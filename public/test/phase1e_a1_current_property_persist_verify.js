// [2026-08-18新設 Phase 1E-A1] currentPropertyId の端末永続化・起動時復元 回帰テスト。
//
// Phase 1E-A1の成功条件は「物件を切り替えられること」ではない。
//
//   一度決まった currentPropertyId を、reloadしても同じ値として安全に復元できること。
//
// 守るべき禁止事項（1つでも破れたら、別物件のデータが混ざる／起動できなくなる）:
//   ・不正なpropertyIdを採用する
//   ・不正なpropertyIdを端末へ保存する
//   ・保存が無い／壊れているときに、勝手に別の物件へ切り替える
//   ・setCurrentPropertyId 以外の経路で currentPropertyId を書き換える
//   ・localStorageが使えない端末（Safariプライベートモード等）で起動できなくなる
//   ・currentPropertyId が最初に使われた後で復元する
//   ・feature flag OFF の業務保存キーを変える
//   ・propertyId無しの旧outboxの扱いを変える
//
// このテストは supabase-integration.js を「ブラウザと同じく丸ごと同期評価」して検査する
// （関数だけ切り出すと、肝心の「いつ復元されるか」を検査できないため）。
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

var STORAGE_KEY = 'lb_current_property_id';
// Phase 1A以前から使われている、この環境の組み込み物件UUID（コスモ六甲ガーデンフォート）。
// Phase 1E-A1では「保存が無ければ従来どおりこの値で起動する」ことを維持する。
var INITIAL_PROPERTY_ID = 'b6e18eed-f2f3-4674-812d-322732908616';
var PID_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
var PID_B = 'bbbbbbbb-2222-4222-9222-bbbbbbbbbbbb';

/* ================================================================
   ソース抽出（既存の public/test/*.js と同じ方式）
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
function stripComments(src) {
  return String(src).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}
function countOccurrences(haystack, needle) {
  var n = 0, i = 0;
  for (;;) {
    var found = haystack.indexOf(needle, i);
    if (found === -1) return n;
    n++;
    i = found + needle.length;
  }
}

/* ================================================================
   起動シミュレータ
   ------------------------------------------------------------
   supabase-integration.js を、ブラウザの <head> 内同期スクリプトと同じ形で
   丸ごと評価する。CDNの supabase-js は onload が発火しないため、
   このテストで動くのは「起動時に同期実行される部分」だけになる。
   ＝ currentPropertyId の復元がそこで完了しているかを、そのまま検査できる。
   ================================================================ */
function bootLiveBoard(options) {
  options = options || {};
  var backing = options.backing || Object.create(null);
  var calls = { getItem: [], setItem: [], removeItem: [] };
  var fakeLocalStorage = {
    getItem: function (k) {
      calls.getItem.push(k);
      if (options.getItemThrows) throw new Error('SecurityError: localStorage is not available');
      return Object.prototype.hasOwnProperty.call(backing, k) ? backing[k] : null;
    },
    setItem: function (k, v) {
      calls.setItem.push({ key: k, value: v });
      if (options.setItemThrows) throw new Error('QuotaExceededError');
      backing[k] = String(v);
    },
    removeItem: function (k) { calls.removeItem.push(k); delete backing[k]; },
  };

  var win = { addEventListener: function () {} };
  if (!options.noLocalStorage) win.localStorage = fakeLocalStorage;

  var thrown = null;
  var ctx = vm.createContext({
    window: win,
    document: {
      createElement: function () { return {}; },
      head: { appendChild: function () {} },
      addEventListener: function () {},
      body: null,
    },
    console: { log: function () {}, warn: function () {}, error: function () {} },
    navigator: { onLine: true },
    setTimeout: function () { return 1; },
    clearTimeout: function () {},
    setInterval: function () { return 1; },
    clearInterval: function () {},
  });
  try {
    vm.runInContext(sbjs, ctx);
  } catch (e) {
    thrown = e;
  }
  return {
    win: win, ctx: ctx, backing: backing, calls: calls, thrown: thrown,
    booted: function () { return !thrown && typeof win.getCurrentPropertyId === 'function'; },
    current: function () { return win.getCurrentPropertyId(); },
    stored: function () { return Object.prototype.hasOwnProperty.call(backing, STORAGE_KEY) ? backing[STORAGE_KEY] : null; },
    setItemCallsForKey: function () {
      return calls.setItem.filter(function (c) { return c.key === STORAGE_KEY; });
    },
  };
}

