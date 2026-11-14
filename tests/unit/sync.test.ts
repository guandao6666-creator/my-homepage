/**
 * Guandao OS 2.0 · 同步墓碑
 *
 * 墓碑是「删除也能跨设备传播」的唯一手段，属于数据正确性问题：
 * 一个 id 被漏记，另一台设备就会把旧数据复活。
 */
import { beforeEach, describe, expect, it } from "vitest";

// tombstones.ts 直接用 localStorage；测试里给一个最小实现
class MemoryStorage {
  private map = new Map<string, string>();
  getItem(key: string) {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }
  setItem(key: string, value: string) {
    this.map.set(key, String(value));
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
  clear() {
    this.map.clear();
  }
  key(index: number) {
    return [...this.map.keys()][index] ?? null;
  }
  get length() {
    return this.map.size;
  }
}

const store = new MemoryStorage();
(globalThis as unknown as { localStorage: MemoryStorage }).localStorage = store;

const { recordTombstone, readTombstones, clearTombstones, tombstoneStats } = await import(
  "../../src/lib/sync/tombstones"
);

describe("同步墓碑", () => {
  beforeEach(() => store.clear());

  it("记录后能读回删除时间", () => {
    recordTombstone("notes", "n1", 1000);
    expect(readTombstones("notes")).toEqual({ n1: 1000 });
  });

  it("同一 id 重复删除以最后一次为准", () => {
    recordTombstone("notes", "n1", 1000);
    recordTombstone("notes", "n1", 2000);
    expect(readTombstones("notes").n1).toBe(2000);
  });

  it("不同数据域互不影响", () => {
    recordTombstone("notes", "n1", 1000);
    recordTombstone("tasks", "t1", 2000);
    expect(Object.keys(readTombstones("notes"))).toEqual(["n1"]);
    expect(Object.keys(readTombstones("calendar"))).toEqual([]);
  });

  it("推送成功后清理墓碑，其他 id 保留", () => {
    recordTombstone("tasks", "t1", 1000);
    recordTombstone("tasks", "t2", 2000);
    clearTombstones("tasks", ["t1"]);
    expect(readTombstones("tasks")).toEqual({ t2: 2000 });
    clearTombstones("tasks", ["t2"]);
    expect(readTombstones("tasks")).toEqual({});
  });

  it("清理不存在的 id 不会报错", () => {
    expect(() => clearTombstones("notes", ["missing"])).not.toThrow();
  });

  it("空 id 被忽略（避免把 undefined 写进墓碑）", () => {
    recordTombstone("notes", "");
    expect(readTombstones("notes")).toEqual({});
  });

  it("统计每个域的数量", () => {
    recordTombstone("notes", "n1");
    recordTombstone("notes", "n2");
    recordTombstone("calendar", "c1");
    expect(tombstoneStats()).toEqual({ notes: 2, tasks: 0, calendar: 1 });
  });

  it("兼容 StorageManager 的版本信封格式", () => {
    store.setItem(
      "guandao.core.sync.tombstones.v1",
      JSON.stringify({ v: 2, at: 1, data: { notes: { n9: 500 } } }),
    );
    expect(readTombstones("notes")).toEqual({ n9: 500 });
    recordTombstone("notes", "n10", 600);
    const raw = JSON.parse(store.getItem("guandao.core.sync.tombstones.v1") as string);
    expect(raw.notes ?? raw.data?.notes).toMatchObject({ n9: 500, n10: 600 });
  });

  it("损坏的 JSON 不会让同步崩溃", () => {
    store.setItem("guandao.core.sync.tombstones.v1", "{not json");
    expect(readTombstones("notes")).toEqual({});
    expect(() => recordTombstone("notes", "n1")).not.toThrow();
    expect(readTombstones("notes").n1).toBeGreaterThan(0);
  });
});