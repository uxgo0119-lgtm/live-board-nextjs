# FireFlow / Live Board — REQUEST STORM 完全修正（自動実行）

作成日: 2026-08-22（無人実行）
基準commit: `d763189 fix: hold outbox items without resolved property id`（working tree に未コミット差分あり。差分は一切消していない）

## 0. 判定

**REQUEST_STORM_AUTOFIX_COMPLETE**

- ROOT_CAUSE 確定（実ブラウザで観測されたURLと、それを出すコードの1本道を突き合わせて確定）
- schedule-override / binder / stamp / outbox の連続通信を解消
- PAGE-WIDE IDLE REQUEST TEST を新設し、129室・259室とも **IDLE 30秒の kv_store REST = 0** を確認
- `test:unit` / `test:release` / `typecheck` / `build` すべて PASS

Safari確認は判定の必須条件にしていない（要求どおり）。ただし実機での最終確認は
「帰宅後PC作業」として残る（第14節）。

---

## 1. ROOT_CAUSE

> **部屋状態を知る手段が「1秒ごとのポーリング」しか無く、
> ユーザー操作もデータ変更も無い時間帯にも同じ内容を取り直し続けていたこと。**

`public/index.html` の `runMainAppBootSequence()` にあった

```js
setInterval(loadAll, 1000);
```

が、`loadAllInner()` → `readRoomValuesBulk()` → `storageListValues()` →
`window.storage.listValues()` を **1秒ごとに2回** 呼び続けていた。

実Safari（localhost:3000）で観測されたURL

```
select=key,value
property_id=eq.b6e18eed-f2f3-4674-812d-322732908616
key=like.fireflow-schedule-override:%25
shared=eq.true
owner_id=is.null
```

は、`public/` 配下でこの形を作る唯一のコード（`supabase-integration.js:486` の
`listValues`、`select('key,value')` を使うのはここだけ）から出ている。
**2 GET/秒 × 約74秒 = 148件** で、観測された「短時間で148件」と一致する。

### なぜ過去の修正で止まらなかったか

2026-08-19 以降の修正は、いずれも「**1回の呼び出しが何件のリクエストを出すか**」だけを直していた。

| 過去の修正 | 直した軸 | 直っていなかった軸 |
|---|---|---|
| `loadAll` の部屋単位N+1 → prefix一括取得 | 1tickの件数 258 → 2 | **1秒ごとに永久に呼ばれること** |
| `StampStore.loadAll` → getMany | 復元1回の件数 259 → 1 | 同上（ただしStampStoreは周期実行に乗っていない） |
| `flushOutbox` 再入ガード＋連続失敗打ち切り | 1passの多重化・件数 | 5秒ごとに失敗を繰り返し続けること |
| `StampStore.putMany` 内容不変時の抑制 | 起動時の書き戻し258件 | 同上 |

つまり **「1tickの通信量」は3回直したが、「tickそのものの存在」を一度も疑っていなかった**。
テスト側も同じ盲点を持っており、`request_storm_fix_verify.js` は
「`setInterval(loadAll, 1000)` が**維持されている**こと」を PASS 条件として要求していた
（今回この判定を反転させた）。

---

## 2. 全発火元（kv_store へ到達しうる経路の全数）

`kv_store` へ届く入口は `window.storage.{get,set,delete,list,listValues}` の5本だけで、
アプリ側は必ず `storageGet/Set/Delete/List/ListValues` を経由する（監査済み・変更なし）。

| # | 発火元 | 契機 | 修正前 | 修正後 |
|---|---|---|---|---|
| 1 | `loadAllInner()` の `readRoomValuesBulk` ×2 | **`setInterval(loadAll,1000)`** / 起動 | **2 GET/秒（永久）** | 起動1回 + 必要イベント時のみ |
| 2 | `stampStore.loadAll()` | 起動・物件切替・連絡票パネル | 1 list + 1 まとめ取り | 変更なし（周期実行に乗っていない） |
| 3 | `stampStore.migrateLegacyKeys()` | 現スコープが0件のときだけ | 変更なし | 変更なし |
| 4 | `flushOutbox()` | 失敗時のみ5秒周期 / online / visible / supabase-ready | 5秒固定で永久リトライ | **5→60秒の待ち延ばし**（成功・復帰で即5秒へ復帰） |
| 5 | `sendPresenceHeartbeat()` | **`setInterval(…,20000)`** | **2 REST/20秒（永久）** | **操作したときだけ（最短20秒間隔）** |
| 6 | `loadActiveInspectors()` | 進捗詳細パネルを開いている間の `renderFloors()` | list 1 + 人数ぶんのGET | **まとめ取り1件**（N+1解消） |
| 7 | `persist()` | 利用者の保存操作 | GET 1 + 書込2 | 変更なし（保存の一貫性のため必要） |
| 8 | `loadCurrentPropertyRecord()` / `loadSiteSupervisor` / `loadScheduleDays` / `loadEquipmentList` / `loadUploadedDocuments` | 起動時1回ずつ | 各1 GET | 変更なし |
| 9 | `loadBuildingNotes` / BOテーブル / PROGRESS_LOG / equip / ext | 各画面の表示・保存時 | 変更なし | 変更なし |
| 10 | `ensureInspectionSession()` | 5秒周期（失敗時のみ・成功で自分を止める） | `inspections` テーブル。**kv_store には触らない** | 変更なし |
| 11 | Realtime（WebSocket） | 購読 | REST を1件も出さない | **受信側を新設**（下記） |

