#!/usr/bin/env npx tsx
// lib/ocr-compare/runCompare.ts
//
// [2026-08-05新設] 捺印表(点検希望時間連絡票)OCR Anthropic／Gemini比較検証CLI。
//
// 使い方:
//   npm run ocr:compare -- <single|bulk> <画像またはPDFのパス> [正解データJSONパス] [--include-names]
//
// 例:
//   npm run ocr:compare -- single ./samples/cosmo-ibaraki-hozumi-101.jpg ./samples/cosmo-ibaraki-hozumi.ground-truth.json
//
// 【重要】このスクリプトは本番のOCR経路(app/api/scan-time-request/route.ts等)を一切
// 呼び出さない。lib/ai/providers/{anthropic,gemini}/client.ts の低レベル関数を直接
// 呼び出し、本番のAdapter(lib/ai/providers/*/ocr.ts)・本番のTASK_ROUTING解決は経由しない。
// lb_tool(LB)・report_flow_tool.html(RF)・Parser・既存のOCR経路は一切変更していない。
//
// 【実測についての注意】ANTHROPIC_API_KEY・GEMINI_API_KEY が実際に設定され、実際に
// ネットワーク到達できた場合のみ、その結果は実測値である。キー未設定・通信失敗の場合は
// 「未検証」として明示され、その場合の集計値を実測結果として報告してはならない
// (最重要方針10)。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadDotEnvLocalIfPresent } from './loadDotEnvLocal';
import { loadGroundTruth, GroundTruthLoadError } from './groundTruth';
import { runProviderRaw, parseProviderRaw } from './runProviders';
import { normalizeToLbEntries } from './normalizeToLbFormat';
import { computeProviderAccuracySummary, buildRoomComparisons } from './compareToGroundTruth';
import { buildHtmlReport } from './htmlReport';
import { redactRoomComparisonForReport } from './redact';
import type {
  OcrCompareMode,
  OcrCompareProviderKey,
  OcrCompareRunReport,
  ProviderRunResult,
} from './types';

// [2026-08-05追加 P0] ログ表示用のモデル名ラベル。lib/ai/providers/{anthropic,gemini}/client.ts
// 内のANTHROPIC_MODEL/GEMINI_MODEL定数(非export)と同じ値を、表示専用の目的でここに
// 複製している(あちらのファイルはAnthropic/Gemini専用処理のため今回の変更対象外とした)。
// 実際に呼び出すモデルはあちら側の定数がそのまま使われる(ここは表示ラベルのみで、
// 実際の通信内容には一切影響しない)。モデル名を変更する場合は両方を更新すること。
const MODEL_LABEL: Record<OcrCompareProviderKey, string> = {
  anthropic: 'claude-sonnet-4-6',
  gemini: 'gemini-2.5-flash',
};

function detectMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.pdf') return 'application/pdf';
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  return 'image/jpeg';
}

function pct(value: number | null): string {
  return value === null ? 'N/A' : `${(value * 100).toFixed(1)}%`;
}

async function runOneProvider(
  provider: OcrCompareProviderKey,
  mode: OcrCompareMode,
  mediaType: string,
  data: string
): Promise<ProviderRunResult> {
  const stage1Raw = await runProviderRaw(provider, mode, mediaType, data);
  const stage2Parsed = parseProviderRaw(stage1Raw, mode);
  const stage3Lb = stage2Parsed.ok
    ? (() => {
        const normalized = normalizeToLbEntries(stage2Parsed.parsed, mode);
        return normalized.ok
          ? { ok: true, entries: normalized.entries, errorMessage: normalized.skipped.length > 0 ? `一部の項目をスキップしました: ${normalized.skipped.join(' / ')}` : null }
          : { ok: false, entries: null, errorMessage: normalized.error };
      })()
    : { ok: false, entries: null, errorMessage: '②JSON解析に失敗しているため、③LB正規化は実施していません: ' + (stage2Parsed.errorMessage || '') };

  return { provider, stage1Raw, stage2Parsed, stage3Lb };
}

