import { matchAgainstDictionaries, _internal } from '../../../../lib/ocr/standardizedStampSheet/misreadDictionary';
function assert(cond: unknown, msg: string) { if (!cond) throw new Error('FAIL: ' + msg); }
{ const r = matchAgainstDictionaries('朝一'); assert(r.state === 'auto_correct' && r.normalizedCode === 'EARLY_MORNING', '朝一'); }
{ const r = matchAgainstDictionaries('朝イチ'); assert(r.state === 'auto_correct' && r.matchedVia === 'exact_alias', '朝イチ'); }
{ const r = matchAgainstDictionaries('都合一'); assert(r.state === 'candidate' && r.normalizedCode === 'EARLY_MORNING', '都合一 candidate'); }
{ const r = matchAgainstDictionaries('不左'); assert(r.state === 'needs_review' && r.riskLevel === 'high', '不在 near match high risk'); }
{ const r = matchAgainstDictionaries('キャソセル'); assert(r.state === 'needs_review' && r.riskLevel === 'high', 'cancel near match high risk'); }
{ const r = matchAgainstDictionaries('不在'); assert(r.state === 'auto_correct', '不在 exact'); }
{ const r = matchAgainstDictionaries('キャンセル'); assert(r.state === 'auto_correct', 'cancel exact'); }
{ const r = matchAgainstDictionaries('全く未知の備考文言123'); assert(r.state === 'needs_review' && r.canonical === null, 'unknown'); }
{ const r = matchAgainstDictionaries(''); assert(r.state === 'needs_review', 'blank'); }
assert(_internal.MISREAD_ENTRIES.length === 14, '14 misread entries');
assert(_internal.MISREAD_ENTRIES.filter((e) => e.risk_level === 'high').length === 2, '2 high risk');
console.log('misreadDictionary.test.ts: ALL PASS');
