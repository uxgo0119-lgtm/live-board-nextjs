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

// --- [2026-08-14更新 最小修正 / 実データ準拠] 1桁の「時」(1101・801)は09:30として確定する ---
// 実画像1枚の実API検証で返ってきたマスの並びをそのまま使う。紙面上はどちらも同じ「9:30」だが、
// 1101号室は ['9','','3','0']、801号室は ['','9','3','0'] と、数字がどちらのマスに入るかが
// ブレて返ってきた。gridTimeParserの最小修正(時欄の片方だけ空欄+分2マス数字なら1桁時として
// 確定)により、どちらの並びでも09:30として確定する。801の備考「朝一」も、時刻確定に伴い
// 行全体がconfirmedになるため、辞書一致(auto_correct)のままentryへ書き込まれる。
{
  const scan = {
    rooms: [gridRoom('1101', 'A'), gridRoom('801', 'A')],
    time_designation_rows: [
      { row_index: 1, room_number_cells: ['1', '1', '0', '1'], start_time_cells: ['9', '', '3', '0'], end_time_cells: ['', '', '', ''], remarks_raw: '' },
      { row_index: 2, room_number_cells: ['', '8', '0', '1'], start_time_cells: ['', '9', '3', '0'], end_time_cells: ['', '', '', ''], remarks_raw: '朝一' },
    ],
  };
  const { entries, unassignedTimeDesignationRows } = normalizeStandardizedStampScan(scan);
  const r1101 = entries.find((e) => e.room_number === '1101')!;
  const r801 = entries.find((e) => e.room_number === '801')!;
  assert(r1101.time_start.value === '09:30' && r1101.needsReview === false, '1101は09:30で確定する');
  assert(r801.time_start.value === '09:30' && r801.needsReview === false, '801は09:30で確定する');
  assert(r801.note_raw === '朝一' && r801.note_misread_match.state === 'auto_correct', '801の備考「朝一」も同時に確定する');
  assert(r1101.resolved_symbol.value === 'A' && r1101.resolved_symbol.state === 'auto_confirmed', '記号Aは維持');
  assert(r801.resolved_symbol.value === 'A' && r801.resolved_symbol.state === 'auto_confirmed', '801の記号Aは維持');
  assert(unassignedTimeDesignationRows.length === 0, '2行とも結合され、未割当はなくなる');
}

// --- 回帰: 区切り記号':'がマスとして返ってきても、1101の9:30は部屋まで届く ---
// [2026-08-15追加 Phase 2 実LB最終確認] 実LBで1101号室が「要確認・09:30が欠落」となった経路。
// モデルは印字された区切り記号を配列要素として返すことがあり、「時」が1桁だと4要素
// ['9',':','3','0'] になる。':'の前後で分ければ時1マス・分2マスと位置で確定するため、
// 紙面の9:30がそのまま部屋カードまで届かなければならない。
{
  const scan = {
    rooms: [gridRoom('1101', 'A'), gridRoom('801', 'A')],
    time_designation_rows: [
      { row_index: 1, room_number_cells: ['1', '1', '0', '1'], start_time_cells: ['9', ':', '3', '0'], end_time_cells: ['', '', '', ''], remarks_raw: '' },
      { row_index: 2, room_number_cells: ['', '8', '0', '1'], start_time_cells: ['', '9', ':', '3', '0'], end_time_cells: ['', '', '', ''], remarks_raw: '朝一' },
    ],
  };
  const { entries, unassignedTimeDesignationRows } = normalizeStandardizedStampScan(scan);
  const r1101 = entries.find((e) => e.room_number === '1101')!;
  const r801 = entries.find((e) => e.room_number === '801')!;
  assert(r1101.time_start.value === '09:30' && r1101.needsReview === false, '1101は区切り記号込みでも09:30で確定する');
  assert(r801.time_start.value === '09:30' && r801.needsReview === false, '801も同じ形で09:30のまま');
  assert(r1101.resolved_symbol.value === 'A', '記号Aは維持');
  assert(unassignedTimeDesignationRows.length === 0, '未割当は増えない');
}

// --- 確定できなかった時刻の理由には、マスの見え方が添えられる(次回の原因特定用) ---
{
  const scan = {
    rooms: [gridRoom('1101', 'A')],
    time_designation_rows: [
      { row_index: 1, room_number_cells: ['1', '1', '0', '1'], start_time_cells: ['', '', '3', '0'], end_time_cells: ['', '', '', ''], remarks_raw: '' },
    ],
  };
  const { entries } = normalizeStandardizedStampScan(scan);
  const reason = entries[0].needsReviewReasons.find((x) => x.startsWith('TIME_START:'))!;
  assert(reason === 'TIME_START:MISSING_CELL(??:30)', '理由に「モデルが返したマスの見え方」が入る: ' + reason);
}

