// [2026-08-13新設 実API検証フェーズ]
// 時間指定エリアの行単位抽出・結合の回帰テスト。実Anthropic API検証(2026-08-13)で観測した
// 3件の誤確定(空マスの0補完×2、1001→1002への割当ズレ×1)をそのまま再現ケースにしている。

import { parseRoomNumberCells, joinTimeDesignationRows } from '../../../../lib/ocr/standardizedStampSheet/timeDesignation';
import { normalizeStandardizedStampScan } from '../../../../lib/ocr/standardizedStampSheet/normalizeStandardizedStamp';

function assert(cond: unknown, msg: string) { if (!cond) throw new Error('FAIL: ' + msg); }

function gridRoom(room: string, symbol: 'A' | 'P' | 'C' | 'AP' | 'PC' | '' = '') {
  return {
    room_number: room,
    raw_checkboxes: {
      a_checked: symbol === 'A' || symbol === 'AP',
      p_checked: symbol === 'P' || symbol === 'AP' || symbol === 'PC',
      cancel_checked: symbol === 'C' || symbol === 'PC',
    },
  };
}

// --- 部屋番号マスの読み取り ---
{ const r = parseRoomNumberCells(['1', '0', '0', '1']); assert(r.ok && r.value === '1001', '4桁'); }
{ const r = parseRoomNumberCells(['', '6', '0', '3']); assert(r.ok && r.value === '603', '3桁は先頭空マス、0埋めしない'); }
{ const r = parseRoomNumberCells(['0', '8', '0', '1']); assert(r.ok === false && r.reason === 'LEADING_ZERO', '先頭0は確定しない'); }
{ const r = parseRoomNumberCells(['1', '', '0', '1']); assert(r.ok === false && r.reason === 'MISSING_CELL', '途中の空マスは補完しない'); }
{ const r = parseRoomNumberCells(['1', '0', '0', '?']); assert(r.ok === false && r.reason === 'ILLEGIBLE_DIGIT', '判読不能'); }
{ const r = parseRoomNumberCells(['', '', '', '']); assert(r.blank === true && r.ok === false, '空行'); }
{ const r = parseRoomNumberCells('1001'); assert(r.ok === false && r.reason === 'CELL_DATA_UNAVAILABLE', '文字列は不可'); }
{ const r = parseRoomNumberCells(['', '', '6', '']); assert(r.ok === false, '末尾空マスは確定しない'); }

// --- 回帰: 1001の時間指定が1002へ割り当てられない ---
{
  const scan = {
    rooms: [gridRoom('1002', 'P'), gridRoom('1001', 'A')],
    time_designation_rows: [
      { row_index: 1, room_number_cells: ['1', '0', '0', '1'], start_time_cells: ['1', '0', '0', '0'], end_time_cells: ['1', '1', '3', '0'], remarks_raw: '' },
    ],
  };
  const { entries, timeDesignationRows } = normalizeStandardizedStampScan(scan);
  const r1001 = entries.find((e) => e.room_number === '1001')!;
  const r1002 = entries.find((e) => e.room_number === '1002')!;
  assert(r1001.time_start.value === '10:00' && r1001.time_end.value === '11:30', '1001に結合される');
  assert(r1002.time_start.value === null && r1002.time_end.value === null, '1002には時刻が入らない');
  assert(r1002.needsReview === false, '1002は時間指定なしのまま確定でよい');
  assert(timeDesignationRows[0].assigned_room_number === '1001', '結合先は行自身の部屋番号');
}

