-- ============================================================
--  网站民主议会
--  在 Supabase 控制台 → SQL Editor 中执行一次即可。
--
--  一张议题表、一张投票表。一人一票靠 (poll_id, voter) 唯一约束保证，
--  voter 是浏览器本地生成的一串随机字符。
-- ============================================================

create table if not exists public.polls (
  id         uuid primary key default gen_random_uuid(),
  title      text not null,
  kind       text not null default 'feature',
  options    jsonb not null,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.votes (
  id           uuid primary key default gen_random_uuid(),
  poll_id      uuid not null references public.polls(id) on delete cascade,
  option_index int not null check (option_index >= 0),
  voter        text not null check (char_length(voter) between 8 and 64),
  created_at   timestamptz not null default now(),
  unique (poll_id, voter)
);

create index if not exists votes_poll_idx on public.votes (poll_id);

alter table public.polls enable row level security;
alter table public.votes enable row level security;

-- 议题：所有人可读，不开放写入（加议题得手动在后台加）
drop policy if exists "polls readable by all" on public.polls;
create policy "polls readable by all"
  on public.polls for select using (true);

-- 投票：所有人可读（看结果），匿名可插入
drop policy if exists "votes readable by all" on public.votes;
create policy "votes readable by all"
  on public.votes for select using (true);

drop policy if exists "votes insertable by anon" on public.votes;
create policy "votes insertable by anon"
  on public.votes for insert
  with check (
    char_length(voter) between 8 and 64
    and option_index >= 0
  );

-- 初始议题：只在表还空的时候插一次
insert into public.polls (title, kind, options)
select * from (
  values
    (
      '下一次更新先做点什么？',
      'feature',
      '["访客留言板","相册","深浅主题切换","站内搜索"]'::jsonb
    ),
    (
      '下一篇写什么？',
      'article',
      '["C 语言的指针到底怎么理解","我为什么选智能制造","骑一百公里的体感记录"]'::jsonb
    ),
    (
      '大肥鱼今天穿什么？',
      'outfit',
      '["白 T 恤","连帽卫衣","小西装","睡衣"]'::jsonb
    )
) as t(title, kind, options)
where not exists (select 1 from public.polls);

-- ============================================================
--  说明
--  想加新议题，在 Table Editor 里往 polls 插一行即可，
--  options 填 JSON 数组，比如 ["选项一","选项二"]。
--  想停掉某条议题，把 active 改成 false。
-- ============================================================
