# FireFlow / Live Board — request storm 実ブラウザ再発 原因監査

作成日: 2026-08-22（無人実行 / **監査のみ・製品コード変更0**）
基準commit: `d763189 fix: hold outbox items without resolved property id`（= `origin/main` の先端）
判定: **REQUEST_STORM_ROOT_CAUSE_PARTIAL**

Phase 1E-A1 は停止継続。修正・test変更・package.json変更・Supabase変更・migration・
git add / commit / push は一切行っていない。

---

## 1. 実ブラウザ事実（最優先。自動テストより優先する）

- 2026-08-22、実Safari の Network で確認。
- Network履歴を削除し、**何も操作せず約5秒**待った。
- `kv_store` へのリクエストが **10件を大幅に超えて連続発生**した。

→ 確定事実は「**実ブラウザでは request storm が直っていない**」。

### 重要な前提の訂正

`docs/FireFlow_RequestStorm_Fix_2026-08-19.md` が到達目標としている「2 GET/秒」は、
**5秒で10件**という意味である。つまり「5秒で10件強」は修正後の設計値と同じ桁で、
「5秒で数十〜数百件」であれば別の発火源が確実に居る。**どちらであるかは、URLを1件見れば確定する**（第12節）。

---

## 2. kv_store 発火元 全数棚卸し

`public/` 配下で `kv_store` に到達しうる経路は、**すべて `window.storage.{get,set,delete,list,listValues}` の5本のみ**
（`public/supabase-integration.js:421 installStorageShim`）。他に `kv_store` を直接叩くコードは無い。
アプリ側はさらに `storageGet / storageSet / storageDelete / storageList / storageListValues`
（`public/index.html:4453〜4583`）を必ず経由する。

| # | 発火元 | 呼び出し元 | 1回あたりの remote 通信 | 定期実行 |
|---|---|---|---|---|
| 1 | `loadAllInner()` の `readRoomValuesBulk` ×2 | `setInterval(loadAll,1000)` / 起動時 | **2 GET**（部屋数非依存） | **1秒** |
| 2 | `stampStore.loadAll()` の per-key `adapters.get` | `reloadStampStoreForCurrentProperty()` | **list 1 + 保存件数ぶんの GET（直列）** | 無（起動・物件切替・一覧表示時） |
| 3 | `stampStore.migrateLegacyKeys()` | 同上（`restored.length===0` のときだけ） | list 1 + 件数ぶんの GET + 件数×2 の書込 | 無 |
| 4 | `flushOutbox()` | `setInterval(flushOutbox,5000)` / online / visibilitychange / supabase-ready | **送信可能item数 × 2**（select id + update/insert） | **5秒**（起動条件あり） |
| 5 | `sendPresenceHeartbeat()` | `setInterval(...,20000)` / inspectorName change | **2**（select id + update/insert） | 20秒 |
| 6 | `loadActiveInspectors()` | `renderActiveInspectors()` ← `updateStats()`（**進捗詳細パネルが開いている間だけ**）/ `openProgressDetail()` | list 1 + 点検員数ぶんの GET | 進捗詳細パネルを開いている間、`renderFloors()` のたび |
| 7 | `persist()` (`index.html:8208`) | 部屋の保存操作 | GET 1 + 書込 2 | 無（利用者操作時） |
| 8 | `loadCurrentPropertyRecord()` | 起動ゲート | 1 GET | 無 |
| 9 | `loadSiteSupervisor / loadScheduleDays / loadEquipmentList / loadUploadedDocuments` | 起動時1回ずつ | 各 1 GET | 無 |
| 10 | `loadBuildingNotes / BOテーブル / PROGRESS_LOG / equipKeyFor / extKeyFor` | 各画面の表示・保存 | 各 1〜3 | 無 |
| 11 | `persistCurrentProperty()` | 物件確定時 | 2 | 無 |

**`Realtime` は kv_store REST を一切発生させない。**
`installRealtimeSync()`（`supabase-integration.js:499`）は WebSocket 購読で、`sb-realtime-update` を
dispatch し `window.onRealtimeUpdate()` を呼ぶが、**`public/index.html` に受信側は1つも存在しない**
（`onRealtimeUpdate` / `sb-realtime-update` / `__sbChannel` の grep 一致 **0件**）。
→ Realtime起因の再取得ループは構造的に有り得ない。

