# 下一轮提示词 · 2.0.3（由 2.0.2 的踩坑整理）

> 用途：下一次让 AI 在 Guandao OS 上做补丁版本时，直接复制本文第 2 节作为任务书。
> 本文不是发布说明；2.0.2 的结论见 `docs/RELEASE-2.0.2.md`。
> 与 2.0.1 那版提示词相比，新增的硬约束全部来自本轮真实故障（见 §1）。

## 1. 本轮踩到的坑（写进下一版硬约束的原因）

1. **过期结论会自我繁殖。** STATUS 风险 4 与 ACCEPTANCE 第 293 行同时声称「页面级插件安装未入
   Playwright」，但 `tests/e2e/plugin-publishing.spec.ts:375-431` 早在 2.0.1 之前就已经完整跑了
   市场 → 安装 → 权限确认 → 「打开」→ 卸载；ACCEPTANCE 第 304 行甚至已经写了「已并入」。
   两份文档互相矛盾，却没有任何门禁发现。→ 硬约束：**任何「未覆盖 / 只有本地证据」的结论，
   下笔前必须先在 `tests/` 里搜同名链路**，并给出反证（文件:行号）。
2. **真实 Worker 的界面链路很贵。** 一个用例里串起「桌面启动 → 社区 → 审核中心 → 隐藏 →
   搜索 → 我的作品 → 撤回」会跑满 Playwright 全局 180 s，最后超时发生在 `finally` 的清理
   DELETE 上，堆栈看起来像「DELETE 挂了」，实际是前面每一跳各花 10–20 s。
   → 硬约束：**一个 test 只放一个用户场景**；多场景用 `test.step` 分组并给 `test.setTimeout`
   写明理由；清理放到 `try/catch` 且不能吞掉失败原因。
3. **跨源 iframe 的 name 索引只在导航提交后才有。** 2.0.1 起 CI 偶发
   「sandbox-sandboxed iframe 未出现」，真因是 append 后立刻 `page.frame({ name })` 抢跑。
   → 硬约束：**按 name 找帧必须轮询**（`expect.poll`），再等 URL 与 `load`。
4. **packageId 是一次性资源。** 删除只把 post/package 标 `deleted`，`assertPackageIdAvailable`
   不看状态，复用即 `409 PACKAGE_ID_TAKEN`。→ 硬约束：**所有夹具 id 带 RUN_ID**。
5. **本地 D1 会留脏数据。** e2e-server 的清理不删 `plugins` 行；残留 `com.qa.alg` 会让夹具构建
   报 `409 NO_VERSION`。`wrangler d1 execute --local` 因 `miniflare-email-store` 权限起不来，
   只能 Node 26 `node:sqlite` 直连。→ 硬约束：**连跑前清 `rate_limits`，遇到 NO_VERSION 先查
   `plugins` 残留**，并在日志里写清「环境问题，不是产品回归」。
6. **限流会伪装成偶发失败。** `plugin-upload` 20 次/小时，每轮夹具约 20 个签名包。
   → 硬约束：**同小时第二次全量 E2E 前必须清计数器**，否则 `429 RATE_LIMITED`。
7. **版本号有 9 个落点，但 `check-version.mjs` 只查 4 个。** 测试、脚本、CI 里的写死版本
   全靠 grep。→ 硬约束：**改版本后全仓搜旧版本号**，测试里的版本断言必须一起改并注明理由。
8. **构建会重写 `worker/api/csp-hashes.js`。** 它是产物，不是噪声；回滚它会让 CSP 拦掉入口脚本。
9. **Playwright 每次运行会清 `test-results/`。** 失败现场要先读 `error-context.md` + 截图再重跑，
   否则证据被下一次运行覆盖。

## 2. 下一轮任务书（可直接复制）

> 给 Guandao OS 做一次补丁版本发布，版本号 2.0.3。自行确定范围、自行写发布说明。

【背景】
- Astro 静态站 + Cloudflare Worker/D1/R2 的「网页操作系统」。
- 上一个发布文档 `docs/RELEASE-2.0.2.md`，当前状态 `docs/AI-BUILD-STATUS.md`，
  未关闭事项 `docs/AI-BUILD-BACKLOG.md`，历史 `docs/AI-BUILD-LOG.md`。
- 动手前先 `git status`；工作区可能有别人未提交的改动，不要覆盖。

【范围（按优先级取，取完为止）】
1. 把 BACKLOG / STATUS / ACCEPTANCE 里所有「Partially Verified / Implemented / 只有本地证据 /
   疑为竞态」的结论逐条变成「有失败证据 → 真修」或「有通过证据 → 关掉」。不允许中间态。
   下笔前先在 `tests/` 里搜对应链路，并写明反证的 `文件:行号`。
2. 补能让 1 成立的自动化测试：能纯函数化的抽纯函数单测；界面链路用 Playwright 在真实 Worker
   上跑（`--project=worker`），不许用 mock 冒充端到端。
3. 做完 1、2 还有余力，才碰性能与体验项。

