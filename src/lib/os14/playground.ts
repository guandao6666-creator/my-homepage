/**
 * Guandao OS 1.4 · 游乐场
 *
 * 游戏中心（7 款公开 + 1 款隐藏）、桌面互动设置、彩蛋墙。
 * 每个游戏的循环都由自己的 destroy 负责收尾，关窗即停。
 */

import { badge, emptyState, escapeHtml, fmtAgo, ls, shell, type Ctx } from "./core";
import { GAMES, gameById, gameCover, type GameHandle } from "./games";
import {
  addDecoration,
  confetti,
  decoKinds,
  decoList,
  EGGS,
  foundEggs,
  petState,
  setPetName,
  setPetSize,
  setPetVisible,
} from "./desktop";

let ctxRef: Ctx | null = null;
let tab = "games";
let activeGame = "";
let handle: GameHandle | null = null;
let paused = false;
let liveScore = 0;
let scoreLabel = "";

const REC_KEY = "guandao.os14.games.v1";

type Record0 = { score: number; at: number; extra?: Record<string, unknown> };
type GameRecords = { v: 1; best: Record<string, Record0>; plays: Record<string, number> };

const readRec = (): GameRecords => ls.get<GameRecords>(REC_KEY, { v: 1, best: {}, plays: {} });
const writeRec = (r: GameRecords) => ls.set(REC_KEY, r);

const bestOf = (id: string) => readRec().best[id];

const isBetter = (id: string, score: number) => {
  const g = gameById(id);
  const best = bestOf(id);
  if (!best) return true;
  return g?.lowerBetter ? score < best.score : score > best.score;
};

/* ============================================================
   游戏库
   ============================================================ */

const gameCard = (g: (typeof GAMES)[number]) => {
  const best = bestOf(g.id);
  return `
    <article class="pg14-game" data-play="${g.id}" style="--gt:${g.tint}">
      ${gameCover(g.id)}
      <div class="pg14-game-body">
        <h4>${escapeHtml(g.title)}</h4>
        <p>${escapeHtml(g.desc)}</p>
        <div class="pg14-game-foot">
          <span>${best ? `最高 ${best.score} ${g.scoreLabel}` : "还没有记录"}</span>
          <button class="g14-btn is-primary" type="button" data-play="${g.id}">开始</button>
        </div>
      </div>
    </article>`;
};

const libraryView = () => `
  <div class="g14-scroll">
    <div class="pg14-hero">
      <div>
        <span class="pg14-kicker">Guandao Playground</span>
        <h2>玩一会儿，再干活</h2>
        <p>七款小游戏都能真的玩，得分与最高纪录会记住。分数保存在本机浏览器里。</p>
      </div>
      <div class="pg14-hero-art">✦</div>
    </div>
    <div class="g14-app-grid is-wide">
      ${GAMES.filter((g) => !g.hidden).map(gameCard).join("")}
    </div>
    <p class="g14-hint">提示：彩蛋里还藏着一个不在这里列出的游戏。</p>
  </div>`;

/* ============================================================
   游戏舞台
   ============================================================ */

const stageView = () => {
  const g = gameById(activeGame);
  if (!g) return libraryView();
  const best = bestOf(g.id);
  return `
    <div class="pg14-stage">
      <header class="pg14-stage-head">
        <button class="g14-btn is-ghost" type="button" data-pg-back>← 返回</button>
        <div class="pg14-stage-title"><b>${escapeHtml(g.title)}</b><span>${escapeHtml(g.hint)}</span></div>
        <div class="pg14-stage-score">
          <span>本局 <b data-live>${liveScore}</b> ${escapeHtml(scoreLabel || g.scoreLabel)}</span>
          <span>最高 <b>${best ? best.score : "—"}</b></span>
        </div>
        <div class="pg14-stage-acts">
          <button class="g14-btn" type="button" data-pg-pause>${paused ? "继续" : "暂停"}</button>
          <button class="g14-btn" type="button" data-pg-restart>重新开始</button>
        </div>
      </header>
      <div class="pg14-host" data-pg-host></div>
      <div class="pg14-pause" data-pg-paused ${paused ? "" : "hidden"}><span>已暂停</span></div>
    </div>`;
};

/* ============================================================
   互动
   ============================================================ */

