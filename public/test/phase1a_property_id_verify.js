// [2026-08-17新設 Phase 1A] propertyId基盤の機械確認。
//
// Phase 1Aの成功条件は「propertyIdの土台を追加したのに、Live Boardの現在の挙動が
// 何も変わっていない」こと。そのため、このスクリプトは新機能の動作ではなく
// 「変わっていないこと」を検査する。
//
// 検査項目（Phase 1A仕様書 14章 A〜F に対応。G/HはStampStore・保存キーの
// git差分0なので、ソース検査ではなく git diff 側で確認する）:
//   A. supabase-integration.js に `const PROPERTY_ID =` が0件（旧UUIDは初期値として1箇所だけ）
//   B. index.html の PROPERTY に propertyId が存在する
//   C. PROPERTY.propertyId が 保存(serializeCurrentProperty) → 復元(applyCurrentPropertyRecord) で保持される
//   D. currentPropertyId の初期値が従来の固定UUIDと同じ
//   E. 既存のstorage/Realtime/写真/権限/招待の各処理が、固定定数ではなく currentPropertyId を参照する
//   F. Report Flow payload の差分が property.propertyId だけ（他フィールドは差分0）
//
// 既存の public/test/*.js と同じく、index.html から関数ソースを文字列抽出して
// Node.jsのvmで実行する方式（製品コードに一切手を入れずに検証するため）。
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
var sbjs = fs.readFileSync(path.join(__dirname, '..', 'supabase-integration.js'), 'utf8');

// Phase 1A以前から使われている、この環境の固定物件UUID（コスモ六甲ガーデンフォート）。
// Phase 1Aでは保存先・読込先を1件も変えないため、この値が変わってはいけない。
var LEGACY_FIXED_PROPERTY_ID = 'b6e18eed-f2f3-4674-812d-322732908616';

function countOccurrences(haystack, needle) {
  var n = 0;
  var i = 0;
  for (;;) {
    var found = haystack.indexOf(needle, i);
    if (found === -1) return n;
    n++;
    i = found + needle.length;
  }
}

