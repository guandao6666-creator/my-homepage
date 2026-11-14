/**
 * Guandao OS 1.9 · Performance Lab（性能实验室）
 *
 * 只显示能真实测到的数据：
 *   - 页面加载：Navigation Timing（TTFB / DOMContentLoaded / load）
 *   - Web Vitals：FCP / LCP / CLS / INP（PerformanceObserver，标注适用范围）
 *   - 资源与图片：Resource Timing / 真实 DOM 图片状态
 *   - 应用耗时：窗口系统上报的真实毫秒数
 *   - 资源存活：resourceStats() 的计数器
 *
 * 不显示：其它标签页 CPU、整机内存、GPU 型号（浏览器拿不到，不编）。
 * 历史记录只存本机，最多 20 条。
 */

import {
  badge,
  bindTabs,
  emptyState,
  escapeHtml,
  fmtAgo,
  fmtBytes,
  fmtDateTime,
  shell,
  type Ctx,
} from "../os14/core";
import {
  clearPerfHistory,
  compareSnapshots,
  growthSeries,
  detectGrowthTrend,
  listAppMetrics,
  observeVitals,
  readImages,
  readMemory,
  readNavigation,
  readPerfHistory,
  readResources,
  savePerfSnapshot,
  startGrowthMonitor,
  summarizeAppMetrics,
  supportedMetrics,
  type AppPhase,
  type PerfSnapshot,
  type VitalsName,
  type VitalMetric,
} from "./perf";
import { resourceStats } from "./resources";
import { connectivitySnapshot } from "./connectivity";
import { diagnosticStats } from "./errors";

const VERSION = "1.9.0";

let ctxRef: Ctx | null = null;
let tab = "overview";
let lastSnapshot: PerfSnapshot | null = null;
let liveVitals: VitalMetric[] = [];
let stopVitals: (() => void) | null = null;
let stopGrowth: (() => void) | null = null;
let compareWith: string | null = null;

const NAV_HELP: Record<string, string> = {
  navigate: "本次为正常进入页面",
  reload: "本次为刷新页面（部分资源可能来自缓存）",
  back_forward: "本次为前进/后退恢复（数据可能来自往返缓存）",
  prerender: "本次为预渲染页面",
};

const RATING_LABEL: Record<string, string> = {
  good: "良好",
  "needs-improvement": "需要改进",
  poor: "较差",
  unknown: "未知",
};

function ratingBadge(rating: string) {
  const tone = rating === "good" ? "ok" : rating === "poor" ? "danger" : rating === "needs-improvement" ? "warn" : "mute";
  return badge(RATING_LABEL[rating] ?? rating, tone as "ok" | "danger" | "warn" | "mute");
}

function metricValue(metric: VitalMetric): string {
  if (metric.unit === "score") return metric.value.toFixed(3);
  return `${Math.round(metric.value)} ms`;
}

/** 当前所有可用指标：实时观察值优先，其次用快照值 */
function currentVitals(): VitalMetric[] {
  const map = new Map<VitalsName, VitalMetric>();
  if (lastSnapshot) for (const metric of lastSnapshot.vitals) map.set(metric.name, metric);
  for (const metric of liveVitals) map.set(metric.name, metric);
  return [...map.values()];
}

function vitalsOfSnapshot(snapshot: PerfSnapshot | null): VitalMetric[] {
  return snapshot?.vitals ?? [];
}

/* ============================================================
   视图
   ============================================================ */

