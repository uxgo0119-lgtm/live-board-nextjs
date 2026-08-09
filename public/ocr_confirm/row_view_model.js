// Phase3「③OCR確認画面」: 一覧の各行の表示用データを組み立てる純粋関数。
//
// 設計方針(ユーザー指示2026-07-26 2番・4番): 一覧では最低限、部屋番号・工程日・AM/PM・
// 時間指定・状態・メモ・信頼度・warningの有無を表示する。色分け: 高信頼・warningなし=通常表示、
// 低信頼=黄色、重大な矛盾・illegible=赤系、確認済み=チェック表示。
//
// review_state.js に依存する(Node/ブラウザ両対応)。
'use strict';

var reviewState;
if (typeof module !== 'undefined' && module.exports) {
  reviewState = require('./review_state.js');
} else if (typeof window !== 'undefined') {
  reviewState = window.FireFlowOcrConfirm || {};
}

var SOURCE_STATUS_LABELS = {
  scheduled: '予定通り',
  pass: 'PASS(確認済み)',
  cancelled: 'キャンセル',
  unanswered: '未回答・未連絡',
  absent: '不在',
  illegible: '判読不能',
  other: 'その他(要確認)',
};

// 色分けクラス名(CSSは統合先のindex.html側で定義する)。
var ROW_COLOR_CLASS = {
  OK: 'ocr-row-ok',                 // 高信頼・warningなし=通常表示
  LOW_CONFIDENCE: 'ocr-row-low',    // 低信頼=黄色
  SEVERE: 'ocr-row-severe',         // 重大な矛盾・illegible=赤系
  REVIEWED: 'ocr-row-reviewed',     // 確認済み=チェック表示
};

function formatScheduleDayLabel(room) {
  if (typeof room.scheduleDay === 'number' && room.scheduleDay >= 1) return room.scheduleDay + '日目';
  return '(不明)';
}

function formatTimeLabel(room) {
  var tp = room.timePreference || {};
  if (!tp.period && !tp.time) return '(指定なし)';
  var parts = [];
  if (tp.period) parts.push(tp.period);
  if (tp.time) {
    var t = tp.time;
    if (tp.isRange && tp.timeEnd) t += '〜' + tp.timeEnd;
    parts.push(t);
  }
  return parts.join(' ') || '(指定なし)';
}

function formatStatusLabel(room) {
  if (room.sourceStatus && SOURCE_STATUS_LABELS[room.sourceStatus]) {
    var label = SOURCE_STATUS_LABELS[room.sourceStatus];
    if (room.ocrStatusRaw && room.ocrStatusRaw !== label) label += '(元: ' + room.ocrStatusRaw + ')';
    return label;
  }
  return room.sourceStatus || '-';
}

// 部屋1件分の行表示モデルを構築する。context: {confidenceThreshold, duplicateRoomNumbers}(省略可)。
function buildRowViewModel(room, context) {
  context = context || {};
  var review = reviewState.needsReview(room, context);
  var mc = reviewState.minConfidence(room);
  var warnings = (room.sourceMeta && room.sourceMeta.warnings) || [];
  var reviewed = reviewState.isReviewed(room);

  var colorClass;
  if (reviewed) {
    colorClass = ROW_COLOR_CLASS.REVIEWED;
  } else if (!review.needsReview) {
    colorClass = ROW_COLOR_CLASS.OK;
  } else {
    // Phase4接続: not_in_template(テンプレートのroomCellMapに存在しない部屋)は、
    // そのままでは書き込み先セルが無く出力できない=重大な問題のため、severe(赤系)扱いとする。
    var severeReasons = ['illegible', 'time_conflict', 'duplicate_room', 'room_number_unknown', 'schedule_day_out_of_range', 'not_in_template'];
    var isSevere = review.reasons.some(function (r) { return severeReasons.indexOf(r) !== -1; }) || reviewState.hasErrorSeverityWarning(room);
    colorClass = isSevere ? ROW_COLOR_CLASS.SEVERE : ROW_COLOR_CLASS.LOW_CONFIDENCE;
  }

  return {
    roomId: room.roomId || room.roomNumber,
    roomNumber: room.roomNumber,
    scheduleDayLabel: formatScheduleDayLabel(room),
    period: (room.timePreference && room.timePreference.period) || null,
    timeLabel: formatTimeLabel(room),
    statusLabel: formatStatusLabel(room),
    memo: room.memo || '',
    minConfidence: mc,
    minConfidenceLabel: (mc === null) ? '(不明)' : Math.round(mc * 100) + '%',
    hasWarning: warnings.length > 0,
    warningCount: warnings.length,
    warningMessages: warnings.map(function (w) { return w.message; }),
    needsReview: review.needsReview,
    reviewReasons: review.reasons,
    reviewed: reviewed,
    reviewedBy: (room.sourceMeta && room.sourceMeta.reviewedBy) || null,
    reviewedAt: (room.sourceMeta && room.sourceMeta.reviewedAt) || null,
    colorClass: colorClass,
    ladderRoom: !!room.ladderRoom,
  };
}

// rooms配列全体を行表示モデルの配列へ変換する。
function buildRowViewModels(rooms, context) {
  rooms = Array.isArray(rooms) ? rooms : [];
  context = context || {};
  var ctx = Object.assign({}, context);
  if (!ctx.duplicateRoomNumbers) ctx.duplicateRoomNumbers = reviewState.findDuplicateRoomNumbers(rooms);
  if (typeof ctx.confidenceThreshold !== 'number') ctx.confidenceThreshold = reviewState.getConfidenceThreshold();
  return rooms.map(function (r) { return buildRowViewModel(r, ctx); });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    SOURCE_STATUS_LABELS: SOURCE_STATUS_LABELS,
    ROW_COLOR_CLASS: ROW_COLOR_CLASS,
    buildRowViewModel: buildRowViewModel,
    buildRowViewModels: buildRowViewModels,
  };
} else if (typeof window !== 'undefined') {
  window.FireFlowOcrConfirm = window.FireFlowOcrConfirm || {};
  window.FireFlowOcrConfirm.SOURCE_STATUS_LABELS = SOURCE_STATUS_LABELS;
  window.FireFlowOcrConfirm.ROW_COLOR_CLASS = ROW_COLOR_CLASS;
  window.FireFlowOcrConfirm.buildRowViewModel = buildRowViewModel;
  window.FireFlowOcrConfirm.buildRowViewModels = buildRowViewModels;
}
