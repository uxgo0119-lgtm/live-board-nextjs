// [2026-08-13新設 新捺印表OCR→LB接続]
// public/index.html から実際に出荷されるJS関数(ソースコードそのまま)をvmで抽出・実行し、
// 新捺印表OCRの変換結果がLive Boardの部屋カードへ正しく反映されることを検証する。
// 既存の public/test/*.js(index_html_phase1_fix_test.js 等)と同じ抽出手法を使う。
//
// 検証内容:
// 1. OCR65室を、Excel由来のMASTER66室へ適用しても1102が消えない(MASTER/DELTAの原則)
// 2. 複数チェックの部屋(802/1005/805)がA/P/キャンセルとして確定表示されない
// 3. 要確認バッジが出る
// 4. 実物件読込時にデモSTAMP_DATAが残らない

import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import { toLiveBoardStampData } from '../../../lib/ocr/standardizedStampSheet/toLiveBoardStampData';
import { normalizeStandardizedStampScan } from '../../../lib/ocr/standardizedStampSheet/normalizeStandardizedStamp';

function assert(cond: unknown, msg: string) { if (!cond) throw new Error('FAIL: ' + msg); }

const html = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'public', 'index.html'), 'utf8');

function extractFunctionSource(functionName: string): string {
  const marker = 'function ' + functionName + '(';
  const startIdx = html.indexOf(marker);
  if (startIdx === -1) throw new Error('function not found: ' + functionName);
  let i = html.indexOf('{', startIdx);
  let depth = 0;
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') { depth--; if (depth === 0) return html.slice(startIdx, i + 1); }
  }
  throw new Error('unbalanced braces: ' + functionName);
}

const FUNCS = [
  'initScheduleLabels',
  'formatStampTimeDisplay',
  'scheduleDayColorForIndex',
  'stampReviewBadgeHtmlFor',
  'clearDemoStampDataForPropertyChange',
  'escapeHtml',
];

// 実物件(コスモ城東野江ロイヤルフォルム)の66室。感知器内訳Excel由来のMASTER(1102を含む)。
const MASTER_ROOMS = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', '..', '..', 'public', 'test', 'fixtures', 'prop13', 'gt_totals.json'), 'utf8')
);
const masterRoomNumbers: string[] = Object.keys(MASTER_ROOMS);
assert(masterRoomNumbers.length === 66, 'MASTERは66室');
assert(masterRoomNumbers.indexOf('1102') !== -1, 'MASTERに1102が含まれる');

function floorLabelOf(room: string): string {
  return (room.length === 4 ? room.slice(0, 2) : room.slice(0, 1)) + 'F';
}
function buildFloors(rooms: string[]) {
  const byFloor: Record<string, string[]> = {};
  rooms.forEach((r) => { const f = floorLabelOf(r); (byFloor[f] = byFloor[f] || []).push(r); });
  return Object.keys(byFloor).map((label) => ({ label, rooms: byFloor[label] }));
}

function makeSandbox(stampData: Record<string, unknown>) {
  const sandbox: Record<string, unknown> = {
    console,
    FLOORS: buildFloors(masterRoomNumbers),
    STAMP_DATA: stampData,
    SENSOR_MASTER: {},
    EVACUATION_EQUIPMENT_ROOMS: [],
    scheduleLabels: {},
    haBadges: {},
    sensorCounts: {},
    scheduleDayColors: {},
  };
  vm.createContext(sandbox);
  vm.runInContext(FUNCS.map(extractFunctionSource).join('\n\n'), sandbox);
  return sandbox;
}

// 実APIで確定した内容と同じ65室分のOCR結果を作る(1102は捺印表に印字が無いので含めない)。
const SYMBOLS: Record<string, 'A' | 'P' | 'C' | 'AP' | 'PC'> = {
  '1003': 'P', '405': 'P', '802': 'AP', '1005': 'PC', '805': 'PC',
  '1001': 'A', '705': 'P', '603': 'A', '503': 'A', '1305': 'P',
  '602': 'A', '505': 'A', '403': 'A', '402': 'A', '401': 'P', '302': 'A', '103': 'P',
};
const ocrRooms = masterRoomNumbers
  .filter((r) => r !== '1102')
  .map((room) => {
    const sym = SYMBOLS[room] || 'A';
    return {
      room_number: room,
      raw_checkboxes: {
        a_checked: sym === 'A' || sym === 'AP',
        p_checked: sym === 'P' || sym === 'AP' || sym === 'PC',
        cancel_checked: sym === 'C' || sym === 'PC',
      },
    };
  });
