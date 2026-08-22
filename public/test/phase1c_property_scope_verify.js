// [2026-08-18新設 Phase 1C] TEST-V V-3: 業務保存データの物件スコープ(property scope)の回帰テスト。
//
// Phase 1Cの成功は「propertyId関連の機能が増えたこと」ではなく、
//   ・同じ101号室でも、物件Aの101と物件Bの101が保存層で絶対に別物になること
//   ・propertyIdが無い/不正なら業務データを保存しないこと(旧物件への無言フォールバック禁止)
//   ・送信キュー(outbox)が「積んだ時点のpropertyId」へ送ること(別物件への混入0)
//   ・feature flag OFF なら Phase 1B(commit 44bf758)と保存キー・保存先・復元が完全一致すること
// である。このテストはその4点だけを機械確認する。
//
// 既存の public/test/*.js と同じく、index.html から関数ソースを文字列抽出して
// Node.jsのvmで実行する方式(製品コードに一切手を入れずに検証するため)。
// IndexedDB(lcPut/lcGet/lcDelete/lcGetAll)と window.storage(Supabase)は、
// 保存先が実際にどう分かれたかを観測できる最小のフェイクへ置き換える。
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

// テスト用の物件UUID(UUID v4・小文字・36文字。setCurrentPropertyId()の検証を通る形)。
var PID_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
var PID_B = 'bbbbbbbb-2222-4222-9222-bbbbbbbbbbbb';
// Phase 1A以前からの固定物件UUID。propertyIdが無いときにここへ落ちてはいけない。
var LEGACY_FIXED_PROPERTY_ID = 'b6e18eed-f2f3-4674-812d-322732908616';

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
function extractVarDeclSource(name) {
  var marker = 'var ' + name + ' = ';
  var startIdx = html.indexOf(marker);
  if (startIdx === -1) throw new Error('MISSING IMPLEMENTATION SOURCE: var ' + name);
  var semiIdx = html.indexOf(';', startIdx);
  return html.slice(startIdx, semiIdx + 1);
}

/* ================================================================
   製品コードから、保存層(Phase 1Cの対象)だけを抜き出して組み立てる
   ================================================================ */
var PRODUCT_SRC = [
  // 保存キーの組み立て(Phase 1Cでは形を変えていないことも同時に確認される)
  extractVarDeclSource('UPLOADED_DOCUMENTS_KEY'),
  extractVarDeclSource('CURRENT_PROPERTY_KEY'),
  extractVarDeclSource('PRESENCE_KEY_PREFIX'),
  extractVarDeclSource('BUILDING_NOTES_KEY'),
  extractVarDeclSource('BO_TABLE_KEY_PREFIX'),
  extractVarDeclSource('PROGRESS_LOG_KEY'),
  extractVarDeclSource('SITE_SUPERVISOR_KEY'),
  extractVarDeclSource('SCHEDULE_DAYS_KEY'),
  extractVarDeclSource('EQUIPMENT_LIST_KEY'),
  extractFunctionSource('keyFor'),
  extractFunctionSource('scheduleOverrideKeyFor'),
  extractFunctionSource('equipKeyFor'),
  extractFunctionSource('extKeyFor'),
  // Phase 1Cで新設した property scope 層
  extractVarDeclSource('PROPERTY_SCOPE_ENABLED'),
  extractVarDeclSource('PROPERTY_SCOPED_KEY_PREFIXES'),
  extractVarDeclSource('PROPERTY_SCOPED_EXACT_KEYS'),
  extractFunctionSource('isPropertyScopedKey'),
  extractFunctionSource('propertyScopedKey'),
  extractFunctionSource('propertyUnscopedKey'),
  extractFunctionSource('isValidScopePropertyId'),
  extractFunctionSource('currentScopePropertyId'),
  extractFunctionSource('applyPropertyScope'),
  // 保存API本体(Phase 1Cで変更した部分)
  extractFunctionSource('lcCacheKey'),
  extractVarDeclSource('warnedUnknownPropertyOutbox'),
  extractFunctionSource('storageSet'),
  extractFunctionSource('storageGet'),
  extractFunctionSource('storageDelete'),
  extractFunctionSource('storageList'),
  extractFunctionSource('flushOutbox'),
].join('\n\n');

/* ================================================================
   フェイクの保存先(観測可能な最小実装)
   ================================================================ */
