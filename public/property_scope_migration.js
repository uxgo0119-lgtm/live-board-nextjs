/* ============================================================================
   [2026-08-18新設 Phase 1D] 旧保存データ → propertyId scope への移行「計画」だけを作る層。

   【この層が何であるか】
   保存済みデータのスナップショットを受け取り、「何を・どのpropertyIdへ・どう移行するか」
   という計画(plan)を返すだけの純粋関数群。**保存層へ一切触れない。**
   storageSet / storageDelete / lcPut / lcDelete / window.storage.* / Supabase を
   参照すらしない(＝呼びようがない)ので、read-onlyであることが規律ではなく構造で保証される。
   実際の移行(本migration)はここには実装しない。Phase 1Dは計画とdry-runまで。

   【FireFlow migrationの最重要原則】
     「移行できないデータを残す」ことは許容する。
     「間違った物件へ移行する」ことは禁止。
   したがって UNKNOWN_PROPERTY / AMBIGUOUS / COLLISION は失敗ではなく正常な結果として扱う。
   移行率100%を目標にしない。根拠のないpropertyId割当は一切行わない。

   【propertyId確定根拠の強度】(弱い根拠だけでは絶対に移行しない)
     A_RECORD_PROPERTY_ID    STRONG      レコード自身が有効なpropertyIdを持つ
     B_SINGLE_SCOPE_INVARIANT STRONG     「この端末の保存領域は1つのpropertyIdしか
                                          持ち得なかった」ことがコード上で証明できる
     C_MEMBERSHIP            CONDITIONAL 現物件レコードの部屋/設備一覧に含まれる
     D_WEAK                  WEAK        部屋番号一致・物件名一致・保存日時が近い・
                                          今開いている物件だから(← 単独では常に移行禁止)
     E_UNKNOWN               UNKNOWN     根拠なし

   【B_SINGLE_SCOPE_INVARIANT の根拠】(dfafb6b時点の実コード・全git履歴で確認済み)
     ・supabase-integration.js の currentPropertyId は INITIAL_PROPERTY_ID で初期化される。
     ・currentPropertyId を変更できる唯一の経路 setCurrentPropertyId() は、製品コードから
       一度も呼ばれていない(呼び出し箇所0。物件切替の結線はPhase 1E)。
     ・Phase 1A以前の固定 PROPERTY_ID も同じUUID(b6e18eed-...)だった。
     ・したがって kv_store の全既存行の property_id はこのUUIDであり、IndexedDBの
       ローカルキャッシュもその1つの物件区画の写しでしかない。
     ⇒ 旧キーを <このUUID> スコープへ入れる操作は「別の物件へ動かす」ことではなく、
       「既に入っている区画を、キー側にも明示する」ことに等しい。

   【ただし B だけでは足りない理由】(Phase 1D設計の核心)
     parseExcelAndRebuild() は別の建物のExcelを読み込んでも、
     fireflow-binder:* / fireflow-schedule-override:* / fireflow-equip:* / fireflow-ext:*
     を削除しない(resetInspectionDataForCurrentRoomSet() を呼ぶのは新規物件作成と
     データリセットの2経路だけで、しかも「呼んだ時点のFLOORSに在る部屋」しか消さない)。
     つまり1台の端末の旧キー空間には、**複数の実建物のデータが混在し得る**。
     混在の痕跡(現物件レコードの部屋/設備一覧に存在しない旧キー＝orphan)が1件でも
     見つかった端末では、部屋・設備単位のデータがどの建物のものか一意に決められない。
     その場合は既定で AMBIGUOUS とし、移行しない(削除もしない)。
   ============================================================================ */
'use strict';

