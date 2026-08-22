# FireFlow / Live Board StampStore 残存 request storm 完全修正（2026-08-22）

## 0. 判定

**STAMPSTORE_STORM_PARTIAL**
（コード修正・全テストPASS・dev server配信確認まで完了。実ブラウザ確認だけが未実施のため PARTIAL）

---

## 1. FIRST_BREAK

```
index.html  seedDemoState()                       ← ここが最初の呼び出し元
  → stampStore.putMany(デモ予定情報 129室)
    → adapters.set(keyFor(room), JSON)            （StampStoreのアダプタ結線）
      → storageSet(key, value, true)
        → window.storage.set(...)                （supabase-integration.js:440）
          → GET select=id&property_id=eq.<uuid>
               &key=eq.stamp:コスモ六甲ガーデンフォート:113
               &shared=eq.true&owner_id=is.null   ← 実ブラウザで観測されたURLそのもの
          → PATCH / POST                          （2リクエスト目）
```

`seedDemoState()` は起動ゲートで「デモを開く」を選んだときに呼ばれる
（`index.html` の `demoBtn.onclick` と、自動テスト用の `lb_test_force_demo_boot` 経路）。

**推測ではなく実コードで確定させた方法**：`index.html` / `stamp_store.js` の実ソースを
Node.js の vm へ載せ、`window.storage` を PostgREST のクエリ文字列ごと記録するフェイクに
差し替えて計測した。実ブラウザで観測されたURLと**1文字も違わない文字列**が再現された。

```
[1回目のseedDemoState] 総リクエスト: 258 / select=id + key=eq.stamp:* : 129
  例: GET select=id&property_id=eq.<uuid>&key=eq.stamp:コスモ六甲ガーデンフォート:113&shared=eq.true&owner_id=is.null
```

実測された部屋番号 113 / 102 は、どちらも `index.html` 冒頭のデモ `STAMP_DATA` に含まれる
（113 = 10:30、102 = 14:30）。物件名も同じ「コスモ六甲ガーデンフォート」。
つまり見えていたのは**デモ予定情報129室の書き戻し**であり、読み込みではない。

---

## 2. ROOT_CAUSE

**`putMany()` が「内容が1バイトも変わっていない再保存」でも必ず1件ずつ保存先へ送り、
その1件ごとに remote existence check（`select=id`）が出る。書き込みの通信が部屋数に比例する。**

- デモ予定情報はファイル冒頭のハードコード値なので、**毎回まったく同じ内容**である。
- それでも「デモを開く」たびに 129室 ×（`select id` ＋ `update/insert`）= **258リクエスト**。
- kv_store が 500 で落ちていると、その129件がそのまま送信キューへ積まれ、
  5秒ごとの再送でさらに積み上がる（＝「Network履歴を削除して数秒放置で100件以上」）。

---

## 3. `select=id` の発火元 一覧（public配下 全数検索）

| # | 場所 | 何の`select=id`か | stamp:* を出すか | 今回の扱い |
|---|------|------------------|-----------------|-----------|
| 1 | `supabase-integration.js:440` `window.storage.set` | 書き込み前の既存行検索（手動upsert） | **出す（実測URLはこれ）** | 呼ぶ回数を減らした（この関数自体は不変） |
| 2 | `supabase-integration.js:367` `kvSetForProperty` | 同上（別物件あて＝outbox再送専用） | 出す（並び順が違う） | 不変（発生元の putMany 側で解消） |
| 3 | `supabase-integration.js:319` `ensureInspectionSession` | inspections の当日セッション検索 | 出さない（kv_storeですらない） | 対象外 |
| 4 | `supabase-integration.js:324` | inspections insert の戻り値取得 | 出さない | 対象外 |
| 5 | `supabase-integration.js:633` | property_invites insert の戻り値取得 | 出さない | 対象外 |

**kv_store に `select=id&key=eq.stamp:*` を出すのは 1 と 2 だけ**で、どちらも
**書き込みの前段**である。読み込み経路（`get` / `list` / `listValues`）は
`select=value` / `select=key` / `select=key,value` であり、実測URLとは形が違う。

`select=id` を出させていた**呼び出し元**（stamp:* に限る）：

