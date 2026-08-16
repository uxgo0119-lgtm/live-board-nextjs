// [2026-08-15新設 Phase 3 複数物件一括OCR検証基盤]
// 登録済みの全物件ケースを、実OCR raw → normalize → Canonical → 保存 → 復元 → LB描画 まで
// 一括で通し、「最初に値が壊れた段階」が増えていないことを回帰として固定する。
//
// 【このテストが守るもの】
// - OCR_FAIL / NORMALIZE_FAIL / PERSIST_FAIL / RENDER_FAIL がすべて0件であること
//
// 【2026-08-16改訂】
// 初回実行で判明していた唯一の未修正欠陥「確定した記号『キャンセル』が部屋カードに一切
// 描画されない」(壊れる段階はrenderに確定済み)を index.html 側で修正したため、既知例外を
// 廃止して RENDER_FAIL も0件固定にした。以後は描画欠陥が1件でも出れば落ちる。
// 詳細: docs/FireFlow_StampBatchValidation_Phase3_2026-08-15.md

import { runBatchValidation } from '../../../batch/runBatchValidation';

function assert(cond: unknown, msg: string) { if (!cond) throw new Error('FAIL: ' + msg); }

async function main() {
  const report = await runBatchValidation();

  assert(report.cases.length >= 1, '検証ケースが1件以上登録されている');

  report.cases.forEach((c) => {
    assert(!c.preconditionError, c.caseId + ': 前提(MASTER室数)が崩れていない — ' + c.preconditionError);

    // 評価対象が実際に計測されていること(件数が取れていなければ検証基盤として機能しない)。
    assert(c.counts.masterRooms > 0, c.caseId + ': MASTER室数を計測している');
    assert(c.counts.rawRooms > 0, c.caseId + ': OCR対象室数を計測している');
    assert(c.counts.canonicalRooms > 0, c.caseId + ': Canonicalの室数を計測している');
    assert(c.counts.restoredRooms > 0, c.caseId + ': 復元した室数を計測している');
    assert(c.counts.renderedCards > 0, c.caseId + ': 描画された部屋カード数を計測している');
    assert(c.counts.groundTruthRooms > 0, c.caseId + ': Ground Truthのある部屋がある');
    assert(c.counts.checkedFields > 0, c.caseId + ': 判定項目が1つ以上ある');

    assert(c.failures.OCR_FAIL === 0, c.caseId + ': OCR_FAIL=0 (got ' + c.failures.OCR_FAIL + ')');
    assert(c.failures.NORMALIZE_FAIL === 0, c.caseId + ': NORMALIZE_FAIL=0 (got ' + c.failures.NORMALIZE_FAIL + ')');
    assert(c.failures.PERSIST_FAIL === 0, c.caseId + ': PERSIST_FAIL=0 (got ' + c.failures.PERSIST_FAIL + ')');

    c.findings.filter((f) => f.kind === 'RENDER_FAIL').forEach((f) => {
      assert(false, c.caseId + ': 描画欠陥が出ている — '
        + f.room + ' ' + f.field + ' 期待=' + f.expected + ' canonical=' + f.canonical + ' render=' + f.render + ' / ' + f.detail);
    });
    assert(c.failures.RENDER_FAIL === 0, c.caseId + ': RENDER_FAIL=0 (got ' + c.failures.RENDER_FAIL + ')');
  });

  console.log('batchValidation.test.ts: ' + report.cases.length + '件の物件ケースを一括検証 '
    + '(OCR_FAIL=' + report.totals.OCR_FAIL + ' NORMALIZE_FAIL=' + report.totals.NORMALIZE_FAIL
    + ' PERSIST_FAIL=' + report.totals.PERSIST_FAIL + ' RENDER_FAIL=' + report.totals.RENDER_FAIL + ')');
  console.log('batchValidation.test.ts: ALL PASS');
}

main().catch((err) => { console.error(err); process.exit(1); });
