// [2026-07-20新設] lib/ai/capabilities/ocr/inspectionSchedule.ts の単体テスト。
// (旧 test/unit/anthropic.test.ts をprovider非依存構成への移行に合わせて移設。
// アサーション内容は変更していない。) 実際のAnthropic APIへは通信せず、
// globalThis.fetchをモックする。ここで特に確認したいのは、
// 「ANTHROPIC_API_KEYがリクエストヘッダにだけ使われ、レスポンスや例外メッセージには
// 一切含まれないこと」「サイズ上限・不正な入力が正しく弾かれること」「Task Router経由でも
// 挙動が変わらないこと」。

import { __resetServerEnvCacheForTests } from '../../../../lib/config/env';
import {
  validateOcrPayload,
  scanInspectionScheduleSlip,
  MAX_BASE64_LENGTH_SINGLE,
} from '../../../../lib/ai/capabilities/ocr/inspectionSchedule';
import { ApiError } from '../../../../lib/http/apiError';

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error('FAIL: ' + msg);
  console.log('OK: ' + msg);
}

const SECRET_KEY = 'sk-ant-THIS-IS-SECRET-DO-NOT-LEAK-12345';
process.env.ANTHROPIC_API_KEY = SECRET_KEY;
process.env.SUPABASE_SERVICE_ROLE_KEY = 'dummy-service-role-key';
__resetServerEnvCacheForTests();

const realFetch = globalThis.fetch;

(async () => {
  // ---- validateOcrPayload: mode不正 ----
  let caught: ApiError | null = null;
  try {
    validateOcrPayload('invalid-mode', 'image/jpeg', 'AAAA');
  } catch (e) {
    caught = e as ApiError;
  }
  assert(caught instanceof ApiError && caught.status === 400, 'modeが single/bulk 以外なら400');

  // ---- validateOcrPayload: mediaType/data欠落 ----
  caught = null;
  try {
    validateOcrPayload('single', '', '');
  } catch (e) {
    caught = e as ApiError;
  }
  assert(caught instanceof ApiError && caught.status === 400, 'mediaTypeまたはdataが空なら400');

  // ---- validateOcrPayload: サイズ上限超過 ----
  const tooLarge = 'A'.repeat(MAX_BASE64_LENGTH_SINGLE + 1);
  caught = null;
  try {
    validateOcrPayload('single', 'image/jpeg', tooLarge);
  } catch (e) {
    caught = e as ApiError;
  }
  assert(caught instanceof ApiError && caught.status === 413, 'サイズ上限を超えるデータは413で拒否される');

  // ---- validateOcrPayload: 正常な入力は例外を投げない ----
  validateOcrPayload('single', 'image/jpeg', 'AAAA');
  console.log('OK: 正常な入力(mode/mediaType/data全て指定)は例外を投げない');

  // ---- scanInspectionScheduleSlip (Task Router経由でAnthropic Adapterを呼ぶ):
  //      ANTHROPIC_API_KEYがヘッダにのみ使われ、レスポンス・エラーメッセージの
  //      どちらにも含まれないことを確認 ----
  let capturedHeaders: any = null;
  let capturedBody: any = null;
  (globalThis as any).fetch = async (url: string, init: any) => {
    capturedHeaders = init.headers;
    capturedBody = JSON.parse(init.body);
    return new Response(
      JSON.stringify({ content: [{ type: 'text', text: '{"room_number":"101","symbol":"A","time":"","time_end":"","note":"","name":""}' }] }),
      { status: 200 }
    );
  };
  const result = await scanInspectionScheduleSlip('single', 'image/jpeg', 'BASE64DATA');
  assert(capturedHeaders['x-api-key'] === SECRET_KEY, 'ANTHROPIC_API_KEYはAnthropicへのリクエストヘッダ(x-api-key)にのみ使われる');
  assert(capturedBody.model && capturedBody.max_tokens === 400, 'singleモードのリクエストパラメータが正しく組み立てられている(Task Router経由でも変化なし)');
  assert(JSON.stringify(result).indexOf(SECRET_KEY) === -1, '【重要】戻り値(ブラウザに返る内容)にAPIキーが一切含まれない');
  assert((result as any).room_number === '101', 'AIの応答が正しくJSONとしてパースされ、フロントが期待する形(room_number等)になっている');

  // ---- bulkモード: max_tokensが16000になり、配列以外が返れば502になることを確認 ----
  (globalThis as any).fetch = async (url: string, init: any) => {
    capturedBody = JSON.parse(init.body);
    return new Response(JSON.stringify({ content: [{ type: 'text', text: '{"not":"an array"}' }] }), { status: 200 });
  };
  caught = null;
  try {
    await scanInspectionScheduleSlip('bulk', 'application/pdf', 'BASE64PDF');
  } catch (e) {
    caught = e as ApiError;
  }
  assert(capturedBody.max_tokens === 16000, 'bulkモードのmax_tokensは16000');
  assert(caught instanceof ApiError && caught.status === 502, 'bulkモードで配列以外が返れば502');

  // ---- Anthropic側がエラーを返した場合、APIキーやAnthropicの生エラーメッセージを
  //      ブラウザに漏らさない(定型メッセージのみ返す) ----
  (globalThis as any).fetch = async () =>
    new Response(JSON.stringify({ type: 'error', error: { message: 'internal detail: key=' + SECRET_KEY } }), { status: 500 });
  caught = null;
  try {
    await scanInspectionScheduleSlip('single', 'image/jpeg', 'BASE64DATA');
  } catch (e) {
    caught = e as ApiError;
  }
  assert(caught instanceof ApiError && caught.status === 502, 'Anthropic側のエラーは502としてラップされる');
  assert(caught!.message.indexOf(SECRET_KEY) === -1, '【重要】Anthropicからの生エラーメッセージ(APIキーが混入し得る)はブラウザ向けの例外メッセージに含まれない');

  globalThis.fetch = realFetch;
  console.log('ALL PASS: ai/capabilities/inspectionSchedule.test.ts');
})().catch((e) => {
  globalThis.fetch = realFetch;
  console.error(e);
  process.exit(1);
});
