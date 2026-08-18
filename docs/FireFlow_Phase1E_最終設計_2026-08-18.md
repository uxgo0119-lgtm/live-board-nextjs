# FireFlow / Live Board Phase 1E 最終設計書
## 複数物件の正式分離 + 旧データ人間割当 + StampStore propertyId接続

基準commit: `3c739fc` (test: add real device migration dry run)
作成: 2026-08-18 / **本書は設計・監査のみ。製品コード差分 0。migration未実行。実データ変更 0件。**

---

## 0. 判定（結論を先に）

**PHASE1E_DESIGN_CONDITIONAL_GO**

GOだが、次の3条件を設計に組み込むことを必須条件とする（本書 §4・§20 に反映済み）。

| # | 条件 | 理由 |
|---|---|---|
| C-1 | **Phase 1E-A（物件切替）の前に Phase 1E-0（outbox物件安全化）を実施する** | 実端末の outbox 132件のうち **129件が propertyId を持たない非scope対象キー（stamp系）**。現在の `flushOutbox()` はこれを素通しし、**送信時点の `currentPropertyId` の区画へ書く**。物件切替を結線した瞬間に、A物件で溜めた未送信データがB物件へ流入する。§3.4 参照 |
| C-2 | **Phase 1E-C で `StampStore.migrateLegacyKeys()` の自動実行を止める** | 「現スコープに1件も無いときだけ旧キーを取り込む」実装は、propertyId scope化後は **「新しい物件を開いたから、物件不明の旧データを全部そこへ入れる」自動割当**そのものになる。課題文§3の禁止事項に真正面から抵触する既存コードである。§3.5 参照 |
| C-3 | **`PROPERTY_SCOPE_ENABLED = true` の実端末投入は Phase 1E-B（人間割当＋migration）の完了後に行う** | flag ONは読み取り先キーを切り替える。実端末の cache 274件は旧キーに在るため、**ONにした瞬間に現場から旧データが消えたように見える**（消えてはいないが読めない）。§10.3 参照 |

**実装は開始しない。** 本書は設計・監査の成果物であり、製品実装はユーザーの明示的なGO後に着手する。

---

## 1. 現状アーキテクチャ（実コードから再抽出。推測なし）

### 1.1 propertyId の現在の正本と流れ

```
supabase-integration.js:26   const INITIAL_PROPERTY_ID = 'b6e18eed-…'  ← コスモ六甲ガーデンフォート固定
supabase-integration.js:64   var currentPropertyId = INITIAL_PROPERTY_ID
supabase-integration.js:75   function setCurrentPropertyId(pid)   ← 唯一の変更経路。製品からの呼び出し 0
supabase-integration.js:81   window.getCurrentPropertyId()        ← 唯一の取得経路
      │
      ├─ index.html:4034   PROPERTY.propertyId = getCurrentPropertyId()   （起動時の写し）
      ├─ index.html:4287   currentScopePropertyId()  → applyPropertyScope() → 保存キーのscope
      ├─ supabase-integration.js:354/369/396/405   kv_store の property_id 列
      ├─ supabase-integration.js:437   Realtime購読フィルタ property_id=eq.<pid>
      ├─ supabase-integration.js:270/275  inspections（property_id + 日付でセッション確定）
      └─ supabase-integration.js:457  写真Storageのパス先頭
```

**確認した事実（grep実測）**

| 項目 | 実測 |
|---|---|
| `setCurrentPropertyId(` の index.html 内の呼び出し | **0件** |
| `listMyProperties(` の index.html 内の呼び出し | **0件** |
| `window.createProperty` の index.html 内の呼び出し | **0件**（使われているのは `createPropertyInvite` のみ・L7271） |
| `currentPropertyId` の永続化 | **存在しない**（localStorage・IndexedDB・kv_store のいずれにも無い） |
| `properties` テーブル | `schema.sql:59`。`id uuid primary key`。RLSは `property_members` 経由 |

⇒ **現在、Live Board上の「今の物件」は、リロードのたびに必ず `INITIAL_PROPERTY_ID` に戻る単一のメモリ変数である。**

### 1.2 「物件が変わる」既存経路（4つ）

| # | 経路 | 実装 | propertyIdを変えるか | PROPERTY.nameを変えるか | 旧キーを消すか |
|---|---|---|---|---|---|
| P1 | 起動ゲート「前回の物件を続ける」 | `initPropertyStartupGate()` L12258 → `applyCurrentPropertyRecord()` L4892 | **変えない** | 変える | 消さない |
| P2 | 起動ゲート「新規物件を作成」 | `createNewProperty()` L8917 | **変えない**（L8930で現在値を代入） | 変える | `resetInspectionDataForCurrentRoomSet()` で「呼んだ時点のFLOORSの部屋」だけ消す |
| P3 | 点検報告書Excel読込 | `parseExcelAndRebuild()` L9608 / L9891 | **変えない**（L9891で現在値を代入） | 変える（roster有り時） | **消さない** |
| P4 | 起動ゲート「デモを開く」 | `seedDemoState()` L4623 | 変えない | 変えない | 消さない |

### 1.3 保存キー体系（Phase 1C・flag既定OFF）

| domain | rawKey | scope対象 | scope後 |
|---|---|---|---|
| 物件レコード | `fireflow-property:current` | ○ | `fireflow-property:<pid>:current` |
| 部屋点検 | `fireflow-binder:<room>` | ○ | `fireflow-binder:<pid>:<room>` |
| 希望時刻上書 | `fireflow-schedule-override:<room>` | ○ | 同上 |
| 設備 | `fireflow-equip:<名>` | ○ | 同上 |
| 消火器 | `fireflow-ext:<no>` | ○ | 同上 |
| 物件付随 | `fireflow-property:buildingNotes` / `boTable:<行>` / `progressLog` / `siteSupervisor` / `scheduleDays` / `equipmentList` | ○ | 同上 |
| 資料 | `fireflow-documents` | ○ | `fireflow-documents:<pid>` |
| プレゼンス | `fireflow-presence:<user>` | ○ | 同上 |
| **予定情報** | **`stamp:<物件名>:<room>` / `fireflow-stamp:<room>`** | **×（対象外）** | **—（Phase 1E-C担当）** |
| 端末設定 | `lb_*` | ×（localStorage直・storage層を通らない） | — |

許可リストは `PROPERTY_SCOPED_KEY_PREFIXES` (L4235) / `PROPERTY_SCOPED_EXACT_KEYS` (L4243)。
未知キーは「スコープ無し（Phase 1B相当）」へ倒れる設計。

### 1.4 復元順序（リロード時。実コードの実行順）

```
1  supabase-integration.js 実行 → currentPropertyId = INITIAL_PROPERTY_ID
2  index.html トップレベル      → PROPERTY.propertyId = getCurrentPropertyId()（写し）
3  initPropertyStartupGate()   → loadCurrentPropertyRecord()
                                  = storageGet('fireflow-property:current', true)
4  利用者が「続ける」を選択     → applyCurrentPropertyRecord(record)
                                  PROPERTY / FLOORS / SENSOR_MASTER / EXTINGUISHER_DATA /
                                  EQUIPMENT_LIST / PREVIOUS_DEFECTS / LADDER_ROOMS /
                                  EVACUATION_EQUIPMENT_ROOMS / ROOM_SPACE_TYPE_FLAGS
                                  → restoreStampDataFromStorage() → reloadStampStoreForCurrentProperty()
5  bootMainAppOnce() → runMainAppBootSequence()  (L12154)
     loadAll()  … 部屋×(binder + schedule-override) を毎秒ポーリング
     loadSiteSupervisor() / loadScheduleDays() / loadEquipmentList() / loadUploadedDocuments()
     setInterval(loadAll, 1000) / sendPresenceHeartbeat()
6  （並行）afterLogin() → ensureInspectionSession() → installRealtimeSync()
```

**3 の時点で既に storage層を呼んでいる。** つまり `currentPropertyId` は storage層の最初の呼び出しより前に確定していなければならない（§8）。

---

## 2. FIRST_BREAK