【硬约束】
- 不改公开 API 契约（改了要同步文档与测试）；补丁版本不加数据库迁移。
- 版本号 9 处同步：`package.json`、`package-lock.json`、`src/lib/version.ts`（`OS_VERSION` 与
  `RELEASES` 首条）、`worker/api/version.js`、`public/sw.js`、`shared/plugin-spec.js`、
  `worker/api/community/validate.js`、`cli/guandao.mjs`、`src/lib/core/registry.ts`；
  以 `node scripts/check-version.mjs` 通过为准，并全仓 grep 旧版本号清理测试/脚本/CI 断言。
- 既有断言不许删；版本号出现在测试里就一起更新，语义变了要写明为什么变。
- 构建会重写 `worker/api/csp-hashes.js`，这是正常产物，不要回滚。
- **一个 E2E test 只放一个用户场景**；串多跳时用 `test.step` 分组，并用 `test.setTimeout`
  写理由（真实 Worker 下每一步 10–20 s 是常态）。
- **按 iframe name 找帧要轮询**（`expect.poll`），再等 URL 前缀与 `load`；不要一次性取帧。
- **夹具 id 一律带 RUN_ID**；删除只是软删，复用 packageId 会 409。
- 连跑全量 E2E 前清本地 `rate_limits`；`wrangler d1 execute --local` 不可用时用 Node 26
  `node:sqlite` 直连 `.wrangler/state/v3/d1/**/*.sqlite`。
- 中文注释写「为什么」，不写「做了什么」；不留调试插桩。
- 失败现场（`error-context.md`、截图、trace）先读再重跑，证据位置写进发布文档。

【证据标准】
- 单测：`npx vitest run <file>` 的用例数与通过数，不写「应该通过」。
- E2E：`npx playwright test --project=worker <spec>`，真实浏览器 + 真实 Worker，
  覆盖「点下去 → 界面到哪」；失败现场截图与 trace 存档并写进文档。
- 门禁：`npm run verify` 全绿（版本一致性 → 迁移 → typecheck → 单测 → 安全测试 →
  未使用依赖 → astro check → HTML 安全 → lint → build → CSP）；任一项红，版本不算完成。
- 文档区分 **Implemented（改了代码）** 与 **Verified（有测试证据）**；生产没部署就写 Blocked。

【交付物】
1. `docs/RELEASE-2.0.3.md`：缺陷回顾（含被推翻的旧结论）、逐条改动（贴关键代码与文件行号）、
   测试证据表、兼容性、部署注意。
2. `docs/PROMPT-2.0.3.md`：本文的下一版，把新踩到的坑写进硬约束。
3. `docs/AI-BUILD-BACKLOG.md`：关闭的条目标 `Fixed + 证据位置`，并写一句「旧结论错在哪」。
4. `docs/AI-BUILD-STATUS.md`：版本、用例总数、E2E 通过数、入口体积、首屏 CSS。
5. `docs/AI-BUILD-LOG.md`：追加本轮记录（时间、范围、门禁命令与结果）。

【报告风格】
先给结论（修好了没有、证据在哪），再给过程。不确定的地方明说「未验证」，
不要用「已优化」「应该没问题」这类话填空。

## 3. 2.0.2 兑现情况（对照用）

| 提示词要求 | 2.0.2 怎么做的 |
| --- | --- |
| 中间态清零 | 关掉「页面级插件安装未入 Playwright」「审核链异常分支无证据」两条；后者补真实 UI E2E |
| 真实 Worker E2E | 新增 `tests/e2e/community-admin-review.spec.ts`（4 个用例：拒绝/备注/重提/通过/详情、举报→隐藏→空态→恢复、撤回→草稿、403/400/404） |
| 不许中间态 | `sandbox-origin` 由「抖动、单独复跑通过」改为按 name 轮询取帧，给出 `--repeat-each` 稳定性证据 |
| 版本号 9 处 | 全部改到 2.0.2，并同步 `tests/e2e/os20.spec.ts`、`scripts/*-qa.mjs`、`.github/workflows/quality.yml` |
| 门禁 | `npm run verify` + 全量 Playwright + `check:docs`（见 RELEASE-2.0.2 §4） |
| 生产状态 | 未部署，文档写 Blocked（补丁只含测试与版本号，未动 Worker 行为） |

## 4. 下一轮优先看什么

1. `ACCEPTANCE-2.0.md` 里 Phase 5 表格与「未完成项」段落仍有互相矛盾的句子，建议做一次
   「结论 ↔ 证据」全表核对，把过期行标「历史」。
2. P3-2 教程页面级 E2E：`community-tutorial.spec.ts` 已覆盖草稿→审核→公开→隐藏，但正文渲染
   的浏览器断言仍缺；这是最小可验证的下一步。
3. P3-3 真机冒烟仍 Not Started，需要真实设备，AI 无法替代；不要用本地双 Context 冒充。
4. P4-1 真机平板、P2-6（需 Core Settings API）在本轮仍无法关闭，下一轮不要重复尝试同一路径。