const overviewView = () => {
  const nav = lastSnapshot?.navigation ?? readNavigation();
  const images = lastSnapshot?.images ?? readImages();
  const resources = readResources(3);
  const memory = readMemory();
  const connect = connectivitySnapshot();
  const appCount = ctxRef ? Object.keys(ctxRef.APPS).length : 0;
  const windowCount = typeof document !== "undefined" ? document.querySelectorAll(".window").length : 0;
  const totals = lastSnapshot?.resources ?? { count: resources.count, totalTransferSize: resources.totalTransferSize };

  return `
    <div class="g14-scroll">
      <div class="g14-pane-head">
        <h3>性能概览</h3>
        <p>以下数值来自当前这一次页面加载（${escapeHtml(NAV_HELP[nav.type] ?? nav.type)}），只代表本机本次运行。</p>
      </div>

      <div class="g19-cards">
        <div class="g19-card">
          <span class="g19-card-k">首字节 TTFB</span>
          <b class="g19-card-v">${nav.available ? `${nav.ttfb} ms` : "不可用"}</b>
          <span class="g19-card-s">服务器返回第一个字节的时间</span>
        </div>
        <div class="g19-card">
          <span class="g19-card-k">DOMContentLoaded</span>
          <b class="g19-card-v">${nav.available ? `${nav.domContentLoaded} ms` : "不可用"}</b>
          <span class="g19-card-s">DOM 解析完成</span>
        </div>
        <div class="g19-card">
          <span class="g19-card-k">Load</span>
          <b class="g19-card-v">${nav.available ? `${nav.loadEvent} ms` : "不可用"}</b>
          <span class="g19-card-s">本页资源加载结束</span>
        </div>
        <div class="g19-card">
          <span class="g19-card-k">应用 / 窗口</span>
          <b class="g19-card-v">${appCount} / ${windowCount}</b>
          <span class="g19-card-s">已注册应用数 / 当前打开窗口数</span>
        </div>
        <div class="g19-card">
          <span class="g19-card-k">资源请求</span>
          <b class="g19-card-v">${totals.count}</b>
          <span class="g19-card-s">${fmtBytes(totals.totalTransferSize)} 传输（本页）</span>
        </div>
        <div class="g19-card">
          <span class="g19-card-k">图片</span>
          <b class="g19-card-v">${images.loaded}/${images.count}</b>
          <span class="g19-card-s">${images.failed ? `${images.failed} 张加载失败 · ` : ""}${images.pending} 张加载中</span>
        </div>
        <div class="g19-card">
          <span class="g19-card-k">同步状态</span>
          <b class="g19-card-v">${escapeHtml(connect.label)}</b>
          <span class="g19-card-s">${escapeHtml(connect.description)}</span>
        </div>
        <div class="g19-card">
          <span class="g19-card-k">JS 堆（本标签页）</span>
          <b class="g19-card-v">${memory.available ? fmtBytes(memory.usedBytes) : "不可用"}</b>
          <span class="g19-card-s">${memory.available ? `上限 ${fmtBytes(memory.limitBytes)} · DOM ${memory.domNodes} 节点` : "非 Chrome 内核浏览器不提供"}</span>
        </div>
      </div>

      <div class="g19-panel">
        <div class="g19-panel-head">
          <h4>最大的资源</h4>
          <span class="g19-muted">按传输字节排序（无法读取的跨域资源显示为 0）</span>
        </div>
        ${
          resources.largest.length
            ? `<ul class="g19-list">${resources.largest
                .map(
                  (item) =>
                    `<li><code>${escapeHtml(item.name)}</code><span>${fmtBytes(item.transferSize)}</span></li>`,
                )
                .join("")}</ul>`
            : emptyState("还没有资源计时数据", "浏览器可能不支持 Resource Timing，或页面刚加载完成。", "◌")
        }
      </div>

      <div class="g19-panel">
        <div class="g19-panel-head">
          <h4>最慢的请求</h4>
          <span class="g19-muted">含缓存命中的资源（耗时接近 0 表示直接读缓存）</span>
        </div>
        ${
          resources.slowest.length
            ? `<ul class="g19-list">${resources.slowest
                .map(
                  (item) =>
                    `<li><code>${escapeHtml(item.name)}</code><span>${item.duration} ms · ${escapeHtml(item.type)}</span></li>`,
                )
                .join("")}</ul>`
            : emptyState("还没有可显示的请求", "随便打开一个应用再回来看。", "◌")
        }
      </div>
    </div>`;
};

