# 管道的博客

一个可以直接上线的个人博客：Astro 静态渲染 + 云端内容与认证。

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

构建产物是纯静态的，任何静态托管都能用（Cloudflare Pages / Vercel / Netlify / 对象存储）。

### Cloudflare Pages

1. Cloudflare Dashboard → Workers & Pages → Create → Pages → Connect to Git，选中本仓库；
2. 构建设置：

   | 项 | 值 |
   | --- | --- |
   | Framework preset | Astro |
   | Build command | `npm run build` |
   | Build output directory | `dist` |
   | Node version | `22.23.4`（仓库根目录已有 `.nvmrc`，也可再加环境变量 `NODE_VERSION=22.23.4`） |

3. 环境变量：填 `PUBLIC_SUPABASE_URL`、`PUBLIC_SUPABASE_ANON_KEY`、`PUBLIC_SUPABASE_BUCKET`，
   以及构建期同步用的 `SUPABASE_URL`、`SUPABASE_ANON_KEY`（不填则用本地 Markdown 构建）；
4. Custom domains 里绑定 `guandao.xin`，Cloudflare 会自动签发证书。

之后每次 push 到 `main` 都会自动构建发布。注意 `scripts/sync-content.mjs` 在 `prebuild`
里跑，云端拉取失败时会**静默跳过**（`--soft` 模式），不会阻断发布。

> 线上实际入口是 **Worker + Static Assets**（`wrangler.jsonc` → `worker/index.js`），
> 不是 Pages Functions。`functions/` 目录在 Worker 部署模式下不会被执行，
> 因此 `/api/*` 与 `/sb/*` 都实现在 Worker 入口里。

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
