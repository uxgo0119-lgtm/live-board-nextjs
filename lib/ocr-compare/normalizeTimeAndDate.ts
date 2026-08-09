// lib/ocr-compare/normalizeTimeAndDate.ts
//
// [2026-08-06新設 評価ロジックP0改善] 「FireFlow OCR評価ロジック P0改善 実装依頼」への対応。
// 時刻・日付を「表記の違いだけの不一致」と「本当の値の不一致」に分けて判定するための、
// 比較専用の正規化ロジック。
//
// 【このファイルの位置づけ】比較専用(lib/ocr-compare/)のロジックであり、本番のOCR経路
// (lib/ai/providers/*/ocr.ts、lib/handlers/*)・OCRプロンプト・LB・RF・Parserのいずれも
// 参照・変更しない。OCR結果やGround Truthの値そのものを書き換える処理は一切行わない
// (このファイルが返すのは「比較した結果」の判定情報のみで、呼び出し元が保持する元の
// 文字列(groundTruthRaw/providerRaw)は常に無加工のまま呼び出し元に残る)。
//
// 【時刻の正規化ルール】
// - "9:00" "09:00" "09:00:00" は同一時刻とみなす(秒が"00"の場合のみ、時分比較で同値とみなす)。
// - 秒が"00"以外の場合は区別する(例: "09:00:15"は"09:00"と同一視しない。丸めない)。
// - "9:30"を"9:00"に丸める、15分/30分程度の誤差を許容する、午前/午後を推測する、
//   不正な時刻を自動修正する、空欄を別の値で補完する、といった処理は一切行わない。
//
// 【日付の正規化ルール】
// - 対応する表記: "YYYY-MM-DD" "YYYY/M/D" "YYYY年M月D日" "YYYY年M月D日(曜日)"
//   "YYYY年M月D日（曜日）"(全角括弧)。曜日表記は意味比較では無視する(捨てるだけで、
//   曜日と日付の整合性チェックは行わない)。
// - 年が無い日付の補完、西暦/和暦の変換、不正日付(存在しない月日等)の自動修正、
//   空欄への帳票共通日付の補完は一切行わない。
//
// 【パースできない値の扱い】
// どちらか一方でもパースできない場合は、raw一致の判定結果はそのまま保持しつつ、
// 意味一致は「比較不能(null)」として扱う。「比較不能」を「一致」として数えることは
// 絶対に行わない(意味一致率の分母には含め、安易に高い数値が出ないようにする)。

export type ComparisonStatus = 'matched' | 'format_only_difference' | 'actual_mismatch' | 'missing' | 'unparseable';

export type FieldComparisonDetail = {
  groundTruthRaw: string;
  providerRaw: string;
  rawMatch: boolean;
  // null = どちらか(または両方)がパースできず、意味的な比較自体ができなかったことを示す。
  // false(比較不能ではなく「比較した結果、不一致だった」)と明確に区別する。
  semanticMatch: boolean | null;
  normalizedGroundTruth: string | null;
  normalizedProvider: string | null;
  comparisonStatus: ComparisonStatus;
};

// ---- 時刻 ----

type NormalizedTime = { hour: number; minute: number; second: number; canonical: string };

const TIME_RE = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export function normalizeTimeString(trimmedRaw: string): NormalizedTime | null {
  if (trimmedRaw === '') return null;
  const m = trimmedRaw.match(TIME_RE);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  const second = m[3] !== undefined ? Number(m[3]) : 0;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) return null;
  const canonical = second === 0 ? `${pad2(hour)}:${pad2(minute)}` : `${pad2(hour)}:${pad2(minute)}:${pad2(second)}`;
  return { hour, minute, second, canonical };
}

function timeEqual(a: NormalizedTime, b: NormalizedTime): boolean {
  return a.hour === b.hour && a.minute === b.minute && a.second === b.second;
}

// ---- 日付 ----

type NormalizedDate = { year: number; month: number; day: number; canonical: string };

// 曜日付き表記("(日)"/"（日）")は末尾にあれば無視する。曜日自体が日付と整合しているかの
// 検証は行わない(曜日を無視して年月日だけを見る、という意味比較の方針のため)。
const DATE_PATTERNS: RegExp[] = [
  /^(\d{4})-(\d{1,2})-(\d{1,2})$/, // 2024-08-25
  /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/, // 2024/8/25
  /^(\d{4})年(\d{1,2})月(\d{1,2})日(?:[（(].*?[)）])?$/, // 2024年8月25日 / 2024年8月25日(日) / （日）
];

