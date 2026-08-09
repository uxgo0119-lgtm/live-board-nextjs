// lib/ocr-compare/loadDotEnvLocal.ts
//
// [2026-08-05新設] `npm run ocr:compare` はtsxで直接Node上で動く単発CLIであり、
// `next dev`/`next build`と違って.env.localを自動では読み込まない。このプロジェクトには
// dotenvパッケージの依存が無い(package.json参照)ため、新規に依存を追加せず、
// ".env.local(存在すれば)の KEY=VALUE 行を読み、まだ設定されていないprocess.envのキーにのみ
// 設定する" という最小限のローダーをここに実装する。
//
// 【重要】既に環境変数としてexportされている値は上書きしない(シェルでの
// `ANTHROPIC_API_KEY=xxx npm run ocr:compare -- ...` のような一時上書きを優先するため)。
// このファイルは lib/ocr-compare/ 配下の比較CLI専用であり、本番のRoute Handler・
// lib/config/env.ts 等からは一切importされない(本番の環境変数解決ロジックには影響しない)。

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export function loadDotEnvLocalIfPresent(cwd: string = process.cwd()): { loadedPath: string | null; loadedKeys: string[] } {
  const filePath = path.join(cwd, '.env.local');
  if (!existsSync(filePath)) {
    return { loadedPath: null, loadedKeys: [] };
  }
  const raw = readFileSync(filePath, 'utf8');
  const loadedKeys: string[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    // 値がダブルクォート/シングルクォートで囲まれていれば剥がす(.envファイルの一般的な慣習)。
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!key) continue;
    if (process.env[key] === undefined) {
      process.env[key] = value;
      loadedKeys.push(key);
    }
  }
  return { loadedPath: filePath, loadedKeys };
}
