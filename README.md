# 管道的博客

一个可以直接上线的个人博客：Astro 静态渲染 + 云端内容与认证。

> **Guandao OS 2.0 · The Platform Era（平台时代）**  
> 正式的平台化版本：统一的 Core 内核（启动流程 / 生命周期 / 事件总线 / 错误隔离）、
> 应用注册中心与正式 Manifest、默认拒绝的权限服务、Window System 3.0、
> 八类设置的 System Center、七步首次启动引导、更新中心，以及应用 / 插件 / 主题 /
> 组件 / 壁纸 / 工作空间 / 社区的统一市场。  
> 交付报告与发布说明见 [`docs/RELEASE-2.0.md`](docs/RELEASE-2.0.md)；
> 架构见 [`docs/ARCHITECTURE-2.0.md`](docs/ARCHITECTURE-2.0.md)，
> 数据迁移见 [`docs/MIGRATION-2.0.md`](docs/MIGRATION-2.0.md)，
> 全项目审计见 [`GUANDAO_2_0_AUDIT.md`](GUANDAO_2_0_AUDIT.md)，
> 后续实施路线图见 [`GUANDAO_2_0_ROADMAP.md`](GUANDAO_2_0_ROADMAP.md)，
> 开发者 SDK 见 [`docs/SDK-1.md`](docs/SDK-1.md)，
> 云端 API 规范见 [`docs/API-2.0.md`](docs/API-2.0.md)，
> 发布验收清单见 [`docs/ACCEPTANCE-2.0.md`](docs/ACCEPTANCE-2.0.md)。
> 1.9 的质量报告见 [`docs/QUALITY-1.9.md`](docs/QUALITY-1.9.md)。
>
> **发布状态**：2026-11-05 已部署到 Cloudflare 生产（https://guandao.xin，版本 `8866fe13`），
> 线上 `/api/health`、内核启动、CSP 与数据完整性均已复核。

- **线上地址**：https://guandao.xin
- **页面**：首页 / 文章 / 笔记 / 系列 / 标签 / 归档 / 骑行 / 作品 / 我用什么 / 关于
- **阅读体验**：全文搜索（命中正文并给上下文）、代码块一键复制、移动端折叠目录、图片灯箱、阅读进度
- **内容组织**：标签、系列（按序号串联）、按年月归档的时间轴
- **社交**：每篇文章构建期生成独立的 1200×630 分享图，另有 RSS、sitemap、JSON-LD
- **云端能力**：Supabase 提供 PostgreSQL 数据库、Auth 登录认证、Storage 对象存储
- **零运行时框架**：页面就是纯 HTML + CSS，交互只有少量原生脚本

## 快速开始

```bash
npm install
npm run dev        # http://localhost:4321
npm run build      # 产物在 dist/
npm run preview    # 预览构建结果
npm test           # 版本一致性 + 迁移检查 + 类型检查 + 单元测试
npm run verify     # 上面全部 + 构建 + CSP 哈希与 dist 一致性
```

不配置任何云端变量也能跑起来：文章来自 `src/content/blog/*.md`，
图片放在 `public/uploads/`。云端相关的入口会显示配置引导，而不是报错。

## 目录结构

