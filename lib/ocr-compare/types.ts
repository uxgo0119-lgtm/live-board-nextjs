// lib/ocr-compare/types.ts
//
// [2026-08-05新設] 捺印表(点検希望時間連絡票)OCR Anthropic／Gemini比較検証基盤の共通型。
//
// 【このディレクトリ全体について】
// lib/ocr-compare/ は、本番のOCR経路(app/api/scan-time-request/route.ts →
// lib/handlers/scanInspectionSchedule.ts → lib/ai/capabilities/ocr/documentTypes/
// residentTimeRequestSheet.ts、いずれもAnthropicベース)とは完全に分離した、
// 開発・検証専用のCLIツールである。本番経路のコード(lib/ai/providers/*/ocr.ts、
// lib/handlers/、app/api/**)は1バイトも変更しない。本番でAnthropicが引き続き
// 使われ続けること、Geminiが本番の既定値にならないことは、
// lib/ai/config/taskRouting.ts の既定値(TASK_ROUTING)を変更していないことで担保している。
//
// 【なぜ既存のOcrCapability(scan())をそのまま呼ばないか】
// lib/ai/providers/{anthropic,gemini}/ocr.ts の scan() は「パース済みJSONを返す」до
// までが責務で、①プロバイダから返った生テキスト(パース前)を呼び出し元へ渡さない。
// 本比較基盤は最重要方針(ユーザー指定)により、
//   ①Providerから返された生データ ②JSON解析・正規化後のデータ ③LBへ渡す直前の最終データ
// の3段階すべてを保持する必要があるため、providers/*/ocr.ts (Adapter)は変更せず、
// その1段下のクライアント関数(callAnthropicMessages / callGeminiGenerateContent、
// 既存・無改修)を直接呼び出し、本ディレクトリ側で①〜③を組み立てる。

import type { StampSheetEntry } from '../ocr-benchmark/types';
// [2026-08-06追加 評価ロジックP0改善] 時刻・日付の「表記差のみ」と「本当の不一致」を
// 区別するための比較専用型。値そのものの正規化・書き換えではなく、比較結果の判定情報。
import type { FieldComparisonDetail } from './normalizeTimeAndDate';

export type OcrCompareProviderKey = 'anthropic' | 'gemini';

export type OcrCompareMode = 'single' | 'bulk';

// ①Providerから返された生データ(パース前のテキスト、またはHTTPエラー等の失敗理由)。
export type ProviderRawStage = {
  ok: boolean;
  // 実際にAPIキーが設定され、実APIへ通信を試みたか。falseの場合、rawText等は
  // 一切実測値ではない(呼び出し自体を行っていない)ことを示す。
  attempted: boolean;
  rawText: string | null;
  errorMessage: string | null;
  processingTimeMs: number | null;
};

// ②JSON解析・正規化後のデータ(extractJsonFromModelTextDetailedでのパース結果。
// 配列でなければbulkモードではエラー扱いとする既存Adapterと同じ判定をここでも行う)。
//
// [2026-08-05追加 P0] extractionMethod(raw/markdown/bracketのどれで抽出できたか)と
// schemaValidation(必須フィールドの存在・型チェック結果)を追加。実測比較で
// 「JSON解析には成功したが、想定と違うフィールド構成だった」ケースを区別できるように
// するため(JSON解析失敗とスキーマ違反は原因が異なるため、別々に記録する)。
export type ProviderParsedStage = {
  ok: boolean;
  parsed: unknown | null;
  errorMessage: string | null;
  extractionMethod: 'raw' | 'markdown' | 'bracket' | null;
  schemaValidation: { ok: true } | { ok: false; reason: string } | null;
};

// ③LBへ渡す直前の最終データ(lb_tool/index.html の applyStampSingleOcrResult /
// applyStampBulkResult のフィールド正規化ロジックをNode側へ移植したもの)。
// 【重要な既知の制約】date→scheduleDate/scheduleDayへの正規化(resolveStampScheduleDate/
// normalizeStampDateRaw)は、LB側の実行時状態(PROPERTY.scheduleDays、物件ごとに登録された
// 点検実施日一覧)に依存しており、この物件非依存のスタンドアロンCLIでは再現できない。
// そのため date は原文のまま(dateRaw)保持し、scheduleDate/scheduleDayの正規化は行わない
// (誤った正規化ロジックを重複実装してLB側とズレるリスクを避けるため、意図的に未実装とし、
// その旨をレポートに明記する)。
export type LbNormalizedEntry = {
  room_number: string;
  symbol: '' | 'A' | 'P' | 'キャンセル';
  time: string;
  time_end: string;
  note: string;
  name: string;
  dateRaw: string;
};

export type ProviderLbStage = {
  ok: boolean;
  entries: LbNormalizedEntry[] | null;
  errorMessage: string | null;
};

export type ProviderRunResult = {
  provider: OcrCompareProviderKey;
  stage1Raw: ProviderRawStage;
  stage2Parsed: ProviderParsedStage;
  stage3Lb: ProviderLbStage;
};

// 正解データ(人間が原紙を確認して作成したもののみを正解として扱う。AI同士の多数決は
// 一切使わない)。lib/ocr-benchmark/types.ts の StampSheetEntry をそのまま再利用する
// (既存のOCRベンチマーク基盤と同じ形式にすることで、ground truthファイルの使い回しや
// 既存ツールとの相互運用を可能にする)。
export type GroundTruthEntry = StampSheetEntry;