**周期実行（`setInterval`）の全数（修正後）**

| 位置 | 周期 | kv_store | 起動条件 |
|---|---|---|---|
| `flushOutbox` | 5秒〜60秒（可変） | する | 保存がリモート失敗した時だけ。キューが空になれば自分で停止 |
| `checkScheduledReminders` | 60秒 | **しない** | 常時（通知バナーのみ） |
| `requestRemoteRefresh('realtime-down')` | 60秒 | する | **Realtime未接続のときだけ**。購読成功で即停止 |
| `ensureInspectionSession`（supabase-integration.js） | 5秒 | **しない**（inspections） | セッション作成失敗時のみ。成功で自分を停止 |

再帰 `setTimeout` による自前ポーリングは0件（テストで検査）。

---

## 3. 今回の修正

### FIX-1: 1秒ポーリングの廃止とイベント駆動化（`public/index.html`）

`setInterval(loadAll, 1000)` を削除し、`requestRemoteRefresh(reason)` を唯一の起動口にした。
読み直しが起きるのは次の場合だけ。

| 契機 | 実装 |
|---|---|
| 起動 | `runMainAppBootSequence()` の `loadAll()`（従来どおり） |
| 他端末の更新 | `document` の `sb-realtime-update`（`table === 'kv_store'` のみ） |
| オンライン復帰 | `window` の `online` |
| 画面へ戻る | `visibilitychange`(visible) / `focus` |
| 物件切替 | `parseExcelAndRebuild()` / `createNewProperty()` から `requestRemoteRefresh('property-change')` |
| パネルを閉じた | `hideBackdrop()` が持ち越し分を1回だけ流す |

- **600msのデバウンス**：129室ぶんの通知が一気に来ても読み直しは1回（＝2 GET）。
- **パネル中の持ち越し**：`loadAll()` は従来どおり入力中の画面を書き換えないが、
  ポーリングが無くなった以上「捨てる」と二度と反映されないため、`loadAllDeferredRefresh`
  で持ち越して `hideBackdrop()` で1回だけ流す。

### FIX-2: Realtime購読状態の通知（`public/supabase-integration.js`）

`channel.subscribe()` に status コールバックを渡し、`sb-realtime-status` を dispatch するだけ。
購読対象・payloadの扱い・既存の `sb-realtime-update` は1文字も変えていない。

これにより、**Realtimeが繋がっていない間だけ** 60秒に1回の予備の読み直しを動かし、
`SUBSCRIBED` が届いた瞬間に止める。正常時は1件も出さない。

> これは「10秒・30秒へ変えて誤魔化す」ためのものではない。
> Realtime という通知経路が使えない環境（購読失敗・未ログイン等）で
> **他端末同期を完全に失わないための縮退動作**であり、
> 正常時（購読成功）の IDLE 通信は 0 件であることをテストで固定している。

### FIX-3: 在席プレゼンスの周期送信を廃止（`public/index.html`）

`setInterval(sendPresenceHeartbeat, 20000)` を削除。
`pointerdown` / `keydown`（capture）で「実際に操作した」ときだけ、最短20秒間隔で送る。
起動直後と点検員名の変更は `{force:true}` で必ず送る。

受信側の判定（`PRESENCE_ACTIVE_MS = 90秒`）は変更していないので、操作中の点検員は従来どおり
「現在点検中」に出る。90秒以上まったく操作していない端末が外れるのは、表示の意味として正しい。

### FIX-4: 在席一覧の N+1 解消（`public/index.html`）

`loadActiveInspectors()` を `storageList` + 人数ぶんの `storageGet` から
`storageListValues` 1本へ。判定・並び順・戻り値の形は同じ。

### FIX-5: 送信キュー再送の待ち延ばし（`public/index.html`）

