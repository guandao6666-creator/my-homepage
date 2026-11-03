/**
 * Guandao OS 1.4 · 任务与通知中心
 *
 * 任务数据来自 tasks-store（日历 / 组件共用），
 * 通知数据来自 1.0 的 guandao.os.notif.v1（与菜单栏铃铛同一份），
 * 两边都不是独立摆设。
 */

import {
  badge,
  bindTabs,
  emptyState,
  escapeHtml,
  fmtAgo,
  fmtDate,
  ls,
  modal,
  shell,
  todayKey,
  type Ctx,
} from "./core";
import { PRIORITY, TASK_CATEGORIES, taskStore, type Task } from "./tasks-store";
import { patchPrefs, readPrefs } from "./prefs";

const NOTIF_KEY = "guandao.os.notif.v1";

type Notif = { id: string; icon: string; title: string; body: string; at: number; read: boolean };

const readNotifs = (): Notif[] => {
  const raw = ls.get<Notif[]>(NOTIF_KEY, []);
  return Array.isArray(raw) ? raw : [];
};

const writeNotifs = (list: Notif[]) => {
  ls.set(NOTIF_KEY, list.slice(0, 40));
  window.dispatchEvent(new CustomEvent("guandao:notif-change"));
};

let ctxRef: Ctx | null = null;
let tab = "tasks";
let filter: "open" | "done" | "all" = "open";
let cat = "all";
let query = "";

const catOf = (id: string) => TASK_CATEGORIES.find((c) => c.id === id) ?? TASK_CATEGORIES[3];

const dueLabel = (t: Task) => {
  if (!t.due) return "无截止";
  const today = todayKey();
  if (t.due === today) return "今天";
  if (t.due < today && !t.done) return `已逾期 ${t.due.slice(5)}`;
  return t.due.slice(5);
};

const taskRow = (t: Task) => `
  <div class="tk14-row ${t.done ? "is-done" : ""}" data-task="${escapeHtml(t.id)}">
    <button class="tk14-check ${t.done ? "is-on" : ""}" type="button" data-task-toggle="${escapeHtml(t.id)}" aria-label="完成">${t.done ? "✓" : ""}</button>
    <div class="tk14-main">
      <div class="tk14-title">${escapeHtml(t.title)}</div>
      <div class="tk14-meta">
        <span class="tk14-pri" style="--pc:${PRIORITY[t.priority].color}">${PRIORITY[t.priority].label}</span>
        <span class="tk14-cat" style="--cc:${catOf(t.category).color}">${escapeHtml(catOf(t.category).name)}</span>
        <span class="tk14-due ${!t.done && t.due && t.due < todayKey() ? "is-late" : ""}">${escapeHtml(dueLabel(t))}</span>
        ${t.note ? `<span class="tk14-note" title="${escapeHtml(t.note)}">备注</span>` : ""}
      </div>
    </div>
    <div class="tk14-acts">
      <button class="g14-btn is-ghost" type="button" data-task-edit="${escapeHtml(t.id)}">编辑</button>
      <button class="g14-btn is-ghost" type="button" data-task-del="${escapeHtml(t.id)}">删除</button>
    </div>
  </div>`;

const tasksView = () => {
  const stats = taskStore.stats();
  let list = taskStore.list();
  if (filter === "open") list = list.filter((t) => !t.done);
  if (filter === "done") list = list.filter((t) => t.done);
  if (cat !== "all") list = list.filter((t) => t.category === cat);
  const q = query.trim().toLowerCase();
  if (q) list = list.filter((t) => `${t.title} ${t.note}`.toLowerCase().includes(q));

  return `
    <div class="g14-scroll">
      <div class="tk14-top">
        <div class="tk14-stat"><b>${stats.open}</b><span>未完成</span></div>
        <div class="tk14-stat"><b>${stats.dueToday}</b><span>今天到期</span></div>
        <div class="tk14-stat ${stats.overdue ? "is-warn" : ""}"><b>${stats.overdue}</b><span>已逾期</span></div>
        <div class="tk14-stat"><b>${Math.round(stats.rate * 100)}%</b><span>完成率</span></div>
        <button class="g14-btn is-primary" type="button" data-task-new>＋ 新建任务</button>
      </div>
      <div class="tk14-bar">
        <div class="g14-seg" data-tk-filter>
          ${(["open", "all", "done"] as const).map((k) => `<button type="button" data-f="${k}" class="${filter === k ? "is-active" : ""}">${k === "open" ? "进行中" : k === "all" ? "全部" : "已完成"}</button>`).join("")}
        </div>
        <div class="g14-chip-row">
          <button class="g14-chip ${cat === "all" ? "is-active" : ""}" type="button" data-tk-cat="all">全部</button>
          ${TASK_CATEGORIES.map((c) => `<button class="g14-chip ${cat === c.id ? "is-active" : ""}" type="button" data-tk-cat="${c.id}">${escapeHtml(c.name)}</button>`).join("")}
        </div>
        <input class="tk14-search" data-tk-search placeholder="搜索任务…" value="${escapeHtml(query)}" />
      </div>
      <div class="tk14-list">
        ${list.length ? list.map(taskRow).join("") : emptyState(filter === "done" ? "还没有完成的任务" : "这里没有任务", "新建一个，或者换个筛选条件。", "✓")}
      </div>
      ${stats.done ? `<div class="tk14-foot"><button class="g14-btn is-ghost" type="button" data-task-clear>清除已完成 (${stats.done})</button></div>` : ""}
    </div>`;
};

