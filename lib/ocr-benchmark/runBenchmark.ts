#!/usr/bin/env npx tsx
// lib/ocr-benchmark/runBenchmark.ts
//
// [2026-07-28新設] OCRベンチマークCLI。Google Cloud Vision API と Google Document AI
// (Document OCRプロセッサ)の両方で捺印表(点検希望時間連絡票)の画像/PDFをOCR→
// lib/ocr-benchmark/stampGridParser.ts で解析し、処理時間・パース結果・(正解データを
// 渡した場合は)項目別一致率・概算費用を出力する。
//
// 使い方:
//   npm run ocr:benchmark -- <画像またはPDFのパス> [正解データJSONパス]
//
// 【重要】このスクリプトは本番のOCR経路(app/api/scan-time-request/route.ts等、
// Anthropic/Claudeベース)を一切呼び出さない。あくまでGoogle Cloud側2プロバイダの
// 精度比較用。Google Cloudの認証情報(GOOGLE_APPLICATION_CREDENTIALS_JSON等、
// lib/ocr-benchmark/googleAuth.ts参照)が未設定の環境で実行した場合、生の例外
// スタックトレースではなく、分かりやすい日本語エラーメッセージが表示されて終了する
// (各プロバイダを個別にtry/catchしているため、片方だけ認証情報が揃っている場合は
// そちらの結果だけが出力される)。

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { runVisionDocumentTextDetection } from './visionOcr';
import { runDocumentAiOcr } from './documentAiOcr';
import { parseStampGridWords } from './stampGridParser';
import { OcrBenchmarkConfigError } from './googleAuth';
import { printFailureAnalysisReport, buildVisualReviewQueue } from './failureAnalysis';
import type { OcrProviderResult, StampSheetEntry } from './types';

function detectMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.pdf') return 'application/pdf';
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  return 'image/jpeg';
}

// Cloud Vision API: documentTextDetectionは$1.50 / 1000ユニット
// (1画像=1ユニット、PDF等の複数ページ入力は1ページ=1ユニット)という固定レートで概算する。
// 参考: https://cloud.google.com/vision/pricing (実際の請求額とは異なる場合がある簡易概算)。
function estimateVisionCostUsd(pageCount: number): number {
  return (pageCount / 1000) * 1.5;
}

// Document AI Document OCRプロセッサ: $1.50 / 1000ページという固定レートで概算する。
// 参考: https://cloud.google.com/document-ai/pricing (実際の請求額とは異なる場合がある簡易概算)。
function estimateDocumentAiCostUsd(pageCount: number): number {
  return (pageCount / 1000) * 1.5;
}

function loadGroundTruth(filePath: string | undefined): StampSheetEntry[] | null {
  if (!filePath) return null;
  if (!existsSync(filePath)) {
    throw new Error(`正解データJSONが見つかりません: ${filePath}`);
  }
  const raw = JSON.parse(readFileSync(filePath, 'utf8'));
  if (!Array.isArray(raw)) throw new Error('正解データJSONは配列である必要があります。');
  return raw as StampSheetEntry[];
}

interface MatchStats {
  totalGroundTruth: number;
  matchedRooms: number;
  roomNumberMatchRate: number;
  symbolMatchRate: number;
  dateMatchRate: number;
  noteMatchRate: number;
  // 「OCR全体の成功率」= 正解データの各行について、部屋番号・symbol(午前/午後)・日付・備考の
  // 4項目すべてが完全一致した行の割合。1項目でもズレていれば、その行はカウントしない
  // (人間が最終的に一切手直ししなくて済んだ行、という意味での「完全成功」を表す厳しめの指標)。
  overallSuccessRate: number;
}

