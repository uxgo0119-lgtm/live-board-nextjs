// Phase3「③OCR確認画面」: 部屋ごとに「要確認」かどうかを判定する純粋ロジック。
//
// 設計方針(ユーザー指示2026-07-26 1番・4番): OCR確認画面は全項目を毎回編集する画面ではなく、
// 「問題のある箇所だけを確認・修正して承認する画面」である。高信頼でwarningが無い項目は
// 原則そのまま承認できる状態にし、人が重点的に確認すべき対象(低信頼度/warningあり/時間帯と
// 時刻の矛盾/工程日不明/部屋番号不明/テンプレート未存在/重複部屋/illegible/other/未回答・
// 未連絡など)だけを"要確認"としてハイライトする。信頼度の数値だけに依存せず、warningや
// 状態も含めて判定する(指示4番)。
//
// Node(require)とブラウザ(<script src>、window.FireFlowOcrConfirm名前空間経由)の両方に対応する
// (既存のocr_intake配下と同じデュアルモジュールパターン)。
'use strict';

var DEFAULT_CONFIDENCE_THRESHOLD = 0.85;
var THRESHOLD_STORAGE_KEY = 'fireflow_ocr_confirm_confidence_threshold_v1';

// 要確認と判定する理由コード一覧(row_view_model.js・ocr_confirm_screen.jsから参照する)。
var REVIEW_REASONS = {
  LOW_CONFIDENCE: 'low_confidence',
  HAS_WARNING: 'has_warning',
  TIME_CONFLICT: 'time_conflict',
  SCHEDULE_DAY_UNKNOWN: 'schedule_day_unknown',
  SCHEDULE_DAY_OUT_OF_RANGE: 'schedule_day_out_of_range',
  ROOM_NUMBER_UNKNOWN: 'room_number_unknown',
  NOT_IN_TEMPLATE: 'not_in_template', // Phase4(テンプレート管理)未実装のためフックのみ。常にfalseを返す。
  DUPLICATE_ROOM: 'duplicate_room',
  ILLEGIBLE: 'illegible',
  OTHER_STATUS: 'other_status',
  UNANSWERED: 'unanswered',
};

function safeLocalStorage(storage) {
  if (storage) return storage;
  try {
    if (typeof window !== 'undefined' && window.localStorage) return window.localStorage;
  } catch (e) {}
  return null;
}

// 信頼度閾値の取得(初期値0.85。設定変更できるようlocalStorageに永続化する。指示4番)。
function getConfidenceThreshold(storage) {
  var s = safeLocalStorage(storage);
  if (s) {
    try {
      var raw = s.getItem(THRESHOLD_STORAGE_KEY);
      if (raw !== null && raw !== undefined && raw !== '') {
        var n = parseFloat(raw);
        if (!isNaN(n) && n >= 0 && n <= 1) return n;
      }
    } catch (e) {}
  }
  return DEFAULT_CONFIDENCE_THRESHOLD;
}

function setConfidenceThreshold(value, storage) {
  var n = parseFloat(value);
  if (isNaN(n) || n < 0 || n > 1) {
    throw new Error('setConfidenceThreshold: 0〜1の数値を指定してください(現在の値: ' + JSON.stringify(value) + ')。');
  }
  var s = safeLocalStorage(storage);
  if (s) {
    try { s.setItem(THRESHOLD_STORAGE_KEY, String(n)); } catch (e) {}
  }
  return n;
}

// 部屋の各フィールド信頼度のうち最小値を返す(1つでも低ければ要確認、という考え方の土台)。
// 信頼度情報が無い場合はnull(「信頼度不明」であり「低信頼」ではないため要区別)。
function minConfidence(room) {
  var conf = (room && room.sourceMeta && room.sourceMeta.ocrConfidence) || {};
  var values = Object.keys(conf).map(function (k) { return conf[k]; }).filter(function (v) { return typeof v === 'number' && !isNaN(v); });
  if (!values.length) return null;
  return Math.min.apply(Math, values);
}

