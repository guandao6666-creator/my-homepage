/**
 * Guandao OS 2.5 · 社区列表 loader（批次 2）。
 *
 * 从 initCommunity 闭包里搬出。函数体逐字保留，只是把闭包引用
 * 改成了 ctx.xxx —— 加载顺序、竞态令牌、渲染内容都没有变。
 */
import * as api from "../../community/api";
import { skeleton, postCard, esc } from "./ui";
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