`scheduleOutboxRetry(opts)` に、1回のflushの結果を渡せるようにした。

- 1件も送れず失敗だけが続いた回 → 待ち時間を2倍（5 → 10 → 20 → 40 → **60秒で頭打ち**）
- 1件でも送れた回 / `online` / `visibilitychange(visible)` → **必ず5秒へ戻す**
- 送信キューが空になれば従来どおりタイマーを停止

送信キューのitem・順序・判定・保存内容には触れていない（データは1件も捨てない）。

---

## 4. pollingをどうしたか

| 対象 | 修正前 | 修正後 |
|---|---|---|
| 部屋状態（binder / schedule-override） | 1秒ポーリング（2 GET/秒・永久） | **廃止**。起動＋イベント駆動 |
| 在席プレゼンス | 20秒周期の書き込み（2 REST/20秒・永久） | **廃止**。操作時のみ（最短20秒間隔） |
| 送信キュー | 5秒固定・永久 | 失敗時のみ 5→60秒の待ち延ばし。空で停止 |
| 予定情報（StampStore） | 周期実行なし | 変更なし |
| Realtime | 受信側が存在しなかった | **kv_store通知を読み直しの起動口として使用** |

---

## 5. request数（PAGE-WIDE 実測値）

計測は `public/test/page_wide_idle_request_verify.js`。
実 `index.html` / `stamp_store.js` の起動シーケンスを vm 上で動かし、
`window.storage` を PostgREST のクエリ文字列ごと記録するフェイクに差し替えて数えている。

| 項目 | 修正前 | 修正後 |
|---|---|---|
| 修正前の実測（実Safari） | 無操作で **148件 / 約74秒** | — |
| boot（129室） | — | **10件** |
| boot（259室） | — | **10件**（部屋数比例なし） |
| **IDLE 30秒（129室）** | 約60件（2 GET/秒） | **0件** |
| **IDLE 30秒（259室）** | 約60件 | **0件** |
| 他端末通知1件 | — | 2件（まとめ取りのみ） |
| 他端末通知129件が同時 | — | 2件（デバウンスで1回） |
| 物件切替 | — | 2件 |
| オンライン復帰 | — | 4件（読み直し2 + 送信キュー消化） |

boot の内訳（129室・259室とも同じ10件）:

```
1  GET select=key,value  key=like.fireflow-binder:%            ← 部屋状態(まとめ取り)
1  GET select=key,value  key=like.fireflow-schedule-override:% ← 点検時刻変更(まとめ取り)
1  GET select=key        key=like.stamp:<物件>:%               ← StampStoreのキー一覧
1  GET select=key,value  key=like.stamp:<物件>:%               ← StampStoreの値(まとめ取り)
4  GET select=value      現場責任者 / 日程 / 設備一覧 / 資料一覧
2  在席の合図（select=id + POST/PATCH）※起動時1回だけ
```

### IDLE request budget

**EXPECTED_IDLE_REQUESTS = 0**（起動完了後・ユーザー操作なし・データ変更なし・
送信キュー正常・Realtime通知なしの30秒間における kv_store REST）

0にできない通信は**無い**。テストはこの0を等号で固定している。

---

## 6. テスト結果

| 項目 | 結果 |
|---|---|
| `npm run test:unit` | **PASS**（exit 0） |
| `npm run test:release` | **PASS**（16スイート全PASS / NG 0件） |
| `npm run typecheck` | **PASS**（exit 0） |
| `npm run build` | **PASS** |

release の内訳（総合結果のみ）:

```
index_html_phase1_fix_test            PASS (29/29)
phase1a_property_id_verify            PASS (49/49)
phase1b_property_state_reset_verify   PASS (76/76)
phase1c_property_scope_verify         PASS (151/151)
outbox_no_data_loss_verify            PASS (78/78)
phase1e0_outbox_property_safety       PASS (110/110)
phase1e_a1_current_property_persist   PASS (142/142)
request_storm_fix_verify              PASS (79/79)
stampstore_request_storm_fix_verify   PASS (59/59)
stampstore_seed_storm_fix_verify      PASS (56/56)
outbox_request_storm_fix_verify       PASS (59/59)
page_wide_idle_request_verify         PASS (69/69)   ← 今回新設
phase1d_property_scope_migration      PASS (94/94)
phase1d_real_device_dryrun_page       PASS (64/64)
apply_confirmed_to_lb_test            PASS (13/13)
normalize_test                        PASS (30/30)
```

---

## 7. PAGE-WIDE IDLE REQUEST TEST の内容

`public/test/page_wide_idle_request_verify.js`（release gate に登録済み）

