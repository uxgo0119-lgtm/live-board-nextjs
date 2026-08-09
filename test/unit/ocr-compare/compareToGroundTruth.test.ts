// [2026-08-05新設] lib/ocr-compare/compareToGroundTruth.ts の単体テスト。
// 「部屋の欠落」と「存在しない部屋の追加」を別々に計測すること(最重要方針7)、
// 部屋ごと項目別の一致判定(buildRoomComparisons)、午前午後/キャンセル/空欄に限定した
// 一致率の算出が正しいことを確認する。

import { computePhantomRooms, buildRoomComparisons, computeProviderAccuracySummary } from '../../../lib/ocr-compare/compareToGroundTruth';
import type { GroundTruthEntry, LbNormalizedEntry } from '../../../lib/ocr-compare/types';

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error('FAIL: ' + msg);
  console.log('OK: ' + msg);
}

function gt(overrides: Partial<GroundTruthEntry>): GroundTruthEntry {
  return { room_number: '', symbol: '', time: '', time_end: '', note: '', name: '', date: '', ...overrides };
}
function entry(overrides: Partial<LbNormalizedEntry>): LbNormalizedEntry {
  return { room_number: '', symbol: '', time: '', time_end: '', note: '', name: '', dateRaw: '', ...overrides };
}

const groundTruth: GroundTruthEntry[] = [
  gt({ room_number: '101', symbol: 'A' }), // 正しく読める想定
  gt({ room_number: '102', symbol: 'P' }), // 誤認識される想定(OCRはA)
  gt({ room_number: '103', symbol: 'キャンセル' }), // 欠落する想定(OCR結果に存在しない)
  gt({ room_number: '104', symbol: '', time: '', time_end: '' }), // 空欄(希望なし)の想定
];

const ocrEntries: LbNormalizedEntry[] = [
  entry({ room_number: '101', symbol: 'A' }), // 正解と一致
  entry({ room_number: '102', symbol: 'A' }), // 正解はP、誤認識
  // 103は欠落(OCR結果に無い)
  entry({ room_number: '104', symbol: '' }), // 空欄一致
  entry({ room_number: '999', symbol: 'A' }), // 正解データに存在しない部屋(phantom)
];

// ---- 存在しない部屋の追加(phantom)の検出 ----
{
  const phantoms = computePhantomRooms(ocrEntries, groundTruth);
  assert(phantoms.length === 1 && phantoms[0] === '999', '正解データに無い部屋番号999がphantomとして検出される');
}

// ---- 部屋ごとの横並び比較(buildRoomComparisons) ----
{
  const comparisons = buildRoomComparisons(ocrEntries, groundTruth);
  const byRoom = new Map(comparisons.map((c) => [c.room_number, c]));

  assert(byRoom.get('101')?.fieldMatches.symbol === true, '部屋101はsymbolが一致(○)と判定される');
  assert(byRoom.get('102')?.fieldMatches.symbol === false, '部屋102はsymbolが不一致(×)と判定される(正解P、OCR結果A)');
  assert(byRoom.get('103')?.isMissingRoom === true, '部屋103は欠落(missing)と判定される');
  assert(byRoom.get('999')?.isPhantomRoom === true, '部屋999は存在しない部屋の追加(phantom)と判定される');
  assert(byRoom.get('104')?.fieldMatches.symbol === true, '部屋104(空欄同士)はsymbolが一致と判定される');
}

