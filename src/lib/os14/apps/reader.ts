/**
 * Guandao OS 1.4 · Guandao Reader
 *
 * 导入 TXT / Markdown，记住阅读进度，支持字号、行距、夜间阅读与书签。
 * 文本存 IndexedDB，书架信息存 localStorage。
 */

import {
  debounce,
  escapeHtml,
  fmtBytes,
  idb,
  ls,
  modal,
  pickFile,
  readText,
  renderMarkdown,
  todayKey,
  uid,
  type Ctx,
} from "../core";
import { sendToDevice } from "../../continuity/ui";

export type Book = {
  id: string;
  blobKey: string;
  title: string;
  format: "txt" | "md";
  size: number;
  addedAt: number;
  /** 0–1 的阅读进度 */
  progress: number;
  bookmarks: Array<{ id: string; ratio: number; label: string; at: number }>;
  lastAt: number;
};

type ReaderState = {
  v: 1;
  books: Book[];
  lastId: string;
  prefs: { font: number; line: number; mode: "day" | "sepia" | "night" };
};

const KEY = "guandao.os14.reader.v1";

const read = (): ReaderState =>
  ls.get<ReaderState>(KEY, { v: 1, books: [], lastId: "", prefs: { font: 17, line: 1.9, mode: "day" } });

const write = (s: ReaderState) => ls.set(KEY, s);

const textCache = new Map<string, string>();

const loadText = async (book: Book): Promise<string> => {
  const cached = textCache.get(book.id);
  if (cached != null) return cached;
  const blob = await idb.get<Blob>("blobs", book.blobKey);
  if (!blob) return "";
  const text = await blob.text();
  textCache.set(book.id, text);
  return text;
};

const body = () => `
  <div class="rd14" data-rd14>
    <aside class="rd14-shelf">
      <button class="rd14-import" type="button" data-rd-import>＋ 导入文本</button>
      <div class="rd14-books" data-rd-books></div>
      <p class="rd14-tip">支持 .txt / .md。文本只保存在浏览器本地。</p>
    </aside>
    <section class="rd14-main">
      <header class="rd14-bar">
        <button class="rd14-back" type="button" data-rd-shelf title="返回书架">←</button>
        <b data-rd-title>选择一本书</b>
        <div class="rd14-tools">
          <button type="button" data-rd-font="-">A−</button>
          <button type="button" data-rd-font="+">A＋</button>
          <button type="button" data-rd-tone>☀</button>
          <button type="button" data-rd-mark>书签</button>
          <button type="button" data-rd-send title="发送阅读位置到设备">⇥</button>
        </div>
      </header>
      <div class="rd14-progress"><i data-rd-bar></i></div>
      <article class="rd14-page" data-rd-page>
        <div class="rd14-empty"><span>▤</span><p>从左侧选一本书，或导入 TXT / Markdown。</p></div>
      </article>
      <footer class="rd14-foot">
        <span data-rd-pct>0%</span>
        <button class="rd14-marks" type="button" data-rd-marks><span data-rd-meta></span></button>
      </footer>
    </section>
  </div>`;

export const renderReader = () => body();

