// SENSOR MASTER P0/P1 検証ハーネス。
// index.html から実際に出荷されるJS関数(ソースコードそのまま)を、Node.jsのvmモジュールで
// 抽出・実行する(既存のindex_html_phase1_fix_test.jsと同じ手法)。
// npm経由でxlsxパッケージをインストールできないサンドボックス制約があるため、
// ④ワークブックのグリッドはPython/openpyxlで事前にJSON化したものを使い、
// sheetToGrid()はこのテストの中で「渡されたグリッドをそのまま返す」恒等関数として
// スタブする(collectSensorBreakdownFromWorkbook自体の実装は変更せず、そのまま実行する)。
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
  'locateSensorBreakdownHeader',
  'extractRoomNumberFromNameCell',
  'collectSensorBreakdownFromWorkbook',
  'mergeSensorMasterField',
  'extendSensorMasterFromEntries',
  'sensorDisplayStateOf',
  'zenkakuDigitsToHankaku',
];

let combinedSrc = FUNCS.map(fn => extractFunctionSource(html, fn)).join('\n\n');

const sandbox = {
  console,
  SENSOR_MASTER: {},
  // sheetToGrid()は本来SheetJSのsheetオブジェクトをグリッド配列へ変換する関数だが、
  // このテストではPython(openpyxl)で事前にグリッド配列化したデータをそのまま
  // workbook.Sheets[name]として渡すため、恒等関数としてスタブする
  // (collectSensorBreakdownFromWorkbook自体のロジックは一切変更せず実行する)。
  sheetToGrid: function (sheet) { return sheet; },
  persistCurrentProperty: function () { /* no-op stub */ },
};
vm.createContext(sandbox);
vm.runInContext(combinedSrc, sandbox);

const results = { tests: [] };
function assert(cond, msg) {
  results.tests.push({ pass: !!cond, msg: msg });
  console.log((cond ? 'OK: ' : 'FAIL: ') + msg);
}

// ============================================================
// テスト1: コスモ城東野江ロイヤルフォルム実データ(④)から、collectSensorBreakdownFromWorkbook()が
// №1〜№4シートを正しく検出し、他の21シート(自火報(配）含む)を誤検出しないことを確認する。
// ============================================================
const workbook4 = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/prop13/prop13_shou4.json'), 'utf8'));
const breakdownResult = sandbox.collectSensorBreakdownFromWorkbook(workbook4);
console.log('sheetsScanned:', JSON.stringify(breakdownResult.sheetsScanned));
assert(
  JSON.stringify(breakdownResult.sheetsScanned.slice().sort()) === JSON.stringify(['№1', '№2', '№3', '№4'].sort()),
  '実データ(④)から検出された内訳シートは№1〜№4の4枚のみ(自火報(配)等の誤検出なし)'
);

const entries = breakdownResult.entries;
assert(!entries['101'], '101号室(管理人室、名称列は「管理人室」で「◯◯号室」表記でない)はエントリに含まれない(非住戸を勝手に住戸化しない)');
assert(entries['1301'] && entries['1301'].sa === 5 && entries['1301'].tei === 1, '1301号室: ④から差動式=5、定温式=1を取得(sourceLabel=' + (entries['1301'] || {}).sourceLabel + ')');
assert(entries['1402'] && entries['1402'].sa === 7 && entries['1402'].tei === 1, '1402号室: ④から差動式=7、定温式=1を取得');

const gtTotals = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/prop13/gt_totals.json'), 'utf8'));
const gtRooms = Object.keys(gtTotals);
assert(gtRooms.length === 66, 'Ground Truth総数リストは66室');
let missingFromBreakdown = gtRooms.filter(r => !entries[r]);
assert(missingFromBreakdown.length === 0, '66室全てについて④の内訳(sa/tei)が取得できている(不足:' + JSON.stringify(missingFromBreakdown) + ')');

// ============================================================
// テスト2: フィールド単位Source補完(④→sa/tei、②→total)の統合と、sensorDisplayStateOf()による
// 総数/内訳のクロスチェックを、実データ66室全件について検証する。
// ============================================================
sandbox.SENSOR_MASTER = {}; // P0のリセット相当(新しい物件セッションの開始点)
Object.keys(entries).forEach(function (room) {
  var e = entries[room];
  sandbox.mergeSensorMasterField(room, 'sa', e.sa, '④:' + e.sourceLabel);
  sandbox.mergeSensorMasterField(room, 'tei', e.tei, '④:' + e.sourceLabel);
});
// ②側(FireFlow Ingest経由のtotal)をextendSensorMasterFromEntriesで補完する(実際の呼び出し方と同じ)
var twoEntries = {};
gtRooms.forEach(function (room) { twoEntries[room] = { sa: null, tei: null, total: gtTotals[room] }; });
sandbox.extendSensorMasterFromEntries(twoEntries, 'fireflowIngest');

