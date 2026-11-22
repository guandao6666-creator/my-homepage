# Guandao OS 2.0.9 · Range Proof

| 项目 | 值 |
| --- | --- |
| 版本 | 2.0.9 |
| 名称 | Range Proof |
| 日期 | 2026-11-22 |
| 类型 | 补丁版（无数据库迁移、无公开响应字段变化） |
| 上游 | 2.0.8 Trust Gate |
| 状态 | 本地完成，**未部署（Blocked：等待上线授权）** |

## 1. 为什么有这个版本

2.0.8 的 §6 与 `docs/AI-BUILD-STATUS.md` §5 留了几条「不需要迁移、但会真实伤到用户」的缺陷。本轮从中挑出五条，都是能被自动化判别的行为缺陷：

| # | 缺陷 | 触发 | 后果 |
| --- | --- | --- | --- |
| F1 | 文件 Range 越界不返回 416 | 客户端断点续传请求 `Range: bytes=<超过文件长度>-` | R2 把越界区间当整包读，回 206/整包：下载器可能重复写入或死循环 |
| F2 | 文件 content/download 不支持 HEAD | 客户端探测大小/类型 | 405 或空响应，探测逻辑只能退回 GET 整包 |
| F3 | 插件 `/api/plugins/net` 整包读入再截断 | 插件代理一个超大响应 | worker 先把整个 body 读进 isolate 内存，再截 256 KiB：大响应直接打爆内存 |
| F4 | 作者能重新发布被下架的 hidden 作品 | 作者对 hidden 作品点「提交审核」或重发 | 作品回到 published，同时 `moderation_note` 被清空：审核记录被抹掉 |
| F5 | 隐藏评论只结算一条举报 | 同一评论被多人举报，管理员点「隐藏评论」 | 其余 open 举报永久悬挂，审核队列永远清不干净 |
| F6 | 重开设置/市场时侧栏高亮错位 | 切到「系统」/「社区」→ 关窗 → 重开 | 内容停在原分类，高亮却回到默认分类 |

F1/F2 是协议层，F3 是隔离层内存边界，F4/F5 是审核链的一致性，F6 是反复出现的窗口状态问题。

## 2. 逐条改动

### 2.1 F1：Range 自己解析，越界直接 416（`worker/api/files/handlers.js`）

原来把 `Range` 头原样透传给 R2：

```js
const object = await env.FILES.get(file.r2_key, { range: request.headers });
```

R2 对「起点 >= 文件长度」的区间不报错，而是返回整包 206。现在先在 worker 里解析单区间：

```js
export function parseByteRange(header, total) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header || "").trim());
  if (!match || total <= 0) return null;
  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") return null;
  const end = rawEnd === "" ? total - 1 : Number(rawEnd);
  if (!Number.isFinite(end)) return null;
  const start = rawStart === "" ? total - Number(rawEnd) : Number(rawStart);
  if (!Number.isFinite(start)) return null;
  if (start >= total) return { unsatisfiable: true };
  ...
}
```

`contentHandler` 在越界时**不读 R2**，直接返回 RFC 7233 规定的不可满足响应：

```js
if (planned?.unsatisfiable) {
  return new Response(null, {
    status: 416,
    headers: { "content-range": `bytes */${total}`, "content-length": "0" },
  });
}
```

多区间、畸形、空区间返回 `null`：按 RFC 允许忽略 Range、退回 200，而不是猜。

### 2.2 F2：HEAD 与 GET 共用元数据，body 为空

路由补上 HEAD（`handlers.js:195-200`）：

```js
if (action === "content" && (method === "GET" || method === "HEAD")) {
  return contentHandler(env, request, file, false, method === "HEAD");
}
if (action === "download" && (method === "GET" || method === "HEAD")) {
  return contentHandler(env, request, file, true, method === "HEAD");
}
```

`contentHandler` 的签名加 `headOnly`，最后一行：

```js
return new Response(headOnly ? null : object.body, { status, headers });
```

HEAD 不传 body，避免运行时尝试发送一个流；状态码与 `content-range`/`accept-ranges` 仍按 GET 计算。

> 注意：workerd 对流式 body 会走 `Transfer-Encoding: chunked`（还可能 gzip），并丢掉我们设置的 `content-length`。这是运行时行为，不是 bug；测试里不要断言 `content-length`，断言 `content-range`、`accept-ranges` 与实际 body 长度即可。

### 2.3 F3：插件网络代理边读边截断（`worker/api/plugins/handlers.js:1375`）

原来：

