// Phase6「⑥原紙プレビュー」: HTML/Canvas(実際には軽量なHTML絶対配置)で、原紙プレビューを
// ブラウザDOM上に描画するコントローラ。
//
// 【設計方針】判定ロジック(どのセルに・どの色で・どのテキストを表示するか)は一切ここに
// 持たない。全て fireflow_template_engine/preview_adapter.js の buildPreviewOutput() が
// 組み立てたPreviewOutput(構造化データ)をそのまま描画するだけの薄いDOM構築層とする
// (Phase3のocr_confirm_screen.js/row_view_model.jsの関心分離パターンを踏襲)。
//
// 【PreviewRendererインターフェースの実装】
//   render(input): PreviewOutput ... preview_adapter.js の buildPreviewOutput をそのまま公開する
//                  (副作用なし。Node上でも動く。本ファイルを読み込まなくてもrender()は使える)。
//   mount(container, previewOutput): void ... render()の出力を受け取り、DOMを構築する
//                  (ブラウザ専用。本ファイルの主目的)。
// 将来、Phase5の書き込み結果を画像化/PDF化する`ExcelPdfPreviewRenderer`を追加する場合も、
// render()が同じ形のPreviewOutputを返しさえすれば、この mount() をそのまま流用できるか、
// 同じ形のmount()を持つ別レンダラーに差し替えるだけで済む(呼び出し側の変更が要らない)。
//
// 【必須要件(design書5章⑥・8章確認事項3への回答)】画面には必ず「これは簡易プレビューです。
// 実際の印刷結果とは異なる場合があります」等、簡易プレビューであることを明示する表示を含める。
//
// 【将来のOCR確認画面との双方向ナビゲーション接続に備えて】各部屋の表示要素には
// data-room-number属性(ocr_confirm_screen.jsの一覧行と同じ属性名)を付与する。今回は
// 接続自体は実装しない(design書・ユーザー指示によりスコープ外)。
//
// 本ファイルはDOM操作(ブラウザ専用)のため、ブラウザでのみ動作する。Node環境では何もしない。
'use strict';

