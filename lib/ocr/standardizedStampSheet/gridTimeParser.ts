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
//
// [2026-08-14改訂 最小修正 / 実画像1枚の実API検証で一般化] 「時」欄は[十の位][一の位]の
// 2マスで、1桁の時刻は片方のマスだけに数字が書かれる(帳票の表記慣習)。実物1枚の実API検証
// では、紙面上は同じ「9:30」の記入でも、801号室は ['','9','3','0']、1101号室は
// ['9','','3','0'] と、数字がどちらのマスに入るかがブレて返ってきた(記入位置とモデルの
// マス割り当ての揺れ)。そこで確定条件を「先頭マスのみ空欄」ではなく、
//   「時」欄2マスのうち片方だけが空欄 + もう片方が数字 + 「分」欄2マスが両方とも数字
// とする。2桁の時刻は必ず「時」欄2マスとも数字になるため、この形は1桁の時刻以外にあり得ず、
// 読めた1文字をそのまま「時」として扱うことは推測ではない(空マス=桁が無い、という帳票構造の
// 解釈)。「分」は常に2桁で記入されるため、「分」欄に空欄があれば従来通り確定しない。
//
// [2026-08-15改訂 Phase 2 実LB最終確認] 区切り記号':'を「マスの境界」として使う。
// モデルは帳票に印字された区切り記号を配列の要素として返してくることがあり(2026-08-13実測)、
// 「時」が2桁のときは ['1','0',':','0','0'] と5要素になるため、':'を除けば4マス揃って
// 従来どおり確定できていた。しかし「時」が1桁のときは ['9',':','3','0'] と4要素で返るため、
// ':'を除くと3マスになり「桁数不足」として確定できなかった(2026-08-13時点の判断。当時は
// 1桁の「時」を確定する規則そのものが無かった)。
// ':'は「時」欄と「分」欄の間に印字された境界なので、その前後で配列を分ければ、どの要素が
// 「時」でどの要素が「分」なのかは位置として確定する。前が1マスなら1桁の「時」であり、
// これは上の[2026-08-14改訂]と全く同じ「空マス=桁が無い」の解釈である。したがって
//   区切り記号がちょうど1つ + 前が1〜2マス + 後ろが2マスとも数字
// のときに限り確定する。分側に空欄・判読不能がある場合、時側が全て空欄の場合は従来どおり
// 確定しない(桁を推測で作らない)。
import type { GridTimeReadResult } from './types';

const STRICT_HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

const ILLEGIBLE_PLACEHOLDER = '?';

