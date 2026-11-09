/**
 * 跨设备 UI：发送面板、配对面板、收件箱轮询、上下文上报。
 *
 * 这些都是桌面端复用组件；移动端有自己的界面，但走同一套 API。
 */

import { escapeHtml, modal, type Ctx } from "../os14/core";
import { listDevices, type Device } from "../devices/client";
import {
  continuityApi,
  pairingApi,
  type ContinuityItem,
  type ContinuityType,
  type PairingCreated,
  type PairingItem,
} from "./client";
import { ITEM_META } from "./payloads";
import { qrSvg } from "./qr";

type SendPayload = {
  itemType: ContinuityType;
  title: string;
  resourceId?: string | null;
  payload: Record<string, unknown>;
};

const OTHER_DEVICE_LABEL: Record<string, string> = {
  desktop: "Desktop",
  laptop: "Laptop",
  tablet: "Tablet",
  mobile: "Mobile",
};

async function otherDevices(): Promise<{ devices: Device[]; authed: boolean }> {
  try {
    const overview = await listDevices();
    return {
      devices: overview.devices.filter((device) => !device.isCurrent && device.status === "active"),
      authed: true,
    };
  } catch (error) {
    return { devices: [], authed: (error as { status?: number }).status !== 401 };
  }
}

/** 统一的「发送到设备」入口：笔记、任务、日程、文件都从这里走。 */
export async function sendToDevice(ctx: Ctx, item: SendPayload) {
  const { devices, authed } = await otherDevices();

  if (!authed) {
    await modal(ctx.os, {
      title: "先登录 Guandao Account",
      body: `<p class="cty-muted">接力内容绑定到账号，需要登录后才能发送到另一台设备。</p>`,
      actions: [
        { label: "取消", value: "" },
        { label: "去登录", value: "login", primary: true },
      ],
    }).then((value) => {
      if (value === "login") window.dispatchEvent(new Event("guandao:open-login"));
    });
    return;
  }

  if (!devices.length) {
    await modal(ctx.os, {
      title: "还没有其他设备",
      body: `<p class="cty-muted">同一账号下没有可接收的设备。先在另一台设备登录，或用配对码添加一台。</p>`,
      actions: [
        { label: "取消", value: "" },
        { label: "打开设备中心", value: "devices", primary: true },
      ],
    }).then((value) => {
      if (value === "devices") ctx.openApp("devices");
    });
    return;
  }

  const value = await modal(ctx.os, {
    title: `发送「${item.title.slice(0, 40)}」`,
    wide: true,
    body: `<div class="cty-send">
      <p class="cty-muted">内容会保存到云端，目标设备上线后可在收件箱打开。目标设备必须属于同一账号。</p>
      <div class="cty-targets">
        <label class="cty-target">
          <input type="radio" name="cty-target" value="" checked />
          <span><b>任一设备</b><i>先打开收件箱的设备会领取</i></span>
        </label>
        ${devices
          .map(
            (device) => `<label class="cty-target">
              <input type="radio" name="cty-target" value="${escapeHtml(device.id)}" />
              <span><b>${escapeHtml(device.name)}</b><i>${escapeHtml(OTHER_DEVICE_LABEL[device.type] ?? device.type)} · ${
                device.presence === "active" ? "在线" : "等待上线"
              }</i></span>
            </label>`,
          )
          .join("")}
      </div>
      <label class="cty-ttl">有效期
        <select class="g14-input" data-cty-ttl>
          <option value="3600000">1 小时</option>
          <option value="86400000">24 小时</option>
          <option value="259200000" selected>3 天</option>
          <option value="604800000">7 天</option>
        </select>
      </label>
      <p class="cty-fine">发送的是内容快照，不是远程控制。目标设备离线时不会假装已经收到。</p>
    </div>`,
    actions: [
      { label: "取消", value: "" },
      { label: "发送", value: "send", primary: true },
    ],
  });

  if (value !== "send") return;

  const target = ctx.os.querySelector<HTMLInputElement>('input[name="cty-target"]:checked')?.value || "";
  const ttl = Number(ctx.os.querySelector<HTMLSelectElement>("[data-cty-ttl]")?.value || 259_200_000);

  try {
    const result = await continuityApi.send({
      itemType: item.itemType,
      title: item.title,
      resourceId: item.resourceId ?? null,
      payload: item.payload,
      targetDeviceId: target || null,
      ttlMs: ttl,
    });
    ctx.toast(`已发送给${result.targetName || "任一设备"}`);
  } catch (error) {
    ctx.toast((error as Error).message || "发送失败");
  }
}

/* ============================================================
   配对面板：二维码 + 6 位码 + 待确认请求
   ============================================================ */

