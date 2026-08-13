// lib/ocr/standardizedStampSheet/timeDesignation.ts
//
// [2026-08-13新設 実API検証フェーズ]
// 時間指定エリア(time_grid)を、本体グリッドとは独立に「1行単位」で解釈し、行自身が持つ
// 部屋番号マスによってのみ本体グリッドの部屋へ結合する。
//
// 【なぜ必要か】実Anthropic API検証(2026-08-13、コスモ城東野江ロイヤルフォルム)で、
// 1001号室の時間指定(開始10:00・終了11:30)が隣接行の1002号室へ割り当てられ、そのまま
// auto_confirmedになる誤確定が発生した。従来は時刻を「本体グリッドの部屋行の属性」として
// 抽出させており、どの部屋の時間指定なのかの対応付けがモデル任せ(実質、行の並び順頼み)
// だったことが原因。
//
// 【方針(KB-024「誤確定0優先」)】
// - 部屋番号・開始・終了はすべて1マス1文字のグリッドとして、マス単位で読む。
// - 行番号(row_index)で本体グリッドと突き合わせることは絶対にしない。結合キーは
//   「その行自身の部屋番号マスから読めた部屋番号」のみ。
// - 少しでも曖昧な要素(判読不能マス・欠損マス・重複・本体グリッドに無い部屋番号・
//   行位置が検証できない)があれば結合せず needs_review へ倒す。

import { parseGridTimeCells, normalizeGridCells } from './gridTimeParser';
import { matchAgainstDictionaries } from './misreadDictionary';
import { STANDARDIZED_STAMP_SHEET_V1 } from './layoutRegistry';
import type {
  GridRoomNumberReadResult,
  StandardizedStampNormalizedEntry,
  StandardizedStampTimeDesignationRawRow,
  StandardizedStampTimeDesignationRow,
} from './types';

// 部屋番号は4マス。3桁の部屋(例: 603)は先頭マスが空欄で[空][6][0][3]と記入される帳票構造。
export const ROOM_NUMBER_CELL_COUNT = 4;

// 時間指定エリアの行数(左右2サブテーブル×各6行)。レジストリのゾーン定義に由来する値で、
// 特定物件専用のhard-codeではない(KB-024ルール5)。
export const TIME_DESIGNATION_ROW_COUNT = 12;

const ILLEGIBLE_PLACEHOLDER = '?';

// 部屋番号マスの読み取り。
// 先頭の空マスは「桁数が少ない部屋番号」を意味する帳票構造なので、先頭の連続した空マスの
// 除去だけは行ってよい(推測ではなく構造)。一方で、途中や末尾の空マスは桁の欠損であり、
// 絶対に0等で埋めない。
export function parseRoomNumberCells(input: unknown): GridRoomNumberReadResult {
  const { cells, malformed } = normalizeGridCells(input, ROOM_NUMBER_CELL_COUNT);

  if (cells === null) {
    return { value: null, raw: '', ok: false, blank: false, reason: 'CELL_DATA_UNAVAILABLE', cells: null };
  }

  const raw = cells.map((c) => (c === '' ? '_' : c)).join('');

  if (cells.every((c) => c === '')) {
    return { value: null, raw: '', ok: false, blank: true, cells };
  }
  if (cells.some((c) => c === ILLEGIBLE_PLACEHOLDER)) {
    return { value: null, raw, ok: false, blank: false, reason: 'ILLEGIBLE_DIGIT', cells };
  }
  if (malformed) {
    return { value: null, raw, ok: false, blank: false, reason: 'INVALID_FORMAT', cells };
  }

  // 先頭の空マスのみ除去し、残りが連続した数字であることを要求する。
  let start = 0;
  while (start < cells.length && cells[start] === '') start++;
  const rest = cells.slice(start);
  if (rest.some((c) => c === '')) {
    // 途中・末尾に空マスがある = 桁が欠けている。補完しない。
    return { value: null, raw, ok: false, blank: false, reason: 'MISSING_CELL', cells };
  }
  if (rest.some((c) => !/^[0-9]$/.test(c))) {
    return { value: null, raw, ok: false, blank: false, reason: 'INVALID_FORMAT', cells };
  }
  const value = rest.join('');
  if (value.length < 3) {
    return { value: null, raw, ok: false, blank: false, reason: 'INVALID_FORMAT', cells };
  }
  if (value.startsWith('0')) {
    // 帳票に印字/記入された部屋番号が先頭0で始まることは想定していない。モデル側の
    // 0埋め(実API検証で "0801" 等が観測された)の可能性があるため、確定しない。
    return { value: null, raw, ok: false, blank: false, reason: 'LEADING_ZERO', cells };
  }
  return { value, raw, ok: true, blank: false, cells };
}

