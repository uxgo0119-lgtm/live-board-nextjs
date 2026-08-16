// lib/ocr/standardizedStampSheet/fieldReview.ts
//
// [2026-08-15新設 Phase 2: 項目単位の確定]
// 「要確認」を、部屋単位の1つのフラグではなく、項目(記号 / 時刻 / 備考)単位で表現する。
//
// 【なぜ必要か】
// 従来 needsReviewReasons は文字列の配列で、部屋としての needs_review は「理由が1つでも
// あるか」でしか表現できなかった。そのため後段(保存・復元・描画・運用判断)からは、
//   「801は時刻9:30が明確に読めていて、曖昧なのは備考だけ」
// という区別が付かず、「怪しい部屋」としてまとめて扱うしかなかった。
// これは FireFlow の最優先原則
//   ・誤確定は防ぐ
//   ・しかし正しく読めた情報は絶対に途中で捨てない
// のうち後半を守れない構造であり、「備考が怪しいから時刻まで無効にする」という全体ゲートを
// 生みやすい。ここで理由を項目へ割り当て、項目単位で確定/要確認を持ち回れるようにする。
//
// 【この関数がしないこと】
// 値の判定はしない。確定できたかどうかは既に上流(記号収束・時刻マス解析・辞書一致)で
// 決まっており、ここはその結果として積まれた理由文字列を項目へ振り分けるだけである。

export type StampFieldReview = {
  // 記号(A/P/キャンセル)が確定できていない
  symbol: boolean;
  // 開始時刻・終了時刻のいずれかが確定できていない
  time: boolean;
  // 備考が確定できていない(辞書一致しなかった/誤読候補だった)
  note: boolean;
  // 項目に紐付かない理由(部屋番号の桁・重複行・解析エラーなど)
  other: boolean;
};

// 理由文字列の接頭辞と、それが指す項目の対応。ここが唯一の対応表。
const SYMBOL_PREFIXES = ['SYMBOL:'];
const TIME_PREFIXES = ['TIME_START:', 'TIME_END:'];
const NOTE_PREFIXES = ['NOTE:', 'REMARKS:'];

// 時間指定行を部屋へ結合できなかったときの理由は、内部理由を'|'で連結して
// 'TIME_DESIGNATION:<内部理由>|<内部理由>' の形で積まれる。内部理由には時刻由来のものも
// 備考由来のものも混ざるため、接頭辞を外して1つずつ再分類する。
const TIME_DESIGNATION_PREFIX = 'TIME_DESIGNATION:';

function startsWithAny(reason: string, prefixes: string[]): boolean {
  return prefixes.some((p) => reason.startsWith(p));
}

function applyReason(reason: string, review: StampFieldReview): void {
  if (startsWithAny(reason, SYMBOL_PREFIXES)) {
    review.symbol = true;
    return;
  }
  if (startsWithAny(reason, TIME_PREFIXES)) {
    review.time = true;
    return;
  }
  if (startsWithAny(reason, NOTE_PREFIXES)) {
    review.note = true;
    return;
  }
  if (reason.startsWith(TIME_DESIGNATION_PREFIX)) {
    const inner = reason.slice(TIME_DESIGNATION_PREFIX.length).split('|').filter((x) => x !== '');
    if (inner.length === 0) {
      // 内訳が無い場合は、時間指定そのものが結び付けられなかったという意味なので時刻として扱う。
      review.time = true;
      return;
    }
    // 内訳のうち備考由来のものは備考へ、それ以外(部屋番号・行位置・時刻)は時刻の確定を
    // 妨げた理由なので時刻へ寄せる。備考だけが理由なら時刻は要確認にしない。
    for (const innerReason of inner) {
      if (startsWithAny(innerReason, NOTE_PREFIXES)) review.note = true;
      else review.time = true;
    }
    return;
  }
  review.other = true;
}

/** 積まれた要確認理由を、項目(記号/時刻/備考/その他)へ振り分ける。 */
export function classifyReviewReasons(reasons: readonly string[]): StampFieldReview {
  const review: StampFieldReview = { symbol: false, time: false, note: false, other: false };
  for (const reason of reasons) {
    if (!reason) continue;
    applyReason(reason, review);
  }
  return review;
}
