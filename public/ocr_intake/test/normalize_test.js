// OCR Normalizer単体テスト。表記揺れ吸収・矛盾検出・判読不能の扱いを検証する。
'use strict';
var { normalizeStatus } = require('../normalize/normalizeStatus.js');
var { normalizeTimePreference, normalizePeriod, parseTimeToHHMM } = require('../normalize/normalizeTimePreference.js');
var { normalizeInspectionScheduleSheet, parseScheduleDay } = require('../normalize/normalizeInspectionScheduleSheet.js');

var results = [];
function check(label, cond, detail) {
  results.push({ label: label, ok: !!cond });
  console.log((cond ? 'OK' : 'NG') + ': ' + label + (detail !== undefined ? ' (' + JSON.stringify(detail) + ')' : ''));
}

console.log('==== normalizeStatus ====');
check('statusRawがnull(欄自体が無い)→scheduled、警告なし', normalizeStatus(null).sourceStatus === 'scheduled' && normalizeStatus(null).warnings.length === 0);
check('statusRawが空文字(判読不能)→illegible、警告あり', normalizeStatus('').sourceStatus === 'illegible' && normalizeStatus('').warnings.length === 1);
check('"PASS"→pass(自動的にdoneへ変換されない。sourceStatusは既存statusのenumに存在しない値)', normalizeStatus('PASS').sourceStatus === 'pass');
check('"パス"→pass(表記揺れ吸収)', normalizeStatus('パス').sourceStatus === 'pass');
check('"キャンセル"→cancelled', normalizeStatus('キャンセル').sourceStatus === 'cancelled');
check('"辞退"→cancelled(表記揺れ吸収)', normalizeStatus('辞退').sourceStatus === 'cancelled');
check('"点検不要"→cancelled(表記揺れ吸収)', normalizeStatus('点検不要').sourceStatus === 'cancelled');
check('"未回答"→unanswered', normalizeStatus('未回答').sourceStatus === 'unanswered');
check('"未連絡"→unanswered(表記揺れ吸収)', normalizeStatus('未連絡').sourceStatus === 'unanswered');
check('"不在"→absent', normalizeStatus('不在').sourceStatus === 'absent');
check('未知の表記"リフォーム中"→otherとして保持され、元の文言もocrStatusRawに残る(勝手に別の値へ寄せない)',
  normalizeStatus('リフォーム中').sourceStatus === 'other' && normalizeStatus('リフォーム中').ocrStatusRaw === 'リフォーム中');
check('低信頼度のPASSは警告が付く', normalizeStatus('PASS', 0.5).warnings.length === 1);

console.log('\n==== normalizeTimePreference ====');
check('"午前"→AM、"午後"→PM、"AM"→AM、"P"→PM', normalizePeriod('午前') === 'AM' && normalizePeriod('午後') === 'PM' && normalizePeriod('AM') === 'AM' && normalizePeriod('P') === 'PM');
check('parseTimeToHHMM("13:00")→"13:00"', parseTimeToHHMM('13:00') === '13:00');
check('parseTimeToHHMM("１３：００")(全角)→"13:00"', parseTimeToHHMM('１３：００') === '13:00');
check('parseTimeToHHMM("9時")→"09:00"', parseTimeToHHMM('9時') === '09:00');
check('parseTimeToHHMM("謎")→null(解析不能)', parseTimeToHHMM('謎') === null);

var r1 = normalizeTimePreference('午後', '1:00', null, '13時希望', {});
check('period="午後"+time="1:00"(12時間表記) → 24時間表記の"13:00"へ統一', r1.period === 'PM' && r1.time === '13:00');

var r2 = normalizeTimePreference('AM', '15:00', null, null, {});
check('period="AM"+time="15:00"は矛盾として警告され、自動修正されない(時刻はそのまま15:00)', r2.period === 'AM' && r2.time === '15:00' && r2.warnings.some(function (w) { return /矛盾/.test(w.message); }));

var r3 = normalizeTimePreference('PM', '0:00', null, null, {});
check('period="PM"+time="0:00"は矛盾として警告される', r3.warnings.some(function (w) { return /矛盾/.test(w.message); }));

console.log('\n==== 工程日の正規化(parseScheduleDay) ====');
check('"2日目"→2', parseScheduleDay('2日目') === 2);
check('"２日目"(全角)→2', parseScheduleDay('２日目') === 2);
check('"Day 2"→2', parseScheduleDay('Day 2') === 2);
check('"2"→2', parseScheduleDay('2') === 2);
check('"謎の記号"→null(解析不能)', parseScheduleDay('謎の記号') === null);

console.log('\n==== normalizeInspectionScheduleSheet(帳票全体) ====');
var batch = normalizeInspectionScheduleSheet([
  { roomNumberRaw: '１０１', scheduleDayRaw: '1日目', periodRaw: 'AM', timeRaw: '9:00', statusRaw: null, confidence: {} },
  { roomNumberRaw: '102', scheduleDayRaw: '2日目', periodRaw: null, timeRaw: null, statusRaw: 'PASS', confidence: {} },
  { roomNumberRaw: '', scheduleDayRaw: '1日目', statusRaw: null, confidence: {} }, // 部屋番号なし→除外される
], {});
check('部屋番号が全角の"１０１"が半角"101"へ正規化される', batch.rooms[0].roomNumber === '101');
check('部屋番号なしの行は結果から除外され、error警告が残る', batch.rooms.length === 2 && batch.warnings.some(function (w) { return w.severity === 'error'; }));
check('totalScheduleDaysが未指定の場合、最大の工程日(2)から推定される', batch.totalScheduleDays === 2);
check('推定した旨がinfo警告として残る', batch.warnings.some(function (w) { return w.field === 'inspection.totalScheduleDays'; }));

var withKnownDays = normalizeInspectionScheduleSheet(
  [{ roomNumberRaw: '101', scheduleDayRaw: '5日目', statusRaw: null, confidence: {} }],
  { knownTotalScheduleDays: 2 }
);
check('工程日数が既知(2日)で、部屋のscheduleDay(5)が範囲外の場合に警告が出る',
  withKnownDays.rooms[0].warnings.some(function (w) { return w.field === 'scheduleDay' && /範囲外/.test(w.message); }));

var allOk = results.every(function (r) { return r.ok; });
console.log('\n==== normalize_test 総合結果: ' + (allOk ? 'PASS' : 'FAIL') + ' (' + results.filter(function (r) { return r.ok; }).length + '/' + results.length + ') ====');
if (!allOk) process.exitCode = 1;
