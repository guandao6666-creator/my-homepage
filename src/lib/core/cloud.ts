/**
 * Guandao OS 2.0 · 云端服务管理器
 *
 * 2.0 把「登录 / 离线 / 云端不可用」收成一个明确的状态，供内核、系统中心、
 * 诊断中心共同读取：
 *
 *   Local Mode  —— 没有账号也能完整使用本地桌面，绝不因为未登录而阻塞启动；
 *   Cloud Mode  —— 登录后启用同步、云盘、备份、设备与社区；
 *   离线         —— 保留待同步队列，不清本地数据，界面显示离线状态。
 *
 * 所有探测都是**真的发起请求并计时**：拿不到就返回 down / unknown，
 * 不会把「没探测」写成「正常」（§16 明确禁止）。
 *
 * 不依赖 DOM（fetch 与计时器都是标准 API），可单测。
 */

import type { CoreMode, HealthReport, HealthState } from "./types";

export type CloudUser = {
  id: string;
  githubUsername: string;
  displayName: string;
  avatarUrl?: string;
  role?: string;
};

export type CloudSnapshot = {
  mode: CoreMode;
  online: boolean;
  authenticated: boolean;
  user: CloudUser | null;
  sessionExpiresAt: number | null;
  providerConfigured: boolean | null;
  health: HealthReport | null;
  lastCheckAt: number | null;
  offlineSince: number | null;
};

export type CloudServiceOptions = {
  /** 模式来源（System Center 设置） */
  mode: () => CoreMode;
  /** 网络状态来源，默认读 navigator.onLine */
  online?: () => boolean;
  /** 统一的 fetch 实现，便于测试注入 */
  fetch?: typeof fetch;
  /** 每次状态变化回调 */
  onChange?: (snapshot: CloudSnapshot) => void;
  emit?: (type: string, payload?: unknown) => void;
  /** 队伍 / 会话接口前缀，默认空（同源 /api） */
  basePath?: string;
};

const DEFAULT_TIMEOUT = 6000;

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`${label} 超时（${timeoutMs}ms）`));
    }, timeoutMs);
    const maybeUnref = timer as unknown as { unref?: () => void };
    if (typeof maybeUnref.unref === "function") maybeUnref.unref();
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

const browserOnline = (): boolean => {
  try {
    if (typeof navigator !== "undefined" && typeof navigator.onLine === "boolean") return navigator.onLine;
  } catch {
    /* 忽略 */
  }
  return true;
};

export class CloudServiceManager {
  private options: Required<Omit<CloudServiceOptions, "onChange" | "emit" | "online">> &
    Pick<CloudServiceOptions, "onChange" | "emit"> & { online: () => boolean };
  private snapshot: CloudSnapshot;
  private listeners = new Set<(snapshot: CloudSnapshot) => void>();
  private pending = 0;
  private networkBound = false;

  constructor(options: CloudServiceOptions) {
    this.options = {
      mode: options.mode,
      online: options.online ?? browserOnline,
      fetch: options.fetch ?? ((...args) => fetch(...args)),
      onChange: options.onChange,
      emit: options.emit,
      basePath: options.basePath ?? "",
    };
    this.snapshot = {
      mode: options.mode(),
      online: this.options.online(),
      authenticated: false,
      user: null,
      sessionExpiresAt: null,
      providerConfigured: null,
      health: null,
      lastCheckAt: null,
      offlineSince: this.options.online() ? null : Date.now(),
    };
  }

  /** 挂上网络事件（仅浏览器），并立刻做一次真实探测 */
  initialize(): void {
    if (typeof window !== "undefined" && !this.networkBound) {
      this.networkBound = true;
      window.addEventListener("online", this.handleOnline);
      window.addEventListener("offline", this.handleOffline);
    }
    this.snapshot.online = this.options.online();
  }

  async start(): Promise<void> {
    await this.refresh({ deep: false });
  }

