// [2026-08-16新設 Phase 3] 一括検証が「本当に壊れを検出できる」ことの自己検査。
//
// 【なぜ必要か】
// batchValidation.test.ts は「失敗が0件であること」を固定するテストである。
// 2026-08-16に唯一の欠陥(RENDER_FAIL×6)を修正した結果、全ケースがPASSになった。
// その状態では、判定側が壊れて常に「異常なし」を返すようになっても誰も気づかない。
// つまり「OCR_FAIL=0 NORMALIZE_FAIL=0 PERSIST_FAIL=0 RENDER_FAIL=0」という結果の
// 意味を保証しているものが無い。ここを埋めるのがこのテストである。
//
// 【やり方(新しい仕組みを作らない)】
// 既存の runCase() をそのまま呼ぶ。渡すケース定義だけをメモリ上で1箇所ずつ意図的にずらし、
// 「期待した種類(OCR_FAIL / NORMALIZE_FAIL / RENDER_FAIL)の失敗が、期待した段階で、
// ずらした箇所にだけ現れる」ことを確認する。
// - ケースJSON(Ground Truth)のファイルは一切書き換えない(メモリ上のコピーだけを歪める)
// - 物件名・部屋番号は1つも書かない。対象の部屋・記号・時刻はケースの中身から実行時に選ぶ
// - 実APIは呼ばない(保存済みの生JSONのみ)
//
// 【PERSIST_FAILだけ扱いが違う】
// 保存→復元の比較は「Canonicalと復元結果が同じか」であり、期待値をずらしても到達できない。
// そのため保存内容を1件だけ失わせて、復元と描画にその欠落が現れることを直接確認する
// (runCase() が PERSIST_FAIL を出すときに見ているのと同じ観測点)。

import * as fs from 'fs';
import * as path from 'path';
import { loadCases, runCase, loadMasterRooms, type ValidationCase, type CaseResult, type Finding } from '../../../batch/runBatchValidation';
import { normalizeStandardizedStampScan, type StandardizedStampScanInput } from '../../../../lib/ocr/standardizedStampSheet/normalizeStandardizedStamp';
import { toLiveBoardStampData } from '../../../../lib/ocr/standardizedStampSheet/toLiveBoardStampData';
import { makeLbPage, readRenderedRoom } from '../../../batch/lbSandbox';

const ROOT = path.join(__dirname, '..', '..', '..', '..');

let checks = 0;
function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error('FAIL: ' + msg);
  checks += 1;
  console.log('  OK: ' + msg);
}

function copyCase(def: ValidationCase): ValidationCase {
  return JSON.parse(JSON.stringify(def)) as ValidationCase;
}

/* ずらした1箇所だけが原因で、期待した種類・段階の失敗が出ていることを確認する。
   findings 全体の件数も見て、副作用で別の失敗が湧いていないことまで固定する。 */
function expectDetects(opts: {
  label: string;
  result: CaseResult;
  baseline: CaseResult;
  expectedNewFindings: number;
  match: (f: Finding) => boolean;
}) {
  const { label, result, baseline } = opts;
  assert(result.findings.length === baseline.findings.length + opts.expectedNewFindings,
    label + ': ずらした箇所の数だけ失敗が増える (baseline=' + baseline.findings.length
    + ' actual=' + result.findings.length + ' expected=' + (baseline.findings.length + opts.expectedNewFindings) + ')');
  const hit = result.findings.filter(opts.match);
  assert(hit.length >= 1, label + ': 期待した種類・段階の失敗として検出される'
    + (hit.length ? ' (' + hit[0].kind + ' @' + hit[0].firstBrokenStage + ')' : ' — 検出されなかった: '
      + JSON.stringify(result.findings.map((f) => f.kind + '/' + f.room + '/' + f.field))));
}

/* ケースの中身から、条件に合う部屋を実行時に選ぶ(部屋番号をテスト側に書かないため)。 */
function pickRoom(def: ValidationCase, cond: (r: NonNullable<ValidationCase['expected']['rooms'][string]>) => boolean): string | null {
  return Object.keys(def.expected.rooms).find((room) => cond(def.expected.rooms[room])) || null;
}

