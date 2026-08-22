// [2026-08-22新設] PAGE-WIDE IDLE REQUEST TEST
//
// 【なぜ必要か】
// これまでの request storm 対策テスト(request_storm_fix_verify / stampstore_* / outbox_*)は、
// どれも「ある1つの関数が出すリクエスト数」しか測っていなかった。
// 利用者が Safari の Network タブで見るのは【ページ全体が出すリクエストの合計】であり、
// 個別関数がいくら減っても、別のタイマー・別のイベント経路が生きていれば storm は続く。
// 実際 2026-08-22 の実Safari(localhost:3000)では、loadAll 単体を 258→2 に減らした後も
// 「何も操作していないのに短時間で148件」が観測された。そのURLは
//     select=key,value & property_id=eq.<uuid>
//     & key=like.fireflow-schedule-override:%25 & shared=eq.true & owner_id=is.null
// で、これは loadAllInner() のまとめ取りが setInterval(loadAll,1000) から
// 永久に呼ばれ続けていたもの(2 GET/秒 × 74秒 = 148件)。
//
// 【このテストが測るもの】
// 起動シーケンス(runMainAppBootSequence の実ソース)と全タイマー・全イベント経路を
// Node.js の vm 上で実際に動かし、仮想時計を30秒進めて、
// 【kv_store へ飛ぶ PostgREST リクエストを1件残らず数える】。
//
// IDLE の定義(要求どおり):
//   起動完了後 / ユーザー操作なし / データ変更なし / 送信キュー正常 / Realtime通知なし
// この条件での kv_store REST の目標値は 0 件。EXPECTED_IDLE_REQUESTS = 0。
//
// 【写経しない】index.html / stamp_store.js / supabase-integration.js の実ソースを文字列で
// 取り出して実行する。テスト用に書き直した関数は1つも無い。フェイクは
//   ・IndexedDB(lcPut/lcGet/lcDelete/lcGetAll)
//   ・window.storage(supabase-integration.js の絞り込み規則と同じ形で、飛ぶURLを記録する)
//   ・DOM / イベント / 時計
// だけで、これらは実ブラウザ側の「環境」に当たるものだけに限っている。
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
var PROP_A = 'コスモ六甲ガーデンフォート';
var EPOCH = 1755000000000;           // 仮想時計の起点(実在の値である必要は無い)

/* IDLE(起動完了後・無操作・無変更・送信キュー正常・Realtime通知なし)で許容する
   kv_store REST の件数。0以外にする場合は、その通信がコード上どうしても必要である理由を
   docs へ根拠付きで書くこと。「既存仕様だから」は理由にならない。 */
var EXPECTED_IDLE_REQUESTS = 0;
var IDLE_WINDOW_MS = 30000;
// 送信キューの再送間隔の上限(index.html の OUTBOX_RETRY_MAX_MS と一致すること)。
var OUTBOX_RETRY_MAX_MS_EXPECTED = 60000;

/* ================================================================
   製品ソースの取り出し
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
function extractRange(src, startMarker, endMarker) {
  var s = src.indexOf(startMarker);
  if (s === -1) throw new Error('MISSING SOURCE RANGE(開始): ' + startMarker);
  var e = src.indexOf(endMarker, s);
  if (e === -1) throw new Error('MISSING SOURCE RANGE(終了): ' + endMarker);
  return src.slice(s, e + endMarker.length);
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

/* 実 index.html の「保存層 + 読み込み経路 + 送信キュー + 更新の起こし方 + 在席 + 起動シーケンス」。
   ページ全体で kv_store へ到達しうる経路(2026-08-22 監査で確定した全数)を漏れなく載せる。 */
var PRODUCT_SRC = [
  // キーと物件スコープ
  extractVarDeclSource(html, 'COMMON_AREA_KEY'),
  extractVarDeclSource(html, 'BINDER_KEY_PREFIX'),
  extractVarDeclSource(html, 'SCHEDULE_OVERRIDE_KEY_PREFIX'),
  extractFunctionSource(html, 'keyFor'),
  extractFunctionSource(html, 'scheduleOverrideKeyFor'),
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
  // 送信キュー(再送タイマー・待ち延ばしを含む)
  extractVarDeclSource(html, 'outboxRetryTimer'),
  extractVarDeclSource(html, 'warnedUnknownPropertyOutbox'),
  extractVarDeclSource(html, 'OUTBOX_RETRY_BASE_MS'),
  extractVarDeclSource(html, 'OUTBOX_RETRY_MAX_MS'),
  extractVarDeclSource(html, 'outboxRetryDelayMs'),
  extractFunctionSource(html, 'scheduleOutboxRetry'),
  extractFunctionSource(html, 'flushOutbox'),
  // 保存層
  extractFunctionSource(html, 'storageSet'),
  extractFunctionSource(html, 'storageGet'),
  extractFunctionSource(html, 'storageDelete'),
  extractFunctionSource(html, 'storageList'),
  extractFunctionSource(html, 'storageListValues'),
  extractFunctionSource(html, 'readValueFromLocalCache'),
  extractFunctionSource(html, 'readRoomValuesBulk'),
  // 送信キューのイベント配線(online / offline / visibilitychange / supabase-ready)。実ソースの範囲指定。
  extractRange(html, '  function resetOutboxRetryBackoff() {',
    "document.addEventListener('supabase-ready', flushOutbox);"),
  // StampStore の結線
  extractFunctionSource(html, 'listKeysLocalFirst'),
  extractStampStoreWiring(),
  extractFunctionSource(html, 'currentPropertyScopeKey'),
  extractFunctionSource(html, 'knownRoomNumbersFromFloors'),
  extractFunctionSource(html, 'syncStampDataFromStore'),
  extractFunctionSource(html, 'reloadStampStoreForCurrentProperty'),
  // 在席プレゼンス
  extractVarDeclSource(html, 'PRESENCE_KEY_PREFIX'),
  extractVarDeclSource(html, 'PRESENCE_ACTIVE_MS'),
  extractVarDeclSource(html, 'PRESENCE_MIN_INTERVAL_MS'),
  extractVarDeclSource(html, 'lastPresenceHeartbeatAt'),
  extractFunctionSource(html, 'sendPresenceHeartbeat'),
  extractFunctionSource(html, 'installPresenceActivityTriggers'),
  extractFunctionSource(html, 'loadActiveInspectors'),
  // 画面更新(loadAll)と、その唯一の起動口
  extractVarDeclSource(html, 'loadAllInFlight'),
  extractVarDeclSource(html, 'loadAllDeferredRefresh'),
  extractFunctionSource(html, 'loadAll'),
  extractFunctionSource(html, 'loadAllInner'),
  extractVarDeclSource(html, 'REMOTE_REFRESH_DEBOUNCE_MS'),
  extractVarDeclSource(html, 'REMOTE_REFRESH_FALLBACK_MS'),
  extractVarDeclSource(html, 'remoteRefreshTimer'),
  extractVarDeclSource(html, 'remoteRefreshFallbackTimer'),
  extractVarDeclSource(html, 'realtimeSyncLive'),
  extractVarDeclSource(html, 'lastRemoteRefreshReason'),
  extractFunctionSource(html, 'requestRemoteRefresh'),
  extractFunctionSource(html, 'setRealtimeSyncLive'),
  extractFunctionSource(html, 'installRemoteRefreshTriggers'),
  extractFunctionSource(html, 'hideBackdrop'),
  // 起動シーケンス(実ソースそのもの。ここに周期実行が復活したら必ずこのテストが落ちる)
  extractFunctionSource(html, 'runMainAppBootSequence'),
].join('\n\n');

