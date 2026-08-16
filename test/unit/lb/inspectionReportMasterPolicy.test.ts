// [2026-08-16新設] 点検報告書Excelの取込が MASTER（部屋一覧＝FLOORS）に対して守るべき
// 一般ルールの単体テスト。
//
// 実LBで「本来39室の物件が94室になる」症状が確認された。実ファイルで再現した内訳は、
//   ・点検報告書が、消火器の設置場所テキストから代用の部屋一覧(70室)を黙って作る
//   ・その後、正しい住戸一覧(39室)を取り込むと「追加のみ」でマージされる
//   ・70 + 39 - 重複15 = 94
// であり、投入順を逆にすると今度は正しい39室が70室で丸ごと置き換わって消えていた。
//
// 恒久ルール（MASTERはExcel由来の正しい住戸一覧を1つだけ持つ）に沿った一般ルールとして、
//
//  (1) 部屋一覧の正本を持つ点検報告書（自火報の一覧／感知器の型式内訳シートに部屋番号がある）は
//      従来どおり FLOORS を作り直す ＝ 他物件の正式MASTER経路を壊さない
//  (2) 部屋一覧の正本を持たない点検報告書は、MASTERを作らない・増やさない・削らない
//      （消火器の設置場所テキストから代用の部屋一覧を作らない）
//  (3) その場合でも、読めた情報（消火器・前回不良・設備一覧・物件名等）は捨てずに取り込む
//  (4) その場合、先に取り込んだ感知器個数(SENSOR_MASTER)や点検中データを消さない
//  (5) 部屋一覧を作っていないのに「全N部屋を読み込みました」と成功表示しない
//
// 実物件名・実部屋番号は使わない（このテストの部屋番号はすべて架空）。
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

// ---- 実関数を index.html のソースそのままで動かす -------------------------------------
// スタブ化するのは副作用側（DOM・トースト・保存・再描画）のみ。sheetToGrid だけは
// 「渡されたグリッドをそのまま返す」恒等関数にし、シートをグリッドの配列で表現する。
const toasts: string[] = [];
const resetCalls: string[] = [];

function makeElement() {
  const el: any = {
    textContent: '', value: '', style: {}, options: [],
    appendChild: () => {}, setAttribute: () => {}, getAttribute: () => null,
    querySelector: () => makeElement(), querySelectorAll: () => [],
  };
  return el;
}

const sandbox: any = {
  console, JSON, Object, Array, String, Number, Boolean, Math, Date, RegExp, isNaN,
  parseInt, parseFloat,
  document: {
    getElementById: () => makeElement(),
    querySelector: () => makeElement(),
    querySelectorAll: () => [],
    createElement: () => makeElement(),
  },
  sheetToGrid: (sheet: unknown) => sheet,
  showToast: (m: string) => { toasts.push(m); },
  persistCurrentProperty: () => {},
  persistScheduleDays: () => { resetCalls.push('persistScheduleDays'); },
  seedScheduleDaysIfNeeded: () => {},
  clearDemoStampDataForPropertyChange: () => { resetCalls.push('clearDemoStampData'); },
  reloadStampStoreForCurrentProperty: () => { resetCalls.push('reloadStampStore'); },
  initScheduleLabels: () => {}, renderFilterChips: () => {}, renderFloors: () => {},
  renderPropertyInfo: () => {}, showView: () => {}, syncDateDisplays: () => {},
  siteSupervisorLocked: false,
  LAST_EQUIPMENT_LIST_NOISE_EXCLUDED: [],
  PROPERTY: {}, FLOORS: [], TOTAL_ROOMS: 0, SENSOR_MASTER: {},
  EXTINGUISHER_DATA: [], EQUIPMENT_LIST: [], PREVIOUS_DEFECTS: [],
  LADDER_ROOMS: [], EVACUATION_EQUIPMENT_ROOMS: [],
  state: {}, scheduleLabels: {}, haBadges: {}, sensorCounts: {},
  extinguisherState: {}, equipmentState: {},
  currentHomeMode: 'normal', activeFilter: null,
};
vm.createContext(sandbox);