(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FireFlowPropertyScopeMigration = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  // 同じmigrationを何度実行しても壊れないための版名。実コードの用語(property scope)に合わせる。
  var MIGRATION_VERSION = 'property-scope-v1';

  // Phase 1A以前から使われている固定物件UUID。B_SINGLE_SCOPE_INVARIANT の唯一の値。
  var LEGACY_FIXED_PROPERTY_ID = 'b6e18eed-f2f3-4674-812d-322732908616';

  var UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  function isValidPropertyId(value) {
    return typeof value === 'string' && value.length === 36 && UUID_V4_RE.test(value);
  }

  /* 製品コード(index.html)の PROPERTY_SCOPED_KEY_PREFIXES / PROPERTY_SCOPED_EXACT_KEYS と
     同じ集合。ここを製品と食い違わせるとdry-runの結論が実挙動とずれるため、
     phase1d のテストで製品側の定義と一致することを機械確認している。 */
  var PROPERTY_SCOPED_KEY_PREFIXES = [
    'fireflow-property:',
    'fireflow-binder:',
    'fireflow-schedule-override:',
    'fireflow-equip:',
    'fireflow-ext:',
    'fireflow-presence:',
  ];
  var PROPERTY_SCOPED_EXACT_KEYS = ['fireflow-documents'];

  /* Phase 1E の担当。StampStore は既に自前の物件スコープ('stamp:<物件>:<部屋>')を持つため、
     Phase 1D では読み取り対象にすらしない(計画に載せない＝SKIPで残す)。 */
  var PHASE1E_KEY_PREFIXES = ['stamp:', 'fireflow-stamp:'];

  // 端末設定。物件が変わっても引き継ぐ値なので、そもそもproperty scopeの対象外。
  var DEVICE_SETTING_KEY_PREFIXES = ['lb_'];
  var DEVICE_SETTING_EXACT_KEYS = ['fireflow-current-property-id'];

  var COMMON_AREA_KEY = '共用部・屋外';

  // ---- 判定結果の語彙 -------------------------------------------------------
  var STATUS = {
    MIGRATABLE: 'MIGRATABLE',
    ALREADY_MIGRATED: 'ALREADY_MIGRATED',
    COLLISION: 'COLLISION',
    AMBIGUOUS: 'AMBIGUOUS',
    UNKNOWN_PROPERTY: 'UNKNOWN_PROPERTY',
    INVALID: 'INVALID',
    SKIPPED_NON_PROPERTY_DATA: 'SKIPPED_NON_PROPERTY_DATA',
    SKIPPED_PHASE1E: 'SKIPPED_PHASE1E',
  };
  var COLLISION = {
    TARGET_EMPTY: 'TARGET_EMPTY',
    TARGET_EXISTS_SAME: 'TARGET_EXISTS_SAME',
    TARGET_EXISTS_DIFFERENT: 'TARGET_EXISTS_DIFFERENT',
    SOURCE_INVALID: 'SOURCE_INVALID',
    SOURCE_UNKNOWN_PROPERTY: 'SOURCE_UNKNOWN_PROPERTY',
    SOURCE_AMBIGUOUS: 'SOURCE_AMBIGUOUS',
    NOT_APPLICABLE: 'NOT_APPLICABLE',
  };
  var EVIDENCE = {
    A_RECORD_PROPERTY_ID: 'A_RECORD_PROPERTY_ID',
    B_SINGLE_SCOPE_INVARIANT: 'B_SINGLE_SCOPE_INVARIANT',
    C_MEMBERSHIP: 'C_MEMBERSHIP',
    D_WEAK: 'D_WEAK',
    E_UNKNOWN: 'E_UNKNOWN',
  };
  // 送信キュー(outbox)専用の語彙。今回outboxは1件も変更しない。
  var OUTBOX_STATUS = {
    ALREADY_SCOPED: 'ALREADY_SCOPED',
    MIGRATABLE: 'MIGRATABLE',
    NEEDS_USER_ASSIGNMENT: 'NEEDS_USER_ASSIGNMENT',
    INVALID: 'INVALID',
    SKIPPED_NON_PROPERTY_DATA: 'SKIPPED_NON_PROPERTY_DATA',
  };

  // ---- 小さな純粋ヘルパ -----------------------------------------------------
  function startsWithAny(key, prefixes) {
    for (var i = 0; i < prefixes.length; i++) if (key.indexOf(prefixes[i]) === 0) return true;
    return false;
  }
  function isPropertyScopedKey(rawKey) {
    var k = String(rawKey == null ? '' : rawKey);
    if (PROPERTY_SCOPED_EXACT_KEYS.indexOf(k) !== -1) return true;
    return startsWithAny(k, PROPERTY_SCOPED_KEY_PREFIXES);
  }
  // index.html の propertyScopedKey() と同一の変換。両者が一致することはテストで固定する。
  function propertyScopedKey(rawKey, propertyId) {
    var k = String(rawKey);
    var idx = k.indexOf(':');
    if (idx === -1) return k + ':' + propertyId;
    return k.slice(0, idx + 1) + propertyId + k.slice(idx);
  }
  // index.html の lcCacheKey() と同一。
  function lcCacheKey(rawKey, shared) { return (shared ? 'shared:' : 'own:') + rawKey; }

  // IndexedDB 'cache' ストアのキー('own:'/'shared:'接頭辞つき)を分解する。
  function parseCacheKey(cacheKey) {
    var k = String(cacheKey == null ? '' : cacheKey);
    if (k.indexOf('shared:') === 0) return { shared: true, rawKey: k.slice(7) };
    if (k.indexOf('own:') === 0) return { shared: false, rawKey: k.slice(4) };
    return null; // 想定外の形。推測で補完せずINVALIDへ倒す。
  }

  /* 既にpropertyIdスコープが付いているか。付いていれば移行済み(＝2回目以降の実行で
     重複を作らない)。領域名の直後の1区画がUUIDかどうかだけで判定する。 */
  function scopeInfo(rawKey) {
    var k = String(rawKey);
    var idx = k.indexOf(':');
    if (idx === -1) return { scoped: false, propertyId: null, subject: '' };
    var head = k.slice(0, idx);
    var rest = k.slice(idx + 1);
    var nextIdx = rest.indexOf(':');
    var candidate = nextIdx === -1 ? rest : rest.slice(0, nextIdx);
    if (!isValidPropertyId(candidate)) return { scoped: false, propertyId: null, subject: rest };
    return {
      scoped: true,
      propertyId: candidate,
      head: head,
      subject: nextIdx === -1 ? '' : rest.slice(nextIdx + 1),
    };
  }

  // 値の同一判定・監査ログ用の決定的ハッシュ(FNV-1a 32bit)。外部依存も時刻依存も持たない。
  function hashValue(value) {
    var s = (value === null || value === undefined) ? ' null' : String(value);
    var h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return ('0000000' + h.toString(16)).slice(-8);
  }

  function safeParseJson(text) {
    if (typeof text !== 'string') return { ok: false, value: null };
    try { return { ok: true, value: JSON.parse(text) }; } catch (err) { return { ok: false, value: null }; }
  }

  /* 旧キーの「対象(subject)」と領域(domain)を取り出す。
     部屋・設備・消火器のように対象が個別にあるものだけが、所属の確認(C_MEMBERSHIP)の対象。 */
  function classifyDomain(rawKey) {
    var k = String(rawKey);
    if (k === 'fireflow-documents') return { domain: 'documents', kind: 'singleton', subject: null };
    if (k.indexOf('fireflow-binder:') === 0) return { domain: 'binder', kind: 'room', subject: k.slice('fireflow-binder:'.length) };
    if (k.indexOf('fireflow-schedule-override:') === 0) return { domain: 'scheduleOverride', kind: 'room', subject: k.slice('fireflow-schedule-override:'.length) };
    if (k.indexOf('fireflow-equip:') === 0) return { domain: 'equip', kind: 'equipment', subject: k.slice('fireflow-equip:'.length) };
    if (k.indexOf('fireflow-ext:') === 0) return { domain: 'ext', kind: 'extinguisher', subject: k.slice('fireflow-ext:'.length) };
    if (k.indexOf('fireflow-presence:') === 0) return { domain: 'presence', kind: 'presence', subject: k.slice('fireflow-presence:'.length) };
    if (k === 'fireflow-property:current') return { domain: 'propertyCurrent', kind: 'currentRecord', subject: null };
    if (k.indexOf('fireflow-property:boTable:') === 0) return { domain: 'boTable', kind: 'singleton', subject: k.slice('fireflow-property:boTable:'.length) };
    if (k.indexOf('fireflow-property:') === 0) return { domain: 'property/' + k.slice('fireflow-property:'.length), kind: 'singleton', subject: null };
    return { domain: 'unknown', kind: 'unknown', subject: null };
  }

  /* 現物件レコード(fireflow-property:current)から、所属確認に使える集合を作る。
     ここで得た部屋/設備/消火器の一覧に無い旧キーは「別の建物の残骸(orphan)」の疑いがある。 */
  function buildMemberSets(currentRecord) {
    var rooms = Object.create(null);
    var equipment = Object.create(null);
    var extinguishers = Object.create(null);
    if (currentRecord && typeof currentRecord === 'object') {
      var floors = Array.isArray(currentRecord.floors) ? currentRecord.floors : [];
      floors.forEach(function (f) {
        var list = (f && Array.isArray(f.rooms)) ? f.rooms : [];
        list.forEach(function (r) { rooms[String(r)] = true; });
      });
      rooms[COMMON_AREA_KEY] = true; // 共用部は常にFLOORSの外に在る既存仕様
      var eq = Array.isArray(currentRecord.equipmentList) ? currentRecord.equipmentList : [];
      eq.forEach(function (name) { equipment[String(name)] = true; });
      var ext = Array.isArray(currentRecord.extinguisherData) ? currentRecord.extinguisherData : [];
      ext.forEach(function (item) {
        if (item && item.no !== undefined && item.no !== null) extinguishers[String(item.no)] = true;
      });
    }
    return { rooms: rooms, equipment: equipment, extinguishers: extinguishers };
  }

  function isMember(members, kind, subject) {
    if (subject === null || subject === undefined) return true; // singletonは所属確認の対象外
    var s = String(subject);
    if (kind === 'room') return !!members.rooms[s];
    if (kind === 'equipment') return !!members.equipment[s];
    if (kind === 'extinguisher') return !!members.extinguishers[s];
    return true;
  }

  /* ==========================================================================
     dry-run 本体。完全read-only。
       入力:
         cacheEntries : IndexedDB 'cache' ストアの全レコード [{key, value, updatedAt}]
         outboxEntries: IndexedDB 'outbox' ストアの全レコード
         currentPropertyId: 参考情報としてのみ受け取る。**これ単独では移行根拠にしない**
                            (D_WEAK。「今開いている物件だから」で割り当てない)
         options.strictOnContamination: 既定true。混在の痕跡が1件でもあれば、
                            部屋・設備単位のデータを丸ごとAMBIGUOUSにして移行しない。
       出力: { version, items, outbox, summary, contamination, writeCount:0, deleteCount:0 }
     ========================================================================== */
  function planPropertyScopeMigration(input) {
    var opts = (input && input.options) || {};
    var strictOnContamination = opts.strictOnContamination !== false;
    var cacheEntries = (input && Array.isArray(input.cacheEntries)) ? input.cacheEntries : [];
    var outboxEntries = (input && Array.isArray(input.outboxEntries)) ? input.outboxEntries : [];

    // ---- 0. 既存キーの索引(衝突判定用)。読むだけで書かない。 ----
    var existingByCacheKey = Object.create(null);
    cacheEntries.forEach(function (e) {
      if (e && e.key !== undefined && e.key !== null) existingByCacheKey[String(e.key)] = e;
    });

    /* ---- 1. 現物件レコードを探す。これが唯一 A_RECORD_PROPERTY_ID を持ち得るデータ。
         スコープ済み(移行済み)の 'fireflow-property:<uuid>:current' も探索対象に含める
         (2回目の実行でも同じ結論になるidempotencyのため)。 ---- */
    var currentRecord = null;
    var currentRecordPropertyId = null;
    var currentRecordMalformed = false;
    cacheEntries.forEach(function (e) {
      var parsed = e && e.key !== undefined ? parseCacheKey(e.key) : null;
      if (!parsed) return;
      var info = scopeInfo(parsed.rawKey);
      var isCurrent = (parsed.rawKey === 'fireflow-property:current') ||
        (info.scoped && info.head === 'fireflow-property' && info.subject === 'current');
      if (!isCurrent) return;
      var json = safeParseJson(e.value);
      if (!json.ok || !json.value || typeof json.value !== 'object') { currentRecordMalformed = true; return; }
      // 既に移行済みのレコードを優先して正本にする(2回目以降の実行で結論を変えないため)。
      if (currentRecord && !info.scoped) return;
      currentRecord = json.value;
      var pid = (json.value.property && json.value.property.propertyId) || null;
      if (isValidPropertyId(pid)) currentRecordPropertyId = pid;
      else if (info.scoped && isValidPropertyId(info.propertyId)) currentRecordPropertyId = info.propertyId;
    });

    var members = buildMemberSets(currentRecord);

    /* ---- 2. B_SINGLE_SCOPE_INVARIANT が成立するか。
         成立条件: 現物件レコードから読めたpropertyIdが、コード上唯一あり得た値と一致すること。
         レコードが無い/propertyIdを持たない場合は、推測せず invariant 無効とする。 ---- */
    var invariantPropertyId = (currentRecordPropertyId === LEGACY_FIXED_PROPERTY_ID)
      ? LEGACY_FIXED_PROPERTY_ID : null;

    /* ---- 3. 混在(contamination)の検出。
         現物件レコードの部屋/設備/消火器一覧に無い旧キーは、別建物の残骸の疑いがある。
         parseExcelAndRebuild() が旧キーを消さない以上、これは実際に起こり得る。 ---- */
    var orphanKeys = [];
    cacheEntries.forEach(function (e) {
      var parsed = e && e.key !== undefined ? parseCacheKey(e.key) : null;
      if (!parsed) return;
      if (!isPropertyScopedKey(parsed.rawKey)) return;
      if (scopeInfo(parsed.rawKey).scoped) return; // 移行済みは混在判定の対象外
      var d = classifyDomain(parsed.rawKey);
      if (d.kind !== 'room' && d.kind !== 'equipment' && d.kind !== 'extinguisher') return;
      if (!isMember(members, d.kind, d.subject)) orphanKeys.push(parsed.rawKey);
    });
    var contaminated = orphanKeys.length > 0;

    // ---- 4. 1件ずつ判定する ----
    var items = cacheEntries.map(function (entry) {
      return planOne(entry, {
        existingByCacheKey: existingByCacheKey,
        members: members,
        invariantPropertyId: invariantPropertyId,
        currentRecordPropertyId: currentRecordPropertyId,
        contaminated: contaminated,
        strictOnContamination: strictOnContamination,
        currentRecordMalformed: currentRecordMalformed,
      });
    });

    // ---- 5. 送信キュー(outbox)。今回は分類のみ。1件も変更しない。 ----
    var outbox = outboxEntries.map(planOneOutbox);

    // ---- 6. 集計 ----
    var summary = Object.create(null);
    Object.keys(STATUS).forEach(function (s) { summary[s] = 0; });
    items.forEach(function (it) { summary[it.status] = (summary[it.status] || 0) + 1; });
    var outboxSummary = Object.create(null);
    Object.keys(OUTBOX_STATUS).forEach(function (s) { outboxSummary[s] = 0; });
    outbox.forEach(function (it) { outboxSummary[it.status] = (outboxSummary[it.status] || 0) + 1; });

    return {
      version: MIGRATION_VERSION,
      items: items,
      outbox: outbox,
      summary: summary,
      outboxSummary: outboxSummary,
      contamination: {
        detected: contaminated,
        orphanKeys: orphanKeys,
        // 混在が見つかった端末では、部屋・設備単位のデータを既定で移行しない。
        policy: strictOnContamination ? 'STRICT_HOLD_ALL_SUBJECT_KEYED' : 'PERMISSIVE',
      },
      invariant: {
        applied: invariantPropertyId !== null,
        propertyId: invariantPropertyId,
        legacyFixedPropertyId: LEGACY_FIXED_PROPERTY_ID,
      },
      // dry-runは定義上どちらも0。呼び出し側が機械確認できるよう明示的に返す。
      writeCount: 0,
      deleteCount: 0,
    };
  }

  function planOne(entry, ctx) {
    var base = {
      cacheKey: (entry && entry.key !== undefined) ? entry.key : null,
      legacyKey: null,
      proposedScopedKey: null,
      proposedCacheKey: null,
      propertyId: null,
      evidence: EVIDENCE.E_UNKNOWN,
      status: STATUS.INVALID,
      collision: COLLISION.NOT_APPLICABLE,
      reason: '',
      domain: null,
    };

    var parsed = (entry && entry.key !== undefined) ? parseCacheKey(entry.key) : null;
    if (!parsed) {
      base.status = STATUS.INVALID;
      base.collision = COLLISION.SOURCE_INVALID;
      base.reason = 'キャッシュキーが own:/shared: のどちらでもない想定外の形';
      return base;
    }
    var rawKey = parsed.rawKey;
    base.legacyKey = rawKey;
    base.shared = parsed.shared;

    // --- 対象外を先に落とす(端末設定・StampStore・未知キー) ---
    if (startsWithAny(rawKey, DEVICE_SETTING_KEY_PREFIXES) || DEVICE_SETTING_EXACT_KEYS.indexOf(rawKey) !== -1) {
      base.status = STATUS.SKIPPED_NON_PROPERTY_DATA;
      base.reason = '端末設定。物件が変わっても引き継ぐ値なのでproperty scope対象外';
      return base;
    }
    if (startsWithAny(rawKey, PHASE1E_KEY_PREFIXES)) {
      base.status = STATUS.SKIPPED_PHASE1E;
      base.reason = 'StampStoreは自前の物件スコープを持つ。propertyIdへの正式接続はPhase 1E';
      return base;
    }
    if (!isPropertyScopedKey(rawKey)) {
      base.status = STATUS.SKIPPED_NON_PROPERTY_DATA;
      base.reason = '業務データのproperty scope対象キーではない';
      return base;
    }

    var d = classifyDomain(rawKey);
    base.domain = d.domain;

    // --- 既に移行済みか(idempotency) ---
    var info = scopeInfo(rawKey);
    if (info.scoped) {
      base.status = STATUS.ALREADY_MIGRATED;
      base.propertyId = info.propertyId;
      base.evidence = EVIDENCE.A_RECORD_PROPERTY_ID;
      base.proposedScopedKey = rawKey;
      base.proposedCacheKey = entry.key;
      base.reason = 'キーに既に有効なpropertyIdスコープが付いている。再移行しない';
      return base;
    }

    // --- 壊れたJSONは移行対象にしない(壊れたまま新スコープへ運ばない。削除もしない) ---
    var json = safeParseJson(entry.value);
    if (!json.ok) {
      base.status = STATUS.INVALID;
      base.collision = COLLISION.SOURCE_INVALID;
      base.reason = '値がJSONとして読めない。移行も削除もしない(そのまま保持)';
      return base;
    }

    // --- propertyIdの確定 ---
    var propertyId = null;
    var evidence = EVIDENCE.E_UNKNOWN;

    if (d.kind === 'currentRecord') {
      /* 現物件レコードだけは、レコード自身のpropertyId(A)しか根拠として認めない。
         propertyIdを持たない旧レコードへ推測で割り当てることは禁止(Phase 1D仕様7章)。 */
      var pid = (json.value && json.value.property && json.value.property.propertyId) || null;
      if (isValidPropertyId(pid)) { propertyId = pid; evidence = EVIDENCE.A_RECORD_PROPERTY_ID; }
      else {
        base.status = STATUS.UNKNOWN_PROPERTY;
        base.collision = COLLISION.SOURCE_UNKNOWN_PROPERTY;
        base.evidence = EVIDENCE.E_UNKNOWN;
        base.reason = 'レコードにpropertyIdが無い。推測で割り当てない(NEEDS_USER_ASSIGNMENT)';
        base.needsUserAssignment = true;
        return base;
      }
    } else {
      /* 従属データ(binder / schedule-override / equip / ext / presence / property付随 / documents)は
         レコード自身にpropertyIdを持たない。B(端末が単一スコープしか持ち得なかった証明)と
         C(現物件レコードへの所属)の両方が揃ったときだけ移行してよい。 */
      if (!ctx.invariantPropertyId) {
        base.status = STATUS.UNKNOWN_PROPERTY;
        base.collision = COLLISION.SOURCE_UNKNOWN_PROPERTY;
        base.reason = ctx.currentRecordMalformed
          ? '現物件レコードが壊れており、propertyIdを確定できない'
          : '現物件レコードにpropertyIdが無く、単一スコープ不変条件を確認できない';
        base.needsUserAssignment = true;
        return base;
      }
      if (ctx.contaminated && ctx.strictOnContamination &&
          (d.kind === 'room' || d.kind === 'equipment' || d.kind === 'extinguisher' ||
           d.kind === 'singleton' || d.kind === 'presence')) {
        base.status = STATUS.AMBIGUOUS;
        base.collision = COLLISION.SOURCE_AMBIGUOUS;
        base.evidence = EVIDENCE.D_WEAK;
        base.reason = 'この端末に複数建物の混在の痕跡がある(現物件に存在しない旧キーが '
          + '検出済み)。どの建物のデータか一意に決められないため移行しない(削除もしない)';
        return base;
      }
      if (!isMember(ctx.members, d.kind, d.subject)) {
        base.status = STATUS.AMBIGUOUS;
        base.collision = COLLISION.SOURCE_AMBIGUOUS;
        base.evidence = EVIDENCE.D_WEAK;
        base.reason = '現物件レコードの部屋/設備一覧に無い。別建物の残骸の可能性があるため移行しない';
        return base;
      }
      propertyId = ctx.invariantPropertyId;
      evidence = (d.kind === 'singleton' || d.kind === 'presence')
        ? EVIDENCE.B_SINGLE_SCOPE_INVARIANT
        : EVIDENCE.C_MEMBERSHIP; // B成立が前提のうえでの所属確認
    }

    base.propertyId = propertyId;
    base.evidence = evidence;
    base.proposedScopedKey = propertyScopedKey(rawKey, propertyId);
    base.proposedCacheKey = lcCacheKey(base.proposedScopedKey, parsed.shared);

    // --- 衝突判定。既存の新スコープデータは絶対に上書きしない ---
    var target = ctx.existingByCacheKey[base.proposedCacheKey];
    if (!target) {
      base.collision = COLLISION.TARGET_EMPTY;
      base.status = STATUS.MIGRATABLE;
      base.reason = '移行先が空。安全に複写できる';
    } else if (hashValue(target.value) === hashValue(entry.value)) {
      base.collision = COLLISION.TARGET_EXISTS_SAME;
      base.status = STATUS.ALREADY_MIGRATED;
      base.reason = '移行先に同じ値が既に在る。複写不要(旧キーは今回削除しない)';
    } else {
      base.collision = COLLISION.TARGET_EXISTS_DIFFERENT;
      base.status = STATUS.COLLISION;
      base.reason = '移行先に別の値が既に在る。自動上書きは禁止。人の判断が要る';
    }

    // 監査ログ(rollback用)に必要な値。今回は永続化しない(設計のみ)。
    base.sourceHash = hashValue(entry.value);
    base.targetHashBefore = target ? hashValue(target.value) : null;
    base.targetExisted = !!target;
    return base;
  }

  /* 送信キュー(outbox)の分類。**今回は1件も変更しない。**
     propertyIdを持たない旧itemへ currentPropertyId を勝手に入れない。削除もしない。 */
  function planOneOutbox(item) {
    var out = {
      key: (item && item.key !== undefined) ? item.key : null,
      rawKey: (item && item.rawKey !== undefined) ? item.rawKey : null,
      propertyId: (item && item.propertyId) || null,
      status: OUTBOX_STATUS.INVALID,
      reason: '',
      mutated: false, // 常にfalse。dry-runは何も変えない
    };
    if (!item || item.rawKey === undefined || item.rawKey === null) {
      out.status = OUTBOX_STATUS.INVALID;
      out.reason = 'rawKeyが無い壊れたitem。変更も削除もしない';
      return out;
    }
    if (!isPropertyScopedKey(item.rawKey)) {
      out.status = OUTBOX_STATUS.SKIPPED_NON_PROPERTY_DATA;
      out.reason = '業務データのproperty scope対象キーではない';
      return out;
    }
    if (item.alreadyScoped === true && isValidPropertyId(item.propertyId)) {
      out.status = OUTBOX_STATUS.ALREADY_SCOPED;
      out.reason = '積んだ時点のpropertyIdを保持済み。そのpropertyIdへ送られる';
      return out;
    }
    if (isValidPropertyId(item.propertyId)) {
      out.status = OUTBOX_STATUS.MIGRATABLE;
      out.reason = '有効なpropertyIdを持つがalreadyScopedが立っていない。本migrationで整合させる';
      return out;
    }
    out.status = OUTBOX_STATUS.NEEDS_USER_ASSIGNMENT;
    out.reason = 'propertyIdが無い旧item。どの物件のものか推測できないため、'
      + '変更も削除も送信もしない(人の割当が要る)';
    return out;
  }

  /* ==========================================================================
     rollback用の監査ログ「レコード形」。本migrationを実行する場合に、
     1件複写するごとにこの形を残す想定。今回は永続化しない(形の定義のみ)。
     rollbackは targetExisted===false の行だけを対象にし、かつ現在の移行先の値が
     複写直後のハッシュと一致するときだけ取り消す。既存の新スコープデータは消さない。
     ========================================================================== */
  function buildAuditRecord(planItem, runId, timestamp) {
    return {
      runId: runId,
      migrationVersion: MIGRATION_VERSION,
      timestamp: timestamp,
      sourceKey: planItem.legacyKey,
      targetKey: planItem.proposedScopedKey,
      shared: planItem.shared,
      propertyId: planItem.propertyId,
      evidence: planItem.evidence,
      status: planItem.status,
      sourceHash: planItem.sourceHash || null,
      targetHashBefore: planItem.targetHashBefore || null,
      // migrationが「作った」ものだけをrollback対象にするための決定的な印。
      createdByMigration: planItem.targetExisted === false,
    };
  }
  // rollbackしてよいか(監査ログ1件と、現在の移行先の値から判定する純粋関数)。
  function canRollback(auditRecord, currentTargetValue) {
    if (!auditRecord || !auditRecord.createdByMigration) return false; // 元から在ったものは消さない
    if (currentTargetValue === undefined) return false;                // 既に無い
    return hashValue(currentTargetValue) === auditRecord.sourceHash;   // 複写後に変更されていない
  }

  return {
    MIGRATION_VERSION: MIGRATION_VERSION,
    LEGACY_FIXED_PROPERTY_ID: LEGACY_FIXED_PROPERTY_ID,
    STATUS: STATUS,
    COLLISION: COLLISION,
    EVIDENCE: EVIDENCE,
    OUTBOX_STATUS: OUTBOX_STATUS,
    PROPERTY_SCOPED_KEY_PREFIXES: PROPERTY_SCOPED_KEY_PREFIXES,
    PROPERTY_SCOPED_EXACT_KEYS: PROPERTY_SCOPED_EXACT_KEYS,
    isValidPropertyId: isValidPropertyId,
    isPropertyScopedKey: isPropertyScopedKey,
    propertyScopedKey: propertyScopedKey,
    lcCacheKey: lcCacheKey,
    parseCacheKey: parseCacheKey,
    scopeInfo: scopeInfo,
    hashValue: hashValue,
    classifyDomain: classifyDomain,
    buildMemberSets: buildMemberSets,
    planPropertyScopeMigration: planPropertyScopeMigration,
    buildAuditRecord: buildAuditRecord,
    canRollback: canRollback,
  };
});