// 正解データ(ground truth)を基準に、部屋番号ごとの一致率を計算する。
// - 部屋番号一致率: 正解データの部屋番号が、パース結果にも(部屋番号として)存在した割合。
// - symbol一致率・日付一致率・備考一致率: 部屋番号が一致した項目のうち、該当フィールドの値も
//   完全一致した割合(全体の正解データ件数を分母にする。部屋番号自体が読み取れなければ
//   当然不一致扱い)。
// - 備考一致率について: noteは自由記述のためOCRの些細な表記ゆれ(全角/半角、空白等)でも
//   不一致判定になりうる、厳密な完全一致での計測である点に注意(実運用時の「体感の使いやすさ」
//   より厳しい数値が出ることがある)。
// - OCR全体の成功率: 4項目(部屋番号・symbol・日付・備考)すべてが完全一致した行の割合。
function computeMatchStats(parsed: StampSheetEntry[], groundTruth: StampSheetEntry[]): MatchStats {
  const parsedByRoom = new Map(parsed.map((e) => [e.room_number, e]));
  let matchedRooms = 0;
  let symbolMatches = 0;
  let dateMatches = 0;
  let noteMatches = 0;
  let fullyCorrect = 0;
  for (const gt of groundTruth) {
    const found = parsedByRoom.get(gt.room_number);
    if (!found) continue;
    matchedRooms++;
    const symbolOk = (found.symbol || '') === (gt.symbol || '');
    const dateOk = (found.date || '') === (gt.date || '');
    const noteOk = (found.note || '') === (gt.note || '');
    if (symbolOk) symbolMatches++;
    if (dateOk) dateMatches++;
    if (noteOk) noteMatches++;
    if (symbolOk && dateOk && noteOk) fullyCorrect++;
  }
  const total = groundTruth.length || 1;
  return {
    totalGroundTruth: groundTruth.length,
    matchedRooms,
    roomNumberMatchRate: matchedRooms / total,
    symbolMatchRate: symbolMatches / total,
    dateMatchRate: dateMatches / total,
    noteMatchRate: noteMatches / total,
    overallSuccessRate: fullyCorrect / total,
  };
}

function formatPct(rate: number | null): string {
  return rate === null ? 'N/A' : `${(rate * 100).toFixed(1)}%`;
}

// --- [2026-07-29追加] 運用評価: 「OCR確認画面での修正」を、正解データとの差分から推定する ---
//
// 【この指標の位置づけ・限界について、必ず読んでください】
// ここで算出する「修正が必要な項目数」「そのまま採用できた部屋数」は、実際に人間が
// OCR確認画面を操作して測った時間ではなく、パース結果と正解データ(ground truth)を
// フィールド単位で突き合わせた「客観的な差分」である。正解データが正しいという前提が
// 成り立つなら、この差分は「人間が確認画面でどの項目を直す必要があるか」を機械的に
// 再現したものであり、実測データ(推測ではない)と言える。ただし、これはあくまで
// 「何を直す必要があるか」の実測であって、「直すのに何秒かかったか」という所要時間
// (①人が修正するのに掛かった時間、⑤人による最終確認の総作業時間)そのものではない。
// 所要時間は実際に人が操作する時間を計測しない限り実測にならないため、このスクリプトでは
// 算出しない(README内の手動計測ワークシートを参照)。
const CORRECTABLE_FIELDS: Array<keyof StampSheetEntry> = ['symbol', 'time', 'time_end', 'note', 'name', 'date'];

interface RoomCorrectionDetail {
  room_number: string;
  foundByOcr: boolean;
  correctedFields: string[];
}

interface CorrectionStats {
  totalRooms: number;
  roomsUsableAsIs: number; // OCR結果を1項目も直さずそのまま採用できた部屋数(④)
  roomsNeedingManualAdd: number; // 部屋番号自体をOCRが読み取れず、手動で行ごと追加が必要な部屋数
  roomsNeedingPartialFix: number; // 部屋は見つかったが、1項目以上の修正が必要な部屋数
  totalCorrectedFieldCount: number; // ②の推定値: 修正が必要なフィールドの延べ数(部屋番号読み取り失敗分は含まない、後述)
  perRoom: RoomCorrectionDetail[];
}

