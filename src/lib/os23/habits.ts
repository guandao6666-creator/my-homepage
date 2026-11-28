/**
 * Guandao OS 2.3 · Habit Tracker（习惯打卡）
 *
 * 按需懒加载内置应用：
 *   - 自定义每日微习惯（颜色标记 + 图标）
 *   - 今日一键打卡 / 取消打卡 + 完成率统计
 *   - 连续打卡天数（Streak）实时计算
 *   - 近 28 天热力格矩阵（支持点击补卡或查看每日完成度）
 *
 * 数据保存在 localStorage（guandao.os23.habits.v1），纯本地存储。
 */
import { ls, todayKey, uid, type Ctx } from "../os14/core";

const STORAGE_KEY = "guandao.os23.habits.v1";

export type HabitItem = {
  id: string;
  name: string;
  color: string;
  /** 已打卡的本地日期列表（YYYY-MM-DD） */
  days: string[];
  createdAt: number;
};

type HabitPersist = { v: 1; habits: HabitItem[] };

const COLORS = ["#6f8cff", "#4fbf9a", "#f08a5d", "#e879b9", "#a78bfa", "#22c3e6"];

const DEFAULTS: HabitPersist = {
  v: 1,
  habits: [
    { id: "hb-read", name: "阅读 30 分钟", color: "#6f8cff", days: [], createdAt: 1 },
    { id: "hb-water", name: "喝够 8 杯水", color: "#22c3e6", days: [], createdAt: 2 },
    { id: "hb-walk", name: "运动或散步", color: "#4fbf9a", days: [], createdAt: 3 },
  ],
};

const readPersist = (): HabitPersist => {
  const raw = ls.get<Partial<HabitPersist>>(STORAGE_KEY, DEFAULTS);
  if (!raw || !Array.isArray(raw.habits)) return DEFAULTS;
  const habits = raw.habits
    .filter((h) => h && typeof h.name === "string" && h.name.trim())
    .map((h) => ({
      id: String(h.id || uid()),
      name: h.name.trim().slice(0, 32),
      color: COLORS.includes(h.color) ? h.color : COLORS[0],
      days: Array.isArray(h.days) ? [...new Set(h.days.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d))))] : [],
      createdAt: Number(h.createdAt) || Date.now(),
    }));
  return { v: 1, habits };
};

const writePersist = (data: HabitPersist) => ls.set(STORAGE_KEY, data);

/**
 * 计算某个习惯截至 `now` 的连续打卡天数：
 * 若今天已打卡则从今天往回数；若今天尚未打卡但昨天已打卡，则保留截至昨天的连续天数。
 */
export const calcStreak = (days: string[], now: Date = new Date()): number => {
  const set = new Set(days);
  const checkDay = (offset: number) =>
    set.has(todayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset)));
  let cursor = checkDay(0) ? 0 : checkDay(1) ? 1 : -1;
  if (cursor < 0) return 0;
  let streak = 0;
  while (checkDay(cursor)) {
    streak++;
    cursor++;
  }
  return streak;
};

/** 生成近 28 天（最早在前，今天在最后）的整体打卡完成比例（0 ~ 1） */
export const buildHeatmap28 = (
  habits: HabitItem[],
  now: Date = new Date(),
): Array<{ day: string; done: number; total: number; ratio: number }> => {
  const total = habits.length;
  const out: Array<{ day: string; done: number; total: number; ratio: number }> = [];
  for (let i = 27; i >= 0; i--) {
    const day = todayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - i));
    const done = habits.filter((h) => h.days.includes(day)).length;
    out.push({ day, done, total, ratio: total > 0 ? done / total : 0 });
  }
  return out;
};

export const renderHabitTracker = () => `
  <div class="os23-habits" style="display:grid;grid-template-rows:auto 1fr auto auto;gap:12px;height:100%;padding:16px 18px;box-sizing:border-box;color:inherit">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">
      <div>
        <div style="font-size:15px;font-weight:650" data-hb-headline>今日习惯</div>
        <div style="font-size:12px;opacity:0.65;margin-top:2px" data-hb-sub>保持节奏，每天进步一点点</div>
      </div>
      <form data-hb-form style="display:flex;gap:6px;align-items:center">
        <input type="text" data-hb-input maxlength="28" placeholder="新习惯，如：早睡" aria-label="新习惯名称" required style="padding:7px 10px;border-radius:9px;border:1px solid rgba(255,255,255,0.14);background:rgba(255,255,255,0.05);color:inherit;font:inherit;font-size:12.5px;outline:none;width:150px" />
        <button type="submit" class="g14-btn is-primary">＋ 添加</button>
      </form>
    </div>

    <div data-hb-list style="min-height:0;overflow:auto;display:grid;gap:8px;align-content:start"></div>

    <div style="border-top:1px solid rgba(255,255,255,0.08);padding-top:10px">
      <div style="display:flex;justify-content:space-between;font-size:11.5px;opacity:0.65;margin-bottom:6px">
        <span>近 28 天打卡热力图</span>
        <span data-hb-heat-summary></span>
      </div>
      <div data-hb-heat style="display:grid;grid-template-columns:repeat(14,1fr);gap:5px"></div>
    </div>

    <div style="display:flex;justify-content:space-between;font-size:12px;opacity:0.72;padding-top:6px;border-top:1px solid rgba(255,255,255,0.08)">
      <span>点击左侧圆圈完成今日打卡</span>
      <span>Guandao OS 2.3 · Habit Tracker</span>
    </div>
  </div>`;

