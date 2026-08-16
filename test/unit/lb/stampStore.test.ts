// [2026-08-15新設 Phase 1] 予定情報の唯一の正本 StampStore の単体テスト(Level 2/3)。
//
// 検証の主眼は、Phase 0で構造的原因として確定した次の3点が二度と起きないこと。
//  (1) MASTER(Excel由来の部屋一覧)に無い部屋をOCR結果から作らない
//  (2) 物件スコープをまたいで予定情報が混入しない
//  (3) リモート(Supabase)が使えない状況でも、保存済みの予定情報を復元できる
//      ＝「読み取り直後は出るのに、再読込で消える」の再発防止

import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

function assert(cond: unknown, msg: string) { if (!cond) throw new Error('FAIL: ' + msg); }

// public/stamp_store/stamp_store.js を、ブラウザと同じソースのまま読み込む。
const storeSource = fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'public', 'stamp_store', 'stamp_store.js'), 'utf8');
const sandbox: Record<string, unknown> = { module: { exports: {} }, console };
vm.createContext(sandbox);
vm.runInContext(storeSource, sandbox);
const StampStore = (sandbox.module as { exports: any }).exports;
assert(typeof StampStore.createStampStore === 'function', 'createStampStoreが公開されている');

// --- テスト用の保存先(ローカル/リモートを別々に模す) ---
type Backend = { data: Record<string, string>; failList?: boolean; failSet?: boolean };
function makeAdapters(local: Backend, remote?: Backend) {
  return {
    list: async (prefix: string) => {
      const keys = Object.keys(local.data).filter((k) => k.startsWith(prefix));
      if (remote && !remote.failList) {
        Object.keys(remote.data).filter((k) => k.startsWith(prefix)).forEach((k) => {
          if (keys.indexOf(k) === -1) keys.push(k);
        });
      }
      return keys;
    },
    get: async (key: string) => (local.data[key] !== undefined ? local.data[key] : (remote ? remote.data[key] ?? null : null)),
    set: async (key: string, value: string) => {
      // ローカルは必ず成功する(index.html側のstorageSetと同じ性質)。
      local.data[key] = value;
      if (remote && !remote.failSet) remote.data[key] = value;
    },
    remove: async (key: string) => { delete local.data[key]; if (remote) delete remote.data[key]; },
  };
}

const MASTER_ROOMS = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'public', 'test', 'fixtures', 'prop13', 'gt_totals.json'), 'utf8'));
const master: string[] = Object.keys(MASTER_ROOMS);
assert(master.length === 66 && master.indexOf('1102') !== -1, '前提: MASTERは66室で1102を含む');

const NEW_OCR_RECORDS = [
  { room: '1101', symbol: 'A', time_start: '09:30', time_end: '', note: '', note_raw: '', needs_review: false, review_reason: [], raw_checkboxes: { a: true, p: false, cancel: false } },
  { room: '801', symbol: 'A', time_start: '09:30', time_end: '', note: '朝一', note_raw: '朝一', needs_review: false, review_reason: [], raw_checkboxes: { a: true, p: false, cancel: false } },
  { room: '802', symbol: '', time_start: '', time_end: '', note: '', note_raw: '', needs_review: true, review_reason: ['SYMBOL:MULTIPLE_SYMBOL_CHECKED'], raw_checkboxes: { a: true, p: true, cancel: false } },
];

