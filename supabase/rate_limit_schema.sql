-- [2026-07-20新設] AI機能(点検希望時間連絡票のスキャン等)の利用回数制限・レート制限のための
-- テーブルと、判定+記録を1回のトランザクションで原子的に行うPostgres関数。
--
-- なぜPostgres関数(RPC)にしているか:
-- 「直近の呼び出し回数を数える(SELECT COUNT)」→「上限未満なら1件記録する(INSERT)」を
-- サーバー側のTypeScriptコードで2回に分けてSupabaseへ問い合わせる実装も可能だが、
-- ほぼ同時に2つのリクエストが届いた場合、両方が「上限未満」と判定してしまう競合
-- (TOCTOU: Time-Of-Check to Time-Of-Use)が起こり得る。この関数はCOUNTとINSERTを
-- 単一のSQL関数呼び出し(1トランザクション)にまとめることで、この競合を防いでいる。
--
-- 既存のschema.sql(properties / property_members / property_invites)に対する追加
-- マイグレーションとして、Supabaseダッシュボードの SQL Editor でこのファイルの内容を
-- 実行してください(既存テーブルには影響しません)。

create table if not exists api_usage_events (
  id bigint generated always as identity primary key,
  user_id uuid not null,
  endpoint text not null,
  created_at timestamptz not null default now()
);

-- user_id + endpoint + created_at の組み合わせで頻繁に絞り込むため、複合インデックスを張る。
create index if not exists idx_api_usage_events_user_endpoint_time
  on api_usage_events (user_id, endpoint, created_at desc);

-- endpoint + created_at だけで全ユーザー横断の集計(グローバル日次上限のチェック)も行うため、
-- こちらにもインデックスを張る。
create index if not exists idx_api_usage_events_endpoint_time
  on api_usage_events (endpoint, created_at desc);

alter table api_usage_events enable row level security;

-- 【重要】このテーブルには、authenticatedロール・anonロールいずれにも
-- 直接のSELECT/INSERT/UPDATE/DELETE権限を一切与えない(ポリシーを1つも作らない=
-- デフォルトで全操作拒否)。読み書きは、必ずこの下の check_and_record_api_usage()
-- 関数(SECURITY DEFINERのため、関数所有者=管理者権限で実行される)を経由してのみ
-- 行う。これにより、万が一ブラウザ側から直接このテーブルを読み書きしようとしても
-- (SUPABASE_ANON_KEYはブラウザに公開される前提の鍵のため)必ず拒否される。

-- 使い方(Route Handler側):
--   select * from check_and_record_api_usage(
--     p_user_id := '...',
--     p_endpoint := 'inspection-schedule.scan',
--     p_window_seconds := 60,
--     p_max_in_window := 5,
--     p_user_day_max := 200,
--     p_global_day_max := 5000
--   );
-- 戻り値: allowed(boolean), retry_after_seconds(int), reason(text|null)
-- allowed=false の場合、レコードは記録されない(=次のリクエストで改めて判定される)。
-- allowed=true の場合、この呼び出し自体が1件として記録される。

create or replace function check_and_record_api_usage(
  p_user_id uuid,
  p_endpoint text,
  p_window_seconds int,
  p_max_in_window int,
  p_user_day_max int,
  p_global_day_max int
) returns table(allowed boolean, retry_after_seconds int, reason text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_window_count int;
  v_oldest_in_window timestamptz;
  v_user_day_count int;
  v_global_day_count int;
begin
  -- ① 短時間バースト制限(例: 直近60秒に5回まで)
  select count(*), min(created_at) into v_window_count, v_oldest_in_window
    from api_usage_events
    where user_id = p_user_id
      and endpoint = p_endpoint
      and created_at > now() - make_interval(secs => p_window_seconds);

  if v_window_count >= p_max_in_window then
    return query select
      false,
      greatest(1, p_window_seconds - floor(extract(epoch from (now() - v_oldest_in_window)))::int),
      'rate_limited_burst'::text;
    return;
  end if;

  -- ② ユーザー単位の1日あたりの上限
  select count(*) into v_user_day_count
    from api_usage_events
    where user_id = p_user_id
      and endpoint = p_endpoint
      and created_at > now() - interval '1 day';

  if v_user_day_count >= p_user_day_max then
    return query select false, 86400, 'rate_limited_user_daily'::text;
    return;
  end if;

  -- ③ 全ユーザー合計の1日あたりの上限(万が一APIキーが漏洩し、複数アカウントから
  --    同時に濫用された場合でも、費用の上限を一定に保つための最終防衛ライン)
  select count(*) into v_global_day_count
    from api_usage_events
    where endpoint = p_endpoint
      and created_at > now() - interval '1 day';

  if v_global_day_count >= p_global_day_max then
    return query select false, 86400, 'rate_limited_global_daily'::text;
    return;
  end if;

  insert into api_usage_events (user_id, endpoint) values (p_user_id, p_endpoint);
  return query select true, 0, null::text;
end;
$$;

-- publicロール(未認証含む)からの直接実行を禁止し、service_role(サーバー側のみが使う鍵)
-- だけに実行権限を与える。
revoke all on function check_and_record_api_usage(uuid, text, int, int, int, int) from public;
grant execute on function check_and_record_api_usage(uuid, text, int, int, int, int) to service_role;
