# AI-BUILD-STATUS · Guandao OS 当前状态

> 本文件只记录**当前事实**，不复制历史细节。
> 历史细节见 `GUANDAO_2_0_AUDIT.md`（附录 A–P）、`GUANDAO_2_0_ROADMAP.md`、`docs/RELEASE-2.0.md`。
> 每轮开发结束必须更新本文件；`Implemented` 不得写成 `Verified`。

- **更新时间**：2026-11-22
- **版本**：2.0.6（Shell Proof，补丁版本；发布说明 `docs/RELEASE-2.0.6.md`）
- **生产状态**：**2.0.6 已部署（2026-11-22）**，Version `835cb688-5ea2-4572-8d48-05d19947f03d`；health/header 2.0.6、`qa:prod` 35/35、部署前备份 `guandao-db-prod-20261122-1250.sql`、生产 D1 无待应用迁移
- **分支**：`dsh-da37e99c-1ac8`
- **当前里程碑**：Milestone A（系统基础成熟）收尾 → Milestone D（性能与稳定性）起步
- **当前阶段**：Phase 6（性能与可观测），P2

## 1. 阶段状态总览

| 阶段 | 状态 | 说明 |
| --- | --- | --- |
| Phase 1 · 安全与数据基线 | `Verified`（本地/CI + 生产部署） | 2.0.4 已上生产、生产 D1 无待应用迁移、`qa:prod` 35/35；1.6 的备份/数据告警 webhook 仍未配置（见 §5 风险 1） |
| Phase 2 · Shell 拆分与工程护栏 | `Verified`（本地/CI） | 2.1–2.5 全部完成（附录 P / RELEASE §16.19） |
| Phase 3 · 插件供应链与多设备 | `Verified`（本地/CI） | 签名 / 沙箱 / OAuth / 设备 |
| Phase 4 · 同步与冲突策略 | `Verified`（本地/CI） | `qa:sync` 45/45 |
| Phase 5 · 社区与市场发布链 | `Verified`（本地 + 生产只读） | 本地 260/260；生产发布链 9/9（`prod-community-qa.mjs`，2026-11-18）；2.0.4 `qa:prod` 35/35 复核公开接口；教程页面级 E2E 2 passed（17.3s） |
| Phase 6 · 性能与可观测 | `Verified`（6.1–6.4） | 6.4 已进生产基线（`docs/perf-measurements-prod.json`）；见 §3 |

## 2. 当前质量基线（2026-11-22 本机实跑）

| 门禁 | 结果 |
| --- | --- |
| `npm run typecheck` | 0 error（383 文件） |
| `npx vitest run` | **38 文件 / 449 单测通过**（2.0.6 新增外壳纯函数 19 条、插件市场 2 条、第二轮审计 29 条；2.0.5 新增 D1 参数预算 7 条） |
| `npm run security:test` | 六组自检全过 |
| `npm run check:unused` / `check:astro` / `check:html-security` / `lint` | 通过（html-security 294 处全审查、0 未审查） |
| `npm run build` | exit 0，**30 页**；CSP 12 哈希 / **31 HTML** 一致；HTML 安全 294 处全审查、0 未审查 |
| 产物体积（`node scripts/perf-baseline.mjs --json`） | 入口 JS **434.8 KB / 439.5 KB**（98.9%）；首屏 CSS **184.7 KB / 195.3 KB**（94.6%）；2.0.6 只改前端逻辑，体积不变 |
| `npm run verify` | **exit 0**（版本一致性 → 迁移 → typecheck → 单测 → 安全 → unused → astro → html-security → lint → build → csp） |
| `npx playwright test`（`E2E_ADMIN_PORT=18789`） | **198 passed（4.7m），exit 0**（含新增 `shell-wallpaper-safety` 2 条与 `community-restriction-guard` 1 条） |
| 生产（2.0.5 现状） | Version `1aeae3dc-e6fa-4e37-b069-b4f042c0a3e1`；health/header 2.0.5；入口 `9IE3LdKR.js` 446,165 B；`qa:prod` **35/35**；自动构建 `0cccf9e8…` |

