// lib/ocr/standardizedStampSheet/parseRawScanResult.ts
//
// [2026-08-11新設 新捺印表OCR P0実装]
// AIから返ってきた生JSONを、型安全なStandardizedStampRawEntryへ変換する防御的アダプタ層。

import type { RawCheckboxes, StandardizedStampRawEntry } from './types';

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
