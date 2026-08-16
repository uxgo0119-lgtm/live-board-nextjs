// [2026-08-13新設 新捺印表OCR→LB接続]
// 新捺印表OCRの正規化結果 → Live Board用stamp dataへの変換アダプタのテスト。
// 実Anthropic API検証(2026-08-13、コスモ城東野江ロイヤルフォルム)で確定した実データの
// 期待値をそのまま回帰ケースにしている。

import { toLiveBoardStampData, toLiveBoardStampEntry } from '../../../../lib/ocr/standardizedStampSheet/toLiveBoardStampData';
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
function timeRow(rowIndex: number, roomCells: string[], start: string[], end: string[], remarks = '') {
  return { row_index: rowIndex, room_number_cells: roomCells, start_time_cells: start, end_time_cells: end, remarks_raw: remarks };
}

// --- 単一記号は確定する ---
{
  const scan = { rooms: [gridRoom('1003', 'P'), gridRoom('405', 'P'), gridRoom('1004', 'A'), gridRoom('804', 'C')], time_designation_rows: [] };
  const { stampData, needsReviewRooms } = toLiveBoardStampData(normalizeStandardizedStampScan(scan));
  assert(stampData['1003'].symbol === 'P' && stampData['1003'].needs_review === false, '1003=P');
  assert(stampData['405'].symbol === 'P' && stampData['405'].needs_review === false, '405=P');
  assert(stampData['1004'].symbol === 'A', '1004=A');
  assert(stampData['804'].symbol === 'キャンセル', '804=キャンセル');
  assert(needsReviewRooms.length === 0, '要確認なし');
  assert(stampData['1003'].p_checked === true && stampData['1003'].a_checked === false, '生チェック状態も保持');
}

// --- 【最重要】複数チェックを単一symbolへ収束させない ---
{
  const scan = { rooms: [gridRoom('802', 'AP'), gridRoom('1005', 'PC'), gridRoom('805', 'PC')], time_designation_rows: [] };
  const { stampData, needsReviewRooms } = toLiveBoardStampData(normalizeStandardizedStampScan(scan));
  for (const room of ['802', '1005', '805']) {
    assert(stampData[room].symbol === '', room + ': symbolを単一値へ収束させない');
    assert(stampData[room].needs_review === true, room + ': needs_review');
    assert(stampData[room].review_reason.some((r) => r.includes('MULTIPLE_SYMBOL_CHECKED')), room + ': 理由を保持');
  }
  assert(stampData['802'].a_checked === true && stampData['802'].p_checked === true, '802はA+Pの生状態を保持');
  assert(stampData['1005'].p_checked === true && stampData['1005'].cancel_checked === true, '1005はP+キャンセルの生状態を保持');
  assert(stampData['805'].p_checked === true && stampData['805'].cancel_checked === true, '805はP+キャンセルの生状態を保持');
  assert(needsReviewRooms.length === 3, '3室が要確認');
}

// --- 確定した時刻だけを入れる ---
{
  const scan = {
    rooms: [gridRoom('1001', 'A'), gridRoom('705', 'P'), gridRoom('603', 'A'), gridRoom('503', 'A'), gridRoom('1305', 'P')],
    time_designation_rows: [
      timeRow(1, ['1', '0', '0', '1'], ['1', '0', '0', '0'], ['1', '1', '3', '0']),
      timeRow(2, ['', '7', '0', '5'], ['1', '3', '0', '0'], ['1', '4', '0', '0']),
      timeRow(3, ['', '6', '0', '3'], ['1', '0', '0', '0'], ['', '', '', '']),
      timeRow(4, ['', '5', '0', '3'], ['1', '1', '0', '0'], ['1', '1', '1', '5']),
      timeRow(5, ['1', '3', '0', '5'], ['1', '4', '0', '0'], ['', '', '', '']),
    ],
  };
  const { stampData } = toLiveBoardStampData(normalizeStandardizedStampScan(scan));
  assert(stampData['1001'].time_start === '10:00' && stampData['1001'].time_end === '11:30', '1001=10:00〜11:30');
  assert(stampData['1001'].time === '10:00', 'LB互換キーtimeにも入る');
  assert(stampData['705'].time_start === '13:00' && stampData['705'].time_end === '14:00', '705=13:00〜14:00');
  assert(stampData['603'].time_start === '10:00' && stampData['603'].time_end === '', '603=10:00');
  assert(stampData['503'].time_start === '11:00' && stampData['503'].time_end === '11:15', '503=11:00〜11:15');
  assert(stampData['1305'].time_start === '14:00', '1305=14:00');
  assert(Object.keys(stampData).every((r) => stampData[r].needs_review === false), '確定できた行は要確認にしない');
}

