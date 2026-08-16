// lib/ocr/standardizedStampSheet/normalizeStandardizedStamp.ts
//
// [2026-08-11新設 新捺印表OCR P0実装]
// 新捺印表のOCR生出力(StandardizedStampRawEntry)を、正規化後のエントリ
// (StandardizedStampNormalizedEntry)へ変換する、新経路の正規化パイプライン本体。

import { convergeSymbol } from './symbolConvergence';
import { blankMisreadMatch } from './misreadDictionary';
import { blankGridTime } from './gridTimeParser';
import { parseRawScanRooms, parseTimeDesignationRawRows } from './parseRawScanResult';
import { joinTimeDesignationRows } from './timeDesignation';
import type {
  StandardizedStampNormalizedEntry,
  StandardizedStampNormalizedResult,
  StandardizedStampRawEntry,
} from './types';

export type NormalizeStandardizedStampOptions = {
  confidenceHint?: number;
  confidenceThreshold?: number;
  parseIssues?: string[];
};

// ---------------------------------------------------------------------------
// [2026-08-13新設 実API検証フェーズ] 本体グリッドと時間指定エリアを分けて扱う経路。
//
// [2026-08-15 Phase 2] ここにあった旧経路(normalizeStandardizedStampEntry /
// normalizeStandardizedStampEntries / normalizeStandardizedStampScanResult)は削除した。
// 本体グリッドの行に時刻・備考が入っている前提の実装で、実API検証により
//  (1) 空マスの0補完を検知できない (2) 時間指定が隣接部屋へ割り当てられても検知できない
// ことが判明して以降どこからも呼ばれておらず、しかしFireFlow辞書(matchAgainstDictionaries)を
// 呼ぶ2つ目の場所として残っていた。辞書の適用箇所を正式パイプライン内の1箇所
// (timeDesignation の備考)だけにするため、経路ごと落としている。
// ---------------------------------------------------------------------------

function stripLeadingZeros(roomNumber: string): string {
  return roomNumber.replace(/^0+/, '');
}

// 要確認理由へ添える「マスの見え方」。値の復元には使わない、人が読むためだけの補足。
// 理由文字列は接頭辞(TIME_START: 等)で項目へ振り分けられるため、末尾に足しても分類は変わらない。
function rawCellHint(raw: string): string {
  const text = (raw ?? '').trim();
  if (!text || text.includes('|')) return '';
  return '(' + text + ')';
}

// 本体グリッドの行(部屋番号+A/P/キャンセルのみ)を正規化する。時刻・備考はここでは扱わず、
// 時間指定エリア側の結合結果としてのみ後から書き込まれる。
function normalizeGridRoomEntry(
  rawEntry: StandardizedStampRawEntry,
  options: NormalizeStandardizedStampOptions
): StandardizedStampNormalizedEntry {
  const resolvedSymbol = convergeSymbol(rawEntry.raw_checkboxes, options);
  const needsReviewReasons: string[] = [];

  if (resolvedSymbol.state === 'needs_review') {
    needsReviewReasons.push('SYMBOL:' + (resolvedSymbol.reason ?? 'UNKNOWN'));
  }
  if (options.parseIssues) {
    for (const issue of options.parseIssues) needsReviewReasons.push('PARSE_ISSUE:' + issue);
  }
  // 帳票の印字は3桁なら3桁。先頭0はモデル側の0埋め(実API検証で "0801" 等を観測)の疑いが
  // あり、どちらが印字値かを機械的に決められないため、こちらで勝手に外さず要確認へ倒す。
  if (/^0/.test(rawEntry.room_number)) {
    needsReviewReasons.push('ROOM_NUMBER:LEADING_ZERO');
  }
  // 新経路では本体グリッド行に時刻・備考が入ってくること自体が想定外。値は採用しない。
  if (rawEntry.time_start_raw || rawEntry.time_end_raw || rawEntry.note_raw) {
    needsReviewReasons.push('UNEXPECTED_INLINE_TIME');
  }

  return {
    room_number: rawEntry.room_number,
    raw_checkboxes: rawEntry.raw_checkboxes,
    resolved_symbol: resolvedSymbol,
    time_start: blankGridTime(),
    time_end: blankGridTime(),
    note_raw: '',
    note_misread_match: blankMisreadMatch(),
    needsReview: needsReviewReasons.length > 0,
    needsReviewReasons,
    time_source_row_index: null,
  };
}

