// [2026-07-20新設 / 2026-07-27改訂Phase7] 「どのタスクをどのプロバイダで処理するか」の対応表。
//
// 将来OpenAI・Geminiを追加する際は、
//   1. ProviderName に 'openai' | 'gemini' 等を追加
//   2. lib/ai/providers/openai/ 等にAdapterを実装
//   3. lib/ai/router.ts のswitchに分岐を追加
//   4. TASK_ROUTING の該当タスクの値を書き換える(または新タスクを追加する)
// だけでよく、Route Handlerやcapabilities層・アプリ全体を書き換える必要はない。
//
// [2026-07-27改訂] Phase7で上記1〜3を実施し、'openai' | 'gemini' のAdapterが実装された。
// [2026-07-27改訂] 新タスク 'ocr.inspectionScheduleSheet' を追加。
// [2026-08-11新設 新捺印表OCR P0実装] 新タスク 'ocr.standardizedStampSheet' を追加。
// 既存の 'ocr.inspectionSchedule' と 'ocr.inspectionScheduleSheet' の既定値は変更しない。

export type ProviderName = 'anthropic' | 'openai' | 'gemini';

export type TaskName = 'ocr.inspectionSchedule' | 'ocr.inspectionScheduleSheet' | 'ocr.standardizedStampSheet';

export const TASK_ROUTING: Record<TaskName, ProviderName> = {
  'ocr.inspectionSchedule': 'anthropic',
  'ocr.inspectionScheduleSheet': 'anthropic',
  'ocr.standardizedStampSheet': 'anthropic',
};

const TASK_PROVIDER_ENV_VAR: Record<TaskName, string> = {
  'ocr.inspectionSchedule': 'OCR_PROVIDER_INSPECTION_SCHEDULE',
  'ocr.inspectionScheduleSheet': 'OCR_PROVIDER_INSPECTION_SCHEDULE_SHEET',
  'ocr.standardizedStampSheet': 'OCR_PROVIDER_STANDARDIZED_STAMP_SHEET',
};

const VALID_PROVIDER_NAMES: ProviderName[] = ['anthropic', 'openai', 'gemini'];

function isProviderName(value: string): value is ProviderName {
  return (VALID_PROVIDER_NAMES as string[]).includes(value);
}

export function resolveProviderForTask(task: TaskName): ProviderName {
  const envVarName = TASK_PROVIDER_ENV_VAR[task];
  const raw = process.env[envVarName];
  if (raw) {
    const trimmed = raw.trim();
    if (isProviderName(trimmed)) {
      return trimmed;
    }
    console.error(
      '[fireflow-api] 環境変数 ' + envVarName + ' の値が不正です(' + JSON.stringify(raw) + ')。' +
        "'anthropic' | 'openai' | 'gemini' のいずれかを指定してください。既定値にフォールバックします。"
    );
  }
  return TASK_ROUTING[task];
}
