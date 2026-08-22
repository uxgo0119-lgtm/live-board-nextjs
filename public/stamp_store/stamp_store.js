/* public/stamp_store/stamp_store.js
 *
 * [2026-08-15新設 Phase 1: 捺印表データ接続層の再構築]
 *
 * 「部屋ごとの点検予定情報(記号・時刻・備考)」の唯一の正本(FireFlow Stamp Canonical Data)を
 * 保持・保存・復元する層。Live Board(public/index.html)は、この層を通してのみ予定情報を
 * 読み書きする。
 *
 * 【なぜ必要か / Phase 0調査で確定した構造問題】
 * 従来、予定情報は index.html のグローバル変数 STAMP_DATA へ12箇所から直接書き込まれており、
 * 経路ごとに形が違い(Legacy/新捺印表/CSV)、どの経路で入った値かを示す情報も無かった。
 * さらに保存はIndexedDB+リモートの2系統に書かれる一方、復元はリモート一覧(storageList)だけを
 * 見ており、通信失敗時は静かに0件復元になっていた。復元の呼び出しも起動経路の1つにしか無く、
 * Excel再読込では消去だけが行われていた。この結果、OCRとしては正しく確定した値が、
 * 保存・復元・再読込のタイミングによって実LBから消える/揺れるという症状が出ていた。
 *
 * 【この層の責務】
 * - 正本レコードの生成(既に確定した値を受け取るだけ。ここで再解釈・再判定はしない)
 * - 物件スコープ(property key)ごとの保持
 * - MASTER(部屋一覧)に存在する部屋だけを受け入れる(OCRからMASTERを作らない)
 * - 保存(ローカル優先)と復元(ローカル優先→リモート差分)の一本化
 * - 旧キー(fireflow-stamp:<room>)からの一度きりの取り込み
 *
 * 【この層がしないこと】
 * - OCR・辞書・時刻解析・記号収束などの判断(すべて上流のサーバー側で確定済み)
 * - 部屋一覧(FLOORS/MASTER)の生成・変更
 * - 画面描画
 */
