# 社区与市场发布链（Phase 5）

> 状态：已实施（本地/隔离层）。生产验证未执行，细节见 §12「证据等级」。
> 范围：Guandao OS 2.3 · Phase 5 —— 社区资源发布、插件发布、教程、审核/举报/下架/审计、测试数据隔离与清理。
> 本文只记录**真实代码行为**；标注「未验证」的内容不得当作已通过。

## 1. 目的与范围

Phase 5 不新增社区产品形态，也不重写插件市场。它把已有的发布链从「代码已实现」推进到「经过真实、可重复验证」：

- 社区资源（主题 / 组件 / 工作空间 / 壁纸 / 教程）从草稿到公开的完整链路；
- 插件从 Developer Center 到 UnifiedInstaller 的完整链路（沿用 Phase 3 签名与权限策略）；
- 管理员审核、举报处理、下架与审计闭环；
- Tutorials 复用现有 `community_posts` 模型；
- 所有自动化测试只在本地/隔离 D1 + R2 上运行，并用 `scripts/lib/qa-cleanup.mjs` 四重校验清理。

**非目标**：重写社区 UI、重写插件 Runtime/Installer、绕过或另造插件签名、生产写入/迁移/部署、自动进入 Phase 6。

## 2. 角色与权限模型

| 角色 | 来源 | 能力 |
| --- | --- | --- |
| visitor | 无 Session | 读公开内容、提交举报（需登录？否，举报要求登录）、不能发布/审核 |
| member | `users.role='member'` | 创建草稿、上传、发布（成员发布进入 `pending_review`）、互动 |
| moderator | `community_roles.role='moderator'` | `isStaff` 为真：审核队列、审核内容、处理举报；**不是**管理员 |
| admin | `users.role='admin'` | `effectiveRole` 最高优先；`requireAdmin` 专属动作（删除作品、用户角色/状态、设置、邀请等） |

关键实现：

- `worker/api/community/common.js`：`effectiveRole`（admin > moderator > member）、`isStaff`、`requireStaff`、`requireAdmin`、`viewerContext`。
- 所有 `/api/community/*` 非 GET/HEAD 请求先执行 `assertSameOrigin(request, env)`（CSRF），再进入业务逻辑。
- `/api/community/admin/*` 前缀统一要求 `isStaff`；其中删除作品、用户管理、设置、邀请等动作在 `admin.js` 内再要求 `requireAdminRole`（仅 admin）。**权限判断始终在 Worker 服务端，不依赖客户端 UI。**

## 3. 社区发布链（真实流程）

```
Creator                Worker API                         D1 / R2
  │                       │                                  │
  ├─ POST /api/community/posts (draft) ──────────────────────► community_posts(status=draft)
  ├─ POST /api/community/uploads (cover/preview/wallpaper) ──► R2 users/<uid>/community/<kind>/…
  │                       │                                   community_assets(status=ready)
  ├─ PATCH /api/community/posts/:id ─────────────────────────► 更新草稿 / draft_manifest_json
  ├─ POST /api/community/posts/:id/publish ──────────────────► 校验 manifest + 兼容性
  │                       │                                   成员→pending_review；admin→published
  │                       │                                   R2 写 package + manifest
  │                       │                                   community_packages / package_versions
  ├─ POST /api/community/admin/posts/:id/review ─────────────► approve → published + published_at
  │  (admin/moderator)    │                                   notify + community_audit_logs(post.approve)
  ├─ GET /api/community/feed|search|posts/:id ───────────────► 只读 published（unlisted 仅隐藏于列表）
  ├─ GET /api/community/posts/:id/package?count=1 ───────────► 下载 R2 包（published 才 +download_count）
  └─ POST /api/community/posts/:id/view ─────────────────────► view_count（与下载计数分离）
```

### 3.1 关键接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/community/meta` | 分类、许可证、限额、公开设置 |
| GET | `/api/community/feed` `search` `explore` | 公开列表（仅 published） |
| GET | `/api/community/posts/:id` | 详情；可见性闸门见 §5 |
| POST | `/api/community/posts` | 创建草稿或直接发布（受审核设置影响） |
| PATCH/DELETE | `/api/community/posts/:id` | 作者编辑/删除草稿；删除为软删 |
| POST | `/api/community/posts/:id/publish` | 提交/发布（成员→pending_review，admin→published） |
| POST | `/api/community/posts/:id/withdraw` | 撤回（published/pending_review → draft，写审计） |
| POST | `/api/community/posts/:id/versions` | 追加新版本（版本必须递增） |
| GET | `/api/community/posts/:id/versions` | 历史版本 |
| GET | `/api/community/posts/:id/package?count=1` | 下载内容包（R2，私有读取校验） |
| POST | `/api/community/posts/:id/view` | 浏览计数 |
| POST | `/api/community/uploads` | 上传图片（avatar/cover/preview/wallpaper） |
| POST | `/api/community/reports` | 举报 post/comment/profile |
| POST | `/api/community/admin/posts/:id/review` | 审核作品（approve/reject/hide/delete/restore） |
| GET | `/api/community/admin/queue` `reports` `audit` `stats` | 审核队列/举报/审计/统计 |
| POST | `/api/community/admin/reports/:id/review` | 处理举报（dismiss/hide_post/delete_post/hide_comment/restrict_user/warn_user） |

