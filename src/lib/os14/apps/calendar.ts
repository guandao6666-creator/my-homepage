/**
 * Guandao OS 1.4 · Guandao Calendar
 *
 * 月历 + 日程列表 + 分类颜色 + 重复事件 + 提醒 + 搜索，
 * 并直接读取任务中心的数据，两边不会各说各话。
 */

import {
  clamp,
  escapeHtml,
  ls,
  modal,
  monthMatrix,
  pad2,
  sameDay,
  todayKey,
  uid,
  type Ctx,
} from "../core";
import { TASK_CATEGORIES, taskStore } from "../tasks-store";

export type Repeat = "none" | "daily" | "weekly" | "monthly";

export type CalEvent = {
  id: string;
  title: string;
  date: string;
  time: string;
  category: string;
  repeat: Repeat;
  remind: number;
  note: string;
  createdAt: number;
  notified?: string[];
};

type CalState = {
  v: 1;
  events: CalEvent[];
  ui: { y: number; m: number; view: "month" | "list"; day: string };
};

const KEY = "guandao.os14.calendar.v1";
const LEGACY_KEY = "guandao.os.events.v1";

const COLORS: Record<string, string> = {
  study: "#6f8cff",
  work: "#e0a35c",
  life: "#5ecf9a",
  other: "#b06eff",
  urgent: "#ff8f8f",
};

const CAT_LABEL: Record<string, string> = {
  study: "学习",
  work: "工作",
  life: "生活",
  other: "其他",
  urgent: "重要",
};

const read = (): CalState => {
  const raw = ls.get<CalState | null>(KEY, null);
  if (raw && raw.v === 1 && Array.isArray(raw.events)) return raw;
  const now = new Date();
  const st: CalState = {
    v: 1,
    events: [],
    ui: { y: now.getFullYear(), m: now.getMonth(), view: "month", day: todayKey() },
  };
  const legacy = ls.get<Array<{ id?: string; date?: string; title?: string; time?: string }> | null>(LEGACY_KEY, null);
  if (Array.isArray(legacy)) {
    for (const e of legacy) {
      if (!e?.date || !e?.title) continue;
      st.events.push({
        id: uid(),
        title: String(e.title).slice(0, 80),
        date: String(e.date),
        time: String(e.time ?? ""),
        category: "other",
        repeat: "none",
        remind: 0,
        note: "",
        createdAt: Date.now(),
      });
    }
  }
  if (!st.events.length) {
    st.events.push({
      id: uid(),
      title: "去操场走两圈",
      date: todayKey(),
      time: "19:30",
      category: "life",
      repeat: "weekly",
      remind: 10,
      note: "别老坐着。",
      createdAt: Date.now(),
    });
  }
  ls.set(KEY, st);
  return st;
};

const write = (st: CalState) => ls.set(KEY, st);

export const occursOn = (ev: CalEvent, date: Date): boolean => {
  const key = todayKey(date);
  if (ev.date === key) return true;
  if (ev.repeat === "none") return false;
  const base = new Date(`${ev.date}T00:00:00`);
  if (!Number.isFinite(base.getTime())) return false;
  if (date < new Date(`${ev.date}T00:00:00`)) return false;
  if (ev.repeat === "daily") return true;
  if (ev.repeat === "weekly") return base.getDay() === date.getDay();
  if (ev.repeat === "monthly") return base.getDate() === date.getDate();
  return false;
};

const eventsOn = (st: CalState, date: Date) =>
  st.events
    .filter((ev) => occursOn(ev, date))
    .sort((a, b) => (a.time || "99:99").localeCompare(b.time || "99:99"));

/* ============================================================
   视图
   ============================================================ */

const eventChip = (ev: CalEvent, compact = false) => `
  <button class="c14-chip" type="button" data-c14-open="${escapeHtml(ev.id)}" style="--ev:${COLORS[ev.category] ?? COLORS.other}">
    ${ev.time ? `<b>${escapeHtml(ev.time)}</b>` : `<b>全天</b>`}
    <span>${escapeHtml(ev.title)}</span>
    ${compact ? "" : ev.repeat !== "none" ? `<i>${ev.repeat === "daily" ? "每天" : ev.repeat === "weekly" ? "每周" : "每月"}</i>` : ""}
  </button>`;

