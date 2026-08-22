# FireFlow / Live Board — StampStore 残存 request storm 完全修正

作成日: 2026-08-22（無人実行）
基準commit: `d763189 fix: hold outbox items without resolved property id`
判定: **STAMPSTORE_STORM_PARTIAL**（コード修正・全テスト完了／実ブラウザ確認だけ未実施）

Phase 1E-A1 は停止継続。propertyId切替 / migration / Supabase DB / RLS / schema.sql / OCR /
RoomMaster / binder / schedule override / UI / CSS / StampStore保存キー / outbox仕様 は一切変更していない。
git add / commit / push も未実施。

---

## 1. 判定

**STAMPSTORE_STORM_PARTIAL**

原因特定・最小修正・回帰テスト追加・全テストPASS・dev server配信確認まで完了。
実Safariでの再確認（第18節）だけが残っているため PARTIAL とする。

---

## 2. FIRST_BREAK

```
public/index.html:4394  flushOutbox()
  → public/index.html:4452  storageSet(item.rawKey, item.value, item.shared, outboxOpts)
    → public/index.html:4462  window.storage.set(scope.key, value, shared, scope.propertyId)
      → public/supabase-integration.js:440  sb.from('kv_store').select('id')
                                              .eq('property_id', currentPropertyId)
                                              .eq('key', key).eq('shared', !!shared)
                                              .is('owner_id', null)
```

最初に壊れているのは **`flushOutbox()` の送信ループ**である。
`stampStore.loadAll()`（復元）でも `migrateLegacyKeys()` でもない。

### なぜ「読み込み」ではないと確定できるか

実ブラウザで観測されたURLのパラメータ順は

```
select=id & property_id=eq.<uuid> & key=eq.stamp:コスモ六甲ガーデンフォート:113
          & shared=eq.true & owner_id=is.null
```

この順序を作るコードは `public/` 配下に **1つしか無い**。

| 経路 | 生成されるパラメータ順 | 実測URLと一致 |
|---|---|---|
| `window.storage.set`（既定＝現在物件）`supabase-integration.js:440-441` | select, **property_id**, key, shared, owner_id | **一致** |
| `kvSetForProperty`（Phase 1C 別物件）`supabase-integration.js:367` | select, key, shared, **property_id**, owner_id | 不一致 |

`kvScopeQuery()` は `property_id` / `owner_id` を**後から**掛けるため、別物件経路では
`property_id` が `key` より後ろに来る。実測URLは `property_id` が `key` より**前**にあるので、
別物件経路（Phase 1C / 1E-0 / 1E-A1で追加された経路）ではない。

そして `select('id')` を出すのは `set()` の**既存行検索だけ**である
（`get()` は `select=value`、`list()` は `select=key`、`listValues()` は `select=key,value`）。

→ **観測された storm は「読み込み」ではなく【書き込み（保存）の再送】である。**
この事実は回帰テストの J-1 でソース検査として固定してあり、
`supabase-integration.js` 側のフィルタ順が変わればテストが落ちる。

---

## 3. ROOT_CAUSE

> **リモート保存が失敗し続けている状態で、`flushOutbox()` が5秒ごとに
> 「送信キューの全件」を1件ずつ再送し続けていたこと。**
> 1件あたり `select=id` が1本飛ぶため、リクエスト数が送信キューの件数に正比例していた。
> さらに再入ガードが無いため、1passが5秒を超えると次のtickが重なり、重なるほど遅くなって
> さらに重なる悪循環になっていた。

成立の連鎖（すべて実コードで確認済み）:

1. `stamp:<物件>:<部屋>` への書き込みがリモートで失敗する
   （kv_store 500。`docs/FireFlow_Supabase_kv_store_500_Audit_2026-08-19.md` で
   FIRST_BREAK は Supabase サーバ側と確定済み）。
2. `storageSet()` は失敗を例外にせず、同じキーで送信キュー（outbox）へ積み直す
   （`index.html:4483`）。このとき **書き込みが実際に向かった物件**を `propertyId` として
   控える（`index.html:4479-4482`、Phase 1E-0）。
   → stamp itemは「送信先が確定している＝送信可能」item になる。
