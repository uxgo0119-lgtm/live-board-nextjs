// [2026-08-13新設 新捺印表 実アップロード導線接続]
// 「実装はあるのにUIから繋がっていない」という今回の不具合の再発防止テスト。
// 実際のアップロード操作が通る経路そのもの(UIのボタン → fetch → 反映関数 → STAMP_DATA →
// 再描画)を、public/index.html から抽出した本物の関数で再現して検証する。

import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

function assert(cond: unknown, msg: string) { if (!cond) throw new Error('FAIL: ' + msg); }

const ROOT = path.join(__dirname, '..', '..', '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

const ENDPOINT = '/api/v1/standardized-stamp-sheet/scan';

// --- 1. サーバー側: ルートとハンドラが存在し、OCR→正規化→LB変換を通していること ---
{
  const routePath = path.join(ROOT, 'app', 'api', 'v1', 'standardized-stamp-sheet', 'scan', 'route.ts');
  assert(fs.existsSync(routePath), 'APIルートが存在する');
  const route = fs.readFileSync(routePath, 'utf8');
  assert(route.includes('handleStandardizedStampScanRequest'), 'ルートがハンドラを呼ぶ');
  assert(/export async function POST/.test(route), 'POSTを受ける');

  const handler = fs.readFileSync(path.join(ROOT, 'lib', 'handlers', 'scanStandardizedStampSheet.ts'), 'utf8');
  for (const fn of ['requireSession', 'enforceRateLimit', 'validateOcrPayload', 'scanStandardizedStampSheet', 'normalizeStandardizedStampScan', 'toLiveBoardStampData']) {
    assert(handler.includes(fn), 'ハンドラが ' + fn + ' を通す');
  }
  // 順序(OCR → 正規化 → LB変換)が入れ替わっていないこと。
  const iScan = handler.indexOf('await scanStandardizedStampSheet(');
  const iNorm = handler.indexOf('normalizeStandardizedStampScan(scan)');
  const iLb = handler.indexOf('toLiveBoardStampData(normalized)');
  assert(iScan > 0 && iNorm > iScan && iLb > iNorm, 'OCR→正規化→LB変換の順で通す');
}

// --- 2. ブラウザ側: 読み込み入口が1つで、そこから新ルートへ繋がっていること ---
{
  assert(html.includes('id="uploadChoiceUnified"'), '一本化した読み込み入口がある');
  assert(html.includes('<span class="upload-choice-card-title">資料を読み込む</span>'), '文言は「資料を読み込む」');
  assert(html.includes('id="unifiedUploadInput"'), '一本化したファイル選択inputがある');
  assert(html.includes(ENDPOINT), 'fetch先が新ルートである');
  assert(html.includes('applyStandardizedStampDataToLb(result.stampData)'), '取得結果を反映関数へ渡す');

  // 画像1枚は必ず新OCR経路へ入る(Legacyへ流さない)ことを、振り分け実装の存在で確認する。
  assert(html.includes('function routeUnifiedUpload(files)'), '振り分け関数がある');
  assert(html.includes('function isStandardizedStampImageFile(file)'), '画像判定がある');

  // 利用者に見える読み込みボタンが1つだけであること(旧入口は非表示にしてある)。
  for (const id of ['uploadChoiceBatch', 'uploadChoiceReport', 'uploadChoiceStamp']) {
    const idx = html.indexOf('id="' + id + '"');
    assert(idx !== -1, id + ' はDOMに残す(既存処理を壊さないため)');
    assert(html.slice(idx, idx + 120).includes('style="display:none;"'), id + ' は非表示になっている');
  }
  const idleIdx = html.indexOf('<div id="stampScanIdle"');
  assert(html.slice(idleIdx, idleIdx + 80).includes('style="display:none;"'), '「PDFで一括スキャン/1枚ずつ撮影」の選択画面は非表示');
  assert(!html.includes('新捺印表（全戸まとめて1枚）を読み取る'), '「新捺印表を読み取る」ボタンは表示しない');
  assert(!html.includes('id="standardizedStampScanBtn"'), '新捺印表専用ボタンは撤去済み');

  // 既存Legacy経路の処理自体は残っていること(壊していない)。
  assert(html.includes("fetch('/api/scan-time-request'"), '既存Legacy経路の処理はそのまま残っている');
  assert(html.includes('id="stampScanPdfBtn"') && html.includes('id="stampScanCaptureBtn"'), '既存の2ボタンはDOM上は残す');
}

// --- 2b. JPG / JPEG / PNG を受け付けること ---
{
  const inputIdx = html.indexOf('id="unifiedUploadInput"');
  const inputTag = html.slice(inputIdx - 200, inputIdx + 400);
  for (const token of ['image/jpeg', 'image/png', '.jpg', '.jpeg', '.png']) {
    assert(inputTag.includes(token), 'acceptに ' + token + ' が含まれる');
  }
  // 選択後の処理でもJPG/JPEG/PNGを拒否しないこと。
  for (const mime of ['image/jpeg', 'image/jpg', 'image/pjpeg', 'image/png']) {
    assert(html.includes("'" + mime + "':"), '受理MIMEに ' + mime + ' がある');
  }
  for (const ext of ['jpg: true', 'jpeg: true', 'png: true']) {
    assert(html.includes(ext), '受理拡張子に ' + ext.split(':')[0] + ' がある');
  }
}

// --- 3. 実導線の再現: fetch応答 → STAMP_DATA → 部屋カード表示 ---
function extractFunctionSource(name: string): string {
  const marker = 'function ' + name + '(';
  const idx = html.indexOf(marker);
  if (idx === -1) throw new Error('function not found: ' + name);
  // async 修飾子が付いている場合は一緒に取り出す(awaitを含む関数のため)。
  const asyncPrefix = 'async ';
  const start = html.slice(Math.max(0, idx - asyncPrefix.length), idx) === asyncPrefix ? idx - asyncPrefix.length : idx;
  let depth = 0;
  for (let i = html.indexOf('{', idx); i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') { depth--; if (depth === 0) return html.slice(start, i + 1); }
  }
  throw new Error('unbalanced braces: ' + name);
}

// 受理する拡張子/MIMEの定義は関数の外にあるため、宣言ごと取り出して同じ値で検証する。
function extractVarDeclaration(name: string): string {
  const marker = 'var ' + name + ' = ';
  const idx = html.indexOf(marker);
  if (idx === -1) throw new Error('var not found: ' + name);
  let depth = 0;
  for (let i = html.indexOf('{', idx); i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') { depth--; if (depth === 0) return html.slice(idx, i + 1) + ';'; }
  }
  throw new Error('unbalanced braces: ' + name);
}

const MASTER: string[] = Object.keys(
  JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'test', 'fixtures', 'prop13', 'gt_totals.json'), 'utf8'))
);
assert(MASTER.length === 66 && MASTER.indexOf('1102') !== -1, 'MASTERは1102を含む66室');

