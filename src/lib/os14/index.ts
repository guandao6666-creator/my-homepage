/**
 * Guandao OS 1.9 · 启动入口
 *
 * 1.9 的变化：应用改成「按需加载」。
 *   - 打开桌面时只加载桌面外壳本身（窗口管理、主题、程序坞、组件、插件注册表）；
 *   - 用户第一次点开某个应用时才下载它的模块，之后复用浏览器缓存；
 *   - 模块下载失败不会拖垮桌面，窗口里会显示可重试的崩溃卡片。
 *
 * 仍然复用 1.0 的窗口系统，没有另起一套 DOM。
 */

import { escapeHtml, ls, uid, type Ctx } from "./core";
import { createSystem } from "./system";
import { readInstall, META_BY_ID } from "./catalog";
import { initThemes, initThemeApp, renderThemeApp } from "./themes";
import { bumpOpen, initAppCenter, renderAppCenter } from "./appcenter";
import { initWidgetGallery, registerNewWidgets, renderWidgetGallery } from "./widgetstore";
import { initWorkspaceShortcuts, initWorkspaces, renderWorkspaces } from "./workspaces";
import { initDesktop, terminalCommand } from "./desktop";
import { readPrefs } from "./prefs";
import { initPlugins, isInstalled as isPluginInstalled } from "../plugins/registry";
import { startContinuity } from "../continuity/ui";

import { OS_VERSION } from "../version";
import { installOs20 } from "../os20/bridge";
import type { Kernel } from "../core/kernel";

/** 2.0 内核实例（延迟读取，避免与 os20/bridge 形成循环依赖） */
const getKernel = (): Kernel | null =>
  (window as unknown as { GOS20?: { kernel?: Kernel } }).GOS20?.kernel ?? null;

/** 版本号对外仍叫 VERSION，值来自 src/lib/version.ts 这个唯一来源 */
export const VERSION = OS_VERSION;

export type BootResult = { ctx: Ctx; sys: ReturnType<typeof createSystem>; version: string };

type LazyInit = (win: HTMLElement) => void | (() => void);

type Spec = {
  id: string;
  title: string;
  width: number;
  height: number;
  glyph: string;
  /** 同步应用直接提供渲染函数；懒加载应用只提供 load */
  render?: () => string;
  init?: LazyInit;
  /** 打开时才下载的模块 */
  load?: () => Promise<{ body: () => string; init?: LazyInit }>;
  optional?: boolean;
};

/** 懒加载窗口在模块到达前的占位内容 */
const PLACEHOLDER = `<div class="g19-loading"><div class="g19-loading-bar"></div><div class="g19-loading-bar is-short"></div><p class="g19-loading-text">正在加载应用…</p></div>`;