function computeCorrectionStats(parsed: StampSheetEntry[], groundTruth: StampSheetEntry[]): CorrectionStats {
  const parsedByRoom = new Map(parsed.map((e) => [e.room_number, e]));
  const perRoom: RoomCorrectionDetail[] = [];
  let roomsUsableAsIs = 0;
  let roomsNeedingManualAdd = 0;
  let roomsNeedingPartialFix = 0;
  let totalCorrectedFieldCount = 0;

  for (const gt of groundTruth) {
    const found = parsedByRoom.get(gt.room_number);
    if (!found) {
      // 部屋番号自体が読み取れていない場合、「N項目修正」ではなく「行ごと手動追加」という
      // 質的に異なる作業になるため、totalCorrectedFieldCountには加算しない
      // (フィールド単位の修正件数と、行単位の追加作業を混同して合算しないため)。
      roomsNeedingManualAdd++;
      perRoom.push({ room_number: gt.room_number, foundByOcr: false, correctedFields: [...CORRECTABLE_FIELDS] });
      continue;
    }
    const correctedFields = CORRECTABLE_FIELDS.filter((f) => (found[f] || '') !== (gt[f] || ''));
    if (correctedFields.length === 0) {
      roomsUsableAsIs++;
    } else {
      roomsNeedingPartialFix++;
      totalCorrectedFieldCount += correctedFields.length;
    }
    perRoom.push({ room_number: gt.room_number, foundByOcr: true, correctedFields });
  }

  return {
    totalRooms: groundTruth.length,
    roomsUsableAsIs,
    roomsNeedingManualAdd,
    roomsNeedingPartialFix,
    totalCorrectedFieldCount,
    perRoom,
  };
}

function printCorrectionStats(label: string, stats: CorrectionStats): void {
  console.log(`\n--- ${label}: 運用評価(正解データとの差分ベース) ---`);
  console.log(`④ そのまま採用できた部屋数: ${stats.roomsUsableAsIs}/${stats.totalRooms}`);
  console.log(`   部分修正が必要な部屋数: ${stats.roomsNeedingPartialFix}/${stats.totalRooms}`);
  console.log(`   部屋番号ごと手動追加が必要な部屋数: ${stats.roomsNeedingManualAdd}/${stats.totalRooms}`);
  console.log(`② 修正が必要なフィールドの延べ数(部分修正の部屋のみ集計): ${stats.totalCorrectedFieldCount}件`);
  if (stats.roomsNeedingManualAdd > 0 || stats.roomsNeedingPartialFix > 0) {
    const detail = stats.perRoom
      .filter((r) => !r.foundByOcr || r.correctedFields.length > 0)
      .map((r) => (r.foundByOcr ? `${r.room_number}(${r.correctedFields.join('/')})`  : `${r.room_number}(部屋番号読み取り失敗・行ごと手動追加)`))
      .join(', ');
    console.log(`   内訳: ${detail}`);
  }
}

type ProviderOutcome = { result: OcrProviderResult; parsed: StampSheetEntry[] } | { error: string };

async function runProvider(name: 'vision' | 'documentai', filePath: string, mimeType: string): Promise<ProviderOutcome> {
  try {
    const result =
      name === 'vision'
        ? await runVisionDocumentTextDetection({ filePath })
        : await runDocumentAiOcr({ filePath, mimeType });
    const parsed = parseStampGridWords(result.words);
    return { result, parsed };
  } catch (err) {
    if (err instanceof OcrBenchmarkConfigError) {
      return { error: err.message };
    }
    return { error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) };
  }
}

