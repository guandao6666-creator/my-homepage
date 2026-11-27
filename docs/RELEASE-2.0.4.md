# Guandao OS 2.0.4 · 缺陷扫描与修复报告

- **版本**：2.0.4
- **代号**：Quiet Repairs
- **日期**：2026-11-21
- **类型**：补丁（上游 2.0.3「Silent Ballot」）
- **状态**：已部署生产（2026-11-21，Version `78e78621-8f36-4585-87bd-a91e74ceaa3f`）

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
| F5 | 配对领取 `confirmed → completed` 无条件更新 | 两个并发轮询都调用 `createSessionRow`，同一配对码换出两枚 Session，其中一枚永远沉默在会话表里 | 已修，确定性单测 + 负向对照 + 真实 Worker E2E |
| F6 | 失败备份不清理 R2 对象 | `failBackup` 只改状态；失败备份 `size_bytes` 为 NULL，`storageStats` 统计不到，重试会累积孤儿对象 | 已修，单测 + 负向对照 |
| F8 | 同步 push 配额先查后写 | 两个并发 push 都看到「还剩 1 个名额」，各自写入成功 → 突破 5000 实体 / 2000 墓碑上限 | 已修：配额闸门进 SQL，单测 + 负向对照 |
| F9 | 文件上传配额先查后写 | 两个并发上传都看到「还剩 300MB」，各自写入 R2 → 合计突破 5 GiB | 已修：先占位再复核，单测 + 负向对照 |
| — | 分页 `?limit=abc` → NaN → 500 | 复核后**不成立**：store 层有 clamp 与 `\|\|` 默认值 | 未改（避免无意义改动） |

另有 2 条已定位但**未在本轮修**（需要事务语义，见 §6）：同步 push 配额 TOCTOU、文件上传配额 TOCTOU。

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

### 2.5 F5 · 配对领取把状态转换当唯一闸门

`GET /api/pairing/claim/:id?secret=` 在状态为 `confirmed` 时先 `createSessionRow`，最后才把配对置为 `completed`，而且不检查 `meta.changes`。两个并发轮询都能通过前面的状态判断，于是各签发一枚 Session。

修法（`worker/api/pairing/handlers.js`）：

1. 先做条件更新：`UPDATE device_pairings SET status='completed', completed_at=? WHERE id=? AND status='confirmed'`；
2. `Number(claimed?.meta?.changes ?? 0) === 0` → 直接 `ok({ status:"completed", paired:true, alreadyDelivered:true })`，不写 Session；
3. 抢到占位的请求再 `createSessionRow`；写入失败则把状态退回 `confirmed`，避免「已完成却永远拿不到 Session」的死状态。

**证据**

- 新增 `tests/unit/pairing-claim.test.ts`：假 D1 把交错摆出来——两个请求都读到 `confirmed`，只有一个拿到 `changes=1`；落败方必须返回 `alreadyDelivered` 且会话插入次数为 0。`npx vitest run tests/unit/pairing-claim.test.ts` → **2 passed**。
- 负向对照：还原旧 `worker/api/pairing/handlers.js` 后重跑 → **1 failed**（`落败的领取请求不应创建 Session`）；恢复后 2 passed。
- 新增 `tests/e2e/pairing-claim-race.spec.ts`（真实 Worker + 真实 D1）：create → claim → confirm → 并发两次领取，断言**恰好一个响应带 `gauth_sid`**、另一个 `alreadyDelivered: true`。`npx playwright test --project=worker tests/e2e/pairing-claim-race.spec.ts` → **1 passed（12.9s）**。
- 如实说明：本机并发请求很难稳定撞进「两个都读到 confirmed」的窗口，E2E 在旧代码上也能通过（12.9s）；判别旧实现的责任由上面的确定性单测承担。

### 2.6 F6 · 失败备份清理 R2 半成品

`failBackup` 原来只更新备份/任务状态，注释却写着「超限时直接失败并清理」。失败备份的 `size_bytes` 是 NULL，`storageStats` 统计不到，用户反复重试会累积孤儿对象。

修法：在状态更新之后追加

