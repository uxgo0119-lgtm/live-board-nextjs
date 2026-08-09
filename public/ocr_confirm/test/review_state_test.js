// review_state.js 単体テスト。
'use strict';
var assert = require('assert');
var rs = require('../review_state.js');

function run() {
  var results = [];
  function check(label, cond, detail) {
    results.push({ label: label, ok: !!cond, detail: detail || '' });
    console.log((cond ? 'OK' : 'NG') + ': ' + label + (detail ? ' (' + detail + ')' : ''));
  }

  // ---- 信頼度閾値 ----
  var fakeStorage = (function () {
    var store = {};
    return { getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; }, setItem: function (k, v) { store[k] = v; } };
  })();
  check('デフォルト閾値は0.85', rs.getConfidenceThreshold({ getItem: function () { return null; } }) === 0.85);
  rs.setConfidenceThreshold(0.6, fakeStorage);
  check('設定した閾値が取得できる', rs.getConfidenceThreshold(fakeStorage) === 0.6);
  var threwOnInvalid = false;
  try { rs.setConfidenceThreshold(1.5, fakeStorage); } catch (e) { threwOnInvalid = true; }
  check('範囲外(1.5)を設定しようとするとエラー', threwOnInvalid);

  // ---- minConfidence ----
  check('ocrConfidenceが無い場合はnull', rs.minConfidence({}) === null);
  check('複数フィールドのうち最小値を返す', rs.minConfidence({ sourceMeta: { ocrConfidence: { a: 0.9, b: 0.5, c: 0.8 } } }) === 0.5);

  // ---- hasWarnings / hasErrorSeverityWarning ----
  check('warningsが無い場合false', rs.hasWarnings({}) === false);
  check('warningsがある場合true', rs.hasWarnings({ sourceMeta: { warnings: [{ field: 'x', message: 'm' }] } }) === true);
  check('severity:errorのwarningを検出', rs.hasErrorSeverityWarning({ sourceMeta: { warnings: [{ field: 'x', message: 'm', severity: 'error' }] } }) === true);
  check('severity:warningはerror扱いしない', rs.hasErrorSeverityWarning({ sourceMeta: { warnings: [{ field: 'x', message: 'm', severity: 'warning' }] } }) === false);

  // ---- hasTimeConflict ----
  check('AMなのに13:00以降は矛盾', rs.hasTimeConflict({ timePreference: { period: 'AM', time: '15:00' } }) === true);
  check('PMなのに午前時刻は矛盾', rs.hasTimeConflict({ timePreference: { period: 'PM', time: '9:00' } }) === true);
  check('AMで9:00は矛盾ではない', rs.hasTimeConflict({ timePreference: { period: 'AM', time: '9:00' } }) === false);
  check('PMで13:00は矛盾ではない', rs.hasTimeConflict({ timePreference: { period: 'PM', time: '13:00' } }) === false);

  // ---- isRoomNumberUnknown ----
  check('roomNumberが空文字はunknown', rs.isRoomNumberUnknown({ roomNumber: '' }) === true);
  check('roomNumberがあればunknownでない', rs.isRoomNumberUnknown({ roomNumber: '101' }) === false);

  // ---- findDuplicateRoomNumbers ----
  var dupRooms = [{ roomNumber: '101' }, { roomNumber: '102' }, { roomNumber: '101' }];
  check('重複部屋番号を検出する', rs.findDuplicateRoomNumbers(dupRooms).indexOf('101') !== -1 && rs.findDuplicateRoomNumbers(dupRooms).length === 1);

  // ---- isReviewed ----
  check('reviewedAtがあればreviewed', rs.isReviewed({ sourceMeta: { reviewedAt: '2026-07-26T00:00:00Z' } }) === true);
  check('reviewedAtが無ければreviewedでない', rs.isReviewed({}) === false);

  // ---- needsReview 総合 ----
  var highConfidenceOkRoom = { roomNumber: '101', scheduleDay: 1, sourceMeta: { ocrConfidence: { roomNumber: 0.98 } } };
  var reviewOk = rs.needsReview(highConfidenceOkRoom, { confidenceThreshold: 0.85 });
  check('高信頼度・warningなし・scheduleDayありは要確認でない', reviewOk.needsReview === false, JSON.stringify(reviewOk));

  var lowConfRoom = { roomNumber: '102', scheduleDay: 1, sourceMeta: { ocrConfidence: { roomNumber: 0.5 } } };
  var reviewLow = rs.needsReview(lowConfRoom, { confidenceThreshold: 0.85 });
  check('低信頼度は要確認', reviewLow.needsReview === true && reviewLow.reasons.indexOf('low_confidence') !== -1, JSON.stringify(reviewLow));

  var illegibleRoom = { roomNumber: '103', sourceStatus: 'illegible' };
  var reviewIllegible = rs.needsReview(illegibleRoom, {});
  check('illegibleは要確認', reviewIllegible.reasons.indexOf('illegible') !== -1);

  var scheduleDayUnknownRoom = { roomNumber: '104', scheduleDay: null };
  check('scheduleDay不明は要確認理由に含まれる', rs.needsReview(scheduleDayUnknownRoom, {}).reasons.indexOf('schedule_day_unknown') !== -1);

  var reviewedRoomWithWarning = { roomNumber: '105', scheduleDay: 1, sourceMeta: { warnings: [{ field: 'x', message: 'm' }], reviewedAt: '2026-07-26T00:00:00Z' } };
  var reviewReviewed = rs.needsReview(reviewedRoomWithWarning, {});
  check('確認済みの部屋はwarningがあってもneedsReview=false(reviewed扱い)', reviewReviewed.needsReview === false && reviewReviewed.reviewed === true, JSON.stringify(reviewReviewed));

  var duplicateRoom = { roomNumber: '101', scheduleDay: 1 };
  var reviewDup = rs.needsReview(duplicateRoom, { duplicateRoomNumbers: ['101'] });
  check('重複部屋番号は要確認', reviewDup.reasons.indexOf('duplicate_room') !== -1);

  // ---- isNotInTemplate(Phase4: 実際のroomCellMapとの突合に接続) ----
  check('roomCellMap未指定(テンプレート未接続)時は判定不能としてfalse', rs.isNotInTemplate({ roomNumber: '999' }) === false);
  var sampleRoomCellMap = { '1512': { cell: 'C15', sheet: '3F' }, '1513': { cell: 'C16', sheet: '3F' } };
  check('roomCellMapに存在する部屋番号はfalse(テンプレート内)', rs.isNotInTemplate({ roomNumber: '1512' }, { roomCellMap: sampleRoomCellMap }) === false);
  check('roomCellMapに存在しない部屋番号はtrue(テンプレート外)', rs.isNotInTemplate({ roomNumber: '9999' }, { roomCellMap: sampleRoomCellMap }) === true);
  check('roomCellMapのキーと前後空白違いでも一致とみなす(正規化)', rs.isNotInTemplate({ roomNumber: '  1512  ' }, { roomCellMap: sampleRoomCellMap }) === false);
  check('roomNumberが空の場合はroom_number_unknownと二重計上せずfalse', rs.isNotInTemplate({ roomNumber: '' }, { roomCellMap: sampleRoomCellMap }) === false);
  check('roomCellMapが空オブジェクト({})の場合は「テンプレートに部屋が1件も無い」として全部屋がtrue扱い', rs.isNotInTemplate({ roomNumber: '1512' }, { roomCellMap: {} }) === true);

  var roomNotInTemplate = { roomNumber: '9999', scheduleDay: 1, sourceMeta: { ocrConfidence: { roomNumber: 0.99 } } };
  var reviewNotInTemplate = rs.needsReview(roomNotInTemplate, { confidenceThreshold: 0.85, roomCellMap: sampleRoomCellMap });
  check('needsReview: テンプレートに無い部屋はnot_in_template理由で要確認になる', reviewNotInTemplate.needsReview === true && reviewNotInTemplate.reasons.indexOf('not_in_template') !== -1, JSON.stringify(reviewNotInTemplate));

  var roomInTemplate = { roomNumber: '1512', scheduleDay: 1, sourceMeta: { ocrConfidence: { roomNumber: 0.99 } } };
  var reviewInTemplate = rs.needsReview(roomInTemplate, { confidenceThreshold: 0.85, roomCellMap: sampleRoomCellMap });
  check('needsReview: テンプレートに存在する部屋は(他に問題が無ければ)要確認にならない', reviewInTemplate.needsReview === false, JSON.stringify(reviewInTemplate));

  var allOk = results.every(function (r) { return r.ok; });
  console.log('\n==== review_state_test 総合結果: ' + (allOk ? 'PASS' : 'FAIL') + ' (' + results.filter(function (r) { return r.ok; }).length + '/' + results.length + ') ====');
  if (!allOk) process.exitCode = 1;
}

run();
