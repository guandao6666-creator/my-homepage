# AI-BUILD-BACKLOG · Guandao OS 待办与优先级

> 只记录**尚未完成**的工作。已完成项在 `docs/AI-BUILD-LOG.md` 与 `docs/RELEASE-2.0.md`。
> 优先级定义与纲领一致：P0 数据/安全/认证 → P1 核心功能/一致性/备份 → P2 架构/稳定/性能 → P3 规划功能 → P4 视觉 → P5 实验。

## P0 · 数据与安全（当前无未关闭项）

| # | 任务 | 状态 | 备注 |
| --- | --- | --- | --- |
| P0-1 | 生产部署 / 生产迁移 / `qa:prod` | **`Verified`（生产，2026-11-21 · 2.0.4）**：`npm run cf:deploy` 部署 Version `78e78621-8f36-4585-87bd-a91e74ceaa3f`，`/api/health` 报 `"version":"2.0.4"`、响应头 `x-guandao-version: 2.0.4`；生产 D1 无待应用迁移（`d1 migrations list --remote` → No migrations to apply）；`npm run qa:prod` **35/35 通过**；入口包 445,610 B 含 2.0.4（2.0.1/2.0.2/2.0.3 的部署与 35/35 见历史记录） | 部署前已导出生产 D1 全量备份（654,863 B，2026-11-21） |
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

**已修 9 项**

| 编号 | 缺陷 | 证据 |
| --- | --- | --- |
| F1 | `worker/api/sync/store.js` `applyChange` 先 SELECT 再 JS 判冲突再写：两个并发 push 都判不冲突、都写同一个 revision，后写者覆盖先写者，客户端永远不产生冲突记录 | `tests/unit/sync-store.test.ts` 新增 RacingD1 + 2 用例 → 18 passed；负向对照还原旧实现 → 2 failed / 16 passed |
| F2 | `src/lib/legacy-apps/draw/index.ts` 用 `toISOString().slice(0,10)` 判断今天：东八区本地 00:00–08:00 仍算昨天，能再抽一次 | 抽出 `drawDateKey()`，新增 `tests/unit/draw-day.test.ts` 6 用例 → 6 passed |
| F3 | `src/lib/os14/index.ts` 存储告警「每天一次」同样用 UTC 日 | 改用 `todayKey()`（本地日） |
| F4 | 递归删除目录树把整棵树展开进一条 `IN (?,…)`：D1 单条语句 100 参数上限，≥ 99 节点删除 500 | 按 40 个一批分块（`FOLDER_TREE_CHUNK`）；新增 `tests/e2e/files-folders-deep.spec.ts`（120 层 → 409 → 递归 200 → 永久 200 → 404）1 passed（16.3s）；负向对照还原旧 handler → 1 failed（实际 500） |
| F5 | 配对领取 `confirmed → completed` 无条件更新且不查 `meta.changes`：两个并发轮询各签发一枚 Session | `tests/unit/pairing-claim.test.ts` 假 D1 把交错摆出来 → 2 passed；负向对照还原旧 handler → 1 failed（落败方仍 INSERT sessions）；真实 Worker `tests/e2e/pairing-claim-race.spec.ts` → 1 passed（12.9s，本机难撞窗，判别靠单测） |
| F6 | 失败备份不清理 R2：`failBackup` 只改状态，失败备份 `size_bytes` 为 NULL，孤儿对象 `storageStats` 看不见 | `failBackup` 追加按前缀分页清理；`tests/unit/backup-cleanup.test.ts` → 2 passed；负向对照还原旧 handler → 1 failed |
| F7 | 版本 9 处 + 断言族升 2.0.4 | `node scripts/check-version.mjs` → 一致；`npm run verify` exit 0 |
| F8 | 同步 push 配额 TOCTOU：`handlers.js` 预检（`userQuotaStats + estimateQuotaDelta`）与逐条 `applyChange` 之间隔着 await，两个并发 push 都能过预检，突破 5000 实体 / 2000 墓碑 | 闸门进写语句：`... AND (SELECT COUNT(*) FROM sync_entities WHERE user_id = ? AND deleted = ?) < ?`，`changes=0` 时先判 `countKind` 再判冲突，返回 `outcome:"quota"`；`tests/unit/sync-store.test.ts` 新增 2 条 → 20 passed；负向对照还原 703ef74 版 store → 2 failed |
| F9 | 文件上传配额 TOCTOU：`usage()` 预检后再 `insertPendingFile` + R2 put，两个并发上传可一起越过 5 GiB | 占位后复核：`assertReservedFileQuota()` 在 `insertPendingFile` 之后 `usage()`（含 pending）超限则删占位 + 507，此时未写 R2 故无孤儿；`tests/unit/files-quota.test.ts`（真实 SQLite）3 条 → 3 passed；负向对照 `if (false)` → 2 failed |