// --- 回帰: 「分」欄に空欄がある場合は、従来通り確定しない ---
// 1桁として確定してよいのは「時」欄だけ(分は常に2桁で記入される)。分の欠損を0で埋めると
// 訪問時刻を取り違えるため、確定させず要確認へ倒す。
{
  const scan = {
    rooms: [gridRoom('1101', 'A')],
    time_designation_rows: [
      { row_index: 1, room_number_cells: ['1', '1', '0', '1'], start_time_cells: ['', '9', '3', ''], end_time_cells: ['', '', '', ''], remarks_raw: '' },
    ],
  };
  // [2026-08-15更新 Phase 2] 部屋(1101)は行自身の部屋番号マスから確定できているため、
  // 「部屋を特定できなかった行(unassigned)」には入れない。時刻が読めなかったことは、
  // その部屋の要確認理由として伝える。unassignedは利用者へ
  // 「部屋を特定できない時間指定 N件」と表示される数なので、部屋が判っている行を数えない。
  const { entries, timeDesignationRows, unassignedTimeDesignationRows } = normalizeStandardizedStampScan(scan);
  const r1101 = entries.find((e) => e.room_number === '1101')!;
  assert(r1101.time_start.value === null && r1101.needsReview === true, '分が欠けていれば確定しない');
  assert(r1101.needsReviewReasons.some((x) => x.startsWith('TIME_START:MISSING_CELL')), '部屋の要確認理由がMISSING_CELL');
  assert(timeDesignationRows[0].state === 'needs_review', '行の状態は要確認');
  assert(timeDesignationRows[0].reasons.some((x) => x.startsWith('TIME_START:MISSING_CELL')), '行の理由がMISSING_CELL');
  assert(unassignedTimeDesignationRows.length === 0, '部屋は特定できているので未割当にはしない');
}

