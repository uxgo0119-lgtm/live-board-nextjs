// lib/ocr-benchmark/failureAnalysis.ts
//
// [2026-07-29新設] OCR結果と正解データ(ground truth)の差分を、失敗パターン別に分類・集計する。
//
// 【この分析の限界について、必ず読んでください】
// 正解データとの機械的な差分だけから自動分類できるのは「どの項目が」「どう間違ったか」
// (部屋番号・午前午後・日付・備考のどれで、値の誤り/見落とし/空欄の誤認識のどれか)まで。
// 「なぜ間違ったか」(手書き文字が原因/印鑑や罫線の重なりが原因/人間でも判読が難しい)は、
// 実際の原紙画像の該当箇所を目視で確認しないと判断できないため、このモジュールだけでは
// 自動分類できない。そのため、このモジュールは「原因カテゴリ」までは出さず、目視レビューが
// 必要なケースの一覧(部屋番号・項目・正解値・OCR結果)を出力するところまでを担当する。
// 目視レビュー(原紙画像との突き合わせ)は、実際のVision API実測結果が揃った時点で
// 別途実施する。

import type { StampSheetEntry } from './types';

export type MismatchSubtype =
  | 'wrong_value' // 正解・OCR結果ともに値があるが、内容が異なる(値の誤認識)
  | 'phantom_value' // 正解は空欄なのに、OCRが何らかの値を返した(空欄を文字として誤認識した可能性)
  | 'missed_value'; // 正解には値があるのに、OCRが空欄で返した(見落とし)

export type MismatchField = 'room_number' | 'symbol' | 'date' | 'note' | 'time' | 'time_end' | 'name';

export interface FailureCase {
  room_number: string;
  field: MismatchField;
  subtype: MismatchSubtype;
  expected: string;
  actual: string;
  // 部屋番号自体をOCRが検出できなかった特殊ケース(この場合、他のフィールドは比較不能)。
  roomNotDetected: boolean;
}

const COMPARABLE_FIELDS: MismatchField[] = ['symbol', 'date', 'note', 'time', 'time_end', 'name'];

// ユーザー指定カテゴリのうち、正解データとの差分だけで自動分類できる4カテゴリへのマッピング。
export const FIELD_LABEL_JA: Record<MismatchField, string> = {
  room_number: '部屋番号の誤認識',
  symbol: '午前／午後の誤認識',
  date: '日付の誤認識',
  note: '備考の誤認識',
  time: '希望時刻(time)の誤認識',
  time_end: '希望時刻終了(time_end)の誤認識',
  name: '氏名(name)の誤認識',
};

export function computeFailureCases(parsed: StampSheetEntry[], groundTruth: StampSheetEntry[]): FailureCase[] {
  const parsedByRoom = new Map(parsed.map((e) => [e.room_number, e]));
  const cases: FailureCase[] = [];

  for (const gt of groundTruth) {
    const found = parsedByRoom.get(gt.room_number);
    if (!found) {
      cases.push({
        room_number: gt.room_number,
        field: 'room_number',
        subtype: 'missed_value',
        expected: gt.room_number,
        actual: '(検出されず)',
        roomNotDetected: true,
      });
      continue;
    }
    for (const field of COMPARABLE_FIELDS) {
      const expected = (gt[field] || '').toString();
      const actual = (found[field] || '').toString();
      if (expected === actual) continue;
      let subtype: MismatchSubtype;
      if (expected === '' && actual !== '') subtype = 'phantom_value';
      else if (expected !== '' && actual === '') subtype = 'missed_value';
      else subtype = 'wrong_value';
      cases.push({ room_number: gt.room_number, field, subtype, expected, actual, roomNotDetected: false });
    }
  }
  return cases;
}

export interface FailureCategorySummary {
  key: string;
  label: string;
  count: number;
  ratioOfGroundTruth: number; // 正解データの総行数に対する割合
  examples: FailureCase[];
}

