/**
 * Guandao OS 2.5 · 社区纯渲染工具。
 *
 * 从 src/lib/os14/community.ts 原样搬出。
 * 这一层是**纯函数**：只接收参数、返回字符串，不读闭包状态，
 * 可以脱离 initCommunity 单独测试。
 */
import { escapeHtml, safeUrl } from "../../html";
import { fmtAgo } from "../core";
import { CATEGORY_LABEL } from "../../community/manifest";
import type { Post, Role } from "./types";
import { REASON_LABEL, ROLE_LABEL, STATUS_LABEL, TYPE_GLYPH, TYPE_LABEL } from "./constants";

export const esc = (value: unknown) => escapeHtml(String(value ?? ""));

export const clampText = (value: string, max: number) => String(value ?? "").trim().slice(0, max);

export const safeWallId = (value: unknown) => {
  const id = String(value ?? "");
  return /^[a-z0-9-]{2,32}$/.test(id) ? id : "aurora";
};

export const safeHex = (value: unknown) => {
  const hex = String(value ?? "");
  return /^#[0-9a-f]{6}$/i.test(hex) ? hex : "#6f8cff";
};

export const timeAgo = (value: number | null | undefined) => (value ? fmtAgo(value) : "—");

export const bytesText = (bytes: number) => {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
};

export const roleBadge = (role: Role | string | undefined) => {
  if (role === "admin") return `<span class="cx-role is-admin">管理员</span>`;
  if (role === "moderator") return `<span class="cx-role is-mod">审核员</span>`;
  return "";
};

export const avatarHtml = (person: { displayName?: string; avatarUrl?: string | null } | null, size = "m") => {
  if (!person) return `<span class="cx-avatar is-${size}"><i>?</i></span>`;
  const initial = esc((person.displayName || "?").slice(0, 1));
  return person.avatarUrl
    ? `<span class="cx-avatar is-${size}"><img src="${safeUrl(person.avatarUrl)}" alt="" loading="lazy"/></span>`
    : `<span class="cx-avatar is-${size}"><i>${initial}</i></span>`;
};

export const coverHtml = (post: Post, className = "cx-cover", options: { full?: boolean } = {}) => {
  const src = options.full ? post.coverUrl || post.coverThumbUrl : post.coverThumbUrl || post.coverUrl;
  return `<div class="${className}">
    ${src ? `<img src="${safeUrl(src)}" alt="${esc(post.title)}" loading="lazy"/>` : `<span class="cx-cover-fallback">${TYPE_GLYPH[post.type] ?? "◇"}</span>`}
    <span class="cx-cover-veil"></span>
    <span class="cx-type-chip">${TYPE_GLYPH[post.type] ?? "◇"} ${TYPE_LABEL[post.type] ?? post.type}</span>
    ${post.featured ? `<span class="cx-featured-chip">编辑精选</span>` : ""}
    ${post.status !== "published" ? `<span class="cx-status-chip is-${esc(post.status)}">${STATUS_LABEL[post.status] ?? post.status}</span>` : ""}
  </div>`;
};