`documents` テーブルは存在しない（`UPLOADED_DOCUMENTS_KEY` は kv_store の1キーで、起動時1回のみ）。
`presence` は #5/#6 のとおり。

---

## 3. setInterval 全数（`public/index.html` + `public/supabase-integration.js`）

`grep -n "setInterval(" public/index.html public/supabase-integration.js` の全一致 = **5件**。
再帰 `setTimeout` によるポーリングは **0件**（`setTimeout` は18件すべて単発のUIタイマー）。

| # | 位置 | 周期 | callback | 1tick の remote request | kv_store | 同時実行 |
|---|---|---|---|---|---|---|
| 1 | `index.html:12310` | 1000ms | `loadAll` | **2 GET** | **する** | **不可**（`loadAllInFlight` ガード有り） |
| 2 | `index.html:12312` | 60000ms | `checkScheduledReminders` | 0 | しない | — |
| 3 | `index.html:12318` | 20000ms | `sendPresenceHeartbeat` | 2（select id + update/insert） | **する** | 可（ガード無し。ただし20秒周期で実害小） |
| 4 | `index.html:4360` | 5000ms | `flushOutbox` | **送信可能item数 × 2**。全件hold・0件なら0 | **する** | **可（ガード無し＝重なる）** |
| 5 | `supabase-integration.js:337` | 5000ms | `ensureInspectionSession` | 通常0（`if (currentInspectionId) return`）。失敗中のみ `inspections` へ1〜2 | **しない**（inspectionsテーブル） | 不可（`if (!inspectionSessionRetryTimer)`） |

**#4 だけが「ガード無し × 短周期 × 件数比例」の3条件を満たす**。
これは修正済みの `loadAll` と**構造的に同じ悪循環**（1passが5秒を超えると次tickが重なり、
重なるほど遅くなってさらに重なる）であり、**今回の修正対象から漏れている**。

---

## 4. loadAll 経路（修正版が本当に実行されるか）

すべて実コードで確認済み。

| 確認項目 | 結果 |
|---|---|
| `function loadAll(` の定義数 | **1件**（`index.html:8269`） |
| `function loadAllInner(` の定義数 | **1件**（`index.html:8282`） |
| `loadAll = ...` による再代入 | **0件**（`index.html` / `supabase-integration.js` とも） |
| 旧関数での上書き | **無し** |
| `setInterval` が旧関数参照を保持 | **無し**（`setInterval(loadAll,1000)` は唯一の定義を指す） |
| `storageListValues` / `readValueFromLocalCache` / `readRoomValuesBulk` | 各1件のみ存在 |
| `window.storage.listValues` | `supabase-integration.js:484` に1件 |
| 別経路での部屋ごと `storageGet` | `loadAllInner` からは **0**。`persist()`(8208) は利用者操作時のみ |
| dev server の配信物 | `curl http://localhost:3000/` に `loadAllInFlight` 4件 / `readRoomValuesBulk` 3件、`/supabase-integration.js` に `listValues` 1件 → **配信物に入っている** |

`loadAllInner()` の remote 通信は `readRoomValuesBulk` × 2 = **2 GET / tick、部屋数非依存**。
`byKey` に無いキーは `readValueFromLocalCache`（IndexedDB）で埋め、**追加の remote GET は出さない**。

### ただし決定的な事実

```
git rev-parse HEAD      = d763189a4794b4107a6d896b095a08673da27592
git rev-parse origin/main = d763189a4794b4107a6d896b095a08673da27592
git show HEAD:public/index.html | grep -c loadAllInFlight  → 0
git show HEAD:public/supabase-integration.js | grep -c listValues → 0
```

**request storm 修正は未コミット（working tree のみ）である。**
`origin/main` = デプロイ元 = `d763189` には `loadAllInFlight` も `readRoomValuesBulk` も
`listValues` も **1文字も入っていない**。

`app/route.ts` はビルド時に `public/index.html` を `readFileSync` して `/` で返す。
したがって、

