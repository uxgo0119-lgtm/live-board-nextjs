import { normalizeStandardizedStampEntry, normalizeStandardizedStampScanResult, normalizeStandardizedStampScan } from '../../../../lib/ocr/standardizedStampSheet/normalizeStandardizedStamp';
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
// --- [2026-08-13追加 実API検証フェーズ] 新経路 normalizeStandardizedStampScan ---
{
  // 記号の既存正解が維持されること(1003=P / 405=P / 802=A+P / 1005=P+キャンセル / 805=P+キャンセル)。
  const rooms = [
    {room_number:'1003',raw_checkboxes:{a_checked:false,p_checked:true,cancel_checked:false}},
    {room_number:'405',raw_checkboxes:{a_checked:false,p_checked:true,cancel_checked:false}},
    {room_number:'802',raw_checkboxes:{a_checked:true,p_checked:true,cancel_checked:false}},
    {room_number:'1005',raw_checkboxes:{a_checked:false,p_checked:true,cancel_checked:true}},
    {room_number:'805',raw_checkboxes:{a_checked:false,p_checked:true,cancel_checked:true}},
  ];
  const {entries}=normalizeStandardizedStampScan({rooms,time_designation_rows:[]});
  const get=(n:string)=>entries.find((e)=>e.room_number===n)!;
  assert(get('1003').resolved_symbol.value==='P' && get('1003').needsReview===false,'1003=P');
  assert(get('405').resolved_symbol.value==='P' && get('405').needsReview===false,'405=P');
  assert(get('802').resolved_symbol.state==='needs_review' && get('802').resolved_symbol.reason==='MULTIPLE_SYMBOL_CHECKED','802 review');
  assert(get('1005').resolved_symbol.state==='needs_review','1005 review');
  assert(get('805').resolved_symbol.state==='needs_review','805 review');
}
{
  // 先頭0埋めされたroom_numberは確定しない(実APIで "0801" 等を観測)。
  const {entries}=normalizeStandardizedStampScan({rooms:[{room_number:'0905',raw_checkboxes:{a_checked:false,p_checked:true,cancel_checked:false}}],time_designation_rows:[]});
  assert(entries[0].room_number==='0905','room_numberは書き換えない');
  assert(entries[0].needsReview===true && entries[0].needsReviewReasons.includes('ROOM_NUMBER:LEADING_ZERO'),'0埋めは要確認');
}
{
  // 同一room_numberが2行(実APIで1305が2行返ってきた回帰)。片方を自動採用しない。
  const {entries,duplicateRoomNumbers}=normalizeStandardizedStampScan({rooms:[
    {room_number:'1305',raw_checkboxes:{a_checked:false,p_checked:true,cancel_checked:false}},
    {room_number:'1305',raw_checkboxes:{a_checked:false,p_checked:true,cancel_checked:false}},
  ],time_designation_rows:[]});
  assert(entries.length===2,'両方残す');
  assert(entries.every((e)=>e.needsReview===true && e.needsReviewReasons.includes('DUPLICATE_ROOM_NUMBER')),'重複は要確認');
  assert(duplicateRoomNumbers.includes('1305'),'重複一覧');
}
{
  // 表記だけ違う重複("905"と"0905")も同一部屋の二重出力として扱う。
  const {entries}=normalizeStandardizedStampScan({rooms:[
    {room_number:'905',raw_checkboxes:{a_checked:true,p_checked:false,cancel_checked:false}},
    {room_number:'0905',raw_checkboxes:{a_checked:false,p_checked:true,cancel_checked:false}},
  ],time_designation_rows:[]});
  assert(entries.every((e)=>e.needsReview===true),'表記違いの重複も要確認');
}
{
  // 新経路では本体グリッド行に時刻が来ても採用しない。
  const {entries}=normalizeStandardizedStampScan({rooms:[
    {room_number:'1002',raw_checkboxes:{a_checked:false,p_checked:true,cancel_checked:false},time_start_raw:'10:00',time_end_raw:'11:30'},
  ],time_designation_rows:[]});
  assert(entries[0].time_start.value===null,'インラインの時刻は採用しない');
  assert(entries[0].needsReviewReasons.includes('UNEXPECTED_INLINE_TIME'),'想定外として記録');
}
{
  // 時間指定エリアが返らなかった場合、記号は確定できるが時刻は入らない。
  const {entries,timeDesignationRows}=normalizeStandardizedStampScan({rooms:[
    {room_number:'103',raw_checkboxes:{a_checked:false,p_checked:true,cancel_checked:false}},
  ]});
  assert(entries[0].resolved_symbol.value==='P' && entries[0].needsReview===false,'記号は確定');
  assert(timeDesignationRows.length===0 && entries[0].time_start.value===null,'時刻は空のまま');
}
{
  // 空のroom_numberはskippedのまま(既存挙動)。
  const {entries,skipped}=normalizeStandardizedStampScan({rooms:[
    {room_number:'',raw_checkboxes:{a_checked:false,p_checked:false,cancel_checked:false}},
  ],time_designation_rows:[]});
  assert(entries.length===0 && skipped.length===1,'空room_numberはskip');
}

console.log('normalizeStandardizedStamp.test.ts: ALL PASS');
