# 2.0.9 提示词（下一轮可直接复制）

## 0. 这一版是什么

2.0.9「Range Proof」是一个补丁版本：修掉协议层的两个真实缺陷（文件 Range/HEAD、插件网络代理整包读入）、社区审核链的两处一致性问题（hidden 作品被作者重发抹掉审核记录、评论举报只结算一条）、以及一个反复出现的前端状态问题（重开系统设置/市场时侧栏高亮与内容不一致）。没有数据库迁移，没有公开响应字段变化。

## 1. 本轮踩过的坑（写进硬约束，别再来一次）

1. **workerd 会自己改写响应头**。`contentHandler` 里 `headers.set("content-length", …)` 在 worker 走流式 body 时会被 workerd 丢掉（真实响应是 `Transfer-Encoding: chunked`，还可能 gzip）。E2E 里断言 `content-length` 会收到 `NaN`；要断言就断言 `content-range`、`accept-ranges` 与实际 body 长度。诊断方式：解压 `test-results/*/trace.zip`，看 `0-trace.network` 的响应头，别靠猜。
2. **R2 不把越界 Range 当错误**。把 `Range` 原样透传给 `env.FILES.get(..., { range })` 时，起点大于文件长度 R2 会回 206/整包而不是 416。必须自己解析单区间并在越界时直接 416 + `Content-Range: bytes */总长`，而且不要为此去读 R2。
3. **HEAD 不是自动的**。路由只写 `method === "GET"` 时 HEAD 会 405/404；`new Response(object.body)` 在 HEAD 下也必须传 `null` body，否则运行时会报错或吞掉连接。
4. **用「临时脚本 + 备份」做负向对照，恢复必须校验 SHA-256**。2.0.8 已经踩过「脚本打印 restored 但没真写回」，本轮所有 `.tmp-neg-*.mjs` 都必须：无参数 `REFUSED` exit 2、`patch` 先备份并记 SHA、`restore` 覆盖后再算 SHA 打印 `MATCH/MISMATCH`，MISMATCH 必须非零退出。
5. **E2E 的 worker project 跑的是 wrangler dev 的源码，不是 dist**。改 Worker 代码不用 `astro build`；但改客户端（os13/os20/shell）必须 `npx astro build`，否则负向对照会假通过（2.0.8 的教训）。
6. **本地 D1 的 `rate_limits` 会挡住第二次 E2E**。`plugin-upload` 是 20 次/小时，夹具每轮上传约 20 个签名包。跑前清表：`node scripts/clear-rate-limits.mjs run "<.wrangler/state/v3/d1/miniflare-D1DatabaseObject/*.sqlite>"`（默认必须 REFUSED）。
7. **引导浮层与欢迎窗会吃点击**。启动测试要「看到 `[data-onb-skip]` 就点、直到 `.os20-onb` 数量为 0」，并且先关掉 `.window[data-app="posts"]`；`GOS14.ctx.openApp()` 的返回值在早期不可靠，判定窗口是否打开要看 `.window[data-app=…]` 是否出现，不要看返回值。
8. **侧栏图标会进文本**。`.g14-nav.is-active` 的 `toHaveText("系统")` 会收到 `"⚙系统"`；断言用 `toContainText`。
9. **wrangler 4.157 的 workerd 在本机起不来**。报 `kj/filesystem-disk-win32.c++:773: failed: CreateDirectory: #5 拒绝访问; path = miniflare-email-store`，`d1 execute --local`、`d1 migrations apply --local`、`wrangler dev --local` 全部失败，e2e-server 因此连迁移都过不去。升级到 `wrangler@4.166.0`（devDependency）即恢复；这不是产品缺陷，但会让「全量 E2E 全绿」这条验收卡住，必须在环境章节写清楚。
10. **版本号批量替换会改坏依赖**。`package-lock.json` 里可能有多处 `"version": "2.0.x"`（本轮 wrangler 升级后就有大量新增），只能替换根包的前两处（第 3、9 行），其余全是依赖版本。

