# AI-BUILD-BACKLOG · Guandao OS 待办与优先级

> 只记录**尚未完成**的工作。已完成项在 `docs/AI-BUILD-LOG.md` 与 `docs/RELEASE-2.0.md`。
> 优先级定义与纲领一致：P0 数据/安全/认证 → P1 核心功能/一致性/备份 → P2 架构/稳定/性能 → P3 规划功能 → P4 视觉 → P5 实验。

## P0 · 数据与安全（当前无未关闭项）

| # | 任务 | 状态 | 备注 |
| --- | --- | --- | --- |
| P0-1 | 生产部署 / 生产迁移 / `qa:prod` | **`Verified`（生产，2026-11-21 · 2.0.2）**：`npm run cf:deploy` 部署 Version `32adf7fb-a922-4c69-ab67-e626cdc4ac1a`，`/api/health` 报 `"version":"2.0.2"`、响应头 `x-guandao-version: 2.0.2`；生产 D1 无待应用迁移（`d1 migrations list --remote` → No migrations to apply）；`npm run qa:prod` **35/35 通过**（2.0.1 的 2026-11-20 部署与 35/35 见历史记录） | 部署前已导出生产 D1 全量备份（625,640 B，2026-11-21） |
| P0-2 | 社区发布链生产验证 | **`Verified`（生产，2026-11-18）**：`prod-community-qa.mjs` 实跑 9/9 通过，qa-prod 清理归零 | 本地 260/260 已过 |

## P1 · 核心功能与一致性

| # | 任务 | 状态 | 依赖 | 验收 |
| --- | --- | --- | --- | --- |
| P1-1 | 页面级插件安装并入 Playwright | **`Verified`（本地）**：发布链用例内新增真实桌面安装步骤（市场卡片 → 安装 → 权限确认 → 按钮变「打开」 → 卸载还原）；2.0.2 全量 E2E 188 passed 复核 | 已完成 | 不再依赖 `.shots/_p5-page-install-evidence2.mjs` 手工脚本 |
| P1-2 | `initRank` 关窗后仍写 DOM | **`Verified`（本地）**：请求返回后先判 `win.isConnected`，关窗即停止写入；单测覆盖 | 已完成 | 新增单测「窗口已关闭时请求返回后不再写 DOM」 |
| P1-3 | legacy 网络请求取消 port | **`Verified`（本地）**：port + 只读 8 处 + 写请求 6 处全部接入；token 刷新单飞；外壳 fetch 统一实现 | 已完成 | 单测 23 项；E2E 26 passed（含关窗回归） |

## P2 · 性能与可观测（当前阶段）

| # | 任务 | 状态 | 目标 | 验收 |
| --- | --- | --- | --- | --- |
| P2-6 | `os13.ts` 巨型闭包拆分 | `Blocked` | 需 Core Settings API | 拆分后入口与设置面板可独立测试 |

## P2 · 剩余

| # | 任务 | 状态 | 依赖 | 验收 |
| --- | --- | --- | --- | --- |
| P2-7 | 6.2 余量（单文件）3.8 KB | 观察 | — | 新增首屏样式前先判断是否真属首屏 |
| P2-8 | 6.2 延迟加载：CSS `?url` + 运行时 `<link>` | **`Verified`（本地）**：22 个应用样式全部接入，首页样式表 17 → **2** | 已完成 | 新增应用必须同时导出 stylesReady 并由 `lazy()` 包裹 |
| P2-9 | 6.2 剩余 4,269 B | **`Verified`**：主题中心改 `load()`，`themes.css` 移出首屏 | 已完成 | 首屏 CSS 185,110 B，余量约 14.9 KB |

## P3 · 生态与开发者体验

| # | 任务 | 状态 | 备注 |
| --- | --- | --- | --- |
| P3-1 | 6.4 生产性能基线进发布报告 | `Not Started` | `scripts/prod-e2e.mjs` + `docs/RELEASE-2.0.md`；需生产授权 |
| P3-2 | 教程页面级浏览器断言 | `Not Started` | 当前仅 API/单测覆盖正文渲染 |
| P3-3 | 真机（物理设备）冒烟 | `Not Started` | 设备接力/配对未在真机验证 |

## P4 · 视觉与体验

| # | 任务 | 状态 | 备注 |
| --- | --- | --- | --- |
| P4-1 | 平板模式验证 | **`Verified`（本地 / E2E 部分）**：820/1024→tablet、1280/1440→desktop、390→/m/；平板样式 46px/58px 生效 | 真机仍 Blocked |

