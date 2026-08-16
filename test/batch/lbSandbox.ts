// test/batch/lbSandbox.ts
//
// [2026-08-15新設 Phase 3 複数物件一括OCR検証基盤]
// Live Board(public/index.html)の実関数と、正本ストア(public/stamp_store/stamp_store.js)の
// 実ソースを、そのまま vm 上で1タブぶん動かすための最小ハーネス。
//
// 【なぜ新規に作らず「既存のやり方」を持ってきたか】
// この関数抽出→vm実行という手法は、既に public/test/index_html_phase1_fix_test.js・
// test/unit/lb/standardizedStampLbBridge.test.ts・test/unit/lb/stampStorageAdapterRoundTrip.test.ts
// で使われている実績のある方法である。Phase 3では「複数物件を同じ手順で回す」ことだけが
// 新しいので、判定ロジックや保存形式は一切足さず、この既存手法を関数として切り出すに留める。
//
// 【この層がしないこと】
// - OCR・正規化・辞書判定(すべて lib/ocr/standardizedStampSheet 側で確定済み)
// - 期待値との比較(runBatchValidation.ts 側の責務)
// - 新しい保存経路・新しいCanonical・物件別ルールの追加

import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

const ROOT = path.join(__dirname, '..', '..');
const HTML = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const STORE_SOURCE = fs.readFileSync(path.join(ROOT, 'public', 'stamp_store', 'stamp_store.js'), 'utf8');

/* index.html から関数のソースをそのまま取り出す(既存テストと同じ手法)。 */
function extractFunctionSource(functionName: string): string {
  const marker = 'function ' + functionName + '(';
  let startIdx = HTML.indexOf(marker);
  if (startIdx === -1) throw new Error('function not found in index.html: ' + functionName);
  // async関数は 'async ' も含めて取り出す(内部のawaitが構文エラーにならないように)。
  if (HTML.slice(startIdx - 6, startIdx) === 'async ') startIdx -= 6;
  let i = HTML.indexOf('{', startIdx);
  let depth = 0;
  for (; i < HTML.length; i++) {
    if (HTML[i] === '{') depth++;
    else if (HTML[i] === '}') { depth--; if (depth === 0) return HTML.slice(startIdx, i + 1); }
  }
  throw new Error('unbalanced braces: ' + functionName);
}

// 予定情報の反映・保存・復元・描画に関わる実関数一式(standardizedStampLbBridge.test.ts と同じ集合)。
const LB_FUNCS = [
  'applyStandardizedStampDataToLb', 'applyStampRecordsToLb', 'syncStampDataFromStore',
  'currentPropertyScopeKey', 'knownRoomNumbersFromFloors', 'reloadStampStoreForCurrentProperty',
  'restoreStampDataFromStorage', 'clearDemoStampDataForPropertyChange',
  'initScheduleLabels', 'formatStampTimeDisplay',
  'scheduleDayColorForIndex', 'stampReviewBadgeHtmlFor', 'escapeHtml', 'effectiveScheduleLabel',
  'statusOf', 'iconFor', 'statusLabel', 'detailFor', 'roomMatchesFilter', 'renderFloors',
];

function floorLabelOf(room: string): string {
  return (room.length === 4 ? room.slice(0, 2) : room.slice(0, 1)) + 'F';
}

export function buildFloors(rooms: string[]): Array<{ label: string; rooms: string[] }> {
  const byFloor: Record<string, string[]> = {};
  rooms.forEach((r) => { const f = floorLabelOf(r); (byFloor[f] = byFloor[f] || []).push(r); });
  return Object.keys(byFloor).map((label) => ({ label, rooms: byFloor[label] }));
}

export type LbPage = {
  sandbox: Record<string, unknown>;
  /* 直近の renderFloors() が書き出した部屋一覧のHTML。 */
  floorsHtml: () => string;
  applyStandardizedStampDataToLb: (stampData: unknown) => { appliedRooms: string[]; unmatchedRooms: string[]; needsReviewRooms: string[] };
  restoreStampDataFromStorage: () => Promise<{ restored: string[]; skipped: string[] }>;
  clearDemoStampDataForPropertyChange: () => void;
  stampData: () => Record<string, Record<string, unknown>>;
};

/* ブラウザ1タブぶんのLive Boardを作る。
   persisted を引き継いだ新しいページを作れば「ページ再読込」を再現できる
   (メモリ上の変数は全て作り直され、保存先の中身だけが残る)。 */
