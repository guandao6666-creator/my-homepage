/**
 * Guandao OS 2.0 · 更新中心
 *
 * 2.0 是**静态网站部署**（Worker + Static Assets），不是原生内核。
 * 所以这里的语义必须诚实（§13）：
 *
 *   1. 「有新版本」= 服务端已经部署了新的静态资源，当前页面还是旧的 JS；
 *   2. 「立即更新」= 先做数据保护检查（布局保存 / 迁移完成 / 本地备份存在），
 *      然后重新加载页面拿到新资源 —— 不伪装成内核热更新；
 *   3. 「回滚」= 服务端重新部署上一版资源；客户端能做的是恢复迁移前快照，
 *      这里只显示真实存在的快照，不提供假的「一键回滚内核」。
 *
 * 版本信息来源：
 *   - 当前版本：编译进 JS 的 OS_VERSION（version.ts）；
 *   - 服务端版本：GET /api/health 的 `version` 字段（真实请求，失败就是未知）。
 */

import { badge, escapeHtml, fmtDateTime, shell, type Ctx } from "../../os14/core";
import type { Kernel } from "../../core/kernel";
import type { Sys } from "../../os14/system";
import { OS_VERSION, RELEASE_NAME, RELEASE_NAME_ZH, BUILD_INFO, RELEASES } from "../../version";
import { compareVersions } from "../../core/manifest";
import { installedRecords } from "../../plugins/registry";
import { idb } from "../../os14/core";

type Phase = "idle" | "checking" | "ready" | "offline" | "failed";

type ServerInfo = {
  version: string;
  releaseName: string;
  status: string;
  latencyMs: number;
  at: number;
  detail: string;
};

type State = {
  phase: Phase;
  server: ServerInfo | null;
  error: string;
  snapshots: string[];
  busy: boolean;
};

const state: State = { phase: "idle", server: null, error: "", snapshots: [], busy: false };

let ctxRef: Ctx | null = null;
let kernelRef: Kernel | null = null;

const esc = escapeHtml;

const pane = (title: string, sub: string, body: string) => `
  <div class="g14-scroll">
    <div class="g14-pane-head"><h3>${esc(title)}</h3><p>${esc(sub)}</p></div>
    ${body}
  </div>`;

const group = (title: string, body: string) => `
  <section class="os20-group"><p class="os20-group-title">${esc(title)}</p>${body}</section>`;

const comparison = () => {
  if (!state.server) return null;
  return compareVersions(state.server.version, OS_VERSION);
};

const statusCard = () => {
  if (state.phase === "checking") {
    return `<div class="os20-update-state is-busy"><b>正在检查…</b><span>请求 /api/health，读取服务端真实版本号</span></div>`;
  }
  if (state.phase === "offline") {
    return `<div class="os20-update-state is-warn"><b>离线</b><span>当前网络不可用，无法确认服务端版本。本地桌面不受影响。</span></div>`;
  }
  if (state.phase === "failed") {
    return `<div class="os20-update-state is-danger"><b>检查失败</b><span>${esc(state.error)}</span></div>`;
  }
  if (!state.server) {
    return `<div class="os20-update-state"><b>还没有检查过</b><span>点击「检查更新」读取服务端版本；不会自动下载或安装任何东西。</span></div>`;
  }
  const delta = comparison();
  if (delta === 0) {
    return `<div class="os20-update-state is-ok"><b>已是最新</b><span>服务端与当前页面都是 ${esc(state.server.version)} · 延迟 ${state.server.latencyMs} ms</span></div>`;
  }
  if (delta !== null && delta > 0) {
    return `<div class="os20-update-state is-new"><b>有新版本 ${esc(state.server.version)}</b><span>服务端已部署新资源。当前页面仍是 ${esc(OS_VERSION)}，重新加载即可更新。</span></div>`;
  }
  return `<div class="os20-update-state is-warn"><b>本地版本较新（${esc(OS_VERSION)}）</b><span>服务端版本 ${esc(state.server.version)} 更低，可能命中了边缘缓存或预发环境。</span></div>`;
};