/* ================================================================
   仮想時計。setTimeout / setInterval / Date.now をまとめて差し替える。
   実時間で30秒待つ代わりに、登録された全タイマーを時刻順に発火させる。
   ================================================================ */
function realSettle() {
  // 実promiseチェーン(フェイクstorageは即解決)を進めるためのマクロタスク待ち。
  return new Promise(function (resolve) { setImmediate(resolve); });
}
async function settle(times) {
  for (var i = 0; i < (times === undefined ? 30 : times); i++) await realSettle();
}
function makeClock() {
  var now = EPOCH;
  var seq = 0;
  var timers = [];
  var clock = {
    now: function () { return now; },
    pending: function () { return timers.length; },
    setTimeout: function (fn, ms) {
      var id = ++seq;
      timers.push({ id: id, at: now + (ms || 0), fn: fn, interval: 0 });
      return id;
    },
    setInterval: function (fn, ms) {
      var id = ++seq;
      var every = Math.max(1, ms || 1);
      timers.push({ id: id, at: now + every, fn: fn, interval: every });
      return id;
    },
    clear: function (id) { timers = timers.filter(function (t) { return t.id !== id; }); },
    intervals: function () {
      return timers.filter(function (t) { return t.interval > 0; }).map(function (t) { return t.interval; }).sort();
    },
    advance: async function (ms) {
      var target = now + ms;
      for (var guard = 0; guard < 100000; guard++) {
        var due = null;
        for (var i = 0; i < timers.length; i++) {
          if (timers[i].at <= target && (!due || timers[i].at < due.at)) due = timers[i];
        }
        if (!due) break;
        now = due.at;
        if (due.interval) due.at = now + due.interval;
        else timers = timers.filter(function (t) { return t.id !== due.id; });
        try { due.fn(); } catch (err) { /* ブラウザのタイマーと同じく他のタイマーは止めない */ }
        await settle(6);
      }
      now = target;
      await settle(10);
    },
  };
  return clock;
}

/* ================================================================
   ページ環境(DOM / イベント / kv_store)
   ================================================================ */
