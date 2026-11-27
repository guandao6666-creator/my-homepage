# Guandao OS 2.0.10 → 下一版任务书（PROMPT-2.0.10）

> 这份提示词是写给「下一轮做补丁版的人（或 AI）」的。前半是这一轮踩过的坑，后半是可以直接复制的任务书。

## 1. 这一轮踩过的坑（硬约束）

1. **版本号批量替换会改坏历史 RELEASES 条目**：把 `2.0.9` 全量替换成 `2.0.10` 时，`src/lib/version.ts` 里旧的 `2.0.9 Range Proof` 条目也被改成 `2.0.10`，导致 2.0.8 的条目被上上轮替换吞掉、历史只剩 2.0.7。改完必须逐条核对 `RELEASES` 的 version/name/date/notes，缺条目要补回来。
2. **package-lock.json 只能改根版本前两处**（`"version": "2.0.x"` 出现在第 3、9 行）；第 5097 行这类是真实依赖版本。用脚本时按行号/前 N 次匹配处理，不要 `replaceAll`。
3. **客户端 E2E 跑的是 `dist`**：改 `src/lib/**` 后必须 `npx astro build` 再跑 `--project=worker`；否则负向对照会「假通过」（测试读的还是旧产物）。而 Worker 侧（`worker/api/**`）直接跑源码，不需要 build。
4. **负向对照必须是真改回旧行为**：本轮两条都做了「patch → 红 → restore（SHA-256 MATCH）→ 绿」。临时脚本默认动作必须是拒绝执行（无参数 exit 2），`patch` 前备份、`restore` 后打印 SHA-256。
5. **本地 D1 的 rate_limits 会伪装成产品故障**：`plugin-upload` 20 次/小时会挡住 e2e-server 的夹具上传（429），跑 E2E 前先 `node scripts/clear-rate-limits.mjs run "<…\/miniflare-D1DatabaseObject\/*.sqlite>"`；脚本默认拒绝执行。
6. **E2E 启动时序**：只等 `#boot` 消失会抢跑，要等 `window.GOS20_READY`；引导浮层 `.os20-onb` 会晚挂载并拦截点击，要按「看到就关、直到消失」循环；欢迎文章窗 `.window[data-app="posts"]` 也会挡住桌面，先关掉。
7. **跨源/跨窗断言别依赖运行时改写的头**：workerd 对流式响应走 `Transfer-Encoding: chunked`，会把 `content-length` 抹掉；断言应落在 `content-range`、实际 body、`accept-ranges` 上。
8. **D1 单条语句最多 100 个绑定参数**：任何 `IN (…)` 拼接都要用 `worker/api/sql.js` 的 `chunkIds`/`placeholdersFor`（40 一块），`userId`、时间戳也要算进预算。
9. **一个页面里同一语义的芯片/状态可能有两个**（审核卡封面与标题行各一个 `.cx-status-chip`），断言要限定容器（`.cx-mod-head .cx-status-chip`）。
10. **系统设置的分区是模块级状态**：`shell`/`bindTabs` 必须传当前分区，否则重开窗口高亮与内容不一致；数值滑杆这类控件要同时处理 `pointerup` 与 `change`，并做按值去重。
11. **wrangler 4.157 在本机有 workerd 缺陷**（`miniflare-email-store` 创建失败），必须 ≥4.166.0；升级后 CI 的 `npm ci` 需要用 npm 10 重新生成锁（peer 解析差异）。
12. **临时产物清理**：`.tmp-*`、`trace-x/`、`test-results/` 不要留在提交里。

## 2. 下一版（2.0.11 候选）任务书（可复制）

```
给 Guandao OS 做一次补丁版本发布，版本号 2.0.11。自行确定范围、自行写发布说明。

硬约束：
- 先跑 git status 与 node scripts/check-version.mjs，确认起点干净、版本一致。
- 优先不需要数据库迁移、不改公开响应字段的缺陷；需要迁移的（计数幂等、社区上传配额预占）只列清单，不塞进补丁版。
- 每条修复都要有「失败复现 → 修复 → 通过」的证据；负向对照必须真的改回旧行为跑一次（临时脚本默认动作必须是拒绝执行，restore 后校验 SHA-256）。
- 界面链路用真实 Worker 的 Playwright（npx playwright test --project=worker <spec>），纯函数才用单测；客户端 spec 改完要 astro build。
- 不改公开 API 契约（必须改时同步文档+测试，并在发布说明里单列「行为变更」）；不加数据库迁移。
- 版本号 9 处同步（package.json、package-lock.json 只改 3/9 行、src/lib/version.ts 含 RELEASES、worker/api/version.js、public/sw.js、shared/plugin-spec.js、worker/api/community/validate.js、cli/guandao.mjs、src/lib/core/registry.ts）。
- 既有断言不许删；版本号出现在测试/脚本/CI 里就一起更新，并在提交说明里写原因。
- 中文注释写「为什么」，不留调试插桩。

候选范围（按价值）：
1. 备份 merge 恢复：按哈希跳过的文件不要再写 R2（当前先 put 再去重 → 孤儿对象）。修法：runRestore 循环前加载已有 sha256 集合，命中则不 get/put，但 upsertRestoreFile 计入进度。
2. 插件安装上限 check-then-insert（MAX_INSTALLED=40）：改成条件插入抢名额，changes=0 再 UPDATE 已存在行，仍 0 才抛 INSTALL_LIMIT（响应契约不变）。
3. 窗口关闭双通道（windows.close 与 shell.onClosed 都 emit window:closed）：只保留一处。
4. 布局恢复窄视口 cascade 重叠：rescale 后按可用区域重新 cascade。
5. sync since 游标加 entity_id tiebreak（外部客户端跨页丢实体）。
6. 文件 Range 多区间（multipart/byteranges）目前按 200 全量返回，可评估是否支持。

验收：npm run verify 全绿 + 全量 E2E 全绿；写 docs/RELEASE-2.0.11.md、docs/PROMPT-2.0.11.md、BACKLOG 追加 Round、STATUS（版本/单测数/E2E 数/体积）、LOG 一条；未部署就写 Blocked。
```

## 3. 对照表（这一轮的实际结果，供下一轮校准）

| 坑 | 这一轮的处理 |
|---|---|
| 版本号替换吞历史 | 手工补回 2.0.8 / 2.0.9 两条 RELEASES 记录 |
| 负向对照脚本 | `.tmp-neg-210.mjs` / `.tmp-neg-210b.mjs` 均为 patch/restore 双模式，无参数拒绝 |
| 客户端 E2E | 改 systemcenter.ts 后必须 `astro build` 才跑得对 |
| rate_limits | `scripts/clear-rate-limits.mjs`（2.0.9 已提升为正式脚本，2.0.10 起 E2E 跑前用它、运行中改用 90 秒一次） |
| 列表重试的边界 | 只处理 20 行、失败保留、日志不抛错 |

## 4. 下一轮的优先级

1. 先把 P1 级别数据一致性问题（备份孤儿对象、安装上限并发）修掉，它们会累积成真实存储成本。
2. 再做纯前端体验类（窗口双关、cascade、控件一致性）。
3. 需要迁移的两条（计数幂等、配额预占）单独排期，不要混进补丁版。