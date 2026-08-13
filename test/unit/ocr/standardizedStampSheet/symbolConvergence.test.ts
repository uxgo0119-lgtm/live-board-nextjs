import { convergeSymbol } from '../../../../lib/ocr/standardizedStampSheet/symbolConvergence';
function assert(cond: unknown, msg: string) { if (!cond) throw new Error('FAIL: ' + msg); }
{ const r = convergeSymbol({ a_checked:false,p_checked:false,cancel_checked:false }); assert(r.value === '' && r.state === 'auto_confirmed','0'); }
{ const r = convergeSymbol({ a_checked:true,p_checked:false,cancel_checked:false }); assert(r.value === 'A' && r.state === 'auto_confirmed','A'); }
{ const r = convergeSymbol({ a_checked:false,p_checked:true,cancel_checked:false }); assert(r.value === 'P' && r.state === 'auto_confirmed','P'); }
{ const r = convergeSymbol({ a_checked:false,p_checked:false,cancel_checked:true }); assert(r.value === 'キャンセル' && r.state === 'auto_confirmed','cancel'); }
{ const r = convergeSymbol({ a_checked:true,p_checked:true,cancel_checked:false }); assert(r.value === '' && r.state === 'needs_review' && r.reason === 'MULTIPLE_SYMBOL_CHECKED','A+P'); }
{ const r = convergeSymbol({ a_checked:true,p_checked:false,cancel_checked:true }); assert(r.state === 'needs_review','A+cancel'); }
{ const r = convergeSymbol({ a_checked:false,p_checked:true,cancel_checked:true }); assert(r.state === 'needs_review','P+cancel'); }
{ const r = convergeSymbol({ a_checked:true,p_checked:true,cancel_checked:true }); assert(r.state === 'needs_review','all'); }
{ const r = convergeSymbol({ a_checked:true,p_checked:false,cancel_checked:false },{confidenceHint:0.3,confidenceThreshold:0.8}); assert(r.state === 'needs_review' && r.reason === 'LOW_CONFIDENCE','low confidence'); }
{ const r = convergeSymbol({ a_checked:true,p_checked:false,cancel_checked:false },{confidenceHint:0.95,confidenceThreshold:0.8}); assert(r.value === 'A' && r.state === 'auto_confirmed','high confidence'); }
console.log('symbolConvergence.test.ts: ALL PASS');