export type FieldCompareKey = 'symbol_ampm' | 'symbol_cancel' | 'time_range' | 'blank';

// 部屋1件・1プロバイダぶんの項目別比較結果。
export type RoomFieldComparison = {
  room_number: string;
  presentInGroundTruth: boolean;
  presentInOcrResult: boolean;
  // 部屋番号自体は検出できたが、正解データに存在しない(=存在しない部屋を追加した)。
  isPhantomRoom: boolean;
  // 正解データには存在するが、OCR結果に検出されなかった(=欠落)。
  isMissingRoom: boolean;
  fieldMatches: Partial<Record<'symbol' | 'time' | 'time_end' | 'note' | 'name' | 'date', boolean>>;
  expected: Partial<LbNormalizedEntry> | null;
  actual: Partial<LbNormalizedEntry> | null;
  // [2026-08-06追加 評価ロジックP0改善] gt・actual双方が存在する部屋のみ設定される。
  // fieldMatches.time / fieldMatches.date (既存・完全文字列一致)とは別に、
  // 「表記差のみ(意味は同じ)」か「本当の不一致」かを区別するための詳細情報。
  // 既存のfieldMatchesの意味・算出方法は一切変更していない(このフィールドは追加のみ)。
  timeDetail?: FieldComparisonDetail;
  dateDetail?: FieldComparisonDetail;
};

export type ProviderAccuracySummary = {
  provider: OcrCompareProviderKey;
  totalGroundTruthRooms: number;
  totalOcrRooms: number;
  missingRoomCount: number; // 正解にあるがOCR結果に無い(欠落)
  phantomRoomCount: number; // OCR結果にあるが正解に無い(存在しない部屋の追加)
  roomNumberRecognitionRate: number; // (正解件数 - 欠落件数) / 正解件数
  fieldAccuracy: Record<'symbol' | 'time' | 'time_end' | 'note' | 'name' | 'date', number | null>;
  ampmAccuracy: number | null; // symbolが'A'|'P'の項目に限定した一致率
  cancelAccuracy: number | null; // symbolが'キャンセル'の項目に限定した一致率
  blankAccuracy: number | null; // 正解がsymbol=''かつtime=''(空欄)の項目に限定した一致率
  processingTimeMs: number | null;

  // [2026-08-06追加 評価ロジックP0改善]
  // 既存のfieldAccuracy.time / time_end / date は完全文字列一致(トリムなし)であり、
  // その算出方法・意味は一切変更していない。timeRawAccuracy等は、それらと全く同じ値を
  // 分かりやすい名前で参照できるようにしたエイリアスである(=fieldAccuracy.timeそのもの)。
  timeRawAccuracy: number | null;
  timeEndRawAccuracy: number | null;
  dateRawAccuracy: number | null;

  // 意味比較(表記差を無視した一致率)。分母は既存のfieldAccuracyと同じ
  // 「OCR側で部屋が見つかった正解データ件数」(欠落部屋は含まない)。
  // 分子は、正解データ側に値がある/ないに関わらず、意味的に一致した件数のみ。
  // 【重要】Ground Truthに値がありOCR側が空欄(missing)の場合はsemanticMatch=falseとして
  // 分母に含めたまま不一致に数える(意味一致率を誤って高く見せない)。
  timeSemanticAccuracy: number | null;
  timeEndSemanticAccuracy: number | null;
  dateSemanticAccuracy: number | null;

  // [2026-08-07追加 評価器P0改善 Phase1-C] comparisonStatus(normalizeTimeAndDate.ts)の
  // 内訳件数。分母はtimeSemanticAccuracy等と同じfoundCount(欠落部屋は含まない)。
  // time系はtimeフィールドのみを対象とする(time_endは対象外。依頼の集計項目に無いため)。
  timeFormatOnlyDifferenceCount: number; // 表記差のみ(9:00 vs 09:00等)
  timeActualMismatchCount: number; // 本当の不一致(丸めない。9:30 vs 9:00等)
  timeMissingCount: number; // Ground Truthに値がありOCR側が空欄
  timeUnparseableCount: number; // どちらかがパースできず意味比較不能

  // 日付側の内訳。「Ground Truthに値がありOCR側が空欄だった件数」(missing)と
  // 「どちらか一方でもパースできず意味比較ができなかった件数」(unparseable)に加え、
  // 「表記差のみ」「本当の不一致」も別途集計する(ユーザー指定の集計項目)。
  dateFormatOnlyDifferenceCount: number;
  dateActualMismatchCount: number;
  dateMissingCount: number;
  dateUnparseableCount: number;
};

// npm run ocr:compare 1回分の実行結果全体(JSON/HTMLレポートの元データ)。
export type OcrCompareRunReport = {
  generatedAtIso: string;
  inputFilePath: string;
  mode: OcrCompareMode;
  mediaType: string;
  groundTruthFilePath: string | null;
  groundTruthRoomCount: number | null;
  providerResults: ProviderRunResult[];
  accuracySummaries: ProviderAccuracySummary[] | null; // 正解データが無い場合はnull
  roomComparisons: Record<OcrCompareProviderKey, RoomFieldComparison[]> | null; // 正解データが無い場合はnull
  namesRedacted: boolean;
};
