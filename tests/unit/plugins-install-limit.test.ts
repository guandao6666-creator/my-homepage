/**
 * Guandao OS 2.0.11 · 插件安装上限（并发修复回归）
 *
 * 为什么用真实 SQLite：修复的核心是「上限判断和写入在同一条语句里完成」。
 * 只有让条件子查询真的读到 plugin_installations 的行数，测试才证明得了
 * 「并发两个新装只会有一个占到位，而不是两个都通过 COUNT 检查」。
 *
 * 场景：39 个已安装插件 → 并发两个新装，恰好一个成功、一个 INSTALL_LIMIT，
 * 结束后总数仍是 40。
 */
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";

import { MAX_INSTALLED, reserveInstallSlot } from "../../worker/api/plugins/install-slot.js";

const MIGRATION_0001 = readFileSync(new URL("../../migrations/0001_init.sql", import.meta.url), "utf8");
const MIGRATION_0010 = readFileSync(new URL("../../migrations/0010_plugins.sql", import.meta.url), "utf8");
const USER = "test-user-plugins";

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
  // 只验证安装名额的 SQL 语义，不验证外键：新插件还没有 plugins 行是正常业务流程。
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec(MIGRATION_0001);
  db.exec(MIGRATION_0010);
  db.prepare("INSERT INTO users (id, email) VALUES (?, ?)").run(USER, "plugins@example.test");
  return db;
}

function seedInstalls(db: DatabaseSync, count: number) {
  const insertPlugin = db.prepare(
    "INSERT INTO plugins (id, developer_id, name, type, created_at, updated_at) VALUES (?, ?, ?, 'application', ?, ?)",
  );
  const insert = db.prepare(
    "INSERT INTO plugin_installations (id, user_id, plugin_id, version, enabled, status, package_sha256, source, installed_at, updated_at) VALUES (?, ?, ?, ?, 1, 'installed', ?, 'market', ?, ?)",
  );
  for (let i = 0; i < count; i += 1) {
    insertPlugin.run(`com.test.p${i}`, USER, `插件 ${i}`, i + 1, i + 1);
    insert.run(`inst-${i}`, USER, `com.test.p${i}`, "1.0.0", "0".repeat(64), i + 1, i + 1);
  }
}

function countInstalls(db: DatabaseSync) {
  const row = db.prepare("SELECT COUNT(*) AS n FROM plugin_installations WHERE user_id = ?").get(USER) as Row;
  return Number(row.n);
}

describe("插件安装上限闸门", () => {
  let db: DatabaseSync;
  let env: { DB: FakeD1 };

  beforeEach(() => {
    db = createDatabase();
    env = { DB: new FakeD1(db) };
  });

  it("39 个已安装后并发两个新装：恰好一个成功，总数不越 40", async () => {
    seedInstalls(db, MAX_INSTALLED - 1);
    const attempt = (pluginId: string) =>
      reserveInstallSlot(env, { userId: USER, pluginId, versionText: "1.0.0", packageHash: "a".repeat(64) }).then(
        () => "ok" as const,
        (error: { code?: string }) => (error.code === "INSTALL_LIMIT" ? "limit" as const : Promise.reject(error)),
      );

    const results = await Promise.all([attempt("com.test.extra1"), attempt("com.test.extra2")]);

    expect(results.sort()).toEqual(["limit", "ok"]);
    expect(countInstalls(db)).toBe(MAX_INSTALLED);
  });

  it("名额已满时重装已有插件仍然允许（更新版本而不是新占名额）", async () => {
    seedInstalls(db, MAX_INSTALLED);

    const result = await reserveInstallSlot(env, {
      userId: USER,
      pluginId: "com.test.p0",
      versionText: "2.0.0",
      packageHash: "b".repeat(64),
    });

    expect(result).toEqual({ ok: true, reinstalled: true });
    expect(countInstalls(db)).toBe(MAX_INSTALLED);
    const row = db.prepare("SELECT version FROM plugin_installations WHERE user_id = ? AND plugin_id = ?").get(USER, "com.test.p0") as Row;
    expect(row.version).toBe("2.0.0");
  });

  it("名额已满且不是已有插件：抛 INSTALL_LIMIT 409", async () => {
    seedInstalls(db, MAX_INSTALLED);
    await expect(
      reserveInstallSlot(env, { userId: USER, pluginId: "com.test.new", versionText: "1.0.0", packageHash: "c".repeat(64) }),
    ).rejects.toMatchObject({ code: "INSTALL_LIMIT", status: 409 });
    expect(countInstalls(db)).toBe(MAX_INSTALLED);
  });

  it("空账号第一次安装：reserved 成功且只插一行", async () => {
    const result = await reserveInstallSlot(env, {
      userId: USER,
      pluginId: "com.test.first",
      versionText: "1.0.0",
      packageHash: "d".repeat(64),
    });
    expect(result).toEqual({ ok: true, reinstalled: false });
    expect(countInstalls(db)).toBe(1);
  });

  it("源码约束：安装走 reserveInstallSlot，handlers 里不再有独立的 COUNT 预检写入", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(new URL("../../worker/api/plugins/handlers.js", import.meta.url), "utf8");
    expect(source).toContain("await reserveInstallSlot(env, {");
    expect(source).not.toContain("const MAX_INSTALLED = 40;");
  });
});