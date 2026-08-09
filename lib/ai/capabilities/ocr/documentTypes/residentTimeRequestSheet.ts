// [2026-07-20新設 / 2026-07-27移設Phase7] 「点検希望時間連絡票のOCR」というタスク固有の知識
// (プロンプト文言・入力サイズ上限・max_tokens・入力の検証)をここに閉じ込める。
// 実際にどのAIプロバイダが処理するかは lib/ai/router.ts が解決するため、
// このファイルはプロバイダ名(Anthropic/OpenAI/Gemini等)を一切知らない。
//
// [2026-07-27改訂] 設計書1.1a「共通OCRエンジン層」の導入に伴い、
// lib/ai/capabilities/ocr/inspectionSchedule.ts の中身をこのファイル
// (documentTypes/residentTimeRequestSheet.ts)へ移設した。移設は内部実装の整理のみであり、
// プロンプト文言(SINGLE_PROMPT/BULK_PROMPT)・max_tokens・サイズ上限・エラーメッセージ・
// エラーコードは1文字も変更していない(実際の読み取り精度・外部から見た挙動を変えない
// ことを最優先した)。旧ファイル lib/ai/capabilities/ocr/inspectionSchedule.ts は、
// このファイルからの re-export のみを行う薄い後方互換ラッパーとして残っている
// (既存のRoute Handler・既存の単体テストが変更不要で動き続けることを確認済み)。
//
// サイズ上限チェックのロジック自体は core/commonExtractor.ts の validateOcrPayload
// (パラメータ化版)を呼ぶよう整理したが、渡す上限値(MAX_BASE64_LENGTH_SINGLE/BULK)は
// 従来と同じ値のため、挙動は変わらない。

import type { OcrMode } from '../../../types';
import { validateOcrPayload as validateOcrPayloadWithLimits, scanDocument } from '../core/commonExtractor';

// [2026-07-29追加] 「date」項目: 捺印表(点検希望時間連絡票)が複数日にまたがる物件の場合、
// 用紙に手書きで「25(土)」「7/25(土)」のような日付(何月何日の記入分か)が書かれていることが
// ある。既存6項目(room_number/symbol/time/time_end/note/name)の抽出指示・出力形式は
// 1文字も変更せず、末尾に「原文そのまま返す」新項目を追加しただけ(姉妹書類
// documentTypes/inspectionScheduleSheet.tsのscheduleDayRawと同じ「原文まま抽出」方針)。
// 実際の年月の補完・ISO日付への正規化はLB側(index.html)のnormalizeStampDateRaw()で行う。
// [2026-08-05改訂] SINGLE_PROMPT/BULK_PROMPT/SINGLE_MAX_TOKENS/BULK_MAX_TOKENS を
// exportに変更した(constの値自体は1文字も変更していない)。捺印表OCR Anthropic／Gemini
// 比較検証基盤(lib/ocr-compare/)が、「本番と全く同じプロンプト・同じmax_tokens」で
// 両プロバイダを比較できるようにするため(プロンプトを比較ツール側でコピー・複製すると、
// 本番側を変更した際にツール側だけ古いプロンプトのまま残るドリフトの危険があるため、
// 唯一の定義箇所であるこのファイルから再利用する)。この変更はexportキーワードの追加のみで、
// 値・呼び出し元(scanInspectionScheduleSlip)の挙動は一切変更していない。
export const SINGLE_PROMPT =
  '添付の画像は、消防点検の希望時間を入居者が記入した連絡票です。' +
  '記載内容から、部屋番号・希望区分・希望時刻（範囲指定なら開始・終了時刻）・' +
  '手書きの補足メモ・お名前欄・日付欄を読み取り、以下のJSON形式のみを出力してください。' +
  '説明文やコードブロックの記号は一切付けないでください。\n' +
  '{"room_number": "部屋番号（数字のみ。読み取れなければ空文字）", ' +
  '"symbol": "「午前中」にチェックがあれば\'A\'、「午後」にチェックがあれば\'P\'、' +
  '「今回は不要・立会いできません（キャンセル）」にチェックがあれば\'キャンセル\'。' +
  '「時間指定」にチェックがある場合や、どれにもチェックが無い場合は空文字。", ' +
  '"time": "「時間指定」にチェックがあり具体的な時刻が記入されていれば、その時刻' +
  '（「〜」で範囲指定されている場合は開始時刻）をHH:MM形式で。無ければ空文字。", ' +
  '"time_end": "「時間指定」の記入が「〜」で区切られた範囲指定になっている場合の' +
  '終了時刻をHH:MM形式で。範囲指定でなければ空文字。", ' +
  '"note": "チェック欄の近くに手書きの補足メモ（例：できるだけ早く）が書かれていれば' +
  'その文字列。無ければ空文字。", ' +
  '"name": "「お名前（任意）」欄に手書きの記入があればその文字列。空欄なら空文字。", ' +
  '"date": "連絡票に「何月何日の分か」を示す日付の記入（例：\'25(土)\'、\'7/25(土)\'、' +
  '\'7月25日\'）があれば、年が書かれていなくても構わないので原文の表記のまま抽出してください。' +
  '日付の記入が無ければ空文字。"}';

