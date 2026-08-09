// lib/ocr-compare/groundTruth.ts
//
// [2026-08-05新設] 正解データ(ground truth)JSONファイルの読み込み。
// lib/ocr-benchmark/runBenchmark.ts の loadGroundTruth() と同じ方針・同じ形式
// (StampSheetEntry[]、lib/ocr-benchmark/types.ts)を採用している(既存ツールとの
// 相互運用・使い回しのため)。
//
// 【最重要方針5の遵守】このファイルは「人間が原紙を確認して作成したデータ」を人間が
// 手作業で用意する前提の入力ファイルである。AIの出力を正解データとして自動生成する
// 機能はこのモジュールには存在しない。

import { existsSync, readFileSync } from 'node:fs';
import type { GroundTruthEntry } from './types';

export class GroundTruthLoadError extends Error {}

export function loadGroundTruth(filePath: string | undefined): GroundTruthEntry[] | null {
  if (!filePath) return null;
  if (!existsSync(filePath)) {
    throw new GroundTruthLoadError(`正解データJSONが見つかりません: ${filePath}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (err) {
    throw new GroundTruthLoadError(`正解データJSONの解析に失敗しました: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!Array.isArray(raw)) {
    throw new GroundTruthLoadError('正解データJSONは配列である必要があります(lib/ocr-benchmark/types.tsのStampSheetEntry[]形式)。');
  }
  for (const item of raw) {
    if (!item || typeof item !== 'object' || typeof (item as { room_number?: unknown }).room_number !== 'string') {
      throw new GroundTruthLoadError('正解データJSONの各要素には文字列型の room_number が必要です。');
    }
  }
  return raw as GroundTruthEntry[];
}
