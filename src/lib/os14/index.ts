/**
 * Guandao OS 1.4 · 启动入口
 *
 * 把主脚本的窗口 / 通知 / 组件 / 外观能力收成一个 Ctx，
 * 注册 1.4 的生态应用与桌面组件，再启动主题引擎、桌面互动与系统服务。
 * 所有应用都复用 1.0 已有的窗口系统，没有另起一套 DOM。
 */

import { escapeHtml, ls, uid, type Ctx } from "./core";
import { createSystem } from "./system";
import { readInstall, META_BY_ID } from "./catalog";
import { initThemes, initThemeApp, renderThemeApp } from "./themes";
import { bumpOpen, initAppCenter, renderAppCenter } from "./appcenter";
import { initWidgetGallery, registerNewWidgets, renderWidgetGallery } from "./widgetstore";
import { initPlayground, renderPlayground } from "./playground";
import { initWorkspaceShortcuts, initWorkspaces, renderWorkspaces } from "./workspaces";
import { initControl, renderControl } from "./control";
import { initTasks, renderTasks } from "./tasks";
import { autoBackupOnBoot, initDataCenter, renderDataCenter } from "./datacenter";
import { initDesktop, terminalCommand } from "./desktop";
import { readPrefs } from "./prefs";
import { renderNotes, initNotes } from "./apps/notes";
import { renderCalendar, initCalendar } from "./apps/calendar";
import { renderGallery, initGallery } from "./apps/gallery";
import { renderMusic, initMusic } from "./apps/music";
import { renderReader, initReader } from "./apps/reader";
import { renderFiles, initFiles } from "./files";

export const VERSION = "1.4.0";

export type BootResult = { ctx: Ctx; sys: ReturnType<typeof createSystem>; version: string };

type Spec = {
  id: string;
  title: string;
  width: number;
  height: number;
  glyph: string;
  render: () => string;
  init?: (win: HTMLElement) => void | (() => void);
  optional?: boolean;
};

export const initOs14 = (ctx: Ctx): BootResult => {
  const sys = createSystem(ctx);

  const specs: Spec[] = [
    { id: "appcenter", title: "应用中心", width: 960, height: 660, glyph: "di-appcenter", render: renderAppCenter, init: (w) => initAppCenter(w, ctx, sys) },
    { id: "themes", title: "主题中心", width: 940, height: 640, glyph: "di-themes", render: renderThemeApp, init: initThemeApp },
    { id: "widgetstore", title: "组件中心", width: 920, height: 620, glyph: "di-widgets", render: renderWidgetGallery, init: initWidgetGallery },
    { id: "playground", title: "游乐场", width: 900, height: 640, glyph: "di-play", render: renderPlayground, init: (w) => initPlayground(w, ctx) },
    { id: "workspaces", title: "工作空间", width: 900, height: 620, glyph: "di-space", render: renderWorkspaces, init: (w) => initWorkspaces(w, ctx) },
    { id: "control", title: "控制中心", width: 820, height: 600, glyph: "di-control", render: renderControl, init: (w) => initControl(w, ctx, sys) },
    { id: "tasks", title: "任务与通知", width: 820, height: 600, glyph: "di-tasks", render: renderTasks, init: (w) => initTasks(w, ctx) },
    { id: "datacenter", title: "数据中心", width: 880, height: 620, glyph: "di-data", render: renderDataCenter, init: (w) => initDataCenter(w, ctx) },
    { id: "notes", title: "Guandao Notes", width: 920, height: 600, glyph: "di-note", render: renderNotes, init: (w) => initNotes(w, ctx) },
    { id: "calendar", title: "Guandao Calendar", width: 900, height: 620, glyph: "di-cal", render: renderCalendar, init: (w) => initCalendar(w, ctx) },
    { id: "files", title: "文件管理器", width: 900, height: 600, glyph: "di-files", render: renderFiles, init: (w) => initFiles(w, ctx) },
    { id: "music", title: "Guandao Music", width: 720, height: 560, glyph: "di-music", render: renderMusic, init: (w) => initMusic(w, ctx) },
    { id: "gallery", title: "Guandao Gallery", width: 880, height: 600, glyph: "di-gallery", render: renderGallery, init: (w) => initGallery(w, ctx), optional: true },
    { id: "reader", title: "Guandao Reader", width: 880, height: 620, glyph: "di-reader", render: renderReader, init: (w) => initReader(w, ctx), optional: true },
  ];

  for (const s of specs) {
    const spec = { id: s.id, title: s.title, width: s.width, height: s.height, glyph: s.glyph, body: s.render, init: s.init };
    sys.registerSpec(spec);
    // 直接注册：同名内置应用会被 1.4 的实现覆盖，旧 init 链不再执行
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

  ctx.setDockFilter((id) => sys.isInstalled(id));
  ctx.setLaunchGuard((id) => {
    if (sys.isInstalled(id)) return false;
    ctx.toast("这个应用还没安装，去应用中心看看");
    ctx.openApp("appcenter");
    return true;
  });

  /* ---------------- 启动服务 ---------------- */
  initThemes(ctx);
  initWorkspaceShortcuts(ctx);
  registerNewWidgets(ctx);
  initDesktop(ctx);
  autoBackupOnBoot();

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
    isInstalled: sys.isInstalled,
    install: sys.install,
    uninstall: sys.uninstall,
    open: sys.open,
    terminal: terminalCommand,
    onOpen: bumpOpen,
    catalog: META_BY_ID,
    prefs: readPrefs,
  };
  (window as unknown as { GOS14?: typeof api }).GOS14 = api;

  return { ctx, sys, version: VERSION };
};

export { ls, escapeHtml, uid };