```
src/
├─ content/blog/          文章 Markdown（云端同步的落地位置）
├─ lib/
│  ├─ site.ts             站点配置：标题、导航、作者、日期格式化
│  ├─ posts.ts            内容查询：列表、标签统计、相关文章、系列、阅读时长
│  ├─ cycling.ts          骑行页数据（里程、装备、照片）
│  ├─ projects.ts         作品页数据
│  ├─ uses.ts             我用什么：工具与装备清单
│  ├─ cloud.ts            云端 client：登录、增删改查、文件上传（REST，无 SDK）
│  ├─ rehype-enhance.mjs  正文增强：代码块外壳、图片懒加载、外链新窗口
│  └─ og-image.mjs        构建结束后为每篇文章渲染分享图
├─ layouts/BaseLayout.astro  文档骨架：SEO、OG、JSON-LD、主题脚本
├─ components/            Header / Footer / PostCard / Icon / Comments
├─ pages/
│  ├─ index.astro         首页
│  ├─ blog/index.astro    文章列表（全文搜索 + 标签筛选）
│  ├─ blog/[slug].astro   文章详情（目录、进度、系列、上下篇、相关阅读）
│  ├─ tags/               标签总览与标签页
│  ├─ series/             系列总览与系列页
│  ├─ archive.astro       按年月归档的时间轴
│  ├─ notes.astro         碎片笔记（客户端读取，即时可见）
│  ├─ cycling.astro       骑行记录
│  ├─ projects.astro      作品
│  ├─ uses.astro          我用什么
│  ├─ search-index.json.ts 构建期生成全文索引
│  ├─ about.astro         关于
│  ├─ admin/index.astro   写作后台（登录后才能用）
│  ├─ rss.xml.ts          RSS
│  └─ 404.astro
└─ styles/global.css      设计系统：颜色变量、排版、Markdown 正文样式
scripts/
├─ sync-content.mjs       构建前把云端文章同步为本地 Markdown
├─ serve-dist.mjs         本地静态预览服务器
├─ qa.mjs                 截图 + 横向溢出检测（视觉质检）
└─ fonts/                 分享图用的中文字体
supabase/
├─ schema.sql             建表、RLS 策略、Storage 桶与权限
└─ notify.sql             新留言通知（pg_net 触发器）
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

- 后台保存已发布的文章后，会主动调 `trigger_sync()` 触发一次 GitHub Actions 同步，**约 2 分钟上线**；
- `auto-publish.yml` 的定时任务每 10 分钟检查一次，但 GitHub 的 schedule 实际常被延迟到 30 分钟以上，只作兜底；
- 渲染管线只有一条，本地写 Markdown 和云端写作最终都走同一套逻辑。

触发同步需要一个 GitHub 细粒度令牌（只勾 `Actions: Read and write`），
填法见 `supabase/notify.sql` 末尾；后台左侧也有「同步上线」按钮可以手动触发。

### 权限模型

`posts` 表启用了 RLS：

- 匿名用户只能 `select` 已发布文章（`published = true`）；
- 只有通过认证的用户才能增删改；
- Storage 桶公开可读，写入需要登录。

anon key 会出现在前端代码里，这是设计如此——**密钥公开不等于数据公开**。

## 部署

构建产物是纯静态的，任何静态托管都能用（Cloudflare Workers / Pages / Vercel / Netlify / 对象存储）。

### 实际的部署方式：Worker + Static Assets

线上入口是 **Worker + Static Assets**（`wrangler.jsonc` → `worker/index.js`），
**不是 Cloudflare Pages，也没有 Pages Functions**。`functions/` 目录在 Worker 部署模式下不会被执行，
因此 `/api/*` 与 `/sb/*` 都实现在 Worker 入口里。

```bash
npm run verify        # 2.0：版本 / 迁移 / 类型 / 单测 / 构建 / CSP 哈希一致性
npm run cf:deploy     # = npm run build && wrangler deploy
node scripts/prod-smoke.mjs   # 发布后只读冒烟
```

> **2.0 部署护栏**：不要绕过 `cf:deploy` 直接 `wrangler deploy`。
> 内联脚本的 CSP 白名单由 `postbuild` 生成，跳过 build 会让线上用旧哈希去放行新脚本，
> 结果是被 CSP 拦掉、桌面白屏。CI 里的 `npm run check:csp` 会比对哈希与 `dist`。

发布与回滚的完整步骤见 [`docs/RELEASE-2.0.md`](docs/RELEASE-2.0.md)，
数据迁移与回滚见 [`docs/MIGRATION-2.0.md`](docs/MIGRATION-2.0.md)。

### 历史说明：Cloudflare Pages（本项目未使用）

1.8 之前这里写的是 Pages 的 Git 集成流程。实际上仓库**没有** Pages 项目、没有 Git 集成，
`auto-publish.yml` 也不会触发 Pages 构建——它只把云端文章同步回仓库。
push 到 `main` 不会自动上线，必须执行一次 `cf:deploy`。这一点在 1.9 中更正。

如果你确实想用 Pages 托管静态部分（放弃 `/api/*` 与 `/sb/*` 后端），可以按下面的构建设置配置：

| 项 | 值 |
| --- | --- |
| Framework preset | Astro |
| Build command | `npm run build` |
| Build output directory | `dist` |
| Node version | `22.23.4`（仓库根目录已有 `.nvmrc`） |

## 后端基础设施（Guandao OS 1.5）

静态资源和 API 走同一个 Worker，同一套域名，不需要额外的服务：

| 路径 | 处理方 | 说明 |
| --- | --- | --- |
| `/api/*` | `worker/api/router.js` | 统一 JSON 接口，目前只有健康检查 |
| `/sb/*` | `worker/index.js` | 反代 Supabase，绕开国内直连卡死 |
| 其他 | `env.ASSETS` | Astro 构建出的静态页面 |

### GET /api/health

```json
{
  "success": true,
  "status": "ok",
  "services": { "d1": "connected", "r2": "available" },
  "details": {
    "d1": { "latencyMs": 3 },
    "r2": {
      "latencyMs": 54,
      "capabilities": { "put": true, "get": true, "head": true, "delete": true },
      "probe": "not_found"
    }
  },
  "checkedAt": "2026-11-04T05:15:05.979Z",
  "durationMs": 30
}
```

- D1：真实执行只读的 `SELECT 1 AS ok`，2 秒超时；
- R2：确认 `put/get/head/delete` 存在后，对固定 key `__healthcheck__/probe` 做一次只读
  `head`（返回 `null` 即桶可达），**不创建、不覆盖、不删除任何对象**；
- 任一服务异常时返回 HTTP 503、`status: "degraded"`，并把对应服务标成
  `unconfigured`（没绑定）或 `error`（查询失败）；静态页面不受影响；
- 错误统一为 `{ "success": false, "error": { "code", "message" } }`，
  非 GET/HEAD 返回 405 + `Allow` 头，未知 `/api/*` 返回 JSON 404 而不是 HTML。

接口只服务同源页面，刻意没有开 CORS；本阶段也没有任何读写业务数据的路由，
表结构和迁移见 [`migrations/README.md`](migrations/README.md)。

### 本地运行

```bash
npx wrangler login          # 只需一次，用于读取 D1 真实 ID
npm run cf:link             # 把 guandao-db 的 UUID 写进 wrangler.jsonc
npm run db:migrate:local    # 初始化本地 D1（.wrangler/state）
npm run cf:dev              # Worker + 静态资源，默认 http://127.0.0.1:8787
npm run verify:cloudflare -- --base http://127.0.0.1:8787
```

`npm run dev`（Astro）仍然只跑静态页面，不含 `/api` 与 `/sb`；要连后端就用 `cf:dev`。

### 部署

```bash
npm run cf:deploy           # 先 build，再 wrangler deploy
```

- `wrangler.jsonc` 里写 R2 的 bucket 名；D1 的 `database_id` 由 `npm run cf:link`
  从账号读取后写入（只是资源标识，不是密钥），换账号或重建数据库时重新执行即可；
- 用 `wrangler deploy` 发布前确认配置里的 `d1_databases[].database_id` 已填，
  否则 D1 绑定不会随部署上传，`/api/health` 会报 `d1: unconfigured`；
- 部署后校验：`npm run verify:cloudflare`（默认打 `https://guandao.xin`）。

## 账号与身份（Guandao Account）

### 方案

GitHub OAuth Web Application Flow + PKCE S256，只申请 `read:user`：

- 不申请 `repo` / `gist` / `workflow`，不读取任何仓库；
- Access Token 只在服务端内存里用于拉取一次用户资料，不写数据库、不下发前端；
- 登录许可由服务端判断：数据库里没有管理员时进入初始化；初始化后只有该管理员的
  GitHub 数字 ID 能登录，用户名变化不影响身份。

### API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/auth/status` | 是否已配置 OAuth、是否已初始化（不返回任何密钥） |
| GET | `/api/auth/github` | 生成 state + PKCE，跳转 GitHub 授权 |
| GET | `/api/auth/github/callback` | 校验 state、交换 code、建立 Session |
| GET | `/api/auth/me` | `{ authenticated, user, session }`，未登录返回 `user: null` |
| POST | `/api/auth/logout` | 删除服务端 Session 并清 Cookie |
| POST | `/api/auth/initialize` | 首次管理员初始化（JSON body 提交 setup token） |
| PATCH | `/api/auth/profile` | 修改显示昵称 |
| GET | `/api/auth/devices` | 当前账号的登录会话（设备能力后续开放） |

### Session 与 CSRF

- Token：32 字节密码学随机数，Base64URL；浏览器只保存于 HttpOnly Cookie；
- D1 只保存 SHA-256 哈希，数据库泄露也无法直接复用 Session；
- Cookie：`HttpOnly`、`SameSite=Lax`、`Path=/`、生产环境 `Secure`，有效期 30 天；
- 所有写操作（POST/PATCH）校验 `Origin` 或 `Sec-Fetch-Site: same-origin`；
- 退出登录会删除服务端 Session，不只是清 Cookie。

### 首次管理员初始化

1. 配置好下面的 Secrets 并部署；
2. 打开站点 → 右上角头像 → 使用 GitHub 登录；
3. 授权后回到 `/?setup=1`，输入 `INITIAL_ADMIN_SETUP_TOKEN`；
4. 服务端确认“当前没有任何管理员”后创建管理员并登录；
5. 初始化入口随即失效（再次调用返回 409），数据库中只会有一个 admin。

### GitHub OAuth App

生产：

- Homepage URL：`https://guandao.xin`
- Authorization callback URL：`https://guandao.xin/api/auth/github/callback`

本地（建议单独建一个 App）：

- Homepage URL：`http://127.0.0.1:8787`
- Authorization callback URL：`http://127.0.0.1:8787/api/auth/github/callback`

### Cloudflare Secrets

```bash
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret put APP_ORIGIN              # https://guandao.xin
npx wrangler secret put INITIAL_ADMIN_SETUP_TOKEN
```

本地开发复制 `.dev.vars.example` 为 `.dev.vars`（已被 `.gitignore` 忽略）。

### 当前边界

- 不开放公开注册，也没有密码 / 邮箱登录；
- 设备管理、云同步仅保留入口，未实现的功能在界面上明确标注“即将开放”；
- 未配置 OAuth Secret 时，登录界面会明确显示“GitHub 登录未配置”，不会伪造登录状态。

## Guandao Cloud Drive

个人云端文件空间：文件本体在 R2，元数据在 D1，所有接口要求 Guandao Account Session。

### 存储设计

- R2 Object Key：`users/{userId}/files/{fileId}`，`fileId` 为服务端 UUID，原始文件名只存 D1；
- 重命名/移动只改 D1 的 `display_name` / `parent_id`，不移动 R2 对象；
- `files` 记录状态：`pending / ready / trash / pending_delete`，另有 `folders`、`multipart_uploads`（预留）、`file_events`。

### API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/files?view=&folderId=&search=&sort=&limit=&offset=` | 列表 / 分类 / 搜索 |
| GET | `/api/files/quota` | 容量与分类统计（不含 pending） |
| GET | `/api/files/folders` | 全部文件夹 |
| POST | `/api/files/folders` | 新建文件夹 |
| PATCH/DELETE | `/api/files/folders/:id` | 重命名/移动/收藏；删除需 `?recursive=1` |
| POST | `/api/files/folders/:id/restore` | 恢复文件夹 |
| DELETE | `/api/files/folders/:id/permanent` | 永久删除文件夹 |
| POST | `/api/files/upload?name=&parentId=` | 单文件上传（原始 body） |
| GET/PATCH/DELETE | `/api/files/:id` | 详情 / 改名移动收藏 / 移入回收站 |
| GET | `/api/files/:id/content` | 预览（安全类型 inline） |
| GET | `/api/files/:id/download` | 强制下载 |
| POST | `/api/files/:id/restore` | 恢复文件 |
| DELETE | `/api/files/:id/permanent` | 永久删除 |
| POST | `/api/files/trash/empty` | 清空回收站 |
| GET | `/api/files/recent` / `favorites` | 最近 / 收藏 |

### 上传与下载

- 单文件上限 25 MiB，账号默认 5 GiB（`CLOUD_QUOTA_BYTES` 可覆盖）；
- 服务端读取文件头校验真实类型，声明为图片/音视频/PDF 但内容不符直接 415；
- HTML、SVG 等不安全类型强制 `Content-Disposition: attachment`，不内联执行；
- 下载支持 `Range`（206、`Content-Range`、`Accept-Ranges`），完整请求返回 200；
- 所有查询以 Session 用户 ID 为条件，跨账号读取/删除返回 404。

### 界面

- 新应用 `Guandao Cloud Drive`（`src/lib/os14/drive.ts`），桌面图标、启动台可打开；
- 侧边栏、网格/列表、搜索、排序、上传进度、拖拽上传、文件夹、收藏、回收站、图片/PDF/音频/视频/文本预览；
- 与本地「文件管理器」完全分离，本地虚拟文件不会进入云端。

### 已知限制

- 超过 25 MiB 的分片上传尚未实现（`multipart_uploads` 表已预留）；
- 图片缩略图直接使用受保护的 content 接口，没有服务端缩略图生成；
- 文件夹拖拽移动、ZIP 打包下载、公开分享未实现；
- 文本/Markdown 预览为纯文本，不渲染 HTML，避免 XSS。

## 内容约定

文章 frontmatter：

```yaml
---
title: "标题"
description: "列表页与 SEO 用的摘要"
pubDate: 2026-10-28
updatedDate: 2026-10-30   # 可选
tags: ["技术", "Astro"]
series: "C 语言"          # 可选，同一个系列名会自动归到 /series/ 下
seriesOrder: 3            # 可选，系列内的阅读顺序，不填则按发布时间
featured: true             # 可选，首页精选
draft: false               # true 时构建期会被排除
cover: https://…           # 可选，留空则用标签色生成渐变封面
---
```

## 碎片笔记

`/notes/` 是一条短句时间流，和长文分开：一句话、一个念头，不必凑成完整文章。

内容存在 `notes` 表，页面由客户端读取，所以后台按「记下来」之后刷新就能看到，
不用等 `auto-publish` 的十分钟。写入只对登录用户开放，访客只读可见记录。
首页会展示最近两条，没有笔记时整块自动隐藏。

## 分享图

每次构建会为每篇文章渲染一张 1200×630 的 PNG（`dist/og/<slug>.png`），
标题、摘要、标签、日期都取自文章本身——分享到微信 / 微博 / Telegram 时不再共用一张默认图。

渲染用 satori + resvg，需要一份中文字体：`scripts/fonts/NotoSansSC-Regular.otf`
（Noto Sans SC，SIL OFL 协议，约 8 MB，已随仓库提交，部署时无需额外准备）。
字体缺失时构建不会失败，只是跳过这一步。

## 留言通知

`supabase/notify.sql` 用 `pg_net` 让数据库自己在留言后发 HTTP 请求，执行一次即可，
不需要部署额外服务。支持三种通道，填哪个用哪个：

| 通道 | 接收方式 | 说明 |
| --- | --- | --- |
| PushPlus | 微信 | 国内可用，个人博客免费额度够用 |
| Telegram | 即时消息 | 需要能访问 Telegram |
| Resend | 邮件 | 需要 API Key |

配置存放在 `notify_config` 表（未开放任何 RLS policy，只有 service_role 能读）。
具体填法见 SQL 文件末尾的注释，附自测与排查语句。


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

---

## Guandao OS 1.3 · Beyond the Desktop

首页 `/` 是一套可交互的个人桌面环境（Guandao OS），1.3 在 1.2 的基础上做增量升级，
不引入 AI 功能，重点解决「桌面像网页」的问题：真实壁纸、空间层级、精致材质与可管理的桌面组件。

### 新增能力

| 模块 | 内容 |
| --- | --- |
| 壁纸系统 2.0 | 24 张本地 WebP 壁纸（自然 / 城市 / 抽象 / Guandao Collection），填充 / 适应 / 居中、暗化、模糊、饱和度、Ken Burns、鼠标视差、切换淡入 |
| 自定义壁纸 | JPG / PNG / WebP 上传，Canvas 压缩到最长边 2560 后写入 IndexedDB（最多 8 张），自动取主色，缩略图即时生成 |
| 自动轮换 | 关闭 / 每天 / 每小时 / 随机 / 定时轮播；只从收藏中挑选，刷新后继续生效 |
| 壁纸联动 | 构建期为每张图做色相聚类取主色，切换壁纸同步强调色；可手动锁定颜色 |
| 桌面组件 | 11 种：时钟（数字 / 大号 / 指针）、日历、天气、待办、系统信息、欢迎语、每日一句、世界时钟、快捷启动、最近打开、个人简介 |
| 组件管理 | 拖动、S/M/L 尺寸、整体透明度、位置锁定、自动分栏（放不下时向左开新栏）、避让 Dock、恢复默认 |
| 桌面图标 | 全套 48×48 SVG 图标语言；网格 / 自由摆放、拖动排序、图标与文字尺寸、显示隐藏、位置持久化、双击打开 |
| 右键菜单 | 新建文件夹、新建便签、排列 / 按名称整理、刷新、更换壁纸、个性化、显示隐藏图标；图标与 Dock 各有独立菜单 |
| Dock 3.0 | 底部 / 左侧 / 右侧、尺寸、放大倍率、透明度、自动隐藏、运行指示点、运行中应用补位、右键固定 / 取消固定 / 关闭、拖动排序 |
| 菜单栏 | 当前应用名、控制中心（Wi-Fi / 蓝牙 / 音量 / 亮度，明确标注为模拟）、通知中心、电源菜单新增锁屏 |
| 锁屏 | 全屏模糊锁屏，显示时间与日期，点击或 Esc 解锁 |
| 个性化 2.0 | 10 个分类、7 套主题预设（Aurora / Ocean / Forest / Sunset / Midnight / Minimal / Glass）、实时预览、自动保存 |
| 材质系统 | glass / frost / solid 三级材质，三档圆角，完整语义 Token，深浅色主题 |
| 动效 | 窗口开关 / 最小化 / 最大化、Dock 放大与启动回弹、壁纸淡入、视差、微尘粒子；支持减少动效与 `prefers-reduced-motion` |

### 壁纸资源

全部壁纸位于 `public/wallpapers/`，由项目内图像生成流程产出：

- 原图 1536×1024，裁去右下角生成标记后统一输出 1600×1067 WebP（质量 82）
- `wallpapers/thumbs/` 为 480×320 缩略图，设置面板懒加载
- 单张全尺寸约 40–340 KB，首屏只加载当前壁纸
- 主色、亮度在构建资源时写入 `src/lib/wallpaper-assets.json`
- 不依赖任何远程图床，无第三方许可风险；详见 `public/wallpapers/CREDITS.md`

重新生成资源（需要把原始 PNG 放到 `.tmp-walls/`）：

```bash
node scripts/build-wallpapers.mjs
```

### 本地运行与部署

```bash
npm install
npm run dev        # http://localhost:4321
npm run build      # 静态产物在 dist/
npm run preview    # 预览生产构建
```

- 纯静态 Astro 输出，可直接部署到 Cloudflare Pages（构建命令 `npm run build`，输出目录 `dist`）
- 桌面全部状态保存在 `localStorage`（`guandao.os13.v1` 等），自定义壁纸保存在 IndexedDB
- 不依赖传统服务器；除原有 Supabase 功能外无运行时后端

### 已知限制

- Wi-Fi / 蓝牙 / 电量 / 音量 / 亮度为界面模拟状态，浏览器无法读取真实硬件，面板内已标注
- 天气来自 Open-Meteo（大连），离线时显示加载失败，不伪造数据
- 自定义壁纸存于浏览器本机，换设备 / 清缓存后需要重新上传；导出备份不包含大图
- 移动端为「基本可用」：5 列图标、Dock 收窄、组件自动收起，自由摆放强制回退为网格
- 设置窗口默认 940×660，小屏会自动收窄，内容区可滚动

---

## Guandao OS 1.4 · Ecosystem Evolution

1.4 的目标不是再换一次皮，而是给桌面补上「生态」：应用中心、主题中心、组件中心、
游乐场、工作空间、控制中心、任务与通知、数据中心，以及升级后的笔记 / 日历 / 相册 /
音乐 / 阅读器 / 文件管理器。所有应用仍然跑在 1.0 的同一套窗口系统里。

### 新增模块

| 模块 | 内容 |
| --- | --- |
| 应用中心 | 发现 / 全部 / 最新 / 热门 / 最近更新 + 7 个分类 + 搜索；应用详情含介绍、界面预览、功能、权限、更新日志；安装 / 卸载 / 更新真实改变 `APPS` 注册表，可固定程序坞、添加桌面快捷方式 |
| 主题中心 | 10 套完整主题（Aurora / Ocean / Forest / Sunset / Cyberpunk / Minimal / Glass / Space / Retro / Terminal），同时定义壁纸、强调色、材质、圆角、程序坞、菜单栏、图标色调、字体与组件观感；收藏、最近使用、自定义主题、带校验的导入导出 |
| 组件中心 | 在 1.3 的 11 个组件之外新增 8 个：桌面相框、倒计时、专注计时、音乐控制、快速便签、系统状态、世界时钟、今日任务；支持添加 / 移除 / S·M·L / 透明度 / 层级 / 锁定 / 布局恢复 |
| 游乐场 | 7 款公开小游戏（2048、贪吃蛇、扫雷、记忆翻牌、方块坠落、反应速度、数字猜谜）+ 1 款隐藏游戏；统一外壳、暂停 / 重开、分数与最高纪录持久化；像素桌宠、可拖动装饰物、点击涟漪、9 个彩蛋 |
| 工作空间 | Daily / Study / Work / Entertainment 四套预设，各自保存主题、壁纸、组件、程序坞、快捷方式、窗口布局与通知偏好；新建 / 复制 / 重命名 / 删除，Alt+1~4 切换，带过渡动画 |
| 控制中心 | 快捷控制（深色 / 浅色、勿扰、音量、动画、壁纸、桌面图标、程序坞自动隐藏、全屏）、系统状态（真实 / 模拟明确标注）、应用管理（运行中、强制关闭、卸载、信息） |
| 任务与通知 | 任务增删改查、优先级、截止日期、分类、搜索、完成率统计；与菜单栏铃铛共用同一份通知数据；勿扰模式下通知入库但不提醒 |
| 数据中心 | 按类别统计占用，全量导出、带格式 / 版本 / 前缀校验的导入、自动本地备份（IndexedDB，保留 10 份）、备份历史 / 下载 / 恢复、恢复默认外观 / 生态数据 / 出厂设置 |
| 文件系统 1.4 | 文档 / 图片 / 音频 / 视频 / 收藏 / 最近 / 下载 / 回收站分类；新建、重命名、复制、移动、回收站恢复、彻底删除、搜索、排序、收藏、详情；md→笔记、图片→相册、音频→音乐的文件关联；单文件导出与文件夹打包 |
| 五款内容应用 | Notes（多文档 / 文件夹 / Markdown / 标签 / 搜索 / 自动保存 / 导出）、Calendar（月历与日程 / 颜色分类 / 重复 / 提醒 / 任务联动）、Gallery（导入 / 相册 / 收藏 / 幻灯片）、Music（本地导入 / 队列 / 音量 / 进度 / 封面）、Reader（TXT·MD / 进度 / 字号 / 夜间 / 书签） |

### 数据与兼容

- 新键统一为 `guandao.os14.*`，不改 1.0–1.3 的旧键；旧便签、日程与文件索引会在首次打开时迁移
- 图片、音频、书籍、备份放在 IndexedDB（`guandao-os14`），localStorage 只存轻量配置
- 安装 / 卸载只改变本地登记状态，不会下载或执行远程代码
- 主题、组件、工作空间、游戏记录、任务都能随「数据中心 → 导出」一起带走
- 与虚拟桌面分工：虚拟桌面管窗口，工作空间管整套场景

### 回归测试

```bash
npm run build
npm run qa:os14        # 冒烟 + 深度 + 边界三套（需要本机 Chrome）
npm run qa:os14:full   # 先构建再跑
```

### 1.4 已知限制

- 浏览器读不到真实 CPU / 电量 / 系统音量，相关读数已标注「模拟」
- 页面关闭后日程提醒不会触发（浏览器页面的边界），通知与任务是页面内能力
- 导入的音频 / 图片 / 书籍只存在当前浏览器，换设备需重新导入；全量备份 JSON 不含二进制
- 应用中心是本地应用目录，不连接在线商店；安装不等于执行任意第三方代码
- 文件管理器是虚拟文件系统，只能读取用户通过文件选择器主动导入的内容

---

## Guandao OS 1.5 · Guandao Devices

一个账号，多台设备。设备管理中心负责「有哪些设备登录过、它们现在什么状态、要不要撤销其中某一台」，
不负责重建云同步，也不提供任何绕过身份认证的入口。

入口：桌面账号菜单 →「设备管理」，或 `window.GOS14.openDevices()`。
应用窗口标题为 **Guandao Devices**，数据全部来自 `/api/devices`（D1），没有演示设备。

### 阶段一审查结论（真实状态）

| 项目 | 结论 |
| --- | --- |
| Guandao Account | 已存在，GitHub OAuth Web Flow + PKCE，单管理员，`/api/auth/*` 可用 |
| Session 安全 | HttpOnly / Secure（HTTPS）/ SameSite=Lax，D1 只存 SHA-256，30 天过期 |
| devices 表 | 0001 已建，但只有 name / platform / last_seen_at，无类型、浏览器、系统、同步、信任字段 |
| sessions 表 | 0002 已建，有 device_id / last_used_at，**没有 revoked_at**，撤销只能删行 |
| Notes / Tasks / Calendar | **仍是浏览器 localStorage，没有云端同步接口**。本阶段不伪造同步状态 |
| Cloud Drive | 已完成，R2 存本体 + D1 存元数据，`/api/files/*` 可用 |
| 部署形态 | Worker + Static Assets，**不是 Pages Functions**（`functions/` 不会执行） |
| 迁移机制 | `wrangler d1 migrations`，编号顺序执行，0001–0005 已应用到线上 |

### 数据模型（0004 / 0005）

```
devices
  id (UUID) / user_id / name / device_type / browser_name / os_name
  last_seen_at / last_active_at / last_sync_at / revoked_at / trusted_at
  status (active|revoked) / created_at

sessions（增量）
  + revoked_at          -- NULL = 未撤销；撤销保留记录用于审计

device_activity
  id / user_id / device_id / event_type / metadata_json / created_at
  event_type: registered signed_in signed_out renamed device_revoked
              session_revoked trusted sync_success sync_failed sync_requested

device_sync_state
  device_id + domain 主键 / mode (cloud|local) / last_attempt_at / last_sync_at
  last_result / pending_up / pending_down / conflicts / sync_requested_at
```

`0005_device_names.sql` 只把旧的自动命名（`Chrome · Windows`）归一化为
`My Desktop / My Laptop / My Tablet / My Phone`，不覆盖用户自定义名称。

### 设备注册

- 登录成功后 `bindDeviceOnLogin` 在服务端生成或复用 UUID，写入 `gauth_did` Cookie
  （HttpOnly、SameSite=Lax、一年）。
- 复用条件只有一个：**该 device_id 属于当前用户且未撤销**。Cookie 被伪造、
  指向他人设备、或设备已撤销时，一律换发新 UUID，不会静默复活旧记录。
- 第一台设备自动 `trusted_at`；之后的新设备为「未确认」，在已有设备上显示
  New Device Signed In。
- 同一设备重复登录只更新时间，不会新增记录；清除浏览器数据后会产生新记录，
  旧记录可在设备中心撤销。

UA 只解析到「浏览器 / 系统 / 设备类型」三件事。UA 无法可靠区分台式机与笔记本，
默认 `desktop`，用户可以在重命名弹窗里改成 Laptop。不做指纹、不存定位、不存 IP。

### 活动状态判定

| 状态 | 条件 |
| --- | --- |
| 活跃 | 最近 5 分钟内收到过**前台**心跳 |
| 最近使用 | 24 小时内有过心跳 |
| 闲置 | 超过 24 小时 |
| 状态未知 | 从未收到心跳 |
| 已撤销 | `revoked_at` 非空 |

心跳：前台每 4 分钟一次；页面切回前台、网络恢复、窗口获得焦点时立即补一次；
页面进入后台停止定时器。写库节流 60 秒，避免 D1 写放大。心跳失败只降级为
「状态未知」，不影响桌面。**浏览器关闭后不存在任何定时器**，因此不会声称实时在线。

`last_seen_at`（心跳）、`last_active_at`（前台心跳）、`last_sync_at`（真实同步成功）、
`sessions.last_used_at`（任意请求）四个时间分开存储，不混用。

### API 清单（全部要求有效 Session 与同源写操作）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/devices` | 设备列表、统计、云盘用量、待确认新设备 |
| POST | `/api/devices/register` | 登记 / 刷新当前设备（登录后自动调用） |
| GET | `/api/devices/current` | 当前设备 + 它的 Session |
| POST | `/api/devices/heartbeat` | 前台心跳，返回是否有排队的同步请求 |
| GET | `/api/devices/sessions` | 当前账号全部 Session |
| GET | `/api/devices/:id` | 设备详情 + Session + 最近活动 |
| PATCH | `/api/devices/:id` | 改名 / 改设备类型 |
| GET | `/api/devices/:id/sessions` | 指定设备的 Session |
| POST | `/api/devices/:id/trust` | 确认「这是我的设备」 |
| POST | `/api/devices/:id/revoke` | 撤销设备及其全部有效 Session |
| POST | `/api/devices/:id/sync-request` | 请求该设备下次上线检查更新 |
| GET | `/api/devices/:id/activity` | 该设备的活动记录 |
| POST | `/api/devices/sessions/:sessionId/revoke` | 撤销单个 Session |
| POST | `/api/devices/revoke-others` | 退出所有其他设备，保留当前 Session |
| POST | `/api/devices/revoke-all` | 退出全部设备，需 `confirm: "REVOKE ALL"` |
| POST | `/api/devices/sync-report` | 当前设备上报 Cloud Drive 同步结果 |
| GET | `/api/devices/activity` | 账号级安全活动 |
| GET | `/api/auth/devices` | 兼容别名，等价于 `GET /api/devices`（带 deprecation 头） |

安全约束：

- `user_id` 只从 Session 读取，任何接口都不接受客户端传入的 user_id；
- URL 里的设备 ID 必须同时匹配 `user_id`，否则统一 404，避免 IDOR 与设备枚举；
- 撤销当前设备被拒绝（400），必须走「退出登录」；
- 所有响应都不包含 token、token_hash、client secret；
- 活动日志只存动作、设备名、计数与领域名，不存内容、凭证或 IP。

### 远程撤销的真实语义

1. 设备 A 发起撤销 → 服务端校验 A 的 Session、B 的归属；
2. 一个 D1 batch 内：`sessions.revoked_at = now`（B 的全部有效会话）+
   `devices.revoked_at/status`；
3. 写 `device_revoked` 审计；
4. 设备 B 下一次任意受保护请求 → `inspectSession` 返回 `revoked`/`device_revoked`
   → 401 + 清除 Cookie；前端弹出登录层，提示「账号可能已在其他设备退出」。

设备 B 完全离线时，服务器只能完成第 2 步；它重新联网后才会发现，这一点在 UI 与
接口文案里都明确写了，不声称能实时控制离线设备。

### 与 Cloud Sync 的集成（诚实版）

- **Cloud Drive 是真实云端**：设备每次成功加载云端文件列表 / 配额后上报
  `sync_success`；失败上报 `sync_failed`。设备卡片显示最后一次成功同步时间。
  超过 7 天未同步显示 `Needs Sync`，冲突数大于 0 显示 `Conflict Detected`。
- **Notes / Tasks / Calendar 仍是本地存储**：`device_sync_state.mode = 'local'`，
  界面明确显示「浏览器本地存储 / 尚未接入云同步」。服务端会拒绝这三个域的
  `sync-report`（409 `SYNC_NOT_AVAILABLE`），不能把本地数据伪造成「已同步」。
- 「请求下次同步」只写 `sync_requested_at`。目标设备下次心跳会看到该标记，真的去读
  一次云端索引后再上报，然后清除标记；不会唤醒离线设备。

### 设备管理中心

- Overview：账号、当前设备、4 张统计卡、新设备提醒、设备 × 数据域同步矩阵、安全操作。
- My Devices：Desktop / Laptop / Tablet / Mobile 分组 + 已撤销分组；卡片含图标、名称、
  系统、浏览器、最后活动、最后同步、注册时间、状态徽标与 CURRENT DEVICE 标记。
- Sessions：按设备分组的 Session 表（创建 / 最后使用 / 过期 / 状态），可单独撤销。
- Security Activity：登录、撤销、改名、同步结果的账号级时间线。
- 详情抽屉：基础信息 / 登录信息双栏、四个数据域的同步详情、该设备 Session、最近活动。
- 撤销确认对话框；「退出全部设备」需要输入 `REVOKE ALL`，可选择保留当前设备。

### 测试

```bash
# 端到端界面（需要本机 Chrome + 本地 wrangler dev + 一个有效会话令牌）
npx wrangler dev --local --port 8787
GDV_TOKEN=<token> node scripts/devices-qa.mjs

# 双设备实测：A 撤销 B，B 下一次请求收到 401
GDV_TOKEN=<tokenA> GDV_TOKEN_B=<tokenB> node scripts/devices-multidevice.mjs
```

已覆盖：设备列表 / 分组 / 当前设备唯一 / 详情抽屉 / Session 列表 / 安全活动 /
移动端无横向溢出 / 双设备不同 device_id / 远程撤销后 401 与登录层 / 改名写入 D1。

### 1.5 已知限制

- Notes / Tasks / Calendar 尚无云同步，因此设备同步矩阵中这三项只能是 `local`；
  补齐它们属于独立的同步引擎阶段，不在本阶段伪造。
- 不带 device_id 的旧 Session（1.5 之前签发且已被删记录）需要重新登录才能登记设备。
- UA 不能可靠区分类似「笔记本 vs 台式机」的形态，默认 Desktop，可手动更正。
- 同步请求依赖心跳轮询（最长约 4 分钟），不是推送；离线设备不会被远程唤醒。
- 撤销设备不会清除该设备浏览器里的本地笔记、主题与布局，只让登录失效。

---

## Guandao OS 1.5 · Guandao Backup & Recovery

**Your Data. Protected. Restorable.**

独立的系统应用 **Guandao Backup**（`window.GOS14.openBackup()`，账号菜单 →「备份与恢复」），
包含 Backup Center 与 Restore Center。所有数据来自 `/api/backups`（D1）与 R2，
没有演示备份、没有假进度。

### 阶段一审查结论

| 项目 | 真实状态 |
| --- | --- |
| Account / Session | 已完成，HttpOnly Cookie + D1 哈希 |
| Notes / Tasks / Calendar | **仍是浏览器 localStorage，无云端同步** |
| Cloud Drive | 已完成，R2 存本体 + D1 存元数据 |
| Devices | 已完成，设备/会话可撤销 |
| backups 表 | 0001 已建，但只有 kind/r2_key/size/note_count，无状态、校验、manifest |
| 同步日志 | `sync_changes` 表存在但从未写入；**没有可靠的变更游标** |

结论：**第一版只实现完整备份（Full）**，不伪造增量备份。增量需要同步引擎先落地。

### 备份范围与数据来源

| 域 | 内容 | 来源 |
| --- | --- | --- |
| notes | 文档、文件夹、标签、置顶、时间 | 设备上传 localStorage 快照 |
| tasks | 任务、优先级、截止、分类、完成状态 | 设备上传 |
| calendar | 事件、日期、时间、重复、提醒 | 设备上传；日期/时间是字符串，原样写回，不做 UTC 换算 |
| desktop | Dock、窗口状态、壁纸、主题、组件、个性化 | 设备上传白名单键 |
| workspace | 工作空间配置 | 设备上传 |
| drive | 文件元数据 + 文件夹结构 + **真实文件内容** | 服务端读取 D1 并复制 R2 对象 |

浏览器本地数据服务端无法读取，因此必须由当前设备上传；这是架构事实，不是偷懒。

### 存储架构

```
实时文件   users/{userId}/files/{fileId}
备份对象   users/{userId}/backups/{backupId}/data.json
          users/{userId}/backups/{backupId}/manifest.json
          users/{userId}/backups/{backupId}/files/{fileId}
```

- 备份对象是**独立的第二份内容**，不是重复保存 Object Key；
- Key 全部由服务端生成，Bucket 保持私有，不提供永久公开链接；
- 复制使用 `ReadableStream.tee()`：一条写入备份对象，一条增量计算 SHA-256；
- 单文件不 arrayBuffer 整体读入内存；
- 备份删除只删 `backups/{backupId}/` 前缀，实时文件不受影响（已实测）。

### 数据模型（0006）

- `backups`：增量扩展 `backup_name / backup_type / scope / status / schema_version /
  snapshot_at / completed_at / item_count / file_count / checksum_sha256 /
  manifest_object_key / data_object_key / verified_at / error_message`；
- `backup_jobs`：job_type(backup|verify|restore)、stage、progress、processed/total、
  checkpoint_json（断点续传）、error_code/message；
- `backup_items`：文件条目（object_key、size、sha256）；
- `backup_settings`：auto_enabled、frequency、retention、last_auto_*；
- `backup_restores` / `backup_restore_items`：恢复记录、幂等键、逐文件状态。

### 执行流程（可重入）

1. `POST /api/backups`：校验参数 → 读取本地快照（请求体，≤8 MB）→ 服务端读取 drive →
   写 `data.json` → 建 backups + job（状态 collecting）；
2. `POST /api/backups/:id/run`：每次最多复制 5 个文件或 18 秒，写 `backup_items`，
   更新 job 进度，返回 `done:false`；客户端继续调用，形成真实进度；
3. 文件全部复制 → 重读 data.json 计算 SHA-256 → 写 manifest → 状态 verifying；
4. 逐个重读备份文件、校验大小与 SHA-256 → 全部通过才写 `completed + verified_at`；
5. 任一步失败 → `status=failed` + 明确错误，**绝不标记 completed**；重试按
   `backup_items` 跳过已复制对象，断点续传。

一致性边界：本地快照与 drive 元数据在同一次创建请求内记录 `snapshotAt`；
文件复制期间若实时文件被删，复制会明确失败（`FILE_OBJECT_MISSING`），不会拼接零散数据。

### Manifest 与校验

```json
{
  "schemaVersion": 1,
  "backupId": "...", "userId": "...",
  "createdAt": 0, "snapshotAt": 0,
  "domains": ["notes", "tasks", "calendar", "desktop", "workspace", "drive"],
  "counts": { "notes": 1, "drive": 2 },
  "fileCount": 2,
  "files": [{ "id": "...", "sizeBytes": 75, "sha256": "...", "objectKey": "..." }],
  "folders": [],
  "dataObjectKey": "...", "dataChecksum": "...", "dataSize": 1527,
  "totalBytes": 1677
}
```

- `backups.checksum_sha256` = manifest 的 SHA-256；
- `manifest.dataChecksum` = data.json 的 SHA-256；
- 恢复前重新读取 manifest 与 data.json 校验（防「校验后被篡改」）；
- 恢复文件时逐个计算 SHA-256，失败立即中止并删除已写入的新对象。

### 恢复

| 模式 | 行为 |
| --- | --- |
| Copy | 生成新 ID；Notes/Tasks/Events 新 ID，Drive 文件新 ID + 新对象，不覆盖当前数据 |
| Merge | 同 ID 相同则跳过；不同则报告冲突并保留当前版本；新 ID 追加 |
| Replace Selected | 只替换选中类型；Drive 先把当前 ready 文件移入回收站（不删对象）再插入恢复数据 |

恢复顺序：预览（重新校验 manifest/data）→ 客户端创建**保护性备份**并跑完 →
`POST /:id/restore`（必须 `confirm:true`、1 小时内的保护性备份、覆盖所选域）→
逐文件复制 + 校验 → 全部成功后才写 D1 元数据 → 返回本地快照 → 客户端写回
localStorage → `ack` 记录应用结果。失败不会留下半套元数据。

保护性备份与恢复都使用幂等键；重复请求返回同一条恢复记录。

### 自动备份（真实 Cron）

`wrangler.jsonc` 增加 `triggers.crons = ["0 18 * * *"]`（每日 18:00 UTC / 北京 02:00），
Worker 导出 `scheduled()`，按 `backup_settings` 判断 daily/weekly 是否到期。
`BACKUP_CRON_ENABLED=true` 是显式开关；未配置时接口如实返回「Cron 未启用」。

**范围限制（重要）**：Cron 只能读取服务端数据，因此自动备份只覆盖 Cloud Drive。
Notes / Tasks / Calendar / 桌面必须在设备上手动备份。UI 与接口文案均明确说明，
不把浏览器定时器伪装成云端调度。

保留策略：按 `retention_daily` / `retention_weekly` 清理最旧的 auto 备份，
只删除 auto 且已完成的记录，至少保留一个已验证的完整备份；失败不触发清理。

### API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/POST | `/api/backups` | 列表（分页/搜索/筛选）/ 创建 |
| GET | `/api/backups/:id` | 详情 + 文件条目 |
| GET | `/api/backups/:id/progress` | 备份与任务进度 |
| POST | `/api/backups/:id/run` | 执行/续跑（分批） |
| POST | `/api/backups/:id/verify` | 重新校验（分批） |
| PATCH | `/api/backups/:id` | 重命名 |
| DELETE | `/api/backups/:id` | 删除（需 `confirm:"DELETE"`） |
| GET | `/api/backups/:id/download?format=json\|zip` | 下载完整包（ZIP 流式） |
| GET | `/api/backups/:id/export?domain=notes` | 单域导出 |
| POST | `/api/backups/:id/restore/preview` | 恢复预览 |
| POST | `/api/backups/:id/restore` | 执行恢复 |
| GET | `/api/backups/restores` | 恢复历史 |
| POST | `/api/backups/restores/:rid/run` | 续跑恢复 |
| POST | `/api/backups/restores/:rid/ack` | 确认本地应用结果 |
| GET/PUT | `/api/backups/settings` | 自动备份设置 |
| GET | `/api/backups/storage` | 真实存储统计 |

安全：Session 才可取 user_id；备份 ID 必须匹配 user_id（否则 404）；写操作校验同源；
响应不含 token / Object Key / 笔记正文；日志只记录动作与错误码。

### 界面

- **Backup Center**：Overview（最近备份、4 张统计、时间线、存储分段）、Backups
  （All/Manual/Automatic/Full/Failed、搜索排序、详情抽屉、JSON/ZIP 下载、重命名、删除）、Settings
  （Cron 状态、保留策略、导入、D1 Time Travel 边界说明）。
- **Restore Center**：选择恢复点 → 范围与模式 → 预览影响与警告 → 输入 `RESTORE` 确认 →
  保护性备份 → 文件恢复 → 本地写回 → 结果。
- 危险操作都有确认；删除需输入 `DELETE`；空状态与失败状态均有明确文案。

### 测试

```bash
# 端到端（需 wrangler dev --local 与有效 Session）
GDV_TOKEN=<token> node scripts/backups-qa.mjs

# Cron（本地）
npx wrangler dev --local --test-scheduled
curl "http://127.0.0.1:8787/cdn-cgi/handler/scheduled?cron=0+18+*+*+*"
```

已实测：完整备份、R2 独立副本与 SHA-256、ZIP 下载、篡改检测、保护性备份强制、
Copy 恢复（新文件 + 本地 Notes 写回）、幂等、删除备份不影响实时文件、跨用户 404、
CSRF 403、Cron 自动备份与状态回写。

### 已知限制

- **增量备份未实现**：没有可靠同步游标，第一版只做完整备份，UI 明确标注。
- **自动备份只覆盖 Cloud Drive**：本地数据必须由设备手动备份。
- Merge 采用「同 ID 同内容跳过 / 不同则冲突」，没有逐字段合并 UI。
- 桌面与工作空间只能整体替换，不支持按单条合并。
- 恢复预览校验 manifest 与 data.json；每个文件的 SHA-256 在恢复复制阶段逐一校验，
  失败会在写 D1 元数据前中止。
- 导入只支持 Guandao 导出的 JSON 包中的本地结构化数据；不导入云端文件，也不执行任何脚本。
- ZIP 采用 store（不压缩）流式输出，体积接近原文件。
- 没有端到端加密：备份在私有 R2 中由服务端加密静态存储，但服务端可读，不能宣称 E2EE。
- D1 Time Travel 仅在文档中说明为运维级能力，普通 Session 无入口。

---

## Guandao OS 1.5 · Guandao Privacy & Security

**Your Data. Your Privacy. Your Control.**

独立应用 **Privacy & Security**（账号菜单 →「隐私与安全」，`window.GOS14.openSecurity()`）。
八个页面：Overview、Account Security、Device & Sessions、Privacy、Data Control、Export、
Security Activity、Delete Account。所有状态来自真实 D1 / Session / 探测，没有静态安全评分。

### 安全审计摘要（真实结论）

| 项目 | 结论 |
| --- | --- |
| Session 校验 | 所有 `/api/*` 业务接口从 Cookie 解析 user_id；D1 只存 SHA-256 |
| Session 撤销 | `revoked_at` 生效后下一次请求即 401，并清 Cookie |
| IDOR | 设备、备份、导出、删除任务都要求 `id + user_id`；跨用户统一 404 |
| CSRF | 所有写操作校验 Origin 或 Sec-Fetch-Site；无 Origin 直接 403 |
| 匿名访问 | `/api/files`、`/api/backups`、`/api/privacy` 未登录均 401（Overview 会真实探测） |
| 备份隔离 | 备份对象与实时 R2 对象分离；删除备份不影响实时文件（已实测） |
| 删除完整性 | 先删 R2 对象，再删 D1 行；R2 失败保留 `pending_delete` 并返回错误 |
| 日志脱敏 | 安全事件只存白名单字段；不含 token、正文、文件内容、IP |
| Secret | `.env` / `.dev.vars` 未入库；历史提交未发现 token；页面只显示布尔状态 |
| 部署形态 | Worker + Static Assets（不是 Pages Functions） |

### 本次修复 / 加固

1. `/api/auth/me` 遇到 `pending_deletion` 不再清 Cookie，保证注销任务可以继续轮询。
2. 隐私设置成为**服务端强制约束**：关闭的类型在备份创建时返回 403，不是只改前端开关。
3. 注销前必须走 GitHub OAuth 重新验证，票据 10 分钟、只存哈希、一次性消费。
4. 注销任务分阶段执行：files → backups → exports → account；失败保留 `pending_deletion` 并可重试。
5. 账号删除保留最小化审计（user_ref_hash + 时间 + 阶段），不保留邮箱、用户名或内容。
6. 新增统一安全事件表，替换分散在设备日志中的安全语义。
7. 静态响应统一加安全头；CSP 已从 Report-Only 切换为**强制模式**，内联脚本按内容哈希放行。
8. `assets.run_worker_first` 改为 `true`，否则静态 HTML 不经过 Worker，安全头不会生效。

### 数据模型（0007）

- `security_events`：event_type / result / device_id / safe metadata；user_id 在账号删除后 SET NULL；
- `privacy_settings`：cloud_sync + notes/tasks/calendar/desktop/workspace；
- `data_exports` + `data_export_jobs`：导出记录、进度、R2 前缀、校验值、7 天过期；
- `data_deletion_jobs`：files / backups / content / account，阶段、进度、错误、checkpoint；
- `reauth_tickets`：注销重新验证票据（哈希、10 分钟）；
- `account_deletion_audit`：无个人内容的最小化审计；
- `users.deletion_state`、`oauth_states.purpose`。

### 隐私设置的真实含义

Notes / Tasks / Calendar **没有云同步**，因此这些开关不会“停止一个不存在的同步”。
它们实际约束的是**云端上传（备份）**：

- 关闭 `cloudSync`：任何本地类型都不能进入备份；Cloud Drive 仍可单独备份；
- 关闭某一类型：服务端拒绝包含该类型的备份请求（403 `DOMAIN_UPLOAD_DISABLED`）；
- 本地数据保留，云端历史不会自动删除；
- 重新开启后可手动创建新备份。

UI 明确写出这一点，不暗示已存在自动同步。

### 数据导出

- `POST /api/privacy/export`：服务端生成 `data.json`（账号、设备、Session 元数据、文件元数据、
  备份记录、安全事件、隐私设置 + 当前设备上传的本地快照），写入独立前缀；
- `POST /api/privacy/export/:id/run`：分批复制文件到 `users/{uid}/exports/{exportId}/files/`，
  每次 18 秒或若干文件，断点续传；
- 完成后写 `manifest.json`（dataChecksum、文件 SHA-256、totals），7 天后自动清理；
- 下载 JSON / ZIP（ZIP 流式，含 manifest、data、files、checksums.txt）；
- 只允许所属账号下载；其他账号 404。

导出不包含：Session Token、OAuth Secret、Token Hash、GitHub Access Token。
本地 Notes/Tasks/Calendar 只有设备上传快照后才在包里；这一点在 `data.limitations` 中明确写出。

### 数据删除与账号注销

- `POST /api/privacy/delete-data`：`targets: ["files"|"backups"|"exports"]`，必须 `confirm: "DELETE"`；
- 任务分批删除 R2 对象再删 D1；R2 失败时把文件标记 `pending_delete` 并返回 502，可重试；
- 账号注销：`POST /api/privacy/delete-account`，必须 `confirm: "DELETE MY ACCOUNT"`、
  `acknowledgeBackups: true`，并持有 GitHub 重新验证票据；
- 分阶段：files → backups → exports → account；账号阶段删除 users 行（级联 Session/设备/文件/备份/设置），
  保留无个人内容的审计；
- 完成后清除 Session Cookie，前端清本地 Guandao OS 键并回到登录入口。

### 安全响应头

Worker 对所有静态响应设置：

```
Content-Security-Policy: default-src 'self';
  script-src 'self' 'sha256-…'（构建生成的 9 个内联脚本哈希）https://static.cloudflareinsights.com;
  style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; media-src 'self' blob: https:;
  font-src 'self' data:; connect-src 'self' https://api.open-meteo.com https://*.supabase.co
  https://cloudflareinsights.com; frame-src 'self' blob: data:; frame-ancestors 'none';
  base-uri 'self'; form-action 'self' https://github.com; object-src 'none'
Strict-Transport-Security: max-age=31536000; includeSubDomains   （仅 HTTPS）
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()
X-Frame-Options: DENY
Cross-Origin-Opener-Policy: same-origin
```

CSP 现在是**强制**的，不再只是 Report-Only：

- `scripts/gen-csp.mjs` 在 `npm run build` 之后扫描 `dist/**/*.html`，把两个内联脚本
  （启动兜底、站点数据）的 SHA-256 写进 `worker/api/csp-hashes.js`；
  Astro 的其余脚本是外部文件，走 `'self'`。没有 `unsafe-eval`。
- `style-src` 仍保留 `'unsafe-inline'`：桌面有大量内联 style 属性（窗口坐标、主题变量），
  逐条哈希不现实，这一点在隐私页也写明了。
- 白名单来自真实需求：天气组件请求 `api.open-meteo.com`，Cloud Drive 的 PDF 预览使用
  `blob:` iframe，Cloudflare 会注入 `static.cloudflareinsights.com` 的 Web Analytics beacon。
- 已用 Puppeteer 在 `/`、`/blog/`、`/blog/<文章>/`、`/home`、404 页面各跑一遍，
  `securitypolicyviolation` 计数为 0，控制台无错误。

### 请求频率限制（0008）

`worker/api/ratelimit.js` 实现 D1 固定窗口计数：

- 全局：同一来源 IP 每分钟 600 次 `/api/*`（`/api/health` 不计）；
- 14 条敏感规则：登录发起 20/分、OAuth 回调 40/分、初始化管理员 5/10 分、上传 60/10 分、
  创建备份 20/时、备份下载 60/10 分、恢复 20/时、创建导出 6/时、删除数据 10/时、
  注销账号 3/时，分批 `run` 接口各 400/时；
- 超限返回 `429 RATE_LIMITED` + `Retry-After`；正常响应带 `x-ratelimit-limit/remaining`；
- 身份只存「规则 + 窗口起点 + IP」的加盐 SHA-256 前缀，不落库 IP 原文，窗口 24 小时后清理；
- D1 完全不可用时计数表读不到，安全中心把「请求频率限制」标为 Unknown；
  单次写入失败只会让那一次请求退化为内存计数（fail-open），事后统计无法区分。

### 后台任务续跑

Cron 改为 `*/15 * * * *`，每次执行三件事：自动备份（按 daily/weekly 到期判断，不会重复）、
清理过期导出 / 超期日志 / 限流窗口、**续跑无人轮询的删除与注销任务**。

删除任务每次 `/run` 只推进一个阶段，前端关闭后原本会永远停在 `pending_deletion`。
`runDeletionMaintenance` 会接管 90 秒内没有更新的任务，并在同一次 Cron 内连续推进最多 6 轮，
实测一个停滞在 `files` 阶段的注销任务在一次触发内完成：users / devices / 任务行全部清除，
审计保留。账号阶段删除 `users` 行后任务行随外键级联消失，恢复逻辑对此做了兜底。

### R2 私有性探测（可配置）

`r2_private` 检查不再永远显示 Unknown，而是按配置执行真实探测：

- `R2_PUBLIC_BASE_URL` 为空（当前默认）：显示 Unknown，文案说明「未配置探测地址」；
- 配置为 R2 自定义域名后：对当前账号的一个真实对象发 `HEAD`，
  403/404 → Protected，200/206 → Check Failed（对象可被匿名读取），其他 → Unknown。

Bucket 级策略只有 Cloudflare 侧知道，应用不会替它下结论。

### API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/privacy/overview` | 真实安全检查、评分规则、事件、备份与清单摘要 |
| GET | `/api/privacy/data-inventory` | D1 实时计数 |
| GET/PUT | `/api/privacy/settings` | 隐私设置（服务端强制） |
| POST | `/api/privacy/export` | 创建导出 |
| GET | `/api/privacy/exports` | 导出历史 |
| GET | `/api/privacy/export/:id` | 导出详情 |
| POST | `/api/privacy/export/:id/run` | 分批执行 |
| GET | `/api/privacy/export/:id/download?format=json\|zip` | 下载 |
| POST | `/api/privacy/delete-data` | 删除选定云端数据 |
| GET | `/api/privacy/deletion/:id` | 删除进度 |
| POST | `/api/privacy/deletion/:id/run` | 继续删除 / 注销 |
| POST | `/api/privacy/delete-account` | 注销账号（需重新验证） |
| POST | `/api/privacy/local-clear` | 记录本地清除事件 |
| GET | `/api/security/overview` | 别名 |
| GET | `/api/security/activity` | 安全事件分页/筛选 |
| GET | `/api/security/sessions` | Session 列表（复用设备模块） |
| POST | `/api/security/sessions/:id/revoke` | 撤销 Session |
| GET | `/api/auth/github?reauth=delete` | 注销前 GitHub 重新验证 |

