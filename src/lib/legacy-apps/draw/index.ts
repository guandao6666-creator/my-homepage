/**
 * 每日抽奖（draw）· 对应 index.astro 原 `renderDraw` / `initDraw`。
 *
 * 依赖：localStorage `guandao.draw.v1`、`achievements.unlock`、`lifecycle.timeout`。
 * 抖动动画的 900ms 延时走 lifecycle，窗口关闭时会被清理。
 */
import type { LegacyAppModule } from "../types";
import { DRAW_BONUS, DRAW_QUOTES } from "./quotes";

const DRAW_KEY = "guandao.draw.v1";


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
            <p class="draw-text" id="draw-text">每天可以抽一张，明天再来</p>
            <button class="draw-btn" id="draw-btn" type="button">抽一张</button>
          </div>`,
  init: (win, { achievements, lifecycle }) => {
    const card = win.querySelector("#draw-card");
    const mark = win.querySelector("#draw-mark");
    const text = win.querySelector("#draw-text");
    const btn = win.querySelector("#draw-btn") as HTMLButtonElement | null;
    if (!card || !mark || !text || !btn) return;

    const today = new Date().toISOString().slice(0, 10);

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

        localStorage.setItem(DRAW_KEY, JSON.stringify({ date: today, text: content, bonus: isBonus }));
        show(content, isBonus);

        if (isBonus) achievements.unlock("draw");
      }, 900);
    });
  },
};
