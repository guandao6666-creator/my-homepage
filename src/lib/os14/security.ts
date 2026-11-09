/**
 * Guandao Security Center · 隐私与安全
 *
 * 所有状态来自 /api/privacy/*、/api/security/*、/api/devices/* 与真实 D1 计数。
 * 未检测/无法验证的项目显示 Unknown，不伪装成 Protected。
 */

// 1.9：应用样式跟着应用代码一起按需加载，不再压进首屏 CSS
import "../../styles/security.css";
import { escapeHtml, type Ctx } from "./core";
import {
  buildLocalSnapshot,
  clearLocalData,
  continueAccountDeletion,
  createExport,
  deleteAccount,
  deleteCloudData,
  exportDownloadUrl,
  getOverview,
  listEvents,
  listExports,
  localDataSummary,
  runDeletionUntilDone,
  runExportUntilDone,
  saveSettings,
  startReauth,
  type DataExport,
  type PrivacyOverview,
  type PrivacySettings,
  type SecurityEvent,
  type SecurityStatus,
} from "../privacy/client";
import {
  listAllSessions,
  listDevices,
  renameDevice,
  revokeAllSessions,
  revokeDevice,
  revokeOtherSessions,
  revokeSession,
  trustDevice,
  type Device,
  type DeviceSession,
} from "../devices/client";

type ViewId = "overview" | "account" | "access" | "privacy" | "data" | "export" | "activity" | "delete";

const NAV: Array<{ id: ViewId; label: string; glyph: string }> = [
  { id: "overview", label: "Overview", glyph: "◈" },
  { id: "account", label: "Account Security", glyph: "◎" },
  { id: "access", label: "Device & Sessions", glyph: "▣" },
  { id: "privacy", label: "Privacy", glyph: "◐" },
  { id: "data", label: "Data Control", glyph: "▤" },
  { id: "export", label: "Export", glyph: "⇩" },
  { id: "activity", label: "Security Activity", glyph: "⌁" },
  { id: "delete", label: "Delete Account", glyph: "⊘" },
];

const CHECK_TONE: Record<SecurityStatus, { label: string; tone: string; glyph: string }> = {
  protected: { label: "Protected", tone: "ok", glyph: "✓" },
  attention: { label: "Attention Required", tone: "warn", glyph: "!" },
  not_configured: { label: "Not Configured", tone: "mute", glyph: "○" },
  failed: { label: "Check Failed", tone: "danger", glyph: "×" },
  unknown: { label: "Unknown", tone: "mute", glyph: "?" },
};

const EVENT_LABEL: Record<string, { label: string; tone: string; glyph: string }> = {
  successful_login: { label: "登录成功", tone: "ok", glyph: "→" },
  failed_login: { label: "登录失败", tone: "danger", glyph: "×" },
  new_device_registered: { label: "新设备注册", tone: "accent", glyph: "＋" },
  session_created: { label: "创建 Session", tone: "accent", glyph: "◷" },
  session_revoked: { label: "撤销 Session", tone: "warn", glyph: "⌫" },
  suspicious_access_blocked: { label: "拦截可疑访问", tone: "danger", glyph: "⊘" },
  data_export_started: { label: "开始导出", tone: "accent", glyph: "⇩" },
  data_export_completed: { label: "导出完成", tone: "ok", glyph: "✓" },
  data_deletion_started: { label: "开始删除数据", tone: "warn", glyph: "⌫" },
  data_deletion_completed: { label: "数据删除完成", tone: "ok", glyph: "✓" },
  account_deletion_started: { label: "开始注销账号", tone: "danger", glyph: "⊘" },
  account_deletion_completed: { label: "账号注销完成", tone: "danger", glyph: "⊘" },
  privacy_settings_changed: { label: "修改隐私设置", tone: "mute", glyph: "⚙" },
  local_data_cleared: { label: "清除本地数据", tone: "warn", glyph: "⌫" },
};

const DOMAIN_LABEL: Record<string, string> = {
  notes: "Notes",
  tasks: "Tasks",
  calendar: "Calendar",
  desktop: "Desktop",
  workspace: "Workspace",
  drive: "Cloud Drive",
};

export const renderSecurity = (): string => `
  <div class="gsc" data-security>
    <aside class="gsc-side">
      <div class="gsc-brand">
        <span class="gsc-brand-logo">⛨</span>
        <div><b>Privacy & Security</b><i>Your Data. Your Control.</i></div>
      </div>
      <nav class="gsc-nav" data-nav>
        ${NAV.map(
          (item) => `<button type="button" class="gsc-nav-item" data-view="${item.id}">
            <span class="gsc-nav-ico">${item.glyph}</span><span>${item.label}</span>
          </button>`,
        ).join("")}
      </nav>
      <div class="gsc-side-foot">
        <p class="gsc-side-label">当前账号</p>
        <b data-side-name>—</b>
        <span data-side-sub>—</span>
        <button type="button" class="gsc-side-action" data-act="logout-current">退出当前设备</button>
      </div>
    </aside>

    <section class="gsc-main">
      <header class="gsc-top">
        <div>
          <p class="gsc-eyebrow">GUANDAO OS 1.5 · SECURITY</p>
          <h1 data-title>Overview</h1>
          <p class="gsc-sub" data-sub>正在读取安全状态…</p>
        </div>
        <div class="gsc-top-actions">
          <span class="gsc-chip" data-checked>—</span>
          <button type="button" class="gsc-icon-btn" data-act="refresh" title="刷新" aria-label="刷新">↻</button>
        </div>
      </header>
      <div class="gsc-scroll" data-body>
        <div class="gsc-loading"><span></span><p>正在读取安全状态…</p></div>
      </div>
    </section>

    <div class="gsc-overlay" data-overlay hidden></div>
  </div>
`;

