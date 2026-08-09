// review_edit_tracker.js 単体テスト。
'use strict';
var tracker = require('../review_edit_tracker.js');

function run() {
  var results = [];
  function check(label, cond, detail) {
    results.push({ label: label, ok: !!cond, detail: detail || '' });
    console.log((cond ? 'OK' : 'NG') + ': ' + label + (detail ? ' (' + detail + ')' : ''));
  }

  var room = {
    roomNumber: '1512',
    scheduleDay: 2,
    timePreference: { period: 'AM', time: '15:00', isRange: false, timeEnd: null, note: '' },
    memo: '',
    sourceMeta: { ocrConfidence: { roomNumber: 0.9 }, warnings: [] },
  };

  // ---- getFieldValue / setFieldValue ----
  check('ドット区切りパスで値を取得できる', tracker.getFieldValue(room, 'timePreference.period') === 'AM');
  var withSet = tracker.setFieldValue(room, 'timePreference.period', 'PM');
  check('ドット区切りパスへ値を設定した新オブジェクトを返す(元は不変)', withSet.timePreference.period === 'PM' && room.timePreference.period === 'AM');

  // ---- applyRoomFieldEdit ----
  var edited1 = tracker.applyRoomFieldEdit(room, 'timePreference.period', 'PM', '2026-07-26T01:00:00Z');
  check('applyRoomFieldEditで値が変更される', edited1.timePreference.period === 'PM');
  check('applyRoomFieldEditでreviewEditsに履歴が追加される', edited1.sourceMeta.reviewEdits.length === 1 &&
    edited1.sourceMeta.reviewEdits[0].field === 'timePreference.period' &&
    edited1.sourceMeta.reviewEdits[0].before === 'AM' &&
    edited1.sourceMeta.reviewEdits[0].after === 'PM', JSON.stringify(edited1.sourceMeta.reviewEdits));
  check('applyRoomFieldEditでeditedFieldsにフィールド名が追加される', edited1.sourceMeta.editedFields.indexOf('timePreference.period') !== -1);
  check('元のroomオブジェクトは変更されない(イミュータブル)', room.timePreference.period === 'AM' && room.sourceMeta.reviewEdits === undefined);

  // 値が変わらない場合は履歴を追加しない
  var edited2 = tracker.applyRoomFieldEdit(room, 'timePreference.period', 'AM', '2026-07-26T01:00:00Z');
  check('値が変化しない場合は履歴を追加しない(同一オブジェクトを返す)', edited2 === room);

  // ---- applyRoomEdits(複数フィールド一括) ----
  var patch = { roomNumber: '1512', scheduleDay: 1, 'timePreference.time': '09:00' };
  var editedMulti = tracker.applyRoomEdits(room, patch, '2026-07-26T02:00:00Z');
  check('複数フィールドをまとめて適用できる', editedMulti.scheduleDay === 1 && editedMulti.timePreference.time === '09:00');
  check('roomNumberが変化していない場合は履歴に追加されない', editedMulti.sourceMeta.reviewEdits.filter(function (e) { return e.field === 'roomNumber'; }).length === 0);
  check('scheduleDayとtimePreference.timeの2件だけ履歴に残る', editedMulti.sourceMeta.reviewEdits.length === 2, JSON.stringify(editedMulti.sourceMeta.reviewEdits));

  // ---- isFieldEdited ----
  check('editedFieldsに含まれるフィールドはisFieldEdited=true', tracker.isFieldEdited(editedMulti, 'scheduleDay') === true);
  check('編集していないフィールドはisFieldEdited=false', tracker.isFieldEdited(editedMulti, 'memo') === false);

  // ---- getReviewEdits ----
  check('getReviewEditsで履歴配列を取得できる', tracker.getReviewEdits(editedMulti).length === 2);
  check('reviewEditsが無い部屋は空配列を返す', tracker.getReviewEdits({}).length === 0);

  // ---- markRoomReviewed ----
  var reviewed1 = tracker.markRoomReviewed(room, '山田太郎', '2026-07-26T03:00:00Z');
  check('markRoomReviewedでreviewedBy/reviewedAtが設定される', reviewed1.sourceMeta.reviewedBy === '山田太郎' && reviewed1.sourceMeta.reviewedAt === '2026-07-26T03:00:00Z');

  var alreadyReviewed = { roomNumber: '999', sourceMeta: { reviewedBy: '最初の担当者', reviewedAt: '2026-01-01T00:00:00Z' } };
  var reviewed2 = tracker.markRoomReviewed(alreadyReviewed, '別の担当者', '2026-07-26T04:00:00Z');
  check('既にreviewedAtがある部屋は既定では上書きしない', reviewed2.sourceMeta.reviewedBy === '最初の担当者' && reviewed2 === alreadyReviewed);

  var reviewed3 = tracker.markRoomReviewed(alreadyReviewed, '別の担当者', '2026-07-26T04:00:00Z', { overwriteExisting: true });
  check('overwriteExisting:trueを指定すれば上書きできる', reviewed3.sourceMeta.reviewedBy === '別の担当者');

  var allOk = results.every(function (r) { return r.ok; });
  console.log('\n==== review_edit_tracker_test 総合結果: ' + (allOk ? 'PASS' : 'FAIL') + ' (' + results.filter(function (r) { return r.ok; }).length + '/' + results.length + ') ====');
  if (!allOk) process.exitCode = 1;
}

run();
