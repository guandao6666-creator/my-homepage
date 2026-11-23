# Guandao OS 2.0.11 · Loose Ends

| 项 | 值 |
| --- | --- |
| 版本 | **2.0.11**（补丁版，上游 2.0.10） |
| 版本名 | Loose Ends |
| 日期 | 2026-11-23 |
| 分支 | `dsh-da37e99c-1ac8`（本工作树） |
| 状态 | **已部署（Verified：本地 + 生产）**，Version `c6444ff6-5fd6-439b-b2c7-6296e2a9aa1f` |
| 生产现状 | 2.0.10（Version `b207dbcb-09d9-4f30-943e-37a281d4de56`） |

## 1. 为什么做这一版

2.0.10 的发布报告在「未修清单」里留了几条已经定位、但上一版没来得及动的缺陷。这一版把它们收掉，
仍然遵守「不动公开 API 契约、不加数据库迁移」的补丁版边界：

| 编号 | 缺陷 | 影响 |
| --- | --- | --- |
| F1 | 备份 merge 恢复**先写 R2 再去重** | 被哈希去重跳过的文件已在 R2 留下 `users/{uid}/files/{newId}` 孤儿对象，`usage()`/`storageStats` 都看不见，反复恢复会无限放大 |
| F2 | 插件安装上限 40 是 **check-then-insert** | 两个并发新装都能通过 `COUNT(*) < 40` 检查，实际安装数可超过上限 |
| F3 | 窗口关闭**双通道重复通知** | `WindowShell.onClosed` 回调与 `close()` 返回值描述同一次关闭，两条路各 `notifyClosed()+emit("window:closed")` 一次 → 订阅者重复清理、`saveLayout` 重复 |
| F4 | 窄视口恢复布局**完全重叠** | 缩放后窗口被 `clampRect` 顶回右下角，级联偏移后再被 clamp 回原处，多窗口压成一摞 |
| F5 | 同步增量拉取 `since` **缺 tiebreak** | `updated_at` 是毫秒整数，同毫秒多条变更跨分页边界时 `updated_at > since` 把其余记录跳过（外部客户端按 limit 翻页会丢数据） |

另外两条**需要数据库迁移**的项（`view`/`package` 计数幂等、社区上传配额预占）与**多区间 Range**
按以下原则处理，不在本版硬塞：

- 需迁移项：留在 STATUS §5 风险 16，单独排期；补丁版不引入 migration。
- 多区间 `Range: bytes=0-1,4-5`：RFC 7233 允许服务端忽略多区间并返回 200 整包，现有行为合规，
  本轮判定「不改」，改为在文档里写清边界（见 §6）。

## 2. 逐条改动

### 2.1 F1 · 备份合并恢复先判哈希再写 R2

新增 `worker/api/backups/restore-copy.js`：

- `classifyRestoreFiles(files, existingSha256)`（`restore-copy.js:17`）：把「内容已在云盘」的文件标成跳过。
- `loadReadySha256(env, userId)`（`:31`）：一次性读 `status='ready'` 的 `sha256` 集合。
- `copyRestoreObject(env, {userId, backupId, file})`（`:41`）：`get` → `tee()` 边写边算哈希 →
  大小/哈希不符则删掉刚写的 key 并抛 `RESTORE_VERIFY_FAILED`。
- `runRestoreCopy(env, {...})`（`:64`）：merge 模式循环里**先判哈希**，命中只登记
  `status:"copied"`、`error:"DUPLICATE_CONTENT"`，**不读不写 R2**；复制成功后把 digest 也并入集合
  （同一备份内重复内容只落一份）。`plan.skippedIds` 会带回给元数据阶段，保证两个阶段对
  「哪些文件被去重」判断一致；为空时 fallback 现查（兼容 2.0.10 之前创建的任务）。

`worker/api/backups/handlers.js` 的 `runRestore` 改为调用 `runRestoreCopy`，
`applyRestoreMetadata` 复用 `plan.skippedIds`。

### 2.2 F2 · 插件安装名额改成条件插入

新增 `worker/api/plugins/install-slot.js`，导出 `MAX_INSTALLED = 40` 与
`reserveInstallSlot(env, {userId, pluginId, versionText, packageHash, now, max, source})`：

```sql
INSERT INTO plugin_installations
  (id, user_id, plugin_id, version, enabled, status, package_sha256, source, installed_at, updated_at)
SELECT ?, ?, ?, ?, 1, 'installed', ?, ?, ?, ?
 WHERE (SELECT COUNT(*) FROM plugin_installations WHERE user_id = ?) < ?
```

`changes > 0` 即抢到名额；`changes === 0` 再尝试 `UPDATE`（并发重装同一插件），仍为 0 才抛
`INSTALL_LIMIT` 409（**响应契约不变**）。`installPlugin` 只多一次调用，原 `COUNT` 预检保留做快速失败。

