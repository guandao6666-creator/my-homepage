# Guandao OS 2.0.4 · 缺陷扫描与修复报告

- **版本**：2.0.4
- **代号**：Quiet Repairs
- **日期**：2026-11-21
- **类型**：补丁（上游 2.0.3「Silent Ballot」）
- **状态**：代码与证据已齐，**未部署生产**（等待授权；按项目规则记为 Blocked）

---

## 1. 这版在修什么

这轮不是功能迭代，是把系统按块拆开逐块找 bug 的第一轮结果。扫描范围：

- Worker API：`auth` / `admin` / `privacy` / `backups` / `community` / `sync` / `devices` / `files` / `plugins` / `pairing`
- 前端外壳与 OS 层：`shell` / `os13` / `os20` / `core`
- 应用层：`os14`（社区、设置、诊断）/ `legacy-apps` / `mobile`

| # | 缺陷 | 影响 | 结论 |
| --- | --- | --- | --- |
| F1 | 同步 `applyChange` 读—判—写竞态 | 两个并发 push 会拿到**同一个 revision 号**、后写覆盖先写，客户端永远不产生冲突记录 → 编辑静默丢失 | 已修，单测 + 负向对照 |
| F2 | 抽奖用 UTC 日判断「今天」 | 东八区本地 00:00–08:00 仍算昨天，可以再抽一次；08:00 才重置 | 已修，单测 |
| F3 | 「存储告警每天一次」同样用 UTC 日 | 与 F2 同源：本地早上 8 点才允许再次提醒 | 已修（复用 `todayKey`） |
| F4 | 目录树递归删除把整棵树展开进 `IN (?,…)` | D1 单条语句上限 100 个参数；≥ 99 个节点的目录删除/永久删除直接 500 | 已修，真实 Worker E2E + 负向对照 |
| — | 分页 `?limit=abc` → NaN → 500 | 复核后**不成立**：store 层有 clamp 与 `\|\|` 默认值 | 未改（避免无意义改动） |

另有 4 条已定位但**未在本轮修**（需要事务语义或更大改动，见 §6）：同步/文件配额 TOCTOU、配对 claim 非原子、备份失败不清理 R2。

---

## 2. 逐条改动

### 2.1 F1 · 同步 `applyChange` 改为条件写

旧的写法是三步：先 `SELECT revision` → JS 判断冲突 → `INSERT … ON CONFLICT DO UPDATE`。D1 只保证**单条语句**原子，两步之间可以插入另一个请求：

```js
// 修复前（worker/api/sync/store.js）
const existing = await env.DB.prepare("SELECT revision …").bind(...).first();
if (existing && existing.revision !== revision) return { outcome: "conflict", ... };
await env.DB.prepare("INSERT INTO sync_entities … ON CONFLICT(…) DO UPDATE SET …").bind(...).run();
```

两个并发请求都读到 `revision = 5`、都判「不冲突」、都写 `revision = 6`，后写者整条覆盖先写者，而且两边都以为自己是第 6 版 —— 客户端因此永远不会进入冲突流程。

现在把判断放进同一条语句的 `WHERE` 里，用 `meta.changes` 判定谁赢：

```js
// 修复后（worker/api/sync/store.js:applyChange）
const updated = await env.DB.prepare(
  `UPDATE sync_entities SET revision = ?, deleted = ?, payload_json = ?, updated_at = ?, deleted_at = ?
   WHERE user_id = ? AND domain = ? AND entity_id = ? AND revision = ?`,
).bind(next, …).run();
if (Number(updated?.meta?.changes ?? 0) === 0) {
  const fresh = await readEntity(env, userId, domain, entityId);
  return { outcome: "conflict", entity: fresh ? mapRow(fresh) : null };
}
```

首次推送同样条件化：`INSERT … SELECT ?,… WHERE NOT EXISTS (SELECT 1 FROM sync_entities WHERE …)`，`changes === 0` 时回读并返回冲突。

**证据**

- `tests/unit/sync-store.test.ts` 新增 `RacingD1`（用 Promise 闸门把两个读者的第一步都放行，再让写入竞争）与两条用例：
  - 「两个并发更新基于同一 revision：一条写入、一条冲突」
  - 「两个并发首次推送同一实体：只插入一条」
