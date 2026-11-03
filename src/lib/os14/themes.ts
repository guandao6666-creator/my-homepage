/**
 * Guandao OS 1.4 · 主题中心
 *
 * 每套主题都不只是壁纸：它同时定义强调色、窗口材质、圆角、程序坞、
 * 菜单栏、图标观感、字体气质与组件外观。应用主题时写入 1.3 的外观引擎，
 * 再通过 #os[data-theme14] 给 CSS 提供差异化钩子。
 */

import { WALLPAPERS, wallpaperById } from "../wallpapers";
import {
  badge,
  bindTabs,
  debounce,
  download,
  emit,
  emptyState,
  escapeHtml,
  ls,
  modal,
  onBus,
  pickFile,
  readText,
  shell,
  type Ctx,
  type FontTone,
  type Material,
  type OsThemeMode,
  type RadiusStyle,
} from "./core";

export type ThemeDef = {
  id: string;
  name: string;
  en: string;
  author: string;
  desc: string;
  style: string;
  wall: string;
  mode: OsThemeMode;
  accent: string;
  accent2: string;
  material: Material;
  radius: RadiusStyle;
  darken: number;
  dock: { size: number; magnify: number; opacity: number };
  font: FontTone;
  grain: boolean;
  tags: string[];
  builtin: boolean;
  createdAt: number;
};

const DEFAULT_LOOK_ID = "default";

export const THEMES: ThemeDef[] = [
  {
    id: "aurora",
    name: "Aurora",
    en: "极光",
    author: "Guandao Studio",
    desc: "冷绿与青色在冰湖上流动，柔光玻璃窗口配圆角程序坞，是最接近系统默认的一套。",
    style: "冷色 · 通透",
    wall: "aurora",
    mode: "dark",
    accent: "#34d399",
    accent2: "#4bd3d1",
    material: "glass",
    radius: "round",
    darken: 18,
    dock: { size: 46, magnify: 1.28, opacity: 0.55 },
    font: "sans",
    grain: false,
    tags: ["自然", "清透", "适合长时间"],
    builtin: true,
    createdAt: 0,
  },
  {
    id: "ocean",
    name: "Ocean",
    en: "深海",
    author: "Guandao Studio",
    desc: "光柱穿过深蓝，窗口像一块沉在水下的玻璃。强调色取自海面反光，安静但不沉闷。",
    style: "深蓝 · 静谧",
    wall: "ocean",
    mode: "dark",
    accent: "#38bdf8",
    accent2: "#3e69e0",
    material: "glass",
    radius: "round",
    darken: 22,
    dock: { size: 44, magnify: 1.22, opacity: 0.5 },
    font: "sans",
    grain: false,
    tags: ["海洋", "专注"],
    builtin: true,
    createdAt: 0,
  },
  {
    id: "forest",
    name: "Forest",
    en: "森林",
    author: "Guandao Studio",
    desc: "雾中针叶林的绿调，磨砂窗口与更柔和的圆角，适合阅读和写东西的时候用。",
    style: "自然 · 柔和",
    wall: "forest",
    mode: "dark",
    accent: "#5ecf9a",
    accent2: "#8fd694",
    material: "frost",
    radius: "soft",
    darken: 16,
    dock: { size: 46, magnify: 1.2, opacity: 0.6 },
    font: "sans",
    grain: false,
    tags: ["自然", "写作"],
    builtin: true,
    createdAt: 0,
  },
  {
    id: "sunset",
    name: "Sunset",
    en: "日落",
    author: "Guandao Studio",
    desc: "低垂的太阳把海面染成琥珀色，暖橙强调色与柔和阴影，傍晚打开最合适。",
    style: "暖色 · 松弛",
    wall: "sunset",
    mode: "dark",
    accent: "#e59a72",
    accent2: "#d0be84",
    material: "glass",
    radius: "soft",
    darken: 14,
    dock: { size: 46, magnify: 1.25, opacity: 0.55 },
    font: "sans",
    grain: false,
    tags: ["暖色", "放松"],
    builtin: true,
    createdAt: 0,
  },
  {
    id: "cyberpunk",
    name: "Cyberpunk",
    en: "赛博朋克",
    author: "Guandao Studio",
    desc: "雨夜霓虹与品红 / 青色高对比，直角窗口、实心程序坞、等宽字体与轻微颗粒。",
    style: "高对比 · 霓虹",
    wall: "city-night",
    mode: "dark",
    accent: "#ff49c8",
    accent2: "#35e6ff",
    material: "solid",
    radius: "sharp",
    darken: 30,
    dock: { size: 40, magnify: 1.14, opacity: 0.9 },
    font: "mono",
    grain: true,
    tags: ["霓虹", "夜间", "强风格"],
    builtin: true,
    createdAt: 0,
  },
  {
    id: "minimal",
    name: "Minimal",
    en: "极简",
    author: "Guandao Studio",
    desc: "沙丘的明暗与留白，浅色界面、实心表面、低饱和强调色，去掉一切多余装饰。",
    style: "浅色 · 克制",
    wall: "dunes",
    mode: "light",
    accent: "#2f7f7a",
    accent2: "#c08552",
    material: "solid",
    radius: "round",
    darken: 8,
    dock: { size: 42, magnify: 1.16, opacity: 0.85 },
    font: "sans",
    grain: false,
    tags: ["浅色", "干净"],
    builtin: true,
    createdAt: 0,
  },
  {
    id: "glass",
    name: "Glass",
    en: "玻璃",
    author: "Guandao Studio",
    desc: "层层叠叠的半透明玻璃，强模糊与高亮描边，窗口像悬在光里。",
    style: "材质 · 通透",
    wall: "glass",
    mode: "dark",
    accent: "#e29b79",
    accent2: "#e4d596",
    material: "frost",
    radius: "round",
    darken: 10,
    dock: { size: 50, magnify: 1.3, opacity: 0.34 },
    font: "sans",
    grain: false,
    tags: ["材质", "轻盈"],
    builtin: true,
    createdAt: 0,
  },
  {
    id: "space",
    name: "Space",
    en: "宇宙",
    author: "Guandao Studio",
    desc: "深空星云与青金气体，深色玻璃、细描边和一点点颗粒，窗口边界几乎融进背景。",
    style: "深空 · 沉浸",
    wall: "space",
    mode: "dark",
    accent: "#7aa2ff",
    accent2: "#b06eff",
    material: "glass",
    radius: "round",
    darken: 26,
    dock: { size: 44, magnify: 1.24, opacity: 0.44 },
    font: "sans",
    grain: true,
    tags: ["深色", "沉浸"],
    builtin: true,
    createdAt: 0,
  },
  {
    id: "retro",
    name: "Retro",
    en: "复古",
    author: "Guandao Studio",
    desc: "纸灯、暖黄与旧印刷质感，衬线字体、实心表面和偏方的圆角，像一台老机器。",
    style: "暖色 · 怀旧",
    wall: "tokyo",
    mode: "dark",
    accent: "#d7a24a",
    accent2: "#c9724a",
    material: "solid",
    radius: "soft",
    darken: 20,
    dock: { size: 44, magnify: 1.18, opacity: 0.86 },
    font: "serif",
    grain: true,
    tags: ["怀旧", "暖色"],
    builtin: true,
    createdAt: 0,
  },
  {
    id: "terminal",
    name: "Terminal",
    en: "终端",
    author: "Guandao Studio",
    desc: "碳纤维底色配荧光绿，全直角、等宽字体、窄程序坞，给命令行爱好者的一套主题。",
    style: "极客 · 单色",
    wall: "tech",
    mode: "dark",
    accent: "#6ee7a8",
    accent2: "#34d399",
    material: "solid",
    radius: "sharp",
    darken: 32,
    dock: { size: 38, magnify: 1.1, opacity: 0.92 },
    font: "mono",
    grain: true,
    tags: ["极客", "深色"],
    builtin: true,
    createdAt: 0,
  },
];