export const initSecurity = (win: HTMLElement, ctx: Ctx): (() => void) => {
  const root = win.querySelector<HTMLElement>("[data-security]");
  if (!root) return () => undefined;

  const body = root.querySelector<HTMLElement>("[data-body]")!;
  const title = root.querySelector<HTMLElement>("[data-title]")!;
  const sub = root.querySelector<HTMLElement>("[data-sub]")!;
  const checkedChip = root.querySelector<HTMLElement>("[data-checked]")!;
  const overlay = root.querySelector<HTMLElement>("[data-overlay]")!;
  const sideName = root.querySelector<HTMLElement>("[data-side-name]")!;
  const sideSub = root.querySelector<HTMLElement>("[data-side-sub]")!;

  let view: ViewId = "overview";
  let loading = true;
  let error = "";
  let signedOut = false;
  let busy = false;

  let overview: PrivacyOverview | null = null;
  let devices: Device[] = [];
  let sessions: DeviceSession[] = [];
  let exports: DataExport[] = [];
  let events: SecurityEvent[] = [];
  let eventsTotal = 0;
  let eventType = "";
  let eventDays = "30";
  let reauthReady = new URLSearchParams(location.search).get("delete_verified") === "1";

  const toast = (message: string) => {
    if (ctx?.toast) ctx.toast(message);
    else {
      const node = document.createElement("div");
      node.className = "gsc-toast";
      node.textContent = message;
      root.appendChild(node);
      window.setTimeout(() => node.remove(), 2600);
    }
  };

  /* ------------------------------ 格式化 ------------------------------ */

  const fmtAbs = (ms: number | null | undefined): string => {
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

  const fmtDay = (ms: number | null | undefined): string => {
    if (!ms) return "—";
    try {
      return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }).format(
        new Date(ms),
      );
    } catch {
      return "—";
    }
  };

  const fmtRel = (ms: number | null | undefined): string => {
    if (!ms) return "—";
    const delta = Date.now() - ms;
    if (delta < 60_000) return "刚刚";
    if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
    if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
    if (delta < 7 * 86_400_000) return `${Math.floor(delta / 86_400_000)} 天前`;
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

  const deviceIcon = (type: string): string => {
    const icons: Record<string, string> = {
      desktop:
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8.5 20h7M12 16v4"/></svg>',
      laptop:
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="4" y="5" width="16" height="10.5" rx="1.8"/><path d="M2.2 19h19.6"/></svg>',
      tablet:
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="5" y="2.6" width="14" height="18.8" rx="2.4"/><path d="M10.8 18.4h2.4"/></svg>',
      mobile:
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="7" y="2" width="10" height="20" rx="2.6"/><path d="M10.6 18.6h2.8"/></svg>',
    };
    return icons[type] ?? icons.desktop;
  };

  /* ------------------------------ 弹窗 / 进度 ------------------------------ */

  const setOverlay = (html: string | null) => {
    if (!html) {
      overlay.hidden = true;
      overlay.innerHTML = "";
      return;
    }
    overlay.hidden = false;
    overlay.innerHTML = html;
  };

  const progress = (label: string, percent: number, detail = "") => {
    setOverlay(`<div class="gsc-progress">
      <p>SECURITY TASK</p>
      <h2>${escapeHtml(label)}</h2>
      <div class="gsc-bar"><span style="width:${Math.min(Math.max(percent, 2), 100)}%"></span></div>
      <small>${escapeHtml(detail || `${percent}%`)}</small>
    </div>`);
  };

  const dialog = (options: {
    title: string;
    body: string;
    actions: Array<{ label: string; value: string; tone?: "primary" | "danger" }>;
    requireText?: string;
  }): Promise<{ action: string; values: Record<string, string>; checks: Record<string, boolean> } | null> =>
    new Promise((resolve) => {
      const wrap = document.createElement("div");
      wrap.className = "gsc-modal";
      wrap.innerHTML = `<div class="gsc-modal-card" role="dialog" aria-modal="true">
        <h2>${escapeHtml(options.title)}</h2>
        <div class="gsc-modal-body">${options.body}</div>
        <div class="gsc-modal-actions">
          ${options.actions
            .map(
              (action) =>
                `<button type="button" class="gsc-btn ${action.tone === "primary" ? "is-primary" : ""} ${action.tone === "danger" ? "is-danger" : ""}" data-dv="${action.value}">${escapeHtml(action.label)}</button>`,
            )
            .join("")}
        </div>
      </div>`;
      root.appendChild(wrap);

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
        const checks: Record<string, boolean> = {};
        wrap.querySelectorAll<HTMLInputElement>("[data-field]").forEach((field) => {
          values[field.dataset.field || ""] = field.value;
        });
        wrap.querySelectorAll<HTMLInputElement>("[data-check]").forEach((box) => {
          checks[box.dataset.check || ""] = box.checked;
        });
        resolve(value ? { action: value, values, checks } : null);
        window.setTimeout(() => wrap.remove(), 0);
      };

      wrap.addEventListener("click", (event) => {
        if (event.target === wrap) return done(null);
        const btn = (event.target as HTMLElement).closest<HTMLElement>("[data-dv]");
        if (btn && !btn.hasAttribute("disabled")) done(btn.dataset.dv ?? "");
      });
    });

  const guard = async (task: () => Promise<void>) => {
    if (busy) return;
    busy = true;
    try {
      await task();
    } catch (err) {
      const message = err instanceof Error ? err.message : "操作失败";
      toast(message);
    } finally {
      busy = false;
      setOverlay(null);
    }
  };

  /* ------------------------------ 数据加载 ------------------------------ */

  const load = async (silent = false): Promise<void> => {
    if (!silent) {
      loading = true;
      render();
    }
    try {
      const [data, deviceData, sessionData, exportData] = await Promise.all([
        getOverview(),
        listDevices(),
        listAllSessions(),
        listExports(),
      ]);
      overview = data;
      devices = deviceData.devices;
      sessions = sessionData.sessions;
      exports = exportData.exports;
      events = data.recentEvents;
      eventsTotal = data.inventory.events.total;
      error = "";
      signedOut = false;
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 401) signedOut = true;
      else error = err instanceof Error ? err.message : "加载失败";
    } finally {
      loading = false;
      render();
    }
  };

  const loadEvents = async (): Promise<void> => {
    const from = eventDays === "all" ? "" : String(Date.now() - Number(eventDays) * 86_400_000);
    try {
      const result = await listEvents({ limit: 100, type: eventType, from });
      events = result.events;
      eventsTotal = result.total;
    } catch {
      events = [];
      eventsTotal = 0;
    }
    if (view === "activity") render();
  };

  /* ------------------------------ 渲染 ------------------------------ */

  const scoreBlock = (data: PrivacyOverview): string => {
    const value = data.score.value;
    const tone = value === null ? "mute" : value >= 80 ? "ok" : value >= 50 ? "warn" : "danger";
    return `<section class="gsc-score is-${tone}">
      <div class="gsc-score-value">${value === null ? "—" : value}<small>/100</small></div>
      <div class="gsc-score-info">
        <b>Security Score</b>
        <p>${escapeHtml(data.score.rules)}</p>
        <span>已计入权重 ${data.score.evaluatedWeight}/${data.score.totalWeight}</span>
      </div>
    </section>`;
  };

  const renderOverview = (): string => {
    if (!overview) return "";
    const data = overview;
    const local = localDataSummary();
    const failed = data.checks.filter((check) => check.status === "failed").length;
    const attention = data.checks.filter((check) => check.status === "attention").length;

    return `
      <section class="gsc-hero">
        <div>
          <p class="gsc-hero-eyebrow">SIGNED IN AS</p>
          <h2>${escapeHtml(data.account.displayName)}</h2>
          <p>${data.account.githubUsername ? `@${escapeHtml(data.account.githubUsername)}` : "Guando Account"} · ${data.account.role === "admin" ? "管理员" : "成员"} · 上次登录 ${fmtRel(data.account.lastLoginAt)}</p>
          <div class="gsc-hero-badges">
            <span class="gsc-badge is-${data.account.deletionState === "pending" ? "danger" : "ok"}">${data.account.deletionState === "pending" ? "账号待删除" : "GitHub OAuth"}</span>
            <span class="gsc-badge is-mute">${data.counts.activeSessions} 个有效 Session</span>
            <span class="gsc-badge is-mute">${data.counts.activeDevices} 台设备</span>
          </div>
        </div>
        <div class="gsc-hero-actions">
          <button type="button" class="gsc-btn is-primary" data-act="goto-export">导出我的数据</button>
          <button type="button" class="gsc-btn" data-act="goto-access">管理登录设备</button>
        </div>
      </section>

      ${scoreBlock(data)}

      <div class="gsc-stats">
        ${stat("有效 Session", String(data.counts.activeSessions), `${data.counts.totalSessions} 条历史记录`)}
        ${stat("注册设备", String(data.counts.activeDevices), data.counts.untrustedDevices ? `${data.counts.untrustedDevices} 台未确认` : "全部已确认")}
        ${stat("最近备份", data.backup ? fmtRel(data.backup.createdAt) : "—", data.backup?.verifiedAt ? "已校验" : "无已完成备份")}
        ${stat("安全事件", String(data.inventory.events.total), failed ? `${failed} 项检查失败` : attention ? `${attention} 项需注意` : "无失败检查")}
      </div>

      <section class="gsc-section">
        <div class="gsc-section-head"><h2>安全检查</h2><p>状态来自真实探测与数据库；Unknown 不计分，也不标记为安全。</p></div>
        <div class="gsc-checks">
          ${data.checks
            .map((check) => {
              const meta = CHECK_TONE[check.status];
              return `<article class="gsc-check is-${meta.tone}">
                <span class="gsc-check-ico">${meta.glyph}</span>
                <div class="gsc-check-main">
                  <div class="gsc-check-title"><b>${escapeHtml(check.label)}</b><em class="is-${meta.tone}">${meta.label}</em></div>
                  <p>${escapeHtml(check.detail)}</p>
                  ${check.evidence ? `<small>${escapeHtml(check.evidence.join(" · "))}</small>` : ""}
                </div>
                <span class="gsc-check-weight">权重 ${check.weight}</span>
              </article>`;
            })
            .join("")}
        </div>
      </section>

      <section class="gsc-section">
        <div class="gsc-section-head"><h2>最近安全活动</h2><p>只记录动作与结果，不含笔记正文、令牌或文件内容。</p></div>
        ${events.length ? `<div class="gsc-events">${events.slice(0, 6).map(eventRow).join("")}</div>` : '<p class="gsc-empty-line">还没有安全事件。</p>'}
        <button type="button" class="gsc-btn is-sm" data-act="goto-activity">查看全部 ${eventsTotal} 条</button>
      </section>

      <section class="gsc-section">
        <div class="gsc-note-card">
          <b>数据位置（真实）</b>
          <p>本地：Notes ${local.notes} 条 · Tasks ${local.tasks} 条 · Calendar ${local.calendar} 条 · 配置 ${local.desktopKeys + local.workspaceKeys} 项。</p>
          <p>云端：文件 ${data.inventory.files.total} 个（${fmtBytes(data.inventory.files.bytes)}）· 备份 ${data.inventory.backups.total} 个 · 安全事件 ${data.inventory.events.total} 条。</p>
          <p>Notes / Tasks / Calendar 目前没有云同步，只在本机；导出或备份时才会上传快照。</p>
        </div>
      </section>`;
  };

  const stat = (label: string, value: string, hint: string) => `
    <div class="gsc-stat"><p>${label}</p><b>${value}</b><span>${hint}</span></div>`;

  const eventRow = (event: SecurityEvent): string => {
    const meta = EVENT_LABEL[event.eventType] ?? { label: event.eventType, tone: "mute", glyph: "·" };
    const extras: string[] = [];
    if (event.metadata?.reason) extras.push(String(event.metadata.reason));
    if (event.metadata?.count !== undefined) extras.push(`${event.metadata.count} 条`);
    if (event.metadata?.targets) extras.push(String(event.metadata.targets));
    return `<div class="gsc-event is-${meta.tone}">
      <span class="gsc-event-ico">${meta.glyph}</span>
      <div><b>${meta.label}</b><span>${escapeHtml(extras.join(" · ") || (event.result === "failure" ? "失败" : "成功"))}</span></div>
      <time>${fmtAbs(event.createdAt)}</time>
    </div>`;
  };

  const renderAccount = (): string => {
    if (!overview) return "";
    const data = overview;
    return `
      <section class="gsc-profile">
        <div class="gsc-avatar">${escapeHtml((data.account.displayName || "管").slice(0, 1))}</div>
        <div>
          <p class="gsc-eyebrow">GUANDAO ACCOUNT</p>
          <h2>${escapeHtml(data.account.displayName)}</h2>
          <p>${data.account.githubUsername ? `@${escapeHtml(data.account.githubUsername)}` : "—"}</p>
        </div>
        <div class="gsc-profile-meta">
          <div><span>账号 ID</span><b>${escapeHtml(data.account.id)}</b></div>
          <div><span>角色</span><b>${data.account.role === "admin" ? "管理员" : "成员"}</b></div>
          <div><span>创建</span><b>${fmtDay(data.account.createdAt)}</b></div>
          <div><span>最近登录</span><b>${fmtRel(data.account.lastLoginAt)}</b></div>
        </div>
      </section>

      <section class="gsc-section">
        <div class="gsc-section-head"><h2>GitHub OAuth</h2><p>只用于身份认证，scope 为 read:user；不申请仓库权限。</p></div>
        <div class="gsc-info-card">
          <div><span>认证方式</span><b>GitHub OAuth（PKCE S256）</b></div>
          <div><span>身份绑定</span><b>${data.account.githubUsername ? `@${escapeHtml(data.account.githubUsername)}` : "未绑定"}</b></div>
          <div><span>登录状态</span><b class="is-ok">可用</b></div>
          <div><span>Token 存储</span><b>不保存 Access Token；Session 只存 SHA-256</b></div>
        </div>
        <p class="gsc-hint">这里不管理 GitHub 仓库，也不会请求 repo / gist / workflow 权限。</p>
      </section>

      <section class="gsc-section">
        <div class="gsc-section-head"><h2>登录安全</h2><p>所有撤销在服务端立即生效。</p></div>
        <div class="gsc-actions-row">
          <button type="button" class="gsc-btn" data-act="revoke-others">退出其他设备</button>
          <button type="button" class="gsc-btn is-danger" data-act="revoke-all">退出所有设备</button>
          <button type="button" class="gsc-btn is-danger" data-act="logout-current">退出当前设备</button>
        </div>
        <p class="gsc-hint">退出所有设备会撤销全部 Session；当前页面会回到登录界面。</p>
      </section>`;
  };

  const renderAccess = (): string => `
    <section class="gsc-section">
      <div class="gsc-section-head"><h2>设备访问</h2><p>在线状态由 5 分钟内的前台心跳推断，不代表可以实时控制离线设备。</p></div>
      <div class="gsc-devices">
        ${
          devices.length
            ? devices
                .map(
                  (device) => `<article class="gsc-device${device.isCurrent ? " is-current" : ""}${device.status === "revoked" ? " is-revoked" : ""}">
                    <span class="gsc-device-ico is-${device.type}">${deviceIcon(device.type)}</span>
                    <div class="gsc-device-main">
                      <div><b>${escapeHtml(device.name)}</b>${device.isCurrent ? '<em class="is-current">CURRENT</em>' : ""}${device.status === "revoked" ? '<em class="is-danger">已撤销</em>' : ""}${!device.trusted && !device.isCurrent ? '<em class="is-warn">未确认</em>' : ""}</div>
                      <p>${escapeHtml(device.os)} · ${escapeHtml(device.browser)} · 最后活动 ${fmtRel(device.lastActiveAt || device.lastSeenAt)} · ${device.activeSessionCount} 个 Session</p>
                    </div>
                    <div class="gsc-device-actions">
                      <button type="button" class="gsc-btn is-sm" data-act="rename-device" data-id="${escapeHtml(device.id)}">重命名</button>
                      ${!device.trusted && !device.isCurrent ? `<button type="button" class="gsc-btn is-sm" data-act="trust-device" data-id="${escapeHtml(device.id)}">确认设备</button>` : ""}
                      ${!device.isCurrent && device.status !== "revoked" ? `<button type="button" class="gsc-btn is-sm is-danger" data-act="revoke-device" data-id="${escapeHtml(device.id)}">撤销</button>` : ""}
                    </div>
                  </article>`,
                )
                .join("")
            : '<p class="gsc-empty-line">没有注册设备。</p>'
        }
      </div>
    </section>

    <section class="gsc-section">
      <div class="gsc-section-head"><h2>Session 管理</h2><p>不显示完整 Token；一台设备可以有多个 Session。</p></div>
      <div class="gsc-session-table">
        <div class="gsc-session-row is-head"><span>设备</span><span>创建</span><span>最近使用</span><span>过期</span><span>状态</span><span>操作</span></div>
        ${
          sessions.length
            ? sessions
                .map(
                  (session) => `<div class="gsc-session-row">
                    <span>${escapeHtml(session.deviceName || "未绑定设备")}</span>
                    <span>${fmtAbs(session.createdAt)}</span>
                    <span>${fmtRel(session.lastUsedAt)}</span>
                    <span>${fmtDay(session.expiresAt)}</span>
                    <span><i class="gsc-dot is-${session.status}"></i>${session.status === "active" ? (session.current ? "当前会话" : "有效") : session.status === "revoked" ? "已撤销" : "已过期"}</span>
                    <span>${session.status === "active" && !session.current ? `<button type="button" class="gsc-btn is-sm is-danger" data-act="revoke-session" data-id="${escapeHtml(session.id)}">撤销</button>` : ""}</span>
                  </div>`,
                )
                .join("")
            : '<p class="gsc-empty-line">没有 Session。</p>'
        }
      </div>
    </section>`;

  const renderPrivacy = (): string => {
    if (!overview) return "";
    const settings = overview.settings;
    const toggle = (key: keyof PrivacySettings, label: string, hint: string, disabled = false) => `
      <label class="gsc-toggle${settings[key] ? " is-on" : ""}${disabled ? " is-disabled" : ""}">
        <input type="checkbox" data-setting="${key}" ${settings[key] ? "checked" : ""} ${disabled ? "disabled" : ""} />
        <span class="gsc-switch"></span>
        <span><b>${label}</b><i>${hint}</i></span>
      </label>`;

    return `
      <section class="gsc-section">
        <div class="gsc-section-head"><h2>云端上传控制</h2><p>关闭后服务端会拒绝该类型的备份上传；本地数据保留，云端历史不会自动删除。</p></div>
        <div class="gsc-toggles">
          ${toggle("cloudSync", "允许本地数据上传到云端", "总开关：关闭后 Notes / Tasks / Calendar / 桌面 / 工作空间不能上传；Cloud Drive 不受影响")}
          ${toggle("notes", "Notes", "笔记正文、文件夹与标签")}
          ${toggle("tasks", "Tasks", "任务、优先级与截止日期")}
          ${toggle("calendar", "Calendar", "日程、重复规则与提醒")}
          ${toggle("desktop", "Desktop", "Dock、壁纸、主题、组件与个性化")}
          ${toggle("workspace", "Workspace", "工作空间与窗口布局")}
        </div>
        <p class="gsc-hint">关闭不等于删除。重新开启后可手动创建新的备份。云同步引擎尚未实现，当前这些开关实际约束的是云端备份上传。</p>
      </section>

      <section class="gsc-section">
        <div class="gsc-section-head"><h2>数据在哪里</h2><p>与当前实现一致，不包含未实现的加密承诺。</p></div>
        <div class="gsc-map">
          <div><b>浏览器本地</b><p>Notes、Tasks、Calendar、桌面与工作空间配置。不离开设备，直到你主动备份或导出。</p><span class="gsc-badge is-mute">localStorage / IndexedDB</span></div>
          <div><b>Cloudflare D1</b><p>账号、Session 元数据、设备、文件元数据、备份记录、安全事件、隐私设置。</p><span class="gsc-badge is-mute">数据库</span></div>
          <div><b>Cloudflare R2</b><p>Cloud Drive 文件本体、备份副本、导出包。Bucket 保持私有，文件只通过鉴权 API 提供；Bucket 级公网策略需在 Cloudflare 侧确认。</p><span class="gsc-badge is-mute">对象存储</span></div>
          <div><b>不收集</b><p>精确地理位置、设备指纹、通讯录、GitHub 仓库内容。UA 只解析浏览器/系统/设备类型。</p><span class="gsc-badge is-ok">minimal</span></div>
        </div>
      </section>

      <section class="gsc-section">
        <div class="gsc-section-head"><h2>Cookie 与存储</h2></div>
        <div class="gsc-info-card">
          <div><span>Session Cookie</span><b>gauth_sid · HttpOnly · SameSite=Lax · Secure（HTTPS）· Path=/ · 30 天</b></div>
          <div><span>设备 Cookie</span><b>gauth_did · HttpOnly · 一年，用于识别同一设备</b></div>
          <div><span>注销验证 Cookie</span><b>gauth_reauth · HttpOnly · 10 分钟，仅 /api</b></div>
          <div><span>访问统计</span><b>Cloudflare Web Analytics：无 Cookie、不跨站，仅聚合页面访问；由 Cloudflare 边缘注入</b></div>
          <div><span>广告 / 追踪脚本</span><b>没有接入</b></div>
        </div>
        <p class="gsc-hint">站点仍会加载 GitHub 头像与 Supabase 公共内容；它们受各自隐私政策约束。</p>
      </section>

      <section class="gsc-section">
        <div class="gsc-section-head"><h2>浏览器安全策略</h2><p>Worker 对每个 HTML 响应下发，已从 Report-Only 切换为强制。</p></div>
        <div class="gsc-info-card">
          <div><span>Content-Security-Policy</span><b>强制 · 内联脚本按 SHA-256 哈希放行 · 无 unsafe-eval</b></div>
          <div><span>HSTS</span><b>max-age=31536000; includeSubDomains（仅 HTTPS）</b></div>
          <div><span>其他响应头</span><b>nosniff · Referrer-Policy · Permissions-Policy · COOP</b></div>
          <div><span>嵌入限制</span><b>frame-ancestors 'none' + X-Frame-Options: DENY</b></div>
        </div>
      </section>

      <section class="gsc-section">
        <div class="gsc-section-head"><h2>请求频率限制</h2><p>服务端固定窗口计数，身份只保存加盐 SHA-256 前缀，不保留 IP 原文。</p></div>
        <div class="gsc-info-card">
          <div><span>全局上限</span><b>${overview.rateLimits.global.limit} 次 / ${Math.round(overview.rateLimits.global.windowSeconds / 60)} 分钟（每个来源 IP，/api/health 除外）</b></div>
          <div><span>敏感接口规则</span><b>${overview.rateLimits.rules.length} 条（登录、上传、备份、导出、删除、下载）</b></div>
          <div><span>过去 24 小时</span><b>${overview.rateLimits.blocked24h === null ? "统计不可用" : `拦截 ${overview.rateLimits.blocked24h} 次 · 计入窗口 ${overview.rateLimits.hits24h ?? 0} 次`}</b></div>
        </div>
        <div class="gsc-limit-list">
          ${overview.rateLimits.rules
            .map(
              (rule) => `<span><b>${escapeHtml(rule.label)}</b>${rule.limit} 次 / ${
                rule.windowSeconds >= 3600 ? `${Math.round(rule.windowSeconds / 3600)} 小时` : `${Math.round(rule.windowSeconds / 60)} 分钟`
              }</span>`,
            )
            .join("")}
        </div>
        <p class="gsc-hint">超过上限返回 429 与 Retry-After；计数表按 24 小时滚动清理。D1 完全不可用时统计读不到，这一项会显示 Unknown；如果只是单次写入失败，那一次请求退化为内存计数（fail-open），事后统计无法区分。</p>
      </section>`;
  };

  const renderData = (): string => {
    if (!overview) return "";
    const inv = overview.inventory;
    const local = localDataSummary();
    return `
      <section class="gsc-section">
        <div class="gsc-section-head"><h2>个人数据清单</h2><p>数量来自 D1 实时查询；本地数量来自当前浏览器。</p></div>
        <div class="gsc-inventory">
          <div class="gsc-inv-block"><h3>账号</h3><p>资料 1 · Session ${inv.sessions.total} · 设备 ${inv.devices.total}</p><span>D1 · users / sessions / devices</span></div>
          <div class="gsc-inv-block"><h3>个人内容</h3><p>Notes ${local.notes} · Tasks ${local.tasks} · Calendar ${local.calendar} · 桌面 ${local.desktopKeys} 项 · 工作空间 ${local.workspaceKeys} 项</p><span>仅本地浏览器</span></div>
          <div class="gsc-inv-block"><h3>文件</h3><p>${inv.files.total} 个 · ${fmtBytes(inv.files.bytes)} · 回收站 ${inv.files.trash} · 文件夹 ${inv.folders.total}</p><span>R2 + D1 元数据</span></div>
          <div class="gsc-inv-block"><h3>备份</h3><p>${inv.backups.total} 个 · ${fmtBytes(inv.backups.bytes)} · 已校验 ${inv.backups.verified}</p><span>R2（独立于实时文件）</span></div>
          <div class="gsc-inv-block"><h3>活动记录</h3><p>安全事件 ${inv.events.total} · 文件操作 ${inv.fileEvents.total}</p><span>D1 · 保留 180 天安全日志</span></div>
          <div class="gsc-inv-block"><h3>未使用</h3><p>云端 Notes 表 ${inv.legacyCloudNotes.total} 条（当前 Notes 不走云同步）</p><span>D1 · notes</span></div>
        </div>
      </section>

      <section class="gsc-section">
        <div class="gsc-section-head"><h2>删除云端内容</h2><p>先删除 R2 对象，再删除 D1 记录；失败会保留待清理状态。</p></div>
        <div class="gsc-danger-grid">
          <button type="button" class="gsc-danger-card" data-act="delete-files">
            <b>删除所有云端文件</b><span>${inv.files.total} 个文件 · ${fmtBytes(inv.files.bytes)} · 备份不受影响</span>
          </button>
          <button type="button" class="gsc-danger-card" data-act="delete-backups">
            <b>删除所有历史备份</b><span>${inv.backups.total} 个备份 · ${fmtBytes(inv.backups.bytes)} · 实时文件不受影响</span>
          </button>
        </div>
        <p class="gsc-hint">单条文件请到 Cloud Drive 删除；回收站可在 Cloud Drive 中恢复或永久清除。</p>
      </section>

      <section class="gsc-section">
        <div class="gsc-section-head"><h2>清除本地数据</h2><p>只清除当前浏览器的 Guandao OS 数据，不删除云端。</p></div>
        <div class="gsc-danger-card is-wide" data-act="clear-local">
          <div><b>清除本地缓存与布局</b><span>Notes ${local.notes} · Tasks ${local.tasks} · Calendar ${local.calendar} · 配置 ${local.desktopKeys + local.workspaceKeys} 项 · IndexedDB</span></div>
          <button type="button" class="gsc-btn is-danger" data-act="clear-local">清除</button>
        </div>
        <p class="gsc-hint">这些数据尚未同步到云端（Notes/Tasks/Calendar 没有云同步），清除后无法从服务器恢复，只能从你自己的备份恢复。</p>
      </section>`;
  };

  const renderExport = (): string => `
    <section class="gsc-section">
      <div class="gsc-section-head"><h2>创建数据导出</h2><p>服务端把结构化数据与文件复制到独立导出前缀，完成后 7 天内可下载。</p></div>
      <div class="gsc-export-card">
        <div>
          <b>完整导出</b>
          <p>账号、设备、Session 元数据、文件元数据、备份记录、安全事件、隐私设置，以及当前设备的 Notes/Tasks/Calendar/桌面快照。</p>
        </div>
        <div class="gsc-export-actions">
          <button type="button" class="gsc-btn is-primary" data-act="create-export-full">包含文件内容</button>
          <button type="button" class="gsc-btn" data-act="create-export-meta">仅元数据</button>
        </div>
      </div>
      <p class="gsc-hint">导出不包含 Session Token、OAuth Secret、Token Hash。文件按批次流式复制，不整包读入内存。</p>
    </section>

    <section class="gsc-section">
      <div class="gsc-section-head"><h2>历史导出</h2><p>过期后自动清理；只有所属账号可以下载。</p></div>
      ${
        exports.length
          ? `<div class="gsc-export-list">${exports
              .map(
                (item) => `<div class="gsc-export-row">
                  <div><b>${item.type === "full" ? "完整导出" : "元数据导出"}</b><span>${fmtAbs(item.createdAt)} · ${item.fileCount} 个文件 · ${fmtBytes(item.sizeBytes)}</span>
                    <em class="is-${item.status === "completed" ? "ok" : item.status === "failed" ? "danger" : "warn"}">${item.status}</em>
                  </div>
                  <div>
                    ${item.status === "completed" ? `<button type="button" class="gsc-btn is-sm" data-act="download-export-json" data-id="${escapeHtml(item.id)}">JSON</button><button type="button" class="gsc-btn is-sm" data-act="download-export-zip" data-id="${escapeHtml(item.id)}">ZIP</button>` : ""}
                  </div>
                </div>`,
              )
              .join("")}</div>`
          : '<p class="gsc-empty-line">还没有导出记录。</p>'
      }
    </section>`;

  const renderActivity = (): string => `
    <section class="gsc-section">
      <div class="gsc-toolbar">
        <select data-event-type>
          <option value="">全部事件</option>
          ${Object.entries(EVENT_LABEL)
            .map(([key, value]) => `<option value="${key}" ${eventType === key ? "selected" : ""}>${value.label}</option>`)
            .join("")}
        </select>
        <select data-event-days>
          <option value="7" ${eventDays === "7" ? "selected" : ""}>最近 7 天</option>
          <option value="30" ${eventDays === "30" ? "selected" : ""}>最近 30 天</option>
          <option value="90" ${eventDays === "90" ? "selected" : ""}>最近 90 天</option>
          <option value="all" ${eventDays === "all" ? "selected" : ""}>全部</option>
        </select>
        <span class="gsc-toolbar-count">${eventsTotal} 条记录</span>
      </div>
      ${events.length ? `<div class="gsc-events is-full">${events.map(eventRow).join("")}</div>` : '<p class="gsc-empty-line">没有符合条件的记录。</p>'}
    </section>`;

  const renderDelete = (): string => {
    if (!overview) return "";
    const inv = overview.inventory;
    return `
      <section class="gsc-delete-hero">
        <span>⊘</span>
        <div>
          <h2>Delete Account</h2>
          <p>永久删除账号、设备、Session、云端文件、历史备份与个人内容。此操作不可撤销。</p>
        </div>
      </section>

      <section class="gsc-section">
        <div class="gsc-section-head"><h2>注销前检查</h2><p>先导出需要保留的数据。</p></div>
        <div class="gsc-delete-stats">
          <div><span>Notes / Tasks / Calendar</span><b>${localDataSummary().notes} / ${localDataSummary().tasks} / ${localDataSummary().calendar}</b></div>
          <div><span>云端文件</span><b>${inv.files.total} 个 · ${fmtBytes(inv.files.bytes)}</b></div>
          <div><span>历史备份</span><b>${inv.backups.total} 个 · ${fmtBytes(inv.backups.bytes)}</b></div>
          <div><span>有效 Session</span><b>${inv.sessions.active}</b></div>
          <div><span>注册设备</span><b>${inv.devices.total}</b></div>
        </div>
        <div class="gsc-actions-row">
          <button type="button" class="gsc-btn" data-act="goto-export">先导出数据</button>
        </div>
      </section>

      <section class="gsc-section">
        <div class="gsc-section-head"><h2>1 · 重新验证身份</h2><p>必须通过 GitHub OAuth 再验证一次；票据 10 分钟有效。</p></div>
        <div class="gsc-reauth ${reauthReady ? "is-ok" : ""}">
          <b>${reauthReady ? "已完成重新验证" : "尚未重新验证"}</b>
          <p>${reauthReady ? "现在可以执行注销；如果超过 10 分钟，服务端会拒绝并提示重新验证。" : "点击按钮跳转 GitHub，授权后返回此页面。"}</p>
          <button type="button" class="gsc-btn" data-act="reauth">${reauthReady ? "重新验证" : "通过 GitHub 验证"}</button>
        </div>
      </section>

      <section class="gsc-section">
        <div class="gsc-section-head"><h2>2 · 明确确认</h2><p>需要输入确认短语，并确认历史备份也会被删除。</p></div>
        <div class="gsc-delete-card">
          <ul>
            <li>删除后无法登录，所有 Session 立即失效。</li>
            <li>云端文件与历史备份对象会从 R2 删除。</li>
            <li>设备、文件元数据、备份记录、隐私设置会从 D1 删除。</li>
            <li>只保留不含个人内容的最小化删除审计（哈希、时间、阶段）。</li>
            <li>即使关闭页面，后台 Cron 每 15 分钟会继续执行未完成的删除任务。</li>
          </ul>
          <button type="button" class="gsc-btn is-danger" data-act="delete-account">永久注销账号</button>
        </div>
      </section>`;
  };

  const render = (): void => {
    const item = NAV.find((entry) => entry.id === view) ?? NAV[0];
    title.textContent = item.label;
    root.querySelectorAll<HTMLElement>("[data-view]").forEach((node) => {
      node.classList.toggle("is-active", node.dataset.view === view);
    });

    if (loading && !overview) {
      body.innerHTML = '<div class="gsc-loading"><span></span><p>正在读取安全状态…</p></div>';
      sub.textContent = "正在读取安全状态…";
      return;
    }
    if (signedOut) {
      body.innerHTML = `<div class="gsc-empty"><span>⚠</span><p>登录已失效或账号已删除。</p><i>请重新登录后继续。</i><button type="button" class="gsc-btn is-primary" data-act="login">重新登录</button></div>`;
      sub.textContent = "需要重新登录";
      return;
    }
    if (error && !overview) {
      body.innerHTML = `<div class="gsc-empty"><span>⚠</span><p>${escapeHtml(error)}</p><button type="button" class="gsc-btn" data-act="refresh">重试</button></div>`;
      sub.textContent = error;
      return;
    }
    if (!overview) return;

    sideName.textContent = overview.account.displayName;
    sideSub.textContent = overview.account.githubUsername ? `@${overview.account.githubUsername}` : "Guandao Account";
    checkedChip.textContent = `CHECKED ${fmtRel(overview.checkedAt)}`;

    sub.textContent = {
      overview: `${overview.checks.filter((c) => c.status === "protected").length} / ${overview.checks.length} 项通过 · 已检查 ${fmtRel(overview.checkedAt)}`,
      account: "身份、OAuth 与登录安全",
      access: `${devices.filter((d) => d.status !== "revoked").length} 台设备 · ${sessions.filter((s) => s.status === "active").length} 个有效 Session`,
      privacy: "云端上传控制与数据位置",
      data: `文件 ${overview.inventory.files.total} · 备份 ${overview.inventory.backups.total}`,
      export: `${exports.length} 个导出记录`,
      activity: `${eventsTotal} 条安全事件`,
      delete: "不可撤销 · 需要重新验证",
    }[view];

    if (view === "overview") body.innerHTML = renderOverview();
    else if (view === "account") body.innerHTML = renderAccount();
    else if (view === "access") body.innerHTML = renderAccess();
    else if (view === "privacy") body.innerHTML = renderPrivacy();
    else if (view === "data") body.innerHTML = renderData();
    else if (view === "export") body.innerHTML = renderExport();
    else if (view === "activity") body.innerHTML = renderActivity();
    else body.innerHTML = renderDelete();
  };

  /* ------------------------------ 操作 ------------------------------ */

  const revokeOthers = async (): Promise<void> => {
    const result = await dialog({
      title: "退出其他设备",
      body: `<p class="gsc-modal-note">保留当前 Session，撤销其他所有登录。</p><p class="gsc-modal-sub">被撤销的设备下一次请求会收到 401；不会删除任何数据。</p>`,
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
  };

  const revokeAll = async (): Promise<void> => {
    const result = await dialog({
      title: "退出所有设备",
      body: `<p class="gsc-modal-note">撤销全部 Session，包括当前设备。需要输入 REVOKE ALL。</p>
        <label class="gsc-field"><span>确认短语</span><input data-confirm-text placeholder="REVOKE ALL" autocomplete="off" /></label>`,
      actions: [
        { label: "取消", value: "cancel" },
        { label: "全部退出", value: "confirm", tone: "danger" },
      ],
      requireText: "REVOKE ALL",
    });
    if (!result || result.action !== "confirm") return;
    await guard(async () => {
      await revokeAllSessions(false);
      signedOut = true;
      render();
      window.dispatchEvent(new Event("guandao:device-session-lost"));
    });
  };

  const logoutCurrent = async (): Promise<void> => {
    const result = await dialog({
      title: "退出当前设备",
      body: `<p class="gsc-modal-note">只结束这台设备的登录，其他设备不受影响。</p>`,
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
      if (!response.ok) throw new Error("退出失败");
      signedOut = true;
      render();
      window.dispatchEvent(new Event("guandao:signed-out"));
    });
  };

  const doExport = async (includeFiles: boolean): Promise<void> => {
    await guard(async () => {
      progress("准备导出", 5, "采集本地快照…");
      const created = await createExport(includeFiles, buildLocalSnapshot());
      const finished = await runExportUntilDone(created.export.id, (job, data) => {
        progress("复制导出数据", Math.max(8, job?.progress ?? 10), `${job?.processed ?? 0} / ${job?.total ?? created.totals.files} 个文件`);
      });
      if (finished.export.status !== "completed") throw new Error("导出未完成");
      toast("导出完成，可在历史导出中下载");
      exports = (await listExports()).exports;
      await load(true);
      view = "export";
      render();
    });
  };

  const deleteFiles = async (targets: Array<"files" | "backups">): Promise<void> => {
    const label = targets.includes("files") ? "所有云端文件" : "所有历史备份";
    const result = await dialog({
      title: `删除${label}`,
      body: `<p class="gsc-modal-note">这会永久删除${label}。R2 删除失败会保留待清理状态并可重试。</p>
        <ul class="gsc-warnings">
          <li>${targets.includes("files") ? "文件元数据与 R2 对象都会删除。" : "备份对象从 R2 删除，实时文件不变。"}</li>
          <li>${targets.includes("files") ? "历史备份中的副本不受影响。" : "删除后无法从这些恢复点恢复。"}</li>
          <li>操作不可撤销。</li>
        </ul>
        <label class="gsc-field"><span>输入 DELETE 确认</span><input data-confirm-text placeholder="DELETE" autocomplete="off" /></label>`,
      actions: [
        { label: "取消", value: "cancel" },
        { label: "确认删除", value: "confirm", tone: "danger" },
      ],
      requireText: "DELETE",
    });
    if (!result || result.action !== "confirm") return;

    await guard(async () => {
      progress("删除云端数据", 5, "正在删除 R2 对象与 D1 记录…");
      const started = await deleteCloudData(targets);
      await runDeletionUntilDone(started.job.id, (job) => {
        progress("删除云端数据", job.progress || 10, `${job.stage} · ${job.processed} 项`);
      });
      toast("删除完成");
      await load(true);
    });
  };

  const clearLocal = async (): Promise<void> => {
    const local = localDataSummary();
    const result = await dialog({
      title: "清除本地数据",
      body: `<p class="gsc-modal-note">将清除当前浏览器的 Guandao OS 数据：Notes ${local.notes} 条、Tasks ${local.tasks} 条、Calendar ${local.calendar} 条、配置 ${local.desktopKeys + local.workspaceKeys} 项，以及 IndexedDB。</p>
        <ul class="gsc-warnings">
          <li>这些本地数据没有云同步，清除后无法从服务器恢复。</li>
          <li>云端文件、备份、账号与 Session 不受影响。</li>
          <li>页面会重新加载。</li>
        </ul>
        <label class="gsc-field"><span>输入 CLEAR 确认</span><input data-confirm-text placeholder="CLEAR" autocomplete="off" /></label>`,
      actions: [
        { label: "取消", value: "cancel" },
        { label: "清除本地数据", value: "confirm", tone: "danger" },
      ],
      requireText: "CLEAR",
    });
    if (!result || result.action !== "confirm") return;

    await guard(async () => {
      progress("清除本地数据", 40, "正在删除 localStorage 与 IndexedDB…");
      const cleared = await clearLocalData();
      progress("完成", 100, `${cleared.clearedKeys} 个键已清除`);
      toast("本地数据已清除，正在重新加载");
      window.setTimeout(() => location.reload(), 600);
    });
  };

  const deleteAccountFlow = async (): Promise<void> => {
    const result = await dialog({
      title: "永久注销账号",
      body: `<p class="gsc-modal-note">账号、设备、Session、云端文件、历史备份与个人内容都会被删除。此操作不可撤销。</p>
        <label class="gsc-check"><input type="checkbox" data-check="backups" /> 我确认历史备份也会被删除</label>
        <label class="gsc-field"><span>输入 DELETE MY ACCOUNT</span><input data-confirm-text placeholder="DELETE MY ACCOUNT" autocomplete="off" /></label>`,
      actions: [
        { label: "取消", value: "cancel" },
        { label: "永久注销", value: "confirm", tone: "danger" },
      ],
      requireText: "DELETE MY ACCOUNT",
    });
    if (!result || result.action !== "confirm") return;
    if (!result.checks.backups) {
      toast("请先确认历史备份也会被删除");
      return;
    }

    await guard(async () => {
      progress("注销账号", 5, "正在重新校验身份…");
      const started = await deleteAccount();
      if (started.accountDeleted) {
        await finishDeletion();
        return;
      }
      if (!started.job) throw new Error("注销任务创建失败");
      progress("注销账号", 15, "撤销与清理进行中…");
      const final = await continueAccountDeletion(started.job.id, (job) => {
        progress("注销账号", Math.max(15, job.progress), `${job.stage} · ${job.processed} 项`);
      });
      if (!final.deleted) throw new Error("注销未完成，请重试");
      await finishDeletion();
    });
  };

  const finishDeletion = async (): Promise<void> => {
    progress("账号已删除", 100, "正在清除当前设备的账号缓存…");
    try {
      await clearLocalData();
    } catch {
      /* ignore */
    }
    signedOut = true;
    safeRender();
    window.setTimeout(() => {
      window.dispatchEvent(new Event("guandao:signed-out"));
      location.reload();
    }, 800);
    toast("账号已删除");
  };

  const safeRender = () => {
    try {
      render();
    } catch {
      /* 账号删除后 overview 可能为空 */
    }
  };

  /* ------------------------------ 事件 ------------------------------ */

  root.addEventListener("click", async (event) => {
    const target = event.target as HTMLElement;
    const nav = target.closest<HTMLElement>("[data-view]");
    if (nav?.dataset.view) {
      view = nav.dataset.view as ViewId;
      if (view === "activity") void loadEvents();
      render();
      return;
    }

    const node = target.closest<HTMLElement>("[data-act]");
    if (!node?.dataset.act) return;
    const action = node.dataset.act;
    const id = node.dataset.id;

    if (action === "refresh") return load();
    if (action === "goto-export") {
      view = "export";
      render();
      return;
    }
    if (action === "goto-access") {
      view = "access";
      render();
      return;
    }
    if (action === "goto-activity") {
      view = "activity";
      render();
      void loadEvents();
      return;
    }
    if (action === "login") {
      window.dispatchEvent(new Event("guandao:open-login"));
      return;
    }
    if (action === "revoke-others") return revokeOthers();
    if (action === "revoke-all") return revokeAll();
    if (action === "logout-current") return logoutCurrent();
    if (action === "reauth") return startReauth();

    if (action === "revoke-session" && id) {
      const session = sessions.find((item) => item.id === id);
      const result = await dialog({
        title: "撤销这个 Session",
        body: `<p class="gsc-modal-note">只撤销这一次登录，不影响设备记录或数据。</p><p class="gsc-modal-sub">创建 ${fmtAbs(session?.createdAt)} · 最近使用 ${fmtRel(session?.lastUsedAt)}</p>`,
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
      });
      return;
    }

    if (action === "revoke-device" && id) {
      const device = devices.find((item) => item.id === id);
      const result = await dialog({
        title: `撤销「${device?.name || "设备"}」`,
        body: `<p class="gsc-modal-note">撤销该设备的全部有效 Session。</p><ul class="gsc-warnings"><li>设备下一次请求会收到 401。</li><li>不会删除笔记、任务、日历或文件。</li></ul>`,
        actions: [
          { label: "取消", value: "cancel" },
          { label: "确认撤销", value: "confirm", tone: "danger" },
        ],
      });
      if (!result || result.action !== "confirm") return;
      await guard(async () => {
        await revokeDevice(id);
        toast("设备已撤销");
        await load(true);
      });
      return;
    }

    if (action === "trust-device" && id) {
      await guard(async () => {
        await trustDevice(id);
        toast("已确认设备");
        await load(true);
      });
      return;
    }

    if (action === "rename-device" && id) {
      const device = devices.find((item) => item.id === id);
      const result = await dialog({
        title: "重命名设备",
        body: `<label class="gsc-field"><span>设备名称</span><input data-field="name" data-confirm-text value="${escapeHtml(device?.name || "")}" maxlength="64" /></label>`,
        actions: [
          { label: "取消", value: "cancel" },
          { label: "保存", value: "confirm", tone: "primary" },
        ],
      });
      if (!result || result.action !== "confirm") return;
      const name = (result.values.name || "").trim();
      if (!name) return;
      await guard(async () => {
        await renameDevice(id, { name });
        toast("设备已重命名");
        await load(true);
      });
      return;
    }

    if (action === "create-export-full") return doExport(true);
    if (action === "create-export-meta") return doExport(false);
    if (action === "download-export-json" && id) {
      window.open(exportDownloadUrl(id, "json"), "_blank");
      return;
    }
    if (action === "download-export-zip" && id) {
      window.open(exportDownloadUrl(id, "zip"), "_blank");
      return;
    }

    if (action === "delete-files") return deleteFiles(["files"]);
    if (action === "delete-backups") return deleteFiles(["backups"]);
    if (action === "clear-local") return clearLocal();
    if (action === "delete-account") return deleteAccountFlow();
  });

  root.addEventListener("change", async (event) => {
    const target = event.target as HTMLElement;

    if (target.matches("[data-setting]")) {
      const input = target as HTMLInputElement;
      const key = input.dataset.setting as keyof PrivacySettings;
      await guard(async () => {
        const result = await saveSettings({ [key]: input.checked });
        if (overview) overview.settings = result.settings;
        toast("隐私设置已保存");
        render();
      });
      return;
    }

    if (target.matches("[data-event-type]")) {
      eventType = (target as HTMLSelectElement).value;
      await loadEvents();
      return;
    }
    if (target.matches("[data-event-days]")) {
      eventDays = (target as HTMLSelectElement).value;
      await loadEvents();
    }
  });

  if (reauthReady) {
    history.replaceState({}, "", location.pathname + location.hash);
    window.setTimeout(() => toast("GitHub 重新验证完成，10 分钟内可注销账号"), 600);
  }

  void load();

  return () => {
    /* 无持久定时器 */
  };
};
