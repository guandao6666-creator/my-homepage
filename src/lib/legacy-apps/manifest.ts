/**
 * Guandao OS 6.1 · legacy 应用懒加载清单。
 *
 * 为什么要单独一份清单：
 * - 程序坞 / 启动台 / 终端 `apps` 命令需要在**同步阶段**就知道应用的 id、标题、尺寸和图标，
 *   否则图标会晚一帧出现；
 * - 但应用实现（HTML 生成 + 交互绑定）只在用户真正打开时才需要。
 *
 * 因此这里只保留「打开窗口必需的最小元数据」，实现通过 `load()` 动态 import。
 * 元数据在两处出现（本清单 + 各模块导出的 LegacyAppModule），
 * 由 `tests/unit/legacy-apps.test.ts` 的「清单与模块元数据一致」用例守住，不允许漂移。
 *
 * 约束：
 * - 顺序 = 1.0 时代 `APPS` 的键序，启动台 / 程序坞列表 / 终端 `apps` 都直接读它；
 * - `load()` 必须返回该模块导出的对象本身，不要在这里二次包装（会破坏模块内闭包）。
 */
import type { LegacyAppManifestEntry } from "./types";

export const LEGACY_APP_MANIFEST: readonly LegacyAppManifestEntry[] = [
  {
    id: "achievements",
    title: "成就",
    width: 540,
    height: 476,
    glyph: "di-ach",
    load: () => import("./achievements").then((m) => m.achievementsApp),
  },
  {
    id: "aquarium",
    title: "水族箱",
    width: 720,
    height: 480,
    glyph: "di-tank",
    load: () => import("./aquarium").then((m) => m.aquariumApp),
  },
  {
    id: "visitors",
    title: "访客墙",
    width: 640,
    height: 460,
    glyph: "di-wall",
    load: () => import("./visitors").then((m) => m.visitorsApp),
  },
  {
    id: "draw",
    title: "每日抽奖",
    width: 440,
    height: 420,
    glyph: "di-draw",
    load: () => import("./draw").then((m) => m.drawApp),
  },
  {
    id: "council",
    title: "议会",
    width: 600,
    height: 540,
    glyph: "di-vote",
    load: () => import("./council").then((m) => m.councilApp),
  },
  {
    id: "treehole",
    title: "树洞",
    width: 560,
    height: 620,
    glyph: "di-hole",
    load: () => import("./treehole").then((m) => m.treeholeApp),
  },
  {
    id: "news",
    title: "新闻联播",
    width: 500,
    height: 560,
    glyph: "di-tv",
    load: () => import("./news").then((m) => m.newsApp),
  },
  {
    id: "social",
    title: "社会网络",
    width: 560,
    height: 600,
    glyph: "di-net",
    load: () => import("./social").then((m) => m.socialApp),
  },
  {
    id: "monitor",
    title: "系统监视器",
    width: 420,
    height: 500,
    glyph: "di-mon",
    load: () => import("./monitor").then((m) => m.monitorApp),
  },
  {
    id: "browser",
    title: "浏览器",
    width: 560,
    height: 480,
    glyph: "di-browser",
    load: () => import("./browser").then((m) => m.browserApp),
  },
  {
    id: "posts",
    title: "文章",
    width: 660,
    height: 440,
    glyph: "di-folder",
    load: () => import("./articles").then((m) => m.articlesApp),
  },
  {
    id: "about",
    title: "关于",
    width: 460,
    height: 380,
    glyph: "di-person",
    load: () => import("./about").then((m) => m.aboutApp),
  },
  {
    id: "rank",
    title: "排行榜",
    width: 480,
    height: 460,
    glyph: "di-rank",
    load: () => import("./leaderboard").then((m) => m.leaderboardApp),
  },
  {
    id: "calc",
    title: "计算器",
    width: 300,
    height: 470,
    glyph: "di-calc",
    load: () => import("./calc").then((m) => m.calculatorApp),
  },
  {
    id: "viewer",
    title: "图片查看器",
    width: 640,
    height: 500,
    glyph: "di-viewer",
    load: () => import("./viewer").then((m) => m.viewerApp),
  },
  {
    id: "terminal",
    title: "终端",
    width: 560,
    height: 360,
    glyph: "di-term",
    load: () => import("./terminal").then((m) => m.terminalApp),
  },
];
