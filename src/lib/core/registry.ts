/**
 * Guandao OS 2.0 · 应用注册中心（App Registry）
 *
 * 2.0 之前，「安装了什么」由 `os14/catalog.ts` 的 localStorage 决定，
 * 「是不是在运行」只能靠数窗口 DOM 猜。于是 UI 可以自己编造状态
 * （例如把按钮写成「运行中」但根本没有窗口）。
 *
 * AppRegistry 把状态收成唯一来源：
 *
 *   registered → installed → enabled → running ⇄ minimized / suspended
 *                                     ↘ disabled
 *   任何阶段异常 → failed（带错误信息与时间，便于诊断）
 *
 * 状态只能通过这里的方法迁移，且每次迁移都会派发事件。
 * 这个模块不依赖 DOM，可单测。
 */

import type { AppManifest } from "./manifest";
import { validateAppManifest } from "./manifest";
import type { AppSource, AppState, TrustLevel } from "./types";
import type { StorageManager } from "./storage";

export type AppRecord = {
  manifest: AppManifest;
  source: AppSource;
  trust: TrustLevel;
  state: AppState;
  /** 系统应用：不允许普通用户卸载 */
  locked: boolean;
  registeredAt: number;
  installedAt: number | null;
  updatedAt: number;
  lastOpenedAt: number | null;
  openCount: number;
  /** failed 状态的原因 */
  error: string | null;
};

export type RegisterOptions = {
  source?: AppSource;
  trust?: TrustLevel;
  locked?: boolean;
  /** 已通过校验的 Manifest 可以直接传入，避免重复校验 */
  validated?: boolean;
  /** 同 id 覆盖（系统应用版本升级时用） */
  replace?: boolean;
  osVersion?: string;
};

export type RegisterResult = {
  ok: boolean;
  record: AppRecord | null;
  errors: string[];
  warnings: string[];
};

export type RegistryOptions = {
  storage: StorageManager;
  emit?: (type: string, payload?: unknown) => void;
  /** 事件里用的系统版本 */
  osVersion?: string;
  /** 依赖某个应用时的判断入口（默认查本注册表） */
  hasApp?: (appId: string) => boolean;
};

const KEY = "apps.v2";

type Persisted = {
  v: 2;
  records: Record<string, AppRecord>;
  updatedAt: number;
};

/** 允许的状态迁移；不在表里的跳转直接拒绝，避免 UI 随手改状态 */
const TRANSITIONS: Record<AppState, AppState[]> = {
  registered: ["installed", "failed"],
  installed: ["enabled", "registered", "failed"],
  enabled: ["running", "disabled", "installed", "failed"],
  running: ["minimized", "suspended", "enabled", "failed"],
  minimized: ["running", "enabled", "suspended", "failed"],
  suspended: ["running", "enabled", "failed"],
  disabled: ["enabled", "registered", "failed"],
  failed: ["installed", "enabled", "running", "registered"],
};

export class AppRegistry {
  private records = new Map<string, AppRecord>();
  private storage: StorageManager;
  private emitFn: (type: string, payload?: unknown) => void;
  private osVersion: string;
  private hasAppFn: (appId: string) => boolean;

  constructor(options: RegistryOptions) {
    this.storage = options.storage;
    this.emitFn = options.emit ?? (() => undefined);
    this.osVersion = options.osVersion ?? "2.0.0";
    this.hasAppFn = options.hasApp ?? ((appId) => this.records.has(appId));

    const stored = this.storage.read<Persisted | null>(KEY, null);
    if (stored && stored.records && typeof stored.records === "object") {
      for (const [id, record] of Object.entries(stored.records)) {
        if (!record?.manifest?.appId) continue;
        this.records.set(id, { ...record, error: record.error ?? null });
      }
    }
  }

  /* ---------------- 注册 / 校验 ---------------- */

  register(raw: unknown, options: RegisterOptions = {}): RegisterResult {
    const validation = validateAppManifest(raw, {
      osVersion: options.osVersion ?? this.osVersion,
      allowReservedIds: (options.source ?? "market") === "system",
    });

    if (!validation.ok || !validation.manifest) {
      return {
        ok: false,
        record: null,
        errors: validation.errors.map((issue) => `${issue.path}：${issue.message}`),
        warnings: validation.warnings.map((issue) => issue.message),
      };
    }

    const manifest = validation.manifest;
    const existing = this.records.get(manifest.appId);
    if (existing && !options.replace) {
      return {
        ok: false,
        record: existing,
        errors: [`应用 ${manifest.appId} 已经注册过了`],
        warnings: [],
      };
    }

    const source = options.source ?? manifest.source ?? "market";
    const trust = options.trust ?? manifest.trust ?? (source === "system" ? "trusted" : "unverified");
    if (trust === "blocked") {
      return { ok: false, record: null, errors: ["该来源已被安全下架"], warnings: [] };
    }

    const at = Date.now();
    const record: AppRecord = {
      manifest,
      source,
      trust,
      // 系统应用注册即视为已安装；第三方应用注册后还要走 install()
      state: source === "system" ? "installed" : "registered",
      locked: options.locked ?? source === "system",
      registeredAt: existing?.registeredAt ?? at,
      installedAt: source === "system" ? (existing?.installedAt ?? at) : (existing?.installedAt ?? null),
      updatedAt: at,
      lastOpenedAt: existing?.lastOpenedAt ?? null,
      openCount: existing?.openCount ?? 0,
      error: null,
    };

    this.records.set(manifest.appId, record);
    this.persist();
    this.emitFn("app:registered", { appId: manifest.appId, source, trust });

    return {
      ok: true,
      record: { ...record },
      errors: [],
      warnings: validation.warnings.map((issue) => issue.message),
    };
  }