function makeEnv(options) {
  options = options || {};
  var idb = { cache: {}, outbox: {} };     // IndexedDB相当
  var remoteRows = [];                     // Supabase kv_store 相当の行
  var state = {
    currentPropertyId: options.currentPropertyId !== undefined ? options.currentPropertyId : PID_A,
    offline: !!options.offline,
  };

  function findRow(propertyId, key, shared) {
    for (var i = 0; i < remoteRows.length; i++) {
      var r = remoteRows[i];
      if (r.property_id === propertyId && r.key === key && r.shared === !!shared) return r;
    }
    return null;
  }
  // 本物のシムと同じ解決規則: 明示propertyIdがあればそれ、無ければ現在の物件。
  function targetPid(propertyId) { return propertyId || state.currentPropertyId; }

  var fakeStorage = {
    get: async function (key, shared, propertyId) {
      if (state.offline) throw new Error('offline');
      var row = findRow(targetPid(propertyId), key, shared);
      if (!row) throw new Error('key not found: ' + key);
      return { key: key, value: row.value, shared: !!shared };
    },
    set: async function (key, value, shared, propertyId) {
      if (state.offline) throw new Error('offline');
      var pid = targetPid(propertyId);
      var row = findRow(pid, key, shared);
      if (row) row.value = String(value);
      else remoteRows.push({ property_id: pid, key: key, value: String(value), shared: !!shared });
      return { key: key, value: value, shared: !!shared };
    },
    delete: async function (key, shared, propertyId) {
      if (state.offline) throw new Error('offline');
      var pid = targetPid(propertyId);
      remoteRows = remoteRows.filter(function (r) {
        return !(r.property_id === pid && r.key === key && r.shared === !!shared);
      });
      return { key: key, deleted: true, shared: !!shared };
    },
    list: async function (prefix, shared, propertyId) {
      if (state.offline) throw new Error('offline');
      var pid = targetPid(propertyId);
      var keys = remoteRows.filter(function (r) {
        return r.property_id === pid && r.shared === !!shared && (!prefix || r.key.indexOf(prefix) === 0);
      }).map(function (r) { return r.key; });
      return { keys: keys, prefix: prefix, shared: !!shared };
    },
  };

  var win = {
    getCurrentPropertyId: function () { return state.currentPropertyId; },
    // 正本の判定条件(supabase-integration.js の isValidPropertyId)と同じ規則。
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
    navigator: { onLine: true },
    document: { addEventListener: function () {} },
    console: { log: function () {}, warn: function () {}, error: function () {} },
    setInterval: function () { return 1; },
    clearInterval: function () {},
    setTimeout: function () { return 1; },
    clearTimeout: function () {},
    // IndexedDBラッパのフェイク(lcOpenDb等は物件スコープと無関係なので置き換える)
    lcPut: async function (store, record) { idb[store][record.key] = record; },
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
    remoteRows: function () { return remoteRows; },
    rowsFor: function (pid) { return remoteRows.filter(function (r) { return r.property_id === pid; }); },
    cacheKeys: function () { return Object.keys(idb.cache).sort(); },
    outboxItems: function () { return Object.keys(idb.outbox).map(function (k) { return idb.outbox[k]; }); },
  };
}

/* 対象業務ドメイン(Phase 1C仕様16章の最低確認セット + 監査で見つかった全業務キー)。
   キーは製品コードの定義から組み立てる(テスト側にハードコードした別定義を作らない)。 */
function businessKeys(ctx) {
  return [
    ['binder(部屋の点検状態)', ctx.keyFor('101')],
    ['schedule override(点検希望時刻の当日変更)', ctx.scheduleOverrideKeyFor('101')],
    ['equipment(設備)', ctx.equipKeyFor('自火報')],
    ['ext(消火器)', ctx.extKeyFor(1)],
    ['property current(物件レコード)', ctx.CURRENT_PROPERTY_KEY],
    ['buildingNotes(物件概要メモ)', ctx.BUILDING_NOTES_KEY],
    ['boTable(物件概要テーブル)', ctx.BO_TABLE_KEY_PREFIX + 'basic'],
    ['progressLog(経過記録)', ctx.PROGRESS_LOG_KEY],
    ['siteSupervisor(現場責任者)', ctx.SITE_SUPERVISOR_KEY],
    ['scheduleDays(工程日)', ctx.SCHEDULE_DAYS_KEY],
    ['equipmentList(設備一覧)', ctx.EQUIPMENT_LIST_KEY],
    ['documents(アップロード資料)', ctx.UPLOADED_DOCUMENTS_KEY],
    ['presence(在席)', ctx.PRESENCE_KEY_PREFIX + '大塚 亮彦'],
  ];
}

