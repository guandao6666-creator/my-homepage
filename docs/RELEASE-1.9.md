# Guandao OS 1.9 · 发布记录与回滚手册

**Release Name:** Polish Before the Next Era
**中文名:** 管道个人数字操作系统 · 性能、稳定性与全面质量升级版

---

## 1. 版本记录

| 字段 | 值 |
| --- | --- |
| Version | `1.9.0` |
| Release Name | Polish Before the Next Era |
| Release Date | 2026-11-05（Asia/Shanghai） |
| Build ID | `dist` 构建于 2026-11-05 17:05（`astro build`，29 页） |
| Commit ID | **未提交**（工作区改动，见 §7） |
| Deployment ID | Worker Version `fecd8355-fa4d-45d0-91b5-76d5192b5d7f` |
| Worker 名称 | `my-homepage`（账号 `Guandao6666@gmail.com's Account`） |
| 自定义域名 | https://guandao.xin |
| D1 | `guandao-db` / `9c89b111-bd89-47a6-8615-2c838993ede5` |
| R2 | `guandao-files` |
| 迁移 | `0012_indexes.sql`（本地 + 远程均 ✅） |

版本号只有一个来源：

- 前端：`src/lib/version.ts` → `OS_VERSION`
- Worker：`worker/api/version.js` → `WORKER_VERSION`
- 缓存：`public/sw.js` → `VERSION`
- 包：`package.json` → `version`

四者在 `npm run check:version` 与 CI 中被强制一致。任何一处改了忘记同步，CI 直接失败。

---

## 2. 部署模型（先看清楚，这里不是 Cloudflare Pages）

本项目**不是** Cloudflare Pages，也**不使用 Pages Functions**：

- Astro 以静态模式构建到 `dist/`；
- `worker/index.js` 是唯一的 Worker 入口，`wrangler.jsonc` 里 `run_worker_first: true`，
  所有请求先经过 Worker（用于安全响应头、`/api/*`、`/sb/*` 反代），再交给静态资源绑定 `ASSETS`；
- 发布命令：`npm run cf:deploy`（= `npm run build && wrangler deploy`）。

因此：
- 仓库里**没有** Pages 的 Git 集成，也没有 "push 即上线"；
- README 里关于 Pages 的旧描述与 `auto-publish.yml` 里「Cloudflare 收到推送后构建上线」的注释
  **都与实际不符**，已在 1.9 文档中更正口径；自动发布工作流只负责同步 Markdown 到仓库，
  真正上线仍需要一次 `cf:deploy`。

---

## 3. 环境划分

| 环境 | 入口 | 用途 | 数据 |
| --- | --- | --- | --- |
| 开发 | `npm run dev`（astro dev） | 前端调试；`/api/*` 不存在，账号功能自动降级为本地模式 | 浏览器本地 |
| 本地 Worker | `npm run cf:dev` | 完整后端（本地 D1/R2 模拟） | `.wrangler/state` |
| 静态预览 | `node scripts/serve-dist.mjs 4321` | 验证真实构建产物（E2E 用这个） | 浏览器本地 |
| Production | `npm run cf:deploy` | 线上 | 远程 D1/R2 |

**1.9 没有引入独立的 Preview 环境**（受限于单个 Worker + 单域名）。替代做法：

```bash
# 先上传一个不接管生产流量的新版本，拿到预览地址
npx wrangler versions upload
# 预览地址形如 https://<version>-my-homepage.guandao6666.workers.dev
# 确认无误后再发布
npx wrangler deploy
```

---

## 4. 发布步骤（每次发版照做）

```bash
# 1. 质量门禁（与 CI 相同）
npm ci
npm run check:version
npm run typecheck
npm run test:unit
npm run build          # 同时生成 CSP 哈希

# 2. 端到端
npm run test:e2e

# 3. 数据库迁移（先看再执行）
npx wrangler d1 migrations list guandao-db --remote
npx wrangler d1 migrations apply guandao-db --remote

# 4. 发布
npx wrangler deploy

# 5. 线上验证（只读）
node scripts/prod-smoke.mjs
curl -s https://guandao.xin/api/health
```