  /* ---------------- 状态迁移 ---------------- */

  install(appId: string): boolean {
    return this.transition(appId, "installed", (record) => {
      record.installedAt = Date.now();
    });
  }

  enable(appId: string): boolean {
    return this.transition(appId, "enabled");
  }

  disable(appId: string): boolean {
    return this.transition(appId, "disabled");
  }

  /** 应用真正打开了窗口 */
  markRunning(appId: string): boolean {
    return this.transition(appId, "running", (record) => {
      record.lastOpenedAt = Date.now();
      record.openCount += 1;
      record.error = null;
    });
  }

  markMinimized(appId: string): boolean {
    return this.transition(appId, "minimized");
  }

  markSuspended(appId: string): boolean {
    return this.transition(appId, "suspended");
  }

  /** 关闭窗口：回到 enabled（仍在运行环境中，只是没有窗口） */
  markClosed(appId: string): boolean {
    const record = this.records.get(appId);
    if (!record) return false;
    if (record.state === "running" || record.state === "minimized" || record.state === "suspended") {
      return this.transition(appId, "enabled");
    }
    return false;
  }

  markFailed(appId: string, error: string): boolean {
    const record = this.records.get(appId);
    if (!record) return false;
    record.state = "failed";
    record.error = error.slice(0, 300);
    record.updatedAt = Date.now();
    this.persist();
    this.emitFn("app:failed", { appId, error: record.error });
    return true;
  }

  /**
   * 更新版本号：只有 registry 里的 manifest 版本变化才算更新成功。
   * 失败（版本倒退 / manifest 不合法）会返回 false，不会写坏状态。
   */
  update(appId: string, next: unknown): RegisterResult {
    const record = this.records.get(appId);
    if (!record) return { ok: false, record: null, errors: ["应用未注册"], warnings: [] };
    const result = this.register(next, {
      source: record.source,
      trust: record.trust,
      locked: record.locked,
      replace: true,
    });
    if (!result.ok || !result.record) return result;

    const merged: AppRecord = {
      ...result.record,
      state: record.state === "registered" ? "installed" : record.state,
      installedAt: record.installedAt,
      openCount: record.openCount,
      lastOpenedAt: record.lastOpenedAt,
    };
    this.records.set(appId, merged);
    this.persist();
    this.emitFn("app:updated", { appId, version: merged.manifest.version });
    return { ...result, record: { ...merged } };
  }

  /**
   * 卸载。系统应用 / 锁定应用拒绝卸载（「系统应用不能被普通用户误删」）。
   * 数据是否清理不在这里决定，由调用方（数据中心）负责。
   */
  uninstall(appId: string): { ok: boolean; error?: string } {
    const record = this.records.get(appId);
    if (!record) return { ok: false, error: "应用未注册" };
    if (record.locked || record.source === "system") {
      return { ok: false, error: "系统应用不能卸载" };
    }
    record.state = "registered";
    record.installedAt = null;
    record.updatedAt = Date.now();
    this.persist();
    this.emitFn("app:uninstalled", { appId });
    return { ok: true };
  }

  /* ---------------- 查询 ---------------- */

  get(appId: string): AppRecord | null {
    const record = this.records.get(appId);
    return record ? { ...record, manifest: { ...record.manifest } } : null;
  }

  has(appId: string): boolean {
    return this.records.has(appId);
  }

  stateOf(appId: string): AppState | null {
    return this.records.get(appId)?.state ?? null;
  }

  isInstalled(appId: string): boolean {
    const state = this.stateOf(appId);
    return Boolean(state && state !== "registered" && state !== "failed");
  }

  isEnabled(appId: string): boolean {
    const state = this.stateOf(appId);
    return state === "enabled" || state === "running" || state === "minimized" || state === "suspended";
  }

  list(): AppRecord[] {
    return [...this.records.values()]
      .map((record) => ({ ...record, manifest: { ...record.manifest } }))
      .sort((a, b) => a.manifest.name.localeCompare(b.manifest.name, "zh"));
  }

  bySource(source: AppSource): AppRecord[] {
    return this.list().filter((record) => record.source === source);
  }

  /** 依赖检查：返回缺失的必选依赖 */
  missingDependencies(appId: string): string[] {
    const record = this.records.get(appId);
    if (!record) return [];
    return record.manifest.dependencies
      .filter((dep) => !dep.optional && !this.hasAppFn(dep.appId))
      .map((dep) => dep.appId);
  }

  /** 状态统计（诊断中心 / 系统中心用） */
  stats(): Record<AppState, number> {
    const out: Record<AppState, number> = {
      registered: 0,
      installed: 0,
      enabled: 0,
      running: 0,
      minimized: 0,
      suspended: 0,
      disabled: 0,
      failed: 0,
    };
    for (const record of this.records.values()) out[record.state] += 1;
    return out;
  }

  /* ---------------- 内部 ---------------- */

  private transition(appId: string, next: AppState, extra?: (record: AppRecord) => void): boolean {
    const record = this.records.get(appId);
    if (!record) return false;
    if (record.state === next) return true;
    if (!TRANSITIONS[record.state].includes(next)) {
      this.emitFn("app:transition-rejected", { appId, from: record.state, to: next });
      return false;
    }
    const from = record.state;
    record.state = next;
    record.updatedAt = Date.now();
    extra?.(record);
    this.persist();
    this.emitFn("app:state", { appId, from, to: next });
    return true;
  }

  private persist(): void {
    const payload: Persisted = {
      v: 2,
      records: Object.fromEntries(this.records),
      updatedAt: Date.now(),
    };
    this.storage.write(KEY, payload);
  }
}

export const createAppRegistry = (options: RegistryOptions) => new AppRegistry(options);