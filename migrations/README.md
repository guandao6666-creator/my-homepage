# 数据库迁移（Cloudflare D1）

本目录是 Guandao OS 后端唯一的数据库变更入口。所有表结构变更都必须以新的
`000N_描述.sql` 文件提交，**不允许**在控制台手工改线上表。

## 文件约定

```
migrations/
  0001_init.sql          基础表结构（users / devices / notes / files / sync_changes / backups）
  0002_account.sql       GitHub 身份字段、sessions、oauth_states、setup_tickets
  0003_xxx.sql           下一次变更
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

## 安全边界（本阶段）

- 表已建好，但**没有任何对外数据接口**。在身份认证完成之前，任何读写路由都无法
  可靠判断 `user_id` 归属，开放即等于越权。
- 所有业务表都有 `user_id` 字段和 `(user_id, ...)` 复合索引；后续接口必须从会话
  解析用户身份，禁止接受客户端传入的 `user_id`。
- 迁移脚本中不得写入真实用户数据、密钥或令牌。
- D1 绑定名固定为 `DB`，R2 绑定名固定为 `FILES`，不要在代码里写死资源 ID。