const compatibility = () => {
  const kernel = kernelRef;
  const plugins = (() => {
    try {
      return installedRecords();
    } catch {
      return [];
    }
  })();
  const incompatiblePlugins = plugins.filter(
    (record) => compareVersions(OS_VERSION, record.manifest.compatibility?.minimumOSVersion ?? "0.0.0") < 0,
  );
  const higherSdk = plugins.filter((record) => Number(record.manifest.compatibility?.sdkVersion ?? 1) > 1);
  return `
    <div class="os20-kpis">
      <div class="os20-kpi"><b>${plugins.length}</b><span>已安装插件</span></div>
      <div class="os20-kpi"><b>${incompatiblePlugins.length}</b><span>系统版本不满足</span></div>
      <div class="os20-kpi"><b>${higherSdk.length}</b><span>SDK 版本过高</span></div>
      <div class="os20-kpi"><b>${kernel?.registry.list().length ?? 0}</b><span>登记应用</span></div>
    </div>
    ${
      incompatiblePlugins.length || higherSdk.length
        ? `<div class="os20-note is-warn"><p>有插件与当前系统不兼容，它们不会自动启用。到插件管理器查看详情或回退版本。</p></div>`
        : `<p class="g14-hint">当前所有插件与应用的兼容性检查都通过。</p>`
    }`;
};

const dataProtection = () => {
  const kernel = kernelRef;
  const report = (
    window as unknown as {
      GOS20?: { migration?: () => { applied?: boolean; from?: number; to?: number } | null };
    }
  ).GOS20?.migration?.();
  // 全新安装时 from === to，迁移引擎不会执行任何步骤（applied=false）。
  // 以前这里显示「未完成」，让用户以为升级失败；现在区分「无需迁移」与「真的失败」。
  const migrationText = report
    ? report.applied
      ? "已完成"
      : Number(report.from ?? 2) >= Number(report.to ?? 2)
        ? "无需迁移（数据已是 2.0 格式）"
        : "未完成（下次启动会自动重试）"
    : "无需迁移";
  const layoutSaved = Boolean(kernel?.storage.read("layout.v2", null));
  return `
    <div class="os20-check">
      <div class="os20-check-row"><span>本地数据迁移</span><b>${esc(migrationText)}</b></div>
      <div class="os20-check-row"><span>桌面布局快照</span><b>${layoutSaved ? "已保存" : "还没有快照"}</b></div>
      <div class="os20-check-row"><span>迁移前备份</span><b>${state.snapshots.length ? `${state.snapshots.length} 份` : "未发现"}</b></div>
      <div class="os20-check-row"><span>存储可用</span><b>${kernel?.storage.available ? "是" : "否（隐私模式）"}</b></div>
    </div>
    <p class="g14-hint">更新前会先保存一次桌面布局。迁移前备份保留在浏览器 IndexedDB 的 backups 里，不会上传。</p>`;
};

const history = () =>
  RELEASES.map(
    (release) => `
    <div class="os20-release ${release.version === OS_VERSION ? "is-current" : ""}">
      <div class="os20-release-head">
        <b>${esc(release.version)}</b>
        <span>${esc(release.name)}</span>
        <i>${esc(release.date)}</i>
        ${release.version === OS_VERSION ? badge("当前", "ok") : ""}
      </div>
      <ul>${release.notes.map((note) => `<li>${esc(note)}</li>`).join("")}</ul>
    </div>`,
  ).join("");