> 环境注意：本机 WorkBuddy 沙箱的 safe-delete 守卫会在 Astro 清理 `dist/.prerender` 时中断进程（exit 1），
> 属环境问题而非代码失败。规避方式：构建前 `mv dist/.prerender /tmp/...`。

## 3. 正在执行的目标（Phase 6）

| 任务 | 状态 | 证据 |
| --- | --- | --- |
| 6.1 入口 JS ≤ 450 KB | **`Verified`（本地）**：525,102 B → **445,235 B**（2.0.4 实测 434.8 KB，-15.2%），应用中心改 `load()` 后达标 | `manifest.ts`、`os14/appcenter/app.ts`；`LEGACY-APPLICATIONS.md` §9.1 |
| 6.2 首屏 CSS ≤ 200 KB | **`Verified`（本地）**：首页 **189,133 B / 2 个样式表**（自 476,749 B 降 60.3%）。主题中心改懒加载后 `themes.css` 也移出首屏 | `lazy-css.ts`、`themes/app.ts`、`docs/PERF-BASELINE.md` |
| 6.3 诊断中心接入真实 LCP/CLS/INP | **`Verified`（本地）**：新增「指标」分区，`observeVitals`（buffered）在本机采集，无数据显示「未采集」、不支持显示「不支持」 | `src/lib/quality/diagnostics.ts`、`tests/e2e/desktop.spec.ts` |
| 6.4 生产性能基线进发布报告 | **`Verified`（生产，2026-11-21）**：`npm run perf:prod` 冷启动 #1 TTFB 211 / FCP 476 / LCP 792 / CLS 0.003 / DCL 664 / Load 764 ms，25 资源 481 KB；数据在 `docs/perf-measurements-prod.json`，报告 `docs/RELEASE-2.0.4.md §3` | `scripts/measure-perf.mjs`（顺带修正写死的「1.9」标题） |

### 3.1 入口包剩余体积归因（sourcemap 实测，2026-11-18）

入口 chunk 生成字符 445,777：

| 模块 | 占比 | 是否启动必需 |
| --- | ---: | --- |
| `index.astro` 内联脚本（外壳/设置面板） | 15.8% | 是（settings 未迁移） |
| `os13.ts`（1.3 桌面层闭包，2,397 行） | 10.4% | 是，且紧耦合，暂不硬拆 |
| `os14/widgetstore.ts` | 6.6% | 组件规格启动必需；画廊可拆 |
| `os14/catalog.ts` | 4.5% | `META_BY_ID` 启动必需 |
| `plugins/host.ts` + `registry.ts` | 7.7% | 是（安全关键，不动） |
| `account/client.ts` | 3.3% | 是 |

结论：在不重写窗口系统、不硬拆 `os13` 闭包的前提下，6.1 的可行剩余空间约 15–25 KB
（appcenter/workspaces 的 app UI 走 `load()`、widgetstore 画廊拆分）。
要达到 450 KB 需同时处理 6.2 或引入 Settings Service。

## 4. 本轮验证结果（2.0.5 → 2.0.6）

