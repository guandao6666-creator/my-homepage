/**
 * Guandao OS 1.6 · Guandao Community 应用
 *
 * 一个真正接入现有系统的社区前端：
 *   发现 → 详情 → 校验 → 安装 → 互动 → 创作者主页 → 审核后台
 * 所有数据来自 /api/community/*，没有任何写死的点赞、评论或用户。
 *
 * 社区内容始终以文本方式渲染；Markdown 使用 core.renderMarkdown（先整体转义）。
 */

// 6.2：样式走运行时加载（Astro 会把直接 import 的 CSS 提升到首页，见 D-006）
import communityCssUrl from "../../styles/community.css?url";
import { ensureCss } from "../ui/lazy-css";

/** `load()` 会等它完成后再渲染，避免无样式闪烁 */
export const stylesReady = ensureCss(communityCssUrl);
// 2.3.1：社区封面/头像/资产预览是第三方内容，图片 URL 走协议校验
import { safeUrl } from "../html";
import { emptyState, ls, modal, renderMarkdown, shell, type Ctx } from "./core";
import * as api from "../community/api";
import type { PostType } from "../community/api";
import { installWallpaperAsset, type InstallRecord } from "../community/install";
import { readManifestFile, validateManifestClient, type Manifest } from "../community/manifest";

/* ---------------- 2.5 拆分后的内部依赖 ----------------
   类型 / 常量 / 纯渲染工具已移到 ./community/*。
   这里 import 回来，initCommunity 内部的 73 个函数继续用同样的名字，
   行为与拆分前完全一致。 */
import type { DetailCache, ModerationTab, Post, PublishState, VersionState, ViewState } from "./community/types";
import { LAYOUT_KEY } from "./community/constants";
import { errorPanel, esc, loginGate, skeleton } from "./community/ui";
import {
  loadFollowingTab,
  loadMyFavorites,
  loadHome as loadHomeImpl,
  loadExplore as loadExploreImpl,
  loadSearch as loadSearchImpl,
  loadCreators as loadCreatorsImpl,
  loadCreator as loadCreatorImpl,
  loadNotifications as loadNotificationsImpl,
  loadCreations as loadCreationsImpl,
} from "./community/loaders";
import type { CommunityContext } from "./community/context";
import { loadDetailImpl, refreshCommentsImpl } from "./community/detail";
import {
  buildManifestImpl,
  loadPublishImpl,
  manifestSummaryImpl,
  paintPublishAssetsImpl,
  paintPublishFormImpl,
  submitPublishImpl,
  submitVersionImpl,
} from "./community/publish";
import {
  backToListImpl,
  deletePostFlowImpl,
  doUpdateImpl,
  editMetaFlowImpl,
  editPostFlowImpl,
  handleInstalledActionImpl,
  installFlowImpl,
  installVersionImpl,
  newVersionFlowImpl,
  openPostFromEventImpl,
  pickPageButton,
  refreshPostButtonsImpl,
  submitReportImpl,
  toggleFavoriteImpl,
  toggleLikeImpl,
  withdrawFlowImpl,
} from "./community/interactions";
import {
  loadModerationImpl,
  onCommunityChangeImpl,
  reviewModerationImpl,
  reviewReportImpl,
} from "./community/moderation";
import {
  handleUploadImpl,
  handleUploadManyImpl,
  pickImageImpl,
} from "./community/upload";

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

/**
 * 窗口 → 上一次 init 的卸载函数。
 *
 * 外壳的崩溃重试 / 工作区恢复有极小的概率对同一个窗口再次 mount；若不先
 * 摘掉旧监听，就会挂两套 click 代理，一次点击同时发起两个 loader、互相判定
 * stale（2.0.0 期间的 P1-8 排查中曾把它当作竞态来源）。这里用 WeakMap 做幂等，
 * 不往 DOM 上写标记，窗口回收后自动失效。
 */
const disposers = new WeakMap<HTMLElement, () => void>();

