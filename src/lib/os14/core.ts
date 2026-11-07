/**
 * Guandao OS 1.4 · Ecosystem Evolution —— 核心工具层
 *
 * 这一层只提供「与具体功能无关」的基础能力：
 *   - localStorage 安全读写（隐私模式 / 配额溢出都不炸）
 *   - IndexedDB 大对象存储（图片 / 音频 / 备份，避免塞进 localStorage）
 *   - DOM 小工具、事件总线、格式化、Markdown 轻量渲染
 *   - 全应用共用的 Ctx 类型
 *
 * 约定：1.4 的键名统一走 `guandao.os14.*`，不改动 1.0–1.3 已有键。
 */

/* 2.3：HTML 转义统一到 src/lib/html.ts。
   这里 import 进来是因为本文件内部有 14 处调用，再 export 出去是为了
   保持「从 os14/core 引 escapeHtml」的历史调用点不动。 */
import { escapeHtml } from "../html";

/* ============================================================
   类型
   ============================================================ */

export type OsThemeMode = "dark" | "light";
export type Material = "glass" | "frost" | "solid";
export type RadiusStyle = "soft" | "round" | "sharp";
export type FontTone = "sans" | "serif" | "mono";
export type DockPos = "bottom" | "left" | "right";

export type LazyAppModule = {
  body: () => string;
  init?: (win: HTMLElement) => void | (() => void);
};

export type AppSpec = {
  id: string;
  title: string;
  width: number;
  height: number;
  glyph?: string;
  body: () => string;
  /** 返回清理函数：窗口关闭时调用，游戏循环 / 定时器必须在这里停掉 */
  init?: (win: HTMLElement) => void | (() => void);
  /**
   * 1.9：按需加载。提供 load 时，窗口先显示骨架，
   * 模块下载完成后再渲染真实内容；同一会话内不重复下载。
   */
  load?: () => Promise<LazyAppModule>;
};

export type WidgetSpec = {
  id: string;
  title: string;
  desc: string;
  category: string;
  body: () => string;
  init?: (el: HTMLElement) => void;
  defaultOn?: boolean;
  w?: number;
};

export type WinStateLike = {
  left: number;
  top: number;
  width: number;
  height: number;
  minimized: boolean;
  maximized: boolean;
  space: number;
};

export type AppMetaLike = { title: string; width: number; height: number; glyph?: string };

export type Ctx = {
  os: HTMLElement;
  windows: HTMLElement;
  desk: HTMLElement;
  openApp: (id: string) => void;
  closeWin: (win: HTMLElement) => void;
  focusWin: (win: HTMLElement) => void;
  openSettings: (tab?: string) => void;
  pushNotif: (n: { icon: string; title: string; body: string }) => void;
  toast: (msg: string) => void;
  escapeHtml: (s: unknown) => string;
  registerApp: (spec: AppSpec) => void;
  unregisterApp: (id: string) => void;
  APPS: Record<string, AppMetaLike & { body?: () => string }>;
  APP_ICON: Record<string, string>;
  readState: () => Record<string, unknown>;
  writeState: (patch: Record<string, unknown>) => void;
  dock: { read: () => string[]; save: (list: string[]) => void; render: () => void };
  widgets: {
    ids: string[];
    titles: Record<string, string>;
    desc: Record<string, string>;
    on: (id: string) => boolean;
    setEnabled: (id: string, on: boolean) => void;
    render: (id: string) => void;
    renderAll: () => void;
    stack: () => void;
    register: (spec: WidgetSpec) => void;
    state: () => Record<string, { x?: number; y?: number; enabled?: boolean; size?: "s" | "m" | "l" }>;
  };
  /** 1.3 暴露的壁纸 / 外观 API */
  api13: {
    cfg: () => Record<string, unknown>;
    setWallpaper: (id: string) => void;
    nextWallpaper: () => void;
    applyPreset: (id: string) => void;
    applyLook: (look: Record<string, unknown>) => void;
    openSettings: (tab?: string) => void;
    toast: (msg: string) => void;
  };
  /** 1.4 需要拦截的窗口级能力 */
  setDockFilter: (fn: ((id: string) => boolean) | null) => void;
  setLaunchGuard: (fn: (id: string) => boolean) => void;
  onBeforeClose: (cb: (win: HTMLElement) => void) => void;
  buildShortcut: (id: string, title: string, glyph: string) => HTMLElement | null;
  relayoutIcons: () => void;
  /** 工作空间切场景用：先关窗，再按快照重开 */
  restoreWindows: (map: Record<string, WinStateLike>, ids: string[]) => Promise<void>;
  closeAllWindows: () => void;
  /**
   * 2.0：桌面外壳暴露的窗口级操作。
   * Core 的 WindowManager 通过它复用 1.x 的窗口实现，不重复写拖动 / 缩放。
   */
  shellOps?: {
    minimize: (win: HTMLElement) => void;
    restore: (win: HTMLElement) => void;
    maximize: (win: HTMLElement) => void;
    moveToSpace: (win: HTMLElement, space: number) => void;
  };
};