| 项 | 结果 |
| --- | --- |
| 壁纸卡片转义单测（`tests/unit/os13-wallcard.test.ts`，2.0.6） | **5 passed**：标签/引号/id 属性转义、blob 放行、`javascript:` 挡掉、状态位 |
| 拖拽落点单测（`tests/unit/icons-order.test.ts`，2.0.6） | **6 passed**：空列表、左侧、右侧、下方、两图标之间、同列上下 |
| 强调色单测（`tests/unit/look-accent.test.ts`，2.0.6） | **5 passed**：auto 恢复、hex 接受、非法值忽略、只给 accent2 |
| 布局快照单测（`tests/unit/legacy-layout.test.ts`，2.0.6） | **3 passed**：不写 viewport/schemaVersion；旧 0×0 快照把 120/80 压成 800/480 的回归证据 |
| 2.0.6 负向对照 | 临时脚本把四模块改回旧实现 → 同命令 **12 failed / 7 passed**；恢复（4 个 SHA256_MATCH）后 19 passed |
| 生产部署（2.0.6，2026-11-22） | `npm run cf:deploy` exit 0 → Version `835cb688-5ea2-4572-8d48-05d19947f03d`；`/api/health` 2.0.6、header 2.0.6、入口 bundle 含 2.0.6；`npm run qa:prod` **35/35**、清理后 `users=0`；备份 `guandao-db-prod-20261122-1250.sql` |
| 壁纸安全 E2E（`tests/e2e/shell-wallpaper-safety.spec.ts`，2.0.6） | **2 passed（16.0s）**：恶意标题不执行、`.wc-name` 保留原文；清空后 IndexedDB count 0、localStorage custom 为 `[]` |
| 壁纸安全 E2E 负向对照 | 换回 2.0.5 裸拼接 → **1 failed**，`toHaveText` 收到 `"壁纸"`（注入的 `<img>` 被解析） |
| 插件市场分块单测（`tests/unit/plugins-market.test.ts`，2.0.6） | **2 passed**：120 候选 → 12 条、绑定全部 ≤100、聚合查询 3 次（块 40/40/40）；负向对照 1 failed（`121 > 100`） |
| 全量门禁（2.0.6 复跑） | `npm run verify` **exit 0**：`[version] 一致：2.0.6`；typecheck 0 error（383 文件）；build 30 页；CSP 12 哈希 / 31 HTML；HTML 安全 294 处、未审查 0 |
| 单测 / 体积 | **38 文件 / 449 通过**；入口 JS **434.8 / 439.5 KB（98.9%）**；首屏 CSS **184.7 / 195.3 KB（94.6%）** |
| 全量 E2E（2.0.6） | **198 passed（4.7m），exit 0**（workers=1、retries=0；比 2.0.5 多 3 条：`shell-wallpaper-safety` 2 + `community-restriction-guard` 1） |
| D1 参数预算单测（`tests/unit/d1-params.test.ts`，2.0.5） | **7 passed**：chunkIds/占位符边界、通知 120 个 id → 3 条 UPDATE 各 42 参数且全部标记、旧形态负向对照抛 `D1 绑定参数超限：101 > 100`、trending 源码约束 |
| D1 参数预算负向对照 | `git stash push -- worker/api/community/write.js`（回 2.0.4 单条 UPDATE）→ **1 failed / 6 passed**，失败为 `D1 绑定参数超限：122 > 100`；恢复后 7 passed |
| D1 参数上限真实 Worker E2E（`tests/e2e/d1-param-bounds.spec.ts`，2.0.5） | **2 passed（12.1s）**：通知 120 个 id → 200；trending 每条 `recentDownloads` 是数字 |
| D1 参数上限 E2E 负向对照 | 回 2.0.4 单条 UPDATE → **1 failed / 1 passed（12.6s）**，失败为真实 D1 `500 INTERNAL_ERROR`；恢复后 2 passed |
| 同步并发单测（`tests/unit/sync-store.test.ts`） | **20 passed**（新增 4 条：并发更新同 revision、并发首次插入、并发抢最后一个实体名额、墓碑满后改墓碑被拒）；负向对照还原旧实现 → **2 failed / 18 passed** |
| 抽奖本地日单测（`tests/unit/draw-day.test.ts`） | **6 passed**（本地 00:05 / 07:59 / 23:55、跨月跨年补零、东八区与 UTC 日不同、源码断言写入用 `drawDateKey()`） |
| 深目录删除 E2E（`files-folders-deep`，worker project） | **1 passed（16.3s）**：120 层 → 非递归 409（含 119 个子文件夹）→ 递归 200 → 永久 200 → 再删 404 |
| 深目录负向对照 | 还原旧 `worker/api/files/handlers.js` 后同命令 → **1 failed**（实际 500 INTERNAL_ERROR），判别成立 |
| 配对领取单测（`tests/unit/pairing-claim.test.ts`） | **2 passed**：假 D1 交错下只有一个请求拿到 `changes=1`，落败方回 `alreadyDelivered` 且不写 Session；负向对照还原旧 handler → **1 failed** |
| 配对领取 E2E（`pairing-claim-race`，worker project） | **1 passed（12.9s）**：create → claim → confirm → 并发两次领取，恰好一个响应带 `gauth_sid` |
| 市场封面单测（`tests/unit/market-thumb.test.ts`，2.0.6 第二批） | **4 passed**：http 出 `<img>`、`data:image` 放行、`javascript:` 返回空串、注入载荷无 `style=` 且属性值无裸引号 |
| 评论刷新单测（`tests/unit/community-comments-refresh.test.ts`） | **2 passed**：同作品写入；切到别的作品后不写 B 的面板 |
| 发布权限单测（`tests/unit/community-restriction-guard.test.ts`） | **6 passed**：审核员封禁/解封 403、同级审核员 403、改自己 400 不写库、管理员放行、审核员下调允许 |
| 发布权限 E2E（`tests/e2e/community-restriction-guard.spec.ts`，worker project） | **1 passed（11.9s）**：管理员封禁 creator → 被封用户发作品 403 → 解封 → 恢复 200；developer 调管理接口 403 |
| 笔记/任务/重试/分页单测 | **17 passed**：notes-model 5、tasks-priority 4、community-retry 3、community-pager 5（含幻灯片 start/stop） |
| 备份清理单测（`tests/unit/backup-cleanup.test.ts`） | **2 passed**：跨两页前缀全部删除；源码约束 `failBackup` 在状态更新后调用 `deleteBackupPrefix`；负向对照 → **1 failed** |
| 同步 push 配额单测（`sync-store.test.ts` 新增 2 条） | **2 passed**：并发抢最后一个实体名额 → 1 applied / 1 quota 且计数停在上限；墓碑满后改墓碑 → quota 且原行不变。负向对照（还原 703ef74 版 store）→ **2 failed** |
| 上传配额单测（`tests/unit/files-quota.test.ts`，真实 SQLite） | **3 passed**：占位后复核在限内返回用量；两个并发占位对 10 字节配额 → 507 且只删自己；配额按用户隔离。负向对照把复核改成 `if (false)` → **2 failed** |
| 全量门禁（2.0.5 复跑） | `npm run verify` **exit 0**：`[version] 一致：2.0.5`；typecheck 0 error；build 30 页；CSP 12 哈希 / 31 HTML；HTML 安全合计 294 处、未审查 0 |
| 单测 / 体积 | **26 文件 / 399 通过**（2.0.5 复跑）；入口 JS **434.8 / 439.5 KB（98.9%）**；首屏 CSS **184.7 / 195.3 KB（94.6%）**（体积未变，2.0.5 只改 Worker 端） |
| 全量 E2E | **195 passed（4.7m），exit 0**（workers=1、retries=0；含新增 `d1-param-bounds` 2 条与教程页面级断言） |
| 生产状态 | **2.0.6 已部署**：Version `835cb688-5ea2-4572-8d48-05d19947f03d`；health/header 2.0.6；`qa:prod` 35/35；部署前备份 `guandao-db-prod-20261122-1250.sql`；入口 bundle 含 `2.0.6`；CI run 44987397901 success；推送后自动构建 `ff33065b-…`（05:00:16Z）；回滚目标 `1aeae3dc-…`（2.0.5） |
| 生产状态（上一版 2.0.5，归档） | Version `1aeae3dc-…`；health/header 2.0.5；推送后自动构建 `0cccf9e8-…`（13:39:58Z） |
| 生产状态（上一版 2.0.4，归档） | Version `78e78621…`；health 2.0.4；`npm run perf:prod` 冷启动 #1 TTFB 211 / FCP 476 / LCP 792 / CLS 0.003 / DCL 664 / Load 764 ms（25 资源 481 KB） |

