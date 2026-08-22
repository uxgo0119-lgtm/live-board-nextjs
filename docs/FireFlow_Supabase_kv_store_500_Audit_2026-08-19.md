# Supabase kv_store 大量500エラー 監査報告（2026-08-19）

read-only監査。製品コード・test・schema.sql・DBのいずれも変更していない。
基準commit: `d763189` / 対象: 現在のワーキングツリー（Phase 1E-A1 未コミット差分あり）。

---

## 1. 判定

- **SUPABASE500_PARTIAL**
- **SUPABASE500_PREEXISTING**

ROOT_CAUSE_B（大量発生の原因）は**確定**。
ROOT_CAUSE_A（1リクエストが500になる原因）は**未確定**（実Supabaseへのread-only確認が
この実行環境では拒否されたため、サーバ側エラーコードを取得できていない）。

Phase 1E-A1起因ではない（下記2で機械的に証明）。

---

## 2. Phase 1E-A1との因果 → 無関係（PREEXISTING）

### 2-1. A1差分はGET queryに一切触れていない

`git diff d763189 -- public/supabase-integration.js` の内容は次だけ。

- `CURRENT_PROPERTY_STORAGE_KEY = 'lb_current_property_id'` の追加
- `readPersistedPropertyId()` / `persistPropertyId()`（localStorageのみ）
- `setCurrentPropertyId()` の中に `persistPropertyId()` を1行追加
- 起動時復元IIFE `restorePersistedPropertyIdAtStartup()`

`sb.from('kv_store')` を組み立てる箇所（`window.storage.get/set/delete/list`、
`kvGetForProperty` 等、supabase-integration.js:353-461）は**1文字も変更されていない**。
`select` / `property_id` / `key` / `shared` / `owner_id` の各filterはA1前後で同一。

### 2-2. さらに、A1は現ビルドでは実行時no-op

`setCurrentPropertyId` の呼び出し元を全走査した結果:

| 場所 | 内容 |
|---|---|
| supabase-integration.js:107 | 定義 |
| supabase-integration.js:115 | `window.setCurrentPropertyId` として公開（index.htmlからの呼び出しは0件） |
| supabase-integration.js:131 | `restorePersistedPropertyIdAtStartup()` 内の唯一の呼び出し |

`lb_current_property_id` へ**書き込む唯一の経路**は `persistPropertyId()` であり、
それを呼ぶのは `setCurrentPropertyId()` だけ、さらにそれを呼ぶのは「保存済みの値を復元する
関数」だけ。つまり **一度も保存されないので一度も復元されない**（物件切替UIがまだ無いため）。

結果として `currentPropertyId` は常に `INITIAL_PROPERTY_ID`
= `b6e18eed-f2f3-4674-812d-322732908616` のまま。
実ブラウザで観測された500のURLの `property_id` もこの値であり、一致する。

→ **Phase 1E-A1は500の原因になり得ない。** 復元前後でproperty_idは同じ。

### 2-3. Phase 1Cの別物件経路も無関係（URLパラメータ順で確定）

観測URL:

```
select=id&property_id=eq.<uuid>&key=eq.fireflow-binder%3A1304&shared=eq.true&owner_id=is.null
```

| 経路 | 生成されるパラメータ順 | 一致 |
|---|---|---|
| `window.storage.set`（現在物件）supabase-integration.js:418-419 | select, property_id, key, shared, owner_id | **一致** |
| `kvSetForProperty`（Phase 1C 別物件）supabase-integration.js:367 | select, key, shared, property_id, owner_id | 不一致 |

→ 失敗しているのは**従来からの現在物件経路**であり、Phase 1C/1E-0/1E-A1で追加された
別物件経路は関与していない。

---

## 3. FIRST_BREAK

**Supabaseサーバ側**。クライアント側ではない。

根拠:
- supabase-js は 500 を自分で作らない（ネットワーク失敗はJS例外、
  PostgRESTは列不正→400、テーブル不在→404、認証→401/403にマップされる）。
