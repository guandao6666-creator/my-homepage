/**
 * Guandao OS 2.0 · 统一权限服务
 *
 * 原则（§11）：
 *   1. 默认拒绝：没有明确授予的权限一律拒绝；
 *   2. 系统组件走 bypass，但每一次 bypass 也写审计日志；
 *   3. 第三方应用 / 插件只能拿到自己声明过、且用户明确授予的权限；
 *   4. UI 隐藏按钮不是安全控制，真正的判断在这里；
 *   5. 每次拒绝都留审计记录，安全中心可以导出。
 *
 * 1.x 里权限分散在 catalog 的展示型 permissions 与插件 manifest 里，
 * 前端只把它当文案用。2.0 的 PermissionManager 成为唯一判定点，
 * 插件宿主（plugins/host.ts）与系统应用都改为调用它。
 *
 * 不依赖 DOM，可单测。
 */

import type { PermissionDecision, PermissionRisk, Principal, PrincipalKind } from "./types";
import type { StorageManager } from "./storage";

export type PermissionDefinition = {
  id: string;
  label: string;
  desc: string;
  risk: PermissionRisk;
  /** 适用的主体；system 权限不会出现在应用权限清单里 */
  appliesTo: Array<Exclude<PrincipalKind, "system">>;
};

/**
 * 2.0 权限清单。`app` 与 `plugin` 前缀保持兼容 1.x 的插件权限 id，
 * 这样插件 manifest 不需要因为 2.0 而全部改写。
 */
export const CORE_PERMISSIONS: PermissionDefinition[] = [
  {
    id: "storage.read",
    label: "读取本地数据",
    desc: "读取本应用自己保存的键值数据（不能读取其他应用或系统数据）",
    risk: "low",
    appliesTo: ["app", "plugin"],
  },
  {
    id: "storage.write",
    label: "写入本地数据",
    desc: "在浏览器里保存本应用自己的配置与内容",
    risk: "low",
    appliesTo: ["app", "plugin"],
  },
  {
    id: "files.read",
    label: "读取文件",
    desc: "通过文件选择器读取你主动选中的文件",
    risk: "mid",
    appliesTo: ["app", "plugin"],
  },
  {
    id: "files.write",
    label: "导出 / 保存文件",
    desc: "把内容保存为本地文件（浏览器下载）",
    risk: "mid",
    appliesTo: ["app", "plugin"],
  },
  {
    id: "clipboard.read",
    label: "读取剪贴板",
    desc: "读取剪贴板内容，用于接力与复制功能",
    risk: "high",
    appliesTo: ["app", "plugin"],
  },
  {
    id: "clipboard.write",
    label: "写入剪贴板",
    desc: "把内容写入剪贴板",
    risk: "mid",
    appliesTo: ["app", "plugin"],
  },
  {
    id: "notifications.post",
    label: "发送通知",
    desc: "在通知中心写入条目（不会触发系统级推送）",
    risk: "low",
    appliesTo: ["app", "plugin"],
  },
  {
    id: "network.request",
    label: "网络请求",
    desc: "通过宿主代理访问允许的外部接口，插件不能直接联网",
    risk: "high",
    appliesTo: ["app", "plugin"],
  },
  {
    id: "window.control",
    label: "控制窗口",
    desc: "打开、关闭、聚焦自己的窗口；不能操作其他应用的窗口",
    risk: "low",
    appliesTo: ["app"],
  },
  {
    id: "desktop.modify",
    label: "修改桌面",
    desc: "添加组件、修改桌面布局与图标",
    risk: "mid",
    appliesTo: ["app", "plugin"],
  },
  {
    id: "theme.apply",
    label: "应用主题",
    desc: "切换系统主题与壁纸",
    risk: "low",
    appliesTo: ["app", "plugin"],
  },
  {
    id: "cloud.sync",
    label: "云同步",
    desc: "读写当前账号的云端数据（仅 Cloud Mode 且已登录时可用）",
    risk: "high",
    appliesTo: ["app", "plugin"],
  },
  {
    id: "account.read",
    label: "读取账号资料",
    desc: "读取当前登录账号的公开资料（昵称、头像）",
    risk: "mid",
    appliesTo: ["app", "plugin"],
  },
  {
    id: "plugin.manage",
    label: "管理插件",
    desc: "安装、启用、禁用其他插件",
    risk: "high",
    appliesTo: ["app"],
  },
];