**查证不成立**：分页 `?limit=abc` → NaN → 500。复核 store 层已有 clamp + `||` 默认值，不成立，未改。

**已定位未修**：无。2.0.4 收口时把原先记在这里的两条配额 TOCTOU 也修了（F8/F9），证据见表；
配额判别靠真实 SQLite 单测而不是本地 E2E——5000 条实体 / 5 GiB 的量级不适合在本地夹具里造，
这是证据边界，不是缺测试。

**门禁**：`npm run verify` **exit 0**（typecheck 0 error、`25 files / 392 tests passed`、
html-security 合计 294 处未审查 0、build 30 页、CSP 12 哈希/31 HTML）；全量
`npx playwright test` → **193 passed（4.7m），exit 0**（F8/F9 落地后复跑；这两项的判别
证据仍在单测与负向对照，E2E 只做真实栈回归）；体积 入口 JS 434.8/439.5 KB（98.9%）、
首屏 CSS 184.7/195.3 KB（94.6%）。

**状态**：已部署生产（2026-11-21，Version `78e78621-8f36-4585-87bd-a91e74ceaa3f`；
health/header 2.0.4、`qa:prod` 35/35、生产 D1 无待应用迁移、部署前备份 654,863 B）。

**教训（新增）**

- D1 只保证单条语句原子；任何「SELECT 判断 → 写」在 Worker 里都是竞态，除非判断写进 WHERE。
- 「UTC 日 ≠ 用户日」不只影响抽奖：凡是「每天一次」的判定都要用本地日 helper。
- D1 单条语句 100 参数；删除整棵树这类 `IN (...)` 一律要分块，仓库已有 40 的先例。
- 批量替换版本号前先看 `package-lock.json`：这次直接 split/join 把 26 个依赖的 2.0.3
  改成了 2.0.4，靠 `git checkout` + 只替换前两处根版本才修回来。
- 负向对照不是形式主义：F1/F4/F5/F6 都是「新测试在旧代码上必须红」，否则测试只是描述实现。
- 并发 bug 的真实 E2E 可能不判别（本机撞不进窗口）：判别责任交给能控制交错的假 D1 单测，
  E2E 只证明真实栈上的行为不变量，文档里要如实分开写。
- 负向对照后的「自动恢复」不可信：临时脚本打印 restored 也可能没写回，下一次门禁红就是证据。
  改完生产代码必须用 `Select-String` 复核关键行；Windows 上连续重写同一文件还会偶发
  `ReplaceFileW EIO`，重试即可，别急着怀疑测试。

---

## 2026-11-21 · Round 26 · 2.0.5 收口（Param Budget，已部署）

| 编号 | 缺陷 | 证据 |
| --- | --- | --- |
| F10 | worker/api/community/write.js markNotifications 把最多 100 个 id 展开进一条 UPDATE ... IN (?,…)：绑定 = 
ow + user_id + N，N=99 即 101 个参数 → D1 500，客户端传 99+ 个通知 id 可打挂接口 | 上限改 200 + 按 40 分块（120 个 id → 3 条 × 42 参数）；`tests/unit/d1-params.test.ts` 假 D1 强校验 100 上限，120 id 全标记；负向对照回 2.0.4 单条 UPDATE → 1 failed（`122 > 100`） |
| F11 | worker/api/plugins/store.js marketList trending 一次取最多 200 行候选，随后 `since + 200 个 id` = 201 参数塞进一条聚合查询：市场上架 ≥99 个插件时 trending 页固定 500 | 按 40 分块查询并合并 `Map`；同文件源码约束（含 `chunkIds` 循环、不再拼一整条 `IN`、保留 100 上限注释） |
| F12 | 分块实现三份：files 的 `FOLDER_TREE_CHUNK`、sync 的 `chunkArray`、通知又写一份 | 新增 `worker/api/sql.js`（`D1_PARAM_LIMIT` / `ID_CHUNK_SIZE = 40` / `chunkIds` / `placeholdersFor` / `assertParamBudget`），files 与 sync 改为共用；`tests/unit/sync-store.test.ts` + `files-quota` + `d1-params` 3 文件 30 passed |
| F13 | 版本 9 处 + 断言族升 2.0.5 | `node scripts/check-version.mjs` → `[version] 一致：2.0.5`；`npm run verify` exit 0（`26 files / 399 tests`） |

