/**
 * Guandao OS 2.2 / 6.1 · legacy-apps 模块契约测试。
 *
 * E2E 证明「行为没变」，这里补四件 E2E 不好覆盖的事：
 *   1. 每个迁移模块的形状合法（id 唯一、body 返回字符串、清单顺序 = 1.0 时代 APPS 键序）；
 *   2. 6.1 懒加载清单的元数据与模块导出一致（两处元数据不允许漂移）；
 *   3. 适配器把外壳能力显式传进去，模块源码不碰外壳闭包（不读全局）；
 *   4. lifecycle port 的登记 / 清理语义（窗口关闭时计时器与监听确实被回收）。
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LEGACY_APP_MANIFEST, legacyWindowLifecycle, registerLegacyApps } from "../../src/lib/legacy-apps";
import { createRankReporter, RANK_NAME_KEY } from "../../src/lib/legacy-apps/leaderboard/report";
import { DRAW_QUOTES, DRAW_BONUS } from "../../src/lib/legacy-apps/draw/quotes";
import type { LegacyAppContext, LegacyAppSpec } from "../../src/lib/legacy-apps/types";

function makeCtx(overrides: Partial<LegacyAppContext> = {}): LegacyAppContext {
  return {
    escapeHtml: (text: string) => String(text).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch] as string),
    data: {
      posts: [
        { title: "标题", href: "/blog/a/", date: "2026-01-01", tags: ["日常"], minutes: 1 },
      ],
      tracks: [],
      site: { author: "管道", host: "guandao.xin" },
      supabase: { url: "https://sb.test", key: "anon-key" },
    },
    fetchWithTimeout: vi.fn(async () => new Response("{}")),
    register: () => undefined,
    lifecycle: {
      interval: vi.fn(() => 1),
      timeout: vi.fn(() => 2),
      onGlobal: vi.fn(),
      dispose: vi.fn(),
    },
    shell: {
      closeWindow: vi.fn(),
      setTheme: vi.fn(),
      setWallpaper: vi.fn(),
      runExtensionCommand: vi.fn(() => null),
      makeId: () => "test-id",
    },
    auth: {
      formHtml: () => '<form class="auth-form"></form>',
      read: () => null,
      ensureFreshToken: vi.fn(async () => null),
      signOut: vi.fn(),
      onChange: vi.fn(),
    },
    achievements: {
      list: () => [],
      state: () => ({ unlocked: {}, visits: 0, petClicks: 0, apps: [], reads: 0 }),
      unlock: vi.fn(() => false),
    },
    desktopFacilities: {
      openWindowCount: () => 0,
      openWindowTitles: () => [],
      deskCount: () => 1,
      bootedAt: Date.now(),
      appTitles: () => ["帖子"],
      phase: () => "day" as const,
    },
    ...overrides,
  };
}

/** 1.0 时代 APPS 的键序：terminal 由 index.astro 的锚点占第一位，这里注册时原地覆盖。 */
const CANONICAL_IDS = [
  "achievements",
  "aquarium",
  "visitors",
  "draw",
  "council",
  "treehole",
  "news",
  "social",
  "monitor",
  "browser",
  "posts",
  "about",
  "rank",
  "calc",
  "viewer",
  "terminal",
];

