import { parseGridTime, parseGridTimeCells, normalizeGridCells, blankGridTime } from '../../../../lib/ocr/standardizedStampSheet/gridTimeParser';

function assert(cond: unknown, msg: string) { if (!cond) throw new Error('FAIL: ' + msg); }

{ const r = parseGridTime('09:30'); assert(r.ok && r.value === '09:30', '09:30'); }
{ const r = parseGridTime('23:59'); assert(r.ok && r.value === '23:59', '23:59'); }
{ const r = parseGridTime('00:00'); assert(r.ok && r.value === '00:00', '00:00'); }
{ const r = parseGridTime(''); assert(r.ok === true && r.value === null, 'blank'); }
{ const r = parseGridTime('1?:00'); assert(r.ok === false && r.reason === 'ILLEGIBLE_DIGIT', 'illegible'); }
{ const r = parseGridTime('25:99'); assert(r.ok === false && r.reason === 'INVALID_FORMAT', 'invalid'); }
{ const r = parseGridTime('24:00'); assert(r.ok === false, '24:00 invalid'); }
{ const r = parseGridTime('9:0'); assert(r.ok === false && r.reason === 'INCOMPLETE', 'incomplete'); }
{ const r = parseGridTime('1?:00'); assert(r.raw === '1?:00', 'raw retained'); }

// --- [2026-08-13追加 実API検証フェーズ] マス単位の時刻読み取り ---
// 実APIが「時」の十の位の空マスを勝手に0で埋めて "09:30" と返した回帰(1101号室・801号室)。
{ const r = parseGridTimeCells(['', '9', '3', '0']);
  assert(r.ok === false && r.reason === 'MISSING_CELL', '空マスは0補完せずMISSING_CELL');
  assert(r.value === null, '空マスがあるとき値を確定しない');
  assert(r.raw === '?9:30', '空マスは?として可視化'); }
{ const r = parseGridTimeCells(['0', '9', '3', '0']); assert(r.ok && r.value === '09:30', '4マス揃えば確定'); }
{ const r = parseGridTimeCells(['1', '3', '0', '0']); assert(r.ok && r.value === '13:00', '13:00'); }
{ const r = parseGridTimeCells(['', '', '', '']); assert(r.ok === true && r.value === null && r.raw === '', '全マス空欄は記入なし'); }
{ const r = parseGridTimeCells(['1', '?', '0', '0']); assert(r.ok === false && r.reason === 'ILLEGIBLE_DIGIT', '判読不能マス'); }
{ const r = parseGridTimeCells(['2', '5', '9', '9']); assert(r.ok === false && r.reason === 'INVALID_FORMAT', '時刻として不正'); }
{ const r = parseGridTimeCells(['1', '0', '0']); assert(r.ok === false && r.reason === 'INCOMPLETE', 'マス数不足'); }
{ const r = parseGridTimeCells('09:30'); assert(r.ok === false && r.reason === 'CELL_DATA_UNAVAILABLE', '文字列だけでは確定できない'); }
{ const r = parseGridTimeCells(undefined); assert(r.ok === false && r.reason === 'CELL_DATA_UNAVAILABLE', 'マス情報なし'); }
{ const r = parseGridTimeCells(['09', '3', '0', '']); assert(r.ok === false, '1マスに2文字は確定しない'); }
{ const r = parseGridTimeCells(['', '9', '3', '0']); assert(Array.isArray(r.cells) && r.cells[0] === '', 'マス情報を保持する'); }
{ const r = blankGridTime(); assert(r.ok === true && r.value === null && r.cells === null, '記入なしの既定値'); }
{ const n = normalizeGridCells(['1', null, '0', '0'], 4); assert(n.cells !== null && n.cells[1] === '', 'nullは空マス'); }
{ const n = normalizeGridCells(['1', '0'], 4); assert(n.malformed === true, 'マス数不一致はmalformed'); }

// [2026-08-13追加] 実APIが区切り記号':'を1マスとして返してくるケース(実測)。
// ':'は帳票の印字であってマスではないため除外する。除外の結果として桁が足りなければ確定しない。
{ const r = parseGridTimeCells(['', '', ':', '']); assert(r.ok === true && r.value === null && r.raw === '', '空欄+区切りは記入なし'); }
{ const r = parseGridTimeCells(['9', ':', '3', '0']); assert(r.ok === false && r.value === null, '区切り除外後3マスなら確定しない'); }
{ const r = parseGridTimeCells(['1', '0', ':', '0', '0']); assert(r.ok && r.value === '10:00', '5要素でも区切りを除けば10:00'); }
{ const r = parseGridTimeCells(['', '', ' ', '']); assert(r.ok === true && r.value === null, '空白だけのマスは空欄扱い'); }
{ const r = parseGridTimeCells(['1', '4', '0', '0']); assert(r.ok && r.value === '14:00', '区切り無しの通常形は従来どおり'); }

console.log('gridTimeParser.test.ts: ALL PASS');
