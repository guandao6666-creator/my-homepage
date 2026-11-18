/**
 * 民主议会（council）· 对应 index.astro 原 `renderCouncil` / `initCouncil`。
 *
 * 依赖：`data.supabase` / `data.council`（构建期种子）、`auth`（登录态、表单、续期、变更广播）、
 * `fetchWithTimeout`、`escapeHtml`；投票记录按账号存在 localStorage
 * `guandao.council.mine[.uid|.anon]`，投票人 key `guandao.council.voter`。
 */
import type { LegacyAppModule } from "../types";

const COUNCIL_MINE_KEY = "guandao.council.mine";

interface CouncilMineEntry {
  opt: number;
  at: number;
}

/** 投票记录按账号分开存（换号不能读到上一个号的「已投」）。 */
const councilMineKey = (uid: string | null) =>
  uid ? `${COUNCIL_MINE_KEY}.${uid}` : `${COUNCIL_MINE_KEY}.anon`;

const readCouncilMine = (uid: string | null): Record<string, CouncilMineEntry> => {
  try {
    const raw = JSON.parse(localStorage.getItem(councilMineKey(uid)) || "{}") as Record<string, unknown>;
    const out: Record<string, CouncilMineEntry> = {};

    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === "number") {
        out[k] = { opt: v, at: 0 };
      } else if (v && typeof v === "object") {
        const obj = v as { opt?: number; at?: number };
        if (typeof obj.opt === "number") out[k] = { opt: obj.opt, at: obj.at ?? 0 };
      }
    }

    return out;
  } catch {
    return {};
  }
};

const writeCouncilMine = (uid: string | null, mine: Record<string, CouncilMineEntry>) => {
  try {
    localStorage.setItem(councilMineKey(uid), JSON.stringify(mine));
  } catch {
    /* 隐私模式忽略 */
  }
};