「入力 → 解析 → 正規化 → 業務ルール → 保存 → 復元 → 描画」の線を追い、**最初に壊れる点**を確定した。

### FIRST_BREAK（本体）

> **`public/index.html:9891`（`parseExcelAndRebuild()`）および `public/index.html:8930`（`createNewProperty()`）が、
> 実在の建物を丸ごと差し替えながら `propertyId` を変えない。**

```js
// index.html:9891  ← 別の建物のExcelを読み込んだ直後
PROPERTY = { propertyId: window.getCurrentPropertyId(), name: buildingName, … };
//                       ^^^^^^^^^^^^^^^^^^^^^^^^^^^^ 前の建物のpropertyIdをそのまま引き継ぐ
```

ここで **「1つの propertyId に2棟以上の実建物が入る」** 状態が発生する。
`parseExcelAndRebuild()` は旧キー（binder / schedule-override / equip / ext）を1件も削除しないため、
旧キー空間に前の建物の記録が残ったまま、新しい建物の記録が同じキー空間へ追記される。

これが実端末で観測された事実の唯一の説明である。

- `contamination.detected = true`
- orphan: `fireflow-binder:807/810/811/813/817`, `fireflow-schedule-override:816/817`
- StampStore に **コスモ六甲ガーデンフォート** と **コスモ城東野江ロイヤルフォルム** が同居
  （StampStore だけは `PROPERTY.name` でscopeされているため、**建物が2つあることが見える形で残った**）
- binder / schedule-override は propertyId も物件名もキーに持たないため、**どちらの建物か区別できない**
  → `MIGRATABLE = 0` / `UNKNOWN_PROPERTY = 15` / `SKIPPED_PHASE1E = 259`

**重要**: Phase 1C の property scope を ON にしても、この FIRST_BREAK が残る限り**物件は分離されない**。
`propertyId` が1つしか無いのだから、キーに `propertyId` を差し込んでも全建物が同じ区画に入る。
**Phase 1E-A は「便利機能」ではなく、Phase 1C を意味あるものにする前提条件である。**

### 派生する破れ（同じ根から出る3つ）

| # | 場所 | 内容 |
|---|---|---|
| FB-2 | `index.html:12243`–`12262` | 復元の線。`loadCurrentPropertyRecord()` でレコードを読み `applyCurrentPropertyRecord()` で反映するが、**`record.property.propertyId` を `setCurrentPropertyId()` へ渡さない**。リロード後の現在物件は常に `INITIAL_PROPERTY_ID`。`currentPropertyId` はどこにも永続化されていない |
| FB-3 | `index.html:4568` `currentPropertyScopeKey()` | StampStoreの線。`normalizePropertyKey(PROPERTY.name)` を物件スコープの正本にしている。**表示名を識別子として使っており、絶対ルール5（正本を明確にする）に反する**。`PROPERTY.name` が空だと `'default'` に全物件が集まる（`stamp_store.js:51`） |
| FB-4 | `index.html:4448` / `4483` | outboxの線。**scope対象外キー（`stamp:*`）を outbox へ積むとき `propertyId` が `null`**（`applyPropertyScope()` が非対象キーに対し `propertyId:null` を返すため）。`flushOutbox()` L4386 の保護は `isPropertyScopedKey(rawKey)` が真のときだけ効くので、stamp系は素通しで **送信時点の `currentPropertyId` の区画**へ入る |

---

## 3. Phase 1E の目的と、実端末事実との対応

### 3.1 目的（1文）

> **「これから保存されるデータが、どの物件のものか常に一意に決まっている」状態を、
> 推測フォールバックを1つも増やさずに作る。**

旧データの救済（Phase 1E-B）は目的ではなく、上の状態が完成した後の**別工程**である（課題文§7）。

### 3.2 実端末事実 → 設計要件の対応表

| 実端末で確定した事実 | 設計要件 |
|---|---|
| `contamination.detected = true`（複数建物が1端末に混在） | 1E-A で建物単位に propertyId を採番・切替する。混在の**発生を止める**ことが先 |
| `MIGRATABLE = 0` | 旧データは自動移行できない。1E-B の人間割当が唯一の道 |
| `UNKNOWN_PROPERTY = 15` | binder 8件 + schedule override 3件 + singleton 4件。1件ずつ人間が決められる規模 |
| `SKIPPED_PHASE1E = 259` | StampStore。物件名scope済みのものは補助証拠として使える（§13.4） |
| outbox `NEEDS_USER_ASSIGNMENT = 3` | 既に Phase 1C の保護下（flag ON時）。1E-B の割当対象 |
| **outbox `SKIPPED_NON_PROPERTY_DATA = 129`** | **保護されていない。C-1（Phase 1E-0）の対象**（§3.4） |
| `cache = 274` / `outbox = 132` | flag ON で読めなくなる量。C-3 の根拠 |
| `kv_store rows = 0`（前回実測） | migration対象は IndexedDB のみでよい可能性が高い（§14.4）。実行時に再確認 |

### 3.3 「複雑化禁止」への適合（課題文§6）

本設計で**追加する正本は0**である。

- propertyId の正本 = `properties.id`（既存・不変）
- 実行時の現在物件 = `currentPropertyId`（既存の単一変数・既存の唯一のsetter/getterをそのまま使う）
- storage API = `storageSet/Get/Delete/List`（既存・変更なし）
- property scope = `applyPropertyScope()`（既存・変更なし）
- StampStore = 既存。**`stamp_store.js` は1行も変えない**（§12.2）

新規に足すのは「現在物件の**永続化1本**」と「切替を実行する関数1本」だけ。
fallback は1つも追加しない。既存の推測経路（`migrateLegacyKeys()` の自動実行）はむしろ**削除**する。

### 3.4 【C-1】outbox 129件の流入経路（確定）

```
現在: storageSet('stamp:コスモ六甲…:807', …)
  → applyPropertyScope() … isPropertyScopedKey('stamp:…') === false
                            → return { key: 元のまま, propertyId: null }
  → リモート失敗
  → lcPut('outbox', { rawKey:'stamp:…', propertyId: null, alreadyScoped: true })   ← index.html:4448

flushOutbox() L4386:
  if (PROPERTY_SCOPE_ENABLED && !item.alreadyScoped && isPropertyScopedKey(item.rawKey)) skip
     ↑ alreadyScoped===true なので条件不成立 → skipされない
  → storageSet(rawKey, …, { alreadyScoped:true, propertyId:null })
  → window.storage.set(key, value, shared, null)
  → supabase-integration.js:362  if (propertyId && propertyId !== currentPropertyId) … ← null なので分岐せず
  → 通常経路 = property_id 列に **その瞬間の currentPropertyId** を入れて insert
```

今日は `currentPropertyId` が1つしかないので無害。
**物件切替を結線した瞬間に、A物件の未送信129件がB物件のkv_storeへ入る。**
これは Phase 1E-A の副作用として静かに起きるため、**1E-Aより先に塞がなければならない**。

### 3.5 【C-2】`migrateLegacyKeys()` の自動割当（確定）

`stamp_store.js:312`

```js
if (restored.length || opts.skipLegacyMigration) return { migrated: [] };
return migrateLegacyKeys(known);   // ← 現スコープに1件も無いときだけ実行
```

`migrateLegacyKeys()` は `fireflow-stamp:<room>`（物件スコープ**無し**）を読み、
`known`（＝いま開いている物件のFLOORS）に在る部屋なら **現スコープへ書き込む**（L338 `adapters.set(keyFor(room), …)`）。

判断根拠は「いま開いている物件の部屋一覧に、その部屋番号がある」だけ。
これは Phase 1D の分類で **D_WEAK**（部屋番号一致・今開いている物件だから）であり、**単独では移行禁止**と定めた根拠そのものである。

現状は物件が1つしか無いので実害が出ていないが、1E-A/1E-C 後は
「新しい物件Bを開く → Bのstampは0件 → 旧 `fireflow-stamp:*` を全部Bへ取り込む」
という自動誤割当になる。**1E-Cで自動実行を止める（呼ぶのは1E-Bの人間確定時のみ）。**

---

