# Supabase kv_store 500 修正 最終設計レビュー（2026-08-19）

設計・安全確認のみ。**製品コード・schema.sql・test・DBのいずれも変更していない。**
SQLは1文も実行していない。

基準commit: `d763189` / 対象: 現在のワーキングツリー（Phase 1E-A1 未コミット差分あり、今回は不変更）。
前提資料: `docs/FireFlow_Supabase_kv_store_500_Audit_2026-08-19.md`（前回のread-only監査）。

---

## 1. 確定原因

### ROOT_CAUSE_A（1リクエストが500になる理由）→ **確定**

実ブラウザ（Safari / localhost:3000）のNetwork Previewで、
`GET /rest/v1/kv_store` の実レスポンスボディを取得済み。

```
code:    42P17
message: infinite recursion detected in policy for relation "property_members"
```

さらにSupabase SQL Editor（read-only）で実DBの `pg_policies` を確認し、

- `property_members_select_own_properties` の `qual` に
  `FROM property_members pm2` が含まれている

ことを実画面で確認済み。

連鎖：

```
Live Board
 → kv_store SELECT
 → kv_store RLS（kv_store_all_property_members）
 → exists (select 1 from property_members ...)
 → property_members の SELECT policy が再適用される
 → その policy の中で再び property_members を SELECT
 → 同じ policy が再帰適用
 → 42P17 infinite recursion
 → PostgREST が HTTP 500
```

前回監査の H2 が的中。H1（コネクション枯渇 / gateway飽和）は**主因ではない**と判定する
（42P17はPostgresが返す論理エラーであり、負荷とは独立に必ず発生するため）。
ただしROOT_CAUSE_Bは負荷を実際に生んでいるので、副作用として並存している可能性はある。

### ROOT_CAUSE_B（大量に発生する理由）→ **確定**

`public/index.html:12210`

```js
setInterval(loadAll, 1000);
```

`loadAll()`（index.html:8180-8237）が毎tick、全室ぶんの個別GETを2種類発行する
（同:8209-8214）。部屋数 N に対し **2N req / 秒**。
組み込みデモ物件 `TOTAL_ROOMS = 129` なら **258 req/秒**。

- `storageGet()`（index.html:4490-4504）は**remote優先**。失敗して初めてIndexedDBへ
  フォールバックするため、500でもリクエスト数は1件も減らない。
- **再入ガードが無い**。`loadAll` はasyncで、1周が1秒を超えても次tickが始まり多重化する。
- 唯一の抑制はパネル表示中のearly return（index.html:8181-8183）だけ。

**この2つは独立している。混ぜて直さない。**

---

## 2. 実DBとschema.sqlの差分（最重要・推測なし）

### 2-1. 現行 `supabase/schema.sql` は既に正しい

| 対象 | schema.sql | 実DB | 一致 |
|---|---|---|---|
| `is_property_member(uuid)` | schema.sql:94-105 に定義あり<br>`language sql` / `security definer` / `set search_path = public` / `stable` | pg_policies上は確認できず（qualが `pm2` を直接参照しているため**未使用または不在**） | **不一致** |
| `property_members_select_own_properties` | schema.sql:121-125<br>`using (is_property_member(property_id))` | `qual` に `FROM property_members pm2` = **自己参照** | **不一致** |
| `property_members_insert_self` | schema.sql:139 で **`drop policy if exists`（廃止済み）** | **実在する** | **不一致** |
| `kv_store_all_property_members` | schema.sql:436-439 | 実在（同名） | 一致 |

### 2-2. 結論 = 「schema.sqlでは直っているが、実DBに古いpolicyが残っている」

決定的な証拠は **`property_members_insert_self` が実DBに存在すること**。
このポリシーは schema.sql:127-139 のコメントの通り **2026-07-17の招待制御導入時に廃止**され、
現行schema.sqlには `drop policy if exists` しか残っていない。
**現行schema.sqlを一度でも実行していれば、このポリシーは実DBから消えているはずである。**

→ 実Supabaseプロジェクトは **2026-07-17より前のschema状態のまま**であり、
   その後のRLS再帰修正・招待制御・Storage権限修正のいずれも適用されていない。

schema.sql自体には問題は無い。**問題は「適用されていないこと」**。

### 2-3. 実DBに存在しない可能性が高いもの（STEP 0で要確認）

2026-07-17以降の追加物はすべて未適用の疑いがある。

- `is_property_member(uuid)` 関数
- `is_property_admin(uuid)` 関数
- `property_invites` テーブル
- `auto_admin_on_property_create()` 関数 + `trg_auto_admin_on_property_create` トリガー
- `storage_object_is_property_member(text)` 関数、および強化後のStorageポリシー3本
- `properties_select_members` / `properties_insert_authenticated`

---

## 3. 🚨 最重要リスク：RLSを直しただけでは動かない可能性がある

**RLS再帰を直すと500は消えるが、それだけでは「読めるようになる」とは限らない。**

### 3-1. 理由

kv_storeのポリシーは
`exists (select 1 from property_members pm where pm.property_id = kv_store.property_id and pm.user_id = auth.uid())`
である。再帰が解消した後は、この `exists` が **素直に評価される**。

つまり

```
(現ユーザー, b6e18eed-f2f3-4674-812d-322732908616) の property_members 行が存在しない
 → exists = false
 → SELECT: HTTP 200 + 空配列（500は消えるが、何も読めない）
 → INSERT/UPDATE: 42501 new row violates row-level security policy（403）
```

となり、**症状が「500の嵐」から「静かに何も同期しない」へ変わるだけ**になる。

### 3-2. その行が存在しない現実的な可能性が高い