**真实 Worker 证据（补充）**：`tests/e2e/d1-param-bounds.spec.ts` **2 passed（12.1s）**：
`PATCH /api/community/me/notifications` 带 120 个 id → 200、`data.unread` 是数字；
`GET /api/plugins?tab=trending` → 每条 `recentDownloads` 是数字。负向对照回 2.0.4 单条 UPDATE
→ **1 failed / 1 passed（12.6s）**，失败为真实 D1 `500 INTERNAL_ERROR`。

**剩余证据边界**：trending 的「候选 ≥99 行」分支仍未在真实 E2E 里造满（上传限流 20 次/小时）；
要补就先用 SQL seed 100 个插件行再请求 trending，不要靠上传接口造数据。

**门禁**：`npm run verify` **exit 0**（typecheck 0 error、`26 files / 399 tests`、
html-security 294 处 / 未审查 0、build 30 页、CSP 12 哈希 / 31 HTML；全量 E2E **195 passed（4.7m）**）；体积不变
（入口 JS 434.8/439.5 KB、首屏 CSS 184.7/195.3 KB，2.0.5 只改 Worker 端）。

**状态**：**已部署生产（2026-11-21）**：Version `1aeae3dc-e6fa-4e37-b069-b4f042c0a3e1`、
health/header 2.0.5、`qa:prod` 35/35、部署前备份 650,184 B；推送 `08db11d..afa7222` 后
Cloudflare 自动构建 `0cccf9e8-…`（13:39:58Z）。CI 状态因本机 GitHub 网络超时未复核。

**教训（新增）**

- 「已经修过同类缺陷」不等于扫干净了：2.0.4 修了深目录删除，2.0.5 又在通知与 trending 各找到一处。
  修完一处应按 `IN (…)` / `bind(…, ...ids)` 两种形态全仓扫。
- `slice(0, 100)` 加上 `now + user_id` 就是 102 个参数：边界判断必须把其它绑定算进去。
- 共用 helper 不是洁癖：三份分块实现意味着三处可能各自退回单条语句。
- 证据要分层写：能造真实 E2E 的造（深目录 120 层），造不动的（99+ 通知）就用强校验桩 + 负向对照，
  并在文档里明确「这是证据边界」。

## 2026-11-22 · Round 27 · 2.0.6 外壳取证（Shell Proof，本地已验证，未部署）

| 编号 | 缺陷 | 证据 |
| --- | --- | --- |
| F14 | 社区壁纸标题直接拼进设置页 `innerHTML`（`renderWallGallery`）：名字来自别人的作品标题，可注入 `<svg/onload>`；无哈希构建时 CSP 回退 `unsafe-inline`，构成存储型 XSS | 抽 `src/lib/os13/wall-card.ts`，`escapeAttr`（属性）+ `escapeHtml`（文本）+ `safeUrl`（预览协议）；`tests/unit/os13-wallcard.test.ts` 5 passed；`shell-wallpaper-safety` E2E 2 passed（16.0s）；负向对照回裸拼接 → 1 failed（`toHaveText` 收到 `"壁纸"`） |
| F15 | 1.x 升级布局快照写 `viewport:{width:0,height:0}`：`isSnapshot()` 认它有效 → 跳过归一化 → 比例放大 1440 倍后被 `clampRect` 压到右下，原布局丢失 | `src/lib/os20/legacy-layout.ts` + `migrations.ts` 改写真实 `innerWidth/innerHeight`；`tests/unit/legacy-layout.test.ts` 3 passed（含 120/80 → 800/480 回归） |
| F16 | 「清空本机数据」调用 `idbDel("__all__")`：按 key 删除的伪键，实际没删；且 `void` 没等事务完成就刷新，壁纸 blob 留在 IndexedDB | `idbClearAll()`（`objectStore.clear()` + 等 `oncomplete` + 关库）后再刷新；E2E 断言 IDB count 0、localStorage custom 为 `[]` |
| F17 | 网格拖拽用「左上角阈值」找目标：第一个图标在 (0,0) 恒满足，`insertBefore` 永远插到最前，`icons.order` 存错顺序 | 抽 `src/lib/os13/icons-order.ts` 的 `pickGridDrop`（中心距离 + 水平/垂直阈值）；`tests/unit/icons-order.test.ts` 6 passed |
| F18 | `applyLook()` 结尾无条件 `autoAccent = false`：选「自动」不恢复，改材质/圆角/程序坞位置也永久关闭壁纸取色 | 抽 `src/lib/os13/look.ts` 的 `resolveLookAccent`；`os20/apply.ts` 在 `accent==="auto"` 时传 `accentAuto`；`tests/unit/look-accent.test.ts` 5 passed |
| F19 | 版本 9 处 + 断言族升 2.0.6 | `node scripts/check-version.mjs` → `[version] 一致：2.0.6`；`npm run verify` exit 0（`31 files / 420 tests`） |