## 4. Phase分割は妥当か（課題文§4への回答）

**A〜Dの4分割は妥当。ただし前段に1つ、内部に4段の細分化が必要。**

| Phase | 名称 | flag要件 | 実端末へ出せるか | 依存 |
|---|---|---|---|---|
| **1E-0** | outbox 物件安全化（**新設・必須**） | 不問 | ○ 単独で出せる | なし |
| **1E-A1** | currentPropertyId の永続化と起動時復元 | 不問 | ○ | 1E-0 |
| **1E-A2** | 物件一覧の表示（切替はしない） | 不問 | ○ | 1E-A1 |
| **1E-A3** | 物件切替の実行 | **ON必須** | × TEST-V後 | 1E-A2, 1E-C |
| **1E-A4** | 新規物件の propertyId 採番（`createProperty()` 結線） | **ON必須** | × TEST-V後 | 1E-A3 |
| **1E-C** | StampStore propertyId 接続 | 不問（キー体系のみ） | × TEST-V後 | 1E-A1 |
| **1E-D** | 実機TEST-V | ON | — | 1E-A3/A4/C |
| **1E-B** | 旧データ人間割当 + migration実行 | — | 割当UIのみ○ | **1E-D PASS後** |

### 4.1 なぜ 1E-B を最後にするか

課題文§7が明示している：

> Phase 1Eは「これから保存されるデータを正しく物件分離できる状態」を先に完成させる。
> その後、実端末dry-runを再実行。そこで初めて旧データmigration可否を再判定する。

さらに実務上の理由がある。**1E-A3/A4 が入ると `contamination` の増加が止まる**ので、
その後に取り直した dry-run のほうが**判定材料として正確**になる（混在が増え続ける状態で割当を確定させない）。

### 4.2 なぜ 1E-A3 に flag ON が必須か

flag OFF のまま物件切替を結線すると、キーに propertyId が入らないまま
A物件とB物件が**同一キー空間**を共有する。今より悪化する（現在は少なくとも切替経路が無い）。

⇒ **物件切替UIの公開と `PROPERTY_SCOPE_ENABLED=true` は不可分。同時に出す。**

### 4.3 flag ON のジレンマと、その解き方

| | flag OFF | flag ON |
|---|---|---|
| 旧データ（実端末 cache 274件） | 読める | **読めない**（キーが違う。消えてはいない） |
| 物件分離 | 効かない | 効く |

`dual-read`（新キーが無ければ旧キーを読む）で両立させたくなるが、**採らない**。
課題文§6が「fallbackはデータ混入原因になるため、必要性を証明できないものは追加しない」と定めており、
本件では混入が実際に起きる：旧キーは**どの建物のものか不明**なので、
新キーが無いときに旧キーを読むことは「今開いている物件のものとみなす」＝ D_WEAK による自動割当に等しい。

**解き方（採用案）**

1. 1E-0 / A1 / A2 は flag OFF のまま実端末へ出す（挙動は今と同じ。安全）
2. 1E-A3 / A4 / C は**テスト環境（クリーンなIndexedDB／別オリジン）で flag ON にして TEST-V を通す**
3. 実端末は flag OFF のまま `phase1d_real_device_dryrun.html` を**再実行**（混在の増加が止まった状態で再測定）
4. 1E-B で人間割当 → preview → migration実行（旧キーは残す）
5. **実端末で flag ON**。読み先が新キーへ移り、割当済みデータがそのまま見える
6. 問題が出たら flag OFF へ戻すだけで元に戻る（旧キーを消していないため）

これが「rollback先を消さない」という Phase 1D §8.3 の方針と一致する唯一の順序である。

---

## 5. 各Phaseの変更対象 / 変更禁止対象

### Phase 1E-0（outbox 物件安全化）

**変更対象**

| ファイル | 箇所 | 変更 |
|---|---|---|
| `index.html` | L4433 `storageSet()` / L4471 `storageDelete()` | outbox へ積む `propertyId` を、scope対象外キーでも**必ず現在の `getCurrentPropertyId()` で埋める**（「積んだ時点の物件」を確定させる。Phase 1C の思想の一般化であり、新しい正本ではない） |
| `index.html` | L4386 `flushOutbox()` | 保護条件を一般化：`isPropertyScopedKey()` に依らず、**`propertyId` が有効UUIDでない item は送信しない**（保持。削除もしない） |

**変更禁止**

- outbox の既存itemを1件も書き換えない・削除しない（既存132件は「propertyIdが無い」ままキューに残す）
- `window.storage.set` 側の分岐（`supabase-integration.js:362`）を変えない
- StampStore の保存キー体系（1E-Cの担当）
- `PROPERTY_SCOPE_ENABLED` の既定値

### Phase 1E-A1（currentPropertyId の永続化）

**変更対象**

| ファイル | 変更 |
|---|---|
| `supabase-integration.js` | `INITIAL_PROPERTY_ID` を **`DEMO_PROPERTY_ID` へ改名**し、`currentPropertyId` の初期値を **`null`** にする。`setCurrentPropertyId()` の実装は**変えない**（既存の検証をそのまま使う） |
| `supabase-integration.js` | 起動時に `localStorage['lb_current_property_id']` を1回だけ読み、有効UUIDなら `setCurrentPropertyId()` へ渡す。`setCurrentPropertyId()` 成功時に同キーへ書く（**書く場所を1つに閉じる**） |
| `index.html` | 起動ゲート（L12217）：`currentPropertyId` が null のとき、**必ず利用者に選ばせる**。推測で `DEMO_PROPERTY_ID` へ倒さない |
| `index.html` | L12258 `continueBtn.onclick`：`record.property.propertyId` が有効なら `setCurrentPropertyId()` を**先に**呼んでから `applyCurrentPropertyRecord()`（順序厳守。§10） |

**変更禁止**

- `setCurrentPropertyId()` の検証条件（UUID v4・36文字）を緩めない
- `localStorage` が使えない環境で `DEMO_PROPERTY_ID` へフォールバックしない（起動ゲートで選ばせる）
- `PROPERTY.propertyId` を判断に使わない（表示・監査用の派生値に降格。§7）

### Phase 1E-A2（物件一覧）

**変更対象**: `index.html` の起動ゲート `#propertyStartupGate` を拡張（**新しいダイアログを追加しない**）。
`window.listMyProperties()`（既存・未接続）を初めて結線する。オフライン時は空配列が返るので、
**ローカルの `fireflow-property:<pid>:current` から既知物件名を補う**（読み取りのみ）。

**変更禁止**: `properties` テーブル・RLS・schema.sql の変更。新テーブルの追加。

### Phase 1E-A3（物件切替の実行）

**変更対象**: `index.html` に `switchProperty(nextPropertyId)` を1つ追加（§9のシーケンス）。
`resetAllInMemoryPropertyState()`（L5037・Phase 1Bで用意済み・呼び出し元0）を**初めて呼ぶ**。
`supabase-integration.js` に `resubscribeRealtimeForProperty()` を追加（`installRealtimeSync()` の張り直し + `currentInspectionId = null` + `ensureInspectionSession()` 再実行）。

**変更禁止**

- `resetAllInMemoryPropertyState()` の中身（保存データを削除しないという不変条件を壊さない）
- `storageDelete()` / `stampStore.clearPersisted()` を切替経路から呼ばない
- 切替時に旧物件のキーを1件も削除しない

### Phase 1E-A4（新規物件の採番）

**変更対象**: `createNewProperty()`（L8917）から `window.createProperty()` を呼び、返った `id` を
`setCurrentPropertyId()` へ渡してから PROPERTY を組み立てる。
オフラインで `createProperty()` が失敗した場合は **新規作成を中止する**（ローカルだけでUUIDを発行しない。二重採番の防止）。

**変更禁止**: LB独自の物件ID発行。`crypto.randomUUID()` を index.html 側で呼ぶこと。

### Phase 1E-C（StampStore接続）

**変更対象**

