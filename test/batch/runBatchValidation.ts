// test/batch/runBatchValidation.ts
//
// [2026-08-15新設 Phase 3 複数物件一括OCR検証基盤]
// 保存済みのOCR生JSON(実画像を実APIへ通した結果)を物件ごとに登録しておき、
//
//   実OCR raw → normalize → Canonical → StampStore保存 → 復元 → Live Board描画
//
// を1物件ずつ通して、期待値(Ground Truth)から最初に値が変化した段階を特定する。
//
// 【なぜこれを作るか】
// これまでは物件1件ぶんの回帰テストが個別ファイルに手書きされており、物件が増えるたびに
// テストを1本ずつ書き足す必要があった。Phase 3で必要なのは「失敗がどの段階で起きたかを
// 一覧で判断できること」なので、判定の中身は既存モジュールをそのまま呼び、
// 物件リストを回して結果を並べるだけの薄い層にしている。
//
// 【この層が絶対にしないこと】
// - 新しいOCR・新しいCanonical・新しいStampStore・新しい保存経路を作らない
//   (normalizeStandardizedStampScan / toLiveBoardStampData / public/stamp_store/stamp_store.js /
//    public/index.html の実関数を、実際の経路と同じ順序でそのまま呼ぶ)
// - 物件別ルール・部屋番号のハードコードを持たない(判定はすべてケースJSONのデータ駆動)
// - Ground Truth を実装の出力へ合わせて書き換えない
// - 実APIを呼ばない(保存済みの生JSONだけを使うので課金は発生しない)
//
// 実行: npm run validate:batch  (レポートは /stamp-batch-reports/ へ出力。.gitignore済み)

import * as fs from 'fs';
import * as path from 'path';
import { normalizeStandardizedStampScan, type StandardizedStampScanInput } from '../../lib/ocr/standardizedStampSheet/normalizeStandardizedStamp';
import { toLiveBoardStampData } from '../../lib/ocr/standardizedStampSheet/toLiveBoardStampData';
import { makeLbPage, readRenderedRoom, expectedTimeDisplay, type RenderedRoom } from './lbSandbox';

const ROOT = path.join(__dirname, '..', '..');
const CASES_DIR = path.join(ROOT, 'test', 'fixtures', 'standardizedStampSheet', 'cases');

// ---------------------------------------------------------------------------
// ケース定義(test/fixtures/standardizedStampSheet/cases/*.json)
// ---------------------------------------------------------------------------

export type ExpectedRoom = {
  symbol?: string;
  time_start?: string;
  time_end?: string;
  note?: string;
  needs_review?: boolean;
};

export type ValidationCase = {
  caseId: string;
  propertyName: string;
  rawScanPath: string;
  masterRoomsPath: string;
  note?: string;
  expected: {
    masterRoomCount: number;
    ocrRoomCount: number;
    needsReviewRooms: string[];
    skippedRoomCount: number;
    unassignedTimeDesignationRowCount: number;
    roomsNotInStamp: string[];
    rooms: Record<string, ExpectedRoom>;
  };
};

// ---------------------------------------------------------------------------
// 判定結果
// ---------------------------------------------------------------------------

export type FailureKind = 'OCR_FAIL' | 'NORMALIZE_FAIL' | 'PERSIST_FAIL' | 'RENDER_FAIL';
export type StageName = 'raw' | 'canonical' | 'restored' | 'render';

export type Finding = {
  caseId: string;
  // 部屋番号。物件全体に関する指摘は空文字。
  room: string;
  field: string;
  category: 'value_mismatch' | 'missing' | 'false_positive' | 'count_mismatch' | 'cross_stage';
  kind: FailureKind;
  // 期待値から最初に値が変わった段階。
  firstBrokenStage: StageName;
  expected: string;
  raw: string;
  canonical: string;
  restored: string;
  render: string;
  detail: string;
};

export type CaseResult = {
  caseId: string;
  propertyName: string;
  ok: boolean;
  // 前提(MASTERの室数など)が崩れている場合の理由。値が入っていれば判定は行わない。
  preconditionError: string | null;
  counts: {
    masterRooms: number;
    rawRooms: number;
    canonicalRooms: number;
    restoredRooms: number;
    renderedCards: number;
    groundTruthRooms: number;
    needsReviewRooms: number;
    skippedRooms: number;
    unassignedTimeDesignationRows: number;
    checkedFields: number;
  };
  failures: Record<FailureKind, number>;
  findings: Finding[];
};

