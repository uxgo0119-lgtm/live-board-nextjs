// [2026-07-27新設 Phase7] Google Gemini generateContent APIの低レベル呼び出し(このプロバイダと
// どう通信するか、のみに責任を絞る)。プロンプト文言や期待する出力形状といった
// 「タスク固有の知識」は一切持たない(それは lib/ai/capabilities/ 配下の役割)。
// providers/anthropic/client.ts と同じ構造・同じエラーハンドリング方針を踏襲している。
//
// 【重要】GEMINI_API_KEY を使ってGoogle Generative Language APIへ直接通信する、
// サーバー専用のコードです。Route Handler以外(クライアントコンポーネント等)から
// importしないでください。APIキーはURLクエリパラメータではなく `x-goog-api-key` ヘッダで
// 送る(URLに含めるとアクセスログ等に残りやすいため、ヘッダ方式を採用している)。
//
// 【環境制約による注記】このプロバイダは実際のGemini APIへライブ接続して検証されていません
// (このリポジトリのサンドボックス環境には実際のGEMINI_API_KEYも外部ネットワーク疎通も
// 無いため)。公開されているGemini generateContent APIの一般的な仕様理解に基づく
// ベストエフォート実装です。本番投入前に実キー・実ネットワークでの疎通確認と、
// モデル名(下記GEMINI_MODEL)が現行の提供モデル名と一致しているかの確認が必要です
// (詳細はPhase7完了報告書を参照)。

import { ApiError } from '../../../http/apiError';
import { getServerEnv } from '../../../config/env';

const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/' + GEMINI_MODEL + ':generateContent';

export type GeminiPart = { text: string } | { inlineData: { mimeType: string; data: string } };

export type GeminiGenerateRequest = {
  maxTokens: number;
  parts: GeminiPart[];
};

// 成功時はテキストパートを結合した生の文字列を返す(JSONとしてのパースは
// 呼び出し側=capabilities層の責務とする)。
export async function callGeminiGenerateContent(request: GeminiGenerateRequest): Promise<string> {
  const env = getServerEnv();

  if (!env.GEMINI_API_KEY) {
    console.error('[fireflow-api] GEMINI_API_KEY is not configured but the Gemini provider was invoked');
    throw new ApiError(500, 'AI読み取りサービス(Gemini)が設定されていません。管理者にご連絡ください。');
  }

  const geminiRes = await fetch(GEMINI_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': env.GEMINI_API_KEY,
    },
    body: JSON.stringify({
      contents: [
        {
          role: 'user',
          parts: request.parts,
        },
      ],
      generationConfig: {
        maxOutputTokens: request.maxTokens,
      },
    }),
  });

  const geminiData = await geminiRes.json();

  if (!geminiRes.ok || geminiData.error) {
    const apiMsg = geminiData.error && geminiData.error.message ? geminiData.error.message : 'HTTPエラー ' + geminiRes.status;
    console.error('[fireflow-api] gemini error:', apiMsg);
    throw new ApiError(502, 'AI読み取りサービスでエラーが発生しました。しばらくしてからもう一度お試しください。');
  }

  const candidates = Array.isArray(geminiData.candidates) ? geminiData.candidates : [];
  const firstCandidate = candidates.length > 0 ? candidates[0] : null;
  const parts = firstCandidate && firstCandidate.content && Array.isArray(firstCandidate.content.parts) ? firstCandidate.content.parts : [];
  const text = parts
    .filter((p: { text?: unknown }) => typeof p.text === 'string')
    .map((p: { text: string }) => p.text)
    .join('');
  return text;
}
