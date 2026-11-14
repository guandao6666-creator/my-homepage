/**
 * Guandao OS 2.0 · 应用运行时
 *
 * 把「注册中心的状态机」「权限判定」「窗口管理器」串成一条应用生命周期：
 *
 *   register → install → launch → activate / minimize / suspend → resume → close → uninstall
 *
 * 规则：
 *   - 只有 registry 里 isEnabled 的应用能被 launch；
 *   - 非系统应用的启动要过权限检查（默认拒绝，安装时按风险分级授予）；
 *   - 启动失败不会抛出到调用方：返回带原因的结果，并让 registry 进入 failed；
 *   - 窗口关闭事件回来时把状态从 running 收敛到 enabled。
 *
 * 本模块不操作 DOM，可单测（窗口能力由注入的 WindowManager 提供）。
 */

import type { WindowManager } from "./windows";
import type { AppRegistry } from "./registry";
import type { PermissionManager } from "./permissions";
import { appPrincipal } from "./permissions";
import type { AppSource } from "./types";

export type LaunchFailure =
  | "unknown-app"
  | "not-installed"
  | "disabled"
  | "blocked"
  | "permission-denied"
  | "failed"
  | "unavailable";

export type LaunchResult = {
  ok: boolean;
  appId: string;
  reason?: LaunchFailure;
  message?: string;
  /** 需要用户确认的新权限（首次启动高权限应用时返回） */
  missingPermissions?: string[];
};

export type AppRuntimeOptions = {
  registry: AppRegistry;
  permissions: PermissionManager;
  windows: WindowManager;
  emit?: (type: string, payload?: unknown) => void;
  /** 该应用是否由插件系统托管（插件应用的权限由插件注册中心负责） */
  isPluginApp?: (appId: string) => boolean;
  /** 启动时额外要求的最低权限（默认 window.control） */
  launchPermission?: string;
};

export class AppRuntime {
  private registry: AppRegistry;
  private permissions: PermissionManager;
  private windows: WindowManager;
  private emitFn: (type: string, payload?: unknown) => void;
  private isPluginApp: (appId: string) => boolean;
  private launchPermission: string;
  private launchedAt = new Map<string, number>();
  private offClosed: (() => void) | null = null;

  constructor(options: AppRuntimeOptions) {
    this.registry = options.registry;
    this.permissions = options.permissions;
    this.windows = options.windows;
    this.emitFn = options.emit ?? (() => undefined);
    this.isPluginApp = options.isPluginApp ?? (() => false);
    this.launchPermission = options.launchPermission ?? "window.control";

    // 窗口被用户关掉时，状态回到 enabled（而不是伪装成 running）
    this.offClosed = this.windows ? this.watchWindows() : null;
  }

  /** 注册：只登记 manifest，不安装 */
  register(manifest: unknown, options?: Parameters<AppRegistry["register"]>[1]) {
    const result = this.registry.register(manifest, options);
    if (result.ok && result.record) {
      this.permissions.declare(appPrincipal(result.record.manifest.appId, result.record.manifest.name), [
        ...result.record.manifest.permissions,
      ]);
    }
    return result;
  }

  install(appId: string): { ok: boolean; message?: string } {
    const record = this.registry.get(appId);
    if (!record) return { ok: false, message: "应用未注册" };
    const missing = this.registry.missingDependencies(appId);
    if (missing.length) return { ok: false, message: `缺少依赖：${missing.join("、")}` };
    if (!this.registry.install(appId)) return { ok: false, message: "应用状态不允许安装" };
    this.registry.enable(appId);
    this.emitFn("app:installed", { appId });
    return { ok: true };
  }

