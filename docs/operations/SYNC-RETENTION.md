# 云同步配额、墓碑 TTL 与保留策略（Phase 4.4）

> 状态：本地与 CI 已验证（`Accepted (Local/CI)`）；生产迁移与生产验证未执行（Phase 1.6 门禁：备份告警未配置、2026-11-06 账号删除事故未 Closed）。
> 范围：`worker/api/sync/**`、`migrations/0018_sync_cloud_expansion.sql`、`worker/index.js` 的 Cron 维护。

## 1. 数据模型

`sync_entities` 是同步的唯一存储：主键 `(user_id, domain, entity_id)`，五域 `notes / tasks / calendar / workspace / preferences`，字段含 `revision`、`deleted`、`deleted_at`、`payload_json`、`updated_at`。

- 活实体：`deleted = 0`、`deleted_at IS NULL`、`payload_json` 必须是合法 JSON。
- 墓碑：`deleted = 1`、`payload_json IS NULL`、`deleted_at = 删除时的 updated_at`。
- 迁移 0018 重建表以放宽域 CHECK 并新增 `deleted_at`；旧表保留为 `sync_entities_legacy_v1`（不 DROP，可回滚）。
- `sync_tombstone_ledger`：墓碑被物理清理后仍保留「最后删除 revision + deleted_at」，用于拦截旧设备复活。
- `sync_cleanup_log`：每次清理一行（`status ok|error`、`cutoff`、`scanned`、`purged`、`detail`），只保留最近 200 行。

## 2. 配额与上限

| 维度 | 值 | 行为 |
| --- | --- | --- |
| 单实体 payload（默认，含 notes/tasks/calendar） | 128 KB | 超出 → `400 PAYLOAD_TOO_LARGE` |
| 单实体 payload（workspace） | 128 KB | 同上 |
| 单实体 payload（preferences） | 32 KB | 超出 → `400 PAYLOAD_TOO_LARGE` |
| 单用户活实体数 | 5000 | 超出 → `409 QUOTA_EXCEEDED`，`details.scope="entities"` |
| 单用户墓碑数 | 2000 | 超出 → `409 QUOTA_EXCEEDED`，`details.scope="tombstones"` |
| 单次 push 批大小 | 100 | 超出 → `400 BATCH_TOO_LARGE` |
| 单次请求体 | 768 KB | Worker 读体上限 |
| 单次 index/pull 返回 | 500（index 最多 10000 行，带 `truncated`） | 客户端按 `hasMore` 分页 |
| 单次按 id 拉取 | 200 个 id | 超出 → `400 TOO_MANY_IDS` |

- 配额在**写入前**估算（`estimateQuotaDelta`）；重复 id 保守多算，并发下可能提前拒绝，但不会超卖。
- 超限只拒绝本次写入，**不静默删除任何用户数据**；返回错误码与 scope 供 UI 提示。
- 旧三域（notes/tasks/calendar）的容量语义不变（仍为 128 KB/条），新增域不会挤占其单条上限。
- `GET /api/sync/status` 返回 `quotas: { entityCount, tombstoneCount, limits:{ maxEntities, maxTombstones } }`，供系统设置展示。

## 3. 墓碑 TTL（90 天）

- `TOMBSTONE_TTL_DAYS = 90`；`deleted_at < now - 90d` 的墓碑才可清理，**严格大于** TTL 才算过期。
- 清理流程（`purgeExpiredTombstones`）：
  1. 按 `deleted = 1 AND deleted_at < cutoff ORDER BY deleted_at` 取一批（≤200）；
  2. 先把每条的 `revision/deleted_at` upsert 进 `sync_tombstone_ledger`（仅 revision 更大时覆盖）；
  3. 再 DELETE 这些墓碑行；
  4. 返回 `{ scanned, purged, cutoff }`，可重复执行（幂等）。