async function runForCase(def: ValidationCase, baseline: CaseResult) {
  // --- ① 記号の誤り(OCR raw が支持しない値)を検出できるか ---------------------
  // 同じケースの中に現れる別の記号へ差し替える(記号名をテスト側に書かない)。
  {
    const room = pickRoom(def, (r) => !!r.symbol);
    const symbols = Object.keys(def.expected.rooms)
      .map((r) => String(def.expected.rooms[r].symbol || ''))
      .filter((s) => s !== '');
    const distinct = symbols.filter((s, i) => symbols.indexOf(s) === i);
    if (room && distinct.length >= 2) {
      const other = distinct.find((s) => s !== def.expected.rooms[room].symbol) as string;
      const mutated = copyCase(def);
      mutated.expected.rooms[room].symbol = other;
      expectDetects({
        label: '記号が紙面と違う場合',
        result: await runCase(mutated), baseline, expectedNewFindings: 1,
        match: (f) => f.room === room && f.field === 'symbol' && f.kind === 'OCR_FAIL' && f.firstBrokenStage === 'raw',
      });
    }
  }

  // --- ② 時刻の誤りを検出できるか -------------------------------------------
  // 同じケースに現れる別の時刻へ差し替える(時刻の文字列をテスト側に書かない)。
  {
    const room = pickRoom(def, (r) => !!r.time_start);
    const times = Object.keys(def.expected.rooms)
      .map((r) => String(def.expected.rooms[r].time_start || ''))
      .filter((t) => t !== '');
    const distinct = times.filter((t, i) => times.indexOf(t) === i);
    if (room && distinct.length >= 2) {
      const other = distinct.find((t) => t !== def.expected.rooms[room].time_start) as string;
      const mutated = copyCase(def);
      mutated.expected.rooms[room].time_start = other;
      expectDetects({
        label: '開始時刻が紙面と違う場合',
        result: await runCase(mutated), baseline, expectedNewFindings: 1,
        match: (f) => f.room === room && f.field === 'time_start' && f.kind === 'OCR_FAIL' && f.firstBrokenStage === 'raw',
      });
    }
  }

  // --- ③ 備考(朝一 / 昼一 など)の誤りを検出できるか --------------------------
  {
    const room = pickRoom(def, (r) => !!r.note);
    if (room) {
      const mutated = copyCase(def);
      mutated.expected.rooms[room].note = String(def.expected.rooms[room].note) + '(自己検査用の差分)';
      expectDetects({
        label: '備考が紙面と違う場合',
        result: await runCase(mutated), baseline, expectedNewFindings: 1,
        match: (f) => f.room === room && f.field === 'note' && f.kind === 'OCR_FAIL' && f.firstBrokenStage === 'raw',
      });
    }
  }

  // --- ④ 誤確定(要確認にすべき部屋を確定扱い)を検出できるか -------------------
  {
    const room = pickRoom(def, (r) => !r.needs_review);
    if (room) {
      const mutated = copyCase(def);
      mutated.expected.rooms[room].needs_review = true;
      expectDetects({
        label: '要確認にすべき部屋が確定扱いになっている場合(誤確定)',
        result: await runCase(mutated), baseline, expectedNewFindings: 1,
        match: (f) => f.room === room && f.field === 'needs_review' && f.category === 'missing'
          && f.kind === 'NORMALIZE_FAIL' && f.firstBrokenStage === 'canonical',
      });
    }
  }

  // --- ⑤ false positive(確定できる部屋を要確認にしている)を検出できるか -------
  {
    const room = def.expected.needsReviewRooms[0];
    if (room) {
      const mutated = copyCase(def);
      mutated.expected.needsReviewRooms = mutated.expected.needsReviewRooms.filter((r) => r !== room);
      if (mutated.expected.rooms[room]) mutated.expected.rooms[room].needs_review = false;
      expectDetects({
        label: '確定できる部屋を要確認にしている場合(false positive)',
        result: await runCase(mutated), baseline, expectedNewFindings: 2, // 集合側 + 部屋側
        match: (f) => f.room === room && f.field === 'needs_review' && f.category === 'false_positive'
          && f.kind === 'NORMALIZE_FAIL' && f.firstBrokenStage === 'canonical',
      });
    }
  }

  // --- ⑥ 件数のずれ(取りこぼし)を検出できるか --------------------------------
  {
    const mutated = copyCase(def);
    mutated.expected.skippedRoomCount = def.expected.skippedRoomCount + 1;
    expectDetects({
      label: '取りこぼした部屋の数が期待と違う場合',
      result: await runCase(mutated), baseline, expectedNewFindings: 1,
      match: (f) => f.field === 'skippedRoomCount' && f.category === 'count_mismatch'
        && f.kind === 'NORMALIZE_FAIL' && f.firstBrokenStage === 'canonical',
    });
  }

  // --- ⑦ 描画の読み取りが本当に効いているか ----------------------------------
  // 「捺印表に無いはずの部屋」として、実際には予定が表示されている部屋を指定する。
  // 部屋カードから値を読めていなければ、この失敗は出ない(＝RENDER段階が空検査になっている)。
  {
    const room = pickRoom(def, (r) => !!r.symbol);
    if (room) {
      const mutated = copyCase(def);
      mutated.expected.roomsNotInStamp = mutated.expected.roomsNotInStamp.concat([room]);
      expectDetects({
        label: '予定が表示されている部屋を「捺印表に無い部屋」とした場合',
        result: await runCase(mutated), baseline, expectedNewFindings: 2, // Canonical側 + 描画側
        match: (f) => f.room === room && f.kind === 'RENDER_FAIL' && f.firstBrokenStage === 'render',
      });
    }
  }
}

