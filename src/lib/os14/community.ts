/**
 * Guandao OS 1.6 · Guandao Community 应用
 *
 * 一个真正接入现有系统的社区前端：
 *   发现 → 详情 → 校验 → 安装 → 互动 → 创作者主页 → 审核后台
 * 所有数据来自 /api/community/*，没有任何写死的点赞、评论或用户。
 *
 * 社区内容始终以文本方式渲染；Markdown 使用 core.renderMarkdown（先整体转义）。
 */

// 1.9：应用样式跟着应用代码一起按需加载，不再压进首屏 CSS
import "../../styles/community.css";
// 2.3.1：社区封面/头像/资产预览是第三方内容，图片 URL 走协议校验
import { safeUrl } from "../html";
import {
  badge,
  emptyState,
  escapeHtml,
  fmtAgo,
  fmtDate,
  ls,
  modal,
  renderMarkdown,
  shell,
  type Ctx,
} from "./core";
import {
  allThemes,
  applyTheme,
  findTheme,
  readThemeState,
} from "./themes";
import {
  applyWorkspace,
  captureCurrentWorkspace,
  currentWorkspace,
  workspaceList,
} from "./workspaces";
import { communityWidgetConfigs } from "./widgetstore";
import * as api from "../community/api";
import type { PostType } from "../community/api";
import {
  checkUpdate,
  compareSemver,
  getInstall,
  installFromServer,
  installWallpaperAsset,
  installedRecords,
  uninstallByPost,
  type InstallRecord,
} from "../community/install";
import {
  CATEGORY_LABEL,
  LICENSE_OPTIONS,
  WIDGET_TYPES,
  WIDGET_TYPE_LABEL,
  compatibilityCheck,
  nextVersion,
  readManifestFile,
  slugify,
  validateManifestClient,
  type Manifest,
  type ThemeConfig,
  type WidgetConfig,
  type WorkspaceConfig,
} from "../community/manifest";

/* ---------------- 2.5 拆分后的内部依赖 ----------------
   类型 / 常量 / 纯渲染工具已移到 ./community/*。
   这里 import 回来，initCommunity 内部的 73 个函数继续用同样的名字，
   行为与拆分前完全一致。 */
import type { AssetRef, Post, PublishState, Role, ViewState } from "./community/types";
import {
  LAYOUT_KEY,
  REASON_LABEL,
  ROLE_LABEL,
  SEARCH_SORTS,
  STATUS_LABEL,
  TYPE_GLYPH,
  TYPE_LABEL,
  VIEW_KEY,
} from "./community/constants";
import {
  avatarHtml,
  bytesText,
  categoryChips,
  clampText,
  coverHtml,
  detailPermissionText,
  errorPanel,
  esc,
  loginGate,
  pageNav,
  postCard,
  progressBar,
  roleBadge,
  safeHex,
  safeWallId,
  skeleton,
  timeAgo,
  typeChips,
} from "./community/ui";
import { loadFollowingTab, loadMyFavorites } from "./community/loaders";
import type { CommunityContext } from "./community/context";
import { notificationBody, notificationTitle } from "./community/notifications";

/* ============================================================
   应用入口
   ============================================================ */

export const renderCommunity = () => {
  const nav: Array<[string, string, string]> = [
    ["home", "首页", "⌂"],
    ["explore", "发现", "◈"],
    ["themes", "主题", "◑"],
    ["widgets", "组件", "▦"],
    ["workspaces", "工作空间", "▤"],
    ["wallpapers", "壁纸", "▧"],
    ["creators", "创作者", "◎"],
    ["following", "关注动态", "⇢"],
    ["creations", "我的作品", "✎"],
    ["favorites", "我的收藏", "★"],
    ["plugins", "插件市场", "⧉"],
    ["plugins", "插件市场", "⧉"],
    ["notifications", "通知", "◔"],
    ["moderation", "审核中心", "⚑"],
  ];
  return shell(
    "community",
    nav,
    `<div class="cx-app">
      <header class="cx-top">
        <div class="cx-search">
          <span>⌕</span>
          <input type="search" data-cx-search placeholder="搜索作品、创作者、标签…" maxlength="60" autocomplete="off"/>
          <button type="button" data-action="search">搜索</button>
        </div>
        <div class="cx-topacts">
          <button type="button" class="cx-btn is-ghost" data-tab="notifications">通知<span class="cx-unread" data-cx-unread hidden>0</span></button>
          <button type="button" class="cx-btn is-primary" data-action="publish">＋ 发布作品</button>
        </div>
      </header>
      <div class="cx-body" data-cx-body>${skeleton()}</div>
    </div>`,
    "Guandao Community",
  );
};