### 2.3 F3 · 窗口关闭只通知一次

`src/lib/core/windows.ts` 新增 `notifiedCloses` 集合与 `notifyClosedOnce(appId)`（`:376`）：

```ts
private notifyClosedOnce(appId: string): void {
  if (!appId || this.notifiedCloses.has(appId)) return;
  this.notifiedCloses.add(appId);
  queueMicrotask(() => this.notifiedCloses.delete(appId));
  this.notifyClosed(appId);
  this.emitFn("window:closed", { appId });
}
```

Shell 回调（`:104`）与 `close()`（`:132`）都走它：同一次关闭只通知一次，微任务清空集合后
「真正再次关闭」仍会通知。

### 2.4 F4 · 窄视口级联把窗口错开

`src/lib/core/layout.ts` 新增导出 `settleCascade(rects, viewport)`（`:274`）：
候选位置限制在 `0..maxX / 0..maxY`（`maxX = viewport.width - rect.width`），最多 16 次、
正反交替、步长 26，只有与已放置窗口重叠比例 > 0.85 才继续换点；视口比窗口还小时保留原位。
`rescaleSnapshot`（`:236`）先 `clampRect` 得到 entries，再统一 `settleCascade`
（`cascade:false` 时保持原位置）。

### 2.5 F5 · 同步游标 (updated_at, entity_id)

新增 `worker/api/sync/cursor.js`：`formatSyncCursor(row)` / `parseSyncCursor(value)`（纯函数，
格式非法返回 null）。`worker/api/sync/store.js` 新增 `listChangesPage(...)`（`:46`）：

```sql
SELECT ... FROM sync_entities
 WHERE user_id = ? AND domain = ?
   AND (updated_at > ? OR (updated_at = ? AND entity_id > ?))
 ORDER BY updated_at ASC, entity_id ASC
 LIMIT ?
```

游标查询用 SQL 元组比较，既不像 `since` 那样跳同毫秒记录，也只需要一条语句（D1 无事务）。
`GET /api/sync/pull` 新增可选参数 `cursor` 与响应字段 `nextCursor`（**新增，不破坏旧字段**）；
`since` 语义保持不变，老客户端行为不变。`listChanges()` 保留旧返回形状供历史调用方使用。

### 2.6 版本号 9 处

`package.json`、`package-lock.json`（仅第 3/9 行根版本，依赖版本未动）、`src/lib/version.ts`
（`OS_VERSION` + RELEASES 首条 `2.0.11 / Loose Ends / 2026-11-23`）、`worker/api/version.js`、
`public/sw.js`（`guandao-2.0.11`）、`shared/plugin-spec.js`、`worker/api/community/validate.js`、
`cli/guandao.mjs`、`src/lib/core/registry.ts`；断言族同步 `tests/e2e/os20.spec.ts`、
`scripts/community-qa.mjs`、`scripts/plugins-qa.mjs`、`.github/workflows/quality.yml`。

## 3. 证据

### 3.1 新增单测

| 文件 | 用例数 | 结果 |
| --- | --- | --- |
| `tests/unit/backup-restore-dedupe.test.ts` | 8 | passed |
| `tests/unit/plugins-install-limit.test.ts` | 5 | passed（真实 SQLite：`0001_init.sql` + `0010_plugins.sql`） |
| `tests/unit/windows-close-cascade.test.ts` | 7 | passed |
| `tests/unit/sync-cursor.test.ts` | 6 | passed（真实 SQLite：`0001` + `0014` + `0018`） |

合计新增 **26** 条；全量单测 **54 files / 537 tests passed**。

### 3.2 负向对照（先把旧行为改回去，确认测试真的红）

| 脚本 | patch 后 | restore 校验 |
| --- | --- | --- |
| `.tmp-neg-211.mjs`（跳过分支 `if (false && readySha…)`） | 1 failed / 7 passed | `MATCH` → 8 passed |
| `.tmp-neg-211b.mjs`（名额条件改 `WHERE 1 = 1`） | 4 failed / 1 passed | `MATCH` → 5 passed |
| `.tmp-neg-211c.mjs`（恢复双通道通知 + `settleCascade` 直接返回） | 2 failed / 5 passed | 两文件 `MATCH` → 7 passed |
| `.tmp-neg-211d.mjs`（游标查询改回裸 `since`） | 1 failed / 5 passed | `MATCH` → 6 passed |

### 3.3 真实 Worker E2E

`tests/e2e/sync-cursor.spec.ts`（新增，已加入 `WORKER_SPEC`）：

1. 顺序 push 三条 notes → `limit=2` 翻页 → 断言 `nextCursor` 是字符串、两页并集正好三条、无重复；
2. `cursor=not-a-cursor` → 400 `INVALID_CURSOR`。

`npx playwright test --project=worker tests/e2e/sync-cursor.spec.ts` → **2 passed（19.1s）**。