const notifView = () => {
  const list = readNotifs();
  const prefs = readPrefs();
  const unread = list.filter((n) => !n.read).length;
  return `
    <div class="g14-scroll">
      <div class="g14-pane-head"><h3>通知</h3><p>${unread} 条未读 · 共 ${list.length} 条。和菜单栏铃铛是同一份数据。</p></div>
      <div class="tk14-notifbar">
        <button class="g14-btn" type="button" data-notif-read>全部标为已读</button>
        <button class="g14-btn is-ghost" type="button" data-notif-clear>清空</button>
        <label class="tk14-dnd"><input type="checkbox" data-dnd ${prefs.dnd ? "checked" : ""}/> 勿扰模式</label>
      </div>
      <div class="tk14-notifs">
        ${
          list.length
            ? list
                .map(
                  (n) => `<div class="tk14-notif ${n.read ? "" : "is-new"}">
                    <span class="tk14-notif-ico">${escapeHtml(n.icon)}</span>
                    <div><b>${escapeHtml(n.title)}</b><p>${escapeHtml(n.body)}</p><i>${fmtAgo(n.at)}</i></div>
                    ${n.read ? "" : `<span class="tk14-dot"></span>`}
                  </div>`,
                )
                .join("")
            : emptyState("没有通知", "应用通知、日程提醒、游戏纪录都会出现在这里。", "◔")
        }
      </div>
      <p class="g14-hint">勿扰模式开启后，新的通知仍会写入这里，但不会弹出提示。</p>
    </div>`;
};

const statsView = () => {
  const tasks = taskStore.list();
  const stats = taskStore.stats();
  const byCat = TASK_CATEGORIES.map((c) => {
    const items = tasks.filter((t) => t.category === c.id);
    const done = items.filter((t) => t.done).length;
    return { ...c, total: items.length, done };
  });
  const days: Array<{ key: string; label: string; created: number; done: number }> = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = todayKey(d);
    days.push({
      key,
      label: `${d.getMonth() + 1}/${d.getDate()}`,
      created: tasks.filter((t) => todayKey(new Date(t.createdAt)) === key).length,
      done: tasks.filter((t) => t.doneAt && todayKey(new Date(t.doneAt)) === key).length,
    });
  }
  const max = Math.max(1, ...days.map((d) => Math.max(d.created, d.done)));
  return `
    <div class="g14-scroll">
      <div class="g14-pane-head"><h3>完成情况</h3><p>按任务数据实时计算，不做估算。</p></div>
      <div class="tk14-stats">
        <div class="tk14-donut" style="--p:${Math.round(stats.rate * 100)}">
          <div><b>${Math.round(stats.rate * 100)}%</b><span>完成率</span></div>
        </div>
        <div class="tk14-bars">
          ${byCat
            .map(
              (c) => `<div class="tk14-bar-row">
                <span>${escapeHtml(c.name)}</span>
                <div class="tk14-track"><i style="width:${c.total ? (c.done / c.total) * 100 : 0}%;background:${c.color}"></i></div>
                <b>${c.done}/${c.total}</b>
              </div>`,
            )
            .join("")}
        </div>
      </div>
      <h3 class="g14-sub-h">最近七天</h3>
      <div class="tk14-week">
        ${days
          .map(
            (d) => `<div class="tk14-day">
              <div class="tk14-daybars">
                <i style="height:${(d.created / max) * 100}%" title="新建 ${d.created}"></i>
                <b style="height:${(d.done / max) * 100}%" title="完成 ${d.done}"></b>
              </div>
              <span>${d.label}</span>
            </div>`,
          )
          .join("")}
      </div>
      <p class="g14-hint"><span class="tk14-legend is-created"></span> 新建 <span class="tk14-legend is-done"></span> 完成</p>
    </div>`;
};

const view = () => (tab === "notif" ? notifView() : tab === "stats" ? statsView() : tasksView());

export const renderTasks = () => {
  const nav: Array<[string, string, string]> = [
    ["tasks", "任务", "✓"],
    ["notif", "通知", "◔"],
    ["stats", "统计", "◫"],
  ];
  return shell("tasks", nav, `<div class="tk14-host" data-tk-host></div>`, "任务与通知");
};

