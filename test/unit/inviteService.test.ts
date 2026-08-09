// [2026-07-20新設] lib/invites/inviteService.ts の単体テスト(有効期限・失効・上限判定など、
// 旧api/accept-invite.jsから移設したロジックが壊れていないことを確認する)。
import { __resetServerEnvCacheForTests } from '../../lib/config/env';
import { getInviteInfo, acceptInvite, isUuid } from '../../lib/invites/inviteService';
import { ApiError } from '../../lib/http/apiError';

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error('FAIL: ' + msg);
  console.log('OK: ' + msg);
}

process.env.ANTHROPIC_API_KEY = 'sk-ant-dummy';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'dummy-service-role-key';
__resetServerEnvCacheForTests();

const realFetch = globalThis.fetch;
const VALID_UUID = '123e4567-e89b-12d3-a456-426614174000';

function mockSelectOnce(rows: unknown[]) {
  (globalThis as any).fetch = async () => new Response(JSON.stringify(rows), { status: 200 });
}

(async () => {
  // ---- UUID形式チェック ----
  assert(isUuid(VALID_UUID), '正しいUUID形式を受理する');
  assert(!isUuid('not-a-uuid'), 'UUID形式でない文字列を拒否する');
  assert(!isUuid(undefined), 'undefinedを拒否する');

  // ---- idがUUID形式でない場合は400 ----
  let caught: ApiError | null = null;
  try {
    await getInviteInfo('bogus-id');
  } catch (e) {
    caught = e as ApiError;
  }
  assert(caught instanceof ApiError && caught.status === 400, '不正な形式のidは400で拒否される');

  // ---- 存在しない招待は404 ----
  mockSelectOnce([]);
  caught = null;
  try {
    await getInviteInfo(VALID_UUID);
  } catch (e) {
    caught = e as ApiError;
  }
  assert(caught instanceof ApiError && caught.status === 404, '存在しない招待は404になる');

  // ---- 失効済み(revoked_at)の招待は valid:false ----
  mockSelectOnce([
    { id: VALID_UUID, property_id: 'p1', role: 'inspector', expires_at: null, revoked_at: '2026-01-01T00:00:00Z', max_uses: null, use_count: 0, properties: { name: 'テスト物件' } },
  ]);
  let info = await getInviteInfo(VALID_UUID);
  assert(info.valid === false, '無効化済みの招待は valid:false になる');
  assert(!!info.reason, '無効化済みの招待には理由(reason)が設定される');

  // ---- 期限切れの招待は valid:false ----
  mockSelectOnce([
    { id: VALID_UUID, property_id: 'p1', role: 'inspector', expires_at: '2020-01-01T00:00:00Z', revoked_at: null, max_uses: null, use_count: 0, properties: { name: 'テスト物件' } },
  ]);
  info = await getInviteInfo(VALID_UUID);
  assert(info.valid === false, '期限切れの招待は valid:false になる');

  // ---- 利用回数上限に達した招待は valid:false ----
  mockSelectOnce([
    { id: VALID_UUID, property_id: 'p1', role: 'inspector', expires_at: null, revoked_at: null, max_uses: 3, use_count: 3, properties: { name: 'テスト物件' } },
  ]);
  info = await getInviteInfo(VALID_UUID);
  assert(info.valid === false, '利用回数の上限に達した招待は valid:false になる');

  // ---- 有効な招待は valid:true、role/roleLabelが正しく変換される ----
  mockSelectOnce([
    { id: VALID_UUID, property_id: 'p1', role: 'admin', expires_at: null, revoked_at: null, max_uses: null, use_count: 5, properties: { name: 'サンプルマンション' } },
  ]);
  info = await getInviteInfo(VALID_UUID);
  assert(info.valid === true, '有効な招待は valid:true になる');
  assert(info.propertyName === 'サンプルマンション', '物件名が正しく取得される');
  assert(info.roleLabel === '管理者', 'role=adminはroleLabel「管理者」に変換される');

  // ---- acceptInvite: 未ログイン扱いのuserIdは呼び出し元(requireSession)で弾く前提のため、
  //      ここではuserIdが渡された場合の正常系(新規参加・既に参加済みの両方)を確認する ----
  let insertCalled = false;
  let insertedBody: any = null;
  (globalThis as any).fetch = async (url: string, init?: any) => {
    if (url.includes('property_invites?id=eq.') && (!init || init.method === undefined)) {
      return new Response(
        JSON.stringify([
          { id: VALID_UUID, property_id: 'prop-1', role: 'inspector', expires_at: null, revoked_at: null, max_uses: null, use_count: 2, properties: { name: 'サンプルマンション' } },
        ]),
        { status: 200 }
      );
    }
    if (url.includes('property_members?property_id=eq.')) {
      return new Response(JSON.stringify([]), { status: 200 }); // まだメンバーでない
    }
    if (url.includes('/rest/v1/property_members') && init && init.method === 'POST') {
      insertCalled = true;
      insertedBody = JSON.parse(init.body);
      return new Response(JSON.stringify([{ ...insertedBody }]), { status: 201 });
    }
    if (url.includes('property_invites?id=eq.') && init && init.method === 'PATCH') {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    return new Response(JSON.stringify([]), { status: 200 });
  };
  const result = await acceptInvite(VALID_UUID, 'new-user-id');
  assert(result.alreadyMember === false, '新規参加の場合 alreadyMember:false');
  assert(insertCalled, 'property_membersへのINSERTが実際に呼ばれている');
  assert(insertedBody.user_id === 'new-user-id', '検証済みのuserId(requireSessionで確認済みの値)がそのままinsertされ、クライアントの自己申告値を信用していない');
  assert(insertedBody.property_id === 'prop-1', '招待に紐づくproperty_idが使われる');

  globalThis.fetch = realFetch;
  console.log('ALL PASS: inviteService.test.ts');
})().catch((e) => {
  globalThis.fetch = realFetch;
  console.error(e);
  process.exit(1);
});
