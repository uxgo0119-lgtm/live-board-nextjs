// [2026-07-27新設 Phase7] lib/ai/providers/openai/{client,ocr}.ts の単体テスト。
// test/unit/ai/providers/anthropic/client.test.ts・
// test/unit/ai/capabilities/inspectionSchedule.test.ts と同じ手法(globalThis.fetchをモック)で、
// 「OPENAI_API_KEYがリクエストヘッダ(Authorization)にのみ使われ、レスポンス・例外メッセージに
// 一切含まれないこと」「リクエストの形(image_urlにdata URI・promptTextがtextブロック)」
// 「レスポンスのJSON抽出」「bulkモードでの配列チェック」「エラーのラップ」を確認する。
//
// 【重要な限界】このテストはfetchをモックしており、実際のOpenAI APIへは一切通信していない。
// OpenAI Chat Completions APIの実際のリクエスト/レスポンス形状が、本テストが想定している形と
// 完全に一致する保証はない(ベストエフォート実装。詳細はPhase7完了報告書を参照)。

import { __resetServerEnvCacheForTests } from '../../../../../lib/config/env';
import { callOpenAiChat } from '../../../../../lib/ai/providers/openai/client';
import { openaiOcrCapability } from '../../../../../lib/ai/providers/openai/ocr';
import { ApiError } from '../../../../../lib/http/apiError';

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error('FAIL: ' + msg);
  console.log('OK: ' + msg);
}

const SECRET_KEY = 'sk-openai-TEST-SECRET-11111';
process.env.ANTHROPIC_API_KEY = 'sk-ant-dummy-for-openai-test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'dummy-service-role-key';
process.env.OPENAI_API_KEY = SECRET_KEY;
__resetServerEnvCacheForTests();

const realFetch = globalThis.fetch;

(async () => {
  // ---- callOpenAiChat: 正常系(URL・ヘッダ・ボディが正しく組み立てられる) ----
  let capturedUrl: string | null = null;
  let capturedHeaders: any = null;
  let capturedBody: any = null;
  (globalThis as any).fetch = async (url: string, init: any) => {
    capturedUrl = url;
    capturedHeaders = init.headers;
    capturedBody = JSON.parse(init.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: 'hello world' } }] }), { status: 200 });
  };
  const text = await callOpenAiChat({ maxTokens: 123, content: [{ type: 'text', text: 'prompt' }] });
  assert(capturedUrl === 'https://api.openai.com/v1/chat/completions', 'OpenAI Chat Completions APIの正しいURLを呼び出す');
  assert(capturedHeaders['Authorization'] === 'Bearer ' + SECRET_KEY, 'OPENAI_API_KEYはAuthorizationヘッダ(Bearer)にのみ使われる');
  assert(capturedBody.max_tokens === 123, '指定したmaxTokensがそのままリクエストに渡る');
  assert(text === 'hello world', 'choices[0].message.contentがそのまま返る');

  // ---- openaiOcrCapability.scan: image_urlブロックがdata URI形式で組み立てられ、
  //      レスポンスがJSONとしてパースされる ----
  (globalThis as any).fetch = async (url: string, init: any) => {
    capturedBody = JSON.parse(init.body);
    return new Response(
      JSON.stringify({ choices: [{ message: { content: '{"room_number":"101","symbol":"A"}' } }] }),
      { status: 200 }
    );
  };
  const singleResult = await openaiOcrCapability.scan({
    mode: 'single',
    mediaType: 'image/jpeg',
    data: 'BASE64DATA',
    promptText: 'サンプルプロンプト',
    maxTokens: 400,
  });
  const sentContent = capturedBody.messages[0].content;
  assert(
    sentContent.some((b: any) => b.type === 'image_url' && b.image_url.url === 'data:image/jpeg;base64,BASE64DATA'),
    'image_urlブロックがdata:<mediaType>;base64,<data>形式で組み立てられる'
  );
  assert(sentContent.some((b: any) => b.type === 'text' && b.text === 'サンプルプロンプト'), 'promptTextがtextブロックとして送られる');
  assert(JSON.stringify(singleResult).indexOf(SECRET_KEY) === -1, '【重要】戻り値にAPIキーが一切含まれない');
  assert((singleResult as any).room_number === '101', 'AIの応答が正しくJSONとしてパースされる');

  // ---- bulkモード: 配列以外が返れば502 ----
  (globalThis as any).fetch = async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: '{"not":"an array"}' } }] }), { status: 200 });
  let caught: ApiError | null = null;
  try {
    await openaiOcrCapability.scan({ mode: 'bulk', mediaType: 'application/pdf', data: 'BASE64PDF', promptText: 'p', maxTokens: 100 });
  } catch (e) {
    caught = e as ApiError;
  }
  assert(caught instanceof ApiError && caught.status === 502, 'bulkモードで配列以外が返れば502');

  // ---- 異常系: HTTPエラー時は502のApiErrorにラップされ、詳細メッセージはクライアントへ渡らない ----
  (globalThis as any).fetch = async () =>
    new Response(JSON.stringify({ error: { message: 'leak-attempt ' + SECRET_KEY } }), { status: 500 });
  caught = null;
  try {
    await callOpenAiChat({ maxTokens: 10, content: [{ type: 'text', text: 'x' }] });
  } catch (e) {
    caught = e as ApiError;
  }
  assert(caught instanceof ApiError && caught.status === 502, 'OpenAIのエラー応答は502のApiErrorにラップされる');
  assert(caught!.message.indexOf(SECRET_KEY) === -1, '【重要】生のエラーメッセージ(APIキー混入し得る)はApiErrorのmessageに含まれない');

  // ---- OPENAI_API_KEY未設定時は、ネットワーク通信を試みる前に分かりやすいエラーになる ----
  delete process.env.OPENAI_API_KEY;
  __resetServerEnvCacheForTests();
  let networkCalled = false;
  (globalThis as any).fetch = async () => {
    networkCalled = true;
    throw new Error('fetch should not be called when OPENAI_API_KEY is missing');
  };
  caught = null;
  try {
    await callOpenAiChat({ maxTokens: 10, content: [{ type: 'text', text: 'x' }] });
  } catch (e) {
    caught = e as ApiError;
  }
  assert(!networkCalled, 'OPENAI_API_KEY未設定時はfetchを呼ぶ前にエラーになる(無駄な通信を試みない)');
  assert(caught instanceof ApiError && caught.status === 500, 'OPENAI_API_KEY未設定時は500のApiErrorになる');

  // 後続テストへの影響を避けるため、環境変数を元に戻す
  process.env.OPENAI_API_KEY = SECRET_KEY;
  __resetServerEnvCacheForTests();

  globalThis.fetch = realFetch;
  console.log('ALL PASS: ai/providers/openai/ocr.test.ts');
})().catch((e) => {
  globalThis.fetch = realFetch;
  console.error(e);
  process.exit(1);
});
