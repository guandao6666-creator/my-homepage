/**
 * Guandao OS 2.5 · 社区页面上下文。
 *
 * initCommunity 是一个 3,000 行的闭包，内层函数通过它共享状态。
 * 这里把「页面级能力」收敛成一个显式接口，让 loader 可以搬出闭包，
 * 而不是靠复制状态。**不新建第二套状态**：getter 仍然读闭包里的原变量。
 *
 * 批次 2 起，闭包里的可变状态（翻页、筛选、排序、已安装缓存）也通过
 * getter + setter 暴露；getter 返回的仍是同一份值/对象引用，不复制。
 */
import type { CommunityMeta, CommunityViewer } from "../../community/api";
import type { InstallRecord } from "../../community/install";
import type { DetailCache, ModerationTab, PublishState, VersionState, ViewState } from "./types";

/** 发现页的筛选状态（闭包内 `explore` 的镜像） */
export type ExploreState = { type: string; category: string; sort: string; page: number };

/** 搜索页的筛选状态（闭包内 `searchState` 的镜像） */
export type SearchState = { q: string; type: string; sort: string; page: number };

/** 「我的作品」三个标签页 */
export type CreationsTab = "works" | "profile" | "installed";

export interface CommunityContext {
  /** 高亮左侧导航 */
  setActiveNav(tab: string): void;
  /** 未登录时跳转登录门并返回 true */
  needLogin(): boolean;
  /** 替换主内容区 HTML */
  setBody(html: string): void;
  /** 统一错误面板 */
  showError(error: unknown): void;
  /** 懒加载社区元信息（分类 / 权限等） */
  ensureMeta(): Promise<unknown>;
  /** 空状态 HTML */
  emptyState(title: string, hint: string, glyph: string): string;
  /** 开始一次加载，返回竞态令牌 */
  nextToken(): number;
  /** 令牌是否已过期（期间有更新的加载发起） */
  isStale(token: number): boolean;
  /** 当前列表布局 */
  readonly layout: string;
  /** 当前收藏夹筛选 */
  readonly favoritesCollection: string;

  /* ---------------- 批次 2：loader 迁移所需的显式状态 ---------------- */

  /** 当前社区元信息（闭包内 `meta`；可能为 null） */
  getMeta(): CommunityMeta | null;
  /** 只写 meta.unreadNotifications，不暴露整份 meta 的替换权 */
  setMetaUnread(unread: number): void;
  /** 当前登录用户（闭包内 `viewer()`） */
  getViewer(): CommunityViewer | null;
  /** 按 meta 刷新导航徽标 / 审核入口 / 发布按钮 */
  applyViewerChrome(): void;
  /** 社区根节点（闭包内的 `win` 参数） */
  readonly win: HTMLElement;
  /** 轻提示（闭包内 `toast`） */
  toast(message: string): void;
  /** 是否审核员（闭包内 `isStaff()`） */
  isStaff(): boolean;
  /** 是否管理员（闭包内 `isAdmin()`） */
  isAdmin(): boolean;

  /** 发现页筛选状态（同一份对象引用，模块可直接改字段） */
  getExplore(): ExploreState;
  /** 搜索页筛选状态（同一份对象引用，模块可直接改字段） */
  getSearchState(): SearchState;
  /** 替换当前视图（闭包内 `view`） */
  setView(view: ViewState): void;
  /** 当前视图（闭包内 `view`） */
  getView(): ViewState;
  /** 返回列表时用到的上一个标签页（闭包内 `lastTab`） */
  getLastTab(): string;
  setLastTab(value: string): void;
  /** 详情页缓存（闭包内 `detailCache`；同一份对象引用） */
  getDetailCache(): DetailCache | null;
  setDetailCache(value: DetailCache | null): void;
  /** 发布表单状态（闭包内 `publishState`；同一份对象引用） */
  getPublishState(): PublishState | null;
  setPublishState(value: PublishState | null): void;
  /** 新版本发布状态（闭包内 `versionState`；同一份对象引用） */
  getVersionState(): VersionState | null;
  setVersionState(value: VersionState | null): void;
  /** 审核中心当前标签与筛选（闭包内 `moderationTab` 等） */
  getModerationTab(): ModerationTab;
  setModerationTab(value: ModerationTab): void;
  getModerationQueueStatus(): string;
  setModerationQueueStatus(value: string): void;
  getModerationReportStatus(): string;
  setModerationReportStatus(value: string): void;

  getCreatorsSort(): string;
  setCreatorsSort(value: string): void;
  getCreatorPostType(): string;
  setCreatorPostType(value: string): void;
  getCreatorPostSort(): string;
  setCreatorPostSort(value: string): void;

  getCreationsTab(): CreationsTab;
  setCreationsTab(value: CreationsTab): void;
  getCreationsStatus(): string;
  setCreationsStatus(value: string): void;
  getCreationsType(): string;
  setCreationsType(value: string): void;

  getNotificationsPage(): number;
  setNotificationsPage(value: number): void;
  /** 已安装资源缓存（闭包内 `installedCache`；同一份数组引用） */
  getInstalledCache(): InstallRecord[];
  setInstalledCache(records: InstallRecord[]): void;

  /** 空搜索时回到首页（由 community.ts 注入，避免 loader 反向 import 入口） */
  loadHome(): Promise<void>;
}
