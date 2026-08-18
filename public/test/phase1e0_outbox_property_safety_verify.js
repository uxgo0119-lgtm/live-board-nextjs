// [2026-08-18新設 Phase 1E-0] 送信キュー(outbox)の物件安全化 回帰テスト。
//
// このテストが守る唯一の原則:
//
//   送信先propertyIdを item 自身が確定保持しているデータだけを、
//   その item が持つ propertyId へ送る。
//
// 「分からないoutboxを賢く送る」ことは目的ではない。
// 「分からないoutboxを絶対に送らない」ことが目的である。
//
// 禁止事項(1つでも破れたら、旧データが今開いている物件へ混入する):
//   ・propertyIdを持たないitemを送る
//   ・propertyIdが不正なitemを送る
//   ・flush時のcurrentPropertyIdをフォールバックとして使う
//   ・送れなかったitemを削除する / 書き換える
//   ・stamp系(stamp: / fireflow-stamp:)をcurrentPropertyIdへ送る
//
// 既存の public/test/*.js と同じく、index.html から関数ソースを文字列抽出して
// Node.js の vm で実行する方式(製品コードに一切手を入れずに検証するため)。
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

var PID_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
var PID_B = 'bbbbbbbb-2222-4222-9222-bbbbbbbbbbbb';

/* ================================================================
   製品ソースの抽出
   ================================================================ */
