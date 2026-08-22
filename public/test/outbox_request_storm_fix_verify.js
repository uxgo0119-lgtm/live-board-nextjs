// [2026-08-22新設] TEST-V: request storm 第3原因(送信キューの再送)の修正に対する回帰テスト。
//
// 【実ブラウザで確定している事実】
// 2026-08-22 実Safari / localhost:3000。Network履歴を削除し、何も操作せず数秒待っただけで
// kv_store のリクエストが100件以上発生した。1件クリックして得たURLは次の形で、
// 部屋番号だけが違うものが延々と並んでいた。
//
//     select=id
//     &property_id=eq.b6e18eed-f2f3-4674-812d-322732908616
//     &key=eq.stamp:コスモ六甲ガーデンフォート:113
//     &shared=eq.true
//     &owner_id=is.null
//
// 【なぜこれが「読み込み」ではないと言えるか】
// このパラメータ順(select, property_id, key, shared, owner_id)を作るのは
// supabase-integration.js の window.storage.set() の既存行検索だけである。
// 別物件経路 kvSetForProperty() は kvScopeQuery() を後から掛けるため
// (select, key, shared, property_id, owner_id)の順になり、一致しない。
// つまり storm の正体は【書き込み(保存)の再送】であり、その唯一の定期実行元が flushOutbox()。
// このテストは、その順序をソース検査でも固定する(J-1)。フェイクが実装から離れないようにするため。
//
// 【何を守るテストか】
//   1. 送信キューにN件溜まっていて、リモートが落ちている(kv_store 500)状態で、
//      1回のflushが N件ぶんの select=id を出さないこと(部屋数比例をやめる)。
//   2. それでも【1件も消さない・書き換えない・別物件へ送らない】こと。
//      通信を減らすために保存判定を雑にしたら、このテストは落ちる。
//   3. リモートが正常なときの最終保存結果が【修正前の実装と1バイトも変わらない】こと。
//      修正前の実装はこのファイル内に参照実装として独立に書き起こしてあり、
//      期待値をベタ書きしていないので「期待値を新実装に合わせたから通った」は起こらない。
//
// 既存の public/test/*.js と同じく、index.html の実ソースを文字列で取り出して
// Node.js の vm で実行する(製品コードには一切手を入れない)。
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
var sbSrc = fs.readFileSync(path.join(ROOT, 'supabase-integration.js'), 'utf8');

var PID_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
var PID_B = 'bbbbbbbb-2222-4222-9222-bbbbbbbbbbbb';
// 実端末で実測した物件名(スコープの区切りに日本語が入る形をそのまま使う)
var PROP_A = 'コスモ六甲ガーデンフォート';
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
  extractFunctionSource(html, 'storageListValues'),
  extractFunctionSource(html, 'readValueFromLocalCache'),
  extractFunctionSource(html, 'readRoomValuesBulk'),
  extractFunctionSource(html, 'flushOutbox'),
].join('\n\n');

/* ================================================================
   観測可能なフェイク環境
   ----------------------------------------------------------------
   fakeStorage は supabase-integration.js の window.storage と同じ規則で動き、
   さらに「実際に飛ぶ PostgREST リクエストの形」を1件ずつ記録する。
   実ブラウザのNetworkタブで数えられるものと同じ粒度で数えるためで、
   ここを甘く作ると「関数呼び出しは減ったが通信は減っていない」を見逃す。
   ================================================================ */