  /** 完整刷新：健康探测 + 会话检查；两步各自独立失败 */
  async refresh(options: { deep?: boolean } = {}): Promise<CloudSnapshot> {
    this.snapshot.mode = this.options.mode();
    this.snapshot.online = this.options.online();
    this.snapshot.health = await this.probeHealth();
    if (this.snapshot.mode === "cloud" || options.deep) {
      await this.probeSession();
    } else {
      this.snapshot.authenticated = false;
      this.snapshot.user = null;
      this.snapshot.sessionExpiresAt = null;
    }
    this.snapshot.lastCheckAt = Date.now();
    this.touch();
    return this.state();
  }

  /** GET /api/health —— 真实计时；失败按状态分类，不冒充正常 */
  async probeHealth(timeoutMs = DEFAULT_TIMEOUT): Promise<HealthReport> {
    const started = Date.now();
    try {
      const response = await withTimeout(
        this.options.fetch(`${this.options.basePath}/api/health`, {
          method: "GET",
          headers: { accept: "application/json" },
          credentials: "same-origin",
        }),
        timeoutMs,
        "云端健康检查",
      );
      const latency = Date.now() - started;
      const payload = (await response.json().catch(() => null)) as
        | { status?: string; checks?: Record<string, { status?: string; detail?: string }> }
        | null;

      if (!response.ok) {
        return {
          id: "api",
          label: "云端 API",
          state: "down",
          latencyMs: latency,
          detail: `HTTP ${response.status}`,
          at: Date.now(),
        };
      }

      const checks = payload?.checks ?? {};
      const degraded = Object.entries(checks)
        .filter(([, value]) => value?.status && value.status !== "ok" && value.status !== "configured")
        .map(([key, value]) => `${key}=${value.status}`);

      return {
        id: "api",
        label: "云端 API",
        state: degraded.length ? "degraded" : "ok",
        latencyMs: latency,
        detail: degraded.length ? `部分依赖异常：${degraded.join("，")}` : "全部依赖正常",
        at: Date.now(),
      };
    } catch (error) {
      return {
        id: "api",
        label: "云端 API",
        state: this.snapshot.online ? "down" : "unknown",
        latencyMs: null,
        detail: this.snapshot.online
          ? `无法连接：${(error as Error)?.message ?? "未知错误"}`
          : "当前设备离线，未发起探测",
        at: Date.now(),
      };
    }
  }

  /** GET /api/auth/me —— 只判断会话，不把 401 当成云端故障 */
  async probeSession(timeoutMs = DEFAULT_TIMEOUT): Promise<void> {
    try {
      const response = await withTimeout(
        this.options.fetch(`${this.options.basePath}/api/auth/me`, {
          method: "GET",
          headers: { accept: "application/json" },
          credentials: "same-origin",
        }),
        timeoutMs,
        "会话检查",
      );
      if (response.status === 401 || response.status === 403) {
        this.setAuthenticated(false, null, null);
        return;
      }
      const payload = (await response.json().catch(() => null)) as
        | {
            authenticated?: boolean;
            user?: { id: string; githubUsername?: string; displayName?: string; avatarUrl?: string; role?: string };
            session?: { expiresAt?: number };
          }
        | null;

      if (payload?.authenticated && payload.user) {
        this.setAuthenticated(
          true,
          {
            id: String(payload.user.id),
            githubUsername: String(payload.user.githubUsername ?? ""),
            displayName: String(payload.user.displayName ?? payload.user.githubUsername ?? "已登录"),
            ...(payload.user.avatarUrl ? { avatarUrl: payload.user.avatarUrl } : {}),
            ...(payload.user.role ? { role: payload.user.role } : {}),
          },
          Number(payload.session?.expiresAt) || null,
        );
      } else {
        this.setAuthenticated(false, null, null);
      }
    } catch {
      // 网络失败时保留原状态，标记为「未知」由调用方决定怎么展示
      this.snapshot.providerConfigured = null;
      this.touch();
    }
  }