| ファイル | 箇所 | 変更 |
|---|---|---|
| `index.html` | L4567 `currentPropertyScopeKey()` | `normalizePropertyKey(PROPERTY.name)` → `getCurrentPropertyId()` |
| `index.html` | L4601 `reloadStampStoreForCurrentProperty()` | `loadAll({ …, skipLegacyMigration: true })` を渡す（**C-2**。既存の引数で足りる。新しいオプションを作らない） |

**変更禁止**

- **`public/stamp_store/stamp_store.js` は1行も変更しない**（`KEY_PREFIX='stamp:'`、`setPropertyKey()`、`isNewer()`、`toStampDataView()` はそのまま）
- dual-read / dual-write を作らない
- 旧キー（`stamp:<物件名>:*` / `fireflow-stamp:*`）を削除しない
- `normalizePropertyKey()` の実装を変えない（UUIDは空白も `:` も含まないため、そのまま通る）

### Phase 1E-B（旧データ人間割当）

**変更対象**: 新規ページ `public/property_assign.html`（**製品UIに常設しない**。作業用ページ）。
判定は `public/property_scope_migration.js` の既存純粋関数のみを呼ぶ。

**変更禁止**

- 新しい判定ロジック・新しい status 語彙・新しい evidence 語彙を作らない（Phase 1D の語彙を再利用）
- 自動割当（room番号推測・物件名類似・現在物件既定）を1つも作らない
- 旧キーの削除・outboxの削除

---

## 6. propertyId 正本設計

### 6.1 正本の階層（1つだけ）

```
【正本】      Supabase properties.id (uuid v4)          ← 不変。LB独自IDを作らない
   │
【実行時】    currentPropertyId (supabase-integration.js:64)
   │           getCurrentPropertyId() / setCurrentPropertyId() が唯一の窓口（既存）
   │
【端末永続】  localStorage['lb_current_property_id']    ← 新規。この1本だけ
   │
【派生・写し】 PROPERTY.propertyId                      ← 表示・保存レコード内の監査情報。判断に使わない
              保存キーの <pid> 区画                      ← applyPropertyScope() が付ける
              kv_store.property_id 列                   ← window.storage が付ける
```

### 6.2 なぜ localStorage なのか（設計上の必然）

`fireflow-property:current` に現在物件IDを持たせることはできない。
このキーは **property scope の対象**なので、読むには先に propertyId が要る。**循環する。**

IndexedDB に別ストアを作るのは「新しい正本を増やさない」に反し、かつ非同期なので
§1.4 の手順3（storage層の最初の呼び出し）より前に確定できない。

`localStorage` は同期読みで、既存の端末設定（`lb_splash_seen` / `lb_kantan_mode` / `lb_lock_pin` …）と
**同じ扱い・同じ接頭辞**にでき、property scope の対象外という既存の除外方針とも一致する。

⇒ キー名は既存慣例に合わせ **`lb_current_property_id`**。
（Phase 1D 文書が言及した `fireflow-current-property-id` は採らない。`fireflow-` 接頭辞は storage層を通る業務キーの名前空間であり、混同を招くため）

### 6.3 INITIAL_PROPERTY_ID の扱い（結論）

**「既定値」としては廃止する。「デモ物件のID」として残す。**

| | 変更前 | 変更後 |
|---|---|---|
| 名前 | `INITIAL_PROPERTY_ID` | `DEMO_PROPERTY_ID` |
| `currentPropertyId` の初期値 | `INITIAL_PROPERTY_ID` | **`null`** |
| 使われる場所 | 全起動 | 起動ゲート「デモを開く」を**明示的に選んだ時のみ** |

値そのもの（`b6e18eed-f2f3-4674-812d-322732908616`）は変えない。
これにより Phase 1D の `LEGACY_FIXED_PROPERTY_ID` と一致したままで、**旧データへの到達経路が失われない**。
「起動しただけで、無条件にコスモ六甲の区画が現在物件になる」という混在の起点だけが消える。

### 6.4 PROPERTY.propertyId の位置づけ

**削除しない。派生値へ降格する。**

- 書き込み：`persistCurrentProperty()` の直前に `getCurrentPropertyId()` から詰め直す（1箇所）
- 読み取り：**判断に使わない**。唯一の例外は 1E-A1 の「前回の物件を続ける」で
  `record.property.propertyId` を `setCurrentPropertyId()` へ渡す時（＝ Phase 1D の evidence **A_RECORD_PROPERTY_ID**、STRONG根拠）

削除しない理由：Phase 1D の根拠Aはこのフィールドに依存しており、消すと旧レコードの唯一のSTRONG根拠が失われる。

### 6.5 `isValidScopePropertyId()` の重複（index.html:4278）

**残す。** これは二重正本ではなく「同一条件の複製」。
supabase-integration.js が CDNブロック等で読めない環境でも保存を止めないための防御であり、
条件式が完全一致していることをテストで固定すればよい（既存 `phase1c_property_scope_verify.js` の方式）。
新しい正本ではないので §6（複雑化禁止）に抵触しない。

---

## 7. 物件切替シーケンス（1E-A3）

### 7.1 正常系

```
switchProperty(nextId)
 0  前提: isValidPropertyId(nextId) && nextId !== getCurrentPropertyId()
 1  【保存中の完了待ち】in-flight の storageSet を待つ（保存中フラグ）
 2  【未送信の告知】lcGetAll('outbox').length > 0 なら
       「未送信N件は『<現物件名>』へ送信されます」と表示して続行を確認
       ★ブロックしない（オフライン現場で切替を止めると業務が止まる）
       ★1E-0により、これらは元の物件へ確実に送られる
 3  resetAllInMemoryPropertyState()        ← 既存 L5037。保存データは1件も消さない
 4  setCurrentPropertyId(nextId)           ← 既存 L75。唯一の変更経路
 5  localStorage['lb_current_property_id'] = nextId   ← setter内で行う（書く場所を1つに）
 6  stampStore.setPropertyKey(nextId)      ← 既存。memoryを自動でクリアする
 7  resubscribeRealtimeForProperty()       ← 新規。channel張り直し + currentInspectionId=null
                                              + ensureInspectionSession()
 8  record = await loadCurrentPropertyRecord()   ← 新propertyIdでscopeされたキーを読む
 9  if (record) applyCurrentPropertyRecord(record)
    else        （空物件のまま。DEMO値もA物件の値も出さない = 手順3で保証済み）
10  reloadAllForCurrentProperty()          ← 新規（§7.3）
```

### 7.2 手順の順序が重要な理由

| 順序 | 理由 |
|---|---|
| 3 が 4 より前 | `resetAllInMemoryPropertyState()` 中に走る `renderFloors()` 等が、**まだA物件の propertyId で** A物件のキーを読むため。4を先にすると、A物件の描画処理がB物件のキーを読みに行く |
| 5 が 4 の中 | 永続化を setter の内側に閉じ込めることで、「メモリだけ変わって永続化されない」状態を構造的に作れなくする |
| 7 が 8 より前 | Realtime が旧 propertyId のままだと、A物件のkv_store更新でB物件の画面が再描画される |
| 8/9 が 10 より前 | `loadAll()` は FLOORS を対象に走る。FLOORS が旧物件のままだと、A物件の部屋番号でB物件のキーを読む |

### 7.3 `reloadAllForCurrentProperty()`（新規・1関数）

`runMainAppBootSequence()`（L12154）から **`setInterval` / `addEventListener` を除いた再ロード部分**を切り出す。

```
含める : loadAll() / loadSiteSupervisor() / loadScheduleDays() / loadEquipmentList() /
         loadUploadedDocuments() / loadBuildingNotes() / loadBoTables() / loadProgressLog() /
         reloadStampStoreForCurrentProperty() / renderFloors() / renderFilterChips() /
         initScheduleLabels() / updateSyncBadge()
含めない: setInterval(loadAll,1000) / setInterval(checkScheduledReminders,60000) /
         setInterval(sendPresenceHeartbeat,20000) / setupCanvas() /
         maybeShowOnboardingOnFirstLaunch() / addEventListener 各種
```

`runMainAppBootSequence()` は `reloadAllForCurrentProperty()` を**呼ぶ形へ書き換える**（重複コードを作らない）。