export const themeById = (id: string) => THEMES.find((t) => t.id === id);

/* ============================================================
   存储
   ============================================================ */

const KEY = "guandao.os14.themes.v1";

export type ThemeState = {
  v: 1;
  current: string;
  favorites: string[];
  recent: string[];
  custom: ThemeDef[];
};

const defaultState = (): ThemeState => ({
  v: 1,
  current: "aurora",
  favorites: [],
  recent: ["aurora"],
  custom: [],
});

let stateCache: ThemeState | null = null;

export const readThemeState = (): ThemeState => {
  if (stateCache) return stateCache;
  const raw = ls.get<ThemeState | null>(KEY, null);
  stateCache = raw && raw.v === 1 ? { ...defaultState(), ...raw } : defaultState();
  return stateCache;
};

export const writeThemeState = (next: ThemeState) => {
  stateCache = next;
  ls.set(KEY, next);
  emit("themes-change", { current: next.current });
};

export const allThemes = () => [...THEMES, ...readThemeState().custom];

export const findTheme = (id: string) => allThemes().find((t) => t.id === id);

/* ============================================================
   应用 / 预览
   ============================================================ */

const HEX = /^#[0-9a-f]{6}$/i;

let previewSnapshot: { themeId: string; look: Record<string, unknown>; wall: string; defaultLook: boolean } | null = null;

const applyAttrs = (theme: ThemeDef) => {
  const os = document.getElementById("os");
  if (!os) return;
  os.dataset.theme14 = theme.id;
  os.dataset.font14 = theme.font;
  os.dataset.grain14 = theme.grain ? "1" : "0";
  document.body.dataset.font14 = theme.font;
  document.body.dataset.theme14 = theme.id;
};

const clearAttrs = () => {
  const os = document.getElementById("os");
  if (os) {
    os.dataset.theme14 = DEFAULT_LOOK_ID;
    os.dataset.font14 = "sans";
    os.dataset.grain14 = "0";
  }
  document.body.dataset.theme14 = DEFAULT_LOOK_ID;
  document.body.dataset.font14 = "sans";
};

