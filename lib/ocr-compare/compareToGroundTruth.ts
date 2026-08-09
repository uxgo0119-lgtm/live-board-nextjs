// lib/ocr-compare/compareToGroundTruth.ts
//
// [2026-08-05新設] ③LB取込直前データ(LbNormalizedEntry[])を、人間が原紙を確認して作成した
// 正解データ(GroundTruthEntry[]、lib/ocr-benchmark/types.tsのStampSheetEntryを再利用)と
// 項目別に比較する。
//
// 【最重要方針の遵守】
// - AI同士の多数決は一切行わない。比較対象は常に「人間が確認した正解データ」のみ。
// - 「存在しない部屋の追加」(phantom)と「存在する部屋の欠落」(missing)を別々に集計する
//   (既存のlib/ocr-benchmark/failureAnalysis.tsは欠落側の判定ロジックのみ持っており、
//   phantom側は無かったため、ここで新規に追加する。欠落側の判定ロジック自体は
//   既存のcomputeFailureCases()をそのまま再利用する=重複実装しない)。
// - 部屋番号だけでなく、symbol・time・time_end・note・name・dateを項目別に比較する。

import type { StampSheetEntry } from '../ocr-benchmark/types';
import { computeFailureCases } from '../ocr-benchmark/failureAnalysis';
import type {
  GroundTruthEntry,
  LbNormalizedEntry,
  OcrCompareProviderKey,
  ProviderAccuracySummary,
  RoomFieldComparison,
} from './types';
// [2026-08-06追加 評価ロジックP0改善] 時刻・日付を「表記差のみ」と「本当の不一致」に
// 分けて判定するための比較専用ロジック。OCR結果・Ground Truthの値そのものは変更しない。
import { compareTimeValues, compareDateValues, type FieldComparisonDetail } from './normalizeTimeAndDate';

const COMPARABLE_FIELDS: Array<'symbol' | 'time' | 'time_end' | 'note' | 'name' | 'date'> = [
  'symbol',
  'time',
  'time_end',
  'note',
  'name',
  'date',
];

// LbNormalizedEntry(dateRaw)とStampSheetEntry(date)はフィールド名が1つ違うだけで、
// それ以外は完全に同じ形なので、既存のfailureAnalysis.tsをそのまま再利用するために
// このアダプタで変換する(値そのものは一切変更しない)。
function toStampSheetEntry(e: LbNormalizedEntry): StampSheetEntry {
  return {
    room_number: e.room_number,
    symbol: e.symbol,
    time: e.time,
    time_end: e.time_end,
    note: e.note,
    name: e.name,
    date: e.dateRaw,
  };
}

// 【新規ロジック】正解データに存在しない部屋番号をOCR結果側から検出する(=存在しない部屋の
// 追加)。既存のfailureAnalysis.computeFailureCases()は「正解データを基準に」走査するため、
// この向き(OCR結果を基準に、正解データに無いものを探す)の判定は行っていない。
export function computePhantomRooms(entries: LbNormalizedEntry[], groundTruth: GroundTruthEntry[]): string[] {
  const gtRooms = new Set(groundTruth.map((g) => g.room_number));
  const seen = new Set<string>();
  const phantoms: string[] = [];
  for (const e of entries) {
    if (!gtRooms.has(e.room_number) && !seen.has(e.room_number)) {
      seen.add(e.room_number);
      phantoms.push(e.room_number);
    }
  }
  return phantoms;
}

