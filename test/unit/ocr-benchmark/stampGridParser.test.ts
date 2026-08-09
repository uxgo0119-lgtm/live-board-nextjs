// test/unit/ocr-benchmark/stampGridParser.test.ts
//
// [2026-07-28新設] lib/ocr-benchmark/stampGridParser.ts (捺印表レイアウトのグリッドパーサー)の
// オフライン単体テスト。
//
// 【重要】このテストは実際のGoogle Cloud API(Vision/Document AI)を一切呼び出さない。
// Google Cloudの認証情報がまだこの環境に設定されていないため(ユーザーが別途準備中)、
// 「Vision API/Document AIが実際に返しそうな形」のダミーレスポンスを、実際に提供された
// 捺印表(コスモザ・パークスイースト1、/tmp/lb_tool/demo_real_inkanhyou.js参照)のレイアウト
// パターン(部屋番号の印字見出し行の直後に、手書きの日付+午前/午後の記入がある、という
// 縦方向の反復構造。5〜7部屋ずつが1列にまとまり複数列が横に並ぶ)を見て手作業で構築し、
// lib/ocr-benchmark/visionOcr.ts / documentAiOcr.ts の純粋変換関数
// (extractWordsFromVisionResponse / extractWordsFromDocumentAiResponse、いずれも
// ネットワーク呼び出しを含まない)→lib/ocr-benchmark/stampGridParser.ts という、
// 実運用と同じ変換パイプラインに通して検証する。
//
// 実行方法: 既存のtest:unitスクリプト(package.json)と同じ手法
// (`npx tsx <このファイル>`、他のtest/unit/**/*.test.tsと同じ実行パターン)。

import { extractWordsFromVisionResponse } from '../../../lib/ocr-benchmark/visionOcr';
import { extractWordsFromDocumentAiResponse } from '../../../lib/ocr-benchmark/documentAiOcr';
import { parseStampGridWords } from '../../../lib/ocr-benchmark/stampGridParser';
import type { VisionAnnotateImageResponseLike, DocumentAiProcessResponseLike } from '../../../lib/ocr-benchmark/googleAuth';
import type { StampSheetEntry } from '../../../lib/ocr-benchmark/types';

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error('FAIL: ' + msg);
  console.log('OK: ' + msg);
}

function assertEqual(actual: unknown, expected: unknown, msg: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`FAIL: ${msg}\n  期待値: ${e}\n  実際値: ${a}`);
  }
  console.log('OK: ' + msg);
}

// ---------------------------------------------------------------------------
// シナリオ1: Vision API風のダミーレスポンス(document.pages[].width/height ピクセル + vertices)
//
// 実際の捺印表の3列ぶんを模している(ページを1000x1000pxと仮定):
//   列1(x:50〜135付近): 1512号室(26(日)午後)→1412号室(25(土)午後、さらに次行に'13:00頃'の
//     補足メモ)。1412号室は列の最後(次の部屋番号行が無いまま列が終わる「列の端」ケース)。
//   列2(x:300〜385付近): 403号室(リフォーム中、日付の記入なし)→303号室(25(土)午前)。
//   列3(x:550〜630付近): 1516号室(記入が完全に空白→結果から除外されるべき)、その後に
//     帳票の説明文のような長いノイズ行(数字を含まない29文字)を挟んで、1416号室
//     (26(日)午前)。ノイズ行が1516号室のブロックにも1416号室のブロックにも紛れ込まない
//     ことを確認する。
// ---------------------------------------------------------------------------

function vertBox(x: number, y: number, w: number, h: number) {
  return {
    vertices: [
      { x, y },
      { x: x + w, y },
      { x: x + w, y: y + h },
      { x, y: y + h },
    ],
  };
}

function visionWord(text: string, x: number, y: number, w: number, h: number) {
  return {
    symbols: text.split('').map((ch) => ({ text: ch })),
    boundingBox: vertBox(x, y, w, h),
  };
}

const VISION_DUMMY_RESPONSE: VisionAnnotateImageResponseLike = {
  fullTextAnnotation: {
    text: '(参考用の全文。パーサーはwords側のみを使うため厳密な一致は不要)',
    pages: [
      {
        width: 1000,
        height: 1000,
        blocks: [
          {
            paragraphs: [
              {
                words: [
                  // --- 列1: 1512 → 1412(列の端、複数行の記入) ---
                  visionWord('1512', 50, 90, 60, 20),
                  visionWord('26(日)', 50, 125, 50, 18),
                  visionWord('午後', 105, 126, 30, 16),
                  visionWord('1412', 50, 195, 60, 20),
                  visionWord('25(土)', 50, 225, 50, 18),
                  visionWord('午後', 105, 226, 30, 16),
                  visionWord('13:00頃', 50, 245, 55, 16),

                  // --- 列2: 403(リフォーム中、日付なし) → 303(列の端) ---
                  visionWord('403', 300, 90, 60, 20),
                  visionWord('リフォーム中', 300, 125, 90, 18),
                  visionWord('303', 300, 195, 60, 20),
                  visionWord('25(土)', 300, 225, 50, 18),
                  visionWord('午前', 355, 226, 25, 16),

                  // --- 列3: 1516(空白→除外) → ノイズ行 → 1416(列の端) ---
                  visionWord('1516', 550, 90, 60, 20),
                  visionWord(
                    'お世話になります恐れ入りますがよろしくお願い申し上げます',
                    550,
                    130,
                    200,
                    16
                  ),
                  visionWord('1416', 550, 195, 60, 20),
                  visionWord('26(日)', 550, 225, 50, 18),
                  visionWord('午前', 605, 226, 25, 16),
                ],
              },
            ],
          },
        ],
      },
    ],
  },
};

