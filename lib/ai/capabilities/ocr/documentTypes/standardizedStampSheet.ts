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

// [2026-08-13改訂 実API検証フェーズ]
// 実Anthropic APIによる実物1枚の検証で、記号(A/P/キャンセル)の抽出は65/65一致だった一方、
// 時間指定まわりで3件の誤確定が出た。原因はいずれもこのプロンプトの出力形状にあった。
//   (1) 時刻を「連結済みの文字列」で返させていたため、「時」の十の位マスが空欄の帳票を
//       モデルが "09:30" と0補完して返し、後段が補完を検知できなかった(1101号室・801号室)。
//   (2) 時刻を「本体グリッドの部屋行の属性」として返させていたため、どの部屋の時間指定かの
//       対応付けがモデル任せになり、1001号室の時間指定が隣接行の1002号室へ入った。
//   (3) room_numberを「4桁の数字」と指示していたため、3桁の部屋が "0801" と0埋めされた。
// 対策として、本体グリッドと時間指定エリアを別の配列として返させ、時刻・部屋番号は
// マス単位の配列(1マス1要素)で返させる。
const ROOM_GRID_INSTRUCTIONS =
  '出力のrooms配列には、本体グリッド（全戸の部屋番号とA/P/キャンセルのチェック欄）だけを' +
  '含めてください。時刻・備考はrooms側には一切含めないでください（時間指定は別配列で返します）。\n' +
  'rooms配列の各要素は次の形です。\n' +
  '{"room_number": "部屋番号（帳票に印字されている文字列をそのまま。3桁で印字されていれば' +
  '3桁のまま\'905\'、4桁で印字されていれば\'1005\'。先頭に0を足して4桁に揃えることは絶対に' +
  'しないでください。\'0905\'のような出力は誤りです）", ' +
  '"raw_checkboxes": {' +
  '"a_checked": "「午前」チェック欄にチェック・記載があればtrue、無ければfalse（true/booleanのみ。' +
  '推測で決めず、実際にマークが見える場合のみtrueにしてください）", ' +
  '"p_checked": "「午後」チェック欄にチェック・記載があればtrue、無ければfalse", ' +
  '"cancel_checked": "「キャンセル」チェック欄にチェック・記載があればtrue、無ければfalse"' +
  '}（重要：3つのチェック欄はそれぞれ完全に独立して判定してください。' +
  '「どれか1つを選ぶ」という前提を置かず、複数の欄に実際にマークがあれば複数をtrueにしてください。' +
  '1つのマークだけを選んで他を無視することは絶対にしないでください。)}\n' +
  '帳票に印字されているすべての部屋の行をrooms配列に含めてください（チェック欄が' +
  'すべて空欄の部屋も、room_numberが印字されている限り必ず含めてください。空欄の行を' +
  '省略しないでください）。同じ部屋番号を2回出力しないでください（1部屋につき必ず1要素です）。';

const TIME_DESIGNATION_INSTRUCTIONS =
  '出力のtime_designation_rows配列には、帳票下部の「時間指定欄」を1行ずつ返してください。' +
  '時間指定欄は左右2つのサブテーブルに分かれています。左サブテーブルの上の行から順に、' +
  '続けて右サブテーブルの上の行から順に、row_indexを1から連番で付けてください。' +
  '記入が無い空行も省略せず、すべての行を返してください。\n' +
  'time_designation_rows配列の各要素は次の形です。\n' +
  '{"row_index": 行番号（1から始まる整数）, ' +
  '"room_number_cells": "部屋番号欄のマスを左から順に1マス1要素で並べた配列（マスは4つ）。' +
  '各要素は必ず1文字にしてください。記入が無いマスは空文字\'\'、判読できないマスは' +
  '半角クエスチョンマーク\'?\'。3桁の部屋番号は左端のマスが空欄になるので、その場合は' +
  '[\'\',\'6\',\'0\',\'3\']のように左端を空文字にしてください（\'0\'で埋めないでください）", ' +
  '"start_time_cells": "開始時刻欄のマスを左から順に1マス1要素で並べた配列（時の十の位・' +
  '時の一の位・分の十の位・分の一の位の4つ）。記入が無いマスは空文字\'\'、判読できないマスは' +
  '\'?\'。【最重要】空欄のマスを0やその他の数字で埋めることは絶対にしないでください。' +
  '例えば「時」の十の位のマスが空欄で一の位に9と書かれている場合は、[\'\',\'9\',\'3\',\'0\']と' +
  '返してください。[\'0\',\'9\',\'3\',\'0\']と補完してはいけません", ' +
  '"end_time_cells": "同上、終了時刻欄の4マス。空欄マスは空文字、判読不能マスは\'?\'。' +
  '推測で埋めないこと", ' +
  // [2026-08-13追加] 実API検証で、区切り記号':'を1マスとして返してくる揺れが観測されたため明示する。
  '（start_time_cells・end_time_cells は必ず数字4マス分の配列にしてください。' +
  '「時」と「分」の間の区切り記号「:」は帳票に印刷された記号でありマスではないので、' +
  '配列の要素に含めないでください。記入が全く無い欄は4つとも空文字の配列 [\'\',\'\',\'\',\'\'] に' +
  'してください）, ' +
  '"remarks_raw": "その行の備考欄の手書き記載をそのまま書き起こした文字列。具体的な時刻へ' +
  '言い換えたり要約したりせず、書かれている通りに書き起こしてください（例：朝一、' +
  '以降いつでも等）。無ければ空文字"}\n' +
  '【最重要】各行のroom_number_cellsは、必ずその行自身の部屋番号欄を読み取ってください。' +
  '上下の行の部屋番号と取り違えないよう、行ごとに独立して読み取ってください。' +
  '部屋番号欄が判読できない行は、推測で部屋番号を補わず、判読できないマスを\'?\'にしてください。';

const QR_INSTRUCTION =
  '帳票にQRコードが印刷されている場合、読み取れた文字列をqr_code_raw欄（トップレベル）に' +
  '含めてください。判読・デコードできない場合は空文字としてください。\n' +
  '出力全体は必ず次の形のJSONオブジェクト1つだけとしてください。説明文やコードブロックの' +
  '記号は一切付けないでください。\n' +
  '{"rooms": [...], "time_designation_rows": [...], "qr_code_raw": "QRコードの内容、無ければ空文字"}';

const JSON_SHAPE_INSTRUCTIONS = ROOM_GRID_INSTRUCTIONS + TIME_DESIGNATION_INSTRUCTIONS;

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
  // [2026-08-13追加] 時間指定エリアを本体グリッドと分けて受け取る。モデルが返さなかった
  // 場合は空配列とし、時刻を本体グリッド側から拾うことはしない(拾うと誤確定の原因になる)。
  time_designation_rows: unknown[];
  qr_code_raw: string;
};

function isValidTopLevelShape(parsed: unknown): parsed is { rooms: unknown[]; qr_code_raw: string } {
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

  const timeRows = (parsed as Record<string, unknown>).time_designation_rows;
  if (!Array.isArray(timeRows)) {
    // 時間指定エリアが返らなかった場合でも、本体グリッド(記号)の結果は利用できるため
    // エラーにはしない。時刻は「読めなかった」として扱い、勝手に補完しない。
    console.error('[fireflow-api] standardizedStampSheet: time_designation_rows missing or not an array');
  }

  return { rooms: parsed.rooms, time_designation_rows: Array.isArray(timeRows) ? timeRows : [], qr_code_raw: parsed.qr_code_raw };
}
