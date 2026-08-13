// lib/ocr/standardizedStampSheet/types.ts
//
// [2026-08-11新設 新捺印表OCR P0実装]
// 新捺印表(Standardized Stamp Sheet、KB-024)専用の型定義。
//
// 【最重要方針】既存Legacy捺印表(documentTypes/residentTimeRequestSheet.ts、単一値symbol
// スキーマ)は1文字も変更しない。ここは完全に独立した新経路であり、既存のStampSheetEntry
// (lib/ocr-benchmark/types.ts)・LbNormalizedEntry(lib/ocr-compare/types.ts)とは別の型を使う。
//
// 設計根拠: FireFlow_新捺印表OCR_誤読辞書確定版_中間表現設計_document_type設計_2026-08-11.md
// Section 2(A/P/キャンセル中間表現)・Section 3(document type設計)。
// KB-024(誤確定0優先Operation Rule)6項目すべてに対応する。

export type RawCheckboxes = {
  a_checked: boolean;
  p_checked: boolean;
  cancel_checked: boolean;
};

export type SymbolResolutionState = 'auto_confirmed' | 'needs_review';

export type SymbolResolutionReason =
  | 'MULTIPLE_SYMBOL_CHECKED'
  | 'LOW_CONFIDENCE';

export type ResolvedSymbol = {
  value: '' | 'A' | 'P' | 'キャンセル';
  state: SymbolResolutionState;
  reason?: SymbolResolutionReason;
};

export type MisreadCandidateState = 'auto_correct' | 'candidate' | 'needs_review';

export type MisreadMatch = {
  canonical: string | null;
  normalizedCode: string | null;
  state: MisreadCandidateState;
  matchedVia: 'exact_canonical' | 'exact_alias' | 'known_misread' | null;
  riskLevel: 'normal' | 'high' | null;
};

export type GridTimeReadResult = {
  value: string | null;
  raw: string;
  ok: boolean;
  reason?: 'ILLEGIBLE_DIGIT' | 'INVALID_FORMAT' | 'INCOMPLETE';
};

export type StandardizedStampRawEntry = {
  room_number: string;
  raw_checkboxes: RawCheckboxes;
  time_start_raw: string;
  time_end_raw: string;
  note_raw: string;
};

export type StandardizedStampNormalizedEntry = {
  room_number: string;
  raw_checkboxes: RawCheckboxes;
  resolved_symbol: ResolvedSymbol;
  time_start: GridTimeReadResult;
  time_end: GridTimeReadResult;
  note_raw: string;
  note_misread_match: MisreadMatch;
  needsReview: boolean;
  needsReviewReasons: string[];
};

export type StampSheetZoneName = 'room_grid' | 'time_grid' | 'remarks_area' | 'qr_code_area';

export type StampSheetZoneDefinition = {
  description: string;
  calibrated: boolean;
  coordinates: null | {
    xMinRatio: number;
    yMinRatio: number;
    xMaxRatio: number;
    yMaxRatio: number;
  };
  measurementNotes?: string;
};

export type StandardizedStampLayoutFormat = {
  layoutFormatId: string;
  effectiveFrom: string;
  pageSize: 'A4';
  zones: Record<StampSheetZoneName, StampSheetZoneDefinition>;
};
