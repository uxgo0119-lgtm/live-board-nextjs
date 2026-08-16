// [2026-08-16新設] 新捺印表(画像)の振り分けが、入口によって変わらないことの単体テスト。
//
// 実LBで「新捺印表のJPGが読み込めない」という症状が報告された。実コードを追うと、同じJPGでも
//   ・画像1枚を直接選ぶ(routeUnifiedUpload)   → 新OCR経路 /api/v1/standardized-stamp-sheet/scan
//   ・他の資料と一緒に選ぶ／資料をまとめて追加  → Legacy  /api/scan-time-request
// と流れ先が分かれていた。Legacyは「1部屋につき1枚の点検希望時間連絡票」を読む別様式のOCRで、
// A4 1枚に全戸が並ぶ新捺印表を渡しても部屋番号を確定できず失敗する。
//
// 恒久ルール「資料読み込み入口は1つ」「Legacy/新OCRの違いをユーザーへ見せない」に沿って、
// 振り分けの基準が入口間で一致していることを固定する。
//
// 実物件名・実部屋番号は使わない（このテストの部屋番号はすべて架空）。

import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

let failures = 0;
function assert(cond: unknown, msg: string) {
  if (cond) { console.log('OK: ' + msg); return; }
  failures++;
  console.log('FAIL: ' + msg);
}

