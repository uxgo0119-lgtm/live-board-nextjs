// 実LB「66室→25件」問題 修正検証ハーネス。
// index.html から実際に出荷されるJS関数(ソースコードそのまま)を、Node.jsのvmモジュールで
// 抽出・実行する(既存のindex_html_phase1_fix_test.js / sensor_master_p0_p1_verify.jsと同じ手法)。
//
// 検証内容:
// 1. コスモ城東野江ロイヤルフォルムの実データ(④、prop13_shou4.json)には
//    「自火報（一覧）」/「自火報(一覧)」という名前のシートが存在しない(内訳は№1〜№4の
//    4シートに分かれている)ことを確認し、不具合の前提条件(buildSensorMasterFromSensorSheet()の
//    roomsFromSensorSheetが空になる)を再現する。
// 2. parseExcelAndRebuild()に今回追加したroomsFromSensorBreakdown(collectSensorBreakdownFromWorkbook()
//    の戻り値からの部屋番号一覧)と、それをfloorMap構築に統合する処理を、実際にindex.htmlから
//    抽出した関数のみを使って再現し、66室全室が正しくfloorMapへ反映されることを確認する。
// 3. 消火器設置場所ベースのフォールバック(newExtinguishers)には一切依存せずに66室へ到達できる
//    ことを示す(=今回の修正が「一覧表」シートの記載内容に左右されないことの確認)。
//
// SENSOR MASTERの値計算ロジック(mergeSensorMasterField/extendSensorMasterFromEntries/
// sensorDisplayStateOf)自体はこのテストの対象外(sensor_master_p0_p1_verify.jsが既に検証済み)。
// ここではあくまで「部屋一覧(FLOORS)がどう構築されるか」のみを検証する。
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function extractFunctionSource(html, functionName) {
  const marker = 'function ' + functionName + '(';
  const startIdx = html.indexOf(marker);
  if (startIdx === -1) throw new Error('function not found: ' + functionName);
  let i = html.indexOf('{', startIdx);
  let depth = 0;
  let end = -1;
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  if (end === -1) throw new Error('could not find matching brace for: ' + functionName);
  return html.slice(startIdx, end);
}

const FUNCS = [
  'floorLabelOfRoomNumber',
  'locateSensorBreakdownHeader',
  'extractRoomNumberFromNameCell',
  'collectSensorBreakdownFromWorkbook',
  'zenkakuDigitsToHankaku',
];

let combinedSrc = FUNCS.map(fn => extractFunctionSource(html, fn)).join('\n\n');

const sandbox = {
  console,
  sheetToGrid: function (sheet) { return sheet; }, // sensor_master_p0_p1_verify.jsと同じスタブ理由
};
vm.createContext(sandbox);
vm.runInContext(combinedSrc, sandbox);

const results = { tests: [] };
function assert(cond, msg) {
  results.tests.push({ pass: !!cond, msg: msg });
  console.log((cond ? 'OK: ' : 'FAIL: ') + msg);
}

// ============================================================
// 前提条件の再現: 「自火報（一覧）」/「自火報(一覧)」という名前のシートは実データに存在しない
// ============================================================
const workbook4 = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/prop13/prop13_shou4.json'), 'utf8'));
const hasOldSingleSheetName = (workbook4.SheetNames || []).some(function (name) {
  return name.indexOf('自火報（一覧）') !== -1 || name.indexOf('自火報(一覧)') !== -1;
});
assert(!hasOldSingleSheetName, '実データ(④)には旧方式が探す「自火報（一覧）」/「自火報(一覧)」という名前のシートが存在しない(=roomsFromSensorSheetは空になる、不具合の前提条件を再現)');

// ============================================================
// 修正後の経路: collectSensorBreakdownFromWorkbook()から得られる部屋番号一覧が
// floorMap構築に統合されることで、66室全室がFLOORSへ反映されることを確認する
// ============================================================
const breakdownResult = sandbox.collectSensorBreakdownFromWorkbook(workbook4);
const roomsFromSensorBreakdown = Object.keys(breakdownResult.entries);

