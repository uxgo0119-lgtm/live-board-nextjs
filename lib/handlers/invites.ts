// [2026-07-20新設] 招待リンク関連(確認・受け入れ)の実処理。新URL(/api/v1/invites*)と
// 旧URL(/api/accept-invite、後方互換のため維持)の両方から呼ばれる、唯一の実装。

import { getServerEnv } from '../config/env';
import { requireSession } from '../auth/verifySession';
import { getInviteInfo, acceptInvite } from '../invites/inviteService';
import { withErrorHandling, okResponse } from '../http/errors';
import { corsHeaders, handlePreflight } from '../http/cors';

export function handleInvitesPreflight(request: Request): Response {
  const env = getServerEnv();
  return handlePreflight(request, env.ALLOWED_ORIGINS);
}

export async function handleGetInviteInfo(request: Request): Promise<Response> {
  const env = getServerEnv();
  const headers = corsHeaders(request.headers.get('origin'), env.ALLOWED_ORIGINS);
  return withErrorHandling(async () => {
    const id = new URL(request.url).searchParams.get('id');
    const result = await getInviteInfo(id);
    return okResponse(result, headers);
  }, headers);
}

export async function handleAcceptInvite(request: Request): Promise<Response> {
  const env = getServerEnv();
  const headers = corsHeaders(request.headers.get('origin'), env.ALLOWED_ORIGINS);
  return withErrorHandling(async () => {
    const session = await requireSession(request);
    const url = new URL(request.url);
    let id: string | null = url.searchParams.get('id');
    if (!id) {
      try {
        const body = (await request.json()) as { id?: string };
        id = body && body.id ? body.id : null;
      } catch {
        // idはクエリ文字列側にある想定のため、bodyが空/JSON以外でもエラーにしない
      }
    }
    const result = await acceptInvite(id, session.userId);
    return okResponse(result, headers);
  }, headers);
}
