// lib/ocr/standardizedStampSheet/toLiveBoardStampData.ts
//
// [2026-08-13新設 新捺印表OCR→Live Board接続]
// 新捺印表OCRの正規化結果(normalizeStandardizedStampScan の出力)を、Live Boardの部屋カードが
// 扱えるstamp data形式へ変換するアダプタ。
//
// 【設計方針(KB-024「誤確定0優先」の継承)】
// 1. 複数チェック(802のA+P、1005/805のP+キャンセル)を単一symbolへ収束させない。
//    resolved_symbol.state が 'auto_confirmed' のときだけ symbol に値を入れ、それ以外は
//    symbol を空文字のままにして needs_review=true を立てる。LB側は「symbolが空 かつ
//    needs_review」の部屋をA/P/キャンセルとして表示しない。
// 2. 時刻は確定できたものだけ time_start/time_end へ入れる。判読不能・空マス(1101/801の
//    「時」十の位空欄など)は値を入れず、needs_review のまま残す。
// 3. 備考は辞書一致(auto_correct)したものだけを note として確定させる。誤読候補の語
//    (実APIで観測された「斡一」等)は note へ入れず、note_raw に原文のみ残す。
//
// 【既存Legacy経路への影響】無し。この変換はLive Board側のSTAMP_DATA形式
// ({symbol, time, time_end, note, name})に「後方互換で足すだけ」の形で寄せており、
// 既存の点検希望時間連絡票OCR(residentTimeRequestSheet)・ocr_confirm経路のデータ形状は
// 一切変更しない。

import { classifyReviewReasons } from './fieldReview';
import type {
  StandardizedStampNormalizedEntry,
  StandardizedStampNormalizedResult,
  StandardizedStampTimeDesignationRow,
} from './types';

export type LiveBoardStampEntry = {
  room_number: string;
  // 確定した記号のみ。複数チェック・低信頼の場合は空文字(勝手に1つへ収束させない)。
  symbol: '' | 'A' | 'P' | 'キャンセル';
  a_checked: boolean;
  p_checked: boolean;
  cancel_checked: boolean;
  // 確定した時刻のみ。未確定は空文字。
  time_start: string;
  time_end: string;
  // [LB互換キー] 既存のLive Board(initScheduleLabels/formatStampTimeDisplay)が参照する
  // フィールド名。値は time_start と同一。
  time: string;
  // 辞書一致で確定した備考のみ。
  note: string;
  // 読み取った備考の原文(未確定でも失わないために保持する。表示には使わない)。
  note_raw: string;
  // [2026-08-15追加 Phase 2 項目単位の確定] どの項目が要確認なのかを、部屋単位の
  // needs_review とは別に持つ。「時刻は確定・備考だけ要確認」を後段(保存・復元・描画・
  // 運用判断)がそのまま扱えるようにするため。一部が要確認でも、確定した項目は捨てない。
  symbol_review: boolean;
  time_review: boolean;
  note_review: boolean;
  // 上のどれにも当てはまらない要確認理由(部屋番号の桁・重複行・解析エラー等)。
  other_review: boolean;
  // 部屋としての要確認(上のいずれかが真)。既存の表示・件数はこれを使う。
  needs_review: boolean;
  review_reason: string[];
};

// [2026-08-15追加 Phase 2 実LB最終確認②] 部屋を特定できなかった時間指定行のうち、
// 「その行で確かに読めた内容」だけを、値の解釈を一切変えずに持ち出すための形。
//
// 【なぜ必要か(801号室で確定した消失経路)】
// 時間指定行は、その行自身の部屋番号マスからしか部屋へ結合しない(推測で隣の部屋へ割り当てない)。
// そのため部屋番号マスが1マスでも確定できない行は unassigned となるが、従来はここで
// **行の中身を件数(number)へ潰していた**ため、同じ行で確実に読めていた開始時刻・備考が
// Canonical生成の時点で消え、保存にも描画にも残らなかった。該当部屋には痕跡すら付かない
// (時刻が「記入なし」と同じ状態になるため要確認にもならない)ので、利用者からは
// 「その部屋には時間指定が無い」ようにしか見えず、原本を確認する手掛かりも失われていた。
//
// 【この型がしないこと】部屋の推定・時刻の補完・備考の正規化は一切しない。読めた値と
// 「マスの見え方」をそのまま運ぶだけで、どの部屋にも書き込まない(誤確定は増えない)。
export type UnassignedTimeDesignation = {
  row_index: number | null;
  // 部屋番号マスの見え方(空マスは'_'、判読不能は'?')。値の復元には使わない、人が読むための情報。
  room_number_raw: string;
  // 確定できた時刻のみ。確定できなければ空文字(0補完はしない)。
  time_start: string;
  time_end: string;
  // 確定できなかった場合のマスの見え方(例 "?9:30")。原本と突き合わせるための手掛かり。
  time_start_raw: string;
  time_end_raw: string;
  // 読み取った備考の原文(辞書で確定できたかに関わらず、そのまま運ぶ)。
  note_raw: string;
  // 結合できなかった理由(部屋番号マスの判読不能・行位置の不整合など)。
  reasons: string[];
};

