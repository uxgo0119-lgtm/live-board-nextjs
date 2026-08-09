// lib/ocr-compare/redact.ts
//
// [2026-08-05新設] 最重要方針9「氏名等の個人情報を無制限に保存しないでください」への対応。
//
// 比較処理そのもの(一致/不一致の判定)は氏名の実際の文字列を使って行う必要があるため
// メモリ上では保持するが、ローカルファイルとして永続化するJSON/HTMLレポートには、
// 既定では氏名の実テキストを一切書き出さない(「一致した/しなかった」という判定結果のみを
// 残す)。サーバー側へのアップロードやDB保存は行わない設計(比較結果はローカルファイルの
// みに出力する、というlib/ocr-compare全体の設計)と合わせて、「無制限に保存しない」を
// 二重に担保している。
//
// 開発者がどうしても元の氏名を見て原因調査したい場合のみ、CLIに --include-names を
// 渡すことで明示的にオプトインできる(既定はオフ)。

import type { RoomFieldComparison } from './types';

const REDACTED_MARKER = '(伏字: --include-namesで表示)';

export function redactRoomComparisonForReport(rc: RoomFieldComparison, includeNames: boolean): RoomFieldComparison {
  if (includeNames) return rc;
  const redactValue = (value: string | undefined): string | undefined => (value ? REDACTED_MARKER : value);
  return {
    ...rc,
    expected: rc.expected ? { ...rc.expected, name: redactValue(rc.expected.name) } : null,
    actual: rc.actual ? { ...rc.actual, name: redactValue(rc.actual.name) } : null,
  };
}
