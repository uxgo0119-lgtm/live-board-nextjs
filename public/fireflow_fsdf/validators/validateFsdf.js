// FSDF(FireFlow Standard Data Format)検証。既存のvalidate_lb_payload.js(rf_tool/)と同じ
// スタイル(手書きの構造チェック、JSON Schemaエンジンは使わない)で書く。Node/ブラウザ両対応の
// 素のJS(CommonJSエクスポート、ブラウザではグローバル関数としても呼べるようscript直書き時は
// 末尾のmodule.exportsをそのまま残せば動く)。
//
// スキーマ定義そのものは ../schema/fsdf.schema.json を正とする。本ファイルはその内容を
// 実行時に検証するための実装であり、両者は必ず同期させること。
//
// 【Ver2.0(Envelope化)対応】validateFsdf()はEnvelope形状(fsdfVersion/documentType/property/
// payload)の入力のみを受け付ける(バリデータ自体を複雑化させないという設計方針により、
// 平坦形式(Ver1.x)とEnvelope形式の両方を受け付ける二重対応にはしない)。平坦形式のFSDFを
// 検証したい場合は、呼び出し側が先に convert/envelopeAdapter.js の wrapAsEnvelope() で
// Envelope化してから渡すこと。
//
// 「payloadのスキーマ検証はdocumentType単位で分離できる構成にすること」という要件に対応するため、
// payload検証ロジックは PAYLOAD_VALIDATORS マップ(documentType文字列 -> 検証関数)へ分離した。
// 将来2つ目のdocumentTypeを追加する場合は、対応するvalidateXxxPayload()関数を実装し、
// PAYLOAD_VALIDATORSへ1エントリ追加するだけでよい。
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

var VALID_STATUS = ['pending', 'done', 'absent', 'cancelled'];
var VALID_SOURCE_STATUS = ['scheduled', 'pass', 'cancelled', 'unanswered', 'absent', 'illegible', 'other'];
var VALID_PERIOD = ['AM', 'PM'];
var VALID_SOURCE_TYPE = ['manual_entry', 'ocr_paper_sheet', 'ocr_resident_time_request'];
var VALID_WARNING_SEVERITY = ['error', 'warning', 'info'];