### 安全检查与评分

7 项检查，权重：账号认证 20、Session 15、设备 10、API 权限 20、备份完整性 15、
R2 私有 10、Secret 10。评分只对**状态已知**的检查计分：Protected 得满分，
Attention / Not Configured / Failed 得 0，Unknown 不计入分母。规则随响应返回。

- API 权限检查会真的发起两次未登录探测（`/api/files`、`/api/backups`），必须都是 401；
  探测失败显示 Unknown，不标 Protected。
- R2 私有一律显示 Unknown：应用侧无法验证 Bucket 公网策略，不编造 Protected。
- 本地开发可能因 `global_fetch_strictly_public` 无法探测 localhost，同样显示 Unknown。

### 测试

```bash
GDV_TOKEN=<token> node scripts/security-qa.mjs
GDV_TOKEN=<token> node scripts/csp-check.mjs      # 强制 CSP 下逐页监听 securitypolicyviolation
```

已覆盖：概览与检查项、账号页不泄露 Secret、设备/Session 列表、隐私开关真实阻断备份、
数据清单、UI 创建导出与下载校验、安全活动、注销页确认、移动端无溢出、无应用控制台错误。

后端已实测：隐私设置 403、导出 JSON/ZIP 与 SHA-256、跨用户导出 404、CSRF 403、
数据删除（R2 + D1）、账号注销（用户/设备/Session/备份全部删除，审计保留）、
注销后旧 Session 401、安全头存在。