function extractFunctionSource(src, name) {
  var marker = 'function ' + name + '(';
  var startIdx = src.indexOf(marker);
  if (startIdx === -1) throw new Error('MISSING IMPLEMENTATION SOURCE: function ' + name);
  var braceStart = src.indexOf('{', startIdx);
  var depth = 0;
  var i = braceStart;
  for (; i < src.length; i++) {
    var ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  if (depth !== 0) throw new Error('関数 ' + name + ' の波括弧の対応が取れませんでした');
  return src.slice(startIdx, i);
}

// `var NAME = {` から対応する `};` までを抽出する（PROPERTYのようなオブジェクトリテラル用）。
function extractObjectVarSource(src, name) {
  var marker = 'var ' + name + ' = {';
  var startIdx = src.indexOf(marker);
  if (startIdx === -1) throw new Error('MISSING IMPLEMENTATION SOURCE: var ' + name);
  var braceStart = src.indexOf('{', startIdx);
  var depth = 0;
  var i = braceStart;
  for (; i < src.length; i++) {
    var ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  if (depth !== 0) throw new Error('var ' + name + ' の波括弧の対応が取れませんでした');
  return src.slice(startIdx, i) + ';';
}

console.log('==== A. 固定定数 PROPERTY_ID の廃止 (supabase-integration.js) ====');
check('`const PROPERTY_ID =` が0件（固定定数は廃止済み）',
  countOccurrences(sbjs, 'const PROPERTY_ID =') === 0,
  countOccurrences(sbjs, 'const PROPERTY_ID ='));
(function () {
  // コード行に識別子 PROPERTY_ID が残っていないこと。旧名に言及するコメント行
  // （「固定定数 const PROPERTY_ID を廃止し…」という経緯の記録）は対象外とする。
  var offenders = sbjs.split('\n').map(function (line, i) {
    return { no: i + 1, text: line };
  }).filter(function (row) {
    var trimmed = row.text.trim();
    if (trimmed.indexOf('//') === 0 || trimmed.indexOf('*') === 0) return false; // コメント行
    return /\bPROPERTY_ID\b/.test(row.text.replace(/INITIAL_PROPERTY_ID/g, ''));
  });
  check('識別子としての `PROPERTY_ID` 参照がコード行に残っていない（INITIAL_PROPERTY_IDを除く）',
    offenders.length === 0, offenders);
})();
check('旧固定UUIDのリテラルはちょうど1箇所だけ（currentPropertyIdの初期値として）',
  countOccurrences(sbjs, LEGACY_FIXED_PROPERTY_ID) === 1,
  countOccurrences(sbjs, LEGACY_FIXED_PROPERTY_ID));
check('実行時変数 currentPropertyId が宣言されている',
  /var\s+currentPropertyId\s*=/.test(sbjs));
check('setter（setCurrentPropertyId）が1つだけ定義されている',
  countOccurrences(sbjs, 'function setCurrentPropertyId(') === 1);
check('setter以外に currentPropertyId へ代入している箇所が無い',
  (sbjs.match(/currentPropertyId\s*=[^=]/g) || []).length === 2, // 宣言時の初期化 + setter内の1回
  (sbjs.match(/currentPropertyId\s*=[^=]/g) || []));

console.log('\n==== D. currentPropertyId の初期値が従来の固定UUIDと同じ ====');
(function () {
  var m = sbjs.match(/const\s+INITIAL_PROPERTY_ID\s*=\s*'([^']+)'/);
  check('INITIAL_PROPERTY_ID が定義されている', !!m);
  check('INITIAL_PROPERTY_ID === 旧固定PROPERTY_ID', !!m && m[1] === LEGACY_FIXED_PROPERTY_ID, m && m[1]);
  check('currentPropertyId の初期値が INITIAL_PROPERTY_ID',
    /var\s+currentPropertyId\s*=\s*INITIAL_PROPERTY_ID\s*;/.test(sbjs));
  // UUID v4 / 小文字 / 36文字（Phase 1A仕様 3章）
  check('旧固定UUIDはUUID v4・小文字・36文字の要件を満たす（setterの検証を通る）',
    LEGACY_FIXED_PROPERTY_ID.length === 36 &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(LEGACY_FIXED_PROPERTY_ID));
})();

console.log('\n==== E. 既存のSupabase処理が currentPropertyId を参照する ====');
(function () {
  // Phase 1A前に固定PROPERTY_IDを参照していた全12箇所が、同じ形のまま
  // currentPropertyId を参照していること（関数シグネチャは変更しない方針）。
  var required = [
    ["ensureInspectionSession の既存セッション検索", "sb.from('inspections').select('id').eq('property_id', currentPropertyId)"],
    ["ensureInspectionSession の新規作成", "insert({ property_id: currentPropertyId, inspection_date: dateStr })"],
    ["storage.get", "sb.from('kv_store').select('value').eq('property_id', currentPropertyId)"],
    ["storage.set の既存行検索", "sb.from('kv_store').select('id').eq('property_id', currentPropertyId)"],
    ["storage.set の新規行", "property_id: currentPropertyId, key: key,"],
    ["storage.delete", "sb.from('kv_store').delete().eq('property_id', currentPropertyId)"],
    ["storage.list", "sb.from('kv_store').select('key').eq('property_id', currentPropertyId)"],
    ["Realtime(kv_store)の購読フィルタ", "'property_id=eq.' + currentPropertyId"],
    ["uploadInspectionPhoto の保存パス", "var path = currentPropertyId + '/'"],
    ["getMyPropertyRole", ".select('role').eq('property_id', currentPropertyId)"],
    ["createPropertyInvite", "property_id: currentPropertyId,"],
    ["listPropertyInvites", ".eq('property_id', currentPropertyId)"],
  ];
  required.forEach(function (pair) {
    check(pair[0] + ' が currentPropertyId を参照する', sbjs.indexOf(pair[1]) !== -1);
  });
  // [2026-08-18 Phase 1E-A1で更新] Phase 1Aの時点ではsetterを呼ぶ経路が1つも無く、
  // ここは `setCurrentPropertyId(` の出現数が2（定義1 + 経緯コメント1）であることを
  // 見ていた。Phase 1E-A1で「起動時にlb_current_property_idから復元する」経路が
  // 1つだけ追加されたため、期待値を「呼び出し経路0」から「呼び出し経路は起動時復元の
  // 1箇所だけ」へ更新する。Phase 1Aが本当に守りたかった不変条件（currentPropertyIdへの
  // 代入はsetter内の1回だけ／setterは1つだけ／index.htmlからは呼ばれない）は上下の
  // 各checkでそのまま検査し続けている。
  (function () {
    function stripComments(src) {
      return String(src).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
    }
    var codeOnly = stripComments(sbjs);
    check('setterを呼び出す経路は「定義」＋「起動時復元」の1箇所だけ（物件切替UIはまだ無い）',
      countOccurrences(codeOnly, 'setCurrentPropertyId(') === 2, // 定義1 + 起動時復元の呼び出し1
      countOccurrences(codeOnly, 'setCurrentPropertyId('));
    check('その唯一の呼び出しは起動時復元（restorePersistedPropertyIdAtStartup）の中にある',
      /function restorePersistedPropertyIdAtStartup\(\)\s*\{[^}]*setCurrentPropertyId\(saved\);/.test(codeOnly));
  })();
})();

console.log('\n==== B. PROPERTY.propertyId の追加 (index.html) ====');
var PROPERTY_BASELINE_KEYS = [
  'name', 'inspectionDate', 'inspectionType', 'startTime', 'endTime',
  'actualStartTime', 'actualEndTime', 'siteSupervisor', 'scheduleDays',
];
var propertyKeys;
(function () {
  var src = extractFunctionSource(html, 'formatDateJP') + '\n'
    + 'var _today = new Date(2026, 7, 17);\n'
    + extractObjectVarSource(html, 'PROPERTY');
  var ctx = vm.createContext({
    // supabase-integration.js の currentPropertyId 相当（実ブラウザではこの経路で入る）
    window: { getCurrentPropertyId: function () { return LEGACY_FIXED_PROPERTY_ID; } },
    Date: Date,
  });
  vm.runInContext(src, ctx);
  propertyKeys = Object.keys(ctx.PROPERTY);
  check('PROPERTY.propertyId が存在する', propertyKeys.indexOf('propertyId') !== -1, propertyKeys);
  check('PROPERTY.propertyId の値は currentPropertyId（＝旧固定UUID）',
    ctx.PROPERTY.propertyId === LEGACY_FIXED_PROPERTY_ID, ctx.PROPERTY.propertyId);
  check('既存フィールドの削除・renameが無い',
    PROPERTY_BASELINE_KEYS.every(function (k) { return propertyKeys.indexOf(k) !== -1; }), propertyKeys);
  check('追加されたフィールドは propertyId だけ（既存構造を壊していない）',
    propertyKeys.length === PROPERTY_BASELINE_KEYS.length + 1, propertyKeys);

  // supabase-integration.js が読み込まれていない環境（CDNブロック等）でも例外にならない
  var ctx2 = vm.createContext({ window: {}, Date: Date });
  vm.runInContext(src, ctx2);
  check('window.getCurrentPropertyId が未定義でも例外にならずnullになる', ctx2.PROPERTY.propertyId === null, ctx2.PROPERTY.propertyId);

  // PROPERTY定義時に window.getCurrentPropertyId が既に存在している必要がある。
  // supabase-integration.js は defer/async なしの同期スクリプトで、PROPERTY定義より
  // 前に置かれていること（この順序が崩れると propertyId が黙ってnullになる）。
  var tagIdx = html.indexOf('<script src="supabase-integration.js"></script>');
  check('supabase-integration.js が defer/async なしの同期スクリプトとして読み込まれている', tagIdx !== -1);
  check('supabase-integration.js の読み込みが var PROPERTY の定義より前にある',
    tagIdx !== -1 && tagIdx < html.indexOf('var PROPERTY = {'));
  check('window.getCurrentPropertyId が supabase-integration.js のIIFE内で同期的に公開される',
    sbjs.indexOf('window.getCurrentPropertyId = function () { return currentPropertyId; };') !== -1);
})();

console.log('\n==== C. propertyId が 保存 → 復元 で保持される ====');
(function () {
  var src = extractFunctionSource(html, 'serializeCurrentProperty') + '\n'
    + extractFunctionSource(html, 'applyCurrentPropertyRecord');
  var buildingText = null;
  var ctx = vm.createContext({
    PROPERTY: {
      propertyId: LEGACY_FIXED_PROPERTY_ID,
      name: 'コスモ六甲ガーデンフォート',
      inspectionDate: '2026年8月17日(月)',
      inspectionType: '総合点検',
      startTime: '09:00', endTime: '17:00', actualStartTime: '', actualEndTime: '',
      siteSupervisor: '大塚 亮彦', scheduleDays: null,
    },
    FLOORS: [{ floor: '1階', rooms: ['101', '102'] }],
    SENSOR_MASTER: { '101': { sa: 3, tei: 2 } },
    EXTINGUISHER_DATA: [], EQUIPMENT_LIST: [], PREVIOUS_DEFECTS: [],
    LADDER_ROOMS: [], EVACUATION_EQUIPMENT_ROOMS: [], ROOM_SPACE_TYPE_FLAGS: {},
    TOTAL_ROOMS: 0,
    Date: Date, Array: Array, JSON: JSON,
    // applyCurrentPropertyRecord() が呼ぶ依存の最小スタブ
    clearDemoStampDataForPropertyChange: function () {},
    restoreStampDataFromStorage: function () {},
    isEquipmentListNoiseLabel: function () { return false; },
    document: {
      querySelector: function () { return { set textContent(v) { buildingText = v; } }; },
      getElementById: function () { return { textContent: '' }; },
    },
  });
  vm.runInContext(src, ctx);

  var record = ctx.serializeCurrentProperty();
  check('serializeCurrentProperty() の結果に property.propertyId が含まれる',
    record.property && record.property.propertyId === LEGACY_FIXED_PROPERTY_ID, record.property && record.property.propertyId);

  // 実際の保存経路と同じく JSON 文字列を経由させる（persistCurrentProperty相当）
  var roundTripped = JSON.parse(JSON.stringify(record));
  ctx.PROPERTY = { name: '別物件（復元前のダミー）' };
  ctx.applyCurrentPropertyRecord(roundTripped);
  check('applyCurrentPropertyRecord() 後も PROPERTY.propertyId が保持される',
    ctx.PROPERTY.propertyId === LEGACY_FIXED_PROPERTY_ID, ctx.PROPERTY.propertyId);
  check('保存→復元で PROPERTY の他フィールドも従来通り復元される',
    ctx.PROPERTY.name === 'コスモ六甲ガーデンフォート' && ctx.PROPERTY.siteSupervisor === '大塚 亮彦');

  // Phase 1A以前に保存されたレコード（propertyId無し）を読んでも例外にならないこと。
  // 旧レコードへのpropertyId割り当て（推測禁止）はPhase 1Dのmigrationの担当。
  var legacyRecord = JSON.parse(JSON.stringify(record));
  delete legacyRecord.property.propertyId;
  ctx.PROPERTY = { name: 'ダミー' };
  ctx.applyCurrentPropertyRecord(legacyRecord);
  check('Phase 1A以前の保存レコード（propertyId無し）でも復元が壊れない',
    ctx.PROPERTY.name === 'コスモ六甲ガーデンフォート' && ctx.PROPERTY.propertyId === undefined);
})();

console.log('\n==== F. Report Flow payload の差分は property.propertyId だけ ====');
(function () {
  var src = extractFunctionSource(html, 'buildReportFlowPayload');
  var propertyObj = {
    propertyId: LEGACY_FIXED_PROPERTY_ID,
    name: 'コスモ六甲ガーデンフォート',
    inspectionDate: '2026年8月17日(月)',
    inspectionType: '総合点検',
    startTime: '09:00', endTime: '17:00', actualStartTime: '', actualEndTime: '',
    siteSupervisor: '大塚 亮彦', scheduleDays: null,
  };
  var ctx = vm.createContext({
    FLOORS: [{ floor: '1階', rooms: ['101'] }],
    state: { '101': { status: 'done', inspector: '大塚 亮彦', time: '2026-08-17T01:00:00.000Z', photos: [] } },
    COMMON_AREA_KEY: '__common__',
    PROPERTY: propertyObj,
    EQUIPMENT_LIST: ['消火器具'],
    equipmentState: {}, extinguisherState: {}, PREVIOUS_DEFECTS: [],
    collectParticipatingInspectors: function () { return ['大塚 亮彦']; },
    Date: Date,
  });
  vm.runInContext(src, ctx);
  var payload = ctx.buildReportFlowPayload();

  var EXPECTED_TOP_KEYS = ['property', 'siteSupervisor', 'participatingInspectors', 'equipmentList',
    'equipmentState', 'extinguisherState', 'previousDefects', 'results', 'commonArea', 'exportedAt'];
  check('payloadのトップレベル項目はPhase 1A前と同一（新項目0・削除0）',
    JSON.stringify(Object.keys(payload)) === JSON.stringify(EXPECTED_TOP_KEYS), Object.keys(payload));
  check('payload.property は PROPERTY をそのまま利用する既存構造のまま（新しい変換ロジック無し）',
    payload.property === ctx.PROPERTY);
  var propKeysInPayload = Object.keys(payload.property);
  check('payload.property の差分は propertyId の追加だけ',
    propKeysInPayload.length === PROPERTY_BASELINE_KEYS.length + 1 &&
    propKeysInPayload.indexOf('propertyId') !== -1 &&
    PROPERTY_BASELINE_KEYS.every(function (k) { return propKeysInPayload.indexOf(k) !== -1; }), propKeysInPayload);
  check('results（部屋ごとの点検結果）の項目はPhase 1A前と同一',
    JSON.stringify(Object.keys(payload.results[0])) ===
    JSON.stringify(['room', 'status', 'inspector', 'signedAt', 'defects', 'absentVisits', 'cancelled']),
    Object.keys(payload.results[0]));
})();

console.log('\n==== Phase 1A: createProperty / listMyProperties は基盤のみ（UI未接続） ====');
(function () {
  check('createProperty() が定義されている', sbjs.indexOf('window.createProperty = async function') !== -1);
  check('listMyProperties() が定義されている', sbjs.indexOf('window.listMyProperties = async function') !== -1);
  check('createProperty はクライアントでUUIDを発行して properties.id にそのまま使う（ID二重管理をしない）',
    sbjs.indexOf('window.crypto.randomUUID()') !== -1 && sbjs.indexOf('id: propertyId,') !== -1);
  check('createProperty はLB本体(index.html)のどこからも呼ばれていない（現在UIの挙動を変えない）',
    html.indexOf('createProperty(') === -1);
  check('listMyProperties はLB本体(index.html)のどこからも呼ばれていない（UI未接続）',
    html.indexOf('listMyProperties(') === -1);
  check('setCurrentPropertyId はLB本体(index.html)のどこからも呼ばれていない（物件切替はPhase 1E）',
    html.indexOf('setCurrentPropertyId(') === -1);
})();

console.log('\n==== H. 保存キー形式に差分が無い ====');
(function () {
  // Phase 1Aでは保存キーの形式を1つも変えない（scope変更はPhase 1B/1C）。
  var keyDefs = [
    ["fireflow-property:current", "var CURRENT_PROPERTY_KEY = 'fireflow-property:current';"],
    ["fireflow-ext:<no>", "function extKeyFor(no) { return 'fireflow-ext:' + no; }"],
  ];
  keyDefs.forEach(function (pair) {
    check('保存キー ' + pair[0] + ' の定義が従来のまま', html.indexOf(pair[1]) !== -1);
  });
  check('保存キーにpropertyIdを差し込む変更が入っていない（Phase 1B/1Cの担当）',
    html.indexOf("':' + PROPERTY.propertyId") === -1 && html.indexOf('PROPERTY.propertyId +') === -1);
})();

var allOk = results.every(function (r) { return r.ok; });
console.log('\n==== phase1a_property_id_verify 総合結果: ' + (allOk ? 'PASS' : 'FAIL')
  + ' (' + results.filter(function (r) { return r.ok; }).length + '/' + results.length + ') ====');
if (!allOk) process.exitCode = 1;
