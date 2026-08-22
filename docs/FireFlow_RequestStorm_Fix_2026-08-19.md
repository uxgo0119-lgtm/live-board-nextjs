# FireFlow / Live Board — Supabase request storm 最小修正

作成日: 2026-08-19（無人実行）
基準commit: `d763189 fix: hold outbox items without resolved property id`
判定: **REQUEST_STORM_PARTIAL**（コード・テストは完了。実ブラウザ確認だけ未実施）

---

## 0. 今回のスコープ

RLS(42P17 / HTTP 500)は実Supabase側で人間操作により修正済み。今回はそこに一切触れず、
**「毎秒数百GET」だけ**を正常化した。

RLS変更・DB変更・schema.sql・migration・Phase 1E-A1続行・propertyId切替・StampStore・
UI・CSS・OCR・RoomMaster・保存データ削除・outbox変更は、いずれも行っていない。

---

## 1. FIRST_BREAK（実コードで再確認）

`public/index.html`

- `setInterval(loadAll, 1000)` … 1秒ごとのpolling発火点
- `loadAll()` は全部屋について
  - `storageGet('fireflow-binder:' + room)`
  - `storageGet('fireflow-schedule-override:' + room)`
  を部屋ごとに投げていた
- `storageGet()` は remote-first（Supabase GET → 失敗時のみIndexedDB fallback）
- `loadAll()` に**再入ガードが無い**ため、1回が1秒以上かかると次のtickが重なる

### 実測（推測ではなくコード構造から確定）

| 項目 | 値 |
|---|---|
| loadAll 1回の storageGet 回数 | `部屋数 × 2` |
| 129室での 1tick | **258 GET** |
| setInterval 周期 | 1000ms |
| 同時loadAllの可能性 | **有り**（ガード無し。遅いほど増える悪循環） |
| loadAll 呼び出し元 | `index.html:12305`（起動時1回）と `index.html:12310`（setInterval）の2箇所のみ |
| visibilitychange | `flushOutbox`/`updateSyncBadge` 用のみ存在。**pollingは非表示でも止まらない** |

### Realtime との役割重複

`public/supabase-integration.js` の `installRealtimeSync()` は `kv_store` を購読し、
`sb-realtime-update` イベント発火と `window.onRealtimeUpdate()` 呼び出しを行う。

しかし `public/index.html` 側に **`onRealtimeUpdate` も `sb-realtime-update` リスナーも存在しない**
（grep一致0件）。つまり Realtime は**発火側だけで受信側未接続**。

→ 「Realtime一本化」は今回**採用しない**。pollingは廃止せず維持する。

---

## 2. 修正内容

### STEP A: 再入ガード（新しいscheduler層は作らない）

`loadAll()` を「ガード」と「本体 `loadAllInner()`」へ分けた。

```js
var loadAllInFlight = false;

async function loadAll() {
  var panelOpen = ...;
  if (panelOpen) return;          // 既存挙動（パネル表示中は読まない）を維持
  if (loadAllInFlight) return;    // 実行中なら次tickをskip
  loadAllInFlight = true;
  try { await loadAllInner(); } finally { loadAllInFlight = false; }
}
```

- `finally` 解除なので throw しても居座らない
- 起動時 `loadAll()` / setInterval / 手動呼び出しのいずれも壊さない
- 例外は握りつぶさず呼び出し元へ伝える（挙動を変えない）

### STEP B: prefix 一括取得

`window.storage.list()` は**キーだけ**を返し値を返さないため、そのままでは
「listで1回 + 値をN回get」で通信が減らない。そこで **`list()` の値つき版**を最小追加した。

`public/supabase-integration.js`
```js
async listValues(prefix, shared, propertyId) { ... select('key,value') ... }
```
- 絞り込み条件（`property_id` / `shared` / `owner_id` / `key` の前方一致）は
  既存 `get()` / `list()` と**1文字も変えていない** → RLS・物件スコープの効き方は同じ
- 既存の `get` / `set` / `delete` / `list` は未変更
- **失敗は必ず例外**で返す（`list()` のように null で黙らない）。
  「取れなかった」と「0件だった」を呼び出し元が区別できないと、通信失敗の瞬間に
  全部屋が未点検として描画されてしまうため。

`public/index.html`
- `storageListValues(prefix, shared, opts)` … `applyPropertyScope()` を1回通す点は
  `storageGet()` と完全に同じ。取得値は `storageGet()` と同じくIndexedDBへも書き戻す。
- `readValueFromLocalCache(rawKey, shared)` … `storageGet()` のfallback部分だけを取り出したもの
- `readRoomValuesBulk(rooms, keyForFn, prefix)` … 全部屋分を取得する唯一の経路