> **Vercel本番URLで開いた Live Board は、100%の確実性で修正前のコード（部屋数×2 = 129室なら258 GET/秒）である。**

localhost:3000 で開いた場合のみ修正版が動く。ローカルとVercelはオリジンが違うので
IndexedDB も別、見分けはURLだけ。

---

## 5. StampStore 経路（実端末に259件）

`public/index.html:4671` の adapter 定義：

```js
var stampStore = window.FireFlowStampStore.createStampStore({
  adapters: {
    list: function (prefix) { return listKeysLocalFirst(prefix); },
    get:  function (key) { return storageGet(key, true)... },   // ← 1キー = 1 remote GET
    set:  function (key, value) { return storageSet(key, value, true); },  // ← 1キー = 2 remote request
    remove: ...
  }
});
```

`public/stamp_store/stamp_store.js:294` の `loadAll()` は

```js
return Promise.resolve(adapters.list(prefix)).then(function (keys) {
  return keys.reduce(function (chain, key) {           // ← 直列。並列でもバルクでもない
    return chain.then(function () { ... return readRecord(key)... });
  }, Promise.resolve());
})
```

- キー一覧は `listKeysLocalFirst()`（`index.html:4652`）= **IndexedDBキャッシュ ∪ remote list**。
  リモートに無くローカルにだけ在るキーも対象に入り、それでも `adapters.get` で **remote GET を1回投げる**
  （`window.storage.get` が「行なし」で throw → `storageGet` が IndexedDB へフォールバック）。
- `known`（現FLOORSの部屋）に無い部屋は GET 前にスキップされる。
  → **実GET数 ≒ min(保存件数, 現物件の部屋数)**。129室物件なら最大129回。
- **すべて直列**。1件50msなら約6.5秒、100msなら約13秒、**その間 kv_store GET が連続で並ぶ**。
- 再入ガード **無し**（`reloadStampStoreForCurrentProperty` にも `loadAll` にも）。

### 発火経路（polling には乗っていない＝毎秒の加算は0。ただし「起動直後の連続バースト」を作る）

| 呼び出し元 | 契機 |
|---|---|
| `applyCurrentPropertyRecord()` (`index.html:5054`) → `restoreStampDataFromStorage()` → `reloadStampStoreForCurrentProperty()` | 起動ゲートの「**前回の物件を続ける**」 |
| `loadStampScannedList()` (`index.html:10115`) | 点検希望時間連絡票パネルを開いたとき |
| Excel/報告書の読み込み (`index.html:10116`) | 物件差し替え |

**重要**: `applyCurrentPropertyRecord()` は `restoreStampDataFromStorage()` を **await しない**。
呼び出し元 `continueBtn.onclick` は直後に `bootMainAppOnce()` を実行する。
→ **StampStore の直列GETチェーンと、1秒ごとの `loadAll` polling が同時に走る。**

### 1秒あたりの発生量

直列チェーンなので **「1秒 ÷ 1往復のRTT」件/秒**。
社内Wi-Fi（RTT 40ms前後）なら **20〜25 GET/秒**、5秒で **100件以上**。
「何も操作せず5秒で10件を大幅に超える」という観測と**完全に一致する**。

### 修正対象から漏れているか

**漏れている。** `FireFlow_RequestStorm_Fix_2026-08-19.md` 4節は
「`restoreStampDataFromStorage()` は起動時・物件切替時のみで、request storm への**毎秒の加算は0**」
と書いたが、これは「**1秒pollingに加算しない**」を証明しただけで、
「**起動直後に数十秒の連続バーストを出さない**」は一切証明していない。
利用者から見た Network タブでは両者は区別できない。

### 追加リスク: legacy migration

`restored.length === 0` の場合（`PROPERTY.name` が変わって `normalizePropertyKey()` の
スコープキーがずれた場合など）、`migrateLegacyKeys()` が
`fireflow-stamp:` を list → 部屋ごとに GET → **さらに `adapters.set`（select id + insert/update = 2通信）**
を直列で走らせる。129室なら **129 GET + 258 書込 = 387 request** の連続バースト。
書込が失敗し続けると **毎回の起動でこれが繰り返される**。

---

## 6. outbox 経路（実端末に旧outbox大量）

