// [2026-08-15改訂 Phase 2] 文字列だけを見る parseGridTime() の削除に伴い、そのケースを削除した。
// 時刻の確定はマス単位の parseGridTimeCells() のみを通る(空マスの0補完を検知するため)。
// 有効/無効な時刻値の判定は、以下のマス単位ケースが同じ範囲を覆っている。
import { parseGridTimeCells, normalizeGridCells, blankGridTime } from '../../../../lib/ocr/standardizedStampSheet/gridTimeParser';

function assert(cond: unknown, msg: string) { if (!cond) throw new Error('FAIL: ' + msg); }

// 時刻として無効な値は、マスが全て埋まっていても確定しない。
{ const r = parseGridTimeCells(['2', '5', '9', '9']); assert(r.ok === false && r.reason === 'INVALID_FORMAT', '25:99は無効'); }
{ const r = parseGridTimeCells(['2', '4', '0', '0']); assert(r.ok === false && r.reason === 'INVALID_FORMAT', '24:00は無効'); }
{ const r = parseGridTimeCells(['2', '3', '5', '9']); assert(r.ok && r.value === '23:59', '23:59は有効'); }
{ const r = parseGridTimeCells(['0', '0', '0', '0']); assert(r.ok && r.value === '00:00', '00:00は有効'); }

// --- [2026-08-13追加 実API検証フェーズ] マス単位の時刻読み取り ---
// 実APIが「時」の十の位の空マスを勝手に0で埋めて "09:30" と返した回帰(1101号室・801号室)。
{ const r = parseGridTimeCells(['0', '9', '3', '0']); assert(r.ok && r.value === '09:30', '4マス揃えば確定'); }

// [2026-08-14更新 最小修正 / 実画像1枚の実API検証で一般化] 1桁の「時」の確定。
// 「時」欄2マスのうち片方だけが空欄+もう片方が数字、かつ「分」欄2マスが両方数字なら確定する。
// 実データでは同じ「9:30」の記入でも、801号室は ['','9','3','0']、1101号室は ['9','','3','0']
// と、数字がどちらのマスに入るかがブレて返ってきた(どちらも紙面は9:30)。
{ const r = parseGridTimeCells(['', '9', '3', '0']);
  assert(r.ok === true && r.value === '09:30', '時の十の位が空欄なら09:30として確定する');
  assert(r.raw === '?9:30', '監査用のrawは補完前のまま(?9:30)を保持する');
  assert(Array.isArray(r.cells) && r.cells[0] === '', 'cellsは補完前の生マスを保持する'); }
{ const r = parseGridTimeCells(['9', '', '3', '0']);
  assert(r.ok === true && r.value === '09:30', '時の一の位側が空欄でも同じ09:30として確定する');
  assert(r.raw === '9?:30', '監査用のrawは補完前のまま(9?:30)を保持する');
  assert(Array.isArray(r.cells) && r.cells[1] === '', 'cellsは補完前の生マスを保持する'); }
{ const r = parseGridTimeCells(['1', '', '3', '0']); assert(r.ok === true && r.value === '01:30', '1桁時であれば9以外でも同じ規則で確定する'); }
// 「分」欄に空欄がある場合は、従来通りMISSING_CELLのまま(分は常に2桁で記入されるため)。
{ const r = parseGridTimeCells(['0', '9', '', '0']); assert(r.ok === false && r.reason === 'MISSING_CELL', '分十の位が空欄はMISSING_CELL'); }
{ const r = parseGridTimeCells(['0', '9', '3', '']); assert(r.ok === false && r.reason === 'MISSING_CELL', '分一の位が空欄はMISSING_CELL'); }
// 「時」欄が両方空欄(=時が読めていない)の場合も、従来通りMISSING_CELLのまま。
{ const r = parseGridTimeCells(['', '', '3', '0']); assert(r.ok === false && r.reason === 'MISSING_CELL', '時が両マスとも空欄はMISSING_CELL(桁を作らない)'); }
// 時が1桁でも、分側に欠損があれば確定しない。
{ const r = parseGridTimeCells(['', '9', '', '0']); assert(r.ok === false && r.reason === 'MISSING_CELL', '時1桁+分欠損はMISSING_CELL'); }
{ const r = parseGridTimeCells(['9', '', '3', '']); assert(r.ok === false && r.reason === 'MISSING_CELL', '空欄マスの位置が逆でも分欠損はMISSING_CELL'); }
// 時が1桁でも、他マスに判読不能('?')があれば確定しない。
{ const r = parseGridTimeCells(['', '9', '?', '0']); assert(r.ok === false && r.reason === 'ILLEGIBLE_DIGIT', '時十の位空欄でも他マスに判読不能があればILLEGIBLE_DIGIT優先'); }
{ const r = parseGridTimeCells(['9', '', '?', '0']); assert(r.ok === false && r.reason === 'ILLEGIBLE_DIGIT', '空欄マスの位置が逆でも判読不能があれば確定しない'); }
// 補完後に時刻として不正なら確定しない(分が60以上等)。
{ const r = parseGridTimeCells(['9', '', '7', '0']); assert(r.ok === false && r.reason === 'INVALID_FORMAT', '分が不正なら1桁時でも確定しない'); }
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
{ const r = parseGridTimeCells(['1', '0', ':', '0', '0']); assert(r.ok && r.value === '10:00', '5要素でも区切りを除けば10:00'); }