async function main() {

// --- 1. 保存: MASTERに無い部屋は受け付けない(OCRからMASTERを作らない) ---
{
  const local: Backend = { data: {} };
  const store = StampStore.createStampStore({ adapters: makeAdapters(local), propertyKey: 'cosmo-joto-noe' });
  const result = await store.putMany(
    NEW_OCR_RECORDS.concat([{ room: '9999', symbol: 'A', time_start: '10:00' } as any]),
    { knownRooms: master, source: 'standardized_stamp_sheet' });
  assert(result.saved.length === 3, 'MASTERに在る3室だけ保存される');
  assert(result.rejected.some((r: any) => r.room === '9999' && r.reason === 'NOT_IN_MASTER'), 'MASTERに無い部屋はNOT_IN_MASTERで拒否');
  assert(store.get('9999') === null, '拒否された部屋は正本に存在しない');
  assert(store.get('1101').symbol === 'A' && store.get('1101').time_start === '09:30', '1101が正本に入る');
  assert(store.get('801').note === '朝一' && store.get('801').note_raw === '朝一', '801は確定noteと原文の両方を保持する');
  assert(store.get('802').symbol === '' && store.get('802').needs_review === true, '802は記号を確定させず要確認のまま');
  assert(store.get('1102') === null, '捺印表に印字が無い1102は予定情報を持たない(部屋自体はMASTER側にある)');
  assert(store.get('801').source === 'standardized_stamp_sheet', 'どの経路で入った値かがsourceで分かる');
  assert(typeof store.get('801').updated_at === 'string' && store.get('801').updated_at !== '', '更新時刻が入る');
}

// --- 2. 保存→復元(同じスコープ) ---
{
  const local: Backend = { data: {} };
  const remote: Backend = { data: {} };
  const adapters = makeAdapters(local, remote);
  const a = StampStore.createStampStore({ adapters, propertyKey: 'cosmo-joto-noe' });
  await a.putMany(NEW_OCR_RECORDS, { knownRooms: master, source: 'standardized_stamp_sheet' });

  // 別インスタンス＝ページ再読込に相当。
  const b = StampStore.createStampStore({ adapters, propertyKey: 'cosmo-joto-noe' });
  const restored = await b.loadAll({ knownRooms: master });
  assert(restored.restored.length === 3, '再読込で3室が復元される');
  assert(b.get('1101').time_start === '09:30', '再読込後も1101=09:30');
  assert(b.get('801').note === '朝一' && b.get('801').note_raw === '朝一', '再読込後も801の備考(確定値と原文)が残る');
  assert(b.get('802').needs_review === true, '再読込後も802は要確認');
  assert(b.get('1102') === null, '1102は予定情報なしのまま');
}

// --- 3. リモートが使えなくてもローカルから復元できる(Phase 0で確定した消失原因) ---
{
  const local: Backend = { data: {} };
  const remote: Backend = { data: {}, failList: true, failSet: true };
  const adapters = makeAdapters(local, remote);
  const a = StampStore.createStampStore({ adapters, propertyKey: 'cosmo-joto-noe' });
  await a.putMany(NEW_OCR_RECORDS, { knownRooms: master, source: 'standardized_stamp_sheet' });
  assert(Object.keys(remote.data).length === 0, '前提: リモートには何も入っていない');

  const b = StampStore.createStampStore({ adapters, propertyKey: 'cosmo-joto-noe' });
  const restored = await b.loadAll({ knownRooms: master });
  assert(restored.restored.length === 3, 'リモートが落ちていてもローカルから3室復元できる');
  assert(b.get('1101').time_start === '09:30', 'オフラインでも1101=09:30が戻る');
}

// --- 4. 物件スコープ: 別物件へ同じ部屋番号があっても混入しない ---
{
  const local: Backend = { data: {} };
  const adapters = makeAdapters(local);
  const store = StampStore.createStampStore({ adapters, propertyKey: 'property-A' });
  await store.putMany([{ room: '801', symbol: 'A', time_start: '09:30' }], { knownRooms: master, source: 'standardized_stamp_sheet' });

  store.setPropertyKey('property-B');
  assert(store.get('801') === null, '物件を切り替えるとメモリ上の予定情報は持ち越さない');
  const loaded = await store.loadAll({ knownRooms: master, skipLegacyMigration: true });
  assert(loaded.restored.length === 0, '別物件のスコープには前物件の値が復元されない');

  store.setPropertyKey('property-A');
  const back = await store.loadAll({ knownRooms: master });
  assert(back.restored.indexOf('801') !== -1 && store.get('801').time_start === '09:30', '元の物件へ戻れば復元される');
}

// --- 5. 旧キー(fireflow-stamp:<room>)からの一度きりの取り込み ---
{
  const local: Backend = { data: {
    'fireflow-stamp:1101': JSON.stringify({ symbol: 'A', time: '09:30', time_end: '', note: '', name: '' }),
    'fireflow-stamp:9999': JSON.stringify({ symbol: 'A', time: '10:00' }),
  } };
  const store = StampStore.createStampStore({ adapters: makeAdapters(local), propertyKey: 'cosmo-joto-noe' });
  const result = await store.loadAll({ knownRooms: master });
  assert(result.migrated.indexOf('1101') !== -1, '旧キーの1101が取り込まれる');
  assert(result.migrated.indexOf('9999') === -1, 'MASTERに無い部屋は取り込まない');
  assert(store.get('1101').time_start === '09:30' && store.get('1101').source === 'migrated_legacy', '取り込み後もsourceで由来が分かる');
  assert(local.data['fireflow-stamp:1101'] !== undefined, '旧キーは削除しない(取り込み失敗で元データを失わないため)');
  assert(local.data['stamp:cosmo-joto-noe:1101'] !== undefined, '新キーへ保存される');
}

// --- 6. 経路が違っても同じ正本へ入り、互いを消さない(Legacy/CSV/新捺印表の混在) ---
{
  const local: Backend = { data: {} };
  const store = StampStore.createStampStore({ adapters: makeAdapters(local), propertyKey: 'cosmo-joto-noe' });
  await store.putMany(NEW_OCR_RECORDS, { knownRooms: master, source: 'standardized_stamp_sheet' });
  // Legacy(点検希望時間連絡票)の1室。従来はSTAMP_DATAごと差し替えて他経路を消していた。
  await store.putMany([StampStore.fromLegacyEntry('603', { symbol: 'A', time: '10:00', time_mode: 'exact', name: '山田' }, { source: 'legacy_time_request' })],
    { knownRooms: master });
  // CSV取込の1室。
  await store.putMany([StampStore.fromLegacyEntry('405', { symbol: 'P', time: '' }, { source: 'csv_import' })], { knownRooms: master });

  assert(store.get('1101').time_start === '09:30', 'Legacy/CSVを入れても新捺印表の1101が消えない');
  assert(store.get('801').note === '朝一', 'Legacy/CSVを入れても801の備考が消えない');
  assert(store.get('603').source === 'legacy_time_request' && store.get('603').time_start === '10:00', 'Legacy経路の値も同じ正本に入る');
  assert(store.get('405').source === 'csv_import', 'CSV経路の値も同じ正本に入る');
  assert(Object.keys(store.all()).length === 5, '5室が1つの正本にまとまる');

  // CSVも保存されている(従来は永続化されず、再読込で消えていた)。
  const reloaded = StampStore.createStampStore({ adapters: makeAdapters(local), propertyKey: 'cosmo-joto-noe' });
  await reloaded.loadAll({ knownRooms: master });
  assert(reloaded.get('405').source === 'csv_import', 'CSV取込の値も再読込で復元される');
  assert(reloaded.get('603').time_mode === 'exact' && reloaded.get('603').name === '山田', 'Legacy固有の項目も失わない');
}

// --- 7. 表示用ビュー(旧STAMP_DATA形式)への変換 ---
{
  const local: Backend = { data: {} };
  const store = StampStore.createStampStore({ adapters: makeAdapters(local), propertyKey: 'cosmo-joto-noe' });
  await store.putMany(NEW_OCR_RECORDS, { knownRooms: master, source: 'standardized_stamp_sheet' });
  const view = store.toStampDataView();
  assert(view['1101'].symbol === 'A' && view['1101'].time === '09:30', '描画側が読む形(time)へ変換される');
  assert(view['801'].note === '朝一', '備考も描画側の形へ入る');
  assert(view['802'].needs_review === true && view['802'].review_reason.length === 1, '要確認の理由も渡る');
  assert(view['1102'] === undefined, '予定情報の無い部屋はビューにも現れない');
}

// --- 8. [2026-08-15追加 Phase 2] 項目単位の確定が、保存→復元→描画用ビューまで失われない ---
// 「時刻は確定していて、曖昧なのは備考だけ」という状態を、再読込後も同じ意味のまま扱えること。
// これが失われると、部屋ごと丸ごと要確認に見え、正しく読めた時刻が使われなくなる。
{
  const local: Backend = { data: {} };
  const adapters = makeAdapters(local);
  const store = StampStore.createStampStore({ adapters, propertyKey: 'cosmo-joto-noe' });
  await store.putMany([{
    room: '801', symbol: 'A', time_start: '09:30', time_end: '',
    note: '', note_raw: '辞書に無い語',
    symbol_review: false, time_review: false, note_review: true, other_review: false,
    needs_review: true, review_reason: ['NOTE:NEEDS_REVIEW'],
    raw_checkboxes: { a: true, p: false, cancel: false },
  }], { knownRooms: master, source: 'standardized_stamp_sheet' });

  const saved = store.get('801');
  assert(saved.time_start === '09:30' && saved.time_review === false, '時刻は確定として保持される');
  assert(saved.note === '' && saved.note_raw === '辞書に無い語' && saved.note_review === true, '備考だけが要確認で、原文は残る');
  assert(saved.symbol === 'A' && saved.symbol_review === false, '記号も確定のまま');

  // ページ再読込に相当。
  const reloaded = StampStore.createStampStore({ adapters, propertyKey: 'cosmo-joto-noe' });
  await reloaded.loadAll({ knownRooms: master });
  const r = reloaded.get('801');
  assert(r.time_start === '09:30' && r.time_review === false, '再読込後も時刻は確定のまま');
  assert(r.note_review === true && r.note_raw === '辞書に無い語', '再読込後も「備考だけ要確認」が保たれる');
  assert(r.symbol === 'A' && r.symbol_review === false, '再読込後も記号は確定のまま');

  const view = reloaded.toStampDataView();
  assert(view['801'].time === '09:30', '描画用ビューにも確定した時刻が入る');
  assert(view['801'].note === '', '確定していない備考は表示値にしない');
  assert(view['801'].note_review === true && view['801'].time_review === false, '描画側がどの項目の要確認かを判別できる');
}

// --- 9. 削除 ---
{
  const local: Backend = { data: {} };
  const store = StampStore.createStampStore({ adapters: makeAdapters(local), propertyKey: 'cosmo-joto-noe' });
  await store.putMany(NEW_OCR_RECORDS, { knownRooms: master, source: 'standardized_stamp_sheet' });
  await store.remove('801');
  assert(store.get('801') === null, 'メモリから消える');
  assert(local.data['stamp:cosmo-joto-noe:801'] === undefined, '保存先からも消える');
  assert(store.get('1101') !== null, '他の部屋は消えない');
}

}

main().then(function () {
  console.log('stampStore.test.ts: ALL PASS');
}).catch(function (err) {
  console.error(err);
  process.exit(1);
});
