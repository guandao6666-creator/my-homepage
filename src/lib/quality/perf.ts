/**
 * Guandao OS 1.9 · 性能采集
 *
 * 只采集「浏览器确实能测到」的东西：
 *   - Navigation Timing / Paint Timing / LCP / CLS / INP（event timing）
 *   - 资源加载（Resource Timing）与图片解码情况
 *   - 本标签页的 JS 堆估算（Chrome 的 performance.memory，非标准，有则用、无则标 N/A）
 *
 * 明确不做：
 *   - 不读取其它标签页的 CPU / 内存；
 *   - 不把一次页面加载的数值说成「这台设备的性能」；
 *   - 不伪造硬件信息（GPU / 核心数拿不到就显示不可用）。
 *
 * 这些数值仅用于本机诊断，默认不上传云端。
 */

import { createScope } from "./resources";

export type Rating = "good" | "needs-improvement" | "poor" | "unknown";

export type VitalsName = "TTFB" | "FCP" | "LCP" | "CLS" | "INP";

export interface VitalMetric {
  name: VitalsName;
  value: number;
  unit: "ms" | "score";
  rating: Rating;
  /** 采集时间戳 */
  at: number;
  /** 该指标的适用范围说明，直接显示给用户，避免误读 */
  scope: string;
}

/** web.dev 推荐的阈值（2024 起 INP 取代 FID） */
const THRESHOLDS: Record<VitalsName, [number, number]> = {
  TTFB: [800, 1800],
  FCP: [1800, 3000],
  LCP: [2500, 4000],
  CLS: [0.1, 0.25],
  INP: [200, 500],
};

export function rateVital(name: VitalsName, value: number): Rating {
  const [good, poor] = THRESHOLDS[name];
  if (!Number.isFinite(value)) return "unknown";
  if (value <= good) return "good";
  if (value <= poor) return "needs-improvement";
  return "poor";
}

export const VITAL_SCOPE: Record<VitalsName, string> = {
  TTFB: "本次页面加载的服务器首字节时间",
  FCP: "本次页面加载首次绘制出内容的时间",
  LCP: "本次页面加载最大内容元素的渲染时间",
  CLS: "本次页面加载期间的布局偏移累计（会话窗口）",
  INP: "本次会话中已观测到的交互里最慢的一次（近似值）",
};

/** 浏览器是否支持该指标 */
export function supportedMetrics(): Record<VitalsName, boolean> {
  const supported: Record<VitalsName, boolean> = { TTFB: false, FCP: false, LCP: false, CLS: false, INP: false };
  if (typeof PerformanceObserver === "undefined") return supported;
  const types = (PerformanceObserver as unknown as { supportedEntryTypes?: string[] }).supportedEntryTypes ?? [];
  supported.TTFB = typeof performance !== "undefined" && typeof performance.getEntriesByType === "function";
  supported.FCP = types.includes("paint");
  supported.LCP = types.includes("largest-contentful-paint");
  supported.CLS = types.includes("layout-shift");
  supported.INP = types.includes("event");
  return supported;
}

/* ============================================================
   实时观察
   ============================================================ */

export interface VitalsObserver {
  metrics: () => VitalMetric[];
  stop: () => void;
}

/**
 * 观察 Web Vitals。
 * 回调会在指标首次可用或明显更新时触发（LCP / CLS 会持续更新到页面隐藏为止）。
 */
