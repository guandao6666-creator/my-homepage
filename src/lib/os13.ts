/**
 * Guandao OS 1.3 · Beyond the Desktop
 *
 * 这一层只做「增量增强」，不改写 1.0–1.2 的应用逻辑：
 *   - 壁纸引擎 2.0（本地图片库 / 自定义上传 / 适应方式 / 自动轮换 / 主色联动）
 *   - 桌面图标布局（网格 / 自由 / 排序 / 大小 / 隐藏 / 右键菜单）
 *   - Dock 3.0（位置 / 尺寸 / 放大 / 透明度 / 自动隐藏 / 运行指示 / 固定与排序）
 *   - 菜单栏控制中心（模拟硬件状态明确标注）
 *   - 个性化设置 2.0（分类 / 实时预览 / 主题预设 / 持久化）
 *   - 动态桌面（视差 / 缓慢呼吸 / 粒子，可关闭并尊重系统偏好）
 *
 * 依赖主脚本通过 initOs13(ctx) 注入的能力，不直接访问其闭包。
 */
import { safeUrl } from "./html";
import { WALLPAPERS, WALL_CATEGORY_LABEL, wallpaperById, type Wallpaper } from "./wallpapers";
import { installIcons } from "./icons13";

export type Os13WidgetState = {
  /** 时钟样式等组件私有配置 */
  style?: string;
  enabled?: boolean;
  x?: number;
  y?: number;
  size?: "s" | "m" | "l";
  opacity?: number;
  locked?: boolean;
};

export type Os13Context = {
  os: HTMLElement;
  windows: HTMLElement;
  openApp: (id: string) => void;
  closeWin?: (win: HTMLElement) => void;
  pushNotif: (n: { icon: string; title: string; body: string }) => void;
  readState: () => Record<string, unknown>;
  writeState: (patch: Record<string, unknown>) => void;
  renderDock: () => void;
  readDock: () => string[];
  saveDock: (list: string[]) => void;
  APPS: Record<string, { title: string; width: number; height: number }>;
  APP_ICON: Record<string, string>;
  widgets: {
    ids: string[];
    titles: Record<string, string>;
    desc: Record<string, string>;
    on: (id: string) => boolean;
    setEnabled: (id: string, on: boolean) => void;
    renderAll: () => void;
    read: () => Record<string, Os13WidgetState>;
    write: (all: Record<string, Os13WidgetState>) => void;
    stack: () => void;
  };
};

type IconPos = { x: number; y: number };

type Cfg = {
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
    autoKey?: string;
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
    pos: Record<string, IconPos>;
    hidden: string[];
  };
  widgets: { opacity: number; locked: boolean };
  motion: { reduce: boolean; particles: boolean; parallax?: boolean };
  custom: Array<{ id: string; name: string; accent: string; accent2?: string; at: number; bytes: number; lum?: number }>;
};

const KEY = "guandao.os13.v1";
const CUSTOM_PREFIX = "custom:";

const DEFAULTS: Cfg = {
  v: 1,
  preset: "custom",
  appearance: { mode: "dark", material: "glass", radius: "round", accent: "#6f8cff", accent2: "#b06eff", autoAccent: true },
  wall: {
    id: "aurora",
    fit: "cover",
    blur: 0,
    darken: 22,
    saturate: 100,
    auto: "off",
    slideshow: 30,
    favorites: [],
    last: 0,
    kenburns: true,
    parallax: true,
  },
  dock: { pos: "bottom", size: 46, magnify: 1.55, opacity: 62, autohide: false, indicators: true, running: true },
  icons: { mode: "grid", size: 46, label: 11.5, gap: 14, show: true, order: [], pos: {}, hidden: [] },
  widgets: { opacity: 100, locked: false },
  motion: { reduce: false, particles: false },
  custom: [],
};

/* ---------------- 主题预设 ---------------- */
type Preset = {
  id: string;
  name: string;
  en: string;
  wall: string;
  accent: string;
  accent2: string;
  mode: "dark" | "light";
  material: Cfg["appearance"]["material"];
  radius: Cfg["appearance"]["radius"];
  dock: Partial<Cfg["dock"]>;
  swatch: [string, string];
};

const PRESETS: Preset[] = [
  {
    id: "aurora",
    name: "极光",
    en: "Aurora",
    wall: "aurora",
    accent: "#46d98a",
    accent2: "#5ee0d0",
    mode: "dark",
    material: "glass",
    radius: "round",
    dock: { opacity: 58, size: 46, magnify: 1.6 },
    swatch: ["#0d2a24", "#46d98a"],
  },
  {
    id: "ocean",
    name: "海洋",
    en: "Ocean",
    wall: "ocean",
    accent: "#22c3e6",
    accent2: "#3e7fe0",
    mode: "dark",
    material: "glass",
    radius: "round",
    dock: { opacity: 62, size: 46, magnify: 1.55 },
    swatch: ["#062033", "#22c3e6"],
  },
  {
    id: "forest",
    name: "森林",
    en: "Forest",
    wall: "forest",
    accent: "#4fbf9a",
    accent2: "#7fd68a",
    mode: "dark",
    material: "frost",
    radius: "round",
    dock: { opacity: 66, size: 46, magnify: 1.5 },
    swatch: ["#0e231b", "#4fbf9a"],
  },
  {
    id: "sunset",
    name: "日落",
    en: "Sunset",
    wall: "sunset",
    accent: "#f08a5d",
    accent2: "#ffb27a",
    mode: "dark",
    material: "glass",
    radius: "round",
    dock: { opacity: 60, size: 46, magnify: 1.55 },
    swatch: ["#2a1410", "#f08a5d"],
  },
  {
    id: "midnight",
    name: "午夜",
    en: "Midnight",
    wall: "tech",
    accent: "#5b8cff",
    accent2: "#8b5cf6",
    mode: "dark",
    material: "solid",
    radius: "soft",
    dock: { opacity: 78, size: 44, magnify: 1.45 },
    swatch: ["#080a12", "#5b8cff"],
  },
  {
    id: "minimal",
    name: "极简",
    en: "Minimal",
    wall: "dunes",
    accent: "#c87758",
    accent2: "#a58a6a",
    mode: "light",
    material: "solid",
    radius: "soft",
    dock: { opacity: 82, size: 44, magnify: 1.4 },
    swatch: ["#f1eae0", "#c87758"],
  },
  {
    id: "glass",
    name: "玻璃",
    en: "Glass",
    wall: "glass",
    accent: "#e88f6a",
    accent2: "#f0c28a",
    mode: "light",
    material: "glass",
    radius: "round",
    dock: { opacity: 50, size: 46, magnify: 1.6 },
    swatch: ["#f6e9e2", "#e88f6a"],
  },
];

/* ---------------- 小工具 ---------------- */
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const qs = <T extends Element>(root: ParentNode, sel: string) => root.querySelector<T>(sel);
const qsa = <T extends Element>(root: ParentNode, sel: string) => Array.from(root.querySelectorAll<T>(sel));

const deepMerge = <T>(base: T, patch: unknown): T => {
  if (Array.isArray(base)) return (Array.isArray(patch) ? patch : base) as T;
  if (base && typeof base === "object") {
    const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
    if (patch && typeof patch === "object") {
      for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
        out[k] = k in out ? deepMerge((out as Record<string, unknown>)[k], v) : v;
      }
    }
    return out as T;
  }
  return (patch === undefined ? base : patch) as T;
};

const getPath = (obj: unknown, path: string): unknown =>
  path.split(".").reduce<unknown>((acc, k) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[k] : undefined), obj);

const setPath = (obj: Record<string, unknown>, path: string, value: unknown) => {
  const keys = path.split(".");
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i += 1) {
    const k = keys[i];
    if (!cur[k] || typeof cur[k] !== "object") cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  }
  cur[keys[keys.length - 1]] = value;
};

const hexToRgb = (hex: string): [number, number, number] => {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

const rgba = (hex: string, alpha: number) => {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
};

/* ---------------- IndexedDB：自定义壁纸 ---------------- */
const DB_NAME = "guandao-os13";
const STORE = "wallpapers";

const openDb = (): Promise<IDBDatabase | null> =>
  new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });

const idbPut = async (key: string, blob: Blob) => {
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(blob, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
  db.close();
};

const idbGet = async (key: string): Promise<Blob | null> => {
  const db = await openDb();
  if (!db) return null;
  const blob = await new Promise<Blob | null>((resolve) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve((req.result as Blob) ?? null);
    req.onerror = () => resolve(null);
  });
  db.close();
  return blob;
};

const idbDel = async (key: string) => {
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
  db.close();
};

/* ============================================================
   主入口
   ============================================================ */