/* ================================================================
   A. localStorageに有効A → 起動時 currentPropertyId = A
   ================================================================ */
console.log('==== A. 端末に保存された有効なpropertyIdを起動時に復元する ====');
{
  var backingA = Object.create(null);
  backingA[STORAGE_KEY] = PID_A;
  var envA = bootLiveBoard({ backing: backingA });
  check('A 起動が成功する', envA.booted(), envA.thrown && String(envA.thrown));
  check('A currentPropertyId が保存値A（INITIAL_PROPERTY_IDではない）',
    envA.current() === PID_A, envA.current());
  check('A 復元はスクリプト評価と同時（同期）に完了している＝非同期待ちが無い',
    envA.calls.getItem.indexOf(STORAGE_KEY) !== -1);
  check('A 復元で保存内容が書き換わらない（同じ値のまま）', envA.stored() === PID_A, envA.stored());
}

/* ================================================================
   B. localStorage無し → 既存の初期値のまま（勝手に別物件へ行かない）
   ================================================================ */
console.log('\n==== B. 保存が無いときは既存の起動挙動を維持する ====');
{
  var envB = bootLiveBoard({});
  check('B 起動が成功する', envB.booted(), envB.thrown && String(envB.thrown));
  check('B currentPropertyId は従来どおり INITIAL_PROPERTY_ID',
    envB.current() === INITIAL_PROPERTY_ID, envB.current());
  check('B 保存が無いのに勝手に書き込まない（INITIAL_PROPERTY_IDを既定として固定化しない）',
    envB.setItemCallsForKey().length === 0, envB.calls.setItem);
  check('B lb_current_property_id は未保存のまま', envB.stored() === null, envB.stored());
}
{
  // 空文字が入っている＝「保存が無い」と同じ扱い（別物件へ行かない）
  var backingEmpty = Object.create(null);
  backingEmpty[STORAGE_KEY] = '';
  var envEmpty = bootLiveBoard({ backing: backingEmpty });
  check('B 空文字が保存されていても INITIAL_PROPERTY_ID のまま起動する',
    envEmpty.booted() && envEmpty.current() === INITIAL_PROPERTY_ID, envEmpty.current());
  check('B 空文字を上書きしない（推測でpropertyIdを埋めない）',
    envEmpty.setItemCallsForKey().length === 0 && envEmpty.stored() === '', envEmpty.stored());
}

/* ================================================================
   C. 不正UUID → 採用0 / localStorage書換0
   ================================================================ */