## 4. 状态机

### 4.1 社区作品（`community_posts.status`）

| 当前 | 动作 | 结果 | 条件 |
| --- | --- | --- | --- |
| draft | publish（member） | pending_review | `community_settings.require_review` 为真 |
| draft | publish（admin） | published | — |
| pending_review | admin approve | published | 作品有 active package；自审仅 admin 可 |
| pending_review | admin reject | rejected | 写 `community_audit_logs` |
| published | admin hide | hidden | 公开列表/详情按可见性闸门处理 |
| hidden | admin restore | published | — |
| published/pending_review | withdraw | draft | 作者本人 |
| 任意 | admin delete | deleted | 软删；packages 置 deleted、assets 置 deleting；R2 由维护任务物理清理 |

### 4.2 内容包（`community_packages` / `package_versions`）

- `community_packages.status`：`active` / `deleted`；同一作品只保留一个当前包（`post_id UNIQUE`）。
- 更新作品只**追加版本**，历史版本永久保留（`package_versions` UNIQUE(package_id, version)）。
- 下载按版本/当前包读取 R2，`checksum_sha256` 用于客户端/服务端比对。

### 4.3 举报（`community_reports.status`）

`open → reviewing → resolved | dismissed`；同一用户对同一目标只有一条记录（UNIQUE reporter_id + target_type + target_id），重复举报返回 409。

## 5. 可见性规则（`worker/api/community/common.js:loadPost`）

| 状态 | 访客 | 作者 | moderator/admin |
| --- | --- | --- | --- |
| published | 可读 | 可读 | 可读 |
| draft / pending_review / hidden / rejected | 404 | 可读（可管理） | 可读 |
| deleted | 404 | 404 | 404（软删，默认不可读） |

- `visibility='unlisted'`：不出现在列表/搜索，但直链在 published 时仍可读（现有产品语义）。
- 公开列表查询只返回 `status='published'`；未审核/被拒/下架资源不会出现在 feed、搜索或详情（访客）。
- 删除作品不会立即删除 R2：`community_assets.status='deleting'` 由 `worker/api/community/maintenance.js` 重试清理（下架与物理删除分离）。

## 6. 上传与 R2 关系

- 表：`community_assets`（`object_key` 唯一、`mime_type` 白名单 jpeg/png/webp/gif、`status ready|deleting|deleted`、`delete_attempts`、`last_error`）。
- object key 完全由服务端生成：`users/<userId>/community/<kind>/<assetId>.<ext>`，客户端不能指定路径。
- 校验：`assertImage` 读取 magic bytes 判断真实类型，不信任 `Content-Type`；大小受 `community_settings.max_upload_bytes`（默认 8MB）限制；表单上限 `min(max+3MB, 24MB)`。
- 写入顺序：先 R2 `put`，再 D1 batch 写 `community_assets`；D1 失败时 `cleanupObjects` 删除刚写入对象再抛错，避免孤儿。
- R2 读取：`GET /api/community/media/...` 与 `posts/:id/package` 都经过 Worker 的可见性/授权检查，不暴露公共桶直链。

## 7. 审核 / 举报 / 下架 / 审计

- 审核队列：`GET /api/community/admin/queue`（按 status 过滤，返回 byStatus 计数）。
- 审核动作（`admin.js:adminReviewPost`）：
  - `approve`：仅 staff+admin 可自审放行；必须有 active package；置 published、`package_versions.published_at`；通知作者；审计 `post.approve`。
  - `reject`：置 rejected，理由写入 `moderation_note`/通知；审计。
  - `hide`：下架（hidden）；`restore`：恢复（published）；两者写审计。
  - `delete`：**仅 admin**；置 deleted、packages 置 deleted、assets 置 deleting、相关举报置 resolved；通知作者；审计；不立即删 R2。
- 举报处理（`admin.js:adminReviewReport`）：`dismiss` / `hide_post` / `delete_post` / `hide_comment` / `restrict_user` / `warn_user`；写 `community_reports` 状态 + 通知 + `community_audit_logs`（`report.<action>`）。
- 审计表 `community_audit_logs(actor_id, action, target_type, target_id, detail_json, created_at)`；`detail_json` 只存操作摘要，不存私密正文。

