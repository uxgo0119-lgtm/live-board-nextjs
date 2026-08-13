// [2026-08-11新設 実物検証フェーズ・一時検証スクリプト]
import { normalizeStandardizedStampScanResult } from './lib/ocr/standardizedStampSheet/normalizeStandardizedStamp';

type RawRoom = {
  room_number: string;
  raw_checkboxes: { a_checked: boolean; p_checked: boolean; cancel_checked: boolean };
  time_start_raw: string;
  time_end_raw: string;
  note_raw: string;
};

function room(num: string, symbol: 'A' | 'P' | 'C' | 'AP' | 'PC'): RawRoom {
  const a = symbol === 'A' || symbol === 'AP';
  const p = symbol === 'P' || symbol === 'AP' || symbol === 'PC';
  const c = symbol === 'C' || symbol === 'PC';
  return { room_number: num, raw_checkboxes: { a_checked: a, p_checked: p, cancel_checked: c }, time_start_raw: '', time_end_raw: '', note_raw: '' };
}

const rooms: RawRoom[] = [
  room('1403','A'),room('1402','A'),room('1401','A'),room('1305','P'),room('1304','P'),room('1303','A'),room('1302','P'),room('1301','C'),room('1205','P'),room('1204','A'),room('1203','A'),room('1202','A'),room('1201','P'),room('1105','P'),room('1104','C'),room('1103','P'),room('1101','A'),
  room('1005','PC'),room('1004','A'),room('1003','P'),room('1002','P'),room('1001','A'),room('905','P'),room('904','P'),room('903','A'),room('902','P'),room('901','P'),room('805','PC'),room('804','C'),room('803','C'),room('802','AP'),room('801','A'),room('705','P'),
  room('704','A'),room('703','P'),room('702','P'),room('701','A'),room('605','A'),room('604','P'),room('603','A'),room('602','A'),room('601','A'),room('505','A'),room('504','P'),room('503','A'),room('502','A'),room('501','P'),room('405','P'),room('404','P'),
  room('403','A'),room('402','A'),room('401','P'),room('305','P'),room('304','P'),room('303','A'),room('302','A'),room('301','A'),room('205','P'),room('204','C'),room('203','P'),room('202','C'),room('201','P'),room('105','A'),room('104','A'),room('103','P'),
];

function applyTime(list: RawRoom[], roomNum: string, start: string, end: string, note: string) {
  const r = list.find((x) => x.room_number === roomNum);
  if (!r) throw new Error('room not found: ' + roomNum);
  r.time_start_raw = start; r.time_end_raw = end; r.note_raw = note;
}
applyTime(rooms,'1305','14:00','','');
applyTime(rooms,'1101','9:30','','');
applyTime(rooms,'1001','10:00','11:30','');
applyTime(rooms,'801','9:30','','朝一');
applyTime(rooms,'705','13:00','14:00','');
applyTime(rooms,'603','10:00','','');
applyTime(rooms,'503','11:00','11:15','');

const { entries, skipped } = normalizeStandardizedStampScanResult(rooms);
console.log('input', rooms.length, 'normalized', entries.length, 'skipped', skipped.length);
for (const target of ['1003','405','802','801','1005','805']) {
  console.log(target, JSON.stringify(entries.find((x)=>x.room_number===target)));
}
let falsePositive = 0;
const expectMultiCheck = new Set(['1005','805','802']);
for (const e of entries) {
  if (expectMultiCheck.has(e.room_number) && e.resolved_symbol.state === 'auto_confirmed') falsePositive++;
}
console.log('falsePositive', falsePositive);
