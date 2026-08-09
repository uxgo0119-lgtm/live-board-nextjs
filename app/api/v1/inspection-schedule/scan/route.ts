// [2026-07-20新設] 点検希望時間連絡票のAIスキャン(OCR) Route Handler。
// 実処理は lib/handlers/scanInspectionSchedule.ts に集約されている(旧URL
// /api/scan-time-request からも同じ実装を呼んでいる。後方互換の経緯は
// app/api/scan-time-request/route.ts のコメント参照)。
//
//   POST /api/v1/inspection-schedule/scan
//   ヘッダ: Authorization: Bearer <ログイン中ユーザーのSupabaseアクセストークン>
//   body: { mode: 'single' | 'bulk', mediaType: 'image/jpeg'等, data: 'base64文字列' }

import { handleScanPreflight, handleScanRequest } from '@/lib/handlers/scanInspectionSchedule';

export const runtime = 'nodejs';
// 画像/PDFのAI読み取りは数十秒かかることがあるため、Vercelの実行時間上限を延長する。
export const maxDuration = 120;

export async function OPTIONS(request: Request) {
  return handleScanPreflight(request);
}

export async function POST(request: Request) {
  return handleScanRequest(request);
}
