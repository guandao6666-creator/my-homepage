/**
 * Guandao OS 2.5 · 社区作品详情页。
 *
 * 批次 3 从 src/lib/os14/community.ts 的 initCommunity 闭包原样搬出；
 * 状态读写改经 CommunityContext，渲染模板与拆分前逐字一致。
 */
import { fmtDate, renderMarkdown } from "../core";
import { safeUrl } from "../../html";
import * as api from "../../community/api";
import { getInstall } from "../../community/install";
import {
  LICENSE_OPTIONS,
  WIDGET_TYPE_LABEL,
  compatibilityCheck,
  type Manifest,
  type ThemeConfig,
  type WidgetConfig,
  type WorkspaceConfig,
} from "../../community/manifest";
import { ROLE_LABEL, STATUS_LABEL, TYPE_GLYPH, TYPE_LABEL, VIEW_KEY } from "./constants";
import type { CommunityContext } from "./context";
import { avatarHtml, bytesText, coverHtml, esc, roleBadge, safeHex, safeWallId, skeleton, timeAgo } from "./ui";

  /* ============================================================
     作品详情
     ============================================================ */

export const loadDetailImpl = async (ctx: CommunityContext, id: string) => {
    // 先占号再改视图：将来 setView 若带上副作用，也不会出现「视图已变、号还没占」的窗口期。
    const token = ctx.nextToken();
    ctx.setView({ kind: "detail", id });
    ctx.setBody(skeleton("正在读取作品与内容包…"));
    try {
      await ctx.ensureMeta();
      const data = await api.getPost(id);
      let manifest: Manifest | null = null;
      // 教程正文存放在内容包里，和其他类型一样需要拉取并校验后才能渲染；
      // 教程不显示安装按钮（见 paintDetail），因此这里不会触发安装流程。
      if (data.package) {
        try {
          const verified = await api.fetchVerifiedPackage(id);
          manifest = verified.manifest as unknown as Manifest;
        } catch {
          manifest = null;
        }
      }
      const comments = await api.getComments(id, 1, 12);
      if (ctx.isStale(token)) return;
      // 双保险：即使 body 被别的 loader 抢先重画（token 已过期但调用方没走 isStale），
      // 也不要把旧详情覆盖到新视图上；视图已经切到别的作品时同样放弃。
      const view = ctx.getView();
      if (view.kind !== "detail" || view.id !== id) return;
      ctx.setDetailCache({ data, manifest, comments, commentsPage: 1 });

      if (data.post.status === "published") {
        const seenKey = `${VIEW_KEY}.${id}`;
        try {
          if (sessionStorage.getItem(seenKey) !== "1") {
            sessionStorage.setItem(seenKey, "1");
            void api.viewPost(id);
          }
        } catch {
          /* 隐私模式忽略 */
        }
      }
      paintDetail(ctx);
    } catch (error) {
      if (!ctx.isStale(token)) ctx.showError(error);
    }
  };

