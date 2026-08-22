# request storm 修正の commit 分離と Phase 1E-A1 復帰準備（2026-08-22）

無人実行での作業記録。基準commit `d763189`。**コードの動作は1行も変えていない**
（差分の分類・全テストの再実行・commit分離の準備だけ）。

無人実行では `git add / commit / push` が実行できないため、
**「PCの前で1本流せば request storm commit が完成する」形**まで作って止めている。

---

## 1. request storm 最終判定

**REQUEST_STORM_FIXED**

`docs/current_task.md` §6 の判定条件を、全部テストで機械確認済み。

| 条件 | 確認方法 | 結果 |
|---|---|---|
| 毎秒大量連打の解消 | 実Safari / localhost:3000（2026-08-22、ユーザー確認済み） | 200秒784件 → 起動直後に数件のみ |
| PAGE-WIDE request test | `page_wide_idle_request_verify` | PASS 69/69 |
| 129室 | `page_wide_idle_request_verify` 1〜4 / `request_storm_fix_verify` C/D/O | PASS |
| 259室 | `page_wide_idle_request_verify` 5/6（IDLE 30秒で kv_store REST = 0） | PASS |
| 500 storm化なし | `page_wide_idle_request_verify` 11（129室でも30秒30件以下・データ破棄0） | PASS |
| timeout storm化なし | `page_wide_idle_request_verify` 12（多重化しない） | PASS |
| offline | 同 13（オフラインIDLE 30秒で送信・削除0） | PASS |
| online復帰 | `outbox_request_storm_fix_verify` / backoff の5秒復帰 | PASS |
| property切替 | 同 16（切替後IDLEも0件・まとめ取り2件だけ） | PASS |
| 保存復元 | 同 15/17/18（reload後129室復元・別物件混入0） | PASS |
| unit / release / typecheck / build | 下記§3 | 全PASS |

### 残存する定期通信の扱い

完全idle 0件ではなく、数十秒おきの少数通信が残る。これは request storm とは別物として
**別タスクへ分離**する（本commitの対象外）。既知の発生源は次の2つで、いずれも設計上の縮退・
定期処理であり、部屋数に比例しない。

- `REMOTE_REFRESH_FALLBACK_MS = 60000`：Realtime が購読できていない間だけの予備読み直し
  （2 GET / 60秒）。購読成功で必ず止まる
- `setInterval(checkScheduledReminders, 60000)`：リマインダー確認（今回の修正対象外）

加えて **kv_store の 500（`42P17 infinite recursion detected in policy for relation
"property_members"`）は未解決のまま**で、これはDB側RLSの問題。
`docs/FireFlow_Supabase500_Fix_Design_2026-08-19.md` が正本。request storm とは別タスク。

---

## 2. 差分の分類（STEP 1）

### A. request storm 修正一式 → 今回の commit 対象

| ファイル | 内容 |
|---|---|
| `public/index.html` | 1秒ポーリング廃止 / requestRemoteRefresh / Realtime status連携 / visibility・focus・online・物件切替・パネル閉じ / binder・schedule override 一括取得 / loadAll再入ガード / flushOutbox再入ガード・失敗時backoff / presence操作連動・N+1解消 |
| `public/stamp_store/stamp_store.js` | loadAll一括取得（getMany）/ putManyの不変データ再保存抑制 / legacy移行の一括取得 |
| `public/supabase-integration.js` | **storm部分のみ**（`kvListValuesForProperty` / `storage.listValues` / `channel.subscribe(status)`）|
| `package.json` | **storm部分のみ**（storm 5テストを test:release へ追加）|
| `public/test/phase1b_property_state_reset_verify.js` | loadAll分割・まとめ取りに追随（期待値の変更なし）|
| `public/test/phase1c_property_scope_verify.js` | `storageListValues` を業務キー監査の対象に追加 |
| `test/unit/lb/inspectionReportMasterPolicy.test.ts` | `requestRemoteRefresh` スタブ追加 |
| `test/unit/lb/stampStorageAdapterRoundTrip.test.ts` | まとめ取り経路のソース読み込み追加 |
| `public/test/request_storm_fix_verify.js` ほか4本（新規）| storm専用テスト |
| storm関連docs 7本（新規）| 調査・修正・実ブラウザ監査の記録 |

### B. Phase 1E-A1 → 今回は commit しない（差分は維持）

