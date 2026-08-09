// FSDF Ver2.0(Envelope化)の互換性の核。
//
// 【背景】既存のFSDF(Ver1.x)は「property/rooms[]/inspection/...」が全てトップレベルに
// フラットに並ぶ形式だった。Ver2.0では、将来複数のdocumentType(LBの点検セッション以外の
// 帳票種別)を追加できるようにするため、「fsdfVersion/documentType/property」の3つだけを
// Envelopeのトップレベルに残し、それ以外(inspection/rooms[]等、documentType固有の内容)を
// すべて`payload`の下へ移動する。
//
//   Ver1.x(平坦):
//     { fsdfVersion, property, inspection, rooms, batchWarnings, ... }
//   Ver2.0(Envelope化):
//     { fsdfVersion: '2.0', documentType: 'roomInspectionSession', property,
//       payload: { inspection, rooms, batchWarnings, ... } }
//
// 【本ファイルの役割】既存コード(lb_tool/ocr_confirm/*.js、fireflow_template_engine/*.js等)を
// Envelopeの入れ子構造に直接依存させないための変換アダプタ。境界(boundary)となる少数の
// エントリポイントでだけ wrapAsEnvelope()/unwrapEnvelope() を呼び、それ以外の内部ロジックは
// 従来どおり平坦な形("フラットビュー")のFSDFだけを見ればよいようにする。
//
// 【unwrapEnvelope()が返すフラットビューのfsdfVersionの規約(判断が分かれ得る点の明文化)】
// unwrapEnvelope()は、Envelopeから取り出した「フラットビュー」のfsdfVersionを、常に
// FLAT_VIEW_FSDF_VERSION(現在'1.2'。既存のconvert/lbExportConverter.jsのFSDF_VERSIONと同じ値。
// Envelope化される直前の、最後の平坦形式のバージョン)に固定する。
// 元のEnvelopeが実際に何のfsdfVersion("2.0"等)を名乗っていたかに関わらず、これを
// 「payloadの内容を、平坦形式(Ver1.2)の型として見るとこうなる」という一貫した投影
// (projection)として扱う。この規約により、
//   wrapAsEnvelope(unwrapEnvelope(envelope))
// は必ず「legacy平坦パス」(fsdfVersionのメジャーバージョンが2未満)を通り、payload/propertyの
// 中身さえ変わっていなければ元のEnvelopeと意味的に同値なEnvelopeへ戻る(round-trip可能)。
// もし逆に「元のEnvelope自身のfsdfVersionをそのままフラットビューにも転記する」規約を
// 採っていた場合、フラットビューがfsdfVersion:"2.0"を名乗るのにdocumentType/payloadを
// 持たない不整合な状態になり、それを再度wrapAsEnvelope()に渡すと
// 「fsdfVersionのメジャーバージョンが2以上なのにdocumentTypeが無い」という異常系として
// 弾かれてしまう(下記のエラー条件を参照)。そのため、このプロジェクトでは前者(固定値)を
// 採用する。
// 【重要】既に平坦な(=documentType/payloadを持たない)オブジェクトをunwrapEnvelope()に
// 渡した場合(防御的な冪等性)は、この規約を適用せず、入力のfsdfVersionをそのまま保持する
// (=何も壊さない。下記参照)。
'use strict';

var DOCUMENT_TYPES, isSupportedDocumentType;
if (typeof module !== 'undefined' && module.exports) {
  var documentTypesModule = require('../schema/documentTypes.js');
  DOCUMENT_TYPES = documentTypesModule.DOCUMENT_TYPES;
  isSupportedDocumentType = documentTypesModule.isSupportedDocumentType;
} else if (typeof window !== 'undefined') {
  DOCUMENT_TYPES = (window.FireFlowFsdf || {}).DOCUMENT_TYPES;
  isSupportedDocumentType = (window.FireFlowFsdf || {}).isSupportedDocumentType;
}

// unwrapEnvelope()が返すフラットビューのfsdfVersion(上記コメント参照)。
var FLAT_VIEW_FSDF_VERSION = '1.2';
// wrapAsEnvelope()がlegacy平坦オブジェクトから新規に組み立てるEnvelopeのfsdfVersion。
var ENVELOPE_FSDF_VERSION = '2.0';

var FSDF_VERSION_PATTERN = /^\d+\.\d+$/;

function parseMajorVersion(fsdfVersion) {
  return parseInt(String(fsdfVersion).split('.')[0], 10);
}

function assertValidFsdfVersion(value, fnName) {
  if (typeof value !== 'string' || !FSDF_VERSION_PATTERN.test(value)) {
    throw new Error(fnName + ': fsdfVersionが"<major>.<minor>"形式の文字列ではありません(現在の値: ' + JSON.stringify(value) + ')。');
  }
}

