/**
 * 移动端通用 UI：图标、抽屉、Toast、格式化。
 * 只做展示，不持有业务状态。
 */

import { escapeAttr, escapeHtml } from "../html";
import { fmtAgo, fmtBytes, fmtDate, pad2, todayKey } from "../os14/core";

export { escapeAttr, escapeHtml, fmtAgo, fmtBytes, fmtDate, pad2, todayKey };

export const ICONS = {
  home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 10.6 12 3.6l8.5 7"/><path d="M5.6 9.4V20h12.8V9.4"/><path d="M9.8 20v-5.6h4.4V20"/></svg>',
  note: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3.5h9.2L19 7.4V20a.6.6 0 0 1-.6.6H6a.6.6 0 0 1-.6-.6V4.1a.6.6 0 0 1 .6-.6Z"/><path d="M14.8 3.8V7.6h3.8"/><path d="M8.6 12h6.4M8.6 15.4h5"/></svg>',
  task: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="4"/><path d="m8.2 12.2 2.6 2.6 5-5.4"/></svg>',
  calendar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3.6" y="5.2" width="16.8" height="15.2" rx="3"/><path d="M3.6 9.8h16.8M8 3.4v3.4M16 3.4v3.4"/><path d="M7.6 13.4h2M11 13.4h2M14.4 13.4h2M7.6 16.8h2M11 16.8h2"/></svg>',
  more: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5.5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="18.5" cy="12" r="1.7"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="m21 3-8.4 18-2.3-7.3L3 11.4 21 3Z"/><path d="M10.3 13.7 21 3"/></svg>',
  device: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><rect x="3.5" y="4.5" width="12.5" height="9" rx="1.8"/><path d="M7 17h6M16 9h4.4v9.4H16z"/></svg>',
  clipboard: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="5.5" y="4.5" width="13" height="16" rx="2.4"/><path d="M9 4.5V3.3h6v1.2"/><path d="M9 10h6M9 13.4h6M9 16.8h4"/></svg>',
  folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M3.5 7.2A1.7 1.7 0 0 1 5.2 5.5h4l2 2.2h5.6a1.7 1.7 0 0 1 1.7 1.7v8.4a1.7 1.7 0 0 1-1.7 1.7H5.2a1.7 1.7 0 0 1-1.7-1.7Z"/></svg>',
  user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="12" cy="8.4" r="3.6"/><path d="M4.8 20c.7-3.6 3.6-5.6 7.2-5.6s6.5 2 7.2 5.6"/></svg>',
  bell: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M6.4 10.2a5.6 5.6 0 0 1 11.2 0c0 4.2 1.4 5.4 1.4 5.4H5s1.4-1.2 1.4-5.4Z"/><path d="M10.2 19a2 2 0 0 0 3.6 0"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m9 5 7 7-7 7"/></svg>',
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m15 5-7 7 7 7"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="10.6" cy="10.6" r="6.4"/><path d="m15.4 15.4 4 4"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M4.5 7h15M9 7V5.2h6V7M7 7l.8 12.2h8.4L17 7"/><path d="M10.4 10.6v5.6M13.6 10.6v5.6"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="8.4" y="8.4" width="11" height="11" rx="2.2"/><path d="M15.6 8.4V6.2a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2.2"/></svg>',
  download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.8v11.4"/><path d="m7.6 11 4.4 4.4 4.4-4.4"/><path d="M4.6 19.4h14.8"/></svg>',
  desktop: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3.2" y="4.4" width="17.6" height="11.4" rx="2"/><path d="M9 19.6h6M12 15.8v3.8"/></svg>',
} as const;

export type SheetOptions = {
  title: string;
  body: string;
  actions?: Array<{ label: string; value: string; primary?: boolean; danger?: boolean }>;
  onMount?: (sheet: HTMLElement) => void;
};

