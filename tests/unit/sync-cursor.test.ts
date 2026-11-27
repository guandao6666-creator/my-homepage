/**
 * 2.0.11 · 同步增量拉取的 (updated_at, entity_id) 游标
 *
 * 背景（负向对照正是这里）：台账 updated_at 是毫秒整数，同一毫秒内写入的多条变更，
 * 用裸 `since`（updated_at > since）分页时，第二页会把「与第一页最后一条同毫秒」的其余
 * 记录全部跳过 —— 外部客户端按 limit 分页时真的会丢数据。所以这里测的是「不丢」。
 */
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { formatSyncCursor, parseSyncCursor } from "../../worker/api/sync/cursor.js";
import { listChanges, listChangesPage } from "../../worker/api/sync/store.js";

const MIGRATION_0001 = readFileSync(new URL("../../migrations/0001_init.sql", import.meta.url), "utf8");
const MIGRATION_0014 = readFileSync(new URL("../../migrations/0014_sync.sql", import.meta.url), "utf8");
const MIGRATION_0018 = readFileSync(new URL("../../migrations/0018_sync_cloud_expansion.sql", import.meta.url), "utf8");
const USER = "test-user-sync-cursor";

type SqlValue = string | number | null;

class FakeStatement {
  private params: SqlValue[] = [];

  constructor(
    private readonly db: DatabaseSync,
    private readonly sql: string,
  ) {}

  bind(...params: SqlValue[]) {
    this.params = params;
    return this;
  }

  async all() {
    return { results: this.db.prepare(this.sql).all(...this.params) as Record<string, unknown>[] };
  }

  async first() {
    return (this.db.prepare(this.sql).get(...this.params) as Record<string, unknown> | undefined) ?? null;
  }

  async run() {
    const info = this.db.prepare(this.sql).run(...this.params);
    return { meta: { changes: Number(info.changes) } };
  }
}

class FakeD1 {
  constructor(private readonly db: DatabaseSync) {}

  prepare(sql: string) {
    return new FakeStatement(this.db, sql);
  }
}

function seed(db: DatabaseSync, rows: Array<{ id: string; updatedAt: number }>) {
  const insert = db.prepare(
    "INSERT INTO sync_entities (user_id, domain, entity_id, revision, deleted, payload_json, updated_at, deleted_at) VALUES (?, 'notes', ?, 1, 0, '{}', ?, NULL)",
  );
  for (const row of rows) insert.run(USER, row.id, row.updatedAt);
}

describe("同步游标 · 纯函数", () => {
  it("格式化与解析互为逆运算", () => {
    const cursor = formatSyncCursor({ updated_at: 1700000000123, entity_id: "note-a" });
    expect(cursor).toBe("1700000000123:note-a");
    expect(parseSyncCursor(cursor)).toEqual({ updatedAt: 1700000000123, entityId: "note-a" });
  });

  it("非法输入一律返回 null，让调用方决定忽略或 400", () => {
    expect(formatSyncCursor({ updated_at: -1, entity_id: "a" })).toBeNull();
    expect(formatSyncCursor({ updated_at: 1.5, entity_id: "a" })).toBeNull();
    expect(formatSyncCursor({ updated_at: 1, entity_id: "" })).toBeNull();
    expect(formatSyncCursor({ updated_at: 1, entity_id: "x".repeat(129) })).toBeNull();
    expect(parseSyncCursor("")).toBeNull();
    expect(parseSyncCursor("1700000000123")).toBeNull();
    expect(parseSyncCursor(":note-a")).toBeNull();
    expect(parseSyncCursor("-5:note-a")).toBeNull();
    expect(parseSyncCursor("1700000000123:")).toBeNull();
    expect(parseSyncCursor(1700000000123 as unknown as string)).toBeNull();
  });
});

describe("同步游标 · 真实 SQLite 分页", () => {
  let db: DatabaseSync;
  let env: { DB: FakeD1 };

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = OFF");
    db.exec(MIGRATION_0001);
    db.exec(MIGRATION_0014);
    db.exec(MIGRATION_0018);
    db.prepare("DELETE FROM sync_entities").run();
    env = { DB: new FakeD1(db) };
  });

  it("同一毫秒的三条变更跨页不丢：第一页给游标，第二页接着取", async () => {
    // a/b/c 同一毫秒，d 在下一毫秒。旧实现第一页取 a、b 后以 since=1000 继续，c 会被跳过。
    seed(db, [
      { id: "a", updatedAt: 1000 },
      { id: "b", updatedAt: 1000 },
      { id: "c", updatedAt: 1000 },
      { id: "d", updatedAt: 2000 },
    ]);

    const first = await listChangesPage(env, USER, "notes", { since: 0, limit: 2 });
    expect(first.changes.map((change: { id: string }) => change.id)).toEqual(["a", "b"]);
    expect(first.nextCursor).toBe("1000:b");

    const second = await listChangesPage(env, USER, "notes", { limit: 2 }, parseSyncCursor(first.nextCursor));
    expect(second.changes.map((change: { id: string }) => change.id)).toEqual(["c", "d"]);
    expect(new Set([...first.changes, ...second.changes].map((change: { id: string }) => change.id)).size).toBe(4);
  });

  it("负向对照的形态：只按 since=1000 继续会漏掉同毫秒的 c", async () => {
    seed(db, [
      { id: "a", updatedAt: 1000 },
      { id: "b", updatedAt: 1000 },
      { id: "c", updatedAt: 1000 },
    ]);
    const legacy = await listChanges(env, USER, "notes", { since: 1000, limit: 10 });
    expect(legacy).toEqual([]); // 这就是 2.0.10 及以前丢数据的样子
  });

  it("游标翻到末尾返回 null，重复请求同一游标结果稳定", async () => {
    seed(db, [{ id: "a", updatedAt: 1000 }]);
    const page = await listChangesPage(env, USER, "notes", { since: 0, limit: 10 });
    expect(page.changes).toHaveLength(1);
    expect(page.nextCursor).toBe("1000:a");
    const again = await listChangesPage(env, USER, "notes", { limit: 10 }, parseSyncCursor(page.nextCursor));
    expect(again.changes).toEqual([]);
    expect(again.nextCursor).toBeNull();
  });

  it("不同域/用户互不串页", async () => {
    db.prepare(
      "INSERT INTO sync_entities (user_id, domain, entity_id, revision, deleted, payload_json, updated_at, deleted_at) VALUES (?, 'notes', 'other-user', 1, 0, '{}', 1000, NULL), (?, 'tasks', 'task-1', 1, 0, '{}', 1000, NULL)",
    ).run("someone-else", USER);
    seed(db, [{ id: "note-1", updatedAt: 1000 }]);
    const page = await listChangesPage(env, USER, "notes", { since: 0, limit: 10 });
    expect(page.changes.map((change: { id: string }) => change.id)).toEqual(["note-1"]);
  });
});