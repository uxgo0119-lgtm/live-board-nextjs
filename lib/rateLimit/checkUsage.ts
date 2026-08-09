// [2026-07-20新設] 利用回数制限・レート制限のRoute Handler向けラッパー。
// 実際の判定+記録ロジックはSupabase側のPostgres関数(check_and_record_api_usage、
// supabase/rate_limit_schema.sql参照)で原子的に行われる。ここではその呼び出しと、
// 拒否された場合に返すエラーメッセージ・HTTPヘッダ(Retry-After)を組み立てる。

import { ApiError } from '../http/apiError';
import { rpc } from '../supabase/adminClient';
import { getServerEnv } from '../config/env';

type RateLimitRow = { allowed: boolean; retry_after_seconds: number; reason: string | null };

const REASON_MESSAGES: Record<string, string> = {
  rate_limited_burst: '短時間に多くのリクエストが送信されました。少し時間をおいてからもう一度お試しください。',
  rate_limited_user_daily: '本日のご利用回数の上限に達しました。日付が変わってから改めてお試しいただくか、管理者にご連絡ください。',
  rate_limited_global_daily: 'システム全体で本日のご利用回数の上限に達しました。しばらくしてからもう一度お試しください（解決しない場合は管理者にご連絡ください）。',
};

// endpointごとに個別の上限を持たせたい場合はここに追記する(未指定ならenvのデフォルト値を使う)。
type EndpointLimits = Partial<{
  windowSeconds: number;
  maxInWindow: number;
  userDayMax: number;
  globalDayMax: number;
}>;

// 呼び出し側は必ず requireSession() で得た userId を渡すこと(未ログインのリクエストは
// このレート制限より前の認証チェックで弾かれている前提)。
export async function enforceRateLimit(
  userId: string,
  endpoint: string,
  overrides: EndpointLimits = {}
): Promise<void> {
  const env = getServerEnv();
  const windowSeconds = overrides.windowSeconds ?? env.RATE_LIMIT_WINDOW_SECONDS;
  const maxInWindow = overrides.maxInWindow ?? env.RATE_LIMIT_MAX_PER_WINDOW;
  const userDayMax = overrides.userDayMax ?? env.RATE_LIMIT_MAX_PER_USER_PER_DAY;
  const globalDayMax = overrides.globalDayMax ?? env.RATE_LIMIT_MAX_GLOBAL_PER_DAY;

  const rows = await rpc<RateLimitRow[]>('check_and_record_api_usage', {
    p_user_id: userId,
    p_endpoint: endpoint,
    p_window_seconds: windowSeconds,
    p_max_in_window: maxInWindow,
    p_user_day_max: userDayMax,
    p_global_day_max: globalDayMax,
  });

  const row = rows && rows[0];
  if (!row) {
    // Postgres関数が想定外の空応答を返した場合は、安全側に倒してリクエストを許可する
    // (レート制限機能自体の不具合でAI機能全体が使えなくなる事態を避けるため)。
    console.error('[fireflow-api] rate limit RPC returned no rows; allowing request as fail-open');
    return;
  }
  if (!row.allowed) {
    const message = REASON_MESSAGES[row.reason || ''] || 'ご利用回数の上限に達しました。しばらくしてからもう一度お試しください。';
    const err = new ApiError(429, message);
    err.retryAfterSeconds = row.retry_after_seconds;
    throw err;
  }
}
