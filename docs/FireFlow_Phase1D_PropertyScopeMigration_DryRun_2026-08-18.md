# FireFlow / Live Board Phase 1D — 旧保存データ → propertyId scope migration 設計・dry-run

基準commit: `dfafb6b` (fix: prevent outbox data loss on sync failure)
作成: 2026-08-18 / 本migrationは未実行（設計・dry-runのみ）

---

## 0. 判定

**PHASE1D_DRYRUN_GO**（設計・dry-run実装・検証は完了）
**本migrationの実行は STOP**（後述の§9 GATEが未充足のため）

---

## 1. legacy保存構造（dfafb6bの実コードから再抽出）

### 1.1 保存の経路

```
現場入力 → storageSet(rawKey, value, shared)
            ├─ lcPut('cache', {key: lcCacheKey(rawKey, shared), value})   ← IndexedDB即時保存
            └─ window.storage.set(rawKey, value, shared, propertyId)      ← Supabase kv_store
                 失敗時 → lcPut('outbox', {...}) → flushOutbox()で再送
```

`lcCacheKey(key, shared) = (shared ? 'shared:' : 'own:') + key`（Phase 1Cでも不変）。

### 1.2 業務キー全量（storageGet/Set/Delete/List を通る全キー）

| 定義箇所 (index.html) | legacyKey |
|---|---|
| `keyFor()` L4798 | `fireflow-binder:<room>` |
| `scheduleOverrideKeyFor()` L4804 | `fireflow-schedule-override:<room>` |
| `equipKeyFor()` L5527 | `fireflow-equip:<設備名>` |
| `extKeyFor()` L9208 | `fireflow-ext:<no>` |
| `CURRENT_PROPERTY_KEY` L4825 | `fireflow-property:current` |
| `BUILDING_NOTES_KEY` L7315 | `fireflow-property:buildingNotes` |
| `BO_TABLE_KEY_PREFIX` L7377 | `fireflow-property:boTable:<行>` |
| `PROGRESS_LOG_KEY` L7469 | `fireflow-property:progressLog` |
| `SITE_SUPERVISOR_KEY` L8419 | `fireflow-property:siteSupervisor` |
| `SCHEDULE_DAYS_KEY` L8492 | `fireflow-property:scheduleDays` |
| `EQUIPMENT_LIST_KEY` L9090 | `fireflow-property:equipmentList` |
| `UPLOADED_DOCUMENTS_KEY` L4058 | `fireflow-documents` |
| `PRESENCE_KEY_PREFIX` L6171 | `fireflow-presence:<user>` |

### 1.3 property scope 対象外（明示除外）

- **端末設定**（`localStorage` 直接、storage層を通らない）:
  `lb_splash_seen` / `lb_onboarding_seen` / `lb_kantan_mode` / `lb_font_scale` /
  `lb_lock_mode` / `lb_lock_pin` / `lb_field_test_mode` / `lb_field_test_data` /
  `lb_test_force_demo_boot`
- **StampStore**（Phase 1E担当）: `stamp:<物件名>:<部屋>` / 旧 `fireflow-stamp:<部屋>`
- `fireflow-current-property-id`: **コード上に実装は存在しない**（コメント内の言及のみ）。
  currentPropertyId は永続化されていない（§3参照）。

---

## 2. 旧キー → 新キー対応表

