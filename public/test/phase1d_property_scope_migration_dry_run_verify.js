// [2026-08-18新設 Phase 1D] 旧保存データ → propertyId scope migration の dry-run 検証。
//
// このテストが守るのは次の4点だけ。
//   1. dry-runが完全read-onlyであること(WRITE COUNT = 0 / DELETE COUNT = 0、
//      実行前後でIndexedDB相当のスナップショット・outbox・stateが完全一致)
//   2. 根拠の弱いデータを移行しないこと(UNKNOWN_PROPERTY / AMBIGUOUS を正常結果として保持)
//   3. 既存の新スコープデータを絶対に上書きしないこと(COLLISION)
//   4. 同じmigrationを2回計画しても重複・上書き・削除事故が起きないこと(idempotent)
//
// FireFlowの原則: 「移行できないデータを残す」ことは許容する。
//                「間違った物件へ移行する」ことは禁止。
// したがって「何件移行できたか」ではなく「間違って移行していないか」を検証する。
'use strict';
var fs = require('fs');
var path = require('path');

var M = require('../property_scope_migration.js');

var results = [];
function check(label, cond, detail) {
  results.push({ label: label, ok: !!cond });
  console.log((cond ? 'OK' : 'NG') + ': ' + label + (detail !== undefined ? ' (' + JSON.stringify(detail) + ')' : ''));
}

var PID_MAIN = 'b6e18eed-f2f3-4674-812d-322732908616'; // Phase 1A以前からの固定物件UUID
var PID_OTHER = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';

function J(o) { return JSON.stringify(o); }
function entry(cacheKey, value) { return { key: cacheKey, value: value, updatedAt: 1755000000000 }; }
function findItem(plan, legacyKey) {
  for (var i = 0; i < plan.items.length; i++) {
    if (plan.items[i].legacyKey === legacyKey && plan.items[i].status !== undefined) {
      if (plan.items[i].cacheKey && String(plan.items[i].cacheKey).indexOf(legacyKey) !== -1) return plan.items[i];
    }
  }
  for (var k = 0; k < plan.items.length; k++) if (plan.items[k].legacyKey === legacyKey) return plan.items[k];
  return null;
}

function currentRecordJson(propertyId, rooms, equipment, extNos) {
  var rec = {
    property: { name: 'コスモ六甲ガーデンフォート', inspectionDate: '2026-08-18' },
    floors: [{ name: '1F', rooms: rooms || [] }],
    sensorMaster: {},
    extinguisherData: (extNos || []).map(function (n) { return { no: n }; }),
    equipmentList: equipment || [],
    savedAt: '2026-08-18T00:00:00.000Z',
  };
  if (propertyId !== null) rec.property.propertyId = propertyId;
  return J(rec);
}

/* ================================================================
   0. 製品コード(index.html)との定義一致
   ---------------------------------------------------------------
   migration側の「どのキーが業務データか」「スコープ済みキーの形」が製品と
   食い違うと、dry-runの結論そのものが実挙動とずれる。文字列で機械比較する。
   ================================================================ */
