/**
 * Guandao Account 客户端。
 *
 * 只负责界面与同源 fetch；所有权限判断在服务端。
 * Session Token 在 HttpOnly Cookie 里，这个模块接触不到。
 */

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
  session?: AccountSession;
}

interface AuthStatus {
  configured: boolean;
  initialized: boolean;
  setupAvailable: boolean;
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
  const root = el<HTMLDivElement>("gauth");
  const center = el<HTMLDivElement>("gacct");
  const menu = el<HTMLDivElement>("mb-account-menu");
  const menuButton = el<HTMLButtonElement>("mb-account");

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
      refs.centerRole.textContent = user ? (user.role === "admin" ? "管理员" : "成员") : "—";
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
  }

  async function refresh(): Promise<void> {
    try {
      const [meData, statusData] = await Promise.all([
        request<MeResponse>("/api/auth/me"),
        request<StatusEnvelope>("/api/auth/status"),
      ]);
      me = meData;
      status = statusData.data;
    } catch (error) {
      console.error("[Guandao Account] 读取状态失败", error);
      me = { authenticated: false, user: null };
      status = { configured: false, initialized: false, setupAvailable: false };
    }
    render();
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
    if (event.target === center) closeCenter();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (!center.hidden) closeCenter();
    else if (!root.hidden) closeLogin();
    else if (!menu.hidden) closeMenu();
  });

  /* ------------------------------ 启动 ------------------------------ */

  void (async () => {
    await refresh();

    const params = new URLSearchParams(location.search);
    const authResult = params.get("auth");
    const authError = params.get("auth_error");
    const setupMode = params.get("setup") === "1";
    const accountMode = params.get("account") === "1";

    if (authResult === "ok") {
      openCenter();
      toast("登录成功");
    } else if (authError) {
      openLogin(ERROR_MESSAGES[authError] || "登录失败，请重试。");
    } else if (setupMode) {
      openLogin();
      if (refs.setup) refs.setup.hidden = false;
      refs.setupToken?.focus();
    } else if (accountMode) {
      if (me.authenticated) openCenter();
      else openLogin();
    }

    if (authResult || authError || setupMode || accountMode) {
      history.replaceState({}, "", location.pathname + location.hash);
    }
  })();
}
