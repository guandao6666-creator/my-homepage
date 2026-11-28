/**
 * Guandao OS 2.1 / 2.2 / 2.3 · 窗口分屏贴靠 + 四角象限 + 窗口置顶 + 剪贴板监听 + 快捷键一览
 *
 * 2.3 新增与修复：
 *   - 修复最小化 / 最大化类名与按钮选择器错配（is-minimized / is-maximized / .dot-max）
 *   - 新增四角 1/4 屏象限贴靠（左上 / 右上 / 左下 / 右下，Alt + Shift + 方向键）
 *   - 新增窗口置顶钉住（Always on Top，Alt + P）：置顶窗口始终浮于普通窗口之上并显示 📌 标记
 *   - 新增剪贴板与快捷片段面板呼出（Alt + V）与桌面内复制自动记录
 */
import type { Ctx } from "../os14/core";

export type Quadrant = "tl" | "tr" | "bl" | "br";

export type TileAction =
  | "tile-left"
  | "tile-right"
  | "tile-center"
  | "tile-max"
  | "tile-close"
  | "tile-grid"
  | "tile-cascade"
  | "tile-tl"
  | "tile-tr"
  | "tile-bl"
  | "tile-br"
  | "tile-pin"
  | "clipboard"
  | "shortcuts";

const SHORTCUT_GROUPS: Array<{ title: string; items: Array<[string, string]> }> = [
  {
    title: "窗口分屏与象限贴靠",
    items: [
      ["Alt + ← / →", "当前窗口贴靠左半屏 / 右半屏"],
      ["Alt + ↑ / ↓", "最大化还原 / 将当前窗口居中"],
      ["Alt + Shift + ← / ↑", "贴靠左上 1/4 屏 / 右上 1/4 屏（2.3）"],
      ["Alt + Shift + ↓ / →", "贴靠左下 1/4 屏 / 右下 1/4 屏（2.3）"],
      ["Alt + W", "关闭当前活动窗口"],
    ],
  },
  {
    title: "置顶、整理与效率（2.2 / 2.3 新增）",
    items: [
      ["Alt + P", "置顶 / 取消置顶当前窗口（Always on Top）"],
      ["Alt + G", "网格平铺全部可见窗口"],
      ["Alt + Shift + G", "层叠排列全部可见窗口"],
      ["Alt + V", "打开剪贴板与快捷片段面板"],
    ],
  },
  {
    title: "工作空间与全局导航",
    items: [
      ["Alt + 1 ~ 4", "快速切换前 4 套工作空间"],
      ["⌘K / Ctrl+K", "Spotlight 搜索 / 算式求值 / 搜笔记与任务"],
      ["Shift + ?", "打开 / 关闭此快捷键面板"],
      ["Esc", "关闭当前浮层或解锁锁屏"],
    ],
  },
];

/** 当前桌面上可见（未最小化 / 未切走工作区 / 未隐藏）的窗口，按 z-index 从上到下排序 */
const getVisibleWindows = (windowsRoot: HTMLElement): HTMLElement[] => {
  const list = Array.from(windowsRoot.querySelectorAll<HTMLElement>(".window")).filter(
    (w) =>
      !w.classList.contains("is-minimized") &&
      !w.classList.contains("is-closing") &&
      !w.classList.contains("is-hidden-space") &&
      !w.hidden &&
      w.style.display !== "none" &&
      getComputedStyle(w).display !== "none",
  );
  list.sort((a, b) => (Number(b.style.zIndex) || 0) - (Number(a.style.zIndex) || 0));
  return list;
};

const getTopWindow = (windowsRoot: HTMLElement): HTMLElement | null => getVisibleWindows(windowsRoot)[0] ?? null;

const workArea = () => {
  const top = 42;
  const bottom = 86;
  const pad = 10;
  const w = Math.max(320, window.innerWidth - pad * 2);
  const h = Math.max(260, window.innerHeight - top - bottom);
  return { x: pad, y: top, w, h, gap: 8 };
};

/** 四角 1/4 屏象限几何计算（纯函数，便于单测） */
export const quadrantRect = (
  quad: Quadrant,
  area: { x: number; y: number; w: number; h: number; gap: number },
): { x: number; y: number; w: number; h: number } => {
  const halfW = Math.floor((area.w - area.gap) / 2);
  const halfH = Math.floor((area.h - area.gap) / 2);
  const rightX = area.x + halfW + area.gap;
  const bottomY = area.y + halfH + area.gap;
  switch (quad) {
    case "tl":
      return { x: area.x, y: area.y, w: halfW, h: halfH };
    case "tr":
      return { x: rightX, y: area.y, w: halfW, h: halfH };
    case "bl":
      return { x: area.x, y: bottomY, w: halfW, h: halfH };
    case "br":
      return { x: rightX, y: bottomY, w: halfW, h: halfH };
  }
};

