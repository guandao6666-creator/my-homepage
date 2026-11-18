/**
 * Guandao OS 2.2 / 6.1 · 旧版应用注册入口。
 *
 * 设计约束（Phase 2.2）：
 * - 复用 index.astro 的 `registerApp`，不新建第二套注册中心；
 * - 应用只拿到 `LegacyAppContext` 里显式声明过的能力，不读闭包；
 * - 注册时机必须在 `renderDock()` / `openFromHash()` 之前，
 *   因为程序坞会按 `APPS` 过滤，注册晚了图标会消失；
 * - 应用启动的计时器 / window 级监听由 `lifecycle` port 登记，
 *   init 包装在窗口关闭时统一 `dispose`（对应 index.astro 的 `__gosCleanup`）。
 *
 * Phase 6.1（本次）：应用实现移出入口 chunk。
 * 这里只静态引用清单（纯元数据），每个应用的实现通过 `load()` 动态 import，
 * 由外壳的懒加载通道渲染骨架屏 → 替换内容 → 执行 init。
 * 收益与残余差距见 `docs/AI-BUILD-STATUS.md` 与 `docs/RELEASE-2.0.md`。
 */
import type { LegacyAppContext, LegacyAppModule, LegacyLazyAppModule } from "./types";
import { LEGACY_APP_MANIFEST } from "./manifest";

export { legacyWindowLifecycle } from "./lifecycle";
export { LEGACY_APP_MANIFEST } from "./manifest";

/**
 * 把应用模块 + ctx 适配成外壳要的 `{ body, init }`。
 *
 * init 的清理顺序有意固定：先跑应用自己的 cleanup，再由 lifecycle 统一回收
 * 计时器 / 全局监听。反过来的话，应用 cleanup 里再取消定时器会拿到已失效的 id。
 */
function adapt(app: LegacyAppModule, ctx: LegacyAppContext): LegacyLazyAppModule {
  return {
    body: () => app.body(ctx),
    init: app.init
      ? (win: HTMLElement) => {
          const cleanup = app.init?.(win, ctx);
          return () => {
            cleanup?.();
            ctx.lifecycle.dispose(win);
          };
        }
      : undefined,
  };
}

/**
 * 按清单注册全部旧应用。
 *
 * 全部走 `load()`：窗口打开时先显示骨架，chunk 到齐后填充。
 * 元数据（标题 / 尺寸 / 图标）已在清单里，因此程序坞与启动台不需要等待网络。
 */
export function registerLegacyApps(ctx: LegacyAppContext): void {
  for (const entry of LEGACY_APP_MANIFEST) {
    ctx.register({
      id: entry.id,
      title: entry.title,
      width: entry.width,
      height: entry.height,
      glyph: entry.glyph,
      load: () =>
        entry.load().then(async (app) => {
          // 6.2：旧应用同样等样式就绪再渲染（CSS 走 ?url + ensureCss）
          await app.stylesReady;
          return adapt(app, ctx);
        }),
    });
  }
}

export type { LegacyAppContext, LegacyAppManifestEntry, LegacyAppModule } from "./types";

/**
 * 外壳与排行榜应用共用的上报能力。
 * index.astro 的 60 秒计时器直接用它，避免再抄一份请求代码。
 */
export { createRankReporter, RANK_NAME_KEY } from "./leaderboard/report";
