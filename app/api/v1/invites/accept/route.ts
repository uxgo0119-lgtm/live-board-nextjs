// [2026-07-20新設] 招待の受け入れ(参加)エンドポイント。ログイン済みユーザーのみ
// 実行できる。実処理は lib/handlers/invites.ts に集約されている。
//
//   POST /api/v1/invites/accept?id=xxx
//   ヘッダ: Authorization: Bearer <ユーザーのアクセストークン>
//   → { result: { propertyId, propertyName, role, roleLabel, alreadyMember } }

import { handleInvitesPreflight, handleAcceptInvite } from '@/lib/handlers/invites';

export const runtime = 'nodejs';

export async function OPTIONS(request: Request) {
  return handleInvitesPreflight(request);
}

export async function POST(request: Request) {
  return handleAcceptInvite(request);
}