/* ============================================================
   localStorage
   ============================================================ */

export const NS = "guandao.";

export const ls = {
  get<T>(key: string, fallback: T): T {
    try {
      const raw = localStorage.getItem(key);
      if (raw == null) return fallback;
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  },
  str(key: string, fallback = ""): string {
    try {
      return localStorage.getItem(key) ?? fallback;
    } catch {
      return fallback;
    }
  },
  set(key: string, value: unknown): boolean {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  },
  setStr(key: string, value: string): boolean {
    try {
      localStorage.setItem(key, value);
      return true;
    } catch {
      return false;
    }
  },
  del(key: string) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* 忽略 */
    }
  },
  /** 统计 guandao.* 占用的字节数（UTF-16 近似值，界面标注为估算） */
  bytes(prefix = "guandao."): number {
    let total = 0;
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k || !k.startsWith(prefix)) continue;
        total += (k.length + (localStorage.getItem(k) || "").length) * 2;
      }
    } catch {
      /* 忽略 */
    }
    return total;
  },
  keys(prefix = "guandao."): string[] {
    const out: string[] = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(prefix)) out.push(k);
      }
    } catch {
      /* 忽略 */
    }
    return out;
  },
};

/* ============================================================
   IndexedDB（图片 / 音频 / 备份）
   ============================================================ */

const DB_NAME = "guandao-os14";
const DB_VER = 1;
const STORES = ["blobs", "backups"] as const;
export type StoreName = (typeof STORES)[number];

let dbPromise: Promise<IDBDatabase | null> | null = null;

export const openDb = (): Promise<IDBDatabase | null> => {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined") return resolve(null);
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const name of STORES) {
          if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
};

