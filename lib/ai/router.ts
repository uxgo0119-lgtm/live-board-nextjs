// [2026-07-20新設 / 2026-07-27改訂Phase7] Task Router: タスク名 → プロバイダの解決。
//
// lib/ai/capabilities/ 配下はプロバイダ名を一切知らず、「どのタスクを実行したいか」
// だけをここに渡す。config/taskRouting.ts の対応表を見てプロバイダを決め、
// そのプロバイダのAdapter実装(providers/配下)を返す。
//
// 将来プロバイダを追加する場合、ここへの変更は「switchに1ケース足す」だけで済み、
// 呼び出し側(lib/ai/capabilities/ や lib/handlers/)は一切変更不要にする。
//
// [2026-07-27改訂] Phase7でOpenAI/Geminiのcase分岐を追加した。ProviderNameへ新しい値を
// 追加した際、対応する分岐を追加し忘れると default節の `never` 型チェックでコンパイル
// エラーになる(実際にopenai/geminiのcaseを一時的に外してtsc --noEmitを実行し、
// コンパイルエラーになることを確認済み)。

import type { OcrCapability } from './types';
import type { TaskName } from './config/taskRouting';
import { resolveProviderForTask } from './config/taskRouting';
import { anthropicOcrCapability } from './providers/anthropic';
import { openaiOcrCapability } from './providers/openai';
import { geminiOcrCapability } from './providers/gemini';

export function resolveOcrCapability(task: TaskName): OcrCapability {
  // [2026-08-05改訂] TASK_ROUTINGを直接indexする代わりに resolveProviderForTask() を
  // 経由する。タスク別環境変数(例: OCR_PROVIDER_INSPECTION_SCHEDULE)が設定されていない
  // 限り、TASK_ROUTINGの既定値がそのまま使われるため、本番の挙動は変わらない
  // (詳細は lib/ai/config/taskRouting.ts のコメント参照)。
  const provider = resolveProviderForTask(task);
  switch (provider) {
    case 'anthropic':
      return anthropicOcrCapability;
    case 'openai':
      return openaiOcrCapability;
    case 'gemini':
      return geminiOcrCapability;
    default: {
      // 将来ProviderNameへ新しい値を追加した際、対応する分岐を追加し忘れると
      // ここでコンパイルエラーになる(網羅性チェック)。
      const exhaustiveCheck: never = provider;
      throw new Error('未対応のAIプロバイダです: ' + String(exhaustiveCheck));
    }
  }
}