export const initHabitTracker = (win: HTMLElement, ctx: Ctx): (() => void) => {
  const listEl = win.querySelector<HTMLElement>("[data-hb-list]");
  const heatEl = win.querySelector<HTMLElement>("[data-hb-heat]");
  const heatSum = win.querySelector<HTMLElement>("[data-hb-heat-summary]");
  const headEl = win.querySelector<HTMLElement>("[data-hb-headline]");
  const subEl = win.querySelector<HTMLElement>("[data-hb-sub]");
  const form = win.querySelector<HTMLFormElement>("[data-hb-form]");
  const input = win.querySelector<HTMLInputElement>("[data-hb-input]");

  let persist = readPersist();

  const paint = () => {
    const today = todayKey();
    const total = persist.habits.length;
    const doneToday = persist.habits.filter((h) => h.days.includes(today)).length;
    if (headEl) headEl.textContent = `今日已完成 ${doneToday} / ${total}`;
    if (subEl) {
      subEl.textContent =
        total === 0
          ? "从右上角添加第一个习惯吧"
          : doneToday === total
            ? "太棒了！今天的习惯已全部打卡完成"
            : `今天是 ${today} · 还差 ${total - doneToday} 项完成全部目标`;
    }

    if (listEl) {
      listEl.textContent = "";
      if (!persist.habits.length) {
        const empty = document.createElement("p");
        empty.textContent = "还没有习惯条目，在右上角输入名称添加。";
        empty.style.cssText = "margin:0;padding:24px 12px;text-align:center;opacity:0.6;font-size:13px";
        listEl.appendChild(empty);
      } else {
        for (const h of persist.habits) {
          const checked = h.days.includes(today);
          const streak = calcStreak(h.days);
          const row = document.createElement("div");
          row.style.cssText =
            "display:flex;align-items:center;gap:12px;padding:10px 13px;border-radius:11px;border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.04)";

          const btn = document.createElement("button");
          btn.type = "button";
          btn.setAttribute("aria-label", `${checked ? "取消打卡" : "打卡"} ${h.name}`);
          btn.textContent = checked ? "✓" : "";
          btn.style.cssText = `width:26px;height:26px;border-radius:50%;border:2px solid ${h.color};background:${checked ? h.color : "transparent"};color:#fff;font-weight:700;cursor:pointer;flex:none;display:grid;place-items:center`;
          btn.addEventListener("click", () => {
            const nextDays = checked ? h.days.filter((d) => d !== today) : [...h.days, today];
            persist = {
              ...persist,
              habits: persist.habits.map((item) => (item.id === h.id ? { ...item, days: nextDays } : item)),
            };
            writePersist(persist);
            paint();
          });

          const info = document.createElement("div");
          info.style.cssText = "flex:1;min-width:0";
          const title = document.createElement("div");
          title.textContent = h.name;
          title.style.cssText = `font-size:13.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;${checked ? "opacity:0.75" : ""}`;
          const meta = document.createElement("div");
          meta.textContent = `连续 ${streak} 天 · 累计 ${h.days.length} 次`;
          meta.style.cssText = "font-size:11.5px;opacity:0.6;margin-top:2px";
          info.append(title, meta);

          const del = document.createElement("button");
          del.type = "button";
          del.className = "g14-btn is-ghost";
          del.textContent = "✕";
          del.style.cssText = "min-height:26px;padding:0 8px";
          del.setAttribute("aria-label", `删除 ${h.name}`);
          del.addEventListener("click", () => {
            persist = { ...persist, habits: persist.habits.filter((item) => item.id !== h.id) };
            writePersist(persist);
            paint();
          });

          row.append(btn, info, del);
          listEl.appendChild(row);
        }
      }
    }

    if (heatEl) {
      heatEl.textContent = "";
      const cells = buildHeatmap28(persist.habits);
      const activeDays = cells.filter((c) => c.done > 0).length;
      if (heatSum) heatSum.textContent = `活跃 ${activeDays} / 28 天`;
      for (const c of cells) {
        const cell = document.createElement("div");
        const alpha = c.ratio === 0 ? 0.07 : 0.25 + c.ratio * 0.75;
        cell.title = `${c.day}：完成 ${c.done}/${c.total}`;
        cell.style.cssText = `height:16px;border-radius:4px;background:${c.ratio === 0 ? "rgba(255,255,255,0.08)" : `rgba(111,140,255,${alpha.toFixed(2)})`}`;
        heatEl.appendChild(cell);
      }
    }
  };

  form?.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = (input?.value || "").trim().slice(0, 28);
    if (!name) return;
    if (persist.habits.length >= 20) {
      ctx.toast("最多添加 20 个日常习惯");
      return;
    }
    const color = COLORS[persist.habits.length % COLORS.length];
    persist = {
      ...persist,
      habits: [...persist.habits, { id: uid(), name, color, days: [], createdAt: Date.now() }],
    };
    writePersist(persist);
    if (input) input.value = "";
    paint();
    ctx.toast(`已添加习惯：${name}`);
  });

  paint();
  return () => undefined;
};
