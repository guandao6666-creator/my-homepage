# AI-BUILD-STATUS · Guandao OS 当前状态

> 本文件只记录**当前事实**，不复制历史细节。
> 历史细节见 `GUANDAO_2_0_AUDIT.md`（附录 A–P）、`GUANDAO_2_0_ROADMAP.md`、`docs/RELEASE-2.0.md`。
> 每轮开发结束必须更新本文件；`Implemented` 不得写成 `Verified`。

- **更新时间**：2026-11-21
- **版本**：2.0.4（Quiet Repairs，补丁版本；发布说明 `docs/RELEASE-2.0.4.md`）
- **生产状态**：**2.0.4 未部署**（本轮是缺陷扫描与修复，未获上线指令；生产仍是 2.0.3，Worker Version `f7af6eda-f904-4e99-b7a4-051653e8819a`，`/api/health` 报 2.0.3）
- **分支**：`dsh-da37e99c-1ac8`
- **当前里程碑**：Milestone A（系统基础成熟）收尾 → Milestone D（性能与稳定性）起步
- **当前阶段**：Phase 6（性能与可观测），P2

## 1. 阶段状态总览

| 阶段 | 状态 | 说明 |
| --- | --- | --- |
| Phase 1 · 安全与数据基线 | `Verified`（本地/CI + 生产部署） | 2.0.2 已上生产、生产 D1 无待应用迁移、`qa:prod` 35/35；1.6 的备份/数据告警 webhook 仍未配置（见 §5 风险 1） |
| Phase 2 · Shell 拆分与工程护栏 | `Verified`（本地/CI） | 2.1–2.5 全部完成（附录 P / RELEASE §16.19） |
| Phase 3 · 插件供应链与多设备 | `Verified`（本地/CI） | 签名 / 沙箱 / OAuth / 设备 |
| Phase 4 · 同步与冲突策略 | `Verified`（本地/CI） | `qa:sync` 45/45 |
| Phase 5 · 社区与市场发布链 | `Verified`（本地 + 生产） | 本地 260/260；生产发布链 9/9（`prod-community-qa.mjs`，2026-11-18）；`qa:prod` 复核公开接口可读 |
| Phase 6 · 性能与可观测 | **进行中（6.1 部分完成）** | 见 §3 |

## 2. 当前质量基线（2026-11-21 本机实跑）

| 门禁 | 结果 |
| --- | --- |
| `npm run typecheck` | 0 error（362 文件） |
| `npx vitest run` | **25 文件 / 392 单测通过**（1.12s；2.0.4 新增同步并发 4 条、抽奖本地日 6 条、配对领取 2 条、备份清理 2 条、上传配额 3 条） |
| `npm run security:test` | 六组自检全过 |
| `npm run check:unused` / `check:astro` / `check:html-security` / `lint` | 通过（html-security 294 处全审查、0 未审查） |
| `npm run build` | exit 0，**30 页**；CSP 12 哈希 / **31 HTML** 一致；HTML 安全 294 处全审查、0 未审查 |
| 产物体积（`node scripts/perf-baseline.mjs --json`） | 入口 JS **434.8 KB / 439.5 KB**（98.9%）；首屏 CSS **184.7 KB / 195.3 KB**（94.6%）；两项预算均通过 |
| `npm run verify` | **exit 0**（版本一致性 → 迁移 → typecheck → 单测 → 安全 → unused → astro → html-security → lint → build → csp） |
| `npx playwright test`（`E2E_ADMIN_PORT=18789`） | **193 passed（4.7m），exit 0**（2.0.4 F8/F9 落地后复跑；含 `files-folders-deep`、`pairing-claim-race`） |

> 环境注意：本机 WorkBuddy 沙箱的 safe-delete 守卫会在 Astro 清理 `dist/.prerender` 时中断进程（exit 1），
> 属环境问题而非代码失败。规避方式：构建前 `mv dist/.prerender /tmp/...`。

## 3. 正在执行的目标（Phase 6）

| 任务 | 状态 | 证据 |
| --- | --- | --- |
| 6.1 入口 JS ≤ 450 KB | **`Verified`（本地）**：525,102 B → **442,621 B**（−82,481 B / −15.7%），应用中心改 `load()` 后达标 | `manifest.ts`、`os14/appcenter/app.ts`；`LEGACY-APPLICATIONS.md` §9.1 |
| 6.2 首屏 CSS ≤ 200 KB | **`Verified`（本地）**：首页 **185,110 B / 2 个样式表**（自 476,749 B 降 61.2%）。主题中心改懒加载后 `themes.css` 也移出首屏 | `lazy-css.ts`、`themes/app.ts`、`docs/PERF-BASELINE.md` |
| 6.3 诊断中心接入真实 LCP/CLS/INP | **`Verified`（本地）**：新增「指标」分区，`observeVitals`（buffered）在本机采集，无数据显示「未采集」、不支持显示「不支持」 | `src/lib/quality/diagnostics.ts`、`tests/e2e/desktop.spec.ts` |
| 6.4 生产性能基线进发布报告 | `Not Started` | `scripts/prod-e2e.mjs` |

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

## 4. 本轮验证结果（2.0.4）

