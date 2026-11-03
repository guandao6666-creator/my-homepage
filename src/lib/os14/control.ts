/**
 * Guandao OS 1.4 · 控制中心
 *
 * 把散落在设置里的开关收进一个面板。所有"真实数据"与"模拟值"都显式标注：
 * 浏览器读不到的硬件指标不会伪装成真实读数。
 */

import {
  badge,
  bindTabs,
  escapeHtml,
  fmtBytes,
  fmtDateTime,
  ls,
  modal,
  shell,
  type Ctx,
} from "./core";
import { META_BY_ID, installedVersion, isInstalled, pendingUpdate } from "./catalog";
import { patchPrefs, readPrefs } from "./prefs";
import { currentWorkspace, workspaceList } from "./workspaces";
import type { Sys } from "./system";

let ctxRef: Ctx | null = null;
let sysRef: Sys | null = null;
let tab = "quick";

const settingRow = (label: string, desc: string, control: string) => `
  <div class="cc14-row">
    <div class="cc14-row-label"><b>${escapeHtml(label)}</b><span>${escapeHtml(desc)}</span></div>
    <div class="cc14-row-ctl">${control}</div>
  </div>`;

const toggle = (key: string, on: boolean) => `
  <button class="cc14-switch ${on ? "is-on" : ""}" type="button" data-cc-toggle="${key}" role="switch" aria-checked="${on}">
    <i></i><span>${on ? "开" : "关"}</span>
  </button>`;

const quickView = () => {
  const prefs = readPrefs();
  const theme = document.documentElement.dataset.osTheme ?? document.body.dataset.osTheme ?? "dark";
  const state = ctxRef?.readState() ?? {};
  const iconsOn = state.showIcons !== false;
  const cfg = (ctxRef?.api13.cfg() ?? {}) as { dock?: { autohide?: boolean } };
  const full = Boolean(document.fullscreenElement);

  return `
    <div class="g14-scroll">
      <div class="g14-pane-head"><h3>快捷控制</h3><p>常用的开关都在这里，改了立即生效并保存。</p></div>
      <div class="cc14-group">
        <p class="cc14-group-title">外观</p>
        ${settingRow("深浅模式", "切换整个桌面的明暗", `<div class="g14-seg" data-cc-seg="mode">
          <button type="button" data-cc-mode="dark" class="${theme !== "light" ? "is-active" : ""}">深色</button>
          <button type="button" data-cc-mode="light" class="${theme === "light" ? "is-active" : ""}">浅色</button>
        </div>`)}
        ${settingRow("壁纸", (ctxRef?.api13.cfg() as { wall?: { id?: string } })?.wall?.id ?? "—", `<div class="cc14-btns">
          <button class="g14-btn" type="button" data-cc-nextwall>下一张</button>
          <button class="g14-btn is-ghost" type="button" data-cc-open="themes">主题中心</button>
        </div>`)}
        ${settingRow("动画效果", "关闭后减少过渡与粒子", toggle("animations", prefs.animations))}
      </div>
      <div class="cc14-group">
        <p class="cc14-group-title">桌面</p>
        ${settingRow("桌面图标", "临时隐藏 / 显示图标栏", toggle("icons", iconsOn))}
        ${settingRow("程序坞自动隐藏", "鼠标移开时收起程序坞", toggle("dockhide", Boolean(cfg.dock?.autohide)))}
        ${settingRow("全屏", "进入浏览器全屏，专注一点", `<button class="g14-btn" type="button" data-cc-full>${full ? "退出全屏" : "进入全屏"}</button>`)}
        ${settingRow("组件", "打开组件中心布置桌面", `<button class="g14-btn is-ghost" type="button" data-cc-open="widgetstore">组件中心</button>`)}
      </div>
      <div class="cc14-group">
        <p class="cc14-group-title">声音与打扰</p>
        ${settingRow("勿扰模式", "只记录通知，不弹提示（应用内通知仍会写入）", toggle("dnd", prefs.dnd))}
        ${settingRow("音量", "音量滑块只影响本页播放器，属于模拟控制", `
          <div class="cc14-vol">
            <input type="range" min="0" max="100" value="${prefs.volume}" data-cc-vol />
            <b data-cc-volnum>${prefs.volume}%</b>
            ${badge("模拟", "warn")}
          </div>`)}
      </div>
      <div class="cc14-group">
        <p class="cc14-group-title">系统</p>
        ${settingRow("工作空间", currentWorkspace()?.name ?? "—", `<button class="g14-btn" type="button" data-cc-open="workspaces">切换场景</button>`)}
        ${settingRow("数据", "备份、导出与恢复", `<button class="g14-btn is-ghost" type="button" data-cc-open="datacenter">数据中心</button>`)}
      </div>
    </div>`;
};

