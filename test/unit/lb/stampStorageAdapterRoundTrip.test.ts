// [2026-08-15新設 Phase 2 最終検証] 実LBの保存アダプタ結線そのものの往復テスト(Level 3の穴埋め)。
//
// 【なぜ必要か】
// 既存の stampStore.test.ts / standardizedStampLbBridge.test.ts は「保存→再読込→復元」を
// 検証しているが、保存先アダプタはテスト用の単純なキー辞書に置き換えている。
// 実ブラウザで実際に通るのは index.html の
//
//     storageSet(key, value, true)  → lcPut('cache', { key: lcCacheKey(key, true) ... })
//     listKeysLocalFirst(prefix)    → lcGetAll('cache') のキーから 'shared:' を外して前方一致
//     storageGet(key, true)         → リモート優先／失敗時に lcGet('cache', 'shared:'+key)
//
// という鎖であり、ここでキー名の付け方が1文字でもずれると「読み取り直後は出るのに、
// ページを再読込すると予定情報が消える」という Phase 0 で確定した症状がそのまま再発する。
// この鎖は実ブラウザ(IndexedDB)でしか動かないため自動テストの対象外になっていた。
//
// そこで IndexedDB の入出力(lcPut/lcGet/lcDelete/lcGetAll)だけをメモリ実装に差し替え、
// キー名を決めている関数(lcCacheKey)・保存/取得/一覧の関数(storageSet/storageGet/
// listKeysLocalFirst)・StampStoreへのアダプタ結線は index.html の実ソースをそのまま実行する。
//
// 【検証する状況】実運用で起きる3つの通信状態すべてで、再読込後に予定情報が残ること。
//   1. リモート未初期化(window.storage が無い＝起動直後・オフライン)
//   2. リモートは動いているが、その部屋の行がまだ無い(送信キューに残っている状態)
//   3. リモートに行がある(通常)

import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

function assert(cond: unknown, msg: string) { if (!cond) throw new Error('FAIL: ' + msg); }

const ROOT = path.join(__dirname, '..', '..', '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const STORE_SOURCE = fs.readFileSync(path.join(ROOT, 'public', 'stamp_store', 'stamp_store.js'), 'utf8');

/* index.html から関数のソースをそのまま取り出す(既存テストと同じ手法)。 */
function extractFunctionSource(functionName: string): string {
  const marker = 'function ' + functionName + '(';
  let startIdx = html.indexOf(marker);
  if (startIdx === -1) throw new Error('function not found: ' + functionName);
  if (html.slice(startIdx - 6, startIdx) === 'async ') startIdx -= 6;
  let i = html.indexOf('{', startIdx);
  let depth = 0;
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') { depth--; if (depth === 0) return html.slice(startIdx, i + 1); }
  }
  throw new Error('unbalanced braces: ' + functionName);
}

/* 単一行の `var NAME = ...;` も同じくindex.htmlの実ソースから取り出す
   ([2026-08-18 Phase 1C] storageSet/storageGet が参照する property scope の設定値のため。
   写経した別定義を置くと、実LBと違う設定でテストが通ってしまう)。 */
function extractVarDeclSource(name: string): string {
  const marker = 'var ' + name + ' = ';
  const startIdx = html.indexOf(marker);
  if (startIdx === -1) throw new Error('var not found: ' + name);
  return html.slice(startIdx, html.indexOf(';', startIdx) + 1);
}

/* StampStoreへのアダプタ結線(createStampStore({ adapters: {...} }))も、index.htmlの実ソースを使う。
   ここを写経するとテストだけ通って実LBが壊れる、という状態を作れてしまうため。 */
function extractStampStoreWiring(): string {
  const marker = 'window.FireFlowStampStore.createStampStore(';
  const markerIdx = html.indexOf(marker);
  assert(markerIdx !== -1, 'index.htmlにcreateStampStoreの結線がある');
  let i = html.indexOf('{', markerIdx);
  let depth = 0;
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') {
      depth--;
      if (depth === 0) {
        const objLiteral = html.slice(html.indexOf('{', markerIdx), i + 1);
        return 'var stampStore = window.FireFlowStampStore.createStampStore(' + objLiteral + ');';
      }
    }
  }
  throw new Error('unbalanced braces: createStampStore wiring');
}

