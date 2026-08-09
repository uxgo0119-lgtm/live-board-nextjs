// lib/ocr-benchmark/types.ts
//
// [2026-07-28新設] Google Cloud Vision API / Document AI の精度をベンチマークするための
// 共通中間形式。
//
// 【重要: このディレクトリ全体について】
// lib/ocr-benchmark/ 配下は、本番のOCR経路(app/api/scan-time-request/route.ts →
// lib/handlers/scanInspectionSchedule.ts → lib/ai/capabilities/ocr/documentTypes/
// residentTimeRequestSheet.ts、いずれもAnthropic/Claudeベース)とは完全に独立した、
// 「捺印表(点検希望時間連絡票)OCRについて、Google Cloud Vision API と Google Document AI
// (Document OCRプロセッサ)の読み取り精度を実データで比較検証する」ためのベンチマーク専用
// モジュール一式である。本番経路のコードは1バイトも参照・変更しない。本番ルートへの配線・
// 統合は今回のスコープに含まない(比較結果を見てから別途判断する)。
//
// 【なぜ共通中間形式が必要か(設計意図)】
// Cloud Vision API(documentTextDetection)とDocument AI(processDocument、Document OCR
// プロセッサ)は、レスポンスのJSON構造がまったく異なる。
//   - Vision: fullTextAnnotation.pages[].blocks[].paragraphs[].words[].symbols[] という
//     ネスト構造で、各wordがピクセル単位のboundingBox(vertices)を持つ。
//   - Document AI: document.text という1本の全文文字列があり、document.pages[].tokens[]の
//     各tokenはlayout.textAnchor.textSegments[]でその全文文字列中のstartIndex/endIndexを
//     指し示す(= 文字列そのものではなく参照)。座標はlayout.boundingPoly.normalizedVertices
//     として0〜1の正規化値で返る。
// この差異を lib/ocr-benchmark/stampGridParser.ts (実際の捺印表レイアウトを解析するグリッド
// パーサー)へそのまま持ち込むと、パースロジックをプロバイダごとに書き分けることになり、
// 「同じレイアウト解析ロジックに、同じ条件(単語+座標)でテキストを渡した場合に、どちらの
// プロバイダの生テキスト検出がより正確か」という、このベンチマークが本来測りたい条件を
// 崩してしまう。そこで、各プロバイダのラッパー(visionOcr.ts / documentAiOcr.ts)側で
// この共通形式へ変換し、stampGridParser.ts はプロバイダ名を一切知らずに動作できるように
// している。
//
// 【座標系】x/y/width/heightは、いずれもページ幅・高さに対する0〜1の正規化値とする。
// - Document AIのnormalizedVerticesはAPIレスポンスがそのまま0〜1で返すため無変換で使う。
// - Vision APIのboundingBox(vertices)はピクセル単位で返るため、ラッパー側で
//   fullTextAnnotation.pages[].width/height を使って0〜1へ正規化してからこの形式に
//   詰め直す(visionOcr.ts の extractWordsFromVisionResponse 参照)。

export interface OcrBoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OcrWord {
  text: string;
  boundingBox: OcrBoundingBox;
}

export type OcrProviderName = 'vision' | 'documentai';

export interface OcrPageResult {
  words: OcrWord[];
  // Visionはページのピクセルサイズが分かるため参考情報として残す(Document AI側は
  // normalizedVerticesがそのまま入るためページサイズを知らなくても正規化できる)。
  pageWidthPx?: number;
  pageHeightPx?: number;
}

export interface OcrProviderResult {
  provider: OcrProviderName;
  words: OcrWord[];
  pages: OcrPageResult[];
  processingTimeMs: number;
  rawText: string;
}

// 捺印表(点検希望時間連絡票)1件分のJSON形式。
// 【絶対に守ること】LB側(/tmp/lb_tool/index.html)の applyStampBulkResult /
// applyStampSingleOcrResult / #stampReviewSave が期待する既存のJSON形式に厳密に合わせる。
// (lib/ai/capabilities/ocr/documentTypes/residentTimeRequestSheet.ts の
// SINGLE_PROMPT/BULK_PROMPT が実際に返す形式と1対1で一致させている。)
export const STAMP_SYMBOL_VALUES = ['A', 'P', 'キャンセル', ''] as const;
export type StampSymbol = (typeof STAMP_SYMBOL_VALUES)[number];

export interface StampSheetEntry {
  room_number: string;
  symbol: StampSymbol;
  time: string;
  time_end: string;
  note: string;
  name: string;
  // 「25(土)」のような日付の原文表記(年が無くても可)。読み取れなければ空文字。
  // 年月の補完・ISO日付への正規化はLB側 index.html の normalizeStampDateRaw() が担当するため、
  // ここでは原文のまま返せばよい(resolveStampScheduleDate/normalizeStampDateRawの実装を
  // 確認済み)。
  date: string;
}