```js
await deleteBackupPrefix(env, `users/${userId}/backups/${backupRow.id}`).catch(() => undefined);
```

清理失败不改写「备份失败」的语义，所以吞掉异常；`deleteBackupPrefix` 本身按前缀分页，超过单页 500 条也不会漏删。

**证据**

- 新增 `tests/unit/backup-cleanup.test.ts`：跨两页的对象全部删除；源码约束 `failBackup` 含清理调用且位于状态更新之后。`npx vitest run tests/unit/backup-cleanup.test.ts` → **2 passed**。
- 负向对照：还原旧 `worker/api/backups/handlers.js` 后重跑 → **1 failed**（缺少 `deleteBackupPrefix` 调用）；恢复后 2 passed。

### 2.7 F8 · 同步 push 配额闸门进写语句

原来 `worker/api/sync/handlers.js` 的顺序是「`userQuotaStats` + `estimateQuotaDelta` 预检 → 逐条 `applyChange`」。预检和写入之间隔着 await：两个并发 push 都算出「还剩 1 个名额」，都通过预检，各自写入成功 —— 上限被突破，而且不会有任何报错。

修法：预检保留（快速失败 + 明确文案），真正的守门放进 `applyChange` 的写语句：

```sql
-- 更新且要新增墓碑（活实体 → 墓碑）时
UPDATE sync_entities SET ... WHERE user_id = ? AND domain = ? AND entity_id = ? AND revision = ?
  AND (SELECT COUNT(*) FROM sync_entities WHERE user_id = ? AND deleted = 1) < ?;

-- 插入新实体时（墓碑同理，子查询改成 deleted = 0）
INSERT INTO sync_entities (...) SELECT ...
  WHERE NOT EXISTS (SELECT 1 FROM sync_entities WHERE user_id = ? AND domain = ? AND entity_id = ?)
    AND (SELECT COUNT(*) FROM sync_entities WHERE user_id = ? AND deleted = 0) < ?;
```

`changes === 0` 时先确认是不是配额挡下的（`countKind` 返回的计数达到上限 → `outcome: "quota"`），再走原来的冲突判定 —— 否则「配额挡下」会被误报成「冲突」，客户端会去合并不存在的服务端版本。HTTP 层把 `quota` 映射成 409 `QUOTA_EXCEEDED`，details 仍是 `{scope,current,limit}`（契约不变）。

如实记录的语义：这一批里排在前面、已经写入的条目不会回滚（D1 没有事务），客户端收到 409 会整批重推；重推时那些条目带着旧 `baseRevision` 会以 conflict 返回服务端版本，客户端合并后收敛，不丢数据。

**证据**

- `tests/unit/sync-store.test.ts` 新增 2 条：只剩一个实体名额时并发两条 → 1 applied / 1 quota，计数停在上限；墓碑满 2000 后再删活实体 → quota 且原行保持不变。同文件 `npx vitest run` → **20 passed**（原 18）。
- 负向对照：`git stash push -- worker/api/sync/store.js`（回到 2.0.4 已修原子写、但无配额闸门的版本）→ 同文件 **2 failed**（就是新增的两条）；`git stash pop` 恢复 → 20 passed。

### 2.8 F9 · 文件上传先占位再复核

原来 `uploadHandler` 是「`usage()` 预检 → `insertPendingFile` → R2 put → `markFileReady`」。两个并发上传都读到「还剩 300MB」，都通过预检，各自把对象写进 R2，合计越过 5 GiB。

修法：预检保留（省掉读 body 前的等待），在占位之后补一道复核闸门 `assertReservedFileQuota(env, userId, id, limit)`：`usage()` 把 `pending` 也算进占用，所以先写 pending 行再求和，后到的请求一定能看到先到的 pending 行；超限就删掉自己的占位并抛 507。此时还没写 R2，失败不会留下孤儿对象。并发下只可能「都保守拒绝」或「排队通过」，不会一起越界。

**证据**