export type BatchReport = {
  cases: CaseResult[];
  totals: Record<FailureKind, number>;
  ok: boolean;
};

const EMPTY_FAILURES = (): Record<FailureKind, number> =>
  ({ OCR_FAIL: 0, NORMALIZE_FAIL: 0, PERSIST_FAIL: 0, RENDER_FAIL: 0 });

// ---------------------------------------------------------------------------
// OCR raw から「その情報が読めていたか」を見るための最小の読み出し。
// 【重要】ここは OCR_FAIL と NORMALIZE_FAIL を切り分けるためだけの参照であり、
// ここで読んだ値をCanonicalへ入れることは絶対にしない(正式経路は normalize 側だけ)。
// ---------------------------------------------------------------------------

type RawScan = {
  rooms?: Array<{ room_number?: string; raw_checkboxes?: Record<string, unknown> }>;
  time_designation_rows?: Array<{
    room_number_cells?: Array<string | null>;
    start_time_cells?: Array<string | null>;
    end_time_cells?: Array<string | null>;
    remarks_raw?: string;
  }>;
};

function digitsOf(cells: Array<string | null> | undefined): string {
  return (cells || []).map((c) => String(c === null || c === undefined ? '' : c))
    .filter((c) => /^[0-9]$/.test(c)).join('');
}

function cellsAsSeen(cells: Array<string | null> | undefined): string {
  if (!cells) return '';
  return cells.map((c) => {
    const t = String(c === null || c === undefined ? '' : c);
    return t === '' ? '_' : t;
  }).join('');
}

/* 時刻マスが期待値を支持しているか。
   帳票は1マス1文字で、「時」の十の位が空欄のことがある(9:30 が [_][9][3][0])。
   先頭の0/空欄の違いだけであれば「読めている」と見なす(0補完の判断は normalize 側の責務)。 */
function timeCellsSupport(expected: string, cells: Array<string | null> | undefined): boolean {
  if (!expected) return true;
  const strip = (s: string) => s.replace(/^0+/, '');
  return strip(expected.replace(':', '')) === strip(digitsOf(cells));
}

function rawRoomRow(raw: RawScan, room: string) {
  return (raw.time_designation_rows || []).find((r) => digitsOf(r.room_number_cells) === room) || null;
}

function rawCheckboxes(raw: RawScan, room: string) {
  const hit = (raw.rooms || []).find((r) => String(r.room_number) === room);
  return hit ? (hit.raw_checkboxes || {}) : null;
}

function checkedCount(cb: Record<string, unknown>): number {
  return [cb.a_checked, cb.p_checked, cb.cancel_checked].filter(Boolean).length;
}

/* 記号マスが期待値を支持しているか。
   期待値が空文字(=紙面上どちらとも決められない)の場合は、複数チェック/未チェックであることが
   「正しく読めている」状態にあたる。 */
function symbolCellsSupport(expected: string, cb: Record<string, unknown> | null): boolean {
  if (!cb) return false;
  const n = checkedCount(cb);
  if (!expected) return n !== 1;
  if (n !== 1) return false;
  if (expected === 'A') return !!cb.a_checked;
  if (expected === 'P') return !!cb.p_checked;
  if (expected === 'キャンセル') return !!cb.cancel_checked;
  return false;
}

// ---------------------------------------------------------------------------
// ケース1件の実行
// ---------------------------------------------------------------------------

type StageValues = {
  symbol: string;
  time_start: string;
  time_end: string;
  note: string;
  note_raw: string;
  needs_review: boolean;
};

const EMPTY_STAGE: StageValues = { symbol: '', time_start: '', time_end: '', note: '', note_raw: '', needs_review: false };

function asText(v: unknown): string { return v === null || v === undefined ? '' : String(v); }

function stageOfCanonical(entry: Record<string, unknown> | undefined): StageValues {
  if (!entry) return EMPTY_STAGE;
  return {
    symbol: asText(entry.symbol),
    time_start: asText(entry.time_start),
    time_end: asText(entry.time_end),
    note: asText(entry.note),
    note_raw: asText(entry.note_raw),
    needs_review: !!entry.needs_review,
  };
}