// ---- documentType: roomInspectionSession のpayload検証 ----
// 既存(Ver1.2までの平坦形式時代)のvalidateFsdf()が行っていたrooms/inspection/batchWarnings
// 検証ロジックをそのまま移設したもの(ルール自体は一切変更していない。フラットな
// トップレベルオブジェクトの代わりにpayloadオブジェクトを見るようになっただけ)。
function validateRoomInspectionSessionPayload(payload) {
  var errors = [];
  var warnings = [];
  function err(path, message, fix) { errors.push({ path: path, message: message, fix: fix || '' }); }
  function warn(path, message, fix) { warnings.push({ path: path, message: message, fix: fix || '' }); }

  // ---- inspection (OCR由来の工程情報。任意) ----
  if (payload.inspection !== undefined && payload.inspection !== null) {
    if (typeof payload.inspection !== 'object' || Array.isArray(payload.inspection)) {
      warn('inspection', 'inspectionがオブジェクトではありません。', '無視して処理を続けます。');
    } else if (payload.inspection.totalScheduleDays !== undefined && payload.inspection.totalScheduleDays !== null) {
      if (typeof payload.inspection.totalScheduleDays !== 'number' || payload.inspection.totalScheduleDays < 1) {
        warn('inspection.totalScheduleDays', 'totalScheduleDaysが1以上の数値ではありません(現在の値: ' + JSON.stringify(payload.inspection.totalScheduleDays) + ')。', '');
      }
    }
  }

  // ---- batchWarnings(帳票全体に関わる警告。任意) ----
  if (payload.batchWarnings !== undefined && payload.batchWarnings !== null) {
    if (!Array.isArray(payload.batchWarnings)) {
      warn('batchWarnings', 'batchWarningsが配列ではありません。', '無視します。');
    } else {
      payload.batchWarnings.forEach(function (w, wIdx) {
        if (!w || typeof w !== 'object' || typeof w.field !== 'string' || typeof w.message !== 'string') {
          warn('batchWarnings[' + wIdx + ']', 'batchWarnings[' + wIdx + ']がfield/messageを持つオブジェクトではありません。', '');
        }
      });
    }
  }

  // ---- rooms ----
  if (!Array.isArray(payload.rooms)) {
    err('rooms', '部屋データ(rooms)がないか、配列ではありません。', '');
  } else {
    var seenRooms = Object.create(null);
    var dupRooms = [];
    var missingRoomNumber = 0;
    var unusualStatusRooms = [];
    var badScheduleDayRooms = [];
    var badConfidenceRooms = [];

    payload.rooms.forEach(function (room, idx) {
      if (!room || typeof room !== 'object' || Array.isArray(room)) {
        missingRoomNumber++;
        return;
      }
      var roomNumberOk = (typeof room.roomNumber === 'string' && room.roomNumber.trim()) ||
        (typeof room.roomNumber === 'number' && !isNaN(room.roomNumber));
      if (!roomNumberOk) {
        missingRoomNumber++;
        return;
      }
      var roomKey = String(room.roomNumber).trim();
      if (seenRooms[roomKey]) dupRooms.push(roomKey);
      seenRooms[roomKey] = true;

      if (room.status !== undefined && room.status !== null) {
        if (VALID_STATUS.indexOf(room.status) === -1) {
          unusualStatusRooms.push(roomKey + '(' + room.status + ')');
        }
      }

      if (room.scheduleDay !== undefined && room.scheduleDay !== null) {
        if (typeof room.scheduleDay !== 'number' || room.scheduleDay < 1 || Math.floor(room.scheduleDay) !== room.scheduleDay) {
          badScheduleDayRooms.push(roomKey);
        }
      }

      if (room.sourceStatus !== undefined && room.sourceStatus !== null && VALID_SOURCE_STATUS.indexOf(room.sourceStatus) === -1) {
        warn('rooms[' + idx + '].sourceStatus', roomKey + '号室のsourceStatusが想定外の値です(現在の値: ' + JSON.stringify(room.sourceStatus) + ')。',
          '想定される値は scheduled/pass/cancelled/unanswered/absent/illegible/other です。');
      }
      if (room.sourceStatus === 'illegible' && (!room.sourceMeta || !Array.isArray(room.sourceMeta.warnings) || room.sourceMeta.warnings.length === 0)) {
        warn('rooms[' + idx + '].sourceStatus', roomKey + '号室はsourceStatus="illegible"(判読不能)ですが、理由を示すsourceMeta.warningsがありません。', 'OCR Normalizerが警告を残すべき箇所です。');
      }
      // status(既存: 点検実施を表す)とsourceStatus(OCR帳票専用の別軸)は役割が異なるため、
      // 同じ部屋に両方が非nullで設定されている場合は責務の重複がないか確認を促す。
      if (room.status !== undefined && room.status !== null && room.sourceStatus !== undefined && room.sourceStatus !== null) {
        warn('rooms[' + idx + '].status', roomKey + '号室はstatusとsourceStatusの両方が設定されています。両者は役割が異なる別軸のフィールドです。意図した設定か確認してください。', '');
      }

      if (room.timePreference !== undefined && room.timePreference !== null) {
        if (typeof room.timePreference !== 'object' || Array.isArray(room.timePreference)) {
          warn('rooms[' + idx + '].timePreference', roomKey + '号室のtimePreferenceがオブジェクトではありません。', '無視します。');
        } else if (room.timePreference.period !== undefined && room.timePreference.period !== null &&
          VALID_PERIOD.indexOf(room.timePreference.period) === -1) {
          warn('rooms[' + idx + '].timePreference.period', roomKey + '号室のtimePreference.periodが"AM"/"PM"以外です(現在の値: ' +
            JSON.stringify(room.timePreference.period) + ')。', '');
        }
      }

      if (room.sourceMeta !== undefined && room.sourceMeta !== null) {
        if (typeof room.sourceMeta !== 'object' || Array.isArray(room.sourceMeta)) {
          warn('rooms[' + idx + '].sourceMeta', roomKey + '号室のsourceMetaがオブジェクトではありません。', '無視します。');
        } else {
          if (room.sourceMeta.sourceType !== undefined && room.sourceMeta.sourceType !== null &&
            VALID_SOURCE_TYPE.indexOf(room.sourceMeta.sourceType) === -1) {
            warn('rooms[' + idx + '].sourceMeta.sourceType', roomKey + '号室のsourceType が想定外です(現在の値: ' +
              JSON.stringify(room.sourceMeta.sourceType) + ')。', '');
          }
          if (room.sourceMeta.ocrConfidence !== undefined && room.sourceMeta.ocrConfidence !== null) {
            if (typeof room.sourceMeta.ocrConfidence !== 'object' || Array.isArray(room.sourceMeta.ocrConfidence)) {
              badConfidenceRooms.push(roomKey);
            } else {
              Object.keys(room.sourceMeta.ocrConfidence).forEach(function (field) {
                var v = room.sourceMeta.ocrConfidence[field];
                if (typeof v !== 'number' || v < 0 || v > 1) {
                  badConfidenceRooms.push(roomKey + '.' + field);
                }
              });
            }
          }
          if (room.sourceMeta.warnings !== undefined && room.sourceMeta.warnings !== null) {
            if (!Array.isArray(room.sourceMeta.warnings)) {
              warn('rooms[' + idx + '].sourceMeta.warnings', roomKey + '号室のsourceMeta.warningsが配列ではありません。', '無視します。');
            } else {
              room.sourceMeta.warnings.forEach(function (w, wIdx) {
                if (!w || typeof w !== 'object' || typeof w.field !== 'string' || typeof w.message !== 'string') {
                  warn('rooms[' + idx + '].sourceMeta.warnings[' + wIdx + ']', roomKey + '号室のwarnings[' + wIdx + ']がfield/messageを持つオブジェクトではありません。', '');
                } else if (w.severity !== undefined && w.severity !== null && VALID_WARNING_SEVERITY.indexOf(w.severity) === -1) {
                  warn('rooms[' + idx + '].sourceMeta.warnings[' + wIdx + '].severity', roomKey + '号室のwarnings[' + wIdx + '].severityが想定外です(現在の値: ' + JSON.stringify(w.severity) + ')。', '');
                }
              });
            }
          }
          // 「AI提案には確信度→低確信度だけ人間確認」の原則をFSDFレベルで確認する:
          // reviewedAtが設定されているのにreviewedByが無い(誰が確認したか分からない)場合は警告。
          if (room.sourceMeta.reviewedAt && !room.sourceMeta.reviewedBy) {
            warn('rooms[' + idx + '].sourceMeta.reviewedBy', roomKey + '号室はreviewedAtが設定されていますが、reviewedByが空です。', '誰が確認したか記録されません。');
          }

          // ---- reviewEdits / editedFields(Ver1.2・OCR確認画面Phase3で追加) ----
          if (room.sourceMeta.reviewEdits !== undefined && room.sourceMeta.reviewEdits !== null) {
            if (!Array.isArray(room.sourceMeta.reviewEdits)) {
              warn('rooms[' + idx + '].sourceMeta.reviewEdits', roomKey + '号室のreviewEditsが配列ではありません。', '無視します。');
            } else {
              room.sourceMeta.reviewEdits.forEach(function (e, eIdx) {
                if (!e || typeof e !== 'object' || typeof e.field !== 'string' || typeof e.editedAt !== 'string') {
                  warn('rooms[' + idx + '].sourceMeta.reviewEdits[' + eIdx + ']', roomKey + '号室のreviewEdits[' + eIdx + ']がfield/editedAtを持つオブジェクトではありません。', '');
                }
              });
            }
          }
          if (room.sourceMeta.editedFields !== undefined && room.sourceMeta.editedFields !== null) {
            if (!Array.isArray(room.sourceMeta.editedFields) || !room.sourceMeta.editedFields.every(function (f) { return typeof f === 'string'; })) {
              warn('rooms[' + idx + '].sourceMeta.editedFields', roomKey + '号室のeditedFieldsが文字列の配列ではありません。', '無視します。');
            }
          }
        }
      }
    });

    if (missingRoomNumber > 0) {
      if (missingRoomNumber === payload.rooms.length && payload.rooms.length > 0) {
        err('rooms[*].roomNumber', '部屋データ(rooms)の全' + payload.rooms.length + '件でroomNumberを取得できませんでした。', '');
      } else {
        warn('rooms[*].roomNumber', '部屋データ(rooms)のうち' + missingRoomNumber + '件でroomNumberが空/不正でした。', '該当行は集計・変換の対象から外れます。');
      }
    }
    if (dupRooms.length) {
      warn('rooms[*].roomNumber', 'roomNumberが重複している行があります: ' + dupRooms.join('、') + '。', '後勝ちで処理される可能性があります。');
    }
    if (unusualStatusRooms.length) {
      warn('rooms[*].status', '想定外のstatus値を持つ部屋があります: ' + unusualStatusRooms.join('、') + '。', '想定される値は pending/done/absent/cancelled です。');
    }
    if (badScheduleDayRooms.length) {
      warn('rooms[*].scheduleDay', 'scheduleDayが1以上の整数ではない部屋があります: ' + badScheduleDayRooms.join('、') + '。', '');
    }
    if (badConfidenceRooms.length) {
      warn('rooms[*].sourceMeta.ocrConfidence', 'ocrConfidenceの値が0〜1の範囲外、または数値でない項目があります: ' + badConfidenceRooms.join('、') + '。', '');
    }
  }

  return { errors: errors, warnings: warnings };
}