- 新增 `tests/unit/files-quota.test.ts`（真实 SQLite：migrations 0001 + 0003，`pending` 行由 `insertPendingFile` 真写入）：3 条用例 —— 占位后仍在上限内返回用量；两个 6 字节占位对 10 字节配额 → 507 且只删自己；配额按用户隔离、删占位不碰别人的行。`npx vitest run` → **3 passed**。
- 负向对照：临时把 `if (reserved.usedBytes > limit)` 改成 `if (false)`（旧行为）→ **2 failed**；恢复后 3 passed。（过程中出过一次事故：临时脚本的「恢复」没真正写回，导致 `npm run verify` 先红；发现后用 `edit` 手工恢复并复跑，已记入 LOG 教训。）

### 2.9 版本号 9 处

`package.json` / `package-lock.json`（根两行）/ `src/lib/version.ts`（`OS_VERSION` + `RELEASES` 首条 2.0.4）/ `worker/api/version.js` / `public/sw.js`（`guandao-2.0.4`）/ `shared/plugin-spec.js` / `worker/api/community/validate.js` / `cli/guandao.mjs` / `src/lib/core/registry.ts`。

同步断言：`tests/e2e/os20.spec.ts`（4 处）、`scripts/community-qa.mjs`（2 处）、`scripts/plugins-qa.mjs`、`.github/workflows/quality.yml`（2 处）。

`node scripts/check-version.mjs` → `[version] 一致：2.0.4`。

---

## 3. 测试证据（本机实跑）

| 项目 | 命令 | 结果 |
| --- | --- | --- |
| 版本一致性 | `node scripts/check-version.mjs` | `2.0.4`，exit 0 |
| 同步并发单测 | `npx vitest run tests/unit/sync-store.test.ts` | 20 passed（含配额 2 条）；负向对照 2 failed |
| 抽奖日界单测 | `npx vitest run tests/unit/draw-day.test.ts` | 6 passed |
| 配对领取单测 | `npx vitest run tests/unit/pairing-claim.test.ts` | 2 passed；负向对照 1 failed |
| 备份清单测 | `npx vitest run tests/unit/backup-cleanup.test.ts` | 2 passed；负向对照 1 failed |
| 上传配额单测 | `npx vitest run tests/unit/files-quota.test.ts` | 3 passed；负向对照 2 failed |
| 全部单测 | `npx vitest run` | **25 files / 392 tests passed**（1.12s） |
| 深目录删除 E2E | `npx playwright test --project=worker tests/e2e/files-folders-deep.spec.ts` | 1 passed（16.3s） |
| 深目录负向对照 | 还原旧 `files/handlers.js` 后同命令 | 1 failed（500，判别成立） |
| 配对并发 E2E | `npx playwright test --project=worker tests/e2e/pairing-claim-race.spec.ts` | 1 passed（12.9s；旧代码也能通过，判别靠单测） |
| 教程页面级 E2E（P3-2） | `npx playwright test --project=worker tests/e2e/community-tutorial.spec.ts` | **2 passed（17.3s）**：新增浏览器内断言 —— 详情「教程正文」面板渲染 h3/h4/strong/链接，`<img onerror>` 只是文本、无 `img` 元素与 `javascript:` 链接 |
| 全量 E2E | `$env:E2E_ADMIN_PORT='18789'; npx playwright test` | **193 passed（5.2m）**，exit 0（教程页面级断言并入后复跑） |
| 全量门禁 | `npm run verify` | **exit 0**（typecheck 0 errors；build 30 页；CSP 12 哈希 / 31 HTML 一致；HTML 安全审查合计 294 处、未审查 0） |
| 体积基线 | `node scripts/perf-baseline.mjs --json` | 入口 JS 434.8 / 439.5 KB（98.9%）；首屏 CSS 184.7 / 195.3 KB（94.6%） |
| **生产性能基线（6.4）** | `npm run perf:prod`（`measure-perf.mjs --remote --runs 3`） | 冷启动 #1：**TTFB 211 ms · FCP 476 ms · LCP 792 ms · CLS 0.003 · DCL 664 ms · Load 764 ms**，25 个资源 / 481 KB；后续两次冷启动走 CDN 缓存（3 KB） |

