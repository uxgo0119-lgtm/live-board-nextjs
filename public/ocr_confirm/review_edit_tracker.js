// Phase3「③OCR確認画面」: 修正前後の値・修正された項目・タイムスタンプを追跡する。
//
// 設計方針(ユーザー指示2026-07-26 5番): 「確定」時に、reviewedBy・reviewedAt・修正前の値・
// 修正後の値・修正された項目、を追跡できるようにする。少なくとも今回のPhaseでは、修正履歴を
// 失わないデータ構造を用意する。ユーザーが修正した値を、再度Normalizerで勝手に上書きしない。
//
// 【重要な規約】この規約はドキュメント化することでも要求を満たすとされているが、本実装では
// 機械的にも保証できるようにした: 人間が編集したフィールドには room.sourceMeta.editedFields
// (編集されたフィールド名の配列)を立てる。normalize/配下やfsdf_builder.js等のパイプラインが
// 同じ部屋のデータを再計算する場合、isFieldEdited()で確認し、trueなら値を上書きしてはならない
// (再実行時にeditedFieldsに含まれるフィールドをスキップする、という規約をここに明記する)。
//
// FSDF Ver1.2で追加した rooms[].sourceMeta.reviewEdits ({field, before, after, editedAt}[]) に
// 対応する。Node/ブラウザ両対応(デュアルモジュールパターン)。
'use strict';

// room内のドット区切りパス(例: 'timePreference.period')から値を取得する。
function getFieldValue(room, field) {
  if (!room) return undefined;
  var parts = String(field).split('.');
  var cur = room;
  for (var i = 0; i < parts.length; i++) {
    if (cur === undefined || cur === null) return undefined;
    cur = cur[parts[i]];
  }
  return cur;
}

// イミュータブルにドット区切りパスへ値を設定した新しいroomオブジェクトを返す。
function setFieldValue(room, field, value) {
  var parts = String(field).split('.');
  var rootClone = Object.assign({}, room);
  var cur = rootClone;
  for (var i = 0; i < parts.length - 1; i++) {
    var key = parts[i];
    cur[key] = Object.assign({}, cur[key] || {});
    cur = cur[key];
  }
  cur[parts[parts.length - 1]] = value;
  return rootClone;
}

function valuesEqual(a, b) {
  if (a === b) return true;
  try { return JSON.stringify(a) === JSON.stringify(b); } catch (e) { return false; }
}

// 1フィールド分の変更履歴を追加した新しいroomオブジェクトを返す(値そのものはまだ変更しない。
// applyRoomFieldEdit()が履歴追加+値変更を両方行う)。
function recordEditHistory(room, field, beforeValue, afterValue, editedAt) {
  editedAt = editedAt || new Date().toISOString();
  var updated = Object.assign({}, room);
  updated.sourceMeta = Object.assign({}, room.sourceMeta || {});
  var edits = Array.isArray(updated.sourceMeta.reviewEdits) ? updated.sourceMeta.reviewEdits.slice() : [];
  edits.push({ field: field, before: beforeValue, after: afterValue, editedAt: editedAt });
  updated.sourceMeta.reviewEdits = edits;

  var editedFields = Array.isArray(updated.sourceMeta.editedFields) ? updated.sourceMeta.editedFields.slice() : [];
  if (editedFields.indexOf(field) === -1) editedFields.push(field);
  updated.sourceMeta.editedFields = editedFields;

  return updated;
}

// フィールド名(ドット区切りパス)から、そのフィールドが解消しうるOCR Normalizer由来の
// warning(field名)を引く対応表。人間が値を修正した際、修正前の値についての古いwarningが
// 表示され続けて「まだ矛盾しているように見える」ことを防ぐため、該当するwarningだけを
// 取り除く(warningsのfield名はfireflow_fsdf/schema/fsdf.schema.jsonのrooms[].sourceMeta.warnings
// およびlb_tool/ocr_intake/normalize/normalizeTimePreference.jsのfield:'timePreference'に対応)。
var FIELD_TO_WARNING_FIELDS = {
  'timePreference.period': ['timePreference'],
  'timePreference.time': ['timePreference'],
  'scheduleDay': ['scheduleDay'],
  'roomNumber': ['roomNumber'],
};

