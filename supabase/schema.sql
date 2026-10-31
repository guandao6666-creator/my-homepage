-- ============================================================
--  博客云端数据结构（Supabase / PostgreSQL）
--  在 Supabase 控制台 → SQL Editor 中执行一次即可。
-- ============================================================

-- 1) 文章表 ---------------------------------------------------
create table if not exists public.posts (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique,
  title       text not null,
  description text not null default '',
  content     text not null default '',
  tags        text[] not null default '{}',
  published   boolean not null default false,
  featured    boolean not null default false,
  cover_url   text,
  pub_date    timestamptz not null default now(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  author_id   uuid references auth.users (id) on delete set null
);

create index if not exists posts_pub_date_idx on public.posts (pub_date desc);
create index if not exists posts_tags_idx on public.posts using gin (tags);

-- 自动维护 updated_at
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists posts_touch_updated_at on public.posts;
create trigger posts_touch_updated_at
  before update on public.posts
  for each row execute function public.touch_updated_at();

-- 2) 行级安全（RLS） ------------------------------------------
-- 公开站点只能读「已发布」的文章；写操作只允许已登录用户。
alter table public.posts enable row level security;

drop policy if exists "posts_public_read" on public.posts;
create policy "posts_public_read"
  on public.posts for select
  to anon, authenticated
  using (published = true or auth.role() = 'authenticated');

drop policy if exists "posts_author_write" on public.posts;
create policy "posts_author_write"
  on public.posts for all
  to authenticated
  using (true)
  with check (true);

-- 3) 对象存储（图片 / 附件） ----------------------------------
insert into storage.buckets (id, name, public)
values ('blog-media', 'blog-media', true)
on conflict (id) do nothing;

drop policy if exists "media_public_read" on storage.objects;
create policy "media_public_read"
  on storage.objects for select
  to anon, authenticated
  using (bucket_id = 'blog-media');

drop policy if exists "media_auth_write" on storage.objects;
create policy "media_auth_write"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'blog-media');

drop policy if exists "media_auth_update" on storage.objects;
create policy "media_auth_update"
  on storage.objects for update
  to authenticated
  using (bucket_id = 'blog-media');

drop policy if exists "media_auth_delete" on storage.objects;
create policy "media_auth_delete"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'blog-media');

-- 4) 文章评论（互动栏） ---------------------------------------
-- 访客不用注册，填个昵称就能留言；站长登录后可以删除/隐藏。
create table if not exists public.comments (
  id         uuid primary key default gen_random_uuid(),
  post_slug  text not null,
  author     text not null,
  body       text not null,
  created_at timestamptz not null default now(),
  visible    boolean not null default true
);

create index if not exists comments_slug_idx
  on public.comments (post_slug, created_at desc);

alter table public.comments enable row level security;

-- 所有人都能读到可见评论（隐藏的只有登录用户能取到）
drop policy if exists "comments_read" on public.comments;
create policy "comments_read"
  on public.comments for select
  to anon, authenticated
  using (visible = true);

-- 任何人可留言，但不能自己塞隐藏状态，长度也有硬限制
drop policy if exists "comments_insert" on public.comments;
create policy "comments_insert"
  on public.comments for insert
  to anon, authenticated
  with check (
    visible = true
    and char_length(btrim(author)) between 1 and 24
    and char_length(btrim(body)) between 1 and 800
  );

-- 站长（登录用户）可以改和删
drop policy if exists "comments_admin" on public.comments;
create policy "comments_admin"
  on public.comments for all
  to authenticated
  using (true)
  with check (true);

-- 5) 评论的回复 + 点赞 -----------------------------------------
-- 回复只有一层：parent_id 指向顶层留言，回复的回复也挂在同一个父级上。
alter table public.comments
  add column if not exists parent_id uuid references public.comments(id) on delete cascade;

create index if not exists comments_parent_idx on public.comments (parent_id);

-- 文章和评论共用一张点赞表，靠 target_type 区分。
create table if not exists public.likes (
  id          uuid primary key default gen_random_uuid(),
  target_type text not null check (target_type in ('post', 'comment')),
  target_id   text not null,
  visitor     text not null,
  created_at  timestamptz not null default now(),
  unique (target_type, target_id, visitor)
);

create index if not exists likes_target_idx on public.likes (target_type, target_id);

alter table public.likes enable row level security;

drop policy if exists "likes_read" on public.likes;
create policy "likes_read"
  on public.likes for select
  to anon, authenticated
  using (true);

-- 只允许新增：点赞不可取消，也防止有人批量删掉别人的赞
drop policy if exists "likes_insert" on public.likes;
create policy "likes_insert"
  on public.likes for insert
  to anon, authenticated
  with check (
    char_length(visitor) between 8 and 64
    and char_length(target_id) between 1 and 80
  );

-- 站长可以清理异常点赞（访客仍然删不了）
drop policy if exists "likes_admin" on public.likes;
create policy "likes_admin"
  on public.likes for all
  to authenticated
  using (true)
  with check (true);

-- ============================================================
--  使用说明
--  1. Authentication → Users → Add user 创建一个账号（关闭邮箱验证更方便）。
--  2. 把项目 URL / anon key 写进 .env（见 .env.example）。
--  3. npm run dev 打开 /admin 登录写作；npm run build 会自动从云端同步文章。
--  4. 删除垃圾评论：Table Editor → comments → 删行，或把 visible 关掉。
-- ============================================================