### 7.4 誤操作防止

- 切替は起動ゲート／歯車メニューの**物件一覧からのみ**。部屋一覧画面に切替ボタンを置かない
- 切替先の**物件名を確認ダイアログに出す**（「『コスモ城東野江ロイヤルフォルム』へ切り替えます」）
- 未送信がある場合は件数と送信先物件名を明示（§7.1 手順2）
- 点検パネル（`#panel` / `#photoPanel`）が開いている間は切替不可（`loadAll()` の既存ガードと同じ考え方）

### 7.5 オフライン時の物件切替

**許可する。** 理由：現場は電波が悪い。切替を通信必須にすると業務が止まる。

| 項目 | オフライン時の挙動 |
|---|---|
| 物件一覧 | `listMyProperties()` は空を返す → ローカルの既知物件（`fireflow-property:<pid>:current` が存在するpid）を表示 |
| 切替そのもの | ローカルで完結（`setCurrentPropertyId` + localStorage + reload） |
| 新規物件作成（1E-A4） | **不可**。`createProperty()` が失敗したら中止（ローカルUUID発行はしない） |
| Realtime再購読 | 失敗してよい。`ensureInspectionSession()` の既存リトライ（5秒間隔）に任せる |
| 未送信データ | 元の物件へ紐付いたまま残り、オンライン復帰時に**元の物件へ**送られる（1E-0） |

---

## 8. 保存シーケンス（flag ON 後）

```
現場入力
 → storageSet(rawKey, value, shared)
 → applyPropertyScope(rawKey)                        index.html:4297
      ├ scope対象キー → propertyId = getCurrentPropertyId()
      │                  無効なら throw 'PROPERTY_SCOPE_REQUIRED'   ← 推測フォールバック無し
      │                  → key = propertyScopedKey(rawKey, pid)
      └ 対象外キー    → key はそのまま / propertyId は 1E-0 で currentPropertyId を記録
 → lcPut('cache', { key: lcCacheKey(scopedKey, shared), value })     ← 必ず先にローカル
 → window.storage.set(scopedKey, value, shared, propertyId)
      ├ 成功 → lcDelete('outbox', cacheKey) / remote:true
      └ 失敗 → lcPut('outbox', { rawKey: scopedKey, propertyId, alreadyScoped:true })
                scheduleOutboxRetry()
 → return { remote, queued }
```

**変更点は 1E-0 の1行だけ**（対象外キーにも propertyId を記録）。
`throw` する設計（旧物件へのフォールバックを持たない）は Phase 1C のまま維持する。

---

## 9. 復元シーケンス（リロード時・1E-A1後）

```
1  supabase-integration.js
     currentPropertyId = null
     saved = localStorage['lb_current_property_id']
     if (isValidPropertyId(saved)) setCurrentPropertyId(saved)      ← 同期。storage層より前に完了
2  index.html トップレベル
     PROPERTY.propertyId = getCurrentPropertyId()   （null の場合もある。派生値なので可）
3  initPropertyStartupGate()
     if (getCurrentPropertyId() == null)
         → 物件一覧を出して必ず選ばせる（DEMOへ倒さない）
     else
         → record = await loadCurrentPropertyRecord()   ← scope済みキーを読む
4  「前回の物件を続ける」
     if (isValidPropertyId(record.property.propertyId)
         && record.property.propertyId !== getCurrentPropertyId())
             setCurrentPropertyId(record.property.propertyId)   ← evidence A（STRONG）
             ★ そのうえで record を読み直す（scopeが変わるため）
     applyCurrentPropertyRecord(record)
5  bootMainAppOnce() → runMainAppBootSequence() → reloadAllForCurrentProperty()
```

**手順1が同期でなければならない理由**：手順3 の `loadCurrentPropertyRecord()` は `storageGet()` を呼び、
`applyPropertyScope()` が propertyId を要求する。非同期で後から埋めると、**最初の1回だけ propertyId 無しで throw する**。

**手順4の「読み直し」が必要な理由**：`fireflow-property:<pid>:current` は pid ごとに別キー。
`setCurrentPropertyId()` でpidが変わったなら、いま手に持っている record は別pidのキーから読んだものになる。
（通常は一致するが、localStorage とレコードが食い違った場合の唯一の正しい復旧経路）

---

## 10. outbox シーケンス

### 10.1 積むとき（1E-0後）

| キー種別 | rawKey | propertyId | alreadyScoped |
|---|---|---|---|
| scope対象 | scope済みキー | `currentPropertyId` | true |
| scope対象外（stamp等） | 元のキー | **`currentPropertyId`（1E-0で追加）** | true |

### 10.2 送るとき（1E-0後）

```
for item of outbox:
    if (!isValidPropertyId(item.propertyId)) → 送らない・消さない・警告1回のみ   ← 一般化
    → storageSet/Delete(item.rawKey, …, { alreadyScoped:true, propertyId:item.propertyId })
    → window.storage.set(…, propertyId)
         propertyId !== currentPropertyId → kvSetForProperty()（別物件へ正しく書く。既存 Phase 1C）
    → result.remote === true のときだけ lcDelete('outbox', item.key)   ← 既存 dfafb6b の修正を維持
```

### 10.3 既存132件の扱い

| 分類 | 件数 | 1E-0後の扱い |
|---|---|---|
| NEEDS_USER_ASSIGNMENT | 3 | 送らない・消さない（現状維持。1E-Bの割当対象） |
| SKIPPED_NON_PROPERTY_DATA（stamp系） | 129 | **送らない・消さない**（従来は素通しだった）。1E-Bの割当対象 |

**1件も書き換えない。** 「送らない」判定は読み取り時に行うため、既存itemへの書き込みは発生しない。

---

## 11. StampStore 接続設計（1E-C）

### 11.1 Canonical key

```
stamp:<propertyId>:<room>
```

- 領域名 `stamp:` は変えない（`KEY_PREFIX` そのまま）
- 中央の1区画だけが `<物件名>` → `<propertyId>` になる
- `normalizePropertyKey(uuid)` は uuid をそのまま返す（trim済み・空白なし・`:` なし）
- **`stamp_store.js` の変更は0行**。変えるのは `index.html:4568` の1関数のみ

### 11.2 旧キーの扱い（3系統）

| 旧キー | 実端末での状態 | 1E-Cでの扱い | 最終的な扱い |
|---|---|---|---|
| `stamp:コスモ六甲ガーデンフォート:<room>` | 存在 | **読まない・書かない・消さない** | 1E-B の割当対象（物件名は**補助証拠**として人間に提示） |
| `stamp:コスモ城東野江ロイヤルフォルム:<room>` | 存在 | 同上 | 同上 |
| `fireflow-stamp:<room>` | 存在（物件scope無し） | **自動取り込みを停止**（C-2） | 1E-B の割当対象。**物件名の手がかりが1つも無い最難関** |

### 11.3 dual-read / dual-write

**どちらも作らない。**

- dual-read は「新キーが無ければ旧キーを読む」＝「今開いている物件のものとみなす」＝ D_WEAK 自動割当
- dual-write は旧キー側を汚し、1E-B の割当時に「どちらが人間の意図か」を判別不能にする

旧キーは**読まないが消さない**。読むのは 1E-B の割当画面（evidence表示）と migration実行時のみ。

### 11.4 collision

| ケース | 旧設計 | 新設計 |
|---|---|---|
| 物件A・物件Bに同じ部屋番号101 | 物件名が違えば分離。**同名なら衝突** | `stamp:<pidA>:101` / `stamp:<pidB>:101` で構造的に分離 |
| 物件名が未設定（新規作成直後） | `normalizePropertyKey('')` → **`'default'` に全物件が集まる** | propertyId は必ず有るので `'default'` が発生しない |
| 物件名を後から変更 | 過去のstampが旧名キーに取り残される | propertyId は不変なので影響なし |
| 同一物件内の同一部屋の重複書き込み | `isNewer()`（updated_at比較）で解決済み | 変更なし |

### 11.5 A→B→A

