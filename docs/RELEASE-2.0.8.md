# Guandao OS 2.0.8 · Trust Gate

- 版本：2.0.8
- 代号：Trust Gate
- 日期：2026-11-22
- 类型：补丁版（上一版 2.0.7 Review Integrity）
- 状态：**Verified（本地 + 生产）**，已部署 Version `9be8e25b-eab0-43e6-bb0d-a0d8e3ca5d4d`

## 1. 这一版修了什么

2.0.7 的 §6 留了一批「可修但没有修」的缺陷。本版按任务书的两条硬约束筛选：

- 不改公开 API 契约（没有新增/删除响应字段、状态码、事件名）；
- 不加数据库迁移。

因此，**需要新增列或预占行的两条暂不进本版**（见 §6）：

- 社区作品浏览/下载计数的幂等（需要计数表或唯一键）；
- 社区图片上传的配额预占（需要 pending 行，等同迁移）。

本版修的是不需要改 schema 的 6 条，全部来自第二轮只读审计
（`audit-worker-c`、`audit-os20-d`）。

## 2. 逐条改动

### 2.1 插件更新/回退也要过签名信任闸门（P1）

**缺陷**：`worker/api/plugins/handlers.js` 的安装路径会检查签名与密钥状态，
但 `updateInstallation` 与 `rollbackInstallation` 只校验 `packageHash`。
后果是：开发者撤销密钥、或版本签名变成 `invalid` 之后，
仍然可以把旧包装回来；`rollback` 还允许 `approved`/`superseded`，
连被 `blocked` 安全下架的插件都能回退。

**修复**：抽出唯一的信任检查函数，三条路径共用。

```js
export async function assertVersionTrusted(env, version, pluginRow) {
  if (!version) throw new ApiError("VERSION_NOT_AVAILABLE", "该安装记录没有可用的版本包", 409);
  if (version.signature_status === "invalid") {
    throw new ApiError("SIGNATURE_INVALID", "该版本签名无效，不能安装", 409, { signatureCode: "SIG_INVALID" });
  }
  if (version.signature_key_id) {
    const key = await getKeyRow(env, version.signature_key_id);
    // 必须同时属于该插件作者，防止借用别人的公钥
    if (!key || key.user_id !== pluginRow?.developer_id) {
      throw new ApiError("SIGNATURE_KEY_UNKNOWN", "签名公钥不存在或不属于该开发者", 409, { signatureCode: "SIG_KEY_UNKNOWN" });
    }
    if (key.status !== "active") {
      throw new ApiError("SIGNATURE_KEY_REVOKED", "签名公钥已撤销，不能安装该版本", 409, { signatureCode: "SIG_KEY_REVOKED" });
    }
  }
  return version;
}
```

- install：把原来的内联检查换成 `await assertVersionTrusted(env, version, row);`
- update：`packageHash` 校验之后加同一调用；
- rollback：先取插件行，`blocked` → 409「该插件已被安全下架，不能回退」，
  非 published → 409「插件当前不可回退」，hash 校验后同样过信任闸门。

**为什么安全**：签名缺失的 1.x 旧版本（没有 `signature_key_id`）保持放行，
与 2.0.6 的安装行为一致；只是把「密钥被撤销/签名无效」这条真实风险补齐。

### 2.2 通知音量 0 不再回落成 45（P2）

**缺陷**：`src/lib/os20/apply.ts` 用 `Number(v) || 45` 归一化音量。
`0` 是用户选的「静音」，但 `||` 把它当成缺省值，于是设置显示 0、实际响 45，
并且后续不再出现差异，用户无法察觉。

**修复**：新增 `src/lib/os20/notify-volume.ts`：

```ts
export const DEFAULT_NOTIFICATION_VOLUME = 45;

export function normalizeNotificationVolume(value: unknown, fallback = DEFAULT_NOTIFICATION_VOLUME): number {
  // 只有真正缺失才回落；数字 0 与字符串 "0" 都是合法的静音值
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(100, Math.max(0, Math.round(parsed)));
}
```

`apply.ts` 改为 `normalizeNotificationVolume(values["notifications.volume"])`。

### 2.3 引导收尾只写用户点过的选项（P2）

**缺陷**：`commitChoices` 无条件 `applyLook({ dock: { pos, autohide: false } })`。
用户开着「程序坞自动隐藏」，跳过引导就被关掉；因为 settings.v1 里仍是 true，
下一次设置变更又把它抖回来。另一个问题是：只有跳过引导也会写 `system.mode`，
可能把已登录的 Cloud 模式切回本地。