const ROOT = path.join(__dirname, '..', '..', '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

function extractFunctionSource(name: string): string {
  const marker = 'function ' + name + '(';
  const idx = html.indexOf(marker);
  if (idx === -1) throw new Error('function not found in index.html: ' + name);
  const start = html.slice(Math.max(0, idx - 6), idx) === 'async ' ? idx - 6 : idx;
  let depth = 0;
  for (let i = html.indexOf('{', idx); i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') { depth--; if (depth === 0) return html.slice(start, i + 1); }
  }
  throw new Error('unbalanced braces: ' + name);
}
function extractObjectVar(name: string): string {
  const marker = 'var ' + name + ' = ';
  const idx = html.indexOf(marker);
  if (idx === -1) throw new Error('var not found in index.html: ' + name);
  let depth = 0;
  for (let i = html.indexOf('{', idx); i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') { depth--; if (depth === 0) return html.slice(idx, i + 1) + ';'; }
  }
  throw new Error('unbalanced braces: ' + name);
}

// ---- 実関数を index.html のソースそのままで動かす（fetchだけを観測用に差し替える）--------
const requestedUrls: string[] = [];
const appliedRecordSources: string[] = [];
let fetchResponder: (url: string, init: any) => { status: number; ok: boolean; jsonBody?: unknown; textBody?: string };

const sandbox: any = {
  console, JSON, Object, Array, String, Number, Boolean, Math, Date, RegExp, isNaN,
  parseInt, parseFloat, Promise,
  fetch: (url: string, init: any) => {
    requestedUrls.push(url);
    const r = fetchResponder(url, init);
    return Promise.resolve({
      status: r.status,
      ok: r.ok,
      json: () => (r.jsonBody === undefined
        ? Promise.reject(new SyntaxError("Unexpected token '<', \"<html>\" is not valid JSON"))
        : Promise.resolve(r.jsonBody)),
    });
  },
  scanRequestHeaders: () => Promise.resolve({ 'Content-Type': 'application/json' }),
  readFileAsDataURL: () => Promise.resolve('data:image/jpeg;base64,QUJD'),
  readFileAsArrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
  compressImage: (dataUrl: string, cb: (v: string) => void) => cb(dataUrl),
  clearDemoStampDataForPropertyChange: () => {},
  applyStampBulkResult: () => {},
  applyStampSingleOcrResult: () => {},
  applyStampRecordsToLb: (records: any[], source: string) => { appliedRecordSources.push(source); return {}; },
  showToast: () => {},
  UNSUPPORTED_DOC_NOTE: 'この資料は自動読み取りに対応していません。',
  FLOORS: [{ label: '2F', rooms: ['201', '202'] }],
  XLSX: {}, FireFlowIngest: {},
};
vm.createContext(sandbox);
vm.runInContext(extractObjectVar('STANDARDIZED_STAMP_IMAGE_EXTS'), sandbox);
vm.runInContext(extractObjectVar('STANDARDIZED_STAMP_IMAGE_MIMES'), sandbox);
vm.runInContext(extractObjectVar('STANDARDIZED_STAMP_ACCEPTED_MEDIA_TYPES'), sandbox);
vm.runInContext([
  'extOfFileName',
  'guessDocumentClassification',
  'isStandardizedStampImageFile',
  'fetchStandardizedStampScanResult',
  'fetchStampOcrResult',
  'fetchStampBulkOcrResult',
  'applyStandardizedStampDataToLb',
  'docBatchProcessingPriority',
  'processDocBatchDraft',
].map(extractFunctionSource).join('\n\n'), sandbox);

const NEW_OCR_URL = '/api/v1/standardized-stamp-sheet/scan';
const LEGACY_URL = '/api/scan-time-request';

function okStampResponse() {
  return {
    status: 200, ok: true,
    jsonBody: {
      result: {
        stampData: { '201': { symbol: 'A' }, '202': { symbol: 'P' }, '999': { symbol: 'A' } },
        needsReviewRooms: [], skippedRooms: [], roomCount: 3,
        unassignedTimeDesignationRowCount: 0, unassignedTimeDesignations: [], qrCodeRaw: '',
      },
    },
  };
}

async function runDraft(fileName: string) {
  requestedUrls.length = 0;
  appliedRecordSources.length = 0;
  const ext = vm.runInContext('extOfFileName(' + JSON.stringify(fileName) + ')', sandbox);
  sandbox.__draft = {
    file: { name: fileName, type: '' },
    fileName: fileName,
    fileExt: ext,
    classification: vm.runInContext(
      'guessDocumentClassification(' + JSON.stringify(fileName) + ', ' + JSON.stringify(ext) + ')', sandbox),
    status: 'pending',
    statusNote: '',
  };
  await vm.runInContext('processDocBatchDraft(__draft)', sandbox);
  return sandbox.__draft;
}

(async () => {
  // ===================================================================================
  console.log('\n==== (1) 入口の分類 ====');
  // ===================================================================================
  const cls = vm.runInContext("guessDocumentClassification('◯◯マンション新捺印表.jpg', 'jpg')", sandbox);
  assert(cls === '捺印表', 'ファイル名に「捺印」を含むJPGは「捺印表」に分類される');
  assert(vm.runInContext("isStandardizedStampImageFile({name:'a.jpg',type:''})", sandbox) === true,
    'JPGは新捺印表の画像として判定される（拡張子だけでも判定できる）');

  // ===================================================================================
  console.log('\n==== (2) 資料をまとめて追加からでも、新OCR経路へ入る ====');
  // ===================================================================================
  fetchResponder = () => okStampResponse();
  const draft = await runDraft('◯◯マンション新捺印表.jpg');
  assert(requestedUrls.length === 1, 'OCRの呼び出しは1回');
  assert(requestedUrls[0] === NEW_OCR_URL,
    '新捺印表のJPGは新OCR経路(' + NEW_OCR_URL + ')へ送られる');
  assert(requestedUrls.indexOf(LEGACY_URL) === -1,
    '【重要】Legacy(' + LEGACY_URL + ')へは送られない');
  assert(draft.status === 'done', '取込結果はdone');
  assert(appliedRecordSources[0] === 'standardized_stamp_sheet',
    '予定情報は新捺印表として正本(StampStore)へ入る');
  assert(draft.statusNote.indexOf('2部屋分') !== -1,
    'MASTERにある2部屋が反映されたことを件数で伝える');
  assert(draft.statusNote.indexOf('1件は未反映') !== -1,
    'MASTERに無い部屋番号は反映せず、件数を伝える（OCRからMASTERを作らない）');

  const pngDraft = await runDraft('捺印表.png');
  assert(requestedUrls[0] === NEW_OCR_URL, 'PNGも同じく新OCR経路へ入る');
  assert(pngDraft.status === 'done', 'PNGもdone');

  // ===================================================================================
  console.log('\n==== (3) 既存経路（PDF一括）は変更しない ====');
  // ===================================================================================
  fetchResponder = () => ({ status: 200, ok: true, jsonBody: { result: [] } });
  const pdfDraft = await runDraft('捺印表.pdf');
  assert(requestedUrls[0] === LEGACY_URL, 'PDFは従来どおりLegacyの一括OCRへ（既存挙動を変えない）');
  assert(pdfDraft.status === 'done', 'PDFもdone');

  // ===================================================================================
  console.log('\n==== (4) 失敗の理由を黙らせない ====');
  // ===================================================================================
  fetchResponder = () => ({ status: 401, ok: false, jsonBody: { error: 'ログインが必要です。ログイン後にもう一度お試しください。' } });
  const authFail = await runDraft('新捺印表.jpg');
  assert(authFail.status === 'failed', '未ログインならfailed');
  assert(authFail.statusNote.indexOf('ログインが必要です') !== -1,
    'サーバーが返した日本語の理由をそのまま利用者へ見せる');

  // 応答がJSONでない失敗（実行時間切れ・ゲートウェイエラー等）でも、日本語で理由を伝える。
  fetchResponder = () => ({ status: 504, ok: false, textBody: '<html>Gateway Timeout</html>' });
  const timeoutFail = await runDraft('新捺印表.jpg');
  assert(timeoutFail.status === 'failed', '応答がJSONでない失敗でもfailed');
  assert(timeoutFail.statusNote.indexOf('時間がかかりすぎた') !== -1,
    '「Unexpected token」等のJavaScriptの生エラーではなく、日本語の理由を出す');

  fetchResponder = () => ({ status: 413, ok: false, textBody: '<html>Payload Too Large</html>' });
  const tooLarge = await runDraft('新捺印表.jpg');
  assert(tooLarge.statusNote.indexOf('容量が大きすぎ') !== -1, '本文サイズ超過も日本語で伝える');

  // ===================================================================================
  console.log('\n==== (5) まとめて追加したとき、部屋一覧を作る資料を先に処理する ====');
  // ===================================================================================
  // 利用者が3点を一度に選ぶ順番は決まっていない。捺印表が先に処理されると、正しく読めていても
  // 全件が「部屋一覧に無い番号」になる（MASTERにしか反映しない設計のため）。
  const selected = [
    { fileName: '新捺印表.jpg', classification: '捺印表' },
    { fileName: '感知器数.xls', classification: '感知器個数表' },
    { fileName: '点検報告書.xlsx', classification: '点検報告書' },
  ];
  sandbox.__selected = selected;
  const ordered = vm.runInContext(
    '__selected.slice().sort(function(a,b){' +
    'return docBatchProcessingPriority(a.classification) - docBatchProcessingPriority(b.classification); })',
    sandbox) as typeof selected;
  assert(ordered[ordered.length - 1].classification === '捺印表',
    '捺印表は最後に処理される（部屋一覧が揃ってから反映する）');
  assert(ordered[0].classification !== '捺印表', '部屋一覧を作りうる資料が先に処理される');
  assert(ordered.length === selected.length && selected[0].classification === '捺印表',
    '並べ替えは解析順だけで、選択したリスト自体は変えない');
  assert(vm.runInContext("docBatchProcessingPriority('住戸一覧') === 0", sandbox),
    '住戸一覧も先に処理する側');
  assert(vm.runInContext("docBatchProcessingPriority('希望時間表') === 1", sandbox),
    '希望時間表も後に処理する側（捺印表と同じ扱い）');

  // ===================================================================================
  if (failures) {
    console.error('\nstampSheetUploadRouting.test.ts: ' + failures + ' FAILED');
    process.exit(1);
  }
  console.log('\nstampSheetUploadRouting.test.ts: ALL PASS');
})();
