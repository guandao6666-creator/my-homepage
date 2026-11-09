# 数据库迁移（Cloudflare D1）

本目录是 Guandao OS 后端唯一的数据库变更入口。所有表结构变更都必须以新的
`000N_描述.sql` 文件提交，**不允许**在控制台手工改线上表。

## 文件约定

```
migrations/
  0001_init.sql          基础表结构（users / devices / notes / files / sync_changes / backups）
  0002_account.sql       GitHub 身份字段、sessions、oauth_states、setup_tickets
  0003_cloud_drive.sql   files 扩展、folders、multipart_uploads、file_events
  0004_devices.sql       设备字段扩展、session revoked_at、device_activity、device_sync_state
  0005_device_names.sql  旧自动设备名归一化为 My Desktop / Laptop / Tablet / Phone
  0006_backups.sql       备份扩展、backup_jobs / backup_items / backup_settings / backup_restores
  0007_privacy_security.sql  安全事件、隐私设置、导出、删除任务、注销票据与审计
  0008_rate_limit.sql        固定窗口限流计数（rate_limits）
  0009_community.sql         社区资料、作品、内容包版本、互动、举报、审核、通知、设置与邀请
  0010_plugins.sql           插件元数据、版本、安装、权限、评价、举报、审计、开发者与下载事件
  0011_continuity.sql        设备配对、接力内容、设备上下文与跨设备剪贴板
  0012_indexes.sql           1.9 热点查询索引
  0013_index_fixes.sql       2.0 索引名冲突修正 + 备份分页索引
```

- 文件名必须符合 `^[0-9]{4}_[a-z0-9_]+\.sql$`，Wrangler 按编号顺序执行；
- 已执行过的迁移**不可修改**，需要改结构就新增一条；
- 每条迁移尽量只做一件事，便于定位问题；
- 只允许增量操作：`CREATE TABLE IF NOT EXISTS`、`CREATE INDEX IF NOT EXISTS`、`ALTER TABLE ... ADD COLUMN`。
  `DROP TABLE` / `DROP COLUMN` / 批量 `DELETE` 必须先备份并在评审中单独说明。

Wrangler 会在数据库里自动维护 `d1_migrations` 表，记录已执行的迁移文件名，
重复执行 `apply` 不会重复跑同一条迁移。

## 首次配置

```bash
npx wrangler login      # 只需一次
npm run cf:link         # 读取 guandao-db 的真实 UUID，写入 wrangler.jsonc
```

`cf:link` 只改 `wrangler.jsonc` 里的 `d1_databases` 字段，不会动其他配置。
如果已经知道 database_id，也可以 `npm run cf:link -- --id <uuid>`。

## 执行迁移

```bash
npm run db:migrate:local     # 写入本地 Miniflare 的 SQLite（.wrangler/state）
npm run db:migrate:remote    # 写入线上 guandao-db
npm run db:migrations:list   # 查看线上已执行 / 待执行的迁移
```

本地迁移是 `npm run cf:dev` 的前置步骤：本地 D1 是一个独立的 SQLite 文件，
不执行迁移就会报表不存在。

线上迁移建议在低峰期执行，并在执行前确认：

```bash
npx wrangler d1 execute guandao-db --remote --command "SELECT name FROM sqlite_master WHERE type='table'"
```

## 回滚

D1 支持 Time Travel（30 天内）：

```bash
npx wrangler d1 time-travel info guandao-db --remote
npx wrangler d1 time-travel restore guandao-db --remote --timestamp=<unix 秒>
```

Time Travel 是整库回滚，会连同期间写入的业务数据一起回退。生产环境执行前
先把当前数据导出：

```bash
npx wrangler d1 export guandao-db --remote --output=backup-$(date +%Y%m%d).sql
```

## 安全边界（2.0 更新）

- 所有业务接口都从 Session 解析 `user_id`，禁止接受客户端传入的 `user_id`；
  所有用户数据查询都带 `user_id`（2.0 审计抽样复核过约 200 处 `DB.prepare`）。
- 迁移脚本中不得写入真实用户数据、密钥或令牌。
- D1 绑定名固定为 `DB`，R2 绑定名固定为 `FILES`，不要在代码里写死资源 ID。
- 2.0 起迁移必须通过 `npm run check:migrations`：编号连续、索引带 `IF NOT EXISTS`、
  不允许同名索引定义冲突、禁止 `DROP TABLE` / `DROP COLUMN`。
