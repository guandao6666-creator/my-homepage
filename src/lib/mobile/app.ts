/**
 * Guandao OS 2.0 · 移动端伴侣
 *
 * 独立于桌面窗口系统的轻量外壳：首页 / 笔记 / 任务 / 日历 / 更多。
 * 数据来源：
 *   - 笔记、任务、日历：与桌面共用同一份 localStorage（不是第二套模型）
 *   - 文件、设备、接力、剪贴板：现有 Worker API
 *   - 离线：本地编辑照常，接力/剪贴板进入 outbox，联网后补发
 */

import { fmtAgo, fmtBytes, fmtDate, monthMatrix, pad2, sameDay, todayKey } from "../os14/core";
import { notesStore } from "../os14/apps/notes";
import { calendarStore } from "../os14/apps/calendar";
import { taskStore, PRIORITY, TASK_CATEGORIES, type Task } from "../os14/tasks-store";
import { initPwa, checkForUpdate } from "../shell/pwa";
import { installGlobalErrorHandlers } from "../quality/errors";
import { initConnectivity } from "../quality/connectivity";
import { initAdaptiveShell, readPreference, resolveMode, setPreference, type ShellPreference } from "../shell/adaptive";
import { revokeDevice, type Device } from "../devices/client";
import {
  clipboardApi,
  continuityApi,
  pairingApi,
  pushApi,
  type ClipboardItem,
  type ContextItem,
  type ContinuityItem,
  type PairingCreated,
  type PairingItem,
} from "../continuity/client";
import { ITEM_META, summarize } from "../continuity/payloads";
import {
  ICONS,
  confirmSheet,
  escapeAttr,
  escapeHtml,
  fileIcon,
  openSheet,
  toast,
} from "./ui";
import {
  isOnline,
  loadAccount,
  loadClipboard,
  loadContexts,
  loadDevices,
  loadFiles,
  loadHistory,
  loadInbox,
  outbox,
  uploadFile,
  type AccountState,
  type DriveFile,
} from "./data";
import { qrSvg } from "../continuity/qr";

type Tab = "home" | "notes" | "tasks" | "calendar" | "more";
type Sub = "files" | "devices" | "clipboard" | "account" | "settings" | null;

type Route = { tab: Tab; sub: Sub; noteId: string | null };

type State = Route & {
  account: AccountState | null;
  devices: Awaited<ReturnType<typeof loadDevices>>;
  files: DriveFile[];
  inbox: ContinuityItem[];
  history: ContinuityItem[];
  contexts: ContextItem[];
  clipboard: ClipboardItem[];
  noteQuery: string;
  taskFilter: "today" | "open" | "done";
  calMonth: Date;
  calDay: string;
  loading: boolean;
  pairing: (PairingCreated & { pending: PairingItem[]; qr?: string }) | null;
  push: { enabled: boolean; configured: boolean; reason: string } | null;
  installPrompt: { prompt: () => Promise<void> } | null;
};

const root = document.getElementById("mobile-root");
if (!root) throw new Error("mobile root missing");

const state: State = {
  tab: "home",
  sub: null,
  noteId: null,
  account: null,
  devices: null,
  files: [],
  inbox: [],
  history: [],
  contexts: [],
  clipboard: [],
  noteQuery: "",
  taskFilter: "today",
  calMonth: new Date(),
  calDay: todayKey(),
  loading: true,
  pairing: null,
  push: null,
  installPrompt: null,
};

let noteSaveTimer = 0;
let pollTimer = 0;
let pairingTimer = 0;

/* ============================================================
   路由：让安卓返回键 / 浏览器后退按层级返回
   ============================================================ */

function routeOf(next: Partial<Route>): Route {
  return { tab: next.tab ?? state.tab, sub: next.sub ?? null, noteId: next.noteId ?? null };
}

let contextTimer = 0;

/** 上报语义化进度：只给应用、内容 ID 与标题，不上传正文。 */
function reportContext() {
  if (!state.account?.authenticated) return;
  window.clearTimeout(contextTimer);
  contextTimer = window.setTimeout(() => {
    const appId =
      state.sub === "files"
        ? "drive"
        : state.sub
          ? state.sub
          : state.noteId
            ? "notes"
            : state.tab;
    const note = state.noteId ? notesStore.get(state.noteId) : null;
    void continuityApi
      .saveContext({
        appId: appId.slice(0, 46),
        resourceId: note?.id ?? null,
        resourceTitle: note?.title || (state.sub ? state.sub : state.tab),
        scroll: window.scrollY,
      })
      .catch(() => undefined);
  }, 1500);
}

function navigate(next: Partial<Route>, opts: { replace?: boolean } = {}) {
  const route = routeOf(next);
  const payload = { ...route };
  if (opts.replace) history.replaceState(payload, "");
  else history.pushState(payload, "");
  Object.assign(state, route);
  if (next.tab) state.sub = next.sub ?? (next.tab === state.tab ? state.sub : null);
  paint();
  window.scrollTo({ top: 0, behavior: "auto" });
  reportContext();
}

function applyRoute(route: Route) {
  state.tab = route.tab;
  state.sub = route.sub;
  state.noteId = route.noteId;
  paint();
}

window.addEventListener("popstate", (event) => {
  const route = event.state as Route | null;
  if (route && route.tab) applyRoute(route);
  else applyRoute({ tab: "home", sub: null, noteId: null });
});

/* ============================================================
   主题：沿用桌面 1.3 的外观配置
   ============================================================ */

function applyMobileTheme() {
  let mode = "dark";
  let accent = "#7c9cff";
  let accent2 = "#c084fc";
  let wall = "aurora";
  try {
    const cfg = JSON.parse(localStorage.getItem("guandao.os13.v1") || "{}");
    const raw = cfg?.appearance?.mode;
    if (raw === "light" || raw === "dark") mode = raw;
    else if (localStorage.getItem("guandao.os.theme") === "light") mode = "light";
    if (typeof cfg?.appearance?.accent === "string") accent = cfg.appearance.accent;
    if (typeof cfg?.appearance?.accent2 === "string") accent2 = cfg.appearance.accent2;
    if (typeof cfg?.wall?.id === "string" && !cfg.wall.id.startsWith("custom")) wall = cfg.wall.id;
  } catch {
    /* 默认值 */
  }
  document.documentElement.dataset.mTheme = mode;
  document.documentElement.style.setProperty("--m-accent", accent);
  document.documentElement.style.setProperty("--m-accent-2", accent2);
  document.documentElement.style.setProperty("--m-wall", `url("/wallpapers/${wall}.webp")`);
}

/* ============================================================
   渲染
   ============================================================ */

function paint() {
  if (!root) return;
  const tabContent =
    state.sub === "files"
      ? viewFiles()
      : state.sub === "devices"
        ? viewDevices()
        : state.sub === "clipboard"
          ? viewClipboard()
          : state.sub === "account"
            ? viewAccount()
            : state.sub === "settings"
              ? viewSettings()
              : state.noteId
                ? viewNoteEditor()
                : state.tab === "home"
                  ? viewHome()
                  : state.tab === "notes"
                    ? viewNotes()
                    : state.tab === "tasks"
                      ? viewTasks()
                      : state.tab === "calendar"
                        ? viewCalendar()
                        : viewMore();

  const showTabs = !state.noteId;
  root.innerHTML = `${topBar()}${tabContent}${showTabs ? tabBar() : ""}`;
  if (state.sub === null && !state.noteId) {
    const fab = fabFor();
    if (fab) root.insertAdjacentHTML("beforeend", fab);
  }
  document.body.classList.toggle("m-editing", Boolean(state.noteId));
}

function topBar() {
  const authed = Boolean(state.account?.authenticated);
  const name =
    state.account?.user?.displayName ||
    state.account?.user?.githubUsername ||
    (state.account?.reason === "offline" ? "离线模式" : "本机模式");
  const sub = state.sub
    ? { files: "云端文件", devices: "设备与配对", clipboard: "跨设备剪贴板", account: "账号", settings: "设置" }[state.sub]
    : state.noteId
      ? "笔记"
      : { home: "Guandao OS 2.0", notes: "Guandao Notes", tasks: "任务", calendar: "日历", more: "更多" }[state.tab];
  const back = Boolean(state.sub || state.noteId || state.tab !== "home");

  const avatar = state.account?.user?.avatarUrl
    ? `<img src="${escapeAttr(state.account.user.avatarUrl)}" alt="" referrerpolicy="no-referrer" />`
    : escapeHtml((name[0] || "管").toUpperCase());

  const status = !isOnline()
    ? `<span class="m-status is-offline"><i></i>离线</span>`
    : authed
      ? `<span class="m-status"><i></i>${
          state.devices
            ? `${state.devices.devices.filter((d) => d.presence === "active").length} 台在线`
            : "云端"
        }</span>`
      : state.account?.reason === "offline"
        ? `<span class="m-status is-offline"><i></i>离线</span>`
        : `<span class="m-status is-guest"><i></i>未登录</span>`;

  return `<header class="m-top">
    ${
      back
        ? `<button type="button" data-m-act="back" aria-label="返回" style="width:38px;height:38px;display:grid;place-items:center;border-radius:12px;border:1px solid var(--m-line);color:var(--m-dim)">${ICONS.back}</button>`
        : `<span class="m-avatar">${avatar}</span>`
    }
    <div class="m-top-text"><b>${escapeHtml(name)}</b><span>${escapeHtml(sub)}</span></div>
    ${status}
  </header>`;
}

