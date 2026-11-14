/**
 * Guandao OS 2.0 · Core 与桌面外壳的桥接
 *
 * 1.x 的窗口系统、应用目录、主题引擎都已经稳定工作，2.0 不重写它们，
 * 而是在外面加一层「内核」：
 *
 *   1.x Desktop Shell（index.astro 的窗口 / 程序坞 / 菜单栏 / 组件）
 *            ↑  WindowShell 适配器（本文件）
 *   WindowManager / AppRuntime / AppRegistry / PermissionManager / Settings…
 *            ↑
 *   Kernel（启动流程、状态、诊断证据）
 *
 * 关键设计：
 *   - 应用状态来自真实的窗口 DOM（MutationObserver），不是 UI 自己写的标签；
 *   - 窗口能力（最小化 / 最大化 / 换虚拟桌面）通过 index.astro 暴露的 shellOps 调用，
 *     2.0 不再另写一套拖动缩放；
 *   - 迁移失败、云端不可用都不会阻止本地桌面；
 *   - 所有失败都进诊断中心，BootReport 可在系统中心查看。
 */

import {
  createKernel,
  BOOT_STAGES,
  type Kernel,
  type StageHandler,
} from "../core/kernel";
import type { BootReport, BootStageId } from "../core/types";
import { createWindowManager, type OpenWindow, type SpaceInfo, type WindowManager, type WindowShell } from "../core/windows";
import { createAppRuntime, type AppRuntime } from "../core/runtime";
import type { Rect } from "../core/layout";
import { createMigrationEngine } from "../core/migrations";
import type { StorageManager } from "../core/storage";
import type { Ctx } from "../os14/core";
import type { Sys } from "../os14/system";
import { isInstalled as legacyInstalled } from "../os14/catalog";
import { OS_VERSION, RELEASE_NAME, RELEASE_NAME_ZH } from "../version";
import { logDiagnostic } from "../quality/errors";
import { ALL_SYSTEM_MANIFESTS, MANIFEST_BY_ID, OS20_NEW_APP_IDS } from "./manifests";
import {
  LOCAL_MIGRATION_STEPS,
  LOCAL_SCHEMA_VERSION,
  backupLocalData,
  detectLegacyUser,
  legacyKeySnapshot,
  verifyLegacyPreserved,
} from "./migrations";
import { applySettings, stampVersion } from "./apply";
import { openOnboarding, shouldShowOnboarding } from "./apps/onboarding";
import {
  localTombstones,
  registerSyncProviders,
  resolveSyncConflict,
  syncConflicts,
  type SyncConflictChoice,
  type SyncDomainId,
  type SyncRegistration,
} from "../sync/providers";

/** index.astro 暴露的窗口级能力（2.0 不重复实现拖动 / 缩放） */
export type ShellOps = {
  minimize: (win: HTMLElement) => void;
  restore: (win: HTMLElement) => void;
  maximize: (win: HTMLElement) => void;
  moveToSpace: (win: HTMLElement, space: number) => void;
};

type CtxWithShell = Ctx & { shellOps?: ShellOps };

const api = (ctx: Ctx) => ctx as CtxWithShell;