**顺序要求：**

1. 迁移必须**先于**代码发布，且只能做「加列 / 加索引 / 加表」这类向前兼容的变更；
2. 破坏性变更（删列、改类型）必须拆成两次发布：先发兼容新旧两版的代码，下一版再删；
3. 未完成数据备份前，不执行破坏性 Schema 迁移。

---

## 5. 回滚

### 5.1 Worker / 静态资源

Cloudflare 保留历史版本，回滚不需要重新构建：

```bash
# 查看历史版本
npx wrangler versions list

# 回滚到指定版本
npx wrangler rollback <VERSION_ID>

# 或者直接回滚到上一个版本
npx wrangler rollback
```

1.9 上线前的版本可以直接用 `npx wrangler versions list` 查（本次发布前生产是 1.8 版本）。

回滚后务必再跑一次：

```bash
node scripts/prod-smoke.mjs
```

注意：静态资源是按内容哈希命名的，旧版本的所有资源仍然保留在 Worker 的 assets 里；
但**数据库迁移不会自动回滚**。

### 5.2 数据库

- D1 支持 Time Travel：`npx wrangler d1 time-travel restore guandao-db --timestamp=<ms>`
- 本次 `0012_indexes.sql` 只创建索引，回滚方式：

```sql
DROP INDEX IF EXISTS idx_security_events_created;
DROP INDEX IF EXISTS idx_data_exports_expires;
DROP INDEX IF EXISTS idx_files_user_status;
DROP INDEX IF EXISTS idx_files_user_trash;
DROP INDEX IF EXISTS idx_sessions_revoked;
DROP INDEX IF EXISTS idx_backups_user_status;
DROP INDEX IF EXISTS idx_plugins_status_featured;
DROP INDEX IF EXISTS idx_community_posts_status_published;
DROP INDEX IF EXISTS idx_device_pairings_code;
```

（`plugin_audit_logs (plugin_id, created_at)` 的索引 1.7 已存在，本次未重复创建。）

### 5.3 前端缓存

`public/sw.js` 的 `VERSION` 变更会让旧缓存整体失效；如果线上出现「用户一直拿到旧外壳」：

1. 确认 `sw.js` 响应头是 `Cache-Control: no-cache`（`public/_headers` 已配置）；
2. 必要时提升 `VERSION` 再发一次；
3. 用户的旧 Service Worker 会在下次访问时进入 waiting，点了「立即刷新」才切换。

---

## 6. 本次上线记录（真实执行结果）

| 步骤 | 结果 |
| --- | --- |
| `npm run check:version` | 一致：1.9.0 |
| `npx tsc --noEmit` | 0 error |
| `npx vitest run` | 39 passed |
| `npx playwright test` | 14 passed（桌面 8 / 手机 3 / 沙箱 3） |
| `npm run build` | 29 页，2.3 s，CSP 12 个哈希 |
| 远程迁移 | `0012_indexes.sql` ✅（10 条语句，5.18 ms） |
| `wrangler deploy` | 成功，43 个资产更新，Version `fecd8355-fa4d-45d0-91b5-76d5192b5d7f` |
| `/api/health` | `version=1.9.0`，D1 connected，R2 available |
| `prod-smoke` | 8/8 通过（含按需加载真实 chunk） |

---

## 7. 未完成：提交与打标签

1.9 的改动**没有提交**。这不是遗漏，而是需要你确认的一步：工作区里同时存在 1.5–1.8 期间
未提交的功能代码（devices / backups / privacy / community / plugins / continuity / mobile 等），
把它们与 1.9 的质量改动混在同一个提交里会让回滚粒度变粗。

建议：

```bash
git add -A
git commit -m "feat(1.9): 质量升级 — 按需加载、可靠性中心、诊断与性能实验室、安全加固、自动化测试与 CI"
git tag -a v1.9.0 -m "Guandao OS 1.9 · Polish Before the Next Era"
git push origin main --tags
```

打标签后，本次的 Commit ID 就可以补进 §1 的表格里，回滚也有了明确的锚点。