// 部屋ごと・項目ごとの○/×比較テーブル(ユーザー指定のUIイメージ「部屋101 / Anthropic:午前 /
// Gemini:午後 / 正解:午後」の元データ)を組み立てる。正解データに存在する部屋と、
// OCR結果にしか存在しない部屋(phantom)の両方を含む(和集合)。
export function buildRoomComparisons(entries: LbNormalizedEntry[], groundTruth: GroundTruthEntry[]): RoomFieldComparison[] {
  const entryByRoom = new Map(entries.map((e) => [e.room_number, e]));
  const gtByRoom = new Map(groundTruth.map((g) => [g.room_number, g]));
  const phantomRooms = new Set(computePhantomRooms(entries, groundTruth));

  const allRoomNumbers = Array.from(new Set([...gtByRoom.keys(), ...entryByRoom.keys()]));
  // 表示順は正解データの並び順を優先し、phantom(正解に無い部屋)は末尾にまとめる。
  allRoomNumbers.sort((a, b) => {
    const aIsPhantom = phantomRooms.has(a);
    const bIsPhantom = phantomRooms.has(b);
    if (aIsPhantom !== bIsPhantom) return aIsPhantom ? 1 : -1;
    return a.localeCompare(b, 'ja');
  });

  return allRoomNumbers.map((room) => {
    const gt = gtByRoom.get(room) || null;
    const actual = entryByRoom.get(room) || null;
    const isPhantomRoom = !gt && !!actual;
    const isMissingRoom = !!gt && !actual;
    const fieldMatches: RoomFieldComparison['fieldMatches'] = {};
    // [2026-08-06追加 評価ロジックP0改善] gt・actual双方が存在する部屋のみ、time/dateの
    // 詳細な意味比較情報を追加で計算する。既存のfieldMatches(完全文字列一致)の計算方法・
    // 値は一切変更しない(下のfor文はそのまま)。
    let timeDetail: FieldComparisonDetail | undefined;
    let dateDetail: FieldComparisonDetail | undefined;
    if (gt && actual) {
      for (const field of COMPARABLE_FIELDS) {
        const expectedValue = field === 'date' ? gt.date : gt[field];
        const actualValue = field === 'date' ? actual.dateRaw : actual[field];
        fieldMatches[field] = (expectedValue || '') === (actualValue || '');
      }
      timeDetail = compareTimeValues(gt.time || '', actual.time || '');
      dateDetail = compareDateValues(gt.date || '', actual.dateRaw || '');
    }
    return {
      room_number: room,
      presentInGroundTruth: !!gt,
      presentInOcrResult: !!actual,
      isPhantomRoom,
      isMissingRoom,
      fieldMatches,
      expected: gt ? { room_number: gt.room_number, symbol: gt.symbol, time: gt.time, time_end: gt.time_end, note: gt.note, name: gt.name, dateRaw: gt.date } : null,
      actual: actual ? { ...actual } : null,
      ...(timeDetail ? { timeDetail } : {}),
      ...(dateDetail ? { dateDetail } : {}),
    };
  });
}

function safeRate(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return numerator / denominator;
}

