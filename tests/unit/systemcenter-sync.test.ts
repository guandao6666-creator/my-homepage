import { describe, expect, it } from "vitest";

import type { SyncConflict } from "../../src/lib/sync/conflicts";

/**
 * System Center 云端面板的纯函数单测（vitest node 环境，无 DOM）：
 * 冲突行投影、域标签与实体 id 展示、检测时间格式、配额文案、解决结果提示。
 * 这里不测 DOM 渲染与事件绑定——它们依赖内核与浏览器，由 e2e 覆盖。
 */

class MemoryStorage {
  private map = new Map<string, string>();

  getItem(key: string): string | null {
    const value = this.map.get(key);
    return value === undefined ? null : value;
  }

  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }

  get length(): number {
    return this.map.size;
  }
}

// systemcenter 会间接加载冲突存储；先注入内存 localStorage，再动态 import
(globalThis as unknown as { localStorage: MemoryStorage }).localStorage = new MemoryStorage();

const {
  CONFLICT_ROW_LIMIT,
  QUOTA_UNAVAILABLE_TEXT,
  conflictDomainLabel,
  conflictEntityShort,
  conflictViewItems,
  formatConflictTime,
  quotaText,
  conflictResolveNotice,
} = await import("../../src/lib/os20/apps/systemcenter");

// 用本地时间构造基准，避免测试机时区影响断言
const BASE = new Date(2026, 0, 5, 9, 7).getTime();

const makeConflict = (overrides: Partial<SyncConflict> = {}): SyncConflict => ({
  id: "notes:n1",
  domain: "notes",
  entityId: "n1",
  localRevision: 2,
  serverRevision: 3,
  localUpdatedAt: BASE,
  serverUpdatedAt: BASE + 1,
  detectedAt: BASE,
  state: "open",
  ...overrides,
});

describe("conflictDomainLabel", () => {
  it("已知域使用人话标签", () => {
    expect(conflictDomainLabel("notes")).toBe("Notes");
    expect(conflictDomainLabel("tasks")).toBe("Tasks");
    expect(conflictDomainLabel("calendar")).toBe("Calendar");
    expect(conflictDomainLabel("workspace")).toBe("Workspace");
    expect(conflictDomainLabel("preferences")).toBe("Preferences");
  });

  it("未知域如实显示原始 id，不伪装成已知域", () => {
    expect(conflictDomainLabel("custom")).toBe("custom");
    expect(conflictDomainLabel(" notes ")).toBe("Notes");
  });

  it("空域显示未知数据域", () => {
    expect(conflictDomainLabel("")).toBe("未知数据域");
    expect(conflictDomainLabel("   ")).toBe("未知数据域");
  });
});

describe("conflictEntityShort", () => {
  it("短 id 原样返回", () => {
    expect(conflictEntityShort("n1")).toBe("n1");
    expect(conflictEntityShort("abcdefghijklmnopqr")).toBe("abcdefghijklmnopqr");
  });

  it("长 id 保留头尾并截断到上限", () => {
    const short = conflictEntityShort("pref-very-long-entity-identifier-123456");
    expect(short).toContain("…");
    expect(short.length).toBeLessThanOrEqual(18);
    expect(short.startsWith("pref-very-l")).toBe(true);
    expect(short.endsWith("123456")).toBe(true);
  });

  it("支持自定义上限", () => {
    const short = conflictEntityShort("abcdefghijklmnopqrstuvwxyz", 10);
    expect(short.length).toBeLessThanOrEqual(10);
    expect(short).toContain("…");
  });

  it("空 id 给出可读占位", () => {
    expect(conflictEntityShort("")).toBe("（无 id）");
    expect(conflictEntityShort("   ")).toBe("（无 id）");
  });
});

describe("formatConflictTime", () => {
  it("输出固定本地格式 YYYY-MM-DD HH:mm", () => {
    expect(formatConflictTime(BASE)).toBe("2026-01-05 09:07");
    expect(formatConflictTime(new Date(2026, 10, 25, 18, 3).getTime())).toBe("2026-11-25 18:03");
  });

  it("无效时间显示时间未知", () => {
    expect(formatConflictTime(0)).toBe("时间未知");
    expect(formatConflictTime(Number.NaN)).toBe("时间未知");
    expect(formatConflictTime(-1)).toBe("时间未知");
  });
});

