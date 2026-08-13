// lib/ocr/standardizedStampSheet/gridTimeParser.ts
//
// [2026-08-11新設 新捺印表OCR P0実装]
// 時間指定グリッド(開始HH:MM・終了HH:MM、1マス1文字)の生読み取り結果を、厳密な検証を
// 通してからのみ確定値として扱う。
//
// 【最重要方針、KB-024ルール6】1文字でも判読不能・書式不正なら、絶対に推測で埋めない。
// 「9□:00」のように一部が読めない場合や、「25:99」のように時刻として無効な場合は、
// 全体をok:falseとしてneeds_reviewに倒す(部分的に正しく見える数字だけを採用しない)。

// [2026-08-13改訂 実API検証フェーズ] 実Anthropic API検証で、「時」の十の位マスが空白の
// 帳票([空][9]:[3][0])に対し、モデルが文字列 "09:30" を返す(=空マスを勝手に0で補完する)
// ことが確認された。文字列だけを見る parseGridTime() では、この補完後の文字列は正常な
// "09:30" と区別できず、そのまま確定されてしまう(実際に1101号室・801号室で誤確定が発生)。
//
// そこで、マス単位の配列(cells)を受け取る parseGridTimeCells() を新設し、時間指定エリアの
// 経路はこちらのみを使う。文字列表現ではなくマスの空/埋を一次情報として判定するため、
// モデルが補完した文字列を同時に返してきても、空マスがある限り確定されない。
import type { GridTimeReadResult } from './types';

const STRICT_HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

const ILLEGIBLE_PLACEHOLDER = '?';

// 開始/終了時刻は [時十の位][時一の位][分十の位][分一の位] の4マス。
export const TIME_CELL_COUNT = 4;

export type NormalizedCells = {
  cells: string[] | null;
  malformed: boolean;
};

// モデルの返す配列を、1マス1文字の文字列配列へ正規化する。
// 各マスは「空文字(未記入)」「1文字」「'?'(判読不能)」のいずれかであることを要求し、
// 2文字以上が1マスに入っている等はmalformedとして扱う(推測で分割しない)。
export function normalizeGridCells(input: unknown, expectedCount: number): NormalizedCells {
  if (!Array.isArray(input)) {
    return { cells: null, malformed: false };
  }
  let malformed = input.length !== expectedCount;
  const cells: string[] = [];
  for (const cell of input) {
    if (cell === null || cell === undefined) {
      cells.push('');
      continue;
    }
    if (typeof cell !== 'string' && typeof cell !== 'number') {
      malformed = true;
      cells.push(ILLEGIBLE_PLACEHOLDER);
      continue;
    }
    const text = String(cell).trim();
    if (text.length > 1) {
      // 1マスに複数文字。どのマスの文字なのか特定できないため、推測で割り振らない。
      malformed = true;
      cells.push(ILLEGIBLE_PLACEHOLDER);
      continue;
    }
    cells.push(text);
  }
  return { cells, malformed };
}

function isBlankCell(cell: string): boolean {
  return cell === '';
}

// マス単位の開始/終了時刻を厳密に検証する。
// - 全マス空欄 => 「記入なし」(ok:true, value:null)
// - 1マスでも空欄 => MISSING_CELL (0補完は絶対に行わない)
// - 1マスでも'?' => ILLEGIBLE_DIGIT
// - マス数が想定と違う/数字以外 => INCOMPLETE / INVALID_FORMAT
export function parseGridTimeCells(input: unknown): GridTimeReadResult {
  const { cells, malformed } = normalizeGridCells(input, TIME_CELL_COUNT);

  if (cells === null) {
    // マス情報そのものが無い。文字列だけでは補完の有無を検証できないため確定しない。
    return { value: null, raw: '', ok: false, reason: 'CELL_DATA_UNAVAILABLE', cells: null };
  }

  const raw = formatCellsAsTime(cells);

  if (cells.every(isBlankCell)) {
    return { value: null, raw: '', ok: true, cells };
  }
  if (cells.some((c) => c === ILLEGIBLE_PLACEHOLDER)) {
    return { value: null, raw, ok: false, reason: 'ILLEGIBLE_DIGIT', cells };
  }
  if (cells.some(isBlankCell)) {
    // ここが1101号室・801号室(「時」の十の位が空白)の経路。推測で埋めずneeds_reviewへ倒す。
    return { value: null, raw, ok: false, reason: 'MISSING_CELL', cells };
  }
  if (malformed || cells.length !== TIME_CELL_COUNT) {
    return { value: null, raw, ok: false, reason: 'INCOMPLETE', cells };
  }
  if (cells.some((c) => !/^[0-9]$/.test(c))) {
    return { value: null, raw, ok: false, reason: 'INVALID_FORMAT', cells };
  }

  const assembled = cells[0] + cells[1] + ':' + cells[2] + cells[3];
  if (!STRICT_HHMM_RE.test(assembled)) {
    return { value: null, raw, ok: false, reason: 'INVALID_FORMAT', cells };
  }
  return { value: assembled, raw: assembled, ok: true, cells };
}

// マスの生の見え方を、空マスを'?'として可視化した文字列にする(例: "?9:30")。
// 監査・人手確認用の表示であり、この文字列から値を復元してはならない。
export function formatCellsAsTime(cells: string[]): string {
  const padded = [...cells];
  while (padded.length < TIME_CELL_COUNT) padded.push('');
  const show = (i: number) => (padded[i] === '' ? ILLEGIBLE_PLACEHOLDER : padded[i]);
  return show(0) + show(1) + ':' + show(2) + show(3);
}

// 「記入なし」を表す既定値(時間指定エリアに行が無い部屋に使う)。
export function blankGridTime(): GridTimeReadResult {
  return { value: null, raw: '', ok: true, cells: null };
}

// [非推奨 / 2026-08-13] 文字列だけを受け取る旧経路。モデル側での0補完を検知できないため、
// 時間指定エリアの処理には使わないこと(parseGridTimeCells を使う)。既存の呼び出し元との
// 互換のためだけに残している。
export function parseGridTime(raw: string): GridTimeReadResult {
  const trimmed = (raw ?? '').trim();

  if (!trimmed) {
    return { value: null, raw: trimmed, ok: true };
  }

  if (trimmed.includes(ILLEGIBLE_PLACEHOLDER)) {
    return { value: null, raw: trimmed, ok: false, reason: 'ILLEGIBLE_DIGIT' };
  }

  if (trimmed.length < 4) {
    return { value: null, raw: trimmed, ok: false, reason: 'INCOMPLETE' };
  }

  if (!STRICT_HHMM_RE.test(trimmed)) {
    return { value: null, raw: trimmed, ok: false, reason: 'INVALID_FORMAT' };
  }

  return { value: trimmed, raw: trimmed, ok: true };
}
