/**
 * Guandao OS 2.0 · Phase 4 同步存储层（D1）
 *
 * 这里用一个真实的 SQLite（node:sqlite 内存库）跑 migrations/0014 + 0018，
 * 再用迷你 D1 适配器驱动 store.js：不 mock SQL，而是验证乐观锁、墓碑台账、
 * 防复活、配额统计在真实约束（CHECK / PRIMARY KEY / ON CONFLICT）下成立。
 */
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";

import {
  applyChange,
  domainStats,
  estimateQuotaDelta,
  listByIds,
  listChanges,
  listIndex,
  purgeExpiredTombstones,
  userQuotaStats,
} from "../../worker/api/sync/store.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const MIGRATION_0014 = readFileSync(new URL("../../migrations/0014_sync.sql", import.meta.url), "utf8");
const MIGRATION_0018 = readFileSync(
  new URL("../../migrations/0018_sync_cloud_expansion.sql", import.meta.url),
  "utf8",
);
const USER_A = "test-user-a";
const USER_B = "test-user-b";

type Row = Record<string, unknown>;
type SqlValue = null | number | bigint | string | Uint8Array;

interface LooseStatement {
  all(...params: SqlValue[]): Row[];
  get(...params: SqlValue[]): Row | undefined;
  run(...params: SqlValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
}

interface SyncEntity {
  id: string;
  revision: number;
  deleted: boolean;
  updatedAt: number;
  deletedAt?: number | null;
  payload?: unknown;
}

/** 只读快照的类型断言：store.js 是 JS，JSDoc 把 entity 标成 object。 */
const asEntity = (value: unknown) => value as SyncEntity;

/** 最小 D1 适配器：store.js 只用到 prepare().bind().first()/.all()/.run()。 */
class FakeStatement {
  constructor(
    private readonly db: DatabaseSync,
    private readonly sql: string,
    private readonly params: SqlValue[] = [],
  ) {}

  bind(...params: SqlValue[]) {
    return new FakeStatement(this.db, this.sql, params);
  }

  private statement() {
    return this.db.prepare(this.sql) as unknown as LooseStatement;
  }

  async first() {
    return this.statement().get(...this.params) ?? null;
  }

  async all() {
    return { results: this.statement().all(...this.params), success: true, meta: { changes: 0 } };
  }

  async run() {
    const info = this.statement().run(...this.params);
    return {
      success: true,
      meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) },
    };
  }
}

class FakeD1 {
  constructor(private readonly db: DatabaseSync) {}

  prepare(sql: string) {
    return new FakeStatement(this.db, sql);
  }
}

function createDatabase() {
  const db = new DatabaseSync(":memory:");
  // 同步表与台账都有 `REFERENCES users (id)`，内存库默认开启外键检查，所以先建 users。
  db.exec("CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT);");
  db.exec(MIGRATION_0014);
  db.exec(MIGRATION_0018);
  const insertUser = db.prepare("INSERT INTO users (id, email) VALUES (?, ?)");
  insertUser.run(USER_A, "a@example.test");
  insertUser.run(USER_B, "b@example.test");
  return db;
}

interface EntitySeed {
  userId?: string;
  domain?: string;
  id: string;
  revision?: number;
  deleted?: number;
  payload?: string | null;
  updatedAt?: number;
  deletedAt?: number | null;
}