assert(ocrRooms.length === 65, 'OCRは65室');

const scan = {
  rooms: ocrRooms,
  time_designation_rows: [
    { row_index: 1, room_number_cells: ['1', '3', '0', '5'], start_time_cells: ['1', '4', '0', '0'], end_time_cells: ['', '', '', ''], remarks_raw: '' },
    { row_index: 2, room_number_cells: ['1', '0', '0', '1'], start_time_cells: ['1', '0', '0', '0'], end_time_cells: ['1', '1', '3', '0'], remarks_raw: '' },
    { row_index: 3, room_number_cells: ['', '7', '0', '5'], start_time_cells: ['1', '3', '0', '0'], end_time_cells: ['1', '4', '0', '0'], remarks_raw: '' },
    { row_index: 4, room_number_cells: ['', '6', '0', '3'], start_time_cells: ['1', '0', '0', '0'], end_time_cells: ['', '', '', ''], remarks_raw: '' },
    { row_index: 5, room_number_cells: ['', '5', '0', '3'], start_time_cells: ['1', '1', '0', '0'], end_time_cells: ['1', '1', '1', '5'], remarks_raw: '' },
    { row_index: 6, room_number_cells: ['1', '1', '0', '1'], start_time_cells: ['', '9', '3', '0'], end_time_cells: ['', '', '', ''], remarks_raw: '' },
  ],
};

const { stampData: lbStamp } = toLiveBoardStampData(normalizeStandardizedStampScan(scan));
assert(Object.keys(lbStamp).length === 65, '変換結果は65室');

// --- 1. MASTER66室へDELTA65室を適用しても1102が残る ---
{
  // applyStandardizedStampDataToLb() と同じ「FLOORSに存在する部屋にだけ載せる」規則を再現する。
  const sandbox = makeSandbox({});
  const known: Record<string, boolean> = {};
  (sandbox.FLOORS as Array<{ rooms: string[] }>).forEach((f) => f.rooms.forEach((r) => { known[r] = true; }));
  const applied: string[] = [];
  Object.keys(lbStamp).forEach((room) => {
    if (!known[room]) return;
    (sandbox.STAMP_DATA as Record<string, unknown>)[room] = lbStamp[room];
    applied.push(room);
  });

  const allRooms: string[] = [];
  (sandbox.FLOORS as Array<{ rooms: string[] }>).forEach((f) => { f.rooms.forEach((r) => allRooms.push(r)); });
  assert(allRooms.length === 66, 'FLOORSは66室のまま(OCR65室で上書きしない)');
  assert(allRooms.indexOf('1102') !== -1, '1102が部屋一覧に残る');
  assert(applied.length === 65, '65室に反映');
  assert((sandbox.STAMP_DATA as Record<string, unknown>)['1102'] === undefined, '1102はstamp情報なしの未指定状態');

  (sandbox as { initScheduleLabels: () => void }).initScheduleLabels();
  const labels = sandbox.scheduleLabels as Record<string, { text: string; timeDisplay: string | null } | null>;

  // --- 期待表示 ---
  assert(labels['1003'] && labels['1003']!.text === 'P', '1003=P');
  assert(labels['405'] && labels['405']!.text === 'P', '405=P');
  assert(labels['1305'] && labels['1305']!.timeDisplay === '14:00', '1305=14:00');
  assert(labels['1001'] && labels['1001']!.timeDisplay === '10:00〜11:30', '1001=10:00〜11:30');
  assert(labels['705'] && labels['705']!.timeDisplay === '13:00〜14:00', '705=13:00〜14:00');
  assert(labels['603'] && labels['603']!.timeDisplay === '10:00', '603=10:00');
  assert(labels['503'] && labels['503']!.timeDisplay === '11:00〜11:15', '503=11:00〜11:15');
  assert(labels['1102'] === null || labels['1102'] === undefined, '1102はラベルなし');

  // --- 2. 複数チェックの部屋はA/P/キャンセルとして確定表示しない ---
  for (const room of ['802', '1005', '805']) {
    assert(labels[room] === null, room + ': A/P/時刻ラベルを出さない');
  }

  // --- 3. 要確認バッジが出る ---
  const badgeOf = (room: string) => (sandbox as { stampReviewBadgeHtmlFor: (r: string) => string }).stampReviewBadgeHtmlFor(room);
  for (const room of ['802', '1005', '805']) {
    assert(badgeOf(room).indexOf('要確認') !== -1, room + ': 要確認バッジ');
    assert(badgeOf(room).indexOf('review-badge') !== -1, room + ': 既存バッジのクラスを使う');
  }
  assert(badgeOf('1101').indexOf('要確認') !== -1, '1101(時刻の空マス)も要確認');
  assert(labels['1101'] && labels['1101']!.text === 'A', '1101は記号Aは確定表示してよい');
  assert(labels['1101']!.timeDisplay === null || labels['1101']!.timeDisplay === '', '1101の未確定時刻は表示しない');
  assert(badgeOf('1003') === '', '1003は要確認バッジを出さない');
  assert(badgeOf('1102') === '', 'stamp情報が無い部屋はバッジを出さない');

  // --- 古いデモ値が消えていること ---
  const OLD_DEMO: Record<string, string> = {
    '705': '10:30', '603': '16:00', '602': '11:30', '505': '9:00',
    '403': '16:00', '402': '16:30', '401': '17:30', '302': '11:00', '103': '14:30',
  };
  Object.keys(OLD_DEMO).forEach((room) => {
    const l = labels[room];
    const shown = l ? (l.text + '|' + (l.timeDisplay || '')) : '';
    assert(shown.indexOf(OLD_DEMO[room]) === -1, room + ': 古いデモ値' + OLD_DEMO[room] + 'が表示されない');
  });
}

