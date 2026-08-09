// [2026-07-20新設] lib/http/cors.ts の単体テスト。Next.js非依存のため、
// `tsx test/unit/cors.test.ts` でそのまま実行できる(npm installなしで検証可能)。
import { resolveCorsOrigin, corsHeaders } from '../../lib/http/cors';

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error('FAIL: ' + msg);
  console.log('OK: ' + msg);
}

// ---- ALLOWED_ORIGINS未設定(開発時の既定動作): リクエスト元をそのまま許可 ----
assert(
  resolveCorsOrigin('https://example.com', []) === 'https://example.com',
  'ALLOWED_ORIGINS未設定時は、開発用にリクエスト元をそのまま許可する'
);
assert(resolveCorsOrigin(null, []) === '*', 'ALLOWED_ORIGINS未設定かつOriginヘッダ無しの場合は* を返す');

// ---- ALLOWED_ORIGINS設定時: 許可リストに無いオリジンは拒否(空文字) ----
const allowed = ['https://live-board.example.com', 'https://reportflow.example.com'];
assert(
  resolveCorsOrigin('https://live-board.example.com', allowed) === 'https://live-board.example.com',
  '許可リストに含まれるオリジンは許可される'
);
assert(
  resolveCorsOrigin('https://evil.example.com', allowed) === '',
  '【重要】許可リストに無いオリジンは拒否され、Access-Control-Allow-Originが空になる'
);
assert(
  resolveCorsOrigin(null, allowed) === '',
  'ALLOWED_ORIGINS設定時、Originヘッダ無しのリクエストは許可されない(空文字)'
);

// ---- corsHeaders: 拒否時はAccess-Control-Allow-Originヘッダ自体が付かない ----
const rejectedHeaders = corsHeaders('https://evil.example.com', allowed) as Record<string, string>;
assert(
  !('Access-Control-Allow-Origin' in rejectedHeaders),
  '拒否されたオリジンの場合、Access-Control-Allow-Originヘッダが存在しない(ブラウザがCORSエラーにする)'
);

const acceptedHeaders = corsHeaders('https://live-board.example.com', allowed) as Record<string, string>;
assert(
  acceptedHeaders['Access-Control-Allow-Origin'] === 'https://live-board.example.com',
  '許可されたオリジンの場合、Access-Control-Allow-Originヘッダにそのオリジンが設定される'
);
assert(
  acceptedHeaders['Access-Control-Allow-Headers'].includes('Authorization'),
  'Access-Control-Allow-HeadersにAuthorizationが含まれる(Bearerトークンを送れるようにするため)'
);

console.log('ALL PASS: cors.test.ts');