**证据分层**：F14 与 F16 有真实浏览器 E2E（一条注入、一条清空）；F15/F17/F18 是纯几何/状态判定，
只有单测（真实指针几何与设置面板状态在 E2E 里造不划算，已写进 RELEASE §6 的证据边界）。
2.0.6 负向对照：四模块改回旧实现 → 12 failed / 7 passed，恢复（逐文件 SHA256）后 19 passed。

**门禁**：`npm run verify` exit 0（typecheck 0 error 383 文件、31 文件 / 420 单测、
html-security 294 处 / 未审查 0、build 30 页、CSP 12 哈希 / 31 HTML）；体积不变
（434.8/439.5 KB、184.7/195.3 KB）。

**状态**：**Implemented / Verified（本地）**，生产未部署（Blocked，等上线授权）；
生产仍是 2.0.5（Version `1aeae3dc…`）。

**教训（新增）**

- 子智能体「inactive」不等于交付：`audit-worker` 两次 inactive、`audit-os14-b` 被停止后没有收尾消息，
  本轮 worker / os14 审计实际没有证据。派单后必须等到 closing message。
- 临时脚本的默认动作必须是「拒绝执行」：误跑 `node .tmp-neg-os13.mjs` 二次打补丁，
  造成重复 import 与 tsc 报错，修回来的时间比写脚本还长。
- 安全修复的负向对照要拿到「旧行为真的发生了」的可读证据（注入的 `<img>` 被当标签解析），
  不能只写「旧代码不安全」。
- `check-html-security` 只认直接被 `safeUrl`/`escapeAttr`/`escapeHtml` 包住的插值；
  三元表达式里再调用也算不出来，模板里直接包一层最省事。

---

## 2026-11-22 · Round 34 · 2.0.6 第二轮审计修复（Shell Proof 增补）

**来源**：`audit-worker-b`（Worker，7 条）与 `audit-os14-c`（社区/桌面应用，7 条）只读审计；
两者都交回了 `SCOPE:` 收尾行，这次不再是「inactive 即结束」。

**已修（补充进 2.0.6，共 6 条）**

| # | 条目 | 证据位置 |
| --- | --- | --- |
| 1 | 市场封面 `preview` 拼进 `style="…url('…')"` → CSS 声明注入 | `src/lib/os20/market-thumb.ts`；`tests/unit/market-thumb.test.ts` 4 passed |
| 2 | 评论「加载更多」不校验作品身份 → A 的评论写进 B | `detail.ts` 的 `refreshCommentsImpl`；`tests/unit/community-comments-refresh.test.ts` 2 passed |
| 3 | 发布权限接口不要求管理员 → 审核员可撤销封禁 | `worker/api/community/admin.js`；单测 6 passed、E2E `community-restriction-guard` 1 passed（11.9s） |
| 4 | 笔记/任务读取不校验字段形状 → 首页 `TypeError` | `notes-model.ts`、`tasks-model.ts`；单测 5 + 4 passed |
| 5 | 通知分页把本页条数当总数、错误面板「重试」只认 home/detail | `ui.ts pageNav(total: number \| null)`、`community.ts retry`；单测 5 + 3 passed |
| 6 | 幻灯片计时器不随灯箱关闭 → Esc 后自动弹回 | `src/lib/os13/slideshow.ts`；`community-pager.test.ts` 内 2 passed |

**未修（8 条，见 STATUS §5 风险 14）**：`deletePost` 不结算举报、`view`/下载计数可重放、
`approve` 允许 `draft`、社区上传配额 TOCTOU、`consumeReauthTicket` 消费顺序、通知接口无 `total`
（已用「第 N 页」规避）、生产审核链只读。它们会改公开计数语义或需要迁移/新预占表，
补丁版本不动。

**门禁**：`npm run verify` exit 0（38 文件 / 449 单测、html-security 294/0、build 30 页、
CSP 12 哈希 / 31 HTML）；全量 E2E **198 passed（4.7m）**。

