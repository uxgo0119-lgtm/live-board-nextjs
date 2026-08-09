// [2026-07-27新設 Phase7] 「紙の点検予定表」帳票OCRというタスク固有の知識(プロンプト文言・
// 入力サイズ上限・max_tokens・入力の検証・出力形状の検証)をここに閉じ込める。実際に
// どのAIプロバイダが処理するかは lib/ai/router.ts が解決するため、このファイルはプロバイダ名
// (Anthropic/OpenAI/Gemini等)を一切知らない(documentTypes/residentTimeRequestSheet.tsと
// 同じ構造)。
//
// 「紙の点検予定表」とは: 管理会社が用意する、部屋ごとに何日目のAM/PMにどう対応したか
// (PASS/キャンセル/未回答/不在等)が書かれた帳票。ocr_intake/mock_ocr_provider.js が
// Phase2〜6でダミーとして返してきた rawRooms 形式に対応する、実際のOCR接続版。
//
// 【重要・設計判断】プロンプトが要求するJSON出力の各フィールド名は、
// lb_tool/ocr_intake/mock_ocr_provider.js の getMockOcrRawResult() が返す rawRooms の
// 各要素(roomNumberRaw/scheduleDayRaw/periodRaw/timeRaw/noteRaw/statusRaw/ladderRaw/
// memoRaw/confidence)と一字一句そろえてある。これにより、実際のAPIレスポンスを
// フィールド名の変換層を別途作らずにそのまま
// lb_tool/ocr_intake/normalize/normalizeInspectionScheduleSheet.js へ渡せる(型定義は
// lib/ai/types.ts の InspectionScheduleSheetOcrRoomResult を参照)。将来API側のJSON形状を
// 変える場合は、変換アダプタの追加を検討すること。
//
// 【重要・信頼度について】confidenceの値はAIモデルに自己評価させたものであり、
// 統計的にキャリブレーションされた確率ではない(あくまでモデル自身の申告値であり、
// 実際の正解率と一致する保証はない)。UI側では「要確認」の目安・参考値として扱うこと
// (lib/ai/types.ts の InspectionScheduleSheetOcrRoomResult のコメントにも同旨を明記)。

import { ApiError } from '../../../../http/apiError';
import type { OcrMode } from '../../../types';
import { validateOcrPayload as validateOcrPayloadWithLimits, scanDocument, COMMON_OCR_NOTATION_GUIDE } from '../core/commonExtractor';

// 出力するJSON配列の形状を指定する指示文言(single/bulk共通)。
const JSON_SHAPE_INSTRUCTIONS =
  '出力は必ず次の形のJSON配列のみとしてください。説明文やコードブロックの記号は一切付けないでください。\n' +
  '[{"roomNumberRaw": "部屋番号の記載をそのまま書き起こした文字列（判読できなければ空文字）", ' +
  '"scheduleDayRaw": "工程日（何日目に対応する予定か）の記載をそのまま書き起こした文字列' +
  '（例:\'2日目\'。記載が無ければnull）", ' +
  '"periodRaw": "時間帯欄の記載をそのまま書き起こした文字列（例:\'AM\'、\'午後\'。記載が無ければnull）", ' +
  '"timeRaw": "具体的な時刻の記載をそのまま書き起こした文字列（例:\'13:00\'。記載が無ければnull）", ' +
  '"noteRaw": "時間欄付近の手書き補足の記載をそのまま書き起こした文字列（無ければnull）", ' +
  '"statusRaw": "対応状況欄の記載をそのまま書き起こした文字列' +
  '（例:\'PASS\'、\'キャンセル\'、\'不在\'、\'未回答\'等。記載が無ければnull）", ' +
  '"ladderRaw": "避難はしごに関する記載をそのまま書き起こした文字列' +
  '（対象である旨の記載があればその文字列、無ければnull）", ' +
  '"memoRaw": "その他の欄外の手書きメモの記載をそのまま書き起こした文字列（無ければ空文字）", ' +
  '"confidence": {"roomNumber": 読み取りの確信度を0.0（全く自信が無い）〜1.0（完全に自信がある）の' +
  '数値で自己評価したもの, "scheduleDay": 同様に自己評価した数値, "period": 同様, "time": 同様, ' +
  '"status": 同様}}, ...]\n' +
  '表に記載されている部屋の行をすべて配列に含めてください(部屋番号欄が判読できない行があっても、' +
  '行自体が存在する場合はroomNumberRawを空文字として含めてください。行の内容を推測で作り出したり、' +
  '逆に読み取れた行を省略したりしないでください)。';

