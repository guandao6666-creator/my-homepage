/**
 * Guandao OS 1.4 · Guandao Notes
 *
 * 多文档 + 文件夹 + Markdown + 标签 + 搜索 + 自动保存 + 导出。
 * 旧版「便签」的数组结构会在首次打开时迁移进来，不丢内容。
 */

import {
  badge,
  debounce,
  download,
  escapeHtml,
  fmtDateTime,
  ls,
  modal,
  renderMarkdown,
  uid,
  type Ctx,
} from "../core";

export type NoteDoc = {
  id: string;
  title: string;
  body: string;
  folder: string;
  tags: string[];
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
};

type NoteState = {
  v: 1;
  folders: Array<{ id: string; name: string }>;
  notes: NoteDoc[];
  ui: { folder: string; noteId: string; mode: "edit" | "preview" };
};

const KEY = "guandao.os14.notes.v1";
const LEGACY_KEY = "guandao.os.notes.v1";

const seed = (): NoteState => {
  const now = Date.now();
  const welcome: NoteDoc = {
    id: uid(),
    title: "欢迎使用 Guandao Notes",
    body: `# 欢迎使用 Guandao Notes

这是 1.4 的笔记工具，和以前的「一张便签」不太一样：

- **多文档**：左侧列表，可以建很多篇
- **文件夹**：把文档分到不同文件夹
- **Markdown**：右上角切换编辑 / 预览
- **标签**：给文档加标签，搜索时一起匹配
- **自动保存**：停下 0.4 秒就写进浏览器

## 一点小技巧

1. 标题会自动取正文第一行
2. 点右上角的「导出」可以存成 .md
3. 所有内容都在本机，换浏览器就看不到了，记得用数据中心备份

> 写下来，才算真的想过。
`,
    folder: "inbox",
    tags: ["指南"],
    pinned: true,
    createdAt: now,
    updatedAt: now,
  };
  return {
    v: 1,
    folders: [
      { id: "inbox", name: "收集箱" },
      { id: "study", name: "学习" },
      { id: "life", name: "生活" },
    ],
    notes: [welcome],
    ui: { folder: "all", noteId: welcome.id, mode: "edit" },
  };
};

const migrateLegacy = (state: NoteState): NoteState => {
  if (state.notes.length > 1) return state;
  const raw = ls.get<Array<{ id?: string; text?: string; at?: number; pinned?: boolean }> | null>(LEGACY_KEY, null);
  if (!Array.isArray(raw) || !raw.length) return state;
  for (const old of raw) {
    const text = String(old.text ?? "");
    if (!text.trim()) continue;
    const first = text.split("\n")[0].trim().slice(0, 40) || "旧便签";
    state.notes.push({
      id: uid(),
      title: first,
      body: text,
      folder: "inbox",
      tags: ["旧便签"],
      pinned: Boolean(old.pinned),
      createdAt: Number(old.at) || Date.now(),
      updatedAt: Number(old.at) || Date.now(),
    });
  }
  return state;
};

const read = (): NoteState => {
  const raw = ls.get<NoteState | null>(KEY, null);
  if (raw && raw.v === 1 && Array.isArray(raw.notes)) {
    if (!raw.ui) raw.ui = { folder: "all", noteId: raw.notes[0]?.id ?? "", mode: "edit" };
    return raw;
  }
  const fresh = migrateLegacy(seed());
  ls.set(KEY, fresh);
  return fresh;
};

const write = (st: NoteState) => ls.set(KEY, st);

const sortNotes = (list: NoteDoc[]) =>
  list.slice().sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt);