限流已实测：登录接口第 21 次返回 429（`Retry-After` 与窗口对齐）、
同一 IP 第 601 次 `/api/*` 请求被全局规则拦截、`/api/health` 不计入。

Cron 续跑已实测：构造一个停滞在 `files` 阶段的注销任务，触发一次
`/cdn-cgi/handler/scheduled` 后 users / devices / 任务行全部清除，审计保留。

### 已知限制

- 限流是**D1 固定窗口 + isolate 内存兜底**：`Retry-After` 与窗口对齐，不是令牌桶；
  D1 完全不可用时统计读不到，界面标 Unknown；单次写入失败只降级那一次请求。
- 注销重新验证依赖 GitHub OAuth；本地未配置 OAuth 时，真实注销流程只能靠预置票据验证。
- 账号删除仍分批执行；前端关闭后由 15 分钟一次的 Cron 续跑，最坏情况下延迟约 15 分钟。
- R2 私有性只有在配置 `R2_PUBLIC_BASE_URL` 后才会真实探测，否则保持 Unknown。
- D1 Time Travel 不向用户开放，只在文档中说明为运维级恢复。
- 没有 E2EE；R2 私有 + 平台静态加密，但服务端可读。
- 安全日志保留 180 天；账号删除后仅保留无个人内容的审计。
- 删除云端文件后，历史备份中的副本仍存在，直到用户单独删除备份——UI 明确提示。


