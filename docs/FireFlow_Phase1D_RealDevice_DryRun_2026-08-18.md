# FireFlow / Live Board Phase 1D — 実端末 migration dry-run（READ ONLY）

基準commit: `d99ac5e` (test: add property scope migration dry run)
実施: 2026-08-18 / **本migrationは未実行。実データ変更 0件。**

---

## 0. 結論（先に）

| 項目 | 結果 |
|---|---|
| 実端末dry-runを実データで実行できたか | **いいえ（未実施）** |
| 判定 | **REAL_DEVICE_DRYRUN_BLOCKED** |
| 本migration判定 | **STOP** |
| 実データの変更 | **WRITE COUNT = 0 / DELETE COUNT = 0**（そもそも実データへ到達していない） |
| 残り作業 | ユーザーがブラウザで測定ページを**1回開く**だけ |

**理由**: FireFlowの実保存データは**ブラウザのIndexedDB（`fireflow-lb-cache`）の中**にしか無い。
これはブラウザプロファイル内にあり、今回の自動実行セッションはリポジトリ外のファイルへアクセスできない
（`ls /Users/nagakurashoya/Library/...` が権限で拒否される）。ブラウザを起動する手段も無い。

**推測データ・fixtureで「実端末dry-run完了」とは絶対にしない**（今回のタスク指示・絶対ルール3）。
したがって §3〜§9 の実測値はすべて **未測定** であり、この文書に架空の件数は一切書かない。

代わりに、**ユーザーの手作業を1回・数十秒に圧縮する測定ページを実装した**（下記§2）。

---

## 1. なぜ無人で測定できないのか（確定事実）

1. 保存の実体は `index.html:4125` の `LC_DB_NAME = 'fireflow-lb-cache'`（IndexedDB）。
   `storageSet()` は必ず `lcPut('cache', …)` で**まずIndexedDBへ**書く（`index.html:4437`）。
2. IndexedDBはブラウザプロファイル配下（Chrome: `Library/Application Support/Google/Chrome/…/IndexedDB/`、
   Safari: `Library/Safari/Databases/___IndexedDB/…`）にあり、**オリジン単位**で分離されている。
3. 今回の実行環境はリポジトリ外の読み取りが拒否される（実測: `ls /Users/nagakurashoya/Library/Safari/Databases` → 拒否）。
4. 仮に読めても、Chrome の IndexedDB は LevelDB + Blink シリアライズ形式で、
   **ブラウザを閉じないと整合した読み取りができない**。ヘッドレスでの再実装は
   「新しいmigrationロジックを作らない」という今回の制約にも反する。
5. Supabase 側は前回ユーザー実測で `kv_store rows = 0`。**リモートには実データが無い**ため、
   Supabaseを読んでも実端末の状況は分からない（かつ今回は接続しない）。

⇒ **実データはこのMacのブラウザの中だけにある。ブラウザで開く以外に読む方法がない。**

---

## 2. 実装したもの（実端末測定ページ）

### `public/test/phase1d_real_device_dryrun.html`（新規）

Live Boardと**同じオリジン**で開くと、その端末の実データを読んで dry-run 結果を表示する。

- 判定は既存の純粋関数 `planPropertyScopeMigration()` を**そのまま呼ぶだけ**。
  画面側に新しいmigrationロジックは1行も無い（テストで機械確認）。
- `currentPropertyId` は**渡さない**。「今開いている物件だから」は D_WEAK であり単独では移行根拠にならない。

#### read-onlyの担保（規律ではなく構造で）

起動直後に以下を毒入り（呼んだら例外＋カウント）へ差し替える。

| 封じた経路 | 内容 |
|---|---|
| `IDBDatabase.prototype.transaction` | `readonly` 以外を要求した時点で例外。既定値も `readonly` へ固定 |
| `IDBObjectStore.prototype.put/add` | 呼んだ時点で例外（WRITE COUNT++） |
| `IDBObjectStore.prototype.delete/clear` | 呼んだ時点で例外（DELETE COUNT++） |
| `indexedDB.deleteDatabase` | 例外 |
| `localStorage.setItem/removeItem/clear` | 例外 |
| `fetch` / `XMLHttpRequest.open` / `sendBeacon` | 例外（Supabaseへ一切出さない） |