> 注：`perf-baseline` 仍提示 `dist` 有 7 组同名不同哈希的残留（未清理 dist 的历史现象），预算判定仍通过。

---

## 4. 兼容性

- **没有改公开 API 契约**：路由、请求体、成功响应结构均不变；F1 只把冲突判定收进 SQL，冲突时仍返回 `outcome: "conflict"`；F4 只改执行方式。F8 的 409 仍是 `QUOTA_EXCEEDED` + `{scope,current,limit}`，只是现在也会在「预检之后被并发越界」时出现；F9 的 507 文案与触发时机不变，只是判定从「预检」变成「占位后复核」。
- **没有新增数据库迁移**：只用了现有表和现有列（`sync_entities`、`sync_tombstone_ledger`、`files`）。
- 版本号变化会影响 `/api/health`、`x-guandao-version`、更新中心展示；旧客户端不做版本门禁的仍可正常使用（本轮未改 `minimumOSVersion` 语义）。

---

## 5. 部署（已完成，2026-11-21）

**已部署生产**。按项目规则，只有拿到生产实测证据后才从 Blocked 改为 Verified —— 下面是这一轮的实跑记录：

| 步骤 | 结果 |
| --- | --- |
| 迁移检查 | `npx wrangler d1 migrations list guandao-db --remote` → `✅ No migrations to apply!` |
| 部署前备份 | `npx wrangler d1 export guandao-db --remote` → `C:\Users\1\Desktop\my-homepage\.backups\guandao-db-prod-20261121-200010.sql`（654,863 B） |
| 部署 | `npm run cf:deploy` exit 0 → build 30 页、32 个静态资源、Total Upload 740.12 KiB / gzip 162.62 KiB、Worker Startup 正常；**Version `78e78621-8f36-4585-87bd-a91e74ceaa3f`** |
| health | `/api/health` → `"version":"2.0.4"`、D1 connected、R2 available（put/get/head/delete 全 true） |
| 响应头 / 首页 | `x-guandao-version: 2.0.4`；首页 200（27,812 B）；入口 `index.astro_astro_type_script_index_0_lang.DmEHLhza.js`（445,610 B）含 `2.0.4` |
| 生产 E2E | `npm run qa:prod` → **35/35 通过**，清理后 `{"users":0}`（stderr 仍有既有 `event_type` CHECK 约束警告，脚本 exit 0） |
| 回滚 | `npx wrangler rollback`（或重新部署上一个 Version `f7af6eda-f904-4e99-b7a4-051653e8819a` = 2.0.3） |

---

## 6. 未修与风险（如实记录）

本轮定位到的缺陷已全部修完（F1–F6、F8、F9；F7 为版本号收口），**没有留下「已定位未修」的条目**。

仍未覆盖的边界（不是缺陷结论，而是证据边界）：

- **配额测试是单测 + 负向对照，不是真实 Worker E2E**：5000 条实体 / 5 GiB 的量级不适合在本地 E2E 里造；判别责任由真实 SQLite 单测承担（旧代码确实会红）。
- **F8 的 409 可能出现在「部分写入之后」**：这是 D1 无事务的固有语义，客户端重推会以 conflict 收敛；已在 §2.7 写清，不是未记录的行为。
- **配对领取并发 E2E 在本机撞不进竞态窗口**：旧代码也能通过，判别靠确定性单测（已如实写在 §2.5 与证据表）。

其他环境事实：

- 本地全量 E2E 会被 `plugin-upload` 限流（20 次/小时，`worker/api/ratelimit.js:245-251`）卡住；连跑前清本地 D1 `rate_limits`，跑中每 20s 清一次（本轮用的就是 `node:sqlite` 循环）。
- `wrangler d1 execute --local` 在本机因 `miniflare-email-store` 目录权限不可用，清表一律走 `node:sqlite` 直连。
- Windows 上连续快速重写同一文件会偶发 `ReplaceFileW EIO (Win32 32)`；用 `edit` 工具重试即可，别在这时候断定测试失败是代码问题（本轮 `files-quota` 的负向对照恢复失败就属于这类事故）。