/**
 * Guandao OS 2.5 · 社区页面上下文。
 *
 * initCommunity 是一个 3,000 行的闭包，内层函数通过它共享状态。
 * 这里把「页面级能力」收敛成一个显式接口，让 loader 可以搬出闭包，
 * 而不是靠复制状态。**不新建第二套状态**：getter 仍然读闭包里的原变量。
 */
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
}
