/**
 * Guandao OS 1.4 · 应用运行时
 *
 * 把「目录元数据」与「真实窗口」连起来：
 *   install   → 把应用登记进 APPS（之后启动台 / 搜索 / 程序坞都能看见）
 *   uninstall → 关闭窗口、移出程序坞与桌面、从 APPS 注销
 *   update    → 更新登记版本号
 * 全部是本地状态变更，不存在远程代码执行。
 */

import { emit, ls, type AppSpec, type Ctx } from "./core";
import {
  META_BY_ID,
  isInstalled as stateInstalled,
  pendingUpdate,
  readInstall,
  writeInstall,
  type AppMeta,
} from "./catalog";

export type Sys = ReturnType<typeof createSystem>;

const isDesktopLink = (node: HTMLElement) => node.classList.contains("desk-icon");

export const createSystem = (ctx: Ctx) => {
  const specs = new Map<string, AppSpec>();
  /** 1.0–1.3 的内置应用在这里留一份底稿，卸载后还能装回来 */
  const stash = new Map<string, AppSpec>();

  for (const [id, app] of Object.entries(ctx.APPS)) {
    if (!app?.body) continue;
    stash.set(id, {
      id,
      title: app.title,
      width: app.width,
      height: app.height,
      glyph: ctx.APP_ICON[id],
      body: app.body,
    });
  }

  const readDockList = () => ctx.dock.read();
  const saveDockList = (list: string[]) => {
    ctx.dock.save(list);
    ctx.dock.render();
  };

  const refreshIcons = () => {
    ctx.relayoutIcons();
    window.dispatchEvent(new Event("resize"));
  };

  /** 桌面快捷方式（真实 DOM，刷新后按记录补回） */
  const addShortcut = (id: string) => {
    const meta = META_BY_ID[id];
    if (!meta) return;
    if (!stateInstalled(id)) {
      ctx.toast("先安装应用，才能放到桌面");
      return;
    }
    if (!stateInstalled(id)) {
      ctx.toast("先安装应用，才能放到桌面");
      return;
    }
    const st = readInstall();
    if (st.shortcuts.includes(id)) return;
    st.shortcuts.push(id);
    writeInstall(st);
    if (document.querySelector(`.desk-icons .desk-icon[data-app="${id}"]`)) return;
    const node = ctx.buildShortcut(id, meta.name, ctx.APP_ICON[id] ?? meta.glyph);
    if (!node) return;
    document.querySelector(".desk-icons")?.appendChild(node);
    refreshIcons();
  };

  const removeShortcut = (id: string) => {
    const st = readInstall();
    st.shortcuts = st.shortcuts.filter((x) => x !== id);
    writeInstall(st);
    document.querySelectorAll<HTMLElement>(`.desk-icons .desk-icon[data-app="${id}"]`).forEach((n) => n.remove());
    refreshIcons();
  };

  const hasShortcut = (id: string) => readInstall().shortcuts.includes(id);

  /** 窗口级清理：游戏循环、计时器都在这里停 */
  const closeApp = (id: string) => {
    ctx.windows.querySelectorAll<HTMLElement>(`.window[data-app="${id}"]`).forEach((win) => ctx.closeWin(win));
  };

  const mount = (id: string) => {
    if (ctx.APPS[id]) return true;
    const spec = specs.get(id) ?? stash.get(id);
    if (!spec) return false;
    ctx.registerApp(spec);
    if (spec.glyph) ctx.APP_ICON[id] = spec.glyph;
    return true;
  };

  const unmount = (id: string) => {
    closeApp(id);
    delete ctx.APPS[id];
    delete ctx.APP_ICON[id];
    const dock = readDockList().filter((x) => x !== id);
    ctx.dock.save(dock);
    ctx.dock.render();
    document.querySelectorAll<HTMLElement>(`.desk-icons .desk-icon[data-app="${id}"]`).forEach((n) => n.remove());
    refreshIcons();
  };

  const install = (id: string) => {
    const meta = META_BY_ID[id];
    if (!meta) return false;
    if (!mount(id)) return false;
    const st = readInstall();
    st.installed[id] = { version: meta.version, at: Date.now() };
    writeInstall(st);
    if (st.shortcuts.includes(id) && !document.querySelector(`.desk-icons .desk-icon[data-app="${id}"]`)) {
      const node = ctx.buildShortcut(id, meta.name, ctx.APP_ICON[id] ?? meta.glyph);
      if (node) document.querySelector(".desk-icons")?.appendChild(node);
      refreshIcons();
    }
    ctx.toast(`已安装「${meta.name}」`);
    emit("app-installed", { id });
    return true;
  };

  const uninstall = (id: string) => {
    const meta = META_BY_ID[id];
    if (!meta) return false;
    // 应用中心是卸载后的唯一入口，不能把它自己卸掉
    if (id === "appcenter") {
      ctx.toast("应用中心是系统入口，不能卸载");
      return false;
    }
    // 应用中心是卸载后的唯一入口，不能把它自己卸掉
    if (id === "appcenter") {
      ctx.toast("应用中心是系统入口，不能卸载");
      return false;
    }
    const st = readInstall();
    delete st.installed[id];
    st.shortcuts = st.shortcuts.filter((x) => x !== id);
    writeInstall(st);
    unmount(id);
    ctx.toast(`已卸载「${meta.name}」，可在应用中心重新安装`);
    emit("app-uninstalled", { id });
    return true;
  };

  const update = (id: string) => {
    const meta = META_BY_ID[id];
    if (!meta) return false;
    const st = readInstall();
    if (!st.installed[id]) return false;
    st.installed[id] = { version: meta.version, at: Date.now() };
    writeInstall(st);
    ctx.toast(`「${meta.name}」已更新到 ${meta.version}`);
    emit("app-updated", { id });
    return true;
  };

  const open = (id: string) => {
    if (!stateInstalled(id)) {
      ctx.toast("这个应用还没安装，去应用中心看看");
      return false;
    }
    ctx.openApp(id);
    return true;
  };

  const pinDock = (id: string, on: boolean) => {
    if (on && !stateInstalled(id)) {
      ctx.toast("先安装应用，才能固定到程序坞");
      return;
    }
    const list = readDockList();
    const has = list.includes(id);
    if (on && !has) list.push(id);
    if (!on && has) list.splice(list.indexOf(id), 1);
    saveDockList(list);
    emit("dock-change", { id, on });
  };

  const isPinned = (id: string) => readDockList().includes(id);

  const running = () => {
    const map = new Map<string, { id: string; title: string; count: number; minimized: number }>();
    ctx.windows.querySelectorAll<HTMLElement>(".window").forEach((win) => {
      const id = win.dataset.app ?? "";
      if (!id) return;
      const cur = map.get(id) ?? { id, title: ctx.APPS[id]?.title ?? id, count: 0, minimized: 0 };
      cur.count += 1;
      if (win.classList.contains("is-minimized")) cur.minimized += 1;
      map.set(id, cur);
    });
    return [...map.values()];
  };

  const installedApps = () => {
    const st = readInstall();
    return Object.keys(st.installed)
      .map((id) => META_BY_ID[id])
      .filter((m): m is AppMeta => Boolean(m));
  };

  const registerSpec = (spec: AppSpec) => {
    specs.set(spec.id, spec);
  };

  const restoreShortcuts = () => {
    const st = readInstall();
    const host = document.querySelector(".desk-icons");
    if (!host) return;
    for (const id of st.shortcuts) {
      if (!st.installed[id]) continue;
      if (host.querySelector(`.desk-icon[data-app="${id}"]`)) continue;
      const meta = META_BY_ID[id];
      if (!meta) continue;
      const node = ctx.buildShortcut(id, meta.name, ctx.APP_ICON[id] ?? meta.glyph);
      if (node) host.appendChild(node);
    }
    if (st.shortcuts.length) refreshIcons();
  };

  /* ---------------- 工作空间需要的窗口快照能力 ---------------- */

  const OS_STATE_KEY = "guandao.os.state.v1";

  const snapshotWindows = (): Record<string, unknown> => {
    const map: Record<string, unknown> = {};
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
    return map;
  };

  const openIds = () =>
    Array.from(ctx.windows.querySelectorAll<HTMLElement>(".window"))
      .map((w) => w.dataset.app ?? "")
      .filter(Boolean);

  /** 先关窗 → 再写目标几何 → 再逐个打开，避免 saveWindows 把目标配置覆盖掉 */
  const restoreWindows = async (map: Record<string, unknown>, ids: string[]) => {
    closeAppAll();
    await new Promise((r) => window.setTimeout(r, 240));
    const st = ls.get<Record<string, unknown>>(OS_STATE_KEY, {});
    ls.set(OS_STATE_KEY, { ...st, windows: map });
    for (const id of ids) {
      if (!stateInstalled(id) || !ctx.APPS[id]) continue;
      ctx.openApp(id);
      await new Promise((r) => window.setTimeout(r, 90));
    }
  };

  const closeAppAll = () => {
    ctx.windows.querySelectorAll<HTMLElement>(".window").forEach((win) => ctx.closeWin(win));
  };

  const desktopShortcutIds = () =>
    Array.from(document.querySelectorAll<HTMLElement>(".desk-icons .desk-icon[data-app]"))
      .filter((node) => isDesktopLink(node))
      .map((node) => node.dataset.app ?? "")
      .filter(Boolean);

  return {
    registerSpec,
    install,
    uninstall,
    update,
    open,
    mount,
    unmount,
    pinDock,
    isPinned,
    addShortcut,
    removeShortcut,
    hasShortcut,
    running,
    installedApps,
    closeApp,
    closeAppAll,
    restoreShortcuts,
    snapshotWindows,
    openIds,
    restoreWindows,
    desktopShortcutIds,
    isInstalled: stateInstalled,
    pendingUpdate,
    state: readInstall,
  };
};