- `public/supabase-integration.js` の A1 部分
  （`CURRENT_PROPERTY_STORAGE_KEY = 'lb_current_property_id'` /
  `readPersistedPropertyId` / `persistPropertyId` / setter内の保存 /
  `restorePersistedPropertyIdAtStartup`）
- `public/test/phase1a_property_id_verify.js`（setter呼び出し経路の期待値更新）
- `public/test/phase1e_a1_current_property_persist_verify.js`（新規）
- `docs/FireFlow_Phase1E_A1_CurrentPropertyPersist_2026-08-19.md`（新規）
- `package.json` の A1 部分（phase1a / phase1e_a1 を test:release へ追加）

### C. 無関係な既存差分 → どちらの commit にも入れない

- `docs/FireFlow_StampBatchValidation_Phase3_2026-08-15.md`（過去の無人実行の追記。§12）
- `docs/current_task.md.save`（エディタのバックアップ。中身はタスク指示の写し）

### D. 調査用一時ファイル → **削除していない**

- `public/test/_probe_sbjs_eval.js`
- `public/test/_probe_seed_demo_storm.js`

`package.json`・`test/`・`public/` のどこからも参照されていないことを grep で確認済み
（docs から名前が言及されているだけ）。ただし **Git未追跡＝削除が不可逆**のため、
無人実行では消さない（`FireFlow_StampBatchValidation_Phase3` §11 と同じ判断）。
commit 対象にも入れていないので、消さなくても commit は汚れない。

---

## 3. テスト結果（STEP 2）

### 3-1. 現在のワーキングツリー（storm + A1 の両方入り）

| 対象 | 結果 |
|---|---|
| `npm run test:unit` | **PASS**（41ファイル全て ALL PASS）|
| `npm run test:release` | **PASS**（16本 / 合計 1178 チェック）|
| `npm run typecheck` | **PASS** |
| `npm run build` | **PASS**（Compiled successfully）|

release 内訳:
`index_html_phase1_fix_test 29/29` / `phase1a 49/49` / `phase1b 76/76` / `phase1c 151/151` /
`outbox_no_data_loss 78/78` / `phase1e0 110/110` / `phase1e_a1 142/142` /
`request_storm_fix 79/79` / `stampstore_request_storm 59/59` / `stampstore_seed_storm 56/56` /
`outbox_request_storm 59/59` / `page_wide_idle_request 69/69` /
`phase1d_property_scope_migration 94/94` / `phase1d_real_device_dryrun 64/64` /
`apply_confirmed_to_lb 13/13` / `normalize 30/30`

### 3-2. **request storm commit だけの状態**（A1を外した状態）

commit を分けても壊れないことの確認として、A1差分を一時的に外した状態で再実行した。

| 対象 | 結果 |
|---|---|
| `npm run test:unit` | **PASS** |
| `npm run test:release`（storm用の並び）| **PASS**（15本、A1の2本を除く全て）|
| `npm run typecheck` | **PASS** |
| `npm run build` | **PASS** |
| `node --check public/supabase-integration.js` | **OK** |

このときの `public/supabase-integration.js` の差分は **storm の3ハンクだけ**
（41 insertions / 1 deletion）で、A1 の痕跡は0件であることを確認した。
確認後、ワーキングツリーは元どおりに戻してある（`git diff --stat` が作業開始時と同一：
10ファイル / 740 insertions / 89 deletions、`git diff --check` エラー0）。

---

## 4. commit / push（STEP 3〜5）— 未実施。PCで実行する

無人実行では `git add / commit / push` が権限で拒否されるため実行していない。
代わりに次の2ファイルを用意した。

- `scripts/commit_request_storm.sh` … 前提チェック → A1を一時的に外す → 対象ファイルだけ
  staging → **A1が混ざっていないことを staging 内容で再検査** → commit → A1を必ず戻す
- `scripts/split_for_storm_commit.js` … 上記から呼ばれる分離ツール。文字列は完全一致でしか
  消さず、1つでも見つからなければ**何もせず中止**する。実行前に必ずバックアップを取る

### PCでの手順（これだけ）

```
bash scripts/commit_request_storm.sh
npm run test:release
git push origin main
```

push 後の確認:

```
git log -1 --oneline
git status --short
git rev-parse HEAD origin/main    # 2行が同じsha1なら一致
```

`git status --short` に残ってよいのは、**B（Phase 1E-A1）・C（無関係差分）・
D（probe）・`scripts/`** だけ。A（storm）が残っていたら staging 漏れ。