let totalOk = 0, saOk = 0, teiOk = 0, crossOk = 0, conflictCount = 0, unconfirmedCount = 0;
let mismatches = [];
gtRooms.forEach(function (room) {
  var ds = sandbox.sensorDisplayStateOf(room);
  if (ds.total === gtTotals[room]) totalOk++;
  if (ds.sa === entries[room].sa) saOk++;
  if (ds.tei === entries[room].tei) teiOk++;
  if (ds.state === 'confirmed' && ds.total === (ds.sa + ds.tei)) crossOk++;
  if (ds.state === 'source_conflict') conflictCount++;
  if (ds.state !== 'confirmed') unconfirmedCount++;
  if (ds.state !== 'confirmed') mismatches.push(room + ':' + ds.state);
});
console.log('total一致:', totalOk + '/66', ' sa一致:', saOk + '/66', ' tei一致:', teiOk + '/66', ' cross-validated:', crossOk + '/66');
console.log('SOURCE_CONFLICT:', conflictCount, ' unconfirmed(state!==confirmed):', unconfirmedCount, mismatches);
assert(totalOk === 66, '66室全室でtotal(②由来)が正しく保持されている');
assert(saOk === 66, '66室全室でsa(差動式、④由来)が正しく保持されている');
assert(teiOk === 66, '66室全室でtei(定温式、④由来)が正しく保持されている');
assert(crossOk === 66, '66室全室でtotal=sa+teiのクロスチェックが一致しstate=confirmedになっている');
assert(conflictCount === 0, 'SOURCE_CONFLICTは0室');
assert(unconfirmedCount === 0, '未確認(state!==confirmed)は0室');

// 1301/1402の最終値ピンポイント確認
var ds1301 = sandbox.sensorDisplayStateOf('1301');
assert(ds1301.total === 6 && ds1301.sa === 5 && ds1301.tei === 1 && ds1301.state === 'confirmed', '1301号室 最終結果: total=6/sa=5/tei=1/confirmed (実測: ' + JSON.stringify(ds1301) + ')');
var ds1402 = sandbox.sensorDisplayStateOf('1402');
assert(ds1402.total === 8 && ds1402.sa === 7 && ds1402.tei === 1 && ds1402.state === 'confirmed', '1402号室 最終結果: total=8/sa=7/tei=1/confirmed (実測: ' + JSON.stringify(ds1402) + ')');

// ============================================================
// テスト3: 未確認テスト(16章) — totalのみ既知、④に内訳が無いケース。差4/定1等を生成しないこと。
// ============================================================
sandbox.SENSOR_MASTER = {};
sandbox.mergeSensorMasterField('9999', 'total', 5, '②:synthetic');
var dsUnconfirmed = sandbox.sensorDisplayStateOf('9999');
assert(dsUnconfirmed.total === 5 && dsUnconfirmed.sa === null && dsUnconfirmed.tei === null && dsUnconfirmed.state === 'unconfirmed_null',
  '未確認テスト: total=5のみ既知、④内訳なしの場合、sa/teiはnullのまま(推測生成なし) (実測: ' + JSON.stringify(dsUnconfirmed) + ')');

// ============================================================
// テスト4: SOURCE_CONFLICTテスト(17章) — ②total=6、④sa=4/tei=1(合計5)の不一致ケース。
// ============================================================
sandbox.SENSOR_MASTER = {};
sandbox.mergeSensorMasterField('8888', 'total', 6, '②:synthetic');
sandbox.mergeSensorMasterField('8888', 'sa', 4, '④:synthetic');
sandbox.mergeSensorMasterField('8888', 'tei', 1, '④:synthetic');
var dsConflict = sandbox.sensorDisplayStateOf('8888');
assert(dsConflict.state === 'source_conflict' && dsConflict.total === 6 && dsConflict.sa === 4 && dsConflict.tei === 1,
  'SOURCE_CONFLICTテスト: total=6, sa+tei=5の不一致はsource_conflictとなり、どちらの値も自動で書き換えない (実測: ' + JSON.stringify(dsConflict) + ')');

// ============================================================
// テスト5: 状態リーク回帰テスト(18章) — 物件Aの差4/定1が物件Bへ残らないこと。
// ============================================================
sandbox.SENSOR_MASTER = {};
sandbox.mergeSensorMasterField('1301', 'sa', 4, '④:物件A_old.xlsx');
sandbox.mergeSensorMasterField('1301', 'tei', 1, '④:物件A_old.xlsx');
sandbox.mergeSensorMasterField('1301', 'total', 5, '②:物件A_old.xlsx');
var beforeReset = sandbox.sensorDisplayStateOf('1301');
assert(beforeReset.sa === 4 && beforeReset.tei === 1 && beforeReset.total === 5, '状態リークテスト前提: 物件A(旧)の1301号室はsa=4/tei=1/total=5(捏造データ)として保持されている');
// P0修正の核心: parseExcelAndRebuild()冒頭で行っている「SENSOR_MASTER = {};」と同じリセットを再現する。
sandbox.SENSOR_MASTER = {};
// 物件B(コスモ城東野江ロイヤルフォルム、実データ)の1301号室を改めて④→②の順で取り込む。
sandbox.mergeSensorMasterField('1301', 'sa', entries['1301'].sa, '④:' + entries['1301'].sourceLabel);
sandbox.mergeSensorMasterField('1301', 'tei', entries['1301'].tei, '④:' + entries['1301'].sourceLabel);
sandbox.extendSensorMasterFromEntries({ '1301': { sa: null, tei: null, total: gtTotals['1301'] } }, 'fireflowIngest');
var afterReset = sandbox.sensorDisplayStateOf('1301');
assert(afterReset.sa === 5 && afterReset.tei === 1 && afterReset.total === 6 && afterReset.state === 'confirmed',
  '状態リークテスト: リセット後は物件Aの捏造データ(sa=4/tei=1/total=5)が一切残らず、物件Bの正しい値(sa=5/tei=1/total=6)になっている (実測: ' + JSON.stringify(afterReset) + ')');

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
