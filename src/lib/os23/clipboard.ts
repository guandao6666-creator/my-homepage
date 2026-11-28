/**
 * Guandao OS 2.3 · 剪贴板历史与快捷片段面板（Alt + V）
 *
 * 按需动态加载浮层：
 *   - 展示桌面内最近复制的文本片段（自动跳过密码框，最多保留 25 条）
 *   - 支持手动新建常用文本模板 / 代码片段，并可「★ 置顶收藏」（清空历史时保留收藏项）
 *   - 支持关键词实时过滤、一键复制回系统剪贴板、单条删除与一键清空未收藏记录
 *
 * 全部 DOM 采用 createElement / textContent 构建，零 innerHTML 注入风险。
 */
import { ls, uid, type Ctx } from "../os14/core";

export const CLIP_STORAGE_KEY = "guandao.os23.clips.v1";

export type ClipEntry = {
  id: string;
  text: string;
  pinned: boolean;
  at: number;
};

type ClipPersist = { v: 1; items: ClipEntry[] };

export const readClips = (): ClipEntry[] => {
  const raw = ls.get<Partial<ClipPersist>>(CLIP_STORAGE_KEY, { v: 1, items: [] });
  if (!raw || !Array.isArray(raw.items)) return [];
  return raw.items
    .filter((it) => it && typeof it.text === "string" && it.text.trim())
    .map((it) => ({
      id: String(it.id || uid()),
      text: it.text.slice(0, 2000),
      pinned: Boolean(it.pinned),
      at: Number(it.at) || Date.now(),
    }));
};

export const writeClips = (items: ClipEntry[]) => {
  const sorted = items
    .slice()
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.at - a.at)
    .slice(0, 30);
  ls.set(CLIP_STORAGE_KEY, { v: 1, items: sorted });
};

/** 记录一条新复制的文本：若已存在同内容则刷新时间戳并保留其置顶态 */
export const recordClipText = (raw: string, pinned = false): ClipEntry[] => {
  const text = raw.trim().slice(0, 2000);
  if (!text) return readClips();
  const list = readClips();
  const existing = list.find((it) => it.text === text);
  const next: ClipEntry[] = existing
    ? [{ ...existing, pinned: existing.pinned || pinned, at: Date.now() }, ...list.filter((it) => it.id !== existing.id)]
    : [{ id: uid(), text, pinned, at: Date.now() }, ...list];
  writeClips(next);
  return readClips();
};

let drawerEl: HTMLElement | null = null;