両方の commit が終わったら `scripts/` は削除してよい（使い捨て）。

---

## 5. Phase 1E-A1 再開前監査（STEP 6）

`docs/current_task.md` §9 の10項目を、現在のワーキングツリーで確認した。

| # | 項目 | 結果 | 根拠 |
|---|---|---|---|
| 1 | currentPropertyId 永続化 | OK | `setCurrentPropertyId()` 内の `persistPropertyId()` / A1テスト D |
| 2 | localStorageキー `lb_current_property_id` | OK | `supabase-integration.js:80`。localStorage参照はこの1箇所だけ |
| 3 | 起動時同期復元 | OK | `restorePersistedPropertyIdAtStartup` IIFE。`index.html:1932` で本体より先に読み込まれ、`PROPERTY.propertyId`（`index.html:4034`）が読むより前に確定する / A1テスト A・G |
| 4 | setter経由のみ | OK | `phase1a_property_id_verify`：コメント除去後の `setCurrentPropertyId(` は「定義1＋起動時復元1」のみ、かつその呼び出しが復元関数の中にあることを正規表現で機械確認 |
| 5 | 不正UUIDで既存値を壊さない | OK | A1テスト C・E（現在値も保存値も破壊しない）|
| 6 | INITIAL_PROPERTY_ID fallback維持 | OK | A1テスト B（保存が無ければ従来どおり起動）|
| 7 | 保存無し端末でINITIALを勝手に永続化しない | OK | 復元は不正・不在なら `return` するだけで setter を呼ばない → 保存も走らない / A1テスト B |
| 8 | 他propertyIdへのfallbackなし | OK | 復元関数に代替値の分岐が無い / A1テスト C |
| 9 | 既存test PASS | OK | §3-1 のとおり全PASS |
| 10 | request storm修正との競合なし | OK | 下記 §6 |

### 追加で確認したこと

- localStorage が使えない端末（Safariプライベート等）でも起動が止まらない（A1テスト J/K）
- `lb_current_property_id` は property scope の対象外＝業務データではない、が
  `phase1c` の業務キー全数監査と矛盾しない（localStorage であって `window.storage` ではない）

---

## 6. Phase 1E-A1 と request storm の競合有無

**競合なし。** 根拠は3つ。

1. **同居しているのは `public/supabase-integration.js` と `package.json` の2ファイルだけ**で、
   ソース上の位置が完全に離れている。A1 は先頭のIIFE（`currentPropertyId` の確定、L73〜132）、
   storm は `kvListValuesForProperty`（L396〜）・`storage.listValues`（L480〜）・
   `channel.subscribe`（L522〜）。`public/index.html` と `public/stamp_store/stamp_store.js`
   には A1 の差分が1行も無い（`lb_current_property_id` / `restorePersistedPropertyIdAtStartup`
   の grep が0件）。
2. **A1を外した状態で storm のテスト・typecheck・build が全てPASS**（§3-2）。
   逆に A1込みでも全てPASS（§3-1）。どちらの順でも壊れない。
3. **実行順の依存が正しい向き**：A1 の復元は `supabase-integration.js` 読み込み時（`<head>`）に
   完了し、storm 側が `currentPropertyId` を読むのは全てその後（storage shim・Realtime購読・
   `loadAll`）。storm 側が復元前の値を掴む経路は無い。

---

## 7. Phase 1E-A1 の残作業（STEP 7）

自動テストは全て通っており、実装としては完成している（142/142）。
**残っているのは実ブラウザ確認だけ**で、これは人にしかできない。

`docs/FireFlow_Phase1E_A1_CurrentPropertyPersist_2026-08-19.md` §14 の残課題のうち、
A2 送りの3件（logout時クリア / listMyProperties に無いIDの復元拒否 /
INITIAL_PROPERTY_ID の DEMO 降格）は今回の対象外のまま。

判定は **PHASE1E_A1_READY_TO_COMMIT ではなく、実ブラウザ確認待ち**。
確認がPASSしたら A1 の commit へ進んでよい（今回は commit しない）。

---

## 8. この作業で変更したファイル

新規のみ。既存の製品コード・テストには一切触っていない。

- `docs/FireFlow_RequestStorm_Commit分離_2026-08-22.md`（この文書）
- `scripts/commit_request_storm.sh`（使い捨て）
- `scripts/split_for_storm_commit.js`（使い捨て）
