# Guandao OS 1.6 — Community & Sharing 交付说明

> Release Name: **The Creative Community**  
> Version: **1.6.0**  
> Production: <https://guandao.xin>  
> 部署版本（Worker）: `my-homepage` / Version ID `07607b42-c7b0-430c-8ba3-2956c3ba178b`

---

## 1. 完成范围

Guandao OS 从个人桌面升级为带真实内容、真实用户与真实审核的创意社区：

- 多用户注册（GitHub OAuth + 关闭 / 邀请制 / 开放注册三种服务端策略）
- 社区首页：精选、最新、真实热度、关注动态、创作者推荐、分类发现
- 主题 / 组件 / 工作空间 / 壁纸 / 教程五类作品发布
- 真实点赞、收藏（含收藏夹分类）、两层评论、关注、通知
- 创作者主页、公开 / 私密资料、作品集、关注 / 粉丝
- 统一发布中心、草稿、审核、撤回、删除、版本历史、回退
- 举报 → 人工审核 → 处理 → 审计
- 审核中心：作品审核、举报、用户、社区设置、邀请码、审计日志、社区总存储
- 社区资源安装到 **原有** 主题中心 / 组件系统 / 工作空间 / 壁纸引擎，没有第二套安装器

**未包含（明确说明）**：AI 助手 / AI Agent / AI 聊天 / AI 自动审核、私信、实时聊天、任意代码插件市场、星级评分。社区短动态（纯文字/图片动态流）未实现；Following 动态由关注创作者的作品发布产生。

---

## 2. 架构

```
浏览器（Astro 单页 OS）
  └─ Guandao Community 应用  src/lib/os14/community.ts
       ├─ src/lib/community/api.ts        同源 API 客户端 / 错误封装
       ├─ src/lib/community/manifest.ts   内容包预检 / 许可证 / 分类
       ├─ src/lib/community/install.ts    安装、校验、更新、回退、卸载
       └─ 原有系统
            ├─ os14/themes.ts            主题中心（custom themes）
            ├─ os14/widgetstore.ts       组件系统（声明式 WidgetSpec）
            ├─ os14/workspaces.ts        工作空间（导入 + 保护性快照）
            └─ os13.ts                   壁纸引擎（压缩 / IndexedDB / 应用）

Cloudflare Worker
  ├─ worker/api/router.js
  └─ worker/api/community/
       ├─ handlers.js    路由、公开读取、媒体访问、R2 私有读取
       ├─ write.js       上传、发布、版本、点赞、收藏、评论、关注、举报、通知
       ├─ admin.js       审核、举报处理、用户、设置、邀请、审计、统计
       ├─ store.js       D1 查询与映射
       ├─ validate.js    Manifest / 图片 / 兼容性 / 执行字段校验
       ├─ registration.js 注册策略、邀请码、OAuth 注册意图
       ├─ common.js      会话、来源校验、角色、配额、审计、通知
       └─ maintenance.js Cron 清理与重试

D1 (guandao-db) · R2 (guandao-files)
```

---

## 3. 账号与权限

### 3.1 保留原有账号体系

- 原管理员账号、GitHub OAuth、初始化密钥、HttpOnly Session、设备绑定、CSRF 校验全部保留。
- `users.role` 仍为 `admin` / `member`，数据库 `idx_users_single_admin` 继续保证只有一个管理员。
- 没有降低 Session 安全等级；社区接口复用同一 Session，不新增客户端可读 Token。

### 3.2 新增社区角色

| 有效角色 | 来源 | 权限 |
|---|---|---|
| Admin | `users.role='admin'` | 用户、设置、邀请、角色、删除作品、精选、审计 |
| Moderator | `community_roles.role='moderator'` | 审核作品、处理举报、隐藏作品/评论；不能改设置、不能删除作品、不能审核自己的作品 |
| Member | 普通用户 | 发布、编辑、删除自己的作品、评论、点赞、收藏、关注、举报 |
| Visitor | 未登录 | 浏览公开内容、搜索、查看创作者 |

角色判断全部在 Worker 端完成，前端只控制显示。普通用户无法通过任何接口修改自己的角色。

### 3.3 注册模型

- 管理员在 **Community → 审核中心 → 社区设置** 中设置：
  - `closed`：关闭注册（代码默认，最安全）
  - `invite`：邀请制，邀请码只保存 SHA-256，明文只在创建时显示一次
  - `open`：开放注册