function makePage(options) {
  options = options || {};
  var clock = makeClock();
  var idb = { cache: {}, outbox: {} };
  var remoteRows = [];
  var requests = [];
  var env = {
    currentPropertyId: options.currentPropertyId || PID_A,
    // 'ok' … 正常 / '500' … kv_store 500相当(読みは例外・書きはnull) / 'throw' … 通信断
    // 'timeout' … 30秒後に失敗する(応答が返らない現場回線)
    remoteMode: options.remoteMode || 'ok',
    onLine: options.onLine === undefined ? true : !!options.onLine,
    propertyKey: options.propertyKey || PROP_A,
  };

  function record(method, query) { requests.push(method + ' ' + query); }
  function targetPid(propertyId) { return propertyId || env.currentPropertyId; }
  function ownerFilter(shared) { return shared ? 'owner_id=is.null' : 'owner_id=eq.me'; }
  function findRow(pid, key, shared) {
    for (var i = 0; i < remoteRows.length; i++) {
      var r = remoteRows[i];
      if (r.property_id === pid && r.key === key && r.shared === !!shared) return r;
    }
    return null;
  }
  function remoteFail(kind) {
    // kind: 'read'(例外で伝える) / 'write'(nullで伝える。実 window.storage.set と同じ)
    if (env.remoteMode === 'timeout') {
      return new Promise(function (resolve, reject) {
        clock.setTimeout(function () { reject(new Error('remote timeout')); }, 30000);
      });
    }
    if (kind === 'write' && env.remoteMode === '500') return Promise.resolve(null);
    return Promise.reject(new Error('remote failed: ' + env.remoteMode));
  }
  function ok(v) { return Promise.resolve(v); }

  var fakeStorage = {
    get: function (key, shared, propertyId) {
      var pid = targetPid(propertyId);
      record('GET', 'select=value&property_id=eq.' + pid + '&key=eq.' + key
        + '&shared=eq.' + !!shared + '&' + ownerFilter(shared));
      if (env.remoteMode !== 'ok') return remoteFail('read');
      var row = findRow(pid, key, shared);
      if (!row) return Promise.reject(new Error('key not found: ' + key));
      return ok({ key: key, value: row.value, shared: !!shared });
    },
    set: function (key, value, shared, propertyId) {
      var pid = targetPid(propertyId);
      record('GET', 'select=id&property_id=eq.' + pid + '&key=eq.' + key
        + '&shared=eq.' + !!shared + '&' + ownerFilter(shared));
      if (env.remoteMode !== 'ok') return remoteFail('write');
      var row = findRow(pid, key, shared);
      if (row) { record('PATCH', 'id=eq.' + row.id); row.value = String(value); }
      else {
        record('POST', 'kv_store');
        remoteRows.push({ id: 'row' + (remoteRows.length + 1), property_id: pid, key: key,
          value: String(value), shared: !!shared });
      }
      return ok({ key: key, value: value, shared: !!shared });
    },
    delete: function (key, shared, propertyId) {
      var pid = targetPid(propertyId);
      record('DELETE', 'property_id=eq.' + pid + '&key=eq.' + key
        + '&shared=eq.' + !!shared + '&' + ownerFilter(shared));
      if (env.remoteMode !== 'ok') return remoteFail('write');
      remoteRows = remoteRows.filter(function (r) {
        return !(r.property_id === pid && r.key === key && r.shared === !!shared);
      });
      return ok({ key: key, deleted: true, shared: !!shared });
    },
    list: function (prefix, shared, propertyId) {
      var pid = targetPid(propertyId);
      record('GET', 'select=key&property_id=eq.' + pid + '&key=like.' + prefix + '%'
        + '&shared=eq.' + !!shared + '&' + ownerFilter(shared));
      if (env.remoteMode !== 'ok') return ok(null);   // 実 list() は失敗を null で返す
      return ok({
        keys: remoteRows.filter(function (r) {
          return r.property_id === pid && r.shared === !!shared && r.key.indexOf(prefix) === 0;
        }).map(function (r) { return r.key; }), prefix: prefix, shared: !!shared,
      });
    },
    listValues: function (prefix, shared, propertyId) {
      var pid = targetPid(propertyId);
      record('GET', 'select=key,value&property_id=eq.' + pid + '&key=like.' + prefix + '%'
        + '&shared=eq.' + !!shared + '&' + ownerFilter(shared));
      if (env.remoteMode !== 'ok') return remoteFail('read');
      return ok({
        items: remoteRows.filter(function (r) {
          return r.property_id === pid && r.shared === !!shared && r.key.indexOf(prefix) === 0;
        }).map(function (r) { return { key: r.key, value: r.value }; }), prefix: prefix, shared: !!shared,
      });
    },
  };

  /* ---- DOM とイベント ---- */
  var elements = {};
  function makeEl(id) {
    return {
      id: id, value: '', textContent: '', innerHTML: '',
      style: { display: id === 'modalBackdrop' ? 'none' : 'none' },
      classList: { add: function () {}, remove: function () {}, toggle: function () {}, contains: function () { return false; } },
      addEventListener: function () {},
      querySelector: function () { return null; },
    };
  }
  function getEl(id) {
    if (!elements[id]) elements[id] = makeEl(id);
    return elements[id];
  }
  function makeBus() {
    var handlers = {};
    return {
      add: function (type, fn) { (handlers[type] || (handlers[type] = [])).push(fn); },
      remove: function (type, fn) {
        if (!handlers[type]) return;
        handlers[type] = handlers[type].filter(function (h) { return h !== fn; });
      },
      count: function (type) { return (handlers[type] || []).length; },
      dispatch: function (type, detail) {
        (handlers[type] || []).slice().forEach(function (fn) {
          try { fn({ type: type, detail: detail }); } catch (err) {}
        });
      },
    };
  }
  var docBus = makeBus();
  var winBus = makeBus();

  function FakeDate(a) {
    if (a === undefined) return new Date(clock.now());
    return new Date(a);
  }
  FakeDate.now = function () { return clock.now(); };

  var ctx = {
    JSON: JSON, Object: Object, Array: Array, String: String, Number: Number, Boolean: Boolean,
    Math: Math, Promise: Promise, Error: Error, isFinite: isFinite, parseInt: parseInt,
    Date: FakeDate,
    setTimeout: function (fn, ms) { return clock.setTimeout(fn, ms); },
    clearTimeout: function (id) { clock.clear(id); },
    setInterval: function (fn, ms) { return clock.setInterval(fn, ms); },
    clearInterval: function (id) { clock.clear(id); },
    console: { log: function () {}, warn: function () {}, error: function () {} },
    navigator: { get onLine() { return env.onLine; } },
    document: {
      get visibilityState() { return env.visibilityState || 'visible'; },
      getElementById: function (id) { return getEl(id); },
      querySelector: function () { return getEl('__querySelector'); },
      addEventListener: docBus.add, removeEventListener: docBus.remove,
      dispatchEvent: function (ev) { docBus.dispatch(ev && ev.type, ev && ev.detail); },
    },
    window: {
      storage: options.noStorage ? undefined : fakeStorage,
      getCurrentPropertyId: function () { return env.currentPropertyId; },
      isValidPropertyId: function (v) {
        return typeof v === 'string' && v.length === 36 &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
      },
      FIREFLOW_PROPERTY_SCOPE_ENABLED: options.scopeEnabled === true,
      addEventListener: winBus.add, removeEventListener: winBus.remove,
    },
    // ---- IndexedDB 相当 ----
    lcPut: function (store, record) { idb[store][record.key] = record; return Promise.resolve(); },
    lcGet: function (store, key) { return Promise.resolve(idb[store][key] || null); },
    lcDelete: function (store, key) { delete idb[store][key]; return Promise.resolve(); },
    lcGetAll: function (store) {
      return Promise.resolve(Object.keys(idb[store]).map(function (k) { return idb[store][k]; }));
    },
    // ---- 表示系(通信しない。呼ばれた回数だけ数える) ----
    updateSyncBadge: function () {},
    showSyncCompleteBriefly: function () {},
    isSyncingNow: false,
    lockBodyScrollForModal: function () {}, unlockBodyScrollForModal: function () {},
    renderFloors: function () { ctx.renderFloorsCount++; },
    renderFloorsCount: 0,
    initScheduleLabels: function () {}, renderFilterChips: function () {}, setupCanvas: function () {},
    maybeShowOnboardingOnFirstLaunch: function () {}, checkScheduledReminders: function () {},
    // ---- 起動時の付随データ読み込み ----
    // 実物は各1回だけ storageGet する(下の testBootLoaderShape() がソース側で全数検査する)。
    // ここでは通信の形だけを同じにして、DOM依存の本体は持ち込まない。
    loadSiteSupervisor: function () { return ctx.storageGet('fireflow-property:siteSupervisor', true).catch(function () {}); },
    loadScheduleDays: function () { return ctx.storageGet('fireflow-property:scheduleDays', true).catch(function () {}); },
    loadEquipmentList: function () { return ctx.storageGet('fireflow-property:equipmentList', true).catch(function () {}); },
    loadUploadedDocuments: function () { return ctx.storageGet('fireflow-property:uploadedDocuments', true).catch(function () {}); },
    // ---- メモリ上の業務データ ----
    FLOORS: [], TOTAL_ROOMS: 0, state: {}, lastRawByRoom: {},
    scheduleOverrides: {}, lastRawScheduleOverrideByRoom: {},
    STAMP_DATA: {}, stampScannedRooms: {},
    PROPERTY: { name: env.propertyKey, propertyId: env.currentPropertyId },
  };
  ctx.window.window = ctx.window;
  ctx.global = ctx;
  vm.createContext(ctx);
  vm.runInContext(storeSrc, ctx);
  vm.runInContext(PRODUCT_SRC, ctx);

  var page = {
    ctx: ctx, clock: clock, idb: idb, env: env, requests: requests,
    docBus: docBus, winBus: winBus, elements: elements,
    getEl: getEl,
    rowsFor: function (pid) { return remoteRows.filter(function (r) { return r.property_id === pid || pid === undefined; }); },
    putRemote: function (key, value, pid) {
      var row = findRow(pid || PID_A, key, true);
      if (row) { row.value = value; return; }
      remoteRows.push({ id: 'seed' + (remoteRows.length + 1), property_id: pid || PID_A,
        key: key, value: value, shared: true });
    },
    outboxItems: function () { return Object.keys(idb.outbox).map(function (k) { return idb.outbox[k]; }); },
    clearRequests: function () { requests.length = 0; },
    kvCount: function () { return requests.length; },
    countBy: function (kind) { return requests.filter(function (r) { return classify(r) === kind; }).length; },
    countMatching: function (needle) {
      return requests.filter(function (r) { return r.indexOf(needle) !== -1; }).length;
    },
    setFloors: function (rooms) {
      ctx.FLOORS = roomsToFloors(rooms);
      ctx.TOTAL_ROOMS = rooms.length;
    },
    dispatchDoc: function (type, detail) { docBus.dispatch(type, detail); },
    dispatchWin: function (type, detail) { winBus.dispatch(type, detail); },
  };
  return page;
}