async function main(): Promise<void> {
  const [, , inputPath, groundTruthPath] = process.argv;
  if (!inputPath) {
    console.error('使い方: npm run ocr:benchmark -- <画像またはPDFのパス> [正解データJSONパス]');
    process.exitCode = 1;
    return;
  }
  if (!existsSync(inputPath)) {
    console.error(`ファイルが見つかりません: ${inputPath}`);
    process.exitCode = 1;
    return;
  }

  let groundTruth: StampSheetEntry[] | null;
  try {
    groundTruth = loadGroundTruth(groundTruthPath);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }

  const mimeType = detectMimeType(inputPath);
  console.log('=== OCRベンチマーク (Google Cloud Vision API vs Google Document AI) ===');
  console.log(`入力ファイル: ${inputPath} (${mimeType})`);
  if (groundTruth) {
    console.log(`正解データ: ${groundTruthPath} (${groundTruth.length}件)`);
  }

  const [visionOutcome, docAiOutcome] = await Promise.all([
    runProvider('vision', inputPath, mimeType),
    runProvider('documentai', inputPath, mimeType),
  ]);

  const providerRuns: Array<{ label: string; outcome: ProviderOutcome; costFn: (pages: number) => number }> = [
    { label: 'Cloud Vision API (documentTextDetection)', outcome: visionOutcome, costFn: estimateVisionCostUsd },
    { label: 'Document AI (Document OCRプロセッサ)', outcome: docAiOutcome, costFn: estimateDocumentAiCostUsd },
  ];

  for (const { label, outcome, costFn } of providerRuns) {
    console.log(`\n--- ${label} ---`);
    if ('error' in outcome) {
      console.log(`実行できませんでした: ${outcome.error}`);
      continue;
    }
    console.log(`処理時間: ${outcome.result.processingTimeMs}ms`);
    console.log(`検出単語数: ${outcome.result.words.length}`);
    console.log(`パース結果件数: ${outcome.parsed.length}`);
    console.log(JSON.stringify(outcome.parsed, null, 2));

    const pageCount = outcome.result.pages.length || 1;
    const costUsd = costFn(pageCount);
    console.log(`概算費用: $${costUsd.toFixed(4)} (${pageCount}ページ換算、固定レートによる簡易概算)`);

    if (groundTruth) {
      const stats = computeMatchStats(outcome.parsed, groundTruth);
      console.log('--- 正解データとの一致率 ---');
      console.log(
        `部屋番号一致率: ${(stats.roomNumberMatchRate * 100).toFixed(1)}% ` +
          `(${stats.matchedRooms}/${stats.totalGroundTruth})`
      );
      console.log(`AM/PM(symbol)一致率: ${(stats.symbolMatchRate * 100).toFixed(1)}%`);
      console.log(`日付一致率: ${(stats.dateMatchRate * 100).toFixed(1)}%`);
      console.log(`備考一致率: ${(stats.noteMatchRate * 100).toFixed(1)}%`);
      console.log(`OCR全体の成功率(4項目完全一致): ${(stats.overallSuccessRate * 100).toFixed(1)}%`);

      const correctionStats = computeCorrectionStats(outcome.parsed, groundTruth);
      printCorrectionStats(label, correctionStats);

      const failureCases = printFailureAnalysisReport(label, outcome.parsed, groundTruth);
      const reviewQueue = buildVisualReviewQueue(failureCases);
      if (reviewQueue.length > 0) {
        const providerKey = label.includes('Vision') ? 'vision' : 'documentai';
        const outPath = `${inputPath}.${providerKey}.failure_review_queue.json`;
        writeFileSync(outPath, JSON.stringify(reviewQueue, null, 2), 'utf8');
        console.log(`\n  → 目視レビュー待ちケースを ${outPath} に書き出しました。このファイルをこのチャットに添付・共有いただければ、原紙画像と突き合わせて「手書き文字が原因」「印鑑や罫線の重なりが原因」「人間でも判読が難しいケース」「その他」に分類します。`);
      }
    }
  }

  printComparisonTable(providerRuns, groundTruth);
}

