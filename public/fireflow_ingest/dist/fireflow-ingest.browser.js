// ==== fireflow-ingest.browser.js ====
// 自動生成ファイル。手編集しないこと。
// 生成元: fireflow_ingest/scripts/buildBrowserBundle.js (node scripts/buildBrowserBundle.js で再生成)
// lib/配下の元ファイルの中身は一切書き換えていない(Node向けテストで検証済みのソースそのまま)。
(function (global) {
  'use strict';
  var __ffModules = {};
  function __ffRequire(fromFile, spec) {
    var fromDir = spec.split("/").length && fromFile.split("/").slice(0, -1).join("/");
    var parts = (fromDir ? fromDir + "/" : "") + spec;
    var segs = parts.split("/");
    var out = [];
    for (var i = 0; i < segs.length; i++) {
      if (segs[i] === "." || segs[i] === "") continue;
      if (segs[i] === "..") { out.pop(); continue; }
      out.push(segs[i]);
    }
    var resolved = out.join("/");
    if (!__ffModules[resolved]) {
      throw new Error("fireflow-ingest bundle: module not found: " + resolved + " (required from " + fromFile + ", spec=" + spec + ")");
    }
    return __ffModules[resolved].exports;
  }

  __ffModules["formatParsers/registry.js"] = (function () {
    var module = { exports: {} };
    var exports = module.exports;
    var require = function (spec) { return __ffRequire("formatParsers/registry.js", spec); };
    (function (module, exports, require) {
// lib/formatParsers/registry.js
//
// [2026-08-02新設] 「同じ種類の帳票(documentKind)でも、管理会社・物件ごとにフォーマット
// (表形式・図面形式など)が異なりうる」という前提に対応するための、汎用フォーマット別
// Parserレジストリ。
//
// 【きっかけ】感知器数(sensorCount)について、既存のLB実装(buildSensorMasterFromSensorSheet、
// lb_tool/index.html)は「1行1部屋、B列=部屋番号、F列=差動式スポット型個数、G列=定温式
// スポット型個数」という表形式のみを前提にしていた。ところが「アービング千林大宮」物件の
// 実データは、フロアごとのブロックに部屋番号と丸数字(⑤⑥等)が並ぶ図面(グリッド)形式で、
// 実際の個数は末尾の凡例("感知器：サーミスタ（定温：キッチン×1）")を読んで初めて分かる、
// 全く異なるレイアウトだった。これは一物件だけの特殊事情ではなく、「管理会社・物件ごとに
// 帳票フォーマットが異なりうる」という一般的な問題の一例と判断し、フォーマットの違いを
// 局所化する仕組みとして本レジストリを新設した。
//
// 【設計方針(ご指示①〜④に対応)】
// ① 既存LBのロジック(buildSensorMasterFromSensorSheet等)は変更しない。このレジストリは
//    LB本体(lb_tool/index.html)の外、fireflow_ingest/(取込専用モジュール)に置く。
//    既存の表形式ロジックは「フォーマットの1つ」としてそのまま移植し(sensorCount/
//    tableFormatParser.js参照)、LB側の元関数はコピー元として残るだけで無変更のままにする。
// ② 「1フォーマット = 1Parserモジュール」とし、各Parserの出力(canonical)は最終的に
//    FSDFへ変換する(sensorCount/toFsdf.js参照)という構成にした。
// ③ Parserは`detect(input) -> {matches, confidence, reason}`を実装し、レジストリの
//    autoParse()が登録済み全Parserのdetect()を実行して自動判定する。
// ④ 新しいフォーマットに対応する場合、新しいParserファイルを1つ追加して
//    registry.register(newParser)を1行呼ぶだけでよい。このファイル(registry.js)・
//    既存の登録済みParser・呼び出し側のコードは一切変更不要。
//
// 【documentKindという単位について】
// このレジストリはdocumentKind(帳票の種類。例: 'sensorCount')ごとに1つ作る想定。
// 将来、点検結果報告書・捺印表・物件概要・経過記録表についても管理会社ごとのフォーマット
// 差異が実際に見つかった時点で、同じ仕組み(createFormatParserRegistry('inspectionReport')等)
// を使って追加できる。ただし「対象となる実データが無いうちから複数フォーマットのParserを
// 先回りして作る」ことはしない(このプロジェクトの既存方針。
// claude/FireFlow_OCR共通基盤化_アーキテクチャ設計レビュー_2026-07-27.md
// 「対象が無い状態で先行実装すると絵に描いた餅になりやすい」を踏襲)。
'use strict';

const REQUIRED_PARSER_KEYS = ['id', 'label', 'detect', 'parse'];

function createFormatParserRegistry(documentKind) {
  if (!documentKind) throw new Error('documentKindを指定してください。');
  const parsers = [];

  function register(parser) {
    REQUIRED_PARSER_KEYS.forEach((key) => {
      if (!parser || typeof parser[key] === 'undefined') {
        throw new Error(`Parserには${key}が必要です(documentKind=${documentKind})。`);
      }
    });
    if (typeof parser.detect !== 'function' || typeof parser.parse !== 'function') {
      throw new Error(`Parser.detect/parseは関数である必要があります(id=${parser.id})。`);
    }
    if (parsers.some((p) => p.id === parser.id)) {
      throw new Error(`Parser IDが重複しています: ${parser.id}`);
    }
    parsers.push(parser);
    return registryApi;
  }

  // 登録済み全Parserに対してdetect()を実行し、matches===trueのものだけを返す
  // (自動判定の途中経過を可視化したい場合に使う)。
  function detectAll(input) {
    return parsers.map((parser) => ({ parser, result: parser.detect(input) || { matches: false, confidence: 0 } }));
  }

  // 自動判定してparse()まで実行する。どのParserにも一致しなかった場合は、
  // 「たまたま近そうなParserへ誤って割り当てる」事故を避けるため、はっきり
  // 失敗を返す(黙って空データを返したり、最初のParserにフォールバックしたりしない)。
  function autoParse(input, options) {
    options = options || {};
    const candidates = detectAll(input).filter((c) => c.result.matches);

    if (candidates.length === 0) {
      return {
        ok: false,
        documentKind,
        reason: 'UNRECOGNIZED_FORMAT',
        detail: `登録済みの${parsers.length}件のフォーマットParser(${parsers.map((p) => p.id).join('、')})のいずれにも一致しませんでした。新しいフォーマットの可能性があります。`,
        triedParsers: parsers.map((p) => ({ id: p.id, label: p.label })),
      };
    }

    candidates.sort((a, b) => (b.result.confidence || 0) - (a.result.confidence || 0));
    const chosen = candidates[0];
    const isAmbiguous = candidates.length > 1 && candidates[1].result.confidence === chosen.result.confidence;

    let canonical;
    try {
      canonical = chosen.parser.parse(input, options);
    } catch (err) {
      return {
        ok: false,
        documentKind,
        reason: 'PARSE_ERROR',
        detail: `${chosen.parser.id}のparse()で例外が発生しました: ${err.message}`,
        matchedParserId: chosen.parser.id,
      };
    }

    return {
      ok: true,
      documentKind,
      matchedParserId: chosen.parser.id,
      matchedParserLabel: chosen.parser.label,
      confidence: chosen.result.confidence,
      reason: chosen.result.reason || null,
      // ambiguous=true: 上位2件が同じconfidenceだった(自動判定に自信が持てない状態)。
      // 呼び出し側は、この場合に警告表示や人間確認を挟むことを検討すべき。
      ambiguous: isAmbiguous,
      candidates: candidates.map((c) => ({ id: c.parser.id, confidence: c.result.confidence })),
      data: canonical,
    };
  }

  function listParsers() {
    return parsers.map((p) => ({ id: p.id, label: p.label }));
  }

  const registryApi = { documentKind, register, detectAll, autoParse, listParsers };
  return registryApi;
}

module.exports = { createFormatParserRegistry };

    })(module, exports, require);
    return module;
  })();

  __ffModules["formatParsers/roomRoster/gridFormatParser.js"] = (function () {
    var module = { exports: {} };
    var exports = module.exports;
    var require = function (spec) { return __ffRequire("formatParsers/roomRoster/gridFormatParser.js", spec); };
    (function (module, exports, require) {
// lib/formatParsers/roomRoster/gridFormatParser.js
//
// [2026-08-03新設、2026-08-03改訂] 新しいドキュメント種別(documentKind)「roomRoster」(捺印表からの
// 部屋番号一覧・階構成・住戸配置の抽出)の最初のParser。
//
// 【背景】これまで11物件分、捺印表(空データ、住人のサイン欄が未記入の状態で配布前に
// 送付いただくもの)から部屋番号一覧を抽出する作業を、都度その場限りのPythonスクリプトで
// 行っていた。これはfireflow_ingestのコードとして保存・再利用可能な形になっておらず、
// 実際に「コスモフォレスタ箕面」で浮動小数点誤差付きの部屋番号(912.000000000003)を
// 見落とし、部屋数を176→204へ訂正する事故が起きている。ユーザーからのご指示
// (2026-08-03)を受け、捺印表を正式な入力データとして扱うため、sensorCountと同じ
// フォーマット別Parserレジストリ方式でParser化した。
//
// 【2026-08-03改訂】ユーザーからの追加ご指示を受け、以下を強化した。
//   1. 部屋番号候補の誤検出防止: 単純な2〜4桁の数値一致だけでなく、電話番号・郵便番号・
//      日付等である可能性が高い候補を除外する(周辺の文脈語・行内パターン・候補の
//      密集度(配置の規則性)を組み合わせて判定する)。除外した候補はwarningsとして
//      明示し、黙って捨てない。
//   2. 階推定にfloorInferenceConfidenceを追加し、確信が持てない推定(0階・50階超等、
//      非現実的な値になるケース)は推定自体を行わずnull+警告とする。
//   3. 将来、管理人室・店舗・共用部等の住戸以外の区画を区別できるよう、各部屋に
//      spaceType('unit'|'non_unit')・spaceTypeLabel(検出した根拠ラベル)を持たせる
//      構造にした(現時点ではベストエフォートの近傍ラベル検出のみで、区画自体を
//      捨てることはしない。捏造・黙殺をしないという既存方針を踏襲し、
//      「非住戸の可能性がある」ことを明示するに留める)。
//
// 【sensorCountとの関係】捺印表は「部屋番号だけが書かれたグリッド」であり、実際に
// 調査した3物件の実データでは、次のいずれかの構造だった。
//   - グランプレイズ宝塚南口: 部屋番号グリッド + 階ラベルが部屋番号行の3行下(フッター位置)。
//     これはsensorCount.totalOnlyGridFormat.v1が対応している感知器数ファイルと、
//     階ラベルの位置もグリッド構造も全く同じだった(値セルの中身が丸数字か、捺印欄の
//     カタカナ「ハ」プレースホルダーかの違いだけ)。
//   - コスモフォレスタ箕面/コスモザ・パークイースト1: 階ラベルが一切無い。
//   - グランディア緑地公園: 階ラベルが無く、1行に複数部屋が並ぶ。
// このParserは、sensorCount側で確立済みの「階ラベル位置バリエーション(同じ行/
// フッター位置/無し)」「浮動小数点部屋番号」「全角数字」への対応方針をそのまま踏襲する。
// ただし捺印表には「値セル」という概念が無い(部屋番号そのものが読み取り対象)ため、
// sensorCountのParser群とはコードを共有せず(本プロジェクトの「各Parserは自己完結」
// 方針を踏襲)、部屋番号セルを起点にした独自のロジックとして実装している。
'use strict';

function zenkakuDigitsToHankaku(str) {
  return String(str).replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
}

const ROOM_NUMBER_PATTERN = /^\d{2,4}$/;
const FLOOR_LABEL_PATTERN = /^\d+\s*[FＦ階]$/;
// 「D棟」「A棟」等の棟ラベル(1〜3文字+棟)。部屋との対応付けまでは行わず、
// シート内に存在するかどうかのベストエフォート検出のみ(既存方針: 曖昧な対応付けを捏造しない)。
const BUILDING_LABEL_PATTERN = /^[A-Za-zＡ-Ｚ一二三四五六七八九十]{1,3}棟$/;

// [2026-08-03追加] 電話番号・FAX・郵便番号・日付等、部屋番号ではない数値が混入する
// 典型的な文脈を示す語。これらが近傍にあり、かつ候補が孤立している(周囲に他の
// 部屋番号候補が無い)場合にのみ除外の判断材料として使う(密集したグリッド内の
// 正規の部屋番号を誤って除外しないよう、文脈語の存在だけでは除外しない)。
const EXCLUSION_CONTEXT_PATTERN = /電話|ＴＥＬ|TEL|FAX|ＦＡＸ|郵便番号|〒|口座|振込先|生年月日|作成日|点検日|有効期限|期限/;
// 行全体を「-」で連結した際に電話番号・郵便番号のパターンに一致するかどうかの判定
// (市外局番・市内局番・番号が別々のセルに分割記入されている帳票が実在するため)。
const PHONE_LIKE_JOINED_PATTERN = /^0\d{1,4}-\d{1,4}-\d{3,4}$/;
const POSTAL_LIKE_JOINED_PATTERN = /^〒?\d{3}-\d{4}$/;

// [2026-08-03追加] 管理人室・店舗・共用部等、住戸(専有部)ではない区画を示す典型的な
// ラベル語。将来的にspaceTypeで住戸と区別できるようにするための、近傍セルからの
// ベストエフォート検出用(検出しても部屋番号自体は捨てず、spaceType/警告で明示するのみ)。
const NON_UNIT_LABEL_PATTERN = /管理人室|管理室|店舗|共用部|共用|駐車場|駐輪場|自転車置場|ゴミ置場|ごみ置場|集会室|機械室|受水槽|ポンプ室|メーターボックス|エレベーター|エントランス|電気室|倉庫|物置/;

function cellToRoomNumberString(v) {
  if (v == null) return null;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return null;
    const rounded = Math.round(v);
    if (Math.abs(v - rounded) > 0.01) return null;
    const str = String(rounded);
    return ROOM_NUMBER_PATTERN.test(str) ? str : null;
  }
  const str = zenkakuDigitsToHankaku(String(v).trim());
  return ROOM_NUMBER_PATTERN.test(str) ? str : null;
}

function isFloorLabelCell(v) {
  if (v == null || typeof v === 'number') return false;
  return FLOOR_LABEL_PATTERN.test(zenkakuDigitsToHankaku(String(v).trim()));
}

function findLoneFloorLabel(row) {
  if (!row) return null;
  for (const v of row) {
    if (isFloorLabelCell(v)) return String(v).trim();
  }
  return null;
}

function rowHasRoomNumber(row) {
  if (!row) return false;
  for (const v of row) {
    if (cellToRoomNumberString(v) != null) return true;
  }
  return false;
}

// sensorCount.totalOnlyGridFormat.v1のfindFooterFloorLabel()と同じ考え方(部屋番号行の
// 数行下に単独で書かれた階ラベルを探す。次の部屋番号行に到達したら打ち切る)。
function findFooterFloorLabel(grid, roomRowIndex) {
  const SEARCH_WINDOW = 5;
  for (let offset = 1; offset <= SEARCH_WINDOW; offset++) {
    const row = grid[roomRowIndex + offset];
    if (!row) break;
    if (rowHasRoomNumber(row)) break;
    const label = findLoneFloorLabel(row);
    if (label) return label;
  }
  return null;
}

// [2026-08-03改訂] 階ラベルが同じ行にもフッター位置にも見つからない場合、部屋番号の
// 先頭桁から階を推定する(3〜4桁の部屋番号のみ対応。2桁は「10号室」なのか
// 「1階0号室」なのか一意に決まらないため推定しない)。
// 推定結果には必ずfloorInferenceConfidenceを付与し、0階・50階超等、明らかに
// 非現実的な値になるケースは「確信が持てない」として推定自体を行わずnullを返す
// (呼び出し側はnullを「未解決」として扱い、ROOM_FLOOR_LABEL_UNRESOLVED警告を出す)。
function inferFloorFromRoomNumber(roomStr) {
  if (roomStr.length === 3) {
    const floorDigit = roomStr[0];
    if (floorDigit === '0') return null; // 「0階」は通常存在しないため推定しない
    return { floorLabel: floorDigit + 'F', floorInferenceConfidence: 0.6 };
  }
  if (roomStr.length === 4) {
    const floorDigits = roomStr.slice(0, 2);
    const floorNum = Number(floorDigits);
    if (floorNum === 0 || floorNum > 50) return null; // 「00階」・50階超は非現実的なため推定しない
    return { floorLabel: floorDigits + 'F', floorInferenceConfidence: 0.55 };
  }
  return null; // 2桁は元々推定不可
}

function findBuildingLabels(grid) {
  const labels = [];
  for (const row of grid || []) {
    if (!row) continue;
    for (const v of row) {
      if (v == null) continue;
      const str = String(v).trim();
      if (BUILDING_LABEL_PATTERN.test(str) && labels.indexOf(str) === -1) labels.push(str);
    }
  }
  return labels;
}

// [2026-08-03追加] 候補セルの近傍(同じ行、および直前直後の行)に、電話番号・郵便番号・
// 日付等の文脈語が含まれていないかを確認する。
function hasExclusionContextNearby(grid, row) {
  for (let rr = row - 1; rr <= row + 1; rr++) {
    const r = grid[rr];
    if (!r) continue;
    for (const v of r) {
      if (v != null && EXCLUSION_CONTEXT_PATTERN.test(String(v))) return true;
    }
  }
  return false;
}

// [2026-08-03追加] 行内の非空セルを「-」で連結した文字列が、電話番号・郵便番号の
// パターンに一致するかどうかを判定する(市外局番等が別々のセルに分割記入されている
// 帳票が実在するため。該当する行は、行内の数値セル全てを部屋番号候補から除外する)。
function rowLooksLikePhoneOrPostal(row) {
  if (!row) return false;
  const parts = row.filter((v) => v != null && String(v).trim() !== '').map((v) => String(v).trim());
  if (parts.length < 2 || parts.length > 4) return false;
  const joined = parts.join('-');
  return PHONE_LIKE_JOINED_PATTERN.test(joined) || POSTAL_LIKE_JOINED_PATTERN.test(joined);
}

// [2026-08-03追加] 部屋番号候補の「配置の規則性」を測る簡易指標。同じ候補セル周辺
// (前後2行以内)に他の部屋番号候補が何件あるかを数える。捺印表の部屋番号は通常、
// 密集したグリッド状に並ぶため、周囲に他の候補が全く無い(密度0)候補は、電話番号や
// 日付の断片等、部屋番号ではない数値である可能性が相対的に高いと判断する材料にする。
function localCandidateDensity(candidates, row, col) {
  let count = 0;
  for (const cand of candidates) {
    if (cand.row === row && cand.col === col) continue;
    if (Math.abs(cand.row - row) <= 2) count++;
  }
  return count;
}

// グリッド全体から、部屋番号らしきセルを収集し、電話番号・郵便番号・日付等の
// 可能性が高い候補を除外する。戻り値は { accepted: [...], excluded: [...] }
// (除外分もexcludedとして返し、呼び出し側でwarningsとして明示できるようにする)。
function scanAllRoomCells(grid) {
  const rawCandidates = [];
  for (let r = 0; r < (grid || []).length; r++) {
    const row = grid[r];
    if (!row) continue;
    for (let c = 0; c < row.length; c++) {
      const roomStr = cellToRoomNumberString(row[c]);
      if (roomStr != null) rawCandidates.push({ row: r, col: c, roomStr });
    }
  }

  const phoneOrPostalRows = new Set();
  for (let r = 0; r < (grid || []).length; r++) {
    if (rowLooksLikePhoneOrPostal(grid[r])) phoneOrPostalRows.add(r);
  }

  const accepted = [];
  const excluded = [];
  for (const cand of rawCandidates) {
    if (phoneOrPostalRows.has(cand.row)) {
      excluded.push(Object.assign({}, cand, { reason: 'PHONE_OR_POSTAL_ROW' }));
      continue;
    }
    const density = localCandidateDensity(rawCandidates, cand.row, cand.col);
    if (density === 0 && hasExclusionContextNearby(grid, cand.row)) {
      excluded.push(Object.assign({}, cand, { reason: 'ISOLATED_WITH_EXCLUSION_CONTEXT' }));
      continue;
    }
    accepted.push(cand);
  }

  return { accepted, excluded };
}

function resolveFloorLabelForRoomCell(grid, roomRow) {
  const sameRowLabel = findLoneFloorLabel(grid[roomRow]);
  if (sameRowLabel) return { floorLabel: sameRowLabel, floorLabelSource: 'same_row' };
  const footerLabel = findFooterFloorLabel(grid, roomRow);
  if (footerLabel) return { floorLabel: footerLabel, floorLabelSource: 'footer' };
  return null;
}

// [2026-08-03追加、2026-08-03修正(実データ対応: アービング宝塚)] 候補セルの近傍(上下左右
// 1マス以内、対角含む8近傍)に、管理人室・店舗等の住戸以外の区画を示すラベルが無いかを
// 確認する(ベストエフォート。見つかった場合も部屋番号自体は捨てず、spaceTypeとwarningで
// 明示するのみ)。
//
// 【修正理由】当初は「同じ行(前後1行含む)のどこかに非住戸ラベルがあれば、その行の
// 全部屋番号candidateを対象とする」という、行全体を近傍とみなす実装だった。しかし
// 「アービング宝塚」の実データ(捺印表アービング宝塚.xlsx)の1F行で、部屋番号103〜110の
// 8部屋と「エントランス」「管理事務室」ラベルが同じ行の別々の列に離れて並んでいたため、
// 実際には住戸である可能性が高い103〜110の全室が誤ってnon_unit判定されてしまう問題が
// 見つかった(他の階(2F〜7F)は同様の行に8〜10戸の住戸番号のみが並ぶ構成であり、1Fだけ
// 突然全室が非住戸というのは考えにくいというのがご判断の根拠)。スプレッドシート上の
//「同じ行」は必ずしも建物内の物理的な近さを意味しないため、判定基準を「列方向も含めた
// 直近傍(上下左右1マス以内)」に狭めた。これにより、実際にラベルへ隣接するセルのみが
// non_unit候補として扱われる。
function classifyNonUnitLabel(grid, row, col) {
  for (let rr = row - 1; rr <= row + 1; rr++) {
    const r = grid[rr];
    if (!r) continue;
    for (let cc = col - 1; cc <= col + 1; cc++) {
      if (rr === row && cc === col) continue; // 自分自身(部屋番号のセル)は対象外
      const v = r[cc];
      if (v != null && NON_UNIT_LABEL_PATTERN.test(String(v))) return String(v).trim();
    }
  }
  return null;
}

function detect(grid) {
  if (!Array.isArray(grid)) return { matches: false, confidence: 0 };
  const { accepted, excluded } = scanAllRoomCells(grid);
  if (accepted.length < 4) {
    return {
      matches: false,
      confidence: 0,
      reason: `部屋番号らしきセルが${accepted.length}件しか見つからない(4件未満。電話番号・日付等として除外した候補: ${excluded.length}件)`,
    };
  }
  // 捺印表には「ご捺印」「サイン」等の依頼文言が含まれることが多く、これがあれば強い手がかりになる。
  // 無くても部屋番号セルが十分あれば捺印表の可能性は十分あるため、無い場合は確信度をやや下げるのみとする。
  const hasStampRequestPhrase = (grid || []).some(
    (row) => row && row.some((v) => v != null && /捺印|サイン|署名/.test(String(v)))
  );
  let confidence = 0.55 + Math.min(0.3, accepted.length * 0.002);
  if (hasStampRequestPhrase) confidence += 0.1;
  confidence = Math.min(0.95, confidence);
  return {
    matches: true,
    confidence,
    reason: `部屋番号らしきセル${accepted.length}件を検出(捺印・サイン等の依頼文言: ${hasStampRequestPhrase ? 'あり' : 'なし'}、電話番号・日付等として除外した候補: ${excluded.length}件)`,
  };
}

function parse(grid) {
  const warnings = [];
  const rooms = {};
  const { accepted, excluded } = scanAllRoomCells(grid);

  for (const ex of excluded) {
    warnings.push({
      code: 'ROOM_NUMBER_CANDIDATE_EXCLUDED',
      detail: `セル(行${ex.row}列${ex.col}、値「${ex.roomStr}」)は電話番号・郵便番号・日付等の可能性が高いため、部屋番号として扱いませんでした(判定理由: ${ex.reason})。誤って除外している場合はご確認ください。`,
      row: ex.row,
      col: ex.col,
      candidateValue: ex.roomStr,
    });
  }

  for (const cell of accepted) {
    if (Object.prototype.hasOwnProperty.call(rooms, cell.roomStr)) {
      warnings.push({
        code: 'ROOM_NUMBER_DUPLICATE',
        detail: `部屋番号「${cell.roomStr}」が複数のセルに出現しました(行${cell.row}列${cell.col}含む)。後勝ちで上書きしています。`,
        room: cell.roomStr,
        row: cell.row,
        col: cell.col,
      });
    }
    const resolved = resolveFloorLabelForRoomCell(grid, cell.row);
    let floorLabel = null;
    let floorLabelSource = null;
    let floorInferenceConfidence = null;
    if (resolved) {
      floorLabel = resolved.floorLabel;
      floorLabelSource = resolved.floorLabelSource;
      // 同じ行/フッター位置から実際に読み取った値であり「推定」ではないため、
      // floorInferenceConfidenceは適用外(null)のままとする。
    } else {
      const inferred = inferFloorFromRoomNumber(cell.roomStr);
      if (inferred) {
        floorLabel = inferred.floorLabel;
        floorLabelSource = 'inferred';
        floorInferenceConfidence = inferred.floorInferenceConfidence;
      } else {
        warnings.push({
          code: 'ROOM_FLOOR_LABEL_UNRESOLVED',
          detail: `部屋番号「${cell.roomStr}」の階が、同じ行・フッター位置のいずれからも読み取れず、部屋番号からの推定も確信を持てませんでした(2桁部屋番号、または推定結果が非現実的な階になるケース)。`,
          room: cell.roomStr,
          row: cell.row,
          col: cell.col,
        });
      }
    }

    const nonUnitLabel = classifyNonUnitLabel(grid, cell.row, cell.col);
    const spaceType = nonUnitLabel ? 'non_unit' : 'unit';
    if (spaceType === 'non_unit') {
      warnings.push({
        code: 'ROOM_SPACE_TYPE_NON_UNIT',
        detail: `部屋番号「${cell.roomStr}」の近傍に住戸以外を示すラベル「${nonUnitLabel}」が見つかったため、spaceTypeを"non_unit"としました。住戸として扱ってよいかご確認ください(部屋番号自体は削除していません)。`,
        room: cell.roomStr,
        row: cell.row,
        col: cell.col,
      });
    }

    rooms[cell.roomStr] = {
      floorLabel,
      floorLabelSource,
      floorInferenceConfidence,
      spaceType,
      spaceTypeLabel: nonUnitLabel || null,
      row: cell.row,
      col: cell.col,
    };
  }

  const floors = {};
  for (const roomStr of Object.keys(rooms)) {
    const fl = rooms[roomStr].floorLabel;
    if (fl == null) continue;
    if (!floors[fl]) floors[fl] = { roomNumbers: [], roomCount: 0 };
    floors[fl].roomNumbers.push(roomStr);
    floors[fl].roomCount++;
  }
  for (const fl of Object.keys(floors)) {
    floors[fl].roomNumbers.sort((a, b) => Number(a) - Number(b));
  }

  const buildings = findBuildingLabels(grid);

  const inferredCount = Object.values(rooms).filter((r) => r.floorLabelSource === 'inferred').length;
  if (inferredCount > 0) {
    warnings.push({
      code: 'ROOM_FLOOR_LABEL_INFERRED',
      detail: `${inferredCount}部屋について、階ラベルが原本に無かったため部屋番号の先頭桁から推定しました(各部屋のfloorInferenceConfidenceをご確認ください。捏造ではなく推定である旨、ご留意ください)。`,
    });
  }

  return { rooms, floors, buildings, warnings };
}

module.exports = {
  id: 'roomRoster.gridFormat.v1',
  label: '部屋番号グリッド形式(捺印表。階ラベルは同じ行/フッター位置/無しのいずれにも対応)',
  detect,
  parse,
};

    })(module, exports, require);
    return module;
  })();

  __ffModules["formatParsers/roomRoster/index.js"] = (function () {
    var module = { exports: {} };
    var exports = module.exports;
    var require = function (spec) { return __ffRequire("formatParsers/roomRoster/index.js", spec); };
    (function (module, exports, require) {
// lib/formatParsers/roomRoster/index.js
//
// [2026-08-03新設] 「捺印表からの部屋番号一覧・階構成」(roomRoster)ドキュメント種別の
// フォーマット別Parserを登録したレジストリ。sensorCount/index.jsと同じ構成。
'use strict';

const { createFormatParserRegistry } = require('../registry.js');
const gridFormatParser = require('./gridFormatParser.js');

const roomRosterRegistry = createFormatParserRegistry('roomRoster');
roomRosterRegistry.register(gridFormatParser);

function parseRoomRosterSheet(grid) {
  return roomRosterRegistry.autoParse(grid);
}

module.exports = { roomRosterRegistry, parseRoomRosterSheet };

    })(module, exports, require);
    return module;
  })();

  __ffModules["formatParsers/sensorCount/tableFormatParser.js"] = (function () {
    var module = { exports: {} };
    var exports = module.exports;
    var require = function (spec) { return __ffRequire("formatParsers/sensorCount/tableFormatParser.js", spec); };
    (function (module, exports, require) {
// lib/formatParsers/sensorCount/tableFormatParser.js
//
// [2026-08-02新設] 感知器数(sensorCount)フォーマット「表形式」用Parser。
//
// 【重要】parse()のロジックは、lb_tool/index.htmlのbuildSensorMasterFromSensorSheet()
// (2026-07-27追加、B列=部屋番号/F列=差動式スポット型個数/G列=定温式スポット型個数という
// 表形式を前提とする既存ロジック)を、一切変更せずそのまま移植したものである。
// LB側の元関数はこのファイルを参照しないし、このファイルもLB側を参照しない
// (「既存LBのロジックは変更しない」というご指示に対し、コピーであり続けることで
// 依存を作らず、かつ既存の挙動を保証する)。移植元と完全に同じ出力になることは
// test/formatParsers/sensorCount_tableFormat_test.jsで検証している。
//
// grid: 2次元配列(sheets[sheetName].gridと同じ形。1オリジンではなく0オリジンの配列)。
'use strict';

const ROOM_NUMBER_PATTERN = /^\d{2,4}$/;

function detect(grid) {
  if (!Array.isArray(grid)) return { matches: false, confidence: 0 };
  let roomLikeCount = 0;
  let numericFgCount = 0;
  let siblingRoomConflicts = 0;
  for (const row of grid) {
    if (!row) continue;
    const roomVal = row[1]; // B列
    if (roomVal == null) continue;
    const roomStr = String(roomVal).trim();
    if (!ROOM_NUMBER_PATTERN.test(roomStr)) continue;
    roomLikeCount++;
    const saVal = row[5]; // F列
    const teiVal = row[6]; // G列
    if (typeof saVal === 'number' || typeof teiVal === 'number') numericFgCount++;
    // [2026-08-02追加] 「グランディア緑地公園」の実データで、部屋番号が並ぶ行(1行に
    // 複数部屋、B列以外にも部屋番号らしき値が並ぶ)を、たまたまB列に部屋番号があった
    // というだけでtableFormatと誤判定してしまう事故が見つかった(F/G列の位置に別の
    // 部屋番号がたまたま来て、あたかも数値の差動/定温個数であるかのように誤読された)。
    // tableFormatは「1行=1部屋」が前提のため、B列以外にも部屋番号らしき値が並ぶ行が
    // 一定割合を超える場合は、別フォーマット(1行に複数部屋が並ぶroomOnlyPairRowsFormat等)
    // の可能性が高いと判断し、確信度を0にする。
    for (let c = 0; c < row.length; c++) {
      if (c === 1) continue;
      const v = row[c];
      if (v == null) continue;
      if (ROOM_NUMBER_PATTERN.test(String(v).trim())) { siblingRoomConflicts++; break; }
    }
  }
  if (roomLikeCount === 0) return { matches: false, confidence: 0, reason: 'B列に部屋番号らしき値が見つからない' };
  if (siblingRoomConflicts / roomLikeCount > 0.3) {
    return {
      matches: false,
      confidence: 0,
      reason: `B列に部屋番号らしき値のある行${roomLikeCount}件中${siblingRoomConflicts}件で、同じ行の他列にも部屋番号らしき値が並んでいる(1行1部屋のtableFormatではなく、1行に複数部屋が並ぶ別フォーマットの可能性が高い)`,
    };
  }
  // F/G列が実際に数値になっている行の割合を確信度とする(表形式ならほぼ100%になるはず)。
  const confidence = numericFgCount / roomLikeCount;
  return {
    matches: confidence > 0.5,
    confidence,
    reason: `部屋番号らしき行${roomLikeCount}件中${numericFgCount}件でF/G列が数値`,
  };
}

// [2026-08-03修正] 移植元(buildSensorMasterFromSensorSheet、経路A/legacy Excel経路)は、
// F/G列が数値以外(空欄・非数値・自由記述等)の場合に0を返す仕様だが、これは「確認済みの
// 0件」と「未確認(読み取れなかった)」を区別できず、商用運用上の誤認リスクがあるとして
// Phase2①.5で修正対象と判断された(ユーザー指示、2026-08-03)。経路A(buildSensorMasterFrom
// SensorSheet)自体は今回も変更しない(既存点検報告書Excel経路は非対象、別途方針決定済み)が、
// このfireflow_ingest側の移植Parserは、以下のルールで意図的に経路Aと異なる、より正確な
// 挙動へ変更する。
//   1. セルが明示的な数値(0を含む)→ その数値をそのまま返す(確認済みの値として扱う)
//   2. セルが空欄・非数値・自由記述等で読み取れない → 0で補完せずnullを返し、warningを積む
//   3. sa/teiは独立に判定する(片方だけ読み取れる場合は、読み取れた方は数値、読み取れない
//      方だけnullにする=部分未確認として保持する)
// この結果、test/formatParsers/sensorCount_tableFormat_test.jsは「移植元と完全一致する」
// ことを検証する内容から、「移植元とは意図的にnull/0の扱いが異なる」ことを検証する内容へ
// 2026-08-03に更新している(経緯はテストファイル内コメント参照)。
function numericOrNull(val) {
  return typeof val === 'number' ? val : null;
}

// 移植元(buildSensorMasterFromSensorSheet)と同じ戻り値の形: { [部屋番号]: { sa, tei } }
// (ただし2026-08-03以降、sa/teiが読み取れない場合は移植元と異なりnullを返す。上記コメント参照)
function parse(grid) {
  const warnings = [];
  const sensorMaster = {};
  for (const row of grid || []) {
    if (!row) continue;
    const roomVal = row[1];
    if (roomVal == null) continue;
    const roomStr = String(roomVal).trim();
    if (!ROOM_NUMBER_PATTERN.test(roomStr)) continue;
    const saRaw = row[5];
    const teiRaw = row[6];
    const sa = numericOrNull(saRaw);
    const tei = numericOrNull(teiRaw);
    sensorMaster[roomStr] = { sa, tei };
    if (sa === null) {
      warnings.push({
        code: 'SENSOR_VALUE_MISSING',
        detail: `部屋${roomStr}: 「差動式スポット型」の値セル(F列)が${saRaw == null ? '空欄' : '数値以外(' + JSON.stringify(saRaw) + ')'}のため、件数を確定できません。0件と決め付けず未確認のまま保持しています。原本を確認してください。`,
        room: roomStr,
        type: 'sa',
      });
    }
    if (tei === null) {
      warnings.push({
        code: 'SENSOR_VALUE_MISSING',
        detail: `部屋${roomStr}: 「定温式スポット型」の値セル(G列)が${teiRaw == null ? '空欄' : '数値以外(' + JSON.stringify(teiRaw) + ')'}のため、件数を確定できません。0件と決め付けず未確認のまま保持しています。原本を確認してください。`,
        room: roomStr,
        type: 'tei',
      });
    }
  }
  return { sensorMaster, warnings };
}

module.exports = {
  id: 'sensorCount.tableFormat.v1',
  label: '表形式(1行1部屋、B列=部屋番号／F列=差動式スポット型／G列=定温式スポット型)',
  detect,
  parse,
};

    })(module, exports, require);
    return module;
  })();

  __ffModules["formatParsers/sensorCount/floorGridFormatParser.js"] = (function () {
    var module = { exports: {} };
    var exports = module.exports;
    var require = function (spec) { return __ffRequire("formatParsers/sensorCount/floorGridFormatParser.js", spec); };
    (function (module, exports, require) {
// lib/formatParsers/sensorCount/floorGridFormatParser.js
//
// [2026-08-02新設] 感知器数(sensorCount)フォーマット「図面(フロアグリッド)形式」用Parser。
//
// 2026-08-02、「アービング千林大宮」物件の実データ(感知器数（アービング千林大宮）.xls)で
// 初めて確認したフォーマット。捺印表と同じ「フロアごとのブロックに部屋番号が並ぶ」
// レイアウトを流用しつつ、各部屋番号のセルの下に丸数字(①②③...)が置かれ、シート末尾の
// 凡例行(例:「感知器：サーミスタ（定温：キッチン×1）」)で、その丸数字が指す感知器の
// 種別(差動式/定温式)と個数が説明される、という構造になっている。
//
// 【重要: この解釈には未確認の前提が含まれる】
// 丸数字は点検結果報告書側で個々の感知器実機に振られた管理番号(例:「⑤番の感知器」)である
// 可能性が高いと考えられるが、これは今回のサンプル(丸数字2種・凡例1行)から読み取れる
// 範囲での最も自然な解釈であり、管理会社に直接確認したものではない。凡例が「丸数字ごとに
// 個別の行」を持たない(今回のように1行だけで複数の丸数字をまとめて説明する)場合、
// このParserは「凡例が1行しか無ければ、見つかった全ての丸数字にその1行の内容を適用する」
// という前提で動作する。凡例が複数行ある場合は、各行の中に丸数字そのものが含まれていれば
// その丸数字専用の凡例として個別に対応付ける。この前提が外れるケース(凡例が2行以上あり、
// かつどの行にも丸数字の記載が無い場合等)は解析できず、warningsに詳細を積んで返す
// (黙って誤った個数を返すより、判定不能を明示する方を優先する設計)。
'use strict';

const ROOM_NUMBER_PATTERN = /^[0-9０-９]{2,4}$/;
// 丸数字①〜⑳(U+2460〜U+2473)。感知器の個体管理番号として使われる想定の範囲。
const CIRCLED_NUMBER_PATTERN = /^[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳]$/;
const LEGEND_LINE_PATTERN = /感知器[:：]\s*(.+)/;

function zenkakuDigitsToHankaku(str) {
  return String(str).replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
}

function findCells(grid, predicate) {
  const hits = [];
  for (let r = 0; r < (grid || []).length; r++) {
    const row = grid[r];
    if (!row) continue;
    for (let c = 0; c < row.length; c++) {
      const v = row[c];
      if (v == null) continue;
      const str = String(v).trim();
      if (str && predicate(str)) hits.push({ row: r, col: c, value: str });
    }
  }
  return hits;
}

// 丸数字1文字ぶんの凡例(種別+個数)を、凡例本文テキストから抽出する。
// 例: "サーミスタ（定温：キッチン×1）" -> { type: 'tei', typeLabel: '定温式', quantity: 1, raw }
function parseLegendEntryText(text) {
  const typeMatch = text.match(/(差動|定温)/);
  const qtyMatch = text.match(/×\s*(\d+)/);
  const type = typeMatch ? (typeMatch[1] === '差動' ? 'sa' : 'tei') : null;
  const quantity = qtyMatch ? Number(qtyMatch[1]) : 1; // 個数の明記が無ければ1個と解釈する(今回確認できたサンプルの表記に合わせる)
  return {
    type,
    typeLabel: type === 'sa' ? '差動式スポット型' : type === 'tei' ? '定温式スポット型' : null,
    quantity,
    raw: text,
  };
}

// シート全体から凡例行を収集する。丸数字を含む行があれば、その丸数字専用の凡例として
// 個別対応付けする(複数フォーマット対応の余地を残すため)。丸数字を含まない行は
// 「共通(デフォルト)凡例」として扱う。
function parseLegend(grid) {
  const perSymbol = {};
  let defaultEntry = null;
  const rawLines = [];
  for (const row of grid || []) {
    if (!row) continue;
    for (const cell of row) {
      if (cell == null) continue;
      const str = String(cell).trim();
      const m = str.match(LEGEND_LINE_PATTERN);
      if (!m) continue;
      rawLines.push(str);
      const body = m[1];
      const symbolInBody = body.match(CIRCLED_NUMBER_PATTERN) || str.match(CIRCLED_NUMBER_PATTERN);
      const entry = parseLegendEntryText(body);
      if (symbolInBody) {
        perSymbol[symbolInBody[0]] = entry;
      } else if (!defaultEntry) {
        defaultEntry = entry;
      }
    }
  }
  return { perSymbol, defaultEntry, rawLines };
}

function detect(grid) {
  if (!Array.isArray(grid)) return { matches: false, confidence: 0 };
  const roomCells = findCells(grid, (s) => ROOM_NUMBER_PATTERN.test(zenkakuDigitsToHankaku(s)));
  const symbolCells = findCells(grid, (s) => CIRCLED_NUMBER_PATTERN.test(s));
  const legend = parseLegend(grid);

  if (roomCells.length === 0) return { matches: false, confidence: 0, reason: '部屋番号らしきセルが見つからない' };
  if (symbolCells.length === 0) return { matches: false, confidence: 0, reason: '丸数字(①〜⑳)のセルが見つからない' };

  // [2026-08-02追加] 「グランディア香里園山の手」の実データで、部屋番号の直下に丸数字が
  // 1個だけ置かれているが、凡例行(「感知器：...」)が一切無いファイルが見つかった。
  // 中身を点検結果報告書と突き合わせたところ、この丸数字は「差動式/定温式の種別」ではなく
  // 「その部屋の感知器の合計数」を表しており、totalOnlyGridFormat(別Parser)が対象とする
  // 全く別のフォーマットだった。凡例が本当に1つも無い場合、このParserは種別を解決する
  // 手がかりが無く「本来のfloorGridFormatではない」可能性の方が高いため、確信度を大きく
  // 下げてtotalOnlyGridFormatParserに自動判定を譲る(parse()自体は凡例0件でも従来通り
  // 動作するので、万一detectの閾値だけ手動で越えて呼ばれても安全に警告付きで返す)。
  if (legend.rawLines.length === 0) {
    return {
      matches: false,
      confidence: 0,
      reason: `丸数字セル${symbolCells.length}件は見つかったが、凡例行(「感知器：...」)が1件も無いため、種別を解決する図面形式とは判定しない(totalOnlyGridFormat等、別フォーマットの可能性が高い)`,
    };
  }

  // tableFormatとの取り違えを避けるため、「F/G列に数値が並ぶ表形式」の特徴が強い場合は
  // 確信度を下げる(両方に部分的に一致することは起きにくいはずだが、念のための保険)。
  let confidence = 0.5 + Math.min(0.4, symbolCells.length * 0.05);
  if (legend.rawLines.length > 0) confidence = Math.min(0.98, confidence + 0.15);
  return {
    matches: true,
    confidence,
    reason: `部屋番号セル${roomCells.length}件・丸数字セル${symbolCells.length}件・凡例行${legend.rawLines.length}件を検出`,
  };
}

// 各丸数字セルを、「同じ列・直近上方にある部屋番号セル」に割り当てる。
function assignSymbolsToRooms(roomCells, symbolCells) {
  const assignments = []; // [{ roomCell, symbolCell }]
  const unassigned = [];
  for (const symbolCell of symbolCells) {
    // 同じ列(col)にある部屋番号セルのうち、symbolCellより上(row小さい)で最も近いものを選ぶ。
    // 同じ列に無ければ、最も近い列(絶対値最小)かつ上方、で代用する
    // (結合セルの影響で列番号が完全一致しないケースへの許容)。
    let best = null;
    let bestScore = Infinity;
    for (const roomCell of roomCells) {
      if (roomCell.row > symbolCell.row) continue; // 部屋番号はsymbolより上にあるはず
      const rowGap = symbolCell.row - roomCell.row;
      const colGap = Math.abs(roomCell.col - symbolCell.col);
      if (colGap > 4) continue; // 明らかに離れた列は候補にしない
      const score = colGap * 100 + rowGap; // 列の近さを最優先、その次に行の近さ
      if (score < bestScore) { bestScore = score; best = roomCell; }
    }
    if (best) assignments.push({ roomCell: best, symbolCell });
    else unassigned.push(symbolCell);
  }
  return { assignments, unassigned };
}

function parse(grid) {
  const warnings = [];
  const roomCells = findCells(grid, (s) => ROOM_NUMBER_PATTERN.test(zenkakuDigitsToHankaku(s)));
  const symbolCells = findCells(grid, (s) => CIRCLED_NUMBER_PATTERN.test(s));
  const legend = parseLegend(grid);

  if (!legend.defaultEntry && Object.keys(legend.perSymbol).length === 0) {
    warnings.push({
      code: 'SENSOR_LEGEND_NOT_FOUND',
      detail: '凡例行(「感知器：...」)が見つからなかったため、丸数字が何個・何式の感知器を表すか判定できません。部屋ごとに丸数字の有無だけを記録し、種別・個数は不明として返します。',
    });
  }

  const { assignments, unassigned } = assignSymbolsToRooms(roomCells, symbolCells);
  if (unassigned.length > 0) {
    warnings.push({
      code: 'SENSOR_SYMBOL_UNASSIGNED',
      detail: `${unassigned.length}件の丸数字セルを、どの部屋にも対応付けできませんでした(近くに部屋番号セルが見つからない)。`,
      cells: unassigned.map((c) => ({ row: c.row, col: c.col, value: c.value })),
    });
  }

  // [2026-08-03修正、Phase2①.7] 従来は部屋ごとの初期値を{sa:0,tei:0}とし、種別を解決できた
  // 丸数字だけを加算していた。この方式だと、1部屋に複数の丸数字がある場合に一部だけ未解決
  // (凡例に無い・種別を判定できない)でも、解決できた分だけの値が「確定値」のように
  // sensorMasterへ出てしまい、実際には内訳が不明であることが利用者から見えなくなる問題が
  // あった(例:③が定温1と解決でき、⑥が凡例に無く未解決の部屋は、従来{sa:0,tei:1}という
  // 一見確定した値になっていたが、実際には⑥の分の内訳が丸ごと欠落していた)。
  //
  // 部屋ごとに「解決済みの丸数字」「未解決の丸数字(元セルのrow/col/記号つき)」を分けて
  // 集計し、1つでも未解決の丸数字が残る部屋はsa/teiを確定値として出さず(null)、
  // 代わりに部屋番号・未解決記号を含むroom単位の警告(SENSOR_TYPE_UNRESOLVED)を出す。
  // 全ての丸数字が解決できた部屋のみ、sa/teiを数値で確定する。
  //
  // total(その部屋の丸数字の総個数、種別を問わない)は、内訳が未解決でも「個数自体は
  // 数えられている」ケースがあるため、sa/teiの内訳とは区別した別フィールドとして常に保持する
  // (sa/teiがnullでも、totalだけは分かるという構造を表現するため)。
  //
  // なお「特定の設備種別だけが未確認だと確実に判断できる場合は、確定できる側だけ数値で
  // 返してよい」という原則も設計上は認めているが、丸数字+凡例というこのフォーマットの
  // 構造上、未解決の丸数字はそれ自体が「差動でも定温でもあり得る、種別情報が無い」状態
  // であり、「差動ではないと確実に判断できる」ような手がかりは無い。そのため現状の実装では
  // 未解決丸数字が1つでもあればsa・tei両方をnullにする(将来、凡例側に「不明時は必ず定温」
  // のような追加情報源が確認できた場合は、片側だけ確定させる拡張の余地を残す)。
  const roomAgg = {};
  for (const { roomCell, symbolCell } of assignments) {
    const roomStr = zenkakuDigitsToHankaku(roomCell.value);
    if (!roomAgg[roomStr]) {
      roomAgg[roomStr] = { resolvedSa: 0, resolvedTei: 0, resolvedCount: 0, unresolved: [] };
    }
    const agg = roomAgg[roomStr];
    const entry = legend.perSymbol[symbolCell.value] || legend.defaultEntry;
    if (!entry || !entry.type) {
      agg.unresolved.push({ symbol: symbolCell.value, row: symbolCell.row, col: symbolCell.col });
      continue;
    }
    if (entry.type === 'sa') agg.resolvedSa += entry.quantity;
    else if (entry.type === 'tei') agg.resolvedTei += entry.quantity;
    agg.resolvedCount += entry.quantity;
  }

  const sensorMaster = {};
  for (const roomStr of Object.keys(roomAgg)) {
    const agg = roomAgg[roomStr];
    const total = agg.resolvedCount + agg.unresolved.length;
    if (agg.unresolved.length === 0) {
      sensorMaster[roomStr] = { sa: agg.resolvedSa, tei: agg.resolvedTei, total };
      continue;
    }
    sensorMaster[roomStr] = { sa: null, tei: null, total };
    const unresolvedSymbolList = agg.unresolved.map((s) => s.symbol);
    warnings.push({
      code: 'SENSOR_TYPE_UNRESOLVED',
      detail: `${roomStr}号室の丸数字${unresolvedSymbolList.join('、')}について、感知器種別を特定できませんでした。内訳は未確認です。0件と決め付けず未確認のまま保持しています。原本・凡例を確認してください。`,
      room: roomStr,
      unresolvedSymbols: unresolvedSymbolList,
      cells: agg.unresolved.map((s) => ({ row: s.row, col: s.col, value: s.symbol })),
    });
  }

  return { sensorMaster, warnings, legend: { defaultEntry: legend.defaultEntry, perSymbol: legend.perSymbol, rawLines: legend.rawLines } };
}

module.exports = {
  id: 'sensorCount.floorGridFormat.v1',
  label: '図面(フロアグリッド)形式(部屋番号+丸数字、末尾凡例で種別・個数を解決)',
  detect,
  parse,
};

    })(module, exports, require);
    return module;
  })();

  __ffModules["formatParsers/sensorCount/floorSummaryTextFormatParser.js"] = (function () {
    var module = { exports: {} };
    var exports = module.exports;
    var require = function (spec) { return __ffRequire("formatParsers/sensorCount/floorSummaryTextFormatParser.js", spec); };
    (function (module, exports, require) {
// lib/formatParsers/sensorCount/floorSummaryTextFormatParser.js
//
// [2026-08-02新設] 感知器数(sensorCount)フォーマット「階合計テキスト形式」用Parser。
//
// 2026-08-02、「アービング塚本」物件の実データ(感知器数アービング塚本.xlsx)で初めて
// 確認したフォーマット。1フロア=2行のブロックで、1行目に階ラベル(例:「7Ｆ」)と
// その階の部屋番号(例:703/702/701)が並び、2行目のうち各部屋番号の直下のセルに
// 「差動6　定温3」のような自由記述テキスト(見出し行の他の注記と混在することがある)で
// その部屋の感知器個数が書かれている。さらに2行目の左端の列には、その階の合計
// (例:「差動16　定温9」)が書かれており、通常は同じ階の各部屋の合計と一致する。
//
// 【他フォーマットとの違い】
// - tableFormat: 1行1部屋・個数は数値セル(F/G列)。今回は個数がテキストの中に埋め込まれて
//   おり、数値セルではない。
// - floorGridFormat(アービング千林大宮): 丸数字+末尾凡例で個数を間接的に表す。今回は
//   丸数字を使わず「差動」「定温」という語と数字がそのままセル内に書かれている。
//
// 【今回発見した実データの品質上の注意点】
// この物件の実データでは、3F(3階)の階合計セルが「差動18　差動7」となっており、本来
// 「定温7」であるべき箇所が「差動7」と誤記されている(定温のラベル自体を差動と誤植したと
// 見られる)。加えて各部屋の合計(差動17/定温8)と階合計(差動18)も数値が一致していない。
// これは原本自体のデータ品質の問題であり、このParserが誤って解析しているのではないことを
// 示すため、parse()は「階合計」と「各部屋の合計の合計」を突き合わせ、不一致があれば
// warningsに積んで返す(黙って多数決や自動補正をしない)。
'use strict';

const ROOM_NUMBER_PATTERN = /^\d{2,4}$/;
const FLOOR_LABEL_PATTERN = /^\d+\s*[FＦ階]$/;

// [2026-08-02追加] 「アービング野中南公園」の実データで、部屋番号が全角数字
// (例:「１３０５」)で書かれているケースが見つかった(アービング塚本は半角数値だった)。
// レイアウト自体はfloorSummaryTextFormat(部屋直下に「差動N 定温M」、階合計列なし)と
// 完全に同じで、違いは部屋番号の全角/半角表記だけだったため、新フォーマットとして
// 切り出さず、既存Parserの部屋番号判定を全角対応にする形で吸収した(floorGridFormatParser.js
// のzenkakuDigitsToHankaku()と同じロジック)。構造が同じものを表記ゆれのたびに別Parserへ
// 分裂させると保守性が落ちるため、「レイアウトが違う場合のみ新Parserを追加し、表記ゆれは
// 既存Parser内の正規化で吸収する」という使い分けをこのプロジェクトの方針とする。
function zenkakuDigitsToHankaku(str) {
  return String(str).replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
}
// 「差動」「定温」の直後(空白文字、または「×」「x」「X」による区切りを挟んでよい)に
// 数字が来て初めて有効な個数とみなす。「中扉差動」のような、数字が直接続かない自由記述の
// 注記は引き続き意図的にマッチさせない。
//
// [2026-08-03修正、実データ対応(アービング宝塚)] 当初は「差動×2」のような「×」区切り表記も
// 意図的に除外する設計だった(数字が直接続かない自由記述の注記の一例として想定していた)。
// しかし「アービング宝塚」の実データ(感知器数アービング宝塚.xls)で、全部屋の個数が
// 「差動×5\n定温×1」のように一貫して「×」区切りで書かれているケースが見つかり、これは
// 誤検出防止のための除外対象ではなく、単なる区切り文字の表記ゆれ(このプロジェクトの既存方針
// 「レイアウトが違う場合のみ新Parserを追加し、表記ゆれは既存Parser内の正規化で吸収する」の
// 対象)であると判断し、ご指示のうえ吸収するよう修正した。既存の「アービング塚本」実データ
// (このParserの新設元)では「差動×2」という文字列が「差動6　定温3」という本来の値と同じ
// セル内に注記として混在するケース(左洋室CL、リビング差動×2)があるが、lastMatchNumber()は
// テキスト内で最後に一致した数字を採用する仕様であり、このケースでは本来の値「差動6」が
// 注記より後ろに書かれているため、この修正後も引き続き「6」が正しく採用される
// (既存fixtureで回帰テスト済み)。
// マーカー(差動/定温/煙、またはそれらの代わりに使われるアイコン文字)の「文字自体」を
// 交互記法(regexの(?:a|b)形式に埋め込む文字列)として持つ。数字部分・区切り文字・
// 「？」付き不確実表記の解釈はlastMatchNumber()側で一括して行う。
//
// [2026-08-03追加、実データ対応(グランフォルム須磨浦)] 「差動」「定温」という漢字ではなく、
// 2種類の私用領域(PUA)Unicode文字(フォント名「丸ゴシック」、凡例はファイル内に無し)で
// 「アイコン1×8　アイコン2×6」のように記載されているケースが見つかった。レイアウト自体は
// 既存の「差動N 定温M」形式と完全に同じ(部屋直下に個数、常にアイコン1が先・アイコン2が後の
// 順)だったため、ご確認のうえ新規Parserは新設せず、マーカーの表記ゆれとして既存Parserへ
// 吸収した。ご確認の結果、アイコン1(U+E012)=定温(tei)、アイコン2(U+E014)=差動(sa)という
// 対応であることが分かった(このプロジェクトの他の実データでの「差動が先・定温が後」という
// 並び順とは、アイコン番号と種別の対応が逆になっている点に注意)。

// [2026-08-03追加、実データ対応(コスモ茨木シティフォルム)] 「差動」「定温」を単漢字に
// 略記した「差×5　定×1」という表記が見つかった。レイアウト自体は既存の「差動N 定温M」
// 形式と完全に同じ(階ラベル+部屋番号の行、直下に個数の行)で、ファイル全体を確認しても
// この略記以外の書き方(フルの語句・アイコン)は一切見つからず、書き漏らし等の曖昧さも
// 無かったため、ご確認のうえ新規Parserは新設せず、マーカーの表記ゆれとして既存Parserへ
// 吸収した(単漢字「差」「定」の直後に数字が続く場合のみ有効とみなす既存の数字抽出ロジック
// (lastMatchNumber、マーカー直後に空白/「×」を挟んで数字が来る場合のみ一致)をそのまま
// 適用するため、「定員5」のように単漢字の直後にすぐ無関係な文字が続くケースでは一致しない)。
const SA_MARKER_ALT = '差動|差|';
const TEI_MARKER_ALT = '定温|定|';
// [2026-08-03追加、実データ対応(グランフォルム新神戸)] 「煙×1」のように、これまで扱って
// こなかった煙感知器(kemuri)の個数が各部屋のセルに書かれているケースが見つかった。
// ご確認のうえ、sensorMasterにkemuriフィールドを新設して記録する方針とした(sa/teiと同じく
// マーカーの直後の数字だけを拾う既存方針に倣い、「煙」の直後の数字のみを拾う)。
// この変更はfloorSummaryTextFormatParser限定であり、他の6Parser・共通スキーマ
// (validateFsdf/LB側の表示等)へは今回のスコープでは波及させていない。全Parser共通の
// スキーマとして扱うべきかは、今後実際に他フォーマットでも煙感知器の記載が見つかった際に
// 改めてご判断いただく。グランフォルム須磨浦の実データには煙に相当するアイコンの記載は
// 見当たらなかったため、煙側はマーカー文字のみ(アイコン無し)のまま。
const KEMURI_MARKER_ALT = '煙';

// [2026-08-03修正、実データ対応(グランフォルム須磨浦)] 従来はマーカー直後の数字1つだけを
// 拾っていたが、この物件の実データでは「アイコン1×8？6？」のように、点検した方自身が
// 個数に自信を持てなかった箇所で「？」区切りの複数の候補数字が併記されているケースが
// 見つかった。ご確認のうえ、「？」で区切られた複数の数字がある場合は、既存のlastMatchNumber
// の「テキスト内で最後に一致した数字を採用する」という考え方をそのまま延長し、最後に
// 書かれた数字(この例では6)を採用する方針とした。数字自体が無い(例:「アイコン1×」)場合は
// 従来通りnull(未確認)のまま。
//
// 【マーカーがセル内に複数回出現する場合の優先順位、2026-08-03改訂】
// 当初(アービング塚本)は「同じマーカーが複数回出現すれば最後のものを採用する」という単純な
// ルールだった(部屋の主な記載の前に「リビング差動×2」のような別区画についての紛らわしい
// 注記が入っており、本来の値がその後ろに書かれていたケース)。
// しかし「グランフォルム須磨浦」の実データで、逆に部屋直下の主な記載(アイコン1×2
// アイコン2×3)が先に書かれ、その後に「ガレージあり（№1）アイコン1×1」という、ガレージ
// (部屋とは別の付随スペース)についての注記が後ろに書かれているケースが見つかった。この
// ケースで単純に「最後のものを採用」すると、部屋本体の値(2)ではなくガレージの注記の値(1)を
// 誤って採用してしまう。
// ご確認のうえ、両ケースに共通する判別基準として「マーカーがその行の先頭(空白文字を除く)に
// 現れているか(＝場所を限定する言葉が前に付いていない「素の」記載か)」を優先順位とした。
// アービング塚本の「差動6」・グランフォルム須磨浦の「アイコン1×2」はいずれも行頭からの
// 素の記載(bare)であるのに対し、「リビング差動×2」「ガレージあり（№1）アイコン1×1」は
// いずれも場所を表す言葉が同じ行の前に直接続く(prefixed)。素の記載が1件でもあればそれを
// 優先し(複数あれば従来通り最後のものを採用)、素の記載が1件も無ければ(まだ見ぬケースへの
// フォールバックとして)従来通りすべての出現のうち最後のものを採用する。
// [2026-08-03修正、実データ対応(グランフォルム須磨浦・アービング塚本の回帰)] 「bare」判定を
// 「行頭からの距離」ではなく「直前の同マーカー一致の終端からの距離」を基準にするよう修正した。
// 当初は単純に「その行の先頭(空白文字を除く)から続けて書かれているか」だけを見ていたが、
// この基準では「差動18　差動7」(アービング塚本3F階合計セルの誤記、同じ行内に同じマーカーが
// 数値と空白だけを挟んで2回連続するケース)の2つ目の「差動7」が、1つ目の「差動18」という
// 文字列が直前に存在するために「prefixed」と誤判定され、意図した「最後の値(7)を採用」が
// できなくなる回帰を引き起こした。
// 「直前の同マーカー一致の終端」を基準にすることで、同じマーカーの数値だけが連続する
// (＝場所を表す言葉を挟まない)ケースは、たとえ行内で2回目以降の出現であっても
// 引き続き「bare」とみなされ、「グランフォルム須磨浦」のガレージ注記のケース
// (「ｶﾞﾚｰｼﾞあり（№1）」という無関係な場所の説明が割り込む場合のみprefixedとする)との
// 両立を保てる。基準となる開始位置は「その行の先頭」と「直前の同マーカー一致の終端」の
// うち、より後ろにある方(=同じ行内で直前の一致がある場合はそちら、無い場合や別の行の
// 場合は行頭)とする。
function lastMatchNumber(text, markerAlternation) {
  const re = new RegExp('(?:' + markerAlternation + ')\\s*[×xX]?\\s*((?:\\d+\\s*[？?]?\\s*)+)', 'g');
  let m;
  const bareValues = [];
  const allValues = [];
  let prevMatchEnd = -1;
  while ((m = re.exec(text)) !== null) {
    const nums = m[1].match(/\d+/g);
    if (!nums || !nums.length) continue;
    const value = Number(nums[nums.length - 1]);
    allValues.push(value);
    const lineStart = text.lastIndexOf('\n', m.index - 1) + 1;
    const prefixStart = Math.max(lineStart, prevMatchEnd);
    const linePrefix = text.slice(prefixStart, m.index);
    if (linePrefix.trim() === '') bareValues.push(value);
    prevMatchEnd = m.index + m[0].length;
  }
  if (bareValues.length) return bareValues[bareValues.length - 1];
  if (allValues.length) return allValues[allValues.length - 1];
  return null;
}

// [2026-08-05追加、現場実機テストP0-2対応] セルのテキストを「括弧の外(主値)」と
// 「括弧の中(意味の異なる副値。例: 確認灯付き個数)」に分離する。
// floorFormatWithConfirmedSubcountParser.jsのsplitMainAndParen()と同じ考え方だが、
// このParserは主値の抽出にlastMatchNumber()の「行内での位置関係(bare/prefixed)」判定を
// 使っているため、括弧の前だけを切り出す(truncateする)と、括弧の後ろに続く文字列
// (例:グランフォルム須磨浦の「ガレージあり（№1）アイコン1×1」のように、無関係な注記の
// 括弧の後ろに別の記載が続くケース)が失われ、既存の回帰ケースを壊すおそれがある。
// そのため主値側は「括弧を空白に置換して除去する」方式にし、括弧の前後のテキストの
// 位置関係(改行・空白による隣接判定)を変えずに、括弧の中身だけを主値の判定対象から
// 除外する。副値(括弧の中身)は最初の括弧1件分のみを別途保持する(既存の
// floorFormatWithConfirmedSubcountParser.jsと同じ、複数括弧がある場合は最初の1件のみ
// 対象とする挙動に合わせている)。
function splitMainAndParen(text) {
  const parenMatch = text.match(/[\(（]([^\)）]*)[\)）]/);
  const parenPart = parenMatch ? parenMatch[1] : null;
  const mainPart = text.replace(/[\(（][^\)）]*[\)）]/g, ' ');
  return { mainPart, parenPart };
}

// セルのテキストから{sa, tei, kemuri}を抽出する。3種別ともいずれも見つからなければnullを返す
// (「感知器の記載が無いセル」と「0個と明記されたセル」を区別するため、0を仮定しない)。
// [2026-08-03修正、Phase2①.6] 従来はsa/teiの一方だけ見つかった場合、見つからなかった方を
// 0として返していた(例:「差動6」のみのセルはtei:0になっていた)。ご指示により
// 「解析不能を0へ変換しない」をParser共通の設計原則として統一するため、見つからなかった方は
// 0で補完せずnull(未確認)のまま返すよう修正した。
// [2026-08-03追加(グランフォルム新神戸)] kemuriを追加。sa・teiがどちらもnullでも、kemuriが
// 見つかっていれば(煙のみが記載されたセルもありうるため)有効な個数として扱う。
// [2026-08-05修正、現場実機テストP0-2対応] 従来はセル全体(括弧の中も含む)をそのまま
// lastMatchNumber()に渡していたため、「差動5・定温3(差動4・定温1)」のように括弧内に
// 意味の異なる別の数字(確認灯付き個数等)が併記されるセルで、括弧内の値を誤って主値として
// 拾ってしまう事故があった(detect()側の「シート全体での括弧併記セルの比率が0.3以上なら
// 別Parserへ譲る」ガードは、比率がそこまで高くない少数派のセルには効かない)。
// 主値の抽出は必ず括弧を除去した本文(mainPart)だけを対象にするよう修正する
// (lastMatchNumber()自体のbare/prefixed判定ロジックは一切変更していない)。
function extractCount(cellValue) {
  if (cellValue == null) return null;
  const text = String(cellValue);
  const { mainPart } = splitMainAndParen(text);
  const sa = lastMatchNumber(mainPart, SA_MARKER_ALT);
  const tei = lastMatchNumber(mainPart, TEI_MARKER_ALT);
  const kemuri = lastMatchNumber(mainPart, KEMURI_MARKER_ALT);
  if (sa === null && tei === null && kemuri === null) return null;
  return { sa: sa, tei: tei, kemuri: kemuri };
}

// 階合計セル用。extractCount()と違い、片方の種別が見つからない場合でも0を仮定せず
// nullのまま返す(階合計が2行に分割されているケースで、「まだ片方しか読んでいない」
// ことを区別するため。[2026-08-02、グランデイア南茨木の実データ対応で追加])。
// [2026-08-03注記] 階合計(floorTotals)は既存通りsa/teiのみを対象とする。煙感知器の
// 階合計との突合は今回のスコープ外(グランフォルム新神戸の実データでは2F〜5Fの各階に
// 階合計セル自体が無いため、現時点では突合の必要が無い)。
// [2026-08-05修正、現場実機テストP0-2対応] extractCount()と同様、括弧内の値を誤って
// 階合計の主値として拾わないよう、mainPart(括弧除去後)のみを対象にする。
function extractPartial(cellValue) {
  if (cellValue == null) return { sa: null, tei: null };
  const text = String(cellValue);
  const { mainPart } = splitMainAndParen(text);
  return { sa: lastMatchNumber(mainPart, SA_MARKER_ALT), tei: lastMatchNumber(mainPart, TEI_MARKER_ALT) };
}

// [2026-08-03追加、実データ対応(グランフォルム新神戸)] セルのテキストが「PS」(パイプ
// スペース等、住戸に付随する共用の小部屋)で始まるかどうかを判定する。「PS」はアルファベット
// 2文字という他の日本語主体のセル内容と混同しにくい目印であるため、これを住戸本体の値とは
// 区別する印として利用する。
function isPsCell(cellValue) {
  if (cellValue == null) return false;
  const text = String(cellValue).trim();
  return /^PS(\s|$)/i.test(text);
}

// [2026-08-03新設、実データ対応(グランフォルム新神戸)] 1フロアに複数の住戸が横に並ぶ
// レイアウトで、各住戸の「本体の値が入っている列」と「PS(付随する共用の小部屋)の値が
// 入っている列」を判定する。
//
// 【発見の経緯】この物件の実データでは、1フロアに2住戸(例:501・502)が並び、見出し行の
// 部屋番号の直下((部屋番号と同じ列)の1行下)に必ずしも住戸本体の値が来るとは限らない
// ことが分かった。501号室は見出しと同じ列(D列)に本体の値があるが、502号室は見出しの列
// (F列)に「PS」の値が入っており、本体の値はさらに1列右(G列)にズレていた(シート作成者が
// 「PS」の列を2住戸の間の共有スペースとして視覚的に配置したため)。この列ズレに既存Parser
// (部屋番号と同じ列を機械的に本体値とみなす)がそのまま対応すると、502号室の値としてPSの
// 値(差動×1のみ)を誤って読み取り、本来の502号室本体の値を取りこぼす事故が起きる。
//
// 【対応方針、ご確認済み】各住戸の「窓(window)」を、その住戸の見出し列から次の住戸の見出し
// 列の手前まで(最後の住戸は見出し列から数列先まで)とし、窓の中を見出し列側から順に走査して
// 「PS」で始まらない、かつ差動/定温/煙のいずれかを含むセルを見つけたら、そこをその住戸の
// 本体値の列(ownCol)とする。窓の中で「PS」から始まるセルは、その住戸に付随するPSの値
// (psCols)としてご指示のとおり本体値と合算する。
function classifyRoomColumns(roomCols, referenceRow) {
  const sorted = roomCols.slice().sort((a, b) => a - b);
  const assignment = {};
  for (let i = 0; i < sorted.length; i++) {
    const c = sorted[i];
    const windowEnd = (i + 1 < sorted.length) ? sorted[i + 1] : Math.min((referenceRow || []).length, c + 4);
    let ownCol = null;
    const psCols = [];
    for (let cc = c; cc < windowEnd; cc++) {
      const v = (referenceRow || [])[cc];
      if (v == null) continue;
      if (isPsCell(v)) {
        psCols.push(cc);
      } else if (ownCol === null && extractCount(v)) {
        ownCol = cc;
      }
    }
    if (ownCol === null) ownCol = c; // 見つからない場合は見出し列自体をフォールバックにする(nullやSENSOR_VALUE_MISSINGが自然に出るようにするため)。
    assignment[c] = { ownCol: ownCol, psCols: psCols };
  }
  return assignment;
}

function findHeaderRows(grid) {
  const headerRows = [];
  for (let r = 0; r < (grid || []).length; r++) {
    const row = grid[r];
    if (!row) continue;
    const roomCols = [];
    let floorLabel = null;
    let totalLabelCol = null;
    for (let c = 0; c < row.length; c++) {
      const v = row[c];
      if (v == null) continue;
      const str = String(v).trim();
      if (FLOOR_LABEL_PATTERN.test(zenkakuDigitsToHankaku(str))) {
        // [2026-08-02修正] 以前はここをrow.find(...)で別途再検索しており、その際は
        // zenkaku変換をかけずに直接FLOOR_LABEL_PATTERNと照合していたため、階ラベルの
        // 数字が全角(例:「７\n\nＦ」、グランデイア南茨木の実データ)だと一致せず、
        // floorLabelがundefinedになるバグがあった(部屋番号の全角変換は元々されていたが、
        // 階ラベル側は取りこぼしていた)。floorLabelがundefinedだと、floorTotalsの
        // キーが全フロアで"undefined"に衝突し、warningsの階表示も壊れてしまうため、
        // このループ内でzenkaku変換込みで一度に判定・取得するよう統合した。
        if (floorLabel === null) floorLabel = str;
      } else if (ROOM_NUMBER_PATTERN.test(zenkakuDigitsToHankaku(str))) {
        roomCols.push(c);
      } else if (str === '合計' && totalLabelCol === null) {
        // [2026-08-03追加、Phase2①.7] 見出し行に「合計」という列見出しが明示されている
        // 場合、その列をこの階の階合計セルの位置として確定させる。従来は階合計セルの
        // 値そのものから「差動/定温」の文字列信号を検出できた場合に限り、その列を階合計と
        // 認識していたため、階合計セルが完全に空欄・非数値(信号ゼロ)の場合、そもそも
        // 「ここが階合計の列だ」と認識できず、警告を出すこと自体ができなかった
        // (「階合計が存在しないケース」と「階合計はあるが読み取れないケース」を区別
        // できていなかった)。見出し行の「合計」という明示的なラベルを手がかりに列位置を
        // 先に確定させることで、値が空欄・非数値でも「本来ここに階合計があるはずだが
        // 読み取れない」ことを検出しSENSOR_FLOOR_TOTAL_MISSINGを出せるようにする。
        totalLabelCol = c;
      }
    }
    if (floorLabel && roomCols.length > 0) headerRows.push({ row: r, roomCols, floorLabel, totalLabelCol });
  }
  return headerRows;
}

// [2026-08-02追加] 「グランドハイツ魚崎」の実データで、セルが「差動5定温3　(差動2定温0)」
// のように、括弧の外(設置感知器個数)と括弧の中(確認灯がついてる個数)という意味の違う
// 2つの数字を持つケースが見つかった。このParserのextractCount()はセル全体から
// 「最後に一致した差動/定温の数字」を拾う仕様のため、この形式のデータに反応すると
// 括弧の中の別の意味の数字を誤って主値として返してしまう(実際に973号室で本来sa=5/tei=3の
// ところsa=2/tei=0という誤った値を返す事故を確認した)。この形式は専用のParser
// (floorFormatWithConfirmedSubcountParser)に任せるべきなので、括弧内にも差動/定温の
// 数字が入っているセルが一定割合を超える場合はこのParserの確信度を0にする。
function hasParenSubcount(text) {
  const m = String(text).match(/[\(（]([^\)）]*)[\)）]/);
  if (!m) return false;
  return /差動\s*\d+/.test(m[1]) || /定温\s*\d+/.test(m[1]);
}

function detect(grid) {
  if (!Array.isArray(grid)) return { matches: false, confidence: 0 };
  const headerRows = findHeaderRows(grid);
  if (headerRows.length === 0) return { matches: false, confidence: 0, reason: '階ラベル+部屋番号の見出し行が見つからない' };

  let pairedCountRows = 0;
  let roomsWithCount = 0;
  let totalRoomCols = 0;
  let roomsWithParenSubcount = 0;
  for (const h of headerRows) {
    const countRow = grid[h.row + 1];
    if (!countRow) continue;
    let anyCount = false;
    for (const c of h.roomCols) {
      totalRoomCols++;
      const cellValue = countRow[c];
      if (extractCount(cellValue)) {
        anyCount = true;
        roomsWithCount++;
        if (hasParenSubcount(cellValue)) roomsWithParenSubcount++;
      }
    }
    if (anyCount) pairedCountRows++;
  }
  if (pairedCountRows === 0) return { matches: false, confidence: 0, reason: '見出し行の直下に「差動」「定温」を含むテキストが見つからない' };

  if (roomsWithCount > 0 && roomsWithParenSubcount / roomsWithCount >= 0.3) {
    return {
      matches: false,
      confidence: 0,
      reason: `個数セル${roomsWithCount}件中${roomsWithParenSubcount}件で括弧内にも差動/定温の数字が入っており、主値+確認灯付き内訳が併記される別形式(floorFormatWithConfirmedSubcount)の可能性が高いため、この形式とは判定しない`,
    };
  }

  const confidence = 0.5 + 0.4 * (roomsWithCount / Math.max(1, totalRoomCols));
  return {
    matches: true,
    confidence: Math.min(0.97, confidence),
    reason: `見出し行${headerRows.length}件中${pairedCountRows}件で直下に「差動/定温」テキストを検出(部屋${roomsWithCount}/${totalRoomCols}件)`,
  };
}

// [2026-08-03新設、実データ対応(グランフォルム新神戸)] 階見出し行の直後、次の階見出し行
// (または空行)の手前までを、この階の「値ブロック」として集める。既存のアービング塚本・
// アービング宝塚・アービング野中南公園・グランデイア南茨木は、いずれも1階=1行のみで
// ブロックが完結するため、この関数を通しても従来通りgrid[h.row+1]の1行だけが返る
// (回帰無し、既存fixtureで確認済み)。一方グランフォルム新神戸は、5F(501・502)のみ
// 住戸内の別区画(洋室・トイレ前洋室等)の値がもう1行分あり、1階=2行のブロックになって
// いることが分かった。次の階見出し行に当たったら止め、誤って次の階のデータを飲み込まない
// ようにする。
function collectBlockRows(grid, headerRow, headerRowIndexSet) {
  const rows = [];
  for (let r = headerRow + 1; r < grid.length; r++) {
    if (headerRowIndexSet.has(r)) break;
    const row = grid[r];
    if (!row || row.every((v) => v == null)) break;
    rows.push(row);
  }
  return rows;
}

// [2026-08-03新設、実データ対応(グランフォルム新神戸)] 1住戸について、本体値の列(ownCol)
// とPS列(psCols)の全ブロック行分の値を合算する。sa/tei/kemuriそれぞれ独立に、1件も
// 見つからなければnullのまま(0を捏造しない)、1件でも見つかれば見つかった値の合計を返す。
function sumRoomCounts(blockRows, ownCol, psCols) {
  const cols = [ownCol].concat(psCols);
  let sa = null, tei = null, kemuri = null;
  for (const row of blockRows) {
    for (const c of cols) {
      const count = extractCount(row[c]);
      if (!count) continue;
      if (count.sa !== null) sa = (sa || 0) + count.sa;
      if (count.tei !== null) tei = (tei || 0) + count.tei;
      if (count.kemuri !== null) kemuri = (kemuri || 0) + count.kemuri;
    }
  }
  return { sa: sa, tei: tei, kemuri: kemuri };
}

function parse(grid) {
  const warnings = [];
  const headerRows = findHeaderRows(grid);
  const headerRowIndexSet = new Set(headerRows.map((h) => h.row));
  const sensorMaster = {};
  const floorTotals = {};

  for (const h of headerRows) {
    const countRow = grid[h.row + 1];
    if (!countRow) {
      warnings.push({ code: 'SENSOR_COUNT_ROW_MISSING', detail: `階見出し行(${h.floorLabel})の直下に個数の行が見つかりません。`, row: h.row });
      continue;
    }
    const roomColSet = new Set(h.roomCols);
    let floorSa = 0;
    let floorTei = 0;

    // [2026-08-03追加、実データ対応(グランフォルム新神戸)] 各住戸の本体値列・PS列を、
    // 見出し行の直後の行(countRow)を手がかりに判定し、階全体の値ブロック(1行とは
    // 限らない)から合算する。既存フォーマット(1住戸1列・PS無し・1行のみ)では
    // ownCol=見出し列そのもの、psCols=空になるため、結果は従来と完全に同じになる。
    const colAssignment = classifyRoomColumns(h.roomCols, countRow);
    const blockRows = collectBlockRows(grid, h.row, headerRowIndexSet);
    // 本体値列・PS列として住戸に割り当て済みの列は、階合計候補の走査から除外する
    // (この物件のように、住戸本体の値が見出し列からズレて別の列に入っている場合、
    // 除外しないとその列を誤って「階合計」として二重に読み取ってしまう。実際に修正前は
    // 502号室本体の値が「階合計」と誤認識され、SENSOR_FLOOR_TOTAL_MISMATCH警告が
    // 誤って出ていた)。
    const claimedCols = new Set();
    h.roomCols.forEach((c) => {
      const a = colAssignment[c];
      claimedCols.add(a.ownCol);
      a.psCols.forEach((pc) => claimedCols.add(pc));
    });

    // 階合計らしきセル(部屋番号の列と一致しない位置にある「差動/定温」テキスト)の列と、
    // そこから読み取れた差動/定温の値(片方しか読み取れていない場合はnullのまま)。
    let totalCol = null;
    let declaredSa = null;
    let declaredTei = null;

    for (let c = 0; c < countRow.length; c++) {
      const cellValue = countRow[c];
      if (roomColSet.has(c)) {
        const roomStr = zenkakuDigitsToHankaku(String(grid[h.row][c]).trim());
        const count = sumRoomCounts(blockRows, colAssignment[c].ownCol, colAssignment[c].psCols);
        // [2026-08-05追加、現場実機テストP0-2対応] 括弧内に差動/定温の数字が併記されている
        // セルは、その括弧内の値を主値の判定からは除外している(extractCount参照)。
        // どの値が採用されたかを追跡できるよう、除外が発生したことを情報として警告に残す
        // (値そのものは正しく主値=括弧外を採用しているため、致命的な警告ではないが、
        // セルの見た目(括弧内の数字)と実際に採用した値が異なることに現場が気づけるようにする)。
        const cols = [colAssignment[c].ownCol].concat(colAssignment[c].psCols);
        const hadParenSubcount = blockRows.some((row) => cols.some((cc) => hasParenSubcount(row[cc])));
        if (hadParenSubcount) {
          warnings.push({
            code: 'SENSOR_VALUE_PAREN_SUBCOUNT_IGNORED',
            detail: `部屋${roomStr}(${h.floorLabel}): セル内の括弧「(...)」の中に差動/定温の数字が併記されていましたが、意味が異なる別の数字(確認灯付き個数等)の可能性があるため、主値の判定からは除外し、括弧の外側の数字のみを採用しました(採用した主値: 差動${count.sa === null ? '不明' : count.sa}・定温${count.tei === null ? '不明' : count.tei})。括弧内の数値も確認したい場合は原本をご確認ください。`,
            row: h.row + 1, room: roomStr,
          });
        }
        // [2026-08-03追加、Phase2①.6] セルが空欄、または「差動」「定温」いずれの記載も
        // 見つからない(自由記述等)場合、従来は当該部屋を丸ごと読み飛ばし(sensorMasterに
        // エントリを作らず、警告も出さない)でいた。「解析不能の場合は必ずwarningsを付ける」
        // という方針に沿って、sa:null,tei:nullのエントリを作った上でSENSOR_VALUE_MISSING
        // 警告を出すよう修正した。
        if (count.sa === null && count.tei === null && count.kemuri === null) {
          sensorMaster[roomStr] = { sa: null, tei: null, kemuri: null };
          warnings.push({
            code: 'SENSOR_VALUE_MISSING',
            detail: `部屋${roomStr}(${h.floorLabel}): 個数のセル(本体+付随するPS等)に「差動」「定温」「煙」いずれの記載も見つかりません。0件と決め付けず未確認のまま保持しています。原本を確認してください。`,
            row: h.row + 1, room: roomStr,
          });
          continue;
        }
        sensorMaster[roomStr] = { sa: count.sa, tei: count.tei, kemuri: count.kemuri };
        if (count.sa === null) {
          warnings.push({
            code: 'SENSOR_VALUE_MISSING',
            detail: `部屋${roomStr}(${h.floorLabel}): 「差動」の件数の記載が見つかりません。0件と決め付けず未確認のまま保持しています。原本を確認してください。`,
            row: h.row + 1, room: roomStr, type: 'sa',
          });
        }
        if (count.tei === null) {
          warnings.push({
            code: 'SENSOR_VALUE_MISSING',
            detail: `部屋${roomStr}(${h.floorLabel}): 「定温」の件数の記載が見つかりません。0件と決め付けず未確認のまま保持しています。原本を確認してください。`,
            row: h.row + 1, room: roomStr, type: 'tei',
          });
        }
        // [2026-08-03注記] kemuri(煙)が見つからない場合は、sa/teiと違い警告を出さない。
        // このフィールドは今回新設したばかりで、他の大多数の物件のデータには元々煙感知器の
        // 記載自体が無い(この物件固有の記載)ため、警告を出すと無関係な全物件に新規警告が
        // 大量発生してしまう。sa/teiのSENSOR_VALUE_MISSINGとは非対称だが、意図的な設計。
        // [2026-08-03注記] floorSa/floorTeiは、この階の「階合計セル」との整合性チェック
        // (SENSOR_FLOOR_TOTAL_MISMATCH警告)専用の内部集計値であり、sensorMaster(利用者に
        // 見える部屋ごとの値)には含まれない。この集計自体は今回のスコープ(利用者に見える
        // 値の0捏造防止)の対象外のため、未確認(null)の部屋は集計上0として扱う従来の単純化を
        // 維持している(完了報告にて別途この点を透明性のため報告する)。
        floorSa += (count.sa || 0);
        floorTei += (count.tei || 0);
        continue;
      }
      // [2026-08-03追加、実データ対応(グランフォルム新神戸)] 住戸本体・PSとして既に
      // 割り当て済みの列は、階合計候補として扱わない(上のclaimedCols参照)。
      if (claimedCols.has(c)) continue;
      // [2026-08-03追加、Phase2①.7] 見出し行に「合計」という明示的な列見出しがある場合、
      // その列位置はh.totalLabelColとして既に確定しているため、他の列を階合計候補として
      // 誤って拾わない(値の信号だけで判定する旧ロジックとの二重検出を避ける)。
      if (h.totalLabelCol !== null) continue;
      // 部屋番号の列と一致しない位置にある「差動/定温」テキストは、階合計とみなす
      // (今回の実データでは列A、部屋列より左にあるが、列位置を決め打ちにしない)。
      const partial = extractPartial(cellValue);
      if (partial.sa === null && partial.tei === null) continue;
      if (totalCol !== null && c !== totalCol) {
        warnings.push({ code: 'SENSOR_MULTIPLE_FLOOR_TOTALS', detail: `階(${h.floorLabel})の合計らしきセルが複数見つかりました。列${c}の値を採用しました。`, row: h.row + 1 });
      }
      totalCol = c;
      if (partial.sa !== null) declaredSa = partial.sa;
      if (partial.tei !== null) declaredTei = partial.tei;
    }

    // [2026-08-03追加、Phase2①.7] 見出し行に明示された「合計」列があれば、値の信号の
    // 有無に関わらず、その列を階合計セルとして確定させる(空欄・非数値でも「本来ここに
    // 階合計があるはずだが読み取れない」ことを検出できるようにするため)。
    if (h.totalLabelCol !== null && totalCol === null) {
      totalCol = h.totalLabelCol;
      const labeledPartial = extractPartial(countRow[h.totalLabelCol]);
      declaredSa = labeledPartial.sa;
      declaredTei = labeledPartial.tei;
    }

    // [2026-08-02追加] 「グランデイア南茨木」の実データで、階合計が1つのセルではなく
    // 見出し行+1行目(「差動42」のみ)と見出し行+2行目(「定温 28」のみ)の2行に分かれて
    // 書かれているケースが見つかった。見出し行+1のセルに差動・定温のどちらか片方しか
    // 無かった場合に限り、同じ列の見出し行+2のセルを補完として確認する。ただし+2行目が
    // 別の階の見出し行そのものになっている場合(既存のアービング塚本・野中南公園のような
    // 1フロア2行ブロックのフォーマット)は補完を試みない(誤って次の階の見出しを
    // 読みに行かないため)。
    if (totalCol !== null && (declaredSa === null || declaredTei === null) && !headerRowIndexSet.has(h.row + 2)) {
      const belowRow = grid[h.row + 2];
      if (belowRow) {
        const belowPartial = extractPartial(belowRow[totalCol]);
        if (declaredSa === null && belowPartial.sa !== null) declaredSa = belowPartial.sa;
        if (declaredTei === null && belowPartial.tei !== null) declaredTei = belowPartial.tei;
      }
    }

    // [2026-08-03修正、Phase2①.7] 従来はここでdeclaredSa||0 / declaredTei||0によって、
    // 階合計セルが空欄・解析不能の場合も内部的に0へ変換していた(①.6時点では
    // 「sensorMasterに出ない内部診断値だから」という理由でスコープ外としていたが、ご指摘の
    // 通りこれも「誤った確定値をLBへ渡す可能性」を否定できないため、①.7で修正する)。
    // sa/teiを独立して判定し、以下の3状態を区別する。
    //   1. 階合計が読み取れて、部屋合計と一致する → 何もしない(floorTotalsにのみ記録)
    //   2. 階合計が読み取れて、部屋合計と不一致 → SENSOR_FLOOR_TOTAL_MISMATCH(既存)
    //   3. 階合計がそもそも読み取れない(空欄・非数値・解析不能) → 0と決め付けず、
    //      SENSOR_FLOOR_TOTAL_MISSINGを出し、その種別(sa/tei)の整合性チェックは行わない
    // (「階合計が存在しないケース」と「階合計が存在して食い違うケース」の区別)。
    //
    // アービング塚本3Fの実データ(階合計セルが「差動18　差動7」という誤記)で確認した通り、
    // この独立判定でも既存のSENSOR_FLOOR_TOTAL_MISMATCH検出は失われない: declaredSa=7
    // (最後に一致した「差動」の数字、誤記だが数値としては読める)は部屋合計(floorSa=17)と
    // 不一致のためMISMATCHが出る。declaredTei=null(このセルに「定温」の文字列自体が
    // 存在しない)は0と決め付けずMISSINGが出る。回帰テストで両方を確認している。
    if (totalCol !== null) {
      const declared = { sa: declaredSa, tei: declaredTei };
      floorTotals[h.floorLabel] = declared;

      if (declaredSa === null) {
        warnings.push({
          code: 'SENSOR_FLOOR_TOTAL_MISSING',
          detail: `階(${h.floorLabel})の「差動」の階合計を読み取れませんでした(空欄または非数値)。0件と決め付けず、この階の差動については階合計との整合性チェックを行っていません。原本を確認してください。`,
          row: h.row + 1,
          type: 'sa',
        });
      } else if (declaredSa !== floorSa) {
        warnings.push({
          code: 'SENSOR_FLOOR_TOTAL_MISMATCH',
          detail: `階(${h.floorLabel})の「差動」の階合計(${declaredSa})が、各部屋の合計(${floorSa})と一致しません。原本のデータ品質を確認してください。`,
          row: h.row + 1,
          type: 'sa',
          declared: declaredSa,
          computed: floorSa,
        });
      }

      if (declaredTei === null) {
        warnings.push({
          code: 'SENSOR_FLOOR_TOTAL_MISSING',
          detail: `階(${h.floorLabel})の「定温」の階合計を読み取れませんでした(空欄または非数値)。0件と決め付けず、この階の定温については階合計との整合性チェックを行っていません。原本を確認してください。`,
          row: h.row + 1,
          type: 'tei',
        });
      } else if (declaredTei !== floorTei) {
        warnings.push({
          code: 'SENSOR_FLOOR_TOTAL_MISMATCH',
          detail: `階(${h.floorLabel})の「定温」の階合計(${declaredTei})が、各部屋の合計(${floorTei})と一致しません。原本のデータ品質を確認してください。`,
          row: h.row + 1,
          type: 'tei',
          declared: declaredTei,
          computed: floorTei,
        });
      }
    }
  }

  return { sensorMaster, warnings, floorTotals };
}

module.exports = {
  id: 'sensorCount.floorSummaryTextFormat.v1',
  label: '階合計テキスト形式(1フロア2行、部屋直下のセルに「差動N 定温M」を自由記述、左列に階合計)',
  detect,
  parse,
};

    })(module, exports, require);
    return module;
  })();

  __ffModules["formatParsers/sensorCount/labelValuePairGridFormatParser.js"] = (function () {
    var module = { exports: {} };
    var exports = module.exports;
    var require = function (spec) { return __ffRequire("formatParsers/sensorCount/labelValuePairGridFormatParser.js", spec); };
    (function (module, exports, require) {
// lib/formatParsers/sensorCount/labelValuePairGridFormatParser.js
//
// [2026-08-02新設] 感知器数(sensorCount)フォーマット「ラベル値ペアグリッド形式」用Parser。
//
// 2026-08-02、「グランアークス千里山」物件の実データ(感知器数.xlsx)で初めて確認した
// フォーマット。1フロア分のブロックが、
//   1行目(見出し行): 階ラベル(例:「8Ｆ」)と、その階の部屋番号が数値セルとして、
//     部屋間に空列を挟みながら並ぶ(例:801,802,803,...。他物件のような等間隔ではなく、
//     棟境目などで列の間隔が変わることがある)。
//   見出し行から数行下: 「差動」というラベル文字列のセルが部屋番号列の直後(+1列)に、
//     その値(個数)が更にその隣(+2列)に置かれた行(以下「差動行」)。
//   差動行の直後の行: 同様に「定温」ラベル(+1列)と値(+2列)が並ぶ行(以下「定温行」)。
// という構成で、tableFormat(1行1部屋・F/G列に数値)/floorGridFormat(丸数字+凡例)/
// floorSummaryTextFormat(見出し行の直下のセルに「差動N 定温M」を自由記述)の
// いずれとも異なる、「ラベルセルと値セルが対になって離れた場所にある」グリッド形式。
//
// 【今回発見した実データの特徴・注意点】
// - 複数棟(≪Ａ棟≫/≪Ｂ棟≫)にまたがるが、部屋番号自体は物件全体で一意なため、
//   棟をまたいだ名前空間の区別は現時点では不要(sensorMasterのキーは部屋番号のみ)。
// - 個数の値セルは数値型(例:7)と文字列型(例:'10')が混在している。Number()で
//   どちらも吸収する。
// - 801号室は「差動」「定温」のラベルセル自体はあるが、値セルが空白(未記入)という
//   実データ上のデータ欠落が見つかった(714号室も同様)。このParserは0を仮定して
//   黙って埋めるのではなく、SENSOR_VALUE_MISSING警告を出したうえで0として扱う
//   (値が存在しないことを呼び出し側が把握できるようにする)。
// - 低層階(1F〜3F)は住戸ではなく共用部(管理人室・電気室・集会室など)が部屋番号の
//   列位置を一部占めており、部屋番号セル自体が存在しない(=このParserの対象外、
//   欠番として扱われる)。これは仕様通りであり警告対象ではない。
'use strict';

// [他Parserと同じ規約] 全角数字を半角に正規化する。今回の実データは部屋番号が数値型
// セルのため必須ではないが、将来別物件で全角文字列の部屋番号が来た場合に備えて
// floorGridFormatParser.js / floorSummaryTextFormatParser.js と同じ正規化を適用する。
function zenkakuDigitsToHankaku(str) {
  return String(str).replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
}

const ROOM_NUMBER_PATTERN = /^\d{2,4}$/;
const FLOOR_LABEL_PATTERN = /^\d+\s*[FＦ階]$/;
const SA_LABEL_PATTERN = /^差動$/;
const TEI_LABEL_PATTERN = /^定温$/;

// 見出し行(階ラベル+部屋番号の並び)を探す。floorSummaryTextFormatParser.jsのfindHeaderRowsと
// 同じ考え方だが、こちらは「直下の行に個数テキストがある」ことを要求しない
// (このフォーマットでは値は数行下の別々のラベル行/値行にあるため)。
function findHeaderRows(grid) {
  const headerRows = [];
  for (let r = 0; r < (grid || []).length; r++) {
    const row = grid[r];
    if (!row) continue;
    const roomCols = [];
    let floorLabel = null;
    for (let c = 0; c < row.length; c++) {
      const v = row[c];
      if (v == null) continue;
      const str = zenkakuDigitsToHankaku(String(v).trim());
      if (FLOOR_LABEL_PATTERN.test(str)) {
        if (floorLabel === null) floorLabel = String(v).trim();
      } else if (ROOM_NUMBER_PATTERN.test(str)) {
        roomCols.push(c);
      }
    }
    if (floorLabel && roomCols.length > 0) headerRows.push({ row: r, roomCols, floorLabel });
  }
  return headerRows;
}

// 見出し行の下、指定したラベル文字列(「差動」/「定温」)がroomCols+1の位置に
// 一定数現れる行を探す(検索範囲は見出し行の直後から最大6行)。
function findLabelRow(grid, headerRow, roomCols, labelPattern, searchStartOffset) {
  const SEARCH_WINDOW = 6;
  for (let offset = searchStartOffset; offset <= SEARCH_WINDOW; offset++) {
    const r = headerRow.row + offset;
    const row = grid[r];
    if (!row) continue;
    let hits = 0;
    for (const c of roomCols) {
      const v = row[c + 1];
      if (v != null && labelPattern.test(String(v).trim())) hits++;
    }
    if (hits > 0 && hits >= Math.ceil(roomCols.length * 0.3)) {
      return { row: r, hits };
    }
  }
  return null;
}

function toNumberOrNull(v) {
  if (v == null || String(v).trim() === '') return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

function detect(grid) {
  if (!Array.isArray(grid)) return { matches: false, confidence: 0 };
  const headerRows = findHeaderRows(grid);
  if (headerRows.length === 0) return { matches: false, confidence: 0, reason: '階ラベル+部屋番号の見出し行が見つからない' };

  let blocksWithPair = 0;
  let totalRoomHits = 0;
  let totalRoomCols = 0;
  for (const h of headerRows) {
    totalRoomCols += h.roomCols.length;
    const saRow = findLabelRow(grid, h, h.roomCols, SA_LABEL_PATTERN, 1);
    if (!saRow) continue;
    const teiRow = findLabelRow(grid, h, h.roomCols, TEI_LABEL_PATTERN, saRow.row - h.row + 1);
    if (!teiRow) continue;
    blocksWithPair++;
    totalRoomHits += Math.max(saRow.hits, teiRow.hits);
  }
  if (blocksWithPair === 0) {
    return { matches: false, confidence: 0, reason: '見出し行の数行下に「差動」「定温」ラベルセルのペアが見つからない' };
  }

  const confidence = 0.5 + 0.4 * (totalRoomHits / Math.max(1, totalRoomCols)) + 0.1 * (blocksWithPair / headerRows.length);
  return {
    matches: true,
    confidence: Math.min(0.97, confidence),
    reason: `見出し行${headerRows.length}件中${blocksWithPair}件で「差動」「定温」ラベル行のペア(値は部屋列+2列)を検出`,
  };
}

function parse(grid) {
  const warnings = [];
  const headerRows = findHeaderRows(grid);
  const sensorMaster = {};

  for (const h of headerRows) {
    const saRow = findLabelRow(grid, h, h.roomCols, SA_LABEL_PATTERN, 1);
    const teiRow = saRow ? findLabelRow(grid, h, h.roomCols, TEI_LABEL_PATTERN, saRow.row - h.row + 1) : null;

    if (!saRow || !teiRow) {
      warnings.push({
        code: 'SENSOR_LABEL_ROW_MISSING',
        detail: `階見出し行(${h.floorLabel})の下に「差動」「定温」ラベル行のペアが見つかりません。`,
        row: h.row,
      });
      continue;
    }

    for (const c of h.roomCols) {
      const roomStr = zenkakuDigitsToHankaku(String(grid[h.row][c]).trim());
      const saLabelCell = grid[saRow.row][c + 1];
      const teiLabelCell = grid[teiRow.row][c + 1];
      const saLabelOk = saLabelCell != null && SA_LABEL_PATTERN.test(String(saLabelCell).trim());
      const teiLabelOk = teiLabelCell != null && TEI_LABEL_PATTERN.test(String(teiLabelCell).trim());

      if (!saLabelOk && !teiLabelOk) {
        // このroom列には差動/定温いずれのラベルも無い(見出し行にだけ部屋番号があり、
        // 実際は該当なしの可能性)。データが無いことを黙って0扱いにせず、警告で明示する。
        warnings.push({
          code: 'SENSOR_LABEL_ROW_MISSING',
          detail: `部屋${roomStr}(${h.floorLabel})の列に「差動」「定温」ラベルが見つかりません。`,
          row: h.row,
          room: roomStr,
        });
        continue;
      }

      const saValRaw = saLabelOk ? grid[saRow.row][c + 2] : null;
      const teiValRaw = teiLabelOk ? grid[teiRow.row][c + 2] : null;
      const saVal = toNumberOrNull(saValRaw);
      const teiVal = toNumberOrNull(teiValRaw);

      // [2026-08-03修正、Phase2①.6] 従来は値セルが空白の場合、警告こそ出していたものの
      // 「(0として扱います)」と明記した上で実際にsensorMasterへ0を格納していた(警告と
      // 実データの扱いが矛盾していた)。ご指示により「解析不能を0へ変換しない」を
      // Parser共通の設計原則として統一するため、0で補完せずnull(未確認)のまま保持する
      // よう修正した。
      if (saVal === null) {
        warnings.push({
          code: 'SENSOR_VALUE_MISSING',
          detail: `部屋${roomStr}(${h.floorLabel})の「差動」の値セルが空白です。0件と決め付けず未確認のまま保持しています。原本を確認してください。`,
          row: saRow.row,
          room: roomStr,
          type: 'sa',
        });
      }
      if (teiVal === null) {
        warnings.push({
          code: 'SENSOR_VALUE_MISSING',
          detail: `部屋${roomStr}(${h.floorLabel})の「定温」の値セルが空白です。0件と決め付けず未確認のまま保持しています。原本を確認してください。`,
          row: teiRow.row,
          room: roomStr,
          type: 'tei',
        });
      }

      sensorMaster[roomStr] = { sa: saVal, tei: teiVal };
    }
  }

  return { sensorMaster, warnings };
}

module.exports = {
  id: 'sensorCount.labelValuePairGridFormat.v1',
  label: 'ラベル値ペアグリッド形式(見出し行の部屋番号列+1に「差動」/「定温」ラベル、+2列にその値)',
  detect,
  parse,
};

    })(module, exports, require);
    return module;
  })();

  __ffModules["formatParsers/sensorCount/totalOnlyGridFormatParser.js"] = (function () {
    var module = { exports: {} };
    var exports = module.exports;
    var require = function (spec) { return __ffRequire("formatParsers/sensorCount/totalOnlyGridFormatParser.js", spec); };
    (function (module, exports, require) {
// lib/formatParsers/sensorCount/totalOnlyGridFormatParser.js
//
// [2026-08-02新設] 感知器数(sensorCount)フォーマット「合計数のみグリッド形式」用Parser。
//
// 2026-08-02、「グランディア香里園山の手」物件の実データ(感知器数（グランディア香里園山の手）.xls)
// で初めて確認したフォーマット。捺印表やfloorGridFormat/labelValuePairGridFormatと同じ
// 「フロアごとのブロックに部屋番号が並ぶ」レイアウトだが、各部屋番号の直下(見出し行の
// 1行下・同じ列)に丸数字(①〜⑳)が1個だけ置かれており、凡例行(「感知器：...」)は
// 一切存在しない。
//
// 点検結果報告書側(№1〜5シート、「共同住宅用自動火災報知設備（その4）」)と実際に
// 突き合わせたところ、この丸数字は差動式/定温式の「種別」を表すのではなく、
// その部屋に設置されている感知器の「合計数」(差動式+定温式+その他の合計)であることが
// 確認できた(例: 101号室はfloorGridの丸数字が⑥=6、点検結果報告書側では差動5・定温1で
// 合計6と一致)。
//
// 【ご本人確認済みの方針(2026-08-02)】
// この物件については感知器数ファイルのみを対応範囲とする(点検結果報告書側の内訳取得は
// 別作業として将来対応)。感知器数ファイルには種別の内訳が無いため、このParserは
// sensorMasterの sa/tei を種別不明として扱い、合計数だけを total フィールドに格納する。
// 「内訳が無いのに0/0と決め付けて種別ごとの数値を捏造する」ことは絶対に行わない
// (他のParserと同じ、黙って0を仮定しない方針を踏襲)。
'use strict';

function zenkakuDigitsToHankaku(str) {
  return String(str).replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
}

// [2026-08-02追加] 「コスモフォレスタ箕面」の実データで、部屋番号セルが文字列ではなく
// 数値型(しかも、Excel内の何らかの計算式に由来すると思われる浮動小数点誤差付き、例:
// 912.000000000003)で入っていることが分かった。String(912.000000000003)は
// "912.000000000003"となり既存の正規表現に一致しないため、数値セルは四捨五入して
// 整数との差が十分小さい場合のみ、その整数を部屋番号文字列とみなす変換を追加する。
function cellToRoomNumberString(v) {
  if (v == null) return null;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return null;
    const rounded = Math.round(v);
    if (Math.abs(v - rounded) > 0.01) return null;
    const str = String(rounded);
    return ROOM_NUMBER_PATTERN.test(str) ? str : null;
  }
  const str = zenkakuDigitsToHankaku(String(v).trim());
  return ROOM_NUMBER_PATTERN.test(str) ? str : null;
}

const ROOM_NUMBER_PATTERN = /^\d{2,4}$/;
const FLOOR_LABEL_PATTERN = /^\d+\s*[FＦ階]$/;
const CIRCLED_NUMBERS = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩', '⑪', '⑫', '⑬', '⑭', '⑮', '⑯', '⑰', '⑱', '⑲', '⑳'];
const CIRCLED_NUMBER_PATTERN = /^[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳]$/;

function circledNumberToInt(ch) {
  const idx = CIRCLED_NUMBERS.indexOf(ch);
  return idx === -1 ? null : idx + 1;
}

// 単独行に階ラベルだけが書かれている場合、そのラベル文字列を返す(見つからなければnull)。
function findLoneFloorLabel(row) {
  if (!row) return null;
  for (const v of row) {
    if (v != null && FLOOR_LABEL_PATTERN.test(zenkakuDigitsToHankaku(String(v).trim()))) return String(v).trim();
  }
  return null;
}

function rowHasRoomNumber(row) {
  if (!row) return false;
  for (const v of row) {
    if (cellToRoomNumberString(v) != null) return true;
  }
  return false;
}

// [2026-08-02追加] 「グランプレイズ宝塚南口」の実データで、階ラベルが部屋番号の行より
// 前ではなく、部屋番号行→丸数字行→空白行の3行分「後ろ」に単独で書かれている
// (階ラベルがそのブロックの見出しではなく「締めくくり」として機能する)レイアウトが
// 見つかった(例: 「11Ｆ」という行の直後に来るのは実は10Fの部屋番号1001〜1005で、
// 「11Ｆ」は1つ前のブロック(1101〜1105)の締めくくりラベルだった)。既存の
// 「グランディア香里園山の手」は階ラベルと部屋番号が同じ行の2行1ブロックだった。
// 丸数字1個=合計数・凡例なしという値の意味自体は完全に同じフォーマットのため、新Parserは
// 追加せず、部屋番号行の数行下に単独の階ラベルが無いか探す(ただし次の部屋番号行に
// 到達したら、そのブロックのラベルは見つからなかったものとして探索を打ち切る)形で
// このParserに吸収した。
function findFooterFloorLabel(grid, roomRowIndex) {
  const SEARCH_WINDOW = 5;
  for (let offset = 1; offset <= SEARCH_WINDOW; offset++) {
    const row = grid[roomRowIndex + offset];
    if (!row) break;
    if (rowHasRoomNumber(row)) break; // 次のブロックに到達 → このブロックのラベルは無い
    const label = findLoneFloorLabel(row);
    if (label) return label;
  }
  return null;
}

function findHeaderRows(grid) {
  const headerRows = [];
  for (let r = 0; r < (grid || []).length; r++) {
    const row = grid[r];
    if (!row) continue;
    const roomCols = [];
    let floorLabel = null;
    for (let c = 0; c < row.length; c++) {
      const v = row[c];
      if (v == null) continue;
      if (typeof v !== 'number' && FLOOR_LABEL_PATTERN.test(zenkakuDigitsToHankaku(String(v).trim()))) {
        if (floorLabel === null) floorLabel = String(v).trim();
        continue;
      }
      if (cellToRoomNumberString(v) != null) roomCols.push(c);
    }
    if (roomCols.length === 0) continue;
    let effectiveFloorLabel = floorLabel || findFooterFloorLabel(grid, r);
    // [2026-08-02追加] 「コスモフォレスタ箕面」の実データで、階ラベルが同じ行にも
    // 後方(フッター位置)にも一切存在しない(階は部屋番号の先頭桁から類推するしかない)
    // レイアウトが見つかった。丸数字1個=合計数という値の意味自体は完全に同じであり、
    // 既存の「同じ行」「フッター位置」に続く3つ目の階ラベル位置バリエーションとして、
    // 新Parserは追加せずこのParserで吸収する。ただし階ラベルが全く無い分、誤検出を
    // 避けるため、部屋番号が2件以上ある行に限定する(roomOnlyPairRowsFormatParserの
    // 「階ラベル無し」判定と同じ安全策)。
    if (!effectiveFloorLabel && roomCols.length >= 2) {
      effectiveFloorLabel = null; // 明示的に「不明」として扱う(nullのまま、捏造しない)
      headerRows.push({ row: r, roomCols, floorLabel: null });
      continue;
    }
    if (effectiveFloorLabel) headerRows.push({ row: r, roomCols, floorLabel: effectiveFloorLabel });
  }
  return headerRows;
}

function hasAnyLegendLine(grid) {
  for (const row of grid || []) {
    if (!row) continue;
    for (const cell of row) {
      if (cell != null && /感知器[:：]\s*(.+)/.test(String(cell).trim())) return true;
    }
  }
  return false;
}

function detect(grid) {
  if (!Array.isArray(grid)) return { matches: false, confidence: 0 };
  const headerRows = findHeaderRows(grid);
  if (headerRows.length === 0) return { matches: false, confidence: 0, reason: '階ラベル+部屋番号の見出し行が見つからない' };

  let totalRoomCols = 0;
  let alignedSymbolHits = 0;
  for (const h of headerRows) {
    const valueRow = grid[h.row + 1];
    if (!valueRow) continue;
    for (const c of h.roomCols) {
      totalRoomCols++;
      const v = valueRow[c];
      if (v != null && CIRCLED_NUMBER_PATTERN.test(String(v).trim())) alignedSymbolHits++;
    }
  }
  if (alignedSymbolHits === 0) {
    return { matches: false, confidence: 0, reason: '見出し行の直下・同じ列に丸数字(①〜⑳)のセルが見つからない' };
  }

  // 凡例(「感知器：...」)が存在する場合は、種別を解決できるfloorGridFormatである可能性が
  // 高いため、このParserの確信度は下げる(floorGridFormatParser側も、凡例が無い場合は
  // 自身の確信度を0にする対称的な仕分けにしてあるので、通常は競合しない)。
  const legendPresent = hasAnyLegendLine(grid);
  let confidence = 0.5 + 0.4 * (alignedSymbolHits / Math.max(1, totalRoomCols));
  if (legendPresent) confidence -= 0.3;
  confidence = Math.max(0, Math.min(0.95, confidence));

  return {
    matches: confidence > 0,
    confidence,
    reason: `見出し行${headerRows.length}件・部屋${totalRoomCols}件中${alignedSymbolHits}件で、直下・同じ列に丸数字1個(合計数)を検出(凡例行: ${legendPresent ? 'あり' : 'なし'})`,
  };
}

// [2026-08-02追加] 「コスモフォレスタ箕面」の実データのシート内に、作成者自身による
// 「感知器数、再確認して下さい。」という注記が見つかった。原本自体が数値の確度に
// 自信が無いと明言しているため、これを見逃さずwarningsとして呼び出し側に伝える
// (グランドハイツ魚崎で「データが揃いきっていない」という原本注記をwarningsに
// 含めた前例を踏襲)。
const SOURCE_UNCONFIRMED_NOTE_PATTERN = /感知器数.{0,4}再確認/;
function findSourceUnconfirmedNote(grid) {
  for (const row of grid || []) {
    if (!row) continue;
    for (const v of row) {
      if (v != null && SOURCE_UNCONFIRMED_NOTE_PATTERN.test(String(v))) return String(v).trim();
    }
  }
  return null;
}

function parse(grid) {
  const warnings = [];
  const headerRows = findHeaderRows(grid);
  const sensorMaster = {};

  if (!hasAnyLegendLine(grid)) {
    warnings.push({
      code: 'SENSOR_TYPE_BREAKDOWN_UNAVAILABLE',
      detail: 'このファイルには部屋ごとの丸数字(合計数)しか記載されておらず、差動式/定温式などの種別内訳はありません。sa/teiはnull(不明)とし、totalにのみ実際の値を格納しています。内訳が必要な場合は点検結果報告書側(別ドキュメント種別、今回は未対応)を参照してください。',
    });
  }

  const sourceUnconfirmedNote = findSourceUnconfirmedNote(grid);
  if (sourceUnconfirmedNote) {
    warnings.push({
      code: 'SENSOR_SOURCE_DATA_UNCONFIRMED',
      detail: `シート内に原本作成者自身による「${sourceUnconfirmedNote}」という注記があり、この感知器数データの確度について原本側も確認中であることを示しています。`,
    });
  }

  for (const h of headerRows) {
    const floorLabelText = h.floorLabel || '階ラベル不明';
    const valueRow = grid[h.row + 1];
    if (!valueRow) {
      warnings.push({ code: 'SENSOR_COUNT_ROW_MISSING', detail: `階見出し行(${floorLabelText})の直下に合計数の行が見つかりません。`, row: h.row });
      continue;
    }
    for (const c of h.roomCols) {
      const roomStr = cellToRoomNumberString(grid[h.row][c]);
      if (roomStr == null) continue;
      const cellValue = valueRow[c];
      if (cellValue == null || !CIRCLED_NUMBER_PATTERN.test(String(cellValue).trim())) {
        warnings.push({
          code: 'SENSOR_VALUE_MISSING',
          detail: `部屋${roomStr}(${floorLabelText})の直下に丸数字(合計数)が見つかりません(自由記述のメモ等が入っている可能性があります)。`,
          row: h.row + 1,
          room: roomStr,
        });
        continue;
      }
      const total = circledNumberToInt(String(cellValue).trim());
      // sa/teiは種別内訳が無いため意図的にnullとする(0を仮定して捏造しない)。
      sensorMaster[roomStr] = { sa: null, tei: null, total };
    }
  }

  return { sensorMaster, warnings };
}

module.exports = {
  id: 'sensorCount.totalOnlyGridFormat.v1',
  label: '合計数のみグリッド形式(部屋番号の直下・同じ列に丸数字1個=感知器の合計数、種別内訳なし)',
  detect,
  parse,
};

    })(module, exports, require);
    return module;
  })();

  __ffModules["formatParsers/sensorCount/roomOnlyPairRowsFormatParser.js"] = (function () {
    var module = { exports: {} };
    var exports = module.exports;
    var require = function (spec) { return __ffRequire("formatParsers/sensorCount/roomOnlyPairRowsFormatParser.js", spec); };
    (function (module, exports, require) {
// lib/formatParsers/sensorCount/roomOnlyPairRowsFormatParser.js
//
// [2026-08-02新設] 感知器数(sensorCount)フォーマット「部屋番号のみペア行形式」用Parser。
//
// 2026-08-02、「グランディア緑地公園」物件の実データ(感知器数.xlsx)で初めて確認した
// フォーマット。1つの階のブロックが2行(部屋番号の行+その直下に各部屋の「差動N・定温M」
// 自由記述テキストが並ぶ行)で構成される点は既存のfloorSummaryTextFormat(アービング塚本等)
// と似ているが、決定的に違うのは「階ラベル(「7Ｆ」等のテキスト)が一切無い」こと。
// 部屋番号だけがそのままシートの左端の列から並んでおり(例:「601 602 603 604 605 606 607」)、
// 階は部屋番号の百の位から推測することはできても、シート上に階ラベルの文字列としては
// 存在しない。また、階ごとの合計セルも無い(合計との整合性チェックはできない)。
//
// 【既存Parserとの取り違えに関する注意】
// floorSummaryTextFormatParserは階ラベルのテキストが無いと見出し行と認識しないため、
// このデータには反応しない(誤判定しない)。一方、tableFormatParser(1行1部屋・B列=部屋番号・
// F/G列=数値の差動/定温)は、たまたまB列に部屋番号が来た行を拾ってしまい、その行の
// 別の列にある「別の部屋番号」を差動/定温の個数と誤読する事故が実際に発生した
// (2026-08-02、この物件の対応時にtableFormatParser.detect()へ「同じ行の他列にも
// 部屋番号らしき値が並ぶ場合は確信度を0にする」というガードを追加して修正済み)。
'use strict';

const ROOM_NUMBER_PATTERN = /^\d{2,4}$/;
const SA_PATTERN = /差動\s*(\d+)/g;
const TEI_PATTERN = /定温\s*(\d+)/g;

function zenkakuDigitsToHankaku(str) {
  return String(str).replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
}

function lastMatchNumber(text, pattern) {
  pattern.lastIndex = 0;
  let m;
  let last = null;
  while ((m = pattern.exec(text)) !== null) {
    last = Number(m[1]);
  }
  return last;
}

// セルのテキストから{sa, tei}を抽出する。どちらも見つからなければnullを返す
// (「感知器の記載が無いセル」と「0個と明記されたセル」を区別するため、0を仮定しない)。
// [2026-08-03修正、Phase2①.6] 従来はsa/teiの一方だけ見つかった場合、見つからなかった方を
// 0として返していた(例:「差動6」のみのセルはtei:0になっていた)。ご指示により
// 「解析不能を0へ変換しない」をParser共通の設計原則として統一するため、見つからなかった方は
// 0で補完せずnull(未確認)のまま返すよう修正した。
function extractCount(cellValue) {
  if (cellValue == null) return null;
  const text = String(cellValue);
  const sa = lastMatchNumber(text, SA_PATTERN);
  const tei = lastMatchNumber(text, TEI_PATTERN);
  if (sa === null && tei === null) return null;
  return { sa: sa, tei: tei };
}

// 「部屋番号だけが2個以上並ぶ行」を見出し行の候補として集める(階ラベルは要求しない)。
function findRoomHeaderRows(grid) {
  const headerRows = [];
  for (let r = 0; r < (grid || []).length; r++) {
    const row = grid[r];
    if (!row) continue;
    const roomCols = [];
    for (let c = 0; c < row.length; c++) {
      const v = row[c];
      if (v == null) continue;
      const str = zenkakuDigitsToHankaku(String(v).trim());
      if (ROOM_NUMBER_PATTERN.test(str)) roomCols.push(c);
    }
    // 1個だけだと単なる番号セル(例: IDや管理番号)との誤判定リスクがあるため、
    // 同じ行に2個以上部屋番号らしき値が並ぶことを条件にする。
    if (roomCols.length >= 2) headerRows.push({ row: r, roomCols });
  }
  return headerRows;
}

function detect(grid) {
  if (!Array.isArray(grid)) return { matches: false, confidence: 0 };
  const headerRows = findRoomHeaderRows(grid);
  if (headerRows.length === 0) return { matches: false, confidence: 0, reason: '部屋番号が2個以上並ぶ行が見つからない' };

  let pairedRows = 0;
  let roomsWithCount = 0;
  let totalRoomCols = 0;
  let roomsWithParenSubcount = 0;
  for (const h of headerRows) {
    const countRow = grid[h.row + 1];
    if (!countRow) continue;
    let anyCount = false;
    for (const c of h.roomCols) {
      totalRoomCols++;
      const cellValue = countRow[c];
      if (extractCount(cellValue)) {
        anyCount = true;
        roomsWithCount++;
        // [2026-08-02追加] 「グランドハイツ魚崎」の実データで、括弧の中にも差動/定温の
        // 数字が入っているセルが見つかった(floorSummaryTextFormatParser.jsに追加した
        // ガードと同じ理由。詳細はfloorFormatWithConfirmedSubcountParser.jsのコメント参照)。
        const parenMatch = String(cellValue).match(/[\(（]([^\)）]*)[\)）]/);
        if (parenMatch && (/差動\s*\d+/.test(parenMatch[1]) || /定温\s*\d+/.test(parenMatch[1]))) {
          roomsWithParenSubcount++;
        }
      }
    }
    if (anyCount) pairedRows++;
  }
  if (pairedRows === 0) return { matches: false, confidence: 0, reason: '部屋番号の行の直下に「差動」「定温」を含むテキストが見つからない' };

  if (roomsWithCount > 0 && roomsWithParenSubcount / roomsWithCount >= 0.3) {
    return {
      matches: false,
      confidence: 0,
      reason: `個数セル${roomsWithCount}件中${roomsWithParenSubcount}件で括弧内にも差動/定温の数字が入っており、主値+確認灯付き内訳が併記される別形式(floorFormatWithConfirmedSubcount)の可能性が高いため、この形式とは判定しない`,
    };
  }

  const confidence = 0.5 + 0.4 * (roomsWithCount / Math.max(1, totalRoomCols));
  return {
    matches: true,
    confidence: Math.min(0.95, confidence),
    reason: `部屋番号の行${headerRows.length}件中${pairedRows}件で直下に「差動/定温」テキストを検出(部屋${roomsWithCount}/${totalRoomCols}件、階ラベルは無し)`,
  };
}

function parse(grid) {
  const warnings = [];
  const headerRows = findRoomHeaderRows(grid);
  const sensorMaster = {};

  for (const h of headerRows) {
    const countRow = grid[h.row + 1];
    if (!countRow) {
      warnings.push({ code: 'SENSOR_COUNT_ROW_MISSING', detail: `部屋番号の行(行${h.row})の直下に個数の行が見つかりません。`, row: h.row });
      continue;
    }
    for (const c of h.roomCols) {
      const roomStr = zenkakuDigitsToHankaku(String(grid[h.row][c]).trim());
      const cellValue = countRow[c];
      // [2026-08-03追加、Phase2①.6] セルが空欄、または「差動」「定温」いずれの記載も
      // 見つからない(自由記述等)場合、従来は当該部屋を丸ごと読み飛ばし(sensorMasterに
      // エントリを作らず、警告も出さない)でいた。「解析不能の場合は必ずwarningsを付ける」
      // という方針に沿って、sa:null,tei:nullのエントリを作った上でSENSOR_VALUE_MISSING
      // 警告を出すよう修正した。
      if (cellValue == null) {
        sensorMaster[roomStr] = { sa: null, tei: null };
        warnings.push({
          code: 'SENSOR_VALUE_MISSING',
          detail: `部屋${roomStr}(行${h.row + 1}): 個数のセルが空欄のため、差動式・定温式とも件数を確定できません。0件と決め付けず未確認のまま保持しています。原本を確認してください。`,
          row: h.row + 1, room: roomStr,
        });
        continue;
      }
      const count = extractCount(cellValue);
      if (!count) {
        sensorMaster[roomStr] = { sa: null, tei: null };
        warnings.push({
          code: 'SENSOR_VALUE_MISSING',
          detail: `部屋${roomStr}(行${h.row + 1}): セルに「差動」「定温」いずれの記載も見つかりません(セルの内容: ${JSON.stringify(cellValue)})。0件と決め付けず未確認のまま保持しています。原本を確認してください。`,
          row: h.row + 1, room: roomStr,
        });
        continue;
      }
      sensorMaster[roomStr] = { sa: count.sa, tei: count.tei };
      if (count.sa === null) {
        warnings.push({
          code: 'SENSOR_VALUE_MISSING',
          detail: `部屋${roomStr}(行${h.row + 1}): 「差動」の件数の記載が見つかりません(定温のみ記載)。0件と決め付けず未確認のまま保持しています。原本を確認してください。`,
          row: h.row + 1, room: roomStr, type: 'sa',
        });
      }
      if (count.tei === null) {
        warnings.push({
          code: 'SENSOR_VALUE_MISSING',
          detail: `部屋${roomStr}(行${h.row + 1}): 「定温」の件数の記載が見つかりません(差動のみ記載)。0件と決め付けず未確認のまま保持しています。原本を確認してください。`,
          row: h.row + 1, room: roomStr, type: 'tei',
        });
      }
    }
  }

  // このフォーマットには階合計セルが無いため、floorSummaryTextFormatのような
  // 階合計との整合性チェックはできない(捏造しないという原則に従い、行わない)。
  return { sensorMaster, warnings };
}

module.exports = {
  id: 'sensorCount.roomOnlyPairRowsFormat.v1',
  label: '部屋番号のみペア行形式(階ラベル無し、部屋番号の行+直下に「差動N・定温M」を自由記述、階合計なし)',
  detect,
  parse,
};

    })(module, exports, require);
    return module;
  })();

  __ffModules["formatParsers/sensorCount/floorFormatWithConfirmedSubcountParser.js"] = (function () {
    var module = { exports: {} };
    var exports = module.exports;
    var require = function (spec) { return __ffRequire("formatParsers/sensorCount/floorFormatWithConfirmedSubcountParser.js", spec); };
    (function (module, exports, require) {
// lib/formatParsers/sensorCount/floorFormatWithConfirmedSubcountParser.js
//
// [2026-08-02新設] 感知器数(sensorCount)フォーマット「階グリッド+確認灯付き内訳形式」用Parser。
//
// 2026-08-02、「グランドハイツ魚崎」物件の実データ(感知器数.xlsx「感知器個数」シート)で
// 初めて確認したフォーマット。階ラベル(例:「9  F」)+部屋番号の見出し行、その直下に
// 各部屋の個数が並ぶ2行1ブロックという骨格は既存のfloorSummaryTextFormat(アービング塚本等)
// と同じだが、各セルの中身が「差動5定温3　(差動2定温0)」のように、括弧の外と中で
// 2種類の数字が並ぶ点が決定的に違う。シート内の注記(「・赤文字は設置感知器個数です。
// （　）内は、確認灯がついてる感知器個数です。」)により、括弧の外=設置されている感知器の
// 総数、括弧の中=そのうち確認灯が点いている(=実際に動作確認できた)個数、という別々の
// 意味を持つことが分かっている。
//
// 【重要な設計判断(2026-08-02、ご本人確認済み)】
// 実データでは括弧の外と中の数字が111セル中85セル(8割)で一致しておらず、シート自体にも
// 「データが揃いきっていない(正確な数も含めて)ので確認と記載のご協力お願いします」という
// 注記があり、未確定のデータであることが分かっている。ユーザーに確認のうえ、
// sensorMaster(sa/tei)には括弧の外(設置感知器個数)を主値として採用し、括弧の中
// (確認灯付き個数)は`confirmedWithLight`という別フィールドに保持する(捨てない)方針とした。
//
// 【既存Parserとの衝突に関する重要な注意】
// このデータをfloorSummaryTextFormatParser(既存)にそのまま解析させると、正規表現が
// セル全体から「最後にマッチした差動/定温の数字」を拾う仕様のため、括弧の中(確認灯付き
// 個数、意味の違う別の数字)を誤ってsa/teiとして返してしまう事故が実際に発生することを
// 確認した(例: 973号室で本来sa=5/tei=3のところ、sa=2/tei=0という誤った値を返す)。
// この事故を防ぐため、floorSummaryTextFormatParser・roomOnlyPairRowsFormatParserの両方に
// 「括弧の中にも差動/定温の数字が入っているセルが一定割合を超える場合は、この形式では
// ないと判断して確信度を0にする」というガードを追加し、このParserに自動判定を譲るように
// した。
'use strict';

const ROOM_NUMBER_PATTERN = /^\d{2,4}$/;
const FLOOR_LABEL_PATTERN = /^\d+\s*[FＦ階]$/;
const SA_PATTERN = /差動[\s.]*(\d+)/;
const TEI_PATTERN = /定温[\s.]*(\d+)/;

function zenkakuDigitsToHankaku(str) {
  return String(str).replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
}

// セルのテキストを「括弧の外(主値)」と「括弧の中(確認灯付き個数)」に分割する。
// 括弧が無ければ主値のみ、括弧内が無ければconfirmedはnullのまま。
function splitMainAndParen(text) {
  const parenMatch = text.match(/[\(（]([^\)）]*)[\)）]/);
  const mainPart = parenMatch ? text.slice(0, parenMatch.index) : text;
  const parenPart = parenMatch ? parenMatch[1] : null;
  return { mainPart, parenPart };
}

// [2026-08-03修正] 従来は「差動」「定温」のどちらか一方しかtextから読み取れなかった場合
// (例:「差動4・定温6　　　　(差動0・1)」の括弧内のように、片方だけ明確なラベル付きで
// 書かれ、もう片方は数字だけで種別が特定できない場合)、読み取れなかった側を0として
// 返していた。これは「確認済みの0件」と「記載はあるが読み取れなかった/未確認」を
// 区別できず、商用運用上の誤認リスクがあるとしてPhase2①.5で修正対象と判断された
// (ユーザー指示、2026-08-03)。sa/teiは独立に判定し、読み取れなかった側はnullのまま返す
// (0で補完しない)。
function extractSaTei(text) {
  if (text == null) return null;
  // [2026-08-02追加] 括弧の中(確認灯付き個数)の数字が全角(例:「（差動０・定温０）」)で
  // 書かれているセルが実データで見つかった。JSの正規表現の\dは全角数字にマッチしない
  // ため、他Parserと同じzenkakuDigitsToHankaku()を通してから照合する。
  const normalized = zenkakuDigitsToHankaku(String(text));
  const saM = normalized.match(SA_PATTERN);
  const teiM = normalized.match(TEI_PATTERN);
  if (!saM && !teiM) return null;
  return { sa: saM ? Number(saM[1]) : null, tei: teiM ? Number(teiM[1]) : null };
}

// セル全体から{ sa, tei, confirmedWithLight: {sa, tei}|null, blank, unresolved, rawText }
// を抽出する。括弧の外(主値)と中(確認灯付き個数)を別々に正規表現で読むことで、括弧の中の
// 数字を誤って主値として拾わないようにする(既存parser群の「セル全体から最後の一致を拾う」
// 方式だと、この形式では括弧の中の別の意味の数字を誤って主値にしてしまうため)。
// [2026-08-03修正] 従来はセルが空欄、または「差動」「定温」いずれの記載も見つからない
// (自由記述のメモ等)場合、呼び出し側でその部屋列を丸ごと読み飛ばし(sensorMasterに
// エントリ自体を作らず)、警告も出していなかった。これは「セルが空欄・解析不能」の場合に
// 必ずwarningsを付けるという方針に反するため、blank/unresolvedの状態を呼び出し側へ
// 明示的に伝えるように変更した(呼び出し側でsa:null,tei:nullのエントリ+warningを作る)。
function extractCell(cellValue) {
  if (cellValue == null) return { sa: null, tei: null, confirmedWithLight: null, blank: true };
  const text = String(cellValue);
  const { mainPart, parenPart } = splitMainAndParen(text);
  const main = extractSaTei(mainPart);
  const confirmed = parenPart != null ? extractSaTei(parenPart) : null;
  if (!main) {
    return { sa: null, tei: null, confirmedWithLight: confirmed, unresolved: true, rawText: text };
  }
  return { sa: main.sa, tei: main.tei, confirmedWithLight: confirmed };
}

function findHeaderRows(grid) {
  const headerRows = [];
  for (let r = 0; r < (grid || []).length; r++) {
    const row = grid[r];
    if (!row) continue;
    const roomCols = [];
    let floorLabel = null;
    for (let c = 0; c < row.length; c++) {
      const v = row[c];
      if (v == null) continue;
      const str = String(v).trim();
      if (FLOOR_LABEL_PATTERN.test(zenkakuDigitsToHankaku(str))) {
        if (floorLabel === null) floorLabel = str;
      } else if (ROOM_NUMBER_PATTERN.test(zenkakuDigitsToHankaku(str))) {
        roomCols.push(c);
      }
    }
    if (floorLabel && roomCols.length > 0) headerRows.push({ row: r, roomCols, floorLabel });
  }
  return headerRows;
}

// このParser特有の判定材料: 括弧の中にも差動/定温の数字が入っているセルの割合。
// この割合が高ければ「主値と確認灯付き内訳が併記される形式」であると強く言える。
function measureParenSubcountRatio(grid, headerRows) {
  let cellsWithCount = 0;
  let cellsWithParenSubcount = 0;
  for (const h of headerRows) {
    const countRow = grid[h.row + 1];
    if (!countRow) continue;
    for (const c of h.roomCols) {
      const v = countRow[c];
      if (v == null) continue;
      const text = String(v);
      const { mainPart, parenPart } = splitMainAndParen(text);
      if (!extractSaTei(mainPart)) continue;
      cellsWithCount++;
      if (parenPart != null && extractSaTei(parenPart)) cellsWithParenSubcount++;
    }
  }
  return { cellsWithCount, cellsWithParenSubcount, ratio: cellsWithCount > 0 ? cellsWithParenSubcount / cellsWithCount : 0 };
}

function detect(grid) {
  if (!Array.isArray(grid)) return { matches: false, confidence: 0 };
  const headerRows = findHeaderRows(grid);
  if (headerRows.length === 0) return { matches: false, confidence: 0, reason: '階ラベル+部屋番号の見出し行が見つからない' };

  const { cellsWithCount, cellsWithParenSubcount, ratio } = measureParenSubcountRatio(grid, headerRows);
  if (cellsWithCount === 0) return { matches: false, confidence: 0, reason: '見出し行の直下に「差動」「定温」を含むテキストが見つからない' };
  if (ratio < 0.3) {
    return {
      matches: false,
      confidence: 0,
      reason: `個数セル${cellsWithCount}件中、括弧内にも差動/定温の数字が入っているセルは${cellsWithParenSubcount}件(${Math.round(ratio * 100)}%)にとどまり、主値+確認灯付き内訳が併記される形式とは判断しない`,
    };
  }

  const confidence = Math.min(0.95, 0.6 + 0.35 * ratio);
  return {
    matches: true,
    confidence,
    reason: `個数セル${cellsWithCount}件中${cellsWithParenSubcount}件(${Math.round(ratio * 100)}%)で括弧内にも差動/定温の数字があり、主値(括弧外)+確認灯付き内訳(括弧内)が併記される形式と判断`,
  };
}

function parse(grid) {
  const warnings = [];
  const headerRows = findHeaderRows(grid);
  const sensorMaster = {};

  for (const h of headerRows) {
    const countRow = grid[h.row + 1];
    if (!countRow) {
      warnings.push({ code: 'SENSOR_COUNT_ROW_MISSING', detail: `階見出し行(${h.floorLabel})の直下に個数の行が見つかりません。`, row: h.row });
      continue;
    }
    for (const c of h.roomCols) {
      const roomStr = zenkakuDigitsToHankaku(String(grid[h.row][c]).trim());
      const cell = extractCell(countRow[c]);
      sensorMaster[roomStr] = { sa: cell.sa, tei: cell.tei, confirmedWithLight: cell.confirmedWithLight };

      // [2026-08-03追加] セルが空欄、または「差動」「定温」いずれの記載も見つからない場合
      // (unresolved)は、以前は黙って読み飛ばしていた(sensorMasterにエントリすら作らず、
      // warningも出さなかった)。これはPhase2①.5の方針(セルが空欄・解析不能の場合は必ず
      // warningsを付ける)に反するため、エントリ自体は作った上でwarningを付けるように変更した。
      if (cell.blank) {
        warnings.push({
          code: 'SENSOR_VALUE_MISSING',
          detail: `部屋${roomStr}(${h.floorLabel}): 個数のセルが空欄のため、差動式・定温式とも件数を確定できません。0件と決め付けず未確認のまま保持しています。原本を確認してください。`,
          row: h.row + 1, room: roomStr,
        });
        continue;
      }
      if (cell.unresolved) {
        warnings.push({
          code: 'SENSOR_VALUE_MISSING',
          detail: `部屋${roomStr}(${h.floorLabel}): 個数のセルに「差動」「定温」いずれの記載も見つかりません(セルの内容: ${JSON.stringify(cell.rawText)})。0件と決め付けず未確認のまま保持しています。原本を確認してください。`,
          row: h.row + 1, room: roomStr,
        });
        continue;
      }

      // [2026-08-03追加] 主値(括弧の外、設置感知器個数)の差動/定温が片方しか読み取れない
      // 場合、以前は読み取れなかった方を0として返していた。0で補完せず、読み取れた方は
      // 数値、読み取れない方はnullのまま保持し、その旨をwarningで明示する。
      if (cell.sa === null) {
        warnings.push({
          code: 'SENSOR_VALUE_MISSING',
          detail: `部屋${roomStr}(${h.floorLabel}): 「差動」の件数の記載が見つかりません(定温のみ記載)。0件と決め付けず未確認のまま保持しています。原本を確認してください。`,
          row: h.row + 1, room: roomStr, type: 'sa',
        });
      }
      if (cell.tei === null) {
        warnings.push({
          code: 'SENSOR_VALUE_MISSING',
          detail: `部屋${roomStr}(${h.floorLabel}): 「定温」の件数の記載が見つかりません(差動のみ記載)。0件と決め付けず未確認のまま保持しています。原本を確認してください。`,
          row: h.row + 1, room: roomStr, type: 'tei',
        });
      }

      if (cell.confirmedWithLight) {
        const cwl = cell.confirmedWithLight;
        if (cwl.sa === null || cwl.tei === null) {
          // [2026-08-03追加] 括弧内(確認灯付き個数)も、主値と同様に片方しか読み取れない
          // 場合は0で補完せずnullのまま保持する(例:「(差動0・1)」のように、片方だけ
          // ラベル付きで書かれ、もう片方は種別不明の数字のみのケース)。
          warnings.push({
            code: 'SENSOR_VALUE_MISSING',
            detail: `部屋${roomStr}(${h.floorLabel}): 括弧内(確認灯がついてる個数)の記載が「差動」「定温」の一方のみで、もう一方は種別を特定できません(セルの内容: ${JSON.stringify(countRow[c])})。0件と決め付けず未確認のまま保持しています(confirmedWithLightの該当項目はnull)。原本を確認してください。`,
            room: roomStr,
          });
        } else if (cell.sa !== null && cell.tei !== null && (cwl.sa !== cell.sa || cwl.tei !== cell.tei)) {
          warnings.push({
            code: 'SENSOR_CONFIRMED_SUBCOUNT_MISMATCH',
            detail: `部屋${roomStr}(${h.floorLabel}): 設置感知器個数(差動${cell.sa}/定温${cell.tei})と、確認灯がついてる個数(差動${cwl.sa}/定温${cwl.tei})が一致しません。原本自体が「データが揃いきっていない」と注記しているため、参考情報として記録します。`,
            room: roomStr,
          });
        }
      }
    }
  }

  // 原本の注記通り、このシートのデータは未確定である可能性が高いことを、
  // 個別警告とは別に一度だけ明示しておく。
  warnings.push({
    code: 'SENSOR_SOURCE_DATA_UNCONFIRMED',
    detail: '原本シートに「データが揃いきっていない(正確な数も含めて)ので確認と記載のご協力お願いします」という注記があり、管理会社側でもこのデータが未確定であることを認識している。sensorMasterのsa/teiには括弧外(設置感知器個数)を採用しているが、内容の最終確認を推奨する。',
  });

  return { sensorMaster, warnings };
}

module.exports = {
  id: 'sensorCount.floorFormatWithConfirmedSubcount.v1',
  label: '階グリッド+確認灯付き内訳形式(部屋番号の直下に「差動N定温M (差動X定温Y)」、括弧外=設置個数/括弧内=確認灯付き個数)',
  detect,
  parse,
};

    })(module, exports, require);
    return module;
  })();

  __ffModules["formatParsers/sensorCount/positionalTwoLineFormatParser.js"] = (function () {
    var module = { exports: {} };
    var exports = module.exports;
    var require = function (spec) { return __ffRequire("formatParsers/sensorCount/positionalTwoLineFormatParser.js", spec); };
    (function (module, exports, require) {
// lib/formatParsers/sensorCount/positionalTwoLineFormatParser.js
//
// [2026-08-03新設] 感知器数(sensorCount)フォーマット「位置依存2行形式」用Parser。
//
// 2026-08-03、「コスモザ・パークスイースト2」物件の実データ(感知器数（コスモザ・
// パークスイースト2）.xls)で初めて確認したフォーマット。部屋番号の行(例:「1501 1502
// 1503 …」)の直下に、各部屋のセルへ「×5\n×2」のように「×」+数字の2行だけが書かれている。
//
// 【既存フォーマットとの決定的な違い】
// 既存のfloorSummaryTextFormat・roomOnlyPairRowsFormat等は、いずれもセル内に「差動」
// 「定温」という語句が必ず存在し、その語句の直後の数字を読み取る設計だった。しかし
// この物件のデータにはその語句が一切無く、「1行目・2行目」という「セル内での行の
// 位置」だけで差動/定温を判別する必要がある(行頭に付くアイコン文字については下記
// 【実装中に見つかった注記事項】を参照。このアイコン自体は差動/定温を意味しておらず、
// 判別には使っていない)。この前提の違いにより、既存Parserの拡張ではなく新規Parser
// として切り出した(ご確認済み)。
//
// 【行の意味、ご確認済み】1行目=差動(sa)、2行目=定温(tei)。この物件の11F〜15Fの「12」
// 号室群(1112・1212・1312等)の見出し行の右側に「定温×２はキッチン・洗面所」という注記が
// あり、2行目の数字(×2)が定温の個数であることを原本自体が裏付けている。
//
// 【空欄「×\n×」(数字が一切無い)の扱い、ご確認済み】2F〜10Fの「01」号室
// (1001・901・801…201)と「12」号室(1012・912・812…212)は、値のセルが「×\n×」に
// なっている。すぐ右の注記(「2階〜10階住居内感知器無し」「洗面所感知器無くてもOK」)が、
// これらの部屋には感知器そのものが設置されていないことを明示しているため、「未確認」
// ではなく「確定0件(sa:0, tei:0)」として扱う。この判断は個別の注記の有無を都度判定して
// いるのではなく、「×」の直後に数字が無い(＝個数を書く欄はあるが記入が無い)という
// セル自体の記法から一律に導出している(このフォーマット内では「×」の直後に数字が
// 無ければ0件、という規則として一貫させている)。
//
// 【実装中に見つかった注記事項】実際にはセルの各行は「×5」ではなく、行頭に私用領域(PUA)
// Unicode文字が1文字付き、その直後に「×」が続く形になっていた(1行目は必ずU+E012、
// 2行目は必ずU+E014、全78部屋で完全に一貫)。「グランフォルム須磨浦」の実データでは
// 同じ2つのアイコン文字が「差動/定温のどちらの語句の代わりか」を意味していたが、この
// 物件ではアイコンの出現位置が行位置と完全に1:1で固定されており、個数の意味は
// 「1行目=差動・2行目=定温」というご確認済みの行位置のルールだけで一意に決まる
// (アイコン自体の意味を解読する必要が無い)。ただし念のため、このアイコンの並びを
// 「差動→定温」の意味だと仮に読み替えると、グランフォルム須磨浦でご確認いただいた
// 対応(アイコン1=定温、アイコン2=差動)とは逆になる。物件・ファイルが異なれば
// アイコンの意味付けも異なりうる、という前提を裏付ける事例として完了報告に記載する。
'use strict';

const ROOM_NUMBER_PATTERN = /^\d{2,4}$/;
// 1行あたり、任意の私用領域(PUA)アイコン文字1文字(あれば)+「×」(全角/半角どちらでも)の
// 直後に、数字が続くか、何も続かないかのみを許容する。「差動×5」のように「×」の前に
// 語句(アイコン以外の通常の文字)が来るケースはこの正規表現には一致しない。
const LINE_PATTERN = /^[-]?\s*[×x]\s*(\d+)?\s*$/;

function zenkakuDigitsToHankaku(str) {
  return String(str).replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
}

// セルのテキストの1行目・2行目を、それぞれ差動(sa)・定温(tei)として読み取る。
// 3行目以降(警備感知器あり、洗面所感知器なし、等の自由記述の注記)は個数の判定には使わない。
// 1行目・2行目のいずれも「×」から始まらない場合(このフォーマットに一致しない内容の場合)は
// nullを返す。
function extractPositionalCount(cellValue) {
  if (cellValue == null) return null;
  const lines = String(cellValue).split('\n');
  const line0 = (lines[0] || '').trim();
  const line1 = (lines[1] || '').trim();
  const m0 = LINE_PATTERN.exec(line0);
  const m1 = LINE_PATTERN.exec(line1);
  if (!m0 && !m1) return null;
  // 「×」の直後に数字が無い(m[1]がundefined)場合は、未確認ではなく確定0件として扱う
  // (ご確認済み。原本の「感知器無し」「洗面所感知器無くてもOK」等の注記による裏付けあり)。
  const sa = m0 ? (m0[1] !== undefined ? Number(m0[1]) : 0) : null;
  const tei = m1 ? (m1[1] !== undefined ? Number(m1[1]) : 0) : null;
  return { sa: sa, tei: tei };
}

// 「部屋番号だけが2個以上並ぶ行」を見出し行の候補として集める(階ラベルは要求しない。
// roomOnlyPairRowsFormatParser.jsと同じ考え方)。
function findRoomHeaderRows(grid) {
  const headerRows = [];
  for (let r = 0; r < (grid || []).length; r++) {
    const row = grid[r];
    if (!row) continue;
    const roomCols = [];
    for (let c = 0; c < row.length; c++) {
      const v = row[c];
      if (v == null) continue;
      const str = zenkakuDigitsToHankaku(String(v).trim());
      if (ROOM_NUMBER_PATTERN.test(str)) roomCols.push(c);
    }
    if (roomCols.length >= 2) headerRows.push({ row: r, roomCols });
  }
  return headerRows;
}

function detect(grid) {
  if (!Array.isArray(grid)) return { matches: false, confidence: 0 };
  const headerRows = findRoomHeaderRows(grid);
  if (headerRows.length === 0) return { matches: false, confidence: 0, reason: '部屋番号が2個以上並ぶ行が見つからない' };

  let pairedRows = 0;
  let roomsWithCount = 0;
  let totalRoomCols = 0;
  for (const h of headerRows) {
    const valueRow = grid[h.row + 1];
    if (!valueRow) continue;
    let anyCount = false;
    for (const c of h.roomCols) {
      totalRoomCols++;
      if (extractPositionalCount(valueRow[c])) {
        anyCount = true;
        roomsWithCount++;
      }
    }
    if (anyCount) pairedRows++;
  }
  if (pairedRows === 0) return { matches: false, confidence: 0, reason: '部屋番号の行の直下に「×N」形式(語句・アイコンを伴わない位置依存の2行)のテキストが見つからない' };

  const confidence = 0.5 + 0.4 * (roomsWithCount / Math.max(1, totalRoomCols));
  return {
    matches: true,
    confidence: Math.min(0.95, confidence),
    reason: `部屋番号の行${headerRows.length}件中${pairedRows}件で直下に「×N」形式(1行目=差動、2行目=定温、語句・アイコンなし)のテキストを検出(部屋${roomsWithCount}/${totalRoomCols}件)`,
  };
}

function parse(grid) {
  const warnings = [];
  const headerRows = findRoomHeaderRows(grid);
  const sensorMaster = {};

  for (const h of headerRows) {
    const valueRow = grid[h.row + 1];
    if (!valueRow) {
      warnings.push({ code: 'SENSOR_COUNT_ROW_MISSING', detail: `部屋番号の行(行${h.row})の直下に個数の行が見つかりません。`, row: h.row });
      continue;
    }
    for (const c of h.roomCols) {
      const roomStr = zenkakuDigitsToHankaku(String(grid[h.row][c]).trim());
      const cellValue = valueRow[c];
      const count = extractPositionalCount(cellValue);
      if (!count) {
        sensorMaster[roomStr] = { sa: null, tei: null };
        warnings.push({
          code: 'SENSOR_VALUE_MISSING',
          detail: `部屋${roomStr}(行${h.row + 1}): セルが「×N」形式(1行目=差動、2行目=定温)に一致しません(セルの内容: ${JSON.stringify(cellValue)})。0件と決め付けず未確認のまま保持しています。原本を確認してください。`,
          row: h.row + 1, room: roomStr,
        });
        continue;
      }
      sensorMaster[roomStr] = { sa: count.sa, tei: count.tei };
      if (count.sa === null) {
        warnings.push({
          code: 'SENSOR_VALUE_MISSING',
          detail: `部屋${roomStr}(行${h.row + 1}): 1行目(差動)が「×N」形式に一致しません。0件と決め付けず未確認のまま保持しています。原本を確認してください。`,
          row: h.row + 1, room: roomStr, type: 'sa',
        });
      }
      if (count.tei === null) {
        warnings.push({
          code: 'SENSOR_VALUE_MISSING',
          detail: `部屋${roomStr}(行${h.row + 1}): 2行目(定温)が「×N」形式に一致しません。0件と決め付けず未確認のまま保持しています。原本を確認してください。`,
          row: h.row + 1, room: roomStr, type: 'tei',
        });
      }
    }
  }

  // このフォーマットには階ラベル・階合計セルが無いため、既存のfloorSummaryTextFormatの
  // ような階合計との整合性チェックはできない(捏造しないという原則に従い、行わない)。
  return { sensorMaster, warnings };
}

module.exports = {
  id: 'sensorCount.positionalTwoLineFormat.v1',
  label: '位置依存2行形式(階ラベル・語句・アイコンなし、部屋番号の行+直下に「×N」を2行、1行目=差動・2行目=定温)',
  detect,
  parse,
};

    })(module, exports, require);
    return module;
  })();

  __ffModules["formatParsers/sensorCount/index.js"] = (function () {
    var module = { exports: {} };
    var exports = module.exports;
    var require = function (spec) { return __ffRequire("formatParsers/sensorCount/index.js", spec); };
    (function (module, exports, require) {
// lib/formatParsers/sensorCount/index.js
//
// [2026-08-02新設] 感知器数(sensorCount)ドキュメント種別のフォーマット別Parserを登録した
// レジストリ。新しいフォーマットに対応する場合は、新しいParserファイルをこのディレクトリに
// 追加し、下のregister()呼び出しを1行追加するだけでよい(このファイルの他の部分・
// registry.js・呼び出し側のコードは変更不要)。
'use strict';

const { createFormatParserRegistry } = require('../registry.js');
const tableFormatParser = require('./tableFormatParser.js');
const floorGridFormatParser = require('./floorGridFormatParser.js');
const floorSummaryTextFormatParser = require('./floorSummaryTextFormatParser.js');
const labelValuePairGridFormatParser = require('./labelValuePairGridFormatParser.js');
const totalOnlyGridFormatParser = require('./totalOnlyGridFormatParser.js');
const roomOnlyPairRowsFormatParser = require('./roomOnlyPairRowsFormatParser.js');
const floorFormatWithConfirmedSubcountParser = require('./floorFormatWithConfirmedSubcountParser.js');
const positionalTwoLineFormatParser = require('./positionalTwoLineFormatParser.js');

const sensorCountRegistry = createFormatParserRegistry('sensorCount');
sensorCountRegistry.register(tableFormatParser);
sensorCountRegistry.register(floorGridFormatParser);
// [2026-08-02追加] 「アービング塚本」物件で見つかった3つ目のフォーマット。
// 追加はこの1行の登録のみ。registry.js・既存2Parserは無変更(ご指示④の実証)。
sensorCountRegistry.register(floorSummaryTextFormatParser);
// [2026-08-02追加] 「グランアークス千里山」物件で見つかった4つ目のフォーマット。
// こちらも追加はこの1行の登録のみ。registry.js・既存3Parserは無変更。
sensorCountRegistry.register(labelValuePairGridFormatParser);
// [2026-08-02追加] 「グランディア香里園山の手」物件で見つかった5つ目のフォーマット
// (種別内訳が無く、部屋ごとの合計数のみ)。追加はこの1行の登録のみ。
sensorCountRegistry.register(totalOnlyGridFormatParser);
// [2026-08-02追加] 「グランディア緑地公園」物件で見つかった6つ目のフォーマット
// (階ラベルが無い、部屋番号のみのペア行)。追加はこの1行の登録のみ。
sensorCountRegistry.register(roomOnlyPairRowsFormatParser);
// [2026-08-02追加] 「グランドハイツ魚崎」物件で見つかった7つ目のフォーマット
// (主値+確認灯付き内訳が括弧で併記される)。追加はこの1行の登録のみ。
sensorCountRegistry.register(floorFormatWithConfirmedSubcountParser);
// [2026-08-03追加] 「コスモザ・パークスイースト2」物件で見つかった8つ目のフォーマット
// (差動/定温の語句・アイコンが一切無く、部屋番号の行の直下に「×N」形式の数字が2行
// (1行目=差動、2行目=定温)だけ書かれている)。追加はこの1行の登録のみ。
sensorCountRegistry.register(positionalTwoLineFormatParser);

// 呼び出し側向けの薄いショートカット関数。
// grid: 2次元配列(pipeline.jsのsheets[sheetName].gridと同じ形)。
function parseSensorCountSheet(grid) {
  return sensorCountRegistry.autoParse(grid);
}

module.exports = { sensorCountRegistry, parseSensorCountSheet };

    })(module, exports, require);
    return module;
  })();

  __ffModules["toPropertyMasterIntake.js"] = (function () {
    var module = { exports: {} };
    var exports = module.exports;
    var require = function (spec) { return __ffRequire("toPropertyMasterIntake.js", spec); };
    (function (module, exports, require) {
// lib/toPropertyMasterIntake.js
//
// [2026-08-03新設、2026-08-03改訂(Phase2②)] FireFlow Ingest → FSDF → LB → RF の一本の
// 実運用フロー完成に向けた実装。各Parser(roomRoster/sensorCount/inspectionReportSummary。
// 将来的にはsensorZoneSummaryも含む)の出力を、FSDF(fireflow_fsdf/)の新documentType
// 「propertyMasterIntake」(点検前マスタ)のEnvelope形式へ変換する。
//
// 【propertyMasterIntakeの位置づけ(ご指示2026-08-03)】
// 点検前の物件マスタ(部屋一覧・階構成・感知器設置数・物件基本情報)を表すdocumentType。
// 点検中〜点検後の現場データを表す既存のroomInspectionSessionとは意味的に別物であり、
// 互いに無関係のまま(roomInspectionSession側は今回一切変更しない)。
//
// 【Phase1のスコープ(roomRoster/sensorCount)】実際にこの関数へ結果を渡すのは
// roomRosterResult・sensorCountResultの2つ(感知器個数表→sensorCount、住戸一覧→roomRoster)。
//
// 【Phase2②で追加接続(2026-08-03)】inspectionReportSummaryResult(点検結果報告書の
// 総括表)を接続した。抽出できた物件名・所在地・点検種別・点検開始日を、呼び出し側が
// 明示的に`property`引数で指定していない項目に限り`property`へ反映する(4.1節、優先順位:
// 明示的なinputs.property > inspectionReportSummaryResultからの抽出値 > null)。
// sensorZoneSummary・crossValidateの接続、propertyInfo/historyの実利用は引き続き将来対応
// (置き場所のみ予約済み)。「渡されなければnullのまま」という設計のため、将来は呼び出し側が
// 該当のResult/入力を追加で渡すだけで拡張でき、本ファイルの呼び出し規約自体は変更不要。
//
// 【日付はFSDF内部ではISO形式(YYYY-MM-DD)を正規値とする(ご指示2026-08-03)】
// inspectionReportSummaryParserが返すinspectionDateStartは既にISO形式であり、本関数は
// これを一切変換せずそのまま`property.inspectionDate`へ格納する。理由:
// FSDFはLB専用データではなくRF・API・将来のDBでも利用する共通データであり、日付比較・
// 並び替え・検索・期間計算にはISO形式の方が安全なため、表示形式(LBの既存「YYYY年M月D日」
// 表記)を共通データへ混在させない。表示用の変換はLB境界のAdapter(index.htmlの
// formatIsoDateForLb())が専任で担う。inspectionDateEndは今回`property`へは反映せず
// (LBのPROPERTYに対応する「終了日」概念が無く、scheduleDaysとの関係整理は将来課題のため)、
// `payload.inspectionReportSummary`(生データ)にのみISO形式で保持する。
//
// 【1回の呼び出し = 1件のpropertyMasterIntake Envelope】
// LB側の「資料をまとめて追加」機能はファイル単位で処理される(processDocBatchDraft(draft)は
// 1ファイルずつ呼ばれる)ため、本関数も「その時点で確定している入力だけ」を受け取り、
// 1つのEnvelopeを返す設計にした。複数ファイルにまたがる統合(crossValidateによる3点セット
// 突合等、バッチ単位のもの)は次フェーズで別途扱う。ただし1ファイル単位の物件名・所在地の
// 不一致検知(「今アップロードした総括表」対「今開いている物件」)は、LB側(index.html)が
// 本関数の呼び出し前に`crossValidateInputSet()`を直接呼ぶことで、Phase2②の時点で対応する
// (本関数自体の変更は不要)。呼び出し側(LB側のapplyPropertyMasterIntakeToLb())は、
// ファイルごとに生成されたEnvelopeを都度LBのworking stateへ「追加のみ」でマージする想定。
//
// 【値を捏造しない原則】各Parserがconfidenceを持たない/失敗した場合、この関数は該当
// セクションをnullのままにし、warningsへ理由を積む。0埋めや空オブジェクトへの
// フォールバックは行わない(sensorMasterのsa/teiが数値でなければnullのまま保持する)。
'use strict';

var FSDF_VERSION = '2.1';
var DOCUMENT_TYPE = 'propertyMasterIntake';

// importedAtが呼び出し側から明示的に渡されなかった場合のみ使うフォールバック。
function nowIso() {
  return new Date().toISOString();
}

// sensorCountRegistry.autoParse()の結果から、sourceType付きのsensorMasterフラグメントを作る。
// 既存のbuildSensorMasterFromSensorSheet()(LB既存の経路A、自火報一覧シート専用)とは完全に
// 別コードパスであり、そちらの「読めない値は0」という既存挙動には一切影響しない。
// fireflowIngest経由は、ご指示の通りsa/teiが数値でない場合はnullのまま保持する(0埋めしない)。
function sensorMasterFragmentFrom(sensorCountResult) {
  if (!sensorCountResult || !sensorCountResult.ok) return null;
  var raw = (sensorCountResult.data && sensorCountResult.data.sensorMaster) || {};
  var out = {};
  Object.keys(raw).forEach(function (room) {
    var entry = raw[room] || {};
    var sa = typeof entry.sa === 'number' ? entry.sa : null;
    var tei = typeof entry.tei === 'number' ? entry.tei : null;
    // [2026-08-03追加、実データ対応(グランフォルム新神戸)] floorSummaryTextFormatParserが
    // 新設したkemuri(煙感知器)フィールドをここでも読み落とさず引き継ぐ(このフィールドを
    // 持たない他6Parserの出力ではentry.kemuriがundefinedのため、常にnullになる)。
    // totalの算出は既存通りsa+teiのみとし、kemuriは含めない(既存物件の「total」の意味を
    // 変えないため。kemuriを含めた合計が必要になった場合は改めてご判断いただく)。
    var kemuri = typeof entry.kemuri === 'number' ? entry.kemuri : null;
    out[room] = {
      sa: sa,
      tei: tei,
      kemuri: kemuri,
      total: (sa === null && tei === null) ? null : (sa || 0) + (tei || 0),
      // データ由来の判別用(ご指示: legacyExcel/fireflowIngestを区別できる設計にすること)。
      // 既存経路A(buildSensorMasterFromSensorSheet)にはこのフィールド自体が存在しない
      // (=undefinedはlegacyExcel相当として扱われる、という規約はLB側の
      // applyPropertyMasterIntakeToLb()/extendSensorMasterFromEntries()のコメントで明文化する)。
      source: 'fireflowIngest',
    };
  });
  return out;
}

// [2026-08-03新設、Phase2②] inspectionReportSummaryResultから、property引数へ反映すべき
// フィールドだけを抽出する。抽出できなかった(null)項目はキー自体を含めない
// (Object.assignで「明示的なinputs.propertyでの上書き」より後に適用しても、
// 未取得の項目でinputs.property側の値を誤ってnullへ戻さないようにするため)。
// inspectionDateEndはここでは意図的に含めない(2.3節: 今回はproperty.inspectionDateEndへ
// 反映しない。payload.inspectionReportSummary(生データ)にのみISO形式で保持される)。
function propertyFieldsFromInspectionReportSummary(inspectionReportSummaryResult) {
  if (!inspectionReportSummaryResult || !inspectionReportSummaryResult.ok) return {};
  var data = inspectionReportSummaryResult.data || {};
  var out = {};
  if (data.propertyName != null) out.name = data.propertyName;
  if (data.address != null) out.address = data.address;
  if (data.inspectionType != null) out.inspectionType = data.inspectionType;
  // ISO形式(YYYY-MM-DD)のまま格納する(表示形式への変換はLB境界のAdapterが担う。
  // ファイル冒頭のコメント参照)。
  if (data.inspectionDateStart != null) out.inspectionDate = data.inspectionDateStart;
  return out;
}

function roomRosterFragmentFrom(roomRosterResult) {
  if (!roomRosterResult || !roomRosterResult.ok) return null;
  var data = roomRosterResult.data || {};
  return {
    rooms: data.rooms || {},
    floors: data.floors || {},
    buildings: data.buildings || [],
  };
}

function sourceDocumentEntry(documentKind, result, meta) {
  if (!result) return null;
  meta = meta || {};
  return {
    documentKind: documentKind,
    parserId: result.matchedParserId || null,
    parserLabel: result.matchedParserLabel || null,
    confidence: typeof result.confidence === 'number' ? result.confidence : null,
    ambiguous: !!result.ambiguous,
    ok: !!result.ok,
    reason: result.reason || null,
    sourceFileName: meta.sourceFileName || null,
    importedAt: meta.importedAt || nowIso(),
  };
}

function collectWarnings(documentKind, result) {
  if (!result) return [];
  var warnings = (result.ok && result.data && Array.isArray(result.data.warnings)) ? result.data.warnings : [];
  var out = warnings.map(function (w) {
    if (w && typeof w === 'object') return Object.assign({ documentKind: documentKind }, w);
    return { documentKind: documentKind, message: String(w) };
  });
  if (result && !result.ok) {
    out.push({
      documentKind: documentKind,
      code: result.reason || 'PARSE_FAILED',
      message: result.detail || (documentKind + 'の解析に失敗しました。'),
      severity: 'error',
    });
  }
  return out;
}

// inputs:
//   roomRosterResult, sensorCountResult, inspectionReportSummaryResult:
//     各ParserのautoParse()戻り値(省略可。LB側が1ファイルずつ処理するため、
//     基本的にいずれか1つのみが渡される)。inspectionReportSummaryResultが渡された場合、
//     抽出できた項目(name/address/inspectionType/inspectionDate)がproperty引数へ反映される
//     (inputs.propertyで明示された項目が優先される。上記コメント4.1節参照)。
//   sensorZoneSummaryResult, crossValidateResult:
//     【将来拡張用】現時点では呼び出し側から渡されない想定だが、渡された場合は
//     payloadへそのまま反映する。
//   property: { name, address, inspectionDate, inspectionDateEnd, inspectionType }
//     (省略可。呼び出し側〈LBの既存PROPERTY等〉が把握している値を明示的に渡す。
//     本関数側で会話履歴や直前の状態を参照することはしない。inspectionDateはISO形式
//     [YYYY-MM-DD]を渡すこと)。
//   sourceMeta: { roomRoster: {sourceFileName, importedAt}, sensorCount: {...}, inspectionReportSummary: {...} }
// 戻り値: FSDF Envelope形式のオブジェクト({fsdfVersion, documentType, property, payload})。
function toPropertyMasterIntake(inputs) {
  inputs = inputs || {};
  var sourceMeta = inputs.sourceMeta || {};

  var sourceDocuments = [
    sourceDocumentEntry('roomRoster', inputs.roomRosterResult, sourceMeta.roomRoster),
    sourceDocumentEntry('sensorCount', inputs.sensorCountResult, sourceMeta.sensorCount),
    sourceDocumentEntry('sensorZoneSummary', inputs.sensorZoneSummaryResult, sourceMeta.sensorZoneSummary),
    sourceDocumentEntry('inspectionReportSummary', inputs.inspectionReportSummaryResult, sourceMeta.inspectionReportSummary),
  ].filter(Boolean);

  var warnings = []
    .concat(collectWarnings('roomRoster', inputs.roomRosterResult))
    .concat(collectWarnings('sensorCount', inputs.sensorCountResult))
    .concat(collectWarnings('sensorZoneSummary', inputs.sensorZoneSummaryResult))
    .concat(collectWarnings('inspectionReportSummary', inputs.inspectionReportSummaryResult));

  // 優先順位(4.1節): 明示的なinputs.property > inspectionReportSummaryResultからの
  // 抽出値 > null。Object.assignは後勝ちのため、抽出値を先に、inputs.propertyを
  // 最後に適用する(inputs.propertyが特定のキーを持たない場合は、そのキーに限り
  // 抽出値がそのまま採用される)。
  var derivedFromSummary = propertyFieldsFromInspectionReportSummary(inputs.inspectionReportSummaryResult);
  var property = Object.assign({
    name: null,
    address: null,
    inspectionDate: null,
    inspectionDateEnd: null,
    inspectionType: null,
  }, derivedFromSummary, inputs.property || {});

  return {
    fsdfVersion: FSDF_VERSION,
    documentType: DOCUMENT_TYPE,
    property: property,
    payload: {
      sourceDocuments: sourceDocuments,
      roomRoster: roomRosterFragmentFrom(inputs.roomRosterResult),
      sensorMaster: sensorMasterFragmentFrom(inputs.sensorCountResult),
      // 【Phase2②で接続】inspectionReportSummaryの生データ(propertyName/address/
      // inspectionType/inspectionDateStart/inspectionDateEnd/warnings)をそのまま保持する。
      // property.inspectionDateEndへは反映しない(ファイル冒頭コメント参照)ため、
      // 終了日を参照したい場合はここ(payload.inspectionReportSummary.inspectionDateEnd)を
      // 見ること。sensorZoneSummary・crossValidateは引き続き将来接続予定のため常にnull。
      sensorZoneSummary: (inputs.sensorZoneSummaryResult && inputs.sensorZoneSummaryResult.ok) ? inputs.sensorZoneSummaryResult.data : null,
      inspectionReportSummary: (inputs.inspectionReportSummaryResult && inputs.inspectionReportSummaryResult.ok) ? inputs.inspectionReportSummaryResult.data : null,
      validation: inputs.crossValidateResult || null,
      // ---- 【将来拡張用の予約フィールド、2026-08-03のご指示】 ----
      // propertyInfo: 物件基本情報をinspectionReportSummaryから独立して管理したくなった場合の置き場所。
      // history: 点検前マスタの変更履歴(Phase3ロードマップ「履歴管理」向け)。
      // どちらも現時点では常にnull/空配列のまま。
      propertyInfo: null,
      history: [],
      warnings: warnings,
    },
  };
}

module.exports = { toPropertyMasterIntake: toPropertyMasterIntake, FSDF_VERSION: FSDF_VERSION, DOCUMENT_TYPE: DOCUMENT_TYPE };

    })(module, exports, require);
    return module;
  })();

  __ffModules["errorTaxonomy.js"] = (function () {
    var module = { exports: {} };
    var exports = module.exports;
    var require = function (spec) { return __ffRequire("errorTaxonomy.js", spec); };
    (function (module, exports, require) {
// errorTaxonomy.js
// ============================================================================
// FireFlow取込エラー分類体系
// ============================================================================
// 6大分類 × それぞれの具体的なエラーコードを一元管理する。
// validator.js / parser.js はここに定義されたコードだけを使ってissueを発行する
// (自由文言のエラーメッセージを個別に書き散らかさない = 「同じ原因のエラーが
// 再発しないように」の一環。新しいエラーパターンを見つけたら、まずここに
// コードを追加してから対応するチェックを実装する、という順序を徹底する)。

'use strict';

// 大分類
const CATEGORIES = Object.freeze({
  INPUT_DATA_DEFECT: '入力データ不備',
  FORMAT_DIFFERENCE: 'フォーマット差異',
  NOTATION_VARIANCE: '表記揺れ',
  SPEC_GAP: '仕様不足',
  SYSTEM_BUG: 'システムバグ',
  DOCUMENT_SPECIFIC_DIFFERENCE: '帳票固有差異',
});

// 重大度。severity='error'は該当行を読込不可として扱い、'warning'は正常データとして
// 読み込むが確認を促す(読込画面の「警告件数」に計上する)。
const SEVERITY = Object.freeze({
  ERROR: 'error',
  WARNING: 'warning',
});

// エラーコード一覧。category, severity(デフォルト。個別issueで上書き可), messageTemplate,
// suggestedFix(修正方法のひな形)を持つ。
const ERROR_CODES = Object.freeze({
  // ---- 1. 入力データ不備 ----
  EMPTY_REQUIRED_FIELD: {
    category: CATEGORIES.INPUT_DATA_DEFECT, severity: SEVERITY.ERROR,
    message: '必須項目が空欄です',
    suggestedFix: '元ファイルの該当セルに値を入力してから再取込してください。',
  },
  DUPLICATE_ROOM_NUMBER: {
    category: CATEGORIES.INPUT_DATA_DEFECT, severity: SEVERITY.ERROR,
    message: '同一物件内で部屋番号が重複しています',
    suggestedFix: '重複している行のどちらが正しいかを確認し、片方を削除するか部屋番号を修正してください。',
  },
  INVALID_VALUE: {
    category: CATEGORIES.INPUT_DATA_DEFECT, severity: SEVERITY.ERROR,
    message: '値の形式が不正です',
    suggestedFix: '想定される形式(例を参照)に修正してください。',
  },
  NUMERIC_STRING_MISMATCH: {
    category: CATEGORIES.INPUT_DATA_DEFECT, severity: SEVERITY.WARNING,
    message: '数値が文字列として保存されています',
    suggestedFix: '自動的に数値へ変換しました。変換結果に誤りがないか確認してください。',
  },
  INVALID_DATE: {
    category: CATEGORIES.INPUT_DATA_DEFECT, severity: SEVERITY.ERROR,
    message: '日付の形式を認識できません',
    suggestedFix: '「2026年6月26日」「2026/6/26」等の形式、またはExcelの日付セルに修正してください。',
  },
  INVALID_ROOM_NUMBER: {
    category: CATEGORIES.INPUT_DATA_DEFECT, severity: SEVERITY.ERROR,
    message: '部屋番号を認識できません',
    suggestedFix: '部屋番号のセルの表記を確認してください(数字を含む必要があります)。',
  },

  // [2026-08-03追加] fireflow_ingest/lib/formatParsers/crossValidate.js用。
  // 捺印表(roomRoster)・感知器数(sensorCount)・点検結果報告書(inspectionReportSummary)を
  // 3ファイル1セットとして読み込んだ際の、ファイル間の整合性チェック用エラーコード。
  ROOM_LIST_MISMATCH: {
    category: CATEGORIES.INPUT_DATA_DEFECT, severity: SEVERITY.WARNING,
    message: '捺印表と感知器数ファイルとで、部屋番号の一覧が一致しません',
    suggestedFix: '該当する部屋が、片方のファイルで単に未記載なのか、部屋番号の表記違い(例: 全角/半角、桁数)なのかを確認してください。',
  },
  FLOOR_STRUCTURE_MISMATCH: {
    category: CATEGORIES.INPUT_DATA_DEFECT, severity: SEVERITY.WARNING,
    message: '捺印表側の階の部屋数に対して、感知器数ファイル側で確認できた部屋数が一致しません',
    suggestedFix: '当該階について、感知器数ファイル側に記載漏れの部屋がないか確認してください。',
  },
  PROPERTY_IDENTITY_MISMATCH: {
    category: CATEGORIES.INPUT_DATA_DEFECT, severity: SEVERITY.ERROR,
    message: '点検結果報告書から抽出した物件名・所在地が、比較対象(expectedProperty、または同一セット内の他ファイル)と明確に一致しません',
    suggestedFix: '異なる物件のファイルを誤って同じセットに含めていないか確認してください(過去に類似物件名の取り違え事故が発生しています)。このissueが1件でもある場合、crossValidateInputSet()はそれ以降の突合処理を中止します。',
  },
  // [2026-08-03追加] 物件名・所在地の差異が、明確な別物件ではなく表記ゆれ(住所の
  // 書き方の違い、スペースの有無等)である可能性が高い場合に使う。severityはwarningとし、
  // PROPERTY_IDENTITY_MISMATCH(error)とは明確に区別する。
  PROPERTY_IDENTITY_NOTATION_VARIANCE: {
    category: CATEGORIES.NOTATION_VARIANCE, severity: SEVERITY.WARNING,
    message: '物件名・所在地の抽出結果に、表記ゆれの可能性がある差異があります',
    suggestedFix: '別物件ではなく表記ゆれの可能性が高いと判定していますが、本当に同一物件かどうか念のためご確認ください。',
  },

  // ---- 2. フォーマット差異 ----
  SHEET_NOT_FOUND: {
    category: CATEGORIES.FORMAT_DIFFERENCE, severity: SEVERITY.ERROR,
    message: '想定するシートが見つかりませんでした',
    suggestedFix: 'シート名の表記(空白・全角半角・号数違い等)を確認するか、シート名候補リストに追加してください。',
  },
  COLUMN_NOT_FOUND: {
    category: CATEGORIES.FORMAT_DIFFERENCE, severity: SEVERITY.ERROR,
    message: '想定する列が見つかりませんでした',
    suggestedFix: '列見出しの表記を確認するか、列名の別名候補に追加してください。',
  },
  HEADER_ROW_AMBIGUOUS: {
    category: CATEGORIES.FORMAT_DIFFERENCE, severity: SEVERITY.WARNING,
    message: 'ヘッダー行の位置を自動判定しました(確認を推奨)',
    suggestedFix: 'プレビュー画面で列の対応関係が正しいか確認してください。',
  },
  MERGED_CELL_EXPANDED: {
    category: CATEGORIES.FORMAT_DIFFERENCE, severity: SEVERITY.WARNING,
    message: '結合セルの値を各行(列)に展開しました',
    suggestedFix: '展開結果が意図通りか確認してください。',
  },
  UNEXPECTED_BLANK_ROW: {
    category: CATEGORIES.FORMAT_DIFFERENCE, severity: SEVERITY.WARNING,
    message: '空白行をスキップしました',
    suggestedFix: '意図的な空白行でない場合は元ファイルを確認してください。',
  },
  MULTI_SHEET_STRUCTURE: {
    category: CATEGORIES.FORMAT_DIFFERENCE, severity: SEVERITY.WARNING,
    message: '複数シートにまたがるデータを統合しました',
    suggestedFix: '統合結果(棟・シートごとの内訳)をプレビューで確認してください。',
  },

  // ---- 3. 表記揺れ ----
  NOTATION_NORMALIZED: {
    category: CATEGORIES.NOTATION_VARIANCE, severity: SEVERITY.WARNING,
    message: '表記ゆれを自動的に正規化しました',
    suggestedFix: '正規化結果(変換前後)をプレビューで確認してください。',
  },
  EQUIPMENT_NAME_UNRESOLVED: {
    category: CATEGORIES.NOTATION_VARIANCE, severity: SEVERITY.WARNING,
    message: '設備名称を既知のカテゴリに正規化できませんでした',
    suggestedFix: '設備名称の別表記辞書(EQUIPMENT_NAME_ALIASES)に追加が必要か確認してください。',
  },

  // ---- 4. 仕様不足 ----
  UNCLASSIFIED_ZONE: {
    category: CATEGORIES.SPEC_GAP, severity: SEVERITY.WARNING,
    message: '区画の種別を判定できませんでした(共用部/管理人室/店舗/駐車場のいずれにも一致しません)',
    suggestedFix: '通常住戸として扱ってよいか、新しい区画種別として辞書に追加すべきか確認してください。',
  },
  MAISONETTE_DETECTED: {
    category: CATEGORIES.SPEC_GAP, severity: SEVERITY.WARNING,
    message: 'メゾネット(複数階にまたがる区画)の可能性がある行を検出しました',
    suggestedFix: '対応する複数の部屋番号が正しく紐づいているか確認してください。',
  },
  MULTIPLE_EQUIPMENT_SAME_UNIT: {
    category: CATEGORIES.SPEC_GAP, severity: SEVERITY.WARNING,
    message: '同一住戸内に複数の同種設備が記録されています',
    suggestedFix: '意図的な複数設置か、データ重複かを確認してください。',
  },
  PROPERTY_SPECIFIC_FIELD: {
    category: CATEGORIES.SPEC_GAP, severity: SEVERITY.WARNING,
    message: '共通データ形式に対応するフィールドがない項目です(物件固有項目として保持)',
    suggestedFix: '複数物件で同様の項目が見つかった場合、共通データ形式への追加を検討してください。',
  },

  // ---- 5. システムバグ ----
  PROCESSING_EXCEPTION: {
    category: CATEGORIES.SYSTEM_BUG, severity: SEVERITY.ERROR,
    message: '正常なデータのはずですが処理中に例外が発生しました',
    suggestedFix: '開発者へ報告してください(エラーIDを添えて)。',
  },
  CONVERSION_MISMATCH: {
    category: CATEGORIES.SYSTEM_BUG, severity: SEVERITY.ERROR,
    message: '変換結果が元データと矛盾しています',
    suggestedFix: '開発者へ報告してください(エラーIDを添えて)。',
  },
  LB_RF_INCONSISTENCY: {
    category: CATEGORIES.SYSTEM_BUG, severity: SEVERITY.ERROR,
    message: 'LBとRFで同一データに対する処理結果が一致しません',
    suggestedFix: '開発者へ報告してください(エラーIDを添えて)。',
  },
  PERSIST_FAILURE: {
    category: CATEGORIES.SYSTEM_BUG, severity: SEVERITY.ERROR,
    message: '保存処理または更新処理に失敗しました',
    suggestedFix: 'もう一度取込を実行してください。繰り返し発生する場合は開発者へ報告してください。',
  },

  // ---- 6. 帳票固有差異 ----
  COMPANY_SPECIFIC_LAYOUT: {
    category: CATEGORIES.DOCUMENT_SPECIFIC_DIFFERENCE, severity: SEVERITY.WARNING,
    message: '管理会社ごとの帳票仕様の違いを検出しました',
    suggestedFix: 'この管理会社向けの取込プロファイルとして設定を保存することを検討してください。',
  },
  OUTPUT_POSITION_DIFFERENCE: {
    category: CATEGORIES.DOCUMENT_SPECIFIC_DIFFERENCE, severity: SEVERITY.WARNING,
    message: '同種の帳票でも出力位置が異なっています',
    suggestedFix: 'ラベルベースの位置検出(findSokatsuRow等と同じ方式)で吸収されているか確認してください。',
  },
  REQUIRED_FIELD_DIFFERENCE: {
    category: CATEGORIES.DOCUMENT_SPECIFIC_DIFFERENCE, severity: SEVERITY.WARNING,
    message: '管理会社ごとに必須項目の扱いが異なります',
    suggestedFix: '管理会社別の必須項目設定を確認してください。',
  },
  DISPLAY_FORMAT_DIFFERENCE: {
    category: CATEGORIES.DOCUMENT_SPECIFIC_DIFFERENCE, severity: SEVERITY.WARNING,
    message: '書式や表示形式が管理会社ごとに異なります',
    suggestedFix: '表示形式の差異が実害を生むか確認してください。',
  },
});

function codeInfo(code) {
  const info = ERROR_CODES[code];
  if (!info) throw new Error('未登録のエラーコード: ' + code);
  return info;
}

module.exports = { CATEGORIES, SEVERITY, ERROR_CODES, codeInfo };

    })(module, exports, require);
    return module;
  })();

  __ffModules["fieldDictionary.js"] = (function () {
    var module = { exports: {} };
    var exports = module.exports;
    var require = function (spec) { return __ffRequire("fieldDictionary.js", spec); };
    (function (module, exports, require) {
// fieldDictionary.js
// ============================================================================
// FireFlow共通データ形式 (Common Data Format) — 部屋・設備マスターデータ版
// ============================================================================
// 目的: 物件ごとの元データ(Excel/CSV等、会社によってレイアウトが異なる)を
// 「取込解析→正規化→検証」した後、LB・RFの両方が同じ形で読める「単一の真実」
// として保持するための、業務データ型の定義。
//
// 設計方針(重要):
//   - LB・RFは、原則としてこの共通データ形式だけを扱う。物件ごとの元Excelの
//     セル位置・シート名・表記ゆれを、LB・RF側のコードが直接意識することは
//     もう無くなる(そのための吸収層が、このモジュールの上位にあるparser/
//     normalizer/validator/pipelineという構成)。
//   - ここに定義するフィールド・区画種別(zoneType)・設備カテゴリの語彙は、
//     「LBが実際に扱える語彙の一覧」である。取込解析・AI解析のどちらも、
//     この語彙の中からしか値を選べないようにすることで、
//     「存在しないデータをマッピングしようとする」事故を防ぐ
//     (claude/ReportFlow_顧客ごとの既存Excel活用_設計提案 のfieldDictionary.ts
//     と同じ考え方を、物件マスターデータ側にも適用したもの)。
//   - LBの既存データモデル(index.html の FLOORS = [{label:'8F', rooms:['817',...]}])
//     は、通常の住戸のみを想定しており、共用部・管理人室・店舗・駐車場等の
//     特殊区画の概念が存在しない。共通データ形式ではこれを拡張し、
//     「区画(unit)」という上位概念のもとに、通常住戸も特殊区画も同じ形で
//     表現できるようにする。

'use strict';

// ---- 区画種別(zoneType) ----
// LBが実際に扱える区画の種類。取込解析はこの中からしか判定しない
// (未知のキーワードは 'unclassified' とし、人間による確認へ回す = カテゴリ4「仕様不足」)。
const ZONE_TYPES = Object.freeze({
  UNIT: 'unit', // 通常の住戸(101号室など)
  COMMON: 'common', // 共用部(エントランス、廊下、屋上、機械室など)
  MANAGER_ROOM: 'manager_room', // 管理人室
  SHOP: 'shop', // 店舗(1階店舗区画など)
  PARKING: 'parking', // 駐車場
  MAISONETTE: 'maisonette', // メゾネット(複数階にまたがる1区画。2つ以上のroomNumberに跨る)
  UNCLASSIFIED: 'unclassified', // 分類できなかった区画(要人間確認)
});

// 区画種別ごとに「部屋番号」が必須かどうか。共用部・管理人室・駐車場は
// 部屋番号を持たない(または「共用部」のような非数値ラベルのみ)ことが多いため、
// UNIT・MAISONETTE以外は部屋番号必須にしない。
const ZONE_TYPE_REQUIRES_ROOM_NUMBER = Object.freeze({
  [ZONE_TYPES.UNIT]: true,
  [ZONE_TYPES.COMMON]: false,
  [ZONE_TYPES.MANAGER_ROOM]: false,
  [ZONE_TYPES.SHOP]: false, // 店舗は「101」のような番号を持つ場合と持たない場合がある
  [ZONE_TYPES.PARKING]: false,
  [ZONE_TYPES.MAISONETTE]: true,
  [ZONE_TYPES.UNCLASSIFIED]: false,
});

// ---- 設備カテゴリ(equipmentCategory) ----
// RF側(build_yamato_fudai.js / build_tenken_houkokusho.js)が既に扱っている
// 設備区分と語彙を揃える(TAG_TO_SOKATSU / TAG_TO_ITEM 相当)。
// ここに無いカテゴリは 'unclassified' とし、自動処理の対象外(人間確認)にする。
const EQUIPMENT_CATEGORIES = Object.freeze({
  FIRE_EXTINGUISHER: 'fire_extinguisher', // 消火器具
  FIRE_ALARM: 'fire_alarm', // 自動火災報知設備(共同住宅用含む)
  EVACUATION_EQUIPMENT: 'evacuation_equipment', // 避難器具(はしご等)
  INDOOR_HYDRANT: 'indoor_hydrant', // 屋内消火栓設備
  SPRINKLER: 'sprinkler', // (共同住宅用)スプリンクラー設備
  POWDER_EXTINGUISHING: 'powder_extinguishing', // 粉末消火設備
  EMERGENCY_ALARM: 'emergency_alarm', // 非常警報器具及び設備
  EXIT_LIGHT: 'exit_light', // 誘導灯及び誘導標識
  FIRE_WATER: 'fire_water', // 消防用水
  STANDPIPE: 'standpipe', // 連結送水管(共同住宅用連結送水管)
  EMERGENCY_OUTLET: 'emergency_outlet', // 非常コンセント設備
  SMOKE_CONTROL: 'smoke_control', // 防排煙制御設備
  UNCLASSIFIED: 'unclassified',
});

// ---- 建物名 → LBの「支店・提出先」等、業務上意味のあるフィールド一覧 ----
// (物件そのものではなく、物件が持つ属性のうち共通データ形式が保持するもの)
const PROPERTY_FIELDS = Object.freeze([
  'propertyId', // FireFlow内部ID(取込時に採番、または既存物件への紐付け)
  'propertyName', // 物件名
  'address', // 住所(任意)
  'managementCompany', // 管理会社名(任意)
  'buildings', // 棟の配列(1棟のみの物件は長さ1)
]);

// ---- 共通データ形式のトップレベルスキーマ(JSON Schema, ドキュメント用) ----
// 実際のランタイムバリデーションは validator.js が行う。ここはあくまで「契約」の
// 一次資料として、ドキュメント化・将来の外部ツール連携用に保持する。
const PROPERTY_MASTER_SCHEMA = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'FireFlowPropertyMaster',
  type: 'object',
  required: ['propertyName', 'buildings', 'sourceMeta'],
  properties: {
    propertyId: { type: ['string', 'null'] },
    propertyName: { type: 'string', minLength: 1 },
    address: { type: ['string', 'null'] },
    managementCompany: { type: ['string', 'null'] },
    buildings: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['buildingLabel', 'units'],
        properties: {
          buildingLabel: { type: 'string' }, // '' = 単棟(棟名なし)。複数棟の場合 'A棟'/'B棟' 等
          units: {
            type: 'array',
            items: { $ref: '#/$defs/unit' },
          },
        },
      },
    },
    // 取込元の追跡情報(エラー報告・ナレッジベース記録に必須)
    sourceMeta: {
      type: 'object',
      required: ['sourceFileName', 'importedAt'],
      properties: {
        sourceFileName: { type: 'string' },
        sourceFileHash: { type: ['string', 'null'] }, // 重複検知用(SHA-256等)
        importedAt: { type: 'string' }, // ISO8601
        importBatchId: { type: ['string', 'null'] },
      },
    },
  },
  $defs: {
    unit: {
      type: 'object',
      required: ['zoneType', 'floorLabel', 'equipment'],
      properties: {
        zoneType: { enum: Object.values(ZONE_TYPES) },
        roomNumber: { type: ['string', 'null'] }, // 正規化済み(例:'101')。共用部等はnull可
        roomNumberRaw: { type: ['string', 'null'] }, // 元表記(例:'101号室'、'１０１')。監査用に保持
        displayLabel: { type: 'string' }, // 画面表示用ラベル(例:'101'、'共用部(エントランス)')
        floorLabel: { type: 'string' }, // 例:'8F'。共用部等でも '1F' 等が付く場合がある。無い場合は ''
        linkedRoomNumbers: { type: 'array', items: { type: 'string' } }, // メゾネット用: 跨る全部屋番号
        equipment: {
          type: 'array',
          items: {
            type: 'object',
            required: ['category', 'nameRaw'],
            properties: {
              category: { enum: Object.values(EQUIPMENT_CATEGORIES) },
              nameRaw: { type: 'string' }, // 元の設備名称表記
              nameNormalized: { type: 'string' }, // 正規化後の標準名称
              quantity: { type: ['number', 'null'] },
              attributes: { type: 'object' }, // maker/model/serial/year等、設備種別ごとの付加情報
            },
          },
        },
      },
    },
  },
});

