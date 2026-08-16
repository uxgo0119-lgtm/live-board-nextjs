// [2026-08-15新設 Phase 2 Level 1] 要確認理由を項目(記号/時刻/備考)へ振り分ける処理の単体テスト。
//
// 検証の主眼は「一部が要確認だからといって、他の項目まで要確認にしない」こと。
// これが崩れると、正しく読めた情報がLive Boardへ届かない旧来の全体ゲートに戻る。

import { classifyReviewReasons } from '../../../../lib/ocr/standardizedStampSheet/fieldReview';

function assert(cond: unknown, msg: string) { if (!cond) throw new Error('FAIL: ' + msg); }

{
  const r = classifyReviewReasons([]);
  assert(!r.symbol && !r.time && !r.note && !r.other, '理由が無ければどの項目も要確認にならない');
}
{
  const r = classifyReviewReasons(['SYMBOL:MULTIPLE_SYMBOL_CHECKED']);
  assert(r.symbol === true, '記号が要確認');
  assert(r.time === false && r.note === false, '記号の曖昧さで時刻・備考を巻き込まない');
}
{
  const r = classifyReviewReasons(['NOTE:NEEDS_REVIEW']);
  assert(r.note === true, '備考が要確認');
  assert(r.time === false && r.symbol === false, '備考の曖昧さで時刻・記号を巻き込まない');
}
{
  const r = classifyReviewReasons(['TIME_END:MISSING_CELL']);
  assert(r.time === true, '時刻が要確認');
  assert(r.note === false && r.symbol === false, '時刻の曖昧さで備考・記号を巻き込まない');
}
{
  const r = classifyReviewReasons(['TIME_START:ILLEGIBLE_DIGIT', 'NOTE:CANDIDATE']);
  assert(r.time === true && r.note === true, '複数の項目が同時に要確認になりうる');
  assert(r.symbol === false, '記号は確定のまま');
}
{
  // 時間指定行を部屋へ結び付けられなかったときは、内部理由が'|'で連結されて渡ってくる。
  const r = classifyReviewReasons(['TIME_DESIGNATION:ROOM_NUMBER_AMBIGUOUS|TIME_START:MISSING_CELL']);
  assert(r.time === true, '結合できなかった時間指定は時刻の要確認として扱う');
  assert(r.note === false, '備考は巻き込まない');
}
{
  // 内訳が備考だけなら、時刻は要確認にしない。
  const r = classifyReviewReasons(['TIME_DESIGNATION:REMARKS:NEEDS_REVIEW']);
  assert(r.note === true && r.time === false, '内訳が備考だけなら備考だけが要確認');
}
{
  const r = classifyReviewReasons(['ROOM_NUMBER:LEADING_ZERO', 'DUPLICATE_ROOM_NUMBER', 'PARSE_ISSUE:MALFORMED_CHECKBOX_VALUE']);
  assert(r.other === true, '項目に紐付かない理由はotherへ');
  assert(r.symbol === false && r.time === false && r.note === false, '項目単位の確定は保たれる');
}

console.log('fieldReview.test.ts: ALL PASS');
