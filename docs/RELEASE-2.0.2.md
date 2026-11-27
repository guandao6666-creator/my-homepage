# Guandao OS 2.0.2 · 发布说明

**版本**：2.0.2
**代号**：Hard Evidence（硬证据）
**日期**：2026-11-21
**类型**：补丁版本（无 schema 变更、无数据迁移、无公开 API 契约变更）
**上游**：2.0.1 · Steady Clicks
**状态**：**已部署到生产（https://guandao.xin，2026-11-21 10:43 +08:00，Worker Version `32adf7fb-a922-4c69-ab67-e626cdc4ac1a`）**，`qa:prod` 35/35 通过。

> 2.0.1 把 BACKLOG 里的中间态清零了，但还有三件事没有「能在 CI 里失败的证据」：
> 「页面级插件安装未入 Playwright」「审核链异常分支只有本地证据」「sandbox-origin 偶发红」。
> 2.0.2 只做一件事：把这三条从「相信它没问题」变成「跑给你看」。

---

## 1. 为什么需要 2.0.2

### 1.1 两条互相矛盾的过期结论

`docs/AI-BUILD-STATUS.md:88`（风险 4）与 `docs/ACCEPTANCE-2.0.md:293` 同时声称
「页面级插件安装未并入 Playwright，只有本地证据脚本」，但：

- `tests/e2e/plugin-publishing.spec.ts:375-431` 早已在真实桌面页里跑了
  市场 → 插件卡片 → 安装 → 权限确认 → 按钮变「打开」 → API 卸载还原；
- `docs/ACCEPTANCE-2.0.md:304` 甚至已经写了「已并入 plugin-publishing.spec.ts」。

同一份文档前后矛盾，而所有门禁都是绿的——因为没有任何检查会把「文档说没覆盖」和
「测试文件里其实有」对上。这是**结论过期**，不是功能缺陷。

### 1.2 审核链只有协议级证据

管理员审核中心的「拒绝 / 隐藏 / 恢复 / 删除」在 2.0.1 只有 API 级与手工本地证据，
没有页面级断言。状态写的是「仅本地证据」，既不能算 Verified，也不该继续挂着。

### 1.3 sandbox-origin 的「偶发红」不是偶发

2.0.1 的 CI 里，`tests/e2e/sandbox-origin.spec.ts` 报过一次
`sandbox-sandboxed iframe 未出现`（run 44755296676，183 passed / 1 failed），重跑即过。
看起来像抖动，实际是**测试自身的抢跑**：

```ts
// 2.0.1 及以前：append 三个 iframe 后立刻按 name 取帧
const sandboxedFrame = page.frame({ name: "sandbox-sandboxed" });
if (!sandboxedFrame) throw new Error("sandbox-sandboxed iframe 未出现");
```

跨源 iframe 只有在**导航提交之后**才进入 Playwright 的 name 索引。机器负载高时，
提交晚几十毫秒，取帧就拿到 `null`。重跑能过只是因为第二次刚好快一点——
这就是为什么它必须被修，而不是被标注成「已知抖动」。

---

## 2. 改动清单

### 2.1 按 iframe name 轮询等待（test-only）

`tests/e2e/sandbox-origin.spec.ts` 新增 `waitForNamedFrame(page, name, prefix)`：

```ts
let found: Frame | undefined;
await expect
  .poll(() => { found = page.frame({ name }) ?? undefined; return Boolean(found); },
    { timeout: 20_000, message: `等待 iframe：${name}` })
  .toBe(true);
if (!found) throw new Error(`iframe 未出现：${name}`);
const frame: Frame = found;
await expect.poll(() => frame.url().startsWith(prefix), { timeout: 20_000 }).toBe(true);
await frame.waitForLoadState("load");
```

三个帧全部改为按 name 等待：`host-sandboxed`（宿主同源 + `allow-scripts`）、
`sandbox-plain`、`sandbox-sandboxed`（独立源，后者加 `allow-scripts`）。