  /**
   * 启动应用。
   * 权限不足时返回 missingPermissions，由调用方弹出确认框，确认后再调用 grant()。
   */
  launch(appId: string): LaunchResult {
    const record = this.registry.get(appId);
    if (!record) return { ok: false, appId, reason: "unknown-app", message: "应用不存在" };

    const state = record.state;
    if (state === "registered") return { ok: false, appId, reason: "not-installed", message: "应用还没有安装" };
    if (state === "failed") {
      // failed 允许重试：先回到 enabled，再尝试一次
      this.registry.enable(appId);
    }
    if (!this.registry.isEnabled(appId) && this.registry.stateOf(appId) !== "running") {
      return { ok: false, appId, reason: "disabled", message: "应用已被禁用" };
    }
    if (record.trust === "blocked") return { ok: false, appId, reason: "blocked", message: "该应用已被安全下架" };

    if (record.source !== "system" && !this.isPluginApp(appId)) {
      const principal = appPrincipal(appId, record.manifest.name);
      const decision = this.permissions.check(principal, this.launchPermission);
      if (!decision.allowed) {
        return {
          ok: false,
          appId,
          reason: "permission-denied",
          message: decision.reason ?? "缺少启动权限",
          missingPermissions: [this.launchPermission],
        };
      }
    }

    const opened = this.windows.open(appId);
    if (!opened) {
      this.registry.markFailed(appId, "窗口管理器拒绝打开窗口");
      this.emitFn("app:launch-failed", { appId, reason: "unavailable" });
      return { ok: false, appId, reason: "failed", message: "窗口打开失败" };
    }

    this.registry.markRunning(appId);
    this.launchedAt.set(appId, Date.now());
    this.emitFn("app:launched", { appId, source: record.source, state: this.registry.stateOf(appId) });
    return { ok: true, appId };
  }

  /** 最小化 / 恢复 */
  minimize(appId: string): boolean {
    const ok = this.windows.minimize(appId);
    if (ok) this.registry.markMinimized(appId);
    return ok;
  }

  activate(appId: string): boolean {
    if (this.windows.isOpen(appId)) {
      const ok = this.windows.focus(appId);
      if (ok) this.registry.markRunning(appId);
      return ok;
    }
    return this.launch(appId).ok;
  }

  suspend(appId: string): boolean {
    const ok = this.windows.minimize(appId);
    if (!ok) return false;
    this.registry.markSuspended(appId);
    this.emitFn("app:suspended", { appId });
    return true;
  }

  resume(appId: string): boolean {
    const ok = this.windows.restore(appId);
    if (ok) this.registry.markRunning(appId);
    this.emitFn("app:resumed", { appId, ok });
    return ok;
  }

  close(appId: string): boolean {
    const ok = this.windows.close(appId);
    if (ok) {
      this.registry.markClosed(appId);
      this.launchedAt.delete(appId);
    }
    return ok;
  }

  /** 卸载：先关窗、撤销授权，再改状态。系统应用会被拒绝 */
  uninstall(appId: string): { ok: boolean; message?: string } {
    const record = this.registry.get(appId);
    if (!record) return { ok: false, message: "应用未注册" };
    if (record.source === "system" || record.locked) return { ok: false, message: "系统应用不能卸载" };
    if (this.windows.isOpen(appId)) this.close(appId);
    this.permissions.forget(appPrincipal(appId));
    const result = this.registry.uninstall(appId);
    if (result.ok) this.emitFn("app:uninstalled", { appId });
    return result;
  }

  /** 授权已声明、可授予的权限（安装 / 首启确认后调用） */
  grant(appId: string, permissions: string[], by: "user" | "system" = "user"): string[] {
    const record = this.registry.get(appId);
    if (!record) return [];
    return this.permissions.grant(appPrincipal(appId, record.manifest.name), permissions, by);
  }

  revoke(appId: string, permissions: string[]): string[] {
    const record = this.registry.get(appId);
    if (!record) return [];
    return this.permissions.revoke(appPrincipal(appId, record.manifest.name), permissions);
  }

  /** 累计启动次数（会话内） */
  stats(): { launched: number; failed: number; running: number; tracked: Array<{ appId: string; state: string }> } {
    const records = this.registry.list();
    return {
      launched: this.launchedAt.size,
      failed: records.filter((record) => record.state === "failed").length,
      running: records.filter((record) => record.state === "running").length,
      tracked: records
        .filter((record) => record.state === "running" || record.state === "minimized" || record.state === "suspended")
        .map((record) => ({ appId: record.manifest.appId, state: record.state })),
    };
  }

  /** 供安装流程判断来源风险 */
  sourceOf(appId: string): AppSource | null {
    return this.registry.get(appId)?.source ?? null;
  }

  dispose(): void {
    this.offClosed?.();
    this.offClosed = null;
  }

  /* ---------------- 内部 ---------------- */

  private watchWindows(): () => void {
    return this.windows.onClosed((appId) => {
      this.registry.markClosed(appId);
      this.launchedAt.delete(appId);
    });
  }
}

export const createAppRuntime = (options: AppRuntimeOptions) => new AppRuntime(options);