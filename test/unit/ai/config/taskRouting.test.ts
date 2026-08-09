// [2026-08-05新設] lib/ai/config/taskRouting.ts の resolveProviderForTask() 単体テスト。
// 「タスク別環境変数が未設定なら既存のTASK_ROUTING既定値(現状すべてanthropic)のまま
// 変わらないこと」(最重要方針1・2の担保)と、「環境変数が設定されていれば、その値が
// 妥当な場合に限り上書きされること」「不正な値は既定値へフォールバックすること」を確認する。

import { resolveProviderForTask, TASK_ROUTING } from '../../../../lib/ai/config/taskRouting';

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error('FAIL: ' + msg);
  console.log('OK: ' + msg);
}

const ENV_VAR_SCHEDULE = 'OCR_PROVIDER_INSPECTION_SCHEDULE';
const ENV_VAR_SHEET = 'OCR_PROVIDER_INSPECTION_SCHEDULE_SHEET';

function withEnv(name: string, value: string | undefined, fn: () => void) {
  const original = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    fn();
  } finally {
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
  }
}

// ---- 環境変数未設定時は、既存のTASK_ROUTING(現状すべてanthropic)がそのまま使われる ----
withEnv(ENV_VAR_SCHEDULE, undefined, () => {
  assert(
    resolveProviderForTask('ocr.inspectionSchedule') === TASK_ROUTING['ocr.inspectionSchedule'],
    '環境変数未設定時はTASK_ROUTINGの既定値がそのまま使われる(本番挙動は変化しない)'
  );
  assert(resolveProviderForTask('ocr.inspectionSchedule') === 'anthropic', '既定値は現状anthropic');
});

// ---- 環境変数に妥当な値を設定すると上書きされる ----
withEnv(ENV_VAR_SCHEDULE, 'gemini', () => {
  assert(resolveProviderForTask('ocr.inspectionSchedule') === 'gemini', `${ENV_VAR_SCHEDULE}=geminiでプロバイダがgeminiに上書きされる`);
});
withEnv(ENV_VAR_SCHEDULE, 'openai', () => {
  assert(resolveProviderForTask('ocr.inspectionSchedule') === 'openai', `${ENV_VAR_SCHEDULE}=openaiでプロバイダがopenaiに上書きされる`);
});

// ---- 別タスクの環境変数は互いに影響しない(タスク別に独立して切り替えられる) ----
withEnv(ENV_VAR_SHEET, 'gemini', () => {
  withEnv(ENV_VAR_SCHEDULE, undefined, () => {
    assert(resolveProviderForTask('ocr.inspectionScheduleSheet') === 'gemini', 'OCR_PROVIDER_INSPECTION_SCHEDULE_SHEETはinspectionScheduleSheetタスクのみに影響する');
    assert(resolveProviderForTask('ocr.inspectionSchedule') === TASK_ROUTING['ocr.inspectionSchedule'], '別タスク(inspectionSchedule)の解決には影響しない');
  });
});

// ---- 不正な値は既定値にフォールバックする(本番を壊さない) ----
withEnv(ENV_VAR_SCHEDULE, 'not-a-real-provider', () => {
  assert(
    resolveProviderForTask('ocr.inspectionSchedule') === TASK_ROUTING['ocr.inspectionSchedule'],
    '不正な値が設定された場合は既定値へフォールバックする'
  );
});

// ---- 空文字は「未設定」と同じ扱いになる ----
withEnv(ENV_VAR_SCHEDULE, '', () => {
  assert(
    resolveProviderForTask('ocr.inspectionSchedule') === TASK_ROUTING['ocr.inspectionSchedule'],
    '空文字が設定された場合も既定値へフォールバックする'
  );
});

console.log('ALL PASS: ai/config/taskRouting.test.ts');
