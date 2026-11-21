# Guandao OS 下一版任务提示词（承接 2.0.3 · Silent Ballot）

这份提示词写给「拿到仓库、没有这次会话上下文」的下一轮执行者。可以直接整段复制成任务书。

---

## §1 先说上一版踩到的坑（写进硬约束，不要再犯）

1. **同源代理删请求头，要先问「上游靠不靠它认证」。**
   `/sb` 代理当初为了安全删了 `cookie` 和 `authorization`，前者对、后者错：
   Supabase 的 RLS 用 `auth.uid()` 认人，Bearer token 被删后所有登录用户都退化成 anon。
   安全审查的检查项应该是「这个头会不会泄漏本站凭据」，不是「敏感头一律删」。

2. **「读路径正常」会掩盖「写路径全挂」。**
   议会投票失败但议题列表照常显示，因为读取只要 `apikey`，写入要 `Bearer`。
   排查这类故障，先分「anon 能做什么 / authenticated 能做什么」。

3. **代理层回归要用区分性错误码，不要只断言「非 200」。**
   带无效 JWT → `PGRST301`（身份传到了，签名不对）；不带 Authorization → `42501`
   （匿名被 RLS 拒绝）。两个码恰好能区分「头被吞」和「策略拒绝」，
   这比 `expect(status).not.toBe(200)` 有用得多。

4. **复现要打真实生产代理，不要本地直连 Supabase。**
   本地直连会绕开 `/sb`，永远复现不出这个 bug。正确做法：
   `POST https://guandao.xin/sb/rest/v1/votes` + 假 JWT，看它是 42501 还是 PGRST301。

5. **E2E 只覆盖自建 API 时，第三方链路没有守门人。**
   本项目 188 条 E2E 全打 `/api/*`；Supabase（议会/树洞/社交）只在构建期被读过。
   凡是「前端直连第三方」的功能，至少要有代理层契约测试。

6. **负向对照是必须的。**
   写完回归用例，把修复临时回退一次，确认用例真的会红（2.0.3：回退后
   1 failed / 2 passed）。不做这一步，你无法证明用例守的是这个 bug。

7. **版本号 9 处源 + 4 处断言族；`check-version` 只查 4 处。**
   除了 package.json / version.ts / worker / sw.js，还有 package-lock、plugin-spec、
   community/validate、cli、registry；测试与 CI 里 os20.spec / community-qa /
   plugins-qa / quality.yml 都要同步。

8. **本机环境两个固定坑。**
   `wrangler dev` 必须把 `TEMP`/`TMP` 指到工作区内（`.wrangler/tmpdir`），
   否则 workerd 报 `CreateDirectory: miniflare-email-store 拒绝访问`；
   E2E 连跑前清本地 `rate_limits`（plugin-upload 20 次/小时），否则夹具阶段 429。

9. **文档区分 Implemented 与 Verified。**
   没有真实浏览器 + 真实 Worker 的实跑，就只能写 Implemented；生产没部署就写 Blocked。

---

## §2 任务书（可直接复制）

