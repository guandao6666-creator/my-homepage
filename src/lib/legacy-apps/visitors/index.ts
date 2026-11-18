/**
 * 访客墙（visitors）· 对应 index.astro 原 `renderVisitors` / `initVisitors`。
 *
 * 依赖：`data.supabase`、`fetchWithTimeout`、`escapeHtml`、`shell.makeId()`。
 * 无计时器 / 全局监听；`loadWall()` 的请求复用原逻辑。
 */
import type { LegacyAppModule } from "../types";
import { isAbortError } from "../net";

export const visitorsApp: LegacyAppModule = {
  id: "visitors",
  title: "访客墙",
  width: 640,
  height: 460,
  glyph: "di-wall",
  body: () => `
          <div class="wall">
            <div class="wall-head">
              <span class="wall-count" id="wall-count">正在加载…</span>
              <button class="wall-add" id="wall-add" type="button">留下我的头像</button>
            </div>
            <div class="wall-grid" id="wall-grid"></div>
            <form class="wall-form" id="wall-form" hidden>
              <input class="wall-name" id="wall-name" maxlength="16" placeholder="你的名字，最多 16 字" />
              <label class="wall-pick">
                <input type="file" id="wall-file" accept="image/*" hidden />
                <span id="wall-file-label">选一张图</span>
              </label>
              <button class="wall-submit" id="wall-submit" type="submit">上传</button>
            </form>
            <p class="wall-note" id="wall-note"></p>
          </div>`,
  init: (win, { data, escapeHtml, fetchWithTimeout, lifecycle, shell }) => {
    // P1-3：窗口关闭时取消在途请求
    const ac = lifecycle.abortController(win);
    const grid = win.querySelector("#wall-grid");
    const countEl = win.querySelector("#wall-count");
    const addBtn = win.querySelector("#wall-add");
    const form = win.querySelector("#wall-form") as HTMLFormElement | null;
    const nameInput = win.querySelector("#wall-name") as HTMLInputElement | null;
    const fileInput = win.querySelector("#wall-file") as HTMLInputElement | null;
    const fileLabel = win.querySelector("#wall-file-label");
    const submitBtn = win.querySelector("#wall-submit") as HTMLButtonElement | null;
    const note = win.querySelector("#wall-note");

    if (!grid || !countEl || !form || !nameInput || !fileInput || !submitBtn || !note) return;

    const sb = data.supabase as { url?: string; key?: string } | undefined;
    const ready = Boolean(sb?.url && sb?.key);

    const setNote = (text: string) => {
      note.textContent = text;
    };

    const renderList = (list: Array<{ name: string; avatar_url: string }>) => {
      if (!list.length) {
        countEl.textContent = "还没有人";
        grid.innerHTML = '<p class="wall-empty">墙还是空的，来做第一个。</p>';
        return;
      }
      countEl.textContent = `${list.length} 位访客`;
      grid.innerHTML = list
        .map(
          (v) => `
                  <div class="wall-item">
                    <img src="${escapeHtml(v.avatar_url)}" alt="" />
                    <span>${escapeHtml(v.name)}</span>
                  </div>`,
        )
        .join("");
    };

    const loadWall = async () => {
      if (!ready) {
        countEl.textContent = "未连接";
        grid.innerHTML =
          '<p class="wall-empty">云端还没接上，需要先在 Supabase 执行 visitors.sql。</p>';
        return;
      }

      try {
        const res = await fetchWithTimeout(
          `${sb!.url}/rest/v1/visitor_avatars?select=name,avatar_url&order=created_at.desc&limit=60`,
          { headers: { apikey: sb!.key!, Authorization: `Bearer ${sb!.key}` }, signal: ac.signal },
        );
        if (!res.ok) throw new Error(String(res.status));
        renderList(await res.json());
      } catch (error) {
        if (isAbortError(error)) return;
        countEl.textContent = "连不上";
        grid.innerHTML = '<p class="wall-empty">数据库连不上，可能是网络到不了 supabase.co。</p>';
      }
    };

    const compress = (file: File) =>
      new Promise<Blob>((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          const size = 240;
          const canvas = document.createElement("canvas");
          canvas.width = size;
          canvas.height = size;
          const ctx = canvas.getContext("2d");
          if (!ctx) return reject(new Error("no ctx"));

          const side = Math.min(img.width, img.height);
          ctx.drawImage(
            img,
            (img.width - side) / 2,
            (img.height - side) / 2,
            side,
            side,
            0,
            0,
            size,
            size,
          );

          canvas.toBlob(
            (blob) => (blob ? resolve(blob) : reject(new Error("blob"))),
            "image/webp",
            0.86,
          );
        };
        img.onerror = () => reject(new Error("img"));
        img.src = URL.createObjectURL(file);
      });

    addBtn?.addEventListener("click", () => {
      form.hidden = !form.hidden;
      if (!form.hidden) nameInput.focus();
    });

    fileInput.addEventListener("change", () => {
      const file = fileInput.files?.[0];
      if (fileLabel) fileLabel.textContent = file ? file.name.slice(0, 18) : "选一张图";
    });

    form.addEventListener("submit", async (event) => {
      event.preventDefault();

      if (!ready) {
        setNote("云端还没配好");
        return;
      }

      const name = nameInput.value.trim();
      const file = fileInput.files?.[0];

      if (name.length < 1 || name.length > 16) {
        setNote("名字写 1 到 16 个字");
        return;
      }
      if (!file) {
        setNote("先选一张图");
        return;
      }

      const lastKey = "guandao.wall.last";
      const last = Number(localStorage.getItem(lastKey) ?? 0);
      if (Date.now() - last < 86_400_000) {
        setNote("一天只能留一次，明天再来");
        return;
      }

      submitBtn.disabled = true;
      submitBtn.textContent = "上传中…";

      try {
        const blob = await compress(file);
        const key = `${shell.makeId()}.webp`;

        const up = await fetchWithTimeout(`${sb!.url}/storage/v1/object/visitors/${key}`, {
          method: "POST",
          headers: {
            apikey: sb!.key!,
            Authorization: `Bearer ${sb!.key}`,
            "Content-Type": "image/webp",
            "x-upsert": "false",
          },
          body: blob,
        });
        if (!up.ok) throw new Error(`upload ${up.status}`);

        const publicUrl = `${sb!.url}/storage/v1/object/public/visitors/${key}`;

        const ins = await fetchWithTimeout(`${sb!.url}/rest/v1/visitor_avatars`, {
          method: "POST",
          headers: {
            apikey: sb!.key!,
            Authorization: `Bearer ${sb!.key}`,
            "Content-Type": "application/json",
            Prefer: "return=minimal",
          },
          body: JSON.stringify({ name, avatar_url: publicUrl }),
        });
        if (!ins.ok) throw new Error(`insert ${ins.status}`);

        localStorage.setItem(lastKey, String(Date.now()));
        form.reset();
        form.hidden = true;
        if (fileLabel) fileLabel.textContent = "选一张图";
        setNote("已经挂上墙了");
        await loadWall();
      } catch {
        setNote("上传失败，稍后再试");
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = "上传";
      }
    });

    void loadWall();
  },
};
