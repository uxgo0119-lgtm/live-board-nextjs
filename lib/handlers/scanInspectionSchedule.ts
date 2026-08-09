// [2026-07-20新設] 「点検希望時間連絡票のAIスキャン」の実処理。新URL
// (app/api/v1/inspection-schedule/scan/route.ts)と旧URL
// (app/api/scan-time-request/route.ts、後方互換のため維持)の両方から呼ばれる、
// 唯一の実装(重複を避けるためここに1箇所だけ置く)。

import { getServerEnv } from '../config/env';
import { requireSession } from '../auth/verifySession';
import { enforceRateLimit } from '../rateLimit/checkUsage';
import { validateOcrPayload, scanInspectionScheduleSlip } from '../ai/capabilities/ocr/inspectionSchedule';
import { withErrorHandling, okResponse, ApiError } from '../http/errors';
import { corsHeaders, handlePreflight } from '../http/cors';

const ENDPOINT_KEY = 'inspection-schedule.scan';

export function handleScanPreflight(request: Request): Response {
  const env = getServerEnv();
  return handlePreflight(request, env.ALLOWED_ORIGINS);
}

export async function handleScanRequest(request: Request): Promise<Response> {
  const env = getServerEnv();
  const headers = corsHeaders(request.headers.get('origin'), env.ALLOWED_ORIGINS);

  return withErrorHandling(async () => {
    // ① ログイン確認(未ログインなら401)
    const session = await requireSession(request);

    // ② 利用回数制限(直近バースト・1日あたりのユーザー別/全体上限)
    await enforceRateLimit(session.userId, ENDPOINT_KEY);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new ApiError(400, 'リクエストの形式が不正です（JSONとして解析できません）。');
    }
    const { mode, mediaType, data } = (body || {}) as Record<string, unknown>;
    validateOcrPayload(mode, mediaType, data);

    // ③ AI呼び出し自体はサーバー側でのみ実行される(ANTHROPIC_API_KEYはこのプロセス内
    //    の環境変数からのみ読まれ、レスポンスにも含まれない)
    const result = await scanInspectionScheduleSlip(mode as 'single' | 'bulk', mediaType as string, data);

    return okResponse(result, headers);
  }, headers);
}
