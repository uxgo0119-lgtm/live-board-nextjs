// [2026-08-06新設 評価ロジックP0改善] lib/ocr-compare/normalizeTimeAndDate.ts の単体テスト。
//
// 目的: 「表記の違いだけの不一致」(9:00 vs 09:00 等)と「本当の値の不一致」(9:00 vs 9:30 等)を
// 正しく区別できること、丸め・推測・自動補完を一切行っていないこと、パース不能な値を
// 「一致」として誤ってカウントしないことを確認する。

import { normalizeTimeString, normalizeDateString, compareTimeValues, compareDateValues } from '../../../lib/ocr-compare/normalizeTimeAndDate';

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error('FAIL: ' + msg);
  console.log('OK: ' + msg);
}

// ---- 時刻: ゼロ埋めの表記差は同一時刻とみなす ----
{
  const r1 = compareTimeValues('9:00', '09:00');
  assert(r1.rawMatch === false, '"9:00" と "09:00" はraw一致しない(文字列としては異なる)');
  assert(r1.semanticMatch === true, '"9:00" と "09:00" は意味一致する(ゼロ埋めの表記差のみ)');
  assert(r1.comparisonStatus === 'format_only_difference', '判定は「表記差のみ」になる');
  assert(r1.groundTruthRaw === '9:00' && r1.providerRaw === '09:00', '元の値(groundTruthRaw/providerRaw)は無加工で保持される');

  const r2 = compareTimeValues('09:00', '09:00:00');
  assert(r2.semanticMatch === true, '"09:00" と "09:00:00" は意味一致する(秒=00は同一視)');
  assert(r2.comparisonStatus === 'format_only_difference', '"09:00" と "09:00:00" の判定は「表記差のみ」になる');

  const r3 = compareTimeValues('9:00', '9:00');
  assert(r3.rawMatch === true && r3.semanticMatch === true && r3.comparisonStatus === 'matched', '完全に同じ文字列は matched になる');
}

// ---- 時刻: 本当に異なる時刻は丸めずに不一致のままにする ----
{
  const r = compareTimeValues('9:30', '9:00');
  assert(r.semanticMatch === false, '"9:30" と "9:00" は意味も不一致(15分/30分の差を許容しない)');
  assert(r.comparisonStatus === 'actual_mismatch', '"9:30" vs "9:00" の判定は「本当の不一致」になる(丸めない)');

  const r2 = compareTimeValues('09:00:15', '09:00:00');
  assert(r2.semanticMatch === false, '秒が00以外の差は区別する("09:00:15" は "09:00" と同一視しない)');
}

// ---- 時刻: 欠落(GTに値がありOCRが空欄)は意味一致率を誤って100%にしない ----
{
  const r = compareTimeValues('9:00', '');
  assert(r.semanticMatch === false, 'GTに値がありOCRが空欄の場合、semanticMatchはfalse(比較不能=nullではない)');
  assert(r.comparisonStatus === 'missing', '判定は「欠落」になる');
  assert(r.normalizedProvider === null, '空欄側のnormalizedProviderはnull');
}

// ---- 時刻: phantom(GTが空欄でOCR側に値がある)は不一致として扱う ----
{
  const r = compareTimeValues('', '9:00');
  assert(r.semanticMatch === false, 'GTが空欄でOCR側に値がある場合、semanticMatchはfalse');
  assert(r.comparisonStatus === 'actual_mismatch', '判定は「本当の不一致」になる(存在しないはずの値)');
}

// ---- 時刻: 両方空欄は一致とみなす ----
{
  const r = compareTimeValues('', '');
  assert(r.rawMatch === true && r.semanticMatch === true && r.comparisonStatus === 'matched', '両方空欄は matched になる');
}

// ---- 時刻: パース不能な値は「比較不能」(null)であり、一致にも不一致にもしない ----
{
  const r = compareTimeValues('午前中', '9:00');
  assert(r.semanticMatch === null, 'パース不能な値は semanticMatch が null (比較不能)になる');
  assert(r.comparisonStatus === 'unparseable', '判定は「比較不能」になる');
}

// ---- 時刻: 不正な範囲の値(25:00等)は自動修正せずパース不能扱いにする ----
{
  const n = normalizeTimeString('25:00');
  assert(n === null, '"25:00" のような不正な時刻は自動修正せずnull(パース不能)を返す');
}

