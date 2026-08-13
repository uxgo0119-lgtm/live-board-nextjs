import { normalizeStandardizedStampEntry, normalizeStandardizedStampScanResult } from '../../../../lib/ocr/standardizedStampSheet/normalizeStandardizedStamp';
import type { StandardizedStampRawEntry } from '../../../../lib/ocr/standardizedStampSheet/types';
function assert(cond: unknown, msg: string) { if (!cond) throw new Error('FAIL: ' + msg); }
function makeRaw(overrides: Partial<StandardizedStampRawEntry> = {}): StandardizedStampRawEntry {
  return { room_number:'101', raw_checkboxes:{a_checked:false,p_checked:false,cancel_checked:false}, time_start_raw:'', time_end_raw:'', note_raw:'', ...overrides };
}
{
  const entry = normalizeStandardizedStampEntry(makeRaw({raw_checkboxes:{a_checked:true,p_checked:false,cancel_checked:false},time_start_raw:'13:00',time_end_raw:'14:00'}));
  assert(entry.resolved_symbol.value === 'A','A'); assert(entry.time_start.value === '13:00','time retained'); assert(entry.time_end.value === '14:00','end retained');
}
{
  const entry = normalizeStandardizedStampEntry(makeRaw({room_number:'1003',raw_checkboxes:{a_checked:false,p_checked:true,cancel_checked:false}}));
  assert(entry.resolved_symbol.value === 'P' && entry.needsReview === false,'1003 P');
}
{
  const entry = normalizeStandardizedStampEntry(makeRaw({room_number:'802',raw_checkboxes:{a_checked:true,p_checked:true,cancel_checked:false}}));
  assert(entry.resolved_symbol.value === '' && entry.needsReview === true,'802 review');
  assert(entry.needsReviewReasons.some((r)=>r.includes('MULTIPLE_SYMBOL_CHECKED')),'802 reason');
}
{
  const entry = normalizeStandardizedStampEntry(makeRaw({room_number:'801',note_raw:'都合一'}));
  assert(entry.note_raw === '都合一' && entry.note_misread_match.state === 'candidate' && entry.needsReview === true,'801 note candidate');
}
{
  const entry = normalizeStandardizedStampEntry(makeRaw({time_start_raw:'1?:00'}));
  assert(entry.needsReview === true && entry.needsReviewReasons.some((r)=>r.startsWith('TIME_START:')),'time review');
}
{
  const rooms: unknown[] = [
    {room_number:'101',raw_checkboxes:{a_checked:true,p_checked:false,cancel_checked:false},time_start_raw:'',time_end_raw:'',note_raw:''},
    {room_number:'802',raw_checkboxes:{a_checked:true,p_checked:true,cancel_checked:false},time_start_raw:'',time_end_raw:'',note_raw:''},
    {room_number:'',raw_checkboxes:{a_checked:false,p_checked:false,cancel_checked:false},time_start_raw:'',time_end_raw:'',note_raw:''}
  ];
  const {entries,skipped}=normalizeStandardizedStampScanResult(rooms); assert(entries.length===2 && skipped.length===1,'scan normalize');
}
{
  const {entries}=normalizeStandardizedStampScanResult([{room_number:'999',raw_checkboxes:{a_checked:'true',p_checked:false,cancel_checked:false},time_start_raw:'',time_end_raw:'',note_raw:''}]);
  assert(entries[0].needsReview===true && entries[0].needsReviewReasons.some((r)=>r.includes('MALFORMED_CHECKBOX_VALUE')),'malformed checkbox review');
}
console.log('normalizeStandardizedStamp.test.ts: ALL PASS');
