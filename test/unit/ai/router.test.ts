// [2026-07-20新設] lib/ai/router.ts (Task Router) の単体テスト。
// 「タスク名からプロバイダが正しく解決されること」「対応表(taskRouting.ts)が
// 唯一の切り替えポイントであること」を確認する。将来OpenAI/Geminiを追加した際も、
// このテストの形のまま対象プロバイダを追加できる想定。

import { resolveOcrCapability } from '../../../lib/ai/router';
import { anthropicOcrCapability } from '../../../lib/ai/providers/anthropic';
import { openaiOcrCapability } from '../../../lib/ai/providers/openai';
import { geminiOcrCapability } from '../../../lib/ai/providers/gemini';
import { TASK_ROUTING } from '../../../lib/ai/config/taskRouting';
import type { TaskName, ProviderName } from '../../../lib/ai/config/taskRouting';

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error('FAIL: ' + msg);
  console.log('OK: ' + msg);
}

assert(TASK_ROUTING['ocr.inspectionSchedule'] === 'anthropic', 'ocr.inspectionScheduleタスクは現時点でanthropicにルーティングされる');

const capability = resolveOcrCapability('ocr.inspectionSchedule');
assert(capability === anthropicOcrCapability, 'resolveOcrCapabilityはtaskRoutingの設定通りanthropicOcrCapabilityを返す');

// ---- [2026-07-27追加 Phase7] 新タスク ocr.inspectionScheduleSheet の解決確認 ----
assert(
  TASK_ROUTING['ocr.inspectionScheduleSheet'] === 'anthropic',
  'ocr.inspectionScheduleSheetタスクは現時点でanthropicにルーティングされる'
);
const sheetCapability = resolveOcrCapability('ocr.inspectionScheduleSheet');
assert(sheetCapability === anthropicOcrCapability, 'ocr.inspectionScheduleSheetもresolveOcrCapability経由でanthropicOcrCapabilityを返す');

// ---- [2026-07-27追加 Phase7] resolveOcrCapabilityがAnthropic/OpenAI/Geminiそれぞれで
//      正しいAdapterを返すことの網羅性テスト。TASK_ROUTINGの値を一時的に書き換えて確認する
//      (テスト用のローカルな対応表のコピーを差し替えるのではなく、実際に使われている
//      TASK_ROUTING自体を一時的に書き換え、テスト終了時に元に戻す) ----
const ORIGINAL_ROUTING: Record<TaskName, ProviderName> = { ...TASK_ROUTING };

function withRouting(provider: ProviderName, fn: () => void) {
  (TASK_ROUTING as Record<TaskName, ProviderName>)['ocr.inspectionScheduleSheet'] = provider;
  try {
    fn();
  } finally {
    (TASK_ROUTING as Record<TaskName, ProviderName>)['ocr.inspectionScheduleSheet'] = ORIGINAL_ROUTING['ocr.inspectionScheduleSheet'];
  }
}

withRouting('anthropic', () => {
  assert(resolveOcrCapability('ocr.inspectionScheduleSheet') === anthropicOcrCapability, 'TASK_ROUTINGをanthropicにするとanthropicOcrCapabilityが返る');
});
withRouting('openai', () => {
  assert(resolveOcrCapability('ocr.inspectionScheduleSheet') === openaiOcrCapability, 'TASK_ROUTINGをopenaiにするとopenaiOcrCapabilityが返る(値を書き換えるだけでプロバイダが切り替わる)');
});
withRouting('gemini', () => {
  assert(resolveOcrCapability('ocr.inspectionScheduleSheet') === geminiOcrCapability, 'TASK_ROUTINGをgeminiにするとgeminiOcrCapabilityが返る(値を書き換えるだけでプロバイダが切り替わる)');
});

// 書き換えが後始末されていること(他のテストへ影響しないこと)の確認
assert(TASK_ROUTING['ocr.inspectionScheduleSheet'] === ORIGINAL_ROUTING['ocr.inspectionScheduleSheet'], 'テスト用の一時的な書き換えは後始末され、元の設定に戻っている');

console.log('ALL PASS: ai/router.test.ts');
