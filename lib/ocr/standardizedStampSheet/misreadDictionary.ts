// lib/ocr/standardizedStampSheet/misreadDictionary.ts
//
// [2026-08-11新設 新捺印表OCR P0実装]
// 正規語辞書・OCR誤読辞書を用いて、備考等の自由記述テキストに対する正規化候補を生成する。

import canonicalDictionaryJson from './dictionaries/canonicalTermDictionary.v1.json';
import misreadDictionaryJson from './dictionaries/ocrMisreadDictionary.v1.json';
import type { MisreadMatch } from './types';

type CanonicalEntry = { canonical: string; normalized_code: string; aliases: string[] };
type MisreadEntry = {
  canonical: string;
  normalized_code: string;
  risk_level: 'normal' | 'high';
  ocr_confusions: string[];
};

const CANONICAL_ENTRIES = canonicalDictionaryJson.entries as CanonicalEntry[];
const MISREAD_ENTRIES = misreadDictionaryJson.entries as MisreadEntry[];

const EXACT_CANONICAL_MAP = new Map<string, string>();
const EXACT_ALIAS_SET = new Set<string>();
for (const entry of CANONICAL_ENTRIES) {
  EXACT_CANONICAL_MAP.set(entry.canonical, entry.normalized_code);
  for (const alias of entry.aliases) {
    EXACT_CANONICAL_MAP.set(alias, entry.normalized_code);
    EXACT_ALIAS_SET.add(alias);
  }
}

const KNOWN_MISREAD_MAP = new Map<string, { normalizedCode: string; riskLevel: 'normal' | 'high' }>();
for (const entry of MISREAD_ENTRIES) {
  for (const confusion of entry.ocr_confusions) {
    if (!KNOWN_MISREAD_MAP.has(confusion)) {
      KNOWN_MISREAD_MAP.set(confusion, { normalizedCode: entry.normalized_code, riskLevel: entry.risk_level });
    }
  }
}

function riskLevelOfNormalizedCode(normalizedCode: string): 'normal' | 'high' | null {
  const misreadEntry = MISREAD_ENTRIES.find((e) => e.normalized_code === normalizedCode);
  if (misreadEntry) return misreadEntry.risk_level;
  return null;
}

export function matchAgainstDictionaries(rawText: string): MisreadMatch {
  const text = rawText.trim();
  if (!text) {
    return { canonical: null, normalizedCode: null, state: 'needs_review', matchedVia: null, riskLevel: null };
  }

  if (EXACT_CANONICAL_MAP.has(text)) {
    const normalizedCode = EXACT_CANONICAL_MAP.get(text)!;
    const riskLevel = riskLevelOfNormalizedCode(normalizedCode);
    const matchedVia = EXACT_ALIAS_SET.has(text) ? 'exact_alias' : 'exact_canonical';
    return { canonical: findCanonicalFor(normalizedCode), normalizedCode, state: 'auto_correct', matchedVia, riskLevel };
  }

  if (KNOWN_MISREAD_MAP.has(text)) {
    const { normalizedCode, riskLevel } = KNOWN_MISREAD_MAP.get(text)!;
    return {
      canonical: findCanonicalFor(normalizedCode),
      normalizedCode,
      state: riskLevel === 'high' ? 'needs_review' : 'candidate',
      matchedVia: 'known_misread',
      riskLevel,
    };
  }

  return { canonical: null, normalizedCode: null, state: 'needs_review', matchedVia: null, riskLevel: null };
}

function findCanonicalFor(normalizedCode: string): string {
  const entry = CANONICAL_ENTRIES.find((e) => e.normalized_code === normalizedCode);
  return entry ? entry.canonical : normalizedCode;
}

export const _internal = {
  CANONICAL_ENTRIES,
  MISREAD_ENTRIES,
};