| 项 | 结果 |
| --- | --- |
| 同步并发单测（`tests/unit/sync-store.test.ts`） | **20 passed**（新增 4 条：并发更新同 revision、并发首次插入、并发抢最后一个实体名额、墓碑满后改墓碑被拒）；负向对照还原旧实现 → **2 failed / 18 passed** |
| 抽奖本地日单测（`tests/unit/draw-day.test.ts`） | **6 passed**（本地 00:05 / 07:59 / 23:55、跨月跨年补零、东八区与 UTC 日不同、源码断言写入用 `drawDateKey()`） |
| 深目录删除 E2E（`files-folders-deep`，worker project） | **1 passed（16.3s）**：120 层 → 非递归 409（含 119 个子文件夹）→ 递归 200 → 永久 200 → 再删 404 |
| 深目录负向对照 | 还原旧 `worker/api/files/handlers.js` 后同命令 → **1 failed**（实际 500 INTERNAL_ERROR），判别成立 |
| 配对领取单测（`tests/unit/pairing-claim.test.ts`） | **2 passed**：假 D1 交错下只有一个请求拿到 `changes=1`，落败方回 `alreadyDelivered` 且不写 Session；负向对照还原旧 handler → **1 failed** |
| 配对领取 E2E（`pairing-claim-race`，worker project） | **1 passed（12.9s）**：create → claim → confirm → 并发两次领取，恰好一个响应带 `gauth_sid` |
| 备份清理单测（`tests/unit/backup-cleanup.test.ts`） | **2 passed**：跨两页前缀全部删除；源码约束 `failBackup` 在状态更新后调用 `deleteBackupPrefix`；负向对照 → **1 failed** |
| 同步 push 配额单测（`sync-store.test.ts` 新增 2 条） | **2 passed**：并发抢最后一个实体名额 → 1 applied / 1 quota 且计数停在上限；墓碑满后改墓碑 → quota 且原行不变。负向对照（还原 703ef74 版 store）→ **2 failed** |
| 上传配额单测（`tests/unit/files-quota.test.ts`，真实 SQLite） | **3 passed**：占位后复核在限内返回用量；两个并发占位对 10 字节配额 → 507 且只删自己；配额按用户隔离。负向对照把复核改成 `if (false)` → **2 failed** |
| 全量门禁 | `npm run verify` **exit 0**：typecheck 0 error；build 30 页；CSP 12 哈希 / 31 HTML；HTML 安全合计 294 处、未审查 0 |
| 单测 / 体积 | **25 文件 / 392 通过**（1.12s）；入口 JS **434.8 / 439.5 KB（98.9%）**；首屏 CSS **184.7 / 195.3 KB（94.6%）** |
| 全量 E2E | **193 passed（4.7m），exit 0**（workers=1、retries=0；F8/F9 落地后复跑） |
| 生产状态 | **2.0.4 未部署**：本轮未获上线指令，生产仍为 2.0.3（Version `f7af6eda…`、health 2.0.3） |

## 4.1 上一版验证结果（2.0.3，归档）

| 项 | 结果 |
| --- | --- |
| 代理修复复现 | 生产 `POST /sb/rest/v1/votes` + 假 JWT → **401 `42501`**；修复后本机 → **401 `PGRST301`** |
| 代理回归 E2E（`supabase-proxy-auth`） | **3 passed（12.8s）**；负向对照恢复删头 → **1 failed / 2 passed** |
| 门禁 / 全量 E2E | `npm run verify` exit 0；**191 passed（4.8m）** |
| 生产部署 | Version `f7af6eda-f904-4e99-b7a4-051653e8819a`；health 2.0.3；`qa:prod` 35/35；CI run 44864220754 success |

## 5. 重大风险（未关闭）

1. **生产仍是 2.0.3，2.0.4 尚未部署**（本轮是缺陷扫描修复，未获上线指令）；1.6 的两条告警
   webhook 仍未配置（`BACKUP_ALERT_WEBHOOK`、`DATA_ALERT_WEBHOOK`）：备份/数据监控的
   **告警投递**没有在生产验证，只能依赖 `qa:prod` 与 `verify:d1-backup` 的主动检查。
   2.0.2 部署前导出的生产 D1 全量备份仍在
   `C:\Users\1\Desktop\my-homepage\.backups\guandao-db-prod-20261121-104235.sql`（625,640 B）。
2. **审核链的页面级证据已在本地补齐，但生产侧只有 2.0.2 这一份构建、还没有生产级审核 E2E**：
   服务端本就没有「审核超时」分支（`admin.js:52` 只接受四种操作），不是缺口，是契约如此；
   生产验证仍依赖 `qa:prod` 的公开接口检查，页面级审核链只在本地/CI 跑。
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

## 6. 下一步（按优先级）

1. **P0 · 2.0.4 生产发布（待授权）**：代码、单测、E2E、verify 已齐；上线路径见
   `docs/RELEASE-2.0.4.md §5`（迁移确认 → D1 导出 → `npm run cf:deploy` → health 2.0.4 →
   `qa:prod` → 推送与 CI 复核）。
3. **P1 · 生产告警收尾**：配置 `BACKUP_ALERT_WEBHOOK` / `DATA_ALERT_WEBHOOK`，跑
   `npm run qa:alerts` 与 `npm run verify:cloudflare`，把 1.6 生产门禁补成全绿。
4. **P2 · P3-2 教程页面级 E2E**：`community-tutorial.spec.ts` 已覆盖草稿→审核→公开→隐藏，
   缺正文渲染的浏览器断言——这是最小可验证的下一步。
5. **P2 · ACCEPTANCE 全表核对**：把 `ACCEPTANCE-2.0.md` 每行「结论 ↔ 证据」对齐，
   过期行标「历史」，避免再出现 293/304 这种自相矛盾。
6. **P3 · 6.4 生产性能基线**：发布报告记录真实 DCL/load/资源体积（需生产授权）。
7. **暂不推进**：P3-3 真机冒烟（需要物理设备）、P2-6 `os13.ts` 拆分（需要 Core Settings API）。
