// OCR Normalizer: 時間帯(AM/PM)・時刻表記の統一と、両者の矛盾検出。
//
// 既存の点検希望時間連絡票OCR(既存stamp_data: symbol='A'|'P'|'キャンセル', time, time_end, note)と
// 同じ記号体系を土台にしつつ、値を意味的に正規化する(設計書4.1「timePreferenceは既存stamp_dataを
// 意味的に正規化したもの」を実装したもの)。
'use strict';

var PERIOD_ALIASES = {
  '午前': 'AM', 'am': 'AM', 'a': 'AM',
  '午後': 'PM', 'pm': 'PM', 'p': 'PM',
};

var FULLWIDTH_DIGITS = '０１２３４５６７８９';

function toHalfWidthDigits(str) {
  if (typeof str !== 'string') return str;
  var out = '';
  for (var i = 0; i < str.length; i++) {
    var ch = str[i];
    var idx = FULLWIDTH_DIGITS.indexOf(ch);
    out += (idx === -1) ? ch : String(idx);
  }
  return out.replace(/：/g, ':');
}

function normalizePeriod(raw) {
  if (raw === undefined || raw === null) return null;
  var key = String(raw).trim().toLowerCase();
  if (!key) return null;
  return Object.prototype.hasOwnProperty.call(PERIOD_ALIASES, key) ? PERIOD_ALIASES[key] : null;
}

// 時刻文字列を 'HH:MM'(24時間表記、ゼロ埋め2桁)へ統一する。解析できない場合はnullを返す。
function parseTimeToHHMM(raw) {
  if (raw === undefined || raw === null) return null;
  var s = toHalfWidthDigits(String(raw)).trim();
  if (!s) return null;
  var m = s.match(/^(\d{1,2})\s*[:時.]\s*(\d{1,2})?\s*分?$/);
  if (!m) return null;
  var hour = parseInt(m[1], 10);
  var minute = m[2] !== undefined ? parseInt(m[2], 10) : 0;
  if (isNaN(hour) || isNaN(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return (hour < 10 ? '0' + hour : String(hour)) + ':' + (minute < 10 ? '0' + minute : String(minute));
}

function hourOf(hhmm) { return parseInt(hhmm.split(':')[0], 10); }

// periodRaw/timeRaw/timeEndRaw/noteRaw: OCR生テキスト。confidence: {period, time}形式の信頼度(任意)。
// 戻り値: { period, time, isRange, timeEnd, note, warnings: [...] }
function normalizeTimePreference(periodRaw, timeRaw, timeEndRaw, noteRaw, confidence) {
  var warnings = [];
  var period = normalizePeriod(periodRaw);
  if (periodRaw !== undefined && periodRaw !== null && String(periodRaw).trim() !== '' && period === null) {
    warnings.push({ field: 'timePreference.period', message: '時間帯の表記「' + periodRaw + '」を認識できませんでした。', severity: 'warning' });
  }

  var time = parseTimeToHHMM(timeRaw);
  if (timeRaw !== undefined && timeRaw !== null && String(timeRaw).trim() !== '' && time === null) {
    warnings.push({ field: 'timePreference.time', message: '時刻の表記「' + timeRaw + '」を解析できませんでした。', severity: 'warning' });
  }

  // 時間帯と時刻の矛盾検出・12時間表記の24時間表記への統一。
  if (period && time) {
    var hour = hourOf(time);
    if (period === 'PM') {
      if (hour === 0) {
        warnings.push({ field: 'timePreference', message: '時間帯は「午後(PM)」ですが、時刻が' + time + '(午前0時)で矛盾しています。自動修正せず要確認としました。', severity: 'warning' });
      } else if (hour >= 1 && hour <= 11) {
        time = (hour + 12) + ':' + time.split(':')[1]; // 12時間表記→24時間表記へ統一(例: PM 1:00 → 13:00)
      }
      // hour 12〜23はそのまま(既に24時間表記、またはpm12時=正午)。
    } else if (period === 'AM') {
      if (hour === 12) {
        time = '00:' + time.split(':')[1]; // 「AM12:00」= 午前0時の慣例的表記を統一。
        warnings.push({ field: 'timePreference', message: '「午前12:00」は午前0時として扱いました(表記慣例上の解釈のため要確認)。', severity: 'info' });
      } else if (hour >= 13 && hour <= 23) {
        warnings.push({ field: 'timePreference', message: '時間帯は「午前(AM)」ですが、時刻が' + time + '(24時間表記で13時以降)で矛盾しています。自動修正せず要確認としました。', severity: 'warning' });
      }
    }
  }

  if (confidence && typeof confidence === 'object') {
    if (typeof confidence.period === 'number' && confidence.period < 0.75) {
      warnings.push({ field: 'timePreference.period', message: '時間帯の読み取り信頼度が低いです(' + confidence.period.toFixed(2) + ')。', severity: 'warning' });
    }
    if (typeof confidence.time === 'number' && confidence.time < 0.75) {
      warnings.push({ field: 'timePreference.time', message: '時刻の読み取り信頼度が低いです(' + confidence.time.toFixed(2) + ')。', severity: 'warning' });
    }
  }

  var timeEnd = parseTimeToHHMM(timeEndRaw);
  var isRange = !!(time && timeEnd);
  var note = (noteRaw === undefined || noteRaw === null) ? null : String(noteRaw);

  return { period: period, time: time, isRange: isRange, timeEnd: timeEnd, note: note, warnings: warnings };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    normalizeTimePreference: normalizeTimePreference,
    normalizePeriod: normalizePeriod,
    parseTimeToHHMM: parseTimeToHHMM,
  };
} else if (typeof window !== 'undefined') {
  window.FireFlowOcrIntake = window.FireFlowOcrIntake || {};
  window.FireFlowOcrIntake.normalizeTimePreference = normalizeTimePreference;
  window.FireFlowOcrIntake.normalizePeriod = normalizePeriod;
  window.FireFlowOcrIntake.parseTimeToHHMM = parseTimeToHHMM;
}
