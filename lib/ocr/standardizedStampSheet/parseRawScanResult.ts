// lib/ocr/standardizedStampSheet/parseRawScanResult.ts
//
// [2026-08-11新設 新捺印表OCR P0実装]
// AIから返ってきた生JSONを、型安全なStandardizedStampRawEntryへ変換する防御的アダプタ層。

import type { RawCheckboxes, StandardizedStampRawEntry, StandardizedStampTimeDesignationRawRow } from './types';

export type ParsedRawEntryResult =
  | { ok: true; entry: StandardizedStampRawEntry; parseIssues: string[] }
  | { ok: false; error: string };

function toTrimmedString(value: unknown): string {
  return (value === undefined || value === null ? '' : String(value)).trim();
}

function coerceCheckboxValue(value: unknown, fieldName: string, parseIssues: string[]): boolean {
  if (typeof value === 'boolean') return value;
  parseIssues.push('MALFORMED_CHECKBOX_VALUE:' + fieldName + '=' + JSON.stringify(value));
  return false;
}

export function parseRawScanRoomEntry(item: unknown): ParsedRawEntryResult {
  if (!item || typeof item !== 'object') {
    return { ok: false, error: '想定外の形式の項目です(オブジェクトではありません): ' + JSON.stringify(item) };
  }
  const obj = item as Record<string, unknown>;
  const room = toTrimmedString(obj.room_number);
  if (!room) {
    return { ok: false, error: '部屋番号を読み取れませんでした。' };
  }

  const parseIssues: string[] = [];
  const rawCheckboxesInput = (obj.raw_checkboxes && typeof obj.raw_checkboxes === 'object' ? obj.raw_checkboxes : {}) as Record<
    string,
    unknown
  >;
  if (!obj.raw_checkboxes || typeof obj.raw_checkboxes !== 'object') {
    parseIssues.push('MISSING_RAW_CHECKBOXES_OBJECT');
  }
  const rawCheckboxes: RawCheckboxes = {
    a_checked: coerceCheckboxValue(rawCheckboxesInput.a_checked, 'a_checked', parseIssues),
    p_checked: coerceCheckboxValue(rawCheckboxesInput.p_checked, 'p_checked', parseIssues),
    cancel_checked: coerceCheckboxValue(rawCheckboxesInput.cancel_checked, 'cancel_checked', parseIssues),
  };

  const entry: StandardizedStampRawEntry = {
    room_number: room,
    raw_checkboxes: rawCheckboxes,
    time_start_raw: toTrimmedString(obj.time_start_raw),
    time_end_raw: toTrimmedString(obj.time_end_raw),
    note_raw: toTrimmedString(obj.note_raw),
  };

  return { ok: true, entry, parseIssues };
}

// [2026-08-13新設 実API検証フェーズ] 時間指定エリアの生行を型安全に取り出す。
// マス配列は「無い(null)」と「空マスが並んでいる」を区別する必要があるため、配列でない場合は
// nullのまま下流(parseGridTimeCells/parseRoomNumberCells)へ渡し、そちらで
// CELL_DATA_UNAVAILABLE として needs_review に倒す。
function toCellArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.map((c) => (c === null || c === undefined ? '' : String(c)));
}

export function parseTimeDesignationRawRow(item: unknown, fallbackIndex: number): StandardizedStampTimeDesignationRawRow {
  const obj = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
  const rawIndex = obj.row_index;
  const rowIndex =
    typeof rawIndex === 'number' && Number.isFinite(rawIndex)
      ? rawIndex
      : typeof rawIndex === 'string' && /^\d+$/.test(rawIndex.trim())
        ? Number(rawIndex.trim())
        : item && typeof item === 'object'
          ? fallbackIndex
          : null;

  return {
    row_index: rowIndex,
    room_number_cells: toCellArray(obj.room_number_cells),
    start_time_cells: toCellArray(obj.start_time_cells),
    end_time_cells: toCellArray(obj.end_time_cells),
    remarks_raw: toTrimmedString(obj.remarks_raw),
  };
}

export function parseTimeDesignationRawRows(rows: unknown): StandardizedStampTimeDesignationRawRow[] {
  if (!Array.isArray(rows)) return [];
  return rows.map((row, i) => parseTimeDesignationRawRow(row, i + 1));
}

export function parseRawScanRooms(rooms: unknown[]): {
  entries: Array<{ entry: StandardizedStampRawEntry; parseIssues: string[] }>;
  skipped: string[];
} {
  const entries: Array<{ entry: StandardizedStampRawEntry; parseIssues: string[] }> = [];
  const skipped: string[] = [];
  for (const item of rooms) {
    const result = parseRawScanRoomEntry(item);
    if (result.ok) {
      entries.push({ entry: result.entry, parseIssues: result.parseIssues });
    } else {
      skipped.push(result.error);
    }
  }
  return { entries, skipped };
}
