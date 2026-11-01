-- ============================================================
--  匿名树洞
--  在 Supabase 控制台 → SQL Editor 中执行一次即可。
--
--  三张表：留言、回应、每日话题。
--  留言和回应都只开「读 + 匿名插入」，不开放改和删，
--  精选和删除都走后台手动操作。
-- ============================================================

-- 1) 留言 ------------------------------------------------------
create table if not exists public.holes (
  id         uuid primary key default gen_random_uuid(),
  content    text not null check (char_length(content) between 1 and 500),
  nick       text not null check (char_length(nick) between 1 and 24),
  featured   boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists holes_created_idx on public.holes (created_at desc);
create index if not exists holes_featured_idx on public.holes (featured, created_at desc);

-- 2) 回应 ------------------------------------------------------
create table if not exists public.hole_replies (
  id         uuid primary key default gen_random_uuid(),
  hole_id    uuid not null references public.holes(id) on delete cascade,
  content    text not null check (char_length(content) between 1 and 300),
  nick       text not null check (char_length(nick) between 1 and 24),
  created_at timestamptz not null default now()
);

create index if not exists hole_replies_hole_idx on public.hole_replies (hole_id, created_at);

-- 3) 每日话题 --------------------------------------------------
create table if not exists public.hole_topics (
  id         uuid primary key default gen_random_uuid(),
  day        date not null unique,
  topic      text not null check (char_length(topic) between 1 and 80),
  created_at timestamptz not null default now()
);

-- 4) 权限 ------------------------------------------------------
alter table public.holes enable row level security;
alter table public.hole_replies enable row level security;
alter table public.hole_topics enable row level security;

-- 留言：谁都能读，匿名能写，不能改不能删
drop policy if exists "holes readable" on public.holes;
create policy "holes readable"
  on public.holes for select using (true);

drop policy if exists "holes insertable" on public.holes;
create policy "holes insertable"
  on public.holes for insert
  with check (
    char_length(content) between 1 and 500
    and char_length(nick) between 1 and 24
  );

-- 回应：同上
drop policy if exists "replies readable" on public.hole_replies;
create policy "replies readable"
  on public.hole_replies for select using (true);

drop policy if exists "replies insertable" on public.hole_replies;
create policy "replies insertable"
  on public.hole_replies for insert
  with check (
    char_length(content) between 1 and 300
    and char_length(nick) between 1 and 24
  );

-- 话题：只读（内容由站长在后台维护）
drop policy if exists "topics readable" on public.hole_topics;
create policy "topics readable"
  on public.hole_topics for select using (true);

-- 5) 初始话题 --------------------------------------------------
insert into public.hole_topics (day, topic)
select current_date, '今天有什么小事让你开心？'
where not exists (select 1 from public.hole_topics);

-- ============================================================
--  站长操作
--
--  设今天的议题：
--    insert into hole_topics (day, topic) values (current_date, '你的话题')
--    on conflict (day) do update set topic = excluded.topic;
--
--  精选某条留言：
--    update holes set featured = true where id = '那条的 id';
--
--  删掉不合适的留言（回应会跟着删）：
--    delete from holes where id = '那条的 id';
-- ============================================================