const transition = (fn: () => void) => {
  const os = document.getElementById("os");
  if (!os) return fn();
  os.classList.add("is-theme-swap");
  fn();
  window.setTimeout(() => os.classList.remove("is-theme-swap"), 720);
};

export const applyTheme = (theme: ThemeDef, opts: { silent?: boolean } = {}) => {
  transition(() => {
    applyAttrs(theme);
    ctxRef?.api13.applyLook({
      mode: theme.mode,
      material: theme.material,
      radius: theme.radius,
      accent: theme.accent,
      accent2: theme.accent2,
      wall: theme.wall,
      darken: theme.darken,
      dock: { size: theme.dock.size, magnify: theme.dock.magnify, opacity: theme.dock.opacity },
      preset: "custom",
    });
    ctxRef?.os.classList.add("is-theme-custom");
  });

  const st = readThemeState();
  st.current = theme.id;
  st.recent = [theme.id, ...st.recent.filter((x) => x !== theme.id)].slice(0, 6);
  writeThemeState(st);
  if (!opts.silent) ctxRef?.toast(`已应用主题「${theme.name} · ${theme.en}」`);
};

export const resetTheme = () => {
  transition(() => {
    clearAttrs();
    ctxRef?.api13.applyLook({
      mode: "dark",
      material: "glass",
      radius: "round",
      accent: "#6f8cff",
      accent2: "#b06eff",
      wall: "aurora",
      darken: 22,
      dock: { size: 46, magnify: 1.22, opacity: 0.55 },
      preset: "custom",
    });
    ctxRef?.os.classList.remove("is-theme-custom");
  });
  const st = readThemeState();
  st.current = DEFAULT_LOOK_ID;
  writeThemeState(st);
};

export const previewTheme = (theme: ThemeDef) => {
  if (!previewSnapshot) {
    const cfg = (ctxRef?.api13.cfg() ?? {}) as Record<string, any>;
    previewSnapshot = {
      themeId: readThemeState().current,
      defaultLook: !ls.str(KEY) || readThemeState().current === DEFAULT_LOOK_ID,
      wall: String(cfg.wall?.id ?? "aurora"),
      look: {
        mode: cfg.appearance?.mode ?? "dark",
        material: cfg.appearance?.material ?? "glass",
        radius: cfg.appearance?.radius ?? "round",
        accent: cfg.appearance?.accent ?? "#6f8cff",
        accent2: cfg.appearance?.accent2 ?? "#b06eff",
        darken: cfg.wall?.darken ?? 22,
        dock: { size: cfg.dock?.size ?? 46, magnify: cfg.dock?.magnify ?? 1.22, opacity: cfg.dock?.opacity ?? 0.55 },
      },
    };
  }
  transition(() => {
    applyAttrs(theme);
    ctxRef?.api13.applyLook({
      mode: theme.mode,
      material: theme.material,
      radius: theme.radius,
      accent: theme.accent,
      accent2: theme.accent2,
      wall: theme.wall,
      darken: theme.darken,
      dock: { size: theme.dock.size, magnify: theme.dock.magnify, opacity: theme.dock.opacity },
      preset: "custom",
    });
  });
};

export const cancelPreview = () => {
  if (!previewSnapshot) return;
  const snap = previewSnapshot;
  previewSnapshot = null;
  transition(() => {
    if (snap.defaultLook) clearAttrs();
    else applyAttrs(findTheme(snap.themeId) ?? THEMES[0]);
    ctxRef?.api13.applyLook({ ...snap.look, wall: snap.wall, preset: "custom" });
  });
};

export const commitPreview = (theme: ThemeDef) => {
  previewSnapshot = null;
  applyTheme(theme);
};

export const applyStoredTheme = () => {
  // 从没用过 1.4 主题的话，完全交给 1.3 的外观配置，避免升级后被强行改回 Aurora
  if (!ls.str(KEY)) {
    clearAttrs();
    return;
  }
  const st = readThemeState();
  const theme = st.current === DEFAULT_LOOK_ID ? null : findTheme(st.current);
  if (theme) {
    applyAttrs(theme);
    ctxRef?.api13.applyLook({
      mode: theme.mode,
      material: theme.material,
      radius: theme.radius,
      accent: theme.accent,
      accent2: theme.accent2,
      wall: theme.wall,
      darken: theme.darken,
      dock: { size: theme.dock.size, magnify: theme.dock.magnify, opacity: theme.dock.opacity },
      preset: "custom",
    });
    ctxRef?.os.classList.add("is-theme-custom");
  } else {
    clearAttrs();
  }
};

/* ============================================================
   自定义 / 导入导出
   ============================================================ */