| domain | legacyKey | scopedKey pattern | propertyId required | propertyId evidence | migration possible | collision risk | delete legacy? | Phase |
|---|---|---|---|---|---|---|---|---|
| propertyCurrent | `fireflow-property:current` | `fireflow-property:<pid>:current` | YES | **A**（レコード自身） | ○ | 低（単一スロット） | NO（今回） | 1D |
| binder | `fireflow-binder:<room>` | `fireflow-binder:<pid>:<room>` | YES | B+C | 条件付き | 中 | NO | 1D |
| scheduleOverride | `fireflow-schedule-override:<room>` | `fireflow-schedule-override:<pid>:<room>` | YES | B+C | 条件付き | 中 | NO | 1D |
| equip | `fireflow-equip:<名>` | `fireflow-equip:<pid>:<名>` | YES | B+C | 条件付き | 中 | NO | 1D |
| ext | `fireflow-ext:<no>` | `fireflow-ext:<pid>:<no>` | YES | B+C | 条件付き | 中 | NO | 1D |
| buildingNotes / progressLog / siteSupervisor / scheduleDays / equipmentList | `fireflow-property:<名>` | `fireflow-property:<pid>:<名>` | YES | B | 条件付き | 低 | NO | 1D |
| boTable | `fireflow-property:boTable:<行>` | `fireflow-property:<pid>:boTable:<行>` | YES | B | 条件付き | 低 | NO | 1D |
| documents | `fireflow-documents` | `fireflow-documents:<pid>` | YES | B | 条件付き | 低 | NO | 1D |
| presence | `fireflow-presence:<user>` | `fireflow-presence:<pid>:<user>` | YES | B | 条件付き | 低 | NO | 1D |
| stamp | `stamp:*` / `fireflow-stamp:*` | — | — | — | **対象外** | — | NO | **1E** |
| 端末設定 | `lb_*` | — | — | — | **対象外** | — | NO | — |

変換規則は製品の `propertyScopedKey()`（index.html L4258）と同一で、テストで機械的に一致を固定している。

---

## 3. propertyId確定根拠（強度別）

| 記号 | 強度 | 内容 |
|---|---|---|
| **A_RECORD_PROPERTY_ID** | STRONG | 保存レコード自身が有効なpropertyIdを持つ（`fireflow-property:current` の `property.propertyId` のみ） |
| **B_SINGLE_SCOPE_INVARIANT** | STRONG | 「この端末の保存領域は1つのpropertyIdしか持ち得なかった」ことがコード上で証明できる |
| **C_MEMBERSHIP** | CONDITIONAL | 現物件レコードの部屋/設備/消火器一覧に、そのキーの対象が含まれる |
| **D_WEAK** | WEAK | 部屋番号一致・物件名一致・保存日時が近い・**今開いている物件だから** |
| **E_UNKNOWN** | UNKNOWN | 根拠なし |

**D / E だけでの移行は禁止。** dry-runテストで「D/E根拠のMIGRATABLE = 0件」を機械確認している。

### 3.1 B_SINGLE_SCOPE_INVARIANT の根拠（実コード・全git履歴で確認済み）

1. `supabase-integration.js:64` — `var currentPropertyId = INITIAL_PROPERTY_ID;`
2. `supabase-integration.js:26` — `INITIAL_PROPERTY_ID = 'b6e18eed-f2f3-4674-812d-322732908616'`
3. `setCurrentPropertyId()` は **製品コードからの呼び出し箇所が0**（Phase 1A verifyでも固定済み。物件切替の結線はPhase 1E）
4. Phase 1A以前（`9dc3811`）の固定 `PROPERTY_ID` も **同一UUID**
5. `createProperty()` は新UUIDを発行するがUIにもcurrentPropertyIdにも未接続

⇒ kv_store の既存行の `property_id` はすべてこのUUID。IndexedDBキャッシュはその1区画の写し。
⇒ 旧キーを `<このUUID>` スコープへ入れる操作は「別の物件へ動かす」ことではなく、
  **「既に入っている区画をキー側にも明示する」relabel** に等しい。

### 3.2 B だけでは足りない理由（Phase 1D設計の核心）

`parseExcelAndRebuild()`（L9608）は**別の建物のExcelを読み込んでも旧キーを削除しない**。
`resetInspectionDataForCurrentRoomSet()`（L4952）を呼ぶのは
`createNewProperty()`（L8922）と データリセット確認（L10472）の2経路だけで、
しかも「呼んだ時点のFLOORSに在る部屋」しか消さない。

⇒ 1台の端末の旧キー空間には **複数の実建物のデータが混在し得る**。
⇒ 混在痕跡（orphan）が1件でもあれば、部屋・設備単位のデータがどの建物のものか一意に決まらない。

---

## 4. MIGRATABLE / UNKNOWN / AMBIGUOUS の条件

