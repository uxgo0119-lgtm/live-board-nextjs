// lib/ocr/standardizedStampSheet/gridTimeParser.ts
//
// [2026-08-11新設 新捺印表OCR P0実装]
// 時間指定グリッド(開始HH:MM・終了HH:MM、1マス1文字)の生読み取り結果を、厳密な検証を
// 通してからのみ確定値として扱う。
//
// 【最重要方針、KB-024ルール6】1文字でも判読不能・書式不正なら、絶対に推測で埋めない。
// 「9□:00」のように一部が読めない場合や、「25:99」のように時刻として無効な場合は、
// 全体をok:falseとしてneeds_reviewに倒す(部分的に正しく見える数字だけを採用しない)。

import type { GridTimeReadResult } from './types';

const STRICT_HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

const ILLEGIBLE_PLACEHOLDER = '?';

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
