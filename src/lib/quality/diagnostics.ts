/**
 * Guandao OS 1.9 · System Diagnostics（系统诊断中心）
 *
 * 四个分区：
 *   1. 系统状态：前端 / API / D1 / R2 / Session / 同步 / 备份 / 插件运行时
 *   2. 诊断记录：最近错误、同步失败、文件异常、插件异常、迁移异常
 *   3. 自检：只读探测，一键跑完；不删除、不重置任何用户数据
 *   4. 日志与隐私：保留策略、导出、清理
 *
 * 安全约定：
 *   - 所有请求走统一网络层（有超时、有取消），不会挂住界面；
 *   - 诊断记录只存本机，且写入前已脱敏（见 errors.ts）；
 *   - 不读取笔记正文、不记录 Session Token。
 */

import { badge, bindTabs, emptyState, escapeHtml, fmtAgo, fmtBytes, fmtDateTime, shell, type Ctx } from "../os14/core";
import { clearDiagnostics, diagnosticStats, exportDiagnostics, listDiagnostics, type DiagEntry } from "./errors";
import { connectivitySnapshot, subscribeConnectivity } from "./connectivity";
import { request, explainError, NetError } from "./net";
import { readNavigation, readMemory } from "./perf";
import { resourceStats } from "./resources";

const VERSION = "1.9.0";

type Tone = "ok" | "warn" | "danger" | "mute" | "accent";

interface CheckRow {
  id: string;
  label: string;
  tone: Tone;
  value: string;
  detail: string;
}

interface Health {
  at: number;
  frontend: CheckRow;
  api: CheckRow;
  d1: CheckRow;
  r2: CheckRow;
  session: CheckRow;
  sync: CheckRow;
  backup: CheckRow;
  plugins: CheckRow;
}

let ctxRef: Ctx | null = null;
let tab = "health";
let health: Health | null = null;
let healthBusy = false;
let selfCheck: Array<CheckRow & { ms: number }> = [];
let selfCheckBusy = false;
let pluginSummary: { total: number; enabled: number; failed: number; blocked: number } | null = null;
let unsubscribeSync: (() => void) | null = null;

const toneBadge = (tone: Tone, text: string) =>
  badge(text, tone === "accent" ? "accent" : tone === "danger" ? "danger" : tone === "warn" ? "warn" : tone === "ok" ? "ok" : "mute");

/* ============================================================
   健康检查
   ============================================================ */

async function readSession(): Promise<CheckRow> {
  try {
    const result = await request<{ success?: boolean; user?: { id?: string; name?: string; username?: string } }>("/api/auth/me", {
      timeoutMs: 6000,
      retries: 0,
    });
    const user = result.data?.user;
    return {
      id: "session",
      label: "Session",
      tone: "ok",
      value: user ? "已登录" : "本地模式",
      detail: user ? `账号 ${user.username || user.name || user.id?.slice(0, 8) || "已识别"}` : "未登录 /api/auth/me 返回空用户",
    };
  } catch (error) {
    if (error instanceof NetError && error.kind === "unauthorized") {
      return { id: "session", label: "Session", tone: "warn", value: "未登录", detail: "本地功能可用；云端能力需要 GitHub 登录" };
    }
    const info = explainError(error);
    return { id: "session", label: "Session", tone: "danger", value: "无法确认", detail: info.message };
  }
}