1. `INITIAL_PROPERTY_ID` の物件は、supabase-integration.js:14-15 の手順の通り
   **SQL Editorで `insert into properties (name) values (...)` で手動作成**された。
2. 実DBには `trg_auto_admin_on_property_create` トリガーが**無い可能性が高い**（2-3）。
   → 作成者は自動adminにならない。
3. クライアント側の `property_members.upsert` は
   **2026-07-17に削除済み**（supabase-integration.js:302-305 のコメントに明記）。
   → LB起動時に自分をmemberへ追加する経路は**現在のコードには存在しない**。
4. 実DBに `property_members_insert_self` が残っているのは、
   **かつてクライアントが自己insertしていた時代の名残**。
   当時LBを起動していれば行は存在するが、**それはユーザー実測「kv_store rows = 0」と
   整合しない**（memberなら書けていたはずで、書けていれば行が0にはならない）。

→ **membership行が無い可能性が相当高い。** これはSTEP 0で必ず確認する。

### 3-3. 設計への反映

**STEP 0（read-only診断）を必須とし、その結果次第でSTEP 1.5（membership行の投入）を挟む。**
membership行の投入は「DBへのwrite」なので、ユーザーの明示判断が必要な操作として分離する。

---

## 4. RLS修正方針

### 4-1. 採用方針

**現行schema.sqlの設計（SECURITY DEFINER関数 `is_property_member()`）をそのまま正本とする。**
新しい設計を発明しない。

### 4-2. 妥当性確認（セクション8の全項目）

| 確認項目 | 結果 |
|---|---|
| function内でproperty_membersを読む | ○ schema.sql:101-104 |
| SECURITY DEFINER | ○ schema.sql:97 |
| row security bypassが意図どおりか | ○ 関数所有者（postgres）権限で実行され、`property_members` のRLSが**再適用されない**。これが再帰を断ち切る唯一の仕組み。所有者はテーブルオーナーのためRLS適用対象外。 |
| auth.uid()との関係 | ○ SECURITY DEFINERでも `auth.uid()` は**呼び出し元JWTのclaimを読む**（`current_setting('request.jwt.claims')` ベース）ので、DEFINERの実行者ではなく**ログイン中ユーザー**が正しく取れる。関数は `auth.uid()` を引数で受けず内部で取るため、**呼び出し元が他人のIDを詐称できない**。 |
| search_path固定 | ○ `set search_path = public`（schema.sql:98）。SECURITY DEFINER関数の必須対策。search_path乗っ取りによる `property_members` すり替えを防ぐ。 |
| SQL injection余地 | ○ 無い。動的SQL（EXECUTE / format / 文字列連結）を一切使わない静的な `language sql` 関数で、引数は `uuid` 型。文字列が入る余地が無い。 |
| property_members自身のSELECT policyで再帰しない | ○ policyは `is_property_member(property_id)` を呼ぶだけ。関数内のSELECTはRLSを通らないため、policyが再評価されない。 |
| kv_store policyから呼んでも再帰しない | ○ kv_store policy → `property_members` SELECT → policy → 関数（RLS外）で**必ず1段で止まる**。 |
| INSERT policyとの整合 | △ **今回は触らない**（後述4-4）。 |
| STABLE指定 | ○ schema.sql:99。同一ステートメント内で結果をキャッシュでき、258行ぶん評価しても関数呼び出しが繰り返し実行されない。性能上も重要。 |

**セキュリティ上の追加確認**: `is_property_member()` は「自分がmemberか」しか返さない。
引数の物件に所属していなければ `false`。**権限昇格には使えない。**

### 4-3. 今回のSQLで**やること**（最小）

1. `is_property_member(uuid)` を `create or replace` で作成（存在すれば更新）
2. `property_members_select_own_properties` を drop → 非再帰版で create

これだけ。**他は一切触らない。**

### 4-4. 今回のSQLで**やらないこと**（重要）

| やらないこと | 理由 |
|---|---|
| `drop policy "property_members_insert_self"` | セキュリティ上は廃止すべきだが、**今これを消すと、membership行が無い場合の唯一の自力復旧経路まで消える**（3-2）。招待制御一式（property_invites + トリガー + api/accept-invite）を同時に入れないと運用が成立しない。**別Phaseへ完全分離する。** |
| Storageポリシーの強化 | 既存写真のパス形式を実DBで確認していない。500と無関係。別Phase。 |
| `property_invites` / トリガー / 招待API | 500と無関係。別Phase。 |
| kv_store のschema変更 | 500と無関係。前回監査で `shared`/`owner_id`/index設計に矛盾が無いことを確認済み。 |
| `kv_store_all_property_members` の変更 | このポリシー自体は正しい。再帰の原因はproperty_members側のみ。 |

---

## 5. 「schema.sql全体再実行」の是非 → **却下**

| 評価項目 | schema.sql全体再実行 | 最小SQL修正（4-3） |
|---|---|---|
| 既存データへの影響 | 直接のDML無し（`create table if not exists` のみ） | 無し |
| policy以外の副作用 | **大きい**。`property_members_insert_self` を削除（→3-2のロックアウト危険）、Storageポリシー3本を強化（既存写真が読めなくなる可能性）、`property_invites` 新設、トリガー2本作成 | 無し |
| trigger | `on_auth_user_created` / `trg_auto_admin_on_property_create` を新規作成 | 触らない |
| function | 6関数を作成/置換 | 1関数のみ |
| table | property_invites を新設 | 触らない |
| index | 変更なし（新テーブルのPKのみ） | 触らない |
| constraint | 変更なし | 触らない |
| idempotent性 | 概ね有（drop-then-create / if not exists / exception when duplicate_object）。ただし **`create table if not exists` のみで `alter table add column` が無いため、既存テーブルの列drift は再実行しても直らない** | 完全にidempotent |
| rollback | **困難**。7〜8個の変更が同時に入り、どれが問題か切り分け不能 | 容易（policy 1本） |
| 本番安全性 | **低**。1回のSQLで500修正・セキュリティ強化・機能追加が混ざる | 高 |