describe("conflictViewItems", () => {
  it("只保留未解决记录，并按检测时间倒序", () => {
    const older = makeConflict({ id: "notes:old", entityId: "old", detectedAt: BASE - 10_000 });
    const newer = makeConflict({ id: "tasks:new", domain: "tasks", entityId: "new", detectedAt: BASE });
    const resolved = makeConflict({ id: "notes:done", entityId: "done", state: "resolved", detectedAt: BASE + 5 });
    const items = conflictViewItems([older, resolved, newer]);
    expect(items.map((item) => item.id)).toEqual(["tasks:new", "notes:old"]);
  });

  it("默认最多 5 条，不修改入参", () => {
    const list = Array.from({ length: 8 }, (_, index) =>
      makeConflict({ id: `notes:${index}`, entityId: `e${index}`, detectedAt: BASE + index }),
    );
    const snapshot = JSON.stringify(list);
    const items = conflictViewItems(list);
    expect(items).toHaveLength(CONFLICT_ROW_LIMIT);
    expect(items.map((item) => item.id)).toEqual(["notes:7", "notes:6", "notes:5", "notes:4", "notes:3"]);
    expect(JSON.stringify(list)).toBe(snapshot);
  });

  it("limit 可覆盖；0 与空输入返回空数组", () => {
    const list = Array.from({ length: 4 }, (_, index) =>
      makeConflict({ id: `notes:${index}`, entityId: `e${index}`, detectedAt: BASE + index }),
    );
    expect(conflictViewItems(list, { limit: 2 }).map((item) => item.id)).toEqual(["notes:3", "notes:2"]);
    expect(conflictViewItems(list, { limit: 0 })).toEqual([]);
    expect(conflictViewItems([])).toEqual([]);
    expect(conflictViewItems(undefined as unknown as SyncConflict[])).toEqual([]);
  });

  it("产出展示字段：域标签、截断 id、检测时间、两边 revision", () => {
    const [item] = conflictViewItems([
      makeConflict({
        domain: "preferences",
        entityId: "pref-very-long-entity-identifier-123456",
        localRevision: 7,
        serverRevision: 9,
      }),
    ]);
    expect(item.domainLabel).toBe("Preferences");
    expect(item.entityId).toBe("pref-very-long-entity-identifier-123456");
    expect(item.entityShort).toContain("…");
    expect(item.detectedText).toBe("2026-01-05 09:07");
    expect(item.localRevision).toBe(7);
    expect(item.serverRevision).toBe(9);
  });

  it("未知域与损坏字段不抛错", () => {
    const items = conflictViewItems([
      makeConflict({ domain: "custom", entityId: "", detectedAt: Number.NaN }),
    ]);
    expect(items[0].domainLabel).toBe("custom");
    expect(items[0].entityShort).toBe("（无 id）");
    expect(items[0].detectedText).toBe("时间未知");
  });
});

describe("quotaText", () => {
  it("正常响应显示实体数与墓碑数及上限", () => {
    const text = quotaText({
      entityCount: 1234,
      tombstoneCount: 56,
      limits: { maxEntities: 5000, maxTombstones: 2000 },
    });
    expect(text.available).toBe(true);
    expect(text.entitiesText).toBe("1,234 / 5,000");
    expect(text.tombstonesText).toBe("56 / 2,000");
    expect(text.entityCount).toBe(1234);
    expect(text.tombstoneCount).toBe(56);
    expect(text.maxEntities).toBe(5000);
    expect(text.maxTombstones).toBe(2000);
  });

  it("缺 limits 时回退到服务端默认上限", () => {
    const text = quotaText({ entityCount: 3, tombstoneCount: 4 });
    expect(text.available).toBe(true);
    expect(text.entitiesText).toBe("3 / 5,000");
    expect(text.tombstonesText).toBe("4 / 2,000");
    expect(text.maxEntities).toBe(5000);
    expect(text.maxTombstones).toBe(2000);
  });

  it("部分 limits 缺失时只回退缺失项", () => {
    const text = quotaText({ entityCount: 1, tombstoneCount: 2, limits: { maxEntities: 8000 } });
    expect(text.entitiesText).toBe("1 / 8,000");
    expect(text.tombstonesText).toBe("2 / 2,000");
  });

  it("0 是有效配额，不显示为不可用", () => {
    const text = quotaText({ entityCount: 0, tombstoneCount: 0 });
    expect(text.available).toBe(true);
    expect(text.entitiesText).toBe("0 / 5,000");
    expect(text.tombstonesText).toBe("0 / 2,000");
  });

  it("数字字符串也能解析（JSON 字段类型漂移容错）", () => {
    const text = quotaText({ entityCount: "12", tombstoneCount: "3" });
    expect(text.entitiesText).toBe("12 / 5,000");
    expect(text.tombstonesText).toBe("3 / 2,000");
  });

  it("响应缺失或损坏时统一显示配额信息暂不可用且不抛错", () => {
    for (const input of [null, undefined, {}, "oops", 42, { entityCount: undefined, tombstoneCount: undefined }]) {
      const text = quotaText(input);
      expect(text.available).toBe(false);
      expect(text.entitiesText).toBe(QUOTA_UNAVAILABLE_TEXT);
      expect(text.tombstonesText).toBe(QUOTA_UNAVAILABLE_TEXT);
    }
    expect(QUOTA_UNAVAILABLE_TEXT).toBe("配额信息暂不可用");
  });
});

describe("conflictResolveNotice", () => {
  it("保留本地 / 保留云端给出明确成功文案", () => {
    expect(conflictResolveNotice({ ok: true, resolved: "local" })).toEqual({
      tone: "ok",
      text: "已保留本地版本，冲突已解决",
    });
    expect(conflictResolveNotice({ ok: true, resolved: "remote" })).toEqual({
      tone: "ok",
      text: "已保留云端版本，冲突已解决",
    });
  });

  it("重复点击（noop）不报错", () => {
    expect(conflictResolveNotice({ ok: true, noop: true }).text).toBe("这条冲突已经处理过，无需重复操作");
    expect(conflictResolveNotice({ ok: true }).text).toBe("这条冲突已经处理过，无需重复操作");
  });

  it("conflict 再次变化时必须提示重新确认", () => {
    expect(conflictResolveNotice({ ok: false, reason: "changed" })).toEqual({
      tone: "warn",
      text: "同步版本已再次变化，请重新确认",
    });
  });

  it("离线 / 不支持 / 其他失败都有可读文案", () => {
    expect(conflictResolveNotice({ ok: false, reason: "offline" }).text).toBe("当前离线或未登录，无法解决冲突");
    expect(conflictResolveNotice({ ok: false, reason: "unsupported" }).text).toBe("该数据域暂不支持解决冲突");
    expect(conflictResolveNotice({ ok: false, reason: "error", error: "boom" })).toEqual({
      tone: "error",
      text: "解决冲突失败，请稍后重试",
    });
  });

  it("异常入参也返回安全提示", () => {
    expect(conflictResolveNotice(null as unknown as { ok: false; reason: "error" }).text).toBe(
      "解决冲突失败，请稍后重试",
    );
  });
});