type FakeIdb = { cache: Record<string, { key: string; value: unknown }>; outbox: Record<string, unknown> };

type RemoteMode = 'absent' | 'empty' | 'ok';

type Sandbox = Record<string, unknown> & {
  __idb: FakeIdb;
  __setRemoteMode: (mode: RemoteMode) => void;
};

/* ブラウザ1タブぶんの環境を作る。__idb を引き継げば「ページ再読込」を再現できる
   (メモリ上の変数は全て作り直され、IndexedDBの中身だけが残る)。 */
function makeBrowser(idb: FakeIdb, remoteMode: RemoteMode): Sandbox {
  // リモート(Supabase kv_store)の中身。window.storage.get は「行が無ければ例外」を投げる
  // 実装(public/supabase-integration.js)に合わせる。ここが例外を投げるからこそ、
  // index.html の storageGet がローカルキャッシュへフォールバックできる。
  const remoteRows: Record<string, unknown> = {};
  let mode: RemoteMode = remoteMode;

  const sandbox: Record<string, unknown> = {
    console, Promise, Object, Array, JSON, String, Number, Boolean, Date, Error, setTimeout,
    // IndexedDB相当(メモリ)。実装差ではなくキー名の整合だけを見たいので最小実装にする。
    lcPut: (store: 'cache' | 'outbox', item: { key: string }) => {
      (idb as unknown as Record<string, Record<string, unknown>>)[store][item.key] = item;
      return Promise.resolve();
    },
    lcGet: (store: 'cache' | 'outbox', key: string) =>
      Promise.resolve((idb as unknown as Record<string, Record<string, unknown>>)[store][key] || null),
    lcDelete: (store: 'cache' | 'outbox', key: string) => {
      delete (idb as unknown as Record<string, Record<string, unknown>>)[store][key];
      return Promise.resolve();
    },
    lcGetAll: (store: 'cache' | 'outbox') =>
      Promise.resolve(Object.keys((idb as unknown as Record<string, Record<string, unknown>>)[store])
        .map((k) => (idb as unknown as Record<string, Record<string, unknown>>)[store][k])),
    // 送信キューのUI表示はこのテストの対象外。
    updateSyncBadge: () => {},
    scheduleOutboxRetry: () => {},
    window: {} as Record<string, unknown>,
  };

  function installRemote() {
    const win = sandbox.window as Record<string, unknown>;
    if (mode === 'absent') { delete win.storage; return; }
    win.storage = {
      get: (key: string, shared: boolean) => {
        if (mode !== 'ok' || !(key in remoteRows)) {
          return Promise.reject(new Error('key not found: ' + key));
        }
        return Promise.resolve({ key: key, value: remoteRows[key], shared: !!shared });
      },
      set: (key: string, value: unknown) => {
        if (mode === 'ok') remoteRows[key] = value;
        return Promise.resolve({ key: key, value: value });
      },
      delete: (key: string) => { delete remoteRows[key]; return Promise.resolve({ key: key, deleted: true }); },
      // list はリモートのみを見る(index.htmlのstorageListそのまま)。リモートに何も無ければ空。
      list: (prefix: string, shared: boolean) => Promise.resolve({
        keys: Object.keys(remoteRows).filter((k) => k.indexOf(prefix) === 0), prefix: prefix, shared: !!shared,
      }),
    };
  }
  installRemote();

  vm.createContext(sandbox);
  vm.runInContext(STORE_SOURCE, sandbox);
  // [2026-08-18 Phase 1C] storageSet/storageGet/storageDelete/storageList は property scope 層を
  // 通るようになったため、その実ソースも一緒に読み込む(この環境では
  // window.FIREFLOW_PROPERTY_SCOPE_ENABLED が未設定＝flag OFF なので、保存キーは従来のまま)。
  vm.runInContext([
    'PROPERTY_SCOPE_ENABLED', 'PROPERTY_SCOPED_KEY_PREFIXES', 'PROPERTY_SCOPED_EXACT_KEYS',
  ].map(extractVarDeclSource).join('\n'), sandbox);
  vm.runInContext([
    'isPropertyScopedKey', 'propertyScopedKey', 'propertyUnscopedKey',
    'isValidScopePropertyId', 'currentScopePropertyId', 'applyPropertyScope',
    'lcCacheKey', 'storageSet', 'storageGet', 'storageDelete', 'storageList', 'listKeysLocalFirst',
  ].map(extractFunctionSource).join('\n\n'), sandbox);
  vm.runInContext(extractStampStoreWiring(), sandbox);
  vm.runInContext('var __store = stampStore;', sandbox);

  (sandbox as Sandbox).__idb = idb;
  (sandbox as Sandbox).__setRemoteMode = (next: RemoteMode) => { mode = next; installRemote(); };
  return sandbox as Sandbox;
}