## 2. 下一轮（2.1.0 / 2.0.10）建议优先

- **需要迁移的计数幂等**：`POST /posts/:id/view` 与 `GET /posts/:id/package?count=1` 现在可以被匿名重放刷量。要修就得加「按用户/按天去重」的表或列，属于迁移，单独一个 PR，别混进补丁版。
- **社区图片上传配额预占**：和 `/files` 的 pending 行一个思路，需要新列/新表。
- 文件 `pending_delete` 没有回收路径：R2 删除失败后行会永久停在 `pending_delete`，回收站看不到，也永远不会重试。可以在读列表时把 `pending_delete` 当作回收站成员展示，并加一次「重试删除」的清理任务（不需要迁移）。
- 备份 merge 恢复：按哈希跳过的文件仍会被 `FILES.put` 一遍（审计 worker 报告第 2 条），孤儿对象不计入配额，值得修。
- 慢启动时欢迎窗先开会让 layout 恢复被跳过（审计前端报告第 1 条），Cloud Mode 刷新会丢布局；这条需要改恢复条件，不只是 UI。

## 3. 复制的任务书

> 给 Guandao OS 做一次补丁版本发布，版本号 2.0.N。自行确定范围、自行写发布说明。
>
> 上位约束：先 `git status` 与 `node scripts/check-version.mjs` 确认起点干净；看 `docs/AI-BUILD-STATUS.md` §5 风险表与上一版 RELEASE 的 §6；优先不需要数据库迁移、不改公开响应字段的缺陷；需要迁移的单独列清单，不塞进补丁版。
>
> 硬约束：每条修复必须有「失败复现 → 修复 → 通过」的证据，负向对照要真改回旧行为跑一次并校验 SHA-256；界面链路用真实 Worker 的 Playwright（`--project=worker`），纯函数才用单测；不改公开 API 契约（必须改时同步文档 + 测试，并在发布说明单列「行为变更」）；不加数据库迁移；版本 9 处同步（package.json、package-lock.json 第 3/9 行、src/lib/version.ts、worker/api/version.js、public/sw.js、shared/plugin-spec.js、worker/api/community/validate.js、cli/guandao.mjs、src/lib/core/registry.ts），以 `node scripts/check-version.mjs` 为准；既有断言不许删，版本号出现在测试/脚本/CI 里就一起更新并在提交说明写原因；临时脚本默认动作必须是「拒绝执行」；一次最多两个子智能体，必须等到收尾消息；中文注释写「为什么」，不留调试插桩；验收 `npm run verify` 全绿 + 全量 E2E 全绿。
>
> 交付：`docs/RELEASE-2.0.N.md`（缺陷回顾、逐条改动与代码、证据表、兼容性、部署注意、未修清单）、`docs/PROMPT-2.0.N.md`（把本轮的坑写进硬约束）、BACKLOG 追加 Round、STATUS 更新版本/单测数/E2E 数/体积、LOG 追加一条。

## 4. 对照表：本轮教训 → 下轮检查点

| 教训 | 下轮检查点 |
| --- | --- |
| workerd 改响应头 | 断言 `content-range`/`accept-ranges`/body，不断言 `content-length` |
| R2 不报越界 | 解析 Range 后自己判 416，别把错误推给 R2 |
| HEAD 需显式空 body | 路由同时接 GET/HEAD，HEAD 传 `null` |
| 临时脚本假恢复 | `patch`/`restore` 双模式 + SHA-256 MATCH 校验 |
| dist 与源码 | 客户端 E2E 前 `astro build`，Worker 不用 |
| rate_limits | 跑前清表，必要时后台循环清 |
| 引导浮层 | 循环关引导、先关 posts 欢迎窗 |
| 侧栏图标 | `toContainText` |
| wrangler/workerd | 4.166.0 起本地可跑；环境章节记录版本 |
| package-lock 依赖版本 | 只替换第 3/9 行，替换后 `git diff` 复核 |