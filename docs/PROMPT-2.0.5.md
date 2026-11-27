# PROMPT-2.0.5 · 下一轮提示词（可直接复制）

> 这份文件记录本轮踩到的坑，并把它们写进下一轮任务的硬约束。
> 复制 §2 的「任务书」给下一次的自己或另一个 agent。

## 1. 本轮踩过的坑

1. **同一类缺陷会出现在不同模块**：2.0.4 修了「深目录删除 IN 参数超限」，
   2.0.5 又在通知标记已读、插件市场 trending 各找到一处。修完一处要按形态全仓扫
   （`IN (${…map(() => "?")})`、`bind(…, ...ids)`），而不是只修用户报的那条路径。
2. **「看起来安全」的 slice 不是安全**：`slice(0, 100)` 加上 `now + user_id` 就是 102 个参数。
   边界判断必须把「其它绑定参数」算进去。
3. **分块实现会各自漂移**：files 有 `FOLDER_TREE_CHUNK`、sync 有 `chunkArray`、通知又写一份。
   应收敛到一个 `worker/api/sql.js`，调用方只关心语义。
4. **负向对照要留证据**：假 D1 强校验 100 上限，`git stash` 回旧实现后必须变红；
   否则「测试通过」只证明测试没跑错。
5. **Windows 上连续快速改同一文件会偶发 `ReplaceFileW EIO`**：重试即可，不要当成代码问题。
6. **`api.github.com` 从本机可能不可达**（connect timeout），但 `github.com` 正常；
   CI 状态复核要准备备用通道（网页 Actions 页或稍后重试），不要把「查不到」当成「失败」。
7. **批量替换版本号会误伤依赖**：`package-lock.json` 里 `picomatch ^2.0.4` 不是项目版本。
   只改第 3、9 行根版本，改完 `git diff` 必须只剩这两行。
8. **推送 = 上线**：本仓库 push 到 `main` 会触发 Cloudflare 自动构建并 100% 切流。
   没有用户明确授权，不要 push。

## 2. 下一轮任务书（模板）

```text
给 Guandao OS 做一次补丁版本发布，版本号 2.0.<N>。自行确定范围、自行写发布说明。

范围优先级：
1. 把 STATUS §5 风险、BACKLOG 里的中间态逐条变成「有失败证据就真修 / 有通过证据就关掉」；
2. 给每条修复补能判别的自动化测试（纯函数抽纯函数；界面链路用真实 Worker 的 Playwright，
   不许 mock 冒充端到端；服务端边界用假 D1 强校验）；
3. 有余力再碰性能体验。

硬约束：
- 不改公开 API 契约（改了同步文档 + 测试）；不加数据库迁移；
- 版本号 9 处同步，以 `node scripts/check-version.mjs` 通过为准；
- 既有断言不许删；`worker/api/csp-hashes.js` 是构建产物，不许回滚；
- 中文注释写「为什么」；不留调试插桩；
- 负向对照必须实跑：把旧实现放回去，测试要变红，再恢复；
- 任何「按 id 批量」的 SQL，先算清绑定参数总数（D1 上限 100），超了就分块。

证据标准：
- 单测写明文件、用例数、通过数；
- E2E 用 `npx playwright test --project=worker <spec>`，真实浏览器 + 真实 Worker，
  覆盖「点下去 → 界面到哪」，失败现场截图存档；
- `npm run verify` 必须 exit 0；全量 E2E 必须全绿。

交付物：
- docs/RELEASE-2.0.<N>.md（缺陷回顾含被推翻的旧结论、逐条改动贴关键代码、证据表、兼容性、部署注意）；
- docs/PROMPT-2.0.<N>.md（本文件）；
- 更新 docs/AI-BUILD-STATUS.md（版本/用例数/E2E 通过数/体积/风险）、
  docs/AI-BUILD-BACKLOG.md（Fixed + 证据位置 + 旧结论错在哪）、docs/AI-BUILD-LOG.md 追加一条；
- 未部署就写 Blocked，并在报告里明确「等授权」。
```

## 3. 本轮对应关系

| 坑 | 落在哪条约束 |
| --- | --- |
| 同类缺陷跨模块 | 「按 id 批量 SQL 先算参数」+「全仓按形态扫」 |
| slice 不是安全 | 「算清绑定参数总数」 |
| 分块实现漂移 | 「收敛到 `worker/api/sql.js`」 |
| 负向对照 | 「负向对照必须实跑」 |
| ReplaceFileW EIO | 见 §1 第 5 条，不写进任务书（环境噪音） |
| api.github.com 不可达 | 「CI 复核准备备用通道」 |
| 版本批量替换 | 「只改根版本，diff 复核」 |
| push = 上线 | 「没有授权不要 push」 |

## 4. 下一轮优先建议

1. **生产侧证据**：通知 99+ / trending ≥99 的真实 Worker E2E（用 SQL seed 100 个插件行，不经上传限流）。
2. **告警 webhook**：`BACKUP_ALERT_WEBHOOK`、`DATA_ALERT_WEBHOOK`（需要用户给 URL）。
3. **os13 / shell 前端状态机**审计（本轮只扫到 `os14` 与 Worker 边界）。
4. 生产写入型发布链（发布 / 审核 / 撤回的真实生产冒烟），目前只有只读冒烟。