`public/index.html:4358-4441`

| 項目 | 事実 |
|---|---|
| 周期 | **5000ms**（`scheduleOutboxRetry()`）。他に `online` / `visibilitychange(visible)` / `supabase-ready` からも呼ばれる |
| タイマー起動条件 | `storageSet` / `storageDelete` が remote 失敗した瞬間だけ |
| タイマー停止条件 | `lcGetAll('outbox')` が **0件**のときだけ |
| **1tick の request 数** | **送信可能item数 × 2**（`storageSet` = `select id` + `update` or `insert`） |
| propertyId無し旧item | `item.propertyId` が null/undefined/'' → `heldCount++; continue;` → **remote 通信0**。送信停止は効いている（`index.html:4400-4408`） |
| 不正propertyId | 同上（`isValidScopePropertyId`）→ 通信0 |
| stamp系item | **rawKeyでは判定していない**。`item.propertyId` があれば stamp系も普通に送信される（storm源になり得る） |
| **再入ガード** | **無い**（`loadAll` のような `inFlight` フラグが無い） |

### 構造的な悪循環（未修正）

1. hold対象のitemが1件でも残っていると `items.length` が0にならず、**タイマーは永久に止まらない**。
2. 送信可能itemがN件あると1passで **2N request**。直列awaitなので所要は `2N × RTT`。
3. **1passが5秒を超えると次のtickが重なる**。重なったpassは同じ `lcGetAll('outbox')` スナップショットを
   処理するため、**同じitemを二重に送り**、さらに遅くなってさらに重なる。
4. これは 2026-08-19 に `loadAll` について直したのと**まったく同じ構造の欠陥**が、
   `flushOutbox` 側に**そのまま残っている**ということ。

N=50 で RTT 50ms なら 1pass = 5秒 → 臨界点。N=100 なら確実に多重化する。

---

## 7. inspection / realtime 経路

- `ensureInspectionSession`（`supabase-integration.js:314`）は `inspections` テーブルのみ。**kv_store には触らない**。
- 成功後は `clearInterval` して自分で止まる。`if (currentInspectionId) return` で早期return。
- `installRealtimeSync()` は WebSocket。**REST の kv_store リクエストを1件も生まない**。
- 受信側 (`window.onRealtimeUpdate` / `sb-realtime-update` リスナー) は **index.html に存在しない**
  → 「Realtime通知 → 再取得 → 更に通知」のループは**構造的に不可能**。

→ **この2つは今回の storm の原因ではない**（除外確定）。

---

## 8. FIRST_BREAK

**FIRST_BREAK は「1秒polling」ではない。**
`loadAllInner()` は実コード上 1tick = 2 GET で確定しており（第4節）、これは配信物にも入っている。

最初に壊れているのは次の2箇所のどちらか（URL 1件で判別可能）。

**FIRST_BREAK 候補 A（環境）**
`public/index.html` の修正が **未コミット**であり、`origin/main` = Vercel本番 = `d763189` は
修正前のコードのまま。本番URLで開いた瞬間、`loadAllInner` の旧実装が
`Promise.all(allRooms.map(storageGet))` を1秒ごとに実行する。
→ 129室で **258 GET/秒**。

**FIRST_BREAK 候補 B（コード）**
`public/index.html:5054` `applyCurrentPropertyRecord()` → `restoreStampDataFromStorage()`
→ `public/stamp_store/stamp_store.js:294` `loadAll()` の **直列 per-key GET**。
起動直後、部屋数ぶん（最大129回）の kv_store GET が、往復レイテンシの許すかぎり連続で並ぶ。
→ **20〜25 GET/秒 × 数秒〜十数秒**。

---

## 9. ROOT_CAUSE

### ROOT_CAUSE-1（確実。事実として確定済み）

> **request storm 修正は working tree にしか無く、`origin/main`（= デプロイ元）には入っていない。**
> したがって Vercel 本番の Live Board は 100% 修正前のコードで動いている。

`git show HEAD:public/index.html | grep -c loadAllInFlight` = **0**、
`git show HEAD:public/supabase-integration.js | grep -c listValues` = **0**、
`HEAD == origin/main == d763189`。
実Safariが本番URLを見ていたなら、これ**だけ**で観測を完全に説明できる（258 GET/秒）。

