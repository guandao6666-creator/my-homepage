/**
 * Guandao OS 1.4 · Guandao Music
 *
 * 播放项目内置音频 + 用户自己导入的音频。
 * 不内置、不下载任何未授权的商业音乐。
 */

import { escapeHtml, fmtBytes, pickFile, type Ctx } from "../core";
import { coverGradient, fmtTime, music, type PlayerSnapshot } from "../music-core";

export const renderMusic = () => `
  <div class="mu14" data-mu14>
    <section class="mu14-player">
      <div class="mu14-cover" data-mu-cover><span data-mu-cover-ico>♫</span></div>
      <div class="mu14-info">
        <h3 data-mu-title>还没有曲目</h3>
        <p data-mu-artist>从下方导入本地音频开始</p>
      </div>
      <div class="mu14-progress" data-mu-progress>
        <span class="mu14-time" data-mu-cur>0:00</span>
        <div class="mu14-track"><i data-mu-bar></i><b data-mu-knob></b></div>
        <span class="mu14-time" data-mu-dur>0:00</span>
      </div>
      <div class="mu14-controls">
        <button type="button" data-mu-shuffle title="随机播放">⤨</button>
        <button type="button" data-mu-prev title="上一首">⏮</button>
        <button type="button" class="mu14-play" data-mu-play title="播放 / 暂停">▶</button>
        <button type="button" data-mu-next title="下一首">⏭</button>
        <button type="button" data-mu-repeat title="循环模式">↻</button>
      </div>
      <div class="mu14-vol">
        <span>音量</span>
        <input type="range" min="0" max="100" data-mu-vol value="70" />
        <b data-mu-volnum>70%</b>
      </div>
    </section>
    <section class="mu14-list">
      <header class="mu14-list-head">
        <div><b>播放列表</b><span data-mu-count></span></div>
        <button class="g14-btn" type="button" data-mu-import>＋ 导入音频</button>
      </header>
      <div class="mu14-rows" data-mu-rows></div>
      <p class="mu14-note">导入的音频会保存在浏览器 IndexedDB 中，只在本机可听；项目内置曲目来自 <code>/public/music</code>。</p>
    </section>
  </div>`;

export const initMusic = (win: HTMLElement, ctx: Ctx): (() => void) => {
  const root = win.querySelector<HTMLElement>("[data-mu14]");
  if (!root) return () => undefined;
  const rowsEl = root.querySelector<HTMLElement>("[data-mu-rows]");
  const bar = root.querySelector<HTMLElement>("[data-mu-bar]");
  const trackEl = root.querySelector<HTMLElement>(".mu14-track");

  const paint = (s: PlayerSnapshot) => {
    const cover = root.querySelector<HTMLElement>("[data-mu-cover]");
    const title = root.querySelector<HTMLElement>("[data-mu-title]");
    const artist = root.querySelector<HTMLElement>("[data-mu-artist]");
    const cur = root.querySelector<HTMLElement>("[data-mu-cur]");
    const dur = root.querySelector<HTMLElement>("[data-mu-dur]");
    const play = root.querySelector<HTMLElement>("[data-mu-play]");
    const vol = root.querySelector<HTMLInputElement>("[data-mu-vol]");
    const volNum = root.querySelector<HTMLElement>("[data-mu-volnum]");
    const count = root.querySelector<HTMLElement>("[data-mu-count]");
    if (title) title.textContent = s.track?.title ?? "还没有曲目";
    if (artist) artist.textContent = s.track ? `${s.track.artist}${s.track.imported ? " · 本地导入" : ""}` : "从下方导入本地音频开始";
    if (cover && s.track) cover.style.background = coverGradient(s.track.title);
    if (bar) bar.style.width = `${s.duration ? (s.time / s.duration) * 100 : 0}%`;
    if (cur) cur.textContent = fmtTime(s.time);
    if (dur) dur.textContent = fmtTime(s.duration);
    if (play) play.textContent = s.playing ? "❚❚" : "▶";
    if (vol) vol.value = String(Math.round(s.volume * 100));
    if (volNum) volNum.textContent = `${Math.round(s.volume * 100)}%`;
    if (count) count.textContent = `${s.tracks.length} 首`;
    const shuffle = root.querySelector<HTMLElement>("[data-mu-shuffle]");
    if (shuffle) shuffle.classList.toggle("is-on", s.shuffle);
    const repeat = root.querySelector<HTMLElement>("[data-mu-repeat]");
    if (repeat) {
      repeat.textContent = s.repeat === "one" ? "↻1" : s.repeat === "all" ? "↻" : "→";
      repeat.classList.toggle("is-on", s.repeat !== "off");
    }

    if (rowsEl) {
      rowsEl.innerHTML = s.tracks.length
        ? s.tracks
            .map(
              (t, i) => `<div class="mu14-row ${i === s.index ? "is-playing" : ""}" data-mu-row="${i}">
                <span class="mu14-num">${i === s.index && s.playing ? "▮▮" : String(i + 1).padStart(2, "0")}</span>
                <span class="mu14-rtitle">${escapeHtml(t.title)}<i>${escapeHtml(t.artist)}</i></span>
                <span class="mu14-rsize">${t.size ? fmtBytes(t.size) : t.src ? "内置" : "—"}</span>
                ${t.imported ? `<button class="mu14-del" type="button" data-mu-del="${escapeHtml(t.id)}" title="移除">×</button>` : ""}
              </div>`,
            )
            .join("")
        : `<div class="mu14-empty">播放列表是空的，点右上角导入音频。</div>`;
    }
  };

  const un = music.subscribe(paint);

  win.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    if (t.closest("[data-mu-play]")) return music.toggle();
    if (t.closest("[data-mu-next]")) {
      void music.next();
      return;
    }
    if (t.closest("[data-mu-prev]")) {
      void music.prev();
      return;
    }
    if (t.closest("[data-mu-shuffle]")) {
      music.toggleShuffle();
      return;
    }
    if (t.closest("[data-mu-repeat]")) {
      const cur = music.snapshot().repeat;
      music.setRepeat(cur === "all" ? "one" : cur === "one" ? "off" : "all");
      return;
    }
    if (t.closest("[data-mu-import]")) {
      pickFile("audio/*", true, async (files) => {
        const n = await music.addFiles(files);
        ctx.toast(n ? `已导入 ${n} 首音频` : "没有可导入的音频（单曲需小于 40MB）");
      });
      return;
    }
    const del = t.closest<HTMLElement>("[data-mu-del]");
    if (del) {
      e.stopPropagation();
      void music.removeTrack(del.dataset.muDel ?? "");
      return;
    }
    const row = t.closest<HTMLElement>("[data-mu-row]");
    if (row) {
      void music.play(Number(row.dataset.muRow));
    }
  });

  root.querySelector<HTMLElement>("[data-mu-progress]")?.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    if (target.closest("[data-mu-knob]")) return;
    if (!trackEl) return;
    const rect = trackEl.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const dur = music.snapshot().duration;
    if (dur) void music.seek(ratio * dur);
  });

  root.querySelector<HTMLInputElement>("[data-mu-vol]")?.addEventListener("input", (e) => {
    music.setVolume(Number((e.target as HTMLInputElement).value) / 100);
  });

  return () => {
    un();
    music.pause();
  };
};
