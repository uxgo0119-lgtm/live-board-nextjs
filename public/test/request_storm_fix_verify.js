// [2026-08-19新設] TEST-V: Supabase request storm(毎秒数百GET)の修正に対する回帰テスト。
//
// 直した対象は2つだけ。
//   STEP A 再入ガード : loadAll()が同時に複数走らない(通信が遅いほど重なって増える悪循環を断つ)
//   STEP B まとめ取り : 部屋ごとの storageGet() を prefix 1回のまとめ取りへ置き換える
//
// このテストが守る一線は「通信は減ったが復元結果が変わってしまった」を起こさないこと。
// そのため、値の復元については必ず【旧実装(部屋ごとstorageGet)を参照実装としてテスト内に
// 書き起こし】、新実装の結果と1件ずつ突き合わせる。期待値をベタ書きしないので、
// 「テストの期待値を新実装に合わせて書き換えたから通った」は原理的に起こらない。
//
// 既存の public/test/*.js と同じく、index.html から関数ソースを文字列抽出して
// Node.js の vm で実行する(製品コードには一切手を入れずに検証する)。
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

var PID_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
var PID_B = 'bbbbbbbb-2222-4222-9222-bbbbbbbbbbbb';

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
  if (html.slice(Math.max(0, startIdx - 6), startIdx) === 'async ') startIdx -= 6;
  return html.slice(startIdx, i);
}
/* ソース検査は「実際の呼び出し」だけを見る。経緯を説明するコメント中に
   storageGet() 等の名前が出てくるのは正常なので、先にコメントを落とす
   (phase1b_property_state_reset_verify.js と同じ考え方)。 */