console.log('\n==== 0. 製品コードとの定義一致 ====');
var html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function extractVarDeclSource(name) {
  var marker = 'var ' + name + ' = ';
  var startIdx = html.indexOf(marker);
  if (startIdx === -1) throw new Error('MISSING IMPLEMENTATION SOURCE: var ' + name);
  var semiIdx = html.indexOf(';', startIdx);
  return html.slice(startIdx, semiIdx + 1);
}
function extractFunctionSource(name) {
  var marker = 'function ' + name + '(';
  var startIdx = html.indexOf(marker);
  if (startIdx === -1) throw new Error('MISSING IMPLEMENTATION SOURCE: function ' + name);
  var braceStart = html.indexOf('{', startIdx);
  var depth = 0, i = braceStart;
  for (; i < html.length; i++) {
    var ch = html[i];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return html.slice(startIdx, i);
}

var sandbox = {};
// eslint-disable-next-line no-new-func
new Function('exports',
  extractVarDeclSource('PROPERTY_SCOPED_KEY_PREFIXES') +
  extractVarDeclSource('PROPERTY_SCOPED_EXACT_KEYS') +
  extractFunctionSource('propertyScopedKey') +
  extractFunctionSource('lcCacheKey') +
  'exports.prefixes = PROPERTY_SCOPED_KEY_PREFIXES;' +
  'exports.exact = PROPERTY_SCOPED_EXACT_KEYS;' +
  'exports.propertyScopedKey = propertyScopedKey;' +
  'exports.lcCacheKey = lcCacheKey;'
)(sandbox);

check('スコープ対象の接頭辞一覧が製品(index.html)と完全一致する',
  J(sandbox.prefixes) === J(M.PROPERTY_SCOPED_KEY_PREFIXES), M.PROPERTY_SCOPED_KEY_PREFIXES);
check('スコープ対象の完全一致キー一覧が製品と一致する',
  J(sandbox.exact) === J(M.PROPERTY_SCOPED_EXACT_KEYS), M.PROPERTY_SCOPED_EXACT_KEYS);
[['fireflow-binder:101', 'fireflow-binder:' + PID_MAIN + ':101'],
 ['fireflow-property:current', 'fireflow-property:' + PID_MAIN + ':current'],
 ['fireflow-equip:自火報', 'fireflow-equip:' + PID_MAIN + ':自火報'],
 ['fireflow-documents', 'fireflow-documents:' + PID_MAIN]].forEach(function (pair) {
  check('scopedKeyが製品の変換と一致: ' + pair[0],
    sandbox.propertyScopedKey(pair[0], PID_MAIN) === pair[1] &&
    M.propertyScopedKey(pair[0], PID_MAIN) === pair[1], M.propertyScopedKey(pair[0], PID_MAIN));
});
check('lcCacheKeyが製品と一致(shared)', sandbox.lcCacheKey('x', true) === M.lcCacheKey('x', true));
check('lcCacheKeyが製品と一致(own)', sandbox.lcCacheKey('x', false) === M.lcCacheKey('x', false));

/* ================================================================
   1. dry-runモジュールが保存APIを構造的に持たないこと(静的検査)
   ---------------------------------------------------------------
   「呼ばないよう気をつける」ではなく「呼ぶコードが存在しない」ことを確認する。
   コメントは除去してから検査する(コメント中の説明文に反応しないため)。
   ================================================================ */
console.log('\n==== 1. 書き込みAPIを構造的に持たない ====');
var migSrc = fs.readFileSync(path.join(__dirname, '..', 'property_scope_migration.js'), 'utf8');
var codeOnly = migSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
var FORBIDDEN = ['storageSet(', 'storageDelete(', 'storageList(', 'lcPut(', 'lcDelete(',
  'window.storage', 'indexedDB', '.upsert(', '.insert(', 'localStorage'];
FORBIDDEN.forEach(function (f) {
  check('migrationモジュールのコードに ' + f + ' が存在しない', codeOnly.indexOf(f) === -1);
});
check('migrationモジュールに require/import が無い(外部副作用を持ち込まない)',
  codeOnly.indexOf('require(') === -1 && codeOnly.indexOf('import ') === -1);

/* ================================================================
   2. fixture A〜J
   ================================================================ */
console.log('\n==== 2. migration fixture A〜J ====');

// ---- 正常な端末(混在なし) ----
var cleanCache = [
  entry('shared:fireflow-property:current', currentRecordJson(PID_MAIN, ['101', '102', '103'], ['自火報'], ['1'])),
  entry('shared:fireflow-binder:101', J({ status: 'done' })),                       // A
  entry('shared:fireflow-schedule-override:101', J({ time: '10:00' })),             // A
  entry('shared:fireflow-equip:自火報', J({ result: 'ok' })),                        // 設備
  entry('shared:fireflow-ext:1', J({ result: 'ok' })),                              // 消火器
  entry('shared:fireflow-property:buildingNotes', J({ note: 'メモ' })),              // 物件付随
  entry('shared:fireflow-documents', J([{ name: 'a.pdf' }])),                        // 資料一覧
  entry('shared:fireflow-presence:user1', J({ at: 1 })),                             // プレゼンス
  entry('shared:fireflow-binder:102', J({ status: 'absent' })),                      // D: 同値が移行先に在る
  entry('shared:fireflow-binder:' + PID_MAIN + ':102', J({ status: 'absent' })),
  entry('shared:fireflow-binder:103', J({ status: 'done' })),                        // E: 異値が移行先に在る
  entry('shared:fireflow-binder:' + PID_MAIN + ':103', J({ status: 'cancelled' })),
  entry('shared:fireflow-property:progressLog', '{壊れたJSON'),                      // F: INVALID
  entry('own:lb_kantan_mode', '1'),                                                  // G: 端末設定
  entry('own:lb_font_scale', '1.2'),                                                 // G
  entry('shared:stamp:コスモ六甲:101', J({ mark: 'A' })),                             // H: Phase 1E
  entry('shared:fireflow-stamp:101', J({ mark: 'A' })),                              // H: Phase 1E
];
var cleanOutbox = [
  { key: 'shared:fireflow-binder:' + PID_MAIN + ':104', rawKey: 'fireflow-binder:' + PID_MAIN + ':104',
    value: J({ status: 'done' }), shared: true, deleted: false, propertyId: PID_MAIN, alreadyScoped: true },
  { key: 'shared:fireflow-binder:105', rawKey: 'fireflow-binder:105',                // I: propertyId無し旧item
    value: J({ status: 'done' }), shared: true, deleted: false },
  { key: 'own:lb_kantan_mode', rawKey: 'lb_kantan_mode', value: '1', shared: false, deleted: false },
  { key: 'broken', value: 'x' },
];

var planClean = M.planPropertyScopeMigration({
  cacheEntries: cleanCache, outboxEntries: cleanOutbox, currentPropertyId: PID_MAIN,
});

check('A: 混在の無い端末では contamination が検出されない',
  planClean.contamination.detected === false, planClean.contamination.orphanKeys);
check('A: 単一スコープ不変条件が成立し、propertyIdが確定する',
  planClean.invariant.applied === true && planClean.invariant.propertyId === PID_MAIN);

var itCurrent = findItem(planClean, 'fireflow-property:current');
check('A: propertyIdありcurrent property は MIGRATABLE',
  itCurrent.status === 'MIGRATABLE', itCurrent.status);
check('A: current property の根拠は A_RECORD_PROPERTY_ID(レコード自身のpropertyId)',
  itCurrent.evidence === 'A_RECORD_PROPERTY_ID', itCurrent.evidence);
check('A: current property の移行先キーが正しい',
  itCurrent.proposedScopedKey === 'fireflow-property:' + PID_MAIN + ':current', itCurrent.proposedScopedKey);

var itBinder = findItem(planClean, 'fireflow-binder:101');
check('A: binder(101) は MIGRATABLE', itBinder.status === 'MIGRATABLE', itBinder.status);
check('A: binder(101) の根拠は C_MEMBERSHIP(現物件の部屋一覧に在る)',
  itBinder.evidence === 'C_MEMBERSHIP', itBinder.evidence);
check('A: binder(101) の移行先キーが正しい',
  itBinder.proposedScopedKey === 'fireflow-binder:' + PID_MAIN + ':101', itBinder.proposedScopedKey);
check('A: schedule override も MIGRATABLE',
  findItem(planClean, 'fireflow-schedule-override:101').status === 'MIGRATABLE');
check('A: equip も MIGRATABLE', findItem(planClean, 'fireflow-equip:自火報').status === 'MIGRATABLE');
check('A: ext も MIGRATABLE', findItem(planClean, 'fireflow-ext:1').status === 'MIGRATABLE');
check('A: buildingNotes も MIGRATABLE', findItem(planClean, 'fireflow-property:buildingNotes').status === 'MIGRATABLE');
check('A: documents も MIGRATABLE', findItem(planClean, 'fireflow-documents').status === 'MIGRATABLE');
check('A: presence も MIGRATABLE', findItem(planClean, 'fireflow-presence:user1').status === 'MIGRATABLE');

check('D: 移行先に同値が在る場合は ALREADY_MIGRATED(複写しない)',
  findItem(planClean, 'fireflow-binder:102').status === 'ALREADY_MIGRATED',
  findItem(planClean, 'fireflow-binder:102').status);
check('D: 衝突分類は TARGET_EXISTS_SAME',
  findItem(planClean, 'fireflow-binder:102').collision === 'TARGET_EXISTS_SAME');

var itE = findItem(planClean, 'fireflow-binder:103');
check('E: 移行先に異値が在る場合は COLLISION(自動上書き禁止)', itE.status === 'COLLISION', itE.status);
check('E: 衝突分類は TARGET_EXISTS_DIFFERENT', itE.collision === 'TARGET_EXISTS_DIFFERENT');

check('F: 壊れたJSONは INVALID(移行も削除もしない)',
  findItem(planClean, 'fireflow-property:progressLog').status === 'INVALID');
check('G: lb_* 端末設定は SKIPPED_NON_PROPERTY_DATA',
  findItem(planClean, 'lb_kantan_mode').status === 'SKIPPED_NON_PROPERTY_DATA');
check('H: stamp: は Phase 1E としてSKIP',
  findItem(planClean, 'stamp:コスモ六甲:101').status === 'SKIPPED_PHASE1E');
check('H: fireflow-stamp: も Phase 1E としてSKIP',
  findItem(planClean, 'fireflow-stamp:101').status === 'SKIPPED_PHASE1E');

check('I: propertyIdありoutboxは ALREADY_SCOPED', planClean.outbox[0].status === 'ALREADY_SCOPED');
check('I: propertyId無し旧outboxは NEEDS_USER_ASSIGNMENT',
  planClean.outbox[1].status === 'NEEDS_USER_ASSIGNMENT', planClean.outbox[1].status);
check('I: 端末設定のoutboxは SKIPPED_NON_PROPERTY_DATA',
  planClean.outbox[2].status === 'SKIPPED_NON_PROPERTY_DATA');
check('I: 壊れたoutbox itemは INVALID', planClean.outbox[3].status === 'INVALID');
check('I: outboxの全itemが未変更(mutated=false)',
  planClean.outbox.every(function (o) { return o.mutated === false; }));
check('I: propertyId無しoutboxへ currentPropertyId が入っていない',
  planClean.outbox[1].propertyId === null, planClean.outbox[1].propertyId);

// ---- B: propertyId無しcurrent property ----
var planNoPid = M.planPropertyScopeMigration({
  cacheEntries: [
    entry('shared:fireflow-property:current', currentRecordJson(null, ['101'], [], [])),
    entry('shared:fireflow-binder:101', J({ status: 'done' })),
  ],
  outboxEntries: [], currentPropertyId: PID_MAIN,
});
check('B: propertyId無しcurrent property は UNKNOWN_PROPERTY',
  findItem(planNoPid, 'fireflow-property:current').status === 'UNKNOWN_PROPERTY',
  findItem(planNoPid, 'fireflow-property:current').status);
check('B: 推測割当をせず NEEDS_USER_ASSIGNMENT として残す',
  findItem(planNoPid, 'fireflow-property:current').needsUserAssignment === true);
check('B: propertyIdが確定できないので従属データも UNKNOWN_PROPERTY',
  findItem(planNoPid, 'fireflow-binder:101').status === 'UNKNOWN_PROPERTY');
check('B: currentPropertyIdが渡されていても移行に使われていない',
  planNoPid.summary.MIGRATABLE === 0, planNoPid.summary);

// ---- C: propertyId無しbinder単体(current property recordが存在しない) ----
var planOrphanOnly = M.planPropertyScopeMigration({
  cacheEntries: [entry('shared:fireflow-binder:101', J({ status: 'done' }))],
  outboxEntries: [], currentPropertyId: PID_MAIN,
});
check('C: binder単体(所属を証明できない)は UNKNOWN_PROPERTY',
  findItem(planOrphanOnly, 'fireflow-binder:101').status === 'UNKNOWN_PROPERTY');
check('C: 移行対象は0件', planOrphanOnly.summary.MIGRATABLE === 0);

// ---- J: A物件/B物件が混在して一意に割当不能 ----
var planMixed = M.planPropertyScopeMigration({
  cacheEntries: [
    entry('shared:fireflow-property:current', currentRecordJson(PID_MAIN, ['101'], [], [])),
    entry('shared:fireflow-binder:101', J({ status: 'done' })),   // 現物件に在る部屋
    entry('shared:fireflow-binder:999', J({ status: 'done' })),   // 別建物の残骸(orphan)
    entry('shared:fireflow-property:buildingNotes', J({ note: 'x' })),
  ],
  outboxEntries: [], currentPropertyId: PID_MAIN,
});
check('J: 混在の痕跡(orphan)が検出される',
  planMixed.contamination.detected === true, planMixed.contamination.orphanKeys);
check('J: orphanは AMBIGUOUS(移行しない・削除しない)',
  findItem(planMixed, 'fireflow-binder:999').status === 'AMBIGUOUS');
check('J: 混在端末では現物件に在る部屋も AMBIGUOUS へ倒す(既定の厳格運用)',
  findItem(planMixed, 'fireflow-binder:101').status === 'AMBIGUOUS',
  findItem(planMixed, 'fireflow-binder:101').status);
check('J: 混在端末でも current property record だけは根拠Aで MIGRATABLE',
  findItem(planMixed, 'fireflow-property:current').status === 'MIGRATABLE');
check('J: 混在端末で部屋・設備単位の移行は0件',
  planMixed.items.filter(function (i) {
    return i.status === 'MIGRATABLE' && i.domain !== 'propertyCurrent';
  }).length === 0);

/* ================================================================
   3. WEAK根拠による自動割当が0であること
   ================================================================ */
console.log('\n==== 3. WEAK根拠による自動割当0 ====');
var allPlans = [planClean, planNoPid, planOrphanOnly, planMixed];
var weakMigrations = [];
allPlans.forEach(function (p) {
  p.items.forEach(function (i) {
    if (i.status === 'MIGRATABLE' && (i.evidence === 'D_WEAK' || i.evidence === 'E_UNKNOWN')) weakMigrations.push(i);
  });
});
check('WEAK/UNKNOWN根拠のみで MIGRATABLE になった項目が0件', weakMigrations.length === 0, weakMigrations);

var wrongProperty = [];
allPlans.forEach(function (p) {
  p.items.forEach(function (i) {
    if (i.status === 'MIGRATABLE' && i.propertyId !== null && i.propertyId !== PID_MAIN) wrongProperty.push(i);
  });
});
check('確定した以外のpropertyIdへ移行しようとする項目が0件', wrongProperty.length === 0, wrongProperty);
check('COLLISION項目が上書き提案になっていない(移行対象に含まれない)',
  planClean.items.filter(function (i) { return i.status === 'COLLISION'; })
    .every(function (i) { return i.collision === 'TARGET_EXISTS_DIFFERENT'; }));

/* ================================================================
   4. WRITE COUNT = 0 / DELETE COUNT = 0（read-only証明）
   ---------------------------------------------------------------
   保存APIを「呼んだら必ず失敗し、かつ数を記録する」形に毒入りで用意し、
   dry-run実行前後のスナップショットが完全一致することを確認する。
   ================================================================ */
console.log('\n==== 4. WRITE/DELETE 0 の機械確認 ====');
var writeCount = 0, deleteCount = 0;
function poisonWrite() { writeCount++; throw new Error('dry-runが書き込みを行った'); }
function poisonDelete() { deleteCount++; throw new Error('dry-runが削除を行った'); }

global.storageSet = poisonWrite;
global.storageList = poisonWrite;
global.lcPut = poisonWrite;
global.storageDelete = poisonDelete;
global.lcDelete = poisonDelete;
global.window = {
  storage: { set: poisonWrite, delete: poisonDelete, list: poisonWrite, get: poisonWrite },
  localStorage: { setItem: poisonWrite, removeItem: poisonDelete },
};
global.supabaseMock = { insert: poisonWrite, update: poisonWrite, upsert: poisonWrite, delete: poisonDelete };

var snapshotCacheBefore = J(cleanCache);
var snapshotOutboxBefore = J(cleanOutbox);
var appState = { PROPERTY: { propertyId: PID_MAIN, name: 'コスモ六甲' }, currentPropertyId: PID_MAIN, state: { '101': { status: 'done' } } };
var snapshotStateBefore = J(appState);
var cacheCountBefore = cleanCache.length;
var outboxCountBefore = cleanOutbox.length;

var planAgain = M.planPropertyScopeMigration({
  cacheEntries: cleanCache, outboxEntries: cleanOutbox, currentPropertyId: PID_MAIN,
});

check('WRITE COUNT = 0', writeCount === 0, writeCount);
check('DELETE COUNT = 0', deleteCount === 0, deleteCount);
check('IndexedDB(cache)件数がdry-run前後で一致', cleanCache.length === cacheCountBefore, cleanCache.length);
check('outbox件数がdry-run前後で一致', cleanOutbox.length === outboxCountBefore, cleanOutbox.length);
check('cacheスナップショットがdry-run前後で完全一致', J(cleanCache) === snapshotCacheBefore);
check('outboxスナップショットがdry-run前後で完全一致', J(cleanOutbox) === snapshotOutboxBefore);
check('state/PROPERTY/currentPropertyId がdry-run前後で完全一致', J(appState) === snapshotStateBefore);
check('planが writeCount:0 を自己申告する', planAgain.writeCount === 0);
check('planが deleteCount:0 を自己申告する', planAgain.deleteCount === 0);
check('同じ入力に対して結論が決定的(2回計画して同一)', J(planAgain.summary) === J(planClean.summary));
check('StampStore対象キーがdry-runで一切変更されていない',
  J(cleanCache.filter(function (e) { return String(e.key).indexOf('stamp') !== -1; })).length > 0 &&
  J(cleanCache) === snapshotCacheBefore);

delete global.storageSet; delete global.storageList; delete global.lcPut;
delete global.storageDelete; delete global.lcDelete; delete global.window; delete global.supabaseMock;

/* ================================================================
   5. idempotent（同じmigrationを2回計画しても壊れない）
   ================================================================ */
console.log('\n==== 5. idempotent設計 ====');
// 1回目の計画のうち MIGRATABLE を「適用した後」の状態を作る(入力配列は変更しない)。
var afterApply = cleanCache.slice();
planClean.items.forEach(function (i) {
  if (i.status !== 'MIGRATABLE') return;
  var src = cleanCache.filter(function (e) { return e.key === i.cacheKey; })[0];
  afterApply.push({ key: i.proposedCacheKey, value: src.value, updatedAt: src.updatedAt });
});
check('適用シミュレーションが元の配列を壊していない', J(cleanCache) === snapshotCacheBefore);

var planSecond = M.planPropertyScopeMigration({
  cacheEntries: afterApply, outboxEntries: cleanOutbox, currentPropertyId: PID_MAIN,
});
check('2回目の計画で MIGRATABLE が0件になる(重複複写なし)',
  planSecond.summary.MIGRATABLE === 0, planSecond.summary);
check('2回目の計画で COLLISION が増えていない(上書き提案が生まれない)',
  planSecond.summary.COLLISION === planClean.summary.COLLISION,
  { first: planClean.summary.COLLISION, second: planSecond.summary.COLLISION });
check('2回目の計画で1回目のMIGRATABLEが ALREADY_MIGRATED になる',
  planSecond.summary.ALREADY_MIGRATED >= planClean.summary.MIGRATABLE,
  { already: planSecond.summary.ALREADY_MIGRATED, firstMigratable: planClean.summary.MIGRATABLE });
check('migration versionが固定されている', planClean.version === 'property-scope-v1', planClean.version);
check('2回目でも判定が別物件へ動かない',
  planSecond.items.every(function (i) { return i.propertyId === null || i.propertyId === PID_MAIN; }));

/* ================================================================
   6. rollback設計（監査ログ形と、取り消してよい条件）
   ================================================================ */
console.log('\n==== 6. rollback設計 ====');
var migratableItem = findItem(planClean, 'fireflow-binder:101');
var audit = M.buildAuditRecord(migratableItem, 'run-0001', '2026-08-18T12:00:00.000Z');
['runId', 'migrationVersion', 'timestamp', 'sourceKey', 'targetKey', 'sourceHash',
 'targetHashBefore', 'propertyId', 'status'].forEach(function (f) {
  check('監査ログに ' + f + ' が含まれる', Object.prototype.hasOwnProperty.call(audit, f));
});
check('監査ログが「migrationが作ったtarget」を識別できる', audit.createdByMigration === true);
check('rollback可: migrationが作り、複写後に変更されていない',
  M.canRollback(audit, J({ status: 'done' })) === true);
check('rollback不可: 複写後に値が変更されている(現場の入力を消さない)',
  M.canRollback(audit, J({ status: 'absent' })) === false);
check('rollback不可: 移行先が既に消えている', M.canRollback(audit, undefined) === false);

var preExisting = M.buildAuditRecord(findItem(planClean, 'fireflow-binder:102'), 'run-0001', '2026-08-18T12:00:00.000Z');
check('rollback不可: 元から在った既存scopedデータは絶対に消さない',
  preExisting.createdByMigration === false && M.canRollback(preExisting, J({ status: 'absent' })) === false);

/* ================================================================
   7. 旧キーは今回1件も削除対象にならない
   ================================================================ */
console.log('\n==== 7. 旧キー削除0 ====');
check('計画に「旧キー削除」を指示するフィールドが存在しない',
  planClean.items.every(function (i) {
    return !Object.prototype.hasOwnProperty.call(i, 'deleteLegacy') &&
           !Object.prototype.hasOwnProperty.call(i, 'deleteSource');
  }));
check('計画に本migrationを実行する関数が公開されていない',
  typeof M.executePropertyScopeMigration !== 'function' && typeof M.applyMigration !== 'function');

/* ================================================================
   総合結果
   ================================================================ */
var passed = results.filter(function (r) { return r.ok; }).length;
var total = results.length;
console.log('\n==== phase1d_property_scope_migration_dry_run_verify 総合結果: '
  + (passed === total ? 'PASS' : 'FAIL') + ' (' + passed + '/' + total + ') ====');
if (passed !== total) {
  results.filter(function (r) { return !r.ok; }).forEach(function (r) { console.log('  NG: ' + r.label); });
  process.exit(1);
}
