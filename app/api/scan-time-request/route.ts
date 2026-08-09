// [2026-07-20新設] 後方互換エイリアス。既存の index.html はまだ旧URL
// (/api/scan-time-request)を呼んでいる。フロントエンド側の変更を最小限にする
// (=既に本番で動いている静的HTMLの通信先を書き換えて壊すリスクを避ける)ため、
// この旧URLを維持しつつ、中身は lib/handlers/scanInspectionSchedule.ts の実装を
// そのまま使う(app/api/v1/inspection-schedule/scan/route.ts と完全に同じ処理)。
// 新規の呼び出しは /api/v1/inspection-schedule/scan を使ってください。

import { handleScanPreflight, handleScanRequest } from '@/lib/handlers/scanInspectionSchedule';

export const runtime = 'nodejs';
export const maxDuration = 120;

export async function OPTIONS(request: Request) {
  return handleScanPreflight(request);
}

export async function POST(request: Request) {
  return handleScanRequest(request);
}
