// [2026-08-22新設] TEST-V: 実ブラウザで観測された request storm 本体の修正に対する回帰テスト。
//
// 【実ブラウザで確定している事実(2026-08-22 実Safari / localhost:3000)】
// Network履歴を削除し、何も操作せず数秒待っただけで kv_store のリクエストが100件以上発生した。
// 1件クリックして得たURLは次の形で、部屋番号だけが違うものが延々と並んでいた。
//
//     select=id
//     &property_id=eq.b6e18eed-f2f3-4674-812d-322732908616
//     &key=eq.stamp:コスモ六甲ガーデンフォート:113
//     &shared=eq.true
//     &owner_id=is.null
//
// 【発火元(推測ではなく実コードで確定)】
// このパラメータ順(select, property_id, key, shared, owner_id)を作るのは
// supabase-integration.js の window.storage.set() の既存行検索だけ。つまり「読み込み」ではなく
// 【書き込みの前段】である。その書き込みを部屋数ぶん出していたのは index.html の
// seedDemoState() で、「デモを開く」たびに冒頭のハードコード予定情報129室ぶんを putMany() し、
// 1室につき「select id」+「update/insert」の2リクエスト = 258リクエストを、
// 内容が1バイトも変わっていないのに毎回そのまま送り直していた。
// リモートが500で落ちていれば、その129件がそのまま送信キューへ積まれ、5秒ごとの再送で
// さらに積み上がる(= 実ブラウザで観測された「数秒放置で100件以上」)。
//
// 実測された部屋番号 113 / 102 は、どちらも index.html 冒頭のデモ STAMP_DATA に含まれる
// (113 = 10:30、102 = 14:30)。物件名も同じ「コスモ六甲ガーデンフォート」。
//
// 【このテストが守る一線】
//   1. 起動シーケンス全体(デモseed → 復元 → 送信キュー再送)で、
//      select=id + key=eq.stamp:* が部屋数に比例して出ないこと。
//   2. それでも【最終保存内容が修正前と1バイトも変わらない】こと(updated_at を除く)。
//      期待値はベタ書きせず、修正前の putMany をこのファイル内へ独立に書き起こした
//      参照実装と突き合わせる。「期待値を新実装に合わせたから通った」は原理的に起こらない。
//   3. 旧キー(fireflow-stamp:*)の扱い・outbox・propertyId・別物件混入に差分0であること。
//
// 既存の public/test/*.js と同じく、index.html / stamp_store.js の実ソースを文字列で取り出して
// Node.js の vm で実行する(製品コードは一切書き換えない。テスト用の写経もしない)。
'use strict';
var fs = require('fs');
var path = require('path');
var vm = require('vm');

var results = [];
function check(label, cond, detail) {
  results.push({ label: label, ok: !!cond });
  console.log((cond ? 'OK' : 'NG') + ': ' + label + (detail !== undefined ? ' (' + JSON.stringify(detail) + ')' : ''));
}

var ROOT = path.join(__dirname, '..');
var html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
var storeSrc = fs.readFileSync(path.join(ROOT, 'stamp_store', 'stamp_store.js'), 'utf8');
var sbSrc = fs.readFileSync(path.join(ROOT, 'supabase-integration.js'), 'utf8');

var PID_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
var PID_B = 'bbbbbbbb-2222-4222-9222-bbbbbbbbbbbb';
var PROP_A = 'コスモ六甲ガーデンフォート';   // 実端末で実測した物件名
var PROP_B = 'コスモ城東野江ロイヤルフォルム';

/* ================================================================
   製品ソースの抽出
   ================================================================ */
function extractFunctionSource(src, name) {
  var marker = 'function ' + name + '(';
  var startIdx = src.indexOf(marker);
  if (startIdx === -1) throw new Error('MISSING IMPLEMENTATION SOURCE: function ' + name);
  var i = src.indexOf('{', startIdx);
  var depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  if (depth !== 0) throw new Error('関数 ' + name + ' の波括弧の対応が取れませんでした');
  if (src.slice(Math.max(0, startIdx - 6), startIdx) === 'async ') startIdx -= 6;
  return src.slice(startIdx, i);
}
function extractVarDeclSource(src, name) {
  var marker = 'var ' + name + ' = ';
  var startIdx = src.indexOf(marker);
  if (startIdx === -1) throw new Error('MISSING IMPLEMENTATION SOURCE: var ' + name);
  return src.slice(startIdx, src.indexOf(';', startIdx) + 1);
}
function stripComments(src) {
  return String(src).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
function extractStampStoreWiring() {
  var marker = 'window.FireFlowStampStore.createStampStore(';
  var markerIdx = html.indexOf(marker);
  if (markerIdx === -1) throw new Error('MISSING: createStampStore の結線');
  var objStart = html.indexOf('{', markerIdx);
  var i = objStart, depth = 0;
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') {
      depth--;
      if (depth === 0) {
        return 'var stampStore = window.FireFlowStampStore.createStampStore('
          + html.slice(objStart, i + 1) + ');';
      }
    }
  }
  throw new Error('unbalanced braces: createStampStore wiring');
}