- 防复活：实体行已不存在、但台账存在且 `baseRevision < ledger.revision` → `applyChange` 返回合成 `deleted` 冲突；客户端删除本地，不会把旧数据写回。
- 不删除非墓碑、不删除未过期墓碑、不跨用户；旧设备拿旧 revision 重推会被台账拦下。
- **安全前提**：现状无法证明「所有设备都已收到删除信息」（无持久化的 per-device sync state 水位），因此实现采用「TTL + 台账」而不是纯物理删除：即使设备离线超过 90 天，旧 revision 也会被台账判定为冲突而不是复活。若未来做更激进的清理，必须先补齐设备水位记录。

## 4. 定时维护

- 复用现有 `*/15 * * * *` Cron（`worker/index.js` 的 `scheduled`），新增一条独立 `ctx.waitUntil(runSyncTombstoneMaintenance(env).catch(...))`：
  - 单次最多清理 2000 条，按 200/批循环，批未满即提前结束；
  - 任何异常在内部捕获并写 `sync_cleanup_log(status="error")`，绝不向 `scheduled` 抛出，不影响备份/隐私/社区等既有任务；
  - 失败后下一轮 Cron 自动重试（清理幂等）；
  - 每轮写一行审计日志，日志表裁剪到最近 200 行。
- 不新建第二个 Cron，不改动既有定时任务的时间与顺序。

## 5. 迁移与回滚

- 迁移 `0018_sync_cloud_expansion.sql` 仅本地 D1 验证过（`.wrangler`），**未应用到生产 D1**。
- 迁移内容：重命名旧表 → 新建 5 域表（含 `deleted_at`）→ 复制数据（历史墓碑 `deleted_at=updated_at`）→ 重建索引 → 建台账与清理日志表。
- 回滚：应用侧回退代码后，把 `sync_entities_legacy_v1` 改回 `sync_entities` 并重建 0014 的两个索引；迁移不删除用户数据。
- 生产启用步骤（需人工批准，本阶段未执行）：
  1. 确认 Phase 1.6 备份/告警与事故状态满足门禁；
  2. 先在生产执行迁移（经批准的 workflow），核对表结构与行数；
  3. 验证 `/api/sync/status` 的 domains/quotas、旧三域读写、双设备增量；
  4. 观察 `sync_cleanup_log` 首轮 `status=ok` 后再启用前端；
  5. 配置清理失败告警（复用现有备份告警通道）。

## 6. 测试证据

| 层级 | 证据 | 结果 |
| --- | --- | --- |
| 单测 | `tests/unit/sync-limits.test.ts`（TTL/域上限/配额常量纯函数） | 10 通过 |
| 单测 | `tests/unit/sync-store.test.ts`（node:sqlite 内存库跑 0014+0018 真实迁移；配额、清理、台账防复活） | 16 通过 |
| 协议 | `scripts/sync-qa.mjs`（含 `wrangler dev --test-scheduled` 触发 Cron） | 45/45 通过 |

`qa:sync` 覆盖：workspace 100KB 通过、preferences 40KB → 400、未知域 400、第 5001 个实体 → 409、Cron 清理过期墓碑、未过期保留、台账 revision 保留、旧 revision 重推返回 deleted 冲突、以 ledger revision 重建成功、二次清理 `purged=0` 幂等。

## 7. 已知风险与限制

- 配额估算在并发写入时可能略微保守（提前拒绝），不会超额写入；极端情况下用户会看到一次可重试的 409。
- D1 的 IN 参数上限通过分块规避（≤100 个/批），大用户量下的查询耗时仍需在生产观测。
- 90 天 TTL 是产品折中；若设备离线超过 90 天且期间数据被删除，其本地副本会在下次同步时被判冲突并删除，这是预期行为。
- 生产未执行迁移/清理；本地 `.wrangler` D1 已应用到 0018。
- 清理日志目前仅表内保留，不接入外部告警；生产启用前建议补告警。

## 8. 变更文件

- `migrations/0018_sync_cloud_expansion.sql`（新增）
- `worker/api/sync/limits.js`、`maintenance.js`（新增）
- `worker/api/sync/store.js`（`deleted_at`、台账、额度统计、清理）
- `worker/api/sync/handlers.js`（status quotas、按域 payload、配额校验）
- `worker/index.js`（Cron 挂载）
- 测试：`tests/unit/sync-limits.test.ts`、`tests/unit/sync-store.test.ts`、`scripts/sync-qa.mjs`