## 8. 计数规则

- `download_count`：仅 `GET /posts/:id/package?count=1` 且作品 published 时 +1；普通详情浏览不加。
- `view_count`：`POST /posts/:id/view` 单独计数，与下载独立。
- `like_count` / `favorite_count` / `comment_count`：互动后按数据库真实行重算，不依赖客户端上报。
- 插件安装次数：由插件安装接口在真实成功后更新（`plugin_installations` 维度），重复安装按现有安装记录处理，不重复累加。
- 任何失败响应都不得更新计数（测试需覆盖安装失败/审核失败不涨计数）。

## 9. Tutorials（复用 `community_posts`）

**结论：不新增表，不新增迁移。**

- `migrations/0009_community.sql` 已包含 `post_type='tutorial'` 与 `community_packages.package_type='tutorial'`；`worker/api/community/validate.js` 的 `POST_TYPES` 含 tutorial，分类为 `guide / tip / workflow / other`，正文上限 `tutorialChars = 20000`。
- 内容以纯文本/Markdown 存于 `manifest.configuration.content`；前端 `src/lib/os14/community.ts` 使用 `renderMarkdown` 渲染，`inlineMd` 先 `escapeHtml` 再替换安全标签；禁止任意 HTML 注入。前端教程编辑器、详情分支、类型标签/图标、教程计数均已存在。
- 兼容：普通帖子仍走各自类型与 manifest；tutorial 不会混入普通帖子的分类/筛选；旧帖子展示、编辑、Feed、评论/点赞不回归。
- 若未来需要教程专属字段（封面、阅读进度、目录等），优先扩展现有 JSON 结构；确需新表时必须单独设计迁移与回滚。

## 10. 插件发布链（沿用 Phase 3 + Developer Center）

```
Developer Center            Worker API                        Unified Market / Client
  ├─ POST /api/developer/plugins ────────────────────────────► plugins(status=draft)
  ├─ POST /api/developer/plugins/:id/versions ───────────────► validateManifest + validateBundle
  │    （bundle 为字符串，Phase 3 签名信封可内嵌或随 body 提交） 验签 resolveSignature
  │                                                            plugin_versions(signature_status=verified|unsigned)
  ├─ POST /api/developer/plugins/:id/submit ─────────────────► plugins(status=pending_review)
  ├─ admin approve/reject/block ─────────────────────────────► published / rejected / blocked + audit
  ├─ GET /api/plugins（市场） ───────────────────────────────► 仅 published；返回 security.signature
  ├─ GET /api/plugins/:id/package ───────────────────────────► 下载时动态复验签名 + SHA-256
  └─ POST /api/plugins/install ──────────────────────────────► 校验 packageHash/版本/签名状态/权限
                                                               plugin_installations + 安装计数
```

- 签名与权限策略是既有事实，Phase 5 **不得绕过/另造**：无签名旧包按阶段 A 兼容为 `unsigned`；签名无效/密钥撤销拒绝；安装与下载均保留 SHA-256 完整性校验。
- 紧急下架 `block`：插件置 blocked，市场不再返回；下载/安装返回 409；已安装插件不被远程删除。
- **证据分级**：API 级（发布/审核/市场/下载/安装接口）与真实客户端级（页面内 UnifiedInstaller）必须分开记录；若页面级未验证，必须写 Partially Verified。

## 11. QA 隔离与清理（本地/隔离环境）

- 测试身份：`qa-*` 用户 + `qa-*@example.test` 邮箱；每轮唯一 `runId`（标题、包 ID、内容标识）。
- 管理员身份：复用本地唯一 admin（单管理员唯一索引），不得修改生产站点所有者账号；`seed-qa-local.mjs` 中已有复用逻辑。
- `npm run qa:community` 由 `scripts/qa-local-run.mjs community` 驱动：本地 D1 迁移 → seed QA 身份 → 启动 `wrangler dev --local --port 8794`（`TEMP/TMP=.wrangler/tmpdir`）→ 运行 `scripts/community-qa.mjs` → `taskkill` 进程树。
- 清理必须复用 `scripts/lib/qa-cleanup.mjs`：
  1. `assertQaCleanupTarget`：enabled、marker/runId、`QA_ID`/`QA_EMAIL` 正则、expected user id/email 一致、重读 users 行恰好 1 行；
  2. `assertCleanupResourceCounts`：目标数量上限（默认 1000），防误删全表；
  3. `assertDeleteCount`：期望删除行数校验；
  4. `buildQaUserDeleteSql` / `buildQaChildDeleteSql`：只允许白名单表 + `qa-%` 条件，失败抛 `QaCleanupError`，**不退化为无条件删除**。
