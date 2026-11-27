# 2.0.9 及之后：下一轮提示词（从 2.0.8 的坑里长出来的）

> 这份文件是给下一轮的人（或下一次的自己）看的。任务书部分可以直接复制。

## 1. 这一轮踩到的坑

1. **版本号批量替换会伤到依赖名**：`split("2.0.7").join("2.0.8")` 之前先在 2.0.4 把 26 个依赖版本改坏过。
   `package-lock.json` 只允许改第 3、9 行；跑 `git diff package-lock.json` 确认只有两行根版本。
2. **源码断言会被自己的注释触发**：测试里 `expect(source).not.toContain("autohide: false")`，
   而注释里正好写了 `autohide: false`。注释要么改写措辞，要么断言改成匹配真实代码形态。
3. **纯函数测试不代表接线正确**：`canApplyUpdate` 全绿，但按钮仍可能用旧表达式。
   界面契约要用「源码约束断言 + 真实渲染/E2E」双层，不要只测纯函数。
4. **临时脚本默认动作必须拒绝**：`.tmp-neg-*` 不带参数时必须 `REFUSED` 退出；
   `restore` 后必须打印 SHA-256 MATCH，否则「假恢复」会让 verify 红（2.0.4 已发生过一次）。
5. **替换脚本先备份再改**：本项目里 `Set-Content -NoNewline` + 连续改写同一文件会偶发
   `ReplaceFileW EIO (Win32 32/1175)`，重试即可；但「恢复」必须校验内容，不能只信脚本 print。
6. **`Number(v) || 45` 这种写法遍布设置层**：任何 0 有语义的字段（音量、亮度、速度）都要单独想。
7. **搜索/过滤类 UI 要同时重绘「列表 + 详情」**：只刷列表是常见的陈旧详情来源。
8. **真实 Worker E2E 的夹具 id 不一定是 UUID**：`qa-p3-*` 是短 id，管理接口只认 UUID；
   需要 UUID 目标的用例只能借助 `creator`（3f6f2a1c-…），其余走假 D1 单测。

## 2. 可复制的任务书（2.0.9）

```text
给 Guandao OS 做一次补丁版本发布，版本号 2.0.9。自行确定范围、自行写发布说明。

上位约束：
- 先 git status 与 node scripts/check-version.mjs 确认起点干净；
- 看 docs/AI-BUILD-STATUS.md §5 风险表与 docs/RELEASE-2.0.8.md §6；
- 优先不需要数据库迁移、不改公开响应字段的缺陷；
- 需要迁移的单独列清单，不塞进补丁版。

硬约束：
- 每条修复必须有「失败复现 → 修复 → 通过」的证据，负向对照要真改回旧行为跑一次；
- 界面链路用真实 Worker 的 Playwright（--project=worker），纯函数才用单测；
- 不改公开 API 契约；必须改时同步文档 + 测试，并在发布说明单列「行为变更」；
- 不加数据库迁移；
- 版本 9 处同步（package.json、package-lock.json 第 3/9 行、src/lib/version.ts、worker/api/version.js、
  public/sw.js、shared/plugin-spec.js、worker/api/community/validate.js、cli/guandao.mjs、
  src/lib/core/registry.ts），以 node scripts/check-version.mjs 为准；
- 既有断言不许删，版本号出现在测试/脚本/CI 里就一起更新，并在提交说明写原因；
- 临时脚本默认动作必须是「拒绝执行」，恢复后校验 SHA-256；
- 一次最多两个子智能体，必须等到收尾消息；
- 中文注释写「为什么」，不留调试插桩；
- 验收：npm run verify 全绿 + 全量 E2E 全绿。

交付：
- docs/RELEASE-2.0.9.md（缺陷回顾、逐条改动与代码、证据表、兼容性、部署注意、未修清单）
- docs/PROMPT-2.0.9.md（把本轮的坑写进硬约束）
- BACKLOG 追加 Round 36
- STATUS 更新版本/单测数/E2E 数/体积
- LOG 追加一条
```

## 3. 2.0.9 的候选（按价值）

1. 文件 `pending_delete` 回收路径（对象泄漏，P2）
2. 插件 `/api/plugins/net` 流式截断（isolate 内存，P2）
3. 文件 Range/HEAD 协议细节（P3，需真实客户端）
4. 窗口双重关闭 / 布局 cascade 重叠 / bridge subtree（P3，需集成测试）
5. 社区浏览/下载计数幂等（需迁移，单独立项）
6. 社区上传配额预占（需迁移，单独立项）

## 4. 对照表：2.0.7 → 2.0.8

| 2.0.7 的问题 | 2.0.8 的处理 |
| --- | --- |
| 2.0.7 §6 的 P1 未修 | 插件更新/回退信任闸门已修，8 条单测 + 负向对照 |
| 设置层 `|| 默认值` | 抽出 `normalizeNotificationVolume`，0 合法 |
| 引导副作用 | `buildOnboardingPatch` 只写 touched 字段 |
| 更新中心陈旧 server | `canApplyUpdate` + 失败清空 |
| 市场陈旧详情 | `resolveSelection` + 详情栏重绘 |
| 要迁移的两条 | 明确排除，写进 §6 与 BACKLOG |