function buildFloors(rooms: string[]) {
  const byFloor: Record<string, string[]> = {};
  rooms.forEach((r) => { const f = (r.length === 4 ? r.slice(0, 2) : r.slice(0, 1)) + 'F'; (byFloor[f] = byFloor[f] || []).push(r); });
  return Object.keys(byFloor).map((label) => ({ label, rooms: byFloor[label] }));
}

// 冒頭のデモ用STAMP_DATA(実物と同じもの)を初期状態として使い、「古い値が残らないこと」を確かめる。
const demoMatch = html.match(/var STAMP_DATA = (\{.*?\});/s);
assert(!!demoMatch, 'デモSTAMP_DATAのリテラルが見つかる');
const DEMO_STAMP = JSON.parse(demoMatch![1]);
assert(DEMO_STAMP['705'] && DEMO_STAMP['705'].time === '10:30', '前提: デモ値705=10:30が存在する');

// サーバーが返す想定のstampData(= toLiveBoardStampData の出力形)。
const serverStampData: Record<string, unknown> = {};
MASTER.filter((r) => r !== '1102').forEach((room) => {
  serverStampData[room] = {
    room_number: room, symbol: 'A', a_checked: true, p_checked: false, cancel_checked: false,
    time_start: '', time_end: '', time: '', note: '', note_raw: '', needs_review: false, review_reason: [],
  };
});
(serverStampData['1003'] as any).symbol = 'P';
(serverStampData['802'] as any) = { room_number: '802', symbol: '', a_checked: true, p_checked: true, cancel_checked: false, time_start: '', time_end: '', time: '', note: '', note_raw: '', needs_review: true, review_reason: ['SYMBOL:MULTIPLE_SYMBOL_CHECKED'] };
(serverStampData['705'] as any).time_start = '13:00';
(serverStampData['705'] as any).time_end = '14:00';
(serverStampData['705'] as any).symbol = 'P';