(function () {
  if (typeof window === 'undefined') return; // Node環境では何もしない(DOM操作不可のため)。

  var TemplateEngineNS = window.FireFlowTemplateEngine || {};
  var OcrConfirmNS = window.FireFlowOcrConfirm || {};

  function escapeHtml(s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function metaLine(previewOutput) {
    var meta = previewOutput.meta || {};
    var parts = [];
    if (meta.propertyName) parts.push(escapeHtml(meta.propertyName));
    if (previewOutput.propertyId) parts.push('(' + escapeHtml(previewOutput.propertyId) + ')');
    if (meta.inspectionDate) parts.push(escapeHtml(meta.inspectionDate));
    parts.push('工程: 全' + (meta.totalScheduleDays || 1) + '日');
    return parts.join(' / ');
  }

  function renderRoomCard(room) {
    var style = '';
    if (room.fillColor) style += 'background-color:' + room.fillColor + ';';
    var textStyle = room.fontColor ? 'color:' + room.fontColor + ';' : '';
    var warnBadge = (room.warnings && room.warnings.length) ? '<span class="ffp-room-warn-badge" title="' + escapeHtml(room.warnings.map(function (w) { return w.message; }).join(' / ')) + '">⚠</span>' : '';
    // 【Phase6承認時のご指示2番】room.sourceがあればそちらを正とし、無い場合(将来previewVersion違いの
    // 古いPreviewOutputを渡された場合等)は個別フィールド(roomNumber/cellRef)にフォールバックする。
    var src = room.source || { roomNumber: room.roomNumber, sheet: null, cell: room.cellRef };
    return '<div class="ffp-preview-room" data-room-number="' + escapeHtml(src.roomNumber) + '" data-room-id="' + escapeHtml(room.roomId) + '" data-cell-ref="' + escapeHtml(src.cell) + '" data-sheet-name="' + escapeHtml(src.sheet) + '" style="' + style + '">' +
      '<div class="ffp-room-number">' + escapeHtml(room.roomNumber) + '号室' + warnBadge + '</div>' +
      '<div class="ffp-room-text" style="' + textStyle + '">' + (room.text ? escapeHtml(room.text) : '(表示なし)') + '</div>' +
      '<div class="ffp-room-cellref">' + escapeHtml(room.cellRef) + '</div>' +
      '</div>';
  }

  function renderSheet(sheet) {
    return '<section class="ffp-preview-sheet" data-sheet-name="' + escapeHtml(sheet.sheetName) + '">' +
      '<h3 class="ffp-sheet-title">シート: ' + escapeHtml(sheet.sheetName) + '</h3>' +
      '<div class="ffp-room-grid">' + sheet.rooms.map(renderRoomCard).join('') + '</div>' +
      '</section>';
  }

  function renderWarningsPanel(previewOutput) {
    var warnings = previewOutput.warnings || [];
    var unmapped = previewOutput.unmappedRooms || [];
    if (!warnings.length && !unmapped.length) return '';
    var html = '<div class="ffp-preview-warnings">';
    if (unmapped.length) {
      html += '<div class="ffp-warn-line ffp-warn-unmapped">⚠ テンプレートに未マッピングのためプレビューに表示されていない部屋: ' + unmapped.map(escapeHtml).join(', ') + '</div>';
    }
    warnings.forEach(function (w) {
      html += '<div class="ffp-warn-line">⚠ ' + escapeHtml(w.message) + '</div>';
    });
    html += '</div>';
    return html;
  }

  // 【Phase6承認時のご指示1番】previewVersionが、このRendererが対応しているバージョンかどうかを
  // 判定する。未対応(将来の破壊的スキーマ変更で上がったバージョン等)でも例外は投げず、
  // 非ブロッキングの警告バナーを追加表示した上で、できる範囲で描画を試みる(グレースフル
  // デグレード。プレビューはあくまで補助機能であり、これが原因で画面が真っ白になることを避ける)。
  function checkPreviewVersionCompat(previewOutput) {
    var version = previewOutput.previewVersion;
    if (version === undefined || version === null) return null; // previewVersionを持たない旧形式は対象外(常に許容)
    if (TemplateEngineNS.isPreviewOutputVersionSupported) {
      if (TemplateEngineNS.isPreviewOutputVersionSupported(version)) return null;
    } else if (TemplateEngineNS.PREVIEW_OUTPUT_SUPPORTED_VERSIONS && TemplateEngineNS.PREVIEW_OUTPUT_SUPPORTED_VERSIONS.indexOf(version) !== -1) {
      return null;
    }
    return '⚠ このPreviewOutputのバージョン(' + escapeHtml(version) + ')は、このプレビュー画面(renderer: ' +
      escapeHtml(previewOutput.renderer || '不明') + ')が想定しているバージョンと異なります。' +
      '表示が崩れる場合があります。画面の再読み込みをお試しください。';
  }

  // container: 描画先のDOM要素。previewOutput: preview_adapter.jsのbuildPreviewOutput()の戻り値。
  function mount(container, previewOutput) {
    if (!container) throw new Error('mount: containerが指定されていません。');
    if (!previewOutput) throw new Error('mount: previewOutputが指定されていません。');

    var versionWarning = checkPreviewVersionCompat(previewOutput);
    var versionWarningHtml = versionWarning
      ? '<div class="ffp-preview-version-warning" role="alert">' + versionWarning + '</div>'
      : '';

    var sheetsHtml = (previewOutput.sheets || []).map(renderSheet).join('');
    var emptyState = (!previewOutput.sheets || previewOutput.sheets.length === 0)
      ? '<div class="ffp-empty-state">表示できる部屋がありません(全部屋が未マッピングか、FSDFに部屋が含まれていません)。</div>'
      : '';

    container.innerHTML =
      '<div class="ffp-preview-banner" role="note">' +
      '⚠ これは簡易プレビューです。実際の印刷結果とは異なる場合があります(HTML/Canvasによる軽量表示。' +
      'Excelの見た目を完全に再現するものではありません)。' +
      '</div>' +
      versionWarningHtml +
      '<div class="ffp-preview-meta">' + metaLine(previewOutput) + '</div>' +
      sheetsHtml + emptyState +
      renderWarningsPanel(previewOutput);
  }

  // render(input): PreviewOutput ... PreviewRendererインターフェースの規約通り、副作用のない
  // データ組み立てのみを行う(DOM操作はしない)。preview_adapter.jsのbuildPreviewOutputをそのまま
  // 公開する薄いラッパー。
  function render(input) {
    if (!TemplateEngineNS.buildPreviewOutput) {
      throw new Error('HtmlCanvasPreviewRenderer.render: fireflow_template_engine/preview_adapter.js が読み込まれていません。');
    }
    return TemplateEngineNS.buildPreviewOutput(input);
  }

  // 呼び出し側の利便のため、render()→mount()を1回で行うヘルパーも用意する(薄いラッパーであり、
  // 判定ロジックは持たない)。
  function renderAndMount(container, input) {
    var previewOutput = render(input);
    mount(container, previewOutput);
    return previewOutput;
  }

  var HtmlCanvasPreviewRenderer = {
    render: render,
    mount: mount,
    renderAndMount: renderAndMount,
  };

  OcrConfirmNS.HtmlCanvasPreviewRenderer = HtmlCanvasPreviewRenderer;
  window.FireFlowOcrConfirm = OcrConfirmNS;
})();
