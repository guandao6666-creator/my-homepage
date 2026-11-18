/**
 * 社会网络（social）· 对应 index.astro 原 `renderSocial` / `initSocial`。
 *
 * 依赖：`data.supabase`、`fetchWithTimeout`、`escapeHtml`、`safeUrl`、
 * `auth`（登录态 / 表单 / 续期 / 退出 / 变更广播）。
 * 关注关系写 follows 表，资料写 profiles 表（on_conflict=id），全部复用原请求逻辑。
 */
import type { LegacyAppModule, LegacyAuthState } from "../types";
import { safeUrl } from "../../html";

const SOCIAL_AVATARS: Record<string, string> = {
  whale: "/pet/whale-girl.webp",
  tshirt: "/pet/tshirt.webp",
  hoodie: "/pet/hoodie.webp",
  suit: "/pet/suit.webp",
  pajamas: "/pet/pajamas.webp",
  swimsuit: "/pet/swimsuit.webp",
  yukata: "/pet/yukata.webp",
  uniform: "/pet/uniform.webp",
};

const socialRole = (createdAt: string) => {
  const days = Math.floor((Date.now() - new Date(createdAt).getTime()) / 86400000);
  if (days < 1) return "刚来";
  if (days < 7) return "新面孔";
  if (days < 30) return "常客";
  return "老熟人";
};