function printConsoleSummary(report: OcrCompareRunReport): void {
  console.log('\n=== FireFlow 捺印表OCR比較(Anthropic vs Gemini) ===');
  console.log(`入力ファイル: ${report.inputFilePath} (${report.mediaType}, mode=${report.mode})`);
  if (report.groundTruthFilePath) {
    console.log(`正解データ: ${report.groundTruthFilePath} (${report.groundTruthRoomCount}件)`);
  } else {
    console.log('正解データ: 未指定(認識率の算出はスキップします)');
  }

  for (const r of report.providerResults) {
    console.log(`\n--- ${r.provider} (model: ${MODEL_LABEL[r.provider]}) ---`);
    if (!r.stage1Raw.attempted) {
      console.log(`【未検証】実APIを呼び出していません: ${r.stage1Raw.errorMessage}`);
      continue;
    }
    if (!r.stage1Raw.ok) {
      console.log(`実API呼び出しに失敗しました(実測): ${r.stage1Raw.errorMessage}`);
      continue;
    }
    console.log(`実API疎通確認(実測)。処理時間: ${r.stage1Raw.processingTimeMs}ms`);
    // [2026-08-05追加 P0] Provider・Model・抽出方式・JSON Parse成功可否・Schema Validation結果を
    // ログに残す(個人情報を含む生テキスト全文はログに出さない。既存どおり先頭500文字までの
    // プレビューのみをエラー時に出力する)。
    console.log(
      `②JSON解析: ${r.stage2Parsed.ok ? '成功' : '失敗'}` +
        (r.stage2Parsed.extractionMethod ? ` (抽出方式: ${r.stage2Parsed.extractionMethod})` : '')
    );
    if (r.stage2Parsed.schemaValidation) {
      console.log(
        `  Schema Validation: ${r.stage2Parsed.schemaValidation.ok ? 'OK' : 'NG(' + r.stage2Parsed.schemaValidation.reason + ')'}`
      );
    }
    if (!r.stage2Parsed.ok) {
      console.log(`②JSON解析に失敗しました: ${r.stage2Parsed.errorMessage}`);
      continue;
    }
    console.log(`③LB取込直前データ: ${r.stage3Lb.entries ? r.stage3Lb.entries.length + '件' : 'N/A'}`);
    if (r.stage3Lb.errorMessage) console.log(`  注記: ${r.stage3Lb.errorMessage}`);
  }

  if (report.accuracySummaries) {
    console.log('\n=== 正解データとの一致率 ===');
    for (const s of report.accuracySummaries) {
      console.log(`\n[${s.provider}]`);
      console.log(`  部屋番号認識率: ${pct(s.roomNumberRecognitionRate)} (欠落${s.missingRoomCount}件 / 存在しない部屋の追加${s.phantomRoomCount}件)`);
      console.log(`  午前/午後一致率: ${pct(s.ampmAccuracy)}  キャンセル一致率: ${pct(s.cancelAccuracy)}  空欄判定一致率: ${pct(s.blankAccuracy)}`);
      console.log(`  時間(time)一致率: ${pct(s.fieldAccuracy.time)}  時間(time_end)一致率: ${pct(s.fieldAccuracy.time_end)}`);
      console.log(`  備考一致率: ${pct(s.fieldAccuracy.note)}  日付一致率: ${pct(s.fieldAccuracy.date)}`);
      // [2026-08-06追加 評価ロジックP0改善] 上記2行(既存・完全文字列一致)は一切変更していない。
      // 以下は追加行で、「表記差のみ」を除いた意味比較の一致率を別途表示する。
      console.log(
        `  ※意味比較(表記差を無視): time=${pct(s.timeSemanticAccuracy)}(raw=${pct(s.timeRawAccuracy)})` +
          `  time_end=${pct(s.timeEndSemanticAccuracy)}(raw=${pct(s.timeEndRawAccuracy)})` +
          `  date=${pct(s.dateSemanticAccuracy)}(raw=${pct(s.dateRawAccuracy)})`
      );
      console.log(`  ※日付内訳: 欠落(GTに値がありOCRが空欄)=${s.dateMissingCount}件  比較不能(パース不可)=${s.dateUnparseableCount}件`);
    }
    console.log('\n【重要】どちらを採用すべきかの客観評価は、本レポートの実測数値に基づいて人間が判断してください。');
    console.log('このツール自体は「AI同士の多数決」等による自動判定は行いません(最重要方針5)。');
  }
}

