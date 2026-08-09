// [2026-07-27新設 Phase7] real_ocr_provider.js の「契約テスト」。
//
// このサンドボックス環境には実際のAPIキー・外部ネットワーク疎通が無いため、実際の
// live-board-nextjs API(/api/v1/inspection-schedule-sheet/scan)へは通信できない。
// その代わり、Node上でglobal.fetchをモックし、「サーバーが返すはずのレスポンス形状」を
// 模したJSONを返させることで、real_ocr_provider.js → normalizeInspectionScheduleSheet.js →
// fsdf_builder.js → validateFsdf.js という実際のパイプラインが最後まで正しく動作し、
// 有効なFSDFが生成されることを確認する。環境制約に関係なくこのサンドボックスで実行・検証
// できる、Phase7で最も重要な統合テストと位置付ける。
//
// あわせて、認証ヘッダの組み立て(getAccessTokenの利用)・エラー系(401/ネットワークエラー/
// 想定外レスポンス形状)がmockへ自動フォールバックせず例外として伝播することも確認する。
'use strict';

var { createRealOcrProvider } = require('../real_ocr_provider.js');
var { runOcrIntakePipeline } = require('../run_pipeline.js');
var { normalizeInspectionScheduleSheet } = require('../normalize/normalizeInspectionScheduleSheet.js');
var { buildFsdfFromNormalized } = require('../fsdf_builder.js');
var { validateFsdf } = require('../../../fireflow_fsdf/validators/validateFsdf.js');

var results = [];
function check(label, cond, detail) {
  results.push({ label: label, ok: !!cond });
  console.log((cond ? 'OK' : 'NG') + ': ' + label + (detail !== undefined ? ' (' + JSON.stringify(detail) + ')' : ''));
}

// live-board-nextjs側の documentTypes/inspectionScheduleSheet.ts が要求するJSON形状
// (rawRooms相当)を模したサーバーレスポンス。
var SERVER_RAW_ROOMS = [
  { roomNumberRaw: '1512', scheduleDayRaw: '2日目', periodRaw: 'PM', timeRaw: '13:00', noteRaw: '13:00希望', statusRaw: null, ladderRaw: null, memoRaw: '', confidence: { roomNumber: 0.98, scheduleDay: 0.95, period: 0.95, time: 0.95, status: 0.95 } },
  { roomNumberRaw: '1513', scheduleDayRaw: '1日目', periodRaw: null, timeRaw: null, noteRaw: '確認済み', statusRaw: 'PASS', ladderRaw: null, memoRaw: '', confidence: { roomNumber: 0.95, status: 0.9 } },
  { roomNumberRaw: '1520', scheduleDayRaw: '2日目', periodRaw: 'PM', timeRaw: '14:00', noteRaw: '14:00希望', statusRaw: null, ladderRaw: 'はしご', memoRaw: '避難はしご設置予定', confidence: { roomNumber: 0.6, scheduleDay: 0.85, period: 0.9, time: 0.9, status: 0.9 } },
];