describe("legacy-apps 注册", () => {
  it("懒加载清单顺序 = 1.0 时代 APPS 键序（启动台 / 程序坞 / 终端 apps 都依赖它）", () => {
    expect(LEGACY_APP_MANIFEST.map((app) => app.id)).toEqual(CANONICAL_IDS);
  });

  it("id 唯一、合法且标题非空", () => {
    const ids = LEGACY_APP_MANIFEST.map((app) => app.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z][a-z0-9-]*$/);
    for (const app of LEGACY_APP_MANIFEST) expect(app.title.length).toBeGreaterThan(0);
  });

  it("清单元数据与模块导出完全一致（6.1 两处元数据不允许漂移）", async () => {
    for (const entry of LEGACY_APP_MANIFEST) {
      const mod = await entry.load();
      expect({ id: mod.id, title: mod.title, width: mod.width, height: mod.height, glyph: mod.glyph }, entry.id).toEqual({
        id: entry.id,
        title: entry.title,
        width: entry.width,
        height: entry.height,
        glyph: entry.glyph,
      });
    }
  });

  it("每个模块都能产出非空 HTML", async () => {
    const ctx = makeCtx();
    for (const entry of LEGACY_APP_MANIFEST) {
      const app = await entry.load();
      const html = app.body(ctx);
      expect(typeof html).toBe("string");
      expect(html.trim().length).toBeGreaterThan(0);
    }
  });

  it("registerLegacyApps 只通过传入的 register 注册，且全部按需加载", () => {
    const specs: LegacyAppSpec[] = [];
    registerLegacyApps(makeCtx({ register: (spec) => specs.push(spec) }));
    // 注册顺序必须与清单一致：APPS 的追加顺序决定了启动台的格子顺序
    expect(specs.map((s) => s.id)).toEqual(LEGACY_APP_MANIFEST.map((app) => app.id));
    for (const spec of specs) {
      expect(spec.title.length).toBeGreaterThan(0);
      // 6.1：入口不再内联 body，窗口打开时才下载实现
      expect(spec.body).toBeUndefined();
      expect(spec.load).toBeTypeOf("function");
    }
  });

  it("load() 返回的 body 与模块直接调用一致", async () => {
    const specs: LegacyAppSpec[] = [];
    const ctx = makeCtx({ register: (spec) => specs.push(spec) });
    registerLegacyApps(ctx);
    for (const spec of specs) {
      const lazy = await spec.load?.();
      const app = await LEGACY_APP_MANIFEST.find((entry) => entry.id === spec.id)?.load();
      expect(lazy?.body()).toBe(app?.body(ctx));
    }
  });

  it("带 init 的应用与清单一致（init 的 DOM 绑定由 E2E 验证）", async () => {
    const withInit: string[] = [];
    for (const entry of LEGACY_APP_MANIFEST) {
      const app = await entry.load();
      if (typeof app.init === "function") withInit.push(app.id);
    }
    expect(withInit.sort()).toEqual([
      "aquarium",
      "browser",
      "calc",
      "council",
      "draw",
      "monitor",
      "news",
      "rank",
      "social",
      "terminal",
      "treehole",
      "viewer",
      "visitors",
    ]);
  });

  it("模块源码不读外壳闭包（能力必须从 ctx 显式注入）", () => {
    const shellOnly = [
      "readAuth",
      "writeAuth",
      "authFormHtml",
      "readAch(",
      "phaseNow(",
      "applyOsTheme",
      "writeState",
      "readState",
      "readDock",
      "renderDock",
      "querySelectorAll(\".window\")",
      "OS_BOOT",
      "window.__OS__",
      "window.GOS14",
    ];
    for (const app of LEGACY_APP_MANIFEST) {
      const dir = app.id === "rank" ? "leaderboard" : app.id === "posts" ? "articles" : app.id;
      const file = path.join(process.cwd(), "src", "lib", "legacy-apps", dir, "index.ts");
      if (!fs.existsSync(file)) continue;
      // 去掉注释，避免注释里提到旧函数名造成误报
      const code = fs
        .readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      for (const forbidden of shellOnly) expect(code, `${app.id} 不应直接使用 ${forbidden}`).not.toContain(forbidden);
    }
  });
});

/** 极简 window 桩：lifecycle port 只用到这几个 API。 */
function installWindowStub() {
  const intervals = new Map<number, () => void>();
  const timeouts = new Map<number, () => void>();
  const listeners = new Set<[string, EventListener]>();
  let seq = 0;
  const stub = {
    setInterval: vi.fn((handler: () => void) => {
      const id = ++seq;
      intervals.set(id, handler);
      return id;
    }),
    clearInterval: vi.fn((id: number) => intervals.delete(id)),
    setTimeout: vi.fn((handler: () => void) => {
      const id = ++seq;
      timeouts.set(id, handler);
      return id;
    }),
    clearTimeout: vi.fn((id: number) => timeouts.delete(id)),
    addEventListener: vi.fn((type: string, handler: EventListener) => listeners.add([type, handler])),
    removeEventListener: vi.fn((type: string, handler: EventListener) => {
      for (const item of listeners) if (item[0] === type && item[1] === handler) listeners.delete(item);
    }),
  };
  (globalThis as unknown as { window: typeof stub }).window = stub;
  return { stub, intervals, timeouts, listeners };
}

function fakeWin(): HTMLElement {
  return {
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dataset: {},
    classList: { add: () => undefined, remove: () => undefined, toggle: () => undefined },
    appendChild: () => undefined,
    contains: () => false,
    focus: () => undefined,
    setAttribute: () => undefined,
    style: {},
    textContent: "",
    innerHTML: "",
    isConnected: true,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }),
  } as unknown as HTMLElement;
}