**MIGRATABLE**
- `fireflow-property:current`: 根拠 **A** のみ。レコード自身が有効propertyIdを持つこと。
- それ以外: 根拠 **B かつ C**。すなわち
  (a) 現物件レコードから読めたpropertyIdが `LEGACY_FIXED_PROPERTY_ID` と一致（＝invariant成立）、かつ
  (b) 混在痕跡が0件、かつ
  (c) キーの対象が現物件レコードの部屋/設備/消火器一覧に含まれる（singleton/presenceは(c)免除）
- さらに移行先が空（TARGET_EMPTY）であること。

**UNKNOWN_PROPERTY**（＝NEEDS_USER_ASSIGNMENT）
- current property record に propertyId が無い／壊れている
- current property record 自体が存在せず、invariantを確認できない

**AMBIGUOUS**
- 混在痕跡が検出された端末の、部屋・設備・消火器・singleton・presence の全キー（既定の厳格運用）
- 現物件レコードの一覧に無いキー（orphan）

**INVALID**: 値がJSONとして読めない／cacheキーが `own:`/`shared:` のどちらでもない
**SKIPPED_NON_PROPERTY_DATA**: `lb_*` 等の端末設定、スコープ対象外キー
**SKIPPED_PHASE1E**: `stamp:` / `fireflow-stamp:`

---

## 5. collisionルール

| 分類 | 意味 | 扱い |
|---|---|---|
| TARGET_EMPTY | 移行先が空 | MIGRATABLE |
| TARGET_EXISTS_SAME | 移行先に同値が在る | ALREADY_MIGRATED（複写しない。旧キーも今回削除しない） |
| TARGET_EXISTS_DIFFERENT | 移行先に異値が在る | **COLLISION。自動上書き禁止。人の判断が要る** |
| SOURCE_INVALID | 元データが壊れている | INVALID |
| SOURCE_UNKNOWN_PROPERTY | propertyIdを確定できない | UNKNOWN_PROPERTY |
| SOURCE_AMBIGUOUS | 一意に割当不能 | AMBIGUOUS |

**既存scopedデータは上書き0件**（テストで固定）。

---

## 6. Supabase 二重scope監査

`supabase/schema.sql:420` — `kv_store(property_id uuid not null, key text, value text, shared bool, owner_id uuid, unique(property_id, key, shared, owner_id))`

- 保存/読込/削除/一覧はすべて `.eq('property_id', ...)` で絞る（`supabase-integration.js:354/369/396/405`）。
- Phase 1C は **rawKey側にもpropertyIdを差し込む**ため、scope ON時は
  `property_id = <pid>` **かつ** `key = 'fireflow-binder:<pid>:101'` の**二重scope**になる。

**監査結論**: 二重scopeは冗長だが**無害**。理由:
1. 列側scopeがRLS（`kv_store_all_property_members`）とRealtimeフィルタ（L437）の正本であり、
   キー側scopeはIndexedDBローカルキャッシュの衝突回避が本来の目的（Phase 1Cの設計意図どおり）。
2. 二重になっても `unique(property_id, key, ...)` は破れない（keyが変わるだけ）。
3. `property_id` 列の値は移行前後で**変化しない**。つまりmigrationはSupabase上では
   「同一property区画内のkeyのrename」であり、行が別物件へ動くことはない。

**ただし本migration実行時の注意（未解決）**: kv_store側は rename ではなく
「新keyでinsert → 旧keyがそのまま残る」になる。**行数が最大2倍になる**。
現時点ではユーザー実測で `kv_store rows = 0` のため実害は無いが、
本migration設計時に旧key行の扱い（残す期間／削除条件）を確定する必要がある。
**今回DB変更は0件。**

---

## 7. outbox（§12）

分類のみ。**1件も変更していない。**

| status | 条件 | 扱い |
|---|---|---|
| ALREADY_SCOPED | `alreadyScoped === true` かつ有効propertyId | そのpropertyIdへ送られる（Phase 1Cで実装済み） |
| MIGRATABLE | 有効propertyIdを持つが `alreadyScoped` 未設定 | 本migrationで整合させる |
| NEEDS_USER_ASSIGNMENT | propertyId無しの旧item | **変更0・削除0・送信0**。currentPropertyIdを勝手に入れない |
| INVALID | rawKey が無い壊れたitem | 変更0・削除0 |
| SKIPPED_NON_PROPERTY_DATA | 業務キーではない | 対象外 |