function insertEntity(db: DatabaseSync, seed: EntitySeed) {
  db.prepare(
    `INSERT OR REPLACE INTO sync_entities
       (user_id, domain, entity_id, revision, deleted, payload_json, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    seed.userId ?? USER_A,
    seed.domain ?? "notes",
    seed.id,
    seed.revision ?? 1,
    seed.deleted ?? 0,
    seed.payload ?? null,
    seed.updatedAt ?? 1000,
    seed.deletedAt ?? null,
  );
}

function readEntity(db: DatabaseSync, userId = USER_A, domain = "notes", id: string) {
  return db
    .prepare(
      `SELECT revision, deleted, payload_json, updated_at, deleted_at
         FROM sync_entities WHERE user_id = ? AND domain = ? AND entity_id = ?`,
    )
    .get(userId, domain, id) as Row | undefined;
}

function readLedger(db: DatabaseSync, userId = USER_A, domain = "notes", id: string) {
  return db
    .prepare(
      `SELECT revision, deleted_at FROM sync_tombstone_ledger
        WHERE user_id = ? AND domain = ? AND entity_id = ?`,
    )
    .get(userId, domain, id) as Row | undefined;
}

describe("applyChange 乐观锁", () => {
  let db: DatabaseSync;
  let env: { DB: FakeD1 };

  beforeEach(() => {
    db = createDatabase();
    env = { DB: new FakeD1(db) };
  });

  it("首次推送写入 revision 1，返回活实体快照", async () => {
    const result = await applyChange(env, USER_A, "notes", {
      id: "n1",
      baseRevision: 0,
      updatedAt: 1000,
      payload: { title: "第一条" },
    });

    expect(result.outcome).toBe("applied");
    expect(result.entity).toMatchObject({
      id: "n1",
      revision: 1,
      deleted: false,
      updatedAt: 1001, // max(1024 时间戳, 库里的 0) + 1
      payload: { title: "第一条" },
    });
    expect(asEntity(result.entity).deletedAt).toBeUndefined();
    expect(readEntity(db, USER_A, "notes", "n1")).toMatchObject({
      revision: 1,
      deleted: 0,
      deleted_at: null,
    });
  });

  it("库里 revision 更大时返回冲突，不覆盖服务端数据", async () => {
    await applyChange(env, USER_A, "notes", {
      id: "n1",
      baseRevision: 0,
      updatedAt: 1000,
      payload: { title: "服务端" },
    });

    const conflict = await applyChange(env, USER_A, "notes", {
      id: "n1",
      baseRevision: 0,
      updatedAt: 2000,
      payload: { title: "并发覆盖" },
    });

    expect(conflict.outcome).toBe("conflict");
    expect(conflict.entity).toMatchObject({ revision: 1, payload: { title: "服务端" } });
    expect(readEntity(db, USER_A, "notes", "n1")).toMatchObject({ revision: 1 });
  });

  it("revision 一致时更新为 revision + 1，updatedAt 单调不倒退", async () => {
    await applyChange(env, USER_A, "notes", { id: "n1", baseRevision: 0, updatedAt: 5000, payload: { v: 1 } });
    const updated = await applyChange(env, USER_A, "notes", {
      id: "n1",
      baseRevision: 1,
      updatedAt: 3000, // 客户端时钟比上次写入还早，服务端仍要保证单调
      payload: { v: 2 },
    });

    expect(updated.outcome).toBe("applied");
    const updatedEntity = asEntity(updated.entity);
    expect(updatedEntity.revision).toBe(2);
    expect(updatedEntity.updatedAt).toBe(5002); // 上次写入是 5001，再 +1
    expect(updatedEntity.payload).toEqual({ v: 2 });
  });

  it("删除写入墓碑（deleted_at）并记台账", async () => {
    await applyChange(env, USER_A, "notes", { id: "n1", baseRevision: 0, updatedAt: 1000, payload: { v: 1 } });
    const removed = await applyChange(env, USER_A, "notes", {
      id: "n1",
      baseRevision: 1,
      deleted: true,
      updatedAt: 7000,
    });

    expect(removed.outcome).toBe("applied");
    expect(removed.entity).toEqual({
      id: "n1",
      revision: 2,
      deleted: true,
      updatedAt: 7001,
      deletedAt: 7001,
    });
    expect(readEntity(db, USER_A, "notes", "n1")).toMatchObject({
      revision: 2,
      deleted: 1,
      payload_json: null,
      deleted_at: 7001,
    });
    expect(readLedger(db, USER_A, "notes", "n1")).toMatchObject({ revision: 2, deleted_at: 7001 });
  });

  it("五个数据域都可写入（workspace / preferences 是 Phase 4 新增）", async () => {
    for (const domain of ["workspace", "preferences"] as const) {
      const result = await applyChange(env, USER_A, domain, {
        id: `${domain}-1`,
        baseRevision: 0,
        updatedAt: 1000,
        payload: { domain },
      });
      expect(result.outcome).toBe("applied");
      expect(readEntity(db, USER_A, domain, `${domain}-1`)).toBeTruthy();
    }
  });
});

describe("墓碑 TTL 清理与防复活", () => {
  let db: DatabaseSync;
  let env: { DB: FakeD1 };
  const now = 100 * DAY_MS;
  const expiredAt = now - 91 * DAY_MS;
  const freshAt = now - 10 * DAY_MS;

  beforeEach(() => {
    db = createDatabase();
    env = { DB: new FakeD1(db) };
  });

  /** 通过 applyChange 正常删除，再把墓碑时间改到想要的位置。 */
  async function deleteThenAge(id: string, deletedAt: number) {
    await applyChange(env, USER_A, "notes", { id, baseRevision: 0, updatedAt: deletedAt - 1, payload: { v: 1 } });
    await applyChange(env, USER_A, "notes", {
      id,
      baseRevision: 1,
      deleted: true,
      updatedAt: deletedAt,
    });
    db.prepare("UPDATE sync_entities SET deleted_at = ?, updated_at = ? WHERE user_id = ? AND domain = ? AND entity_id = ?").run(
      deletedAt,
      deletedAt,
      USER_A,
      "notes",
      id,
    );
    // 台账写的是真实删除时刻；这里同步改老，模拟「90 天前删除」的墓碑。
    db.prepare("UPDATE sync_tombstone_ledger SET deleted_at = ? WHERE user_id = ? AND domain = ? AND entity_id = ?").run(
      deletedAt,
      USER_A,
      "notes",
      id,
    );
  }

  it("过期墓碑被物理清理，但台账保留（先补台账再删行）", async () => {
    await deleteThenAge("tomb-old", expiredAt);
    const result = await purgeExpiredTombstones(env, { now });

    expect(result.scanned).toBe(1);
    expect(result.purged).toBe(1);
    expect(result.cutoff).toBe(now - 90 * DAY_MS);
    expect(readEntity(db, USER_A, "notes", "tomb-old")).toBeUndefined();
    expect(readLedger(db, USER_A, "notes", "tomb-old")).toMatchObject({ revision: 2, deleted_at: expiredAt });
  });

  it("清理后旧 baseRevision 重推返回合成墓碑冲突，追平台账后才允许重建", async () => {
    await deleteThenAge("tomb-old", expiredAt);
    await purgeExpiredTombstones(env, { now });

    const resurrect = await applyChange(env, USER_A, "notes", {
      id: "tomb-old",
      baseRevision: 0,
      updatedAt: now,
      payload: { title: "复活" },
    });
    expect(resurrect.outcome).toBe("conflict");
    expect(resurrect.entity).toEqual({
      id: "tomb-old",
      revision: 2,
      deleted: true,
      updatedAt: expiredAt,
      deletedAt: expiredAt,
    });
    expect(readEntity(db, USER_A, "notes", "tomb-old")).toBeUndefined();

    const recreate = await applyChange(env, USER_A, "notes", {
      id: "tomb-old",
      baseRevision: 2,
      updatedAt: now,
      payload: { title: "显式重建" },
    });
    expect(recreate.outcome).toBe("applied");
    expect(asEntity(recreate.entity).revision).toBe(3);
    expect(readEntity(db, USER_A, "notes", "tomb-old")).toMatchObject({ deleted: 0, revision: 3 });
  });

  it("未过期墓碑、活实体与其他用户的活实体都不受清理影响", async () => {
    await deleteThenAge("tomb-fresh", freshAt);
    insertEntity(db, {
      userId: USER_A,
      id: "live-a",
      payload: JSON.stringify({ title: "活" }),
      updatedAt: now - 5 * DAY_MS,
    });
    insertEntity(db, {
      userId: USER_B,
      id: "live-b",
      payload: JSON.stringify({ title: "B" }),
      updatedAt: now - 5 * DAY_MS,
    });
    insertEntity(db, {
      userId: USER_B,
      domain: "workspace",
      id: "tomb-b",
      revision: 4,
      deleted: 1,
      updatedAt: expiredAt,
      deletedAt: expiredAt,
    });

    const result = await purgeExpiredTombstones(env, { now });

    // 清理是全局维护任务：其他用户的过期墓碑也要清，但它的活实体不能动
    expect(result.scanned).toBe(1);
    expect(result.purged).toBe(1);
    expect(readEntity(db, USER_A, "notes", "tomb-fresh")).toBeTruthy();
    expect(readEntity(db, USER_A, "notes", "live-a")).toBeTruthy();
    expect(readEntity(db, USER_B, "notes", "live-b")).toBeTruthy();
    expect(readEntity(db, USER_B, "workspace", "tomb-b")).toBeUndefined();
    expect(readLedger(db, USER_B, "workspace", "tomb-b")).toMatchObject({ revision: 4 });

    const again = await purgeExpiredTombstones(env, { now });
    expect(again).toMatchObject({ scanned: 0, purged: 0 });
  });

  it("batchSize 限制单次处理量，剩余墓碑留给下一轮", async () => {
    for (const id of ["t1", "t2", "t3"]) {
      insertEntity(db, {
        id,
        revision: 3,
        deleted: 1,
        updatedAt: expiredAt - 1000,
        deletedAt: expiredAt - 1000,
      });
    }

    const first = await purgeExpiredTombstones(env, { now, batchSize: 2 });
    expect(first.scanned).toBe(2);
    expect(first.purged).toBe(2);

    const second = await purgeExpiredTombstones(env, { now, batchSize: 2 });
    expect(second.scanned).toBe(1);
    expect(second.purged).toBe(1);
  });
});

describe("配额与统计", () => {
  let db: DatabaseSync;
  let env: { DB: FakeD1 };

  beforeEach(() => {
    db = createDatabase();
    env = { DB: new FakeD1(db) };
  });

  it("userQuotaStats 分别统计活实体与墓碑", async () => {
    insertEntity(db, { id: "live-1", payload: JSON.stringify({ v: 1 }), updatedAt: 100 });
    insertEntity(db, { id: "live-2", payload: JSON.stringify({ v: 2 }), updatedAt: 200 });
    insertEntity(db, { id: "tomb-1", revision: 2, deleted: 1, updatedAt: 300, deletedAt: 300 });
    insertEntity(db, { id: "other-user", userId: USER_B, payload: JSON.stringify({ v: 3 }), updatedAt: 400 });

    const stats = await userQuotaStats(env, USER_A);
    expect(stats).toEqual({
      entityCount: 2,
      tombstoneCount: 1,
      limits: { maxEntities: 5000, maxTombstones: 2000 },
    });
  });

  it("domainStats 只统计当前域", async () => {
    insertEntity(db, { id: "n1", payload: JSON.stringify({ v: 1 }), updatedAt: 100 });
    insertEntity(db, { id: "n2", revision: 2, deleted: 1, updatedAt: 200, deletedAt: 200 });
    insertEntity(db, { domain: "tasks", id: "t1", payload: JSON.stringify({ v: 2 }), updatedAt: 300 });

    expect(await domainStats(env, USER_A, "notes")).toEqual({
      domain: "notes",
      count: 2,
      tombstones: 1,
      lastUpdated: 200,
    });
    expect(await domainStats(env, USER_A, "calendar")).toEqual({
      domain: "calendar",
      count: 0,
      tombstones: 0,
      lastUpdated: null,
    });
  });

  it("estimateQuotaDelta：新增算实体、删除算墓碑、更新已存在实体不占额度", async () => {
    insertEntity(db, { id: "live-1", payload: JSON.stringify({ v: 1 }), updatedAt: 100 });
    insertEntity(db, { id: "live-2", payload: JSON.stringify({ v: 2 }), updatedAt: 200 });

    const delta = await estimateQuotaDelta(env, USER_A, "notes", [
      { id: "live-1", baseRevision: 1, deleted: false },
      { id: "brand-new", baseRevision: 0, deleted: false },
      { id: "live-2", baseRevision: 1, deleted: true },
      { id: "new-tomb", baseRevision: 0, deleted: true },
    ]);

    expect(delta).toEqual({ entities: 1, tombstones: 2 });
  });

  it("estimateQuotaDelta：墓碑重建释放墓碑额度，被防复活拦下的推送不占额度", async () => {
    insertEntity(db, { id: "tomb-live", revision: 2, deleted: 1, updatedAt: 300, deletedAt: 300 });
    // tomb-purged：墓碑已被物理清理，只剩台账
    db.prepare(
      "INSERT INTO sync_tombstone_ledger (user_id, domain, entity_id, revision, deleted_at) VALUES (?, 'notes', 'tomb-purged', 3, 400)",
    ).run(USER_A);

    const delta = await estimateQuotaDelta(env, USER_A, "notes", [
      { id: "tomb-live", baseRevision: 2, deleted: false },
      { id: "tomb-purged", baseRevision: 0, deleted: false }, // 旧 base → 会被冲突拦下
      { id: "tomb-purged", baseRevision: 3, deleted: false }, // 追平台账 → 算新建
    ]);

    expect(delta).toEqual({ entities: 2, tombstones: 0 });
  });
});

describe("读取接口", () => {
  let db: DatabaseSync;
  let env: { DB: FakeD1 };

  beforeEach(() => {
    db = createDatabase();
    env = { DB: new FakeD1(db) };
  });

  it("listIndex 只返回索引字段，不返回 payload", async () => {
    insertEntity(db, { id: "n1", payload: JSON.stringify({ title: "一" }), updatedAt: 100 });
    insertEntity(db, { id: "n2", revision: 2, deleted: 1, updatedAt: 200, deletedAt: 200 });

    const index = await listIndex(env, USER_A, "notes");
    expect(index.truncated).toBe(false);
    expect(index.entities).toEqual([
      { id: "n2", revision: 2, deleted: true, updatedAt: 200 },
      { id: "n1", revision: 1, deleted: false, updatedAt: 100 },
    ]);
  });

  it("listChanges 按 updated_at 升序，墓碑带 deletedAt", async () => {
    insertEntity(db, { id: "n1", payload: JSON.stringify({ title: "一" }), updatedAt: 100 });
    insertEntity(db, { id: "n2", revision: 2, deleted: 1, updatedAt: 200, deletedAt: 200 });

    const changes = await listChanges(env, USER_A, "notes", { since: 0 });
    expect(changes.map((item: Row) => item.id)).toEqual(["n1", "n2"]);
    expect(changes[0]).toMatchObject({ deleted: false, payload: { title: "一" } });
    expect(changes[1]).toMatchObject({ deleted: true, deletedAt: 200 });

    expect(await listChanges(env, USER_A, "notes", { since: 150 })).toHaveLength(1);
  });

  it("listByIds 去重并只返回命中的实体", async () => {
    insertEntity(db, { id: "n1", payload: JSON.stringify({ title: "一" }), updatedAt: 100 });
    insertEntity(db, { id: "n2", payload: JSON.stringify({ title: "二" }), updatedAt: 200 });

    const found = await listByIds(env, USER_A, "notes", ["n1", "n1", "n2", "missing"]);
    expect(found.map((item: Row) => item.id).sort()).toEqual(["n1", "n2"]);
    expect(await listByIds(env, USER_A, "notes", [])).toEqual([]);
  });
});