const storageCalls: string[] = [];
const toasts: string[] = [];
const docBatchCalls: string[] = [];
const fetchedUrls: string[] = [];
function makeElementStub() { return { style: { display: '' }, textContent: '', innerHTML: '', value: '', click() {}, addEventListener() {} }; }
const closeStampScanCalls: string[] = [];

// [2026-08-15追加 Phase 2 実LB最終確認②] 部屋を特定できなかった時間指定行の「読めていた内容」。
// 実LBで801号室が「Aのみ」になった形(部屋番号マスだけが読めず、開始9:30と備考「朝一」は読めていた)を
// サーバー応答としてそのまま与える。
const UNASSIGNED_ROWS = [
  { row_index: 1, room_number_raw: '410?', time_start: '', time_end: '', time_start_raw: '', time_end_raw: '', note_raw: '', reasons: ['ROOM_NUMBER_AMBIGUOUS'] },
  { row_index: 5, room_number_raw: '_80?', time_start: '09:30', time_end: '', time_start_raw: '', time_end_raw: '', note_raw: '朝一', reasons: ['ROOM_NUMBER_AMBIGUOUS'] },
];
const elements: Record<string, ReturnType<typeof makeElementStub>> = {};

const sandbox: Record<string, unknown> = {
  console,
  setTimeout,
  Promise,
  // [2026-08-15追加 Phase 1] 予定情報の正本(StampStore)は物件スコープを持つ。
  window: { storage: {} },
  PROPERTY: { name: 'コスモ城東野江ロイヤルフォルム' },
  FLOORS: buildFloors(MASTER),
  STAMP_DATA: JSON.parse(JSON.stringify(DEMO_STAMP)),
  SENSOR_MASTER: {},
  EVACUATION_EQUIPMENT_ROOMS: [],
  scheduleLabels: {},
  haBadges: {},
  sensorCounts: {},
  scheduleDayColors: {},
  stampScannedRooms: {},
  STAMP_SCAN_KEY_PREFIX: 'fireflow-stamp:',
  document: { getElementById: (id: string) => (elements[id] = elements[id] || makeElementStub()) },
  showToast: (m: string) => toasts.push(m),
  showBackdrop: () => {},
  hideBackdrop: () => {},
  resetStampScanToIdle: () => {},
  closeStampScan: () => { closeStampScanCalls.push('close'); },
  renderFilterChips: () => {},
  renderFloors: () => {},
  storageSet: (key: string) => { storageCalls.push(key); return Promise.resolve(); },
  scanRequestHeaders: async () => ({ 'Content-Type': 'application/json' }),
  // 資料取込(既存経路)側は呼ばれたことだけ記録する。
  openDocBatchUploadDialog: () => docBatchCalls.push('open'),
  addFilesToDocBatch: (files: Array<{ name: string }>) => docBatchCalls.push('add:' + files.map((f) => f.name).join(',')),
  extOfFileName: (name: string) => String(name).split('.').pop()!.toLowerCase(),
  FileReader: class {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    result = '';
    readAsDataURL(file: { type: string }) {
      this.result = 'data:' + (file.type || 'image/jpeg') + ';base64,BASE64DATA';
      if (this.onload) this.onload();
    }
  },
  // 実際の通信の代わりに、サーバーが返す形の応答をそのまま返す。
  fetch: async (url: string, init: { body: string }) => {
    fetchedUrls.push(url);
    assert(url === ENDPOINT, 'fetch先が新ルート: ' + url);
    const body = JSON.parse(init.body);
    assert(body.mode === 'single' && body.data === 'BASE64DATA', 'リクエスト本文が正しい');
    assert(body.mediaType === 'image/jpeg' || body.mediaType === 'image/png', 'mediaTypeが画像: ' + body.mediaType);
    return { ok: true, status: 200, json: async () => ({ result: { stampData: serverStampData, needsReviewRooms: ['802'], skippedRooms: [], roomCount: 65, unassignedTimeDesignationRowCount: 2, unassignedTimeDesignations: UNASSIGNED_ROWS } }) };
  },
};
vm.createContext(sandbox);
vm.runInContext(
  ['STANDARDIZED_STAMP_IMAGE_EXTS', 'STANDARDIZED_STAMP_IMAGE_MIMES', 'STANDARDIZED_STAMP_ACCEPTED_MEDIA_TYPES']
    .map(extractVarDeclaration).join('\n'),
  sandbox
);
// [2026-08-15追加 Phase 1] 予定情報の唯一の正本(StampStore)を、ブラウザと同じソースで読み込む。
vm.runInContext(fs.readFileSync(path.join(ROOT, 'public', 'stamp_store', 'stamp_store.js'), 'utf8'), sandbox);
(sandbox as { __persisted: Record<string, string> }).__persisted = {};
vm.runInContext(`
  var stampStore = window.FireFlowStampStore.createStampStore({
    adapters: {
      list: function (prefix) { return Promise.resolve(Object.keys(__persisted).filter(function (k) { return k.indexOf(prefix) === 0; })); },
      get: function (key) { return Promise.resolve(__persisted[key] === undefined ? null : __persisted[key]); },
      set: function (key, value) { __persisted[key] = value; return Promise.resolve(); },
      remove: function (key) { delete __persisted[key]; return Promise.resolve(); }
    }
  });
`, sandbox);
vm.runInContext(
  ['initScheduleLabels', 'formatStampTimeDisplay', 'scheduleDayColorForIndex', 'stampReviewBadgeHtmlFor',
    'clearDemoStampDataForPropertyChange', 'escapeHtml', 'applyStandardizedStampDataToLb', 'setStampPanelTitle',
    'applyStampRecordsToLb', 'syncStampDataFromStore', 'currentPropertyScopeKey', 'knownRoomNumbersFromFloors',
    'fetchStandardizedStampScanResult', 'runStandardizedStampScan', 'describeUnassignedTimeDesignations',
    'isStandardizedStampImageFile', 'routeUnifiedUpload'].map(extractFunctionSource).join('\n\n'),
  sandbox
);