async function readHealth(): Promise<Health> {
  const nav = readNavigation();
  const memory = readMemory();
  const resources = resourceStats();

  const frontend: CheckRow = {
    id: "frontend",
    label: "前端运行",
    tone: "ok",
    value: "正常",
    detail: nav.available
      ? `本次加载 ${nav.total} ms · DOM ${memory.domNodes} 节点 · 存活资源域 ${resources.scopes}`
      : `运行中 · DOM ${memory.domNodes} 节点`,
  };

  // API / D1 / R2 一次探测全部拿到
  let api: CheckRow = { id: "api", label: "/api", tone: "warn", value: "未检测", detail: "" };
  let d1: CheckRow = { id: "d1", label: "D1", tone: "mute", value: "未检测", detail: "" };
  let r2: CheckRow = { id: "r2", label: "R2", tone: "mute", value: "未检测", detail: "" };

  try {
    const started = Date.now();
    const result = await request<{
      status?: string;
      services?: { d1?: string; r2?: string };
      details?: { d1?: { latencyMs?: number }; r2?: { latencyMs?: number; probe?: string } };
      checkedAt?: string;
    }>("/api/health", { timeoutMs: 6000, retries: 1 });

    const services = result.data?.services ?? {};
    const ms = Date.now() - started;

    if (result.status === 200 || services.d1 === "connected") {
      api = { id: "api", label: "/api", tone: "ok", value: "可达", detail: `健康检查耗时 ${ms} ms` };
    } else {
      api = { id: "api", label: "/api", tone: "warn", value: "降级", detail: "接口可达，但有依赖不可用" };
    }

    d1 = serviceRow("d1", "D1", services.d1, result.data?.details?.d1?.latencyMs);
    r2 = serviceRow("r2", "R2", services.r2, result.data?.details?.r2?.latencyMs);
  } catch (error) {
    const info = explainError(error);
    api = { id: "api", label: "/api", tone: "danger", value: info.title, detail: info.message };
    d1 = { id: "d1", label: "D1", tone: "mute", value: "未知", detail: "接口不可达，无法确认数据库状态" };
    r2 = { id: "r2", label: "R2", tone: "mute", value: "未知", detail: "接口不可达，无法确认对象存储状态" };
  }

  const session = await readSession();

  /**
   * 2.0：云同步这一行必须是真实状态。
   *
   * 1.9 的做法是读 connectivity 的默认值（idle → 在线 · 已同步），
   * 但仓库当时根本没有同步引擎，于是「未实现」被显示成「正常」。
   * 现在只读内核里真实注册的同步域：没有接入就显示「未接入」，绝不显示绿色。
   */
  const core = (window as unknown as {
    GOS20?: { sync?: { domains?: () => Array<{ id: string; label: string; state: string; lastSyncAt: number | null }> } };
  }).GOS20;
  const domains = core?.sync?.domains?.() ?? [];
  const connect = connectivitySnapshot();
  const failedDomain = domains.find((domain) => domain.state === "failed");
  const conflictDomain = domains.find((domain) => domain.state === "conflict");
  const sync: CheckRow =
    domains.length === 0
      ? {
          id: "sync",
          label: "Cloud Sync",
          tone: "mute",
          value: "未接入数据域",
          detail: connect.network === "offline"
            ? "当前离线；同步引擎已就绪，等待网络恢复"
            : "同步引擎已就绪，但 Notes / Tasks / Calendar 还没有服务端 API，数据仍保存在本地",
        }
      : {
          id: "sync",
          label: "Cloud Sync",
          tone: failedDomain ? "danger" : conflictDomain ? "warn" : "ok",
          value: `${domains.length} 个数据域`,
          detail: failedDomain
            ? `${failedDomain.label} 上次同步失败`
            : conflictDomain
              ? `${conflictDomain.label} 存在冲突，需要人工确认`
              : `最近同步：${domains
                  .map((domain) => domain.label)
                  .slice(0, 4)
                  .join("、")}`,
        };

  // 备份：登录后只读列出（POST 才算创建，这里不写任何数据）
  let backup: CheckRow = { id: "backup", label: "Backup", tone: "mute", value: "需要登录", detail: "登录后可查看云端备份数量" };
  if (session.tone === "ok" && session.value === "已登录") {
    try {
      const result = await request<{ backups?: Array<{ id: string; createdAt?: string; status?: string; integrity?: string }> }>(
        "/api/backups",
        { timeoutMs: 8000, retries: 0 },
      );
      const list = result.data?.backups ?? [];
      const latest = list[0];
      backup = {
        id: "backup",
        label: "Backup",
        tone: list.length ? "ok" : "warn",
        value: list.length ? `${list.length} 份` : "还没有备份",
        detail: latest
          ? `最近 ${latest.createdAt ? fmtDateTime(Date.parse(latest.createdAt)) : "时间未知"}${latest.integrity ? ` · 完整性 ${latest.integrity}` : ""}`
          : "到「备份与恢复」里创建第一份备份",
      };
    } catch (error) {
      const info = explainError(error);
      backup = { id: "backup", label: "Backup", tone: "warn", value: "无法读取", detail: info.message };
    }
  }

  let plugins: CheckRow = { id: "plugins", label: "插件运行时", tone: "mute", value: "未加载", detail: "插件注册表尚未初始化" };
  if (pluginSummary) {
    plugins = {
      id: "plugins",
      label: "插件运行时",
      tone: pluginSummary.failed ? "warn" : "ok",
      value: pluginSummary.total ? `${pluginSummary.enabled}/${pluginSummary.total} 已启用` : "无插件",
      detail: [
        pluginSummary.blocked ? `${pluginSummary.blocked} 个被沙箱拦截` : "",
        pluginSummary.failed ? `${pluginSummary.failed} 个加载失败` : "",
      ]
        .filter(Boolean)
        .join(" · ") || "全部插件运行正常",
    };
  }

  return { at: Date.now(), frontend, api, d1, r2, session, sync, backup, plugins };
}

