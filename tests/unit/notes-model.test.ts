/**
 * 2.0.6 · 笔记数据归一化的回归测试
 *
 * 旧 `read()` 只检查数组存在，缺 `tags`/`body` 的记录会让首页 `n.tags.join()`
 * 或 `body.split()` 抛 TypeError。这里覆盖纯函数本身，并用源码断言确认
 * `read()` 真的调用了它（否则只测函数不改调用点等于没修）。
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { normalizeNote, normalizeNotes } from "../../src/lib/os14/apps/notes-model";

describe("笔记归一化", () => {
  it("缺 tags/body/pinned 的旧记录不会让首页崩", () => {
    const note = normalizeNote({ id: "n1", title: "旧笔记" });
    expect(note).not.toBeNull();
    expect(note).toMatchObject({ id: "n1", title: "旧笔记", body: "", tags: [], pinned: false, folder: "inbox" });
    // 模拟首页行为：这两步在旧数据上会抛。
    expect(note!.tags.join(" ")).toBe("");
    expect(note!.body.split("\n")).toHaveLength(1);
  });

  it("tags 里的非字符串被丢弃（join 不会出现 undefined）", () => {
    const note = normalizeNote({ id: "n2", tags: ["a", 1, null, { x: 1 }, "b"] });
    expect(note!.tags).toEqual(["a", "b"]);
    expect(note!.tags.join(" ")).toBe("a b");
  });

  it("没有 id 的记录无法编辑，直接丢弃；非数组列表返回空数组", () => {
    expect(normalizeNote({ title: "无 id" })).toBeNull();
    expect(normalizeNote(null)).toBeNull();
    expect(normalizeNotes("not-array")).toEqual([]);
    expect(normalizeNotes([{ id: "ok" }, {}, 42])).toHaveLength(1);
  });

  it("时间戳缺失/非法时补 0，不产生 NaN 排序", () => {
    const note = normalizeNote({ id: "n3", createdAt: "abc", updatedAt: undefined });
    expect(note!.createdAt).toBe(0);
    expect(note!.updatedAt).toBe(0);
    const fallback = normalizeNote({ id: "n4", createdAt: 100 });
    expect(fallback!.updatedAt).toBe(100);
  });

  it("read() 确实调用了 normalizeNotes（否则只测函数没修调用点）", () => {
    const source = readFileSync(new URL("../../src/lib/os14/apps/notes.ts", import.meta.url), "utf8");
    expect(source).toContain("raw.notes = normalizeNotes(raw.notes)");
  });
});