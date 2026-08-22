// [2026-08-22新設] TEST-V: request storm 第2原因(StampStore)の修正に対する回帰テスト。
//
// 【直した対象】
// StampStore.loadAll() は「キー一覧 → キーごとに adapters.get()」という形で復元しており、
// index.html の結線では adapters.get = storageGet = kv_store の1件GETだった。
// そのため実端末(StampStore 259件)ではページを開くたびに
//     select=id&property_id=eq.<uuid>&key=eq.stamp:コスモ六甲ガーデンフォート:102&shared=eq.true
// という形のGETが259回飛んでいた(2026-08-22 実Safari / localhost:3000 で実測)。
// これを prefix 1回のまとめ取り(既存の readRoomValuesBulk 経路)へ置き換えた。
//
// 【このテストが守る一線】
// 「通信は減ったが復元結果が変わってしまった」を起こさないこと。そのため復元値は必ず
// 【旧実装(キーごとに storageGet)をテスト内に独立して書き起こした参照実装】と1件ずつ
// 突き合わせる。期待値をベタ書きしないので、「テストの期待値を新実装へ合わせて書き換えた
// から通った」は原理的に起こらない。
//
// 【製品コードは一切書き換えない】
// 既存の public/test/*.js と同じく、index.html / stamp_store.js の実ソースを文字列で
// 取り出して Node.js の vm で実行する。StampStoreへのアダプタ結線も実ソースをそのまま使う
// (ここを写経すると、テストだけ通って実LBが壊れている状態を作れてしまうため)。
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

var PID_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
// 実端末で実測した物件名(スコープの区切りに日本語が入る形をそのまま使う)
var PROP_A = 'コスモ六甲ガーデンフォート';
var PROP_B = 'コスモ城東野江ロイヤルフォルム';

function extractFunctionSource(name) {
  var marker = 'function ' + name + '(';
  var startIdx = html.indexOf(marker);
  if (startIdx === -1) throw new Error('MISSING IMPLEMENTATION SOURCE: function ' + name);
  var i = html.indexOf('{', startIdx);
  var depth = 0;
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  if (depth !== 0) throw new Error('関数 ' + name + ' の波括弧の対応が取れませんでした');
  if (html.slice(Math.max(0, startIdx - 6), startIdx) === 'async ') startIdx -= 6;
  return html.slice(startIdx, i);
}
function extractVarDeclSource(name) {
  var marker = 'var ' + name + ' = ';
  var startIdx = html.indexOf(marker);
  if (startIdx === -1) throw new Error('MISSING IMPLEMENTATION SOURCE: var ' + name);
  return html.slice(startIdx, html.indexOf(';', startIdx) + 1);
}
/* 経緯を説明するコメント中にも storageGet 等の名前が出るので、ソース検査の前に落とす
   (request_storm_fix_verify.js と同じ考え方)。 */
