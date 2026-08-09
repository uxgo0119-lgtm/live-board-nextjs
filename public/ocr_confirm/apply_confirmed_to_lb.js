// Phase3「⑦既存LBへの反映」: 確認済みFSDFを既存LB(Live Board)へ反映する後方互換アダプタ。
//
// 設計方針(ユーザー指示2026-07-26 7番・9番): 既存の部屋カードUI・点検入力・stamp_data・
// 既存OCRの動作は変更しない。既存LBが必要とする項目だけを後方互換アダプタで反映し、
// OCR固有情報(sourceStatus/ocrStatusRaw/scheduleDay/sourceMeta等)はFSDF側に保持したまま、
// 無理に既存statusへ押し込まない。
//
// 具体的な反映先: 既存の「点検希望時間連絡票OCR」が使っているstamp_data形式
// ({symbol:'A'|'P'|'キャンセル'|'', time, time_end, note, name})に、FSDFのtimePreference/
// sourceStatusを変換して反映する(既存のrunStampOcr()等と全く同じデータ形状に揃えることで、
// 既存の部屋カードの時間帯表示ロジックをそのまま再利用できる)。既存の`status`
// (pending/done/absent/cancelled、点検実施済みかを表す既存専用の意味)は絶対に変更しない。
// ladderRoom(避難はしご対象)は既存のLADDER_ROOMS概念へ、削除ではなく追加のみで反映する。
//
// 【重要】この関数は「確定済み」(sourceMeta.reviewedAtが設定されている)部屋だけを対象とする。
// 未確認の部屋を誤って反映しないための安全装置。
'use strict';

// OCRのsourceStatusを、既存stamp_data.symbolの意味を壊さない形へ変換する。
// symbolは既存UIの表示に直結するため、意味が完全に一致する場合だけ変換し、それ以外は
// symbolを空にしてnoteへ状態を残す(情報を失わないが、既存の表示ロジックを混乱させない)。
//
// 【重要】既存のstamp_data(runStampOcr/applyStampBulkResult)は、symbol('A'/'P'/'キャンセル')と
// 具体的な時刻(time)を互いに排他なものとして扱っている(既存コード:
// `var time = symbol ? '' : (item.time || '')`)。この既存の意味を壊さないよう、
// 具体的な時刻が読み取れている場合はsymbolを空にして時刻を優先し、具体的な時刻が無く
// AM/PMの大まかな区分のみの場合にsymbolを使う。
function sourceStatusToStampSymbol(room) {
  if (room.sourceStatus === 'cancelled') return 'キャンセル';
  var tp = room.timePreference || {};
  if (tp.time) return ''; // 具体的な時刻がある場合はtimeを優先し、symbolは使わない(既存の排他ルール)。
  var period = tp.period;
  if (period === 'AM') return 'A';
  if (period === 'PM') return 'P';
  return '';
}

// OCR由来のsourceStatus/ocrStatusRawのうち、既存stamp_data.noteに書き込んでも情報を失わない
// (かつ既存symbol/timeの意味と衝突しない)ものだけを、可読な注記として追記する。
function buildStampNoteSuffix(room) {
  var noteworthy = ['pass', 'unanswered', 'absent', 'illegible', 'other'];
  if (room.sourceStatus && noteworthy.indexOf(room.sourceStatus) !== -1) {
    var label = { pass: 'PASS', unanswered: '未回答・未連絡', absent: '不在', illegible: '判読不能', other: 'その他' }[room.sourceStatus];
    return '[OCR:' + label + (room.ocrStatusRaw ? '(' + room.ocrStatusRaw + ')' : '') + ']';
  }
  return '';
}

