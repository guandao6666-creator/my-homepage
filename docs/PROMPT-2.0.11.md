# Guandao OS 2.0.12 任务书（由 2.0.11 沉淀）

> 给下一轮（或另一个 AI）直接可复制的任务描述。先把「坑」写清楚，再写任务本身。

## 1. 本轮踩过的坑（硬约束）

1. **`src/lib/version.ts` 的 RELEASES 不能批量替换版本号**：把 `2.0.10` 全文替换成 `2.0.11`
   会把历史条目的 `version`/`notes` 一起改名。正确做法是：发布落点（10 个文件 + package-lock 前两处）
   用脚本替换，`version.ts` 的 RELEASES **手工插新条目**，旧条目原样保留。
2. **`package-lock.json` 只能改第 3、9 行**：第 5097 行那种 `"version": "x"` 是真实依赖版本
   （`fast-levenshtein@2.0.6` 一类）。批量替换会把依赖钉死到不存在的版本，`npm ci` 直接 EUSAGE。
   改完必须 `git diff package-lock.json` 确认只有 2 行。
3. **负向对照脚本必须是 `.mjs` 纯 JS**：不能写 TypeScript 的 `as` 断言（`SyntaxError: Unexpected identifier 'as'`）。
   必须「无参数 → REFUSED exit 2」，`patch` 前备份到 `.tmp-neg-*.bak/` 并记 SHA-256，`restore` 必须
   打印 `MATCH`/`MISMATCH` + `RESTORE_OK`。默认动作绝不允许是 `patch`。
4. **worker project 的 E2E 不需要 `astro build`**（它跑 `wrangler dev` 读源码）；**客户端/页面类 spec 需要**：
   只改 `src/` 不重建 `dist` 会让负向对照「假通过」。改了 `src/lib/**` 后先 `npx astro build` 再跑 E2E。
5. **JSDoc 参数类型会影响 TS 推断**：给 JS 函数写 `@param` 描述不了「解构参数里的字段」，
   `cursor = null` 的默认值会把参数推成 `null`，测试传对象立即 TS2322。修法：把新增的可选参数
   拆成独立形参（`listChangesPage(env, userId, domain, options, cursor)`），JSDoc 写在独立参数上。
6. **D1 没有事务，只保证单条语句原子**：任何「先查再写」都是 TOCTOU。分页/去重/名额这类
   「读—判断—写」要压进一条 SQL（条件子查询 / 条件 UPDATE / 条件 INSERT ... SELECT）。
7. **本地跑测前清 `rate_limits`**：`node scripts/clear-rate-limits.mjs run "<.wrangler\state\v3\d1\miniflare-D1DatabaseObject\*.sqlite>"`
   （plugin-upload 20 次/小时会挡夹具上传）。长跑 E2E 建议每 90 秒清一次，20 秒一次会与 D1 抢锁，
   2.0.10 曾因此出现 `device.spec.ts` 的 500 抖动。
8. **GitHub API 直连会超时**：`curl.exe --resolve api.github.com:443:140.82.113.6` + `git credential fill`
   的 password 才能查 Actions；PowerShell 5.1 不要用 `Invoke-RestMethod -SslProvider`。

## 2. 可复制的任务书

> 给 Guandao OS 发布补丁版 **2.0.12**。
>
> 起点：先 `git status` 与 `node scripts/check-version.mjs` 确认干净；阅读
> `docs/AI-BUILD-STATUS.md` §5 风险表与 `docs/RELEASE-2.0.11.md` §6 未修边界。
>
> 范围优先级：
> 1. STATUS 风险 16 的两条**需迁移**缺陷（view/package 计数幂等、社区上传配额预占）——
>    本版允许新增**一个** migration（`00xx_*.sql`），但必须写清回滚方式、在文档里说明
>    「部署时需 `wrangler d1 migrations apply --remote`」，并先 `migrations list --remote` 确认待应用数量。
> 2. 2.0.11 §6 里被判为「不改」的多区间 Range：只有在有真实客户端需求时才实现
>    multipart/byteranges，否则保持不改。
> 3. 入口体积技术债（440.5 KB / 439.5 KB）：可拆首屏非关键模块，但**不许改预算数字**来「通过」。
>
> 硬约束（与 2.0.9+ 相同）：每条有「失败复现→修复→通过」证据；负向对照真改回旧行为并给 SHA-256
> 校验；界面链路用真实 Worker Playwright（`--project=worker`）；不改公开 API 契约（必须改时
> 同步文档+测试并在发布说明单列「行为变更」）；版本 9 处同步（package-lock 只改 3/9 行）；
> 既有断言不删；临时脚本默认拒绝执行；一次最多两个子智能体且必须等收尾消息；中文注释写「为什么」；
> `npm run verify` + 全量 E2E 全绿；发布说明区分 Implemented / Verified，未部署写 Blocked。
>
> 交付：`docs/RELEASE-2.0.12.md`、`docs/PROMPT-2.0.12.md`、BACKLOG 追加 Round、STATUS 更新
> （版本 / 单测数 / E2E 数 / 体积）、LOG 追加一条。

## 3. 本轮结论对照表

| 事项 | 结论 | 证据位置 |
| --- | --- | --- |
| 备份合并恢复孤儿对象 | 已修（先判哈希，不读不写 R2） | `worker/api/backups/restore-copy.js`；`tests/unit/backup-restore-dedupe.test.ts` 8 passed |
| 插件安装上限并发 | 已修（条件 INSERT 抢名额） | `worker/api/plugins/install-slot.js`；`tests/unit/plugins-install-limit.test.ts` 5 passed（真实 SQLite） |
| 窗口关闭双通知 | 已修（`notifyClosedOnce`） | `src/lib/core/windows.ts:376`；`tests/unit/windows-close-cascade.test.ts` 7 passed |
| 窄视口级联重叠 | 已修（`settleCascade`） | `src/lib/core/layout.ts:274`；同上 |
| 同步 `since` 缺 tiebreak | 已修（新增 `cursor`/`nextCursor`） | `worker/api/sync/cursor.js`、`store.js:46`；单测 6 + E2E 2 passed |
| 多区间 Range | 不改（RFC 允许忽略，返回 200） | `docs/RELEASE-2.0.11.md` §6 |
| 计数幂等 / 上传配额预占 | 未修（需迁移） | STATUS §5 风险 16 |

## 4. 下一轮优先

1. 两条需迁移项（本轮唯一允许迁移的窗口）。
2. 入口体积：找出 `index.astro_astro_type_script_index_0_lang` 里可延迟加载的非首屏模块
   （先 `node scripts/perf-baseline.mjs --json` 看分布），目标回到 439.5 KB 以内；
   如果做不到，就把预算调整写进 RELEASE 的「行为变更 / 技术债」而不是偷偷改数字。
3. 生产侧证据缺口（STATUS §5 风险 2/3）：审核链异常分支、生产写入型发布链、真机。