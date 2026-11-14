# 安全事件日志

**状态**：事件类型 / 过滤 / 测试完成；**尚未部署到生产**。

---

## 1. 现有机制

- 表：`security_events`（D1，`user_id` 可空，`ON DELETE SET NULL`）；
- 写入：`worker/api/privacy/events.js` 的 `logSecurityEvent`；
- 白名单：`SECURITY_EVENT_TYPES`；
- metadata 白名单：`safeMetadata`；
- 读取：`GET /api/security/activity`，**按当前 Session 的 user_id 过滤**，普通用户只能看自己的事件；
- 保留：`pruneSecurityEvents` 保留 180 天（随隐私清理执行）。

---

## 2. 本次新增事件

| 事件 | 触发点 | 用途 |
| --- | --- | --- |
| `account_deletion_failed` | 注销流程 catch | 记录失败阶段与错误码 |
| `account_deletion_r2_retry` | R2 前缀删除重试 | 已有代码，现已加入白名单 |
| `account_deletion_r2_incomplete` | 重试耗尽 | 已有代码，现已加入白名单 |
| `data_monitor_alert` | 监控写告警 | 监控事件可追溯 |
| `data_monitor_acknowledged` | 管理员确认告警 | 谁确认了哪条告警 |
| `data_backup_completed` | 备份脚本本地审计 | 备份成功（本地 JSONL，不入 D1） |
| `data_backup_failed` | 备份脚本异常 | 备份失败（本地 JSONL，不入 D1） |
| `qa_cleanup_started` | `prod-e2e` 清理入口 | QA 清理开始 |
| `qa_cleanup_completed` | 清理完成 | QA 清理结束 |

> `qa_cleanup_*` 只在运行 `qa:prod` 时写入；本专项**没有运行** qa:prod，因此生产暂无这两类事件。

---

## 3. 记录字段

| 字段 | 说明 |
| --- | --- |
| `id` | UUID |
| `created_at` | 毫秒时间戳 |
| `event_type` | 白名单事件 |
| `user_id` | 关联用户；删除后由 FK 置 NULL |
| `device_id` | 可选 |
| `result` | success / failure / blocked |
| `metadata_json` | 白名单键，≤1500 字符 |

允许的 metadata 键包括：`reason`、`count`、`stage`、`code`、`errorCode`、`severity`、`alertId`、`jobId`、`backupId`、`runId`、`table`、`sha256Prefix` 等。

---

## 4. 敏感数据过滤

`safeMetadata` 只保留白名单键，并：

- 字符串截断到 120 字符；
- 数组最多 10 项、每项 40 字符；
- 对象只保留布尔/数字；
- `token`、`cookie`、`secret`、`password`、`email`、`authorization` 等键**不会**进入日志；
- SQL 内容、文件内容、笔记正文、完整用户数据不记录。

测试 `npm run qa:security-log` **6/6** 验证了 Token/Cookie/Secret/邮箱不会落库，以及写入失败不抛异常。

---

## 5. 日志失败与访问控制

- `logSecurityEvent` 内部 `try/catch`，日志失败只 `console.error`，不中断业务；
- 日志失败目前**不会**自动告警（Worker 无持久日志）；建议后续把连续失败纳入监控；
- 普通用户只能读取自己的事件；
- 管理员监控数据通过 `/api/admin/data-monitor`，不含事件正文；
- 没有公开的全局安全日志接口。

---

## 6. 保留与清理

- `pruneSecurityEvents` 保留 180 天；
- 删除用户时 `security_events.user_id` 置 NULL，事件保留（最小化审计）；
- 账号删除审计表 `account_deletion_audit` 不含邮箱/用户名，长期保留。

---

## 7. 尚未完成

1. 生产 Worker 未部署本次日志变更；
2. 备份脚本的 `data_backup_*` 事件只写本地 `backups/d1/audit.log`，没有写入生产 D1；
3. 日志写入失败没有独立告警；
4. 没有请求级持久日志（本次仅做安全事件，不做全量请求日志）。

以上必须在文档中保持“未启用”，不能写成“已生产验证”。