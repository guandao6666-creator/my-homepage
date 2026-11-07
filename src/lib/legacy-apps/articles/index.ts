/**
 * 文章（posts）· 对应 index.astro 原 `renderPosts`。
 *
 * 只读 `data.posts` / `data.site`，无 init、无持久化、无定时器。
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
    const rows = data.posts
      .map(
        (post, index) => `
              <a class="file-row" href="${safeUrl(post.href)}">
                <span class="file-icon"></span>
                <span class="file-main">
                  <span class="file-name">${escapeHtml(post.title)}</span>
                  <span class="file-meta">${post.date} · ${post.minutes} 分钟 · ${post.tags.map((tag) => escapeHtml(tag)).join(" / ")}</span>
                </span>
                <span class="file-index">${String(index + 1).padStart(2, "0")}</span>
              </a>`,
      )
      .join("");

    return `
            <div class="finder">
              <aside class="finder-side">
                <p class="side-title">位置</p>
                <span class="side-item is-active">全部文章</span>
                <span class="side-item">${data.posts.length} 篇</span>
                <p class="side-title">关于</p>
                <span class="side-item">${data.site.host}</span>
              </aside>
              <div class="finder-files">${rows || '<p class="finder-empty">还没有文章。</p>'}</div>
            </div>`;
  },
};