/** 从 1.x 的窗口 DOM 构建 WindowShell 适配器 */
export function createShell(ctx: Ctx): WindowShell {
  const shellOps = api(ctx).shellOps;

  const find = (appId: string) =>
    ctx.windows.querySelector<HTMLElement>(`.window[data-app="${CSS.escape(appId)}"]`);

  const geometryOf = (win: HTMLElement): Rect => ({
    x: win.offsetLeft,
    y: win.offsetTop,
    width: win.offsetWidth,
    height: win.offsetHeight,
  });

  const applyGeometry = (win: HTMLElement, rect: Rect) => {
    win.style.left = `${Math.max(0, Math.round(rect.x))}px`;
    win.style.top = `${Math.max(0, Math.round(rect.y))}px`;
    win.style.width = `${Math.max(320, Math.round(rect.width))}px`;
    win.style.height = `${Math.max(240, Math.round(rect.height))}px`;
    // 恢复布局时如果窗口是「最大化」状态，先退出，否则几何会被样式覆盖
    win.classList.remove("is-maximized");
  };

  return {
    open(appId) {
      if (!ctx.APPS[appId]) throw new Error(`应用 ${appId} 不存在`);
      ctx.openApp(appId);
    },
    close(appId) {
      const win = find(appId);
      if (!win) return false;
      ctx.closeWin(win);
      return true;
    },
    closeAll() {
      ctx.closeAllWindows();
    },
    focus(appId) {
      const win = find(appId);
      if (!win) return false;
      ctx.focusWin(win);
      return true;
    },
    minimize(appId) {
      const win = find(appId);
      if (!win || !shellOps) return false;
      shellOps.minimize(win);
      return true;
    },
    restore(appId) {
      const win = find(appId);
      if (!win || !shellOps) return false;
      shellOps.restore(win);
      return true;
    },
    maximize(appId) {
      const win = find(appId);
      if (!win || !shellOps) return false;
      shellOps.maximize(win);
      return true;
    },
    isOpen(appId) {
      return Boolean(find(appId));
    },
    getGeometry(appId) {
      const win = find(appId);
      return win ? geometryOf(win) : null;
    },
    setGeometry(appId, rect) {
      const win = find(appId);
      if (win) applyGeometry(win, rect);
    },
    getSpace(appId) {
      const win = find(appId);
      const value = Number(win?.dataset.space);
      return Number.isFinite(value) && value > 0 ? value : null;
    },
    setSpace(appId, space) {
      const win = find(appId);
      if (!win || !shellOps) return false;
      shellOps.moveToSpace(win, space);
      return true;
    },
    listOpen(): OpenWindow[] {
      return Array.from(ctx.windows.querySelectorAll<HTMLElement>(".window[data-app]")).map((win) => ({
        appId: win.dataset.app ?? "",
        space: Number(win.dataset.space) || 1,
        minimized: win.classList.contains("is-minimized"),
        maximized: win.classList.contains("is-maximized"),
        geometry: geometryOf(win),
      }));
    },
    listSpaces(): SpaceInfo[] {
      const state = ctx.readState() as { desks?: Array<{ id?: number; name?: string }> };
      const desks = Array.isArray(state.desks) ? state.desks : [];
      return desks
        .map((desk) => ({ id: Number(desk.id) || 1, name: String(desk.name ?? `桌面 ${desk.id ?? 1}`) }))
        .filter((desk) => desk.id > 0);
    },
    currentSpace(): number {
      const state = ctx.readState() as { space?: number };
      return Number(state.space) || 1;
    },
    viewport() {
      const rect = ctx.windows.getBoundingClientRect();
      return {
        width: Math.max(320, Math.round(rect.width || window.innerWidth)),
        height: Math.max(240, Math.round(rect.height || window.innerHeight)),
      };
    },
    onClosed(cb) {
      const listener = (event: Event) => {
        const win = event.target;
        if (!(win instanceof HTMLElement)) return;
        cb(win.dataset.app ?? "");
      };
      ctx.windows.addEventListener("guandao:before-close", listener);
      return () => ctx.windows.removeEventListener("guandao:before-close", listener);
    },
  };
}

export type Os20Runtime = {
  kernel: Kernel;
  wm: WindowManager;
  runtime: AppRuntime;
  ctx: Ctx;
  sys: Sys;
  ready: Promise<BootReport>;
  bootLog: () => BootReport | null;
};

let current: Os20Runtime | null = null;

/** 供其他模块（诊断 / 设置 / 市场）读取当前内核 */
export const getOs20 = (): Os20Runtime | null => current;

const report = (message: string, detail?: unknown) => {
  const summary = detail === undefined ? "" : ` · ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 180)}`;
  try {
    logDiagnostic({ scope: "core", code: "OS20_BOOT", message: `${message}${summary}` });
  } catch {
    /* 诊断不可用时退化为 console */
    console.info("[Guandao OS 2.0]", message, detail);
  }
};

