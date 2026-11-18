/**
 * 水族箱（aquarium）· 对应 index.astro 原 `renderAquarium` / `initAquarium`。
 *
 * 依赖：`desktopFacilities.phase()`（按时辰决定水色与文案）、
 * `lifecycle`（60s 相位 watcher、2.3s 瞌睡泡、投喂 820/1700/3100ms 延时）。
 * 原实现在回调里用 `document.body.contains` 自清，迁移后统一由 lifecycle.dispose 清理。
 */
import type { LegacyAppModule } from "../types";

const AI_FISH = [
  { id: "chatgpt", name: "ChatGPT" },
  { id: "deepseek", name: "DeepSeek" },
  { id: "claude", name: "Claude" },
  { id: "grok", name: "Grok" },
  { id: "gemini", name: "Gemini" },
  { id: "wenxin", name: "文心一言" },
  { id: "qwen", name: "千问" },
];

const PHASE_TEXT: Record<string, string> = {
  dawn: "天刚亮，它们醒过来了 · 点水里投喂",
  day: "点水里投喂 · 七只都在",
  dusk: "日头下去了，游得慢些",
  night: "熄灯了，它们都安静下来",
};

export const aquariumApp: LegacyAppModule = {
  id: "aquarium",
  title: "水族箱",
  width: 720,
  height: 480,
  glyph: "di-tank",
  body: ({ desktopFacilities }) => {
    const phase = desktopFacilities.phase();

    const fish = AI_FISH.map(
      (ai, i) => `
              <div class="fish" data-ai="${ai.id}"
                style="--bg: url(/aquarium/${ai.id}.webp); --delay: ${-i * 1.3}s; left: ${5 + i * 12.5}%; top: ${16 + (i % 3) * 24}%">
                <span class="fish-name">${ai.name}</span>
              </div>`,
    ).join("");

    const bubbles = Array.from(
      { length: 10 },
      (_, i) =>
        `<span class="bubble" style="--size: ${4 + (i % 3) * 3}px; --dur: ${9 + i * 1.3}s; --delay: ${-i * 1.6}s; left: ${6 + i * 9}%"></span>`,
    ).join("");

    return `
            <div class="tank" id="tank" data-phase="${phase}">
              <div class="bubbles">${bubbles}</div>
              <div class="tank-floor"></div>
              <div class="fish-layer" id="fish-layer">${fish}</div>
              <p class="tank-hint" id="tank-hint">${PHASE_TEXT[phase]}</p>
            </div>`;
  },
  init: (win, { desktopFacilities, lifecycle }) => {
    const tank = win.querySelector("#tank") as HTMLElement | null;
    const layer = win.querySelector("#fish-layer");
    const hint = win.querySelector("#tank-hint");
    if (!tank || !layer || !hint) return;

    let fed = 0;

    tank.addEventListener("click", (event) => {
      const rect = tank.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;

      const food = document.createElement("span");
      food.className = "food";
      food.style.left = `${x}px`;
      food.style.top = `${y}px`;
      tank.appendChild(food);

      lifecycle.timeout(win, () => {
        food.remove();

        const fishes = Array.from(layer.querySelectorAll<HTMLElement>(".fish"));
        const target = fishes[Math.floor(Math.random() * fishes.length)];

        if (target) {
          const heart = document.createElement("span");
          heart.className = "heart";
          heart.textContent = "♥";
          target.appendChild(heart);
          lifecycle.timeout(win, () => heart.remove(), 1700);
        }

        fed += 1;
        hint.textContent = fed >= 6 ? "吃饱了，谢谢你" : `投喂了 ${fed} 次 · 它们很开心`;
      }, 820);
    });

    // 页面开着跨过时段时，自己跟着换档
    lifecycle.interval(win, () => {
      const next = desktopFacilities.phase();
      if (tank.dataset.phase === next) return;
      tank.dataset.phase = next;
      hint.textContent = PHASE_TEXT[next];
    }, 60_000);

    // 深夜随机冒一个瞌睡泡
    lifecycle.interval(win, () => {
      if (tank.dataset.phase !== "night") return;

      const fishes = Array.from(layer.querySelectorAll<HTMLElement>(".fish"));
      const target = fishes[Math.floor(Math.random() * fishes.length)];
      if (!target) return;

      const z = document.createElement("span");
      z.className = "zzz";
      z.textContent = Math.random() > 0.45 ? "z" : "Z";
      target.appendChild(z);
      lifecycle.timeout(win, () => z.remove(), 3100);
    }, 2300);
  },
};