**为什么按 name 而不是 URL**：`sandbox-plain` 与 `sandbox-sandboxed` 导航到同一个
`/sandbox/runner`，按 URL `find()` 可能拿到另一个帧，后续「未沙箱帧 Origin 正常」的断言
会随机落到沙箱帧上——那会变成另一个更难查的假绿。

**产品代码零改动**：`sandbox/runner` 与 CSP 均未动，本项只修测试的等待方式。

### 2.2 新增审核链的真实浏览器证据

新增 `tests/e2e/community-admin-review.spec.ts`（真实 Worker + 真实桌面 UI），四个用例：

1. **拒绝 → 备注 → 重新提交 → 通过 → 公开可搜**：
   作者提交（`pending_review`）→ 公开搜索 0 条 → 管理员在「审核中心」点「拒绝」并写审核备注
   → 队列行消失 → 作者「我的作品」出现 `.cx-modnote`（审核备注）与 `.cx-status-chip`「未通过」
   → 点「提交审核」→ 芯片「待审核」→ 管理员「通过」→ 公开搜索 1 条 → 点开详情标题一致。
2. **举报 → 隐藏 → 搜不到 → 恢复 → 重新出现**：
   已发布作品被第三方举报 → 管理员「举报处理」→ `report-hide-post` 填处理说明 → 作品从公开搜索消失
   （空态文案「没有找到相关作品」）→ 审核中心「已隐藏」队列里恢复（`approve`）→ 重新可搜。
3. **作者撤回**：「我的作品」→「撤回」→ 芯片变「草稿」→ 公开搜索 0 条。
4. **接口权限分支**：非审核员调用审核接口 403；未知动作 400（响应含「未知的审核操作」）；
   不存在的作品 404。

### 2.3 过程中发现的两个「文档没写、代码才是真相」

这两个不是 bug，但决定了测试该怎么写，也值得记下来：

1. **「已发布」不在审核队列里。** 审核中心的筛选芯片只有
   `pending_review / hidden / rejected / draft`（`src/lib/os14/community/moderation.ts:46`），
   服务端也只接受这四种（`worker/api/community/admin.js:52`）。
   卡片模板里的 `review-hide` 按钮（`moderation.ts:63`）只在 `status === "published"` 时渲染，
   而 published 永远不进队列——**这个按钮实际不可达**。
   下架已发布作品的真实入口是「举报处理 → 隐藏作品」
   （`src/lib/os14/community.ts:782` → `reviewReport(id, "hide_post")`，
   弹窗 `[data-report-resolution]` + `[data-mv="go"]`）。
   因此用例 2 的链路是「第三方举报 → 管理员处理举报」，而不是「在队列里点隐藏」。
2. **作品卡的状态芯片只在非「已发布」时出现**
   （`src/lib/os14/community/ui.ts:58`：`post.status !== "published"` 才渲染）。
   同一张审核卡里还有**两个** `.cx-status-chip`（封面一个、标题行一个），
   所以断言必须收窄到 `.cx-mod-head .cx-status-chip`，否则 strict mode 直接报错。

这两个发现都先写进了测试注释，再写进本文——避免下一轮又踩一遍。

### 2.4 关闭三条过期结论

| 文件 | 原结论 | 2.0.2 处理 |
| --- | --- | --- |
| `docs/AI-BUILD-STATUS.md:88` | 风险 4「页面级插件安装未并入 Playwright」 | 删掉该风险，改为已由 `plugin-publishing.spec.ts:375-431` 覆盖 |
| `docs/ACCEPTANCE-2.0.md:293` | 「插件发布闭环 … 页面级 Partially Verified」 | 改为 **通过（API + 页面级 Playwright，2026-11-21 复核）**，并注明旧结论作废 |
| `docs/architecture/COMMUNITY-PUBLISHING.md:191/198` | 「页面级未并入 Playwright 套件」「Playwright 内为协议级」 | 改为 **Verified（Playwright，2026-11-21 复核）**，证据指向具体行号，旧手工脚本不再是证据来源 |

