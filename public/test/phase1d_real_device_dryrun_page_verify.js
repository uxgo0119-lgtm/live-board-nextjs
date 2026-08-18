// [2026-08-18新設 Phase 1D] 実端末 dry-run 画面 (phase1d_real_device_dryrun.html) の静的検証。
//
// この画面は「このMacの実データを読むだけ」の画面である。実データに触る画面なので、
// 「気をつけて書いた」ではなく「書き込む手段をコード上に持たない」ことを機械確認する。
//
// このテストが守るのは次の5点だけ。
//   1. 画面のコードに書き込み・削除・送信のAPI呼び出しが存在しないこと
//   2. IndexedDBを 'readonly' 以外で開く経路が存在しないこと
//   3. 存在しないDBを新規作成しないこと(indexedDB.databases()で先に存在確認する／
//      open()にversionを渡さない)
//   4. 判定は既存の純粋関数 planPropertyScopeMigration() をそのまま呼ぶだけで、
//      画面側に新しいmigrationロジック・本migration実行機能が無いこと
//   5. 参照するDB名が製品(index.html)と一致すること
'use strict';
var fs = require('fs');
var path = require('path');

var results = [];
function check(label, cond, detail) {
  results.push({ label: label, ok: !!cond });
  console.log((cond ? 'OK' : 'NG') + ': ' + label + (detail !== undefined ? ' (' + JSON.stringify(detail) + ')' : ''));
}

var PAGE_PATH = path.join(__dirname, 'phase1d_real_device_dryrun.html');
var page = fs.readFileSync(PAGE_PATH, 'utf8');
var html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

/* 画面内のインラインscriptだけを取り出し、コメント(HTML/ブロック/行頭行コメント)を除去する。
   説明文に反応して誤検知しないようにするため。 */
var scriptBodies = [];
page.replace(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g, function (_, body) {
  scriptBodies.push(body); return '';
});
check('インラインscriptが1つだけ存在する', scriptBodies.length === 1, scriptBodies.length);
var code = scriptBodies.join('\n')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '');

/* ================================================================
   1. 書き込み・削除・送信の呼び出しが存在しない
   ---------------------------------------------------------------
   毒入り差し替え(= 左辺への代入)は許すが、「呼び出し」は1件も許さない。
   代入行を先に落としてから検査する。
   ================================================================ */