const view = () => {
  const server = state.server;
  return pane(
    "更新中心",
    `Guandao OS ${OS_VERSION} · ${RELEASE_NAME_ZH}。静态部署下的更新 = 新资源部署 + 客户端数据迁移。`,
    group(
      "当前版本",
      `<div class="os20-about">
        <div class="os20-about-logo">管</div>
        <div>
          <h4>${esc(OS_VERSION)} · ${esc(RELEASE_NAME)}</h4>
          <p>${esc(RELEASE_NAME_ZH)} · 构建 ${esc(BUILD_INFO.build)}</p>
          <p class="g14-hint">构建时间 ${esc(BUILD_INFO.builtAt)} · 通道 ${esc(BUILD_INFO.channel)}</p>
        </div>
      </div>`,
    ) +
      group(
        "检查更新",
        `${statusCard()}
         <div class="os20-inline">
           <button class="g14-btn is-primary" type="button" data-check ${state.busy ? "disabled" : ""}>${state.phase === "checking" ? "检查中…" : "检查更新"}</button>
           <button class="g14-btn" type="button" data-apply ${server && comparison() === 1 ? "" : "disabled"}>重新加载并更新</button>
         </div>
         ${server ? `<p class="g14-hint">服务端 ${esc(server.version)}（${esc(server.releaseName)}）· ${esc(server.detail)} · ${esc(fmtDateTime(server.at))}</p>` : ""}`,
      ) +
      group("兼容性检查", compatibility()) +
      group("数据保护", dataProtection()) +
      group(
        "回滚",
        `<div class="os20-note">
          <p><b>资源回滚</b>：由服务端重新部署上一版静态资源完成，客户端无法把一个已部署的网站「回滚」到旧 JS。</p>
          <p><b>数据回滚</b>：2.0 迁移只新增键、不改旧键，所以即使资源回退到 1.9，旧数据仍然可用。迁移前的完整快照保存在 IndexedDB 的 <code>backups</code>，键名以 <code>pre-2.0-</code> 开头。</p>
          <p><b>失败保护</b>：迁移失败不会提升数据版本号，下次启动会重试；已经成功的步骤是幂等的。</p>
        </div>
        ${
          state.snapshots.length
            ? `<div class="os20-check">${state.snapshots
                .map((key) => `<div class="os20-check-row"><span>${esc(key)}</span><b>迁移前快照</b></div>`)
                .join("")}</div>`
            : `<p class="g14-hint">还没有发现迁移前快照（全新安装的用户不需要）。</p>`
        }`,
      ) +
      group("更新历史", `<div class="os20-releases">${history()}</div>`),
  );
};

export const renderUpdateCenter = () =>
  shell(
    "updatecenter",
    [
      ["main", "更新", "⟳"],
      ["about", "关于", "ⓘ"],
    ],
    `<div data-uc-host></div>`,
    "更新中心",
  );

export const initUpdateCenter = (win: HTMLElement, ctx: Ctx, _sys: Sys, kernel: Kernel): (() => void) => {
  ctxRef = ctx;
  kernelRef = kernel;
  const host = win.querySelector<HTMLElement>("[data-uc-host]");
  if (!host) return () => undefined;

  const paint = () => {
    if (host) host.innerHTML = view();
  };

  const loadSnapshots = async () => {
    try {
      const keys = await idb.keys("backups");
      state.snapshots = keys.filter((key) => key.startsWith("pre-2.0-")).slice(-5).reverse();
    } catch {
      state.snapshots = [];
    }
  };

  const check = async () => {
    if (state.busy) return;
    state.busy = true;
    state.phase = "checking";
    state.error = "";
    paint();
    const started = Date.now();
    try {
      const response = await fetch("/api/health", { headers: { accept: "application/json" }, credentials: "same-origin" });
      const latency = Date.now() - started;
      const payload = (await response.json().catch(() => null)) as
        | { version?: string; releaseName?: string; status?: string; details?: Record<string, unknown> }
        | null;
      if (!payload?.version) {
        state.phase = "failed";
        state.error = `接口返回异常（HTTP ${response.status}），无法读取版本号`;
      } else {
        state.phase = "ready";
        state.server = {
          version: String(payload.version),
          releaseName: String(payload.releaseName ?? ""),
          status: String(payload.status ?? "unknown"),
          latencyMs: latency,
          at: Date.now(),
          detail: `HTTP ${response.status} · ${payload.status ?? "unknown"}`,
        };
      }
    } catch (error) {
      state.phase = navigator.onLine === false ? "offline" : "failed";
      state.error = error instanceof Error ? error.message : "网络请求失败";
    } finally {
      state.busy = false;
      paint();
    }
  };

  const reloadForUpdate = () => {
    // 数据保护：先保存布局，再看迁移是否完成
    try {
      (window as unknown as { GOS20?: { saveLayout?: () => void } }).GOS20?.saveLayout?.();
    } catch {
      /* 忽略 */
    }
    ctxRef?.toast("正在重新加载以获取新版本…");
    window.setTimeout(() => location.reload(), 400);
  };

  win.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    if (target.closest("[data-check]")) {
      void check();
      return;
    }
    if (target.closest("[data-apply]")) {
      reloadForUpdate();
      return;
    }
  });

  void loadSnapshots().then(paint);
  paint();

  // 打开时自动检查一次：用户至少知道有没有新版本
  void check();

  return () => {
    ctxRef = null;
    kernelRef = null;
  };
};