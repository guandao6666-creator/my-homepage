/**
 * Guandao Account 客户端。
 *
 * 只负责界面与同源 fetch；所有权限判断在服务端。
 * Session Token 在 HttpOnly Cookie 里，这个模块接触不到。
 */

import {
  SESSION_LOST_EVENT,
  listDevices,
  revokeDevice,
  startDevicePresence,
  stopDevicePresence,
  trustDevice,
  type DeviceAlert,
} from "../devices/client";

interface AccountUser {
  id: string;
  githubUsername: string;
  displayName: string;
  avatarUrl: string | null;
  role: "admin" | "member";
  createdAt: number;
  lastLoginAt: number | null;
}

interface AccountSession {
  expiresAt: number;
  createdAt: number;
  deviceId: string | null;
}

interface MeResponse {
  authenticated: boolean;
  user: AccountUser | null;
  reason?: "missing" | "revoked" | "expired" | "device_revoked" | "disabled";
  session?: AccountSession;
}

interface AuthStatus {
  configured: boolean;
  initialized: boolean;
  setupAvailable: boolean;
  community?: {
    mode: "closed" | "invite" | "open";
    memberLogin: boolean;
    joinAvailable: boolean;
    invitationRequired: boolean;
  };
}

interface StatusEnvelope {
  success: boolean;
  data: AuthStatus;
}

const ERROR_MESSAGES: Record<string, string> = {
  access_denied: "你取消了 GitHub 授权。",
  not_configured: "GitHub 登录尚未配置，请先在 Cloudflare 设置 GITHUB_CLIENT_ID 与 GITHUB_CLIENT_SECRET。",
  setup_disabled: "首次初始化尚未开启，缺少 INITIAL_ADMIN_SETUP_TOKEN。",
  invalid_state: "登录状态已失效，请重新发起登录。",
  oauth_failed: "GitHub 授权失败，请稍后重试。",
  profile_failed: "读取 GitHub 资料失败，请稍后重试。",
  not_allowed: "该 GitHub 账号没有登录权限。",
  server_error: "服务暂时不可用，请稍后重试。",
  not_member: "这个 GitHub 账号还不是社区成员。请使用邀请码加入社区，或联系管理员。",
  registration_closed: "社区当前未开放注册，请联系管理员获取邀请。",
  invalid_invite: "邀请码无效、已过期或名额已用完。",
  member_login_disabled: "社区成员登录已由管理员暂停。",
  account_disabled: "这个账号已被停用，请联系社区管理员。",
  pending_deletion: "这个账号正在注销流程中，暂时无法登录。",
  not_initialized: "Guandao 管理员尚未初始化，社区暂不可用。",
};

class ApiError extends Error {
  code: string;

  constructor(message: string, code = "UNKNOWN") {
    super(message);
    this.name = "ApiError";
    this.code = code;
  }
}

function el<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function safeAvatar(url: string | null): string | null {
  if (!url) return null;
  return /^https:\/\/avatars\.githubusercontent\.com\//.test(url) ? url : null;
}

function formatTime(ms: number | null | undefined): string {
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
}

function escapeText(value: string): string {
  return String(value).replace(/[&<>"']/g, (char) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char,
  );
}

function formatRelative(ms: number): string {
  const delta = Date.now() - ms;
  if (delta < 60_000) return "刚刚";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
  return `${Math.floor(delta / 86_400_000)} 天前`;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  if (init.body) headers.set("content-type", "application/json");

  const response = await fetch(path, {
    ...init,
    headers,
    credentials: "same-origin",
  });

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    const message = payload?.error?.message || `请求失败（${response.status}）`;
    throw new ApiError(message, payload?.error?.code || "UNKNOWN");
  }

  return payload as T;
}