- **当前生产环境已设置为 `invite`（邀请制）**，并向访客显示加入社区入口；邀请码需由管理员生成
- 注册必须走 GitHub OAuth：`/api/auth/github?mode=join[&invite=...]`
- 发起时服务端校验策略，回调时再次校验（防止 OAuth 期间策略变更 / 邀请被抢完）
- 新用户永远以 `member` 创建，不能通过注册获得管理员
- 已存在的成员可直接登录；`member_login` 可暂停成员登录，但管理员与审核员不受影响
- 关闭注册不会影响已有成员登录和社区浏览

**生产环境当前为邀请制（`invite`）。** 首次邀请请由管理员登录后打开 Community → 审核中心 → 邀请注册，生成邀请码。

---

## 4. D1 数据库（0009_community.sql）

仅新增，不修改 0001–0008 已有表：

| 表 | 用途 |
|---|---|
| `community_settings` | 单行社区设置（注册模式、审核、配额、公告） |
| `community_profiles` | 公开创作者资料、可见性、限制 |
| `community_roles` | 审核员角色（admin 仍在 users.role） |
| `community_invites` | 邀请码（仅哈希）、名额、过期、作废 |
| `community_join_intents` | OAuth state 哈希关联的一次性注册意图 |
| `community_assets` | R2 资源索引、尺寸、mime、删除状态与重试 |
| `community_posts` | 作品、状态、分类、标签、计数、精选、审核备注 |
| `community_packages` | 作品包元数据、当前版本、checksum、R2 key |
| `package_versions` | 历史版本、changelog、checksum、发布时间 |
| `community_likes` | 点赞，`UNIQUE(user_id, post_id)` |
| `community_favorites` | 收藏 + 收藏夹，`UNIQUE(user_id, post_id)` |
| `community_comments` | 两层评论，状态 visible / hidden / deleted |
| `community_follows` | 关注关系，主键 `(follower_id, following_id)` |
| `community_reports` | 举报，同一举报人同一目标唯一 |
| `community_notifications` | 评论 / 回复 / 审核 / 更新 / 关注 / 管理通知 |
| `community_audit_logs` | 管理员操作审计 |
| `community_view_daily` | 按作品 + 日期的浏览聚合（无用户/IP/设备） |

索引覆盖发布状态、类型、作者、精选、分类、评论、举报、通知、审计与清理状态。计数列仅作查询缓存，互动后统一用 `COUNT(*)` 重算。

---

## 5. R2 存储

沿用绑定 `FILES` / bucket `guandao-files`，不新建 bucket。

```
users/{userId}/community/avatars/{assetId}.{ext}
users/{userId}/community/covers/{assetId}.{ext}
users/{userId}/community/previews/{assetId}.{ext}
users/{userId}/community/wallpapers/{assetId}.{ext}
users/{userId}/community/packages/{postId}/{version}/package.json
users/{userId}/community/packages/{postId}/{version}/manifest.json
```

- 所有 Object Key 由服务端使用随机 UUID 生成，不使用原始文件名，客户端不能指定路径
- R2 保持私有；读取统一走 `GET /api/community/media/:assetId`
- 媒体访问规则：
  - 已发布作品 → 公开（缓存 300 秒）
  - 草稿 / 待审核 / 隐藏 / 未通过 → 仅作者与审核员
  - 头像 / 封面 → 仅在被社区资料引用时公开
  - 未绑定作品的上传 → 仅作者与审核员
- 图片按真实文件头验证，仅允许 JPEG / PNG / WebP / GIF；拒绝 SVG / HTML / 伪装扩展名
- 上传大小、每日发布数、评论数、内容包数、每用户存储均有服务端配额
- 删除采用 `status='deleting'` + 重试计数，Cron 每 15 分钟清理；内容包删除同样有重试
- 注销账号时会删除 `users/{userId}/community` 整个前缀

---

## 6. API 列表（全部已实现）

统一前缀 `/api/community`。

### 读取

- `GET /meta`
- `GET /feed?tab=featured|latest|trending|following&type=&page=`
- `GET /explore?type=&category=&tag=&sort=&page=`
- `GET /search?q=&type=&category=&sort=&page=`
- `GET /creators?sort=&q=&page=`
- `GET /creators/:id?type=&sort=&page=`
- `GET /posts/:id`
- `GET /posts/:id/comments?page=`
- `GET /posts/:id/versions`
- `GET /posts/:id/package?version=&count=1`
- `GET /media/:assetId`（图片 / 带 `download=1` 的附件响应）

### 写入（需 Session + 同源）

