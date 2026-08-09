// row_view_model.js 単体テスト。
'use strict';
var rvm = require('../row_view_model.js');

function run() {
  var results = [];
  function check(label, cond, detail) {
    results.push({ label: label, ok: !!cond, detail: detail || '' });
    console.log((cond ? 'OK' : 'NG') + ': ' + label + (detail ? ' (' + detail + ')' : ''));
  }

  // ---- 高信頼・warningなし: 通常表示 ----
  var okRoom = { roomNumber: '1512', scheduleDay: 2, timePreference: { period: 'PM', time: '13:00' }, memo: '', sourceMeta: { ocrConfidence: { roomNumber: 0.98 } } };
  var vm1 = rvm.buildRowViewModel(okRoom, { confidenceThreshold: 0.85, duplicateRoomNumbers: [] });
  check('高信頼・warningなしはOK色', vm1.colorClass === rvm.ROW_COLOR_CLASS.OK, vm1.colorClass);
  check('scheduleDayLabelが「2日目」になる', vm1.scheduleDayLabel === '2日目');
  check('timeLabelにPMと時刻が含まれる', vm1.timeLabel.indexOf('PM') !== -1 && vm1.timeLabel.indexOf('13:00') !== -1, vm1.timeLabel);
  check('needsReview=false', vm1.needsReview === false);

  // ---- 低信頼度: 黄色 ----
  var lowConfRoom = { roomNumber: '1513', scheduleDay: 1, timePreference: {}, sourceMeta: { ocrConfidence: { roomNumber: 0.5 } } };
  var vm2 = rvm.buildRowViewModel(lowConfRoom, { confidenceThreshold: 0.85, duplicateRoomNumbers: [] });
  check('低信頼度は黄色クラス', vm2.colorClass === rvm.ROW_COLOR_CLASS.LOW_CONFIDENCE, vm2.colorClass);
  check('minConfidenceLabelがパーセント表示', vm2.minConfidenceLabel === '50%');

  // ---- illegible: 赤系 ----
  var illegibleRoom = { roomNumber: '1518', sourceStatus: 'illegible', timePreference: {}, sourceMeta: {} };
  var vm3 = rvm.buildRowViewModel(illegibleRoom, { confidenceThreshold: 0.85, duplicateRoomNumbers: [] });
  check('illegibleは赤系(severe)クラス', vm3.colorClass === rvm.ROW_COLOR_CLASS.SEVERE, vm3.colorClass);
  check('statusLabelに判読不能が含まれる', vm3.statusLabel.indexOf('判読不能') !== -1);

  // ---- 時間帯矛盾: 赤系 ----
  var conflictRoom = { roomNumber: '1519', scheduleDay: 2, timePreference: { period: 'AM', time: '15:00' }, sourceMeta: {} };
  var vm4 = rvm.buildRowViewModel(conflictRoom, { confidenceThreshold: 0.85, duplicateRoomNumbers: [] });
  check('時間帯矛盾は赤系クラス', vm4.colorClass === rvm.ROW_COLOR_CLASS.SEVERE, vm4.colorClass);

  // ---- 確認済み: チェック表示 ----
  var reviewedRoom = { roomNumber: '1516', scheduleDay: 1, timePreference: {}, sourceMeta: { ocrConfidence: { roomNumber: 0.5 }, reviewedAt: '2026-07-26T00:00:00Z', reviewedBy: 'テスト' } };
  var vm5 = rvm.buildRowViewModel(reviewedRoom, { confidenceThreshold: 0.85, duplicateRoomNumbers: [] });
  check('確認済みはreviewedクラス(低信頼度でも優先)', vm5.colorClass === rvm.ROW_COLOR_CLASS.REVIEWED, vm5.colorClass);
  check('reviewed=true', vm5.reviewed === true);
  check('reviewedByが引き継がれる', vm5.reviewedBy === 'テスト');

  // ---- ステータスラベル ----
  var passRoom = { roomNumber: '1513', sourceStatus: 'pass', ocrStatusRaw: 'PASS', timePreference: {}, sourceMeta: {} };
  var vm6 = rvm.buildRowViewModel(passRoom, {});
  check('PASSは「PASS(確認済み)」ラベルになる', vm6.statusLabel.indexOf('PASS') !== -1);

  // ---- scheduleDay不明の表示 ----
  var noScheduleRoom = { roomNumber: '1520', timePreference: {}, sourceMeta: {} };
  var vm7 = rvm.buildRowViewModel(noScheduleRoom, {});
  check('scheduleDay不明は「(不明)」表示', vm7.scheduleDayLabel === '(不明)');

  // ---- buildRowViewModels(配列一括) ----
  var models = rvm.buildRowViewModels([okRoom, lowConfRoom, illegibleRoom], { confidenceThreshold: 0.85 });
  check('buildRowViewModelsは配列内の全部屋分を返す', models.length === 3);

  // ---- Phase4接続: テンプレートに無い部屋はsevere(赤系)扱いになる ----
  var roomCellMap = { '1512': { cell: 'C15', sheet: '3F' } };
  var notInTemplateRoom = { roomNumber: '9999', scheduleDay: 1, timePreference: {}, sourceMeta: { ocrConfidence: { roomNumber: 0.99 } } };
  var vm8 = rvm.buildRowViewModel(notInTemplateRoom, { confidenceThreshold: 0.85, duplicateRoomNumbers: [], roomCellMap: roomCellMap });
  check('テンプレートに無い部屋はneedsReview=trueかつnot_in_template理由を持つ', vm8.needsReview === true && vm8.reviewReasons.indexOf('not_in_template') !== -1, JSON.stringify(vm8.reviewReasons));
  check('テンプレートに無い部屋は赤系(severe)クラス', vm8.colorClass === rvm.ROW_COLOR_CLASS.SEVERE, vm8.colorClass);

  var inTemplateRoom = { roomNumber: '1512', scheduleDay: 1, timePreference: {}, sourceMeta: { ocrConfidence: { roomNumber: 0.99 } } };
  var vm9 = rvm.buildRowViewModel(inTemplateRoom, { confidenceThreshold: 0.85, duplicateRoomNumbers: [], roomCellMap: roomCellMap });
  check('テンプレートに存在する部屋はOK色のまま', vm9.colorClass === rvm.ROW_COLOR_CLASS.OK, vm9.colorClass);

  var allOk = results.every(function (r) { return r.ok; });
  console.log('\n==== row_view_model_test 総合結果: ' + (allOk ? 'PASS' : 'FAIL') + ' (' + results.filter(function (r) { return r.ok; }).length + '/' + results.length + ') ====');
  if (!allOk) process.exitCode = 1;
}

run();