### 判定

**原因はpolicy 1本なので、最小SQL修正を採用する。**

絶対ルール9「修正は最小限 / 無関係なリファクタリング禁止 / 別機能のついで修正禁止」に
そのまま該当する。schema.sql全体の適用は「schema drift解消」という**別の目的**であり、
500修正と同時にやると、絶対ルール7・8（原因の切り分け）を自分から壊す。

**ただし schema drift自体は残課題として明記する**（セクション13・14）。

---

## 6. 修正SQL案（**実行禁止・レビュー用**）

すべてSupabase SQL Editorで**1ステップずつ**実行し、各ステップの結果を確認してから次へ進む。
一括で貼らない。

---

### STEP 0 — 現状確認（read-only、writeゼロ）

**このSTEPの結果が出るまで、STEP 1以降へ進まない。**

```sql
-- 0-A. property_members / kv_store の現在のポリシー定義（変更前の記録＝rollback用）
select schemaname, tablename, policyname, cmd, roles, qual, with_check
from pg_policies
where tablename in ('property_members', 'kv_store', 'properties')
order by tablename, policyname;
```

```sql
-- 0-B. is_property_member 関数の存在と定義
select p.proname,
       pg_get_function_identity_arguments(p.oid) as args,
       p.prosecdef  as is_security_definer,
       p.provolatile as volatility,   -- 's' = stable
       p.proconfig  as config,        -- {search_path=public} を期待
       pg_get_functiondef(p.oid)      as definition
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('is_property_member', 'is_property_admin', 'auto_admin_on_property_create');
```

```sql
-- 0-C. 【最重要】現ユーザーのmembership行が存在するか（セクション3の検証）
--      ※ RLSが再帰中でも、SQL EditorはService Role相当のため参照できる
select pm.property_id, pm.user_id, pm.role, pm.added_at, pr.name as property_name
from property_members pm
left join properties pr on pr.id = pm.property_id
order by pm.added_at;
```

```sql
-- 0-D. 対象物件が実在するか
select id, name, created_at, created_by
from properties
where id = 'b6e18eed-f2f3-4674-812d-322732908616';
```

```sql
-- 0-E. 自分のuser_id（auth.usersの一覧。行数が少ない前提）
select id, email, created_at from auth.users order by created_at;
```

```sql
-- 0-F. kv_storeの現在行数（ユーザー実測「rows = 0」の再確認）
select count(*) as kv_rows from kv_store;
```

**0-A の出力（特に `property_members_select_own_properties` の `qual` 全文）を、
必ずテキストで保存してからSTEP 1へ進む。これがrollback原資になる。**

---

### STEP 1 — SECURITY DEFINER関数の作成（policyは変更しない）

このSTEPは**単独では何の挙動も変えない**（誰もこの関数を呼んでいないため）。
安全に先行実行でき、失敗しても影響が無い。

```sql
-- schema.sql:94-105 と完全に同一。新しい設計は導入しない。
create or replace function is_property_member(target_property_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from property_members pm
    where pm.property_id = target_property_id and pm.user_id = auth.uid()
  );
$$;
```

検証（read-only）:

```sql
-- 1-V. 作成できたか / 属性が正しいか
select p.proname, p.prosecdef, p.provolatile, p.proconfig
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'is_property_member';
-- 期待: prosecdef = true, provolatile = 's', proconfig = {search_path=public}
```

---

### STEP 1.5 — membership行の投入（**STEP 0-C で行が無かった場合のみ**）

⚠️ **これはDBへのwrite。ユーザーの明示判断が必要。**
STEP 0-C で行が存在した場合は **このSTEPを飛ばす**。

```sql
-- 自分を対象物件のadminとして登録する。
-- <YOUR_USER_ID> は STEP 0-E で確認した自分の auth.users.id に置き換える。
-- 既に行があれば何もしない（冪等）。
insert into property_members (property_id, user_id, role)
values ('b6e18eed-f2f3-4674-812d-322732908616', '<YOUR_USER_ID>', 'admin')
on conflict (property_id, user_id) do nothing;
```

正当性: これは schema.sql:198-216 の `auto_admin_on_property_create()` トリガーが
本来やるはずだった処理そのもの（「物件を作成した人は自動でadminになる」）。
新しい業務ルールを作っていない。

rollback: `delete from property_members where property_id = '...' and user_id = '<YOUR_USER_ID>';`

---

### STEP 2 — property_members の SELECT policy を非再帰版へ置換

```sql
-- schema.sql:121-125 と完全に同一。
drop policy if exists "property_members_select_own_properties" on property_members;
create policy "property_members_select_own_properties"
  on property_members for select
  to authenticated
  using (is_property_member(property_id));
```

⚠️ `property_members_insert_self` には触らない（4-4）。

---

### STEP 3 — read-only 検証SQL

```sql
-- 3-A. policyが差し替わったか。qual に pm2 が消えていること
select policyname, cmd, qual, with_check
from pg_policies
where tablename = 'property_members'
order by policyname;
-- 期待: property_members_select_own_properties の qual = is_property_member(property_id)
--       property_members_insert_self は【残っていてよい】（今回対象外）
```

