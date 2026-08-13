import { parseGridTime } from '../../../../lib/ocr/standardizedStampSheet/gridTimeParser';

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

console.log('gridTimeParser.test.ts: ALL PASS');