// --- 4. 実物件読込時にデモSTAMP_DATAが残らない ---
{
  const demoStamp = { '705': { symbol: '', time: '10:30' }, '603': { symbol: '', time: '16:00' } };
  const sandbox = makeSandbox(demoStamp);
  assert(Object.keys(sandbox.STAMP_DATA as object).length === 2, '前提: デモ値が入っている');
  (sandbox as { clearDemoStampDataForPropertyChange: () => void }).clearDemoStampDataForPropertyChange();
  assert(Object.keys(sandbox.STAMP_DATA as object).length === 0, 'デモSTAMP_DATAが空になる');

  (sandbox as { initScheduleLabels: () => void }).initScheduleLabels();
  const labels = sandbox.scheduleLabels as Record<string, unknown>;
  assert(labels['705'] === null && labels['603'] === null, 'クリア後はラベルも消える');
}

// --- 実物件読込の2経路が、必ずクリア関数を呼んでいること(ソース上の結線確認) ---
{
  const excelReset = html.indexOf('---- ② 点検中データをリセット（新しい物件のため） ----');
  assert(excelReset !== -1, 'parseExcelAndRebuildのリセット箇所が見つかる');
  const excelBlock = html.slice(excelReset, excelReset + 1200);
  assert(excelBlock.indexOf('clearDemoStampDataForPropertyChange()') !== -1, '実物件Excel読込時にクリアを呼ぶ');

  const restoreIdx = html.indexOf('function applyCurrentPropertyRecord(record)');
  assert(restoreIdx !== -1, 'applyCurrentPropertyRecordが見つかる');
  const restoreBlock = html.slice(restoreIdx, restoreIdx + 1200);
  assert(restoreBlock.indexOf('clearDemoStampDataForPropertyChange()') !== -1, '前回物件の復元時にクリアを呼ぶ');

  // 反映関数がFLOORSを書き換えていないこと(MASTERをDELTAで上書きしない)。
  const applyIdx = html.indexOf('function applyStandardizedStampDataToLb(stampData)');
  assert(applyIdx !== -1, 'applyStandardizedStampDataToLbが存在する');
  let depth = 0, end = applyIdx;
  for (let i = html.indexOf('{', applyIdx); i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  const applyBody = html.slice(applyIdx, end);
  assert(!/FLOORS\s*=/.test(applyBody), 'FLOORSへ代入していない(部屋一覧MASTERを上書きしない)');
  assert(applyBody.indexOf('unmatchedRooms.push(room)') !== -1, 'FLOORSに無い部屋は追加せずunmatchedにする');
}

console.log('standardizedStampLbBridge.test.ts: ALL PASS');
