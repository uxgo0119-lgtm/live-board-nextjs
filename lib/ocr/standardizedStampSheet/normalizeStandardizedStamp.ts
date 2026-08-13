// lib/ocr/standardizedStampSheet/normalizeStandardizedStamp.ts
//
// [2026-08-11新設 新捺印表OCR P0実装]
// 新捺印表のOCR生出力(StandardizedStampRawEntry)を、正規化後のエントリ
// (StandardizedStampNormalizedEntry)へ変換する、新経路の正規化パイプライン本体。

import { convergeSymbol } from './symbolConvergence';
import { matchAgainstDictionaries } from './misreadDictionary';
import { parseGridTime } from './gridTimeParser';
import { parseRawScanRooms } from './parseRawScanResult';
import type { StandardizedStampNormalizedEntry, StandardizedStampRawEntry } from './types';

export type NormalizeStandardizedStampOptions = {
  confidenceHint?: number;
  confidenceThreshold?: number;
  parseIssues?: string[];
};

export function normalizeStandardizedStampEntry(
  rawEntry: StandardizedStampRawEntry,
  options: NormalizeStandardizedStampOptions = {}
): StandardizedStampNormalizedEntry {
  const resolvedSymbol = convergeSymbol(rawEntry.raw_checkboxes, options);
  const timeStart = parseGridTime(rawEntry.time_start_raw);
  const timeEnd = parseGridTime(rawEntry.time_end_raw);
  const noteMisreadMatch = matchAgainstDictionaries(rawEntry.note_raw);

  const needsReviewReasons: string[] = [];
  if (resolvedSymbol.state === 'needs_review') {
    needsReviewReasons.push('SYMBOL:' + (resolvedSymbol.reason ?? 'UNKNOWN'));
  }
  if (!timeStart.ok) {
    needsReviewReasons.push('TIME_START:' + (timeStart.reason ?? 'UNKNOWN'));
  }
  if (!timeEnd.ok) {
    needsReviewReasons.push('TIME_END:' + (timeEnd.reason ?? 'UNKNOWN'));
  }
  if (rawEntry.note_raw.trim() && noteMisreadMatch.state !== 'auto_correct') {
    needsReviewReasons.push('NOTE:' + noteMisreadMatch.state.toUpperCase());
  }
  if (options.parseIssues && options.parseIssues.length > 0) {
    for (const issue of options.parseIssues) {
      needsReviewReasons.push('PARSE_ISSUE:' + issue);
    }
  }

  return {
    room_number: rawEntry.room_number,
    raw_checkboxes: rawEntry.raw_checkboxes,
    resolved_symbol: resolvedSymbol,
    time_start: timeStart,
    time_end: timeEnd,
    note_raw: rawEntry.note_raw,
    note_misread_match: noteMisreadMatch,
    needsReview: needsReviewReasons.length > 0,
    needsReviewReasons,
  };
}

export function normalizeStandardizedStampEntries(
  rawEntries: StandardizedStampRawEntry[],
  options: NormalizeStandardizedStampOptions = {}
): StandardizedStampNormalizedEntry[] {
  return rawEntries.map((entry) => normalizeStandardizedStampEntry(entry, options));
}

export function normalizeStandardizedStampScanResult(
  rooms: unknown[],
  options: Omit<NormalizeStandardizedStampOptions, 'parseIssues'> = {}
): { entries: StandardizedStampNormalizedEntry[]; skipped: string[] } {
  const { entries: parsedEntries, skipped } = parseRawScanRooms(rooms);
  const normalizedEntries = parsedEntries.map(({ entry, parseIssues }) =>
    normalizeStandardizedStampEntry(entry, { ...options, parseIssues })
  );
  return { entries: normalizedEntries, skipped };
}