const FUNCS = [
  'zenkakuDigitsToHankaku', 'ladderTextToHalfWidthDigits', 'floorLabelOfRoomNumber',
  'normalizeFloorLabel', 'extractRoomNumberFromIchiranRow', 'extractLadderRooms',
  'extractInspectionType', 'excelSerialToJPDate', 'normalizeInspectionDateValue',
  'findSheetByName', 'findSheetsByPrefix', 'findSheetByContains',
  'locateSensorBreakdownHeader', 'extractRoomNumberFromNameCell',
  'collectSensorBreakdownFromWorkbook', 'buildSensorMasterFromSensorSheet',
  'extractEquipmentList', 'isEquipmentListNoiseLabel', 'mergeSensorMasterField',
  'parseExcelAndRebuild',
];
vm.runInContext(FUNCS.map(extractFunctionSource).join('\n\n'), sandbox);

// ---- 架空の点検報告書Workbook ---------------------------------------------------------
// 「一覧表」: 消火器の設置場所。設置場所テキストには号室が書かれている（＝代用の部屋一覧を
// 作ろうと思えば作れてしまう状態）。データ行はindex 4から、No.列が数値の行のみ。
function ichiranSheet() {
  const grid: any[][] = [[], [], [], [], []];
  const rooms = ['201', '203', '205', '301', '303', '305', '401', '403'];
  rooms.forEach((room, i) => {
    const row: any[] = [];
    row[0] = i + 1;
    row[1] = room.slice(0, 1) + '階';
    row[3] = room + '号室前';
    row[6] = 'MODEL-1';
    row[8] = 'メーカーA';
    row[9] = '0000' + i;
    row[11] = '2025';
    grid.push(row);
  });
  return grid;
}

// 「自火報（一覧）」: 部屋一覧の正本。B列＝部屋番号、F列＝差動式、G列＝定温式。
function jikahoSheet(rooms: string[]) {
  return rooms.map((room) => {
    const row: any[] = [];
    row[1] = room;
    row[5] = 4;
    row[6] = 2;
    return row;
  });
}

function makeWorkbook(withJikaho: boolean) {
  const sheets: Record<string, unknown> = { '一覧表': ichiranSheet() };
  const names = ['一覧表'];
  if (withJikaho) {
    // 正本の部屋一覧は「一覧表」の号室とは意図的に別集合にし、どちらが採用されたか判別できるようにする。
    sheets['自火報（一覧）'] = jikahoSheet(['1101', '1102', '1103', '1104', '1105']);
    names.push('自火報（一覧）');
  }
  return { SheetNames: names, Sheets: sheets };
}

function roomsOfMaster(): string[] {
  return sandbox.FLOORS.reduce((a: string[], f: any) => a.concat(f.rooms), []);
}
function resetLb() {
  sandbox.PROPERTY = { name: '', inspectionDate: '', inspectionType: '', siteSupervisor: '' };
  sandbox.FLOORS = []; sandbox.TOTAL_ROOMS = 0; sandbox.SENSOR_MASTER = {};
  sandbox.EXTINGUISHER_DATA = []; sandbox.EQUIPMENT_LIST = []; sandbox.PREVIOUS_DEFECTS = [];
  sandbox.state = {};
  toasts.length = 0; resetCalls.length = 0;
}
function run(workbook: unknown) {
  sandbox.__wb = workbook;
  vm.runInContext('parseExcelAndRebuild(__wb)', sandbox);
}

// =====================================================================================
console.log('\n==== (1) 部屋一覧の正本を持つ報告書は、従来どおりMASTERを作る ====');
// =====================================================================================

resetLb();
run(makeWorkbook(true));
assert(roomsOfMaster().length === 5, '自火報の一覧がある報告書は、その5室でMASTERを作る');
assert(roomsOfMaster().indexOf('1101') !== -1, '部屋一覧は自火報の一覧の部屋番号になる');
assert(roomsOfMaster().indexOf('201') === -1, '消火器の設置場所の号室はMASTERに混ざらない');
assert(sandbox.TOTAL_ROOMS === 5, 'TOTAL_ROOMSも5室');
assert(resetCalls.indexOf('clearDemoStampData') !== -1,
  '「新しい物件の読込」として点検中データ・予定情報がリセットされる（従来どおり）');
assert(sandbox.PROPERTY.name !== '', '物件名が差し替わる（従来どおり）');
assert(toasts.some((t) => t.indexOf('全5部屋') !== -1), '成功トーストは実際の部屋数を伝える');

