// lib/ocr-compare/htmlReport.ts
//
// [2026-08-05新設] ユーザー指定の「比較しやすいUI」(例: 部屋101 / Anthropic:午前 /
// Gemini:午後 / 正解:午後、のような横並び表示)を、自己完結型の静的HTMLファイルとして
// 生成する。本番のNext.jsアプリ(app/api/**, public/**)には一切追加しない
// (最重要方針3: 比較機能は本番OCR経路と分離した開発・検証専用機能)。生成された
// このHTMLファイルは、開発者がローカルでブラウザで開いて見るだけのものであり、
// どこにもデプロイ・公開しない。

import type { OcrCompareRunReport, OcrCompareProviderKey, RoomFieldComparison } from './types';
import { redactRoomComparisonForReport } from './redact';
// [2026-08-06追加 評価ロジックP0改善] comparisonStatusの日本語ラベル・バッジ表示用。
import type { ComparisonStatus, FieldComparisonDetail } from './normalizeTimeAndDate';

function esc(value: unknown): string {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function pct(value: number | null): string {
  return value === null ? 'N/A' : `${(value * 100).toFixed(1)}%`;
}

const PROVIDER_LABEL: Record<OcrCompareProviderKey, string> = {
  anthropic: 'Anthropic(本番)',
  gemini: 'Gemini',
};

function renderProviderStatusTable(report: OcrCompareRunReport): string {
  const rows = report.providerResults
    .map((r) => {
      const s1 = r.stage1Raw;
      const statusLabel = !s1.attempted
        ? '<span class="badge badge-warn">未検証(実APIキー未設定等)</span>'
        : s1.ok
        ? '<span class="badge badge-ok">実API疎通確認</span>'
        : '<span class="badge badge-err">実API呼び出し失敗</span>';
      // [2026-08-05追加 P0] JSON抽出方式(raw/markdown/bracket)とSchema Validation結果を表示。
      const extractionMethodLabel = r.stage2Parsed.extractionMethod
        ? { raw: '①そのままJSON.parse', markdown: '②Markdownコードブロック抽出', bracket: '③括弧探索(説明文混入等)' }[r.stage2Parsed.extractionMethod]
        : '—';
      const schemaLabel = r.stage2Parsed.schemaValidation
        ? r.stage2Parsed.schemaValidation.ok
          ? '<span class="badge badge-ok">OK</span>'
          : `<span class="badge badge-warn">NG: ${esc(r.stage2Parsed.schemaValidation.reason)}</span>`
        : '—';
      return `<tr>
        <td>${esc(PROVIDER_LABEL[r.provider])}</td>
        <td>${statusLabel}</td>
        <td>${s1.processingTimeMs === null ? 'N/A' : s1.processingTimeMs + 'ms'}</td>
        <td>${esc(extractionMethodLabel)}</td>
        <td>${schemaLabel}</td>
        <td>${esc(s1.errorMessage || r.stage2Parsed.errorMessage || '')}</td>
        <td>${r.stage3Lb.entries ? r.stage3Lb.entries.length + '件' : 'N/A'}</td>
      </tr>`;
    })
    .join('\n');
  return `<table class="report-table">
    <thead><tr><th>プロバイダ</th><th>実測ステータス</th><th>処理時間</th><th>JSON抽出方式</th><th>Schema Validation</th><th>エラー詳細</th><th>抽出件数</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function renderAccuracySummaryTable(report: OcrCompareRunReport): string {
  if (!report.accuracySummaries) {
    return '<p>正解データ(ground truth)が指定されていないため、認識率は算出していません。</p>';
  }
  const rows = report.accuracySummaries
    .map(
      (s) => `<tr>
        <td>${esc(PROVIDER_LABEL[s.provider])}</td>
        <td>${pct(s.roomNumberRecognitionRate)} (${s.totalGroundTruthRooms - s.missingRoomCount}/${s.totalGroundTruthRooms})</td>
        <td>${s.missingRoomCount}件</td>
        <td>${s.phantomRoomCount}件</td>
        <td>${pct(s.ampmAccuracy)}</td>
        <td>${pct(s.cancelAccuracy)}</td>
        <td>${pct(s.blankAccuracy)}</td>
        <td>${pct(s.fieldAccuracy.time)} / ${pct(s.fieldAccuracy.time_end)}</td>
        <td>${pct(s.fieldAccuracy.note)}</td>
        <td>${pct(s.fieldAccuracy.date)}</td>
        <td>${s.processingTimeMs === null ? 'N/A' : s.processingTimeMs + 'ms'}</td>
      </tr>`
    )
    .join('\n');
  // [2026-08-06追加 評価ロジックP0改善] 上のrows/theadは既存の完全文字列一致(raw)の
  // 集計であり、算出方法・列とも一切変更していない。以下は追加の別テーブルで、
  // 「表記差のみ」を除いた意味比較の一致率(timeSemanticAccuracy等)を並べて表示する。
  const semanticRows = report.accuracySummaries
    .map(
      (s) => `<tr>
        <td>${esc(PROVIDER_LABEL[s.provider])}</td>
        <td>${pct(s.timeRawAccuracy)}</td>
        <td>${pct(s.timeSemanticAccuracy)}</td>
        <td>${pct(s.timeEndRawAccuracy)}</td>
        <td>${pct(s.timeEndSemanticAccuracy)}</td>
        <td>${pct(s.dateRawAccuracy)}</td>
        <td>${pct(s.dateSemanticAccuracy)}</td>
        <td>${s.dateMissingCount}件</td>
        <td>${s.dateUnparseableCount}件</td>
      </tr>`
    )
    .join('\n');
  const semanticTable = `<table class="report-table">
    <thead><tr>
      <th>プロバイダ</th>
      <th>time raw一致率</th><th>time 意味一致率</th>
      <th>time_end raw一致率</th><th>time_end 意味一致率</th>
      <th>date raw一致率</th><th>date 意味一致率</th>
      <th>date 欠落件数(GTに値ありOCR空欄)</th><th>date 比較不能件数(パース不可)</th>
    </tr></thead>
    <tbody>${semanticRows}</tbody>
  </table>
  <p class="note-text">※「意味一致率」は"9:00"と"09:00"のような表記差(ゼロ埋め等)を同一とみなした一致率です。raw一致率(既存の完全文字列一致)は変更していません。日付欠落件数は、Ground Truthに値があるのにOCR側が空欄だった件数です(この件数は意味一致率の分母に含まれたまま不一致として数えられており、意味一致率が誤って高く出ることはありません)。</p>`;
  return `<table class="report-table">
    <thead><tr>
      <th>プロバイダ</th><th>部屋番号認識率</th><th>欠落</th><th>存在しない部屋の追加</th>
      <th>午前/午後一致率</th><th>キャンセル一致率</th><th>空欄判定一致率</th>
      <th>時間指定(time/time_end)一致率</th><th>備考一致率</th><th>日付一致率</th><th>処理時間</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>
  ${semanticTable}`;
}

function fieldCell(rc: RoomFieldComparison, provider: 'gt' | OcrCompareProviderKey, field: 'symbol' | 'time' | 'time_end' | 'note' | 'date'): string {
  const source = provider === 'gt' ? rc.expected : rc.actual;
  if (!source) return '<span class="cell-muted">—</span>';
  const value = field === 'date' ? source.dateRaw : source[field];
  return esc(value || '(空欄)');
}

function matchMarker(rc: RoomFieldComparison, field: 'symbol' | 'time' | 'time_end' | 'note' | 'date'): string {
  if (!rc.presentInGroundTruth || !rc.presentInOcrResult) return '';
  const ok = rc.fieldMatches[field];
  if (ok === undefined) return '';
  return ok ? '<span class="mark-ok">○</span>' : '<span class="mark-ng">×</span>';
}

// [2026-08-06追加 評価ロジックP0改善] time/date専用: 「完全一致」「表記差のみ」「本当の
// 不一致」「欠落」「比較不能」を視覚的に区別して表示する(既存のfieldCell/matchMarkerは
// symbol/time_end/note向けとして変更せず残す)。
const STATUS_LABEL: Record<ComparisonStatus, string> = {
  matched: '完全一致',
  format_only_difference: '表記差のみ(意味一致)',
  actual_mismatch: '本当の不一致',
  missing: '欠落(OCR側が空欄)',
  unparseable: '比較不能(形式解析不可)',
};
const STATUS_BADGE_CLASS: Record<ComparisonStatus, string> = {
  matched: 'status-matched',
  format_only_difference: 'status-format-only',
  actual_mismatch: 'status-mismatch',
  missing: 'status-missing',
  unparseable: 'status-unparseable',
};

function detailCell(detail: FieldComparisonDetail | undefined): string {
  if (!detail) return '<span class="cell-muted">—</span>';
  const badge = `<span class="status-badge ${STATUS_BADGE_CLASS[detail.comparisonStatus]}">${esc(STATUS_LABEL[detail.comparisonStatus])}</span>`;
  return `<div class="detail-cell">
    <div>GT: ${esc(detail.groundTruthRaw || '(空欄)')}</div>
    <div>OCR: ${esc(detail.providerRaw || '(空欄)')}</div>
    <div>判定: ${badge}</div>
  </div>`;
}

// time/dateはtimeDetail/dateDetail(あれば)を優先して表示し、それ以外の項目
// (symbol/time_end/note)は既存どおりfieldCell+matchMarkerで表示する。
function providerCell(rc: RoomFieldComparison, provider: OcrCompareProviderKey, field: 'symbol' | 'time' | 'time_end' | 'note' | 'date'): string {
  if (field === 'time' && rc.timeDetail) return detailCell(rc.timeDetail);
  if (field === 'date' && rc.dateDetail) return detailCell(rc.dateDetail);
  return `${fieldCell(rc, provider, field)} ${matchMarker(rc, field)}`;
}

// ユーザー指定の「部屋101 / Anthropic:午前 / Gemini:午後 / 正解:午後」という
// 横並び比較を、部屋番号ごとに1ブロックとして描画する。
function renderRoomByRoomComparison(report: OcrCompareRunReport): string {
  if (!report.roomComparisons) {
    return '<p>正解データ(ground truth)が指定されていないため、部屋ごとの正誤判定は表示できません(OCR結果同士の生データ比較のみ下部のJSON比較セクションをご覧ください)。</p>';
  }
  const providers = report.providerResults.map((r) => r.provider);
  const primary = report.roomComparisons[providers[0]] || [];
  const secondary = providers[1] ? report.roomComparisons[providers[1]] || [] : [];
  const secondaryByRoom = new Map(secondary.map((rc) => [rc.room_number, rc]));

  const blocks = primary
    .map((rcA) => {
      const rcBRaw = secondaryByRoom.get(rcA.room_number);
      const rcARedacted = redactRoomComparisonForReport(rcA, !report.namesRedacted);
      const rcB = rcBRaw ? redactRoomComparisonForReport(rcBRaw, !report.namesRedacted) : null;
      const statusTag = rcARedacted.isPhantomRoom
        ? '<span class="badge badge-err">存在しない部屋(正解データに無い)</span>'
        : rcARedacted.isMissingRoom
        ? '<span class="badge badge-warn">欠落(いずれのプロバイダも検出できず)</span>'
        : '';
      const fields: Array<{ key: 'symbol' | 'time' | 'time_end' | 'note' | 'date'; label: string }> = [
        { key: 'symbol', label: '午前/午後/キャンセル' },
        { key: 'time', label: '時間(開始)' },
        { key: 'time_end', label: '時間(終了)' },
        { key: 'date', label: '日付(原文)' },
        { key: 'note', label: '備考' },
      ];
      const fieldRows = fields
        .map(
          (f) => `<tr>
          <td>${esc(f.label)}</td>
          <td>${providerCell(rcARedacted, providers[0], f.key)}</td>
          ${rcB ? `<td>${providerCell(rcB, providers[1], f.key)}</td>` : ''}
          <td>${fieldCell(rcARedacted, 'gt', f.key)}</td>
        </tr>`
        )
        .join('');
      return `<details class="room-block">
        <summary>部屋 ${esc(rcA.room_number)} ${statusTag}</summary>
        <table class="report-table room-field-table">
          <thead><tr><th>項目</th><th>${esc(PROVIDER_LABEL[providers[0]])}</th>${providers[1] ? `<th>${esc(PROVIDER_LABEL[providers[1]])}</th>` : ''}<th>正解</th></tr></thead>
          <tbody>${fieldRows}</tbody>
        </table>
      </details>`;
    })
    .join('\n');

  return `<div class="room-blocks">${blocks}</div>`;
}

function renderJsonComparisonSection(report: OcrCompareRunReport): string {
  const blocks = report.providerResults
    .map(
      (r) => `<div class="json-block">
        <h4>${esc(PROVIDER_LABEL[r.provider])}: ①生レスポンス</h4>
        <pre>${esc(r.stage1Raw.rawText ?? '(未取得: ' + (r.stage1Raw.errorMessage || '') + ')')}</pre>
        <h4>${esc(PROVIDER_LABEL[r.provider])}: ②JSON解析後</h4>
        <pre>${esc(r.stage2Parsed.parsed !== null ? JSON.stringify(r.stage2Parsed.parsed, null, 2) : '(未取得: ' + (r.stage2Parsed.errorMessage || '') + ')')}</pre>
        <h4>${esc(PROVIDER_LABEL[r.provider])}: ③LB取込直前データ${report.namesRedacted ? '(氏名は伏字)' : ''}</h4>
        <pre>${esc(
          r.stage3Lb.entries
            ? JSON.stringify(
                r.stage3Lb.entries.map((e) => (report.namesRedacted ? { ...e, name: e.name ? '(伏字)' : '' } : e)),
                null,
                2
              )
            : '(未取得: ' + (r.stage3Lb.errorMessage || '') + ')'
        )}</pre>
      </div>`
    )
    .join('\n');
  return blocks;
}

export function buildHtmlReport(report: OcrCompareRunReport): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<title>FireFlow 捺印表OCR比較レポート — ${esc(report.inputFilePath)}</title>
<style>
  body { font-family: -apple-system, "Hiragino Kaku Gothic ProN", sans-serif; margin: 24px; color: #1a1a1a; background: #f7f7f8; }
  h1 { font-size: 20px; }
  h2 { font-size: 16px; margin-top: 32px; border-bottom: 2px solid #ddd; padding-bottom: 6px; }
  h4 { font-size: 13px; margin: 12px 0 4px; }
  .meta { color: #555; font-size: 13px; margin-bottom: 16px; }
  .report-table { border-collapse: collapse; width: 100%; background: #fff; margin: 8px 0 16px; font-size: 13px; }
  .report-table th, .report-table td { border: 1px solid #ddd; padding: 6px 8px; text-align: left; vertical-align: top; }
  .report-table th { background: #f0f0f2; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 12px; }
  .badge-ok { background: #dff5e1; color: #1a7f37; }
  .badge-warn { background: #fff4d6; color: #8a6100; }
  .badge-err { background: #fde2e1; color: #b3261e; }
  .mark-ok { color: #1a7f37; font-weight: bold; }
  .mark-ng { color: #b3261e; font-weight: bold; }
  .cell-muted { color: #999; }
  .room-block { background: #fff; border: 1px solid #ddd; border-radius: 6px; margin-bottom: 8px; padding: 8px 12px; }
  .room-block summary { cursor: pointer; font-weight: 600; }
  .note-text { color: #555; font-size: 12px; margin: 4px 0 16px; }
  .detail-cell { font-size: 12px; line-height: 1.5; }
  .detail-cell div { white-space: pre-wrap; }
  .status-badge { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; }
  .status-matched { background: #dff5e1; color: #1a7f37; }
  .status-format-only { background: #dbeeff; color: #0a5bb8; }
  .status-mismatch { background: #fde2e1; color: #b3261e; }
  .status-missing { background: #fff4d6; color: #8a6100; }
  .status-unparseable { background: #ececec; color: #555; }
  pre { background: #1e1e1e; color: #d4d4d4; padding: 10px; overflow-x: auto; font-size: 12px; border-radius: 6px; }
  .warn-box { background: #fff4d6; border: 1px solid #e6c200; padding: 10px 14px; border-radius: 6px; margin: 12px 0; font-size: 13px; }
</style>
</head>
<body>
  <h1>FireFlow 捺印表OCR比較レポート(Anthropic vs Gemini)</h1>
  <div class="meta">
    生成日時: ${esc(report.generatedAtIso)}<br>
    入力ファイル: ${esc(report.inputFilePath)} (${esc(report.mediaType)}, mode=${esc(report.mode)})<br>
    正解データ: ${report.groundTruthFilePath ? esc(report.groundTruthFilePath) + `(${report.groundTruthRoomCount}件)` : '未指定'}
  </div>
  <div class="warn-box">
    ⚠ この比較結果は、実行時に実際に到達できたAPIの応答に基づく実測値です。「未検証」バッジが付いているプロバイダは、実APIキーが未設定、または実API呼び出しに失敗しており、その行の数値は実測ではありません。推測で「検証済み」として扱わないでください。
  </div>

  <h2>プロバイダ別・実行ステータス</h2>
  ${renderProviderStatusTable(report)}

  <h2>正解データとの一致率(項目別)</h2>
  ${renderAccuracySummaryTable(report)}

  <h2>部屋ごとの横並び比較</h2>
  ${renderRoomByRoomComparison(report)}

  <h2>①②③ 生データ・JSON比較(トレーサビリティ)</h2>
  ${renderJsonComparisonSection(report)}
</body>
</html>`;
}