const SINGLE_PROMPT =
  '添付の画像は、消防点検の点検予定表です。管理会社が用意した帳票で、部屋ごとに何日目の' +
  'AM/PMにどう対応したか(PASS/キャンセル/未回答/不在等)が記載されています。1枚の画像に' +
  '複数の部屋の行が含まれています。' +
  COMMON_OCR_NOTATION_GUIDE +
  JSON_SHAPE_INSTRUCTIONS;

const BULK_PROMPT =
  '添付のPDFには、消防点検の点検予定表が複数ページ含まれています。管理会社が用意した帳票で、' +
  '部屋ごとに何日目のAM/PMにどう対応したか(PASS/キャンセル/未回答/不在等)が記載されています。' +
  '各ページに複数の部屋の行が含まれています。すべてのページ・すべての行を読み取ってください。' +
  COMMON_OCR_NOTATION_GUIDE +
  JSON_SHAPE_INSTRUCTIONS;

// [判断理由] Single/Bulkとも、点検希望時間連絡票(1件=1部屋)と異なり「1枚の帳票に多数の部屋の
// 行が含まれる表形式」が主用途であるため、ファイルサイズ上限は既存値を流用しつつ
// (画像/PDFのバイト数の上限であり、行数そのものには連動しないため据え置いてよいと判断)、
// max_tokensは出力がJSON配列(部屋数分の要素)になる分、既存の点検希望時間連絡票OCRより
// 大きく確保する。数十部屋規模の1ページ(single)・複数ページ分の合算(bulk)を見込み、
// singleは既存の点検希望時間連絡票(400)から大幅に増やして8000、bulkは既存(16000)より
// さらに余裕を持たせて24000とした(いずれも実データでの精度・トークン消費量の実測は
// 本セッションでは行えていないため、Phase7完了報告書の「次Phaseで行う内容」に記載の
// 実運用移行チェックリストで、実際の帳票を用いた検証・チューニングが必要)。
export const MAX_BASE64_LENGTH_SINGLE = 8 * 1000 * 1000;
export const MAX_BASE64_LENGTH_BULK = 30 * 1000 * 1000;
const SINGLE_MAX_TOKENS = 8000;
const BULK_MAX_TOKENS = 24000;

export function validateOcrPayload(mode: unknown, mediaType: unknown, data: unknown): asserts data is string {
  validateOcrPayloadWithLimits(mode, mediaType, data, { single: MAX_BASE64_LENGTH_SINGLE, bulk: MAX_BASE64_LENGTH_BULK });
}

export async function scanInspectionScheduleSheet(mode: OcrMode, mediaType: string, data: string): Promise<unknown> {
  const isBulk = mode === 'bulk';
  const parsed = await scanDocument(
    'ocr.inspectionScheduleSheet',
    mode,
    mediaType,
    data,
    isBulk ? BULK_PROMPT : SINGLE_PROMPT,
    isBulk ? BULK_MAX_TOKENS : SINGLE_MAX_TOKENS
  );

  // [重要] providers/配下の各Adapter(anthropic/openai/gemini)は、bulkモードの場合のみ
  // 配列であることを検証する(帳票種別非依存の共通挙動)。この帳票種別は1枚の画像でも
  // 複数部屋の行を返す表形式であるため、singleモードでも配列であることをここ
  // (帳票種別固有の要件を知っているレイヤー)で追加検証する。
  if (!Array.isArray(parsed)) {
    console.error('[fireflow-api] unexpected non-array response for inspectionScheduleSheet:', JSON.stringify(parsed).slice(0, 500));
    throw new ApiError(502, '想定外の形式で結果が返されました。もう一度お試しください。');
  }

  return parsed;
}