// [2026-08-15更新 Phase 2 実LB最終確認] 区切り記号を「マスの境界」として使う。
// 2026-08-13時点では ['9',':','3','0'] を「区切り除外後3マスなので桁数不足」として確定
// させていなかったが、当時はまだ1桁の「時」を確定する規則自体が無かった(2026-08-14に追加)。
// ':'は「時」欄と「分」欄の間の印字であり、その前後で分ければ「時が1マス・分が2マス」と
// 位置として確定する。これは ['9','','3','0'] を09:30として確定するのと同じ構造の解釈で、
// 実LB最終確認で1101号室の09:30が欠落した経路がここ。
{ const r = parseGridTimeCells(['9', ':', '3', '0']);
  assert(r.ok === true && r.value === '09:30', '区切りの前が1マスなら1桁の「時」として09:30で確定する');
  assert(r.raw === '9:30', '監査用のrawはモデルが返した並びのまま保持する'); }
{ const r = parseGridTimeCells(['', '9', ':', '3', '0']); assert(r.ok === true && r.value === '09:30', '時欄の空マス+区切りでも09:30'); }
{ const r = parseGridTimeCells(['1', '3', ':', '0', '0']); assert(r.ok === true && r.value === '13:00', '区切りの前が2マスなら2桁の「時」'); }
// 分側に欠損・判読不能があれば、区切りがあっても確定しない(桁を推測で作らない)。
{ const r = parseGridTimeCells(['9', ':', '3', '']); assert(r.ok === false, '分が欠けていれば区切りがあっても確定しない'); }
{ const r = parseGridTimeCells(['9', ':', '?', '0']); assert(r.ok === false && r.reason === 'ILLEGIBLE_DIGIT', '判読不能マスがあれば確定しない'); }
{ const r = parseGridTimeCells([':', '3', '0']); assert(r.ok === false, '時が1マスも無ければ確定しない'); }
{ const r = parseGridTimeCells(['9', ':', '7', '0']); assert(r.ok === false && r.reason === 'INVALID_FORMAT', '分が不正なら確定しない'); }
{ const r = parseGridTimeCells(['9', ':', '3', '0', ':', '0']); assert(r.ok === false, '区切りが2つある形は確定しない'); }
{ const r = parseGridTimeCells(['9', ':', '3', '0', '0']); assert(r.ok === false, '分が3マスある形は確定しない'); }
{ const r = parseGridTimeCells(['', '', ' ', '']); assert(r.ok === true && r.value === null, '空白だけのマスは空欄扱い'); }
{ const r = parseGridTimeCells(['1', '4', '0', '0']); assert(r.ok && r.value === '14:00', '区切り無しの通常形は従来どおり'); }

console.log('gridTimeParser.test.ts: ALL PASS');
