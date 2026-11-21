# Guandao OS 2.0.3 · 发布说明与交付报告

- **版本**：2.0.3
- **代号**：Silent Ballot
- **类型**：补丁版本（生产缺陷修复）
- **上游版本**：2.0.2「Hard Evidence」
- **日期**：2026-11-21
- **状态**：本地/CI 已验证；生产部署结果见 §5

---

## §1 缺陷回顾

### 现象

用户报告「议会投票一直不成功」：点选项后界面短暂显示已投，随后提示
「投票没提交上，再点一次试试」，票数不增长；刷新后本地「已投」记录也被撤销。

### 根因

`worker/index.js` 的 `/sb` 同源代理（Supabase 反代）在 1.9 安全加固时写了：

```js
headers.delete("cookie");
headers.delete("authorization");   // ← 这里
```

Cookie 必须删（它是本站 `gauth_sid` 会话，不能透传给第三方 Supabase），
但 **Authorization 是 Supabase 识别用户的唯一通道**。删掉之后 PostgREST
只能把请求当成匿名（anon），而 `supabase/bind-auth.sql` 给 `votes` 的插入策略是：

```sql
create policy "votes insertable" on public.votes for insert
  to authenticated with check (auth.uid()::text = voter);
```

于是所有登录用户的写入都落到 `42501 new row violates row-level security policy`。
前端 `council/index.ts:212-224` 把非 2xx/409 一律当成失败，撤销本地记录并提示。

### 为什么 2.0 系列没发现

- 现有 E2E 全部打的是本站自建 Worker API（`/api/*`），Supabase 在测试里只作为
  **构建期只读数据源**（首页 seed、文章同步），从未覆盖「登录用户写 Supabase」；
- 读取只靠 `apikey` 就能通过，所以议会议题列表、树洞列表一直正常显示，
  故障只出现在写路径；
- 1.9 之后没有任何一条自动化用例观察 `/sb` 的请求头。

### 影响面

同一条身份链上的功能一起被破坏（不是议会独有）：

| 功能 | 写路径 | 2.0.2 行为 |
|---|---|---|
| 议会投票 | `POST /rest/v1/votes` | 42501，提示提交失败 |
| 树洞发帖 / 回复 | `POST /rest/v1/holes`、`/hole_replies` | 同上 |
| 社交名片 | `PATCH/POST /rest/v1/profiles`、`follows` | 同上 |
| 议会议题/票数读取 | `GET /rest/v1/polls`、`votes` | 正常（apikey 足够） |

---

## §2 改动

### 唯一的产品改动

```diff
 // 1.9 安全修复：/sb 是同源代理，浏览器会自动带上 guandao.xin 的 Cookie。
 // 这些 Cookie 属于本站会话，绝不能透传给 Supabase（第三方）。
+// 注意：Authorization 必须保留。Supabase 用 `Authorization: Bearer <access_token>`
+// 识别登录用户；此前一并删掉，PostgREST 只能看到 anon，RLS 的
+// `auth.uid()::text = voter` 永远不成立，议会投票等写操作全部 42501。
 headers.delete("cookie");
-headers.delete("authorization");
 headers.set("origin", `https://${SUPABASE_HOST}`);
 headers.set("referer", `https://${SUPABASE_HOST}/`);
