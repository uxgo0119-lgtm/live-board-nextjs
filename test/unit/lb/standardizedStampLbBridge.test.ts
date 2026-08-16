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
  let startIdx = html.indexOf(marker);
  if (startIdx === -1) throw new Error('function not found: ' + functionName);
  // async関数は 'async ' も含めて取り出す(内部のawaitが構文エラーにならないように)。
  if (html.slice(startIdx - 6, startIdx) === 'async ') startIdx -= 6;
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
  // [2026-08-15追加 Phase 2] STAMP_DATAは正本(StampStore)からの派生ビューになったため、
  // クリア処理もビューの作り直し(syncStampDataFromStore)を通る。
  'syncStampDataFromStore',
  'clearDemoStampDataForPropertyChange',
  'escapeHtml',
];

// public/stamp_store/stamp_store.js を、ブラウザと同じソースのまま使う。
const STORE_SOURCE = fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'public', 'stamp_store', 'stamp_store.js'), 'utf8');

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
  const floors = buildFloors(masterRoomNumbers);
  const knownRooms: string[] = [];
  floors.forEach((f) => f.rooms.forEach((r) => knownRooms.push(r)));

  // 正本(StampStore)を実物のソースのまま用意する。予定情報はここにだけ入れ、STAMP_DATAは
  // そこからの派生ビューとして作る(ブラウザ側と同じ関係にする)。
  const storeBox: Record<string, unknown> = { module: { exports: {} }, console };
  vm.createContext(storeBox);
  vm.runInContext(STORE_SOURCE, storeBox);
  const StampStoreApi = (storeBox.module as { exports: any }).exports;
  const memory: Record<string, string> = {};
  const stampStore = StampStoreApi.createStampStore({
    propertyKey: 'test-property',
    adapters: {
      list: async (prefix: string) => Object.keys(memory).filter((k) => k.startsWith(prefix)),
      get: async (key: string) => (memory[key] !== undefined ? memory[key] : null),
      set: async (key: string, value: string) => { memory[key] = value; },
      remove: async (key: string) => { delete memory[key]; },
    },
  });
  const seedRooms = Object.keys(stampData);
  if (seedRooms.length) {
    // putMany はメモリ上の正本を同期的に更新してから保存を待つ(保存の完了は表示に不要)。
    stampStore.putMany(
      seedRooms.map((room) => StampStoreApi.fromLegacyEntry(room, stampData[room], { source: 'demo' })),
      { knownRooms: knownRooms, source: 'demo' }
    );
  }

  const sandbox: Record<string, unknown> = {
    console,
    FLOORS: floors,
    STAMP_DATA: {},
    stampScannedRooms: {},
    stampStore,
    SENSOR_MASTER: {},
    EVACUATION_EQUIPMENT_ROOMS: [],
    scheduleLabels: {},
    haBadges: {},
    sensorCounts: {},
    scheduleDayColors: {},
  };
  vm.createContext(sandbox);
  vm.runInContext(FUNCS.map(extractFunctionSource).join('\n\n'), sandbox);
  (sandbox as { syncStampDataFromStore: () => void }).syncStampDataFromStore();
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
    // [2026-08-14更新 実データ準拠] 1101号室は実APIが ['9','','3','0'] (紙面は9:30、数字が
    // 入るマスが801号室と逆にブレる)を返した。実際に返ってきた並びのままLBまで通す。
    { row_index: 6, room_number_cells: ['1', '1', '0', '1'], start_time_cells: ['9', '', '3', '0'], end_time_cells: ['', '', '', ''], remarks_raw: '' },
    // [2026-08-14追加] 801号室。「時」の十の位マスが空欄の9:30 + 備考「朝一」(FireFlow辞書で確定する語)。
    { row_index: 7, room_number_cells: ['', '8', '0', '1'], start_time_cells: ['', '9', '3', '0'], end_time_cells: ['', '', '', ''], remarks_raw: '朝一' },
  ],
};

const { stampData: lbStamp } = toLiveBoardStampData(normalizeStandardizedStampScan(scan));
assert(Object.keys(lbStamp).length === 65, '変換結果は65室');