```sql
-- 3-B. 認証ユーザーの視点で property_members を読み、42P17が出ないこと
--      ※ SQL Editorはデフォルトでpostgres権限のためRLSを迂回する。
--        必ず下記のようにロールとJWT claimを明示して評価する。
begin;
  select set_config('request.jwt.claims',
                    json_build_object('sub', '<YOUR_USER_ID>', 'role', 'authenticated')::text,
                    true);
  set local role authenticated;

  select property_id, user_id, role from property_members;          -- 42P17 が出ないこと
  select count(*) from kv_store
   where property_id = 'b6e18eed-f2f3-4674-812d-322732908616';      -- 42P17 が出ないこと
rollback;   -- ← 必ず rollback。何も変更しない。
```

**`rollback;` を必ず含めること。** `commit;` にしない（read-onlyを保証するため）。

---

## 7. SQL実行順（まとめ）

```
STEP 0   read-only 診断 + 変更前definitionの記録         ← write ゼロ
  ↓  （0-C の結果で分岐）
STEP 1   is_property_member() を create or replace       ← 挙動変化なし
  ↓
STEP 1.5 membership行 insert（0-Cで行が無い場合のみ）     ← ⚠️ write / 要判断
  ↓
STEP 2   property_members SELECT policy を置換           ← ここで42P17が消える
  ↓
STEP 3   read-only 検証（3-A / 3-B）
  ↓
STEP 4   実Live Board（Safari）で確認 → セクション8
```

**STEP 2 と request storm修正を同時にやらない。**

---

## 8. RLS修正後の確認項目（セクション11 A〜I）

STEP 4。Safari / localhost:3000 でLBを起動し、Console + Networkで確認する。

| # | 確認内容 | 期待 | 確認方法 |
|---|---|---|---|
| A | kv_store SELECT 1件 | HTTP **200** | Network で任意の `kv_store?select=value...` を1件確認 |
| B | 存在しないkey | **200 + 空**（500でない） | 未保存の部屋のbinder GET。supabase-jsは200+空→`maybeSingle()`がnullを返し、`window.storage.get`が「key not found」を**JS例外**で投げる。**これは正常動作**（HTTP層は200） |
| C | binder key（ASCII） | 200 | `fireflow-binder:1304` |
| D | schedule override key | 200 | `fireflow-schedule-override:*` |
| E | 日本語stamp key | 200 | `stamp:物件名:部屋番号`。捺印表一覧を開く |
| F | 認証済み所属物件 → read可能 | 200、保存済みなら値が返る | 一度部屋をタップして保存 → リロード → 値が復元される |
| G | 非所属物件 → read不可 | **200 + 空**（403でも500でもない） | 下記スニペット参照。PostgRESTのRLSはSELECTでは「行が見えない」＝空配列になる。**403を期待しない** |
| H | property_members SELECT | 42P17なし | Network / 下記スニペット |
| I | INSERT policy 既存仕様維持 | 保存が成功し、`select id` が200 | 部屋をタップ→保存→未送信バッジが0になる |

### 実ブラウザ用 read-only スニペット（Safari Console貼り付け）

既存の `window.__sb` クライアントを使うだけ。**新しいAPIキーを露出しない。**

```js
(async () => {
  const sb = window.__sb;
  const PID = 'b6e18eed-f2f3-4674-812d-322732908616';
  const FAKE = '00000000-0000-4000-8000-000000000000'; // 非所属物件（存在しなくてよい）
  const show = (n, r) => console.log(n, '| err:', r.error ? (r.error.code + ' ' + r.error.message) : 'none',
                                        '| rows:', Array.isArray(r.data) ? r.data.length : (r.data ? 1 : 0));

  show('H property_members', await sb.from('property_members').select('property_id,user_id,role'));
  show('C binder(ascii)   ', await sb.from('kv_store').select('value').eq('property_id', PID).eq('key', 'fireflow-binder:1304').eq('shared', true).is('owner_id', null));
  show('B missing key     ', await sb.from('kv_store').select('value').eq('property_id', PID).eq('key', 'fireflow-binder:__no_such_room__').eq('shared', true).is('owner_id', null));
  show('D override        ', await sb.from('kv_store').select('key').eq('property_id', PID).like('key', 'fireflow-schedule-override:%').eq('shared', true).is('owner_id', null));
  show('E stamp(日本語)   ', await sb.from('kv_store').select('key').eq('property_id', PID).like('key', 'stamp:%').eq('shared', true).is('owner_id', null));
  show('F own property    ', await sb.from('kv_store').select('key').eq('property_id', PID).eq('shared', true).is('owner_id', null));
  show('G other property  ', await sb.from('kv_store').select('key').eq('property_id', FAKE).eq('shared', true).is('owner_id', null));
})();
```

**合格条件: 全行の `err` が `none`（Bは行0件でよい）、Gが `rows: 0`。**
1行でも `42P17` が出たらSTEP 2をやり直す。
`F` が `rows: 0` のままなら **3-1の状態**＝membership行が無い → STEP 1.5へ戻る。

---

## 9. request storm 原因（再掲・確定済み）

`loadAll()` が「何をリアルタイム同期したくて1秒pollingしているか」を実コードで再確認した。

### 9-1. loadAllの責務（index.html:8180-8237）

| 責務 | 内容 | 1秒pollingが必要か |
|---|---|---|
| ① 物件外の部屋をメモリから落とす | `state` / `scheduleOverrides` のprune（8198-8207） | **不要**。物件切替時の1回で足りる |
| ② `fireflow-binder:<room>` の取得 → `state[room]` | **他端末の点検結果を反映**（8209-8211, 8217-8226） | 他端末反映が目的 |
| ③ `fireflow-schedule-override:<room>` の取得 → `scheduleOverrides[room]` | **他端末の予定上書きを反映**（8212-8214, 8227-8234） | 他端末反映が目的 |
| ④ 変化があれば `renderFloors()` | 再描画（8236） | 変化検知に依存 |