const statusView = () => {
  const state = ctxRef?.readState() ?? {};
  const desks = (state.desks as Array<{ id: number; name: string }> | undefined) ?? [];
  const spaceId = Number(state.space) || 1;
  const space = desks.find((d) => d.id === spaceId);
  const wins = Array.from(ctxRef?.windows.querySelectorAll<HTMLElement>(".window") ?? []);
  const running = new Map<string, number>();
  for (const w of wins) {
    const id = w.dataset.app ?? "";
    running.set(id, (running.get(id) ?? 0) + 1);
  }
  const localBytes = ls.keys().reduce((sum, k) => sum + (k.length + ls.str(k).length) * 2, 0);
  const uptime = Math.floor(performance.now() / 1000);
  const hh = Math.floor(uptime / 3600);
  const mm = Math.floor((uptime % 3600) / 60);
  const ss = uptime % 60;
  const ws = currentWorkspace();

  return `
    <div class="g14-scroll">
      <div class="g14-pane-head"><h3>系统状态</h3><p>标「真实」的来自浏览器可读的数据；标「模拟」的只是界面演示，不代表硬件读数。</p></div>
      <div class="cc14-cards">
        <div class="cc14-card"><span>当前虚拟桌面</span><b>${escapeHtml(space?.name ?? `桌面 ${spaceId}`)}</b><i>${badge("真实", "ok")} 来自桌面系统</i></div>
        <div class="cc14-card"><span>当前工作空间</span><b>${escapeHtml(ws?.name ?? "—")}</b><i>${badge("真实", "ok")} 场景配置</i></div>
        <div class="cc14-card"><span>运行中的应用</span><b>${running.size} 个</b><i>${badge("真实", "ok")} 窗口 DOM 统计</i></div>
        <div class="cc14-card"><span>打开的窗口</span><b>${wins.length} 个</b><i>${badge("真实", "ok")} 含最小化</i></div>
        <div class="cc14-card"><span>页面运行时间</span><b>${hh}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}</b><i>${badge("真实", "ok")} 本次会话</i></div>
        <div class="cc14-card"><span>本地数据占用</span><b>${fmtBytes(localBytes)}</b><i>${badge("估算", "warn")} localStorage 文本量</i></div>
      </div>
      <div class="cc14-group">
        <p class="cc14-group-title">打开着的窗口</p>
        ${
          wins.length
            ? `<div class="cc14-winlist">${wins
                .map((w) => {
                  const id = w.dataset.app ?? "";
                  const title = ctxRef?.APPS[id]?.title ?? id;
                  return `<div class="cc14-winrow"><span>${escapeHtml(title)}</span><i>${w.classList.contains("is-minimized") ? "已收起" : w.classList.contains("is-maximized") ? "最大化" : "窗口"}</i><button class="g14-btn is-ghost" type="button" data-cc-close="${escapeHtml(id)}">关闭</button></div>`;
                })
                .join("")}</div>`
            : `<p class="g14-hint">现在没有打开的窗口。</p>`
        }
      </div>
      <div class="cc14-group">
        <p class="cc14-group-title">说明</p>
        <div class="cc14-note">
          <p>${badge("模拟", "warn")} 音量、亮度一类的滑块只改变页面内的播放音量或视觉观感，浏览器无法调整系统音量。</p>
          <p>${badge("真实", "ok")} 运行时间、窗口数、存储占用都来自当前页面，刷新后重新计时。</p>
          <p>${badge("真实", "ok")} "强制关闭"只关闭 Guandao OS 内部的窗口，不会结束你电脑上的任何进程。</p>
        </div>
      </div>
    </div>`;
};

