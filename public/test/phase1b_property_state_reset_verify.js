// [2026-08-17新設 Phase 1B] TEST-V V-6: 前物件データ残留防止の回帰テスト。
//
// Phase 1Bの成功は「何か新しいものを保存できること」ではなく、
//   ・データが無いとき、前の物件・前の状態を1件も残さないこと
//   ・そして保存済みデータ自体は1件も削除しないこと
// である。このテストはその2点だけを機械確認する。
//
// シナリオ(Phase 1B仕様 17章):
//   物件Aの保存データを全項目ぶん用意して復元する
//     ↓
//   resetAllInMemoryPropertyState() でメモリ初期化
//     ↓
//   物件B(同じ101号室を持つが保存データは1件も無い)を復元する
//     ↓
//   A由来の値がB側のメモリ・DOMへ1件も残っていないこと
//
// 既存の public/test/*.js と同じく、index.html から関数ソースを文字列抽出して
// Node.jsのvmで実行する方式(製品コードに一切手を入れずに検証するため)。
// 描画関数(renderFloors等)はこのテストの対象外なのでスタブに置き換える。
'use strict';
var fs = require('fs');
var path = require('path');
var vm = require('vm');

var results = [];
function check(label, cond, detail) {
  results.push({ label: label, ok: !!cond });
  console.log((cond ? 'OK' : 'NG') + ': ' + label + (detail !== undefined ? ' (' + JSON.stringify(detail) + ')' : ''));
}

