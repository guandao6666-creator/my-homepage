/**
 * Guandao OS 1.3 · 个性化设置 2.0 窗口 UI（按需懒加载）
 *
 * 从 src/lib/os13.ts 拆分出 600 余行面板渲染与事件绑定代码，
 * 仅在用户打开「设置 / 个性化」窗口时按需下载，显著降低首屏入口 JS 体积。
 */
import { wallCardHtml } from "./os13/wall-card";
import { WALLPAPERS, WALL_CATEGORY_LABEL, type Wallpaper } from "./wallpapers";
import { EXPORT_FORMAT, OS_VERSION, RELEASE_NAME } from "./version";
import type { Os13Context } from "./os13";

export type Os13Preset = {
  id: string;
  name: string;
  en: string;
  swatch: [string, string];
};

export type Os13SettingsCfg = {
  v: number;
  preset: string;
  appearance: {
    mode: "dark" | "light";
    material: "glass" | "frost" | "solid";
    radius: "soft" | "round" | "sharp";
    accent: string;
    accent2: string;
    autoAccent: boolean;
  };
  wall: {
    id: string;
    fit: "cover" | "contain" | "center";
    blur: number;
    darken: number;
    saturate: number;
    auto: "off" | "daily" | "hourly" | "random" | "slideshow";
    slideshow: number;
    favorites: string[];
    last: number;
    kenburns: boolean;
    parallax: boolean;
  };
  dock: {
    pos: "bottom" | "left" | "right";
    size: number;
    magnify: number;
    opacity: number;
    autohide: boolean;
    indicators: boolean;
    running: boolean;
  };
  icons: {
    mode: "grid" | "free";
    size: number;
    label: number;
    gap: number;
    show: boolean;
    order: string[];
    pos: Record<string, { x: number; y: number }>;
    hidden: string[];
  };
  widgets: { opacity: number; locked: boolean };
  motion: { reduce: boolean; particles: boolean; parallax?: boolean };
  custom: Array<{ id: string; name: string; accent: string; accent2?: string; at: number; bytes: number; lum?: number }>;
};

export type Os13SettingsBridge = {
  ctx: Os13Context;
  getCfg: () => Os13SettingsCfg;
  setCfg: (next: Os13SettingsCfg) => void;
  defaults: Os13SettingsCfg;
  presets: Os13Preset[];
  objUrls: Map<string, string>;
  getTab: () => string;
  setTab: (tab: string) => void;
  save: () => void;
  applyAll: () => void;
  applyAccent: () => void;
  applyMode: (mode: "dark" | "light") => void;
  applyPreset: (id: string) => void;
  applyIcons: () => void;
  applyIconLayout: () => void;
  applyWidgets: () => void;
  arrangeIcons: (by: "grid" | "name") => void;
  setWallpaper: (id: string) => void;
  importWallpaper: (file: File) => Promise<unknown>;
  removeCustom: (id: string) => Promise<void>;
  pushToast: (msg: string) => void;
  clearIdb: () => Promise<void>;
  deepMerge: <T>(base: T, patch: unknown) => T;
  getPath: (obj: unknown, path: string) => unknown;
  setPath: (obj: Record<string, unknown>, path: string, value: unknown) => void;
};

const TABS: Array<[string, string, string]> = [
  ["desktop", "桌面", "▤"],
  ["wallpaper", "壁纸", "◧"],
  ["appearance", "外观", "◐"],
  ["color", "颜色", "◉"],
  ["dock", "程序坞", "▱"],
  ["widgets", "桌面组件", "▦"],
  ["icons", "图标", "◇"],
  ["motion", "动画", "≈"],
  ["screen", "屏幕与布局", "▭"],
  ["system", "系统", "ⓘ"],
];

const SWATCHES = ["#6f8cff", "#22c3e6", "#4fbf9a", "#f08a5d", "#c87758", "#a78bfa", "#e879b9", "#e6b878", "#9aa4b2"];

const qs = <T extends Element = HTMLElement>(root: ParentNode, sel: string) => root.querySelector<T>(sel);
const qsa = <T extends Element = HTMLElement>(root: ParentNode, sel: string) => Array.from(root.querySelectorAll<T>(sel));