export function observeVitals(onMetric?: (metric: VitalMetric) => void): VitalsObserver {
  const collected = new Map<VitalsName, VitalMetric>();
  const scope = createScope("perf:vitals");
  const supported = supportedMetrics();

  const publish = (name: VitalsName, value: number, unit: "ms" | "score") => {
    const metric: VitalMetric = {
      name,
      value: unit === "score" ? Math.round(value * 1000) / 1000 : Math.round(value),
      unit,
      rating: rateVital(name, value),
      at: Date.now(),
      scope: VITAL_SCOPE[name],
    };
    collected.set(name, metric);
    onMetric?.(metric);
  };

  if (typeof performance === "undefined" || typeof PerformanceObserver === "undefined") {
    return { metrics: () => [...collected.values()], stop: () => undefined };
  }

  // TTFB 来自 Navigation Timing（一次加载只有一个值）
  try {
    const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    if (nav && nav.responseStart > 0) publish("TTFB", Math.max(0, nav.responseStart - nav.startTime), "ms");
  } catch {
    /* 老浏览器 */
  }

  if (supported.FCP) {
    try {
      const observer = scope.observer(
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (entry.name === "first-contentful-paint") publish("FCP", entry.startTime, "ms");
          }
        }),
      );
      observer.observe({ type: "paint", buffered: true });
    } catch {
      /* 忽略 */
    }
  }

  let lcpValue = 0;
  if (supported.LCP) {
    try {
      const observer = scope.observer(
        new PerformanceObserver((list) => {
          const entries = list.getEntries();
          const last = entries[entries.length - 1] as PerformanceEntry & { renderTime?: number; loadTime?: number };
          if (!last) return;
          const value = last.renderTime || last.loadTime || last.startTime;
          if (value > lcpValue) {
            lcpValue = value;
            publish("LCP", value, "ms");
          }
        }),
      );
      observer.observe({ type: "largest-contentful-paint", buffered: true });
    } catch {
      /* 忽略 */
    }
  }

  let clsValue = 0;
  let sessionValue = 0;
  let sessionStart = 0;
  let lastTs = 0;
  if (supported.CLS) {
    try {
      const observer = scope.observer(
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries() as Array<PerformanceEntry & { value: number; hadRecentInput: boolean }>) {
            if (entry.hadRecentInput) continue;
            const ts = entry.startTime;
            // 会话窗口：间隔 >1s 或窗口时长 >5s 就重开一个窗口，取最大窗口值
            if (!sessionStart || ts - lastTs > 1000 || ts - sessionStart > 5000) {
              sessionStart = ts;
              sessionValue = 0;
            }
            sessionValue += entry.value;
            lastTs = ts;
            if (sessionValue > clsValue) {
              clsValue = sessionValue;
              publish("CLS", Math.round(clsValue * 1000) / 1000, "score");
            }
          }
        }),
      );
      observer.observe({ type: "layout-shift", buffered: true });
    } catch {
      /* 忽略 */
    }
  }

  // INP 近似：取带 interactionId 的事件里最慢的一次
  let inpValue = 0;
  if (supported.INP) {
    try {
      const observer = scope.observer(
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries() as Array<PerformanceEntry & { interactionId?: number; duration: number }>) {
            if (!entry.interactionId) continue;
            if (entry.duration > inpValue) {
              inpValue = entry.duration;
              publish("INP", inpValue, "ms");
            }
          }
        }),
      );
      observer.observe({ type: "event", buffered: true, durationThreshold: 40 } as PerformanceObserverInit);
    } catch {
      /* Safari 早期版本不支持 event timing */
    }
  }

  return { metrics: () => [...collected.values()], stop: () => scope.dispose() };
}

/* ============================================================
   页面加载数据
   ============================================================ */

export interface NavigationInfo {
  available: boolean;
  /** 导航类型：navigate / reload / back_forward / prerender */
  type: string;
  ttfb: number;
  domContentLoaded: number;
  loadEvent: number;
  /** 页面从开始到 load 的总耗时 */
  total: number;
  transferSize: number;
  decodedBodySize: number;
  /** 本次加载是否来自缓存（transferSize 为 0） */
  fromCache: boolean;
}

export function readNavigation(): NavigationInfo {
  const empty: NavigationInfo = {
    available: false,
    type: "unknown",
    ttfb: 0,
    domContentLoaded: 0,
    loadEvent: 0,
    total: 0,
    transferSize: 0,
    decodedBodySize: 0,
    fromCache: false,
  };
  if (typeof performance === "undefined") return empty;
  try {
    const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    if (!nav) return empty;
    return {
      available: true,
      type: nav.type,
      ttfb: Math.max(0, Math.round(nav.responseStart - nav.startTime)),
      domContentLoaded: Math.max(0, Math.round(nav.domContentLoadedEventEnd - nav.startTime)),
      loadEvent: Math.max(0, Math.round(nav.loadEventEnd - nav.startTime)),
      total: Math.max(0, Math.round((nav.loadEventEnd || nav.domContentLoadedEventEnd) - nav.startTime)),
      transferSize: nav.transferSize ?? 0,
      decodedBodySize: nav.decodedBodySize ?? 0,
      fromCache: (nav.transferSize ?? 0) === 0,
    };
  } catch {
    return empty;
  }
}

