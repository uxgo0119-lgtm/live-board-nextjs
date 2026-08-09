// Phase3 完了条件の検証: mock OCR → Normalizer → FSDF → OCR確認画面ロジック(フィルタ/要確認判定/
// 編集/バリデーション/確定) → 既存LBへの反映、までの一気通貫テスト。
// lb_tool/ocr_intake/test/pipeline_test.js(Phase2)の続きとして、Phase3で追加したocr_confirm/
// 配下のロジックを繋いで検証する。
'use strict';
var assert = require('assert');
var path = require('path');

var runPipeline = require(path.join(__dirname, '..', '..', 'ocr_intake', 'run_pipeline.js'));
var reviewState = require('../review_state.js');
var filters = require('../filters.js');
var rowViewModel = require('../row_view_model.js');
var editTracker = require('../review_edit_tracker.js');
var validateBeforeConfirm = require('../validate_before_confirm.js');
var applyToLb = require('../apply_confirmed_to_lb.js');
var fsdfValidator = require(path.join(__dirname, '..', '..', '..', 'fireflow_fsdf', 'validators', 'validateFsdf.js'));
// 【Ver2.0(Envelope化)対応】ocr_confirm/配下の内部ロジックは意図的に平坦形式(Ver1.x)の
// FSDFのまま操作し続ける(run_pipeline.jsの境界(boundary)でEnvelope→平坦形式へ変換済みの
// ものを受け取るため。詳細はrun_pipeline.jsのコメント参照)。一方validateFsdf()自体は
// Envelope形式のみを受け付けるようになったため、平坦形式のconfirmedFsdfを検証する際は
// wrapAsEnvelope()で明示的にEnvelope化してから渡す。
var { wrapAsEnvelope } = require(path.join(__dirname, '..', '..', '..', 'fireflow_fsdf', 'convert', 'envelopeAdapter.js'));