```

为什么这样是安全的：

- Cookie 仍然不转发，本站会话不会泄漏给 Supabase；
- `Authorization` 只由本站页面在调用 `/sb/*` 时携带（Supabase access token），
  浏览器不会把它自动附加到其它请求；
- `apikey`（publishable key）本来就随页面公开下发，权限边界始终是 RLS。

### 版本号

9 处版本源同步到 2.0.3：`package.json`、`package-lock.json`（root 两处）、
`src/lib/version.ts`（`OS_VERSION` + RELEASES 首条 2.0.3）、`worker/api/version.js`、
`public/sw.js`（`guandao-2.0.3`）、`shared/plugin-spec.js`、
`worker/api/community/validate.js`、`cli/guandao.mjs`、`src/lib/core/registry.ts`；
引用版本的断言同步：`tests/e2e/os20.spec.ts`（4 处）、`scripts/community-qa.mjs`、
`scripts/plugins-qa.mjs`、`.github/workflows/quality.yml`（2 处）。

无公开 API 契约变更、无数据库迁移。

---

## §3 测试证据

新增 `tests/e2e/supabase-proxy-auth.spec.ts`（真实 Worker + 真实 Supabase，不写数据）。
关键在于**区分性错误码**：

- 带一个结构合法、签名无效的 JWT：代理若透传，PostgREST 会先解码并报 `PGRST301`；
- 不带 Authorization：只能按匿名处理，落到 `42501`。

| 证据 | 命令 | 结果 |
|---|---|---|
| 线上故障复现（2.0.2 生产） | `POST https://guandao.xin/sb/rest/v1/votes` + Bearer 假 JWT | **401 `42501`**（身份没到上游） |
| 修复后本地代理 | 同一请求打 `http://127.0.0.1:8799/sb/rest/v1/votes` | **401 `PGRST301`**（JWT 被上游解码） |
| 回归用例 | `npx playwright test --project=worker tests/e2e/supabase-proxy-auth.spec.ts` | **3 passed（12.8s）** |
| 负向对照 | 临时恢复 `headers.delete("authorization")` 后重跑 | **1 failed / 2 passed**（用例 1 收到 42501） |
| 恢复修复后复跑 | 同上 | **3 passed** |
| 版本一致性 | `node scripts/check-version.mjs` | `一致：2.0.3` |
| 全量门禁 | `npm run verify` | 见 §3.1 |

### §3.1 门禁实跑

| 项目 | 结果 |
|---|---|
| `node scripts/check-version.mjs` | `[version] 一致：2.0.3（package.json / version.ts / worker / sw.js）` |
| `npm run typecheck`（verify 内） | 0 error（仅既有 warning） |
| 单测 `npx vitest run` | **21 files / 375 tests passed（974ms）** |
| `npm run verify` | **exit 0**：security:test、unused、astro → build **30 页** → gen-csp **12 个哈希 / 31 个 HTML** → check:csp 通过 |
| html-security | **294 处 / 未审查 0** |
| 入口体积 `scripts/perf-baseline.mjs` | 入口 JS **434.3 / 439.5 KB（98.8%）**；首屏 CSS **184.7 / 195.3 KB（94.6%）**；合计 JS 1311.8 KB · CSS 586.4 KB · 资源 102 个 |
| E2E（新增 spec） | **3 passed（12.8s）**；负向对照 **1 failed / 2 passed** |
| 全量 E2E | `npx playwright test`（worker + chromium + firefox-worker + webkit-worker） | **191 passed（4.8m），exit 0** |

> 全量首跑时 190 passed / 1 failed，失败点是 `community-follow.spec.ts:15` 的
> `GET /api/community/creators/:id` 返回 500。排查结论是**测试进程自己在打数据库**：
> 为了绕开 `plugin-upload` 20 次/小时限流，我在后台每 20 秒对本地 D1 执行一次
> `DELETE FROM rate_limits` + `PRAGMA wal_checkpoint(TRUNCATE)`，与 Worker 的写入抢锁，
> 偶发 `SQLITE_BUSY` 被包装成 500。停掉轮询、只在上跑前清一次后复跑全量 **191 passed**，
> 单独复跑该 spec 也 1 passed。产品侧没有该缺陷。

---

## §4 兼容性

- 前端、数据库 schema、公开 API 均未变；`/sb` 只是多转发一个请求头。
- 对匿名请求的行为不变：没有 Authorization 时为 anon，读取仍可用。
- 对已登录用户：写操作从「必然 42501」恢复为「RLS 按 `auth.uid() = voter` 判定」。
- 已投过票的用户：前端按 `(poll_id, voter)` 唯一约束，重复投票仍是 409，按成功处理。

---

## §5 部署记录

| 步骤 | 结果 |
|---|---|
| 生产 D1 迁移检查 | `npx wrangler d1 migrations list guandao-db --remote` → `No migrations to apply!`（本版无 schema 变更，未做备份） |
| 部署 | `npm run cf:deploy` → build 30 页、`Uploaded 32 of 32 assets`、Total Upload **734.42 KiB / gzip 161.45 KiB**、Worker Startup 2 ms，**Version `f7af6eda-f904-4e99-b7a4-051653e8819a`** |
| 版本核对 | `GET /api/health` → `"version":"2.0.3"`；响应头 `x-guandao-version: 2.0.3` |
| 生产 `/sb` 判别性复测 | `POST /sb/rest/v1/votes` + `apikey` + 结构合法但签名无效的 JWT → **401 `{"code":"PGRST301","message":"JWT cryptographic operation failed"}`**（修复前同一请求是 `42501`，说明身份头已到上游） |
| 请求体透传复核 | `POST /sb/auth/v1/token?grant_type=password` + 真实 JSON → **400 `invalid_credentials`**（上游确实解析到了 body，排除「只修了头、body 仍丢」的假绿） |
| 读路径 | `GET /sb/rest/v1/polls?select=id,title&limit=1` → 200 |
| `npm run qa:prod` | **35/35 通过**（生产环境）；清理后 `{"users":0}` |
| 推送与 CI | 提交推送到 `main` 后 GitHub Actions `quality` 与 Cloudflare 自动构建见 LOG Round 29 尾条 |

---

## §6 未完成与注意

- 这次修复不改变「不能匿名投票」的设计：投票仍需登录，只是登录状态终于被
  Supabase 认可。
- 树洞、社交名片共用同一代理，修复同时生效，但没有为它们各写 UI 级 E2E
  （写路径需要 Supabase 账号；本轮只验证代理层与议会链路的判别性证据）。
- 若后续给 `/sb` 增加安全策略，判断标准应是「上游是否需要这个头」，
  而不是「同源代理就应该删所有敏感头」。