## Guandao OS 1.7 · Plugin Ecosystem & Developer Platform

**Open Desktop**。1.7 把 Guandao OS 从「有应用、主题和社区资源的个人系统」升级为可以安装第三方插件的平台。

### 新增

- **插件管理器**：安装 / 启用 / 禁用 / 更新 / 回退 / 卸载，权限、存储、运行上下文与日志都可查。
- **插件市场**：与 1.6 账号体系共用身份，下载、安装、评分全部来自真实记录；官方示例单独标注。
- **开发者中心**：创建草稿、上传 `.gplug`、提交审核、管理资料、查看审核意见。
- **插件沙箱**：双层 `sandbox="allow-scripts"` iframe（opaque origin），受控 MessageChannel，宿主按权限逐条放行。
- **权限中心**：17 项能力，默认拒绝，安装前逐项确认，撤销立即生效，更新新增权限必须重新同意。
- **SDK**：`ui / storage / notifications / files / theme / commands / calendar / notes / lifecycle / device`。
- **命令面板**：`Ctrl` / `⌘` + `K`，执行插件注册的受控命令。
- **CLI**：`create / validate / build / dev / package / preview / publish`，零依赖。
- **文档**：[`/developers/`](https://guandao.xin/developers/) 与 [`docs/PLUGINS-1.7.md`](docs/PLUGINS-1.7.md)。

### 安全边界

插件不能访问主页面 DOM、Cookie、localStorage、D1、R2；不能执行 Shell；不能读取其它插件的数据。
插件包必须通过 Manifest Schema、文件路径、体积、`filesDigest` 与 SHA-256 校验；未审核版本不进市场。

### 测试

```bash
npm run qa:plugins       # 65/65（真实 Worker + D1 + R2）
npm run qa:plugins:ui    # 17/17（headless Chrome，沙箱隔离、CSP 与 SDK）
```

### 已知限制

文件处理插件尚未与文件管理器自动关联；主题插件只引用现有壁纸；网络代理只允许 https/443；
不提供 iframe 级 CPU / 内存统计；独立子域沙箱（`sandbox.guandao.xin`）为可选加固，未默认部署。
完整清单见 `docs/PLUGINS-1.7.md` 第 18 节。


## Guandao OS 1.8 · Seamless Experience

**Beyond One Device**。1.8 把桌面、平板和手机拆成三套真正不同的体验，并用同一账号把它们连起来。

### 新增

- **自适应外壳**：按视口、触摸能力与方向选择 desktop / tablet / mobile；不依赖 User-Agent。首帧写入 `data-shell`，无闪烁跳转。
- **平板模式**：46px 菜单栏、58px Dock、≥44px 点击目标、接近满宽的窗口、手指贴边吸附。
- **移动伴侣 `/m/`**：独立页面，不加载窗口系统；首页、笔记、任务、日历、文件、设备、剪贴板、账号、设置。
  手机打开站点网址默认进入伴侣页（Worker 302，不下载桌面主包）；底栏「桌面」入口（`/?desktop=1`）
  可进入完整桌面阅读博客与使用全部应用，仅本次会话生效；
  进入后可在「视图 → 手机布局」切回。
- **设备配对**：6 位码 + 二维码，10 分钟一次性会话；新设备 Session 在旧设备批准后才签发。
- **跨设备接力**：笔记 / 任务 / 日程 / 云盘文件 / 链接 / 工作空间；真实 `pending → delivered → opened → completed` 状态，离线保持等待。
- **语义化上下文**：只同步应用、内容 ID、工作空间与滚动位置，不同步窗口坐标。
- **跨设备剪贴板**：仅用户主动发送的纯文本，24h 过期，可删除；无后台监听。
- **PWA**：manifest、192/512/maskable 图标、Service Worker、离线页与更新提示；`/api/*`、沙箱、配对页永不进入缓存。
- **离线队列**：断网时接力/剪贴板进入本机 outbox，恢复网络后补发。

### 安全边界

配对二维码不含 Cookie / Session / GitHub Token；只有发起配对的设备能批准；新设备 Session 领取时一次性签发。
接力内容只能由同一账号的目标设备打开；所有接口从 Session 取身份，非 GET 校验 Origin。
Web Push **未启用**（无 VAPID），`/api/push/status` 会如实返回原因。

### 测试

```bash
npm run qa:continuity      # 45/45（真实 Worker + D1 + R2）
npm run qa:continuity:ui   # 38/38（桌面 / 平板 / 超宽屏 / 手机竖横屏）
```

### 已知限制

Notes / Tasks / Calendar 仍是本机数据，不是云同步；接力传的是内容快照，不能远程控制离线设备；
工作空间会过滤目标设备不支持的应用/组件；剪贴板仅纯文本；Push 未启用。
完整 11 条见 `docs/SEAMLESS-1.8.md` 第 12 节。

## Guandao OS 2.0 · The Platform Era（平台时代）

**Your Digital World. One Unified Platform.** 2.0 不是再塞几个应用，而是把 1.x 的能力收进一套统一架构：
一个内核、一套应用运行环境、一套权限、一套云端状态、一个市场、一个开发者平台。

### 新增

- **Guandao Core**：`src/lib/core/**` 18 个模块 —— 启动编排（11 阶段，单阶段失败不阻止桌面）、
  生命周期、事件总线（错误隔离）、应用注册中心、应用运行时、窗口管理器、权限、设置、存储、
  迁移、通知、云端、同步、设备。公开入口 `src/lib/core/index.ts`（`core@1` 契约）。
- **正式 Manifest**：`appId/name/version/description/icon/category/entry/minimumOSVersion/
  permissions/dependencies/author`，注册前校验；46 个内置应用全部登记。
- **统一应用状态**：`registered / installed / enabled / running / minimized / suspended /
  disabled / failed`，由真实窗口驱动，UI 不能伪装。
- **权限服务**：默认拒绝、声明≠授予、逐项授权、拉黑、审计日志与导出。
- **Window System 3.0**：统一窗口 API（贴靠 / 分屏 / 最大化 / 快照 / 跨设备几何重算），
  应用不再自己实现拖动缩放。
- **System Center**：外观 / 个性化 / 应用 / 插件 / 云端 / 设备 / 隐私 / 系统八类设置，改动真实落盘。
- **首次启动引导**：七步，可跳过、状态持久化；1.x 升级用户不会被打扰。
- **更新中心**：当前版本、构建号（编译期注入）、服务端版本、插件兼容性、数据保护检查、更新历史。
- **统一市场**：应用 / 插件 / 主题 / 组件 / 壁纸 / 工作空间 / 社区 7 类资源，12 步安装流水线，
  处理器全部复用已验证实现。
- **云同步（Notes / Tasks / Calendar）**：实体级增量同步、乐观锁冲突检测、删除墓碑传播；
  `POST /api/sync/push`、`GET /api/sync/{index,pull,status}`；系统设置可一键同步。
- **1.x 数据迁移**：先写 IndexedDB 快照，再只新增 `guandao.core.*` 键；幂等、可重试、失败不删数据。

### 修复（2.0 审计驱动）

- 普通成员无法注销账号（重新验证被写死为 admin）；
- 初始化管理员密钥可被分布式爆破（新增 ≥24 字符与全局尝试锁）；
- `/sb` 同源代理可被当作开放中继（前缀/方法白名单 + 限流 + 错误脱敏）；
- 3 处请求体上限可被 chunked 绕过；
- 插件更新不检查系统兼容性；`widget.setTitle` 宿主未实现；组件模式 `ui.setTitle` 静默成功；
- 插件名可注入宿主 HTML；插件逃逸只本地封禁、不上报服务端；
- 撤销插件权限不跨标签页；换设备恢复插件会静默继承敏感权限（现在必须本机重新确认）；
- 社区下载量被详情页浏览灌水；
- 诊断中心把「没有同步引擎」显示成「已同步」；
- 备份条目 >5000 必失败；备份下载不校验摘要；恢复的 Merge 语义名不副实；
- 注销时 R2 清理失败被吞掉（现在会重试并留审计）；
- `/api/health` 匿名不限流；
- 版本号 1.6 / 1.8 / 1.9 三份真相（CI 现在强制一致）；
- PWA 未预缓存桌面 `/` 导致首访后断网白屏；SW 更新检查竞态。

### 测试与工程

```bash
npm test             # 版本 + 迁移 + 类型 + 单元测试（115）
npm run verify       # 上面全部 + 构建 + CSP 哈希与 dist 一致性
npm run qa:os20      # 2.0 平台 E2E（7 项）
npx playwright test  # 全部 E2E（21 项）
npm run qa:sync      # 云同步 API（20 项，自带 wrangler dev --local）
npm run qa:sync:ui   # 云同步双设备联调（8 项，需要本机 Chrome）
npm run qa:prod      # 生产端到端（35 项，临时账号，跑完清理）
```

CI 增加：迁移静态检查、CSP 哈希一致性、`wrangler dev --local` API 冒烟。
CLI 新增 `test` 子命令（Manifest / 入口 / SDK 表面 / 打包摘要 6 项自检）。

### 已知限制

同步只覆盖 Notes / Tasks / Calendar（冲突策略是服务端优先）；插件供应链无签名；
插件逃逸事件会上报但数据出网无法回滚；`index.astro` 仍是 17.5k 行外壳；两套云栈并存；
**回滚路径已确认但未实际演练**。
完整 11 条见 [`docs/RELEASE-2.0.md`](docs/RELEASE-2.0.md) 第 17 节。