export const toggleClipboardDrawer = (ctx: Ctx) => {
  if (drawerEl && drawerEl.isConnected) {
    drawerEl.remove();
    drawerEl = null;
    return;
  }

  let query = "";

  const backdrop = document.createElement("div");
  backdrop.className = "os23-clip-backdrop";
  backdrop.setAttribute("role", "dialog");
  backdrop.setAttribute("aria-modal", "true");
  backdrop.setAttribute("aria-label", "剪贴板与快捷片段");
  Object.assign(backdrop.style, {
    position: "fixed",
    inset: "0",
    zIndex: "9992",
    display: "grid",
    placeItems: "center",
    background: "rgba(8, 10, 16, 0.56)",
    backdropFilter: "blur(10px)",
    padding: "16px",
  });

  const panel = document.createElement("div");
  Object.assign(panel.style, {
    width: "min(540px, 100%)",
    maxHeight: "80vh",
    display: "grid",
    gridTemplateRows: "auto auto 1fr auto",
    gap: "10px",
    borderRadius: "16px",
    border: "1px solid rgba(255,255,255,0.14)",
    background: "rgba(20, 24, 36, 0.95)",
    color: "#eef1f7",
    padding: "18px 20px",
    boxShadow: "0 24px 64px -20px rgba(0,0,0,0.85)",
  });

  const head = document.createElement("div");
  Object.assign(head.style, { display: "flex", justifyContent: "space-between", alignItems: "center", gap: "10px" });
  const titleWrap = document.createElement("div");
  const h2 = document.createElement("h2");
  h2.textContent = "剪贴板与快捷片段（Alt+V）";
  Object.assign(h2.style, { margin: "0", fontSize: "15.5px", fontWeight: "650" });
  const sub = document.createElement("p");
  sub.textContent = "仅保存在当前浏览器 · 自动忽略密码框 · 收藏项不会被一键清空";
  Object.assign(sub.style, { margin: "3px 0 0", fontSize: "11.5px", opacity: "0.62" });
  titleWrap.append(h2, sub);

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "g14-btn is-ghost";
  closeBtn.textContent = "关闭";
  closeBtn.addEventListener("click", () => toggleClipboardDrawer(ctx));
  head.append(titleWrap, closeBtn);

  const bar = document.createElement("div");
  Object.assign(bar.style, { display: "flex", gap: "8px", flexWrap: "wrap" });
  const search = document.createElement("input");
  search.type = "search";
  search.placeholder = "搜索剪贴板或快捷片段…";
  Object.assign(search.style, {
    flex: "1",
    minWidth: "160px",
    padding: "7px 11px",
    borderRadius: "9px",
    border: "1px solid rgba(255,255,255,0.14)",
    background: "rgba(255,255,255,0.06)",
    color: "inherit",
    font: "inherit",
    fontSize: "12.5px",
    outline: "none",
  });
  const clearBtn = document.createElement("button");
  clearBtn.type = "button";
  clearBtn.className = "g14-btn is-ghost";
  clearBtn.textContent = "清空未收藏";
  bar.append(search, clearBtn);

  const listEl = document.createElement("div");
  Object.assign(listEl.style, { minHeight: "140px", maxHeight: "46vh", overflowY: "auto", display: "grid", gap: "7px", alignContent: "start" });

  const addForm = document.createElement("form");
  Object.assign(addForm.style, { display: "flex", gap: "8px", paddingTop: "8px", borderTop: "1px solid rgba(255,255,255,0.08)" });
  const addInput = document.createElement("input");
  addInput.type = "text";
  addInput.maxLength = 500;
  addInput.placeholder = "新建常用快捷片段（自动置顶收藏），回车添加…";
  Object.assign(addInput.style, {
    flex: "1",
    padding: "7px 11px",
    borderRadius: "9px",
    border: "1px solid rgba(255,255,255,0.14)",
    background: "rgba(255,255,255,0.05)",
    color: "inherit",
    font: "inherit",
    fontSize: "12.5px",
    outline: "none",
  });
  const addBtn = document.createElement("button");
  addBtn.type = "submit";
  addBtn.className = "g14-btn is-primary";
  addBtn.textContent = "收藏片段";
  addForm.append(addInput, addBtn);

  const paint = () => {
    listEl.textContent = "";
    const q = query.trim().toLowerCase();
    const items = readClips().filter((it) => !q || it.text.toLowerCase().includes(q));
    if (!items.length) {
      const empty = document.createElement("p");
      empty.textContent = q ? "没有匹配的片段。" : "暂无记录。在页面内复制文本或在下方添加常用片段即可出现在这里。";
      Object.assign(empty.style, { margin: "0", padding: "26px 12px", textAlign: "center", fontSize: "12.5px", opacity: "0.6" });
      listEl.appendChild(empty);
      return;
    }
    for (const it of items) {
      const row = document.createElement("div");
      Object.assign(row.style, {
        display: "flex",
        alignItems: "center",
        gap: "8px",
        padding: "8px 11px",
        borderRadius: "10px",
        border: "1px solid rgba(255,255,255,0.1)",
        background: "rgba(255,255,255,0.04)",
      });

      const textBtn = document.createElement("button");
      textBtn.type = "button";
      textBtn.title = "点击复制";
      textBtn.textContent = it.text.replace(/\s+/g, " ").slice(0, 110);
      Object.assign(textBtn.style, {
        flex: "1",
        minWidth: "0",
        border: "0",
        background: "transparent",
        color: "inherit",
        font: "inherit",
        fontSize: "12.5px",
        textAlign: "left",
        cursor: "pointer",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        padding: "0",
      });
      textBtn.addEventListener("click", () => {
        void navigator.clipboard?.writeText(it.text).then(
          () => {
            ctx.toast("已复制到剪贴板");
            toggleClipboardDrawer(ctx);
          },
          () => ctx.toast("浏览器阻止了自动写入剪贴板"),
        );
      });

      const pinBtn = document.createElement("button");
      pinBtn.type = "button";
      pinBtn.className = "g14-btn is-ghost";
      pinBtn.textContent = it.pinned ? "★" : "☆";
      pinBtn.title = it.pinned ? "取消收藏" : "收藏置顶";
      Object.assign(pinBtn.style, { minHeight: "26px", padding: "0 8px", color: it.pinned ? "#facc15" : "inherit" });
      pinBtn.addEventListener("click", () => {
        writeClips(readClips().map((x) => (x.id === it.id ? { ...x, pinned: !x.pinned } : x)));
        paint();
      });

      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "g14-btn is-ghost";
      delBtn.textContent = "✕";
      delBtn.title = "删除";
      Object.assign(delBtn.style, { minHeight: "26px", padding: "0 8px" });
      delBtn.addEventListener("click", () => {
        writeClips(readClips().filter((x) => x.id !== it.id));
        paint();
      });

      row.append(textBtn, pinBtn, delBtn);
      listEl.appendChild(row);
    }
  };

  search.addEventListener("input", () => {
    query = search.value;
    paint();
  });

  clearBtn.addEventListener("click", () => {
    writeClips(readClips().filter((x) => x.pinned));
    paint();
    ctx.toast("已清空未收藏的剪贴板历史");
  });

  addForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const val = addInput.value.trim();
    if (!val) return;
    recordClipText(val, true);
    addInput.value = "";
    paint();
    ctx.toast("已收藏快捷片段");
  });

  panel.append(head, bar, listEl, addForm);
  backdrop.appendChild(panel);
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) toggleClipboardDrawer(ctx);
  });
  const onEsc = (e: KeyboardEvent) => {
    if (e.key === "Escape" && drawerEl === backdrop) {
      e.preventDefault();
      window.removeEventListener("keydown", onEsc);
      toggleClipboardDrawer(ctx);
    }
  };
  window.addEventListener("keydown", onEsc);

  document.body.appendChild(backdrop);
  drawerEl = backdrop;
  paint();
  search.focus();
};