3. `scheduleOutboxRetry()` が `setInterval(flushOutbox, 5000)` を張る（`index.html:4360`）。
   タイマーが止まるのは outbox が **0件**になったときだけ。
4. 実端末には StampStore が259件ある。129〜259件が送信可能itemとして溜まると、
   1passで `select=id` が129〜259本。**5秒ごとに永久に繰り返す。**
5. 1passが5秒を超えると次tickが重なる。再入ガードが無いため、
   重なったpassは同じ `lcGetAll('outbox')` のスナップショットを処理し、同じitemを二重に送る。

これは 2026-08-19 に `loadAll()` について直したのと**まったく同じ構造の欠陥**が、
`flushOutbox()` 側にそのまま残っていたということである。

### なぜ前回の修正で消えなかったか

前回（2026-08-22）の StampStore 修正は `loadAll()` の**復元（読み込み）**を
prefixまとめ取りへ変えたもので、`select=value` / `select=key,value` を減らす修正だった。
今回の storm は `select=id`＝**書き込み経路**なので、対象が最初から違っていた。
`FireFlow_RequestStorm_RealBrowser_Audit_2026-08-22.md` 第12節の判定表でも
「`select=id` + そのあと PATCH/POST が連発 → **outbox 多重flush** → FIX-2」と予測しており、
実測URLはその行に一致した。

---

## 4. `select=id` 発火元 一覧（全数）

`public/` 配下で `select('id')` / `select("id")` を出すコードは **5箇所**。
そのうち `kv_store` に対するものは **2箇所**だけである。

| # | 場所 | テーブル | クエリ形状 | 実測URLと一致 | 呼び出し元 | 定期実行 |
|---|---|---|---|---|---|---|
| 1 | `supabase-integration.js:440` `window.storage.set` | kv_store | select,property_id,key,shared,owner_id | **一致（storm本体）** | `storageSet()` ← `flushOutbox()` / `persist()` / `stampStore.putMany()` / `migrateLegacyKeys()` | **5秒（flushOutbox）** |
| 2 | `supabase-integration.js:367` `kvSetForProperty` | kv_store | select,key,shared,property_id,owner_id | 不一致 | `window.storage.set` の別物件分岐のみ | 無 |
| 3 | `supabase-integration.js:319` `ensureInspectionSession` | inspections | — | 不一致（kv_storeではない） | 起動時 | 5秒（失敗中のみ） |
| 4 | `supabase-integration.js:324` `ensureInspectionSession` insert | inspections | — | 不一致 | 同上 | 同上 |
| 5 | `supabase-integration.js:633` `property_invites` insert | property_invites | — | 不一致 | 招待作成時 | 無 |

`#1` を `stamp:*` キーで叩く経路（＝実測されたURLを出しうる経路）は次の4つ。

| 経路 | 1回あたりの `select=id` | 定期実行 | 今回の storm への寄与 |
|---|---|---|---|
| **`flushOutbox()` の再送** | **送信可能item数ぶん** | **5秒・再入ガード無し** | **本体。これが原因** |
| `stampStore.putMany()`（捺印表OCR / CSV / 手入力 / demo seed） | 受け付けた部屋数ぶん | 無（利用者操作時） | 一次バーストのみ。失敗すると①へ供給する |
| `stampStore.migrateLegacyKeys()` | 取り込んだ部屋数ぶん | 無（`restored.length===0` のときだけ） | 同上 |
| `stampStore.remove()` / `clearPersisted()` | 0（DELETEでselectしない） | 無 | 無し |

**「何も操作せず5秒放置で100件以上」を説明できるのは `flushOutbox()` だけ**である
（他の3つはすべて利用者操作・起動時の単発で、放置中には1本も出ない）。

---

## 5. 修正内容（最小・製品コード1関数のみ）

変更したのは `public/index.html` の `flushOutbox()` **1関数だけ**。
送信可否の判定・送信順序・削除条件・保存内容には**一切触れていない**。

### FIX-1: 再入ガード

```js
if (flushOutbox.inFlight) return;
flushOutbox.inFlight = true;
try { /* 既存の中身そのまま */ } finally { flushOutbox.inFlight = false; }
```

