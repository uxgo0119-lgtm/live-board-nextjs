// [2026-07-20新設] 後方互換エイリアス。既存の index.html・join.html はまだ旧URL
// (/api/accept-invite、GETは確認・POSTは受け入れ)を呼んでいる。フロントエンド側の
// 変更を最小限にするため、この旧URLを維持しつつ、中身は lib/handlers/invites.ts の
// 実装をそのまま使う(app/api/v1/invites, app/api/v1/invites/accept と完全に同じ処理)。
// 新規の呼び出しは /api/v1/invites 系を使ってください。

import { handleInvitesPreflight, handleGetInviteInfo, handleAcceptInvite } from '@/lib/handlers/invites';

export const runtime = 'nodejs';

export async function OPTIONS(request: Request) {
  return handleInvitesPreflight(request);
}

export async function GET(request: Request) {
  return handleGetInviteInfo(request);
}

export async function POST(request: Request) {
  return handleAcceptInvite(request);
}
