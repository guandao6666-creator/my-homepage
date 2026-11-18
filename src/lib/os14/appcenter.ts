/**
 * Guandao OS 1.4 / 6.1 · 应用中心：启动期需要的统计能力。
 *
 * 6.1 起商店界面在 `./appcenter/app.ts`，按需下载；
 * 这里只保留 `bumpOpen`（每次打开应用时累加次数），它由外壳在开机时注册进 `onOpen`，
 * 必须同步可用，因此不能跟着界面一起懒加载。
 */

import { ls } from "./core";

export const STATS_KEY = "guandao.os14.appstats.v1";

export const readStats = (): Record<string, number> => ls.get<Record<string, number>>(STATS_KEY, {});

export const bumpOpen = (id: string) => {
  const stats = readStats();
  stats[id] = (stats[id] ?? 0) + 1;
  ls.set(STATS_KEY, stats);
};
