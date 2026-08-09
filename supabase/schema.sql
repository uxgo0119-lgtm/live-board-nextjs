-- ============================================================================
-- FireFlow / Live Board - Supabase スキーマ
-- ============================================================================
-- 適用方法:
--   1. Supabaseダッシュボード → SQL Editor に貼り付けて実行
--   2. または: supabase db push （Supabase CLIを使う場合）
--
-- 【このファイルは何度実行してもエラーにならないように作ってあります】
--   途中でエラーが出て止まった場合や、内容を直して再実行したい場合も、
--   最初からもう一度全部貼り付けて実行して大丈夫です
--   （create policy の前に drop policy if exists を、
--    alter publication の前に「すでに登録済みなら無視」する処理を入れています）。
-- ============================================================================

create extension if not exists "pgcrypto"; -- gen_random_uuid() 用

-- ----------------------------------------------------------------------------
-- 1. profiles: 点検員のプロフィール（auth.usersに1:1で紐づく）
-- ----------------------------------------------------------------------------
create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null,
  created_at timestamptz not null default now()
);

alter table profiles enable row level security;

drop policy if exists "profiles_select_all_authenticated" on profiles;
create policy "profiles_select_all_authenticated"
  on profiles for select
  to authenticated
  using (true);

drop policy if exists "profiles_update_own" on profiles;
create policy "profiles_update_own"
  on profiles for update
  to authenticated
  using (id = auth.uid());

-- 新規ユーザー登録時に自動でprofilesレコードを作る
create or replace function handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name', new.email));
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();


-- ----------------------------------------------------------------------------
-- 2. properties: 点検対象物件
-- ----------------------------------------------------------------------------
create table if not exists properties (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  address text,
  created_at timestamptz not null default now(),
  created_by uuid references profiles(id)
);

alter table properties enable row level security;

-- 3. property_members: どのユーザーがどの物件にアクセスできるか
create table if not exists property_members (
  property_id uuid not null references properties(id) on delete cascade,
  user_id uuid not null references profiles(id) on delete cascade,
  role text not null default 'inspector', -- 'inspector' | 'admin'
  added_at timestamptz not null default now(),
  primary key (property_id, user_id)
);

alter table property_members enable row level security;

-- 【2026-07-17 発見・修正】このすぐ下の "property_members_select_own_properties" は
-- 元々 property_members テーブル自身に対して「property_membersにEXISTSで問い合わせる」
-- という自己参照ポリシーになっていた。PostgreSQLのRLSは、あるテーブルのポリシーの中で
-- 同じテーブルを問い合わせると、そのサブクエリにも同じポリシーが適用されるため、
-- これは無限再帰になる。ローカルPostgreSQL 16で実際に
-- `select * from property_members;`（authenticatedロール・auth.uid()設定済み）を
-- 実行したところ、実際に
-- 「ERROR: infinite recursion detected in policy for relation "property_members"」
-- が発生することを確認した。property_membersは他のほぼ全テーブル
-- （kv_store, room_results, defects, photos, equipment_state, extinguisher_state,
-- stamp_data, start_confirmations 等）のポリシーからEXISTSで間接的に参照されているため、
-- この1箇所の再帰が直る前は、それら全テーブルへのアクセスも道連れで失敗しうる状態だった。
-- Supabase公式が推奨する定番の回避策（SECURITY DEFINER関数でRLSを介さずに問い合わせ、
-- 自己参照を断ち切る）で修正する。
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

drop policy if exists "properties_select_members" on properties;
create policy "properties_select_members"
  on properties for select
  to authenticated
  using (
    exists (select 1 from property_members pm where pm.property_id = id and pm.user_id = auth.uid())
  );

drop policy if exists "properties_insert_authenticated" on properties;
create policy "properties_insert_authenticated"
  on properties for insert
  to authenticated
  with check (created_by = auth.uid());

drop policy if exists "property_members_select_own_properties" on property_members;
create policy "property_members_select_own_properties"
  on property_members for select
  to authenticated
  using (is_property_member(property_id));