var PRODUCT_SRC = [
  extractVarDeclSource(html, 'PROPERTY_SCOPE_ENABLED'),
  extractVarDeclSource(html, 'PROPERTY_SCOPED_KEY_PREFIXES'),
  extractVarDeclSource(html, 'PROPERTY_SCOPED_EXACT_KEYS'),
  extractFunctionSource(html, 'isPropertyScopedKey'),
  extractFunctionSource(html, 'propertyScopedKey'),
  extractFunctionSource(html, 'propertyUnscopedKey'),
  extractFunctionSource(html, 'isValidScopePropertyId'),
  extractFunctionSource(html, 'currentScopePropertyId'),
  extractFunctionSource(html, 'applyPropertyScope'),
  extractFunctionSource(html, 'lcCacheKey'),
  extractVarDeclSource(html, 'warnedUnknownPropertyOutbox'),
  extractFunctionSource(html, 'storageSet'),
  extractFunctionSource(html, 'storageGet'),
  extractFunctionSource(html, 'storageDelete'),
  extractFunctionSource(html, 'storageList'),
  extractFunctionSource(html, 'storageListValues'),
  extractFunctionSource(html, 'readValueFromLocalCache'),
  extractFunctionSource(html, 'readRoomValuesBulk'),
  extractFunctionSource(html, 'listKeysLocalFirst'),
  extractFunctionSource(html, 'flushOutbox'),
].join('\n\n');

// 実 index.html のデモ予定情報(129室)と、実 seedDemoState()。写経しない。
var STAMP_DATA_SRC = extractVarDeclSource(html, 'STAMP_DATA');
var SEED_DEMO_SRC = extractFunctionSource(html, 'seedDemoState');

/* ================================================================
   観測可能なフェイク環境
   ----------------------------------------------------------------
   fakeStorage は supabase-integration.js の window.storage と同じ絞り込み規則で動き、
   さらに「実際に飛ぶ PostgREST リクエストの形」を1件ずつ記録する。実ブラウザのNetworkタブで
   数えられるのと同じ粒度で数えるためで、ここを甘く作ると「関数呼び出しは減ったが通信は
   減っていない」を見逃す。
   ================================================================ */