export const idb = {
  async put(store: StoreName, key: string, value: unknown): Promise<boolean> {
    const db = await openDb();
    if (!db) return false;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(store, "readwrite");
        tx.objectStore(store).put(value, key);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
        tx.onabort = () => resolve(false);
      } catch {
        resolve(false);
      }
    });
  },
  async get<T>(store: StoreName, key: string): Promise<T | null> {
    const db = await openDb();
    if (!db) return null;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(store, "readonly");
        const req = tx.objectStore(store).get(key);
        req.onsuccess = () => resolve((req.result as T) ?? null);
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  },
  async del(store: StoreName, key: string): Promise<void> {
    const db = await openDb();
    if (!db) return;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(store, "readwrite");
        tx.objectStore(store).delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
        tx.onabort = () => resolve();
      } catch {
        resolve();
      }
    });
  },
  async keys(store: StoreName): Promise<string[]> {
    const db = await openDb();
    if (!db) return [];
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(store, "readonly");
        const req = tx.objectStore(store).getAllKeys();
        req.onsuccess = () => resolve((req.result as IDBValidKey[]).map(String));
        req.onerror = () => resolve([]);
      } catch {
        resolve([]);
      }
    });
  },
  async entries<T>(store: StoreName): Promise<Array<[string, T]>> {
    const db = await openDb();
    if (!db) return [];
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(store, "readonly");
        const os = tx.objectStore(store);
        const out: Array<[string, T]> = [];
        const req = os.openCursor();
        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor) return resolve(out);
          out.push([String(cursor.key), cursor.value as T]);
          cursor.continue();
        };
        req.onerror = () => resolve(out);
      } catch {
        resolve([]);
      }
    });
  },
  /** 粗估占用：Blob.size 精确，其余按 JSON 长度 */
  async size(store: StoreName): Promise<number> {
    const rows = await idb.entries<unknown>(store);
    let total = 0;
    for (const [, v] of rows) {
      if (v instanceof Blob) total += v.size;
      else if (typeof v === "string") total += v.length * 2;
      else {
        try {
          total += JSON.stringify(v).length * 2;
        } catch {
          total += 1024;
        }
      }
    }
    return total;
  },
};

/* ============================================================
   DOM / 事件
   ============================================================ */

export const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document): T | null =>
  root.querySelector(sel) as T | null;

export const $$ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document): T[] =>
  Array.from(root.querySelectorAll(sel)) as T[];

export const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  html?: string,
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (html != null) node.innerHTML = html;
  return node;
};

/**
 * 2.3：实现已统一到 `src/lib/html.ts`，这里只做转出。
 *
 * 行为变化（相对 1.x 本文件旧实现）：无。旧实现就是 5 字符转义 + null 安全，
 * 与统一模块完全一致。差异出现在四个 Astro 页面（原本只转 4 个字符）。
 */
export { escapeHtml };

export const on = <K extends keyof HTMLElementEventMap>(
  node: EventTarget | null,
  type: K,
  handler: (event: HTMLElementEventMap[K]) => void,
  opts?: AddEventListenerOptions,
): (() => void) => {
  if (!node) return () => undefined;
  node.addEventListener(type, handler as EventListener, opts);
  return () => node.removeEventListener(type, handler as EventListener, opts);
};

/** 事件委托：只在根节点挂一次监听，子节点再多也不增加监听器 */
export const delegate = <T extends HTMLElement = HTMLElement>(
  root: HTMLElement,
  selector: string,
  type: keyof HTMLElementEventMap,
  handler: (target: T, event: Event) => void,
): void => {
  root.addEventListener(type, (event) => {
    const t = (event.target as HTMLElement | null)?.closest<T>(selector);
    if (t && root.contains(t)) handler(t, event);
  });
};

export const bus = new EventTarget();

export const emit = (name: string, detail?: unknown) => {
  bus.dispatchEvent(new CustomEvent(name, { detail }));
  // 同时抛到 window，方便外部脚本 / 测试观察
  window.dispatchEvent(new CustomEvent(`guandao:${name}`, { detail }));
};

export const onBus = (name: string, fn: (detail: unknown) => void): (() => void) => {
  const wrapped = (e: Event) => fn((e as CustomEvent).detail);
  bus.addEventListener(name, wrapped);
  return () => bus.removeEventListener(name, wrapped);
};

/* ============================================================
   格式化 / 工具
   ============================================================ */

