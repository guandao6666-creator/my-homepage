/**
 * 匿名树洞（treehole）· 对应 index.astro 原 `renderTreehole` / `initTreehole`。
 *
 * 依赖：`data.supabase`、`fetchWithTimeout`、`escapeHtml`、`auth`（登录态 / 表单 / 续期 / 变更广播）、
 * `lifecycle`（auth-change 监听随窗口关闭一起摘掉）。匿名昵称本地生成，不落库身份。
 */
import type { LegacyAppModule } from "../types";

const HOLE_ADJ = ["安静的", "路过的", "深夜的", "迷路的", "加班的", "刚睡醒的", "在骑车的", "写代码的", "晒太阳的"];
const HOLE_NOUN = ["鲸鱼", "海豚", "猫", "海鸥", "风", "路灯", "路人", "大肥鱼", "土豆"];

const holeNick = () =>
  `${HOLE_ADJ[Math.floor(Math.random() * HOLE_ADJ.length)]}${HOLE_NOUN[Math.floor(Math.random() * HOLE_NOUN.length)]}`;

const timeAgo = (iso: string) => {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} 天前`;
  return new Date(iso).toLocaleDateString("zh-CN");
};

export const treeholeApp: LegacyAppModule = {
  id: "treehole",
  title: "树洞",
  width: 560,
  height: 620,
  glyph: "di-hole",
  body: () => `
          <div class="hole">
            <div class="hole-top">
              <p class="hole-topic-label">今日话题</p>
              <p class="hole-topic" id="hole-topic">今天有什么小事让你开心？</p>
            </div>
            <div class="hole-auth" id="hole-auth"></div>
            <form class="hole-form" id="hole-form">
              <textarea class="hole-input" id="hole-input" rows="2" maxlength="500" placeholder="想说什么就说，没人知道你是谁"></textarea>
              <div class="hole-form-bar">
                <span class="hole-count" id="hole-count">0 / 500</span>
                <button class="hole-send" id="hole-send" type="submit">说出去</button>
              </div>
            </form>
            <div class="hole-list" id="hole-list"></div>
            <p class="hole-status" id="hole-status"></p>
          </div>`,
  init: (win, { data, escapeHtml, fetchWithTimeout, auth, lifecycle }) => {
    const list = win.querySelector("#hole-list");
    const form = win.querySelector<HTMLFormElement>("#hole-form");
    const input = win.querySelector<HTMLTextAreaElement>("#hole-input");
    const send = win.querySelector<HTMLButtonElement>("#hole-send");
    const count = win.querySelector("#hole-count");
    const status = win.querySelector("#hole-status");
    const topicEl = win.querySelector("#hole-topic");
    if (!list || !form || !input || !send || !count || !status) return;

    const sb = data.supabase as { url?: string; key?: string } | undefined;
    const ready = Boolean(sb?.url && sb?.key);

    interface Hole {
      id: string;
      content: string;
      nick: string;
      featured: boolean;
      created_at: string;
    }
    interface Reply {
      id: string;
      hole_id: string;
      content: string;
      nick: string;
      created_at: string;
    }

    let holes: Hole[] = [];
    let replies: Reply[] = [];
    const openReplies = new Set<string>();

    const authBox = win.querySelector("#hole-auth");
    let lastAuthed: boolean | null = null;

    const render = () => {
      const authed = Boolean(auth.read());
      // 只在登录状态真正变化时重绘，否则会把正在输入的邮箱密码清掉
      if (authBox && authed !== lastAuthed) {
        authBox.innerHTML = authed
          ? ""
          : `${auth.formHtml()}<p class="hole-auth-tip">登录后才能说话和回应，页面上仍只显示随机昵称。</p>`;
        lastAuthed = authed;
      }

      if (!holes.length) {
        list.innerHTML = '<p class="hole-empty">还没有人说话。做第一个吧。</p>';
        return;
      }

      list.innerHTML = holes
        .map((h) => {
          const rs = replies.filter((r) => r.hole_id === h.id);
          const open = openReplies.has(h.id);

          const replyBlock = open
            ? `
                    <div class="hole-replies">
                      ${
                        rs.length
                          ? rs
                              .map(
                                (r) => `
                                  <div class="hole-reply">
                                    <span class="hole-reply-nick">${escapeHtml(r.nick)}</span>
                                    <span class="hole-reply-text">${escapeHtml(r.content)}</span>
                                  </div>`,
                              )
                              .join("")
                          : '<p class="hole-reply-empty">还没有回应，说点什么？</p>'
                      }
                      <form class="hole-reply-form" data-hole="${h.id}">
                        <input class="hole-reply-input" maxlength="300" placeholder="回应一句…" />
                        <button type="submit">发送</button>
                      </form>
                    </div>`
            : "";

          return `
                  <article class="hole-item ${h.featured ? "is-featured" : ""}">
                    ${h.featured ? '<span class="hole-badge">精选</span>' : ""}
                    <p class="hole-text">${escapeHtml(h.content)}</p>
                    <div class="hole-meta">
                      <span class="hole-nick">${escapeHtml(h.nick)}</span>
                      <span class="hole-time">${timeAgo(h.created_at)}</span>
                      <button class="hole-reply-toggle" data-hole="${h.id}" type="button">
                        ${rs.length ? `${rs.length} 条回应` : "回应"}
                      </button>
                    </div>
                    ${replyBlock}
                  </article>`;
        })
        .join("");
    };

    const load = async () => {
      if (!ready) {
        status.textContent = "云端没接上，只能看不能发";
        return;
      }

      // 未登录也要能看到别人说的，所以照常拉数据

      status.textContent = "正在连…";

      try {
        const headers = { apikey: sb!.key!, Authorization: `Bearer ${sb!.key}` };

        const [tRes, hRes, rRes] = await Promise.all([
          fetchWithTimeout(
            `${sb!.url}/rest/v1/hole_topics?select=day,topic&order=day.desc&limit=1`,
            { headers },
            8000,
          ),
          fetchWithTimeout(
            `${sb!.url}/rest/v1/holes?select=id,content,nick,featured,created_at&order=featured.desc,created_at.desc&limit=40`,
            { headers },
            10000,
          ),
          fetchWithTimeout(
            `${sb!.url}/rest/v1/hole_replies?select=id,hole_id,content,nick,created_at&order=created_at.asc&limit=300`,
            { headers },
            10000,
          ),
        ]);

        if (tRes.ok) {
          const topics = (await tRes.json()) as Array<{ topic: string }>;
          if (topics.length && topicEl) topicEl.textContent = topics[0].topic;
        }

        if (!hRes.ok || !rRes.ok) throw new Error("bad status");

        holes = (await hRes.json()) as Hole[];
        replies = (await rRes.json()) as Reply[];

        status.textContent = holes.length ? `共 ${holes.length} 条` : "";
        render();
      } catch {
        status.textContent = "连不上，可能是网络问题，关掉重开试试";
      }
    };

    // 没登录就锁住输入框
    const syncInputState = () => {
      const current = auth.read();
      input.disabled = !current;
      send.disabled = !current;
      input.placeholder = current
        ? "想说什么就说，页面上只显示随机昵称"
        : "登录后就能在这里说话";
    };
    syncInputState();
    auth.onChange(win, () => {
      syncInputState();
      render();
    });

    input.addEventListener("input", () => {
      count.textContent = `${input.value.length} / 500`;
    });

    form.addEventListener("submit", async (event) => {
      event.preventDefault();

      const text = input.value.trim();
      if (!text) return;

      if (!auth.read()) {
        status.textContent = "登录后才能说话";
        return;
      }

      const token = await auth.ensureFreshToken();
      const current = auth.read();
      if (!token || !current) {
        status.textContent = "登录过期了，重新登录一下";
        return;
      }

      const nick = holeNick();
      const optimistic: Hole = {
        id: `local-${Date.now()}`,
        content: text,
        nick,
        featured: false,
        created_at: new Date().toISOString(),
      };

      // 先插进列表，网络慢也不耽误看到自己说的话
      holes.unshift(optimistic);
      input.value = "";
      count.textContent = "0 / 500";
      render();
      list.scrollTop = 0;

      if (!ready) {
        status.textContent = "显示在本地了，但云端没连上";
        return;
      }

      send.disabled = true;

      try {
        const res = await fetchWithTimeout(
          `${sb!.url}/rest/v1/holes`,
          {
            method: "POST",
            headers: {
              apikey: sb!.key!,
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
              Prefer: "return=minimal",
            },
            body: JSON.stringify({ content: text, nick, author_id: current.uid }),
          },
          10000,
        );
        if (!res.ok) throw new Error(String(res.status));
        status.textContent = "说完了";
      } catch {
        holes = holes.filter((h) => h.id !== optimistic.id);
        render();
        status.textContent = "没发出去，再试一次";
      } finally {
        send.disabled = false;
      }
    });

    list.addEventListener("click", (event) => {
      const btn = (event.target as HTMLElement).closest<HTMLElement>(".hole-reply-toggle");
      if (!btn) return;

      const id = btn.dataset.hole;
      if (!id) return;

      if (openReplies.has(id)) openReplies.delete(id);
      else openReplies.add(id);

      render();
    });

    list.addEventListener("submit", async (event) => {
      const formEl = event.target as HTMLFormElement;
      if (!formEl.classList.contains("hole-reply-form")) return;
      event.preventDefault();

      const holeId = formEl.dataset.hole;
      const inputEl = formEl.querySelector<HTMLInputElement>(".hole-reply-input");
      const text = inputEl?.value.trim();
      if (!holeId || !text || !ready) return;

      if (!auth.read()) {
        status.textContent = "登录后才能回应";
        return;
      }

      const token = await auth.ensureFreshToken();
      const current = auth.read();
      if (!token || !current) {
        status.textContent = "登录过期了，重新登录一下";
        return;
      }

      const nick = holeNick();
      const optimistic: Reply = {
        id: `local-${Date.now()}`,
        hole_id: holeId,
        content: text,
        nick,
        created_at: new Date().toISOString(),
      };

      if (inputEl) inputEl.value = "";
      replies.push(optimistic);
      render();

      try {
        const res = await fetchWithTimeout(
          `${sb!.url}/rest/v1/hole_replies`,
          {
            method: "POST",
            headers: {
              apikey: sb!.key!,
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
              Prefer: "return=minimal",
            },
            body: JSON.stringify({ hole_id: holeId, content: text, nick, author_id: current.uid }),
          },
          10000,
        );
        if (!res.ok) throw new Error(String(res.status));
      } catch {
        replies = replies.filter((r) => r.id !== optimistic.id);
        render();
        status.textContent = "回应没发出去，再试一次";
      }
    });

    render();
    void load();
  },
};