/** 注册系统应用：Manifest 校验 → Registry 登记 → 与 1.x 安装状态对齐 */
function seedRegistry(kernel: Kernel): { registered: number; installed: number; failed: string[] } {
  const failed: string[] = [];
  let registered = 0;
  let installed = 0;

  for (const manifest of ALL_SYSTEM_MANIFESTS) {
    const already = kernel.registry.get(manifest.appId);
    const result = kernel.registry.register(manifest, {
      source: "system",
      trust: "trusted",
      locked: true,
      replace: Boolean(already),
    });
    if (!result.ok) {
      failed.push(`${manifest.appId}: ${result.errors.join("；")}`);
      continue;
    }
    registered += 1;

    const isNewApp = (OS20_NEW_APP_IDS as readonly string[]).includes(manifest.appId);
    // 2.0 新应用随系统提供；其余按 1.x 的安装状态对齐
    if (isNewApp || legacyInstalled(manifest.appId)) {
      if (kernel.registry.stateOf(manifest.appId) === "registered") {
        kernel.registry.install(manifest.appId);
        kernel.registry.enable(manifest.appId);
        installed += 1;
      } else if (!kernel.registry.isEnabled(manifest.appId)) {
        kernel.registry.enable(manifest.appId);
      }
    }
    kernel.permissions.declare(
      { kind: "app", id: manifest.appId, name: manifest.name },
      [...manifest.permissions],
    );
  }

  return { registered, installed, failed };
}

/** 观察真实窗口，维护「运行中 / 已关闭」状态（不靠 UI 自报） */
function trackWindows(kernel: Kernel, ctx: Ctx): MutationObserver {
  const sync = () => {
    const open = new Set(
      Array.from(ctx.windows.querySelectorAll<HTMLElement>(".window[data-app]")).map((win) => win.dataset.app ?? ""),
    );
    for (const record of kernel.registry.list()) {
      const id = record.manifest.appId;
      const isOpen = open.has(id);
      const state = record.state;
      if (isOpen && state !== "running" && state !== "minimized" && state !== "suspended") {
        kernel.registry.markRunning(id);
      }
      if (!isOpen && (state === "running" || state === "minimized" || state === "suspended")) {
        kernel.registry.markClosed(id);
      }
    }
  };

  const observer = new MutationObserver(() => sync());
  observer.observe(ctx.windows, { childList: true, subtree: false });
  // 插件应用 / 子窗口可能在更深层级插入，单独再观察一层
  sync();
  return observer;
}

/**
 * 安装 2.0 内核并启动。
 * 返回的 ready Promise 永远不会 reject：启动失败会体现在 BootReport 里。
 */
