// [2026-07-27新設 Phase7] mock_ocr_provider.js(Phase2〜6のダミーOCR)の実プロバイダ版。
//
// run_pipeline.js の runOcrIntakePipeline(input, ocrProvider) の第2引数(ocrProvider)へ
// そのまま渡せる、`function(input): Promise<{sourceFile, rawRooms}>` という形の関数を作る。
// mock_ocr_provider.js と全く同じ非同期インターフェースに揃えてあるため、呼び出し側
// (run_pipeline.js・normalizeInspectionScheduleSheet.js)は一切変更不要。
//
// 実際の通信先は live-board-nextjs の `POST /api/v1/inspection-schedule-sheet/scan`
// (lib/handlers/scanInspectionScheduleSheet.ts)。認証ヘッダの付け方は、既存の
// lb_tool/index.html の点検希望時間連絡票OCR呼び出し(fetchStampOcrResult/
// fetchStampBulkOcrResult の scanRequestHeaders())と同じ方式(window.getAccessTokenが
// あれば取得してBearerで送る。ログインしていない場合はヘッダ無しで送りサーバー側の401に
// 任せる)にそろえてある。
//
// 【重要・設計方針】サーバー側(lib/ai/capabilities/ocr/documentTypes/inspectionScheduleSheet.ts)
// のプロンプトは、レスポンスのJSON形状をmock_ocr_provider.jsのrawRooms要素と同じフィールド名
// (roomNumberRaw/scheduleDayRaw/periodRaw/timeRaw/noteRaw/statusRaw/ladderRaw/memoRaw/
// confidence)にそろえてある。そのため本ファイルは基本的にAPIレスポンス(payload.result)を
// そのままrawRoomsとして右から左へ渡すだけでよい。ただし「サーバー側のJSON形状が将来変わって
// いないか」「AIが配列以外の想定外の形を返していないか」を無言で見過ごさないよう、
// 最低限の防御的チェック(配列であること・各要素がオブジェクトであること)は行う。
//
// 【重要・mockへの自動フォールバックはしない】ネットワークエラー・認証エラー・サーバー
// エラー時は、呼び出し元(index.html)へエラーを投げるだけで、mock_ocr_provider.jsの結果へ
// 黙って差し替えたりはしない(本番で「これは実データかダミーか」が曖昧になることを避ける
// ため。設計方針として意図的にこうしている)。
'use strict';

var DEFAULT_ENDPOINT = '/api/v1/inspection-schedule-sheet/scan';

// createRealOcrProvider(options): テスト・呼び出し元からendpoint/fetch実装/認証トークン取得
// 関数を差し替えられるファクトリ。ブラウザの通常利用では引数無しで呼べば、グローバルfetchと
// window.getAccessToken(存在すれば)を使う既定の関数が作られる(下記getRealOcrRawResultが
// それ)。Node側の契約テスト(real_ocr_provider_contract_test.js)では、fetchImpl/
// getAccessTokenをモックに差し替えて使う。
//
// options.endpoint: 省略時は DEFAULT_ENDPOINT
// options.fetchImpl: 省略時はグローバルのfetch(ブラウザ)。無ければ例外。
// options.getAccessToken: 省略時は window.getAccessToken(存在すれば)。無ければトークン無しで送る。
//
// 戻り値: function(input): Promise<{sourceFile, rawRooms}>
//   input: { sourceFile, mode: 'single'|'bulk', mediaType, data(base64) } のほか、
//     run_pipeline.jsが素通しする propertyId/propertyName/inspectionDate 等が含まれていてもよい
//     (このプロバイダはmediaType/data/mode/sourceFileだけを見る)。
function createRealOcrProvider(options) {
  options = options || {};
  var endpoint = options.endpoint || DEFAULT_ENDPOINT;
  var fetchImpl = options.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  var getAccessToken = Object.prototype.hasOwnProperty.call(options, 'getAccessToken')
    ? options.getAccessToken
    : (typeof window !== 'undefined' ? window.getAccessToken : null);

  return function getRealOcrRawResult(input) {
    input = input || {};

    if (!input.mediaType || !input.data) {
      return Promise.reject(new Error('real_ocr_provider: 画像/PDFが選択されていません(mediaType/dataが必要です)。'));
    }
    if (!fetchImpl) {
      return Promise.reject(new Error('real_ocr_provider: この環境ではfetchが利用できません。'));
    }

    var mode = input.mode === 'bulk' ? 'bulk' : 'single';

    return Promise.resolve()
      .then(function () {
        var headers = { 'Content-Type': 'application/json' };
        if (!getAccessToken) return headers;
        return Promise.resolve()
          .then(function () { return getAccessToken(); })
          .then(function (token) {
            if (token) headers['Authorization'] = 'Bearer ' + token;
            return headers;
          })
          .catch(function () {
            // ログインしていない場合等はトークン無しで送り、サーバー側の401判定に任せる
            // (既存のscanRequestHeaders()と同じ方針)。
            return headers;
          });
      })
      .then(function (headers) {
        return fetchImpl(endpoint, {
          method: 'POST',
          headers: headers,
          body: JSON.stringify({ mode: mode, mediaType: input.mediaType, data: input.data }),
        }).catch(function () {
          // fetch自体が例外を投げるのはネットワーク到達不能・CORS等の通信エラー。
          throw new Error('ネットワークエラー: サーバーに接続できませんでした。通信環境を確認してもう一度お試しください。');
        });
      })
      .then(function (response) {
        return response
          .json()
          .catch(function () {
            throw new Error('サーバーからの応答を解析できませんでした(HTTP ' + response.status + ')。');
          })
          .then(function (payload) {
            if (!response.ok || (payload && payload.error)) {
              if (response.status === 401) {
                throw new Error('認証エラー: ログインし直してから、もう一度お試しください。');
              }
              var msg = (payload && payload.error) || 'HTTPエラー ' + response.status;
              throw new Error('読み取りに失敗しました: ' + msg);
            }

            var rawRooms = payload && payload.result;
            if (!Array.isArray(rawRooms)) {
              throw new Error('サーバーからの応答の形式が想定外でした(配列ではありません)。');
            }
            // 防御的チェック: 各要素が最低限オブジェクトであることを確認する(サーバー側の
            // JSON形状が将来変わった場合に、無言でおかしなFSDFを作らずここで検知するため)。
            for (var i = 0; i < rawRooms.length; i++) {
              if (!rawRooms[i] || typeof rawRooms[i] !== 'object') {
                throw new Error('サーバーからの応答の' + (i + 1) + '件目の形式が想定外でした。');
              }
            }

            return { sourceFile: input.sourceFile || '', rawRooms: rawRooms };
          });
      });
  };
}

// getRealOcrRawResult: ブラウザ通常利用向けの既定インスタンス(グローバルfetch・
// window.getAccessTokenを使う)。run_pipeline.jsのocrProvider引数へそのまま渡せる。
var getRealOcrRawResult = createRealOcrProvider();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { createRealOcrProvider: createRealOcrProvider, getRealOcrRawResult: getRealOcrRawResult };
} else if (typeof window !== 'undefined') {
  window.FireFlowOcrIntake = window.FireFlowOcrIntake || {};
  window.FireFlowOcrIntake.createRealOcrProvider = createRealOcrProvider;
  window.FireFlowOcrIntake.getRealOcrRawResult = getRealOcrRawResult;
}