さらに **DBを新規作成しない**配慮を入れてある。
`indexedDB.open()` は存在しないDBを**作ってしまう**（＝書き込み）ため、
先に `indexedDB.databases()` で存在を確認し、無ければ **open せずに BLOCKED を返す**。
`open()` に version を渡さない（upgradeさせない）。万一 `onupgradeneeded` が発火したら
`transaction.abort()` で中断する。

そのうえで **dry-run の前後にIndexedDBを2回読み直し**、全レコードの指紋
（`key | 値のFNV-1aハッシュ | updatedAt`）一覧が完全一致することを確認する。
1件でも違えば **`REAL_DEVICE_DRYRUN_UNVERIFIED`** へ倒す。

#### 出力（そのまま報告に使える）

`contamination.detected` と理由 / status別件数 / outbox status別件数 / domain別件数 /
propertyId evidence別件数（A・B・C・D・E）/ MIGRATABLE・AMBIGUOUS・UNKNOWN_PROPERTY・COLLISION・INVALID
の一覧 / StampStore件数（対象外・件数のみ）/ WRITE COUNT / DELETE COUNT / 前後件数と一致判定 /
`REAL_DEVICE_DRYRUN_*` 判定 / 本migration判定。

**報告用JSONには実データの値そのものを含めない**（キーと分類だけ。テストで確認）。
「レポート全文をコピー」ボタン1つでクリップボードへ入る。

#### 判定の出し方（画面が自動で決める）

| 条件 | dry-run判定 | 本migration判定 |
|---|---|---|
| WRITE/DELETE/送信が0でない、または前後が不一致 | `REAL_DEVICE_DRYRUN_UNVERIFIED` | STOP |
| D_WEAK / E_UNKNOWN 根拠だけで MIGRATABLE になった項目がある | `REAL_DEVICE_DRYRUN_UNVERIFIED` | STOP |
| DBが無い / `indexedDB.databases()` 非対応 / 他タブがDBを掴んでいる | `REAL_DEVICE_DRYRUN_BLOCKED` | STOP |
| contamination検出 or AMBIGUOUS / UNKNOWN_PROPERTY / COLLISION が1件以上 | `REAL_DEVICE_DRYRUN_AMBIGUOUS` | STOP |
| 上記すべて無し・MIGRATABLE ≥ 1 | `REAL_DEVICE_DRYRUN_PASS` | `MIGRATION_EXECUTION_CONDITIONAL_GO` |
| 上記すべて無し・MIGRATABLE = 0 | `REAL_DEVICE_DRYRUN_PASS` | STOP（移行する意味がない） |

**無条件の `MIGRATION_EXECUTION_GO` はこの画面から出ない**（設計書§6のkv_store旧key行の扱いが
未確定である以上、最良でも CONDITIONAL_GO 止まりであるべきため）。テストで固定している。

### `public/test/phase1d_real_device_dryrun_page_verify.js`（新規・PASS 64/64）

この画面が実データに触る以上、「気をつけて書いた」では足りないので機械確認する。

1. 画面のコードに書き込み・削除・送信APIの**呼び出しが存在しない**（毒入り代入だけは許す）
2. `.transaction()` の呼び出しが**すべて `readonly` 指定**
3. `indexedDB.databases()` で先に存在確認し、`open()` に version を渡していない
4. 判定は既存の純粋関数のみ。本migration実行機能・status/evidence語彙の再定義が無い
5. DB名・objectStore名が製品（`index.html`）と一致
6. **最小のDOM/IndexedDBスタブ上で画面のスクリプトを実際に走らせ**、
   例外なく描画できること・WRITE/DELETE=0を自力で申告すること・件数が純粋関数の結論と
   一致すること（画面が数え間違えていないこと）を確認。スタブ側の保存APIも毒入りなので、
   画面が書こうとしたらテストが落ちる。

---

## 3. 実測項目（**すべて未測定**）

以下は測定ページを開くと自動で埋まる。今回は実データへ到達していないため、**空欄のままにする**。