### 2.5 版本号 2.0.2（9 处 + 断言）

- `package.json`、`package-lock.json`（第 3、9 行）
- `src/lib/version.ts`：`OS_VERSION` 与 `RELEASES` 首条
  `{ version: "2.0.2", name: "Hard Evidence", date: "2026-11-21" }`，note 四条
- `worker/api/version.js`（`WORKER_VERSION`）
- `public/sw.js`（`guandao-2.0.2`）
- `shared/plugin-spec.js`、`worker/api/community/validate.js`
- `cli/guandao.mjs`（`CLI_VERSION` 与模板 `minimumOSVersion`）
- `src/lib/core/registry.ts`（默认回退 `"2.0.2"`）

引用版本号的测试/脚本/CI 同步：`tests/e2e/os20.spec.ts:54/168/232/238`、
`scripts/community-qa.mjs:338`、`scripts/plugins-qa.mjs:196`、
`.github/workflows/quality.yml:146/158`。

---

## 3. 测试证据

| 证据 | 命令 | 结果 |
| --- | --- | --- |
| 版本一致性 | `node scripts/check-version.mjs` | `[version] 一致：2.0.2`（exit 0） |
| 单测 | `npx vitest run` | **21 files / 375 passed**（1.54s）；本版未新增单测，改的是 E2E 与版本号 |
| 审核链 E2E | `npx playwright test --project=worker tests/e2e/community-admin-review.spec.ts` | **4 passed（30.4s）**，真实 Worker + 真实桌面 UI |
| sandbox 稳定性 | `npx playwright test --project=worker tests/e2e/sandbox-origin.spec.ts --repeat-each=3` | **3 passed（17.6s）** |
| 全量 E2E | `npx playwright test`（workers=1, retries=0） | **188 passed（5.1m）**，含 plugin-publishing 的页面级安装链路 |
| 门禁 | `npm run verify` | **exit 0**：typecheck 0 error、单测 375、security、unused、astro、html-security **294 处全审查**、lint、build **30 页**、gen-csp **12 哈希 / 31 HTML**、check:csp 通过 |
| 体积 | `node scripts/perf-baseline.mjs --json` | 入口 JS **433.9 KB / 439.5 KB（98.7%）**、首屏 CSS **184.7 KB / 195.3 KB（94.6%）** |

### 3.1 本轮被推翻的两个判断

1. 「审核队列里可以直接隐藏已发布作品」——**不成立**（见 §2.3）。第一版用例 2 就是这么写的，
   结果对不存在的 `[data-queue-status="published"]` 芯片点击，Playwright 一直等，
   180 s 后超时，堆栈却落在 `finally` 的清理 DELETE 上，看起来像「DELETE 挂了」。
   读 trace 才看清：最后一个动作是那个永远点不到的 click。
2. 「sandbox-origin 是环境抖动」——**不成立**。真因是测试抢在导航提交前按 name 取帧（见 §1.3）。

### 3.2 本地环境事故（已记入 LOG，不是产品回归）

- `plugin-upload` 限流 **20 次/小时**，每轮 e2e-server 造夹具要上传约 20 个签名包。
  同小时第二次全量 E2E 必 `429 RATE_LIMITED`（本次提示「请 310 秒后再试」）。
  处置：Node 26 `node:sqlite` 直连本地 D1
  （`.wrangler/state/v3/d1/miniflare-D1DatabaseObject/5e13b83e….sqlite`），
  `DELETE FROM rate_limits` + `PRAGMA wal_checkpoint(TRUNCATE)`；
  `wrangler d1 execute --local` 因 `miniflare-email-store` 目录权限起不来，不可用。
- 清理脚本参数必须写成 `node .tmp-clear-rate.mjs "$db"`（带引号）；
  否则 PowerShell 把 `(path)` 当命令解析，报 `path argument must be a string`。