- `setPropertyKey()` は key が変わると `records = {}` する（`stamp_store.js:209`）→ **メモリ残留なし（既存実装で担保済み）**
- 保存側は pid ごとに別キー → A へ戻れば `loadAll()` が A のキーから復元
- ローカル優先の `listKeysLocalFirst(prefix)` は `stamp:<pidA>:` で前方一致するので、**オフラインでもA/Bが混ざらない**

### 11.6 outbox との関係

1E-0 により stamp の outbox item も propertyId を持つ。
1E-C 後に積まれたものは `rawKey = 'stamp:<pid>:<room>'` なので、キー自体からも物件が判る（二重に安全）。

---

## 12. 旧データ人間割当設計（1E-B）

### 12.1 原則

> **候補提示（機械）と確定（人間）を分ける。機械は1件も確定しない。**

判定は `public/property_scope_migration.js` の既存純粋関数のみを使う。**新しい判定ロジックを書かない。**

### 12.2 割当単位（グループ化）

課題文の「同じ部屋番号群をまとめられるか / domainを跨いでまとめる条件」への回答：

| 提案するまとめ方 | 既定 | 根拠の強さ | 判断 |
|---|---|---|---|
| 同一 rawKey | — | 完全 | 常に1単位 |
| 同一 room の全domain（`binder:807` + `schedule-override:807`） | **提案するが既定はOFF** | **D_WEAK**（同じ部屋番号でも別建物のものが混在し得る。それが今回の contamination そのもの） | 人間が明示的にチェックしたときのみ有効 |
| domain 全体を一括（binder全件など） | 提案しない | E_UNKNOWN | 不可 |
| 一覧に対する「全部Aへ」ボタン | **作らない** | — | 誤操作の被害が最大。作らない |

⇒ **既定は1件ずつ。UIが「同じ部屋番号の他domainもまとめますか？」と提案するが、既定チェックは外しておく。**
実端末の UNKNOWN_PROPERTY は 15件なので、1件ずつでも現実的な量である。

### 12.3 選択肢（4つ・既定は「保留」）

| 選択肢 | 意味 | 実行時の動作 |
|---|---|---|
| 物件Aへ割当 | 人間が根拠を持って確定 | 新キーへ**複写**（旧キーは残す） |
| 物件Bへ割当 | 同上 | 同上 |
| **保留（既定）** | まだ決められない | 何もしない。次回also表示される |
| 移行しない | この端末では使わないと判断 | 何もしない。以後の一覧から非表示（**削除ではない**） |

### 12.4 evidence（表示するもの／しないもの）

**表示する**

| 種別 | 内容 | 強さ |
|---|---|---|
| キー情報 | rawKey / domain / room / shared / updatedAt | 事実 |
| MASTER 照合 | 各物件の FLOORS にその部屋番号が在るか（○/×） | C_MEMBERSHIP。**複数物件に在る場合は「決め手にならない」と赤字で明示** |
| 値の要約 | 点検者名・点検時刻・写真枚数・記号 | 参考 |
| **StampStore 補助証拠** | 同じ部屋番号が `stamp:<物件名>:<room>` に在るか、その物件名は何か | **参考（表示のみ）** |
| Phase 1D 判定 | status / evidence / collision分類 | 事実 |

**表示しない**：写真そのもの、署名画像（画面共有時の情報漏れ防止。件数のみ）

**課題文の問い「物件名scope済StampStoreを補助証拠として使えるか」への回答**

> **YES（人間への提示材料としてのみ）。NO（自動確定の根拠としては使わない）。**
>
> 理由：`stamp:コスモ六甲ガーデンフォート:807` があることは、
> 「807という部屋番号でコスモ六甲の予定情報を入れた」ことの証拠であって、
> 「`fireflow-binder:807` がコスモ六甲のものである」ことの証拠ではない。
> 両物件に807が在れば決め手にならない。**人間が「807はコスモ六甲にしかない」と知っている場合にだけ有効**であり、
> それは機械には検証できない。したがって表示に留める。

### 12.5 preview（実行前）

確定した割当を `planPropertyScopeMigration()` へ**入力として渡し直し**、再計算した結果を表示する。

```
表示: 複写されるキー一覧（旧キー → 新キー）
      COLLISION 件数
      ALREADY_MIGRATED 件数
      対象外のまま残る件数
実行可否: COLLISION === 0 のときだけ「実行」ボタンを有効化
```

### 12.6 実行と rollback

**実行**
```
1  copy: 新キーへ書く（旧キーは消さない）
2  read-back: 書いた値を読み直し、sourceHash と完全一致することを確認
3  不一致なら即中断（そこまでの複写は rollback 可能な形で監査ログに残る）
4  buildAuditRecord() を保存（createdByMigration = (targetExisted === false)）
```

**rollback**（Phase 1D §8.1 の `canRollback()` をそのまま使う）
```
false を返す条件（＝消さない）:
  ・createdByMigration !== true      … 元から在った scoped データは絶対に消さない
  ・移行先が既に無い
  ・現在値のハッシュ ≠ 複写時のハッシュ … 複写後に現場入力があったものは消さない
```

**誤割当の取消**
- 確定前：いつでも変更可（保留へ戻せる）
- 実行後：`canRollback()` が true のものだけ新キー側を削除 → 割当をやり直せる
- **最終防衛線**：旧キーを1件も削除しないので、最悪でも元の状態へ戻せる

---

## 13. collision 対策（全種類）

| # | 種類 | 発生条件 | 対策 | 自動解決するか |
|---|---|---|---|---|
| 1 | キー衝突（同一物件・異なる値） | migration で TARGET_EXISTS_DIFFERENT | COLLISION として停止。人間が選ぶ | **しない**（自動上書き禁止） |
| 2 | 部屋番号衝突（A物件101 / B物件101） | 常時 | propertyId scope で構造的に分離 | する |
| 3 | 物件名衝突（StampStore） | 同名物件・名前未設定 | propertyId 化（1E-C）で消滅 | する |
| 4 | `'default'` スコープへの集約 | `PROPERTY.name` が空 | propertyId は必ず有効なので発生しない | する |
| 5 | kv_store 行の二重化 | migration が新keyでinsertし旧key行が残る | **§14.4 の決定により回避** | する |
| 6 | outbox の物件誤配 | propertyId 無しitemの flush | 1E-0 で送信停止 | する |
| 7 | Realtime の物件誤配 | 切替後もチャンネルが旧pid | `resubscribeRealtimeForProperty()` | する |
| 8 | inspection セッションの物件誤配 | 切替後も `currentInspectionId` が旧物件 | 切替時に null → 再取得 | する |
| 9 | localStorage とレコードの食い違い | 手動編集・別タブ | レコード側（evidence A）を優先し読み直す（§9 手順4） | する |

---

## 14. rollback 設計

### 14.1 Phase単位

| Phase | rollback方法 | 失うもの |
|---|---|---|
| 1E-0 | `flushOutbox()` の条件式を revert | なし（送っていなかったデータが送られるようになるだけ） |
| 1E-A1 | `lb_current_property_id` を削除 + 定数を戻す | なし |
| 1E-A2 | UI追加のみ。revert | なし |
| 1E-A3/A4 + flag ON | **`PROPERTY_SCOPE_ENABLED = false` へ戻す** | flag ON中に入力したデータが**見えなくなる**（消えてはいない。scopedキーに在る） |
| 1E-C | `currentPropertyScopeKey()` を revert | 同上（stampが `stamp:<pid>:*` に在る） |
| 1E-B | `canRollback()` に基づく新キー削除 | なし（旧キーが残っている） |

### 14.2 flag OFF へ戻せる理由

**旧キーを1件も削除しないから。** これが Phase 1D §8.3 で「旧キーの即時削除を採らない」と決めた本当の理由であり、
Phase 1E でも同じ方針を維持する。

### 14.3 旧キーの削除時期

**Phase 1E では削除しない。** 最低1点検サイクル、flag ON での実運用が確認できてから、別タスクで判断する。

### 14.4 kv_store 旧key行の扱い（Phase 1D §6 の未解決事項への回答）

**決定案：migration の対象を IndexedDB cache のみに限定する。kv_store へは書かない。**