export function computeProviderAccuracySummary(
  provider: OcrCompareProviderKey,
  entries: LbNormalizedEntry[],
  groundTruth: GroundTruthEntry[],
  processingTimeMs: number | null
): ProviderAccuracySummary {
  const stampEntries = entries.map(toStampSheetEntry);
  // 欠落(missing)側は既存のcomputeFailureCases()をそのまま再利用する。
  const failureCases = computeFailureCases(stampEntries, groundTruth);
  const missingRoomCount = failureCases.filter((c) => c.roomNotDetected).length;
  const phantomRoomCount = computePhantomRooms(entries, groundTruth).length;

  const totalGroundTruthRooms = groundTruth.length;
  const roomNumberRecognitionRate = safeRate(totalGroundTruthRooms - missingRoomCount, totalGroundTruthRooms);

  const entryByRoom = new Map(entries.map((e) => [e.room_number, e]));

  const fieldAccuracy: ProviderAccuracySummary['fieldAccuracy'] = {
    symbol: null,
    time: null,
    time_end: null,
    note: null,
    name: null,
    date: null,
  };
  for (const field of COMPARABLE_FIELDS) {
    let matches = 0;
    for (const gt of groundTruth) {
      const actual = entryByRoom.get(gt.room_number);
      if (!actual) continue; // 欠落は「不一致」としてroomNumberRecognitionRate側で計上済み。fieldAccuracyの分母には含めない(欠落と値誤りを混同しないため)。
      const expectedValue = field === 'date' ? gt.date : gt[field];
      const actualValue = field === 'date' ? actual.dateRaw : actual[field];
      if ((expectedValue || '') === (actualValue || '')) matches++;
    }
    // 分母は「OCR側で部屋が見つかった正解データ件数」(欠落分は除く)。欠落を含めたい場合は
    // roomNumberRecognitionRateとあわせて見ること。
    const foundCount = groundTruth.filter((gt) => entryByRoom.has(gt.room_number)).length;
    fieldAccuracy[field] = safeRate(matches, foundCount);
  }

  // 午前/午後(symbol='A'|'P')に限定した一致率。
  const ampmRows = groundTruth.filter((gt) => gt.symbol === 'A' || gt.symbol === 'P');
  let ampmMatches = 0;
  for (const gt of ampmRows) {
    const actual = entryByRoom.get(gt.room_number);
    if (actual && actual.symbol === gt.symbol) ampmMatches++;
  }
  const ampmAccuracy = safeRate(ampmMatches, ampmRows.length);

  // キャンセルに限定した一致率。
  const cancelRows = groundTruth.filter((gt) => gt.symbol === 'キャンセル');
  let cancelMatches = 0;
  for (const gt of cancelRows) {
    const actual = entryByRoom.get(gt.room_number);
    if (actual && actual.symbol === 'キャンセル') cancelMatches++;
  }
  const cancelAccuracy = safeRate(cancelMatches, cancelRows.length);

  // 空欄判定(symbol='' かつ time/time_endともに空欄=希望なし)に限定した一致率。
  const blankRows = groundTruth.filter((gt) => gt.symbol === '' && !gt.time && !gt.time_end);
  let blankMatches = 0;
  for (const gt of blankRows) {
    const actual = entryByRoom.get(gt.room_number);
    if (actual && actual.symbol === '' && !actual.time && !actual.time_end) blankMatches++;
  }
  const blankAccuracy = safeRate(blankMatches, blankRows.length);

  // [2026-08-06追加 評価ロジックP0改善] 時刻・日付の意味比較(表記差を無視した一致率)。
  // 分母は既存のfieldAccuracyと全く同じ「OCR側で部屋が見つかった正解データ件数」
  // (foundCount、欠落部屋は含まない)。semanticFieldStats()はcompareGeneric()を
  // 呼び出すだけで、既存のfieldAccuracy計算(上のfor文)には一切手を加えていない。
  function semanticFieldStats(
    compareFn: (gtRaw: string, actualRaw: string) => FieldComparisonDetail,
    expectedOf: (gt: GroundTruthEntry) => string,
    actualOf: (actual: LbNormalizedEntry) => string
  ): {
    semanticAccuracy: number | null;
    formatOnlyDifferenceCount: number;
    actualMismatchCount: number;
    missingCount: number;
    unparseableCount: number;
  } {
    let semanticMatches = 0;
    let formatOnlyDifferenceCount = 0;
    let actualMismatchCount = 0;
    let missingCount = 0;
    let unparseableCount = 0;
    let foundCount = 0;
    for (const gt of groundTruth) {
      const actual = entryByRoom.get(gt.room_number);
      if (!actual) continue; // 欠落は既存fieldAccuracyと同様、分母に含めない。
      foundCount++;
      const detail = compareFn(expectedOf(gt) || '', actualOf(actual) || '');
      if (detail.semanticMatch === true) semanticMatches++;
      if (detail.comparisonStatus === 'format_only_difference') formatOnlyDifferenceCount++;
      if (detail.comparisonStatus === 'actual_mismatch') actualMismatchCount++;
      if (detail.comparisonStatus === 'missing') missingCount++;
      if (detail.comparisonStatus === 'unparseable') unparseableCount++;
    }
    return {
      semanticAccuracy: safeRate(semanticMatches, foundCount),
      formatOnlyDifferenceCount,
      actualMismatchCount,
      missingCount,
      unparseableCount,
    };
  }

  const timeStats = semanticFieldStats(compareTimeValues, (gt) => gt.time, (a) => a.time);
  const timeEndStats = semanticFieldStats(compareTimeValues, (gt) => gt.time_end, (a) => a.time_end);
  const dateStats = semanticFieldStats(compareDateValues, (gt) => gt.date, (a) => a.dateRaw);

  return {
    provider,
    totalGroundTruthRooms,
    totalOcrRooms: entries.length,
    missingRoomCount,
    phantomRoomCount,
    roomNumberRecognitionRate: roomNumberRecognitionRate ?? 0,
    fieldAccuracy,
    ampmAccuracy,
    cancelAccuracy,
    blankAccuracy,
    processingTimeMs,
    // 既存fieldAccuracy.time/time_end/dateと全く同じ値のエイリアス(意味は変更していない)。
    timeRawAccuracy: fieldAccuracy.time,
    timeEndRawAccuracy: fieldAccuracy.time_end,
    dateRawAccuracy: fieldAccuracy.date,
    timeSemanticAccuracy: timeStats.semanticAccuracy,
    timeEndSemanticAccuracy: timeEndStats.semanticAccuracy,
    dateSemanticAccuracy: dateStats.semanticAccuracy,
    timeFormatOnlyDifferenceCount: timeStats.formatOnlyDifferenceCount,
    timeActualMismatchCount: timeStats.actualMismatchCount,
    timeMissingCount: timeStats.missingCount,
    timeUnparseableCount: timeStats.unparseableCount,
    dateFormatOnlyDifferenceCount: dateStats.formatOnlyDifferenceCount,
    dateActualMismatchCount: dateStats.actualMismatchCount,
    dateMissingCount: dateStats.missingCount,
    dateUnparseableCount: dateStats.unparseableCount,
  };
}