**自端末の更新はpollingに依存していない。** `persist()` が `state[room]` を直接更新してから
`storageSet()` するため、自分の操作は即座に画面へ出る（index.html:8057付近のコメント）。

→ **1秒pollingの唯一の目的は「他端末の更新を最大1秒で反映すること」。**

### 9-2. Realtime との役割重複 → **重複していない（現状Realtimeは死んでいる）**

| 事実 | 根拠 |
|---|---|
| kv_store の Realtime購読コードは存在する | supabase-integration.js:485-491 |
| しかし **LB本体に受け手が1つも無い** | `window.onRealtimeUpdate` の定義は0件、`sb-realtime-update` のlistenerも0件（public/ 全体をgrep。ヒットするのは supabase-integration.js の**発火側4箇所のみ**） |
| そもそも購読が始まらない | `installRealtimeSync()` は `ensureInspectionSession()` 成功後にのみ呼ばれる（supabase-integration.js:328）。`inspections` テーブルのRLSも `property_members` 経由（schema.sql:238-243）なので、**現在は42P17で失敗し続け、5秒ごとにリトライしているだけ**（同:336-338） |
| publication登録も未適用の可能性 | `alter publication supabase_realtime add table kv_store`（schema.sql:483）は2026-07-17以降の適用に含まれる。実DB未適用の疑い（2-3） |

→ **「Realtimeがあるからpollingを消せる」は成立しない。**
   Realtimeへ寄せるには (a) 受け手の実装、(b) publication登録、(c) inspectionセッション非依存化、
   の3つが必要で、**最小修正ではない**。

### 9-3. presence / StampStore は loadAll と無関係

| 経路 | 間隔 | 備考 |
|---|---|---|
| `sendPresenceHeartbeat` | 20秒 / 1件（index.html:12218） | 嵐の主因ではない |
| `flushOutbox` | 5秒（index.html:4360） | writeの再送のみ。`loadAll` はreadしかしないのでoutboxを増やさない |
| StampStore | イベント駆動（起動時・捺印表を開いた時・Excel再読込時） | pollingではない |
| `checkScheduledReminders` | 60秒 | ネットワーク不使用 |

---

## 10. request storm 修正案の比較

| 案 | 内容 | req/秒（N=129） | 実装量 | リスク | 判定 |
|---|---|---|---|---|---|
| **A** | setInterval停止 + Realtime/イベント駆動へ一本化 | ~0 | **大**（受け手実装 + publication + セッション非依存化） | 高。他端末反映が完全にRealtime依存になり、購読が切れると無音で同期が止まる | **却下（今回は）**。将来の正本方向としては正しい |
| **B** | polling間隔を延ばす（1秒→10秒） | 25.8 | 極小 | **他端末反映が最大10秒遅れる＝現場のUX劣化**。req数も1桁しか減らない | **単独では却下** |
| **C** | 全量N件GETをやめ、prefix一括GETにする | **2** | 中 | fallback経路の再設計が必要 | **採用（本命）** |
| **D** | 再入ガード（`if (loadAllInFlight) return;`） | 上限を保証 | 極小 | ほぼ無し | **採用（最優先）** |
| **E** | `visibilitychange` で非表示時にpolling停止 | 非表示時0 | 小 | 復帰時に1回即実行が必要 | **採用（補助）** |

### なぜ B（間隔延長）を主軸にしないか

絶対ルール9「特定物件のハードコード禁止 / 今後の物件にも通用する一般ルール」に反する。
`2N req/tick` という構造を残したまま間隔だけ延ばすと、
**部屋数が増えるほど破綻する**（300室なら10秒間隔でも60 req/秒）。
「とりあえず10秒」は原因（N件の個別GET）を残す対症療法であり、正本設計と整合しない。

### C の具体設計（実装は今回しない）

現在（tickごと 2N リクエスト）:

```js
storageGet('fireflow-binder:' + room, true)                // × N
storageGet('fireflow-schedule-override:' + room, true)     // × N
```

変更後（tickごと 2 リクエスト）:

```
GET kv_store?select=key,value&property_id=eq.<pid>&key=like.fireflow-binder:*&shared=eq.true&owner_id=is.null
GET kv_store?select=key,value&property_id=eq.<pid>&key=like.fireflow-schedule-override:*&shared=eq.true&owner_id=is.null
```

- 既存の `window.storage.list()`（supabase-integration.js:452-461）は **keyしか返さない**ので
  そのままでは使えない。**`select('key,value')` を返す新メソッドを1本足す**のが最小
  （例: `window.storage.listWithValues(prefix, shared, propertyId)`）。
  既存の `get/set/delete/list` の挙動は**1文字も変えない**（Phase 1B以降のrollback条件を守る）。
- **正本データは変えない。** 読む場所（kv_store）も、キー体系も、値の形式も同じ。
  「N回に分けて読むか、1回で読むか」だけを変える。新しい正本を作らない（セクション15の指示に合致）。
- index.html側は `loadAll()` の中だけを差し替える。`storageGet()` 自体は変更しない
  （StampStore・binder個別読込など他の呼び出し元に影響を出さない）。

**必ず設計に含めること — IndexedDBキャッシュの扱い:**