function serviceRow(id: string, label: string, status: string | undefined, latency: number | undefined): CheckRow {
  const latencyText = typeof latency === "number" ? ` · ${latency} ms` : "";
  switch (status) {
    case "connected":
      return { id, label, tone: "ok", value: "已连接", detail: `只读探活成功${latencyText}` };
    case "available":
      return { id, label, tone: "ok", value: "可用", detail: `head 探测成功${latencyText}` };
    case "unconfigured":
      return { id, label, tone: "warn", value: "未配置", detail: "缺少绑定，需要在部署环境里配置" };
    case "error":
      return { id, label, tone: "danger", value: "异常", detail: `探活失败${latencyText}，详细原因见服务端日志` };
    default:
      return { id, label, tone: "mute", value: "未知", detail: "健康检查没有返回该服务状态" };
  }
}

/* ============================================================
   视图
   ============================================================ */

function healthView(): string {
  const rows = health ? [health.frontend, health.api, health.d1, health.r2, health.session, health.sync, health.backup, health.plugins] : [];
  return `
    <div class="g14-scroll">
      <div class="g14-pane-head">
        <h3>System Health</h3>
        <p>前端状态来自浏览器实测；API / D1 / R2 来自 <code>/api/health</code> 的只读探活。${
          health ? `上次检查 ${fmtAgo(health.at)}。` : "还没有检查。"
        }</p>
      </div>
      <div class="g19-actions">
        <button class="g14-btn is-primary" type="button" data-diag-refresh ${healthBusy ? "disabled" : ""}>
          ${healthBusy ? "检查中…" : "重新检查"}
        </button>
        <span class="g19-muted" data-diag-live></span>
      </div>
      ${
        rows.length
          ? `<div class="g19-health">${rows
              .map(
                (row) => `
              <div class="g19-health-row">
                <div class="g19-health-name"><b>${escapeHtml(row.label)}</b><span>${escapeHtml(row.detail)}</span></div>
                <div class="g19-health-state">${toneBadge(row.tone, row.value)}</div>
              </div>`,
              )
              .join("")}</div>`
          : emptyState("还没有健康数据", "点「重新检查」跑一次只读探活。", "◌")
      }
      <p class="g19-note">
        说明：D1 / R2 的详细错误不会回传到浏览器（避免泄露库名、bucket 名与凭据），
        需要更细的信息请看 Cloudflare 的 Worker 日志。
      </p>
    </div>`;
}