const interactView = () => {
  const pet = petState();
  const decos = decoList();
  return `
    <div class="g14-scroll">
      <div class="g14-pane-head"><h3>桌面互动</h3><p>都是轻量的装饰，不会挡住窗口操作。</p></div>
      <section class="pg14-block">
        <h4>像素小动物「小管」</h4>
        <p class="pg14-block-sub">会自己在桌面上走动、眨眼，点它会说话，长按可以拖动；双击打开游乐场。</p>
        <div class="pg14-petrow">
          <span class="pg14-petprev">${`<span class="pet14-mini" data-mood="idle"></span>`}</span>
          <label class="g14-range-row"><span>显示</span><input type="checkbox" data-pet-on ${pet.on ? "checked" : ""}/></label>
          <label class="pf-field">名字<input class="g14-input" data-pet-name maxlength="8" value="${escapeHtml(pet.name)}" /></label>
          <label class="g14-range-row"><span>大小</span><input type="range" min="70" max="160" value="${Math.round(pet.size * 100)}" data-pet-size /><b>${Math.round(pet.size * 100)}%</b></label>
        </div>
      </section>
      <section class="pg14-block">
        <h4>可拖动装饰物</h4>
        <p class="pg14-block-sub">放在桌面上的小东西，拖动改位置，双击收回。</p>
        <div class="pg14-decos">
          ${Object.entries(decoKinds)
            .map(([kind, d]) => `<button class="pg14-deco" type="button" data-deco-add="${kind}"><span>${d.art}</span>${escapeHtml(d.label)}</button>`)
            .join("")}
        </div>
        <p class="g14-hint">当前桌面有 ${decos.length} 个装饰物。</p>
      </section>
      <section class="pg14-block">
        <h4>点击反馈</h4>
        <p class="pg14-block-sub">点击桌面空白会有一圈涟漪；连续点击十次会触发一个小彩蛋。</p>
        <button class="g14-btn" type="button" data-pg-confetti>放一次彩带</button>
      </section>
    </div>`;
};

/* ============================================================
   彩蛋
   ============================================================ */

const eggsView = () => {
  const found = foundEggs();
  const n = Object.keys(found).length;
  return `
    <div class="g14-scroll">
      <div class="g14-pane-head"><h3>彩蛋</h3><p>已发现 ${n} / ${EGGS.length}。没发现的只给一句提示，不影响正常使用。</p></div>
      <div class="pg14-egg-progress"><i style="width:${(n / EGGS.length) * 100}%"></i></div>
      <div class="pg14-eggs">
        ${EGGS.map((e) => {
          const at = found[e.id];
          return `<article class="pg14-egg ${at ? "is-found" : ""}">
            <span class="pg14-egg-ico">${at ? "✧" : "?"}</span>
            <div><b>${at ? escapeHtml(e.title) : "未发现"}</b><p>${escapeHtml(e.hint)}</p>
            ${at ? `<span class="pg14-egg-at">${fmtAgo(at)}发现</span>` : ""}</div>
          </article>`;
        }).join("")}
      </div>
      ${
        found.ember
          ? `<div class="pg14-hintbox">你已经解锁了隐藏游戏「余烬」。<button class="g14-link" type="button" data-play="ember">直接进入 →</button></div>`
          : `<p class="g14-hint">有些彩蛋需要键盘，有些需要等一个特定的时间。</p>`
      }
    </div>`;
};

const view = () => {
  if (tab === "interact") return interactView();
  if (tab === "eggs") return eggsView();
  return activeGame ? stageView() : libraryView();
};

export const renderPlayground = () => {
  const nav: Array<[string, string, string]> = [
    ["games", "游戏中心", "✦"],
    ["interact", "桌面互动", "❀"],
    ["eggs", "彩蛋", "✧"],
  ];
  return shell("playground", nav, `<div class="pg14-host-root" data-pg-root></div>`, "游乐场");
};