**状态**：**Implemented / Verified（本地）**，生产未部署（Blocked，等上线授权）。

**教训（新增）**

- 夹具账号不都是 UUID：管理接口只认 UUID，真实栈造不出「审核员改同级审核员」，
  这部分矩阵只能交给假 D1 单测；写 E2E 前先看接口的 id 校验。
- 真实栈「≥99 行」的边界很难撞：用「超过 100 就抛」的假 D1 证明分块逻辑，比堆数据可靠。
- 分页文案要先看接口实际返回什么；没有 `total` 就不写数量，比编一个本页条数诚实。
- 抽纯函数是安全修复的最短路径：`marketThumbHtml`/`pickGridDrop`/`normalizePriority`/
  `createSlideshow` 都只有几十行，却让 E2E 与负向对照都能稳定复现。

**部署（2026-11-22）**：已发布 2.0.6 —— Version `835cb688-5ea2-4572-8d48-05d19947f03d`，health/header 2.0.6，`qa:prod` 35/35，备份 `guandao-db-prod-20261122-1250.sql`；回滚目标 `1aeae3dc-…`（2.0.5）。


---

## 2026-11-22 · Round 35 · 2.0.7 Review Integrity（本地完成，未部署）

**范围**：继续收口 `docs/RELEASE-2.0.6.md` §6 里不需要数据库迁移的四条，升 2.0.7。

| # | 缺陷 | 修法 | 证据 |
| --- | --- | --- | --- |
| 1 | 审核 `approve` 接受 `draft`，作者撤回的草稿可被审核员重新公开 | 新增 `worker/api/community/review-policy.js`：approve 仅 `pending_review\|rejected`、restore 仅 `hidden`、draft 明确拒绝 | 单测 8 passed（含真调 `adminReviewPost` 的行为用例）；负向对照 1 failed（旧文案「作品还没有可安装的内容包」） |
| 2 | 审核卡对 draft 也渲染「通过」按钮 | `moderation.ts` 按状态给「通过/恢复」，draft 无按钮；`community.ts` 新增 `review-restore` | 单测源码断言；负向对照 1 failed |
| 3 | 作者 `deletePost` 不结算举报，后续 `hide_post` 可把软删作品改回 `hidden` | 删除 batch 补 `UPDATE community_reports … status IN ('open','reviewing')`；`adminReviewReport` 加 deleted 守卫 | 单测 3 passed；负向对照 1 failed |
| 4 | `consumeReauthTicket` 在前置 409 检查之前消费 | 移到检查通过、真正开始删除之前 | 源码顺序断言（activeBackup < consume < markUserPendingDeletion） |

**门禁**：`npm run verify` **exit 0**（40 文件 / 460 单测、html-security 294/0、build 30 页、
CSP 12 哈希 / 31 HTML）；全量 E2E **198 passed（4.7m）**（首次 197/1，既有审核链用例按新 `review-restore` 契约改完后复跑全绿）。
`node scripts/check-version.mjs` → 2.0.7 一致。

**状态**：**Verified（本地 + 生产）**，2026-11-22 已部署 Version `a7728641…`（health/header 2.0.7、`qa:prod` 35/35、备份 `guandao-db-prod-20261122-1412.sql` 639,545 B）。

**教训（新增）**

- 非 UUID 的测试 id 会先撞 `UUID.test()` 校验层：行为用例要用真 UUID，否则测的是 404 而不是状态策略。
- 纯函数矩阵全绿 ≠ 接线正确：要有一条真的调入口函数的行为用例，再用源码断言锁 UI ↔ 服务端对应关系。
- 逻辑删除的「跨表复活」单看每个函数都正常：`deletePost` 只改三张表、`hide_post` 无条件写 `hidden`，
  合起来才让已删作品重新出现；审计要顺着状态传播链看。
- `package-lock.json` 第 5097 行的 `2.0.6` 是 `fast-levenshtein` 的依赖版本，只改第 3、9 行。

**未修（下一轮）**：`view` / `package?count=1` 计数幂等（需去重表/指纹列）、社区上传配额预占（需迁移）、
生产写入型发布链 E2E、真机浏览器。

## 2026-11-22 · Round 36 · 2.0.8 Trust Gate（校验前置 + 引导副作用）

**范围**：第二轮只读审计（`audit-worker-c` 6 条、`audit-os20-d` 9 条）中**不需要迁移、不改公开响应字段**的 6 条。
需要计数表/预占行的两条（社区 view/download 幂等、社区上传配额预占）明确不进本版。