function stripComments(src) {
  return String(src).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
/* StampStoreへのアダプタ結線を index.html の実ソースから取り出す
   (stampStorageAdapterRoundTrip.test.ts と同じ手法)。 */
function extractStampStoreWiring() {
  var marker = 'window.FireFlowStampStore.createStampStore(';
  var markerIdx = html.indexOf(marker);
  if (markerIdx === -1) throw new Error('MISSING: createStampStore の結線');
  var objStart = html.indexOf('{', markerIdx);
  var i = objStart;
  var depth = 0;
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
  extractVarDeclSource('PROPERTY_SCOPE_ENABLED'),
  extractVarDeclSource('PROPERTY_SCOPED_KEY_PREFIXES'),
  extractVarDeclSource('PROPERTY_SCOPED_EXACT_KEYS'),
  extractFunctionSource('isPropertyScopedKey'),
  extractFunctionSource('propertyScopedKey'),
  extractFunctionSource('propertyUnscopedKey'),
  extractFunctionSource('isValidScopePropertyId'),
  extractFunctionSource('currentScopePropertyId'),
  extractFunctionSource('applyPropertyScope'),
  extractFunctionSource('lcCacheKey'),
  extractFunctionSource('storageSet'),
  extractFunctionSource('storageGet'),
  extractFunctionSource('storageDelete'),
  extractFunctionSource('storageList'),
  extractFunctionSource('storageListValues'),
  extractFunctionSource('readValueFromLocalCache'),
  extractFunctionSource('readRoomValuesBulk'),
  extractFunctionSource('listKeysLocalFirst'),
].join('\n\n');

/* ================================================================
   観測可能なフェイク: IndexedDB と Supabase(kv_store)
   ================================================================ */
function makeEnv(options) {
  options = options || {};
  var idb = { cache: {}, outbox: {} };
  var remoteRows = [];
  var counts = { get: 0, list: 0, listValues: 0, set: 0, delete: 0 };
  var getKeys = [];      // 1件GETが飛んだキー(storm検知用)
  var state = {
    currentPropertyId: options.currentPropertyId !== undefined ? options.currentPropertyId : PID_A,
    offline: !!options.offline,
    remoteError: !!options.remoteError,
    noListValues: !!options.noListValues,
  };

  function resolveProperty(propertyId) { return propertyId ? propertyId : state.currentPropertyId; }
  function findRow(propertyId, key, shared) {
    for (var i = 0; i < remoteRows.length; i++) {
      var r = remoteRows[i];
      if (r.property_id === propertyId && r.key === key && r.shared === !!shared) return r;
    }
    return null;
  }
  function down() { return state.offline || state.remoteError; }

  /* 本物の window.storage シム(supabase-integration.js)と同じ絞り込み規則。 */
  var storage = {
    get: function (key, shared, propertyId) {
      counts.get++;
      getKeys.push(key);
      return Promise.resolve().then(function () {
        if (down()) throw new Error('remote down');
        var row = findRow(resolveProperty(propertyId), key, shared);
        if (!row) throw new Error('key not found: ' + key);
        return { key: key, value: row.value, shared: !!shared };
      });
    },
    list: function (prefix, shared, propertyId) {
      counts.list++;
      return Promise.resolve().then(function () {
        if (down()) return null;
        var pid = resolveProperty(propertyId);
        return {
          keys: remoteRows.filter(function (r) {
            return r.property_id === pid && r.shared === !!shared && String(r.key).indexOf(prefix) === 0;
          }).map(function (r) { return r.key; }),
          prefix: prefix, shared: !!shared,
        };
      });
    },
    set: function (key, value, shared, propertyId) {
      counts.set++;
      return Promise.resolve().then(function () {
        if (down()) throw new Error('remote down');
        var pid = resolveProperty(propertyId);
        var row = findRow(pid, key, shared);
        if (row) { row.value = String(value); }
        else { remoteRows.push({ property_id: pid, key: key, value: String(value), shared: !!shared }); }
        return { key: key, value: value, shared: !!shared };
      });
    },
    delete: function (key, shared, propertyId) {
      counts.delete++;
      return Promise.resolve().then(function () {
        if (down()) throw new Error('remote down');
        var pid = resolveProperty(propertyId);
        for (var i = 0; i < remoteRows.length; i++) {
          if (remoteRows[i].property_id === pid && remoteRows[i].key === key && remoteRows[i].shared === !!shared) {
            remoteRows.splice(i, 1); break;
          }
        }
        return { key: key, deleted: true, shared: !!shared };
      });
    },
  };
  if (!state.noListValues) {
    storage.listValues = function (prefix, shared, propertyId) {
      counts.listValues++;
      return Promise.resolve().then(function () {
        if (down()) throw new Error('remote down');
        var pid = resolveProperty(propertyId);
        return {
          items: remoteRows.filter(function (r) {
            return r.property_id === pid && r.shared === !!shared && String(r.key).indexOf(prefix) === 0;
          }).map(function (r) { return { key: r.key, value: r.value }; }),
          prefix: prefix, shared: !!shared,
        };
      });
    };
  }

  var ctx = {
    JSON: JSON, Object: Object, Array: Array, String: String, Number: Number, Boolean: Boolean,
    Promise: Promise, Date: Date, Error: Error, console: console, setTimeout: setTimeout,
    window: {
      storage: storage,
      getCurrentPropertyId: function () { return state.currentPropertyId; },
      FIREFLOW_PROPERTY_SCOPE_ENABLED: !!options.scopeEnabled,
    },
    lcPut: function (store, record) { idb[store][record.key] = record; return Promise.resolve(); },
    lcGet: function (store, key) { return Promise.resolve(idb[store][key] || null); },
    lcDelete: function (store, key) { delete idb[store][key]; return Promise.resolve(); },
    lcGetAll: function (store) {
      return Promise.resolve(Object.keys(idb[store]).map(function (k) { return idb[store][k]; }));
    },
    updateSyncBadge: function () {},
    scheduleOutboxRetry: function () {},
    currentScopePropertyIdOverride: null,
  };
  ctx.window.window = ctx.window;
  vm.createContext(ctx);
  vm.runInContext(storeSrc, ctx);      // ブラウザと同じ stamp_store.js
  vm.runInContext(PRODUCT_SRC, ctx);   // index.html の保存層(実ソース)
  vm.runInContext(extractStampStoreWiring(), ctx);  // 実LBと同じアダプタ結線

  return {
    ctx: ctx, idb: idb, counts: counts, getKeys: getKeys, env: state, remoteRows: remoteRows,
    store: ctx.stampStore,
    putRemote: function (key, value) {
      var row = findRow(PID_A, key, true);
      if (row) { row.value = value; return; }
      remoteRows.push({ property_id: PID_A, key: key, value: value, shared: true });
    },
    putCache: function (rawKey, value) {
      idb.cache['shared:' + rawKey] = { key: 'shared:' + rawKey, value: value, updatedAt: 1 };
    },
    resetCounts: function () {
      counts.get = 0; counts.list = 0; counts.listValues = 0; counts.set = 0; counts.delete = 0;
      getKeys.length = 0;
    },
  };
}

/* 129室 / 259件ぶんの部屋番号 */
function makeRooms(n) {
  var rooms = [];
  for (var floor = 1; rooms.length < n; floor++) {
    for (var i = 1; i <= 10 && rooms.length < n; i++) rooms.push(String(floor * 100 + i));
  }
  return rooms;
}

function stampKey(prop, room) { return 'stamp:' + prop + ':' + room; }
function recordValue(room, extra) {
  var base = {
    schema_version: 1, property_key: PROP_A, room: room,
    symbol: (Number(room) % 2 === 0) ? 'A' : '', time_start: '09:30', time_end: '',
    time_mode: 'exact', note: '朝一' + room, note_raw: '朝一' + room, name: '',
    schedule_date: '', schedule_day: null,
    raw_checkboxes: { a: true, p: false, cancel: false },
    symbol_review: false, time_review: false, note_review: false, other_review: false,
    needs_review: false, review_reason: [], source: 'standardized_stamp_sheet',
    updated_at: '2026-08-20T00:00:00.000Z',
  };
  return JSON.stringify(Object.assign(base, extra || {}));
}

/* ================================================================
   参照実装: 修正前(旧loadAll)の取得経路をテスト側へ独立して書き起こしたもの。
   「キー一覧 → キーごとに adapters.get() → JSON.parse → buildRecord」。
   新実装の復元結果は、必ずこれと一致しなければならない。
   ================================================================ */
async function referenceOldLoadAll(e, propertyKey, knownRooms) {
  var StampStore = e.ctx.window.FireFlowStampStore;
  var scope = StampStore.normalizePropertyKey(propertyKey);
  var prefix = 'stamp:' + scope + ':';
  var known = knownRooms ? knownRooms.slice() : null;
  var keys = await e.ctx.listKeysLocalFirst(prefix);
  var out = {};
  var restored = [];
  for (var i = 0; i < keys.length; i++) {
    var room = String(keys[i]).slice(prefix.length);
    if (!room) continue;
    if (known && known.indexOf(room) === -1) continue;
    var value = await e.ctx.storageGet(keys[i], true)
      .then(function (r) { return r ? r.value : null; })
      .catch(function () { return null; });
    if (!value) continue;
    var parsed = null;
    try { parsed = (typeof value === 'string') ? JSON.parse(value) : value; } catch (err) { parsed = null; }
    if (!parsed || typeof parsed !== 'object') continue;
    out[room] = StampStore.buildRecord(Object.assign({}, parsed, { room: room }),
      { propertyKey: scope, now: parsed.updated_at });
    restored.push(room);
  }
  return { records: out, restored: restored };
}

function sameRecords(a, b) {
  var ka = Object.keys(a).sort();
  var kb = Object.keys(b).sort();
  if (ka.length !== kb.length) return false;
  for (var i = 0; i < ka.length; i++) {
    if (ka[i] !== kb[i]) return false;
    if (JSON.stringify(a[ka[i]]) !== JSON.stringify(b[kb[i]])) return false;
  }
  return true;
}

/* ================================================================
   A / B / J / 11. 通信回数
   ================================================================ */
async function testRequestCount() {
  console.log('\n==== A/B/J. StampStore復元のremote GET回数 ====');

  // A. 129室
  var rooms129 = makeRooms(129);
  var e = makeEnv();
  rooms129.forEach(function (r) { e.putRemote(stampKey(PROP_A, r), recordValue(r)); });
  e.store.setPropertyKey(PROP_A);
  e.resetCounts();
  var loaded = await e.store.loadAll({ knownRooms: rooms129 });
  check('A. 129室でも1件ずつのremote GET(key=eq.stamp:...)は0回', e.counts.get === 0, e.counts.get);
  check('A. 129室でもremote GETが129回にならない', e.counts.get < 129, e.counts.get);
  check('A. 129室すべてが復元される', loaded.restored.length === 129, loaded.restored.length);
  check('11. 復元1回あたりの通信は数回だけ(list 1 + listValues 1)',
    e.counts.list === 1 && e.counts.listValues === 1,
    { list: e.counts.list, listValues: e.counts.listValues, get: e.counts.get });

  // B. 259件(実端末の件数)
  var rooms259 = makeRooms(259);
  var e2 = makeEnv();
  rooms259.forEach(function (r) { e2.putRemote(stampKey(PROP_A, r), recordValue(r)); });
  e2.store.setPropertyKey(PROP_A);
  e2.resetCounts();
  var loaded2 = await e2.store.loadAll({ knownRooms: rooms259 });
  check('B. 259件でも1件ずつのremote GETは0回', e2.counts.get === 0, e2.counts.get);
  check('B. 259件でもremote GETが259回にならない', e2.counts.get < 259, e2.counts.get);
  check('B. 259件すべてが復元される', loaded2.restored.length === 259, loaded2.restored.length);
  check('11. 件数が倍になっても通信回数が増えない(部屋数に比例しない)',
    e2.counts.list === e.counts.list && e2.counts.listValues === e.counts.listValues,
    { small: e.counts.listValues, large: e2.counts.listValues });

  // 実測されたstormの形そのもの: key=eq.stamp:コスモ六甲ガーデンフォート:102 が飛ばないこと
  check('実測されたstormの形(key=eq.stamp:' + PROP_A + ':102 の単発GET)が1回も飛ばない',
    e2.getKeys.indexOf(stampKey(PROP_A, '102')) === -1, e2.getKeys.slice(0, 3));

  // 旧実装(参照)は本当に件数ぶんのGETを出していたのか(退行検知の土台)
  var e3 = makeEnv();
  rooms259.forEach(function (r) { e3.putRemote(stampKey(PROP_A, r), recordValue(r)); });
  e3.resetCounts();
  await referenceOldLoadAll(e3, PROP_A, rooms259);
  check('旧実装(参照)は259件で259回のGETを出していた(修正前の実態)', e3.counts.get === 259, e3.counts.get);
}

/* ================================================================
   C / D / F / G. 復元結果が旧実装と一致し、物件をまたがない
   ================================================================ */
async function testRestoreIdentical() {
  console.log('\n==== C/D/F/G. 復元結果が旧実装と完全一致 / 別物件の混入0 ====');
  var rooms = makeRooms(129);
  var e = makeEnv();
  // 保存が有る部屋・無い部屋・要確認の部屋・壊れた値を混在させる
  rooms.forEach(function (r, i) {
    if (i % 4 === 3) return;                                   // 保存が無い部屋
    if (i % 7 === 0) {
      e.putRemote(stampKey(PROP_A, r), recordValue(r, {
        symbol: '', symbol_review: true, needs_review: true, review_reason: ['複数チェック'],
      }));
      return;
    }
    e.putRemote(stampKey(PROP_A, r), recordValue(r));
  });
  e.putRemote(stampKey(PROP_A, '9999'), '{壊れたJSON');          // 壊れた値
  // 同じ部屋番号を持つ「別物件」のデータ。1件も混ざってはいけない。
  rooms.forEach(function (r) {
    e.putRemote(stampKey(PROP_B, r), recordValue(r, { note: 'BBB', property_key: PROP_B }));
  });

  var ref = await referenceOldLoadAll(e, PROP_A, rooms);
  e.store.setPropertyKey(PROP_A);
  await e.store.loadAll({ knownRooms: rooms });
  var now = e.store.all();

  check('C. 通常stamp復元の結果が旧実装と1件も違わない', sameRecords(ref.records, now),
    { old: Object.keys(ref.records).length, now: Object.keys(now).length });
  check('D. stamp:<物件名>:<部屋> の復元結果が一致する(記号・時刻・備考・要確認まで)',
    JSON.stringify(now['102']) === JSON.stringify(ref.records['102']) &&
    now['102'] && now['102'].time_start === '09:30');
  check('D. 要確認(needs_review)の部屋もそのまま復元される',
    Object.keys(now).some(function (r) { return now[r].needs_review === true && now[r].symbol_review === true; }));
  check('保存が無い部屋は復元されない(未点検のまま)',
    rooms.filter(function (r, i) { return i % 4 === 3; }).every(function (r) { return now[r] === undefined; }));
  check('壊れた値は復元されない(旧実装と同じく黙って捨てる)', now['9999'] === undefined);

  check('F. 別物件名(' + PROP_B + ')のstampが1件も混入しない',
    Object.keys(now).every(function (r) { return now[r].note.indexOf('BBB') === -1; }));
  check('G. 同一部屋番号の別物件データが混入しない(102は現物件の値)',
    now['102'] && now['102'].note === '朝一102', now['102'] && now['102'].note);
  check('7. property scope が stamp:<PROPERTY.name>:<room> のまま(propertyId化していない)',
    e.store.keyFor('102') === stampKey(PROP_A, '102'), e.store.keyFor('102'));

  // MASTERに無い部屋は復元しない、という既存の一線を壊していないこと
  var e2 = makeEnv();
  ['101', '102', '103'].forEach(function (r) { e2.putRemote(stampKey(PROP_A, r), recordValue(r)); });
  e2.store.setPropertyKey(PROP_A);
  var loaded2 = await e2.store.loadAll({ knownRooms: ['101', '102'] });
  check('MASTERに無い部屋は復元せずskippedへ入る(既存の一線を維持)',
    loaded2.restored.length === 2 && loaded2.skipped.indexOf('103') !== -1,
    { restored: loaded2.restored, skipped: loaded2.skipped });
}

/* ================================================================
   E / N. 旧キー(fireflow-stamp:*)の扱いを変えていないこと
   ================================================================ */
async function testLegacyKeysUnchanged() {
  console.log('\n==== E/N. 旧キー(fireflow-stamp:*)の扱いを1ミリも広げていない ====');
  var rooms = ['101', '102', '103'];

  // (1) 現スコープに1件でも在れば、旧キーは取り込まない(従来どおり)
  var e = makeEnv();
  e.putRemote(stampKey(PROP_A, '101'), recordValue('101'));
  rooms.forEach(function (r) {
    e.putRemote('fireflow-stamp:' + r, JSON.stringify({ symbol: 'X', time: '08:00' }));
  });
  e.store.setPropertyKey(PROP_A);
  var loaded = await e.store.loadAll({ knownRooms: rooms });
  check('N. 現物件に1件でも在れば旧キーを取り込まない(自動割当を増やしていない)',
    loaded.migrated.length === 0, loaded.migrated);
  check('N. 旧キーの値(X/08:00)が現物件へ入らない',
    e.store.get('102') === null && e.store.get('103') === null);

  // (2) 現スコープが0件のときだけ取り込む(従来どおり)。取り込む部屋も従来と同じ。
  var e2 = makeEnv();
  rooms.forEach(function (r) {
    e2.putRemote('fireflow-stamp:' + r, JSON.stringify({ symbol: 'X', time: '08:00' }));
  });
  e2.putRemote('fireflow-stamp:9999', JSON.stringify({ symbol: 'Z' }));   // MASTERに無い部屋
  e2.store.setPropertyKey(PROP_A);
  var loaded2 = await e2.store.loadAll({ knownRooms: rooms });
  check('E. 旧キーの取り込み条件(現スコープ0件のときだけ)は従来のまま',
    loaded2.migrated.slice().sort().join(',') === '101,102,103', loaded2.migrated);
  check('E. MASTERに無い部屋は旧キーからも取り込まない', e2.store.get('9999') === null);
  check('E. 旧キーから取り込んだ値の中身も従来どおり(source=migrated_legacy)',
    e2.store.get('101') && e2.store.get('101').symbol === 'X' &&
    e2.store.get('101').time_start === '08:00' &&
    e2.store.get('101').source === 'migrated_legacy', e2.store.get('101'));
  check('N. 旧キーは削除しない(元データを失わない)',
    e2.remoteRows.some(function (r) { return r.key === 'fireflow-stamp:101'; }));

  // (3) skipLegacyMigration の既存挙動
  var e3 = makeEnv();
  rooms.forEach(function (r) { e3.putRemote('fireflow-stamp:' + r, JSON.stringify({ symbol: 'X' })); });
  e3.store.setPropertyKey(PROP_A);
  var loaded3 = await e3.store.loadAll({ knownRooms: rooms, skipLegacyMigration: true });
  check('N. skipLegacyMigration:true のときは1件も取り込まない(従来どおり)',
    loaded3.migrated.length === 0, loaded3.migrated);

  // (4) 旧キーの取り込みでも1件ずつのGETにならないこと
  var manyRooms = makeRooms(129);
  var e4 = makeEnv();
  manyRooms.forEach(function (r) {
    e4.putRemote('fireflow-stamp:' + r, JSON.stringify({ symbol: 'X', time: '08:00' }));
  });
  e4.store.setPropertyKey(PROP_A);
  e4.resetCounts();
  var loaded4 = await e4.store.loadAll({ knownRooms: manyRooms });
  check('E. 旧キーの取り込みでも1件ずつのremote GETは0回',
    e4.counts.get === 0 && loaded4.migrated.length === 129, e4.counts.get);
  check('N. 取り込む部屋数は従来と同じ(MASTERに在る129室のみ、増えていない)',
    loaded4.migrated.length === 129, loaded4.migrated.length);
}

/* ================================================================
   H / I / J. remote 0件・remote error のときローカルから復元
   ================================================================ */
async function testOfflineFallback() {
  console.log('\n==== H/I/J. remote 0件 / remote error でもローカルから復元 ====');
  var rooms = makeRooms(129);

  // H. remoteに1件も無く、ローカル(IndexedDB)にだけ在る
  var e = makeEnv();
  rooms.forEach(function (r) { e.putCache(stampKey(PROP_A, r), recordValue(r)); });
  e.store.setPropertyKey(PROP_A);
  e.resetCounts();
  var loaded = await e.store.loadAll({ knownRooms: rooms });
  check('H. remote 0件でもローカルから129室すべて復元される', loaded.restored.length === 129, loaded.restored.length);
  check('H. その場合も1件ずつのremote GETへ切り替わらない', e.counts.get === 0, e.counts.get);

  // I. remote error(500 / オフライン)
  var e2 = makeEnv();
  rooms.forEach(function (r) { e2.putRemote(stampKey(PROP_A, r), recordValue(r)); });
  e2.store.setPropertyKey(PROP_A);
  await e2.store.loadAll({ knownRooms: rooms });        // 1度オンラインで読み、ローカルを温める
  check('J. まとめ取りで得た値はローカル(IndexedDB)へも書き戻される(オフライン復元の元になる)',
    !!e2.idb.cache['shared:' + stampKey(PROP_A, '101')]);

  e2.env.remoteError = true;
  e2.store.clearMemory();
  e2.resetCounts();
  var loaded2 = await e2.store.loadAll({ knownRooms: rooms });
  check('I. remote error でも129室すべてローカルから復元される(空にならない)',
    loaded2.restored.length === 129, loaded2.restored.length);
  check('J. remote error 時に1件ずつのremote再取得へfallbackしない(通信量が元に戻らない)',
    e2.counts.get === 0, e2.counts.get);
  check('I. remote error 時に値が壊れない(旧実装と同じ値)',
    e2.store.get('102') && e2.store.get('102').note === '朝一102', e2.store.get('102'));

  // window.storage.listValues をまだ持たない環境(起動直後・古いシム)でも空にならないこと
  var e3 = makeEnv({ noListValues: true });
  rooms.forEach(function (r) { e3.putCache(stampKey(PROP_A, r), recordValue(r)); });
  e3.store.setPropertyKey(PROP_A);
  e3.resetCounts();
  var loaded3 = await e3.store.loadAll({ knownRooms: rooms });
  check('J. listValues非対応の環境でもローカルから復元でき、1件ずつGETもしない',
    loaded3.restored.length === 129 && e3.counts.get === 0,
    { restored: loaded3.restored.length, get: e3.counts.get });
}

/* ================================================================
   K / L / M. 保存・outbox・propertyId に差分0
   ================================================================ */
async function testSaveAndOutboxUntouched() {
  console.log('\n==== K/L/M. 保存側・outbox・propertyId に差分0 ====');
  var e = makeEnv();
  e.store.setPropertyKey(PROP_A);

  // K. 保存側の結果(キー・値・リモート行)が従来どおり
  var put = await e.store.putMany([
    { room: '101', symbol: 'A', time_start: '09:30', note: '朝一' },
    { room: '102', symbol: '', needs_review: true, review_reason: ['複数チェック'] },
  ], { knownRooms: ['101', '102'], source: 'standardized_stamp_sheet' });
  check('K. 保存側の受理結果が従来どおり(2室保存)', put.saved.length === 2 && put.rejected.length === 0, put);
  check('K. 保存キーは従来どおり stamp:<物件名>:<部屋>',
    !!e.remoteRows.filter(function (r) { return r.key === stampKey(PROP_A, '101'); }).length);
  check('K. ローカルキャッシュのキーも従来どおり shared: + stamp:<物件名>:<部屋>',
    !!e.idb.cache['shared:' + stampKey(PROP_A, '101')]);
  check('K. 点検済み・不在・キャンセル・署名・時刻などの値がそのまま保存される',
    JSON.parse(e.remoteRows.filter(function (r) { return r.key === stampKey(PROP_A, '101'); })[0].value).time_start === '09:30');

  // L. loadAll の前後で outbox が1件も変わらない
  e.idb.outbox['shared:stamp:dummy'] = { key: 'shared:stamp:dummy', value: 'pending', propertyId: null };
  var outboxBefore = JSON.stringify(e.idb.outbox);
  e.resetCounts();
  await e.store.loadAll({ knownRooms: ['101', '102'] });
  e.env.remoteError = true;
  await e.store.loadAll({ knownRooms: ['101', '102'] });
  check('L. loadAll の前後で outbox が1件も変わらない(オンライン・remote error とも)',
    JSON.stringify(e.idb.outbox) === outboxBefore, e.idb.outbox);
  check('L. 復元中に送信(set)・削除(delete)が1度も発生しない',
    e.counts.set === 0 && e.counts.delete === 0, { set: e.counts.set, delete: e.counts.delete });

  // M. StampStoreのキーにpropertyIdが自動付与されないこと(Phase 1E-C前)
  var e2 = makeEnv({ scopeEnabled: true, currentPropertyId: PID_A });
  e2.store.setPropertyKey(PROP_A);
  await e2.store.putMany([{ room: '101', symbol: 'A' }], { knownRooms: ['101'] });
  check('M. property scope ON でも stamp キーへ propertyId が自動付与されない',
    e2.remoteRows.some(function (r) { return r.key === stampKey(PROP_A, '101'); }) &&
    !e2.remoteRows.some(function (r) { return r.key.indexOf(PID_A) !== -1; }),
    e2.remoteRows.map(function (r) { return r.key; }));
  e2.store.clearMemory();
  e2.resetCounts();
  var loaded = await e2.store.loadAll({ knownRooms: ['101'] });
  check('M. property scope ON でも復元経路は同じで、1件ずつGETもしない',
    loaded.restored.length === 1 && e2.counts.get === 0, { restored: loaded.restored, get: e2.counts.get });
}

/* ================================================================
   O. 修正前後でStampStoreの値が一致(round trip)
   ================================================================ */
async function testRoundTripValuesIdentical() {
  console.log('\n==== O. 保存→再読込 の値が旧実装と一致 ====');
  var master = ['1101', '801', '802', '1102'];
  var RECORDS = [
    { room: '1101', symbol: 'A', time_start: '09:30', source: 'standardized_stamp_sheet' },
    { room: '801', symbol: 'A', time_start: '09:30', note: '朝一', note_raw: '朝一', source: 'standardized_stamp_sheet' },
    { room: '802', symbol: '', symbol_review: true, needs_review: true,
      review_reason: ['複数チェック'], raw_checkboxes: { a: true, p: true }, source: 'standardized_stamp_sheet' },
  ];
  var e = makeEnv();
  e.store.setPropertyKey(PROP_A);
  await e.store.putMany(RECORDS, { knownRooms: master, source: 'standardized_stamp_sheet' });

  var ref = await referenceOldLoadAll(e, PROP_A, master);   // 旧実装での復元
  e.store.clearMemory();
  e.resetCounts();
  await e.store.loadAll({ knownRooms: master });            // 新実装での復元
  var now = e.store.all();

  check('O. 保存→再読込の復元値が旧実装と1件も違わない', sameRecords(ref.records, now),
    { old: Object.keys(ref.records), now: Object.keys(now) });
  check('O. 記号・時刻・備考が保たれる',
    now['801'] && now['801'].symbol === 'A' && now['801'].time_start === '09:30' && now['801'].note === '朝一');
  check('O. 要確認の部屋は記号を確定表示しない(従来どおり)',
    now['802'] && now['802'].symbol === '' && now['802'].needs_review === true);
  check('O. 予定情報が無い部屋は従来どおりnull', now['1102'] === undefined);
  check('O. 復元中の1件ずつremote GETは0回', e.counts.get === 0, e.counts.get);
}

/* ================================================================
   13. 退行検知(ソース検査)
   ================================================================ */
function testSourceGuards() {
  console.log('\n==== 退行検知: 1件ずつ取得へ戻っていないこと(ソース検査) ====');
  var loadAllSrc = stripComments(sliceStoreFunction('loadAll'));
  var migrateSrc = stripComments(sliceStoreFunction('migrateLegacyKeys'));
  var readManySrc = stripComments(sliceStoreFunction('readRecordsFor'));

  check('loadAll が adapters.get / readRecord を直接呼ばない(まとめ取り経由のみ)',
    loadAllSrc.indexOf('readRecord(') === -1 && loadAllSrc.indexOf('adapters.get(') === -1);
  check('loadAll がまとめ取り(readRecordsFor)を使う', loadAllSrc.indexOf('readRecordsFor(') !== -1);
  check('migrateLegacyKeys も1件ずつ取得へ戻っていない',
    migrateSrc.indexOf('readRecord(') === -1 && migrateSrc.indexOf('readRecordsFor(') !== -1);
  check('getMany があるときは1件ずつ取得へfallbackしない(readRecordsFor内の分岐が1箇所)',
    readManySrc.indexOf("typeof adapters.getMany !== 'function'") !== -1);

  var wiring = stripComments(extractStampStoreWiring());
  check('index.html のStampStoreアダプタが getMany を持つ', wiring.indexOf('getMany:') !== -1);
  check('getMany が既存のまとめ取り一本道(readRoomValuesBulk)を使う(新しい保存層を作っていない)',
    wiring.indexOf('readRoomValuesBulk(') !== -1);
  check('getMany が1件ずつの storageGet を呼ばない',
    wiring.slice(wiring.indexOf('getMany:')).indexOf('storageGet(') === -1);
  check('StampStoreの保存キーの形式は従来のまま(stamp: / fireflow-stamp:)',
    storeSrc.indexOf("var KEY_PREFIX = 'stamp:';") !== -1 &&
    storeSrc.indexOf("var LEGACY_KEY_PREFIX = 'fireflow-stamp:';") !== -1);
  /* [2026-08-22 この検査項目だけ意味を差し替えた。理由をここに残す]
     元の項目は「保存側(putMany)はまとめ取りに触れていない(load側だけの修正)」だった。
     これは2026-08-22の【読み込み側】の修正が保存側へ波及していないことを示すためのもので、
     当時の設計意図としては正しかった。

     その後、同じ日の実ブラウザ検証(実Safari / localhost:3000)で、残っていた storm の発火元は
     読み込み側ではなく【保存側】だと確定した。seedDemoState() が「デモを開く」たびに
     ハードコードされた129室ぶんの予定情報を putMany() し、内容が1バイトも変わっていないのに
     1室ずつ window.storage.set() の既存行検索
       select=id&property_id=eq.<uuid>&key=eq.stamp:コスモ六甲ガーデンフォート:113&shared&owner_id
     を出していた(= 実測されたURLそのもの)。したがって保存側は「触らない」ではなく
     「1件ずつのremote existence checkをやめる」必要がある。

     期待値を新実装に合わせて緩めたのではなく、実ブラウザの事実にもとづいて【守るべき一線を
     具体化した】。緩めていないことは、置き換え後の3項目(1件ずつ取得へ落ちない / 一括取得は
     1回だけ / 送らない判定は updated_at 以外の完全一致)で担保している。
     保存内容そのものが変わっていないことの検証は
     public/test/stampstore_seed_storm_fix_verify.js が参照実装との突き合わせで行う。 */
  var putManySrc = stripComments(sliceStoreFunction('putMany'));
  var writeRecordsSrc = stripComments(sliceStoreFunction('writeRecords'));
  check('9. 保存側は1件ずつの取得(readRecord / adapters.get)へ落ちない',
    putManySrc.indexOf('readRecord(') === -1 && putManySrc.indexOf('adapters.get(') === -1 &&
    writeRecordsSrc.indexOf('readRecord(') === -1 && writeRecordsSrc.indexOf('adapters.get(') === -1);
  check('9. 保存側が使うまとめ取りは1回だけ(部屋数に比例させない)',
    writeRecordsSrc.split('readRecordsFor(').length - 1 === 1);
  check('9. 送らないと判断するのは updated_at 以外が完全一致したときだけ(保存判定を雑にしない)',
    writeRecordsSrc.indexOf('contentWithoutUpdatedAt(stored) === contentWithoutUpdatedAt(') !== -1);
}

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

async function main() {
  await testRequestCount();
  await testRestoreIdentical();
  await testLegacyKeysUnchanged();
  await testOfflineFallback();
  await testSaveAndOutboxUntouched();
  await testRoundTripValuesIdentical();
  testSourceGuards();

  var passed = results.filter(function (r) { return r.ok; }).length;
  var failed = results.length - passed;
  console.log('\n==== stampstore_request_storm_fix_verify 総合結果: ' + (failed === 0 ? 'PASS' : 'FAIL')
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