export const socialApp: LegacyAppModule = {
  id: "social",
  title: "社会网络",
  width: 560,
  height: 600,
  glyph: "di-net",
  body: () => `
          <div class="social">
            <div class="social-me" id="social-me"></div>
            <div class="social-head">
              <span class="social-count" id="social-count">正在加载…</span>
              <span class="social-tip">认识一下常来的人</span>
            </div>
            <div class="social-list" id="social-list"></div>
          </div>`,
  init: (win, { data, escapeHtml, fetchWithTimeout, auth, lifecycle }) => {
    const meEl = win.querySelector("#social-me");
    const listEl = win.querySelector("#social-list");
    const countEl = win.querySelector("#social-count");
    if (!meEl || !listEl || !countEl) return;

    const sb = data.supabase as { url?: string; key?: string } | undefined;
    const ready = Boolean(sb?.url && sb?.key);
    let session: LegacyAuthState | null = auth.read();

    interface Person {
      id: string;
      nickname: string;
      avatar: string;
      bio: string;
      created_at: string;
      last_seen: string;
    }

    let me: Person | null = null;
    let people: Person[] = [];
    let following = new Set<string>();
    let editing = false;

    const headers = (extra: Record<string, string> = {}) => {
      // 每次都重新读，续期之后能立刻拿到新 token
      const cur = auth.read();
      return {
        apikey: sb!.key!,
        Authorization: `Bearer ${cur ? cur.token : sb!.key}`,
        ...extra,
      };
    };

    const renderMe = () => {
      if (!session) {
        meEl.innerHTML = auth.formHtml();
        return;
      }

      if (editing) {
        const avatarBtns = Object.entries(SOCIAL_AVATARS)
          .map(
            ([key, src]) => `
                    <button class="social-pick ${me?.avatar === key ? "is-on" : ""}" type="button" data-avatar="${key}">
                      <img src="${safeUrl(src)}" alt="" />
                    </button>`,
          )
          .join("");

        meEl.innerHTML = `
                <form class="social-form" id="social-form">
                  <div class="social-picks" id="social-picks">${avatarBtns}</div>
                  <input class="social-input" id="social-name" maxlength="16" placeholder="昵称（1–16 字）" value="${escapeHtml(me?.nickname ?? "")}" />
                  <input class="social-input" id="social-bio" maxlength="80" placeholder="一句话介绍自己（可不填）" value="${escapeHtml(me?.bio ?? "")}" />
                  <div class="social-form-bar">
                    <button class="social-cancel" type="button" id="social-cancel">算了</button>
                    <button class="social-save" type="submit">保存</button>
                  </div>
                </form>`;
        return;
      }

      const src = SOCIAL_AVATARS[me?.avatar ?? "whale"] ?? SOCIAL_AVATARS.whale;

      meEl.innerHTML = `
              <div class="social-card">
                <img class="social-face" src="${safeUrl(src)}" alt="" />
                <div class="social-info">
                  <p class="social-name">${escapeHtml(me?.nickname ?? "还没起名字")}</p>
                  <p class="social-bio">${escapeHtml(me?.bio || "这个人很懒，什么都没写")}</p>
                  <p class="social-meta">
                    <span class="social-role">${me ? socialRole(me.created_at) : "新面孔"}</span>
                    <span>关注 ${following.size}</span>
                  </p>
                </div>
                <div class="social-card-btns">
                  <button class="social-edit" type="button" id="social-edit">${me ? "改" : "起名"}</button>
                  <button class="social-edit is-quiet" type="button" id="social-signout">退出</button>
                </div>
              </div>`;
    };

    const renderList = () => {
      const others = people.filter((p) => p.id !== (session ? session.uid : ""));

      if (!others.length) {
        listEl.innerHTML = '<p class="social-empty">还没有别的访客留下名字。</p>';
        countEl.textContent = "0 位访客";
        return;
      }

      countEl.textContent = `${others.length} 位访客`;

      listEl.innerHTML = others
        .map((p) => {
          const src = SOCIAL_AVATARS[p.avatar] ?? SOCIAL_AVATARS.whale;
          const isFollowing = following.has(p.id);
          return `
                  <div class="social-row">
                    <img class="social-row-face" src="${safeUrl(src)}" alt="" />
                    <div class="social-row-info">
                      <p class="social-row-name">${escapeHtml(p.nickname)}</p>
                      <p class="social-row-bio">${escapeHtml(p.bio || "没写介绍")}</p>
                    </div>
                    <span class="social-row-role">${socialRole(p.created_at)}</span>
                    <button class="social-follow ${isFollowing ? "is-on" : ""}" type="button" data-follow="${p.id}">
                      ${isFollowing ? "已关注" : "关注"}
                    </button>
                  </div>`;
        })
        .join("");
    };

    const signOut = () => {
      auth.signOut();
      session = null;
      me = null;
      following = new Set();
      renderMe();
      renderList();
      countEl.textContent = "已退出";
    };

    const load = async () => {
      if (!ready) {
        countEl.textContent = "云端没接上";
        return;
      }

      try {
        // 我的资料
        const meRes = await fetchWithTimeout(
          `${sb!.url}/rest/v1/profiles?id=eq.${encodeURIComponent(session ? session.uid : "")}&select=*`,
          { headers: headers() },
          8000,
        );
        if (meRes.ok) {
          const rows = (await meRes.json()) as Person[];
          me = rows[0] ?? null;
        }

        // 所有人
        const pRes = await fetchWithTimeout(
          `${sb!.url}/rest/v1/profiles?select=*&order=last_seen.desc&limit=50`,
          { headers: headers() },
          10000,
        );
        if (pRes.ok) people = (await pRes.json()) as Person[];

        // 我关注了谁
        const fRes = await fetchWithTimeout(
          `${sb!.url}/rest/v1/follows?select=to_id&from_id=eq.${encodeURIComponent(session ? session.uid : "")}`,
          { headers: headers() },
          8000,
        );
        if (fRes.ok) {
          const rows = (await fRes.json()) as Array<{ to_id: string }>;
          following = new Set(rows.map((r) => r.to_id));
        }

        renderMe();
        renderList();
      } catch {
        countEl.textContent = "连不上，关掉重开试试";
      }
    };

    const saveProfile = async (nickname: string, bio: string, avatar: string) => {
      if (!ready) return;

      await auth.ensureFreshToken();
      session = auth.read();
      if (!session) {
        countEl.textContent = "登录过期了，重新登录一下";
        renderMe();
        return;
      }

      const body = {
        id: session.uid,
        nickname,
        bio,
        avatar,
        last_seen: new Date().toISOString(),
      };

      try {
        await fetchWithTimeout(
          `${sb!.url}/rest/v1/profiles?on_conflict=id`,
          {
            method: "POST",
            headers: headers({
              "Content-Type": "application/json",
              Prefer: "resolution=merge-duplicates,return=minimal",
            }),
            body: JSON.stringify(body),
          },
          10000,
        );

        me = {
          ...(me ?? { created_at: new Date().toISOString() }),
          ...body,
        } as Person;
        editing = false;
        renderMe();
        renderList();
        countEl.textContent = "资料已保存";
      } catch {
        countEl.textContent = "保存失败，再试一次";
      }
    };

    const toggleFollow = async (toId: string) => {
      if (!ready) return;

      await auth.ensureFreshToken();
      session = auth.read();
      if (!session) {
        countEl.textContent = "登录过期了，重新登录一下";
        renderMe();
        return;
      }

      const on = following.has(toId);

      // 先改界面
      if (on) following.delete(toId);
      else following.add(toId);
      renderMe();
      renderList();

      try {
        if (on) {
          await fetchWithTimeout(
            `${sb!.url}/rest/v1/follows?from_id=eq.${encodeURIComponent(session ? session.uid : "")}&to_id=eq.${encodeURIComponent(toId)}`,
            { method: "DELETE", headers: headers({ Prefer: "return=minimal" }) },
            8000,
          );
        } else {
          await fetchWithTimeout(
            `${sb!.url}/rest/v1/follows`,
            {
              method: "POST",
              headers: headers({ "Content-Type": "application/json", Prefer: "return=minimal" }),
              body: JSON.stringify({ from_id: session ? session.uid : "", to_id: toId }),
            },
            8000,
          );
        }
      } catch {
        // 回滚
        if (on) following.add(toId);
        else following.delete(toId);
        renderMe();
        renderList();
        countEl.textContent = "操作没成功，再试一次";
      }
    };

    // 事件：编辑 / 保存 / 选头像 / 关注
    win.addEventListener("click", (event) => {
      const target = event.target as HTMLElement;

      if (target.closest("#social-signout")) {
        signOut();
        return;
      }

      if (target.closest("#social-edit")) {
        editing = true;
        renderMe();
        return;
      }

      if (target.closest("#social-cancel")) {
        editing = false;
        renderMe();
        return;
      }

      const pick = target.closest<HTMLElement>(".social-pick");
      if (pick) {
        const key = pick.dataset.avatar;
        if (!key) return;
        meEl.querySelectorAll(".social-pick").forEach((el) => el.classList.remove("is-on"));
        pick.classList.add("is-on");
        return;
      }

      const followBtn = target.closest<HTMLElement>(".social-follow");
      if (followBtn) {
        const id = followBtn.dataset.follow;
        if (id) void toggleFollow(id);
      }
    });

    win.addEventListener("submit", (event) => {
      const form = event.target as HTMLFormElement;

      if (!form.classList.contains("social-form")) return;
      event.preventDefault();

      const name = win.querySelector<HTMLInputElement>("#social-name")?.value.trim() ?? "";
      const bio = win.querySelector<HTMLInputElement>("#social-bio")?.value.trim() ?? "";
      const avatar = meEl.querySelector<HTMLElement>(".social-pick.is-on")?.dataset.avatar ?? "whale";

      if (!name) return;
      void saveProfile(name, bio, avatar);
    });

    // 登录状态变了（比如在这个窗口切号），重新读身份并拉数据
    auth.onChange(win, () => {
      session = auth.read();
      void load();
    });

    void load();
  },
};