| 局面 | 現在（N件個別） | 変更後（一括） |
|---|---|---|
| 成功時 | 各keyのcacheを更新（index.html:4496） | **取得した全keyのcacheを更新する**（同等性を保つ） |
| 失敗時 | keyごとにcacheへフォールバック（同:4500-4501） | **一括GETが失敗したら、その周は「変化なし」として扱い、メモリ上のstateを維持する** |

⚠️ **設計上の注意点（実装時に必ず守る）**:
一括GETは「返ってこなかったkey＝削除された」を意味しない
（`.like()` の結果に含まれないだけかもしれない）。
現在の `loadAll` は `if (result && result.value)` で**値がある時しか上書きしない**
（8220, 8228）ため、**「返ってこなかった部屋のstateを消さない」という現在の挙動を必ず維持する**。
一括化を機に「差分削除」を導入しない。オフライン起動時に全部屋の点検状態が
画面から消える事故（index.html:8193-8197 のコメントが警告している事故）を再発させる。

### 採用案

**D → C → E の順に、3つの独立したcommitで入れる。**
`setInterval` の間隔は **1秒のまま維持する**（Cで 2 req/tick になるため、
UXを落とさずに負荷を 129分の1 にできる。Bは不要）。

---

## 11. 再入ガード（セクション14）

現状 `loadAll` に再入ガードは無い（index.html:8180-8237 に該当コードなし）。

```
tick1: loadAll 開始 → 258件のGET待ち（1秒超）
tick2: loadAll 開始（tick1未完了のまま）→ さらに258件
tick3: ...
```

応答が遅いほど多重化する**自己増幅**。設計としては最小で足りる:

```js
var loadAllInFlight = false;
async function loadAll() {
  if (loadAllInFlight) return;
  loadAllInFlight = true;
  try {
    /* 既存の本体をそのまま */
  } finally {
    loadAllInFlight = false;   // ← try/finally 必須。例外時にフラグが残ると永久に止まる
  }
}
```

- **`finally` を必ず使う**。`await` が例外を投げた場合にフラグが立ちっぱなしになると、
  loadAllが二度と走らず「他端末の更新が永久に反映されない」という**より悪い不具合**になる。
- 既存の早期return（パネル表示中、8181-8183）は**フラグを立てる前**に置く。
- `loadAll()` の明示呼び出し（index.html:12205、物件切替時など）はスキップされ得るが、
  1秒後のtickで必ず追いつくため実害は無い。

**実装は今回しない。**

---

## 12. IndexedDB fallback の順序（セクション15）→ **今回は変更しない**

現在: `remote GET → 失敗 → IndexedDB fallback`（index.html:4490-4504）。

| 観点 | 評価 |
|---|---|
| local-first（cache即返し → 裏でremote同期）の方が現場向きか | 一般論としては○。体感が速く、オフラインでも即描画できる |
| しかし今回変更すべきか | **× しない** |

理由:

1. **セクション15の指示「今回のrequest storm修正で新しい正本を作らない」に直接該当する。**
   local-firstにすると「画面が見ているのはcacheか、remoteか」という状態が増え、
   絶対ルール5（正本データを明確にする）に抵触する。
2. Phase 1E（outbox / propertyIdスコープ）の保存基盤設計が確定していない段階で
   読み取り順序を変えると、Phase 1Eの検証条件が崩れる。
3. **案Cを入れれば、この論点の実利がほぼ消える。**
   tickあたり2リクエストなら、remote-firstでもコストは無視できる。
4. 現在 remote-first が実害を生んでいるのは「500が返るから」であり、
   RLS修正でその前提自体が消える。

→ **local-first化は「検討した上で今回はやらない」と記録する。Phase 1E完了後に再評価。**

---

## 13. 実装順序（全体）

```
STEP 1  RLS修正（セクション6・7。DBのみ。製品コード変更ゼロ）
   ↓
STEP 2  Safariで500消失を確認（セクション8のA〜I + スニペット）
   ↓  ★ここで一度止まる。判定が出るまで次へ進まない
STEP 3  request storm 計測（下記13-1。製品コード変更ゼロ）
   ↓
STEP 4  request storm 最小修正（D → C → E。各1commit）
   ↓
STEP 5  再計測（同じスニペットで before/after を比較）
   ↓
STEP 6  Phase 1E-A1 復帰判定（セクション15）
```

**RLSとpollingを同時に変更しない。** 同時変更は絶対ルール7・8に反する。

### ⚠️ STEP 2 → STEP 3 の間に潜むリスク

RLS修正が成功した瞬間、**258 req/秒が「失敗」から「成功」に変わる**。
Supabaseの egress / リクエスト数 / DB CPU が実際に消費され始める。

→ **STEP 2 の確認は短時間で終わらせ、確認が済んだらタブを閉じること。**
   LBを開きっぱなしで放置しない。STEP 4（特にD・C）を**同日中に**入れる。

### 13-1. 計測方法（read-only、製品コード変更なし）

Safari Consoleに貼るだけ。10秒間のkv_storeリクエスト数を数える。

```js
(() => {
  const t0 = performance.now();
  const obs = new PerformanceObserver(list => {
    list.getEntries().forEach(e => { if (e.name.includes('/rest/v1/kv_store')) window.__kvCount = (window.__kvCount || 0) + 1; });
  });
  window.__kvCount = 0;
  obs.observe({ type: 'resource', buffered: false });
  setTimeout(() => {
    obs.disconnect();
    const sec = (performance.now() - t0) / 1000;
    console.log('kv_store requests:', window.__kvCount, '/', sec.toFixed(1), 'sec =',
                (window.__kvCount / sec).toFixed(1), 'req/sec');
  }, 10000);
})();
```