function makeEnv(options) {
  options = options || {};
  var idb = { cache: {}, outbox: {} };
  var remoteRows = [];
  var requests = [];
  var state = {
    currentPropertyId: options.currentPropertyId !== undefined ? options.currentPropertyId : PID_A,
    // 'ok' … 正常 / 'throw' … 通信断 / 'null' … 失敗を戻り値で伝える(kv_store 500相当)
    remoteMode: options.remoteMode || 'ok',
    onLine: options.onLine === undefined ? true : !!options.onLine,
    propertyKey: options.propertyKey || PROP_A,
  };

  function record(m, q) { requests.push(m + ' ' + q); }
  function targetPid(propertyId) { return propertyId || state.currentPropertyId; }
  function ownerFilter(shared) { return shared ? 'owner_id=is.null' : 'owner_id=eq.me'; }
  function findRow(pid, key, shared) {
    for (var i = 0; i < remoteRows.length; i++) {
      var r = remoteRows[i];
      if (r.property_id === pid && r.key === key && r.shared === !!shared) return r;
    }
    return null;
  }
  function failOrNull() {
    if (state.remoteMode === 'throw') throw new Error('remote failed');
    return null;   // window.storage.set が null を返す = 保存できていない
  }

  var fakeStorage = {
    get: async function (key, shared, propertyId) {
      var pid = targetPid(propertyId);
      record('GET', 'select=value&property_id=eq.' + pid + '&key=eq.' + key
        + '&shared=eq.' + !!shared + '&' + ownerFilter(shared));
      if (state.remoteMode !== 'ok') throw new Error('remote get failed');
      var row = findRow(pid, key, shared);
      if (!row) throw new Error('key not found: ' + key);
      return { key: key, value: row.value, shared: !!shared };
    },
    set: async function (key, value, shared, propertyId) {
      var pid = targetPid(propertyId);
      /* window.storage.set の第1リクエスト = 既存行検索。実ブラウザで観測されたURLはこれ。 */
      record('GET', 'select=id&property_id=eq.' + pid + '&key=eq.' + key
        + '&shared=eq.' + !!shared + '&' + ownerFilter(shared));
      if (state.remoteMode !== 'ok') return failOrNull();
      var row = findRow(pid, key, shared);
      if (row) { record('PATCH', 'id=eq.' + row.id); row.value = String(value); }
      else {
        record('POST', 'kv_store');
        remoteRows.push({ id: 'row' + (remoteRows.length + 1), property_id: pid, key: key,
          value: String(value), shared: !!shared });
      }
      return { key: key, value: value, shared: !!shared };
    },
    delete: async function (key, shared, propertyId) {
      var pid = targetPid(propertyId);
      record('DELETE', 'property_id=eq.' + pid + '&key=eq.' + key
        + '&shared=eq.' + !!shared + '&' + ownerFilter(shared));
      if (state.remoteMode !== 'ok') return failOrNull();
      remoteRows = remoteRows.filter(function (r) {
        return !(r.property_id === pid && r.key === key && r.shared === !!shared);
      });
      return { key: key, deleted: true, shared: !!shared };
    },
    list: async function (prefix, shared, propertyId) {
      var pid = targetPid(propertyId);
      record('GET', 'select=key&property_id=eq.' + pid + '&key=like.' + prefix + '%'
        + '&shared=eq.' + !!shared + '&' + ownerFilter(shared));
      if (state.remoteMode !== 'ok') return null;
      return {
        keys: remoteRows.filter(function (r) {
          return r.property_id === pid && r.shared === !!shared && r.key.indexOf(prefix) === 0;
        }).map(function (r) { return r.key; }), prefix: prefix, shared: !!shared,
      };
    },
    listValues: async function (prefix, shared, propertyId) {
      var pid = targetPid(propertyId);
      record('GET', 'select=key,value&property_id=eq.' + pid + '&key=like.' + prefix + '%'
        + '&shared=eq.' + !!shared + '&' + ownerFilter(shared));
      if (state.remoteMode !== 'ok') throw new Error('remote listValues failed');
      return {
        items: remoteRows.filter(function (r) {
          return r.property_id === pid && r.shared === !!shared && r.key.indexOf(prefix) === 0;
        }).map(function (r) { return { key: r.key, value: r.value }; }), prefix: prefix, shared: !!shared,
      };
    },
  };
  if (options.noListValues) delete fakeStorage.listValues;

  var ctx = {
    JSON: JSON, Object: Object, Array: Array, String: String, Number: Number, Boolean: Boolean,
    Promise: Promise, Date: Date, Error: Error, setTimeout: setTimeout, clearTimeout: clearTimeout,
    setInterval: function () { return 1; }, clearInterval: function () {},
    console: { log: function () {}, warn: function () {}, error: function () {} },
    navigator: { get onLine() { return state.onLine; } },
    document: { addEventListener: function () {} },
    window: {
      storage: fakeStorage,
      getCurrentPropertyId: function () { return state.currentPropertyId; },
      isValidPropertyId: function (v) {
        return typeof v === 'string' && v.length === 36 &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
      },
      FIREFLOW_PROPERTY_SCOPE_ENABLED: options.scopeEnabled === true,
      addEventListener: function () {},
    },
    lcPut: async function (s, r) { idb[s][r.key] = r; },
    lcGet: async function (s, k) { return idb[s][k] || null; },
    lcDelete: async function (s, k) { delete idb[s][k]; },
    lcGetAll: async function (s) { return Object.keys(idb[s]).map(function (k) { return idb[s][k]; }); },
    updateSyncBadge: function () {},
    scheduleOutboxRetry: function () {},
    showSyncCompleteBriefly: function () {},
    isSyncingNow: false,
    outboxRetryTimer: null,
    // seedDemoState() が触る周辺(点検状況のseed。予定情報の通信とは無関係なので空で足りる)
    SEED_STATE_RAW: {}, SEED_SIG_URI: '', SEED_PHOTO_URI: '', state: {},
    syncStampDataFromStore: function () {},
    currentPropertyScopeKey: function () { return state.propertyKey; },
  };
  ctx.window.window = ctx.window;
  vm.createContext(ctx);
  vm.runInContext(storeSrc, ctx);                    // ブラウザと同じ stamp_store.js
  vm.runInContext(PRODUCT_SRC, ctx);                 // index.html の保存層(実ソース)
  vm.runInContext(extractStampStoreWiring(), ctx);   // 実LBと同じアダプタ結線
  vm.runInContext(STAMP_DATA_SRC, ctx);              // 実 index.html のデモ予定情報129室
  ctx.knownRoomNumbersFromFloors = function () {
    return options.knownRooms ? options.knownRooms.slice() : Object.keys(ctx.STAMP_DATA);
  };
  vm.runInContext(SEED_DEMO_SRC, ctx);               // 実 seedDemoState()

  return {
    ctx: ctx, idb: idb, state: state, requests: requests,
    store: ctx.stampStore,
    demoRooms: Object.keys(ctx.STAMP_DATA),
    rows: function () { return remoteRows; },
    rowsFor: function (pid) { return remoteRows.filter(function (r) { return r.property_id === pid; }); },
    outboxItems: function () { return Object.keys(idb.outbox).map(function (k) { return idb.outbox[k]; }); },
    putRemote: function (key, value, pid) {
      remoteRows.push({ id: 'seed' + (remoteRows.length + 1), property_id: pid || PID_A,
        key: key, value: value, shared: true });
    },
    putCache: function (rawKey, value) {
      idb.cache['shared:' + rawKey] = { key: 'shared:' + rawKey, value: value, updatedAt: 1 };
    },
    clearRequests: function () { requests.length = 0; },
    // 実ブラウザで観測された storm の形そのものを数える
    stampSelectIdCount: function () {
      return requests.filter(function (r) {
        return r.indexOf('GET select=id&') === 0 && r.indexOf('&key=eq.stamp:') !== -1;
      }).length;
    },
    selectIdCount: function () {
      return requests.filter(function (r) { return r.indexOf('GET select=id&') === 0; }).length;
    },
    singleKeyGetCount: function () {
      return requests.filter(function (r) { return r.indexOf('GET select=value&') === 0; }).length;
    },
  };
}

function settle(ms) { return new Promise(function (r) { setTimeout(r, ms === undefined ? 60 : ms); }); }