// [2026-08-14追加] 1101・801が、LB変換の時点で記号・時刻・備考をすべて保持していること。
assert(lbStamp['1101'].symbol === 'A' && lbStamp['1101'].time === '09:30', '1101: A / 09:30 が変換結果に入る');
assert(lbStamp['801'].symbol === 'A' && lbStamp['801'].time === '09:30', '801: A / 09:30 が変換結果に入る');
assert(lbStamp['801'].note === '朝一', '801: 備考「朝一」がFireFlow辞書で確定して変換結果に入る');
assert(!lbStamp['801'].needs_review && !lbStamp['1101'].needs_review, '1101/801は要確認にならない');

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
  // [2026-08-14更新 最小修正] 「時」十の位のみ空欄(1101)は09:30として確定するようになった
  // ため、要確認バッジは出ず、時刻もそのままLBへ表示される。
  assert(badgeOf('1101') === '', '1101は09:30で確定するため要確認バッジを出さない');
  assert(labels['1101'] && labels['1101']!.text === 'A', '1101は記号Aは確定表示してよい');
  assert(labels['1101']!.timeDisplay === '09:30', '1101の時刻は09:30として表示される');
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

// --- 5. 実LBと同じ関数で「反映→保存→再読込→復元→再描画」まで通す(Level 3+4) ---
// [2026-08-15改訂 Phase 1] 予定情報の正本を StampStore へ一本化したため、index.htmlの本物の
// 関数(applyStandardizedStampDataToLb / applyStampRecordsToLb / reloadStampStoreForCurrentProperty /
// renderFloors)をそのまま実行し、ページ再読込に相当する状態リセットを挟んでも
// 1101・801・802・1102・MASTER66室が維持されることを確認する。
// (STORE_SOURCE はファイル冒頭で読み込み済み)

// ブラウザのIndexedDB/リモートに相当する保存先(ページを跨いで残る)。
const persisted: Record<string, string> = {};

function makeLbSandbox(): { sandbox: Record<string, unknown>; getFloorsHtml: () => string } {
  const RENDER_FUNCS = [
    'applyStandardizedStampDataToLb', 'applyStampRecordsToLb', 'syncStampDataFromStore',
    'currentPropertyScopeKey', 'knownRoomNumbersFromFloors', 'reloadStampStoreForCurrentProperty',
    'restoreStampDataFromStorage', 'clearDemoStampDataForPropertyChange',
    'initScheduleLabels', 'formatStampTimeDisplay',
    'scheduleDayColorForIndex', 'stampReviewBadgeHtmlFor', 'escapeHtml', 'effectiveScheduleLabel',
    'statusOf', 'iconFor', 'statusLabel', 'detailFor', 'roomMatchesFilter', 'renderFloors',
  ];
  let floorsHtml = '';
  const sandbox: Record<string, unknown> = {
    console, setTimeout, Promise, Object, Array, JSON, String, Number, Boolean, Date,
    window: { storage: {} },
    PROPERTY: { name: 'コスモ城東野江ロイヤルフォルム' },
    FLOORS: buildFloors(masterRoomNumbers),
    STAMP_DATA: {},
    SENSOR_MASTER: {},
    EVACUATION_EQUIPMENT_ROOMS: [],
    LADDER_ROOMS: [],
    ROOM_SPACE_TYPE_FLAGS: {},
    scheduleLabels: {},
    scheduleOverrides: {},
    haBadges: {},
    sensorCounts: {},
    scheduleDayColors: {},
    state: {},
    stampScannedRooms: {},
    currentHomeMode: 'normal',
    activeFilter: null,
    kantanModeEnabled: false,
    renderFilterChips: () => {},
    updateStats: () => {},
    renderSensorUnconfirmedBadge: () => {},
    roomHasPreviousDefect: () => false,
    sensorDisplayStateOf: () => ({ state: 'confirmed', sa: 0, tei: 0, total: null }),
    document: { getElementById: () => ({ set innerHTML(v: string) { floorsHtml = v; }, style: {} }) },
  };
  vm.createContext(sandbox);
  // StampStore本体(公開ソースそのまま)を同じコンテキストで読み込む。
  vm.runInContext(STORE_SOURCE, sandbox);
  // index.html と同じ形の保存アダプタ(ローカル相当。ページを跨いで内容が残る)。
  (sandbox as { __persisted: Record<string, string> }).__persisted = persisted;
  vm.runInContext(`
    var stampStore = window.FireFlowStampStore.createStampStore({
      adapters: {
        list: function (prefix) {
          return Promise.resolve(Object.keys(__persisted).filter(function (k) { return k.indexOf(prefix) === 0; }));
        },
        get: function (key) { return Promise.resolve(__persisted[key] === undefined ? null : __persisted[key]); },
        set: function (key, value) { __persisted[key] = value; return Promise.resolve(); },
        remove: function (key) { delete __persisted[key]; return Promise.resolve(); }
      }
    });
  `, sandbox);
  vm.runInContext(RENDER_FUNCS.map(extractFunctionSource).join('\n\n'), sandbox);
  return { sandbox, getFloorsHtml: () => floorsHtml };
}