- `.maybeSingle()` はGETでは `Accept: application/json` を使い、行数チェックはクライアント側
  （PGRST116）。406/500の原因にならない。

→ FIRST_BREAK = `GET /rest/v1/kv_store` を受けた Supabase 側（PostgREST / Postgres / gateway）
がHTTP 500を返した時点。クライアントは正しいクエリを送っている。

---

## 4. ROOT_CAUSE_A（なぜ1リクエストが500なのか）→ **未確定**

実Supabaseへのread-only確認（curl）がこの実行環境で拒否されたため、
**PostgRESTのエラーボディ（code / message / hint）を取得できていない = INSUFFICIENT_EVIDENCE。**

確定できた切り分けだけ記す。

| 仮説 | 判定 |
|---|---|
| key encoding（`:` / 日本語）が原因 | **否定**。ASCIIのみの `fireflow-binder:1304` でも500（下記10） |
| 列依存（`select=id` / `select=value`） | **否定**。両方500 → projectionではなく行アクセス層の問題（下記11） |
| Phase 1E-A1 / Phase 1C差分 | **否定**（上記2） |
| クライアント側のクエリ組み立て不正 | **否定**（上記3） |

残る候補（順不同、いずれも未検証）:

- **H1: リソース枯渇 / レート制限** — ROOT_CAUSE_B の秒間2N件のリクエスト嵐によって
  PostgRESTのコネクションプールやSupabase gatewayが飽和。
  「ボディが取れない500」はPostgREST（JSONボディを返す）より
  gateway由来のエラーに特徴が近い。**嵐の実在は確定しているので、この仮説の前提は成立している。**
- **H2: 実DBのRLSポリシー不整合（schema.sqlとのdrift）** — 特に2026-07-17以前の
  自己参照版 `property_members` SELECTポリシーが実DBに残っている場合、
  `42P17 infinite recursion detected in policy` → PostgRESTは500を返す。
  kv_storeのポリシーは `exists (select 1 from property_members ...)` を経由するため、
  **key・列・物件に関係なく全kv_storeリクエストが500になる**。
  ユーザー実測の「kv_store rows = 0」（＝writeが一度も成功していない）とも整合する。
  ただし**現在のschema.sqlは再帰していない**（下記7）ので、これは実DBのdriftを要する。
- **H3: プロジェクト側の状態異常**（一時停止・quota超過・再起動中）。
  通常は503/540になるため優先度は低い。

**H1とH2は排他ではない。** ただしROOT_CAUSE_Bは確定事実であり、
どちらが真でも先に潰す価値がある。

---

## 5. ROOT_CAUSE_B（なぜ大量に発生するのか）→ **確定**

### `public/index.html:12210`

```js
setInterval(loadAll, 1000);
```

`loadAll()`（index.html:8180-8237）は毎回:

```js
var results = await Promise.all(allRooms.map(function(room) {
  return storageGet(keyFor(room), true).catch(function() { return null; });          // fireflow-binder:<room>
}));
var overrideResults = await Promise.all(allRooms.map(function(room) {
  return storageGet(scheduleOverrideKeyFor(room), true).catch(function() { return null; }); // fireflow-schedule-override:<room>
}));
```

- 部屋数 N に対し **1秒ごとに 2N 件** の `kv_store` GET が飛ぶ。
  組み込みデモ物件は `TOTAL_ROOMS = 129` → **258 req/秒**。
  実ブラウザで観測されたキー（`fireflow-binder:1304`）は13F以上の実物件なので同規模。
- `storageGet` はキャッシュ優先ではない。**毎回必ずネットワークへ行き**、
  失敗して初めてIndexedDBキャッシュへフォールバックする（index.html:4490-4504）。
  つまり500でもリクエスト数は1件も減らない。
- **再入ガードが無い**。`loadAll` はasyncで、1周が1秒を超えても次のtickが始まる。
  応答が遅くなるほど多重化し、自己増幅する。