function extractFunctionSource(src, name) {
  var marker = 'function ' + name + '(';
  var startIdx = src.indexOf(marker);
  if (startIdx === -1) throw new Error('MISSING IMPLEMENTATION SOURCE: ' + name);
  var braceStart = src.indexOf('{', startIdx);
  var depth = 0;
  var i = braceStart;
  for (; i < src.length; i++) {
    var ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  if (depth !== 0) throw new Error('関数 ' + name + ' の波括弧の対応が取れませんでした');
  if (src.slice(Math.max(0, startIdx - 6), startIdx) === 'async ') startIdx -= 6;
  return src.slice(startIdx, i);
}
function extractVarDeclSource(src, name) {
  var marker = 'var ' + name + ' = ';
  var startIdx = src.indexOf(marker);
  if (startIdx === -1) throw new Error('MISSING IMPLEMENTATION SOURCE: var ' + name);
  var semiIdx = src.indexOf(';', startIdx);
  return src.slice(startIdx, semiIdx + 1);
}

var PRODUCT_SRC = [
  extractFunctionSource(html, 'keyFor'),
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
  extractFunctionSource(html, 'flushOutbox'),
].join('\n\n');

/* ================================================================
   フェイク環境
   ------------------------------------------------------------
   fakeStorage は supabase-integration.js の window.storage と同じ規則で動く。
   すなわち「propertyIdが未指定(null/undefined/空)なら currentPropertyId へ書く」。
   Phase 1E-0のバグはまさにこの既定経路へ落ちることで起きるため、
   フェイク側でも忠実に再現しておく(ここを安全側に作ると、テストがバグを見逃す)。
   ================================================================ */
function makeEnv(options) {
  options = options || {};
  var idb = { cache: {}, outbox: {} };
  var remoteRows = [];
  var setCalls = [];
  var deleteCalls = [];
  var state = {
    currentPropertyId: options.currentPropertyId !== undefined ? options.currentPropertyId : PID_A,
    remoteMode: options.remoteMode || 'ok',
  };

  // supabase-integration.js: if (propertyId && propertyId !== currentPropertyId) ... else 既定経路
  function targetPid(propertyId) { return propertyId || state.currentPropertyId; }
  function findRow(pid, key, shared) {
    for (var i = 0; i < remoteRows.length; i++) {
      var r = remoteRows[i];
      if (r.property_id === pid && r.key === key && r.shared === !!shared) return r;
    }
    return null;
  }
  function failOrNull(what) {
    if (state.remoteMode === 'throw') throw new Error('remote ' + what + ' failed');
    return null;
  }

  var fakeStorage = {
    get: async function (key, shared, propertyId) {
      if (state.remoteMode !== 'ok') throw new Error('remote get failed');
      var row = findRow(targetPid(propertyId), key, shared);
      if (!row) throw new Error('key not found: ' + key);
      return { key: key, value: row.value, shared: !!shared };
    },
    set: async function (key, value, shared, propertyId) {
      var pid = targetPid(propertyId);
      setCalls.push({ propertyId: pid, requestedPropertyId: propertyId, key: key, value: String(value), shared: !!shared });
      if (state.remoteMode !== 'ok') return failOrNull('set');
      var row = findRow(pid, key, shared);
      if (row) row.value = String(value);
      else remoteRows.push({ property_id: pid, key: key, value: String(value), shared: !!shared });
      return { key: key, value: value, shared: !!shared };
    },
    delete: async function (key, shared, propertyId) {
      var pid = targetPid(propertyId);
      deleteCalls.push({ propertyId: pid, requestedPropertyId: propertyId, key: key, shared: !!shared });
      if (state.remoteMode !== 'ok') return failOrNull('delete');
      remoteRows = remoteRows.filter(function (r) {
        return !(r.property_id === pid && r.key === key && r.shared === !!shared);
      });
      return { key: key, deleted: true, shared: !!shared };
    },
    list: async function (prefix, shared) { return { keys: [], prefix: prefix, shared: !!shared }; },
  };

  var win = {
    getCurrentPropertyId: function () { return state.currentPropertyId; },
    isValidPropertyId: function (value) {
      return typeof value === 'string' && value.length === 36 &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
    },
    storage: fakeStorage,
    FIREFLOW_PROPERTY_SCOPE_ENABLED: options.scopeEnabled === true,
    addEventListener: function () {},
  };

  var retryScheduled = 0;
  var syncCompleteShown = 0;
  var ctx = {
    window: win,
    navigator: { onLine: true },
    document: { addEventListener: function () {} },
    console: { log: function () {}, warn: function () {}, error: function () {} },
    setInterval: function () { return 1; },
    clearInterval: function () {},
    setTimeout: function () { return 1; },
    clearTimeout: function () {},
    lcPut: async function (store, record) { idb[store][record.key] = record; },
    lcGet: async function (store, key) { return idb[store][key] || null; },
    lcDelete: async function (store, key) { delete idb[store][key]; },
    lcGetAll: async function (store) {
      return Object.keys(idb[store]).map(function (k) { return idb[store][k]; });
    },
    updateSyncBadge: function () {},
    scheduleOutboxRetry: function () { retryScheduled++; },
    showSyncCompleteBriefly: function () { syncCompleteShown++; },
    isSyncingNow: false,
    outboxRetryTimer: null,
  };
  vm.createContext(ctx);
  vm.runInContext(PRODUCT_SRC, ctx);

  return {
    ctx: ctx,
    idb: idb,
    state: state,
    setCalls: setCalls,
    deleteCalls: deleteCalls,
    remoteRows: function () { return remoteRows; },
    rowsFor: function (pid) { return remoteRows.filter(function (r) { return r.property_id === pid; }); },
    outboxItems: function () { return Object.keys(idb.outbox).map(function (k) { return idb.outbox[k]; }); },
    cacheItems: function () { return Object.keys(idb.cache).map(function (k) { return idb.cache[k]; }); },
    retryScheduled: function () { return retryScheduled; },
    syncCompleteShown: function () { return syncCompleteShown; },
  };
}

/* 旧outbox item(Phase 1E-0以前に積まれたもの)を直接キューへ置く。
   実端末に残っている132件と同じ形(propertyIdフィールドそのものが無い)。 */
function seedLegacyItem(env, cacheKey, rawKey, value, extra) {
  var item = {
    key: cacheKey, rawKey: rawKey, value: value, shared: true, deleted: false, updatedAt: 1,
  };
  if (extra) Object.keys(extra).forEach(function (k) { item[k] = extra[k]; });
  env.idb.outbox[cacheKey] = item;
  return JSON.parse(JSON.stringify(item));
}
function snapshotOutbox(env) {
  return JSON.parse(JSON.stringify(env.idb.outbox));
}
function outboxUnchanged(env, before) {
  return JSON.stringify(snapshotOutbox(env)) === JSON.stringify(before);
}

(async function run() {

/* ================================================================
   A. item.propertyId = A / currentPropertyId = B → Aへ送る
   ================================================================ */
console.log('==== A. 送信先は item.propertyId(flush時のcurrentPropertyIdではない) ====');
for (var ai = 0; ai < 2; ai++) {
  var scopeOn = ai === 1;
  var label = 'A[' + (scopeOn ? 'flag ON' : 'flag OFF') + ']';
  var env = makeEnv({ scopeEnabled: scopeOn, currentPropertyId: PID_A, remoteMode: 'throw' });
  await env.ctx.storageSet(env.ctx.keyFor('101'), 'Aの点検結果', true);
  check(label + ' 前提: 積んだitemがpropertyId(A)を保持している',
    env.outboxItems().length === 1 && env.outboxItems()[0].propertyId === PID_A,
    env.outboxItems()[0]);

  env.state.currentPropertyId = PID_B;   // 物件Bへ切り替わった状態でflush
  env.state.remoteMode = 'ok';
  env.setCalls.length = 0;
  await env.ctx.flushOutbox();

  check(label + ' 送信先propertyIdはA', env.setCalls.length === 1 && env.setCalls[0].propertyId === PID_A, env.setCalls);
  check(label + ' window.storageへ明示的にAを渡している(既定経路へ落ちていない)',
    env.setCalls[0] && env.setCalls[0].requestedPropertyId === PID_A, env.setCalls[0]);
  check(label + ' A物件へ1件入った', env.rowsFor(PID_A).length === 1, env.rowsFor(PID_A));
  check(label + ' B物件への混入は0件', env.rowsFor(PID_B).length === 0, env.rowsFor(PID_B));
  check(label + ' 送信できたのでキューから削除された', env.outboxItems().length === 0, env.outboxItems().length);
}

/* ================================================================
   B / C. item.propertyId = null → どの物件へも送らない
   ================================================================ */
console.log('\n==== B/C. propertyId無しitemは、現在の物件が何であっても送らない ====');
var pidNullCases = [
  ['B', PID_A, 'currentPropertyId = A'],
  ['C', PID_B, 'currentPropertyId = B'],
];
for (var ci = 0; ci < pidNullCases.length; ci++) {
  for (var cj = 0; cj < 2; cj++) {
    var caseName = pidNullCases[ci][0];
    var curPid = pidNullCases[ci][1];
    var scopeOn2 = cj === 1;
    var lbl = caseName + '[' + (scopeOn2 ? 'flag ON' : 'flag OFF') + '] ' + pidNullCases[ci][2];
    var env = makeEnv({ scopeEnabled: scopeOn2, currentPropertyId: curPid, remoteMode: 'ok' });
    var before = seedLegacyItem(env, 'shared:fireflow-binder:101', 'fireflow-binder:101', '旧データ');
    var beforeAll = snapshotOutbox(env);

    await env.ctx.flushOutbox();

    check(lbl + ': リモートへの送信回数0', env.setCalls.length === 0, env.setCalls);
    check(lbl + ': リモート行0件', env.remoteRows().length === 0, env.remoteRows());
    check(lbl + ': 現在の物件へ勝手に入っていない', env.rowsFor(curPid).length === 0, env.rowsFor(curPid));
    check(lbl + ': 削除0(キューに残る)', env.outboxItems().length === 1, env.outboxItems().length);
    check(lbl + ': item書き換え0(propertyIdを勝手に埋めない)',
      outboxUnchanged(env, beforeAll) && env.outboxItems()[0].propertyId === undefined,
      env.outboxItems()[0]);
    check(lbl + ': 同期完了表示を出さない', env.syncCompleteShown() === 0, env.syncCompleteShown());
  }
}

/* ================================================================
   D. 不正propertyId → 送信0 / 削除0
   ================================================================ */
console.log('\n==== D. 不正なpropertyIdを持つitemは送らない(推測で直さない) ====');
var badPids = [
  ['空文字', ''],
  ['UUIDでない文字列', 'not-a-uuid'],
  ['大文字UUID', 'AAAAAAAA-1111-4111-8111-AAAAAAAAAAAA'],
  ['桁足らず', 'aaaaaaaa-1111-4111-8111-aaaaaaaaaa'],
  ['v4でない(version桁が3)', 'aaaaaaaa-1111-3111-8111-aaaaaaaaaaaa'],
  ['数値', 12345],
  ['物件名が入っている', 'コスモ六甲ガーデンフォート'],
];
for (var di = 0; di < badPids.length; di++) {
  var env = makeEnv({ scopeEnabled: true, currentPropertyId: PID_B, remoteMode: 'ok' });
  seedLegacyItem(env, 'shared:fireflow-binder:101', 'fireflow-binder:101', '壊れたitem',
    { propertyId: badPids[di][1], alreadyScoped: true });
  var beforeBad = snapshotOutbox(env);

  await env.ctx.flushOutbox();

  check('D 不正propertyId(' + badPids[di][0] + '): 送信0',
    env.setCalls.length === 0 && env.remoteRows().length === 0, env.setCalls);
  check('D 不正propertyId(' + badPids[di][0] + '): 削除0・書き換え0',
    env.outboxItems().length === 1 && outboxUnchanged(env, beforeBad), env.outboxItems()[0]);
}

/* ================================================================
   E / F. propertyId無しの binder / presence
   ================================================================ */
console.log('\n==== E/F. 実端末に存在する propertyId無し旧outbox(binder / presence) ====');
{
  // 実端末dry-runで実在が確認された3件
  var realLegacy = [
    ['E binder 807', 'shared:fireflow-binder:807', 'fireflow-binder:807'],
    ['E binder 811', 'shared:fireflow-binder:811', 'fireflow-binder:811'],
    ['F presence 大塚 亮彦', 'shared:fireflow-presence:大塚 亮彦', 'fireflow-presence:大塚 亮彦'],
  ];
  for (var ei = 0; ei < realLegacy.length; ei++) {
    var env = makeEnv({ scopeEnabled: false, currentPropertyId: PID_A, remoteMode: 'ok' });
    seedLegacyItem(env, realLegacy[ei][1], realLegacy[ei][2], '実端末相当');
    var beforeReal = snapshotOutbox(env);
    await env.ctx.flushOutbox();
    check(realLegacy[ei][0] + ': HOLD(送信0)',
      env.setCalls.length === 0 && env.remoteRows().length === 0, env.setCalls);
    check(realLegacy[ei][0] + ': HOLD(削除0・書き換え0)',
      env.outboxItems().length === 1 && outboxUnchanged(env, beforeReal), env.outboxItems()[0]);
  }
}

/* ================================================================
   G / H. stamp系は currentPropertyId へ送られない
   ------------------------------------------------------------
   stamp系キーは isPropertyScopedKey() の許可リストに無い。Phase 1C の旧判定は
   スコープ対象キーしか止めていなかったため、ここが素通りしていた。
   ================================================================ */
console.log('\n==== G/H. stamp系(StampStore)をcurrentPropertyIdへ送らない ====');
{
  var stampKeys = [
    ['G stamp:コスモ六甲ガーデンフォート:101', 'stamp:コスモ六甲ガーデンフォート:101'],
    ['G stamp:コスモ城東野江ロイヤルフォルム:203', 'stamp:コスモ城東野江ロイヤルフォルム:203'],
    ['H fireflow-stamp:101', 'fireflow-stamp:101'],
  ];
  for (var gi = 0; gi < stampKeys.length; gi++) {
    for (var gj = 0; gj < 2; gj++) {
      var scopeOn3 = gj === 1;
      var lbl3 = stampKeys[gi][0] + '[' + (scopeOn3 ? 'flag ON' : 'flag OFF') + ']';
      var env = makeEnv({ scopeEnabled: scopeOn3, currentPropertyId: PID_B, remoteMode: 'ok' });
      seedLegacyItem(env, 'shared:' + stampKeys[gi][1], stampKeys[gi][1], '{"mark":"A"}');
      var beforeStamp = snapshotOutbox(env);

      await env.ctx.flushOutbox();

      check(lbl3 + ': currentPropertyId(B)へ送信されない',
        env.setCalls.length === 0 && env.rowsFor(PID_B).length === 0, env.setCalls);
      check(lbl3 + ': リモートへ1件も入らない', env.remoteRows().length === 0, env.remoteRows());
      check(lbl3 + ': 既存stampデータを消さない・書き換えない',
        env.outboxItems().length === 1 && outboxUnchanged(env, beforeStamp), env.outboxItems()[0]);
    }
  }
}
{
  // propertyIdを確定保持している新しいstamp itemは、その物件へ送れること
  // (Phase 1E-0は「送れなくする」ことが目的ではない)
  var env = makeEnv({ scopeEnabled: false, currentPropertyId: PID_A, remoteMode: 'throw' });
  await env.ctx.storageSet('stamp:コスモ六甲ガーデンフォート:101', '{"mark":"A"}', true);
  check('G/H 新規stamp保存はpropertyId(A)を確定保持して積まれる',
    env.outboxItems().length === 1 && env.outboxItems()[0].propertyId === PID_A, env.outboxItems()[0]);
  env.state.currentPropertyId = PID_B;
  env.state.remoteMode = 'ok';
  await env.ctx.flushOutbox();
  check('G/H 新規stamp itemはB表示中でもA物件へ送られる',
    env.rowsFor(PID_A).length === 1 && env.rowsFor(PID_B).length === 0, env.remoteRows());
}

/* ================================================================
   I / J. remote success / failure と削除の関係
   ================================================================ */
console.log('\n==== I/J. 送信成功したitemだけ削除する(失敗は保持) ====');
{
  // I: propertyIdありitem(送信成功) と propertyId無しitem を同時に持つ状態
  var env = makeEnv({ scopeEnabled: false, currentPropertyId: PID_A, remoteMode: 'throw' });
  await env.ctx.storageSet(env.ctx.keyFor('101'), '点検済み', true);
  var legacyBefore = seedLegacyItem(env, 'shared:fireflow-binder:807', 'fireflow-binder:807', '旧データ');
  check('I 前提: 送信可能1件 + propertyId無し1件', env.outboxItems().length === 2, env.outboxItems().length);

  env.state.remoteMode = 'ok';
  await env.ctx.flushOutbox();

  var leftI = env.outboxItems();
  check('I propertyIdありitemだけ削除された',
    leftI.length === 1 && leftI[0].rawKey === 'fireflow-binder:807', leftI);
  check('I propertyId無しitemは中身も含めて完全に元のまま',
    JSON.stringify(leftI[0]) === JSON.stringify(legacyBefore), leftI[0]);
  check('I リモートへ入ったのは送信可能itemの1件だけ', env.remoteRows().length === 1, env.remoteRows());
  check('I 残件があるので同期完了表示は出ない', env.syncCompleteShown() === 0, env.syncCompleteShown());
}
{
  // J: remote failure のときは propertyIdありitemも保持される
  var env = makeEnv({ scopeEnabled: false, currentPropertyId: PID_A, remoteMode: 'throw' });
  await env.ctx.storageSet(env.ctx.keyFor('101'), '点検済み', true);
  seedLegacyItem(env, 'shared:fireflow-binder:807', 'fireflow-binder:807', '旧データ');

  for (var ji = 0; ji < 2; ji++) {
    env.state.remoteMode = ['throw', 'null'][ji];
    await env.ctx.flushOutbox();
    check('J[' + ['throw', 'null'][ji] + '] 送信失敗時はpropertyIdありitemも保持される',
      env.outboxItems().length === 2, env.outboxItems().length);
    check('J[' + ['throw', 'null'][ji] + '] リモートへは1件も入らない',
      env.remoteRows().length === 0, env.remoteRows());
    check('J[' + ['throw', 'null'][ji] + '] propertyIdがcurrentPropertyIdで書き換わらない',
      env.idb.outbox['shared:fireflow-binder:101'].propertyId === PID_A
      && env.idb.outbox['shared:fireflow-binder:807'].propertyId === undefined,
      [env.idb.outbox['shared:fireflow-binder:101'].propertyId,
       env.idb.outbox['shared:fireflow-binder:807'].propertyId]);
  }
  check('J 送信失敗が続いてもローカル(IndexedDB)のデータは残る',
    env.cacheItems().length === 1 && env.cacheItems()[0].value === '点検済み', env.cacheItems());
}
{
  // 削除(deleted:true)のoutboxも同じ規則で扱われる
  var env = makeEnv({ scopeEnabled: false, currentPropertyId: PID_A, remoteMode: 'throw' });
  await env.ctx.storageDelete(env.ctx.keyFor('101'), true);
  check('I/J 削除outboxもpropertyId(A)を確定保持する',
    env.outboxItems()[0] && env.outboxItems()[0].deleted === true
    && env.outboxItems()[0].propertyId === PID_A, env.outboxItems()[0]);

  env.state.currentPropertyId = PID_B;
  env.state.remoteMode = 'ok';
  env.deleteCalls.length = 0;   // 積むときの1回目を除き、再送分だけを見る
  await env.ctx.flushOutbox();
  check('I/J 削除outboxもitem.propertyId(A)に対してのみ実行される',
    env.deleteCalls.length === 1 && env.deleteCalls[0].propertyId === PID_A, env.deleteCalls);
  check('I/J 削除outboxは成功時に削除される', env.outboxItems().length === 0, env.outboxItems().length);
}
{
  // propertyId無しの削除outboxは、削除リクエスト自体を送らない
  // (誤った物件のデータを消してしまうのが最悪のケース)
  var env = makeEnv({ scopeEnabled: false, currentPropertyId: PID_B, remoteMode: 'ok' });
  env.idb.outbox['shared:fireflow-binder:807'] = {
    key: 'shared:fireflow-binder:807', rawKey: 'fireflow-binder:807',
    value: null, shared: true, deleted: true, updatedAt: 1,
  };
  var beforeDel = snapshotOutbox(env);
  await env.ctx.flushOutbox();
  check('I/J propertyId無しの削除outboxはリモート削除を実行しない',
    env.deleteCalls.length === 0, env.deleteCalls);
  check('I/J propertyId無しの削除outboxもキューに残る',
    env.outboxItems().length === 1 && outboxUnchanged(env, beforeDel), env.outboxItems()[0]);
}

/* ================================================================
   K. 実端末132件相当のfixture: 1件もmutate / deleteされない
   ------------------------------------------------------------
   実端末dry-run(2026-08-18)の実測内訳:
     NEEDS_USER_ASSIGNMENT     = 3   (propertyId無しの業務データ)
     SKIPPED_NON_PROPERTY_DATA = 129 (StampStore系)
   ================================================================ */
console.log('\n==== K. 実端末132件相当fixture: propertyId無しitemの変更0 ====');
{
  var env = makeEnv({ scopeEnabled: false, currentPropertyId: PID_B, remoteMode: 'ok' });

  // NEEDS_USER_ASSIGNMENT = 3 (実端末で確認された実在キー)
  seedLegacyItem(env, 'shared:fireflow-binder:807', 'fireflow-binder:807', 'binder807');
  seedLegacyItem(env, 'shared:fireflow-binder:811', 'fireflow-binder:811', 'binder811');
  seedLegacyItem(env, 'shared:fireflow-presence:大塚 亮彦', 'fireflow-presence:大塚 亮彦', 'presence');

  // SKIPPED_NON_PROPERTY_DATA = 129 (StampStore系)
  var stampSeeded = 0;
  var propNames = ['コスモ六甲ガーデンフォート', 'コスモ城東野江ロイヤルフォルム'];
  for (var r = 0; r < 43; r++) {
    for (var p = 0; p < propNames.length; p++) {
      var rawK = 'stamp:' + propNames[p] + ':' + (101 + r);
      seedLegacyItem(env, 'shared:' + rawK, rawK, '{"mark":"A"}');
      stampSeeded++;
    }
  }
  for (var q = 0; q < 43; q++) {
    var rawK2 = 'fireflow-stamp:' + (201 + q);
    seedLegacyItem(env, 'shared:' + rawK2, rawK2, '{"mark":"P"}');
    stampSeeded++;
  }
  check('K 前提: StampStore系129件', stampSeeded === 129, stampSeeded);
  check('K 前提: outbox合計132件', env.outboxItems().length === 132, env.outboxItems().length);

  var before132 = snapshotOutbox(env);

  // 何度flushしても変化しないこと(5秒ごとの自動リトライを想定)
  await env.ctx.flushOutbox();
  await env.ctx.flushOutbox();
  await env.ctx.flushOutbox();

  check('K 送信0(リモートへの書き込み要求が1回も発生しない)',
    env.setCalls.length === 0 && env.deleteCalls.length === 0,
    [env.setCalls.length, env.deleteCalls.length]);
  check('K リモート行0件', env.remoteRows().length === 0, env.remoteRows().length);
  check('K 現在の物件(B)への混入0件', env.rowsFor(PID_B).length === 0, env.rowsFor(PID_B).length);
  check('K delete 0(132件すべて残っている)', env.outboxItems().length === 132, env.outboxItems().length);
  check('K rewrite 0(132件が1バイトも変わっていない)', outboxUnchanged(env, before132));
  check('K auto assign 0(propertyIdが1件も生えていない)',
    env.outboxItems().every(function (it) { return it.propertyId === undefined; }),
    env.outboxItems().filter(function (it) { return it.propertyId !== undefined; }).length);
  check('K IndexedDBのcacheも変更されない', env.cacheItems().length === 0, env.cacheItems().length);
  check('K 同期完了表示は出ない', env.syncCompleteShown() === 0, env.syncCompleteShown());
}

/* ================================================================
   L. ソース監査: flush時のcurrentPropertyIdフォールバックが無いこと
   ================================================================ */
console.log('\n==== L. ソース監査 ====');
{
  // コメント文中の語に反応しないよう、実行されるコードだけを見る。
  function stripComments(src) {
    return String(src).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
  }
  var flushSrc = stripComments(extractFunctionSource(html, 'flushOutbox'));
  check('L flushOutbox内で currentScopePropertyId() を呼んでいない(flush時fallback 0)',
    flushSrc.indexOf('currentScopePropertyId') === -1);
  check('L flushOutbox内で getCurrentPropertyId を呼んでいない',
    flushSrc.indexOf('getCurrentPropertyId') === -1);
  check('L flushOutbox内で INITIAL_PROPERTY_ID を参照していない',
    flushSrc.indexOf('INITIAL_PROPERTY_ID') === -1);
  check('L 送信判定が item.propertyId の妥当性検査を通っている',
    flushSrc.indexOf('isValidScopePropertyId') !== -1);
  check('L 送信判定が feature flag に依存していない',
    flushSrc.indexOf('PROPERTY_SCOPE_ENABLED') === -1);
  check('L 送信判定が キー名(isPropertyScopedKey) に依存していない',
    flushSrc.indexOf('isPropertyScopedKey') === -1);

  // StampStore本体は差分0
  var stampStoreSrc = fs.readFileSync(path.join(__dirname, '..', 'stamp_store', 'stamp_store.js'), 'utf8');
  check('L stamp_store.js は propertyId を一切知らないまま(Phase 1E-0で触っていない)',
    stampStoreSrc.indexOf('propertyId') === -1 && stampStoreSrc.indexOf('getCurrentPropertyId') === -1);
}

/* ================================================================ */
var ng = results.filter(function (r) { return !r.ok; });
console.log('\n==== 結果 ====');
console.log('PASS ' + (results.length - ng.length) + ' / ' + results.length);
if (ng.length) {
  console.log('FAILED:');
  ng.forEach(function (r) { console.log('  - ' + r.label); });
  process.exit(1);
}
console.log('==== phase1e0_outbox_property_safety_verify (outbox物件安全化) 総合結果: PASS ('
  + results.length + '/' + results.length + ') ====');
})().catch(function (err) {
  console.error('テスト実行中に例外が発生しました:', err);
  process.exit(1);
});