## 4.1 上一版验证结果（2.0.3，归档）

| 项 | 结果 |
| --- | --- |
| 代理修复复现 | 生产 `POST /sb/rest/v1/votes` + 假 JWT → **401 `42501`**；修复后本机 → **401 `PGRST301`** |
| 代理回归 E2E（`supabase-proxy-auth`） | **3 passed（12.8s）**；负向对照恢复删头 → **1 failed / 2 passed** |
| 门禁 / 全量 E2E | `npm run verify` exit 0；**191 passed（4.8m）** |
| 生产部署 | Version `f7af6eda-f904-4e99-b7a4-051653e8819a`；health 2.0.3；`qa:prod` 35/35；CI run 44864220754 success |

## 5. 重大风险（未关闭）

1. **生产已上 2.0.5（2026-11-21）**，但 1.6 的两条告警 webhook 仍未配置
   （`BACKUP_ALERT_WEBHOOK`、`DATA_ALERT_WEBHOOK`）：备份/数据监控的
   **告警投递**没有在生产验证，只能依赖 `qa:prod` 与 `verify:d1-backup` 的主动检查。
   最近的生产 D1 备份：`C:\Users\1\Desktop\my-homepage\.backups\guandao-db-prod-20261121-213900.sql`（650,184 B）。
2. **审核链的页面级证据已在本地补齐（4 条用例），生产侧只有公开接口与只读冒烟**：
   服务端本就没有「审核超时」分支（`admin.js:52` 只接受四种操作），不是缺口，是契约如此；
   生产验证仍依赖 `qa:prod`，页面级审核链只在本地/CI 跑。