module.exports = {
  ZONE_TYPES,
  ZONE_TYPE_REQUIRES_ROOM_NUMBER,
  EQUIPMENT_CATEGORIES,
  PROPERTY_FIELDS,
  PROPERTY_MASTER_SCHEMA,
};

    })(module, exports, require);
    return module;
  })();

  __ffModules["validator.js"] = (function () {
    var module = { exports: {} };
    var exports = module.exports;
    var require = function (spec) { return __ffRequire("validator.js", spec); };
    (function (module, exports, require) {
// validator.js
// ============================================================================
// 入力検証エンジン
// ============================================================================
// 正規化済みの行データ(rows: 1行1区画候補)を検証し、構造化されたissueの配列を
// 返す。issueは必ず「物件名・シート名・行番号・部屋番号・項目名・元の値・
// エラー原因・修正方法」を含む形にする(「読込失敗」とだけ表示することを禁止、
// というユーザー要求に対応するための最低限のフィールドセット)。

'use strict';

const { ERROR_CODES } = require('./errorTaxonomy.js');
const { ZONE_TYPES, ZONE_TYPE_REQUIRES_ROOM_NUMBER } = require('./fieldDictionary.js');

// issue生成のヘルパー。errorTaxonomyのコード情報からcategory/severityを引く。
function makeIssue(code, ctx) {
  const info = ERROR_CODES[code];
  if (!info) throw new Error('未登録のエラーコード: ' + code);
  return {
    code,
    category: info.category,
    severity: ctx.severityOverride || info.severity,
    propertyNameOrId: ctx.propertyNameOrId || null,
    sourceFileName: ctx.sourceFileName || null,
    sheetName: ctx.sheetName || null,
    rowNumber: ctx.rowNumber === undefined ? null : ctx.rowNumber,
    roomNumber: ctx.roomNumber === undefined ? null : ctx.roomNumber,
    fieldName: ctx.fieldName || null,
    originalValue: ctx.originalValue === undefined ? null : ctx.originalValue,
    message: ctx.message || info.message,
    estimatedCause: ctx.estimatedCause || null,
    suggestedFix: ctx.suggestedFix || info.suggestedFix,
  };
}

// 1棟分の正規化済みunit配列を検証する。
// units: [{ zoneType, roomNumber, roomNumberRaw, floorLabel, equipment, _row, _sheet }]
// (_row, _sheet は取込元へのトレース用に normalize 段階で付与しておく)
function validateUnits(units, context) {
  const issues = [];
  const seenRoomNumbers = new Map(); // roomNumber -> 最初に見つかった行

  for (const unit of units) {
    const rowCtx = Object.assign({}, context, { sheetName: unit._sheet, rowNumber: unit._row, roomNumber: unit.roomNumber });

    // ---- 必須項目チェック ----
    if (ZONE_TYPE_REQUIRES_ROOM_NUMBER[unit.zoneType] && !unit.roomNumber) {
      issues.push(makeIssue('EMPTY_REQUIRED_FIELD', Object.assign({}, rowCtx, {
        fieldName: 'roomNumber', originalValue: unit.roomNumberRaw,
        estimatedCause: '部屋番号のセルが空欄、または区画種別「' + unit.zoneType + '」に対して部屋番号が必須にもかかわらず抽出できなかった。',
      })));
    }
    if (!unit.floorLabel && unit.zoneType === ZONE_TYPES.UNIT) {
      issues.push(makeIssue('EMPTY_REQUIRED_FIELD', Object.assign({}, rowCtx, {
        fieldName: 'floorLabel', originalValue: unit.floorLabel,
        severityOverride: 'warning',
        estimatedCause: '階数を推定できる情報(部屋番号の桁数、階列など)が元データに無かった。',
      })));
    }

    // ---- 部屋番号の妥当性 ----
    if (unit.roomNumberRaw && !unit.roomNumber && ZONE_TYPE_REQUIRES_ROOM_NUMBER[unit.zoneType]) {
      issues.push(makeIssue('INVALID_ROOM_NUMBER', Object.assign({}, rowCtx, {
        fieldName: 'roomNumber', originalValue: unit.roomNumberRaw,
        estimatedCause: '部屋番号のセルに数字が含まれていなかった、または想定外の形式だった。',
      })));
    }

    // ---- 重複部屋番号チェック(同一物件・同一棟内) ----
    if (unit.roomNumber) {
      const key = (unit._building || '') + '::' + unit.roomNumber;
      if (seenRoomNumbers.has(key)) {
        const firstRow = seenRoomNumbers.get(key);
        issues.push(makeIssue('DUPLICATE_ROOM_NUMBER', Object.assign({}, rowCtx, {
          fieldName: 'roomNumber', originalValue: unit.roomNumberRaw,
          estimatedCause: (firstRow + 1) + '行目と' + (unit._row + 1) + '行目に同じ部屋番号「' + unit.roomNumber + '」が存在する。',
        })));
      } else {
        seenRoomNumbers.set(key, unit._row);
      }
    }

    // ---- 区画種別が未分類のまま ----
    if (unit.zoneType === ZONE_TYPES.UNCLASSIFIED) {
      issues.push(makeIssue('UNCLASSIFIED_ZONE', Object.assign({}, rowCtx, {
        fieldName: 'zoneType', originalValue: unit.displayLabel,
      })));
    }

    // ---- メゾネット候補の検出(同一部屋番号が複数階に記載されている等、
    //      呼び出し側でlinkedRoomNumbersを埋めていた場合) ----
    if (unit.linkedRoomNumbers && unit.linkedRoomNumbers.length > 1) {
      issues.push(makeIssue('MAISONETTE_DETECTED', Object.assign({}, rowCtx, {
        fieldName: 'linkedRoomNumbers', originalValue: unit.linkedRoomNumbers.join(','),
      })));
    }

    // ---- 同一住戸内の複数同種設備 ----
    const byCategory = {};
    for (const eq of unit.equipment || []) {
      byCategory[eq.category] = (byCategory[eq.category] || 0) + 1;
    }
    for (const cat of Object.keys(byCategory)) {
      if (byCategory[cat] > 1 && cat !== 'unclassified') {
        issues.push(makeIssue('MULTIPLE_EQUIPMENT_SAME_UNIT', Object.assign({}, rowCtx, {
          fieldName: 'equipment', originalValue: cat + ' x' + byCategory[cat],
        })));
      }
    }

    // ---- 設備名称が正規化できなかった ----
    for (const eq of unit.equipment || []) {
      if (eq.category === 'unclassified') {
        issues.push(makeIssue('EQUIPMENT_NAME_UNRESOLVED', Object.assign({}, rowCtx, {
          fieldName: 'equipment.nameRaw', originalValue: eq.nameRaw,
        })));
      }
    }
  }

  return issues;
}

// issue一覧から、読込画面向けのサマリー(総件数・正常・警告・エラー・読込可能・読込不可)を作る。
// 「行(unit)単位」で集計する: 1行にerror severityのissueが1つでもあれば読込不可、
// warningのみならwarning件数へ、issueが1つも無ければ正常件数へ。
function summarize(units, issues) {
  const issuesByRow = new Map();
  for (const issue of issues) {
    const key = (issue.sheetName || '') + '::' + issue.rowNumber;
    if (!issuesByRow.has(key)) issuesByRow.set(key, []);
    issuesByRow.get(key).push(issue);
  }
  let ok = 0, warn = 0, err = 0;
  for (const unit of units) {
    const key = (unit._sheet || '') + '::' + unit._row;
    const rowIssues = issuesByRow.get(key) || [];
    if (rowIssues.some((i) => i.severity === 'error')) err++;
    else if (rowIssues.length) warn++;
    else ok++;
  }
  return {
    totalCount: units.length,
    okCount: ok,
    warningCount: warn,
    errorCount: err,
    loadableCount: ok + warn,
    unloadableCount: err,
  };
}

module.exports = { validateUnits, summarize, makeIssue };

    })(module, exports, require);
    return module;
  })();

  __ffModules["formatParsers/inspectionReportSummary/governmentFormSokatsuhyoParser.js"] = (function () {
    var module = { exports: {} };
    var exports = module.exports;
    var require = function (spec) { return __ffRequire("formatParsers/inspectionReportSummary/governmentFormSokatsuhyoParser.js", spec); };
    (function (module, exports, require) {
// lib/formatParsers/inspectionReportSummary/governmentFormSokatsuhyoParser.js
//
// [2026-08-03新設] 新しいドキュメント種別(documentKind)「inspectionReportSummary」
// (点検結果報告書からの物件名・所在地・点検年月日等の基本情報抽出)の最初のParser。
//
// 【背景】これまで11物件分、点検結果報告書の「総括表」シートから物件名・所在地を
// 都度その場限りのPythonスクリプトで読み取っていた(3ファイルセットが本当に同じ物件の
// ものかを確認するため、毎回手作業で実施)。実際にこの確認漏れにより、9件目
// (グランプレイズ宝塚南口)で「グランドパレス上須磨」と一時的に取り違える事故が起きて
// いる。ユーザーからのご指示(2026-08-03)を受け、正式なParserとしてコード化した。
//
// 【フォーマットの性質】この「総括表」シートは、sensorZoneSummaryの「別紙(自)」と同じく
// 消防法施行規則の別記様式第２(全国共通の指定様式)であり、実際に確認した3物件
// (グランドパレス上須磨・コスモザ・パークイースト1・コスモフォレスタ箕面)全てで、
// ラベルと値の行・列位置が完全に一致していた。そのため列位置を固定的に扱うが、
// ラベル文字列自体はセル走査で見つける(行がズレても多少は追従できるようにする)方針にし、
// 「ラベルの右隣の列に値がある」という固定オフセットだけを前提とする設計にした。
'use strict';

function normalizeLabelText(v) {
  if (v == null) return '';
  return String(v).replace(/[\s　]+/g, '');
}

// Excelのシリアル値(SheetJSがcellDates:falseで読み込んだ場合の生の日付値)をISO日付文字列
// (YYYY-MM-DD)に変換する。1900年始まりのExcel日付システムを前提とする(標準的な変換式)。
function excelSerialToIsoDate(serial) {
  const utcDays = Math.floor(serial - 25569);
  const utcMs = utcDays * 86400 * 1000;
  const d = new Date(utcMs);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// 日付セルをISO日付文字列へ正規化する。「　年　月　日」のような未記入プレースホルダーや、
// 解釈できない値はnullを返す(捏造しない。呼び出し側はnullを「未記入」として扱う)。
function normalizeDateCell(v) {
  if (v == null) return null;
  if (typeof v === 'number' && Number.isFinite(v)) {
    return excelSerialToIsoDate(v);
  }
  if (Object.prototype.toString.call(v) === '[object Date]' && !Number.isNaN(v.getTime())) {
    const y = v.getUTCFullYear();
    const m = String(v.getUTCMonth() + 1).padStart(2, '0');
    const day = String(v.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
  if (typeof v === 'string') {
    const trimmed = v.trim();
    const isoMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
    const slashMatch = trimmed.match(/^(\d{4})[\/年](\d{1,2})[\/月](\d{1,2})/);
    if (slashMatch) {
      return `${slashMatch[1]}-${String(slashMatch[2]).padStart(2, '0')}-${String(slashMatch[3]).padStart(2, '0')}`;
    }
    return null; // 未記入プレースホルダー等、解釈できない文字列
  }
  return null;
}

// グリッド全体から、正規化後のラベルテキストが一致するセルを探す({row, col})。
function findLabelCell(grid, labelText) {
  for (let r = 0; r < (grid || []).length; r++) {
    const row = grid[r];
    if (!row) continue;
    for (let c = 0; c < row.length; c++) {
      if (normalizeLabelText(row[c]) === labelText) return { row: r, col: c };
    }
  }
  return null;
}

// [2026-08-03改訂] 「点検種別」も必須見出しに追加(実データ3件全てで確認済み)。
const REQUIRED_LABELS = ['名称', '所在地', '点検年月日', '点検種別'];
// 実データ3件では、見出しブロック(名称〜点検種別・点検年月日)は全てシート先頭7行目
// までに収まっていた。無関係なシート・巨大なシートの中に断片的にラベル語が散らばって
// いるだけの誤検出を防ぐため、想定される見出しブロックの範囲(先頭15行、実データの
// 実測値に安全マージンを加えた値)を超える位置にある場合はdetectを失敗させる。
const MAX_HEADER_ROW = 15;

function detect(grid) {
  if (!Array.isArray(grid)) return { matches: false, confidence: 0 };
  const cells = {};
  for (const label of REQUIRED_LABELS) {
    cells[label] = findLabelCell(grid, label);
  }
  const foundLabels = REQUIRED_LABELS.filter((label) => cells[label] != null);
  if (foundLabels.length < REQUIRED_LABELS.length) {
    return {
      matches: false,
      confidence: 0,
      reason: `必須ラベル(${REQUIRED_LABELS.join('・')})のうち${foundLabels.length}件しか見つからない`,
    };
  }

  // ---- 想定位置チェック(固定セル位置ではなく、見出し同士の相対位置・範囲による確認) ----
  const rows = REQUIRED_LABELS.map((label) => cells[label].row);
  const maxRow = Math.max(...rows);
  if (maxRow > MAX_HEADER_ROW) {
    return {
      matches: false,
      confidence: 0,
      reason: `必須ラベルは全て見つかったが、想定される見出しブロックの範囲(先頭${MAX_HEADER_ROW}行以内)を超えた位置(${maxRow}行目)にあるため、この様式として扱わない(無関係なシートでの偶然の一致を避けるため)`,
    };
  }
  if (cells['名称'].row > cells['所在地'].row) {
    return {
      matches: false,
      confidence: 0,
      reason: '「名称」が「所在地」より下の行にあり、様式の想定される見出し順序(名称→所在地→点検種別/点検年月日)と一致しないため、この様式として扱わない',
    };
  }

  const hasFormTitle = (grid || []).some(
    (row) => row && row.some((v) => v != null && /点検結果総括表|別記様式/.test(String(v)))
  );
  const confidence = hasFormTitle ? 0.95 : 0.75;
  return {
    matches: true,
    confidence,
    reason: `必須ラベル全件検出(名称・所在地・点検種別・点検年月日)、想定される見出し順序・範囲にも一致。様式タイトル文言: ${hasFormTitle ? 'あり' : 'なし'}`,
  };
}

function parse(grid) {
  const warnings = [];

  function readValueRightOf(labelText, fieldNameForWarning) {
    const cell = findLabelCell(grid, labelText);
    if (!cell) {
      warnings.push({ code: 'SUMMARY_LABEL_NOT_FOUND', detail: `「${labelText}」ラベルが見つかりませんでした。`, fieldName: fieldNameForWarning });
      return null;
    }
    const row = grid[cell.row];
    const value = row ? row[cell.col + 1] : null;
    if (value == null || String(value).trim() === '') {
      warnings.push({ code: 'SUMMARY_VALUE_EMPTY', detail: `「${labelText}」の値が空欄です。`, fieldName: fieldNameForWarning, row: cell.row, col: cell.col + 1 });
      return null;
    }
    return value;
  }

  const nameRaw = readValueRightOf('名称', 'propertyName');
  const propertyName = nameRaw != null ? String(nameRaw).trim() : null;
  if (propertyName != null && !Number.isNaN(Number(propertyName))) {
    // 「防火管理者」列と読み間違えているケース等、名称が数値(0等)になっている場合は
    // 明らかに異常なため、値は保持しつつ警告を出す(捏造せず、そのまま伝える)。
    warnings.push({ code: 'SUMMARY_PROPERTY_NAME_SUSPICIOUS', detail: `物件名が数値的な値("${propertyName}")になっており、正しく読み取れていない可能性があります。`, fieldName: 'propertyName' });
  }

  const addressRaw = readValueRightOf('所在地', 'address');
  const address = addressRaw != null ? String(addressRaw).trim() : null;

  const inspectionTypeCell = findLabelCell(grid, '点検種別');
  let inspectionType = null;
  if (inspectionTypeCell) {
    const row = grid[inspectionTypeCell.row];
    const value = row ? row[inspectionTypeCell.col + 1] : null;
    inspectionType = value != null ? String(value).trim() : null;
  }

  const dateLabelCell = findLabelCell(grid, '点検年月日');
  let inspectionDateStart = null;
  let inspectionDateEnd = null;
  if (dateLabelCell) {
    const row = grid[dateLabelCell.row];
    const startRaw = row ? row[dateLabelCell.col + 1] : null;
    const endRaw = row ? row[dateLabelCell.col + 3] : null; // 間の列(col+2)は「～」区切り
    inspectionDateStart = normalizeDateCell(startRaw);
    inspectionDateEnd = normalizeDateCell(endRaw);
    if (inspectionDateStart == null && startRaw != null) {
      warnings.push({ code: 'INSPECTION_DATE_INCOMPLETE', detail: `点検年月日(開始)が未記入または解釈できない値でした(原本の値: ${JSON.stringify(startRaw)})。`, fieldName: 'inspectionDateStart' });
    }
    if (inspectionDateEnd == null && endRaw != null) {
      warnings.push({ code: 'INSPECTION_DATE_INCOMPLETE', detail: `点検年月日(終了)が未記入または解釈できない値でした(原本の値: ${JSON.stringify(endRaw)})。`, fieldName: 'inspectionDateEnd' });
    }
  } else {
    warnings.push({ code: 'SUMMARY_LABEL_NOT_FOUND', detail: '「点検年月日」ラベルが見つかりませんでした。', fieldName: 'inspectionDateStart' });
  }

  return {
    propertyName,
    address,
    inspectionType,
    inspectionDateStart,
    inspectionDateEnd,
    warnings,
  };
}

module.exports = {
  id: 'inspectionReportSummary.governmentFormSokatsuhyo.v1',
  label: '消防法施行規則・別記様式第２「点検結果総括表」形式',
  detect,
  parse,
};

    })(module, exports, require);
    return module;
  })();

  __ffModules["formatParsers/inspectionReportSummary/index.js"] = (function () {
    var module = { exports: {} };
    var exports = module.exports;
    var require = function (spec) { return __ffRequire("formatParsers/inspectionReportSummary/index.js", spec); };
    (function (module, exports, require) {
// lib/formatParsers/inspectionReportSummary/index.js
//
// [2026-08-03新設]「点検結果報告書からの物件名・所在地・点検年月日等の基本情報」
// (inspectionReportSummary)ドキュメント種別のフォーマット別Parserを登録した
// レジストリ。roomRoster/index.js・sensorCount/index.jsと同じ構成。
'use strict';

const { createFormatParserRegistry } = require('../registry.js');
const governmentFormSokatsuhyoParser = require('./governmentFormSokatsuhyoParser.js');

const inspectionReportSummaryRegistry = createFormatParserRegistry('inspectionReportSummary');
inspectionReportSummaryRegistry.register(governmentFormSokatsuhyoParser);

function parseInspectionReportSummarySheet(grid) {
  return inspectionReportSummaryRegistry.autoParse(grid);
}

module.exports = { inspectionReportSummaryRegistry, parseInspectionReportSummarySheet };

    })(module, exports, require);
    return module;
  })();

  __ffModules["formatParsers/crossValidate.js"] = (function () {
    var module = { exports: {} };
    var exports = module.exports;
    var require = function (spec) { return __ffRequire("formatParsers/crossValidate.js", spec); };
    (function (module, exports, require) {
// lib/formatParsers/crossValidate.js
//
// [2026-08-03新設、2026-08-03改訂] 捺印表(roomRoster)・感知器数(sensorCount)・
// 点検結果報告書(inspectionReportSummary)の3ドキュメント種別を1セットとして読み込んだ際の、
// ファイル間の整合性を自動確認するValidation Engine。
//
// 【位置づけ】これまで11物件分、「捺印表の部屋一覧と感知器数ファイルの部屋一覧を
// 突き合わせて確認する」作業を、私(Claude)がその場限りのPythonスクリプトで
// 手作業実施していた。この手作業により実際に「グランプレイズ宝塚南口」を
// 「グランドパレス上須磨」と一時的に取り違える事故が起きている。本モジュールは
// その手作業を正式なコードとして置き換えるもの。
//
// 【2026-08-03改訂】ユーザーからの追加ご指示を受け、以下を修正・強化した。
//   1. checkPropertyIdentityConsistencyを、会話履歴や「直前にやり取りしていた物件」
//      といった暗黙の状態に一切依存しない設計に修正した。比較対象は、呼び出し側が
//      明示的に渡す(a) expectedProperty({name, address})、または(b) 同一処理対象
//      セットに含まれる複数ファイルから抽出した物件名・所在地同士、のいずれかのみとする。
//   2. 物件名だけでなく所在地も正規化比較の対象に加えた。
//   3. 完全一致ではなく、Levenshtein距離ベースの類似度で「表記ゆれ(warning)」と
//      「明確な別物件(error)」を区別するようにした。
//   4. 明確な別物件(error)が1件でも検出された場合、crossValidateInputSet()は
//      それ以降の部屋一覧・階構成の突合処理を中止する(異なる物件のデータを
//      誤って組み合わせて突合してしまうことを防ぐ)。
//   5. compareRoomLists / compareFloorStructureは、roomRoster側でspaceTypeが
//      'unit'(住戸)と判定された部屋のみを比較対象とし、管理人室・店舗・共用部等を
//      誤って住戸の欠落として扱わないようにした。
//
// 【設計方針】
// - 3ファイルとも揃っている必要はない。渡された組み合わせだけを検証する
//   (例: roomRosterとsensorCountだけでもcompareRoomLists/compareFloorStructureは実行できる)。
// - どのチェックも、判定に必要なデータが欠けている場合は「不一致」ではなく
//   「スキップ」する(不明を不一致と誤判定して不要な警告を出さない)。
// - issueは既存のvalidator.js(pipeline.js側、別ドキュメント種別向けに先に存在していた
//   Validation Engine)のmakeIssue()と同じ構造化フィールドセットで返す
//   ({code, category, severity, propertyNameOrId, sourceFileName, sheetName, rowNumber,
//   roomNumber, fieldName, originalValue, message, estimatedCause, suggestedFix})。
//   エラーコード(ROOM_LIST_MISMATCH / FLOOR_STRUCTURE_MISMATCH / PROPERTY_IDENTITY_MISMATCH /
//   PROPERTY_IDENTITY_NOTATION_VARIANCE)はerrorTaxonomy.jsに追加登録済み。
//
// 【既知の限界】compareFloorStructureは、roomRoster側の階構成(捺印表から読み取った
// 実際の階ラベル)を基準にして、sensorCount側にその階の部屋が何室確認できるかを
// 突き合わせるものであり、sensorCount側が独自に持つ階構造との「双方向」比較ではない。
// これは、既存のsensorCount系Parser群(totalOnlyGridFormat等)が、canonical出力
// (sensorMaster)に階ラベル自体を含めない設計になっているため(内部的には階ラベルを
// 見出し行検出に使っているが、部屋番号→値の辞書としてのみ出力している)。この出力形式は
// 既存の全sensorCount Parserおよびそのテスト群に影響するため、今回は変更せず、
// 「roomRoster側の階構成を正とした、sensorCount側の充足率チェック」として実装する
// (次フェーズでsensorCount側のcanonical出力に階ラベルを追加するかどうかは、
// 既存出力形式への影響を含め別途検討が必要な設計判断としてユーザー確認を要する)。
//
// また、detectDuplicateOrMissingRoomNumbersについても同様の限界がある。sensorCount系
// Parser群は現状、パース時に部屋番号をキーとした辞書へ直接格納する実装になっており、
// 同一部屋番号が原本内に複数回出現した場合、後勝ちで無警告のまま上書きされる
// (roomRoster.gridFormatParserはROOM_NUMBER_DUPLICATE警告を出す設計になっているのに対し、
// sensorCount側には同等の重複検出が無い、という非対称)。crossValidateはパース後の
// 辞書(canonical出力)しか受け取れないため、この時点では重複の有無を復元できない。
// sensorCount側Parser群自体への重複検出追加は、既存の実データ回帰テスト群への影響を
// 検証しながら行う必要があるため、今回のスコープには含めず、既知の未対応課題として
// 明示しておく(捏造・黙殺をしない、という方針に基づき、ここで正直に記録する)。
//
// また、物件名・所在地の抽出は現状inspectionReportSummaryドキュメント種別からのみ
// 可能(roomRoster・sensorCountの各Parserは、現時点で物件名・所在地を抽出する
// フィールドを持たない)。checkPropertyIdentityConsistencyの「各ファイルから抽出した
// 物件名・所在地同士の比較」は、同一セット内に複数のinspectionReportSummary結果が
// 含まれる場合(例: 機器点検報告書・総合点検報告書が別ファイルとして提供され、
// それぞれに総括表がある場合)を主に想定している。
'use strict';

const { makeIssue } = require('../validator.js');

function normalizeNameForCompare(name) {
  if (name == null) return '';
  return String(name).replace(/[\s　]+/g, '');
}

// --- Levenshtein距離(編集距離)。外部ライブラリに依存せず、物件名・所在地の
//     「表記ゆれ」と「明確な別物件」を区別するための類似度計算に使う。 ---
function levenshteinDistance(a, b) {
  a = a || '';
  b = b || '';
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(
        dp[j] + 1,
        dp[j - 1] + 1,
        prev + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
      prev = tmp;
    }
  }
  return dp[n];
}

function similarityRatio(a, b) {
  const na = normalizeNameForCompare(a);
  const nb = normalizeNameForCompare(b);
  if (na === nb) return 1;
  const maxLen = Math.max(na.length, nb.length);
  if (maxLen === 0) return 1;
  return 1 - levenshteinDistance(na, nb) / maxLen;
}

// 類似度がこの値以上なら「表記ゆれ」(warning)、未満なら「明確な別物件」(error)と判定する。
// 実データでの検証事例は無いため暫定値。運用しながら誤判定が見つかれば調整する前提の値。
const NOTATION_VARIANCE_SIMILARITY_THRESHOLD = 0.6;

function classifyNameMatch(a, b) {
  if (a == null || b == null) return null; // 比較不能(片方が未抽出)
  const ratio = similarityRatio(a, b);
  if (ratio === 1) return { verdict: 'match', ratio };
  if (ratio >= NOTATION_VARIANCE_SIMILARITY_THRESHOLD) return { verdict: 'notation_variance', ratio };
  return { verdict: 'different', ratio };
}

const FIELD_LABELS = { propertyName: '物件名', address: '所在地' };

function buildIdentityIssues(fieldName, extracted, comparedTo, comparedToLabel, context) {
  const match = classifyNameMatch(extracted, comparedTo);
  if (!match || match.verdict === 'match') return [];
  const isError = match.verdict === 'different';
  const code = isError ? 'PROPERTY_IDENTITY_MISMATCH' : 'PROPERTY_IDENTITY_NOTATION_VARIANCE';
  const label = FIELD_LABELS[fieldName] || fieldName;
  return [makeIssue(code, Object.assign({}, context, {
    fieldName,
    originalValue: extracted,
    message: `${label}「${extracted}」が、${comparedToLabel}「${comparedTo}」と一致しません(類似度: ${Math.round(match.ratio * 100)}%)。`,
    estimatedCause: isError
      ? '異なる物件のファイルを誤って同じセットに含めている可能性があります。'
      : '住所の書き方の違いやスペースの有無等、表記ゆれの可能性があります。念のためご確認ください。',
  }))];
}

// --- ① 捺印表(roomRoster)のうち、住戸(spaceType:'unit')の部屋のみを対象に部屋番号一覧を取り出す ---
// (管理人室・店舗・共用部等をspaceType:'non_unit'として検出済みの場合、それらは
//  住戸の欠落として誤って扱わないよう、比較対象から除外する)
function unitRoomsOf(roomRosterResult) {
  const rooms = (roomRosterResult && roomRosterResult.ok && roomRosterResult.data && roomRosterResult.data.rooms) || {};
  const result = {};
  for (const roomNumber of Object.keys(rooms)) {
    const room = rooms[roomNumber];
    if (room && room.spaceType && room.spaceType !== 'unit') continue;
    result[roomNumber] = room;
  }
  return result;
}

function computeUnitFloors(roomRosterResult) {
  const rooms = unitRoomsOf(roomRosterResult);
  const floors = {};
  for (const roomNumber of Object.keys(rooms)) {
    const fl = rooms[roomNumber].floorLabel;
    if (fl == null) continue;
    if (!floors[fl]) floors[fl] = { roomNumbers: [], roomCount: 0 };
    floors[fl].roomNumbers.push(roomNumber);
    floors[fl].roomCount++;
  }
  for (const fl of Object.keys(floors)) floors[fl].roomNumbers.sort((a, b) => Number(a) - Number(b));
  return floors;
}

// --- ② 捺印表(住戸のみ)とsensorCountの部屋番号一覧を比較する ---
// (部屋数の一致・不一致だけでなく、部屋番号の集合そのものを完全比較する。
//  片方にしかない部屋番号を1件ずつ全て列挙する)
function compareRoomLists(roomRosterResult, sensorCountResult, context) {
  const issues = [];
  if (!roomRosterResult || !roomRosterResult.ok || !sensorCountResult || !sensorCountResult.ok) {
    return issues; // 片方が欠けている、または未対応フォーマットで失敗している場合はスキップ
  }
  const rosterRooms = unitRoomsOf(roomRosterResult);
  const sensorRooms = sensorCountResult.data.sensorMaster || {};
  const rosterSet = new Set(Object.keys(rosterRooms));
  const sensorSet = new Set(Object.keys(sensorRooms));

  for (const roomNumber of rosterSet) {
    if (!sensorSet.has(roomNumber)) {
      issues.push(makeIssue('ROOM_LIST_MISMATCH', Object.assign({}, context, {
        fieldName: 'roomNumber',
        roomNumber,
        originalValue: roomNumber,
        message: `部屋番号「${roomNumber}」は捺印表(住戸)にありますが、感知器数ファイルには見つかりません。`,
        estimatedCause: '感知器数ファイル側での記載漏れ・値の読み取り失敗、または部屋番号の表記違いの可能性があります。',
      })));
    }
  }
  for (const roomNumber of sensorSet) {
    if (!rosterSet.has(roomNumber)) {
      issues.push(makeIssue('ROOM_LIST_MISMATCH', Object.assign({}, context, {
        fieldName: 'roomNumber',
        roomNumber,
        originalValue: roomNumber,
        message: `部屋番号「${roomNumber}」は感知器数ファイルにありますが、捺印表(住戸)には見つかりません。`,
        estimatedCause: '捺印表側での記載漏れ、部屋番号の表記違い、捺印表作成後に増えた部屋(増築等)、または捺印表側でspaceTypeが住戸以外と判定されている(誤判定の可能性含む)可能性があります。',
      })));
    }
  }
  return issues;
}

// --- ③ 捺印表側(住戸のみ)の階ごとの部屋数と、sensorCount側でその階の部屋が
//        何室確認できるかを比較する ---
// (前述の【既知の限界】の通り、sensorCount側は独自の階ラベルを持たないため、
//  roomRoster側の階構成を基準にした片方向の充足率チェックとなる)
function compareFloorStructure(roomRosterResult, sensorCountResult, context) {
  const issues = [];
  if (!roomRosterResult || !roomRosterResult.ok || !sensorCountResult || !sensorCountResult.ok) {
    return issues;
  }
  const floors = computeUnitFloors(roomRosterResult);
  const sensorRooms = sensorCountResult.data.sensorMaster || {};

  for (const floorLabel of Object.keys(floors)) {
    const floor = floors[floorLabel];
    const missing = floor.roomNumbers.filter((r) => !Object.prototype.hasOwnProperty.call(sensorRooms, r));
    if (missing.length > 0) {
      issues.push(makeIssue('FLOOR_STRUCTURE_MISMATCH', Object.assign({}, context, {
        fieldName: 'floorLabel',
        originalValue: floorLabel,
        message: `${floorLabel}: 捺印表(住戸)側は${floor.roomCount}部屋ですが、感知器数ファイル側で確認できたのは${floor.roomCount - missing.length}部屋です(未確認: ${missing.join('、')})。`,
        estimatedCause: '感知器数ファイル側での記載漏れ・値の読み取り失敗の可能性があります。',
      })));
    }
  }
  return issues;
}

// --- ④ 点検結果報告書から抽出した物件名・所在地が、比較対象と一致するかを確認する ---
// (グランプレイズ宝塚南口をグランドパレス上須磨と一時的に取り違えた事故の再発防止。
//  会話履歴や「直前にやり取りしていた物件」等の暗黙の状態には一切依存せず、
//  以下の2種類の「明示的に渡された比較対象」のみを使う)
//
// inspectionReportSummaryResults: 単一のautoParse()結果、またはその配列
//   (同一セットに複数の点検結果報告書ファイルが含まれる場合、それぞれの総括表から
//   抽出した物件名・所在地同士を突き合わせる)
// expectedProperty: { name: string|null, address: string|null } | null
//   (呼び出し側がこの処理対象セットの対象物件として明示的に渡す値。省略した場合は
//   この比較はスキップする=不明を不一致と誤判定しない)
function checkPropertyIdentityConsistency(inspectionReportSummaryResults, expectedProperty, context) {
  const issues = [];
  const results = Array.isArray(inspectionReportSummaryResults)
    ? inspectionReportSummaryResults
    : (inspectionReportSummaryResults ? [inspectionReportSummaryResults] : []);
  const okResults = results.filter((r) => r && r.ok && r.data);

  // (a) 明示的に渡されたexpectedPropertyとの比較
  if (expectedProperty && (expectedProperty.name != null || expectedProperty.address != null)) {
    for (const r of okResults) {
      if (expectedProperty.name != null && r.data.propertyName != null) {
        issues.push(...buildIdentityIssues('propertyName', r.data.propertyName, expectedProperty.name, '指定された対象物件名(expectedProperty.name)', context));
      }
      if (expectedProperty.address != null && r.data.address != null) {
        issues.push(...buildIdentityIssues('address', r.data.address, expectedProperty.address, '指定された対象所在地(expectedProperty.address)', context));
      }
    }
  }

  // (b) 同一セット内の複数ファイルから抽出した物件名・所在地同士の比較
  for (let i = 0; i < okResults.length; i++) {
    for (let j = i + 1; j < okResults.length; j++) {
      const a = okResults[i];
      const b = okResults[j];
      if (a.data.propertyName != null && b.data.propertyName != null) {
        issues.push(...buildIdentityIssues('propertyName', a.data.propertyName, b.data.propertyName, `セット内の他ファイル(${j + 1}件目)の物件名`, context));
      }
      if (a.data.address != null && b.data.address != null) {
        issues.push(...buildIdentityIssues('address', a.data.address, b.data.address, `セット内の他ファイル(${j + 1}件目)の所在地`, context));
      }
    }
  }

  return issues;
}

// --- ⑤ 各ソース単体での、部屋番号の桁数異常等の再点検 ---
// (重複検出についての限界は、本ファイル冒頭の【既知の限界】を参照)
function detectDuplicateOrMissingRoomNumbers(sourceResult, sourceLabel, context) {
  const issues = [];
  if (!sourceResult || !sourceResult.ok) return issues;
  const roomsDict = sourceResult.data.rooms || sourceResult.data.sensorMaster;
  if (!roomsDict) return issues;
  for (const roomNumber of Object.keys(roomsDict)) {
    if (!/^\d{2,4}$/.test(roomNumber)) {
      issues.push(makeIssue('INVALID_ROOM_NUMBER', Object.assign({}, context, {
        fieldName: 'roomNumber',
        roomNumber,
        originalValue: roomNumber,
        message: `${sourceLabel}側の部屋番号「${roomNumber}」が想定される桁数(2〜4桁の数字)と異なります。`,
      })));
    }
  }
  return issues;
}

// --- 各Parserが既に検出済みのwarningsを、crossValidateの統一issue形式に変換してまとめる ---
// (crossValidate自身が新たに検出しているのではなく、複数箇所に分散している既存の
//  warningsを1箇所で見られるようにする、形式変換のみの処理)
function collectSourceWarningsAsIssues(parseResults, context) {
  const issues = [];
  const sourceLabels = { roomRoster: '捺印表', sensorCount: '感知器数ファイル', inspectionReportSummary: '点検結果報告書' };
  for (const key of Object.keys(parseResults || {})) {
    const result = parseResults[key];
    if (!result) continue;
    const items = Array.isArray(result) ? result : [result];
    for (const single of items) {
      if (!single || !single.ok || !single.data || !Array.isArray(single.data.warnings)) continue;
      for (const w of single.data.warnings) {
        issues.push({
          code: w.code || 'SOURCE_WARNING',
          category: null,
          severity: 'warning',
          propertyNameOrId: (context && context.propertyNameOrId) || null,
          sourceFileName: null,
          sheetName: null,
          rowNumber: w.row != null ? w.row : null,
          roomNumber: w.room || w.roomNumber || null,
          fieldName: w.fieldName || null,
          originalValue: null,
          message: `[${sourceLabels[key] || key}] ${w.detail || w.message || w.code}`,
          estimatedCause: null,
          suggestedFix: null,
          sourceDocumentKind: key,
        });
      }
    }
  }
  return issues;
}

// --- エントリーポイント: 揃っている組み合わせだけを検証し、統一されたissue配列を返す ---
// input: {
//   roomRoster: autoParse()結果|null,
//   sensorCount: autoParse()結果|null,
//   inspectionReportSummary: autoParse()結果|autoParse()結果の配列|null,
//   expectedProperty: { name: string|null, address: string|null } | null,
//   context: { propertyNameOrId, sourceFileName など。issueへそのまま引き継がれる }
// }
//
// 物件名・所在地が明確に別物件だと判定された(PROPERTY_IDENTITY_MISMATCH、severity:error)
// 場合、それ以降の部屋一覧・階構成の突合処理は中止する(summary.aborted = true)。
// 異なる物件のデータを誤って組み合わせて「部屋が足りない」等の誤った警告を出すことを防ぐため。
function crossValidateInputSet(input) {
  input = input || {};
  const context = input.context || {};

  const identityIssues = checkPropertyIdentityConsistency(input.inspectionReportSummary, input.expectedProperty, context);
  const hasFatalIdentityMismatch = identityIssues.some((i) => i.code === 'PROPERTY_IDENTITY_MISMATCH' && i.severity === 'error');

  if (hasFatalIdentityMismatch) {
    return {
      issues: identityIssues,
      summary: {
        totalIssueCount: identityIssues.length,
        errorCount: identityIssues.filter((i) => i.severity === 'error').length,
        warningCount: identityIssues.filter((i) => i.severity === 'warning').length,
        aborted: true,
        abortReason: '物件名・所在地が明確に別物件と判定されたため、部屋一覧・階構成の突合処理を中止しました。異なる物件のファイルを同じセットに含めていないかご確認ください。',
      },
    };
  }

  const issues = [];
  issues.push(...identityIssues);
  issues.push(...compareRoomLists(input.roomRoster, input.sensorCount, context));
  issues.push(...compareFloorStructure(input.roomRoster, input.sensorCount, context));
  issues.push(...detectDuplicateOrMissingRoomNumbers(input.roomRoster, '捺印表', context));
  issues.push(...detectDuplicateOrMissingRoomNumbers(input.sensorCount, '感知器数ファイル', context));
  issues.push(...collectSourceWarningsAsIssues({
    roomRoster: input.roomRoster,
    sensorCount: input.sensorCount,
    inspectionReportSummary: input.inspectionReportSummary,
  }, context));

  const errorCount = issues.filter((i) => i.severity === 'error').length;
  const warningCount = issues.filter((i) => i.severity === 'warning').length;

  return {
    issues,
    summary: { totalIssueCount: issues.length, errorCount, warningCount, aborted: false },
  };
}

module.exports = {
  compareRoomLists,
  compareFloorStructure,
  checkPropertyIdentityConsistency,
  detectDuplicateOrMissingRoomNumbers,
  collectSourceWarningsAsIssues,
  crossValidateInputSet,
};

    })(module, exports, require);
    return module;
  })();

  global.FireFlowIngest = {
    parseRoomRosterSheet: __ffModules["formatParsers/roomRoster/index.js"].exports.parseRoomRosterSheet,
    parseSensorCountSheet: __ffModules["formatParsers/sensorCount/index.js"].exports.parseSensorCountSheet,
    toPropertyMasterIntake: __ffModules["toPropertyMasterIntake.js"].exports.toPropertyMasterIntake,
    FSDF_VERSION: __ffModules["toPropertyMasterIntake.js"].exports.FSDF_VERSION,
    DOCUMENT_TYPE: __ffModules["toPropertyMasterIntake.js"].exports.DOCUMENT_TYPE,
    crossValidateInputSet: __ffModules["formatParsers/crossValidate.js"].exports.crossValidateInputSet,
    parseInspectionReportSummarySheet: __ffModules["formatParsers/inspectionReportSummary/index.js"].exports.parseInspectionReportSummarySheet,
  };
})(typeof window !== "undefined" ? window : this);