const EXPECTED_VISION_RESULT: StampSheetEntry[] = [
  { room_number: '1512', symbol: 'P', time: '', time_end: '', note: '', name: '', date: '26(日)' },
  { room_number: '1412', symbol: 'P', time: '', time_end: '', note: '13:00頃', name: '', date: '25(土)' },
  { room_number: '403', symbol: '', time: '', time_end: '', note: 'リフォーム中', name: '', date: '' },
  { room_number: '303', symbol: 'A', time: '', time_end: '', note: '', name: '', date: '25(土)' },
  { room_number: '1416', symbol: 'A', time: '', time_end: '', note: '', name: '', date: '26(日)' },
];

function runVisionScenario() {
  const extraction = extractWordsFromVisionResponse(VISION_DUMMY_RESPONSE);
  assert(extraction.words.length > 0, 'Vision風ダミーレスポンスから単語が抽出できる');

  const parsed = parseStampGridWords(extraction.words);
  assertEqual(parsed, EXPECTED_VISION_RESULT, 'Vision風ダミーレスポンス: パース結果が期待通りの5件(3列)になる');

  assert(
    parsed.every((e) => e.room_number !== '1516'),
    '記入が完全に空白の部屋(1516)は結果に含まれない'
  );
  assert(
    parsed.find((e) => e.room_number === '403')!.symbol === '',
    'リフォーム中(日付記入なし)の部屋はsymbolが空文字'
  );
  assert(
    parsed.find((e) => e.room_number === '403')!.note === 'リフォーム中',
    'リフォーム中の部屋はnoteに原文が入る'
  );
  assert(
    parsed.find((e) => e.room_number === '1412')!.note === '13:00頃',
    '列の端の部屋(1412)でも、日付+symbol行の下の補足メモ行が正しくnoteに入る'
  );
  assert(
    parsed.find((e) => e.room_number === '1416') !== undefined,
    '空白部屋とノイズ行を挟んでも、次の部屋(1416)は正しくパースされる(ノイズ行が紛れ込まない)'
  );
}

// ---------------------------------------------------------------------------
// シナリオ2: Document AI風のダミーレスポンス(document.text + textAnchor.textSegments +
// normalizedVertices)。同じstampGridParserが、Vision/Document AIどちらの共通中間形式からも
// 同じ結果を組み立てられること(=プロバイダ非依存の設計になっていること)を確認する。
// 部屋番号1件+キャンセルのケースを含めて検証する。
// ---------------------------------------------------------------------------

function buildDocumentAiFixture(): { response: DocumentAiProcessResponseLike; expected: StampSheetEntry[] } {
  // フルテキストの中に、各トークンのテキストをこの順で連結して埋め込み、
  // textSegmentsでその位置を指す(実際のDocument AIのtextAnchorと同じ表現)。
  const tokens: Array<{ text: string; box: { x: number; y: number; w: number; h: number } }> = [
    { text: '912', box: { x: 0.05, y: 0.09, w: 0.06, h: 0.02 } },
    { text: '26(日)', box: { x: 0.05, y: 0.125, w: 0.05, h: 0.018 } },
    { text: 'キャンセル', box: { x: 0.11, y: 0.126, w: 0.06, h: 0.016 } },
  ];

  let fullText = '';
  const segments: Array<{ startIndex: number; endIndex: number }> = [];
  for (const t of tokens) {
    const start = fullText.length;
    fullText += t.text;
    segments.push({ startIndex: start, endIndex: fullText.length });
    fullText += '\n'; // トークン間の区切り(実際のdocument.textにも改行等が挟まる)
  }

  const response: DocumentAiProcessResponseLike = {
    document: {
      text: fullText,
      pages: [
        {
          tokens: tokens.map((t, i) => ({
            layout: {
              textAnchor: { textSegments: [segments[i]] },
              boundingPoly: {
                normalizedVertices: [
                  { x: t.box.x, y: t.box.y },
                  { x: t.box.x + t.box.w, y: t.box.y },
                  { x: t.box.x + t.box.w, y: t.box.y + t.box.h },
                  { x: t.box.x, y: t.box.y + t.box.h },
                ],
              },
            },
          })),
        },
      ],
    },
  };

  const expected: StampSheetEntry[] = [
    { room_number: '912', symbol: 'キャンセル', time: '', time_end: '', note: '', name: '', date: '26(日)' },
  ];

  return { response, expected };
}

function runDocumentAiScenario() {
  const { response, expected } = buildDocumentAiFixture();
  const extraction = extractWordsFromDocumentAiResponse(response);
  assert(extraction.words.length === 3, 'Document AI風ダミーレスポンスから3トークン分の単語が抽出できる');
  assertEqual(
    extraction.words.map((w) => w.text),
    ['912', '26(日)', 'キャンセル'],
    'Document AI風ダミーレスポンス: textAnchor.textSegmentsからのテキスト切り出しが正しい'
  );

  const parsed = parseStampGridWords(extraction.words);
  assertEqual(parsed, expected, 'Document AI風ダミーレスポンス: キャンセル(symbol)+日付のパースが正しい');
}

// ---------------------------------------------------------------------------
// シナリオ3: 完全に空の入力(単語が1つも検出できなかった場合)。クラッシュせず空配列を返す。
// ---------------------------------------------------------------------------

function runEmptyInputScenario() {
  const parsed = parseStampGridWords([]);
  assertEqual(parsed, [], '単語が1つも無い場合は空配列を返す(クラッシュしない)');
}

runVisionScenario();
runDocumentAiScenario();
runEmptyInputScenario();

console.log('ALL PASS: ocr-benchmark/stampGridParser.test.ts');
