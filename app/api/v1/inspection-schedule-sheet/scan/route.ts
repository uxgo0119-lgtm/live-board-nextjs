// [2026-07-27新設 Phase7] 紙の点検予定表のAIスキャン(OCR) Route Handler。
// 実処理は lib/handlers/scanInspectionScheduleSheet.ts に集約されている。
// app/api/v1/inspection-schedule/scan/route.ts(既存の点検希望時間連絡票OCR)と全く同じ構造。
//
//   POST /api/v1/inspection-schedule-sheet/scan
//   ヘッダ: Authorization: Bearer <ログイン中ユーザーのSupabaseアクセストークン>
//   body: { mode: 'single' | 'bulk', mediaType: 'image/jpeg'等, data: 'base64文字列' }
//   response: { result: InspectionScheduleSheetOcrRoomResult[] }
//     (lb_tool/ocr_intake/mock_ocr_provider.js の rawRooms と同じ形の配列)

import { handleScanSheetPreflight, handleScanSheetRequest } from '@/lib/handlers/scanInspectionScheduleSheet';

export const runtime = 'nodejs';
// 画像/PDFのAI読み取りは数十秒かかることがあるため、Vercelの実行時間上限を延長する。
export const maxDuration = 120;

export async function OPTIONS(request: Request) {
  return handleScanSheetPreflight(request);
}

export async function POST(request: Request) {
  return handleScanSheetRequest(request);
}