export const BULK_PROMPT =
  '添付のPDFには、消防点検の希望時間を入居者が記入した連絡票が複数ページ含まれています' +
  '（1ページに1件、または複数件のことがあります）。すべてのページ・すべての記入から、' +
  '部屋番号・希望区分・希望時刻（範囲指定なら開始・終了時刻）・手書きの補足メモ・' +
  'お名前欄・日付欄を読み取ってください。以下のJSON配列形式のみを出力してください。' +
  '説明文やコードブロックの記号は一切付けないでください。\n' +
  '[{"room_number": "部屋番号（数字のみ）", ' +
  '"symbol": "「午前中」にチェックがあれば\'A\'、「午後」にチェックがあれば\'P\'、' +
  '「今回は不要・立会いできません（キャンセル）」にチェックがあれば\'キャンセル\'。' +
  '「時間指定」にチェックがある場合や、どれにもチェックが無い場合は空文字。", ' +
  '"time": "「時間指定」にチェックがあり具体的な時刻が記入されていれば、その時刻' +
  '（「〜」で範囲指定されている場合は開始時刻）をHH:MM形式で。無ければ空文字。", ' +
  '"time_end": "「時間指定」の記入が「〜」で区切られた範囲指定になっている場合の' +
  '終了時刻をHH:MM形式で。範囲指定でなければ空文字。", ' +
  '"note": "チェック欄の近くに手書きの補足メモ（例：できるだけ早く）が書かれていれば' +
  'その文字列。無ければ空文字。", ' +
  '"name": "「お名前（任意）」欄に手書きの記入があればその文字列。空欄なら空文字。", ' +
  '"date": "連絡票に「何月何日の分か」を示す日付の記入（例：\'25(土)\'、\'7/25(土)\'、' +
  '\'7月25日\'）があれば、年が書かれていなくても構わないので原文の表記のまま抽出してください。' +
  '日付の記入が無ければ空文字。"}, ...]\n' +
  '読み取れた件数分すべてを配列に含めてください。部屋番号が読み取れない項目は含めないでください。';

// Single(JPEG等): base64で最大約8MB(デコード後 約6MB)。Bulk(PDF複数ページ): 最大約30MB(デコード後 約22MB)。
export const MAX_BASE64_LENGTH_SINGLE = 8 * 1000 * 1000;
export const MAX_BASE64_LENGTH_BULK = 30 * 1000 * 1000;

export const SINGLE_MAX_TOKENS = 400;
export const BULK_MAX_TOKENS = 16000;

export function validateOcrPayload(mode: unknown, mediaType: unknown, data: unknown): asserts data is string {
  validateOcrPayloadWithLimits(mode, mediaType, data, { single: MAX_BASE64_LENGTH_SINGLE, bulk: MAX_BASE64_LENGTH_BULK });
}

export async function scanInspectionScheduleSlip(mode: OcrMode, mediaType: string, data: string): Promise<unknown> {
  const isBulk = mode === 'bulk';
  return scanDocument(
    'ocr.inspectionSchedule',
    mode,
    mediaType,
    data,
    isBulk ? BULK_PROMPT : SINGLE_PROMPT,
    isBulk ? BULK_MAX_TOKENS : SINGLE_MAX_TOKENS
  );
}
