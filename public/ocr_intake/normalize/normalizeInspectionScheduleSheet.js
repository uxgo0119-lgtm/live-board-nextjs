// OCR Normalizer: 「紙の点検予定表」帳票専用のエントリポイント。
//
// 位置付け(設計書1.1a・7章の「共通OCRコア/帳票種別ごとの拡張」構造を、Phase2ではAI接続を
// 挟まないダミーOCRの範囲で実装したもの): AM/PM・ステータス・時刻といった帳票非依存の
// 共通正規化はnormalizeStatus.js/normalizeTimePreference.jsに委譲し、この帳票固有の
// 「工程日(scheduleDay)」の正規化だけをここで行う。将来Phase7で実OCR接続する際も、
// この関数のインターフェース(生OCR結果の配列を受け取り、正規化済みの部屋データ配列を返す)は
// 変わらない想定。
//
// 【重要】OCR生結果を直接FSDFへ変換しない。必ず OCR Raw Result → (本ファイル) → FSDF の順で
// 経由すること。fsdf_builder.jsは本ファイルの出力だけを受け取り、生のOCR結果を直接は扱わない。
'use strict';

// Node(require)とブラウザ(<script src>で直接読み込み、window.FireFlowOcrIntake名前空間経由)の
// 両方で動くようにする(既存validate_lb_payload.js等と同じ二重対応の考え方)。
var normalizeStatus, normalizeTimePreference, mergeWarnings, warnIfLowConfidence, warnMissingRoomNumber, warnScheduleDayOutOfRange, warnUnparsedScheduleDay;
if (typeof module !== 'undefined' && module.exports) {
  normalizeStatus = require('./normalizeStatus.js').normalizeStatus;
  normalizeTimePreference = require('./normalizeTimePreference.js').normalizeTimePreference;
  var _bw = require('./buildWarnings.js');
  mergeWarnings = _bw.mergeWarnings;
  warnIfLowConfidence = _bw.warnIfLowConfidence;
  warnMissingRoomNumber = _bw.warnMissingRoomNumber;
  warnScheduleDayOutOfRange = _bw.warnScheduleDayOutOfRange;
  warnUnparsedScheduleDay = _bw.warnUnparsedScheduleDay;
} else if (typeof window !== 'undefined') {
  var _ns = window.FireFlowOcrIntake || {};
  normalizeStatus = _ns.normalizeStatus;
  normalizeTimePreference = _ns.normalizeTimePreference;
  mergeWarnings = _ns.mergeWarnings;
  warnIfLowConfidence = _ns.warnIfLowConfidence;
  warnMissingRoomNumber = _ns.warnMissingRoomNumber;
  warnScheduleDayOutOfRange = _ns.warnScheduleDayOutOfRange;
  warnUnparsedScheduleDay = _ns.warnUnparsedScheduleDay;
}

var FULLWIDTH_DIGITS = '０１２３４５６７８９';
function toHalfWidthDigits(str) {
  if (typeof str !== 'string') return str;
  var out = '';
  for (var i = 0; i < str.length; i++) {
    var idx = FULLWIDTH_DIGITS.indexOf(str[i]);
    out += (idx === -1) ? str[i] : String(idx);
  }
  return out;
}

// "2日目" / "Day 2" / "day2" / "2" などの表記揺れを整数へ正規化する。解析できない場合はnull。
function parseScheduleDay(raw) {
  if (raw === undefined || raw === null) return null;
  var s = toHalfWidthDigits(String(raw)).trim();
  if (!s) return null;
  var m = s.match(/^(?:day\s*)?(\d{1,2})\s*(?:日目)?$/i);
  if (!m) return null;
  var n = parseInt(m[1], 10);
  return (isNaN(n) || n < 1) ? null : n;
}

function normalizeLadder(raw) {
  if (raw === undefined || raw === null) return false;
  var s = String(raw).trim();
  return s !== '' && s !== '0' && s.toLowerCase() !== 'false' && s.toLowerCase() !== 'no';
}