3. **`os13.ts` 巨型闭包**（2,397 行）：壁纸/图标/Dock/控制中心/设置面板共用一份 cfg，
   是入口体积与可维护性的主要结构性债务，需 Core Settings API 才能干净拆分。
4. 本地并发跑 Playwright 与 verify 会共享 `.wrangler/state` 本地 D1，互相干扰。
5. **CSP 哈希与 dist 必须一起更新**：改动内联脚本后 `wrangler/api/csp-hashes.js` 会变；
   若只重建 dist 却回滚该文件，页面会被 CSP 拦掉、`window.GOS20` 不出现，E2E 大面积超时
   （2026-11-18 复现两次）。
6. 仓库中的 `src/**` 存在 CRLF/LF 抖动：构建/格式化后会显示为已修改，`git checkout` 即恢复，
   不要误提交。
7. **本地 E2E 会被自己的限流卡住**：`plugin-upload` 规则 20 次/小时，e2e-server 造夹具
   每轮就要上传约 20 个签名包，同一小时内连跑两三遍全量就会 `429 RATE_LIMITED`；
   且 `wrangler d1 execute --local` 在本机因 `miniflare-email-store` 目录权限起不来，
   只能用 Node 26 的 `node:sqlite` 直连 `.wrangler/state/v3/d1/**/*.sqlite` 清
   `rate_limits`。连跑前先清计数器，否则报错会被误读成产品回归。
8. **已关闭（2.0.2）**：
   - 原风险 4「页面级插件安装未并入 Playwright」——`plugin-publishing.spec.ts:375-431`
     一直在跑真实桌面安装链路，2.0.2 实跑复核（全量 188 passed），结论作废。
   - 原风险 9「`sandbox-origin` 偶发」——真因是取帧抢跑，已改为按 name 轮询；
     `--repeat-each=3` 3 passed。
9. **已关闭（2.0.3）**：`/sb` 同源代理把 `Authorization` 一起删掉，Supabase 只看到
   anon，议会投票、树洞发帖、社交名片写入全部 42501。修复为「只剥离本站 Cookie、
   保留 Bearer token」，并新增代理层回归用例（PGRST301 vs 42501 的区分性断言）。
10. **已修（2.0.4）**：
    - 同步 `applyChange` 读—判—写竞态：并发 push 会拿到同一个 revision 后互相覆盖，
      客户端永远不产生冲突记录。改为条件 `UPDATE/INSERT` + `meta.changes` 判定，
      单测 18 passed、负向对照 2 failed。
    - 抽奖与「存储告警每天一次」用 UTC 日：东八区本地 00:00–08:00 仍算昨天。已改本地日。
    - 目录树递归删除/永久删除把整棵树展开进 `IN (?,…)`：≥ 99 节点直接 500。已按 40 个
      一批分块；真实 Worker E2E 120 层通过，旧实现负向对照 500。
    - 配对领取 `confirmed → completed` 无条件更新：并发轮询会各签发一枚 Session。改为
      条件更新 + `meta.changes` 判定；确定性单测 2 passed、负向对照 1 failed，真实 Worker
      并发 E2E 1 passed（本机难撞窗，判别旧实现靠单测）。
    - 失败备份不清理 R2：`failBackup` 只改状态，孤儿对象 `storageStats` 看不见。改为按前缀
      分页清理；单测 2 passed、负向对照 1 failed。
    - 同步 push 配额 TOCTOU：预检与逐条写之间隔着 await，两个并发 push 都能过预检。
      改为写语句内条件子查询（`... AND (SELECT COUNT(*) ...) < ?`）+ `outcome:"quota"`；
      单测 2 passed、负向对照 2 failed。409 仍是 `QUOTA_EXCEEDED` + `{scope,current,limit}`；
      一批里已写入的条目不回滚，客户端重推会以 conflict 收敛。
    - 文件上传配额 TOCTOU：`usage()` 预检后再写 R2，两个并发上传可一起越过 5 GiB。
      改为占位后复核（`assertReservedFileQuota`，超限删占位 + 507、未写 R2 故无孤儿对象）；
      真实 SQLite 单测 3 passed、负向对照 2 failed。
