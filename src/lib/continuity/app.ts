/**
 * 接力中心（桌面）
 *
 * 收件箱、已发送、跨设备剪贴板、其他设备上下文。
 * 所有状态来自 /api/continuity、/api/clipboard 与真实运行结果。
 */

// 1.9：应用样式跟着应用代码一起按需加载，不再压进首屏 CSS
import "../../styles/continuity.css";
import { escapeHtml, fmtAgo, modal, type Ctx } from "../os14/core";
import { notesStore } from "../os14/apps/notes";
import { calendarStore } from "../os14/apps/calendar";
import { taskStore } from "../os14/tasks-store";
import { applyWorkspace, importCommunityWorkspace } from "../os14/workspaces";
import {
  clipboardApi,
  continuityApi,
  type ClipboardItem,
  type ContextItem,
  type ContinuityItem,
} from "./client";
import { ITEM_META, summarize } from "./payloads";

type ViewId = "overview" | "inbox" | "sent" | "clipboard" | "context";

const NAV: Array<{ id: ViewId; label: string; hint: string; glyph: string }> = [
  { id: "overview", label: "Overview", hint: "继续未完成的工作", glyph: "◈" },
  { id: "inbox", label: "Inbox", hint: "其他设备发来的内容", glyph: "⇣" },
  { id: "sent", label: "Sent", hint: "已发送与状态", glyph: "⇡" },
  { id: "clipboard", label: "Clipboard", hint: "跨设备纯文本", glyph: "▤" },
  { id: "context", label: "Devices", hint: "其他设备进度", glyph: "▣" },
];

const STATUS_LABEL: Record<string, string> = {
  pending: "等待设备上线",
  delivered: "已送达",
  opened: "已打开",
  completed: "已完成",
  cancelled: "已取消",
  expired: "已过期",
};

export const renderContinuity = () => `
  <div class="cty-app" data-cx>
    <aside class="cty-side">
      <div class="cty-brand">
        <span class="cty-brand-logo">⇄</span>
        <div><b>Guandao Continuity</b><i>Pick Up Where You Left Off</i></div>
      </div>
      <nav class="cty-nav" data-cty-nav>
        ${NAV.map(
          (item) => `<button type="button" class="cty-nav-item" data-cty-view="${item.id}">
            <span class="cty-nav-ico">${item.glyph}</span>
            <span><b>${item.label}</b><i>${item.hint}</i></span>
          </button>`,
        ).join("")}
      </nav>
      <div class="cty-side-foot">
        <p class="cty-side-label">当前设备</p>
        <b data-cty-device>—</b>
        <span data-cty-device-sub>正在读取…</span>
        <button type="button" class="cty-side-action" data-cty-act="clipboard-quick">发送剪贴板</button>
      </div>
    </aside>
    <section class="cty-main">
      <header class="cty-top">
        <div><p class="cty-eyebrow">GUANDAO OS 2.0 · CONTINUITY</p><h1 data-cty-title>Overview</h1><p class="cty-sub" data-cty-sub>正在读取接力内容…</p></div>
        <div class="cty-top-actions">
          <span class="cty-chip" data-cty-status>—</span>
          <button type="button" class="cty-icon-btn" data-cty-act="refresh" title="刷新" aria-label="刷新">↻</button>
        </div>
      </header>
      <div class="cty-scroll" data-cty-body>
        <div class="cty-loading"><span></span><p>正在读取云端接力…</p></div>
      </div>
    </section>
  </div>`;

