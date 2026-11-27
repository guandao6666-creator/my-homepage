/**
 * 文章（posts）· 对应 index.astro 原 `renderPosts`。
 *
 * 只读 `data.posts` / `data.site`，无持久化、无定时器。
 * 支持窗口内实时关键词检索与侧栏标签筛选；列表与侧栏都是真实链接。
 */
import { safeUrl } from "../../html";
import type { LegacyAppModule } from "../types";

export const articlesApp: LegacyAppModule = {
  id: "posts",
  title: "文章",
  width: 660,
  height: 440,
  glyph: "di-folder",
  body: ({ data, escapeHtml }) => {
    const allTags = [...new Set(data.posts.flatMap((post) => post.tags))];
    const rows = data.posts
      .map(
        (post, index) => `
              <a class="file-row" href="${safeUrl(post.href)}" data-post-title="${escapeHtml(post.title.toLowerCase())}" data-post-tags="${escapeHtml(post.tags.join("|"))}" title="打开《${escapeHtml(post.title)}》">
                <span class="file-icon" aria-hidden="true"></span>
                <span class="file-main">
                  <span class="file-name">${escapeHtml(post.title)}</span>
                  <span class="file-meta">${post.date} · ${post.minutes} 分钟 · ${post.tags.map((tag) => escapeHtml(tag)).join(" / ")}</span>
                </span>
                <span class="file-index">${String(index + 1).padStart(2, "0")}</span>
              </a>`,
      )
      .join("");

    const tagButtons = allTags
      .map(
        (tag) =>
          `<button class="side-item" type="button" data-finder-tag="${escapeHtml(tag)}"># ${escapeHtml(tag)}</button>`,
      )
      .join("");

    return `
            <div class="finder">
              <aside class="finder-side">
                <p class="side-title">位置</p>
                <button class="side-item is-active" type="button" data-finder-tag="all">全部文章 (${data.posts.length})</button>
                <a class="side-item" href="${safeUrl("/blog/")}">博客列表 ↗</a>
                ${allTags.length ? `<p class="side-title">标签</p>${tagButtons}` : ""}
                <p class="side-title">关于</p>
                <a class="side-item" href="${safeUrl("/about/")}">关于页</a>
                <a class="side-item" href="${safeUrl("/home/")}">${escapeHtml(data.site.host)}</a>
              </aside>
              <div class="finder-files">
                <div style="padding:0 0 10px">
                  <input type="search" data-finder-search placeholder="搜索文章标题或标签…" autocomplete="off" style="width:100%;padding:7px 10px;border-radius:8px;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.05);color:inherit;font:inherit;font-size:12.5px;outline:none" />
                </div>
                ${rows || '<p class="finder-empty">还没有文章。</p>'}
                <p class="finder-empty" data-finder-empty hidden>没有匹配的文章。</p>
              </div>
            </div>`;
  },
  init: (win) => {
    const input = win.querySelector<HTMLInputElement>("[data-finder-search]");
    const tagBtns = [...win.querySelectorAll<HTMLButtonElement>("[data-finder-tag]")];
    const rows = [...win.querySelectorAll<HTMLElement>(".file-row[data-post-title]")];
    const empty = win.querySelector<HTMLElement>("[data-finder-empty]");
    if (!rows.length) return;

    let activeTag = "all";
    const filter = () => {
      const q = (input?.value ?? "").trim().toLowerCase();
      let shown = 0;
      for (const row of rows) {
        const title = row.dataset.postTitle ?? "";
        const tags = (row.dataset.postTags ?? "").split("|");
        const matchTag = activeTag === "all" || tags.includes(activeTag);
        const matchText = !q || title.includes(q) || tags.some((t) => t.toLowerCase().includes(q));
        const visible = matchTag && matchText;
        row.hidden = !visible;
        if (visible) shown++;
      }
      if (empty) empty.hidden = shown > 0;
    };

    input?.addEventListener("input", filter);
    for (const btn of tagBtns) {
      btn.addEventListener("click", () => {
        activeTag = btn.dataset.finderTag ?? "all";
        for (const item of tagBtns) item.classList.toggle("is-active", item === btn);
        filter();
      });
    }
  },
};