describe("lifecycle port", () => {
  afterEach(() => {
    delete (globalThis as unknown as { window?: unknown }).window;
  });

  it("interval / timeout / onGlobal 都会登记，dispose 一次性回收", () => {
    const { stub, intervals, timeouts, listeners } = installWindowStub();
    const win = fakeWin();

    const tick = () => undefined;
    legacyWindowLifecycle.interval(win, tick, 1000);
    legacyWindowLifecycle.timeout(win, () => undefined, 50);
    const listener = () => undefined;
    legacyWindowLifecycle.onGlobal(win, "guandao:auth-change", listener);
    expect(intervals.size).toBe(1);
    expect(timeouts.size).toBe(1);
    expect(listeners.size).toBe(1);
    expect(stub.addEventListener).toHaveBeenCalledWith("guandao:auth-change", listener);

    legacyWindowLifecycle.dispose(win);
    expect(stub.clearInterval).toHaveBeenCalledTimes(1);
    expect(stub.clearTimeout).toHaveBeenCalledTimes(1);
    expect(stub.removeEventListener).toHaveBeenCalledWith("guandao:auth-change", listener);
    expect(intervals.size).toBe(0);
    expect(timeouts.size).toBe(0);
    expect(listeners.size).toBe(0);
  });

  it("timeout 触发后自动从登记表移除，dispose 不会重复 clear", () => {
    const { stub, timeouts } = installWindowStub();
    const win = fakeWin();
    const handler = vi.fn();
    legacyWindowLifecycle.timeout(win, handler, 50);
    const entry = [...timeouts.values()][0];
    entry();
    expect(handler).toHaveBeenCalledTimes(1);
    // 触发后从 lifecycle 内部登记表移除（stub 的 map 只是 setTimeout 的调用记录）
    legacyWindowLifecycle.dispose(win);
    expect(stub.clearTimeout).not.toHaveBeenCalled();
  });

  it("registerLegacyApps 的 init 包装在 cleanup 时调用 dispose", async () => {
    const { stub } = installWindowStub();
    const win = fakeWin();
    const dispose = vi.fn();
    const specs: LegacyAppSpec[] = [];
    const ctx = makeCtx({ lifecycle: { interval: vi.fn(), timeout: vi.fn(), onGlobal: vi.fn(), dispose }, register: (spec) => specs.push(spec) });
    registerLegacyApps(ctx);
    const initSpec = specs.find((spec) => spec.id === "terminal");
    // 6.1：init 随模块一起按需加载，先 load 再取
    const lazy = await initSpec?.load?.();
    expect(lazy?.init).toBeTypeOf("function");
    const cleanup = lazy?.init?.(win);
    expect(cleanup).toBeTypeOf("function");
    cleanup?.();
    expect(dispose).toHaveBeenCalledWith(win);
    // terminal 的 init 只做输入框绑定，窗口桩里没有输入框，应该干净退出而不是抛错
    expect(stub.setInterval).not.toHaveBeenCalled();
  });
});

describe("抽签文案共享模块", () => {
  it("桌面「今日一句」与抽奖应用共用同一份签文", () => {
    expect(DRAW_QUOTES.length).toBe(28);
    expect(DRAW_BONUS).toBe("今日幸运：解锁隐藏成就「手气不错」");
    expect(new Set(DRAW_QUOTES).size).toBe(DRAW_QUOTES.length);
  });
});

describe("排行榜上报适配器", () => {
  it("键名保持 1.0 的值，不能改", () => {
    expect(RANK_NAME_KEY).toBe("guandao.rank.name");
  });

  it("未配置 Supabase 时不发请求", async () => {
    const fetchWithTimeout = vi.fn(async () => new Response("{}"));
    const report = createRankReporter(undefined, fetchWithTimeout);
    await report("管道", 60);
    expect(fetchWithTimeout).not.toHaveBeenCalled();
  });

  it("配置后 POST 到 report_time 并携带正确参数", async () => {
    const fetchWithTimeout = vi.fn(async () => new Response("{}"));
    const report = createRankReporter({ url: "https://sb.test", key: "anon" }, fetchWithTimeout);
    await report("管道", 60);

    expect(fetchWithTimeout).toHaveBeenCalledTimes(1);
    const [url, init] = fetchWithTimeout.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://sb.test/rest/v1/rpc/report_time");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ p_name: "管道", p_seconds: 60 });
  });

  it("上报失败被吞掉，不向调用方抛错", async () => {
    const fetchWithTimeout = vi.fn(async () => {
      throw new Error("network down");
    });
    const report = createRankReporter({ url: "https://sb.test", key: "anon" }, fetchWithTimeout);
    await expect(report("管道", 60)).resolves.toBeUndefined();
  });
});

describe("排行榜异步加载的生命周期", () => {
  afterEach(() => {
    delete (globalThis as unknown as { localStorage?: unknown }).localStorage;
  });

  it("窗口已关闭时，请求返回后不再写 DOM", async () => {
    const writes: string[] = [];
    const node = (tag: string) => ({
      set textContent(value: string) {
        writes.push(`${tag}.text=${value}`);
      },
      set innerHTML(value: string) {
        writes.push(`${tag}.html=${value}`);
      },
      addEventListener: () => undefined,
      disabled: false,
    });
    const list = node("list");
    const status = node("status");
    const join = node("join");
    // 窗口已脱离文档：init 仍会跑一次，但请求返回后不得再碰 DOM
    const win = {
      ...fakeWin(),
      isConnected: false,
      querySelector: (selector: string) =>
        selector === "#rank-list" ? list : selector === "#rank-status" ? status : selector === "#rank-join" ? join : null,
    } as unknown as HTMLElement;

    // 排行榜会读 localStorage 里的昵称，node 环境需要最小桩
    (globalThis as unknown as { localStorage: unknown }).localStorage = {
      getItem: () => null,
      setItem: () => undefined,
    };

    const ctx = makeCtx({
      fetchWithTimeout: vi.fn(async () =>
        new Response(JSON.stringify([{ name: "管道", seconds: 60, visits: 3 }]), { status: 200 }),
      ),
    });
    const rank = (await import("../../src/lib/legacy-apps/leaderboard")).leaderboardApp;
    rank.init?.(win, ctx);
    // 等请求与回调走完
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(writes.filter((entry) => entry.startsWith("list.") || entry.startsWith("status."))).toEqual([]);
  });
});
