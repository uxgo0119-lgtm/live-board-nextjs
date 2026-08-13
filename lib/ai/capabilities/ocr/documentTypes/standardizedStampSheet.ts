// lib/ai/capabilities/ocr/documentTypes/standardizedStampSheet.ts
//
// [2026-08-11新設 新捺印表OCR P0実装]
// 新捺印表(Standardized Stamp Sheet、KB-024)というタスク固有の知識(プロンプト文言・
// 入力サイズ上限・max_tokens・入力の検証・出力形状の検証)をここに閉じ込める。
// documentTypes/inspectionScheduleSheet.ts と同じ構造(共通OCRコア層 core/commonExtractor
// 経由)を踏襲する。
//
// 【最重要方針】既存Legacy捺印表(documentTypes/residentTimeRequestSheet.ts、単一値symbol・
// 部屋ごとに1枚の連絡票を前提とするプロンプト)は1文字も変更しない。新捺印表は
// 「A4 1枚に全戸番号印字済み」という全く異なる帳票構造であり、完全に独立した新しい
// タスク('ocr.standardizedStampSheet')・新しいプロンプトとして追加する。
//
// 【帳票構造(ユーザー確定、設計書Section 3.1)】
// A4 1枚・全戸の部屋番号印字済み・A/P/キャンセルは固定位置のチェック欄(3つ独立)・
// 時間指定は別エリア(部屋番号4桁+開始HH:MM+終了HH:MMを1マス1文字のグリッド)・
// 備考のみ自由記述・QRコードあり・fixed-layout。
//
// 【KB-024「誤確定0優先」との対応、プロンプト設計上の要点】
// 1. A/P/キャンセルを単一値へ強制せず、3つの独立したbooleanとして出力させる
//    (Legacy側のsymbol単一値スキーマの誤り=802号室のA+P同時チェック問題を、
//     プロンプトの入口から再発させないための設計)。
// 2. 時間指定グリッドは1マス1文字構造を踏まえ、判読不能なマスは絶対に別の数字で
//    埋めず、必ず"?"で返すよう明示的に指示する(推測による桁埋めの禁止)。
// 3. 備考は原文のまま書き起こすことを明示し、具体的な時刻への言い換え・要約を禁止する
//    (KB-018と同じ既存の禁止事項を、新経路のプロンプトでも踏襲する)。
// 4. QRコードが読み取れた場合は、そこに含まれる文字列をlayoutFormatIdRawとしてそのまま
//    返させる(将来のフォーマットバージョン識別に使う可能性があるため。読み取れなければ
//    空文字とし、無理に解読・推測させない)。

import { ApiError } from '../../../../http/apiError';
import type { OcrMode } from '../../../types';
import { validateOcrPayload as validateOcrPayloadWithLimits, scanDocument, COMMON_OCR_NOTATION_GUIDE } from '../core/commonExtractor';

const JSON_SHAPE_INSTRUCTIONS =
  '出力は必ず次の形のJSON配列のみとしてください。説明文やコードブロックの記号は一切付けないでください。\n' +
  '[{"room_number": "部屋番号（帳票に印字されている番号をそのまま。4桁の数字）", ' +
  '"raw_checkboxes": {' +
  '"a_checked": "「午前」チェック欄にチェック・記載があればtrue、無ければfalse（true/booleanのみ。' +
  '推測で決めず、実際にマークが見える場合のみtrueにしてください）", ' +
  '"p_checked": "「午後」チェック欄にチェック・記載があればtrue、無ければfalse", ' +
  '"cancel_checked": "「キャンセル」チェック欄にチェック・記載があればtrue、無ければfalse"' +
  '}（重要：3つのチェック欄はそれぞれ完全に独立して判定してください。' +
  '「どれか1つを選ぶ」という前提を置かず、複数の欄に実際にマークがあれば複数をtrueにしてください。' +
  '1つのマークだけを選んで他を無視することは絶対にしないでください。), ' +
  '"time_start_raw": "時間指定グリッドの開始時刻欄（1マス1文字のHH:MM形式）を、マスごとに' +
  '判読した文字をそのまま連結した文字列。判読できないマスがあれば、そのマスだけを' +
  '半角クエスチョンマーク\'?\'に置き換えてください（例: \'1?:00\'）。他の数字で推測して' +
  '埋めることは絶対にしないでください。記入が無ければ空文字。", ' +
  '"time_end_raw": "同上、終了時刻欄について。判読できないマスは\'?\'に置き換え、推測しないこと。' +
  '記入が無ければ空文字。", ' +
  '"note_raw": "備考欄の手書き記載をそのまま書き起こした文字列。具体的な時刻へ言い換えたり' +
  '要約したりせず、書かれている通りに書き起こしてください（例：朝一、以降いつでも等）。' +
  '無ければ空文字。"}, ...]\n' +
  '帳票に印字されているすべての部屋の行を配列に含めてください（チェック欄・時間指定欄が' +
  'すべて空欄の部屋も、room_numberが印字されている限り必ず配列に含めてください。' +
  '空欄の行を省略しないでください）。';

