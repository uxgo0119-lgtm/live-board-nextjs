// Phase3「③OCR確認画面」: 確定前バリデーション(純粋関数)。
//
// 設計方針(ユーザー指示2026-07-26 6番): 確定前に最低限、
//   - 部屋番号が空でない
//   - 部屋番号の重複
//   - scheduleDayがtotalScheduleDaysの範囲内
//   - AMなのに13:00以降・PMなのに午前時刻などの矛盾
//   - illegibleが未確認のまま残っていないか
//   - 重大warningが未解決のまま残っていないか
// を検証する。重大warningが残る場合は、警告を表示した上で確定を止めるか、明示的な確認操作を
// 要求する(blockingIssuesとwarningsを区別し、blockingIssuesはoptions.acknowledgedRoomsで
// 明示的に確認された部屋のみ解除できるようにする)。
'use strict';

function trimRoomNumber(v) {
  return (v === undefined || v === null) ? '' : String(v).trim();
}

function parseHour(timeStr) {
  if (!timeStr) return null;
  var m = String(timeStr).match(/^(\d{1,2}):/);
  if (!m) return null;
  var h = parseInt(m[1], 10);
  return isNaN(h) ? null : h;
}

// fsdf: FSDFオブジェクト。options: {
//   acknowledgedIllegibleRooms: string[] (illegible状態のまま確定してよいと明示確認された部屋番号),
//   acknowledgedWarningRooms: string[] (重大warning(severity:'error')が残っていても確定してよいと
//     明示確認された部屋番号),
// }
// 戻り値: { ok: boolean, blockingIssues: [{code, roomNumber, message}], warnings: [{code, roomNumber, message, severity}] }
function validateBeforeConfirm(fsdf, options) {
  options = options || {};
  var acknowledgedIllegible = options.acknowledgedIllegibleRooms || [];
  var acknowledgedWarning = options.acknowledgedWarningRooms || [];
  var rooms = (fsdf && Array.isArray(fsdf.rooms)) ? fsdf.rooms : [];
  var totalScheduleDays = (fsdf && fsdf.inspection && typeof fsdf.inspection.totalScheduleDays === 'number') ? fsdf.inspection.totalScheduleDays : null;

  var blockingIssues = [];
  var warnings = [];

  // ---- 部屋番号が空でない ----
  rooms.forEach(function (r, idx) {
    if (!trimRoomNumber(r && r.roomNumber)) {
      blockingIssues.push({ code: 'empty_room_number', roomIndex: idx, roomNumber: null, message: (idx + 1) + '件目の部屋番号が空です。' });
    }
  });

  // ---- 部屋番号の重複 ----
  var seen = Object.create(null);
  var dup = Object.create(null);
  rooms.forEach(function (r) {
    var rn = trimRoomNumber(r && r.roomNumber);
    if (!rn) return;
    if (seen[rn]) dup[rn] = true;
    seen[rn] = true;
  });
  Object.keys(dup).forEach(function (rn) {
    blockingIssues.push({ code: 'duplicate_room_number', roomNumber: rn, message: rn + '号室の部屋番号が重複しています。' });
  });

  rooms.forEach(function (r) {
    var rn = trimRoomNumber(r && r.roomNumber);
    if (!rn) return;

    // ---- scheduleDayがtotalScheduleDaysの範囲内 ----
    if (typeof r.scheduleDay === 'number' && totalScheduleDays !== null) {
      if (r.scheduleDay < 1 || r.scheduleDay > totalScheduleDays) {
        blockingIssues.push({
          code: 'schedule_day_out_of_range', roomNumber: rn,
          message: rn + '号室の工程日(' + r.scheduleDay + '日目)が、物件全体の工程日数(全' + totalScheduleDays + '日)の範囲外です。',
        });
      }
    }

    // ---- AM/PMと時刻の矛盾 ----
    var tp = r.timePreference || {};
    if (tp.period && tp.time) {
      var hh = parseHour(tp.time);
      if (hh !== null) {
        if (tp.period === 'AM' && hh >= 13) {
          blockingIssues.push({ code: 'am_pm_time_conflict', roomNumber: rn, message: rn + '号室はAM指定ですが、時刻(' + tp.time + ')が午後です。' });
        } else if (tp.period === 'PM' && hh < 12) {
          blockingIssues.push({ code: 'am_pm_time_conflict', roomNumber: rn, message: rn + '号室はPM指定ですが、時刻(' + tp.time + ')が午前です。' });
        }
      }
    }

    // ---- illegibleが未確認のまま残っていないか ----
    if (r.sourceStatus === 'illegible' && !(r.sourceMeta && r.sourceMeta.reviewedAt)) {
      if (acknowledgedIllegible.indexOf(rn) === -1) {
        blockingIssues.push({ code: 'illegible_unreviewed', roomNumber: rn, message: rn + '号室は判読不能(illegible)のまま未確認です。内容を確認してください。' });
      } else {
        warnings.push({ code: 'illegible_acknowledged', roomNumber: rn, message: rn + '号室は判読不能のまま、明示的に確認済みとして扱われています。', severity: 'warning' });
      }
    }

    // ---- 重大warning(severity:'error')が未解決のまま残っていないか ----
    var roomWarnings = (r.sourceMeta && r.sourceMeta.warnings) || [];
    var hasErrorWarning = roomWarnings.some(function (w) { return w && w.severity === 'error'; });
    if (hasErrorWarning && !(r.sourceMeta && r.sourceMeta.reviewedAt)) {
      if (acknowledgedWarning.indexOf(rn) === -1) {
        blockingIssues.push({ code: 'blocking_warning_unresolved', roomNumber: rn, message: rn + '号室に重大な警告が未解決のまま残っています。' });
      } else {
        warnings.push({ code: 'blocking_warning_acknowledged', roomNumber: rn, message: rn + '号室の重大な警告は、明示的に確認済みとして確定されようとしています。', severity: 'warning' });
      }
    }

    // ---- 軽微なwarning(severity !== 'error')は確定をブロックしないが、一覧として返す ----
    roomWarnings.forEach(function (w) {
      if (w && w.severity !== 'error') {
        warnings.push({ code: 'room_warning', roomNumber: rn, message: rn + '号室: ' + w.message, severity: w.severity || 'warning' });
      }
    });
  });

  return {
    ok: blockingIssues.length === 0,
    blockingIssues: blockingIssues,
    warnings: warnings,
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { validateBeforeConfirm: validateBeforeConfirm };
} else if (typeof window !== 'undefined') {
  window.FireFlowOcrConfirm = window.FireFlowOcrConfirm || {};
  window.FireFlowOcrConfirm.validateBeforeConfirm = validateBeforeConfirm;
}