> 给 Guandao OS 做一个补丁版本 2.0.N（承接 2.0.3）。自行确定范围，自行写发布说明。
>
> **背景**：Astro 静态站 + Cloudflare Worker/D1/R2；第三方 Supabase 通过 `/sb` 同源
> 代理承载议会/树洞/社交三个旧应用。上一版修掉了代理吞 `Authorization` 导致
> 登录用户写入全部 42501 的故障，并补了代理层回归用例。
>
> **范围优先级**：
> 1. 先清「未验证的真实故障」：能复现的就修，修完有区分性证据；不能复现的写清假设，
>    不许写成 Verified。
> 2. 补能让 ① 成立的自动化：代理/协议层用可离线的契约测试；界面链用真实 Worker 的
>    Playwright，不许 mock 冒充端到端。
> 3. 有余力才碰性能与体验。
>
> **本轮建议优先**：
> - 树洞发帖/回复、社交名片写入的页面级证据（需要 Supabase 测试账号或可重复的登录夹具）；
> - `/sb` 代理头的契约表（哪些头保留、哪些剥离，写成测试用例而不是注释）；
> - 告警 webhook（`BACKUP_ALERT_WEBHOOK` / `DATA_ALERT_WEBHOOK`）仍缺配置，属运维阻塞。
>
> **硬约束**：
> - 不改公开 API 契约（改了同步文档 + 测试），不加数据库迁移；
> - 版本号 9 处同步（package.json、package-lock.json 的 root 两行、`src/lib/version.ts`
>   （`OS_VERSION` + RELEASES 首条）、`worker/api/version.js`、`public/sw.js`
>   （`guandao-2.0.N`）、`shared/plugin-spec.js`、`worker/api/community/validate.js`、
>   `cli/guandao.mjs`、`src/lib/core/registry.ts` 默认回退），以
>   `node scripts/check-version.mjs` 通过为准；
> - 既有断言不许删；版本号出现在测试里就一起更新，并在提交信息里说明为什么；
> - `worker/api/csp-hashes.js` 是构建产物，不许回滚；
> - 中文注释写「为什么」；不留调试插桩；临时脚本用完即删。
>
> **证据标准**：
> - 单测写明 `npx vitest run <file>` 的用例数/通过数；
> - E2E 用 `npx playwright test --project=worker <spec>`，真实浏览器 + 真实 Worker，
>   覆盖「点下去 → 界面到哪」；失败现场截图存档；
> - 涉及第三方服务时，必须打**真实生产代理**复现一次故障码，再用本地修复后同一请求
>   得到不同错误码，形成前后对照；
> - 修复类改动必须做一次负向对照（临时回退，确认用例会红）；
> - `npm run verify` 全绿；`npm run check:docs` 通过。
>
> **交付物**：
> - `docs/RELEASE-2.0.N.md`：缺陷回顾（含为什么没被测出来）、逐条改动贴关键代码与行号、
>   证据表、兼容性、部署记录；
> - `docs/PROMPT-2.0.N.md`：把本轮踩到的坑写进硬约束；
> - BACKLOG：本轮关闭/新增条目 + 证据位置 + 旧结论错在哪；
> - STATUS：版本、用例总数、E2E 通过数、入口体积、首屏 CSS、风险表；
> - LOG 追加一条 Round。
>
> **报告风格**：先结论再过程；不确定就写「未验证」，不要用推测填事实。

---

## §3 提示词要求 → 2.0.3 兑现情况

| 要求 | 2.0.3 的兑现 |
|---|---|
| 有失败证据就真修 | 生产 `42501` 复现 → 删掉一行头处理 → 生产/本地 `PGRST301` |
| 自动化能成立 | 新增 3 条代理解析用例（真实 Worker + 真实 Supabase），负向对照 1 failed |
| 不许 mock 冒充端到端 | 代理链真实上游；未给树洞/社交写 UI 级 E2E，如实写「未验证」 |
| 版本 9 处 | 全部同步，`check-version` → 2.0.3 |
| 文档区分 Implemented/Verified | RELEASE §3 列本地与线上证据；未部署时 §5 留空，部署后回填 |
| 门禁全绿 | `npm run verify` exit 0；`check-docs` 通过 |

---

## §4 下一轮该先看什么

1. **树洞 / 社交写入的页面级证据**：本轮只证明代理层；这两个应用的 UI 链路仍未验证。
2. **`/sb` 代理头契约表**：把「保留 Authorization、剥离 Cookie、保留 apikey」写成用例，
   避免下次安全加固又把身份头删掉。
3. **告警 webhook**：`BACKUP_ALERT_WEBHOOK`、`DATA_ALERT_WEBHOOK` 仍未配置，监控邮件发不出。
4. **P3-2 教程页面级 E2E**、**6.4 生产性能基线**：仍是待办，不是本轮范围。
5. **P2-6（Core Settings API）与 P3-3（真机冒烟）**：仍 Blocked，别当成能顺手做掉的小事。