// [2026-07-20新設] OcrCapability の Anthropic実装(Adapter)。
// 「OcrInputをAnthropicのcontent block形式に変換して呼び出し、返答テキストを
// JSONとして取り出す」というプロバイダ固有の変換のみを行う。プロンプト文言や
// 入力サイズ上限といったタスク固有の知識は持たない(呼び出し元の
// lib/ai/capabilities/ocr/inspectionSchedule.ts が組み立てて渡す)。
//
// 旧 lib/ai/anthropic.ts のレスポンス解析部分をそのまま移設したもので、
// エラーハンドリングの挙動(502へのラップ・配列チェック等)は変更していない。

import { ApiError } from '../../../http/apiError';
import type { OcrCapability, OcrInput, OcrOutput } from '../../types';
import { callAnthropicMessages } from './client';
import { stripJsonFences, extractJsonFromModelText } from '../../shared/extractJsonFromModelText';

export const anthropicOcrCapability: OcrCapability = {
  async scan(input: OcrInput): Promise<OcrOutput> {
    const isBulk = input.mode === 'bulk';
    const contentBlock = isBulk
      ? ({ type: 'document', source: { type: 'base64', media_type: input.mediaType, data: input.data } } as const)
      : ({ type: 'image', source: { type: 'base64', media_type: input.mediaType, data: input.data } } as const);

    const text = await callAnthropicMessages({
      maxTokens: input.maxTokens,
      content: [contentBlock, { type: 'text', text: input.promptText }],
    });

    let parsed: unknown;
    try {
      parsed = extractJsonFromModelText(text);
    } catch {
      console.error('[fireflow-api] failed to parse anthropic response as JSON:', stripJsonFences(text).slice(0, 500));
      throw new ApiError(502, 'AIの返答を解析できませんでした。もう一度お試しください。');
    }

    if (isBulk && !Array.isArray(parsed)) {
      console.error('[fireflow-api] unexpected non-array bulk response:', stripJsonFences(text).slice(0, 500));
      throw new ApiError(502, '想定外の形式で結果が返されました。もう一度お試しください。');
    }

    return parsed;
  },
};