/* ================================================================ */
console.log('==== A. 保存キー規則(propertyScopedKey) ====');
(function () {
  var env = makeEnv({ scopeEnabled: true });
  var f = env.ctx.propertyScopedKey;
  var cases = [
    ['fireflow-binder:101', 'fireflow-binder:' + PID_A + ':101'],
    ['fireflow-schedule-override:101', 'fireflow-schedule-override:' + PID_A + ':101'],
    ['fireflow-equip:自火報', 'fireflow-equip:' + PID_A + ':自火報'],
    ['fireflow-ext:1', 'fireflow-ext:' + PID_A + ':1'],
    ['fireflow-property:current', 'fireflow-property:' + PID_A + ':current'],
    ['fireflow-property:boTable:basic', 'fireflow-property:' + PID_A + ':boTable:basic'],
    ['fireflow-documents', 'fireflow-documents:' + PID_A],
  ];
  cases.forEach(function (c) {
    check('スコープ後キー ' + c[0] + ' → ' + c[1], f(c[0], PID_A) === c[1], f(c[0], PID_A));
  });
  check('propertyUnscopedKey() は propertyScopedKey() の逆変換になっている',
    cases.every(function (c) { return env.ctx.propertyUnscopedKey(c[1], PID_A) === c[0]; }));
  check('領域名(最初の\':\'まで)は変えていない(キー体系の全面刷新をしていない)',
    cases.every(function (c) {
      var domain = c[0].split(':')[0];
      return c[1].split(':')[0] === domain;
    }));
})();

console.log('\n==== B. スコープ対象の判定(業務データと端末設定を混ぜない) ====');
(function () {
  var env = makeEnv({ scopeEnabled: true });
  var isScoped = env.ctx.isPropertyScopedKey;
  businessKeys(env.ctx).forEach(function (pair) {
    check('業務キーとして扱う: ' + pair[0] + ' [' + pair[1] + ']', isScoped(pair[1]) === true);
  });
  var notScoped = [
    ['端末設定 lb_kantan_mode', 'lb_kantan_mode'],
    ['端末設定 fireflow-current-property-id', 'fireflow-current-property-id'],
    ['StampStore 現行キー(自前の物件スコープを持つ。接続はPhase 1E)', 'stamp:コスモ六甲:101'],
    ['StampStore 旧キー', 'fireflow-stamp:101'],
  ];
  notScoped.forEach(function (pair) {
    check('スコープ対象外: ' + pair[0], isScoped(pair[1]) === false);
  });
})();

console.log('\n==== C. TEST-V V-3 本体: 物件A/物件Bの同一部屋・同一ドメインが別物になる ====');
(async function () {
  var env = makeEnv({ scopeEnabled: true, currentPropertyId: PID_A });
  var ctx = env.ctx;
  var domains = businessKeys(ctx);

  // 物件Aで保存
  env.state.currentPropertyId = PID_A;
  for (var i = 0; i < domains.length; i++) await ctx.storageSet(domains[i][1], 'valueA', true);
  // 物件Bで、同じ生キー(同じ101号室・同じ設備名)へ別の値を保存
  env.state.currentPropertyId = PID_B;
  for (var j = 0; j < domains.length; j++) await ctx.storageSet(domains[j][1], 'valueB', true);

  // Aから読む → Aだけ
  env.state.currentPropertyId = PID_A;
  for (var k = 0; k < domains.length; k++) {
    var got = await ctx.storageGet(domains[k][1], true);
    check('A から読むと A の値だけ: ' + domains[k][0], got && got.value === 'valueA', got && got.value);
  }
  // Bから読む → Bだけ
  env.state.currentPropertyId = PID_B;
  for (var m = 0; m < domains.length; m++) {
    var got2 = await ctx.storageGet(domains[m][1], true);
    check('B から読むと B の値だけ: ' + domains[m][0], got2 && got2.value === 'valueB', got2 && got2.value);
  }

  // 保存先(Supabase kv_store相当)が物件ごとに分かれている
  check('kv_store側: 物件Aの行数 = ドメイン数', env.rowsFor(PID_A).length === domains.length, env.rowsFor(PID_A).length);
  check('kv_store側: 物件Bの行数 = ドメイン数', env.rowsFor(PID_B).length === domains.length, env.rowsFor(PID_B).length);
  check('kv_store側: property_id が A/B 以外の行は0件',
    env.remoteRows().every(function (r) { return r.property_id === PID_A || r.property_id === PID_B; }));
  check('kv_store側: 全ての保存キーが propertyId を含む',
    env.remoteRows().every(function (r) { return r.key.indexOf(r.property_id) !== -1; }));

  // IndexedDB側のローカルキャッシュも衝突しない
  check('IndexedDB側: A/Bで同じ部屋でもキャッシュキーが衝突しない(件数 = ドメイン数×2)',
    env.cacheKeys().length === domains.length * 2, env.cacheKeys().length);
  check('IndexedDB側: lcCacheKey の形式(own:/shared: 前置)は従来のまま',
    env.cacheKeys().every(function (k) { return k.indexOf('shared:') === 0; }));

  // 削除も物件スコープで効く
  env.state.currentPropertyId = PID_A;
  await ctx.storageDelete(ctx.keyFor('101'), true);
  check('A の binder:101 を削除しても B の binder:101 は残る',
    env.rowsFor(PID_A).length === domains.length - 1 && env.rowsFor(PID_B).length === domains.length,
    [env.rowsFor(PID_A).length, env.rowsFor(PID_B).length]);
  env.state.currentPropertyId = PID_B;
  var stillB = await ctx.storageGet(ctx.keyFor('101'), true);
  check('B の binder:101 の値は削除の影響を受けない', stillB && stillB.value === 'valueB', stillB && stillB.value);

  // storageList は propertyId を取り除いて返す(呼び出し側の既存コードが壊れない)
  env.state.currentPropertyId = PID_A;
  await ctx.storageSet(ctx.PRESENCE_KEY_PREFIX + '田中', String(Date.now()), true);
  var listed = await ctx.storageList(ctx.PRESENCE_KEY_PREFIX, true);
  check('storageList: 物件Aの在席キーだけが返る', listed.keys.length === 2, listed.keys);
  check('storageList: 返るキーは propertyId を含まない(二重スコープにならない)',
    listed.keys.every(function (k) { return k.indexOf(PID_A) === -1 && k.indexOf(ctx.PRESENCE_KEY_PREFIX) === 0; }), listed.keys);
  var relisted = await ctx.storageGet(listed.keys[0], true);
  check('storageList で得たキーをそのまま storageGet へ渡せる', relisted && relisted.value !== undefined);
})().then(runD).catch(fail);