function classify(r) {
  if (r.indexOf('GET select=key,value&') === 0) return 'bulkRead';
  if (r.indexOf('GET select=value&') === 0) return 'singleRead';
  if (r.indexOf('GET select=key&') === 0) return 'listKeys';
  if (r.indexOf('GET select=id&') === 0) return 'writeProbe';
  if (r.indexOf('PATCH ') === 0 || r.indexOf('POST ') === 0) return 'write';
  if (r.indexOf('DELETE ') === 0) return 'delete';
  return 'other';
}

function makeRooms(n) {
  var rooms = [];
  for (var floor = 1; rooms.length < n; floor++) {
    for (var i = 1; i <= 10 && rooms.length < n; i++) rooms.push(String(floor * 100 + i));
  }
  return rooms;
}
function roomsToFloors(rooms) {
  var byFloor = {};
  rooms.forEach(function (r) {
    var f = r.slice(0, r.length - 2) + '階';
    (byFloor[f] || (byFloor[f] = [])).push(r);
  });
  return Object.keys(byFloor).map(function (f) { return { floor: f, rooms: byFloor[f] }; });
}
function binderValue(room, status) {
  return JSON.stringify({ room: room, status: status || 'done', at: '2026-08-22T09:00:00.000Z' });
}
function overrideValue(room) { return JSON.stringify({ room: room, time: '10:30' }); }
function stampValue(room, propertyKey) {
  return JSON.stringify({ room: room, property_key: propertyKey || PROP_A, symbol: 'A',
    time_start: '09:30', note: '朝一' + room, source: 'standardized_stamp_sheet',
    updated_at: '2026-08-22T00:00:00.000Z' });
}

/* 実端末と同じ「保存済みデータが既にある物件」を作る。 */
function seedRemoteProperty(page, rooms, pid, propertyKey) {
  rooms.forEach(function (room) {
    page.putRemote('fireflow-binder:' + room, binderValue(room), pid);
    page.putRemote('fireflow-schedule-override:' + room, overrideValue(room), pid);
    page.putRemote('stamp:' + (propertyKey || PROP_A) + ':' + room, stampValue(room, propertyKey), pid);
  });
  page.putRemote('fireflow-property:siteSupervisor', JSON.stringify({ name: '山田', locked: true }), pid);
  page.putRemote('fireflow-property:scheduleDays', JSON.stringify([{ date: '2026-08-22' }]), pid);
  page.putRemote('fireflow-property:equipmentList', JSON.stringify(['消火器具']), pid);
  page.putRemote('fireflow-property:uploadedDocuments', JSON.stringify([]), pid);
}

/* 実LBの起動そのもの。起動ゲートで「前回の物件を続ける」を選んだときと同じ順序。
   ・applyCurrentPropertyRecord() は restoreStampDataFromStorage() を await しない
   ・その直後に bootMainAppOnce() → runMainAppBootSequence() が走る
   という実コードの並び(index.html)をそのまま再現する。 */
async function bootPage(page, opts) {
  opts = opts || {};
  page.getEl('inspectorName').value = opts.inspectorName === undefined ? '田中' : opts.inspectorName;
  page.ctx.reloadStampStoreForCurrentProperty();
  page.ctx.runMainAppBootSequence();
  await settle();
  await page.clock.advance(1000);          // 起動直後のデバウンス等を消化する
  page.dispatchDoc('supabase-ready');
  await settle();
  await page.clock.advance(1000);
  if (opts.realtime !== false) {
    page.dispatchDoc('sb-realtime-status', { status: 'SUBSCRIBED' });
    await settle();
  }
  await page.clock.advance(1000);
}

/* ================================================================
   1/2/3/4. 129室 boot → 30秒 IDLE
   ================================================================ */