(function () {
  'use strict';

  var SCHEMA_VERSION = 1;
  // 物件スコープを含む保存キー。物件をまたいだ混入を構造的に防ぐ。
  var KEY_PREFIX = 'stamp:';
  // Phase 0以前の保存キー(物件スコープを持たない)。復元時に一度だけ取り込む。
  var LEGACY_KEY_PREFIX = 'fireflow-stamp:';

  var VALID_SOURCES = {
    standardized_stamp_sheet: true, // 新捺印表OCR
    legacy_time_request: true,      // 点検希望時間連絡票OCR(Legacy、単票/一括)
    legacy_schedule_sheet: true,    // 点検予定表OCR(FSDF確定)
    csv_import: true,               // CSV取込
    manual: true,                   // 手入力・レビュー画面での保存
    demo: true,                     // デモ物件の初期値
    migrated_legacy: true           // 旧キーからの取り込み
  };

  function normalizePropertyKey(raw) {
    var text = (raw === null || raw === undefined) ? '' : String(raw);
    text = text.trim();
    if (!text) return 'default';
    // キーの区切り(':')と空白だけを潰す。日本語の物件名はそのまま使える。
    return text.replace(/\s+/g, '_').replace(/:/g, '-');
  }

  function asString(v) { return (v === null || v === undefined) ? '' : String(v); }
  function asTrimmed(v) { return asString(v).trim(); }

  function normalizeReviewReason(v) {
    if (Array.isArray(v)) return v.map(asString).filter(function (x) { return !!x; });
    var text = asTrimmed(v);
    return text ? [text] : [];
  }

  function normalizeCheckboxes(v) {
    v = v || {};
    return {
      a: !!(v.a !== undefined ? v.a : v.a_checked),
      p: !!(v.p !== undefined ? v.p : v.p_checked),
      cancel: !!(v.cancel !== undefined ? v.cancel : v.cancel_checked)
    };
  }

  /* 正本レコードを組み立てる。
     【重要】ここは「確定済みの値を器へ入れる」だけで、値の解釈・補完・再判定は一切しない
     (記号の収束・時刻の確定・辞書一致の判定は、すべて上流で完了している)。 */
  function buildRecord(input, context) {
    input = input || {};
    context = context || {};
    var room = asTrimmed(input.room !== undefined ? input.room : input.room_number);
    var source = asTrimmed(input.source) || asTrimmed(context.source);
    return {
      schema_version: SCHEMA_VERSION,
      property_key: normalizePropertyKey(input.property_key || context.propertyKey),
      room: room,
      symbol: asTrimmed(input.symbol),
      time_start: asTrimmed(input.time_start !== undefined ? input.time_start : input.time),
      time_end: asTrimmed(input.time_end),
      // Legacy経路が持っている表示用の時刻モード(exact/range/end_only等)。無ければ空。
      time_mode: asTrimmed(input.time_mode),
      // 確定した業務語のみ(辞書がauto_correctと判定したもの)。
      note: asTrimmed(input.note),
      // 読み取り原文。確定できなくても必ず残す(要確認の根拠になるため)。
      note_raw: asTrimmed(input.note_raw),
      name: asTrimmed(input.name),
      schedule_date: asTrimmed(input.schedule_date !== undefined ? input.schedule_date : input.scheduleDate),
      schedule_day: (typeof input.schedule_day === 'number') ? input.schedule_day
        : (typeof input.scheduleDay === 'number' ? input.scheduleDay : null),
      raw_checkboxes: normalizeCheckboxes(input.raw_checkboxes || input),
      /* [2026-08-15追加 Phase 2 項目単位の確定] どの項目が要確認なのかを、部屋単位の
         needs_review とは別に保持する。
         「801は時刻9:30が確定していて、曖昧なのは備考だけ」という状態を、保存・復元を
         またいでそのまま表現できるようにするため。一部が要確認でも、確定した項目
         (symbol / time_start / time_end / note)は捨てず、そのままLive Boardへ届ける。 */
      symbol_review: !!input.symbol_review,
      time_review: !!input.time_review,
      note_review: !!input.note_review,
      other_review: !!input.other_review,
      needs_review: !!input.needs_review,
      review_reason: normalizeReviewReason(input.review_reason),
      source: VALID_SOURCES[source] ? source : 'manual',
      updated_at: asTrimmed(input.updated_at) || asTrimmed(context.now)
    };
  }

  /* 旧形式(STAMP_DATAのエントリ)から正本レコードへ。Legacy経路と旧キー取り込みで使う。 */
  function fromLegacyEntry(room, entry, context) {
    entry = entry || {};
    return buildRecord({
      room: room,
      symbol: entry.symbol,
      time_start: entry.time_start !== undefined ? entry.time_start : entry.time,
      time_end: entry.time_end,
      time_mode: entry.time_mode,
      note: entry.note,
      note_raw: entry.note_raw,
      name: entry.name,
      schedule_date: entry.scheduleDate,
      schedule_day: entry.scheduleDay,
      raw_checkboxes: entry,
      symbol_review: entry.symbol_review,
      time_review: entry.time_review,
      note_review: entry.note_review,
      other_review: entry.other_review,
      needs_review: entry.needs_review,
      review_reason: entry.review_reason,
      source: (context && context.source) || entry.source
    }, context);
  }

  /* 正本レコードから、既存の描画コード(initScheduleLabels/renderFloors)が読む形へ。
     【重要】これは表示用の派生ビューであり、正本ではない。保存対象にもしない。 */
  function toLegacyEntry(record) {
    return {
      symbol: record.symbol,
      time: record.time_start,
      time_end: record.time_end,
      time_mode: record.time_mode,
      note: record.note,
      note_raw: record.note_raw,
      name: record.name,
      scheduleDate: record.schedule_date,
      scheduleDay: record.schedule_day,
      a_checked: record.raw_checkboxes.a,
      p_checked: record.raw_checkboxes.p,
      cancel_checked: record.raw_checkboxes.cancel,
      symbol_review: record.symbol_review,
      time_review: record.time_review,
      note_review: record.note_review,
      other_review: record.other_review,
      needs_review: record.needs_review,
      review_reason: record.review_reason.slice(),
      source: record.source
    };
  }

  function knownRoomSet(knownRooms) {
    if (!knownRooms) return null;
    if (typeof knownRooms.has === 'function') return knownRooms;
    var set = {};
    var list = Array.isArray(knownRooms) ? knownRooms : Object.keys(knownRooms);
    list.forEach(function (r) { set[asTrimmed(r)] = true; });
    return { has: function (room) { return !!set[room]; } };
  }

  function isNewer(candidate, current) {
    if (!current) return true;
    var a = asString(candidate && candidate.updated_at);
    var b = asString(current.updated_at);
    if (!a) return false;
    if (!b) return true;
    return a >= b;
  }

  /* ストア本体。
     adapters は { list(prefix), get(key), set(key, value), remove(key) } を持つ非同期I/O。
     index.html では「IndexedDB(必ず成功) + リモート(失敗時は送信キュー)」の既存機構を渡し、
     テストではメモリ実装を渡す。ストア自身は保存先の種類を知らない。

     [2026-08-22追加] 任意で getMany(prefix, keys) を持てる。prefixに一致する保存データを
     1回の通信でまとめて返す取得口で、実装したアダプタでは復元時に get() を1件も呼ばない。
     背景: 復元は「キー一覧 → キーごとに get()」という形だったため、実端末のStampStore
     259件でページを開くたびに259回の kv_store GET(key=eq.stamp:<物件>:<部屋>)が飛んでいた
     (2026-08-22 実Safariで確認、request stormの第2原因)。保存キーの形式・復元結果・
     保存側の挙動は一切変えず、取得の通信回数だけを部屋数に比例しない形へ落とす。 */
  function createStampStore(options) {
    options = options || {};
    var adapters = options.adapters || {
      list: function () { return Promise.resolve([]); },
      get: function () { return Promise.resolve(null); },
      set: function () { return Promise.resolve(); },
      remove: function () { return Promise.resolve(); }
    };
    var nowFn = options.now || function () { return new Date().toISOString(); };
    var propertyKey = normalizePropertyKey(options.propertyKey);
    var records = {};

    function scopePrefix() { return KEY_PREFIX + propertyKey + ':'; }
    function keyFor(room) { return scopePrefix() + room; }

    function setPropertyKey(nextKey) {
      var next = normalizePropertyKey(nextKey);
      if (next === propertyKey) return propertyKey;
      propertyKey = next;
      // 物件が変わったらメモリ上の予定情報は必ず捨てる(前物件の値が同じ部屋番号へ残らない)。
      records = {};
      return propertyKey;
    }

    function getPropertyKey() { return propertyKey; }
    function clearMemory() { records = {}; }
    function get(room) { return records[asTrimmed(room)] || null; }
    function has(room) { return !!records[asTrimmed(room)]; }
    function rooms() { return Object.keys(records); }
    function all() {
      var out = {};
      Object.keys(records).forEach(function (room) { out[room] = records[room]; });
      return out;
    }
    /* 描画用の派生ビュー(旧STAMP_DATA相当)をまとめて作る。 */
    function toStampDataView() {
      var out = {};
      Object.keys(records).forEach(function (room) { out[room] = toLegacyEntry(records[room]); });
      return out;
    }

    /* 予定情報を書き込む唯一の入口。
       - MASTER(knownRooms)に無い部屋は絶対に受け付けない(OCRからMASTERを作らないため)
       - 受け付けた分だけ、メモリと保存先へ同じ内容で書く

       [2026-08-22変更 request storm 本体の修正]
       メモリへの反映は【従来どおり同期】で行う(呼び出し元 applyStampRecordsToLb() は
       putMany() の直後に同期で syncStampDataFromStore() を呼ぶため、ここを非同期化すると
       画面に出なくなる)。変わったのは「保存先へ実際に送るかどうか」の判定だけ。 */
    function putMany(inputs, opts) {
      opts = opts || {};
      var known = knownRoomSet(opts.knownRooms);
      var now = nowFn();
      var list = Array.isArray(inputs) ? inputs : Object.keys(inputs || {}).map(function (room) {
        var v = inputs[room] || {};
        if (v.room === undefined && v.room_number === undefined) v = Object.assign({}, v, { room: room });
        return v;
      });

      var saved = [];
      var rejected = [];
      var pending = [];
      list.forEach(function (input) {
        var record = buildRecord(input, { propertyKey: propertyKey, now: now, source: opts.source });
        if (!record.room) { rejected.push({ room: '', reason: 'EMPTY_ROOM' }); return; }
        if (known && !known.has(record.room)) { rejected.push({ room: record.room, reason: 'NOT_IN_MASTER' }); return; }
        records[record.room] = record;
        saved.push(record.room);
        pending.push({ room: record.room, key: keyFor(record.room), record: record });
      });
      return writeRecords(pending).then(function () {
        return { saved: saved, rejected: rejected };
      });
    }

    function ignoreWriteError(p) {
      return (p && typeof p.catch === 'function') ? p.catch(function () {}) : p;
    }
    /* updated_at だけを除いた比較用の姿。updated_at は「どちらが新しいか」を決めるためだけの
       項目で、記号・時刻・備考・チェック・要確認などの業務上の値は一切含まない。
       buildRecord() が常に同じ順序で組み立てるので、文字列比較で厳密に比べられる。 */
    function contentWithoutUpdatedAt(record) {
      var copy = Object.assign({}, record);
      copy.updated_at = '';
      return JSON.stringify(copy);
    }
    /* 保存先から読んだ素のレコードを、復元(loadAll)とまったく同じ規則で正本の姿へ戻す。 */
    function normalizeStoredRecord(parsed, room) {
      if (!parsed) return null;
      return buildRecord(Object.assign({}, parsed, { room: room }),
        { propertyKey: propertyKey, now: parsed.updated_at });
    }

    /* [2026-08-22新設 request storm 本体の修正] 保存先へ実際に送る分だけを送る。

       【直した症状(2026-08-22 実Safari / localhost:3000 で実測)】
       Network履歴を削除して何も操作せず数秒待つだけで kv_store のリクエストが100件以上出た。
       1件クリックして得たURLは
         select=id&property_id=eq.<uuid>&key=eq.stamp:コスモ六甲ガーデンフォート:113
         &shared=eq.true&owner_id=is.null
       で、部屋番号だけが違うものが並んでいた。この形は window.storage.set() の既存行検索
       (＝書き込みの前段)だけが作る。発火元は index.html の seedDemoState() で、
       「デモを開く」たびに冒頭のハードコードされた予定情報129室ぶんを putMany() し、
       1室につき「select id」＋「update/insert」の2リクエスト = 258リクエストを、
       内容が1バイトも変わっていないのに毎回そのまま送り直していた
       (リモートが500で落ちていると、その129件がそのまま送信キューへ積まれ、
        5秒ごとの再送でさらに増え続ける)。

       【直し方】新しい保存層もアダプタも増やさず、既にある一括取得(adapters.getMany、
       index.html では storageListValues → kv_store の prefix 1回GET)を1回だけ使い、
       「保存先に既に在る内容」と突き合わせる。updated_at を除いて完全一致する分だけ送らない。
       送らないのは【送っても保存内容が1バイトも変わらない書き込み】だけなので、
       点検済み・不在・キャンセル・サイン・時刻・stamp値・room状態の最終保存内容は変わらない。
       1件でも違えば従来どおり送る(通信を減らすために保存判定を雑にしない)。

       送らなかった分は、保存先側の updated_at をメモリの正本へ合わせておく。こうしないと
       メモリだけが新しい updated_at を持ち、他の点検員が後から入れた本当の更新を
       loadAll() の isNewer() が「古い」と誤判定して取りこぼす。

       adapters.getMany を持たないアダプタ(メモリ実装・既存テスト)では、比較のために
       1件ずつ読み直すと通信が部屋数に比例して元へ戻るため、従来どおり全件送る。 */
    function writeRecords(pending) {
      if (!pending.length) return Promise.resolve();
      if (typeof adapters.getMany !== 'function') {
        return Promise.all(pending.map(function (p) {
          return ignoreWriteError(adapters.set(p.key, JSON.stringify(p.record)));
        }));
      }
      return readRecordsFor(scopePrefix(), pending.map(function (p) { return p.key; }))
        .then(function (byKey) {
          var writes = [];
          pending.forEach(function (p) {
            var stored = normalizeStoredRecord(byKey[p.key], p.room);
            if (stored && contentWithoutUpdatedAt(stored) === contentWithoutUpdatedAt(p.record)) {
              // 送っても保存先の内容は変わらない。メモリの正本を保存先の姿へ揃えて終わり。
              // (この待ち時間中に同じ部屋がもっと新しい内容で上書きされていたら触らない)
              if (records[p.room] === p.record) p.record.updated_at = stored.updated_at;
              return;
            }
            writes.push(ignoreWriteError(adapters.set(p.key, JSON.stringify(p.record))));
          });
          return Promise.all(writes);
        });
    }

    function put(input, opts) {
      return putMany([input], opts).then(function (r) {
        return { saved: r.saved, rejected: r.rejected, record: r.saved.length ? records[r.saved[0]] : null };
      });
    }

    function remove(room) {
      var key = asTrimmed(room);
      delete records[key];
      var p = adapters.remove(keyFor(key));
      return (p && typeof p.catch === 'function') ? p.catch(function () {}) : Promise.resolve();
    }

    /* 保存されている文字列(またはオブジェクト)を正本レコードの素の形へ戻す。
       壊れていれば null。ここは1件取得でもまとめ取りでも共通で通す。 */
    function parseRecordValue(value) {
      if (!value) return null;
      try {
        var parsed = (typeof value === 'string') ? JSON.parse(value) : value;
        if (!parsed || typeof parsed !== 'object') return null;
        return parsed;
      } catch (err) { return null; }
    }

    function readRecord(key) {
      return Promise.resolve(adapters.get(key)).then(parseRecordValue).catch(function () { return null; });
    }

    /* [2026-08-22追加 request storm対策] 復元対象のキーぶんの値をまとめて読む。
       返り値は { key: 素のレコード or null }。

       ・adapters.getMany があるとき : それ「だけ」を使う。1件ずつの adapters.get へは
         絶対に落とさない(落とすと通信量が部屋数に比例して元へ戻り、stormが再発する)。
         リモートが読めないときにローカルから復元するのは getMany 側の責務。
       ・getMany が無いとき         : 従来どおり1件ずつ順に読む(メモリ実装・既存テスト用)。 */
    function readRecordsFor(prefix, keys) {
      if (typeof adapters.getMany !== 'function') {
        return keys.reduce(function (chain, key) {
          return chain.then(function (acc) {
            return readRecord(key).then(function (parsed) { acc[key] = parsed; return acc; });
          });
        }, Promise.resolve({}));
      }
      return Promise.resolve(adapters.getMany(prefix, keys.slice())).then(function (byKey) {
        byKey = byKey || {};
        var out = {};
        keys.forEach(function (key) {
          out[key] = parseRecordValue(
            Object.prototype.hasOwnProperty.call(byKey, key) ? byKey[key] : null);
        });
        return out;
      }).catch(function () {
        // getMany は例外を投げない契約だが、万一投げても1件ずつの再取得はしない。
        var out = {};
        keys.forEach(function (key) { out[key] = null; });
        return out;
      });
    }

    /* 復元。保存済みの正本をそのままメモリへ戻すだけで、値の再解釈はしない。
       - MASTERに無い部屋は復元しない(66室のMASTERを壊さない)
       - 現スコープに1件も無い場合だけ、旧キー(fireflow-stamp:*)を一度だけ取り込む */
    function loadAll(opts) {
      opts = opts || {};
      var known = knownRoomSet(opts.knownRooms);
      var prefix = scopePrefix();
      var restored = [];
      var skipped = [];
      return Promise.resolve(adapters.list(prefix)).catch(function () { return []; }).then(function (keys) {
        keys = Array.isArray(keys) ? keys : [];
        /* [2026-08-22変更 request storm対策] 先に「実際に復元するキー」だけへ絞り、
           その分をまとめて1回で取る。絞り込み条件(空部屋名を捨てる / MASTERに無い部屋は
           復元しない)も、キーの並び順も従来と同じなので、復元結果は1件も変わらない。 */
        var targets = [];
        keys.forEach(function (key) {
          var room = String(key).slice(prefix.length);
          if (!room) return;
          if (known && !known.has(room)) { skipped.push(room); return; }
          targets.push({ key: key, room: room });
        });
        return readRecordsFor(prefix, targets.map(function (t) { return t.key; })).then(function (byKey) {
          targets.forEach(function (t) {
            var parsed = byKey[t.key];
            if (!parsed) return;
            var record = buildRecord(Object.assign({}, parsed, { room: t.room }), { propertyKey: propertyKey, now: parsed.updated_at });
            if (isNewer(record, records[t.room])) {
              records[t.room] = record;
              restored.push(t.room);
            }
          });
        });
      }).then(function () {
        if (restored.length || opts.skipLegacyMigration) return { migrated: [] };
        return migrateLegacyKeys(known);
      }).then(function (migration) {
        return { restored: restored, skipped: skipped, migrated: migration.migrated };
      });
    }

    /* 旧キー(物件スコープ無し)の取り込み。現スコープに1件も無いときだけ実行する。
       旧キーは削除しない(取り込みに失敗しても元データを失わないため)。 */
    function migrateLegacyKeys(known) {
      var migrated = [];
      return Promise.resolve(adapters.list(LEGACY_KEY_PREFIX)).catch(function () { return []; }).then(function (keys) {
        keys = Array.isArray(keys) ? keys : [];
        /* [2026-08-22変更 request storm対策] 取得をまとめただけ。取り込む対象の判定
           (旧キーが在る / MASTERに在る部屋だけ)も書き込みの順序も従来と同じで、
           取り込む部屋が1室たりとも増えないようにしている。 */
        var targets = [];
        keys.forEach(function (key) {
          var room = String(key).slice(LEGACY_KEY_PREFIX.length);
          if (!room) return;
          if (known && !known.has(room)) return;
          targets.push({ key: key, room: room });
        });
        return readRecordsFor(LEGACY_KEY_PREFIX, targets.map(function (t) { return t.key; })).then(function (byKey) {
          return targets.reduce(function (chain, t) {
            return chain.then(function () {
              var parsed = byKey[t.key];
              if (!parsed) return null;
              // 旧キーの中身は「旧STAMP_DATAのエントリ」。正本レコードへ器を移すだけ。
              var record = parsed.schema_version
                ? buildRecord(Object.assign({}, parsed, { room: t.room }), { propertyKey: propertyKey, now: parsed.updated_at })
                : fromLegacyEntry(t.room, parsed, { propertyKey: propertyKey, now: nowFn(), source: 'migrated_legacy' });
              records[t.room] = record;
              migrated.push(t.room);
              return adapters.set(keyFor(t.room), JSON.stringify(record));
            });
          }, Promise.resolve());
        });
      }).then(function () { return { migrated: migrated }; }).catch(function () { return { migrated: migrated }; });
    }

    /* 現スコープの保存済みデータを消す(物件データのリセット時のみ使う)。 */
    function clearPersisted() {
      var prefix = scopePrefix();
      clearMemory();
      return Promise.resolve(adapters.list(prefix)).catch(function () { return []; }).then(function (keys) {
        return Promise.all((keys || []).map(function (key) {
          var p = adapters.remove(key);
          return (p && typeof p.catch === 'function') ? p.catch(function () {}) : p;
        }));
      }).then(function () { return true; });
    }

    return {
      SCHEMA_VERSION: SCHEMA_VERSION,
      KEY_PREFIX: KEY_PREFIX,
      LEGACY_KEY_PREFIX: LEGACY_KEY_PREFIX,
      setPropertyKey: setPropertyKey,
      getPropertyKey: getPropertyKey,
      keyFor: keyFor,
      put: put,
      putMany: putMany,
      get: get,
      has: has,
      all: all,
      rooms: rooms,
      remove: remove,
      loadAll: loadAll,
      clearMemory: clearMemory,
      clearPersisted: clearPersisted,
      toStampDataView: toStampDataView
    };
  }

  var api = {
    SCHEMA_VERSION: SCHEMA_VERSION,
    KEY_PREFIX: KEY_PREFIX,
    LEGACY_KEY_PREFIX: LEGACY_KEY_PREFIX,
    normalizePropertyKey: normalizePropertyKey,
    buildRecord: buildRecord,
    fromLegacyEntry: fromLegacyEntry,
    toLegacyEntry: toLegacyEntry,
    createStampStore: createStampStore
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else if (typeof window !== 'undefined') {
    window.FireFlowStampStore = api;
  }
})();
