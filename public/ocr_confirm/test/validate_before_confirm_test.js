// validate_before_confirm.js 単体テスト。
'use strict';
var validate = require('../validate_before_confirm.js');

function baseFsdf(rooms, totalScheduleDays) {
  return { fsdfVersion: '1.2', property: { name: '物件A' }, inspection: { totalScheduleDays: totalScheduleDays || 2 }, rooms: rooms };
}

function run() {
  var results = [];
  function check(label, cond, detail) {
    results.push({ label: label, ok: !!cond, detail: detail || '' });
    console.log((cond ? 'OK' : 'NG') + ': ' + label + (detail ? ' (' + detail + ')' : ''));
  }

  // ---- 正常系: 問題なし ----
  var okFsdf = baseFsdf([{ roomNumber: '1512', scheduleDay: 2, timePreference: { period: 'PM', time: '13:00' }, sourceMeta: {} }]);
  var v0 = validate.validateBeforeConfirm(okFsdf);
  check('問題ない部屋のみの場合ok=true', v0.ok === true && v0.blockingIssues.length === 0, JSON.stringify(v0));

  // ---- 部屋番号が空 ----
  var emptyRoomFsdf = baseFsdf([{ roomNumber: '', scheduleDay: 1 }]);
  var v1 = validate.validateBeforeConfirm(emptyRoomFsdf);
  check('部屋番号が空はブロック', v1.ok === false && v1.blockingIssues.some(function (i) { return i.code === 'empty_room_number'; }));

  // ---- 部屋番号の重複 ----
  var dupFsdf = baseFsdf([{ roomNumber: '101', scheduleDay: 1 }, { roomNumber: '101', scheduleDay: 1 }]);
  var v2 = validate.validateBeforeConfirm(dupFsdf);
  check('部屋番号の重複はブロック', v2.ok === false && v2.blockingIssues.some(function (i) { return i.code === 'duplicate_room_number'; }));

  // ---- scheduleDayがtotalScheduleDaysの範囲外 ----
  var outOfRangeFsdf = baseFsdf([{ roomNumber: '101', scheduleDay: 5 }], 2);
  var v3 = validate.validateBeforeConfirm(outOfRangeFsdf);
  check('scheduleDayが範囲外はブロック', v3.ok === false && v3.blockingIssues.some(function (i) { return i.code === 'schedule_day_out_of_range'; }));

  // ---- AM/PMと時刻の矛盾 ----
  var amConflictFsdf = baseFsdf([{ roomNumber: '101', scheduleDay: 1, timePreference: { period: 'AM', time: '15:00' } }], 1);
  var v4 = validate.validateBeforeConfirm(amConflictFsdf);
  check('AMなのに15:00はブロック', v4.ok === false && v4.blockingIssues.some(function (i) { return i.code === 'am_pm_time_conflict'; }));

  var pmConflictFsdf = baseFsdf([{ roomNumber: '101', scheduleDay: 1, timePreference: { period: 'PM', time: '9:00' } }], 1);
  var v5 = validate.validateBeforeConfirm(pmConflictFsdf);
  check('PMなのに9:00はブロック', v5.ok === false && v5.blockingIssues.some(function (i) { return i.code === 'am_pm_time_conflict'; }));

  // ---- illegibleが未確認のまま ----
  var illegibleFsdf = baseFsdf([{ roomNumber: '101', scheduleDay: 1, sourceStatus: 'illegible', sourceMeta: {} }], 1);
  var v6 = validate.validateBeforeConfirm(illegibleFsdf);
  check('illegibleが未確認はブロック', v6.ok === false && v6.blockingIssues.some(function (i) { return i.code === 'illegible_unreviewed'; }));

  var v6ack = validate.validateBeforeConfirm(illegibleFsdf, { acknowledgedIllegibleRooms: ['101'] });
  check('illegibleでも明示的に確認済みとして渡せばブロックしない', v6ack.ok === true && v6ack.warnings.some(function (w) { return w.code === 'illegible_acknowledged'; }));

  // ---- illegibleでもすでにreviewedAtがあればブロックしない ----
  var illegibleReviewedFsdf = baseFsdf([{ roomNumber: '101', scheduleDay: 1, sourceStatus: 'illegible', sourceMeta: { reviewedAt: '2026-07-26T00:00:00Z', reviewedBy: 'x' } }], 1);
  var v7 = validate.validateBeforeConfirm(illegibleReviewedFsdf);
  check('illegibleでも既にreviewedAtがあればブロックしない', v7.ok === true);

  // ---- 重大warning(severity:error)が未解決 ----
  var errorWarnFsdf = baseFsdf([{ roomNumber: '101', scheduleDay: 1, sourceMeta: { warnings: [{ field: 'x', message: '重大', severity: 'error' }] } }], 1);
  var v8 = validate.validateBeforeConfirm(errorWarnFsdf);
  check('severity:errorのwarningが未解決はブロック', v8.ok === false && v8.blockingIssues.some(function (i) { return i.code === 'blocking_warning_unresolved'; }));

  var v8ack = validate.validateBeforeConfirm(errorWarnFsdf, { acknowledgedWarningRooms: ['101'] });
  check('severity:errorのwarningも明示確認すればブロックしない', v8ack.ok === true);

  // ---- 軽微なwarning(severity:warning)はブロックしないが一覧に含まれる ----
  var minorWarnFsdf = baseFsdf([{ roomNumber: '101', scheduleDay: 1, sourceMeta: { warnings: [{ field: 'x', message: '軽微', severity: 'warning' }] } }], 1);
  var v9 = validate.validateBeforeConfirm(minorWarnFsdf);
  check('軽微なwarningはブロックしない', v9.ok === true);
  check('軽微なwarningはwarnings一覧に含まれる', v9.warnings.some(function (w) { return w.code === 'room_warning'; }));

  var allOk = results.every(function (r) { return r.ok; });
  console.log('\n==== validate_before_confirm_test 総合結果: ' + (allOk ? 'PASS' : 'FAIL') + ' (' + results.filter(function (r) { return r.ok; }).length + '/' + results.length + ') ====');
  if (!allOk) process.exitCode = 1;
}

run();
