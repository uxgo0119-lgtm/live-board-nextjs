// [2026-07-20新設] Supabase REST/Auth APIへの薄いラッパー。
//
// 既存のapi/accept-invite.js・api/scan-time-request.js は @supabase/supabase-js の
// SDKを使わず、素のfetch()でSupabaseのREST API(/rest/v1/...)・Auth API(/auth/v1/...)を
// 直接叩く実装だった。今回の移行でも、新しい依存(npm install)を増やしてこのサンドボックス内で
// 検証できない状態を作らないため、同じ「素のfetch」方式を踏襲し、重複していたロジックだけを
// ここに集約した。将来的に @supabase/supabase-js を導入する場合も、呼び出し側
// (Route Handler)はこのファイルの関数シグネチャに依存しているため、中身の実装だけ
// 差し替えれば済むようにしてある。
//
// 【重要】このファイルは SUPABASE_SERVICE_ROLE_KEY (RLSを無視できる強い権限の鍵)を
// 扱うため、サーバー専用コード(Route Handler、lib/配下)からのみimportしてください。

import { getServerEnv } from '../config/env';
import { ApiError } from '../http/apiError';

function serviceHeaders(serviceKey: string, extra?: Record<string, string>) {
  return {
    apikey: serviceKey,
    Authorization: 'Bearer ' + serviceKey,
    ...extra,
  };
}

// SupabaseのPostgREST(/rest/v1/<table>?...)へのSELECT。フィルタは呼び出し側が
// クエリ文字列として組み立てて渡す(既存コードと同じ方式。テーブル名・カラム名は
// すべてこのリポジトリ内の固定文字列のみを渡す運用とし、ユーザー入力を直接
// クエリ文字列に混ぜる場合は必ずencodeURIComponentを通すこと)。
export async function restSelect<T = unknown>(path: string): Promise<T> {
  const env = getServerEnv();
  const url = env.SUPABASE_URL + '/rest/v1/' + path;
  const r = await fetch(url, { headers: serviceHeaders(env.SUPABASE_SERVICE_ROLE_KEY) });
  if (!r.ok) {
    throw new ApiError(502, 'Supabaseへの問い合わせに失敗しました（HTTP ' + r.status + '）');
  }
  return (await r.json()) as T;
}

export async function restInsert<T = unknown>(table: string, body: unknown): Promise<T> {
  const env = getServerEnv();
  const url = env.SUPABASE_URL + '/rest/v1/' + table;
  const r = await fetch(url, {
    method: 'POST',
    headers: serviceHeaders(env.SUPABASE_SERVICE_ROLE_KEY, {
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    }),
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    throw new ApiError(502, '書き込みに失敗しました（HTTP ' + r.status + '）');
  }
  return (await r.json()) as T;
}

export async function restPatch(path: string, body: unknown): Promise<void> {
  const env = getServerEnv();
  const url = env.SUPABASE_URL + '/rest/v1/' + path;
  await fetch(url, {
    method: 'PATCH',
    headers: serviceHeaders(env.SUPABASE_SERVICE_ROLE_KEY, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  });
}

// Postgres関数(RPC)を呼ぶ。lib/rateLimit/checkUsage.tsが、レート制限の判定+記録を
// 単一トランザクションで原子的に行うために使用する(詳細はそちらのコメント参照)。
export async function rpc<T = unknown>(fnName: string, args: Record<string, unknown>): Promise<T> {
  const env = getServerEnv();
  const url = env.SUPABASE_URL + '/rest/v1/rpc/' + fnName;
  const r = await fetch(url, {
    method: 'POST',
    headers: serviceHeaders(env.SUPABASE_SERVICE_ROLE_KEY, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(args),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new ApiError(502, 'サーバー側の処理に失敗しました（HTTP ' + r.status + '） ' + text.slice(0, 200));
  }
  return (await r.json()) as T;
}

export type AuthUser = { id: string };

// Authorizationヘッダのアクセストークンを、Supabase Auth API(/auth/v1/user)に
// 問い合わせて検証する。クライアントが送ってきたuser_idを信用せず、トークン自体を
// サーバー側で検証することで「なりすまし」を防ぐ(既存api/accept-invite.js・
// api/scan-time-request.jsと同じ方式)。
export async function verifyAccessTokenAgainstSupabase(accessToken: string): Promise<AuthUser | null> {
  const env = getServerEnv();
  const r = await fetch(env.SUPABASE_URL + '/auth/v1/user', {
    headers: serviceHeaders(env.SUPABASE_SERVICE_ROLE_KEY, { Authorization: 'Bearer ' + accessToken }),
  });
  if (!r.ok) return null;
  const body = (await r.json()) as { id?: string };
  if (!body || !body.id) return null;
  return { id: body.id };
}