```js
const buffer = await response.arrayBuffer();
const truncated = buffer.byteLength > 256 * 1024;
const bytes = new Uint8Array(buffer.slice(0, 256 * 1024));
```

改为流式读取，到上限立即停并取消上游：

```js
export async function readLimitedBody(response, limit = 256 * 1024) {
  const reader = response.body?.getReader();
  if (!reader) return { bytes: new Uint8Array(), truncated: false };
  const chunks = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    const take = Math.min(value.byteLength, limit - size);
    if (take > 0) { chunks.push(value.subarray(0, take)); size += take; }
    if (take < value.byteLength || size >= limit) {
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
  }
  ...
}
```

调用点（`handlers.js:1346`）改为 `const { bytes, truncated } = await readLimitedBody(response, 256 * 1024);`。`truncated` 语义不变，公开响应字段不变。

### 2.4 F4：hidden 作品不能被作者重新发布（`worker/api/community/write.js:828`）

新守卫：

```js
export function assertAuthorPublishAllowed(status) {
  if (status === "hidden") {
    throw new ApiError("POST_HIDDEN", "作品已被版主下架，不能自行重新发布；如有异议请联系审核", 409);
  }
}
```

`publishPost` 在 `published` 提前返回之后、读取清单之前调用它（`write.js:839`）。这样 hidden 作品只能由审核员「恢复」，作者重发不会把 `moderation_note` 清空。

### 2.5 F5：评论举报按目标批量结算（`worker/api/community/admin.js:344`）

hide_comment 分支从「更新评论 + 单独结算当前举报行」合并成一个 batch，结算条件改成按目标：

```sql
UPDATE community_reports
   SET status = 'resolved', resolution = ?, reviewer_id = ?, reviewed_at = ?
 WHERE target_type = 'comment' AND target_id = ? AND status IN ('open', 'reviewing')
```

参数：`resolution || "评论已隐藏"`、`viewer.id`、`now`、`comment.id`。同一评论的所有 open/reviewing 举报一起关闭，和 `hide_post` 的既有做法对齐。

### 2.6 F6：重开窗口时侧栏高亮跟随当前分类

`src/lib/os20/apps/systemcenter.ts:1000`：

```js
shell("systemcenter", TABS.map(...), `<div data-sc-host></div>`, "系统设置", tab)
```

`bindTabs(win, cb, tab)`（`:1290`）也传 `tab`；`market.ts:481` 同样把 `state.kind` 传给 `shell` 与 `bindTabs`。模块级状态本来跨窗口保留，之前只是没告诉 shell「当前在哪一页」，于是高亮回到默认分类。

### 2.7 工程侧：wrangler 升级到 4.166.0

本机 wrangler 4.157 的 workerd 启动时报：

```
kj/filesystem-disk-win32.c++:773: failed: CreateDirectory: #5 拒绝访问。
path = miniflare-email-store
```

`wrangler d1 execute --local`、`d1 migrations apply --local`、`wrangler dev --local` 全部失败，e2e-server 连迁移都过不去，全量 E2E 因此被环境卡死。升级 devDependency `wrangler` 到 `4.166.0`（workerd 2026-11-19）后恢复。这不是产品缺陷，但属于「验收能跑完」的前提，单独记录；生产部署不受影响。

### 2.8 版本号 9 处

`package.json`、`package-lock.json` 第 3/9 行（根版本；依赖版本一律不动）、`src/lib/version.ts`（`OS_VERSION` + RELEASES 首条）、`worker/api/version.js`、`public/sw.js`（`guandao-2.0.9`）、`shared/plugin-spec.js`、`worker/api/community/validate.js`、`cli/guandao.mjs`、`src/lib/core/registry.ts`；断言族 `tests/e2e/os20.spec.ts`、`scripts/community-qa.mjs:338`、`scripts/plugins-qa.mjs:196`、`.github/workflows/quality.yml:146/158`。

## 3. 证据

### 3.1 单测

| 文件 | 用例 | 结果 |
| --- | --- | --- |
| `tests/unit/files-range.test.ts` | 9 | passed |
| `tests/unit/plugins-net-stream.test.ts` | 4 | passed |
| `tests/unit/community-publish-hidden.test.ts` | 3 | passed |
| `tests/unit/community-comment-reports.test.ts` | 1 | passed |
| 全量 `npx vitest run` | **507** | 507 passed（1.58s） |

### 3.2 负向对照（真改回旧行为）