export const initContinuity = (win: HTMLElement, ctx: Ctx): (() => void) => {
  const rootEl = win.querySelector<HTMLElement>("[data-cx]");
  if (!rootEl) return () => undefined;
  // 断言一次并保留同名变量：下面大量嵌套函数会引用 root，
  // 直接依赖收窄会失效（TS 对函数声明不做跨闭包收窄）。
  const root: HTMLElement = rootEl;

  const body = root.querySelector<HTMLElement>("[data-cty-body]")!;
  const title = root.querySelector<HTMLElement>("[data-cty-title]")!;
  const sub = root.querySelector<HTMLElement>("[data-cty-sub]")!;
  const chip = root.querySelector<HTMLElement>("[data-cty-status]")!;
  const deviceName = root.querySelector<HTMLElement>("[data-cty-device]")!;
  const deviceSub = root.querySelector<HTMLElement>("[data-cty-device-sub]")!;

  let view: ViewId = "overview";
  let inbox: ContinuityItem[] = [];
  let history: ContinuityItem[] = [];
  let clipboard: ClipboardItem[] = [];
  let contexts: ContextItem[] = [];
  let currentDeviceId = "";
  let loading = true;
  let error = "";
  let busy = false;

  const meta = (id: ViewId) => NAV.find((item) => item.id === id) ?? NAV[0];

  const paintNav = () => {
    root.querySelectorAll<HTMLElement>("[data-cty-view]").forEach((node) => {
      node.classList.toggle("is-active", node.dataset.ctyView === view);
    });
  };

  const paintChrome = () => {
    const info = meta(view);
    title.textContent = info.label;
    sub.textContent = info.hint;
    chip.textContent = `${inbox.length} 待接收 · ${history.length} 记录`;
    deviceName.textContent = currentDeviceId ? "这台设备" : "未登录";
    deviceSub.textContent = currentDeviceId ? `${inbox.length} 条待处理 · ${clipboard.length} 条剪贴板` : "登录后启用跨设备接力";
  };

  const statusBadge = (status: string) => {
    const tone = status === "completed" ? "ok" : status === "cancelled" || status === "expired" ? "mute" : status === "delivered" || status === "opened" ? "accent" : "warn";
    return `<span class="cty-badge is-${tone}">${STATUS_LABEL[status] ?? status}</span>`;
  };

  const itemRow = (item: ContinuityItem, direction: "in" | "out") => `
    <article class="cty-item">
      <div class="cty-item-ico">${escapeHtml(ITEM_META[item.itemType]?.glyph ?? "◆")}</div>
      <div class="cty-item-main">
        <div class="cty-item-top"><b>${escapeHtml(item.title)}</b>${statusBadge(item.status)}</div>
        <p>${escapeHtml(summarize(item.itemType, item.payload))}</p>
        <div class="cty-item-meta">
          <span>${direction === "in" ? `来自 ${escapeHtml(item.sourceName)}` : `发送给 ${escapeHtml(item.targetName)}`}</span>
          <span>·</span>
          <span>${escapeHtml(fmtAgo(item.createdAt))}</span>
          <span>·</span>
          <span>${escapeHtml(ITEM_META[item.itemType]?.label ?? item.itemType)}</span>
        </div>
      </div>
      <div class="cty-item-acts">
        ${
          direction === "in" && item.status !== "completed"
            ? `<button type="button" class="g14-btn is-primary" data-cty-act="open-item" data-id="${escapeHtml(item.id)}">打开</button>`
            : ""
        }
        ${
          direction === "in" && item.status === "opened"
            ? `<button type="button" class="g14-btn is-ghost" data-cty-act="complete-item" data-id="${escapeHtml(item.id)}">标记完成</button>`
            : ""
        }
        ${
          direction === "out" && ["pending", "delivered"].includes(item.status)
            ? `<button type="button" class="g14-btn is-ghost" data-cty-act="cancel-item" data-id="${escapeHtml(item.id)}">取消</button>`
            : ""
        }
      </div>
    </article>`;

  const overview = () => {
    const incoming = inbox.filter((item) => item.status !== "completed");
    const notes = notesStore.list().slice(0, 3);
    const tasks = taskStore.list().filter((task) => !task.done).slice(0, 3);
    const others = contexts.filter((context) => !context.current);

    return `
      <section class="cty-block">
        <div class="cty-block-head"><h2>继续工作</h2><span>${incoming.length ? `${incoming.length} 条待接收` : "没有待接收内容"}</span></div>
        ${
          incoming.length
            ? `<div class="cty-list">${incoming.slice(0, 4).map((item) => itemRow(item, "in")).join("")}</div>`
            : `<div class="cty-empty"><span>⇣</span><b>暂时没有新的接力</b><p>在笔记、任务、日程或云盘里点「发送到设备」。</p></div>`
        }
      </section>

      <section class="cty-block">
        <div class="cty-block-head"><h2>在这台设备继续</h2><span>本机最近内容</span></div>
        <div class="cty-cards">
          ${notes
            .map(
              (note) => `<button type="button" class="cty-card" data-cty-act="resume-note" data-id="${escapeHtml(note.id)}">
                <span>✎</span><b>${escapeHtml(note.title || "未命名笔记")}</b><i>${escapeHtml(fmtAgo(note.updatedAt))}</i>
              </button>`,
            )
            .join("")}
          ${tasks
            .map(
              (task) => `<button type="button" class="cty-card" data-cty-act="open-tasks">
                <span>✓</span><b>${escapeHtml(task.title)}</b><i>${task.due ? `截止 ${escapeHtml(task.due)}` : "无截止日期"}</i>
              </button>`,
            )
            .join("")}
          ${
            !notes.length && !tasks.length
              ? `<div class="cty-empty"><b>还没有本地内容</b><p>先去写一篇笔记或建一个任务。</p></div>`
              : ""
          }
        </div>
      </section>

      ${
        others.length
          ? `<section class="cty-block">
              <div class="cty-block-head"><h2>其他设备</h2><span>语义化进度</span></div>
              <div class="cty-list">${others
                .map(
                  (context) => `<div class="cty-item">
                    <div class="cty-item-ico">▣</div>
                    <div class="cty-item-main">
                      <div class="cty-item-top"><b>${escapeHtml(context.deviceName)}</b><span class="cty-badge is-mute">${escapeHtml(context.appId)}</span></div>
                      <p>${escapeHtml(context.resourceTitle || "没有具体内容")}</p>
                      <div class="cty-item-meta"><span>${escapeHtml(fmtAgo(context.updatedAt))}</span></div>
                    </div>
                  </div>`,
                )
                .join("")}</div>
              <p class="cty-fine">这里只显示应用与内容标题，不同步窗口坐标，也不会远程操作那台设备。</p>
            </section>`
          : ""
      }`;
  };

  const inboxView = () =>
    inbox.length
      ? `<div class="cty-list">${inbox.map((item) => itemRow(item, "in")).join("")}</div>`
      : `<div class="cty-empty"><span>⇣</span><b>收件箱是空的</b><p>其他设备发来的笔记、任务、日程与文件会出现在这里。</p></div>`;

  const sentView = () => {
    const outgoing = history.filter((item) => item.outgoing);
    return outgoing.length
      ? `<div class="cty-list">${outgoing.map((item) => itemRow(item, "out")).join("")}</div>`
      : `<div class="cty-empty"><span>⇡</span><b>还没有发送记录</b><p>发送后会记录目标设备与真实状态。</p></div>`;
  };

  const clipboardView = () => `
    <section class="cty-block">
      <div class="cty-block-head"><h2>发送文字</h2><span>只发送你明确提交的内容</span></div>
      <div class="cty-clip-compose">
        <textarea class="g14-input" data-cty-clip-input rows="3" maxlength="4000" placeholder="粘贴或输入要发送到其他设备的纯文本…"></textarea>
        <div class="cty-clip-actions">
          <p>不会后台读取系统剪贴板；内容 24 小时后过期。</p>
          <button type="button" class="g14-btn is-primary" data-cty-act="send-clip">发送</button>
        </div>
      </div>
    </section>
    <section class="cty-block">
      <div class="cty-block-head"><h2>最近</h2><span>${clipboard.length} 条</span></div>
      ${
        clipboard.length
          ? `<div class="cty-clip-list">${clipboard
              .map(
                (item) => `<article class="cty-clip">
                  <p>${escapeHtml(item.content)}</p>
                  <div><span>${escapeHtml(item.sourceName)} · ${escapeHtml(fmtAgo(item.createdAt))}</span>
                    <button type="button" data-cty-act="copy-clip" data-id="${escapeHtml(item.id)}">复制</button>
                    <button type="button" data-cty-act="delete-clip" data-id="${escapeHtml(item.id)}">删除</button>
                  </div>
                </article>`,
              )
              .join("")}</div>`
          : `<div class="cty-empty"><b>还没有剪贴板记录</b><p>在任意设备发送一段文字后会出现在这里。</p></div>`
      }
    </section>`;

  const contextView = () => {
    const others = contexts.filter((context) => !context.current);
    return `<section class="cty-block">
      <div class="cty-block-head"><h2>其他设备上的进度</h2><span>${others.length} 台</span></div>
      ${
        others.length
          ? `<div class="cty-list">${others
              .map(
                (context) => `<div class="cty-item">
                  <div class="cty-item-ico">▣</div>
                  <div class="cty-item-main">
                    <div class="cty-item-top"><b>${escapeHtml(context.resourceTitle || context.appId)}</b><span class="cty-badge is-mute">${escapeHtml(context.appId)}</span></div>
                    <p>${escapeHtml(context.deviceName)}${context.workspaceId ? ` · 工作空间 ${escapeHtml(context.workspaceId)}` : ""}</p>
                    <div class="cty-item-meta"><span>${escapeHtml(fmtAgo(context.updatedAt))}</span></div>
                  </div>
                </div>`,
              )
              .join("")}</div>`
          : `<div class="cty-empty"><b>没有其他设备的进度</b><p>在另一台设备打开应用后，这里会显示语义化状态。</p></div>`
      }
      <p class="cty-fine">应用上下文只包含应用、内容标题与工作空间 ID，不包含窗口坐标、Cookie 或私人正文。</p>
    </section>`;
  };

  const paint = () => {
    if (!root) return;
    paintNav();
    paintChrome();
    if (loading) {
      body.innerHTML = `<div class="cty-loading"><span></span><p>正在读取云端接力…</p></div>`;
      return;
    }
    if (error) {
      const needsLogin = error.includes("登录");
      body.innerHTML = `<div class="cty-empty"><b>${needsLogin ? "需要登录 Guandao Account" : "读取失败"}</b><p>${escapeHtml(error)}</p>
        <button type="button" class="g14-btn is-primary" data-cty-act="${needsLogin ? "login" : "refresh"}">${needsLogin ? "去登录" : "重试"}</button></div>`;
      return;
    }
    body.innerHTML =
      view === "overview"
        ? overview()
        : view === "inbox"
          ? inboxView()
          : view === "sent"
            ? sentView()
            : view === "clipboard"
              ? clipboardView()
              : contextView();
  };

  const load = async () => {
    loading = true;
    error = "";
    paint();
    try {
      const me = await fetch("/api/auth/me", {
        credentials: "same-origin",
        headers: { accept: "application/json" },
      }).then((response) => response.json());
      if (!me?.authenticated) {
        loading = false;
        error = "请先登录 Guandao Account 再使用接力。";
        paint();
        return;
      }
      const [inboxResult, historyResult, clipboardResult, contextResult] = await Promise.all([
        continuityApi.inbox(),
        continuityApi.history(),
        clipboardApi.list(),
        continuityApi.contexts(),
      ]);
      inbox = inboxResult.items;
      currentDeviceId = inboxResult.currentDeviceId;
      history = historyResult.items;
      clipboard = clipboardResult.items;
      contexts = contextResult.items;
      loading = false;
    } catch (err) {
      loading = false;
      const status = (err as { status?: number }).status;
      error = status === 401 ? "请先登录 Guandao Account 再使用接力。" : (err as Error).message || "网络异常";
    }
    paint();
  };

  void load();
  const refreshTimer = window.setInterval(() => {
    if (document.visibilityState === "visible" && view !== "clipboard") void load();
  }, 60_000);
  const onInbox = () => void load();
  window.addEventListener("guandao:continuity-inbox", onInbox);

  /* ------------------------------ 打开接力 ------------------------------ */

  async function openItem(id: string) {
    if (busy) return;
    busy = true;
    try {
      const result = await continuityApi.open(id);
      const item = result.item;
      const payload = item.payload as Record<string, unknown>;

      if (item.itemType === "note") {
        let note = item.resourceId ? notesStore.get(item.resourceId) : null;
        if (!note) {
          note = notesStore.create({
            title: String(payload.title || item.title || "接力笔记"),
            body: String(payload.body || ""),
            tags: ["接力"],
          });
        }
        notesStore.select(note.id);
        ctx.openApp("notes");
        ctx.toast("已在 Notes 打开");
        await continuityApi.complete(id).catch(() => undefined);
      } else if (item.itemType === "task") {
        taskStore.add({
          title: String(payload.title || item.title || "接力任务"),
          note: String(payload.note || ""),
          priority: (payload.priority as "low" | "normal" | "high") || "normal",
          due: String(payload.due || ""),
          category: String(payload.category || "other"),
        });
        ctx.openApp("tasks");
        ctx.toast("已加入任务中心");
        await continuityApi.complete(id).catch(() => undefined);
      } else if (item.itemType === "event") {
        calendarStore.add({
          title: String(payload.title || item.title || "接力日程"),
          date: String(payload.date || ""),
          time: String(payload.time || ""),
          category: String(payload.category || "other"),
          note: String(payload.note || ""),
        });
        ctx.openApp("calendar");
        ctx.toast("已加入日历");
        await continuityApi.complete(id).catch(() => undefined);
      } else if (item.itemType === "file") {
        ctx.openApp("drive");
        ctx.toast(`已打开云盘，文件：${String(payload.name || item.title)}`);
      } else if (item.itemType === "link") {
        const url = String(payload.url || "");
        if (/^https?:\/\//i.test(url)) {
          window.open(url, "_blank", "noopener,noreferrer");
          await continuityApi.complete(id).catch(() => undefined);
          ctx.toast("已在浏览器打开链接");
        } else {
          ctx.toast("链接格式不正确");
        }
      } else if (item.itemType === "workspace") {
        const workspace = (payload.workspace ?? {}) as Record<string, unknown>;
        const result = importCommunityWorkspace(
          {
            name: workspace.name,
            themeId: workspace.theme,
            wallId: workspace.wall,
            widgets: workspace.widgets,
            dock: workspace.dock,
            shortcuts: workspace.shortcuts,
            openApps: workspace.openApps,
            dnd: workspace.dnd,
          },
          ctx,
          { postId: `continuity-${id.slice(0, 8)}`, packageName: String(workspace.name || "接力工作空间") },
        );
        await applyWorkspace(result.id, ctx, { silent: true });
        const missing = [...result.missingApps, ...result.missingWidgets];
        await modal(ctx.os, {
          title: `已恢复「${result.name}」`,
          body: `<p class="cty-muted">工作空间已按这台设备的屏幕重新排布。</p>${
            missing.length
              ? `<p class="cty-fine">以下应用/组件在这台设备上不存在，已保留原配置但不会加载：${escapeHtml(missing.join("、"))}</p>`
              : ""
          }`,
          actions: [{ label: "知道了", value: "ok", primary: true }],
        });
        await continuityApi.complete(id).catch(() => undefined);
      } else if (item.itemType === "reading") {
        await modal(ctx.os, {
          title: item.title,
          body: `<p class="cty-muted">阅读进度：${Math.round(Number(payload.progress || 0) * 100)}%</p>
            ${payload.url ? `<p class="cty-fine">${escapeHtml(String(payload.url))}</p>` : ""}`,
          actions: [{ label: "完成接力", value: "done", primary: true }],
        }).then((value) => {
          if (value === "done") void continuityApi.complete(id);
        });
      } else {
        await modal(ctx.os, {
          title: String(payload.appTitle || item.title),
          body: `<p class="cty-muted">这条内容来自桌面应用，当前版本不会自动重建该应用的编辑现场。可以从对应的应用重新打开。</p>`,
          actions: [{ label: "知道了", value: "ok", primary: true }],
        });
      }
      await load();
    } catch (err) {
      ctx.toast((err as Error).message || "打开失败");
    } finally {
      busy = false;
    }
  }

  /* ------------------------------ 剪贴板 ------------------------------ */

  async function sendClipboard() {
    const input = root.querySelector<HTMLTextAreaElement>("[data-cty-clip-input]");
    const content = input?.value.trim() || "";
    if (!content) {
      ctx.toast("先输入要发送的文字");
      return;
    }
    try {
      await clipboardApi.send(content);
      if (input) input.value = "";
      clipboard = (await clipboardApi.list()).items;
      paint();
      ctx.toast("已发送到其他设备");
    } catch (err) {
      ctx.toast((err as Error).message || "发送失败");
    }
  }

  async function quickClipboard() {
    const value = await modal(root, {
      title: "发送剪贴板",
      wide: true,
      body: `<p class="cty-muted">只发送下面这段文字，不会读取系统剪贴板。</p>
        <textarea class="g14-input" data-cty-quick-clip rows="4" maxlength="4000" placeholder="要发送的文字…"></textarea>`,
      actions: [
        { label: "取消", value: "" },
        { label: "发送", value: "send", primary: true },
      ],
    });
    if (value !== "send") return;
    const content = root.querySelector<HTMLTextAreaElement>("[data-cty-quick-clip]")?.value.trim() || "";
    if (!content) {
      ctx.toast("内容为空");
      return;
    }
    try {
      await clipboardApi.send(content);
      ctx.toast("已发送");
      if (view === "clipboard") await load();
    } catch (err) {
      ctx.toast((err as Error).message || "发送失败");
    }
  }

  /* ------------------------------ 事件 ------------------------------ */

  root.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const nav = target.closest<HTMLElement>("[data-cty-view]");
    if (nav) {
      view = (nav.dataset.ctyView as ViewId) || "overview";
      paint();
      return;
    }
    const action = target.closest<HTMLElement>("[data-cty-act]")?.dataset.ctyAct;
    const id = target.closest<HTMLElement>("[data-cty-act]")?.dataset.id || "";
    if (!action) return;

    if (action === "login") {
      window.dispatchEvent(new Event("guandao:open-login"));
      return;
    }
    if (action === "login") {
      window.dispatchEvent(new Event("guandao:open-login"));
      return;
    }
    if (action === "refresh") {
      void load();
      return;
    }
    if (action === "open-item") {
      void openItem(id);
      return;
    }
    if (action === "complete-item") {
      void continuityApi.complete(id).then(() => load()).catch((err) => ctx.toast((err as Error).message));
      return;
    }
    if (action === "cancel-item") {
      void continuityApi.cancel(id).then(() => load()).catch((err) => ctx.toast((err as Error).message));
      return;
    }
    if (action === "resume-note") {
      if (notesStore.select(id)) {
        ctx.openApp("notes");
        ctx.toast("已打开笔记");
      }
      return;
    }
    if (action === "open-tasks") {
      ctx.openApp("tasks");
      return;
    }
    if (action === "send-clip") {
      void sendClipboard();
      return;
    }
    if (action === "clipboard-quick") {
      void quickClipboard();
      return;
    }
    if (action === "copy-clip") {
      const item = clipboard.find((entry) => entry.id === id);
      if (!item) return;
      void navigator.clipboard
        .writeText(item.content)
        .then(() => ctx.toast("已复制"))
        .catch(() => {
          void modal(root, {
            title: "手动复制",
            body: `<textarea class="g14-input" rows="5" readonly>${escapeHtml(item.content)}</textarea>`,
            actions: [{ label: "完成", value: "ok", primary: true }],
          });
        });
      return;
    }
    if (action === "delete-clip") {
      void clipboardApi
        .remove(id)
        .then(async () => {
          clipboard = (await clipboardApi.list()).items;
          paint();
          ctx.toast("已删除");
        })
        .catch((err) => ctx.toast((err as Error).message));
    }
  });

  return () => {
    window.clearInterval(refreshTimer);
    window.removeEventListener("guandao:continuity-inbox", onInbox);
  };
};