// ---- documentType: propertyMasterIntake のpayload検証 ----
// [2026-08-03新設] FireFlow Ingest(lib/toPropertyMasterIntake.js)が生成するEnvelopeの
// payload検証。「対応済みdocumentTypeを追加する場合は、対応するvalidateXxxPayload()を実装し
// PAYLOAD_VALIDATORSへ1エントリ追加するだけでよい」という既存の拡張方針どおりに追加した
// (validateRoomInspectionSessionPayload・validateFsdf本体は無変更)。
function validatePropertyMasterIntakePayload(payload) {
  var errors = [];
  var warnings = [];
  function err(path, message, fix) { errors.push({ path: path, message: message, fix: fix || '' }); }
  function warn(path, message, fix) { warnings.push({ path: path, message: message, fix: fix || '' }); }

  // ---- sourceDocuments(抽出元の追跡。任意だが、あれば配列であること) ----
  if (payload.sourceDocuments !== undefined && payload.sourceDocuments !== null) {
    if (!Array.isArray(payload.sourceDocuments)) {
      warn('sourceDocuments', 'sourceDocumentsが配列ではありません。', '無視します。');
    } else {
      payload.sourceDocuments.forEach(function (doc, idx) {
        if (!doc || typeof doc !== 'object' || typeof doc.documentKind !== 'string') {
          warn('sourceDocuments[' + idx + ']', 'sourceDocuments[' + idx + ']がdocumentKindを持つオブジェクトではありません。', '');
        } else if (doc.confidence !== undefined && doc.confidence !== null && (typeof doc.confidence !== 'number' || doc.confidence < 0 || doc.confidence > 1)) {
          warn('sourceDocuments[' + idx + '].confidence', doc.documentKind + 'のconfidenceが0〜1の範囲外、または数値ではありません(現在の値: ' + JSON.stringify(doc.confidence) + ')。', '');
        }
      });
    }
  }

  // ---- roomRoster(住戸一覧。任意: roomRosterを含まないpropertyMasterIntakeも許容する。
  //      Phase1ではLBが1ファイルずつ処理するため、sensorCountのみのEnvelopeも正常系) ----
  if (payload.roomRoster !== undefined && payload.roomRoster !== null) {
    if (typeof payload.roomRoster !== 'object' || Array.isArray(payload.roomRoster)) {
      warn('roomRoster', 'roomRosterがオブジェクトではありません。', '無視します。');
    } else if (payload.roomRoster.rooms !== undefined && (typeof payload.roomRoster.rooms !== 'object' || Array.isArray(payload.roomRoster.rooms))) {
      warn('roomRoster.rooms', 'roomRoster.roomsがオブジェクト(部屋番号 -> 部屋情報のマップ)ではありません。', '');
    }
  }

  // ---- sensorMaster(感知器設置数。任意) ----
  // 【値を捏造しない原則】sa/teiは数値かnullのみを許容する。0埋めされたfireflowIngest由来の
  // データは想定外(既存経路Aのlegacy Excelにのみ許容される挙動)のため警告する。
  if (payload.sensorMaster !== undefined && payload.sensorMaster !== null) {
    if (typeof payload.sensorMaster !== 'object' || Array.isArray(payload.sensorMaster)) {
      warn('sensorMaster', 'sensorMasterがオブジェクトではありません。', '無視します。');
    } else {
      var badEntries = [];
      var missingSourceEntries = [];
      Object.keys(payload.sensorMaster).forEach(function (room) {
        var entry = payload.sensorMaster[room] || {};
        var saOk = entry.sa === null || typeof entry.sa === 'number';
        var teiOk = entry.tei === null || typeof entry.tei === 'number';
        if (!saOk || !teiOk) badEntries.push(room);
        if (entry.source !== undefined && entry.source !== null && entry.source !== 'fireflowIngest' && entry.source !== 'legacyExcel') {
          missingSourceEntries.push(room + '(' + JSON.stringify(entry.source) + ')');
        }
      });
      if (badEntries.length) {
        warn('sensorMaster[*].sa/tei', 'saまたはteiが数値でもnullでもない部屋があります: ' + badEntries.join('、') + '。', '数値化できない値は0ではなくnullで表現してください。');
      }
      if (missingSourceEntries.length) {
        warn('sensorMaster[*].source', '想定外のsource値を持つ部屋があります: ' + missingSourceEntries.join('、') + '。', '想定される値は fireflowIngest/legacyExcel です。');
      }
    }
  }

  // ---- warnings(各Parserの警告集約。任意) ----
  if (payload.warnings !== undefined && payload.warnings !== null && !Array.isArray(payload.warnings)) {
    warn('warnings', 'warningsが配列ではありません。', '無視します。');
  }

  // ---- propertyInfo / history(将来拡張用の予約フィールド、Phase1では常にnull/空配列) ----
  if (payload.history !== undefined && payload.history !== null && !Array.isArray(payload.history)) {
    warn('history', 'historyが配列ではありません(将来拡張用の予約フィールド)。', '無視します。');
  }

  return { errors: errors, warnings: warnings };
}

