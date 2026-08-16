// [2026-08-16新設] 感知器個数の取込における一般ルール3点の単体テスト。
//
// 2026-08-16の実ファイル監査で、感知器個数のExcelが「読めるはずなのに1件も反映されない」
// 原因が3つ確定した。いずれも特定物件の事情ではなく、複数シート構成のExcel・略記の表記ゆれ
// という一般的な条件で起きるため、一般ルールとして再発防止する。
//
//  (1) 個数の語句が「差動N・定温M」ではなく略記「差N・定M」でも読めること
//      （読めた値を捨てない。sa=N / tei=M / total=N+M）
//  (2) Parserへ渡すシートを1枚目固定にせず、実際に値のあるシートを選ぶこと
//      （1シート構成の帳票では従来と完全に同じ結果になること）
//  (3) 既存の部屋へ個数を補完しただけの取込でも保存されること
//      （「読み取り直後は出るのに、再読込で消える」の再発防止）
//
// 実物件名・実部屋番号は使わない（このテストの部屋番号はすべて架空の連番）。
// 実ファイルによる検証は test/trace/ 配下の調査スクリプトで別途行う。

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

// ---- ブラウザと同じソースのまま FireFlow Ingest を読み込む --------------------------
const ingestSource = fs.readFileSync(
  path.join(ROOT, 'public', 'fireflow_ingest', 'dist', 'fireflow-ingest.browser.js'), 'utf8');
const ingestSandbox: Record<string, unknown> = { console, module: undefined, window: {} };
(ingestSandbox as any).globalThis = ingestSandbox;
vm.createContext(ingestSandbox);
vm.runInContext(ingestSource, ingestSandbox);
const FireFlowIngest: any = (ingestSandbox as any).FireFlowIngest || (ingestSandbox as any).window.FireFlowIngest;

// ---- index.html から出荷される実関数を、ソースそのまま取り出す ------------------------
// （public/test/sensor_master_p0_p1_verify.js と同じ手法。sheetToGrid だけは
//   「渡されたグリッドをそのまま返す」恒等関数としてスタブし、シート→グリッド変換ではなく
//   シート選択・保存条件のロジックそのものを検証する）
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
function extractFunctionSource(name: string): string {
  const marker = 'function ' + name + '(';
  const idx = html.indexOf(marker);
  if (idx === -1) throw new Error('function not found in index.html: ' + name);
  let depth = 0;
  for (let i = html.indexOf('{', idx); i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') { depth--; if (depth === 0) return html.slice(idx, i + 1); }
  }
  throw new Error('unbalanced braces: ' + name);
}

const persistCalls: string[] = [];
const lbSandbox: Record<string, unknown> = {
  console,
  SENSOR_MASTER: {},
  sheetToGrid: (sheet: unknown) => sheet,
  persistCurrentProperty: () => { persistCalls.push('persist'); },
};
vm.createContext(lbSandbox);
vm.runInContext([
  'pickIngestSheetResult',
  'scoreSensorCountResult',
  'scoreRoomRosterResult',
  'mergeSensorMasterField',
  'extendSensorMasterFromEntries',
].map(extractFunctionSource).join('\n\n'), lbSandbox);
const lb: any = lbSandbox;

// =====================================================================================
console.log('\n==== (1) 個数の略記「差N・定M」を一般ルールとして読む ====');
// =====================================================================================

// 部屋番号の行＋その直下に個数、という既存レイアウトはそのまま。語句だけが略記。
const abbreviatedGrid = [
  ['101', '102', '103', '104'],
  ['差4・定2', '差3・定2', '差5・定2', '差4・定2'],
];
const abbreviated = FireFlowIngest.parseSensorCountSheet(abbreviatedGrid);
assert(abbreviated.ok === true, '略記「差N・定M」の帳票を解析できる');
assert(abbreviated.matchedParserId === 'sensorCount.roomOnlyPairRowsFormat.v1',
  '略記は既存の「部屋番号のみペア行形式」Parserが担当する（フォーマットを増やしていない）');
assert(abbreviated.data.sensorMaster['101'].sa === 4 && abbreviated.data.sensorMaster['101'].tei === 2,
  '「差4・定2」→ sa=4 / tei=2');