// ---- プロバイダ別の集計(computeProviderAccuracySummary) ----
{
  const summary = computeProviderAccuracySummary('anthropic', ocrEntries, groundTruth, 1234);
  assert(summary.missingRoomCount === 1, '欠落件数は1件(部屋103)');
  assert(summary.phantomRoomCount === 1, '存在しない部屋の追加件数は1件(部屋999)');
  assert(summary.totalGroundTruthRooms === 4, '正解データ件数は4件');
  // 部屋番号認識率 = (4 - 1) / 4 = 0.75
  assert(Math.abs(summary.roomNumberRecognitionRate - 0.75) < 1e-9, `部屋番号認識率は75%になる(実測: ${summary.roomNumberRecognitionRate})`);

  // 午前/午後(A|P)対象: 101(A→A 一致), 102(P→A 不一致) → 1/2 = 50%
  assert(summary.ampmAccuracy !== null && Math.abs(summary.ampmAccuracy - 0.5) < 1e-9, `午前/午後一致率は50%になる(実測: ${summary.ampmAccuracy})`);

  // キャンセル対象: 103のみ(欠落のため不一致) → 0/1 = 0%
  assert(summary.cancelAccuracy !== null && Math.abs(summary.cancelAccuracy - 0) < 1e-9, `キャンセル一致率は0%になる(欠落のため。実測: ${summary.cancelAccuracy})`);

  // 空欄対象: 104のみ(一致) → 1/1 = 100%
  assert(summary.blankAccuracy !== null && Math.abs(summary.blankAccuracy - 1) < 1e-9, `空欄判定一致率は100%になる(実測: ${summary.blankAccuracy})`);

  assert(summary.processingTimeMs === 1234, '処理時間がそのまま summary に反映される');
}

// ---- 正解データが空の場合、0除算にならない(null等で安全に扱われる) ----
{
  const summary = computeProviderAccuracySummary('gemini', [], [], null);
  assert(summary.totalGroundTruthRooms === 0, '正解データ0件でもエラーにならない');
  assert(summary.ampmAccuracy === null, '対象0件の場合、一致率はnull(N/A)になる');
}

// [2026-08-06追加 評価ロジックP0改善] 時刻・日付の意味比較(表記差を無視した一致率)を検証する。
// 既存の上記アサーション(fieldMatches.symbol等)には一切手を加えていない。
{
  const gtRows: GroundTruthEntry[] = [
    gt({ room_number: '201', time: '9:00', date: '2024-08-25' }), // 表記差のみ(ゼロ埋め・日付フォーマット)
    gt({ room_number: '202', time: '9:30', date: '2024-08-25' }), // 本当の不一致
    gt({ room_number: '203', time: '10:00', date: '2024-08-25' }), // dateがOCR側で空欄(欠落)
  ];
  const ocrRows: LbNormalizedEntry[] = [
    entry({ room_number: '201', time: '09:00', dateRaw: '2024年8月25日(日)' }),
    entry({ room_number: '202', time: '9:00', dateRaw: '2024-08-25' }),
    entry({ room_number: '203', time: '10:00', dateRaw: '' }),
  ];

  const comparisons = buildRoomComparisons(ocrRows, gtRows);
  const byRoom = new Map(comparisons.map((c) => [c.room_number, c]));

  assert(byRoom.get('201')?.fieldMatches.time === false, '部屋201: 既存fieldMatches.time(完全文字列一致)は不一致のまま変更されない(9:00 !== 09:00)');
  assert(byRoom.get('201')?.timeDetail?.comparisonStatus === 'format_only_difference', '部屋201: timeDetailでは「表記差のみ」と判定される');
  assert(byRoom.get('201')?.dateDetail?.comparisonStatus === 'format_only_difference', '部屋201: dateDetailでは「表記差のみ」と判定される');
  assert(byRoom.get('202')?.timeDetail?.comparisonStatus === 'actual_mismatch', '部屋202: 9:30 vs 9:00 は「本当の不一致」と判定される(丸めない)');
  assert(byRoom.get('203')?.dateDetail?.comparisonStatus === 'missing', '部屋203: OCR側の日付空欄は「欠落」と判定される');

  const summary = computeProviderAccuracySummary('anthropic', ocrRows, gtRows, null);
  // 既存fieldAccuracy.time(完全文字列一致): 201×, 202×, 203○(10:00一致) → 1/3
  assert(summary.timeRawAccuracy === summary.fieldAccuracy.time, 'timeRawAccuracyは既存fieldAccuracy.timeと同じ値のエイリアスである');
  assert(summary.timeRawAccuracy !== null && Math.abs(summary.timeRawAccuracy - 1 / 3) < 1e-9, `既存fieldAccuracy.time(完全文字列一致)は変更されず1/3のまま(実測: ${summary.timeRawAccuracy})`);
  // 意味一致: 201○(表記差のみ), 202×(本当の不一致), 203○ → 2/3
  assert(summary.timeSemanticAccuracy !== null && Math.abs(summary.timeSemanticAccuracy - 2 / 3) < 1e-9, `timeSemanticAccuracyは2/3になる(実測: ${summary.timeSemanticAccuracy})`);

  assert(summary.dateRawAccuracy === summary.fieldAccuracy.date, 'dateRawAccuracyは既存fieldAccuracy.dateと同じ値のエイリアスである');
  // 意味一致: 201○(表記差のみ), 202○(2024-08-25同士), 203×(欠落) → 2/3
  assert(summary.dateSemanticAccuracy !== null && Math.abs(summary.dateSemanticAccuracy - 2 / 3) < 1e-9, `dateSemanticAccuracyは2/3になる(実測: ${summary.dateSemanticAccuracy})`);
  assert(summary.dateMissingCount === 1, '部屋203のdate欠落が1件としてdateMissingCountに計上される');
  assert(summary.dateUnparseableCount === 0, '比較不能な日付は今回のデータには無いため0件になる');
}