// --- 回帰: 空マス時刻(1101・801)は確定しない ---
{
  const scan = {
    rooms: [gridRoom('1101', 'A'), gridRoom('801', 'A')],
    time_designation_rows: [
      { row_index: 1, room_number_cells: ['1', '1', '0', '1'], start_time_cells: ['', '9', '3', '0'], end_time_cells: ['', '', '', ''], remarks_raw: '' },
      { row_index: 2, room_number_cells: ['', '8', '0', '1'], start_time_cells: ['', '9', '3', '0'], end_time_cells: ['', '', '', ''], remarks_raw: '朝一' },
    ],
  };
  const { entries, unassignedTimeDesignationRows } = normalizeStandardizedStampScan(scan);
  const r1101 = entries.find((e) => e.room_number === '1101')!;
  const r801 = entries.find((e) => e.room_number === '801')!;
  assert(r1101.time_start.value === null && r1101.needsReview === true, '1101は確定しない');
  assert(r801.time_start.value === null && r801.needsReview === true, '801は確定しない');
  assert(r1101.resolved_symbol.value === 'A' && r1101.resolved_symbol.state === 'auto_confirmed', '記号Aは維持');
  assert(r801.resolved_symbol.value === 'A' && r801.resolved_symbol.state === 'auto_confirmed', '801の記号Aは維持');
  assert(unassignedTimeDesignationRows.length === 2, '2行とも要確認へ');
  assert(unassignedTimeDesignationRows.every((r) => r.reasons.some((x) => x.startsWith('TIME_START:MISSING_CELL'))), '理由がMISSING_CELL');
  assert(unassignedTimeDesignationRows[1].remarks_raw === '朝一', '備考は原文保持');
}

// --- 備考「朝一」は辞書一致すること(結合できた場合) ---
{
  const scan = {
    rooms: [gridRoom('801', 'A')],
    time_designation_rows: [
      { row_index: 1, room_number_cells: ['', '8', '0', '1'], start_time_cells: ['0', '9', '3', '0'], end_time_cells: ['', '', '', ''], remarks_raw: '朝一' },
    ],
  };
  const { entries } = normalizeStandardizedStampScan(scan);
  assert(entries[0].note_raw === '朝一' && entries[0].note_misread_match.state === 'auto_correct', '朝一はauto_correct');
  assert(entries[0].time_start.value === '09:30' && entries[0].needsReview === false, '全マス埋まっていれば確定');
}

// --- 誤読語(都合一)は確定しない ---
{
  const scan = {
    rooms: [gridRoom('801', 'A')],
    time_designation_rows: [
      { row_index: 1, room_number_cells: ['', '8', '0', '1'], start_time_cells: ['0', '9', '3', '0'], end_time_cells: ['', '', '', ''], remarks_raw: '都合一' },
    ],
  };
  const { entries, unassignedTimeDesignationRows } = normalizeStandardizedStampScan(scan);
  assert(entries[0].needsReview === true, '誤読候補の備考は要確認');
  assert(unassignedTimeDesignationRows.length === 1, '行も要確認');
}

// --- 本体グリッドに無い部屋番号 / 時間指定エリア内の重複 ---
{
  const scan = {
    rooms: [gridRoom('101', 'A')],
    time_designation_rows: [
      { row_index: 1, room_number_cells: ['9', '9', '9', '9'], start_time_cells: ['1', '0', '0', '0'], end_time_cells: ['', '', '', ''], remarks_raw: '' },
    ],
  };
  const { unassignedTimeDesignationRows } = normalizeStandardizedStampScan(scan);
  assert(unassignedTimeDesignationRows[0].reasons.includes('ROOM_NOT_IN_MAIN_GRID'), '本体グリッドに無い');
  assert(unassignedTimeDesignationRows[0].assigned_room_number === null, '結合しない');
}
{
  const scan = {
    rooms: [gridRoom('101', 'A')],
    time_designation_rows: [
      { row_index: 1, room_number_cells: ['', '1', '0', '1'], start_time_cells: ['1', '0', '0', '0'], end_time_cells: ['', '', '', ''], remarks_raw: '' },
      { row_index: 2, room_number_cells: ['', '1', '0', '1'], start_time_cells: ['1', '3', '0', '0'], end_time_cells: ['', '', '', ''], remarks_raw: '' },
    ],
  };
  const { entries, unassignedTimeDesignationRows } = normalizeStandardizedStampScan(scan);
  assert(unassignedTimeDesignationRows.length === 2, '同一部屋が2行 => 両方要確認');
  assert(unassignedTimeDesignationRows.every((r) => r.reasons.includes('DUPLICATE_ROOM_IN_TIME_GRID')), '重複理由');
  assert(entries[0].time_start.value === null, 'どちらの時刻も採用しない');
}