`loadAll()` に入れたものと同じ。実行中のtickは捨てる。
`finally` で必ず戻すので、途中で例外が出ても二度と動かなくなることはない。

### FIX-2: 連続リモート失敗での打ち切り

```js
var CONSECUTIVE_REMOTE_FAILURE_LIMIT = 3;
var consecutiveRemoteFailures = 0;
...
  if (!result || result.remote !== true) {
    consecutiveRemoteFailures++;
    if (consecutiveRemoteFailures >= CONSECUTIVE_REMOTE_FAILURE_LIMIT) break;
    continue;
  }
  await lcDelete('outbox', item.key);
  sentCount++;
  consecutiveRemoteFailures = 0;
} catch (err) {
  consecutiveRemoteFailures++;
  if (consecutiveRemoteFailures >= CONSECUTIVE_REMOTE_FAILURE_LIMIT) break;
}
```

全itemは同じ kv_store エンドポイントへ送っている。連続で失敗しているなら続けても結果は同じで、
得られるものが無いまま件数ぶんのリクエストだけが増える。そこでその回は打ち切る。

**打ち切りは「連続」失敗のときだけ**である点が重要で、成功が1件でも挟まれば
カウンタは0へ戻る。したがって「1件だけ送れないitemがあると後続が送れなくなる」ことは起きない
（回帰テストで30件中3件目だけ失敗させ、残り29件が送信されることを確認済み）。

打ち切ってもitemは**1件も消さず・書き換えず**、次のtickでまた先頭から試すので、
リモートが復旧すれば全件そのまま送信される（回帰テスト I で確認済み）。

### 実装上の注意（新しいモジュール変数を作っていない理由）

再入フラグは関数オブジェクト自身（`flushOutbox.inFlight`）に持たせ、
打ち切り上限は関数内のローカル変数にした。
既存の回帰テスト群は `flushOutbox` の関数ソースだけを `vm` へ載せて実行する方式のため、
モジュールスコープに新しい `var` を足すと、それらのテスト環境で ReferenceError になる。
また関数を2つに分割することもできない（テストが抽出するのは `flushOutbox` 1つだけのため）。

---

## 6. 修正前 request 数

前提: StampStore 129室ぶんが送信可能itemとして送信キューに滞留、リモートは500。

| 単位 | `select=id` | 合計 kv_store request |
|---|---|---|
| flush 1pass | **129** | 129（500なのでPATCH/POSTまで到達しない） |
| 5秒 | **129〜（多重化すると258, 387…）** | 同左 |
| 259件のとき 1pass | **259** | 259 |

実測（2026-08-22 実Safari）: 無操作5秒で100件超。上記と整合する。

---

## 7. 修正後 想定 request 数

| 状況 | `select=id` / 1pass | 備考 |
|---|---|---|
| リモート落ち・129件滞留 | **3** | 連続3回失敗で打ち切り |
| リモート落ち・259件滞留 | **3** | 件数に依存しない |
| tickが3回重なった | **3** | 再入ガードで2回目以降は即return |
| オフライン | **0** | 従来どおり試行しない |
| 送信先不明itemだけ132件 | **0** | 従来どおり hold（Phase 1E-0） |
| リモート正常・129件滞留 | 129 | **これは正常な保存の送信**であり storm ではない。送り切れば outbox が空になりタイマーが停止する |

回帰テストの実測値: 129件でも259件でも **3**（テスト N-2 / A / B）。
同じ条件で修正前の参照実装は **129**（テスト N-1）。

---

## 8. loadAll への影響

**無し。**

- `index.html` の `loadAll()` / `loadAllInner()` / `readRoomValuesBulk()` は1文字も変更していない。
- `stamp_store.js` の `loadAll()` も1文字も変更していない。
- `request_storm_fix_verify.js`（70/70）と `stampstore_request_storm_fix_verify.js`（57/57）が
  変更前と同じくPASS。
- 新テストの C で、129件の復元がリモート通信 **1回**のままであることを再確認済み。

---

## 9. migrateLegacyKeys への影響

**意味・対象・順序ともに変更無し。**