/**
 * 网格布局计算（纯函数，便于单测）：n 个窗口 → 尽量接近正方形的 cols × rows，
 * 最后一行不足时拉宽填满。返回每个窗口的 { x, y, w, h }。
 */
export const gridLayout = (
  n: number,
  area: { x: number; y: number; w: number; h: number; gap: number },
): Array<{ x: number; y: number; w: number; h: number }> => {
  if (n <= 0) return [];
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const cellH = Math.floor((area.h - area.gap * (rows - 1)) / rows);
  const out: Array<{ x: number; y: number; w: number; h: number }> = [];
  for (let i = 0; i < n; i++) {
    const row = Math.floor(i / cols);
    const inRow = row === rows - 1 ? n - cols * (rows - 1) : cols;
    const col = i - row * cols;
    const cellW = Math.floor((area.w - area.gap * (inRow - 1)) / inRow);
    out.push({
      x: area.x + col * (cellW + area.gap),
      y: area.y + row * (cellH + area.gap),
      w: cellW,
      h: cellH,
    });
  }
  return out;
};

const applyRect = (win: HTMLElement, r: { x: number; y: number; w: number; h: number }) => {
  win.classList.remove("is-maximized");
  win.style.left = `${r.x}px`;
  win.style.top = `${r.y}px`;
  win.style.width = `${r.w}px`;
  win.style.height = `${r.h}px`;
};

const tileWindow = (win: HTMLElement, mode: "left" | "right" | "center" | "max" | Quadrant) => {
  const area = workArea();
  if (mode === "tl" || mode === "tr" || mode === "bl" || mode === "br") {
    applyRect(win, quadrantRect(mode, area));
    return;
  }
  if (mode === "left") {
    const half = Math.floor((area.w - area.gap) / 2);
    applyRect(win, { x: area.x, y: area.y, w: half, h: area.h });
    return;
  }
  if (mode === "right") {
    const half = Math.floor((area.w - area.gap) / 2);
    applyRect(win, { x: area.x + half + area.gap, y: area.y, w: half, h: area.h });
    return;
  }
  if (mode === "center") {
    win.classList.remove("is-maximized");
    const w = Math.min(Math.max(win.offsetWidth || 720, 420), area.w - 40);
    const h = Math.min(Math.max(win.offsetHeight || 500, 320), area.h - 24);
    applyRect(win, {
      x: Math.round((window.innerWidth - w) / 2),
      y: Math.round(area.y + (area.h - h) / 2),
      w: Math.round(w),
      h: Math.round(h),
    });
    return;
  }
  const maxBtn = win.querySelector<HTMLButtonElement>(".dot-max, .win-max, [data-win-act='max']");
  if (maxBtn) {
    maxBtn.click();
  } else {
    applyRect(win, { x: area.x, y: area.y, w: area.w, h: area.h });
  }
};

const arrangeGrid = (wins: HTMLElement[]) => {
  const ordered = [...wins].sort((a, b) => a.offsetTop - b.offsetTop || a.offsetLeft - b.offsetLeft);
  const cells = gridLayout(ordered.length, workArea());
  ordered.forEach((win, i) => applyRect(win, cells[i]));
};

const arrangeCascade = (wins: HTMLElement[]) => {
  const area = workArea();
  const step = 32;
  const w = Math.round(Math.min(860, Math.max(420, area.w * 0.6)));
  const h = Math.round(Math.min(600, Math.max(300, area.h * 0.72)));
  const maxSteps = Math.max(1, Math.floor(Math.min(area.w - w, area.h - h) / step));
  [...wins].reverse().forEach((win, i) => {
    const k = i % (maxSteps + 1);
    applyRect(win, { x: area.x + 20 + k * step, y: area.y + 12 + k * step, w, h });
  });
};

let pinTopCounter = 5000;

export const togglePinWindow = (win: HTMLElement, focusWin: (w: HTMLElement) => void): boolean => {
  const next = win.dataset.pinned !== "1";
  if (next) {
    win.dataset.pinned = "1";
    win.classList.add("is-pinned");
    win.style.zIndex = String(++pinTopCounter);
    const bar = win.querySelector<HTMLElement>(".titlebar");
    if (bar && !bar.querySelector("[data-win-pin-badge]")) {
      const badge = document.createElement("span");
      badge.dataset.winPinBadge = "1";
      badge.textContent = "📌 置顶";
      Object.assign(badge.style, {
        marginLeft: "auto",
        fontSize: "11px",
        padding: "1px 7px",
        borderRadius: "999px",
        background: "rgba(111,140,255,0.24)",
        color: "#dbe6ff",
        pointerEvents: "none",
      });
      bar.appendChild(badge);
    }
  } else {
    delete win.dataset.pinned;
    win.classList.remove("is-pinned");
    win.querySelector("[data-win-pin-badge]")?.remove();
    focusWin(win);
  }
  return next;
};

