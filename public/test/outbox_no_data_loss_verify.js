// [2026-08-18新設] 送信キュー(outbox)のデータ消失回帰テスト。
//
// FireFlowでは「通信に失敗した」ことより、
// 「通信に失敗したデータを、成功したと思い込んで捨てる」ことの方が重大である。
// このテストが守る唯一の原則:
//
//   サーバーへ保存できたことを確認できた時だけ、送信キューから削除する。
//
// 禁止事項(1つでも破れたら現場の点検記録が黙って消える):
//   ・送信失敗なのに削除する
//   ・リモート失敗を成功扱いする
//   ・propertyId不明のitemを推測で送る / 削除する
//   ・失敗itemを別propertyIdへ送る
//   ・リモート失敗を理由にローカル(IndexedDB)保存まで捨てる
//
// 既存の public/test/*.js と同じく、index.html / supabase-integration.js から関数ソースを
// 文字列抽出して Node.js の vm で実行する方式(製品コードに一切手を入れずに検証するため)。
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

/* ================================================================
   製品ソースの抽出
   ================================================================ */
function extractFunctionSource(src, name, what) {
  var marker = (what || 'function ') + name + (what ? '' : '(');
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

// index.html 側: 保存層(storageSet/storageDelete)と送信キュー(flushOutbox)
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
   remoteMode でリモート保存の失敗の「出方」を切り替える。
     'ok'    … 正常
     'throw' … 例外を投げる(通信断・window.storage未初期化など)
     'null'  … 例外は投げずに null を返す(Supabaseシムがエラー時に取る形)
   実バグは 'null' 側で起きるため、両方を必ず検証する。
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
    return null; // remoteMode === 'null'
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
      setCalls.push({ propertyId: pid, key: key, value: String(value), shared: !!shared });
      if (state.remoteMode !== 'ok') return failOrNull('set');
      var row = findRow(pid, key, shared);
      if (row) row.value = String(value);
      else remoteRows.push({ property_id: pid, key: key, value: String(value), shared: !!shared });
      return { key: key, value: value, shared: !!shared };
    },
    delete: async function (key, shared, propertyId) {
      var pid = targetPid(propertyId);
      deleteCalls.push({ propertyId: pid, key: key, shared: !!shared });
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

/* 現場入力1件を、指定モードで保存する(= outbox item を作る)。 */
async function saveOnce(env, room, value, shared) {
  return env.ctx.storageSet(env.ctx.keyFor(room), value, shared === undefined ? true : shared);
}

(async function run() {

/* ================================================================
   A. storageSet の contract
   「リモート保存成功」「ローカルのみ成功」を呼び出し元が区別できること
   ================================================================ */
console.log('==== A. storageSet contract(リモート成否を呼び出し元へ伝える) ====');
{
  var env = makeEnv({ remoteMode: 'ok' });
  var r = await saveOnce(env, '101', 'done');
  check('A-1 リモート成功時に remote:true を返す', !!r && r.remote === true, r);
  check('A-1 リモート成功時は送信キューに残らない', env.outboxItems().length === 0, env.outboxItems().length);
}
{
  var env = makeEnv({ remoteMode: 'throw' });
  var r = await saveOnce(env, '101', 'done');
  check('A-2 リモートが例外を投げたとき remote:false を返す', !!r && r.remote === false, r);
  check('A-2 例外時は送信キューへ積まれる', env.outboxItems().length === 1, env.outboxItems().length);
}
{
  // 実バグの本体。Supabaseシムはエラー時に例外ではなく null を返す形だった。
  // null を成功と誤認すると、送信キューにすら積まれず即座に消える。
  var env = makeEnv({ remoteMode: 'null' });
  var r = await saveOnce(env, '101', 'done');
  check('A-3 リモートが null を返したとき remote:false を返す(nullを成功扱いしない)',
    !!r && r.remote === false, r);
  check('A-3 null応答でも送信キューへ積まれる(黙って消えない)',
    env.outboxItems().length === 1, env.outboxItems().length);
  check('A-3 null応答でも再送がスケジュールされる', env.retryScheduled() > 0, env.retryScheduled());
  check('A-3 ローカル(IndexedDB)には保存されている', env.cacheItems().length === 1
    && env.cacheItems()[0].value === 'done', env.cacheItems());
}
{
  var env = makeEnv({ remoteMode: 'null' });
  var r = await env.ctx.storageDelete(env.ctx.keyFor('101'), true);
  check('A-4 storageDelete も null応答を失敗として扱う', !!r && r.remote === false, r);
  check('A-4 storageDelete のnull応答も送信キューへ積まれる',
    env.outboxItems().length === 1 && env.outboxItems()[0].deleted === true, env.outboxItems());
}

/* ================================================================
   CASE A: 送信成功 → 送信キューから削除
   ================================================================ */
console.log('\n==== CASE A. リモート保存成功 → outboxから削除 ====');
{
  var env = makeEnv({ scopeEnabled: true, remoteMode: 'throw' });
  await saveOnce(env, '101', '点検済み');
  check('CASE A 前提: 失敗して送信キューに1件積まれた', env.outboxItems().length === 1, env.outboxItems().length);

  env.state.remoteMode = 'ok';
  env.setCalls.length = 0;
  await env.ctx.flushOutbox();

  check('CASE A リモートへ1回だけ保存された', env.setCalls.length === 1, env.setCalls.length);
  check('CASE A 正しいpropertyId(A)へ保存された',
    env.rowsFor(PID_A).length === 1 && env.rowsFor(PID_B).length === 0, env.remoteRows());
  check('CASE A 保存された値が壊れていない',
    env.rowsFor(PID_A)[0] && env.rowsFor(PID_A)[0].value === '点検済み', env.rowsFor(PID_A));
  check('CASE A 送信キューの残数は0', env.outboxItems().length === 0, env.outboxItems().length);
  check('CASE A 同期完了表示が出る', env.syncCompleteShown() === 1, env.syncCompleteShown());
}

/* ================================================================
   CASE B: 送信失敗 → 送信キューに残る(データ消失0)
   ================================================================ */
console.log('\n==== CASE B. リモート保存失敗 → outbox保持(消失0) ====');
for (var mi = 0; mi < 2; mi++) {
  var mode = ['throw', 'null'][mi];
  var env = makeEnv({ scopeEnabled: true, remoteMode: 'throw' });
  await saveOnce(env, '101', '点検済み');
  var beforeItem = JSON.parse(JSON.stringify(env.outboxItems()[0]));

  env.state.remoteMode = mode;   // オンラインだがリモートが失敗し続ける
  await env.ctx.flushOutbox();

  var after = env.outboxItems();
  check('CASE B[' + mode + '] リモートには1件も保存されていない', env.remoteRows().length === 0, env.remoteRows());
  check('CASE B[' + mode + '] 送信キューに残っている(削除0)', after.length === 1, after.length);
  check('CASE B[' + mode + '] キーが保持されている', after[0] && after[0].key === beforeItem.key, after[0] && after[0].key);
  check('CASE B[' + mode + '] rawKeyが保持されている', after[0] && after[0].rawKey === beforeItem.rawKey, after[0] && after[0].rawKey);
  check('CASE B[' + mode + '] valueが保持されている', after[0] && after[0].value === '点検済み', after[0] && after[0].value);
  check('CASE B[' + mode + '] propertyIdが保持されている(A)', after[0] && after[0].propertyId === PID_A, after[0] && after[0].propertyId);
  check('CASE B[' + mode + '] sharedが保持されている', after[0] && after[0].shared === beforeItem.shared, after[0] && after[0].shared);
  check('CASE B[' + mode + '] 同期完了表示は出ない(送れていないのに成功と見せない)',
    env.syncCompleteShown() === 0, env.syncCompleteShown());
  check('CASE B[' + mode + '] ローカル保存(IndexedDB)は消えていない',
    env.cacheItems().length === 1 && env.cacheItems()[0].value === '点検済み', env.cacheItems());
  check('CASE B[' + mode + '] 再送がスケジュールされている(retry可能)', env.retryScheduled() > 0, env.retryScheduled());
}

/* ================================================================
   CASE C / E: propertyId無しの旧outbox item
   ================================================================ */
console.log('\n==== CASE C. propertyId無しの旧outbox item(推測送信0・削除0) ====');
{
  var env = makeEnv({ scopeEnabled: true, currentPropertyId: PID_B, remoteMode: 'ok' });
  // Phase 1C以前に積まれた、どの物件のものか分からないitem
  env.idb.outbox['shared:fireflow-binder:101'] = {
    key: 'shared:fireflow-binder:101', rawKey: 'fireflow-binder:101',
    value: '旧データ', shared: true, deleted: false, updatedAt: 1,
  };
  await env.ctx.flushOutbox();

  check('CASE C 送信されていない(推測で物件を割り当てない)', env.setCalls.length === 0, env.setCalls);
  check('CASE C リモートに1件も入っていない', env.remoteRows().length === 0, env.remoteRows());
  check('CASE C 現在の物件(B)へ勝手に送っていない', env.rowsFor(PID_B).length === 0, env.rowsFor(PID_B).length);
  check('CASE C 削除されずキューに残る', env.outboxItems().length === 1, env.outboxItems().length);
  check('CASE C itemの中身が書き換えられていない',
    env.outboxItems()[0].value === '旧データ' && env.outboxItems()[0].propertyId === undefined,
    env.outboxItems()[0]);
  check('CASE C 同期完了表示は出ない', env.syncCompleteShown() === 0, env.syncCompleteShown());
}

/* ================================================================
   CASE D: A物件のitemを、B物件を開いた状態でflush → Aへ送る
   ================================================================ */
console.log('\n==== CASE D. A物件のitemはB物件表示中にflushしてもAへ送る ====');
{
  var env = makeEnv({ scopeEnabled: true, currentPropertyId: PID_A, remoteMode: 'throw' });
  await saveOnce(env, '101', 'Aの点検結果');
  check('CASE D 前提: A物件のitemが積まれた',
    env.outboxItems().length === 1 && env.outboxItems()[0].propertyId === PID_A, env.outboxItems()[0]);

  env.state.currentPropertyId = PID_B;   // 物件Bを開いた
  env.state.remoteMode = 'ok';
  env.setCalls.length = 0;
  await env.ctx.flushOutbox();

  check('CASE D 送信先propertyIdはA(積んだ時点の物件)',
    env.setCalls.length === 1 && env.setCalls[0].propertyId === PID_A, env.setCalls);
  check('CASE D 送信キーはAでスコープされている',
    env.setCalls[0] && env.setCalls[0].key.indexOf(PID_A) !== -1, env.setCalls[0] && env.setCalls[0].key);
  check('CASE D B物件への混入は0件', env.rowsFor(PID_B).length === 0, env.rowsFor(PID_B));
  check('CASE D A物件へ1件入っている', env.rowsFor(PID_A).length === 1, env.rowsFor(PID_A));
  check('CASE D 送信できたので削除された', env.outboxItems().length === 0, env.outboxItems().length);
}
{
  // 失敗した場合も、currentPropertyId(B)で上書きされないこと
  var env = makeEnv({ scopeEnabled: true, currentPropertyId: PID_A, remoteMode: 'throw' });
  await saveOnce(env, '101', 'Aの点検結果');
  env.state.currentPropertyId = PID_B;
  env.state.remoteMode = 'null';
  await env.ctx.flushOutbox();
  check('CASE D 失敗時もpropertyIdがB(現在の物件)へ書き換わらない',
    env.outboxItems().length === 1 && env.outboxItems()[0].propertyId === PID_A, env.outboxItems()[0]);
  var leftD = env.outboxItems()[0];
  check('CASE D 失敗時もrawKeyがBで付け直されない',
    !!leftD && leftD.rawKey.indexOf(PID_A) !== -1 && leftD.rawKey.indexOf(PID_B) === -1,
    leftD && leftD.rawKey);
}

/* ================================================================
   CASE F: 失敗後のretry成功 → その時だけ削除 / 複数回retryで重複破壊なし
   ================================================================ */
console.log('\n==== CASE F. 失敗を繰り返してもデータは壊れず、成功した時だけ削除 ====');
{
  var env = makeEnv({ scopeEnabled: true, remoteMode: 'throw' });
  await saveOnce(env, '101', '点検済み');

  env.state.remoteMode = 'null';
  await env.ctx.flushOutbox();
  await env.ctx.flushOutbox();
  await env.ctx.flushOutbox();
  check('CASE F 3回失敗しても送信キューは1件のまま(重複も消失もない)',
    env.outboxItems().length === 1, env.outboxItems().length);
  check('CASE F 3回失敗してもvalue/propertyIdが壊れていない',
    env.outboxItems()[0].value === '点検済み' && env.outboxItems()[0].propertyId === PID_A,
    env.outboxItems()[0]);
  check('CASE F 失敗中はリモートに1件も入っていない', env.remoteRows().length === 0, env.remoteRows());

  env.state.remoteMode = 'ok';
  env.setCalls.length = 0;
  await env.ctx.flushOutbox();
  check('CASE F retry成功時に初めて削除される', env.outboxItems().length === 0, env.outboxItems().length);
  check('CASE F リモート行は1件だけ(重複行を作らない)', env.remoteRows().length === 1, env.remoteRows());
  check('CASE F 復旧後の送信は1回だけ', env.setCalls.length === 1, env.setCalls.length);

  // 送信キューが空になった後にもう一度flushしても何も起きない
  env.setCalls.length = 0;
  await env.ctx.flushOutbox();
  check('CASE F 空のキューを再flushしても再送しない', env.setCalls.length === 0, env.setCalls.length);
  check('CASE F 空のキューを再flushしてもリモート行は増えない', env.remoteRows().length === 1, env.remoteRows().length);
}
{
  // 削除(deleted:true)のoutboxも、成功を確認できた時だけ消える
  var env = makeEnv({ scopeEnabled: true, remoteMode: 'throw' });
  await env.ctx.storageDelete(env.ctx.keyFor('101'), true);
  env.state.remoteMode = 'null';
  await env.ctx.flushOutbox();
  check('CASE F 削除outboxも失敗時は保持される',
    env.outboxItems().length === 1 && env.outboxItems()[0].deleted === true, env.outboxItems());
  env.state.remoteMode = 'ok';
  await env.ctx.flushOutbox();
  check('CASE F 削除outboxは成功時に削除される', env.outboxItems().length === 0, env.outboxItems().length);
}

/* ================================================================
   複数item: 1件失敗しても他は送信され、失敗分だけ残る
   ================================================================ */
console.log('\n==== G. 複数item: 成功分だけ削除し、失敗分は残す ====');
{
  var env = makeEnv({ scopeEnabled: true, remoteMode: 'throw' });
  await saveOnce(env, '101', 'v101');
  await saveOnce(env, '102', 'v102');
  check('G 前提: 2件積まれた', env.outboxItems().length === 2, env.outboxItems().length);

  // 102号室だけ失敗し続ける
  var origSet = env.ctx.window.storage.set;
  env.state.remoteMode = 'ok';
  env.ctx.window.storage.set = async function (key, value, shared, propertyId) {
    if (String(key).indexOf('102') !== -1) return null;
    return origSet(key, value, shared, propertyId);
  };
  await env.ctx.flushOutbox();

  var left = env.outboxItems();
  check('G 成功した101は削除された', left.length === 1, left.length);
  check('G 失敗した102は残っている', left[0] && left[0].rawKey.indexOf('102') !== -1, left[0] && left[0].rawKey);
  check('G 失敗した102の値は保持されている', left[0] && left[0].value === 'v102', left[0] && left[0].value);
  check('G 成功した101はリモートにある', env.rowsFor(PID_A).length === 1, env.rowsFor(PID_A));
  check('G 残件があるので同期完了表示は出ない', env.syncCompleteShown() === 0, env.syncCompleteShown());
}

/* ================================================================
   H. feature flag OFF でも同じ原則が守られること
   ================================================================ */
console.log('\n==== H. PROPERTY_SCOPE_ENABLED OFF でも消失0 ====');
{
  var env = makeEnv({ scopeEnabled: false, remoteMode: 'throw' });
  await saveOnce(env, '101', '点検済み');
  check('H flag OFF: スコープ無しキーで積まれる(Phase 1B相当)',
    env.outboxItems()[0] && env.outboxItems()[0].rawKey === 'fireflow-binder:101',
    env.outboxItems()[0] && env.outboxItems()[0].rawKey);

  env.state.remoteMode = 'null';
  await env.ctx.flushOutbox();
  check('H flag OFF: リモート失敗時に削除されない', env.outboxItems().length === 1, env.outboxItems().length);
  check('H flag OFF: リモートへ入っていない', env.remoteRows().length === 0, env.remoteRows());

  env.state.remoteMode = 'ok';
  await env.ctx.flushOutbox();
  check('H flag OFF: 成功時は従来どおり削除される', env.outboxItems().length === 0, env.outboxItems().length);
  check('H flag OFF: 従来どおりリモートへ入る', env.remoteRows().length === 1, env.remoteRows());
}

/* ================================================================
   I. Supabaseシム(window.storage)が失敗を呼び出し元へ伝えること
   ------------------------------------------------------------
   ここが FIRST_BREAK。set/delete がエラー時に例外ではなく null を返していたため、
   storageSet は「保存できた」と誤認し、送信キューにすら積まなかった。
   ================================================================ */
console.log('\n==== I. Supabaseシム: 保存失敗を成功扱いしない ====');
function makeShim(fail) {
  fail = fail || {};
  var rows = [];
  var nextId = 1;
  function builder(op, payload) {
    var filters = [];
    function match(r) {
      return filters.every(function (f) {
        if (f[0].charAt(0) === '~') return String(r[f[0].slice(1)]).indexOf(f[1]) === 0;
        return r[f[0]] === f[1];
      });
    }
    function exec(single) {
      if (op === 'select') {
        if (fail.select) return { data: null, error: fail.select };
        var hit = rows.filter(match);
        return single ? { data: hit[0] || null, error: null } : { data: hit, error: null };
      }
      if (op === 'update') {
        if (fail.update) return { data: null, error: fail.update };
        rows.filter(match).forEach(function (r) {
          Object.keys(payload).forEach(function (k) { r[k] = payload[k]; });
        });
        return { data: null, error: null };
      }
      if (op === 'insert') {
        if (fail.insert) return { data: null, error: fail.insert };
        var row = { id: 'row-' + (nextId++) };
        Object.keys(payload).forEach(function (k) { row[k] = payload[k]; });
        rows.push(row);
        return { data: null, error: null };
      }
      if (op === 'delete') {
        if (fail.delete) return { data: null, error: fail.delete };
        rows = rows.filter(function (r) { return !match(r); });
        return { data: null, error: null };
      }
      return { data: null, error: null };
    }
    var b = {
      eq: function (c, v) { filters.push([c, v]); return b; },
      is: function (c, v) { filters.push([c, v]); return b; },
      like: function (c, v) { filters.push(['~' + c, String(v).replace(/%$/, '')]); return b; },
      select: function () { return b; },
      single: function () { return Promise.resolve(exec(true)); },
      maybeSingle: function () { return Promise.resolve(exec(true)); },
      then: function (res, rej) { return Promise.resolve(exec(false)).then(res, rej); },
    };
    return b;
  }
  var sb = {
    from: function () {
      return {
        select: function () { return builder('select'); },
        update: function (p) { return builder('update', p); },
        insert: function (p) { return builder('insert', p); },
        delete: function () { return builder('delete'); },
      };
    },
  };
  var SHIM_SRC = [
    extractFunctionSource(sbjs, 'kvScopeQuery'),
    extractFunctionSource(sbjs, 'kvGetForProperty'),
    extractFunctionSource(sbjs, 'kvSetForProperty'),
    extractFunctionSource(sbjs, 'kvDeleteForProperty'),
    extractFunctionSource(sbjs, 'kvListForProperty'),
    extractFunctionSource(sbjs, 'installStorageShim'),
    'installStorageShim();',
  ].join('\n\n');
  var ctx = {
    sb: sb,
    currentPropertyId: PID_A,
    currentUser: { id: 'user-1' },
    window: {},
    console: { log: function () {}, warn: function () {}, error: function () {} },
  };
  vm.createContext(ctx);
  vm.runInContext(SHIM_SRC, ctx);
  return { storage: ctx.window.storage, rows: function () { return rows; } };
}
async function rejects(fn) {
  try { var v = await fn(); return { threw: false, value: v }; }
  catch (err) { return { threw: true, value: err }; }
}
{
  var shim = makeShim();
  var ok = await shim.storage.set('fireflow-binder:101', '点検済み', true);
  check('I-0 正常時は従来どおり結果オブジェクトを返す', !!ok && ok.key === 'fireflow-binder:101', ok);

  var s1 = await rejects(function () { return makeShim({ select: { message: 'select failed' } }).storage.set('k', 'v', true); });
  check('I-1 select失敗を例外で伝える(nullを返さない)', s1.threw, s1.value);

  var s2 = await rejects(function () { return makeShim({ insert: { message: 'insert failed' } }).storage.set('k', 'v', true); });
  check('I-2 insert失敗を例外で伝える(nullを返さない)', s2.threw, s2.value);

  var shimUpd = makeShim({ update: { message: 'update failed' } });
  await shimUpd.storage.set('k', 'v1', true);              // 1回目はinsertで成功
  var s3 = await rejects(function () { return shimUpd.storage.set('k', 'v2', true); });
  check('I-3 update失敗を例外で伝える(nullを返さない)', s3.threw, s3.value);

  var d1 = await rejects(function () { return makeShim({ delete: { message: 'delete failed' } }).storage.delete('k', true); });
  check('I-4 delete失敗を例外で伝える(nullを返さない)', d1.threw, d1.value);

  // 別物件向け(outbox再送で使う経路)も同じ契約であること
  var s4 = await rejects(function () { return makeShim({ select: { message: 'x' } }).storage.set('k', 'v', true, PID_B); });
  check('I-5 別物件向けset(kvSetForProperty)も失敗を例外で伝える', s4.threw, s4.value);

  var d2 = await rejects(function () { return makeShim({ delete: { message: 'x' } }).storage.delete('k', true, PID_B); });
  check('I-6 別物件向けdelete(kvDeleteForProperty)も失敗を例外で伝える', d2.threw, d2.value);
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
console.log('==== outbox_no_data_loss_verify (送信キュー消失回帰) 総合結果: PASS (' + results.length + '/' + results.length + ') ====');
})().catch(function (err) {
  console.error('テスト実行中に例外が発生しました:', err);
  process.exit(1);
});