  /** 切换模式：只改模式，不碰本地数据（切换安全的保证在 Kernel 层） */
  setMode(mode: CoreMode): CloudSnapshot {
    if (mode === this.snapshot.mode) return this.state();
    this.snapshot.mode = mode;
    if (mode === "local") {
      // Local Mode 不展示云端身份，但不删除任何本地数据
      this.snapshot.authenticated = false;
      this.snapshot.user = null;
      this.snapshot.sessionExpiresAt = null;
    }
    this.emitFn("cloud:mode", { mode });
    this.touch();
    return this.state();
  }

  /** 待同步数量由同步引擎汇报 */
  reportPending(count: number): void {
    this.pending = Math.max(0, Math.floor(count));
    this.emitFn("cloud:pending", { count: this.pending });
  }

  pendingCount(): number {
    return this.pending;
  }

  state(): CloudSnapshot {
    return { ...this.snapshot, health: this.snapshot.health ? { ...this.snapshot.health } : null };
  }

  /** 状态摘要，供设置面板 / 诊断中心一行显示 */
  summary(): { label: string; tone: "ok" | "warn" | "danger" | "mute"; detail: string } {
    const snapshot = this.snapshot;
    if (snapshot.mode === "local") {
      return {
        label: "Local Mode",
        tone: "mute",
        detail: "未登录也能完整使用本地桌面；不会自动上传任何数据",
      };
    }
    if (!snapshot.online) {
      return {
        label: "离线",
        tone: "warn",
        detail: snapshot.offlineSince
          ? `离线 ${Math.max(1, Math.round((Date.now() - snapshot.offlineSince) / 60000))} 分钟，操作会排在待同步队列里`
          : "当前离线，操作会排在待同步队列里",
      };
    }
    if (!snapshot.authenticated) {
      return { label: "Cloud Mode · 未登录", tone: "warn", detail: "登录后启用同步、云盘、备份与设备管理" };
    }
    const health = snapshot.health?.state ?? "unknown";
    if (health === "down") return { label: "已登录 · 云端异常", tone: "danger", detail: "会话有效，但 API 暂时不可用" };
    if (health === "degraded") return { label: "已登录 · 部分降级", tone: "warn", detail: "部分云端依赖异常" };
    return {
      label: "Cloud Mode · 已连接",
      tone: "ok",
      detail: `账号 ${snapshot.user?.displayName ?? snapshot.user?.githubUsername ?? "已登录"}`,
    };
  }

  subscribe(listener: (snapshot: CloudSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    if (typeof window !== "undefined" && this.networkBound) {
      window.removeEventListener("online", this.handleOnline);
      window.removeEventListener("offline", this.handleOffline);
      this.networkBound = false;
    }
    this.listeners.clear();
  }

  /* ---------------- 内部 ---------------- */

  private handleOnline = () => {
    this.snapshot.online = true;
    this.snapshot.offlineSince = null;
    this.emitFn("cloud:online", {});
    void this.refresh();
  };

  private handleOffline = () => {
    this.snapshot.online = false;
    this.snapshot.offlineSince = Date.now();
    this.emitFn("cloud:offline", {});
    this.touch();
  };

  private setAuthenticated(authenticated: boolean, user: CloudUser | null, expiresAt: number | null): void {
    this.snapshot.authenticated = authenticated;
    this.snapshot.user = user;
    this.snapshot.sessionExpiresAt = expiresAt;
    this.emitFn(authenticated ? "cloud:authenticated" : "cloud:anonymous", {
      ...(user ? { user: user.displayName } : {}),
    });
    this.touch();
  }

  private touch(): void {
    const snapshot = this.state();
    try {
      this.options.onChange?.(snapshot);
    } catch {
      /* 忽略 */
    }
    for (const listener of [...this.listeners]) {
      try {
        listener(snapshot);
      } catch {
        /* 单个订阅者失败不影响其他 */
      }
    }
  }

  private emitFn(type: string, payload?: unknown): void {
    try {
      this.options.emit?.(type, payload);
    } catch {
      /* 忽略 */
    }
  }
}

export const createCloudService = (options: CloudServiceOptions) => new CloudServiceManager(options);