// [2026-08-06追加 評価ロジックP0改善] Anthropicのように全部屋で日付が空欄の場合、
// 意味一致率が誤って100%にならないことを確認する(最重要な回帰防止テスト)。
{
  const gtRows: GroundTruthEntry[] = [
    gt({ room_number: '301', date: '2024-08-25' }),
    gt({ room_number: '302', date: '2024-08-25' }),
  ];
  const ocrRows: LbNormalizedEntry[] = [
    entry({ room_number: '301', dateRaw: '' }),
    entry({ room_number: '302', dateRaw: '' }),
  ];
  const summary = computeProviderAccuracySummary('anthropic', ocrRows, gtRows, null);
  assert(summary.dateSemanticAccuracy === 0, '全件空欄の場合、dateSemanticAccuracyは0%になる(100%と誤カウントしない)');
  assert(summary.dateMissingCount === 2, '全件空欄の場合、dateMissingCountは2件になる');
}

// [2026-08-07追加 評価器P0改善 Phase1-C] comparisonStatus内訳の集計件数
// (timeFormatOnlyDifferenceCount/timeActualMismatchCount/timeMissingCount/timeUnparseableCount、
// dateFormatOnlyDifferenceCount/dateActualMismatchCount)を検証する。
{
  const gtRows: GroundTruthEntry[] = [
    gt({ room_number: '401', time: '9:00', date: '2024-08-25' }), // time: 表記差のみ / date: 表記差のみ
    gt({ room_number: '402', time: '9:30', date: '2024-08-25' }), // time: 本当の不一致 / date: 本当の不一致
    gt({ room_number: '403', time: '10:00', date: '2024-08-25' }), // time: 欠落(OCR空欄) / date: 欠落(OCR空欄)
    gt({ room_number: '404', time: 'あさ', date: '2024-08-25' }), // time: 比較不能 / date: 一致
  ];
  const ocrRows: LbNormalizedEntry[] = [
    entry({ room_number: '401', time: '09:00', dateRaw: '2024年8月25日' }),
    entry({ room_number: '402', time: '9:00', dateRaw: '2024-08-26' }),
    entry({ room_number: '403', time: '', dateRaw: '' }),
    entry({ room_number: '404', time: '10:00', dateRaw: '2024-08-25' }),
  ];

  const summary = computeProviderAccuracySummary('gemini', ocrRows, gtRows, null);

  assert(summary.timeFormatOnlyDifferenceCount === 1, 'time表記差のみは1件(部屋401)');
  assert(summary.timeActualMismatchCount === 1, 'time本当の不一致は1件(部屋402)');
  assert(summary.timeMissingCount === 1, 'time欠落は1件(部屋403)');
  assert(summary.timeUnparseableCount === 1, 'time比較不能は1件(部屋404、GT側が「あさ」でパース不能)');

  assert(summary.dateFormatOnlyDifferenceCount === 1, 'date表記差のみは1件(部屋401)');
  assert(summary.dateActualMismatchCount === 1, 'date本当の不一致は1件(部屋402)');
  assert(summary.dateMissingCount === 1, 'date欠落は1件(部屋403)');
  assert(summary.dateUnparseableCount === 0, 'date比較不能は0件(部屋404のdateは一致するためunparseableではない)');
}

console.log('ALL PASS: ocr-compare/compareToGroundTruth.test.ts');
