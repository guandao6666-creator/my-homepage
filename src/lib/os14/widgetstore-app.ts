/**
 * Guandao OS 1.4 · 组件中心窗口 UI（按需懒加载）
 *
 * 从 widgetstore.ts 拆分出来，只在用户打开「组件中心」窗口时下载。
 */
import { bindTabs, clamp, emptyState, escapeHtml, ls, shell } from "./core";
import {
  WIDGET_CATS,
  WIDGET_CFG_KEY,
  WIDGET_STATE_KEY,
  applyWidgetExtras,
  ensureWidgetList,
  getWidgetCtx,
  readWidgetCfg,
  widgetIcons,
  writeWidgetCfg,
} from "./widgetstore";

let galleryTab = "library";
let galleryCat = "all";

const galleryPreview = (id: string) => {
  switch (id) {
    case "photoframe":
      return `<div class="gp gp-photo"><i></i><span></span></div>`;
    case "countdown":
      return `<div class="gp gp-count"><b>12</b><span>天</span><i></i></div>`;
    case "focus":
      return `<div class="gp gp-focus"><div class="gp-ring"><b>25:00</b></div><i></i></div>`;
    case "musicmini":
      return `<div class="gp gp-music"><div class="gp-cover"></div><i></i><i class="is-short"></i><div class="gp-btns"><span>⏮</span><span>▶</span><span>⏭</span></div></div>`;
    case "quicknote":
      return `<div class="gp gp-note"><i></i><i></i><i class="is-short"></i></div>`;
    case "sysmon":
      return `<div class="gp gp-sys"><i></i><i></i><i></i><div class="gp-spark"><b></b><b></b><b></b><b></b><b></b></div></div>`;
    case "worldclock14":
      return `<div class="gp gp-world"><i></i><i></i><i></i><i></i></div>`;
    case "taskmini":
      return `<div class="gp gp-task"><i></i><i></i><i></i></div>`;
    case "clock":
      return `<div class="gp gp-clock"><b>19:51</b><span>11月3日 周二</span></div>`;
    case "calendar":
      return `<div class="gp gp-cal"><b>11</b><div class="gp-dots">${"<i></i>".repeat(12)}</div></div>`;
    case "weather":
      return `<div class="gp gp-weather"><span>☀</span><b>14°</b><i></i></div>`;
    case "todo":
      return `<div class="gp gp-task"><i></i><i></i><i></i></div>`;
    case "sys":
      return `<div class="gp gp-sys"><i></i><i></i><i></i></div>`;
    case "quote":
      return `<div class="gp gp-quote"><i></i><i class="is-short"></i><b>”</b></div>`;
    case "world":
      return `<div class="gp gp-world"><i></i><i></i><i></i><i></i></div>`;
    case "launch":
      return `<div class="gp gp-launch"><span></span><span></span><span></span><span></span></div>`;
    case "recent":
      return `<div class="gp gp-recent"><i></i><i></i><i></i></div>`;
    case "profile":
      return `<div class="gp gp-profile"><span>管</span><i></i><i class="is-short"></i></div>`;
    case "welcome":
      return `<div class="gp gp-hello"><b>晚上好</b><i></i></div>`;
    default:
      return `<div class="gp gp-generic"><span>▦</span></div>`;
  }
};

const widgetCard = (spec: { id: string; title: string; desc: string; category: string }) => {
  const on = getWidgetCtx()?.widgets.on(spec.id) ?? false;
  return `
    <article class="g14-wcard ${on ? "is-on" : ""}" data-widget-id="${escapeHtml(spec.id)}">
      <div class="g14-wprev">${galleryPreview(spec.id)}</div>
      <div class="g14-wmeta">
        <h4>${escapeHtml(spec.title)}</h4>
        <p>${escapeHtml(spec.desc)}</p>
        <div class="g14-wacts">
          <button class="g14-btn ${on ? "" : "is-primary"}" type="button" data-wtoggle="${escapeHtml(spec.id)}">${on ? "从桌面移除" : "添加到桌面"}</button>
        </div>
      </div>
    </article>`;
};