assert(abbreviated.data.sensorMaster['103'].sa === 5 && abbreviated.data.sensorMaster['103'].tei === 2,
  '同じ行の他の部屋も個別に読める');

// 表記ゆれ（全角数字・注記の併記）を吸収する。
const variantGrid = [
  ['201', '202'],
  ['差４・定２', '差3・定2\n（右側：CL）'],
];
const variant = FireFlowIngest.parseSensorCountSheet(variantGrid);
assert(variant.ok === true, '全角数字・注記付きでも解析できる');
assert(variant.data.sensorMaster['201'].sa === 4 && variant.data.sensorMaster['201'].tei === 2,
  '全角「差４・定２」→ sa=4 / tei=2');
assert(variant.data.sensorMaster['202'].sa === 3 && variant.data.sensorMaster['202'].tei === 2,
  '注記が続いても個数だけを読む');

// 既存の正式表記が従来どおり読めること（略記対応で壊していないこと）。
const fullWordGrid = [
  ['301', '302'],
  ['差動4・定温2', '差動3・定温2'],
];
const fullWord = FireFlowIngest.parseSensorCountSheet(fullWordGrid);
assert(fullWord.ok === true && fullWord.data.sensorMaster['301'].sa === 4 && fullWord.data.sensorMaster['301'].tei === 2,
  '従来の「差動N・定温M」表記は従来どおり読める');

// 「差動式スポット型」のように語句の直後が数字でない場合は個数として誤読しない。
const labelOnlyGrid = [
  ['401', '402'],
  ['差動式スポット型', '定温式スポット型'],
];
const labelOnly = FireFlowIngest.parseSensorCountSheet(labelOnlyGrid);
assert(!labelOnly.ok || !(labelOnly.data.sensorMaster['401'] || {}).sa,
  '語句だけのセルから個数を捏造しない');

// 読めた値を捨てない: total = sa + tei が正式内部データ(FSDF)まで届く。
const intake = FireFlowIngest.toPropertyMasterIntake({ sensorCountResult: abbreviated });
assert(intake.payload.sensorMaster['101'].total === 6, 'total = sa + tei = 6 が正式内部データへ届く');

// =====================================================================================
console.log('\n==== (2) Parserへ渡すシートを1枚目固定にしない ====');
// =====================================================================================

// 1枚目・2枚目は部屋番号だけ（個数なし）、3枚目にだけ個数がある複数シート構成。
const roomsOnlySheet = [['101', '102', '103', '104']];
const multiSheetWorkbook = {
  SheetNames: ['テンプレート', '控え', '個数'],
  Sheets: { 'テンプレート': roomsOnlySheet, '控え': roomsOnlySheet, '個数': abbreviatedGrid },
};
const picked = lb.pickIngestSheetResult(
  multiSheetWorkbook, FireFlowIngest.parseSensorCountSheet, lb.scoreSensorCountResult);
assert(picked && picked.sheetName === '個数', '値のあるシートが採用される（1枚目固定ではない）');
assert(picked.result.ok === true && picked.score === 4, '採用シートから4室分の個数が取れている');

// シート名には依存しない（名前の手がかりが無くても値のある方を選ぶ）。
const namelessWorkbook = {
  SheetNames: ['Sheet1', 'Sheet2'],
  Sheets: { 'Sheet1': roomsOnlySheet, 'Sheet2': abbreviatedGrid },
};
const pickedNameless = lb.pickIngestSheetResult(
  namelessWorkbook, FireFlowIngest.parseSensorCountSheet, lb.scoreSensorCountResult);
assert(pickedNameless && pickedNameless.sheetName === 'Sheet2',
  'シート名の手がかりが無くても、値のあるシートを選ぶ');

// 部屋一覧は「部屋番号が最も多く取れたシート」を選ぶ。
const rosterPick = lb.pickIngestSheetResult(
  multiSheetWorkbook, FireFlowIngest.parseRoomRosterSheet, lb.scoreRoomRosterResult);
assert(rosterPick && rosterPick.result.ok === true && rosterPick.score === 4,
  '同じWorkbookから部屋一覧(4室)も取得できる');