// ユーザー指定の9指標(部屋番号認識率・午前/午後認識率・日付認識率・備考認識率・
// OCR全体の成功率・処理時間・API利用料金(概算)・既存JSONへの変換しやすさ・
// LBへの反映のしやすさ)を、Vision API / Document AI 横並びの表形式で出力する。
function printComparisonTable(
  providerRuns: Array<{ label: string; outcome: ProviderOutcome; costFn: (pages: number) => number }>,
  groundTruth: StampSheetEntry[] | null
): void {
  console.log('\n=== 比較表 (Cloud Vision API vs Document AI) ===');

  const cells = providerRuns.map(({ outcome, costFn }) => {
    if ('error' in outcome) {
      return {
        ok: false as const,
        error: outcome.error,
      };
    }
    const pageCount = outcome.result.pages.length || 1;
    const stats = groundTruth ? computeMatchStats(outcome.parsed, groundTruth) : null;
    const correctionStats = groundTruth ? computeCorrectionStats(outcome.parsed, groundTruth) : null;
    return {
      ok: true as const,
      processingTimeMs: outcome.result.processingTimeMs,
      costUsd: costFn(pageCount),
      stats,
      correctionStats,
    };
  });

  // 【既存JSONへの変換しやすさ・LBへの反映のしやすさについて(実測ではなく設計上の事実)】
  // このベンチマークは両プロバイダとも、プロバイダ固有のレスポンスを
  // 共通中間形式(OcrWord[]、lib/ocr-benchmark/types.ts参照)へ変換したうえで、
  // 同一のstampGridParser.tsに通し、同一のStampSheetEntry型(既存JSON形式そのもの)を
  // 出力するよう意図的に設計している(理由はtypes.ts冒頭のコメント参照)。
  // そのため「既存JSONへの変換しやすさ」「LBへの反映のしやすさ」は、設計上
  // Vision APIとDocument AIで完全に同一(両方とも追加コード不要でそのままLBへ渡せる)であり、
  // 実測で差が出る性質の指標ではない。ここでは実測データを装って差をでっち上げるのではなく、
  // 「設計により同一」という事実をそのまま報告する。
  const conversionEase = '○ 既存JSON形式へ変換済み(両プロバイダ共通のstampGridParser.tsを経由するため、設計上Vision/Document AIで差はない)';
  const lbReflectionEase = '○ 既存JSON形式のままLBの実装(applyStampBulkResult等)にそのまま渡せる(既存動作を変更していないため、両プロバイダで差はない)';

  const header = ['指標', ...providerRuns.map((p) => p.label)];
  const rows: string[][] = [];

  rows.push(['部屋番号認識率', ...cells.map((c) => (!c.ok ? '実行不可' : formatPct(c.stats?.roomNumberMatchRate ?? null)))]);
  rows.push(['午前/午後(symbol)認識率', ...cells.map((c) => (!c.ok ? '実行不可' : formatPct(c.stats?.symbolMatchRate ?? null)))]);
  rows.push(['日付認識率', ...cells.map((c) => (!c.ok ? '実行不可' : formatPct(c.stats?.dateMatchRate ?? null)))]);
  rows.push(['備考認識率', ...cells.map((c) => (!c.ok ? '実行不可' : formatPct(c.stats?.noteMatchRate ?? null)))]);
  rows.push(['OCR全体の成功率(4項目完全一致)', ...cells.map((c) => (!c.ok ? '実行不可' : formatPct(c.stats?.overallSuccessRate ?? null)))]);
  rows.push(['処理時間', ...cells.map((c) => (!c.ok ? '実行不可' : `${c.processingTimeMs}ms`))]);
  rows.push(['API利用料金(概算・1枚あたり)', ...cells.map((c) => (!c.ok ? '実行不可' : `$${c.costUsd.toFixed(4)}`))]);
  rows.push(['既存JSONへの変換しやすさ', ...cells.map((c) => (!c.ok ? '実行不可' : conversionEase))]);
  rows.push(['LBへの反映のしやすさ', ...cells.map((c) => (!c.ok ? '実行不可' : lbReflectionEase))]);
  rows.push([
    '④ そのまま採用できた部屋数',
    ...cells.map((c) => (!c.ok ? '実行不可' : c.correctionStats ? `${c.correctionStats.roomsUsableAsIs}/${c.correctionStats.totalRooms}` : 'N/A')),
  ]);
  rows.push([
    '② 修正が必要な項目の延べ数(推定)',
    ...cells.map((c) => (!c.ok ? '実行不可' : c.correctionStats ? `${c.correctionStats.totalCorrectedFieldCount}件` : 'N/A')),
  ]);

  if (cells.some((c) => !c.ok)) {
    console.log('(実行できなかったプロバイダがあります。詳細は各プロバイダのセクションのエラーメッセージを参照してください。)');
  }
  if (!groundTruth) {
    console.log('(正解データJSONが未指定のため、認識率系の指標は算出していません。npm run ocr:benchmark -- <画像> <正解データJSON> の形式で実行してください。)');
  }

  console.log(`| ${header.join(' | ')} |`);
  console.log(`| ${header.map(() => '---').join(' | ')} |`);
  for (const row of rows) {
    console.log(`| ${row.join(' | ')} |`);
  }
}

main().catch((err) => {
  console.error('予期しないエラーが発生しました:');
  console.error(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
  process.exitCode = 1;
});
