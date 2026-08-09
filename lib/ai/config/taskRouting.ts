// [2026-07-20新設 / 2026-07-27改訂Phase7] 「どのタスクをどのプロバイダで処理するか」の対応表。
//
// 将来OpenAI・Geminiを追加する際は、
//   1. ProviderName に 'openai' | 'gemini' 等を追加
//   2. lib/ai/providers/openai/ 等にAdapterを実装
//   3. lib/ai/router.ts のswitchに分岐を追加
//   4. TASK_ROUTING の該当タスクの値を書き換える(または新タスクを追加する)
// だけでよく、Route Handlerやcapabilities層・アプリ全体を書き換える必要はない。
//
// [2026-07-27改訂] Phase7で上記1〜3を実施し、'openai' | 'gemini' のAdapterが実装された
// (lib/ai/providers/openai/, lib/ai/providers/gemini/)。ただし実際に本番で使うプロバイダを
// 切り替えるのは、このファイルのTASK_ROUTINGの値を書き換えるだけでよい(呼び出し側は一切
// 変更不要)。現時点ではまだ実運用での動作実績があるAnthropicのみを指すデフォルトとしている
// (実APIキーでのライブ検証未実施のOpenAI/Geminiへ、事前の断りなくいきなり切り替えないため)。
//
// [2026-07-27改訂] Phase7で新タスク 'ocr.inspectionScheduleSheet'(紙の点検予定表OCR)を追加。
// 既存の 'ocr.inspectionSchedule'(点検希望時間連絡票OCR)の対応表エントリ・値は変更していない
// (設計書1.1a: 「帳票種別の追加」と「プロバイダ差し替え」は直交した2軸であり、1タスク=1帳票種別
// の対応関係自体は変えない)。

export type ProviderName = 'anthropic' | 'openai' | 'gemini';

export type TaskName = 'ocr.inspectionSchedule' | 'ocr.inspectionScheduleSheet';

export const TASK_ROUTING: Record<TaskName, ProviderName> = {
  'ocr.inspectionSchedule': 'anthropic',
  // [2026-07-27新設Phase7] まずはAnthropicで接続する(既存タスクと同じプロバイダ・同じ実績のある
  // 通信経路を使うことで、新規プロンプト自体の精度検証に集中する)。将来OpenAI/Geminiへ切り替える
  // 際は、この値を 'openai' や 'gemini' に書き換えるだけでよい。
  'ocr.inspectionScheduleSheet': 'anthropic',
};

// [2026-08-05新設] 捺印表OCR Anthropic／Gemini比較検証プロジェクトの一環。
//
// 【背景・方針】TASK_ROUTINGの値を直接書き換えると「本番で使うプロバイダそのもの」が
// 切り替わってしまう。今回はまず「タスクごとに環境変数で上書きできる差し替え口」だけを
// 用意し、TASK_ROUTINGの既定値(='anthropic'、本番の現行動作)自体は1文字も変更しない
// (最重要方針1・2: 現在のAnthropic本番OCR動作を維持し、Geminiを既定値へ変更しない)。
// 環境変数が未設定の場合は、これまでどおりTASK_ROUTINGの値がそのまま使われるため、
// 本番環境で新しい環境変数を設定しない限り、挙動は一切変化しない。
//
// 各タスクに対応する環境変数名(最低限、以下2つに対応):
//   OCR_PROVIDER_INSPECTION_SCHEDULE       → 'ocr.inspectionSchedule'      (捺印表/点検希望時間連絡票)
//   OCR_PROVIDER_INSPECTION_SCHEDULE_SHEET → 'ocr.inspectionScheduleSheet' (紙の点検予定表)
const TASK_PROVIDER_ENV_VAR: Record<TaskName, string> = {
  'ocr.inspectionSchedule': 'OCR_PROVIDER_INSPECTION_SCHEDULE',
  'ocr.inspectionScheduleSheet': 'OCR_PROVIDER_INSPECTION_SCHEDULE_SHEET',
};

const VALID_PROVIDER_NAMES: ProviderName[] = ['anthropic', 'openai', 'gemini'];

function isProviderName(value: string): value is ProviderName {
  return (VALID_PROVIDER_NAMES as string[]).includes(value);
}

// タスク名からプロバイダを解決する。lib/ai/router.ts はこの関数経由でプロバイダを
// 決定する(TASK_ROUTINGを直接indexしない)。
//   1. タスク別の環境変数(例: OCR_PROVIDER_INSPECTION_SCHEDULE)が設定されていれば、
//      その値が 'anthropic' | 'openai' | 'gemini' のいずれかである場合に限り採用する。
//   2. 環境変数が未設定、または想定外の値の場合は、TASK_ROUTINGの既定値(現状'anthropic')に
//      フォールバックする(想定外の値で本番が壊れることを避けるため、無効値は無視して
//      デフォルトへフォールバックし、サーバーログにのみ警告を出す)。
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
