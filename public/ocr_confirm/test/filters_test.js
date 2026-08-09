// filters.js 単体テスト。
'use strict';
var filters = require('../filters.js');

function room(overrides) {
  return Object.assign({ roomNumber: '101', scheduleDay: 1, timePreference: {}, sourceMeta: { ocrConfidence: { roomNumber: 0.95 } } }, overrides);
}

function run() {
  var results = [];
  function check(label, cond, detail) {
    results.push({ label: label, ok: !!cond, detail: detail || '' });
    console.log((cond ? 'OK' : 'NG') + ': ' + label + (detail ? ' (' + detail + ')' : ''));
  }

  var rooms = [
    room({ roomNumber: '1512' }), // 高信頼・問題なし
    room({ roomNumber: '1513', sourceMeta: { ocrConfidence: { roomNumber: 0.5 } } }), // 低信頼
    room({ roomNumber: '1514', sourceMeta: { ocrConfidence: { roomNumber: 0.95 }, warnings: [{ field: 'x', message: 'm' }] } }), // warningあり
    room({ roomNumber: '1515', sourceStatus: 'illegible' }), // 判読不能
    room({ roomNumber: '1516', sourceMeta: { ocrConfidence: { roomNumber: 0.95 }, reviewedAt: '2026-07-26T00:00:00Z', reviewedBy: 'テスト' } }), // 確認済み
  ];

  var ctx = { confidenceThreshold: 0.85, duplicateRoomNumbers: [] };

  var needsReviewRooms = filters.applyFilter(rooms, filters.FILTER_TYPES.NEEDS_REVIEW, ctx);
  check('要確認フィルタは低信頼/warning/illegibleの3件を返す', needsReviewRooms.length === 3,
    needsReviewRooms.map(function (r) { return r.roomNumber; }).join(','));

  var lowConfRooms = filters.applyFilter(rooms, filters.FILTER_TYPES.LOW_CONFIDENCE, ctx);
  check('低信頼度フィルタは1513のみ', lowConfRooms.length === 1 && lowConfRooms[0].roomNumber === '1513');

  var warnRooms = filters.applyFilter(rooms, filters.FILTER_TYPES.HAS_WARNING, ctx);
  check('warningありフィルタは1514のみ', warnRooms.length === 1 && warnRooms[0].roomNumber === '1514');

  var illegibleRooms = filters.applyFilter(rooms, filters.FILTER_TYPES.ILLEGIBLE, ctx);
  check('判読不能フィルタは1515のみ', illegibleRooms.length === 1 && illegibleRooms[0].roomNumber === '1515');

  var unprocessedRooms = filters.applyFilter(rooms, filters.FILTER_TYPES.UNPROCESSED, ctx);
  check('未処理フィルタは1516以外の4件', unprocessedRooms.length === 4);

  var reviewedRooms = filters.applyFilter(rooms, filters.FILTER_TYPES.REVIEWED, ctx);
  check('確認済みフィルタは1516のみ', reviewedRooms.length === 1 && reviewedRooms[0].roomNumber === '1516');

  var allRooms = filters.applyFilter(rooms, filters.FILTER_TYPES.ALL, ctx);
  check('全件フィルタは5件すべて', allRooms.length === 5);

  var counts = filters.countByFilter(rooms, ctx);
  check('countByFilterが全フィルタタイプの件数を返す', counts.needs_review === 3 && counts.all === 5, JSON.stringify(counts));

  // ---- pickInitialFilter ----
  var initial = filters.pickInitialFilter(rooms, ctx);
  check('要確認が1件以上ある場合、初期フィルタはneeds_review', initial.filter === filters.FILTER_TYPES.NEEDS_REVIEW && initial.fallback === false);

  var allCleanRooms = [room({ roomNumber: '201' }), room({ roomNumber: '202', sourceMeta: { ocrConfidence: { roomNumber: 0.95 }, reviewedAt: '2026-07-26T00:00:00Z', reviewedBy: 'x' } })];
  var initial2 = filters.pickInitialFilter(allCleanRooms, ctx);
  check('要確認が0件の場合、初期フィルタは全件表示にフォールバックする', initial2.filter === filters.FILTER_TYPES.ALL && initial2.fallback === true, JSON.stringify(initial2.filter));

  var allReviewedRooms = [room({ roomNumber: '301', sourceMeta: { ocrConfidence: { roomNumber: 0.95 }, reviewedAt: '2026-07-26T00:00:00Z', reviewedBy: 'x' } })];
  var initial3 = filters.pickInitialFilter(allReviewedRooms, ctx);
  check('全件確認済みの場合allReviewed=trueが分かる', initial3.allReviewed === true);

  // ---- Phase4接続: context.roomCellMapがフィルタ結果まで伝播すること ----
  var templateRooms = [
    room({ roomNumber: '1512' }), // テンプレートに存在
    room({ roomNumber: '9999' }), // テンプレートに存在しない
  ];
  var roomCellMap = { '1512': { cell: 'C15', sheet: '3F' } };
  var ctxWithTemplate = { confidenceThreshold: 0.85, duplicateRoomNumbers: [], roomCellMap: roomCellMap };
  var needsReviewWithTemplate = filters.applyFilter(templateRooms, filters.FILTER_TYPES.NEEDS_REVIEW, ctxWithTemplate);
  check('roomCellMapを渡すとテンプレートに無い部屋(9999)が要確認フィルタに現れる', needsReviewWithTemplate.length === 1 && needsReviewWithTemplate[0].roomNumber === '9999', JSON.stringify(needsReviewWithTemplate.map(function (r) { return r.roomNumber; })));

  var needsReviewWithoutTemplate = filters.applyFilter(templateRooms, filters.FILTER_TYPES.NEEDS_REVIEW, ctx);
  check('roomCellMapを渡さない場合は9999も要確認にならない(判定不能=falseのまま)', needsReviewWithoutTemplate.length === 0, JSON.stringify(needsReviewWithoutTemplate.map(function (r) { return r.roomNumber; })));

  var allOk = results.every(function (r) { return r.ok; });
  console.log('\n==== filters_test 総合結果: ' + (allOk ? 'PASS' : 'FAIL') + ' (' + results.filter(function (r) { return r.ok; }).length + '/' + results.length + ') ====');
  if (!allOk) process.exitCode = 1;
}

run();