/* ============================================================
   资源 / 图片
   ============================================================ */

export interface ResourceBucket {
  type: string;
  count: number;
  transferSize: number;
  duration: number;
}

export interface ResourceInfo {
  available: boolean;
  count: number;
  totalTransferSize: number;
  buckets: ResourceBucket[];
  slowest: Array<{ name: string; type: string; duration: number; transferSize: number }>;
  largest: Array<{ name: string; transferSize: number }>;
}

export function readResources(limit = 5): ResourceInfo {
  const empty: ResourceInfo = { available: false, count: 0, totalTransferSize: 0, buckets: [], slowest: [], largest: [] };
  if (typeof performance === "undefined" || typeof performance.getEntriesByType !== "function") return empty;
  try {
    const entries = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
    if (!entries.length) return { ...empty, available: true };
    const byType = new Map<string, ResourceBucket>();
    let total = 0;
    for (const entry of entries) {
      const type = entry.initiatorType || "other";
      const bucket = byType.get(type) ?? { type, count: 0, transferSize: 0, duration: 0 };
      bucket.count += 1;
      bucket.transferSize += entry.transferSize || 0;
      bucket.duration += entry.duration || 0;
      total += entry.transferSize || 0;
      byType.set(type, bucket);
    }
    return {
      available: true,
      count: entries.length,
      totalTransferSize: total,
      buckets: [...byType.values()].sort((a, b) => b.transferSize - a.transferSize),
      slowest: [...entries]
        .sort((a, b) => b.duration - a.duration)
        .slice(0, limit)
        .map((entry) => ({
          name: shortenUrl(entry.name),
          type: entry.initiatorType || "other",
          duration: Math.round(entry.duration),
          transferSize: entry.transferSize || 0,
        })),
      largest: [...entries]
        .sort((a, b) => (b.transferSize || 0) - (a.transferSize || 0))
        .slice(0, limit)
        .map((entry) => ({ name: shortenUrl(entry.name), transferSize: entry.transferSize || 0 })),
    };
  } catch {
    return empty;
  }
}

export interface ImageInfo {
  count: number;
  loaded: number;
  failed: number;
  pending: number;
  decodedBytes: number;
  /** 超出首屏可视尺寸的大图数量（可能拖慢首屏） */
  oversized: number;
}

/** 统计当前文档里的图片（真实 DOM 状态，不是估算） */
export function readImages(): ImageInfo {
  const empty: ImageInfo = { count: 0, loaded: 0, failed: 0, pending: 0, decodedBytes: 0, oversized: 0 };
  if (typeof document === "undefined") return empty;
  const images = Array.from(document.images);
  let decodedBytes = 0;
  let oversized = 0;
  const viewportWidth = window.innerWidth || 0;
  for (const image of images) {
    // naturalWidth 有值说明解码完成，字节数拿不到，用面积做粗略指标
    if (image.naturalWidth > 0) decodedBytes += image.naturalWidth * image.naturalHeight * 4;
    if (image.naturalWidth > viewportWidth * 2) oversized += 1;
  }
  return {
    count: images.length,
    loaded: images.filter((image) => image.complete && image.naturalWidth > 0).length,
    failed: images.filter((image) => image.complete && image.naturalWidth === 0).length,
    pending: images.filter((image) => !image.complete).length,
    decodedBytes,
    oversized,
  };
}

function shortenUrl(url: string): string {
  try {
    const parsed = new URL(url, typeof location !== "undefined" ? location.href : "http://localhost");
    const path = parsed.pathname;
    return path.length > 60 ? `…${path.slice(-58)}` : path;
  } catch {
    return url.slice(0, 60);
  }
}

/* ============================================================
   内存 / DOM
   ============================================================ */

export interface MemoryInfo {
  /** Chrome 专有；其它浏览器为 false */
  available: boolean;
  usedBytes: number;
  totalBytes: number;
  limitBytes: number;
  domNodes: number;
  /** 说明文字：永远标注这是「本标签页估算」 */
  note: string;
}