const layer = () => {
  let node = document.getElementById("m-sheet-layer");
  if (!node) {
    node = document.createElement("div");
    node.id = "m-sheet-layer";
    node.className = "m-sheet-layer";
    document.body.appendChild(node);
  }
  return node;
};

/** 打开底部抽屉，返回 Promise：点击动作返回 value，点遮罩/关闭返回 null。 */
export function openSheet(options: SheetOptions): Promise<string | null> {
  return new Promise((resolve) => {
    const host = layer();
    host.innerHTML = "";
    host.hidden = false;

    const backdrop = document.createElement("div");
    backdrop.className = "m-sheet-backdrop";
    const sheet = document.createElement("div");
    sheet.className = "m-sheet";
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-modal", "true");
    sheet.setAttribute("aria-label", options.title);
    sheet.innerHTML = `
      <span class="m-sheet-grip"></span>
      <div class="m-sheet-head">
        <h3>${escapeHtml(options.title)}</h3>
        <button type="button" data-sheet-close aria-label="关闭">×</button>
      </div>
      <div class="m-sheet-body">${options.body}</div>
      ${
        options.actions?.length
          ? `<div class="m-sheet-actions">${options.actions
              .map(
                (action) =>
                  `<button type="button" class="m-btn ${action.primary ? "primary" : ""} ${
                    action.danger ? "danger" : ""
                  }" data-sheet-value="${escapeHtml(action.value)}">${escapeHtml(action.label)}</button>`,
              )
              .join("")}</div>`
          : ""
      }`;
    host.append(backdrop, sheet);

    const close = (value: string | null) => {
      host.hidden = true;
      host.innerHTML = "";
      document.body.style.overflow = "";
      resolve(value);
    };

    document.body.style.overflow = "hidden";
    sheet.querySelector("[data-sheet-close]")?.addEventListener("click", () => close(null));
    backdrop.addEventListener("click", () => close(null));
    sheet.querySelectorAll<HTMLElement>("[data-sheet-value]").forEach((button) => {
      button.addEventListener("click", () => close(button.dataset.sheetValue ?? null));
    });
    options.onMount?.(sheet);
    window.setTimeout(() => sheet.querySelector<HTMLElement>("input,textarea")?.focus(), 120);
  });
}

export function closeSheet() {
  const host = document.getElementById("m-sheet-layer");
  if (!host) return;
  host.hidden = true;
  host.innerHTML = "";
  document.body.style.overflow = "";
}

let toastTimer = 0;
export function toast(message: string, tone: "normal" | "danger" = "normal") {
  let node = document.getElementById("m-toast");
  if (!node) {
    node = document.createElement("div");
    node.id = "m-toast";
    node.className = "m-toast";
    document.body.appendChild(node);
  }
  node.textContent = message;
  node.classList.toggle("is-danger", tone === "danger");
  node.classList.add("is-on");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => node?.classList.remove("is-on"), 2400);
}

export function confirmSheet(message: string, confirmLabel = "确定"): Promise<boolean> {
  return openSheet({
    title: "请确认",
    body: `<p style="margin:6px 2px 14px;font-size:12.5px;line-height:1.65;color:var(--m-dim)">${escapeHtml(message)}</p>`,
    actions: [
      { label: "取消", value: "" },
      { label: confirmLabel, value: "ok", danger: true, primary: true },
    ],
  }).then((value) => value === "ok");
}

export function deviceIcon(type: string): string {
  return ICONS.device;
}

export function fileIcon(category: string): string {
  const map: Record<string, string> = {
    image: "▣",
    audio: "♪",
    video: "▶",
    document: "▥",
  };
  return map[category] ?? "▤";
}

export function relativeTime(ms: number | null | undefined): string {
  if (!ms) return "—";
  const diff = Date.now() - ms;
  if (diff < 60_000) return "刚刚";
  return fmtAgo(ms);
}

// 2.3：escapeAttr 已统一到 src/lib/html.ts（与 escapeHtml 同规则），此处不再保留本地副本。