export const initOs14 = (ctx: Ctx): BootResult => {
  const sys = createSystem(ctx);

  /* 桌面外壳必需、必须同步可用：主题、组件、工作空间、应用中心、桌面交互。
     其余应用全部改成 load()，第一次打开时才下载。 */
  const specs: Spec[] = [
    { id: "appcenter", title: "应用中心", width: 960, height: 660, glyph: "di-appcenter", render: renderAppCenter, init: (w) => initAppCenter(w, ctx, sys) },

    /* ---------- 2.0 平台应用 ---------- */
    {
      id: "systemcenter",
      title: "系统设置",
      width: 1080,
      height: 740,
      glyph: "di-gear",
      load: () =>
        import("../os20/apps/systemcenter").then((m) => ({
          body: m.renderSystemCenter,
          init: (w) => m.initSystemCenter(w, ctx, sys),
        })),
    },
    {
      id: "market",
      title: "应用与资源市场",
      width: 1120,
      height: 760,
      glyph: "di-store",
      load: () =>
        import("../os20/apps/market").then((m) => ({
          body: m.renderMarket,
          init: (w) => m.initMarket(w, ctx, sys),
        })),
    },
    {
      id: "updatecenter",
      title: "更新中心",
      width: 940,
      height: 700,
      glyph: "di-fresh",
      load: () =>
        import("../os20/apps/updatecenter").then((m) => ({
          body: m.renderUpdateCenter,
          init: (w) => {
            const kernel = getKernel();
            if (kernel) m.initUpdateCenter(w, ctx, sys, kernel);
          },
        })),
    },
    { id: "themes", title: "主题中心", width: 940, height: 640, glyph: "di-themes", render: renderThemeApp, init: initThemeApp },
    { id: "widgetstore", title: "组件中心", width: 920, height: 620, glyph: "di-widgets", render: renderWidgetGallery, init: initWidgetGallery },
    { id: "workspaces", title: "工作空间", width: 900, height: 620, glyph: "di-space", render: renderWorkspaces, init: (w) => initWorkspaces(w, ctx) },

    {
      id: "perflab",
      title: "Performance Lab",
      width: 1000,
      height: 680,
      glyph: "di-mon",
      load: () => import("../quality/perflab").then((m) => ({ body: m.renderPerfLab, init: (w) => m.initPerfLab(w, ctx) })),
    },
    {
      id: "diagnostics",
      title: "System Diagnostics",
      width: 1040,
      height: 700,
      glyph: "di-security",
      load: () => import("../quality/diagnostics").then((m) => ({ body: m.renderDiagnostics, init: (w) => m.initDiagnostics(w, ctx) })),
    },
    {
      id: "control",
      title: "控制中心",
      width: 820,
      height: 600,
      glyph: "di-control",
      load: () => import("./control").then((m) => ({ body: m.renderControl, init: (w) => m.initControl(w, ctx, sys) })),
    },
    {
      id: "tasks",
      title: "任务与通知",
      width: 820,
      height: 600,
      glyph: "di-tasks",
      load: () => import("./tasks").then((m) => ({ body: m.renderTasks, init: (w) => m.initTasks(w, ctx) })),
    },
    {
      id: "playground",
      title: "游乐场",
      width: 900,
      height: 640,
      glyph: "di-play",
      load: () => import("./playground").then((m) => ({ body: m.renderPlayground, init: (w) => m.initPlayground(w, ctx) })),
    },
    {
      id: "datacenter",
      title: "数据中心",
      width: 880,
      height: 620,
      glyph: "di-data",
      load: () => import("./datacenter").then((m) => ({ body: m.renderDataCenter, init: (w) => m.initDataCenter(w, ctx) })),
    },
    {
      id: "notes",
      title: "Guandao Notes",
      width: 920,
      height: 600,
      glyph: "di-note",
      load: () => import("./apps/notes").then((m) => ({ body: m.renderNotes, init: (w) => m.initNotes(w, ctx) })),
    },
    {
      id: "calendar",
      title: "Guandao Calendar",
      width: 900,
      height: 620,
      glyph: "di-cal",
      load: () => import("./apps/calendar").then((m) => ({ body: m.renderCalendar, init: (w) => m.initCalendar(w, ctx) })),
    },
    {
      id: "files",
      title: "文件管理器",
      width: 900,
      height: 600,
      glyph: "di-files",
      load: () => import("./files").then((m) => ({ body: m.renderFiles, init: (w) => m.initFiles(w, ctx) })),
    },
    {
      id: "drive",
      title: "Guandao Cloud Drive",
      width: 1040,
      height: 680,
      glyph: "di-files",
      load: () => import("./drive").then((m) => ({ body: m.renderDrive, init: (w) => m.initDrive(w, ctx) })),
    },
    {
      id: "devices",
      title: "Guandao Devices",
      width: 1040,
      height: 680,
      glyph: "di-devices",
      load: () => import("./devices").then((m) => ({ body: m.renderDevices, init: (w) => m.initDevices(w, ctx) })),
    },
    {
      id: "backup",
      title: "Guandao Backup",
      width: 1060,
      height: 680,
      glyph: "di-backup",
      load: () => import("./backup").then((m) => ({ body: m.renderBackup, init: (w) => m.initBackup(w, ctx) })),
    },
    {
      id: "security",
      title: "Privacy & Security",
      width: 1080,
      height: 680,
      glyph: "di-security",
      load: () => import("./security").then((m) => ({ body: m.renderSecurity, init: (w) => m.initSecurity(w, ctx) })),
    },
    {
      id: "community",
      title: "Guandao Community",
      width: 1180,
      height: 740,
      glyph: "di-community",
      load: () => import("./community").then((m) => ({ body: m.renderCommunity, init: (w) => m.initCommunity(w, ctx) })),
    },
    {
      id: "continuity",
      title: "接力中心",
      width: 1000,
      height: 690,
      glyph: "di-devices",
      load: () => import("../continuity/app").then((m) => ({ body: m.renderContinuity, init: (w) => m.initContinuity(w, ctx) })),
    },
    {
      id: "pm",
      title: "插件管理器",
      width: 980,
      height: 680,
      glyph: "di-widgets",
      load: () => import("../plugins/manager").then((m) => ({ body: m.renderPluginManager, init: (w) => m.initPluginManager(w, ctx) })),
    },
    {
      id: "pmarket",
      title: "插件市场",
      width: 1100,
      height: 720,
      glyph: "di-appcenter",
      load: () => import("../plugins/market").then((m) => ({ body: m.renderPluginMarket, init: (w) => m.initPluginMarket(w, ctx) })),
    },
    {
      id: "pdev",
      title: "开发者中心",
      width: 1080,
      height: 720,
      glyph: "di-themes",
      load: () => import("../plugins/developer").then((m) => ({ body: m.renderDeveloperCenter, init: (w) => m.initDeveloperCenter(w, ctx) })),
    },
    {
      id: "music",
      title: "Guandao Music",
      width: 720,
      height: 560,
      glyph: "di-music",
      load: () => import("./apps/music").then((m) => ({ body: m.renderMusic, init: (w) => m.initMusic(w, ctx) })),
    },
    {
      id: "gallery",
      title: "Guandao Gallery",
      width: 880,
      height: 600,
      glyph: "di-gallery",
      optional: true,
      load: () => import("./apps/gallery").then((m) => ({ body: m.renderGallery, init: (w) => m.initGallery(w, ctx) })),
    },
    {
      id: "reader",
      title: "Guandao Reader",
      width: 880,
      height: 620,
      glyph: "di-reader",
      optional: true,
      load: () => import("./apps/reader").then((m) => ({ body: m.renderReader, init: (w) => m.initReader(w, ctx) })),
    },
  ];

  for (const s of specs) {
    const spec = {
      id: s.id,
      title: s.title,
      width: s.width,
      height: s.height,
      glyph: s.glyph,
      body: s.render ?? (() => PLACEHOLDER),
      init: s.init,
      load: s.load,
    };
    sys.registerSpec(spec);
    // 直接注册：同名内置应用会被 1.9 的实现覆盖，旧 init 链不再执行
    ctx.registerApp(spec);
  }

  // 可选应用默认不装：真的从 APPS 里摘掉，不是只把按钮变灰
  const installState = readInstall();
  for (const s of specs) {
    if (!s.optional) continue;
    if (!installState.installed[s.id]) {
      delete ctx.APPS[s.id];
      delete ctx.APP_ICON[s.id];
    }
  }

  // 云端能力与系统工具不参与「安装 / 卸载」流程
  const ALWAYS_AVAILABLE = new Set([
    "drive",
    "devices",
    "backup",
    "security",
    "community",
    "pm",
    "pmarket",
    "pdev",
    "continuity",
    "perflab",
    "diagnostics",
    // 2.0 平台应用：系统入口，不参与安装 / 卸载
    "systemcenter",
    "updatecenter",
    "market",
  ]);

  ctx.setDockFilter((id) => ALWAYS_AVAILABLE.has(id) || sys.isInstalled(id));
  ctx.setLaunchGuard((id) => {
    if (ALWAYS_AVAILABLE.has(id) || sys.isInstalled(id)) return false;
    // 插件应用由插件注册中心管理安装状态，不参与应用中心的安装流程
    if (id.startsWith("plugin:") && isPluginInstalled(id.slice("plugin:".length))) return false;
    ctx.toast("这个应用还没安装，去应用中心看看");
    ctx.openApp("appcenter");
    return true;
  });

  /* ---------------- 启动服务 ---------------- */
  initThemes(ctx);
  initPlugins(ctx);
  startContinuity(ctx);
  initWorkspaceShortcuts(ctx);
  registerNewWidgets(ctx);
  initDesktop(ctx);

  // 1.9：自动备份不再阻塞开机。等浏览器空闲（或 4 秒后）再检查，
  // 避免首屏就要读 IndexedDB 并可能发起上传。
  const runAutoBackup = () => {
    void import("./datacenter")
      .then((m) => m.autoBackupOnBoot())
      .catch(() => undefined);
  };
  const idle = (window as unknown as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number })
    .requestIdleCallback;
  if (typeof idle === "function") idle(runAutoBackup, { timeout: 4000 });
  else window.setTimeout(runAutoBackup, 4000);

  window.addEventListener("guandao:apps-change", () => {
    ctx.dock.render();
    document.querySelectorAll<HTMLElement>(".desk-icon[data-app]").forEach((node) => {
      const id = node.dataset.app ?? "";
      if (id && !sys.isInstalled(id)) node.remove();
    });
  });

  sys.restoreShortcuts();

  // 存储接近浏览器配额时提醒一次（每天最多一次）
  const storageWatch = () => {
    try {
      const used = ls.bytes();
      const limit = 4.2 * 1024 * 1024;
      if (used < limit) return;
      const key = "guandao.os14.storageWarn";
      const last = ls.str(key);
      const today = new Date().toISOString().slice(0, 10);
      if (last === today) return;
      ls.setStr(key, today);
      ctx.pushNotif({
        icon: "▤",
        title: "本地存储快满了",
        body: `已用约 ${(used / 1024 / 1024).toFixed(1)} MB。可以到数据中心导出备份，再清理不需要的笔记或图片。`,
      });
    } catch {
      /* 忽略 */
    }
  };
  window.setTimeout(storageWatch, 9000);
  window.setInterval(storageWatch, 10 * 60 * 1000);

  const api = {
    version: VERSION,
    sys,
    ctx,
    /** 2.0 内核（启动完成后可用；失败时为 null） */
    core: () => getKernel(),
    isInstalled: sys.isInstalled,
    install: sys.install,
    uninstall: sys.uninstall,
    open: sys.open,
    /** 系统设置页：不受安装状态限制 */
    openDevices: () => ctx.openApp("devices"),
    openBackup: () => ctx.openApp("backup"),
    openSecurity: () => ctx.openApp("security"),
    openCommunity: () => ctx.openApp("community"),
    openPerfLab: () => ctx.openApp("perflab"),
    openDiagnostics: () => ctx.openApp("diagnostics"),
    terminal: terminalCommand,
    onOpen: bumpOpen,
    catalog: META_BY_ID,
    prefs: readPrefs,
  };
  (window as unknown as { GOS14?: typeof api }).GOS14 = api;

  /* ---------------- Guandao OS 2.0 · The Platform Era ----------------
     内核在 1.x 外壳之后启动：窗口系统、主题、组件都已经就绪，
     这样任何一个 Core 阶段失败都不会让桌面白屏。
     启动是异步的，`GOS20_READY` 可供 QA 与诊断等待。 */
  try {
    installOs20({ ctx, sys });
  } catch (error) {
    console.error("[Guandao OS 2.0] 内核启动失败", error);
  }

  return { ctx, sys, version: VERSION };
};

export { ls, escapeHtml, uid };