/* 実LBの起動シーケンスに近い形。「デモを開く」→ 予定情報の復元 → 5秒ごとの再送を3回。
   実ブラウザで「Network履歴を削除して数秒放置」したときに起きることと同じ範囲を通す。 */
async function runStartupSequence(e, opts) {
  opts = opts || {};
  e.ctx.seedDemoState();
  await settle();
  if (!opts.skipReload) {
    await e.store.loadAll({ knownRooms: e.ctx.knownRoomNumbersFromFloors() });
  }
  for (var tick = 0; tick < (opts.flushTicks === undefined ? 3 : opts.flushTicks); tick++) {
    await e.ctx.flushOutbox();
  }
  await settle();
}

/* ================================================================
   参照実装: 修正前の putMany(受理した分を必ず1件ずつ保存先へ書く)。
   最終保存内容の突き合わせ相手。ここは実装から独立して書き起こしてある。
   ================================================================ */
function referenceOldPutMany(e, inputs, knownRooms, source) {
  var SS = e.ctx.window.FireFlowStampStore;
  var scope = SS.normalizePropertyKey(e.state.propertyKey);
  var now = new Date().toISOString();
  var known = {};
  (knownRooms || []).forEach(function (r) { known[String(r).trim()] = true; });
  var writes = [];
  var saved = [];
  (inputs || []).forEach(function (input) {
    var record = SS.buildRecord(input, { propertyKey: scope, now: now, source: source });
    if (!record.room) return;
    if (knownRooms && !known[record.room]) return;
    saved.push(record.room);
    writes.push(e.ctx.storageSet('stamp:' + scope + ':' + record.room, JSON.stringify(record), true)
      .catch(function () {}));
  });
  return Promise.all(writes).then(function () { return { saved: saved }; });
}
/* 修正前の seedDemoState() の書き込み部分(参照実装側) */
function referenceOldSeedDemo(e) {
  var SS = e.ctx.window.FireFlowStampStore;
  var demoSeed = e.ctx.STAMP_DATA;
  return referenceOldPutMany(e, Object.keys(demoSeed).map(function (room) {
    return SS.fromLegacyEntry(room, demoSeed[room], { source: 'demo' });
  }), e.ctx.knownRoomNumbersFromFloors(), 'demo');
}

/* updated_at は「どちらが新しいか」を決めるためだけの項目で、業務上の値ではない。
   保存内容の一致はそれ以外の全項目で厳密に比べる。 */
function businessContent(jsonText) {
  var parsed = JSON.parse(jsonText);
  delete parsed.updated_at;
  return JSON.stringify(parsed, Object.keys(parsed).sort());
}
function rowsByKey(e, pid) {
  var out = {};
  e.rowsFor(pid || PID_A).forEach(function (r) { out[r.key] = r.value; });
  return out;
}

/* ================================================================
   N. 実測されたstormの形の再現と消滅
   ================================================================ */
async function testObservedStormShape() {
  console.log('\n==== N. 実測された storm の形(select=id + key=eq.stamp:*)の再現と消滅 ====');

  // 修正前(参照実装)は本当に部屋数ぶんの select=id を出していたのか
  var eOld = makeEnv();
  eOld.clearRequests();
  await referenceOldSeedDemo(eOld);
  check('N-1 修正前の実装は「デモを開く」1回で129件の select=id + key=eq.stamp:* を出す(storm再現)',
    eOld.stampSelectIdCount() === 129, eOld.stampSelectIdCount());
  check('N-1 実測されたURL(select=id&property_id&key=eq.stamp:' + PROP_A + ':113&shared&owner_id)が一致',
    eOld.requests.indexOf('GET select=id&property_id=eq.' + PID_A
      + '&key=eq.stamp:' + PROP_A + ':113&shared=eq.true&owner_id=is.null') !== -1);
  check('N-1 実測されたもう1室(102)も同じ形で出ていた',
    eOld.requests.indexOf('GET select=id&property_id=eq.' + PID_A
      + '&key=eq.stamp:' + PROP_A + ':102&shared=eq.true&owner_id=is.null') !== -1);
  // 2回目(= ページ再読込)も同じだけ出し続けていた
  eOld.clearRequests();
  await referenceOldSeedDemo(eOld);
  check('N-1 修正前は内容が同じでも再読込のたびに129件を送り直していた',
    eOld.stampSelectIdCount() === 129, eOld.stampSelectIdCount());

  // 修正後: 実端末と同じ「既に保存済み」の状態から起動する
  var e = makeEnv();
  e.ctx.seedDemoState();          // 1回目(初回だけは新規作成なので書き込みが要る)
  await settle();
  e.store.clearMemory();
  e.clearRequests();
  await runStartupSequence(e);    // 2回目 = 実端末での「localhost:3000を開いて数秒放置」
  check('N-2 修正後は再起動時の select=id + key=eq.stamp:* が0件',
    e.stampSelectIdCount() === 0, e.stampSelectIdCount());
  check('N-2 実測されたURL(113)が1件も出ない',
    e.requests.every(function (r) { return r.indexOf('&key=eq.stamp:' + PROP_A + ':113') === -1; }));
  check('N-2 起動シーケンス全体の通信が数リクエストに収まる(部屋数比例でない)',
    e.requests.length <= 6, { count: e.requests.length, requests: e.requests });
}

