// [2026-07-20新設 / 2026-07-27改訂Phase7] 後方互換ラッパー。
//
// このファイルの中身は、設計書1.1a「共通OCRエンジン層」の導入に伴い
// documentTypes/residentTimeRequestSheet.ts へ移設された(プロンプト文言・max_tokens・
// サイズ上限・エラーメッセージは1文字も変更していない)。
//
// 既存の呼び出し元(lib/handlers/scanInspectionSchedule.ts、
// test/unit/ai/capabilities/inspectionSchedule.test.ts)は、このファイルを
// `'../../../../lib/ai/capabilities/ocr/inspectionSchedule'` というパスでimportしたまま
// 変更していない。このファイルが移設先を re-export するだけの薄いラッパーになることで、
// 既存の呼び出し元・既存のテストを1文字も変更せずに動き続けさせる(後方互換性の維持)。
//
// 新規コードからは、直接 documentTypes/residentTimeRequestSheet.ts をimportしてよい
// (このラッパーを経由する必然性はない)。ただし旧パスも今後廃止する予定はない。
export {
  validateOcrPayload,
  scanInspectionScheduleSlip,
  MAX_BASE64_LENGTH_SINGLE,
  MAX_BASE64_LENGTH_BULK,
} from './documentTypes/residentTimeRequestSheet';