console.log('\n==== C. 壊れた保存値を採用しない・直しにいかない ====');
{
  var badValues = [
    ['UUIDでない文字列', 'not-a-uuid'],
    ['大文字UUID', 'AAAAAAAA-1111-4111-8111-AAAAAAAAAAAA'],
    ['桁足らず', 'aaaaaaaa-1111-4111-8111-aaaaaaaaaa'],
    ['桁あまり', 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaaa'],
    ['v4でない(version桁が3)', 'aaaaaaaa-1111-3111-8111-aaaaaaaaaaaa'],
    ['variantが不正(先頭がc)', 'aaaaaaaa-1111-4111-c111-aaaaaaaaaaaa'],
    ['前後に空白', ' aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa '],
    ['物件名', 'コスモ六甲ガーデンフォート'],
    ['JSON', '{"propertyId":"aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa"}'],
    ['null文字列', 'null'],
    ['undefined文字列', 'undefined'],
  ];
  for (var ci = 0; ci < badValues.length; ci++) {
    var backingBad = Object.create(null);
    backingBad[STORAGE_KEY] = badValues[ci][1];
    var envC = bootLiveBoard({ backing: backingBad });
    check('C 不正値(' + badValues[ci][0] + '): 起動は継続する',
      envC.booted(), envC.thrown && String(envC.thrown));
    check('C 不正値(' + badValues[ci][0] + '): 採用0（INITIAL_PROPERTY_IDのまま・別物件へ行かない）',
      envC.current() === INITIAL_PROPERTY_ID, envC.current());
    check('C 不正値(' + badValues[ci][0] + '): localStorage書換0',
      envC.setItemCallsForKey().length === 0 && envC.stored() === badValues[ci][1], envC.stored());
  }
}

/* ================================================================
   D. setCurrentPropertyId(B) → memory=B / localStorage=B
   ================================================================ */
console.log('\n==== D. setCurrentPropertyId が唯一のsetterとして端末へ保存する ====');
{
  var envD = bootLiveBoard({});
  var ok = envD.win.setCurrentPropertyId(PID_B);
  check('D setCurrentPropertyId(B) が true を返す', ok === true, ok);
  check('D メモリ上の currentPropertyId = B', envD.current() === PID_B, envD.current());
  check('D localStorage(lb_current_property_id) = B', envD.stored() === PID_B, envD.stored());
  check('D 保存に使われたキーは lb_current_property_id のみ',
    envD.calls.setItem.length === 1 && envD.calls.setItem[0].key === STORAGE_KEY, envD.calls.setItem);
}

/* ================================================================
   E. setCurrentPropertyId(不正) → memory維持 / localStorage維持
   ================================================================ */
console.log('\n==== E. 不正値では現在値も保存値も破壊しない ====');
{
  var backingE = Object.create(null);
  backingE[STORAGE_KEY] = PID_A;
  var envE = bootLiveBoard({ backing: backingE });
  var setCallsAfterBoot = envE.setItemCallsForKey().length;
  var badArgs = [null, undefined, '', 'not-a-uuid', 12345, {}, [], PID_A.toUpperCase(),
    'aaaaaaaa-1111-3111-8111-aaaaaaaaaaaa', ' ' + PID_B];
  for (var ei = 0; ei < badArgs.length; ei++) {
    var ret = envE.win.setCurrentPropertyId(badArgs[ei]);
    check('E 不正引数(' + JSON.stringify(badArgs[ei]) + '): false を返す', ret === false, ret);
  }
  check('E メモリ上の currentPropertyId は A のまま', envE.current() === PID_A, envE.current());
  check('E localStorage も A のまま', envE.stored() === PID_A, envE.stored());
  check('E 不正引数では setItem が1回も追加で呼ばれない',
    envE.setItemCallsForKey().length === setCallsAfterBoot, envE.calls.setItem);
}

/* ================================================================
   F. reload相当 → Bが復元される
   ================================================================ */
console.log('\n==== F. reload / ブラウザ再起動後も同じ物件が復元される ====');
{
  var sharedBacking = Object.create(null);   // 端末のlocalStorageに相当（ページを跨いで残る）
  var first = bootLiveBoard({ backing: sharedBacking });
  check('F 1回目の起動は INITIAL_PROPERTY_ID', first.current() === INITIAL_PROPERTY_ID, first.current());
  first.win.setCurrentPropertyId(PID_B);
  check('F 1回目のセッションで B を選択した', first.current() === PID_B, first.current());

  var second = bootLiveBoard({ backing: sharedBacking });   // reload
  check('F reload後も currentPropertyId = B', second.current() === PID_B, second.current());
  var third = bootLiveBoard({ backing: sharedBacking });    // ブラウザ再起動
  check('F ブラウザ再起動後も currentPropertyId = B', third.current() === PID_B, third.current());
  check('F 復元を繰り返しても保存値が変質しない', sharedBacking[STORAGE_KEY] === PID_B, sharedBacking[STORAGE_KEY]);
}

/* ================================================================
   G. PROPERTY.propertyId と矛盾しない
   ------------------------------------------------------------
   index.html の var PROPERTY は window.getCurrentPropertyId() から値を取る。
   復元後の currentPropertyId がそのまま PROPERTY.propertyId になり、
   二重正本にならないことを、実際に評価して確認する。
   ================================================================ */
console.log('\n==== G. PROPERTY.propertyId が復元後の currentPropertyId と一致する ====');
{
  var propertySrc = extractFunctionSource(html, 'formatDateJP') + '\n'
    + 'var _today = new Date(2026, 7, 18);\n'
    + extractObjectVarSource(html, 'PROPERTY');

  var casesG = [
    ['保存あり(A)', PID_A, PID_A],
    ['保存なし', null, INITIAL_PROPERTY_ID],
    ['保存が不正', 'not-a-uuid', INITIAL_PROPERTY_ID],
  ];
  for (var gi = 0; gi < casesG.length; gi++) {
    var backingG = Object.create(null);
    if (casesG[gi][1] !== null) backingG[STORAGE_KEY] = casesG[gi][1];
    var envG = bootLiveBoard({ backing: backingG });
    var ctxG = vm.createContext({ window: envG.win, Date: Date });
    vm.runInContext(propertySrc, ctxG);
    check('G ' + casesG[gi][0] + ': PROPERTY.propertyId === getCurrentPropertyId()',
      ctxG.PROPERTY.propertyId === envG.current(), [ctxG.PROPERTY.propertyId, envG.current()]);
    check('G ' + casesG[gi][0] + ': 期待値どおり',
      ctxG.PROPERTY.propertyId === casesG[gi][2], ctxG.PROPERTY.propertyId);
  }
  check('G PROPERTY.propertyId は新しい正本ではなく getCurrentPropertyId() の派生値のまま',
    html.indexOf('propertyId: (typeof window.getCurrentPropertyId === \'function\') ? window.getCurrentPropertyId() : null,') !== -1);
}

/* ================================================================
   H. scope flag OFF → raw業務キー差分0
   ================================================================ */
console.log('\n==== H. feature flag OFF の業務保存キーが Phase 1E-0 までと同じ ====');
{
  var scopeSrc = [
    extractVarDeclSource(html, 'PROPERTY_SCOPE_ENABLED'),
    extractVarDeclSource(html, 'PROPERTY_SCOPED_KEY_PREFIXES'),
    extractVarDeclSource(html, 'PROPERTY_SCOPED_EXACT_KEYS'),
    extractFunctionSource(html, 'isPropertyScopedKey'),
    extractFunctionSource(html, 'propertyScopedKey'),
    extractFunctionSource(html, 'isValidScopePropertyId'),
    extractFunctionSource(html, 'currentScopePropertyId'),
    extractFunctionSource(html, 'applyPropertyScope'),
  ].join('\n\n');

  var businessKeys = [
    'fireflow-binder:101', 'fireflow-schedule-override:101', 'fireflow-equip:自火報',
    'fireflow-property:current', 'fireflow-documents', 'fireflow-presence:大塚 亮彦',
    'fireflow-ext:1', 'stamp:コスモ六甲ガーデンフォート:101', 'fireflow-stamp:101',
  ];
  var restoreCases = [['保存なし', null], ['保存あり(A)', PID_A], ['保存あり(B)', PID_B]];
  var keyResults = {};
  for (var hi = 0; hi < restoreCases.length; hi++) {
    var backingH = Object.create(null);
    if (restoreCases[hi][1]) backingH[STORAGE_KEY] = restoreCases[hi][1];
    var envH = bootLiveBoard({ backing: backingH });
    var winH = envH.win;
    winH.FIREFLOW_PROPERTY_SCOPE_ENABLED = false;   // 既定OFF
    var ctxH = vm.createContext({ window: winH, console: { warn: function () {} } });
    vm.runInContext(scopeSrc, ctxH);
    check('H ' + restoreCases[hi][0] + ': PROPERTY_SCOPE_ENABLED は false のまま',
      ctxH.PROPERTY_SCOPE_ENABLED === false, ctxH.PROPERTY_SCOPE_ENABLED);
    keyResults[restoreCases[hi][0]] = businessKeys.map(function (k) {
      return ctxH.applyPropertyScope(k).key;
    });
    check('H ' + restoreCases[hi][0] + ': 業務キーが1つもpropertyIdでスコープされない',
      JSON.stringify(keyResults[restoreCases[hi][0]]) === JSON.stringify(businessKeys),
      keyResults[restoreCases[hi][0]]);
    check('H ' + restoreCases[hi][0] + ': lb_current_property_id は property scope の対象外',
      ctxH.isPropertyScopedKey(STORAGE_KEY) === false);
  }
  check('H 復元されたpropertyIdが何であっても flag OFF の保存キーは完全に同一',
    JSON.stringify(keyResults['保存なし']) === JSON.stringify(keyResults['保存あり(A)'])
    && JSON.stringify(keyResults['保存なし']) === JSON.stringify(keyResults['保存あり(B)']));
}

/* ================================================================
   I. propertyId無しoutbox → currentPropertyIdが変わっても送信0
   ------------------------------------------------------------
   Phase 1E-0 の安全化が、起動時復元の導入で1ミリも緩んでいないことを、
   「復元済みの本物の window」を使って確認する。
   ================================================================ */
console.log('\n==== I. Phase 1E-0（propertyId無しoutboxを送らない）を壊していない ====');
var runOutboxChecks;
{
  var outboxSrc = [
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

  function makeOutboxEnv(bootEnv) {
    var idb = { cache: {}, outbox: {} };
    var remoteRows = [];
    var setCalls = [];
    var deleteCalls = [];
    var win = bootEnv.win;   // ← 復元済みの本物の window（getCurrentPropertyId / isValidPropertyId）
    win.FIREFLOW_PROPERTY_SCOPE_ENABLED = false;
    // supabase-integration.js の window.storage と同じ規則:
    // propertyId未指定なら currentPropertyId へ書く（安全側に作るとバグを見逃すため忠実に再現）
    function targetPid(propertyId) { return propertyId || win.getCurrentPropertyId(); }
    win.storage = {
      get: async function () { throw new Error('remote get failed'); },
      set: async function (key, value, shared, propertyId) {
        var pid = targetPid(propertyId);
        setCalls.push({ propertyId: pid, requestedPropertyId: propertyId, key: key });
        remoteRows.push({ property_id: pid, key: key, value: String(value), shared: !!shared });
        return { key: key, value: value, shared: !!shared };
      },
      delete: async function (key, shared, propertyId) {
        var pid = targetPid(propertyId);
        deleteCalls.push({ propertyId: pid, requestedPropertyId: propertyId, key: key });
        return { key: key, deleted: true, shared: !!shared };
      },
      list: async function (prefix, shared) { return { keys: [], prefix: prefix, shared: !!shared }; },
    };
    var ctx = {
      window: win,
      navigator: { onLine: true },
      document: { addEventListener: function () {} },
      console: { log: function () {}, warn: function () {}, error: function () {} },
      setInterval: function () { return 1; }, clearInterval: function () {},
      setTimeout: function () { return 1; }, clearTimeout: function () {},
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
    vm.runInContext(outboxSrc, ctx);
    return {
      ctx: ctx, idb: idb, setCalls: setCalls, deleteCalls: deleteCalls,
      remoteRows: function () { return remoteRows; },
      outboxItems: function () { return Object.keys(idb.outbox).map(function (k) { return idb.outbox[k]; }); },
    };
  }

  // 実端末に実在する propertyId無し旧outbox（Phase 1D dry-runで確認された3件）
  var legacyKeys = ['fireflow-binder:807', 'fireflow-binder:811', 'fireflow-presence:大塚 亮彦'];
  var restoredCases = [['保存なし(INITIAL)', null], ['復元A', PID_A], ['復元B', PID_B]];
  runOutboxChecks = async function () {
    for (var ii = 0; ii < restoredCases.length; ii++) {
      var backingI = Object.create(null);
      if (restoredCases[ii][1]) backingI[STORAGE_KEY] = restoredCases[ii][1];
      var bootEnv = bootLiveBoard({ backing: backingI });
      var env = makeOutboxEnv(bootEnv);
      for (var li = 0; li < legacyKeys.length; li++) {
        env.idb.outbox['shared:' + legacyKeys[li]] = {
          key: 'shared:' + legacyKeys[li], rawKey: legacyKeys[li],
          value: '旧データ', shared: true, deleted: false, updatedAt: 1,
        };
      }
      var before = JSON.stringify(env.idb.outbox);
      await env.ctx.flushOutbox();
      await env.ctx.flushOutbox();
      var lbl = 'I ' + restoredCases[ii][0] + '(currentPropertyId=' + bootEnv.current().slice(0, 8) + ')';
      check(lbl + ': propertyId無しoutboxの送信0',
        env.setCalls.length === 0 && env.deleteCalls.length === 0 && env.remoteRows().length === 0,
        env.setCalls);
      check(lbl + ': 削除0（3件すべて残る）', env.outboxItems().length === 3, env.outboxItems().length);
      check(lbl + ': 書換0（propertyIdが1件も生えていない）',
        JSON.stringify(env.idb.outbox) === before);
    }

    // propertyIdを確定保持しているitemは、復元後の物件が何であっても item.propertyId へ送られる
    var backingI2 = Object.create(null);
    backingI2[STORAGE_KEY] = PID_A;
    var bootEnv2 = bootLiveBoard({ backing: backingI2 });
    var env2 = makeOutboxEnv(bootEnv2);
    env2.idb.outbox['shared:fireflow-binder:101'] = {
      key: 'shared:fireflow-binder:101', rawKey: 'fireflow-binder:101',
      value: '点検済み', shared: true, deleted: false, updatedAt: 1,
      propertyId: PID_B, alreadyScoped: true,
    };
    await env2.ctx.flushOutbox();
    check('I 復元がA でも item.propertyId=B のitemは B へ送られる（復元値をfallbackにしない）',
      env2.setCalls.length === 1 && env2.setCalls[0].propertyId === PID_B
      && env2.setCalls[0].requestedPropertyId === PID_B, env2.setCalls);
  };
}

/* ================================================================
   J / K. localStorage障害でも Live Board は起動する
   ================================================================ */
function runStorageFailureChecks() {
console.log('\n==== J/K. localStorageが使えない端末でも起動を止めない ====');
{
  var failCases = [
    ['J setItem が例外を投げる（容量超過等）', { setItemThrows: true }],
    ['K getItem が例外を投げる（Safariプライベートモード等）', { getItemThrows: true }],
    ['J/K localStorage自体が存在しない', { noLocalStorage: true }],
    ['J/K getItem/setItem の両方が例外', { getItemThrows: true, setItemThrows: true }],
  ];
  for (var fi = 0; fi < failCases.length; fi++) {
    var envF = bootLiveBoard(failCases[fi][1]);
    check(failCases[fi][0] + ': Live Board の起動が継続する（例外で止まらない）',
      envF.booted(), envF.thrown && String(envF.thrown));
    check(failCases[fi][0] + ': currentPropertyId は INITIAL_PROPERTY_ID を維持（別物件へフォールバックしない）',
      envF.current() === INITIAL_PROPERTY_ID, envF.current());
  }
}
{
  // setItem が失敗しても、メモリ上の currentPropertyId は setter の結果を維持する
  var envJ = bootLiveBoard({ setItemThrows: true });
  var retJ = envJ.win.setCurrentPropertyId(PID_B);
  check('J setItem失敗時も setCurrentPropertyId は true（メモリ上の切替は成立している）', retJ === true, retJ);
  check('J setItem失敗時もメモリ上の currentPropertyId = B', envJ.current() === PID_B, envJ.current());
  check('J setItem失敗を無限に再試行しない（呼び出しは1回だけ）',
    envJ.setItemCallsForKey().length === 1, envJ.setItemCallsForKey().length);
  // 何度呼んでも例外は外へ出ない
  var threwJ = false;
  try { envJ.win.setCurrentPropertyId(PID_A); } catch (e) { threwJ = true; }
  check('J setItem失敗が呼び出し側へ例外として伝播しない', threwJ === false);
  check('J 2回目の切替もメモリ上は成立する', envJ.current() === PID_A, envJ.current());
}
{
  // getItem が失敗しても、その後の setCurrentPropertyId / 保存は普通に動く
  var envK = bootLiveBoard({ getItemThrows: true });
  envK.win.setCurrentPropertyId(PID_A);
  check('K getItem失敗後でも setCurrentPropertyId は動作する', envK.current() === PID_A, envK.current());
  check('K getItem失敗後でも保存自体は行われる', envK.stored() === PID_A, envK.stored());
}
}

/* ================================================================
   L. ソース監査（復元タイミング / 単一setter / 今回の非スコープ）
   ================================================================ */
function runSourceAudits() {
  console.log('\n==== L. 復元タイミング: currentPropertyId は FIRST_USE より前に確定する ====');
  {
    var code = stripComments(sbjs);
    var restoreIdx = code.indexOf('setCurrentPropertyId(saved)');
    check('L 起動時復元の呼び出しが存在する', restoreIdx !== -1);

    // supabase-integration.js 内で currentPropertyId を実際に使う最初の場所より前であること
    var firstUses = [
      ['initSupabaseIntegration の定義', 'function initSupabaseIntegration('],
      ['ensureInspectionSession の既存セッション検索', "sb.from('inspections').select('id').eq('property_id', currentPropertyId)"],
      ['storage.get(kv_store)', "sb.from('kv_store').select('value').eq('property_id', currentPropertyId)"],
      ['storage.set(kv_store)', "sb.from('kv_store').select('id').eq('property_id', currentPropertyId)"],
      ['storage.delete(kv_store)', "sb.from('kv_store').delete().eq('property_id', currentPropertyId)"],
      ['storage.list(kv_store)', "sb.from('kv_store').select('key').eq('property_id', currentPropertyId)"],
      ['Realtime購読フィルタ', "'property_id=eq.' + currentPropertyId"],
      ['写真の保存パス', "var path = currentPropertyId + '/'"],
      ['getMyPropertyRole(権限)', ".select('role').eq('property_id', currentPropertyId)"],
      ['createPropertyInvite(招待)', 'property_id: currentPropertyId,'],
    ];
    firstUses.forEach(function (pair) {
      var useIdx = code.indexOf(pair[1]);
      check('L 復元は ' + pair[0] + ' より前にある', useIdx !== -1 && restoreIdx < useIdx, [restoreIdx, useIdx]);
    });

    // 復元が「同期スクリプト評価中」に完了していることの実挙動での裏付けは A/F で検査済み
    // （このテストの vm 上では script.onload も DOMContentLoaded も一度も発火しないのに、
    //   A/F では復元後の値が読めている）。ここではソース上でも、復元が非同期コールバックの
    //   中に置かれていないことを確認する。
    check('L 復元は script.onload のコールバック内に置かれていない',
      code.indexOf('script.onload') !== -1
      && code.indexOf('setCurrentPropertyId(saved)', code.indexOf('script.onload')) !== -1
      && code.indexOf('runWhenBodyReady(function') === -1);
    check('L 復元は initSupabaseIntegration（ログイン後の処理）の中ではない',
      restoreIdx < code.indexOf('function initSupabaseIntegration('));

    // index.html 側の読み込み順（PROPERTY.propertyId の初期化より前）
    var tagIdx = html.indexOf('<script src="supabase-integration.js"></script>');
    check('L supabase-integration.js が defer/async なしの同期スクリプトである', tagIdx !== -1);
    check('L supabase-integration.js の読み込みが var PROPERTY より前',
      tagIdx !== -1 && tagIdx < html.indexOf('var PROPERTY = {'));
    check('L supabase-integration.js の読み込みが storageSet の定義より前',
      tagIdx !== -1 && tagIdx < html.indexOf('async function storageSet('));
    check('L supabase-integration.js の読み込みが flushOutbox の定義より前',
      tagIdx !== -1 && tagIdx < html.indexOf('async function flushOutbox('));
  }

  console.log('\n==== L. 単一setter / 保存キー / 今回の非スコープ ====');
  {
    var code2 = stripComments(sbjs);
    check('L 保存キーは lb_current_property_id（定義は1箇所だけ）',
      countOccurrences(code2, "'" + STORAGE_KEY + "'") === 1, countOccurrences(code2, "'" + STORAGE_KEY + "'"));
    check('L 保存先は localStorage（IndexedDB / kv_store へは保存しない）',
      code2.indexOf('window.localStorage.setItem(CURRENT_PROPERTY_STORAGE_KEY') !== -1);
    check('L currentPropertyId への代入は「宣言時」と「setter内」の2箇所だけ',
      (code2.match(/currentPropertyId\s*=[^=]/g) || []).length === 2,
      (code2.match(/currentPropertyId\s*=[^=]/g) || []));
    check('L setter の定義は1つだけ',
      countOccurrences(code2, 'function setCurrentPropertyId(') === 1);
    check('L setter は isValidPropertyId を通った値しか受け付けない',
      /function setCurrentPropertyId\(propertyId\)\s*\{\s*if \(!isValidPropertyId\(propertyId\)\) return false;/.test(code2));
    check('L 保存は setter の検証を通過した後にだけ行われる',
      /if \(!isValidPropertyId\(propertyId\)\) return false;\s*currentPropertyId = propertyId;\s*persistPropertyId\(propertyId\);/.test(code2));
    check('L localStorage の読み書きは try/catch で保護されている',
      /function readPersistedPropertyId\(\)\s*\{\s*try \{/.test(code2)
      && /function persistPropertyId\(propertyId\)\s*\{\s*try \{/.test(code2));
    check('L 復元は「有効なUUIDのとき」だけ setter を通す',
      /var saved = readPersistedPropertyId\(\);\s*if \(!isValidPropertyId\(saved\)\) return;\s*setCurrentPropertyId\(saved\);/.test(code2));
    check('L INITIAL_PROPERTY_ID は宣言時の初期値としてだけ使われ、復元失敗時の再代入に使われない',
      /var\s+currentPropertyId\s*=\s*INITIAL_PROPERTY_ID\s*;/.test(code2)
      && countOccurrences(code2, 'INITIAL_PROPERTY_ID') === 2, // const宣言1 + 初期値1
      countOccurrences(code2, 'INITIAL_PROPERTY_ID'));
    check('L 復元で removeItem / clear を呼ばない（端末の他の設定を消さない）',
      code2.indexOf('removeItem') === -1 && code2.indexOf('localStorage.clear') === -1);
  }

  console.log('\n==== L. Phase 1E-A2以降を実装していない ====');
  {
    check('L index.html から setCurrentPropertyId を呼んでいない（物件切替UIはA2以降）',
      html.indexOf('setCurrentPropertyId(') === -1);
    // 既存の #switchPropertyBtn は Phase 1E以前からある「新規物件を作成」フォームを開く
    // だけのボタンで、propertyId には一切触れない（物件名ベースの起動ゲート）。
    // Phase 1E-A2 で入れる propertyId ベースの switchProperty() はまだ無いこと。
    check('L propertyIdベースの switchProperty() は未実装（A2以降）',
      html.indexOf('switchProperty(') === -1 && sbjs.indexOf('switchProperty') === -1);
    check('L 既存の #switchPropertyBtn は propertyId を切り替えない（新規物件フォームを開くだけ）',
      /getElementById\('switchPropertyBtn'\)\.addEventListener\('click', function\(\) \{\s*document\.getElementById\('settingsMenuPopup'\)\.style\.display = 'none';\s*openPropertyFormDialog\('create'\);\s*\}\);/.test(html));
    check('L listMyProperties / createProperty はUI未接続のまま',
      html.indexOf('listMyProperties(') === -1 && html.indexOf('createProperty(') === -1);
    check('L index.html は lb_current_property_id を知らない（保存の正本は1箇所だけ）',
      html.indexOf(STORAGE_KEY) === -1);
    check('L feature flag は既定OFFのまま',
      html.indexOf("var PROPERTY_SCOPE_ENABLED = (typeof window !== 'undefined' && window.FIREFLOW_PROPERTY_SCOPE_ENABLED === true);") !== -1);

    var stampStoreSrc = fs.readFileSync(path.join(__dirname, '..', 'stamp_store', 'stamp_store.js'), 'utf8');
    check('L stamp_store.js は propertyId を一切知らないまま（StampStore差分0）',
      stampStoreSrc.indexOf('propertyId') === -1 && stampStoreSrc.indexOf('getCurrentPropertyId') === -1
      && stampStoreSrc.indexOf(STORAGE_KEY) === -1);

    var migrationSrc = fs.readFileSync(path.join(__dirname, '..', 'property_scope_migration.js'), 'utf8');
    check('L migration は Phase 1E-A1 と無関係のまま（lb_current_property_id を参照しない）',
      migrationSrc.indexOf(STORAGE_KEY) === -1);
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
  console.log('==== phase1e_a1_current_property_persist_verify (currentPropertyId永続化・起動時復元) 総合結果: PASS ('
    + results.length + '/' + results.length + ') ====');
}

/* ================================================================
   実行順（A〜Hは読み込み時に同期実行済み）
   ================================================================ */
(async function () {
  await runOutboxChecks();
  runStorageFailureChecks();
  runSourceAudits();
})().catch(function (err) {
  console.error('テスト実行中に例外が発生しました:', err);
  process.exit(1);
});