const vitalsView = () => {
  const supported = supportedMetrics();
  const metrics = currentVitals();
  const rows = (["TTFB", "FCP", "LCP", "CLS", "INP"] as VitalsName[]).map((name) => {
    const metric = metrics.find((item) => item.name === name);
    const isSupported = supported[name];
    return `
      <tr class="${metric ? "" : "is-empty"}">
        <td><b>${name}</b></td>
        <td>${metric ? metricValue(metric) : isSupported ? "采集中…" : "浏览器不支持"}</td>
        <td>${metric ? ratingBadge(metric.rating) : badge("—", "mute")}</td>
        <td class="g19-td-note">${escapeHtml(
          name === "CLS"
            ? "本次加载期间的会话窗口累计值"
            : name === "INP"
              ? "本会话中已观测到的最慢交互（近似 INP）"
              : metric?.scope ?? "",
        )}</td>
      </tr>`;
  });

  return `
    <div class="g14-scroll">
      <div class="g14-pane-head">
        <h3>Web Vitals</h3>
        <p>阈值参考 web.dev：LCP ≤2.5s、INP ≤200ms、CLS ≤0.1 为「良好」。这些是本次会话的实测值，不是这台设备的永久性能结论。</p>
      </div>
      <table class="g19-table">
        <thead><tr><th>指标</th><th>本次测量</th><th>评级</th><th>说明</th></tr></thead>
        <tbody>${rows.join("")}</tbody>
      </table>

      <div class="g19-panel">
        <div class="g19-panel-head"><h4>为什么有的指标显示「浏览器不支持」</h4></div>
        <p class="g19-note">
          LCP / CLS 依赖 <code>PerformanceObserver</code> 的布局与绘制条目，Safari 与 Firefox 的部分版本没有开放；
          INP 依赖 Event Timing，Safari 17 之前不可用。拿不到就不显示数字，不做估算。
        </p>
        <p class="g19-note">
          CLS 为「会话窗口」算法：连续偏移间隔小于 1 秒、窗口总长不超过 5 秒，取其中最大的一段。
          刷新页面会重新开始统计，所以不同时间的数值不能直接横向比较。
        </p>
      </div>
    </div>`;
};

const PHASE_LABEL: Record<AppPhase, string> = {
  open: "窗口打开",
  close: "窗口关闭",
  "switch-space": "桌面切换",
  dock: "Dock 交互",
  render: "应用渲染",
  sync: "同步请求",
};

const appsView = () => {
  const phases: AppPhase[] = ["open", "close", "switch-space", "dock", "render"];
  const summaries = phases.map((phase) => summarizeAppMetrics(phase));
  const recent = listAppMetrics().slice(0, 20);
  const stats = diagnosticStats();
  const resources = resourceStats();
  const trend = detectGrowthTrend();

  return `
    <div class="g14-scroll">
      <div class="g14-pane-head">
        <h3>应用性能</h3>
        <p>由窗口系统在真实操作时上报（performance.now 差值），不是模拟数据。样本随使用累积，关闭页面后清空。</p>
      </div>

      <div class="g19-cards">
        ${summaries
          .map(
            (summary) => `
          <div class="g19-card">
            <span class="g19-card-k">${escapeHtml(PHASE_LABEL[summary.phase])}</span>
            <b class="g19-card-v">${summary.count ? `${summary.p95} ms` : "—"}</b>
            <span class="g19-card-s">${
              summary.count
                ? `样本 ${summary.count} · 平均 ${summary.avg} ms · 最大 ${summary.max} ms${summary.failures ? ` · 失败 ${summary.failures}` : ""}`
                : "还没有样本"
            }</span>
          </div>`,
          )
          .join("")}
      </div>

      <div class="g19-panel">
        <div class="g19-panel-head"><h4>最近记录</h4><span class="g19-muted">最多保留 200 条</span></div>
        ${
          recent.length
            ? `<ul class="g19-list">${recent
                .map(
                  (metric) =>
                    `<li><code>${escapeHtml(metric.id)}</code><span>${escapeHtml(PHASE_LABEL[metric.phase] ?? metric.phase)} · ${metric.ms} ms${metric.ok ? "" : " · 失败"}</span></li>`,
                )
                .join("")}</ul>`
            : emptyState("还没有应用耗时记录", "打开几个应用、拖一下窗口，这里就会有数据。", "◌")
        }
      </div>

      <div class="g19-panel">
        <div class="g19-panel-head"><h4>运行时资源</h4><span class="g19-muted">来自资源生命周期管理器的真实计数</span></div>
        <ul class="g19-kv">
          <li><span>存活资源域</span><b>${resources.scopes}</b></li>
          <li><span>定时器（timeout / interval）</span><b>${resources.timeouts} / ${resources.intervals}</b></li>
          <li><span>动画帧回调</span><b>${resources.rafs}</b></li>
          <li><span>事件监听</span><b>${resources.listeners}</b></li>
          <li><span>观察器</span><b>${resources.observers}</b></li>
          <li><span>未释放 Object URL</span><b>${resources.objectUrls}</b></li>
          <li><span>已释放资源域累计</span><b>${resources.disposedTotal}</b></li>
        </ul>
        <p class="g19-note">
          ${trend.samples < 6
            ? "持续监控需要至少 6 次采样（每 30 秒一次），继续使用这个窗口即可累积。"
            : trend.rising
              ? `最近一段 DOM 节点净增 ${trend.domDelta}，堆增加 ${fmtBytes(Math.max(0, trend.heapDelta))}，可能存在未清理的资源。`
              : `最近一段 DOM 节点变化 ${trend.domDelta}，堆变化 ${fmtBytes(Math.abs(trend.heapDelta))}，没有持续增长迹象。`}
        </p>
        <p class="g19-note">诊断记录：${stats.entries} 条（累计 ${stats.total} 次），约 ${fmtBytes(stats.storageBytes)}。</p>
      </div>
    </div>`;
};