export const councilApp: LegacyAppModule = {
  id: "council",
  title: "议会",
  width: 600,
  height: 540,
  glyph: "di-vote",
  body: () => `
          <div class="council">
            <div class="council-head">
              <span class="council-status" id="council-status">正在加载…</span>
              <button class="council-retry" id="council-retry" type="button" hidden>重试</button>
              <span class="council-tip">一人一票 · 投完看结果</span>
            </div>
            <div class="council-auth" id="council-auth"></div>
            <div class="council-list" id="council-list"></div>
          </div>`,
  init: (win, { data, escapeHtml, fetchWithTimeout, auth, lifecycle }) => {
    const list = win.querySelector("#council-list");
    const status = win.querySelector("#council-status");
    const retryBtn = win.querySelector<HTMLButtonElement>("#council-retry");
    if (!list || !status) return;

    const sb = data.supabase as { url?: string; key?: string } | undefined;
    const ready = Boolean(sb?.url && sb?.key);

    interface Poll {
      id: string;
      title: string;
      kind: string;
      options: string[];
    }

    // 议题和票数在构建时就写进页面了，打开即有内容，不等网络
    const seed = (data.council ?? { polls: [], counts: {} }) as {
      polls: Poll[];
      counts: Record<string, Record<string, number>>;
      builtAt?: number;
    };

    const polls: Poll[] = seed.polls ?? [];
    const baseCounts = seed.counts ?? {};
    // 构建时间：晚于这个时间投的票，还没进 baseCounts
    const builtAt = seed.builtAt ?? 0;

    // 我投过哪些，记在本地（含投票时间，用来判断要不要补这一票）
    let mine: Record<string, CouncilMineEntry> = readCouncilMine(auth.read()?.uid ?? null);

    let lastAuthed: boolean | null = null;

    const countOf = (pollId: string, optIdx: number) => {
      let n = baseCounts[pollId]?.[String(optIdx)] ?? 0;
      const entry = mine[pollId];
      // 构建之后投的票还没算进 baseCounts，这里补上，刷新也不会丢
      if (entry && entry.opt === optIdx && entry.at > builtAt) n += 1;
      return n;
    };

    const totalOf = (poll: Poll) => poll.options.reduce((sum, _, i) => sum + countOf(poll.id, i), 0);

    const render = () => {
      // 登录账号可能换了，重读一次投票记录
      const uid = auth.read()?.uid ?? null;
      mine = readCouncilMine(uid);

      if (!polls.length) {
        status.textContent = "暂无议题";
        list.innerHTML =
          '<p class="council-empty">页面里没有议题数据，可能是构建时没连上数据库。</p>';
        return;
      }

      const authed = Boolean(uid);
      const canVote = authed;

      const authBox = win.querySelector("#council-auth");
      if (authBox && authed !== lastAuthed) {
        authBox.innerHTML = authed ? "" : auth.formHtml();
        lastAuthed = authed;
      }

      const grand = polls.reduce((sum, p) => sum + totalOf(p), 0);
      status.textContent = canVote
        ? `${polls.length} 项在议 · ${grand} 票`
        : `${polls.length} 项在议 · 登录后才能投票`;

      list.innerHTML = polls
        .map((poll) => {
          const total = totalOf(poll);
          const chosen = mine[poll.id]?.opt;
          const locked = chosen !== undefined;

          const rows = poll.options
            .map((label, i) => {
              const n = countOf(poll.id, i);
              const pct = total ? Math.round((n / total) * 100) : 0;
              return `
                      <button class="council-opt ${chosen === i ? "is-mine" : ""}" type="button"
                        data-poll="${poll.id}" data-opt="${i}" ${locked || !canVote ? "disabled" : ""}>
                        <span class="council-bar" style="width:${pct}%"></span>
                        <span class="council-label">${escapeHtml(label)}</span>
                        <span class="council-num">${n}</span>
                      </button>`;
            })
            .join("");

          const myLabel = locked && poll.options[chosen] ? ` · 你投了「${escapeHtml(poll.options[chosen])}」` : "";

          return `
                  <section class="council-item">
                    <p class="council-title">${escapeHtml(poll.title)}</p>
                    <div class="council-opts">${rows}</div>
                    <p class="council-meta">${total} 票${myLabel}</p>
                  </section>`;
        })
        .join("");
    };

    const vote = async (pollId: string, optIdx: number) => {
      if (mine[pollId] !== undefined) return;

      if (!auth.read()) {
        status.textContent = "先登录才能投票";
        return;
      }

      // token 可能已经过期，先换一个可用的再用
      const token = await auth.ensureFreshToken();
      const current = auth.read();
      if (!token || !current) {
        status.textContent = "登录过期了，重新登录一下";
        render();
        return;
      }

      // 先在本地记下并刷新，网络再慢也不耽误
      mine[pollId] = { opt: optIdx, at: Date.now() };
      writeCouncilMine(current.uid, mine);
      render();

      if (!ready) {
        status.textContent = "已记在本地，但云端没连上";
        return;
      }

      void fetchWithTimeout(
        `${sb!.url}/rest/v1/votes`,
        {
          method: "POST",
          headers: {
            apikey: sb!.key!,
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            Prefer: "return=minimal",
          },
          body: JSON.stringify({ poll_id: pollId, option_index: optIdx, voter: current.uid }),
        },
        8000,
      )
        .then((res) => {
          if (!res.ok && res.status !== 409) throw new Error(String(res.status));
        })
        .catch(() => {
          // 没提交成功就撤销这票，让人还能重投
          delete mine[pollId];
          writeCouncilMine(current.uid, mine);
          render();
          status.textContent = "投票没提交上，再点一次试试";
          if (retryBtn) retryBtn.hidden = false;
        });
    };

    list.addEventListener("click", (event) => {
      const btn = (event.target as HTMLElement).closest<HTMLButtonElement>(".council-opt");
      if (!btn || btn.disabled) return;

      const pollId = btn.dataset.poll;
      const optIdx = Number(btn.dataset.opt);
      if (!pollId || Number.isNaN(optIdx)) return;

      vote(pollId, optIdx);
    });

    // 手动拉最新票数，失败也不影响已经显示的内容
    retryBtn?.addEventListener("click", async () => {
      if (!ready || !retryBtn) return;

      retryBtn.hidden = true;
      status.textContent = "正在拉最新票数…";

      try {
        const res = await fetchWithTimeout(
          `${sb!.url}/rest/v1/votes?select=poll_id,option_index`,
          { headers: { apikey: sb!.key!, Authorization: `Bearer ${sb!.key}` } },
          8000,
        );
        if (!res.ok) throw new Error("bad status");

        const votes = (await res.json()) as Array<{ poll_id: string; option_index: number }>;

        for (const k of Object.keys(baseCounts)) delete baseCounts[k];
        for (const v of votes) {
          if (!baseCounts[v.poll_id]) baseCounts[v.poll_id] = {};
          const cur = baseCounts[v.poll_id][v.option_index];
          baseCounts[v.poll_id][v.option_index] = (typeof cur === "number" ? cur : 0) + 1;
        }

        render();
        status.textContent = "已更新到最新";
      } catch {
        status.textContent = "还是连不上，先看页面里的结果";
        retryBtn.hidden = false;
      }
    });

    render();
    auth.onChange(win, render);
  },
};