export const PERMISSION_BY_ID: Record<string, PermissionDefinition> = Object.fromEntries(
  CORE_PERMISSIONS.map((permission) => [permission.id, permission]),
);

export class PermissionError extends Error {
  code = "PERMISSION_DENIED";
  permission: string;

  constructor(permission: string, principal: Principal) {
    const label = PERMISSION_BY_ID[permission]?.label ?? permission;
    super(`缺少权限：${label}`);
    this.name = "PermissionError";
    this.permission = permission;
    this.principalId = principal.id;
  }

  readonly principalId: string;
}

export type AuditEntry = {
  at: number;
  principal: Principal;
  permission: string;
  allowed: boolean;
  via: PermissionDecision["via"];
  reason?: string;
};

export type GrantRecord = {
  permission: string;
  at: number;
  by: "user" | "system" | "policy";
};

export type PrincipalGrants = {
  kind: Exclude<PrincipalKind, "system">;
  permissions: GrantRecord[];
  /** 主体声明过、但从未授予的权限：用于区分「没声明」与「没授权」 */
  declared: string[];
  blocked: boolean;
  updatedAt: number;
};

type State = {
  v: 2;
  grants: Record<string, PrincipalGrants>;
  audit: AuditEntry[];
};

const STATE_KEY = "permissions.v1";
const AUDIT_LIMIT = 200;

const emptyState = (): State => ({ v: 2, grants: {}, audit: [] });

const keyOf = (principal: Principal) => `${principal.kind}:${principal.id}`;

const nowMs = () => Date.now();

export type PermissionManagerOptions = {
  storage: StorageManager;
  /** 事件回调，Kernel 会接到总线 */
  emit?: (type: string, payload?: unknown) => void;
  /** 审计条目上限，默认 200 */
  auditLimit?: number;
};

export class PermissionManager {
  private state: State;
  private storage: StorageManager;
  private emitFn: (type: string, payload?: unknown) => void;
  private auditLimit: number;

  constructor(options: PermissionManagerOptions) {
    this.storage = options.storage;
    this.emitFn = options.emit ?? (() => undefined);
    this.auditLimit = Math.max(20, options.auditLimit ?? AUDIT_LIMIT);
    const stored = this.storage.read<State>(STATE_KEY, emptyState());
    this.state = {
      v: 2,
      grants: stored && typeof stored.grants === "object" && stored.grants ? stored.grants : {},
      audit: Array.isArray(stored?.audit) ? stored.audit.slice(-this.auditLimit) : [],
    };
  }

  /* ---------------- 声明 ---------------- */

  /**
   * 登记某个主体声明的权限。声明不等于授予：默认仍然是拒绝。
   * 应用注册、插件安装时调用。
   */
  declare(principal: Principal, permissions: string[]): void {
    if (principal.kind === "system") return;
    const record = this.ensure(principal);
    const next = [...new Set(permissions.filter((item) => typeof item === "string" && item))];
    const changed = next.length !== record.declared.length || next.some((item) => !record.declared.includes(item));
    record.declared = next;
    if (changed) this.persist();
  }

  declaredOf(principal: Principal): string[] {
    return [...(this.state.grants[keyOf(principal)]?.declared ?? [])];
  }

  /* ---------------- 授予 / 撤销 ---------------- */