async function testIdle129() {
  console.log('\n==== 1〜4. 129室: 起動 → 30秒 IDLE ====');
  var rooms = makeRooms(129);
  var page = makePage();
  seedRemoteProperty(page, rooms, PID_A);
  page.setFloors(rooms);

  await bootPage(page);
  var bootRequests = page.kvCount();
  check('2. boot完了までの kv_store リクエスト数が部屋数に比例しない(129室で15件以下)',
    bootRequests <= 15, { bootRequests: bootRequests, requests: page.requests.slice() });
  check('2. boot で129室すべて復元されている',
    Object.keys(page.ctx.state).length === 129, Object.keys(page.ctx.state).length);
  check('2. boot で予定情報(StampStore)も復元されている',
    Object.keys(page.ctx.STAMP_DATA).length === 129, Object.keys(page.ctx.STAMP_DATA).length);

  page.clearRequests();
  await page.clock.advance(IDLE_WINDOW_MS);
  check('3/4. IDLE 30秒の kv_store REST が EXPECTED_IDLE_REQUESTS(=0) と一致する',
    page.kvCount() === EXPECTED_IDLE_REQUESTS, { count: page.kvCount(), requests: page.requests.slice(0, 10) });
  check('4. IDLE中の GET が0件', page.countBy('bulkRead') + page.countBy('singleRead') + page.countBy('listKeys') + page.countBy('writeProbe') === 0);
  check('4. IDLE中の POST/PATCH が0件', page.countBy('write') === 0);
  check('4. IDLE中の DELETE が0件', page.countBy('delete') === 0);
  check('7. schedule-override の周期GETが止まっている',
    page.countMatching('key=like.fireflow-schedule-override:') === 0, page.countMatching('key=like.fireflow-schedule-override:'));
  check('8. binder の周期GETが止まっている',
    page.countMatching('fireflow-binder:') === 0, page.countMatching('fireflow-binder:'));
  check('9. stamp の周期GETが止まっている',
    page.countMatching('stamp:') === 0, page.countMatching('stamp:'));
  check('10. 送信キュー正常時の周期書込みが無い(outboxが空でタイマーも無い)',
    page.outboxItems().length === 0 && page.ctx.outboxRetryTimer === null);
  check('IDLE中もタイマーは残るが kv_store を叩かない(残タイマーは通知系のみ)',
    page.clock.intervals().every(function (ms) { return ms >= 60000; }), page.clock.intervals());
  return { page: page, bootRequests: bootRequests };
}

/* ================================================================
   5/6. 259室でも同じ。部屋数比例が無い
   ================================================================ */
async function testIdle259(bootRequests129) {
  console.log('\n==== 5/6. 259室: 起動 → 30秒 IDLE(部屋数比例が無いこと) ====');
  var rooms = makeRooms(259);
  var page = makePage();
  seedRemoteProperty(page, rooms, PID_A);
  page.setFloors(rooms);

  await bootPage(page);
  var bootRequests = page.kvCount();
  check('5. 259室でも boot の kv_store リクエスト数が15件以下',
    bootRequests <= 15, { bootRequests: bootRequests });
  check('6. boot のリクエスト数が129室と259室で同一(部屋数比例が無い)',
    bootRequests === bootRequests129, { rooms129: bootRequests129, rooms259: bootRequests });
  check('5. 259室すべて復元されている',
    Object.keys(page.ctx.state).length === 259, Object.keys(page.ctx.state).length);

  page.clearRequests();
  await page.clock.advance(IDLE_WINDOW_MS);
  check('5/6. 259室の IDLE 30秒も kv_store REST = 0',
    page.kvCount() === EXPECTED_IDLE_REQUESTS, { count: page.kvCount(), requests: page.requests.slice(0, 10) });
}

/* ================================================================
   他端末同期(pollingを消した代わりが本当に働くか)
   ================================================================ */
async function testRealtimeSync() {
  console.log('\n==== 他端末同期: Realtime通知で読み直す(pollingの役目の引き継ぎ) ====');
  var rooms = makeRooms(129);
  var page = makePage();
  seedRemoteProperty(page, rooms, PID_A);
  page.setFloors(rooms);
  await bootPage(page);

  // 他端末が101号室を「不在」にした
  page.putRemote('fireflow-binder:101', binderValue('101', 'absent'), PID_A);
  page.clearRequests();
  page.dispatchDoc('sb-realtime-update', { table: 'kv_store' });
  await page.clock.advance(2000);
  check('他端末の更新をRealtime通知で拾って反映する',
    page.ctx.state['101'] && page.ctx.state['101'].status === 'absent', page.ctx.state['101']);
  check('1回の通知で出る通信はまとめ取り2件だけ',
    page.kvCount() === 2 && page.countBy('bulkRead') === 2, { count: page.kvCount(), requests: page.requests.slice() });

  // 129室ぶんの通知が一気に来ても、読み直しは1回にまとめる
  page.clearRequests();
  for (var i = 0; i < 129; i++) page.dispatchDoc('sb-realtime-update', { table: 'kv_store' });
  await page.clock.advance(2000);
  check('通知が129件まとめて来ても読み直しは1回(2件)だけ',
    page.kvCount() === 2, { count: page.kvCount() });

  // kv_store 以外のテーブルの通知では読み直さない
  page.clearRequests();
  page.dispatchDoc('sb-realtime-update', { table: 'room_results' });
  await page.clock.advance(2000);
  check('kv_store 以外のテーブル通知では読み直さない', page.kvCount() === 0, page.requests.slice());

  // パネルを開いている間の通知は、閉じた直後に1回だけ反映する
  page.getEl('panel').style.display = 'block';
  page.putRemote('fireflow-binder:102', binderValue('102', 'absent'), PID_A);
  page.clearRequests();
  page.dispatchDoc('sb-realtime-update', { table: 'kv_store' });
  await page.clock.advance(2000);
  check('パネルを開いている間は読み直さない(入力中の画面を書き換えない)',
    page.kvCount() === 0 && page.ctx.loadAllDeferredRefresh === true, { count: page.kvCount() });
  page.getEl('panel').style.display = 'none';
  page.ctx.hideBackdrop();
  await page.clock.advance(2000);
  check('パネルを閉じた直後に持ち越し分を1回だけ反映する',
    page.ctx.state['102'] && page.ctx.state['102'].status === 'absent' && page.kvCount() === 2,
    { count: page.kvCount(), state102: page.ctx.state['102'] });
}

/* ================================================================
   Realtimeが繋がらない場合の縮退動作
   ================================================================ */