const SCOPE_LABEL: Record<string, string> = {
  "app:": "应用渲染异常",
  "window": "未捕获异常",
  "resource": "资源加载失败",
  "plugin": "插件异常",
  "sync": "同步异常",
  "file": "文件操作异常",
  "migration": "数据迁移异常",
  "cloud": "服务连接异常",
};

function diagRow(entry: DiagEntry): string {
  return `
    <li class="g19-diag-item">
      <div class="g19-diag-top">
        ${toneBadge(entry.level === "error" ? "danger" : entry.level === "warn" ? "warn" : "mute", entry.level === "error" ? "错误" : entry.level === "warn" ? "警告" : "信息")}
        <b>${escapeHtml(entry.scope)}</b>
        <span class="g19-muted">${escapeHtml(entry.code)}${entry.count > 1 ? ` ×${entry.count}` : ""}</span>
        <span class="g19-diag-time">${fmtAgo(entry.at)}</span>
      </div>
      <p class="g19-diag-msg">${escapeHtml(entry.message)}</p>
      ${entry.meta ? `<p class="g19-diag-meta">${escapeHtml(Object.entries(entry.meta).map(([k, v]) => `${k}: ${v}`).join(" · "))}</p>` : ""}
      ${entry.stack ? `<pre class="g19-diag-stack">${escapeHtml(entry.stack)}</pre>` : ""}
    </li>`;
}

function diagnosticsView(): string {
  const all = listDiagnostics();
  const groups = [
    { key: "app:", label: "最近错误（应用）" },
    { key: "sync", label: "同步失败" },
    { key: "file", label: "文件操作" },
    { key: "plugin", label: "插件" },
    { key: "migration", label: "数据迁移" },
    { key: "cloud", label: "服务连接" },
    { key: "resource", label: "资源加载" },
    { key: "window", label: "未捕获异常" },
  ];
  const sections = groups
    .map((group) => {
      const list = all.filter((entry) => entry.scope.startsWith(group.key));
      if (!list.length) return "";
      return `<div class="g19-panel">
        <div class="g19-panel-head"><h4>${escapeHtml(group.label)}</h4><span class="g19-muted">${list.length} 条</span></div>
        <ul class="g19-diag-list">${list.slice(0, 8).map(diagRow).join("")}</ul>
      </div>`;
    })
    .join("");

  return `
    <div class="g14-scroll">
      <div class="g14-pane-head">
        <h3>Diagnostics</h3>
        <p>只记录「哪个模块、什么错误、什么时候」，不记录笔记正文、文件名和令牌。记录保存在本机。</p>
      </div>
      ${sections || emptyState("没有诊断记录", "系统运行正常，或者错误还没有被捕获到。", "✓")}
      ${
        all.length
          ? `<div class="g19-panel">
              <div class="g19-panel-head"><h4>全部记录</h4><span class="g19-muted">${all.length} 条 · 最多保留 200 条 / 14 天</span></div>
              <ul class="g19-diag-list">${all.slice(0, 20).map(diagRow).join("")}</ul>
            </div>`
          : ""
      }
    </div>`;
}

