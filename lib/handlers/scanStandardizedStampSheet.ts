// [2026-08-13新設 新捺印表 実アップロード導線接続]
// 「新捺印表(standardized stamp sheet、A4 1枚に全戸のA/P/キャンセル欄)のAIスキャン」の実処理。
// lib/handlers/scanInspectionScheduleSheet.ts と全く同じ構造(認証→レート制限→入力検証→AI呼び出し)。
//
// 【なぜ必要だったか】新捺印表OCR(scanStandardizedStampSheet)と正規化・LB変換
// (normalizeStandardizedStampScan / toLiveBoardStampData)はlib配下に実装済みだったが、
// これらを呼び出すHTTPエンドポイントが存在しなかったため、ブラウザ(public/index.html)から
// 到達する手段が無く、実際のアップロード操作は既存Legacyの /api/scan-time-request
// (点検希望時間連絡票=部屋ごとに1枚の連絡票)だけを通っていた。
//
// 【このエンドポイントの責務】ブラウザ側は1.6MBの単一HTMLで、lib配下のTypeScriptを
// import できない。そのため「OCR → 正規化 → LB用stamp dataへの変換」までをサーバー側で
// 完結させ、ブラウザにはそのまま部屋カードへ反映できる形(stampData)だけを返す。
// 判断ロジック(複数チェックを収束させない/空マスを補完しない)は全てサーバー側の
// 既存モジュールがそのまま担うため、ブラウザ側に判断は一切持たせない。
//
// 【既存経路への影響】無し。既存の /api/scan-time-request・
// /api/v1/inspection-schedule-sheet/scan・/api/v1/inspection-schedule/scan の
// URL・レスポンス形状・エラーコードには一切手を加えていない、独立した新規エンドポイント。

import { getServerEnv } from '../config/env';
import { requireSession } from '../auth/verifySession';
import { enforceRateLimit } from '../rateLimit/checkUsage';
import {
  scanStandardizedStampSheet,
  validateOcrPayload,
} from '../ai/capabilities/ocr/documentTypes/standardizedStampSheet';
import { normalizeStandardizedStampScan } from '../ocr/standardizedStampSheet/normalizeStandardizedStamp';
import { toLiveBoardStampData } from '../ocr/standardizedStampSheet/toLiveBoardStampData';
import { withErrorHandling, okResponse, ApiError } from '../http/errors';
import { corsHeaders, handlePreflight } from '../http/cors';

const ENDPOINT_KEY = 'standardized-stamp-sheet.scan';

export function handleStandardizedStampScanPreflight(request: Request): Response {
  const env = getServerEnv();
  return handlePreflight(request, env.ALLOWED_ORIGINS);
}

export async function handleStandardizedStampScanRequest(request: Request): Promise<Response> {
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
    // サイズ上限は新捺印表側の定義(documentTypes/standardizedStampSheet.ts)をそのまま使う。
    validateOcrPayload(mode, mediaType, data);

    // ③ AI呼び出し(APIキーはこのプロセス内の環境変数からのみ読まれ、レスポンスには含まれない)
    const scan = await scanStandardizedStampSheet(mode as 'single' | 'bulk', mediaType as string, data);

    // ④ 正規化(複数チェック・空マス・重複部屋番号の判定はすべてここで完結する)
    const normalized = normalizeStandardizedStampScan(scan);

    // ⑤ Live Board用stamp dataへ変換
    const lb = toLiveBoardStampData(normalized);


    return okResponse(
      {
        stampData: lb.stampData,
        needsReviewRooms: lb.needsReviewRooms,
        skippedRooms: lb.skippedRooms,
        roomCount: Object.keys(lb.stampData).length,
        // 部屋を特定できなかった時間指定行の件数(ブラウザ側の注意喚起表示用)。
        unassignedTimeDesignationRowCount: lb.unassignedTimeDesignationRowCount,
        // [2026-08-15追加 Phase 2 実LB最終確認②] 同じ行で「読めていた内容」(開始/終了時刻・
        // 備考の原文・部屋番号マスの見え方)。従来は件数だけを返しており、部屋へ結合できな
        // かった行で確実に読めていた時刻・備考がここで完全に失われていた(801号室の消失経路)。
        // どの部屋にも書き込まないため誤確定は増えず、利用者は原本のどの行かを特定できる。
        unassignedTimeDesignations: lb.unassignedTimeDesignations,
        qrCodeRaw: scan.qr_code_raw,
      },
      headers
    );
  }, headers);
}