- `stamp_store.js` は今回1文字も変更していない。
- 旧キー（`fireflow-stamp:<部屋>`）は削除しない。テスト J-8 でソース検査として固定。
- legacy自動割当を増やしていない。propertyIdを勝手に付けていない。
- migration が出す書き込み（`adapters.set`）そのものは減らしていない。
  減らしたのは**その書き込みが失敗したあとの再送**だけである。
- 新テストの D で、legacy prefix の読み取りもまとめ取り1回のままであることを確認済み。

---

## 10. 保存への影響

**最終保存内容は修正前と完全一致する。**

回帰テスト E で、リモート正常時に

- 送信可能stamp（A物件40件） + 別物件stamp（B物件20件） + binder + 送信先不明の旧item3種

という混在fixtureを流し、**修正前の実装（テスト内に独立して書き起こした参照実装）**と

- リモートへ入った行（property_id / key / value / shared）
- 送信キューに残ったitem

の両方が完全一致することを確認した。期待値をベタ書きしていないので
「期待値を新実装に合わせたから通った」は原理的に起こらない。

点検済み / 不在 / キャンセル / サイン / 時刻 / stamp値 / room状態 は、
いずれも `item.value` の中身として素通しされるだけで、今回の修正は触れていない。

---

## 11. offline への影響

**変更無し。**

- `if ('onLine' in navigator && !navigator.onLine) { updateSyncBadge(); return; }` は従来のまま、
  再入ガードより**前**に置いてある（オフライン時にフラグが立ちっぱなしにならない）。
- 打ち切ってもローカル（IndexedDB cache）には値が残る。テスト H で、
  リモート失敗中に `readValueFromLocalCache()` から値を読めることを確認済み。
- 打ち切りが「1件ずつのremote retryへ戻る」ことは無い。テスト H で
  `GET select=value`（1件取得）が0件であることを確認済み。
- オンライン復帰後、繰り返しのtickで129件すべてが送信され、outboxが0件になることを
  テスト I で確認済み（**恒久停止しない**）。

---

## 12. outbox への影響（Phase 1E-0を壊していないこと）

**仕様変更なし。** Phase 1E-0 の判定コードには1文字も触れていない。

| 項目 | 結果 |
|---|---|
| propertyId無し旧outbox → 送信0 | 維持（テスト G/J: 132件で kv_store request **0**） |
| propertyId無し旧outbox → 削除0 | 維持（132件すべて残存） |
| propertyId無し旧outbox → 書換0 | 維持（132件が1バイトも変わらない） |
| flush時の currentPropertyId フォールバック | 引き続き**存在しない**（テスト J-4 でソース検査） |
| 送信先は item.propertyId のみ | 維持（テスト F: A物件のstampはB表示中でもAへだけ入る） |
| propertyId 自動付与 | **0**（テスト K） |
| 送信できなかったitemの削除 | **0**（テスト J-5: `lcDelete` は成功後の1箇所だけ） |
| 既存 `phase1e0_outbox_property_safety_verify.js` | 110/110 PASS（変更前と同じ） |

---

## 13. legacy への影響

**差分0。**

- `stamp:<物件名>:<部屋番号>` と `fireflow-stamp:<部屋番号>` の両方を送信キューに持つ
  fixture（実端末132件相当）で、送信0 / 削除0 / 書換0 を確認（テスト G/J）。
- 旧キーの削除・propertyId付与・自動割当の拡大は行っていない。

---

## 14. 変更ファイル

| ファイル | 変更 | 行数 |
|---|---|---|
| `public/index.html` | `flushOutbox()` に再入ガードと連続失敗打ち切りを追加（+説明コメント） | 実処理 +12 / コメント +32 |
| `package.json` | `test:release` に新テストを1本追加 | 1行 |
| `public/test/outbox_request_storm_fix_verify.js` | **新規**。今回の回帰テスト | 新規 |
| `docs/FireFlow_Outbox_RequestStorm_Fix_2026-08-22.md` | **新規**。本ドキュメント | 新規 |

**この実行で触っていないもの**（開始前の未コミット差分はすべて保護されている）:
`public/stamp_store/stamp_store.js` / `public/supabase-integration.js` /
`public/test/request_storm_fix_verify.js` / `public/test/stampstore_request_storm_fix_verify.js` /
`public/test/phase1e_a1_current_property_persist_verify.js` / `test/unit/lb/*` / `schema.sql` / `docs/` の既存分。

