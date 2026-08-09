// apply_confirmed_to_lb.js 単体テスト。
'use strict';
var adapter = require('../apply_confirmed_to_lb.js');

function run() {
  var results = [];
  function check(label, cond, detail) {
    results.push({ label: label, ok: !!cond, detail: detail || '' });
    console.log((cond ? 'OK' : 'NG') + ': ' + label + (detail ? ' (' + detail + ')' : ''));
  }

  var reviewedMeta = { reviewedBy: 'テスト太郎', reviewedAt: '2026-07-26T00:00:00Z' };

  // ---- 基本: PM+13:00 -> symbol 'P' ----
  var fsdf1 = {
    fsdfVersion: '1.2',
    property: { name: '物件A' },
    inspection: { totalScheduleDays: 2 },
    rooms: [
      { roomNumber: '1512', scheduleDay: 2, timePreference: { period: 'PM', time: '13:00', note: '13:00希望' }, sourceStatus: 'scheduled', ladderRoom: false, sourceMeta: reviewedMeta },
    ],
  };
  var existing1 = { stampData: {}, ladderRooms: [], knownRoomNumbers: ['1512', '1513'] };
  var out1 = adapter.applyConfirmedFsdfToLb(fsdf1, existing1);
  // 既存stamp_dataの排他ルール(symbolとtimeは同時に使わない)を踏襲し、具体的な時刻がある
  // 場合はsymbolを空にしてtimeを優先する(既存のrunStampOcr/applyStampBulkResultと同じ挙動)。
  check('PM+時刻指定は具体時刻を優先しsymbolは空、timeに13:00が入る', out1.stampData['1512'].symbol === '' && out1.stampData['1512'].time === '13:00', JSON.stringify(out1.stampData['1512']));
  check('appliedRoomsに反映した部屋番号が入る', out1.appliedRooms.indexOf('1512') !== -1);

  // ---- 具体的な時刻が無いAM/PMのみの場合はsymbolを使う ----
  var fsdf1b = {
    inspection: { totalScheduleDays: 1 },
    rooms: [{ roomNumber: '101', timePreference: { period: 'PM' }, sourceMeta: reviewedMeta }],
  };
  var out1b = adapter.applyConfirmedFsdfToLb(fsdf1b, { stampData: {}, ladderRooms: [], knownRoomNumbers: ['101'] });
  check('具体時刻の無いPM区分のみはsymbol=Pになる', out1b.stampData['101'].symbol === 'P' && out1b.stampData['101'].time === '');

  // ---- cancelled -> symbol 'キャンセル' ----
  var fsdf2 = {
    inspection: { totalScheduleDays: 1 },
    rooms: [{ roomNumber: '101', sourceStatus: 'cancelled', timePreference: {}, sourceMeta: reviewedMeta }],
  };
  var out2 = adapter.applyConfirmedFsdfToLb(fsdf2, { stampData: {}, ladderRooms: [], knownRoomNumbers: ['101'] });
  check('cancelledはsymbol=キャンセルへ変換される', out2.stampData['101'].symbol === 'キャンセル');

  // ---- status(既存)を変更していないことを確認するため、そもそもstatusフィールドを持たせない設計であることの確認 ----
  check('stampEntryにstatusキーを含めない(既存statusを一切扱わない)', !Object.prototype.hasOwnProperty.call(out2.stampData['101'], 'status'));

  // ---- 未確認(reviewedAt無し)の部屋は反映されない ----
  var fsdf3 = {
    inspection: { totalScheduleDays: 1 },
    rooms: [{ roomNumber: '201', timePreference: { period: 'AM', time: '9:00' }, sourceMeta: {} }],
  };
  var out3 = adapter.applyConfirmedFsdfToLb(fsdf3, { stampData: {}, ladderRooms: [], knownRoomNumbers: ['201'] });
  check('未確認の部屋はstampDataに反映されない', out3.stampData['201'] === undefined);
  check('未確認の部屋はskippedRoomsにnot_reviewed理由で記録される', out3.skippedRooms.some(function (s) { return s.roomNumber === '201' && s.reason === 'not_reviewed'; }));

  // ---- 既存LBに存在しない部屋番号(デフォルト: skip) ----
  var fsdf4 = {
    inspection: { totalScheduleDays: 1 },
    rooms: [{ roomNumber: '9999', timePreference: { period: 'AM', time: '9:00' }, sourceMeta: reviewedMeta }],
  };
  var out4 = adapter.applyConfirmedFsdfToLb(fsdf4, { stampData: {}, ladderRooms: [], knownRoomNumbers: ['101'] });
  check('既存LBに無い部屋番号はデフォルトでunmatchedRoomsへ', out4.unmatchedRooms.indexOf('9999') !== -1);
  check('既存LBに無い部屋番号はデフォルトでstampDataに反映されない', out4.stampData['9999'] === undefined);

  // ---- newRoomPolicy:'include'なら反映する ----
  var out5 = adapter.applyConfirmedFsdfToLb(fsdf4, { stampData: {}, ladderRooms: [], knownRoomNumbers: ['101'] }, { newRoomPolicy: 'include' });
  check('newRoomPolicy:includeなら新規部屋も反映される', out5.stampData['9999'] !== undefined && out5.appliedRooms.indexOf('9999') !== -1);

  // ---- ladderRoomは追加のみ(既存を消さない) ----
  var fsdf6 = {
    inspection: { totalScheduleDays: 1 },
    rooms: [{ roomNumber: '805', ladderRoom: true, timePreference: {}, sourceMeta: reviewedMeta }],
  };
  var out6 = adapter.applyConfirmedFsdfToLb(fsdf6, { stampData: {}, ladderRooms: ['700'], knownRoomNumbers: ['805'] });
  check('ladderRoomが既存リストに追加される(既存700は保持)', out6.ladderRooms.indexOf('805') !== -1 && out6.ladderRooms.indexOf('700') !== -1);

  // ---- OCR専用のsourceStatus(unanswered等)はnoteへ注記され、symbolは空のまま ----
  var fsdf7 = {
    inspection: { totalScheduleDays: 1 },
    rooms: [{ roomNumber: '301', sourceStatus: 'unanswered', ocrStatusRaw: '未回答', timePreference: {}, sourceMeta: reviewedMeta }],
  };
  var out7 = adapter.applyConfirmedFsdfToLb(fsdf7, { stampData: {}, ladderRooms: [], knownRoomNumbers: ['301'] });
  check('未回答はsymbolを空のままnoteに注記する', out7.stampData['301'].symbol === '' && out7.stampData['301'].note.indexOf('未回答') !== -1, JSON.stringify(out7.stampData['301']));

  // ---- 既存stampDataのnameフィールドは保持される ----
  var out8 = adapter.applyConfirmedFsdfToLb(fsdf1, { stampData: { '1512': { symbol: 'A', time: '', time_end: '', note: '', name: '山本' } }, ladderRooms: [], knownRoomNumbers: ['1512'] });
  check('既存stampDataのnameフィールドは保持される', out8.stampData['1512'].name === '山本');

  var allOk = results.every(function (r) { return r.ok; });
  console.log('\n==== apply_confirmed_to_lb_test 総合結果: ' + (allOk ? 'PASS' : 'FAIL') + ' (' + results.filter(function (r) { return r.ok; }).length + '/' + results.length + ') ====');
  if (!allOk) process.exitCode = 1;
}

run();