function isRowBlank(row: StandardizedStampTimeDesignationRawRow, roomNumber: GridRoomNumberReadResult): boolean {
  if (!roomNumber.blank) return false;
  const start = normalizeGridCells(row.start_time_cells, 4).cells;
  const end = normalizeGridCells(row.end_time_cells, 4).cells;
  const startBlank = start === null || start.every((c) => c === '');
  const endBlank = end === null || end.every((c) => c === '');
  return startBlank && endBlank && row.remarks_raw.trim() === '';
}

export type JoinResult = {
  rows: StandardizedStampTimeDesignationRow[];
  unassigned: StandardizedStampTimeDesignationRow[];
};

// 時間指定エリアの生行を解釈し、本体グリッドのエントリへ結合する。
// entries は破壊的に更新される(結合できた行の時刻・備考のみを書き込む)。
export function joinTimeDesignationRows(
  entries: StandardizedStampNormalizedEntry[],
  rawRows: StandardizedStampTimeDesignationRawRow[]
): JoinResult {
  // 本体グリッド側の部屋番号 -> エントリ(同一番号が複数ある場合は全部保持して重複判定に使う)
  const entriesByRoom = new Map<string, StandardizedStampNormalizedEntry[]>();
  for (const e of entries) {
    const list = entriesByRoom.get(e.room_number);
    if (list) list.push(e);
    else entriesByRoom.set(e.room_number, [e]);
  }

  // まず全行を解釈する(結合の可否判定に、行同士の重複を見る必要があるため)。
  const interpreted = rawRows.map((row) => {
    const roomNumber = parseRoomNumberCells(row.room_number_cells);
    const startTime = parseGridTimeCells(row.start_time_cells);
    const endTime = parseGridTimeCells(row.end_time_cells);
    const remarks = row.remarks_raw.trim();
    return {
      raw: row,
      roomNumber,
      startTime,
      endTime,
      remarks,
      remarksMatch: matchAgainstDictionaries(remarks),
      blank: isRowBlank(row, roomNumber),
    };
  });

  // 時間指定エリア内で同じ部屋番号が複数行に出るケースを検出する。
  const roomCountInTimeGrid = new Map<string, number>();
  for (const item of interpreted) {
    if (item.blank || !item.roomNumber.ok || !item.roomNumber.value) continue;
    roomCountInTimeGrid.set(item.roomNumber.value, (roomCountInTimeGrid.get(item.roomNumber.value) ?? 0) + 1);
  }

  // row_index の妥当性(欠落・重複・範囲外)を検証する。行位置が検証できない行は確定しない。
  const rowIndexCount = new Map<number, number>();
  for (const item of interpreted) {
    if (typeof item.raw.row_index === 'number') {
      rowIndexCount.set(item.raw.row_index, (rowIndexCount.get(item.raw.row_index) ?? 0) + 1);
    }
  }

  const rows: StandardizedStampTimeDesignationRow[] = [];
  const unassigned: StandardizedStampTimeDesignationRow[] = [];

  for (const item of interpreted) {
    const reasons: string[] = [];
    const rowIndex = typeof item.raw.row_index === 'number' ? item.raw.row_index : null;

    if (item.blank) {
      // 完全な空行。帳票上ふつうに存在するため、レビュー対象にはしない。
      rows.push({
        row_index: rowIndex,
        room_number: item.roomNumber,
        start_time: item.startTime,
        end_time: item.endTime,
        remarks_raw: item.remarks,
        remarks_misread_match: item.remarksMatch,
        assigned_room_number: null,
        state: 'blank',
        reasons: [],
      });
      continue;
    }

    if (rowIndex === null || !Number.isInteger(rowIndex) || rowIndex < 1 || rowIndex > TIME_DESIGNATION_ROW_COUNT) {
      reasons.push('ROW_POSITION_UNVERIFIABLE');
    } else if ((rowIndexCount.get(rowIndex) ?? 0) > 1) {
      reasons.push('ROW_POSITION_UNVERIFIABLE');
    }

    if (item.roomNumber.reason === 'CELL_DATA_UNAVAILABLE') reasons.push('ROOM_NUMBER_CELL_DATA_UNAVAILABLE');
    else if (item.roomNumber.reason === 'LEADING_ZERO') reasons.push('ROOM_NUMBER_LEADING_ZERO');
    else if (!item.roomNumber.ok) reasons.push('ROOM_NUMBER_AMBIGUOUS');

    let target: StandardizedStampNormalizedEntry | null = null;
    const roomValue = item.roomNumber.ok ? item.roomNumber.value : null;

    if (roomValue) {
      if ((roomCountInTimeGrid.get(roomValue) ?? 0) > 1) reasons.push('DUPLICATE_ROOM_IN_TIME_GRID');

      const exact = entriesByRoom.get(roomValue);
      if (exact && exact.length === 1) {
        target = exact[0];
      } else if (exact && exact.length > 1) {
        reasons.push('DUPLICATE_ROOM_IN_MAIN_GRID');
        target = exact[0];
      } else {
        // 本体グリッド側が0埋めされている等、表記の違いで一致しない可能性を検出する。
        // ただし表記が違う時点で確定はしない(どちらが帳票の印字かを機械的に決められないため)。
        const loose = entries.filter((e) => e.room_number.replace(/^0+/, '') === roomValue);
        if (loose.length === 1) {
          reasons.push('ROOM_NUMBER_FORMAT_MISMATCH');
          target = loose[0];
        } else if (loose.length > 1) {
          reasons.push('DUPLICATE_ROOM_IN_MAIN_GRID');
        } else {
          reasons.push('ROOM_NOT_IN_MAIN_GRID');
        }
      }
    }

    if (!item.startTime.ok) reasons.push('TIME_START:' + (item.startTime.reason ?? 'UNKNOWN'));
    if (!item.endTime.ok) reasons.push('TIME_END:' + (item.endTime.reason ?? 'UNKNOWN'));
    if (item.remarks && item.remarksMatch.state !== 'auto_correct') reasons.push('REMARKS:' + item.remarksMatch.state.toUpperCase());

    const confirmed = reasons.length === 0 && target !== null;

    const row: StandardizedStampTimeDesignationRow = {
      row_index: rowIndex,
      room_number: item.roomNumber,
      start_time: item.startTime,
      end_time: item.endTime,
      remarks_raw: item.remarks,
      remarks_misread_match: item.remarksMatch,
      assigned_room_number: confirmed && target ? target.room_number : null,
      state: confirmed ? 'auto_confirmed' : 'needs_review',
      reasons,
    };
    rows.push(row);

    if (confirmed && target) {
      // 確定した行だけを本体エントリへ書き込む。
      target.time_start = item.startTime;
      target.time_end = item.endTime;
      target.note_raw = item.remarks;
      target.note_misread_match = item.remarksMatch;
      target.time_source_row_index = rowIndex;
      continue;
    }

    // 未確定の行。結合先候補が分かっている場合は、その部屋にも「時間指定が要確認である」
    // ことを伝える(時刻の値そのものは絶対に書き込まない)。
    if (target) {
      target.needsReview = true;
      target.needsReviewReasons.push('TIME_DESIGNATION:' + reasons.join('|'));
    }
    unassigned.push(row);
  }

  return { rows, unassigned };
}

// 参照用: レイアウト定義側の時間指定ゾーンが実測済みかどうか。
export function isTimeGridCalibrated(): boolean {
  return STANDARDIZED_STAMP_SHEET_V1.zones.time_grid.calibrated;
}
