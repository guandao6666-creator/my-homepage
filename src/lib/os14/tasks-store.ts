/**
 * Guandao OS 1.4 · 任务数据层
 *
 * 任务中心、日历、桌面组件、通知提醒共用这一份数据，
 * 避免每个界面各存一套、互相看不见。
 */

import { emit, ls, uid } from "./core";
import { recordTombstone } from "../sync/tombstones";

export type Priority = "low" | "normal" | "high";

export type Task = {
  id: string;
  title: string;
  note: string;
  priority: Priority;
  /** YYYY-MM-DD，空表示没有截止日期 */
  due: string;
  category: string;
  done: boolean;
  createdAt: number;
  /** 2.0：最后一次修改时间（云同步用） */
  updatedAt?: number;
  doneAt?: number;
  /** 已经提醒过的日期，避免同一天重复弹 */
  notified?: string;
};

export type TaskState = { v: 1; tasks: Task[] };

const KEY = "guandao.os14.tasks.v1";

export const TASK_CATEGORIES: Array<{ id: string; name: string; color: string }> = [
  { id: "study", name: "学习", color: "#6f8cff" },
  { id: "work", name: "工作", color: "#e0a35c" },
  { id: "life", name: "生活", color: "#5ecf9a" },
  { id: "other", name: "其他", color: "#b06eff" },
];

export const PRIORITY: Record<Priority, { label: string; color: string; weight: number }> = {
  high: { label: "高", color: "#ff8f8f", weight: 3 },
  normal: { label: "中", color: "#ffd479", weight: 2 },
  low: { label: "低", color: "#8ea0bf", weight: 1 },
};

const seed = (): Task[] => {
  const now = Date.now();
  const today = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const d = (offset: number) => {
    const t = new Date(today);
    t.setDate(t.getDate() + offset);
    return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`;
  };
  return [
    {
      id: uid(),
      title: "读一节《C 程序设计语言》",
      note: "第 3 章：控制流，做两道课后题。",
      priority: "normal",
      due: d(0),
      category: "study",
      done: false,
      createdAt: now,
    },
    {
      id: uid(),
      title: "把桌面组件重新排一下",
      note: "试试新的专注计时和倒计时。",
      priority: "low",
      due: d(1),
      category: "life",
      done: false,
      createdAt: now,
    },
  ];
};

const read = (): TaskState => {
  const raw = ls.get<TaskState | null>(KEY, null);
  if (raw && raw.v === 1 && Array.isArray(raw.tasks)) return raw;
  const seeded: TaskState = { v: 1, tasks: seed() };
  ls.set(KEY, seeded);
  return seeded;
};

const write = (st: TaskState) => {
  ls.set(KEY, st);
  emit("tasks-change", { count: st.tasks.length });
};

export const taskStore = {
  list: (): Task[] => read().tasks.slice().sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    const ad = a.due || "9999-99-99";
    const bd = b.due || "9999-99-99";
    if (ad !== bd) return ad < bd ? -1 : 1;
    return PRIORITY[b.priority].weight - PRIORITY[a.priority].weight;
  }),
  add: (patch: Partial<Task>): Task => {
    const st = read();
    const now = Date.now();
    const task: Task = {
      id: uid(),
      title: String(patch.title ?? "").slice(0, 120) || "未命名任务",
      note: String(patch.note ?? "").slice(0, 600),
      priority: (patch.priority as Priority) ?? "normal",
      due: patch.due ?? "",
      category: patch.category ?? "other",
      done: false,
      createdAt: now,
      // 2.0：同步需要「最后一次修改时间」，否则改标题不会被识别为变更
      updatedAt: now,
    };
    st.tasks.unshift(task);
    write(st);
    return task;
  },
  update: (id: string, patch: Partial<Task>) => {
    const st = read();
    const t = st.tasks.find((x) => x.id === id);
    if (!t) return;
    Object.assign(t, patch, { id: t.id, createdAt: t.createdAt, updatedAt: Date.now() });
    write(st);
  },
  toggle: (id: string) => {
    const st = read();
    const t = st.tasks.find((x) => x.id === id);
    if (!t) return;
    t.done = !t.done;
    t.doneAt = t.done ? Date.now() : undefined;
    t.updatedAt = Date.now();
    write(st);
    if (t.done) emit("task-done", { id, title: t.title });
  },
  remove: (id: string) => {
    const st = read();
    st.tasks = st.tasks.filter((x) => x.id !== id);
    write(st);
    // 2.0：删除留墓碑，云同步才能传播删除
    recordTombstone("tasks", id);
  },
  clearDone: () => {
    const st = read();
    const removed = st.tasks.filter((x) => x.done);
    st.tasks = st.tasks.filter((x) => !x.done);
    write(st);
    // 2.0：批量删除也要留墓碑
    for (const task of removed) recordTombstone("tasks", task.id);
  },
  stats: () => {
    const tasks = read().tasks;
    const done = tasks.filter((t) => t.done).length;
    const today = new Date();
    const key = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    const dueToday = tasks.filter((t) => !t.done && t.due === key).length;
    const overdue = tasks.filter((t) => !t.done && t.due && t.due < key).length;
    return { total: tasks.length, done, open: tasks.length - done, dueToday, overdue, rate: tasks.length ? done / tasks.length : 0 };
  },
  dueToday: () => {
    const today = new Date();
    const key = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    return read().tasks.filter((t) => !t.done && t.due === key);
  },

  /* ---------------- 2.0 云同步接口 ---------------- */

  syncItems: (): Array<{ id: string; updatedAt: number; payload: Task }> =>
    read().tasks.map((task) => ({
      id: task.id,
      updatedAt: task.updatedAt || task.doneAt || task.createdAt,
      payload: task,
    })),

  applySync: (
    items: Array<{ id: string; updatedAt: number; deleted: boolean; payload?: Task | null }>,
  ): { applied: number; removed: number } => {
    const st = read();
    let applied = 0;
    let removed = 0;
    for (const item of items) {
      if (item.deleted) {
        const before = st.tasks.length;
        st.tasks = st.tasks.filter((task) => task.id !== item.id);
        if (st.tasks.length !== before) removed += 1;
        continue;
      }
      const incoming = item.payload;
      if (!incoming || typeof incoming !== "object") continue;
      const merged: Task = {
        id: item.id,
        title: String(incoming.title ?? "").slice(0, 120) || "未命名任务",
        note: String(incoming.note ?? "").slice(0, 600),
        priority: (incoming.priority as Priority) ?? "normal",
        due: String(incoming.due ?? ""),
        category: String(incoming.category ?? "other"),
        done: Boolean(incoming.done),
        createdAt: Number(incoming.createdAt) || item.updatedAt,
        updatedAt: Number(incoming.updatedAt) || item.updatedAt,
        ...(incoming.doneAt ? { doneAt: Number(incoming.doneAt) } : {}),
      };
      const index = st.tasks.findIndex((task) => task.id === item.id);
      if (index >= 0) st.tasks[index] = merged;
      else st.tasks.unshift(merged);
      applied += 1;
    }
    write(st);
    if (applied || removed) {
      try {
        window.dispatchEvent(new CustomEvent("guandao:tasks-sync"));
      } catch {
        /* 忽略 */
      }
    }
    return { applied, removed };
  },
};