export const uid = (): string => {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  } catch {
    /* 忽略 */
  }
  return `g-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
};

export const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));

export const pad2 = (n: number) => String(n).padStart(2, "0");

export const fmtBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
};

export const fmtDate = (ts: number): string => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};

export const fmtDateTime = (ts: number): string => {
  const d = new Date(ts);
  return `${fmtDate(ts)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

export const fmtAgo = (ts: number): string => {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 2_592_000_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  return fmtDate(ts);
};

export const todayKey = (d = new Date()): string => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

export const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

export const monthMatrix = (year: number, month: number): Date[][] => {
  const first = new Date(year, month, 1);
  const start = new Date(year, month, 1 - ((first.getDay() + 6) % 7)); // 周一为一周起点
  const rows: Date[][] = [];
  for (let w = 0; w < 6; w++) {
    const row: Date[] = [];
    for (let d = 0; d < 7; d++) {
      const cur = new Date(start);
      cur.setDate(start.getDate() + w * 7 + d);
      row.push(cur);
    }
    rows.push(row);
  }
  return rows;
};

export const debounce = <A extends unknown[]>(fn: (...args: A) => void, ms: number) => {
  let timer = 0;
  return (...args: A) => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => fn(...args), ms);
  };
};

export const download = (filename: string, content: string | Blob, mime = "application/json;charset=utf-8") => {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1500);
};

export const pickFile = (accept: string, multiple = false, onFiles?: (files: File[]) => void) => {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = accept;
  input.multiple = multiple;
  input.style.position = "fixed";
  input.style.left = "-9999px";
  document.body.appendChild(input);
  input.addEventListener("change", () => {
    const files = Array.from(input.files ?? []);
    input.remove();
    if (files.length) onFiles?.(files);
  });
  input.click();
};

export const readText = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error("读取失败"));
    reader.readAsText(file);
  });

/** 图片压缩到最长边 max，返回 webp/jpeg Blob（IndexedDB 存原图太占空间） */
export const compressImage = async (file: File, max = 1600, quality = 0.86): Promise<Blob> => {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.size < 900_000) return file;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", quality));
    return blob ?? file;
  } catch {
    return file;
  }
};

/* ============================================================
   轻量 Markdown 渲染
   —— 先整体转义，再把受限语法换成标签，绝不执行外部 HTML
   ============================================================ */

const inlineMd = (text: string): string => {
  let s = escapeHtml(text);
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
  s = s.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  s = s.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noreferrer noopener">$1</a>',
  );
  return s;
};