- 唯一の抑制は「パネルが開いていたらreturn」だけ（index.html:8181-8183）。

これが「ゴミ箱でConsoleを消しても継続的に大量発生する」の正体。

### 副次的な発生源（嵐の主因ではない）

| 場所 | 間隔 | 内容 |
|---|---|---|
| index.html:4360 | 5秒 | `setInterval(flushOutbox, 5000)` — 失敗したwriteの再送 |
| index.html:12218 | 20秒 | `sendPresenceHeartbeat` → `storageSet`（1件） |
| supabase-integration.js:337 | 5秒 | `ensureInspectionSession` 再試行（inspectionsテーブル） |
| index.html:4971 / 6421 / 10016 | イベント駆動 | `stamp:*` の復元（起動時・捺印表一覧を開いた時・Excel再読込時） |

**重要**: `loadAll` は read しかしないため、500になってもoutboxには積まれない。
つまり嵐の増幅は「retry loop」ではなく**純粋な1秒ポーリング**である。

---

## 6. kv_store schema（supabase/schema.sql:420-439）

```sql
create table if not exists kv_store (
  id bigint generated always as identity primary key,
  property_id uuid not null references properties(id) on delete cascade,
  key text not null,
  value text,
  shared boolean not null default true,
  owner_id uuid references profiles(id),
  updated_at timestamptz not null default now(),
  unique (property_id, key, shared, owner_id)
);
```

- **index**: PK(id) と unique(property_id, key, shared, owner_id) のみ。
  実クエリの絞り込み順（property_id, key, shared, owner_id）はunique制約の
  先頭列から一致するため、index自体は効く形になっている。
- **注意点（今回の500とは別件）**: schema.sql全体が `create table if not exists` で
  構成され、`alter table ... add column` が1つも無い。
  過去のバージョンで作られたテーブルが実DBに残っている場合、
  **再実行しても列は追加されない**。schema driftを検出する仕組みが無い。

---

## 7. RLS / policy

```sql
alter table kv_store enable row level security;
create policy "kv_store_all_property_members" on kv_store for all to authenticated
  using (exists (select 1 from property_members pm
                 where pm.property_id = kv_store.property_id and pm.user_id = auth.uid()))
  with check (...同上...);
```

- kv_storeのポリシーは **property_members を経由する**。
- property_members側のSELECTポリシーは `is_property_member(property_id)`
  （`security definer` / `stable` / `set search_path = public`、schema.sql:94-105）。
  SECURITY DEFINERで所有者権限で実行されるためRLSが再適用されず、**自己参照が切れている**。

→ **現在のschema.sqlの記述では無限再帰は起きない。**
schema.sql:80-93 のコメントが記録している通り、2026-07-17に
「property_membersの自己参照ポリシー → `ERROR: infinite recursion detected in policy`」
という事象がローカルPostgreSQL 16で実際に再現・修正されている。

**未検証の要点**: その修正が**実Supabaseプロジェクトへ適用済みか**。
リポジトリ内にschema.sql適用履歴の記録は存在しない
（git履歴は全体が1つの "Initial commit" に潰れており、時系列判定にも使えない）。
実DBに旧ポリシーが残っていれば、kv_storeの全リクエストが500になる（＝H2）。

---

## 8. shared / owner_id 設計

| 種別 | shared | owner_id | 用途 |
|---|---|---|---|
| 物件共有行 | true | NULL | 点検結果・予定情報など、点検員全員で共有する業務データ（LBのほぼ全て） |
| 個人行 | false | `currentUser.id` | 個人スコープ（現状ほぼ未使用） |

実ブラウザURLに `shared=eq.true&owner_id=is.null` が共通して現れるのは、
LBの業務データが**全て物件共有行**だから（`storageSet(key, value, true)` で
第3引数 `shared=true` 固定）。