// --- [2026-08-14更新 最小修正] 「時」十の位のみ空欄(1101/801)は09:30として確定・反映される ---
{
  const scan = {
    rooms: [gridRoom('1101', 'A'), gridRoom('801', 'A')],
    time_designation_rows: [
      // [2026-08-14更新 実データ準拠] 実APIは同じ「9:30」でも 1101号室=['9','','3','0']、
      // 801号室=['','9','3','0'] と、数字が入るマスがブレて返す。実測どおりの並びで通す。
      timeRow(1, ['1', '1', '0', '1'], ['9', '', '3', '0'], ['', '', '', '']),
      timeRow(2, ['', '8', '0', '1'], ['', '9', '3', '0'], ['', '', '', ''], '朝一'),
    ],
  };
  const { stampData } = toLiveBoardStampData(normalizeStandardizedStampScan(scan));
  assert(stampData['1101'].time_start === '09:30' && stampData['1101'].time === '09:30', '1101=09:30で確定・LB互換キーにも反映');
  assert(stampData['801'].time_start === '09:30', '801=09:30で確定');
  assert(stampData['801'].note === '朝一', '801の備考「朝一」もLBへ反映される');
  assert(stampData['1101'].needs_review === false && stampData['801'].needs_review === false, '両室とも要確認は解除される');
  assert(stampData['1101'].symbol === 'A' && stampData['801'].symbol === 'A', '記号自体は確定できているので維持する');
}

// --- 回帰: 「分」欄に空欄がある場合は、従来通り確定せず要確認のまま残す ---
// 1桁として扱ってよいのは「時」欄だけ(分は常に2桁で記入される)。
{
  const scan = {
    rooms: [gridRoom('1101', 'A')],
    time_designation_rows: [timeRow(1, ['1', '1', '0', '1'], ['', '9', '3', ''], ['', '', '', ''])],
  };
  const { stampData } = toLiveBoardStampData(normalizeStandardizedStampScan(scan));
  assert(stampData['1101'].time_start === '' && stampData['1101'].time === '', '分が欠けていれば時刻は確定しない');
  assert(stampData['1101'].needs_review === true, '要確認のまま');
  assert(stampData['1101'].symbol === 'A', '記号自体は確定できているので維持する');
}

// --- 備考は辞書一致したものだけ確定。誤読候補は原文のみ保持 ---
{
  const scan = {
    rooms: [gridRoom('801', 'A')],
    time_designation_rows: [timeRow(1, ['', '8', '0', '1'], ['0', '9', '3', '0'], ['', '', '', ''], '朝一')],
  };
  const { stampData } = toLiveBoardStampData(normalizeStandardizedStampScan(scan));
  assert(stampData['801'].note === '朝一' && stampData['801'].needs_review === false, '朝一は確定');
}
{
  const scan = {
    rooms: [gridRoom('801', 'A')],
    time_designation_rows: [timeRow(1, ['', '8', '0', '1'], ['0', '9', '3', '0'], ['', '', '', ''], '斡一')],
  };
  const normalized = normalizeStandardizedStampScan(scan);
  const { stampData } = toLiveBoardStampData(normalized);
  assert(stampData['801'].note === '', '誤読候補の備考は確定しない');
  assert(stampData['801'].needs_review === true, '要確認');
  assert(stampData['801'].review_reason.some((r) => r.startsWith('NOTE:')), '備考が理由に含まれる');
  // [2026-08-15更新] 備考が未確定でも、時刻は独立に確定して部屋へ入る(巻き添えで消さない)。
  // 備考の原文は部屋エントリ側に保持され、確定していないためnoteには出さない。
  assert(stampData['801'].time_start === '09:30', '備考が未確定でも時刻は残る');
  assert(stampData['801'].note_raw === '斡一', '備考の原文は部屋エントリに保持される');
  assert(normalized.unassignedTimeDesignationRows.length === 0, '部屋を特定できているので未割当にはしない');
}

// --- 重複room_numberはstampDataへ入れない ---
{
  const scan = { rooms: [gridRoom('1305', 'P'), gridRoom('1305', 'P')], time_designation_rows: [] };
  const { stampData, skippedRooms } = toLiveBoardStampData(normalizeStandardizedStampScan(scan));
  assert(stampData['1305'] === undefined, '重複部屋は自動採用しない');
  assert(skippedRooms.some((s) => s.room_number === '1305' && s.reason === 'DUPLICATE_ROOM_NUMBER'), '重複として記録');
}

// --- entries配列を直接渡しても動く ---
{
  const { entries } = normalizeStandardizedStampScan({ rooms: [gridRoom('103', 'P')], time_designation_rows: [] });
  const { stampData } = toLiveBoardStampData(entries);
  assert(stampData['103'].symbol === 'P', '配列入力');
  assert(toLiveBoardStampEntry(entries[0]).room_number === '103', '単体変換');
}

console.log('toLiveBoardStampData.test.ts: ALL PASS');