| # | 缺陷 | 修法 | 证据 |
| --- | --- | --- | --- |
| 1 | 插件 `update`/`rollback` 不过签名信任：撤销密钥、invalid 签名、别人的密钥、被 blocked 下架都能装回来 | 抽 `assertVersionTrusted(env, version, pluginRow)`，install/update/rollback 三条路径共用；rollback 额外要求插件 published | 单测 8 passed；负向对照删掉 update 调用 → 1 failed（源码断言 3→2） |
| 2 | 通知音量 0 被 `Number(v) || 45` 回落成 45 | 新增 `notify-volume.ts`：0 与 "0" 合法，缺失/NaN/布尔才回落，钳 0–100 | 单测 4 passed |
| 3 | 引导收尾无条件写 dock.autohide=false 与 system.mode，跳过引导会关掉自动隐藏、可能把 Cloud 切回 local | 新增 `onboarding-patch.ts`：只写 `desktop.iconLabels/clockSeconds`，dock/mode 仅在用户点过时写 | 单测 7 passed（四组 touched 组合 + 源码约束） |
| 4 | 引导 Esc 不过滤输入框、`finish` 无 in-flight 守卫 | `isTypingTarget()` 忽略输入态；`finishing` 守卫防重复应用 | 同上 |
| 5 | 更新检查失败不清 `state.server`，旧版本号让「应用更新」继续可点 | 新增 `update-state.ts` 的 `canApplyUpdate(phase, server, comparison)`；失败/离线两分支清空 server | 单测 5 passed；负向对照 2 failed |
| 6 | 市场搜索只重绘列表，右侧仍画被过滤掉的旧详情 | 新增 `market-selection.ts` 的 `resolveSelection`；搜索后同时重绘 `.os20-mk-detail` | 单测 6 passed；负向对照 2 failed |

**负向对照**：`.tmp-neg-208.mjs`（无参数 `REFUSED` exit 2；`restore` 打印两行 SHA-256 `MATCH` 与 `RESTORE_OK`）
把两个文件改回旧行为后 **4 failed**，恢复后 **11 passed**。插件信任的负向对照单独做过（1 failed / 7 passed）。

**门禁**：`npm run verify` **exit 0**（版本 2.0.8、**45 文件 / 490 单测**、html-security **295 处 / 未审查 0**、
build 30 页、CSP 12 哈希 / 31 HTML）；全量 E2E 见 §4（2.0.8 未新增 E2E）。
真实 Worker E2E：新增 `tests/e2e/market-search-detail.spec.ts` **1 passed（14.4s）**；
删掉详情栏重绘块并重建 dist 后同一用例 **1 failed**（负向对照成立）。全量 E2E **199 passed（5.3m）**。
`node scripts/check-version.mjs` → 2.0.8 一致。

**状态**：**Verified（本地 + 生产）**，2026-11-22 已部署 Version `9be8e25b…`（health/header 2.0.8、`qa:prod` 35/35、备份 `guandao-db-prod-20261122-1615.sql` 648,923 B、回滚目标 `a7728641…`）。

**证据边界**：更新中心失败态与市场过滤后的详情没有真实 Worker 用例（需要拦截网络/构造失败），
判别靠纯函数 + 源码约束；「点击后界面到哪」的正常路径仍由既有 `os20.spec.ts` 覆盖。

**教训（新增）**

- 版本号批量替换前先确认 `package-lock.json` 第 3/9 行才是根版本；第 5097 行是依赖版本。
- 源码断言会被注释触发：注释里写 `autohide: false` 让「不得再传」的断言失败，措辞要避开代码片段。
- 纯函数全绿 ≠ 接线正确：界面契约用「纯函数矩阵 + 源码约束」双层，必要时再加真实渲染。
- 临时脚本默认动作必须拒绝；`restore` 必须校验 SHA-256，才能证明真的回到了旧内容。
- 新模块的 HTML sink 会让 `check:html-security` 的 count 失配：新增 1 处 outerHTML 后要把 allowlist 的
  market.ts 从 6 改为 7 并写 reason，否则 verify 红在最后一步。

**未修（下一轮）**：文件 `pending_delete` 回收路径、插件 `/api/plugins/net` 流式截断、文件 Range/HEAD、
窗口双重关闭/布局 cascade/bridge subtree、sync `since` 游标 tiebreak、插件安装上限并发、计数幂等与社区上传配额预占。