export const initTasks = (win: HTMLElement, ctx: Ctx): (() => void) => {
  ctxRef = ctx;
  tab = "tasks";
  const host = win.querySelector<HTMLElement>("[data-tk-host]");
  if (!host) return () => undefined;

  const paint = () => {
    if (host) host.innerHTML = view();
  };

  const editor = (task?: Task) => {
    void modal(win, {
      title: task ? "编辑任务" : "新建任务",
      wide: true,
      body: `<div class="g14-form">
        <label>标题<input class="g14-input" data-tf="title" maxlength="120" value="${escapeHtml(task?.title ?? "")}" placeholder="要做什么"/></label>
        <div class="g14-form-row">
          <label>优先级<select class="g14-input" data-tf="priority">
            ${(["high", "normal", "low"] as const).map((p) => `<option value="${p}" ${task?.priority === p || (!task && p === "normal") ? "selected" : ""}>${PRIORITY[p].label}</option>`).join("")}
          </select></label>
          <label>分类<select class="g14-input" data-tf="category">
            ${TASK_CATEGORIES.map((c) => `<option value="${c.id}" ${task?.category === c.id ? "selected" : ""}>${c.name}</option>`).join("")}
          </select></label>
          <label>截止日期<input class="g14-input" type="date" data-tf="due" value="${escapeHtml(task?.due ?? todayKey())}"/></label>
        </div>
        <label>备注<textarea class="g14-input" data-tf="note" rows="2" maxlength="400">${escapeHtml(task?.note ?? "")}</textarea></label>
      </div>`,
      actions: [
        { label: "取消", value: "" },
        { label: task ? "保存" : "创建", value: "ok", primary: true },
      ],
    }).then((v) => {
      if (v !== "ok") return;
      const val = (k: string) => win.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(`[data-tf="${k}"]`)?.value ?? "";
      const title = val("title").trim();
      if (!title) {
        ctx.toast("标题不能为空");
        return;
      }
      const patch = {
        title: title.slice(0, 120),
        priority: val("priority") as Task["priority"],
        category: val("category"),
        due: val("due"),
        note: val("note").slice(0, 400),
      };
      if (task) taskStore.update(task.id, patch);
      else taskStore.add(patch);
      paint();
    });
  };

  win.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    if (t.closest("[data-task-new]")) {
      editor();
      return;
    }
    const tg = t.closest<HTMLElement>("[data-task-toggle]");
    if (tg) {
      taskStore.toggle(tg.dataset.taskToggle ?? "");
      paint();
      return;
    }
    const ed = t.closest<HTMLElement>("[data-task-edit]");
    if (ed) {
      const task = taskStore.list().find((x) => x.id === ed.dataset.taskEdit);
      if (task) editor(task);
      return;
    }
    const del = t.closest<HTMLElement>("[data-task-del]");
    if (del) {
      taskStore.remove(del.dataset.taskDel ?? "");
      paint();
      return;
    }
    const f = t.closest<HTMLElement>("[data-f]");
    if (f) {
      filter = (f.dataset.f as typeof filter) ?? "open";
      paint();
      return;
    }
    const c = t.closest<HTMLElement>("[data-tk-cat]");
    if (c) {
      cat = c.dataset.tkCat ?? "all";
      paint();
      return;
    }
    if (t.closest("[data-task-clear]")) {
      taskStore.clearDone();
      paint();
      return;
    }
    if (t.closest("[data-notif-read]")) {
      writeNotifs(readNotifs().map((n) => ({ ...n, read: true })));
      paint();
      return;
    }
    if (t.closest("[data-notif-clear]")) {
      writeNotifs([]);
      paint();
    }
  });

  win.addEventListener("input", (e) => {
    const s = (e.target as HTMLElement).closest<HTMLInputElement>("[data-tk-search]");
    if (!s) return;
    query = s.value;
    const caret = s.selectionStart ?? query.length;
    const scroll = host.querySelector<HTMLElement>(".g14-scroll");
    const top = scroll?.scrollTop ?? 0;
    paint();
    const next = host.querySelector<HTMLElement>(".g14-scroll");
    if (next) next.scrollTop = top;
    const input = host.querySelector<HTMLInputElement>("[data-tk-search]");
    if (input) {
      input.focus();
      try {
        input.setSelectionRange(caret, caret);
      } catch {
        /* number 类型没有 setSelectionRange */
      }
    }
  });

  win.addEventListener("change", (e) => {
    const dnd = (e.target as HTMLElement).closest<HTMLInputElement>("[data-dnd]");
    if (dnd) {
      patchPrefs({ dnd: dnd.checked });
      ctx.toast(dnd.checked ? "已开启勿扰" : "已关闭勿扰");
    }
  });

  bindTabs(win, (next) => {
    tab = next;
    paint();
  });

  paint();
  return () => undefined;
};

export const notifStore = { read: readNotifs, write: writeNotifs };
export const taskDateLabel = fmtDate;
export const taskBadge = badge;