export const normalizeTheme = (raw: unknown, builtin = false): ThemeDef | null => {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const name = String(r.name ?? "").trim().slice(0, 24);
  if (!name) return null;
  const wall = String(r.wall ?? "");
  if (!WALLPAPERS.some((w) => w.id === wall)) return null;
  const accent = String(r.accent ?? "");
  const accent2 = String(r.accent2 ?? "");
  if (!HEX.test(accent) || !HEX.test(accent2)) return null;
  const mode = r.mode === "light" ? "light" : "dark";
  const material = ["glass", "frost", "solid"].includes(String(r.material)) ? (String(r.material) as Material) : "glass";
  const radius = ["soft", "round", "sharp"].includes(String(r.radius)) ? (String(r.radius) as RadiusStyle) : "round";
  const font = ["sans", "serif", "mono"].includes(String(r.font)) ? (String(r.font) as FontTone) : "sans";
  const dockRaw = (r.dock ?? {}) as Record<string, unknown>;
  const id = builtin
    ? String(r.id ?? "")
    : `custom-${String(r.id ?? "")
        .replace(/^custom-/, "")
        .replace(/[^a-z0-9-]/gi, "")
        .slice(0, 24) || Date.now().toString(36)}`;
  return {
    id,
    name,
    en: String(r.en ?? "自定义").slice(0, 16) || "自定义",
    author: String(r.author ?? "我").slice(0, 24) || "我",
    desc: String(r.desc ?? "自己搭配的一套外观。").slice(0, 120),
    style: String(r.style ?? "自定义").slice(0, 20),
    wall,
    mode,
    accent,
    accent2,
    material,
    radius,
    darken: Math.max(0, Math.min(80, Number(r.darken) || 20)),
    dock: {
      size: Math.max(34, Math.min(72, Number(dockRaw.size) || 46)),
      magnify: Math.max(1, Math.min(1.6, Number(dockRaw.magnify) || 1.2)),
      opacity: Math.max(0.2, Math.min(1, Number(dockRaw.opacity) || 0.55)),
    },
    font,
    grain: Boolean(r.grain),
    tags: Array.isArray(r.tags) ? r.tags.slice(0, 4).map((t) => String(t).slice(0, 12)) : ["自定义"],
    builtin,
    createdAt: Number(r.createdAt) || Date.now(),
  };
};

export const saveCustomTheme = (theme: ThemeDef) => {
  const st = readThemeState();
  const idx = st.custom.findIndex((t) => t.id === theme.id);
  if (idx >= 0) st.custom[idx] = theme;
  else st.custom.push(theme);
  writeThemeState(st);
  emit("themes-change", { current: st.current });
};

export const deleteCustomTheme = (id: string) => {
  const st = readThemeState();
  st.custom = st.custom.filter((t) => t.id !== id);
  if (st.current === id) st.current = "aurora";
  writeThemeState(st);
};

export const exportTheme = (theme: ThemeDef) => {
  download(
    `guandao-theme-${theme.id}.json`,
    JSON.stringify({ kind: "guandao-theme", version: 1, exportedAt: new Date().toISOString(), theme }, null, 2),
  );
};

export const importThemeFile = async (file: File): Promise<ThemeDef | null> => {
  try {
    if (file.size > 64 * 1024) return null;
    const parsed = JSON.parse(await readText(file)) as Record<string, unknown>;
    if (!parsed || parsed.kind !== "guandao-theme") return null;
    const theme = normalizeTheme(parsed.theme);
    if (!theme) return null;
    theme.id = `custom-${Date.now().toString(36)}`;
    theme.author = String((parsed.theme as Record<string, unknown>)?.author ?? "导入").slice(0, 24);
    saveCustomTheme(theme);
    return theme;
  } catch {
    return null;
  }
};

/* ============================================================
   主题中心界面
   ============================================================ */

let ctxRef: Ctx | null = null;
let activeTab = "all";
let previewId = "";

const themePreview = (theme: ThemeDef) => {
  const wall = wallpaperById(theme.wall);
  const light = theme.mode === "light";
  return `
    <div class="g14-theme-prev ${light ? "is-light" : ""}" style="--tp-accent:${theme.accent};--tp-accent2:${theme.accent2}" data-radius="${theme.radius}">
      <img src="${wall.thumb}" alt="" loading="lazy" />
      <span class="g14-tp-veil"></span>
      <span class="g14-tp-menubar"></span>
      <span class="g14-tp-win">
        <i class="g14-tp-dots"><b></b><b></b><b></b></i>
        <i class="g14-tp-line"></i><i class="g14-tp-line is-short"></i><i class="g14-tp-chip"></i>
      </span>
      <span class="g14-tp-widget"></span>
      <span class="g14-tp-dock"><i></i><i></i><i></i><i></i></span>
    </div>`;
};