const titleOf = (note: NoteDoc) => {
  const t = note.title.trim();
  if (t) return t;
  const first = note.body.split("\n").find((l) => l.trim());
  return (first ?? "无标题").replace(/^#+\s*/, "").slice(0, 40);
};

const countWords = (text: string) => {
  const cn = (text.match(/[\u4e00-\u9fa5]/g) ?? []).length;
  const en = (text.replace(/[\u4e00-\u9fa5]/g, " ").match(/[A-Za-z0-9]+/g) ?? []).length;
  return cn + en;
};

const folderName = (st: NoteState, id: string) =>
  id === "all" ? "全部笔记" : st.folders.find((f) => f.id === id)?.name ?? "未分类";

/** 供文件管理器调用：把一个 Markdown / 文本文件变成新笔记 */
export const addNoteFromFile = (name: string, content: string): boolean => {
  try {
    const state = read();
    const now = Date.now();
    const note: NoteDoc = {
      id: uid(),
      title: name.replace(/\.[^.]+$/, "").slice(0, 80),
      body: content,
      folder: "inbox",
      tags: ["来自文件"],
      pinned: false,
      createdAt: now,
      updatedAt: now,
    };
    state.notes.unshift(note);
    state.ui.noteId = note.id;
    write(state);
    window.dispatchEvent(new CustomEvent("guandao:notes-open", { detail: { id: note.id } }));
    return true;
  } catch {
    return false;
  }
};

export const renderNotes = () => `
  <div class="n14" data-n14>
    <aside class="n14-side">
      <div class="n14-side-head"><span>文件夹</span><button type="button" data-n-folder-add title="新建文件夹">＋</button></div>
      <div class="n14-folders" data-n-folders></div>
      <div class="n14-side-foot">
        <button type="button" class="n14-tool" data-n-export-all>导出全部</button>
      </div>
    </aside>
    <section class="n14-list">
      <div class="n14-list-head">
        <input class="n14-search" data-n-search placeholder="搜索标题、正文、标签…" />
        <button class="n14-new" type="button" data-n-new>＋</button>
      </div>
      <div class="n14-items" data-n-items></div>
    </section>
    <section class="n14-editor" data-n-editor></section>
  </div>`;

export const initNotes = (win: HTMLElement, ctx: Ctx): (() => void) => {
  const root = win.querySelector<HTMLElement>("[data-n14]");
  if (!root) return () => undefined;
  let state = read();
  let query = "";
  let dirty = false;

  const foldersEl = root.querySelector<HTMLElement>("[data-n-folders]");
  const itemsEl = root.querySelector<HTMLElement>("[data-n-items]");
  const editorEl = root.querySelector<HTMLElement>("[data-n-editor]");
  const searchEl = root.querySelector<HTMLInputElement>("[data-n-search]");

  const current = () => state.notes.find((n) => n.id === state.ui.noteId) ?? null;

  const filtered = () => {
    let list = state.notes.slice();
    if (state.ui.folder !== "all") list = list.filter((n) => n.folder === state.ui.folder);
    const q = query.trim().toLowerCase();
    if (q) {
      list = list.filter((n) =>
        `${n.title}\n${n.body}\n${n.tags.join(" ")}`.toLowerCase().includes(q),
      );
    }
    return sortNotes(list);
  };

  const paintFolders = () => {
    if (!foldersEl) return;
    const total = state.notes.length;
    foldersEl.innerHTML =
      `<button class="n14-folder ${state.ui.folder === "all" ? "is-active" : ""}" type="button" data-n-folder="all"><span>▤</span>全部笔记<b>${total}</b></button>` +
      state.folders
        .map((f) => {
          const n = state.notes.filter((x) => x.folder === f.id).length;
          return `<button class="n14-folder ${state.ui.folder === f.id ? "is-active" : ""}" type="button" data-n-folder="${escapeHtml(f.id)}">
            <span>▸</span>${escapeHtml(f.name)}<b>${n}</b>
            <i class="n14-folder-more" data-n-folder-menu="${escapeHtml(f.id)}" title="文件夹操作">⋯</i>
          </button>`;
        })
        .join("");
  };

  const paintList = () => {
    if (!itemsEl) return;
    const list = filtered();
    itemsEl.innerHTML = list.length
      ? list
          .map(
            (n) => `<button class="n14-item ${n.id === state.ui.noteId ? "is-active" : ""}" type="button" data-n-open="${escapeHtml(n.id)}">
              <span class="n14-item-title">${n.pinned ? "★ " : ""}${escapeHtml(titleOf(n))}</span>
              <span class="n14-item-sub">${escapeHtml(n.body.replace(/\s+/g, " ").slice(0, 60) || "空白笔记")}</span>
              <span class="n14-item-meta">${fmtDateTime(n.updatedAt)}${n.tags.length ? ` · ${escapeHtml(n.tags.slice(0, 2).join(" "))}` : ""}</span>
            </button>`,
          )
          .join("")
      : `<div class="n14-blank">${query ? "没有匹配的笔记" : "这个文件夹还是空的"}</div>`;
  };

  const paintEditor = () => {
    if (!editorEl) return;
    const note = current();
    if (!note) {
      editorEl.innerHTML = `<div class="n14-editor-empty"><span>✎</span><p>选一篇笔记，或者新建一篇。</p><button class="g14-btn is-primary" type="button" data-n-new>新建笔记</button></div>`;
      return;
    }
    const words = countWords(note.body);
    editorEl.innerHTML = `
      <div class="n14-ed-bar">
        <span class="n14-ed-folder">${escapeHtml(folderName(state, note.folder))}</span>
        <div class="n14-ed-acts">
          <div class="n14-seg">
            <button type="button" data-n-mode="edit" class="${state.ui.mode === "edit" ? "is-active" : ""}">编辑</button>
            <button type="button" data-n-mode="preview" class="${state.ui.mode === "preview" ? "is-active" : ""}">预览</button>
          </div>
          <button type="button" class="n14-icon" data-n-pin title="置顶">${note.pinned ? "★" : "☆"}</button>
          <button type="button" class="n14-icon" data-n-export title="导出 Markdown">↓</button>
          <button type="button" class="n14-icon is-danger" data-n-delete title="删除">🗑</button>
        </div>
      </div>
      <input class="n14-title" data-n-title value="${escapeHtml(note.title)}" placeholder="标题" maxlength="80" />
      <div class="n14-tagbar">
        ${note.tags.map((t) => `<span class="n14-tag">${escapeHtml(t)}<i data-n-untag="${escapeHtml(t)}">×</i></span>`).join("")}
        <input class="n14-taginput" data-n-taginput placeholder="+ 标签" maxlength="16" />
      </div>
      ${
        state.ui.mode === "edit"
          ? `<textarea class="n14-body" data-n-body spellcheck="false" placeholder="用 Markdown 写点什么…">${escapeHtml(note.body)}</textarea>`
          : `<div class="n14-preview md-body">${renderMarkdown(note.body) || "<p class='n14-blank'>这篇笔记还没有内容。</p>"}</div>`
      }
      <div class="n14-ed-foot">
        <span>${words} 字</span>
        <span data-n-saved>${dirty ? "正在保存…" : `已保存 · ${fmtDateTime(note.updatedAt)}`}</span>
      </div>`;
  };

  const paintAll = () => {
    paintFolders();
    paintList();
    paintEditor();
  };

  const save = () => {
    write(state);
    dirty = false;
    const tip = root.querySelector<HTMLElement>("[data-n-saved]");
    const note = current();
    if (tip && note) tip.textContent = `已保存 · ${fmtDateTime(note.updatedAt)}`;
  };

  const saveSoon = debounce(save, 420);

  const touch = (note: NoteDoc) => {
    note.updatedAt = Date.now();
    dirty = true;
    const tip = root.querySelector<HTMLElement>("[data-n-saved]");
    if (tip) tip.textContent = "正在保存…";
    saveSoon();
  };

  const selectNote = (id: string) => {
    state.ui.noteId = id;
    write(state);
    paintList();
    paintEditor();
  };

  const newNote = () => {
    const now = Date.now();
    const folder = state.ui.folder === "all" ? state.folders[0]?.id ?? "inbox" : state.ui.folder;
    const note: NoteDoc = {
      id: uid(),
      title: "",
      body: "",
      folder,
      tags: [],
      pinned: false,
      createdAt: now,
      updatedAt: now,
    };
    state.notes.unshift(note);
    state.ui.noteId = note.id;
    state.ui.mode = "edit";
    write(state);
    paintAll();
    window.setTimeout(() => root.querySelector<HTMLInputElement>("[data-n-title]")?.focus(), 30);
  };

  /* ---------------- 事件 ---------------- */

  root.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;

    const folderBtn = t.closest<HTMLElement>("[data-n-folder]");
    if (folderBtn) {
      state.ui.folder = folderBtn.dataset.nFolder ?? "all";
      write(state);
      paintFolders();
      paintList();
      return;
    }

    if (t.closest("[data-n-folder-add]")) {
      void modal(win, {
        title: "新建文件夹",
        body: `<input class="g14-input" data-modal-input placeholder="文件夹名称" maxlength="16" />`,
        actions: [
          { label: "取消", value: "" },
          { label: "创建", value: "ok", primary: true },
        ],
      }).then((v) => {
        if (v !== "ok") return;
        const input = win.querySelector<HTMLInputElement>("[data-modal-input]");
        const name = (input?.value ?? "").trim();
        if (!name) return;
        const id = `f-${uid().slice(0, 8)}`;
        state.folders.push({ id, name: name.slice(0, 16) });
        write(state);
        paintFolders();
      });
      return;
    }

    const folderMenu = t.closest<HTMLElement>("[data-n-folder-menu]");
    if (folderMenu) {
      e.stopPropagation();
      const id = folderMenu.dataset.nFolderMenu ?? "";
      const folder = state.folders.find((f) => f.id === id);
      if (!folder) return;
      void modal(win, {
        title: folder.name,
        body: `<div class="g14-menu-list">
          <button class="g14-menu-item" data-mm="rename">重命名</button>
          <button class="g14-menu-item is-danger" data-mm="delete">删除文件夹</button>
        </div>`,
        actions: [{ label: "关闭", value: "" }],
      }).then((v) => {
        if (v === "rename") {
          void modal(win, {
            title: "重命名文件夹",
            body: `<input class="g14-input" data-modal-input value="${escapeHtml(folder.name)}" maxlength="16" />`,
            actions: [
              { label: "取消", value: "" },
              { label: "保存", value: "ok", primary: true },
            ],
          }).then((r) => {
            if (r !== "ok") return;
            const name = (win.querySelector<HTMLInputElement>("[data-modal-input]")?.value ?? "").trim();
            if (!name) return;
            folder.name = name.slice(0, 16);
            write(state);
            paintAll();
          });
        }
        if (v === "delete") {
          state.folders = state.folders.filter((f) => f.id !== id);
          for (const n of state.notes) if (n.folder === id) n.folder = "inbox";
          if (state.ui.folder === id) state.ui.folder = "all";
          write(state);
          paintAll();
          ctx.toast("文件夹已删除，里面的笔记移到收集箱");
        }
      });
      return;
    }

    const open = t.closest<HTMLElement>("[data-n-open]");
    if (open) {
      selectNote(open.dataset.nOpen ?? "");
      return;
    }

    if (t.closest("[data-n-new]")) {
      newNote();
      return;
    }

    const mode = t.closest<HTMLElement>("[data-n-mode]");
    if (mode) {
      state.ui.mode = (mode.dataset.nMode as "edit" | "preview") ?? "edit";
      write(state);
      paintEditor();
      return;
    }

    if (t.closest("[data-n-pin]")) {
      const note = current();
      if (!note) return;
      note.pinned = !note.pinned;
      touch(note);
      paintList();
      paintEditor();
      return;
    }

    if (t.closest("[data-n-export]")) {
      const note = current();
      if (!note) return;
      const safe = titleOf(note).replace(/[\\/:*?"<>|]/g, "_");
      download(`${safe}.md`, `${note.title ? `# ${note.title}\n\n` : ""}${note.body}`, "text/markdown;charset=utf-8");
      ctx.toast("已导出为 Markdown 文件");
      return;
    }

    if (t.closest("[data-n-export-all]")) {
      const bundle = state.notes.map((n) => ({ title: titleOf(n), folder: folderName(state, n.folder), tags: n.tags, body: n.body, updatedAt: n.updatedAt }));
      download(`guandao-notes-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify({ kind: "guandao-notes", version: 1, notes: bundle }, null, 2));
      ctx.toast(`已导出 ${bundle.length} 篇笔记`);
      return;
    }

    if (t.closest("[data-n-delete]")) {
      const note = current();
      if (!note) return;
      void modal(win, {
        title: "删除这篇笔记？",
        body: `<p class="g14-modal-text">「${escapeHtml(titleOf(note))}」将被移除，不能撤销。</p>`,
        actions: [
          { label: "取消", value: "" },
          { label: "删除", value: "ok", danger: true, primary: true },
        ],
      }).then((v) => {
        if (v !== "ok") return;
        state.notes = state.notes.filter((n) => n.id !== note.id);
        state.ui.noteId = state.notes[0]?.id ?? "";
        write(state);
        paintAll();
      });
      return;
    }

    const untag = t.closest<HTMLElement>("[data-n-untag]");
    if (untag) {
      const note = current();
      if (!note) return;
      note.tags = note.tags.filter((x) => x !== untag.dataset.nUntag);
      touch(note);
      paintEditor();
    }
  });

  root.addEventListener("input", (e) => {
    const t = e.target as HTMLElement;
    if (t === searchEl) {
      query = searchEl?.value ?? "";
      paintList();
      return;
    }
    const note = current();
    if (!note) return;
    if (t.matches("[data-n-title]")) {
      note.title = (t as HTMLInputElement).value;
      touch(note);
      return;
    }
    if (t.matches("[data-n-body]")) {
      note.body = (t as HTMLTextAreaElement).value;
      touch(note);
      const words = root.querySelector<HTMLElement>(".n14-ed-foot span");
      if (words) words.textContent = `${countWords(note.body)} 字`;
      return;
    }
  });

  root.addEventListener("keydown", (e) => {
    const t = e.target as HTMLElement;
    if (t.matches("[data-n-taginput]") && e.key === "Enter") {
      e.preventDefault();
      const input = t as HTMLInputElement;
      const value = input.value.trim().replace(/[,，]/g, "");
      if (!value) return;
      const note = current();
      if (!note) return;
      if (!note.tags.includes(value)) note.tags.push(value.slice(0, 16));
      input.value = "";
      touch(note);
      paintEditor();
      return;
    }
    if (t.matches("[data-n-body]") && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      save();
      ctx.toast("已保存");
    }
  });

  // 关窗前把未落盘的改动写掉
  win.addEventListener("guandao:before-close", () => save());

  paintAll();
  return () => save();
};
