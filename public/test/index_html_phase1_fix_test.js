// [2026-08-09新設、実装修正フェーズ1 回帰テスト] public/index.html(LB本体、Route A/表示層)は
// 単一の巨大<script>内にインライン関数を持ち、既存のocr_intake/ocr_confirmのようなmodule.exports
// 経由の単体テストが存在しない。今回のFix1〜Fix4はこのindex.html側のロジックにも影響するため、
// 新たにビルドやリファクタを行わず(「大規模リファクタ禁止」の方針を尊重)、対象関数のソースを
// index.htmlから文字列として直接抽出し、Node.jsのvmモジュールで最小限の依存(グローバル変数)
// だけをスタブして実行することで、既存コードに一切手を入れずに回帰テストを追加する。
//
// 【注意】この抽出方式は「関数本体の文字列内に不釣り合いな{/}を含まない」ことを前提にした単純な
// 波括弧カウント方式であり、対象の4関数(いずれも本テスト作成時点でこの前提を満たすことを目視
// 確認済み)以外への流用は非推奨。index.html側の対象関数を変更した場合、本テストが期待通りに
// 抽出できているか(抽出結果が空/未定義にならないか)を明示的にチェックしている。
'use strict';
var fs = require('fs');
var path = require('path');
var vm = require('vm');

var results = [];
function check(label, cond, detail) {
  results.push({ label: label, ok: !!cond });
  console.log((cond ? 'OK' : 'NG') + ': ' + label + (detail !== undefined ? ' (' + JSON.stringify(detail) + ')' : ''));
}

var html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');