根拠と条件：

1. 前回のユーザー実測で **`kv_store rows = 0`**。リモートには移行すべきデータがそもそも無い
2. cache のみを対象にすれば、「新keyでinsert → 旧key行が残る → 行数が最大2倍」という問題自体が発生しない
3. 移行後のデータは、次に現場入力があった時点で `storageSet()` が新キーで kv_store へ上げる（自然に整合する）
4. それまでの読み取りは `storageGet()` の IndexedDB フォールバックで成立する

**実行前GATE**：migration 実行の直前に `kv_store rows = 0` を再確認する。
0でない場合、この決定は無効になり、旧key行の扱いを改めて決める必要がある。

---

## 15. TEST-V（実機検証項目）

### 15.1 前提

- **クリーンな状態で行う**（実端末の混在データの上ではやらない）
- 物件A・物件Bは実在の別建物として作成し、**同じ部屋番号を意図的に含める**
- `PROPERTY_SCOPE_ENABLED = true`

### 15.2 基本シナリオ

| # | 操作 | 期待 |
|---|---|---|
| V-1 | 物件Aを開く → 入力 → reload | Aの入力が維持される |
| V-2 | 物件Bへ切替 | **Aのデータ 0件**（部屋一覧・予定・設備・消火器・資料すべて） |
| V-3 | Bへ入力 → reload | **Bのみ維持**。Aの値が1つも出ない |
| V-4 | 物件Aへ戻る | **Aの入力が復元**。**Bのデータ 0件** |
| V-5 | A→B→A→B を4往復 | 毎回 V-2〜V-4 と同じ結果 |

### 15.3 対象データ（全13種 × V-1〜V-4）

binder / A・P（記号）/ 点検済み / 不在 / キャンセル / 点検時刻 / 不在時刻 /
schedule override / equipment / ext（消火器）/ documents / presence / scheduleDays / StampStore

### 15.4 オフライン（Wi-Fi OFF/ON）

| # | 操作 | 期待 |
|---|---|---|
| V-6 | Wi-Fi OFF → Aで入力 → reload | Aの入力が維持される（IndexedDBのみで成立） |
| V-7 | Wi-Fi OFF → Aで入力 → **Bへ切替** → Wi-Fi ON | **未送信データがAへ送られる。Bには1件も入らない**（★1E-0の核心検証） |
| V-8 | Wi-Fi OFF → Bへ切替 → Bで入力 → Wi-Fi ON | Bのデータが**Bへ**送られる |
| V-9 | Wi-Fi OFF で新規物件作成 | **作成できない旨を表示**（ローカルUUIDを発行しない） |

### 15.5 境界・異常系

| # | 操作 | 期待 |
|---|---|---|
| V-10 | 同一部屋番号（例:101）がA・B両方に在る状態でV-1〜V-4 | 完全分離 |
| V-11 | **物件名が同一**の2物件 | 完全分離（propertyIdが違うため） |
| V-12 | 物件名未設定（空）の新規物件 | `'default'` へ集約されない |
| V-13 | localStorage をクリア → reload | 起動ゲートで**必ず物件を選ばされる**。デモへ自動で倒れない |
| V-14 | 保存中（未送信あり）に切替 | 件数と送信先物件名が表示される。切替はブロックされない |
| V-15 | 点検パネルを開いたまま切替を試みる | 切替不可（パネルを閉じるよう案内） |
| V-16 | 別タブでBを開き、Aのタブで入力 | Aのタブの入力がBへ入らない（Realtime購読が物件別） |
| V-17 | `fireflow-stamp:*` が在る端末でBを開く | **Bへ自動取り込みされない**（★C-2の核心検証） |
| V-18 | Excel（別建物）を読み込む | propertyId が変わる or 「別物件として作成しますか」と確認される（★FIRST_BREAKの検証） |

### 15.6 自動テストで固定すべき項目（実装時）

- `setCurrentPropertyId()` の呼び出し箇所が、**永続化を伴う1経路に限定**されていること
- `INITIAL_PROPERTY_ID` が `currentPropertyId` の初期値として使われていないこと
- `stamp_store.js` の差分が0であること
- `migrateLegacyKeys()` が `loadAll()` の自動経路から呼ばれないこと
- `flushOutbox()` が propertyId 無しitemを送らないこと
- dual-read / dual-write のコードが存在しないこと
- 切替経路から `storageDelete` / `clearPersisted` が呼ばれないこと

---

## 16. 実LB確認項目（ユーザー操作が必要なもの）

| # | 内容 | 誰が | いつ |
|---|---|---|---|
| L-1 | 実端末 dry-run の**再実行**（`phase1d_real_device_dryrun.html`） | ユーザー | 1E-A3/A4/C の実装後・1E-B の設計確定前 |
| L-2 | `kv_store rows` の再確認（Supabase管理画面） | ユーザー | migration実行前GATE（§14.4） |
| L-3 | 物件Bの実データ（Excel）の用意 | ユーザー | TEST-V 実施前 |
| L-4 | TEST-V の実施（§15） | ユーザー | 1E-D |
| L-5 | 旧データ割当の確定（15件 + outbox 3件 + StampStore 259件） | ユーザー | 1E-B |

---

## 17. migration 再開条件（Phase 1D への引き渡し）

Phase 1D の本migrationを再開してよいのは、次の**すべて**を満たしたときのみ。

| # | 条件 | 現状 |
|---|---|---|
| G-1 | 1E-0 / 1E-A / 1E-C が実装され、TEST-V（§15）が全項目PASS | 未着手 |
| G-2 | 実端末 dry-run を**再実行**し、混在の増加が止まったことを確認 | 未実施 |
| G-3 | `kv_store rows = 0` の再確認（§14.4） | 前回0。再確認未実施 |
| G-4 | 1E-B の割当UIで、UNKNOWN_PROPERTY 15件 + outbox 3件 + StampStore 259件について**人間が確定** | 未実施 |
| G-5 | preview の COLLISION が 0件 | 未実施 |
| G-6 | 旧キー削除は行わない方針の再確認 | 確認済み（§14.3） |

**G-1〜G-5 が未充足のため、本migrationは引き続き STOP。**

---

## 18. リスク

| # | リスク | 影響 | 対策 | 残余 |
|---|---|---|---|---|
| R-1 | **outbox 129件がB物件へ流入** | 別建物のデータ混入（不可逆に近い） | 1E-0を1E-Aより先に実施（**C-1**） | 低 |
| R-2 | **`migrateLegacyKeys()` が旧stampを新物件へ自動取り込み** | 同上 | 1E-Cで自動実行停止（**C-2**） | 低 |
| R-3 | **flag ON で旧データが画面から消える** | 現場が「データが消えた」と判断し混乱 | 1E-B完了後にON（**C-3**）。事前にユーザーへ説明 | 中（説明が必要） |
| R-4 | `resetAllInMemoryPropertyState()` が未使用コード（実行実績0） | 初使用時に想定外の残留 | TEST-V V-2/V-4 で13種すべてを検証 | 中 |
| R-5 | Realtime / inspection セッションが切替に追随しない | 他端末の更新が別物件の画面に出る | `resubscribeRealtimeForProperty()`。V-16で検証 | 低 |
| R-6 | localStorage が使えない環境（Safariプライベート等） | 現在物件が復元できない | 起動ゲートで必ず選ばせる。デモへ倒さない。V-13で検証 | 低 |
| R-7 | StampStore 259件の物件名→propertyId 対応が**人間にも分からない** | 割当できず保留のまま残る | 保留を正常な結果として扱う（移行率100%を目標にしない） | 中（受容） |
| R-8 | `fireflow-stamp:<room>` は物件の手がかりが1つも無い | 同上 | 同上。**推測で割り当てない** | 中（受容） |
| R-9 | 二重正本（`PROPERTY.propertyId` と `currentPropertyId`） | 判断が食い違う | `PROPERTY.propertyId` を派生値へ降格。読むのは§9手順4のみ | 低 |
| R-10 | Excel読込（P3）が propertyId を変えないまま残る | FIRST_BREAK が再発 | 1E-A4 で「別物件として作成しますか」の確認を挟む。V-18で検証 | 中（**設計必須項目**） |
| R-11 | 1E-A3 と flag ON が同時リリースになり、変更量が大きい | rollback判断が難しくなる | flag 1つで丸ごと戻せる形を維持（§14.1） | 低 |

