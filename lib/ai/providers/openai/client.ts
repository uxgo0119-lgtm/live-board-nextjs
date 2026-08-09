// [2026-07-27新設 Phase7] OpenAI Chat Completions APIの低レベル呼び出し(このプロバイダと
// どう通信するか、のみに責任を絞る)。プロンプト文言や期待する出力形状といった
// 「タスク固有の知識」は一切持たない(それは lib/ai/capabilities/ 配下の役割)。
// providers/anthropic/client.ts と同じ構造・同じエラーハンドリング方針(詳細な内部エラーを
// ブラウザへ漏らさず502へラップする・APIキーはヘッダにのみ使う)を踏襲している。
//
// 【重要】OPENAI_API_KEY を使ってOpenAIへ直接通信する、サーバー専用のコードです。
// Route Handler以外(クライアントコンポーネント等)からimportしないでください。
//
// 【環境制約による注記】このプロバイダは実際のOpenAI APIへライブ接続して検証されていません
// (このリポジトリのサンドボックス環境には実際のOPENAI_API_KEYも外部ネットワーク疎通も
// 無いため)。公開されているOpenAI Chat Completions APIの一般的な仕様理解に基づく
// ベストエフォート実装です。本番投入前に実キー・実ネットワークでの疎通確認が必要です
// (詳細はPhase7完了報告書を参照)。
//
// 【既知の制約】OpenAIのChat Completions APIの image_url コンテンツブロックは、
// 一般的な画像形式(JPEG/PNG/WEBP/GIF等)のみを想定しており、PDFファイルをそのまま
// image_urlのdata URIとして渡せる保証はない(Anthropicのdocumentブロックのような
// 「PDFをそのまま渡せる」専用の入力形式は、Chat Completions APIには無い可能性がある)。
// そのため mode:'bulk'(PDF入力)でOpenAIプロバイダを使う場合は、ライブ検証時に
// 別途PDF→画像変換や、OpenAIのFiles API/Responses API等の代替手段の要否を確認すること。

import { ApiError } from '../../../http/apiError';
import { getServerEnv } from '../../../config/env';

const OPENAI_MODEL = 'gpt-4o';
const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';

export type OpenAiContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export type OpenAiChatRequest = {
  maxTokens: number;
  content: OpenAiContentBlock[];
};

// 成功時はテキストパートを結合した生の文字列を返す(JSONとしてのパースは
// 呼び出し側=capabilities層の責務とする)。
export async function callOpenAiChat(request: OpenAiChatRequest): Promise<string> {
  const env = getServerEnv();

  if (!env.OPENAI_API_KEY) {
    // TASK_ROUTINGでopenaiが選ばれない限りこの関数は呼ばれない想定だが、万一設定不備の
    // まま呼ばれた場合に、原因不明の例外ではなく分かりやすいエラーにするためここで弾く。
    console.error('[fireflow-api] OPENAI_API_KEY is not configured but the OpenAI provider was invoked');
    throw new ApiError(500, 'AI読み取りサービス(OpenAI)が設定されていません。管理者にご連絡ください。');
  }

  const openaiRes = await fetch(OPENAI_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + env.OPENAI_API_KEY,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      max_tokens: request.maxTokens,
      messages: [
        {
          role: 'user',
          content: request.content,
        },
      ],
    }),
  });

  const openaiData = await openaiRes.json();

  if (!openaiRes.ok || openaiData.error) {
    const apiMsg = openaiData.error && openaiData.error.message ? openaiData.error.message : 'HTTPエラー ' + openaiRes.status;
    // [2026-07-27] OpenAI側のエラーメッセージをそのままブラウザへ転送すると、稀に内部的な
    // 詳細情報が混ざる可能性があるため、ログには全文を残しつつ、ブラウザへ返すのは
    // 定型メッセージ+短い要約のみにする(既存のAnthropicアダプタと同じ方針)。
    console.error('[fireflow-api] openai error:', apiMsg);
    throw new ApiError(502, 'AI読み取りサービスでエラーが発生しました。しばらくしてからもう一度お試しください。');
  }

  const choices = Array.isArray(openaiData.choices) ? openaiData.choices : [];
  const firstMessage = choices.length > 0 ? choices[0].message : null;
  const text = firstMessage && typeof firstMessage.content === 'string' ? firstMessage.content : '';
  return text;
}