/* 復元後のSTAMP_DATA(描画用の派生ビュー)は time というキー名で開始時刻を持つ。 */
function stageOfRestored(entry: Record<string, unknown> | undefined): StageValues {
  if (!entry) return EMPTY_STAGE;
  return {
    symbol: asText(entry.symbol),
    time_start: asText(entry.time !== undefined ? entry.time : entry.time_start),
    time_end: asText(entry.time_end),
    note: asText(entry.note),
    note_raw: asText(entry.note_raw),
    needs_review: !!entry.needs_review,
  };
}

export function loadMasterRooms(absPath: string): string[] {
  const parsed = JSON.parse(fs.readFileSync(absPath, 'utf8'));
  if (Array.isArray(parsed)) return parsed.map((r) => String(r));
  return Object.keys(parsed).map((r) => String(r));
}

export function loadCases(): ValidationCase[] {
  if (!fs.existsSync(CASES_DIR)) return [];
  return fs.readdirSync(CASES_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(CASES_DIR, f), 'utf8')) as ValidationCase);
}

export async function runCase(def: ValidationCase): Promise<CaseResult> {
  const findings: Finding[] = [];
  const add = (f: Omit<Finding, 'caseId'>) => { findings.push({ caseId: def.caseId, ...f }); };

  // 実APIが返した生JSONそのもの。正式経路(normalize)へ渡す値と、OCR_FAIL切り分け用に
  // 参照する値は同一のオブジェクトで、ここで加工は一切しない。
  const rawJson = JSON.parse(fs.readFileSync(path.join(ROOT, def.rawScanPath), 'utf8')) as StandardizedStampScanInput;
  const raw = rawJson as RawScan;
  const masterRooms = loadMasterRooms(path.join(ROOT, def.masterRoomsPath));
  const rawRoomCount = (raw.rooms || []).length;

  const base = {
    caseId: def.caseId,
    propertyName: def.propertyName,
    counts: {
      masterRooms: masterRooms.length,
      rawRooms: rawRoomCount,
      canonicalRooms: 0,
      restoredRooms: 0,
      renderedCards: 0,
      groundTruthRooms: Object.keys(def.expected.rooms).length,
      needsReviewRooms: 0,
      skippedRooms: 0,
      unassignedTimeDesignationRows: 0,
      checkedFields: 0,
    },
  };

  // MASTERはExcel由来の正本。室数が想定と違う場合、以降の判定は意味を持たないので止める。
  if (masterRooms.length !== def.expected.masterRoomCount) {
    return {
      ...base, ok: false,
      preconditionError: 'MASTER室数が期待と異なる: expected=' + def.expected.masterRoomCount + ' actual=' + masterRooms.length,
      failures: EMPTY_FAILURES(), findings: [],
    };
  }

  // --- 正式経路をそのまま通す ---
  const normalized = normalizeStandardizedStampScan(rawJson);
  const canonical = toLiveBoardStampData(normalized);

  const persisted: Record<string, string> = {};
  const scanPage = makeLbPage({ propertyName: def.propertyName, masterRooms, persisted });
  scanPage.applyStandardizedStampDataToLb(canonical.stampData);
  const scanHtml = scanPage.floorsHtml();

  // ページ再読込に相当(メモリを全て捨て、保存先からの復元だけで描画する)。
  const reloadPage = makeLbPage({ propertyName: def.propertyName, masterRooms, persisted });
  reloadPage.clearDemoStampDataForPropertyChange();
  await reloadPage.restoreStampDataFromStorage();
  const restoredStampData = reloadPage.stampData();
  const reloadHtml = reloadPage.floorsHtml();

  base.counts.canonicalRooms = Object.keys(canonical.stampData).length;
  base.counts.restoredRooms = Object.keys(restoredStampData).length;
  base.counts.renderedCards = (reloadHtml.match(/class="room-card /g) || []).length;
  base.counts.needsReviewRooms = canonical.needsReviewRooms.length;
  base.counts.skippedRooms = canonical.skippedRooms.length;
  base.counts.unassignedTimeDesignationRows = canonical.unassignedTimeDesignationRowCount;

  // -------------------------------------------------------------------------
  // ① 物件全体の件数(OCR対象室数・取りこぼし・要確認・未割当の時間指定)
  // -------------------------------------------------------------------------
  const countCheck = (field: string, expected: number, actual: number, kind: FailureKind, stage: StageName, detail: string) => {
    if (expected === actual) return;
    add({
      room: '', field, category: 'count_mismatch', kind, firstBrokenStage: stage,
      expected: String(expected), raw: '', canonical: '', restored: '', render: '', detail: detail + ' (actual=' + actual + ')',
    });
  };

  countCheck('ocrRoomCount(raw)', def.expected.ocrRoomCount, rawRoomCount, 'OCR_FAIL', 'raw',
    'OCRが返した室数が期待と違う');
  if (rawRoomCount === def.expected.ocrRoomCount) {
    countCheck('ocrRoomCount(canonical)', def.expected.ocrRoomCount, base.counts.canonicalRooms, 'NORMALIZE_FAIL', 'canonical',
      'rawは期待室数だがCanonicalで増減した');
  }
  countCheck('skippedRoomCount', def.expected.skippedRoomCount, base.counts.skippedRooms, 'NORMALIZE_FAIL', 'canonical',
    '取りこぼした部屋の数が期待と違う');
  countCheck('unassignedTimeDesignationRowCount', def.expected.unassignedTimeDesignationRowCount,
    base.counts.unassignedTimeDesignationRows, 'NORMALIZE_FAIL', 'canonical',
    '部屋を特定できなかった時間指定行の数が期待と違う');
  countCheck('masterRoomsRendered', def.expected.masterRoomCount, base.counts.renderedCards, 'RENDER_FAIL', 'render',
    'MASTERの部屋数が描画で維持されていない(OCRでMASTERを作り替えていないか)');
  countCheck('restoredRoomCount', base.counts.canonicalRooms, base.counts.restoredRooms, 'PERSIST_FAIL', 'restored',
    '保存→復元で室数が変わった');

  // 要確認の集合(false positive / 見落とし)。
  {
    const want = def.expected.needsReviewRooms.slice().sort();
    const got = canonical.needsReviewRooms.slice().sort();
    got.filter((r) => want.indexOf(r) === -1).forEach((room) => {
      add({
        room, field: 'needs_review', category: 'false_positive', kind: 'NORMALIZE_FAIL', firstBrokenStage: 'canonical',
        expected: 'false', raw: '', canonical: 'true', restored: '', render: '',
        detail: '要確認にする必要が無い部屋を要確認にしている(false positive)',
      });
    });
    want.filter((r) => got.indexOf(r) === -1).forEach((room) => {
      add({
        room, field: 'needs_review', category: 'missing', kind: 'NORMALIZE_FAIL', firstBrokenStage: 'canonical',
        expected: 'true', raw: '', canonical: 'false', restored: '', render: '',
        detail: '要確認にすべき部屋が確定扱いになっている(誤確定)',
      });
    });
  }

  // 捺印表に印字が無い部屋を、OCRから作っていないこと(MASTER/DELTAの原則)。
  def.expected.roomsNotInStamp.forEach((room) => {
    if (canonical.stampData[room] !== undefined) {
      add({
        room, field: 'roomsNotInStamp', category: 'value_mismatch', kind: 'NORMALIZE_FAIL', firstBrokenStage: 'canonical',
        expected: '(予定情報なし)', raw: '', canonical: JSON.stringify(canonical.stampData[room]), restored: '', render: '',
        detail: '捺印表に無い部屋にOCRから予定情報を作っている',
      });
    }
    const rendered = readRenderedRoom(reloadHtml, room);
    if (!rendered.exists) {
      add({
        room, field: 'roomsNotInStamp', category: 'missing', kind: 'RENDER_FAIL', firstBrokenStage: 'render',
        expected: '(部屋カードは在る)', raw: '', canonical: '', restored: '', render: '(カード無し)',
        detail: 'MASTERにある部屋の部屋カードが描画されていない',
      });
    } else if (rendered.symbol || rendered.timeDisplay) {
      add({
        room, field: 'roomsNotInStamp', category: 'value_mismatch', kind: 'RENDER_FAIL', firstBrokenStage: 'render',
        expected: '(表示なし)', raw: '', canonical: '', restored: '',
        render: rendered.symbol + '|' + rendered.timeDisplay,
        detail: '捺印表に無い部屋に予定情報が表示されている',
      });
    }
  });

  // -------------------------------------------------------------------------
  // ② Ground Truth のある部屋: 期待値から最初に値が変わった段階を特定する
  // -------------------------------------------------------------------------
  const FIELD_LABELS: Array<'symbol' | 'time_start' | 'time_end' | 'note'> = ['symbol', 'time_start', 'time_end', 'note'];

  Object.keys(def.expected.rooms).forEach((room) => {
    const want = def.expected.rooms[room];
    const can = stageOfCanonical(canonical.stampData[room]);
    const res = stageOfRestored(restoredStampData[room]);
    const renderScan = readRenderedRoom(scanHtml, room);
    const renderReload = readRenderedRoom(reloadHtml, room);
    const row = rawRoomRow(raw, room);
    const cb = rawCheckboxes(raw, room);

    if (canonical.stampData[room] === undefined) {
      add({
        room, field: 'room', category: 'missing', kind: cb ? 'NORMALIZE_FAIL' : 'OCR_FAIL',
        firstBrokenStage: cb ? 'canonical' : 'raw',
        expected: '(Canonicalに存在する)', raw: cb ? '(rawには在る)' : '(rawに無い)',
        canonical: '(無し)', restored: '', render: '',
        detail: cb ? 'rawには読めているのにCanonicalから消えている(読み飛ばし)' : 'OCRがこの部屋を返していない(読み飛ばし)',
      });
      base.counts.checkedFields += 1;
      return;
    }

    FIELD_LABELS.forEach((field) => {
      const expectedValue = asText(want[field]);
      base.counts.checkedFields += 1;

      // rawがこの期待値を支持しているか(OCR_FAILとNORMALIZE_FAILの切り分け)。
      let rawShown = '';
      let rawSupports = true;
      if (field === 'symbol') {
        rawShown = cb ? ['a', 'p', 'キャンセル'].filter((_, i) => [cb.a_checked, cb.p_checked, cb.cancel_checked][i]).join('+') || '(未チェック)' : '(rawに無し)';
        rawSupports = symbolCellsSupport(expectedValue, cb);
      } else if (field === 'time_start' || field === 'time_end') {
        const cells = field === 'time_start' ? row?.start_time_cells : row?.end_time_cells;
        rawShown = row ? cellsAsSeen(cells) : '(該当行なし)';
        rawSupports = expectedValue ? (!!row && timeCellsSupport(expectedValue, cells)) : true;
      } else {
        rawShown = row ? asText(row.remarks_raw) : '(該当行なし)';
        rawSupports = expectedValue ? (!!row && asText(row.remarks_raw).trim() === expectedValue) : true;
      }

      const canonicalValue = can[field];
      const restoredValue = res[field];
      const renderValue = field === 'symbol' ? renderReload.symbol
        : field === 'note' ? renderReload.note
          : ''; // 時刻は timeDisplay としてまとめて後段で見る

      const record = (kind: FailureKind, stage: StageName, detail: string) => {
        add({
          room, field, category: 'value_mismatch', kind, firstBrokenStage: stage,
          expected: expectedValue || '(なし)', raw: rawShown,
          canonical: canonicalValue || '(なし)', restored: restoredValue || '(なし)', render: renderValue || '(なし)',
          detail,
        });
      };

      if (!rawSupports) { record('OCR_FAIL', 'raw', 'OCRの生出力に期待した値が現れていない'); return; }
      if (canonicalValue !== expectedValue) { record('NORMALIZE_FAIL', 'canonical', 'rawには読めているのにCanonicalで期待値と違う'); return; }
      if (restoredValue !== canonicalValue) { record('PERSIST_FAIL', 'restored', '保存→復元で値が変わった'); return; }
      if (field === 'symbol' && renderReload.symbol !== expectedValue) { record('RENDER_FAIL', 'render', '再読込後の部屋カードに記号が出ていない'); return; }
      if (field === 'symbol' && renderScan.symbol !== expectedValue) { record('RENDER_FAIL', 'render', '読み取り直後の部屋カードに記号が出ていない'); return; }
      if (field === 'note' && expectedValue && renderReload.note !== expectedValue) { record('RENDER_FAIL', 'render', '再読込後の部屋カードに備考が出ていない'); return; }
      if (field === 'note' && expectedValue && renderScan.note !== expectedValue) { record('RENDER_FAIL', 'render', '読み取り直後の部屋カードに備考が出ていない'); }
    });

    // 時刻の「時間帯」表示(単発 / 範囲)は、開始・終了を合わせた1つの表示として確認する。
    {
      const wantDisplay = expectedTimeDisplay(asText(want.time_start), asText(want.time_end));
      base.counts.checkedFields += 1;
      const timesConfirmed = can.time_start === asText(want.time_start) && can.time_end === asText(want.time_end);
      if (timesConfirmed && renderReload.timeDisplay !== wantDisplay) {
        add({
          room, field: 'timeDisplay', category: 'value_mismatch', kind: 'RENDER_FAIL', firstBrokenStage: 'render',
          expected: wantDisplay || '(なし)', raw: '', canonical: expectedTimeDisplay(can.time_start, can.time_end) || '(なし)',
          restored: expectedTimeDisplay(res.time_start, res.time_end) || '(なし)', render: renderReload.timeDisplay || '(なし)',
          detail: '再読込後の部屋カードの時間帯表示が期待と違う',
        });
      } else if (timesConfirmed && renderScan.timeDisplay !== wantDisplay) {
        add({
          room, field: 'timeDisplay', category: 'value_mismatch', kind: 'RENDER_FAIL', firstBrokenStage: 'render',
          expected: wantDisplay || '(なし)', raw: '', canonical: expectedTimeDisplay(can.time_start, can.time_end) || '(なし)',
          restored: expectedTimeDisplay(res.time_start, res.time_end) || '(なし)', render: renderScan.timeDisplay || '(なし)',
          detail: '読み取り直後の部屋カードの時間帯表示が期待と違う',
        });
      }
    }

    // 要確認フラグ(誤確定 / false positive を部屋単位でも見る)。
    {
      const wantReview = !!want.needs_review;
      base.counts.checkedFields += 1;
      if (can.needs_review !== wantReview) {
        add({
          room, field: 'needs_review', category: wantReview ? 'missing' : 'false_positive',
          kind: 'NORMALIZE_FAIL', firstBrokenStage: 'canonical',
          expected: String(wantReview), raw: '', canonical: String(can.needs_review),
          restored: String(res.needs_review), render: String(renderReload.reviewBadge),
          detail: wantReview ? '要確認にすべき部屋が確定扱いになっている' : '確定できている部屋を要確認にしている',
        });
      } else if (res.needs_review !== can.needs_review) {
        add({
          room, field: 'needs_review', category: 'value_mismatch', kind: 'PERSIST_FAIL', firstBrokenStage: 'restored',
          expected: String(wantReview), raw: '', canonical: String(can.needs_review),
          restored: String(res.needs_review), render: String(renderReload.reviewBadge),
          detail: '保存→復元で要確認の状態が変わった',
        });
      } else if (renderReload.reviewBadge !== wantReview) {
        add({
          room, field: 'needs_review', category: 'value_mismatch', kind: 'RENDER_FAIL', firstBrokenStage: 'render',
          expected: String(wantReview), raw: '', canonical: String(can.needs_review),
          restored: String(res.needs_review), render: String(renderReload.reviewBadge),
          detail: '要確認バッジの表示が期待と違う',
        });
      }
    }
  });

  // -------------------------------------------------------------------------
  // ③ Ground Truth の無い部屋: 段階間で値が変わっていないことだけを確認する
  //    (紙面の正解が無くても「保存・復元・描画で消える/化ける」は検出できる)
  // -------------------------------------------------------------------------
  Object.keys(canonical.stampData).forEach((room) => {
    if (def.expected.rooms[room]) return; // GTのある部屋は②で見ている
    const can = stageOfCanonical(canonical.stampData[room]);
    const res = stageOfRestored(restoredStampData[room]);
    base.counts.checkedFields += 1;

    /* Ground Truthが無いので「前段と同じ値のままか」だけを見る。
       値が変わっていれば、変わった段階がそのまま最初に壊れた段階になる。 */
    const crossStage = (field: string, a: string, b: string, kind: FailureKind, stage: StageName, detail: string) => {
      if (a === b) return;
      add({
        room, field, category: 'cross_stage', kind, firstBrokenStage: stage,
        expected: a || '(なし)', raw: '', canonical: a || '(なし)', restored: b || '(なし)', render: '', detail,
      });
    };

    if (restoredStampData[room] === undefined) {
      add({
        room, field: 'room', category: 'missing', kind: 'PERSIST_FAIL', firstBrokenStage: 'restored',
        expected: '(復元される)', raw: '', canonical: '(あり)', restored: '(無し)', render: '',
        detail: 'Canonicalにある部屋が保存→復元で失われた',
      });
      return;
    }
    crossStage('symbol', can.symbol, res.symbol, 'PERSIST_FAIL', 'restored', '保存→復元で記号が変わった');
    crossStage('time_start', can.time_start, res.time_start, 'PERSIST_FAIL', 'restored', '保存→復元で開始時刻が変わった');
    crossStage('time_end', can.time_end, res.time_end, 'PERSIST_FAIL', 'restored', '保存→復元で終了時刻が変わった');
    crossStage('note', can.note, res.note, 'PERSIST_FAIL', 'restored', '保存→復元で備考が変わった');
    crossStage('note_raw', can.note_raw, res.note_raw, 'PERSIST_FAIL', 'restored', '保存→復元で備考の原文が変わった');
    crossStage('needs_review', String(can.needs_review), String(res.needs_review), 'PERSIST_FAIL', 'restored', '保存→復元で要確認の状態が変わった');

    const renderCheck = (rendered: RenderedRoom, phase: string) => {
      if (!rendered.exists) {
        add({
          room, field: 'room', category: 'missing', kind: 'RENDER_FAIL', firstBrokenStage: 'render',
          expected: '(部屋カードが在る)', raw: '', canonical: '(あり)', restored: '(あり)', render: '(カード無し)',
          detail: phase + ': 部屋カードが描画されていない',
        });
        return;
      }
      if (rendered.symbol !== res.symbol) {
        add({
          room, field: 'symbol', category: 'cross_stage', kind: 'RENDER_FAIL', firstBrokenStage: 'render',
          expected: res.symbol || '(なし)', raw: '', canonical: can.symbol || '(なし)', restored: res.symbol || '(なし)',
          render: rendered.symbol || '(なし)', detail: phase + ': 復元した記号が部屋カードに出ていない',
        });
      }
      const wantDisplay = expectedTimeDisplay(res.time_start, res.time_end);
      // 記号が確定していない部屋では時刻表示が記号欄に入る仕様のため、どちらの欄で出ていても可とする。
      if (rendered.timeDisplay !== wantDisplay) {
        add({
          room, field: 'timeDisplay', category: 'cross_stage', kind: 'RENDER_FAIL', firstBrokenStage: 'render',
          expected: wantDisplay || '(なし)', raw: '', canonical: expectedTimeDisplay(can.time_start, can.time_end) || '(なし)',
          restored: wantDisplay || '(なし)', render: rendered.timeDisplay || '(なし)',
          detail: phase + ': 復元した時刻が部屋カードに出ていない',
        });
      }
      const wantNote = res.note || res.note_raw;
      if (rendered.note !== wantNote) {
        add({
          room, field: 'note', category: 'cross_stage', kind: 'RENDER_FAIL', firstBrokenStage: 'render',
          expected: wantNote || '(なし)', raw: '', canonical: can.note || can.note_raw || '(なし)',
          restored: wantNote || '(なし)', render: rendered.note || '(なし)',
          detail: phase + ': 復元した備考が部屋カードに出ていない',
        });
      }
      if (rendered.reviewBadge !== res.needs_review) {
        add({
          room, field: 'needs_review', category: 'cross_stage', kind: 'RENDER_FAIL', firstBrokenStage: 'render',
          expected: String(res.needs_review), raw: '', canonical: String(can.needs_review), restored: String(res.needs_review),
          render: String(rendered.reviewBadge), detail: phase + ': 要確認バッジの表示が復元した状態と違う',
        });
      }
    };
    renderCheck(readRenderedRoom(reloadHtml, room), '再読込後');
    renderCheck(readRenderedRoom(scanHtml, room), '読み取り直後');
  });

  const failures = EMPTY_FAILURES();
  findings.forEach((f) => { failures[f.kind] += 1; });

  return { ...base, ok: findings.length === 0, preconditionError: null, failures, findings };
}

export async function runBatchValidation(): Promise<BatchReport> {
  const cases = loadCases();
  const results: CaseResult[] = [];
  for (const def of cases) {
    // 1件のケースが壊れていても(ファイルの置き忘れ・JSONの記述ミス等)、残りの物件の
    // 一覧が見られなくならないようにする。物件が増えるほどここで止まる損失が大きいため。
    try {
      results.push(await runCase(def));
    } catch (err) {
      results.push({
        caseId: def.caseId || '(caseId未設定)',
        propertyName: def.propertyName || '',
        ok: false,
        preconditionError: 'ケースを実行できなかった: ' + (err instanceof Error ? err.message : String(err)),
        counts: {
          masterRooms: 0, rawRooms: 0, canonicalRooms: 0, restoredRooms: 0, renderedCards: 0,
          groundTruthRooms: 0, needsReviewRooms: 0, skippedRooms: 0,
          unassignedTimeDesignationRows: 0, checkedFields: 0,
        },
        failures: EMPTY_FAILURES(),
        findings: [],
      });
    }
  }
  const totals = EMPTY_FAILURES();
  results.forEach((r) => {
    (Object.keys(totals) as FailureKind[]).forEach((k) => { totals[k] += r.failures[k]; });
  });
  return { cases: results, totals, ok: results.every((r) => r.ok && !r.preconditionError) };
}

// ---------------------------------------------------------------------------
// 出力(既存の ocr:compare と同じく、リポジトリ直下の .gitignore 済みディレクトリへ)
// ---------------------------------------------------------------------------

const CSV_COLUMNS: Array<keyof Finding> = [
  'caseId', 'room', 'field', 'category', 'kind', 'firstBrokenStage',
  'expected', 'raw', 'canonical', 'restored', 'render', 'detail',
];

export function toCsv(report: BatchReport): string {
  const esc = (v: string) => '"' + String(v).replace(/"/g, '""') + '"';
  const lines = [CSV_COLUMNS.join(',')];
  report.cases.forEach((c) => {
    c.findings.forEach((f) => { lines.push(CSV_COLUMNS.map((col) => esc(asText(f[col]))).join(',')); });
  });
  return lines.join('\n') + '\n';
}

function printConsole(report: BatchReport) {
  console.log('=== Batch OCR Validation (新捺印表 → Live Board) ===');
  console.log('登録ケース数: ' + report.cases.length);
  report.cases.forEach((c) => {
    console.log('');
    console.log('--- ' + c.caseId + ' / ' + c.propertyName + ' ---');
    if (c.preconditionError) { console.log('  前提エラー: ' + c.preconditionError); return; }
    const n = c.counts;
    console.log('  MASTER室数=' + n.masterRooms + ' / OCR対象室数(raw)=' + n.rawRooms
      + ' / Canonical=' + n.canonicalRooms + ' / 復元=' + n.restoredRooms + ' / 描画カード=' + n.renderedCards);
    console.log('  要確認=' + n.needsReviewRooms + ' / 取りこぼし=' + n.skippedRooms
      + ' / 未割当の時間指定行=' + n.unassignedTimeDesignationRows
      + ' / Ground Truth室数=' + n.groundTruthRooms + ' / 判定項目数=' + n.checkedFields);
    console.log('  OCR_FAIL=' + c.failures.OCR_FAIL + ' NORMALIZE_FAIL=' + c.failures.NORMALIZE_FAIL
      + ' PERSIST_FAIL=' + c.failures.PERSIST_FAIL + ' RENDER_FAIL=' + c.failures.RENDER_FAIL);
    if (!c.findings.length) { console.log('  結果: PASS'); return; }
    console.log('  結果: FAIL (最初に値が変わった段階の一覧)');
    c.findings.forEach((f) => {
      console.log('    [' + f.kind + '] ' + (f.room || '(物件全体)') + ' ' + f.field
        + ' | 期待=' + f.expected + ' raw=' + f.raw + ' canonical=' + f.canonical
        + ' restored=' + f.restored + ' render=' + f.render + ' | ' + f.detail);
    });
  });
  console.log('');
  console.log('=== 合計 === OCR_FAIL=' + report.totals.OCR_FAIL + ' NORMALIZE_FAIL=' + report.totals.NORMALIZE_FAIL
    + ' PERSIST_FAIL=' + report.totals.PERSIST_FAIL + ' RENDER_FAIL=' + report.totals.RENDER_FAIL);
  console.log(report.ok ? '総合判定: PASS' : '総合判定: FAIL');
}

async function main() {
  const report = await runBatchValidation();
  printConsole(report);

  const outDir = path.join(process.cwd(), 'stamp-batch-reports');
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.writeFileSync(path.join(outDir, 'batch-validation.' + stamp + '.json'), JSON.stringify(report, null, 2), 'utf8');
  fs.writeFileSync(path.join(outDir, 'batch-validation.' + stamp + '.csv'), toCsv(report), 'utf8');
  console.log('レポート出力: ' + outDir);

  if (!report.ok) process.exit(1);
}

// CLIとして実行されたときだけ走らせる(テストからは runBatchValidation() を直接呼ぶ)。
if (require.main === module) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