function tabBar() {
  const items: Array<[Tab, string, string]> = [
    ["home", "首页", ICONS.home],
    ["notes", "笔记", ICONS.note],
    ["tasks", "任务", ICONS.task],
    ["calendar", "日历", ICONS.calendar],
    ["more", "更多", ICONS.more],
  ];
  // 2.0：底栏直接给一个「桌面」出口。手机访问 / 会落到 /m/，
  // 没有这个入口就看不到博客与全部桌面应用；?desktop=1 会持久化选择。
  return `<nav class="m-tabbar" aria-label="主导航">
    ${items
      .map(
        ([id, label, icon]) =>
          `<button type="button" class="m-tab ${state.tab === id && !state.sub ? "is-on" : ""}" data-m-act="tab" data-tab="${id}">${icon}<span>${label}</span></button>`,
      )
      .join("")}
    <a class="m-tab m-tab-desktop" href="/?desktop=1" aria-label="进入桌面版">
      ${ICONS.desktop}<span>桌面</span>
    </a>
  </nav>`;
}

function fabFor(): string | null {
  if (state.tab === "notes") return `<button class="m-fab" type="button" data-m-act="new-note" aria-label="新建笔记">${ICONS.plus}</button>`;
  if (state.tab === "tasks") return `<button class="m-fab" type="button" data-m-act="new-task" aria-label="新建任务">${ICONS.plus}</button>`;
  if (state.tab === "calendar") return `<button class="m-fab" type="button" data-m-act="new-event" aria-label="新建日程">${ICONS.plus}</button>`;
  return null;
}

/* ============================================================
   首页
   ============================================================ */

function greeting() {
  const hour = new Date().getHours();
  if (hour < 6) return "夜深了";
  if (hour < 11) return "早上好";
  if (hour < 14) return "中午好";
  if (hour < 18) return "下午好";
  return "晚上好";
}

function viewHome() {
  const name = state.account?.user?.displayName || state.account?.user?.githubUsername || "";
  const notes = notesStore.list();
  const tasks = taskStore.list();
  const openTasks = tasks.filter((task) => !task.done);
  const dueToday = taskStore.dueToday();
  const today = new Date();
  const events = calendarStore
    .list()
    .filter((event) => event.date >= todayKey())
    .slice(0, 4);
  const incoming = state.inbox.filter((item) => !item.outgoing);
  const contexts = state.contexts.filter((context) => !context.current);
  const outboxCount = outbox.count();

  return `<main class="m-scroll m-fade-in">
    <section class="m-greet">
      <p>Guandao OS 2.0 · ${escapeHtml(fmtDate(today.getTime()))}</p>
      <h1>${greeting()}${name ? `，<em>${escapeHtml(name)}</em>` : ""}</h1>
      <small>${today.toLocaleDateString("zh-CN", { weekday: "long", month: "long", day: "numeric" })}</small>
    </section>

    ${
      !isOnline()
        ? `<p class="m-offline">当前离线：笔记、任务、日历仍可编辑并保存在本机；接力与剪贴板会排队，联网后自动发送。</p>`
        : ""
    }
    ${
      outboxCount
        ? `<p class="m-offline">有 ${outboxCount} 条接力/剪贴板等待发送，联网后会自动补发。</p>`
        : ""
    }

    <section class="m-hero">
      <div class="m-hero-top">
        <div>
          <h2>你的数字世界</h2>
          <p>${state.account?.authenticated ? "同一个账号，不同设备各自的体验。" : "登录后可以在设备之间接力内容。"}</p>
        </div>
        <span class="m-pill ${state.account?.authenticated ? "ok" : ""}">${state.account?.authenticated ? "已连接账号" : "本机模式"}</span>
      </div>
      <div class="m-hero-stats">
        <div><b>${openTasks.length}</b><span>未完成任务</span></div>
        <div><b>${notes.length}</b><span>笔记</span></div>
        <div><b>${state.devices?.overview.activeDeviceCount ?? "—"}</b><span>活跃设备</span></div>
      </div>
      <div class="m-quick">
        <button type="button" data-m-act="new-note"><span class="m-ico">${ICONS.note}</span>新建笔记</button>
        <button type="button" data-m-act="new-task"><span class="m-ico">${ICONS.task}</span>新建任务</button>
        <button type="button" data-m-act="new-event"><span class="m-ico">${ICONS.calendar}</span>新建日程</button>
        <button type="button" data-m-act="quick-upload"><span class="m-ico">${ICONS.folder}</span>上传文件</button>
      </div>
    </section>

    ${
      incoming.length
        ? `<section class="m-section">
            <div class="m-sec-head"><h2>等你接收</h2><span class="m-pill">${incoming.length}</span></div>
            <div class="m-card"><div class="m-row-list">
              ${incoming
                .slice(0, 4)
                .map(
                  (item) => `<button type="button" class="m-row" data-m-act="open-item" data-id="${escapeAttr(item.id)}">
                    <span class="m-device-ico">${escapeHtml(ITEM_META[item.itemType]?.glyph ?? "◆")}</span>
                    <span class="m-row-main"><b>${escapeHtml(item.title)}</b><span>来自 ${escapeHtml(item.sourceName)} · ${escapeHtml(ITEM_META[item.itemType]?.label ?? "")} · ${escapeHtml(fmtAgo(item.createdAt))}</span></span>
                    <span class="m-row-side">打开 ${ICONS.chevron}</span>
                  </button>`,
                )
                .join("")}
            </div></div>
          </section>`
        : ""
    }

    <section class="m-section">
      <div class="m-sec-head"><h2>今天</h2><button type="button" data-m-act="tab" data-tab="tasks">全部任务</button></div>
      <div class="m-card"><div class="m-row-list">
        ${
          dueToday.length
            ? dueToday
                .slice(0, 5)
                .map(
                  (task) => `<div class="m-row">
                    <button type="button" class="m-check" data-m-act="toggle-task" data-id="${escapeAttr(task.id)}" aria-label="完成任务">✓</button>
                    <span class="m-row-main"><b>${escapeHtml(task.title)}</b><span>${escapeHtml(PRIORITY[task.priority].label)}优先 · ${escapeHtml(categoryName(task.category))} · 今天</span></span>
                  </div>`,
                )
                .join("")
            : `<div class="m-empty"><b>今天没有到期任务</b>新建一个，或者享受空白。</div>`
        }
      </div></div>
    </section>

    <section class="m-section">
      <div class="m-sec-head"><h2>即将到来</h2><button type="button" data-m-act="tab" data-tab="calendar">日历</button></div>
      <div class="m-card"><div class="m-row-list">
        ${
          events.length
            ? events
                .map(
                  (event) => `<button type="button" class="m-row" data-m-act="open-event" data-id="${escapeAttr(event.id)}">
                    <span class="m-row-side" style="min-width:44px;text-align:center;color:var(--m-accent)"><b style="display:block;font-size:16px">${escapeHtml(event.date.slice(8))}</b><span style="font-size:9px">${escapeHtml(event.date.slice(5, 7))} 月</span></span>
                    <span class="m-row-main"><b>${escapeHtml(event.title)}</b><span>${escapeHtml(event.time || "全天")} · ${escapeHtml(categoryName(event.category))}</span></span>
                  </button>`,
                )
                .join("")
            : `<div class="m-empty"><b>近期没有日程</b>日程会按日期显示在这里。</div>`
        }
      </div></div>
    </section>

    <section class="m-section">
      <div class="m-sec-head"><h2>最近笔记</h2><button type="button" data-m-act="tab" data-tab="notes">打开笔记</button></div>
      <div class="m-card"><div class="m-row-list">
        ${
          notes.length
            ? notes
                .slice(0, 3)
                .map(
                  (note) => `<button type="button" class="m-row" data-m-act="open-note" data-id="${escapeAttr(note.id)}">
                    <span class="m-device-ico">${ICONS.note}</span>
                    <span class="m-row-main"><b>${escapeHtml(note.title || "未命名笔记")}</b><span>${escapeHtml(note.body.replace(/\s+/g, " ").slice(0, 48) || "空白笔记")}</span></span>
                    <span class="m-row-side">${escapeHtml(fmtAgo(note.updatedAt))}</span>
                  </button>`,
                )
                .join("")
            : `<div class="m-empty"><b>还没有笔记</b>点右下角新建一篇。</div>`
        }
      </div></div>
    </section>

    ${
      state.account?.authenticated
        ? `<section class="m-section">
            <div class="m-sec-head"><h2>最近文件</h2><button type="button" data-m-act="sub" data-sub="files">全部文件</button></div>
            <div class="m-card"><div class="m-row-list">
              ${
                state.files.length
                  ? state.files
                      .slice(0, 3)
                      .map(
                        (file) => `<button type="button" class="m-row" data-m-act="open-file" data-id="${escapeAttr(file.id)}">
                          <span class="m-device-ico">${escapeHtml(fileIcon(file.category))}</span>
                          <span class="m-row-main"><b>${escapeHtml(file.name)}</b><span>${escapeHtml(fmtBytes(file.sizeBytes))} · ${escapeHtml(fmtAgo(file.updatedAt))}</span></span>
                        </button>`,
                      )
                      .join("")
                  : `<div class="m-empty"><b>云端还没有文件</b>上传一张图片或文档试试。</div>`
              }
            </div></div>
          </section>`
        : ""
    }

    ${
      contexts.length
        ? `<section class="m-section">
            <div class="m-sec-head"><h2>其他设备上的进度</h2></div>
            <div class="m-card"><div class="m-row-list">
              ${contexts
                .slice(0, 3)
                .map(
                  (context) => `<div class="m-row">
                    <span class="m-device-ico">${ICONS.device}</span>
                    <span class="m-row-main"><b>${escapeHtml(context.deviceName)}</b><span>${escapeHtml(context.resourceTitle || context.appId)} · ${escapeHtml(fmtAgo(context.updatedAt))}</span></span>
                  </div>`,
                )
                .join("")}
            </div></div>
            <p style="margin:8px 4px 0;font-size:10px;color:var(--m-faint)">这里只显示语义化进度；内容本身需要那台设备主动发送或从云端文件打开。</p>
          </section>`
        : ""
    }

    ${
      !state.account?.authenticated
        ? `<section class="m-section"><div class="m-card m-login">
            <div class="m-logo">管</div>
            <h3>登录 Guandao Account</h3>
            <p>登录后可以接收接力内容、查看云端文件、配对设备。本机笔记不需要登录。</p>
            <a class="m-btn primary" href="/api/auth/github">使用 GitHub 登录</a>
          </div></section>`
        : ""
    }
  </main>`;
}

