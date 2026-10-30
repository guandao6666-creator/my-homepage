# 管道的博客

一个可以直接上线的个人博客：Astro 静态渲染 + 云端内容与认证。

- **线上地址**：https://guandao.xin
- **文章列表 / 详情 / 标签 / 关于**：完整的信息架构
- **Markdown 渲染**：构建期编译，代码高亮、目录锚点、阅读时长全部预生成
- **云端能力**：Supabase 提供 PostgreSQL 数据库、Auth 登录认证、Storage 对象存储
- **零运行时框架**：除了 2KB 的交互脚本，页面就是纯 HTML + CSS

## 快速开始

```bash
npm install
npm run dev        # http://localhost:4321
npm run build      # 产物在 dist/
npm run preview    # 预览构建结果
```

不配置任何云端变量也能跑起来：文章来自 `src/content/blog/*.md`，
图片放在 `public/uploads/`。云端相关的入口会显示配置引导，而不是报错。

## 目录结构

```
src/
├─ content/blog/          文章 Markdown（云端同步的落地位置）
├─ lib/
│  ├─ site.ts             站点配置：标题、导航、作者、日期格式化
│  ├─ posts.ts            内容查询：列表、标签统计、相关文章、阅读时长
│  └─ cloud.ts            云端 client：登录、增删改查、文件上传（REST，无 SDK）
├─ layouts/BaseLayout.astro  文档骨架：SEO、OG、JSON-LD、主题脚本
├─ components/            Header / Footer / PostCard / Icon
├─ pages/
│  ├─ index.astro         首页
│  ├─ blog/index.astro    文章归档（关键词搜索 + 标签筛选）
│  ├─ blog/[slug].astro   文章详情（目录、进度、上下篇、相关阅读）
│  ├─ tags/               标签总览与标签页
│  ├─ about.astro         关于
│  ├─ admin/index.astro   写作后台（登录后才能用）
│  ├─ rss.xml.ts          RSS
│  └─ 404.astro
└─ styles/global.css      设计系统：颜色变量、排版、Markdown 正文样式
scripts/
├─ sync-content.mjs       构建前把云端文章同步为本地 Markdown
├─ serve-dist.mjs         本地静态预览服务器
└─ qa.mjs                 截图 + 横向溢出检测（视觉质检）
supabase/schema.sql       建表、RLS 策略、Storage 桶与权限
```

## 云端配置（数据库 / 存储 / 登录）

1. 新建 Supabase 项目，在 SQL Editor 里执行 `supabase/schema.sql`。
2. 在 Authentication → Users 里添加一个账号（建议关闭邮箱验证，自己用）。
3. 复制 `.env.example` 为 `.env`，填入项目 URL 与 anon key：

```bash
cp .env.example .env
```

| 变量 | 用途 |
| --- | --- |
| `PUBLIC_SUPABASE_URL` | 项目地址，前端也会用到 |
| `PUBLIC_SUPABASE_ANON_KEY` | 公开密钥，受 RLS 保护，可以出现在浏览器 |
| `PUBLIC_SUPABASE_BUCKET` | 媒体桶名，默认 `blog-media` |
| `SUPABASE_URL` / `SUPABASE_ANON_KEY` | 供构建期同步脚本使用 |

4. 打开 `/admin` 登录，即可新建、编辑、发布、上传图片。

### 数据是怎么走到页面上的

```
Supabase (Postgres)
        │  npm run sync（prebuild 自动执行）
        ▼
src/content/blog/*.md
        │  astro build
        ▼
dist/**/index.html  →  CDN / 静态托管
```

写作在云端进行，发布仍然是一份纯静态产物。所以：

- 后台保存文章后，需要重新构建一次站点（CI 里推送代码即触发）；
- 渲染管线只有一条，本地写 Markdown 和云端写作最终都走同一套逻辑。

### 权限模型

`posts` 表启用了 RLS：

- 匿名用户只能 `select` 已发布文章（`published = true`）；
- 只有通过认证的用户才能增删改；
- Storage 桶公开可读，写入需要登录。

anon key 会出现在前端代码里，这是设计如此——**密钥公开不等于数据公开**。

## 部署

构建产物是纯静态的，任何静态托管都能用（Cloudflare Pages / Vercel / Netlify / 对象存储）。
以 Cloudflare Pages 为例：

- 构建命令：`npm run build`
- 输出目录：`dist`
- 环境变量：上面的四个 Supabase 变量
- Node 版本：>= 22.23.4（Astro 7 要求）

## 内容约定

文章 frontmatter：

```yaml
---
title: "标题"
description: "列表页与 SEO 用的摘要"
pubDate: 2026-10-28
updatedDate: 2026-10-30   # 可选
tags: ["技术", "Astro"]
featured: true             # 可选，首页精选
draft: false               # true 时构建期会被排除
cover: https://…           # 可选，留空则用标签色生成渐变封面
---
```

## 脚本

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 开发服务器 |
| `npm run build` | 构建（会先尝试同步云端文章） |
| `npm run sync` | 强制从云端同步文章，缺配置时报错 |
| `node scripts/serve-dist.mjs` | 本地跑构建产物 |
| `node scripts/qa.mjs <url> <out.png> <宽> <高> [--full]` | 截图并检测横向溢出 |

## 设计说明

- 版式：中文正文 700px 宽、行高 1.95，标题用衬线体，正文用无衬线体。
- 颜色：一个强调色（墨绿），只出现在可点击、被选中的元素上。
- 深色模式：所有颜色变量成对定义，代码高亮使用 Shiki 双主题。
- 动效：全站唯一语言是「短距离上浮 + 淡入」，并尊重 `prefers-reduced-motion`。
