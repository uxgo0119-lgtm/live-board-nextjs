// Phase2「②OCR受け皿」用のダミーOCRプロバイダ。
//
// 設計書5章の工夫方針: ②〜⑥は実際のOCR AIを一切呼ばず、本ファイルが返す固定のダミー結果を
// 使ってパイプライン全体を開発・テストする。Phase7で実OCR接続に差し替える際は、本ファイルと
// 同じ形(Promiseを返す非同期関数、rawRooms配列を含むオブジェクト)を持つ実プロバイダに
// 差し替えるだけで済むようにする(既存lib/ai/のOcrCapability.scan()と同じ非同期インター
// フェースに揃えてある)。
//
// 【重要】ここで返すのは「OCR Raw Result」であり、FSDFではない。正規化前の生の読み取り結果
// (表記揺れ・矛盾・判読不能を含む)をそのまま返す。正規化はnormalize/配下が担当する。
'use strict';

// scenario='clean': 表記揺れの少ない、素直に読み取れたケース。
// scenario='messy': 表記揺れ・矛盾・判読不能・低信頼度・全角数字などをすべて含む、
//   OCR Normalizerの各処理を一通り検証するためのケース。
function buildRawRooms(scenario) {
  if (scenario === 'clean') {
    return [
      { roomNumberRaw: '1512', scheduleDayRaw: '2日目', periodRaw: 'PM', timeRaw: '13:00', noteRaw: '13:00希望', statusRaw: null, ladderRaw: null, memoRaw: '', confidence: { roomNumber: 0.98, scheduleDay: 0.95, period: 0.95, time: 0.95, status: 0.95 } },
      { roomNumberRaw: '1513', scheduleDayRaw: '1日目', periodRaw: 'AM', timeRaw: '9:00', noteRaw: '9:00希望', statusRaw: null, ladderRaw: null, memoRaw: '', confidence: { roomNumber: 0.98, scheduleDay: 0.95, period: 0.95, time: 0.95, status: 0.95 } },
    ];
  }

  // 'messy'(デフォルト): 実運用のFAX/写真経由OCRで実際に起こりうる表記揺れ・矛盾を一通り含む。
  return [
    // 全角数字の部屋番号・工程日。時間帯「午後」+時刻1桁(12時間表記)→24時間表記へ統一されるはず。
    { roomNumberRaw: '１５１２', scheduleDayRaw: '２日目', periodRaw: '午後', timeRaw: '1:00', noteRaw: '13:00希望', statusRaw: null, ladderRaw: null, memoRaw: '', confidence: { roomNumber: 0.9, scheduleDay: 0.85, period: 0.8, time: 0.8, status: 0.9 } },
    // PASS表記(自動的にdone/pendingへ変換してはならない)。
    { roomNumberRaw: '1513', scheduleDayRaw: '1日目', periodRaw: null, timeRaw: null, noteRaw: '確認済み', statusRaw: 'PASS', ladderRaw: null, memoRaw: '', confidence: { roomNumber: 0.95, status: 0.9 } },
    // キャンセルの表記揺れ(辞退)。
    { roomNumberRaw: '1514', scheduleDayRaw: '1日目', periodRaw: null, timeRaw: null, noteRaw: null, statusRaw: '辞退', ladderRaw: null, memoRaw: '', confidence: { roomNumber: 0.9, status: 0.85 } },
    // 未回答の表記揺れ。
    { roomNumberRaw: '1515', scheduleDayRaw: '2日目', periodRaw: null, timeRaw: null, noteRaw: null, statusRaw: '未回答', ladderRaw: null, memoRaw: '', confidence: { roomNumber: 0.9, status: 0.8 } },
    // 不在。
    { roomNumberRaw: '1516', scheduleDayRaw: '2日目', periodRaw: null, timeRaw: null, noteRaw: null, statusRaw: '不在', ladderRaw: null, memoRaw: '', confidence: { roomNumber: 0.9, status: 0.85 } },
    // 未知の特殊状態(リフォーム中)。既知語彙に無理に寄せず'other'として保持されるはず。
    { roomNumberRaw: '1517', scheduleDayRaw: '1日目', periodRaw: null, timeRaw: null, noteRaw: null, statusRaw: 'リフォーム中', ladderRaw: null, memoRaw: '', confidence: { roomNumber: 0.9, status: 0.7 } },
    // ステータス欄が空欄(判読不能)。自動確定せず'illegible'になるはず。
    { roomNumberRaw: '1518', scheduleDayRaw: '1日目', periodRaw: null, timeRaw: null, noteRaw: null, statusRaw: '', ladderRaw: null, memoRaw: '', confidence: { roomNumber: 0.9 } },
    // 時間帯と時刻の矛盾(AM表記なのに15:00=午後の時刻)。自動修正せず警告のみ。
    { roomNumberRaw: '1519', scheduleDayRaw: '2日目', periodRaw: 'AM', timeRaw: '15:00', noteRaw: '15:00希望(記載ママ)', statusRaw: null, ladderRaw: null, memoRaw: '', confidence: { roomNumber: 0.9, scheduleDay: 0.85, period: 0.6, time: 0.6, status: 0.9 } },
    // 避難はしご対象部屋。低信頼度の部屋番号(要確認閾値0.75未満)。
    { roomNumberRaw: '1520', scheduleDayRaw: '2日目', periodRaw: 'PM', timeRaw: '14:00', noteRaw: '14:00希望', statusRaw: null, ladderRaw: 'はしご', memoRaw: '避難はしご設置予定', confidence: { roomNumber: 0.6, scheduleDay: 0.85, period: 0.9, time: 0.9, status: 0.9 } },
    // 工程日が解析不能な表記。
    { roomNumberRaw: '1521', scheduleDayRaw: '謎の記号', periodRaw: 'PM', timeRaw: '10:00', noteRaw: '', statusRaw: null, ladderRaw: null, memoRaw: '', confidence: { roomNumber: 0.9, scheduleDay: 0.3, period: 0.9, time: 0.9, status: 0.9 } },
    // 部屋番号自体が読み取れない行(FSDFへは含まれず、エラー警告になるはず)。
    { roomNumberRaw: '', scheduleDayRaw: '1日目', periodRaw: 'AM', timeRaw: '9:00', noteRaw: '', statusRaw: null, ladderRaw: null, memoRaw: '', confidence: {} },
  ];
}

// input: { sourceFile: string, scenario?: 'clean'|'messy' }
// 戻り値: Promise<{ sourceFile, rawRooms: [...] }>(実OCR接続時と同じ非同期インターフェース)
function getMockOcrRawResult(input) {
  input = input || {};
  var scenario = input.scenario || 'messy';
  var sourceFile = input.sourceFile || ('mock_' + scenario + '_scan.jpg');
  return Promise.resolve({
    sourceFile: sourceFile,
    rawRooms: buildRawRooms(scenario),
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { getMockOcrRawResult: getMockOcrRawResult };
} else if (typeof window !== 'undefined') {
  window.FireFlowOcrIntake = window.FireFlowOcrIntake || {};
  window.FireFlowOcrIntake.getMockOcrRawResult = getMockOcrRawResult;
}