export type StandardizedStampScanInput = {
  rooms: unknown[];
  time_designation_rows?: unknown;
};

export function normalizeStandardizedStampScan(
  scan: StandardizedStampScanInput,
  options: Omit<NormalizeStandardizedStampOptions, 'parseIssues'> = {}
): StandardizedStampNormalizedResult {
  const { entries: parsedEntries, skipped } = parseRawScanRooms(Array.isArray(scan.rooms) ? scan.rooms : []);
  const entries = parsedEntries.map(({ entry, parseIssues }) => normalizeGridRoomEntry(entry, { ...options, parseIssues }));

  // 同一room_numberが複数行返ってきた場合、どちらが正しい行かを機械的に決められないため、
  // 片方を自動採用せず、該当する全行をneeds_reviewにする(実API検証で1305が2行返ってきた)。
  const exactCount = new Map<string, number>();
  const normalizedCount = new Map<string, number>();
  for (const e of entries) {
    exactCount.set(e.room_number, (exactCount.get(e.room_number) ?? 0) + 1);
    const key = stripLeadingZeros(e.room_number);
    normalizedCount.set(key, (normalizedCount.get(key) ?? 0) + 1);
  }
  const duplicateRoomNumbers: string[] = [];
  for (const e of entries) {
    const key = stripLeadingZeros(e.room_number);
    if ((exactCount.get(e.room_number) ?? 0) > 1) {
      e.needsReviewReasons.push('DUPLICATE_ROOM_NUMBER');
      e.needsReview = true;
      if (!duplicateRoomNumbers.includes(e.room_number)) duplicateRoomNumbers.push(e.room_number);
    } else if ((normalizedCount.get(key) ?? 0) > 1) {
      // "905" と "0905" のように表記だけ違う重複も、同一部屋の二重出力の疑いとして扱う。
      e.needsReviewReasons.push('DUPLICATE_ROOM_NUMBER:NORMALIZED');
      e.needsReview = true;
      if (!duplicateRoomNumbers.includes(e.room_number)) duplicateRoomNumbers.push(e.room_number);
    }
  }

  const rawRows = parseTimeDesignationRawRows(scan.time_designation_rows);
  const { rows, unassigned } = joinTimeDesignationRows(entries, rawRows);

  // 結合後に、時刻・備考起因のneeds_reviewを各エントリへ反映する。
  // [2026-08-15追加] 理由には、確定できなかったマスの見え方(例: "9?:30")も添える。
  // 実LBでは要確認バッジの説明(title)としてそのまま表示・保存されるため、次に同じ症状が出た
  // ときに「モデルが何を返したせいで確定できなかったのか」を、再スキャンせずに特定できる
  // (絶対ルール8「推測で原因確定しない」を、実LB側だけで満たせるようにするため)。
  for (const e of entries) {
    if (!e.time_start.ok) e.needsReviewReasons.push('TIME_START:' + (e.time_start.reason ?? 'UNKNOWN') + rawCellHint(e.time_start.raw));
    if (!e.time_end.ok) e.needsReviewReasons.push('TIME_END:' + (e.time_end.reason ?? 'UNKNOWN') + rawCellHint(e.time_end.raw));
    if (e.note_raw.trim() && e.note_misread_match.state !== 'auto_correct') {
      e.needsReviewReasons.push('NOTE:' + e.note_misread_match.state.toUpperCase());
    }
    e.needsReview = e.needsReviewReasons.length > 0;
  }

  return { entries, timeDesignationRows: rows, unassignedTimeDesignationRows: unassigned, duplicateRoomNumbers, skipped };
}
