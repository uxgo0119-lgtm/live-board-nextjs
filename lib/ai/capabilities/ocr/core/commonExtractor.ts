// [2026-07-27新設 Phase7] 共通OCRコア(設計書1.1a「共通OCRエンジン層」)。
//
// どの帳票種別(点検希望時間連絡票=residentTimeRequestSheet、紙の点検予定表=
// inspectionScheduleSheet、将来追加される帳票)にも共通する部分をここへ集約する。
// - サイズ上限をパラメータ化した汎用の validateOcrPayload
// - AM/PM・PASS・キャンセル・不在等の表記ゆれの扱いに関する、複数のプロンプトで
//   使い回せる共通の指示文言スニペット
// - Task Router経由でAI呼び出しを行う汎用ヘルパー scanDocument
//
// 【重要】ここは「帳票種別をまたぐロジックの共通化」のレイヤーであり、「どのAIプロバイダを
// 使うか」の切り替え(lib/ai/router.ts・config/taskRouting.ts)とは別軸。scanDocument()の
// 第1引数(taskName)がプロバイダ差し替えの軸、このファイル自体は帳票種別の追加の軸を担う
// (設計書1.1a参照)。
//
// 【既存挙動への影響】既存の点検希望時間連絡票OCR(documentTypes/residentTimeRequestSheet.ts、
// 旧inspectionSchedule.ts)は、このファイルの validateOcrPayload/scanDocument を呼ぶよう
// 内部実装のみ整理された。プロンプト文言・エラーコード・レスポンス形状は一切変更していない。

import { ApiError } from '../../../../http/apiError';
import type { OcrMode, OcrOutput } from '../../../types';
import type { TaskName } from '../../../config/taskRouting';
import { resolveOcrCapability } from '../../../router';

export type OcrSizeLimits = {
  single: number;
  bulk: number;
};

// mode/mediaType/dataの妥当性検証+サイズ上限チェック(400/413エラー)の汎用版。
// 既存のlib/ai/capabilities/ocr/inspectionSchedule.tsが持っていたロジックから、
// サイズ上限だけを呼び出し元(帳票種別ごとのファイル)からパラメータとして受け取るように
// 一般化したもの。挙動(エラーメッセージ・ステータスコード)は既存のものと完全に同一。
export function validateOcrPayload(
  mode: unknown,
  mediaType: unknown,
  data: unknown,
  limits: OcrSizeLimits
): asserts data is string {
  if (mode !== 'single' && mode !== 'bulk') {
    throw new ApiError(400, 'mode は "single" か "bulk" のいずれかを指定してください。');
  }
  if (!mediaType || !data) {
    throw new ApiError(400, 'mediaType と data は必須です。');
  }
  const isBulk = mode === 'bulk';
  const maxLen = isBulk ? limits.bulk : limits.single;
  if (typeof data !== 'string' || data.length > maxLen) {
    throw new ApiError(
      413,
      'ファイルサイズが大きすぎます。' + (isBulk ? 'PDFのページ数を減らすか、' : '') + '別のファイルでお試しください。'
    );
  }
}

// 複数の文書種別プロンプトで共有する、表記ゆれの扱いに関する共通指示文言。
// 【重要】既存の点検希望時間連絡票OCR(SINGLE_PROMPT/BULK_PROMPT in
// documentTypes/residentTimeRequestSheet.ts)は、この共通スニペットを使わず既存の文言を
// そのまま維持している(既存の読み取り精度に影響を与えないことを優先したため)。この
// スニペットは、Phase7で新設した documentTypes/inspectionScheduleSheet.ts のプロンプトで
// 利用する(将来追加される第3の帳票種別のプロンプトからも再利用できる想定)。
export const COMMON_OCR_NOTATION_GUIDE =
  '記入内容の表記ゆれについては、次の基準で「記載されている通り」を読み取ってください' +
  '(意味の解釈・正規化はこの後工程のアプリ側処理で行うため、ここでは判断を加えず原文に忠実に' +
  '書き起こすことが重要です)。' +
  '午前を表す表記(「AM」「午前」「午前中」等)や午後を表す表記(「PM」「午後」等)は、' +
  'チェックまたは記入がある場合そのまま書き起こしてください。' +
  '「PASS」「確認済み」「済」等の完了・合格を意味する記述、' +
  '「キャンセル」「辞退」「不要」等のキャンセルを意味する記述、' +
  '「不在」「留守」等の不在を意味する記述、「未回答」「空欄」等の未回答を意味する記述は、' +
  'いずれも自動的に他の状態へ変換したり意味を解釈したりせず、記載されている文字列をそのまま' +
  '書き起こしてください。判読できない・記載が無い項目は、無理に推測せず空文字またはnullと' +
  'してください。';

// resolveOcrCapability(taskName).scan(...) を呼ぶだけの薄いヘルパー。各documentTypeファイルが
// 「タスク名を指定して、組み立てたプロンプト・上限トークン数でAIを呼ぶ」という定型処理を
// 簡潔に書けるようにする。
export async function scanDocument(
  taskName: TaskName,
  mode: OcrMode,
  mediaType: string,
  data: string,
  promptText: string,
  maxTokens: number
): Promise<OcrOutput> {
  const capability = resolveOcrCapability(taskName);
  return capability.scan({ mode, mediaType, data, promptText, maxTokens });
}