  /** 授予权限；只保留声明过的（系统主体不受限） */
  grant(principal: Principal, permissions: string[], by: GrantRecord["by"] = "user"): string[] {
    if (principal.kind === "system") return [...permissions];
    const record = this.ensure(principal);
    const declared = new Set(record.declared);
    const granted: string[] = [];
    for (const permission of permissions) {
      if (!permission) continue;
      // 未声明的权限不能被授予，避免「偷偷提权」
      if (declared.size && !declared.has(permission)) continue;
      if (!record.permissions.some((item) => item.permission === permission)) {
        record.permissions.push({ permission, at: nowMs(), by });
      }
      granted.push(permission);
    }
    record.updatedAt = nowMs();
    this.persist();
    this.emitFn("permission:granted", { principal: keyOf(principal), permissions: granted });
    return granted;
  }

  revoke(principal: Principal, permissions: string[]): string[] {
    if (principal.kind === "system") return [];
    const record = this.state.grants[keyOf(principal)];
    if (!record) return [];
    const removed: string[] = [];
    for (const permission of permissions) {
      const index = record.permissions.findIndex((item) => item.permission === permission);
      if (index >= 0) {
        record.permissions.splice(index, 1);
        removed.push(permission);
      }
    }
    record.updatedAt = nowMs();
    this.persist();
    if (removed.length) this.emitFn("permission:revoked", { principal: keyOf(principal), permissions: removed });
    return removed;
  }

  /** 整体替换（用于权限面板保存） */
  setGrants(principal: Principal, permissions: string[]): string[] {
    if (principal.kind === "system") return [];
    const record = this.ensure(principal);
    const current = record.permissions.map((item) => item.permission);
    const toRevoke = current.filter((permission) => !permissions.includes(permission));
    if (toRevoke.length) this.revoke(principal, toRevoke);
    return this.grant(principal, permissions, "user");
  }

  grantsOf(principal: Principal): string[] {
    if (principal.kind === "system") return ["*"];
    return (this.state.grants[keyOf(principal)]?.permissions ?? []).map((item) => item.permission);
  }

  /** 安全下架 / 用户拉黑：立即拒绝该主体的一切调用 */
  block(principal: Principal, blocked: boolean): void {
    if (principal.kind === "system") return;
    const record = this.ensure(principal);
    record.blocked = blocked;
    record.updatedAt = nowMs();
    this.persist();
    this.emitFn("permission:blocked", { principal: keyOf(principal), blocked });
  }

  isBlocked(principal: Principal): boolean {
    if (principal.kind === "system") return false;
    return Boolean(this.state.grants[keyOf(principal)]?.blocked);
  }

  /* ---------------- 判定 ---------------- */

  /**
   * 唯一的权限判定入口。同步返回结果，调用方据此拒绝。
   * 该函数会写审计日志（内存 + 持久化，按上限裁剪）。
   */
  check(principal: Principal, permission: string, detail?: string): PermissionDecision {
    if (principal.kind === "system") {
      return this.record({
        allowed: true,
        permission,
        principal,
        via: "system-bypass",
        ...(detail ? { reason: detail } : {}),
      });
    }

    if (this.isBlocked(principal)) {
      return this.record({
        allowed: false,
        permission,
        principal,
        via: "blocked",
        reason: "该来源已被安全下架，所有调用被拒绝",
      });
    }

    const record = this.state.grants[keyOf(principal)];
    if (!record) {
      return this.record({
        allowed: false,
        permission,
        principal,
        via: "default-deny",
        reason: "从未授予该权限",
      });
    }

    if (record.declared.length && !record.declared.includes(permission)) {
      return this.record({
        allowed: false,
        permission,
        principal,
        via: "not-declared",
        reason: "该主体没有声明这个权限",
      });
    }

    if (!record.permissions.some((item) => item.permission === permission)) {
      return this.record({
        allowed: false,
        permission,
        principal,
        via: "default-deny",
        reason: "用户没有授予该权限",
      });
    }

    return this.record({ allowed: true, permission, principal, via: "granted" });
  }