// ---- 日付: 複数フォーマットが同一日として意味一致する ----
{
  const r1 = compareDateValues('2024-08-25', '2024年8月25日(日)');
  assert(r1.rawMatch === false, '"2024-08-25" と "2024年8月25日(日)" はraw一致しない');
  assert(r1.semanticMatch === true, '"2024-08-25" と "2024年8月25日(日)" は意味一致する(表記差のみ、曜日は無視)');
  assert(r1.comparisonStatus === 'format_only_difference', '判定は「表記差のみ」になる');

  const r2 = compareDateValues('2024-08-25', '2024年8月25日（日）');
  assert(r2.semanticMatch === true, '全角括弧の曜日表記でも意味一致する');

  const r3 = compareDateValues('2024-08-25', '2024/8/25');
  assert(r3.semanticMatch === true, 'スラッシュ区切り(月日の0埋めなし)でも意味一致する');

  const r4 = compareDateValues('2024-08-25', '2024年8月25日');
  assert(r4.semanticMatch === true, '曜日表記なしの漢字表記でも意味一致する');

  // [2026-08-07追加 Phase1-D 日付テスト2] GT側がスラッシュ表記、OCR側が漢字表記の組み合わせ。
  const r5 = compareDateValues('2024/8/25', '2024年8月25日');
  assert(r5.rawMatch === false, '"2024/8/25" と "2024年8月25日" はraw一致しない');
  assert(r5.semanticMatch === true, '"2024/8/25" と "2024年8月25日" は意味一致する');
  assert(r5.comparisonStatus === 'format_only_difference', '判定は「表記差のみ」になる');
}

// [2026-08-07追加 Phase1-D 日付テスト4] 両方空欄は一致とみなす(時刻と同じ仕様)。
{
  const r = compareDateValues('', '');
  assert(r.rawMatch === true && r.semanticMatch === true && r.comparisonStatus === 'matched', '日付も両方空欄は matched になる');
}

// [2026-08-07追加 Phase1-D 日付テスト5] 片方だけ空欄(GTが空欄でOCR側に値がある = phantom)。
{
  const r = compareDateValues('', '2024-08-25');
  assert(r.semanticMatch === false, 'GTが空欄でOCR側に値がある場合、日付もsemanticMatchはfalse');
  assert(r.comparisonStatus === 'actual_mismatch', '判定は「本当の不一致」になる(存在しないはずの値)');
}

// ---- 日付: 本当に異なる日付は不一致のままにする ----
{
  const r = compareDateValues('2024-08-25', '2024-08-26');
  assert(r.semanticMatch === false, '本当に異なる日付は意味も不一致になる');
  assert(r.comparisonStatus === 'actual_mismatch', '判定は「本当の不一致」になる');
}

// ---- 日付: 欠落(GTに値がありOCRが空欄)は意味一致率を誤って100%にしない ----
// [最重要] Anthropicのように全部屋で日付が空欄になったケースの根拠テスト。
{
  const r = compareDateValues('2024-08-25', '');
  assert(r.semanticMatch === false, 'GTに値がありOCRが空欄の場合、semanticMatchはfalse(100%に誤カウントされない)');
  assert(r.comparisonStatus === 'missing', '判定は「欠落」になる');
}

// ---- 日付: パース不能・不正日付は自動修正しない ----
{
  const n1 = normalizeDateString('2024年13月40日'); // 存在しない月日
  assert(n1 === null, '存在しない月日("13月40日")は自動修正せずnull(パース不能)を返す');

  const r = compareDateValues('2024-08-25', '令和6年8月25日');
  assert(r.semanticMatch === null, '対応フォーマット外(和暦等)の表記はパース不能=比較不能(null)になる(変換しない)');
  assert(r.comparisonStatus === 'unparseable', '判定は「比較不能」になる');
}

// ---- 実データ回帰: 2026-08-06 実API比較レポート(ibaraki-hozumi)の実測値を用いた確認 ----
{
  // 部屋101: GT "9:00" vs Anthropic "09:00" (実測)
  const r1 = compareTimeValues('9:00', '09:00');
  assert(r1.comparisonStatus === 'format_only_difference', '実データ回帰(部屋101 time): 表記差のみと判定される');

  // GT "2024-08-25" vs Gemini "2024年8月25日(日)" (実測、全35部屋共通)
  const r2 = compareDateValues('2024-08-25', '2024年8月25日(日)');
  assert(r2.comparisonStatus === 'format_only_difference', '実データ回帰(Gemini date): 表記差のみと判定される');

  // GT "2024-08-25" vs Anthropic "" (実測、今回の実行では全35部屋で空欄)
  const r3 = compareDateValues('2024-08-25', '');
  assert(r3.comparisonStatus === 'missing' && r3.semanticMatch === false, '実データ回帰(Anthropic date全件空欄): missingとして不一致に数えられ、100%にはならない');
}

console.log('ALL PASS: ocr-compare/normalizeTimeAndDate.test.ts');