const appsView = () => {
  const sys = sysRef;
  if (!sys) return "";
  const installed = sys.installedApps();
  const running = sys.running();
  const rows = installed
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name, "zh"))
    .map((m) => {
      const isRunning = running.some((r) => r.id === m.id);
      return `<div class="cc14-approw">
        <span class="di-glyph ${m.glyph}"></span>
        <div class="cc14-appmeta"><b>${escapeHtml(m.name)}</b><span>${escapeHtml(m.tagline)}</span></div>
        <span class="cc14-appver">v${escapeHtml(installedVersion(m.id) || m.version)}${pendingUpdate(m.id) ? ` → ${m.version}` : ""}</span>
        ${isRunning ? badge("运行中", "ok") : ""}
        <div class="cc14-appacts">
          <button class="g14-btn" type="button" data-cc-app-open="${escapeHtml(m.id)}">打开</button>
          ${isRunning ? `<button class="g14-btn is-ghost" type="button" data-cc-app-close="${escapeHtml(m.id)}">关闭</button>` : ""}
          <button class="g14-btn is-ghost" type="button" data-cc-app-info="${escapeHtml(m.id)}">信息</button>
          <button class="g14-btn is-ghost" type="button" data-cc-app-un="${escapeHtml(m.id)}">卸载</button>
        </div>
      </div>`;
    })
    .join("");

  return `
    <div class="g14-scroll">
      <div class="g14-pane-head"><h3>应用管理</h3><p>已安装 ${installed.length} 个应用，正在运行 ${running.length} 个。</p></div>
      <div class="cc14-applist">${rows || `<p class="g14-hint">还没有安装应用。</p>`}</div>
      <p class="g14-hint">卸载不会删除应用数据；重新安装后内容还在。需要清理数据请到数据中心。</p>
    </div>`;
};

const view = () => (tab === "status" ? statusView() : tab === "apps" ? appsView() : quickView());

export const renderControl = () => {
  const nav: Array<[string, string, string]> = [
    ["quick", "快捷控制", "◐"],
    ["status", "系统状态", "▤"],
    ["apps", "应用管理", "▦"],
  ];
  return shell("control", nav, `<div class="cc14-host" data-cc-host></div>`, "控制中心");
};