const libraryView = () => {
  const specs = ensureWidgetList().map((w) => ({
    id: w.id,
    title: w.title,
    desc: w.desc,
    category: w.category ?? widgetIcons[w.id]?.cat ?? "life",
  }));
  const items = galleryCat === "all" ? specs : specs.filter((s) => s.category === galleryCat);
  return `
    <div class="g14-scroll">
      <div class="g14-pane-head"><h3>组件库</h3><p>点一下就能加到桌面，位置可以随手拖。</p></div>
      <div class="g14-chip-row is-wrap">
        ${WIDGET_CATS.map((c) => `<button class="g14-chip ${galleryCat === c.id ? "is-active" : ""}" type="button" data-wcat="${c.id}">${escapeHtml(c.name)}</button>`).join("")}
      </div>
      ${items.length ? `<div class="g14-wgrid">${items.map(widgetCard).join("")}</div>` : emptyState("这个分类还没有组件", "换个分类看看。", "▦")}
    </div>`;
};

const desktopView = () => {
  const ctx = getWidgetCtx();
  const on = ensureWidgetList().filter((w) => ctx?.widgets.on(w.id));
  const off = ensureWidgetList().filter((w) => !ctx?.widgets.on(w.id));
  return `
    <div class="g14-scroll">
      <div class="g14-pane-head"><h3>我的桌面</h3><p>已添加 ${on.length} 个组件。手机上放不下的会自动收起。</p></div>
      ${
        on.length
          ? `<div class="g14-wlist">${on
              .map(
                (w) => `<div class="g14-wrow">
                  <span class="g14-wrow-ico">${widgetIcons[w.id]?.ico ?? "▦"}</span>
                  <div><b>${escapeHtml(w.title)}</b><span>${escapeHtml(w.desc)}</span></div>
                  <button class="g14-btn is-ghost" type="button" data-wtoggle="${escapeHtml(w.id)}">移除</button>
                </div>`,
              )
              .join("")}</div>`
          : emptyState("桌面还没有组件", "去组件库挑几个。", "▦")
      }
      <h3 class="g14-sub-h">未添加</h3>
      ${
        off.length
          ? `<div class="g14-wlist">${off
              .map(
                (w) => `<div class="g14-wrow">
                  <span class="g14-wrow-ico">${widgetIcons[w.id]?.ico ?? "▦"}</span>
                  <div><b>${escapeHtml(w.title)}</b><span>${escapeHtml(w.desc)}</span></div>
                  <button class="g14-btn" type="button" data-wtoggle="${escapeHtml(w.id)}">添加</button>
                </div>`,
              )
              .join("")}</div>`
          : `<p class="g14-hint">全部都添加了。</p>`
      }
    </div>`;
};

const layoutView = () => {
  const ctx = getWidgetCtx();
  const cfg = readWidgetCfg();
  const on = ensureWidgetList().filter((w) => ctx?.widgets.on(w.id));
  return `
    <div class="g14-scroll">
      <div class="g14-pane-head"><h3>布局</h3><p>调整尺寸、透明度与层级，布局会自动保存。</p></div>
      ${
        on.length
          ? `<div class="g14-layout">${on
              .map((w) => {
                const st = ctx?.widgets.state()[w.id] ?? {};
                const size = st.size ?? "m";
                const op = cfg.opacity[w.id] ?? 1;
                const locked = Boolean(cfg.locked[w.id]);
                return `<div class="g14-lrow" data-lrow="${escapeHtml(w.id)}">
                  <div class="g14-ltop">
                    <b>${escapeHtml(w.title)}</b>
                    <div class="g14-seg" data-wsize="${escapeHtml(w.id)}">
                      ${(["s", "m", "l"] as const)
                        .map((s) => `<button type="button" data-size="${s}" class="${size === s ? "is-active" : ""}">${s === "s" ? "小" : s === "m" ? "中" : "大"}</button>`)
                        .join("")}
                    </div>
                  </div>
                  <label class="g14-range-row"><span>不透明度</span><input type="range" min="20" max="100" value="${Math.round(op * 100)}" data-wop="${escapeHtml(w.id)}"/><b>${Math.round(op * 100)}%</b></label>
                  <div class="g14-lacts">
                    <button class="g14-btn ${locked ? "is-primary" : ""}" type="button" data-wlock="${escapeHtml(w.id)}">${locked ? "已锁定" : "锁定位置"}</button>
                    <button class="g14-btn is-ghost" type="button" data-wlayer="${escapeHtml(w.id)}|up">上移一层</button>
                    <button class="g14-btn is-ghost" type="button" data-wlayer="${escapeHtml(w.id)}|down">下移一层</button>
                    <button class="g14-btn is-ghost" type="button" data-wtoggle="${escapeHtml(w.id)}">移除</button>
                  </div>
                </div>`;
              })
              .join("")}</div>`
          : emptyState("没有可调整的组件", "先到组件库添加一个。", "▦")
      }
      <div class="g14-io-bar"><button class="g14-btn is-ghost" type="button" data-wreset>恢复默认布局</button></div>
    </div>`;
};