| 局面 | 期待値（N=129） |
|---|---|
| STEP 3（修正前） | 250〜260 req/sec |
| STEP 5（D+C+E後） | **2 req/sec 前後** |

---

## 14. rollback 設計

### 14-1. RLS（セクション20の指示に沿う）

**旧policyへの単純rollbackは正解としない。** 旧policy自体が42P17の原因だから。

| 段階 | 内容 |
|---|---|
| 変更前definitionの記録 | STEP 0-A の出力（`qual` 全文）をテキスト保存。**これが唯一の記録。git管理されていないため、実行者が必ず控える** |
| 新policyに別問題が出た場合の**fallback policy** | 下記 |

**fallback policy（非再帰・より狭い・緊急用）:**

```sql
-- is_property_member() に想定外の問題が出た場合の退避先。
-- 自分の行しか返さないが、非再帰であり 42P17 は起きない。
drop policy if exists "property_members_select_own_properties" on property_members;
create policy "property_members_select_own_properties"
  on property_members for select
  to authenticated
  using (user_id = auth.uid());
```

- **kv_store は これでも動く**。kv_storeのpolicyは
  `exists (select 1 from property_members pm where pm.property_id = ... and pm.user_id = auth.uid())`
  であり、必要なのは**自分の行が見えること**だけだから。
- 失うもの: 「同じ物件の**他のメンバー**を一覧する」機能
  （`listPropertyMembers`、supabase-integration.js:586）。メンバー一覧に自分しか出なくなる。
- 情報漏洩リスク: **無い**（むしろ厳しくなる方向）。
- **緊急退避専用。恒久策にしない。** 正本は `is_property_member()` 版。

| やってはいけないrollback | 理由 |
|---|---|
| 旧 `pm2` 自己参照policyへ戻す | 42P17が再発する。**絶対にやらない** |
| `alter table property_members disable row level security` | 全ユーザーが全物件のメンバーシップを閲覧可能になる。**重大な情報漏洩。絶対にやらない** |
| policyを削除して裸にする | 上と同じ。**やらない** |

STEP 1.5 のrollback: `delete from property_members where property_id = '...' and user_id = '<YOUR_USER_ID>';`

### 14-2. request storm

**D / C / E をそれぞれ単独commitにする。**
`git revert <commit>` で個別に戻せること自体をrollback条件とする。

| commit | 内容 | 単独revert可否 |
|---|---|---|
| 1 | `loadAll` 再入ガード | ○（`loadAllInFlight` の追加のみで完結） |
| 2 | `loadAll` の一括GET化 + `listWithValues` 追加 | ○（`window.storage.get/set/delete/list` を変更しないため） |
| 3 | `visibilitychange` によるpolling停止 | ○ |

**3つを1commitにまとめない。**

---

## 15. Phase 1E-A1 復帰条件

前回監査（セクション17）の3条件を、確定した原因に合わせて更新する。

| # | 条件 | 状態 |
|---|---|---|
| 1 | ROOT_CAUSE_A の確定 | ✅ **達成**（42P17。セクション1） |
| 2 | STEP 1 完了 + セクション8の A〜I がすべて合格（**特に F: `rows > 0`**） | ⬜ 未 |
| 3 | STEP 4 完了 + STEP 5 で kv_store が **2 req/sec 前後**であること | ⬜ 未 |
| 4 | kv_store の `rows > 0` を実DBで確認（＝writeが通っている証明） | ⬜ 未 |

さらにA1へ戻る前に、RLS修正後の実LBで以下を再確認する（セクション17の指示）:

- `getCurrentPropertyId()` が正しい値を返す
- `lb_current_property_id` の localStorage 永続化
- リロード後の復元
- 通常のLB操作（部屋タップ → 保存 → 未送信バッジ0 → リロード → 値が残る）

**Phase 1E-A1 の未コミット差分は今回も一切触っていない。**
`public/supabase-integration.js` / `package.json` / Phase1A test / Phase1E-A1 test / docs は
すべて現状のまま（セクション18の指示に従い、勝手なrollbackをしていない）。

---

## 16. リスク

| # | リスク | 深刻度 | 対策 |
|---|---|---|---|
| R1 | **membership行が無く、500が消えても何も読めない**（セクション3） | **高** | STEP 0-C で事前確認。無ければSTEP 1.5。**これを飛ばすと「直したのに直っていない」になる** |
| R2 | RLS修正直後、258 req/秒が実際に成功し始めquotaを消費 | 中 | STEP 2の確認を短時間で終え、タブを閉じる。STEP 4を同日中に実施（13） |
| R3 | 実DBのschema driftが他にも残っている（property_invites不在、Storage権限が緩い、Realtime publication未登録など） | 中 | **今回のスコープ外**。別Phaseで棚卸し。今回のSQLはdriftを増やさない（schema.sqlと完全に同一の定義しか流さない） |
| R4 | `property_members_insert_self` が実DBに残存＝**「property_idを知っていれば誰でも他社物件に参加できる」セキュリティ穴** | **高**（商品化時） | 今回は**意図的に残す**（4-4）。単独で消すとロックアウトの危険。招待制御一式の適用と同時に閉じる。**別Phaseとして最優先で起票する** |
| R5 | 一括GET化で「返ってこなかったkey＝削除」と誤解した実装をすると、オフライン時に全部屋のstateが消える | 中 | セクション10の⚠️を実装時に必ず守る。既存の `if (result && result.value)` の挙動を維持 |
| R6 | 再入ガードのフラグが例外で立ちっぱなしになり、同期が永久停止 | 中 | `try/finally` 必須（セクション11） |
| R7 | STEP 0 の変更前definitionを控え忘れる | 低 | STEP 0-A の出力保存を手順に明記済み。git管理外なので実行者依存 |
| R8 | SQL Editorはデフォルトでpostgres権限のためRLSを迂回し、「直った」と誤判定する | 中 | STEP 3-B で `set local role authenticated` + JWT claim を明示。最終判定は**必ず実ブラウザ**（絶対ルール3） |

