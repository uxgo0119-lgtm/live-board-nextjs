// lib/ocr-compare/runProviders.ts
//
// [2026-08-05新設] Anthropic/Geminiの低レベルクライアント関数(既存・無改修)を直接呼び出し、
// ①生レスポンス(パース前テキスト) を保持したうえで ②JSON解析後のデータ を組み立てる。
//
// 【重要】lib/ai/providers/{anthropic,gemini}/ocr.ts (本番のOcrCapability Adapter)は
// 一切importしない・変更しない。その1段下の callAnthropicMessages / callGeminiGenerateContent
// (通信のみを担当する既存関数)だけを再利用する。プロンプト文言・max_tokensは
// lib/ai/capabilities/ocr/documentTypes/residentTimeRequestSheet.ts の
// SINGLE_PROMPT/BULK_PROMPT/SINGLE_MAX_TOKENS/BULK_MAX_TOKENS(本番と完全同一の値)を
// そのままimportして使う(重複実装によるドリフトを避けるため)。

import { callAnthropicMessages } from '../ai/providers/anthropic/client';
import { callGeminiGenerateContent } from '../ai/providers/gemini/client';
import { getServerEnv } from '../config/env';
import {
  stripJsonFences,
  extractJsonFromModelTextDetailed,
  JsonExtractionError,
  validateArrayShape,
  validateObjectShape,
  type ObjectShapeSchema,
} from '../ai/shared/extractJsonFromModelText';
import {
  SINGLE_PROMPT,
  BULK_PROMPT,
  SINGLE_MAX_TOKENS,
  BULK_MAX_TOKENS,
} from '../ai/capabilities/ocr/documentTypes/residentTimeRequestSheet';
import type {
  OcrCompareMode,
  OcrCompareProviderKey,
  ProviderParsedStage,
  ProviderRawStage,
} from './types';

// [2026-08-05追加 P0] 捺印表OCR(residentTimeRequestSheet.tsのSINGLE_PROMPT/BULK_PROMPT)が
// 期待する出力フィールドのスキーマ。本番のAdapter(providers/*/ocr.ts)には一切配線して
// いない(本番のバリデーション有無は変更しない)。比較CLI側だけがこのスキーマを使って
// 「JSON解析には成功したが、想定外のフィールド構成だった」ケースを検出する。
const STAMP_SHEET_ENTRY_SCHEMA: ObjectShapeSchema = {
  requiredStringFields: ['room_number', 'symbol', 'time', 'time_end', 'note', 'name', 'date'],
};

export function promptAndMaxTokensForMode(mode: OcrCompareMode): { promptText: string; maxTokens: number } {
  const isBulk = mode === 'bulk';
  return {
    promptText: isBulk ? BULK_PROMPT : SINGLE_PROMPT,
    maxTokens: isBulk ? BULK_MAX_TOKENS : SINGLE_MAX_TOKENS,
  };
}

async function runAnthropicRaw(mode: OcrCompareMode, mediaType: string, data: string): Promise<ProviderRawStage> {
  const { promptText, maxTokens } = promptAndMaxTokensForMode(mode);
  const isBulk = mode === 'bulk';
  const contentBlock = isBulk
    ? ({ type: 'document', source: { type: 'base64', media_type: mediaType, data } } as const)
    : ({ type: 'image', source: { type: 'base64', media_type: mediaType, data } } as const);

  const startedAt = Date.now();
  try {
    // ANTHROPIC_API_KEYはServerEnvの必須項目のため、未設定ならgetServerEnv()自体が
    // ここで例外を投げる(=attempted: falseとして扱う)。
    getServerEnv();
  } catch (err) {
    return {
      ok: false,
      attempted: false,
      rawText: null,
      errorMessage: 'ANTHROPIC_API_KEY(または実行に必要な他の環境変数)が設定されていません: ' + (err instanceof Error ? err.message : String(err)),
      processingTimeMs: null,
    };
  }

  try {
    const text = await callAnthropicMessages({
      maxTokens,
      content: [contentBlock, { type: 'text', text: promptText }],
    });
    return {
      ok: true,
      attempted: true,
      rawText: text,
      errorMessage: null,
      processingTimeMs: Date.now() - startedAt,
    };
  } catch (err) {
    return {
      ok: false,
      attempted: true,
      rawText: null,
      errorMessage: err instanceof Error ? err.message : String(err),
      processingTimeMs: Date.now() - startedAt,
    };
  }
}