### ROOT_CAUSE-2（コード欠陥。localhostでも必ず再現する）

> **「1tickの通信量」だけを最適化し、「同じ関数が何本同時に走るか」「1回の呼び出しが
> 何件の直列リクエストを出すか」を `loadAll` 以外で一切見なかったこと。**

具体的には次の2つが未修正で残っている。

- **StampStore の直列 per-key GET**（`stamp_store.js:294` + `index.html:4671`）
  … `loadAll` に入れた「prefixまとめ取り」が StampStore には入っていない。
  StampStore は `list` でキーだけ取り、値を1件ずつ `storageGet` している——
  これは **2026-08-19 に `loadAll` から取り除いたのと同一のアンチパターン**である。
- **`flushOutbox` に再入ガードが無い**（`index.html:4362`）
  … `loadAll` に入れた `inFlight` ガードが `flushOutbox` には入っていない。
  5秒周期・件数比例・直列awaitなので、件数が増えると必ず多重化する。

つまり修正は **1箇所（loadAll）にだけ当てられ、同じ欠陥を持つ他の2箇所には当てられなかった**。

---

## 10. なぜテストで見逃したか

`public/test/request_storm_fix_verify.js` の設計そのものが原因。

| 監査項目 | 事実 |
|---|---|
| loadAllだけをテストしていないか | **loadAllだけ**。`PRODUCT_SRC`（同ファイル61-88行）が `index.html` から文字列抽出するのは `keyFor` / `scheduleOverrideKeyFor` / scope層 / `lcCacheKey` / `storageGet` / `storageListValues` / `readValueFromLocalCache` / `readRoomValuesBulk` / `loadAllInFlight` / `loadAll` / `loadAllInner` の**11個だけ** |
| StampStoreを含むか | **含まない**。項目Lは `check('L. 読み込み経路が STAMP に触らない', all.indexOf(needle) === -1)` という**loadAllのソース文字列検査**であって、StampStoreのリクエスト数は1件も数えていない |
| outboxを含むか | **含まない**。項目Kも同じくソース文字列検査＋「loadAll前後でoutboxが増減しない」だけ。`flushOutbox` は**抽出すらされていない** |
| 全timerを同時実行しているか | **していない**。テストが動かすのは `loadAll` のみ。`setInterval` は5本とも1本も再現していない |
| 実 supabase-integration.js を通すか | **通さない**。`window.storage` は `makeEnv()`（93-155行）の**手書きフェイク**。実シムは `listValues` の**ソース文字列を正規表現で検査**しているだけで、実行はしていない |
| 実ブラウザ起動時シーケンスを再現するか | **していない**。`initPropertyStartupGate` / `applyCurrentPropertyRecord` / `runMainAppBootSequence` / `restoreStampDataFromStorage` はどれも抽出対象外 |

**結論**: このテストが測っているのは「**loadAll が出すリクエスト数**」であって、
「**ページ全体が出すリクエスト数**」ではない。
「258 → 2」は loadAll 単体としては正しく、**その主張の範囲では嘘ではない**。
しかし利用者が Network タブで見るのはページ全体の合計であり、テストはそこを一度も測っていない。
さらに、テストは **未コミット状態の working tree** を読むため、
「デプロイされているか」は原理的に検出できない。

---

## 11. 最小修正案（今回は実装しない。原因確定のみ）

優先順位順。**確定するまで着手しないこと**（第12節のURL確認が先）。

**FIX-0（コード変更ゼロ・最優先）**
現在の working tree を commit / push し、Vercel の deploy 完了を待ってから本番URLを再確認する。
これだけで ROOT_CAUSE-1 は消える。**ユーザーのPC作業**。

**FIX-1（StampStore の直列GET → まとめ取り）**
`index.html:4671` の adapter に、`loadAll` で既に作った `storageListValues` を使う
`listValues` adapter を1本足し、`stamp_store.js:294` の `keys.reduce(...)` チェーンを
「まとめ取りできたらそれを使い、無いキーだけローカルキャッシュで補う」へ差し替える。
`readRoomValuesBulk` と**まったく同じ形**にできる。
効果: 起動時 129 GET → **1 GET**。