export function initAccount(): void {
  const root = el<HTMLDivElement>("gauth")!;
  const center = el<HTMLDivElement>("gacct")!;
  const menu = el<HTMLDivElement>("mb-account-menu")!;
  const menuButton = el<HTMLButtonElement>("mb-account")!;

  if (!root || !center || !menu || !menuButton) return;

  const refs = {
    closeLogin: el<HTMLButtonElement>("gauth-close"),
    github: el<HTMLButtonElement>("gauth-github"),
    githubLabel: el<HTMLSpanElement>("gauth-github-label"),
    status: el<HTMLParagraphElement>("gauth-status"),
    error: el<HTMLParagraphElement>("gauth-error"),
    setup: el<HTMLDivElement>("gauth-setup"),
    setupForm: el<HTMLFormElement>("gauth-setup-form"),
    setupToken: el<HTMLInputElement>("gauth-setup-token"),
    setupSubmit: el<HTMLButtonElement>("gauth-setup-submit"),
    local: el<HTMLButtonElement>("gauth-local"),

    joinBlock: el<HTMLDivElement>("gauth-community"),
    joinBadge: el<HTMLElement>("gauth-community-badge"),
    joinDesc: el<HTMLParagraphElement>("gauth-community-desc"),
    invite: el<HTMLInputElement>("gauth-invite"),
    joinBtn: el<HTMLButtonElement>("gauth-join"),

    avatarImg: el<HTMLImageElement>("mb-account-img"),
    avatarGlyph: el<HTMLSpanElement>("mb-account-glyph"),
    accountDot: el<HTMLSpanElement>("mb-account-dot"),

    menuAvatarImg: el<HTMLImageElement>("mbam-avatar-img"),
    menuAvatarGlyph: el<HTMLSpanElement>("mbam-avatar-glyph"),
    menuName: el<HTMLElement>("mbam-name"),
    menuSub: el<HTMLElement>("mbam-sub"),
    menuAuth: el<HTMLButtonElement>("mbam-auth"),

    centerClose: el<HTMLButtonElement>("gacct-close"),
    centerAvatarImg: el<HTMLImageElement>("gacct-avatar-img"),
    centerAvatarGlyph: el<HTMLSpanElement>("gacct-avatar-glyph"),
    centerHandle: el<HTMLElement>("gacct-handle"),
    centerBadge: el<HTMLElement>("gacct-badge"),
    centerId: el<HTMLElement>("gacct-id"),
    centerUsername: el<HTMLElement>("gacct-username"),
    centerRole: el<HTMLElement>("gacct-role"),
    centerCreated: el<HTMLElement>("gacct-created"),
    centerLast: el<HTMLElement>("gacct-last"),
    centerSession: el<HTMLElement>("gacct-session"),
    nameForm: el<HTMLFormElement>("gacct-name-form"),
    nameInput: el<HTMLInputElement>("gacct-name"),
    nameSave: el<HTMLButtonElement>("gacct-name-save"),
    nameMsg: el<HTMLParagraphElement>("gacct-name-msg"),
    logout: el<HTMLButtonElement>("gacct-logout"),
  };

  let me: MeResponse = { authenticated: false, user: null };
  let status: AuthStatus = { configured: false, initialized: false, setupAvailable: false };
  let communityRole = "";
  let lastFocus: HTMLElement | null = null;

  function showError(message: string | null): void {
    if (!refs.error) return;
    refs.error.textContent = message || "";
    refs.error.hidden = !message;
  }

  function setStatus(message: string | null, busy = false): void {
    if (!refs.status) return;
    refs.status.textContent = message || "";
    refs.status.classList.toggle("is-busy", busy);
  }

  function toast(message: string): void {
    const node = document.createElement("div");
    node.className = "acc-toast";
    node.textContent = message;
    document.body.appendChild(node);
    window.setTimeout(() => node.classList.add("is-out"), 2200);
    window.setTimeout(() => node.remove(), 2600);
  }

  /* ---------------------- 新设备安全提示 ---------------------- */

  let alertNode: HTMLElement | null = null;

  const alertDismissKey = (id: string) => `guandao.device.alert.${id}`;

  function wasDismissed(id: string): boolean {
    try {
      return sessionStorage.getItem(alertDismissKey(id)) === "1";
    } catch {
      return false;
    }
  }

  function dismissAlert(id: string): void {
    try {
      sessionStorage.setItem(alertDismissKey(id), "1");
    } catch {
      /* 隐私模式下忽略 */
    }
  }

  function removeAlert(): void {
    alertNode?.remove();
    alertNode = null;
  }

  function openDevices(): void {
    const gos = (window as unknown as { GOS14?: { openDevices?: () => void } }).GOS14;
    if (gos?.openDevices) gos.openDevices();
    else location.assign("/?account=1");
  }

  function openCommunity(): void {
    const gos = (window as unknown as { GOS14?: { openCommunity?: () => void } }).GOS14;
    if (gos?.openCommunity) gos.openCommunity();
    else location.assign("/?account=1");
  }

  function openBackup(): void {
    const gos = (window as unknown as { GOS14?: { openBackup?: () => void } }).GOS14;
    if (gos?.openBackup) gos.openBackup();
    else location.assign("/?account=1");
  }

  function openSecurity(): void {
    const gos = (window as unknown as { GOS14?: { openSecurity?: () => void } }).GOS14;
    if (gos?.openSecurity) gos.openSecurity();
    else location.assign("/?account=1");
  }

  function showDeviceAlert(alert: DeviceAlert, total: number): void {
    removeAlert();
    const node = document.createElement("div");
    node.className = "gdv-alert-banner";
    node.setAttribute("role", "status");
    node.innerHTML = `
      <div class="gdv-alert-banner-main">
        <span class="gdv-alert-banner-dot" aria-hidden="true"></span>
        <div>
          <b>New Device Signed In</b>
          <p>${escapeText(alert.os)} · ${escapeText(alert.browser)} 在 ${formatRelative(alert.createdAt)}登录了一台新设备${total > 1 ? `（共 ${total} 台待确认）` : ""}。</p>
        </div>
      </div>
      <div class="gdv-alert-banner-actions">
        <button type="button" data-device-alert="trust">这是我的设备</button>
        <button type="button" data-device-alert="revoke">不是我的设备</button>
        <button type="button" data-device-alert="open">查看设备</button>
        <button type="button" class="is-close" data-device-alert="dismiss" aria-label="稍后处理">×</button>
      </div>`;
    document.body.appendChild(node);
    alertNode = node;

    node.addEventListener("click", (event) => {
      const target = (event.target as HTMLElement).closest<HTMLElement>("[data-device-alert]");
      if (!target) return;
      const action = target.dataset.deviceAlert;
      if (action === "dismiss") {
        dismissAlert(alert.deviceId);
        removeAlert();
        return;
      }
      if (action === "open") {
        openDevices();
        return;
      }
      if (action === "trust") {
        void trustDevice(alert.deviceId)
          .then(() => {
            toast("已确认这是你的设备");
            removeAlert();
          })
          .catch(() => toast("操作失败，请到设备管理中心重试"));
        return;
      }
      if (action === "revoke") {
        void revokeDevice(alert.deviceId)
          .then(() => {
            toast("已撤销该设备的登录权限");
            removeAlert();
          })
          .catch(() => toast("操作失败，请到设备管理中心重试"));
      }
    });
  }

  async function refreshDeviceAlerts(): Promise<void> {
    if (!me.authenticated) {
      removeAlert();
      return;
    }
    try {
      const data = await listDevices();
      const pending = data.alerts.filter((alert) => !wasDismissed(alert.deviceId));
      if (!pending.length) {
        removeAlert();
        return;
      }
      showDeviceAlert(pending[0], pending.length);
    } catch {
      /* 设备提示失败不影响账号界面 */
    }
  }

  function render(): void {
    const user = me.authenticated ? me.user : null;
    const avatar = safeAvatar(user?.avatarUrl ?? null);
    const glyph = (user?.displayName || user?.githubUsername || "管").slice(0, 1);

    if (refs.avatarImg) {
      refs.avatarImg.hidden = !avatar;
      if (avatar) refs.avatarImg.src = avatar;
    }
    if (refs.avatarGlyph) {
      refs.avatarGlyph.hidden = Boolean(avatar);
      refs.avatarGlyph.textContent = glyph;
    }
    if (refs.accountDot) refs.accountDot.hidden = !user;

    if (refs.menuAvatarImg) {
      refs.menuAvatarImg.hidden = !avatar;
      if (avatar) refs.menuAvatarImg.src = avatar;
    }
    if (refs.menuAvatarGlyph) {
      refs.menuAvatarGlyph.hidden = Boolean(avatar);
      refs.menuAvatarGlyph.textContent = glyph;
    }
    if (refs.menuName) refs.menuName.textContent = user?.displayName || "本地模式";
    if (refs.menuSub) {
      refs.menuSub.textContent = user ? `@${user.githubUsername}` : "未登录";
    }
    if (refs.menuAuth) {
      refs.menuAuth.textContent = user ? "退出登录" : "使用 GitHub 登录";
    }

    if (refs.centerAvatarImg) {
      refs.centerAvatarImg.hidden = !avatar;
      if (avatar) refs.centerAvatarImg.src = avatar;
    }
    if (refs.centerAvatarGlyph) {
      refs.centerAvatarGlyph.hidden = Boolean(avatar);
      refs.centerAvatarGlyph.textContent = glyph;
    }
    if (refs.centerHandle) {
      refs.centerHandle.textContent = user
        ? `@${user.githubUsername} · ${user.displayName}`
        : "本地模式 · 未登录";
    }
    if (refs.centerBadge) {
      refs.centerBadge.textContent = user ? user.role.toUpperCase() : "LOCAL";
    }
    if (refs.centerId) refs.centerId.textContent = user?.id || "—";
    if (refs.centerUsername) refs.centerUsername.textContent = user ? `@${user.githubUsername}` : "—";
    if (refs.centerRole) {
      const label =
        communityRole === "admin" || user?.role === "admin"
          ? "管理员"
          : communityRole === "moderator"
            ? "社区审核员"
            : "社区成员";
      refs.centerRole.textContent = user ? label : "—";
    }
    if (refs.centerCreated) refs.centerCreated.textContent = formatTime(user?.createdAt);
    if (refs.centerLast) refs.centerLast.textContent = formatTime(user?.lastLoginAt);
    if (refs.centerSession) {
      refs.centerSession.textContent = user && me.session
        ? `有效 · ${formatTime(me.session.expiresAt)}`
        : "—";
    }
    if (refs.nameInput) refs.nameInput.value = user?.displayName || "";
    if (refs.logout) refs.logout.disabled = !user;

    if (refs.github) refs.github.disabled = false;
    if (refs.githubLabel) {
      refs.githubLabel.textContent = status.configured
        ? "Continue with GitHub"
        : "GitHub 登录未配置";
    }

    const community = status.community;
    const modeLabel =
      community?.mode === "invite" ? "邀请制" : community?.mode === "open" ? "开放注册" : "未开放";
    if (refs.joinBlock) {
      refs.joinBlock.hidden = Boolean(user) || !status.initialized || community?.mode === "closed";
    }
    if (refs.joinBadge) refs.joinBadge.textContent = modeLabel;
    if (refs.joinDesc) {
      refs.joinDesc.textContent = !status.initialized
        ? "Guandao 管理员初始化后，社区注册会自动开放。"
        : community?.mode === "invite"
          ? "社区采用邀请制。输入管理员给你的邀请码，通过 GitHub 身份加入。"
          : community?.mode === "open"
            ? "社区当前开放注册。使用 GitHub 公开身份即可加入。"
            : "社区当前未开放注册，请联系管理员。";
    }
    if (refs.invite) {
      refs.invite.hidden = !community?.invitationRequired;
      refs.invite.value = "";
    }
    if (refs.joinBtn) {
      refs.joinBtn.disabled = !community?.joinAvailable;
      refs.joinBtn.textContent = status.initialized ? "加入 Guandao Community" : "等待管理员初始化";
    }
  }

  async function refresh(): Promise<void> {
    try {
      const [meData, statusData] = await Promise.all([
        request<MeResponse>("/api/auth/me"),
        request<StatusEnvelope>("/api/auth/status"),
      ]);
      me = meData;
      status = statusData.data;
      const communityMeta = await request<{ success: boolean; data: { viewer: { role?: string } | null } }>(
        "/api/community/meta",
      ).catch(() => null);
      communityRole = communityMeta?.data?.viewer?.role || (meData.user?.role === "admin" ? "admin" : "");
    } catch (error) {
      console.error("[Guandao Account] 读取状态失败", error);
      me = { authenticated: false, user: null };
      status = { configured: false, initialized: false, setupAvailable: false };
      communityRole = "";
    }
    render();

    if (me.authenticated) {
      startDevicePresence();
      void refreshDeviceAlerts();
    } else {
      stopDevicePresence();
      removeAlert();
    }
  }

  function openLogin(message?: string): void {
    lastFocus = document.activeElement as HTMLElement | null;
    root.hidden = false;
    closeMenu();
    if (refs.setup) refs.setup.hidden = true;
    showError(message || null);
    setStatus(
      status.configured
        ? status.initialized
          ? "使用 GitHub 授权后即可进入。"
          : "首次使用：登录后将进入管理员初始化。"
        : "管理员尚未配置 GitHub OAuth。",
    );
    window.setTimeout(() => refs.github?.focus(), 40);
  }

  function closeLogin(): void {
    root.hidden = true;
    showError(null);
    setStatus(null);
    if (refs.setup) refs.setup.hidden = true;
    lastFocus?.focus?.();
  }

  function openCenter(): void {
    if (!me.authenticated) {
      openLogin("请先登录，再查看账号中心。");
      return;
    }
    lastFocus = document.activeElement as HTMLElement | null;
    center.hidden = false;
    closeMenu();
    if (refs.nameMsg) {
      refs.nameMsg.textContent = "";
      refs.nameMsg.classList.remove("is-error");
    }
    window.setTimeout(() => refs.centerClose?.focus(), 40);
  }

  function closeCenter(): void {
    center.hidden = true;
    lastFocus?.focus?.();
  }

  function closeMenu(): void {
    menu.hidden = true;
    menuButton.setAttribute("aria-expanded", "false");
  }

  function toggleMenu(): void {
    const willOpen = menu.hidden;
    menu.hidden = !willOpen;
    menuButton.setAttribute("aria-expanded", String(willOpen));
  }

  async function logout(): Promise<void> {
    try {
      await request("/api/auth/logout", { method: "POST" });
      me = { authenticated: false, user: null };
      stopDevicePresence();
      removeAlert();
      render();
      closeCenter();
      closeMenu();
      toast("已退出登录，本地数据保持不变");
    } catch (error) {
      toast(error instanceof Error ? error.message : "退出失败");
    }
  }

  /* ------------------------------ 事件 ------------------------------ */

  menuButton.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleMenu();
  });

  menu.addEventListener("click", (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-account-action]");
    if (!target) return;
    const action = target.dataset.accountAction;
    if (action === "profile") {
      openCenter();
      window.setTimeout(() => refs.nameInput?.focus(), 140);
    }
    if (action === "center") openCenter();
    if (action === "devices") {
      closeMenu();
      openDevices();
    }
    if (action === "backup") {
      closeMenu();
      openBackup();
    }
    if (action === "security") {
      closeMenu();
      openSecurity();
    }
    if (action === "community") {
      closeMenu();
      openCommunity();
    }
    if (action === "auth") {
      if (me.authenticated) void logout();
      else openLogin();
    }
  });

  document.addEventListener("click", (event) => {
    if (menu.hidden) return;
    if (!menu.contains(event.target as Node) && event.target !== menuButton) closeMenu();
  });

  refs.closeLogin?.addEventListener("click", closeLogin);
  refs.local?.addEventListener("click", () => {
    closeLogin();
    toast("已进入本地模式");
  });
  refs.centerClose?.addEventListener("click", closeCenter);

  refs.github?.addEventListener("click", () => {
    if (!status.configured) {
      showError(ERROR_MESSAGES.not_configured);
      return;
    }
    showError(null);
    setStatus("正在跳转 GitHub…", true);
    if (refs.github) refs.github.disabled = true;
    location.assign("/api/auth/github");
  });

  refs.joinBtn?.addEventListener("click", () => {
    const community = status.community;
    if (!community?.joinAvailable) {
      showError(
        community?.mode === "closed"
          ? ERROR_MESSAGES.registration_closed
          : "社区注册暂不可用，请确认管理员已完成初始化。",
      );
      return;
    }
    if (!status.configured) {
      showError(ERROR_MESSAGES.not_configured);
      return;
    }
    let invite = "";
    if (community.invitationRequired) {
      invite = (refs.invite?.value || "").trim().toUpperCase();
      if (!/^GD-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(invite)) {
        showError("请输入完整的邀请码，例如 GD-ABCD-EFGH-JKLM。");
        refs.invite?.focus();
        return;
      }
    }
    showError(null);
    setStatus("正在前往 GitHub 验证身份…", true);
    if (refs.joinBtn) refs.joinBtn.disabled = true;
    const query = new URLSearchParams({ mode: "join" });
    if (invite) query.set("invite", invite);
    location.assign(`/api/auth/github?${query.toString()}`);
  });

  refs.setupForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const token = refs.setupToken?.value.trim() || "";
    if (!token) {
      showError("请输入初始化密钥。");
      return;
    }

    showError(null);
    setStatus("正在创建管理员…", true);
    if (refs.setupSubmit) refs.setupSubmit.disabled = true;

    try {
      await request("/api/auth/initialize", {
        method: "POST",
        body: JSON.stringify({ token }),
      });
      await refresh();
      closeLogin();
      openCenter();
      toast("管理员已创建");
    } catch (error) {
      showError(error instanceof Error ? error.message : "初始化失败");
    } finally {
      setStatus(null);
      if (refs.setupSubmit) refs.setupSubmit.disabled = false;
    }
  });

  refs.nameForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const displayName = refs.nameInput?.value.trim() || "";
    if (!displayName) {
      if (refs.nameMsg) {
        refs.nameMsg.textContent = "昵称不能为空。";
        refs.nameMsg.classList.add("is-error");
      }
      return;
    }

    if (refs.nameSave) refs.nameSave.disabled = true;
    if (refs.nameMsg) {
      refs.nameMsg.textContent = "正在保存…";
      refs.nameMsg.classList.remove("is-error");
    }

    try {
      const result = await request<{ data: { user: AccountUser } }>("/api/auth/profile", {
        method: "PATCH",
        body: JSON.stringify({ displayName }),
      });
      if (result?.data?.user) {
        me = { ...me, user: result.data.user };
        render();
      }
      if (refs.nameMsg) refs.nameMsg.textContent = "已保存到云端。";
      toast("昵称已更新");
    } catch (error) {
      if (refs.nameMsg) {
        refs.nameMsg.textContent = error instanceof Error ? error.message : "保存失败";
        refs.nameMsg.classList.add("is-error");
      }
    } finally {
      if (refs.nameSave) refs.nameSave.disabled = false;
    }
  });

  refs.logout?.addEventListener("click", () => void logout());

  root.addEventListener("click", (event) => {
    if (event.target === root) closeLogin();
  });
  center.addEventListener("click", (event) => {
    const devices = (event.target as HTMLElement).closest<HTMLElement>('[data-account-action="devices"]');
    if (devices) {
      closeCenter();
      openDevices();
      return;
    }
    const backup = (event.target as HTMLElement).closest<HTMLElement>('[data-account-action="backup"]');
    if (backup) {
      closeCenter();
      openBackup();
      return;
    }
    const security = (event.target as HTMLElement).closest<HTMLElement>('[data-account-action="security"]');
    if (security) {
      closeCenter();
      openSecurity();
      return;
    }
    const community = (event.target as HTMLElement).closest<HTMLElement>('[data-account-action="community"]');
    if (community) {
      closeCenter();
      openCommunity();
      return;
    }
    if (event.target === center) closeCenter();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (!center.hidden) closeCenter();
    else if (!root.hidden) closeLogin();
    else if (!menu.hidden) closeMenu();
  });

  /* ---------------------- 会话被远程撤销 ---------------------- */

  window.addEventListener(SESSION_LOST_EVENT, (event) => {
    const code = (event as CustomEvent<{ code?: string }>).detail?.code;
    me = { authenticated: false, user: null, reason: code === "DEVICE_REVOKED" ? "device_revoked" : "revoked" };
    stopDevicePresence();
    removeAlert();
    render();
    closeCenter();
    closeMenu();
    openLogin(
      code === "DEVICE_REVOKED"
        ? "这台设备的登录权限已被撤销，请重新登录。"
        : "账号可能已在其他设备退出登录，请重新登录。",
    );
  });

  window.addEventListener("guandao:open-login", () => {
    openLogin(me.authenticated ? undefined : "请先登录，再继续。");
  });

  window.addEventListener("guandao:open-community-join", () => {
    if (me.authenticated) {
      openCommunity();
      return;
    }
    openLogin();
    if (refs.joinBlock) refs.joinBlock.hidden = false;
    window.setTimeout(() => {
      if (status.community?.invitationRequired) refs.invite?.focus();
      else refs.joinBtn?.focus();
    }, 120);
  });

  window.addEventListener("guandao:signed-out", () => {
    me = { authenticated: false, user: null };
    stopDevicePresence();
    removeAlert();
    render();
    closeCenter();
    closeMenu();
    openLogin("已退出登录。");
  });

  /* ------------------------------ 启动 ------------------------------ */

  void (async () => {
    await refresh();

    const params = new URLSearchParams(location.search);
    const authResult = params.get("auth");
    const authError = params.get("auth_error");
    const setupMode = params.get("setup") === "1";
    const accountMode = params.get("account") === "1";
    const joinedMode = params.get("joined") === "1";
    const communityMode = params.get("community") === "1";

    if (joinedMode) {
      closeLogin();
      toast("欢迎加入 Guandao Community");
      openCommunity();
    } else if (authResult === "ok") {
      openCenter();
      toast("登录成功");
    } else if (authError) {
      openLogin(ERROR_MESSAGES[authError] || "登录失败，请重试。");
      if (authError === "not_member" && refs.joinBlock) {
        refs.joinBlock.hidden = false;
      }
    } else if (setupMode) {
      openLogin();
      if (refs.setup) refs.setup.hidden = false;
      refs.setupToken?.focus();
    } else if (accountMode) {
      if (me.authenticated) openCenter();
      else openLogin();
    } else if (communityMode) {
      if (me.authenticated) openCommunity();
      else openLogin();
    }

    if (authResult || authError || setupMode || accountMode || joinedMode || communityMode) {
      history.replaceState({}, "", location.pathname + location.hash);
    }

    // 注销重新验证返回：自动打开隐私与安全中心，让用户继续确认。
    if (params.get("delete_verified") === "1") {
      window.setTimeout(() => openSecurity(), 700);
    }
  })();
}
