# Guandao OS 2.0.7 · Review Integrity

- **版本**：2.0.7
- **代号**：Review Integrity（审核完整性）
- **日期**：2026-11-22
- **类型**：补丁版本
- **上游**：2.0.6 Shell Proof
- **状态**：**Verified（本地）**；生产仍 2.0.6，本版未部署（等授权）

---

## 1. 为什么有这一版

2.0.6 的 §6 列了 8 条「已定位、但本轮没修」的边界。继续往下修时，我把其中
**不需要数据库迁移、也不改变公开响应字段**的四条挑出来，凑成 2.0.7：

| # | 问题 | 触发者 | 后果 |
| --- | --- | --- | --- |
| 1 | 审核「通过」接受 `draft` | 审核员 | 作者撤回的草稿被审核员替他重新公开 |
| 2 | 审核卡「通过」按钮对 `draft`/`hidden` 一律渲染 | 审核员 | UI 暗示可以越过作者意志与恢复语义 |
| 3 | 作者删除作品不结算举报 | 作者 | `open` 举报永久挂着；后续 `hide_post` 还绕过删除检查，把软删作品改回 `hidden` |
| 4 | 账号注销的重验票据先消费后检查 | 有活跃导出/备份的用户 | 被 409 挡住后票据已作废，要重走 GitHub OAuth |

这四条都在 Worker 的社区/隐私接口和审核 UI 内，接口形状不变，所以是补丁版本。

## 2. 改动

### 2.1 审核状态策略成为唯一真相（`worker/api/community/review-policy.js`，新增）

```js
export const APPROVE_STATUSES = ["pending_review", "rejected"];
export const RESTORE_STATUSES = ["hidden"];

export function checkReviewTransition(action, status) {
  if (status === "deleted") return { ok: false, message: "作品已删除" };
  if (action === "approve") {
    if (status === "draft") {
      return { ok: false, message: "作者已撤回为草稿，需要作者重新提交审核" };
    }
    return APPROVE_STATUSES.includes(status)
      ? { ok: true }
      : { ok: false, message: "当前状态不能通过审核" };
  }
  if (action === "restore") {
    if (status === "draft") {
      return { ok: false, message: "作者已撤回为草稿，需要作者重新提交审核" };
    }
    return RESTORE_STATUSES.includes(status)
      ? { ok: true }
      : { ok: false, message: "只有已隐藏的作品可以恢复" };
  }
  return { ok: true };
}
```

`draft` 是**作者的意志**：审核员可以拒绝、可以恢复已隐藏，但不能替作者发布。
`restore` 与 `approve` 分开之后，审计日志里的动作名也和用户看到的按钮一致。

`worker/api/community/admin.js` 的 `adminReviewPost` 原来只排除 `published`：

```js
if (!["pending_review", "hidden", "rejected", "draft"].includes(raw.status) && action !== "restore") {
  bad("当前状态不能通过审核");
}
```

现在改成 `const transition = checkReviewTransition(action, raw.status); if (!transition.ok) bad(transition.message);`。

### 2.2 软删作品不能「半复活」

`adminReviewReport` 的 `hide_post | delete_post` 分支在查到作品后补一道检查：

```js
if (post.status === "deleted") throw new ApiError("NOT_FOUND", "作品已删除", 404);
```

原因：审核动作 `hide_post` 会把 `community_posts.status` 直接改成 `hidden`，
对软删行执行就会把「已删除」变回「已隐藏」，列表里重新出现。

### 2.3 作者删除时结算举报

`worker/api/community/write.js` 的 `deletePost` 原本 batch 三条（post → deleted、
package → deleted、asset → deleting）。现在补第四条：

```sql
UPDATE community_reports
   SET status = 'resolved', resolution = ?, reviewer_id = ?, reviewed_at = ?
 WHERE target_type = 'post' AND target_id = ?
   AND status IN ('open', 'reviewing')
```

`resolution` 写「作品已被删除」。作者自己删掉作品后，管理员队列里不应再留着
一条永远处理不了的举报。

### 2.4 重验票据只在真正开始删除时消费

`worker/api/privacy/handlers.js` 里 `consumeReauthTicket` 原先在
`activeDeletion(409) / activeExport(409) / activeBackup(409)` 三条前置检查**之前**执行。
票据是一次性的，检查失败就等于白白作废。现在移到 `if (activeBackup) throw ...` 之后、
`markUserPendingDeletion` 之前，并在注释里写明顺序原因。

### 2.5 审核卡按钮与策略对齐

`src/lib/os14/community/moderation.ts`：

- `hidden` → `data-action="review-restore"`，文案「恢复」；
- `["pending_review","rejected"]` → `data-action="review-approve"`，文案「通过」；
- `draft` 不渲染动作按钮。

`src/lib/os14/community.ts` 新增 `case "review-restore"` → `reviewModeration(id, "restore")`。

### 2.6 版本号 9 处

`package.json`、`package-lock.json` 第 3/9 行（第 5097 行的 `2.0.6` 是 `fast-levenshtein` 依赖版本，未动）、
`src/lib/version.ts` 的 `OS_VERSION` 与 RELEASES 首条、`worker/api/version.js`、
`public/sw.js`（`guandao-2.0.7`）、`shared/plugin-spec.js`、`worker/api/community/validate.js`、
`cli/guandao.mjs`、`src/lib/core/registry.ts`；断言族同步 `tests/e2e/os20.spec.ts`（4 处）、
`scripts/community-qa.mjs:338`、`scripts/plugins-qa.mjs:196`、`.github/workflows/quality.yml:146/158`。