**修复**：新增 `src/lib/os20/apps/onboarding-patch.ts`：

```ts
export function buildOnboardingPatch(choices, { dockTouched, modeTouched }) {
  const patch = {
    "desktop.iconLabels": choices.iconLabels,
    "desktop.clockSeconds": choices.clockSeconds,
  };
  if (dockTouched) patch["desktop.dock.position"] = choices.dock;
  if (modeTouched) patch["system.mode"] = choices.mode;
  return patch;
}
```

`onboarding.ts` 记录 `dockTouched`（点 `[data-dock]` 才置 true），
只在 touched 时调用 `applyLook({ dock: { pos } })`，**不再传 autohide**。

### 2.4 引导的 Esc 与重复收尾（P3）

**缺陷**：Esc 监听不过滤输入框，设备命名框里按 Esc 会直接跳过引导、名字丢失；
`finish` 没有 in-flight 守卫，连点会重复 `applyWorkspace` 与 `onboarding:done`。

**修复**：

```ts
if (event.key !== "Escape") return;
if (isTypingTarget(event.target)) return;
void finish(true);
```

`finish` 内加 `let finishing = false; if (finishing) return;`。
`isTypingTarget` 用 `closest("input, textarea, select, [contenteditable='true']")`。

### 2.5 更新检查失败后清空陈旧 server（P3）

**缺陷**：`check()` 失败只改 `phase`/`error`，不清理 `state.server`。
于是断网后页面仍显示上一轮的「有新版」，按钮也按旧 `comparison() === 1` 可点，
点下去只是重新加载旧资源。

**修复**：新增 `src/lib/os20/apps/update-state.ts`：

```ts
export function canApplyUpdate(phase, server, comparison): boolean {
  if (phase !== "ready") return false;
  if (!server) return false;
  return comparison === 1;
}
```

- 按钮：`data-apply ${canApplyUpdate(state.phase, server, comparison()) ? "" : "disabled"}`
- 失败（接口异常）与 catch（离线/网络失败）两个分支都 `state.server = null;`

### 2.6 市场搜索过滤后重绘详情栏（P3）

**缺陷**：搜索框输入后只重绘左侧列表，`refreshData()` 虽然清了 `state.selected`，
右侧详情仍画旧作品，安装按钮按空 id 静默失败。

**修复**：抽出 `resolveSelection(selected, visibleKeys)`（新模块
`src/lib/os20/apps/market-selection.ts`），`refreshData` 用它决定是否清空；
搜索事件里在重绘列表的同时重绘 `.os20-mk-detail`（`detail(item)` 或 `emptyDetail()`）。

## 3. 测试与证据

### 3.1 单元测试（新增 5 个文件 30 条）

| 文件 | 条数 | 覆盖 |
| --- | --- | --- |
| `tests/unit/plugin-version-trust.test.ts` | 8 | invalid / 密钥缺失 / 别人的密钥 / 已撤销 / active 放行 / 无签名放行 / 版本缺失 / 三条路径源码约束 |
| `tests/unit/notify-volume.test.ts` | 4 | 0 与 "0" 合法、缺失/NaN/Infinity 回落、布尔与 null、钳制与取整 |
| `tests/unit/onboarding-patch.test.ts` | 7 | 四组 touched 组合、Esc 输入态、in-flight 守卫与「不再传 autohide」源码约束 |
| `tests/unit/update-state.test.ts` | 5 | phase × server × comparison 判定矩阵、失败/离线清空 server 的源码约束 |
| `tests/unit/market-selection.test.ts` | 6 | 选中项保留/清空、详情栏重绘、emptyDetail 唯一来源 |

`npx vitest run` 这五个文件 → **30 passed**；`npx tsc --noEmit` exit 0。

### 3.2 负向对照（真改回旧行为）

`.tmp-neg-208.mjs`（无参数直接 `REFUSED` exit 2；`patch` 前备份；`restore` 用备份覆盖并打印 SHA-256）：

- `patch` 后：`update-state` 2 条失败，`market-selection` 2 条失败（共 4 failed）；
- `restore` 输出两行 `MATCH`、`RESTORE_OK`，复跑 **11 passed**。

插件信任闸门的负向对照在开发中已单独做过（`.tmp-neg-trust.mjs`）：
删掉 update 路径的调用后 1 failed（源码断言 3 → 2），恢复后 8 passed。

### 3.3 门禁

- `npm run verify` **exit 0**：`[version] 一致：2.0.8`；typecheck 0 error；
  **45 文件 / 490 单测**（1.78s）；html-security **295 处 / 未审查 0**；build **30 页**；
  `[csp] 12 个哈希与 31 个 HTML 一致`。