**FIX-2（`flushOutbox` に再入ガード）**
`loadAll` と同じ3行。
```js
var flushOutboxInFlight = false;
async function flushOutbox() {
  if (flushOutboxInFlight) return;
  flushOutboxInFlight = true;
  try { /* 既存の中身 */ } finally { flushOutboxInFlight = false; }
}
```
効果: 多重化を構造的に禁止。1passの通信量自体は変わらない（別課題）。

**FIX-3（`reloadStampStoreForCurrentProperty` に再入ガード）**
起動チェーンと「連絡票パネルを開く」が重なったときの二重実行を止める。FIX-1 実施後は影響が小さくなる。

**FIX-4（テストの盲点を塞ぐ）**
「ページ全体の kv_store リクエスト数」を数えるテストを1本追加する。
`phase1e_a1_current_property_persist_verify.js` の `bootLiveBoard()`（`supabase-integration.js` を
vm で丸ごと評価する既存の仕組み）を流用し、
**起動シーケンス + 全setInterval を5秒ぶん回して総リクエスト数を数える**のが最短。
※ 今回は test 変更禁止のため未実施。

---

## 12. ユーザーがSafariで確認する項目（**これ1回で原因が確定します。所要1分**）

Live Board を開いて Network を見ている状態で、**kv_store のリクエストを1件クリックし、URL全文を教えてください。**
必要なのは `?` 以降だけです。判定表:

| URL に含まれる文字列 | 原因 | 対応 |
|---|---|---|
| `select=key%2Cvalue` かつ `key=like.fireflow-binder%3A%25` が **1秒に1件だけ** | 修正版が動いている。stormは別の発火源 | 下の行と併せて判定 |
| `select=value` かつ `key=eq.fireflow-binder%3A<部屋番号>` が**連発** | **ROOT_CAUSE-1**。修正前のコードが動いている（＝本番URL、または古いキャッシュ） | FIX-0（commit → push → deploy） |
| `select=value` かつ `key=eq.stamp%3A...` が**連発** | **ROOT_CAUSE-2 / StampStore** | FIX-1 |
| `select=key` かつ `key=like.fireflow-stamp%3A%25` が出る | StampStore の legacy migration が毎回走っている | FIX-1 + スコープキー調査 |
| `select=id` + そのあと `PATCH` / `POST` が**連発** | **outbox 多重flush** | FIX-2 |
| `key=like.fireflow-presence%3A%25` が連発 | 進捗詳細パネルが開いたまま | 別途 |

**あわせて、アドレスバーのURLが `localhost:3000` か本番URL（`*.vercel.app` 等）かもお知らせください。**
本番URLだった場合、**その時点で ROOT_CAUSE-1 が確定**し、コード修正は不要です（deploy するだけ）。

---

## 13. Phase 1E-A1 へ戻れる条件

すべて満たすまで Phase 1E-A1 は再開しない。

1. 第12節のURL確認が完了し、ROOT_CAUSE が **1つに確定**している。
2. 確定した原因に対する最小修正（FIX-0 / FIX-1 / FIX-2 のうち該当分）が入っている。
3. 実Safari で **Network履歴クリア → 無操作5秒 → kv_store が 10件前後（＝2 GET/秒）以内**を確認済み。
   起動直後のバーストも含めて確認する（「前回の物件を続ける」を押した直後から30秒間を見る）。
4. 赤い 500 が0件。
5. 129室すべてが正しく描画されている（`listValues` の `db-max-rows` 打ち切りリスク R-1 の同時確認）。
6. `npm run test:release` / `test:unit` / `typecheck` / `build` がPASS。

---

## 14. 今回の監査で実行したこと（変更0の証明）

- 読み取り・grep のみ。`public/` 配下と `docs/` 配下の**製品コードは1文字も変更していない**。
- 追加したのは本ドキュメント1ファイルのみ。
- `npm run test:release`（NG 0件）/ `npm run test:unit`（ALL PASS）/ `npm run typecheck`（exit 0）を実行。
- dev server を起動し `curl` で配信物を確認したのち停止。
- git add / commit / push は未実施。
