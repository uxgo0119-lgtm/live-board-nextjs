// [2026-07-27新設 Phase7] lib/ai/providers/gemini/{client,ocr}.ts の単体テスト。
// test/unit/ai/providers/openai/ocr.test.ts と同じ手法・同じ観点(globalThis.fetchをモック)で、
// 「GEMINI_API_KEYがリクエストヘッダ(x-goog-api-key)にのみ使われ、レスポンス・例外メッセージに
// 一切含まれないこと」「リクエストの形(inlineDataにmimeType/base64・promptTextがtextパート)」
// 「レスポンスのJSON抽出」「bulkモードでの配列チェック」「エラーのラップ」「APIキー未設定時の
// 挙動」を確認する。
//
// 【重要な限界】このテストはfetchをモックしており、実際のGemini APIへは一切通信していない。
// Gemini generateContent APIの実際のリクエスト/レスポンス形状・モデル名が、本テストが
// 想定している形と完全に一致する保証はない(ベストエフォート実装。詳細はPhase7完了報告書参照)。

import { __resetServerEnvCacheForTests } from '../../../../../lib/config/env';
import { callGeminiGenerateContent } from '../../../../../lib/ai/providers/gemini/client';
import { geminiOcrCapability } from '../../../../../lib/ai/providers/gemini/ocr';
import { ApiError } from '../../../../../lib/http/apiError';

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error('FAIL: ' + msg);
  console.log('OK: ' + msg);
}

const SECRET_KEY = 'gemini-TEST-SECRET-22222';
process.env.ANTHROPIC_API_KEY = 'sk-ant-dummy-for-gemini-test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'dummy-service-role-key';
process.env.GEMINI_API_KEY = SECRET_KEY;
__resetServerEnvCacheForTests();

const realFetch = globalThis.fetch;

(async () => {
  // ---- callGeminiGenerateContent: 正常系(URL・ヘッダ・ボディが正しく組み立てられる) ----
  let capturedUrl: string | null = null;
  let capturedHeaders: any = null;
  let capturedBody: any = null;
  (globalThis as any).fetch = async (url: string, init: any) => {
    capturedUrl = url;
    capturedHeaders = init.headers;
    capturedBody = JSON.parse(init.body);
    return new Response(
      JSON.stringify({ candidates: [{ content: { parts: [{ text: 'hello ' }, { text: 'world' }] } }] }),
      { status: 200 }
    );
  };
  const text = await callGeminiGenerateContent({ maxTokens: 123, parts: [{ text: 'prompt' }] });
  assert(capturedUrl !== null && String(capturedUrl).indexOf('generativelanguage.googleapis.com') !== -1, 'Gemini generateContent APIのURLを呼び出す');
  assert(String(capturedUrl).indexOf(SECRET_KEY) === -1, '【重要】APIキーはURLクエリパラメータには含まれない(ヘッダ方式)');
  assert(capturedHeaders['x-goog-api-key'] === SECRET_KEY, 'GEMINI_API_KEYはx-goog-api-keyヘッダにのみ使われる');
  assert(capturedBody.generationConfig.maxOutputTokens === 123, '指定したmaxTokensがgenerationConfig.maxOutputTokensとしてそのままリクエストに渡る');
  assert(text === 'hello world', '複数のtextパートが結合されて返る');

  // ---- geminiOcrCapability.scan: inlineDataブロックがmimeType/data形式で組み立てられ、
  //      レスポンスがJSONとしてパースされる ----
  (globalThis as any).fetch = async (url: string, init: any) => {
    capturedBody = JSON.parse(init.body);
    return new Response(
      JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"room_number":"101","symbol":"A"}' }] } }] }),
      { status: 200 }
    );
  };
  const singleResult = await geminiOcrCapability.scan({
    mode: 'single',
    mediaType: 'image/jpeg',
    data: 'BASE64DATA',
    promptText: 'サンプルプロンプト',
    maxTokens: 400,
  });
  const sentParts = capturedBody.contents[0].parts;
  assert(
    sentParts.some((p: any) => p.inlineData && p.inlineData.mimeType === 'image/jpeg' && p.inlineData.data === 'BASE64DATA'),
    'inlineDataブロックがmimeType/data形式で組み立てられる'
  );
  assert(sentParts.some((p: any) => p.text === 'サンプルプロンプト'), 'promptTextがtextパートとして送られる');
  assert(JSON.stringify(singleResult).indexOf(SECRET_KEY) === -1, '【重要】戻り値にAPIキーが一切含まれない');
  assert((singleResult as any).room_number === '101', 'AIの応答が正しくJSONとしてパースされる');

  // ---- bulkモード: 配列以外が返れば502 ----
  (globalThis as any).fetch = async () =>
    new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"not":"an array"}' }] } }] }), { status: 200 });
  let caught: ApiError | null = null;
  try {
    await geminiOcrCapability.scan({ mode: 'bulk', mediaType: 'application/pdf', data: 'BASE64PDF', promptText: 'p', maxTokens: 100 });
  } catch (e) {
    caught = e as ApiError;
  }
  assert(caught instanceof ApiError && caught.status === 502, 'bulkモードで配列以外が返れば502');

  // ---- 異常系: HTTPエラー時は502のApiErrorにラップされ、詳細メッセージはクライアントへ渡らない ----
  (globalThis as any).fetch = async () =>
    new Response(JSON.stringify({ error: { message: 'leak-attempt ' + SECRET_KEY } }), { status: 500 });
  caught = null;
  try {
    await callGeminiGenerateContent({ maxTokens: 10, parts: [{ text: 'x' }] });
  } catch (e) {
    caught = e as ApiError;
  }
  assert(caught instanceof ApiError && caught.status === 502, 'Geminiのエラー応答は502のApiErrorにラップされる');
  assert(caught!.message.indexOf(SECRET_KEY) === -1, '【重要】生のエラーメッセージ(APIキー混入し得る)はApiErrorのmessageに含まれない');

  // ---- GEMINI_API_KEY未設定時は、ネットワーク通信を試みる前に分かりやすいエラーになる ----
  delete process.env.GEMINI_API_KEY;
  __resetServerEnvCacheForTests();
  let networkCalled = false;
  (globalThis as any).fetch = async () => {
    networkCalled = true;
    throw new Error('fetch should not be called when GEMINI_API_KEY is missing');
  };
  caught = null;
  try {
    await callGeminiGenerateContent({ maxTokens: 10, parts: [{ text: 'x' }] });
  } catch (e) {
    caught = e as ApiError;
  }
  assert(!networkCalled, 'GEMINI_API_KEY未設定時はfetchを呼ぶ前にエラーになる(無駄な通信を試みない)');
  assert(caught instanceof ApiError && caught.status === 500, 'GEMINI_API_KEY未設定時は500のApiErrorになる');

  // 後続テストへの影響を避けるため、環境変数を元に戻す
  process.env.GEMINI_API_KEY = SECRET_KEY;
  __resetServerEnvCacheForTests();

  globalThis.fetch = realFetch;
  console.log('ALL PASS: ai/providers/gemini/ocr.test.ts');
})().catch((e) => {
  globalThis.fetch = realFetch;
  console.error(e);
  process.exit(1);
});
