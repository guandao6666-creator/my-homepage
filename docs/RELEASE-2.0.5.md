# Guandao OS 2.0.5 · Param Budget

- **版本**：2.0.5（补丁版本）
- **代号**：Param Budget（D1 绑定参数预算）
- **日期**：2026-11-21
- **上游**：2.0.4（Quiet Repairs）
- **状态**：**已部署生产（2026-11-21）**；Version `1aeae3dc-e6fa-4e37-b069-b4f042c0a3e1`，见 §5

## 1. 为什么有这一版

2.0.4 修掉了「深目录删除把整棵树塞进 `IN (?, ?, …)` 撞 D1 100 参数上限」这一类缺陷，
但当时只修了用户报告路径上的那一处。发布后按同一形态做了一次静态审计，又找到两处：

- **通知「标记已读」**：`worker/api/community/write.js` 先 `slice(0, 100)`，再把最多 100 个 id
  塞进一条 `UPDATE ... WHERE user_id = ? AND id IN (…)`。绑定参数 = `now + user_id + N`，
  N=99 时已经是 101 个 → D1 直接 500。客户端一次传 99 个以上通知 id 就能把接口打挂。
- **插件市场 trending**：`worker/api/plugins/store.js` 的 `marketList` 在 `sort === "trending"`
  时一次取最多 200 行候选，随后把 `since + 200 个 id` 绑进一条聚合查询（201 个参数）。
  市场上架插件 ≥99 个时，trending 页固定 500。

两处都不是「性能问题」，而是**边界一击即中**的功能不可用。补丁的范围因此定为：
把「一批 id 展开成 IN」的写/查统一走分块实现，并加一个能在实现退回去时立刻变红的测试。

## 2. 改动

### 2.1 F10 · 通知标记已读按块写

`worker/api/community/write.js`：

```js
} else if (Array.isArray(body?.ids) && body.ids.length) {
  // 一次最多处理 200 条：客户端「单条通知」场景远小于这个数，
  // 但也不能让异常客户端用 500 个 id 把单条 UPDATE 撑过 D1 的 100 参数上限。
  const ids = body.ids.filter((id) => UUID.test(String(id))).slice(0, 200);
  if (!ids.length) return ok({ unread: await unreadNotificationCount(env, viewer.id) });
  // 分块写：一条 UPDATE 的绑定是 now + user_id + N 个 id，N=99 就会超出 100。
  for (const chunk of chunkIds(ids)) {
    await env.DB.prepare(
      `UPDATE community_notifications SET read_at = ? WHERE user_id = ? AND id IN (${placeholdersFor(chunk)})`,
    )
      .bind(now, viewer.id, ...chunk)
      .run();
  }
}
```

- 上限从 100 提到 200：异常客户端不再能靠大数组把单条语句撑爆，而正常「点一条通知」
  的请求根本不会接近这个数；超过 200 的 id 仍然安静丢弃（与旧行为一致，不新增错误码）。
- 120 个 id → 3 条 UPDATE，每条 42 个参数（`now + user_id + 40`）。

### 2.2 F11 · trending 聚合按块查

`worker/api/plugins/store.js`：

```js
// trending 会一次取出最多 200 行候选，参数是 since + 200 个 id，
// 直接塞进一条 IN (?,…) 会超过 D1 的 100 参数上限 —— 所以按 40 分块查再合并。
const trend = new Map();
for (const chunk of chunkIds(ids)) {
  const trendRows = await env.DB.prepare(
    `SELECT plugin_id, COUNT(*) AS n FROM plugin_download_events
      WHERE created_at >= ? AND plugin_id IN (${placeholdersFor(chunk)}) GROUP BY plugin_id`,
  )
    .bind(since, ...chunk)
    .all();
  for (const row of trendRows.results ?? []) trend.set(row.plugin_id, Number(row.n));
}
```

- 语义不变：仍然是「近 30 天、按插件聚合、取 COUNT(*)」；分块后合并到同一个 Map。
- 代价是最多 5 次小查询（200 / 40），都在同一页渲染周期内，量级可忽略。

### 2.3 共用分块实现 `worker/api/sql.js`