-- 【2026-07-17 発見・修正：重要なセキュリティ上の穴】
-- 元の実装は「管理者だけが追加できる、ただし物件に誰もいなければ誰でも最初の1人になれる」
-- という条件でしたが、これだと2人目以降が永久に参加できなくなるバグがあったため、一時的に
-- 「ログインさえしていれば誰でも自分をどの物件にも追加できる」という緩い条件に修正していました。
-- しかし、この状態だと property_id さえ分かれば（推測できなくても、たとえば同じSupabase
-- プロジェクトを複数の物件・複数の管理会社で共用した場合など）誰でも他社の物件データに
-- 参加できてしまい、商品化（複数の顧客企業への展開）を考えると重大な情報漏洩リスクになる。
-- そのため、クライアントから直接 property_members へ insert する経路は廃止し、
-- 「①物件を作成した人は自動でadminになる（下記トリガー）」「②2人目以降は、adminが発行した
-- 招待リンク経由でのみ参加できる（下記 property_invites テーブル + api/accept-invite.js、
-- Service Role Keyでのみ実行される）」という2経路だけに絞った。
drop policy if exists "property_members_insert_admin" on property_members; -- 旧バージョンの名残があれば削除
drop policy if exists "property_members_insert_self" on property_members; -- 【廃止】誰でも自分を追加できた穴


-- ----------------------------------------------------------------------------
-- 3.5. property_invites: 物件への招待リンク（admin が発行し、リンクを知っている人だけ参加できる）
--     招待の受け入れ（property_membersへのinsert）は必ず api/accept-invite.js
--     （Service Role Key、サーバー側のみ）を経由させる。このテーブル自体への
--     直接アクセスはadminの発行・一覧・失効のみに限定し、招待される側（まだ
--     メンバーではない人）はこのテーブルを直接読めない（招待情報は
--     api/invite-info.js が最小限の情報だけを安全に返す）。
-- ----------------------------------------------------------------------------
create table if not exists property_invites (
  id uuid primary key default gen_random_uuid(), -- このIDが招待リンクの推測不可能なトークンを兼ねる
  property_id uuid not null references properties(id) on delete cascade,
  role text not null default 'inspector', -- この招待で付与する権限 'inspector' | 'admin'
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  expires_at timestamptz, -- nullなら無期限
  revoked_at timestamptz, -- nullでなければ失効済み（adminが手動で無効化した場合など）
  max_uses integer, -- nullなら無制限（何人でも同じリンクから参加できる）
  use_count integer not null default 0
);
alter table property_invites enable row level security;

-- 自己参照バグを避けるため、property_members同様 SECURITY DEFINER 関数で判定する
create or replace function is_property_admin(target_property_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from property_members pm
    where pm.property_id = target_property_id
      and pm.user_id = auth.uid()
      and pm.role = 'admin'
  );
$$;

drop policy if exists "property_invites_admin_select" on property_invites;
create policy "property_invites_admin_select"
  on property_invites for select
  to authenticated
  using (is_property_admin(property_id));

drop policy if exists "property_invites_admin_insert" on property_invites;
create policy "property_invites_admin_insert"
  on property_invites for insert
  to authenticated
  with check (is_property_admin(property_id) and created_by = auth.uid());

drop policy if exists "property_invites_admin_update" on property_invites;
create policy "property_invites_admin_update"
  on property_invites for update
  to authenticated
  using (is_property_admin(property_id))
  with check (is_property_admin(property_id));