async function main(): Promise<void> {
  const { loadedPath } = loadDotEnvLocalIfPresent();
  if (loadedPath) console.log(`[ocr-compare] .env.localを読み込みました: ${loadedPath}`);

  const args = process.argv.slice(2).filter((a: string) => a !== '--include-names');
  const includeNames = process.argv.includes('--include-names');
  const [modeArg, inputPath, groundTruthPath] = args;

  if (!modeArg || (modeArg !== 'single' && modeArg !== 'bulk') || !inputPath) {
    console.error('使い方: npm run ocr:compare -- <single|bulk> <画像またはPDFのパス> [正解データJSONパス] [--include-names]');
    process.exitCode = 1;
    return;
  }
  if (!existsSync(inputPath)) {
    console.error(`ファイルが見つかりません: ${inputPath}`);
    process.exitCode = 1;
    return;
  }

  let groundTruth;
  try {
    groundTruth = loadGroundTruth(groundTruthPath);
  } catch (err) {
    if (err instanceof GroundTruthLoadError) {
      console.error(err.message);
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  const mode: OcrCompareMode = modeArg;
  const mediaType = detectMimeType(inputPath);
  const data = readFileSync(inputPath).toString('base64');

  console.log(`入力: ${inputPath} (${mediaType}, mode=${mode})`);
  console.log('Anthropic / Gemini へ同時にOCRリクエストを送信します…');

  const [anthropicResult, geminiResult] = await Promise.all([
    runOneProvider('anthropic', mode, mediaType, data),
    runOneProvider('gemini', mode, mediaType, data),
  ]);
  const providerResults: ProviderRunResult[] = [anthropicResult, geminiResult];

  let accuracySummaries = null as OcrCompareRunReport['accuracySummaries'];
  let roomComparisons = null as OcrCompareRunReport['roomComparisons'];
  if (groundTruth) {
    accuracySummaries = providerResults.map((r) =>
      computeProviderAccuracySummary(r.provider, r.stage3Lb.entries || [], groundTruth!, r.stage1Raw.processingTimeMs)
    );
    roomComparisons = {
      anthropic: buildRoomComparisons(anthropicResult.stage3Lb.entries || [], groundTruth),
      gemini: buildRoomComparisons(geminiResult.stage3Lb.entries || [], groundTruth),
    };
  }

  const report: OcrCompareRunReport = {
    generatedAtIso: new Date().toISOString(),
    inputFilePath: inputPath,
    mode,
    mediaType,
    groundTruthFilePath: groundTruthPath || null,
    groundTruthRoomCount: groundTruth ? groundTruth.length : null,
    providerResults,
    accuracySummaries,
    roomComparisons,
    namesRedacted: !includeNames,
  };

  printConsoleSummary(report);

  // レポート出力先: リポジトリ直下 /ocr-compare-reports/ (.gitignore済み)。
  const outDir = path.join(process.cwd(), 'ocr-compare-reports');
  mkdirSync(outDir, { recursive: true });
  const baseName = path.basename(inputPath).replace(/[^a-zA-Z0-9_.\-一-龠ぁ-んァ-ヶ]/g, '_');
  const stamp = report.generatedAtIso.replace(/[:.]/g, '-');
  const jsonOutPath = path.join(outDir, `${baseName}.${stamp}.json`);
  const htmlOutPath = path.join(outDir, `${baseName}.${stamp}.html`);

  // JSONレポートも、氏名は既定で伏字化して保存する(最重要方針9)。
  const redactedReportForFile: OcrCompareRunReport = includeNames
    ? report
    : {
        ...report,
        roomComparisons: report.roomComparisons
          ? {
              anthropic: report.roomComparisons.anthropic.map((rc) => redactRoomComparisonForReport(rc, false)),
              gemini: report.roomComparisons.gemini.map((rc) => redactRoomComparisonForReport(rc, false)),
            }
          : null,
        providerResults: report.providerResults.map((r) => ({
          ...r,
          stage3Lb: {
            ...r.stage3Lb,
            entries: r.stage3Lb.entries ? r.stage3Lb.entries.map((e) => ({ ...e, name: e.name ? '(伏字)' : '' })) : null,
          },
        })),
      };

  writeFileSync(jsonOutPath, JSON.stringify(redactedReportForFile, null, 2), 'utf8');
  writeFileSync(htmlOutPath, buildHtmlReport(report), 'utf8');

  console.log(`\nJSONレポートを書き出しました: ${jsonOutPath}`);
  console.log(`HTMLレポート(横並び比較UI)を書き出しました: ${htmlOutPath}`);
  console.log('HTMLファイルをブラウザで開くと、部屋ごとの横並び比較表を確認できます。');
}

main().catch((err) => {
  console.error('予期しないエラーが発生しました:');
  console.error(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
  process.exitCode = 1;
});
