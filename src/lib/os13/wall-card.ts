/**
 * Guandao OS 2.0.6 · 壁纸卡片渲染
 *
 * 为什么单独拆出来：
 *   自定义壁纸的名字来自社区作品的 `post.title`（见 community/install.ts），
 *   属于**别人可控的输入**。2.0.5 之前 `renderWallGallery` 直接把它拼进
 *   `title="${w.name}"`、`alt="${w.name}"` 与 `<span>`，标题里带 `<svg/onload>`
 *   就能在设置页里执行脚本（CSP 在无哈希构建时会回退 unsafe-inline，挡不住）。
 *
 *   把这段 HTML 生成放进纯函数，才能用单测钉住「名字必须转义」，
 *   而不是每次重构都靠人肉 review。
 */
import { escapeAttr, escapeHtml, safeUrl } from "../html";

export type WallCardWall = {
  id: string;
  name: string;
  /** 预览地址：内置壁纸是静态缩略图，自定义壁纸是 blob: 对象 URL */
  thumb: string;
  custom: boolean;
};

export type WallCardState = {
  active: boolean;
  favorite: boolean;
};

/**
 * 渲染一张壁纸卡片。
 *
 * 名字同时出现在「带引号的属性」和「文本节点」两种上下文里，
 * 两处都必须转义；`safeUrl` 只负责预览地址的协议校验，不负责名字。
 */
export function wallCardHtml(wall: WallCardWall, state: WallCardState): string {
  const id = escapeAttr(wall.id);
  const name = escapeAttr(wall.name);
  const text = escapeHtml(wall.name);
  // 预览地址先过 safeUrl（协议白名单 + 允许 blob: 仅自定义壁纸），
  // 再交给 escapeAttr —— 静态检查与运行时各守一层。
  const thumb = wall.custom ? safeUrl(wall.thumb, { allowBlob: true }) : safeUrl(wall.thumb);
  const preview = thumb
    ? `<img src="${escapeAttr(thumb)}" alt="${name}" loading="lazy" decoding="async" />`
    : `<span class="wc-void">自定义</span>`;
  return `<button class="wall-card ${state.active ? "is-active" : ""}" type="button" data-wall-id="${id}" title="${name}">
          ${preview}
          <span class="wc-name">${text}</span>
          <span class="wc-fav ${state.favorite ? "is-on" : ""}" data-fav="${id}" role="button" aria-label="收藏">★</span>
          ${wall.custom ? `<span class="wc-del" data-del="${id}" role="button" aria-label="删除">✕</span>` : ""}
          ${state.active ? `<span class="wc-check">✓</span>` : ""}
        </button>`;
}