// documentType(文字列) -> payload検証関数。将来3つ目のdocumentTypeを追加する場合は、
// ここへ1エントリ追加するだけでよい(それ以外のvalidateFsdf()本体は変更不要)。
var PAYLOAD_VALIDATORS = {};
PAYLOAD_VALIDATORS[DOCUMENT_TYPES.ROOM_INSPECTION_SESSION] = validateRoomInspectionSessionPayload;
PAYLOAD_VALIDATORS[DOCUMENT_TYPES.PROPERTY_MASTER_INTAKE] = validatePropertyMasterIntakePayload;

// fsdf: Envelope形状(fsdfVersion/documentType/property/payload)のオブジェクトのみを受け付ける。
// 平坦形式(Ver1.x)を検証したい場合は、呼び出し側が先にconvert/envelopeAdapter.jsの
// wrapAsEnvelope()でEnvelope化してから渡すこと(本関数はその変換を行わない)。
function validateFsdf(fsdf) {
  var errors = [];   // 処理停止(FSDFとして扱えない)
  var warnings = []; // 続行可能(値が想定外だが処理は続けられる)
  function err(path, message, fix) { errors.push({ path: path, message: message, fix: fix || '' }); }
  function warn(path, message, fix) { warnings.push({ path: path, message: message, fix: fix || '' }); }

  if (fsdf === null || typeof fsdf !== 'object' || Array.isArray(fsdf)) {
    err('(root)', 'FSDFの最上位がオブジェクトではありません。', '');
    return { errors: errors, warnings: warnings, valid: false };
  }

  // ---- fsdfVersion(Envelope形式はVer2.0以上) ----
  if (typeof fsdf.fsdfVersion !== 'string' || !/^\d+\.\d+$/.test(fsdf.fsdfVersion)) {
    err('fsdfVersion', 'fsdfVersionが"<major>.<minor>"形式の文字列ではありません(現在の値: ' + JSON.stringify(fsdf.fsdfVersion) + ')。', '');
  } else if (parseInt(fsdf.fsdfVersion.split('.')[0], 10) < 2) {
    err('fsdfVersion', 'validateFsdf()はEnvelope形式(fsdfVersion 2.0以上)のみを受け付けます(現在の値: ' + JSON.stringify(fsdf.fsdfVersion) + ')。平坦形式(Ver1.x)を検証する場合は、先にconvert/envelopeAdapter.jsのwrapAsEnvelope()でEnvelope化してください。', '');
  }

  // ---- documentType ----
  var documentType = fsdf.documentType;
  if (documentType === undefined || documentType === null || documentType === '') {
    err('documentType', 'documentTypeが指定されていません。', '');
  } else if (!isSupportedDocumentType(documentType)) {
    err('documentType', 'documentType "' + documentType + '" は未対応です(対応済み: ' + (typeof DOCUMENT_TYPES !== 'undefined' && DOCUMENT_TYPES ? Object.keys(DOCUMENT_TYPES).map(function (k) { return DOCUMENT_TYPES[k]; }).join('、') : 'roomInspectionSession、propertyMasterIntake') + ')。', '');
  }

  // ---- property ----
  var hasProperty = fsdf.property && typeof fsdf.property === 'object' && !Array.isArray(fsdf.property);
  if (!hasProperty) {
    err('property', '物件情報(property)がありません。', '');
  } else if (!fsdf.property.name || typeof fsdf.property.name !== 'string' || !fsdf.property.name.trim()) {
    warn('property.name', '物件名(property.name)が空です。', '帳票生成時の建物名一致チェックが機能しなくなります。');
  }

  // ---- payload: 存在確認のうえ、documentType単位の検証関数へ委譲する ----
  var hasPayload = fsdf.payload && typeof fsdf.payload === 'object' && !Array.isArray(fsdf.payload);
  if (!hasPayload) {
    err('payload', 'payloadがないか、オブジェクトではありません。', '');
  } else if (documentType !== undefined && documentType !== null && documentType !== '' && isSupportedDocumentType(documentType)) {
    var payloadValidator = PAYLOAD_VALIDATORS[documentType];
    var payloadResult = payloadValidator(fsdf.payload);
    errors = errors.concat(payloadResult.errors);
    warnings = warnings.concat(payloadResult.warnings);
  }
  // documentTypeが不正/未対応の場合は、上ですでにerrを積んでいるため、payload検証自体は
  // (どの検証関数を使えばよいか決められないため)スキップする。

  return { errors: errors, warnings: warnings, valid: errors.length === 0 };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    validateFsdf: validateFsdf,
    validateRoomInspectionSessionPayload: validateRoomInspectionSessionPayload,
    validatePropertyMasterIntakePayload: validatePropertyMasterIntakePayload,
    PAYLOAD_VALIDATORS: PAYLOAD_VALIDATORS,
  };
} else if (typeof window !== 'undefined') {
  // ブラウザ直読み込み用(<script src>で読み込んだ場合、requireが使えないため名前空間へ登録する)。
  window.FireFlowFsdf = window.FireFlowFsdf || {};
  window.FireFlowFsdf.validateFsdf = validateFsdf;
  window.FireFlowFsdf.validateRoomInspectionSessionPayload = validateRoomInspectionSessionPayload;
  window.FireFlowFsdf.validatePropertyMasterIntakePayload = validatePropertyMasterIntakePayload;
  window.FireFlowFsdf.PAYLOAD_VALIDATORS = PAYLOAD_VALIDATORS;
}
