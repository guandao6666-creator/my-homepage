/**
 * Guandao OS 1.4 · 工作空间
 *
 * 工作空间保存「一整套场景」：主题、壁纸、组件、程序坞、快捷方式、
 * 窗口布局与通知偏好；虚拟桌面只负责管理窗口。两者并存，互不覆盖。
 */

import { normalizeSnapshot, rescaleSnapshot, type Viewport, type WindowState } from "../core/layout";
import { emit, escapeHtml, ls, uid, type Ctx, type WinStateLike } from "./core";
import { findTheme, readThemeState, applyTheme } from "./themes";
import { readInstall, writeInstall } from "./catalog";
import { readPrefs, patchPrefs } from "./prefs";

export type Workspace = {
  id: string;
  name: string;
  preset: boolean;
  theme: string;
  /** 主题之外单独记住当前壁纸，切场景时一并恢复 */
  wall: string;
  widgets: Record<string, { x?: number; y?: number; enabled?: boolean; size?: "s" | "m" | "l" }>;
  dock: string[];
  shortcuts: string[];
  windows: Record<string, WinStateLike>;
  openApps: string[];
  dnd: boolean;
  createdAt: number;
  updatedAt: number;
  /** 2.0 跨设备同步：保存时的视口，用于恢复时重算窗口几何（旧数据没有，按当前视口只做边界收敛） */
  viewport?: Viewport;
};

type WsState = { v: 1; list: Workspace[]; current: string };

const KEY = "guandao.os14.ws.v1";
const WIDGET_KEY = "guandao.os.widgets.v1";

const PRESETS: Array<{ id: string; name: string; theme: string; apps: string[]; widgets: string[]; dnd: boolean; desc: string }> = [
  {
    id: "daily",
    name: "Daily 日常",
    theme: "aurora",
    apps: ["posts", "notes", "calendar", "music"],
    widgets: ["clock", "calendar", "weather", "taskmini", "quote"],
    dnd: false,
    desc: "常用应用 + 日历 + 时钟 + 快捷便签",
  },
  {
    id: "study",
    name: "Study 学习",
    theme: "forest",
    apps: ["notes", "reader", "calc", "calendar"],
    widgets: ["focus", "calendar", "taskmini", "countdown"],
    dnd: true,
    desc: "笔记、阅读器、计算器、日历与专注计时",
  },
  {
    id: "work",
    name: "Work 工作",
    theme: "ocean",
    apps: ["files", "terminal", "monitor", "notes"],
    widgets: ["taskmini", "countdown", "sysmon", "clock"],
    dnd: true,
    desc: "文件、终端、系统监视器与笔记",
  },
  {
    id: "entertainment",
    name: "Entertainment 娱乐",
    theme: "sunset",
    apps: ["music", "playground", "gallery"],
    widgets: ["musicmini", "photoframe", "clock"],
    dnd: false,
    desc: "音乐、游戏中心、相册与更松弛的主题",
  },
];

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const emptyWidgets = (ids: string[]) => {
  const map: Record<string, { enabled: boolean }> = {};
  for (const id of ids) map[id] = { enabled: true };
  return map;
};

const makePreset = (p: (typeof PRESETS)[number]): Workspace => ({
  id: p.id,
  name: p.name,
  preset: true,
  theme: p.theme,
  wall: findTheme(p.theme)?.wall ?? "aurora",
  widgets: emptyWidgets(p.widgets),
  dock: ["appcenter", ...p.apps.slice(0, 4)],
  shortcuts: [],
  windows: {},
  openApps: p.apps,
  dnd: p.dnd,
  createdAt: 0,
  updatedAt: Date.now(),
});

const defaults = (): WsState => {
  const list = PRESETS.map(makePreset);
  return { v: 1, list, current: "daily" };
};

const read = (): WsState => {
  const raw = ls.get<WsState | null>(KEY, null);
  if (raw && raw.v === 1 && Array.isArray(raw.list)) {
    // 升级补齐：以后新增预设时也能自动出现
    for (const p of PRESETS) {
      if (!raw.list.some((w) => w.id === p.id)) raw.list.push(makePreset(p));
    }
    return raw;
  }
  const fresh = defaults();
  ls.set(KEY, fresh);
  return fresh;
};

const write = (st: WsState) => {
  ls.set(KEY, st);
  emit("workspaces-change", { current: st.current });
};

export const workspaceList = () => read().list;
export const currentWorkspace = () => read().list.find((w) => w.id === read().current) ?? read().list[0];

/* ============================================================
   捕获 / 应用
   ============================================================ */

