/**
 * Guandao OS 2.1 / 2.2 · 窗口分屏贴靠 + 智能整理 + 全局快捷键 + 快捷键一览面板
 *
 * 快捷键（输入框内自动屏蔽）：
 *   - Alt + ← : 当前窗口左半屏贴靠
 *   - Alt + → : 当前窗口右半屏贴靠
 *   - Alt + ↑ : 最大化 / 还原当前窗口
 *   - Alt + ↓ : 居中当前窗口
 *   - Alt + W : 关闭当前窗口
 *   - Alt + G : 网格平铺全部可见窗口（2.2）
 *   - Alt + Shift + G : 层叠排列全部可见窗口（2.2）
 *   - Shift + ? : 打开 / 关闭快捷键一览面板
 *
 * 全部 DOM 均使用 createElement / textContent 构建，无 innerHTML 风险。
 */
import type { Ctx } from "../os14/core";

export type TileAction =
  | "tile-left"
  | "tile-right"
  | "tile-center"
  | "tile-max"
  | "tile-close"
  | "tile-grid"
  | "tile-cascade"
  | "shortcuts";

const SHORTCUT_GROUPS: Array<{ title: string; items: Array<[string, string]> }> = [
  {
    title: "窗口分屏与管理",
    items: [
      ["Alt + ←", "当前窗口贴靠左半屏"],
      ["Alt + →", "当前窗口贴靠右半屏"],
      ["Alt + ↑", "最大化 / 还原当前窗口"],
      ["Alt + ↓", "将当前窗口居中"],
      ["Alt + W", "关闭当前活动窗口"],
    ],
  },
  {
    title: "智能整理（2.2 新增）",
    items: [
      ["Alt + G", "网格平铺全部可见窗口"],
      ["Alt + Shift + G", "层叠排列全部可见窗口"],
    ],
  },
  {
    title: "工作空间与导航",
    items: [
      ["Alt + 1 ~ 4", "快速切换前 4 套工作空间"],
      ["⌘K / Ctrl+K", "打开 Spotlight 全局搜索"],
      ["Shift + ?", "打开 / 关闭此快捷键面板"],
      ["Esc", "关闭当前浮层或解锁锁屏"],
    ],
  },
];

/** 当前桌面上可见（未最小化 / 未隐藏）的窗口，按 z-index 从上到下排序 */
const getVisibleWindows = (windowsRoot: HTMLElement): HTMLElement[] => {
  const list = Array.from(windowsRoot.querySelectorAll<HTMLElement>(".window")).filter(
    (w) =>
      !w.classList.contains("is-min") &&
      !w.classList.contains("is-hidden-space") &&
      !w.hidden &&
      w.style.display !== "none" &&
      getComputedStyle(w).display !== "none",
  );
  list.sort((a, b) => (Number(b.style.zIndex) || 0) - (Number(a.style.zIndex) || 0));
  return list;
};

const getTopWindow = (windowsRoot: HTMLElement): HTMLElement | null => getVisibleWindows(windowsRoot)[0] ?? null;

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

const arrangeGrid = (wins: HTMLElement[]) => {
  // 按屏幕位置（从上到下、从左到右）排序，整理后窗口相对位置尽量不乱跳
  const ordered = [...wins].sort((a, b) => a.offsetTop - b.offsetTop || a.offsetLeft - b.offsetLeft);
  const cells = gridLayout(ordered.length, workArea());
  ordered.forEach((win, i) => {
    const c = cells[i];
    win.classList.remove("is-max");
    win.style.left = `${c.x}px`;
    win.style.top = `${c.y}px`;
    win.style.width = `${c.w}px`;
    win.style.height = `${c.h}px`;
  });
};

const arrangeCascade = (wins: HTMLElement[]) => {
  const area = workArea();
  const step = 32;
  const w = Math.round(Math.min(860, Math.max(420, area.w * 0.6)));
  const h = Math.round(Math.min(600, Math.max(300, area.h * 0.72)));
  const maxSteps = Math.max(1, Math.floor(Math.min(area.w - w, area.h - h) / step));
  // 自底向上排，原先在最上层的窗口仍在最上层、位于层叠末端
  [...wins].reverse().forEach((win, i) => {
    const k = i % (maxSteps + 1);
    win.classList.remove("is-max");
    win.style.width = `${w}px`;
    win.style.height = `${h}px`;
    win.style.left = `${area.x + 20 + k * step}px`;
    win.style.top = `${area.y + 12 + k * step}px`;
  });
};

const workArea = () => {
  const top = 42;
  const bottom = 86;
  const pad = 10;
  const w = Math.max(320, window.innerWidth - pad * 2);
  const h = Math.max(260, window.innerHeight - top - bottom);
  return { x: pad, y: top, w, h, gap: 8 };
};

const tileWindow = (win: HTMLElement, mode: "left" | "right" | "center" | "max") => {
  const area = workArea();
  win.classList.remove("is-max");
  if (mode === "left") {
    const half = Math.floor((area.w - area.gap) / 2);
    win.style.left = `${area.x}px`;
    win.style.top = `${area.y}px`;
    win.style.width = `${half}px`;
    win.style.height = `${area.h}px`;
    return;
  }
  if (mode === "right") {
    const half = Math.floor((area.w - area.gap) / 2);
    win.style.left = `${area.x + half + area.gap}px`;
    win.style.top = `${area.y}px`;
    win.style.width = `${half}px`;
    win.style.height = `${area.h}px`;
    return;
  }
  if (mode === "center") {
    const w = Math.min(Math.max(win.offsetWidth || 720, 420), area.w - 40);
    const h = Math.min(Math.max(win.offsetHeight || 500, 320), area.h - 24);
    win.style.width = `${Math.round(w)}px`;
    win.style.height = `${Math.round(h)}px`;
    win.style.left = `${Math.round((window.innerWidth - w) / 2)}px`;
    win.style.top = `${Math.round(area.y + (area.h - h) / 2)}px`;
    return;
  }
  const maxBtn = win.querySelector<HTMLButtonElement>(".win-max, [data-win-act='max']");
  if (maxBtn) {
    maxBtn.click();
  } else {
    win.style.left = `${area.x}px`;
    win.style.top = `${area.y}px`;
    win.style.width = `${area.w}px`;
    win.style.height = `${area.h}px`;
  }
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
    width: "min(560px, 100%)",
    maxHeight: "80vh",
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
  h2.textContent = "Guandao OS 2.2 · 快捷键一览";
  Object.assign(h2.style, { margin: "0", fontSize: "16px", fontWeight: "650" });
  const sub = document.createElement("p");
  sub.textContent = "Chrono Flow · 用键盘高效管理窗口与工作空间";
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

  const dispatch = (action: TileAction) => {
    if (action === "shortcuts") {
      toggleShortcutCheatsheet();
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
    if (action === "tile-left") {
      tileWindow(win, "left");
      ctx.toast("已贴靠到左半屏");
    } else if (action === "tile-right") {
      tileWindow(win, "right");
      ctx.toast("已贴靠到右半屏");
    } else if (action === "tile-center") {
      tileWindow(win, "center");
      ctx.toast("已居中窗口");
    } else if (action === "tile-max") {
      tileWindow(win, "max");
    } else if (action === "tile-close") {
      ctx.closeWin(win);
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
    if (typing) return;

    if (e.key === "?" && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      toggleShortcutCheatsheet();
      return;
    }

    if (!e.altKey || e.ctrlKey || e.metaKey) return;
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
      dispatch(e.shiftKey ? "tile-cascade" : "tile-grid");
    }
  });
};
