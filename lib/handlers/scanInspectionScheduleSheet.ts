// [2026-07-27新設 Phase7] 「紙の点検予定表のAIスキャン」の実処理。
// lib/handlers/scanInspectionSchedule.ts(既存の点検希望時間連絡票OCR)と全く同じ構造。
// 既存のURL・レスポンス形状・エラーコードには一切影響を与えない、新規の独立したエンドポイント。

import { getServerEnv } from '../config/env';
import { requireSession } from '../auth/verifySession';
import { enforceRateLimit } from '../rateLimit/checkUsage';
import { validateOcrPayload } from '../ai/capabilities/ocr/core/commonExtractor';
import {
  scanInspectionScheduleSheet,
  MAX_BASE64_LENGTH_SINGLE,
  MAX_BASE64_LENGTH_BULK,
} from '../ai/capabilities/ocr/documentTypes/inspectionScheduleSheet';
import { withErrorHandling, okResponse, ApiError } from '../http/errors';
import { corsHeaders, handlePreflight } from '../http/cors';

const ENDPOINT_KEY = 'inspection-schedule-sheet.scan';

export function handleScanSheetPreflight(request: Request): Response {
  const env = getServerEnv();
  return handlePreflight(request, env.ALLOWED_ORIGINS);
}

export async function handleScanSheetRequest(request: Request): Promise<Response> {
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
    validateOcrPayload(mode, mediaType, data, { single: MAX_BASE64_LENGTH_SINGLE, bulk: MAX_BASE64_LENGTH_BULK });

    // ③ AI呼び出し自体はサーバー側でのみ実行される(APIキーはこのプロセス内の環境変数
    //    からのみ読まれ、レスポンスにも含まれない)
    const result = await scanInspectionScheduleSheet(mode as 'single' | 'bulk', mediaType as string, data);

    return okResponse(result, headers);
  }, headers);
}
