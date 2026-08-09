// [2026-07-27新設 Phase7] Geminiプロバイダのバレルエクスポート。
// providers/anthropic/index.ts と同じ形(同名のexport)にしてあり、
// lib/ai/router.ts側の実装を揃えやすくしている。

export { callGeminiGenerateContent } from './client';
export { geminiOcrCapability } from './ocr';
