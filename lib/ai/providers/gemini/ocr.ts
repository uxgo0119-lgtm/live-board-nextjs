// [2026-07-27新設 Phase7] OcrCapability の Gemini実装(Adapter)。
// 「OcrInputをGemini generateContent APIのparts形式に変換して呼び出し、
// 返答テキストをJSONとして取り出す」というプロバイダ固有の変換のみを行う。プロンプト
// 文言や入力サイズ上限といったタスク固有の知識は持たない(呼び出し元の
// lib/ai/capabilities/ocr/ 配下が組み立てて渡す)。providers/anthropic/ocr.ts と
// 同じ構造・同じエラーハンドリング方針を踏襲している。
//
// 【環境制約による注記】client.ts同様、実際のGemini APIへのライブ接続では検証されて
// いない(ベストエフォート実装)。単体テストはfetchをモックする形で、リクエストの形・
// レスポンスパース・エラーラップ・APIキー非漏洩を検証している
// (test/unit/ai/providers/gemini/ocr.test.ts)。

import { ApiError } from '../../../http/apiError';
import type { OcrCapability, OcrInput, OcrOutput } from '../../types';
import type { GeminiPart } from './client';
import { callGeminiGenerateContent } from './client';
import { stripJsonFences, extractJsonFromModelText } from '../../shared/extractJsonFromModelText';

export const geminiOcrCapability: OcrCapability = {
  async scan(input: OcrInput): Promise<OcrOutput> {
    const isBulk = input.mode === 'bulk';
    // Geminiは画像/PDF等のバイナリをinlineData(mimeType/base64data)で受け取る。
    const parts: GeminiPart[] = [
      { inlineData: { mimeType: input.mediaType, data: input.data } },
      { text: input.promptText },
    ];

    const text = await callGeminiGenerateContent({ maxTokens: input.maxTokens, parts });

    let parsed: unknown;
    try {
      parsed = extractJsonFromModelText(text);
    } catch {
      console.error('[fireflow-api] failed to parse gemini response as JSON:', stripJsonFences(text).slice(0, 500));
      throw new ApiError(502, 'AIの返答を解析できませんでした。もう一度お試しください。');
    }

    if (isBulk && !Array.isArray(parsed)) {
      console.error('[fireflow-api] unexpected non-array bulk response:', stripJsonFences(text).slice(0, 500));
      throw new ApiError(502, '想定外の形式で結果が返されました。もう一度お試しください。');
    }

    return parsed;
  },
};