// フィールド別(部屋番号・午前午後・日付・備考・その他)に集計する(ユーザー指定カテゴリの
// うち、機械的に分類できる4分類+補助分類)。
export function summarizeByField(cases: FailureCase[], totalGroundTruth: number): FailureCategorySummary[] {
  const groups = new Map<MismatchField, FailureCase[]>();
  for (const c of cases) {
    if (!groups.has(c.field)) groups.set(c.field, []);
    groups.get(c.field)!.push(c);
  }
  const total = totalGroundTruth || 1;
  const summaries: FailureCategorySummary[] = [];
  for (const [field, list] of groups.entries()) {
    summaries.push({
      key: field,
      label: FIELD_LABEL_JA[field],
      count: list.length,
      ratioOfGroundTruth: list.length / total,
      examples: list.slice(0, 3),
    });
  }
  return summaries.sort((a, b) => b.count - a.count);
}

// 横断カテゴリ: 「空欄を文字として認識したケース」(phantom_value、フィールド問わず横断集計)。
// フィールド別集計と重複計上になる(例: symbolフィールドでphantom_valueだったケースは、
// 「午前／午後の誤認識」にも「空欄を文字として認識したケース」にも両方カウントされる)。
// これは意図的な仕様(どちらの切り口でも知りたい情報のため)であり、単純合計すると
// 正解データ件数を超えうる点に注意。
export function summarizePhantomValues(cases: FailureCase[], totalGroundTruth: number): FailureCategorySummary {
  const list = cases.filter((c) => c.subtype === 'phantom_value');
  const total = totalGroundTruth || 1;
  return {
    key: 'phantom_value',
    label: '空欄を文字として認識したケース(全フィールド横断)',
    count: list.length,
    ratioOfGroundTruth: list.length / total,
    examples: list.slice(0, 5),
  };
}

// 「手書き文字が原因」「印鑑や罫線の重なりが原因」「人間でも判読が難しいケース」「その他」は、
// 原紙画像との目視突き合わせが無いと分類できないため、このモジュールでは自動分類しない。
// 代わりに、目視レビューが必要な全ケース(room_numberの見落とし + wrong_value + missed_value、
// phantom_valueは除く=空欄誤認識はOCRのノイズ処理の問題である可能性が高く、原因切り分けの
// 優先度が異なるため)をレビュー待ちリストとして返す。
export function buildVisualReviewQueue(cases: FailureCase[]): FailureCase[] {
  return cases.filter((c) => c.subtype !== 'phantom_value');
}

export function printFailureAnalysisReport(label: string, parsed: StampSheetEntry[], groundTruth: StampSheetEntry[]): FailureCase[] {
  const cases = computeFailureCases(parsed, groundTruth);
  const byField = summarizeByField(cases, groundTruth.length);
  const phantom = summarizePhantomValues(cases, groundTruth.length);
  const reviewQueue = buildVisualReviewQueue(cases);

  console.log(`\n--- ${label}: 失敗パターン分析(正解データとの差分ベースで自動分類できる範囲) ---`);
  if (cases.length === 0) {
    console.log('差分なし(全項目が正解データと完全一致)。');
    return cases;
  }
  console.log('【自動分類できるカテゴリ(フィールド別)】');
  for (const s of byField) {
    console.log(`  ${s.label}: ${s.count}件 (正解データ${groundTruth.length}件中 ${(s.ratioOfGroundTruth * 100).toFixed(1)}%)`);
    for (const ex of s.examples) {
      console.log(`    例: 部屋${ex.room_number} 正解="${ex.expected}" OCR結果="${ex.actual}" (${ex.subtype})`);
    }
  }
  console.log(`\n【空欄を文字として認識したケース(横断集計、上記と重複あり)】`);
  console.log(`  ${phantom.count}件 (${(phantom.ratioOfGroundTruth * 100).toFixed(1)}%)`);
  for (const ex of phantom.examples) {
    console.log(`    例: 部屋${ex.room_number}の${FIELD_LABEL_JA[ex.field]} OCR結果="${ex.actual}"(正解は空欄)`);
  }
  console.log(`\n【原因分類に目視レビューが必要なケース(手書き文字/印鑑・罫線の重なり/判読困難/その他)】`);
  console.log(`  ${reviewQueue.length}件。原紙画像との突き合わせが必要なため、この一覧をJSON出力し、後日目視分類する。`);
  console.log(JSON.stringify(reviewQueue, null, 2));

  return cases;
}
