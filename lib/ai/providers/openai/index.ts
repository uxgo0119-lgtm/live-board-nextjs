// [2026-07-27新設 Phase7] OpenAIプロバイダのバレルエクスポート。
// providers/anthropic/index.ts と同じ形(同名のexport)にしてあり、
// lib/ai/router.ts側の実装を揃えやすくしている。

export { callOpenAiChat } from './client';
export { openaiOcrCapability } from './ocr';