console.log('\n==== 1. 書き込みAPIの呼び出しが存在しない ====');
// 'X.y = function' 形式の毒入り差し替え行を除去（代入は封じる側なので検査対象外）
var callsOnly = code
  .replace(/^\s*(?:indexedDB\.deleteDatabase|window\.fetch|navigator\.sendBeacon)\s*=\s*function[\s\S]*?;\s*$/gm, '')
  .replace(/^\s*(?:Storage|IDBObjectStore|IDBDatabase|XMLHttpRequest)\.prototype\[?[a-zA-Z'"]*\]?(?:\.[a-zA-Z]+)?\s*=\s*function[\s\S]*?;\s*$/gm, '')
  .replace(/IDBObjectStore\.prototype\[m\]\s*=\s*function\s*\(\)\s*\{[^}]*\};?/g, '');

var FORBIDDEN_CALLS = [
  "'readwrite'", '"readwrite"',   // readwriteトランザクションを開く経路そのもの
  '.deleteDatabase(', '.setItem(', '.removeItem(', '.localStorage.clear(',
  'storageSet(', 'storageDelete(', 'storageList(', 'lcPut(', 'lcDelete(',
  '.upsert(', '.insert(', '.update(',
  'fetch(', 'XMLHttpRequest(', 'sendBeacon(',
  'executePropertyScopeMigration', 'applyMigration',
];
FORBIDDEN_CALLS.forEach(function (f) {
  check('画面のコードに ' + f + ' の呼び出しが存在しない', callsOnly.indexOf(f) === -1, f);
});
check('画面のコードに .put( / .add( / .clear( の呼び出しが存在しない',
  callsOnly.indexOf('.put(') === -1 && callsOnly.indexOf('.add(') === -1 && callsOnly.indexOf('.clear(') === -1);
// objectStore().delete() 形式の削除が無いこと（DOM の removeChild 等と混同しないよう限定して見る）
check('objectStore経由の delete( 呼び出しが存在しない',
  !/objectStore\([^)]*\)\s*\.\s*delete\s*\(/.test(callsOnly));

/* ================================================================
   2. readonly以外でトランザクションを開けない
   ================================================================ */
console.log('\n==== 2. readonly固定 ====');
check('IDBDatabase.prototype.transaction を差し替えている',
  code.indexOf('IDBDatabase.prototype.transaction = function') !== -1);
check('差し替えたtransactionが常に readonly を渡す',
  /origTransaction\.call\(this,\s*stores,\s*'readonly'\)/.test(code));
check('readonly以外を要求されたら例外にする',
  /mode\s*!==\s*'readonly'\)\s*record\(/.test(code));
check('db.transaction の呼び出しはすべて readonly 指定',
  (code.match(/\.transaction\(/g) || []).length ===
  (code.match(/\.transaction\([^)]*'readonly'\)/g) || []).length,
  { all: (code.match(/\.transaction\(/g) || []).length,
    readonly: (code.match(/\.transaction\([^)]*'readonly'\)/g) || []).length });
check('IDBObjectStore の put/add を毒入りへ差し替えている',
  /\['put',\s*'add'\]\.forEach/.test(code));
check('IDBObjectStore の delete/clear を毒入りへ差し替えている',
  /\['delete',\s*'clear'\]\.forEach/.test(code));
check('localStorage への書き込み・削除を毒入りへ差し替えている',
  code.indexOf('Storage.prototype.setItem = function') !== -1 &&
  code.indexOf('Storage.prototype.removeItem = function') !== -1);
check('ネットワーク送信(fetch/XHR/sendBeacon)を毒入りへ差し替えている',
  code.indexOf('window.fetch = function') !== -1 &&
  code.indexOf('XMLHttpRequest.prototype.open = function') !== -1 &&
  code.indexOf('navigator.sendBeacon = function') !== -1);

/* ================================================================
   3. 存在しないDBを新規作成しない
   ---------------------------------------------------------------
   indexedDB.open() は存在しないDBを作る＝書き込みになる。先に databases() で
   存在を確認し、open() には version を渡さない(upgradeさせない)。
   ================================================================ */
console.log('\n==== 3. DBを新規作成しない ====');
check('indexedDB.databases() で先に存在確認している', code.indexOf('indexedDB.databases()') !== -1);
check('databases() 非対応環境では open せずに中止する',
  /if\s*\(!indexedDB\.databases\)\s*return Promise\.resolve\(null\)/.test(code));
check('DBが見つからない場合は open しない（found判定でreturn）',
  /report\.dbFound = found;/.test(code) && /if\s*\(!found\)/.test(code));
check('indexedDB.open() に version を渡していない（upgradeさせない）',
  /indexedDB\.open\(name\)/.test(code) && !/indexedDB\.open\([^)]*,\s*\d/.test(code));
check('onupgradeneeded が発火したら中断する（DBを作って残さない）',
  /onupgradeneeded[\s\S]{0,220}transaction\.abort\(\)/.test(code));

/* ================================================================
   4. 新しいmigrationロジックを画面側に持たない
   ================================================================ */
console.log('\n==== 4. 判定は既存の純粋関数のみ ====');
check('既存の planPropertyScopeMigration() を呼んでいる',
  code.indexOf('M.planPropertyScopeMigration({') !== -1);
check('外部scriptの読み込みは property_scope_migration.js の1本だけ',
  (page.match(/<script[^>]*\bsrc=/g) || []).length === 1 &&
  page.indexOf('src="../property_scope_migration.js"') !== -1);
check('supabase-integration.js を読み込んでいない',
  page.indexOf('supabase-integration.js') === -1);
check('currentPropertyId を移行根拠として渡していない（D_WEAK単独禁止）',
  /currentPropertyId:\s*null/.test(code));
check('status/evidence の語彙を画面側で再定義していない',
  code.indexOf('var STATUS =') === -1 && code.indexOf('var EVIDENCE =') === -1);

/* ================================================================
   5. 製品コードとの一致
   ================================================================ */
console.log('\n==== 5. 製品コードとの一致 ====');
var pageDbName = (code.match(/var LC_DB_NAME = '([^']+)'/) || [])[1];
var prodDbName = (html.match(/var LC_DB_NAME = '([^']+)'/) || [])[1];
check('参照するIndexedDB名が製品(index.html)と一致する',
  !!pageDbName && pageDbName === prodDbName, { page: pageDbName, product: prodDbName });
check('読み取るobjectStoreが製品と同じ cache / outbox である',
  code.indexOf("getAll(db, 'cache')") !== -1 && code.indexOf("getAll(db, 'outbox')") !== -1);
check('dry-run前後でIndexedDBを読み直して指紋比較している',
  code.indexOf('fpCacheBefore') !== -1 && code.indexOf('io.unchanged') !== -1);
check('前後不一致なら DRYRUN_UNVERIFIED へ倒す',
  /REAL_DEVICE_DRYRUN_UNVERIFIED/.test(code) && /if\s*\(!writeOk\)/.test(code));
check('D_WEAK/E_UNKNOWN のみのMIGRATABLEを検出したら UNVERIFIED へ倒す',
  /weakMigratable\.length\s*>\s*0/.test(code));
check('最良でも MIGRATION_EXECUTION_CONDITIONAL_GO 止まり（無条件GOを出さない）',
  code.indexOf('MIGRATION_EXECUTION_CONDITIONAL_GO') !== -1 &&
  code.indexOf("'MIGRATION_EXECUTION_GO'") === -1);

/* ================================================================
   6. 画面ロジックを実際に走らせる（ユーザーの1回の手作業を失敗させないため）
   ---------------------------------------------------------------
   ユーザーがこの画面を開くのは1回きりで、そこで例外が出たら実端末dry-runは
   丸ごとやり直しになる。静的検査だけでは描画時の実行時エラーを捕まえられないため、
   最小限のDOM/IndexedDBスタブ上で画面のスクリプトをそのまま実行し、
   ・例外なく最後まで描画できること
   ・WRITE/DELETE=0 と前後一致を自力で申告すること
   ・件数が既存の純粋関数の結論と一致すること（画面が数え間違えていないこと）
   を確認する。スタブは書き込みAPIを毒入りにしてあるので、画面が書こうとしたら落ちる。
   ================================================================ */
function runPageInStubs() {
  var M = require('../property_scope_migration.js');
  var PID = M.LEGACY_FIXED_PROPERTY_ID;
  function J(o) { return JSON.stringify(o); }
  function entry(k, v) { return { key: k, value: v, updatedAt: 1755000000000 }; }
  var currentRecord = J({
    property: { name: 'テスト物件', propertyId: PID },
    floors: [{ name: '1F', rooms: ['101', '102', '103'] }],
    equipmentList: ['自火報'], extinguisherData: [{ no: '1' }],
  });
  var cache = [
    entry('shared:fireflow-property:current', currentRecord),
    entry('shared:fireflow-binder:101', J({ status: 'done' })),
    entry('shared:fireflow-equip:自火報', J({ result: 'ok' })),
    entry('shared:fireflow-ext:1', J({ result: 'ok' })),
    entry('shared:fireflow-property:buildingNotes', J({ note: 'x' })),
    entry('shared:fireflow-documents', J([{ name: 'a.pdf' }])),
    entry('shared:fireflow-binder:103', J({ status: 'done' })),
    entry('shared:fireflow-binder:' + PID + ':103', J({ status: 'cancelled' })), // COLLISION
    entry('shared:fireflow-property:progressLog', '{壊れたJSON'),                // INVALID
    entry('own:lb_kantan_mode', '1'),
    entry('shared:stamp:テスト物件:101', J({ mark: 'A' })),
  ];
  var outbox = [
    { key: 'shared:fireflow-binder:' + PID + ':104', rawKey: 'fireflow-binder:' + PID + ':104',
      value: J({ status: 'done' }), shared: true, deleted: false, propertyId: PID, alreadyScoped: true },
    { key: 'shared:fireflow-binder:105', rawKey: 'fireflow-binder:105', value: J({ status: 'done' }), shared: true },
  ];
  var snapshotBefore = J([cache, outbox]);
  var expected = M.planPropertyScopeMigration({ cacheEntries: cache, outboxEntries: outbox, currentPropertyId: null });

  // ---- 最小スタブ（書き込みAPIは毒入り。画面が書こうとしたら例外で落ちる） ----
  var stubWrites = 0;
  function poison() { stubWrites++; throw new Error('STUB: 画面が書き込みを試みた'); }
  global.IDBObjectStore = function () {};
  IDBObjectStore.prototype.getAll = function () {
    var self = this, req = {};
    setTimeout(function () { req.result = self.__rows.slice(); if (req.onsuccess) req.onsuccess(); }, 0);
    return req;
  };
  ['put', 'add', 'delete', 'clear'].forEach(function (m) { IDBObjectStore.prototype[m] = poison; });
  var stores = { cache: cache, outbox: outbox };
  global.IDBDatabase = function () {};
  IDBDatabase.prototype.transaction = function (name, mode) {
    if (mode !== 'readonly') poison();
    return { objectStore: function (n) {
      var s = Object.create(IDBObjectStore.prototype); s.__rows = stores[n] || []; return s;
    } };
  };
  global.Storage = function () {};
  Storage.prototype.setItem = poison; Storage.prototype.removeItem = poison; Storage.prototype.clear = poison;
  global.XMLHttpRequest = function () {}; XMLHttpRequest.prototype.open = poison;
  global.indexedDB = {
    databases: function () { return Promise.resolve([{ name: 'fireflow-lb-cache', version: 1 }]); },
    open: function (name) {
      var req = {};
      setTimeout(function () {
        var db = Object.create(IDBDatabase.prototype);
        db.version = 1;
        db.objectStoreNames = { 0: 'cache', 1: 'outbox', length: 2,
          contains: function (n) { return n === 'cache' || n === 'outbox'; } };
        req.result = db;
        if (req.onsuccess) req.onsuccess({ target: req });
      }, 0);
      return req;
    },
    deleteDatabase: poison,
  };
  // Node 24 の navigator / URL / Blob はgetter専用なので defineProperty で差し替える
  function defineGlobal(name, value) {
    Object.defineProperty(global, name, { value: value, writable: true, configurable: true });
  }
  defineGlobal('navigator', { userAgent: 'node-stub', sendBeacon: function () {} });
  defineGlobal('location', { origin: 'http://localhost:3000', href: 'http://localhost:3000/test/x.html' });
  defineGlobal('Blob', function () {});
  defineGlobal('URL', { createObjectURL: function () { return ''; } });
  var els = {};
  function makeEl() { return { className: '', textContent: '', innerHTML: '', addEventListener: function () {}, href: '', download: '', click: function () {} }; }
  ['verdict', 'out', 'json', 'copyBtn', 'dlBtn'].forEach(function (id) { els[id] = makeEl(); });
  global.document = {
    getElementById: function (id) { return els[id] || null; },
    createElement: function () { return makeEl(); },
  };
  global.window = global;
  global.FireFlowPropertyScopeMigration = M;

  // 画面のインラインscriptをそのまま実行する
  // eslint-disable-next-line no-new-func
  new Function(scriptBodies[0])();

  return new Promise(function (resolve) {
    var tries = 0;
    (function wait() {
      if (global.__phase1dReport || tries++ > 200) { resolve({ report: global.__phase1dReport, els: els, expected: expected, snapshotBefore: snapshotBefore, cache: cache, outbox: outbox, stubWrites: stubWrites }); return; }
      setTimeout(wait, 5);
    })();
  });
}

runPageInStubs().then(function (r) {
  console.log('\n==== 6. 画面ロジックの実行検証（スタブ上） ====');
  var rep = r.report;
  check('画面が例外なく最後まで実行され、レポートを生成する', !!rep, rep ? rep.verdict : 'なし');
  if (rep) {
    check('画面が実データを読めたと申告する（realDeviceData=true）', rep.realDeviceData === true);
    check('画面のWRITE COUNT = 0', rep.writeCount === 0, rep.writeCount);
    check('画面のDELETE COUNT = 0', rep.deleteCount === 0, rep.deleteCount);
    check('画面のネットワーク送信 = 0', rep.networkCount === 0, rep.networkCount);
    check('スタブ側でも書き込み試行を1件も検出しない', r.stubWrites === 0, r.stubWrites);
    check('dry-run前後でデータが変わっていないと判定する', rep.io.unchanged === true, rep.io);
    check('入力データ自体がdry-run前後で完全一致', JSON.stringify([r.cache, r.outbox]) === r.snapshotBefore);
    check('status別件数が既存の純粋関数の結論と一致する',
      JSON.stringify(rep.statusCounts) === JSON.stringify(r.expected.summary), rep.statusCounts);
    check('outbox status別件数が既存の純粋関数の結論と一致する',
      JSON.stringify(rep.outboxStatusCounts) === JSON.stringify(r.expected.outboxSummary), rep.outboxStatusCounts);
    check('contamination判定が既存の純粋関数と一致する',
      rep.contamination.detected === r.expected.contamination.detected, rep.contamination.detected);
    check('COLLISIONがある入力では AMBIGUOUS 判定になる',
      rep.verdict === 'REAL_DEVICE_DRYRUN_AMBIGUOUS', rep.verdict);
    check('COLLISIONがある入力では本migrationを STOP と判定する',
      rep.migrationDecision === 'STOP', rep.migrationDecision);
    check('D_WEAK/E_UNKNOWN のみのMIGRATABLEが0件', rep.weakEvidenceMigratableCount === 0);
    check('StampStoreは件数確認のみで移行対象に入らない',
      rep.stampStore.count === 1 && rep.migratable.every(function (i) { return String(i.legacyKey).indexOf('stamp') !== 0; }),
      rep.stampStore);
    check('outboxの全itemが未変更(mutated=false)',
      rep.outbox.every(function (o) { return o.mutated === false; }));
    check('画面が結果を描画している（空でない）',
      r.els.out.innerHTML.length > 500 && r.els.verdict.textContent.indexOf('REAL_DEVICE_DRYRUN') === 0,
      r.els.verdict.textContent);
    check('レポートに実データの値そのものを含めない（キーと分類のみ）',
      JSON.stringify(rep).indexOf('壊れたJSON') === -1 && JSON.stringify(rep).indexOf('a.pdf') === -1);
  }

  /* ================================================================
     総合結果
     ================================================================ */
  var passed = results.filter(function (x) { return x.ok; }).length;
  var total = results.length;
  console.log('\n==== phase1d_real_device_dryrun_page_verify 総合結果: '
    + (passed === total ? 'PASS' : 'FAIL') + ' (' + passed + '/' + total + ') ====');
  if (passed !== total) {
    results.filter(function (x) { return !x.ok; }).forEach(function (x) { console.log('  NG: ' + x.label); });
    process.exit(1);
  }
}).catch(function (err) {
  console.log('NG: 画面ロジックの実行検証で例外: ' + (err && err.stack || err));
  process.exit(1);
});
