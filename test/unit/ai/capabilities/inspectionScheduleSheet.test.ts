// [2026-07-27新設 Phase7] lib/ai/capabilities/ocr/documentTypes/inspectionScheduleSheet.ts
// (紙の点検予定表OCR)の単体テスト。既存の
// test/unit/ai/capabilities/inspectionSchedule.test.ts と同じ手法(globalThis.fetchをモック)
// で、「ANTHROPIC_API_KEYがリクエストヘッダにだけ使われ、レスポンス・例外メッセージに
// 一切含まれないこと」「サイズ上限・不正な入力が正しく弾かれること」「レスポンスのJSON形状
// (rawRooms相当の配列)が検証されること」「single/bulk双方でmax_tokensが正しく組み立てられる
// こと」を確認する。

import { __resetServerEnvCacheForTests } from '../../../../lib/config/env';
import {
  validateOcrPayload,
  scanInspectionScheduleSheet,
  MAX_BASE64_LENGTH_SINGLE,
  MAX_BASE64_LENGTH_BULK,
} from '../../../../lib/ai/capabilities/ocr/documentTypes/inspectionScheduleSheet';
import { ApiError } from '../../../../lib/http/apiError';

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error('FAIL: ' + msg);
  console.log('OK: ' + msg);
}

const SECRET_KEY = 'sk-ant-INSPECTION-SHEET-TEST-SECRET-54321';
process.env.ANTHROPIC_API_KEY = SECRET_KEY;
process.env.SUPABASE_SERVICE_ROLE_KEY = 'dummy-service-role-key';
__resetServerEnvCacheForTests();

const realFetch = globalThis.fetch;

const SAMPLE_ROW = {
  roomNumberRaw: '1512',
  scheduleDayRaw: '2日目',
  periodRaw: 'PM',
  timeRaw: '13:00',
  noteRaw: '13:00希望',
  statusRaw: null,
  ladderRaw: null,
  memoRaw: '',
  confidence: { roomNumber: 0.98, scheduleDay: 0.95, period: 0.95, time: 0.95, status: 0.95 },
};

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

  // ---- validateOcrPayload: サイズ上限超過(single) ----
  const tooLargeSingle = 'A'.repeat(MAX_BASE64_LENGTH_SINGLE + 1);
  caught = null;
  try {
    validateOcrPayload('single', 'image/jpeg', tooLargeSingle);
  } catch (e) {
    caught = e as ApiError;
  }
  assert(caught instanceof ApiError && caught.status === 413, 'singleモードでサイズ上限を超えるデータは413で拒否される');

  // ---- validateOcrPayload: サイズ上限超過(bulk) ----
  const tooLargeBulk = 'A'.repeat(MAX_BASE64_LENGTH_BULK + 1);
  caught = null;
  try {
    validateOcrPayload('bulk', 'application/pdf', tooLargeBulk);
  } catch (e) {
    caught = e as ApiError;
  }
  assert(caught instanceof ApiError && caught.status === 413, 'bulkモードでサイズ上限を超えるデータは413で拒否される');

  // ---- validateOcrPayload: 正常な入力は例外を投げない ----
  validateOcrPayload('single', 'image/jpeg', 'AAAA');
  console.log('OK: 正常な入力(mode/mediaType/data全て指定)は例外を投げない');

  // ---- scanInspectionScheduleSheet (single): ANTHROPIC_API_KEYがヘッダにのみ使われ、
  //      レスポンス・エラーメッセージのどちらにも含まれないこと。max_tokens=8000で
  //      呼ばれること。rawRooms相当の配列としてパースされること ----
  let capturedHeaders: any = null;
  let capturedBody: any = null;
  (globalThis as any).fetch = async (url: string, init: any) => {
    capturedHeaders = init.headers;
    capturedBody = JSON.parse(init.body);
    return new Response(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify([SAMPLE_ROW]) }] }), { status: 200 });
  };
  const singleResult = await scanInspectionScheduleSheet('single', 'image/jpeg', 'BASE64DATA');
  assert(capturedHeaders['x-api-key'] === SECRET_KEY, 'ANTHROPIC_API_KEYはAnthropicへのリクエストヘッダ(x-api-key)にのみ使われる');
  assert(capturedBody.max_tokens === 8000, 'singleモードのmax_tokensは8000(部屋数分の配列出力を見込んで既存より引き上げ)');
  assert(JSON.stringify(singleResult).indexOf(SECRET_KEY) === -1, '【重要】戻り値(ブラウザに返る内容)にAPIキーが一切含まれない');
  assert(Array.isArray(singleResult) && singleResult.length === 1, 'singleモードでも結果はrawRooms相当の配列としてパースされる');
  assert((singleResult as any)[0].roomNumberRaw === '1512', 'AIの応答が正しくJSONとしてパースされ、rawRoomsが期待するフィールド名(roomNumberRaw等)になっている');

  // ---- scanInspectionScheduleSheet (single): 配列以外が返れば502(帳票固有の要件として
  //      single/bulk問わず配列を要求する) ----
  (globalThis as any).fetch = async () =>
    new Response(JSON.stringify({ content: [{ type: 'text', text: '{"not":"an array"}' }] }), { status: 200 });
  caught = null;
  try {
    await scanInspectionScheduleSheet('single', 'image/jpeg', 'BASE64DATA');
  } catch (e) {
    caught = e as ApiError;
  }
  assert(caught instanceof ApiError && caught.status === 502, 'singleモードでも配列以外が返れば502(この帳票種別は表形式のため配列を要求する)');

  // ---- bulkモード: max_tokensが24000になり、配列であれば正しくパースされる ----
  (globalThis as any).fetch = async (url: string, init: any) => {
    capturedBody = JSON.parse(init.body);
    return new Response(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify([SAMPLE_ROW, SAMPLE_ROW]) }] }), { status: 200 });
  };
  const bulkResult = await scanInspectionScheduleSheet('bulk', 'application/pdf', 'BASE64PDF');
  assert(capturedBody.max_tokens === 24000, 'bulkモードのmax_tokensは24000(複数ページ分の配列出力を見込んで既存より引き上げ)');
  assert(Array.isArray(bulkResult) && bulkResult.length === 2, 'bulkモードは複数件のrawRooms配列として返る');

  // ---- Anthropic側がエラーを返した場合、APIキーやAnthropicの生エラーメッセージを
  //      ブラウザに漏らさない(定型メッセージのみ返す) ----
  (globalThis as any).fetch = async () =>
    new Response(JSON.stringify({ type: 'error', error: { message: 'internal detail: key=' + SECRET_KEY } }), { status: 500 });
  caught = null;
  try {
    await scanInspectionScheduleSheet('single', 'image/jpeg', 'BASE64DATA');
  } catch (e) {
    caught = e as ApiError;
  }
  assert(caught instanceof ApiError && caught.status === 502, 'Anthropic側のエラーは502としてラップされる');
  assert(caught!.message.indexOf(SECRET_KEY) === -1, '【重要】Anthropicからの生エラーメッセージ(APIキーが混入し得る)はブラウザ向けの例外メッセージに含まれない');

  globalThis.fetch = realFetch;
  console.log('ALL PASS: ai/capabilities/inspectionScheduleSheet.test.ts');
})().catch((e) => {
  globalThis.fetch = realFetch;
  console.error(e);
  process.exit(1);
});