/* ================================================================
   A / B / 12. 部屋数に比例しない
   ================================================================ */
async function testRequestCountNotProportional() {
  console.log('\n==== A/B/12. 129室 / 259室でも select=id が件数比例で飛ばない ====');

  async function measure(n) {
    var rooms = [];
    for (var floor = 1; rooms.length < n; floor++) {
      for (var i = 1; i <= 10 && rooms.length < n; i++) rooms.push(String(floor * 100 + i));
    }
    var e = makeEnv({ knownRooms: rooms });
    // 既に保存済みの実端末と同じ状態を作る(1回putManyしてから再起動)
    await e.store.putMany(rooms.map(function (r) {
      return { room: r, symbol: 'A', time_start: '09:30', note: '朝一' + r };
    }), { knownRooms: rooms, source: 'standardized_stamp_sheet' });
    e.store.clearMemory();
    e.clearRequests();
    // 同じ内容をもう一度入れ直す(起動のたびに起きていたこと)
    await e.store.putMany(rooms.map(function (r) {
      return { room: r, symbol: 'A', time_start: '09:30', note: '朝一' + r };
    }), { knownRooms: rooms, source: 'standardized_stamp_sheet' });
    await e.store.loadAll({ knownRooms: rooms });
    for (var t = 0; t < 3; t++) await e.ctx.flushOutbox();
    return e;
  }

  var e129 = await measure(129);
  check('A. 129室で select=id + key=eq.stamp:* が129回にならない',
    e129.stampSelectIdCount() < 129, e129.stampSelectIdCount());
  check('A. 129室で select=id + key=eq.stamp:* が0件', e129.stampSelectIdCount() === 0, e129.stampSelectIdCount());

  var e259 = await measure(259);
  check('B. 259室で select=id + key=eq.stamp:* が259回にならない',
    e259.stampSelectIdCount() < 259, e259.stampSelectIdCount());
  check('B. 259室で select=id + key=eq.stamp:* が0件', e259.stampSelectIdCount() === 0, e259.stampSelectIdCount());
  check('12. 部屋数が倍でも通信回数が増えない(部屋数に比例しない)',
    e259.requests.length === e129.requests.length,
    { rooms129: e129.requests.length, rooms259: e259.requests.length });

  // C. 復元(loadAll)のあとに、別経路から1件ずつの存在確認が発生しない
  check('C. loadAll後に1件ずつの存在確認(select=id)も1件取得(select=value)も発生しない',
    e259.stampSelectIdCount() === 0 && e259.singleKeyGetCount() === 0,
    { selectId: e259.stampSelectIdCount(), singleGet: e259.singleKeyGetCount() });
}

/* ================================================================
   E. 最終保存内容が修正前と一致
   ================================================================ */
async function testSavedContentIdentical() {
  console.log('\n==== E/8. 最終保存内容が修正前の実装と一致(updated_at以外は1バイトも同じ) ====');

  // 修正前: 2回とも全件書き込む / 修正後: 2回目は送らない。最終保存内容は同じでなければならない。
  var eOld = makeEnv();
  await referenceOldSeedDemo(eOld);
  await referenceOldSeedDemo(eOld);
  var eNew = makeEnv();
  eNew.ctx.seedDemoState(); await settle();
  eNew.ctx.seedDemoState(); await settle();

  var oldRows = rowsByKey(eOld), newRows = rowsByKey(eNew);
  var oldKeys = Object.keys(oldRows).sort(), newKeys = Object.keys(newRows).sort();
  check('E. 保存されたキーの集合が完全一致(129室)',
    oldKeys.length === 129 && oldKeys.join(',') === newKeys.join(','),
    { old: oldKeys.length, now: newKeys.length });
  var diff = oldKeys.filter(function (k) { return businessContent(oldRows[k]) !== businessContent(newRows[k]); });
  check('E. 記号・時刻・備考・チェック・要確認・sourceまで含めて保存内容の差分0', diff.length === 0, diff.slice(0, 3));
  check('E. 実測された113号室の保存内容が一致(10:30)',
    businessContent(oldRows['stamp:' + PROP_A + ':113']) === businessContent(newRows['stamp:' + PROP_A + ':113'])
    && JSON.parse(newRows['stamp:' + PROP_A + ':113']).time_start === '10:30',
    JSON.parse(newRows['stamp:' + PROP_A + ':113']).time_start);
  check('E. 実測された102号室の保存内容が一致(14:30)',
    JSON.parse(newRows['stamp:' + PROP_A + ':102']).time_start === '14:30',
    JSON.parse(newRows['stamp:' + PROP_A + ':102']).time_start);
  check('E. キャンセル記号の部屋もそのまま保存される(保存判定を雑にしていない)',
    JSON.parse(newRows['stamp:' + PROP_A + ':712']).symbol === 'キャンセル',
    JSON.parse(newRows['stamp:' + PROP_A + ':712']).symbol);
  check('E. updated_at は保存内容として引き続き持っている(空にしていない)',
    !!JSON.parse(newRows['stamp:' + PROP_A + ':113']).updated_at);

  // 内容が1つでも変われば、必ず送る(通信削減のために保存を落とさない)
  var e = makeEnv();
  e.ctx.seedDemoState(); await settle();
  e.clearRequests();
  await e.store.putMany([{ room: '113', symbol: '', time_start: '16:45', source: 'manual' }],
    { knownRooms: e.demoRooms, source: 'manual' });
  check('8. 1項目でも変わった部屋は必ず保存先へ送る', e.stampSelectIdCount() === 1, e.stampSelectIdCount());
  check('8. 変わった値が保存先に反映される(16:45)',
    JSON.parse(rowsByKey(e)['stamp:' + PROP_A + ':113']).time_start === '16:45',
    JSON.parse(rowsByKey(e)['stamp:' + PROP_A + ':113']).time_start);
  check('8. 変わっていない他の部屋は送らない(1室ぶんだけ)', e.stampSelectIdCount() === 1);

  // 保存先から値が消えていたら、必ず作り直す(送らない判定が「取りこぼし」にならない)
  var e2 = makeEnv();
  e2.ctx.seedDemoState(); await settle();
  var rows = e2.rows();
  for (var i = rows.length - 1; i >= 0; i--) {
    if (rows[i].key === 'stamp:' + PROP_A + ':113') rows.splice(i, 1);
  }
  delete e2.idb.cache['shared:stamp:' + PROP_A + ':113'];
  e2.store.clearMemory();
  e2.clearRequests();
  e2.ctx.seedDemoState(); await settle();
  check('8. 保存先から消えていた部屋は作り直される(取りこぼさない)',
    !!rowsByKey(e2)['stamp:' + PROP_A + ':113'] && e2.stampSelectIdCount() === 1,
    e2.stampSelectIdCount());
}

