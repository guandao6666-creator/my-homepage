# Guandao OS 2.0.10 · Cleanup

| 项 | 值 |
|---|---|
| 版本 | `2.0.10` |
| 代号 | `Cleanup` |
| 日期 | 2026-11-22 |
| 类型 | 补丁版（上游 `2.0.9` Range Proof） |
| 生产状态 | **已部署生产（2026-11-22）**，Version `b207dbcb-09d9-4f30-943e-37a281d4de56`；health/header 2.0.10、`qa:prod` 35/35 |

## 1. 这一版修了什么

接 2.0.9 之后，继续按「不需要数据库迁移、不改公开响应字段」的口径收边界缺陷。本轮两条：

1. **删除失败的文件行永远不会被清掉**：R2 删除失败时 `permanentDeleteHandler` / `permanentFolderHandler` 把行标成 `status='pending_delete'` 再抛 502，但全仓没有任何读取或重试该状态的分支；`usage()` 只统计 `ready/trash/pending`、回收站只查 `trash` → 行与 R2 对象永久泄漏，用户也看不见、清不掉。
2. **系统设置的数值滑杆用键盘调整后不落盘**：只有 `pointerup` 写 `kernel.settings.set`；用方向键 / Home / End 调整只触发 `input`+`change`，旁边的数字变了，设置却没保存，关窗重开立刻回到旧值。

## 2. 改动

### 2.1 `pending_delete` 回收（`worker/api/files/handlers.js`）

新增：

```js
export async function retryPendingDeletes(env, userId, limit = 20) {
  const rows = await env.DB.prepare(
    "SELECT id, r2_key FROM files WHERE user_id = ? AND status = 'pending_delete' ORDER BY updated_at ASC LIMIT ?",
  ).bind(userId, limit).all();
  const items = (rows.results || []).filter((row) => row?.id);
  if (!items.length) return 0;

  const keys = items.map((row) => row.r2_key).filter(Boolean);
  try {
    if (keys.length) await env.FILES.delete(keys);
  } catch (error) {
    console.error("[files] pending_delete retry failed:", error?.message ?? error);
    return 0;
  }

  let removed = 0;
  for (const chunk of chunkIds(items.map((row) => row.id))) {
    await env.DB.prepare(
      `DELETE FROM files WHERE user_id = ? AND status = 'pending_delete' AND id IN (${placeholdersFor(chunk)})`,
    ).bind(userId, ...chunk).run();
    removed += chunk.length;
  }
  return removed;
}
```

`listHandler` 开头接上（失败不阻塞列表）：

```js
await retryPendingDeletes(env, userId).catch(() => undefined);
```

为什么放在列表：这是用户唯一会自然经过的入口，不需要新增 API、不需要后台任务；每次最多试 20 行，R2 恢复后用户下一次打开云盘就自动收敛。删除语句带着 `status = 'pending_delete'`，即使 id 被复用也不会误删正常文件。

### 2.2 数值滑杆键盘提交（`src/lib/os20/apps/systemcenter.ts`）

```ts
const commitNumberSetting = (range: HTMLInputElement) => {
  const id = range.dataset.setNumber ?? "";
  if (!id) return;
  const next = Number(range.value);
  if (kernel.settings.get(id) === next) return;
  kernel.settings.set(id, next);
  apply();
};
```

- `change` 监听新增 `[data-set-number]` 分支调用它（早于原来的 select 分支，并 `return`）；
- `pointerup` 改为调用同一个函数；
- 按值去重：指针拖动结束时 `pointerup` 与 `change` 都会触发，只会写一次设置。

## 3. 证据