export function installOs20(input: { ctx: Ctx; sys: Sys }): Os20Runtime {
  const { ctx, sys } = input;

  const kernel = createKernel({
    version: OS_VERSION,
    releaseName: RELEASE_NAME,
    bridgeToWindow: true,
    onLog: (event) => report(event.message, event.detail),
  });

  const shell = createShell(ctx);
  const wm = createWindowManager({
    shell,
    emit: (type, payload) => kernel.bus.emit(type, payload),
    onError: ({ op, appId, error }) => {
      report(`窗口操作失败：${op} ${appId}`, error instanceof Error ? error.message : String(error));
    },
    persist: (snapshot) => {
      kernel.storage.write("layout.v2", snapshot);
    },
    load: () => kernel.storage.read("layout.v2", null),
  });

  const runtime = createAppRuntime({
    registry: kernel.registry,
    permissions: kernel.permissions,
    windows: wm,
    emit: (type, payload) => kernel.bus.emit(type, payload),
    isPluginApp: (appId) => appId.startsWith("plugin:"),
  });

  kernel.attachWindows(wm);
  kernel.attachRuntime(runtime);

  const seeded = seedRegistry(kernel);
  if (seeded.failed.length) report("部分系统应用 Manifest 校验失败", seeded.failed);

  const observer = trackWindows(kernel, ctx);

  // 自动保存布局：窗口关闭 / 页面隐藏时各存一次
  const saveLayout = () => {
    try {
      wm.snapshot();
    } catch {
      /* 布局保存失败不影响使用 */
    }
  };
  const offClosed = wm.onClosed(() => window.setTimeout(saveLayout, 300));
  const onHide = () => {
    if (document.visibilityState === "hidden") saveLayout();
  };
  document.addEventListener("visibilitychange", onHide);
  window.addEventListener("pagehide", saveLayout);

  const legacyUser = detectLegacyUser(kernel.storage);
  const keysBefore = legacyKeySnapshot(kernel.storage);
  let migrationReport: Awaited<ReturnType<ReturnType<typeof createMigrationEngine>["run"]>> | null = null;

  const handlers: Partial<Record<BootStageId, StageHandler>> = {
    config: () => {
      const values = kernel.settings.read();
      kernel.cloud.setMode(values["system.mode"] === "cloud" ? "cloud" : "local");
      report(`配置就绪：${values["system.mode"] === "cloud" ? "Cloud Mode" : "Local Mode"}`);
    },

    storage: async () => {
      const engine = createMigrationEngine({
        storage: kernel.storage,
        steps: LOCAL_MIGRATION_STEPS,
        targetVersion: LOCAL_SCHEMA_VERSION,
        // 老用户从 1 开始，新安装直接是 2，避免空跑
        initialVersion: legacyUser ? 1 : LOCAL_SCHEMA_VERSION,
        backup: () => backupLocalData(kernel.storage),
        requireBackup: true,
        onProgress: (step) => report(`迁移中：${step.title}`),
      });
      migrationReport = await engine.run();
      if (migrationReport.errors.length) {
        report("本地数据迁移未完成", migrationReport.errors);
      }
      const missing = verifyLegacyPreserved(kernel.storage, keysBefore);
      if (missing.length) {
        // 这是最严重的情况：旧键丢了。只报告，不掩盖
        report("检测到 1.x 数据键缺失", missing);
        kernel.bus.emit("migration:data-missing", { keys: missing });
      }
      if (!kernel.storage.available) {
        throw new Error("本地存储不可用（隐私模式？），本次会话的数据无法持久化");
      }
    },

    events: () => {
      kernel.cloud.initialize();
      // 让诊断中心能看到内核事件（只保留高价值事件，避免刷屏）
      const watched = ["migration:data-missing", "permission:denied", "app:failed", "window:error", "sync:failed"];
      for (const type of watched) {
        kernel.bus.on(type, (payload) => report(`事件 ${type}`, payload));
      }
    },

    windows: () => {
      const viewport = wm.viewport();
      if (viewport.width < 200 || viewport.height < 200) throw new Error("窗口容器尺寸异常");
      report(`窗口管理器就绪：${viewport.width}×${viewport.height}`);
    },

    apps: () => {
      const stats = kernel.registry.stats();
      report(`应用注册中心就绪：${stats.installed + stats.enabled + stats.running} 个已安装`, stats);
      if (!stats.installed && !stats.enabled) throw new Error("没有任何应用被登记");
    },

    device: () => {
      const profile = kernel.device.profile();
      report(`本地设备：${profile.name}（${profile.type}）`);
    },

    auth: async () => {
      if (kernel.settings.get("system.mode") !== "cloud") {
        return { skipped: true, detail: "Local Mode：不发起登录检查" };
      }
      await kernel.cloud.probeSession();
    },

    cloud: async () => {
      if (!kernel.cloud.state().online) {
        return { skipped: true, detail: "当前离线：跳过云端探测，本地桌面照常启动" };
      }
      const health = await kernel.cloud.probeHealth();
      report(`云端健康：${health.state}（${health.detail}）`);
      if (health.state === "down") {
        // Local Mode 不依赖云端：如实记录，但不把启动标记为降级（§2.2）
        if (kernel.settings.get("system.mode") !== "cloud") {
          return { skipped: true, detail: `Local Mode：${health.detail}` };
        }
        throw new Error(`云端不可用：${health.detail}`);
      }
    },

    layout: async () => {
      const snapshot = wm.saved();
      if (!snapshot || !Object.keys(snapshot.windows).length) {
        report("没有可恢复的布局，使用默认桌面");
        return;
      }
      // 桌面已经自己打开了欢迎窗口时不要再抢
      if (wm.listOpen().length) {
        report("桌面已有窗口，跳过布局恢复");
        return;
      }
      const restored = await wm.restoreLayout(snapshot);
      report(`布局已恢复：${restored.restored.length} 个窗口`);
    },

    widgets: () => {
      try {
        ctx.widgets.renderAll();
        ctx.widgets.stack();
        report(`组件已加载：${ctx.widgets.ids.filter((id) => ctx.widgets.on(id)).length} 个启用`);
      } catch (error) {
        throw new Error(`组件加载失败：${(error as Error)?.message ?? "未知错误"}`);
      }
    },

    shell: async () => {
      stampVersion(OS_VERSION, RELEASE_NAME_ZH || RELEASE_NAME);
      document.documentElement.dataset.osBoot = "ready";
      if (shouldShowOnboarding(kernel)) {
        // 首次启动引导是「进入桌面后」的体验，不能阻塞启动完成：
        // 否则内核要等用户点完七步才 ready，诊断里会显示成启动超时。
        void openOnboarding({ kernel, ctx, sys }).catch((error) => {
          report("首次启动引导失败", error instanceof Error ? error.message : String(error));
        });
      }
      kernel.bus.emit("os20:ready", { version: OS_VERSION });
      report("Desktop Shell 就绪");
    },
  };

  const ready = kernel
    .boot(handlers, BOOT_STAGES)
    .then((result) => {
      report(
        `启动完成：${result.durationMs}ms，${result.stages.filter((stage) => stage.status === "ok").length}/${result.stages.length} 个阶段成功`,
      );
      if (result.degraded.length) report("启动降级项", result.degraded);
      return result;
    })
    .catch((error) => {
      report("内核启动异常", error instanceof Error ? error.message : String(error));
      // 即使内核异常也返回一份可读报告，桌面本身仍可继续使用（由 1.x 外壳保证）
      return {
        version: OS_VERSION,
        mode: kernel.settings.get("system.mode") === "cloud" ? ("cloud" as const) : ("local" as const),
        startedAt: Date.now(),
        durationMs: 0,
        stages: [],
        offline: true,
        degraded: [error instanceof Error ? error.message : String(error)],
      };
    });

  // 设置变化时立即生效，并落盘
  kernel.settings.subscribe((values, changes) => {
    try {
      applySettings(kernel, ctx, { silent: true });
      kernel.bus.emit("settings:applied", { changed: changes.map((change) => change.id) });
      void values;
    } catch (error) {
      report("设置应用失败", error instanceof Error ? error.message : String(error));
    }
  });

  void ready.then(() => {
    try {
      applySettings(kernel, ctx, { silent: true });
    } catch (error) {
      report("启动后应用设置失败", error instanceof Error ? error.message : String(error));
    }
    void startCloudSync();
  });

  /* ---------------- 2.0 云同步（Notes / Tasks / Calendar） ----------------
     只在 Cloud Mode 且已登录时注册；退出登录 / 切回 Local Mode 立即注销，
     界面上的同步状态会随之变回「未接入」，不会留下一个假绿点。 */
  let syncRegistration: SyncRegistration | null = null;
  let syncInFlight: Promise<void> | null = null;
  let lastAuthenticated = false;
  let syncTimer = 0;

  async function startCloudSync(domain?: SyncDomainId): Promise<void> {
    if (kernel.settings.get("system.mode") !== "cloud") return;
    if (!kernel.cloud.state().authenticated) return;

    if (!syncRegistration) {
      syncRegistration = registerSyncProviders(kernel);
      report(`云同步已接入：${syncRegistration.domains.join(" / ") || "无"}`);
    }
    if (syncInFlight) return syncInFlight;
    syncInFlight = syncRegistration
      .syncNow(domain)
      .catch((error) => {
        report("云同步失败", error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        syncInFlight = null;
      });
    return syncInFlight;
  }

  function stopCloudSync(): void {
    syncRegistration?.dispose();
    syncRegistration = null;
    kernel.cloud.reportPending(0);
  }

  kernel.cloud.subscribe((snapshot) => {
    if (snapshot.mode === "cloud" && snapshot.authenticated) {
      if (!lastAuthenticated) {
        lastAuthenticated = true;
        void startCloudSync();
      }
      return;
    }
    if (lastAuthenticated || syncRegistration) {
      lastAuthenticated = false;
      stopCloudSync();
    }
  });

  kernel.bus.on("cloud:online", () => {
    if (syncRegistration) void startCloudSync();
  });
  kernel.bus.on("sync:failed", () => kernel.cloud.reportPending(Math.max(1, kernel.sync.pendingCount())));
  kernel.bus.on("sync:done", () => kernel.cloud.reportPending(kernel.sync.pendingCount()));

  // 页面可见时每 10 分钟同步一次；隐藏时跳过，避免在后台空转
  syncTimer = window.setInterval(() => {
    if (document.visibilityState !== "visible") return;
    if (!syncRegistration) return;
    void startCloudSync();
  }, 10 * 60_000);

  const instance: Os20Runtime = {
    kernel,
    wm,
    runtime,
    ctx,
    sys,
    ready,
    bootLog: () => kernel.bootReport(),
  };
  current = instance;

  // 对外 API：QA / 诊断 / 调试都通过它读取真实状态
  (window as unknown as { GOS20?: unknown }).GOS20 = {
    version: OS_VERSION,
    releaseName: RELEASE_NAME,
    kernel,
    wm,
    runtime,
    registry: kernel.registry,
    permissions: kernel.permissions,
    settings: kernel.settings,
    sync: kernel.sync,
    cloud: kernel.cloud,
    device: kernel.device,
    notifications: kernel.notifications,
    bootReport: () => kernel.bootReport(),
    status: () => kernel.status(),
    applySettings: (options?: { silent?: boolean }) => applySettings(kernel, ctx, options),
    openOnboarding: () => openOnboarding({ kernel, ctx, sys }),
    saveLayout,
    migration: () => migrationReport,
    /** 云同步：立即同步 / 当前接入的数据域 / 本地墓碑数量 */
    syncNow: (domain?: SyncDomainId) => startCloudSync(domain),
    syncDomains: () => syncRegistration?.domains ?? [],
    syncTombstones: () => localTombstones(),
    /** 冲突中心：未解决冲突列表 + 按用户选择解决单条冲突 */
    syncConflicts: () => syncConflicts(),
    syncResolveConflict: (id: string, choice: SyncConflictChoice) => resolveSyncConflict(kernel, id, choice),
    dispose: () => {
      observer.disconnect();
      offClosed();
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", saveLayout);
      window.clearInterval(syncTimer);
      syncRegistration?.dispose();
      void kernel.dispose();
      current = null;
    },
  };
  (window as unknown as { GOS20_READY?: Promise<BootReport> }).GOS20_READY = ready;

  return instance;
}

/** 诊断中心用：内核与迁移的真实摘要 */
export function os20Diagnostics(): {
  version: string;
  boot: BootReport | null;
  registry: Record<string, number> | null;
  migration: string;
  permissions: { total: number; denied: number } | null;
  windows: string;
  sync: string;
  cloud: string;
} {
  const currentInstance = current;
  if (!currentInstance) {
    return {
      version: OS_VERSION,
      boot: null,
      registry: null,
      migration: "内核未初始化",
      permissions: null,
      windows: "未初始化",
      sync: "未初始化",
      cloud: "未初始化",
    };
  }
  const kernel = currentInstance.kernel;
  const migration = (window as unknown as { GOS20?: { migration?: () => { applied: boolean } | null } }).GOS20?.migration?.();
  return {
    version: OS_VERSION,
    boot: kernel.bootReport(),
    registry: kernel.registry.stats(),
    migration: migration ? (migration.applied ? "已完成" : "未完成（下次启动重试）") : "无需迁移",
    permissions: kernel.permissions.auditStats(),
    windows: `${kernel.windows?.stats().open ?? 0} 个窗口`,
    sync: kernel.sync.domains().length ? `${kernel.sync.domains().length} 个数据域` : "同步引擎就绪 · 0 个数据域接入",
    cloud: kernel.cloud.summary().label,
  };
}

/** 让市场 / appcenter 能拿到某个应用的 manifest */
export const manifestOf = (appId: string) => MANIFEST_BY_ID[appId] ?? null;

export type { StorageManager };