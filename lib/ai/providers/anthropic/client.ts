// [2026-07-20新設] Anthropic Messages APIの低レベル呼び出し(このプロバイダとどう
// 通信するか、のみに責任を絞る)。プロンプト文言や期待する出力形状といった
// 「タスク固有の知識」は一切持たない(それは lib/ai/capabilities/ 配下の役割)。
//
// 旧 lib/ai/anthropic.ts の通信部分をそのまま移設したもので、モデル名・
// APIエンドポイント・エラーハンドリングの挙動は一切変更していない。
//
// 【重要】ANTHROPIC_API_KEY を使ってAnthropicへ直接通信する、サーバー専用の
// コードです。Route Handler以外(クライアントコンポーネント等)からimportしないで
// ください。

import { ApiError } from '../../../http/apiError';
import { getServerEnv } from '../../../config/env';

const ANTHROPIC_MODEL = 'claude-sonnet-4-6';
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

export type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'document'; source: { type: 'base64'; media_type: string; data: string } };

export type AnthropicMessagesRequest = {
  maxTokens: number;
  content: AnthropicContentBlock[];
};

// 成功時はテキストパートを結合した生の文字列を返す(JSONとしてのパースは
// 呼び出し側=capabilities層の責務とする)。
export async function callAnthropicMessages(request: AnthropicMessagesRequest): Promise<string> {
  const env = getServerEnv();

  const anthropicRes = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: request.maxTokens,
      messages: [
        {
          role: 'user',
          content: request.content,
        },
      ],
    }),
  });

  const anthropicData = await anthropicRes.json();

  if (!anthropicRes.ok || anthropicData.type === 'error') {
    const apiMsg =
      anthropicData.error && anthropicData.error.message ? anthropicData.error.message : 'HTTPエラー ' + anthropicRes.status;
    // [2026-07-20改善] Anthropic側のエラーメッセージをそのままブラウザへ転送すると、
    // 稀に内部的な詳細情報が混ざる可能性があるため、ログには全文を残しつつ、
    // ブラウザへ返すのは定型メッセージ+短い要約のみにする。
    console.error('[fireflow-api] anthropic error:', apiMsg);
    throw new ApiError(502, 'AI読み取りサービスでエラーが発生しました。しばらくしてからもう一度お試しください。');
  }

  const textParts = (anthropicData.content || [])
    .filter((b: { type: string }) => b.type === 'text')
    .map((b: { text: string }) => b.text);
  return textParts.join('');
}
