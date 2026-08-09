// ユーザー指示4番の反映: OCR由来のFSDFを既存LB書き出し形式へ変換する経路では、
// キー順序やJSON文字列の完全一致を検証条件にしない。意味的に必要な情報が保持されている
// (部屋番号が一致する、OCR専用フィールドは適切に取り除かれる等)ことだけを確認する。
//
// (参考: Phase1のfsdf_roundtrip_test.jsで行った「既存の非OCRデータの完全一致」検証とは
// 目的が異なる。あちらは元々OCRフィールドを持たないデータの可逆性を保証するもので、
// 今回はOCR由来データを既存形式へ「必要な範囲で」変換する際の検証。)
'use strict';
var { runOcrIntakePipeline } = require('../run_pipeline.js');
var { fsdfToLbExport } = require('../../../fireflow_fsdf/convert/lbExportConverter.js');

var results = [];
function check(label, cond, detail) {
  results.push({ label: label, ok: !!cond });
  console.log((cond ? 'OK' : 'NG') + ': ' + label + (detail !== undefined ? ' (' + JSON.stringify(detail) + ')' : ''));
}

async function run() {
  var pipelineResult = await runOcrIntakePipeline({ propertyId: '物件A', propertyName: 'テスト物件', inspectionDate: '2026-07-26', scenario: 'messy' });
  var fsdf = pipelineResult.fsdf;
  var lbShape = fsdfToLbExport(fsdf);

  console.log('==== 意味的同値性の確認(キー順序・文字列完全一致は問わない) ====');

  check('既存LB形式へ変換した結果のresultsの件数が、FSDFのroomsの件数と一致する',
    Array.isArray(lbShape.results) && lbShape.results.length === fsdf.rooms.length);

  var roomNumbersInFsdf = fsdf.rooms.map(function (r) { return r.roomNumber; }).sort();
  var roomNumbersInLb = lbShape.results.map(function (r) { return r.room; }).sort();
  check('部屋番号の集合が意味的に一致する(順序は問わない)', JSON.stringify(roomNumbersInFsdf) === JSON.stringify(roomNumbersInLb));

  check('既存LB形式にはOCR専用フィールド(scheduleDay/timePreference/sourceStatus等)が含まれない(役割の異なるフィールドを既存形式へ持ち込まない)',
    lbShape.results.every(function (r) {
      return r.scheduleDay === undefined && r.timePreference === undefined && r.sourceStatus === undefined &&
        r.ocrStatusRaw === undefined && r.sourceMeta === undefined && r.ladderRoom === undefined;
    }));

  check('既存LB形式のresults[].roomはFSDFのroomNumberと同じ文字列値を持つ(意味的に同じ部屋を指す)',
    lbShape.results.every(function (r) {
      var match = fsdf.rooms.filter(function (fr) { return fr.roomNumber === r.room; })[0];
      return !!match;
    }));

  check('fsdfVersion/inspection/roomsといったFSDF専有のトップレベルキーは既存LB形式に残らない(役割分離)',
    lbShape.fsdfVersion === undefined && lbShape.inspection === undefined && lbShape.rooms === undefined && lbShape.batchWarnings === undefined);

  var allOk = results.every(function (r) { return r.ok; });
  console.log('\n==== semantic_equivalence_test 総合結果: ' + (allOk ? 'PASS' : 'FAIL') + ' (' + results.filter(function (r) { return r.ok; }).length + '/' + results.length + ') ====');
  if (!allOk) process.exitCode = 1;
}

run().catch(function (e) { console.error(e); process.exit(1); });
