// [2026-07-20新設] lib/rateLimit/checkUsage.ts の単体テスト。
// Supabase(Postgres RPC)への実通信はglobalThis.fetchをモックして再現する。
import { __resetServerEnvCacheForTests } from '../../lib/config/env';
import { enforceRateLimit } from '../../lib/rateLimit/checkUsage';
import { ApiError } from '../../lib/http/apiError';

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error('FAIL: ' + msg);
  console.log('OK: ' + msg);
}

process.env.ANTHROPIC_API_KEY = 'sk-ant-dummy';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'dummy-service-role-key';
__resetServerEnvCacheForTests();

const realFetch = globalThis.fetch;

function mockRpcOnce(row: { allowed: boolean; retry_after_seconds: number; reason: string | null }) {
  let capturedUrl: string | null = null;
  let capturedBody: unknown = null;
  (globalThis as any).fetch = async (url: string, init: any) => {
    capturedUrl = url;
    capturedBody = JSON.parse(init.body);
    return new Response(JSON.stringify([row]), { status: 200 });
  };
  return {
    getCapturedUrl: () => capturedUrl,
    getCapturedBody: () => capturedBody,
  };
}

(async () => {
  // ---- 許可される場合: 例外を投げずに正常終了する ----
  mockRpcOnce({ allowed: true, retry_after_seconds: 0, reason: null });
  await enforceRateLimit('user-1', 'inspection-schedule.scan');
  console.log('OK: 許可された場合、enforceRateLimitは例外を投げない');

  // ---- RPCに正しいパラメータが渡っているか ----
  const captured = mockRpcOnce({ allowed: true, retry_after_seconds: 0, reason: null });
  await enforceRateLimit('user-42', 'inspection-schedule.scan');
  const url = captured.getCapturedUrl() as unknown as string;
  const body = captured.getCapturedBody() as any;
  assert(url.includes('/rest/v1/rpc/check_and_record_api_usage'), 'Postgres関数 check_and_record_api_usage をRPC経由で呼んでいる');
  assert(body.p_user_id === 'user-42', 'p_user_idにuserIdが渡される');
  assert(body.p_endpoint === 'inspection-schedule.scan', 'p_endpointに正しいendpoint名が渡される');
  assert(typeof body.p_window_seconds === 'number' && body.p_window_seconds > 0, 'p_window_secondsに正の数が渡される');

  // ---- バースト制限で拒否される場合: ApiError(429)を投げ、retryAfterSecondsが伝わる ----
  mockRpcOnce({ allowed: false, retry_after_seconds: 37, reason: 'rate_limited_burst' });
  let caught: ApiError | null = null;
  try {
    await enforceRateLimit('user-2', 'inspection-schedule.scan');
  } catch (e) {
    caught = e as ApiError;
  }
  assert(caught instanceof ApiError, 'バースト制限で拒否された場合、ApiErrorが投げられる');
  assert(caught!.status === 429, 'ステータスコードは429(Too Many Requests)');
  assert(caught!.retryAfterSeconds === 37, 'retryAfterSecondsがRPCの応答からそのまま伝わる (got: ' + caught!.retryAfterSeconds + ')');
  assert(caught!.message.length > 0, '日本語のエラーメッセージが設定されている');

  // ---- 1日あたりのユーザー別上限で拒否される場合 ----
  mockRpcOnce({ allowed: false, retry_after_seconds: 86400, reason: 'rate_limited_user_daily' });
  caught = null;
  try {
    await enforceRateLimit('user-3', 'inspection-schedule.scan');
  } catch (e) {
    caught = e as ApiError;
  }
  assert(caught instanceof ApiError && caught.status === 429, '1日あたりのユーザー別上限でも429で拒否される');
  assert(caught!.message.includes('本日'), 'ユーザー別日次上限のメッセージには「本日」という文言が含まれる (got: ' + caught!.message + ')');

  // ---- 全体(グローバル)の1日あたり上限で拒否される場合 ----
  mockRpcOnce({ allowed: false, retry_after_seconds: 86400, reason: 'rate_limited_global_daily' });
  caught = null;
  try {
    await enforceRateLimit('user-4', 'inspection-schedule.scan');
  } catch (e) {
    caught = e as ApiError;
  }
  assert(caught instanceof ApiError && caught.status === 429, 'グローバル日次上限でも429で拒否される');

  // ---- RPCが空配列を返す想定外ケース: fail-open(許可)される ----
  (globalThis as any).fetch = async () => new Response(JSON.stringify([]), { status: 200 });
  let didThrow = false;
  try {
    await enforceRateLimit('user-5', 'inspection-schedule.scan');
  } catch {
    didThrow = true;
  }
  assert(!didThrow, 'RPCが想定外の空応答を返した場合、レート制限機能自体の不具合でAI機能全体が止まらないようfail-openする');

  globalThis.fetch = realFetch;
  console.log('ALL PASS: rateLimit.test.ts');
})().catch((e) => {
  globalThis.fetch = realFetch;
  console.error(e);
  process.exit(1);
});
