// [2026-08-13新設 新捺印表 実アップロード導線接続] 新捺印表のAIスキャン(OCR) Route Handler。
// 実処理は lib/handlers/scanStandardizedStampSheet.ts に集約されている。
// app/api/v1/inspection-schedule-sheet/scan/route.ts と全く同じ構造。
//
//   POST /api/v1/standardized-stamp-sheet/scan
//   ヘッダ: Authorization: Bearer <ログイン中ユーザーのSupabaseアクセストークン>
//   body: { mode: 'single' | 'bulk', mediaType: 'image/jpeg'等, data: 'base64文字列' }
//   response: { result: { stampData, needsReviewRooms, skippedRooms, roomCount,
//                         unassignedTimeDesignationRowCount, unassignedTimeDesignations,
//                         qrCodeRaw } }
//     stampData は lib/ocr/standardizedStampSheet/toLiveBoardStampData.ts の変換済みデータで、
//     そのまま Live Board の applyStandardizedStampDataToLb() へ渡せる形。

import {
  handleStandardizedStampScanPreflight,
  handleStandardizedStampScanRequest,
} from '@/lib/handlers/scanStandardizedStampSheet';

export const runtime = 'nodejs';
// 画像/PDFのAI読み取りは数十秒かかることがあるため、Vercelの実行時間上限を延長する。
export const maxDuration = 120;

export async function OPTIONS(request: Request) {
  return handleStandardizedStampScanPreflight(request);
}

export async function POST(request: Request) {
  return handleStandardizedStampScanRequest(request);
}