const route = (sandbox as { routeUnifiedUpload: (f: unknown[]) => void }).routeUnifiedUpload;
const isImg = (sandbox as { isStandardizedStampImageFile: (f: unknown) => boolean }).isStandardizedStampImageFile;

// --- JPG / JPEG / PNG が新OCR経路の対象と判定されること ---
assert(isImg({ name: '新捺印表.jpg', type: 'image/jpeg' }), '.jpg');
assert(isImg({ name: '新捺印表.jpeg', type: 'image/jpeg' }), '.jpeg');
assert(isImg({ name: '新捺印表.JPG', type: '' }), '大文字.JPG(typeが空でも拡張子で判定)');
assert(isImg({ name: '新捺印表.png', type: 'image/png' }), '.png');
assert(isImg({ name: 'scan', type: 'image/jpeg' }), '拡張子が無くてもMIMEで判定');
assert(!isImg({ name: '点検報告書.xlsx', type: '' }), 'Excelは対象外');
assert(!isImg({ name: '捺印表.pdf', type: 'application/pdf' }), 'PDFは対象外(既存経路へ)');

// --- Excel/PDF/複数ファイルは既存の資料取込へ回り、新OCRを呼ばないこと ---
route([{ name: '点検報告書.xlsx', type: '' }]);
assert(docBatchCalls.length === 2 && docBatchCalls[0] === 'open', 'Excelは資料取込へ: ' + JSON.stringify(docBatchCalls));
assert(fetchedUrls.length === 0, 'Excelで新OCRを呼ばない');
docBatchCalls.length = 0;
route([{ name: 'a.jpg', type: 'image/jpeg' }, { name: 'b.jpg', type: 'image/jpeg' }]);
assert(docBatchCalls.length === 2, '複数枚は資料取込へ');
assert(fetchedUrls.length === 0, '複数枚で新OCRを呼ばない');
docBatchCalls.length = 0;

