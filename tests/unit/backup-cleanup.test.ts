/**
 * 2.0.4 · 失败备份的 R2 清理
 *
 * 这组用例守两件事：
 *  1. `deleteBackupPrefix` 会分页把前缀下的对象全部删掉，而不是只删第一页
 *     （备份可能包含 manifest/data/逐个文件对象，超过 R2 列表单页 500 条时旧实现会漏删）；
 *  2. `failBackup` 真的调用了清理，而不是只改数据库状态——孤儿对象在
 *     `storageStats` 里看不见（失败备份 size_bytes 为 NULL），只能靠代码约束。
 */
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { deleteBackupPrefix } from "../../worker/api/backups/archive.js";

interface Page {
  objects: string[];
  truncated: boolean;
}

interface FakeR2 {
  deleted: string[];
  env: { FILES: { list(options: { prefix: string; cursor?: string }): Promise<{ objects: Array<{ key: string }>; truncated: boolean; cursor?: string }>; delete(keys: string[]): Promise<void> } };
}

function fakeR2(pages: Page[]): FakeR2 {
  const deleted: string[] = [];
  let call = 0;
  return {
    deleted,
    env: {
      FILES: {
        async list(_options) {
          const page = pages[call] ?? { objects: [], truncated: false };
          call += 1;
          return {
            objects: page.objects.map((key) => ({ key })),
            truncated: page.truncated,
            cursor: page.truncated ? `c${call}` : undefined,
          };
        },
        async delete(keys) {
          deleted.push(...keys);
        },
      },
    },
  };
}

describe("备份 · 失败后清理 R2 前缀（2.0.4）", () => {
  it("按前缀分页删除，两页对象都会删掉", async () => {
    const { env, deleted } = fakeR2([
      { objects: ["users/u1/backups/b1/data.json", "users/u1/backups/b1/manifest.json"], truncated: true },
      { objects: ["users/u1/backups/b1/files/f1"], truncated: false },
    ]);

    await deleteBackupPrefix(env, "users/u1/backups/b1");

    expect(deleted).toEqual([
      "users/u1/backups/b1/data.json",
      "users/u1/backups/b1/manifest.json",
      "users/u1/backups/b1/files/f1",
    ]);
  });

  it("failBackup 在改状态之后调用清理（源码约束）", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "worker/api/backups/handlers.js"), "utf8");
    const body = /async function failBackup\([\s\S]*?\n}/.exec(source)?.[0] ?? "";
    expect(body).toContain("status: \"failed\"");
    expect(body).toContain("deleteBackupPrefix(env, `users/${userId}/backups/${backupRow.id}`)");
    expect(body.indexOf("deleteBackupPrefix")).toBeGreaterThan(body.indexOf("status: \"failed\""));
  });
});