function makeEnv(options) {
  options = options || {};
  var idb = { cache: {}, outbox: {} };
  var remoteRows = [];
  var requests = [];      // 実際に飛んだリクエスト(メソッド + クエリ文字列)
  var state = {
    currentPropertyId: options.currentPropertyId !== undefined ? options.currentPropertyId : PID_A,
    // 'ok' … 正常 / 'throw' … 例外(通信断) / 'null' … 失敗を戻り値で伝える(500相当)
    remoteMode: options.remoteMode || 'ok',
    onLine: options.onLine === undefined ? true : !!options.onLine,
  };

  function record(method, query) { requests.push(method + ' ' + query); }
  // supabase-integration.js: if (propertyId && propertyId !== currentPropertyId) ... else 既定経路
  function targetPid(propertyId) { return propertyId || state.currentPropertyId; }
  function ownerFilter(shared) { return shared ? 'owner_id=is.null' : 'owner_id=eq.me'; }
  function findRow(pid, key, shared) {
    for (var i = 0; i < remoteRows.length; i++) {
      var r = remoteRows[i];
      if (r.property_id === pid && r.key === key && r.shared === !!shared) return r;
    }
    return null;
  }
  function failOrNull(what) {
    if (state.remoteMode === 'throw') throw new Error('remote ' + what + ' failed');
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
      /* window.storage.set の第1リクエスト = 既存行検索。実ブラウザで観測されたURLはこれ。
         リモートが落ちているときはここで失敗するので、失敗1件につき飛ぶのは1リクエスト。 */
      record('GET', 'select=id&property_id=eq.' + pid + '&key=eq.' + key
        + '&shared=eq.' + !!shared + '&' + ownerFilter(shared));
      if (state.remoteMode !== 'ok') return failOrNull('set');
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
      if (state.remoteMode !== 'ok') return failOrNull('delete');
      remoteRows = remoteRows.filter(function (r) {
        return !(r.property_id === pid && r.key === key && r.shared === !!shared);
      });
      return { key: key, deleted: true, shared: !!shared };
    },
    list: async function (prefix, shared, propertyId) {
      var pid = targetPid(propertyId);
      record('GET', 'select=key&property_id=eq.' + pid + '&key=like.' + prefix + '%'
        + '&shared=eq.' + !!shared + '&' + ownerFilter(shared));
      if (state.remoteMode !== 'ok') return { keys: [], prefix: prefix, shared: !!shared };
      return {
        keys: remoteRows.filter(function (r) {
          return r.property_id === pid && r.shared === !!shared && r.key.indexOf(prefix) === 0;
        }).map(function (r) { return r.key; }),
        prefix: prefix, shared: !!shared,
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
        }).map(function (r) { return { key: r.key, value: r.value }; }),
        prefix: prefix, shared: !!shared,
      };
    },
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

  var ctx = {
    window: win,
    navigator: { get onLine() { return state.onLine; } },
    document: { addEventListener: function () {} },
    console: { log: function () {}, warn: function () {}, error: function () {} },
    setInterval: function () { return 1; },
    clearInterval: function () {},
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    lcPut: async function (store, record2) { idb[store][record2.key] = record2; },
    lcGet: async function (store, key) { return idb[store][key] || null; },
    lcDelete: async function (store, key) { delete idb[store][key]; },
    lcGetAll: async function (store) {
      return Object.keys(idb[store]).map(function (k) { return idb[store][k]; });
    },
    updateSyncBadge: function () {},
    scheduleOutboxRetry: function () {},
    showSyncCompleteBriefly: function () {},
    isSyncingNow: false,
    outboxRetryTimer: null,
  };
  vm.createContext(ctx);
  vm.runInContext(PRODUCT_SRC, ctx);

  return {
    ctx: ctx,
    idb: idb,
    state: state,
    requests: requests,
    remoteRows: function () { return remoteRows; },
    rowsFor: function (pid) { return remoteRows.filter(function (r) { return r.property_id === pid; }); },
    outboxItems: function () { return Object.keys(idb.outbox).map(function (k) { return idb.outbox[k]; }); },
    cacheItems: function () { return Object.keys(idb.cache).map(function (k) { return idb.cache[k]; }); },
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
  };
}

/* 実端末と同じ形の outbox item を直接キューへ置く。
   propertyId を渡さなければ「Phase 1E-0以前に積まれた、送信先不明の旧item」になる。 */
function seedItem(env, rawKey, value, propertyId) {
  var cacheKey = 'shared:' + rawKey;
  var item = { key: cacheKey, rawKey: rawKey, value: value, shared: true, deleted: false,
    alreadyScoped: true, updatedAt: 1 };
  if (propertyId !== undefined) item.propertyId = propertyId;
  env.idb.outbox[cacheKey] = item;
  return JSON.parse(JSON.stringify(item));
}
function seedStampItems(env, propName, count, propertyId) {
  var keys = [];
  for (var i = 0; i < count; i++) {
    var rawKey = 'stamp:' + propName + ':' + (101 + i);
    seedItem(env, rawKey, '{"room":"' + (101 + i) + '","symbol":"A"}', propertyId);
    keys.push(rawKey);
  }
  return keys;
}
function snapshotOutbox(env) { return JSON.parse(JSON.stringify(env.idb.outbox)); }
function outboxUnchanged(env, before) {
  return JSON.stringify(snapshotOutbox(env)) === JSON.stringify(before);
}
/* 送信を試みて失敗したitemは、既存の storageSet() が同じキーで積み直すため updatedAt だけが
   進む(Phase 1C以前からの仕様で、今回の修正で変えていない)。データとして意味を持つ部分
   ——どのキーへ、どの値を、どの物件へ送るのか——が1つでも変わっていないことを見る。 */