// 「矛盾」を含む警告のうち、指定フィールドに紐づくものを取り除いた新しいroomオブジェクトを返す。
// (指示5番の「ユーザーが修正した値を、再度Normalizerで勝手に上書きしない」規約とは別軸で、
// 「人間が矛盾を修正した後もUI上は矛盾ありと表示され続ける」という食い違いを防ぐための処理。
// warnings自体を無条件に消すのではなく、"矛盾"に関するものだけを対象にする)。
function pruneResolvedConflictWarnings(room, field) {
  var warnFields = FIELD_TO_WARNING_FIELDS[field];
  if (!warnFields || !room.sourceMeta || !Array.isArray(room.sourceMeta.warnings) || !room.sourceMeta.warnings.length) return room;
  var remaining = room.sourceMeta.warnings.filter(function (w) {
    if (!w || warnFields.indexOf(w.field) === -1) return true; // 無関係なwarningはそのまま残す
    return !/矛盾/.test(w.message || ''); // 「矛盾」に言及するwarningだけを、値修正後に取り除く
  });
  if (remaining.length === room.sourceMeta.warnings.length) return room; // 変化なし
  var updated = Object.assign({}, room);
  updated.sourceMeta = Object.assign({}, room.sourceMeta, { warnings: remaining });
  return updated;
}

// 部屋のフィールドを人間の修正として反映する(値そのものの変更+履歴追加を両方行う)。
// 値に変化が無い場合は履歴を追加せず、元のオブジェクトをそのまま返す(無駄な履歴を作らない)。
function applyRoomFieldEdit(room, field, newValue, editedAt) {
  var before = getFieldValue(room, field);
  if (valuesEqual(before, newValue)) return room;
  var withHistory = recordEditHistory(room, field, before, newValue, editedAt);
  var withValue = setFieldValue(withHistory, field, newValue);
  return pruneResolvedConflictWarnings(withValue, field);
}

// 複数フィールドをまとめて適用する。patch: { 'roomNumber': '1512', 'timePreference.period': 'AM', ... }
function applyRoomEdits(room, patch, editedAt) {
  editedAt = editedAt || new Date().toISOString();
  var updated = room;
  Object.keys(patch || {}).forEach(function (field) {
    updated = applyRoomFieldEdit(updated, field, patch[field], editedAt);
  });
  return updated;
}

function isFieldEdited(room, field) {
  var editedFields = (room && room.sourceMeta && room.sourceMeta.editedFields) || [];
  return editedFields.indexOf(field) !== -1;
}

function getReviewEdits(room) {
  return (room && room.sourceMeta && room.sourceMeta.reviewEdits) || [];
}

// 「確定」操作: reviewedBy/reviewedAtを設定する(既存の値を無条件に上書きしない。指示5番:
// 一度確定された部屋のreviewedByを、別の担当者名で誤って上書きしないよう、
// options.overwriteExisting=trueを明示しない限り、既にreviewedAtがある部屋はスキップする)。
function markRoomReviewed(room, reviewedBy, reviewedAt, options) {
  options = options || {};
  reviewedAt = reviewedAt || new Date().toISOString();
  if (!options.overwriteExisting && room && room.sourceMeta && room.sourceMeta.reviewedAt) {
    return room; // 既に確認済み。上書きしない。
  }
  var updated = Object.assign({}, room);
  updated.sourceMeta = Object.assign({}, room.sourceMeta || {});
  updated.sourceMeta.reviewedBy = reviewedBy || null;
  updated.sourceMeta.reviewedAt = reviewedAt;
  return updated;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    getFieldValue: getFieldValue,
    setFieldValue: setFieldValue,
    recordEditHistory: recordEditHistory,
    applyRoomFieldEdit: applyRoomFieldEdit,
    applyRoomEdits: applyRoomEdits,
    isFieldEdited: isFieldEdited,
    getReviewEdits: getReviewEdits,
    markRoomReviewed: markRoomReviewed,
  };
} else if (typeof window !== 'undefined') {
  window.FireFlowOcrConfirm = window.FireFlowOcrConfirm || {};
  window.FireFlowOcrConfirm.getFieldValue = getFieldValue;
  window.FireFlowOcrConfirm.setFieldValue = setFieldValue;
  window.FireFlowOcrConfirm.recordEditHistory = recordEditHistory;
  window.FireFlowOcrConfirm.applyRoomFieldEdit = applyRoomFieldEdit;
  window.FireFlowOcrConfirm.applyRoomEdits = applyRoomEdits;
  window.FireFlowOcrConfirm.isFieldEdited = isFieldEdited;
  window.FireFlowOcrConfirm.getReviewEdits = getReviewEdits;
  window.FireFlowOcrConfirm.markRoomReviewed = markRoomReviewed;
}
