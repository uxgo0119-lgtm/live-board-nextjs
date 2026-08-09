// [2026-07-20新設] lib/auth/verifySession.ts の単体テスト。
// これは「①ANTHROPIC_API_KEYはサーバー側のみで管理されているか」ではなく、
// 「未ログインのリクエストがAI機能を呼べてしまわないか」を検証するテスト。
import { __resetServerEnvCacheForTests } from '../../lib/config/env';
import { requireSession } from '../../lib/auth/verifySession';
import { ApiError } from '../../lib/http/apiError';

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error('FAIL: ' + msg);
  console.log('OK: ' + msg);
}

process.env.ANTHROPIC_API_KEY = 'sk-ant-dummy';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'dummy-service-role-key';
__resetServerEnvCacheForTests();

const realFetch = globalThis.fetch;

(async () => {
  // ---- Authorizationヘッダが無いリクエストは401で拒否される ----
  const reqNoAuth = new Request('https://api.example.com/api/v1/inspection-schedule/scan', { method: 'POST' });
  let caught: ApiError | null = null;
  try {
    await requireSession(reqNoAuth);
  } catch (e) {
    caught = e as ApiError;
  }
  assert(caught instanceof ApiError, 'Authorizationヘッダが無いリクエストは例外になる');
  assert(caught!.status === 401, '【重要】未ログインのリクエストは401で拒否される(AI機能・招待受け入れの両方で共通)');

  // ---- Bearerトークンが付いているが、Supabase側で無効と判定される場合も401 ----
  (globalThis as any).fetch = async () => new Response('unauthorized', { status: 401 });
  const reqInvalidToken = new Request('https://api.example.com/api/v1/inspection-schedule/scan', {
    method: 'POST',
    headers: { Authorization: 'Bearer invalid-token' },
  });
  caught = null;
  try {
    await requireSession(reqInvalidToken);
  } catch (e) {
    caught = e as ApiError;
  }
  assert(caught instanceof ApiError && caught.status === 401, '無効なトークンの場合も401で拒否される(トークンの中身をこちらで検証せず、必ずSupabase Auth APIに問い合わせて確認している)');

  // ---- 有効なBearerトークンの場合、userIdが返る ----
  let calledWithAuthHeader: string | null = null;
  (globalThis as any).fetch = async (_url: string, init: any) => {
    calledWithAuthHeader = init.headers.Authorization;
    return new Response(JSON.stringify({ id: 'user-abc-123' }), { status: 200 });
  };
  const reqValidToken = new Request('https://api.example.com/api/v1/inspection-schedule/scan', {
    method: 'POST',
    headers: { Authorization: 'Bearer valid-token-xyz' },
  });
  const session = await requireSession(reqValidToken);
  assert(session.userId === 'user-abc-123', '有効なトークンの場合、Supabaseから返ってきたuser idが使われる (got: ' + session.userId + ')');
  assert(
    calledWithAuthHeader === 'Bearer valid-token-xyz',
    'ユーザーが送ってきたアクセストークンが、そのままSupabase Auth APIへの問い合わせに使われている(なりすまし防止: クライアントが送るuser_idではなく、トークン自体を検証する設計)'
  );

  // ---- Supabaseがidを含まない応答を返した場合も401(念のための防御) ----
  (globalThis as any).fetch = async () => new Response(JSON.stringify({}), { status: 200 });
  const reqNoId = new Request('https://api.example.com/x', { headers: { Authorization: 'Bearer weird-token' } });
  caught = null;
  try {
    await requireSession(reqNoId);
  } catch (e) {
    caught = e as ApiError;
  }
  assert(caught instanceof ApiError && caught.status === 401, 'Supabaseの応答にidが無い場合も401で拒否される(fail-closed)');

  globalThis.fetch = realFetch;
  console.log('ALL PASS: verifySession.test.ts');
})().catch((e) => {
  globalThis.fetch = realFetch;
  console.error(e);
  process.exit(1);
});