Phase 1C の `flushOutbox()`（index.html L4386）は既に「propertyId無し旧itemを送信せず保持」を実装済み。

---

## 8. rollback / idempotent 設計

### 8.1 監査ログ（形の定義のみ。今回永続化は実装しない）

`buildAuditRecord()` が返す形:
`{ runId, migrationVersion, timestamp, sourceKey, targetKey, shared, propertyId, evidence, status, sourceHash, targetHashBefore, createdByMigration }`

- `createdByMigration = (targetExisted === false)` — **migrationが作ったtargetだけを識別する印**。
- rollback可否は `canRollback(auditRecord, currentTargetValue)`:
  1. `createdByMigration !== true` → **false**（元から在った既存scopedデータは絶対に消さない）
  2. 移行先が既に無い → false
  3. 現在値のハッシュ ≠ 複写時のハッシュ → **false**（複写後に現場入力があったものは消さない）

### 8.2 idempotent

- version: `property-scope-v1`
- 再実行時の判定: 領域名の直後の1区画が有効UUIDなら **ALREADY_MIGRATED**（再移行しない）
- テストで「2回目の計画で MIGRATABLE = 0 / COLLISION 増加 = 0 / 別物件へ動かない」を固定

### 8.3 旧キー削除（§10）

今回削除0。将来の本migrationでも
`copy → read-back → 完全一致確認 → migration marker → 旧キー削除` の即時削除は**採らない**方針を推奨する。
理由: 旧キーはPhase 1C flag OFF時の読み取り先そのものであり、
flag ONで問題が出た場合のrollback先が消える。
**推奨: 旧キーは一定期間（最低1点検サイクル）残し、flag ONでの実運用が確認できてから別タスクで削除する。**

---

## 9. 本migrationへ進むためのGATE（未充足）

本設計は「B_SINGLE_SCOPE_INVARIANT が成立し、混在痕跡が0件」の端末でのみ自動移行を許す。
成立するかは**実端末の実データを見ないと判定できない**。したがって:

1. 実端末（実Live Board）で dry-run を実行し、
   `contamination.detected` / 各statusの件数を実測する ← **未実施（要ユーザー操作）**
2. 実測結果で `contamination.detected === true` なら、
   部屋単位データは自動移行対象外。物件割当UI（Phase 1E相当）が先に必要。
3. COLLISION が1件でも出た場合、その解決方針をユーザーが決める。
4. kv_store 旧key行の扱い（§6）を確定する。

**1〜4が未充足のため、本migrationは実行しない。**

---

## 10. TEST_GAP（既存テストで検証されていなかった点）

Phase 1A/1B/1C/outbox の既存テストは「新スコープ機構が正しく動くか」だけを見ており、
**旧保存データの扱いは1件も検証していなかった**。今回追加でカバーした:

- 旧キー→新キー変換が製品の `propertyScopedKey()` と一致すること
- propertyId無しデータを推測割当しないこと
- 混在端末で部屋単位データを移行しないこと
- 既存scopedデータを上書きしないこと
- dry-runが完全read-onlyであること（WRITE/DELETE = 0）
- 2回計画しても重複・上書き・削除事故が起きないこと
- rollbackが既存データ・複写後の現場入力を消さないこと

**まだ無いテスト（本migration実装時に必要）**:
- 実複写処理の read-back 一致検証
- 複写中の異常終了からの再開
- kv_store 旧key行の増加に対する上限・警告

---

## 11. 変更ファイル

| ファイル | 内容 |
|---|---|
| `public/property_scope_migration.js` | 新規。純粋関数のみのmigration計画層（保存APIを構造的に持たない） |
| `public/test/phase1d_property_scope_migration_dry_run_verify.js` | 新規。dry-run検証 94件 |
| `package.json` | `test:release` へ Phase 1D テストを1行追加 |

**製品コード（`public/index.html` / `public/supabase-integration.js` / `public/stamp_store/stamp_store.js` / `supabase/schema.sql`）は差分0。**