11. **已关闭（2.0.4）**：原风险 11 的两条配额 TOCTOU 已按「写语句内条件子查询 / 先占位再复核」
    修掉，证据见上方风险 10 与 `docs/RELEASE-2.0.4.md §2.7/§2.8`。剩余证据边界如实记录：
    配额判别靠真实 SQLite 单测而非 E2E（5000 条 / 5 GiB 量级不适合本地造）。
12. **已修（2.0.5，已部署 2026-11-21）**：
    - 通知「标记已读」把最多 100 个 id 展开进一条 UPDATE，绑定 = `now + user_id + N`，
      N=99 即 101 个 → D1 500。改为一次最多 200 个 id、按 40 分块写（120 个 id → 3 条 × 42 参数）。
    - 插件市场 trending 把最多 200 行候选塞进一条 `IN`，`since + 200 个 id` = 201 个参数 →
      市场上架 ≥99 个插件时页面固定 500。改为按 40 分块聚合后合并 Map。
    - 新增 `worker/api/sql.js`（`D1_PARAM_LIMIT = 100` / `ID_CHUNK_SIZE = 40` / `chunkIds` /
      `placeholdersFor` / `assertParamBudget`），files 与 sync 的本地分块实现一并收编，避免三份逻辑漂移。
    - 判别证据：假 D1 在 `bind()` 强校验 100 上限，`tests/unit/d1-params.test.ts` 7 passed；
      旧实现负向对照 1 failed（`122 > 100`）；真实 Worker E2E `d1-param-bounds` 2 passed（12.1s），旧实现负向对照 1 failed（真实 D1 500）。证据边界：trending 的「候选 ≥99 行」分支仍未在真实 E2E 造满。

13. **已修（2.0.6，本地未部署）**：
    - 社区壁纸标题未转义：名字来自别人的作品标题（`community/install.ts` → `importWallpaperFromBlob`），
      直接拼进设置页 `title/alt/文本` 即存储型 XSS。已抽 `wall-card.ts` 纯函数并
      `escapeAttr`/`escapeHtml` 双上下文转义；单测 5 passed、E2E 2 passed、负向对照 1 failed
      （旧实现把注入的 `<img>` 当标签解析）。
    - 1.x 升级布局快照写 `0×0`：`isSnapshot()` 认它有效 → 跳过归一化 → 比例放大 1440 倍后夹到右下。
      已改为写真实 `innerWidth/innerHeight`，旧形状快照仍可读（`legacyLayoutSnapshot`）；单测 3 passed。
    - 「清空本机数据」删的是不存在的伪键 `"__all__"`，且刷新不等事务完成：壁纸 blob 留在 IndexedDB。
      已改为 `idbClearAll()`（`clear()` + 等 `oncomplete` + 关库）后再刷新；E2E 断言 IDB count 0。
    - 网格拖拽用左上角阈值判定，第一个图标恒命中 → 永远插到最前。已抽 `pickGridDrop`
      按中心距离 + 水平/垂直阈值选落点；单测 6 passed。
    - `applyLook()` 无条件关闭壁纸取色：选「自动」无法恢复，改材质/圆角也会误关。已抽
      `resolveLookAccent`，只有显式 hex 才关闭联动；单测 5 passed。
    - 第二轮子智能体审计（`audit-worker-b` 7 条、`audit-os14-c` 7 条）又修复五条：
      市场封面 `preview` 拼进 `style="…url('…')"` 的 CSS 声明注入（改 `marketThumbHtml` +
      `safeUrl`/`escapeAttr`，单测 4）；评论「加载更多」不校验作品身份导致串台（请求时记
      `postId`、回来再比对，单测 2）；发布权限接口不要求管理员、审核员可撤销封禁（补角色
      对等，单测 6、真实 Worker E2E 1 passed 11.9s）；笔记/任务读取不校验字段形状（新增
      `notes-model.ts` / `tasks-model.ts` 归一化，单测 9）；错误面板「重试」只认 home/detail、
      通知分页把本页条数当总数、幻灯片计时器不随灯箱关闭（`pageNav` total 可为 null、
      按 `view.kind` 分派、`createSlideshow`，单测 8）。
    - 证据边界：布局/拖拽/强调色与第二批的归一化/分页只有单测；审核员的「同级审核员」矩阵
      只在假 D1 单测里（真实夹具只有 creator 是 UUID）。