export function initOs13(ctx: Os13Context) {
  const os = ctx.os;

  /* ---------- 配置 ---------- */
  let cfg: Cfg = DEFAULTS;
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) cfg = deepMerge(DEFAULTS, JSON.parse(raw));
  } catch {
    /* 坏数据直接回默认 */
  }
  // 首次升级：沿用 1.2 的深浅色偏好，避免用户升级后被强行切回深色
  try {
    if (!localStorage.getItem(KEY)) {
      const legacyTheme = localStorage.getItem("guandao.os.theme");
      if (legacyTheme === "light") cfg.appearance.mode = "light";
      const legacyWall = (ctx.readState().wall as string) || "";
      if (["nebula", "dusk", "deep"].includes(legacyWall)) cfg.wall.id = "aurora";
    }
  } catch {
    /* 忽略 */
  }

  const save = () => {
    try {
      localStorage.setItem(KEY, JSON.stringify(cfg));
    } catch {
      /* 隐私模式忽略 */
    }
  };

  const objUrls = new Map<string, string>();
  const customById = (id: string) => cfg.custom.find((c) => c.id === id);

  const wallSrc = (id: string): string | null => {
    if (id.startsWith(CUSTOM_PREFIX)) {
      const cached = objUrls.get(id);
      return cached ?? null;
    }
    return wallpaperById(id).src;
  };

  const resolveWall = (): { id: string; name: string; src: string | null; accent: string; accent2: string } => {
    const id = cfg.wall.id;
    if (id.startsWith(CUSTOM_PREFIX)) {
      const c = customById(id);
      return {
        id,
        name: c?.name ?? "我的壁纸",
        src: wallSrc(id),
        accent: c?.accent ?? cfg.appearance.accent,
        accent2: cfg.appearance.accent2,
      };
    }
    const w = wallpaperById(id);
    return { id, name: w.name, src: w.src, accent: w.accent, accent2: w.accent2 };
  };

  /* ---------- 壁纸 DOM ---------- */
  const wallEl = qs<HTMLElement>(os, ".wallpaper") ?? document.createElement("div");
  if (!wallEl.parentElement) {
    wallEl.className = "wallpaper";
    os.prepend(wallEl);
  }
  wallEl.classList.add("wp13");
  wallEl.innerHTML = `
    <div class="wp-layer" data-wp="a"></div>
    <div class="wp-layer" data-wp="b"></div>
    <div class="wp-veil"></div>
    <div class="wp-grain"></div>`;
  const layers = qsa<HTMLElement>(wallEl, ".wp-layer");
  let activeLayer = 0;

  /* ---------- 强调色 ---------- */
  const applyAccent = () => {
    const [r, g, b] = hexToRgb(cfg.appearance.accent);
    // 同时写到 <html>：锁屏、Toast 等挂在 body 下的图层也要拿到同一套强调色
    const targets = [document.documentElement, os];
    for (const t of targets) {
      t.style.setProperty("--os-accent", cfg.appearance.accent);
      t.style.setProperty("--os-accent-2", cfg.appearance.accent2);
      t.style.setProperty("--os-accent-rgb", `${r}, ${g}, ${b}`);
      t.style.setProperty("--os-accent-soft", rgba(cfg.appearance.accent, 0.18));
      t.style.setProperty("--os-accent-line", rgba(cfg.appearance.accent, 0.42));
      t.style.setProperty("--os-accent-glow", rgba(cfg.appearance.accent, 0.32));
      const dark = `rgb(${Math.round(r * 0.62)}, ${Math.round(g * 0.62)}, ${Math.round(b * 0.62)})`;
      t.style.setProperty("--os-accent-ink", cfg.appearance.mode === "light" ? dark : cfg.appearance.accent);
    }
  };

  /* ---------- 壁纸应用 ---------- */
  const applyWallFilters = () => {
    os.dataset.wall = "photo";
    os.style.setProperty("--wp-blur", `${cfg.wall.blur}px`);
    os.style.setProperty("--wp-darken", String(cfg.wall.darken / 100));
    os.style.setProperty("--wp-saturate", String(cfg.wall.saturate / 100));
    os.dataset.wpFit = cfg.wall.fit;
    os.dataset.wpKen = cfg.wall.kenburns ? "1" : "0";
    wallEl.dataset.ken = cfg.wall.kenburns ? "1" : "0";
  };

  let syncWallUI = () => {};

  let applySeq = 0;
  const setWallpaper = (id: string, opts: { silent?: boolean; remember?: boolean } = {}) => {
    const target = id.startsWith(CUSTOM_PREFIX) ? id : wallpaperById(id).id;
    const src = wallSrc(target);
    if (!src) return;
    cfg.wall.id = target;
    if (opts.remember !== false) cfg.wall.last = Date.now();

    const info = target.startsWith(CUSTOM_PREFIX)
      ? { accent: customById(target)?.accent ?? cfg.appearance.accent, accent2: cfg.appearance.accent2 }
      : { accent: wallpaperById(target).accent, accent2: wallpaperById(target).accent2 };

    if (cfg.appearance.autoAccent) {
      cfg.appearance.accent = info.accent;
      cfg.appearance.accent2 = info.accent2;
      applyAccent();
    }

    const seq = ++applySeq;
    const paint = () => {
      if (seq !== applySeq) return;
      const next = 1 - activeLayer;
      layers[next].style.backgroundImage = `url("${src}")`;
      requestAnimationFrame(() => {
        if (seq !== applySeq) return;
        layers[next].classList.add("is-on");
        layers[activeLayer].classList.remove("is-on");
        activeLayer = next;
      });
    };

    const img = new Image();
    img.decoding = "async";
    img.onload = paint;
    img.onerror = () => {
      // 自定义图丢了就退回默认壁纸，绝不留白屏
      if (target.startsWith(CUSTOM_PREFIX)) {
        pushToast("这张自定义壁纸已失效，已切回极光");
        setWallpaper("aurora");
      }
    };
    img.src = src;

    document.documentElement.style.setProperty("--wp-preload", `url("${src}")`);
    applyWallFilters();
    // 亮壁纸配深色图标文字，暗壁纸配白色，保证任何一张图上都读得清
    const lum = target.startsWith(CUSTOM_PREFIX) ? (customById(target)?.lum ?? 0.4) : wallpaperById(target).lum;
    os.dataset.labelTone = lum > 0.6 ? "dark" : "light";
    save();
    syncWallUI();
    if (!opts.silent) {
      const name = target.startsWith(CUSTOM_PREFIX) ? customById(target)?.name ?? "自定义壁纸" : wallpaperById(target).name;
      os.dataset.wallName = name;
    }
  };

  /* ---------- 自动轮换 ---------- */
  const pool = () => {
    const favs = cfg.wall.favorites.filter((id) => !id.startsWith(CUSTOM_PREFIX) || customById(id));
    return favs.length ? favs : WALLPAPERS.map((w) => w.id);
  };

  const stepWallpaper = (dir = 1) => {
    const list = pool();
    const cur = cfg.wall.id;
    let idx = list.indexOf(cur);
    if (idx < 0) idx = 0;
    const next = list[(idx + dir + list.length) % list.length];
    setWallpaper(next);
  };

  const autoKey = () => {
    const d = new Date();
    const day = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
    if (cfg.wall.auto === "daily") return day;
    if (cfg.wall.auto === "hourly") return `${day}-${d.getHours()}`;
    return "";
  };

  let lastAutoKey = "";
  const tickAuto = () => {
    if (cfg.wall.auto === "off") return;
    const now = Date.now();
    if (cfg.wall.auto === "random") {
      if (now - cfg.wall.last > 30 * 60 * 1000) {
        const list = pool();
        setWallpaper(list[Math.floor(Math.random() * list.length)]);
      }
      return;
    }
    if (cfg.wall.auto === "slideshow") {
      if (now - cfg.wall.last > cfg.wall.slideshow * 60 * 1000) stepWallpaper(1);
      return;
    }
    const key = autoKey();
    if (key && key !== lastAutoKey) {
      lastAutoKey = key;
      if (cfg.wall.autoKey === key) return;
      if (now - cfg.wall.last > 60 * 1000) {
        // 同一天内多次刷新不会重复跳
        const list = pool();
        const seed = [...key].reduce((a, c) => a + c.charCodeAt(0), 0);
        cfg.wall.autoKey = key;
        setWallpaper(list[seed % list.length]);
      }
    }
  };

  /* ---------- 自定义上传 ---------- */
  const compressImage = (file: File): Promise<{ blob: Blob; accent: string; accent2: string; lum: number }> =>
    new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const maxW = 2560;
        const scale = Math.min(1, maxW / img.naturalWidth);
        const w = Math.max(1, Math.round(img.naturalWidth * scale));
        const h = Math.max(1, Math.round(img.naturalHeight * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const g = canvas.getContext("2d");
        if (!g) {
          URL.revokeObjectURL(url);
          reject(new Error("no-canvas"));
          return;
        }
        g.drawImage(img, 0, 0, w, h);

        // 采样主色
        const box = document.createElement("canvas");
        box.width = 40;
        box.height = 28;
        const bg = box.getContext("2d");
        bg?.drawImage(img, 0, 0, 40, 28);
        let r = 0;
        let gg = 0;
        let b = 0;
        let n = 0;
        let lumSum = 0;
        let lumN = 0;
        if (bg) {
          const data = bg.getImageData(0, 0, 40, 28).data;
          for (let i = 0; i < data.length; i += 4) {
            lumSum += (data[i] * 0.2126 + data[i + 1] * 0.7152 + data[i + 2] * 0.0722) / 255;
            lumN += 1;
            const mx = Math.max(data[i], data[i + 1], data[i + 2]);
            const mn = Math.min(data[i], data[i + 1], data[i + 2]);
            if (mx - mn < 26) continue;
            r += data[i];
            gg += data[i + 1];
            b += data[i + 2];
            n += 1;
          }
        }
        const toHex = (v: number) => Math.round(clamp(v, 40, 215)).toString(16).padStart(2, "0");
        const accent = n ? `#${toHex(r / n)}${toHex(gg / n)}${toHex(b / n)}` : "#6f8cff";
        const accent2 = n ? `#${toHex((r / n) * 0.8 + 30)}${toHex((gg / n) * 0.8 + 20)}${toHex((b / n) * 0.9 + 40)}` : "#b06eff";

        canvas.toBlob(
          (blob) => {
            URL.revokeObjectURL(url);
            if (blob) resolve({ blob, accent, accent2, lum: lumN ? lumSum / lumN : 0.4 });
            else reject(new Error("encode-failed"));
          },
          "image/webp",
          0.84,
        );
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("decode-failed"));
      };
      img.src = url;
    });

  const importWallpaper = async (file: File) => {
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) {
      pushToast("只支持 JPG / PNG / WebP");
      return null;
    }
    if (file.size > 24 * 1024 * 1024) {
      pushToast("图片太大了，请控制在 24MB 以内");
      return null;
    }
    pushToast("正在压缩并保存…");
    try {
      const { blob, accent, accent2, lum } = await compressImage(file);
      const id = `${CUSTOM_PREFIX}${Date.now().toString(36)}`;
      await idbPut(id, blob);
      cfg.custom.push({ id, name: file.name.replace(/\.[^.]+$/, "").slice(0, 24) || "我的壁纸", accent, accent2, lum, at: Date.now(), bytes: blob.size });
      if (cfg.custom.length > 8) {
        const removed = cfg.custom.shift();
        if (removed) {
          await idbDel(removed.id);
          const old = objUrls.get(removed.id);
          if (old) URL.revokeObjectURL(old);
          objUrls.delete(removed.id);
          cfg.wall.favorites = cfg.wall.favorites.filter((f) => f !== removed.id);
        }
      }
      objUrls.set(id, URL.createObjectURL(blob));
      cfg.appearance.autoAccent = true;
      setWallpaper(id);
      save();
      // 上传后直接跳到「自定义」，让用户看到刚加的这张
      const grid = settingsWin?.querySelector<HTMLElement>("#wall-grid");
      if (grid) grid.dataset.cat = "custom";
      qsa<HTMLElement>(settingsWin ?? document, "#wall-cats [data-cat]").forEach((b) => b.classList.toggle("is-active", b.dataset.cat === "custom"));
      renderWallGallery();
      pushToast("壁纸已应用并保存在本机");
      return id;
    } catch {
      pushToast("这张图读不出来，换一张试试");
      return null;
    }
  };

  /** 社区壁纸：先由服务端做真实图片校验，用户确认后再下载到本地并交给同一套壁纸引擎 */
  const importCommunityWallpaper = async (blob: Blob, name: string) => {
    const ext = blob.type === "image/png" ? "png" : blob.type === "image/webp" ? "webp" : "jpg";
    const file = new File([blob], `${String(name || "社区壁纸").slice(0, 48)}.${ext}`, {
      type: blob.type || "image/webp",
    });
    return importWallpaper(file);
  };

  const removeCustom = async (id: string) => {
    cfg.custom = cfg.custom.filter((c) => c.id !== id);
    cfg.wall.favorites = cfg.wall.favorites.filter((f) => f !== id);
    await idbDel(id);
    const url = objUrls.get(id);
    if (url) URL.revokeObjectURL(url);
    objUrls.delete(id);
    if (cfg.wall.id === id) setWallpaper("aurora");
    save();
    renderWallGallery();
  };

  /* ---------- 提示 ---------- */
  const pushToast = (text: string) => {
    const stack = document.getElementById("toast-stack");
    if (!stack) return;
    const el = document.createElement("div");
    el.className = "toast toast13";
    el.textContent = text;
    stack.appendChild(el);
    window.setTimeout(() => el.classList.add("is-out"), 2200);
    window.setTimeout(() => el.remove(), 2600);
  };

  /* ============================================================
     桌面图标
     ============================================================ */
  const iconsHost = qs<HTMLElement>(document, ".desk-icons");
  const iconEls = () => qsa<HTMLElement>(iconsHost ?? document, ".desk-icon");
  const iconId = (el: HTMLElement) => el.dataset.app ?? el.getAttribute("href") ?? el.textContent?.trim() ?? "";

  const applyIcons = () => {
    if (!iconsHost) return;
    iconsHost.hidden = !cfg.icons.show;
    os.style.setProperty("--di-size", `${cfg.icons.size}px`);
    os.style.setProperty("--di-zoom", String(cfg.icons.size / 34));
    os.style.setProperty("--di-label", `${cfg.icons.label}px`);
    os.style.setProperty("--di-gap", `${cfg.icons.gap}px`);
    iconsHost.style.setProperty("--di-col-w", `${Math.round(cfg.icons.size + 34)}px`);

    for (const el of iconEls()) {
      const id = iconId(el);
      el.hidden = cfg.icons.hidden.includes(id);
      el.dataset.iconId = id;
    }

    // 程序坞在左右两侧时，自由摆放的图标也要让开它
    const dockPos = os.dataset.dockPos || cfg.dock.pos;
    const leftPad = dockPos === "left" ? 74 : 0;
    const rightPad = dockPos === "right" ? 74 : 0;

    // 进入自由模式前先把当前网格坐标记下来，否则图标会全部叠到左上角
    if (cfg.icons.mode === "free" && !iconsHost.classList.contains("is-free")) {
      const hostRect = iconsHost.getBoundingClientRect();
      for (const el of iconEls()) {
        const id = iconId(el);
        if (el.hidden || cfg.icons.pos[id]) continue;
        const r = el.getBoundingClientRect();
        cfg.icons.pos[id] = {
          x: Math.max(0, Math.round(r.left - hostRect.left)),
          y: Math.max(0, Math.round(r.top - hostRect.top)),
        };
      }
    }

    iconsHost.dataset.mode = cfg.icons.mode;

    if (cfg.icons.mode === "free") {
      iconsHost.classList.add("is-free");
      for (const el of iconEls()) {
        if (el.hidden) continue;
        const pos = cfg.icons.pos[iconId(el)];
        if (!pos) continue;
        const maxX = Math.max(leftPad, iconsHost.clientWidth - 60 - rightPad);
        const maxY = Math.max(0, iconsHost.clientHeight - 60);
        el.style.left = `${clamp(pos.x, leftPad, maxX)}px`;
        el.style.top = `${clamp(pos.y, 0, maxY)}px`;
      }
    } else {
      iconsHost.classList.remove("is-free");
      for (const el of iconEls()) {
        el.style.left = "";
        el.style.top = "";
      }
      // 顺序：自定义 order 优先，其余保持原顺序
      const all = iconEls();
      const map = new Map(all.map((el) => [iconId(el), el]));
      const ordered: HTMLElement[] = [];
      for (const id of cfg.icons.order) {
        const el = map.get(id);
        if (el) {
          ordered.push(el);
          map.delete(id);
        }
      }
      ordered.push(...map.values());
      for (const el of ordered) iconsHost.appendChild(el);
    }
    applyIconLayout();
  };

  const applyIconLayout = () => {
    if (!iconsHost || cfg.icons.mode !== "grid") return;
    if (window.innerWidth <= 720) {
      iconsHost.style.removeProperty("--di-rows");
      return;
    }
    const n = qsa<HTMLElement>(iconsHost, ".desk-icon").filter((el) => !el.hidden).length;
    if (!n) return;
    const first = iconsHost.querySelector<HTMLElement>(".desk-icon:not([hidden])");
    const rowH = (first?.offsetHeight || cfg.icons.size + 34) + cfg.icons.gap;
    const avail = os.clientHeight - 22 - 96;
    const maxRows = Math.max(3, Math.floor(avail / rowH));
    let rows = Math.ceil(n / Math.ceil(n / maxRows));
    for (let cols = Math.ceil(n / maxRows); cols <= Math.min(6, n); cols += 1) {
      if (n % cols === 0) {
        rows = n / cols;
        break;
      }
    }
    iconsHost.style.setProperty("--di-rows", String(rows));
  };

  const arrangeIcons = (mode: "grid" | "name") => {
    if (!iconsHost) return;
    if (mode === "grid") {
      cfg.icons.pos = {};
      cfg.icons.mode = "grid";
    } else {
      const sorted = iconEls().sort((a, b) => (a.textContent ?? "").localeCompare(b.textContent ?? "", "zh"));
      cfg.icons.order = sorted.map((el) => iconId(el));
    }
    applyIcons();
    save();
    pushToast(mode === "grid" ? "图标已排列到网格" : "图标已按名称排序");
  };

  /* 拖拽：网格内换位 / 自由摆放 */
  let dragIcon: HTMLElement | null = null;
  let dragStart = { x: 0, y: 0 };
  let dragOffset = { x: 0, y: 0 };
  let dragMoved = false;
  let lastDrop = { x: 0, y: 0 };
  let suppressIconClick = false;

  const onIconPointerDown = (e: PointerEvent) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>(".desk-icon");
    if (!el || e.button !== 0) return;
    // 小屏一律走自动网格，避免自由位置把图标叠在一起
    if (window.innerWidth <= 720) return;
    dragIcon = el;
    dragMoved = false;
    dragStart = { x: e.clientX, y: e.clientY };
    const rect = el.getBoundingClientRect();
    dragOffset = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    el.setPointerCapture?.(e.pointerId);
  };

  const onIconPointerMove = (e: PointerEvent) => {
    if (!dragIcon) return;
    const dx = e.clientX - dragStart.x;
    const dy = e.clientY - dragStart.y;
    if (!dragMoved && Math.hypot(dx, dy) < 6) return;
    if (!dragMoved) {
      dragMoved = true;
      dragIcon.classList.add("is-dragging");
      if (cfg.icons.mode === "grid") {
        dragIcon.style.position = "absolute";
        dragIcon.style.zIndex = "30";
        dragIcon.style.width = `${dragIcon.offsetWidth}px`;
      }
    }
    e.preventDefault();
    const hostRect = iconsHost!.getBoundingClientRect();
    const x = clamp(e.clientX - hostRect.left - dragOffset.x, 0, (iconsHost?.clientWidth ?? 0) - 40);
    const y = clamp(e.clientY - hostRect.top - dragOffset.y, 0, (iconsHost?.clientHeight ?? 0) - 40);
    lastDrop = { x, y };
    dragIcon.style.left = `${x}px`;
    dragIcon.style.top = `${y}px`;
  };

  const onIconPointerUp = () => {
    if (!dragIcon) return;
    const el = dragIcon;
    dragIcon = null;
    el.classList.remove("is-dragging");
    if (!dragMoved) return;
    suppressIconClick = true;
    window.setTimeout(() => (suppressIconClick = false), 60);

    const id = iconId(el);
    if (cfg.icons.mode === "free") {
      cfg.icons.pos[id] = { x: el.offsetLeft, y: el.offsetTop };
      save();
      return;
    }

    // 网格模式：找到落点位置，插入到那个图标之前
    el.style.position = "";
    el.style.zIndex = "";
    el.style.left = "";
    el.style.top = "";
    el.style.width = "";
    const hostRect = iconsHost!.getBoundingClientRect();
    const target = iconEls().find((other) => {
      if (other === el) return false;
      const r = other.getBoundingClientRect();
      return r.left - hostRect.left <= lastDrop.x + 24 && r.top - hostRect.top <= lastDrop.y + 24;
    });
    if (target) iconsHost!.insertBefore(el, target);
    else iconsHost!.appendChild(el);
    cfg.icons.order = iconEls().map((x) => iconId(x));
    save();
  };

  iconsHost?.addEventListener("pointerdown", onIconPointerDown);
  window.addEventListener("pointermove", onIconPointerMove, { passive: false });
  window.addEventListener("pointerup", onIconPointerUp);
  window.addEventListener("pointercancel", onIconPointerUp);

  // 拖完图标马上松手会触发一次 click，这里吃掉它，避免误开应用
  document.addEventListener(
    "click",
    (e) => {
      if (suppressIconClick && (e.target as HTMLElement).closest(".desk-icon")) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
    true,
  );

  /* 图标右键 */
  const onIconContext = (e: MouseEvent) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>(".desk-icon");
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    const id = iconId(el);
    const app = ctx.APPS[id];
    openMenu(e.clientX, e.clientY, [
      ...(app ? [{ label: `打开「${app.title}」`, icon: "↗", run: () => ctx.openApp(id) }] : []),
      { label: "整理到网格", icon: "▦", run: () => arrangeIcons("grid") },
      { sep: true },
      { label: "从桌面隐藏", icon: "◌", run: () => { cfg.icons.hidden.push(id); applyIcons(); save(); } },
      { label: "恢复隐藏的图标", icon: "↺", run: () => { cfg.icons.hidden = []; applyIcons(); save(); } },
    ]);
  };
  iconsHost?.addEventListener("contextmenu", onIconContext);

  /* ============================================================
     通用菜单
     ============================================================ */
  type MenuItem = { label?: string; icon?: string; hint?: string; run?: () => void; sep?: boolean; danger?: boolean; checked?: boolean };
  let menuEl: HTMLElement | null = null;

  const closeMenu = () => {
    menuEl?.remove();
    menuEl = null;
  };

  const openMenu = (x: number, y: number, items: MenuItem[]) => {
    closeMenu();
    const menu = document.createElement("div");
    menu.className = "ctxmenu";
    menu.innerHTML = items
      .map((it) =>
        it.sep
          ? `<span class="ctx-sep"></span>`
          : `<button class="ctx-item ${it.danger ? "is-danger" : ""}" type="button">
               <span class="ctx-ico">${it.checked ? "✓" : it.icon ?? ""}</span>
               <span class="ctx-label">${it.label ?? ""}</span>
               ${it.hint ? `<span class="ctx-hint">${it.hint}</span>` : ""}
             </button>`,
      )
      .join("");
    document.body.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.min(x, window.innerWidth - rect.width - 10)}px`;
    menu.style.top = `${Math.min(y, window.innerHeight - rect.height - 10)}px`;
    menuEl = menu;
    qsa<HTMLButtonElement>(menu, ".ctx-item").forEach((btn, i) => {
      const src = items.filter((it) => !it.sep)[i];
      btn.addEventListener("click", () => {
        closeMenu();
        src?.run?.();
      });
    });
    requestAnimationFrame(() => menu.classList.add("is-in"));
  };

  document.addEventListener("pointerdown", (e) => {
    if (menuEl && !menuEl.contains(e.target as Node)) closeMenu();
  });

  /* ============================================================
     桌面右键菜单
     ============================================================ */
  const FS_KEY = "guandao.os.fs.v1";

  const addDesktopFolder = () => {
    try {
      const raw = JSON.parse(localStorage.getItem(FS_KEY) || "[]");
      const list = Array.isArray(raw) ? raw : [];
      list.push({ id: `f-${Date.now().toString(36)}`, name: "新建文件夹", type: "folder", parent: "root", at: Date.now() });
      localStorage.setItem(FS_KEY, JSON.stringify(list));
      pushToast("已新建文件夹，在「文件」里查看");
    } catch {
      pushToast("存储空间不足，建不了文件夹");
    }
  };

  const addDesktopNote = () => {
    try {
      const raw = JSON.parse(localStorage.getItem("guandao.os.notes.v1") || "[]");
      const list = Array.isArray(raw) ? raw : [];
      list.unshift({
        id: `n-${Date.now().toString(36)}`,
        text: "",
        color: "#ffd479",
        pinned: false,
        at: Date.now(),
      });
      localStorage.setItem("guandao.os.notes.v1", JSON.stringify(list));
    } catch {
      /* 忽略 */
    }
    const existing = qs<HTMLElement>(ctx.windows, '.window[data-app="notes"]');
    if (existing) {
      // 便签应用在打开时读取列表，重建一次才能看到新便签
      ctx.closeWin?.(existing);
      window.setTimeout(() => ctx.openApp("notes"), 180);
    } else {
      ctx.openApp("notes");
    }
  };

  const refreshDesktop = () => {
    setWallpaper(cfg.wall.id, { silent: true, remember: false });
    iconsHost?.classList.remove("is-refreshing");
    void iconsHost?.offsetWidth;
    iconsHost?.classList.add("is-refreshing");
    pushToast("桌面已刷新");
  };

  document.addEventListener("contextmenu", (e) => {
    const target = e.target as HTMLElement;
    if (target.closest(".window, .dock, .desk-icon, .menubar, .widget, .ctxmenu, .launchpad, .spotlight, .mission")) return;
    e.preventDefault();
    openMenu(e.clientX, e.clientY, [
      { label: "新建文件夹", icon: "＋", run: addDesktopFolder },
      { label: "新建便签", icon: "▤", run: addDesktopNote },
      { sep: true },
      { label: cfg.icons.mode === "free" ? "自动排列图标" : "自由摆放图标", icon: "▦", run: () => { cfg.icons.mode = cfg.icons.mode === "free" ? "grid" : "free"; applyIcons(); save(); } },
      { label: "按名称整理", icon: "⇅", run: () => arrangeIcons("name") },
      { label: "刷新桌面", icon: "↻", run: refreshDesktop },
      { sep: true },
      { label: "更换壁纸…", icon: "◧", run: () => openSettings("wallpaper") },
      { label: "个性化设置…", icon: "⚙", run: () => openSettings("appearance") },
      { sep: true },
      { label: cfg.icons.show ? "隐藏桌面图标" : "显示桌面图标", icon: "◌", run: () => { cfg.icons.show = !cfg.icons.show; applyIcons(); save(); } },
    ]);
  });

  /* ============================================================
     Dock 3.0
     ============================================================ */
  const dock = qs<HTMLElement>(os, "#dock");

  const applyDock = () => {
    // 小屏强制回到底部：左右停靠会和 5 列图标抢空间
    const pos = window.innerWidth <= 720 ? "bottom" : cfg.dock.pos;
    os.dataset.dockPos = pos;
    os.dataset.dockAuto = cfg.dock.autohide ? "1" : "0";
    os.style.setProperty("--dock-size", `${cfg.dock.size}px`);
    os.style.setProperty("--dock-pad", `${Math.round(cfg.dock.size * 0.2)}px`);
    os.style.setProperty("--dock-gap", `${Math.round(cfg.dock.size * 0.22)}px`);
    os.style.setProperty("--dock-alpha", String(cfg.dock.opacity / 100));
    os.style.setProperty("--dock-glyph", String(cfg.dock.size / 34));
    if (dock) {
      dock.dataset.indicators = cfg.dock.indicators ? "1" : "0";
      dock.dataset.pos = pos;
    }
    syncDockRunning();
  };

  let dockAwakeTimer = 0;
  document.addEventListener(
    "pointermove",
    (e) => {
      if (!cfg.dock.autohide || !dock) return;
      const r = dock.getBoundingClientRect();
      const near =
        cfg.dock.pos === "bottom"
          ? e.clientY > window.innerHeight - 90
          : cfg.dock.pos === "left"
            ? e.clientX < 90
            : e.clientX > window.innerWidth - 90;
      if (near) {
        os.classList.add("dock-awake");
        window.clearTimeout(dockAwakeTimer);
        dockAwakeTimer = window.setTimeout(() => os.classList.remove("dock-awake"), 1400);
      } else if (!dock.matches(":hover")) {
        window.clearTimeout(dockAwakeTimer);
        dockAwakeTimer = window.setTimeout(() => os.classList.remove("dock-awake"), 600);
      }
      void r;
    },
    { passive: true },
  );

  /* 放大联动 */
  if (dock) {
    dock.addEventListener("pointermove", (e) => {
      if (!cfg.dock.magnify || cfg.dock.magnify <= 1.01) return;
      const items = qsa<HTMLElement>(dock, ".dock-item");
      for (const item of items) {
        const r = item.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        const d = cfg.dock.pos === "bottom" ? Math.abs(e.clientX - cx) : Math.abs(e.clientY - cy);
        const range = cfg.dock.size * 2.6;
        const t = clamp(1 - d / range, 0, 1);
        const scale = 1 + (cfg.dock.magnify - 1) * t * t;
        const lift = (scale - 1) * cfg.dock.size * 0.22;
        item.style.transform =
          cfg.dock.pos === "bottom"
            ? `translateY(${-lift}px) scale(${scale.toFixed(3)})`
            : `translateX(${cfg.dock.pos === "left" ? lift : -lift}px) scale(${scale.toFixed(3)})`;
      }
      void items;
    });
    dock.addEventListener("pointerleave", () => {
      qsa<HTMLElement>(dock, ".dock-item").forEach((item) => {
        item.style.transform = "";
      });
    });

    /* 右键：固定 / 取消固定 / 关闭 */
    dock.addEventListener("contextmenu", (e) => {
      const item = (e.target as HTMLElement).closest<HTMLElement>(".dock-item");
      if (!item) return;
      e.preventDefault();
      e.stopPropagation();
      const appId = item.dataset.app ?? "";
      const pinned = ctx.readDock().includes(appId);
      const running = !!qs<HTMLElement>(ctx.windows, `.window[data-app="${appId}"]`);
      openMenu(e.clientX, e.clientY, [
        { label: "打开", icon: "↗", run: () => ctx.openApp(appId) },
        ...(running
          ? [
              {
                label: "关闭窗口",
                icon: "✕",
                run: () => {
                  const win = qs<HTMLElement>(ctx.windows, `.window[data-app="${appId}"]`);
                  if (win) ctx.closeWin?.(win);
                },
              },
            ]
          : []),
        { sep: true },
        pinned
          ? {
              label: "取消固定在程序坞",
              icon: "⊖",
              run: () => {
                const list = ctx.readDock().filter((x) => x !== appId);
                ctx.saveDock(list);
                ctx.renderDock();
                syncDockRunning();
              },
            }
          : {
              label: "固定到程序坞",
              icon: "⊕",
              run: () => {
                const list = ctx.readDock();
                list.push(appId);
                ctx.saveDock(list);
                ctx.renderDock();
                syncDockRunning();
              },
            },
        { label: "更换壁纸…", icon: "◧", run: () => openSettings("wallpaper") },
      ]);
    });

    /* 拖动排序（仅固定项） */
    let dragging: HTMLElement | null = null;
    let startX = 0, startY = 0, moved = false;
    let suppressDockClick = false;
    document.addEventListener(
      "click",
      (e) => {
        if (suppressDockClick && (e.target as HTMLElement).closest(".dock-item")) {
          e.preventDefault();
          e.stopPropagation();
        }
      },
      true,
    );
    dock.addEventListener("pointerdown", (e) => {
      const item = (e.target as HTMLElement).closest<HTMLElement>(".dock-item");
      if (!item || e.button !== 0) return;
      dragging = item;
      moved = false;
      startX = e.clientX;
      startY = e.clientY;
    });
    window.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      if (!moved && Math.hypot(e.clientX - startX, e.clientY - startY) < 8) return;
      if (!moved) {
        moved = true;
        dragging.classList.add("is-dragging");
        dock.classList.add("is-sorting");
      }
      e.preventDefault();
    });
    window.addEventListener("pointerup", (e) => {
      if (!dragging) return;
      const el = dragging;
      dragging = null;
      el.classList.remove("is-dragging");
      dock.classList.remove("is-sorting");
      if (!moved) return;
      suppressDockClick = true;
      window.setTimeout(() => (suppressDockClick = false), 60);
      const over = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>(".dock-item");
      if (over && over !== el && dock.contains(over)) {
        const items = qsa<HTMLElement>(dock, ".dock-item");
        const from = items.indexOf(el);
        const to = items.indexOf(over);
        if (from >= 0 && to >= 0) {
          if (from < to) over.after(el);
          else over.before(el);
        }
      }
      const order = qsa<HTMLElement>(dock, ".dock-item")
        .map((x) => x.dataset.app ?? "")
        .filter((id) => id && ctx.readDock().includes(id));
      ctx.saveDock(order);
    });
  }

  /* 运行中的应用补位到 Dock 末尾 */
  let syncing = false;
  const syncDockRunning = () => {
    if (!dock || syncing) return;
    syncing = true;
    try {
      const pinned = ctx.readDock();
      const running = qsa<HTMLElement>(ctx.windows, ".window").map((w) => w.dataset.app ?? "");
      const want = cfg.dock.running
        ? [...new Set(running)].filter((id) => id && !pinned.includes(id) && ctx.APPS[id]).slice(0, 8)
        : [];
      const have = qsa<HTMLElement>(dock, '.dock-item[data-temp="1"]').map((el) => el.dataset.app ?? "");

      // 只有集合真的变了才动 DOM，避免 MutationObserver 自激
      if (want.join("|") !== have.filter((id) => want.includes(id)).join("|") || want.length !== have.length) {
        for (const el of qsa<HTMLElement>(dock, '.dock-item[data-temp="1"]')) {
          if (!want.includes(el.dataset.app ?? "")) el.remove();
        }
        const sep = qsa<HTMLElement>(dock, ".dock-sep")[0];
        for (const id of want) {
          if (have.includes(id)) continue;
          const btn = document.createElement("button");
          btn.className = "dock-item is-temp has-open";
          btn.type = "button";
          btn.dataset.app = id;
          btn.dataset.temp = "1";
          btn.title = ctx.APPS[id].title;
          btn.innerHTML = `<span class="di-glyph ${ctx.APP_ICON[id] ?? "di-folder"}"></span>`;
          if (sep) dock.insertBefore(btn, sep);
          else dock.appendChild(btn);
        }
      }

      const alive = new Set(running);
      for (const el of qsa<HTMLElement>(dock, ".dock-item")) {
        const id = el.dataset.app ?? "";
        el.classList.toggle("has-open", alive.has(id));
      }
    } finally {
      syncing = false;
    }
  };

  const dockObserver = new MutationObserver(() => window.setTimeout(syncDockRunning, 30));
  dockObserver.observe(ctx.windows, { childList: true, subtree: false, attributes: true, attributeFilter: ["class", "data-space"] });
  dockObserver.observe(dock ?? document.body, { childList: true, subtree: false });

  /* ============================================================
     菜单栏：控制中心
     ============================================================ */
  const mbStatus = qs<HTMLElement>(os, ".mb-status");
  const timeBtn = document.getElementById("mb-time-btn");

  const control = { wifi: true, bt: false, volume: 45, brightness: 80, focus: false };

  const buildControlCenter = () => {
    if (!mbStatus || !timeBtn) return;
    if (document.getElementById("cc-btn")) return;

    const btn = document.createElement("button");
    btn.id = "cc-btn";
    btn.className = "mb-cc";
    btn.type = "button";
    btn.title = "控制中心";
    btn.setAttribute("aria-label", "控制中心");
    btn.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
        <path d="M4 8.5a12 12 0 0 1 16 0" stroke-linecap="round"/>
        <path d="M7 12a8 8 0 0 1 10 0" stroke-linecap="round"/>
        <path d="M9.7 15.4a4 4 0 0 1 4.6 0" stroke-linecap="round"/>
        <circle cx="12" cy="19" r="1" fill="currentColor" stroke="none"/>
      </svg>
      <svg class="cc-batt" viewBox="0 0 26 14" fill="none" aria-hidden="true">
        <rect x="0.6" y="0.6" width="21" height="12.8" rx="3.4" stroke="currentColor" stroke-width="1.2" opacity=".55"/>
        <rect class="cc-batt-fill" x="2.4" y="2.4" width="14" height="9.2" rx="2" fill="currentColor"/>
        <path d="M23.4 5v4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" opacity=".55"/>
      </svg>`;

    const panel = document.createElement("div");
    panel.id = "control-center";
    panel.className = "control-center";
    panel.hidden = true;
    panel.innerHTML = `
      <div class="cc-grid">
        <button class="cc-tile cc-wide" type="button" data-cc="theme">
          <span class="cc-tile-ico" data-cc-theme-ico>◐</span>
          <span class="cc-tile-body"><b data-cc-theme-label>深色外观</b><i>点击切换明亮 / 深色</i></span>
        </button>
        <button class="cc-tile" type="button" data-cc="focus">
          <span class="cc-tile-ico">◎</span>
          <span class="cc-tile-body"><b data-cc-focus>专注</b><i>隐藏打扰</i></span>
        </button>
      </div>
      <div class="cc-card">
        <div class="cc-row">
          <span class="cc-ico">◈</span>
          <span class="cc-name">Wi-Fi</span>
          <span class="cc-val" data-cc-wifi>Guandao-5G</span>
          <button class="cc-switch" type="button" data-cc="wifi" aria-pressed="true"><i></i></button>
        </div>
        <div class="cc-row">
          <span class="cc-ico">⌁</span>
          <span class="cc-name">蓝牙</span>
          <span class="cc-val" data-cc-bt>关闭</span>
          <button class="cc-switch" type="button" data-cc="bt" aria-pressed="false"><i></i></button>
        </div>
        <label class="cc-row cc-slider">
          <span class="cc-ico">♪</span>
          <span class="cc-name">音量</span>
          <input type="range" min="0" max="100" value="${control.volume}" data-cc-range="volume" aria-label="音量" />
          <b data-cc-volume>${control.volume}%</b>
        </label>
        <label class="cc-row cc-slider">
          <span class="cc-ico">☀</span>
          <span class="cc-name">亮度</span>
          <input type="range" min="20" max="100" value="${control.brightness}" data-cc-range="brightness" aria-label="亮度" />
          <b data-cc-brightness>${control.brightness}%</b>
        </label>
      </div>
      <p class="cc-note">Wi-Fi / 蓝牙 / 音量 / 电量均为界面模拟状态，不会访问真实硬件。</p>`;

    mbStatus.insertBefore(btn, timeBtn);
    mbStatus.insertBefore(panel, timeBtn);

    const sync = () => {
      qs<HTMLElement>(panel, "[data-cc-wifi]")!.textContent = control.wifi ? "Guandao-5G" : "已关闭";
      qs<HTMLElement>(panel, "[data-cc-bt]")!.textContent = control.bt ? "未连接设备" : "关闭";
      qs<HTMLButtonElement>(panel, '[data-cc="wifi"]')!.setAttribute("aria-pressed", String(control.wifi));
      qs<HTMLButtonElement>(panel, '[data-cc="bt"]')!.setAttribute("aria-pressed", String(control.bt));
      qs<HTMLElement>(panel, "[data-cc-theme-label]")!.textContent = document.body.dataset.osTheme === "light" ? "浅色外观" : "深色外观";
      qs<HTMLElement>(panel, "[data-cc-theme-ico]")!.textContent = document.body.dataset.osTheme === "light" ? "☼" : "◐";
      qs<HTMLElement>(panel, "[data-cc-focus]")!.textContent = control.focus ? "专注中" : "专注";
      const fill = qs<SVGRectElement>(btn, ".cc-batt-fill");
      if (fill) fill.setAttribute("width", String(3 + (control.brightness / 100) * 16));
    };

    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const open = panel.hidden;
      panel.hidden = !open;
      btn.classList.toggle("is-open", open);
      if (open) sync();
    });

    panel.addEventListener("click", (e) => {
      const act = (e.target as HTMLElement).closest<HTMLElement>("[data-cc]")?.dataset.cc;
      if (act === "theme") {
        const next = document.body.dataset.osTheme === "light" ? "dark" : "light";
        applyMode(next as "dark" | "light", true);
        cfg.preset = "custom";
        save();
        sync();
      }
      if (act === "focus") {
        control.focus = !control.focus;
        os.classList.toggle("is-focus", control.focus);
        pushToast(control.focus ? "专注模式：通知已静音" : "已退出专注模式");
        sync();
      }
      if (act === "wifi") {
        control.wifi = !control.wifi;
        sync();
        pushToast(control.wifi ? "已连接 Guandao-5G（模拟）" : "Wi-Fi 已关闭（模拟）");
      }
      if (act === "bt") {
        control.bt = !control.bt;
        sync();
      }
    });

    panel.addEventListener("input", (e) => {
      const input = e.target as HTMLInputElement;
      const key = input.dataset.ccRange as "volume" | "brightness" | undefined;
      if (!key) return;
      control[key] = Number(input.value);
      qs<HTMLElement>(panel, `[data-cc-${key}]`)!.textContent = `${input.value}%`;
      if (key === "brightness") {
        os.style.setProperty("--cc-dim", String((100 - control.brightness) / 160));
      }
      sync();
    });

    document.addEventListener("click", (e) => {
      if (!panel.hidden && !panel.contains(e.target as Node) && !btn.contains(e.target as Node)) {
        panel.hidden = true;
        btn.classList.remove("is-open");
      }
    });
    sync();
  };

  /* ============================================================
     外观应用
     ============================================================ */
  const applyMode = (mode: "dark" | "light", notify = false) => {
    cfg.appearance.mode = mode;
    document.body.dataset.osTheme = mode;
    try {
      localStorage.setItem("guandao.os.theme", mode);
    } catch {
      /* 忽略 */
    }
    applyAccent();
    if (notify) pushToast(mode === "light" ? "已切换到浅色外观" : "已切换到深色外观");
  };

  const applyAppearance = () => {
    os.dataset.material = cfg.appearance.material;
    os.dataset.radius = cfg.appearance.radius;
    applyMode(cfg.appearance.mode);
    applyAccent();
  };

  const applyMotion = () => {
    const systemReduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const reduce = cfg.motion.reduce || !!systemReduce;
    os.classList.toggle("os13-reduce", reduce);
    document.body.classList.toggle("os-reduce-motion", reduce);
    os.dataset.parallax = cfg.motion.parallax && !reduce ? "1" : "0";
    os.dataset.particles = cfg.motion.particles && !reduce ? "1" : "0";
    if (cfg.motion.particles && !reduce) startParticles();
    else stopParticles();
    ctx.writeState({ reduceMotion: reduce });
  };

  const applyWidgets = () => {
    os.style.setProperty("--wg-alpha", String(cfg.widgets.opacity / 100));
    os.classList.toggle("wg-locked", cfg.widgets.locked);
  };

  const applyAll = () => {
    applyAppearance();
    applyWallFilters();
    applyDock();
    applyIcons();
    applyMotion();
    applyWidgets();
  };

  /* ============================================================
     主题预设
     ============================================================ */
  const applyPreset = (id: string) => {
    const p = PRESETS.find((x) => x.id === id);
    if (!p) return;
    cfg.preset = p.id;
    cfg.appearance.mode = p.mode;
    cfg.appearance.material = p.material;
    cfg.appearance.radius = p.radius;
    cfg.appearance.autoAccent = false;
    cfg.appearance.accent = p.accent;
    cfg.appearance.accent2 = p.accent2;
    cfg.dock = { ...cfg.dock, ...p.dock };
    cfg.wall.darken = p.mode === "light" ? 8 : 24;
    save();
    setWallpaper(p.wall);
    applyAll();
    pushToast(`已切换到「${p.name}」主题`);
    syncSettings();
  };

  /** 1.4 主题引擎用：按任意一组外观参数落盘并应用 */
  const applyLook = (look: {
    mode?: "dark" | "light";
    material?: "glass" | "frost" | "solid";
    radius?: "soft" | "round" | "sharp";
    accent?: string;
    accent2?: string;
    wall?: string;
    darken?: number;
    kenburns?: boolean;
    dock?: Partial<Cfg["dock"]>;
    preset?: string;
  }) => {
    if (look.mode) cfg.appearance.mode = look.mode;
    if (look.material) cfg.appearance.material = look.material;
    if (look.radius) cfg.appearance.radius = look.radius;
    if (look.accent && /^#[0-9a-f]{6}$/i.test(look.accent)) cfg.appearance.accent = look.accent;
    if (look.accent2 && /^#[0-9a-f]{6}$/i.test(look.accent2)) cfg.appearance.accent2 = look.accent2;
    if (typeof look.darken === "number") cfg.wall.darken = Math.max(0, Math.min(80, look.darken));
    if (typeof look.kenburns === "boolean") cfg.wall.kenburns = look.kenburns;
    if (look.dock) cfg.dock = { ...cfg.dock, ...look.dock };
    // 主题自己带强调色，别再被壁纸主色覆盖
    cfg.appearance.autoAccent = false;
    cfg.preset = look.preset ?? "custom";
    save();
    if (look.wall) setWallpaper(look.wall);
    applyAll();
    syncSettings();
  };

  /* ============================================================
     设置 2.0
     ============================================================ */
  let settingsTab = "wallpaper";
  let settingsWin: HTMLElement | null = null;

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

  const slider = (k: string, min: number, max: number, step: number, suffix = "%") => {
    const v = Number(getPath(cfg, k) ?? 0);
    return `<label class="s-row"><span>${""}</span><input type="range" data-k="${k}" min="${min}" max="${max}" step="${step}" value="${v}" /><b data-out="${k}">${v}${suffix}</b></label>`;
  };

  const toggleRow = (k: string, label: string, hint = "") => {
    const v = Boolean(getPath(cfg, k));
    return `<label class="s-row s-toggle"><span class="s-label">${label}${hint ? `<i>${hint}</i>` : ""}</span>
      <input type="checkbox" data-k="${k}" data-kind="bool" ${v ? "checked" : ""} /><i class="s-switch"></i></label>`;
  };

  const segRow = (k: string, label: string, opts: Array<[string, string]>) => {
    const v = String(getPath(cfg, k) ?? "");
    return `<div class="s-row s-seg-row"><span class="s-label">${label}</span><div class="s-seg" data-seg="${k}">
      ${opts.map(([val, text]) => `<button type="button" class="${v === val ? "is-active" : ""}" data-val="${val}">${text}</button>`).join("")}
    </div></div>`;
  };

  const swatches = ["#6f8cff", "#22c3e6", "#4fbf9a", "#f08a5d", "#c87758", "#a78bfa", "#e879b9", "#e6b878", "#9aa4b2"];

  const panelDesktop = () => `
    <section class="s-panel" data-panel="desktop">
      <h2>桌面布局</h2>
      <p class="s-sub">图标可以按网格排满，也可以像真实桌面一样随手摆放。</p>
      <div class="s-card">
        ${segRow("icons.mode", "排列方式", [["grid", "网格"], ["free", "自由"]])}
        ${slider("icons.size", 34, 64, 2, "px").replace('<span></span>', `<span class="s-label">图标大小</span>`)}
        ${slider("icons.label", 9, 15, 0.5, "px").replace('<span></span>', `<span class="s-label">文字大小</span>`)}
        ${slider("icons.gap", 6, 28, 1, "px").replace('<span></span>', `<span class="s-label">网格间距</span>`)}
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
          .map((c, i) => `<button type="button" class="${i === 0 ? "is-active" : ""}" data-cat="${c}">${c === "all" ? "全部" : c === "custom" ? "自定义" : WALL_CATEGORY_LABEL[c as keyof typeof WALL_CATEGORY_LABEL]}</button>`)
          .join("")}
      </div>
      <div class="wall-grid" id="wall-grid"></div>
      <div class="s-card">
        ${segRow("wall.fit", "显示方式", [["cover", "填充"], ["contain", "适应"], ["center", "居中"]])}
        ${slider("wall.darken", 0, 70, 1, "%").replace('<span></span>', `<span class="s-label">暗化程度</span>`)}
        ${slider("wall.blur", 0, 18, 1, "px").replace('<span></span>', `<span class="s-label">背景模糊</span>`)}
        ${slider("wall.saturate", 60, 140, 1, "%").replace('<span></span>', `<span class="s-label">色彩浓度</span>`)}
      </div>
      <div class="s-card">
        ${segRow("wall.auto", "自动更换", [["off", "关闭"], ["daily", "每天"], ["hourly", "每小时"], ["random", "随机"], ["slideshow", "轮播"]])}
        ${slider("wall.slideshow", 5, 120, 5, " 分钟").replace('<span></span>', `<span class="s-label">轮播间隔</span>`)}
        <p class="s-tip s-tip--inline">自动更换只从「收藏」里挑；没有收藏时使用全部壁纸。刷新页面不会丢失。</p>
      </div>
      <div class="s-card">
        ${toggleRow("wall.kenburns", "壁纸缓慢呼吸", "极慢的缩放，几乎不耗性能")}
        ${toggleRow("wall.parallax", "鼠标视差", "指针移动时壁纸轻微位移")}
      </div>
    </section>`;

  const panelAppearance = () => `
    <section class="s-panel" data-panel="appearance">
      <h2>外观</h2>
      <p class="s-sub">主题是一整套组合：壁纸、强调色、材质、圆角与程序坞一起变化。</p>
      <div class="preset-grid">
        ${PRESETS.map(
          (p) => `<button class="preset ${cfg.preset === p.id ? "is-active" : ""}" type="button" data-preset="${p.id}" style="--pa:${p.swatch[1]};--pb:${p.swatch[0]}">
            <span class="preset-swatch"><i></i></span>
            <span class="preset-name">${p.name}<i>${p.en}</i></span>
          </button>`,
        ).join("")}
      </div>
      <div class="s-card">
        ${segRow("appearance.mode", "明暗", [["dark", "深色"], ["light", "浅色"]])}
        ${segRow("appearance.material", "窗口材质", [["glass", "玻璃"], ["frost", "磨砂"], ["solid", "实色"]])}
        ${segRow("appearance.radius", "圆角", [["soft", "克制"], ["round", "圆润"], ["sharp", "锐利"]])}
      </div>
      <p class="s-tip">材质区别：玻璃透出壁纸颜色，磨砂只保留模糊，实色完全不透明。低配设备建议选实色以获得最高帧率。</p>
    </section>`;

  const panelColor = () => `
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
          ${swatches.map((c) => `<button type="button" style="--sw:${c}" data-swatch="${c}" aria-label="${c}"></button>`).join("")}
        </div>
      </div>
      <div class="color-preview">
        <div class="cp-card"><b>卡片标题</b><span>次级文字与说明</span><button type="button">主要按钮</button><button class="ghost" type="button">次要</button></div>
      </div>
    </section>`;

  const panelDock = () => `
    <section class="s-panel" data-panel="dock">
      <h2>程序坞</h2>
      <p class="s-sub">位置、尺寸、放大倍率、透明度都可以调；右键图标可以固定或取消固定。</p>
      <div class="dock-demo"><div class="dock-demo-bar"><i></i><i></i><i></i><i></i><i></i></div></div>
      <div class="s-card">
        ${segRow("dock.pos", "位置", [["bottom", "底部"], ["left", "左侧"], ["right", "右侧"]])}
        ${slider("dock.size", 36, 64, 2, "px").replace('<span></span>', `<span class="s-label">图标大小</span>`)}
        ${slider("dock.magnify", 1, 2, 0.05, "×").replace('<span></span>', `<span class="s-label">悬停放大</span>`)}
        ${slider("dock.opacity", 30, 95, 1, "%").replace('<span></span>', `<span class="s-label">背景不透明度</span>`)}
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
        ${slider("widgets.opacity", 35, 100, 1, "%").replace('<span></span>', `<span class="s-label">整体不透明度</span>`)}
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
        ${slider("icons.size", 34, 64, 2, "px").replace('<span></span>', `<span class="s-label">图标大小</span>`)}
        ${slider("icons.label", 9, 15, 0.5, "px").replace('<span></span>', `<span class="s-label">文字大小</span>`)}
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
      <p class="s-sub">Guandao OS 1.3 · Beyond the Desktop</p>
      <div class="s-card s-info">
        <div><span>版本</span><b>1.3</b></div>
        <div><span>代号</span><b>Beyond the Desktop</b></div>
        <div><span>壁纸</span><b>${WALLPAPERS.length} 张本地资源 + ${cfg.custom.length} 张自定义</b></div>
        <div><span>本地数据</span><b>${(bytes / 1024).toFixed(1)} KB · ${count} 项</b></div>
        <div><span>自定义壁纸</span><b>${(customBytes / 1024 / 1024).toFixed(2)} MB（IndexedDB）</b></div>
        <div><span>渲染</span><b>Astro 静态 · 无后端依赖</b></div>
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
          <span><b>个性化</b><i>Guandao OS 1.3</i></span>
        </div>
        <nav class="s13-tabs">
          ${TABS.map(([id, name, ico]) => `<button type="button" class="${settingsTab === id ? "is-active" : ""}" data-tab="${id}"><span>${ico}</span>${name}</button>`).join("")}
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
    const grid = settingsWin?.querySelector<HTMLElement>("#wall-grid");
    if (!grid) return;
    const cat = grid.dataset.cat ?? "all";
    const list: Array<Wallpaper | { id: string; name: string; thumb: string; cat: string; custom: true }> = [
      ...WALLPAPERS,
      ...cfg.custom.map((c) => ({ id: c.id, name: c.name, thumb: "", cat: "custom", custom: true as const })),
    ];
    const filtered = list.filter((w) => cat === "all" || w.cat === cat);
    grid.innerHTML = filtered
      .map((w) => {
        const active = cfg.wall.id === w.id;
        const fav = cfg.wall.favorites.includes(w.id);
        const thumb = "custom" in w ? objUrls.get(w.id) ?? "" : (w as Wallpaper).thumb;
        return `<button class="wall-card ${active ? "is-active" : ""}" type="button" data-wall-id="${w.id}" title="${w.name}">
          ${thumb ? `<img src="${safeUrl(thumb, { allowBlob: true })}" alt="${w.name}" loading="lazy" decoding="async" />` : `<span class="wc-void">自定义</span>`}
          <span class="wc-name">${w.name}</span>
          <span class="wc-fav ${fav ? "is-on" : ""}" data-fav="${w.id}" role="button" aria-label="收藏">★</span>
          ${"custom" in w ? `<span class="wc-del" data-del="${w.id}" role="button" aria-label="删除">✕</span>` : ""}
          ${active ? `<span class="wc-check">✓</span>` : ""}
        </button>`;
      })
      .join("");
    grid.dataset.cat = cat;
  };

  const suffixOf = (k: string) => {
    if (k.includes("magnify")) return "×";
    if (k.includes("slideshow")) return " 分钟";
    if (k.endsWith(".accent") || k.endsWith(".accent2")) return "";
    if (k.includes("size") || k.includes("label") || k.includes("blur")) return "px";
    return "%";
  };

  const syncSettings = () => {
    if (!settingsWin) return;
    qsa<HTMLElement>(settingsWin, ".s13-tabs [data-tab]").forEach((b) => b.classList.toggle("is-active", b.dataset.tab === settingsTab));
    qsa<HTMLElement>(settingsWin, ".s-panel").forEach((p) => {
      p.hidden = p.dataset.panel !== settingsTab;
    });
    qsa<HTMLInputElement>(settingsWin, "input[data-k]").forEach((input) => {
      const v = getPath(cfg, input.dataset.k ?? "");
      if (input.type === "checkbox") input.checked = Boolean(v);
      else input.value = String(v ?? "");
      const out = settingsWin?.querySelector<HTMLElement>(`[data-out="${input.dataset.k}"]`);
      if (out) out.textContent = `${input.value}${suffixOf(input.dataset.k ?? "")}`;
    });
    qsa<HTMLElement>(settingsWin, ".s-seg").forEach((seg) => {
      const v = String(getPath(cfg, seg.dataset.seg ?? "") ?? "");
      qsa<HTMLElement>(seg, "button").forEach((b) => b.classList.toggle("is-active", b.dataset.val === v));
    });
    qsa<HTMLElement>(settingsWin, ".preset").forEach((p) => p.classList.toggle("is-active", p.dataset.preset === cfg.preset));
    qsa<HTMLElement>(settingsWin, ".s-widget-row").forEach((row) => {
      const id = row.dataset.widgetRow ?? "";
      row.classList.toggle("is-on", ctx.widgets.on(id));
      const btn = row.querySelector<HTMLElement>("[data-wtoggle]");
      btn?.setAttribute("aria-pressed", String(ctx.widgets.on(id)));
      const size = ctx.widgets.read()[id]?.size ?? "m";
      qsa<HTMLElement>(row, "[data-wsize]").forEach((b) => b.classList.toggle("is-active", b.dataset.wsize === size));
    });
    const clockStyle = ctx.widgets.read().clock?.style ?? "digital";
    qsa<HTMLElement>(settingsWin, "[data-clock-val]").forEach((b) => b.classList.toggle("is-active", b.dataset.clockVal === clockStyle));
    renderWallGallery();
  };

  const bindSettings = () => {
    if (!settingsWin) return;
    const win = settingsWin;
    // 同一个窗口可能被重复挂载，事件只绑一次
    if (win.dataset.s13bound === "1") return;
    win.dataset.s13bound = "1";

    win.addEventListener("click", (e) => {
      const t = e.target as HTMLElement;

      const tab = t.closest<HTMLElement>("[data-tab]")?.dataset.tab;
      if (tab) {
        settingsTab = tab;
        syncSettings();
        return;
      }

      const preset = t.closest<HTMLElement>("[data-preset]")?.dataset.preset;
      if (preset) {
        applyPreset(preset);
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
        applyAll();
        save();
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
        save();
        renderWallGallery();
        return;
      }

      if (delId) {
        void removeCustom(delId);
        return;
      }

      if (wallId) {
        setWallpaper(wallId);
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
        applyAccent();
        save();
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
          arrangeIcons("grid");
          break;
        case "arrange-name":
          arrangeIcons("name");
          break;
        case "reset-icons":
          cfg.icons = deepMerge(DEFAULTS.icons, { hidden: [] });
          applyIcons();
          save();
          break;
        case "upload-wall": {
          const input = document.createElement("input");
          input.type = "file";
          input.accept = "image/jpeg,image/png,image/webp";
          input.onchange = () => {
            const f = input.files?.[0];
            if (f) void importWallpaper(f);
          };
          input.click();
          break;
        }
        case "reset-widgets": {
          ctx.widgets.write({});
          ctx.widgets.renderAll();
          cfg.widgets = { ...DEFAULTS.widgets };
          applyWidgets();
          save();
          syncSettings();
          pushToast("组件已恢复默认布局");
          break;
        }
        case "fullscreen":
          if (!document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => undefined);
          else document.exitFullscreen?.().catch(() => undefined);
          break;
        case "relayout":
          applyIconLayout();
          ctx.widgets.stack();
          pushToast("布局已重新计算");
          break;
        case "reset-desktop":
          cfg = deepMerge(DEFAULTS, { appearance: cfg.appearance });
          save();
          applyAll();
          setWallpaper(DEFAULTS.wall.id);
          ctx.widgets.write({});
          ctx.widgets.renderAll();
          syncSettings();
          pushToast("桌面已恢复默认");
          break;
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
          const payload = { version: "guandao-os/1.3", exportedAt: new Date().toISOString(), data };
          const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = `guandao-os13-${new Date().toISOString().slice(0, 10)}.json`;
          a.click();
          URL.revokeObjectURL(url);
          pushToast("设置已导出");
          break;
        }
        case "reset-all":
          if (window.confirm("清空本机所有 Guandao 数据并刷新？此操作不可撤销。")) {
            try {
              localStorage.clear();
            } catch {
              /* 忽略 */
            }
            void idbDel("__all__");
            window.location.reload();
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
      const kind = input.dataset.kind;
      let value: string | number | boolean = input.type === "checkbox" ? input.checked : input.type === "range" ? Number(input.value) : input.value;
      if (kind === "bool") value = input.checked;
      setPath(cfg as unknown as Record<string, unknown>, k, value);
      if (k === "appearance.accent" || k === "appearance.accent2") cfg.appearance.autoAccent = false;
      if (k === "appearance.mode") applyMode(value as "dark" | "light");
      applyAll();
      save();
      const out = win.querySelector<HTMLElement>(`[data-out="${k}"]`);
      if (out) out.textContent = `${input.value}${suffixOf(k)}`;
      if (k.startsWith("icons.")) applyIconLayout();
    });
  };

  syncWallUI = () => {
    if (settingsWin) syncSettings();
  };

  const mountSettings = (win: HTMLElement) => {
    settingsWin = win;
    const body = qs<HTMLElement>(win, ".win-body");
    if (!body) return;
    body.innerHTML = renderSettings();
    body.classList.add("win-body--settings13");
    bindSettings();
    syncSettings();
    // 给设置窗口一个更合适的初始尺寸（仅首次打开时）
    if (!win.dataset.s13sized) {
      win.dataset.s13sized = "1";
      win.style.width = `${Math.min(940, window.innerWidth - 80)}px`;
      win.style.height = `${Math.min(660, window.innerHeight - 120)}px`;
      win.style.left = `${Math.max(20, (window.innerWidth - Math.min(940, window.innerWidth - 80)) / 2)}px`;
      win.style.top = `${Math.max(46, (window.innerHeight - Math.min(660, window.innerHeight - 120)) / 2 - 10)}px`;
    }
  };

  const openSettings = (tab?: string) => {
    if (tab) settingsTab = tab;
    const existing = qs<HTMLElement>(ctx.windows, '.window[data-app="settings"]');
    ctx.openApp("settings");
    if (existing) {
      mountSettings(existing);
      ctx.openApp("settings");
    }
  };

  /* 监听设置窗口出现：1.2 的 renderSettings 仍会先生成，这里整体替换为 2.0 */
  const winObserver = new MutationObserver((records) => {
    for (const rec of records) {
      for (const node of Array.from(rec.addedNodes)) {
        if (!(node instanceof HTMLElement)) continue;
        const win = node.classList?.contains("window") ? node : node.querySelector?.(".window");
        if (win instanceof HTMLElement && win.dataset.app === "settings" && !win.dataset.s13) {
          win.dataset.s13 = "1";
          window.setTimeout(() => mountSettings(win), 0);
        }
      }
    }
    window.setTimeout(syncDockRunning, 20);
    updateCurrentApp();
  });
  winObserver.observe(ctx.windows, { childList: true });

  /* ============================================================
     动态桌面
     ============================================================ */
  let parallaxRaf = 0;
  let px = 0;
  let py = 0;
  window.addEventListener(
    "pointermove",
    (e) => {
      if (os.dataset.parallax !== "1") return;
      px = (e.clientX / window.innerWidth - 0.5) * -14;
      py = (e.clientY / window.innerHeight - 0.5) * -10;
      if (parallaxRaf) return;
      parallaxRaf = requestAnimationFrame(() => {
        parallaxRaf = 0;
        os.style.setProperty("--wp-px", `${px.toFixed(2)}px`);
        os.style.setProperty("--wp-py", `${py.toFixed(2)}px`);
      });
    },
    { passive: true },
  );

  /* 粒子：默认关闭，开启后才创建 canvas */
  let particleCanvas: HTMLCanvasElement | null = null;
  let particleRaf = 0;
  /** 1.9：记录 startParticles 注册的 resize 监听，停止时能精确摘掉 */
  let particleResize: (() => void) | null = null;
  const startParticles = () => {
    if (particleCanvas) return;
    const canvas = document.createElement("canvas");
    canvas.className = "wp-particles";
    wallEl.appendChild(canvas);
    particleCanvas = canvas;
    const g = canvas.getContext("2d");
    if (!g) return;
    const dots = Array.from({ length: 30 }, () => ({
      x: Math.random(),
      y: Math.random(),
      r: 0.6 + Math.random() * 1.6,
      vx: (Math.random() - 0.5) * 0.00012,
      vy: -0.00008 - Math.random() * 0.00012,
      a: 0.12 + Math.random() * 0.35,
    }));
    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = wallEl.clientWidth * dpr;
      canvas.height = wallEl.clientHeight * dpr;
      canvas.style.width = `${wallEl.clientWidth}px`;
      canvas.style.height = `${wallEl.clientHeight}px`;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const draw = () => {
      const w = wallEl.clientWidth;
      const h = wallEl.clientHeight;
      g.clearRect(0, 0, w, h);
      for (const d of dots) {
        d.x += d.vx;
        d.y += d.vy;
        if (d.y < -0.02) d.y = 1.02;
        if (d.x < -0.02) d.x = 1.02;
        if (d.x > 1.02) d.x = -0.02;
        g.beginPath();
        g.arc(d.x * w, d.y * h, d.r, 0, Math.PI * 2);
        g.fillStyle = `rgba(255,255,255,${d.a})`;
        g.fill();
      }
      particleRaf = requestAnimationFrame(draw);
    };
    draw();
    particleResize = resize;
    window.addEventListener("resize", resize, { passive: true });
  };
  const stopParticles = () => {
    if (particleResize) window.removeEventListener("resize", particleResize);
    particleResize = null;
    cancelAnimationFrame(particleRaf);
    particleCanvas?.remove();
    particleCanvas = null;
  };

  /* ============================================================
     键盘：壁纸切换
     ============================================================ */
  document.addEventListener("keydown", (e) => {
    const typing = ["INPUT", "TEXTAREA"].includes((document.activeElement as HTMLElement)?.tagName ?? "");
    if (typing) return;
    if (e.key === "[" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      stepWallpaper(-1);
    }
    if (e.key === "]" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      stepWallpaper(1);
    }
  });

  /* ============================================================
     锁屏与菜单栏当前应用
     ============================================================ */
  const currentEl = document.getElementById("mb-current");
  const updateCurrentApp = () => {
    const front = ctx.windows.querySelector<HTMLElement>(".window.is-front:not(.is-hidden-space)");
    const id = front?.dataset.app ?? "";
    const title = id ? ctx.APPS[id]?.title ?? "" : "";
    if (currentEl) {
      currentEl.hidden = !title;
      currentEl.textContent = title;
    }
  };
  document.addEventListener("pointerdown", () => window.setTimeout(updateCurrentApp, 30), true);

  const lockEl = document.createElement("div");
  lockEl.className = "lock13";
  lockEl.hidden = true;
  lockEl.innerHTML = `
    <div class="lk-inner">
      <span class="lk-brand">管</span>
      <div class="lk-time" data-lk-time>--:--</div>
      <div class="lk-date" data-lk-date></div>
      <p class="lk-hint">点击任意处，或用 Esc 解锁</p>
    </div>`;
  document.body.appendChild(lockEl);

  const tickLock = () => {
    if (lockEl.hidden) return;
    const now = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    const t = qs<HTMLElement>(lockEl, "[data-lk-time]");
    const d = qs<HTMLElement>(lockEl, "[data-lk-date]");
    if (t) t.textContent = `${p(now.getHours())}:${p(now.getMinutes())}`;
    if (d) d.textContent = now.toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "long" });
  };

  const lockScreen = () => {
    lockEl.hidden = false;
    tickLock();
    os.classList.add("is-locked");
    window.setTimeout(() => lockEl.classList.add("is-visible"), 20);
  };
  const unlockScreen = () => {
    lockEl.classList.remove("is-visible");
    os.classList.remove("is-locked");
    window.setTimeout(() => (lockEl.hidden = true), 280);
  };

  lockEl.addEventListener("click", unlockScreen);
  document.addEventListener("keydown", (e) => {
    if (!lockEl.hidden && (e.key === "Escape" || e.key === "Enter" || e.key === " ")) unlockScreen();
  });
  window.setInterval(tickLock, 1000);

  const powerMenu = document.getElementById("power-menu");
  if (powerMenu && !qs(powerMenu, '[data-power="lock"]')) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.dataset.power = "lock";
    btn.textContent = "锁定屏幕";
    powerMenu.insertBefore(btn, powerMenu.firstChild);
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      powerMenu.hidden = true;
      window.setTimeout(lockScreen, 120);
    });
  }

  /* Dock 启动时轻微跳一下 */
  dock?.addEventListener("click", (e) => {
    const item = (e.target as HTMLElement).closest<HTMLElement>(".dock-item");
    if (!item) return;
    item.classList.remove("is-launching");
    void item.offsetWidth;
    item.classList.add("is-launching");
    window.setTimeout(() => item.classList.remove("is-launching"), 620);
  });

  /* ============================================================
     启动
     ============================================================ */
  const boot = async () => {
    // 恢复自定义壁纸的 objectURL
    for (const c of cfg.custom) {
      const blob = await idbGet(c.id);
      if (blob) objUrls.set(c.id, URL.createObjectURL(blob));
    }
    if (cfg.wall.id.startsWith(CUSTOM_PREFIX) && !objUrls.has(cfg.wall.id)) cfg.wall.id = "aurora";

    applyAll();
    setWallpaper(cfg.wall.id, { silent: true, remember: false });
    buildControlCenter();
    installIcons();

    if (cfg.motion.particles) startParticles();

    // 版本号统一从 src/lib/version.ts 读取，不再各处硬编码
    qsa<HTMLElement>(document, ".mb-version").forEach((el) => (el.textContent = "1.9"));
    os.dataset.osVersion = "2.0";

    window.setInterval(tickAuto, 60_000);
    tickAuto();

    // 屏幕变化：图标与组件重新排版
    let raf = 0;
    window.addEventListener(
      "resize",
      () => {
        if (raf) return;
        raf = requestAnimationFrame(() => {
          raf = 0;
          applyDock();
          if (cfg.icons.mode === "free") applyIcons();
          else applyIconLayout();
          ctx.widgets.stack();
        });
      },
      { passive: true },
    );

    // 系统偏好变化时重新评估动效
    window.matchMedia?.("(prefers-reduced-motion: reduce)").addEventListener?.("change", applyMotion);

    // 关闭窗口时把 Dock 的“运行中”状态同步掉
    window.addEventListener("guandao:window-change", () => window.setTimeout(syncDockRunning, 30));

    syncDockRunning();
  };

  void boot();

  /* 对外暴露，便于小组件 / 终端 / 后续版本复用 */
  return {
    cfg: () => cfg,
    setWallpaper,
    applyLook,
    nextWallpaper: () => stepWallpaper(1),
    prevWallpaper: () => stepWallpaper(-1),
    applyPreset,
    openSettings,
    arrangeIcons,
    toast: pushToast,
    /** 1.6：社区壁纸下载后交给同一套壁纸引擎保存 / 应用 */
    importWallpaperFromBlob: importCommunityWallpaper,
    removeWallpaper: removeCustom,
  };
}