// 【回帰】1シート構成の帳票では、従来（1枚目をそのまま解析）と完全に同じ結果になる。
const singleOkWorkbook = { SheetNames: ['個数'], Sheets: { '個数': abbreviatedGrid } };
const singleOk = lb.pickIngestSheetResult(
  singleOkWorkbook, FireFlowIngest.parseSensorCountSheet, lb.scoreSensorCountResult);
assert(JSON.stringify(singleOk.result) === JSON.stringify(FireFlowIngest.parseSensorCountSheet(abbreviatedGrid)),
  '1シート(成功): 従来の「1枚目をそのまま解析」と結果が完全一致');

const singleNgWorkbook = { SheetNames: ['テンプレート'], Sheets: { 'テンプレート': roomsOnlySheet } };
const singleNg = lb.pickIngestSheetResult(
  singleNgWorkbook, FireFlowIngest.parseSensorCountSheet, lb.scoreSensorCountResult);
assert(JSON.stringify(singleNg.result) === JSON.stringify(FireFlowIngest.parseSensorCountSheet(roomsOnlySheet)),
  '1シート(失敗): 失敗結果・エラー文言まで従来と完全一致（画面表示が変わらない）');

// 全シートが解析失敗の複数シート構成でも、従来と同じ「失敗」を返す（黙って成功にしない）。
const allNgWorkbook = { SheetNames: ['A', 'B'], Sheets: { 'A': roomsOnlySheet, 'B': roomsOnlySheet } };
const allNg = lb.pickIngestSheetResult(
  allNgWorkbook, FireFlowIngest.parseSensorCountSheet, lb.scoreSensorCountResult);
assert(allNg && allNg.result.ok === false, '全シート失敗なら失敗のまま（成功に見せかけない）');

// =====================================================================================
console.log('\n==== (3) 既存の部屋への補完だけでも保存される ====');
// =====================================================================================

lb.SENSOR_MASTER = {};
persistCalls.length = 0;
const addedNew = lb.extendSensorMasterFromEntries({ '101': { sa: 4, tei: 2, total: 6 } }, 'fireflowIngest');
assert(addedNew.length === 1, '新規の部屋は「追加」として数えられる');
assert(persistCalls.length === 1, '新規追加時に保存される（従来どおり）');

// 既に部屋のエントリがあり、未確定のフィールドだけを補完するケース。
lb.SENSOR_MASTER = { '102': { total: 6, totalSource: '②:fireflowIngest' } };
persistCalls.length = 0;
const addedFields = lb.extendSensorMasterFromEntries({ '102': { sa: 4, tei: 2, total: null } }, 'fireflowIngest');
assert(addedFields.length === 0, '既存の部屋なので「新規追加」は0件');
assert(lb.SENSOR_MASTER['102'].sa === 4 && lb.SENSOR_MASTER['102'].tei === 2, 'sa/teiが補完される');
assert(persistCalls.length === 1, '新規追加が0件でも、値が変われば保存される（再読込で消えない）');

// 何も変わらない再取込では、余計な保存を走らせない。
persistCalls.length = 0;
lb.extendSensorMasterFromEntries({ '102': { sa: 4, tei: 2, total: null } }, 'fireflowIngest');
assert(persistCalls.length === 0, '同じ値の再取込では保存しない（無駄な書き込みを増やさない）');

// 値が1つも読めなかった部屋を「追加した」と数えない（件数を捏造しない）。
lb.SENSOR_MASTER = {};
persistCalls.length = 0;
const addedNull = lb.extendSensorMasterFromEntries({ '103': { sa: null, tei: null, total: null } }, 'fireflowIngest');
assert(addedNull.length === 0, '値が読めなかった部屋は「感知器個数を追加した」件数に含めない');
assert(persistCalls.length === 0, '何も書き込まれていないので保存も走らない');

// =====================================================================================
if (failures) {
  console.error('\nsensorCountSheetSelection.test.ts: ' + failures + ' FAILED');
  process.exit(1);
}
console.log('\nsensorCountSheetSelection.test.ts: ALL PASS');