// 【回帰】部屋一覧の正本を持つ報告書は、既に別のMASTERがあっても従来どおり作り直す。
resetLb();
sandbox.FLOORS = [{ label: '9F', rooms: ['901', '902'] }];
sandbox.TOTAL_ROOMS = 2;
run(makeWorkbook(true));
assert(roomsOfMaster().length === 5 && roomsOfMaster().indexOf('901') === -1,
  '正本を持つ報告書の読込は、従来どおり物件の入れ替え（既存MASTERを引き継がない）');

// =====================================================================================
console.log('\n==== (2) 部屋一覧の正本を持たない報告書は、MASTERを作らない ====');
// =====================================================================================

resetLb();
run(makeWorkbook(false));
assert(roomsOfMaster().length === 0,
  '消火器の設置場所テキストから代用の部屋一覧を作らない（MASTERを作らない）');
assert(sandbox.TOTAL_ROOMS === 0, 'TOTAL_ROOMSも0のまま');
assert(toasts.some((t) => t.indexOf('部屋一覧') !== -1 && t.indexOf('ありませんでした') !== -1),
  '部屋一覧が無いことを利用者へ明示する');

// =====================================================================================
console.log('\n==== (3) 正本を持たなくても、読めた情報は捨てない ====');
// =====================================================================================

assert(sandbox.EXTINGUISHER_DATA.length === 8, '消火器8本は取り込まれる');
assert(sandbox.PROPERTY.name !== '', '物件名（既定値）は設定される');
assert(sandbox.PROPERTY.inspectionDate !== undefined, '点検日の項目が失われない');

// =====================================================================================
console.log('\n==== (4) 既にMASTERがある状態では、増やさない・削らない・消さない ====');
// =====================================================================================

resetLb();
// 先に正しい住戸一覧（Excel由来）でMASTERが確定し、感知器個数と点検中データもある状態を作る。
sandbox.FLOORS = [{ label: '4F', rooms: ['401', '403'] }, { label: '2F', rooms: ['201', '203'] }];
sandbox.TOTAL_ROOMS = 4;
sandbox.SENSOR_MASTER = { '401': { sa: 4, tei: 2, total: 6 } };
sandbox.state = { '401': { status: 'done' } };
sandbox.PROPERTY = { name: '既存物件', inspectionDate: '', inspectionType: '', siteSupervisor: '' };
run(makeWorkbook(false));

const after = roomsOfMaster();
assert(after.length === 4, 'MASTERの室数が変わらない（増やさない・削らない）');
assert(['401', '403', '201', '203'].every((r) => after.indexOf(r) !== -1), '部屋番号も元のまま');
assert(sandbox.SENSOR_MASTER['401'] && sandbox.SENSOR_MASTER['401'].sa === 4,
  '先に取り込んだ感知器個数を消さない（読めた情報を捨てない）');
assert(sandbox.state['401'] && sandbox.state['401'].status === 'done', '点検中データを消さない');
assert(resetCalls.indexOf('clearDemoStampData') === -1, '予定情報（StampStore）のリセットも行わない');
assert(sandbox.PROPERTY.name === '既存物件',
  '物件の同一性（＝予定情報の保存スコープ）を黙って書き換えない');
assert(sandbox.EXTINGUISHER_DATA.length === 8, '既存MASTERへ設備情報（消火器）は付与される');
assert(toasts.some((t) => t.indexOf('4件のまま') !== -1),
  '「部屋一覧は現在の4件のまま変更していない」ことを伝える');

// =====================================================================================
console.log('\n==== (5) 部屋一覧を作っていないのに成功表示しない ====');
// =====================================================================================

assert(!toasts.some((t) => /全\d+部屋/.test(t)),
  '部屋一覧を作っていない取込で「全N部屋を読み込みました」と表示しない');
assert(toasts.some((t) => t.indexOf('消火器8本') !== -1),
  '実際に取り込んだもの（消火器8本）だけを伝える');

// =====================================================================================
if (failures) {
  console.error('\ninspectionReportMasterPolicy.test.ts: ' + failures + ' FAILED');
  process.exit(1);
}
console.log('\ninspectionReportMasterPolicy.test.ts: ALL PASS');