function selfCheckView(): string {
  return `
    <div class="g14-scroll">
      <div class="g14-pane-head">
        <h3>Self Check</h3>
        <p>全部是只读探测：不会删除文件、不会重置数据、不会创建备份、不会改设置。</p>
      </div>
      <div class="g19-actions">
        <button class="g14-btn is-primary" type="button" data-diag-selfcheck ${selfCheckBusy ? "disabled" : ""}>
          ${selfCheckBusy ? "自检中…" : "开始自检"}
        </button>
        ${selfCheck.length ? `<span class="g19-muted">${selfCheck.filter((row) => row.tone === "ok").length}/${selfCheck.length} 项通过</span>` : ""}
      </div>
      ${
        selfCheck.length
          ? `<ul class="g19-check">${selfCheck
              .map(
                (row) => `
              <li>
                <span class="g19-check-ico is-${row.tone}">${row.tone === "ok" ? "✓" : row.tone === "warn" ? "!" : row.tone === "danger" ? "×" : "–"}</span>
                <div class="g19-check-body">
                  <b>${escapeHtml(row.label)}</b>
                  <span>${escapeHtml(row.detail)}</span>
                </div>
                <span class="g19-check-ms">${row.ms} ms</span>
              </li>`,
              )
              .join("")}</ul>`
          : emptyState("还没有自检结果", "点上面的按钮跑一次基础检查。", "◌")
      }
    </div>`;
}

function logsView(): string {
  const stats = diagnosticStats();
  const oldest = stats.firstAt ? fmtDateTime(stats.firstAt) : "—";
  const newest = stats.lastAt ? fmtDateTime(stats.lastAt) : "—";
  return `
    <div class="g14-scroll">
      <div class="g14-pane-head">
        <h3>日志与隐私</h3>
        <p>诊断信息默认只存在这台设备上，不会上传到你没有主动授权的地方。</p>
      </div>
      <div class="g19-panel">
        <div class="g19-panel-head"><h4>保留情况</h4></div>
        <ul class="g19-kv">
          <li><span>当前条数 / 累计次数</span><b>${stats.entries} / ${stats.total}</b></li>
          <li><span>占用空间</span><b>${fmtBytes(stats.storageBytes)}</b></li>
          <li><span>时间范围</span><b>${escapeHtml(oldest)} → ${escapeHtml(newest)}</b></li>
          <li><span>保留策略</span><b>最多 200 条 / 14 天，超出自动丢弃最旧的</b></li>
        </ul>
      </div>
      <div class="g19-panel">
        <div class="g19-panel-head"><h4>脱敏规则</h4></div>
        <ul class="g19-bullets">
          <li>GitHub Token、JWT、Bearer 头、Cookie 值、32 位以上十六进制串 → 替换为 REDACTED</li>
          <li>不记录笔记正文、任务内容、文件名</li>
          <li>不记录 Session Token 与 OAuth 凭证</li>
          <li>每条消息截断到 300 字符，堆栈只保留 6 行</li>
        </ul>
      </div>
      <div class="g19-actions">
        <button class="g14-btn" type="button" data-diag-export>导出诊断 JSON</button>
        <button class="g14-btn is-danger" type="button" data-diag-clear ${stats.entries ? "" : "disabled"}>清除诊断记录</button>
      </div>
      <p class="g19-note">
        导出的文件只包含上面这些元信息（版本、浏览器 UA、错误摘要），可以直接附在问题反馈里。
      </p>
    </div>`;
}

/* ============================================================
   自检
   ============================================================ */