| 項目 | 値 |
|---|---|
| contamination.detected | 未測定 |
| contamination理由（orphan room / orphan equipment / 複数propertyId / 現物件レコード不整合） | 未測定 |
| MIGRATABLE / ALREADY_MIGRATED / COLLISION / AMBIGUOUS / UNKNOWN_PROPERTY / INVALID / SKIPPED_* | 未測定 |
| outbox: NEEDS_USER_ASSIGNMENT / ALREADY_SCOPED / MIGRATABLE / INVALID | 未測定 |
| domain別（current / binder / scheduleOverride / equipment / ext / buildingNotes / boTable / progressLog / siteSupervisor / scheduleDays / equipmentList / documents / presence / outbox / StampStore） | 未測定 |
| evidence別（A_STRONG / B_STRONG / C_CONDITIONAL / D_WEAK / E_UNKNOWN） | 未測定 |
| dry-run前後のデータ変更有無 | 未測定（到達していない） |

**WRITE COUNT = 0 / DELETE COUNT = 0**（実データへ一切到達していないため自明）。
Supabaseへの接続・読み取り・書き込みも 0件。

---

## 4. ユーザーの手作業（1回だけ・所要30秒）

前提: Live Boardを**普段使っているURLと同じオリジン**で開くこと。
IndexedDBはオリジン単位で分離されているため、`localhost:3000` と本番URLでは**中身が別**。

1. **Live Boardのタブをすべて閉じる**（DBを掴んでいると読めない場合があるため）
2. ターミナルで `npm run dev` を起動（ローカルの実データを見る場合）
3. 普段Live Boardを使っているブラウザで次を開く
   - ローカルで使っている場合: `http://localhost:3000/test/phase1d_real_device_dryrun.html`
   - 本番URLで使っている場合: `https://<本番ドメイン>/test/phase1d_real_device_dryrun.html`
4. 表示された **「レポート全文をコピー」** を押す
5. コピー内容をそのままClaude Codeへ貼る

**「このオリジンに実データがありません」と出た場合**は、画面がその端末に存在するDB名を
一覧表示するので、その表示ごと貼ればよい。**もう片方のオリジン（ローカル⇔本番）でも
同じ手順を1回試す**と、実データがどちら側にあるか確定する。

この画面は本migrationを実行する機能自体を持っていないので、何度開いても実データは変わらない。

---

## 5. 本migrationを実行してよいか

**STOP。** 設計書 `FireFlow_Phase1D_PropertyScopeMigration_DryRun_2026-08-18.md` §9 のGATEのうち、
1（実端末dry-runの実測）が未充足のまま。実測前にGOは出さない。

### 実行前に人間の判断が必要な項目

1. **実端末dry-runの実測**（§4の1回の操作）← これが無いと他は判断できない
2. `contamination.detected === true` だった場合、部屋単位データは自動移行対象外。
   物件割当UI（Phase 1E相当）を先に作るか、混在を承知で現物件へ寄せるかの判断
3. COLLISION が1件でも出た場合の解決方針（どちらの値を正とするか）
4. kv_store 旧key行の扱い（設計書§6・未解決）。本migrationは kv_store 上では
   rename ではなく「新keyでinsert → 旧key行が残る」になり、**行数が最大2倍**になる。
   残す期間と削除条件を先に決める必要がある
5. 旧キーの削除時期（推奨: 最低1点検サイクルは残す。Phase 1C flag OFF時の読み取り先そのものであり、
   消すとrollback先が無くなる）

---

## 6. 変更ファイル

| ファイル | 内容 |
|---|---|
| `public/test/phase1d_real_device_dryrun.html` | 新規。実端末read-only測定ページ |
| `public/test/phase1d_real_device_dryrun_page_verify.js` | 新規。上記の静的検査＋スタブ実行検証 64件 |
| `package.json` | `test:release` へ1行追加 |
| `docs/FireFlow_Phase1D_RealDevice_DryRun_2026-08-18.md` | 本書 |

**製品コード（`public/index.html` / `public/supabase-integration.js` /
`public/property_scope_migration.js` / `public/stamp_store/stamp_store.js` / `supabase/schema.sql`）は差分0。**
実データ・DB・outbox・StampStoreの変更も0件。
