/**
 * Guandao OS 2.2 · legacy-apps 模块契约测试。
 *
 * E2E 证明「行为没变」，这里补两件 E2E 不好覆盖的事：
 *   1. 每个迁移模块的形状合法（id 唯一、body 返回字符串）；
 *   2. 适配器把外壳能力显式传进去，而不是靠全局变量。
 */
import { describe, expect, it, vi } from "vitest";
import { LEGACY_APPS, registerLegacyApps } from "../../src/lib/legacy-apps";
import { createRankReporter, RANK_NAME_KEY } from "../../src/lib/legacy-apps/leaderboard/report";
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
    ...overrides,
  };
}

describe("legacy-apps 注册", () => {
  it("已迁移应用的 id 唯一且非空", () => {
    const ids = LEGACY_APPS.map((app) => app.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z][a-z0-9-]*$/);
  });

  it("每个模块都能产出非空 HTML", () => {
    const ctx = makeCtx();
    for (const app of LEGACY_APPS) {
      const html = app.body(ctx);
      expect(typeof html).toBe("string");
      expect(html.trim().length).toBeGreaterThan(0);
    }
  });

  it("registerLegacyApps 只通过传入的 register 注册，不依赖全局", () => {
    const specs: LegacyAppSpec[] = [];
    registerLegacyApps(makeCtx({ register: (spec) => specs.push(spec) }));
    expect(specs.map((s) => s.id).sort()).toEqual(LEGACY_APPS.map((app) => app.id).sort());
    for (const spec of specs) {
      expect(spec.title.length).toBeGreaterThan(0);
      expect(spec.body()).toBeTruthy();
    }
  });

  it("带 init 的应用确实声明了初始化函数", () => {
    // init 的实际 DOM 绑定由 tests/e2e/legacy-apps.spec.ts 验证（真实浏览器）
    const withInit = LEGACY_APPS.filter((app) => typeof app.init === "function").map((app) => app.id);
    expect(withInit.sort()).toEqual(["calc", "rank", "viewer"]);
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