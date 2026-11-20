# Guandao OS 2.0.1 · 发布提示词（可复用模板）

这份文件回答「2.0.1 是被什么指令推进出来的」。它不是任务书，而是**给下一个模型/下一个自己**
可直接粘贴的提示词模板：范围怎么定、什么算证据、哪些红线不能踩。
复制 §2 的代码块即可开始一轮补丁版本发布。

---

## 1. 为什么要有这份提示词

2.0.0 的发布文档很完整，但它是「一次性报告」：18 项交付物、审计、架构图，写完就冻结了。
2.0.1 暴露出的问题是另一种——**缺陷被修过，却没人证明它真的好了**：

- BACKLOG 里 P1-8 停在 `Partially Verified`，理由写的是「根因收窄到竞态」；
- 真实根因其实是 `closest("[data-page]")` 命中了根元素；
- 修复随主线进来了，但没有一条测试会在它回归时报警。

所以 2.0.1 的提示词重心不是「加功能」，而是**把含糊状态收敛成有证据的状态**。
这套写法同样适用于 2.0.2、2.0.3。

---

## 2. 提示词正文（可直接复制）

```text
给 Guandao OS 做一次补丁版本发布，版本号 2.0.<N>。自行确定范围、自行写发布说明。

【背景】
- 仓库是 Astro 静态站 + Cloudflare Worker/D1/R2 的「网页操作系统」（Guandao OS）。
- 上一版发布文档在 docs/RELEASE-2.0.0.md，当前状态在 docs/AI-BUILD-STATUS.md，
  未关闭事项在 docs/AI-BUILD-BACKLOG.md，历史在 docs/AI-BUILD-LOG.md。
- 工作区可能有别人未提交的改动，动手前先 git status 看清楚，不要覆盖。

【范围（按优先级取，取完为止）】
1. 把 BACKLOG 里所有「Partially Verified / Implemented / 疑为竞态」的条目，逐条变成
   「要么有失败证据必须真修，要么有通过证据必须关掉」。不允许继续留在中间态。
2. 补上让 1 能成立的自动化测试：能写成纯函数单测的抽成纯函数，界面链路用 Playwright
   在真实 Worker 上跑，不用 mock 冒充端到端。
3. 只有做完 1、2 还有余力，才碰性能和体验项。

【硬约束】
- 不改公开 API 契约（除非同步改文档与测试）；不加数据库迁移（补丁版本不做 schema 变更）。
- 版本号必须同时改到 package.json、package-lock.json、src/lib/version.ts（含 RELEASES 条目）、
  worker/api/version.js、public/sw.js、shared/plugin-spec.js、
  worker/api/community/validate.js、cli/guandao.mjs、src/lib/core/registry.ts 的默认回退值，
  以 `node scripts/check-version.mjs` 通过为准。
- 既有断言不许「顺手删」：版本号出现在测试里就一起更新，语义变了要写清楚为什么变。
- 构建会重写 worker/api/csp-hashes.js，这是正常产物，不要回滚它。
- 中文注释写「为什么」，不写「做了什么」；不留下调试插桩。

【证据标准（写进发布文档时要能对上）】
- 单测：`npx vitest run <file>` 的用例数与通过数，不写「应该通过」。
- E2E：真实浏览器 + 真实 Worker（`npx playwright test --project=worker <spec>`），
  必须覆盖「用户点下去 → 界面到哪」的完整链路，并截图存档失败现场。
- 门禁：`npm run verify`（版本一致性 → 迁移 → typecheck → 单测 → 安全测试 → 未使用依赖 →
  astro check → HTML 安全 → lint → build → CSP）。任一项红，版本不能算完成。
- 文档里区分 **Implemented（改了代码）** 与 **Verified（有测试证据）**；
  生产没部署就写 Blocked，不许把本地通过写成线上正常。

【交付物】
1. docs/RELEASE-2.0.<N>.md：缺陷回顾（含被推翻的旧结论）、逐条改动（贴关键代码与文件行号）、
   测试证据表、兼容性、部署注意。
2. docs/PROMPT-2.0.<N>.md：本文件的下一版——把这次踩到的坑写进「硬约束」。
3. docs/AI-BUILD-BACKLOG.md：被关闭的条目移除或标 `Fixed + 证据位置`，
   同时把「旧结论错在哪」写一句，防止下一个人重新掉进同一个假说。
4. docs/AI-BUILD-STATUS.md：版本、用例总数、E2E 通过数、入口体积、首屏 CSS。
5. docs/AI-BUILD-LOG.md：追加一条本轮记录（时间、范围、门禁命令与结果）。

【报告风格】
先给结论（修好了没有、证据在哪），再给过程。不确定的地方明说「未验证」，
不要用「已优化」「应该没问题」这类话填空。
```

---

## 3. 这次按提示词落地的结果

| 提示词要求 | 2.0.1 的兑现 |
| --- | --- |
| 中间态条目清零 | P1-8 从 `Partially Verified` 改为 `Fixed`，并写明旧「竞态」结论错在哪 |
| 抽纯函数 | `pickPageButton()` 从点击代理里抽出来，3 条单测覆盖「数字才算翻页」 |
| 真实链路 E2E | `community-search-open.spec.ts`：造作品 → 发布 → 审核 → UI 搜索 → 点卡片 → 进详情 → 返回 |
| 门禁全绿才发版 | `check:version`、typecheck、lint、check:unused、build、vitest、playwright 逐项实跑 |
| 不把本地写成线上 | 发布文档只声称本地/CI 证据，生产标记 Blocked |

---

## 4. 下一轮（2.0.2）该先看什么

1. `docs/AI-BUILD-BACKLOG.md` 里仍开着的 P3-2（教程页面级浏览器断言）、P3-3（真机冒烟）、
   P2-6（`os13.ts` 拆分的 Blocked 项）。
2. `qa:prod` 的门禁清单——生产部署一直是唯一被 Blocked 的大项，任何补丁版本都绕不过它。
3. 本文件的「硬约束」第 2 条：版本源已经 8 处，再加就要考虑收敛成单一生成源，
   否则每轮都靠人工对齐迟早出错。