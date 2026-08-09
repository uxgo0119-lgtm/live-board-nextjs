// [2026-07-20新設] 招待リンク(property_invites)まわりのロジックを、旧
// api/accept-invite.js から抜き出して集約したもの。Route Handler(GET/POST それぞれ)は
// このファイルの関数を呼ぶだけにし、Supabaseへの問い合わせの詳細はここに閉じ込める。

import { ApiError } from '../http/apiError';
import { restSelect, restInsert, restPatch } from '../supabase/adminClient';

const ROLE_LABEL: Record<string, string> = { inspector: '点検員', admin: '管理者' };

const INVITE_SELECT_FIELDS =
  'id,property_id,role,expires_at,revoked_at,max_uses,use_count,properties(name)';

type InviteRow = {
  id: string;
  property_id: string;
  role: string;
  expires_at: string | null;
  revoked_at: string | null;
  max_uses: number | null;
  use_count: number;
  properties: { name: string } | null;
};

export function isUuid(s: unknown): s is string {
  return typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

async function fetchInvite(id: string): Promise<InviteRow | null> {
  const rows = await restSelect<InviteRow[]>(
    'property_invites?id=eq.' + encodeURIComponent(id) + '&select=' + INVITE_SELECT_FIELDS
  );
  return rows[0] || null;
}

// 招待の有効性を判定する。有効な場合は reason が null。
function checkValidity(invite: InviteRow): string | null {
  if (invite.revoked_at) {
    return 'この招待リンクは発行者によって無効化されています。新しいリンクを発行してもらってください。';
  }
  if (invite.expires_at && new Date(invite.expires_at).getTime() < Date.now()) {
    return 'この招待リンクの有効期限が切れています。新しいリンクを発行してもらってください。';
  }
  if (invite.max_uses != null && invite.use_count >= invite.max_uses) {
    return 'この招待リンクは利用回数の上限に達しています。新しいリンクを発行してもらってください。';
  }
  return null;
}

export async function getInviteInfo(id: unknown) {
  if (!isUuid(id)) {
    throw new ApiError(400, '招待リンクが正しくありません（idが指定されていないか、形式が不正です）。');
  }
  const invite = await fetchInvite(id);
  if (!invite) {
    throw new ApiError(404, 'この招待リンクは見つかりませんでした。リンクが正しいかご確認ください。');
  }
  const reason = checkValidity(invite);
  return {
    propertyName: (invite.properties && invite.properties.name) || null,
    role: invite.role,
    roleLabel: ROLE_LABEL[invite.role] || invite.role,
    valid: !reason,
    reason,
  };
}

export async function acceptInvite(id: unknown, userId: string) {
  if (!isUuid(id)) {
    throw new ApiError(400, '招待リンクが正しくありません（idが指定されていないか、形式が不正です）。');
  }
  const invite = await fetchInvite(id);
  if (!invite) {
    throw new ApiError(404, 'この招待リンクは見つかりませんでした。リンクが正しいかご確認ください。');
  }
  const reason = checkValidity(invite);
  if (reason) {
    throw new ApiError(400, reason);
  }

  const propertyName = (invite.properties && invite.properties.name) || null;

  // 既にそのユーザーがメンバーかどうか確認(重複参加・二重タップ対策)
  const existingRows = await restSelect<Array<{ role: string }>>(
    'property_members?property_id=eq.' +
      encodeURIComponent(invite.property_id) +
      '&user_id=eq.' +
      encodeURIComponent(userId) +
      '&select=role'
  );

  if (existingRows.length > 0) {
    return {
      propertyId: invite.property_id,
      propertyName,
      role: existingRows[0].role,
      roleLabel: ROLE_LABEL[existingRows[0].role] || existingRows[0].role,
      alreadyMember: true,
    };
  }

  await restInsert('property_members', { property_id: invite.property_id, user_id: userId, role: invite.role });

  // 利用回数を1件加算する(読み取り→加算のため、ごく僅かな競合の可能性はあるが、
  // これはあくまで目安のカウンタであり、実際のセキュリティ境界は招待IDの推測不可能性・
  // 失効フラグ・有効期限で担保しているため許容している。既存api/accept-invite.jsから
  // 踏襲した判断)。
  restPatch('property_invites?id=eq.' + encodeURIComponent(id), { use_count: invite.use_count + 1 }).catch(() => {});

  return {
    propertyId: invite.property_id,
    propertyName,
    role: invite.role,
    roleLabel: ROLE_LABEL[invite.role] || invite.role,
    alreadyMember: false,
  };
}
