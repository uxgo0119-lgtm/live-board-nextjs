// OCR Normalizer: 警告の生成・集約を行う共通ヘルパー。
//
// 方針: 「判読不能な項目を勝手に確定しない」というユーザー指示を、警告という形で必ず可視化する。
// warningオブジェクトの形式は fireflow_fsdf/schema/fsdf.schema.json の
// rooms[].sourceMeta.warnings と揃える({field, message, severity})。
'use strict';

function mergeWarnings() {
  var out = [];
  for (var i = 0; i < arguments.length; i++) {
    var arr = arguments[i];
    if (Array.isArray(arr)) out = out.concat(arr);
  }
  return out;
}

function warnIfLowConfidence(field, label, confidence, threshold) {
  threshold = (typeof threshold === 'number') ? threshold : 0.75;
  if (typeof confidence === 'number' && confidence < threshold) {
    return [{ field: field, message: label + 'の読み取り信頼度が低いです(' + confidence.toFixed(2) + ' < ' + threshold + ')。要確認です。', severity: 'warning' }];
  }
  return [];
}

function warnMissingRoomNumber(index) {
  return [{ field: 'roomNumber', message: 'OCR結果の' + (index + 1) + '件目で部屋番号を読み取れませんでした。この行はFSDFへ変換されません。', severity: 'error' }];
}

// totalScheduleDaysが未確定(工程全体の日数がまだ分からない)段階では範囲チェックをスキップする。
function warnScheduleDayOutOfRange(roomLabel, scheduleDay, totalScheduleDays) {
  if (scheduleDay === null || scheduleDay === undefined) return [];
  if (typeof totalScheduleDays !== 'number' || totalScheduleDays < 1) return [];
  if (scheduleDay < 1 || scheduleDay > totalScheduleDays) {
    return [{ field: 'scheduleDay', message: roomLabel + 'の工程日(' + scheduleDay + '日目)が、物件全体の工程日数(全' + totalScheduleDays + '日)の範囲外です。', severity: 'warning' }];
  }
  return [];
}

function warnUnparsedScheduleDay(roomLabel, raw) {
  return [{ field: 'scheduleDay', message: roomLabel + 'の工程日表記「' + raw + '」を解析できませんでした。', severity: 'warning' }];
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    mergeWarnings: mergeWarnings,
    warnIfLowConfidence: warnIfLowConfidence,
    warnMissingRoomNumber: warnMissingRoomNumber,
    warnScheduleDayOutOfRange: warnScheduleDayOutOfRange,
    warnUnparsedScheduleDay: warnUnparsedScheduleDay,
  };
} else if (typeof window !== 'undefined') {
  window.FireFlowOcrIntake = window.FireFlowOcrIntake || {};
  window.FireFlowOcrIntake.mergeWarnings = mergeWarnings;
  window.FireFlowOcrIntake.warnIfLowConfidence = warnIfLowConfidence;
  window.FireFlowOcrIntake.warnMissingRoomNumber = warnMissingRoomNumber;
  window.FireFlowOcrIntake.warnScheduleDayOutOfRange = warnScheduleDayOutOfRange;
  window.FireFlowOcrIntake.warnUnparsedScheduleDay = warnUnparsedScheduleDay;
}