**測り方**: 実 `index.html` の `runMainAppBootSequence()` を含む実ソースを vm へ載せ、
仮想時計（`setTimeout`/`setInterval`/`Date.now` を差し替え）で30秒を進め、
`window.storage` に届いた PostgREST リクエストを1件残らず記録する。
テスト用に書き直した製品関数は1つも無い（フェイクは IndexedDB / kv_store / DOM / イベント / 時計だけ）。

| # | 要求項目 | 検査内容 | 結果 |
|---|---|---|---|
| 1 | 129室 boot | 起動シーケンス実行 | PASS |
| 2 | boot までの request 数 | 10件（15件以下） | PASS |
| 3 | boot後30秒 idle | 仮想時計で30秒 | PASS |
| 4 | idle中の GET/POST/PATCH/DELETE 数 | すべて0 | PASS |
| 5 | 259室でも同じ | idle 0件 | PASS |
| 6 | 部屋数比例がない | boot 10件 == 10件 | PASS |
| 7 | schedule-override 周期GET停止 | 0件 | PASS |
| 8 | binder 周期GET停止 | 0件 | PASS |
| 9 | stamp 周期GET停止 | 0件 | PASS |
| 10 | outbox正常時の周期書込なし | キュー空・タイマー無し | PASS |
| 11 | remote 500 で storm化しない | 129件失敗でも30秒6件・上限60秒・**キュー130件が1件も失われない** | PASS |
| 12 | timeout で storm化しない | 応答待ち中に多重化しない・再入ガード解放 | PASS |
| 13 | offline は remote 0 | 送信・削除0件・ローカルから129室復元 | PASS |
| 14 | online復帰で必要な同期だけ | 読み直し2件・復帰後idle 0件・キュー空 | PASS |
| 15 | reload正常 | 129室復元・保存内容一致・idle 0件 | PASS |
| 16 | property切替正常 | 新部屋一覧復元・通信2件・idle 0件 | PASS |
| 17 | 保存→復元一致 | 1バイト一致 | PASS |
| 18 | 別物件混入0 | PID_B のデータ0件・PID_B あて通信0件 | PASS |
| 追 | 他端末同期 | Realtime通知で反映・129通知でも読み直し1回 | PASS |
| 追 | パネル中の持ち越し | 開いている間0件 → 閉じた直後1回 | PASS |
| 追 | Realtime未接続の縮退 | 30秒0件 / 60秒に1回 / 購読成功で停止 | PASS |
| 追 | 在席プレゼンス | 無操作2分で0件 / 操作時のみ / 一覧は1リクエスト | PASS |
| 追 | ソース全数検査 | 周期実行の棚卸し・再帰setTimeout 0件・起動時読み込み各1回 | PASS |

---

## 8. 回帰防止

release gate（`npm run test:release`）に `page_wide_idle_request_verify.js` を追加した。
将来 storm を再発させる変更が入ると、次のいずれかで **FAIL** する。

1. `setInterval(loadAll, …)` / `setInterval(sendPresenceHeartbeat, …)` を復活させた
   → ソース全数検査（`index.html に部屋状態・在席の周期実行が1件も無い`）が落ちる。
2. 棚卸しに無い固定間隔の `setInterval` を足した
   → `残っている固定間隔の setInterval は棚卸し済みのものだけ` が落ちる。
3. 再帰 `setTimeout` で自前ポーリングを書いた → 専用検査が落ちる。
4. 何らかの経路で IDLE 中に kv_store を叩くようになった
   → `IDLE 30秒の kv_store REST が EXPECTED_IDLE_REQUESTS(=0) と一致する` が落ちる。
5. 部屋数比例の通信を復活させた → 129室 vs 259室の boot 件数一致が落ちる。
6. 起動時読み込みが1関数で複数回読むようになった → 各 `loadXxx()` の読み取り1回検査が落ちる。

あわせて `request_storm_fix_verify.js` の「polling 設定」節を反転させた
（`setInterval(loadAll, 1000)` が**存在しないこと**＋イベント配線が揃っていることを要求）。

---

## 9. 変更ファイル

