# FireFlow / Live Board — request storm 第2原因（StampStore）最小修正

作成日: 2026-08-22
判定: **STAMPSTORE_REQUEST_STORM_PARTIAL**（実ブラウザ確認が未実施のため）

---

## 1. 確定事実（修正前）

2026-08-22、実Safari / localhost:3000 のNetwork履歴で、
kv_store への大量GETを直接確認した。

```
select=id
property_id=eq.b6e18eed-f2f3-4674-812d-322732908616
key=eq.stamp:コスモ六甲ガーデンフォート:102
shared=eq.true
owner_id=is.null
```

`key=eq.stamp:<物件名>:<部屋番号>` という形は、
StampStoreの復元経路以外からは出ない。

---

## 2. FIRST_BREAK

推測を挟まず、実コードの接続を確認した。

| # | 位置 | 実装 |
|---|---|---|
| 1 | `public/index.html:4733` | `reloadStampStoreForCurrentProperty()` → `stampStore.loadAll()` |
| 2 | `public/stamp_store/stamp_store.js` `loadAll()` | `adapters.list(prefix)` でキー一覧 → **キーごとに** `adapters.get(key)` |
| 3 | `public/index.html` `createStampStore({adapters})` | `get: (key) => storageGet(key, true)` |
| 4 | `public/index.html` `storageGet()` | remote-first → `window.storage.get(key, shared, propertyId)` |
| 5 | `public/supabase-integration.js:423` | `sb.from('kv_store').select('value').eq('key', key)...maybeSingle()` |

**FIRST_BREAK = stamp_store.js の `loadAll()` 内の
`keys.reduce(... readRecord(key) ...)`。**
ここで「キーの件数ぶんだけ1件GET」が確定的に発生していた。

実端末のStampStoreは259件 → 復元1回につき **259 GET**。

---

## 3. ROOT_CAUSE

StampStoreの復元が「一覧取得 → 1件ずつ本体取得」という
N+1 の形のままだった。保存件数（部屋数）に比例して通信が増える。

2026-08-19 の request storm STEP B（binder / schedule override のまとめ取り）は
`loadAll()`（index.html 側の部屋状態ポーリング）だけを対象にしており、
StampStore は経路が別だったため取り残されていた。

---

## 4. 修正前 / 修正後の request 数

| 状況 | 修正前 | 修正後 |
|---|---|---|
| 129室の物件 | 約 129 GET | **2**（list 1 + listValues 1） |
| 259件（実端末） | 259 GET | **2**（list 1 + listValues 1） |
| 旧キー取り込みが走る場合 | 1 + N GET | +2（list 1 + listValues 1） |

自動テストで実測（`stampstore_request_storm_fix_verify.js`）。
件数を倍にしても通信回数が変わらないこと（部屋数に比例しないこと）も検証済み。

---

## 5. 一括取得の方法

**新しいstorage層は作っていない。** 2026-08-19 に追加済みの一本道を再利用した。

```
StampStore.loadAll()
  → readRecordsFor(prefix, keys)        ← 今回追加（stamp_store.js内の内部関数）
  → adapters.getMany(prefix, keys)      ← 今回追加（index.html の結線に1つ追加）
  → readRoomValuesBulk()                ← 既存（2026-08-19）
  → storageListValues()                 ← 既存
  → window.storage.listValues()         ← 既存（select('key,value') + like('key', prefix+'%')）
```

- `adapters.getMany` を持たないアダプタ（メモリ実装・既存unit test）は、
  従来どおり1件ずつ取得する。既存テストの期待値は1つも変えていない。
- `getMany` を持つアダプタでは、`adapters.get()` は復元中に **1回も呼ばれない**。

---

## 6. legacy key（`fireflow-stamp:*`）の扱い

**扱いは1ミリも広げていない。**

- 取り込み条件は従来どおり「現物件スコープの復元が0件のときだけ」。
- 対象部屋も従来どおり「MASTER（FLOORS）に在る部屋だけ」。
- 旧キーは削除しない。
- `skipLegacyMigration: true` の挙動も従来どおり。
- 変えたのは「取り込み対象の値をまとめて読むか、1件ずつ読むか」だけ。

`migrateLegacyKeys()` による D_WEAK 自動割当の問題は Phase 1E-C / 1E-B の課題であり、
今回は触っていない。

---

## 7. property scope への影響

**なし。** 保存キーは `stamp:<PROPERTY.name>:<部屋番号>` のまま。
propertyId 化（Phase 1E-C）は行っていない。
`PROPERTY_SCOPE_ENABLED` が true でも stamp キーへ propertyId は付与されない
（`PROPERTY_SCOPED_KEY_PREFIXES` に `stamp:` は含まれていない = 従来どおり）。

---

## 8. offline への影響

remote失敗時はローカル（IndexedDB）へ倒す。**1件ずつのremote再取得へは戻さない。**

| 状況 | 挙動 |
|---|---|
| remote 0件、localにだけ在る | localから復元（旧実装と同じ） |
| remote error / オフライン | 全件localから復元、追加GET 0回 |
| `window.storage.listValues` 非対応（起動直後・古いシム） | localから復元、追加GET 0回 |

まとめ取りで得た値は従来どおり IndexedDB へ書き戻すので、
オフライン時の復元元は維持される。

---

## 9. 保存（set / put）への影響

**なし。** `putMany` / `put` / `remove` は1文字も変えていない。
点検済み・不在・キャンセル・署名・時刻・その他stamp値の保存結果は同一。

---

## 10. outbox への影響

**なし。** 復元経路は `storageSet` / `storageDelete` / `lcPut('outbox')` を1度も呼ばない。
loadAll 前後で outbox の中身が1件も変わらないことをテストで確認。
Phase 1E-0 の「propertyId無し旧outbox保持」も壊していない。

---

## 11. 変更ファイル

| ファイル | 内容 |
|---|---|
| `public/stamp_store/stamp_store.js` | `parseRecordValue()` / `readRecordsFor()` を追加。`loadAll()` と `migrateLegacyKeys()` を「絞り込み → まとめ取り」へ変更 |
| `public/index.html` | `createStampStore({adapters})` に `getMany` を1つ追加（既存 `readRoomValuesBulk` を使うだけ） |
| `public/test/stampstore_request_storm_fix_verify.js` | 新規TEST-V |
| `package.json` | `test:release` へ新規テストを追加 |
| `test/unit/lb/stampStorageAdapterRoundTrip.test.ts` | sandboxへ `storageListValues` / `readValueFromLocalCache` / `readRoomValuesBulk` の実ソースを追加（結線が依存するようになったため。期待値は変更なし） |

Phase 1E-A1 の未コミット差分は一切 rollback していない。

---

## 12. 残課題

- 実Safari / localhost:3000 での目視確認（下記15）
- `migrateLegacyKeys()` の D_WEAK 自動割当（Phase 1E-C / 1E-B）
- StampStore の propertyId 化（Phase 1E-C）
- Phase 1E-A1 の再開

---

## 13. 実ブラウザ確認手順（人間）

1. Safari で `http://localhost:3000` を開く
2. Web インスペクタ → Network → 履歴を削除
3. そのまま5秒放置

確認項目：

- [ ] `key=eq.stamp:*` の1件ずつGET連打が消えている
- [ ] kv_store 全体のリクエスト数が大幅に減っている
- [ ] 500 = 0件
- [ ] 部屋カードの状態（記号・時刻・備考・要確認）が正常
- [ ] reload後も正常
