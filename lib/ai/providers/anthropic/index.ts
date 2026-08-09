// [2026-07-20新設] Anthropicプロバイダのバレルエクスポート。
// 将来 providers/openai/index.ts, providers/gemini/index.ts を追加する際も、
// 同じ形(このファイルと同名のexport)にしておくことで、lib/ai/router.ts側の
// 実装を揃えやすくする。

export { callAnthropicMessages } from './client';
export { anthropicOcrCapability } from './ocr';
