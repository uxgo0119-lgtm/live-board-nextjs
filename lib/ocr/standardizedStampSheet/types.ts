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

// [2026-08-13改訂 実API検証フェーズ] 実Anthropic API検証で、1マス1文字グリッドの
// 「時」の十の位が空白のケース(帳票上は[空][9]:[3][0])を、モデルが勝手に"09:30"へ0補完して
// 返してくることが判明した。文字列だけを受け取る従来の構造では、この補完を後段で検知できない。
// そこでマス単位の生情報(cells)を最後まで保持し、1マスでも欠損があれば確定しない構造にする。
export type GridTimeReadResult = {
  value: string | null;
  raw: string;
  ok: boolean;
  reason?: 'ILLEGIBLE_DIGIT' | 'INVALID_FORMAT' | 'INCOMPLETE' | 'MISSING_CELL' | 'CELL_DATA_UNAVAILABLE';
  // マス単位の生読み取り値(空マスは空文字)。モデルがマス情報を返さなかった場合のみnull。
  cells?: string[] | null;
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
  // [2026-08-13追加] 時間指定エリアのどの行から時刻を結合したか(結合できていなければnull)。
  // 行番号ではなく行自身の部屋番号マスで結合した場合のみ値が入る。
  time_source_row_index?: number | null;
};

// ---------------------------------------------------------------------------
// [2026-08-13新設 実API検証フェーズ] 時間指定エリア(time_grid)専用の型。
//
// 実API検証で、1001号室の時間指定(開始10:00・終了11:30)が隣接行の1002号室へ割り当てられて
// 自動確定される誤確定が発生した。原因は、時刻を「本体グリッドの部屋行の属性」として
// 抽出させていたため、行の対応付けをモデル任せにしていたこと。
// 対策として、時間指定エリアは本体グリッドとは独立に「1行単位」(部屋番号+開始+終了+備考)で
// 抽出し、行番号ではなく行自身が持つ部屋番号マスで結合する。少しでも曖昧なら結合せず
// needs_reviewへ倒す。
// ---------------------------------------------------------------------------

// モデルから返ってくる時間指定エリアの1行の生データ。
export type StandardizedStampTimeDesignationRawRow = {
  row_index: number | null;
  room_number_cells: string[] | null;
  start_time_cells: string[] | null;
  end_time_cells: string[] | null;
  remarks_raw: string;
};

export type TimeDesignationRowState = 'auto_confirmed' | 'needs_review' | 'blank';

export type TimeDesignationReviewReason =
  | 'ROW_POSITION_UNVERIFIABLE'
  | 'ROOM_NUMBER_CELL_DATA_UNAVAILABLE'
  | 'ROOM_NUMBER_AMBIGUOUS'
  | 'ROOM_NUMBER_LEADING_ZERO'
  | 'ROOM_NOT_IN_MAIN_GRID'
  | 'ROOM_NUMBER_FORMAT_MISMATCH'
  | 'DUPLICATE_ROOM_IN_TIME_GRID'
  | 'DUPLICATE_ROOM_IN_MAIN_GRID'
  | 'TIME_START'
  | 'TIME_END'
  | 'REMARKS'
  | 'MALFORMED_CELL_VALUE';

// 部屋番号マス(1マス1文字)の読み取り結果。
export type GridRoomNumberReadResult = {
  value: string | null;
  raw: string;
  ok: boolean;
  blank: boolean;
  reason?: 'ILLEGIBLE_DIGIT' | 'MISSING_CELL' | 'INVALID_FORMAT' | 'CELL_DATA_UNAVAILABLE' | 'LEADING_ZERO';
  cells: string[] | null;
};

export type StandardizedStampTimeDesignationRow = {
  row_index: number | null;
  room_number: GridRoomNumberReadResult;
  start_time: GridTimeReadResult;
  end_time: GridTimeReadResult;
  remarks_raw: string;
  remarks_misread_match: MisreadMatch;
  // 結合先として確定できた本体グリッドの部屋番号。確定できない場合はnull(=未割当)。
  assigned_room_number: string | null;
  state: TimeDesignationRowState;
  reasons: string[];
};

// 本体グリッド+時間指定エリアをまとめて正規化した結果。
export type StandardizedStampNormalizedResult = {
  entries: StandardizedStampNormalizedEntry[];
  timeDesignationRows: StandardizedStampTimeDesignationRow[];
  // 部屋を特定できなかった/矛盾があり結合しなかった時間指定行(人手確認が必要)。
  unassignedTimeDesignationRows: StandardizedStampTimeDesignationRow[];
  duplicateRoomNumbers: string[];
  skipped: string[];
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
