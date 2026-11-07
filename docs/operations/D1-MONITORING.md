# D1 数据与备份监控

**状态**：代码已部署（版本 6928916f），0015/0016 已应用；**备份成功、通知未配置**。

---

## 1. 监控入口

| 入口 | 频率 | 作用 |
| --- | --- | --- |
| Worker Cron `*/15 * * * *` → `runDataMonitor` | 15 分钟 | 用户/会话/设备/关键表数量检查 |
| Worker Cron → `runBackupMonitor` | 15 分钟 | 读取独立 R2 备份状态，检查失败/过期/unknown |
| `GET /api/admin/data-monitor` | 手动 | 管理员查看快照与告警 |
| `GET /api/admin/backup-status` | 手动 | 管理员查看备份状态与最近运行 |
| `node scripts/backup-status.mjs --file ...` | 手动/脚本 | 本地状态文件检查 |
| `node scripts/backup-status.mjs --remote` | 手动 | 只读查询 `d1_backup_runs` |

监控只读；不会修改业务数据。

---

## 2. 数据量指标

`METRIC_TABLES`：

```text
users
sessions
devices
files
backups
sync_entities
security_events
account_deletion_audit
data_deletion_jobs
```

只统计 `COUNT(*)`，不读取用户隐私字段。

### 规则

| Code | 条件 | 级别 |
| --- | --- | --- |
| `USERS_ZERO` | 上次 users > 0，本次 = 0 | critical |
| `USERS_DROP` | users 下降但未归零 | warning |
| `SESSIONS_DEVICES_ZERO` | users > 0，sessions = 0 且 devices = 0 | critical |
| `DATA_DROP_FILES` | files 基线 ≥ 10 且本次 < 50% | warning |
| `DATA_DROP_BACKUPS` | backups 基线 ≥ 10 且本次 < 50% | warning |
| `DATA_DROP_SYNC_ENTITIES` | sync 基线 ≥ 10 且本次 < 50% | warning |
| `MONITOR_ERROR` | 查询/状态读取失败 | warning |

**注意**：

- Session 正常过期不等于账号被删除；
- 只有 `users > 0` 且 sessions/devices **同时为 0** 才触发账号关系 critical；
- 合法注销会造成数量下降，告警文字统一标记「需要人工核查」。

---

## 3. 备份状态规则

来源：`DB_BACKUPS/logs/backup-status.json`（Workflow 每次运行写入）。

| 状态 | 条件 | 告警 |
| --- | --- | --- |
| `healthy` | 有成功记录，且距今 ≤ 26 小时 | 不告警；resolve 旧 `BACKUP_*` |
| `stale` | 成功记录 > 26 小时 | `BACKUP_STALE` critical |
| `failed` | 最近一次 run 为 failed | `BACKUP_FAILED` critical |
| `unknown` | 无绑定、无对象、JSON 损坏、无成功记录 | `BACKUP_STATUS_UNKNOWN` warning |

**unknown 绝不显示为 healthy。**
阈值 `STALE_MS = 26h` 给每日 19:00 UTC 备份留出 2 小时余量；连续失败超过 26h 必然触发。

告警去重：同一 code 6 小时内只写一次；恢复后标记 resolved。

---

## 4. 告警存储与通知

### 数据库

`data_monitor_alerts`（迁移 0015）：

- `severity`：warning / critical；
- `status`：open / acknowledged / resolved；
- `metrics_json` 只含计数/状态；
- `notified_at` / `notify_error` 记录通知结果。

管理员可以 `POST /api/admin/data-monitor/alerts/:id/ack` 确认。

### 通知渠道

| 变量 | 用途 | 当前 |
| --- | --- | --- |
| `DATA_ALERT_WEBHOOK` | 数据量/备份监控告警 | **代码链路已验证；Cloudflare 上未配置** |
| `BACKUP_ALERT_WEBHOOK` | Workflow 备份失败告警 | **代码链路已验证；Cloudflare 上未配置** |

- 未配置时**只写数据库**，不伪造送达；
- 发送失败写入 `notify_error`，不丢弃告警；
- Webhook payload 只含失败类型、时间、runId、恢复建议；
- 不包含 Token、signed_url、SQL、Cookie、用户数据。

### 真实送达已验证（2026-11-07）

`npm run qa:alerts`（`scripts/alert-delivery-check.mjs`）**16/16 通过**：

- 只 Mock「D1 导出/下载」与「D1 数据库」，**Webhook 走真实外部 HTTPS**；
- 接收端（webhook.site）实际收到 `guandao.backup.alert` 与 `guandao.data.alert`；
- 两条链路都写入正确的 `notifiedAt`，且 `notifyError` 为空；
- payload 经断言不含 Token / SQL / 邮箱。

> 这证明**告警能真实送出去**，但**不证明生产已配置**：两个 Secret 仍未设置，
> 生产 Workflow 的下一次失败不会外发。

### 怎么验证真的送达

1. 配置一个受控 HTTPS 测试 Webhook；
2. 用本地 Mock 或隔离环境触发一次失败（不要删生产数据）；
3. 确认外部服务收到 `guandao.backup.alert` / `guandao.data.alert`；
4. 在 `/api/admin/backup-status` 或 `data_monitor_alerts` 中确认 `notified_at` 非空；
5. 失败时应有 `notify_error`，而不是“成功”。

---

## 5. 状态 CLI

```bash
# 从本地下载的 status JSON
node scripts/backup-status.mjs --file ./backup-status.json --check

# 只读查询 D1 d1_backup_runs（不写）
node scripts/backup-status.mjs --remote --check
```

输出 `health.state` / `lastSuccessAt` / `lastRun` / `alert`。

退出码：

- `0`：healthy；
- `2`：`--check` 且 stale/failed/unknown；
- `1`：参数/文件读取错误。

缺失文件/损坏 JSON 会返回 `unknown`，不会假装 healthy。

---

## 6. Cron 接入

`worker/index.js` 的 `scheduled()` 已增加：

```js
ctx.waitUntil(runBackupMonitor(env).catch(...))
```

- 失败只记录日志，不影响请求；
- 无 `DB_BACKUPS` 时返回 unknown（并写告警，若表存在）；
- 当前生产**未部署**；`0015` / `0016` 迁移**未应用生产**。

---

## 7. 本地测试

| 测试 | 结果 |
| --- | --- |
| `npm run qa:data-monitor` | **9/9** |
| `npm run qa:d1-backup` | **11/11**（含 stale 告警、unknown） |
| `npm run backup:status -- --file <status.json>`（手动） | healthy 输出正常 |
| `npm run qa:alerts` | **16/16**（真实外部 HTTPS 送达，非 Mock） |
| 生产告警送达 | **代码链路已验证；生产未配置** |

测试覆盖：

- users 1→0 critical；
- users 正常增长不误报；
- Session 正常过期不触发账号删除；
- 26h stale critical；
- Webhook 不可用保留 notify_error；
- 缺失状态显示 unknown；
- 监控失败不伪装正常。

---

## 8. 仍需所有者操作

1. 应用 `0015_data_monitor.sql`、`0016_d1_backup.sql`（独立授权）；
2. 部署 Worker（本阶段禁止）；
3. 配置 `DATA_ALERT_WEBHOOK` / `BACKUP_ALERT_WEBHOOK`；
4. 用受控 Webhook 验证送达；
5. 观察 24 小时快照，确认基线合理；
6. 不要通过删除生产数据测试告警。