async function runGeminiRaw(mode: OcrCompareMode, mediaType: string, data: string): Promise<ProviderRawStage> {
  const { promptText, maxTokens } = promptAndMaxTokensForMode(mode);

  // GEMINI_API_KEYはServerEnvではoptional(未設定ならnull)なので、ここで明示的に
  // チェックし、「未設定=試行していない」ことを区別する
  // (callGeminiGenerateContent自体もチェックして例外を投げるが、その例外文言だけに
  // 依存すると将来文言が変わった際に判定が壊れるため、ここでも直接判定する)。
  let env;
  try {
    env = getServerEnv();
  } catch (err) {
    return {
      ok: false,
      attempted: false,
      rawText: null,
      errorMessage: '環境変数の読み込みに失敗しました: ' + (err instanceof Error ? err.message : String(err)),
      processingTimeMs: null,
    };
  }
  if (!env.GEMINI_API_KEY) {
    return {
      ok: false,
      attempted: false,
      rawText: null,
      errorMessage: 'GEMINI_API_KEY が設定されていません(.env.local または実行環境の環境変数に設定してください)。',
      processingTimeMs: null,
    };
  }

  const startedAt = Date.now();
  try {
    const text = await callGeminiGenerateContent({
      maxTokens,
      parts: [{ inlineData: { mimeType: mediaType, data } }, { text: promptText }],
    });
    return {
      ok: true,
      attempted: true,
      rawText: text,
      errorMessage: null,
      processingTimeMs: Date.now() - startedAt,
    };
  } catch (err) {
    return {
      ok: false,
      attempted: true,
      rawText: null,
      errorMessage: err instanceof Error ? err.message : String(err),
      processingTimeMs: Date.now() - startedAt,
    };
  }
}

export async function runProviderRaw(
  provider: OcrCompareProviderKey,
  mode: OcrCompareMode,
  mediaType: string,
  data: string
): Promise<ProviderRawStage> {
  if (provider === 'anthropic') return runAnthropicRaw(mode, mediaType, data);
  return runGeminiRaw(mode, mediaType, data);
}

// ①raw stageの結果を②parsed stageへ変換する。既存のAdapter(anthropic/ocr.ts・gemini/ocr.ts)と
// 同じくextractJsonFromModelText相当のロジック(2026-08-05改訂で①raw→②markdown→③bracketの
// 段階的抽出へ強化済み)でパースし、bulkモードなら配列であることを検証する
// (既存Adapterと同じ判定基準にすることで、本番と比較ツールで「何を成功/失敗とみなすか」の
// 基準を揃える)。加えて、どの抽出方式で成功したか(extractionMethod)と、フィールド構成の
// スキーマ検証結果(schemaValidation)も記録する([2026-08-05追加 P0])。
export function parseProviderRaw(raw: ProviderRawStage, mode: OcrCompareMode): ProviderParsedStage {
  if (!raw.ok || raw.rawText === null) {
    return {
      ok: false,
      parsed: null,
      errorMessage: raw.errorMessage || 'raw stageが失敗しているため解析していません。',
      extractionMethod: null,
      schemaValidation: null,
    };
  }

  let parsed: unknown;
  let extractionMethod: 'raw' | 'markdown' | 'bracket';
  try {
    const result = extractJsonFromModelTextDetailed(raw.rawText);
    parsed = result.value;
    extractionMethod = result.method;
  } catch (err) {
    const attempted = err instanceof JsonExtractionError ? err.attemptedMethods.join(' → ') : '不明';
    return {
      ok: false,
      parsed: null,
      errorMessage:
        'JSONとして解析できませんでした(試行方式: ' + attempted + ')。生テキスト先頭500文字: ' +
        stripJsonFences(raw.rawText).slice(0, 500),
      extractionMethod: null,
      schemaValidation: null,
    };
  }

  if (mode === 'bulk' && !Array.isArray(parsed)) {
    return {
      ok: false,
      parsed,
      errorMessage: '想定外の形式です(bulkモードでは配列を期待しますが配列以外が返されました)。',
      extractionMethod,
      schemaValidation: null,
    };
  }

  // ④スキーマ検証(本番Adapterには配線していない。比較CLI側でのみ実施する追加チェック)。
  // 検証結果は記録するのみで、schemaValidation.ok===falseでも③LB正規化(normalizeToLbFormat)は
  // 引き続き試みる(normalizeToLbFormat自体が個々のフィールド欠落に対して安全側に倒す
  // 実装になっているため。ここでのスキーマ検証はあくまで「本来期待する形と違う」ことを
  // ログ・レポートに残すための診断情報という位置づけ)。
  const schemaValidation = mode === 'bulk' ? validateArrayShape(parsed, STAMP_SHEET_ENTRY_SCHEMA) : validateObjectShape(parsed, STAMP_SHEET_ENTRY_SCHEMA);

  return { ok: true, parsed, errorMessage: null, extractionMethod, schemaValidation };
}