// rawRooms: mock_ocr_provider.js(または将来の実OCR)が返す、帳票1枚分の生OCR結果の配列。
// options.knownTotalScheduleDays: 既に工程日数が分かっている場合(例: 物件マスタから)に渡す。
//   省略時はrawRoomsのscheduleDayの最大値から推定する(推定である旨を警告として残す)。
// 戻り値: { rooms: [正規化済み部屋データ], totalScheduleDays, warnings: [帳票全体に関する警告] }
function normalizeInspectionScheduleSheet(rawRooms, options) {
  options = options || {};
  var rooms = [];
  var topLevelWarnings = [];

  (Array.isArray(rawRooms) ? rawRooms : []).forEach(function (raw, index) {
    if (!raw || typeof raw !== 'object') {
      topLevelWarnings.push.apply(topLevelWarnings, warnMissingRoomNumber(index));
      return;
    }
    var roomNumberRaw = raw.roomNumberRaw;
    var roomNumberOk = (typeof roomNumberRaw === 'string' && roomNumberRaw.trim()) ||
      (typeof roomNumberRaw === 'number' && !isNaN(roomNumberRaw));
    if (!roomNumberOk) {
      topLevelWarnings.push.apply(topLevelWarnings, warnMissingRoomNumber(index));
      return; // 部屋番号が読めない行は、誤った部屋へ書き込むリスクがあるためFSDFへ含めない。
    }
    var roomNumber = toHalfWidthDigits(String(roomNumberRaw).trim());
    var confidence = raw.confidence || {};

    var scheduleDayWarnings = [];
    var scheduleDay = parseScheduleDay(raw.scheduleDayRaw);
    if ((raw.scheduleDayRaw !== undefined && raw.scheduleDayRaw !== null && String(raw.scheduleDayRaw).trim() !== '') && scheduleDay === null) {
      scheduleDayWarnings = warnUnparsedScheduleDay(roomNumber + '号室', raw.scheduleDayRaw);
    }
    scheduleDayWarnings = scheduleDayWarnings.concat(warnIfLowConfidence('scheduleDay', roomNumber + '号室の工程日', confidence.scheduleDay));

    var timeResult = normalizeTimePreference(raw.periodRaw, raw.timeRaw, raw.timeEndRaw, raw.noteRaw, { period: confidence.period, time: confidence.time });
    var statusResult = normalizeStatus(raw.statusRaw, confidence.status);

    var roomWarnings = mergeWarnings(
      scheduleDayWarnings,
      timeResult.warnings,
      statusResult.warnings,
      warnIfLowConfidence('roomNumber', roomNumber + '号室の部屋番号', confidence.roomNumber)
    );

    rooms.push({
      roomNumber: roomNumber,
      roomNumberRaw: (typeof roomNumberRaw === 'string') ? roomNumberRaw : String(roomNumberRaw),
      scheduleDay: scheduleDay,
      timePreference: { period: timeResult.period, time: timeResult.time, isRange: timeResult.isRange, timeEnd: timeResult.timeEnd, note: timeResult.note },
      ladderRoom: normalizeLadder(raw.ladderRaw),
      memo: (raw.memoRaw === undefined || raw.memoRaw === null) ? '' : String(raw.memoRaw),
      ocrStatusRaw: statusResult.ocrStatusRaw,
      sourceStatus: statusResult.sourceStatus,
      ocrConfidence: confidence,
      warnings: roomWarnings,
    });
  });

  var totalScheduleDays = options.knownTotalScheduleDays;
  if (typeof totalScheduleDays !== 'number' || totalScheduleDays < 1) {
    var maxDay = rooms.reduce(function (max, r) { return (typeof r.scheduleDay === 'number' && r.scheduleDay > max) ? r.scheduleDay : max; }, 0);
    if (maxDay > 0) {
      totalScheduleDays = maxDay;
      topLevelWarnings.push({ field: 'inspection.totalScheduleDays', message: '工程全体の日数が明示されていなかったため、各部屋の工程日の最大値(' + maxDay + '日)から推定しました。物件マスタ等で正しい値が分かる場合は上書きしてください。', severity: 'info' });
    } else {
      totalScheduleDays = 1;
    }
  }

  // 推定/確定した工程日数をもとに、各部屋の工程日が範囲内かを再チェックする。
  rooms.forEach(function (r) {
    var rangeWarn = warnScheduleDayOutOfRange(r.roomNumber + '号室', r.scheduleDay, totalScheduleDays);
    if (rangeWarn.length) r.warnings = r.warnings.concat(rangeWarn);
  });

  return { rooms: rooms, totalScheduleDays: totalScheduleDays, warnings: topLevelWarnings };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { normalizeInspectionScheduleSheet: normalizeInspectionScheduleSheet, parseScheduleDay: parseScheduleDay };
} else if (typeof window !== 'undefined') {
  window.FireFlowOcrIntake = window.FireFlowOcrIntake || {};
  window.FireFlowOcrIntake.normalizeInspectionScheduleSheet = normalizeInspectionScheduleSheet;
  window.FireFlowOcrIntake.parseScheduleDay = parseScheduleDay;
}
