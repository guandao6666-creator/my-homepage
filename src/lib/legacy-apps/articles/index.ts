/**
 * 文章（posts）· 对应 index.astro 原 `renderPosts`。
 *
 * 只读 `data.posts` / `data.site`，无 init、无持久化、无定时器。
 * 列表与侧栏都是真实链接：7 篇文章各自跳详情，侧栏跳归档 / 关于。
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
              <a class="file-row" href="${safeUrl(post.href)}" title="打开《${escapeHtml(post.title)}》">
                <span class="file-icon" aria-hidden="true"></span>
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
                <a class="side-item" href="${safeUrl("/blog/")}">${data.posts.length} 篇</a>
                <p class="side-title">关于</p>
                <a class="side-item" href="${safeUrl("/about/")}">关于页</a>
                <a class="side-item" href="${safeUrl("/home/")}">${escapeHtml(data.site.host)}</a>
              </aside>
              <div class="finder-files">${rows || '<p class="finder-empty">还没有文章。</p>'}</div>
            </div>`;
  },
};