`loadAll` 本体は次の2行になった（部屋数に関係なく通信2回）。
```js
var results = await readRoomValuesBulk(allRooms, keyFor, BINDER_KEY_PREFIX);
var overrideResults = await readRoomValuesBulk(allRooms, scheduleOverrideKeyFor, SCHEDULE_OVERRIDE_KEY_PREFIX);
```

### 旧実装との等価性（ここが今回の一線）

`readRoomValuesBulk()` の結果は、旧「部屋ごと `storageGet()`」と一致する:

| 状況 | 旧実装 | 新実装 |
|---|---|---|
| リモートに在る | リモートの値 | prefix取得の値（同じ） |
| リモートに無い | `get`が例外 → IndexedDB → 無ければnull | mapに無い → IndexedDB → 無ければnull |
| リモート自体が読めない | 全部屋 IndexedDB | 全部屋 IndexedDB |

**リモートで取れなかったキーを1件ずつ再取得しない**（それをやると通信量が元に戻る）。

### STEP C: visibilitychange — DEFER

A+Bで目標（2 GET/秒）に到達したため、指示どおり今回は入れない。独立commitへ分離可能。

---

## 3. 効果

| | 修正前 | 修正後 |
|---|---|---|
| 129室 1tick の remote GET | **258** | **2** |
| 1秒あたり | 258 GET/秒 | **2 GET/秒** |
| 部屋数依存 | `N × 2` に比例 | **部屋数に関係なく2**（258室でも2） |
| loadAll重なり | 無制限に重なる | 最大1本 |
| polling間隔 | 1000ms | **1000ms（維持）** |

polling間隔は変更していない。1tickが2リクエストまで落ちたので、現場の即時性を優先して
1秒を維持できる（指示#12の方針どおり、「とりあえず10秒」で終わらせていない）。

---

## 4. 影響範囲

- **property scope**: `applyPropertyScope()` を通る唯一経路は維持。flag OFF＝旧raw key挙動、
  ON＝スコープ済みキー。部屋への割り当ては**キーの完全一致**で行うため、prefix一致で
  引っかかる旧形式キーや他propertyIdのキーが混入しない（テストで確認済み）。
- **offline**: 維持。まとめ取りの値もIndexedDBへ書き戻すので復元元は従来どおり。
- **outbox**: 変更なし。読み込み経路は `outbox` に一切触れない（実行時にも増減0を確認）。
- **StampStore**: 変更なし。
- **UI / CSS / 保存キー形式**: 変更なし。

### StampStore 由来のremote GET（件数のみ報告・修正は別Phase）

`restoreStampDataFromStorage()` は `applyCurrentPropertyRecord()` からの
**起動時・物件切替時のみ**の呼び出しで、1秒pollingには乗っていない。
→ request storm への**毎秒の加算は0**。

### 1秒pollingに乗っている他の通信（2026-08-20 再監査 → 2026-08-22 再々監査で訂正）

`loadAll` 以外の `setInterval` を全数確認した結果、**毎秒の remote GET を出すものは無い**。

※ 2026-08-22 訂正: 初版のこの表はタイマーを4件としていたが、実際は**5件**ある
（`public/supabase-integration.js` の `inspectionSessionRetryTimer` を数え落としていた）。
下表が全数（`grep -n "setInterval(" public/index.html public/supabase-integration.js` の全一致）。
結論（毎秒の remote GET は `loadAll` の2回のみ）は変わらない。

| タイマー | 周期 | 毎tickの remote 通信 |
|---|---|---|
| `index.html:12310` `setInterval(loadAll, 1000)` | 1秒 | **2 GET**（今回の修正後） |
| `index.html:12318` `setInterval(sendPresenceHeartbeat, 20000)` | 20秒 | select + insert/update の2回（部屋数に無関係） |
| `index.html:12312` `setInterval(checkScheduledReminders, 60000)` | 60秒 | **0**（メモリ上のstateだけを見る） |
| `index.html:4360` `setInterval(flushOutbox, 5000)` | 5秒 | 未送信が0件なら**0** |
| `supabase-integration.js:337` `setInterval(ensureInspectionSession, 5000)` | 5秒 | 下記のとおり**通常0**。storm への加算なし |

`ensureInspectionSession` の再試行タイマーは、次の3点により request storm には寄与しない。
今回のスコープ（kv_store の毎秒GET）外のため**変更していない**。