const card = (theme: ThemeDef, st: ThemeState) => {
  const fav = st.favorites.includes(theme.id);
  const cur = st.current === theme.id;
  return `
    <article class="g14-theme-card ${cur ? "is-current" : ""}" data-theme="${escapeHtml(theme.id)}">
      <div class="g14-theme-shot">${themePreview(theme)}</div>
      <div class="g14-theme-meta">
        <div class="g14-theme-row">
          <h4>${escapeHtml(theme.name)} <span>${escapeHtml(theme.en)}</span></h4>
          <button class="g14-iconbtn ${fav ? "is-on" : ""}" type="button" data-fav="${escapeHtml(theme.id)}" title="收藏">${fav ? "★" : "☆"}</button>
        </div>
        <p class="g14-theme-style">${escapeHtml(theme.style)} · ${escapeHtml(theme.author)}</p>
        <p class="g14-theme-desc">${escapeHtml(theme.desc)}</p>
        <div class="g14-theme-tags">${theme.tags.map((t) => `<span>${escapeHtml(t)}</span>`).join("")}</div>
        <div class="g14-theme-actions">
          <button class="g14-btn is-primary" type="button" data-apply="${escapeHtml(theme.id)}">${cur ? "已应用" : "应用"}</button>
          <button class="g14-btn" type="button" data-prev="${escapeHtml(theme.id)}">预览</button>
          <button class="g14-btn is-ghost" type="button" data-detail="${escapeHtml(theme.id)}">详情</button>
        </div>
      </div>
    </article>`;
};

const editorForm = (theme?: ThemeDef) => {
  const t = theme ?? {
    name: "",
    en: "",
    wall: "aurora",
    mode: "dark" as OsThemeMode,
    accent: "#6f8cff",
    accent2: "#b06eff",
    material: "glass" as Material,
    radius: "round" as RadiusStyle,
    darken: 22,
    dock: { size: 46, magnify: 1.22, opacity: 0.55 },
    font: "sans" as FontTone,
    grain: false,
    desc: "",
  };
  const wallOpts = WALLPAPERS.map(
    (w) => `<option value="${w.id}" ${w.id === t.wall ? "selected" : ""}>${escapeHtml(w.name)} · ${escapeHtml(w.en)}</option>`,
  ).join("");
  return `
    <div class="g14-editor">
      <div class="g14-editor-row">
        <label>主题名称<input class="g14-input" data-f="name" maxlength="24" value="${escapeHtml(t.name)}" placeholder="例如：我的夜航" /></label>
        <label>风格描述<input class="g14-input" data-f="style" maxlength="20" value="${escapeHtml((t as ThemeDef).style ?? "自定义")}" placeholder="例如：冷色 · 夜间" /></label>
      </div>
      <label>壁纸<select class="g14-input" data-f="wall">${wallOpts}</select></label>
      <div class="g14-editor-row">
        <label>主强调色<input class="g14-color" type="color" data-f="accent" value="${t.accent}" /></label>
        <label>副强调色<input class="g14-color" type="color" data-f="accent2" value="${t.accent2}" /></label>
        <label>深色强度<input class="g14-range" type="range" data-f="darken" min="0" max="70" value="${t.darken}" /></label>
      </div>
      <div class="g14-editor-row">
        <label>明暗<select class="g14-input" data-f="mode">
          <option value="dark" ${t.mode === "dark" ? "selected" : ""}>深色</option>
          <option value="light" ${t.mode === "light" ? "selected" : ""}>浅色</option>
        </select></label>
        <label>窗口材质<select class="g14-input" data-f="material">
          <option value="glass" ${t.material === "glass" ? "selected" : ""}>玻璃</option>
          <option value="frost" ${t.material === "frost" ? "selected" : ""}>磨砂</option>
          <option value="solid" ${t.material === "solid" ? "selected" : ""}>实心</option>
        </select></label>
        <label>圆角<select class="g14-input" data-f="radius">
          <option value="soft" ${t.radius === "soft" ? "selected" : ""}>柔和</option>
          <option value="round" ${t.radius === "round" ? "selected" : ""}>圆润</option>
          <option value="sharp" ${t.radius === "sharp" ? "selected" : ""}>直角</option>
        </select></label>
      </div>
      <div class="g14-editor-row">
        <label>字体气质<select class="g14-input" data-f="font">
          <option value="sans" ${t.font === "sans" ? "selected" : ""}>无衬线</option>
          <option value="serif" ${t.font === "serif" ? "selected" : ""}>衬线</option>
          <option value="mono" ${t.font === "mono" ? "selected" : ""}>等宽</option>
        </select></label>
        <label>程序坞图标<input class="g14-range" type="range" data-f="dock.size" min="34" max="72" value="${t.dock.size}" /></label>
        <label class="g14-check"><input type="checkbox" data-f="grain" ${t.grain ? "checked" : ""}/> 颗粒质感</label>
      </div>
      <label>备注<textarea class="g14-input" data-f="desc" rows="2" maxlength="120" placeholder="一句话说明这套主题">${escapeHtml(t.desc ?? "")}</textarea></label>
      <div class="g14-editor-actions">
        <button class="g14-btn is-primary" type="button" data-save="${theme ? escapeHtml(theme.id) : "new"}">保存主题</button>
        <button class="g14-btn" type="button" data-editor-preview>用当前设置预览</button>
        ${theme ? `<button class="g14-btn is-danger is-ghost" type="button" data-del="${escapeHtml(theme.id)}">删除</button>` : ""}
      </div>
      <p class="g14-hint">自定义主题保存在本机浏览器；导入的配置会先校验字段与取值范围，不会执行任何脚本。</p>
    </div>`;
};