- 清理顺序：先按 runId 识别本次内容（posts/packages/assets/reports/audit/评论/点赞…），验证归属 → 删除白名单行 → 触发维护任务清理 R2（`status='deleting'`）→ 复核残留 0。
- 所有 QA 命令只连 `127.0.0.1`，禁止 `qa:prod`、禁止生产 D1/R2。

## 12. 证据等级（Phase 5 实测）

| 项 | 状态 | 证据 |
| --- | --- | --- |
| 社区发布链（草稿→上传→提交审核→管理员批准→公开列表/详情） | **通过（本地 / 隔离）** | `npm run qa:community` 连续三次 **260/260**：`mwbpn6qw` 47.5s、`mwbpodbb` 47.6s、Lead 复核 `mwbpwgmk` 48.0s；覆盖 14 段（上传安全 / 内容包负例 / 草稿可见性 / 成员待审 / 审核闭环 / 公开列表 / 下载与浏览计数 / 版本链 / 互动通知 / 举报 / 审计 / 设置权限 / 清理） |
| 上传安全与孤儿控制 | **通过** | PNG 201；SVG 与非图 415；9MB 413；失败无 R2 孤儿；`assertImage` magic bytes；所有权校验；R2 key 服务端生成 |
| 举报 / 审核 / 下架 / 审计闭环 | **通过** | 举报 201、重复 409、队列 dismiss / hide_post / delete_post；approve / reject / hide / restore / delete；审计 action + targetId 断言；普通用户 403、未登录 401；下架后公开 404；重复审批 409；不物理删除 R2 |
| 安装计数与浏览计数 | **通过** | `download_count` 仅 `package?count=1` 且 published 时 +1；`view_count` 独立；失败响应不增计数 |
| Tutorials 复用模型 + 安全渲染 | **通过（本地）** | 复用 `community_posts`（`post_type='tutorial'` 已存在），**未新增表/迁移**；`tests/unit/community-tutorial.test.ts` 20 passed ×2；`tests/e2e/community-tutorial.spec.ts` 2 passed ×2；修复教程详情正文不渲染的真实缺陷 |
| 插件发布链（API 级） | **通过（本地）** | `npm run qa:plugins` **107/107 ×2**（新增 37 项）；`tests/e2e/plugin-publishing.spec.ts` 1 passed ×2；含签名 verified → submit → 审核 → 市场列表/详情 → 下载复算 SHA-256 → 安装 → takedown → 审计 |
| 插件客户端安装（页面级） | **Partially Verified** | 本地证据脚本走真实桌面页 + 现有 UnifiedInstaller：`GOS20.wm.open("pmarket")` → 详情安装 → 确认 → 打开，20/20 + 截图；**未并入 Playwright 套件**，未新增生产调试接口 |
| 测试数据清理 | **通过** | 复用 `scripts/lib/qa-cleanup.mjs` 四重校验；三次运行均 R2=OK / 身份=OK / 残留=0；D1 基线 `total_posts=11`、`total_assets=9` 不变 |
| 全量门禁 | **通过** | `npm run verify`：19 文件 / **351 单测**、lint、build 29 pages、CSP 12 哈希/30 HTML、migrations 18/117、html-security 291 处/未审查 0；`npx playwright test` **158 passed**（chromium 67 + worker 67 + firefox 12 + webkit 12；worker 67 含社区教程 2、插件发布链 1）；`npm run qa:sync` **45/45**；`npm run qa:community` **260/260** |

## 13. 已知限制

- **生产发布链未验证**：Phase 1.6 备份告警未配置、2026-11-06 账号删除事故未 Closed → 未做生产写入/迁移/部署/`qa:prod`；本地与 CI 通过不等于生产发布链通过。
- 插件客户端安装的**页面级**证据来自本地证据脚本（真实桌面页 + cookie），未纳入 Playwright 常规套件；Playwright 内为协议级 `plugin-publishing.spec.ts`。
- 教程没有页面级浏览器 E2E：正文渲染由 `renderMarkdown` 源码守卫 + API 断言 + 单测覆盖；若后续改富文本必须单独做 Sanitizer 设计。
- `scripts/seed-qa-local.mjs` 会复用本地唯一 admin 并删除其其它 session：与 e2e fixtures 共用 admin 时不能并发运行；`plugin-publishing.spec.ts` 已做 fixtures → seed 回退。
- `follow` 正向链路在无 UUID 创作者的新库会 SKIP（API 强制 UUID 属生产设计），由旧库/CI 环境覆盖度不同。
- R2 对象清理依赖维护任务重试；测试清理在无法直接枚举 R2 时以 D1 状态 + 维护任务结果复核。
- 下架与物理删除分离：下架不删除 R2，物理删除由维护任务在安全前提下执行。
- 所有 Phase 5 测试均使用本地 / 隔离 D1 + R2，不涉及真实用户或生产管理员。