| ファイル | 変更内容 |
|---|---|
| `public/index.html` | 1秒ポーリング廃止・`requestRemoteRefresh` 新設・パネル持ち越し・在席の操作駆動化・在席一覧のまとめ取り・送信キューの待ち延ばし・物件切替からの読み直し依頼 |
| `public/supabase-integration.js` | `channel.subscribe()` に status コールバックを追加し `sb-realtime-status` を dispatch（それ以外は不変） |
| `public/test/page_wide_idle_request_verify.js` | **新設**。PAGE-WIDE IDLE REQUEST TEST |
| `public/test/request_storm_fix_verify.js` | 「polling 設定」節を反転（1秒ポーリングが無いことを要求） |
| `public/test/phase1c_property_scope_verify.js` | 業務キー全数監査に `storageListValues` を追加（従来は見ていなかった） |
| `test/unit/lb/inspectionReportMasterPolicy.test.ts` | `requestRemoteRefresh` のスタブを追加 |
| `package.json` | `test:release` に page-wide テストを追加 |
| `docs/FireFlow_RequestStorm_AutoFix_Complete_2026-08-22.md` | 本ドキュメント |

**やっていないこと**（要求どおり）: 新しい正本を作らない / storage層を増やさない /
adapterを乱立させない / offlineを壊さない / outboxを削除しない / StampStoreを削除しない /
property scopeを壊さない / データ保存を省略して通信0に見せない / エラーを握り潰さない。
`git add` / `commit` / `push` / deploy / Supabase操作 / 依存パッケージ変更も未実施。
既存の未コミット差分（Phase 1E-A1分を含む）は1件も消していない。

---

## 10. 設計上のふるまいの変化（把握しておくべき点）

1. **他端末の更新の反映タイミング**が「最大1秒遅れ」から「Realtime通知を受けた時点」に変わる。
   通常はむしろ速くなるが、Realtimeが繋がっていない場合は
   「60秒に1回 or 画面復帰・オンライン復帰・保存操作時」になる。
2. **在席一覧**は「操作している端末」だけが出る。端末を置いたまま90秒以上何もしていない
   点検員は一覧から外れる（表示の意味としては正しいが、従来と見え方が変わる）。
3. **送信キューの再送**は失敗が続くと最大60秒間隔まで延びる。復帰操作（オンライン復帰・
   画面復帰）または1件でも送信成功した時点で即座に5秒へ戻る。

---

## 11. Phase 1E-A1 へ戻れるか

**戻れる。**

request storm の原因は確定し、コード修正・回帰テスト・release gate 追加まで完了している。
Phase 1E-A1 の差分（`docs/FireFlow_Phase1E_A1_CurrentPropertyPersist_2026-08-19.md` と
`public/test/phase1e_a1_current_property_persist_verify.js`）は手つかずで保護されており、
そのテストも 142/142 PASS のままである。

ただし第14節の実機確認（Safari）を先に済ませておくと、以後の判断が安全になる。

---

## 12. 残課題（今回のスコープ外）

- `stampStore.migrateLegacyKeys()` は、現スコープに1件も予定情報が無いときに
  `fireflow-stamp:` を list → 件数ぶんの書き込みを直列で行う。今回の IDLE 通信には
  関与しないが、`PROPERTY.name` が変わってスコープキーがずれると起動のたびに走り得る。
  （`stampstore_seed_storm_fix_verify.js` が書き込み側の抑制は担保済み）
- `ensureInspectionSession()` は失敗時に5秒周期で `inspections` を叩き続ける。
  kv_store ではないため今回の budget 対象外だが、同じ待ち延ばしを入れる余地がある。
- `loadActiveInspectors()` は進捗詳細パネルを開いている間、`renderFloors()` のたびに
  1リクエスト出る（N+1は解消済み）。パネルを開きっぱなしにする運用が常態化するなら、
  更新間隔を持たせる検討余地がある。

---

## 13. 実行した確認（証跡）

- `npm run test:unit` → exit 0
- `npm run test:release` → 16スイート全PASS（NG 0件）
- `npm run typecheck` → exit 0
- `npm run build` → 成功
- dev server を起動し `curl` で**配信物**を確認
  - `/` に `installRemoteRefreshTriggers` が4件含まれる
  - `/` に残る `setInterval(loadAll, 1000)` の2件は**どちらもコメント内**（実コードは0件）
  - `/supabase-integration.js` に `sb-realtime-status` が含まれる
  - 確認後、起動した dev server は停止済み

---

## 14. 帰宅後PC作業（ユーザー操作が必要なもの）

1. Safari で `http://localhost:3000` を開き、起動ゲートで「前回の物件を続ける」を選ぶ。
2. Network 履歴を削除し、**何も操作せず30秒**待つ。
   → kv_store のリクエストが **0件**（Realtime未接続なら60秒に1件のまとめ取り2件）になることを確認。
3. 赤い 500 が0件であること、129室すべてが正しく描画されていることを確認。
4. 問題なければ commit / push（Vercel本番はまだ `d763189` = 修正前のコードのままなので、
   本番URLで確認する前に deploy が必要）。