## 已完成

- 6.1 旧版应用懒加载（2026-11-18）：入口 525,102 B → 482,939 B；单测 13 → 16 项；E2E 目标 spec 27 passed。
- 6.3 诊断中心接入真实 LCP/CLS/INP（2026-11-18）：新增「指标」分区；无数据「未采集」；
  浏览器不支持「不支持」；E2E `desktop.spec.ts` 新增 1 项；HTML 安全 292 处全审查。
- 6.1 收尾（2026-11-18）：应用中心改 `load()`，入口 482,939 → **442,621 B**，达标；
  顺带修复「发现页搜索框输入无效」的真实缺陷。
- 6.2 首屏 CSS（2026-11-18）：**通过**。22 个应用样式改运行时加载 + 主题中心懒加载，
  首页 2 个样式表 185,110 B（原 476,749 B）。

## 2026-11-18 新增（复核时发现）

| ID | 事项 | 状态 | 依据 | 修复方向 |
| --- | --- | --- | --- | --- |
| P1-8 | 社区搜索结果卡片点击无效 | **`Fixed`（2.0.1 · 有回归测试）** | 根因是 click 代理的分页分支用裸选择器 `target.closest("[data-page]")`，命中外壳写在 `<html data-page="desktop">` 上的标记（src/lib/shell/adaptive.ts:141），在 `openPostFromEvent` 之前 `return`，`Number("desktop") ‖ 1` → 重画第 1 页。修复随主线提交 `bc44b75` 进入，2.0.1 把它收敛成纯函数 `pickPageButton()`（`button[data-page]` + 数字校验）。证据：`tests/unit/community.test.ts`（3 项）+ `tests/e2e/community-search-open.spec.ts`（真实 Worker 上「搜索 → 点卡片 → 详情」「点空白不跳走」） | 已完成。**旧结论作废**：2.0.0 记的「`isStale` 竞态」不成立——`loadDetail` 压根没被调用；「一次点击 6 次 `setBody`」是 init 起累计（loadHome 2 + loadSearch 2 + 误触 loadSearch 2），不是单次点击 |

---

## 2026-11-18 · Round 21 · P1-8 根因收窄到竞态（**已被 2.0.1 推翻，见下节**）

- 在 `setBody` 插桩后观察到：一次卡片点击产生了 6 次 `setBody`，全部写入连接中的节点，
  最终内容又回到搜索结果页 —— 说明详情加载被后续渲染判定为 stale 而中止，视图回滚。
- 结论：不是点击丢失、不是引用失效，而是**并发重渲染与 loadDetail 的竞态**。
  下一步应查重渲染来源（通知轮询 / community-change 事件 / 搜索的二次触发）。
- 插桩已撤销、构建已还原，工作区干净。

---

## 2026-11-21 · Round 23 · 2.0.2 收口（Hard Evidence）

本版不开新功能，只把「结论过期」与「只有本地证据」两类中间态变成可复跑的自动化证据。
发布说明见 `docs/RELEASE-2.0.2.md`。

- **关闭「页面级插件安装未并入 Playwright」**：`tests/e2e/plugin-publishing.spec.ts:375-431`
  一直在真实桌面页跑「市场 → 卡片 → 安装 → 权限确认 → 按钮变『打开』 → 卸载还原」。
  2.0.2 在全量 E2E 里复核（188 passed），并改写 `docs/ACCEPTANCE-2.0.md:293` 与
  `docs/architecture/COMMUNITY-PUBLISHING.md:191/198` 的过期结论。
  **旧结论错在哪**：两份文档互相抄，没人回头搜 `tests/`；ACCEPTANCE 304 行早已写「已并入」，
  293 行没跟着改。
- **关闭「审核链只有本地证据」**：新增 `tests/e2e/community-admin-review.spec.ts`，四个用例在
  真实 Worker + 真实桌面 UI 上跑通（4 passed / 30.4s）：拒绝→备注→重提→通过→详情；
  举报→隐藏→搜不到→恢复；撤回→草稿；非审核员 403、未知动作 400、作品不存在 404。
  过程中确认了两件事并写进注释：审核队列只有四种状态（`moderation.ts:46`、`admin.js:52`），
  「已发布」不在队列里，下架已发布作品必须走「举报处理 → 隐藏作品」；作品卡状态芯片只在
  非已发布时渲染（`ui.ts:58`），且审核卡里有两个芯片，断言必须收窄到 `.cx-mod-head`。