- `POST /uploads`（multipart，图片 + 缩略图）
- `POST /posts`、`PATCH /posts/:id`、`DELETE /posts/:id`
- `POST /posts/:id/publish`、`POST /posts/:id/withdraw`
- `POST /posts/:id/versions`
- `POST /posts/:id/like`、`DELETE /posts/:id/like`
- `POST /posts/:id/favorite`、`DELETE /posts/:id/favorite`
- `POST /posts/:id/comments`、`DELETE /comments/:id`
- `POST /reports`、`POST /comments/:id/report`
- `POST /creators/:id/follow`、`DELETE /creators/:id/follow`
- `POST /posts/:id/view`
- `GET/PATCH /me/profile`、`GET /me/creations`、`GET /me/favorites`、`GET /me/favorite-collections`
- `GET /me/notifications`、`PATCH /me/notifications`、`GET /me/usage`、`GET /me/following`

### 管理（staff / admin）

- `GET /admin/queue`、`POST /admin/posts/:id/review`、`POST /admin/posts/:id/feature`
- `GET /admin/reports`、`POST /admin/reports/:id/review`
- `GET /admin/users`、`PATCH /admin/users/:id/role|status|restriction`
- `GET/PATCH /admin/settings`
- `GET/POST /admin/invites`、`DELETE /admin/invites/:id`
- `GET /admin/audit`、`GET /admin/stats`

---

## 7. 内容包规范与安全

统一 JSON Manifest（`schemaVersion: 1`）：

```json
{
  "schemaVersion": 1,
  "packageId": "ocean-theme",
  "type": "theme",
  "name": "Ocean Theme",
  "version": "1.0.0",
  "author": "creator",
  "description": "…",
  "compatibility": { "minimum": "1.6.0" },
  "license": "CC-BY-4.0",
  "assets": [],
  "configuration": {}
}
```

- 严格白名单字段；任何层级出现 `script` / `html` / `eval` / `src` / `url` / `href` / `import` / `wasm` / `code` / `on*` 等执行字段直接拒绝
- 限制嵌套深度、字段长度、数组数量、总大小（128 KB）
- 版本号 semver；兼容性在发布、审核、下载、安装四层检查
- 主题配置只接受内置壁纸 ID、`#RRGGBB`、受控枚举与数值范围
- 组件配置只接受系统已注册的 10 种类型与受控 props；不执行 JavaScript/HTML/WASM
- 工作空间只允许布局与外观字段，不含笔记正文、日历事件、文件路径、账号或 Session
- 教程正文先整体转义，再使用受限 Markdown 渲染
- 内容包文本与元数据写入 R2；SHA-256 由服务端计算，客户端安装前再次校验

### 安装对接

| 类型 | 安装到 | 说明 |
|---|---|---|
| Theme | `os14/themes.ts` | `normalizeTheme` → `saveCustomTheme` → 可选 `applyTheme` |
| Widget | `os14/widgetstore.ts` | 注册为声明式 `WidgetSpec`，受控渲染 |
| Workspace | `os14/workspaces.ts` | 新增工作空间，导入前写保护性快照，缺失应用/组件跳过 |
| Wallpaper | `os13.ts` | 下载 → 本机压缩 → IndexedDB → 自定义壁纸引擎 |
| Tutorial | 详情页 | 只读，不修改系统 |

主题更新会检查当前外观是否仍与主题原始配置一致；若用户已做本地个性化调整，则保留当前外观，仅更新保存的主题定义。工作空间更新以新副本导入，不覆盖用户已修改的场景。

---

## 8. 审核与举报

- 作品状态：`draft` / `pending_review` / `published` / `hidden` / `rejected` / `deleted`
- 默认发布进入人工审核；管理员可直接发布（用于自身与紧急处理）
- 审核员不能审核自己的作品；不能删除作品；不能修改社区设置
- 举报不自动隐藏内容，必须人工确认，避免举报轰炸
- 举报处理动作：驳回、隐藏作品、删除作品（admin）、隐藏评论、限制用户（admin）
- 所有审核、举报、角色、设置、邀请操作写入 `community_audit_logs`
- 处理结果通过站内通知推送给作者 / 评论者 / 被限制用户

---

## 9. 安全与隐私边界

- 所有写入要求 Session + 同源校验；所有权限在服务端判断
- 未发布内容与媒体的读取按作品状态 + 作者 / 审核员身份判断
- 跨用户资源 ID 不能复用；资源归属校验 `user_id`
- 点赞 / 收藏 / 关注 / 举报有数据库唯一约束
- 评论先转义渲染，长度 / 链接数 / 重复字符 / 垃圾词过滤，双层回复
- 浏览只按作品 + 日期聚合，不记录 IP、设备、精确位置或用户标识
- 社区资料与私人账号数据分离，接口不返回 email、GitHub 数字 ID、Session、设备、笔记、日历、云盘或备份
- R2 私有，公开媒体通过服务端发布状态检查
- 请求频率限制接入现有 D1 固定窗口限流（上传 / 评论 / 写入 / 媒体）
- 内容包不能执行任意代码；组件不能读取未声明权限的数据
- 管理员操作可审计；停用账号会撤销其全部 Session