function run() {
  var results = [];
  function check(label, cond, detail) {
    results.push({ label: label, ok: !!cond, detail: detail || '' });
    console.log((cond ? 'OK' : 'NG') + ': ' + label + (detail ? ' (' + detail + ')' : ''));
  }

  runPipeline.runOcrIntakePipeline({ propertyId: '物件A', propertyName: 'サンプル物件', inspectionDate: '2026-07-26', scenario: 'messy' })
    .then(function (pipelineResult) {
      var fsdf = pipelineResult.fsdf;
      check('Phase2パイプラインからFSDFが生成される', !!fsdf && Array.isArray(fsdf.rooms) && fsdf.rooms.length > 0);
      check('FSDFのバージョンはVer1.2以上', parseFloat(fsdf.fsdfVersion) >= 1.2, fsdf.fsdfVersion);

      // ---- ①一覧のフィルタリング: 要確認のみが初期表示に優先される ----
      var initial = filters.pickInitialFilter(fsdf.rooms, {});
      check('messyシナリオでは要確認項目が1件以上あり、初期フィルタはneeds_review', initial.filter === filters.FILTER_TYPES.NEEDS_REVIEW && initial.rooms.length > 0,
        initial.filter + ' / ' + initial.rooms.length + '件');

      // ---- ②低信頼度・warningの視覚判別(行表示モデル) ----
      var rowModels = rowViewModel.buildRowViewModels(fsdf.rooms, {});
      var hasSevereRow = rowModels.some(function (rm) { return rm.colorClass === rowViewModel.ROW_COLOR_CLASS.SEVERE; });
      var hasLowConfRow = rowModels.some(function (rm) { return rm.colorClass === rowViewModel.ROW_COLOR_CLASS.LOW_CONFIDENCE; });
      check('messyシナリオには赤系(重大)行が存在する', hasSevereRow);
      check('messyシナリオには黄色(低信頼度)行が存在する', hasLowConfRow);

      // ---- ③項目を修正できる(1519号室: 時間帯矛盾を修正) ----
      var idx1519 = fsdf.rooms.findIndex(function (r) { return r.roomNumber === '1519'; });
      check('矛盾のある1519号室がFSDFに存在する', idx1519 !== -1);
      var room1519 = fsdf.rooms[idx1519];
      check('1519号室は修正前、時間帯矛盾により要確認', reviewState.needsReview(room1519, {}).reasons.indexOf('time_conflict') !== -1);

      var fixed1519 = editTracker.applyRoomEdits(room1519, { 'timePreference.period': 'PM' }, '2026-07-26T05:00:00Z');
      check('修正後は時間帯矛盾が解消される', reviewState.hasTimeConflict(fixed1519) === false);
      check('修正内容が編集履歴(reviewEdits)に記録される', fixed1519.sourceMeta.reviewEdits.some(function (e) { return e.field === 'timePreference.period' && e.before === 'AM' && e.after === 'PM'; }),
        JSON.stringify(fixed1519.sourceMeta.reviewEdits));
      check('editedFieldsに記録され、Normalizer再実行時に上書きしない規約が適用できる', editTracker.isFieldEdited(fixed1519, 'timePreference.period') === true);

      var rooms2 = fsdf.rooms.slice();
      rooms2[idx1519] = fixed1519;
      var fsdfAfterEdit = Object.assign({}, fsdf, { rooms: rooms2 });

      // ---- ④確定前バリデーション: illegible(1518号室)が未確認のため、確定はブロックされる ----
      var idx1518 = fsdfAfterEdit.rooms.findIndex(function (r) { return r.roomNumber === '1518'; });
      check('判読不能な1518号室がFSDFに存在する', idx1518 !== -1 && fsdfAfterEdit.rooms[idx1518].sourceStatus === 'illegible');

      var v1 = validateBeforeConfirm.validateBeforeConfirm(fsdfAfterEdit);
      check('illegible(1518)が未確認のため確定はブロックされる', v1.ok === false && v1.blockingIssues.some(function (i) { return i.code === 'illegible_unreviewed'; }));

      // ---- ⑤明示的な確認操作をした上で確定する ----
      var v2 = validateBeforeConfirm.validateBeforeConfirm(fsdfAfterEdit, { acknowledgedIllegibleRooms: ['1518'] });
      check('1518号室を明示的に確認済みとして扱えば確定できる', v2.ok === true);

      var nowIso = '2026-07-26T06:00:00Z';
      var confirmedRooms = fsdfAfterEdit.rooms.map(function (r) { return editTracker.markRoomReviewed(r, 'テスト担当者', nowIso); });
      var confirmedFsdf = Object.assign({}, fsdfAfterEdit, { rooms: confirmedRooms });

      check('確定後、全部屋にreviewedBy/reviewedAtが設定される', confirmedFsdf.rooms.every(function (r) { return r.sourceMeta.reviewedBy === 'テスト担当者' && r.sourceMeta.reviewedAt === nowIso; }));
      check('確定後もeditedFields(1519号室)は保持され、値も保持されている', confirmedFsdf.rooms[idx1519].timePreference.period === 'PM' && confirmedFsdf.rooms[idx1519].sourceMeta.editedFields.indexOf('timePreference.period') !== -1);

      var fsdfValidation = fsdfValidator.validateFsdf(wrapAsEnvelope(confirmedFsdf));
      check('確定済みFSDFはfsdf.schema.json(Envelope化・wrapAsEnvelope経由)のバリデータでerrorsが無い', fsdfValidation.errors.length === 0, JSON.stringify(fsdfValidation.errors));

      // ---- Ver2.0(Envelope化)対応の追加確認: Envelope形状のFSDFがOCR確認画面のパイプラインを
      // 通っても、内部ロジック(フィルタ/行表示/確定前バリデーション等)が従来どおり動作すること
      // (run_pipeline.jsの境界(boundary)がEnvelope→平坦形式への変換を正しく行っている証拠) ----
      check('pipelineResult.fsdfは(run_pipeline.jsの境界で変換済みのため)平坦形式のまま渡ってくる(documentType/payloadを持たない)',
        fsdf.documentType === undefined && fsdf.payload === undefined);

      // ---- ⑥確定済みデータを既存LBへ反映できる ----
      var knownRoomNumbers = ['1512', '1513', '1514', '1515', '1516', '1517', '1518', '1519', '1520', '1521'];
      var lbResult = applyToLb.applyConfirmedFsdfToLb(confirmedFsdf, { stampData: {}, ladderRooms: [], knownRoomNumbers: knownRoomNumbers });
      check('確定済みFSDFの全部屋がstampDataへ反映される', lbResult.appliedRooms.length === confirmedFsdf.rooms.length, lbResult.appliedRooms.length + ' / ' + confirmedFsdf.rooms.length);
      check('1520号室(避難はしご対象)がladderRoomsへ追加される', lbResult.ladderRooms.indexOf('1520') !== -1);
      check('既存statusフィールドはstampEntryに一切含まれない(既存statusを上書きしない)',
        Object.keys(lbResult.stampData).every(function (rn) { return !Object.prototype.hasOwnProperty.call(lbResult.stampData[rn], 'status'); }));

      var allOk = results.every(function (r) { return r.ok; });
      console.log('\n==== ocr_confirm_pipeline_test 総合結果: ' + (allOk ? 'PASS' : 'FAIL') + ' (' + results.filter(function (r) { return r.ok; }).length + '/' + results.length + ') ====');
      if (!allOk) process.exitCode = 1;
    })
    .catch(function (err) {
      console.error('テスト実行中にエラー: ', err);
      process.exitCode = 1;
    });
}

run();
