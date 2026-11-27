/**
 * 每日抽奖（draw）· 对应 index.astro 原 `renderDraw` / `initDraw`。
 *
 * 依赖：localStorage `guandao.draw.v1`、`achievements.unlock`、`lifecycle.timeout`。
 * 抖动动画的 900ms 延时走 lifecycle，窗口关闭时会被清理。
 */
import type { LegacyAppModule } from "../types";
import { DRAW_BONUS, DRAW_QUOTES } from "./quotes";

const DRAW_KEY = "guandao.draw.v1";

/**
 * 本地日历日（yyyy-mm-dd）。
 *
 * 抽奖按「本机日历日」重置。以前用 `toISOString()` 取的是 UTC 日：
 * 东八区 00:00–08:00 会被当成前一天，用户可在本地零点后再抽一次、
 * 08:00 才真正重置。这里改成取本地日期分量，和任务/日历用的是同一套口径。
 */
export const drawDateKey = (now: Date = new Date()): string =>
  `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

export const drawApp: LegacyAppModule = {
  id: "draw",
  title: "每日抽奖",
  width: 440,
  height: 420,
  glyph: "di-draw",
  body: () => `
          <div class="draw">
            <div class="draw-card" id="draw-card">
              <span class="draw-mark" id="draw-mark">?</span>
            </div>
            <p class="draw-text" id="draw-text">每天可以抽一张</p>
            <button class="draw-btn" id="draw-btn" type="button">抽一张</button>
          </div>`,
  init: (win, { achievements, lifecycle }) => {
    const card = win.querySelector("#draw-card");
    const mark = win.querySelector("#draw-mark");
    const text = win.querySelector("#draw-text");
    const btn = win.querySelector("#draw-btn") as HTMLButtonElement | null;
    if (!card || !mark || !text || !btn) return;

    // 打开窗口时先看今天（本地日）是否已经抽过
    const today = drawDateKey();

    const show = (content: string, isBonus: boolean) => {
      mark.textContent = isBonus ? "★" : "“";
      text.textContent = content;
      card.classList.toggle("is-bonus", isBonus);
      btn.disabled = true;
      btn.textContent = "明天再来";
    };

    try {
      const saved = JSON.parse(localStorage.getItem(DRAW_KEY) || "null");
      if (saved && saved.date === today) {
        show(saved.text, Boolean(saved.bonus));
        return;
      }
    } catch {
      /* 记录坏了就重抽 */
    }

    btn.addEventListener("click", () => {
      btn.disabled = true;
      btn.textContent = "抽取中…";
      card.classList.add("is-shaking");

      lifecycle.timeout(win, () => {
        card.classList.remove("is-shaking");

        const isBonus = Math.random() < 0.1;
        const content = isBonus ? DRAW_BONUS : DRAW_QUOTES[Math.floor(Math.random() * DRAW_QUOTES.length)];

        // 用「点下去这一刻」的本地日：窗口跨过零点还开着时，不能把昨天的日期写进去
        // （否则第二天重开窗口会再抽一次）
        localStorage.setItem(DRAW_KEY, JSON.stringify({ date: drawDateKey(), text: content, bonus: isBonus }));
        show(content, isBonus);

        if (isBonus) achievements.unlock("draw");
      }, 900);
    });
  },
};
