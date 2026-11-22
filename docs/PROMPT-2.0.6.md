# PROMPT-2.0.6 · 下一轮提示词（写给下一次的自己）

> 用法：把 §2 整段贴给下一轮；§1 是这一轮踩过的坑，已经用硬约束的形式写进 §2。

---

## 1. 这轮踩过的坑

1. **子智能体可能静默消失**
   一次派三个审计，`audit-os14` 被系统停掉；另外两个「inactive」后问它们，
   只拿到 `was stopped before it finished. It left no closing message.`。
   → 每次派单后必须等到**收尾消息**才算拿到结论；只看到 inactive 不等于完成。
   同一时刻最多两个子智能体（用户明确要求）。

2. **负向对照的临时脚本默认动作不能是「打补丁」**
   `.tmp-neg-os13.mjs` 不带参数时默认 patch，我误跑一次，造成二次打补丁 +
   重复 `import { safeUrl }`，`tsc` 直接报 `os13.ts:14:9`。
   → 脚本必须要求显式 `restore`，默认分支只能报错退出；恢复后逐文件校验 SHA256。

3. **安全修复的「旧行为」要用真实断言证明**
   把 `renderWallGallery` 换回裸拼接后，`toHaveText` 收到的实际值是 `"壁纸"`
   （注入的 `<img>` 被当标签解析），这才是能写进报告的失败证据；
   只是「旧代码看起来不安全」不算。

4. **`check-html-security` 只认「直接被安全调用包住」**
   `src="${wall.custom ? safeUrl(...) : safeUrl(...)}"` 认不出来；
   `src="${escapeAttr(thumb)}"` 可以。新文件里有 `innerHTML`/URL 插值，
   verify 会红，要么在模板里直接包一层，要么在 allowlist 登记并写 reason。

5. **批量替换版本号会改坏 RELEASES 与 package-lock**
   全局 `2.0.5 → 2.0.6` 会把 2.0.5 那条发布记录整个改名，也会把依赖的真实版本改掉。
   → `package-lock.json` 只替换根对象两行（第 3、9 行）；`version.ts` 的 RELEASES
   要**新增**一条，不能靠替换。

6. **本地 E2E 限流是常客**
   `plugin-upload` 每小时 20 次，e2e-server 每轮造约 20 个签名包。
   每次跑之前清 `rate_limits`（node:sqlite，`DELETE` + `PRAGMA wal_checkpoint(TRUNCATE)`），
   否则第二轮就 `429 RATE_LIMITED <秒数>`。

7. **Windows 文件写入偶发 `ReplaceFileW EIO`**
   连续快速改同一文件时会撞（Win32 32 / 1175）。重试一次即可，别当成代码错误。

---

## 2. 可复制任务书

```text
给 Guandao OS 做一次补丁版本发布，版本号 2.0.<N>。自行确定范围、自行写发布说明。

背景：Astro 静态站 + Cloudflare Worker/D1/R2 的网页操作系统；文档在 docs/RELEASE-2.0.<N-1>.md、
docs/AI-BUILD-STATUS.md、docs/AI-BUILD-BACKLOG.md、docs/AI-BUILD-LOG.md。
动手前先 git status，别覆盖别人未提交的改动。

范围优先级：
1) 先把 BACKLOG 里所有「Partially Verified / Implemented / 疑为竞态」的条目处理干净：
   有失败证据就真修，有通过证据就改成 Verified，不允许中间态。
2) 补上能成立的自动化证据：能纯函数化的抽纯函数写单测；
   界面链路必须用真实 Worker + 真实浏览器的 Playwright，不许 mock 冒充端到端。
3) 有余力再碰性能与体验。

硬约束：
- 不改公开 API 契约；改了必须同步文档与测试。
- 不加数据库迁移。
- 版本号 9 处同步：package.json、package-lock.json（只改根两行）、
  src/lib/version.ts（含 RELEASES 新增一条，不能改旧条目）、worker/api/version.js、
  public/sw.js、shared/plugin-spec.js、worker/api/community/validate.js、
  cli/guandao.mjs、src/lib/core/registry.ts；以 `node scripts/check-version.mjs` 通过为准。
- 既有断言不许删；版本号出现在测试里就一起更新并写明为什么。
- 构建重写 worker/api/csp-hashes.js 属正常产物，不许回滚。
- 中文注释写「为什么」，不写「什么」。
- 不留调试插桩。

证据标准：
- 单测写明 `npx vitest run <file>` 的用例数/通过数；
- E2E 用 `npx playwright test --project=worker <spec>`，覆盖「点下去→界面到哪」；
- 关键修复必须有负向对照（把旧实现放回去，测试必须红），并记录失败输出；
- 失败现场截图与 trace 留在 test-results/，不要为了让报告好看而删；
- `npm run verify` 全绿（任一红则版本不算完成）。

文档：
- docs/RELEASE-2.0.<N>.md：缺陷回顾（含被推翻的旧结论）、逐条改动贴关键代码与行号、
  测试证据表、兼容性、部署步骤；
- docs/PROMPT-2.0.<N>.md：下一轮提示词，把这一轮的坑写成硬约束；
- BACKLOG：每条 Fixed 写证据位置与「旧结论错在哪」；
- STATUS：版本、用例总数、E2E 通过数、入口体积、首屏 CSS；
- LOG：追加一条本轮记录。
- 文档必须区分 Implemented 与 Verified；生产没部署就写 Blocked，不许写「已完成」。

报告风格：先结论、再过程；不确定的地方写「未验证」。
```

---

## 3. 对照表

| 要求 | 本轮怎么满足 |
| --- | --- |
| 中间态清零 | BACKLOG 已无 Partially Verified / Implemented；风险 11 拆出的两条配额已修 |
| 真实证据 | 19 条纯函数单测 + 2 条真实浏览器 E2E + 两轮负向对照 |
| 不改 API、不加迁移 | 只改前端模块与两个迁移写入函数，`check:migrations` 通过 |
| 版本 9 处 | `check-version` 输出 2.0.6 一致 |
| verify 全绿 | 31 files / 420 tests、294 处审查、30 页、12 哈希 |
| 文档 | RELEASE-2.0.6 / PROMPT-2.0.6 / STATUS / BACKLOG / LOG |

---

## 4. 下一轮优先

1. 给布局、拖拽、强调色补真实浏览器 E2E（现在只有单测）。
2. 把 `audit-worker` 与 `audit-os14` 重新派出去，拿到收尾消息再收工。
3. 告警 webhook：需要用户给 `BACKUP_ALERT_WEBHOOK` / `DATA_ALERT_WEBHOOK` 两个地址，
   没有就继续在文档里写 Blocked。
4. 生产写入型发布链（qa:prod 只覆盖公开/只读链路）。