let overlayEl: HTMLElement | null = null;

export const toggleShortcutCheatsheet = () => {
  if (overlayEl && overlayEl.isConnected) {
    overlayEl.remove();
    overlayEl = null;
    return;
  }

  const backdrop = document.createElement("div");
  backdrop.className = "os21-kbd-backdrop";
  backdrop.setAttribute("role", "dialog");
  backdrop.setAttribute("aria-modal", "true");
  backdrop.setAttribute("aria-label", "Guandao OS 快捷键一览");
  Object.assign(backdrop.style, {
    position: "fixed",
    inset: "0",
    zIndex: "9990",
    display: "grid",
    placeItems: "center",
    background: "rgba(8, 10, 16, 0.56)",
    backdropFilter: "blur(10px)",
    padding: "16px",
  });

  const panel = document.createElement("div");
  Object.assign(panel.style, {
    width: "min(580px, 100%)",
    maxHeight: "82vh",
    overflowY: "auto",
    borderRadius: "16px",
    border: "1px solid rgba(255, 255, 255, 0.14)",
    background: "rgba(22, 26, 38, 0.94)",
    color: "#eef1f7",
    padding: "20px 22px",
    boxShadow: "0 24px 64px -20px rgba(0, 0, 0, 0.85)",
  });

  const head = document.createElement("div");
  Object.assign(head.style, {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: "14px",
  });

  const titleWrap = document.createElement("div");
  const h2 = document.createElement("h2");
  h2.textContent = "Guandao OS 2.3 · 快捷键一览";
  Object.assign(h2.style, { margin: "0", fontSize: "16px", fontWeight: "650" });
  const sub = document.createElement("p");
  sub.textContent = "Studio Horizon · 用键盘高效管理窗口、剪贴板与工作空间";
  Object.assign(sub.style, { margin: "3px 0 0", fontSize: "12px", opacity: "0.65" });
  titleWrap.append(h2, sub);

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.textContent = "关闭";
  Object.assign(closeBtn.style, {
    border: "1px solid rgba(255,255,255,0.16)",
    background: "rgba(255,255,255,0.08)",
    color: "#eef1f7",
    borderRadius: "8px",
    padding: "5px 11px",
    fontSize: "12px",
    cursor: "pointer",
  });
  closeBtn.addEventListener("click", () => toggleShortcutCheatsheet());
  head.append(titleWrap, closeBtn);
  panel.appendChild(head);

  for (const group of SHORTCUT_GROUPS) {
    const sec = document.createElement("section");
    sec.style.marginTop = "14px";
    const gt = document.createElement("p");
    gt.textContent = group.title;
    Object.assign(gt.style, {
      margin: "0 0 8px",
      fontSize: "11.5px",
      opacity: "0.6",
      letterSpacing: "0.04em",
    });
    sec.appendChild(gt);

    const list = document.createElement("div");
    Object.assign(list.style, { display: "grid", gap: "6px" });
    for (const [keys, desc] of group.items) {
      const row = document.createElement("div");
      Object.assign(row.style, {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "12px",
        padding: "8px 10px",
        borderRadius: "9px",
        background: "rgba(255, 255, 255, 0.04)",
      });
      const label = document.createElement("span");
      label.textContent = desc;
      label.style.fontSize = "13px";
      const kbd = document.createElement("kbd");
      kbd.textContent = keys;
      Object.assign(kbd.style, {
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: "11.5px",
        padding: "3px 8px",
        borderRadius: "6px",
        border: "1px solid rgba(255,255,255,0.16)",
        background: "rgba(255,255,255,0.08)",
        color: "#c7d6ff",
        flex: "none",
      });
      row.append(label, kbd);
      list.appendChild(row);
    }
    sec.appendChild(list);
    panel.appendChild(sec);
  }

  backdrop.appendChild(panel);
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) toggleShortcutCheatsheet();
  });

  document.body.appendChild(backdrop);
  overlayEl = backdrop;
};