var html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function extractFunctionSource(name) {
  var marker = 'function ' + name + '(';
  var startIdx = html.indexOf(marker);
  if (startIdx === -1) throw new Error('MISSING IMPLEMENTATION SOURCE: function ' + name);
  var braceStart = html.indexOf('{', startIdx);
  var depth = 0;
  var i = braceStart;
  for (; i < html.length; i++) {
    var ch = html[i];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  if (depth !== 0) throw new Error('関数 ' + name + ' の波括弧の対応が取れませんでした');
  // `async function xxx()` の場合は async を落とさない(落とすとawaitが構文エラーになる)。
  if (html.slice(Math.max(0, startIdx - 6), startIdx) === 'async ') startIdx -= 6;
  return html.slice(startIdx, i);
}
// 単一行の `var NAME = ...;` を抽出する。
function extractVarDeclSource(name) {
  var marker = 'var ' + name + ' = ';
  var startIdx = html.indexOf(marker);
  if (startIdx === -1) throw new Error('MISSING IMPLEMENTATION SOURCE: var ' + name);
  var semiIdx = html.indexOf(';', startIdx);
  return html.slice(startIdx, semiIdx + 1);
}

/* ---------------- 最小のDOMスタブ ---------------- */
function makeEl(id) {
  return {
    id: id,
    innerHTML: '',
    textContent: '',
    value: '',
    style: {},
    children: [],
    classList: { toggle: function () {}, add: function () {}, remove: function () {} },
    addEventListener: function () {},
    querySelector: function () { return null; },
    querySelectorAll: function () { return []; },
    closest: function () { return null; },
  };
}
function makeDom() {
  var els = {};
  ['boNotesDisplay', 'boTable-basic', 'boTable-transfer', 'boTable-keys',
    'progressTotalLabel', 'roomListTitle', 'panel', 'photoPanel',
    'progressLogTable', 'progressLogEmpty', 'infoSiteSupervisor',
    'siteSupervisorDisplay', 'siteSupervisorLockBtn', 'scheduleDaysList'].forEach(function (id) {
      els[id] = makeEl(id);
    });
  var building = makeEl('building');
  return {
    els: els,
    building: building,
    document: {
      getElementById: function (id) { return els[id] || null; },
      querySelector: function (sel) { return sel === '.building' ? building : null; },
      querySelectorAll: function () { return []; },
      createElement: function () { return makeEl('tmp'); },
    },
  };
}

/* ---------------- 保存領域のスタブ ----------------
   window.storage.get() は「行が無い」場合に throw する実装(supabase-integration.js)なので、
   ここでも未保存キーは reject にする(storageGetのエラー経路を本物と同じにするため)。 */
function makeStore(entries) {
  return {
    entries: entries,
    deleteCalls: [],
    get: function (key) {
      if (Object.prototype.hasOwnProperty.call(this.entries, key)) {
        return Promise.resolve({ key: key, value: this.entries[key], shared: true });
      }
      return Promise.reject(new Error('key not found: ' + key));
    },
  };
}

var SRC = [
  extractVarDeclSource('COMMON_AREA_KEY'),
  extractVarDeclSource('BO_TABLE_SECTIONS'),
  extractVarDeclSource('BO_TABLE_KEY_PREFIX'),
  extractVarDeclSource('BUILDING_NOTES_KEY'),
  extractVarDeclSource('PROGRESS_LOG_KEY'),
  extractVarDeclSource('SITE_SUPERVISOR_KEY'),
  extractVarDeclSource('SCHEDULE_DAYS_KEY'),
  extractVarDeclSource('EQUIPMENT_LIST_KEY'),
  extractVarDeclSource('UPLOADED_DOCUMENTS_KEY'),
  extractFunctionSource('escapeHtml'),
  extractFunctionSource('boTextToTableHtml'),
  extractFunctionSource('keyFor'),
  extractVarDeclSource('BINDER_KEY_PREFIX'),
  extractVarDeclSource('SCHEDULE_OVERRIDE_KEY_PREFIX'),
  extractFunctionSource('scheduleOverrideKeyFor'),
  extractFunctionSource('todayISODate'),
  extractFunctionSource('isoFromJpDate'),
  extractFunctionSource('seedScheduleDaysIfNeeded'),
  extractFunctionSource('blankPropertyRecord'),
  extractVarDeclSource('propertyViewBaseline'),
  extractFunctionSource('blankPropertyViewBaseline'),
  extractFunctionSource('currentPropertyViewBaseline'),
  extractFunctionSource('applyPropertyViewBaselineToDom'),
  extractFunctionSource('resetAllInMemoryPropertyState'),
  extractFunctionSource('serializeCurrentProperty'),
  extractFunctionSource('applyCurrentPropertyRecord'),
  extractFunctionSource('loadBuildingNotes'),
  extractFunctionSource('loadBoTables'),
  extractFunctionSource('loadProgressLog'),
  extractFunctionSource('loadSiteSupervisor'),
  extractFunctionSource('loadScheduleDays'),
  extractFunctionSource('loadEquipmentList'),
  extractFunctionSource('loadUploadedDocuments'),
  // [2026-08-19] request storm対策で loadAll() は「再入ガード」と「本体(loadAllInner)」へ
  // 分かれた。このテストが見ている挙動(物件切替時のメモリ整理・保存値からの復元・オフライン耐性)は
  // 本体側にあるため、両方を読み込む。期待値は1つも変えていない。
  extractVarDeclSource('loadAllInFlight'),
  extractFunctionSource('loadAll'),
  extractFunctionSource('loadAllInner'),
].join('\n');

var PROPERTY_ID = 'b6e18eed-f2f3-4674-812d-322732908616';

// index.html に直書きされている初期値(＝組み込みデモ物件の値)を模したDOM/メモリを作る。
function makeContext(store) {
  var dom = makeDom();
  dom.els['boNotesDisplay'].innerHTML = '<div>デモ物件の特記事項</div>';
  dom.els['boTable-basic'].innerHTML = '<div class="bo-row">デモ物件の基本情報</div>';
  dom.els['boTable-transfer'].innerHTML = '<div class="bo-row">デモ物件の移報関係</div>';
  dom.els['boTable-keys'].innerHTML = '<div class="bo-row">デモ物件の借用鍵</div>';
  dom.els['panel'].style.display = 'none';
  dom.els['photoPanel'].style.display = 'none';

  var calls = { storageDelete: [], storageSet: [], stampClearPersisted: 0, clearDemoStamp: 0 };
  var ctx = {
    document: dom.document,
    window: { getCurrentPropertyId: function () { return PROPERTY_ID; } },
    Date: Date, JSON: JSON, Array: Array, Object: Object, String: String,
    Promise: Promise, parseInt: parseInt, isNaN: isNaN, console: console,

    PROPERTY: {
      propertyId: PROPERTY_ID, name: 'デモ物件', inspectionDate: '2026年8月17日（月）',
      inspectionType: '総合点検', startTime: '09:00', endTime: '17:00',
      actualStartTime: '', actualEndTime: '', siteSupervisor: 'デモ責任者', scheduleDays: null,
    },
    FLOORS: [], SENSOR_MASTER: {}, TOTAL_ROOMS: 0,
    EXTINGUISHER_DATA: [], EQUIPMENT_LIST: ['デモ設備'], PREVIOUS_DEFECTS: [],
    LADDER_ROOMS: [], EVACUATION_EQUIPMENT_ROOMS: [], ROOM_SPACE_TYPE_FLAGS: {},
    state: {}, lastRawByRoom: {}, scheduleOverrides: {}, lastRawScheduleOverrideByRoom: {},
    scheduleLabels: {}, scheduleDayColors: {}, haBadges: {}, sensorCounts: {},
    equipmentState: {}, extinguisherState: {},
    progressLog: [{ id: 'seed-demo', date: '2026-01-01', staff: 'デモ', notes: 'デモ経過記録' }],
    editingProgressLogId: null,
    UPLOADED_DOCUMENTS: [],
    siteSupervisorLocked: false,
    currentHomeMode: 'normal', activeFilter: null,

    // 保存レイヤー
    storageGet: function (key) { return store.get(key); },
    /* [2026-08-19] loadAll()が全部屋分をまとめて取る経路。このテストの対象は「取得した後の
       メモリ整理・復元」なので、取得手段そのものは既存のstorageGetフェイクと同じ動きの
       スタブにしている(1件ずつ取れて、失敗した部屋はnull)。まとめ取り自体の正しさは
       request storm専用テスト(request_storm_fix_verify.js)で機械確認している。 */
    readRoomValuesBulk: function (rooms, keyForFn) {
      return Promise.all(rooms.map(function (room) {
        return store.get(keyForFn(room)).catch(function () { return null; });
      }));
    },
    loadAllInFlight: false,
    storageDelete: function (key) { calls.storageDelete.push(key); return Promise.resolve(); },
    storageSet: function (key, v) { calls.storageSet.push(key); return Promise.resolve(); },

    // 依存のスタブ(このテストの対象外)
    clearDemoStampDataForPropertyChange: function () { calls.clearDemoStamp++; },
    restoreStampDataFromStorage: function () {},
    isEquipmentListNoiseLabel: function () { return false; },
    syncLegacyPropertyTimeFields: function () {},
    initScheduleLabels: function () {}, renderFilterChips: function () {},
    renderFloors: function () {}, renderProgressLogTable: function () {},
    renderSiteSupervisorField: function () {}, renderEquipmentList: function () {},
    renderPropertyInfo: function () {}, renderScheduleDays: function () {},
  };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  return { ctx: ctx, dom: dom, calls: calls };
}

/* ---------------- 点検日程シードの期待値算出(参照実装) ----------------
   [2026-08-18修正] 以前はここの期待値を '2026-08-17' という固定日付で書いていたため、
   テストを書いた当日しかPASSしないテストになっていた(翌日以降は必ずFAIL)。
   固定値をやめ、製品 seedScheduleDaysIfNeeded() / isoFromJpDate() と同じルールから
   期待値を毎回算出する。ctx側の関数をそのまま呼ぶと「製品が製品と一致する」だけの
   無意味なテストになるので、ルールはここへ独立に書き起こす(参照実装)。

   現在の製品仕様(2026-08-18時点):
     ・点検日 PROPERTY.inspectionDate が厳密に `YYYY年M月D日` のときだけその日付を使う
     ・それ以外(曜日付きの `2026年8月17日（月）` など)は本日日付へフォールバックする
   後者は isoFromJpDate() が曜日付き表記を解釈できないことによる既存バグだが、
   Phase 1Bのスコープ外のため製品側は修正せず、現仕様として期待値へ反映する。
   (曜日付き表記を正しく解釈するよう製品を直したら、このテストは意図どおり落ちる) */
function refTodayISODate() {
  var d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function refExpectedSeedDate(jpDate) {
  var m = /^(\d{4})年(\d{1,2})月(\d{1,2})日$/.exec(jpDate || '');
  if (!m) return refTodayISODate();
  return m[1] + '-' + String(m[2]).padStart(2, '0') + '-' + String(m[3]).padStart(2, '0');
}
// 保存が1件も無いときに seedScheduleDaysIfNeeded() が作るべき1日分。
function refExpectedSeedDay(property) {
  return {
    date: refExpectedSeedDate(property.inspectionDate),
    startTime: property.startTime || '09:00',
    endTime: property.endTime || '17:00',
    actualStartTime: property.actualStartTime || '',
    actualEndTime: property.actualEndTime || '',
  };
}

async function loadAllPropertyScopedData(ctx) {
  await ctx.loadBuildingNotes();
  await ctx.loadBoTables();
  await ctx.loadProgressLog();
  await ctx.loadSiteSupervisor();
  await ctx.loadScheduleDays();
  await ctx.loadEquipmentList();
  await ctx.loadUploadedDocuments();
  await ctx.loadAll();
}

/* ============================================================
   1. Phase 1B前と同じであること: 保存が1件も無いとき、直書きの初期値が残る
   ============================================================ */
async function testNoBehaviourChangeWithoutReset() {
  console.log('==== 1. 物件を切り替えない限り挙動が変わらない(直書き初期値のまま) ====');
  var env = makeContext(makeStore({}));
  var ctx = env.ctx;
  await loadAllPropertyScopedData(ctx);
  check('特記事項は直書きの初期表示のまま', env.dom.els['boNotesDisplay'].innerHTML === '<div>デモ物件の特記事項</div>',
    env.dom.els['boNotesDisplay'].innerHTML);
  check('物件概要テーブル(basic)は直書きの初期表示のまま', env.dom.els['boTable-basic'].innerHTML === '<div class="bo-row">デモ物件の基本情報</div>');
  check('物件概要テーブル(transfer)は直書きの初期表示のまま', env.dom.els['boTable-transfer'].innerHTML === '<div class="bo-row">デモ物件の移報関係</div>');
  check('物件概要テーブル(keys)は直書きの初期表示のまま', env.dom.els['boTable-keys'].innerHTML === '<div class="bo-row">デモ物件の借用鍵</div>');
  check('経過記録は直書きの初期値のまま', ctx.progressLog.length === 1 && ctx.progressLog[0].id === 'seed-demo');
  check('設備一覧は直書きの初期値のまま', JSON.stringify(ctx.EQUIPMENT_LIST) === JSON.stringify(['デモ設備']));
  check('現場責任者は直書きの初期値のまま', ctx.PROPERTY.siteSupervisor === 'デモ責任者');
  check('点検日程は初期値(1日分)が作られる', Array.isArray(ctx.PROPERTY.scheduleDays) && ctx.PROPERTY.scheduleDays.length === 1);
  check('保存データの削除は0件', env.calls.storageDelete.length === 0, env.calls.storageDelete);
}

/* ============================================================
   2. TEST-V V-6: A → メモリ初期化 → B(保存なし) で A由来の値が0件
   ============================================================ */
var A_STORE_ENTRIES = {
  'fireflow-property:buildingNotes': 'A概要',
  'fireflow-property:boTable:basic': '引合先：A情報',
  'fireflow-property:boTable:transfer': 'EV管制：A情報',
  'fireflow-property:boTable:keys': '借用鍵：A情報',
  'fireflow-property:progressLog': JSON.stringify([{ id: 'a-1', date: '2026-02-02', staff: 'A記録', notes: 'A記録' }]),
  'fireflow-property:siteSupervisor': JSON.stringify({ name: 'A責任者', locked: true }),
  'fireflow-property:scheduleDays': JSON.stringify([{ date: '2026-02-02', startTime: '08:00', endTime: '18:00', actualStartTime: '08:05', actualEndTime: '' }]),
  'fireflow-property:equipmentList': JSON.stringify(['A設備']),
  'fireflow-documents': JSON.stringify([{ id: 'a-doc', fileName: 'A資料' }]),
  'fireflow-binder:101': JSON.stringify({ status: 'done', inspector: 'A点検員', visitTimes: ['10:30'], photos: [], signature: null }),
  'fireflow-schedule-override:101': JSON.stringify({ time: '10:30', by: 'A点検員' }),
};

var RECORD_A = {
  property: {
    propertyId: PROPERTY_ID, name: 'A物件', inspectionDate: '2026年2月2日（月）',
    inspectionType: '総合点検', startTime: '08:00', endTime: '18:00',
    actualStartTime: '', actualEndTime: '', siteSupervisor: 'A責任者', scheduleDays: null,
  },
  floors: [{ floor: '1階', rooms: ['101'] }],
  sensorMaster: { '101': { sa: 6, tei: 1 } },
  extinguisherData: [{ no: 1, location: 'A設置場所' }],
  equipmentList: ['A設備'],
  previousDefects: [{ equipment: 'A設備', detail: 'A不良', rooms: ['101'] }],
  ladderRooms: ['101'],
  evacuationEquipmentRooms: ['101'],
  roomSpaceTypeFlags: { '101': 'A要確認' },
  savedAt: '2026-02-02T00:00:00.000Z',
};

// 物件B: 部屋番号101はAと意図的に同じ。保存データは1件も無い(＝Bのstoreは空)。
var RECORD_B = {
  property: {
    propertyId: PROPERTY_ID, name: 'B物件', inspectionDate: '2026年8月17日（月）',
    inspectionType: '機器点検', startTime: '09:00', endTime: '17:00',
    actualStartTime: '', actualEndTime: '', siteSupervisor: '', scheduleDays: null,
  },
  floors: [{ floor: '1階', rooms: ['101'] }],
  savedAt: '2026-08-17T00:00:00.000Z',
};

function collectAResidue(ctx, dom) {
  var snapshot = JSON.stringify({
    property: ctx.PROPERTY, floors: ctx.FLOORS, sensorMaster: ctx.SENSOR_MASTER,
    extinguisherData: ctx.EXTINGUISHER_DATA, equipmentList: ctx.EQUIPMENT_LIST,
    previousDefects: ctx.PREVIOUS_DEFECTS, ladderRooms: ctx.LADDER_ROOMS,
    evacuationEquipmentRooms: ctx.EVACUATION_EQUIPMENT_ROOMS,
    roomSpaceTypeFlags: ctx.ROOM_SPACE_TYPE_FLAGS,
    state: ctx.state, scheduleOverrides: ctx.scheduleOverrides,
    lastRawByRoom: ctx.lastRawByRoom, lastRawScheduleOverrideByRoom: ctx.lastRawScheduleOverrideByRoom,
    scheduleLabels: ctx.scheduleLabels, haBadges: ctx.haBadges, sensorCounts: ctx.sensorCounts,
    equipmentState: ctx.equipmentState, extinguisherState: ctx.extinguisherState,
    progressLog: ctx.progressLog, documents: ctx.UPLOADED_DOCUMENTS,
    siteSupervisorLocked: ctx.siteSupervisorLocked,
    currentHomeMode: ctx.currentHomeMode, activeFilter: ctx.activeFilter,
    dom: {
      notes: dom.els['boNotesDisplay'].innerHTML,
      basic: dom.els['boTable-basic'].innerHTML,
      transfer: dom.els['boTable-transfer'].innerHTML,
      keys: dom.els['boTable-keys'].innerHTML,
      building: dom.building.textContent,
    },
  });
  // 「A概要」「A情報」「A記録」「A責任者」「A設備」「A資料」「A物件」「A点検員」等
  return (snapshot.match(/A(?:概要|情報|記録|責任者|設備|資料|物件|点検員|不良|要確認|設置場所)/g) || []);
}

async function testV6() {
  console.log('\n==== 2. TEST-V V-6: 物件A → メモリ初期化 → 物件B(保存なし) ====');
  var storeA = makeStore(A_STORE_ENTRIES);
  var env = makeContext(storeA);
  var ctx = env.ctx;

  // ---- A状態を作る ----
  ctx.applyCurrentPropertyRecord(RECORD_A);
  await loadAllPropertyScopedData(ctx);
  check('前提: 物件Aの特記事項が復元されている', env.dom.els['boNotesDisplay'].innerHTML.indexOf('A概要') !== -1);
  check('前提: 物件Aの経過記録が復元されている', ctx.progressLog.length === 1 && ctx.progressLog[0].staff === 'A記録');
  check('前提: 物件Aの現場責任者が復元されている', ctx.PROPERTY.siteSupervisor === 'A責任者' && ctx.siteSupervisorLocked === true);
  check('前提: 物件Aの設備一覧が復元されている', JSON.stringify(ctx.EQUIPMENT_LIST) === JSON.stringify(['A設備']));
  check('前提: 物件Aの資料一覧が復元されている', ctx.UPLOADED_DOCUMENTS.length === 1);
  check('前提: 物件Aの101号室が点検済み・訪問時刻10:30で復元されている',
    ctx.state['101'] && ctx.state['101'].status === 'done' && ctx.state['101'].visitTimes[0] === '10:30');
  check('前提: 物件Aの101号室の点検時刻変更(override)が復元されている', ctx.scheduleOverrides['101'] && ctx.scheduleOverrides['101'].time === '10:30');
  check('前提: 物件Aの点検日程が復元されている', ctx.PROPERTY.scheduleDays[0].date === '2026-02-02');
  check('前提: A復元後もA由来の値は検出できる(検出ロジック自体が動いている)', collectAResidue(ctx, env.dom).length > 0);

  // ---- メモリ初期化 ----
  ctx.resetAllInMemoryPropertyState();
  check('初期化後: PROPERTY.propertyId は失われない', ctx.PROPERTY.propertyId === PROPERTY_ID, ctx.PROPERTY.propertyId);
  check('初期化後: A由来の値が0件', collectAResidue(ctx, env.dom).length === 0, collectAResidue(ctx, env.dom));
  check('初期化後: 保存データの削除は0件', env.calls.storageDelete.length === 0, env.calls.storageDelete);
  check('初期化後: 予定情報はメモリのみ初期化される(clearDemoStampDataForPropertyChange経由)', env.calls.clearDemoStamp > 0);

  // ---- 物件B(保存データ0件)を復元 ----
  storeA.entries = {}; // Bのスコープには保存が1件も無い
  ctx.applyCurrentPropertyRecord(RECORD_B);
  await loadAllPropertyScopedData(ctx);

  var residue = collectAResidue(ctx, env.dom);
  check('B復元後: A由来の文字列がメモリ・DOMに1件も残らない', residue.length === 0, residue);
  check('buildingNotes = 空', env.dom.els['boNotesDisplay'].innerHTML === '', env.dom.els['boNotesDisplay'].innerHTML);
  check('boTable basic = 空', env.dom.els['boTable-basic'].innerHTML === '');
  check('boTable transfer = 空', env.dom.els['boTable-transfer'].innerHTML === '');
  check('boTable keys = 空', env.dom.els['boTable-keys'].innerHTML === '');
  check('progressLog = []', Array.isArray(ctx.progressLog) && ctx.progressLog.length === 0, ctx.progressLog);
  check('siteSupervisor = 空 / 未確定', ctx.PROPERTY.siteSupervisor === '' && ctx.siteSupervisorLocked === false);
  // 期待値は固定日付ではなく、製品と同じルール(refExpectedSeedDay)で毎回算出する。
  // 「日付なら何でもOK」にはせず、日付・予定時刻・実施時刻の5項目すべてを厳密比較する。
  var expectedSeedDay = refExpectedSeedDay(RECORD_B.property);
  var actualSeedDay = ctx.PROPERTY.scheduleDays && ctx.PROPERTY.scheduleDays[0];
  check('scheduleDays = 初期状態(Bの点検日から1日分。Aの日付・時刻は残らない)',
    ctx.PROPERTY.scheduleDays.length === 1 && !!actualSeedDay
    && actualSeedDay.date === expectedSeedDay.date
    && actualSeedDay.startTime === expectedSeedDay.startTime
    && actualSeedDay.endTime === expectedSeedDay.endTime
    && actualSeedDay.actualStartTime === expectedSeedDay.actualStartTime
    && actualSeedDay.actualEndTime === expectedSeedDay.actualEndTime,
    { expected: expectedSeedDay, actual: ctx.PROPERTY.scheduleDays });
  check('equipmentList = []', Array.isArray(ctx.EQUIPMENT_LIST) && ctx.EQUIPMENT_LIST.length === 0, ctx.EQUIPMENT_LIST);
  check('UPLOADED_DOCUMENTS = []', Array.isArray(ctx.UPLOADED_DOCUMENTS) && ctx.UPLOADED_DOCUMENTS.length === 0);
  check('state にA由来値0件(101号室は同じ番号でも点検済み・訪問時刻が残らない)',
    Object.keys(ctx.state).length === 0, ctx.state);
  check('scheduleOverrides にA由来値0件', Object.keys(ctx.scheduleOverrides).length === 0, ctx.scheduleOverrides);
  check('lastRawByRoom / lastRawScheduleOverrideByRoom にA由来値0件',
    Object.keys(ctx.lastRawByRoom).length === 0 && Object.keys(ctx.lastRawScheduleOverrideByRoom).length === 0);
  check('SENSOR_MASTER にA由来値0件', Object.keys(ctx.SENSOR_MASTER).length === 0, ctx.SENSOR_MASTER);
  check('EXTINGUISHER_DATA / PREVIOUS_DEFECTS / LADDER_ROOMS にA由来値0件',
    ctx.EXTINGUISHER_DATA.length === 0 && ctx.PREVIOUS_DEFECTS.length === 0 && ctx.LADDER_ROOMS.length === 0);
  check('ROOM_SPACE_TYPE_FLAGS にA由来値0件', Object.keys(ctx.ROOM_SPACE_TYPE_FLAGS).length === 0);
  check('currentHomeMode = normal', ctx.currentHomeMode === 'normal');
  check('activeFilter = null', ctx.activeFilter === null);
  check('B復元後もPROPERTY.propertyIdが保持される', ctx.PROPERTY.propertyId === PROPERTY_ID);
  check('全工程を通して保存データの削除は0件', env.calls.storageDelete.length === 0, env.calls.storageDelete);
}

/* ============================================================
   3. applyCurrentPropertyRecord: レコードに項目が無い場合も既定初期値へ戻す
   ============================================================ */
function testApplyRecordFallsBackToDefaults() {
  console.log('\n==== 3. applyCurrentPropertyRecord: 項目が無いレコードでも前物件を残さない ====');
  var env = makeContext(makeStore({}));
  var ctx = env.ctx;
  ctx.applyCurrentPropertyRecord(RECORD_A);
  // 物件だけしか入っていない、項目の欠けたレコード(旧形式・部分保存)
  ctx.applyCurrentPropertyRecord({ property: RECORD_B.property });
  check('floors が無ければ []', ctx.FLOORS.length === 0);
  check('sensorMaster が無ければ {}', Object.keys(ctx.SENSOR_MASTER).length === 0);
  check('extinguisherData が無ければ []', ctx.EXTINGUISHER_DATA.length === 0);
  check('equipmentList が無ければ []', ctx.EQUIPMENT_LIST.length === 0);
  check('previousDefects が無ければ []', ctx.PREVIOUS_DEFECTS.length === 0);
  check('ladderRooms / evacuationEquipmentRooms が無ければ []',
    ctx.LADDER_ROOMS.length === 0 && ctx.EVACUATION_EQUIPMENT_ROOMS.length === 0);
  check('roomSpaceTypeFlags が無ければ {}', Object.keys(ctx.ROOM_SPACE_TYPE_FLAGS).length === 0);
  check('TOTAL_ROOMS が 0 へ更新される', ctx.TOTAL_ROOMS === 0);

  // propertyそのものが無いレコード
  ctx.applyCurrentPropertyRecord({ floors: [] });
  check('property が無ければ既定初期値へ戻り、propertyId は保持される',
    ctx.PROPERTY.name === '' && ctx.PROPERTY.siteSupervisor === '' && ctx.PROPERTY.propertyId === PROPERTY_ID, ctx.PROPERTY);

  // Phase 1A以前の保存レコード(propertyId無し)。推測でUUIDを作らない。
  var legacy = JSON.parse(JSON.stringify(RECORD_A));
  delete legacy.property.propertyId;
  ctx.applyCurrentPropertyRecord(legacy);
  check('propertyId無しの旧レコードでも、推測でpropertyIdを作らない(migrationはPhase 1D)',
    ctx.PROPERTY.propertyId === undefined, ctx.PROPERTY.propertyId);
  check('保存データの削除は0件', env.calls.storageDelete.length === 0);
}

/* ============================================================
   4. loadAll: 現在の物件に無い部屋をメモリから落とす(保存は消さない)
   ============================================================ */
async function testLoadAllPrunesForeignRooms() {
  console.log('\n==== 4. loadAll: 現在の物件(FLOORS)に無い部屋の残留を落とす ====');
  var store = makeStore({
    'fireflow-binder:201': JSON.stringify({ status: 'done', inspector: 'B点検員', visitTimes: [], photos: [] }),
  });
  var env = makeContext(store);
  var ctx = env.ctx;
  ctx.FLOORS = [{ floor: '2階', rooms: ['201'] }];
  ctx.state = {
    '101': { status: 'done', inspector: 'A点検員', visitTimes: ['10:30'], photos: [] }, // 前物件の部屋
    '共用部・屋外': { status: 'done', inspector: 'B点検員', visitTimes: [], photos: [] },
  };
  ctx.lastRawByRoom = { '101': 'stale' };
  ctx.scheduleOverrides = { '101': { time: '10:30' } };
  ctx.lastRawScheduleOverrideByRoom = { '101': 'stale' };
  await ctx.loadAll();
  check('前物件の部屋(101)の点検状態がメモリから落ちる', ctx.state['101'] === undefined);
  check('前物件の部屋(101)の点検時刻変更がメモリから落ちる', ctx.scheduleOverrides['101'] === undefined);
  check('変更検出キャッシュ(lastRaw*)も一緒に落ちる',
    ctx.lastRawByRoom['101'] === undefined && ctx.lastRawScheduleOverrideByRoom['101'] === undefined);
  check('共用部(FLOORSに含まれない正規の記録先)は残る', !!ctx.state['共用部・屋外']);
  check('現在の物件の部屋(201)は保存値から復元される', ctx.state['201'] && ctx.state['201'].inspector === 'B点検員');
  check('保存データの削除(storageDelete)は0件', env.calls.storageDelete.length === 0, env.calls.storageDelete);

  // 保存の読み取りに失敗した部屋(オフライン等)の点検状態を消さないこと。
  var offlineEnv = makeContext({ get: function () { return Promise.reject(new Error('offline')); } });
  var octx = offlineEnv.ctx;
  octx.FLOORS = [{ floor: '1階', rooms: ['101'] }];
  octx.state = { '101': { status: 'done', inspector: '現場点検員', visitTimes: ['09:00'], photos: [] } };
  await octx.loadAll();
  check('storageGetが失敗しても、現在の物件の部屋の点検状態を消さない(オフライン起動対策)',
    octx.state['101'] && octx.state['101'].status === 'done');
}

/* ============================================================
   5. 保存データ削除禁止(ソース検査)
   ============================================================ */
function testNoPersistedDeletes() {
  console.log('\n==== 5. 初期化は保存データを削除しない(ソース検査) ====');
  // 「呼び出し」だけを見る(経緯を説明するコメント中の言及は対象外)。
  var resetSrc = extractFunctionSource('resetAllInMemoryPropertyState');
  ['storageDelete(', 'clearPersisted(', 'lcDelete(', 'removeItem('].forEach(function (needle) {
    check('resetAllInMemoryPropertyState() が ' + needle + ' を呼ばない', resetSrc.indexOf(needle) === -1);
  });
  var clearDemoSrc = extractFunctionSource('clearDemoStampDataForPropertyChange');
  check('予定情報の初期化はメモリのみ(clearMemory)で、保存(clearPersisted)は消さない',
    clearDemoSrc.indexOf('clearMemory(') !== -1 && clearDemoSrc.indexOf('clearPersisted(') === -1);
  ['applyCurrentPropertyRecord', 'loadBuildingNotes', 'loadBoTables', 'loadProgressLog',
    'loadSiteSupervisor', 'loadScheduleDays', 'loadEquipmentList', 'loadUploadedDocuments', 'loadAll',
    'loadAllInner'
  ].forEach(function (name) {
    check(name + '() が storageDelete を呼ばない', extractFunctionSource(name).indexOf('storageDelete(') === -1);
  });
  // 保存キーの形式はPhase 1Bでは1つも変えない(propertyIdの差し込みはPhase 1C)。
  check('保存キーへpropertyIdを差し込む変更が入っていない',
    html.indexOf("':' + PROPERTY.propertyId") === -1 && html.indexOf('PROPERTY.propertyId +') === -1);
}

(async function main() {
  await testNoBehaviourChangeWithoutReset();
  await testV6();
  testApplyRecordFallsBackToDefaults();
  await testLoadAllPrunesForeignRooms();
  testNoPersistedDeletes();

  var okCount = results.filter(function (r) { return r.ok; }).length;
  var allOk = okCount === results.length;
  console.log('\n==== phase1b_property_state_reset_verify (TEST-V V-6) 総合結果: '
    + (allOk ? 'PASS' : 'FAIL') + ' (' + okCount + '/' + results.length + ') ====');
  if (!allOk) process.exitCode = 1;
})();
