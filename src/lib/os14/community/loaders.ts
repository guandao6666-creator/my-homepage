/**
 * Guandao OS 2.5 · 社区列表 loader（批次 2）。
 *
 * 从 initCommunity 闭包里搬出。函数体逐字保留，只是把闭包引用
 * 改成了 ctx.xxx —— 加载顺序、竞态令牌、渲染内容都没有变。
 */
import * as api from "../../community/api";
import { safeUrl } from "../../html";
import {
  avatarHtml,
  bytesText,
  categoryChips,
  esc,
  pageNav,
  postCard,
  progressBar,
  roleBadge,
  skeleton,
  timeAgo,
  typeChips,
} from "./ui";
import { ROLE_LABEL, SEARCH_SORTS, TYPE_GLYPH, TYPE_LABEL } from "./constants";
import { notificationBody, notificationTitle } from "./notifications";
import { fmtDate } from "../core";
import { allThemes } from "../themes";
import { installedRecords } from "../../community/install";
import type { CommunityContext } from "./context";

export const loadFollowingTab = async (ctx: CommunityContext) => {
    ctx.setActiveNav("following");
    if (ctx.needLogin()) return;
    const token = ctx.nextToken();
    ctx.setBody(skeleton("正在读取你关注的创作者动态…"));
    try {
      await ctx.ensureMeta();
      const result = await api.getFollowingFeed(1);
      if (ctx.isStale(token)) return;
      ctx.setBody(`
        <section class="cx-page-head">
          <div><p class="cx-eyebrow">Following</p><h1>关注动态</h1><p>你关注的创作者发布的新作品会出现在这里。</p></div>
          <button class="cx-btn" type="button" data-tab="creators">发现创作者</button>
        </section>
        ${result.items.length ? `<div class="cx-grid is-${ctx.layout}">${result.items.map((post) => postCard(post, { row: ctx.layout === "list" })).join("")}</div>` : ctx.emptyState("还没有关注动态", "去创作者页关注几位创作者，或者发布你自己的第一个作品。", "⇢")}
      `);
    } catch (error) {
      if (!ctx.isStale(token)) ctx.showError(error);
    }
  }

export const loadMyFavorites = async (ctx: CommunityContext) => {
    ctx.setActiveNav("favorites");
    if (ctx.needLogin()) return;
    const token = ctx.nextToken();
    ctx.setBody(skeleton("正在读取收藏…"));
    try {
      await ctx.ensureMeta();
      const result = await api.getMyFavorites({ collection: ctx.favoritesCollection || undefined, page: 1 });
      if (ctx.isStale(token)) return;
      ctx.setBody(`
        <section class="cx-page-head"><div><p class="cx-eyebrow">Favorites</p><h1>我的收藏</h1><p>收藏是私人数据，只有你自己能看到。收藏夹分类也保存在服务端。</p></div><span class="cx-count">${result.total} 个作品</span></section>
        <div class="cx-chip-row">
          <button type="button" class="cx-chip ${ctx.favoritesCollection === "" ? "is-active" : ""}" data-fav-collection="">全部</button>
          ${result.collections.map((collection) => `<button type="button" class="cx-chip ${ctx.favoritesCollection === collection.name ? "is-active" : ""}" data-fav-collection="${esc(collection.name)}">${esc(collection.name)} <em>${collection.count}</em></button>`).join("")}
        </div>
        ${result.items.length ? `<div class="cx-grid is-${ctx.layout}">${result.items.map((post) => postCard(post, { row: ctx.layout === "list" })).join("")}</div>` : ctx.emptyState("这个收藏夹还是空的", "在作品详情页点星标即可收藏。", "★")}
      `);
    } catch (error) {
      if (!ctx.isStale(token)) ctx.showError(error);
    }
  }

/**
 * 首页（批次 2）。闭包依赖全部走 ctx：meta / viewer / layout / 竞态令牌。
 */