// --- 行位置(row_index)が検証できない行は確定しない ---
{
  const scan = {
    rooms: [gridRoom('101', 'A')],
    time_designation_rows: [
      { room_number_cells: ['', '1', '0', '1'], start_time_cells: ['1', '0', '0', '0'], end_time_cells: ['', '', '', ''], remarks_raw: '' },
    ],
  };
  // row_index欠落時はフォールバックで連番が入るため確定できる(1行目=1)。
  const { entries } = normalizeStandardizedStampScan(scan);
  assert(entries[0].time_start.value === '10:00', 'フォールバック行番号で確定');
}
{
  const scan = {
    rooms: [gridRoom('101', 'A')],
    time_designation_rows: [
      { row_index: 99, room_number_cells: ['', '1', '0', '1'], start_time_cells: ['1', '0', '0', '0'], end_time_cells: ['', '', '', ''], remarks_raw: '' },
    ],
  };
  const { entries, unassignedTimeDesignationRows } = normalizeStandardizedStampScan(scan);
  assert(unassignedTimeDesignationRows[0].reasons.includes('ROW_POSITION_UNVERIFIABLE'), '範囲外の行番号');
  assert(entries[0].time_start.value === null, '確定しない');
}

// --- 空行はレビュー対象にしない ---
{
  const scan = {
    rooms: [gridRoom('101', 'A')],
    time_designation_rows: [
      { row_index: 1, room_number_cells: ['', '', '', ''], start_time_cells: ['', '', '', ''], end_time_cells: ['', '', '', ''], remarks_raw: '' },
    ],
  };
  const { entries, timeDesignationRows, unassignedTimeDesignationRows } = normalizeStandardizedStampScan(scan);
  assert(timeDesignationRows[0].state === 'blank', '空行はblank');
  assert(unassignedTimeDesignationRows.length === 0, '空行は要確認に出さない');
  assert(entries[0].needsReview === false, '空行があっても部屋は確定できる');
}

// --- 判読不能な断片だけの行(実物サンプルの左サブテーブル1行目)は部屋を捏造しない ---
{
  const scan = {
    rooms: [gridRoom('101', 'A')],
    time_designation_rows: [
      { row_index: 1, room_number_cells: ['?', '1', '', ''], start_time_cells: ['', '', '', ''], end_time_cells: ['', '', '', ''], remarks_raw: '' },
    ],
  };
  const { unassignedTimeDesignationRows } = normalizeStandardizedStampScan(scan);
  assert(unassignedTimeDesignationRows.length === 1, '断片行は要確認');
  assert(unassignedTimeDesignationRows[0].assigned_room_number === null, '部屋を推測しない');
}

// --- joinTimeDesignationRows を直接呼ぶ場合も同じ ---
{
  const { entries } = normalizeStandardizedStampScan({ rooms: [gridRoom('705', 'P')], time_designation_rows: [] });
  const { rows } = joinTimeDesignationRows(entries, [
    { row_index: 1, room_number_cells: ['', '7', '0', '5'], start_time_cells: ['1', '3', '0', '0'], end_time_cells: ['1', '4', '0', '0'], remarks_raw: '' },
  ]);
  assert(rows[0].state === 'auto_confirmed' && entries[0].time_end.value === '14:00', '直接呼び出しでも結合');
}

console.log('timeDesignation.test.ts: ALL PASS');