const renderBody = (win: HTMLElement) => {
  const st = read();
  const { y, m } = st.ui;
  const first = new Date(y, m, 1);
  const weeks = monthMatrix(y, m);
  const monthLabel = `${y} 年 ${m + 1} 月`;
  const selected = new Date(`${st.ui.day}T00:00:00`);
  const dayEvents = eventsOn(st, selected);
  const dayTasks = taskStore.list().filter((t) => t.due === st.ui.day);
  const searchQ = win.querySelector<HTMLInputElement>("[data-c14-search]")?.value.trim().toLowerCase() ?? "";

  const monthEvents = st.events
    .filter((ev) => (!searchQ ? true : `${ev.title} ${ev.note}`.toLowerCase().includes(searchQ)))
    .filter((ev) => {
      const d = new Date(`${ev.date}T00:00:00`);
      return d.getFullYear() === y && d.getMonth() === m;
    })
    .sort((a, b) => (a.date + (a.time || "")).localeCompare(b.date + (b.time || "")));

  return `
    <div class="c14">
      <header class="c14-head">
        <div class="c14-nav">
          <button type="button" data-c14-prev title="上个月">‹</button>
          <b>${monthLabel}</b>
          <button type="button" data-c14-next title="下个月">›</button>
          <button class="c14-today" type="button" data-c14-today>今天</button>
        </div>
        <div class="c14-tools">
          <div class="c14-seg">
            <button type="button" data-c14-view="month" class="${st.ui.view === "month" ? "is-active" : ""}">月历</button>
            <button type="button" data-c14-view="list" class="${st.ui.view === "list" ? "is-active" : ""}">日程</button>
          </div>
          <input class="c14-search" data-c14-search placeholder="搜索日程…" value="${escapeHtml(searchQ)}" />
          <button class="g14-btn is-primary" type="button" data-c14-new>＋ 新建</button>
        </div>
      </header>

      <div class="c14-body ${st.ui.view === "list" ? "is-list" : ""}">
        ${
          st.ui.view === "month"
            ? `<div class="c14-cal">
                <div class="c14-week">${["一", "二", "三", "四", "五", "六", "日"].map((d) => `<span>${d}</span>`).join("")}</div>
                <div class="c14-days">
                  ${weeks
                    .flat()
                    .map((d) => {
                      const evs = eventsOn(st, d);
                      const inMonth = d.getMonth() === m;
                      const isToday = sameDay(d, new Date());
                      const isSel = todayKey(d) === st.ui.day;
                      return `<button class="c14-day ${inMonth ? "" : "is-out"} ${isToday ? "is-today" : ""} ${isSel ? "is-sel" : ""}" type="button" data-c14-day="${todayKey(d)}">
                        <span class="c14-num">${d.getDate()}</span>
                        <span class="c14-dots">${evs.slice(0, 3).map((e) => `<i style="background:${COLORS[e.category] ?? COLORS.other}"></i>`).join("")}</span>
                        ${evs.length > 3 ? `<span class="c14-more">+${evs.length - 3}</span>` : ""}
                      </button>`;
                    })
                    .join("")}
                </div>
              </div>`
            : `<div class="c14-month-list">
                ${monthLabel} · 共 ${monthEvents.length} 条
                ${
                  monthEvents.length
                    ? monthEvents
                        .map(
                          (ev) => `<div class="c14-lrow" data-c14-open="${escapeHtml(ev.id)}">
                            <span class="c14-ldate">${ev.date.slice(5)}<i>${escapeHtml(ev.time || "全天")}</i></span>
                            <span class="c14-lbar" style="background:${COLORS[ev.category] ?? COLORS.other}"></span>
                            <span class="c14-ltitle">${escapeHtml(ev.title)}</span>
                            <span class="c14-ltag">${escapeHtml(CAT_LABEL[ev.category] ?? ev.category)}</span>
                          </div>`,
                        )
                        .join("")
                    : `<div class="c14-empty">这个月还没有日程。</div>`
                }
              </div>`
        }

        <aside class="c14-side">
          <div class="c14-side-head">
            <div><b>${selected.getMonth() + 1} 月 ${selected.getDate()} 日</b><span>${selected.toLocaleDateString("zh-CN", { weekday: "long" })}</span></div>
            <button type="button" class="c14-add" data-c14-new>＋</button>
          </div>
          <div class="c14-side-sec">
            <p class="c14-sec-title">日程 <span>${dayEvents.length}</span></p>
            ${dayEvents.length ? dayEvents.map((e) => eventChip(e)).join("") : `<p class="c14-empty">这一天还没有安排。</p>`}
          </div>
          <div class="c14-side-sec">
            <p class="c14-sec-title">任务 <span>${dayTasks.length}</span></p>
            ${
              dayTasks.length
                ? dayTasks
                    .map(
                      (t) => `<label class="c14-task"><input type="checkbox" data-c14-task="${escapeHtml(t.id)}" ${t.done ? "checked" : ""}/><span>${escapeHtml(t.title)}</span></label>`,
                    )
                    .join("")
                : `<p class="c14-empty">没有到期任务。</p>`
            }
            <button class="c14-link" type="button" data-c14-tasks>打开任务中心 →</button>
          </div>
          <div class="c14-legend">
            ${Object.entries(COLORS).map(([k, v]) => `<span><i style="background:${v}"></i>${CAT_LABEL[k]}</span>`).join("")}
          </div>
        </aside>
      </div>
    </div>`;
};

