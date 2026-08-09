// Phase2の完了条件そのもの: 画像/PDF選択 → mock OCR結果取得 → OCR Normalizerで正規化 →
// FSDF生成 → 生成内容を確認できる、という一連のパイプラインを繋ぐ。
//
// 【重要】ここで言う「画像/PDF選択」はPhase2の段階ではmock_ocr_provider.jsへの入力
// (ファイル名等のメタ情報のみ)を意味する。実際の画像解析はPhase7で実OCR接続する際に
// mock_ocr_provider.jsを実プロバイダへ差し替えることで対応する。このrunOcrIntakePipeline()の
// 関数シグネチャ(ocrProviderを差し替え可能にした第2引数)は、その差し替えを見据えたもの。
'use strict';

// Node(require)とブラウザ(<script src>、window.FireFlowOcrIntake/FireFlowFsdf名前空間経由)の
// 両方に対応する。
var getMockOcrRawResult, normalizeInspectionScheduleSheet, buildFsdfFromNormalized, validateFsdf, unwrapEnvelope;
if (typeof module !== 'undefined' && module.exports) {
  getMockOcrRawResult = require('./mock_ocr_provider.js').getMockOcrRawResult;
  normalizeInspectionScheduleSheet = require('./normalize/normalizeInspectionScheduleSheet.js').normalizeInspectionScheduleSheet;
  buildFsdfFromNormalized = require('./fsdf_builder.js').buildFsdfFromNormalized;
  validateFsdf = require('../../fireflow_fsdf/validators/validateFsdf.js').validateFsdf;
  unwrapEnvelope = require('../../fireflow_fsdf/convert/envelopeAdapter.js').unwrapEnvelope;
} else if (typeof window !== 'undefined') {
  var _oi = window.FireFlowOcrIntake || {};
  getMockOcrRawResult = _oi.getMockOcrRawResult;
  normalizeInspectionScheduleSheet = _oi.normalizeInspectionScheduleSheet;
  buildFsdfFromNormalized = _oi.buildFsdfFromNormalized;
  validateFsdf = (window.FireFlowFsdf || {}).validateFsdf;
  unwrapEnvelope = (window.FireFlowFsdf || {}).unwrapEnvelope;
}

// input: { sourceFile, scenario, propertyId, propertyName, inspectionDate, knownTotalScheduleDays }
// ocrProvider: 省略時はmock_ocr_provider.jsを使う。Phase7で実プロバイダに差し替える際はここへ渡す。
// 戻り値: Promise<{ fsdf, normalized, validation, rawOcrResult }>
//
// 【Ver2.0(Envelope化)対応・境界(boundary)】fsdf_builder.jsはEnvelope形状(Ver2.0)のFSDFを
// 直接生成する。ここでEnvelopeのままvalidateFsdf()(Envelope形式のみ受け付ける)で検証した
// 直後にunwrapEnvelope()で平坦ビューへ変換し、以降(この関数の戻り値resultResult.fsdf、
// summarizePipelineResult()、そしてこの結果を受け取るOCR確認画面
// (lb_tool/ocr_confirm/、lb_tool/index.htmlのshowOcrScheduleConfirmResult()))は
// 全て従来どおり平坦形式のFSDFだけを見ればよいようにする。この関数がEnvelope⇔平坦形式の
// 変換を行う唯一の境界であり、下流(OCR確認画面・index.html)には一切手を加えていない。
function runOcrIntakePipeline(input, ocrProvider) {
  input = input || {};
  var provider = ocrProvider || getMockOcrRawResult;

  return Promise.resolve(provider(input)).then(function (rawOcrResult) {
    var normalized = normalizeInspectionScheduleSheet(rawOcrResult.rawRooms, { knownTotalScheduleDays: input.knownTotalScheduleDays });
    var fsdfEnvelope = buildFsdfFromNormalized(normalized, {
      propertyId: input.propertyId,
      propertyName: input.propertyName,
      inspectionDate: input.inspectionDate,
      sourceFile: rawOcrResult.sourceFile,
    });
    var validation = validateFsdf(fsdfEnvelope);
    var fsdf = unwrapEnvelope(fsdfEnvelope);
    return { fsdf: fsdf, normalized: normalized, validation: validation, rawOcrResult: rawOcrResult };
  });
}

// 「生成内容を確認できる」ための人間可読な要約を作る(Phase2の暫定表示用。本格的な確認画面は
// Phase3で実装する)。
function summarizePipelineResult(result) {
  var lines = [];
  lines.push('=== FSDF生成結果の確認(簡易表示。正式なOCR確認画面はPhase3で実装予定) ===');
  lines.push('取込元ファイル: ' + (result.rawOcrResult.sourceFile || '(不明)'));
  lines.push('工程日数: 全' + result.fsdf.inspection.totalScheduleDays + '日');
  lines.push('部屋数: ' + result.fsdf.rooms.length + '件');
  lines.push('FSDFバリデーション: ' + (result.validation.valid ? 'valid' : 'invalid') +
    '(errors:' + result.validation.errors.length + ', warnings:' + result.validation.warnings.length + ')');
  if (result.fsdf.batchWarnings && result.fsdf.batchWarnings.length) {
    lines.push('--- 帳票全体の警告 ---');
    result.fsdf.batchWarnings.forEach(function (w) { lines.push('  [' + (w.severity || 'warning') + '] ' + w.message); });
  }
  lines.push('--- 部屋ごとの内容 ---');
  result.fsdf.rooms.forEach(function (r) {
    var tp = r.timePreference || {};
    var parts = [r.roomNumber + '号室'];
    if (r.scheduleDay) parts.push(r.scheduleDay + '日目');
    if (tp.period && tp.time) parts.push(tp.period + ' ' + tp.time);
    if (r.sourceStatus) parts.push('status=' + r.sourceStatus + (r.ocrStatusRaw ? '(元: ' + r.ocrStatusRaw + ')' : ''));
    if (r.ladderRoom) parts.push('避難はしご対象');
    lines.push('  ' + parts.join(' / '));
    (r.sourceMeta.warnings || []).forEach(function (w) { lines.push('    ⚠ [' + (w.severity || 'warning') + '] ' + w.message); });
  });
  return lines.join('\n');
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { runOcrIntakePipeline: runOcrIntakePipeline, summarizePipelineResult: summarizePipelineResult };
} else if (typeof window !== 'undefined') {
  window.FireFlowOcrIntake = window.FireFlowOcrIntake || {};
  window.FireFlowOcrIntake.runOcrIntakePipeline = runOcrIntakePipeline;
  window.FireFlowOcrIntake.summarizePipelineResult = summarizePipelineResult;
}
