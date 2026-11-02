-- ============================================================
--  网站社会网络
--  在 Supabase 控制台 → SQL Editor 中执行一次即可。
--
--  身份用浏览器本地生成的 UUID，没有密码、没有登录。
--  代价：换设备或清缓存就是另一个人，无法跨设备找回。
-- ============================================================

-- 1) 访客资料 --------------------------------------------------
create table if not exists public.profiles (
  id         text primary key check (char_length(id) between 8 and 64),
  nickname   text not null check (char_length(nickname) between 1 and 16),
  avatar     text not null default 'whale',
  bio        text not null default '' check (char_length(bio) <= 80),
  created_at timestamptz not null default now(),
  last_seen  timestamptz not null default now()
);

create index if not exists profiles_seen_idx on public.profiles (last_seen desc);

-- 2) 关注关系 --------------------------------------------------
create table if not exists public.follows (
  id         uuid primary key default gen_random_uuid(),
  from_id    text not null,
  to_id      text not null,
  created_at timestamptz not null default now(),
  unique (from_id, to_id),
  check (from_id <> to_id)
);

create index if not exists follows_from_idx on public.follows (from_id);
create index if not exists follows_to_idx on public.follows (to_id);

-- 3) 权限 ------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.follows enable row level security;

-- 资料：谁都能读，匿名能写（id 是随机 UUID，猜不到别人的）
drop policy if exists "profiles readable" on public.profiles;
create policy "profiles readable"
  on public.profiles for select using (true);

drop policy if exists "profiles insertable" on public.profiles;
create policy "profiles insertable"
  on public.profiles for insert
  with check (
    char_length(id) between 8 and 64
    and char_length(nickname) between 1 and 16
    and char_length(bio) <= 80
  );

drop policy if exists "profiles updatable" on public.profiles;
create policy "profiles updatable"
  on public.profiles for update
  using (true)
  with check (
    char_length(nickname) between 1 and 16
    and char_length(bio) <= 80
  );

-- 关注：谁都能读，匿名能加和取消
drop policy if exists "follows readable" on public.follows;
create policy "follows readable"
  on public.follows for select using (true);

drop policy if exists "follows insertable" on public.follows;
create policy "follows insertable"
  on public.follows for insert
  with check (from_id <> to_id);

drop policy if exists "follows deletable" on public.follows;
create policy "follows deletable"
  on public.follows for delete using (true);

-- ============================================================
--  说明
--  身份不安全（没有密码），只适合做「常来的人互相认识一下」，
--  不承载任何权限。真要登录得另做 auth。
-- ============================================================