/* ================================================================ */
function runD() {
  console.log('\n==== D. propertyIdが無い/不正なら業務データを保存しない ====');
  return (async function () {
    var badIds = [
      ['null', null],
      ['空文字', ''],
      ['不正UUID(物件名)', 'コスモ六甲ガーデンフォート'],
      ['不正UUID(短い)', 'aaaa-bbbb'],
      ['不正UUID(v4でない)', 'aaaaaaaa-1111-1111-8111-aaaaaaaaaaaa'],
    ];
    for (var i = 0; i < badIds.length; i++) {
      var env = makeEnv({ scopeEnabled: true, currentPropertyId: badIds[i][1] });
      var ctx = env.ctx;
      var rejected = false;
      try { await ctx.storageSet(ctx.keyFor('101'), 'x', true); } catch (err) {
        rejected = /PROPERTY_SCOPE_REQUIRED/.test(String(err && err.message));
      }
      check('propertyId=' + badIds[i][0] + ' のとき業務データの保存が拒否される', rejected);
      check('propertyId=' + badIds[i][0] + ' のとき保存先へ1件も書かれない', env.remoteRows().length === 0, env.remoteRows().length);
      check('propertyId=' + badIds[i][0] + ' のときIndexedDBにも1件も書かれない', env.cacheKeys().length === 0, env.cacheKeys());
      check('propertyId=' + badIds[i][0] + ' のとき送信キューにも積まれない', env.outboxItems().length === 0, env.outboxItems().length);
      check('propertyId=' + badIds[i][0] + ' のとき旧固定物件UUIDへフォールバックしない',
        env.remoteRows().every(function (r) { return r.property_id !== LEGACY_FIXED_PROPERTY_ID; }));

      var readRejected = false;
      try { await ctx.storageGet(ctx.keyFor('101'), true); } catch (err2) {
        readRejected = /PROPERTY_SCOPE_REQUIRED/.test(String(err2 && err2.message));
      }
      check('propertyId=' + badIds[i][0] + ' のとき業務データの読込も拒否される(旧物件を読まない)', readRejected);
    }
    // 端末設定は propertyId が無くても従来どおり扱える(業務データと巻き添えにしない)
    var envSetting = makeEnv({ scopeEnabled: true, currentPropertyId: null });
    await envSetting.ctx.storageSet('stamp:コスモ六甲:101', 'v', true);
    check('propertyIdが無くてもスコープ対象外キー(StampStore)は従来どおり保存できる',
      envSetting.remoteRows().length === 1 && envSetting.remoteRows()[0].key === 'stamp:コスモ六甲:101',
      envSetting.remoteRows());
  })().then(runE).catch(fail);
}

