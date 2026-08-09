// Phase2完了条件の検証: mock OCR → OCR Normalizer → FSDF生成、を一気通貫で確認する。
// あわせて、既存statusとsourceStatusが混同されないこと(PASSがdoneに化けないこと)、
// FSDFがvalidateFsdfでvalid=trueになること、判読不能項目が自動確定されないことを確認する。
'use strict';
var { runOcrIntakePipeline, summarizePipelineResult } = require('../run_pipeline.js');

var results = [];
function check(label, cond, detail) {
  results.push({ label: label, ok: !!cond });
  console.log((cond ? 'OK' : 'NG') + ': ' + label + (detail !== undefined ? ' (' + JSON.stringify(detail) + ')' : ''));
}

function findRoom(fsdf, roomNumber) {
  return fsdf.rooms.filter(function (r) { return r.roomNumber === roomNumber; })[0];
}

async function run() {
  console.log('==== ケース1: cleanシナリオ(表記揺れが少ない素直なケース) ====');
  var cleanResult = await runOcrIntakePipeline({ propertyId: '物件A', propertyName: 'テスト物件', inspectionDate: '2026-07-26', scenario: 'clean' });
  check('FSDFがvalidateFsdfでvalid=trueになる', cleanResult.validation.valid, cleanResult.validation.errors);
  check('部屋数が2件生成される', cleanResult.fsdf.rooms.length === 2);
  var room1512 = findRoom(cleanResult.fsdf, '1512');
  check('1512号室がscheduleDay=2, PM 13:00として正しく取り込まれる',
    room1512 && room1512.scheduleDay === 2 && room1512.timePreference.period === 'PM' && room1512.timePreference.time === '13:00');
  check('OCR由来のroomsには既存statusフィールドが設定されない(点検実施前のためstatusは未設定のまま)',
    cleanResult.fsdf.rooms.every(function (r) { return r.status === undefined; }));

  console.log('\n==== ケース2: messyシナリオ(表記揺れ・矛盾・判読不能を含む) ====');
  var messyResult = await runOcrIntakePipeline({ propertyId: '物件A', propertyName: 'テスト物件', inspectionDate: '2026-07-26', scenario: 'messy' });
  check('FSDFがvalidateFsdfでvalid=trueになる(警告はあってもエラーにはならない)', messyResult.validation.valid, messyResult.validation.errors);

  var room1513 = findRoom(messyResult.fsdf, '1513');
  check('PASSはsourceStatus="pass"になり、既存status("done"等)へは絶対に変換されない',
    room1513 && room1513.sourceStatus === 'pass' && room1513.status === undefined && room1513.ocrStatusRaw === 'PASS');

  var room1512m = findRoom(messyResult.fsdf, '1512');
  check('全角の部屋番号"１５１２"が半角"1512"に正規化される', !!room1512m);
  check('"午後"+"1:00"(12時間表記)が24時間表記"13:00"へ統一される', room1512m.timePreference.period === 'PM' && room1512m.timePreference.time === '13:00');

  var room1517 = findRoom(messyResult.fsdf, '1517');
  check('未知の特殊状態"リフォーム中"はotherとして保持され、要確認の警告が残る(自動確定しない)',
    room1517 && room1517.sourceStatus === 'other' && room1517.ocrStatusRaw === 'リフォーム中' &&
    room1517.sourceMeta.warnings.some(function (w) { return /未知/.test(w.message); }));

  var room1518 = findRoom(messyResult.fsdf, '1518');
  check('ステータス欄が判読不能(空文字)の部屋はillegibleとなり、警告が残る(何かを勝手に確定しない)',
    room1518 && room1518.sourceStatus === 'illegible' && room1518.sourceMeta.warnings.length > 0);

  var room1519 = findRoom(messyResult.fsdf, '1519');
  check('時間帯(AM)と時刻(15:00)の矛盾が検出され、自動修正されず警告として残る',
    room1519 && room1519.sourceMeta.warnings.some(function (w) { return /矛盾/.test(w.message); }));

  var room1521 = findRoom(messyResult.fsdf, '1521');
  check('工程日が解析不能な部屋は、scheduleDay=nullのまま警告が残る(勝手に1日目などと決めつけない)',
    room1521 && room1521.scheduleDay === null && room1521.sourceMeta.warnings.some(function (w) { return w.field === 'scheduleDay'; }));

  check('部屋番号が読めない行はFSDFのroomsに含まれず、帳票全体の警告(error)として記録される',
    messyResult.fsdf.rooms.every(function (r) { return r.roomNumber !== ''; }) &&
    messyResult.fsdf.batchWarnings.some(function (w) { return w.severity === 'error'; }));

  check('全ての部屋にsourceMeta.sourceType="ocr_paper_sheet"とsourceFileが設定される',
    messyResult.fsdf.rooms.every(function (r) { return r.sourceMeta.sourceType === 'ocr_paper_sheet' && r.sourceMeta.sourceFile; }));
  check('reviewedBy/reviewedAtは未確認(null)のまま(Phase3のOCR確認画面で確定する設計)',
    messyResult.fsdf.rooms.every(function (r) { return r.sourceMeta.reviewedBy === null && r.sourceMeta.reviewedAt === null; }));

  console.log('\n==== ケース3: 「生成内容を確認できる」ことの確認(Phase2完了条件) ====');
  var summary = summarizePipelineResult(messyResult);
  check('人間可読な要約が生成でき、部屋番号・工程日・時間帯・ステータスが含まれる',
    typeof summary === 'string' && summary.indexOf('1512号室') !== -1 && summary.indexOf('status=pass') !== -1);

  console.log('\n' + summary.split('\n').slice(0, 3).join('\n') + '\n... (以下略、上記summarizePipelineResultの全文は別途確認可能)');

  var allOk = results.every(function (r) { return r.ok; });
  console.log('\n==== pipeline_test 総合結果: ' + (allOk ? 'PASS' : 'FAIL') + ' (' + results.filter(function (r) { return r.ok; }).length + '/' + results.length + ') ====');
  if (!allOk) process.exitCode = 1;
}

run().catch(function (e) { console.error(e); process.exit(1); });
