> **Phase 1.6 更新（2026-11-07）**：监控指标已扩展到 security_events / ccount_deletion_audit / data_deletion_jobs，并新增独立 R2 备份的 26 小时 stale / failed / unknown 检查；完整说明见 [operations/D1-MONITORING.md](operations/D1-MONITORING.md)。生产已部署（版本 6928916f）；备份成功，告警 Webhook 未配置。

# 生产用户数据异常监控

**状态**：代码与迁移已部署；生产备份成功；**告警通知未配置**。

---

## 1. 监控范围

| 表 | 指标 | 重要性 |
| --- | --- | --- |
| `users` | 总数 | 最高 |
| `sessions` | 总数 | 高 |
| `devices` | 总数 | 高 |
| `files` | 总数 | 中 |
| `backups` | 总数 | 中 |
| `sync_entities` | 总数 | 中 |

只做 `COUNT(*)`，不读取任何用户内容、Token、Cookie。

---

## 2. 检测规则

| Code | 条件 | 级别 |
| --- | --- | --- |
| `USERS_ZERO` | 上次 users > 0，本次 users = 0 | critical |
| `USERS_DROP` | users 下降但未归零 | warning |
| `SESSIONS_DEVICES_ZERO` | users > 0，但 sessions = 0 且 devices = 0 | critical |
| `DATA_DROP_FILES` | files 基线 ≥ 10 且本次 < 50% | warning |
| `DATA_DROP_BACKUPS` | backups 基线 ≥ 10 且本次 < 50% | warning |
| `DATA_DROP_SYNC_ENTITIES` | sync 基线 ≥ 10 且本次 < 50% | warning |
| `MONITOR_ERROR` | 监控查询失败 | warning |

所有告警文案都带「需要人工核查」，因为**合法的账号注销**也会导致数量下降。

---

## 3. 基线、快照与重复抑制

- 每次运行把当前计数写入 `data_monitor_snapshots`（保留查询最近 50 条）；
- 基线保存在 `data_monitor_state`（`monitor.baseline`），首次运行以当前值为基线；
- 告警写入 `data_monitor_alerts`；
- 相同 `dedupe_key` 在 **6 小时**内不重复写告警；
- users 恢复 > 0 时，`USERS_ZERO` / `SESSIONS_DEVICES_ZERO` 自动标记 resolved；
- 管理者可 `POST /api/admin/data-monitor/alerts/:id/ack` 确认。

---

## 4. 调度

使用现有 Worker Cron `*/15 * * * *`，在 `scheduled()` 中新增：

```js
ctx.waitUntil(runDataMonitor(env).catch(...))
```

- 只读统计；
- 任何异常都被捕获，不影响正常请求；
- 监控失败会写 `MONITOR_ERROR` 告警（表存在时）。

**注意**：迁移 `0015_data_monitor.sql` 尚未应用到生产；在应用前，监控任务会因表不存在而失败（不会影响请求）。

---

## 5. 告警通知

- 支持可选 `DATA_ALERT_WEBHOOK`（Worker secret）；
- 未配置时：只写数据库，`notificationConfigured=false`，**不伪造送达**；
- Webhook payload 只含：`type / at / severity / code / message / metrics / requiresHumanReview`；
- 发送失败会写入 `notify_error`，并仍保留数据库告警；
- 当前项目**没有**配置该 Secret，也没有验证过任何外部通知送达。

### 配置后如何验证

1. `wrangler secret put DATA_ALERT_WEBHOOK`（HTTPS 端点）；
2. 在本地/隔离环境触发一次 `runDataMonitor` 或调用测试 webhook；
3. 确认外部服务收到 `guandao.data.alert`，且不含用户内容；
4. 在 `/api/admin/data-monitor` 中确认 `notificationConfigured=true` 与 `notifiedAt`。

---

## 6. 管理员接口

| 方法 | 路径 | 权限 |
| --- | --- | --- |
| GET | `/api/admin/data-monitor` | 管理员 |
| POST | `/api/admin/data-monitor/alerts/:id/ack` | 管理员 + 同源 |

返回：最近 50 条快照、最近 50 条告警、state、通知是否配置。
不返回任何用户内容。

---

## 7. 测试（本地）

`npm run qa:data-monitor` **9/9**：

1. users 正常增长不告警；
2. users 下降告警；
3. users 归零 critical；
4. sessions/devices 同时归零 critical；
5. 重要表下降告警；
6. 6 小时内重复抑制；
7. 监控失败告警；
8. 指标白名单 + Webhook 不含敏感字段。

**生产状态**：迁移已应用、Worker 已部署、备份成功；Webhook 未配置。

---

## 8. 启用步骤（需要所有者授权）

1. 本地 `wrangler d1 migrations apply guandao-db --local` 验证 0015；
2. 生产应用迁移（单独授权，本专项未执行）；
3. 部署 Worker；
4. 配置 `DATA_ALERT_WEBHOOK`（可选）；
5. 只读检查 `/api/admin/data-monitor`；
6. 观察 24 小时快照，确认基线合理；
7. 不要通过删除真实数据测试告警；用本地/隔离库验证。