---

## 19. 既存構造で再利用するもの / 新規追加 / 削除・統合候補

### 19.1 そのまま再利用（変更なし）

| 対象 | 場所 |
|---|---|
| `setCurrentPropertyId()` / `getCurrentPropertyId()` / `isValidPropertyId()` | `supabase-integration.js:75/81/69` |
| `window.createProperty()` / `window.listMyProperties()` | `supabase-integration.js:597/623` （**既に存在。UI未接続なだけ**） |
| `storageSet/Get/Delete/List` | `index.html:4433/4455/4471/4490` |
| `applyPropertyScope()` / `propertyScopedKey()` / `propertyUnscopedKey()` / `isPropertyScopedKey()` | `index.html:4297/4258/4266/4247` |
| `resetAllInMemoryPropertyState()` | `index.html:5037`（Phase 1Bで用意済み・**初めて呼ぶ**） |
| `applyCurrentPropertyRecord()` / `blankPropertyRecord()` / `persistCurrentProperty()` | `index.html:4892/4871/4851` |
| `stamp_store.js` 全体 | **1行も変えない** |
| `property_scope_migration.js` の純粋関数群 | 1E-B の判定に再利用 |
| `properties` / `property_members` テーブルと RLS | `schema.sql:59/70` **schema変更 0** |

### 19.2 新規追加（最小限・6つ）

| # | 追加物 | 場所 | 理由 |
|---|---|---|---|
| N-1 | `lb_current_property_id`（localStorage 1キー） | `supabase-integration.js` | 現在物件の永続化。§6.2 |
| N-2 | `switchProperty(nextPropertyId)` | `index.html` | 切替の唯一の入口。§7 |
| N-3 | `reloadAllForCurrentProperty()` | `index.html` | `runMainAppBootSequence()` からの切り出し（**重複コードを作らない**）。§7.3 |
| N-4 | `resubscribeRealtimeForProperty()` | `supabase-integration.js` | Realtime + inspection セッションの張り直し |
| N-5 | 物件一覧UI | `index.html` の `#propertyStartupGate` **拡張**（新ダイアログを作らない） | 1E-A2 |
| N-6 | `public/property_assign.html` | 新規ファイル | 1E-B 作業用。**製品UIに常設しない** |

**新しい層・adapter・override・正本は0。fallbackは0。**

### 19.3 削除・統合候補

| 対象 | 場所 | 判断 |
|---|---|---|
| `INITIAL_PROPERTY_ID` を既定値として使うこと | `supabase-integration.js:26/64` | **廃止** → `DEMO_PROPERTY_ID`（デモ選択時のみ）。値自体は変えない |
| `migrateLegacyKeys()` の自動実行 | `stamp_store.js:312` の呼び出し側 | **停止**（`skipLegacyMigration:true`）。関数自体は1E-Bで使うので残す |
| `currentPropertyScopeKey()` の `PROPERTY.name` 依存 | `index.html:4568` | **`getCurrentPropertyId()` へ統合** |
| `normalizePropertyKey()` の `'default'` フォールバック | `stamp_store.js:51` | **残す**（`stamp_store.js` を変えない方針）。propertyId が必ず有効なので到達しなくなる。到達したらテストで落とす |
| `isValidScopePropertyId()` の重複定義 | `index.html:4278` | **残す**（二重正本ではなく同一条件の複製。§6.5） |
| `PROPERTY.propertyId` | `index.html:4034` ほか | **残すが派生値へ降格**（§6.4） |
| 起動ゲートのコメント「多物件対応は今回のスコープ外」 | `index.html:12196-12201` | 1E-A3 完了時に更新（既知の制約の記述が事実と食い違うため） |

---

## 20. 実装順序（この順に、1段ずつ実LB確認を挟む）

```
STEP 1  Phase 1E-0   outbox 物件安全化
        変更: index.html の storageSet/storageDelete/flushOutbox（3箇所・条件式レベル）
        flag: 不問（OFFのままでよい）
        検証: 単体テスト（propertyId無しは送らない／既存itemを書き換えない）
        実端末: 出してよい（挙動は今と同じ＝stamp系が送られなくなるだけ）
        ★ここを飛ばして STEP 3 へ進むことを禁止する

STEP 2  Phase 1E-A1  currentPropertyId の永続化・起動時復元
        変更: supabase-integration.js（初期値 null / localStorage / DEMO_PROPERTY_ID 改名）
              index.html の起動ゲート（null時は必ず選ばせる／続けるでsetCurrentPropertyId）
        flag: 不問
        実端末: 出してよい（物件は1つのままなので挙動は実質不変）

STEP 3  Phase 1E-A2  物件一覧の表示（切替はまだしない）
        変更: index.html の #propertyStartupGate 拡張、listMyProperties() 結線
        flag: 不問
        実端末: 出してよい

STEP 4  Phase 1E-C   StampStore propertyId 接続
        変更: index.html:4568（1関数）+ 4601（skipLegacyMigration）
        flag: 不問（stampキーは元々scope対象外）
        実端末: ★出さない（TEST-V後）

STEP 5  Phase 1E-A3  物件切替の実行
        変更: switchProperty() / reloadAllForCurrentProperty() / resubscribeRealtimeForProperty()
        flag: ON 必須
        実端末: ★出さない

STEP 6  Phase 1E-A4  新規物件の propertyId 採番
        変更: createNewProperty() → createProperty() 結線
              parseExcelAndRebuild() に「別物件として作成しますか」の確認（R-10）
        flag: ON 必須
        実端末: ★出さない

STEP 7  Phase 1E-D   TEST-V（§15 全項目）
        環境: クリーンなIndexedDB / 実建物2件 / Wi-Fi OFF-ON を含む
        ★ここがPASSするまで実端末へ何も出さない

STEP 8  実端末 dry-run 再実行（L-1）+ kv_store rows 再確認（L-2）
        → 混在の増加が止まったことを確認して初めて 1E-B の対象を確定する

STEP 9  Phase 1E-B   旧データ人間割当
        割当UI → 人間確定 → preview（COLLISION 0） → migration実行（cacheのみ・旧キー残す）

STEP 10 実端末で PROPERTY_SCOPE_ENABLED = true
        問題が出たら flag を false へ戻すだけで元に戻る
```

### 20.1 次に実装すべき最小Phase

> **STEP 1（Phase 1E-0：outbox 物件安全化）**

- 変更は `index.html` の3箇所・条件式レベル。差分が小さく、単独でrollbackできる
- **物件切替を結線する前に必ず塞がなければならない唯一の穴**（§3.4）
- flag OFF のまま実端末へ出せる（現状の挙動を悪化させない）
- 完了条件：
  1. `flushOutbox()` が propertyId 無しitemを送らない（テストで固定）
  2. outbox の既存132件を1件も書き換えない・削除しない（テストで固定）
  3. `npm run test:release` / `test:unit` / `typecheck` / `build` すべてPASS

---

## 21. 今回の変更ファイル

| ファイル | 内容 |
|---|---|
| `docs/FireFlow_Phase1E_最終設計_2026-08-18.md` | 本書（新規） |

**製品コード（`public/index.html` / `public/supabase-integration.js` / `public/stamp_store/stamp_store.js` /
`public/property_scope_migration.js` / `supabase/schema.sql`）は差分 0。**
IndexedDB・outbox・StampStore・Supabase の変更も 0件。migration 未実行。

---

## 22. 判定（再掲）

**PHASE1E_DESIGN_CONDITIONAL_GO**

条件 C-1（1E-0を先に）/ C-2（`migrateLegacyKeys()` 自動実行の停止）/ C-3（flag ONは1E-B後）を
実装計画に組み込むことを必須とする。3条件は本書 §4 / §5 / §20 に反映済み。

**GOであっても実装は開始しない。**
