/**
 * Guandao OS 1.7 · 系统数据适配器
 *
 * 插件只能通过宿主读写 Notes / Calendar，而且只拿到用户「点选」的那一条。
 * 这里复用 1.4 应用已有的 localStorage 结构，不新建第二套笔记或日历。
 */

import { ls, pad2, todayKey, uid } from "../os14/core";

/* ============================================================
   Notes
   ============================================================ */

export type NoteDoc = {
  id: string;
  title: string;
  body: string;
  folder: string;
  tags: string[];
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
};

type NoteState = {
  v: 1;
  folders: Array<{ id: string; name: string }>;
  notes: NoteDoc[];
  ui: { folder: string; noteId: string; mode: "edit" | "preview" };
};

const NOTES_KEY = "guandao.os14.notes.v1";

function readNotes(): NoteState {
  const raw = ls.get<NoteState | null>(NOTES_KEY, null);
  if (raw && raw.v === 1 && Array.isArray(raw.notes)) return raw;
  return {
    v: 1,
    folders: [{ id: "inbox", name: "收集箱" }],
    notes: [],
    ui: { folder: "all", noteId: "", mode: "edit" },
  };
}

export function listNoteSummaries(): Array<{ id: string; title: string; updatedAt: number }> {
  return readNotes()
    .notes.slice()
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((note) => ({ id: note.id, title: note.title || note.body.slice(0, 24) || "未命名笔记", updatedAt: note.updatedAt }));
}

export function readNote(id: string): NoteDoc | null {
  return readNotes().notes.find((note) => note.id === id) ?? null;
}

export function createNote(input: { title: string; body: string; tags: string[] }): NoteDoc {
  const state = readNotes();
  const now = Date.now();
  const title = String(input.title || "").trim().slice(0, 80) || input.body.slice(0, 24) || "未命名笔记";
  const note: NoteDoc = {
    id: uid(),
    title,
    body: String(input.body || "").slice(0, 20000),
    folder: "inbox",
    tags: Array.isArray(input.tags) ? input.tags.slice(0, 6) : [],
    pinned: false,
    createdAt: now,
    updatedAt: now,
  };
  state.notes.push(note);
  state.ui = { ...state.ui, noteId: note.id };
  ls.set(NOTES_KEY, state);
  window.dispatchEvent(new CustomEvent("guandao:notes-change", { detail: { id: note.id, source: "plugin" } }));
  return note;
}

/* ============================================================
   Calendar
   ============================================================ */

export type CalEvent = {
  id: string;
  title: string;
  date: string;
  time: string;
  category: string;
  repeat: "none" | "daily" | "weekly" | "monthly";
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

const CAL_KEY = "guandao.os14.calendar.v1";

function readCalendar(): CalState {
  const raw = ls.get<CalState | null>(CAL_KEY, null);
  if (raw && raw.v === 1 && Array.isArray(raw.events)) return raw;
  const now = new Date();
  return {
    v: 1,
    events: [],
    ui: { y: now.getFullYear(), m: now.getMonth(), view: "month", day: todayKey() },
  };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function listUpcomingEvents(): Array<{ id: string; title: string; date: string; time: string; note: string }> {
  const day = todayKey();
  return readCalendar()
    .events.filter((event) => event.date >= day)
    .sort((a, b) => (a.date === b.date ? a.time.localeCompare(b.time) : a.date.localeCompare(b.date)))
    .slice(0, 40)
    .map((event) => ({ id: event.id, title: event.title, date: event.date, time: event.time, note: event.note }));
}

export function readEvent(id: string): CalEvent | null {
  return readCalendar().events.find((event) => event.id === id) ?? null;
}

export function createEvent(input: { title: string; date: string; time: string; note: string }): CalEvent {
  const title = String(input.title || "").trim().slice(0, 80);
  if (!title) throw new Error("日程标题不能为空");
  const date = String(input.date || "");
  if (!DATE_RE.test(date)) throw new Error("日期格式必须是 YYYY-MM-DD");
  const time = String(input.time || "09:00");
  if (!TIME_RE.test(time)) throw new Error("时间格式必须是 HH:MM");
  const state = readCalendar();
  const event: CalEvent = {
    id: uid(),
    title,
    date,
    time,
    category: "other",
    repeat: "none",
    remind: 0,
    note: String(input.note || "").slice(0, 400),
    createdAt: Date.now(),
    notified: [],
  };
  state.events.push(event);
  const [year, month] = date.split("-").map(Number);
  state.ui = { ...state.ui, y: year, m: Math.max(0, Math.min(11, (month || 1) - 1)), day: date };
  ls.set(CAL_KEY, state);
  window.dispatchEvent(new CustomEvent("guandao:calendar-change", { detail: { id: event.id, source: "plugin" } }));
  return event;
}

export function fmtClock(hour: number, minute: number) {
  return `${pad2(hour)}:${pad2(minute)}`;
}