14. **未修（2.0.6 记录，下一轮候选）**：第二轮审计仍有 8 条没动，原因是会改公开计数语义、
    需要新增预占表/迁移，或超出「补丁版本不加迁移」的约束：
    - `deletePost` 不结算关联举报，后续 `hide_post` 可能把软删作品改回 `hidden`；
    - `POST /posts/:id/view` 无鉴权/无去重，可重放刷 `view_count` 与 `community_view_daily`；
    - `GET /posts/:id/package?count=1` 在 GET 里自增下载量，无鉴权无幂等；
    - 审核 `approve` 允许 `draft`（`restore` 还跳过状态校验），可把作者撤回的草稿重新公开；
    - 社区图片上传配额先查后写，无预占行，并发可破 `max_user_storage_bytes`；
    - `consumeReauthTicket` 在 `activeDeletion/activeExport/activeBackup` 前置检查之前消费，
      409 时票据已作废；
    - 通知接口没有 `total`（分页只标「第 N 页」，不再编数量）；
    - 生产侧的审核链仍只有 `qa:prod` 的公开接口与只读冒烟。

## 6. 下一步（按优先级）

1. **P1 · 2.0.6 已发布**（2026-11-22）：Version `835cb688…`、health/header 2.0.6、`qa:prod`
   35/35、备份 `guandao-db-prod-20261122-1250.sql`；下一步是 push 后复核 CI 与自动构建。
2. **P1 · 生产告警收尾**：配置 `BACKUP_ALERT_WEBHOOK` / `DATA_ALERT_WEBHOOK`（需要用户提供两个
   webhook URL，不能臆造），跑 `npm run qa:alerts` 与 `npm run verify:cloudflare`，把 1.6 生产门禁补成全绿。
3. **P2 · 补 2.0.6 的证据边界**：布局/拖拽/强调色、笔记/任务归一化、分页/重试补真实浏览器 E2E；
   审核员的同级审核员矩阵若要进真实栈，需要给夹具账号补 UUID（会牵动 e2e-server 的 USER_IDS）。
4. **P2 · 处理未修的 8 条**（见 §5 风险 14）：计数幂等与 `draft→approve` 需要先定产品语义；
   社区上传预占与 reauth 票据顺序需要迁移或调整鉴权顺序。
5. **P2 · 补 2.0.5 的剩余证据**：trending 的「候选 ≥99 行」分支用 SQL seed 100 个插件行再做真实
   Worker 断言（不要走上传接口，会被限流）；CI 状态等 GitHub 网络恢复后复核。
6. **P2 · ACCEPTANCE 全表核对（已完成 2.0.4）**：后续新增证据时同步该表。
7. **P3 · 生产写入型发布链**：`qa:prod` 只覆盖公开接口与只读链路；生产资源创建→审核→安装需隔离账号，未安排。
8. **暂不推进**：P3-3 真机冒烟（需要物理设备）、P2-6 `os13.ts` 拆分（需要 Core Settings API）。