export async function openPairingDialog(host: HTMLElement, ctx: Ctx) {
  const layer = document.createElement("div");
  layer.className = "cty-overlay";
  layer.innerHTML = `
    <div class="cty-dialog" role="dialog" aria-modal="true" aria-labelledby="cty-pair-title">
      <header class="cty-dialog-head">
        <div><p class="cty-eyebrow">GUANDAO DEVICE PAIRING</p><h2 id="cty-pair-title">添加设备</h2></div>
        <button type="button" class="cty-close" data-cty-close aria-label="关闭">×</button>
      </header>
      <div class="cty-dialog-body" data-cty-pair-body>
        <div class="cty-loading"><span></span><p>正在生成配对码…</p></div>
      </div>
    </div>`;
  host.appendChild(layer);

  let created: PairingCreated | null = null;
  let pending: PairingItem[] = [];
  let timer = 0;
  let countdown = 0;
  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    window.clearInterval(timer);
    window.clearInterval(countdown);
    if (created) void pairingApi.cancel(created.pairingId).catch(() => undefined);
    layer.remove();
  };

  layer.querySelector("[data-cty-close]")?.addEventListener("click", close);
  layer.addEventListener("click", (event) => {
    if (event.target === layer) close();
    const approve = (event.target as HTMLElement).closest<HTMLElement>("[data-cty-approve]");
    if (approve) {
      const id = approve.dataset.ctyApprove!;
      approve.setAttribute("disabled", "true");
      void pairingApi
        .confirm(id)
        .then(() => {
          ctx.toast("已批准新设备，等待它领取登录状态");
          pending = pending.filter((item) => item.id !== id);
          render();
          ctx.pushNotif({ icon: "◈", title: "新设备已加入", body: "可以在 Guandao Devices 中查看它。" });
        })
        .catch((error) => {
          ctx.toast((error as Error).message || "批准失败");
          approve.removeAttribute("disabled");
        });
    }
  });

  const body = layer.querySelector<HTMLElement>("[data-cty-pair-body]")!;

  async function render() {
    if (!created || closed) return;
    const remain = Math.max(0, Math.floor((created.expiresAt - Date.now()) / 1000));
    const mm = String(Math.floor(remain / 60)).padStart(2, "0");
    const ss = String(remain % 60).padStart(2, "0");
    body.innerHTML = `
      <div class="cty-pair-grid">
        <div class="cty-qr" data-cty-qr></div>
        <div class="cty-pair-info">
          <p class="cty-muted">用新设备扫描二维码，或在配对页输入下面的 6 位码。</p>
          <div class="cty-code">${escapeHtml(created.code)}</div>
          <p class="cty-timer">剩余 ${mm}:${ss} · 只能使用一次</p>
          <p class="cty-fine">二维码里只有 10 分钟有效的配对 token，不包含 Cookie、Session 或 GitHub Token。</p>
          ${
            pending.length
              ? `<div class="cty-claimed">
                  <p class="cty-claimed-title">等待你确认</p>
                  ${pending
                    .map(
                      (item) => `<div class="cty-claimed-row">
                        <div><b>${escapeHtml(item.target?.name || "新设备")}</b><span>${escapeHtml(item.target?.browser || "")} · ${escapeHtml(item.target?.os || "")}</span></div>
                        <button type="button" class="g14-btn is-primary" data-cty-approve="${escapeHtml(item.id)}">批准</button>
                      </div>`,
                    )
                    .join("")}
                </div>`
              : `<p class="cty-waiting">正在等待新设备提交配对…</p>`
          }
        </div>
      </div>`;
    try {
      const svg = await qrSvg(created.qrUrl);
      const node = body.querySelector<HTMLElement>("[data-cty-qr]");
      if (node) node.innerHTML = svg;
    } catch {
      const node = body.querySelector<HTMLElement>("[data-cty-qr]");
      if (node) node.innerHTML = `<p class="cty-fine">二维码生成失败，请使用数字配对码。</p>`;
    }
  }

  timer = window.setInterval(async () => {
    if (!created || closed) return;
    try {
      const list = await pairingApi.list();
      const mine = list.items.find((item) => item.id === created?.pairingId);
      const next = mine && mine.status === "claimed" ? [mine] : [];
      const changed = next.length !== pending.length || next[0]?.id !== pending[0]?.id;
      pending = next;
      if (changed) void render();
    } catch {
      /* 轮询失败不打扰 */
    }
  }, 3000);

  countdown = window.setInterval(() => {
    if (!created || closed) return;
    if (Date.now() >= created.expiresAt) {
      window.clearInterval(countdown);
      body.innerHTML = `<div class="cty-empty"><b>配对码已过期</b><p>关闭后重新生成一个新的配对码。</p></div>`;
      return;
    }
    const node = body.querySelector<HTMLElement>(".cty-timer");
    const remain = Math.max(0, Math.floor((created.expiresAt - Date.now()) / 1000));
    if (node) node.textContent = `剩余 ${String(Math.floor(remain / 60)).padStart(2, "0")}:${String(remain % 60).padStart(2, "0")} · 只能使用一次`;
  }, 1000);

  try {
    created = await pairingApi.create();
    void render();
    ctx.toast("配对码已生成，10 分钟内有效");
  } catch (error) {
    body.innerHTML = `<div class="cty-empty"><b>无法生成配对码</b><p>${escapeHtml((error as Error).message || "请稍后再试")}</p></div>`;
  }
}