| 呼び出し元 | 件数 | 状態 |
|-----------|------|------|
| `seedDemoState()` → `putMany(129室)` | 129×2 | **今回修正（本丸）** |
| `applyStampRecordsToLb()` → `putMany()`（OCR/CSV/手入力） | 変更した室数ぶん | 今回の修正で「変わった分だけ」になる |
| `migrateLegacyKeys()` → `adapters.set()` | 旧キーの室数ぶん・端末につき1度だけ | 仕様どおり（意味を変えない） |
| `flushOutbox()` の再送 | 2026-08-22の先行修正で再入ガード＋連続失敗打ち切り済み | 維持 |
| `StampStore.loadAll()` | **0**（2026-08-22の先行修正で一括取得済み） | 維持 |

---

## 4. 修正内容（最小）

変更したのは `public/stamp_store/stamp_store.js` の `putMany()` と、そこから切り出した
`writeRecords()` **だけ**。新しい保存層もアダプタも増やしていない。

1. `putMany()` は受理判定とメモリ（正本）への反映を**従来どおり同期**で行う
   （呼び出し元 `applyStampRecordsToLb()` は直後に同期で `syncStampDataFromStore()` を
   呼ぶため、ここを非同期化すると画面に出なくなる）。
2. 実際に保存先へ送るのは `writeRecords()` へ移した。既にある一括取得
   （`adapters.getMany` → `storageListValues` → kv_store の prefix **1回GET**）を
   **1回だけ**使い、「保存先に既に在る内容」と突き合わせる。
3. `updated_at` を除いて**完全一致**した分だけ送らない。1項目でも違えば従来どおり送る。
4. 送らなかった分は、保存先側の `updated_at` をメモリの正本へ揃える。
   こうしないとメモリだけが新しい `updated_at` を持ち、他の点検員が後から入れた
   本当の更新を `loadAll()` の `isNewer()` が「古い」と誤判定して取りこぼす。
5. `adapters.getMany` を持たないアダプタ（メモリ実装・既存テスト）では、比較のために
   1件ずつ読み直すと通信が部屋数に比例して元へ戻るため、**従来どおり全件送る**。

**保存判定を雑にしていない**：送らないのは「送っても保存内容が1バイトも変わらない書き込み」だけ。

---

## 5. リクエスト数（実測・vmでPostgRESTクエリ単位に計測）

| 状況 | 修正前 | 修正後 |
|------|--------|--------|
| 「デモを開く」初回（保存先が空） | 258（select=id 129） | 259（select=id 129）※新規作成なので必要 |
| **「デモを開く」2回目以降（＝実端末の状態）** | **258（select=id 129）** | **1（select=id 0）** |
| **保存済み＋kv_store 500** | **129（select=id 129）＋ outbox 129件** | **1（select=id 0）＋ outbox 0件** |
| 起動シーケンス全体（seed→復元→再送3tick） | 258+ | **3** |
| 129室 / 259室 | 129 / 259 | **0 / 0**（部屋数に比例しない） |
| `loadAll()` 単体 | 2（先行修正済み） | 2（不変） |

初回だけ +1（prefix の一括取得1回）増える。129室ぶんの行を新規作成する以上、
bulk insert API を新設しない限り129回の書き込みは避けられない。これは storm ではなく
**端末につき一度きりの正当な保存通信**であり、2回目以降は0になる。

---

## 6. 影響範囲

- **loadAll**：一切変更なし。2リクエストのまま。
- **migrateLegacyKeys**：一切変更なし。取り込み条件（現スコープ0件のときだけ）、
  取り込む部屋（MASTERに在る部屋だけ）、旧キーを削除しないこと、`source=migrated_legacy`、
  propertyId を付けないこと、すべて従来どおり。読み取りが N+1 にならないのも維持。
- **保存**：最終保存内容に差分0（`updated_at` を除く全項目を参照実装と突き合わせ）。
  記号・時刻・備考・チェック・要確認・source まで一致。キャンセル記号も維持。
  保存先から行が消えていた場合は従来どおり作り直す（取りこぼさない）。
- **offline**：オフライン／remote 500 でも 129室すべてローカル（IndexedDB）から復元。
  1件ずつのリモート再取得へは戻らない。未保存のままオフラインなら従来どおり全件を
  送信キューへ積む（データを捨てない）。
- **outbox**：仕様変更なし。Phase 1E-0（propertyId無しの旧itemは送信0・削除0・書換0）を維持。
  同じ内容の再seedで送信キューが増えなくなったぶん、stormの燃料が断たれた。
- **legacy**：差分0。自動割当を増やしていない。旧キーを削除しない。propertyId を付けない。
- **propertyId**：property scope ON でも stampキーへ自動付与しない（従来どおり）。
- **別物件**：混入0。別物件の行へ書き込みも発生しない。

---

## 7. 変更ファイル