async function run() {
  console.log('==== ケース1: 正常系(サーバーレスポンス → real_ocr_provider → Normalizer → FSDF) ====');
  var capturedUrl = null;
  var capturedInit = null;
  var fakeFetch = function (url, init) {
    capturedUrl = url;
    capturedInit = init;
    return Promise.resolve({
      ok: true,
      status: 200,
      json: function () { return Promise.resolve({ result: SERVER_RAW_ROOMS }); },
    });
  };
  var tokenCalls = 0;
  var provider = createRealOcrProvider({
    fetchImpl: fakeFetch,
    getAccessToken: function () { tokenCalls++; return Promise.resolve('TEST-ACCESS-TOKEN'); },
  });

  var pipelineResult = await runOcrIntakePipeline(
    { propertyId: '物件A', propertyName: 'テスト物件', inspectionDate: '2026-07-27', sourceFile: 'real_scan.jpg', mode: 'single', mediaType: 'image/jpeg', data: 'QkFTRTY0REFUQQ==' },
    provider
  );

  check('real_ocr_provider経由でも正しいエンドポイントを呼び出す', capturedUrl === '/api/v1/inspection-schedule-sheet/scan', capturedUrl);
  check('mode/mediaType/dataがそのままリクエストボディに渡る', (function () {
    var body = JSON.parse(capturedInit.body);
    return body.mode === 'single' && body.mediaType === 'image/jpeg' && body.data === 'QkFTRTY0REFUQQ==';
  })());
  check('getAccessTokenが呼ばれ、Authorizationヘッダに反映される', tokenCalls === 1 && capturedInit.headers['Authorization'] === 'Bearer TEST-ACCESS-TOKEN');
  check('rawOcrResult.rawRoomsがサーバーレスポンスと同じ3件になる', pipelineResult.rawOcrResult.rawRooms.length === 3);
  check('FSDFがvalidateFsdfでvalid=trueになる', pipelineResult.validation.valid, pipelineResult.validation.errors);
  check('部屋数が3件生成される', pipelineResult.fsdf.rooms.length === 3);

  var room1513 = pipelineResult.fsdf.rooms.filter(function (r) { return r.roomNumber === '1513'; })[0];
  check('PASSはsourceStatus="pass"として正規化される(mock版と同じNormalizerを経由している証拠)', room1513 && room1513.sourceStatus === 'pass' && room1513.ocrStatusRaw === 'PASS');

  var room1520 = pipelineResult.fsdf.rooms.filter(function (r) { return r.roomNumber === '1520'; })[0];
  check('避難はしご対象(ladderRaw)がladderRoom=trueとして正規化される', room1520 && room1520.ladderRoom === true);

  check('sourceMeta.sourceType=ocr_paper_sheetが設定される(実OCR経由でも既存のFSDF形状を満たす)',
    pipelineResult.fsdf.rooms.every(function (r) { return r.sourceMeta.sourceType === 'ocr_paper_sheet'; }));

  console.log('\n==== ケース2: 認証エラー(401)は分かりやすいメッセージの例外として伝播する(mockへのフォールバックはしない) ====');
  var provider401 = createRealOcrProvider({
    fetchImpl: function () {
      return Promise.resolve({ ok: false, status: 401, json: function () { return Promise.resolve({ error: '未ログインです' }); } });
    },
    getAccessToken: null,
  });
  var caught401 = null;
  try {
    await provider401({ mode: 'single', mediaType: 'image/jpeg', data: 'AAAA' });
  } catch (e) {
    caught401 = e;
  }
  check('401時は「認証エラー」を含む分かりやすいメッセージの例外になる', caught401 && /認証エラー/.test(caught401.message), caught401 && caught401.message);

  console.log('\n==== ケース3: ネットワークエラーはmockへフォールバックせず例外として伝播する ====');
  var providerNetErr = createRealOcrProvider({
    fetchImpl: function () { return Promise.reject(new Error('getaddrinfo ENOTFOUND')); },
    getAccessToken: null,
  });
  var caughtNet = null;
  try {
    await providerNetErr({ mode: 'single', mediaType: 'image/jpeg', data: 'AAAA' });
  } catch (e) {
    caughtNet = e;
  }
  check('ネットワークエラー時は「ネットワークエラー」を含む分かりやすいメッセージの例外になる', caughtNet && /ネットワークエラー/.test(caughtNet.message), caughtNet && caughtNet.message);

  console.log('\n==== ケース4: サーバーが想定外の形状(配列でない)を返した場合、無言で通さず例外にする ====');
  var providerBadShape = createRealOcrProvider({
    fetchImpl: function () {
      return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve({ result: { not: 'an array' } }); } });
    },
    getAccessToken: null,
  });
  var caughtShape = null;
  try {
    await providerBadShape({ mode: 'single', mediaType: 'image/jpeg', data: 'AAAA' });
  } catch (e) {
    caughtShape = e;
  }
  check('配列以外のレスポンスは「形式が想定外」の例外になる(黙って空扱いにしない)', caughtShape && /想定外/.test(caughtShape.message), caughtShape && caughtShape.message);

  console.log('\n==== ケース5: mediaType/data未指定(ファイル未選択)は分かりやすいエラーになる ====');
  var providerNoInput = createRealOcrProvider({ fetchImpl: function () { throw new Error('fetch should not be called'); }, getAccessToken: null });
  var caughtNoInput = null;
  try {
    await providerNoInput({ mode: 'single' });
  } catch (e) {
    caughtNoInput = e;
  }
  check('mediaType/data未指定時はfetchを呼ぶ前にエラーになる', caughtNoInput && /画像\/PDF/.test(caughtNoInput.message), caughtNoInput && caughtNoInput.message);

  console.log('\n==== ケース6: getAccessTokenが例外を投げても(未ログイン相当)、トークン無しで送信を試みる ====');
  var capturedHeaders2 = null;
  var providerTokenFail = createRealOcrProvider({
    fetchImpl: function (url, init) {
      capturedHeaders2 = init.headers;
      return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve({ result: [] }); } });
    },
    getAccessToken: function () { return Promise.reject(new Error('not logged in')); },
  });
  await providerTokenFail({ mode: 'single', mediaType: 'image/jpeg', data: 'AAAA' });
  check('getAccessToken失敗時もAuthorizationヘッダ無しでリクエストは送られる(サーバー側401判定に委ねる)', !capturedHeaders2['Authorization']);

  var allOk = results.every(function (r) { return r.ok; });
  console.log('\n==== real_ocr_provider_contract_test 総合結果: ' + (allOk ? 'PASS' : 'FAIL') + ' (' + results.filter(function (r) { return r.ok; }).length + '/' + results.length + ') ====');
  if (!allOk) process.exitCode = 1;
}

run().catch(function (e) { console.error(e); process.exit(1); });