/* ============================================================
   后台：收件箱轮询 + 上下文上报
   ============================================================ */

let watcherStarted = false;
let contextTimer = 0;
let lastContext = "";

export function startContinuity(ctx: Ctx) {
  if (watcherStarted) return;
  watcherStarted = true;

  const seen = new Set<string>();
  let primed = false;
  let authenticated = false;

  // 未登录时不要每 60 秒打一次 401，控制台会满是网络错误。
  const checkAuth = async () => {
    try {
      const response = await fetch("/api/auth/me", { credentials: "same-origin", headers: { accept: "application/json" } });
      const payload = (await response.json()) as { authenticated?: boolean };
      authenticated = Boolean(payload.authenticated);
      contextAuth = authenticated;
      contextAuth = authenticated;
    } catch {
      authenticated = false;
    }
  };

  const poll = async () => {
    if (!navigator.onLine) return;
    if (!authenticated) await checkAuth();
    if (!authenticated) return;
    try {
      const inbox = await continuityApi.inbox();
      const incoming = inbox.items.filter((item) => !item.outgoing && item.status !== "completed");
      if (primed) {
        for (const item of incoming) {
          if (seen.has(item.id)) continue;
          ctx.pushNotif({
            icon: ITEM_META[item.itemType]?.glyph ?? "◆",
            title: `来自 ${item.sourceName} 的接力`,
            body: `${ITEM_META[item.itemType]?.label ?? "内容"}：${item.title}`,
          });
        }
      }
      for (const item of incoming) seen.add(item.id);
      primed = true;
      window.dispatchEvent(new CustomEvent("guandao:continuity-inbox", { detail: { items: incoming } }));
    } catch {
      /* 未登录或网络失败：静默 */
    }
  };

  void (async () => {
    await checkAuth();
    if (authenticated) await poll();
  })();
  window.setInterval(poll, 60_000);
  window.addEventListener("online", () => void poll());
  window.addEventListener("focus", () => void poll());
  window.addEventListener("guandao:signed-out", () => {
    authenticated = false;
    primed = false;
    seen.clear();
  });

  window.addEventListener("guandao:app-open", (event) => {
    const id = String((event as CustomEvent<{ id?: string }>).detail?.id || "");
    if (!id) return;
    void reportContext(ctx, id);
  });
}

/** 只上报语义化状态：当前应用、当前笔记 / 工作空间与滚动位置。 */
let contextAuth = false;

export async function reportContext(ctx: Ctx, appId: string) {
  if (!contextAuth) return;
  const key = `${appId}`;
  if (key === lastContext && Date.now() - contextTimer < 15_000) return;
  lastContext = key;
  contextTimer = Date.now();

  let resourceId: string | null = null;
  let title = ctx.APPS[appId]?.title || appId;
  let workspaceId: string | null = null;
  let scroll = 0;

  try {
    if (appId === "notes") {
      // 只读取本地状态，不 import Notes 模块，避免 ui ↔ apps 的循环依赖。
      const state = JSON.parse(localStorage.getItem("guandao.os14.notes.v1") || "{}") as {
        notes?: Array<{ id: string; title: string }>;
        ui?: { noteId?: string };
      };
      const current = state.notes?.find((note) => note.id === state.ui?.noteId);
      if (current) {
        resourceId = current.id;
        title = current.title || "未命名笔记";
      }
      const body = document.querySelector<HTMLElement>(".window[data-app='notes'] .n14-body");
      scroll = body ? body.scrollTop : 0;
    }
    if (appId === "workspaces") {
      const state = JSON.parse(localStorage.getItem("guandao.os14.ws.v1") || "{}") as {
        list?: Array<{ id: string; name: string }>;
        current?: string;
      };
      const current = state.list?.find((workspace) => workspace.id === state.current);
      workspaceId = current?.id ?? null;
      title = current?.name ?? title;
    }
    if (appId === "drive") {
      const active = document.querySelector<HTMLElement>(".window[data-app='drive'] .cdrv-card.is-active");
      resourceId = active?.dataset.file ?? null;
    }
    await continuityApi.saveContext({ appId, resourceId, resourceTitle: title, workspaceId, scroll });
  } catch {
    /* 未登录或离线：不打扰用户 */
  }
}