export const postCard = (post: Post, options: { row?: boolean; showStatus?: boolean } = {}) => `
  <article class="cx-card ${options.row ? "is-row" : ""}" data-post="${esc(post.id)}" tabindex="0" role="link" aria-label="${esc(post.title)}">
    ${coverHtml(post)}
    <div class="cx-card-body">
      <div class="cx-card-head">
        <h3>${esc(post.title)}</h3>
        <span class="cx-version">v${esc(post.version)}</span>
      </div>
      <p class="cx-card-desc">${esc(post.description || "创作者还没有填写简介。")}</p>
      <div class="cx-card-tags">${post.tags.slice(0, 3).map((tag) => `<span>#${esc(tag)}</span>`).join("")}</div>
      <div class="cx-card-foot">
        <button class="cx-author" type="button" data-creator="${esc(post.author.id)}">
          ${avatarHtml(post.author, "xs")}
          <span>${esc(post.author.displayName)}</span>
          ${roleBadge(post.author.role)}
        </button>
        <span class="cx-time">${timeAgo(post.publishedAt || post.createdAt)}</span>
      </div>
      <div class="cx-metrics">
        <button type="button" class="cx-metric cx-like ${post.viewer.liked ? "is-on" : ""}" data-like="${esc(post.id)}" aria-label="点赞">
          <span>♥</span><b data-like-count="${esc(post.id)}">${post.likeCount}</b>
        </button>
        <button type="button" class="cx-metric cx-fav ${post.viewer.favorited ? "is-on" : ""}" data-fav="${esc(post.id)}" aria-label="收藏">
          <span>★</span><b data-fav-count="${esc(post.id)}">${post.favoriteCount}</b>
        </button>
        <span class="cx-metric">💬 <b>${post.commentCount}</b></span>
        <span class="cx-metric">⤓ <b>${post.downloadCount}</b></span>
      </div>
      ${options.showStatus && post.moderationNote ? `<p class="cx-modnote">审核备注：${esc(post.moderationNote)}</p>` : ""}
    </div>
  </article>`;

export const pageNav = (page: number, hasMore: boolean, total: number, label = "作品") => `
  <div class="cx-pager">
    <button type="button" class="cx-btn is-ghost" data-page="${page - 1}" ${page <= 1 ? "disabled" : ""}>上一页</button>
    <span>第 ${page} 页 · 共 ${total} 个${label}</span>
    <button type="button" class="cx-btn is-ghost" data-page="${page + 1}" ${!hasMore ? "disabled" : ""}>下一页</button>
  </div>`;

export const skeleton = (label = "正在从社区读取真实数据…") => `
  <div class="cx-loading">
    <span class="cx-spinner"></span>
    <p>${esc(label)}</p>
    <div class="cx-skel-grid">${"<i></i>".repeat(3)}</div>
  </div>`;

export const loginGate = (message = "登录 Guandao Account 后即可使用社区功能。") => `
  <div class="cx-gate">
    <span class="cx-gate-art">◇</span>
    <h2>需要登录</h2>
    <p>${esc(message)}</p>
    <div class="cx-gate-actions">
      <button type="button" class="cx-btn is-primary" data-action="login">登录 Guandao Account</button>
      <button type="button" class="cx-btn" data-action="join">加入社区</button>
    </div>
    <p class="cx-hint">社区只读取你在 GitHub 的公开资料；不会访问仓库、Session 或私人文件。</p>
  </div>`;

export const errorPanel = (message: string) => `
  <div class="cx-error-panel">
    <span>!</span>
    <h2>没能读取社区数据</h2>
    <p>${esc(message)}</p>
    <button type="button" class="cx-btn is-primary" data-action="retry">重试</button>
  </div>`;

export const progressBar = (used: number, limit: number) => {
  const percent = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  return `<div class="cx-usage"><i style="width:${percent}%"></i><b>${percent}%</b></div>`;
};

export const typeChips = (selected: string, onSelect: string, includeAll = true) => {
  const entries: Array<[string, string]> = (
    includeAll ? ([["", "全部"]] as Array<[string, string]>) : []
  ).concat(Object.entries(TYPE_LABEL) as Array<[string, string]>);
  return entries
    .map(
      ([id, label]) =>
        `<button type="button" class="cx-chip ${selected === id ? "is-active" : ""}" data-${onSelect}="${esc(id)}">${esc(label)}</button>`,
    )
    .join("");
};

export const categoryChips = (type: string, selected: string, onSelect: string) => {
  const categories = type ? CATEGORY_LABEL[type] || {} : {};
  if (!type) return "";
  return Object.entries(categories)
    .map(
      ([id, label]) =>
        `<button type="button" class="cx-chip is-small ${selected === id ? "is-active" : ""}" data-${onSelect}="${esc(id)}">${esc(label)}</button>`,
    )
    .join("");
};

export const detailPermissionText = (permissions: string[]) =>
  permissions.map((permission) => `${permission}：${(window as unknown as { __CX_PERMS?: Record<string, string> }).__CX_PERMS?.[permission] || permission}`).join("；");
