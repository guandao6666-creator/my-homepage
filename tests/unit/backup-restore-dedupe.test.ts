import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  classifyRestoreFiles,
  copyRestoreObject,
  loadReadySha256,
  runRestoreCopy,
} from "../../worker/api/backups/restore-copy.js";

interface PlanFile {
  id: string;
  newId: string;
  sha256: string;
  sizeBytes: number;
  mimeType: string;
}

interface RestoreItem {
  id: string;
  user_id: string;
  restore_id: string;
  file_id: string;
  new_file_id: string | null;
  status: string;
  error_message: string | null;
}

interface FakeDb {
  restoreItems: Map<string, RestoreItem>;
  jobs: unknown[][];
  restores: unknown[][];
  prepare: (sql: string) => {
    bind: (...args: unknown[]) => {
      all: () => Promise<{ results: unknown[] }>;
      run: () => Promise<{ meta: { changes: number } }>;
    };
  };
}

type FakeEnv = { DB: FakeDb; FILES: ReturnType<typeof fakeR2>["FILES"] };

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/**
 * 假 D1：只实现 restore-copy.js / store.js 用到的语句。
 * 为什么手写而不用真实 SQLite：这里要断言的是「调用了什么」，不是 SQL 语义。
 */
function fakeDb(existingHashes: string[] = []): FakeDb {
  const restoreItems = new Map<string, RestoreItem>();
  const jobs: unknown[][] = [];
  const restores: unknown[][] = [];
  return {
    restoreItems,
    jobs,
    restores,
    prepare(sql: string) {
      return {
        bind: (...args: unknown[]) => ({
          all: async (): Promise<{ results: unknown[] }> => {
            if (/SELECT sha256 FROM files/.test(sql)) {
              return { results: existingHashes.map((value) => ({ sha256: value })) };
            }
            if (/SELECT \* FROM backup_restore_items/.test(sql)) {
              return { results: [...restoreItems.values()] };
            }
            return { results: [] };
          },
          run: async (): Promise<{ meta: { changes: number } }> => {
            if (/INSERT INTO backup_restore_items/.test(sql)) {
              const [id, userId, restoreId, fileId, newFileId, status, error] = args as string[];
              restoreItems.set(id, {
                id,
                user_id: userId,
                restore_id: restoreId,
                file_id: fileId,
                new_file_id: newFileId ?? null,
                status,
                error_message: error ?? null,
              });
            } else if (/UPDATE backup_jobs/.test(sql)) {
              jobs.push(args);
            } else if (/UPDATE backup_restores/.test(sql)) {
              restores.push(args);
            }
            return { meta: { changes: 1 } };
          },
        }),
      };
    },
  };
}

function fakeR2(objects: Record<string, string>) {
  const gets: string[] = [];
  const puts: { key: string; size: number }[] = [];
  const deletes: string[] = [];
  return {
    gets,
    puts,
    deletes,
    FILES: {
      get: async (key: string): Promise<{ body: ReadableStream<Uint8Array> } | null> => {
        gets.push(key);
        const text = objects[key];
        if (text === undefined) return null;
        return { body: new Response(text).body as ReadableStream<Uint8Array> };
      },
      put: async (key: string, body: ReadableStream<Uint8Array>): Promise<void> => {
        const chunks: Uint8Array[] = [];
        const reader = body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) chunks.push(value);
        }
        puts.push({ key, size: chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0) });
      },
      delete: async (key: string): Promise<void> => {
        deletes.push(key);
      },
    },
  };
}

function file(id: string, newId: string, content: string, overrides: Partial<PlanFile> = {}): PlanFile {
  return {
    id,
    newId,
    sha256: sha(content),
    sizeBytes: bytes(content).byteLength,
    mimeType: "text/plain",
    ...overrides,
  };
}

const ctx = { userId: "u1", restoreId: "r1", backupId: "b1", jobId: "j1" };

function envFor(db: FakeDb, r2: ReturnType<typeof fakeR2>): FakeEnv {
  return { DB: db, FILES: r2.FILES };
}

