// FSDF ⇔ 既存LB書き出しJSON の双方向変換。
//
// 設計方針(設計書1.2・4章を参照): FSDFは既存のLB書き出しJSON(property/results[]/
// equipmentState/previousDefects等)を「rooms[]」という名前で完全に包含し、OCR由来の
// 追加フィールド(scheduleDay/timePreference/ladderRoom/memo/sourceMeta)を任意項目として
// 追加したものである。既存データにはこれらの追加フィールドが存在しないため、
// lbExportToFsdf()は既存データに新しいキーを一切増やさず(値が無ければキー自体を作らない)、
// fsdfToLbExport()はFSDF専用キーを取り除くだけで元の形に戻す。
//
// これにより「既存データ→FSDF→既存データ」の往復で完全に同じ内容に戻ることを保証できる
// (test/fsdf_roundtrip_test.jsで実データを使って検証済み)。
'use strict';

// 【Ver2.0(Envelope化)対応】fsdfToLbExport()はRF(rf_tool/)等がFSDFから既存LB形式へ変換する際の
// 境界(boundary)にあたる。RF自体は現状FSDFを直接読まず、この変換関数の出力(既存LB書き出しJSON
// 形式)だけを消費するが、本関数がEnvelope形式(Ver2.0)のFSDFを渡された場合でも正しく動作できる
// よう、入力を必ずunwrapEnvelope()に通してから処理する(既に平坦形式なら何もせずそのまま返る
// 冪等な変換のため、Ver1.x呼び出し元には影響しない)。
var envelopeAdapter;
if (typeof module !== 'undefined' && module.exports) {
  envelopeAdapter = require('./envelopeAdapter.js');
} else if (typeof window !== 'undefined') {
  envelopeAdapter = window.FireFlowFsdf || {};
}

var FSDF_VERSION = '1.2';

// FSDFのrooms[]専用キー(既存results[]には存在しない、OCR由来の追加フィールド)。
// fsdfToLbExport()で元に戻す際にこれらを取り除く。
var ROOM_ONLY_FSDF_KEYS = ['roomNumberRaw', 'scheduleDay', 'timePreference', 'ladderRoom', 'memo', 'sourceMeta', 'ocrStatusRaw', 'sourceStatus'];

// FSDFの最上位専用キー(既存LB書き出しJSONのトップレベルには存在しない)。
var TOP_LEVEL_ONLY_FSDF_KEYS = ['fsdfVersion', 'inspection', 'rooms', 'batchWarnings'];

function lbExportToFsdf(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('lbExportToFsdf: payloadがオブジェクトではありません。');
  }
  var fsdf = Object.assign({}, payload); // 未知の項目も含め、まず全キーをそのままコピーする
  delete fsdf.results;

  fsdf.fsdfVersion = FSDF_VERSION;
  fsdf.rooms = (Array.isArray(payload.results) ? payload.results : []).map(function (r) {
    var room = Object.assign({}, r);
    if (r && r.room !== undefined) {
      room.roomNumber = String(r.room);
    }
    delete room.room;
    return room;
  });
  return fsdf;
}

function fsdfToLbExport(fsdf) {
  if (!fsdf || typeof fsdf !== 'object' || Array.isArray(fsdf)) {
    throw new Error('fsdfToLbExport: fsdfがオブジェクトではありません。');
  }
  // 【境界(boundary)】Envelope形式(Ver2.0)で渡された場合はここで平坦形式へ変換する。
  // 既に平坦形式(documentType/payloadを持たない)の場合はunwrapEnvelope()が冪等にそのまま返す。
  fsdf = envelopeAdapter.unwrapEnvelope(fsdf);
  var payload = Object.assign({}, fsdf);
  TOP_LEVEL_ONLY_FSDF_KEYS.forEach(function (key) { delete payload[key]; });

  payload.results = (Array.isArray(fsdf.rooms) ? fsdf.rooms : []).map(function (room) {
    var r = Object.assign({}, room);
    if (room && room.roomNumber !== undefined) {
      r.room = room.roomNumber;
    }
    delete r.roomNumber;
    ROOM_ONLY_FSDF_KEYS.forEach(function (key) { delete r[key]; });
    return r;
  });
  return payload;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    FSDF_VERSION: FSDF_VERSION,
    lbExportToFsdf: lbExportToFsdf,
    fsdfToLbExport: fsdfToLbExport,
  };
} else if (typeof window !== 'undefined') {
  window.FireFlowFsdf = window.FireFlowFsdf || {};
  window.FireFlowFsdf.FSDF_VERSION = FSDF_VERSION;
  window.FireFlowFsdf.lbExportToFsdf = lbExportToFsdf;
  window.FireFlowFsdf.fsdfToLbExport = fsdfToLbExport;
}