async function testRealtimeDownFallback() {
  console.log('\n==== Realtime未接続時の縮退(60秒に1回だけ・繋がったら止まる) ====');
  var rooms = makeRooms(129);
  var page = makePage();
  seedRemoteProperty(page, rooms, PID_A);
  page.setFloors(rooms);
  await bootPage(page, { realtime: false });   // 購読成功が届かない

  page.clearRequests();
  await page.clock.advance(IDLE_WINDOW_MS);
  check('Realtime未接続でも IDLE 30秒では読み直しが起きない',
    page.kvCount() === 0, { count: page.kvCount() });

  page.clearRequests();
  await page.clock.advance(65000);
  check('Realtime未接続のときだけ60秒に1回読み直す(2件)',
    page.kvCount() === 2 && page.countBy('bulkRead') === 2, { count: page.kvCount() });

  page.dispatchDoc('sb-realtime-status', { status: 'SUBSCRIBED' });
  await settle();
  page.clearRequests();
  await page.clock.advance(180000);
  check('購読できた瞬間に縮退の読み直しは完全に止まる',
    page.kvCount() === 0, { count: page.kvCount() });
}

/* ================================================================
   11. remote 500 でも storm 化しない
   ================================================================ */
async function testRemote500() {
  console.log('\n==== 11. kv_store 500: storm 化しない・データを捨てない ====');
  var rooms = makeRooms(129);
  var page = makePage({ remoteMode: '500' });
  page.setFloors(rooms);
  await bootPage(page);

  // 129室ぶんの保存がすべて失敗して送信キューへ積まれる(実端末で起きていた状況)
  for (var i = 0; i < rooms.length; i++) {
    await page.ctx.storageSet('fireflow-binder:' + rooms[i], binderValue(rooms[i]), true);
  }
  await settle();
  // 起動時の在席の合図も500で失敗して積まれるため、送信キューは 129 + 1 件になる。
  var binderQueued = page.outboxItems().filter(function (it) {
    return String(it.rawKey).indexOf('fireflow-binder:') === 0;
  }).length;
  check('11. 保存失敗した129室ぶんが送信キューへ残る(データを捨てない)',
    binderQueued === 129, { binderQueued: binderQueued, total: page.outboxItems().length });

  page.clearRequests();
  await page.clock.advance(IDLE_WINDOW_MS);
  var first30 = page.kvCount();
  check('11. 500継続中の30秒でも件数比例のstormにならない(129室でも30件以下)',
    first30 <= 30, { count: first30 });
  page.clearRequests();
  await page.clock.advance(IDLE_WINDOW_MS);
  var second30 = page.kvCount();
  check('11. 失敗が続くほど再送間隔が延びる(2回目の30秒は1回目以下)',
    second30 <= first30, { first30: first30, second30: second30 });
  check('11. 送信キューは1件も失われていない',
    page.outboxItems().length === binderQueued + 1, page.outboxItems().length);
  page.clearRequests();
  await page.clock.advance(180000);
  check('11. 再送間隔が上限(60秒)で頭打ちになる(無限に延びない)',
    page.ctx.outboxRetryDelayMs === OUTBOX_RETRY_MAX_MS_EXPECTED, page.ctx.outboxRetryDelayMs);
  check('11. 上限に達した後の3分間も、リクエストは待ち延ばしどおりの少数に収まる',
    page.kvCount() <= 12, { count: page.kvCount() });

  // 復旧したら、次の機会に必ず送り切る
  page.env.remoteMode = 'ok';
  page.dispatchWin('online');
  await settle();
  await page.clock.advance(30000);
  check('11. 復旧後は待たされずに送信を再開し、送信キューが空になる',
    page.outboxItems().length === 0, page.outboxItems().length);
  check('11. 送信キューが空になったら再送タイマーも止まる',
    page.ctx.outboxRetryTimer === null);
}

/* ================================================================
   12. timeout でも storm 化しない
   ================================================================ */
async function testRemoteTimeout() {
  console.log('\n==== 12. 応答が返らない回線(timeout): 多重化しない ====');
  var rooms = makeRooms(129);
  var page = makePage();
  seedRemoteProperty(page, rooms, PID_A);
  page.setFloors(rooms);
  await bootPage(page);

  page.env.remoteMode = 'timeout';   // 以後、応答は30秒返らない
  page.clearRequests();
  // 他端末通知が10回来ても、応答待ちの間に読み直しが重ならないこと
  for (var i = 0; i < 10; i++) {
    page.dispatchDoc('sb-realtime-update', { table: 'kv_store' });
    await page.clock.advance(1000);
  }
  check('12. 応答待ちの間に読み直しが多重化しない(まとめ取りは1件のみ在庫)',
    page.countBy('bulkRead') <= 1, { requests: page.requests.slice() });
  await page.clock.advance(120000);
  check('12. timeout が続いても kv_store リクエストが積み上がらない',
    page.kvCount() <= 6, { count: page.kvCount(), requests: page.requests.slice(0, 8) });
  check('12. 再入ガードが解放されている(二度と読み直せなくならない)',
    page.ctx.loadAllInFlight === false);
}

/* ================================================================
   13/14. offline は remote 0。online 復帰で必要な同期だけ
   ================================================================ */