async function runSelfCheck(): Promise<void> {
  const results: Array<CheckRow & { ms: number }> = [];
  const push = (row: CheckRow, startedAt: number) => results.push({ ...row, ms: Date.now() - startedAt });

  // 1. localStorage 可写
  {
    const started = Date.now();
    try {
      const key = `guandao.os19.probe.${Date.now()}`;
      localStorage.setItem(key, "1");
      const ok = localStorage.getItem(key) === "1";
      localStorage.removeItem(key);
      push(
        { id: "ls", label: "本地存储可写", tone: ok ? "ok" : "danger", value: "", detail: ok ? "localStorage 读写正常（已清理探针）" : "写入后读回不一致" },
        started,
      );
    } catch (error) {
      push({ id: "ls", label: "本地存储可写", tone: "danger", value: "", detail: `不可写：${explainError(error).message}` }, started);
    }
  }

  // 2. IndexedDB 可打开
  {
    const started = Date.now();
    try {
      const opened = await new Promise<boolean>((resolve) => {
        const req = indexedDB.open("guandao-os19-probe", 1);
        req.onupgradeneeded = () => {
          req.result.createObjectStore("probe");
        };
        req.onsuccess = () => {
          req.result.close();
          resolve(true);
        };
        req.onerror = () => resolve(false);
        setTimeout(() => resolve(false), 3000);
      });
      indexedDB.deleteDatabase("guandao-os19-probe");
      push(
        { id: "idb", label: "IndexedDB 可打开", tone: opened ? "ok" : "warn", value: "", detail: opened ? "可以创建/打开数据库（探针库已删除）" : "打开失败，可能被隐私模式限制" },
        started,
      );
    } catch (error) {
      push({ id: "idb", label: "IndexedDB 可打开", tone: "warn", value: "", detail: explainError(error).message }, started);
    }
  }

  // 3. API / D1 / R2
  {
    const started = Date.now();
    try {
      const result = await request<{ services?: { d1?: string; r2?: string } }>("/api/health", { timeoutMs: 6000, retries: 0 });
      const services = result.data?.services ?? {};
      const ok = services.d1 === "connected" && services.r2 === "available";
      push(
        {
          id: "api",
          label: "API / D1 / R2",
          tone: ok ? "ok" : "warn",
          value: "",
          detail: ok ? "健康检查通过，数据库与对象存储均可用" : `接口可达，但 D1=${services.d1 ?? "?"}、R2=${services.r2 ?? "?"}`,
        },
        started,
      );
    } catch (error) {
      push({ id: "api", label: "API / D1 / R2", tone: "danger", value: "", detail: explainError(error).message }, started);
    }
  }

  // 4. 会话
  {
    const started = Date.now();
    const session = await readSession();
    push({ ...session, id: "session" }, started);
  }

  // 5. 云端备份可读（只在已登录时）
  {
    const started = Date.now();
    const session = await request<{ user?: unknown }>("/api/auth/me", { timeoutMs: 5000, retries: 0 }).catch(() => null);
    if (!session?.data?.user) {
      push({ id: "backup", label: "云端备份可读", tone: "mute", value: "", detail: "未登录，跳过（不读取任何备份数据）" }, started);
    } else {
      try {
        const list = await request<{ backups?: unknown[] }>("/api/backups", { timeoutMs: 8000, retries: 0 });
        const count = list.data?.backups?.length ?? 0;
        push({ id: "backup", label: "云端备份可读", tone: "ok", value: "", detail: `只读列出 ${count} 份备份，未创建任何新备份` }, started);
      } catch (error) {
        push({ id: "backup", label: "云端备份可读", tone: "warn", value: "", detail: explainError(error).message }, started);
      }
    }
  }

  // 6. Service Worker
  {
    const started = Date.now();
    if (!("serviceWorker" in navigator)) {
      push({ id: "sw", label: "Service Worker", tone: "mute", value: "", detail: "当前浏览器不支持（离线能力不可用）" }, started);
    } else {
      const registration = await navigator.serviceWorker.getRegistration().catch(() => null);
      push(
        {
          id: "sw",
          label: "Service Worker",
          tone: registration ? "ok" : "warn",
          value: "",
          detail: registration ? `已注册 · ${registration.active?.state ?? registration.installing?.state ?? "等待激活"}` : "未注册（http 环境或首次访问属正常）",
        },
        started,
      );
    }
  }

  // 7. 缓存
  {
    const started = Date.now();
    try {
      if (typeof caches === "undefined") {
        push({ id: "cache", label: "离线缓存", tone: "mute", value: "", detail: "浏览器不支持 Cache Storage" }, started);
      } else {
        const keys = await caches.keys();
        push(
          { id: "cache", label: "离线缓存", tone: keys.length ? "ok" : "warn", value: "", detail: keys.length ? `${keys.length} 个缓存空间：${keys.join(", ")}` : "还没有缓存（离线能力需要刷新一次后才生效）" },
          started,
        );
      }
    } catch (error) {
      push({ id: "cache", label: "离线缓存", tone: "warn", value: "", detail: explainError(error).message }, started);
    }
  }

  // 8. 插件沙箱文档可达（只读 GET）
  {
    const started = Date.now();
    try {
      const result = await request<string>("/sandbox/runner.html", { parse: "text", timeoutMs: 6000, retries: 0 });
      const ok = result.status === 200 && result.data.includes("<");
      push(
        { id: "sandbox", label: "插件沙箱", tone: ok ? "ok" : "warn", value: "", detail: ok ? "沙箱运行页可加载（isolated origin，CSP 禁止网络出口）" : "沙箱页返回异常内容" },
        started,
      );
    } catch (error) {
      push({ id: "sandbox", label: "插件沙箱", tone: "warn", value: "", detail: explainError(error).message }, started);
    }
  }

  selfCheck = results;
}