export const renderCalendar = () => `<div class="c14-host" data-c14-host></div>`;

export const initCalendar = (win: HTMLElement, ctx: Ctx): (() => void) => {
  const host = win.querySelector<HTMLElement>("[data-c14-host]");
  if (!host) return () => undefined;
  const paint = () => {
    host.innerHTML = renderBody(win);
  };

  const openEditor = (date?: string, id?: string) => {
    const st = read();
    const ev = id ? st.events.find((e) => e.id === id) : null;
    const d = date ?? st.ui.day;
    void modal(win, {
      title: ev ? "编辑日程" : "新建日程",
      wide: true,
      body: `
        <div class="g14-form">
          <label>标题<input class="g14-input" data-ef="title" maxlength="80" value="${escapeHtml(ev?.title ?? "")}" placeholder="要做什么" /></label>
          <div class="g14-form-row">
            <label>日期<input class="g14-input" type="date" data-ef="date" value="${escapeHtml(ev?.date ?? d)}" /></label>
            <label>时间<input class="g14-input" type="time" data-ef="time" value="${escapeHtml(ev?.time ?? "09:00")}" /></label>
            <label>分类<select class="g14-input" data-ef="category">
              ${Object.keys(COLORS).map((k) => `<option value="${k}" ${ev?.category === k ? "selected" : ""}>${CAT_LABEL[k]}</option>`).join("")}
            </select></label>
          </div>
          <div class="g14-form-row">
            <label>重复<select class="g14-input" data-ef="repeat">
              <option value="none" ${!ev || ev.repeat === "none" ? "selected" : ""}>不重复</option>
              <option value="daily" ${ev?.repeat === "daily" ? "selected" : ""}>每天</option>
              <option value="weekly" ${ev?.repeat === "weekly" ? "selected" : ""}>每周</option>
              <option value="monthly" ${ev?.repeat === "monthly" ? "selected" : ""}>每月</option>
            </select></label>
            <label>提醒<select class="g14-input" data-ef="remind">
              <option value="0">不提醒</option>
              <option value="5">提前 5 分钟</option>
              <option value="15">提前 15 分钟</option>
              <option value="60">提前 1 小时</option>
              <option value="1440">提前 1 天</option>
            </select></label>
          </div>
          <label>备注<textarea class="g14-input" data-ef="note" rows="2" maxlength="300" placeholder="补充说明">${escapeHtml(ev?.note ?? "")}</textarea></label>
          <p class="g14-hint">提醒会写入通知中心；页面关闭时不会触发（这是浏览器页面的边界）。</p>
        </div>`,
      actions: [
        ...(ev ? [{ label: "删除", value: "del", danger: true }] : []),
        { label: "取消", value: "" },
        { label: ev ? "保存" : "创建", value: "ok", primary: true },
      ],
    }).then((v) => {
      if (v === "del" && ev) {
        st.events = st.events.filter((x) => x.id !== ev.id);
        write(st);
        paint();
        return;
      }
      if (v !== "ok") return;
      const val = (k: string) => win.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(`[data-ef="${k}"]`)?.value ?? "";
      const title = val("title").trim();
      if (!title) {
        ctx.toast("标题不能为空");
        return;
      }
      const next: CalEvent = {
        id: ev?.id ?? uid(),
        title: title.slice(0, 80),
        date: val("date") || d,
        time: val("time"),
        category: val("category") || "other",
        repeat: (val("repeat") as Repeat) || "none",
        remind: Number(val("remind")) || 0,
        note: val("note").slice(0, 300),
        createdAt: ev?.createdAt ?? Date.now(),
      };
      if (ev) {
        const idx = st.events.findIndex((x) => x.id === ev.id);
        if (idx >= 0) st.events[idx] = next;
      } else {
        st.events.push(next);
      }
      st.ui.day = next.date;
      write(st);
      paint();
      ctx.toast(ev ? "日程已更新" : "日程已创建");
    });
  };

  win.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const st = read();

    if (t.closest("[data-c14-prev]")) {
      st.ui.m -= 1;
      if (st.ui.m < 0) {
        st.ui.m = 11;
        st.ui.y -= 1;
      }
      write(st);
      paint();
      return;
    }
    if (t.closest("[data-c14-next]")) {
      st.ui.m += 1;
      if (st.ui.m > 11) {
        st.ui.m = 0;
        st.ui.y += 1;
      }
      write(st);
      paint();
      return;
    }
    if (t.closest("[data-c14-today]")) {
      const now = new Date();
      st.ui.y = now.getFullYear();
      st.ui.m = now.getMonth();
      st.ui.day = todayKey();
      write(st);
      paint();
      return;
    }
    const view = t.closest<HTMLElement>("[data-c14-view]");
    if (view) {
      st.ui.view = view.dataset.c14View === "list" ? "list" : "month";
      write(st);
      paint();
      return;
    }
    const day = t.closest<HTMLElement>("[data-c14-day]");
    if (day) {
      st.ui.day = day.dataset.c14Day ?? todayKey();
      const d = new Date(`${st.ui.day}T00:00:00`);
      st.ui.y = d.getFullYear();
      st.ui.m = d.getMonth();
      write(st);
      paint();
      return;
    }
    if (t.closest("[data-c14-new]")) {
      openEditor(st.ui.day);
      return;
    }
    const open = t.closest<HTMLElement>("[data-c14-open]");
    if (open) {
      openEditor(undefined, open.dataset.c14Open ?? "");
      return;
    }
    if (t.closest("[data-c14-tasks]")) {
      ctx.openApp("tasks");
      return;
    }
    const task = t.closest<HTMLInputElement>("[data-c14-task]");
    if (task) {
      taskStore.toggle(task.dataset.c14Task ?? "");
      paint();
    }
  });

  win.addEventListener("change", (e) => {
    const task = (e.target as HTMLElement).closest<HTMLInputElement>("[data-c14-task]");
    if (task) {
      taskStore.toggle(task.dataset.c14Task ?? "");
      paint();
    }
  });

  win.addEventListener("input", (e) => {
    if ((e.target as HTMLElement).matches("[data-c14-search]")) paint();
  });

  // 提醒检查：每 30 秒一次，只在本页面打开时工作
  const timer = window.setInterval(() => {
    const st = read();
    const now = new Date();
    let changed = false;
    for (const ev of st.events) {
      if (!ev.remind) continue;
      for (let offset = 0; offset <= 1; offset++) {
        const day = new Date(now);
        day.setDate(day.getDate() + offset);
        if (!occursOn(ev, day)) continue;
        const [hh, mm] = (ev.time || "09:00").split(":").map(Number);
        const start = new Date(day);
        start.setHours(hh || 0, mm || 0, 0, 0);
        const fire = start.getTime() - ev.remind * 60000;
        const key = `${ev.id}@${todayKey(day)}`;
        if (now.getTime() >= fire && now.getTime() < fire + 60000 && !(ev.notified ?? []).includes(key)) {
          ev.notified = [...(ev.notified ?? []), key].slice(-30);
          changed = true;
          ctx.pushNotif({ icon: "◷", title: "日程提醒", body: `${ev.time || "今天"} ${ev.title}` });
        }
      }
    }
    if (changed) write(st);
  }, 30000);

  paint();
  return () => window.clearInterval(timer);
};

export const calendarColors = COLORS;
export { CAT_LABEL as calendarCategories, clamp };
