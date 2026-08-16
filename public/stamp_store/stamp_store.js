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
     テストではメモリ実装を渡す。ストア自身は保存先の種類を知らない。 */
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
       - 受け付けた分だけ、メモリと保存先へ同じ内容で書く */
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
      var writes = [];
      list.forEach(function (input) {
        var record = buildRecord(input, { propertyKey: propertyKey, now: now, source: opts.source });
        if (!record.room) { rejected.push({ room: '', reason: 'EMPTY_ROOM' }); return; }
        if (known && !known.has(record.room)) { rejected.push({ room: record.room, reason: 'NOT_IN_MASTER' }); return; }
        records[record.room] = record;
        saved.push(record.room);
        writes.push(adapters.set(keyFor(record.room), JSON.stringify(record)));
      });
      return Promise.all(writes.map(function (p) {
        return (p && typeof p.catch === 'function') ? p.catch(function () {}) : p;
      })).then(function () {
        return { saved: saved, rejected: rejected };
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

    function readRecord(key) {
      return Promise.resolve(adapters.get(key)).then(function (value) {
        if (!value) return null;
        try {
          var parsed = (typeof value === 'string') ? JSON.parse(value) : value;
          if (!parsed || typeof parsed !== 'object') return null;
          return parsed;
        } catch (err) { return null; }
      }).catch(function () { return null; });
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
        return keys.reduce(function (chain, key) {
          return chain.then(function () {
            var room = String(key).slice(prefix.length);
            if (!room) return null;
            if (known && !known.has(room)) { skipped.push(room); return null; }
            return readRecord(key).then(function (parsed) {
              if (!parsed) return null;
              var record = buildRecord(Object.assign({}, parsed, { room: room }), { propertyKey: propertyKey, now: parsed.updated_at });
              if (isNewer(record, records[room])) {
                records[room] = record;
                restored.push(room);
              }
            });
          });
        }, Promise.resolve());
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
        return keys.reduce(function (chain, key) {
          return chain.then(function () {
            var room = String(key).slice(LEGACY_KEY_PREFIX.length);
            if (!room) return null;
            if (known && !known.has(room)) return null;
            return readRecord(key).then(function (parsed) {
              if (!parsed) return null;
              // 旧キーの中身は「旧STAMP_DATAのエントリ」。正本レコードへ器を移すだけ。
              var record = parsed.schema_version
                ? buildRecord(Object.assign({}, parsed, { room: room }), { propertyKey: propertyKey, now: parsed.updated_at })
                : fromLegacyEntry(room, parsed, { propertyKey: propertyKey, now: nowFn(), source: 'migrated_legacy' });
              records[room] = record;
              migrated.push(room);
              return adapters.set(keyFor(room), JSON.stringify(record));
            });
          });
        }, Promise.resolve());
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