type Store = {
  setPropertyKey: (k: string) => string;
  putMany: (records: unknown[], opts: unknown) => Promise<{ saved: string[]; rejected: unknown[] }>;
  loadAll: (opts: unknown) => Promise<{ restored: string[]; skipped: string[] }>;
  get: (room: string) => Record<string, unknown> | null;
};

const PROPERTY = 'コスモ城東野江ロイヤルフォルム';
const SCOPE = 'コスモ城東野江ロイヤルフォルム'; // normalizePropertyKey は日本語をそのまま使う
const MASTER = ['1101', '801', '802', '1102'];

// 実OCRで確定した内容と同じ形(1101 / 801 / 802)。1102は捺印表に印字が無いので入れない。
const RECORDS = [
  { room: '1101', symbol: 'A', time_start: '09:30', source: 'standardized_stamp_sheet' },
  {
    room: '801', symbol: 'A', time_start: '09:30', note: '朝一', note_raw: '朝一',
    source: 'standardized_stamp_sheet',
  },
  {
    room: '802', symbol: '', symbol_review: true, needs_review: true,
    review_reason: ['複数チェック'], raw_checkboxes: { a: true, p: true },
    source: 'standardized_stamp_sheet',
  },
];

function newIdb(): FakeIdb { return { cache: {}, outbox: {} }; }

function assertRestoredState(store: Store, phase: string) {
  const r1101 = store.get('1101');
  assert(r1101 && r1101.symbol === 'A' && r1101.time_start === '09:30', phase + ': 1101はA/09:30');
  const r801 = store.get('801');
  assert(r801 && r801.symbol === 'A' && r801.time_start === '09:30', phase + ': 801はA/09:30');
  assert(r801 && r801.note === '朝一', phase + ': 801の備考「朝一」が残る');
  const r802 = store.get('802');
  assert(r802 && r802.needs_review === true && r802.symbol_review === true, phase + ': 802は要確認(記号)');
  assert(r802 && r802.symbol === '', phase + ': 802は記号を確定表示しない');
  assert(store.get('1102') === null, phase + ': 1102は予定情報なし(部屋はMASTER側にある)');
}

async function saveThenReload(saveMode: RemoteMode, reloadMode: RemoteMode, phase: string) {
  const idb = newIdb();

  // --- ページ1: 新捺印表を読み取って保存 ---
  const page1 = makeBrowser(idb, saveMode);
  const store1 = (page1 as unknown as { __store: Store }).__store;
  store1.setPropertyKey(PROPERTY);
  const put = await store1.putMany(RECORDS, { knownRooms: MASTER, source: 'standardized_stamp_sheet' });
  assert(put.saved.length === 3, phase + ': 3室が保存される');

  // 保存キーは 'shared:stamp:<物件>:<部屋>' の形でローカルキャッシュへ入る。
  const cacheKeys = Object.keys(idb.cache);
  assert(cacheKeys.length === 3, phase + ': ローカルキャッシュに3件入る(リモートの成否に関わらず)');
  assert(cacheKeys.indexOf('shared:stamp:' + SCOPE + ':801') !== -1,
    phase + ': キーは shared: + stamp:<物件>:<部屋>');

  // --- ページ2: ブラウザ再読込(メモリは全部捨て、IndexedDBだけ引き継ぐ) ---
  const page2 = makeBrowser(idb, reloadMode);
  const store2 = (page2 as unknown as { __store: Store }).__store;
  store2.setPropertyKey(PROPERTY);
  const loaded = await store2.loadAll({ knownRooms: MASTER });
  assert(loaded.restored.length === 3, phase + ': 再読込で3室すべてが復元される (got ' + loaded.restored.length + ')');
  assertRestoredState(store2, phase);
}