const suffixOf = (k: string) => {
  if (k.includes("magnify")) return "×";
  if (k.includes("slideshow")) return " 分钟";
  if (k.endsWith(".accent") || k.endsWith(".accent2")) return "";
  if (k.includes("size") || k.includes("label") || k.includes("blur")) return "px";
  return "%";
};

export function mountOs13Settings(
  win: HTMLElement,
  bridge: Os13SettingsBridge,
): { sync: () => void; renderGallery: (cat?: string) => void } {
  const { ctx, defaults, presets, objUrls, getPath, setPath } = bridge;

  const slider = (k: string, min: number, max: number, step: number, suffix = "%") => {
    const v = Number(getPath(bridge.getCfg(), k) ?? 0);
    return `<label class="s-row"><span>${""}</span><input type="range" data-k="${k}" min="${min}" max="${max}" step="${step}" value="${v}" /><b data-out="${k}">${v}${suffix}</b></label>`;
  };

  const toggleRow = (k: string, label: string, hint = "") => {
    const v = Boolean(getPath(bridge.getCfg(), k));
    return `<label class="s-row s-toggle"><span class="s-label">${label}${hint ? `<i>${hint}</i>` : ""}</span>
      <input type="checkbox" data-k="${k}" data-kind="bool" ${v ? "checked" : ""} /><i class="s-switch"></i></label>`;
  };

  const segRow = (k: string, label: string, opts: Array<[string, string]>) => {
    const v = String(getPath(bridge.getCfg(), k) ?? "");
    return `<div class="s-row s-seg-row"><span class="s-label">${label}</span><div class="s-seg" data-seg="${k}">
      ${opts.map(([val, text]) => `<button type="button" class="${v === val ? "is-active" : ""}" data-val="${val}">${text}</button>`).join("")}
    </div></div>`;
  };

  const panelDesktop = () => `
    <section class="s-panel" data-panel="desktop">
      <h2>桌面布局</h2>
      <p class="s-sub">图标可以按网格排满，也可以像真实桌面一样随手摆放。</p>
      <div class="s-card">
        ${segRow("icons.mode", "排列方式", [["grid", "网格"], ["free", "自由"]])}
        ${slider("icons.size", 34, 64, 2, "px").replace("<span></span>", `<span class="s-label">图标大小</span>`)}
        ${slider("icons.label", 9, 15, 0.5, "px").replace("<span></span>", `<span class="s-label">文字大小</span>`)}
        ${slider("icons.gap", 6, 28, 1, "px").replace("<span></span>", `<span class="s-label">网格间距</span>`)}
        ${toggleRow("icons.show", "显示桌面图标", "关掉后只剩壁纸、组件和程序坞")}
      </div>
      <div class="s-actions">
        <button class="s-btn" type="button" data-act="arrange-grid">自动排列</button>
        <button class="s-btn" type="button" data-act="arrange-name">按名称整理</button>
        <button class="s-btn" type="button" data-act="reset-icons">恢复默认布局</button>
      </div>
      <p class="s-tip">自由模式下拖动图标即可改位置，位置会自动保存；网格模式下拖动可以换顺序。</p>
    </section>`;

  const panelWallpaper = () => `
    <section class="s-panel" data-panel="wallpaper">
      <div class="s-head">
        <div>
          <h2>壁纸</h2>
          <p class="s-sub">24 张本地壁纸，全部随项目一起分发，不依赖远程图源。</p>
        </div>
        <button class="s-btn s-btn--accent" type="button" data-act="upload-wall">上传图片</button>
      </div>
      <div class="wall-cats" id="wall-cats">
        ${["all", "nature", "city", "abstract", "guandao", "custom"]
          .map(
            (c, i) =>
              `<button type="button" class="${i === 0 ? "is-active" : ""}" data-cat="${c}">${c === "all" ? "全部" : c === "custom" ? "自定义" : WALL_CATEGORY_LABEL[c as keyof typeof WALL_CATEGORY_LABEL]}</button>`,
          )
          .join("")}
      </div>
      <div class="wall-grid" id="wall-grid"></div>
      <div class="s-card">
        ${segRow("wall.fit", "显示方式", [["cover", "填充"], ["contain", "适应"], ["center", "居中"]])}
        ${slider("wall.darken", 0, 70, 1, "%").replace("<span></span>", `<span class="s-label">暗化程度</span>`)}
        ${slider("wall.blur", 0, 18, 1, "px").replace("<span></span>", `<span class="s-label">背景模糊</span>`)}
        ${slider("wall.saturate", 60, 140, 1, "%").replace("<span></span>", `<span class="s-label">色彩浓度</span>`)}
      </div>
      <div class="s-card">
        ${segRow("wall.auto", "自动更换", [["off", "关闭"], ["daily", "每天"], ["hourly", "每小时"], ["random", "随机"], ["slideshow", "轮播"]])}
        ${slider("wall.slideshow", 5, 120, 5, " 分钟").replace("<span></span>", `<span class="s-label">轮播间隔</span>`)}
        <p class="s-tip s-tip--inline">自动更换只从「收藏」里挑；没有收藏时使用全部壁纸。刷新页面不会丢失。</p>
      </div>
      <div class="s-card">
        ${toggleRow("wall.kenburns", "壁纸缓慢呼吸", "极慢的缩放，几乎不耗性能")}
        ${toggleRow("wall.parallax", "鼠标视差", "指针移动时壁纸轻微位移")}
      </div>
    </section>`;

  const panelAppearance = () => {
    const cfg = bridge.getCfg();
    return `
    <section class="s-panel" data-panel="appearance">
      <h2>外观</h2>
      <p class="s-sub">主题是一整套组合：壁纸、强调色、材质、圆角与程序坞一起变化。</p>
      <div class="preset-grid">
        ${presets
          .map(
            (p) => `<button class="preset ${cfg.preset === p.id ? "is-active" : ""}" type="button" data-preset="${p.id}" style="--pa:${p.swatch[1]};--pb:${p.swatch[0]}">
            <span class="preset-swatch"><i></i></span>
            <span class="preset-name">${p.name}<i>${p.en}</i></span>
          </button>`,
          )
          .join("")}
      </div>
      <div class="s-card">
        ${segRow("appearance.mode", "明暗", [["dark", "深色"], ["light", "浅色"]])}
        ${segRow("appearance.material", "窗口材质", [["glass", "玻璃"], ["frost", "磨砂"], ["solid", "实色"]])}
        ${segRow("appearance.radius", "圆角", [["soft", "克制"], ["round", "圆润"], ["sharp", "锐利"]])}
      </div>
      <p class="s-tip">材质区别：玻璃透出壁纸颜色，磨砂只保留模糊，实色完全不透明。低配设备建议选实色以获得最高帧率。</p>
    </section>`;
  };

  const panelColor = () => {
    const cfg = bridge.getCfg();
    return `
    <section class="s-panel" data-panel="color">
      <h2>颜色</h2>
      <p class="s-sub">默认跟随壁纸取色；也可以锁定一组自己的强调色。</p>
      <div class="s-card">
        ${toggleRow("appearance.autoAccent", "跟随壁纸自动取色", "切换壁纸时同步更新强调色")}
        <div class="s-row"><span class="s-label">强调色</span>
          <div class="color-pick">
            <input type="color" data-k="appearance.accent" data-kind="color" value="${cfg.appearance.accent}" />
            <code data-out="appearance.accent">${cfg.appearance.accent}</code>
          </div>
        </div>
        <div class="s-row"><span class="s-label">辅助色</span>
          <div class="color-pick">
            <input type="color" data-k="appearance.accent2" data-kind="color" value="${cfg.appearance.accent2}" />
            <code data-out="appearance.accent2">${cfg.appearance.accent2}</code>
          </div>
        </div>
        <div class="s-swatches">
          ${SWATCHES.map((c) => `<button type="button" style="--sw:${c}" data-swatch="${c}" aria-label="${c}"></button>`).join("")}
        </div>
      </div>
      <div class="color-preview">
        <div class="cp-card"><b>卡片标题</b><span>次级文字与说明</span><button type="button">主要按钮</button><button class="ghost" type="button">次要</button></div>
      </div>
    </section>`;
  };

  const panelDock = () => `
    <section class="s-panel" data-panel="dock">
      <h2>程序坞</h2>
      <p class="s-sub">位置、尺寸、放大倍率、透明度都可以调；右键图标可以固定或取消固定。</p>
      <div class="dock-demo"><div class="dock-demo-bar"><i></i><i></i><i></i><i></i><i></i></div></div>
      <div class="s-card">
        ${segRow("dock.pos", "位置", [["bottom", "底部"], ["left", "左侧"], ["right", "右侧"]])}
        ${slider("dock.size", 36, 64, 2, "px").replace("<span></span>", `<span class="s-label">图标大小</span>`)}
        ${slider("dock.magnify", 1, 2, 0.05, "×").replace("<span></span>", `<span class="s-label">悬停放大</span>`)}
        ${slider("dock.opacity", 30, 95, 1, "%").replace("<span></span>", `<span class="s-label">背景不透明度</span>`)}
        ${toggleRow("dock.autohide", "自动隐藏", "鼠标靠近屏幕边缘时出现")}
        ${toggleRow("dock.indicators", "显示运行指示点")}
        ${toggleRow("dock.running", "在程序坞显示运行中的应用")}
      </div>
      <p class="s-tip">提示：程序坞高度会随图标大小变化，窗口与桌面组件会自动避开它的位置。</p>
    </section>`;

  const panelWidgets = () => `
    <section class="s-panel" data-panel="widgets">
      <h2>桌面组件</h2>
      <p class="s-sub">组件可以拖动、调整尺寸、改透明度，也可以锁定位置避免误碰。</p>
      <div class="s-card">
        ${slider("widgets.opacity", 35, 100, 1, "%").replace("<span></span>", `<span class="s-label">整体不透明度</span>`)}
        ${toggleRow("widgets.locked", "锁定组件位置", "锁定后拖动不会移动")}
      </div>
      <div class="s-widget-list">
        ${ctx.widgets.ids
          .map(
            (id) => `<div class="s-widget-row ${ctx.widgets.on(id) ? "is-on" : ""}" data-widget-row="${id}">
              <span class="sw-name">${ctx.widgets.titles[id]}<i>${ctx.widgets.desc[id] ?? ""}</i></span>
              <div class="sw-sizes" role="group" aria-label="尺寸">
                ${(["s", "m", "l"] as const)
                  .map((s) => `<button type="button" data-wsize="${s}" data-wid="${id}" class="${(ctx.widgets.read()[id]?.size ?? "m") === s ? "is-active" : ""}">${s.toUpperCase()}</button>`)
                  .join("")}
              </div>
              <button class="s-switch sw-toggle" type="button" data-wtoggle="${id}" aria-pressed="${ctx.widgets.on(id)}"><i></i></button>
            </div>`,
          )
          .join("")}
      </div>
      <div class="s-card">
        <div class="s-row s-seg-row"><span class="s-label">时钟样式</span>
          <div class="s-seg" data-clock-style>
            <button type="button" data-clock-val="digital">数字</button>
            <button type="button" data-clock-val="large">大号</button>
            <button type="button" data-clock-val="analog">指针</button>
          </div>
        </div>
        <p class="s-tip s-tip--inline">指针样式每秒刷新一次，只改旋转角度。</p>
      </div>
      <div class="s-actions">
        <button class="s-btn" type="button" data-act="reset-widgets">恢复默认布局</button>
      </div>
    </section>`;

  const panelIcons = () => `
    <section class="s-panel" data-panel="icons">
      <h2>图标</h2>
      <p class="s-sub">统一为圆角方形底 + 精细图形，尺寸与字号独立可调。</p>
      <div class="icon-demo">
        <span class="di-glyph di-folder"></span>
        <span class="di-glyph di-term"></span>
        <span class="di-glyph di-note"></span>
        <span class="di-glyph di-cal"></span>
      </div>
      <div class="s-card">
        ${slider("icons.size", 34, 64, 2, "px").replace("<span></span>", `<span class="s-label">图标大小</span>`)}
        ${slider("icons.label", 9, 15, 0.5, "px").replace("<span></span>", `<span class="s-label">文字大小</span>`)}
        ${toggleRow("icons.show", "显示桌面图标")}
      </div>
      <p class="s-tip">隐藏的图标可以在桌面右键菜单里一次性恢复。</p>
    </section>`;

  const panelMotion = () => `
    <section class="s-panel" data-panel="motion">
      <h2>动画</h2>
      <p class="s-sub">所有动效都优先使用 transform / opacity，并且可以整体关闭。</p>
      <div class="s-card">
        ${toggleRow("motion.reduce", "减少动态效果", "同时遵循系统的「减少动态效果」偏好")}
        ${toggleRow("wall.parallax", "桌面视差")}
        ${toggleRow("wall.kenburns", "壁纸缓慢呼吸")}
        ${toggleRow("motion.particles", "背景微尘粒子", "默认关闭；开启后约 30 个粒子，几乎不占 CPU")}
      </div>
      <div class="s-card">
        ${segRow("appearance.material", "材质（性能）", [["glass", "玻璃 · 最佳观感"], ["frost", "磨砂 · 均衡"], ["solid", "实色 · 最省性能"]])}
      </div>
    </section>`;

  const panelScreen = () => `
    <section class="s-panel" data-panel="screen">
      <h2>屏幕与布局</h2>
      <p class="s-sub">当前视口 ${window.innerWidth} × ${window.innerHeight} · DPR ${(window.devicePixelRatio || 1).toFixed(2)}</p>
      <div class="s-card">
        ${toggleRow("dock.autohide", "程序坞自动隐藏", "小屏幕上给窗口留更多空间")}
        ${toggleRow("icons.show", "显示桌面图标")}
        ${segRow("wall.fit", "壁纸适配", [["cover", "填充"], ["contain", "适应"], ["center", "居中"]])}
      </div>
      <div class="s-actions">
        <button class="s-btn" type="button" data-act="fullscreen">进入 / 退出全屏</button>
        <button class="s-btn" type="button" data-act="relayout">重新计算布局</button>
        <button class="s-btn" type="button" data-act="reset-desktop">恢复默认桌面</button>
      </div>
      <p class="s-tip">手机端会自动降低动效并收起部分卡片；「桌面模式」开关仍在菜单栏右侧。</p>
    </section>`;

  const panelSystem = () => {
    const cfg = bridge.getCfg();
    let bytes = 0;
    let count = 0;
    try {
      for (let i = 0; i < localStorage.length; i += 1) {
        const k = localStorage.key(i) ?? "";
        if (k.startsWith("guandao.")) {
          bytes += (localStorage.getItem(k) ?? "").length;
          count += 1;
        }
      }
    } catch {
      /* 忽略 */
    }
    const customBytes = cfg.custom.reduce((a, c) => a + c.bytes, 0);
    return `
    <section class="s-panel" data-panel="system">
      <h2>系统</h2>
      <p class="s-sub">Guandao OS ${OS_VERSION} · ${RELEASE_NAME}</p>
      <div class="s-card s-info">
        <div><span>版本</span><b>${OS_VERSION}</b></div>
        <div><span>代号</span><b>${RELEASE_NAME}</b></div>
        <div><span>壁纸</span><b>${WALLPAPERS.length} 张本地资源 + ${cfg.custom.length} 张自定义</b></div>
        <div><span>本地数据</span><b>${(bytes / 1024).toFixed(1)} KB · ${count} 项</b></div>
        <div><span>自定义壁纸</span><b>${(customBytes / 1024 / 1024).toFixed(2)} MB（IndexedDB）</b></div>
        <div><span>渲染</span><b>Astro 静态 · Cloudflare Worker</b></div>
      </div>
      <div class="s-actions">
        <button class="s-btn" type="button" data-act="export">导出备份</button>
        <button class="s-btn is-danger" type="button" data-act="reset-all">清空本机数据</button>
      </div>
      <p class="s-tip">自定义壁纸存在 IndexedDB 中，导出备份只包含设置与元数据，不包含大图。</p>
      <div class="s-credit">
        <b>素材来源</b>
        <p>全部壁纸由项目内图像生成流程产出，已裁去生成标记并压缩为 WebP；不引用第三方图床，无外部许可风险。</p>
      </div>
    </section>`;
  };

  const renderSettings = () => `
    <div class="settings13">
      <aside class="s13-side">
        <div class="s13-id">
          <span class="s13-mark">管</span>
          <span><b>个性化</b><i>Guandao OS ${OS_VERSION}</i></span>
        </div>
        <nav class="s13-tabs">
          ${TABS.map(([id, name, ico]) => `<button type="button" class="${bridge.getTab() === id ? "is-active" : ""}" data-tab="${id}"><span>${ico}</span>${name}</button>`).join("")}
        </nav>
        <p class="s13-foot">设置实时生效并自动保存</p>
      </aside>
      <div class="s13-main">
        ${panelDesktop()}
        ${panelWallpaper()}
        ${panelAppearance()}
        ${panelColor()}
        ${panelDock()}
        ${panelWidgets()}
        ${panelIcons()}
        ${panelMotion()}
        ${panelScreen()}
        ${panelSystem()}
      </div>
    </div>`;

  const renderWallGallery = () => {
    const grid = win.querySelector<HTMLElement>("#wall-grid");
    if (!grid) return;
    const cfg = bridge.getCfg();
    const cat = grid.dataset.cat ?? "all";
    const list: Array<Wallpaper | { id: string; name: string; thumb: string; cat: string; custom: true }> = [
      ...WALLPAPERS,
      ...cfg.custom.map((c) => ({ id: c.id, name: c.name, thumb: "", cat: "custom", custom: true as const })),
    ];
    const filtered = list.filter((w) => cat === "all" || w.cat === cat);
    grid.innerHTML = filtered
      .map((w) => {
        const custom = "custom" in w;
        return wallCardHtml(
          {
            id: w.id,
            name: w.name,
            thumb: custom ? objUrls.get(w.id) ?? "" : (w as Wallpaper).thumb,
            custom,
          },
          { active: cfg.wall.id === w.id, favorite: cfg.wall.favorites.includes(w.id) },
        );
      })
      .join("");
    grid.dataset.cat = cat;
  };

  const syncSettings = () => {
    const cfg = bridge.getCfg();
    const currentTab = bridge.getTab();
    qsa<HTMLElement>(win, ".s13-tabs [data-tab]").forEach((b) => b.classList.toggle("is-active", b.dataset.tab === currentTab));
    qsa<HTMLElement>(win, ".s-panel").forEach((p) => {
      p.hidden = p.dataset.panel !== currentTab;
    });
    qsa<HTMLInputElement>(win, "input[data-k]").forEach((input) => {
      const v = getPath(cfg, input.dataset.k ?? "");
      if (input.type === "checkbox") input.checked = Boolean(v);
      else input.value = String(v ?? "");
      const out = win.querySelector<HTMLElement>(`[data-out="${input.dataset.k}"]`);
      if (out) out.textContent = `${input.value}${suffixOf(input.dataset.k ?? "")}`;
    });
    qsa<HTMLElement>(win, ".s-seg").forEach((seg) => {
      const v = String(getPath(cfg, seg.dataset.seg ?? "") ?? "");
      qsa<HTMLElement>(seg, "button").forEach((b) => b.classList.toggle("is-active", b.dataset.val === v));
    });
    qsa<HTMLElement>(win, ".preset").forEach((p) => p.classList.toggle("is-active", p.dataset.preset === cfg.preset));
    qsa<HTMLElement>(win, ".s-widget-row").forEach((row) => {
      const id = row.dataset.widgetRow ?? "";
      row.classList.toggle("is-on", ctx.widgets.on(id));
      const btn = row.querySelector<HTMLElement>("[data-wtoggle]");
      btn?.setAttribute("aria-pressed", String(ctx.widgets.on(id)));
      const size = ctx.widgets.read()[id]?.size ?? "m";
      qsa<HTMLElement>(row, "[data-wsize]").forEach((b) => b.classList.toggle("is-active", b.dataset.wsize === size));
    });
    const clockStyle = ctx.widgets.read().clock?.style ?? "digital";
    qsa<HTMLElement>(win, "[data-clock-val]").forEach((b) => b.classList.toggle("is-active", b.dataset.clockVal === clockStyle));
    renderWallGallery();
  };

  const bindSettings = () => {
    if (win.dataset.s13bound === "1") return;
    win.dataset.s13bound = "1";

    win.addEventListener("click", (e) => {
      const t = e.target as HTMLElement;
      const cfg = bridge.getCfg();

      const tab = t.closest<HTMLElement>("[data-tab]")?.dataset.tab;
      if (tab) {
        bridge.setTab(tab);
        syncSettings();
        return;
      }

      const preset = t.closest<HTMLElement>("[data-preset]")?.dataset.preset;
      if (preset) {
        bridge.applyPreset(preset);
        return;
      }

      const segBtn = t.closest<HTMLElement>(".s-seg button");
      if (segBtn) {
        const seg = segBtn.closest<HTMLElement>(".s-seg");
        const k = seg?.dataset.seg ?? "";
        const val = segBtn.dataset.val ?? "";
        setPath(cfg as unknown as Record<string, unknown>, k, val);
        const isNum = ["dock.size", "dock.magnify", "dock.opacity"].includes(k);
        if (isNum) setPath(cfg as unknown as Record<string, unknown>, k, Number(val));
        bridge.applyAll();
        bridge.save();
        syncSettings();
        return;
      }

      const wallId = t.closest<HTMLElement>("[data-wall-id]")?.dataset.wallId;
      const favId = t.closest<HTMLElement>("[data-fav]")?.dataset.fav;
      const delId = t.closest<HTMLElement>("[data-del]")?.dataset.del;

      if (favId) {
        cfg.wall.favorites = cfg.wall.favorites.includes(favId)
          ? cfg.wall.favorites.filter((x) => x !== favId)
          : [...cfg.wall.favorites, favId];
        bridge.save();
        renderWallGallery();
        return;
      }

      if (delId) {
        void bridge.removeCustom(delId);
        return;
      }

      if (wallId) {
        bridge.setWallpaper(wallId);
        syncSettings();
        return;
      }

      const cat = t.closest<HTMLElement>("[data-cat]")?.dataset.cat;
      if (cat) {
        qsa<HTMLElement>(win, "#wall-cats [data-cat]").forEach((b) => b.classList.toggle("is-active", b.dataset.cat === cat));
        const grid = win.querySelector<HTMLElement>("#wall-grid");
        if (grid) grid.dataset.cat = cat;
        renderWallGallery();
        return;
      }

      const swatch = t.closest<HTMLElement>("[data-swatch]")?.dataset.swatch;
      if (swatch) {
        cfg.appearance.autoAccent = false;
        cfg.appearance.accent = swatch;
        bridge.applyAccent();
        bridge.save();
        syncSettings();
        return;
      }

      const wToggle = t.closest<HTMLElement>("[data-wtoggle]")?.dataset.wtoggle;
      if (wToggle) {
        ctx.widgets.setEnabled(wToggle, !ctx.widgets.on(wToggle));
        syncSettings();
        return;
      }

      const clockStyle = (t.closest<HTMLElement>("[data-clock-val]") as HTMLElement | null)?.dataset.clockVal;
      if (clockStyle) {
        const all = ctx.widgets.read();
        all.clock = { ...all.clock, style: clockStyle };
        ctx.widgets.write(all);
        ctx.widgets.renderAll();
        syncSettings();
        return;
      }

      const wSize = t.closest<HTMLElement>("[data-wsize]") as HTMLElement | null;
      if (wSize) {
        const id = wSize.dataset.wid ?? "";
        const all = ctx.widgets.read();
        all[id] = { ...all[id], size: wSize.dataset.wsize as "s" | "m" | "l" };
        ctx.widgets.write(all);
        ctx.widgets.renderAll();
        syncSettings();
        return;
      }

      const act = t.closest<HTMLElement>("[data-act]")?.dataset.act;
      if (!act) return;
      switch (act) {
        case "arrange-grid":
          bridge.arrangeIcons("grid");
          break;
        case "arrange-name":
          bridge.arrangeIcons("name");
          break;
        case "reset-icons":
          cfg.icons = bridge.deepMerge(defaults.icons, { hidden: [] });
          bridge.applyIcons();
          bridge.save();
          break;
        case "upload-wall": {
          const input = document.createElement("input");
          input.type = "file";
          input.accept = "image/jpeg,image/png,image/webp";
          input.onchange = () => {
            const f = input.files?.[0];
            if (f) void bridge.importWallpaper(f);
          };
          input.click();
          break;
        }
        case "reset-widgets": {
          ctx.widgets.write({});
          ctx.widgets.renderAll();
          cfg.widgets = { ...defaults.widgets };
          bridge.applyWidgets();
          bridge.save();
          syncSettings();
          bridge.pushToast("组件已恢复默认布局");
          break;
        }
        case "fullscreen":
          if (!document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => undefined);
          else document.exitFullscreen?.().catch(() => undefined);
          break;
        case "relayout":
          bridge.applyIconLayout();
          ctx.widgets.stack();
          bridge.pushToast("布局已重新计算");
          break;
        case "reset-desktop": {
          const next = bridge.deepMerge(defaults, { appearance: cfg.appearance });
          bridge.setCfg(next);
          bridge.save();
          bridge.applyAll();
          bridge.setWallpaper(defaults.wall.id);
          ctx.widgets.write({});
          ctx.widgets.renderAll();
          syncSettings();
          bridge.pushToast("桌面已恢复默认");
          break;
        }
        case "export": {
          const data: Record<string, unknown> = {};
          for (let i = 0; i < localStorage.length; i += 1) {
            const k = localStorage.key(i) ?? "";
            if (!k.startsWith("guandao.")) continue;
            const raw = localStorage.getItem(k) ?? "";
            try {
              data[k] = JSON.parse(raw);
            } catch {
              data[k] = raw;
            }
          }
          const payload = { version: EXPORT_FORMAT, exportedAt: new Date().toISOString(), data };
          const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = `guandao-os-${new Date().toISOString().slice(0, 10)}.json`;
          a.click();
          URL.revokeObjectURL(url);
          bridge.pushToast("设置已导出");
          break;
        }
        case "reset-all":
          if (window.confirm("清空本机所有 Guandao 数据并刷新？此操作不可撤销。")) {
            try {
              localStorage.clear();
            } catch {
              /* 忽略 */
            }
            void bridge.clearIdb().then(() => window.location.reload());
          }
          break;
        default:
          break;
      }
    });

    win.addEventListener("input", (e) => {
      const input = e.target as HTMLInputElement;
      const k = input.dataset.k;
      if (!k) return;
      const cfg = bridge.getCfg();
      const kind = input.dataset.kind;
      let value: string | number | boolean = input.type === "checkbox" ? input.checked : input.type === "range" ? Number(input.value) : input.value;
      if (kind === "bool") value = input.checked;
      setPath(cfg as unknown as Record<string, unknown>, k, value);
      if (k === "appearance.accent" || k === "appearance.accent2") cfg.appearance.autoAccent = false;
      if (k === "appearance.mode") bridge.applyMode(value as "dark" | "light");
      bridge.applyAll();
      bridge.save();
      const out = win.querySelector<HTMLElement>(`[data-out="${k}"]`);
      if (out) out.textContent = `${input.value}${suffixOf(k)}`;
      if (k.startsWith("icons.")) bridge.applyIconLayout();
    });
  };

  const body = qs<HTMLElement>(win, ".win-body");
  if (body) {
    body.innerHTML = renderSettings();
    body.classList.add("win-body--settings13");
    bindSettings();
    syncSettings();
    if (!win.dataset.s13sized) {
      win.dataset.s13sized = "1";
      win.style.width = `${Math.min(940, window.innerWidth - 80)}px`;
      win.style.height = `${Math.min(660, window.innerHeight - 120)}px`;
      win.style.left = `${Math.max(20, (window.innerWidth - Math.min(940, window.innerWidth - 80)) / 2)}px`;
      win.style.top = `${Math.max(46, (window.innerHeight - Math.min(660, window.innerHeight - 120)) / 2 - 10)}px`;
    }
  }

  return {
    sync: syncSettings,
    renderGallery: (cat?: string) => {
      if (cat) {
        const grid = win.querySelector<HTMLElement>("#wall-grid");
        if (grid) grid.dataset.cat = cat;
        qsa<HTMLElement>(win, "#wall-cats [data-cat]").forEach((b) => b.classList.toggle("is-active", b.dataset.cat === cat));
      }
      renderWallGallery();
    },
  };
}