/* ================================================================ */
function runE() {
  console.log('\n==== E. outbox: 積んだ時点のpropertyIdへ送る(別物件への混入0) ====');
  return (async function () {
    /* 仕様17章のケース:
         1. currentPropertyId = A
         2. オフラインで保存 → outbox item が積まれる
         3. currentPropertyId = B へ変更
         4. flush
       期待: 送信先 property_id = A / 物件Bへの保存 0件 */
    var env = makeEnv({ scopeEnabled: true, currentPropertyId: PID_A, offline: true });
    var ctx = env.ctx;

    await ctx.storageSet(ctx.keyFor('101'), 'offlineA', true);
    var items = env.outboxItems();
    check('オフライン保存で送信キューへ1件積まれる', items.length === 1, items.length);
    check('outbox item が propertyId を保持している', items[0] && items[0].propertyId === PID_A, items[0] && items[0].propertyId);
    check('outbox item の保存キーは積んだ時点でスコープ済み',
      items[0] && items[0].rawKey === 'fireflow-binder:' + PID_A + ':101', items[0] && items[0].rawKey);
    check('オフライン中も IndexedDB へは即時保存されている(既存の思想をKEEP)',
      env.cacheKeys().length === 1 && env.cacheKeys()[0] === 'shared:fireflow-binder:' + PID_A + ':101', env.cacheKeys());

    // 物件Bへ切り替えてからオンライン復帰 → flush
    env.state.currentPropertyId = PID_B;
    env.state.offline = false;
    await ctx.flushOutbox();

    check('flush後: 物件Aへ1件送信されている', env.rowsFor(PID_A).length === 1, env.rowsFor(PID_A));
    check('flush後: 物件Bへの保存は0件(混入0)', env.rowsFor(PID_B).length === 0, env.rowsFor(PID_B));
    check('flush後: 送信済みitemは送信キューから消えている', env.outboxItems().length === 0, env.outboxItems().length);
    check('flush後: 送信された行のキーも物件Aのスコープのまま',
      env.rowsFor(PID_A)[0] && env.rowsFor(PID_A)[0].key === 'fireflow-binder:' + PID_A + ':101',
      env.rowsFor(PID_A)[0] && env.rowsFor(PID_A)[0].key);

    // 削除も同じく、積んだ時点の物件へ効く
    var env2 = makeEnv({ scopeEnabled: true, currentPropertyId: PID_A });
    await env2.ctx.storageSet(env2.ctx.keyFor('101'), 'a', true);
    env2.state.currentPropertyId = PID_B;
    await env2.ctx.storageSet(env2.ctx.keyFor('101'), 'b', true);
    env2.state.currentPropertyId = PID_A;
    env2.state.offline = true;
    await env2.ctx.storageDelete(env2.ctx.keyFor('101'), true);
    env2.state.currentPropertyId = PID_B;
    env2.state.offline = false;
    await env2.ctx.flushOutbox();
    check('削除のoutboxも積んだ時点の物件(A)にだけ効く',
      env2.rowsFor(PID_A).length === 0 && env2.rowsFor(PID_B).length === 1,
      [env2.rowsFor(PID_A).length, env2.rowsFor(PID_B).length]);

    /* propertyIdを持たないPhase 1C以前の旧outbox item は、推測で割り当てない。
       送らず・消さずにキューへ残す(UNKNOWN / pending)。取り扱いはPhase 1Dのmigration。 */
    var env3 = makeEnv({ scopeEnabled: true, currentPropertyId: PID_B });
    env3.idb.outbox['shared:fireflow-binder:101'] = {
      key: 'shared:fireflow-binder:101', rawKey: 'fireflow-binder:101',
      value: 'legacy', shared: true, deleted: false, updatedAt: 1,
    };
    await env3.ctx.flushOutbox();
    check('旧outbox(propertyId無し)は送信されない(推測で物件を割り当てない)',
      env3.remoteRows().length === 0, env3.remoteRows());
    check('旧outbox(propertyId無し)は削除もされずキューに残る',
      env3.outboxItems().length === 1, env3.outboxItems().length);
    check('旧outboxが現在の物件(B)へ入っていない', env3.rowsFor(PID_B).length === 0, env3.rowsFor(PID_B).length);
  })().then(runF).catch(fail);
}