async function main() {
  // 1. 起動直後・オフライン。window.storage が無くてもローカルだけで往復できる。
  await saveThenReload('absent', 'absent', '① リモート未初期化');

  // 2. 最も危険な組み合わせ: 保存時はリモートへ届かず(送信キュー)、再読込時はリモートが
  //    生きている。ここでリモートを優先しきってしまうと「行が無い＝予定情報なし」と解釈され、
  //    ローカルにある正本が無視される(Phase 0で確定した消失原因と同じ形)。
  await saveThenReload('empty', 'ok', '② 送信キューに残ったまま再読込');

  // 3. 通常(リモートも生きている)。
  await saveThenReload('ok', 'ok', '③ リモート正常');

  // --- 4. リモートが「行が無い」を返しても、ローカルの値が壊されないこと ---
  // storageGet は取得成功時にローカルキャッシュを上書きするため、失敗時に上書きしていないかを見る。
  {
    const idb = newIdb();
    const page1 = makeBrowser(idb, 'empty');
    const store1 = (page1 as unknown as { __store: Store }).__store;
    store1.setPropertyKey(PROPERTY);
    await store1.putMany(RECORDS, { knownRooms: MASTER, source: 'standardized_stamp_sheet' });

    const page2 = makeBrowser(idb, 'empty');
    const store2 = (page2 as unknown as { __store: Store }).__store;
    store2.setPropertyKey(PROPERTY);
    await store2.loadAll({ knownRooms: MASTER });
    const cached = idb.cache['shared:stamp:' + SCOPE + ':801'] as { value: string };
    assert(cached && typeof cached.value === 'string' && cached.value.indexOf('朝一') !== -1,
      '④ リモートに行が無くても、ローカルの正本がnullで上書きされない');

    // さらにもう一度再読込しても復元できる(消失が1回遅れて起きないこと)。
    const page3 = makeBrowser(idb, 'empty');
    const store3 = (page3 as unknown as { __store: Store }).__store;
    store3.setPropertyKey(PROPERTY);
    const loaded3 = await store3.loadAll({ knownRooms: MASTER });
    assert(loaded3.restored.length === 3, '④ 2回目の再読込でも3室が復元される');
    assertRestoredState(store3, '④ 2回目の再読込');
  }

  // --- 5. 物件スコープが違えば、同じ部屋番号でも復元しない ---
  {
    const idb = newIdb();
    const page1 = makeBrowser(idb, 'ok');
    const store1 = (page1 as unknown as { __store: Store }).__store;
    store1.setPropertyKey(PROPERTY);
    await store1.putMany(RECORDS, { knownRooms: MASTER, source: 'standardized_stamp_sheet' });

    const page2 = makeBrowser(idb, 'ok');
    const store2 = (page2 as unknown as { __store: Store }).__store;
    store2.setPropertyKey('別の物件');
    const loaded = await store2.loadAll({ knownRooms: MASTER, skipLegacyMigration: true });
    assert(loaded.restored.length === 0, '⑤ 別物件では前物件の予定情報を復元しない');
  }

  console.log('OK: ① リモート未初期化でも保存→再読込で復元できる');
  console.log('OK: ② 送信キューに残ったまま再読込しても、ローカルの正本から復元できる');
  console.log('OK: ③ リモート正常時も同じ結果になる');
  console.log('OK: ④ リモートに行が無い応答でローカルの正本が壊れない');
  console.log('OK: ⑤ 物件スコープをまたいで混入しない');
  console.log('ALL PASS: stampStorageAdapterRoundTrip.test.ts');
}

main().catch((err) => { console.error(String(err && err.message ? err.message : err)); process.exit(1); });
