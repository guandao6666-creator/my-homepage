-- ============================================================
--  访客排行榜
--  在 Supabase 控制台 → SQL Editor 中执行一次即可。
--
--  设计上不直接开放 update 权限，改走 report_time 函数：
--  函数内部限流、累加，避免有人改别人的记录。
-- ============================================================

create table if not exists public.visitor_rank (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (char_length(name) between 1 and 16),
  seconds    integer not null default 0 check (seconds >= 0),
  visits     integer not null default 1,
  updated_at timestamptz not null default now()
);

create unique index if not exists visitor_rank_name_key
  on public.visitor_rank (name);

alter table public.visitor_rank enable row level security;

-- 谁都能看榜
drop policy if exists "rank readable by all" on public.visitor_rank;
create policy "rank readable by all"
  on public.visitor_rank for select
  using (true);

-- 不开放 insert / update / delete 给 anon，只给函数用

-- 上报时长：单次最多计 12 小时，防止有人塞个大数
create or replace function public.report_time(p_name text, p_seconds int)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  safe_name text := btrim(p_name);
  safe_secs int := greatest(0, least(coalesce(p_seconds, 0), 43200));
begin
  if char_length(safe_name) < 1 or char_length(safe_name) > 16 then
    raise exception 'name must be 1-16 chars';
  end if;

  insert into public.visitor_rank (name, seconds, visits)
  values (safe_name, safe_secs, 1)
  on conflict (name) do update
    set seconds = public.visitor_rank.seconds + safe_secs,
        visits = public.visitor_rank.visits + 1,
        updated_at = now();
end;
$$;

grant execute on function public.report_time(text, int) to anon;

-- ============================================================
--  说明
--  seconds 单位是秒，排行榜按它排。
--  前端每 60 秒报一次增量，不是全量。
-- ============================================================