export type LiveBoardStampDataResult = {
  stampData: Record<string, LiveBoardStampEntry>;
  // needs_review の部屋番号一覧(LB側のバッジ表示・件数表示用)。
  needsReviewRooms: string[];
  // 同一room_numberが複数行あった等、stampDataへ入れられなかった部屋。
  skippedRooms: Array<{ room_number: string; reason: string }>;
  // 部屋を特定できなかった時間指定行(人手確認が必要)。
  unassignedTimeDesignationRowCount: number;
  // 同じ行で「読めていた内容」。件数だけでは原本のどの行かも分からないため必ず添える。
  unassignedTimeDesignations: UnassignedTimeDesignation[];
};

function toUnassignedTimeDesignation(row: StandardizedStampTimeDesignationRow): UnassignedTimeDesignation {
  return {
    row_index: row.row_index ?? null,
    room_number_raw: row.room_number.raw ?? '',
    time_start: row.start_time.ok && row.start_time.value ? row.start_time.value : '',
    time_end: row.end_time.ok && row.end_time.value ? row.end_time.value : '',
    time_start_raw: row.start_time.ok ? '' : (row.start_time.raw ?? ''),
    time_end_raw: row.end_time.ok ? '' : (row.end_time.raw ?? ''),
    note_raw: row.remarks_raw ?? '',
    reasons: Array.isArray(row.reasons) ? row.reasons.slice() : [],
  };
}

function toEntryList(input: StandardizedStampNormalizedResult | StandardizedStampNormalizedEntry[]): {
  entries: StandardizedStampNormalizedEntry[];
  unassigned: UnassignedTimeDesignation[];
} {
  if (Array.isArray(input)) return { entries: input, unassigned: [] };
  const rows = Array.isArray(input.unassignedTimeDesignationRows) ? input.unassignedTimeDesignationRows : [];
  return {
    entries: input.entries ?? [],
    unassigned: rows.map(toUnassignedTimeDesignation),
  };
}

export function toLiveBoardStampEntry(entry: StandardizedStampNormalizedEntry): LiveBoardStampEntry {
  // 【重要】symbolは auto_confirmed のときだけ採用する。needs_review(複数チェック等)の
  // 部屋を、a_checked/p_checked/cancel_checked から「どれか1つ」に決め直すことは絶対にしない。
  const symbol = entry.resolved_symbol.state === 'auto_confirmed' ? entry.resolved_symbol.value : '';

  const timeStart = entry.time_start.ok && entry.time_start.value ? entry.time_start.value : '';
  const timeEnd = entry.time_end.ok && entry.time_end.value ? entry.time_end.value : '';

  const noteConfirmed = entry.note_raw.trim() && entry.note_misread_match.state === 'auto_correct' ? entry.note_raw : '';

  // 積まれた要確認理由を項目へ振り分ける。判定はここでしない(既に上流で終わっている)。
  const fieldReview = classifyReviewReasons(entry.needsReviewReasons);

  return {
    room_number: entry.room_number,
    symbol,
    a_checked: entry.raw_checkboxes.a_checked,
    p_checked: entry.raw_checkboxes.p_checked,
    cancel_checked: entry.raw_checkboxes.cancel_checked,
    time_start: timeStart,
    time_end: timeEnd,
    time: timeStart,
    note: noteConfirmed,
    note_raw: entry.note_raw,
    symbol_review: fieldReview.symbol,
    time_review: fieldReview.time,
    note_review: fieldReview.note,
    other_review: fieldReview.other,
    needs_review: entry.needsReview,
    review_reason: entry.needsReviewReasons.slice(),
  };
}

export function toLiveBoardStampData(
  input: StandardizedStampNormalizedResult | StandardizedStampNormalizedEntry[]
): LiveBoardStampDataResult {
  const { entries, unassigned } = toEntryList(input);

  const stampData: Record<string, LiveBoardStampEntry> = {};
  const needsReviewRooms: string[] = [];
  const skippedRooms: Array<{ room_number: string; reason: string }> = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    const room = entry.room_number;
    if (!room) {
      skippedRooms.push({ room_number: '', reason: 'EMPTY_ROOM_NUMBER' });
      continue;
    }
    if (seen.has(room)) {
      // 同一room_numberが複数行。どちらが正しいか機械的に決められないため、後勝ちで
      // 上書きせず、両方をstampDataから外して人手確認へ回す。
      delete stampData[room];
      const idx = needsReviewRooms.indexOf(room);
      if (idx !== -1) needsReviewRooms.splice(idx, 1);
      if (!skippedRooms.some((s) => s.room_number === room)) {
        skippedRooms.push({ room_number: room, reason: 'DUPLICATE_ROOM_NUMBER' });
      }
      continue;
    }
    seen.add(room);
    if (skippedRooms.some((s) => s.room_number === room)) continue;

    const lbEntry = toLiveBoardStampEntry(entry);
    stampData[room] = lbEntry;
    if (lbEntry.needs_review) needsReviewRooms.push(room);
  }

  return {
    stampData,
    needsReviewRooms,
    skippedRooms,
    unassignedTimeDesignationRowCount: unassigned.length,
    unassignedTimeDesignations: unassigned,
  };
}