export const initOs21Tiling = (ctx: Ctx) => {
  if ((window as unknown as { __os21Tiling?: boolean }).__os21Tiling) return;
  (window as unknown as { __os21Tiling?: boolean }).__os21Tiling = true;

  // 2.3：自动记录本页面内的复制文本（排除密码框），供 Alt+V 剪贴板面板使用
  document.addEventListener("copy", () => {
    const active = document.activeElement;
    if (active instanceof HTMLInputElement && active.type === "password") return;
    let selected = window.getSelection()?.toString() ?? "";
    if (!selected && (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement)) {
      selected = active.value.slice(active.selectionStart ?? 0, active.selectionEnd ?? 0);
    }
    const text = selected.trim();
    if (!text) return;
    void import("../os23/clipboard").then((m) => m.recordClipText(text));
  });

  const dispatch = (action: TileAction) => {
    if (action === "shortcuts") {
      toggleShortcutCheatsheet();
      return;
    }
    if (action === "clipboard") {
      void import("../os23/clipboard").then((m) => m.toggleClipboardDrawer(ctx));
      return;
    }
    if (action === "tile-grid" || action === "tile-cascade") {
      const wins = getVisibleWindows(ctx.windows);
      if (!wins.length) {
        ctx.toast("当前没有可整理的窗口");
        return;
      }
      if (action === "tile-grid") {
        arrangeGrid(wins);
        ctx.toast(`已网格平铺 ${wins.length} 个窗口`);
      } else {
        arrangeCascade(wins);
        ctx.toast(`已层叠排列 ${wins.length} 个窗口`);
      }
      return;
    }
    const win = getTopWindow(ctx.windows);
    if (!win) {
      ctx.toast("当前没有可操作的活动窗口");
      return;
    }
    switch (action) {
      case "tile-left":
        tileWindow(win, "left");
        ctx.toast("已贴靠到左半屏");
        break;
      case "tile-right":
        tileWindow(win, "right");
        ctx.toast("已贴靠到右半屏");
        break;
      case "tile-center":
        tileWindow(win, "center");
        ctx.toast("已居中窗口");
        break;
      case "tile-max":
        tileWindow(win, "max");
        break;
      case "tile-close":
        ctx.closeWin(win);
        break;
      case "tile-tl":
        tileWindow(win, "tl");
        ctx.toast("已贴靠到左上 1/4 屏");
        break;
      case "tile-tr":
        tileWindow(win, "tr");
        ctx.toast("已贴靠到右上 1/4 屏");
        break;
      case "tile-bl":
        tileWindow(win, "bl");
        ctx.toast("已贴靠到左下 1/4 屏");
        break;
      case "tile-br":
        tileWindow(win, "br");
        ctx.toast("已贴靠到右下 1/4 屏");
        break;
      case "tile-pin": {
        const pinned = togglePinWindow(win, ctx.focusWin);
        ctx.toast(pinned ? "窗口已置顶（Alt+P 取消）" : "已取消窗口置顶");
        break;
      }
    }
  };

  window.addEventListener("guandao:os21-action", (event) => {
    const detail = (event as CustomEvent<TileAction>).detail;
    if (detail) dispatch(detail);
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && overlayEl && overlayEl.isConnected) {
      e.preventDefault();
      toggleShortcutCheatsheet();
      return;
    }
    const el = document.activeElement as HTMLElement | null;
    const typing =
      el &&
      (el.tagName === "TEXTAREA" ||
        el.isContentEditable ||
        (el.tagName === "INPUT" &&
          !["checkbox", "radio", "file", "button", "range", "color", "submit"].includes((el as HTMLInputElement).type)));

    // Alt + V 在任何时候都可呼出剪贴板面板（方便在输入框旁查找片段）
    if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.key.toLowerCase() === "v") {
      e.preventDefault();
      dispatch("clipboard");
      return;
    }

    if (typing) return;

    if (e.key === "?" && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      toggleShortcutCheatsheet();
      return;
    }

    if (!e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.shiftKey) {
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        dispatch("tile-tl");
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        dispatch("tile-tr");
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        dispatch("tile-bl");
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        dispatch("tile-br");
      } else if (e.code === "KeyG" || e.key.toLowerCase() === "g") {
        e.preventDefault();
        dispatch("tile-cascade");
      }
      return;
    }

    if (e.key === "ArrowLeft") {
      e.preventDefault();
      dispatch("tile-left");
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      dispatch("tile-right");
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      dispatch("tile-max");
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      dispatch("tile-center");
    } else if (e.key.toLowerCase() === "w") {
      e.preventDefault();
      dispatch("tile-close");
    } else if (e.code === "KeyG" || e.key.toLowerCase() === "g") {
      e.preventDefault();
      dispatch("tile-grid");
    } else if (e.code === "KeyP" || e.key.toLowerCase() === "p") {
      e.preventDefault();
      dispatch("tile-pin");
    }
  });
};