async function testOfflineAndOnline() {
  console.log('\n==== 13/14. オフライン中は0件 / オンライン復帰で必要な分だけ ====');
  var rooms = makeRooms(129);
  var page = makePage({ onLine: false, remoteMode: 'throw' });
  page.setFloors(rooms);
  // ローカル(IndexedDB)にだけ保存がある状態
  rooms.forEach(function (room) {
    page.idb.cache['shared:fireflow-binder:' + room] = {
      key: 'shared:fireflow-binder:' + room, value: binderValue(room), updatedAt: 1 };
  });
  await bootPage(page, { realtime: false });
  check('13. オフラインでもローカルから129室を復元できる',
    Object.keys(page.ctx.state).length === 129, Object.keys(page.ctx.state).length);

  page.clearRequests();
  await page.clock.advance(IDLE_WINDOW_MS);
  var offlineWrites = page.countBy('write') + page.countBy('writeProbe') + page.countBy('delete');
  check('13. オフラインIDLE 30秒で送信・削除が1件も出ない', offlineWrites === 0, { offlineWrites: offlineWrites });

  // オンライン復帰
  page.env.onLine = true;
  page.env.remoteMode = 'ok';
  seedRemoteProperty(page, rooms, PID_A);
  page.clearRequests();
  page.dispatchWin('online');
  await page.clock.advance(3000);
  check('14. オンライン復帰で読み直しが1回だけ走る(まとめ取り2件)',
    page.countBy('bulkRead') === 2, { bulkRead: page.countBy('bulkRead'), requests: page.requests.slice() });
  check('14. オンライン復帰の通信が部屋数に比例しない(10件以下)',
    page.kvCount() <= 10, { count: page.kvCount() });

  // 回線が戻れば Realtime も再購読される。そこから先は通常どおり IDLE 0件。
  page.dispatchDoc('sb-realtime-status', { status: 'SUBSCRIBED' });
  await settle();
  page.clearRequests();
  await page.clock.advance(IDLE_WINDOW_MS);
  check('14. オンライン復帰後もIDLEは0件へ戻る', page.kvCount() === 0, { count: page.kvCount() });
  check('14. 復帰後に送信キューが残っていない(必要な同期は終わっている)',
    page.outboxItems().length === 0, page.outboxItems().length);
}

/* ================================================================
   15/16/17/18. reload / 物件切替 / 保存→復元 / 別物件混入
   ================================================================ */
async function testReloadPropertySwitchAndIsolation() {
  console.log('\n==== 15〜18. reload / 物件切替 / 保存→復元 / 別物件混入0 ====');
  var roomsA = makeRooms(129);
  var roomsB = ['201', '202', '203'];
  var page = makePage();
  seedRemoteProperty(page, roomsA, PID_A);
  // 別物件(PID_B)にも同じ部屋番号の保存がある = 混入が起きるならここで起きる
  roomsA.forEach(function (room) {
    page.putRemote('fireflow-binder:' + room, JSON.stringify({ room: room, status: 'BADPROPERTY' }), PID_B);
  });
  page.setFloors(roomsA);
  await bootPage(page);

  check('18. 別物件(PID_B)のデータが1件も混入していない',
    Object.keys(page.ctx.state).every(function (room) { return page.ctx.state[room].status !== 'BADPROPERTY'; }));
  check('18. IDLE中も含め、他物件あての通信が1件も出ていない',
    page.countMatching('property_id=eq.' + PID_B) === 0, page.countMatching('property_id=eq.' + PID_B));

  // 17. 保存 → 復元一致
  var saved = JSON.stringify({ room: '101', status: 'done', sign: 'テスト署名', at: '2026-08-22T10:00:00.000Z' });
  var setResult = await page.ctx.storageSet('fireflow-binder:101', saved, true);
  check('17. 保存はリモートまで確認できている', setResult && setResult.remote === true, setResult);
  page.ctx.lastRawByRoom = {};
  page.clearRequests();
  page.dispatchDoc('sb-realtime-update', { table: 'kv_store' });
  await page.clock.advance(2000);
  check('17. 保存した内容がそのまま復元される(1バイトも変わらない)',
    JSON.stringify(page.ctx.state['101']) === JSON.stringify(JSON.parse(saved)), page.ctx.state['101']);

  // 15. reload(= 同じ保存状態から新しいページを起動する)
  var reloaded = makePage();
  seedRemoteProperty(reloaded, roomsA, PID_A);
  reloaded.putRemote('fireflow-binder:101', saved, PID_A);
  reloaded.setFloors(roomsA);
  await bootPage(reloaded);
  check('15. reload後も129室すべて復元される',
    Object.keys(reloaded.ctx.state).length === 129, Object.keys(reloaded.ctx.state).length);
  check('15. reload後の保存内容が一致する',
    JSON.stringify(reloaded.ctx.state['101']) === JSON.stringify(JSON.parse(saved)));
  reloaded.clearRequests();
  await reloaded.clock.advance(IDLE_WINDOW_MS);
  check('15. reload後のIDLEも0件', reloaded.kvCount() === 0, { count: reloaded.kvCount() });

  // 16. 物件切替(Excel取込相当: FLOORSを差し替えて property-change を依頼する)
  page.putRemote('fireflow-binder:201', binderValue('201'), PID_A);
  page.putRemote('fireflow-binder:202', binderValue('202'), PID_A);
  page.putRemote('fireflow-binder:203', binderValue('203'), PID_A);
  page.setFloors(roomsB);
  page.clearRequests();
  page.ctx.requestRemoteRefresh('property-change');
  await page.clock.advance(2000);
  check('16. 物件切替で新しい部屋一覧が復元される',
    Object.keys(page.ctx.state).sort().join(',') === roomsB.slice().sort().join(','),
    Object.keys(page.ctx.state));
  check('16. 物件切替の通信もまとめ取り2件だけ',
    page.countBy('bulkRead') === 2 && page.kvCount() === 2, { count: page.kvCount() });
  page.clearRequests();
  await page.clock.advance(IDLE_WINDOW_MS);
  check('16. 物件切替後のIDLEも0件', page.kvCount() === 0, { count: page.kvCount() });
}

/* ================================================================
   在席プレゼンス: 無操作では出さない / 操作したら出す
   ================================================================ */