function cardOfHtml(floorsHtml: string, room: string): string {
  const idx = floorsHtml.indexOf('data-room="' + room + '"');
  assert(idx !== -1, room + ': 部屋カードが描画されている');
  const next = floorsHtml.indexOf('data-room="', idx + 10);
  return floorsHtml.slice(idx, next === -1 ? floorsHtml.length : next);
}

function assertExpectedCards(floorsHtml: string, phase: string) {
  const card1101 = cardOfHtml(floorsHtml, '1101');
  assert(card1101.includes('>A</span>'), phase + ': 1101のカードにAが出る');
  assert(card1101.includes('sched-label-time">09:30<'), phase + ': 1101のカードに09:30が出る');
  const card801 = cardOfHtml(floorsHtml, '801');
  assert(card801.includes('>A</span>'), phase + ': 801のカードにAが出る');
  assert(card801.includes('sched-label-time">09:30<'), phase + ': 801のカードに09:30が出る');
  assert(card801.includes('room-note-text">朝一<'), phase + ': 801のカードに備考「朝一」が出る');
  const card802 = cardOfHtml(floorsHtml, '802');
  assert(card802.includes('要確認'), phase + ': 802は要確認バッジが出る');
  assert(!card802.includes('sched-label'), phase + ': 802はA/Pを確定表示しない');
  const card1102 = cardOfHtml(floorsHtml, '1102');
  assert(!card1102.includes('sched-label'), phase + ': 1102は予定情報なし(部屋カードは在る)');
  assert((floorsHtml.match(/class="room-card /g) || []).length === 66, phase + ': MASTERの66室すべてが描画される');
}

async function main() {
  // --- 5-1. 読み取り直後(新捺印表OCR → StampStore → 描画) ---
  const first = makeLbSandbox();
  const applied = (first.sandbox as { applyStandardizedStampDataToLb: (d: unknown) => { appliedRooms: string[]; unmatchedRooms: string[] } })
    .applyStandardizedStampDataToLb(lbStamp);
  assert(applied.appliedRooms.length === 65 && applied.unmatchedRooms.length === 0, '65室が部屋カードへ反映される');
  assertExpectedCards(first.getFloorsHtml(), '読み取り直後');

  // 正本として保存されている(物件スコープ付きキー)。
  const savedKeys = Object.keys(persisted);
  assert(savedKeys.length === 65, '65室が保存される');
  assert(savedKeys.every((k) => k.indexOf('stamp:') === 0), '保存キーは物件スコープを含む新形式');
  const saved801 = JSON.parse(persisted[savedKeys.filter((k) => k.endsWith(':801'))[0]]);
  assert(saved801.note === '朝一' && saved801.note_raw === '朝一', '801は確定noteと読み取り原文の両方が保存される');
  assert(saved801.source === 'standardized_stamp_sheet', 'どの経路で入った値かが保存される');
  assert(persisted[savedKeys.filter((k) => k.endsWith(':1102'))[0]] === undefined, '1102は保存されない(予定情報が無いだけ)');

  // --- 5-2. ページ再読込(メモリを完全に捨て、保存先からの復元だけで描画する) ---
  const second = makeLbSandbox();
  (second.sandbox as { clearDemoStampDataForPropertyChange: () => void }).clearDemoStampDataForPropertyChange();
  const restored = await (second.sandbox as { restoreStampDataFromStorage: () => Promise<{ restored: string[] }> })
    .restoreStampDataFromStorage();
  assert(restored.restored.length === 65, '再読込で65室が復元される');
  assertExpectedCards(second.getFloorsHtml(), '再読込後');

  // --- 5-3. 物件が違えば混入しない(同じ部屋番号でもスコープが別) ---
  const other = makeLbSandbox();
  (other.sandbox as { PROPERTY: { name: string } }).PROPERTY.name = '別物件テスト';
  const otherRestored = await (other.sandbox as { restoreStampDataFromStorage: () => Promise<{ restored: string[] }> })
    .restoreStampDataFromStorage();
  assert(otherRestored.restored.length === 0, '別物件のスコープには前物件の予定情報が復元されない');
  assert(Object.keys((other.sandbox as { STAMP_DATA: Record<string, unknown> }).STAMP_DATA).length === 0, '別物件では予定情報が空');

  // --- 5-4. [2026-08-15追加 Phase 2] 備考だけが読めなかった部屋でも、記号と時刻は届く ---
  // 実LBで実際に起きた事象(801の備考が辞書に無い語で返り、確定していた09:30ごと消えた)を、
  // OCR出力からLive Boardの部屋カードHTMLまで通して固定する。
  {
    const partialScan = {
      rooms: ocrRooms,
      time_designation_rows: [
        { row_index: 1, room_number_cells: ['', '8', '0', '1'], start_time_cells: ['', '9', '3', '0'], end_time_cells: ['', '', '', ''], remarks_raw: '辞書に無い語' },
      ],
    };
    const { stampData: partial } = toLiveBoardStampData(normalizeStandardizedStampScan(partialScan));
    assert(partial['801'].time === '09:30', '変換の時点で時刻は確定している');
    assert(partial['801'].note === '' && partial['801'].note_raw === '辞書に無い語', '備考は確定させず原文を残す');
    assert(partial['801'].time_review === false && partial['801'].note_review === true, '要確認は備考だけ');

    const box = makeLbSandbox();
    (box.sandbox as { applyStandardizedStampDataToLb: (d: unknown) => unknown }).applyStandardizedStampDataToLb(partial);
    const card801 = cardOfHtml(box.getFloorsHtml(), '801');
    assert(card801.includes('>A</span>'), '備考が読めなくても記号Aは部屋カードに出る');
    assert(card801.includes('sched-label-time">09:30<'), '備考が読めなくても時刻09:30は部屋カードに出る');
    // [2026-08-15更新 Phase 2 実LB最終確認] 実LBで801号室の備考「朝一」が画面から完全に
    // 消えた経路。辞書で確定できなかった備考は「確定した業務語」としては扱わない(noteは空の
    // まま)が、読み取った原文は捨てずに部屋カードへ出す。原文まで消すと、利用者からは
    // 「備考が書かれていない部屋」と区別が付かず、原本を確認する手掛かりが無くなるため。
    assert(card801.includes('room-note-text') && card801.includes('>辞書に無い語<'), '確定できなかった備考も、読み取った原文は部屋カードに出る');
    assert(card801.includes('要確認'), '要確認バッジは出る');
    assert(card801.includes('確認が必要な項目：備考'), 'どの項目の確認が必要かが説明に出る');
    assert(card801.includes('原本の確認が必要です'), '原文であって確定値ではないことが説明に出る');

    // 再読込しても、確定できなかった備考の原文が残ること(保存→復元→描画まで通す)。
    const reloaded = makeLbSandbox();
    (reloaded.sandbox as { clearDemoStampDataForPropertyChange: () => void }).clearDemoStampDataForPropertyChange();
    await (reloaded.sandbox as { restoreStampDataFromStorage: () => Promise<unknown> }).restoreStampDataFromStorage();
    const reloaded801 = cardOfHtml(reloaded.getFloorsHtml(), '801');
    assert(reloaded801.includes('>辞書に無い語<'), '再読込後も備考の原文が部屋カードに出る');
    assert(reloaded801.includes('sched-label-time">09:30<'), '再読込後も時刻09:30は出る');
  }
}

// --- 6. 結線の確認(経路が増えても正本を通ることを、ソース上でも固定する) ---
{
  // 予定情報の書き込みは applyStampRecordsToLb / stampStore へ集約されていること。
  const forbidden = html.match(/STAMP_DATA\[room\] = entry/g) || [];
  assert(forbidden.length === 0, 'Legacy経路がSTAMP_DATAへ直接書き込んでいない');
  assert((html.match(/STAMP_DATA = lbResult\.stampData/g) || []).length === 0, 'FSDF確定がSTAMP_DATAを丸ごと差し替えていない');
  assert((html.match(/STAMP_DATA = newStampData/g) || []).length === 0, 'CSV取込がSTAMP_DATAを丸ごと差し替えていない');

  // [2026-08-15追加 Phase 2] STAMP_DATAは正本(StampStore)からの派生ビューなので、
  // 代入する場所は「派生ビューを作り直す関数」と「デモ用の初期値定義」の2つだけにする。
  // ここが増えると、画面に出ている値がどこから来たのか特定できない状態へ逆戻りする。
  {
    const assignments = html.match(/(?:^|[^.\w])STAMP_DATA\s*=(?!=)/gm) || [];
    assert(assignments.length === 2,
      'STAMP_DATAへの代入は「派生ビューの作り直し」と「デモ初期値の定義」の2箇所だけ (got ' + assignments.length + ')');
    const syncIdx = html.indexOf('function syncStampDataFromStore()');
    assert(syncIdx !== -1, '派生ビューを作り直す関数が存在する');
    assert(html.slice(syncIdx, syncIdx + 400).indexOf('STAMP_DATA = stampStore.toStampDataView()') !== -1,
      '派生ビューは正本(StampStore)から作る');
  }

  // Legacy経路がMASTER(FLOORS)へ部屋を追加していないこと。
  const legacyRosterCalls = ['applyStampBulkResult', 'applyStampSingleOcrResult'];
  legacyRosterCalls.forEach((fn) => {
    const idx = html.indexOf('function ' + fn + '(');
    assert(idx !== -1, fn + ' が存在する');
    // コメント行(変更理由の記述)は判定から除き、実際の呼び出しが残っていないことを見る。
    const body = html.slice(idx, idx + 3000)
      .split('\n').filter((line) => line.trim().indexOf('//') !== 0).join('\n');
    assert(body.indexOf('extendRoomRosterFromRoomNumbers(') === -1, fn + ': OCR結果からMASTERへ部屋を追加しない');
  });

  // Excel再読込の後に、その物件の予定情報を復元していること。
  const excelIdx = html.indexOf('---- ② 点検中データをリセット（新しい物件のため） ----');
  assert(excelIdx !== -1, 'Excel再読込のリセット箇所が見つかる');
  const excelBlock = html.slice(excelIdx, excelIdx + 1800);
  assert(excelBlock.indexOf('reloadStampStoreForCurrentProperty()') !== -1, 'Excel再読込後に予定情報を復元する');

  // 復元がリモート一覧だけに依存していないこと(ローカルを必ず含める)。
  const listIdx = html.indexOf('async function listKeysLocalFirst(');
  assert(listIdx !== -1, 'ローカル優先の一覧取得が存在する');
  const listBody = html.slice(listIdx, listIdx + 1400);
  assert(listBody.indexOf("lcGetAll('cache')") !== -1, '保存キーの一覧にローカル(IndexedDB)を必ず含める');

  // 「前回の物件を続ける」経路で、消去より後に復元すること。
  const restoreIdx = html.indexOf('function applyCurrentPropertyRecord(record)');
  const restoreBlock = html.slice(restoreIdx, restoreIdx + 2600);
  const clearAt = restoreBlock.indexOf('clearDemoStampDataForPropertyChange()');
  const restoreAt = restoreBlock.indexOf('restoreStampDataFromStorage()');
  assert(clearAt !== -1 && restoreAt !== -1 && clearAt < restoreAt, '消去より後に復元する(順序が逆だと消える)');
}

main().then(function () {
  console.log('standardizedStampLbBridge.test.ts: ALL PASS');
}).catch(function (err) {
  console.error(err);
  process.exit(1);
});