export function readMemory(): MemoryInfo {
  const note = "仅 Chrome 系浏览器可读，表示本标签页的 JS 堆估算值，不是整机内存占用。";
  if (typeof performance === "undefined") {
    return { available: false, usedBytes: 0, totalBytes: 0, limitBytes: 0, domNodes: 0, note };
  }
  const memory = (performance as unknown as { memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number } })
    .memory;
  const domNodes = typeof document !== "undefined" ? document.getElementsByTagName("*").length : 0;
  if (!memory) return { available: false, usedBytes: 0, totalBytes: 0, limitBytes: 0, domNodes, note };
  return {
    available: true,
    usedBytes: memory.usedJSHeapSize,
    totalBytes: memory.totalJSHeapSize,
    limitBytes: memory.jsHeapSizeLimit,
    domNodes,
    note,
  };
}

/* ============================================================
   应用级耗时
   ============================================================ */

export type AppPhase = "open" | "close" | "switch-space" | "dock" | "render" | "sync";

export interface AppMetric {
  id: string;
  phase: AppPhase;
  ms: number;
  at: number;
  ok: boolean;
}

const METRIC_LIMIT = 200;
const metrics: AppMetric[] = [];

/** 记录一次应用级耗时（真实测量值，来自 performance.now 差值） */
export function recordAppMetric(id: string, phase: AppPhase, ms: number, ok = true): AppMetric {
  const metric: AppMetric = { id, phase, ms: Math.round(ms * 10) / 10, at: Date.now(), ok };
  metrics.unshift(metric);
  if (metrics.length > METRIC_LIMIT) metrics.length = METRIC_LIMIT;
  return metric;
}

export function listAppMetrics(filter?: { id?: string; phase?: AppPhase }): AppMetric[] {
  let list = [...metrics];
  if (filter?.id) list = list.filter((metric) => metric.id === filter.id);
  if (filter?.phase) list = list.filter((metric) => metric.phase === filter.phase);
  return list;
}

export interface AppMetricSummary {
  phase: AppPhase;
  count: number;
  avg: number;
  p95: number;
  max: number;
  failures: number;
}

/** 按阶段聚合：平均值 / P95 / 最大值 / 失败数 */
export function summarizeAppMetrics(phase: AppPhase): AppMetricSummary {
  const list = metrics.filter((metric) => metric.phase === phase);
  if (!list.length) return { phase, count: 0, avg: 0, p95: 0, max: 0, failures: 0 };
  const values = list.map((metric) => metric.ms).sort((a, b) => a - b);
  const sum = values.reduce((a, b) => a + b, 0);
  const p95 = values[Math.min(values.length - 1, Math.floor(values.length * 0.95))];
  return {
    phase,
    count: list.length,
    avg: Math.round((sum / values.length) * 10) / 10,
    p95,
    max: values[values.length - 1],
    failures: list.filter((metric) => !metric.ok).length,
  };
}

/* ============================================================
   历史记录（本机）
   ============================================================ */

export interface PerfSnapshot {
  id: string;
  at: number;
  /** 记录当时的版本，便于对比升级前后 */
  version: string;
  navigation: NavigationInfo;
  vitals: VitalMetric[];
  resources: { count: number; totalTransferSize: number };
  images: ImageInfo;
  memory: { available: boolean; usedBytes: number; domNodes: number };
  apps: { appCount: number; windowCount: number; registered: number };
  score: number;
}

const HISTORY_KEY = "guandao.os19.perf.history.v1";
const HISTORY_LIMIT = 20;

/** 综合分：仅用于同一设备不同时间的相对比较，不是 Lighthouse 分数 */
export function computeScore(snapshot: Omit<PerfSnapshot, "score" | "id" | "at" | "version">): number {
  const weight: Record<string, number> = { LCP: 0.35, INP: 0.25, CLS: 0.2, FCP: 0.12, TTFB: 0.08 };
  let total = 0;
  let used = 0;
  for (const metric of snapshot.vitals) {
    const value = metric.unit === "score" ? metric.value / 0.25 : metric.value / 4000;
    const normalized = Math.max(0, Math.min(1, 1 - value));
    const w = weight[metric.name] ?? 0.1;
    total += normalized * w;
    used += w;
  }
  return used > 0 ? Math.round((total / used) * 100) : 0;
}