| ファイル | 変更 |
|---------|------|
| `public/stamp_store/stamp_store.js` | `putMany()` 改訂＋`writeRecords()` / `contentWithoutUpdatedAt()` / `normalizeStoredRecord()` / `ignoreWriteError()` 新設 |
| `public/test/stampstore_seed_storm_fix_verify.js` | **新規**。今回の回帰テスト（56項目） |
| `public/test/stampstore_request_storm_fix_verify.js` | ソース検査1項目の意味を差し替え（下記§8）。他は不変 |
| `package.json` | `test:release` へ新テストを追加 |
| `docs/FireFlow_StampStore_SeedStorm_Fix_2026-08-22.md` | このドキュメント（新規） |
| `public/test/_probe_seed_demo_storm.js` | 原因特定に使った計測プローブ（削除が権限で拒否されたため残置。テストではない） |

**製品コードの変更は `public/stamp_store/stamp_store.js` の1ファイルのみ。**
`index.html` / `supabase-integration.js` は1文字も変えていない。

---

## 8. 既存テストの期待値を1項目だけ差し替えた（明示）

`public/test/stampstore_request_storm_fix_verify.js` の

> 「9. 保存側(putMany)はまとめ取りに触れていない(load側だけの修正)」

を、次の3項目へ差し替えた。

- 保存側は1件ずつの取得（`readRecord` / `adapters.get`）へ落ちない
- 保存側が使うまとめ取りは1回だけ（部屋数に比例させない）
- 送らないと判断するのは `updated_at` 以外が完全一致したときだけ

**理由**：元の項目は「2026-08-22の**読み込み側**の修正が保存側へ波及していないこと」を
示すためのもので、当時の設計意図としては正しかった。その後の実ブラウザ検証で、
残っていた storm の発火元は読み込み側ではなく**保存側**だと確定したため、
保存側は「触らない」ではなく「1件ずつの remote existence check をやめる」必要がある。

**期待値を新実装に合わせて緩めたのではない**（緩めていれば `select=id` の件数を数える
新テストが落ちる）。保存内容そのものが変わっていないことは、
`stampstore_seed_storm_fix_verify.js` が**修正前の実装をテスト内へ独立に書き起こした
参照実装**と突き合わせて検証している。

---

## 9. テスト結果

| コマンド | 結果 |
|---------|------|
| `npm run test:unit` | PASS（全ファイル ALL PASS） |
| `npm run test:release` | PASS（15スイート／1,080項目、うち新規56項目） |
| `npm run typecheck` | PASS（exit 0） |
| `npm run build` | PASS |

新テスト `stampstore_seed_storm_fix_verify.js` は §13 A〜N を満たす：

- **A/B** 129室・259室で `select=id + key=eq.stamp:*` が件数比例しない（どちらも0件）
- **C** loadAll後に別経路から1件ずつの存在確認・1件取得が発生しない
- **D** migrateLegacyKeys経路でもN+1にならない
- **E** 保存結果が旧実装（参照実装）と一致
- **F** 別物件stamp混入0
- **G** legacy扱い差分0
- **H** remote error時ローカル復元
- **I** offline差分0
- **J** outbox差分0
- **K** propertyId自動付与0
- **L** 既存StampStore unit test 全PASS
- **M** `request_storm_fix_verify` / `stampstore_request_storm_fix_verify` /
  `outbox_request_storm_fix_verify` も全PASS
- **N** 修正前の実ブラウザURL形状 `select=id + key=eq.stamp:*` が129件出る構造を
  テストで再現し、修正後に0件へ消えることを確認

---

## 10. 実ブラウザ確認手順（PC前でやること）

1. Safari で `http://localhost:3000` を開く
2. 起動ゲートで **「デモを開く」** を選ぶ（実測時と同じ経路）
3. 開発ツール → Network の履歴を**削除**
4. **5秒、何も触らない**
5. `kv_store` のリクエスト件数を見る → **数件で止まっていること**（100件以上にならない）
6. `kv_store` のリクエストを1件クリックし、
   `select=id` ＋ `key=eq.stamp:コスモ六甲ガーデンフォート:<部屋番号>` の**連打が消えている**こと
7. 500 が **0件** であること
8. 部屋カードの記号・時刻が正常（113 = 10:30、102 = 14:30 が出る）
9. リロード後も同じで、予定情報が消えていないこと

※ 一度もデモ予定情報を保存したことがない端末では、**初回だけ**129室ぶんの書き込みが出る。
2回目以降のリロードで消えていれば正常。