新增 `worker/api/sql.js`：

- `D1_PARAM_LIMIT = 100`、`ID_CHUNK_SIZE = 40`；
- `chunkIds(list, size = ID_CHUNK_SIZE)`：空数组返回 `[]`，非法 size 回退到默认值；
- `placeholdersFor(chunk)`：生成 `"?, ?, ?"`；
- `assertParamBudget(count)`：超限抛 `D1 绑定参数超限：N > 100`，给测试桩用。

同时把两处旧实现收编，避免「三份分块逻辑各自漂移」：

- `worker/api/files/handlers.js`：删掉本地 `FOLDER_TREE_CHUNK` / `chunkIds` / `placeholdersFor`，
  改为 `import { chunkIds, placeholdersFor } from "../sql.js";`（默认块大小仍是 40）；
- `worker/api/sync/store.js`：删掉本地 `chunkArray` 与 `ID_CHUNK_SIZE` 常量，改为
  `import { ID_CHUNK_SIZE, chunkIds } from "../sql.js";`；台账 15 行/块、墓碑 20 行/块仍用各自常量。

### 2.4 版本号 9 处（与 2.0.1 起的清单一致）

`package.json`、`package-lock.json`（第 3、9 行根版本）、`src/lib/version.ts`（`OS_VERSION` + RELEASES
首条 `2.0.5 / Param Budget / 2026-11-21`）、`worker/api/version.js`、`public/sw.js`、
`shared/plugin-spec.js`、`worker/api/community/validate.js`、`cli/guandao.mjs`、`src/lib/core/registry.ts`。

随版本一起更新的断言：`tests/e2e/os20.spec.ts`（4 处）、`scripts/community-qa.mjs:338`、
`scripts/plugins-qa.mjs:196`、`.github/workflows/quality.yml:146/158`。

`node scripts/check-version.mjs` → `[version] 一致：2.0.5（package.json / version.ts / worker / sw.js）`。

## 3. 测试证据

`tests/unit/d1-params.test.ts`（新增，7 个用例）：

| 用例 | 断言 | 结果 |
| --- | --- | --- |
| 空列表 | `chunkIds([])` → `[]` | passed |
| 120 个 id | 切成 40/40/40，顺序不变 | passed |
| 自定义/非法块大小 | 7 → `7/7/6`；0 与 NaN 回退 40 | passed |
| 占位符 | `""` → `""`、`["a","b","c"]` → `"?, ?, ?"` | passed |
| 通知 120 个 id | 3 条 UPDATE，每条 42 个参数，120 个 id 全部标记 | passed |
| 负向对照（旧形态） | `now + user_id + 99 个 id` 触发 `D1 绑定参数超限：101 > 100` | passed |
| trending 源码约束 | 含 `for (const chunk of chunkIds(ids))`、不含 `ids.map(() => "?")`、有「100 参数上限」注释 | passed |

- 假 D1（`LimitDb` / `LimitStatement`）在 `bind()` 时强校验 100 上限：实现退回单条语句，
  第 5 个用例直接抛错，不需要真实 D1 才能判别。
- **负向对照实跑**：`git stash push -- worker/api/community/write.js`（回到 2.0.4 的单条 UPDATE）
  → `Test Files 1 failed / Tests 1 failed | 6 passed`，失败即
  `D1 绑定参数超限：122 > 100`（120 个 id + now + user_id）；恢复后 7 passed。
- 回归：`npx vitest run tests/unit/sync-store.test.ts tests/unit/files-quota.test.ts tests/unit/d1-params.test.ts`
  → **3 files / 30 tests passed**，证明把 files/sync 的本地分块换成共用 `sql.js` 没有改变行为。
- `npx tsc --noEmit` exit 0；`npm run verify` exit 0（25 → **26 文件 / 399 单测**）。

**真实 Worker E2E（`tests/e2e/d1-param-bounds.spec.ts`，2 个用例）**：