/* ================================================================
   D / G. 旧キー(fireflow-stamp:*)の扱いに差分0
   ================================================================ */
async function testLegacyUnchanged() {
  console.log('\n==== D/G/9. 旧キー(fireflow-stamp:*)の扱いに差分0 ====');
  var rooms = ['101', '102', '103'];

  var e = makeEnv({ knownRooms: rooms, propertyKey: PROP_A });
  rooms.forEach(function (r) { e.putRemote('fireflow-stamp:' + r, JSON.stringify({ symbol: 'X', time: '08:00' })); });
  e.putRemote('fireflow-stamp:9999', JSON.stringify({ symbol: 'Z' }));
  e.store.setPropertyKey(PROP_A);
  var loaded = await e.store.loadAll({ knownRooms: rooms });
  check('G. 現スコープ0件のときだけ旧キーを取り込む条件は従来のまま',
    loaded.migrated.slice().sort().join(',') === '101,102,103', loaded.migrated);
  check('G. MASTERに無い部屋は旧キーからも取り込まない', e.store.get('9999') === null);
  check('G. 取り込んだ値の中身も従来どおり(source=migrated_legacy)',
    e.store.get('101') && e.store.get('101').symbol === 'X'
    && e.store.get('101').time_start === '08:00'
    && e.store.get('101').source === 'migrated_legacy', e.store.get('101'));
  check('9. 旧キーは削除しない(元データを失わない)',
    e.rows().some(function (r) { return r.key === 'fireflow-stamp:101'; }));
  check('9. 旧キーへ propertyId を勝手に付けない',
    e.rows().filter(function (r) { return r.key.indexOf('fireflow-stamp:') === 0; })
      .every(function (r) { return r.key.indexOf(PID_A) === -1; }));

  // D. 旧キー経路でも読み取りが N+1 にならない(1件ずつ取得へ戻っていない)
  var many = [];
  for (var f = 1; many.length < 129; f++) for (var i = 1; i <= 10 && many.length < 129; i++) many.push(String(f * 100 + i));
  var e2 = makeEnv({ knownRooms: many, propertyKey: PROP_A });
  many.forEach(function (r) { e2.putRemote('fireflow-stamp:' + r, JSON.stringify({ symbol: 'X', time: '08:00' })); });
  e2.store.setPropertyKey(PROP_A);
  e2.clearRequests();
  var loaded2 = await e2.store.loadAll({ knownRooms: many });
  check('D. migrateLegacyKeys経路でも1件ずつの取得(select=value)は0回',
    e2.singleKeyGetCount() === 0, e2.singleKeyGetCount());
  check('D. 取り込む部屋数は従来と同じ129室(自動割当を増やしていない)',
    loaded2.migrated.length === 129, loaded2.migrated.length);

  // 現スコープに1件でも在れば取り込まない(自動割当を広げていない)
  var e3 = makeEnv({ knownRooms: rooms, propertyKey: PROP_A });
  e3.putRemote('stamp:' + PROP_A + ':101', JSON.stringify({ schema_version: 1, room: '101', symbol: 'A' }));
  rooms.forEach(function (r) { e3.putRemote('fireflow-stamp:' + r, JSON.stringify({ symbol: 'X' })); });
  e3.store.setPropertyKey(PROP_A);
  var loaded3 = await e3.store.loadAll({ knownRooms: rooms });
  check('G. 現物件に1件でも在れば旧キーを取り込まない(従来どおり)',
    loaded3.migrated.length === 0 && e3.store.get('102') === null, loaded3.migrated);
}

/* ================================================================
   F / K. 別物件の混入0 / propertyId自動付与0
   ================================================================ */