describe("backup restore dedupe", () => {
  it("merge 恢复：内容已存在的文件不读不写 R2，同一备份内重复内容也只落一份", async () => {
    const a = file("f1", "n1", "alpha");
    const b = file("f2", "n2", "beta");
    const c = file("f3", "n3", "alpha"); // 与 f1 内容相同
    const db = fakeDb([sha("alpha")]);
    const r2 = fakeR2({
      "users/u1/backups/b1/files/f1": "alpha",
      "users/u1/backups/b1/files/f2": "beta",
      "users/u1/backups/b1/files/f3": "alpha",
    });
    const plan = { files: [a, b, c], skippedIds: [] as string[] };

    const result = await runRestoreCopy(envFor(db, r2), { ...ctx, mode: "merge", plan });

    expect(result.done.size).toBe(3);
    expect(r2.gets).toEqual(["users/u1/backups/b1/files/f2"]);
    expect(r2.puts).toEqual([{ key: "users/u1/files/n2", size: 4 }]);
    expect(plan.skippedIds.sort()).toEqual(["f1", "f3"]);
    expect(db.restoreItems.get("r1:f1")?.status).toBe("copied");
    expect(db.restoreItems.get("r1:f1")?.error_message).toBe("DUPLICATE_CONTENT");
    expect(db.restoreItems.get("r1:f2")?.status).toBe("verified");
    expect(db.restoreItems.get("r1:f3")?.status).toBe("copied");
  });

  it("copy 模式不按哈希跳过：三个文件都读、都写", async () => {
    const a = file("f1", "n1", "alpha");
    const b = file("f2", "n2", "beta");
    const db = fakeDb([sha("alpha")]);
    const r2 = fakeR2({
      "users/u1/backups/b1/files/f1": "alpha",
      "users/u1/backups/b1/files/f2": "beta",
    });
    const plan = { files: [a, b], skippedIds: [] as string[] };

    const result = await runRestoreCopy(envFor(db, r2), { ...ctx, mode: "copy", plan });

    expect(result.done.size).toBe(2);
    expect(r2.gets.length).toBe(2);
    expect(r2.puts.map((item) => item.key)).toEqual(["users/u1/files/n1", "users/u1/files/n2"]);
    expect(plan.skippedIds).toEqual([]);
  });

  it("备份对象缺失：标记 failed、恢复任务置 failed，并抛 BACKUP_BROKEN", async () => {
    const db = fakeDb();
    const r2 = fakeR2({});
    const plan = { files: [file("f1", "n1", "alpha")], skippedIds: [] as string[] };

    await expect(
      runRestoreCopy(envFor(db, r2), { ...ctx, mode: "copy", plan }),
    ).rejects.toMatchObject({ code: "BACKUP_BROKEN" });
    expect(db.restoreItems.get("r1:f1")?.status).toBe("failed");
    expect(db.restoreItems.get("r1:f1")?.error_message).toBe("BACKUP_OBJECT_MISSING");
    expect(db.restores.length).toBe(1);
  });

  it("校验失败：删掉刚写的对象、不做 verified，并抛 RESTORE_VERIFY_FAILED", async () => {
    const db = fakeDb();
    const r2 = fakeR2({ "users/u1/backups/b1/files/f1": "tampered" });
    const plan = { files: [file("f1", "n1", "alpha")], skippedIds: [] as string[] };

    await expect(
      runRestoreCopy(envFor(db, r2), { ...ctx, mode: "copy", plan }),
    ).rejects.toMatchObject({ code: "RESTORE_VERIFY_FAILED" });
    expect(r2.deletes).toEqual(["users/u1/files/n1"]);
    expect(db.restoreItems.get("r1:f1")?.status).toBe("failed");
    expect(db.restoreItems.get("r1:f1")?.error_message).toBe("RESTORE_VERIFY_FAILED");
  });

  it("classifyRestoreFiles：没有哈希集合时全部复制，有集合时按内容跳过", () => {
    const a = file("f1", "n1", "alpha");
    const b = file("f2", "n2", "beta");

    expect(classifyRestoreFiles([a, b], null)).toEqual({ copies: [a, b], skips: [] });
    const result = classifyRestoreFiles([a, b], new Set([sha("alpha")]));
    expect(result.copies.map((item: PlanFile) => item.id)).toEqual(["f2"]);
    expect(result.skips.map((item: PlanFile) => item.id)).toEqual(["f1"]);
  });

  it("loadReadySha256 只取 ready 且带哈希的行", async () => {
    const set = await loadReadySha256({ DB: fakeDb(["h1", "h2"]) } as never, "u1");
    expect([...set]).toEqual(["h1", "h2"]);
  });

  it("copyRestoreObject 校验通过时返回 digest 与 live key", async () => {
    const r2 = fakeR2({ "users/u1/backups/b1/files/f1": "alpha" });
    const result = await copyRestoreObject(
      { FILES: r2.FILES } as never,
      { userId: "u1", backupId: "b1", file: file("f1", "n1", "alpha") },
    );
    expect(result.liveKey).toBe("users/u1/files/n1");
    expect(result.digest).toEqual({ size: 5, sha256: sha("alpha") });
  });

  it("源码约束：恢复处理用 runRestoreCopy，元数据阶段复用 plan.skippedIds", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(new URL("../../worker/api/backups/handlers.js", import.meta.url), "utf8");
    expect(source).toContain("await runRestoreCopy(env, {");
    expect(source).toContain("plan.skippedIds");
    // 复制阶段之外的任何地方都不该再「先 put 再算哈希」。
    expect(source).not.toContain("[hashBranch, writeBranch] = object.body.tee();");
  });
});