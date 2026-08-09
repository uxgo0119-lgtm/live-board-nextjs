// [2026-07-20新設] CORS(オリジン制限)ヘルパー。
//
// 重要な前提: CORSは「このAPIの安全性の主な防壁」ではありません。主な防壁は
// (1) lib/auth/verifySession.ts によるログイン確認(Bearer トークン検証)と
// (2) lib/rateLimit/checkUsage.ts による利用回数制限です。ブラウザ以外のクライアント
// (curl、サーバー間通信など)はCORSの影響を受けないため、CORSだけでは不正利用を
// 防げません。CORSはあくまで「ブラウザ上の別サイトのJavaScriptから、ログイン中の
// ユーザーの資格情報を使ってこのAPIが叩かれることを防ぐ」ための多層防御の一枚です。
//
// ALLOWED_ORIGINS が未設定の場合は開発momentのため全オリジンを許可しますが、
// 本番運用では必ず Vercel の環境変数 ALLOWED_ORIGINS に、Live Board・Report Flow・
// 今後の顧客企業のドメインをカンマ区切りで設定してください
// (例: https://live-board.example.com,https://reportflow.example.com)。

export function resolveCorsOrigin(requestOrigin: string | null, allowedOrigins: string[]): string {
  if (allowedOrigins.length === 0) {
    // 未設定時は開発用に全許可。本番でこのまま運用しないよう .env.local.example と
    // README に明記している。
    return requestOrigin || '*';
  }
  if (requestOrigin && allowedOrigins.includes(requestOrigin)) {
    return requestOrigin;
  }
  // 許可リストに無いオリジンには、Access-Control-Allow-Originを返さない
  // (ブラウザ側でCORSエラーとなり、レスポンス本文を読み取れなくなる)。
  return '';
}

export function corsHeaders(requestOrigin: string | null, allowedOrigins: string[]): HeadersInit {
  const allowOrigin = resolveCorsOrigin(requestOrigin, allowedOrigins);
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization,Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
  if (allowOrigin) headers['Access-Control-Allow-Origin'] = allowOrigin;
  return headers;
}

export function handlePreflight(request: Request, allowedOrigins: string[]): Response {
  const origin = request.headers.get('origin');
  return new Response(null, { status: 204, headers: corsHeaders(origin, allowedOrigins) });
}
