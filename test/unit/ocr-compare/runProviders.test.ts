// [2026-08-05新設] lib/ocr-compare/runProviders.ts の単体テスト。
// 【重要な限界】このテストはfetchを一切呼ばない(実APIへの通信なし)。
// parseProviderRaw()(①→②の純粋なJSON解析ロジック)と、本番プロンプト/max_tokensを
// 重複実装せずに再利用できていることだけを確認する(実際にAnthropic/Gemini APIへ
// 接続できるかどうかは、本テストでは一切検証していない=「実API疎通確認」ではない)。

import { parseProviderRaw, promptAndMaxTokensForMode } from '../../../lib/ocr-compare/runProviders';
import {
  SINGLE_PROMPT,
  BULK_PROMPT,
  SINGLE_MAX_TOKENS,
  BULK_MAX_TOKENS,
} from '../../../lib/ai/capabilities/ocr/documentTypes/residentTimeRequestSheet';
import type { ProviderRawStage } from '../../../lib/ocr-compare/types';

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error('FAIL: ' + msg);
  console.log('OK: ' + msg);
}

// ---- 本番と全く同じプロンプト・max_tokensが使われる(重複実装によるドリフトが無いこと) ----
{
  const single = promptAndMaxTokensForMode('single');
  assert(single.promptText === SINGLE_PROMPT, 'singleモードのプロンプトは本番のSINGLE_PROMPTと完全一致する');
  assert(single.maxTokens === SINGLE_MAX_TOKENS, 'singleモードのmaxTokensは本番のSINGLE_MAX_TOKENSと完全一致する');

  const bulk = promptAndMaxTokensForMode('bulk');
  assert(bulk.promptText === BULK_PROMPT, 'bulkモードのプロンプトは本番のBULK_PROMPTと完全一致する');
  assert(bulk.maxTokens === BULK_MAX_TOKENS, 'bulkモードのmaxTokensは本番のBULK_MAX_TOKENSと完全一致する');
}

function rawStage(overrides: Partial<ProviderRawStage>): ProviderRawStage {
  return { ok: true, attempted: true, rawText: null, errorMessage: null, processingTimeMs: 100, ...overrides };
}

// ---- raw stageが失敗している場合、parsed stageも失敗として伝播する ----
{
  const raw = rawStage({ ok: false, attempted: false, errorMessage: 'APIキー未設定' });
  const parsed = parseProviderRaw(raw, 'single');
  assert(!parsed.ok, 'raw stageが失敗していればparsed stageも失敗になる');
  assert(parsed.errorMessage === 'APIキー未設定', 'raw stageのエラーメッセージがそのまま伝播する');
}

// ---- singleモード: 正常なJSONはパースされる ----
{
  const raw = rawStage({ rawText: '{"room_number":"101","symbol":"A"}' });
  const parsed = parseProviderRaw(raw, 'single');
  assert(parsed.ok, 'singleモードの正常なJSONはパースに成功する');
  assert((parsed.parsed as any).room_number === '101', 'パース結果の中身が正しい');
}

// ---- コードフェンス付きのJSONも既存ロジック(extractJsonFromModelText)通りパースできる ----
{
  const raw = rawStage({ rawText: '```json\n{"room_number":"102"}\n```' });
  const parsed = parseProviderRaw(raw, 'single');
  assert(parsed.ok, 'コードフェンス付きのJSONもパースできる(stripJsonFencesが機能している)');
}

// ---- bulkモード: 配列以外が返ってきたらエラー(既存Adapterと同じ判定基準) ----
{
  const raw = rawStage({ rawText: '{"not":"an array"}' });
  const parsed = parseProviderRaw(raw, 'bulk');
  assert(!parsed.ok, 'bulkモードで配列以外が返された場合はエラーになる(既存Adapterと同じ基準)');
}

// ---- 不正なJSONはエラーになる ----
{
  const raw = rawStage({ rawText: 'これはJSONではありません' });
  const parsed = parseProviderRaw(raw, 'single');
  assert(!parsed.ok, '不正なJSONはエラーになる');
}

console.log('ALL PASS: ocr-compare/runProviders.test.ts');