const paintDetail = (ctx: CommunityContext) => {
    const detailCache = ctx.getDetailCache();
    if (!detailCache) return;
    const { data, manifest, comments } = detailCache;
    const post = data.post;
    const install = getInstall(post.id);
    const compat = compatibilityCheck(manifest?.compatibility || post.compatibility);
    const isOwner = data.viewer.isOwner;
    const canModerate = data.viewer.canModerate;
    const isWallpaper = post.type === "wallpaper";

    ctx.setBody(`
      <button class="cx-back" type="button" data-action="back">← 返回</button>
      ${post.status !== "published" ? `<div class="cx-status-banner is-${esc(post.status)}"><b>${STATUS_LABEL[post.status] || post.status}</b><span>${post.status === "draft" ? "草稿仅你可见，提交审核后才会公开。" : post.status === "pending_review" ? "作品正在人工审核，通过后会出现在社区。" : post.moderationNote ? `审核备注：${esc(post.moderationNote)}` : "该作品当前不公开。"}</span></div>` : ""}
      <section class="cx-detail-hero">
        <div class="cx-detail-cover">${coverHtml(post, "cx-detail-cover-inner", { full: true })}${data.previews.length > 1 ? `<div class="cx-detail-thumbs">${data.previews.slice(0, 5).map((asset) => `<img src="${safeUrl(asset.url)}" alt="" loading="lazy"/>`).join("")}</div>` : ""}</div>
        <aside class="cx-detail-side">
          <div class="cx-detail-badges">
            <span class="cx-type-chip">${TYPE_GLYPH[post.type]} ${TYPE_LABEL[post.type]}</span>
            <span class="cx-license">${esc(licenseName(post.license))}</span>
            ${post.featured ? `<span class="cx-featured-chip">编辑精选</span>` : ""}
          </div>
          <h1>${esc(post.title)}</h1>
          <button type="button" class="cx-detail-author" data-creator="${esc(post.author.id)}">
            ${avatarHtml(post.author, "s")}
            <span><b>${esc(post.author.displayName)}</b><em>${esc(post.author.creatorTitle || "社区创作者")} · ${ROLE_LABEL[post.author.role] || ""}</em></span>
          </button>
          <div class="cx-detail-meta">
            <div><span>版本</span><b>v${esc(post.version)}</b></div>
            <div><span>更新时间</span><b>${timeAgo(post.updatedAt)}</b></div>
            <div><span>兼容</span><b>OS ${esc(post.compatibility.minimum || "1.3.0")}+</b></div>
            <div><span>安装</span><b>${post.downloadCount}</b></div>
          </div>
          <div class="cx-detail-actions">
            ${
              post.type === "tutorial"
                ? `<button class="cx-btn is-large" type="button" disabled>教程 · 直接阅读</button>`
                : post.status === "published"
                  ? `<button class="cx-btn is-primary is-large" type="button" data-action="install" ${compat.ok ? "" : "disabled"}>${install ? `重新安装 / 更新` : isWallpaper ? "选择壁纸" : "安装到我的桌面"}</button>`
                  : isOwner
                    ? `<button class="cx-btn is-primary is-large" type="button" data-action="publish" data-id="${esc(post.id)}">提交审核 / 发布</button>`
                    : `<button class="cx-btn is-large" type="button" disabled>尚未公开</button>`
            }
            ${!compat.ok ? `<p class="cx-incompatible">${esc(compat.reason)}</p>` : ""}
            <div class="cx-detail-social">
              <button type="button" class="cx-social-btn ${post.viewer.liked ? "is-on" : ""}" data-like="${esc(post.id)}">♥ <b data-like-count="${esc(post.id)}">${post.likeCount}</b> 点赞</button>
              <button type="button" class="cx-social-btn ${post.viewer.favorited ? "is-on" : ""}" data-fav="${esc(post.id)}">★ <b data-fav-count="${esc(post.id)}">${post.favoriteCount}</b> 收藏</button>
              <button type="button" class="cx-social-btn" data-action="report" data-id="${esc(post.id)}">⚑ 举报</button>
            </div>
          </div>
          <div class="cx-install-note">
            ${
              post.type === "theme"
                ? "安装后会保存到主题中心，可随时应用、更新或卸载；原始主题配置与你的本地调整分开保存。"
                : post.type === "widget"
                  ? "安装后注册为声明式桌面组件，不执行任何社区脚本。"
                  : post.type === "workspace"
                    ? "导入会新增一套工作空间，并在导入前为当前布局创建保护性快照。"
                    : post.type === "wallpaper"
                      ? "壁纸下载后交给本机壁纸引擎压缩保存，不会自动公开你的任何文件。"
                      : "教程只读，不会修改系统设置。"
            }
          </div>
          ${
            isOwner || canModerate
              ? `<div class="cx-owner-tools">
                  ${isOwner && ["draft", "rejected"].includes(post.status) ? `<button class="cx-btn is-small" type="button" data-action="edit-post" data-id="${esc(post.id)}">编辑草稿</button>` : ""}
                  ${isOwner && post.status === "published" ? `<button class="cx-btn is-small" type="button" data-action="edit-meta" data-id="${esc(post.id)}">编辑信息</button>` : ""}
                  ${isOwner && post.status === "published" ? `<button class="cx-btn is-small" type="button" data-action="new-version" data-id="${esc(post.id)}">发布新版本</button>` : ""}
                  ${isOwner && post.status === "published" ? `<button class="cx-btn is-small is-ghost" type="button" data-action="withdraw" data-id="${esc(post.id)}">撤回</button>` : ""}
                  ${canModerate ? `<button class="cx-btn is-small is-ghost" type="button" data-action="moderate" data-id="${esc(post.id)}">审核操作</button>` : ""}
                  ${canModerate && post.status === "published" ? `<button class="cx-btn is-small is-ghost" type="button" data-action="feature" data-id="${esc(post.id)}" data-featured="${post.featured ? "1" : "0"}">${post.featured ? "取消精选" : "设为精选"}</button>` : ""}
                  ${isOwner || data.viewer.admin ? `<button class="cx-btn is-small is-danger is-ghost" type="button" data-action="delete-post" data-id="${esc(post.id)}">删除</button>` : ""}
                </div>`
              : ""
          }
        </aside>
      </section>

      <div class="cx-detail-grid">
        <div class="cx-detail-main">
          <section class="cx-panel">
            <div class="cx-section-head"><div><p class="cx-eyebrow">About</p><h2>作品介绍</h2></div></div>
            <div class="cx-markdown">${renderMarkdown(post.description || "创作者还没有填写详细介绍。")}</div>
            <div class="cx-tag-row">${post.tags.map((tag) => `<span>#${esc(tag)}</span>`).join("")}</div>
          </section>

          ${manifest && post.type === "theme" ? themePreviewPanel(manifest) : ""}
          ${manifest && post.type === "widget" ? widgetPreviewPanel(manifest) : ""}
          ${manifest && post.type === "workspace" ? workspacePreviewPanel(manifest) : ""}
          ${manifest && post.type === "tutorial" ? `<section class="cx-panel"><div class="cx-section-head"><div><p class="cx-eyebrow">Tutorial</p><h2>教程正文</h2></div></div><div class="cx-markdown">${renderMarkdown(String((manifest.configuration as Record<string, unknown>)?.content || ""))}</div></section>` : ""}

          ${
            data.previews.length
              ? `<section class="cx-panel"><div class="cx-section-head"><div><p class="cx-eyebrow">Preview</p><h2>预览图</h2></div></div>
                  <div class="cx-preview-grid">${data.previews.map((asset) => `<button type="button" class="cx-preview" data-preview="${esc(asset.url)}"><img src="${safeUrl(asset.url)}" alt="" loading="lazy"/></button>`).join("")}</div></section>`
              : ""
          }

          ${
            data.wallpapers.length
              ? `<section class="cx-panel"><div class="cx-section-head"><div><p class="cx-eyebrow">Wallpapers</p><h2>壁纸（${data.wallpapers.length}）</h2></div></div>
                  <div class="cx-wall-grid">${data.wallpapers
                    .map(
                      (asset) => `<figure class="cx-wall">
                        <img src="${safeUrl(asset.url)}" alt="" loading="lazy"/>
                        <figcaption><span>${asset.width} × ${asset.height}</span><em>${bytesText(asset.sizeBytes)}</em></figcaption>
                        <button type="button" class="cx-btn is-small is-primary" data-action="install-wallpaper" data-id="${esc(post.id)}" data-asset="${esc(asset.id)}">下载并应用</button>
                      </figure>`,
                    )
                    .join("")}</div></section>`
              : ""
          }

          <section class="cx-panel" data-comments-panel>
            ${comments ? renderComments(comments) : ""}
          </section>
        </div>

        <aside class="cx-detail-aside">
          <section class="cx-panel">
            <h3>许可证</h3>
            <div class="cx-license-box">
              <b>${esc(licenseName(post.license))}</b>
              <p>${esc(licenseSummary(post.license))}</p>
              ${post.licenseNote ? `<p class="cx-hint">作者补充：${esc(post.licenseNote)}</p>` : ""}
              <p class="cx-hint">发布者已确认拥有该作品的分享权利。发现侵权可提交举报。</p>
            </div>
          </section>
          <section class="cx-panel">
            <h3>版本历史</h3>
            ${
              data.versions.length
                ? `<ol class="cx-versions">${data.versions
                    .map(
                      (version, index) => `<li>
                        <div><b>v${esc(version.version)}</b>${index === 0 ? `<span class="cx-badge is-ok">最新</span>` : ""}</div>
                        <p>${esc(version.changelog || "没有填写更新说明")}</p>
                        <em>${fmtDate(version.createdAt)} · ${bytesText(version.sizeBytes)}</em>
                        ${(isOwner || canModerate) && index > 0 ? `<button class="cx-link" type="button" data-action="install-version" data-id="${esc(post.id)}" data-version="${esc(version.version)}">安装此版本</button>` : ""}
                      </li>`,
                    )
                    .join("")}</ol>`
                : `<p class="cx-hint">还没有发布内容包。</p>`
            }
          </section>
          <section class="cx-panel">
            <h3>真实数据</h3>
            <div class="cx-detail-stats">
              <span><b>${post.viewCount}</b>浏览</span>
              <span><b>${post.likeCount}</b>点赞</span>
              <span><b>${post.favoriteCount}</b>收藏</span>
              <span><b>${post.downloadCount}</b>安装</span>
              <span><b>${post.commentCount}</b>评论</span>
            </div>
            <p class="cx-hint">浏览统计只按作品与日期聚合，不记录 IP、设备或精确位置。</p>
          </section>
        </aside>
      </div>
      ${renderCommentComposer(ctx)}
    `);
  };

  const renderComments = (comments: Awaited<ReturnType<typeof api.getComments>>) => `
    <div class="cx-section-head"><div><p class="cx-eyebrow">Discussion</p><h2>评论（${comments.total}）</h2></div></div>
    <div class="cx-comment-list">
      ${
        comments.items.length
          ? comments.items.map((comment) => renderComment(comment)).join("")
          : `<p class="cx-hint">还没有评论，来留下第一条。</p>`
      }
    </div>
    ${
      comments.hasMore
        ? `<button class="cx-btn is-ghost" type="button" data-action="more-comments">加载更多评论</button>`
        : ""
    }`;

  const renderComment = (comment: api.CommunityComment) => {
    if (comment.status === "deleted") {
      return `<article class="cx-comment is-deleted"><p>该评论已删除</p></article>`;
    }
    if (comment.status === "hidden") {
      return `<article class="cx-comment is-hidden"><p>该评论因违反社区规范被隐藏</p></article>`;
    }
    return `<article class="cx-comment" data-comment="${esc(comment.id)}">
      ${avatarHtml(comment.author, "s")}
      <div class="cx-comment-main">
        <div class="cx-comment-head"><b>${esc(comment.author?.displayName || "用户")}</b>${roleBadge(comment.author?.role)}<span>${timeAgo(comment.createdAt)}</span></div>
        <p>${esc(comment.content)}</p>
        <div class="cx-comment-actions">
          <button type="button" data-action="reply" data-id="${esc(comment.id)}">回复</button>
          ${comment.canDelete ? `<button type="button" data-action="delete-comment" data-id="${esc(comment.id)}">删除</button>` : ""}
          <button type="button" data-action="report-comment" data-id="${esc(comment.id)}">举报</button>
        </div>
        <div class="cx-reply-box" data-reply-box="${esc(comment.id)}" hidden>
          <textarea class="cx-input" rows="2" maxlength="1000" placeholder="回复 ${esc(comment.author?.displayName || "这条评论")}…" data-reply-input="${esc(comment.id)}"></textarea>
          <div><button class="cx-btn is-small is-primary" type="button" data-action="submit-reply" data-id="${esc(comment.id)}">发送回复</button>
          <button class="cx-btn is-small is-ghost" type="button" data-action="cancel-reply" data-id="${esc(comment.id)}">取消</button></div>
        </div>
        ${
          comment.replies.length
            ? `<div class="cx-replies">${comment.replies
                .map(
                  (reply) => `<article class="cx-comment is-reply" data-comment="${esc(reply.id)}">
                    ${avatarHtml(reply.author, "xs")}
                    <div class="cx-comment-main">
                      <div class="cx-comment-head"><b>${esc(reply.author?.displayName || "用户")}</b>${roleBadge(reply.author?.role)}<span>${timeAgo(reply.createdAt)}</span></div>
                      <p>${esc(reply.content)}</p>
                      <div class="cx-comment-actions">${reply.canDelete ? `<button type="button" data-action="delete-comment" data-id="${esc(reply.id)}">删除</button>` : ""}<button type="button" data-action="report-comment" data-id="${esc(reply.id)}">举报</button></div>
                    </div>
                  </article>`,
                )
                .join("")}</div>`
            : ""
        }
      </div>
    </article>`;
  };

const renderCommentComposer = (ctx: CommunityContext) => {
    if (!ctx.getViewer()) {
      return `<section class="cx-panel cx-comment-gate"><p>登录后可以评论、回复与举报。</p><button class="cx-btn is-primary" type="button" data-action="login">登录</button></section>`;
    }
    return `<section class="cx-panel cx-comment-composer">
      <h3>发表评论</h3>
      <textarea class="cx-input" rows="3" maxlength="1000" data-comment-input placeholder="友善、具体地表达你的想法…"></textarea>
      <div class="cx-comment-composer-foot"><span>最多 1000 字，支持两层回复；内容会经过长度、频率与垃圾信息过滤。</span><button class="cx-btn is-primary" type="button" data-action="submit-comment">发表评论</button></div>
    </section>`;
  };

  const themePreviewPanel = (manifest: Manifest) => {
    const config = manifest.configuration as ThemeConfig;
    const wall = safeWallId(config.wall);
    const a = safeHex(config.accent);
    const b = safeHex(config.accent2);
    return `<section class="cx-panel">
      <div class="cx-section-head"><div><p class="cx-eyebrow">Theme</p><h2>主题预览</h2></div></div>
      <div class="cx-theme-preview" style="--cx-a:${a};--cx-b:${b}">
        <img src="${safeUrl(`/wallpapers/thumbs/${wall}.webp`)}" alt=""/>
        <span class="cx-tp-menubar"></span>
        <span class="cx-tp-window"><i></i><b></b><b></b><em></em></span>
        <span class="cx-tp-widget"></span>
        <span class="cx-tp-dock"><i></i><i></i><i></i><i></i></span>
      </div>
      <div class="cx-theme-tokens">
        <span><i style="background:${a}"></i>${a}</span>
        <span><i style="background:${b}"></i>${b}</span>
        <span>材质 ${esc(config.material)}</span>
        <span>圆角 ${esc(config.radius)}</span>
        <span>${config.mode === "light" ? "浅色" : "深色"}</span>
      </div>
    </section>`;
  };

  const widgetPreviewPanel = (manifest: Manifest) => {
    const config = manifest.configuration as WidgetConfig;
    return `<section class="cx-panel">
      <div class="cx-section-head"><div><p class="cx-eyebrow">Widget</p><h2>组件说明</h2></div></div>
      <div class="cx-widget-info">
        <div><span>组件类型</span><b>${esc(WIDGET_TYPE_LABEL[config.widgetType] || config.widgetType)}</b></div>
        <div><span>渲染方式</span><b>系统声明式渲染</b></div>
        <div><span>请求权限</span><b>${esc(config.permissions.join(" · ") || "none")}</b></div>
      </div>
      <ul class="cx-perm-list">${(config.permissions.length ? config.permissions : ["none"]).map((permission) => `<li><b>${esc(permission)}</b><span>${esc((window as unknown as { __CX_PERMS?: Record<string, string> }).__CX_PERMS?.[permission] || "不需要额外数据")}</span></li>`).join("")}</ul>
      <p class="cx-hint">组件配置只包含受控属性；不会执行 JavaScript、HTML 或 WASM。</p>
    </section>`;
  };

  const workspacePreviewPanel = (manifest: Manifest) => {
    const config = manifest.configuration as WorkspaceConfig;
    return `<section class="cx-panel">
      <div class="cx-section-head"><div><p class="cx-eyebrow">Workspace</p><h2>工作空间内容</h2></div></div>
      <div class="cx-widget-info">
        <div><span>应用</span><b>${config.openApps?.length || 0} 个</b></div>
        <div><span>组件</span><b>${Object.keys(config.widgets || {}).length} 个</b></div>
        <div><span>程序坞</span><b>${config.dock?.length || 0} 项</b></div>
        <div><span>快捷方式</span><b>${config.shortcuts?.length || 0} 个</b></div>
      </div>
      <p class="cx-hint">工作空间只包含布局与外观，不包含笔记正文、日历事件、文件路径、账号信息或 Session。</p>
    </section>`;
  };

  export const licenseName = (id: string) => LICENSE_OPTIONS.find((license) => license.id === id)?.name || id;
  const licenseSummary = (id: string) => LICENSE_OPTIONS.find((license) => license.id === id)?.summary || "";

export const refreshCommentsImpl = async (ctx: CommunityContext, page = 1) => {
    const detailCache = ctx.getDetailCache();
    if (!detailCache) return;
    // 记住发起请求时是哪个作品：await 期间用户可能已经返回列表并打开别的作品，
    // 回来时不能再把 A 的评论写进 B 的缓存与面板（旧实现完全没有校验）。
    const postId = detailCache.data.post.id;
    const comments = await api.getComments(postId, page, 12);
    const current = ctx.getDetailCache();
    if (!current || current.data.post.id !== postId) return;
    current.comments = comments;
    current.commentsPage = page;
    const panel = ctx.win.querySelector<HTMLElement>("[data-comments-panel]");
    if (panel) panel.innerHTML = renderComments(comments);
  };
