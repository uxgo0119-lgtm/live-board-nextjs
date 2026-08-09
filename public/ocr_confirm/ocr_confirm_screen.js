// Phase3「③OCR確認画面」: ブラウザDOM上にUIを構築するコントローラ。
//
// 設計方針: 既存のstampReview*パネルのビジュアル言語(.bo-row/.bo-label/.bo-value、
// パネルの表示/非表示、showBackdrop/hideBackdropとの連携)を踏襲しつつ、独立した画面として
// 実装する(既存の部屋カードUI・stamp OCR関連DOM・関数には一切手を加えない)。
//
// 一覧+フィルタ+信頼度閾値設定+詳細編集パネル+確定ボタンを持つ。将来の原紙連携(指示10番)の
// ため、各行のDOM要素に data-room-number 属性を持たせる(双方向ナビゲーション自体は未実装)。
//
// 本ファイルはDOM操作(ブラウザ専用)のため、ブラウザでのみ動作する。ロジック本体(review_state.js
// /filters.js/validate_before_confirm.js/row_view_model.js/review_edit_tracker.js)は
// window.FireFlowOcrConfirm名前空間から取得する(Node単体テストは別ファイルのロジック側で行う)。
'use strict';

(function () {
  if (typeof window === 'undefined') return; // Node環境では何もしない(DOM操作不可のため)。

  var NS = window.FireFlowOcrConfirm || {};

  function escapeHtml(s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // container: 描画先のDOM要素。initialFsdf: FSDFオブジェクト。callbacks: {
  //   onConfirmed(confirmedFsdf): 確定完了時に呼ばれる,
  //   onCancel(): 画面を閉じる操作をした場合に呼ばれる(省略可),
  //   getReviewerName(): 既定の担当者名を返す(省略可),
  // }
  function createOcrConfirmController(container, initialFsdf, callbacks) {
    callbacks = callbacks || {};
    var state = {
      fsdf: initialFsdf,
      filter: null,
      threshold: NS.getConfidenceThreshold(),
      selectedRoomNumber: null,
      reviewerName: (callbacks.getReviewerName && callbacks.getReviewerName()) || '',
      ackSevereIssues: false,
      lastValidation: null,
      // Phase7前対応バックログ④: 信頼度しきい値設定(詳細設定)の開閉状態。既定は折りたたみ。
      showAdvancedSettings: false,
      // Phase4(テンプレート管理)接続: callbacks.getRoomCellMap() が渡された場合、
      // mapping.json の roomCellMap(部屋番号->{cell,sheet})相当のオブジェクトを保持し、
      // isNotInTemplate() の判定に使う。省略可(呼び出し元がテンプレートを未選択の場合は
      // 従来通り「判定不能」として扱われ、UI上の見た目は変わらない)。
      roomCellMap: (callbacks.getRoomCellMap && callbacks.getRoomCellMap()) || null,
    };

    function currentRooms() { return (state.fsdf && state.fsdf.rooms) || []; }

    function findRoomIndex(roomNumber) {
      var rooms = currentRooms();
      for (var i = 0; i < rooms.length; i++) {
        if (String(rooms[i].roomNumber) === String(roomNumber)) return i;
      }
      return -1;
    }

    function replaceRoom(roomNumber, updatedRoom) {
      var idx = findRoomIndex(roomNumber);
      if (idx === -1) return;
      var rooms = currentRooms().slice();
      rooms[idx] = updatedRoom;
      state.fsdf = Object.assign({}, state.fsdf, { rooms: rooms });
    }

    function context() {
      var ctx = { confidenceThreshold: state.threshold, duplicateRoomNumbers: NS.findDuplicateRoomNumbers(currentRooms()) };
      if (state.roomCellMap) ctx.roomCellMap = state.roomCellMap;
      return ctx;
    }

    // Phase7前対応バックログ②: 「部屋一覧→詳細編集」移動時に大量のスクロールが必要になる
    // 問題への対応。一覧が長い場合、下の方の行をタップして詳細編集が(従来どおり)一覧の
    // 下に追記される作りだと、そのままの画面位置では詳細が見えない/一覧の残りを延々
    // スクロールし続ける必要があった。container自身が可視域を持つスクロール祖先(このモジュールが
    // 組み込まれる側のパネルCSSでoverflow-y:auto等が指定されている前提。index.html側の
    // #ocrScheduleIntakePanelがこれにあたるが、ここではDOM構造非依存にするためID決め打ちせず
    // 汎用的に「overflowが効いている祖先要素」を探して先頭へ戻す)、一覧⇔詳細を切り替える
    // たびに表示位置を先頭へ戻す。あわせてrender()側で一覧本体とフィルタチップを詳細表示中は
    // 隠す(掲載スペースを詳細だけに絞ることで、スクロール量そのものを削減する。指示どおり
    // 既存アーキテクチャ(state駆動の薄いDOM層)を維持したまま行う最小限の変更)。
    function scrollContainerToTop() {
      var el = container;
      while (el && el !== document.body && el !== document.documentElement) {
        var style = (typeof window.getComputedStyle === 'function') ? window.getComputedStyle(el) : null;
        if (style && (style.overflowY === 'auto' || style.overflowY === 'scroll')) {
          el.scrollTop = 0;
          return;
        }
        el = el.parentElement;
      }
    }

    function renderFilterChips(rootEl) {
      var counts = NS.countByFilter(currentRooms(), context());
      var chips = Object.keys(NS.FILTER_TYPES).map(function (k) {
        var type = NS.FILTER_TYPES[k];
        var active = state.filter === type;
        return '<button type="button" class="ocr-filter-chip' + (active ? ' active' : '') + '" data-filter="' + type + '">' +
          escapeHtml(NS.FILTER_LABELS[type]) + '（' + counts[type] + '）</button>';
      }).join('');
      rootEl.innerHTML = chips;
      Array.prototype.forEach.call(rootEl.querySelectorAll('.ocr-filter-chip'), function (btn) {
        btn.addEventListener('click', function () {
          state.filter = btn.getAttribute('data-filter');
          render();
        });
      });
    }

    // Phase7前対応バックログ④: 信頼度しきい値設定は通常操作から分離し、詳細設定として
    // 折りたたむ。日常的な操作(一覧を見る・修正する・確定する)には不要な設定項目のため、
    // 既定(state.showAdvancedSettings = false)では非表示にし、「詳細設定」トグルを押した
    // ときだけ展開する(ページ内に留めたまま開閉できるdisclosureパターン。閾値の意味・
    // 適用ロジック自体は変更しない)。
    function renderThresholdControl(rootEl) {
      var toggleLabel = state.showAdvancedSettings ? '詳細設定を閉じる ▲' : '詳細設定（信頼度しきい値） ▼';
      var html = '<button type="button" id="ocrAdvancedSettingsToggle" class="ocr-advanced-toggle" aria-expanded="' + (state.showAdvancedSettings ? 'true' : 'false') + '">' +
        escapeHtml(toggleLabel) + '</button>';
      if (state.showAdvancedSettings) {
        html += '<div class="ocr-advanced-settings-body">' +
          '<label class="ocr-threshold-label">信頼度しきい値（これ未満は「低信頼度」として要確認）: ' +
          '<input type="number" id="ocrThresholdInput" min="0" max="1" step="0.01" value="' + state.threshold + '" style="width:70px;"></label>' +
          '<button type="button" id="ocrThresholdApplyBtn">適用</button>' +
          '</div>';
      }
      rootEl.innerHTML = html;
      rootEl.querySelector('#ocrAdvancedSettingsToggle').addEventListener('click', function () {
        state.showAdvancedSettings = !state.showAdvancedSettings;
        render();
      });
      if (state.showAdvancedSettings) {
        rootEl.querySelector('#ocrThresholdApplyBtn').addEventListener('click', function () {
          var v = rootEl.querySelector('#ocrThresholdInput').value;
          try {
            state.threshold = NS.setConfidenceThreshold(v);
            render();
          } catch (e) {
            window.alert(e.message);
          }
        });
      }
    }

    function renderList(rootEl) {
      var rooms = currentRooms();
      var initial = NS.pickInitialFilter(rooms, context());
      if (state.filter === null) state.filter = initial.filter;

      var visibleRooms = NS.applyFilter(rooms, state.filter, context());
      var rowModels = visibleRooms.map(function (r) { return NS.buildRowViewModel(r, context()); });

      if (rowModels.length === 0) {
        var emptyMsg = (state.filter === NS.FILTER_TYPES.NEEDS_REVIEW)
          ? '要確認の項目はありません。すべて高信頼度・warningなしです。'
          : 'このフィルタに該当する部屋はありません。';
        rootEl.innerHTML = '<div class="ocr-empty-state">' + escapeHtml(emptyMsg) + '</div>';
        return;
      }

      rootEl.innerHTML = rowModels.map(function (rm) {
        var checkMark = rm.reviewed ? '<span class="ocr-row-check" aria-hidden="true">✓</span>' : '';
        var warnBadge = rm.hasWarning ? '<span class="ocr-row-warn-badge">⚠' + rm.warningCount + '</span>' : '';
        return '<div class="ocr-room-row ' + rm.colorClass + '" data-room-number="' + escapeHtml(rm.roomNumber) + '" data-room-id="' + escapeHtml(rm.roomId) + '">' +
          '<div class="ocr-room-row-main">' +
          '<span class="ocr-room-number">' + escapeHtml(rm.roomNumber) + '号室</span>' +
          '<span class="ocr-room-day">' + escapeHtml(rm.scheduleDayLabel) + '</span>' +
          '<span class="ocr-room-time">' + escapeHtml(rm.timeLabel) + '</span>' +
          '<span class="ocr-room-status">' + escapeHtml(rm.statusLabel) + '</span>' +
          checkMark + warnBadge +
          '</div>' +
          '<div class="ocr-room-row-sub">' +
          '<span class="ocr-room-memo">' + (rm.memo ? escapeHtml(rm.memo) : '') + '</span>' +
          '<span class="ocr-room-confidence">信頼度: ' + escapeHtml(rm.minConfidenceLabel) + '</span>' +
          '</div>' +
          '</div>';
      }).join('');

      Array.prototype.forEach.call(rootEl.querySelectorAll('.ocr-room-row'), function (rowEl) {
        rowEl.addEventListener('click', function () {
          state.selectedRoomNumber = rowEl.getAttribute('data-room-number');
          scrollContainerToTop();
          render();
        });
      });
    }

    function renderDetailPanel(rootEl) {
      if (!state.selectedRoomNumber) {
        rootEl.innerHTML = '';
        rootEl.style.display = 'none';
        return;
      }
      rootEl.style.display = 'block';
      var idx = findRoomIndex(state.selectedRoomNumber);
      if (idx === -1) { rootEl.innerHTML = ''; return; }
      var room = currentRooms()[idx];
      var tp = room.timePreference || {};

      rootEl.innerHTML =
        '<div class="bo-table">' +
        '<div class="bo-row"><div class="bo-label">部屋番号</div><div class="bo-value"><input type="text" id="ocrEditRoomNumber" class="stamp-review-input" value="' + escapeHtml(room.roomNumber) + '"></div></div>' +
        '<div class="bo-row"><div class="bo-label">工程日</div><div class="bo-value"><input type="number" id="ocrEditScheduleDay" class="stamp-review-input" min="1" value="' + (room.scheduleDay || '') + '"></div></div>' +
        '<div class="bo-row"><div class="bo-label">AM/PM</div><div class="bo-value"><select id="ocrEditPeriod" class="stamp-review-input">' +
        '<option value=""' + (!tp.period ? ' selected' : '') + '>指定なし</option>' +
        '<option value="AM"' + (tp.period === 'AM' ? ' selected' : '') + '>AM</option>' +
        '<option value="PM"' + (tp.period === 'PM' ? ' selected' : '') + '>PM</option>' +
        '</select></div></div>' +
        '<div class="bo-row"><div class="bo-label">時刻</div><div class="bo-value"><input type="time" id="ocrEditTime" class="stamp-review-input" value="' + escapeHtml(tp.time || '') + '"></div></div>' +
        '<div class="bo-row"><div class="bo-label">状態</div><div class="bo-value"><select id="ocrEditSourceStatus" class="stamp-review-input">' +
        ['scheduled', 'pass', 'cancelled', 'unanswered', 'absent', 'illegible', 'other'].map(function (s) {
          return '<option value="' + s + '"' + (room.sourceStatus === s ? ' selected' : '') + '>' + escapeHtml((NS.SOURCE_STATUS_LABELS && NS.SOURCE_STATUS_LABELS[s]) || s) + '</option>';
        }).join('') +
        '</select></div></div>' +
        '<div class="bo-row"><div class="bo-label">メモ</div><div class="bo-value"><input type="text" id="ocrEditMemo" class="stamp-review-input" value="' + escapeHtml(room.memo || '') + '"></div></div>' +
        '</div>' +
        (room.sourceMeta && room.sourceMeta.warnings && room.sourceMeta.warnings.length
          ? '<div class="ocr-detail-warnings">' + room.sourceMeta.warnings.map(function (w) {
            return '<div class="warn-line severity-' + (w.severity || 'warning') + '">⚠ ' + escapeHtml(w.message) + '</div>';
          }).join('') + '</div>' : '') +
        '<div class="panel-buttons" style="margin-top:12px;">' +
        '<button type="button" id="ocrEditCancelBtn">← 一覧に戻る</button>' +
        '<button type="button" class="primary" id="ocrEditSaveBtn">この部屋の修正を保存</button>' +
        '</div>';

      rootEl.querySelector('#ocrEditCancelBtn').addEventListener('click', function () {
        state.selectedRoomNumber = null;
        scrollContainerToTop();
        render();
      });
      rootEl.querySelector('#ocrEditSaveBtn').addEventListener('click', function () {
        var patch = {
          roomNumber: rootEl.querySelector('#ocrEditRoomNumber').value.trim(),
          scheduleDay: rootEl.querySelector('#ocrEditScheduleDay').value ? parseInt(rootEl.querySelector('#ocrEditScheduleDay').value, 10) : null,
          'timePreference.period': rootEl.querySelector('#ocrEditPeriod').value || null,
          'timePreference.time': rootEl.querySelector('#ocrEditTime').value || null,
          sourceStatus: rootEl.querySelector('#ocrEditSourceStatus').value,
          memo: rootEl.querySelector('#ocrEditMemo').value,
        };
        var updated = NS.applyRoomEdits(room, patch);
        replaceRoom(state.selectedRoomNumber, updated);
        state.selectedRoomNumber = updated.roomNumber;
        scrollContainerToTop();
        render();
      });
    }

    // 明示的な確認操作(チェックボックス)で解除できるblockingIssue(illegible/重大warning未解決)。
    // それ以外(部屋番号の空/重複、scheduleDay範囲外、AM/PM矛盾)はデータ自体の誤りであり、
    // 修正しない限り確定できない(チェックボックスでは解除させない。指示6番)。
    var ACKNOWLEDGEABLE_BLOCKING_CODES = ['illegible_unreviewed', 'blocking_warning_unresolved'];

    function renderValidationPanel(rootEl) {
      if (!state.lastValidation) { rootEl.innerHTML = ''; return; }
      var v = state.lastValidation;
      var html = '';
      var acknowledgeableIssues = v.blockingIssues.filter(function (i) { return ACKNOWLEDGEABLE_BLOCKING_CODES.indexOf(i.code) !== -1; });
      var hardBlockingIssues = v.blockingIssues.filter(function (i) { return ACKNOWLEDGEABLE_BLOCKING_CODES.indexOf(i.code) === -1; });

      if (hardBlockingIssues.length) {
        html += '<div class="ocr-validation-block ocr-validation-error"><div class="ocr-validation-title">確定できません（修正が必要、' + hardBlockingIssues.length + '件）</div>' +
          hardBlockingIssues.map(function (i) { return '<div>・' + escapeHtml(i.message) + '</div>'; }).join('') + '</div>';
      }
      if (acknowledgeableIssues.length || v.warnings.length) {
        var count = acknowledgeableIssues.length + v.warnings.length;
        html += '<div class="ocr-validation-block ocr-validation-warning"><div class="ocr-validation-title">要確認・警告（' + count + '件）</div>' +
          acknowledgeableIssues.map(function (i) { return '<div>・' + escapeHtml(i.message) + '</div>'; }).join('') +
          v.warnings.slice(0, 20).map(function (w) { return '<div>・' + escapeHtml(w.message) + '</div>'; }).join('') +
          (v.warnings.length > 20 ? '<div>…他' + (v.warnings.length - 20) + '件</div>' : '') +
          '<label class="ocr-ack-label"><input type="checkbox" id="ocrAckSevereCheckbox"' + (state.ackSevereIssues ? ' checked' : '') + '> 上記の警告・未解決項目を確認の上、そのまま確定します</label>' +
          '</div>';
      }
      rootEl.innerHTML = html;
      var ackCheckbox = rootEl.querySelector('#ocrAckSevereCheckbox');
      if (ackCheckbox) {
        ackCheckbox.addEventListener('change', function () { state.ackSevereIssues = ackCheckbox.checked; });
      }
    }

    function doConfirm(rootEl) {
      var reviewerInput = rootEl.querySelector('#ocrReviewerNameInput');
      var reviewerName = reviewerInput ? reviewerInput.value.trim() : state.reviewerName;
      state.reviewerName = reviewerName;
      if (!reviewerName) { window.alert('担当者名を入力してください。'); return; }

      var rooms = currentRooms();
      var illegibleRooms = rooms.filter(function (r) { return r.sourceStatus === 'illegible' && !(r.sourceMeta && r.sourceMeta.reviewedAt); }).map(function (r) { return String(r.roomNumber); });
      var errorWarningRooms = rooms.filter(function (r) {
        var ws = (r.sourceMeta && r.sourceMeta.warnings) || [];
        return ws.some(function (w) { return w.severity === 'error'; }) && !(r.sourceMeta && r.sourceMeta.reviewedAt);
      }).map(function (r) { return String(r.roomNumber); });

      var ackOptions = state.ackSevereIssues
        ? { acknowledgedIllegibleRooms: illegibleRooms, acknowledgedWarningRooms: errorWarningRooms }
        : {};

      var validation = NS.validateBeforeConfirm(state.fsdf, ackOptions);
      state.lastValidation = validation;

      if (!validation.ok) {
        render();
        return;
      }
      if (validation.warnings.length && !state.ackSevereIssues) {
        // 重大警告そのものは無いが軽微な警告がある場合でも、明示確認を一度は要求する。
        render();
        return;
      }

      var nowIso = new Date().toISOString();
      var confirmedRooms = rooms.map(function (r) { return NS.markRoomReviewed(r, reviewerName, nowIso); });
      var confirmedFsdf = Object.assign({}, state.fsdf, { rooms: confirmedRooms });
      state.fsdf = confirmedFsdf;
      state.lastValidation = null;
      render();
      if (callbacks.onConfirmed) callbacks.onConfirmed(confirmedFsdf);
    }

    function render() {
      var filterChipsEl = container.querySelector('.ocr-confirm-filters');
      var thresholdEl = container.querySelector('.ocr-confirm-threshold');
      var listEl = container.querySelector('.ocr-confirm-list');
      var detailEl = container.querySelector('.ocr-confirm-detail');
      var validationEl = container.querySelector('.ocr-confirm-validation');
      if (!filterChipsEl) return; // まだmountされていない

      // 初期フィルタ(指示3番: 要確認優先。0件なら全件表示)は、フィルタチップを描画する前に
      // 確定させておく必要がある(そうしないと初回描画時にどのチップにもactiveクラスが
      // 付かないまま表示されてしまう)。
      if (state.filter === null) {
        state.filter = NS.pickInitialFilter(currentRooms(), context()).filter;
      }

      renderThresholdControl(thresholdEl);
      renderList(listEl);
      renderDetailPanel(detailEl);
      renderValidationPanel(validationEl);

      // Phase7前対応バックログ②: 詳細編集を開いている間は一覧本体とフィルタチップを隠し、
      // 詳細編集だけのシンプルな画面(スライドオーバー的な見た目)にする。一覧に戻るには
      // 詳細内の「← 一覧に戻る」ボタン(state.selectedRoomNumber = nullにしてrender()を
      // 呼ぶ)を使う。これにより、長い一覧の下の方の行を選んだ場合でも詳細編集へは
      // 一切スクロールせずに到達でき(scrollContainerToTop()と合わせて常に先頭から見える)、
      // 一覧へ戻る際も再び先頭から一覧を見渡せる。
      var inDetail = !!state.selectedRoomNumber;
      filterChipsEl.style.display = inDetail ? 'none' : '';
      renderFilterChips(filterChipsEl);
      listEl.style.display = inDetail ? 'none' : '';
    }

    function mount() {
      container.innerHTML =
        '<div class="ocr-confirm-threshold"></div>' +
        '<div class="ocr-confirm-filters"></div>' +
        '<div class="ocr-confirm-list"></div>' +
        '<div class="ocr-confirm-detail" style="display:none;"></div>' +
        '<div class="ocr-confirm-validation"></div>' +
        '<div class="ocr-confirm-confirmbar">' +
        '<input type="text" id="ocrReviewerNameInput" placeholder="担当者名" value="' + escapeHtml(state.reviewerName) + '">' +
        '<button type="button" class="primary" id="ocrConfirmBtn">確定してLBへ反映</button>' +
        '</div>';
      container.querySelector('#ocrConfirmBtn').addEventListener('click', function () { doConfirm(container); });
      render();
    }

    mount();

    return {
      getFsdf: function () { return state.fsdf; },
      setFsdf: function (fsdf) { state.fsdf = fsdf; state.selectedRoomNumber = null; render(); },
      render: render,
    };
  }

  window.FireFlowOcrConfirm = window.FireFlowOcrConfirm || {};
  window.FireFlowOcrConfirm.createOcrConfirmController = createOcrConfirmController;
})();