- `.tmp-neg-209.mjs`（默认拒绝执行）：改回「越界透传 R2、HEAD 只路由 GET、/net 整包读入」→ 单测 **3 failed / 10 passed**；真实 Worker E2E **1 failed**（`expect(beyond.status()).toBe(416)` 收到 **206**）。恢复后 SHA-256 两文件 `MATCH`，单测 13 passed，E2E 1 passed（14.0s）。
- `.tmp-neg-209b.mjs`：删掉发布闸门调用、评论举报退回 `WHERE id = ?` → 单测 **2 failed / 2 passed**（源码断言 gate=-1；结算 SQL 不含 `open/reviewing`）。恢复后 `MATCH` + `RESTORE_OK`，复跑 4 passed。

### 3.3 真实 Worker E2E（`--project=worker`）

| spec | 覆盖 | 结果 |
| --- | --- | --- |
| `tests/e2e/files-range-head.spec.ts` | 上传 1000 B → GET 200 → `bytes=0-9` 206 + body → `bytes=1001-` 416 + `bytes */1000` → HEAD 200 且 body 为空 | 1 passed（13.0s） |
| `tests/e2e/os20-tab-restore.spec.ts` | 设置切「系统」→ 关窗 → 重开高亮「系统」；市场切「社区」→ 关窗 → 重开高亮「社区」 | 2 passed（与上一个 spec 合并计 3 passed / 17.9s） |

全量 E2E：**202 passed（见 §3.4）**。

### 3.4 门禁

`npm run verify` **exit 0**：

- `[version] 一致：2.0.9`
- typecheck 0 error
- `Tests 507 passed（507）`
- html-security `合计 295 处，未审查 0 处`
- build 30 页
- `[csp] 校验通过：12 个哈希与 31 个 HTML 一致`

全量 E2E：`$env:E2E_ADMIN_PORT='18789'; npx playwright test --reporter=line` → **202 passed（5.0m）**，exit 0（2.0.8 的 199 + files-range-head 1 + os20-tab-restore 2）。跑前与跑中每 20 秒清 `rate_limits`。

## 4. 兼容性

- **新增 HEAD 支持**：无障碍；GET 行为不变。
- **新增 416 响应**：越界 Range 从「200/206 整包」变为 416 + `Content-Range: bytes */总长`，这是 RFC 7233 的正确行为；正常区间不受影响。
- **新增 409 `POST_HIDDEN`**：只影响「作者重新发布 hidden 作品」，正常发布/撤回/审核不受影响；公开响应字段无变化。
- **无数据库迁移**：`wrangler d1 migrations list --remote` 应为 `No migrations to apply!`。
- **wrangler devDependency 4.166.0**：只影响本地/CI 开发环境。

## 5. 部署注意（未部署，等授权）

1. `git fetch` 确认 `origin/main...HEAD` 只领先、不落后。
2. `npx wrangler d1 migrations list guandao-db --remote` → 应无待应用迁移。
3. 先备份：`npx wrangler d1 export guandao-db --remote --output ..\.backups\guandao-db-prod-<时间>.sql`。
4. `npm run cf:deploy`。
5. 核对 `/api/health` 的 `version`、`x-guandao-version` 响应头、首页入口包含 `2.0.9`。
6. `npm run qa:prod`（应 35/35）。
7. 回滚目标：2.0.8 的 Version `9be8e25b-eab0-43e6-bb0d-a0d8e3ca5d4d`。

## 6. 未修清单

本轮只修「不需要迁移、不改公开字段」的五条。以下留给 2.1.0 或独立迁移：

- **计数幂等（需迁移）**：`POST /posts/:id/view`、`GET /posts/:id/package?count=1` 可匿名重放刷量。
- **社区图片上传配额（需迁移）**：先查后写，需要 pending 预占行。
- **文件 `pending_delete` 无回收路径**：R2 删除失败后行永久停在 `pending_delete`，回收站看不见、也不会重试。
- **备份 merge 恢复的孤儿对象**：按哈希跳过的文件仍被 `FILES.put` 一遍。
- **插件安装上限 check-then-insert**：`MAX_INSTALLED = 40`，并发可超装。
- **慢启动欢迎窗导致 layout 恢复被跳过**：Cloud Mode 刷新可能丢布局。
- **数值滑杆只在 pointerup 落盘**：键盘调整与窗外松手会丢。
- **sync `since` 游标缺 tiebreak**：同时间戳跨页可能漏实体（官方前端不走这条，外部客户端受影响）。
- 生产审核链的写入型 E2E、真机 Safari/Firefox 仍未覆盖。