/* ============================================================
   笔记
   ============================================================ */

function viewNotes() {
  const query = state.noteQuery.trim().toLowerCase();
  const list = notesStore.list().filter((note) => {
    if (!query) return true;
    return `${note.title}\n${note.body}\n${note.tags.join(" ")}`.toLowerCase().includes(query);
  });

  return `<main class="m-scroll m-fade-in">
    <div class="m-search">${ICONS.search}<input data-m-input="note-search" placeholder="搜索笔记" value="${escapeAttr(state.noteQuery)}" /></div>
    <div class="m-section" style="margin-top:12px">
      <div class="m-card">
        ${
          list.length
            ? `<div class="m-row-list">${list
                .map(
                  (note) => `<button type="button" class="m-note-item" style="display:block;width:100%;text-align:left" data-m-act="open-note" data-id="${escapeAttr(note.id)}">
                    <b>${note.pinned ? "★ " : ""}${escapeHtml(note.title || "未命名笔记")}</b>
                    <p>${escapeHtml(note.body.replace(/\s+/g, " ").slice(0, 120) || "空白笔记")}</p>
                    <span>${escapeHtml(fmtAgo(note.updatedAt))}${note.tags.length ? ` · ${escapeHtml(note.tags.slice(0, 2).join(" "))}` : ""}</span>
                  </button>`,
                )
                .join("")}</div>`
            : `<div class="m-empty"><b>${query ? "没有匹配的笔记" : "还没有笔记"}</b>${query ? "换个关键词试试。" : "点右下角开始写第一篇。"}</div>`
        }
      </div>
    </div>
    <p style="margin:12px 4px;font-size:10px;color:var(--m-faint)">笔记保存在这台设备的浏览器里；需要带走时用「发送到设备」。</p>
  </main>`;
}

function viewNoteEditor() {
  const note = notesStore.get(state.noteId || "");
  if (!note) {
    window.setTimeout(() => navigate({ noteId: null }, { replace: true }), 0);
    return `<main class="m-scroll"><div class="m-empty">这篇笔记不存在。</div></main>`;
  }
  return `<main class="m-scroll m-fade-in">
    <div class="m-editor-bar">
      <button type="button" class="m-btn ghost" data-m-act="toggle-pin">${note.pinned ? "★ 已置顶" : "☆ 置顶"}</button>
      <button type="button" class="m-btn ghost" data-m-act="send-note">${ICONS.send} 发送</button>
      <button type="button" class="m-btn ghost" data-m-act="delete-note" aria-label="删除">${ICONS.trash}</button>
      <span class="m-saved" data-m-saved>已保存</span>
    </div>
    <div class="m-editor">
      <input class="m-title" data-m-input="note-title" maxlength="80" placeholder="标题" value="${escapeAttr(note.title)}" />
      <textarea data-m-input="note-body" placeholder="用 Markdown 写点什么…">${escapeHtml(note.body)}</textarea>
    </div>
    <p style="margin:10px 2px 0;font-size:10px;color:var(--m-faint)">自动保存到本机 · <span data-m-count>${note.body.length}</span> 字</p>
  </main>`;
}

/* ============================================================
   任务
   ============================================================ */

function categoryName(id: string) {
  return TASK_CATEGORIES.find((category) => category.id === id)?.name ?? "其他";
}

function taskMatches(task: Task) {
  if (state.taskFilter === "today") return !task.done && task.due === todayKey();
  if (state.taskFilter === "done") return task.done;
  return !task.done;
}

function viewTasks() {
  const list = taskStore.list().filter(taskMatches);
  const stats = taskStore.stats();
  return `<main class="m-scroll m-fade-in">
    <div class="m-chips">
      ${(
        [
          ["today", `今天 ${stats.dueToday}`],
          ["open", `未完成 ${stats.open}`],
          ["done", `已完成 ${stats.done}`],
        ] as const
      )
        .map(
          ([id, label]) =>
            `<button type="button" class="m-chip ${state.taskFilter === id ? "is-on" : ""}" data-m-act="task-filter" data-filter="${id}">${label}</button>`,
        )
        .join("")}
    </div>
    <div class="m-card">
      ${
        list.length
          ? `<div class="m-row-list">${list
              .map(
                (task) => `<div class="m-row">
                  <button type="button" class="m-check ${task.done ? "is-on" : ""}" data-m-act="toggle-task" data-id="${escapeAttr(task.id)}" aria-label="完成任务">✓</button>
                  <button type="button" class="m-row-main" style="text-align:left;background:none" data-m-act="edit-task" data-id="${escapeAttr(task.id)}">
                    <b style="${task.done ? "text-decoration:line-through;color:var(--m-faint)" : ""}">${escapeHtml(task.title)}</b>
                    <span>${escapeHtml(PRIORITY[task.priority].label)}优先 · ${escapeHtml(categoryName(task.category))} · ${task.due ? escapeHtml(task.due === todayKey() ? "今天" : task.due.slice(5)) : "无截止"}</span>
                  </button>
                </div>`,
              )
              .join("")}</div>`
          : `<div class="m-empty"><b>${
              state.taskFilter === "today" ? "今天没有到期任务" : state.taskFilter === "done" ? "还没有完成的任务" : "没有未完成任务"
            }</b>点右下角新建一个。</div>`
      }
    </div>
  </main>`;
}

function openTaskSheet(task?: Task) {
  const item = task ?? null;
  const body = `
    <div style="display:flex;flex-direction:column;gap:10px">
      <input class="m-input" data-task-field="title" maxlength="120" placeholder="任务标题" value="${escapeAttr(item?.title ?? "")}" />
      <textarea class="m-input" data-task-field="note" rows="2" maxlength="600" placeholder="备注（可选）">${escapeHtml(item?.note ?? "")}</textarea>
      <div style="display:flex;gap:8px">
        <label style="flex:1;font-size:10px;color:var(--m-dim)">截止日期<input class="m-input" type="date" data-task-field="due" value="${escapeAttr(item?.due ?? todayKey())}" /></label>
        <label style="flex:1;font-size:10px;color:var(--m-dim)">优先级<select class="m-input" data-task-field="priority">
          ${Object.entries(PRIORITY).map(([id, meta]) => `<option value="${id}" ${item?.priority === id ? "selected" : ""}>${meta.label}</option>`).join("")}
        </select></label>
      </div>
      <label style="font-size:10px;color:var(--m-dim)">分类<select class="m-input" data-task-field="category">
        ${TASK_CATEGORIES.map((category) => `<option value="${category.id}" ${item?.category === category.id ? "selected" : ""}>${category.name}</option>`).join("")}
      </select></label>
    </div>`;
  const sheetValues: Record<string, string> = {
    title: item?.title ?? "",
    note: item?.note ?? "",
    due: item?.due ?? todayKey(),
    priority: item?.priority ?? "normal",
    category: item?.category ?? "other",
  };

  void openSheet({
    title: item ? "编辑任务" : "新建任务",
    body,
    actions: [
      ...(item ? [{ label: "删除", value: "delete", danger: true }] : []),
      { label: "取消", value: "" },
      { label: item ? "保存" : "创建", value: "ok", primary: true },
    ],
    onMount(sheet) {
      sheet.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("[data-task-field]").forEach((field) => {
        const sync = () => {
          sheetValues[field.dataset.taskField!] = field.value;
        };
        field.addEventListener("input", sync);
        field.addEventListener("change", sync);
      });
    },
  }).then((value) => {
    if (value === "delete" && item) {
      taskStore.remove(item.id);
      paint();
      toast("任务已删除");
      return;
    }
    if (value !== "ok") return;
    const title = sheetValues.title.trim();
    if (!title) {
      toast("标题不能为空", "danger");
      return;
    }
    const patch: Partial<Task> = {
      title,
      note: sheetValues.note,
      due: sheetValues.due,
      priority: (sheetValues.priority as Task["priority"]) || "normal",
      category: sheetValues.category || "other",
    };
    if (item) taskStore.update(item.id, patch);
    else taskStore.add(patch);
    paint();
    toast(item ? "任务已更新" : "任务已创建");
  });
}

