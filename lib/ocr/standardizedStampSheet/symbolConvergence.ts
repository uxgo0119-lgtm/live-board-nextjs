// lib/ocr/standardizedStampSheet/symbolConvergence.ts
//
// [2026-08-11新設 新捺印表OCR P0実装]
// A/P/キャンセルの生チェック状態(RawCheckboxes)を、下流互換の単一値symbolへ収束させる
// ロジック(設計書Section 2.3の収束テーブルの実装)。
//
// 【最重要方針、KB-024ルール1・2】
// 「AとP、両方にチェックがある」といった複数チェックを、黙って1つへ補正してはならない
// (802号室のケース。stampGridParser.tsのif/else-ifチェーンで実際に発生していた不具合の
// 再発防止が目的)。0個(空欄)は空欄として確定してよい(KB-018)。1個だけなら確定してよいが、
// 2個以上は必ず needs_review に倒す。

import type { RawCheckboxes, ResolvedSymbol } from './types';

function countChecked(raw: RawCheckboxes): number {
  return (raw.a_checked ? 1 : 0) + (raw.p_checked ? 1 : 0) + (raw.cancel_checked ? 1 : 0);
}

export type SymbolConvergenceOptions = {
  confidenceHint?: number;
  confidenceThreshold?: number;
};

export function convergeSymbol(raw: RawCheckboxes, options: SymbolConvergenceOptions = {}): ResolvedSymbol {
  const checkedCount = countChecked(raw);

  if (checkedCount === 0) {
    return { value: '', state: 'auto_confirmed' };
  }

  if (checkedCount >= 2) {
    return { value: '', state: 'needs_review', reason: 'MULTIPLE_SYMBOL_CHECKED' };
  }

  const threshold = options.confidenceThreshold ?? 0;
  if (options.confidenceHint !== undefined && options.confidenceHint < threshold) {
    return { value: '', state: 'needs_review', reason: 'LOW_CONFIDENCE' };
  }

  if (raw.a_checked) return { value: 'A', state: 'auto_confirmed' };
  if (raw.p_checked) return { value: 'P', state: 'auto_confirmed' };
  return { value: 'キャンセル', state: 'auto_confirmed' };
}
