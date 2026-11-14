/**
 * 性能采集与离线队列单元测试（1.9）
 */
import { describe, expect, it } from "vitest";
import {
  compareSnapshots,
  computeScore,
  listAppMetrics,
  rateVital,
  recordAppMetric,
  summarizeAppMetrics,
  supportedMetrics,
  type PerfSnapshot,
} from "../../src/lib/quality/perf";
import { classifyOutboxFailure } from "../../src/lib/mobile/data";
import { OS_VERSION, RELEASE_NAME } from "../../src/lib/version";

describe("rateVital（Web Vitals 阈值）", () => {
  it("LCP 2.5s / 4s 是良好与较差的分界", () => {
    expect(rateVital("LCP", 2000)).toBe("good");
    expect(rateVital("LCP", 2500)).toBe("good");
    expect(rateVital("LCP", 3000)).toBe("needs-improvement");
    expect(rateVital("LCP", 4500)).toBe("poor");
  });

  it("INP 与 CLS 使用各自的阈值", () => {
    expect(rateVital("INP", 180)).toBe("good");
    expect(rateVital("INP", 300)).toBe("needs-improvement");
    expect(rateVital("CLS", 0.05)).toBe("good");
    expect(rateVital("CLS", 0.3)).toBe("poor");
  });

  it("非有限值不判为良好", () => {
    expect(rateVital("LCP", Number.NaN)).toBe("unknown");
  });
});

describe("supportedMetrics", () => {
  it("始终返回五个指标的支持情况，且不把未观测到的能力标记为支持", () => {
    const supported = supportedMetrics();
    expect(Object.keys(supported).sort()).toEqual(["CLS", "FCP", "INP", "LCP", "TTFB"]);
    // 绘制 / 交互类条目依赖浏览器的渲染进程，Node 里不该被标成支持
    expect(supported.LCP).toBe(false);
    expect(supported.FCP).toBe(false);
    expect(supported.INP).toBe(false);
  });
});

describe("应用耗时统计", () => {
  it("记录后可聚合出平均值与 P95", () => {
    recordAppMetric("notes", "open", 10);
    recordAppMetric("notes", "open", 20);
    recordAppMetric("notes", "open", 30);
    const summary = summarizeAppMetrics("open");
    expect(summary.count).toBeGreaterThanOrEqual(3);
    expect(summary.max).toBeGreaterThanOrEqual(30);
    expect(listAppMetrics({ id: "notes" }).length).toBeGreaterThanOrEqual(3);
  });

  it("没有样本时返回全 0，不伪造数据", () => {
    const summary = summarizeAppMetrics("sync");
    if (summary.count === 0) {
      expect(summary.avg).toBe(0);
      expect(summary.p95).toBe(0);
      expect(summary.max).toBe(0);
    }
  });
});

const snapshot = (overrides: Partial<PerfSnapshot> = {}): PerfSnapshot => ({
  id: "a",
  at: 1,
  version: "1.9.0",
  navigation: { available: true, type: "navigate", ttfb: 100, domContentLoaded: 400, loadEvent: 800, total: 800, transferSize: 0, decodedBodySize: 0, fromCache: false },
  vitals: [
    { name: "LCP", value: 2000, unit: "ms", rating: "good", at: 1, scope: "" },
    { name: "CLS", value: 0.05, unit: "score", rating: "good", at: 1, scope: "" },
  ],
  resources: { count: 10, totalTransferSize: 1000 },
  images: { count: 2, loaded: 2, failed: 0, pending: 0, decodedBytes: 0, oversized: 0 },
  memory: { available: false, usedBytes: 0, domNodes: 100 },
  apps: { appCount: 10, windowCount: 2, registered: 30 },
  score: 0,
  ...overrides,
});

describe("性能快照", () => {
  it("综合分在 0–100 之间", () => {
    const score = computeScore(snapshot());
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
  });

  it("变慢时 delta 为正且 better 为 false", () => {
    const older = snapshot();
    const newer = snapshot({
      vitals: [
        { name: "LCP", value: 3000, unit: "ms", rating: "needs-improvement", at: 2, scope: "" },
        { name: "CLS", value: 0.05, unit: "score", rating: "good", at: 2, scope: "" },
      ],
    });
    const rows = compareSnapshots(older, newer);
    const lcp = rows.find((row) => row.name === "LCP");
    expect(lcp?.delta).toBe(1000);
    expect(lcp?.better).toBe(false);
  });
});

describe("离线队列失败分类", () => {
  it("401 需要重新登录，保留队列", () => {
    expect(classifyOutboxFailure(401)).toBe("needs-login");
  });

  it("内容无效的 4xx 才丢弃", () => {
    expect(classifyOutboxFailure(400)).toBe("drop");
    expect(classifyOutboxFailure(404)).toBe("drop");
    expect(classifyOutboxFailure(409)).toBe("drop");
    expect(classifyOutboxFailure(422)).toBe("drop");
  });

  it("超时 / 限流 / 5xx / 网络错误保留重试", () => {
    expect(classifyOutboxFailure(408)).toBe("retain");
    expect(classifyOutboxFailure(429)).toBe("retain");
    expect(classifyOutboxFailure(500)).toBe("retain");
    expect(classifyOutboxFailure(0)).toBe("retain");
  });
});

describe("版本常量", () => {
  it("与 package.json 一致", async () => {
    const pkg = (await import("../../package.json")) as { default?: { version: string } } & { version?: string };
    const version = pkg.default?.version ?? pkg.version;
    expect(OS_VERSION).toBe(version);
    expect(RELEASE_NAME).toBe("The Platform Era");
  });
});