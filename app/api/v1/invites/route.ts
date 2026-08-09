// [2026-07-20新設] 招待リンクの確認用エンドポイント(ログイン前でも見られる最小限の情報)。
// 実処理は lib/handlers/invites.ts に集約されている。
//
//   GET /api/v1/invites?id=xxx
//     → { result: { propertyName, role, roleLabel, valid, reason } }

import { handleInvitesPreflight, handleGetInviteInfo } from '@/lib/handlers/invites';

export const runtime = 'nodejs';

export async function OPTIONS(request: Request) {
  return handleInvitesPreflight(request);
}

export async function GET(request: Request) {
  return handleGetInviteInfo(request);
}