const readEditor = (root: HTMLElement) => {
  const val = (k: string) => root.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(`[data-f="${k}"]`)?.value ?? "";
  return normalizeTheme({
    id: "custom-new",
    name: val("name"),
    en: "自定义",
    style: val("style"),
    wall: val("wall"),
    accent: val("accent"),
    accent2: val("accent2"),
    mode: val("mode"),
    material: val("material"),
    radius: val("radius"),
    font: val("font"),
    darken: Number(val("darken")),
    grain: root.querySelector<HTMLInputElement>('[data-f="grain"]')?.checked ?? false,
    desc: val("desc"),
    dock: { size: Number(val("dock.size")), magnify: 1.2, opacity: 0.55 },
    author: "我",
    tags: ["自定义"],
  });
};

const renderThemeTab = (host: HTMLElement, st: ThemeState) => {
  const list = allThemes();
  if (activeTab === "editor") {
    host.innerHTML = `<div class="g14-pane-head"><h3>创建自定义主题</h3><p>先搭一套，再点「用当前设置预览」看整体效果。</p></div>${editorForm()}`;
    return;
  }
  if (activeTab === "mine") {
    const mine = st.custom;
    host.innerHTML = `
      <div class="g14-pane-head"><h3>我的主题</h3><p>共 ${mine.length} 套自定义主题，可导出为 JSON 分享。</p></div>
      ${
        mine.length
          ? `<div class="g14-theme-grid">${mine
              .map(
                (t) => `
            <article class="g14-theme-card" data-theme="${escapeHtml(t.id)}">
              <div class="g14-theme-shot">${themePreview(t)}</div>
              <div class="g14-theme-meta">
                <div class="g14-theme-row"><h4>${escapeHtml(t.name)} <span>自定义</span></h4></div>
                <p class="g14-theme-style">${escapeHtml(t.style)}</p>
                <div class="g14-theme-actions">
                  <button class="g14-btn is-primary" type="button" data-apply="${escapeHtml(t.id)}">应用</button>
                  <button class="g14-btn" type="button" data-edit="${escapeHtml(t.id)}">编辑</button>
                  <button class="g14-btn is-ghost" type="button" data-exp="${escapeHtml(t.id)}">导出</button>
                </div>
              </div>
            </article>`,
              )
              .join("")}</div>`
          : emptyState("还没有自定义主题", "点右上角「新建主题」开始搭配，或导入一个 JSON 配置。", "◐")
      }
      <div class="g14-io-bar">
        <button class="g14-btn" type="button" data-new>＋ 新建主题</button>
        <button class="g14-btn" type="button" data-import>导入主题配置</button>
        <input type="file" accept="application/json,.json" data-import-file hidden />
        <button class="g14-btn is-ghost" type="button" data-reset>恢复系统默认外观</button>
      </div>`;
    return;
  }

  let items = list;
  if (activeTab === "fav") items = list.filter((t) => st.favorites.includes(t.id));
  if (activeTab === "recent") items = st.recent.map((id) => list.find((t) => t.id === id)).filter(Boolean) as ThemeDef[];

  const title = activeTab === "fav" ? "我的收藏" : activeTab === "recent" ? "最近使用" : "全部主题";
  const sub =
    activeTab === "all"
      ? "十套内置主题，每套都包含完整的窗口、程序坞、菜单栏与组件观感。"
      : activeTab === "fav"
        ? "星标过的主题会出现在这里。"
        : "最近应用过的几套，随时切回去。";

  host.innerHTML = `
    <div class="g14-pane-head"><h3>${title}</h3><p>${sub}</p></div>
    ${
      items.length
        ? `<div class="g14-theme-grid">${items.map((t) => card(t, st)).join("")}</div>`
        : emptyState("这里是空的", "去「全部主题」看看，点 ☆ 收藏。", "☆")
    }
    <div class="g14-io-bar">
      <button class="g14-btn" type="button" data-new>＋ 新建主题</button>
      <button class="g14-btn" type="button" data-import>导入主题配置</button>
      <input type="file" accept="application/json,.json" data-import-file hidden />
      <button class="g14-btn is-ghost" type="button" data-reset>恢复系统默认外观</button>
    </div>`;
};

const previewBar = () => `
  <div class="g14-preview-bar" data-preview-bar hidden>
    <span>正在预览主题，没有保存。</span>
    <div>
      <button class="g14-btn is-primary" type="button" data-prev-ok>应用</button>
      <button class="g14-btn" type="button" data-prev-cancel>取消</button>
    </div>
  </div>`;