| 证据 | 结果 |
|---|---|
| `npx vitest run tests/unit/files-pending-delete.test.ts` | **4 passed**（成功删行/删 key、R2 失败保留、空行不碰 R2、列表接线源码断言） |
| 负向对照（删掉列表入口重试调用） | `1 failed | 3 passed`；`node .tmp-neg-210b.mjs restore` 输出 `handlers: MATCH` + `RESTORE_OK`，复跑 4 passed |
| `npx playwright test --project=worker tests/e2e/systemcenter-number-keyboard.spec.ts` | **1 passed（16.0s）**，真实 Worker + 真实浏览器：方向键调音量 → 关窗 → 重开仍保留 |
| 负向对照（改回只有 pointerup 落盘） | **1 failed**：`toHaveValue` 期望 `"40"` 实际 `"45"`；`node .tmp-neg-210.mjs restore` 输出 `systemcenter: MATCH` + `RESTORE_OK`，重建后复跑 1 passed |
| `npm run verify` | **exit 0**：`[version] 一致：2.0.10`；typecheck 0 error；**50 文件 / 511 单测**（1.60s）；html-security **295 处 / 未审查 0**；build 30 页；CSP 12 哈希 / 31 HTML |
| 全量 E2E | `npx playwright test`（`E2E_ADMIN_PORT=18789`）→ **203 passed（4.7m）**，exit 0（2.0.9 的 202 + 本版 1 条）。首跑 1 failed 是清 `rate_limits` 定时器与 D1 抢锁导致配对确认 500；单跑 `device.spec.ts` 12 passed，改 90 秒清理后全量通过 |
| 体积 | 入口 JS **440.5 / 439.5 KB（100.2%）**、首屏 CSS **184.7 / 195.3 KB（94.6%）**，与 2.0.9 持平（本轮只改 Worker 与设置面板逻辑，未新增依赖） |

> 负向对照脚本的默认动作都是「拒绝执行」（无参数 exit 2），patch/restore 之前备份并打印 SHA-256 校验。

## 4. 兼容性

- 无公开 API 变化：`GET /api/files` 的响应字段一个没动，只多了一次最多 20 行的内部重试。
- 列表请求的理论延迟上限增加一次 R2 批量 delete + 一次 D1 delete；`pending_delete` 通常为空，正常路径只多一条 SELECT。
- 不涉及数据库迁移；`status` 列的既有 CHECK 约束不变。

## 5. 部署记录（2026-11-22）

| 步骤 | 结果 |
| --- | --- |
| 部署前检查 | `git fetch` 后 `origin/main...HEAD = 0 1`（无落后）；`npx wrangler d1 migrations list guandao-db --remote` → `✅ No migrations to apply!` |
| D1 备份 | `C:\Users\1\Desktop\my-homepage\.backups\guandao-db-prod-20261122-2029.sql`（**658,291 B**） |
| 部署 | `npm run cf:deploy` exit 0 → 30 页、`Uploaded 32 of 32 assets`、`Total Upload: 746.85 KiB / gzip: 164.54 KiB`、Worker Startup 4 ms、**Current Version ID `b207dbcb-09d9-4f30-943e-37a281d4de56`**；绑定 BACKUP_WORKFLOW/DB/FILES/DB_BACKUPS/ASSETS 正常 |
| 生产核对 | `/api/health` → `"version":"2.0.10"`、D1 connected、R2 available（put/get/head/delete 全 true）；header `x-guandao-version: 2.0.10`；首页 200（27,812 B）；入口 `index.astro_astro_type_script_index_0_lang.CnPgsDvL.js`（452,121 B，含 5 处 `2.0.10`）；`/sw.js` → `guandao-2.0.10` |
| 生产 E2E | `npm run qa:prod` → **35/35 通过**，清理后 `{"users":0}`（既有 `event_type` CHECK 约束警告仍在 stderr，脚本 exit 0） |
| 回滚 | 2.0.9 生产 Version `a034902b-562b-4122-85bf-e238cbbe23d6` |
| 推送复核 | push `f335c9b..eb0825a` 后 quality run **45023083005 success**；Cloudflare 自动构建 **`423253b9-1166-44a0-83b7-9bc3f1ceabe6`**（12:36:35Z，100%），`/api/health` 仍 2.0.10 |

## 6. 仍未修 / 边界

- 备份 merge 恢复仍会在按哈希跳过之前写 R2：孤儿对象问题（本轮未改，需拆分复制与去重顺序）。
- 插件安装上限 `MAX_INSTALLED = 40` 仍是 check-then-insert（并发可超装）。
- 窗口关闭双通道、布局恢复 cascade 重叠、sync `since` 缺 tiebreak：未修。
- 需迁移项（不属于补丁版）：`POST /posts/:id/view` 与 `GET /posts/:id/package?count=1` 计数幂等、社区上传配额预占。
- `pending_delete` 的回收只在用户访问云盘列表时发生；如果用户长期不打开云盘，孤儿对象仍在（已比永久泄漏好，但还不是后台任务）。