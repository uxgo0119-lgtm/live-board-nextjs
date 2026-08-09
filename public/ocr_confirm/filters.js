// Phase3「③OCR確認画面」: 一覧のフィルタリングロジック(純粋関数)。
//
// 設計方針(ユーザー指示2026-07-26 3番): 要確認のみ／低信頼度のみ／warningあり／判読不能／
// 未処理／確認済み／全件、を用意する。初期表示は「要確認のみ」を優先するが、要確認が0件の
// 場合は全件または完了状態を分かりやすく表示する。
//
// review_state.js に依存する(Node/ブラウザ両対応のデュアルモジュールパターン)。
'use strict';

var reviewState;
if (typeof module !== 'undefined' && module.exports) {
  reviewState = require('./review_state.js');
} else if (typeof window !== 'undefined') {
  reviewState = window.FireFlowOcrConfirm || {};
}

var FILTER_TYPES = {
  NEEDS_REVIEW: 'needs_review',
  LOW_CONFIDENCE: 'low_confidence',
  HAS_WARNING: 'has_warning',
  ILLEGIBLE: 'illegible',
  UNPROCESSED: 'unprocessed',
  REVIEWED: 'reviewed',
  ALL: 'all',
};

var FILTER_LABELS = {
  needs_review: '要確認のみ',
  low_confidence: '低信頼度のみ',
  has_warning: 'warningあり',
  illegible: '判読不能',
  unprocessed: '未処理',
  reviewed: '確認済み',
  all: '全件',
};

// Phase4(テンプレート管理)接続: context.roomCellMap が渡された場合はそのまま次段へ
// 引き継ぐ(review_state.jsのisNotInTemplate()が参照する)。渡されなければキーごと省略し、
// 従来通り「テンプレート未接続=判定不能」として扱われる(既存呼び出し元・既存テストへの
// 影響は無い)。
function buildContext(rooms, context) {
  context = context || {};
  var threshold = (typeof context.confidenceThreshold === 'number') ? context.confidenceThreshold : reviewState.getConfidenceThreshold();
  var dup = context.duplicateRoomNumbers || reviewState.findDuplicateRoomNumbers(rooms);
  var ctx = { confidenceThreshold: threshold, duplicateRoomNumbers: dup };
  if (context.roomCellMap && typeof context.roomCellMap === 'object') ctx.roomCellMap = context.roomCellMap;
  return ctx;
}

// rooms: FSDFのrooms[]配列。filterType: FILTER_TYPESのいずれか。context: {confidenceThreshold, duplicateRoomNumbers}(省略可)。
function applyFilter(rooms, filterType, context) {
  rooms = Array.isArray(rooms) ? rooms : [];
  var ctx = buildContext(rooms, context);

  switch (filterType) {
    case FILTER_TYPES.NEEDS_REVIEW:
      return rooms.filter(function (r) { return reviewState.needsReview(r, ctx).needsReview; });
    case FILTER_TYPES.LOW_CONFIDENCE:
      return rooms.filter(function (r) {
        var mc = reviewState.minConfidence(r);
        return mc !== null && mc < ctx.confidenceThreshold;
      });
    case FILTER_TYPES.HAS_WARNING:
      return rooms.filter(reviewState.hasWarnings);
    case FILTER_TYPES.ILLEGIBLE:
      return rooms.filter(function (r) { return r && r.sourceStatus === 'illegible'; });
    case FILTER_TYPES.UNPROCESSED:
      return rooms.filter(function (r) { return !reviewState.isReviewed(r); });
    case FILTER_TYPES.REVIEWED:
      return rooms.filter(reviewState.isReviewed);
    case FILTER_TYPES.ALL:
      return rooms.slice();
    default:
      return rooms.slice();
  }
}

// 各フィルタの該当件数をまとめて返す(フィルタチップのバッジ表示用)。
function countByFilter(rooms, context) {
  var out = {};
  Object.keys(FILTER_TYPES).forEach(function (k) {
    var type = FILTER_TYPES[k];
    out[type] = applyFilter(rooms, type, context).length;
  });
  return out;
}

// 初期表示フィルタを決定する(指示3番: 要確認優先。0件なら全件+完了状態を明示)。
// 戻り値: { filter, rooms, fallback: boolean, allReviewed: boolean }
function pickInitialFilter(rooms, context) {
  rooms = Array.isArray(rooms) ? rooms : [];
  var ctx = buildContext(rooms, context);
  var needsReviewRooms = applyFilter(rooms, FILTER_TYPES.NEEDS_REVIEW, ctx);
  if (needsReviewRooms.length > 0) {
    return { filter: FILTER_TYPES.NEEDS_REVIEW, rooms: needsReviewRooms, fallback: false, allReviewed: false };
  }
  var allReviewed = rooms.length > 0 && rooms.every(reviewState.isReviewed);
  return { filter: FILTER_TYPES.ALL, rooms: rooms.slice(), fallback: true, allReviewed: allReviewed };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    FILTER_TYPES: FILTER_TYPES,
    FILTER_LABELS: FILTER_LABELS,
    applyFilter: applyFilter,
    countByFilter: countByFilter,
    pickInitialFilter: pickInitialFilter,
  };
} else if (typeof window !== 'undefined') {
  window.FireFlowOcrConfirm = window.FireFlowOcrConfirm || {};
  window.FireFlowOcrConfirm.FILTER_TYPES = FILTER_TYPES;
  window.FireFlowOcrConfirm.FILTER_LABELS = FILTER_LABELS;
  window.FireFlowOcrConfirm.applyFilter = applyFilter;
  window.FireFlowOcrConfirm.countByFilter = countByFilter;
  window.FireFlowOcrConfirm.pickInitialFilter = pickInitialFilter;
}