---

## 15. 新規テスト

`public/test/outbox_request_storm_fix_verify.js`（**59項目 PASS**）

`index.html` の実ソースを文字列抽出して `vm` で実行する既存方式。
フェイクの `window.storage` は、**実際に飛ぶ PostgREST リクエストの形**を1本ずつ記録するので、
「関数呼び出しは減ったが通信は減っていない」を見逃さない。

| 要求 | 対応する検査 | 実測 |
|---|---|---|
| A. 129 stampで129回にならない | A（`null`/`throw` 両モード） | 129 → **3** |
| B. 259 stampでも259回にならない | B（同上） | 259 → **3** |
| C. loadAll後に1件ずつ存在確認が発生しない | C | remote通信 **1回**、`key=eq.stamp:*` **0件** |
| D. migrateLegacyKeys経路でもN+1にならない | D | まとめ取り **1回** |
| E. 保存結果が旧実装と一致 | E（参照実装との突き合わせ） | 行61件・残item3件が完全一致 |
| F. 別物件stamp混入0 | F | B物件への行 **0** |
| G. legacy扱い差分0 | G/J | 132件で送信0・削除0・書換0 |
| H. remote error時local復元 | H | ローカルから復元可・1件GETへ戻らない |
| I. offline差分0 | I | request 0・復帰後は全件送信 |
| J. outbox差分0 | G/J, J-5, J-6 | `lcDelete` 1箇所・`lcPut` 0箇所 |
| K. propertyId自動付与0 | K | `propertyId === undefined` のまま |
| L. 既存StampStore unit test全PASS | 第16節 | PASS |
| M. `request_storm_fix_verify` もPASS | 第16節 | 70/70 PASS |
| N. 実測URL形状の再現と消滅 | N-1 / N-2 | 修正前 **129本**を再現 → 修正後 **3本** |

加えて:

- **再入ガード**: flushを3回重ねて呼んでも `select=id` が3本のまま（多重化しない）。
- **打ち切りの安全性**: 30件中3件目だけが失敗する item-specific なケースで、
  残り29件が正しく送信され、失敗した1件だけがキューに残る。
- **J-1 ソース検査**: `window.storage.set` の既存行検索が
  `select → property_id → key → shared → owner_id` の順であることを固定。
  実測URLとフェイクの対応が崩れたらテストが落ちる。

---

## 16. 全テスト結果

| コマンド | 結果 |
|---|---|
| `npm run test:release` | **PASS（14スイート全部）** |
| `npm run test:unit` | **ALL PASS** |
| `npm run typecheck` | **PASS（exit 0）** |
| `npm run build` | **PASS** |

```
index_html_phase1_fix_test                    PASS (29/29)
phase1a_property_id_verify                    PASS (49/49)
phase1b_property_state_reset_verify           PASS (76/76)
phase1c_property_scope_verify                 PASS (151/151)
outbox_no_data_loss_verify                    PASS (78/78)
phase1e0_outbox_property_safety_verify        PASS (110/110)
phase1e_a1_current_property_persist_verify    PASS (142/142)
request_storm_fix_verify                      PASS (70/70)
stampstore_request_storm_fix_verify           PASS (57/57)
outbox_request_storm_fix_verify               PASS (59/59)   ← 新規
phase1d_property_scope_migration_dry_run      PASS (94/94)
phase1d_real_device_dryrun_page_verify        PASS (64/64)
apply_confirmed_to_lb_test                    PASS (13/13)
normalize_test                                PASS (30/30)
```

**既存テストの期待値は1件も書き換えていない。**
新テストを1本足しただけで、既存の12スイートは変更前と同じ件数でPASSしている。

---

## 17. dev server 配信確認

```
curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/            → 200
curl -s http://localhost:3000/ | grep -c "flushOutbox.inFlight"          → 3
curl -s http://localhost:3000/ | grep -c "consecutiveRemoteFailures"     → 6
curl -s http://localhost:3000/ | grep -c "readRoomValuesBulk\|loadAllInFlight" → 9
curl -s http://localhost:3000/supabase-integration.js | grep -c listValues     → 1
```