const historyView = () => {
  const history = readPerfHistory();
  const current = history[0] ?? null;
  const older = compareWith ? history.find((item) => item.id === compareWith) ?? null : history[1] ?? null;
  const compare =
    current && older && current.id !== older.id
      ? compareSnapshots(older, current)
      : null;

  return `
    <div class="g14-scroll">
      <div class="g14-pane-head">
        <h3>性能历史</h3>
        <p>记录保存在本机浏览器里（最多 20 条），不会上传云端。点击「运行测试」生成一条新记录。</p>
      </div>

      <div class="g19-actions">
        <button class="g14-btn is-primary" type="button" data-perf-run>运行测试</button>
        <button class="g14-btn" type="button" data-perf-now>查看当前加载数据</button>
        <button class="g14-btn is-ghost" type="button" data-perf-clear ${history.length ? "" : "disabled"}>清除历史</button>
      </div>

      ${
        current
          ? `<div class="g19-panel">
              <div class="g19-panel-head"><h4>最近一次测试</h4><span class="g19-muted">${fmtDateTime(current.at)} · v${escapeHtml(current.version)}</span></div>
              <ul class="g19-kv">
                <li><span>综合参考分（仅本机纵向比较）</span><b>${current.score}</b></li>
                <li><span>LCP / INP / CLS</span><b>${vitalsOfSnapshot(current)
                  .filter((m) => ["LCP", "INP", "CLS"].includes(m.name))
                  .map((m) => `${m.name} ${metricValue(m)}`)
                  .join(" · ") || "未采集到"}</b></li>
                <li><span>Load / DOMContentLoaded</span><b>${current.navigation.loadEvent} / ${current.navigation.domContentLoaded} ms</b></li>
                <li><span>资源 / 图片</span><b>${current.resources.count} 个 · ${fmtBytes(current.resources.totalTransferSize)} / ${current.images.loaded} 张</b></li>
                <li><span>打开的应用 / 窗口</span><b>${current.apps.registered} / ${current.apps.windowCount}</b></li>
              </ul>
            </div>`
          : emptyState("还没有保存过测试", "点上面的「运行测试」把当前状态存成第一条记录。", "◌")
      }

      ${
        compare
          ? `<div class="g19-panel">
              <div class="g19-panel-head"><h4>与上一次对比</h4><span class="g19-muted">负数表示变快</span></div>
              <table class="g19-table">
                <thead><tr><th>指标</th><th>较早</th><th>本次</th><th>变化</th></tr></thead>
                <tbody>${compare
                  .map(
                    (row) => `<tr>
                      <td>${escapeHtml(row.name)}</td>
                      <td>${row.before}</td>
                      <td>${row.after}</td>
                      <td class="${row.better === null ? "" : row.better ? "is-good" : "is-bad"}">${row.delta > 0 ? "+" : ""}${row.delta}</td>
                    </tr>`,
                  )
                  .join("")}</tbody>
              </table>
            </div>`
          : ""
      }

      ${
        history.length
          ? `<div class="g19-panel">
              <div class="g19-panel-head"><h4>历史记录</h4><span class="g19-muted">${history.length} 条</span></div>
              <ul class="g19-list">${history
                .map(
                  (item) => `<li>
                    <code>${fmtAgo(item.at)}</code>
                    <span>参考分 ${item.score} · LCP ${vitalsOfSnapshot(item).find((m) => m.name === "LCP")?.value ?? "—"} ms</span>
                    <button class="g14-btn is-ghost" type="button" data-perf-compare="${escapeHtml(item.id)}">作为对比</button>
                  </li>`,
                )
                .join("")}</ul>
            </div>`
          : ""
      }
    </div>`;
};

