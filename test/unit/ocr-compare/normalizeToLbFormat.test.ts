// [2026-08-05新設] lib/ocr-compare/normalizeToLbFormat.ts の単体テスト。
// lb_tool/index.html の applyStampSingleOcrResult()/applyStampBulkResult() が実際に行う
// フィールド正規化(symbolは'A'|'P'|'キャンセル'以外は空文字化、symbolがあればtime/time_endは
// 強制的に空文字化、各文字列のtrim)と同じ結果になることを確認する。

import { normalizeOneEntry, normalizeToLbEntries } from '../../../lib/ocr-compare/normalizeToLbFormat';

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error('FAIL: ' + msg);
  console.log('OK: ' + msg);
}

// ---- 正常系: symbol='A'ならtime/time_endは空文字に丸められる ----
{
  const result = normalizeOneEntry({ room_number: '101', symbol: 'A', time: '09:00', time_end: '10:00', note: 'メモ', name: '山田', date: '25(土)' });
  assert(result.ok, 'symbol=Aの正常な項目は正規化に成功する');
  if (result.ok) {
    assert(result.entry.symbol === 'A', 'symbolはAのまま');
    assert(result.entry.time === '', "symbolがある場合、timeは強制的に空文字になる(lb_tool/index.htmlと同じ挙動)");
    assert(result.entry.time_end === '', 'symbolがある場合、time_endも強制的に空文字になる');
    assert(result.entry.dateRaw === '25(土)', '日付は原文のまま保持される(dateRaw)');
  }
}

// ---- 時間指定(symbol無し)の場合はtime/time_endがそのまま使われる ----
{
  const result = normalizeOneEntry({ room_number: '102', symbol: '', time: '13:00', time_end: '14:00', note: '', name: '', date: '' });
  assert(result.ok, '時間指定項目は正規化に成功する');
  if (result.ok) {
    assert(result.entry.time === '13:00', 'symbol無しの場合、timeはそのまま使われる');
    assert(result.entry.time_end === '14:00', 'symbol無しの場合、time_endはそのまま使われる');
  }
}

// ---- 不正なsymbol値は空文字に丸められる(想定外の値をAIが返した場合の防御) ----
{
  const result = normalizeOneEntry({ room_number: '103', symbol: 'PASS', time: '', time_end: '', note: '', name: '', date: '' });
  assert(result.ok, '不正なsymbolでも正規化自体は成功する');
  if (result.ok) {
    assert(result.entry.symbol === '', "'A'|'P'|'キャンセル'以外のsymbol値は空文字に丸められる(lb_tool/index.htmlと同じ挙動)");
  }
}

// ---- 部屋番号が読み取れない場合はエラーになる ----
{
  const result = normalizeOneEntry({ room_number: '', symbol: 'A', time: '', time_end: '', note: '', name: '', date: '' });
  assert(!result.ok, '部屋番号が空文字の項目はエラーになる');
}

// ---- 前後の空白がtrimされる ----
{
  const result = normalizeOneEntry({ room_number: '  205  ', symbol: '', time: ' 09:00 ', time_end: '', note: '  補足  ', name: '', date: '' });
  assert(result.ok, 'trim対象の項目も正規化に成功する');
  if (result.ok) {
    assert(result.entry.room_number === '205', '部屋番号の前後空白はtrimされる');
    assert(result.entry.time === '09:00', 'timeの前後空白はtrimされる');
    assert(result.entry.note === '補足', 'noteの前後空白はtrimされる');
  }
}

// ---- bulkモード: 部屋番号が読み取れない項目はスキップされ、他の項目は正規化される ----
{
  const result = normalizeToLbEntries(
    [
      { room_number: '301', symbol: 'P', time: '', time_end: '', note: '', name: '', date: '' },
      { room_number: '', symbol: 'A', time: '', time_end: '', note: '', name: '', date: '' },
      { room_number: '302', symbol: 'キャンセル', time: '', time_end: '', note: '', name: '', date: '' },
    ],
    'bulk'
  );
  assert(result.ok, 'bulkモードの正規化自体は成功する(個別項目のエラーはskippedへ)');
  if (result.ok) {
    assert(result.entries.length === 2, '部屋番号が読み取れない項目はスキップされ、残り2件が正規化される');
    assert(result.skipped.length === 1, 'スキップされた項目の理由が1件記録される');
  }
}

// ---- singleモードで配列が来たらエラー、bulkモードでオブジェクトが来たらエラー ----
{
  const singleWithArray = normalizeToLbEntries([{ room_number: '101' }], 'single');
  // singleモードではparsedをそのままnormalizeOneEntryに渡すため、配列はオブジェクトとして
  // room_numberを持たず失敗する。
  assert(!singleWithArray.ok || singleWithArray.entries.length === 0, 'singleモードに配列を渡した場合、期待通りには解釈されない');

  const bulkWithObject = normalizeToLbEntries({ room_number: '101' }, 'bulk');
  assert(!bulkWithObject.ok, 'bulkモードにオブジェクト(配列でない)を渡すとエラーになる');
}

console.log('ALL PASS: ocr-compare/normalizeToLbFormat.test.ts');
