/**
 * Guandao OS 2.2 · 旧版应用注册入口。
 *
 * 设计约束（Phase 2.2）：
 * - 复用 index.astro 的 `registerApp`，不新建第二套注册中心；
 * - 应用只拿到 `LegacyAppContext` 里显式声明过的能力，不读闭包；
 * - 注册时机必须在 `renderDock()` / `openFromHash()` 之前，
 *   因为程序坞会按 `APPS` 过滤，注册晚了图标会消失。
 */
import type { LegacyAppContext, LegacyAppModule } from "./types";
import { aboutApp } from "./about";
import { articlesApp } from "./articles";
import { calculatorApp } from "./calc";
import { leaderboardApp } from "./leaderboard";
import { viewerApp } from "./viewer";

/** 已迁移的 legacy 应用清单（顺序即注册顺序，不影响窗口行为） */
export const LEGACY_APPS: readonly LegacyAppModule[] = [
  articlesApp,
  aboutApp,
  leaderboardApp,
  calculatorApp,
  viewerApp,
];

export function registerLegacyApps(ctx: LegacyAppContext): void {
  for (const app of LEGACY_APPS) {
    const init = app.init;
    ctx.register({
      id: app.id,
      title: app.title,
      width: app.width,
      height: app.height,
      glyph: app.glyph,
      body: () => app.body(ctx),
      init: init ? (win: HTMLElement) => init(win, ctx) : undefined,
    });
  }
}

export type { LegacyAppContext, LegacyAppModule } from "./types";

/**
 * 外壳与排行榜应用共用的上报能力。
 * index.astro 的 60 秒计时器直接用它，避免再抄一份请求代码。
 */
export { createRankReporter, RANK_NAME_KEY } from "./leaderboard/report";