function hasWarnings(room) {
  var w = (room && room.sourceMeta && room.sourceMeta.warnings) || [];
  return w.length > 0;
}

function hasErrorSeverityWarning(room) {
  var w = (room && room.sourceMeta && room.sourceMeta.warnings) || [];
  return w.some(function (x) { return x && x.severity === 'error'; });
}

// 時間帯(AM/PM)と時刻の矛盾を検出する(例: AMなのに13:00以降、PMなのに午前の時刻)。
// warnings配列にfield:'timePreference'やmessageに「矛盾」を含むものがある場合、または
// timePreference自体から直接矛盾を検出できる場合の両方をカバーする。
function hasTimeConflict(room) {
  var w = (room && room.sourceMeta && room.sourceMeta.warnings) || [];
  if (w.some(function (x) { return x && (x.field === 'timePreference' || x.field === 'time' || x.field === 'period') && /矛盾/.test(x.message || ''); })) {
    return true;
  }
  var tp = (room && room.timePreference) || {};
  if (tp.period && tp.time) {
    var hh = parseInt(String(tp.time).split(':')[0], 10);
    if (!isNaN(hh)) {
      if (tp.period === 'AM' && hh >= 13) return true;
      if (tp.period === 'PM' && hh < 12) return true;
    }
  }
  return false;
}

function isRoomNumberUnknown(room) {
  var rn = room && room.roomNumber;
  return !(typeof rn === 'string' ? rn.trim() : rn);
}

// Phase4(テンプレート管理)実装により、実際のroomCellMapとの突合に接続した。
//
// context.roomCellMap に mapping.json の roomCellMap(部屋番号 -> {cell, sheet})相当の
// オブジェクトが渡された場合のみ判定を行う。渡されなかった場合(テンプレートが未読込/
// この物件に対応するテンプレートが無い)は「判定不能」として false を返す(要確認理由には
// 積まない)。これは、テンプレート未接続の状態を「テンプレートに存在しない部屋」と誤って
// 扱わないための設計判断(fireflow_template_engine/mapping_validator.jsのpropertyId未設定時の
// 扱いと同じ考え方: 判定できない場合はエラー/警告扱いにせず、呼び出し元が明示的に
// roomCellMapを渡した場合のみ厳密な判定を行う)。
//
// 部屋番号の突合は、mapping_validator.jsのnormalizeRoomNumberKey()と同じ正規化
// (前後空白除去)を行った上で行う(findDuplicateRoomNumbers()と表記を揃えるため)。
function isNotInTemplate(room, context) {
  context = context || {};
  var roomCellMap = context.roomCellMap;
  if (!roomCellMap || typeof roomCellMap !== 'object') return false; // テンプレート未接続=判定不能
  var rn = room && room.roomNumber;
  var key = (typeof rn === 'string') ? rn.trim() : (rn === undefined || rn === null ? '' : String(rn));
  if (!key) return false; // 部屋番号不明は別理由(ROOM_NUMBER_UNKNOWN)で検出されるため、ここでは二重に立てない
  return !Object.prototype.hasOwnProperty.call(roomCellMap, key);
}

// 部屋番号の重複判定用ヘルパー(fsdf.rooms全体から重複しているroomNumberの集合を作る)。
function findDuplicateRoomNumbers(rooms) {
  var seen = Object.create(null);
  var dup = Object.create(null);
  (rooms || []).forEach(function (r) {
    var rn = r && r.roomNumber;
    var key = (typeof rn === 'string') ? rn.trim() : (rn === undefined || rn === null ? '' : String(rn));
    if (!key) return;
    if (seen[key]) dup[key] = true;
    seen[key] = true;
  });
  return Object.keys(dup);
}

function isReviewed(room) {
  return !!(room && room.sourceMeta && room.sourceMeta.reviewedAt);
}

