-- ============================================================
--  访客头像墙
--  在 Supabase 控制台 → SQL Editor 中执行一次即可。
--
--  一共有三件事：建表、开 RLS、建存储桶和策略。
-- ============================================================

-- 1) 头像记录表 -------------------------------------------------
create table if not exists public.visitor_avatars (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (char_length(name) between 1 and 16),
  avatar_url text not null,
  created_at timestamptz not null default now()
);

create index if not exists visitor_avatars_created_idx
  on public.visitor_avatars (created_at desc);

alter table public.visitor_avatars enable row level security;

-- 谁都能看
drop policy if exists "visitors readable by all" on public.visitor_avatars;
create policy "visitors readable by all"
  on public.visitor_avatars for select
  using (true);

-- 匿名可插入（访客不留账号）。不允许改和删。
drop policy if exists "visitors insertable by anon" on public.visitor_avatars;
create policy "visitors insertable by anon"
  on public.visitor_avatars for insert
  with check (
    char_length(name) between 1 and 16
    and avatar_url like 'http%'
  );

-- 2) 存储桶 -----------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('visitors', 'visitors', true, 2097152, array['image/webp', 'image/png', 'image/jpeg'])
on conflict (id) do update
  set public = true,
      file_size_limit = 2097152,
      allowed_mime_types = array['image/webp', 'image/png', 'image/jpeg'];

-- 公开可读
drop policy if exists "visitors bucket public read" on storage.objects;
create policy "visitors bucket public read"
  on storage.objects for select
  using (bucket_id = 'visitors');

-- 匿名可上传（前端已压到 240px，正常只有几十 KB）
drop policy if exists "visitors bucket anon upload" on storage.objects;
create policy "visitors bucket anon upload"
  on storage.objects for insert
  with check (bucket_id = 'visitors');

-- ============================================================
--  说明
--  匿名上传意味着任何人写个脚本就能往墙里塞东西。
--  真被刷了直接在后台删记录即可，或者临时把这几个 policy 删掉。
-- ============================================================