export const renderThemeApp = () => {
  const nav: Array<[string, string, string]> = [
    ["all", "全部主题", "◐"],
    ["fav", "我的收藏", "★"],
    ["recent", "最近使用", "◷"],
    ["mine", "我的主题", "✎"],
    ["editor", "新建主题", "＋"],
  ];
  return shell("themes", nav, `<div class="g14-theme-host" data-theme-host></div>${previewBar()}`, "主题中心");
};

export const initThemeApp = (win: HTMLElement): (() => void) => {
  const host = win.querySelector<HTMLElement>("[data-theme-host]");
  if (!host) return () => undefined;
  let editing: ThemeDef | undefined;

  const bar = win.querySelector<HTMLElement>("[data-preview-bar]");

  const paint = () => {
    const st = readThemeState();
    renderThemeTab(host, st);
    refreshBar();
  };

  const refreshBar = () => {
    if (!bar) return;
    bar.hidden = !previewId;
  };

  const onFav = (id: string) => {
    const st = readThemeState();
    st.favorites = st.favorites.includes(id) ? st.favorites.filter((x) => x !== id) : [...st.favorites, id];
    writeThemeState(st);
    paint();
  };

  const openDetail = async (theme: ThemeDef) => {
    const st = readThemeState();
    const picked = await modal(win, {
      title: `${theme.name} · ${theme.en}`,
      wide: true,
      body: `
        <div class="g14-detail-hero">${themePreview(theme)}</div>
        <p class="g14-detail-desc">${escapeHtml(theme.desc)}</p>
        <div class="g14-kv">
          <div><span>壁纸</span><b>${escapeHtml(wallpaperById(theme.wall).name)}</b></div>
          <div><span>明暗</span><b>${theme.mode === "light" ? "浅色" : "深色"}</b></div>
          <div><span>材质</span><b>${theme.material === "glass" ? "玻璃" : theme.material === "frost" ? "磨砂" : "实心"}</b></div>
          <div><span>圆角</span><b>${theme.radius === "sharp" ? "直角" : theme.radius === "soft" ? "柔和" : "圆润"}</b></div>
          <div><span>程序坞</span><b>${theme.dock.size}px</b></div>
          <div><span>字体</span><b>${theme.font === "mono" ? "等宽" : theme.font === "serif" ? "衬线" : "无衬线"}</b></div>
        </div>
        <div class="g14-swatches"><i style="background:${theme.accent}"></i><i style="background:${theme.accent2}"></i><i style="background:${theme.mode === "light" ? "#f7f4ee" : "#141826"}"></i></div>
        ${st.favorites.includes(theme.id) ? badge("已收藏", "warn") : ""}`,
      actions: [
        { label: "关闭", value: "" },
        { label: "收藏 / 取消", value: "fav" },
        { label: "应用主题", value: "apply", primary: true },
      ],
    });
    if (picked === "fav") onFav(theme.id);
    if (picked === "apply") {
      applyTheme(theme);
      paint();
    }
  };

  win.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const st = readThemeState();

    const favBtn = t.closest<HTMLElement>("[data-fav]");
    if (favBtn) return onFav(favBtn.dataset.fav ?? "");

    const applyBtn = t.closest<HTMLElement>("[data-apply]");
    if (applyBtn) {
      const theme = findTheme(applyBtn.dataset.apply ?? "");
      if (theme) {
        applyTheme(theme);
        previewId = "";
        paint();
      }
      return;
    }

    const prevBtn = t.closest<HTMLElement>("[data-prev]");
    if (prevBtn) {
      const theme = findTheme(prevBtn.dataset.prev ?? "");
      if (theme) {
        previewTheme(theme);
        previewId = theme.id;
        refreshBar();
      }
      return;
    }

    const detailBtn = t.closest<HTMLElement>("[data-detail]");
    if (detailBtn) {
      const theme = findTheme(detailBtn.dataset.detail ?? "");
      if (theme) void openDetail(theme);
      return;
    }

    if (t.closest("[data-prev-ok]")) {
      const theme = findTheme(previewId);
      if (theme) commitPreview(theme);
      previewId = "";
      paint();
      return;
    }
    if (t.closest("[data-prev-cancel]")) {
      cancelPreview();
      previewId = "";
      paint();
      return;
    }

    if (t.closest("[data-new]")) {
      activeTab = "editor";
      editing = undefined;
      win.querySelectorAll(".g14-nav").forEach((n) => n.classList.toggle("is-active", (n as HTMLElement).dataset.tab === "editor"));
      paint();
      return;
    }

    const editBtn = t.closest<HTMLElement>("[data-edit]");
    if (editBtn) {
      editing = findTheme(editBtn.dataset.edit ?? "");
      activeTab = "editor";
      win.querySelectorAll(".g14-nav").forEach((n) => n.classList.toggle("is-active", (n as HTMLElement).dataset.tab === "editor"));
      host.innerHTML = `<div class="g14-pane-head"><h3>编辑主题</h3><p>修改后保存会覆盖原来的自定义主题。</p></div>${editorForm(editing)}`;
      return;
    }

    const delBtn = t.closest<HTMLElement>("[data-del]");
    if (delBtn) {
      const id = delBtn.dataset.del ?? "";
      void modal(win, {
        title: "删除这套自定义主题？",
        body: `<p class="g14-modal-text">删除后无法恢复，正在使用时会切回 Aurora。</p>`,
        actions: [
          { label: "取消", value: "" },
          { label: "删除", value: "del", danger: true, primary: true },
        ],
      }).then((v) => {
        if (v === "del") {
          deleteCustomTheme(id);
          editing = undefined;
          paint();
        }
      });
      return;
    }

    if (t.closest("[data-editor-preview]")) {
      const theme = readEditor(host);
      if (!theme) {
        ctxRef?.toast("请先给主题起个名字，并确认颜色是 #RRGGBB");
        return;
      }
      previewTheme(theme);
      previewId = "editor-preview";
      refreshBar();
      return;
    }

    const saveBtn = t.closest<HTMLElement>("[data-save]");
    if (saveBtn) {
      const theme = readEditor(host);
      if (!theme) {
        ctxRef?.toast("请填写名称，颜色需要是 #RRGGBB 格式");
        return;
      }
      const id = saveBtn.dataset.save ?? "new";
      if (id !== "new") theme.id = id;
      else theme.id = `custom-${Date.now().toString(36)}`;
      if (editing) theme.createdAt = editing.createdAt;
      saveCustomTheme(theme);
      applyTheme(theme);
      previewId = "";
      editing = undefined;
      activeTab = "mine";
      win.querySelectorAll(".g14-nav").forEach((n) => n.classList.toggle("is-active", (n as HTMLElement).dataset.tab === "mine"));
      paint();
      return;
    }

    const expBtn = t.closest<HTMLElement>("[data-exp]");
    if (expBtn) {
      const theme = findTheme(expBtn.dataset.exp ?? "");
      if (theme) exportTheme(theme);
      return;
    }

    if (t.closest("[data-import]")) {
      win.querySelector<HTMLInputElement>("[data-import-file]")?.click();
      return;
    }

    if (t.closest("[data-reset]")) {
      void modal(win, {
        title: "恢复系统默认外观？",
        body: `<p class="g14-modal-text">会回到 1.3 的默认壁纸与配色，自定义主题不会被删除。</p>`,
        actions: [
          { label: "取消", value: "" },
          { label: "恢复默认", value: "ok", primary: true },
        ],
      }).then((v) => {
        if (v === "ok") {
          resetTheme();
          paint();
        }
      });
      return;
    }

    const fileInput = t.closest<HTMLElement>("[data-import-file]") as HTMLInputElement | null;
    if (fileInput) return;
    void st;
  });

  win.addEventListener("change", async (e) => {
    const input = (e.target as HTMLElement).closest<HTMLInputElement>("[data-import-file]");
    if (!input?.files?.length) return;
    const file = input.files[0];
    const theme = await importThemeFile(file);
    if (!theme) {
      void modal(win, {
        title: "导入失败",
        body: `<p class="g14-modal-text">这个文件不是有效的 Guandao 主题配置，或字段超出允许范围。主题文件只包含颜色、壁纸与材质参数，不会被执行。</p>`,
        actions: [{ label: "知道了", value: "ok", primary: true }],
      });
      input.value = "";
      return;
    }
    ctxRef?.toast(`已导入主题「${theme.name}」`);
    activeTab = "mine";
    paint();
    input.value = "";
  });

  bindTabs(win, (tab) => {
    activeTab = tab;
    if (tab !== "editor") editing = undefined;
    if (tab === "editor") {
      host.innerHTML = `<div class="g14-pane-head"><h3>创建自定义主题</h3><p>先搭一套，再点「用当前设置预览」看整体效果。</p></div>${editorForm()}`;
      return;
    }
    paint();
  });

  const off = onBus("themes-change", () => paint());
  paint();

  return () => {
    off();
    if (previewId) {
      cancelPreview();
      previewId = "";
    }
  };
};

/** 由 index 在启动时调用，绑定上下文并恢复上次主题 */
export const initThemes = (ctx: Ctx) => {
  ctxRef = ctx;
  // 在 1.3 设置里换主题预设 = 退出 1.4 主题，否则刷新后会被主题覆盖回来
  try {
    const original = ctx.api13.applyPreset;
    ctx.api13.applyPreset = (id: string) => {
      const st = readThemeState();
      st.current = DEFAULT_LOOK_ID;
      writeThemeState(st);
      clearAttrs();
      ctx.os.classList.remove("is-theme-custom");
      original(id);
    };
  } catch {
    /* 1.3 没暴露这个 API 就跳过 */
  }
  applyStoredTheme();
  // 壁纸被 1.3 的设置改掉后，取消主题的「当前」标记，避免界面显示错位
  const debounced = debounce(() => emit("themes-sync", null), 200);
  window.addEventListener("resize", debounced, { passive: true });
};

export { DEFAULT_LOOK_ID };