const view = () => (galleryTab === "desktop" ? desktopView() : galleryTab === "layout" ? layoutView() : libraryView());

export const renderWidgetGallery = () => {
  const nav: Array<[string, string, string]> = [
    ["library", "组件库", "▦"],
    ["desktop", "我的桌面", "▤"],
    ["layout", "布局", "⇕"],
  ];
  return shell("widgetstore", nav, `<div class="g14-whost" data-whost></div>`, "组件中心");
};

const patchWidgetState = (id: string, patch: Record<string, unknown>) => {
  const all = ls.get<Record<string, Record<string, unknown>>>(WIDGET_STATE_KEY, {});
  all[id] = { ...all[id], ...patch };
  ls.set(WIDGET_STATE_KEY, all);
};

export const initWidgetGallery = (win: HTMLElement): (() => void) => {
  const host = win.querySelector<HTMLElement>("[data-whost]");
  if (!host) return () => undefined;

  const paint = () => {
    host.innerHTML = view();
  };

  const toggle = (id: string) => {
    const ctx = getWidgetCtx();
    if (!ctx) return;
    const on = ctx.widgets.on(id);
    ctx.widgets.setEnabled(id, !on);
    ctx.toast(on ? "已从桌面移除" : "已添加到桌面");
    paint();
  };

  win.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const tg = t.closest<HTMLElement>("[data-wtoggle]");
    if (tg) {
      toggle(tg.dataset.wtoggle ?? "");
      return;
    }
    const cat = t.closest<HTMLElement>("[data-wcat]");
    if (cat) {
      galleryCat = cat.dataset.wcat ?? "all";
      paint();
      return;
    }
    const size = t.closest<HTMLElement>("[data-wsize] [data-size]");
    if (size) {
      const id = size.closest<HTMLElement>("[data-wsize]")?.dataset.wsize ?? "";
      patchWidgetState(id, { size: size.dataset.size });
      getWidgetCtx()?.widgets.render(id);
      window.setTimeout(paint, 60);
      return;
    }
    const lock = t.closest<HTMLElement>("[data-wlock]");
    if (lock) {
      const id = lock.dataset.wlock ?? "";
      const cfg = readWidgetCfg();
      cfg.locked[id] = !cfg.locked[id];
      writeWidgetCfg(cfg);
      applyWidgetExtras();
      paint();
      return;
    }
    const layer = t.closest<HTMLElement>("[data-wlayer]");
    if (layer) {
      const [id, dir] = (layer.dataset.wlayer ?? "").split("|");
      const cfg = readWidgetCfg();
      const cur = cfg.z[id] ?? 20;
      cfg.z[id] = dir === "up" ? cur + 2 : Math.max(1, cur - 2);
      writeWidgetCfg(cfg);
      applyWidgetExtras();
      paint();
      return;
    }
    if (t.closest("[data-wreset]")) {
      ls.del(WIDGET_CFG_KEY);
      const all = ls.get<Record<string, Record<string, unknown>>>(WIDGET_STATE_KEY, {});
      for (const id of Object.keys(all)) {
        if (all[id]?.x != null || all[id]?.y != null || all[id]?.size) {
          all[id] = { enabled: all[id].enabled };
        }
      }
      ls.set(WIDGET_STATE_KEY, all);
      getWidgetCtx()?.widgets.renderAll();
      applyWidgetExtras();
      paint();
      return;
    }
  });

  win.addEventListener("input", (e) => {
    const input = (e.target as HTMLElement).closest<HTMLInputElement>("[data-wop]");
    if (!input) return;
    const id = input.dataset.wop ?? "";
    const cfg = readWidgetCfg();
    cfg.opacity[id] = clamp(Number(input.value) / 100, 0.2, 1);
    writeWidgetCfg(cfg);
    applyWidgetExtras();
    const label = input.parentElement?.querySelector("b");
    if (label) label.textContent = `${input.value}%`;
  });

  bindTabs(win, (tab) => {
    galleryTab = tab;
    paint();
  });

  paint();
  return () => undefined;
};