## 3. 证据

### 3.1 单测

| 文件 | 用例 | 通过 |
| --- | --- | --- |
| `tests/unit/community-review-policy.test.ts` | 8 | 8 passed |
| `tests/unit/community-delete-reports.test.ts` | 3 | 3 passed |
| 全量 `npx vitest run` | 460 | **40 files / 460 passed（1.48s）** |

`community-review-policy.test.ts` 里除了 6×2 状态矩阵，还有一条**真的调用**
`adminReviewPost` 的行为用例：假 D1 对 `SELECT * FROM community_posts WHERE id = ?`
返回 `status: "draft"` 的 UUID 行，审核员 `approve` → 400 且 message 含「作者已撤回」。
（第一次跑成 404，因为我最初用的是 `post-draft` 这种非 UUID id，接口在 `UUID.test` 处就返回了。）

`community-delete-reports.test.ts` 用假 D1 收集 `batch` 语句，断言作者删除时
确实带着 `UPDATE community_reports` 与 `status IN ('open', 'reviewing')`；
同文件还用源码顺序断言锁住 privacy 的「先检查、后消费」。

### 3.2 负向对照

| 还原的文件 | 结果 |
| --- | --- |
| `worker/api/community/write.js`（去掉举报结算） | delete-reports **1 failed** |
| `src/lib/os14/community/moderation.ts`（旧宽口径按钮） | review-policy **1 failed** |
| `worker/api/community/admin.js`（旧状态判断） | 行为用例 **1 failed**，旧文案「作品还没有可安装的内容包」 |

三次都用 `git stash push/pop` 还原，没有留下中间态。

### 3.3 门禁

- `node scripts/check-version.mjs` → `[version] 一致：2.0.7`。
- `npx tsc --noEmit` → exit 0。
- `npm run verify` / 全量 E2E 见 §3.4。

### 3.4 门禁与全量 E2E

- 全量 E2E 第一次跑 **197 passed / 1 failed（8.8m）**，失败的是 `community-admin-review.spec.ts`
  的「已隐藏队列恢复」：它还在点 `[data-action="review-approve"]`，而 2.0.7 把「已隐藏」的按钮
  改成了 `[data-action="review-restore"]`（文案「恢复」）、弹窗按钮 `[data-mv="restore"]`。
  这不是产品回归，是 **UI 契约变更**；既有断言没有删，改为按新契约点击。
- 改完后单跑该 spec：**4 passed（26.2s）**。
- 全量复跑：**198 passed（4.7m），exit 0**（workers=1、retries=0；与 2.0.6 基线持平，
  说明本版只改了审核分支与本地模型，没有动其他链路）。

门禁汇总：`npm run verify` **exit 0**（`[version] 一致：2.0.7`、typecheck 0 error、
40 文件 / 460 单测、html-security 294 处 / 未审查 0、build 30 页、CSP 12 哈希 / 31 HTML 一致）；
体积不变（入口 434.8 / 439.5 KB、首屏 CSS 184.7 / 195.3 KB）。

## 4. 兼容性

- 公开接口无字段增删；`PATCH /api/admin/users/:id/restriction` 的权限判定更严，
  非管理员调用会比以前更容易得到 403 —— 这是修复本身。
- 审核接口新增的状态拒绝返回既有 `INVALID_INPUT`（400），不是新错误码。
- 已删作品的 `hide_post/delete_post` 从「改回 hidden」变为 404，行为变更只影响管理员脚本。
- **审核卡「已隐藏」的动作从 `review-approve` 改为 `review-restore`**（弹窗值 `approve → restore`）。
  这是 UI 契约变更：2.0.7 起既有 E2E 必须按新值点击；外部脚本若硬编码了旧 `data-action`，需要同步。
- 无数据库迁移。

## 5. 部署

**未部署。** 生产仍 2.0.6（Version `835cb688-5ea2-4572-8d48-05d19947f03d`，
自动构建 `017daf47-5eed-4215-becf-608b7d7eba80`）。部署步骤与 2.0.6 相同：

1. `git fetch` 确认 `origin/main` 无新提交；
2. `npx wrangler d1 migrations list guandao-db --remote`（本版无迁移，应输出 `No migrations to apply!`）；
3. `npx wrangler d1 export guandao-db --remote --output .backups/guandao-db-prod-<时间>.sql`；
4. `npm run cf:deploy`；
5. 核对 `/api/health` 与 `x-guandao-version: 2.0.7`、首页与入口 bundle；
6. `npm run qa:prod`；
7. push 后复核 CI 与 Cloudflare 自动构建。

回滚目标：2.0.6 的 Version `835cb688-5ea2-4572-8d48-05d19947f03d`。

## 6. 仍未修

| 项 | 为什么不在本版 |
| --- | --- |
| `POST /posts/:id/view` 与 `GET /posts/:id/package?count=1` 可重放刷计数 | 要先去重（去重表或指纹列），是数据库迁移 + 公开计数语义决定 |
| 社区图片上传配额先查后写（TOCTOU） | 要像 `/files` 那样加 pending 预占行，属迁移 |
| 审核队列的生产侧写入链路 | `qa:prod` 只覆盖公开/只读链路，生产写入型发布链还没跑 |
| 真机 Safari/Firefox | 本机没有设备，E2E 只覆盖 Chrome 内核 |