export function makeLbPage(opts: {
  propertyName: string;
  masterRooms: string[];
  persisted: Record<string, string>;
}): LbPage {
  let floorsHtml = '';
  const persisted = opts.persisted;

  const sandbox: Record<string, unknown> = {
    console, setTimeout, Promise, Object, Array, JSON, String, Number, Boolean, Date,
    window: { storage: {} },
    PROPERTY: { name: opts.propertyName },
    FLOORS: buildFloors(opts.masterRooms),
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
  // 正本ストア本体(公開ソースそのまま)を同じコンテキストで読み込む。
  vm.runInContext(STORE_SOURCE, sandbox);
  (sandbox as { __persisted: Record<string, string> }).__persisted = persisted;
  // index.html と同じ形の保存アダプタ(ローカル相当。ページを跨いで内容が残る)。
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
  vm.runInContext(LB_FUNCS.map(extractFunctionSource).join('\n\n'), sandbox);

  const api = sandbox as unknown as {
    applyStandardizedStampDataToLb: (d: unknown) => { appliedRooms: string[]; unmatchedRooms: string[]; needsReviewRooms: string[] };
    restoreStampDataFromStorage: () => Promise<{ restored: string[]; skipped: string[] }>;
    clearDemoStampDataForPropertyChange: () => void;
    STAMP_DATA: Record<string, Record<string, unknown>>;
  };

  return {
    sandbox,
    floorsHtml: () => floorsHtml,
    applyStandardizedStampDataToLb: (d) => api.applyStandardizedStampDataToLb(d),
    restoreStampDataFromStorage: () => api.restoreStampDataFromStorage(),
    clearDemoStampDataForPropertyChange: () => api.clearDemoStampDataForPropertyChange(),
    stampData: () => api.STAMP_DATA,
  };
}

// ---------------------------------------------------------------------------
// 描画結果(部屋カードHTML)から、利用者が実際に見ている値を取り出す。
// 【重要】ここでOCR情報を再解釈しない。HTMLに出ている文字をそのまま読むだけ。
// ---------------------------------------------------------------------------

export type RenderedRoom = {
  exists: boolean;
  // 部屋カードに確定表示されている記号('A'/'P'。出ていなければ空文字)。
  symbol: string;
  // 部屋カードに出ている時刻表示('09:30' / '10:00〜11:30' など。無ければ空文字)。
  timeDisplay: string;
  // 部屋カードに出ている備考(確定した業務語 or 読み取り原文)。
  note: string;
  // 要確認バッジが出ているか。
  reviewBadge: boolean;
};

function cardHtmlOf(floorsHtml: string, room: string): string | null {
  const idx = floorsHtml.indexOf('data-room="' + room + '"');
  if (idx === -1) return null;
  const next = floorsHtml.indexOf('data-room="', idx + 10);
  return floorsHtml.slice(idx, next === -1 ? floorsHtml.length : next);
}

function unescapeHtml(text: string): string {
  return text
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

export function readRenderedRoom(floorsHtml: string, room: string): RenderedRoom {
  const card = cardHtmlOf(floorsHtml, room);
  if (card === null) return { exists: false, symbol: '', timeDisplay: '', note: '', reviewBadge: false };

  // <span class="sched-label..." style="color:...">A</span> の中身。
  const labelMatch = card.match(/<span class="sched-label[^"]*"[^>]*>([\s\S]*?)<\/span>/);
  const labelText = labelMatch ? unescapeHtml(labelMatch[1]).trim() : '';
  // <span class="sched-label-time">09:30</span> の中身。
  const timeMatch = card.match(/<span class="sched-label-time">([\s\S]*?)<\/span>/);
  const timeText = timeMatch ? unescapeHtml(timeMatch[1]).trim() : '';
  const noteMatch = card.match(/<span class="room-note-text"[^>]*>([\s\S]*?)<\/span>/);

  // 記号が確定していない部屋では、時刻表示そのものが .sched-label に入る(index.htmlの既存仕様)。
  // そのため「.sched-label が時刻の形をしているか」だけで記号欄か時刻欄かを判定する。
  // [2026-08-16修正] 従来はここを 'A' / 'P' の2値に固定していたため、Ground Truthの記号が
  // それ以外(キャンセル等)の部屋は、部屋カードに正しく出ていても常に symbol='' と読まれ、
  // 「描画できているのに RENDER_FAIL」という偽の失敗になる状態だった。読み取り側は
  // 記号の種類を知らずに「カードに出ている文字をそのまま読む」だけにする(再解釈しない)。
  // 現時点の出力は変わらない(index.html は A/P と時刻しか .sched-label に入れないため)。
  const isTimeLike = /^〜?\d{1,2}:\d{2}/.test(labelText);
  return {
    exists: true,
    symbol: (labelText && !isTimeLike) ? labelText : '',
    timeDisplay: timeText || (isTimeLike ? labelText : ''),
    note: noteMatch ? unescapeHtml(noteMatch[1]).trim() : '',
    reviewBadge: card.indexOf('stamp-review-badge') !== -1,
  };
}

/* index.html の formatStampTimeDisplay と同じ規則で、期待される時刻表示を組み立てる。
   (「〜」の向きを捏造せず、読み取れた形式のとおりに表示するという既存仕様に合わせる) */
export function expectedTimeDisplay(timeStart: string, timeEnd: string): string {
  if (timeStart && timeEnd) return timeStart + '〜' + timeEnd;
  if (timeStart) return timeStart;
  if (timeEnd) return '〜' + timeEnd;
  return '';
}