const QR_INSTRUCTION =
  '帳票にQRコードが印刷されている場合、読み取れた文字列をqr_code_raw欄（配列の外、' +
  'トップレベル）に含めてください。判読・デコードできない場合は空文字としてください。' +
  '出力全体は {"rooms": [...上記の配列...], "qr_code_raw": "QRコードの内容、無ければ空文字"} ' +
  'という形にしてください（配列ではなくオブジェクトがトップレベルです）。';

const SINGLE_PROMPT =
  '添付の画像は、消防点検の「新捺印表」です。A4用紙1枚に、全戸の部屋番号があらかじめ印字されており、' +
  '各部屋に「午前」「午後」「キャンセル」の固定位置チェック欄があります。それとは別のエリアに、' +
  '時間を指定したい部屋番号・希望時刻を、1マスに1文字ずつ手書きで記入するグリッドがあります。' +
  COMMON_OCR_NOTATION_GUIDE +
  JSON_SHAPE_INSTRUCTIONS +
  QR_INSTRUCTION;

const BULK_PROMPT =
  '添付のPDFには、消防点検の「新捺印表」が複数ページ含まれています。各ページはA4用紙1枚に' +
  '全戸の部屋番号があらかじめ印字されており、各部屋に「午前」「午後」「キャンセル」の固定位置' +
  'チェック欄があります。それとは別のエリアに、時間を指定したい部屋番号・希望時刻を、1マスに' +
  '1文字ずつ手書きで記入するグリッドがあります。すべてのページを読み取ってください。' +
  COMMON_OCR_NOTATION_GUIDE +
  JSON_SHAPE_INSTRUCTIONS +
  QR_INSTRUCTION;

// [判断理由] 新捺印表はinspectionScheduleSheet.tsと同じく「1枚の帳票に多数の部屋行」が
// 前提のため、そのファイルサイズ上限・max_tokensの考え方をそのまま踏襲する。実データでの
// 精度・トークン消費量は未検証(実物サンプル未入手のため)であり、設計書Section 6の
// CONDITIONAL GO項目のとおり、実物サンプル入手後にチューニングが必要。
export const MAX_BASE64_LENGTH_SINGLE = 8 * 1000 * 1000;
export const MAX_BASE64_LENGTH_BULK = 30 * 1000 * 1000;
const SINGLE_MAX_TOKENS = 9000;
const BULK_MAX_TOKENS = 27000;

export function validateOcrPayload(mode: unknown, mediaType: unknown, data: unknown): asserts data is string {
  validateOcrPayloadWithLimits(mode, mediaType, data, { single: MAX_BASE64_LENGTH_SINGLE, bulk: MAX_BASE64_LENGTH_BULK });
}

export type StandardizedStampSheetScanResult = {
  rooms: unknown[];
  qr_code_raw: string;
};

function isValidTopLevelShape(parsed: unknown): parsed is StandardizedStampSheetScanResult {
  return (
    !!parsed &&
    typeof parsed === 'object' &&
    Array.isArray((parsed as Record<string, unknown>).rooms) &&
    typeof (parsed as Record<string, unknown>).qr_code_raw === 'string'
  );
}

export async function scanStandardizedStampSheet(mode: OcrMode, mediaType: string, data: string): Promise<StandardizedStampSheetScanResult> {
  const isBulk = mode === 'bulk';
  const parsed = await scanDocument(
    'ocr.standardizedStampSheet',
    mode,
    mediaType,
    data,
    isBulk ? BULK_PROMPT : SINGLE_PROMPT,
    isBulk ? BULK_MAX_TOKENS : SINGLE_MAX_TOKENS
  );

  // [重要] 新捺印表は{"rooms": [...], "qr_code_raw": "..."}というオブジェクト形状を要求する
  // (Legacy側やinspectionScheduleSheet.tsの配列直下とは異なる形状。QRコード情報をトップ
  // レベルに持たせるため)。この形状検証はこの帳票種別固有の要件であり、ここで行う。
  if (!isValidTopLevelShape(parsed)) {
    console.error('[fireflow-api] unexpected shape for standardizedStampSheet:', JSON.stringify(parsed).slice(0, 500));
    throw new ApiError(502, '想定外の形式で結果が返されました。もう一度お試しください。');
  }

  return parsed;
}