export const initPlayground = (win: HTMLElement, ctx: Ctx): (() => void) => {
  ctxRef = ctx;
  tab = "games";
  activeGame = "";
  paused = false;
  liveScore = 0;

  const root = win.querySelector<HTMLElement>("[data-pg-root]");
  if (!root) return () => undefined;

  const paint = () => {
    root.innerHTML = view();
    if (activeGame && tab === "games") mountGame();
  };

  const destroyGame = () => {
    try {
      handle?.destroy();
    } catch {
      /* 忽略 */
    }
    handle = null;
  };

  const mountGame = () => {
    const g = gameById(activeGame);
    const host = root.querySelector<HTMLElement>("[data-pg-host]");
    if (!g || !host) return;
    destroyGame();
    paused = false;
    liveScore = 0;
    scoreLabel = g.scoreLabel;
    handle = g.mount(host, {
      setScore: (score, label) => {
        liveScore = score;
        if (label) scoreLabel = label;
        const el = root.querySelector<HTMLElement>("[data-live]");
        if (el) el.textContent = String(score);
      },
      setStatus: (text) => {
        const sub = root.querySelector<HTMLElement>(".pg14-stage-title span");
        if (sub && text) sub.textContent = text;
      },
      gameOver: (score, extra) => {
        const rec = readRec();
        rec.plays[g.id] = (rec.plays[g.id] ?? 0) + 1;
        const better = isBetter(g.id, score);
        if (better) rec.best[g.id] = { score, at: Date.now(), extra };
        writeRec(rec);
        ctx.pushNotif({
          icon: "✦",
          title: better ? `「${g.title}」新纪录` : `「${g.title}」本局结束`,
          body: better ? `得分 ${score} ${g.scoreLabel}，去游乐场看看。` : `得分 ${score} ${g.scoreLabel}。`,
        });
        const scoreEl = root.querySelector<HTMLElement>("[data-live]");
        if (scoreEl) scoreEl.textContent = String(score);
        if (better) confetti(14);
      },
    });
  };

  const start = (id: string) => {
    const g = gameById(id);
    if (!g) return;
    activeGame = id;
    paused = false;
    tab = "games";
    win.querySelectorAll(".g14-nav").forEach((n) => n.classList.toggle("is-active", (n as HTMLElement).dataset.tab === "games"));
    paint();
  };

  win.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const play = t.closest<HTMLElement>("[data-play]");
    if (play) {
      start(play.dataset.play ?? "");
      return;
    }
    if (t.closest("[data-pg-back]")) {
      destroyGame();
      paused = false;
      activeGame = "";
      paint();
      return;
    }
    if (t.closest("[data-pg-restart]")) {
      destroyGame();
      paused = false;
      paint();
      return;
    }
    if (t.closest("[data-pg-pause]")) {
      paused = !paused;
      if (paused) handle?.pause?.();
      else handle?.resume?.();
      const btn = root.querySelector<HTMLElement>("[data-pg-pause]");
      if (btn) btn.textContent = paused ? "继续" : "暂停";
      const cover = root.querySelector<HTMLElement>("[data-pg-paused]");
      if (cover) cover.hidden = !paused;
      return;
    }
    const deco = t.closest<HTMLElement>("[data-deco-add]");
    if (deco) {
      addDecoration(deco.dataset.decoAdd ?? "");
      paint();
      return;
    }
    if (t.closest("[data-pg-confetti]")) {
      confetti(28);
      return;
    }
  });

  win.addEventListener("input", (e) => {
    const t = e.target as HTMLElement;
    if (t.matches("[data-pet-name]")) setPetName((t as HTMLInputElement).value);
    if (t.matches("[data-pet-size]")) {
      setPetSize(Number((t as HTMLInputElement).value) / 100);
      const label = t.parentElement?.querySelector("b");
      if (label) label.textContent = `${(t as HTMLInputElement).value}%`;
    }
  });

  win.addEventListener("change", (e) => {
    const t = e.target as HTMLElement;
    if (t.matches("[data-pet-on]")) setPetVisible((t as HTMLInputElement).checked);
  });

  // 隐藏游戏入口（终端 `play` 或桌宠彩蛋）
  const onPlay = (ev: Event) => {
    const id = (ev as CustomEvent<{ game?: string }>).detail?.game;
    if (id) start(id);
  };
  window.addEventListener("guandao:play", onPlay);

  const onEgg = () => {
    if (tab === "eggs") paint();
  };
  document.addEventListener("guandao:egg", onEgg);

  paint();

  return () => {
    destroyGame();
    window.removeEventListener("guandao:play", onPlay);
    document.removeEventListener("guandao:egg", onEgg);
  };
};

export const gameRecords = readRec;
export const gameBadge = (id: string) => {
  const best = bestOf(id);
  return best ? badge(`最高 ${best.score}`, "mute") : "";
};
export const gamesEmpty = emptyState;