- **成功するまで作られない**：`catch` の中でしか `setInterval` を張らない（`if (!inspectionSessionRetryTimer)` で二重起動も防止）
- **成功したら自分で止まる**：`clearInterval` してから `inspectionSessionRetryTimer = null` にする
- **走っている間も対象が違う**：叩くのは `inspections` テーブルで **`kv_store` ではない**。しかも
  `if (currentInspectionId) return` で即抜けるため、確立済みなら通信0。最悪でも 5秒に1回・部屋数に無関係

`renderFloors()` は文字列組み立てだけで remote を一切読まない（`loadAll` が変化を検出した
tickでのみ呼ばれる点も従来どおり）。

`loadActiveInspectors()`（`storageList` 1回 + 点検員数ぶんの `storageGet`）は
`openProgressDetail()` からの**利用者の操作時のみ**呼ばれ、pollingには乗っていない。
※初版のこの節に「`updateProgress()` が呼ぶ」と書いていたが、`updateProgress()` という関数は
現在の `public/index.html` に存在しない（呼び出し元は `openProgressDetail()` が唯一）。
storm への毎秒の加算が0である結論は変わらない。

---

## 5. 変更ファイル

| ファイル | 内容 |
|---|---|
| `public/index.html` | 再入ガード / まとめ取り3関数 / prefix定数 / loadAll本体 |
| `public/supabase-integration.js` | `listValues` 追加（既存API未変更） |
| `public/test/request_storm_fix_verify.js` | **新規** request storm専用テスト（70項目） |
| `public/test/phase1b_property_state_reset_verify.js` | loadAll分割に追随（**期待値の変更なし**） |
| `package.json` | 新テストを `test:release` へ登録 |

### phase1b テストへ手を入れた理由（明示）

`loadAll` が「ガード + 本体」へ分かれたため、ソース抽出方式の同テストが本体を
読み込めなくなった。追加したのは **読み込む関数の追加** と **取得手段のスタブ** だけで、
**assertionは1つも書き換えていない**。むしろ `loadAllInner()` を
「storageDeleteを呼ばない」検査対象へ追加して強化している（PASS 76/76）。

---

## 6. テスト

### 新規 `request_storm_fix_verify.js`（TEST-V A〜O 全項目カバー）

値の復元については **旧実装（部屋ごとstorageGet）をテスト内に参照実装として書き起こし**、
新実装と1件ずつ突き合わせている。期待値をベタ書きしていないので
「期待値を新実装に合わせて書き換えたから通った」は原理的に起こらない。

| 項目 | 内容 | 結果 |
|---|---|---|
| A | loadAll同時実行最大1（5tick重なっても通信2回） | PASS |
| B | throw後もlock解除・次tick正常 | PASS |
| C | 129室でもbinder個別GET 0回 | PASS |
| D | 129室でもschedule override個別GET 0回 | PASS |
| E | flag OFFで復元結果差分0 | PASS |
| F | scope ONで他propertyId混入0（旧形式キー混入も0） | PASS |
| G | binder復元差分0（129室） | PASS |
| H | schedule override復元差分0（129室） | PASS |
| I | 保存無しroom初期状態差分0 | PASS |
| J | offline fallback維持（オフラインでも129室復元・追加GET 0） | PASS |
| K | outbox差分0（オンライン・オフラインとも） | PASS |
| L | StampStore差分0 | PASS |
| M | 起動時loadAll正常・他端末更新の反映維持 | PASS |
| N | 前回未完了ならtick skip | PASS |
| O | 旧258回 → 新2回（部屋数を倍にしても2回） | PASS |

### 全体（2026-08-22 に現在のワーキングツリーで再実行し、全て再現）

| コマンド | 結果 |
|---|---|
| `npm run test:release` | **全12スイート PASS**（新規 request_storm_fix_verify 70/70 含む） |
| `npm run test:unit` | **PASS**（exit 0） |
| `npm run typecheck` | **PASS**（exit 0） |
| `npm run build` | **PASS**（exit 0） |
| `npm run lint` | **未実行**。このリポジトリは ESLint 未設定で、`next lint` が対話セットアップを出して止まる。設定を入れると依存追加になるため今回のスコープ外（request storm とは無関係） |
| dev server + curl | 配信物に新経路が含まれることを確認（`/index.html` に `loadAllInFlight` / `readRoomValuesBulk` / `storageListValues`、`/supabase-integration.js` に `listValues` / `select('key,value')`） |