  has(principal: Principal, permission: string): boolean {
    if (principal.kind === "system") return true;
    const record = this.state.grants[keyOf(principal)];
    if (!record || record.blocked) return false;
    return record.permissions.some((item) => item.permission === permission);
  }

  /** 断言版本：不允许时抛 PermissionError，供业务代码用 */
  assert(principal: Principal, permission: string): void {
    const decision = this.check(principal, permission);
    if (!decision.allowed) throw new PermissionError(permission, principal);
  }

  /* ---------------- 审计 ---------------- */

  audit(limit = 50): AuditEntry[] {
    return this.state.audit.slice(-Math.max(0, limit)).reverse();
  }

  auditStats(): { total: number; denied: number; since: number | null } {
    const denied = this.state.audit.filter((entry) => !entry.allowed).length;
    return {
      total: this.state.audit.length,
      denied,
      since: this.state.audit[0]?.at ?? null,
    };
  }

  exportAudit(): string {
    return JSON.stringify(
      {
        version: "guandao-os/2.0",
        at: new Date().toISOString(),
        permissions: CORE_PERMISSIONS.map((permission) => ({ id: permission.id, risk: permission.risk })),
        entries: this.audit(this.auditLimit),
      },
      null,
      2,
    );
  }

  clearAudit(): void {
    this.state.audit = [];
    this.persist();
  }

  /** 安全中心用：所有主体的授权概览 */
  overview(): Array<{ principal: string; kind: string; granted: number; declared: number; blocked: boolean }> {
    return Object.entries(this.state.grants).map(([key, value]) => ({
      principal: key,
      kind: value.kind,
      granted: value.permissions.length,
      declared: value.declared.length,
      blocked: value.blocked,
    }));
  }

  /** 危险操作：清掉某个主体的全部授权（卸载插件 / 应用时） */
  forget(principal: Principal): void {
    delete this.state.grants[keyOf(principal)];
    this.persist();
  }

  /* ---------------- 内部 ---------------- */

  private ensure(principal: Principal): PrincipalGrants {
    if (principal.kind === "system") {
      throw new Error("系统主体不需要授权记录");
    }
    const key = keyOf(principal);
    const existing = this.state.grants[key];
    if (existing) return existing;
    const created: PrincipalGrants = {
      kind: principal.kind,
      permissions: [],
      declared: [],
      blocked: false,
      updatedAt: nowMs(),
    };
    this.state.grants[key] = created;
    return created;
  }

  private record(decision: PermissionDecision): PermissionDecision {
    const entry: AuditEntry = {
      at: nowMs(),
      principal: decision.principal,
      permission: decision.permission,
      allowed: decision.allowed,
      via: decision.via,
      ...(decision.reason ? { reason: decision.reason } : {}),
    };
    this.state.audit.push(entry);
    if (this.state.audit.length > this.auditLimit) {
      this.state.audit.splice(0, this.state.audit.length - this.auditLimit);
    }
    // 拒绝立即落盘；允许每 20 条落一次，避免高频调用把 localStorage 写爆
    const denied = !decision.allowed;
    const shouldPersist = denied || this.state.audit.length % 20 === 0;
    if (shouldPersist) this.persist();
    if (denied) this.emitFn("permission:denied", { permission: decision.permission, principal: keyOf(decision.principal) });
    return decision;
  }

  private persist(): void {
    this.storage.write(STATE_KEY, this.state);
  }
}

export const createPermissions = (options: PermissionManagerOptions) => new PermissionManager(options);

/** 常见主体的构造器，避免各处手写对象 */
export const systemPrincipal = (id = "kernel"): Principal => ({ kind: "system", id, name: "系统" });
export const appPrincipal = (id: string, name?: string): Principal => ({ kind: "app", id, ...(name ? { name } : {}) });
export const pluginPrincipal = (id: string, name?: string): Principal => ({
  kind: "plugin",
  id,
  ...(name ? { name } : {}),
});