// ---------------------------------------------------------------------------
// PERSIST段階: 保存内容を1件失わせ、復元と描画にその欠落が現れることを確認する。
// (期待値の書き換えでは到達できない段階なので、ここだけ経路を直接動かす)
// ---------------------------------------------------------------------------
async function checkPersistStageObservable(def: ValidationCase) {
  const rawJson = JSON.parse(fs.readFileSync(path.join(ROOT, def.rawScanPath), 'utf8')) as StandardizedStampScanInput;
  const canonical = toLiveBoardStampData(normalizeStandardizedStampScan(rawJson));
  const masterRooms = loadMasterRooms(path.join(ROOT, def.masterRoomsPath));

  const persisted: Record<string, string> = {};
  const scanPage = makeLbPage({ propertyName: def.propertyName, masterRooms, persisted });
  scanPage.applyStandardizedStampDataToLb(canonical.stampData);

  const keys = Object.keys(persisted);
  assert(keys.length > 0, def.caseId + ' / 保存段階: 予定情報が保存先へ書き込まれている');

  // 保存先から1件だけ消す(保存層が値を失った状況の再現。部屋は保存キーから実行時に取る)。
  const lostKey = keys[keys.length - 1];
  const lostRoom = lostKey.slice(lostKey.lastIndexOf(':') + 1);
  delete persisted[lostKey];

  const reloadPage = makeLbPage({ propertyName: def.propertyName, masterRooms, persisted });
  reloadPage.clearDemoStampDataForPropertyChange();
  await reloadPage.restoreStampDataFromStorage();

  assert(canonical.stampData[lostRoom] !== undefined,
    def.caseId + ' / PERSIST段階: 消した部屋はCanonicalには存在する');
  assert(reloadPage.stampData()[lostRoom] === undefined,
    def.caseId + ' / PERSIST段階: 保存内容が欠けると復元結果にも現れない(欠落を観測できる)');

  const rendered = readRenderedRoom(reloadPage.floorsHtml(), lostRoom);
  assert(rendered.exists, def.caseId + ' / PERSIST段階: MASTER由来の部屋カード自体は残る(OCRでMASTERを作り替えていない)');
  assert(!rendered.symbol && !rendered.timeDisplay,
    def.caseId + ' / PERSIST段階: 失われた予定は部屋カードにも出ない(描画の読み取りが実データを見ている)');
}

async function main() {
  const cases = loadCases();
  assert(cases.length >= 1, '検証ケースが1件以上登録されている');

  for (const def of cases) {
    console.log('--- ' + def.caseId + ' の自己検査 ---');
    const baseline = await runCase(def);
    assert(!baseline.preconditionError, def.caseId + ': 前提が崩れていない');
    // ここが0でないと「1箇所ずらした結果だけを見る」ことができない。
    assert(baseline.findings.length === 0,
      def.caseId + ': ずらす前は失敗0件 (got ' + baseline.findings.length + ')');
    await runForCase(def, baseline);
    await checkPersistStageObservable(def);
  }

  console.log('batchValidationSelfCheck.test.ts: ' + checks + '件の確認');
  console.log('batchValidationSelfCheck.test.ts: ALL PASS');
}

main().catch((err) => { console.error(err); process.exit(1); });