/* ============================================================
   渲染 / 初始化
   ============================================================ */

export const renderPerfLab = (): string =>
  shell(
    "perflab",
    [
      ["overview", "性能概览", "◔"],
      ["vitals", "Web Vitals", "◈"],
      ["apps", "应用性能", "▤"],
      ["history", "性能历史", "◷"],
    ],
    tab === "vitals" ? vitalsView() : tab === "apps" ? appsView() : tab === "history" ? historyView() : overviewView(),
    "Performance Lab",
  );

function takeSnapshot(): PerfSnapshot {
  const nav = readNavigation();
  const images = readImages();
  const resources = readResources(5);
  const memory = readMemory();
  const vitals = currentVitals();
  const registered = ctxRef ? Object.keys(ctxRef.APPS).length : 0;
  const windowCount = typeof document !== "undefined" ? document.querySelectorAll(".window").length : 0;

  const snapshot = savePerfSnapshot({
    version: VERSION,
    navigation: nav,
    vitals,
    resources: { count: resources.count, totalTransferSize: resources.totalTransferSize },
    images,
    memory: { available: memory.available, usedBytes: memory.usedBytes, domNodes: memory.domNodes },
    apps: { appCount: registered, windowCount, registered },
  });
  lastSnapshot = snapshot;
  return snapshot;
}

export const initPerfLab = (win: HTMLElement, ctx: Ctx): (() => void) => {
  ctxRef = ctx;

  // 页面级观察器只启动一次；重复打开窗口不重复计数
  if (!stopVitals) {
    const observer = observeVitals((metric) => {
      liveVitals = [...liveVitals.filter((item) => item.name !== metric.name), metric];
    });
    liveVitals = observer.metrics();
    stopVitals = observer.stop;
  }
  if (!stopGrowth) {
    stopGrowth = startGrowthMonitor((sample) => {
      // 只在性能应用打开时刷新，避免无谓重绘
      if (!win.isConnected) return;
      const panel = win.querySelector<HTMLElement>("[data-perf-live]");
      if (panel) panel.textContent = `采样 ${growthSeries().length} · DOM ${sample.domNodes} 节点`;
    });
  }

  const rerender = () => {
    const main = win.querySelector<HTMLElement>(".g14-main");
    if (!main) return;
    main.innerHTML =
      tab === "vitals" ? vitalsView() : tab === "apps" ? appsView() : tab === "history" ? historyView() : overviewView();
  };

  bindTabs(win, (next) => {
    tab = next || "overview";
    rerender();
  });

  win.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    if (target.closest("[data-perf-run]")) {
      const snapshot = takeSnapshot();
      compareWith = null;
      tab = "history";
      win.querySelectorAll(".g14-nav").forEach((node) => {
        node.classList.toggle("is-active", (node as HTMLElement).dataset.tab === "history");
      });
      rerender();
      ctx.toast(`已记录性能快照 · 参考分 ${snapshot.score}`);
      return;
    }
    if (target.closest("[data-perf-now]")) {
      lastSnapshot = null;
      tab = "overview";
      rerender();
      return;
    }
    if (target.closest("[data-perf-clear]")) {
      clearPerfHistory();
      lastSnapshot = null;
      compareWith = null;
      rerender();
      ctx.toast("已清除本机性能历史");
      return;
    }
    const compareBtn = target.closest<HTMLElement>("[data-perf-compare]");
    if (compareBtn) {
      compareWith = compareBtn.dataset.perfCompare ?? null;
      tab = "history";
      rerender();
      return;
    }
    // 其它需要刷新的按钮
    if (target.closest("[data-perf-refresh]")) {
      rerender();
    }
  });

  function refreshSoon() {
    // 指标是异步到达的：打开概览 1.2 秒后补一次渲染，避免一进来全是「采集中」
    window.setTimeout(() => {
      if (win.isConnected) rerender();
    }, 1200);
  }

  if (tab === "overview" || tab === "vitals") refreshSoon();

  return () => {
    // 观察器与性能历史是页面级的，窗口关闭不销毁（诊断中心还要用）
    // 但需要把引用清掉，避免指向已移除的窗口
    if (!win.isConnected) lastSnapshot = null;
  };
};

export const perfLabVersion = VERSION;