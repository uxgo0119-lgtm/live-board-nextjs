// FSDF Ver2.0(Envelope化)で導入した documentType の識別子一覧。
//
// 【設計意図】documentTypeの文字列リテラルを他のファイルへ散在させないための単一の真実源。
// 新しいdocumentTypeを追加する場合は、まずここへ追加し、そのうえで
// validators/validateFsdf.js の PAYLOAD_VALIDATORS マップへ対応するpayload検証関数を
// 1エントリ追加する、という流れにする(「次の拡張を容易にする」という本プロジェクトの
// 既存の設計方針を踏襲)。
//
// 【現時点でのスコープ】当初実装したdocumentTypeは`roomInspectionSession`
// (LBの一時点の点検セッション書き出し。既存の平坦なFSDF Ver1.2が表していたもの全体)
// ただ1つのみだった。AIによる文書種別自動判定(documentTypeクラス分類層)は引き続き
// スコープ外(将来の別作業)。
//
// 【2026-08-03追加: propertyMasterIntake(Ver2.1)】
// FireFlow Ingest→FSDF→LB→RFの一本の実運用フロー完成に向けて、2つ目のdocumentType
// 「propertyMasterIntake」(点検前マスタ: 部屋一覧・階構成・感知器設置数等)を追加した。
// roomInspectionSession(点検中〜点検後の現場データ)とは意味的に別物であり、互いに
// 無関係のまま(roomInspectionSession側のスキーマ・検証ロジックは一切変更していない)。
// これはFSDF Envelope化(Ver2.0、2026-07-27)が最初から想定していた拡張であり、
// fsdf_version.md記載の通り「Ver1.xは追加のみ」の運用方針をマイナーバージョンにも
// 適用してVer2.1とした(詳細はfsdf_version.mdの変更履歴を参照)。
'use strict';

var DOCUMENT_TYPES = {
  // LBが書き出す、ある一時点の点検セッション(property + inspection + rooms[]等)。
  // 既存のFSDF Ver1.2(平坦形式)が表現していた内容そのもの。
  ROOM_INSPECTION_SESSION: 'roomInspectionSession',
  // [2026-08-03新設] 点検前の物件マスタ(部屋一覧・階構成・感知器設置数・物件基本情報)。
  // FireFlow Ingestの各Parser(roomRoster/sensorCount。将来はinspectionReportSummary等も)の
  // 出力を統合したもの。lib/toPropertyMasterIntake.js(fireflow_ingest側)が生成する。
  PROPERTY_MASTER_INTAKE: 'propertyMasterIntake',
};

var SUPPORTED_DOCUMENT_TYPES = [DOCUMENT_TYPES.ROOM_INSPECTION_SESSION, DOCUMENT_TYPES.PROPERTY_MASTER_INTAKE];

function isSupportedDocumentType(documentType) {
  return SUPPORTED_DOCUMENT_TYPES.indexOf(documentType) !== -1;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    DOCUMENT_TYPES: DOCUMENT_TYPES,
    SUPPORTED_DOCUMENT_TYPES: SUPPORTED_DOCUMENT_TYPES,
    isSupportedDocumentType: isSupportedDocumentType,
  };
} else if (typeof window !== 'undefined') {
  window.FireFlowFsdf = window.FireFlowFsdf || {};
  window.FireFlowFsdf.DOCUMENT_TYPES = DOCUMENT_TYPES;
  window.FireFlowFsdf.SUPPORTED_DOCUMENT_TYPES = SUPPORTED_DOCUMENT_TYPES;
  window.FireFlowFsdf.isSupportedDocumentType = isSupportedDocumentType;
}