- **关闭「sandbox-origin 偶发」**：真因不是环境抖动，而是测试在 iframe 导航提交前就按 name
  取帧（跨源帧只有提交后才进 name 索引）。改为 `expect.poll` 等 name 出现、再等 URL 与 load；
  `--repeat-each=3` → **3 passed（17.6s）**。
- **版本号**：2.0.2 同步 9 处 + 测试/脚本/CI 断言；`node scripts/check-version.mjs` 通过。
- **门禁**：`npm run verify` exit 0（typecheck 0 error、单测 21/375、html-security 294 全审、
  build 30 页、CSP 12 哈希/31 HTML）；全量 E2E **188 passed（5.1m），exit 0**。
- **生产**：已部署 2.0.2（Version `32adf7fb-a922-4c69-ab67-e626cdc4ac1a`）；`/api/health` 报 2.0.2、
  响应头 `x-guandao-version: 2.0.2`；`npm run qa:prod` **35/35**。
- **环境教训**：`plugin-upload` 20 次/小时 + 每轮夹具约 20 个签名包，同小时连跑全量必 429；
  只能用 Node 26 `node:sqlite` 直连本地 D1 清 `rate_limits`（`wrangler d1 execute --local` 不可用）。
- **教训**：文档里的「未覆盖」本身就是一条需要证据的断言；下笔前先在 `tests/` 里搜同名链路。

---

## 2026-11-21 · Round 24 · 2.0.3 收口（Silent Ballot）

用户报「议会投票一直不成功」。根因不在议会，而在 `/sb` 同源代理（`worker/index.js`）：
1.9 安全加固时把 `cookie` 和 `authorization` 一起删了。Cookie 该删，Authorization 不该——
Supabase 的 RLS 用 `auth.uid()::text = voter` 认人，头被删后 PostgREST 只能看到 anon，
所有登录用户写入 42501。受影响的不止议会：树洞发帖/回复、社交名片写入共用同一条身份链。

- **修复**：只剥离本站 Cookie，保留 `Authorization`；注释写明为什么（上游靠它认证）。
- **线上复现**：`POST https://guandao.xin/sb/rest/v1/votes` + 结构合法但签名无效的 JWT
  → **401 `42501`**（身份没到上游）；修复后本地同一请求 → **401 `PGRST301`**（JWT 被解码）。
- **回归用例**：新增 `tests/e2e/supabase-proxy-auth.spec.ts`（真实 Worker + 真实 Supabase），
  三条：带 JWT → PGRST301；不带 → 42501；读请求 200。**3 passed（12.8s）**。
  负向对照：临时恢复删除行 → **1 failed / 2 passed**；恢复后 3 passed。
- **版本**：2.0.3 同步 9 处 + 4 处断言族；`node scripts/check-version.mjs` → 一致。
- **门禁**：`npm run verify` **exit 0**（typecheck 0 error、单测 21/375、html-security 294 全审、
  build 30 页、CSP 12 哈希/31 HTML）；入口 JS 434.3/439.5 KB（98.8%）、首屏 CSS 184.7/195.3 KB（94.6%）。
- **教训**：同源代理删头前先问「上游靠不靠它认证」；「读正常」会掩盖「写全挂」；
  代理回归要用区分性错误码（PGRST301 vs 42501），不能只断言「非 200」。
- **全量 E2E**：`npx playwright test` → **191 passed（4.8m），exit 0**。
- **环境教训（新）**：为绕开 `plugin-upload` 限流而在后台每 20 秒清 `rate_limits` 并
  `wal_checkpoint(TRUNCATE)`，会与 Worker 的 D1 写入抢锁，偶发 `SQLITE_BUSY` 被包装成
  500（本轮 `community-follow` 因此红了一次）。做法改为「上跑前清一次」，复跑 191 passed。
- **生产**：`npm run cf:deploy` → Version `f7af6eda-f904-4e99-b7a4-051653e8819a`；
  `/api/health` 报 2.0.3、`x-guandao-version: 2.0.3`；生产 `/sb` + 假 JWT → 401 `PGRST301`
  （修复前同一请求 42501）；`/sb/auth/v1/token` 返回 `invalid_credentials`，证明 body 也透传；
  `npm run qa:prod` **35/35**，清理后 `{"users":0}`。

---

## 2026-11-21 · Round 25 · 2.0.4 Quiet Repairs（缺陷扫描第一轮）

任务原文是「寻找各部分 bug，修复，一个一个看」。按模块拆开读，只采纳能复现或用条件写证明的缺陷；
读起来可疑但没有失败证据的条目不动。