/** 当前 shell 视口；workespace 快照与窗口重算都以它为目标尺寸 */
const currentViewport = (ctx: Ctx): Viewport => {
  try {
    const rect = ctx.windows.getBoundingClientRect();
    const width = Math.round(rect.width);
    const height = Math.round(rect.height);
    if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
      return { width, height };
    }
  } catch {
    /* 桌面 DOM 尚未完成布局 */
  }
  const width = Number(window.innerWidth) || 1280;
  const height = Number(window.innerHeight) || 800;
  return { width: Math.round(width), height: Math.round(height) };
};

const toWinStateMap = (windows: Record<string, WindowState>): Record<string, WinStateLike> => {
  const map: Record<string, WinStateLike> = {};
  for (const [app, state] of Object.entries(windows)) {
    map[app] = {
      left: state.left,
      top: state.top,
      width: state.width,
      height: state.height,
      minimized: state.minimized,
      maximized: state.maximized,
      space: state.space,
    };
  }
  return map;
};

const capture = (base: Workspace, ctx: Ctx): Workspace => {
  const install = readInstall();
  const themeState = readThemeState();
  const cfg = (ctx.api13.cfg() as { wall?: { id?: string } }) ?? {};
  return {
    ...base,
    theme: themeState.current,
    wall: String(cfg.wall?.id ?? base.wall ?? "aurora"),
    widgets: ctx.widgets.state(),
    dock: ctx.dock.read(),
    shortcuts: install.shortcuts.slice(),
    openApps: Array.from(ctx.windows.querySelectorAll<HTMLElement>(".window"))
      .map((w) => w.dataset.app ?? "")
      .filter(Boolean),
    windows: {},
    dnd: readPrefs().dnd,
    viewport: currentViewport(ctx),
    updatedAt: Date.now(),
  };
};

/** 保存当前场景到指定工作空间 */
export const saveWorkspace = (id: string, ctx: Ctx) => {
  const st = read();
  const idx = st.list.findIndex((w) => w.id === id);
  if (idx < 0) return;
  const next = capture(st.list[idx], ctx);
  // 窗口几何用 DOM 快照
  const map: Record<string, WinStateLike> = {};
  ctx.windows.querySelectorAll<HTMLElement>(".window").forEach((win) => {
    const app = win.dataset.app;
    if (!app) return;
    map[app] = {
      left: win.offsetLeft,
      top: win.offsetTop,
      width: win.offsetWidth,
      height: win.offsetHeight,
      minimized: win.classList.contains("is-minimized"),
      maximized: win.classList.contains("is-maximized"),
      space: Number(win.dataset.space) || 1,
    };
  });
  next.windows = map;
  if (!next.openApps.length) next.openApps = Object.keys(map);
  st.list[idx] = next;
  write(st);
  ctx.toast(`已保存「${next.name}」的当前布局`);
};

const showTransition = (name: string) => {
  let veil = document.getElementById("ws-transition");
  if (!veil) {
    veil = document.createElement("div");
    veil.id = "ws-transition";
    veil.className = "ws-transition";
    veil.innerHTML = `<div><span>切换工作空间</span><b data-ws-name></b></div>`;
    document.body.appendChild(veil);
  }
  const label = veil.querySelector<HTMLElement>("[data-ws-name]");
  if (label) label.textContent = name;
  // 强制回流，保证第二次切换也能重新播动画
  void veil.offsetWidth;
  veil.classList.add("is-on");
  return () => window.setTimeout(() => veil?.classList.remove("is-on"), 160);
};