-- 物件を新規作成した人を、自動でその物件のadminにする（招待なしで参加できる唯一の経路）
create or replace function auto_admin_on_property_create()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into property_members (property_id, user_id, role)
  values (new.id, auth.uid(), 'admin')
  on conflict (property_id, user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists trg_auto_admin_on_property_create on properties;
create trigger trg_auto_admin_on_property_create
  after insert on properties
  for each row execute function auto_admin_on_property_create();


-- ----------------------------------------------------------------------------
-- 4. inspections: 点検セッション（物件×点検日で1件）
-- ----------------------------------------------------------------------------
create table if not exists inspections (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references properties(id) on delete cascade,
  inspection_date date not null,
  inspection_type text, -- '機器点検' | '総合点検'
  start_time time,
  end_time time,
  actual_start_time time,
  actual_end_time time,
  site_supervisor text,
  created_at timestamptz not null default now(),
  unique (property_id, inspection_date)
);

alter table inspections enable row level security;

drop policy if exists "inspections_all_property_members" on inspections;
create policy "inspections_all_property_members"
  on inspections for all
  to authenticated
  using (exists (select 1 from property_members pm where pm.property_id = inspections.property_id and pm.user_id = auth.uid()))
  with check (exists (select 1 from property_members pm where pm.property_id = inspections.property_id and pm.user_id = auth.uid()));


-- ----------------------------------------------------------------------------
-- 5. room_results: 部屋ごとの点検結果
-- ----------------------------------------------------------------------------
create table if not exists room_results (
  id uuid primary key default gen_random_uuid(),
  inspection_id uuid not null references inspections(id) on delete cascade,
  room text not null,
  status text not null default 'pending', -- 'pending' | 'done' | 'absent'
  cancelled boolean not null default false,
  signature text,
  inspector text,
  inspected_at timestamptz,
  visit_times jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid references profiles(id),
  unique (inspection_id, room)
);

alter table room_results enable row level security;

drop policy if exists "room_results_all_property_members" on room_results;
create policy "room_results_all_property_members"
  on room_results for all
  to authenticated
  using (
    exists (
      select 1 from inspections i
      join property_members pm on pm.property_id = i.property_id
      where i.id = room_results.inspection_id and pm.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from inspections i
      join property_members pm on pm.property_id = i.property_id
      where i.id = room_results.inspection_id and pm.user_id = auth.uid()
    )
  );


-- ----------------------------------------------------------------------------
-- 6. defects: 不良箇所（部屋別 or 共用部）
-- ----------------------------------------------------------------------------
create table if not exists defects (
  id uuid primary key default gen_random_uuid(),
  inspection_id uuid not null references inspections(id) on delete cascade,
  room_result_id uuid references room_results(id) on delete cascade, -- 共用部の場合はnull
  location_label text, -- '共用部・屋外' など、room_result_idがnullの時に使う
  tag text not null,
  memo text,
  created_at timestamptz not null default now()
);

alter table defects enable row level security;

drop policy if exists "defects_all_property_members" on defects;
create policy "defects_all_property_members"
  on defects for all
  to authenticated
  using (
    exists (
      select 1 from inspections i
      join property_members pm on pm.property_id = i.property_id
      where i.id = defects.inspection_id and pm.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from inspections i
      join property_members pm on pm.property_id = i.property_id
      where i.id = defects.inspection_id and pm.user_id = auth.uid()
    )
  );


-- ----------------------------------------------------------------------------
-- 7. photos: 写真（実体はSupabase Storageに保存し、ここはメタデータのみ）
-- ----------------------------------------------------------------------------
create table if not exists photos (
  id uuid primary key default gen_random_uuid(),
  inspection_id uuid not null references inspections(id) on delete cascade,
  room_result_id uuid references room_results(id) on delete cascade,
  defect_id uuid references defects(id) on delete cascade,
  equipment_name text, -- 設備点検の写真の場合
  extinguisher_no text, -- 消火器点検の写真の場合
  storage_path text not null, -- Supabase Storage上のパス
  tag text,
  memo text,
  taken_by uuid references profiles(id),
  taken_at timestamptz not null default now()
);

alter table photos enable row level security;

drop policy if exists "photos_all_property_members" on photos;
create policy "photos_all_property_members"
  on photos for all
  to authenticated
  using (
    exists (
      select 1 from inspections i
      join property_members pm on pm.property_id = i.property_id
      where i.id = photos.inspection_id and pm.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from inspections i
      join property_members pm on pm.property_id = i.property_id
      where i.id = photos.inspection_id and pm.user_id = auth.uid()
    )
  );


-- ----------------------------------------------------------------------------
-- 8. equipment_state / extinguisher_state: 設備点検・消火器点検の状態
-- ----------------------------------------------------------------------------
create table if not exists equipment_state (
  id uuid primary key default gen_random_uuid(),
  inspection_id uuid not null references inspections(id) on delete cascade,
  equipment_name text not null,
  status text not null default 'pending', -- 'pending' | 'done'
  memo text,
  updated_at timestamptz not null default now(),
  unique (inspection_id, equipment_name)
);
alter table equipment_state enable row level security;
drop policy if exists "equipment_state_all_property_members" on equipment_state;
create policy "equipment_state_all_property_members" on equipment_state for all to authenticated
  using (exists (select 1 from inspections i join property_members pm on pm.property_id = i.property_id where i.id = equipment_state.inspection_id and pm.user_id = auth.uid()))
  with check (exists (select 1 from inspections i join property_members pm on pm.property_id = i.property_id where i.id = equipment_state.inspection_id and pm.user_id = auth.uid()));

create table if not exists extinguisher_state (
  id uuid primary key default gen_random_uuid(),
  inspection_id uuid not null references inspections(id) on delete cascade,
  extinguisher_no text not null,
  unclear boolean not null default false,
  memo text,
  updated_at timestamptz not null default now(),
  unique (inspection_id, extinguisher_no)
);
alter table extinguisher_state enable row level security;
drop policy if exists "extinguisher_state_all_property_members" on extinguisher_state;
create policy "extinguisher_state_all_property_members" on extinguisher_state for all to authenticated
  using (exists (select 1 from inspections i join property_members pm on pm.property_id = i.property_id where i.id = extinguisher_state.inspection_id and pm.user_id = auth.uid()))
  with check (exists (select 1 from inspections i join property_members pm on pm.property_id = i.property_id where i.id = extinguisher_state.inspection_id and pm.user_id = auth.uid()));


-- ----------------------------------------------------------------------------
-- 9. stamp_data: 点検希望時間連絡票のデータ（捺印表β）
-- ----------------------------------------------------------------------------
create table if not exists stamp_data (
  id uuid primary key default gen_random_uuid(),
  inspection_id uuid not null references inspections(id) on delete cascade,
  room text not null,
  symbol text, -- 'A' | 'P' | 'T' | 'C'
  time_from text,
  time_to text,
  name text,
  note text,
  updated_at timestamptz not null default now(),
  unique (inspection_id, room)
);
alter table stamp_data enable row level security;
drop policy if exists "stamp_data_all_property_members" on stamp_data;
create policy "stamp_data_all_property_members" on stamp_data for all to authenticated
  using (exists (select 1 from inspections i join property_members pm on pm.property_id = i.property_id where i.id = stamp_data.inspection_id and pm.user_id = auth.uid()))
  with check (exists (select 1 from inspections i join property_members pm on pm.property_id = i.property_id where i.id = stamp_data.inspection_id and pm.user_id = auth.uid()));


-- ----------------------------------------------------------------------------
-- 10. kv_store: 上記以外の雑多な状態（物件概要メモ、建物概要テーブルなど）
--     window.storage 互換のキー・バリュー保存先として使う
-- ----------------------------------------------------------------------------
create table if not exists kv_store (
  id bigint generated always as identity primary key,
  property_id uuid not null references properties(id) on delete cascade,
  key text not null,
  value text,
  shared boolean not null default true,
  owner_id uuid references profiles(id), -- shared=falseの時のみ使用
  updated_at timestamptz not null default now(),
  unique (property_id, key, shared, owner_id)
  -- 【注意】PostgreSQLはNULL同士を「等しい」とみなさないため、shared=trueの行
  -- （owner_idが常にNULL）は、このunique制約だけでは重複を防げません。
  -- 重複INSERTを防ぐ処理は supabase-integration.js 側（select→update/insertの
  -- 手動upsert）で行っています。ON CONFLICTに頼った素朴なupsertを使うと、
  -- 保存するたびに行が増え続けるバグになるので注意してください。
);
alter table kv_store enable row level security;
drop policy if exists "kv_store_all_property_members" on kv_store;
create policy "kv_store_all_property_members" on kv_store for all to authenticated
  using (exists (select 1 from property_members pm where pm.property_id = kv_store.property_id and pm.user_id = auth.uid()))
  with check (exists (select 1 from property_members pm where pm.property_id = kv_store.property_id and pm.user_id = auth.uid()));


-- ----------------------------------------------------------------------------
-- 10.5. (2026-07-17廃止) start_confirmations
--     点検開始前の管理会社・セキュリティ会社への確認連絡機能は、LB本体側のUIごと
--     削除した（confirm.html / api/confirm-start.js も削除済み）。既にこのテーブルを
--     作成済みの環境では、不要になったため任意のタイミングで
--     `drop table if exists start_confirmations;` を実行して構わない（他テーブルから
--     参照されていないため安全）。新規セットアップではこのテーブルは作成されない。
-- ----------------------------------------------------------------------------


-- ----------------------------------------------------------------------------
-- 11. Realtime: 進捗のリアルタイム反映に必要なテーブルを publication に追加
--     すでに登録済みのテーブルに対して実行するとエラーになるため、
--     「登録済みなら何もしない」処理で包んでいます。
-- ----------------------------------------------------------------------------
do $$
begin
  alter publication supabase_realtime add table room_results;
exception when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table equipment_state;
exception when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table extinguisher_state;
exception when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table stamp_data;
exception when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table kv_store;
exception when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table property_invites;
exception when duplicate_object then null;
end $$;


-- ----------------------------------------------------------------------------
-- 12. Storage: 写真保存用バケット
-- ----------------------------------------------------------------------------
-- 2026-07-17 修正：以前はこのバケットのポリシーが bucket_id しかチェックしておらず、
-- ログインさえしていれば他社(他物件)の点検写真ファイルを直接read/overwrite/deleteできる
-- 状態だった（招待制御の修正で photos テーブル側のメタデータは物件メンバー限定にしていたが、
-- Storage上の実ファイルの方は見落としていた）。uploadInspectionPhoto()（supabase-integration.js）
-- が書き込むパスは "{property_id}/{room}/{timestamp}-{random}.{ext}" という形式なので、
-- パスの先頭セグメント(property_id)を取り出してis_property_member()でチェックする。
-- 想定外の形式のパス(先頭セグメントがUUIDでない等)は例外を握りつぶしてfalseを返す
-- (RLSポリシー内でキャスト例外を直接投げるとリクエストがエラーになってしまうため)。
create or replace function storage_object_is_property_member(object_name text)
returns boolean
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  folder text;
  pid uuid;
begin
  folder := (storage.foldername(object_name))[1];
  if folder is null then
    return false;
  end if;
  begin
    pid := folder::uuid;
  exception when others then
    return false;
  end;
  return is_property_member(pid);
end;
$$;

insert into storage.buckets (id, name, public)
values ('inspection-photos', 'inspection-photos', false)
on conflict (id) do nothing;

drop policy if exists "inspection_photos_select_authenticated" on storage.objects;
create policy "inspection_photos_select_authenticated"
  on storage.objects for select
  to authenticated
  using (bucket_id = 'inspection-photos' and storage_object_is_property_member(name));

drop policy if exists "inspection_photos_insert_authenticated" on storage.objects;
create policy "inspection_photos_insert_authenticated"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'inspection-photos' and storage_object_is_property_member(name));

drop policy if exists "inspection_photos_delete_authenticated" on storage.objects;
create policy "inspection_photos_delete_authenticated"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'inspection-photos' and storage_object_is_property_member(name));