/** 支持的语法：标题 / 列表 / 引用 / 代码块 / 分割线 / 粗斜体 / 行内代码 / 链接 */
export const renderMarkdown = (src: string): string => {
  const lines = String(src ?? "").replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let inCode = false;
  let listType: "ul" | "ol" | null = null;
  let inQuote = false;

  const closeList = () => {
    if (listType) {
      out.push(`</${listType}>`);
      listType = null;
    }
  };
  const closeQuote = () => {
    if (inQuote) {
      out.push("</blockquote>");
      inQuote = false;
    }
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");

    if (/^```/.test(line)) {
      closeList();
      closeQuote();
      if (inCode) {
        out.push("</code></pre>");
        inCode = false;
      } else {
        out.push("<pre><code>");
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      out.push(`${escapeHtml(raw)}\n`);
      continue;
    }
    if (!line.trim()) {
      closeList();
      closeQuote();
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      closeList();
      closeQuote();
      const level = h[1].length + 2; // h1 → h3 视觉上更克制
      out.push(`<h${level}>${inlineMd(h[2])}</h${level}>`);
      continue;
    }
    if (/^(-{3,}|\*{3,})$/.test(line.trim())) {
      closeList();
      closeQuote();
      out.push("<hr/>");
      continue;
    }
    const q = /^>\s?(.*)$/.exec(line);
    if (q) {
      closeList();
      if (!inQuote) {
        out.push("<blockquote>");
        inQuote = true;
      }
      out.push(`<p>${inlineMd(q[1])}</p>`);
      continue;
    }
    closeQuote();
    const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ul || ol) {
      const want = ul ? "ul" : "ol";
      if (listType !== want) {
        closeList();
        out.push(`<${want}>`);
        listType = want;
      }
      out.push(`<li>${inlineMd((ul ?? ol)![1])}</li>`);
      continue;
    }
    closeList();
    out.push(`<p>${inlineMd(line)}</p>`);
  }
  closeList();
  closeQuote();
  if (inCode) out.push("</code></pre>");
  return out.join("\n");
};

/* ============================================================
   通用 UI 小件（弹窗 / 空态 / 分段控件）
   ============================================================ */

export type ModalAction = { label: string; value: string; danger?: boolean; primary?: boolean };

/** 在窗口内部弹一个确认框；返回用户选择的值（关闭则 null） */
export const modal = (
  host: HTMLElement,
  opts: { title: string; body?: string; actions?: ModalAction[]; wide?: boolean },
): Promise<string | null> =>
  new Promise((resolve) => {
    const wrap = el("div", "g14-modal");
    const actions = opts.actions ?? [
      { label: "取消", value: "" },
      { label: "确定", value: "ok", primary: true },
    ];
    wrap.innerHTML = `
      <div class="g14-modal-card${opts.wide ? " is-wide" : ""}" role="dialog" aria-modal="true">
        <p class="g14-modal-title">${escapeHtml(opts.title)}</p>
        ${opts.body ? `<div class="g14-modal-body">${opts.body}</div>` : ""}
        <div class="g14-modal-actions">
          ${actions
            .map(
              (a) =>
                `<button class="g14-btn ${a.primary ? "is-primary" : ""} ${a.danger ? "is-danger" : ""}" type="button" data-mv="${escapeHtml(a.value)}">${escapeHtml(a.label)}</button>`,
            )
            .join("")}
        </div>
      </div>`;
    host.appendChild(wrap);
    // 先 resolve 再移除：调用方常在 then 里回读弹窗里的 input，
    // 如果同步删掉 DOM，读到的就是空值。留一个宏任务再清理。
    const done = (v: string | null) => {
      resolve(v);
      window.setTimeout(() => wrap.remove(), 0);
    };
    wrap.addEventListener("click", (e) => {
      if (e.target === wrap) done(null);
      const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-mv]");
      if (btn) {
        done(btn.dataset.mv ?? "");
        return;
      }
      // 菜单式弹窗：点 .g14-menu-item[data-mm] 就等于选中它的值
      const item = (e.target as HTMLElement).closest<HTMLElement>(".g14-menu-item[data-mm]");
      if (item) done(item.dataset.mm ?? "");
    });
  });

export const emptyState = (title: string, sub = "", icon = "◌") => `
  <div class="g14-empty">
    <span class="g14-empty-ico">${escapeHtml(icon)}</span>
    <p class="g14-empty-title">${escapeHtml(title)}</p>
    ${sub ? `<p class="g14-empty-sub">${escapeHtml(sub)}</p>` : ""}
  </div>`;

export const badge = (text: string, tone: "accent" | "ok" | "warn" | "danger" | "mute" = "mute") =>
  `<span class="g14-badge is-${tone}">${escapeHtml(text)}</span>`;

/** 统一的应用外壳：左侧导航 + 右侧内容 */
export const shell = (id: string, nav: Array<[string, string, string]>, body: string, title: string) => `
  <div class="g14-shell" data-g14="${escapeHtml(id)}">
    <aside class="g14-side">
      <p class="g14-side-title">${escapeHtml(title)}</p>
      ${nav
        .map(
          ([key, label, ico], i) =>
            `<button class="g14-nav${i === 0 ? " is-active" : ""}" type="button" data-tab="${escapeHtml(key)}"><span>${ico}</span>${escapeHtml(label)}</button>`,
        )
        .join("")}
    </aside>
    <section class="g14-main">${body}</section>
  </div>`;

/** 侧栏切换：返回当前 tab，并在点击时回调 */
export const bindTabs = (win: HTMLElement, onChange: (tab: string) => void) => {
  const root = win.querySelector<HTMLElement>(".g14-shell") ?? win;
  root.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>(".g14-nav[data-tab]");
    if (!btn) return;
    root.querySelectorAll(".g14-nav").forEach((n) => n.classList.toggle("is-active", n === btn));
    onChange(btn.dataset.tab ?? "");
  });
};