`test:release` 12スイートの内訳（全PASS）:
`index_html_phase1_fix_test 29/29` / `phase1a_property_id_verify 49/49` /
`phase1b_property_state_reset_verify 76/76` / `phase1c_property_scope_verify 151/151` /
`outbox_no_data_loss_verify 78/78` / `phase1e0_outbox_property_safety_verify 110/110` /
`phase1e_a1_current_property_persist_verify 142/142` / `request_storm_fix_verify 70/70` /
`phase1d_property_scope_migration_dry_run_verify 94/94` /
`phase1d_real_device_dryrun_page_verify 64/64` / `apply_confirmed_to_lb_test 13/13` /
`normalize_test 30/30`

既存期待値の書き換えは0件。

### 新実装が旧実装と等価であることの独立確認（2026-08-22）

テストとは別に、「リモートに行が無いとき」の分岐をコードで直接突き合わせた。ここが
ずれると通信は減っても画面の値が変わるため、今回の一番の急所である。

`public/supabase-integration.js:429` で `window.storage.get()` は
`if (!data) throw new Error('key not found: ' + key)` と、**行が無いとき例外を投げる**。
したがって旧実装の「リモートに無い」経路は `storageGet()` の `catch` → IndexedDB →
無ければ null。新実装は「byKey に無い」→ `readValueFromLocalCache()` → 無ければ null。
**同じ**（＝ローカルに残っている値で描画される点まで一致）。

`{ value: null } を返して黙る` 実装だった場合はここが非等価になっていたが、そうではないことを
実コードで確認済み。

---

## 7. 実ブラウザ（未実施・人間確認が必要）

1. LB起動
2. Network で `kv_store` 通信量を確認 → **1秒あたり2件程度**（従来は数百件）
3. 赤500が0
4. 1秒ごとに数百件発生しない
5. 部屋一覧 / 6. 点検済み / 7. 不在 / 8. 点検時刻変更 / 9. 不在時刻
10. reload後維持 / 11. offline入力 / 12. online復帰

---

## 8. rollback

今回の修正は単独で戻せる。`public/index.html` の `loadAll` 2行を旧
`Promise.all(allRooms.map(storageGet(...)))` へ戻し、`listValues` を使わなくすれば元通り
（`listValues` は追加APIなので残しても既存経路に影響しない）。

---

## 9. git

Phase 1E-A1 の未コミット差分（`supabase-integration.js` のpropertyId永続化、
`phase1a_property_id_verify.js`、`package.json` のtest登録、docs）は**一切rollbackしていない**。
`supabase-integration.js` は同一ファイル内に両方の差分が同居しているが、
Phase 1E-A1分は上部（`readPersistedPropertyId` 等）、今回分は下部（`listValues`）で
物理的に分かれている。

git add / commit / push は未実施（無人実行のため禁止操作）。

---

## 10. 残っているリスク（2026-08-20 再監査で追記・今回は未対応）

### R-1. PostgREST の最大行数による打ち切り（要・実環境での確認）

`listValues` は `.range()` / ページングを持たない。Supabase(PostgREST)には
`db-max-rows` という「1回のGETで返す最大行数」の設定があり、これが設定されている場合、
prefix一致の行数がその上限を超えると**エラーにならず黙って途中で切れる**。

- 今回の対象では、1つのprefixが一致する行数は **部屋数と同じ（129室なら129行）** なので
  現実的な上限（通常1000行）には届かない。**現時点で実害は無い。**
- 危険になるのは「1物件が1000室を超える」または「`db-max-rows` が極端に小さく設定される」場合。
  そのとき、超過ぶんの部屋は remote の値ではなく**ローカルキャッシュの値で描画される**
  （＝他端末の更新が反映されない部屋が出る）。旧実装（1部屋ずつGET）にはこの上限が無かったため、
  これは今回の修正で新しく入った制約である。
- 対応するなら `.range()` によるページング追加。ただし通信回数が `ceil(行数/上限)` に増えるだけで、
  1000室未満なら1回のままなので、**部屋数が1000に近づくまでは入れない**方が単純で安全。
- **実LB確認時に「129室すべてが正しく描画されるか」を見れば、この件も同時に確認できる。**

### R-2. 2回の通信が直列（軽微・意図的に未変更）

`loadAllInner()` は binder → 点検時刻変更 の順に `await` している。同時に投げれば
1tickの待ち時間が約半分になるが、通信量は変わらない（2回のまま）。挙動を変えない方を優先し、
今回は直列のままにした。1秒polling内に収まっているうちは変更する理由が無い。

---

## 11. 次のPhase

- **STEP C**（visibilitychangeでの非表示時skip）… 独立commitでいつでも追加可
- Realtime 受信側の結線（現在は発火のみ）… pollingを1秒より延ばしたくなった時の前提
- `updateProgress` 経由の `loadActiveInspectors` の通信削減
- Phase 1E-A1 の再開