export function normalizeDateString(trimmedRaw: string): NormalizedDate | null {
  if (trimmedRaw === '') return null;
  for (const re of DATE_PATTERNS) {
    const m = trimmedRaw.match(re);
    if (!m) continue;
    const year = Number(m[1]);
    const month = Number(m[2]);
    const day = Number(m[3]);
    // 基本的な範囲チェックのみ(月1-12・日1-31)。うるう年等のカレンダー厳密検証や、
    // 不正日付の自動修正は行わない(範囲外は単純にunparseable扱いにする)。
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return { year, month, day, canonical: `${year}-${pad2(month)}-${pad2(day)}` };
  }
  return null;
}

function dateEqual(a: NormalizedDate, b: NormalizedDate): boolean {
  return a.year === b.year && a.month === b.month && a.day === b.day;
}

// ---- 共通の比較ロジック ----

function compareGeneric<T>(
  groundTruthRaw: string,
  providerRaw: string,
  normalize: (trimmed: string) => T | null,
  equal: (a: T, b: T) => boolean,
  canonicalOf: (t: T) => string
): FieldComparisonDetail {
  const gtTrim = (groundTruthRaw ?? '').trim();
  const pvTrim = (providerRaw ?? '').trim();
  const rawMatch = gtTrim === pvTrim;

  if (gtTrim === '' && pvTrim === '') {
    return {
      groundTruthRaw,
      providerRaw,
      rawMatch: true,
      semanticMatch: true,
      normalizedGroundTruth: null,
      normalizedProvider: null,
      comparisonStatus: 'matched',
    };
  }

  const gtNorm = gtTrim === '' ? null : normalize(gtTrim);
  const pvNorm = pvTrim === '' ? null : normalize(pvTrim);
  const normalizedGroundTruth = gtNorm ? canonicalOf(gtNorm) : null;
  const normalizedProvider = pvNorm ? canonicalOf(pvNorm) : null;

  // Ground Truthには値があるのにOCR側が空欄 = 「意味一致率を誤って100%にしない」ための
  // 最重要ケース。missingとして明示的に不一致(false)扱いにする(除外はしない)。
  if (gtTrim !== '' && pvTrim === '') {
    return { groundTruthRaw, providerRaw, rawMatch: false, semanticMatch: false, normalizedGroundTruth, normalizedProvider: null, comparisonStatus: 'missing' };
  }
  // 逆に、Ground Truthには無いのにOCR側に値がある(存在しないはずの値を生成した)ケース。
  if (gtTrim === '' && pvTrim !== '') {
    return { groundTruthRaw, providerRaw, rawMatch: false, semanticMatch: false, normalizedGroundTruth: null, normalizedProvider, comparisonStatus: 'actual_mismatch' };
  }

  if (rawMatch) {
    return { groundTruthRaw, providerRaw, rawMatch: true, semanticMatch: true, normalizedGroundTruth, normalizedProvider, comparisonStatus: 'matched' };
  }
  if (!gtNorm || !pvNorm) {
    return { groundTruthRaw, providerRaw, rawMatch: false, semanticMatch: null, normalizedGroundTruth, normalizedProvider, comparisonStatus: 'unparseable' };
  }
  const semanticMatch = equal(gtNorm, pvNorm);
  return {
    groundTruthRaw,
    providerRaw,
    rawMatch: false,
    semanticMatch,
    normalizedGroundTruth,
    normalizedProvider,
    comparisonStatus: semanticMatch ? 'format_only_difference' : 'actual_mismatch',
  };
}

export function compareTimeValues(groundTruthRaw: string, providerRaw: string): FieldComparisonDetail {
  return compareGeneric(groundTruthRaw, providerRaw, normalizeTimeString, timeEqual, (t) => t.canonical);
}

export function compareDateValues(groundTruthRaw: string, providerRaw: string): FieldComparisonDetail {
  return compareGeneric(groundTruthRaw, providerRaw, normalizeDateString, dateEqual, (d) => d.canonical);
}