export const initReader = (win: HTMLElement, ctx: Ctx): (() => void) => {
  const root = win.querySelector<HTMLElement>("[data-rd14]");
  if (!root) return () => undefined;
  let st = read();
  let currentId = st.lastId;
  let mode: "read" | "shelf" = currentId ? "read" : "shelf";

  const page = root.querySelector<HTMLElement>("[data-rd-page]");
  const booksEl = root.querySelector<HTMLElement>("[data-rd-books]");
  const titleEl = root.querySelector<HTMLElement>("[data-rd-title]");
  const bar = root.querySelector<HTMLElement>("[data-rd-bar]");
  const pct = root.querySelector<HTMLElement>("[data-rd-pct]");
  const meta = root.querySelector<HTMLElement>("[data-rd-meta]");
  const host = root.querySelector<HTMLElement>(".rd14-main");

  const applyPrefs = () => {
    if (!page) return;
    page.style.fontSize = `${st.prefs.font}px`;
    page.style.lineHeight = String(st.prefs.line);
    host?.setAttribute("data-rd-mode", st.prefs.mode);
  };

  const paintShelf = () => {
    if (!booksEl) return;
    const sorted = st.books.slice().sort((a, b) => b.lastAt - a.lastAt);
    booksEl.innerHTML = sorted.length
      ? sorted
          .map(
            (b) => `<button class="rd14-book ${b.id === currentId ? "is-active" : ""}" type="button" data-rd-open="${escapeHtml(b.id)}">
              <span class="rd14-book-ico">${b.format === "md" ? "M↓" : "TXT"}</span>
              <span class="rd14-book-body"><b>${escapeHtml(b.title)}</b><i>${fmtBytes(b.size)} · ${Math.round(b.progress * 100)}%</i></span>
              <span class="rd14-book-prog"><i style="width:${Math.round(b.progress * 100)}%"></i></span>
            </button>`,
          )
          .join("")
      : `<div class="rd14-blank">书架是空的</div>`;
  };

  const paintProgress = () => {
    const b = st.books.find((x) => x.id === currentId);
    const p = b ? b.progress : 0;
    if (bar) bar.style.width = `${Math.round(p * 100)}%`;
    if (pct) pct.textContent = `${Math.round(p * 100)}%`;
    if (meta && b) meta.textContent = `书签 ${b.bookmarks.length} · ${b.format.toUpperCase()}`;
  };

  const openBook = async (id: string) => {
    const b = st.books.find((x) => x.id === id);
    if (!b || !page) return;
    currentId = id;
    mode = "read";
    st.lastId = id;
    b.lastAt = Date.now();
    write(st);
    if (titleEl) titleEl.textContent = b.title;
    page.innerHTML = `<div class="rd14-loading">正在打开…</div>`;
    const text = await loadText(b);
    if (!text) {
      page.innerHTML = `<div class="rd14-empty"><span>!</span><p>文本读取失败，可能已被清理。</p></div>`;
      return;
    }
    page.innerHTML = b.format === "md" ? `<div class="md-body">${renderMarkdown(text)}</div>` : `<pre class="rd14-text">${escapeHtml(text)}</pre>`;
    applyPrefs();
    paintShelf();
    paintProgress();
    // 等排版完成再恢复进度，否则 scrollHeight 还没算好
    requestAnimationFrame(() => {
      const max = page.scrollHeight - page.clientHeight;
      page.scrollTop = Math.max(0, max * b.progress);
    });
  };

  const saveProgress = debounce(() => {
    const b = st.books.find((x) => x.id === currentId);
    if (!b || !page) return;
    const max = page.scrollHeight - page.clientHeight;
    b.progress = max > 0 ? Math.max(0, Math.min(1, page.scrollTop / max)) : 0;
    write(st);
    paintProgress();
    const row = booksEl?.querySelector<HTMLElement>(`[data-rd-open="${CSS.escape(b.id)}"] i`);
    if (row) row.textContent = `${fmtBytes(b.size)} · ${Math.round(b.progress * 100)}%`;
  }, 500);

  win.addEventListener("scroll", () => saveProgress(), true);
  page?.addEventListener("scroll", () => saveProgress());

  win.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;

    if (t.closest("[data-rd-send]")) {
      const book = st.books.find((item) => item.id === currentId);
      if (!book) {
        ctx.toast("先在左侧选一本书");
        return;
      }
      void sendToDevice(ctx, {
        itemType: "reading",
        title: book.title,
        resourceId: book.id,
        payload: { title: book.title, progress: book.progress },
      });
      return;
    }
    if (t.closest("[data-rd-import]")) {
      pickFile(".txt,.md,.markdown,text/plain,text/markdown", true, async (files) => {
        let ok = 0;
        for (const file of files.slice(0, 10)) {
          if (file.size > 4 * 1024 * 1024) continue;
          const text = await readText(file);
          const key = `book:${uid()}`;
          if (!(await idb.put("blobs", key, new Blob([text], { type: "text/plain;charset=utf-8" })))) continue;
          const format = /\.(md|markdown)$/i.test(file.name) ? "md" : "txt";
          const book: Book = {
            id: uid(),
            blobKey: key,
            title: file.name.replace(/\.[^.]+$/, "").slice(0, 80),
            format,
            size: file.size,
            addedAt: Date.now(),
            progress: 0,
            bookmarks: [],
            lastAt: Date.now(),
          };
          textCache.set(book.id, text);
          st.books.unshift(book);
          currentId = book.id;
          st.lastId = book.id;
          ok++;
        }
        write(st);
        paintShelf();
        if (ok) {
          await openBook(currentId);
          ctx.toast(`已导入 ${ok} 本书`);
        } else {
          ctx.toast("没有可导入的文本（单本需小于 4MB）");
        }
      });
      return;
    }
    const open = t.closest<HTMLElement>("[data-rd-open]");
    if (open) {
      void openBook(open.dataset.rdOpen ?? "");
      return;
    }
    if (t.closest("[data-rd-shelf]")) {
      mode = "shelf";
      currentId = "";
      if (titleEl) titleEl.textContent = "书架";
      if (page) page.innerHTML = `<div class="rd14-empty"><span>▤</span><p>选一本书继续读，进度会自动记住。</p></div>`;
      paintShelf();
      return;
    }
    const font = t.closest<HTMLElement>("[data-rd-font]");
    if (font) {
      st.prefs.font = Math.max(13, Math.min(30, st.prefs.font + (font.dataset.rdFont === "+" ? 1 : -1)));
      write(st);
      applyPrefs();
      return;
    }
    if (t.closest("[data-rd-tone]")) {
      st.prefs.mode = st.prefs.mode === "day" ? "sepia" : st.prefs.mode === "sepia" ? "night" : "day";
      write(st);
      applyPrefs();
      const btn = t.closest<HTMLElement>("[data-rd-tone]");
      if (btn) btn.textContent = st.prefs.mode === "day" ? "☀" : st.prefs.mode === "sepia" ? "◐" : "☾";
      return;
    }
    if (t.closest("[data-rd-mark]")) {
      const b = st.books.find((x) => x.id === currentId);
      if (!b || !page) {
        ctx.toast("先打开一本书");
        return;
      }
      const max = page.scrollHeight - page.clientHeight;
      const ratio = max > 0 ? page.scrollTop / max : 0;
      b.bookmarks.push({ id: uid(), ratio, label: `${Math.round(ratio * 100)}% · ${todayKey()}`, at: Date.now() });
      write(st);
      paintProgress();
      ctx.toast("已添加书签");
      return;
    }
    if (t.closest("[data-rd-marks]")) {
      const b = st.books.find((x) => x.id === currentId);
      if (!b) {
        ctx.toast("先打开一本书");
        return;
      }
      void modal(win, {
        title: `书签 · ${b.title}`,
        body: b.bookmarks.length
          ? `<div class="g14-menu-list">${b.bookmarks
              .map((bm, i) => `<div class="rd14-markrow"><button class="g14-menu-item" data-rd-jump="${escapeHtml(bm.id)}">${i + 1}. ${escapeHtml(bm.label)}</button><button class="g14-menu-item is-danger" data-rd-markdel="${escapeHtml(bm.id)}">删除</button></div>`)
              .join("")}</div>`
          : `<p class="g14-modal-text">还没有书签。读到一半点右上角「书签」就能记下当前位置。</p>`,
        actions: [{ label: "关闭", value: "" }],
      });
      return;
    }
    const markDel = t.closest<HTMLElement>("[data-rd-markdel]");
    if (markDel) {
      const b = st.books.find((x) => x.id === currentId);
      if (!b) return;
      b.bookmarks = b.bookmarks.filter((x) => x.id !== markDel.dataset.rdMarkdel);
      write(st);
      paintProgress();
      ctx.toast("已删除书签");
      return;
    }
    const mark = t.closest<HTMLElement>("[data-rd-jump]");
    if (mark) {
      const b = st.books.find((x) => x.id === currentId);
      const bm = b?.bookmarks.find((x) => x.id === mark.dataset.rdJump);
      if (b && bm && page) {
        const max = page.scrollHeight - page.clientHeight;
        page.scrollTo({ top: max * bm.ratio, behavior: "smooth" });
      }
    }
  });

  const paintAll = async () => {
    paintShelf();
    applyPrefs();
    const modeBtn = root.querySelector<HTMLElement>("[data-rd-tone]");
    if (modeBtn) modeBtn.textContent = st.prefs.mode === "day" ? "☀" : st.prefs.mode === "sepia" ? "◐" : "☾";
    if (currentId) await openBook(currentId);
    void mode;
  };

  void paintAll();
  return () => saveProgress();
};