async function testPropertyIsolation() {
  console.log('\n==== F/K. 別物件stamp混入0 / propertyId自動付与0 ====');
  var e = makeEnv();
  e.ctx.seedDemoState(); await settle();
  // 同じ部屋番号を持つ別物件のデータを保存先へ置く
  e.demoRooms.forEach(function (r) {
    e.putRemote('stamp:' + PROP_B + ':' + r, JSON.stringify({ schema_version: 1, room: r, symbol: 'B' }));
  });
  e.store.clearMemory();
  e.clearRequests();
  e.ctx.seedDemoState(); await settle();
  check('F. 別物件(' + PROP_B + ')のstampが1件も現物件へ混入しない',
    Object.keys(e.store.all()).every(function (r) { return e.store.get(r).symbol !== 'B'; }));
  check('F. 別物件のstampへ書き込みが発生しない',
    e.requests.every(function (r) { return r.indexOf('key=eq.stamp:' + PROP_B) === -1; }));
  check('F. 別物件の行が書き換わっていない',
    e.rows().filter(function (r) { return r.key.indexOf('stamp:' + PROP_B) === 0; })
      .every(function (r) { return JSON.parse(r.value).symbol === 'B'; }));

  // K. property scope ON でも stampキーへ propertyId を自動付与しない
  var e2 = makeEnv({ scopeEnabled: true });
  e2.ctx.seedDemoState(); await settle();
  check('K. property scope ON でも stampキーへ propertyId が自動付与されない',
    e2.rows().every(function (r) { return r.key.indexOf(PID_A) === -1; }),
    e2.rows().slice(0, 2).map(function (r) { return r.key; }));
  check('K. 保存キーは従来どおり stamp:<物件名>:<部屋>',
    !!rowsByKey(e2)['stamp:' + PROP_A + ':113']);
}

/* ================================================================
   H / I. remote error / offline
   ================================================================ */
async function testOfflineAndRemoteError() {
  console.log('\n==== H/I/10. remote error・offline でも保存・復元結果を壊さない ====');

  // H. 一度保存できたあと remote 500 になっても、同じ内容の再送でstormを起こさない
  var e = makeEnv();
  e.ctx.seedDemoState(); await settle();
  var before = rowsByKey(e);
  e.state.remoteMode = 'null';       // kv_store 500
  e.store.clearMemory();
  e.clearRequests();
  await runStartupSequence(e);
  check('H. 保存済み + remote 500 でも select=id + key=eq.stamp:* が0件',
    e.stampSelectIdCount() === 0, e.stampSelectIdCount());
  check('H. その状態でもローカル(IndexedDB)から129室すべて復元できる',
    Object.keys(e.store.all()).length === 129, Object.keys(e.store.all()).length);
  check('H. remote error 時に1件ずつのリモート再取得へfallbackしない',
    e.singleKeyGetCount() === 0, e.singleKeyGetCount());
  check('10. 保存先の内容は1件も書き換わっていない',
    JSON.stringify(rowsByKey(e)) === JSON.stringify(before));

  // I. 完全オフライン(通信断)でも同じ
  var e2 = makeEnv();
  e2.ctx.seedDemoState(); await settle();
  e2.state.remoteMode = 'throw';
  e2.state.onLine = false;
  e2.store.clearMemory();
  e2.clearRequests();
  await runStartupSequence(e2);
  check('I. オフラインでも select=id + key=eq.stamp:* が0件', e2.stampSelectIdCount() === 0, e2.stampSelectIdCount());
  check('I. オフラインでも129室すべて復元できる(空にならない)',
    Object.keys(e2.store.all()).length === 129, Object.keys(e2.store.all()).length);
  check('I. オフラインでの復元値が正しい(113 = 10:30)',
    e2.store.get('113') && e2.store.get('113').time_start === '10:30', e2.store.get('113'));

  // 初回起動がオフラインだった場合は、従来どおり全件を送信キューへ積む(取りこぼさない)
  var e3 = makeEnv({ remoteMode: 'null' });
  e3.ctx.seedDemoState(); await settle();
  check('10. 未保存のままオフラインなら従来どおり全件を送信キューへ積む(データを捨てない)',
    e3.outboxItems().length === 129, e3.outboxItems().length);
}

/* ================================================================
   J. outbox に差分0(Phase 1E-0 を壊さない)
   ================================================================ */