**已修 7 项**

| 编号 | 缺陷 | 证据 |
| --- | --- | --- |
| F1 | `worker/api/sync/store.js` `applyChange` 先 SELECT 再 JS 判冲突再写：两个并发 push 都判不冲突、都写同一个 revision，后写者覆盖先写者，客户端永远不产生冲突记录 | `tests/unit/sync-store.test.ts` 新增 RacingD1 + 2 用例 → 18 passed；负向对照还原旧实现 → 2 failed / 16 passed |
| F2 | `src/lib/legacy-apps/draw/index.ts` 用 `toISOString().slice(0,10)` 判断今天：东八区本地 00:00–08:00 仍算昨天，能再抽一次 | 抽出 `drawDateKey()`，新增 `tests/unit/draw-day.test.ts` 6 用例 → 6 passed |
| F3 | `src/lib/os14/index.ts` 存储告警「每天一次」同样用 UTC 日 | 改用 `todayKey()`（本地日） |
| F4 | 递归删除目录树把整棵树展开进一条 `IN (?,…)`：D1 单条语句 100 参数上限，≥ 99 节点删除 500 | 按 40 个一批分块（`FOLDER_TREE_CHUNK`）；新增 `tests/e2e/files-folders-deep.spec.ts`（120 层 → 409 → 递归 200 → 永久 200 → 404）1 passed（16.3s）；负向对照还原旧 handler → 1 failed（实际 500） |
| F5 | 配对领取 `confirmed → completed` 无条件更新且不查 `meta.changes`：两个并发轮询各签发一枚 Session | `tests/unit/pairing-claim.test.ts` 假 D1 把交错摆出来 → 2 passed；负向对照还原旧 handler → 1 failed（落败方仍 INSERT sessions）；真实 Worker `tests/e2e/pairing-claim-race.spec.ts` → 1 passed（12.9s，本机难撞窗，判别靠单测） |
| F6 | 失败备份不清理 R2：`failBackup` 只改状态，失败备份 `size_bytes` 为 NULL，孤儿对象 `storageStats` 看不见 | `failBackup` 追加按前缀分页清理；`tests/unit/backup-cleanup.test.ts` → 2 passed；负向对照还原旧 handler → 1 failed |
| F7 | 版本 9 处 + 断言族升 2.0.4 | `node scripts/check-version.mjs` → 一致；`npm run verify` exit 0 |

**查证不成立**：分页 `?limit=abc` → NaN → 500。复核 store 层已有 clamp + `||` 默认值，不成立，未改。

**已定位未修（下一轮优先）**：同步 push 配额 TOCTOU（`worker/api/sync/handlers.js:112-147`）、
文件上传配额 TOCTOU（`worker/api/files/handlers.js:294-298`）。这两条需要真正的条件写入或
事务语义，只记录位置与理由，不做无判别测试的硬改。

**门禁**：`npm run verify` **exit 0**（typecheck 0 error、`22 files / 383 tests passed`、
html-security 合计 294 处未审查 0、build 30 页、CSP 12 哈希/31 HTML）；全量
`npx playwright test` → **192 passed（4.6m），exit 0**；体积 入口 JS 434.8/439.5 KB（98.9%）、
首屏 CSS 184.7/195.3 KB（94.6%）。

**状态**：代码已提交、**未部署**（本轮没有上线指令），按规则写 Blocked，
上线路径见 `docs/RELEASE-2.0.4.md §5`。

**教训（新增）**

- D1 只保证单条语句原子；任何「SELECT 判断 → 写」在 Worker 里都是竞态，除非判断写进 WHERE。
- 「UTC 日 ≠ 用户日」不只影响抽奖：凡是「每天一次」的判定都要用本地日 helper。
- D1 单条语句 100 参数；删除整棵树这类 `IN (...)` 一律要分块，仓库已有 40 的先例。
- 批量替换版本号前先看 `package-lock.json`：这次直接 split/join 把 26 个依赖的 2.0.3
  改成了 2.0.4，靠 `git checkout` + 只替换前两处根版本才修回来。
- 负向对照不是形式主义：F1/F4/F5/F6 都是「新测试在旧代码上必须红」，否则测试只是描述实现。
- 并发 bug 的真实 E2E 可能不判别（本机撞不进窗口）：判别责任交给能控制交错的假 D1 单测，
  E2E 只证明真实栈上的行为不变量，文档里要如实分开写。