// --- 回帰: 「時」欄が両方空欄なら確定しない(桁を作らない) ---
{
  const scan = {
    rooms: [gridRoom('1101', 'A')],
    time_designation_rows: [
      { row_index: 1, room_number_cells: ['1', '1', '0', '1'], start_time_cells: ['', '', '3', '0'], end_time_cells: ['', '', '', ''], remarks_raw: '' },
    ],
  };
  const { entries, timeDesignationRows, unassignedTimeDesignationRows } = normalizeStandardizedStampScan(scan);
  assert(entries[0].time_start.value === null && entries[0].needsReview === true, '時が読めていなければ確定しない');
  assert(timeDesignationRows[0].state === 'needs_review', '行の状態は要確認');
  assert(unassignedTimeDesignationRows.length === 0, '部屋は特定できているので未割当にはしない');
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
  const { entries, timeDesignationRows, unassignedTimeDesignationRows } = normalizeStandardizedStampScan(scan);
  assert(entries[0].needsReview === true, '誤読候補の備考は要確認');
  assert(entries[0].note_misread_match.state !== 'auto_correct', '誤読候補はnoteとして確定しない');
  // [2026-08-15更新 実LB1回分の診断で確定] 備考が確定しないことと、時刻が確定することは別。
  // 部屋を特定できている行なので「未割当(部屋不明)」には入れず、行の状態だけ要確認にする。
  assert(entries[0].time_start.value === '09:30', '備考が誤読候補でも時刻は確定して残る');
  assert(timeDesignationRows[0].state === 'needs_review', '行の状態は要確認');
  assert(unassignedTimeDesignationRows.length === 0, '部屋は特定できているので未割当にはしない');
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

// --- [2026-08-15新設 実LB1回分の診断で確定した回帰] 備考が読めなくても時刻は巻き添えで消さない ---
// 実LBでの1回の読み込みで、801号室の備考が辞書に無い語(実測: 「都合ー」)として返ってきた結果、
// 独立に確定できていた開始時刻09:30まで丸ごと破棄され、部屋カードが記号Aだけになっていた。
// 時刻は結合し、備考は確定させず原文だけ残して要確認にする。
{
  const scan = {
    rooms: [gridRoom('801', 'A')],
    time_designation_rows: [
      { row_index: 1, room_number_cells: ['', '8', '0', '1'], start_time_cells: ['', '9', '3', '0'], end_time_cells: ['', '', '', ''], remarks_raw: '辞書に無い語' },
    ],
  };
  const { entries, timeDesignationRows, unassignedTimeDesignationRows } = normalizeStandardizedStampScan(scan);
  const r801 = entries.find((e) => e.room_number === '801')!;
  assert(r801.time_start.value === '09:30', '備考が読めなくても時刻は確定して結合される');
  assert(r801.note_raw === '辞書に無い語', '備考の原文は失わずに保持する');
  assert(r801.note_misread_match.state !== 'auto_correct', '備考は確定させない');
  assert(r801.needsReview === true && r801.needsReviewReasons.some((x) => x.startsWith('NOTE:')), '備考未確定として要確認にする');
  assert(timeDesignationRows[0].assigned_room_number === '801', '行は801へ結合される');
  assert(timeDesignationRows[0].state === 'needs_review', '行の状態は要確認(備考が未確定のため)');
  assert(unassignedTimeDesignationRows.length === 0, '部屋は特定できているので未割当にはしない');
}

// --- [2026-08-15新設 Phase 2 項目単位の確定] 開始と終了は互いを巻き添えにしない ---
// 「13:00〜14:00」の終了マスに判読不能が1文字あるだけで、明確に読めている開始13:00まで
// 破棄されていた(全体ゲート)。開始は確定して部屋へ届け、終了だけを要確認にする。
{
  const scan = {
    rooms: [gridRoom('705', 'P')],
    time_designation_rows: [
      { row_index: 1, room_number_cells: ['', '7', '0', '5'], start_time_cells: ['1', '3', '0', '0'], end_time_cells: ['1', '?', '0', '0'], remarks_raw: '' },
    ],
  };
  const { entries, timeDesignationRows, unassignedTimeDesignationRows } = normalizeStandardizedStampScan(scan);
  const r705 = entries.find((e) => e.room_number === '705')!;
  assert(r705.time_start.value === '13:00', '読めた開始時刻は捨てない');
  assert(r705.time_end.value === null && r705.time_end.ok === false, '読めない終了時刻は確定しない');
  assert(r705.resolved_symbol.value === 'P', '記号Pは維持');
  assert(r705.needsReview === true && r705.needsReviewReasons.some((x) => x.startsWith('TIME_END:')), '終了時刻だけが要確認理由');
  assert(!r705.needsReviewReasons.some((x) => x.startsWith('TIME_START:')), '開始時刻は要確認理由にならない');
  assert(timeDesignationRows[0].assigned_room_number === '705', '行は705へ結合される');
  assert(unassignedTimeDesignationRows.length === 0, '部屋は特定できているので未割当にはしない');
}
// 逆向き(開始が読めず終了だけ読めた)でも同じく、読めた側を捨てない。
{
  const scan = {
    rooms: [gridRoom('705', 'P')],
    time_designation_rows: [
      { row_index: 1, room_number_cells: ['', '7', '0', '5'], start_time_cells: ['1', '?', '0', '0'], end_time_cells: ['1', '4', '0', '0'], remarks_raw: '' },
    ],
  };
  const { entries } = normalizeStandardizedStampScan(scan);
  const r705 = entries.find((e) => e.room_number === '705')!;
  assert(r705.time_start.value === null && r705.time_start.ok === false, '読めない開始時刻は確定しない');
  assert(r705.time_end.value === '14:00', '読めた終了時刻は捨てない');
  assert(r705.needsReviewReasons.some((x) => x.startsWith('TIME_START:')), '開始時刻が要確認理由');
  assert(!r705.needsReviewReasons.some((x) => x.startsWith('TIME_END:')), '終了時刻は要確認理由にならない');
}
// 時刻が読めなくても、備考が辞書一致していれば備考は確定する(項目は互いに独立)。
{
  const scan = {
    rooms: [gridRoom('801', 'A')],
    time_designation_rows: [
      { row_index: 1, room_number_cells: ['', '8', '0', '1'], start_time_cells: ['?', '9', '3', '0'], end_time_cells: ['', '', '', ''], remarks_raw: '朝一' },
    ],
  };
  const { entries } = normalizeStandardizedStampScan(scan);
  const r801 = entries.find((e) => e.room_number === '801')!;
  assert(r801.time_start.value === null, '読めない時刻は確定しない');
  assert(r801.note_misread_match.state === 'auto_correct' && r801.note_raw === '朝一', '備考は独立に確定する');
  assert(r801.resolved_symbol.value === 'A', '記号Aは維持');
  assert(!r801.needsReviewReasons.some((x) => x.startsWith('NOTE:')), '備考は要確認理由にならない');
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
