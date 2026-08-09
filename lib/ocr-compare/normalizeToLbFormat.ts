// lib/ocr-compare/normalizeToLbFormat.ts
//
// [2026-08-05新設] ③LBへ渡す直前の最終データ、を組み立てる。
//
// 【重要・移植元】このロジックは lb_tool/index.html の applyStampSingleOcrResult() /
// applyStampBulkResult() が実際にSTAMP_DATAへ保存する直前に行っているフィールド正規化
// (symbolを'A'|'P'|'キャンセル'の3値以外は空文字に丸める、symbolがあればtime/time_endは
// 強制的に空文字にする、各文字列のtrim等)を、ブラウザ専用のJSからNode側へ「読み取り専用の
// 移植」したものである。lb_tool/index.html 自体は1文字も変更していない。
//
// 【既知の制約(意図的に未実装)】applyStampBulkResult/applyStampSingleOcrResultは、
// date(原文)を resolveStampScheduleDate() 経由で scheduleDate/scheduleDay へ正規化するが、
// これはLB側の実行時状態(PROPERTY.scheduleDays=物件ごとに登録された点検実施日一覧)に
// 依存しており、物件非依存のこのCLIでは再現できない。そのため date は原文のまま
// dateRaw として保持し、scheduleDate/scheduleDayへの変換は行わない。誤ったロジックを
// 重複実装してLB側の実装とズレる方が危険と判断したため、意図的な未実装であり、
// レポートにもその旨を明記する。
//
// 【将来lb_tool/index.html側のロジックが変更された場合】このファイルもあわせて
// 見直すこと(重複実装ゆえの既知の同期リスクとして、このコメントで明示しておく)。

import type { LbNormalizedEntry } from './types';

function toTrimmedString(value: unknown): string {
  return (value === undefined || value === null ? '' : String(value)).trim();
}

// lb_tool/index.html の該当行そのまま:
//   var symbol = (item.symbol === 'A' || item.symbol === 'P' || item.symbol === 'キャンセル') ? item.symbol : '';
function normalizeSymbol(rawSymbol: unknown): '' | 'A' | 'P' | 'キャンセル' {
  return rawSymbol === 'A' || rawSymbol === 'P' || rawSymbol === 'キャンセル' ? rawSymbol : '';
}

export function normalizeOneEntry(item: unknown): { ok: true; entry: LbNormalizedEntry } | { ok: false; error: string } {
  if (!item || typeof item !== 'object') {
    return { ok: false, error: '想定外の形式の項目です(オブジェクトではありません): ' + JSON.stringify(item) };
  }
  const obj = item as Record<string, unknown>;
  const room = toTrimmedString(obj.room_number);
  if (!room) {
    return { ok: false, error: '部屋番号を読み取れませんでした。' };
  }
  const symbol = normalizeSymbol(obj.symbol);
  // lb_tool/index.html: var time = symbol ? '' : (item.time || '').toString().trim();
  const time = symbol ? '' : toTrimmedString(obj.time);
  const timeEnd = symbol ? '' : toTrimmedString(obj.time_end);
  const note = toTrimmedString(obj.note);
  const name = toTrimmedString(obj.name);
  const dateRaw = toTrimmedString(obj.date);
  return {
    ok: true,
    entry: { room_number: room, symbol, time, time_end: timeEnd, note, name, dateRaw },
  };
}

// mode: 'single'ならparsedは単一オブジェクト、'bulk'ならparsedは配列を期待する
// (本番のscanInspectionScheduleSlipと同じ前提)。部屋番号が読み取れない要素は
// (bulkモードのapplyStampBulkResultと同じく)スキップし、失敗理由だけskippedへ積む。
export function normalizeToLbEntries(
  parsed: unknown,
  mode: 'single' | 'bulk'
): { ok: true; entries: LbNormalizedEntry[]; skipped: string[] } | { ok: false; error: string } {
  if (mode === 'single') {
    const result = normalizeOneEntry(parsed);
    if (!result.ok) return { ok: false, error: result.error };
    return { ok: true, entries: [result.entry], skipped: [] };
  }

  if (!Array.isArray(parsed)) {
    return { ok: false, error: 'bulkモードでは配列を期待しますが、配列以外が渡されました。' };
  }
  const entries: LbNormalizedEntry[] = [];
  const skipped: string[] = [];
  for (const item of parsed) {
    const result = normalizeOneEntry(item);
    if (result.ok) {
      entries.push(result.entry);
    } else {
      skipped.push(result.error);
    }
  }
  return { ok: true, entries, skipped };
}