(async () => {
  // --- 実導線: 「資料を読み込む」でJPGを1枚選ぶ → 新OCR経路 ---
  route([{ name: '新捺印表.jpg', type: 'image/jpeg' }]);
  await new Promise((r) => setTimeout(r, 50));
  assert(fetchedUrls.length === 1 && fetchedUrls[0] === ENDPOINT, 'JPG1枚は新ルートへ流れる');
  assert(docBatchCalls.length === 0, 'JPG1枚はLegacy/資料取込へ流れない');

  const stamp = sandbox.STAMP_DATA as Record<string, any>;
  const labels = sandbox.scheduleLabels as Record<string, any>;

  assert(Object.keys(stamp).length === 65, 'STAMP_DATAが今回のOCR結果65室で置換される (got ' + Object.keys(stamp).length + ')');
  assert(stamp['817'] === undefined && stamp['117'] === undefined, 'デモ専用の部屋(817/117)が残っていない');
  assert(stamp['1102'] === undefined, '1102は捺印情報なし');

  let total = 0;
  (sandbox.FLOORS as Array<{ rooms: string[] }>).forEach((f) => { total += f.rooms.length; });
  assert(total === 66, 'FLOORSは66室のまま');
  assert((sandbox.FLOORS as Array<{ rooms: string[] }>).some((f) => f.rooms.indexOf('1102') !== -1), '1102が部屋一覧に残る');

  // 古いデモ値が1件も残っていないこと。
  const OLD: Record<string, string> = { '705': '10:30', '603': '16:00', '602': '11:30', '505': '9:00', '403': '16:00', '402': '16:30', '401': '17:30', '302': '11:00', '103': '14:30' };
  Object.keys(OLD).forEach((room) => {
    assert(stamp[room].time !== OLD[room], room + ': 古いデモ値' + OLD[room] + 'が残っていない');
    const l = labels[room];
    const shown = l ? (l.text + '|' + (l.timeDisplay || '')) : '';
    assert(shown.indexOf(OLD[room]) === -1, room + ': 表示にも古い値が出ない');
  });

  assert(labels['1003'] && labels['1003'].text === 'P', '1003=P');
  assert(labels['705'] && labels['705'].timeDisplay === '13:00〜14:00', '705=13:00〜14:00');
  assert(labels['802'] === null, '802はA/Pとして確定表示しない');
  const badge = (sandbox as { stampReviewBadgeHtmlFor: (r: string) => string }).stampReviewBadgeHtmlFor('802');
  assert(badge.indexOf('要確認') !== -1, '802に要確認バッジ');
  // [2026-08-15更新 Phase 1] 保存は正本(StampStore)経由。物件スコープ付きキーで65室分入る。
  const persistedKeys = Object.keys((sandbox as { __persisted: Record<string, string> }).__persisted);
  assert(persistedKeys.length === 65, '65室分が保存される (got ' + persistedKeys.length + ')');
  assert(persistedKeys.every((k) => k.indexOf('stamp:') === 0), '保存キーは物件スコープを含む');
  assert(persistedKeys.filter((k) => k.endsWith(':1102')).length === 0, '捺印表に印字が無い1102は保存されない');
  assert(toasts.length === 1 && toasts[0].indexOf('65部屋分') !== -1, '完了トーストに件数が出る: ' + toasts[0]);
  // 部屋を特定できなかった時間指定行を黙って捨てない(推測で部屋へ割り当てもしない)。
  assert(toasts[0].indexOf('部屋を特定できない時間指定 2件') !== -1, '未割当の時間指定件数を必ず知らせる: ' + toasts[0]);

  // --- [2026-08-15追加 Phase 2 実LB最終確認②] 未割当行で「読めていた内容」を捨てないこと ---
  // 実LBで801号室が「Aのみ」になった経路。部屋番号マスが読めなかったせいで、同じ行で確実に
  // 読めていた開始9:30と備考「朝一」が件数だけに潰され、画面からも保存からも完全に消えていた。
  {
    const notice = elements['standardizedStampScanError'];
    assert(notice && notice.style.display === 'block', '未割当行があるときは注意書きを表示する');
    const shown = String((notice as unknown as { innerHTML: string }).innerHTML);
    assert(shown.indexOf('09:30') !== -1, '読めていた開始時刻をそのまま出す: ' + shown);
    assert(shown.indexOf('朝一') !== -1, '読めていた備考の原文をそのまま出す: ' + shown);
    assert(shown.indexOf('_80?') !== -1, '部屋番号マスの見え方を出す(原本のどの行かを特定できる): ' + shown);
    assert(shown.indexOf('410?') !== -1, '記入の無い未割当行も件数と一致して並ぶ: ' + shown);
    // 3.2秒で消えるトーストだけにしない(閉じた瞬間に手掛かりが失われるため)。
    assert(closeStampScanCalls.length === 0, '未割当行があるときはパネルを自動で閉じない');
    // どの部屋にも書き込まない(推測で割り当てない)ことは従来どおり。
    assert(stamp['801'] === undefined || !stamp['801'].time, '未割当行の時刻をどの部屋にも書き込まない');
  }

  console.log('standardizedStampUploadRoute.test.ts: ALL PASS');
})().catch((e) => { console.error(e.message || e); process.exit(1); });