---

## 17. 次の最小Phase

| Phase | 内容 | 種別 | 前提 |
|---|---|---|---|
| **P-A** | RLS再帰修正（STEP 0〜3） | **DB操作のみ**。製品コード変更ゼロ | — |
| **P-B** | 実LB確認（セクション8 A〜I） | ユーザー操作 | P-A |
| **P-C** | request storm 計測 | ユーザー操作（Console貼り付け） | P-B |
| **P-D** | 再入ガード（commit 1） | コード | P-C |
| **P-E** | 一括GET化（commit 2） | コード | P-D |
| **P-F** | visibilitychange（commit 3） | コード | P-E |
| **P-G** | 再計測 → Phase 1E-A1 復帰判定 | ユーザー操作 | P-F |
| P-H | （別件・要起票）schema drift 棚卸し + 招待制御一式の適用 + `property_members_insert_self` の廃止 | DB + コード | P-G後 |

**次にやるのは P-A のみ。** P-A が終わるまで他へ進まない。

---

## 18. テスト（セクション19）

### RLS修正用（P-A / P-B）

| # | 内容 | 手段 |
|---|---|---|
| 1 | SQL read-only確認 | STEP 0-A〜F、STEP 1-V、STEP 3-A/3-B |
| 2 | kv_store 1件GET | セクション8-C |
| 3 | property_members GET | セクション8-H |
| 4 | 非所属物件の拒否 | セクション8-G（**200 + 空**が正解） |
| 5 | 42P17 再発0 | スニペットの全行で `err: none` |

### request storm修正用（P-C 〜 P-G）

| # | 内容 | 判定方法 | 備考 |
|---|---|---|---|
| 1 | loadAll同時実行数 | 再入ガード導入後、`loadAllInFlight` が同時に2つ立たない | 単体テスト化可 |
| 2 | 1秒あたりrequest数 | セクション13-1のスニペット。**258 → 2 前後** | before/after必須 |
| 3 | remote failure時のrequest増幅0 | オフラインにしてもreq/secが増えないこと | DevTools Network throttling: Offline |
| 4 | reload後の復元 | 部屋の点検状態・予定上書きがリロード後も残る | 実LB |
| 5 | Realtime | **今回は対象外**（受け手が無い＝挙動変化なし。セクション9-2） | — |
| 6 | offline | 完全オフラインで起動 → 全部屋のstateが**消えない** | R5の回帰確認。最重要 |
| 7 | outbox | オフライン保存 → オンライン復帰 → 未送信バッジ0 | 既存 `outbox_no_data_loss_verify.js` と併せて確認 |
| 8 | A/P（午前・午後） | 予定記号の表示が変わらない | 実LB |
| 9 | 点検済み | 点検済み色分けが変わらない | 実LB |
| 10 | 不在 | 不在マークが変わらない | 実LB |
| 11 | schedule override | 予定上書きがリロード後も残る | 実LB |

### 既存テスト（今回実行済み・全PASS）

| コマンド | 結果 |
|---|---|
| `npm run test:unit` | ✅ ALL PASS |
| `npm run test:release` | ✅ ALL PASS（30/30含む全スイート） |
| `npm run typecheck` | ✅ PASS（エラー0） |
| `npm run build` | ✅ PASS |

⚠️ **これらのPASSは500が無い証明にはならない。**
すべてNode上のロジックテストであり、実Supabase・実RLSを通っていない。
絶対ルール3の通り、**最終判断基準は実Live Board**。

---

## 19. 判定

```
SUPABASE500_FIX_DESIGN_CONDITIONAL_GO
NEXT_STEP_RLS_FIX
```

### CONDITIONAL_GO とした理由

RLS修正の設計自体は完成しており、原因も実ブラウザ + 実DBで確定済み。
SQLも最小・段階実行可能・idempotentで、rollback（fallback policy）も用意した。

ただし **無条件GOにできない条件が1つある** ＝ **セクション3のR1**。

> `(現ユーザー, b6e18eed-...)` の `property_members` 行が存在しなければ、
> 42P17は消えるが kv_store は 200 + 空 / 42501 になり、**問題は解決しない。**

したがって:

- **STEP 0-C（membership行の確認）を実行し、その結果を確認するまでSTEP 2へ進まない。**
- STEP 0-C で行が存在した → そのまま STEP 1 → STEP 2（無条件GO相当）
- STEP 0-C で行が無かった → STEP 1.5 を挟む（DBへのwrite1件。ユーザー判断）

この分岐が確定すれば、そのまま `SUPABASE500_FIX_DESIGN_GO` に格上げしてよい。

### 今回の作業範囲の遵守確認

| セクション6の禁止事項 | 実施状況 |
|---|---|
| DROP / CREATE / ALTER POLICY | ✅ 実行していない（SQL案の記述のみ） |
| schema.sql実行 / SQL Editorのwrite / migration | ✅ 実行していない |
| 製品コード変更 / index.html / supabase-integration.js / test / package.json | ✅ 1文字も変更していない |
| Phase 1E-A1 続行 / A2以降 | ✅ 着手していない |
| git add / commit / push / deploy | ✅ 実行していない |

**変更したファイルは、この設計書1つのみ（新規作成）。**