/* ============================================================
   渲染 / 初始化
   ============================================================ */

export const renderDiagnostics = (): string =>
  shell(
    "diagnostics",
    [
      ["health", "系统状态", "◍"],
      ["diag", "诊断记录", "▤"],
      ["check", "自检", "✓"],
      ["logs", "日志与隐私", "⌘"],
    ],
    tab === "diag" ? diagnosticsView() : tab === "check" ? selfCheckView() : tab === "logs" ? logsView() : healthView(),
    "System Diagnostics",
  );

function currentView(): string {
  return tab === "diag" ? diagnosticsView() : tab === "check" ? selfCheckView() : tab === "logs" ? logsView() : healthView();
}

export const initDiagnostics = (win: HTMLElement, ctx: Ctx): (() => void) => {
  ctxRef = ctx;

  // 插件注册表按需加载：避免诊断应用把整个插件系统拉进主包
  void import("../plugins/registry")
    .then((mod) => {
      pluginSummary = mod.stateSummary();
      if (tab === "health" && win.isConnected) rerender();
    })
    .catch(() => {
      pluginSummary = null;
    });

  const rerender = () => {
    const main = win.querySelector<HTMLElement>(".g14-main");
    if (main) main.innerHTML = currentView();
  };

  bindTabs(win, (next) => {
    tab = next || "health";
    rerender();
    if (tab === "health" && !health) void refreshHealth();
  });

  const refreshHealth = async () => {
    if (healthBusy) return;
    healthBusy = true;
    const panel = win.querySelector<HTMLElement>("[data-diag-live]");
    if (panel) panel.textContent = "检查中…";
    try {
      health = await readHealth();
    } finally {
      healthBusy = false;
      if (win.isConnected) rerender();
    }
  };

  win.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    if (target.closest("[data-diag-refresh]")) {
      void refreshHealth();
      return;
    }
    if (target.closest("[data-diag-selfcheck]")) {
      if (selfCheckBusy) return;
      selfCheckBusy = true;
      rerender();
      void runSelfCheck().finally(() => {
        selfCheckBusy = false;
        if (win.isConnected) rerender();
      });
      return;
    }
    if (target.closest("[data-diag-export]")) {
      const text = exportDiagnostics();
      const blob = new Blob([text], { type: "application/json;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `guandao-diagnostics-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1500);
      ctx.toast("诊断记录已导出（已脱敏）");
      return;
    }
    if (target.closest("[data-diag-clear]")) {
      clearDiagnostics();
      rerender();
      ctx.toast("已清除本机诊断记录");
    }
  });

  // 网络状态变化只影响「要不要重新探测」，不再把同步行改写成默认文案
  unsubscribeSync = subscribeConnectivity(() => {
    if (!win.isConnected) return;
    if (tab === "health") void refreshHealth();
  });

  void refreshHealth();

  return () => {
    unsubscribeSync?.();
    unsubscribeSync = null;
  };
};

export const diagnosticsVersion = VERSION;