function buildStampEntryFromRoom(room, existingEntry) {
  // TODO: 将来FSDF統合時にscheduleDayも引き継ぐようここを修正する。
  // (2026-07-29追記) 捺印表(点検希望時間連絡票)の直接経路(index.htmlのapplyStampBulkResult等)
  // では、STAMP_DATAのentryにscheduleDate/scheduleDayを追加保存するようになった。一方この関数は
  // 点検予定表(FSDF経由)側の変換であり、確定済みroomオブジェクト(room.scheduleDayを含む場合が
  // ある)からstamp_data形式へ変換する際に、そのscheduleDayを意図的にコピーせず捨てている
  // (下のreturnオブジェクトにscheduleDay/scheduleDateが無いことに注意)。これは今回の直接経路の
  // 変更とは別のパイプラインのため、今回は動作を変更しない(コメント記録のみ)。
  var symbol = sourceStatusToStampSymbol(room);
  var tp = room.timePreference || {};
  var time = symbol ? '' : (tp.time || '');
  var timeEnd = symbol ? '' : (tp.isRange ? (tp.timeEnd || '') : '');
  var baseNote = tp.note || '';
  var suffix = buildStampNoteSuffix(room);
  var note = [baseNote, suffix].filter(Boolean).join(' ').trim();
  return {
    symbol: symbol,
    time: time,
    time_end: timeEnd,
    note: note,
    // 既存stamp_data.nameはOCR(点検予定表)側には対応情報が無いため、既存値を保持する。
    name: (existingEntry && existingEntry.name) || '',
  };
}

// fsdf: 確認済みFSDF(rooms[]の各要素にsourceMeta.reviewedAtが設定されている想定)。
// existingLbState: {
//   stampData: { [roomNumber]: {symbol, time, time_end, note, name} } (既存STAMP_DATA相当),
//   ladderRooms: string[] (既存LADDER_ROOMS相当),
//   knownRoomNumbers: string[] (この物件に実在する部屋番号の一覧。既存の部屋カード一覧から得る),
// }
// options: { newRoomPolicy: 'skip'(既定)|'include' }
// 戻り値: { stampData, ladderRooms, appliedRooms, skippedRooms: [{roomNumber, reason}], unmatchedRooms: string[] }
function applyConfirmedFsdfToLb(fsdf, existingLbState, options) {
  options = options || {};
  var newRoomPolicy = options.newRoomPolicy || 'skip';
  existingLbState = existingLbState || {};
  var stampData = Object.assign({}, existingLbState.stampData || {});
  var ladderRooms = (existingLbState.ladderRooms || []).slice();
  var knownRoomNumbers = existingLbState.knownRoomNumbers || null; // nullなら「全件既知」として扱う(チェックしない)

  var appliedRooms = [];
  var skippedRooms = [];
  var unmatchedRooms = [];

  var rooms = (fsdf && Array.isArray(fsdf.rooms)) ? fsdf.rooms : [];
  rooms.forEach(function (room) {
    var rn = (room.roomNumber === undefined || room.roomNumber === null) ? '' : String(room.roomNumber).trim();
    if (!rn) {
      skippedRooms.push({ roomNumber: rn, reason: 'empty_room_number' });
      return;
    }

    if (!(room.sourceMeta && room.sourceMeta.reviewedAt)) {
      skippedRooms.push({ roomNumber: rn, reason: 'not_reviewed' });
      return;
    }

    var isKnown = !knownRoomNumbers || knownRoomNumbers.indexOf(rn) !== -1;
    if (!isKnown) {
      unmatchedRooms.push(rn);
      if (newRoomPolicy !== 'include') {
        skippedRooms.push({ roomNumber: rn, reason: 'not_in_existing_lb' });
        return;
      }
      // includeポリシー: 新規部屋として反映するが、後段のknownRoomNumbers更新は呼び出し側の責務とする。
    }

    stampData[rn] = buildStampEntryFromRoom(room, stampData[rn]);
    if (room.ladderRoom === true && ladderRooms.indexOf(rn) === -1) {
      ladderRooms.push(rn);
    }
    appliedRooms.push(rn);
  });

  return {
    stampData: stampData,
    ladderRooms: ladderRooms,
    appliedRooms: appliedRooms,
    skippedRooms: skippedRooms,
    unmatchedRooms: unmatchedRooms,
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    sourceStatusToStampSymbol: sourceStatusToStampSymbol,
    buildStampEntryFromRoom: buildStampEntryFromRoom,
    applyConfirmedFsdfToLb: applyConfirmedFsdfToLb,
  };
} else if (typeof window !== 'undefined') {
  window.FireFlowOcrConfirm = window.FireFlowOcrConfirm || {};
  window.FireFlowOcrConfirm.sourceStatusToStampSymbol = sourceStatusToStampSymbol;
  window.FireFlowOcrConfirm.buildStampEntryFromRoom = buildStampEntryFromRoom;
  window.FireFlowOcrConfirm.applyConfirmedFsdfToLb = applyConfirmedFsdfToLb;
}