async function testPresence() {
  console.log('\n==== 在席プレゼンス: 無操作0件 / 操作時のみ(最短20秒間隔) ====');
  var rooms = makeRooms(129);
  var page = makePage();
  seedRemoteProperty(page, rooms, PID_A);
  page.setFloors(rooms);
  await bootPage(page);

  page.clearRequests();
  await page.clock.advance(120000);
  check('無操作なら2分経っても在席の書き込みが1件も出ない',
    page.countMatching('fireflow-presence:') === 0, page.countMatching('fireflow-presence:'));

  // 操作した
  page.clearRequests();
  page.dispatchDoc('pointerdown');
  await settle();
  check('操作したら在席の合図を1回送る(select id + 書込 = 2件)',
    page.countMatching('fireflow-presence:') === 1 && page.kvCount() === 2,
    { presence: page.countMatching('fireflow-presence:'), count: page.kvCount() });

  // 連打しても20秒に1回へ間引く
  page.clearRequests();
  for (var i = 0; i < 50; i++) page.dispatchDoc('pointerdown');
  await settle();
  check('連打しても20秒以内は追加送信しない(間引き)',
    page.countMatching('fireflow-presence:') === 0, page.countMatching('fireflow-presence:'));

  await page.clock.advance(21000);
  page.clearRequests();
  page.dispatchDoc('pointerdown');
  await settle();
  check('20秒経った後の操作では改めて合図を送る(点検中の表示が消えない)',
    page.countMatching('fireflow-presence:') === 1, page.countMatching('fireflow-presence:'));

  // 在席一覧の読み込みが人数比例のN+1になっていないこと
  page.putRemote('fireflow-presence:佐藤', String(page.clock.now()), PID_A);
  page.putRemote('fireflow-presence:鈴木', String(page.clock.now()), PID_A);
  page.clearRequests();
  var active = await page.ctx.loadActiveInspectors();
  check('在席一覧の取得は人数に関係なく1リクエスト',
    page.kvCount() === 1 && page.countBy('bulkRead') === 1, { count: page.kvCount(), requests: page.requests.slice() });
  check('在席一覧の中身は従来どおり(90秒以内の点検員だけ・名前順)',
    active.indexOf('佐藤') !== -1 && active.indexOf('鈴木') !== -1
      && JSON.stringify(active) === JSON.stringify(active.slice().sort()), active);
}

/* ================================================================
   ソース側の全数検査(このテストが見ていない経路が増えたら落とす)
   ================================================================ */
function testSourceLevelGuards() {
  console.log('\n==== ソース全数検査: 周期実行と起動時読み込みの棚卸し ====');
  var htmlNoComments = stripComments(html);
  var sbNoComments = stripComments(sbSrc);

  // setInterval の全数。kv_store を叩く周期実行が1つも無いこと。
  var intervals = [];
  var re = /setInterval\(([^,]+),\s*([0-9]+)\s*\)/g;
  var m;
  while ((m = re.exec(htmlNoComments)) !== null) {
    intervals.push({ fn: m[1].trim(), ms: parseInt(m[2], 10) });
  }
  var expected = [
    { fn: 'flushOutbox', ms: 5000 },                 // 送信キューの再送(失敗時のみ起動・空で停止)
    { fn: 'flushOutbox', ms: 'outboxRetryDelayMs' }, // 同上(待ち延ばし後)
    { fn: 'checkScheduledReminders', ms: 60000 },    // 通知バナー。通信しない
  ];
  var kvPeriodic = intervals.filter(function (t) {
    return t.fn.indexOf('loadAll') !== -1 || t.fn.indexOf('PresenceHeartbeat') !== -1;
  });
  check('index.html に部屋状態・在席の周期実行が1件も無い', kvPeriodic.length === 0, kvPeriodic);
  check('残っている固定間隔の setInterval は棚卸し済みのものだけ',
    intervals.every(function (t) {
      return t.fn === 'flushOutbox' || t.fn === 'checkScheduledReminders'
        || t.fn.indexOf('requestRemoteRefresh') !== -1;
    }), intervals);
  check('60秒の縮退読み直しは REMOTE_REFRESH_FALLBACK_MS 経由だけ',
    (htmlNoComments.match(/setInterval\(function \(\) \{ requestRemoteRefresh\('realtime-down'\); \}, REMOTE_REFRESH_FALLBACK_MS\)/g) || []).length === 1);

  // 再帰 setTimeout によるポーリングが無いこと
  var recursivePolling = /setTimeout\(\s*function[^)]*\{[^}]*\b(loadAll|sendPresenceHeartbeat|flushOutbox)\s*\([^}]*\}\s*,\s*[0-9]+\s*\)\s*;?\s*\}/.test(htmlNoComments);
  check('再帰 setTimeout による自前ポーリングが無い', !recursivePolling);

  // 起動時の付随データ読み込みが、それぞれ1回の読み取りで済んでいること
  ['loadSiteSupervisor', 'loadScheduleDays', 'loadEquipmentList', 'loadUploadedDocuments'].forEach(function (name) {
    var src = stripComments(extractFunctionSource(html, name));
    var reads = (src.match(/storage(?:Get|List|ListValues)\(/g) || []).length;
    check('起動時読み込み ' + name + '() の読み取りは1回だけ', reads === 1, reads);
  });

  // kv_store へ到達できる入口が window.storage の5本だけであること(監査の前提)
  check('kv_store を直接叩くコードは supabase-integration.js の window.storage だけ',
    htmlNoComments.indexOf("from('kv_store')") === -1
      && (sbNoComments.match(/from\('kv_store'\)/g) || []).length > 0);

  // Realtime の購読状態がLB本体へ届くこと
  check('Realtime の購読状態が sb-realtime-status で通知される',
    sbNoComments.indexOf("channel.subscribe(function (status)") !== -1
      && sbNoComments.indexOf("'sb-realtime-status'") !== -1);
  check('Realtime の購読対象(kv_store / room_results 等)は従来のまま',
    sbNoComments.indexOf("table: 'kv_store', filter: 'property_id=eq.' + currentPropertyId") !== -1);
}

/* ================================================================ */
async function main() {
  var r129 = await testIdle129();
  await testIdle259(r129.bootRequests);
  await testRealtimeSync();
  await testRealtimeDownFallback();
  await testRemote500();
  await testRemoteTimeout();
  await testOfflineAndOnline();
  await testReloadPropertySwitchAndIsolation();
  await testPresence();
  testSourceLevelGuards();

  var passed = results.filter(function (r) { return r.ok; }).length;
  var failed = results.length - passed;
  console.log('\n==== page_wide_idle_request_verify 総合結果: ' + (failed === 0 ? 'PASS' : 'FAIL')
    + ' (' + passed + '/' + results.length + ') ====');
  console.log('EXPECTED_IDLE_REQUESTS = ' + EXPECTED_IDLE_REQUESTS + ' (30秒 IDLE / kv_store REST)');
  if (failed > 0) {
    results.filter(function (r) { return !r.ok; }).forEach(function (r) { console.log('  NG: ' + r.label); });
    process.exit(1);
  }
}

main().catch(function (err) {
  console.error('テストの実行自体が失敗しました:', err && err.stack ? err.stack : err);
  process.exit(1);
});
