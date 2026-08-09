// [2026-07-20新設] lib/ai/providers/anthropic/client.ts (低レベルAPI呼び出し)単体の
// テスト。capabilities層のプロンプト知識を介さず、「Anthropic Messages APIとの
// 通信そのもの」が正しいことをピンポイントで確認する。

import { __resetServerEnvCacheForTests } from '../../../../../lib/config/env';
import { callAnthropicMessages } from '../../../../../lib/ai/providers/anthropic/client';
import { ApiError } from '../../../../../lib/http/apiError';

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error('FAIL: ' + msg);
  console.log('OK: ' + msg);
}

const SECRET_KEY = 'sk-ant-CLIENT-TEST-SECRET-98765';
process.env.ANTHROPIC_API_KEY = SECRET_KEY;
process.env.SUPABASE_SERVICE_ROLE_KEY = 'dummy-service-role-key';
__resetServerEnvCacheForTests();

const realFetch = globalThis.fetch;

(async () => {
  // ---- 正常系: 指定したcontent/maxTokensがそのままリクエストボディへ渡り、
  //      レスポンスのtextパートが結合されて返る ----
  let capturedUrl: string | null = null;
  let capturedHeaders: any = null;
  let capturedBody: any = null;
  (globalThis as any).fetch = async (url: string, init: any) => {
    capturedUrl = url;
    capturedHeaders = init.headers;
    capturedBody = JSON.parse(init.body);
    return new Response(JSON.stringify({ content: [{ type: 'text', text: 'hello ' }, { type: 'text', text: 'world' }] }), {
      status: 200,
    });
  };
  const text = await callAnthropicMessages({
    maxTokens: 123,
    content: [{ type: 'text', text: 'prompt' }],
  });
  assert(capturedUrl === 'https://api.anthropic.com/v1/messages', 'Anthropic Messages APIの正しいURLを呼び出す');
  assert(capturedHeaders['x-api-key'] === SECRET_KEY, 'ANTHROPIC_API_KEYはx-api-keyヘッダにのみ使われる');
  assert(capturedBody.max_tokens === 123, '指定したmaxTokensがそのままリクエストに渡る');
  assert(text === 'hello world', '複数のtextパートが結合されて返る');

  // ---- 異常系: HTTPエラー時は502のApiErrorにラップされ、詳細メッセージは
  //      クライアントへ渡らない ----
  (globalThis as any).fetch = async () =>
    new Response(JSON.stringify({ type: 'error', error: { message: 'leak-attempt ' + SECRET_KEY } }), { status: 500 });
  let caught: ApiError | null = null;
  try {
    await callAnthropicMessages({ maxTokens: 10, content: [{ type: 'text', text: 'x' }] });
  } catch (e) {
    caught = e as ApiError;
  }
  assert(caught instanceof ApiError && caught.status === 502, 'Anthropicのエラー応答は502のApiErrorにラップされる');
  assert(caught!.message.indexOf(SECRET_KEY) === -1, '生のエラーメッセージ(APIキー混入し得る)はApiErrorのmessageに含まれない');

  globalThis.fetch = realFetch;
  console.log('ALL PASS: ai/providers/anthropic/client.test.ts');
})().catch((e) => {
  globalThis.fetch = realFetch;
  console.error(e);
  process.exit(1);
});