// 部屋1件が「要確認」かどうかを判定する。
// context: {
//   confidenceThreshold: number (省略時はgetConfidenceThreshold()),
//   duplicateRoomNumbers: string[] (省略時はundefined=重複チェックしない。通常はfilters.js等が
//     findDuplicateRoomNumbers()の結果を渡す),
// }
// 戻り値: { needsReview: boolean, reasons: string[], reviewed: boolean }
function needsReview(room, context) {
  context = context || {};
  var threshold = (typeof context.confidenceThreshold === 'number') ? context.confidenceThreshold : getConfidenceThreshold();
  var reasons = [];

  var mc = minConfidence(room);
  if (mc !== null && mc < threshold) reasons.push(REVIEW_REASONS.LOW_CONFIDENCE);
  if (hasWarnings(room)) reasons.push(REVIEW_REASONS.HAS_WARNING);
  if (hasTimeConflict(room)) reasons.push(REVIEW_REASONS.TIME_CONFLICT);
  if (room && (room.scheduleDay === undefined || room.scheduleDay === null)) reasons.push(REVIEW_REASONS.SCHEDULE_DAY_UNKNOWN);
  if (isRoomNumberUnknown(room)) reasons.push(REVIEW_REASONS.ROOM_NUMBER_UNKNOWN);
  if (isNotInTemplate(room, context)) reasons.push(REVIEW_REASONS.NOT_IN_TEMPLATE);
  if (Array.isArray(context.duplicateRoomNumbers) && room && context.duplicateRoomNumbers.indexOf(String(room.roomNumber)) !== -1) {
    reasons.push(REVIEW_REASONS.DUPLICATE_ROOM);
  }
  if (room && room.sourceStatus === 'illegible') reasons.push(REVIEW_REASONS.ILLEGIBLE);
  if (room && room.sourceStatus === 'other') reasons.push(REVIEW_REASONS.OTHER_STATUS);
  if (room && room.sourceStatus === 'unanswered') reasons.push(REVIEW_REASONS.UNANSWERED);

  var reviewed = isReviewed(room);
  return {
    needsReview: reasons.length > 0 && !reviewed,
    reasons: reasons,
    reviewed: reviewed,
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    DEFAULT_CONFIDENCE_THRESHOLD: DEFAULT_CONFIDENCE_THRESHOLD,
    REVIEW_REASONS: REVIEW_REASONS,
    getConfidenceThreshold: getConfidenceThreshold,
    setConfidenceThreshold: setConfidenceThreshold,
    minConfidence: minConfidence,
    hasWarnings: hasWarnings,
    hasErrorSeverityWarning: hasErrorSeverityWarning,
    hasTimeConflict: hasTimeConflict,
    isRoomNumberUnknown: isRoomNumberUnknown,
    isNotInTemplate: isNotInTemplate,
    findDuplicateRoomNumbers: findDuplicateRoomNumbers,
    isReviewed: isReviewed,
    needsReview: needsReview,
  };
} else if (typeof window !== 'undefined') {
  window.FireFlowOcrConfirm = window.FireFlowOcrConfirm || {};
  window.FireFlowOcrConfirm.DEFAULT_CONFIDENCE_THRESHOLD = DEFAULT_CONFIDENCE_THRESHOLD;
  window.FireFlowOcrConfirm.REVIEW_REASONS = REVIEW_REASONS;
  window.FireFlowOcrConfirm.getConfidenceThreshold = getConfidenceThreshold;
  window.FireFlowOcrConfirm.setConfidenceThreshold = setConfidenceThreshold;
  window.FireFlowOcrConfirm.minConfidence = minConfidence;
  window.FireFlowOcrConfirm.hasWarnings = hasWarnings;
  window.FireFlowOcrConfirm.hasErrorSeverityWarning = hasErrorSeverityWarning;
  window.FireFlowOcrConfirm.hasTimeConflict = hasTimeConflict;
  window.FireFlowOcrConfirm.isRoomNumberUnknown = isRoomNumberUnknown;
  window.FireFlowOcrConfirm.isNotInTemplate = isNotInTemplate;
  window.FireFlowOcrConfirm.findDuplicateRoomNumbers = findDuplicateRoomNumbers;
  window.FireFlowOcrConfirm.isReviewed = isReviewed;
  window.FireFlowOcrConfirm.needsReview = needsReview;
}