function outboxPayloadUnchanged(env, before) {
  var keys = Object.keys(before).sort();
  var nowKeys = Object.keys(snapshotOutbox(env)).sort();
  if (JSON.stringify(keys) !== JSON.stringify(nowKeys)) return false;
  return keys.every(function (k) {
    var a = before[k];
    var b = env.idb.outbox[k];
    return a.rawKey === b.rawKey && a.value === b.value && a.shared === b.shared
      && a.deleted === b.deleted && a.propertyId === b.propertyId;
  });
}

/* ================================================================
   参照実装: 修正前(d763189時点)の flushOutbox の送信ループ
   ----------------------------------------------------------------
   「再入ガードなし」「連続失敗しても最後まで回す」という、修正前の性質だけを再現する。
   送信可否の判定(Phase 1E-0)と削除条件は修正前後で同一なので、そのまま写している。
   これがあることで、
     ・修正前は本当に N件の select=id が飛ぶ(= stormの構造を再現できている)
     ・リモート正常時の最終結果は修正前後で完全一致する
   の両方を、期待値のベタ書き無しで示せる。
   ================================================================ */
async function referenceFlushOutbox(env) {
  var ctx = env.ctx;
  if (!ctx.window.storage) return;
  if ('onLine' in ctx.navigator && !ctx.navigator.onLine) return;
  var items = await ctx.lcGetAll('outbox');
  if (!items.length) return;
  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    var itemPropertyId = item.propertyId;
    if (itemPropertyId === null || itemPropertyId === undefined || itemPropertyId === '') continue;
    if (!ctx.isValidScopePropertyId(itemPropertyId)) continue;
    var outboxOpts = { alreadyScoped: true, propertyId: itemPropertyId };
    try {
      var result = item.deleted
        ? await ctx.storageDelete(item.rawKey, item.shared, outboxOpts)
        : await ctx.storageSet(item.rawKey, item.value, item.shared, outboxOpts);
      if (!result || result.remote !== true) continue;
      await ctx.lcDelete('outbox', item.key);
    } catch (err) { /* 次回へ持ち越す */ }
  }
}