export const initCommunity = (win: HTMLElement, ctx: Ctx): (() => void) => {
  const root = win.querySelector<HTMLElement>(".g14-shell") ?? win;
  const body = win.querySelector<HTMLElement>("[data-cx-body]");
  const searchInput = win.querySelector<HTMLInputElement>("[data-cx-search]");
  if (!body) return () => undefined;

  let meta: api.CommunityMeta | null = null;
  let view: ViewState = { kind: "tab", tab: "home" };
  let layout: "grid" | "list" = ls.str(LAYOUT_KEY) === "list" ? "list" : "grid";
  let loadToken = 0;
  let explore = { type: "", category: "", sort: "latest", page: 1 };
  let searchState = { q: "", type: "", sort: "latest", page: 1 };
  let creatorsSort = "active";
  let creatorPostType = "";
  let creatorPostSort = "latest";
  let creationsTab: "works" | "profile" | "installed" = "works";
  let creationsStatus = "all";
  let creationsType = "";
  let favoritesCollection = "";
  let notificationsPage = 1;
  let moderationTab: "queue" | "reports" | "users" | "settings" | "invites" | "audit" = "queue";
  let moderationQueueStatus = "pending_review";
  let moderationReportStatus = "open";
  let detailCache: {
    data: Awaited<ReturnType<typeof api.getPost>>;
    manifest: Manifest | null;
    comments: Awaited<ReturnType<typeof api.getComments>> | null;
    commentsPage: number;
  } | null = null;
  let publishState: PublishState | null = null;
  let versionState: { post: Post; manifest: Manifest | null; baseVersion: string } | null = null;
  let installedCache: InstallRecord[] = [];

  const toast = (message: string) => ctx.toast(message);
  const viewer = () => meta?.viewer ?? null;
  const isStaff = () => Boolean(meta?.viewer?.staff);
  const isAdmin = () => Boolean(meta?.viewer?.admin);

  const ensureMeta = async () => {
    if (meta) return meta;
    meta = await api.getMeta();
    (window as unknown as { __CX_PERMS?: Record<string, string> }).__CX_PERMS = meta.widgetPermissions;
    applyViewerChrome();
    return meta;
  };

  const applyViewerChrome = () => {
    const unread = meta?.unreadNotifications ?? 0;
    const badgeNode = win.querySelector<HTMLElement>("[data-cx-unread]");
    if (badgeNode) {
      badgeNode.hidden = unread <= 0;
      badgeNode.textContent = unread > 99 ? "99+" : String(unread);
    }
    root.querySelectorAll<HTMLElement>(".g14-nav").forEach((node) => {
      if (node.dataset.tab === "moderation") node.hidden = !isStaff();
    });
    const publishBtn = win.querySelector<HTMLElement>('[data-action="publish"]');
    if (publishBtn) publishBtn.hidden = !meta?.allowPublishing;
  };

  const setActiveNav = (tab: string) => {
    root.querySelectorAll<HTMLElement>(".g14-nav").forEach((node) => {
      node.classList.toggle("is-active", node.dataset.tab === tab);
    });
  };

  const openTab = (tab: string) => {
    if (tab === "moderation" && !isStaff()) return;
    if (tab === "plugins") {
      ctx.openApp("pmarket");
      return;
    }
    if (tab === "plugins") {
      ctx.openApp("pmarket");
      return;
    }
    lastTab = tab === "detail" ? lastTab : tab;
    view = { kind: "tab", tab };
    setActiveNav(tab);
    if (tab === "home") void loadHome();
    else if (tab === "explore" || tab === "themes" || tab === "widgets" || tab === "workspaces" || tab === "wallpapers") {
      const type = tab === "themes" ? "theme" : tab === "widgets" ? "widget" : tab === "workspaces" ? "workspace" : tab === "wallpapers" ? "wallpaper" : "";
      explore = { type, category: "", sort: "latest", page: 1 };
      void loadExplore(type);
    } else if (tab === "creators") void loadCreators();
    else if (tab === "following") void loadFollowing();
    else if (tab === "creations") void loadCreations(creationsTab);
    else if (tab === "favorites") void loadFavorites();
    else if (tab === "notifications") void loadNotifications(1);
    else if (tab === "moderation") void loadModeration();
  };

  const setBody = (html: string) => {
    body.innerHTML = html;
    body.scrollTop = 0;
  };

  const showError = (error: unknown) => {
    const message = error instanceof Error ? error.message : "未知错误";
    setBody(errorPanel(message));
  };

  const needLogin = (): boolean => {
    if (viewer()) return false;
    setBody(loginGate());
    return true;
  };

  const run = async <T>(task: () => Promise<T>): Promise<T | null> => {
    const token = ++loadToken;
    setBody(skeleton());
    try {
      const result = await task();
      return token === loadToken ? result : null;
    } catch (error) {
      if (token === loadToken) showError(error);
      return null;
    }
  };

  /* ============================================================
     首页
     ============================================================ */

  const loadHome = async () => {
    const token = ++loadToken;
    setBody(skeleton("正在汇总最新、热门与创作者动态…"));
    try {
      await ensureMeta();
      const [latest, trending, creators, featured, following] = await Promise.all([
        api.getFeed({ tab: "latest", limit: 8 }),
        api.getFeed({ tab: "trending", limit: 5 }),
        api.getCreators({ sort: "active", limit: 6 }),
        api.getFeed({ tab: "featured", limit: 3 }),
        viewer() ? api.getFollowingFeed(1).catch(() => null) : Promise.resolve(null),
      ]);
      if (token !== loadToken) return;
      const counts = meta?.counts || {};
      const topCreators = creators.items;
      setBody(`
        <section class="cx-hero">
          <div class="cx-hero-copy">
            <p class="cx-eyebrow">Guandao Community · OS ${esc(meta?.osVersion || "1.6.0")}</p>
            <h1>Create. Share. <em>Discover.</em></h1>
            <p class="cx-hero-lead">${esc(meta?.announcement || "把桌面变成作品：发布主题、组件、工作空间与壁纸，让别人的桌面因为你的设计变得更好。")}</p>
            <div class="cx-hero-actions">
              <button type="button" class="cx-btn is-primary" data-action="explore-all">开始探索</button>
              <button type="button" class="cx-btn" data-action="publish">发布我的作品</button>
            </div>
            <div class="cx-hero-stats">
              <span><b>${counts.theme || 0}</b>主题</span>
              <span><b>${counts.widget || 0}</b>组件</span>
              <span><b>${counts.workspace || 0}</b>工作空间</span>
              <span><b>${counts.wallpaper || 0}</b>壁纸</span>
              <span><b>${counts.tutorial || 0}</b>教程</span>
            </div>
          </div>
          <div class="cx-hero-art" aria-hidden="true">
            <span class="cx-orb is-a"></span><span class="cx-orb is-b"></span>
            <div class="cx-art-window"><i></i><b></b><b></b><span></span></div>
            <div class="cx-art-card"><span></span><i></i></div>
            <div class="cx-art-dock"><i></i><i></i><i></i><i></i></div>
          </div>
        </section>

        ${
          featured.items.length
            ? `<section class="cx-section">
                <div class="cx-section-head"><div><p class="cx-eyebrow">Featured</p><h2>编辑精选</h2></div><button class="cx-link" type="button" data-action="explore-all">浏览全部 →</button></div>
                <div class="cx-feature-grid">${featured.items.map((post) => postCard(post)).join("")}</div>
              </section>`
            : ""
        }

        <section class="cx-home-grid">
          <div class="cx-home-main">
            <div class="cx-section-head"><div><p class="cx-eyebrow">Latest</p><h2>最新作品</h2></div><button class="cx-link" type="button" data-action="explore-all">发现更多 →</button></div>
            ${latest.items.length ? `<div class="cx-grid is-${layout}">${latest.items.map((post) => postCard(post, { row: layout === "list" })).join("")}</div>` : emptyState("社区还没有作品", "成为第一个发布作品的人。", "◇")}
          </div>
          <aside class="cx-home-side">
            <section class="cx-panel">
              <div class="cx-section-head"><div><p class="cx-eyebrow">Trending</p><h2>真实热度</h2></div></div>
              ${
                trending.items.length
                  ? `<ol class="cx-trending">${trending.items
                      .map(
                        (post, index) => `<li data-post="${esc(post.id)}">
                          <b>${index + 1}</b>
                          <div><span>${esc(post.title)}</span><em>${esc(post.author.displayName)} · ♥ ${post.likeCount} · ★ ${post.favoriteCount}</em></div>
                        </li>`,
                      )
                      .join("")}</ol>`
                  : `<p class="cx-hint">还没有足够的互动数据。热门榜只使用真实的点赞、收藏、评论与安装次数。</p>`
              }
            </section>
            <section class="cx-panel">
              <div class="cx-section-head"><div><p class="cx-eyebrow">Creators</p><h2>创作者推荐</h2></div></div>
              ${
                topCreators.length
                  ? `<div class="cx-creator-list">${topCreators
                      .map(
                        (creator) => `<button type="button" class="cx-creator-row" data-creator="${esc(creator.id)}">
                          ${avatarHtml(creator, "s")}
                          <div><b>${esc(creator.displayName)}</b><span>${creator.postCount} 个作品 · ${creator.followerCount} 位关注者</span></div>
                          ${roleBadge(creator.role)}
                        </button>`,
                      )
                      .join("")}</div>`
                  : `<p class="cx-hint">还没有公开的创作者主页。</p>`
              }
            </section>
            ${
              following && following.items.length
                ? `<section class="cx-panel"><div class="cx-section-head"><div><p class="cx-eyebrow">Following</p><h2>关注动态</h2></div></div>
                    <div class="cx-follow-mini">${following.items
                      .slice(0, 3)
                      .map(
                        (post) => `<button type="button" class="cx-mini-post" data-post="${esc(post.id)}">
                          ${post.coverThumbUrl ? `<img src="${safeUrl(post.coverThumbUrl)}" alt=""/>` : `<span>${TYPE_GLYPH[post.type]}</span>`}
                          <div><b>${esc(post.title)}</b><em>${esc(post.author.displayName)} · ${timeAgo(post.publishedAt)}</em></div>
                        </button>`,
                      )
                      .join("")}</div></section>`
                : ""
            }
          </aside>
        </section>

        <section class="cx-section">
          <div class="cx-section-head"><div><p class="cx-eyebrow">Explore</p><h2>按分类发现</h2></div></div>
          <div class="cx-category-grid">
            ${Object.entries(TYPE_LABEL)
              .map(
                ([type, label]) => `<button type="button" class="cx-category" data-type="${esc(type)}">
                  <span>${TYPE_GLYPH[type]}</span>
                  <b>${esc(label)}</b>
                  <em>${counts[type as PostType] || 0} 个作品</em>
                </button>`,
              )
              .join("")}
          </div>
        </section>
      `);
    } catch (error) {
      if (token === loadToken) showError(error);
    }
  };

  /* ============================================================
     发现 / 分类列表
     ============================================================ */

  const loadExplore = async (type = explore.type, options: { resetPage?: boolean } = {}) => {
    if (options.resetPage) explore.page = 1;
    explore.type = type;
    setActiveNav(type === "theme" ? "themes" : type === "widget" ? "widgets" : type === "workspace" ? "workspaces" : type === "wallpaper" ? "wallpapers" : "explore");
    const token = ++loadToken;
    setBody(skeleton());
    try {
      await ensureMeta();
      const result = await api.getExplore({
        type: type || undefined,
        category: explore.category || undefined,
        sort: explore.sort,
        page: explore.page,
        limit: 12,
      });
      if (token !== loadToken) return;
      const heading = type ? `${TYPE_LABEL[type]}市场` : "发现社区作品";
      const sub = type
        ? `浏览社区里的${TYPE_LABEL[type]}作品，按分类与热度筛选。`
        : "所有作品都来自真实用户发布；点击卡片查看详情、互动与安装。";
      setBody(`
        <section class="cx-page-head">
          <div><p class="cx-eyebrow">Explore</p><h1>${heading}</h1><p>${sub}</p></div>
          <div class="cx-layout-toggle">
            <button type="button" class="${layout === "grid" ? "is-active" : ""}" data-layout="grid" title="网格">▦</button>
            <button type="button" class="${layout === "list" ? "is-active" : ""}" data-layout="list" title="列表">☰</button>
          </div>
        </section>
        <div class="cx-toolbar">
          <div class="cx-chip-row">${typeChips(type, "filter-type")}</div>
          ${type ? `<div class="cx-chip-row is-sub">${categoryChips(type, explore.category, "filter-cat")}</div>` : ""}
          <div class="cx-toolbar-row">
            <select class="cx-select" data-explore-sort>
              ${SEARCH_SORTS.map(([id, label]) => `<option value="${id}" ${explore.sort === id ? "selected" : ""}>${label}</option>`).join("")}
            </select>
            <span class="cx-count">共 ${result.total} 个作品</span>
          </div>
        </div>
        ${
          result.items.length
            ? `<div class="cx-grid is-${layout}">${result.items.map((post) => postCard(post, { row: layout === "list" })).join("")}</div>`
            : emptyState("这个筛选下还没有作品", "换个分类，或者发布第一个。", "◇")
        }
        ${result.total ? pageNav(result.page, result.hasMore, result.total) : ""}
      `);
    } catch (error) {
      if (token === loadToken) showError(error);
    }
  };

  /* ============================================================
     搜索
     ============================================================ */

  const loadSearch = async (q: string, resetPage = true) => {
    searchState.q = q.slice(0, 60);
    if (resetPage) searchState.page = 1;
    if (!searchState.q) return loadHome();
    view = { kind: "search", q: searchState.q };
    setActiveNav("explore");
    const token = ++loadToken;
    setBody(skeleton("正在搜索社区作品与创作者…"));
    try {
      await ensureMeta();
      const result = await api.getSearch({
        q: searchState.q,
        type: searchState.type || undefined,
        sort: searchState.sort,
        page: searchState.page,
        limit: 12,
      });
      if (token !== loadToken) return;
      setBody(`
        <section class="cx-page-head">
          <div><p class="cx-eyebrow">Search</p><h1>“${esc(result.query)}” 的结果</h1><p>${result.total} 个作品 · ${result.creators.length} 位相关创作者</p></div>
        </section>
        <div class="cx-toolbar">
          <div class="cx-chip-row">${typeChips(searchState.type, "search-type")}</div>
          <div class="cx-toolbar-row">
            <select class="cx-select" data-search-sort>
              ${SEARCH_SORTS.map(([id, label]) => `<option value="${id}" ${searchState.sort === id ? "selected" : ""}>${label}</option>`).join("")}
            </select>
          </div>
        </div>
        ${
          result.creators.length
            ? `<div class="cx-search-creators">${result.creators
                .map(
                  (creator) => `<button type="button" class="cx-search-creator" data-creator="${esc(creator.id)}">
                    ${avatarHtml(creator, "s")}<div><b>${esc(creator.displayName)}</b><span>${creator.postCount} 个作品</span></div>
                  </button>`,
                )
                .join("")}</div>`
            : ""
        }
        ${
          result.items.length
            ? `<div class="cx-grid is-${layout}">${result.items.map((post) => postCard(post, { row: layout === "list" })).join("")}</div>`
            : emptyState("没有找到相关作品", "试试更短的关键词，或直接浏览发现页。", "⌕")
        }
        ${result.total ? pageNav(result.page, result.hasMore, result.total) : ""}
      `);
    } catch (error) {
      if (token === loadToken) showError(error);
    }
  };

  /* ============================================================
     创作者
     ============================================================ */

  const loadCreators = async () => {
    setActiveNav("creators");
    const token = ++loadToken;
    setBody(skeleton("正在读取创作者主页…"));
    try {
      await ensureMeta();
      const result = await api.getCreators({ sort: creatorsSort, limit: 24 });
      if (token !== loadToken) return;
      setBody(`
        <section class="cx-page-head">
          <div><p class="cx-eyebrow">Creators</p><h1>社区创作者</h1><p>每个主页都来自真实账号；关注后会在「关注动态」看到新作品。</p></div>
          <select class="cx-select" data-creator-sort>
            <option value="active" ${creatorsSort === "active" ? "selected" : ""}>按作品数量</option>
            <option value="new" ${creatorsSort === "new" ? "selected" : ""}>最新加入</option>
          </select>
        </section>
        ${
          result.items.length
            ? `<div class="cx-creator-grid">${result.items
                .map(
                  (creator) => `<article class="cx-creator-card" data-creator="${esc(creator.id)}">
                    <div class="cx-creator-cover">${creator.coverUrl ? `<img src="${safeUrl(creator.coverUrl)}" alt="" loading="lazy"/>` : ""}<span></span></div>
                    <div class="cx-creator-body">
                      ${avatarHtml(creator, "l")}
                      <h3>${esc(creator.displayName)} ${roleBadge(creator.role)}</h3>
                      <p class="cx-creator-title">${esc(creator.creatorTitle || "社区创作者")}</p>
                      <p class="cx-creator-bio">${esc(creator.bio || "还没有填写创作者介绍。")}</p>
                      <div class="cx-creator-stats"><span><b>${creator.postCount}</b>作品</span><span><b>${creator.followerCount}</b>关注者</span><span><b>${creator.featuredCount}</b>精选</span></div>
                    </div>
                  </article>`,
                )
                .join("")}</div>`
            : emptyState("还没有公开创作者", "发布第一个作品，或者邀请朋友加入。", "◎")
        }
      `);
    } catch (error) {
      if (token === loadToken) showError(error);
    }
  };

  const loadCreator = async (id: string) => {
    view = { kind: "creator", id };
    setActiveNav("creators");
    const token = ++loadToken;
    setBody(skeleton("正在打开创作者主页…"));
    try {
      await ensureMeta();
      const result = await api.getCreator(id, { type: creatorPostType || undefined, sort: creatorPostSort });
      if (token !== loadToken) return;
      const creator = result.creator;
      setBody(`
        <button class="cx-back" type="button" data-action="back">← 返回</button>
        <section class="cx-profile-hero">
          <div class="cx-profile-cover">${creator.coverUrl ? `<img src="${safeUrl(creator.coverUrl)}" alt=""/>` : `<span></span>`}</div>
          <div class="cx-profile-main">
            ${avatarHtml(creator, "xl")}
            <div class="cx-profile-copy">
              <p class="cx-eyebrow">Creator</p>
              <h1>${esc(creator.displayName)} ${roleBadge(creator.role)}</h1>
              <p class="cx-creator-title">${esc(creator.creatorTitle || "社区创作者")} · 加入于 ${fmtDate(creator.joinedAt)}</p>
              <p>${esc(creator.bio || "这个创作者还没有写介绍。")}</p>
              <div class="cx-profile-actions">
                ${
                  creator.isSelf
                    ? `<button class="cx-btn" type="button" data-action="my-profile">编辑创作者资料</button>`
                    : creator.canFollow
                      ? `<button class="cx-btn ${creator.isFollowing ? "" : "is-primary"}" type="button" data-follow="${esc(creator.id)}" data-follow-state="${creator.isFollowing ? "1" : "0"}">${creator.isFollowing ? "已关注" : "关注创作者"}</button>`
                      : ""
                }
                <button class="cx-btn is-ghost" type="button" data-action="report-profile" data-id="${esc(creator.id)}">举报</button>
              </div>
            </div>
            <div class="cx-profile-stats">
              <span><b>${creator.stats.posts}</b>作品</span>
              <span><b>${creator.stats.followers}</b>关注者</span>
              <span><b>${creator.stats.likes}</b>获赞</span>
              <span><b>${creator.stats.downloads}</b>安装</span>
            </div>
          </div>
        </section>
        ${
          result.featured.length
            ? `<section class="cx-section"><div class="cx-section-head"><div><p class="cx-eyebrow">Featured</p><h2>精选作品</h2></div></div>
                <div class="cx-feature-grid">${result.featured.map((post) => postCard(post)).join("")}</div></section>`
            : ""
        }
        <section class="cx-section">
          <div class="cx-section-head"><div><p class="cx-eyebrow">Portfolio</p><h2>全部作品</h2></div><span class="cx-count">${result.total} 个</span></div>
          <div class="cx-toolbar">
            <div class="cx-chip-row">
              <button type="button" class="cx-chip ${creatorPostType === "" ? "is-active" : ""}" data-creator-type="">全部</button>
              ${Object.entries(TYPE_LABEL).map(([id, label]) => `<button type="button" class="cx-chip ${creatorPostType === id ? "is-active" : ""}" data-creator-type="${id}">${label}</button>`).join("")}
            </div>
            <div class="cx-toolbar-row">
              <select class="cx-select" data-creator-post-sort>
                <option value="latest" ${creatorPostSort === "latest" ? "selected" : ""}>最新发布</option>
                <option value="popular" ${creatorPostSort === "popular" ? "selected" : ""}>最受欢迎</option>
                <option value="downloads" ${creatorPostSort === "downloads" ? "selected" : ""}>安装最多</option>
              </select>
            </div>
          </div>
          ${result.posts.length ? `<div class="cx-grid is-grid">${result.posts.map((post) => postCard(post)).join("")}</div>` : emptyState("这个分类下还没有公开作品", "换个分类看看。", "◇")}
        </section>
      `);
    } catch (error) {
      if (token === loadToken) showError(error);
    }
  };

  const communityCtx: CommunityContext = {
    setActiveNav,
    needLogin,
    setBody,
    showError,
    ensureMeta,
    emptyState,
    nextToken: () => ++loadToken,
    isStale: (token: number) => token !== loadToken,
    get layout() {
      return layout;
    },
    get favoritesCollection() {
      return favoritesCollection;
    },
  };

  const loadFollowing = () => loadFollowingTab(communityCtx);

  const loadFavorites = () => loadMyFavorites(communityCtx);
;

  /* ============================================================
     收藏 / 通知
     ============================================================ */

  ;

  const loadNotifications = async (page = notificationsPage) => {
    setActiveNav("notifications");
    if (needLogin()) return;
    notificationsPage = page;
    const token = ++loadToken;
    setBody(skeleton("正在读取通知…"));
    try {
      await ensureMeta();
      const result = await api.getMyNotifications(page);
      if (token !== loadToken) return;
      if (meta) meta.unreadNotifications = result.unread;
      applyViewerChrome();
      setBody(`
        <section class="cx-page-head">
          <div><p class="cx-eyebrow">Notifications</p><h1>通知</h1><p>评论、回复、审核结果、作品更新与关注动态。未读 ${result.unread} 条。</p></div>
          <button class="cx-btn" type="button" data-action="mark-all" ${result.unread ? "" : "disabled"}>全部标为已读</button>
        </section>
        ${
          result.items.length
            ? `<div class="cx-notifications">${result.items
                .map(
                  (item) => `<article class="cx-notification ${item.read ? "" : "is-unread"}" data-notif="${esc(item.id)}" ${item.postId ? `data-post="${esc(item.postId)}"` : ""}>
                    <span class="cx-notif-dot"></span>
                    <div class="cx-notif-main">
                      <b>${notificationTitle(item)}</b>
                      <p>${esc(notificationBody(item))}</p>
                      <span>${timeAgo(item.createdAt)}${item.postTitle ? ` · ${esc(item.postTitle)}` : ""}</span>
                    </div>
                  </article>`,
                )
                .join("")}</div>`
            : emptyState("还没有通知", "发布作品、关注创作者后，这里会有新动态。", "◔")
        }
        ${pageNav(page, result.items.length >= result.limit, result.items.length, "条通知")} 
      `);
    } catch (error) {
      if (token === loadToken) showError(error);
    }
  };

  
  

  /* ============================================================
     我的作品 / 资料 / 已安装
     ============================================================ */

  const loadCreations = async (tab: "works" | "profile" | "installed" = creationsTab) => {
    creationsTab = tab;
    setActiveNav("creations");
    if (needLogin()) return;
    const token = ++loadToken;
    setBody(skeleton());
    try {
      await ensureMeta();
      if (tab === "works") {
        const result = await api.getMyCreations({ status: creationsStatus, type: creationsType || undefined, page: 1 });
        if (token !== loadToken) return;
        const statuses: Array<[string, string]> = [["all", "全部"], ["published", "已发布"], ["pending_review", "待审核"], ["draft", "草稿"], ["rejected", "未通过"], ["hidden", "已隐藏"]];
        setBody(`
          <section class="cx-page-head">
            <div><p class="cx-eyebrow">My Creations</p><h1>我的作品</h1><p>草稿、审核状态与版本都在这里管理。</p></div>
            <button class="cx-btn is-primary" type="button" data-action="publish">＋ 发布</button>
          </section>
          <div class="cx-tabs">
            <button type="button" class="${tab === "works" ? "is-active" : ""}" data-creations-tab="works">作品</button>
            <button type="button" data-creations-tab="profile">创作者资料</button>
            <button type="button" data-creations-tab="installed">已安装</button>
          </div>
          <div class="cx-chip-row">${statuses.map(([id, label]) => `<button type="button" class="cx-chip ${creationsStatus === id ? "is-active" : ""}" data-creations-status="${id}">${label} ${id === "all" ? "" : `(${result.byStatus[id] || 0})`}</button>`).join("")}</div>
          <div class="cx-chip-row is-sub" style="margin-bottom:12px">
            <button type="button" class="cx-chip is-small ${creationsType === "" ? "is-active" : ""}" data-creations-type="">全部类型</button>
            ${Object.entries(TYPE_LABEL).map(([id, label]) => `<button type="button" class="cx-chip is-small ${creationsType === id ? "is-active" : ""}" data-creations-type="${id}">${label}</button>`).join("")}
          </div>
          ${
            result.items.length
              ? `<div class="cx-grid is-${layout}">${result.items
                  .map(
                    (post) => `<div class="cx-card-wrap">
                      ${postCard(post, { row: layout === "list", showStatus: true })}
                      <div class="cx-owner-actions" data-owner-post="${esc(post.id)}">
                        ${post.status === "draft" || post.status === "rejected" ? `<button class="cx-btn is-small is-primary" type="button" data-action="publish" data-id="${esc(post.id)}">提交审核</button>` : ""}
                        ${post.status === "draft" ? `<button class="cx-btn is-small" type="button" data-action="edit-post" data-id="${esc(post.id)}">编辑草稿</button>` : ""}
                        ${post.status === "published" || post.status === "pending_review" ? `<button class="cx-btn is-small" type="button" data-action="new-version" data-id="${esc(post.id)}">发布新版本</button>` : ""}
                        ${post.status === "published" ? `<button class="cx-btn is-small is-ghost" type="button" data-action="edit-meta" data-id="${esc(post.id)}">编辑信息</button>` : ""}
                        ${post.status === "published" || post.status === "pending_review" ? `<button class="cx-btn is-small is-ghost" type="button" data-action="withdraw" data-id="${esc(post.id)}">撤回</button>` : ""}
                        <button class="cx-btn is-small is-danger is-ghost" type="button" data-action="delete-post" data-id="${esc(post.id)}">删除</button>
                      </div>
                    </div>`,
                  )
                  .join("")}</div>`
              : emptyState("还没有作品", "发布一套主题、一个组件或一组壁纸，让社区看到你的设计。", "✎")
          }
        `);
      } else if (tab === "profile") {
        const profile = await api.getMyProfile();
        if (token !== loadToken) return;
        const limits = meta?.limits;
        setBody(`
          <section class="cx-page-head"><div><p class="cx-eyebrow">Creator Profile</p><h1>创作者资料</h1><p>公开资料与私人账号数据严格分离：这里的内容会展示在社区主页。</p></div></section>
          <div class="cx-tabs">
            <button type="button" data-creations-tab="works">作品</button>
            <button type="button" class="${tab === "profile" ? "is-active" : ""}" data-creations-tab="profile">创作者资料</button>
            <button type="button" data-creations-tab="installed">已安装</button>
          </div>
          <div class="cx-profile-edit">
            <div class="cx-profile-edit-head">
              ${avatarHtml(profile.profile, "xl")}
              <div><h2>${esc(profile.profile.displayName)}</h2><p>${ROLE_LABEL[profile.profile.role] || "成员"} · 加入于 ${fmtDate(profile.profile.createdAt)}</p></div>
              <button class="cx-btn" type="button" data-action="upload-avatar">更换头像</button>
            </div>
            <form class="cx-form" data-profile-form>
              <label>显示昵称<input class="cx-input" name="displayName" maxlength="40" value="${esc(profile.profile.displayName)}" required/></label>
              <label>创作者头衔<input class="cx-input" name="creatorTitle" maxlength="40" value="${esc(profile.profile.creatorTitle)}" placeholder="例如：界面设计师 / 大一学生"/></label>
              <label>个人简介<textarea class="cx-input" name="bio" rows="4" maxlength="600" placeholder="介绍你的创作方向、灵感来源…">${esc(profile.profile.bio)}</textarea></label>
              <label>主页封面
                <div class="cx-cover-upload">
                  <span>${profile.profile.coverUrl ? `<img src="${safeUrl(profile.profile.coverUrl)}" alt=""/>` : "还没有封面"}</span>
                  <button type="button" class="cx-btn is-small" data-action="upload-profile-cover">上传封面</button>
                </div>
              </label>
              <label>主页公开范围
                <select class="cx-input" name="visibility">
                  <option value="public" ${profile.profile.visibility === "public" ? "selected" : ""}>公开：出现在创作者目录</option>
                  <option value="private" ${profile.profile.visibility === "private" ? "selected" : ""}>私密：只有自己和审核员能打开</option>
                </select>
              </label>
              <button class="cx-btn is-primary" type="submit">保存资料</button>
            </form>
            <div class="cx-profile-stats-card">
              <h3>数据与用量</h3>
              <div class="cx-profile-stats"><span><b>${profile.stats.posts}</b>作品</span><span><b>${profile.stats.followers}</b>关注者</span><span><b>${profile.stats.likes}</b>获赞</span><span><b>${profile.stats.downloads}</b>安装</span></div>
              <p>社区存储 ${bytesText(profile.usage.totalBytes)} / ${bytesText(limits?.maxUserStorageBytes || 0)}</p>
              ${progressBar(profile.usage.totalBytes, limits?.maxUserStorageBytes || 0)}
              <p class="cx-hint">资源包 ${profile.usage.packageCount} 个，图片 ${profile.usage.assetCount} 张。R2 免费额度不是无限空间，请及时清理不再使用的资源。</p>
            </div>
          </div>
        `);
      } else {
        installedCache = installedRecords();
        const themes = allThemes();
        if (token !== loadToken) return;
        setBody(`
          <section class="cx-page-head"><div><p class="cx-eyebrow">Installed</p><h1>已安装</h1><p>社区资源安装后会进入原有主题中心、组件系统、工作空间与壁纸引擎。</p></div></section>
          <div class="cx-tabs">
            <button type="button" data-creations-tab="works">作品</button>
            <button type="button" data-creations-tab="profile">创作者资料</button>
            <button type="button" class="${tab === "installed" ? "is-active" : ""}" data-creations-tab="installed">已安装</button>
          </div>
          ${
            installedCache.length
              ? `<div class="cx-installed-list">${installedCache
                  .map(
                    (record) => `<article class="cx-installed" data-installed="${esc(record.postId)}">
                      <span class="cx-installed-ico">${TYPE_GLYPH[record.postType] || "◇"}</span>
                      <div class="cx-installed-main">
                        <b>${esc(record.title)}</b>
                        <span>${TYPE_LABEL[record.postType]} · 作者 ${esc(record.author)} · 当前 v${esc(record.version)} · 安装于 ${fmtDate(record.updatedAt)}</span>
                        <em>本地标识：${esc(record.localId)}${record.postType === "theme" && !themes.some((theme) => theme.id === record.localId) ? " · 主题已不存在" : ""}</em>
                      </div>
                      <div class="cx-installed-actions">
                        <button class="cx-btn is-small" type="button" data-action="check-update" data-id="${esc(record.postId)}">检查更新</button>
                        <button class="cx-btn is-small" type="button" data-action="update" data-id="${esc(record.postId)}">更新</button>
                        <button class="cx-btn is-small is-ghost" type="button" data-action="rollback" data-id="${esc(record.postId)}">版本 / 回退</button>
                        <button class="cx-btn is-small" type="button" data-action="reapply" data-id="${esc(record.postId)}">重新应用</button>
                        <button class="cx-btn is-small is-danger is-ghost" type="button" data-action="uninstall" data-id="${esc(record.postId)}">卸载</button>
                      </div>
                    </article>`,
                  )
                  .join("")}</div>`
              : emptyState("还没有安装社区资源", "在作品详情页安装主题、组件、工作空间或壁纸。", "⤓")
          }
        `);
      }
    } catch (error) {
      if (token === loadToken) showError(error);
    }
  };

  /* ============================================================
     作品详情
     ============================================================ */

  const loadDetail = async (id: string) => {
    view = { kind: "detail", id };
    const token = ++loadToken;
    setBody(skeleton("正在读取作品与内容包…"));
    try {
      await ensureMeta();
      const data = await api.getPost(id);
      let manifest: Manifest | null = null;
      if (data.post.type !== "tutorial" && data.package) {
        try {
          const verified = await api.fetchVerifiedPackage(id);
          manifest = verified.manifest as unknown as Manifest;
        } catch {
          manifest = null;
        }
      }
      const comments = await api.getComments(id, 1, 12);
      if (token !== loadToken) return;
      detailCache = { data, manifest, comments, commentsPage: 1 };

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
      paintDetail();
    } catch (error) {
      if (token === loadToken) showError(error);
    }
  };

  const paintDetail = () => {
    if (!detailCache) return;
    const { data, manifest, comments } = detailCache;
    const post = data.post;
    const install = getInstall(post.id);
    const compat = compatibilityCheck(manifest?.compatibility || post.compatibility);
    const isOwner = data.viewer.isOwner;
    const canModerate = data.viewer.canModerate;
    const isWallpaper = post.type === "wallpaper";

    setBody(`
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
      ${renderCommentComposer()}
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

  const renderCommentComposer = () => {
    if (!viewer()) {
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

  const licenseName = (id: string) => LICENSE_OPTIONS.find((license) => license.id === id)?.name || id;
  const licenseSummary = (id: string) => LICENSE_OPTIONS.find((license) => license.id === id)?.summary || "";

  const refreshComments = async (page = 1) => {
    if (!detailCache) return;
    const comments = await api.getComments(detailCache.data.post.id, page, 12);
    detailCache.comments = comments;
    detailCache.commentsPage = page;
    const panel = win.querySelector<HTMLElement>("[data-comments-panel]");
    if (panel) panel.innerHTML = renderComments(comments);
  };

  /* ============================================================
     发布 / 编辑 / 新版本
     ============================================================ */

  const newPublishState = (mode: PublishState["mode"], type: PostType = "theme"): PublishState => ({
    mode,
    type,
    manifest: null,
    manifestError: "",
    cover: null,
    previews: [],
    wallpapers: [],
    previewsChanged: false,
    wallpapersChanged: false,
    coverChanged: false,
  });

  const loadPublish = async (options: { editId?: string; versionOf?: string } = {}) => {
    if (needLogin()) return;
    setActiveNav("");
    const token = ++loadToken;
    setBody(skeleton("正在准备发布…"));
    try {
      await ensureMeta();
      if (options.versionOf) {
        const data = await api.getPost(options.versionOf);
        if (data.post.author.id !== meta?.viewer?.id) throw new Error("只能为自己的作品发布新版本");
        let manifest: Manifest | null = null;
        if (data.package) {
          const verified = await api.fetchVerifiedPackage(options.versionOf, undefined);
          manifest = verified.manifest as unknown as Manifest;
        }
        if (token !== loadToken) return;
        versionState = { post: data.post, manifest, baseVersion: data.post.version };
        publishState = newPublishState("version", data.post.type);
        publishState.manifest = manifest;
        view = { kind: "publish", versionOf: options.versionOf };
        paintVersionForm();
        return;
      }
      if (options.editId) {
        const data = await api.getPost(options.editId);
        if (!data.viewer.isOwner) throw new Error("只能编辑自己的作品");
        let manifest: Manifest | null = (data.post.draftManifest as unknown as Manifest) || null;
        if (!manifest && data.package) {
          try {
            const verified = await api.fetchVerifiedPackage(options.editId);
            manifest = verified.manifest as unknown as Manifest;
          } catch {
            manifest = null;
          }
        }
        if (token !== loadToken) return;
        publishState = {
          ...newPublishState("edit", data.post.type),
          postId: data.post.id,
          manifest,
        };
        view = { kind: "publish", editId: options.editId };
        paintPublishForm(data.post);
        return;
      }
      publishState = (window as unknown as { __CX_PUBLISH?: PublishState }).__CX_PUBLISH || newPublishState("create", "theme");
      view = { kind: "publish" };
      paintPublishForm(null);
    } catch (error) {
      if (token === loadToken) showError(error);
    }
  };

  const paintPublishForm = (editing: Post | null) => {
    if (!publishState) return;
    const state = publishState;
    const fixedType = state.type;
    setBody(`
      <button class="cx-back" type="button" data-action="back">← 返回</button>
      <section class="cx-page-head">
        <div><p class="cx-eyebrow">${editing ? "Edit Draft" : "Publish"}</p><h1>${editing ? "编辑草稿" : "发布作品"}</h1><p>作品会先经过结构、图片与兼容性校验；${meta?.requireReview ? "发布后进入人工审核。" : "管理员已关闭前置审核。"}</p></div>
        <span class="cx-publish-progress">内容包 ${state.manifest ? "✓" : "—"} · 封面 ${state.cover || editing?.coverUrl ? "✓" : "—"}</span>
      </section>
      <form class="cx-publish" data-publish-form>
        <section class="cx-publish-card">
          <h2>1 · 作品类型</h2>
          <div class="cx-type-picker">
            ${Object.entries(TYPE_LABEL).map(([id, label]) => `<button type="button" class="cx-type-choice ${fixedType === id ? "is-active" : ""}" data-publish-type="${id}" ${editing ? "disabled" : ""}><span>${TYPE_GLYPH[id]}</span><b>${label}</b></button>`).join("")}
          </div>
        </section>
        <section class="cx-publish-card">
          <h2>2 · 基本信息</h2>
          <div class="cx-form-grid">
            <label class="is-wide">作品名称<input class="cx-input" data-pf="title" maxlength="80" value="${esc(editing?.title || "")}" placeholder="例如：Ocean Depth 深海主题" required/></label>
            <label>分类<select class="cx-input" data-pf="category">${Object.entries(CATEGORY_LABEL[fixedType] || {}).map(([id, label]) => `<option value="${id}" ${editing?.category === id ? "selected" : ""}>${label}</option>`).join("")}</select></label>
            <label>可见性<select class="cx-input" data-pf="visibility"><option value="public" ${!editing || editing.visibility === "public" ? "selected" : ""}>公开</option><option value="unlisted" ${editing?.visibility === "unlisted" ? "selected" : ""}>不公开列出（有直链可访问）</option></select></label>
            <label class="is-wide">作品介绍<textarea class="cx-input" data-pf="description" rows="5" maxlength="8000" placeholder="说明设计灵感、使用方法与注意事项…">${esc(editing?.description || "")}</textarea></label>
            <label class="is-wide">标签（逗号分隔，最多 8 个）<input class="cx-input" data-pf="tags" value="${esc(editing?.tags.join(", ") || "")}" placeholder="深色, 海洋, 极简"/></label>
            <label>许可证<select class="cx-input" data-pf="license">${LICENSE_OPTIONS.map((license) => `<option value="${license.id}" ${editing?.license === license.id ? "selected" : ""}>${esc(license.name)}</option>`).join("")}</select></label>
            <label class="is-wide">自定义授权说明<input class="cx-input" data-pf="licenseNote" maxlength="600" value="${esc(editing?.licenseNote || "")}" placeholder="选择「自定义授权」时至少填写 10 个字符"/></label>
          </div>
        </section>
        <section class="cx-publish-card">
          <h2>3 · 封面与预览</h2>
          <div class="cx-upload-row">
            <div class="cx-upload-box" data-upload-box="cover">
              <span class="cx-upload-preview" data-cover-preview>${editing?.coverUrl ? `<img src="${safeUrl(editing.coverUrl)}" alt=""/>` : `<b>＋</b><em>上传封面</em>`}</span>
              <button type="button" class="cx-btn is-small" data-action="upload-cover">选择图片</button>
              <input type="file" accept="image/jpeg,image/png,image/webp" hidden data-file-cover/>
            </div>
            <div class="cx-upload-box is-wide">
              <div class="cx-upload-previews" data-preview-list>${editing ? dataUrlPlaceholder(editing) : `<em>还没有预览图</em>`}</div>
              <button type="button" class="cx-btn is-small" data-action="upload-previews">添加预览图（最多 6 张）</button>
              <input type="file" accept="image/jpeg,image/png,image/webp" multiple hidden data-file-previews/>
            </div>
          </div>
          ${fixedType === "wallpaper" ? `<div class="cx-upload-box is-wide"><div class="cx-upload-previews" data-wall-list>${editing ? "<em>已上传的壁纸</em>" : "<em>还没有壁纸</em>"}</div><button type="button" class="cx-btn is-small" data-action="upload-wallpapers">添加壁纸图片（最多 8 张）</button><input type="file" accept="image/jpeg,image/png,image/webp" multiple hidden data-file-wallpapers/></div>` : ""}
          <p class="cx-hint">图片会在浏览器内压缩并生成缩略图；服务端会按文件头验证真实格式，SVG / HTML 不能上传。</p>
        </section>
        <section class="cx-publish-card">
          <h2>4 · 内容包</h2>
          ${publishPackageFields(fixedType)}
          <div class="cx-manifest-bar">
            <button type="button" class="cx-btn" data-action="generate-manifest">从当前桌面生成配置</button>
            <button type="button" class="cx-btn is-ghost" data-action="import-manifest">导入 JSON 内容包</button>
            <input type="file" accept="application/json,.json" hidden data-file-manifest/>
          </div>
          <div class="cx-manifest-box" data-manifest-box>${manifestSummary(state.manifest, state.manifestError)}</div>
        </section>
        <section class="cx-publish-card">
          <h2>5 · 兼容性与授权</h2>
          <div class="cx-form-grid">
            <label>最低系统版本<select class="cx-input" data-pf="compat-min"><option value="1.3.0" ${editing?.compatibility.minimum === "1.3.0" ? "selected" : ""}>1.3.0</option><option value="1.4.0" ${editing?.compatibility.minimum === "1.4.0" ? "selected" : ""}>1.4.0</option><option value="1.5.0" ${editing?.compatibility.minimum === "1.5.0" ? "selected" : ""}>1.5.0</option><option value="1.6.0" ${!editing || editing.compatibility.minimum === "1.6.0" ? "selected" : ""}>1.6.0</option></select></label>
            <label>最高系统版本（可选）<input class="cx-input" data-pf="compat-max" value="${esc(editing?.compatibility.maximum || "")}" placeholder="留空表示不限制"/></label>
            ${fixedType === "wallpaper" ? `<label>图片比例<select class="cx-input" data-pf="ratio"><option>16:9</option><option>16:10</option><option>21:9</option><option>4:3</option><option>3:2</option><option>9:16</option><option>1:1</option></select></label>` : ""}
            ${fixedType === "widget" ? widgetFields(editing) : ""}
            ${fixedType === "workspace" ? `<input type="hidden" data-pf="workspace-name" value="${esc(editing?.title || "")}"/>` : ""}
            ${fixedType === "tutorial" ? `<label class="is-wide">教程正文（Markdown）<textarea class="cx-input" data-pf="tutorial" rows="12" maxlength="20000" placeholder="## 如何布置一个专注桌面…">${esc((editing?.draftManifest?.configuration as Record<string, unknown> | undefined)?.content as string || "")}</textarea></label>` : ""}
          </div>
          <label class="cx-rights"><input type="checkbox" data-pf="rights" ${editing?.rightsConfirmed ? "checked" : ""}/> 我确认拥有该作品的发布与分享权利，并已选择许可证；不包含未经授权的商业壁纸、音乐或其他资源。</label>
          <div class="cx-publish-actions">
            <button type="button" class="cx-btn" data-action="save-draft">保存草稿</button>
            <button type="submit" class="cx-btn is-primary" data-action="submit-publish">${meta?.requireReview ? "提交审核" : "发布作品"}</button>
          </div>
          <p class="cx-hint" data-publish-msg></p>
        </section>
      </form>
    `);
    if (state.manifest) {
      const box = win.querySelector<HTMLElement>("[data-manifest-box]");
      if (box) box.innerHTML = manifestSummary(state.manifest, state.manifestError);
    }
    paintPublishAssets();
  };

  const dataUrlPlaceholder = (post: Post) => `<em>保留现有预览图；重新上传会替换。</em>`;

  const widgetFields = (editing: Post | null) => {
    const config = (editing?.draftManifest?.configuration || {}) as WidgetConfig;
    const props = (config.props || {}) as Record<string, string | number | boolean>;
    return `
      <label>组件类型<select class="cx-input" data-pf="w-type">${WIDGET_TYPES.map((type) => `<option value="${type}" ${config.widgetType === type ? "selected" : ""}>${WIDGET_TYPE_LABEL[type]}</option>`).join("")}</select></label>
      <label>主色<input class="cx-input" type="color" data-pf="w-accent" value="${esc(String(props.accent || "#6f8cff"))}"/></label>
      <label>标签<input class="cx-input" data-pf="w-label" maxlength="24" value="${esc(String(props.label || ""))}" placeholder="组件上显示的文字"/></label>
      <label>语录正文<input class="cx-input" data-pf="w-text" maxlength="120" value="${esc(String(props.text || ""))}" placeholder="仅语录类型使用"/></label>
      <label>语录作者<input class="cx-input" data-pf="w-author" maxlength="32" value="${esc(String(props.author || ""))}"/></label>
      <label>天气城市<input class="cx-input" data-pf="w-city" maxlength="24" value="${esc(String(props.city || "大连"))}"/></label>
      <label>专注分钟<input class="cx-input" type="number" data-pf="w-minutes" min="5" max="120" value="${esc(String(props.minutes || 25))}"/></label>
      <label>时钟样式<select class="cx-input" data-pf="w-style"><option value="digital" ${props.style !== "analog" ? "selected" : ""}>数字</option><option value="analog" ${props.style === "analog" ? "selected" : ""}>指针</option></select></label>
    `;
  };

  const publishPackageFields = (type: PostType) => {
    if (type === "wallpaper") return `<p class="cx-hint">壁纸作品会自动根据上传图片生成内容包，无需单独上传 JSON。</p>`;
    if (type === "tutorial") return `<p class="cx-hint">教程正文会作为内容包保存，渲染时先整体转义再支持安全 Markdown。</p>`;
    return `<p class="cx-hint">支持导入符合社区 Manifest 规范的 JSON；也可以点下方按钮从当前桌面生成。</p>`;
  };

  const manifestSummary = (manifest: Manifest | null, error: string) => {
    if (error) return `<div class="cx-manifest-error">✕ ${esc(error)}</div>`;
    if (!manifest) return `<div class="cx-manifest-empty">还没有内容包。导入 JSON，或从当前桌面生成。</div>`;
    const check = validateManifestClient(manifest);
    const compat = compatibilityCheck(manifest.compatibility);
    return `<div class="cx-manifest-ok">
      <div><b>${esc(manifest.name)}</b><span>${TYPE_LABEL[manifest.type] || manifest.type} · v${esc(manifest.version)} · ${esc(manifest.packageId)}</span></div>
      <div class="cx-manifest-tags"><span>${compat.ok ? "✓ 兼容" : "✕ 不兼容"}</span><span>${esc(licenseName(manifest.license))}</span><span>${check.ok ? "结构校验通过" : check.errors[0]}</span></div>
    </div>`;
  };

  const paintPublishAssets = () => {
    if (!publishState) return;
    const state = publishState;
    const coverBox = win.querySelector<HTMLElement>("[data-cover-preview]");
    if (coverBox) {
      coverBox.innerHTML = state.cover
        ? `<img src="${safeUrl(`/api/community/media/${state.cover.id}`)}" alt=""/>`
        : coverBox.querySelector("img")?.outerHTML || `<b>＋</b><em>上传封面</em>`;
    }
    const previews = win.querySelector<HTMLElement>("[data-preview-list]");
    if (previews) {
      previews.innerHTML = state.previews.length
        ? state.previews.map((asset, index) => `<span class="cx-upload-thumb"><img src="${safeUrl(`/api/community/media/${asset.thumbId || asset.id}`)}" alt=""/><button type="button" data-remove-asset="${index}" data-asset-kind="preview">×</button></span>`).join("")
        : `<em>还没有预览图</em>`;
    }
    const walls = win.querySelector<HTMLElement>("[data-wall-list]");
    if (walls) {
      walls.innerHTML = state.wallpapers.length
        ? state.wallpapers.map((asset, index) => `<span class="cx-upload-thumb"><img src="${safeUrl(`/api/community/media/${asset.thumbId || asset.id}`)}" alt=""/><button type="button" data-remove-asset="${index}" data-asset-kind="wallpaper">×</button></span>`).join("")
        : `<em>还没有壁纸</em>`;
    }
  };

  const readFormValue = (key: string) =>
    win.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(`[data-pf="${key}"]`)?.value ?? "";

  const readChecked = (key: string) =>
    win.querySelector<HTMLInputElement>(`[data-pf="${key}"]`)?.checked ?? false;

  const buildManifest = (type: PostType): Manifest | null => {
    if (!publishState) return null;
    const title = clampText(readFormValue("title") || versionState?.post.title || "", 80);
    if (!title) {
      publishState.manifestError = "请先填写作品名称";
      return null;
    }
    const version = publishState.manifest?.version || versionState?.post.version || "1.0.0";
    const packageId = publishState.manifest?.packageId || `${slugify(title)}-${Date.now().toString(36).slice(-4)}`;
    const license = readFormValue("license") || versionState?.post.license || "CC-BY-4.0";
    const compatibility = {
      minimum: readFormValue("compat-min") || versionState?.post.compatibility.minimum || "1.3.0",
      ...(readFormValue("compat-max") || versionState?.post.compatibility.maximum
        ? { maximum: readFormValue("compat-max") || versionState?.post.compatibility.maximum }
        : {}),
    };
    const author = meta?.viewer?.displayName || "创作者";
    const base = {
      schemaVersion: 1 as const,
      packageId,
      type,
      name: title,
      version,
      author,
      description: clampText(readFormValue("description") || versionState?.post.description || "", 600),
      compatibility,
      license,
      ...(license === "CUSTOM" ? { licenseNote: clampText(readFormValue("licenseNote"), 600) } : {}),
      assets: [] as Array<{ kind: string; ref: string }>,
    };
    let configuration: Record<string, unknown>;
    if (type === "theme") {
      const theme = findTheme(readThemeState().current) || allThemes()[0];
      if (!theme) {
        publishState.manifestError = "没有可用的当前主题";
        return null;
      }
      configuration = {
        name: theme.name,
        en: theme.en,
        style: theme.style,
        desc: theme.desc,
        wall: theme.wall,
        mode: theme.mode,
        accent: theme.accent,
        accent2: theme.accent2,
        material: theme.material,
        radius: theme.radius,
        darken: theme.darken,
        dock: theme.dock,
        font: theme.font,
        grain: theme.grain,
        tags: theme.tags,
      };
    } else if (type === "widget") {
      const widgetType = readFormValue("w-type") || "clock";
      const props: Record<string, string | number | boolean> = {
        accent: readFormValue("w-accent") || "#6f8cff",
        label: clampText(readFormValue("w-label"), 24),
      };
      if (widgetType === "quote") {
        props.text = clampText(readFormValue("w-text"), 120);
        props.author = clampText(readFormValue("w-author"), 32);
      }
      if (widgetType === "weather") props.city = clampText(readFormValue("w-city"), 24);
      if (widgetType === "focus") props.minutes = Math.max(5, Math.min(120, Number(readFormValue("w-minutes")) || 25));
      if (widgetType === "clock") props.style = readFormValue("w-style") || "digital";
      const permissionMap: Record<string, string[]> = {
        clock: ["time", "date"], calendar: ["date"], weather: ["weather"], focus: ["time"],
        quote: ["none"], photo: ["none"], music: ["music"], system: ["system"],
        productivity: ["none"], decorative: ["none"],
      };
      configuration = { widgetType, props, permissions: permissionMap[widgetType] || ["none"], dependencies: [] };
    } else if (type === "workspace") {
      const snapshot = captureCurrentWorkspace(ctx);
      configuration = {
        name: clampText(snapshot.name.replace(/\s*(副本|·.*)$/, ""), 24) || "社区工作空间",
        description: clampText(readFormValue("description"), 200),
        themeId: snapshot.theme,
        wallId: snapshot.wall,
        dock: snapshot.dock,
        shortcuts: snapshot.shortcuts,
        openApps: snapshot.openApps,
        widgets: snapshot.widgets,
        dnd: snapshot.dnd,
      };
    } else if (type === "wallpaper") {
      configuration = {
        collectionName: clampText(title, 40),
        ratio: readFormValue("ratio") || "16:9",
        items: publishState.wallpapers.map(() => ({ caption: "" })),
      };
    } else {
      configuration = { content: clampText(readFormValue("tutorial"), 20000) };
    }
    const manifest = { ...base, configuration } as unknown as Manifest;
    const check = validateManifestClient(manifest, type);
    if (!check.ok) {
      publishState.manifestError = check.errors.join("；");
      return null;
    }
    publishState.manifestError = "";
    return manifest;
  };

  const paintVersionForm = () => {
    if (!versionState) return;
    const { post, manifest, baseVersion } = versionState;
    setBody(`
      <button class="cx-back" type="button" data-action="back">← 返回</button>
      <section class="cx-page-head"><div><p class="cx-eyebrow">New Version</p><h1>发布新版本</h1><p>${esc(post.title)} · 当前 v${esc(baseVersion)}。历史版本会保留，可随时回退。</p></div></section>
      <form class="cx-publish" data-version-form>
        <section class="cx-publish-card">
          <h2>版本信息</h2>
          <div class="cx-form-grid">
            <label>新版本号<input class="cx-input" data-vf="version" value="${esc(nextVersion(baseVersion))}" required/></label>
            <label class="is-wide">更新说明<textarea class="cx-input" data-vf="changelog" rows="4" maxlength="2000" placeholder="这个版本改了什么？">${""}</textarea></label>
          </div>
          <div class="cx-manifest-bar">
            <button type="button" class="cx-btn" data-action="version-generate">从当前桌面生成新配置</button>
            <button type="button" class="cx-btn is-ghost" data-action="version-import">导入 JSON 内容包</button>
            <input type="file" accept="application/json,.json" hidden data-file-version/>
          </div>
          <div class="cx-manifest-box" data-version-manifest>${manifestSummary(manifest, "")}</div>
          <div class="cx-publish-actions">
            <button type="submit" class="cx-btn is-primary">${meta?.requireReview ? "提交新版本审核" : "发布新版本"}</button>
          </div>
          <p class="cx-hint" data-version-msg></p>
        </section>
      </form>
    `);
  };

  /* ============================================================
     审核中心
     ============================================================ */

  const loadModeration = async () => {
    setActiveNav("moderation");
    if (!isStaff()) {
      setBody(emptyState("需要审核权限", "这个入口只对社区审核员与管理员开放。", "⚑"));
      return;
    }
    const token = ++loadToken;
    setBody(skeleton("正在读取审核数据…"));
    try {
      await ensureMeta();
      const tabs = `<div class="cx-tabs">
        ${([["queue", "作品审核"], ["reports", "举报处理"], ["users", "用户管理"], ["settings", "社区设置"], ["invites", "邀请注册"], ["audit", "审计日志"]] as const)
          .map(([id, label]) => `<button type="button" class="${moderationTab === id ? "is-active" : ""}" data-mod-tab="${id}">${label}</button>`)
          .join("")}
      </div>`;
      if (moderationTab === "queue") {
        const result = await api.adminGetQueue(moderationQueueStatus);
        if (token !== loadToken) return;
        setBody(`
          <section class="cx-page-head"><div><p class="cx-eyebrow">Moderation</p><h1>审核中心</h1><p>第一版采用人工审核：通过、拒绝、隐藏与删除都会真实执行并写入审计日志。</p></div></section>
          ${tabs}
          <div class="cx-chip-row">
            ${([["pending_review", "待审核"], ["hidden", "已隐藏"], ["rejected", "未通过"], ["draft", "草稿"]] as const).map(([id, label]) => `<button type="button" class="cx-chip ${moderationQueueStatus === id ? "is-active" : ""}" data-queue-status="${id}">${label} ${result.byStatus[id] || 0}</button>`).join("")}
          </div>
          <div class="cx-mod-list">
            ${
              result.items.length
                ? result.items
                    .map(
                      (post) => `<article class="cx-mod-card" data-post="${esc(post.id)}">
                        ${coverHtml(post, "cx-mod-cover")}
                        <div class="cx-mod-main">
                          <div class="cx-mod-head"><h3>${esc(post.title)}</h3><span class="cx-status-chip is-${esc(post.status)}">${STATUS_LABEL[post.status]}</span></div>
                          <p>${esc(post.description || "没有简介")}</p>
                          <div class="cx-mod-meta"><span>作者 ${esc(post.author.displayName)}</span><span>v${esc(post.version)}</span><span>举报 ${post.reportCount}</span><span>${timeAgo(post.createdAt)}</span></div>
                          ${post.moderationNote ? `<p class="cx-modnote">备注：${esc(post.moderationNote)}</p>` : ""}
                          <div class="cx-mod-actions">
                            ${post.status !== "published" ? `<button class="cx-btn is-small is-primary" type="button" data-action="review-approve" data-id="${esc(post.id)}">通过</button>` : ""}
                            ${post.status === "pending_review" ? `<button class="cx-btn is-small" type="button" data-action="review-reject" data-id="${esc(post.id)}">拒绝</button>` : ""}
                            ${post.status === "published" ? `<button class="cx-btn is-small" type="button" data-action="review-hide" data-id="${esc(post.id)}">隐藏</button>` : ""}
                            ${post.status === "published" ? `<button class="cx-btn is-small is-ghost" type="button" data-action="feature" data-id="${esc(post.id)}" data-featured="${post.featured ? "1" : "0"}">${post.featured ? "取消精选" : "设为精选"}</button>` : ""}
                            ${isAdmin() ? `<button class="cx-btn is-small is-danger is-ghost" type="button" data-action="review-delete" data-id="${esc(post.id)}">删除</button>` : ""}
                            <button class="cx-btn is-small is-ghost" type="button" data-post="${esc(post.id)}" data-action="preview-post">查看</button>
                          </div>
                        </div>
                      </article>`,
                    )
                    .join("")
                : emptyState("队列是空的", "没有待处理的审核对象。", "⚑")
            }
          </div>
        `);
      } else if (moderationTab === "reports") {
        const result = await api.adminGetReports(moderationReportStatus);
        if (token !== loadToken) return;
        setBody(`
          <section class="cx-page-head"><div><p class="cx-eyebrow">Reports</p><h1>审核中心</h1><p>举报不会自动隐藏内容，必须由审核员确认后执行。</p></div></section>
          ${tabs}
          <div class="cx-chip-row">${([["open", "待处理"], ["resolved", "已处理"], ["dismissed", "已驳回"], ["all", "全部"]] as const).map(([id, label]) => `<button type="button" class="cx-chip ${moderationReportStatus === id ? "is-active" : ""}" data-report-status="${id}">${label} ${result.byStatus[id] || 0}</button>`).join("")}</div>
          <div class="cx-report-list">
            ${
              result.items.length
                ? result.items
                    .map(
                      (report) => `<article class="cx-report" data-report="${esc(report.id)}">
                        <div class="cx-report-head"><b>${esc(REASON_LABEL[report.reason] || report.reason)}</b><span class="cx-status-chip is-${esc(report.status)}">${report.status}</span></div>
                        <p>${esc(report.description || "举报人没有补充说明。")}</p>
                        <div class="cx-report-target">${
                          report.targetType === "post"
                            ? `作品：${esc(String(report.target.title || ""))}`
                            : report.targetType === "comment"
                              ? `评论：${esc(String(report.target.content || ""))}`
                              : `用户：${esc(String(report.target.displayName || ""))}`
                        }</div>
                        <div class="cx-report-meta"><span>举报人 ${esc(report.reporterName)}</span><span>${timeAgo(report.createdAt)}</span><span>目标 ${report.targetType}</span></div>
                        ${
                          report.status === "open" || report.status === "reviewing"
                            ? `<div class="cx-mod-actions">
                                <button class="cx-btn is-small" type="button" data-action="report-dismiss" data-id="${esc(report.id)}">驳回</button>
                                ${report.targetType === "post" ? `<button class="cx-btn is-small" type="button" data-action="report-hide-post" data-id="${esc(report.id)}">隐藏作品</button>` : ""}
                                ${report.targetType === "post" && isAdmin() ? `<button class="cx-btn is-small is-danger is-ghost" type="button" data-action="report-delete-post" data-id="${esc(report.id)}">删除作品</button>` : ""}
                                ${report.targetType === "comment" ? `<button class="cx-btn is-small" type="button" data-action="report-hide-comment" data-id="${esc(report.id)}">隐藏评论</button>` : ""}
                                ${isAdmin() ? `<button class="cx-btn is-small is-danger is-ghost" type="button" data-action="report-restrict" data-id="${esc(report.id)}">限制用户</button>` : ""}
                              </div>`
                            : `<p class="cx-hint">处理结果：${esc(report.resolution || "—")}</p>`
                        }
                      </article>`,
                    )
                    .join("")
                : emptyState("没有举报", "当前筛选下没有待处理举报。", "⚑")
            }
          </div>
        `);
      } else if (moderationTab === "users") {
        const result = await api.adminGetUsers();
        if (token !== loadToken) return;
        setBody(`
          <section class="cx-page-head"><div><p class="cx-eyebrow">Users</p><h1>审核中心</h1><p>角色与账号状态只能由管理员修改，审核员可以限制发布权限。</p></div></section>
          ${tabs}
          <div class="cx-user-list">
            ${(result.items as Array<Record<string, unknown>>)
              .map(
                (user) => `<article class="cx-user-row">
                  <span class="cx-avatar is-s"><i>${esc(String(user.displayName || "?").slice(0, 1))}</i></span>
                  <div><b>${esc(String(user.displayName || ""))} ${roleBadge(String(user.role))}</b><span>@${esc(String(user.username || ""))} · ${Number(user.postCount || 0)} 个作品 · ${user.status === "active" ? "正常" : "已停用"} · 限制：${esc(String(user.restriction || "none"))}</span></div>
                  <div class="cx-user-actions">
                    ${isAdmin() && user.role !== "admin" ? `<button class="cx-btn is-small" type="button" data-action="user-role" data-id="${esc(String(user.id))}" data-role="${user.role === "moderator" ? "member" : "moderator"}">${user.role === "moderator" ? "撤销审核员" : "设为审核员"}</button>` : ""}
                    ${isAdmin() && user.role !== "admin" ? `<button class="cx-btn is-small is-ghost" type="button" data-action="user-status" data-id="${esc(String(user.id))}" data-status="${user.status === "active" ? "disabled" : "active"}">${user.status === "active" ? "停用账号" : "恢复账号"}</button>` : ""}
                    ${user.role !== "admin" ? `<button class="cx-btn is-small is-ghost" type="button" data-action="user-restrict" data-id="${esc(String(user.id))}" data-restriction="${user.restriction === "none" ? "limited" : "none"}">${user.restriction === "none" ? "限制发布" : "解除限制"}</button>` : ""}
                  </div>
                </article>`,
              )
              .join("")}
          </div>
        `);
      } else if (moderationTab === "settings") {
        const settings = await api.adminGetSettings();
        if (token !== loadToken) return;
        const raw = settings.raw as Record<string, unknown>;
        setBody(`
          <section class="cx-page-head"><div><p class="cx-eyebrow">Settings</p><h1>审核中心</h1><p>注册模式、审核策略、配额与社区公告。设置会立即在服务端生效。</p></div></section>
          ${tabs}
          <form class="cx-settings-form" data-admin-settings>
            <section class="cx-publish-card">
              <h2>社区与注册</h2>
              <div class="cx-form-grid">
                <label>社区名称<input class="cx-input" name="communityName" maxlength="60" value="${esc(String(raw.communityName || ""))}" ${isAdmin() ? "" : "disabled"}/></label>
                <label>注册模式<select class="cx-input" name="registrationMode" ${isAdmin() ? "" : "disabled"}>
                  <option value="closed" ${raw.registrationMode === "closed" ? "selected" : ""}>关闭注册</option>
                  <option value="invite" ${raw.registrationMode === "invite" ? "selected" : ""}>邀请制</option>
                  <option value="open" ${raw.registrationMode === "open" ? "selected" : ""}>开放注册</option>
                </select></label>
                <label class="is-wide">社区公告<textarea class="cx-input" name="announcement" rows="3" maxlength="600" ${isAdmin() ? "" : "disabled"}>${esc(String(raw.announcement || ""))}</textarea></label>
                <label class="cx-check"><input type="checkbox" name="requireReview" ${raw.requireReview ? "checked" : ""} ${isAdmin() ? "" : "disabled"}/> 发布需要人工审核</label>
                <label class="cx-check"><input type="checkbox" name="memberLogin" ${raw.memberLogin ? "checked" : ""} ${isAdmin() ? "" : "disabled"}/> 允许社区成员登录</label>
                <label class="cx-check"><input type="checkbox" name="allowPublishing" ${raw.allowPublishing ? "checked" : ""} ${isAdmin() ? "" : "disabled"}/> 允许发布新内容</label>
              </div>
            </section>
            <section class="cx-publish-card">
              <h2>配额与存储</h2>
              <div class="cx-form-grid">
                <label>每日作品数<input class="cx-input" type="number" name="maxPostsPerDay" min="1" max="100" value="${Number(settings.settings.maxPostsPerDay || 5)}" ${isAdmin() ? "" : "disabled"}/></label>
                <label>每日评论数<input class="cx-input" type="number" name="maxCommentsPerDay" min="1" max="500" value="${Number(settings.settings.maxCommentsPerDay || 60)}" ${isAdmin() ? "" : "disabled"}/></label>
                <label>每用户内容包上限<input class="cx-input" type="number" name="maxPackagesPerUser" min="1" max="500" value="${Number(settings.settings.maxPackagesPerUser || 40)}" ${isAdmin() ? "" : "disabled"}/></label>
                <label>单文件上传上限（MB）<input class="cx-input" type="number" name="maxUploadMB" min="1" max="32" value="${Math.round(Number(settings.settings.maxUploadBytes || 0) / 1024 / 1024)}" ${isAdmin() ? "" : "disabled"}/></label>
                <label>每用户存储上限（MB）<input class="cx-input" type="number" name="maxStorageMB" min="1" max="1024" value="${Math.round(Number(settings.settings.maxUserStorageBytes || 0) / 1024 / 1024)}" ${isAdmin() ? "" : "disabled"}/></label>
              </div>
              <p class="cx-hint">R2 免费额度有限，请按实际需要设置配额；社区总存储可在审计页查看。</p>
              ${isAdmin() ? `<button class="cx-btn is-primary" type="submit">保存设置</button>` : `<p class="cx-hint">只有管理员可以修改社区设置。</p>`}
              <p class="cx-hint" data-admin-msg></p>
            </section>
          </form>
        `);
      } else if (moderationTab === "invites") {
        const result = await api.adminGetInvites();
        if (token !== loadToken) return;
        setBody(`
          <section class="cx-page-head"><div><p class="cx-eyebrow">Invites</p><h1>审核中心</h1><p>邀请码只保存哈希，明文只在创建时显示一次。注册时服务端会再次校验名额与有效期。</p></div></section>
          ${tabs}
          ${isAdmin() ? `<form class="cx-invite-form" data-invite-form>
            <label>用途备注<input class="cx-input" name="label" maxlength="60" placeholder="例如：给设计群的朋友"/></label>
            <label>可用次数<input class="cx-input" type="number" name="maxUses" min="1" max="500" value="1"/></label>
            <label>有效天数（0 为永久）<input class="cx-input" type="number" name="expiresInDays" min="0" max="365" value="7"/></label>
            <button class="cx-btn is-primary" type="submit">生成邀请码</button>
          </form>` : `<p class="cx-hint">只有管理员可以创建邀请码。</p>`}
          <div class="cx-invite-list">
            ${(result.items as Array<Record<string, unknown>>).length
              ? (result.items as Array<Record<string, unknown>>).map(
                  (invite) => `<article class="cx-invite-row">
                    <code>${esc(String(invite.prefix || ""))}••••</code>
                    <div><b>${esc(String(invite.label || "未命名邀请"))}</b><span>已用 ${Number(invite.usedCount || 0)} / ${Number(invite.maxUses || 0)} · ${invite.expiresAt ? `到期 ${fmtDate(Number(invite.expiresAt))}` : "永久有效"} · ${invite.revokedAt ? "已作废" : "有效"}</span></div>
                    ${!invite.revokedAt && isAdmin() ? `<button class="cx-btn is-small is-danger is-ghost" type="button" data-action="revoke-invite" data-id="${esc(String(invite.id))}">作废</button>` : ""}
                  </article>`,
                ).join("")
              : emptyState("还没有邀请码", "生成第一个邀请码，发给想加入社区的朋友。", "✉")
            }
          </div>
        `);
      } else {
        const [result, statsResult] = await Promise.all([api.adminGetAudit(1), api.adminGetStats()]);
        if (token !== loadToken) return;
        const stats = statsResult.stats;
        setBody(`
          <section class="cx-page-head"><div><p class="cx-eyebrow">Audit</p><h1>审核中心</h1><p>所有重要操作都会写入审计日志：审核、举报处理、角色、设置、邀请。</p></div></section>
          ${tabs}
          <section class="cx-panel">
            <div class="cx-section-head"><div><p class="cx-eyebrow">Overview</p><h2>社区概览</h2></div></div>
            <div class="cx-admin-stats">
              <div><b>${Number(stats.accounts || 0)}</b><span>活跃账号</span></div>
              <div><b>${Number(stats.creators || 0)}</b><span>创作者资料</span></div>
              <div><b>${Number(stats.publishedPosts || 0)}</b><span>已发布作品</span></div>
              <div><b>${Number(stats.pendingReview || 0)}</b><span>待审核</span></div>
              <div><b>${Number(stats.openReports || 0)}</b><span>待处理举报</span></div>
              <div><b>${Number(stats.assetFiles || 0)}</b><span>社区图片</span></div>
              <div><b>${Number(stats.packages || 0)}</b><span>内容包</span></div>
              <div><b>${bytesText(Number(stats.storageBytes || 0))}</b><span>R2 已用存储</span></div>
            </div>
            <p class="cx-hint">R2 免费额度不是无限空间。社区总存储包含图片与内容包；单个用户用量可在用户资料中查看。</p>
          </section>
          <div class="cx-audit-list">
            ${(result.items as Array<Record<string, unknown>>).map(
              (log) => `<article class="cx-audit-row">
                <span>${esc(String(log.action || ""))}</span>
                <div><b>${esc(String(log.actorName || "系统"))}</b><em>${esc(String(log.targetType || ""))} ${esc(String(log.targetId || ""))}</em></div>
                <time>${timeAgo(Number(log.createdAt || 0))}</time>
              </article>`,
            ).join("") || emptyState("还没有审计记录", "管理操作会出现在这里。", "▤")}
          </div>
        `);
      }
    } catch (error) {
      if (token === loadToken) showError(error);
    }
  };

  /* ============================================================
     事件
     ============================================================ */

  const backToList = () => {
    const tab = view.kind === "detail" ? lastTab : view.kind === "creator" ? "creators" : "home";
    setActiveNav(tab);
    view = { kind: "tab", tab };
    if (tab === "creators") void loadCreators();
    else if (tab === "creations") void loadCreations();
    else void loadHome();
  };

  let lastTab = "home";

  const refreshPostButtons = (id: string, liked: boolean, likeCount: number, favorited: boolean, favoriteCount: number) => {
    win.querySelectorAll<HTMLElement>(`[data-like="${id}"]`).forEach((node) => {
      node.classList.toggle("is-on", liked);
      const count = node.querySelector<HTMLElement>(`[data-like-count="${id}"]`);
      if (count) count.textContent = String(likeCount);
    });
    win.querySelectorAll<HTMLElement>(`[data-fav="${id}"]`).forEach((node) => {
      node.classList.toggle("is-on", favorited);
      const count = node.querySelector<HTMLElement>(`[data-fav-count="${id}"]`);
      if (count) count.textContent = String(favoriteCount);
    });
  };

  const toggleLike = async (postId: string) => {
    if (!viewer()) {
      toast("请先登录再点赞");
      return;
    }
    try {
      const post = detailCache?.data.post.id === postId ? detailCache.data.post : null;
      if (post?.viewer.liked) {
        const result = await api.unlikePost(postId);
        post.viewer.liked = false;
        post.likeCount = result.likeCount;
        refreshPostButtons(postId, false, result.likeCount, post.viewer.favorited, post.favoriteCount);
      } else {
        const result = await api.likePost(postId);
        if (post) {
          post.viewer.liked = true;
          post.likeCount = result.likeCount;
          refreshPostButtons(postId, true, result.likeCount, post.viewer.favorited, post.favoriteCount);
        } else {
          win.querySelectorAll<HTMLElement>(`[data-like="${postId}"]`).forEach((node) => {
            node.classList.add("is-on");
            const count = node.querySelector<HTMLElement>(`[data-like-count="${postId}"]`);
            if (count) count.textContent = String(result.likeCount);
          });
        }
      }
    } catch (error) {
      toast(error instanceof Error ? error.message : "操作失败");
    }
  };

  const toggleFavorite = async (postId: string) => {
    if (!viewer()) {
      toast("请先登录再收藏");
      return;
    }
    try {
      const post = detailCache?.data.post.id === postId ? detailCache.data.post : null;
      if (post?.viewer.favorited) {
        const result = await api.unfavoritePost(postId);
        post.viewer.favorited = false;
        post.favoriteCount = result.favoriteCount;
        refreshPostButtons(postId, post.viewer.liked, post.likeCount, false, result.favoriteCount);
        if (view.kind === "tab" && view.tab === "favorites") void loadFavorites();
        return;
      }

      const choice = await modal(win, {
        title: "收藏到收藏夹",
        body: `<div class="cx-form">
          <label>收藏夹名称（可新建）<input class="cx-input" data-fav-collection-input maxlength="32" value="default" placeholder="例如：灵感 / 学习 / 深色主题"/></label>
          <p class="cx-hint">收藏是私人数据，默认不公开。你可以用收藏夹给作品分类。</p>
        </div>`,
        actions: [{ label: "取消", value: "" }, { label: "收藏", value: "fav", primary: true }],
      });
      if (choice !== "fav") return;
      const collection =
        (win.querySelector<HTMLInputElement>("[data-fav-collection-input]")?.value || "default").trim().slice(0, 32) ||
        "default";
      const result = await api.favoritePost(postId, collection);
      if (post) {
        post.viewer.favorited = true;
        post.favoriteCount = result.favoriteCount;
        refreshPostButtons(postId, post.viewer.liked, post.likeCount, true, result.favoriteCount);
      } else {
        win.querySelectorAll<HTMLElement>(`[data-fav="${postId}"]`).forEach((node) => {
          node.classList.add("is-on");
          const count = node.querySelector<HTMLElement>(`[data-fav-count="${postId}"]`);
          if (count) count.textContent = String(result.favoriteCount);
        });
      }
      toast(`已收藏到「${collection}」`);
      if (view.kind === "tab" && view.tab === "favorites") void loadFavorites();
    } catch (error) {
      toast(error instanceof Error ? error.message : "操作失败");
    }
  };

  const installFlow = async () => {
    if (!detailCache) return;
    const { data, manifest } = detailCache;
    const post = data.post;
    if (!manifest) {
      toast("这个作品还没有可安装的内容包");
      return;
    }
    const compat = compatibilityCheck(manifest.compatibility);
    if (!compat.ok) {
      toast(compat.reason);
      return;
    }
    const details: string[] = [];
    if (post.type === "theme") {
      const config = manifest.configuration as ThemeConfig;
      details.push(`壁纸：${safeWallId(config.wall)}`, `强调色：${safeHex(config.accent)} / ${safeHex(config.accent2)}`, `材质：${config.material}`, `圆角：${config.radius}`, `程序坞：${config.dock?.size || 46}px`, "将写入主题中心的自定义主题，不会覆盖其他主题。");
    } else if (post.type === "widget") {
      const config = manifest.configuration as WidgetConfig;
      details.push(`组件类型：${WIDGET_TYPE_LABEL[config.widgetType] || config.widgetType}`, `请求权限：${detailPermissionText(config.permissions)}`, "渲染方式：系统声明式组件，不执行社区脚本。");
    } else if (post.type === "workspace") {
      const config = manifest.configuration as WorkspaceConfig;
      const missingApps = (config.openApps || []).filter((id) => !ctx.APPS[id]);
      const missingWidgets = Object.keys(config.widgets || {}).filter((id) => !ctx.widgets.ids.includes(id));
      details.push(`将新增一套工作空间，不会覆盖当前桌面。`, `应用：${(config.openApps || []).length} 个${missingApps.length ? `，缺少 ${missingApps.length} 个（会跳过）` : ""}`, `组件：${Object.keys(config.widgets || {}).length} 个${missingWidgets.length ? `，缺少 ${missingWidgets.length} 个（会跳过）` : ""}`, "导入前会为当前工作空间创建保护性快照。");
    } else if (post.type === "wallpaper") {
      details.push("将下载壁纸并保存到本机壁纸库，不会上传你的文件。");
    }
    const value = await modal(win, {
      title: `安装「${post.title}」`,
      body: `<div class="cx-install-modal">
        <p><b>作者</b> ${esc(post.author.displayName)} · <b>版本</b> v${esc(post.version)} · <b>许可证</b> ${esc(licenseName(post.license))}</p>
        <ul>${details.map((line) => `<li>${esc(line)}</li>`).join("")}</ul>
        <p class="cx-hint">安装包会先做 SHA-256 校验与版本兼容检查；校验失败会中止安装。</p>
      </div>`,
      actions: [
        { label: "取消", value: "" },
        ...(post.type === "theme" ? [{ label: "仅安装", value: "install" }] : []),
        { label: post.type === "theme" ? "安装并应用" : "确认安装", value: "apply", primary: true },
      ],
      wide: true,
    });
    if (value !== "install" && value !== "apply") return;
    const result = await installFromServer(post, ctx, { applyTheme: value === "apply" });
    if (!result.ok) {
      toast(result.message);
      return;
    }
    if (result.details?.length) {
      await modal(win, {
        title: "安装完成",
        body: `<div class="cx-install-modal"><p>${esc(result.message)}</p><ul>${result.details.map((line) => `<li>${esc(line)}</li>`).join("")}</ul></div>`,
        actions: [{ label: "完成", value: "ok", primary: true }],
      });
    } else {
      toast(result.message);
    }
    await loadDetail(post.id);
  };

  const installVersion = async (postId: string, version: string) => {
    const data = await api.getPost(postId);
    const result = await installFromServer(data.post, ctx, { version, applyTheme: true });
    toast(result.ok ? `已安装 v${version}` : result.message);
    if (result.ok) void loadDetail(postId);
  };

  const newVersionFlow = (postId: string) => {
    void loadPublish({ versionOf: postId });
  };

  const editPostFlow = (postId: string) => {
    void loadPublish({ editId: postId });
  };

  const deletePostFlow = async (postId: string) => {
    const value = await modal(win, {
      title: "删除作品",
      body: `<p>删除后作品会从社区下线，图片与内容包将进入清理队列。这个操作不可撤销。</p>`,
      actions: [{ label: "取消", value: "" }, { label: "确认删除", value: "delete", danger: true, primary: true }],
    });
    if (value !== "delete") return;
    try {
      await api.deletePost(postId);
      toast("作品已删除");
      view = { kind: "tab", tab: "creations" };
      void loadCreations("works");
    } catch (error) {
      toast(error instanceof Error ? error.message : "删除失败");
    }
  };

  const withdrawFlow = async (postId: string) => {
    const value = await modal(win, {
      title: "撤回作品",
      body: `<p>撤回后作品会变为草稿，不再公开；已安装的用户仍保留本地副本。</p>`,
      actions: [{ label: "取消", value: "" }, { label: "撤回", value: "withdraw", primary: true }],
    });
    if (value !== "withdraw") return;
    try {
      await api.withdrawPost(postId);
      toast("作品已撤回为草稿");
      void loadCreations("works");
    } catch (error) {
      toast(error instanceof Error ? error.message : "撤回失败");
    }
  };

  const editMetaFlow = async (post: Post) => {
    const value = await modal(win, {
      title: "编辑作品信息",
      body: `<div class="cx-form">
        <label>作品名称<input class="cx-input" data-meta-title maxlength="80" value="${esc(post.title)}"/></label>
        <label>作品介绍<textarea class="cx-input" data-meta-desc rows="4" maxlength="8000">${esc(post.description)}</textarea></label>
        <label>标签（逗号分隔）<input class="cx-input" data-meta-tags value="${esc(post.tags.join(", "))}"/></label>
        <label>分类<select class="cx-input" data-meta-category>${Object.entries(CATEGORY_LABEL[post.type] || {}).map(([id, label]) => `<option value="${id}" ${post.category === id ? "selected" : ""}>${label}</option>`).join("")}</select></label>
        <label>许可证<select class="cx-input" data-meta-license>${LICENSE_OPTIONS.map((license) => `<option value="${license.id}" ${post.license === license.id ? "selected" : ""}>${esc(license.name)}</option>`).join("")}</select></label>
        <label>自定义授权说明<input class="cx-input" data-meta-license-note maxlength="600" value="${esc(post.licenseNote)}"/></label>
        <p class="cx-hint">修改已发布作品会重新进入人工审核（管理员除外），审核通过前作品暂不公开。版本配置请使用「发布新版本」。</p>
      </div>`,
      actions: [{ label: "取消", value: "" }, { label: "保存修改", value: "save", primary: true }],
      wide: true,
    });
    if (value !== "save") return;
    const title = (win.querySelector<HTMLInputElement>("[data-meta-title]")?.value || "").trim();
    const description = win.querySelector<HTMLTextAreaElement>("[data-meta-desc]")?.value || "";
    const tags = (win.querySelector<HTMLInputElement>("[data-meta-tags]")?.value || "")
      .split(/[,，]/)
      .map((tag) => tag.trim())
      .filter(Boolean)
      .slice(0, 8);
    const category = win.querySelector<HTMLSelectElement>("[data-meta-category]")?.value || post.category;
    const license = win.querySelector<HTMLSelectElement>("[data-meta-license]")?.value || post.license;
    const licenseNote = win.querySelector<HTMLInputElement>("[data-meta-license-note]")?.value || "";
    if (!title) {
      toast("作品名称不能为空");
      return;
    }
    try {
      const result = await api.patchPost(post.id, { title, description, tags, category, license, licenseNote });
      toast(result.message || "作品信息已更新");
      if (view.kind === "detail") await loadDetail(post.id);
      else await loadCreations("works");
    } catch (error) {
      toast(error instanceof Error ? error.message : "保存失败");
    }
  };

  const submitReport = async (targetType: string, targetId: string) => {
    if (!viewer()) {
      toast("请先登录");
      return;
    }
    const value = await modal(win, {
      title: "提交举报",
      body: `<div class="cx-form">
        <label>举报原因<select class="cx-input" data-report-reason>${Object.entries(REASON_LABEL).map(([id, label]) => `<option value="${id}">${label}</option>`).join("")}</select></label>
        <label>补充说明<textarea class="cx-input" rows="3" maxlength="1000" data-report-desc placeholder="请描述具体问题，方便审核员判断"></textarea></label>
        <p class="cx-hint">举报会提交给人工审核；不会自动公开你的身份，也不会自动隐藏内容。</p>
      </div>`,
      actions: [{ label: "取消", value: "" }, { label: "提交举报", value: "report", primary: true }],
    });
    if (value !== "report") return;
    const reason = win.querySelector<HTMLSelectElement>("[data-report-reason]")?.value || "other";
    const description = win.querySelector<HTMLTextAreaElement>("[data-report-desc]")?.value || "";
    try {
      if (targetType === "comment") await api.reportComment(targetId, reason, description);
      else await api.reportContent({ targetType, targetId, reason, description });
      toast("举报已提交，管理员会尽快处理");
    } catch (error) {
      toast(error instanceof Error ? error.message : "举报提交失败");
    }
  };

  const reviewModeration = async (postId: string, action: string, defaultNote = "") => {
    const value = await modal(win, {
      title: "审核操作",
      body: `<div class="cx-form"><label>备注（作者可见）<textarea class="cx-input" rows="3" maxlength="600" data-review-note placeholder="${esc(defaultNote)}"></textarea></label></div>`,
      actions: [{ label: "取消", value: "" }, { label: "执行", value: action, primary: true, danger: action === "delete" }],
    });
    if (value !== action) return;
    const note = win.querySelector<HTMLTextAreaElement>("[data-review-note]")?.value || defaultNote;
    try {
      await api.adminReviewPost(postId, action, note);
      toast("审核操作已执行");
      await loadModeration();
    } catch (error) {
      toast(error instanceof Error ? error.message : "操作失败");
    }
  };

  const reviewReport = async (reportId: string, action: string) => {
    const value = await modal(win, {
      title: "处理举报",
      body: `<div class="cx-form"><label>处理说明<textarea class="cx-input" rows="3" maxlength="600" data-report-resolution placeholder="会记录到审计日志，并在需要时通知作者"></textarea></label></div>`,
      actions: [{ label: "取消", value: "" }, { label: "确认处理", value: "go", primary: true, danger: action === "delete_post" || action === "restrict_user" }],
    });
    if (value !== "go") return;
    const resolution = win.querySelector<HTMLTextAreaElement>("[data-report-resolution]")?.value || "";
    try {
      const result = await api.adminReviewReport(reportId, action, resolution);
      toast(result.message);
      await loadModeration();
    } catch (error) {
      toast(error instanceof Error ? error.message : "操作失败");
    }
  };

  const handleInstalledAction = async (action: string, postId: string) => {
    const record = getInstall(postId);
    if (!record) {
      toast("本机没有这个安装记录");
      return;
    }
    try {
      if (action === "check-update") {
        const check = await checkUpdate(postId);
        if (!check.hasUpdate) {
          toast(`已是最新版本 v${record.version}`);
          return;
        }
        await modal(win, {
          title: "发现新版本",
          body: `<p>当前 v${esc(record.version)} → 最新 v${esc(check.latest || "")}</p><p>${esc(check.changelog || "作者没有填写更新说明。")}</p><p class="cx-hint">更新会保留历史版本，可回退。</p>`,
          actions: [{ label: "稍后", value: "" }, { label: "立即更新", value: "update", primary: true }],
        }).then((value) => {
          if (value === "update") void doUpdate(postId);
        });
      } else if (action === "update") {
        await doUpdate(postId);
      } else if (action === "rollback") {
        const data = await api.getPost(postId);
        const versions = data.versions;
        const value = await modal(win, {
          title: "版本历史 / 回退",
          body: `<div class="cx-menu-list">${versions
            .map((version) => `<button class="cx-menu-item g14-menu-item" data-mm="${esc(version.version)}"><b>v${esc(version.version)}</b><span>${esc(version.changelog || "无说明")}</span></button>`)
            .join("")}</div>`,
          actions: [{ label: "关闭", value: "" }],
        });
        if (!value) return;
        await installVersion(postId, value);
      } else if (action === "reapply") {
        if (record.postType === "theme") {
          const theme = findTheme(record.localId);
          if (theme) {
            applyTheme(theme);
            toast("主题已应用");
          } else toast("本地主题已不存在，请重新安装");
        } else if (record.postType === "widget") {
          ctx.widgets.setEnabled(record.localId, true);
          toast("组件已重新添加到桌面");
        } else if (record.postType === "workspace") {
          const workspace = workspaceList().find((item) => item.id === record.localId);
          if (workspace) {
            void applyWorkspace(workspace.id, ctx);
            toast("正在切换工作空间");
          } else toast("本地工作空间已不存在");
        } else if (record.postType === "wallpaper") {
          const gos13 = (window as unknown as { GOS13?: { setWallpaper?: (id: string) => void } }).GOS13;
          try {
            gos13?.setWallpaper?.(record.localId);
            toast("壁纸已应用");
          } catch {
            toast("壁纸已不在本机，请重新安装");
          }
        }
      } else if (action === "uninstall") {
        const value = await modal(win, {
          title: "卸载社区资源",
          body: `<p>将从本机移除「${esc(record.title)}」。已应用的桌面效果会按系统原有逻辑恢复或保留。</p>`,
          actions: [{ label: "取消", value: "" }, { label: "卸载", value: "go", danger: true, primary: true }],
        });
        if (value !== "go") return;
        await uninstallByPost(postId, ctx);
        toast("已卸载");
        await loadCreations("installed");
      }
    } catch (error) {
      toast(error instanceof Error ? error.message : "操作失败");
    }
  };

  const doUpdate = async (postId: string) => {
    const check = await checkUpdate(postId);
    if (!check.hasUpdate) {
      toast("已经是最新版本");
      return;
    }
    const data = await api.getPost(postId);
    const result = await installFromServer(data.post, ctx, { applyTheme: false });
    toast(result.ok ? `已更新到 v${data.post.version}` : result.message);
    if (result.ok) await loadCreations("installed");
  };

  const openPostFromEvent = (target: HTMLElement) => {
    if (target.closest("button,a,input,textarea,select,[data-action]")) return false;
    const postButton = target.closest<HTMLElement>("[data-post]");
    if (postButton?.dataset.post) {
      lastTab = view.kind === "tab" ? view.tab : lastTab;
      void loadDetail(postButton.dataset.post);
      return true;
    }
    return false;
  };

  /* ---------------- 点击代理 ---------------- */

  root.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;

    const nav = target.closest<HTMLElement>(".g14-nav[data-tab]");
    if (nav) {
      event.preventDefault();
      openTab(nav.dataset.tab || "home");
      return;
    }

    const like = target.closest<HTMLElement>("[data-like]");
    if (like) {
      event.preventDefault();
      event.stopPropagation();
      void toggleLike(like.dataset.like || "");
      return;
    }
    const fav = target.closest<HTMLElement>("[data-fav]");
    if (fav) {
      event.preventDefault();
      event.stopPropagation();
      void toggleFavorite(fav.dataset.fav || "");
      return;
    }

    const creator = target.closest<HTMLElement>("[data-creator]");
    if (creator) {
      event.preventDefault();
      event.stopPropagation();
      lastTab = view.kind === "tab" ? view.tab : lastTab;
      void loadCreator(creator.dataset.creator || "");
      return;
    }

    const page = target.closest<HTMLElement>("[data-page]");
    if (page) {
      event.preventDefault();
      const next = Number(page.dataset.page) || 1;
      if (view.kind === "search") {
        searchState.page = Math.max(1, next);
        void loadSearch(searchState.q, false);
      } else if (view.kind === "tab" && view.tab === "notifications") {
        void loadNotifications(Math.max(1, next));
      } else {
        explore.page = Math.max(1, next);
        void loadExplore(explore.type);
      }
      return;
    }

    if (openPostFromEvent(target)) {
      event.preventDefault();
      return;
    }

    const actionEl = target.closest<HTMLElement>("[data-action]");
    const action = actionEl?.dataset.action || "";
    if (!action) return;
    event.preventDefault();

    switch (action) {
      case "login":
        window.dispatchEvent(new CustomEvent("guandao:open-login"));
        break;
      case "join":
        window.dispatchEvent(new CustomEvent("guandao:open-community-join"));
        break;
      case "retry":
        void (view.kind === "tab" ? loadHome() : loadDetail((view as { id?: string }).id || ""));
        break;
      case "explore-all":
        explore = { type: "", category: "", sort: "latest", page: 1 };
        setActiveNav("explore");
        view = { kind: "tab", tab: "explore" };
        void loadExplore("");
        break;
      case "publish":
        if (actionEl?.dataset.id) {
          const id = actionEl.dataset.id;
          void (async () => {
            try {
              await api.publishPost(id, {});
              toast("已提交审核");
              await loadCreations("works");
            } catch (error) {
              toast(error instanceof Error ? error.message : "提交失败");
            }
          })();
        } else {
          void loadPublish({});
        }
        break;
      case "edit-post":
        if (actionEl?.dataset.id) editPostFlow(actionEl.dataset.id);
        break;
      case "edit-meta": {
        const id = actionEl?.dataset.id;
        if (!id) break;
        void (async () => {
          try {
            if (detailCache?.data.post.id === id) {
              await editMetaFlow(detailCache.data.post);
            } else {
              const data = await api.getPost(id);
              await editMetaFlow(data.post);
            }
          } catch (error) {
            toast(error instanceof Error ? error.message : "保存失败");
          }
        })();
        break;
      }
      case "new-version":
        if (actionEl?.dataset.id) newVersionFlow(actionEl.dataset.id);
        break;
      case "withdraw":
        if (actionEl?.dataset.id) void withdrawFlow(actionEl.dataset.id);
        break;
      case "delete-post":
        if (actionEl?.dataset.id) void deletePostFlow(actionEl.dataset.id);
        break;
      case "install":
        void installFlow();
        break;
      case "install-version":
        if (actionEl?.dataset.id && actionEl.dataset.version) void installVersion(actionEl.dataset.id, actionEl.dataset.version);
        break;
      case "install-wallpaper":
        if (actionEl?.dataset.id && actionEl.dataset.asset && detailCache) {
          const asset = detailCache.data.wallpapers.find((item) => item.id === actionEl.dataset.asset);
          if (!asset) break;
          void (async () => {
            const value = await modal(win, {
              title: "下载并应用壁纸",
              body: `<p>将下载 ${asset.width} × ${asset.height} 的壁纸并保存到本机。</p>`,
              actions: [{ label: "取消", value: "" }, { label: "下载并应用", value: "go", primary: true }],
            });
            if (value !== "go") return;
            const result = await installWallpaperAsset(detailCache!.data.post, asset, ctx);
            toast(result.message);
          })();
        }
        break;
      case "report":
        if (actionEl?.dataset.id) void submitReport("post", actionEl.dataset.id);
        break;
      case "report-comment":
        if (actionEl?.dataset.id) void submitReport("comment", actionEl.dataset.id);
        break;
      case "report-profile":
        if (actionEl?.dataset.id) void submitReport("profile", actionEl.dataset.id);
        break;
      case "moderate": {
        const id = actionEl?.dataset.id;
        if (!id) break;
        void (async () => {
          const choice = await modal(win, {
            title: "选择审核操作",
            body: `<div class="cx-menu-list">
              <button type="button" class="cx-menu-item g14-menu-item" data-mm="approve"><b>通过审核</b><span>让作品公开</span></button>
              <button type="button" class="cx-menu-item g14-menu-item" data-mm="hide"><b>隐藏作品</b><span>从社区下线，保留数据</span></button>
              <button type="button" class="cx-menu-item g14-menu-item" data-mm="reject"><b>拒绝作品</b><span>通知作者修改后重新提交</span></button>
              ${isAdmin() ? `<button type="button" class="cx-menu-item g14-menu-item is-danger" data-mm="delete"><b>删除作品</b><span>不可撤销，进入清理队列</span></button>` : ""}
            </div>`,
            actions: [{ label: "取消", value: "" }],
          });
          if (choice) void reviewModeration(id, choice);
        })();
        break;
      }
      case "preview-post":
        if (actionEl?.dataset.post) void loadDetail(actionEl.dataset.post);
        break;
      case "feature": {
        const id = actionEl?.dataset.id;
        if (!id) break;
        const featured = actionEl.dataset.featured === "1";
        void (async () => {
          try {
            await api.adminFeaturePost(id, !featured);
            toast(!featured ? "已加入编辑精选" : "已取消精选");
            if (view.kind === "detail") await loadDetail(id);
            else await loadModeration();
          } catch (error) {
            toast(error instanceof Error ? error.message : "操作失败");
          }
        })();
        break;
      }
      case "back":
        backToList();
        break;
      case "reply": {
        const id = actionEl?.dataset.id;
        const box = id ? win.querySelector<HTMLElement>(`[data-reply-box="${id}"]`) : null;
        if (box) box.hidden = !box.hidden;
        break;
      }
      case "cancel-reply": {
        const id = actionEl?.dataset.id;
        const box = id ? win.querySelector<HTMLElement>(`[data-reply-box="${id}"]`) : null;
        if (box) box.hidden = true;
        break;
      }
      case "submit-reply": {
        const id = actionEl?.dataset.id;
        const input = id ? win.querySelector<HTMLTextAreaElement>(`[data-reply-input="${id}"]`) : null;
        if (!id || !input) break;
        void (async () => {
          try {
            await api.addComment(detailCache!.data.post.id, input.value, id);
            toast("回复已发送");
            await refreshComments(1);
          } catch (error) {
            toast(error instanceof Error ? error.message : "回复失败");
          }
        })();
        break;
      }
      case "submit-comment": {
        const input = win.querySelector<HTMLTextAreaElement>("[data-comment-input]");
        if (!input || !detailCache) break;
        void (async () => {
          try {
            await api.addComment(detailCache!.data.post.id, input.value);
            input.value = "";
            toast("评论已发表");
            await refreshComments(1);
            const comments = detailCache?.comments;
            if (comments && detailCache) {
              detailCache.data.post.commentCount = comments.total;
            }
          } catch (error) {
            toast(error instanceof Error ? error.message : "评论失败");
          }
        })();
        break;
      }
      case "more-comments":
        if (detailCache) {
          void (async () => {
            const next = detailCache!.commentsPage + 1;
            await refreshComments(next);
          })();
        }
        break;
      case "delete-comment": {
        const id = actionEl?.dataset.id;
        if (!id) break;
        void (async () => {
          const value = await modal(win, {
            title: "删除评论",
            body: `<p>评论会被标记为已删除，回复关系仍会保留。</p>`,
            actions: [{ label: "取消", value: "" }, { label: "删除", value: "go", danger: true, primary: true }],
          });
          if (value !== "go") return;
          try {
            await api.removeComment(id);
            toast("评论已删除");
            await refreshComments(1);
          } catch (error) {
            toast(error instanceof Error ? error.message : "删除失败");
          }
        })();
        break;
      }
      case "mark-all":
        void (async () => {
          try {
            const result = await api.markNotifications({ all: true });
            if (meta) meta.unreadNotifications = result.unread;
            applyViewerChrome();
            toast("已全部标为已读");
            await loadNotifications(notificationsPage);
          } catch (error) {
            toast(error instanceof Error ? error.message : "操作失败");
          }
        })();
        break;
      case "my-profile":
        creationsTab = "profile";
        view = { kind: "tab", tab: "creations" };
        void loadCreations("profile");
        break;
      case "check-update":
      case "update":
      case "rollback":
      case "reapply":
      case "uninstall":
        if (actionEl?.dataset.id) void handleInstalledAction(action, actionEl.dataset.id);
        break;
      case "review-approve":
        if (actionEl?.dataset.id) void reviewModeration(actionEl.dataset.id, "approve");
        break;
      case "review-reject":
        if (actionEl?.dataset.id) void reviewModeration(actionEl.dataset.id, "reject");
        break;
      case "review-hide":
        if (actionEl?.dataset.id) void reviewModeration(actionEl.dataset.id, "hide");
        break;
      case "review-delete":
        if (actionEl?.dataset.id) void reviewModeration(actionEl.dataset.id, "delete");
        break;
      case "report-dismiss":
        if (actionEl?.dataset.id) void reviewReport(actionEl.dataset.id, "dismiss");
        break;
      case "report-hide-post":
        if (actionEl?.dataset.id) void reviewReport(actionEl.dataset.id, "hide_post");
        break;
      case "report-delete-post":
        if (actionEl?.dataset.id) void reviewReport(actionEl.dataset.id, "delete_post");
        break;
      case "report-hide-comment":
        if (actionEl?.dataset.id) void reviewReport(actionEl.dataset.id, "hide_comment");
        break;
      case "report-restrict":
        if (actionEl?.dataset.id) void reviewReport(actionEl.dataset.id, "restrict_user");
        break;
      case "user-role":
        if (actionEl?.dataset.id) {
          void (async () => {
            try {
              await api.adminSetUserRole(actionEl.dataset.id!, actionEl.dataset.role || "member");
              toast("角色已更新");
              await loadModeration();
            } catch (error) {
              toast(error instanceof Error ? error.message : "操作失败");
            }
          })();
        }
        break;
      case "user-status":
        if (actionEl?.dataset.id) {
          void (async () => {
            try {
              await api.adminSetUserStatus(actionEl.dataset.id!, actionEl.dataset.status || "active");
              toast("账号状态已更新");
              await loadModeration();
            } catch (error) {
              toast(error instanceof Error ? error.message : "操作失败");
            }
          })();
        }
        break;
      case "user-restrict":
        if (actionEl?.dataset.id) {
          void (async () => {
            const restriction = actionEl.dataset.restriction || "limited";
            const value = await modal(win, {
              title: restriction === "none" ? "解除发布限制" : "限制用户发布",
              body: restriction === "none" ? `<p>将恢复该用户的正常发布权限。</p>` : `<div class="cx-form"><label>原因（会通知用户）<textarea class="cx-input" rows="3" data-restrict-reason maxlength="300"></textarea></label></div>`,
              actions: [{ label: "取消", value: "" }, { label: "确认", value: "go", primary: true, danger: restriction !== "none" }],
            });
            if (value !== "go") return;
            const reason = win.querySelector<HTMLTextAreaElement>("[data-restrict-reason]")?.value || "";
            try {
              await api.adminSetRestriction(actionEl.dataset.id!, restriction, reason);
              toast("用户限制已更新");
              await loadModeration();
            } catch (error) {
              toast(error instanceof Error ? error.message : "操作失败");
            }
          })();
        }
        break;
      case "revoke-invite":
        if (actionEl?.dataset.id) {
          void (async () => {
            try {
              await api.adminRevokeInvite(actionEl.dataset.id!);
              toast("邀请码已作废");
              await loadModeration();
            } catch (error) {
              toast(error instanceof Error ? error.message : "操作失败");
            }
          })();
        }
        break;
      case "upload-cover":
        win.querySelector<HTMLInputElement>("[data-file-cover]")?.click();
        break;
      case "upload-previews":
        win.querySelector<HTMLInputElement>("[data-file-previews]")?.click();
        break;
      case "upload-wallpapers":
        win.querySelector<HTMLInputElement>("[data-file-wallpapers]")?.click();
        break;
      case "import-manifest":
        win.querySelector<HTMLInputElement>("[data-file-manifest]")?.click();
        break;
      case "generate-manifest":
        if (publishState) {
          const manifest = buildManifest(publishState.type);
          if (manifest) {
            publishState.manifest = manifest;
            const box = win.querySelector<HTMLElement>("[data-manifest-box]");
            if (box) box.innerHTML = manifestSummary(manifest, "");
            toast("已从当前桌面生成内容包");
          } else {
            const box = win.querySelector<HTMLElement>("[data-manifest-box]");
            if (box) box.innerHTML = manifestSummary(null, publishState.manifestError);
          }
        }
        break;
      case "save-draft":
        void submitPublish(false);
        break;
      case "submit-publish":
        void submitPublish(true);
        break;
      case "version-generate":
        if (versionState && publishState) {
          const manifest = buildManifest(versionState.post.type);
          if (manifest) {
            versionState.manifest = manifest;
            const box = win.querySelector<HTMLElement>("[data-version-manifest]");
            if (box) box.innerHTML = manifestSummary(manifest, "");
            toast("已生成新版本内容包");
          }
        }
        break;
      case "version-import":
        win.querySelector<HTMLInputElement>("[data-file-version]")?.click();
        break;
      case "upload-avatar":
        pickImage(async (file) => {
          if (!meta || !viewer()) return;
          const { asset } = await api.uploadImage(file, "avatar");
          await api.updateMyProfile({ avatarAssetId: asset.id });
          toast("头像已更新");
          await loadCreations("profile");
        });
        break;
      case "upload-profile-cover":
        pickImage(async (file) => {
          const { asset } = await api.uploadImage(file, "cover");
          await api.updateMyProfile({ coverAssetId: asset.id });
          toast("封面已更新");
          await loadCreations("profile");
        });
        break;
      case "install-post-preview":
        break;
      default:
        break;
    }
  });

  root.addEventListener("change", (event) => {
    const target = event.target as HTMLInputElement;
    if (target.matches("[data-publish-type]")) return;
    if (target.matches("[data-explore-sort]")) {
      explore.sort = target.value;
      explore.page = 1;
      void loadExplore(explore.type);
      return;
    }
    if (target.matches("[data-search-sort]")) {
      searchState.sort = target.value;
      void loadSearch(searchState.q, true);
      return;
    }
    if (target.matches("[data-creator-sort]")) {
      creatorsSort = target.value;
      void loadCreators();
      return;
    }
    if (target.matches("[data-creator-post-sort]") && view.kind === "creator") {
      creatorPostSort = target.value;
      void loadCreator(view.id);
      return;
    }
    if (target.matches("[data-file-cover]") && target.files?.[0]) {
      void handleUpload(target.files[0], "cover");
      target.value = "";
      return;
    }
    if (target.matches("[data-file-previews]") && target.files?.length) {
      void handleUploadMany(Array.from(target.files), "preview");
      target.value = "";
      return;
    }
    if (target.matches("[data-file-wallpapers]") && target.files?.length) {
      void handleUploadMany(Array.from(target.files), "wallpaper");
      target.value = "";
      return;
    }
    if (target.matches("[data-file-manifest]") && target.files?.[0] && publishState) {
      void (async () => {
        try {
          const raw = await readManifestFile(target.files![0]);
          const check = validateManifestClient(raw, publishState!.type);
          if (!check.ok) {
            publishState!.manifestError = check.errors.join("；");
            const box = win.querySelector<HTMLElement>("[data-manifest-box]");
            if (box) box.innerHTML = manifestSummary(null, publishState!.manifestError);
            return;
          }
          publishState!.manifest = check.manifest;
          publishState!.manifestError = "";
          const box = win.querySelector<HTMLElement>("[data-manifest-box]");
          if (box) box.innerHTML = manifestSummary(check.manifest, "");
          toast("内容包已通过预检");
        } catch (error) {
          toast(error instanceof Error ? error.message : "读取失败");
        }
      })();
      target.value = "";
      return;
    }
    if (target.matches("[data-file-version]") && target.files?.[0] && versionState) {
      void (async () => {
        try {
          const raw = await readManifestFile(target.files![0]);
          const check = validateManifestClient(raw, versionState!.post.type);
          if (!check.ok) {
            toast(check.errors[0]);
            return;
          }
          versionState!.manifest = check.manifest;
          const box = win.querySelector<HTMLElement>("[data-version-manifest]");
          if (box) box.innerHTML = manifestSummary(check.manifest, "");
          toast("新版本内容包已通过预检");
        } catch (error) {
          toast(error instanceof Error ? error.message : "读取失败");
        }
      })();
      target.value = "";
    }
  });

  root.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const genericTab = target.closest<HTMLElement>("[data-tab]");
    if (genericTab && !genericTab.classList.contains("g14-nav")) {
      event.preventDefault();
      openTab(genericTab.dataset.tab || "home");
      return;
    }
    const removeAsset = target.closest<HTMLElement>("[data-remove-asset]");
    if (removeAsset && publishState) {
      const index = Number(removeAsset.dataset.removeAsset);
      if (removeAsset.dataset.assetKind === "preview") {
        publishState.previews.splice(index, 1);
        publishState.previewsChanged = true;
      } else {
        publishState.wallpapers.splice(index, 1);
        publishState.wallpapersChanged = true;
      }
      paintPublishAssets();
      return;
    }
    const publishType = target.closest<HTMLElement>("[data-publish-type]");
    if (publishType && publishState && publishState.mode === "create") {
      publishState.type = publishType.dataset.publishType as PostType;
      publishState.manifest = null;
      paintPublishForm(null);
      return;
    }
    const filterType = target.closest<HTMLElement>("[data-filter-type]");
    if (filterType) {
      explore.type = filterType.dataset.filterType || "";
      explore.category = "";
      explore.page = 1;
      void loadExplore(explore.type);
      return;
    }
    const filterCat = target.closest<HTMLElement>("[data-filter-cat]");
    if (filterCat) {
      explore.category = filterCat.dataset.filterCat || "";
      explore.page = 1;
      void loadExplore(explore.type);
      return;
    }
    const searchType = target.closest<HTMLElement>("[data-search-type]");
    if (searchType) {
      searchState.type = searchType.dataset.searchType || "";
      void loadSearch(searchState.q, true);
      return;
    }
    const creatorType = target.closest<HTMLElement>("[data-creator-type]");
    if (creatorType && view.kind === "creator") {
      creatorPostType = creatorType.dataset.creatorType || "";
      void loadCreator(view.id);
      return;
    }
    const typeButton = target.closest<HTMLElement>("[data-type]");
    if (typeButton) {
      const type = typeButton.dataset.type || "";
      explore = { type, category: "", sort: "latest", page: 1 };
      view = { kind: "tab", tab: type === "theme" ? "themes" : type === "widget" ? "widgets" : type === "workspace" ? "workspaces" : type === "wallpaper" ? "wallpapers" : "explore" };
      void loadExplore(type);
      return;
    }
    const layoutBtn = target.closest<HTMLElement>("[data-layout]");
    if (layoutBtn) {
      layout = layoutBtn.dataset.layout === "list" ? "list" : "grid";
      ls.setStr(LAYOUT_KEY, layout);
      if (view.kind === "tab" && ["explore", "themes", "widgets", "workspaces", "wallpapers"].includes(view.tab)) void loadExplore(explore.type);
      else if (view.kind === "search") void loadSearch(searchState.q, false);
      else void loadHome();
      return;
    }
    const creationsTabBtn = target.closest<HTMLElement>("[data-creations-tab]");
    if (creationsTabBtn) {
      void loadCreations(creationsTabBtn.dataset.creationsTab as "works" | "profile" | "installed");
      return;
    }
    const statusBtn = target.closest<HTMLElement>("[data-creations-status]");
    if (statusBtn) {
      creationsStatus = statusBtn.dataset.creationsStatus || "all";
      void loadCreations("works");
      return;
    }
    const creationType = target.closest<HTMLElement>("[data-creations-type]");
    if (creationType) {
      creationsType = creationType.dataset.creationsType || "";
      void loadCreations("works");
      return;
    }
    const modTab = target.closest<HTMLElement>("[data-mod-tab]");
    if (modTab) {
      moderationTab = modTab.dataset.modTab as typeof moderationTab;
      void loadModeration();
      return;
    }
    const queueStatus = target.closest<HTMLElement>("[data-queue-status]");
    if (queueStatus) {
      moderationQueueStatus = queueStatus.dataset.queueStatus || "pending_review";
      void loadModeration();
      return;
    }
    const reportStatus = target.closest<HTMLElement>("[data-report-status]");
    if (reportStatus) {
      moderationReportStatus = reportStatus.dataset.reportStatus || "open";
      void loadModeration();
      return;
    }
    const favCollection = target.closest<HTMLElement>("[data-fav-collection]");
    if (favCollection) {
      favoritesCollection = favCollection.dataset.favCollection || "";
      void loadFavorites();
      return;
    }
    const follow = target.closest<HTMLElement>("[data-follow]");
    if (follow) {
      const id = follow.dataset.follow || "";
      const state = follow.dataset.followState === "1";
      void (async () => {
        try {
          if (state) {
            const result = await api.unfollowCreator(id);
            follow.dataset.followState = "0";
            follow.textContent = "关注创作者";
            follow.classList.add("is-primary");
            toast(`已取消关注 · ${result.followerCount} 位关注者`);
          } else {
            const result = await api.followCreator(id);
            follow.dataset.followState = "1";
            follow.textContent = "已关注";
            follow.classList.remove("is-primary");
            toast(`已关注 · ${result.followerCount} 位关注者`);
          }
        } catch (error) {
          toast(error instanceof Error ? error.message : "操作失败");
        }
      })();
      return;
    }
    const preview = target.closest<HTMLElement>("[data-preview]");
    if (preview?.dataset.preview) {
      void modal(win, {
        title: "预览图",
        body: `<div class="cx-lightbox"><img src="${safeUrl(preview.dataset.preview)}" alt=""/></div>`,
        actions: [{ label: "关闭", value: "", primary: true }],
        wide: true,
      });
    }
  });

  const pickImage = (onFile: (file: File) => Promise<void>) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/jpeg,image/png,image/webp";
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (file) void onFile(file).catch((error) => toast(error instanceof Error ? error.message : "上传失败"));
    });
    input.click();
  };

  const handleUpload = async (file: File, kind: api.UploadKind) => {
    try {
      if (!publishState) return;
      toast("正在压缩并上传图片…");
      const result = await api.uploadImage(file, kind);
      if (kind === "cover") {
        publishState.cover = { id: result.asset.id, thumbId: result.thumb?.id || null };
        publishState.coverChanged = true;
      }
      paintPublishAssets();
      toast("图片已上传");
    } catch (error) {
      toast(error instanceof Error ? error.message : "上传失败");
    }
  };

  const handleUploadMany = async (files: File[], kind: "preview" | "wallpaper") => {
    if (!publishState) return;
    const max = kind === "preview" ? 6 : 8;
    const current = kind === "preview" ? publishState.previews : publishState.wallpapers;
    const room = max - current.length;
    if (room <= 0) {
      toast(`最多上传 ${max} 张`);
      return;
    }
    try {
      toast(`正在上传 ${Math.min(room, files.length)} 张图片…`);
      for (const file of files.slice(0, room)) {
        const result = await api.uploadImage(file, kind);
        const ref = { id: result.asset.id, thumbId: result.thumb?.id || null };
        if (kind === "preview") {
          publishState.previews.push(ref);
          publishState.previewsChanged = true;
        } else {
          publishState.wallpapers.push(ref);
          publishState.wallpapersChanged = true;
        }
      }
      paintPublishAssets();
      toast("图片已上传");
    } catch (error) {
      toast(error instanceof Error ? error.message : "上传失败");
    }
  };

  const submitPublish = async (publish: boolean) => {
    if (!publishState) return;
    const msg = win.querySelector<HTMLElement>("[data-publish-msg]");
    const setMsg = (text: string) => {
      if (msg) msg.textContent = text;
    };
    const title = clampText(readFormValue("title"), 80);
    if (!title) {
      setMsg("请填写作品名称");
      return;
    }
    const description = readFormValue("description");
    const tags = readFormValue("tags").split(/[,，]/).map((tag) => tag.trim()).filter(Boolean).slice(0, 8);
    const license = readFormValue("license") || "CC-BY-4.0";
    const licenseNote = readFormValue("licenseNote");
    const category = readFormValue("category") || "other";
    const visibility = readFormValue("visibility") || "public";
    const rightsConfirmed = readChecked("rights");
    if (publish && !rightsConfirmed) {
      setMsg("发布前必须确认你拥有相关作品的分享权利");
      return;
    }
    if (publish) {
      let manifest = publishState.manifest;
      if (!manifest || publishState.type === "wallpaper" || publishState.type === "tutorial") {
        manifest = buildManifest(publishState.type);
        if (manifest) publishState.manifest = manifest;
      }
      if (!manifest) {
        setMsg(publishState.manifestError || "请先生成或导入内容包");
        return;
      }
      if (publishState.type === "wallpaper" && publishState.wallpapers.length === 0) {
        setMsg("壁纸作品至少上传一张图片");
        return;
      }
    }
    const payload: Record<string, unknown> = {
      type: publishState.type,
      title,
      description,
      category,
      tags,
      license,
      licenseNote,
      visibility,
      rightsConfirmed,
      publish,
      manifest: publishState.manifest || undefined,
      changelog: publishState.mode === "edit" ? "更新草稿" : "首次发布",
    };
    if (publishState.mode === "edit") {
      if (publishState.coverChanged) {
        payload.coverAssetId = publishState.cover?.id || null;
        payload.coverThumbAssetId = publishState.cover?.thumbId || null;
      }
      if (publishState.previewsChanged) {
        payload.previews = publishState.previews.map((asset) => ({ id: asset.id, thumbId: asset.thumbId }));
      }
      if (publishState.wallpapersChanged) {
        payload.wallpapers = publishState.wallpapers.map((asset) => ({ id: asset.id, thumbId: asset.thumbId }));
      }
    } else {
      payload.coverAssetId = publishState.cover?.id || null;
      payload.coverThumbAssetId = publishState.cover?.thumbId || null;
      payload.previews = publishState.previews.map((asset) => ({ id: asset.id, thumbId: asset.thumbId }));
      payload.wallpapers = publishState.wallpapers.map((asset) => ({ id: asset.id, thumbId: asset.thumbId }));
    }
    try {
      setMsg(publish ? "正在提交…" : "正在保存草稿…");
      if (publishState.mode === "edit" && publishState.postId) {
        await api.patchPost(publishState.postId, payload);
        if (publish) {
          const result = await api.publishPost(publishState.postId, {});
          toast(result.message);
        } else {
          toast("草稿已保存");
        }
        await loadDetail(publishState.postId);
      } else {
        const result = await api.createPost(payload);
        toast(result.message);
        publishState = newPublishState("create", publishState.type);
        await loadDetail(result.post.id);
      }
    } catch (error) {
      setMsg(error instanceof Error ? error.message : "提交失败");
    }
  };

  root.addEventListener("submit", (event) => {
    const form = event.target as HTMLFormElement;
    if (form.matches("[data-publish-form]")) {
      event.preventDefault();
      void submitPublish(true);
      return;
    }
    if (form.matches("[data-version-form]")) {
      event.preventDefault();
      void submitVersion();
      return;
    }
    if (form.matches("[data-profile-form]")) {
      event.preventDefault();
      const data = new FormData(form);
      void (async () => {
        try {
          await api.updateMyProfile({
            displayName: String(data.get("displayName") || ""),
            creatorTitle: String(data.get("creatorTitle") || ""),
            bio: String(data.get("bio") || ""),
            visibility: String(data.get("visibility") || "public"),
          });
          toast("资料已保存");
          await loadCreations("profile");
        } catch (error) {
          toast(error instanceof Error ? error.message : "保存失败");
        }
      })();
      return;
    }
    if (form.matches("[data-admin-settings]")) {
      event.preventDefault();
      const data = new FormData(form);
      void (async () => {
        try {
          await api.adminSaveSettings({
            communityName: String(data.get("communityName") || ""),
            registrationMode: String(data.get("registrationMode") || "closed"),
            announcement: String(data.get("announcement") || ""),
            requireReview: data.get("requireReview") === "on",
            memberLogin: data.get("memberLogin") === "on",
            allowPublishing: data.get("allowPublishing") === "on",
            maxPostsPerDay: Number(data.get("maxPostsPerDay") || 5),
            maxCommentsPerDay: Number(data.get("maxCommentsPerDay") || 60),
            maxPackagesPerUser: Number(data.get("maxPackagesPerUser") || 40),
            maxUploadBytes: Number(data.get("maxUploadMB") || 8) * 1024 * 1024,
            maxUserStorageBytes: Number(data.get("maxStorageMB") || 50) * 1024 * 1024,
          });
          toast("社区设置已保存");
          await loadModeration();
        } catch (error) {
          toast(error instanceof Error ? error.message : "保存失败");
        }
      })();
      return;
    }
    if (form.matches("[data-invite-form]")) {
      event.preventDefault();
      const data = new FormData(form);
      void (async () => {
        try {
          const result = await api.adminCreateInvite({
            label: String(data.get("label") || ""),
            maxUses: Number(data.get("maxUses") || 1),
            expiresInDays: Number(data.get("expiresInDays") || 0),
          });
          await modal(win, {
            title: "邀请码已生成",
            body: `<div class="cx-invite-code"><code>${esc(result.code)}</code><p>只显示这一次。请复制后发给对方，在登录窗口选择「加入社区」时填写。</p></div>`,
            actions: [{ label: "我已复制", value: "ok", primary: true }],
            wide: true,
          });
          await loadModeration();
        } catch (error) {
          toast(error instanceof Error ? error.message : "生成失败");
        }
      })();
    }
  });

  const submitVersion = async () => {
    if (!versionState || !publishState) return;
    const msg = win.querySelector<HTMLElement>("[data-version-msg]");
    const setMsg = (text: string) => {
      if (msg) msg.textContent = text;
    };
    const version = readFormValue("version");
    const changelog = readFormValue("changelog");
    if (!version) return setMsg("请填写版本号");
    if (changelog.trim().length < 2) return setMsg("请填写更新说明");
    let manifest = versionState.manifest;
    if (!manifest) {
      manifest = buildManifest(versionState.post.type);
      if (manifest) {
        manifest.version = version;
        versionState.manifest = manifest;
        const box = win.querySelector<HTMLElement>("[data-version-manifest]");
        if (box) box.innerHTML = manifestSummary(manifest, "");
      }
    }
    if (!manifest) return setMsg("请生成或导入新版本内容包");
    manifest.version = version;
    try {
      setMsg("正在提交新版本…");
      const result = await api.createVersion(versionState.post.id, { manifest, changelog });
      toast(result.message);
      await loadDetail(versionState.post.id);
    } catch (error) {
      setMsg(error instanceof Error ? error.message : "发布失败");
    }
  };

  root.addEventListener("keydown", (event) => {
    const target = event.target as HTMLElement;
    if (event.key === "Enter" && target.matches("[data-cx-search]")) {
      event.preventDefault();
      void loadSearch((target as HTMLInputElement).value, true);
    }
    if (event.key === "Enter" && target.closest("[data-post]") && target.matches("[data-post]")) {
      event.preventDefault();
      const id = target.getAttribute("data-post");
      if (id) void loadDetail(id);
    }
  });

  win.querySelector<HTMLButtonElement>('[data-action="search"]')?.addEventListener("click", () => {
    void loadSearch(searchInput?.value || "", true);
  });

  const onCommunityChange = () => {
    if (view.kind === "tab" && view.tab === "creations" && creationsTab === "installed") {
      void loadCreations("installed");
    }
  };
  window.addEventListener("guandao:community-change", onCommunityChange);

  /* ---------------- 启动 ---------------- */
  void (async () => {
    try {
      await ensureMeta();
      // TS 在 IIFE 里会把 meta 收窄回初始的 null，这里按声明类型读一次
      const metaNow = meta as api.CommunityMeta | null;
      const mark = win.querySelector<HTMLElement>(".g14-side-title");
      if (mark) mark.textContent = metaNow?.communityName || "Guandao Community";
      if (metaNow?.registrationMode === "closed") {
        // 关闭注册不影响浏览，只影响登录窗口的加入入口
      }
      await loadHome();
    } catch (error) {
      showError(error);
    }
  })();

  return () => {
    loadToken++;
    window.removeEventListener("guandao:community-change", onCommunityChange);
  };
};