export const applyWorkspace = async (id: string, ctx: Ctx, opts: { silent?: boolean } = {}) => {
  const st = read();
  const ws = st.list.find((w) => w.id === id);
  if (!ws) return;

  // 跨设备恢复：窗口几何按「保存时视口 → 当前视口」重算。
  // 只换算坐标/尺寸并写回工作空间，不改变 restoreWindows 的开关窗顺序与语义。
  if (ws.windows && Object.keys(ws.windows).length > 0) {
    const viewport = currentViewport(ctx);
    const snapshot = normalizeSnapshot({ windows: ws.windows, viewport: ws.viewport }, viewport);
    ws.windows = toWinStateMap(rescaleSnapshot(snapshot, viewport, { cascade: false }).windows);
    ws.viewport = viewport;
  } else if (!ws.viewport) {
    ws.viewport = currentViewport(ctx);
  }

  const hideTransition = showTransition(ws.name);
  await new Promise((r) => window.setTimeout(r, 180));
  st.current = id;
  write(st);

  // 主题（含壁纸 / 材质 / 圆角 / 程序坞尺寸）
  const theme = findTheme(ws.theme);
  if (theme) applyTheme(theme, { silent: true });
  // 主题自带壁纸，但用户可能在主题内换过图；工作空间以自己记录的那张为准
  if (ws.wall && ws.wall !== theme?.wall) {
    try {
      ctx.api13.setWallpaper(ws.wall);
    } catch {
      /* 壁纸不存在就保持主题默认 */
    }
  }
  // 主题自带壁纸，但用户可能在主题内换过图；工作空间以自己记录的那张为准
  if (ws.wall && ws.wall !== theme?.wall) {
    try {
      ctx.api13.setWallpaper(ws.wall);
    } catch {
      /* 壁纸不存在就保持主题默认 */
    }
  }

  // 组件：整表替换，未列出的组件关闭
  const all = ctx.widgets.state();
  const ids = ctx.widgets.ids;
  const next: Record<string, Record<string, unknown>> = { ...all };
  for (const wid of ids) {
    const saved = ws.widgets[wid];
    next[wid] = saved ? { ...saved, enabled: saved.enabled !== false } : { ...all[wid], enabled: false };
  }
  ls.set(WIDGET_KEY, next);
  ctx.widgets.renderAll();
  ctx.widgets.stack();

  // 程序坞
  ctx.dock.save(ws.dock.slice());
  ctx.dock.render();

  // 桌面快捷方式
  const install = readInstall();
  install.shortcuts = ws.shortcuts.slice();
  writeInstall(install);
  document.querySelectorAll<HTMLElement>(".desk-icons .desk-icon[data-app]").forEach((n) => {
    const app = n.dataset.app ?? "";
    if (app && !ws.shortcuts.includes(app)) n.remove();
  });
  for (const id of ws.shortcuts) {
    if (!ctx.APPS[id] || document.querySelector(`.desk-icons .desk-icon[data-app="${id}"]`)) continue;
    const node = ctx.buildShortcut(id, ctx.APPS[id].title, ctx.APP_ICON[id] ?? "di-folder");
    if (node) document.querySelector(".desk-icons")?.appendChild(node);
  }
  window.dispatchEvent(new Event("resize"));

  // 通知偏好
  patchPrefs({ dnd: ws.dnd });

  // 窗口：先关再按快照重开
  await ctx.restoreWindows(ws.windows, ws.openApps);
  hideTransition();

  if (!opts.silent) ctx.toast(`已切换到「${ws.name}」`);
};

/* 内部桥接：供按需加载的 workspaces-app.ts 使用 */
export const WORKSPACE_PRESETS = PRESETS;
export const readWorkspaceState = read;
export const writeWorkspaceState = write;
export const cloneWorkspace = clone;

/** 全局快捷键：Alt + 1..4 切换工作空间。启动时注册一次，不依赖窗口是否开过 */
export const initWorkspaceShortcuts = (ctx: Ctx) => {
  if ((window as unknown as { __wsKeys?: boolean }).__wsKeys) return;
  (window as unknown as { __wsKeys?: boolean }).__wsKeys = true;
  document.addEventListener("keydown", (e) => {
    if (!e.altKey || e.ctrlKey || e.metaKey) return;
    const el = document.activeElement as HTMLElement | null;
    const typing =
      el &&
      (el.tagName === "TEXTAREA" ||
        el.isContentEditable ||
        (el.tagName === "INPUT" &&
          !["checkbox", "radio", "file", "button", "range", "color", "submit"].includes((el as HTMLInputElement).type)));
    if (typing) return;
    const n = Number(e.key);
    if (!Number.isInteger(n) || n < 1 || n > 4) return;
    const ws = read().list[n - 1];
    if (!ws) return;
    e.preventDefault();
    void applyWorkspace(ws.id, ctx);
  });
};

export const captureCurrentWorkspace = (ctx: Ctx): Workspace => {
  const st = read();
  const base = st.list.find((workspace) => workspace.id === st.current) ?? st.list[0];
  const captured = capture(base, ctx);
  const map: Record<string, WinStateLike> = {};
  ctx.windows.querySelectorAll<HTMLElement>(".window").forEach((win) => {
    const app = win.dataset.app;
    if (!app) return;
    map[app] = {
      left: win.offsetLeft,
      top: win.offsetTop,
      width: win.offsetWidth,
      height: win.offsetHeight,
      minimized: win.classList.contains("is-minimized"),
      maximized: win.classList.contains("is-maximized"),
      space: Number(win.dataset.space) || 1,
    };
  });
  captured.windows = map;
  return captured;
};

export const applyWorkspaceByIndex = (n: number, ctx: Ctx) => {
  const ws = read().list[n];
  if (ws) void applyWorkspace(ws.id, ctx);
};