(async function run() {

/* ================================================================
   N. 修正前の実ブラウザURL形状を再現し、修正後に部屋数比例が消えること
   ================================================================ */
console.log('==== N. 実測された storm の形(select=id + key=eq.stamp:*)の再現と消滅 ====');
{
  // まず「修正前の構造なら本当に129件飛ぶ」ことを示す(再現できていないテストは無価値)。
  var envOld = makeEnv({ currentPropertyId: PID_A, remoteMode: 'null' });
  seedStampItems(envOld, PROP_A, 129, PID_A);
  envOld.clearRequests();
  await referenceFlushOutbox(envOld);
  check('N-1 修正前の実装は1回のflushで129件の select=id + key=eq.stamp:* を出す(storm再現)',
    envOld.stampSelectIdCount() === 129, envOld.stampSelectIdCount());
  check('N-1 実測されたURLの形(select=id&property_id&key=eq.stamp:<物件>:113&shared&owner_id)が一致',
    envOld.requests.indexOf('GET select=id&property_id=eq.' + PID_A
      + '&key=eq.stamp:' + PROP_A + ':113&shared=eq.true&owner_id=is.null') !== -1,
    envOld.requests.slice(0, 2));

  // 修正後は同じ状態でも部屋数に比例しない。
  var envNew = makeEnv({ currentPropertyId: PID_A, remoteMode: 'null' });
  seedStampItems(envNew, PROP_A, 129, PID_A);
  envNew.clearRequests();
  await envNew.ctx.flushOutbox();
  check('N-2 修正後は129件にならない(部屋数比例が消えている)',
    envNew.stampSelectIdCount() < 129, envNew.stampSelectIdCount());
  check('N-2 修正後は数リクエスト程度に収まる(<=3)',
    envNew.stampSelectIdCount() <= 3, envNew.stampSelectIdCount());
  check('N-2 kv_storeへのリクエスト総数も数件(<=3)',
    envNew.requests.length <= 3, envNew.requests.length);
}

/* ================================================================
   A / B. 129室・259室でも件数比例のリクエストにならない
   ================================================================ */
console.log('\n==== A/B. 129室 / 259室でも select=id が件数比例で飛ばない ====');
{
  for (var ci = 0; ci < 2; ci++) {
    var count = [129, 259][ci];
    var label = ['A', 'B'][ci] + '. ' + count + '件';
    for (var mi = 0; mi < 2; mi++) {
      var mode = ['null', 'throw'][mi];     // 500相当 / 通信断
      var env = makeEnv({ currentPropertyId: PID_A, remoteMode: mode });
      seedStampItems(env, PROP_A, count, PID_A);
      var before = snapshotOutbox(env);
      env.clearRequests();
      await env.ctx.flushOutbox();
      check(label + '[' + mode + '] select=id が ' + count + '回にならない',
        env.stampSelectIdCount() <= 3, env.stampSelectIdCount());
      check(label + '[' + mode + '] 1件も削除されない',
        env.outboxItems().length === count, env.outboxItems().length);
      check(label + '[' + mode + '] キー・値・送信先物件が書き換えられない',
        outboxPayloadUnchanged(env, before));
      check(label + '[' + mode + '] リモートへは1件も入らない',
        env.remoteRows().length === 0, env.remoteRows().length);
    }
  }
}

/* ================================================================
   再入: 5秒tickが重なっても多重送信しない
   ================================================================ */
console.log('\n==== 再入ガード: flushが重なっても通信が二重にならない ====');
{
  var env = makeEnv({ currentPropertyId: PID_A, remoteMode: 'null' });
  seedStampItems(env, PROP_A, 129, PID_A);
  var before = snapshotOutbox(env);
  env.clearRequests();
  // 5秒ごとのtickが重なった状態(前のflushがまだ終わっていないのに次が呼ばれる)
  var p1 = env.ctx.flushOutbox();
  var p2 = env.ctx.flushOutbox();
  var p3 = env.ctx.flushOutbox();
  await Promise.all([p1, p2, p3]);
  check('重なった3回のflushでも select=id は数件のまま(多重化しない)',
    env.stampSelectIdCount() <= 3, env.stampSelectIdCount());
  check('重なって呼ばれても outbox のキー・値・送信先物件は変わらない',
    outboxPayloadUnchanged(env, before));
  check('実行後は再入フラグが戻っている(二度と動かなくならない)',
    env.ctx.flushOutbox.inFlight === false, env.ctx.flushOutbox.inFlight);
}

/* ================================================================
   E. 保存結果が修正前と完全一致すること(通信を減らして結果を変えていない)
   ================================================================ */
console.log('\n==== E. リモート正常時の最終保存結果が修正前と完全一致 ====');
{
  function buildFixture(env) {
    // 送信可能なstamp(A物件) + 送信可能なbinder + 別物件(B)のstamp + 送信先不明の旧item
    seedStampItems(env, PROP_A, 40, PID_A);
    seedStampItems(env, PROP_B, 20, PID_B);
    seedItem(env, 'fireflow-binder:101', '{"status":"done"}', PID_A);
    seedItem(env, 'fireflow-binder:807', '旧データ');              // propertyIdフィールド自体が無い
    seedItem(env, 'fireflow-stamp:203', '{"mark":"P"}');           // legacy key。送信先不明
    seedItem(env, 'fireflow-presence:大塚 亮彦', 'presence', '');  // 空文字
  }
  var envRef = makeEnv({ currentPropertyId: PID_A, remoteMode: 'ok' });
  buildFixture(envRef);
  await referenceFlushOutbox(envRef);

  var envNew = makeEnv({ currentPropertyId: PID_A, remoteMode: 'ok' });
  buildFixture(envNew);
  await envNew.ctx.flushOutbox();

  function normRows(rows) {
    return rows.map(function (r) { return [r.property_id, r.key, r.value, r.shared].join('|'); }).sort();
  }
  function normOutbox(env) {
    return env.outboxItems().map(function (it) { return JSON.stringify(it); }).sort();
  }
  check('E リモートへ入った行が修正前と完全一致',
    JSON.stringify(normRows(envNew.remoteRows())) === JSON.stringify(normRows(envRef.remoteRows())),
    [normRows(envNew.remoteRows()).length, normRows(envRef.remoteRows()).length]);
  check('E 送信キューに残ったitemが修正前と完全一致',
    JSON.stringify(normOutbox(envNew)) === JSON.stringify(normOutbox(envRef)),
    [normOutbox(envNew).length, normOutbox(envRef).length]);
  check('E 全件成功する状況では打ち切りが働かない(60件のstampが全部送られている)',
    envNew.remoteRows().filter(function (r) { return r.key.indexOf('stamp:') === 0; }).length === 60,
    envNew.remoteRows().filter(function (r) { return r.key.indexOf('stamp:') === 0; }).length);
}

/* ================================================================
   1件だけ送れないitemがあっても後続を止めないこと
   （打ち切りは「連続失敗」であって「1回でも失敗したら終わり」ではない）
   ================================================================ */
console.log('\n==== 打ち切りは連続失敗のときだけ(1件の失敗で後続を止めない) ====');
{
  var env = makeEnv({ currentPropertyId: PID_A, remoteMode: 'ok' });
  seedStampItems(env, PROP_A, 30, PID_A);
  // 3件目(103)だけ必ず失敗する item-specific なケース
  var origSet = env.ctx.window.storage.set;
  env.ctx.window.storage.set = async function (key, value, shared, propertyId) {
    if (key === 'stamp:' + PROP_A + ':103') { await origSet(key, value, shared, propertyId); return null; }
    return origSet(key, value, shared, propertyId);
  };
  await env.ctx.flushOutbox();
  var left = env.outboxItems();
  check('送れなかった1件だけが残る(後続29件は送られている)',
    left.length === 1 && left[0].rawKey === 'stamp:' + PROP_A + ':103', left.map(function (i) { return i.rawKey; }));
}

/* ================================================================
   F / K. 別物件混入0 / propertyIdの自動付与0
   ================================================================ */
console.log('\n==== F/K. 別物件混入0・propertyId自動付与0 ====');
{
  var env = makeEnv({ currentPropertyId: PID_B, remoteMode: 'ok' });
  seedStampItems(env, PROP_A, 5, PID_A);      // A物件のstampだが、今開いているのはB物件
  seedItem(env, 'stamp:' + PROP_A + ':999', '{"mark":"A"}');   // 送信先不明
  var beforeF = snapshotOutbox(env);
  await env.ctx.flushOutbox();
  check('F A物件のstampはB物件へ入らない', env.rowsFor(PID_B).length === 0, env.rowsFor(PID_B));
  check('F A物件のstampはA物件へだけ入る', env.rowsFor(PID_A).length === 5, env.rowsFor(PID_A).length);
  check('K 送信先不明itemにpropertyIdが付かない',
    env.idb.outbox['shared:stamp:' + PROP_A + ':999'].propertyId === undefined,
    env.idb.outbox['shared:stamp:' + PROP_A + ':999']);
  check('K 送信先不明itemは1バイトも変わらない',
    JSON.stringify(env.idb.outbox['shared:stamp:' + PROP_A + ':999'])
    === JSON.stringify(beforeF['shared:stamp:' + PROP_A + ':999']));
}

/* ================================================================
   G / J. legacy(fireflow-stamp:) と送信先不明itemの扱いが変わらない
   ================================================================ */
console.log('\n==== G/J. legacy扱い差分0・outbox差分0 ====');
{
  var env = makeEnv({ currentPropertyId: PID_B, remoteMode: 'ok' });
  for (var g = 0; g < 43; g++) seedItem(env, 'fireflow-stamp:' + (201 + g), '{"mark":"P"}');
  for (var g2 = 0; g2 < 43; g2++) seedItem(env, 'stamp:' + PROP_A + ':' + (101 + g2), '{"mark":"A"}');
  for (var g3 = 0; g3 < 43; g3++) seedItem(env, 'stamp:' + PROP_B + ':' + (101 + g3), '{"mark":"A"}');
  seedItem(env, 'fireflow-binder:807', 'binder807');
  seedItem(env, 'fireflow-binder:811', 'binder811');
  seedItem(env, 'fireflow-presence:大塚 亮彦', 'presence');
  check('G 前提: 実端末132件相当', env.outboxItems().length === 132, env.outboxItems().length);
  var before132 = snapshotOutbox(env);
  env.clearRequests();
  // 5秒ごとの自動リトライを3回ぶん
  await env.ctx.flushOutbox();
  await env.ctx.flushOutbox();
  await env.ctx.flushOutbox();
  check('G/J 送信先不明の132件は1件も送信されない(kv_storeリクエスト0)',
    env.requests.length === 0, env.requests);
  check('G/J delete 0(132件すべて残っている)', env.outboxItems().length === 132, env.outboxItems().length);
  check('G/J rewrite 0(132件が1バイトも変わっていない)', outboxUnchanged(env, before132));
  check('G/J 現在の物件(B)への混入0件', env.rowsFor(PID_B).length === 0, env.rowsFor(PID_B).length);
}

/* ================================================================
   I. offline: 通信0・差分0
   ================================================================ */
console.log('\n==== I. オフライン時は通信0・保存データ差分0 ====');
{
  var env = makeEnv({ currentPropertyId: PID_A, remoteMode: 'ok', onLine: false });
  seedStampItems(env, PROP_A, 129, PID_A);
  var beforeOff = snapshotOutbox(env);
  env.clearRequests();
  await env.ctx.flushOutbox();
  check('I オフライン中はkv_storeリクエストが1件も飛ばない', env.requests.length === 0, env.requests.length);
  check('I オフライン中でも送信キューは1バイトも変わらない', outboxUnchanged(env, beforeOff));
  check('I オフライン中に再入フラグが立ちっぱなしにならない',
    env.ctx.flushOutbox.inFlight !== true, env.ctx.flushOutbox.inFlight);

  // オンラインへ戻せば従来どおり送信される(打ち切りが恒久停止にならないこと)
  env.state.onLine = true;
  for (var t = 0; t < 200 && env.outboxItems().length > 0; t++) await env.ctx.flushOutbox();
  check('I オンライン復帰後は繰り返しのtickで全件送信できる(恒久停止しない)',
    env.outboxItems().length === 0 && env.rowsFor(PID_A).length === 129,
    [env.outboxItems().length, env.rowsFor(PID_A).length]);
}

/* ================================================================
   H. リモート失敗中でもローカル(IndexedDB)は保持される
   ================================================================ */
console.log('\n==== H. リモート失敗中でもローカルから復元できる ====');
{
  var env = makeEnv({ currentPropertyId: PID_A, remoteMode: 'throw' });
  await env.ctx.storageSet('stamp:' + PROP_A + ':101', '{"mark":"A"}', true);
  await env.ctx.storageSet('stamp:' + PROP_A + ':102', '{"mark":"P"}', true);
  env.clearRequests();
  await env.ctx.flushOutbox();
  var cached = await env.ctx.readValueFromLocalCache('stamp:' + PROP_A + ':101', true);
  check('H リモートが落ちていてもローカルキャッシュから値を読める',
    cached && cached.value === '{"mark":"A"}', cached);
  check('H リモート失敗中も送信キューに2件保持されている',
    env.outboxItems().length === 2, env.outboxItems().length);
  check('H 打ち切っても1件ずつのremote再取得へ戻らない(GET select=value が0件)',
    env.requests.filter(function (r) { return r.indexOf('GET select=value') === 0; }).length === 0,
    env.requests);
}

/* ================================================================
   C / D. 復元経路(StampStore)が1件ずつのremote取得へ戻っていないこと
   ================================================================ */
console.log('\n==== C/D. 復元は prefix まとめ取り1回のまま(N+1へ戻っていない) ====');
{
  var env = makeEnv({ currentPropertyId: PID_A, remoteMode: 'ok' });
  // リモートに129室ぶんのstampがある状態を作る
  for (var s = 0; s < 129; s++) {
    await env.ctx.window.storage.set('stamp:' + PROP_A + ':' + (101 + s),
      '{"room":"' + (101 + s) + '"}', true, PID_A);
  }
  var rooms = [];
  for (var s2 = 0; s2 < 129; s2++) rooms.push('stamp:' + PROP_A + ':' + (101 + s2));
  env.clearRequests();
  var got = await env.ctx.readRoomValuesBulk(rooms, function (k) { return k; }, 'stamp:' + PROP_A + ':');
  check('C 129件の復元でリモート通信は1回だけ', env.requests.length === 1, env.requests);
  check('C 1件ずつの key=eq.stamp:* GET が0件', env.stampSelectIdCount() === 0
    && env.requests.filter(function (r) { return r.indexOf('&key=eq.stamp:') !== -1; }).length === 0,
    env.requests);
  check('C 129件すべて復元できている',
    got.filter(function (r) { return r && r.value; }).length === 129,
    got.filter(function (r) { return r && r.value; }).length);

  // D: legacy prefix でも同じ(prefixが違うだけで経路は共通)
  env.clearRequests();
  var legacyRooms = ['fireflow-stamp:201', 'fireflow-stamp:202', 'fireflow-stamp:203'];
  await env.ctx.readRoomValuesBulk(legacyRooms, function (k) { return k; }, 'fireflow-stamp:');
  check('D legacy(fireflow-stamp:)経路もまとめ取り1回でN+1にならない',
    env.requests.length === 1, env.requests);
}

/* ================================================================
   J-1. ソース検査: フェイクが実装から離れていないこと / 触っていないこと
   ================================================================ */
console.log('\n==== ソース検査 ====');
{
  var sbSet = stripComments(sbSrc.slice(sbSrc.indexOf('async set(key, value, shared, propertyId)')));
  sbSet = sbSet.slice(0, sbSet.indexOf('async delete('));
  var order = ["select('id')", "eq('property_id', currentPropertyId)", "eq('key', key)",
    "eq('shared', !!shared)", "is('owner_id', null)"];
  var lastIdx = -1;
  var ordered = order.every(function (needle) {
    var idx = sbSet.indexOf(needle);
    if (idx === -1 || idx < lastIdx) return false;
    lastIdx = idx;
    return true;
  });
  check('J-1 window.storage.set の既存行検索が実測URLと同じ順序(select,property_id,key,shared,owner_id)',
    ordered, sbSet.slice(0, 200));

  var flushSrc = stripComments(extractFunctionSource(html, 'flushOutbox'));
  check('J-2 flushOutbox に再入ガードがある', flushSrc.indexOf('flushOutbox.inFlight') !== -1);
  check('J-2 再入フラグは finally で必ず戻す',
    /finally\s*\{[^}]*flushOutbox\.inFlight\s*=\s*false/.test(flushSrc), flushSrc.slice(-200));
  check('J-3 連続失敗の打ち切りがある', flushSrc.indexOf('consecutiveRemoteFailures') !== -1);
  check('J-4 flushOutbox内で currentScopePropertyId() を呼んでいない(Phase 1E-0維持)',
    flushSrc.indexOf('currentScopePropertyId') === -1);
  check('J-4 flushOutbox内で getCurrentPropertyId を呼んでいない',
    flushSrc.indexOf('getCurrentPropertyId') === -1);
  check('J-4 flushOutbox内で INITIAL_PROPERTY_ID を参照していない',
    flushSrc.indexOf('INITIAL_PROPERTY_ID') === -1);
  check('J-5 送信できなかったitemを削除していない(lcDelete は成功後の1箇所だけ)',
    (flushSrc.match(/lcDelete\(/g) || []).length === 1, (flushSrc.match(/lcDelete\(/g) || []).length);
  check('J-6 flushOutbox が outbox item の中身を書き換えていない(lcPut を呼ばない)',
    flushSrc.indexOf('lcPut(') === -1);

  // StampStoreの保存キー・migration・outbox仕様に手を入れていないこと
  var storeSrc = stripComments(fs.readFileSync(path.join(ROOT, 'stamp_store', 'stamp_store.js'), 'utf8'));
  check('J-7 StampStoreの保存キー接頭辞が変わっていない',
    storeSrc.indexOf("KEY_PREFIX = 'stamp:'") !== -1
    && storeSrc.indexOf("LEGACY_KEY_PREFIX = 'fireflow-stamp:'") !== -1);
  check('J-8 migrateLegacyKeys は旧キーを削除しない',
    storeSrc.indexOf('adapters.remove(LEGACY') === -1
    && stripComments(extractFunctionSource(storeSrc, 'migrateLegacyKeys')).indexOf('adapters.remove') === -1);
}

/* ================================================================
   結果
   ================================================================ */
var ng = results.filter(function (r) { return !r.ok; });
console.log('\n==== 結果 ====');
results.forEach(function (r) { if (!r.ok) console.log('NG: ' + r.label); });
console.log('==== outbox_request_storm_fix_verify 総合結果: '
  + (ng.length === 0 ? 'PASS' : 'FAIL') + ' (' + (results.length - ng.length) + '/' + results.length + ') ====');
if (ng.length) process.exit(1);

})().catch(function (err) {
  console.error(err);
  process.exit(1);
});