function stripComments(src) {
  return String(src).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
function extractVarDeclSource(name) {
  var marker = 'var ' + name + ' = ';
  var startIdx = html.indexOf(marker);
  if (startIdx === -1) throw new Error('MISSING IMPLEMENTATION SOURCE: var ' + name);
  var semiIdx = html.indexOf(';', startIdx);
  return html.slice(startIdx, semiIdx + 1);
}

var PRODUCT_SRC = [
  extractVarDeclSource('COMMON_AREA_KEY'),
  extractFunctionSource('keyFor'),
  extractVarDeclSource('BINDER_KEY_PREFIX'),
  extractVarDeclSource('SCHEDULE_OVERRIDE_KEY_PREFIX'),
  extractFunctionSource('scheduleOverrideKeyFor'),
  // property scope 層(Phase 1C)。まとめ取りでも同じ1経路だけを通ることを確認する。
  extractVarDeclSource('PROPERTY_SCOPE_ENABLED'),
  extractVarDeclSource('PROPERTY_SCOPED_KEY_PREFIXES'),
  extractVarDeclSource('PROPERTY_SCOPED_EXACT_KEYS'),
  extractFunctionSource('isPropertyScopedKey'),
  extractFunctionSource('propertyScopedKey'),
  extractFunctionSource('propertyUnscopedKey'),
  extractFunctionSource('isValidScopePropertyId'),
  extractFunctionSource('currentScopePropertyId'),
  extractFunctionSource('applyPropertyScope'),
  // 保存層
  extractFunctionSource('lcCacheKey'),
  extractFunctionSource('storageGet'),
  // 今回追加したまとめ取り経路
  extractFunctionSource('storageListValues'),
  extractFunctionSource('readValueFromLocalCache'),
  extractFunctionSource('readRoomValuesBulk'),
  // loadAll(再入ガード + パネル中の持ち越し + 本体)
  extractVarDeclSource('loadAllInFlight'),
  extractVarDeclSource('loadAllDeferredRefresh'),
  extractFunctionSource('loadAll'),
  extractFunctionSource('loadAllInner'),
].join('\n\n');

/* ================================================================
   観測可能なフェイク: IndexedDB と Supabase(kv_store)
   ================================================================ */
function makeEnv(options) {
  options = options || {};
  var idb = { cache: {}, outbox: {} };
  var remoteRows = [];                 // kv_store 相当
  var counts = { get: 0, listValues: 0, list: 0, set: 0, delete: 0 };
  var state = {
    currentPropertyId: options.currentPropertyId !== undefined ? options.currentPropertyId : PID_A,
    offline: !!options.offline,
    slowMs: options.slowMs || 0,
  };

  function delay() {
    if (!state.slowMs) return Promise.resolve();
    return new Promise(function (resolve) { setTimeout(resolve, state.slowMs); });
  }
  function resolveProperty(propertyId) {
    return propertyId ? propertyId : state.currentPropertyId;
  }
  function findRow(propertyId, key, shared) {
    for (var i = 0; i < remoteRows.length; i++) {
      var r = remoteRows[i];
      if (r.property_id === propertyId && r.key === key && r.shared === !!shared) return r;
    }
    return null;
  }

  /* 本物の window.storage シム(supabase-integration.js)と同じ絞り込み規則:
     property_id / key / shared で1件、list系は key の前方一致。 */
  var storage = {
    get: function (key, shared, propertyId) {
      counts.get++;
      return delay().then(function () {
        if (state.offline) throw new Error('offline');
        var row = findRow(resolveProperty(propertyId), key, shared);
        if (!row) throw new Error('key not found: ' + key);
        return { key: key, value: row.value, shared: !!shared };
      });
    },
    list: function (prefix, shared, propertyId) {
      counts.list++;
      return delay().then(function () {
        if (state.offline) return null;
        var pid = resolveProperty(propertyId);
        var keys = remoteRows.filter(function (r) {
          return r.property_id === pid && r.shared === !!shared && String(r.key).indexOf(prefix) === 0;
        }).map(function (r) { return r.key; });
        return { keys: keys, prefix: prefix, shared: !!shared };
      });
    },
    listValues: function (prefix, shared, propertyId) {
      counts.listValues++;
      return delay().then(function () {
        if (state.offline) throw new Error('offline');
        var pid = resolveProperty(propertyId);
        var items = remoteRows.filter(function (r) {
          return r.property_id === pid && r.shared === !!shared && String(r.key).indexOf(prefix) === 0;
        }).map(function (r) { return { key: r.key, value: r.value }; });
        return { items: items, prefix: prefix, shared: !!shared };
      });
    },
    set: function () { counts.set++; return Promise.resolve(null); },
    delete: function () { counts.delete++; return Promise.resolve(null); },
  };

  var ctx = {
    JSON: JSON, Object: Object, Array: Array, String: String, Number: Number,
    Promise: Promise, Date: Date, Error: Error, console: console, setTimeout: setTimeout,
    window: {
      storage: storage,
      getCurrentPropertyId: function () { return state.currentPropertyId; },
      FIREFLOW_PROPERTY_SCOPE_ENABLED: !!options.scopeEnabled,
    },
    // IndexedDB 相当
    lcPut: function (store, record) { idb[store][record.key] = record; return Promise.resolve(); },
    lcGet: function (store, key) { return Promise.resolve(idb[store][key] || null); },
    lcDelete: function (store, key) { delete idb[store][key]; return Promise.resolve(); },
    lcGetAll: function (store) { return Promise.resolve(Object.keys(idb[store]).map(function (k) { return idb[store][k]; })); },
    updateSyncBadge: function () {},
    scheduleOutboxRetry: function () {},

    // loadAll 本体が触るメモリ
    FLOORS: [], state: {}, lastRawByRoom: {},
    scheduleOverrides: {}, lastRawScheduleOverrideByRoom: {},
    renderFloors: function () { ctx.renderFloorsCount++; if (ctx.renderFloorsThrows) { ctx.renderFloorsThrows = false; throw new Error('render失敗(テスト)'); } },
    renderFloorsCount: 0,
    renderFloorsThrows: false,
    document: {
      getElementById: function () { return { style: { display: 'none' } }; },
    },
  };
  ctx.window.window = ctx.window;
  vm.createContext(ctx);
  vm.runInContext(PRODUCT_SRC, ctx);

  return {
    ctx: ctx, idb: idb, counts: counts, env: state,
    remoteRows: remoteRows,
    putRemote: function (propertyId, key, value, shared) {
      var row = findRow(propertyId, key, shared === undefined ? true : shared);
      if (row) { row.value = value; return; }
      remoteRows.push({ property_id: propertyId, key: key, value: value, shared: shared === undefined ? true : shared });
    },
    putCache: function (cacheKey, value) { idb.cache[cacheKey] = { key: cacheKey, value: value, updatedAt: 1 }; },
    resetCounts: function () { counts.get = 0; counts.listValues = 0; counts.list = 0; counts.set = 0; counts.delete = 0; },
  };
}

/* 129室ぶんの部屋番号(実物件の規模。1階〜13階×10室相当) */
function make129Rooms() {
  var rooms = [];
  for (var floor = 1; rooms.length < 129; floor++) {
    for (var n = 1; n <= 10 && rooms.length < 129; n++) {
      rooms.push(String(floor * 100 + n));
    }
  }
  return rooms;
}
function roomsToFloors(rooms) {
  var floors = [];
  for (var i = 0; i < rooms.length; i += 10) {
    floors.push({ floor: String(i / 10 + 1) + '階', rooms: rooms.slice(i, i + 10) });
  }
  return floors;
}

/* ================================================================
   参照実装: 修正前(旧実装)の取得経路をテスト側へ書き起こしたもの。
   製品の readRoomValuesBulk() の結果は、必ずこれと一致しなければならない。
   ※製品の関数を呼び回すのではなく、旧コードと同じ「部屋ごとにstorageGet、
     失敗はnull」をここに独立して書いている。
   ================================================================ */
function referenceOldPerRoomRead(ctx, rooms, keyForFn) {
  return Promise.all(rooms.map(function (room) {
    return ctx.storageGet(keyForFn(room), true).catch(function () { return null; });
  }));
}
function normalizeForCompare(list) {
  return list.map(function (r) { return r && r.value !== undefined && r.value !== null ? String(r.value) : null; });
}
function sameValues(a, b) {
  var x = normalizeForCompare(a), y = normalizeForCompare(b);
  if (x.length !== y.length) return false;
  for (var i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

function binderValue(room, status) {
  return JSON.stringify({ status: status || 'done', inspector: '点検員' + room, visitTimes: ['10:00'], photos: [] });
}
function overrideValue(room) {
  return JSON.stringify({ time: '1' + (room.length > 2 ? room.slice(-2) : '00'), updatedBy: '点検員' });
}

/* ================================================================
   O / C / D: 通信回数
   ================================================================ */
async function testRequestCountReduction() {
  console.log('\n==== C/D/O. 129室でも1回の更新あたりの通信は2回(旧実装は258回) ====');
  var rooms = make129Rooms();
  var e = makeEnv();
  rooms.forEach(function (r) {
    e.putRemote(PID_A, 'fireflow-binder:' + r, binderValue(r));
    e.putRemote(PID_A, 'fireflow-schedule-override:' + r, overrideValue(r));
  });
  e.ctx.FLOORS = roomsToFloors(rooms);

  // 旧実装(参照)の通信回数
  e.resetCounts();
  await referenceOldPerRoomRead(e.ctx, rooms, e.ctx.keyFor);
  var oldBinderGets = e.counts.get;
  await referenceOldPerRoomRead(e.ctx, rooms, e.ctx.scheduleOverrideKeyFor);
  var oldTotal = e.counts.get;

  check('旧実装(参照)は binder だけで129回のGETを出す', oldBinderGets === 129, oldBinderGets);
  check('旧実装(参照)は binder + 点検時刻変更で258回のGETを出す', oldTotal === 258, oldTotal);

  // 新実装(loadAll 1回 = 定常pollingの1tick)
  e.resetCounts();
  await e.ctx.loadAll();
  check('C. 129室でも binder の1件ずつのremote GETは0回', e.counts.get === 0, e.counts.get);
  check('C/D. 129室でも通信は binder + 点検時刻変更 の2回だけ', e.counts.listValues === 2, e.counts.listValues);
  check('O. 1tickあたりの通信量が258回→2回へ削減されている(129倍の削減)',
    e.counts.listValues + e.counts.get === 2 && oldTotal === 258);
  check('O. 部屋数に関係なく通信回数が一定であること(部屋数を倍にしても2回)', await (async function () {
    var rooms2 = make129Rooms().concat(make129Rooms().map(function (r) { return 'B' + r; }));
    var e2 = makeEnv();
    rooms2.forEach(function (r) { e2.putRemote(PID_A, 'fireflow-binder:' + r, binderValue(r)); });
    e2.ctx.FLOORS = roomsToFloors(rooms2);
    e2.resetCounts();
    await e2.ctx.loadAll();
    return e2.counts.listValues === 2 && e2.counts.get === 0;
  })());

  // 通信が減っても画面の中身は入っていること
  check('129室すべての点検状態が復元されている',
    Object.keys(e.ctx.state).length === 129 && e.ctx.state['101'].inspector === '点検員101');
  check('129室すべての点検時刻変更が復元されている',
    Object.keys(e.ctx.scheduleOverrides).length === 129);
}

/* ================================================================
   E / F / G / H / I / J: 復元結果が旧実装と1件も違わないこと
   ================================================================ */
async function testRestoreIdenticalToOldImplementation() {
  console.log('\n==== E/G/H/I. 復元結果が旧実装(部屋ごとstorageGet)と完全一致 ====');
  var rooms = make129Rooms();
  var e = makeEnv();                       // flag OFF(実端末と同じ)
  // 保存が有る部屋・無い部屋・点検時刻変更だけ有る部屋を混在させる
  rooms.forEach(function (r, i) {
    if (i % 3 !== 0) e.putRemote(PID_A, 'fireflow-binder:' + r, binderValue(r, i % 2 ? 'done' : 'absent'));
    if (i % 5 === 0) e.putRemote(PID_A, 'fireflow-schedule-override:' + r, overrideValue(r));
  });
  e.ctx.FLOORS = roomsToFloors(rooms);

  var oldBinder = await referenceOldPerRoomRead(e.ctx, rooms, e.ctx.keyFor);
  var newBinder = await e.ctx.readRoomValuesBulk(rooms, e.ctx.keyFor, e.ctx.BINDER_KEY_PREFIX);
  check('G. binderの復元値が旧実装と1件も違わない(129室)', sameValues(oldBinder, newBinder));

  var oldOv = await referenceOldPerRoomRead(e.ctx, rooms, e.ctx.scheduleOverrideKeyFor);
  var newOv = await e.ctx.readRoomValuesBulk(rooms, e.ctx.scheduleOverrideKeyFor, e.ctx.SCHEDULE_OVERRIDE_KEY_PREFIX);
  check('H. 点検時刻変更の復元値が旧実装と1件も違わない(129室)', sameValues(oldOv, newOv));

  check('E. feature flag OFF のとき復元結果に差分0(旧挙動そのまま)',
    sameValues(oldBinder, newBinder) && sameValues(oldOv, newOv));

  var savedRooms = rooms.filter(function (r, i) { return i % 3 !== 0; });
  var unsavedRooms = rooms.filter(function (r, i) { return i % 3 === 0; });
  check('I. 保存が無い部屋は新旧ともnull(未点検の初期状態)で差分0', unsavedRooms.every(function (r) {
    var idx = rooms.indexOf(r);
    return newBinder[idx] === null && oldBinder[idx] === null;
  }));
  check('I. 保存が有る部屋だけ値が入る', savedRooms.length > 0 && savedRooms.every(function (r) {
    return newBinder[rooms.indexOf(r)] !== null;
  }));

  // 保存が無い部屋を loadAll が「未点検のまま」にしていること
  await e.ctx.loadAll();
  check('I. 保存が無い部屋は state に作られない', unsavedRooms.every(function (r) { return e.ctx.state[r] === undefined; }));
}

async function testPropertyScopeIsolation() {
  console.log('\n==== F. 物件スコープON相当: 他物件のデータ混入0 ====');
  var rooms = ['101', '102', '103'];
  var e = makeEnv({ scopeEnabled: true, currentPropertyId: PID_A });
  // 物件Aのスコープ済みキー
  rooms.forEach(function (r) {
    e.putRemote(PID_A, 'fireflow-binder:' + PID_A + ':' + r, binderValue(r));
    e.putRemote(PID_A, 'fireflow-schedule-override:' + PID_A + ':' + r, overrideValue(r));
  });
  /* 物件Bの行。property_id も キー内のpropertyId も別なので、絶対に拾ってはいけない。
     「同じ101号室」でも物件が違えば別物、はPhase 1Cで確定した一線。 */
  rooms.forEach(function (r) {
    e.putRemote(PID_B, 'fireflow-binder:' + PID_B + ':' + r, binderValue(r, 'BBB'));
  });
  /* さらに意地悪ケース: 物件Aの中に「スコープが付いていない旧形式のキー」が残っている場合。
     prefix一致では引っかかるが、部屋への割り当てはキーの完全一致で行うので混ざらない。 */
  e.putRemote(PID_A, 'fireflow-binder:101', binderValue('101', 'LEGACY'));

  e.ctx.FLOORS = roomsToFloors(rooms);
  await e.ctx.loadAll();

  check('F. 物件Aのスコープ済みデータだけが復元される',
    e.ctx.state['101'] && e.ctx.state['101'].inspector === '点検員101', e.ctx.state['101']);
  check('F. 他物件(B)のデータが1件も混入しない', rooms.every(function (r) {
    return e.ctx.state[r] && e.ctx.state[r].status !== 'BBB';
  }));
  check('F. スコープ未適用の旧形式キーが現物件のデータとして混入しない',
    e.ctx.state['101'].status !== 'LEGACY', e.ctx.state['101'].status);
  check('F. 点検時刻変更もスコープ済みのものだけ復元される',
    Object.keys(e.ctx.scheduleOverrides).length === 3);

  // スコープONでも通信回数は2回のまま
  e.resetCounts();
  await e.ctx.loadAll();
  check('F. 物件スコープONでも1tickの通信は2回', e.counts.listValues === 2 && e.counts.get === 0,
    { listValues: e.counts.listValues, get: e.counts.get });
}

async function testOfflineFallback() {
  console.log('\n==== J. オフライン: ローカル(IndexedDB)からの復元が維持される ====');
  var rooms = make129Rooms();
  var e = makeEnv();
  rooms.forEach(function (r) {
    e.putRemote(PID_A, 'fireflow-binder:' + r, binderValue(r));
    e.putRemote(PID_A, 'fireflow-schedule-override:' + r, overrideValue(r));
  });
  e.ctx.FLOORS = roomsToFloors(rooms);

  // オンラインで1度読み、ローカルキャッシュを温める(まとめ取り経路がキャッシュを書くこと自体の確認)
  await e.ctx.loadAll();
  check('J. まとめ取りで得た値はローカル(IndexedDB)にも保存される(オフライン復元の元になる)',
    e.idb.cache['shared:fireflow-binder:101'] &&
    e.idb.cache['shared:fireflow-binder:101'].value === binderValue('101'));
  check('J. 点検時刻変更もローカルへ保存される', !!e.idb.cache['shared:fireflow-schedule-override:101']);

  // オフラインにして、別のメモリ状態から読み直す
  e.env.offline = true;
  e.ctx.state = {}; e.ctx.lastRawByRoom = {};
  e.ctx.scheduleOverrides = {}; e.ctx.lastRawScheduleOverrideByRoom = {};
  e.resetCounts();
  await e.ctx.loadAll();
  check('J. オフラインでも129室すべてローカルから復元される',
    Object.keys(e.ctx.state).length === 129 && e.ctx.state['101'].inspector === '点検員101',
    Object.keys(e.ctx.state).length);
  check('J. オフライン時に1件ずつのremote GETへ切り替わらない(通信量が元に戻らない)',
    e.counts.get === 0, e.counts.get);

  // 旧実装(参照)もオフラインでは同じくローカルから復元する。差分0であること。
  var oldOffline = await referenceOldPerRoomRead(e.ctx, rooms, e.ctx.keyFor);
  var newOffline = await e.ctx.readRoomValuesBulk(rooms, e.ctx.keyFor, e.ctx.BINDER_KEY_PREFIX);
  check('J. オフライン時の復元値が旧実装と差分0', sameValues(oldOffline, newOffline));

  /* リモートには在るがローカルには無い、の逆(ローカルにだけ在る)ケース。
     旧実装は「リモートが404→キャッシュ」で拾えた。まとめ取りでも同じく拾えること。 */
  var e2 = makeEnv();
  e2.putCache('shared:fireflow-binder:101', binderValue('101'));
  e2.ctx.FLOORS = [{ floor: '1階', rooms: ['101', '102'] }];
  e2.resetCounts();
  await e2.ctx.loadAll();
  check('J. リモートに無くローカルにだけ在る部屋も復元される(旧実装と同じ)',
    e2.ctx.state['101'] && e2.ctx.state['101'].inspector === '点検員101');
  check('J. その場合も追加の1件取得は発生しない', e2.counts.get === 0, e2.counts.get);
}

/* ================================================================
   A / B / N: 再入ガード
   ================================================================ */
async function testReentrancyGuard() {
  console.log('\n==== A/B/N. loadAll の再入ガード ====');
  var rooms = make129Rooms();
  var e = makeEnv({ slowMs: 30 });   // 1tick(1秒)より遅い通信を模す
  rooms.forEach(function (r) { e.putRemote(PID_A, 'fireflow-binder:' + r, binderValue(r)); });
  e.ctx.FLOORS = roomsToFloors(rooms);

  e.resetCounts();
  // 1秒ごとのsetIntervalで、前回が終わらないうちに5tick来た状況
  var tick1 = e.ctx.loadAll();
  var tick2 = e.ctx.loadAll();
  var tick3 = e.ctx.loadAll();
  var tick4 = e.ctx.loadAll();
  var tick5 = e.ctx.loadAll();
  check('A. 実行中は loadAllInFlight が立つ', e.ctx.loadAllInFlight === true);
  await Promise.all([tick1, tick2, tick3, tick4, tick5]);

  check('A. 同時に走る loadAll は最大1本(5tick重なっても通信は2回だけ)',
    e.counts.listValues === 2, e.counts.listValues);
  check('N. 前回が未完了なら次のtickはskipされる(重なった4tickは通信0)',
    e.counts.get === 0 && e.counts.listValues === 2);
  check('A. 完了後は loadAllInFlight が解除される', e.ctx.loadAllInFlight === false);

  // 完了後の次のtickはちゃんと動く(ガードが居座らない)
  e.resetCounts();
  await e.ctx.loadAll();
  check('A. 完了後の次のtickは通常どおり実行される', e.counts.listValues === 2, e.counts.listValues);

  /* B. 途中で例外が出てもロックが残らないこと。
     renderFloors() を1回だけ失敗させる(loadAllInner の最後で呼ばれる)。 */
  var e2 = makeEnv();
  e2.putRemote(PID_A, 'fireflow-binder:101', binderValue('101'));
  e2.ctx.FLOORS = [{ floor: '1階', rooms: ['101'] }];
  e2.ctx.renderFloorsThrows = true;
  var threw = false;
  try { await e2.ctx.loadAll(); } catch (err) { threw = true; }
  check('B. loadAll 内部の例外は握りつぶされず呼び出し元へ伝わる', threw);
  check('B. 例外が出ても loadAllInFlight は解除される(finally)', e2.ctx.loadAllInFlight === false);
  e2.resetCounts();
  await e2.ctx.loadAll();
  check('B. 例外の次のtickは正常に実行される(pollingが永久停止しない)',
    e2.counts.listValues === 2, e2.counts.listValues);

  /* パネルを開いている間はloadAllしない、という既存挙動を壊していないこと。
     かつ、その早期returnでロックを掴んだままにしないこと。 */
  var e3 = makeEnv();
  e3.ctx.document.getElementById = function () { return { style: { display: 'block' } }; };
  e3.resetCounts();
  await e3.ctx.loadAll();
  check('A. パネルを開いている間は従来どおり読み込まない', e3.counts.listValues === 0);
  check('A. 早期returnでロックを掴んだままにしない', e3.ctx.loadAllInFlight === false);
}

/* ================================================================
   M: 起動時 loadAll
   ================================================================ */
async function testStartupLoad() {
  console.log('\n==== M. 起動時の loadAll ====');
  var rooms = make129Rooms();
  var e = makeEnv();
  rooms.forEach(function (r) {
    e.putRemote(PID_A, 'fireflow-binder:' + r, binderValue(r));
    e.putRemote(PID_A, 'fireflow-schedule-override:' + r, overrideValue(r));
  });
  e.ctx.FLOORS = roomsToFloors(rooms);
  e.resetCounts();
  await e.ctx.loadAll();   // 起動直後の1回目(runMainAppBootSequence 相当)
  check('M. 起動時の1回目で129室すべて復元される', Object.keys(e.ctx.state).length === 129);
  check('M. 起動時も通信は2回', e.counts.listValues === 2, e.counts.listValues);
  check('M. 変化があったので再描画される', e.ctx.renderFloorsCount === 1, e.ctx.renderFloorsCount);

  // 2回目は変化なし → 再描画しない(既存の差分検出が働いていること)
  e.resetCounts();
  var before = e.ctx.renderFloorsCount;
  await e.ctx.loadAll();
  check('M. 変化が無いtickでは再描画しない(既存の差分検出を壊していない)',
    e.ctx.renderFloorsCount === before, e.ctx.renderFloorsCount);

  // 他端末が1室だけ更新 → その変化を拾って再描画する(polling の役目を維持)
  e.putRemote(PID_A, 'fireflow-binder:101', binderValue('101', 'absent'));
  await e.ctx.loadAll();
  check('M. 他端末の更新を1tickで拾って反映する(pollingの役目を維持)',
    e.ctx.state['101'].status === 'absent' && e.ctx.renderFloorsCount === before + 1);
}

/* ================================================================
   K / L: outbox・StampStore を巻き込んでいないこと
   ================================================================ */
function testNoOutboxNoStampStoreImpact() {
  console.log('\n==== K/L. outbox・StampStore へ影響しないこと(ソース検査) ====');
  var bulkSrc = stripComments(extractFunctionSource('readRoomValuesBulk'));
  var listValuesSrc = stripComments(extractFunctionSource('storageListValues'));
  var cacheSrc = stripComments(extractFunctionSource('readValueFromLocalCache'));
  var innerSrc = stripComments(extractFunctionSource('loadAllInner'));
  var loadAllSrc = stripComments(extractFunctionSource('loadAll'));
  var all = [bulkSrc, listValuesSrc, cacheSrc, innerSrc, loadAllSrc].join('\n');

  ['outbox', 'flushOutbox(', 'scheduleOutboxRetry('].forEach(function (needle) {
    check('K. 読み込み経路が ' + needle + ' に触らない', all.indexOf(needle) === -1);
  });
  ['stampStore', 'StampStore', 'STAMP_DATA'].forEach(function (needle) {
    check('L. 読み込み経路が ' + needle + ' に触らない', all.indexOf(needle) === -1);
  });
  ['storageSet(', 'storageDelete(', 'lcDelete('].forEach(function (needle) {
    check('K/L. 読み込み経路が ' + needle + ' を呼ばない(読み込みが保存を壊さない)',
      all.indexOf(needle) === -1);
  });
  // ローカルへの書き戻しは cache ストアだけ(outbox へは1件も積まない)
  check('K. ローカルへの書き戻し先は cache ストアだけ',
    listValuesSrc.indexOf("lcPut('cache'") !== -1 && listValuesSrc.indexOf("lcPut('outbox'") === -1);
}

async function testOutboxUntouchedAtRuntime() {
  console.log('\n==== K. outbox が実行時にも増減しないこと ====');
  var e = makeEnv();
  e.putRemote(PID_A, 'fireflow-binder:101', binderValue('101'));
  e.ctx.FLOORS = [{ floor: '1階', rooms: ['101', '102'] }];
  e.idb.outbox['shared:fireflow-binder:999'] = { key: 'shared:fireflow-binder:999', value: 'pending', propertyId: null };
  var before = JSON.stringify(e.idb.outbox);
  await e.ctx.loadAll();
  e.env.offline = true;
  await e.ctx.loadAll();          // オフラインでも outbox を触らない
  check('K. loadAll の前後で outbox が1件も変わらない(オンライン・オフラインとも)',
    JSON.stringify(e.idb.outbox) === before, e.idb.outbox);
  check('K. 送信(set)・削除(delete)が1度も発生しない', e.counts.set === 0 && e.counts.delete === 0);
}

/* ================================================================
   保存キーの形式・整合
   ================================================================ */
function testKeyFormatUnchanged() {
  console.log('\n==== 保存キーの形式を変えていないこと ====');
  var e = makeEnv();
  check('binderの保存キーは従来どおり fireflow-binder:<部屋>', e.ctx.keyFor('1304') === 'fireflow-binder:1304');
  check('点検時刻変更の保存キーは従来どおり fireflow-schedule-override:<部屋>',
    e.ctx.scheduleOverrideKeyFor('1304') === 'fireflow-schedule-override:1304');
  // まとめ取り用のprefixが、部屋ごとのキーと必ず一致すること(ここがずれると復元できなくなる)
  check('BINDER_KEY_PREFIX が keyFor() の先頭と一致する',
    e.ctx.keyFor('1304').indexOf(e.ctx.BINDER_KEY_PREFIX) === 0 &&
    e.ctx.keyFor('1304') === e.ctx.BINDER_KEY_PREFIX + '1304');
  check('SCHEDULE_OVERRIDE_KEY_PREFIX が scheduleOverrideKeyFor() の先頭と一致する',
    e.ctx.scheduleOverrideKeyFor('1304') === e.ctx.SCHEDULE_OVERRIDE_KEY_PREFIX + '1304');
  // prefixがLIKEのワイルドカード(% _)を含まないこと(含むと別キーまで拾ってしまう)
  check('prefixにLIKEのワイルドカードが含まれない',
    !/[%_]/.test(e.ctx.BINDER_KEY_PREFIX) && !/[%_]/.test(e.ctx.SCHEDULE_OVERRIDE_KEY_PREFIX));
}

function testSupabaseShimContract() {
  console.log('\n==== window.storage.listValues の絞り込み条件(supabase-integration.js) ====');
  var idx = sbjs.indexOf('async listValues(');
  check('window.storage に listValues が実装されている', idx !== -1);
  var body = sbjs.slice(idx, idx + 900);
  check('listValues は property_id で絞り込む', body.indexOf("eq('property_id', currentPropertyId)") !== -1);
  check('listValues は shared で絞り込む', body.indexOf("eq('shared', !!shared)") !== -1);
  check('listValues は shared=true のとき owner_id is null で絞り込む(get/listと同じ)',
    body.indexOf("is('owner_id', null)") !== -1 && body.indexOf("eq('owner_id', currentUser.id)") !== -1);
  check('listValues は prefix の前方一致で絞り込む', body.indexOf("like('key', prefix + '%')") !== -1);
  check('listValues は key と value だけを取得する(余計な列を取らない)',
    body.indexOf("select('key,value')") !== -1);
  check('listValues は失敗を例外で伝える(list()のように黙って空を返さない)',
    body.indexOf('if (error) throw error;') !== -1);
  // 既存の get / list / set / delete は1文字も変えていないこと
  check('既存の list() は従来どおりキーだけを返す実装のまま',
    sbjs.indexOf("async list(prefix, shared, propertyId)") !== -1 &&
    sbjs.indexOf("return { keys: (data || []).map(function (r) { return r.key; }), prefix: prefix, shared: !!shared };") !== -1);
}

/* ================================================================
   更新の起こし方(2026-08-22改訂)

   【この節が2026-08-19版から反転した理由】
   2026-08-19版はここで「setInterval(loadAll, 1000) が維持されていること」を要求していた。
   しかし2026-08-22の実Safari(localhost:3000)で、何も操作していないのに kv_store への
   リクエストが短時間で148件出続けることが確認され、そのURLは
     select=key,value & key=like.fireflow-schedule-override:%25
   すなわち loadAllInner() のまとめ取りそのものだった。1tickの通信量(258→2)は直っていても、
   1秒ごとに叩き続ける設計自体が storm の残りだった(2 GET/秒 × 74秒 = 148件)。
   よってこのテストは「1秒ポーリングが存在しないこと」を要求する側へ反転する。
   ページ全体のIDLE通信量そのものは page_wide_idle_request_verify.js が測る。
   ================================================================ */
function testPollingConfiguration() {
  console.log('\n==== 更新の起こし方(1秒ポーリング廃止) ====');
  var htmlNoComments = stripComments(html);
  check('1秒ごとの loadAll ポーリングが存在しない(IDLE中に定期GETしない)',
    htmlNoComments.indexOf('setInterval(loadAll') === -1);
  check('loadAll を setInterval で回す記述が1件も無い',
    !/setInterval\(\s*(function[^)]*\{\s*)?loadAll\s*\(/.test(htmlNoComments));
  check('起動時の loadAll() は残っている', /\n\s*loadAll\(\);/.test(html));
  // 読み直しの起動口が、必要なイベントすべてに繋がっていること(退行検知)
  var triggersSrc = stripComments(extractFunctionSource('installRemoteRefreshTriggers'));
  ["'online'", "'focus'", "'visibilitychange'", "'sb-realtime-update'", "'sb-realtime-status'"]
    .forEach(function (needle) {
      check('読み直しの起動口が ' + needle + ' に繋がっている', triggersSrc.indexOf(needle) !== -1);
    });
  check('起動シーケンスが読み直しの起動口を設置する',
    htmlNoComments.indexOf('installRemoteRefreshTriggers();') !== -1);
  check('物件切替(Excel取込・新規作成)から読み直しを依頼する',
    (htmlNoComments.match(/requestRemoteRefresh\('property-change'\)/g) || []).length >= 2);
  check('パネルを閉じたときの持ち越しがある',
    stripComments(extractFunctionSource('hideBackdrop')).indexOf('loadAllDeferredRefresh') !== -1);
  // loadAll が1件ずつの storageGet へ戻っていないこと(退行検知)
  var innerSrc = stripComments(extractFunctionSource('loadAllInner'));
  check('loadAll の本体が部屋ごとの storageGet を呼ばない(退行検知)',
    innerSrc.indexOf('storageGet(') === -1, innerSrc.indexOf('storageGet('));
  check('loadAll の本体はまとめ取り(readRoomValuesBulk)を使う',
    innerSrc.indexOf('readRoomValuesBulk(') !== -1);
}

async function main() {
  testKeyFormatUnchanged();
  await testRequestCountReduction();
  await testRestoreIdenticalToOldImplementation();
  await testPropertyScopeIsolation();
  await testOfflineFallback();
  await testReentrancyGuard();
  await testStartupLoad();
  testNoOutboxNoStampStoreImpact();
  await testOutboxUntouchedAtRuntime();
  testSupabaseShimContract();
  testPollingConfiguration();

  var passed = results.filter(function (r) { return r.ok; }).length;
  var failed = results.length - passed;
  console.log('\n==== request_storm_fix_verify 総合結果: ' + (failed === 0 ? 'PASS' : 'FAIL')
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
