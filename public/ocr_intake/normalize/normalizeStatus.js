// OCR Normalizer: ステータス表記揺れの吸収(帳票専用の正規化ステータス語彙 sourceStatus へ変換)。
//
// 重要な設計方針(ユーザー指示2026-07-26 5番): 既存LBのstatus(pending/done/absent/cancelled、
// 「点検が実施されたか」を表す既存の意味専用)は一切触らない。ここで生成するsourceStatusは
// 全く別軸の、点検予定表というOCR対象帳票専用の語彙である。特にPASSを自動的にdoneへ
// 変換してはならない(PASSは「点検実施済み」ではなく「予定表上、確認済み/問題なし」等、
// 意味が異なる可能性があるため)。
//
// 判読不能・未知の表記は絶対に良かれと思って別の値へ寄せない(illegibleとして扱い、
// 警告を必ず残す)。これは「AIが判読不能項目を勝手に確定しない」というユーザー指示の核心。
'use strict';

// 表記揺れ→正規化ステータスの対応表。キーは正規化のため小文字化・空白除去した状態で比較する。
var STATUS_ALIASES = {
  'pass': 'pass',
  'パス': 'pass',
  'ok': 'pass',
  'キャンセル': 'cancelled',
  '辞退': 'cancelled',
  '点検不要': 'cancelled',
  '不要': 'cancelled',
  '未': 'unanswered',
  '未連絡': 'unanswered',
  '未回答': 'unanswered',
  '未定': 'unanswered',
  '不在': 'absent',
  '留守': 'absent',
};

function normalizeKey(raw) {
  if (typeof raw !== 'string') return '';
  return raw.trim().toLowerCase();
}

// statusRaw: OCRが読み取った生のステータス文言(例: 'PASS'、'キャンセル'、'未回答'、'リフォーム中'、
//   空文字、意味不明な断片、undefined)。
// confidence: 0.0〜1.0のOCR信頼度(無ければnull扱い)。
// 戻り値: { sourceStatus, ocrStatusRaw, warnings: [{field, message, severity}] }
function normalizeStatus(statusRaw, confidence) {
  var warnings = [];
  var ocrStatusRaw = (statusRaw === undefined || statusRaw === null) ? null : String(statusRaw);

  // undefined/null(=そもそもステータス欄に何の記載も無い。予定表の大多数の行はこちら)は
  // 「予定通り(scheduled)」という正常な既定状態として扱う。判読不能(illegible)とは明確に区別する。
  if (statusRaw === undefined || statusRaw === null) {
    return { sourceStatus: 'scheduled', ocrStatusRaw: ocrStatusRaw, warnings: warnings };
  }

  var key = normalizeKey(statusRaw);
  if (!key) {
    // 空文字列(=ステータス欄に何らかの記載を試みた形跡はあるが、判読できない/読み取れなかった)。
    warnings.push({ field: 'status', message: 'ステータスの記載が判読できなかったため、自動確定しませんでした。', severity: 'warning' });
    return { sourceStatus: 'illegible', ocrStatusRaw: ocrStatusRaw, warnings: warnings };
  }

  if (Object.prototype.hasOwnProperty.call(STATUS_ALIASES, key)) {
    var mapped = STATUS_ALIASES[key];
    if (typeof confidence === 'number' && confidence < 0.75) {
      warnings.push({ field: 'status', message: 'ステータス「' + statusRaw + '」の読み取り信頼度が低いため(' + confidence.toFixed(2) + ')、要確認です。', severity: 'warning' });
    }
    return { sourceStatus: mapped, ocrStatusRaw: ocrStatusRaw, warnings: warnings };
  }

  // 既知の別軸の特殊状態(例: 「リフォーム中」)は、無理に既存語彙へ寄せず'other'として扱い、
  // 元の文言をocrStatusRawに残すことで、後続のOCR確認画面(Phase3)で人間が判断できるようにする。
  warnings.push({ field: 'status', message: '未知のステータス表記「' + statusRaw + '」です。既知の語彙に寄せず、そのまま保持しました(要確認)。', severity: 'warning' });
  return { sourceStatus: 'other', ocrStatusRaw: ocrStatusRaw, warnings: warnings };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { normalizeStatus: normalizeStatus, STATUS_ALIASES: STATUS_ALIASES };
} else if (typeof window !== 'undefined') {
  window.FireFlowOcrIntake = window.FireFlowOcrIntake || {};
  window.FireFlowOcrIntake.normalizeStatus = normalizeStatus;
  window.FireFlowOcrIntake.STATUS_ALIASES = STATUS_ALIASES;
}