export const initControl = (win: HTMLElement, ctx: Ctx, sys: Sys): (() => void) => {
  ctxRef = ctx;
  sysRef = sys;
  const host = win.querySelector<HTMLElement>("[data-cc-host]");
  if (!host) return () => undefined;

  const paint = () => {
    if (host) host.innerHTML = view();
  };

  win.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;

    const mode = t.closest<HTMLElement>("[data-cc-mode]");
    if (mode) {
      const light = mode.dataset.ccMode === "light";
      const cfg = (ctx.api13.cfg() as { appearance?: { accent?: string; accent2?: string } }).appearance ?? {};
      ctx.api13.applyLook({
        mode: light ? "light" : "dark",
        accent: cfg.accent,
        accent2: cfg.accent2,
        preset: "custom",
      });
      paint();
      return;
    }

    const tg = t.closest<HTMLElement>("[data-cc-toggle]");
    if (tg) {
      const key = tg.dataset.ccToggle ?? "";
      if (key === "animations") {
        const next = !readPrefs().animations;
        patchPrefs({ animations: next });
        document.body.classList.toggle("os-reduce-motion", !next);
        ctx.writeState({ reduceMotion: !next });
        ctx.toast(next ? "已开启动画" : "已关闭动画效果");
      }
      if (key === "dnd") {
        const next = !readPrefs().dnd;
        patchPrefs({ dnd: next });
        ctx.toast(next ? "已开启勿扰，通知不再弹出" : "已关闭勿扰");
      }
      if (key === "icons") {
        const icons = document.querySelector<HTMLElement>(".desk-icons");
        if (!icons) return;
        const show = icons.hidden;
        icons.hidden = !show;
        ctx.writeState({ showIcons: show });
        ctx.toast(show ? "已显示桌面图标" : "已隐藏桌面图标");
      }
      if (key === "dockhide") {
        const cfg = (ctx.api13.cfg() as { dock?: { autohide?: boolean } }).dock;
        ctx.api13.applyLook({ dock: { autohide: !cfg?.autohide }, preset: "custom" });
        ctx.toast(cfg?.autohide ? "程序坞已固定显示" : "程序坞已改为自动隐藏");
      }
      paint();
      return;
    }

    if (t.closest("[data-cc-nextwall]")) {
      ctx.api13.nextWallpaper();
      paint();
      return;
    }
    const open = t.closest<HTMLElement>("[data-cc-open]");
    if (open) {
      ctx.openApp(open.dataset.ccOpen ?? "");
      return;
    }
    if (t.closest("[data-cc-full]")) {
      if (document.fullscreenElement) void document.exitFullscreen?.();
      else void document.documentElement.requestFullscreen?.().catch(() => ctx.toast("浏览器拒绝了全屏请求"));
      window.setTimeout(paint, 300);
      return;
    }
    const close = t.closest<HTMLElement>("[data-cc-close]");
    if (close) {
      sys.closeApp(close.dataset.ccClose ?? "");
      window.setTimeout(paint, 260);
      return;
    }
    const appOpen = t.closest<HTMLElement>("[data-cc-app-open]");
    if (appOpen) {
      sys.open(appOpen.dataset.ccAppOpen ?? "");
      return;
    }
    const appClose = t.closest<HTMLElement>("[data-cc-app-close]");
    if (appClose) {
      sys.closeApp(appClose.dataset.ccAppClose ?? "");
      window.setTimeout(paint, 260);
      return;
    }
    const appInfo = t.closest<HTMLElement>("[data-cc-app-info]");
    if (appInfo) {
      ctx.openApp("appcenter");
      ctx.toast("在应用中心查看详情");
      return;
    }
    const appUn = t.closest<HTMLElement>("[data-cc-app-un]");
    if (appUn) {
      const id = appUn.dataset.ccAppUn ?? "";
      const meta = META_BY_ID[id];
      if (!meta) return;
      void modal(win, {
        title: `卸载「${meta.name}」？`,
        body: `<p class="g14-modal-text">会关闭窗口并移除入口，应用数据保留。可以在应用中心重新安装。</p>`,
        actions: [
          { label: "取消", value: "" },
          { label: "卸载", value: "ok", danger: true, primary: true },
        ],
      }).then((v) => {
        if (v === "ok") {
          sys.uninstall(id);
          paint();
        }
      });
    }
  });

  win.addEventListener("input", (e) => {
    const vol = (e.target as HTMLElement).closest<HTMLInputElement>("[data-cc-vol]");
    if (!vol) return;
    patchPrefs({ volume: Number(vol.value) });
    const label = win.querySelector<HTMLElement>("[data-cc-volnum]");
    if (label) label.textContent = `${vol.value}%`;
  });

  bindTabs(win, (next) => {
    tab = next;
    paint();
  });

  paint();
  return () => undefined;
};

export const controlSummary = () => ({
  installed: Object.keys(META_BY_ID).filter(isInstalled).length,
  workspaces: workspaceList().length,
  at: fmtDateTime(Date.now()),
});