- 首次单独跑 `plugin-publishing.spec.ts` 时撞上同一个限流（429 后 `version.checksum` 读不到，
  matcher 又报 `received value must be a string`——次生错误）。重跑全量前清计数器后 188 全绿。
- 编辑 Markdown 时偶发 `ReplaceFileW EIO (Win32 1175)`（连续快速写同一文件被锁），重试即成功。

---

## 4. 兼容性

- **无公开 API 契约变更**：`/api/*` 的请求/响应未动；新增的只是测试文件。
- **无数据库迁移**：2.0.2 不新增 `migrations/`，生产 D1 结构不变。
- **Worker 行为无变化**：除 `worker/api/version.js` 的版本字符串外，`worker/` 无逻辑改动。
- **前端行为无变化**：`src/` 只改 `version.ts` 的版本常量与 `registry.ts` 的默认回退。
- **样式/资源**：构建多出的一页来自已合并的博客文章（`src/content/blog/`），不是本版新增功能。

---

## 5. 部署记录（2026-11-21）

1. 备份生产 D1：
   `npx wrangler d1 export guandao-db --remote --output .backups/guandao-db-prod-20261121-104235.sql`
   → **625,640 B**。
2. `npx wrangler d1 migrations list guandao-db --remote` → `No migrations to apply!`（2.0.2 不加迁移）。
3. `npm run cf:deploy`（exit 0）：build 30 页、上传 32 个新资源（195 个未变）、
   Total Upload **734.46 KiB / gzip 161.46 KiB**、Worker Startup 4 ms，
   绑定 `BACKUP_WORKFLOW / DB / FILES / DB_BACKUPS / ASSETS` 正常；
   **Current Version ID `32adf7fb-a922-4c69-ab67-e626cdc4ac1a`**（`deployments list` 显示
   2026-11-21T02:43:03Z，100%）。
4. 部署后核对：
   - `/api/health` → `{"status":"ok","version":"2.0.2","releaseName":"The Platform Era","services":{"d1":"connected","r2":"available"}}`；
   - 响应头 `x-guandao-version: 2.0.2`；
   - 首页 200（27,812 B），入口包 `/_astro/index.astro_astro_type_script_index_0_lang.Tr0vnTIr.js`
     （444,311 B）内含 `2.0.2`；
   - `npm run qa:prod` → **35/35 通过**，测试数据清理后 `{"users":0}`。
5. 注意：Cloudflare 对每次 push `main` 都会触发一次自动构建部署，Version ID 会变；
   以 `wrangler deployments list` 与 `/api/health` 为准，不要只认手部署那一次。
   清理脚本仍会在 `event_type` CHECK 约束上报既有警告（脚本 exit 0、清理核对通过）。
6. 推送 `main`（`9e3387a..de3cb7c`）后的证据：GitHub Actions `quality` run
   **44857906680 success**；Cloudflare 自动构建 Version `8dd5e807-20b8-418c-b1bb-b80972e789b7`
   （2026-11-21T02:49:40Z），入口包哈希随之变为 `VhC_h3-F.js`，`/api/health` 仍报 `2.0.2`。

---

## 6. 未完成 / 未验证

- **P3-2 教程页面级浏览器断言**：`community-tutorial.spec.ts` 覆盖草稿→审核→公开→隐藏，
  但正文渲染的浏览器断言仍缺（Not Started）。
- **P3-3 真机冒烟**：需要物理设备，AI 无法替代（Not Started）。
- **P2-6 `os13.ts` 拆分**：需要 Core Settings API（Blocked）。
- **告警 webhook**（`BACKUP_ALERT_WEBHOOK` / `DATA_ALERT_WEBHOOK`）：生产仍未配置（2.0.1 遗留）。
- **ACCEPTANCE-2.0.md 其余行**：只改了第 293 行；整表「结论 ↔ 证据」核对留给下一轮。