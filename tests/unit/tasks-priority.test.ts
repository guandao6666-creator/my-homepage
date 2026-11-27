/**
 * 2.0.6 · 任务优先级归一化的回归测试
 *
 * 旧代码：排序里 `PRIORITY[a.priority].weight`、同步里 `(incoming.priority as Priority)`
 * —— 只要 localStorage 或别的设备送来枚举外字符串，任务中心整页 TypeError。
 * 这里测纯函数，并用源码断言确认 tasks-store 的四个入口都用了它。
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { normalizePriority, normalizeTaskRecord, normalizeTaskRecords } from "../../src/lib/os14/tasks-model";

describe("任务优先级归一化", () => {
  it("枚举外/缺失值收敛到 normal", () => {
    expect(normalizePriority("high")).toBe("high");
    expect(normalizePriority("low")).toBe("low");
    expect(normalizePriority("urgent")).toBe("normal");
    expect(normalizePriority(undefined)).toBe("normal");
    expect(normalizePriority(3)).toBe("normal");
    expect(normalizePriority(null)).toBe("normal");
  });

  it("坏记录不让 PRIORITY 查询崩：全部是有三档之一的形状", () => {
    const records = normalizeTaskRecords([
      { id: "t1", priority: "urgent" },
      { id: "t2" },
      { id: "", priority: "high" },
      "nope",
      null,
    ]);
    expect(records.map((r) => r.id)).toEqual(["t1", "t2"]);
    expect(records.map((r) => r.priority)).toEqual(["normal", "normal"]);
    // 模拟旧排序：这两步在旧数据上会 undefined.weight。
    expect(records.map((r) => ({ normal: 2, high: 3, low: 1 })[r.priority])).toEqual([2, 2]);
  });

  it("字段类型被强制成渲染可用的形状", () => {
    const record = normalizeTaskRecord({
      id: "t3",
      title: 42,
      note: null,
      due: 5,
      category: "",
      done: "yes",
      createdAt: "abc",
    });
    expect(record).toMatchObject({ id: "t3", title: "未命名任务", note: "", due: "", category: "other", done: true, createdAt: 0 });
  });

  it("tasks-store 的读取/排序/新增/同步都走归一化（只改纯函数不算修）", () => {
    const source = readFileSync(new URL("../../src/lib/os14/tasks-store.ts", import.meta.url), "utf8");
    expect(source).toContain("normalizeTaskRecords(raw.tasks)");
    expect(source).toContain("PRIORITY[normalizePriority(a.priority)]");
    expect(source).toContain("priority: normalizePriority(patch.priority)");
    expect(source).toContain("priority: normalizePriority(incoming.priority)");
  });
});