- クエリ側: `shared ? q.is('owner_id', null) : q.eq('owner_id', currentUser.id)`
  （supabase-integration.js:404 / 419 / 446 / 456）
- 保存側: `owner_id: shared ? null : currentUser.id`（同:436）

→ **クエリと保存の条件は完全に対応しており、矛盾は無い。**
RLSポリシーは `owner_id` を一切参照していないため、**`owner_id is null` と
ポリシー条件の衝突も無い**。

なお `unique (property_id, key, shared, owner_id)` は、NULL同士を等値とみなさない
PostgreSQLの仕様上 shared=true 行では機能しない。これはschema.sql:429-433 と
supabase-integration.js:412-417 で既知として扱われ、
**select→update/insertの手動upsert**で回避済み（今回の500とは無関係）。

---

## 9. property_id

- 正本は `properties.id`。LB側で独自IDを発行していない。
- 実行時の値は `currentPropertyId`（supabase-integration.js:64）で、
  初期値 = `INITIAL_PROPERTY_ID` = `b6e18eed-f2f3-4674-812d-322732908616`。
- 上記2-2の通り、現ビルドではこの値が変わる経路が存在しない。
- 観測された500のURLのproperty_idはこの値と一致 → **property_idは正しい**。

（`properties` にこのidの行が実在するかは実DB確認が必要。ただし**存在しなくても
500にはならず、200 + 空配列になる**ため、500の説明にはならない。）

---

## 10. key encoding → 原因ではない

| キー | 文字種 | 結果 |
|---|---|---|
| `fireflow-binder:1304` | ASCIIのみ | **500** |
| `fireflow-schedule-override:*` | ASCIIのみ | 500 |
| `stamp:物件名:部屋番号` | 日本語含む | 500 |

- ASCIIのみのキーでも500になっているため、**日本語が原因ではないことが確定**。
- `:` はPostgRESTのfilter値として正当。postgrest-jsが `%3A` へ正しく
  percent-encodeしていることも観測URLから確認できる。
- 仮にencodingが壊れていれば400（PGRST100 parse error）になり、500にはならない。

---

## 11. select=id / select=value → 列依存ではない

| 発行元 | select | 意味 |
|---|---|---|
| `window.storage.get`（supabase-integration.js:403） | `value` | **読み込み**。`loadAll` の毎秒ポーリングがこれ |
| `window.storage.set`（同:418） | `id` | **書き込み前の存在確認**（手動upsertの1段目）。部屋をタップして保存した時 |

filterは両者で同一（property_id / key / shared / owner_id）。
**selectだけ変えても両方500** ということは、失敗しているのは
「どの列を返すか」ではなく「行にアクセスできるか」の段階。
→ RLS評価またはインフラ層の問題を示唆し、列定義の欠落（それなら400）を否定する。

**業務上の含意**: `select=id` が500 = 保存が失敗している。
ただし `storageSet` は例外を捕捉してoutbox（IndexedDB）へ積むため
（index.html:4466-4486、基準commit `d763189` の修正が効いている）、
**現場入力データは端末内に保持されており消失していない**。
`kv_store rows = 0` と整合する。

---

## 12. 実Supabase read-only確認 → **BLOCKED**

無人実行モードの制約により外部ネットワークアクセス（curl）が拒否された。
そのため以下は取得できていない:

- kv_store の実行数 / 実テーブル定義
- `pg_policies` のポリシー一覧
- PostgRESTのエラーボディ（code / message / hint）

**schema.sqlを正本として扱い、実DBとのdrift有無は INSUFFICIENT_EVIDENCE とする。**

ユーザー実測「kv_store rows = 0 / bytes = NULL」との整合:
rows=0でもRLS評価は行われるため、**行が0件でも500は起こり得る**（矛盾しない）。
むしろ「LBを実運用しているのにrows=0」は、
**writeが一度も成功していない**ことを意味し、H2（恒常的な失敗）と整合性が高い。

---

## 13. 最小再現 → **実施できず**

