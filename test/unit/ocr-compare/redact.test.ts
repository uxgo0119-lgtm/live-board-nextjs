// [2026-08-05新設] lib/ocr-compare/redact.ts の単体テスト。
// 最重要方針9「氏名等の個人情報を無制限に保存しないでください」の担保:
// レポート出力時、既定(includeNames=false)では氏名の実テキストが一切残らないことを確認する。

import { redactRoomComparisonForReport } from '../../../lib/ocr-compare/redact';
import type { RoomFieldComparison } from '../../../lib/ocr-compare/types';

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error('FAIL: ' + msg);
  console.log('OK: ' + msg);
}

const SECRET_NAME = '山田太郎';

const sample: RoomFieldComparison = {
  room_number: '101',
  presentInGroundTruth: true,
  presentInOcrResult: true,
  isPhantomRoom: false,
  isMissingRoom: false,
  fieldMatches: { name: false },
  expected: { room_number: '101', symbol: 'A', time: '', time_end: '', note: '', name: SECRET_NAME, dateRaw: '' },
  actual: { room_number: '101', symbol: 'A', time: '', time_end: '', note: '', name: SECRET_NAME + '(OCR誤読)', dateRaw: '' },
};

// ---- 既定(includeNames=false): 氏名の実テキストは一切残らない ----
{
  const redacted = redactRoomComparisonForReport(sample, false);
  const serialized = JSON.stringify(redacted);
  assert(serialized.indexOf(SECRET_NAME) === -1, '【重要】既定では氏名の実テキストがレポート用オブジェクトに一切含まれない');
  assert(redacted.expected?.name !== SECRET_NAME, 'expected.nameは伏字化されている');
  assert(redacted.actual?.name !== SECRET_NAME + '(OCR誤読)', 'actual.nameは伏字化されている');
  // 氏名以外のフィールドは変更されない
  assert(redacted.expected?.symbol === 'A', '氏名以外のフィールド(symbol)は変更されない');
}

// ---- includeNames=true を明示した場合のみ、氏名がそのまま残る(開発者の明示的オプトイン) ----
{
  const notRedacted = redactRoomComparisonForReport(sample, true);
  assert(notRedacted.expected?.name === SECRET_NAME, '--include-names相当のオプトイン時は氏名がそのまま保持される');
}

// ---- 空欄の氏名は空欄のまま(空欄であることは個人情報ではないため伏字化しない) ----
{
  const blankNameSample: RoomFieldComparison = {
    ...sample,
    expected: { ...sample.expected!, name: '' },
  };
  const redacted = redactRoomComparisonForReport(blankNameSample, false);
  assert(redacted.expected?.name === '', '氏名が空欄の場合は空欄のまま(伏字マーカーを付けない)');
}

console.log('ALL PASS: ocr-compare/redact.test.ts');