function extractFunctionSource(name) {
  var marker = 'function ' + name + '(';
  var startIdx = html.indexOf(marker);
  if (startIdx === -1) throw new Error('MISSING IMPLEMENTATION SOURCE: function ' + name + ' が index.html に見つかりません');
  var braceStart = html.indexOf('{', startIdx);
  var depth = 0;
  var i = braceStart;
  for (; i < html.length; i++) {
    var ch = html[i];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  if (depth !== 0) throw new Error('関数 ' + name + ' の波括弧の対応が取れませんでした(抽出方式の前提が崩れている可能性)');
  return html.slice(startIdx, i);
}

// 単一行の `var NAME = {...};` 形式の宣言を抽出する(VALID_STAMP_TIME_MODES用)。
function extractVarDeclSource(name) {
  var marker = 'var ' + name + ' = ';
  var startIdx = html.indexOf(marker);
  if (startIdx === -1) throw new Error('MISSING IMPLEMENTATION SOURCE: var ' + name + ' が index.html に見つかりません');
  var semiIdx = html.indexOf(';', startIdx);
  if (semiIdx === -1) throw new Error('var ' + name + ' の宣言の終端(;)が見つかりません');
  return html.slice(startIdx, semiIdx + 1);
}

console.log('==== formatStampTimeDisplay / resolveStampTimeMode (Fix1/Fix2、Route A表示層) ====');
(function () {
  var src = extractVarDeclSource('VALID_STAMP_TIME_MODES') + '\n'
    + extractFunctionSource('resolveStampTimeMode') + '\n'
    + extractFunctionSource('formatStampTimeDisplay');
  var ctx = vm.createContext({});
  vm.runInContext(src, ctx);

  // ---- resolveStampTimeMode: Fix2 4状態の判定 ----
  check('modeRaw="exact"+time有り → "exact"のまま', ctx.resolveStampTimeMode('exact', '09:30', '') === 'exact');
  check('modeRaw="start_only"+time有り → "start_only"のまま(「13:00〜」)', ctx.resolveStampTimeMode('start_only', '13:00', '') === 'start_only');
  check('modeRaw="end_only"+timeEnd有り → "end_only"のまま(「〜10:30」)', ctx.resolveStampTimeMode('end_only', '', '10:30') === 'end_only');
  check('modeRaw="range"+time/timeEnd両方有り → "range"のまま', ctx.resolveStampTimeMode('range', '09:30', '10:30') === 'range');
  check('modeRaw未申告+timeのみ → 安全側で"exact"(「〜」を捏造しない)', ctx.resolveStampTimeMode(null, '09:30', '') === 'exact');
  check('modeRaw未申告+timeEndのみ → "end_only"と一意に推測', ctx.resolveStampTimeMode(undefined, '', '10:30') === 'end_only');
  check('modeRaw未申告+time/timeEnd無し → 空文字', ctx.resolveStampTimeMode('', '', '') === '');
  check('modeRaw="end_only"だがtimeEndが編集で消えた(矛盾) → フォールバック推測へ切替(時刻自体も無ければ空)', ctx.resolveStampTimeMode('end_only', '', '') === '');
  check('modeRaw="exact"だが実際はtime+timeEnd両方ある(レビュー画面で終了時刻が追加された等) → フォールバックで"range"', ctx.resolveStampTimeMode('exact', '09:30', '10:30') === 'range');

  // ---- formatStampTimeDisplay: Fix2 表示文字列の「〜」方向の保持 ----
  check('exact: "9:30"のみ → "9:30"のまま(「〜」を付与しない)', ctx.formatStampTimeDisplay('9:30', '', 'exact') === '9:30');
  check('start_only: "13:00〜" → 開始側のみ「〜」が付く', ctx.formatStampTimeDisplay('13:00', '', 'start_only') === '13:00〜');
  check('end_only: "〜10:30" → 終了側のみ「〜」が付く(具体時刻10:30へ変換されない)', ctx.formatStampTimeDisplay('', '10:30', 'end_only') === '〜10:30');
  check('range: "9:30〜10:30" → 開始・終了とも保持される', ctx.formatStampTimeDisplay('9:30', '10:30', 'range') === '9:30〜10:30');
  check('time/timeEndともに無ければnull', ctx.formatStampTimeDisplay('', '', '') === null);
})();

console.log('\n==== extendSensorMasterFromEntries / sensorDisplayStateOf (Fix4、感知器total保持 / SENSOR MASTER P0-P1、フィールド単位Source補完) ====');
(function () {
  var src = extractFunctionSource('mergeSensorMasterField') + '\n'
    + extractFunctionSource('extendSensorMasterFromEntries') + '\n'
    + extractFunctionSource('sensorDisplayStateOf');
  var ctx = vm.createContext({
    SENSOR_MASTER: {},
    persistCurrentProperty: function () { /* テストではI/O不要のためno-op */ },
  });
  vm.runInContext(src, ctx);

  // ---- Case: 丸数字の合計数しか分からない(sa/teiは種別未解決) ----
  ctx.extendSensorMasterFromEntries({ '302': { sa: null, tei: null, total: 6 } }, 'fireflowIngest');
  check('total=6のみの部屋がSENSOR_MASTERに反映される(totalが破棄されない、INGEST_MAPPING_ERROR修正)',
    ctx.SENSOR_MASTER['302'] && ctx.SENSOR_MASTER['302'].total === 6, ctx.SENSOR_MASTER['302']);
  var dsTotalOnly = ctx.sensorDisplayStateOf('302');
  check('total=6のみ: sa/teiは未確認(null)のまま、0や推測値へは補完されない', dsTotalOnly.sa === null && dsTotalOnly.tei === null && dsTotalOnly.state === 'unconfirmed_null', dsTotalOnly);
  check('total=6のみ: sensorDisplayStateOf().totalに6がそのまま反映される', dsTotalOnly.total === 6, dsTotalOnly);

  // ---- Case: 既存の内訳(sa/tei)ありデータには影響しない(total無し=既存の他物件フォーマット) ----
  ctx.extendSensorMasterFromEntries({ '410': { sa: 3, tei: 2 } }, 'fireflowIngest');
  var dsBreakdown = ctx.sensorDisplayStateOf('410');
  check('既存のsa/tei内訳データ(sa=3,tei=2)の表示は変更されない', dsBreakdown.sa === 3 && dsBreakdown.tei === 2 && dsBreakdown.state === 'confirmed', dsBreakdown);
  check('sa/tei内訳ありの場合、totalはnullのまま(捏造しない)', dsBreakdown.total === null, dsBreakdown);

  // ---- Case: 確認済みでsa=0/tei=0/total=0(本当に0件と確認済み) ----
  ctx.extendSensorMasterFromEntries({ '501': { sa: 0, tei: 0, total: 0 } }, 'fireflowIngest');
  var dsZero = ctx.sensorDisplayStateOf('501');
  check('sa=0/tei=0/total=0(確認済みのゼロ)は未確認扱いにならない(0とnull/未確認を混同しない)', dsZero.sa === 0 && dsZero.tei === 0 && dsZero.total === 0 && dsZero.state === 'confirmed', dsZero);

  // ---- Case: エントリ自体が無い部屋 ----
  var dsNoEntry = ctx.sensorDisplayStateOf('999');
  check('エントリ無しの部屋はunconfirmed_no_entry、totalもnull', dsNoEntry.state === 'unconfirmed_no_entry' && dsNoEntry.total === null, dsNoEntry);

  // ---- Case: 既存部屋は上書きされない(追加のみ、の既存方針を壊していないか) ----
  ctx.extendSensorMasterFromEntries({ '410': { sa: 99, tei: 99, total: 99 } }, 'fireflowIngest');
  check('既存の部屋番号(410)は追加処理で上書きされない(既存の「追加のみ」方針を維持)', ctx.SENSOR_MASTER['410'].sa === 3 && ctx.SENSOR_MASTER['410'].tei === 2, ctx.SENSOR_MASTER['410']);
})();

console.log('\n==== detailFor (Fix3: note表示 / Fix4: sensor total表示) ====');
(function () {
  var src = extractFunctionSource('escapeHtml') + '\n'
    + extractFunctionSource('sensorDisplayStateOf') + '\n'
    + extractFunctionSource('detailFor');
  var stampData = {
    '302': { symbol: 'A', time: '', time_end: '', note: '朝一', name: '' },
    '303': { symbol: 'A', time: '', time_end: '', note: '', name: '' },
    // note内にHTML特殊文字が含まれても無害化されることを確認するためのフィクスチャ。
    '304': { symbol: '', time: '', time_end: '', note: '<script>', name: '' },
  };
  var state = {};
  var ctx = vm.createContext({
    currentHomeMode: 'normal',
    STAMP_DATA: stampData,
    state: state,
    SENSOR_MASTER: { '910': { sa: null, tei: null, total: 6, source: 'fireflowIngest' } },
    String: String,
  });
  vm.runInContext(src, ctx);

  // ---- Fix3: symbol=A+note="朝一"の部屋(302) → noteが元の文言のまま表示される(具体時刻へ変換しない) ----
  var detail302 = ctx.detailFor('302', 'pending');
  check('302号室: symbol=A+note="朝一" → 「朝一」がそのまま表示される(具体時刻へ変換されない)', detail302.indexOf('朝一') !== -1, detail302);
  check('302号室: 「09:00」等の具体時刻へ変換されていない', detail302.indexOf('09:00') === -1, detail302);

  // ---- Fix3: noteが空の部屋(303) → 既存表示(空文字)のまま、余計な空白・プレースホルダが出ない ----
  var detail303 = ctx.detailFor('303', 'pending');
  check('303号室: noteが空の場合は既存通り空文字を返す(余計な表示が出ない)', detail303 === '', detail303);

  // ---- Fix3: cancelled状態は従来通り空文字のまま(note表示を追加していない) ----
  var detail303cancelled = ctx.detailFor('303', 'cancelled');
  check('cancelled状態はnote有無に関わらず従来通り空文字のまま(既存表示を変更しない)', detail303cancelled === '', detail303cancelled);

  // ---- Fix3: noteにHTML特殊文字が含まれていてもエスケープされる(escapeHtml経由) ----
  var detail304 = ctx.detailFor('304', 'pending');
  check('noteはescapeHtml()を通して描画され、生のHTMLタグとして挿入されない', detail304.indexOf('<script>') === -1 && detail304.indexOf('&lt;script&gt;') !== -1, detail304);

  // ---- Fix4: sensorモードでtotalのみ判明している部屋(910) → sa/teiは未確認のまま、totalが表示される ----
  ctx.currentHomeMode = 'sensor';
  var detailSensorTotal = ctx.detailFor('910');
  check('感知器モード: total=6のみの部屋は「合計6」が表示される', detailSensorTotal.indexOf('合計6') !== -1, detailSensorTotal);
  check('感知器モード: total=6のみの部屋はsa/teiを推測せず「―」(未確認)のまま', detailSensorTotal.indexOf('―') !== -1, detailSensorTotal);
})();

var allOk = results.every(function (r) { return r.ok; });
console.log('\n==== index_html_phase1_fix_test 総合結果: ' + (allOk ? 'PASS' : 'FAIL') + ' (' + results.filter(function (r) { return r.ok; }).length + '/' + results.length + ') ====');
if (!allOk) process.exitCode = 1;