---

## 10. 测试与部署结果

| 项目 | 结果 |
|---|---|
| 本地 D1 从零执行 0001–0009 | ✅ 通过（46 条命令） |
| 远程 D1 0009 迁移 | ✅ 通过（46 条命令） |
| Astro 构建 | ✅ 通过 |
| Community API 端到端 QA | ✅ 51/51 通过（`node scripts/community-qa.mjs`） |
| 注册策略服务端校验 | ✅ 关闭 → registration_closed；邀请制无码 → invalid_invite；有效邀请 → 创建 join intent 且不提前消耗；开放 → 进入 OAuth |
| 媒体越权 | ✅ 待审核作品封面：访客 404、作者/审核员 200 |
| 组件安装 | ✅ 安装后桌面出现声明式组件 |
| 主题安装 | ✅ 写入主题中心并应用 |
| 工作空间导入 | ✅ 新增工作空间 + 保护性快照 |
| 壁纸安装 | ✅ 下载、压缩、本机保存并应用 |
| 版本更新 / 回退 | ✅ 1.0.0 → 1.1.0 → 回退 1.0.0 |
| Cloudflare 部署 | ✅ `my-homepage` Worker 已部署 |
| 生产冒烟 | ✅ `/api/health`、`/api/community/meta`、OS 1.6、Community 应用无控制台错误 |

生产地址：<https://guandao.xin>

---

## 11. 首次启用社区（人工配置）

1. 使用原管理员 GitHub 账号登录 <https://guandao.xin>。
2. 顶部菜单 → **Guandao Community**（或应用中心安装）。
3. 侧栏 **审核中心 → 社区设置**：
   - 当前已设置为「邀请制」，可改为「开放注册」或「关闭注册」；
   - 设置是否人工审核（建议保持开启）；
   - 设置每日发布 / 评论 / 存储配额。
4. **审核中心 → 邀请注册** → 生成邀请码（只显示一次）。
5. 把邀请码发给朋友；对方在登录窗口使用「加入 Guandao Community」。
6. 在 **审核中心 → 作品审核** 处理首批内容。

其余 Cloudflare 配置：沿用现有 `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` / `APP_ORIGIN` / `INITIAL_ADMIN_SETUP_TOKEN`，无需新增密钥。R2 bucket 与 D1 绑定不变。

---

## 12. 修改文件清单（1.6）

**新增**

- `migrations/0009_community.sql`
- `worker/api/community/`：`handlers.js`、`write.js`、`admin.js`、`store.js`、`validate.js`、`common.js`、`registration.js`、`maintenance.js`
- `src/lib/community/`：`api.ts`、`manifest.ts`、`install.ts`
- `src/lib/os14/community.ts`
- `src/styles/community.css`
- `scripts/community-qa.mjs`
- `docs/COMMUNITY-1.6.md`

**修改**

- `worker/api/router.js`、`worker/index.js`、`worker/api/ratelimit.js`
- `worker/api/auth/handlers.js`、`worker/api/privacy/handlers.js`
- `src/lib/os14/index.ts`、`catalog.ts`、`appcenter.ts`、`widgetstore.ts`、`workspaces.ts`
- `src/lib/os13.ts`、`src/lib/icons13.ts`
- `src/lib/account/client.ts`
- `src/pages/index.astro`、`src/styles/account.css`、`src/styles/os14.css`
- `migrations/README.md`、`README.md`、`package.json`、`package-lock.json`
- `scripts/community-prod-smoke.mjs`、`scripts/community-mobile-smoke.mjs`（本地浏览器冒烟工具）

---

## 13. 已知限制

1. 生产社区当前为「邀请制」且尚无邀请码，需要管理员生成首批邀请码并邀请创作者。
2. 社区短动态（纯文字/图片 Moment）未实现；Following 动态来自关注创作者的作品发布。
3. 星级评分未实现；当前使用点赞 + 评论。
4. 搜索使用 D1 `LIKE` + 索引，数据量大后再考虑 FTS。
5. 缩略图在浏览器端生成（主图 + 640px WebP），服务端只验证真实格式与尺寸，不做二次转码。
6. 主题更新会保留用户本地外观调整；工作空间更新以新副本导入，不覆盖旧场景。
7. 注销账号删除社区 R2 前缀，但账号数据导出暂不包含社区作品正文。
8. 生产社区目前为空，需要管理员开启注册并邀请首批创作者。
9. 所有内容审核为人工，不存在自动 AI 审核。