- 真实 Worker E2E（新增 `tests/e2e/market-search-detail.spec.ts`）：
  `npx playwright test --project=worker tests/e2e/market-search-detail.spec.ts` → **1 passed（14.4s）**。
  链路：打开桌面 → 跳过引导 → 打开市场 → 点第一张卡片（详情出现标题）→
  输入不匹配的关键词 → 列表空态「没有匹配的资源」+ 详情栏 `is-empty` + 不再有旧标题。
  **负向对照**：删掉详情栏重绘块并 `npx astro build`（worker project 服务的是 dist）后，
  同一用例 **1 failed**（`toHaveClass(/is-empty/)`）；`restore` 打印 `MATCH` + `RESTORE_OK` 后复跑通过。
  首次失败的两个原因已记：① 只等 `#boot` 消失会抢跑（要等 `GOS20_READY`）；②
  `GOS14.ctx.openApp()` 在桌面未挂完时返回假值，判定应看窗口是否出现而不是返回值。
- 全量 E2E：`$env:E2E_ADMIN_PORT='18789'; npx playwright test --reporter=line` → **199 passed（5.3m）**，exit 0（2.0.7 的 198 条 + 本版新增的市场详情 1 条）。
- 体积：本版只改 Worker 与前端局部逻辑，入口体积应与 2.0.7 持平（见 STATUS §2）

## 4. 兼容性

- 公开 API：无变更。`update` / `rollback` 新增的 409 只发生在
  「签名无效 / 密钥被撤销 / 密钥不属于作者 / 插件被 blocked」这几种特殊情况，
  错误码沿用 `ApiError` 既有格式，`details.signatureCode` 是新增可选字段。
- 数据：无迁移，所有修复都只读现有列。
- UI 行为：市场详情栏在搜索时立即收起；更新按钮在失败态不可点。
  如果旧行为被某个自动化脚本依赖（例如只重绘列表），需要同步。

## 5. 部署记录

2026-11-22 16:06 上线：

| 步骤 | 结果 |
| --- | --- |
| `git fetch` | `origin/main…HEAD = 0 1`（本地领先 1，无落后） |
| `npx wrangler d1 migrations list guandao-db --remote` | `✅ No migrations to apply!` |
| D1 备份 | `.backups/guandao-db-prod-20261122-1615.sql`，**648,923 B** |
| `npm run cf:deploy` | exit 0；30 页；32 个静态资源；`Total Upload: 743.22 KiB / gzip: 163.57 KiB`；Worker Startup **4 ms**；**Version `9be8e25b-eab0-43e6-bb0d-a0d8e3ca5d4d`** |
| 生产核对 | `/api/health` → `"version":"2.0.8"`、D1 connected、R2 available；响应头 `x-guandao-version: 2.0.8`；首页 200（27,812 B）；入口 `index.astro_astro_type_script_index_0_lang.CZAyZYvn.js`（450,998 B，含 2.0.8） |
| `npm run qa:prod` | **35/35 通过**；清理 `{"users":0}`（既有 `event_type` CHECK 警告仍存在，脚本 exit 0） |

回滚目标：2.0.7 的 Version `a7728641-876d-4351-8b4a-fcacc816ced1`。

推送 `fe51b05..58b1103` 后：GitHub Actions quality run **45001712326 success**（attempt 1）；
Cloudflare 自动构建新 Version `ab595f66-c58a-4075-9c44-eed86a14ff75`（08:13:16Z，100%），`/api/health` 仍 2.0.8。
每次 push 都会触发一次自动构建，最终版本以 `wrangler deployments list` 末尾为准。

## 6. 未修与「需要迁移」清单

本版刻意没动的（都已复核，列进 BACKLOG）：

| 条目 | 为什么不在本版 |
| --- | --- |
| 社区作品浏览/下载计数幂等 | 需要计数表或唯一键，属迁移 |
| 社区图片上传配额预占 | 需要 pending 行，等同迁移 |
| 文件 `pending_delete` 无回收路径 | 需要清理作业与状态机，单独排期 |
| 插件 `/api/plugins/net` 整包读入 | 需要改成流式截断，改动面较大 |
| 插件安装上限 check-then-insert | 需要条件插入或唯一键（偏迁移） |
| 文件 Range 不可满足返回 200、HEAD 未路由 | 属协议兼容细节，需要真实客户端回归 |
| 窗口双重关闭、布局 cascade 重叠、bridge subtree | 需要窗口层集成测试，风险高于收益 |
| sync `since` 游标缺 tiebreak | 官方前端不走该游标，影响外部客户端 |