セクション13で計画したA〜D（filterを段階的に外して切り分ける read-only GET）は、
外部ネットワークアクセスが拒否されたため未実施。

代わりに、**ユーザーがSafariのコンソールに貼るだけ**で同じ切り分けができる
read-onlyスニペットを下記「帰宅後PC作業」に用意した（既存の `window.__sb`
クライアントを使うだけで、新しいAPIキーを露出しない）。

---

## 14. 修正候補（最小・原因確定後にのみ着手）

### ROOT_CAUSE_B に対して（原因確定済み・単独で着手可能）

1. **`loadAll` に再入ガードを入れる**（`if (loadAllInFlight) return;`）— 数行。自己増幅を止める。
2. **ポーリング間隔を1秒から緩める**（例: 5〜10秒）。index.html:12210 の1行。
3. **本命: 部屋ごとの逐次GETをやめ、1リクエストにまとめる**
   （`select=key,value&key=in.(...)` または `key=like.fireflow-binder:*`）。
   2N req/秒 → 1〜2 req/tick になる。Realtime購読（kv_store）が既にあるので、
   ポーリング自体を段階的に削れる余地もある。

### ROOT_CAUSE_A に対して（**エラーコード確認後に選択**）

- `42P17`（infinite recursion）だった場合 → 実DBへ現行 schema.sql の
  `is_property_member` + `property_members_select_own_properties` を再適用。
- コネクション枯渇 / gateway由来だった場合 → 上記B-3で解消する見込み。まずBを直して再観測。
- それ以外 → エラーボディを見てから判断。**推測で先に触らない。**

**やらないこと**: `shared` / `owner_id` の設計変更、storageGet側のfilter削減、
kv_storeのスキーマ変更。いずれも今回の証拠では正当化されない。

---

## 15. 影響範囲

- Live Boardの**リモート保存・復元が全面的に機能していない**（kv_store経由の全データ）。
- ただしIndexedDBキャッシュ + outboxにより、**端末内では動作し、入力データも消えていない**。
  単一端末で使っている限り利用者には見えにくい。
- 一方で**複数端末間の共有・引き継ぎは成立していない**。これは業務上の実害。
- Supabaseプロジェクトへ秒間数百リクエストを送り続けており、
  quota / 課金 / プロジェクト健全性への影響が継続している。

---

## 16. rollback要否 → **不要**

- 基準commit `d763189` は「outboxのデータ保持」を強化した修正であり、
  むしろ今回の500下でデータを守っている側。戻すとデータ消失リスクが上がる。
- Phase 1E-A1の未コミット差分は実行時no-op（上記2-2）であり、戻す理由が無い。
- 500は両者より前から存在する（`setInterval(loadAll, 1000)` は初期コミットから）。

---

## 17. Phase 1E-A1へ戻れる条件

1. PostgRESTのエラーコードが判明し、ROOT_CAUSE_Aが確定していること。
2. ROOT_CAUSE_B（1秒ポーリングの逐次GET）が修正され、
   実ブラウザのConsoleで500が**0件**になっていること。
3. `window.storage.set` → `kv_store` へのwriteが1件成功し、
   **rows > 0** を実DBで確認できていること（＝保存経路が生きている証明）。

この3つが揃うまでPhase 1E-A1は停止のまま。
（A1は「物件切替の永続化」であり、そもそもkv_storeが書けない状態では検証不能。）

---

## 18. 残課題

- ROOT_CAUSE_A のサーバ側エラーコード取得（**ユーザー操作が必要**）
- 実DBの `pg_policies` / kv_store定義とschema.sqlのdrift確認
- 最小再現A〜D（filter切り分け）の実施
- schema drift検出手段が無い問題（`create table if not exists` のみで列追加migrationが無い）

---

## 19. 次の行動

**FIX_SUPABASE500_FIRST**

Phase 1E-A1は停止を継続。まずエラーコードを1つ取得すること。
それが取れれば ROOT_CAUSE_A はその場で確定する。