E2E 负向对照：`.tmp-neg-211e.mjs` 让 Worker 忽略 `cursor`（传 `null`）→ 同一 spec
**1 failed**（`Expected: 4, Received: 2`——两页重复了同一批记录、三条里只取到两条）；
restore `MATCH` + `RESTORE_OK`。

### 3.4 全量门禁

- `npm run verify` **exit 0**：`[version] 一致：2.0.11`；typecheck 0 error；**54 files / 537 tests**；
  html-security `合计 295 处，未审查 0 处`；build **30 page(s)**；CSP 12 哈希 / 31 HTML 一致。
- 全量 E2E（`$env:E2E_ADMIN_PORT='18789'; npx playwright test`）→ **205 passed（5.3m）**，exit 0
  （2.0.10 的 203 + `sync-cursor` 2）。首跑 204 / 1 failed：`systemcenter-number-keyboard` 的侧栏点击被
  晚挂载的引导层拦截（套件慢时出现），把 spec 里「看到就关」升级为固定 10 轮 `dismissOverlays` 后复跑全绿。

## 4. 兼容性

- **契约不变**：安装上限 409 文案与 `INSTALL_LIMIT` 错误码不变；`put`/`delete`/恢复接口字段不变。
- **新增（非破坏）**：`GET /api/sync/pull` 接受可选 `cursor`，响应新增 `nextCursor`（可能为 `null`）。
- **行为变更（需要知道）**：
  1. `window:closed` 事件从「可能两次」变成「一次」——依赖「两次」的外部脚本会少收一次；
     这是修 bug 的目标行为，仓库内订阅者都幂等。
  2. merge 恢复时被去重的文件不再写 R2，`backup_restore_items.status` 为 `copied` 且
     `error=DUPLICATE_CONTENT`（原来根本不建行）。
- **不加迁移**：两条需迁移项仍挂起（见 §6）。

## 5. 部署记录（2026-11-23 14:12）

| 步骤 | 结果 |
| --- | --- |
| 推送前检查 | `git fetch` 后 `origin/main...HEAD` = `0 1`（无落后）；`node scripts/check-version.mjs` → 2.0.11 |
| 数据库迁移 | `npx wrangler d1 migrations list guandao-db --remote` → `✅ No migrations to apply!`（本版不加迁移） |
| D1 备份 | `npx wrangler d1 export guandao-db --remote --output ...\guandao-db-prod-20261123-1415.sql` → **668,753 B** |
| 部署 | `npm run cf:deploy` exit 0 → 30 页、`Uploaded my-homepage`、`Total Upload: 755.29 KiB / gzip: 167.31 KiB`、Worker Startup 5 ms、**Version `c6444ff6-5fd6-439b-b2c7-6296e2a9aa1f`** |
| 生产核对 | `/api/health` → `"version":"2.0.11"`、D1 connected、R2 available（put/get/head/delete 全 true）；header `x-guandao-version: 2.0.11`；首页 200（27,812 B）；入口 `index.astro_astro_type_script_index_0_lang.C3KRcFM4.js`（453,522 B，含 `2.0.11`）；`/sw.js` → `guandao-2.0.11` |
| 生产端到端 | `npm run qa:prod` → **35/35 通过**、清理 `{"users":0}`（既有 `event_type` CHECK 警告仍在，exit 0） |
| 回滚目标 | 2.0.10：Version `b207dbcb-09d9-4f30-943e-37a281d4de56` |
| 推送后 | push 会触发 Cloudflare 自动构建（再生成一个 Version），CI 用 `curl.exe --resolve api.github.com:443:140.82.113.6` 复核 |

## 6. 未修 / 边界

1. **多区间 Range**（`Range: bytes=0-1,4-5`）：服务端忽略并返回 200 整包，符合 RFC 7233；
   不实现 multipart/byteranges（成本高、收益低），单区间与不可满足区间已在 2.0.9/2.0.10 修好。
2. **需迁移项**（继续挂起，STATUS 风险 16）：
   - `POST /posts/:id/view` 与 `GET /posts/:id/package?count=1` 的计数幂等（需要「谁在什么时候看过」表）；
   - 社区图片上传配额预占（需要 pending 行）。
3. **证据边界**：
   - 备份去重与插件名额的「真正并发」由真实 SQLite 单测证明；Worker 层没有并发 E2E（本地无法稳定造交错）。
   - 窗口/布局两条只做纯逻辑单测：真浏览器里重复 emit 与窗口重叠不影响可操作性，肉眼难判定。
   - 同步游标 E2E 只验证「两页不重不漏」与非法游标 400；同毫秒分页由 SQLite 单测证明。
4. **入口体积**：2.0.8 起入口 JS 440.5 KB / 439.5 KB（100.2%）为已知技术债，STATUS 风险 18；
   本版未改客户端主路径代码之外的东西，体积不变。