| 用例 | 断言 | 结果 |
| --- | --- | --- |
| 通知标记已读 120 个 id（`PATCH /api/community/me/notifications`） | 200 + `data.unread` 是数字 | passed |
| 插件市场 trending（`GET /api/plugins?tab=trending`） | 200 + 每条 `recentDownloads` 是数字（分块聚合不漏） | passed |

- 实跑：`npx playwright test --project=worker tests/e2e/d1-param-bounds.spec.ts`
  → **2 passed（12.1s）**。
- **负向对照（真实 D1）**：`git stash push -- worker/api/community/write.js`（回 2.0.4 单条 UPDATE）
  → **1 failed / 1 passed（12.6s）**，失败正是 `Received: 500`、
  `{"code":"INTERNAL_ERROR","message":"服务内部错误"}` —— 旧实现在真实 D1 上确定会 500。
  恢复后 2 passed；全量 E2E 复跑 **195 passed（4.7m）**。

## 4. 兼容性

- **公开 API 契约不变**：`PATCH /api/community/me/notifications` 的成功信封仍是
  `{ success: true, data: { unread } }`；`ids` 超过 200 的行为仍是「处理前 200 个」，
  没有新增 4xx。
- `GET /api/plugins?tab=trending`（或 `sort=trending`）的分页/排序/字段不变，只是内部聚合分块。
- 无数据库迁移；无新增环境变量或 secret。
- `worker/api/sql.js` 是 Worker 内部模块，不进客户端包（不增加入口体积）。

## 5. 部署记录（已上线）

生产已从 2.0.4 升到 2.0.5（2026-11-21，用户授权后执行）：

1. `npx wrangler d1 migrations list guandao-db --remote` → **`✅ No migrations to apply!`**；
2. D1 备份：`C:\Users\1\Desktop\my-homepage\.backups\guandao-db-prod-20261121-213900.sql`（**650,184 B**）；
3. `npm run cf:deploy` **exit 0** → build 30 页、`Uploaded 32 files`、
   `Total Upload: 740.14 KiB / gzip: 162.69 KiB`、Worker Startup 2 ms、
   **Version `1aeae3dc-e6fa-4e37-b069-b4f042c0a3e1`**；
4. 核对：`/api/health` → `"version":"2.0.5"`、D1 connected、R2 available；
   `x-guandao-version: 2.0.5`；首页 200（27,812 B）；
   入口 `/_astro/index.astro_astro_type_script_index_0_lang.9IE3LdKR.js`（446,165 B，含 `2.0.5`）；
5. `npm run qa:prod` → **35/35 通过**，清理后 `{"users":0}`；
6. 推送 `08db11d..afa7222` 后 Cloudflare 自动构建 Version
   `0cccf9e8-e2d8-4845-877c-05f4694459eb`（2026-11-21T13:39:58Z，100%）；
7. 回滚目标：`78e78621-8f36-4585-87bd-a91e74ceaa3f`（2.0.4），备份见第 2 步。

## 6. 边界与未做

- **真实证据覆盖到什么程度**：通知 120 个 id 已用真实 Worker 证明（D1 的参数上限在绑定阶段触发，
  与命中多少行无关，所以不需要造 120 条通知）；trending 的「候选 ≥99 行」分支没有在真实 E2E 里
  造满 99 个插件（上传限流 20 次/小时），只验证了响应形状与 `recentDownloads` 完整性，
  判别旧实现的证据是单测负向对照 + 源码约束。要补生产级证据，建议在 qa 脚本里用 SQL 直接
  seed 100 个插件行（不经上传接口），再请求 trending。
- **未改前端**：客户端本来就不会传 99 个通知 id；这一版只修服务端边界。
- **告警 webhook 仍未配置**（`BACKUP_ALERT_WEBHOOK` / `DATA_ALERT_WEBHOOK`），需用户提供 URL；
  与 2.0.5 无关，但仍在 STATUS §5 风险 1 里。
- **CI 状态未复核**：本机访问 `api.github.com` 与 Actions 页面均超时（github.com 同一时段也抖动），
  2.0.4 与 2.0.5 推送后的 Actions run 结论都还没确认；能确认的是推送成功
  （`08db11d..afa7222`）与 Cloudflare 自动构建切流（`0cccf9e8…`）。