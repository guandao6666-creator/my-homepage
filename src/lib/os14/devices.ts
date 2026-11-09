/**
 * Guandao Devices · 设备管理中心
 *
 * 数据全部来自 /api/devices（D1）。没有演示设备、没有假在线状态：
 * 「活跃」只表示最近 5 分钟收到过前台心跳，页面在后台或浏览器休眠时不算在线。
 */

// 1.9：应用样式跟着应用代码一起按需加载，不再压进首屏 CSS
import "../../styles/devices.css";
import { escapeHtml, type Ctx } from "./core";
import { openPairingDialog } from "../continuity/ui";
import {
  DeviceApiError,
  getDeviceDetail,
  listAccountActivity,
  listAllSessions,
  listDevices,
  renameDevice,
  reportDriveSync,
  requestDeviceSync,
  revokeAllSessions,
  revokeDevice,
  revokeOtherSessions,
  revokeSession,
  trustDevice,
  type ActivityEvent,
  type Device,
  type DeviceOverview,
  type DeviceSession,
  type DeviceType,
  type Presence,
  type SyncState,
} from "../devices/client";

type ViewId = "overview" | "devices" | "sessions" | "activity";

const NAV: Array<{ id: ViewId; label: string; glyph: string; hint: string }> = [
  { id: "overview", label: "Overview", glyph: "◈", hint: "账号与设备总览" },
  { id: "devices", label: "My Devices", glyph: "▣", hint: "按类型查看所有设备" },
  { id: "sessions", label: "Sessions", glyph: "◷", hint: "当前有效的登录会话" },
  { id: "activity", label: "Security Activity", glyph: "⌁", hint: "登录、撤销与同步记录" },
];

const TYPE_LABEL: Record<DeviceType, string> = {
  desktop: "Desktop",
  laptop: "Laptop",
  tablet: "Tablet",
  mobile: "Mobile",
};

const TYPE_ORDER: DeviceType[] = ["desktop", "laptop", "tablet", "mobile"];

const TYPE_ICON: Record<DeviceType, string> = {
  desktop:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8.5 20h7M12 16v4"/></svg>',
  laptop:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="4" y="5" width="16" height="10.5" rx="1.8"/><path d="M2.2 19h19.6"/></svg>',
  tablet:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="5" y="2.6" width="14" height="18.8" rx="2.4"/><path d="M10.8 18.4h2.4"/></svg>',
  mobile:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="7" y="2" width="10" height="20" rx="2.6"/><path d="M10.6 18.6h2.8"/></svg>',
};

const PRESENCE: Record<Presence, { label: string; tone: string }> = {
  active: { label: "活跃", tone: "ok" },
  recent: { label: "最近使用", tone: "accent" },
  idle: { label: "闲置", tone: "mute" },
  unknown: { label: "状态未知", tone: "mute" },
  revoked: { label: "已撤销", tone: "danger" },
};

const EVENT_LABEL: Record<string, { label: string; glyph: string; tone: string }> = {
  registered: { label: "设备注册", glyph: "＋", tone: "accent" },
  signed_in: { label: "登录", glyph: "→", tone: "ok" },
  signed_out: { label: "退出登录", glyph: "←", tone: "mute" },
  renamed: { label: "修改设备名称", glyph: "✎", tone: "mute" },
  device_revoked: { label: "撤销设备", glyph: "⊘", tone: "danger" },
  session_revoked: { label: "撤销 Session", glyph: "⌫", tone: "danger" },
  trusted: { label: "确认设备", glyph: "✓", tone: "ok" },
  sync_success: { label: "同步成功", glyph: "↻", tone: "ok" },
  sync_failed: { label: "同步失败", glyph: "!", tone: "danger" },
  sync_requested: { label: "请求同步", glyph: "⇒", tone: "accent" },
};

export const renderDevices = (): string => `
  <div class="gdv" data-devices>
    <aside class="gdv-side">
      <div class="gdv-brand">
        <span class="gdv-brand-logo">◈</span>
        <div><b>Guandao Devices</b><i>One Account. Every Device.</i></div>
      </div>
      <nav class="gdv-nav" data-nav>
        ${NAV.map(
          (item) => `<button type="button" class="gdv-nav-item" data-view="${item.id}">
            <span class="gdv-nav-ico">${item.glyph}</span>
            <span class="gdv-nav-text"><b>${item.label}</b><i>${item.hint}</i></span>
          </button>`,
        ).join("")}
      </nav>
      <div class="gdv-side-foot">
        <p class="gdv-side-label">当前账号</p>
        <div class="gdv-side-user">
          <span class="gdv-side-avatar" data-side-avatar>管</span>
          <div><b data-side-name>—</b><i data-side-sub>—</i></div>
        </div>
        <button type="button" class="gdv-side-action" data-act="revoke-others">退出其他设备</button>
      </div>
    </aside>

    <section class="gdv-main">
      <header class="gdv-top">
        <div class="gdv-top-text">
          <p class="gdv-eyebrow" data-eyebrow>GUANDAO OS 1.5 · DEVICES</p>
          <h1 data-title>Overview</h1>
          <p class="gdv-sub" data-sub>正在读取设备…</p>
        </div>
        <div class="gdv-top-actions">
          <span class="gdv-chip" data-current>—</span>
          <button type="button" class="gdv-btn gdv-pair-btn" data-act="pair">＋ 添加设备</button>
          <button type="button" class="gdv-icon-btn" data-act="refresh" title="刷新" aria-label="刷新">↻</button>
        </div>
      </header>
      <div class="gdv-scroll" data-body>
        <div class="gdv-loading"><span></span><p>正在读取设备状态…</p></div>
      </div>
    </section>

    <div class="gdv-drawer" data-drawer hidden></div>
  </div>
`;