export const initCommunity = (win: HTMLElement, ctx: Ctx): (() => void) => {
  disposers.get(win)?.();
  const root = win.querySelector<HTMLElement>(".g14-shell") ?? win;
  const body = win.querySelector<HTMLElement>("[data-cx-body]");
  const searchInput = win.querySelector<HTMLInputElement>("[data-cx-search]");
  if (!body) return () => undefined;

  let meta: api.CommunityMeta | null = null;
  let view: ViewState = { kind: "tab", tab: "home" };
  let layout: "grid" | "list" = ls.str(LAYOUT_KEY) === "list" ? "list" : "grid";
  let loadToken = 0;
  // 卸载后（窗口关闭 / 被新实例顶掉）旧实例必须停止写 DOM：
  // 卸载只摘监听器，已经飞出去的 await 仍会回来。
  let disposed = false;
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
  let moderationTab: ModerationTab = "queue";
  let moderationQueueStatus = "pending_review";
  let moderationReportStatus = "open";
  let detailCache: DetailCache | null = null;
  let publishState: PublishState | null = null;
  let versionState: VersionState | null = null;
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
    if (disposed) return;
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


  /* ============================================================
     发现 / 分类列表
     ============================================================ */

  const loadExplore = (type?: string, options?: { resetPage?: boolean }) =>
    loadExploreImpl(communityCtx, type, options);

  /* ============================================================
     搜索
     ============================================================ */

  const loadSearch = (q: string, resetPage = true) => loadSearchImpl(communityCtx, q, resetPage);

  /* ============================================================
     创作者
     ============================================================ */

  const loadCreators = () => loadCreatorsImpl(communityCtx);

  const loadCreator = (id: string) => loadCreatorImpl(communityCtx, id);

  const loadHome = () => loadHomeImpl(communityCtx);

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
    getMeta: () => meta,
    setMetaUnread: (unread: number) => {
      if (meta) meta.unreadNotifications = unread;
    },
    getViewer: () => viewer(),
    applyViewerChrome,
    getExplore: () => explore,
    getSearchState: () => searchState,
    setView: (next) => {
      view = next;
    },
    getCreatorsSort: () => creatorsSort,
    setCreatorsSort: (value: string) => {
      creatorsSort = value;
    },
    getCreatorPostType: () => creatorPostType,
    setCreatorPostType: (value: string) => {
      creatorPostType = value;
    },
    getCreatorPostSort: () => creatorPostSort,
    setCreatorPostSort: (value: string) => {
      creatorPostSort = value;
    },
    getCreationsTab: () => creationsTab,
    setCreationsTab: (value) => {
      creationsTab = value;
    },
    getCreationsStatus: () => creationsStatus,
    setCreationsStatus: (value: string) => {
      creationsStatus = value;
    },
    getCreationsType: () => creationsType,
    setCreationsType: (value: string) => {
      creationsType = value;
    },
    getNotificationsPage: () => notificationsPage,
    setNotificationsPage: (value: number) => {
      notificationsPage = value;
    },
    getInstalledCache: () => installedCache,
    setInstalledCache: (records) => {
      installedCache = records;
    },
    loadHome: () => loadHome(),
    win,
    toast: (message: string) => ctx.toast(message),
    isStaff: () => isStaff(),
    isAdmin: () => isAdmin(),
    getView: () => view,
    getLastTab: () => lastTab,
    setLastTab: (value: string) => {
      lastTab = value;
    },
    getDetailCache: () => detailCache,
    setDetailCache: (value) => {
      detailCache = value;
    },
    getPublishState: () => publishState,
    setPublishState: (value) => {
      publishState = value;
    },
    getVersionState: () => versionState,
    setVersionState: (value) => {
      versionState = value;
    },
    getModerationTab: () => moderationTab,
    setModerationTab: (value) => {
      moderationTab = value;
    },
    getModerationQueueStatus: () => moderationQueueStatus,
    setModerationQueueStatus: (value: string) => {
      moderationQueueStatus = value;
    },
    getModerationReportStatus: () => moderationReportStatus,
    setModerationReportStatus: (value: string) => {
      moderationReportStatus = value;
    },
  };

  const loadFollowing = () => loadFollowingTab(communityCtx);

  const loadFavorites = () => loadMyFavorites(communityCtx);

  /* ============================================================
     收藏 / 通知
     ============================================================ */


  const loadNotifications = (page?: number) => loadNotificationsImpl(communityCtx, page);


  /* ============================================================
     我的作品 / 资料 / 已安装
     ============================================================ */

  const loadCreations = (tab?: "works" | "profile" | "installed") => loadCreationsImpl(communityCtx, tab);

  /* ============================================================
     作品详情（批次 3：实现已迁至 ./community/detail.ts）
     ============================================================ */

  const loadDetail = (id: string) => loadDetailImpl(communityCtx, id);

  const refreshComments = (page = 1) => refreshCommentsImpl(communityCtx, page);
  /* ============================================================
     发布 / 编辑 / 新版本（批次 3：实现已迁至 ./community/publish.ts）
     ============================================================ */

  const loadPublish = (options: { editId?: string; versionOf?: string } = {}) =>
    loadPublishImpl(communityCtx, options);
  const paintPublishForm = (editing: Post | null) =>
    paintPublishFormImpl(communityCtx, editing);
  const paintPublishAssets = () => paintPublishAssetsImpl(communityCtx);
  const manifestSummary = (manifest: Manifest | null, error: string) =>
    manifestSummaryImpl(manifest, error);
  const buildManifest = (type: PostType) =>
    buildManifestImpl(communityCtx, ctx, type);
  const submitPublish = async (publish: boolean) =>
    submitPublishImpl(communityCtx, ctx, publish);
  const submitVersion = async () => submitVersionImpl(communityCtx, ctx);
  /* ============================================================
     审核中心
     ============================================================ */

  const loadModeration = () => loadModerationImpl(communityCtx);

  /* ============================================================
     事件
     ============================================================ */

  const backToList = () => backToListImpl(communityCtx);

  let lastTab = "home";

  const refreshPostButtons = (
    id: string,
    liked: boolean,
    likeCount: number,
    favorited: boolean,
    favoriteCount: number,
  ) => refreshPostButtonsImpl(communityCtx, id, liked, likeCount, favorited, favoriteCount);

  const toggleLike = (postId: string) => toggleLikeImpl(communityCtx, postId);

  const toggleFavorite = (postId: string) => toggleFavoriteImpl(communityCtx, postId);

  const installFlow = () => installFlowImpl(communityCtx, ctx);

  const installVersion = (postId: string, version: string) =>
    installVersionImpl(communityCtx, ctx, postId, version);

  const newVersionFlow = (postId: string) => newVersionFlowImpl(communityCtx, postId);

  const editPostFlow = (postId: string) => editPostFlowImpl(communityCtx, postId);

  const deletePostFlow = (postId: string) => deletePostFlowImpl(communityCtx, postId);

  const withdrawFlow = (postId: string) => withdrawFlowImpl(communityCtx, postId);

  const editMetaFlow = (post: Post) => editMetaFlowImpl(communityCtx, post);

  const submitReport = (targetType: string, targetId: string) =>
    submitReportImpl(communityCtx, targetType, targetId);

  const reviewModeration = (postId: string, action: string, defaultNote = "") =>
    reviewModerationImpl(communityCtx, postId, action, defaultNote);

  const reviewReport = (reportId: string, action: string) =>
    reviewReportImpl(communityCtx, reportId, action);

  const handleInstalledAction = (action: string, postId: string) =>
    handleInstalledActionImpl(communityCtx, ctx, action, postId);

  const doUpdate = (postId: string) => doUpdateImpl(communityCtx, ctx, postId);

  const openPostFromEvent = (target: HTMLElement) => openPostFromEventImpl(communityCtx, target);

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

    // 只认分页按钮。OS 外壳会在 <html> 上写 data-page="desktop"，用裸
    // [data-page] 会把「点卡片 / 点空白」全部当成翻页，直接跳去发现页。
    // 2.0.1 起选择器与数字校验收敛到 pickPageButton（见 interactions.ts）。
    const page = pickPageButton(target);
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

  const pickImage = (onFile: (file: File) => Promise<void>) => pickImageImpl(communityCtx, onFile);

  const handleUpload = (file: File, kind: api.UploadKind) =>
    handleUploadImpl(communityCtx, file, kind);

  const handleUploadMany = (files: File[], kind: "preview" | "wallpaper") =>
    handleUploadManyImpl(communityCtx, files, kind);


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
  });

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

  const onCommunityChange = () => onCommunityChangeImpl(communityCtx);
  window.addEventListener("guandao:community-change", onCommunityChange);

  /* ---------------- 启动 ---------------- */
  void (async () => {
    try {
      await ensureMeta();
      if (disposed) return;
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

  const dispose = () => {
    disposed = true;
    loadToken++;
    window.removeEventListener("guandao:community-change", onCommunityChange);
    if (disposers.get(win) === dispose) disposers.delete(win);
  };
  disposers.set(win, dispose);
  return dispose;
};