export const loadHome = async (ctx: CommunityContext) => {
    const token = ctx.nextToken();
    ctx.setBody(skeleton("正在汇总最新、热门与创作者动态…"));
    try {
      await ctx.ensureMeta();
      const meta = ctx.getMeta();
      const viewer = ctx.getViewer();
      const [latest, trending, creators, featured, following] = await Promise.all([
        api.getFeed({ tab: "latest", limit: 8 }),
        api.getFeed({ tab: "trending", limit: 5 }),
        api.getCreators({ sort: "active", limit: 6 }),
        api.getFeed({ tab: "featured", limit: 3 }),
        viewer ? api.getFollowingFeed(1).catch(() => null) : Promise.resolve(null),
      ]);
      if (ctx.isStale(token)) return;
      const counts = meta?.counts || {};
      const topCreators = creators.items;
      ctx.setBody(`
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
            ${latest.items.length ? `<div class="cx-grid is-${ctx.layout}">${latest.items.map((post) => postCard(post, { row: ctx.layout === "list" })).join("")}</div>` : ctx.emptyState("社区还没有作品", "成为第一个发布作品的人。", "◇")}
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
                  <em>${counts[type as api.PostType] || 0} 个作品</em>
                </button>`,
              )
              .join("")}
          </div>
        </section>
      `);
    } catch (error) {
      if (!ctx.isStale(token)) ctx.showError(error);
    }
  }

/**
 * 发现 / 分类列表（批次 2）。筛选状态保留在闭包 `explore` 对象里，
 * 这里通过 ctx.getExplore() 拿到同一份引用，只改字段，不复制状态。
 */
export const loadExplore = async (
  ctx: CommunityContext,
  type = ctx.getExplore().type,
  options: { resetPage?: boolean } = {},
) => {
    const explore = ctx.getExplore();
    if (options.resetPage) explore.page = 1;
    explore.type = type;
    ctx.setActiveNav(type === "theme" ? "themes" : type === "widget" ? "widgets" : type === "workspace" ? "workspaces" : type === "wallpaper" ? "wallpapers" : "explore");
    const token = ctx.nextToken();
    ctx.setBody(skeleton());
    try {
      await ctx.ensureMeta();
      const result = await api.getExplore({
        type: type || undefined,
        category: explore.category || undefined,
        sort: explore.sort,
        page: explore.page,
        limit: 12,
      });
      if (ctx.isStale(token)) return;
      const heading = type ? `${TYPE_LABEL[type]}市场` : "发现社区作品";
      const sub = type
        ? `浏览社区里的${TYPE_LABEL[type]}作品，按分类与热度筛选。`
        : "所有作品都来自真实用户发布；点击卡片查看详情、互动与安装。";
      ctx.setBody(`
        <section class="cx-page-head">
          <div><p class="cx-eyebrow">Explore</p><h1>${heading}</h1><p>${sub}</p></div>
          <div class="cx-layout-toggle">
            <button type="button" class="${ctx.layout === "grid" ? "is-active" : ""}" data-layout="grid" title="网格">▦</button>
            <button type="button" class="${ctx.layout === "list" ? "is-active" : ""}" data-layout="list" title="列表">☰</button>
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
            ? `<div class="cx-grid is-${ctx.layout}">${result.items.map((post) => postCard(post, { row: ctx.layout === "list" })).join("")}</div>`
            : ctx.emptyState("这个筛选下还没有作品", "换个分类，或者发布第一个。", "◇")
        }
        ${result.total ? pageNav(result.page, result.hasMore, result.total) : ""}
      `);
    } catch (error) {
      if (!ctx.isStale(token)) ctx.showError(error);
    }
  }

/**
 * 搜索页（批次 2）。空查询时回到首页，通过 ctx.loadHome() 避免反向依赖入口。
 */
export const loadSearch = async (ctx: CommunityContext, q: string, resetPage = true) => {
    const searchState = ctx.getSearchState();
    searchState.q = q.slice(0, 60);
    if (resetPage) searchState.page = 1;
    if (!searchState.q) return ctx.loadHome();
    ctx.setView({ kind: "search", q: searchState.q });
    ctx.setActiveNav("explore");
    const token = ctx.nextToken();
    ctx.setBody(skeleton("正在搜索社区作品与创作者…"));
    try {
      await ctx.ensureMeta();
      const result = await api.getSearch({
        q: searchState.q,
        type: searchState.type || undefined,
        sort: searchState.sort,
        page: searchState.page,
        limit: 12,
      });
      if (ctx.isStale(token)) return;
      ctx.setBody(`
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
            ? `<div class="cx-grid is-${ctx.layout}">${result.items.map((post) => postCard(post, { row: ctx.layout === "list" })).join("")}</div>`
            : ctx.emptyState("没有找到相关作品", "试试更短的关键词，或直接浏览发现页。", "⌕")
        }
        ${result.total ? pageNav(result.page, result.hasMore, result.total) : ""}
      `);
    } catch (error) {
      if (!ctx.isStale(token)) ctx.showError(error);
    }
  }

/**
 * 创作者列表（批次 2）。排序状态在闭包 creatorsSort 中，经 ctx 读写。
 */
export const loadCreators = async (ctx: CommunityContext) => {
    ctx.setActiveNav("creators");
    const token = ctx.nextToken();
    ctx.setBody(skeleton("正在读取创作者主页…"));
    try {
      await ctx.ensureMeta();
      const sort = ctx.getCreatorsSort();
      const result = await api.getCreators({ sort, limit: 24 });
      if (ctx.isStale(token)) return;
      ctx.setBody(`
        <section class="cx-page-head">
          <div><p class="cx-eyebrow">Creators</p><h1>社区创作者</h1><p>每个主页都来自真实账号；关注后会在「关注动态」看到新作品。</p></div>
          <select class="cx-select" data-creator-sort>
            <option value="active" ${sort === "active" ? "selected" : ""}>按作品数量</option>
            <option value="new" ${sort === "new" ? "selected" : ""}>最新加入</option>
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
            : ctx.emptyState("还没有公开创作者", "发布第一个作品，让朋友也来看看。", "◎")
        }
      `);
    } catch (error) {
      if (!ctx.isStale(token)) ctx.showError(error);
    }
  }

/**
 * 创作者主页（批次 2）。筛选状态 creatorPostType / creatorPostSort 经 ctx 读写。
 */
export const loadCreator = async (ctx: CommunityContext, id: string) => {
    ctx.setView({ kind: "creator", id });
    ctx.setActiveNav("creators");
    const token = ctx.nextToken();
    ctx.setBody(skeleton("正在打开创作者主页…"));
    try {
      await ctx.ensureMeta();
      const creatorPostType = ctx.getCreatorPostType();
      const creatorPostSort = ctx.getCreatorPostSort();
      const result = await api.getCreator(id, { type: creatorPostType || undefined, sort: creatorPostSort });
      if (ctx.isStale(token)) return;
      const creator = result.creator;
      ctx.setBody(`
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
          ${result.posts.length ? `<div class="cx-grid is-grid">${result.posts.map((post) => postCard(post)).join("")}</div>` : ctx.emptyState("这个分类下还没有公开作品", "换个分类看看。", "◇")}
        </section>
      `);
    } catch (error) {
      if (!ctx.isStale(token)) ctx.showError(error);
    }
  }

/**
 * 通知列表（批次 2）。未读计数写回闭包 meta，并刷新顶栏。
 */
export const loadNotifications = async (ctx: CommunityContext, page = ctx.getNotificationsPage()) => {
    ctx.setActiveNav("notifications");
    if (ctx.needLogin()) return;
    ctx.setNotificationsPage(page);
    const token = ctx.nextToken();
    ctx.setBody(skeleton("正在读取通知…"));
    try {
      await ctx.ensureMeta();
      const result = await api.getMyNotifications(page);
      if (ctx.isStale(token)) return;
      ctx.setMetaUnread(result.unread);
      ctx.applyViewerChrome();
      ctx.setBody(`
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
            : ctx.emptyState("还没有通知", "发布作品、关注创作者后，这里会有新动态。", "◔")
        }
        ${pageNav(page, result.items.length >= result.limit, page === 1 && result.items.length < result.limit ? result.items.length : null, "条通知")} 
      `);
    } catch (error) {
      if (!ctx.isStale(token)) ctx.showError(error);
    }
  }

/**
 * 我的作品 / 创作者资料 / 已安装（批次 2）。
 */
export const loadCreations = async (
  ctx: CommunityContext,
  tab: "works" | "profile" | "installed" = ctx.getCreationsTab(),
) => {
    ctx.setCreationsTab(tab);
    ctx.setActiveNav("creations");
    if (ctx.needLogin()) return;
    const token = ctx.nextToken();
    ctx.setBody(skeleton());
    try {
      await ctx.ensureMeta();
      const creationsStatus = ctx.getCreationsStatus();
      const creationsType = ctx.getCreationsType();
      if (tab === "works") {
        const result = await api.getMyCreations({ status: creationsStatus, type: creationsType || undefined, page: 1 });
        if (ctx.isStale(token)) return;
        const statuses: Array<[string, string]> = [["all", "全部"], ["published", "已发布"], ["pending_review", "待审核"], ["draft", "草稿"], ["rejected", "未通过"], ["hidden", "已隐藏"]];
        ctx.setBody(`
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
              ? `<div class="cx-grid is-${ctx.layout}">${result.items
                  .map(
                    (post) => `<div class="cx-card-wrap">
                      ${postCard(post, { row: ctx.layout === "list", showStatus: true })}
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
              : ctx.emptyState("还没有作品", "发布一套主题、一个组件或一组壁纸，让社区看到你的设计。", "✎")
          }
        `);
      } else if (tab === "profile") {
        const profile = await api.getMyProfile();
        if (ctx.isStale(token)) return;
        const limits = ctx.getMeta()?.limits;
        ctx.setBody(`
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
        const installedCache = installedRecords();
        ctx.setInstalledCache(installedCache);
        const themes = allThemes();
        if (ctx.isStale(token)) return;
        ctx.setBody(`
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
              : ctx.emptyState("还没有安装社区资源", "在作品详情页安装主题、组件、工作空间或壁纸。", "⤓")
          }
        `);
      }
    } catch (error) {
      if (!ctx.isStale(token)) ctx.showError(error);
    }
  }