// 帳票に印字されている「時」と「分」の区切り記号。マス(数字1文字)ではない。
const SEPARATOR_CELL = ':';

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
  const raw0 = normalizeGridCells(input, TIME_CELL_COUNT);

  if (raw0.cells === null) {
    // マス情報そのものが無い。文字列だけでは補完の有無を検証できないため確定しない。
    return { value: null, raw: '', ok: false, reason: 'CELL_DATA_UNAVAILABLE', cells: null };
  }

  // [2026-08-13追加] 実API検証で、モデルが「時」と「分」の区切り記号':'を1つのマスとして
  // 返してくることがあった(例: 記入の無い欄を ["","",":",""] 、9:30を ["9",":","3","0"])。
  // ':'は帳票に印字された区切りであってマス(数字1文字)ではないため、数字マスの判定から
  // 除外する。除外は「区切り記号を取り除く」だけであり、数字を推測して補うことはしない
  // (例: ["9",":","3","0"] は除外後3マスになるので、桁数不足として確定しない)。
  const cells = raw0.cells.filter((c) => c !== SEPARATOR_CELL);
  const malformed = raw0.malformed && raw0.cells.length - cells.length === 0;

  const raw = formatCellsAsTime(cells);

  if (cells.every(isBlankCell)) {
    return { value: null, raw: '', ok: true, cells };
  }
  if (cells.some((c) => c === ILLEGIBLE_PLACEHOLDER)) {
    return { value: null, raw, ok: false, reason: 'ILLEGIBLE_DIGIT', cells };
  }
  // [2026-08-15追加 Phase 2 実LB最終確認] 区切り記号を境界として使う経路。
  // ここへ来るのは「区切りを除くと4マスに満たない」形だけ(4マス揃う形は下の従来経路が
  // そのまま扱う)なので、これまで確定できずneeds_reviewへ倒れていたケースだけが対象になる。
  const separatorCount = raw0.cells.filter((c) => c === SEPARATOR_CELL).length;
  if (separatorCount === 1 && cells.length < TIME_CELL_COUNT) {
    const separatorIndex = raw0.cells.indexOf(SEPARATOR_CELL);
    const hourPart = raw0.cells.slice(0, separatorIndex);
    const minutePart = raw0.cells.slice(separatorIndex + 1);
    const hourDigits = hourPart.filter((c) => !isBlankCell(c));
    if (hourPart.length <= 2 && hourDigits.length >= 1 && minutePart.length === 2 && !minutePart.some(isBlankCell)) {
      const hour = hourDigits.length === 1 ? '0' + hourDigits[0] : hourDigits[0] + hourDigits[1];
      const assembled = hour + ':' + minutePart[0] + minutePart[1];
      // 監査用のrawは、区切り記号を含む「モデルが返したままの並び」を保持する(補完前の姿)。
      const rawWithSeparator = raw0.cells.map((c) => (isBlankCell(c) ? ILLEGIBLE_PLACEHOLDER : c)).join('');
      if (!STRICT_HHMM_RE.test(assembled)) {
        return { value: null, raw: rawWithSeparator, ok: false, reason: 'INVALID_FORMAT', cells };
      }
      return { value: assembled, raw: rawWithSeparator, ok: true, cells };
    }
  }
  // [2026-08-14改訂 最小修正] 1桁の「時」の確定。「時」欄2マスのうち片方だけが空欄で、
  // もう片方が数字、かつ「分」欄2マスが両方とも数字のときに限り、その1文字を1桁の時として
  // 確定する(空マスの位置が十の位側・一の位側のどちらでも同じ扱い)。実データでは同じ記入でも
  // どちらのマスに数字が入るかがブレるため、位置ではなく「時欄に数字が1つだけある」という
  // 構造で判定する。分側に空欄がある場合・時欄が両方空欄の場合は、従来通りMISSING_CELLの
  // ままneeds_reviewへ倒す(桁を推測で作らない)。
  const hourCells = cells.slice(0, 2);
  const minuteCells = cells.slice(2, TIME_CELL_COUNT);
  if (
    cells.length === TIME_CELL_COUNT &&
    hourCells.filter(isBlankCell).length === 1 &&
    !minuteCells.some(isBlankCell)
  ) {
    const hourDigit = hourCells.find((c) => !isBlankCell(c)) as string;
    const filled = ['0', hourDigit, minuteCells[0], minuteCells[1]];
    if (filled.some((c) => !/^[0-9]$/.test(c))) {
      return { value: null, raw, ok: false, reason: 'INVALID_FORMAT', cells };
    }
    const assembledFilled = filled[0] + filled[1] + ':' + filled[2] + filled[3];
    if (!STRICT_HHMM_RE.test(assembledFilled)) {
      return { value: null, raw, ok: false, reason: 'INVALID_FORMAT', cells };
    }
    return { value: assembledFilled, raw, ok: true, cells };
  }
  if (cells.some(isBlankCell)) {
    // 上記の「先頭マスのみ空欄」以外の空欄パターン。推測で埋めずneeds_reviewへ倒す。
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

// [2026-08-15 Phase 2] 文字列だけを受け取る旧経路 parseGridTime() は削除した。
// モデル側での0補完(空マスを勝手に"0"で埋めた"09:30")を文字列からは検知できず、
// 実API検証で1101・801の誤確定を招いた実装であり、2026-08-13以降どこからも呼ばれていない。
// 時刻の確定は必ずマス単位の parseGridTimeCells() を通す。