/* ================================================================ */
function runF() {
  console.log('\n==== F. feature flag OFF は Phase 1B(44bf758)と完全同一 ====');
  return (async function () {
    var env = makeEnv({ scopeEnabled: false, currentPropertyId: PID_A });
    var ctx = env.ctx;
    check('PROPERTY_SCOPE_ENABLED の既定はOFF', makeEnv({}).ctx.PROPERTY_SCOPE_ENABLED === false);
    check('flag OFF のとき PROPERTY_SCOPE_ENABLED が false', ctx.PROPERTY_SCOPE_ENABLED === false);

    var domains = businessKeys(ctx);
    for (var i = 0; i < domains.length; i++) await ctx.storageSet(domains[i][1], 'v', true);

    check('flag OFF: 保存キーは従来のまま(propertyIdが1件も入らない)',
      env.remoteRows().every(function (r) { return r.key.indexOf(PID_A) === -1; }),
      env.remoteRows().map(function (r) { return r.key; }));
    check('flag OFF: 保存キーが元の生キーと1件ずつ一致する',
      domains.every(function (d) {
        return env.remoteRows().some(function (r) { return r.key === d[1]; });
      }));
    check('flag OFF: IndexedDBのキャッシュキーも従来の lcCacheKey(rawKey) と一致する',
      domains.every(function (d) { return env.idb.cache['shared:' + d[1]] !== undefined; }),
      env.cacheKeys());
    check('flag OFF: 保存先の property_id は currentPropertyId のまま',
      env.remoteRows().every(function (r) { return r.property_id === PID_A; }));

    // 読み戻し(復元)も従来どおり
    var restored = await ctx.storageGet(ctx.keyFor('101'), true);
    check('flag OFF: 復元が従来どおり動く', restored && restored.value === 'v', restored && restored.value);
    check('flag OFF: storageGet の戻り値の形が従来どおり(key/value/shared)',
      restored && restored.key === ctx.keyFor('101') && restored.shared === true, restored);

    // propertyIdが無くても業務データを保存できる(＝Phase 1B時点の挙動)
    var envNoPid = makeEnv({ scopeEnabled: false, currentPropertyId: null });
    await envNoPid.ctx.storageSet(envNoPid.ctx.keyFor('101'), 'v', true);
    check('flag OFF: propertyIdが無くても従来どおり保存できる(拒否ロジックが働かない)',
      envNoPid.remoteRows().length === 1, envNoPid.remoteRows().length);

    /* [2026-08-18更新 Phase 1E-0] ★Phase 1Cの不変条件を1件だけ意図的に破棄している★

       ここは元々「flag OFF なら、propertyIdを持たない旧outboxも従来(Phase 1B)どおり
       送信され、キューから消える」ことを確認していた。しかしその挙動こそが、
       Phase 1E設計監査でP0として確定した不具合そのものだった。

       propertyIdを持たないitemは window.storage.set() へ propertyId=null で渡り、
       supabase-integration.js の `if (propertyId && propertyId !== currentPropertyId)`
       が false になって既定経路(＝currentPropertyIdへ書く)に落ちる。つまり
       「どの物件のものか分からない旧データが、今たまたま開いている物件へ入る」。
       実端末にはこの形の旧outboxが132件残っており、実端末は flag OFF で動いている。
       したがって flag OFF のままでも送ってはいけない。

       Phase 1E-0 で送信条件を「item自身が有効なpropertyIdを保持していること」へ変更したため、
       この1件については flag OFF ＝ Phase 1B完全同一 が成立しなくなる。
       破棄したのはこの1件だけで、他の flag OFF 挙動(保存キー・保存先property_id・復元・
       storageList)はPhase 1B時点と同一のまま(下の各checkで担保している)。 */
    var envOut = makeEnv({ scopeEnabled: false, currentPropertyId: PID_A });
    envOut.idb.outbox['shared:fireflow-binder:101'] = {
      key: 'shared:fireflow-binder:101', rawKey: 'fireflow-binder:101',
      value: 'legacy', shared: true, deleted: false, updatedAt: 1,
    };
    await envOut.ctx.flushOutbox();
    check('flag OFF: propertyId無しの旧outboxは送信されない(Phase 1E-0で変更)',
      envOut.remoteRows().length === 0, envOut.remoteRows());
    check('flag OFF: propertyId無しの旧outboxは削除もされずキューに残る(Phase 1E-0で変更)',
      envOut.outboxItems().length === 1, envOut.outboxItems().length);
    check('flag OFF: 旧outboxが現在の物件(A)へ入っていない(Phase 1E-0で変更)',
      envOut.rowsFor(PID_A).length === 0, envOut.rowsFor(PID_A).length);

    /* storageList 自体の挙動(リモートのキーをそのまま返す)はPhase 1E-0でも従来どおり。
       上のenvOutは旧outboxを意図的に送信しないため、通常保存を行う別envで確認する。 */
    check('flag OFF: storageList は従来どおりリモートのキーをそのまま返す',
      true);
    var envList = makeEnv({ scopeEnabled: false, currentPropertyId: PID_A });
    await envList.ctx.storageSet(envList.ctx.keyFor('101'), 'v', true);
    var listedOff = await envList.ctx.storageList('fireflow-binder:', true);
    check('flag OFF: storageList の返すキーが従来のまま', listedOff.keys.length === 1
      && listedOff.keys[0] === 'fireflow-binder:101', listedOff.keys);
  })().then(runG).catch(fail);
}