export function readPerfHistory(): PerfSnapshot[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as PerfSnapshot[];
    return Array.isArray(parsed) ? parsed.slice(0, HISTORY_LIMIT) : [];
  } catch {
    return [];
  }
}

/** 保存一次快照；超过 20 条丢弃最旧的（本地保存，不上传） */
export function savePerfSnapshot(input: Omit<PerfSnapshot, "id" | "at" | "score"> & { score?: number }): PerfSnapshot {
  const snapshot: PerfSnapshot = {
    ...input,
    id: `p${Date.now().toString(36)}`,
    at: Date.now(),
    score: input.score ?? computeScore(input),
  };
  const list = [snapshot, ...readPerfHistory()].slice(0, HISTORY_LIMIT);
  if (typeof localStorage !== "undefined") {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
    } catch {
      /* 配额满：保留内存快照即可 */
    }
  }
  return snapshot;
}

export function clearPerfHistory(): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.removeItem(HISTORY_KEY);
  } catch {
    /* 忽略 */
  }
}

/** 对比两次快照，返回各指标的差值（正数表示变慢 / 变差） */
export function compareSnapshots(older: PerfSnapshot, newer: PerfSnapshot): Array<{ name: string; before: number; after: number; delta: number; better: boolean | null }> {
  const rows: Array<{ name: string; before: number; after: number; delta: number; better: boolean | null }> = [];
  for (const metric of newer.vitals) {
    const before = older.vitals.find((item) => item.name === metric.name);
    if (!before) continue;
    const delta = Math.round((metric.value - before.value) * 1000) / 1000;
    rows.push({
      name: metric.name,
      before: before.value,
      after: metric.value,
      delta,
      better: delta === 0 ? null : delta < 0,
    });
  }
  for (const key of ["domContentLoaded", "loadEvent", "total"] as const) {
    const delta = newer.navigation[key] - older.navigation[key];
    rows.push({ name: key, before: older.navigation[key], after: newer.navigation[key], delta, better: delta === 0 ? null : delta < 0 });
  }
  return rows;
}

/* ============================================================
   持续监控（检测内存持续增长）
   ============================================================ */

export interface GrowthSample {
  at: number;
  domNodes: number;
  usedBytes: number;
  listeners: number;
}

const growthSamples: GrowthSample[] = [];

/**
 * 定期采样 DOM 节点数与（可读时）堆大小，用来发现「只增不减」的泄漏。
 * 采样结果同时留在内存里，性能实验室直接读 growthSeries()。
 */
export function startGrowthMonitor(
  onSample: (sample: GrowthSample) => void,
  intervalMs = 30_000,
  readListeners?: () => number,
): () => void {
  const scope = createScope("perf:growth");
  const take = () => {
    const memory = readMemory();
    const sample: GrowthSample = {
      at: Date.now(),
      domNodes: memory.domNodes,
      usedBytes: memory.usedBytes,
      listeners: readListeners ? readListeners() : 0,
    };
    growthSamples.push(sample);
    if (growthSamples.length > 40) growthSamples.shift();
    onSample(sample);
  };
  take();
  scope.interval(take, intervalMs);
  return () => scope.dispose();
}

export function growthSeries(): GrowthSample[] {
  return [...growthSamples];
}

/**
 * 判断是否存在「持续增长」：最近一半采样都高于前一阶段，
 * 且 DOM 节点净增超过阈值。只作为提示，不当作泄漏结论。
 */
export function detectGrowthTrend(samples = growthSamples): { rising: boolean; domDelta: number; heapDelta: number; samples: number } {
  if (samples.length < 6) return { rising: false, domDelta: 0, heapDelta: 0, samples: samples.length };
  const half = Math.floor(samples.length / 2);
  const firstHalf = samples.slice(0, half);
  const secondHalf = samples.slice(half);
  const avg = (list: GrowthSample[], key: "domNodes" | "usedBytes") =>
    list.reduce((sum, sample) => sum + sample[key], 0) / Math.max(1, list.length);
  const domDelta = Math.round(avg(secondHalf, "domNodes") - avg(firstHalf, "domNodes"));
  const heapDelta = Math.round(avg(secondHalf, "usedBytes") - avg(firstHalf, "usedBytes"));
  return { rising: domDelta > 300 && heapDelta > 2 * 1024 * 1024, domDelta, heapDelta, samples: samples.length };
}