async function testOutboxUntouched() {
  console.log('\n==== J/11. outbox仕様に差分0(Phase 1E-0を壊さない) ====');

  // 送信先物件が不明な旧itemは、送信0・削除0・書換0のまま
  var e = makeEnv();
  e.idb.outbox['shared:stamp:' + PROP_A + ':999'] = {
    key: 'shared:stamp:' + PROP_A + ':999', rawKey: 'stamp:' + PROP_A + ':999',
    value: '{"legacy":true}', shared: true, deleted: false, propertyId: null,
    alreadyScoped: true, updatedAt: 1,
  };
  var beforeOutbox = JSON.stringify(e.idb.outbox);
  e.ctx.seedDemoState(); await settle();
  e.clearRequests();
  await e.ctx.flushOutbox();
  var held = e.outboxItems().filter(function (it) { return it.propertyId === null; });
  check('11. propertyId無しの旧outboxは送信0(リクエストが1件も出ない)',
    e.requests.every(function (r) { return r.indexOf(':999') === -1; }));
  check('11. propertyId無しの旧outboxは削除0・書換0',
    held.length === 1 && JSON.stringify(held[0]) === JSON.stringify(JSON.parse(beforeOutbox)['shared:stamp:' + PROP_A + ':999']));

  // 同じ内容の再seedでは、そもそも送信キューが増えない
  var e2 = makeEnv({ remoteMode: 'null' });
  e2.ctx.seedDemoState(); await settle();
  var outboxAfterFirst = e2.outboxItems().length;
  e2.store.clearMemory();
  e2.ctx.seedDemoState(); await settle();
  check('J. 同じ内容の再seedで送信キューが増えない(stormの燃料を足さない)',
    e2.outboxItems().length === outboxAfterFirst, { before: outboxAfterFirst, after: e2.outboxItems().length });
}

/* ================================================================
   退行検知(ソース検査)
   ================================================================ */
function sliceStoreFunction(name) {
  var marker = 'function ' + name + '(';
  var startIdx = storeSrc.indexOf(marker);
  if (startIdx === -1) throw new Error('MISSING IMPLEMENTATION SOURCE: stamp_store.js ' + name);
  var i = storeSrc.indexOf('{', startIdx);
  var depth = 0;
  for (; i < storeSrc.length; i++) {
    if (storeSrc[i] === '{') depth++;
    else if (storeSrc[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return storeSrc.slice(startIdx, i);
}

function testSourceGuards() {
  console.log('\n==== 退行検知: 保存側が1件ずつのremote existence checkへ戻っていないこと ====');
  var writeSrc = stripComments(sliceStoreFunction('writeRecords'));
  var putManySrc = stripComments(sliceStoreFunction('putMany'));

  check('putMany はメモリへの反映を同期のまま行う(描画が1拍遅れない)',
    putManySrc.indexOf('records[record.room] = record;') !== -1);
  check('保存側は一括取得(readRecordsFor)を1回だけ使う',
    writeSrc.indexOf('readRecordsFor(') !== -1
    && writeSrc.split('readRecordsFor(').length - 1 === 1);
  check('保存側は1件ずつの取得(readRecord / adapters.get)へ落ちない',
    writeSrc.indexOf('readRecord(') === -1 && writeSrc.indexOf('adapters.get(') === -1);
  check('getMany を持たないアダプタでは従来どおり全件書き込む(比較のために通信を増やさない)',
    writeSrc.indexOf("typeof adapters.getMany !== 'function'") !== -1);
  check('送らない判定は updated_at 以外の全項目の完全一致(保存判定を雑にしていない)',
    writeSrc.indexOf('contentWithoutUpdatedAt(stored) === contentWithoutUpdatedAt(') !== -1);
  check('保存先の updated_at をメモリの正本へ揃えている(他者の更新を取りこぼさない)',
    writeSrc.indexOf('p.record.updated_at = stored.updated_at') !== -1);
  check('StampStoreの保存キーの形式は従来のまま(stamp: / fireflow-stamp:)',
    storeSrc.indexOf("var KEY_PREFIX = 'stamp:';") !== -1
    && storeSrc.indexOf("var LEGACY_KEY_PREFIX = 'fireflow-stamp:';") !== -1);
  check('新しい保存層・アダプタを増やしていない(list/get/getMany/set/remove のみ)',
    stripComments(extractStampStoreWiring()).indexOf('adapters:') !== -1
    && ['list:', 'get:', 'getMany:', 'set:', 'remove:'].every(function (k) {
      return stripComments(extractStampStoreWiring()).indexOf(k) !== -1;
    }));

  // 実ブラウザで観測されたURLの並び順を作るのは window.storage.set の既存行検索だけ、という前提を固定する
  var setSrc = stripComments(extractFunctionSource(sbSrc, 'installStorageShim'));
  var order = ["select('id')", "eq('property_id', currentPropertyId)", "eq('key', key)", "eq('shared'"];
  var pos = -1, ordered = true;
  order.forEach(function (token) {
    var at = setSrc.indexOf(token, pos + 1);
    if (at === -1 || at < pos) ordered = false;
    pos = at;
  });
  check('window.storage.set の既存行検索の並びが実測URL(select,property_id,key,shared,owner_id)と一致',
    ordered);
}

async function main() {
  await testObservedStormShape();
  await testRequestCountNotProportional();
  await testSavedContentIdentical();
  await testLegacyUnchanged();
  await testPropertyIsolation();
  await testOfflineAndRemoteError();
  await testOutboxUntouched();
  testSourceGuards();

  var passed = results.filter(function (r) { return r.ok; }).length;
  var failed = results.length - passed;
  console.log('\n==== stampstore_seed_storm_fix_verify 総合結果: ' + (failed === 0 ? 'PASS' : 'FAIL')
    + ' (' + passed + '/' + results.length + ') ====');
  if (failed > 0) {
    results.filter(function (r) { return !r.ok; }).forEach(function (r) { console.log('  NG: ' + r.label); });
    process.exit(1);
  }
}

main().catch(function (err) {
  console.error('テストの実行自体が失敗しました:', err);
  process.exit(1);
});
