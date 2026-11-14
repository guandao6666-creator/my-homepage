/**
 * Guandao OS 2.0 · Core 单元测试（总线 / 生命周期 / 存储 / 设置）
 *
 * 这些是 2.0 的平台地基：任何一条退化都会让「统一内核」变成空话，
 * 所以用纯 Node 单测把语义钉死（不依赖 DOM）。
 */
import { describe, expect, it, vi } from "vitest";
import { createBus } from "../../src/lib/core/bus";
import { createServiceHost } from "../../src/lib/core/service";
import { createStorage, MemoryStore } from "../../src/lib/core/storage";
import { createSettings } from "../../src/lib/core/settings";

describe("EventBus", () => {
  it("按订阅顺序同步派发", () => {
    const bus = createBus();
    const order: string[] = [];
    bus.on("ping", () => order.push("a"));
    bus.on("ping", () => order.push("b"));
    const result = bus.emit("ping", 1);
    expect(order).toEqual(["a", "b"]);
    expect(result.delivered).toBe(2);
    expect(result.errors).toBe(0);
  });

  it("单个订阅者抛错不会打断其他订阅者", () => {
    const onError = vi.fn();
    const bus = createBus({ onError });
    const hits: string[] = [];
    bus.on("x", () => {
      throw new Error("boom");
    });
    bus.on("x", () => hits.push("after"));
    const result = bus.emit("x");
    expect(hits).toEqual(["after"]);
    expect(result.errors).toBe(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(bus.stats().errors).toBe(1);
  });

  it("once 只触发一次，取消订阅幂等", () => {
    const bus = createBus();
    const handler = vi.fn();
    const off = bus.once("y", handler);
    bus.emit("y");
    bus.emit("y");
    expect(handler).toHaveBeenCalledTimes(1);
    off();
    off();
    expect(bus.stats().handlers).toBe(0);
  });

  it("通配订阅能拿到事件名与负载", () => {
    const bus = createBus();
    const seen: Array<{ type: string; payload: unknown }> = [];
    bus.on("*", (payload) => {
      const meta = payload as { type: string; payload: unknown };
      seen.push({ type: meta.type, payload: meta.payload });
    });
    bus.emit("hello", { a: 1 });
    expect(seen).toEqual([{ type: "hello", payload: { a: 1 } }]);
  });

  it("waitFor 等到事件；超时会 reject", async () => {
    const bus = createBus();
    setTimeout(() => bus.emit("ready", "ok"), 5);
    await expect(bus.waitFor<string>("ready", 200)).resolves.toBe("ok");
    await expect(bus.waitFor("never", 20)).rejects.toThrow(/超时/);
  });

  it("历史记录按上限裁剪", () => {
    const bus = createBus({ maxHistory: 3 });
    for (let i = 0; i < 5; i += 1) bus.emit("e", i);
    const recent = bus.recent(10);
    expect(recent).toHaveLength(3);
    expect(recent.map((entry) => entry.payload)).toEqual([2, 3, 4]);
  });
});

describe("ServiceHost（生命周期）", () => {
  it("按依赖顺序启动，逆序销毁", async () => {
    const host = createServiceHost();
    const log: string[] = [];
    host.register({
      id: "b",
      title: "B",
      requires: ["a"],
      hooks: {
        start: () => {
          log.push("start-b");
        },
        dispose: () => {
          log.push("dispose-b");
        },
      },
    });
    host.register({
      id: "a",
      title: "A",
      hooks: {
        initialize: () => {
          log.push("init-a");
        },
        start: () => {
          log.push("start-a");
        },
        dispose: () => {
          log.push("dispose-a");
        },
      },
    });

    const result = await host.startAll();
    expect(result.started).toEqual(["a", "b"]);
    expect(log).toEqual(["init-a", "start-a", "start-b"]);

    await host.disposeAll();
    expect(log.slice(3)).toEqual(["dispose-b", "dispose-a"]);
  });

  it("一个服务失败不会阻止其他服务启动", async () => {
    const host = createServiceHost();
    host.register({ id: "bad", title: "Bad", hooks: { start: () => { throw new Error("坏了"); } } });
    host.register({ id: "good", title: "Good", hooks: { start: () => undefined } });

    const result = await host.startAll();
    expect(result.started).toContain("good");
    expect(result.failed).toContain("bad");
    expect(host.status("bad")).toBe("failed");
    expect(host.status("good")).toBe("started");
    expect(host.failures()[0].error).toContain("start 失败");
  });

  it("依赖失败时下游被跳过而不是崩掉", async () => {
    const host = createServiceHost();
    host.register({ id: "base", title: "Base", hooks: { start: () => { throw new Error("x"); } } });
    host.register({ id: "child", title: "Child", requires: ["base"], hooks: { start: () => undefined } });
    const result = await host.startAll();
    expect(result.failed).toContain("base");
    expect(result.skipped).toContain("child");
    expect(host.status("child")).toBe("failed");
  });

  it("环依赖被识别为失败，不会死循环", async () => {
    const host = createServiceHost();
    host.register({ id: "a", title: "A", requires: ["b"], hooks: {} });
    host.register({ id: "b", title: "B", requires: ["a"], hooks: {} });
    const result = await host.startAll();
    expect(result.failed.length).toBeGreaterThan(0);
    expect(host.list().every((record) => record.status === "failed")).toBe(true);
  });

  it("阶段超时会被判定为失败", async () => {
    const host = createServiceHost({ phaseTimeoutMs: 20 });
    host.register({ id: "slow", title: "Slow", hooks: { initialize: () => new Promise(() => undefined) } });
    const result = await host.startAll();
    expect(result.failed).toContain("slow");
    expect(host.failures()[0].error).toContain("超时");
  });

  it("activate / suspend 状态机正确", async () => {
    const host = createServiceHost();
    host.register({ id: "s", title: "S", hooks: {} });
    await host.startAll();
    expect(await host.activate("s")).toBe(true);
    expect(host.status("s")).toBe("active");
    expect(await host.suspend("s")).toBe(true);
    expect(host.status("s")).toBe("suspended");
    expect(await host.deactivate("s")).toBe(false);
  });
});

describe("StorageManager", () => {
  const make = (seed: Record<string, string> = {}) =>
    createStorage({ store: new MemoryStore(seed), namespace: "guandao.core", version: 2 });

  it("写入带版本信封，读取自动解包", () => {
    const storage = make();
    expect(storage.write("k", { a: 1 }).ok).toBe(true);
    expect(storage.read("k", null)).toEqual({ a: 1 });
  });

  it("兼容 1.x 的裸 JSON（不回写、不破坏）", () => {
    const storage = make({ "guandao.core.legacy": JSON.stringify({ old: true }) });
    expect(storage.read("legacy", {})).toEqual({ old: true });
  });

  it("旧键只读视图与命名空间隔离", () => {
    const storage = make({
      "guandao.os.notes.v1": "[1]",
      "guandao.core.mine": JSON.stringify({ v: 2, at: 1, data: 1 }),
    });
    expect(storage.legacyKeys()).toContain("guandao.os.notes.v1");
    expect(storage.legacyKeys()).not.toContain("guandao.core.mine");
    expect(storage.legacyStr("guandao.os.notes.v1")).toBe("[1]");
    expect(storage.keys()).toEqual(["mine"]);
  });

  it("超过软配额时拒绝写入并说明原因", () => {
    const storage = createStorage({ store: new MemoryStore(), quotaBytes: 200 });
    const result = storage.write("big", "x".repeat(300));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("quota");
  });

  it("损坏的 JSON 不会抛错", () => {
    const storage = make({ "guandao.core.bad": "{not json" });
    expect(storage.read("bad", { fallback: true })).toEqual({ fallback: true });
  });

  it("存储不可用时如实报告 available=false", () => {
    const storage = createStorage({ store: null });
    expect(storage.available).toBe(false);
  });
});

describe("SettingsManager", () => {
  const make = () =>
    createSettings({
      storage: createStorage({ store: new MemoryStore(), namespace: "guandao.core", version: 2 }),
    });

  it("默认值来自 Schema", () => {
    const settings = make();
    expect(settings.get("appearance.mode")).toBe("dark");
    expect(settings.get("system.mode")).toBe("local");
    expect(settings.get("desktop.clockSeconds")).toBe(false);
  });

  it("更新落盘并在新实例里读回", () => {
    const store = new MemoryStore();
    const first = createSettings({ storage: createStorage({ store }) });
    first.update({ "appearance.mode": "light", "notifications.dnd": true });
    const second = createSettings({ storage: createStorage({ store }) });
    expect(second.get("appearance.mode")).toBe("light");
    expect(second.get("notifications.dnd")).toBe(true);
  });

  it("非法值被拒绝，不会写坏存储", () => {
    const settings = make();
    const result = settings.update({ "appearance.mode": "neon", "notifications.volume": 500 });
    expect(result.rejected).toEqual(["appearance.mode"]);
    expect(settings.get("appearance.mode")).toBe("dark");
    // 数值会被夹到范围内，而不是丢弃
    expect(settings.get("notifications.volume")).toBe(100);
  });

  it("订阅者在设置变化时收到 changed 列表", () => {
    const settings = make();
    const seen: string[] = [];
    settings.subscribe((_values, changes) => seen.push(...changes.map((change) => change.id)));
    settings.set("appearance.animations", false);
    expect(seen).toEqual(["appearance.animations"]);
  });

  it("reset 恢复默认；导出导入可往返", () => {
    const settings = make();
    settings.set("appearance.material", "solid");
    settings.reset(["appearance.material"]);
    expect(settings.get("appearance.material")).toBe("glass");

    settings.set("appearance.radius", "sharp");
    const exported = settings.export();
    settings.reset();
    expect(settings.import(exported).ok).toBe(true);
    expect(settings.get("appearance.radius")).toBe("sharp");
  });
});