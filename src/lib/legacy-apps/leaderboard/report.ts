/**
 * 排行榜的「停留时长上报」。
 *
 * 为什么单独一个文件：
 * 这份逻辑被两处使用——排行榜窗口里的「加入排行」（首次上报 0 秒），
 * 以及 index.astro 外壳里每 60 秒一次的计时器。
 * 如果只把它留在应用模块内，外壳就得再抄一份；抄两份正是本次重构要消除的债。
 *
 * 依赖仍然是显式的：Supabase 配置与带超时的 fetch 都由调用方传入。
 */
import type { OsData } from "../types";

/** 参与标识的 localStorage 键。沿用 1.0 的键名，改键会丢用户已有昵称。 */
export const RANK_NAME_KEY = "guandao.rank.name";

export type RankFetch = (url: string, init?: RequestInit, ms?: number) => Promise<Response>;

/**
 * 生成上报函数。
 * 未配置 Supabase 时返回一个安静的空操作，由调用方决定是否展示「未连接」。
 */
export function createRankReporter(supabase: OsData["supabase"], fetchWithTimeout: RankFetch) {
  const sb = supabase as { url?: string; key?: string } | undefined;

  return async (name: string, seconds: number): Promise<void> => {
    if (!sb?.url || !sb?.key) return;

    try {
      await fetchWithTimeout(`${sb.url}/rest/v1/rpc/report_time`, {
        method: "POST",
        headers: {
          apikey: sb.key,
          Authorization: `Bearer ${sb.key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ p_name: name, p_seconds: seconds }),
      });
    } catch {
      /* 报不上去就等下一轮 */
    }
  };
}