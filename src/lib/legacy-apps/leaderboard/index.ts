/**
 * 排行榜（rank）· 对应 index.astro 原 `fmtDuration` / `reportTime` / `renderRank` / `initRank`。
 *
 * 依赖：`data.supabase`、`escapeHtml`、`fetchWithTimeout`。
 *
 * 已知技术债（本次不修，避免顺带改行为）：
 * `initRank` 末尾的 `void load()` 是异步的，窗口在请求返回前被关掉时，
 * 回调仍会写一个已脱离文档的 `status` / `list` 节点。不会抛错，也不会泄漏处理器，
 * 但严格的生命周期应在 `init` 里返回 cleanup 取消请求——留待 Phase 2.4 处理。
 */
import type { LegacyAppModule } from "../types";
import { createRankReporter, RANK_NAME_KEY } from "./report";

const fmtDuration = (secs: number) => {
  if (secs < 60) return `${secs} 秒`;
  if (secs < 3600) return `${Math.floor(secs / 60)} 分钟`;
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return m ? `${h} 小时 ${m} 分` : `${h} 小时`;
};

export const leaderboardApp: LegacyAppModule = {
  id: "rank",
  title: "排行榜",
  width: 480,
  height: 460,
  glyph: "di-rank",
  body: () => `
          <div class="rank">
            <div class="rank-head">
              <span class="rank-status" id="rank-status">正在加载…</span>
              <button class="rank-join" id="rank-join" type="button">加入排行</button>
            </div>
            <div class="rank-list" id="rank-list"></div>
            <p class="rank-note">按累计停留时长排序，每 60 秒上报一次</p>
          </div>`,
  init: (win, { data, escapeHtml, fetchWithTimeout }) => {
    const list = win.querySelector("#rank-list");
    const status = win.querySelector("#rank-status");
    const joinBtn = win.querySelector("#rank-join") as HTMLButtonElement | null;
    if (!list || !status || !joinBtn) return;

    const sb = data.supabase as { url?: string; key?: string } | undefined;
    const ready = Boolean(sb?.url && sb?.key);

    // 与外壳的 60 秒计时器共用同一份实现（见 ./report.ts）
    const reportTime = createRankReporter(data.supabase, fetchWithTimeout);

    const load = async () => {
      if (!ready) {
        status.textContent = "未连接";
        list.innerHTML = '<p class="rank-empty">云端还没接上。</p>';
        return;
      }

      try {
        const res = await fetchWithTimeout(
          `${sb!.url}/rest/v1/visitor_rank?select=name,seconds,visits&order=seconds.desc&limit=20`,
          { headers: { apikey: sb!.key!, Authorization: `Bearer ${sb!.key}` } },
        );
        if (!res.ok) throw new Error(String(res.status));
        const rows = (await res.json()) as Array<{
          name: string;
          seconds: number;
          visits: number;
        }>;

        if (!rows.length) {
          status.textContent = "还没有人上榜";
          list.innerHTML = '<p class="rank-empty">榜还是空的，做第一个。</p>';
          return;
        }

        status.textContent = `${rows.length} 位在榜`;
        list.innerHTML = rows
          .map(
            (r, i) => `
                    <div class="rank-row ${i < 3 ? "is-top" : ""}">
                      <span class="rank-no">${i + 1}</span>
                      <span class="rank-name">${escapeHtml(r.name)}</span>
                      <span class="rank-time">${fmtDuration(r.seconds)}</span>
                    </div>`,
          )
          .join("");
      } catch {
        status.textContent = "连不上";
        list.innerHTML = '<p class="rank-empty">数据库连不上，可能是网络到不了 supabase.co。</p>';
      }
    };

    const current = localStorage.getItem(RANK_NAME_KEY);
    if (current) {
      joinBtn.textContent = `以「${current}」参与`;
      joinBtn.disabled = true;
    }

    joinBtn.addEventListener("click", () => {
      const input = window.prompt("留个名字，榜上用它显示（1–16 字）");
      if (!input) return;

      const name = input.trim().slice(0, 16);
      if (!name) return;

      localStorage.setItem(RANK_NAME_KEY, name);
      joinBtn.textContent = `以「${name}」参与`;
      joinBtn.disabled = true;
      void reportTime(name, 0);
      void load();
    });

    void load();
  },
};