/* ============================================================
   Guandao OS 1.6 · 社区工作空间导入
   —— 只新增一套工作空间，绝不覆盖现有桌面；
   —— 导入前先把当前工作空间快照写入本地，可回退。
   ============================================================ */

const SNAPSHOT_KEY = "guandao.os14.ws.snapshots.v1";

export type CommunityWorkspaceResult = {
  id: string;
  name: string;
  missingApps: string[];
  missingWidgets: string[];
  themeMissing: boolean;
  snapshotAt: number;
};

const makeSnapshot = (st: WsState): number => {
  const at = Date.now();
  const snapshots = ls.get<Array<{ at: number; current: string; list: Workspace[] }>>(SNAPSHOT_KEY, []);
  snapshots.unshift({ at, current: st.current, list: clone(st.list) });
  ls.set(SNAPSHOT_KEY, snapshots.slice(0, 5));
  return at;
};

export const workspaceSnapshots = () =>
  ls.get<Array<{ at: number; current: string; list: Workspace[] }>>(SNAPSHOT_KEY, []);

export const importCommunityWorkspace = (
  config: Record<string, unknown>,
  ctx: Ctx,
  meta: { postId: string; packageName?: string },
): CommunityWorkspaceResult => {
  const st = read();
  const snapshotAt = makeSnapshot(st);

  const missingApps: string[] = [];
  const cleanId = (value: unknown) => {
    const id = String(value ?? "");
    return /^[a-z0-9][a-z0-9-]{0,40}$/.test(id) ? id : "";
  };
  const filterApps = (value: unknown) => {
    if (!Array.isArray(value)) return [];
    const out: string[] = [];
    for (const item of value.slice(0, 40)) {
      const id = cleanId(item);
      if (!id) continue;
      if (!ctx.APPS[id]) {
        if (!missingApps.includes(id)) missingApps.push(id);
        continue;
      }
      if (!out.includes(id)) out.push(id);
    }
    return out;
  };

  const themeId = String(config.themeId ?? "");
  const theme = themeId ? findTheme(themeId) : null;
  const themeMissing = Boolean(themeId) && !theme;
  const currentTheme = readThemeState().current;

  const missingWidgets: string[] = [];
  const widgets: Record<string, { enabled?: boolean; size?: "s" | "m" | "l"; x?: number; y?: number }> = {};
  const rawWidgets = config.widgets && typeof config.widgets === "object" ? (config.widgets as Record<string, unknown>) : {};
  for (const [id, value] of Object.entries(rawWidgets).slice(0, 40)) {
    if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(id)) continue;
    if (!ctx.widgets.ids.includes(id)) {
      missingWidgets.push(id);
      continue;
    }
    const state = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
    const widget: { enabled?: boolean; size?: "s" | "m" | "l"; x?: number; y?: number } = {};
    if (state.enabled !== undefined) widget.enabled = state.enabled !== false;
    if (["s", "m", "l"].includes(String(state.size))) widget.size = state.size as "s" | "m" | "l";
    for (const axis of ["x", "y"] as const) {
      const num = Number(state[axis]);
      if (Number.isFinite(num) && Math.abs(num) <= 20000) widget[axis] = Math.round(num);
    }
    widgets[id] = widget;
  }

  const baseName = String(config.name || meta.packageName || "社区工作空间").trim().slice(0, 24) || "社区工作空间";
  let name = baseName;
  if (st.list.some((workspace) => workspace.name === name)) name = `${baseName} · 社区`.slice(0, 24);

  const workspace: Workspace = {
    id: `ws-com-${meta.postId.slice(0, 8)}-${Date.now().toString(36).slice(-4)}`,
    name,
    preset: false,
    theme: theme ? theme.id : currentTheme,
    wall: String(config.wallId || theme?.wall || "aurora").slice(0, 60),
    widgets,
    dock: filterApps(config.dock),
    shortcuts: filterApps(config.shortcuts),
    openApps: filterApps(config.openApps),
    windows: {},
    dnd: Boolean(config.dnd),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  st.list.push(workspace);
  st.current = st.current || workspace.id;
  write(st);

  return {
    id: workspace.id,
    name: workspace.name,
    missingApps,
    missingWidgets,
    themeMissing,
    snapshotAt,
  };
};

export const removeCommunityWorkspace = (id: string): boolean => {
  const st = read();
  if (!st.list.some((workspace) => workspace.id === id)) return false;
  st.list = st.list.filter((workspace) => workspace.id !== id);
  if (st.current === id) st.current = st.list[0]?.id ?? "daily";
  write(st);
  return true;
};