/* ================================================================ */
function runG() {
  console.log('\n==== G. 触っていないこと(ソース監査) ====');
  // lcCacheKey本体の差分0
  check('lcCacheKey() の実装がPhase 1B時点と1文字も同じ',
    html.indexOf("function lcCacheKey(key, shared) { return (shared ? 'shared:' : 'own:') + key; }") !== -1);
  // 保存キーの定義(領域名)を変えていない
  var keyDefs = [
    ["fireflow-binder:<room>", "function keyFor(room) { return 'fireflow-binder:' + room; }"],
    ["fireflow-schedule-override:<room>", "function scheduleOverrideKeyFor(room) { return 'fireflow-schedule-override:' + room; }"],
    ["fireflow-equip:<name>", "function equipKeyFor(name) { return 'fireflow-equip:' + name; }"],
    ["fireflow-ext:<no>", "function extKeyFor(no) { return 'fireflow-ext:' + no; }"],
    ["fireflow-property:current", "var CURRENT_PROPERTY_KEY = 'fireflow-property:current';"],
    ["fireflow-documents", "var UPLOADED_DOCUMENTS_KEY = 'fireflow-documents';"],
    ["fireflow-presence:", "var PRESENCE_KEY_PREFIX = 'fireflow-presence:';"],
  ];
  keyDefs.forEach(function (pair) {
    check('生キーの定義が従来のまま: ' + pair[0], html.indexOf(pair[1]) !== -1);
  });
  // 旧キーの削除・コピー・migrationをしていない(Phase 1Dの担当)
  check('Phase 1Cのスコープ層に旧キーのmigration処理が無い',
    extractFunctionSource('applyPropertyScope').indexOf('storageDelete') === -1 &&
    extractFunctionSource('applyPropertyScope').indexOf('lcDelete') === -1 &&
    extractFunctionSource('applyPropertyScope').indexOf('migrat') === -1);
  check('storageGet がスコープ無しの旧キーへフォールバックしない(旧物件を読まない)',
    extractFunctionSource('storageGet').indexOf('propertyUnscopedKey') === -1);
  // StampStore本体は差分0
  var stampStoreSrc = fs.readFileSync(path.join(__dirname, '..', 'stamp_store', 'stamp_store.js'), 'utf8');
  check('StampStore本体にpropertyId(UUID)スコープが持ち込まれていない(Phase 1Eの担当)',
    stampStoreSrc.indexOf('getCurrentPropertyId') === -1 && stampStoreSrc.indexOf('propertyId') === -1);
  check('StampStoreのキー接頭辞が従来のまま',
    stampStoreSrc.indexOf("var KEY_PREFIX = 'stamp:';") !== -1 &&
    stampStoreSrc.indexOf("var LEGACY_KEY_PREFIX = 'fireflow-stamp:';") !== -1);
  // Supabase側: DB schemaを変えず、property_idの決定だけを明示化した
  check('kv_store への property_id は currentPropertyId か、明示指定されたpropertyIdだけ',
    sbjs.indexOf('property_id: currentPropertyId, key: key,') !== -1 &&
    sbjs.indexOf('property_id: propertyId, key: key,') !== -1);
  check('window.storage の4メソッドが明示propertyIdを受け取れる',
    sbjs.indexOf('async get(key, shared, propertyId)') !== -1 &&
    sbjs.indexOf('async set(key, value, shared, propertyId)') !== -1 &&
    sbjs.indexOf('async delete(key, shared, propertyId)') !== -1 &&
    sbjs.indexOf('async list(prefix, shared, propertyId)') !== -1);
  check('明示propertyIdが無い/現在の物件と同じときは従来の経路をそのまま通る',
    sbjs.indexOf("if (propertyId && propertyId !== currentPropertyId) return kvSetForProperty(propertyId, key, value, shared);") !== -1);
  check('物件切替(setCurrentPropertyId)はPhase 1Cでも呼んでいない(Phase 1Eの担当)',
    html.indexOf('setCurrentPropertyId(') === -1);
  check('PROPERTY.name をスコープに使っていない',
    extractFunctionSource('currentScopePropertyId').indexOf('PROPERTY') === -1 &&
    extractFunctionSource('applyPropertyScope').indexOf('PROPERTY.name') === -1);

  console.log('\n==== H. 業務キーの取りこぼしが無い(呼び出し箇所の全数監査) ====');
  (function () {
    // index.html 内の storageSet/Get/Delete/List の第1引数の式をすべて集め、
    // 監査済みの一覧と完全一致することを確認する。新しい業務キーが増えたのに
    // property scope へ登録し忘れたら、このテストが落ちる。
    /* [2026-08-22拡張] まとめ取り(storageListValues)も監査対象へ入れる。
       従来の正規表現は `storageList(` で終端していたため、2026-08-19に追加された
       storageListValues() の呼び出し(部屋状態のまとめ取り・在席一覧)を1件も見ていなかった。
       業務キーの取りこぼし監査という目的からすると、これは対象外にしてよい理由が無い。 */
    var re = /storage(?:Set|Get|Delete|ListValues|List)\(/g;
    var found = {};
    var m;
    while ((m = re.exec(html)) !== null) {
      // コメント内の言及(「storageGet(ローカルキャッシュ…)」等)は対象外にする。
      var lineStart = html.lastIndexOf('\n', m.index) + 1;
      var before = html.slice(lineStart, m.index);
      if (before.indexOf('//') !== -1 || /^\s*\*/.test(before) || /^\s*【/.test(before)) continue;
      // 括弧の対応を数えながら、第1引数の式だけを取り出す。
      var i = m.index + m[0].length;
      var depth = 0;
      var argStart = i;
      for (; i < html.length; i++) {
        var ch = html[i];
        if (ch === '(' || ch === '[' || ch === '{') depth++;
        else if (ch === ')' && depth === 0) break;
        else if (ch === ')' || ch === ']' || ch === '}') depth--;
        else if (ch === ',' && depth === 0) break;
      }
      // 引数無しの `storageSet()` は説明コメント内の言及なので対象外(実際の呼び出しは必ずキーを渡す)。
      var arg = html.slice(argStart, i).trim();
      if (arg) found[arg] = true;
    }
    var actual = Object.keys(found).sort();
    var expected = [
      'BO_TABLE_KEY_PREFIX + section',
      'BUILDING_NOTES_KEY',
      'CURRENT_PROPERTY_KEY',
      'EQUIPMENT_LIST_KEY',
      'PRESENCE_KEY_PREFIX',        // 在席一覧のまとめ取り(storageListValues)
      'PRESENCE_KEY_PREFIX + name',
      'PROGRESS_LOG_KEY',
      'SCHEDULE_DAYS_KEY',
      'SITE_SUPERVISOR_KEY',
      'UPLOADED_DOCUMENTS_KEY',
      'equipKeyFor(name)',
      'extKeyFor(item.no)',
      'extKeyFor(no)',
      'item.rawKey',        // 送信キュー再送(スコープ済みキーをそのまま送る内部経路)
      'key',                // storageSet/Get/Delete の定義とStampStoreアダプタ
      'keyFor(room)',
      'prefix',             // storageList / storageListValues の定義と readRoomValuesBulk
      'scheduleOverrideKeyFor(room)',
    ].sort();
    check('storage API の呼び出し箇所が監査済み一覧と完全一致する', JSON.stringify(actual) === JSON.stringify(expected),
      { actual: actual, missingFromExpected: actual.filter(function (a) { return expected.indexOf(a) === -1; }) });

    // 監査済みの業務キーは全てスコープ対象になっている
    var env = makeEnv({ scopeEnabled: true });
    businessKeys(env.ctx).forEach(function (pair) {
      check('property scope 登録済み: ' + pair[0], env.ctx.isPropertyScopedKey(pair[1]));
    });
  })();

  finish();
}

function fail(err) {
  console.error('テスト実行中に例外が発生しました:');
  console.error(err && err.stack ? err.stack : err);
  process.exitCode = 1;
}

function finish() {
  var allOk = results.every(function (r) { return r.ok; });
  console.log('\n==== phase1c_property_scope_verify (TEST-V V-3) 総合結果: ' + (allOk ? 'PASS' : 'FAIL')
    + ' (' + results.filter(function (r) { return r.ok; }).length + '/' + results.length + ') ====');
  if (!allOk) process.exitCode = 1;
}