- `npx vitest run tests/unit/sync-store.test.ts` → **18 passed**（原 16）。
- 负向对照：`git stash push -- worker/api/sync/store.js` 后跑同文件 → **2 failed / 16 passed**（两条新用例红），恢复后 18 passed。说明用例能判别旧实现，不是恒真。

### 2.2 F2 · 抽奖按本地日，而不是 UTC 日

`src/lib/legacy-apps/draw/index.ts` 原来用 `new Date().toISOString().slice(0, 10)`。对 UTC+8 的用户，本地 00:00–08:00 的「今天」在 UTC 里还是昨天，于是抽过的那天本地看起来又能抽第二次。

```ts
// 新增：与 os14/core.ts 的 todayKey 同语义，但内联在这个独立 chunk 里，避免跨 chunk 依赖
export const drawDateKey = (now: Date = new Date()): string =>
  `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
```

`init()` 的读取与点击后的写入都改用 `drawDateKey()`；注释写明「跨零点窗口不能写昨天的日期」。

**证据**：`tests/unit/draw-day.test.ts` 6 条用例（本地 00:05 / 07:59 / 23:55、跨月跨年补零、东八区偏移下与 UTC 日不同、源码断言写入用 `drawDateKey()` 且不再出现 `.toISOString().slice`）→ **6 passed**。

### 2.3 F3 · 「存储告警每天一次」改用 `todayKey()`

`src/lib/os14/index.ts` 的同类判断换成项目已有的本地日 helper（`src/lib/os14/core.ts:449`）。影响比抽奖小，但同属「UTC 日 ≠ 用户日」这个错误假设。

### 2.4 F4 · 深目录删除分块执行

`deleteFolderHandler` / `permanentFolderHandler` 原来把 `folderTree()` 返回的整棵树拼进一条 `IN (?, ?, …)`。D1 单条语句最多 100 个绑定参数，因此 99 个节点以上的目录删除会 500，而且树可能已经被改了一半。

现在按 40 个一批（`FOLDER_TREE_CHUNK`，仓库已有的 `ID_CHUNK_SIZE = 40` 先例）：

- 统计文件数：`for (chunk of chunks) SELECT COUNT(*) … parent_id IN (chunk)`
- 回收站：`env.DB.batch(chunks.map(chunk => UPDATE folders … IN (chunk)))`，再 batch `UPDATE files … trash`
- 永久删除：分块 `SELECT id, r2_key … IN (chunk)` 汇总 → R2 删除 → 失败项按分块置 `pending_delete` → 最后 `batch(chunks.flatMap(chunk => [DELETE files, DELETE folders]))`

**证据**

- 新增 `tests/e2e/files-folders-deep.spec.ts`（真实 Worker + 真实 D1）：建 120 层目录 → 非递归删除 **409** 且消息含 `119 个子文件夹` → `?recursive=1` **200** → `permanent` **200** → 再删 **404**。`npx playwright test --project=worker tests/e2e/files-folders-deep.spec.ts` → **1 passed（16.3s）**。
- 负向对照：把 `worker/api/files/handlers.js` 临时还原为 HEAD 版本后重跑 → **1 failed**，失败断言正是 `非递归删除应 409，实际 500：{"code":"INTERNAL_ERROR"}`；恢复后通过。

### 2.5 版本号 9 处

`package.json` / `package-lock.json`（根两行）/ `src/lib/version.ts`（`OS_VERSION` + `RELEASES` 首条 2.0.4）/ `worker/api/version.js` / `public/sw.js`（`guandao-2.0.4`）/ `shared/plugin-spec.js` / `worker/api/community/validate.js` / `cli/guandao.mjs` / `src/lib/core/registry.ts`。

同步断言：`tests/e2e/os20.spec.ts`（4 处）、`scripts/community-qa.mjs`（2 处）、`scripts/plugins-qa.mjs`、`.github/workflows/quality.yml`（2 处）。

`node scripts/check-version.mjs` → `[version] 一致：2.0.4`。

---

## 3. 测试证据（本机实跑）

| 项目 | 命令 | 结果 |
| --- | --- | --- |
| 版本一致性 | `node scripts/check-version.mjs` | `2.0.4`，exit 0 |
| 同步并发单测 | `npx vitest run tests/unit/sync-store.test.ts` | 18 passed |
| 抽奖日界单测 | `npx vitest run tests/unit/draw-day.test.ts` | 6 passed |
| 全部单测 | `npm run test:unit` | **22 files / 383 tests passed**（1.01s） |
| 深目录删除 E2E | `npx playwright test --project=worker tests/e2e/files-folders-deep.spec.ts` | 1 passed（16.3s） |
| 深目录负向对照 | 还原旧 `files/handlers.js` 后同命令 | 1 failed（500，判别成立） |
| 全量 E2E | `$env:E2E_ADMIN_PORT='18789'; npx playwright test` | **192 passed（4.6m）**，exit 0 |
| 全量门禁 | `npm run verify` | **exit 0**（typecheck 0 errors；build 30 页；CSP 12 哈希 / 31 HTML 一致；HTML 安全审查合计 294 处、未审查 0） |
| 体积基线 | `node scripts/perf-baseline.mjs --json` | 入口 JS 434.8 / 439.5 KB（98.9%）；首屏 CSS 184.7 / 195.3 KB（94.6%） |

> 注：`perf-baseline` 仍提示 `dist` 有 7 组同名不同哈希的残留（未清理 dist 的历史现象），预算判定仍通过。

---

## 4. 兼容性

- **没有改公开 API 契约**：路由、请求体、成功响应结构均不变；F1 只把冲突判定收进 SQL，冲突时仍返回 `outcome: "conflict"`；F4 只改执行方式。
- **没有新增数据库迁移**：只用了现有表和现有列。
- 版本号变化会影响 `/api/health`、`x-guandao-version`、更新中心展示；旧客户端不做版本门禁的仍可正常使用（本轮未改 `minimumOSVersion` 语义）。

---

## 5. 部署

**未部署**。本轮用户要求是「寻找各部分 bug，修复」，没有下达上线指令，按项目规则在文档里记为 Blocked，而不是写成 Verified。

发布路径（与 2.0.3 相同）：

1. `npx wrangler d1 migrations list guandao-db --remote` → 预期 `No migrations to apply!`
2. `npx wrangler d1 export guandao-db --remote --output .backups/guandao-db-prod-<时间>.sql`
3. `npm run cf:deploy`
4. 核对 `/api/health`（`version: 2.0.4`）、`x-guandao-version`、首页、`npm run qa:prod`
5. 推送 `main` 后等 GitHub Actions；Cloudflare 每次推送会自动构建一个新 Version，ID 以 `wrangler deployments list` 与 `/api/health` 为准
6. 回滚：`npx wrangler rollback`（或重新部署上一个 Version）

---

## 6. 未修与风险（如实记录）

已定位、**本轮未修**，留给下一轮（需要事务语义或更大范围改动）：

1. **同步 push 配额 TOCTOU**（`worker/api/sync/handlers.js:112-147`）：先 `userQuotaStats + estimateQuotaDelta` 再逐条写，并发可突破 5000 实体 / 2000 墓碑上限。
2. **文件上传配额 TOCTOU**（`worker/api/files/handlers.js:294-298`）：`usage()` 检查后再 `insertPendingFile` + R2 put，并发可突破 5 GiB。
3. **配对 claim 非原子**（`worker/api/pairing/handlers.js:157-167`）：先查 `status === 'completed'`、再无条件 `createSessionRow`、最后才 UPDATE 且不查 `meta.changes`，并发可换出多个 Session。
4. **备份失败不清理 R2**（`worker/api/backups/handlers.js:643-657`）：`failBackup` 只改状态；注释（:540-545）写「超限时直接失败并清理」，实现没有清理；失败备份 `size_bytes` 为 NULL，`storageStats` 看不见这些孤儿对象。

其他环境事实：

- 本地全量 E2E 会被 `plugin-upload` 限流（20 次/小时，`worker/api/ratelimit.js:245-251`）卡住；连跑前清本地 D1 `rate_limits`，跑中每 20s 清一次（本轮用的就是 `node:sqlite` 循环）。
- `wrangler d1 execute --local` 在本机因 `miniflare-email-store` 目录权限不可用，清表一律走 `node:sqlite` 直连。