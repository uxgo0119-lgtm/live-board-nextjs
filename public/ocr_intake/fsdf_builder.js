// OCR Normalizerの出力(正規化済み部屋データ)からFSDFを組み立てる。
//
// 【重要】OCR生結果(mock_ocr_provider.jsの出力)を直接受け取らない。必ずnormalize/配下を
// 経由した正規化済みデータだけを受け取る(設計方針: OCR Raw Result → OCR Normalizer → FSDF)。
// 表示色・セル位置は一切持たせない(FSDFの一貫した設計原則)。
//
// 【Ver2.0(Envelope化)対応】本ファイルはFSDFの唯一の「生成元」(fresh producer)であるため、
// 平坦形式(Ver1.x)を組み立てたあとでラップするのではなく、最初からEnvelope形状
// ({fsdfVersion:'2.0', documentType:'roomInspectionSession', property, payload})を直接
// 組み立てる。呼び出し元(lb_tool/ocr_intake/run_pipeline.js)がこのEnvelopeを受け取り、
// validateFsdf()(Envelope形式のみ受け付ける)で検証したうえで、既存の平坦形式を前提とする
// 下流ロジック(OCR確認画面等)向けにunwrapEnvelope()で平坦ビューへ変換する
// (「境界でだけ変換する」という設計方針。run_pipeline.js参照)。
'use strict';

// Node(require)とブラウザ(<script src>、window.FireFlowFsdf名前空間経由)の両方に対応する。
var DOCUMENT_TYPES, ENVELOPE_FSDF_VERSION;
if (typeof module !== 'undefined' && module.exports) {
  DOCUMENT_TYPES = require('../../fireflow_fsdf/schema/documentTypes.js').DOCUMENT_TYPES;
  ENVELOPE_FSDF_VERSION = require('../../fireflow_fsdf/convert/envelopeAdapter.js').ENVELOPE_FSDF_VERSION;
} else if (typeof window !== 'undefined') {
  DOCUMENT_TYPES = (window.FireFlowFsdf || {}).DOCUMENT_TYPES;
  ENVELOPE_FSDF_VERSION = (window.FireFlowFsdf || {}).ENVELOPE_FSDF_VERSION;
}

// normalizedResult: normalizeInspectionScheduleSheet()の戻り値そのまま
//   ({ rooms: [...], totalScheduleDays, warnings: [...] })。
// meta: { propertyId, propertyName, inspectionDate, sourceFile }
// 戻り値: FSDF Envelopeオブジェクト(fireflow_fsdf/schema/fsdf.schema.json準拠。Ver2.0)。
function buildFsdfFromNormalized(normalizedResult, meta) {
  meta = meta || {};
  var rooms = (normalizedResult.rooms || []).map(function (r) {
    return {
      roomNumber: r.roomNumber,
      roomNumberRaw: r.roomNumberRaw,
      scheduleDay: r.scheduleDay,
      timePreference: r.timePreference,
      ladderRoom: r.ladderRoom,
      memo: r.memo,
      ocrStatusRaw: r.ocrStatusRaw,
      sourceStatus: r.sourceStatus,
      // status(既存LBの点検実施ステータス)はここでは設定しない。点検予定表OCRの時点では
      // まだ点検自体は行われていないため、既存statusの意味を壊さないよう未設定のままにする。
      sourceMeta: {
        sourceType: 'ocr_paper_sheet',
        sourceFile: meta.sourceFile || null,
        ocrConfidence: r.ocrConfidence || {},
        reviewedBy: null,
        reviewedAt: null,
        warnings: r.warnings || [],
      },
    };
  });

  return {
    fsdfVersion: ENVELOPE_FSDF_VERSION,
    documentType: DOCUMENT_TYPES.ROOM_INSPECTION_SESSION,
    property: {
      id: meta.propertyId || null,
      name: meta.propertyName || '',
      inspectionDate: meta.inspectionDate || null,
    },
    payload: {
      inspection: {
        date: meta.inspectionDate || null,
        totalScheduleDays: normalizedResult.totalScheduleDays,
      },
      rooms: rooms,
      // 帳票全体に関わる警告(工程日数の推定など)。部屋単位の警告はrooms[].sourceMeta.warningsへ。
      batchWarnings: normalizedResult.warnings || [],
    },
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { buildFsdfFromNormalized: buildFsdfFromNormalized };
} else if (typeof window !== 'undefined') {
  window.FireFlowOcrIntake = window.FireFlowOcrIntake || {};
  window.FireFlowOcrIntake.buildFsdfFromNormalized = buildFsdfFromNormalized;
}
