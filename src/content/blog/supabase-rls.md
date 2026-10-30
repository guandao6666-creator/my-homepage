---
title: "静态站点也能有云端后台：Supabase + RLS 的一次实践"
description: "不用自己写服务端，也能有登录、数据库和对象存储。记录一次把静态博客接上云端后端的完整取舍。"
pubDate: 2026-10-12
tags: ["后端", "数据库", "部署"]
---

静态站最舒服的地方是"没有服务器要管"，最难受的地方是"想在手机上改一篇文章都做不到"。

这次我给博客加后台，目标很明确：**写作要能在任何设备上进行，但线上仍然是一份纯静态文件。**

## 为什么不自己写后端

三条路我都想过：

- **自建 Node 服务**：灵活，但要一直维护进程、备份、升级依赖，个人博客不值得。
- **纯 CMS（如 Contentful）**：省事，但数据不在自己手里，导出还受限制。
- **BaaS**：数据库、认证、存储都在一个平台里，权限用 SQL 策略表达。

我选了第三条，具体是 Supabase（本质是一套 Postgres + PostgREST + GoTrue + Storage）。

## 数据长什么样

一张表就够：

```sql
create table public.posts (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique,
  title       text not null,
  description text not null default '',
  content     text not null default '',
  tags        text[] not null default '{}',
  published   boolean not null default false,
  pub_date    timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index posts_tags_idx on public.posts using gin (tags);
```

`tags` 用 `text[]` 而不是关联表，是因为博客的标签不需要独立生命周期——它只是文章上的一个字符串集合。真要做标签重命名，一条 `update ... set tags = array_replace(...)` 就够了。

## 权限写在数据库里

这是我更喜欢 BaaS 的地方：安全规则不是散落在接口里的 `if`，而是数据库层的策略。

```sql
alter table public.posts enable row level security;

-- 任何人只能读已发布的文章
create policy "posts_public_read"
  on public.posts for select
  to anon
  using (published = true);

-- 登录用户可以做任何事
create policy "posts_author_write"
  on public.posts for all
  to authenticated
  using (true) with check (true);
```

即使有人拿到 anon key（它本来就会出现在前端代码里），也只能读到已发布内容。**密钥公开不等于数据公开**，这个区别值得记住。

## 构建时同步，而不是运行时请求

后台写完之后有个关键决定：线上页面怎么拿数据？

方案 A 是打开页面时用 JS 请求 API。方案 B 是构建时把云端数据抓下来，生成本地 Markdown，走原来的静态渲染管线。

我选了 B：

```bash
nodescripts/sync-content.mjs   # 拉取云端文章 → src/content/blog/*.md
astro build                    # 照常静态渲染
```

好处是**渲染管线只有一条**：开发时写本地文件，线上用云端数据，两条路最终都汇到同一套 Markdown 处理流程里。代码高亮、目录、RSS 都不用改。

代价是"写完要重新构建"。对博客来说这不是问题——我把同步挂到 `prebuild`，推送代码触发部署时自然就跑完了。

## 文件上传

图片和附件走 Storage，公开桶 + 只允许登录用户写入：

```sql
insert into storage.buckets (id, name, public)
values ('blog-media', 'blog-media', true);
```

上传后拿到的是公开 URL，直接写进 Markdown：

```md
![构建流程图](https://xxx.supabase.co/storage/v1/object/public/blog-media/uploads/flow.png)
```

## 复盘

这套组合让我用不到 300 行代码就有了登录、增删改查和文件上传，同时保住了静态站的速度。

如果要提醒一句：**先把"内容怎么渲染"想清楚，再决定"内容存在哪"。** 反过来做，通常会把架构搞复杂。