/* ============================================================
   日历
   ============================================================ */

function viewCalendar() {
  const year = state.calMonth.getFullYear();
  const month = state.calMonth.getMonth();
  const weeks = monthMatrix(year, month);
  const selected = new Date(`${state.calDay}T00:00:00`);
  const dayEvents = calendarStore.onDay(selected);
  const monthLabel = `${year} 年 ${month + 1} 月`;

  return `<main class="m-scroll m-fade-in">
    <div class="m-cal-nav">
      <button type="button" data-m-act="cal-prev" aria-label="上个月">‹</button>
      <b>${monthLabel}</b>
      <button type="button" data-m-act="cal-next" aria-label="下个月">›</button>
      <button type="button" class="m-btn ghost" data-m-act="cal-today">今天</button>
    </div>
    <div class="m-card m-card-pad">
      <div class="m-cal-head">${["一", "二", "三", "四", "五", "六", "日"].map((day) => `<span>${day}</span>`).join("")}</div>
      <div class="m-cal">
        ${weeks
          .flat()
          .map((day) => {
            const key = `${day.getFullYear()}-${pad2(day.getMonth() + 1)}-${pad2(day.getDate())}`;
            const events = calendarStore.onDay(day);
            return `<button type="button" class="${day.getMonth() !== month ? "is-out" : ""} ${sameDay(day, new Date()) ? "is-today" : ""} ${
              key === state.calDay ? "is-sel" : ""
            }" data-m-act="cal-day" data-day="${key}">${day.getDate()}${events.length ? "<i></i>" : ""}</button>`;
          })
          .join("")}
      </div>
    </div>

    <section class="m-section">
      <div class="m-sec-head"><h2>${selected.getMonth() + 1} 月 ${selected.getDate()} 日 · 周${"日一二三四五六"[selected.getDay()]}</h2><button type="button" data-m-act="new-event">新建</button></div>
      <div class="m-card">
        ${
          dayEvents.length
            ? `<div class="m-row-list">${dayEvents
                .map(
                  (event) => `<button type="button" class="m-row" data-m-act="open-event" data-id="${escapeAttr(event.id)}">
                    <span class="m-row-side" style="min-width:46px;color:var(--m-accent);font-size:12px">${escapeHtml(event.time || "全天")}</span>
                    <span class="m-row-main"><b>${escapeHtml(event.title)}</b><span>${escapeHtml(categoryName(event.category))}${event.note ? ` · ${escapeHtml(event.note)}` : ""}</span></span>
                  </button>`,
                )
                .join("")}</div>`
            : `<div class="m-empty"><b>这一天还没有安排</b>点「新建」加一个日程。</div>`
        }
      </div>
    </section>
  </main>`;
}

function openEventSheet(id?: string) {
  const item = id ? calendarStore.get(id) : null;
  const values: Record<string, string> = {
    title: item?.title ?? "",
    date: item?.date ?? state.calDay,
    time: item?.time ?? "",
    category: item?.category ?? "other",
    note: item?.note ?? "",
  };
  const body = `
    <div style="display:flex;flex-direction:column;gap:10px">
      <input class="m-input" data-event-field="title" maxlength="80" placeholder="日程标题" value="${escapeAttr(values.title)}" />
      <div style="display:flex;gap:8px">
        <label style="flex:1;font-size:10px;color:var(--m-dim)">日期<input class="m-input" type="date" data-event-field="date" value="${escapeAttr(values.date)}" /></label>
        <label style="flex:1;font-size:10px;color:var(--m-dim)">时间<input class="m-input" type="time" data-event-field="time" value="${escapeAttr(values.time)}" /></label>
      </div>
      <label style="font-size:10px;color:var(--m-dim)">分类<select class="m-input" data-event-field="category">
        ${["study", "work", "life", "other", "urgent"].map((key) => `<option value="${key}" ${values.category === key ? "selected" : ""}>${categoryName(key)}</option>`).join("")}
      </select></label>
      <textarea class="m-input" data-event-field="note" rows="2" maxlength="300" placeholder="备注（可选）">${escapeHtml(values.note)}</textarea>
    </div>`;
  void openSheet({
    title: item ? "编辑日程" : "新建日程",
    body,
    actions: [
      ...(item ? [{ label: "删除", value: "delete", danger: true }, { label: "发送", value: "send" }] : []),
      { label: "取消", value: "" },
      { label: item ? "保存" : "创建", value: "ok", primary: true },
    ],
    onMount(sheet) {
      sheet.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("[data-event-field]").forEach((field) => {
        const sync = () => {
          values[field.dataset.eventField!] = field.value;
        };
        field.addEventListener("input", sync);
        field.addEventListener("change", sync);
      });
    },
  }).then((value) => {
    window.setTimeout(() => {
      if (value === "delete" && item) {
        calendarStore.remove(item.id);
        paint();
        toast("日程已删除");
        return;
      }
      if (value === "send" && item) {
        void sendItem("event", item.title, item.id, {
          title: item.title,
          date: item.date,
          time: item.time,
          category: item.category,
          repeat: item.repeat,
          note: item.note,
        });
        return;
      }
      if (value !== "ok") return;
      const title = values.title.trim();
      if (!title) {
        toast("标题不能为空", "danger");
        return;
      }
      const patch = {
        title,
        date: values.date || state.calDay,
        time: values.time,
        category: values.category,
        note: values.note,
      };
      if (item) calendarStore.update(item.id, patch);
      else calendarStore.add(patch);
      state.calDay = patch.date;
      paint();
      toast(item ? "日程已更新" : "日程已创建");
    }, 0);
  });
}

/* ============================================================
   更多 / 子页面
   ============================================================ */

function viewMore() {
  const authed = Boolean(state.account?.authenticated);
  return `<main class="m-scroll m-fade-in">
    <section class="m-card" style="margin-top:8px">
      <div class="m-row-list">
        <button type="button" class="m-row" data-m-act="sub" data-sub="files">
          <span class="m-device-ico">${ICONS.folder}</span><span class="m-row-main"><b>云端文件</b><span>${state.files.length ? `${state.files.length} 个最近文件` : "浏览、上传、发送文件"}</span></span><span class="m-row-side">${ICONS.chevron}</span>
        </button>
        <button type="button" class="m-row" data-m-act="sub" data-sub="devices">
          <span class="m-device-ico">${ICONS.device}</span><span class="m-row-main"><b>设备与配对</b><span>${state.devices ? `${state.devices.overview.deviceCount} 台设备` : "查看设备、添加新设备"}</span></span><span class="m-row-side">${ICONS.chevron}</span>
        </button>
        <button type="button" class="m-row" data-m-act="sub" data-sub="clipboard">
          <span class="m-device-ico">${ICONS.clipboard}</span><span class="m-row-main"><b>跨设备剪贴板</b><span>只发送你明确选择的文字</span></span><span class="m-row-side">${ICONS.chevron}</span>
        </button>
      </div>
    </section>

    <section class="m-section">
      <div class="m-sec-head"><h2>账号</h2></div>
      <div class="m-card"><div class="m-row-list">
        ${
          authed
            ? `<button type="button" class="m-row" data-m-act="sub" data-sub="account">
                <span class="m-avatar" style="width:36px;height:36px;border-radius:11px">${
                  state.account?.user?.avatarUrl ? `<img src="${escapeAttr(state.account.user.avatarUrl)}" alt="" referrerpolicy="no-referrer" />` : escapeHtml((state.account?.user?.displayName || "管")[0] || "管")
                }</span>
                <span class="m-row-main"><b>${escapeHtml(state.account?.user?.displayName || "Guandao")}</b><span>@${escapeHtml(state.account?.user?.githubUsername || "guandao")} · Guandao Account</span></span>
                <span class="m-row-side">${ICONS.chevron}</span>
              </button>`
            : `<a class="m-row" href="/api/auth/github"><span class="m-device-ico">${ICONS.user}</span><span class="m-row-main"><b>登录 Guandao Account</b><span>使用 GitHub 登录</span></span></a>`
        }
        <button type="button" class="m-row" data-m-act="sub" data-sub="settings">
          <span class="m-device-ico">${ICONS.more}</span><span class="m-row-main"><b>设置</b><span>布局、安装、更新与推送状态</span></span><span class="m-row-side">${ICONS.chevron}</span>
        </button>
      </div></div>
    </section>

    <section class="m-section">
      <div class="m-sec-head"><h2>同步边界</h2></div>
      <div class="m-card m-card-pad" style="font-size:11.5px;line-height:1.7;color:var(--m-dim)">
        <p style="margin:0 0 6px">笔记、任务、日历保存在这台设备的浏览器里，不会自动上传。</p>
        <p style="margin:0 0 6px">云端文件、接力内容与剪贴板使用 Guandao Account，同一账号的设备才能接收。</p>
        <p style="margin:0">没有登录时，本机功能照常可用。</p>
      </div>
    </section>

    <p style="text-align:center;margin:26px 0 8px;font-size:10px;color:var(--m-faint)">Guandao OS 2.0 · Faster. Safer. Smoother.</p>
  </main>`;
}

function viewFiles() {
  return `<main class="m-scroll m-fade-in">
    <div class="m-sec-head" style="margin-top:8px">
      <h2>云端文件</h2>
      <button type="button" data-m-act="quick-upload">上传</button>
    </div>
    <div class="m-card">
      ${
        state.files.length
          ? `<div class="m-row-list">${state.files
              .map(
                (file) => `<button type="button" class="m-row" data-m-act="open-file" data-id="${escapeAttr(file.id)}">
                  <span class="m-device-ico">${escapeHtml(fileIcon(file.category))}</span>
                  <span class="m-row-main"><b>${escapeHtml(file.name)}</b><span>${escapeHtml(fmtBytes(file.sizeBytes))} · ${escapeHtml(fmtAgo(file.updatedAt))}</span></span>
                  <span class="m-row-side">${ICONS.chevron}</span>
                </button>`,
              )
              .join("")}</div>`
          : `<div class="m-empty"><b>${state.account?.authenticated ? "还没有云端文件" : "登录后查看云端文件"}</b>${
              state.account?.authenticated ? "上传一张图片或文档试试。" : `<a href="/api/auth/github" style="color:var(--m-accent)">去登录</a>`
            }</div>`
      }
    </div>
    <p style="margin:10px 4px;font-size:10px;color:var(--m-faint)">文件保存在 R2，只有当前账号可以访问。</p>
  </main>`;
}

function viewDevices() {
  const authed = Boolean(state.account?.authenticated);
  const devices = state.devices?.devices ?? [];
  return `<main class="m-scroll m-fade-in">
    <div class="m-sec-head" style="margin-top:8px"><h2>我的设备</h2><button type="button" data-m-act="pair-create">添加设备</button></div>
    <div class="m-card">
      ${
        authed
          ? devices.length
            ? `<div>${devices
                .map(
                  (device) => `<div class="m-device-row">
                    <span class="m-device-ico">${ICONS.device}</span>
                    <span class="m-row-main"><b>${escapeHtml(device.name)} ${device.isCurrent ? '<em style="font-style:normal;color:var(--m-accent);font-size:9px">当前</em>' : ""}</b><span>${escapeHtml(device.browser)} · ${escapeHtml(device.os)} · ${device.presence === "active" ? "活跃" : device.presence === "recent" ? "最近使用" : "闲置"}</span></span>
                    ${
                      device.isCurrent
                        ? `<span class="m-pill ok">本机</span>`
                        : `<button type="button" class="m-btn ghost" data-m-act="revoke-device" data-id="${escapeAttr(device.id)}" data-name="${escapeAttr(device.name)}">撤销</button>`
                    }
                  </div>`,
                )
                .join("")}</div>`
            : `<div class="m-empty"><b>还没有设备记录</b>登录后会自动登记这台设备。</div>`
          : `<div class="m-empty"><b>登录后管理设备</b><a href="/api/auth/github" style="color:var(--m-accent)">使用 GitHub 登录</a></div>`
      }
    </div>

    ${
      state.pairing
        ? `<section class="m-section">
            <div class="m-sec-head"><h2>配对这台设备</h2><button type="button" data-m-act="pair-cancel">取消</button></div>
            <div class="m-card m-card-pad" style="text-align:center">
              <p style="margin:0;font-size:11px;color:var(--m-dim)">在另一台已登录设备上打开设备中心，输入下面的配对码。</p>
              <div class="m-code">${escapeHtml(state.pairing.code)}</div>
              <div class="m-qr">${state.pairing.qr || ""}</div>
              <p style="margin:0;font-size:10px;color:var(--m-faint)">二维码只有 10 分钟有效，且只能使用一次。</p>
              ${
                state.pairing.pending.length
                  ? `<div style="margin-top:12px;text-align:left">${state.pairing.pending
                      .map(
                        (pairing) => `<div style="padding:10px 0;border-top:1px solid var(--m-line)">
                          <b style="font-size:12px">${escapeHtml(pairing.target?.name || "新设备")}</b>
                          <p style="margin:3px 0 8px;font-size:10px;color:var(--m-dim)">${escapeHtml(pairing.target?.browser || "")} · ${escapeHtml(pairing.target?.os || "")}</p>
                          <button type="button" class="m-btn primary" data-m-act="pair-confirm" data-id="${escapeAttr(pairing.id)}">批准配对</button>
                        </div>`,
                      )
                      .join("")}</div>`
                  : `<p style="margin:10px 0 0;font-size:10px;color:var(--m-faint)">正在等待新设备提交配对…</p>`
              }
            </div>
          </section>`
        : ""
    }

    <p style="margin:12px 4px;font-size:10px;color:var(--m-faint)">配对会在服务端登记新设备并签发独立 Session；旧设备不批准，新设备拿不到任何凭证。</p>
  </main>`;
}

function viewClipboard() {
  return `<main class="m-scroll m-fade-in">
    <div class="m-sec-head" style="margin-top:8px"><h2>发送文字</h2><span class="m-pill">纯文本</span></div>
    <div class="m-card m-card-pad">
      <textarea class="m-input" data-m-input="clip-text" rows="3" maxlength="4000" placeholder="粘贴或输入要发送到其他设备的文字…"></textarea>
      <div style="display:flex;gap:8px;margin-top:9px">
        <button type="button" class="m-btn primary" style="flex:1" data-m-act="clip-send">发送</button>
        <button type="button" class="m-btn ghost" data-m-act="clip-clear">清空</button>
      </div>
      <p style="margin:9px 2px 0;font-size:10px;color:var(--m-faint)">只有点击「发送」才会写入云端；不会后台读取系统剪贴板。内容 24 小时后自动过期。</p>
    </div>

    <section class="m-section">
      <div class="m-sec-head"><h2>最近</h2><button type="button" data-m-act="clip-refresh">刷新</button></div>
      <div class="m-card">
        ${
          state.clipboard.length
            ? state.clipboard
                .map(
                  (item) => `<div class="m-clip-item">
                    <div class="m-clip-text">${escapeHtml(item.content)}</div>
                    <div class="m-clip-meta">
                      <span>${escapeHtml(item.sourceName)} · ${escapeHtml(fmtAgo(item.createdAt))}</span>
                      <button type="button" data-m-act="clip-copy" data-id="${escapeAttr(item.id)}">复制</button>
                      <button type="button" data-m-act="clip-delete" data-id="${escapeAttr(item.id)}">删除</button>
                    </div>
                  </div>`,
                )
                .join("")
            : `<div class="m-empty"><b>还没有剪贴板记录</b>${state.account?.authenticated ? "发送一段文字试试。" : "登录后才能跨设备发送。"}</div>`
        }
      </div>
    </section>
  </main>`;
}

function viewAccount() {
  const user = state.account?.user;
  const devices = state.devices?.devices ?? [];
  return `<main class="m-scroll m-fade-in">
    <div class="m-card m-card-pad" style="display:flex;gap:13px;align-items:center;margin-top:8px">
      <span class="m-avatar" style="width:54px;height:54px;border-radius:16px;font-size:19px">${
        user?.avatarUrl ? `<img src="${escapeAttr(user.avatarUrl)}" alt="" referrerpolicy="no-referrer" />` : escapeHtml((user?.displayName || "管")[0] || "管")
      }</span>
      <div style="min-width:0">
        <b style="display:block;font-size:16px">${escapeHtml(user?.displayName || "Guandao")}</b>
        <span style="font-size:11px;color:var(--m-dim)">@${escapeHtml(user?.githubUsername || "guandao")} · ${escapeHtml(user?.role || "member")}</span>
      </div>
    </div>

    <section class="m-section">
      <div class="m-card"><div class="m-row-list">
        <div class="m-row"><span class="m-row-main"><b>设备</b><span>${devices.length} 台设备在这个账号下</span></span><button type="button" class="m-btn ghost" data-m-act="sub" data-sub="devices">管理</button></div>
        <div class="m-row"><span class="m-row-main"><b>账号类型</b><span>Guandao Account · GitHub 登录</span></span></div>
        <div class="m-row"><span class="m-row-main"><b>当前设备</b><span>${escapeHtml(devices.find((device) => device.isCurrent)?.name || "这台浏览器")}</span></span></div>
      </div></div>
    </section>

    <section class="m-section">
      <div class="m-card"><div class="m-row-list">
        <a class="m-row" href="/?app=devices&amp;desktop=1"><span class="m-row-main"><b>在桌面版管理设备</b><span>重命名、查看会话与安全活动</span></span><span class="m-row-side">${ICONS.chevron}</span></a>
        <a class="m-row" href="/?app=backup&amp;desktop=1"><span class="m-row-main"><b>备份与恢复</b><span>导出本机数据</span></span><span class="m-row-side">${ICONS.chevron}</span></a>
        <button type="button" class="m-row" data-m-act="logout"><span class="m-row-main"><b style="color:var(--m-danger)">退出登录</b><span>同时撤销这台设备的 Session</span></span></button>
      </div></div>
    </section>
  </main>`;
}

function viewSettings() {
  const pref = readPreference();
  const mode = resolveMode();
  return `<main class="m-scroll m-fade-in">
    <section class="m-section" style="margin-top:8px">
      <div class="m-sec-head"><h2>布局模式</h2><span class="m-pill">当前：${mode === "mobile" ? "手机" : mode === "tablet" ? "平板" : "桌面"}</span></div>
      <div class="m-card m-card-pad">
        <div class="m-chips" style="flex-wrap:wrap;padding-bottom:0">
          ${(
            [
              ["auto", "自动"],
              ["desktop", "桌面"],
              ["tablet", "平板"],
              ["mobile", "手机"],
            ] as Array<[ShellPreference, string]>
          )
            .map(
              ([id, label]) =>
                `<button type="button" class="m-chip ${pref === id ? "is-on" : ""}" data-m-act="set-shell" data-pref="${id}">${label}</button>`,
            )
            .join("")}
        </div>
        <p style="margin:10px 2px 0;font-size:10px;color:var(--m-faint)">自动模式会综合屏宽、高度、触摸能力与方向，不依赖 User-Agent。</p>
      </div>
    </section>

    <section class="m-section">
      <div class="m-sec-head"><h2>应用</h2></div>
      <div class="m-card"><div class="m-row-list">
        <button type="button" class="m-row" data-m-act="install-pwa"><span class="m-row-main"><b>安装到主屏幕</b><span>${state.installPrompt ? "可用" : "浏览器菜单里也可以添加"}</span></span><span class="m-row-side">${ICONS.chevron}</span></button>
        <button type="button" class="m-row" data-m-act="check-update"><span class="m-row-main"><b>检查更新</b><span>Service Worker 版本</span></span><span class="m-row-side">${ICONS.chevron}</span></button>
        <button type="button" class="m-row" data-m-act="push-status"><span class="m-row-main"><b>跨设备通知</b><span>${state.push ? (state.push.enabled ? "已启用" : "未启用") : "读取中…"}</span></span><span class="m-row-side">${ICONS.chevron}</span></button>
        <button type="button" class="m-row" data-m-act="clear-cache"><span class="m-row-main"><b>清理离线缓存</b><span>不会删除笔记、任务或账号</span></span><span class="m-row-side">${ICONS.chevron}</span></button>
      </div></div>
    </section>

    <section class="m-section">
      <div class="m-sec-head"><h2>外观</h2></div>
      <div class="m-card m-card-pad" style="font-size:11.5px;line-height:1.7;color:var(--m-dim)">
        <p style="margin:0">手机端沿用桌面版的主题模式与强调色。想换配色请到桌面版「主题中心」，这里的视觉会跟着变。</p>
      </div>
    </section>

    <p style="text-align:center;margin:24px 0 8px;font-size:10px;color:var(--m-faint)">Guandao OS 2.0.0 · Polish Before the Next Era</p>
  </main>`;
}

/* ============================================================
   发送 / 接力的交互
   ============================================================ */

async function sendItem(
  itemType: "note" | "task" | "event" | "file" | "link" | "workspace" | "reading" | "app",
  title: string,
  resourceId: string | null,
  payload: Record<string, unknown>,
) {
  if (!state.account?.authenticated) {
    toast("先登录 Guandao Account 才能发送", "danger");
    return;
  }
  const devices = state.devices?.devices.filter((device) => !device.isCurrent && device.status === "active") ?? [];
  const options = [
    `<label style="display:flex;align-items:center;gap:10px;padding:11px 0;border-bottom:1px solid var(--m-line)">
      <input type="radio" name="m-target" value="" checked />
      <span><b style="display:block;font-size:12.5px">任一设备</b><span style="font-size:10px;color:var(--m-dim)">先打开收件箱的设备会领取</span></span>
    </label>`,
    ...devices.map(
      (device) => `<label style="display:flex;align-items:center;gap:10px;padding:11px 0;border-bottom:1px solid var(--m-line)">
        <input type="radio" name="m-target" value="${escapeAttr(device.id)}" />
        <span><b style="display:block;font-size:12.5px">${escapeHtml(device.name)}</b><span style="font-size:10px;color:var(--m-dim)">${escapeHtml(device.browser)} · ${device.presence === "active" ? "在线" : "等待上线"}</span></span>
      </label>`,
    ),
  ].join("");

  let targetDevice = "";
  let ttlMs = 259_200_000;
  const value = await openSheet({
    title: `发送「${title}」`,
    body: `<p style="margin:0 0 6px;font-size:11px;color:var(--m-dim)">选择接收设备。内容会保存在云端，目标设备上线后可以在收件箱打开。</p>
      <div>${options}</div>
      <label style="display:block;margin-top:12px;font-size:10px;color:var(--m-dim)">有效期
        <select class="m-input" data-send-ttl>
          <option value="3600000">1 小时</option>
          <option value="86400000">24 小时</option>
          <option value="259200000" selected>3 天</option>
          <option value="604800000">7 天</option>
        </select>
      </label>`,
    actions: [
      { label: "取消", value: "" },
      { label: "发送", value: "send", primary: true },
    ],
    onMount(sheet) {
      sheet.querySelectorAll<HTMLInputElement>('input[name="m-target"]').forEach((input) => {
        input.addEventListener("change", () => {
          if (input.checked) targetDevice = input.value;
        });
      });
      const select = sheet.querySelector<HTMLSelectElement>("[data-send-ttl]");
      select?.addEventListener("change", () => {
        ttlMs = Number(select.value) || ttlMs;
      });
    },
  });
  if (value !== "send") return;

  const body = {
    itemType,
    title,
    resourceId,
    payload,
    targetDeviceId: targetDevice || null,
    ttlMs,
  };

  if (!isOnline()) {
    outbox.add({ id: crypto.randomUUID(), kind: "continuity", at: Date.now(), body });
    toast("离线：已加入待发送队列");
    paint();
    return;
  }

  try {
    const result = await continuityApi.send(body);
    toast(`已发送给${result.targetName || "任一设备"}`);
    void refreshInbox();
  } catch (error) {
    toast((error as Error).message || "发送失败", "danger");
  }
}

async function openContinuity(item: ContinuityItem) {
  if (!state.account?.authenticated) {
    toast("登录后才能接收接力内容", "danger");
    return;
  }
  try {
    const opened = await continuityApi.open(item.id);
    const fresh = opened.item;
    const payload = fresh.payload as Record<string, unknown>;

    if (fresh.itemType === "note") {
      const existing = notesStore.get(fresh.resourceId || "");
      const note =
        existing ??
        notesStore.create({
          title: String(payload.title || fresh.title || "接力笔记"),
          body: String(payload.body || ""),
          tags: ["接力"],
        });
      await continuityApi.complete(fresh.id).catch(() => undefined);
      navigate({ tab: "notes", noteId: note.id, sub: null });
      toast(existing ? "已打开本地笔记" : "已保存为本地笔记");
      void refreshInbox();
      return;
    }

    if (fresh.itemType === "task") {
      const task = taskStore.add({
        title: String(payload.title || fresh.title || "接力任务"),
        note: String(payload.note || ""),
        priority: (payload.priority as Task["priority"]) || "normal",
        due: String(payload.due || todayKey()),
        category: String(payload.category || "other"),
      });
      await continuityApi.complete(fresh.id).catch(() => undefined);
      navigate({ tab: "tasks" });
      toast(`已加入任务：${task.title}`);
      void refreshInbox();
      return;
    }

    if (fresh.itemType === "event") {
      const event = calendarStore.add({
        title: String(payload.title || fresh.title || "接力日程"),
        date: String(payload.date || todayKey()),
        time: String(payload.time || ""),
        category: String(payload.category || "other"),
        note: String(payload.note || ""),
      });
      await continuityApi.complete(fresh.id).catch(() => undefined);
      navigate({ tab: "calendar", sub: null });
      toast(`已加入日程：${event.title}`);
      void refreshInbox();
      return;
    }

    if (fresh.itemType === "file") {
      navigate({ sub: "files" });
      window.setTimeout(() => void openFile(fresh.resourceId || ""), 120);
      toast("已打开云端文件");
      return;
    }

    if (fresh.itemType === "link") {
      const url = String(payload.url || "");
      if (/^https?:\/\//i.test(url)) {
        window.open(url, "_blank", "noopener,noreferrer");
        await continuityApi.complete(fresh.id).catch(() => undefined);
        void refreshInbox();
      } else {
        toast("链接格式不正确", "danger");
      }
      return;
    }

    if (fresh.itemType === "reading") {
      await openSheet({
        title: fresh.title,
        body: `<p style="font-size:12px;line-height:1.7;color:var(--m-dim)">阅读进度：${Math.round(Number(payload.progress || 0) * 100)}%</p>
          ${payload.url ? `<p style="font-size:10.5px;word-break:break-all;color:var(--m-faint)">${escapeHtml(payload.url)}</p>` : ""}`,
        actions: [{ label: "完成接力", value: "done", primary: true }],
      }).then((value) => {
        if (value === "done") void continuityApi.complete(fresh.id).then(() => void refreshInbox());
      });
      return;
    }

    if (fresh.itemType === "workspace") {
      const workspace = payload.workspace as Record<string, unknown> | undefined;
      await openSheet({
        title: String(workspace?.name || fresh.title || "工作空间"),
        body: `<p style="font-size:12px;line-height:1.7;color:var(--m-dim)">这是一个桌面工作空间布局。手机端不使用窗口坐标，无法在这里恢复窗口排列；云端配置保留。</p>
          <p style="font-size:10.5px;color:var(--m-faint)">在桌面版打开这条接力，可以按当前屏幕重新排布。</p>`,
        actions: [{ label: "知道了", value: "done", primary: true }],
      });
      await continuityApi.complete(fresh.id).catch(() => undefined);
      void refreshInbox();
      return;
    }

    // app / 其他：给出可执行的下一步，而不是假装已经恢复。
    const appTitle = String(payload.appTitle || payload.resourceTitle || fresh.title);
    await openSheet({
      title: appTitle,
      body: `<p style="font-size:12px;line-height:1.7;color:var(--m-dim)">这条内容来自桌面应用。手机端暂不提供该应用的完整编辑界面，可以在桌面版继续。</p>`,
      actions: [{ label: "知道了", value: "done", primary: true }],
    });
    await continuityApi.complete(fresh.id).catch(() => undefined);
    void refreshInbox();
  } catch (error) {
    toast((error as Error).message || "打开失败", "danger");
  }
}

async function openFile(id: string) {
  const file = state.files.find((item) => item.id === id);
  if (!file) return;
  const isImage = file.category === "image";
  const value = await openSheet({
    title: file.name,
    body: `${isImage ? `<img src="/api/files/${encodeURIComponent(file.id)}/content" alt="" style="width:100%;border-radius:14px;margin-bottom:10px" loading="lazy" />` : ""}
      <p style="margin:0;font-size:11px;color:var(--m-dim)">${escapeHtml(fmtBytes(file.sizeBytes))} · ${escapeHtml(file.mimeType)} · ${escapeHtml(fmtAgo(file.updatedAt))}</p>`,
    actions: [
      { label: "发送到设备", value: "send" },
      { label: "下载", value: "download", primary: true },
    ],
  });
  if (value === "download") {
    window.location.href = `/api/files/${encodeURIComponent(file.id)}/download`;
  }
  if (value === "send") {
    void sendItem("file", file.name, file.id, {
      name: file.name,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes,
      category: file.category,
    });
  }
}

/* ============================================================
   配对
   ============================================================ */

async function createPairing() {
  if (!state.account?.authenticated) {
    toast("先登录才能配对设备", "danger");
    return;
  }
  try {
    const created = await pairingApi.create();
    let qr = "";
    try {
      qr = await qrSvg(created.qrUrl);
    } catch {
      qr = "";
    }
    state.pairing = { ...created, pending: [], qr };
    navigate({ sub: "devices" });
    toast("配对码已生成，10 分钟内有效");
    startPairingPoll();
  } catch (error) {
    toast((error as Error).message || "生成配对码失败", "danger");
  }
}

function startPairingPoll() {
  window.clearInterval(pairingTimer);
  pairingTimer = window.setInterval(async () => {
    if (!state.pairing) {
      window.clearInterval(pairingTimer);
      return;
    }
    try {
      const list = await pairingApi.list();
      const mine = list.items.find((item) => item.id === state.pairing?.pairingId);
      if (!mine) return;
      const pending = mine.status === "claimed" ? [mine] : [];
      const changed = pending.length !== state.pairing.pending.length;
      state.pairing.pending = pending;
      if (changed) paint();
    } catch {
      /* 轮询失败不打扰 */
    }
  }, 3000);
}

async function confirmPairing(id: string) {
  try {
    const result = await pairingApi.confirm(id);
    toast(`已批准「${result.device.name}」`);
    state.pairing = null;
    window.clearInterval(pairingTimer);
    await refreshDevices();
    paint();
  } catch (error) {
    toast((error as Error).message || "批准失败", "danger");
  }
}

/* ============================================================
   数据刷新
   ============================================================ */

/**
 * 补发离线队列。
 *
 * 1.9 修复：旧实现里 `outbox.flush()` 把所有 4xx 都当永久失败直接丢弃，
 * 其中包含 401（登录过期）。用户在离线时写的内容会在重新联网、而会话已过期时
 * 被静默删除。现在 401 会保留队列并提示重新登录，只有真正无效的内容才丢弃。
 */
async function flushOutbox(): Promise<void> {
  try {
    const result = await outbox.flush();
    if (result.needsLogin) {
      toast("登录状态已过期，待发送内容已保留，重新登录后会继续补发");
      return;
    }
    if (result.sent) {
      toast(`已补发 ${result.sent} 条待发送内容`);
      paint();
    }
    if (result.discarded) {
      toast(`${result.discarded} 条内容因目标设备失效已被移除`);
    }
  } catch {
    /* 补发失败不阻塞主流程，下一次轮询会继续 */
  }
}

async function refreshInbox() {
  if (!state.account?.authenticated || !isOnline()) return;
  const inbox = await loadInbox();
  if (!inbox) return;
  const pending = inbox.items.filter((item) => item.status !== "completed" && item.status !== "cancelled");
  const changed = pending.length !== state.inbox.length;
  state.inbox = pending;
  if (changed) paint();
}

async function refreshDevices() {
  if (!state.account?.authenticated) return;
  state.devices = await loadDevices();
}

async function refreshFiles() {
  if (!state.account?.authenticated) return;
  try {
    state.files = await loadFiles();
  } catch {
    state.files = [];
  }
}

async function refreshClipboard() {
  if (!state.account?.authenticated) return;
  state.clipboard = await loadClipboard();
}

async function refreshAll() {
  await refreshDevices();
  await Promise.all([refreshInbox(), refreshFiles(), refreshClipboard()]);
  state.contexts = await loadContexts();
  state.history = await loadHistory();
  paint();
}

/* ============================================================
   事件
   ============================================================ */

root.addEventListener("click", (event) => {
  const target = event.target as HTMLElement;
  const action = target.closest<HTMLElement>("[data-m-act]")?.dataset.mAct;
  const data = target.closest<HTMLElement>("[data-m-act]")?.dataset ?? {};

  if (!action) return;

  switch (action) {
    case "tab":
      state.taskFilter = "today";
      navigate({ tab: (data.tab as Tab) || "home", sub: null, noteId: null });
      return;
    case "sub":
      navigate({ sub: (data.sub as Sub) ?? null, noteId: null });
      return;
    case "back":
      if (window.history.state) window.history.back();
      else navigate({ tab: "home", sub: null, noteId: null }, { replace: true });
      return;
    case "new-note": {
      const note = notesStore.create({ title: "", body: "" });
      navigate({ tab: "notes", noteId: note.id, sub: null });
      return;
    }
    case "open-note":
      navigate({ tab: "notes", noteId: data.id ?? null, sub: null });
      return;
    case "toggle-pin": {
      const note = notesStore.get(state.noteId || "");
      if (!note) return;
      notesStore.update(note.id, { pinned: !note.pinned });
      paint();
      return;
    }
    case "delete-note": {
      const note = notesStore.get(state.noteId || "");
      if (!note) return;
      void confirmSheet(`删除「${note.title || "未命名笔记"}」？此操作不可撤销。`, "删除").then((ok) => {
        if (!ok) return;
        notesStore.remove(note.id);
        navigate({ tab: "notes", noteId: null, sub: null }, { replace: true });
        toast("笔记已删除");
      });
      return;
    }
    case "send-note": {
      const note = notesStore.get(state.noteId || "");
      if (!note) return;
      void sendItem("note", note.title || "未命名笔记", note.id, {
        title: note.title,
        body: note.body,
        folder: note.folder,
        tags: note.tags,
        pinned: note.pinned,
        updatedAt: note.updatedAt,
      });
      return;
    }
    case "task-filter":
      state.taskFilter = (data.filter as State["taskFilter"]) || "open";
      paint();
      return;
    case "toggle-task":
      taskStore.toggle(data.id || "");
      paint();
      return;
    case "new-task":
      openTaskSheet();
      return;
    case "edit-task":
      openTaskSheet(taskStore.list().find((task) => task.id === data.id));
      return;
    case "cal-prev":
      state.calMonth = new Date(state.calMonth.getFullYear(), state.calMonth.getMonth() - 1, 1);
      paint();
      return;
    case "cal-next":
      state.calMonth = new Date(state.calMonth.getFullYear(), state.calMonth.getMonth() + 1, 1);
      paint();
      return;
    case "cal-today":
      state.calMonth = new Date();
      state.calDay = todayKey();
      paint();
      return;
    case "cal-day":
      state.calDay = data.day || todayKey();
      paint();
      return;
    case "new-event":
      openEventSheet();
      return;
    case "open-event":
      openEventSheet(data.id);
      return;
    case "open-item":
      {
        const item = state.inbox.find((entry) => entry.id === data.id) || null;
        if (item) void openContinuity(item);
      }
      return;
    case "open-file":
      void openFile(data.id || "");
      return;
    case "quick-upload":
      document.getElementById("m-file")?.click();
      return;
    case "clip-send": {
      const input = root.querySelector<HTMLTextAreaElement>('[data-m-input="clip-text"]');
      const content = input?.value.trim() || "";
      if (!content) {
        toast("先输入要发送的文字", "danger");
        return;
      }
      if (!state.account?.authenticated) {
        toast("登录后才能跨设备发送", "danger");
        return;
      }
      if (!isOnline()) {
        outbox.add({ id: crypto.randomUUID(), kind: "clipboard", at: Date.now(), content });
        toast("离线：已加入待发送队列");
        if (input) input.value = "";
        paint();
        return;
      }
      void clipboardApi
        .send(content)
        .then(() => {
          toast("已发送到其他设备");
          if (input) input.value = "";
          return refreshClipboard().then(paint);
        })
        .catch((error) => toast((error as Error).message || "发送失败", "danger"));
      return;
    }
    case "clip-clear": {
      const input = root.querySelector<HTMLTextAreaElement>('[data-m-input="clip-text"]');
      if (input) input.value = "";
      return;
    }
    case "clip-refresh":
      void refreshClipboard().then(paint);
      return;
    case "clip-copy": {
      const item = state.clipboard.find((entry) => entry.id === data.id);
      if (!item) return;
      void copyText(item.content);
      return;
    }
    case "clip-delete":
      void clipboardApi.remove(data.id || "").then(() => refreshClipboard()).then(paint);
      return;
    case "revoke-device":
      void confirmSheet(`撤销「${data.name || "这台设备"}」？该设备上的登录会立即失效。`, "撤销").then(async (ok) => {
        if (!ok) return;
        try {
          await revokeDevice(data.id || "");
          await refreshDevices();
          paint();
          toast("设备已撤销");
        } catch (error) {
          toast((error as Error).message || "撤销失败", "danger");
        }
      });
      return;
    case "pair-create":
      void createPairing();
      return;
    case "pair-confirm":
      void confirmPairing(data.id || "");
      return;
    case "pair-cancel":
      if (state.pairing) void pairingApi.cancel(state.pairing.pairingId).catch(() => undefined);
      state.pairing = null;
      window.clearInterval(pairingTimer);
      paint();
      return;
    case "set-shell":
      setPreference((data.pref as ShellPreference) || "auto");
      return;
    case "install-pwa":
      if (state.installPrompt) {
        void state.installPrompt.prompt();
      } else {
        toast("请用浏览器菜单「添加到主屏幕」");
      }
      return;
    case "check-update":
      void checkForUpdate().then((found) => toast(found ? "发现新版本，刷新后生效" : "已是最新版本"));
      return;
    case "push-status":
      if (!state.account?.authenticated) {
        toast("登录后可以查看推送状态");
        return;
      }
      void pushApi
        .status()
        .then((status) =>
          openSheet({
            title: "跨设备通知",
            body: `<p style="margin:0;font-size:12px;line-height:1.7;color:var(--m-dim)">${escapeHtml(status.reason)}</p>`,
            actions: [{ label: "知道了", value: "ok", primary: true }],
          }),
        )
        .catch((error) => toast((error as Error).message || "读取失败", "danger"));
      return;
    case "clear-cache":
      void clearOfflineCache();
      return;
    case "logout":
      void logout();
      return;
    default:
      return;
  }
});

root.addEventListener("input", (event) => {
  const target = event.target as HTMLElement;
  const field = target.dataset.mInput;
  if (!field) return;

  if (field === "note-search") {
    state.noteQuery = (target as HTMLInputElement).value;
    paint();
    const input = root.querySelector<HTMLInputElement>('[data-m-input="note-search"]');
    input?.focus();
    input?.setSelectionRange(state.noteQuery.length, state.noteQuery.length);
    return;
  }

  if (field === "note-title" || field === "note-body") {
    const note = notesStore.get(state.noteId || "");
    if (!note) return;
    const patch = field === "note-title" ? { title: (target as HTMLInputElement).value } : { body: (target as HTMLTextAreaElement).value };
    notesStore.update(note.id, patch);
    const saved = root.querySelector<HTMLElement>("[data-m-saved]");
    if (saved) saved.textContent = "正在保存…";
    if (field === "note-body") {
      const count = root.querySelector<HTMLElement>("[data-m-count]");
      if (count) count.textContent = String((target as HTMLTextAreaElement).value.length);
    }
    if (field === "note-body") {
      const count = root.querySelector<HTMLElement>("[data-m-count]");
      if (count) count.textContent = String((target as HTMLTextAreaElement).value.length);
    }
    window.clearTimeout(noteSaveTimer);
    noteSaveTimer = window.setTimeout(() => {
      const node = root.querySelector<HTMLElement>("[data-m-saved]");
      if (node) node.textContent = "已保存";
    }, 420);
  }
});

document.getElementById("m-file")?.addEventListener("change", (event) => {
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  input.value = "";
  if (!files.length) return;
  if (!state.account?.authenticated) {
    toast("登录后才能上传文件", "danger");
    return;
  }
  void (async () => {
    for (const file of files) {
      try {
        toast(`正在上传 ${file.name}`);
        const uploaded = await uploadFile(file);
        state.files.unshift(uploaded);
        toast(`已上传 ${uploaded.name}`);
      } catch (error) {
        toast((error as Error).message || "上传失败", "danger");
      }
    }
    paint();
  })();
});

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast("已复制");
    return;
  } catch {
    /* 降级 */
  }
  await openSheet({
    title: "手动复制",
    body: `<p style="margin:0 0 8px;font-size:11px;color:var(--m-dim)">浏览器拒绝了自动复制，请长按下面的文字选择复制。</p>
      <textarea class="m-input" rows="5" readonly>${escapeHtml(text)}</textarea>`,
    actions: [{ label: "完成", value: "ok", primary: true }],
  });
}

async function clearOfflineCache() {
  try {
    if ("caches" in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
    }
    toast("离线缓存已清理，笔记与账号未受影响");
  } catch {
    toast("清理失败", "danger");
  }
}

async function logout() {
  const ok = await confirmSheet("退出后这台设备需要重新登录，未发送的接力会保留在本机队列。", "退出登录");
  if (!ok) return;
  try {
    await fetch("/api/auth/logout", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
    });
    state.account = { authenticated: false, user: null };
    state.devices = null;
    state.inbox = [];
    state.clipboard = [];
    state.files = [];
    state.pairing = null;
    paint();
    toast("已退出登录");
  } catch {
    toast("退出失败，请稍后再试", "danger");
  }
}

/* ============================================================
   启动
   ============================================================ */

async function boot() {
  applyMobileTheme();
  initPwa();
  history.replaceState({ tab: "home", sub: null, noteId: null } satisfies Route, "");

  state.loading = true;
  paint();

  state.account = await loadAccount();

  if (state.account.authenticated) {
    try {
      state.push = await pushApi.status();
    } catch {
      state.push = null;
    }
    await refreshDevices();
    await Promise.all([refreshInbox(), refreshFiles(), refreshClipboard()]);
    state.contexts = await loadContexts();
    state.history = await loadHistory();
    await flushOutbox();
  }

  state.loading = false;
  paint();

  window.clearInterval(pollTimer);
  pollTimer = window.setInterval(() => {
    if (document.visibilityState === "visible") {
      void refreshInbox();
      void flushOutbox();
    }
  }, 60_000);

  window.addEventListener("online", () => {
    toast("网络已恢复");
    void flushOutbox();
    void refreshInbox();
    paint();
  });
  window.addEventListener("offline", () => paint());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void refreshInbox();
  });
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    state.installPrompt = event as unknown as { prompt: () => Promise<void> };
  });

  const scroller = () => {
    const top = root?.querySelector<HTMLElement>(".m-top");
    if (top) top.classList.toggle("is-scrolled", window.scrollY > 4);
  };
  window.addEventListener("scroll", scroller, { passive: true });
  scroller();
}

// 桌面 / 平板访问 /m/ 时回到对应外壳；手机与手动指定手机模式留在本页。
// 2.0：移动端也接上质量层（全局错误捕获 + 在线状态），
// 1.9 之前只有桌面外壳装了这两个，手机端出错完全不可见。
installGlobalErrorHandlers();
initConnectivity();
initAdaptiveShell("mobile");
if (resolveMode() === "mobile") void boot();