function assertKnownDocumentType(documentType, fnName) {
  if (documentType === undefined || documentType === null || documentType === '') {
    throw new Error(fnName + ': fsdfVersionのメジャーバージョンが2以上、またはEnvelope形式が期待される文脈ですが、documentTypeが指定されていません。');
  }
  if (!isSupportedDocumentType(documentType)) {
    throw new Error(fnName + ': documentType "' + documentType + '" は未対応です(対応済み: ' + (DOCUMENT_TYPES ? Object.keys(DOCUMENT_TYPES).map(function (k) { return DOCUMENT_TYPES[k]; }).join(', ') : '') + ')。');
  }
}

function assertHasPayload(fsdf, fnName) {
  if (fsdf.payload === undefined || fsdf.payload === null || typeof fsdf.payload !== 'object' || Array.isArray(fsdf.payload)) {
    throw new Error(fnName + ': Envelope形式(documentType指定あり)なのにpayloadがオブジェクトとして存在しません。');
  }
}

// fsdf: Envelope(Ver2.0)、またはVer1.x平坦形式のどちらでも受け付ける。
// 戻り値: 常にEnvelope形式のオブジェクト({fsdfVersion, documentType, property, payload})。
// 【冪等性】既に有効なVer2.0以上のEnvelopeが渡された場合は、(浅い複製をした上で)そのまま返す。
// payload.payloadのような二重ネストは発生しない。
function wrapAsEnvelope(fsdf) {
  if (!fsdf || typeof fsdf !== 'object' || Array.isArray(fsdf)) {
    throw new Error('wrapAsEnvelope: fsdfがオブジェクトではありません。');
  }
  assertValidFsdfVersion(fsdf.fsdfVersion, 'wrapAsEnvelope');

  var major = parseMajorVersion(fsdf.fsdfVersion);
  if (major >= 2) {
    // 既にEnvelope形式(のはず)。documentType/payloadの整合性を確認したうえで、
    // 冪等に(そのまま、浅い複製で)返す。
    assertKnownDocumentType(fsdf.documentType, 'wrapAsEnvelope');
    assertHasPayload(fsdf, 'wrapAsEnvelope');
    return Object.assign({}, fsdf);
  }

  // Ver1.x平坦形式として扱い、Envelopeへ包む。
  // fsdfVersion/propertyの2つだけをEnvelopeのトップレベルに残し、それ以外は全てpayloadへ。
  var payload = Object.assign({}, fsdf);
  delete payload.fsdfVersion;
  delete payload.property;

  return {
    fsdfVersion: ENVELOPE_FSDF_VERSION,
    documentType: DOCUMENT_TYPES.ROOM_INSPECTION_SESSION,
    property: fsdf.property,
    payload: payload,
  };
}

// envelope: Envelope(Ver2.0)を想定するが、防御的にVer1.x平坦形式(documentType/payloadを
// 持たない)が渡された場合はそのまま返す(冪等・非破壊)。
// 戻り値: 常に平坦形式のオブジェクト(既存コードがそのまま読み書きできる形)。
function unwrapEnvelope(envelope) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw new Error('unwrapEnvelope: envelopeがオブジェクトではありません。');
  }
  assertValidFsdfVersion(envelope.fsdfVersion, 'unwrapEnvelope');

  var major = parseMajorVersion(envelope.fsdfVersion);
  var looksLikeEnvelope = major >= 2 || envelope.documentType !== undefined || envelope.payload !== undefined;

  if (!looksLikeEnvelope) {
    // 既に平坦な形式(防御的な冪等性)。何も変更せず、そのまま(浅い複製で)返す。
    return Object.assign({}, envelope);
  }

  assertKnownDocumentType(envelope.documentType, 'unwrapEnvelope');
  assertHasPayload(envelope, 'unwrapEnvelope');

  // payloadの内容をトップレベルへ展開し、property/fsdfVersionを添える。
  // fsdfVersionは上記コメントの規約どおりFLAT_VIEW_FSDF_VERSIONに固定する
  // (元Envelopeが名乗っていたfsdfVersionの値そのものではない)。
  var flat = Object.assign({}, envelope.payload);
  flat.property = envelope.property;
  flat.fsdfVersion = FLAT_VIEW_FSDF_VERSION;
  return flat;
}

var EXPORTS = {
  FLAT_VIEW_FSDF_VERSION: FLAT_VIEW_FSDF_VERSION,
  ENVELOPE_FSDF_VERSION: ENVELOPE_FSDF_VERSION,
  wrapAsEnvelope: wrapAsEnvelope,
  unwrapEnvelope: unwrapEnvelope,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = EXPORTS;
} else if (typeof window !== 'undefined') {
  window.FireFlowFsdf = window.FireFlowFsdf || {};
  window.FireFlowFsdf.FLAT_VIEW_FSDF_VERSION = FLAT_VIEW_FSDF_VERSION;
  window.FireFlowFsdf.ENVELOPE_FSDF_VERSION = ENVELOPE_FSDF_VERSION;
  window.FireFlowFsdf.wrapAsEnvelope = wrapAsEnvelope;
  window.FireFlowFsdf.unwrapEnvelope = unwrapEnvelope;
}