→ 今回の修正も、前回までの request storm 修正も、**配信物に入っている**。

**重要（前回監査から継続）**: これらの修正は依然として **未コミット**であり、
`origin/main` = Vercel本番 = `d763189` には入っていない。
**確認は必ず `localhost:3000` で行うこと。** 本番URLでは修正前のコードが動く。

---

## 18. 実ブラウザ確認手順（所要2分）

1. Safari で **`http://localhost:3000`** を開く（本番URLでは意味がありません）。
2. Web インスペクタ → **ネットワーク** → 履歴を削除。
3. **5秒、何も触らずに待つ。**
4. `kv_store` のリクエスト件数を見る。
   → **10件前後なら成功。** 100件以上出ていたら失敗。
5. `kv_store` のリクエストを1件クリックしてURLを見る。
   → **`select=id` + `key=eq.stamp:...` の連打が消えていること。**
   （`select=key,value` + `key=like....%` が1秒に数件なら、それが正常な状態です）
6. 赤い **500 が0件**であること。
7. 部屋カードが正常に表示されていること（129室すべて）。
8. ページを再読込して、7 が変わらないこと。

うまくいかない場合に教えていただきたいのは、
**`kv_store` のリクエストを1件クリックして得られるURLの `?` 以降**だけです。

---

## 19. git diff

```
 M package.json                                        (test:release に1本追加)
 M public/index.html                                   (flushOutbox のみ)
?? public/test/outbox_request_storm_fix_verify.js      (新規テスト)
?? docs/FireFlow_Outbox_RequestStorm_Fix_2026-08-22.md (本ドキュメント)
```

開始前からあった未コミット差分（Phase 1E-A1 / request storm STEP A/B / StampStore 前回修正 /
関連docs / `public/test/_probe_sbjs_eval.js` など）は**すべてそのまま保護されている**。
rollback・削除は1件も行っていない。

`git add` / `commit` / `push` は禁止操作のため未実施。

---

## 20. 次の行動

### 今夜PCの前で

1. 第18節の実ブラウザ確認（`localhost:3000`、2分）。
2. 通っていれば、**working tree を commit → push**。
   これで `origin/main` にも request storm 修正一式（loadAll / StampStore / outbox の3件）が入り、
   Vercel本番の 258 GET/秒 も同時に解消する。
   ※ 現状、本番URLは3件とも未適用のままです。

### 残る課題（今回の対象外）

- **kv_store 500 そのもの**は未解決（`FireFlow_Supabase_kv_store_500_Audit_2026-08-19.md`
  ROOT_CAUSE_A 未確定）。今回の修正は「500が続いても storm にならない」ようにしたもので、
  500を直したわけではない。500が続く限り送信キューは滞留し続ける。
  実Supabaseのエラーボディ確認（`property_members` の RLS 再帰の有無）が次の一手。
- **`select=id` そのものを無くす案（未実施・提案）**:
  `window.storage.set` の「SELECT してから UPDATE / INSERT」を
  「UPDATE ... `.select('id')` して、0行なら INSERT」へ変えると、既存行の保存が
  2リクエスト → 1リクエストになり、実測URLの形（`select=id` の GET）自体が消える。
  ただしこれは stamp 専用ではなく**全キー共通の書き込み基盤**を変えるため、
  今回の「最小修正」からは外した。
  実施する場合、`phase1a_property_id_verify.js:129` と
  `phase1e_a1_current_property_persist_verify.js:542` の**ソース文字列の期待値**を
  更新する必要がある（どちらも「set経路が property_id でスコープしていること」を
  検査する項目で、意図は変わらない）。既存期待値の変更を伴うため、別タスクとして
  明示的に判断すること。
- **`reloadStampStoreForCurrentProperty()` の再入ガード**（前回監査 FIX-3）は未実施。
  今回の storm の原因ではなく、`loadAll` のまとめ取り化で影響が小さいため見送った。

### Phase 1E-A1

第18節の実ブラウザ確認が通るまで **停止継続**。

---

VERIFY_REAL_BROWSER