export const initDevices = (win: HTMLElement, ctx: Ctx): (() => void) => {
  const root = win.querySelector<HTMLElement>("[data-devices]");
  if (!root) return () => undefined;

  const body = root.querySelector<HTMLElement>("[data-body]")!;
  const title = root.querySelector<HTMLElement>("[data-title]")!;
  const sub = root.querySelector<HTMLElement>("[data-sub]")!;
  const eyebrow = root.querySelector<HTMLElement>("[data-eyebrow]")!;
  const currentChip = root.querySelector<HTMLElement>("[data-current]")!;
  const drawer = root.querySelector<HTMLElement>("[data-drawer]")!;
  const sideName = root.querySelector<HTMLElement>("[data-side-name]")!;
  const sideSub = root.querySelector<HTMLElement>("[data-side-sub]")!;
  const sideAvatar = root.querySelector<HTMLElement>("[data-side-avatar]")!;

  let view: ViewId = "overview";
  let data: DeviceOverview | null = null;
  let loading = true;
  let error = "";
  let signedOut = false;
  let busy = false;
  let accountActivity: ActivityEvent[] = [];
  let allSessions: DeviceSession[] = [];
  let detail: { device: Device; sessions: DeviceSession[]; activity: ActivityEvent[] } | null = null;
  let detailId: string | null = null;

  const toast = (message: string) => {
    if (ctx?.toast) ctx.toast(message);
    else {
      const node = document.createElement("div");
      node.className = "gdv-toast";
      node.textContent = message;
      root.appendChild(node);
      window.setTimeout(() => node.remove(), 2600);
    }
  };

  /* ------------------------------ 时间 ------------------------------ */

  const fmtAbs = (ms: number | null): string => {
    if (!ms) return "—";
    try {
      return new Intl.DateTimeFormat("zh-CN", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date(ms));
    } catch {
      return "—";
    }
  };

  const fmtDay = (ms: number | null): string => {
    if (!ms) return "—";
    try {
      return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }).format(
        new Date(ms),
      );
    } catch {
      return "—";
    }
  };

  const fmtRel = (ms: number | null): string => {
    if (!ms) return "—";
    const delta = Date.now() - ms;
    if (delta < 0) return "刚刚";
    const minute = 60_000;
    const hour = 60 * minute;
    const day = 24 * hour;
    if (delta < minute) return "刚刚";
    if (delta < hour) return `${Math.floor(delta / minute)} 分钟前`;
    if (delta < day) return `${Math.floor(delta / hour)} 小时前`;
    if (delta < 7 * day) return `${Math.floor(delta / day)} 天前`;
    return fmtDay(ms);
  };

  const fmtBytes = (bytes: number): string => {
    if (!bytes) return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    let value = bytes;
    let index = 0;
    while (value >= 1024 && index < units.length - 1) {
      value /= 1024;
      index += 1;
    }
    return `${value.toFixed(value >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
  };

  /* ------------------------------ 渲染 ------------------------------ */

  const pill = (presence: Presence): string =>
    `<span class="gdv-badge is-${PRESENCE[presence].tone}">${PRESENCE[presence].label}</span>`;

  const needsSync = (device: Device): boolean => {
    if (device.status === "revoked") return false;
    const drive = device.sync.drive;
    if (drive.requestedAt) return true;
    if (drive.lastResult === "failed") return true;
    if (!drive.lastSyncAt) return false;
    return Date.now() - drive.lastSyncAt > (data?.overview.staleSyncMs ?? 7 * 24 * 3600 * 1000);
  };

  const syncText = (state: SyncState): string => {
    if (state.mode === "local") return "本地存储";
    if (state.requestedAt) return "已请求同步";
    if (state.lastResult === "failed") return "上次同步失败";
    if (state.conflicts > 0) return `冲突 ${state.conflicts}`;
    if (!state.lastSyncAt) return "尚未上报";
    return fmtRel(state.lastSyncAt);
  };

  const syncTone = (state: SyncState): string => {
    if (state.mode === "local") return "local";
    if (state.lastResult === "failed" || state.conflicts > 0) return "warn";
    if (state.lastSyncAt) return "ok";
    return "mute";
  };

  const deviceCard = (device: Device): string => {
    const revoked = device.status === "revoked";
    const current = device.isCurrent;
    const untrusted = !device.trusted && !current;

    return `<article class="gdv-card${current ? " is-current" : ""}${revoked ? " is-revoked" : ""}" data-device="${escapeHtml(device.id)}">
      <div class="gdv-card-top">
        <span class="gdv-dev-ico is-${device.type}">${TYPE_ICON[device.type]}</span>
        <div class="gdv-card-name">
          <b title="${escapeHtml(device.name)}">${escapeHtml(device.name)}</b>
          <span>${escapeHtml(device.os)} · ${escapeHtml(device.browser)}</span>
        </div>
      </div>
      <div class="gdv-card-badges">
        ${current ? '<span class="gdv-badge is-current">CURRENT DEVICE</span>' : ""}
        ${pill(device.presence)}
        ${untrusted ? '<span class="gdv-badge is-warn">未确认</span>' : ""}
        ${needsSync(device) ? '<span class="gdv-badge is-warn">Needs Sync</span>' : ""}
        ${device.sync.drive.conflicts > 0 ? '<span class="gdv-badge is-danger">Conflict Detected</span>' : ""}
      </div>
      <dl class="gdv-meta">
        <div><dt>最后活动</dt><dd>${fmtRel(device.lastActiveAt || device.lastSeenAt)}</dd></div>
        <div><dt>最后同步</dt><dd>${device.sync.drive.lastSyncAt ? fmtRel(device.sync.drive.lastSyncAt) : "—"}</dd></div>
        <div><dt>注册时间</dt><dd>${fmtDay(device.createdAt)}</dd></div>
      </dl>
      <div class="gdv-card-foot">
        <button type="button" class="gdv-btn" data-act="detail" data-id="${escapeHtml(device.id)}">详情</button>
        <button type="button" class="gdv-btn" data-act="rename" data-id="${escapeHtml(device.id)}" ${revoked ? "disabled" : ""}>重命名</button>
        ${
          current
            ? '<span class="gdv-card-note">当前设备</span>'
            : revoked
              ? `<span class="gdv-card-note">已于 ${fmtDay(device.revokedAt)} 撤销</span>`
              : `<button type="button" class="gdv-btn is-danger" data-act="revoke" data-id="${escapeHtml(device.id)}">撤销</button>`
        }
      </div>
    </article>`;
  };

  const statTile = (label: string, value: string, hint: string, tone = ""): string => `
    <div class="gdv-stat${tone ? ` is-${tone}` : ""}">
      <p>${label}</p>
      <b>${value}</b>
      <span>${hint}</span>
    </div>`;

  const renderOverview = (): string => {
    if (!data) return "";
    const { overview, devices, alerts, drive, currentDeviceId } = data;
    const current = devices.find((device) => device.id === currentDeviceId);

    const alertBlock = alerts.length
      ? `<section class="gdv-section">
          <div class="gdv-section-head">
            <h2>New Device Signed In</h2>
            <p>有 ${alerts.length} 台新设备尚未确认。确认前不会影响使用，但建议核对。</p>
          </div>
          <div class="gdv-alert-list">
            ${alerts
              .map(
                (alert) => `<div class="gdv-alert">
                  <span class="gdv-dev-ico is-${alert.type}">${TYPE_ICON[alert.type]}</span>
                  <div class="gdv-alert-text">
                    <b>${escapeHtml(alert.name)}</b>
                    <span>${escapeHtml(alert.os)} · ${escapeHtml(alert.browser)} · ${fmtRel(alert.createdAt)}</span>
                  </div>
                  <div class="gdv-alert-actions">
                    <button type="button" class="gdv-btn is-primary" data-act="trust" data-id="${escapeHtml(alert.deviceId)}">这是我的设备</button>
                    <button type="button" class="gdv-btn is-danger" data-act="revoke" data-id="${escapeHtml(alert.deviceId)}">不是我的设备</button>
                    <button type="button" class="gdv-btn" data-act="detail" data-id="${escapeHtml(alert.deviceId)}">查看详情</button>
                  </div>
                </div>`,
              )
              .join("")}
          </div>
        </section>`
      : "";

    const syncRows = devices
      .filter((device) => device.status === "active")
      .map(
        (device) => `<div class="gdv-sync-row">
          <div class="gdv-sync-dev">
            <span class="gdv-dev-ico is-${device.type}">${TYPE_ICON[device.type]}</span>
            <div><b>${escapeHtml(device.name)}</b><span>${device.isCurrent ? "当前设备" : TYPE_LABEL[device.type]}</span></div>
          </div>
          ${(["drive", "notes", "tasks", "calendar"] as const)
            .map((domain) => {
              const state = device.sync[domain];
              const label = domain === "drive" ? "Cloud Drive" : domain[0].toUpperCase() + domain.slice(1);
              return `<div class="gdv-sync-cell is-${syncTone(state)}">
                <span>${label}</span>
                <b>${syncText(state)}</b>
              </div>`;
            })
            .join("")}
        </div>`,
      )
      .join("");

    return `
      <section class="gdv-hero">
        <div class="gdv-hero-main">
          <div class="gdv-avatar">${escapeHtml((data.account.displayName || "管").slice(0, 1))}</div>
          <div class="gdv-hero-id">
            <p>当前登录账号</p>
            <h2>${escapeHtml(data.account.displayName)}</h2>
            <span>${data.account.githubUsername ? `@${escapeHtml(data.account.githubUsername)}` : "Guandao Account"}${data.account.role === "admin" ? " · Admin" : ""}</span>
          </div>
        </div>
        <div class="gdv-hero-device">
          <p>This device</p>
          <b>${escapeHtml(current?.name || "未登记")}</b>
          <span>${current ? `${escapeHtml(current.os)} · ${escapeHtml(current.browser)} · ${TYPE_LABEL[current.type]}` : "—"}</span>
        </div>
      </section>

      <div class="gdv-stats">
        ${statTile("已注册设备", String(overview.deviceCount), overview.revokedCount ? `另有 ${overview.revokedCount} 台已撤销` : "全部处于有效状态")}
        ${statTile("活跃 Session", String(overview.activeSessionCount), `${overview.signedInDeviceCount} 台设备已登录`)}
        ${statTile("最近活动", overview.lastActivityAt ? fmtRel(overview.lastActivityAt) : "—", "只统计真实心跳")}
        ${statTile("云端文件", String(drive.fileCount), fmtBytes(drive.usedBytes), "ok")}
      </div>

      ${alertBlock}

      <section class="gdv-section">
        <div class="gdv-section-head">
          <h2>设备与同步</h2>
          <p>在线状态与同步状态分开计算：在线看 5 分钟内的前台心跳，同步看真实上报结果。</p>
        </div>
        <div class="gdv-legend">
          <span><i class="is-ok"></i>已同步</span>
          <span><i class="is-warn"></i>需要同步 / 失败</span>
          <span><i class="is-local"></i>仅本地存储</span>
          <span><i class="is-mute"></i>尚未上报</span>
        </div>
        <div class="gdv-sync-table">${syncRows || '<p class="gdv-empty-line">还没有有效设备。</p>'}</div>
      </section>

      <section class="gdv-section">
        <div class="gdv-section-head">
          <h2>安全操作</h2>
          <p>撤销只会让登录失效，不会删除笔记、任务、日历或云端文件。</p>
        </div>
        <div class="gdv-quick">
          <button type="button" class="gdv-quick-btn" data-act="sync-current">
            <b>同步当前设备</b><span>检查云端连接并更新同步时间</span>
          </button>
          <button type="button" class="gdv-quick-btn" data-act="revoke-others">
            <b>退出其他设备</b><span>保留当前设备，撤销其余全部 Session</span>
          </button>
          <button type="button" class="gdv-quick-btn is-danger" data-act="revoke-all">
            <b>退出所有设备</b><span>需要输入确认短语，当前设备也会退出</span>
          </button>
          <button type="button" class="gdv-quick-btn" data-act="logout-current">
            <b>退出当前设备</b><span>只结束这台设备的登录，其他设备不受影响</span>
          </button>
        </div>
      </section>
    `;
  };

  const renderDeviceList = (): string => {
    if (!data) return "";
    const active = data.devices.filter((device) => device.status === "active");
    const revoked = data.devices.filter((device) => device.status === "revoked");

    const groups = TYPE_ORDER.map((type) => {
      const list = active.filter((device) => device.type === type);
      if (!list.length) return "";
      const label = type === "mobile" ? "Mobile" : type === "tablet" ? "Tablet" : type === "laptop" ? "Laptop" : "Desktop";
      return `<section class="gdv-group">
        <div class="gdv-group-head"><span>${label}</span><em>${list.length}</em></div>
        <div class="gdv-grid">${list.map(deviceCard).join("")}</div>
      </section>`;
    }).join("");

    const revokedBlock = revoked.length
      ? `<section class="gdv-group is-muted">
          <div class="gdv-group-head"><span>已撤销</span><em>${revoked.length}</em></div>
          <div class="gdv-grid">${revoked.map(deviceCard).join("")}</div>
        </section>`
      : "";

    return `${groups || '<div class="gdv-empty"><span>◌</span><p>还没有登记任何设备</p><i>登录后会自动登记当前设备。</i></div>'}${revokedBlock}`;
  };

  const renderSessions = (): string => {
    if (!data) return "";
    const activeDevices = data.devices.filter((device) => device.status === "active");

    const groups = activeDevices
      .map((device) => {
        const sessions = allSessions.filter((session) => session.deviceId === device.id);
        return `<section class="gdv-session-group">
          <div class="gdv-session-head">
            <span class="gdv-dev-ico is-${device.type}">${TYPE_ICON[device.type]}</span>
            <div><b>${escapeHtml(device.name)}</b><span>${escapeHtml(device.os)} · ${escapeHtml(device.browser)}</span></div>
            ${device.isCurrent ? '<span class="gdv-badge is-current">CURRENT DEVICE</span>' : ""}
          </div>
          ${
            sessions.length
              ? `<div class="gdv-session-table">
                  <div class="gdv-session-row is-head"><span>创建时间</span><span>最后使用</span><span>过期时间</span><span>状态</span><span>操作</span></div>
                  ${sessions
                    .map(
                      (session) => `<div class="gdv-session-row">
                        <span>${fmtAbs(session.createdAt)}</span>
                        <span>${fmtRel(session.lastUsedAt)}</span>
                        <span>${fmtDay(session.expiresAt)}</span>
                        <span><i class="gdv-dot is-${session.status}"></i>${sessionStatusLabel(session)}</span>
                        <span>${
                          session.status === "active" && !session.current
                            ? `<button type="button" class="gdv-btn is-danger is-sm" data-act="revoke-session" data-id="${escapeHtml(session.id)}">撤销</button>`
                            : session.current
                              ? '<em class="gdv-muted">当前会话</em>'
                              : ""
                        }</span>
                      </div>`,
                    )
                    .join("")}
                </div>`
              : '<p class="gdv-empty-line">该设备当前没有有效 Session。设备仍保留在列表中，可随时重新登录。</p>'
          }
        </section>`;
      })
      .join("");

    return `
      <section class="gdv-section">
        <div class="gdv-section-head">
          <h2>所有登录 Session</h2>
          <p>一台设备可以有多个 Session。撤销 Session 只让那一次登录失效，不影响设备记录。</p>
        </div>
        ${groups || '<div class="gdv-empty"><span>◌</span><p>没有有效设备</p></div>'}
      </section>`;
  };

  const sessionStatusLabel = (session: DeviceSession): string => {
    if (session.status === "revoked") return "已撤销";
    if (session.status === "expired") return "已过期";
    return session.current ? "当前会话" : "有效";
  };

  const renderActivity = (): string => {
    const list = accountActivity;
    if (!list.length) {
      return `<div class="gdv-empty"><span>◌</span><p>还没有安全活动记录</p><i>登录、撤销设备与同步结果都会记录在这里。</i></div>`;
    }

    const days = new Map<string, ActivityEvent[]>();
    for (const event of list) {
      const key = new Date(event.createdAt).toDateString();
      const group = days.get(key) ?? [];
      group.push(event);
      days.set(key, group);
    }

    return `<section class="gdv-timeline">
      ${[...days.entries()]
        .map(
          ([day, events]) => `<div class="gdv-tl-day">
            <p class="gdv-tl-date">${day}</p>
            ${events
              .map((event) => {
                const meta = EVENT_LABEL[event.eventType] ?? { label: event.eventType, glyph: "·", tone: "mute" };
                const extras: string[] = [];
                if (event.metadata?.domain) extras.push(String(event.metadata.domain));
                if (event.metadata?.sessions !== undefined) extras.push(`${event.metadata.sessions} 个 Session`);
                if (event.metadata?.count !== undefined) extras.push(`${event.metadata.count} 条`);
                if (event.metadata?.to && event.eventType === "renamed") extras.push(`→ ${String(event.metadata.to)}`);
                if (event.metadata?.browser) extras.push(String(event.metadata.browser));
                if (event.metadata?.os) extras.push(String(event.metadata.os));

                return `<div class="gdv-tl-item is-${meta.tone}">
                  <span class="gdv-tl-ico">${meta.glyph}</span>
                  <div class="gdv-tl-body">
                    <b>${meta.label}</b>
                    <span>${escapeHtml(event.deviceName || "账号级操作")}${extras.length ? ` · ${escapeHtml(extras.join(" · "))}` : ""}</span>
                  </div>
                  <time>${fmtAbs(event.createdAt)}</time>
                </div>`;
              })
              .join("")}
          </div>`,
        )
        .join("")}
    </section>`;
  };

  const render = (): void => {
    const item = NAV.find((nav) => nav.id === view) ?? NAV[0];
    title.textContent = item.label;
    eyebrow.textContent = view === "overview" ? "GUANDAO OS 1.5 · DEVICES" : "GUANDAO DEVICES · CONTROL";

    root.querySelectorAll<HTMLElement>("[data-view]").forEach((node) => {
      node.classList.toggle("is-active", node.dataset.view === view);
    });

    if (loading && !data) {
      body.innerHTML = '<div class="gdv-loading"><span></span><p>正在读取设备状态…</p></div>';
      sub.textContent = "正在读取设备…";
      currentChip.textContent = "—";
      return;
    }

    if (signedOut) {
      showSignedOut("登录已失效，请重新登录。");
      return;
    }

    if (error && !data) {
      body.innerHTML = `<div class="gdv-empty"><span>⚠</span><p>${escapeHtml(error)}</p><button type="button" class="gdv-btn" data-act="refresh">重试</button></div>`;
      sub.textContent = error;
      return;
    }

    if (!data) return;

    const current = data.devices.find((device) => device.id === data?.currentDeviceId);
    currentChip.textContent = current ? `当前 · ${current.name}` : "未登记设备";
    sideName.textContent = data.account.displayName;
    sideSub.textContent = data.account.githubUsername
      ? `@${data.account.githubUsername}`
      : "Guandao Account";
    sideAvatar.textContent = (data.account.displayName || "管").slice(0, 1);

    sub.textContent = {
      overview: `${data.overview.deviceCount} 台设备 · ${data.overview.activeSessionCount} 个有效 Session`,
      devices: "按设备类型分类，当前设备已标记",
      sessions: "同一设备可能存在多个 Session",
      activity: "只记录动作与结果，不含任何凭证或内容",
    }[view];

    if (view === "overview") body.innerHTML = renderOverview();
    else if (view === "devices") body.innerHTML = renderDeviceList();
    else if (view === "sessions") body.innerHTML = renderSessions();
    else body.innerHTML = renderActivity();
  };

  /* ------------------------------ 数据 ------------------------------ */

  const load = async (silent = false): Promise<void> => {
    if (!silent) {
      loading = true;
      error = "";
      render();
    }
    try {
      const [overview, sessions] = await Promise.all([listDevices(), listAllSessions()]);
      data = overview;
      allSessions = sessions.sessions;
      error = "";
      signedOut = false;
    } catch (err) {
      if (err instanceof DeviceApiError && err.status === 401) {
        data = null;
        signedOut = true;
        error = "登录已失效，请重新登录后查看设备。";
      } else {
        error = err instanceof Error ? err.message : "加载失败";
      }
    } finally {
      loading = false;
      render();
      if (view === "activity" && data) void loadActivity(true);
    }
  };

  const loadActivity = async (silent = false): Promise<void> => {
    if (!silent && view !== "activity") return;
    try {
      accountActivity = (await listAccountActivity(80)).activity;
    } catch {
      accountActivity = [];
    }
    if (view === "activity") {
      if (data) render();
      else body.innerHTML = renderActivity();
    }
  };

  const showSignedOut = (message: string): void => {
    body.innerHTML = `<div class="gdv-empty">
      <span>⚠</span>
      <p>${escapeHtml(message)}</p>
      <i>账号可能已在其他设备退出登录。</i>
      <button type="button" class="gdv-btn is-primary" data-act="login">重新登录</button>
    </div>`;
    sub.textContent = "需要重新登录";
  };

  /* ------------------------------ 弹窗 ------------------------------ */

  const dialog = (options: {
    title: string;
    body: string;
    actions: Array<{ label: string; value: string; tone?: "primary" | "danger" }>;
    requireText?: string;
  }): Promise<{ action: string; values: Record<string, string> } | null> =>
    new Promise((resolve) => {
      const wrap = document.createElement("div");
      wrap.className = "gdv-modal";
      wrap.innerHTML = `<div class="gdv-modal-card" role="dialog" aria-modal="true">
        <h2>${escapeHtml(options.title)}</h2>
        <div class="gdv-modal-body">${options.body}</div>
        <div class="gdv-modal-actions">
          ${options.actions
            .map(
              (action) =>
                `<button type="button" class="gdv-btn ${action.tone === "primary" ? "is-primary" : ""} ${action.tone === "danger" ? "is-danger" : ""}" data-dv="${escapeHtml(action.value)}">${escapeHtml(action.label)}</button>`,
            )
            .join("")}
        </div>
      </div>`;
      root.appendChild(wrap);
      window.setTimeout(() => wrap.querySelector<HTMLInputElement>("[data-autofocus]")?.focus(), 40);

      const confirm = wrap.querySelector<HTMLButtonElement>('[data-dv="confirm"]');
      const input = wrap.querySelector<HTMLInputElement>("[data-confirm-text]");

      if (options.requireText && confirm) {
        confirm.disabled = true;
        input?.addEventListener("input", () => {
          confirm.disabled = (input.value || "").trim().toUpperCase() !== options.requireText?.toUpperCase();
        });
      }

      const done = (value: string | null) => {
        const values: Record<string, string> = {};
        wrap.querySelectorAll<HTMLInputElement>("[data-field]").forEach((field) => {
          values[field.dataset.field || ""] = field.value;
        });
        const checkbox = wrap.querySelector<HTMLInputElement>("[data-check]");
        if (checkbox) values.__checked = String(checkbox.checked);
        resolve(value ? { action: value, values } : null);
        window.setTimeout(() => wrap.remove(), 0);
      };

      wrap.addEventListener("click", (event) => {
        if (event.target === wrap) {
          done(null);
          return;
        }
        const btn = (event.target as HTMLElement).closest<HTMLElement>("[data-dv]");
        if (btn && !btn.hasAttribute("disabled")) done(btn.dataset.dv ?? "");
      });
    });

  /* ------------------------------ 操作 ------------------------------ */

  const guard = async (task: () => Promise<void>): Promise<void> => {
    if (busy) return;
    busy = true;
    try {
      await task();
    } catch (err) {
      const message = err instanceof Error ? err.message : "操作失败";
      toast(message);
      if (err instanceof DeviceApiError && err.status === 401) showSignedOut(message);
    } finally {
      busy = false;
    }
  };

  const openRename = async (device: Device): Promise<void> => {
    const result = await dialog({
      title: "修改设备名称",
      body: `<p class="gdv-modal-note">名称会保存到云端，其他设备重新读取时也会看到。</p>
        <label class="gdv-field"><span>设备名称</span>
          <input data-field="name" data-autofocus maxlength="64" value="${escapeHtml(device.name)}" />
        </label>
        <label class="gdv-field"><span>设备类型</span>
          <select data-field="type">
            ${TYPE_ORDER.map((type) => `<option value="${type}" ${device.type === type ? "selected" : ""}>${TYPE_LABEL[type]}</option>`).join("")}
          </select>
        </label>`,
      actions: [
        { label: "取消", value: "cancel" },
        { label: "保存", value: "confirm", tone: "primary" },
      ],
    });

    if (!result || result.action !== "confirm") return;

    const name = (result.values.name || "").trim();
    if (!name) {
      toast("设备名称不能为空");
      return;
    }

    await guard(async () => {
      await renameDevice(device.id, { name, type: result.values.type as DeviceType });
      toast("设备名称已更新");
      await load(true);
      if (detailId === device.id) await openDetail(device.id);
    });
  };

  const openRevoke = async (device: Device): Promise<void> => {
    if (device.isCurrent) {
      toast("当前设备请在账号菜单里退出登录");
      return;
    }

    const result = await dialog({
      title: `撤销「${device.name}」`,
      body: `<p class="gdv-modal-note">这会立即撤销该设备的 <b>${device.activeSessionCount}</b> 个有效 Session。</p>
        <ul class="gdv-modal-list">
          <li>该设备下一次向服务器发请求时会收到 401，并回到登录界面。</li>
          <li>如果设备当前离线，无法实时通知它；它重新联网后才会发现。</li>
          <li>不会删除该设备上的本地数据，也不会删除云端笔记、任务或文件。</li>
        </ul>`,
      actions: [
        { label: "取消", value: "cancel" },
        { label: "确认撤销", value: "confirm", tone: "danger" },
      ],
    });

    if (!result || result.action !== "confirm") return;

    await guard(async () => {
      const response = await revokeDevice(device.id);
      toast(`已撤销「${device.name}」，${response.revokedSessions} 个 Session 失效`);
      drawer.hidden = true;
      detailId = null;
      detail = null;
      await load(true);
    });
  };

  const openRevokeAll = async (): Promise<void> => {
    const result = await dialog({
      title: "退出所有设备",
      body: `<p class="gdv-modal-note">这是强度最高的操作，会撤销该账号的全部 Session。</p>
        <ul class="gdv-modal-list">
          <li>输入 <b>REVOKE ALL</b> 以确认。</li>
          <li>勾选下面选项可以保留当前设备的登录状态。</li>
          <li>撤销不等于删除账号，也不会删除任何云端数据。</li>
        </ul>
        <label class="gdv-field"><span>确认短语</span>
          <input data-confirm-text maxlength="20" placeholder="REVOKE ALL" autocomplete="off" />
        </label>
        <label class="gdv-check"><input type="checkbox" data-check checked /> 保留当前设备的登录状态</label>`,
      actions: [
        { label: "取消", value: "cancel" },
        { label: "退出所有设备", value: "confirm", tone: "danger" },
      ],
      requireText: "REVOKE ALL",
    });

    if (!result || result.action !== "confirm") return;

    const keepCurrent = result.values.__checked === "true";
    await guard(async () => {
      const response = await revokeAllSessions(keepCurrent);
      toast(`已撤销 ${response.revoked} 个 Session`);
      if (!keepCurrent) {
        window.dispatchEvent(new CustomEvent("guandao:device-session-lost", { detail: { code: "SESSION_REVOKED" } }));
        showSignedOut("已退出所有设备。");
      } else {
        await load(true);
      }
    });
  };

  const openDetail = async (deviceId: string): Promise<void> => {
    drawer.hidden = false;
    drawer.innerHTML = '<div class="gdv-drawer-loading">正在读取设备详情…</div>';
    try {
      detail = await getDeviceDetail(deviceId);
      detailId = deviceId;
      renderDrawer();
    } catch (err) {
      drawer.innerHTML = `<div class="gdv-drawer-loading">${escapeHtml(err instanceof Error ? err.message : "读取详情失败")}</div>`;
    }
  };

  const renderDrawer = (): void => {
    if (!detail) return;
    const { device, sessions, activity } = detail;
    const revoked = device.status === "revoked";

    const syncRows = (["drive", "notes", "tasks", "calendar"] as const)
      .map((domain) => {
        const state = device.sync[domain];
        const label = domain === "drive" ? "Cloud Drive" : domain[0].toUpperCase() + domain.slice(1);
        return `<div class="gdv-sync-detail">
          <div><b>${label}</b><span>${state.mode === "cloud" ? "云端同步" : "浏览器本地存储"}</span></div>
          <div class="is-${syncTone(state)}"><b>${syncText(state)}</b><span>${state.mode === "cloud" ? (state.lastSyncAt ? fmtAbs(state.lastSyncAt) : "尚无成功记录") : "尚未接入云同步"}</span></div>
        </div>`;
      })
      .join("");

    drawer.innerHTML = `<div class="gdv-drawer-panel">
      <header class="gdv-drawer-head">
        <span class="gdv-dev-ico is-${device.type}">${TYPE_ICON[device.type]}</span>
        <div>
          <h2>${escapeHtml(device.name)}</h2>
          <p>${escapeHtml(device.os)} · ${escapeHtml(device.browser)} · ${TYPE_LABEL[device.type]}</p>
        </div>
        ${device.isCurrent ? '<span class="gdv-badge is-current">CURRENT DEVICE</span>' : pill(device.presence)}
        <button type="button" class="gdv-icon-btn" data-act="close-detail" aria-label="关闭">×</button>
      </header>

      <div class="gdv-drawer-body">
        <section class="gdv-detail-grid">
          <div>
            <h3>基础信息</h3>
            <dl class="gdv-kv">
              <div><dt>设备名称</dt><dd>${escapeHtml(device.name)}</dd></div>
              <div><dt>设备类型</dt><dd>${TYPE_LABEL[device.type]}</dd></div>
              <div><dt>操作系统</dt><dd>${escapeHtml(device.os)}</dd></div>
              <div><dt>浏览器</dt><dd>${escapeHtml(device.browser)}</dd></div>
              <div><dt>首次登录</dt><dd>${fmtAbs(device.createdAt)}</dd></div>
            </dl>
          </div>
          <div>
            <h3>登录信息</h3>
            <dl class="gdv-kv">
              <div><dt>最近活动</dt><dd>${device.lastActiveAt ? fmtRel(device.lastActiveAt) : "—"}</dd></div>
              <div><dt>最近心跳</dt><dd>${device.lastSeenAt ? fmtRel(device.lastSeenAt) : "—"}</dd></div>
              <div><dt>最近同步</dt><dd>${device.sync.drive.lastSyncAt ? fmtRel(device.sync.drive.lastSyncAt) : "—"}</dd></div>
              <div><dt>有效 Session</dt><dd>${device.activeSessionCount} / ${device.sessionCount}</dd></div>
              <div><dt>设备状态</dt><dd>${device.status === "revoked" ? `已撤销 · ${fmtDay(device.revokedAt)}` : device.trusted ? "有效 · 已确认" : "有效 · 未确认"}</dd></div>
            </dl>
          </div>
        </section>

        <section>
          <h3>同步状态</h3>
          <div class="gdv-sync-details">${syncRows}</div>
        </section>

        <section>
          <h3>该设备的 Session</h3>
          ${
            sessions.length
              ? `<div class="gdv-session-table is-compact">
                  ${sessions
                    .map(
                      (session) => `<div class="gdv-session-row">
                        <span>${fmtAbs(session.createdAt)}</span>
                        <span>${fmtRel(session.lastUsedAt)}</span>
                        <span>${fmtDay(session.expiresAt)}</span>
                        <span><i class="gdv-dot is-${session.status}"></i>${sessionStatusLabel(session)}</span>
                        <span>${
                          session.status === "active" && !session.current
                            ? `<button type="button" class="gdv-btn is-danger is-sm" data-act="revoke-session" data-id="${escapeHtml(session.id)}">撤销</button>`
                            : ""
                        }</span>
                      </div>`,
                    )
                    .join("")}
                </div>`
              : '<p class="gdv-empty-line">没有有效 Session。</p>'
          }
        </section>

        <section>
          <h3>最近活动</h3>
          ${
            activity.length
              ? `<div class="gdv-mini-timeline">${activity
                  .slice(0, 12)
                  .map((event) => {
                    const meta = EVENT_LABEL[event.eventType] ?? { label: event.eventType, glyph: "·", tone: "mute" };
                    return `<div class="gdv-mini-item"><span class="is-${meta.tone}">${meta.glyph}</span><b>${meta.label}</b><time>${fmtRel(event.createdAt)}</time></div>`;
                  })
                  .join("")}</div>`
              : '<p class="gdv-empty-line">暂无活动记录。</p>'
          }
        </section>
      </div>

      <footer class="gdv-drawer-foot">
        <button type="button" class="gdv-btn" data-act="rename" data-id="${escapeHtml(device.id)}" ${revoked ? "disabled" : ""}>重命名</button>
        ${
          device.isCurrent
            ? '<button type="button" class="gdv-btn is-primary" data-act="sync-current">同步当前设备</button>'
            : revoked
              ? '<span class="gdv-card-note">设备已撤销</span>'
              : `<button type="button" class="gdv-btn" data-act="sync-request" data-id="${escapeHtml(device.id)}">请求下次同步</button>
                 ${device.trusted ? "" : `<button type="button" class="gdv-btn" data-act="trust" data-id="${escapeHtml(device.id)}">这是我的设备</button>`}
                 <button type="button" class="gdv-btn is-danger" data-act="revoke" data-id="${escapeHtml(device.id)}">撤销设备</button>`
        }
      </footer>
    </div>`;
  };

  const syncCurrent = async (): Promise<void> => {
    await guard(async () => {
      // 真实检查一次云端连接（配额接口需要有效 Session + D1），再上报同步结果。
      const response = await fetch("/api/files/quota", {
        credentials: "same-origin",
        headers: { accept: "application/json" },
      });
      if (!response.ok) throw new Error("云端连接检查失败");
      await reportDriveSync({ result: "success" });
      toast("已检查云端连接，同步时间已更新");
      await load(true);
      if (detailId) await openDetail(detailId);
    });
  };

  const handleAction = async (action: string, id?: string): Promise<void> => {
    if (action === "refresh") {
      await load();
      if (view === "activity") await loadActivity();
      return;
    }
    if (action === "pair") {
      if (signedOut || !data) {
        toast("请先登录 Guandao Account");
        return;
      }
      void openPairingDialog(root, ctx);
      return;
    }
    if (action === "login") {
      window.dispatchEvent(new Event("guandao:open-login"));
      return;
    }
    if (action === "close-detail") {
      drawer.hidden = true;
      detailId = null;
      detail = null;
      return;
    }
    if (!data) return;

    const device = id ? data.devices.find((item) => item.id === id) : undefined;

    if (action === "detail" && id) {
      await openDetail(id);
      return;
    }
    if (action === "rename" && device) {
      await openRename(device);
      return;
    }
    if (action === "revoke" && device) {
      await openRevoke(device);
      return;
    }
    if (action === "trust" && device) {
      await guard(async () => {
        await trustDevice(device.id);
        toast("已标记为可信设备");
        await load(true);
        if (detailId === device.id) await openDetail(device.id);
      });
      return;
    }
    if (action === "sync-current") {
      await syncCurrent();
      return;
    }
    if (action === "sync-request" && device) {
      await guard(async () => {
        const response = await requestDeviceSync(device.id);
        toast(response.note || "已记录同步请求");
        await load(true);
      });
      return;
    }
    if (action === "revoke-session" && id) {
      const session = allSessions.find((item) => item.id === id);
      const result = await dialog({
        title: "撤销这个 Session",
        body: `<p class="gdv-modal-note">只撤销这一次登录，不影响设备记录，也不会删除任何数据。</p>
          <p class="gdv-modal-sub">创建于 ${fmtAbs(session?.createdAt ?? null)} · 最近使用 ${fmtRel(session?.lastUsedAt ?? null)}</p>`,
        actions: [
          { label: "取消", value: "cancel" },
          { label: "确认撤销", value: "confirm", tone: "danger" },
        ],
      });
      if (!result || result.action !== "confirm") return;
      await guard(async () => {
        await revokeSession(id);
        toast("Session 已撤销");
        await load(true);
        if (detailId) await openDetail(detailId);
      });
      return;
    }
    if (action === "revoke-others") {
      const result = await dialog({
        title: "退出其他设备",
        body: `<p class="gdv-modal-note">保留当前设备，撤销其他所有登录 Session。</p>
          <p class="gdv-modal-sub">已撤销的设备下一次请求时会收到 401。不会删除任何笔记、任务或文件。</p>`,
        actions: [
          { label: "取消", value: "cancel" },
          { label: "确认退出", value: "confirm", tone: "danger" },
        ],
      });
      if (!result || result.action !== "confirm") return;
      await guard(async () => {
        const response = await revokeOtherSessions();
        toast(`已撤销 ${response.revoked} 个 Session`);
        await load(true);
      });
      return;
    }
    if (action === "revoke-all") {
      await openRevokeAll();
      return;
    }
    if (action === "logout-current") {
      const result = await dialog({
        title: "退出当前设备",
        body: `<p class="gdv-modal-note">只结束这台设备的登录，其他设备与云端数据都不受影响。</p>
          <p class="gdv-modal-sub">退出后需要重新通过 GitHub 登录。</p>`,
        actions: [
          { label: "取消", value: "cancel" },
          { label: "退出登录", value: "confirm", tone: "danger" },
        ],
      });
      if (!result || result.action !== "confirm") return;
      await guard(async () => {
        const response = await fetch("/api/auth/logout", {
          method: "POST",
          credentials: "same-origin",
          headers: { accept: "application/json" },
        });
        if (!response.ok) throw new Error("退出失败，请重试");
        signedOut = true;
        showSignedOut("已退出当前设备。");
        window.dispatchEvent(new Event("guandao:signed-out"));
      });
    }
  };

  /* ------------------------------ 事件 ------------------------------ */

  root.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const nav = target.closest<HTMLElement>("[data-view]");
    if (nav?.dataset.view) {
      view = nav.dataset.view as ViewId;
      if (view === "activity") {
        body.innerHTML = '<div class="gdv-loading"><span></span><p>正在读取安全活动…</p></div>';
        void loadActivity();
      } else {
        render();
      }
      return;
    }

    const actionNode = target.closest<HTMLElement>("[data-act]");
    if (actionNode?.dataset.act) {
      void handleAction(actionNode.dataset.act, actionNode.dataset.id);
    }
  });

  const onSessionLost = (): void => {
    signedOut = true;
    showSignedOut("登录已失效，请重新登录。");
  };

  const onChanged = (): void => {
    if (win.isConnected) void load(true);
  };

  window.addEventListener("guandao:device-session-lost", onSessionLost);
  window.addEventListener("guandao:devices-changed", onChanged);
  window.addEventListener("guandao:open-login", onSessionLost);

  void load();
  // 闭包里的 view 会被 TS 收窄成初始字面量，这里显式还原联合类型
  if ((view as ViewId) === "activity") void loadActivity();

  return () => {
    window.removeEventListener("guandao:device-session-lost", onSessionLost);
    window.removeEventListener("guandao:devices-changed", onChanged);
    window.removeEventListener("guandao:open-login", onSessionLost);
  };
};
