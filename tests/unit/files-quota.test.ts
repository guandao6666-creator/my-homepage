/**
 * Guandao OS 2.0 · 云盘上传配额（2.0.4 并发修复回归）
 *
 * 为什么用真实 SQLite 而不是 mock SQL：修复的核心是「先写 pending 占位，再用 usage()
 * 求和判定」这个顺序。只有让 usage() 真的读到刚写入的 pending 行，测试才证明得了
 * 「并发两个请求会保守拒绝，而不是一起越过上限」。
 *
 * 场景：两个 6 字节的上传先后占位，配额 10 字节 → 合计 12 超限。
 * 预检（used + size）在各自执行时都看不出问题，只有复核 pending 行之和才能拦下。
 */
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";

import { assertReservedFileQuota } from "../../worker/api/files/handlers.js";
import { insertPendingFile, usage } from "../../worker/api/files/store.js";

const MIGRATION_0001 = readFileSync(new URL("../../migrations/0001_init.sql", import.meta.url), "utf8");
const MIGRATION_0003 = readFileSync(new URL("../../migrations/0003_cloud_drive.sql", import.meta.url), "utf8");
const USER = "test-user-files";

type Row = Record<string, unknown>;
type SqlValue = null | number | bigint | string | Uint8Array;

interface LooseStatement {
  all(...params: SqlValue[]): Row[];
  get(...params: SqlValue[]): Row | undefined;
  run(...params: SqlValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
}

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
  db.exec(MIGRATION_0001);
  db.exec(MIGRATION_0003);
  db.prepare("INSERT INTO users (id, email) VALUES (?, ?)").run(USER, "files@example.test");
  return db;
}

function reserve(env: { DB: FakeD1 }, id: string, size: number) {
  return insertPendingFile(env, {
    id,
    userId: USER,
    parentId: null,
    objectKey: `users/${USER}/files/${id}`,
    name: `${id}.txt`,
    extension: "txt",
    mimeType: "text/plain",
    size,
  });
}

describe("云盘上传配额闸门", () => {
  let db: DatabaseSync;
  let env: { DB: FakeD1 };

  beforeEach(() => {
    db = createDatabase();
    env = { DB: new FakeD1(db) };
  });

  it("占位后仍在上限内：复核返回当前用量，pending 行保留", async () => {
    await reserve(env, "f1", 4);

    const used = await assertReservedFileQuota(env, USER, "f1", 10);

    expect(used).toBe(4);
    expect(db.prepare("SELECT COUNT(*) AS n FROM files WHERE id = ?").get("f1")).toMatchObject({ n: 1 });
  });

  it("两个占位合计越界：复核删掉自己的行并返回 507，另一个占位不动", async () => {
    await reserve(env, "f1", 6);
    await reserve(env, "f2", 6);
    expect((await usage(env, USER)).usedBytes).toBe(12);

    await expect(assertReservedFileQuota(env, USER, "f1", 10)).rejects.toMatchObject({
      code: "QUOTA_EXCEEDED",
      status: 507,
    });

    // 只删自己：另一个上传仍然可以继续走复核（它也会被拒，但不会互相踩数据）
    expect(db.prepare("SELECT COUNT(*) AS n FROM files WHERE id = ?").get("f1")).toMatchObject({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM files WHERE id = ?").get("f2")).toMatchObject({ n: 1 });
    expect((await usage(env, USER)).usedBytes).toBe(6);
  });

  it("配额按用户计算：别人的占位不算进我的用量，删占位也不碰别人的行", async () => {
    db.prepare("INSERT INTO users (id, email) VALUES (?, ?)").run("other-user", "other@example.test");
    await reserve(env, "mine-1", 6);
    await reserve(env, "mine-2", 6);
    await insertPendingFile(env, {
      id: "theirs",
      userId: "other-user",
      parentId: null,
      objectKey: "users/other-user/files/theirs",
      name: "theirs.txt",
      extension: "txt",
      mimeType: "text/plain",
      size: 6,
    });

    // 我的 12 字节超限；别人的 6 字节不参与
    await expect(assertReservedFileQuota(env, USER, "mine-1", 10)).rejects.toMatchObject({
      status: 507,
    });

    expect(db.prepare("SELECT COUNT(*) AS n FROM files WHERE id = ?").get("theirs")).toMatchObject({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM files WHERE id = ?").get("mine-1")).toMatchObject({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM files WHERE user_id = ?").get(USER)).toMatchObject({ n: 1 });
    expect((await usage(env, USER)).usedBytes).toBe(6);
  });
});