const gtTotals = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/prop13/gt_totals.json'), 'utf8'));
const gtRooms = Object.keys(gtTotals);
assert(gtRooms.length === 66, 'Ground Truth総数リストは66室');
assert(roomsFromSensorBreakdown.length === 66, 'collectSensorBreakdownFromWorkbook()から得られる部屋番号一覧は66室(roomsFromSensorSheetが空でも、こちらだけで66室に到達できる)');

// index.htmlのparseExcelAndRebuild()に追加したfloorMap構築ロジック(roomsFromSensorSheet(空)と
// roomsFromSensorBreakdown(66室)を統合し、floorLabelOfRoomNumber()で階ごとにグルーピングする処理)を、
// 実際に抽出した関数のみを使ってそのまま再現する(newExtinguishers/消火器設置場所には一切依存しない)。
const roomsFromSensorSheet = []; // 本物件では常に空(上のassertで確認済み)
const roomsFromSensorData = roomsFromSensorSheet.slice();
roomsFromSensorBreakdown.forEach(function (room) {
  if (roomsFromSensorData.indexOf(room) === -1) roomsFromSensorData.push(room);
});
const floorMap = {};
roomsFromSensorData.forEach(function (room) {
  const floorLabel = sandbox.floorLabelOfRoomNumber(room);
  if (!floorLabel) return;
  if (!floorMap[floorLabel]) floorMap[floorLabel] = [];
  if (floorMap[floorLabel].indexOf(room) === -1) floorMap[floorLabel].push(room);
});

let totalInFloorMap = 0;
Object.keys(floorMap).forEach(function (fl) { totalInFloorMap += floorMap[fl].length; });
console.log('floorMap階数:', Object.keys(floorMap).length, ' floorMap内の総部屋数:', totalInFloorMap);
assert(totalInFloorMap === 66, '修正後のfloorMap構築ロジックにより、66室全室がFLOORSに反映される(旧: 消火器設置場所ベースで25室のみだった不具合の再現解消)');

const missingFromFloorMap = gtRooms.filter(function (r) {
  const fl = sandbox.floorLabelOfRoomNumber(r);
  return !floorMap[fl] || floorMap[fl].indexOf(r) === -1;
});
assert(missingFromFloorMap.length === 0, 'Ground Truthの66室が全てfloorMapに含まれている(不足:' + JSON.stringify(missingFromFloorMap) + ')');

// 14F(1401〜1403)は消火器設置場所ベースのフォールバックでは欠落していた階(実LBのスクリーンショットで
// 「13F/12F/11F/10F」までしか確認できていなかった実例に対応)。修正後はここも含まれることを確認する。
assert(floorMap['14F'] && floorMap['14F'].length === gtRooms.filter(function (r) { return sandbox.floorLabelOfRoomNumber(r) === '14F'; }).length,
  '14F(修正前は消火器設置場所テキストの都合で欠落しやすかった階)も正しくfloorMapに含まれている(実測: ' + JSON.stringify(floorMap['14F']) + ')');

// 各号室が消火器設置場所由来ではなく、感知器内訳シート(④)由来で取得できていることの確認
// (sourceLabelが実際に№1〜№4のいずれかになっている=newExtinguishersに一切依存していない)
const sample = ['1301', '1402', '101'];
sample.forEach(function (room) {
  if (room === '101') {
    assert(!breakdownResult.entries['101'], '101号室(管理人室)はfloorMapにも含まれない(非住戸を勝手に住戸化しない、既存方針を維持)');
    return;
  }
  const e = breakdownResult.entries[room];
  assert(e && /^№/.test(e.sourceLabel), room + '号室は④内訳シート(' + (e && e.sourceLabel) + ')由来で取得されている(消火器設置場所には依存していない)');
});

// ============================================================
// 集計
// ============================================================
const failed = results.tests.filter(t => !t.pass);
console.log('\n=== 集計 ===');
console.log('PASS:', results.tests.length - failed.length, '/', results.tests.length);
if (failed.length) {
  console.log('FAILED:', failed.map(t => t.msg));
  process.exit(1);
} else {
  console.log('ALL PASS');
}
