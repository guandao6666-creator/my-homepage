/**
 * Guandao OS 2.0 · 统一资源安装器
 *
 * 1.x 里有 5 条互不相通的安装链：应用中心、社区资源、插件市场、主题导入、壁纸引擎。
 * 2.0 不重写这些处理器（它们都已经验证过），而是在外面套一层统一流程（§7.2）：
 *
 *   获取信息 → 检查来源 → 检查版本 → 检查兼容性 → 检查 Manifest
 *   → 检查权限 → 展示详情 → 用户确认 → 下载 → 校验 → 安装 → 登记 → 返回真实结果
 *
 * 任何一种资源都走这里，只是「安装处理器」不同。
 * 流程失败会停在具体步骤并返回原因，绝不返回「安装成功」的假象。
 */

import type { AppManifest } from "../core/manifest";
import { compareVersions, validateAppManifest } from "../core/manifest";
import { CORE_PERMISSIONS } from "../core/permissions";
import type { Kernel } from "../core/kernel";
import type { Ctx } from "../os14/core";
import type { Sys } from "../os14/system";
import { OS_VERSION } from "../version";

export type ResourceKind = "app" | "plugin" | "theme" | "widget" | "wallpaper" | "workspace" | "community";

export type MarketItem = {
  id: string;
  kind: ResourceKind;
  name: string;
  version: string;
  author: string;
  description: string;
  /** glyph 类名或图片 URL */
  icon: string;
  preview?: string;
  tags: string[];
  source: "system" | "market" | "community";
  /** 声明的权限 id（应用用 2.0 权限，插件用插件权限） */
  permissions: string[];
  manifest?: AppManifest | Record<string, unknown>;
  installed: boolean;
  installable: boolean;
  sizeBytes?: number;
  updatedAt?: number;
  homepage?: string;
  extra?: Record<string, unknown>;
};

export type StepId =
  | "resolve"
  | "source"
  | "version"
  | "compat"
  | "manifest"
  | "permissions"
  | "confirm"
  | "download"
  | "verify"
  | "install"
  | "register"
  | "result";

export const STEP_LABEL: Record<StepId, string> = {
  resolve: "获取资源信息",
  source: "检查来源",
  version: "检查版本",
  compat: "检查兼容性",
  manifest: "检查 Manifest",
  permissions: "检查权限",
  confirm: "用户确认",
  download: "下载",
  verify: "校验",
  install: "安装",
  register: "登记资源",
  result: "返回结果",
};

export type StepStatus = "pending" | "running" | "ok" | "skipped" | "failed";

export type StepState = {
  id: StepId;
  label: string;
  status: StepStatus;
  detail?: string;
};

export type InstallConsent = {
  accepted: boolean;
  /** 用户勾选授予的权限 */
  permissions: string[];
};

export type InstallOutcome = {
  ok: boolean;
  steps: StepState[];
  message: string;
  /** 被拒绝的权限（需要用户确认时可以弹窗） */
  needsConsent?: string[];
  record?: unknown;
  installedId?: string;
};

export type ResourceHandler = {
  kind: ResourceKind;
  /** 下载阶段：返回任意 payload 交给 verify / install */
  download?: (item: MarketItem) => Promise<unknown>;
  /** 校验阶段：摘要、格式、结构 */
  verify?: (item: MarketItem, payload: unknown) => Promise<{ ok: boolean; message: string }> | { ok: boolean; message: string };
  /** 安装阶段：调用已验证的处理器 */
  install: (item: MarketItem, payload: unknown, consent: InstallConsent) => Promise<{ ok: boolean; message: string; record?: unknown; installedId?: string }>;
  /** 卸载（可选） */
  uninstall?: (item: MarketItem) => Promise<{ ok: boolean; message: string }>;
  /** 是否已安装（用于市场列表展示） */
  isInstalled?: (item: MarketItem) => boolean;
};

export type InstallerContext = {
  kernel: Kernel;
  ctx: Ctx;
  sys: Sys;
};

const LOW_RISK = new Set(
  CORE_PERMISSIONS.filter((permission) => permission.risk === "low").map((permission) => permission.id),
);

/** 插件权限的风险等级不在 2.0 权限表里，按「未知即高风险」处理 */
export const riskOf = (permission: string): "low" | "mid" | "high" => {
  const definition = CORE_PERMISSIONS.find((item) => item.id === permission);
  if (definition) return definition.risk;
  if (LOW_RISK.has(permission)) return "low";
  return "high";
};

export class UnifiedInstaller {
  private handlers = new Map<ResourceKind, ResourceHandler>();
  private context: InstallerContext;
  private emit: (type: string, payload?: unknown) => void;

  constructor(context: InstallerContext) {
    this.context = context;
    this.emit = (type, payload) => context.kernel.bus.emit(type, payload);
  }

  register(handler: ResourceHandler): void {
    if (this.handlers.has(handler.kind)) throw new Error(`资源类型 ${handler.kind} 已经有处理器`);
    this.handlers.set(handler.kind, handler);
  }

  handlerFor(kind: ResourceKind): ResourceHandler | null {
    return this.handlers.get(kind) ?? null;
  }

  /**
   * 预检：不发请求、不写任何东西，只判断能不能装。
   * 市场详情页用它提前展示「不兼容 / 缺权限 / 已安装」。
   */
  precheck(item: MarketItem): { ok: boolean; steps: StepState[]; needsConsent: string[]; message: string } {
    const steps: StepState[] = [];
    const push = (id: StepId, status: StepStatus, detail?: string) => {
      steps.push({ id, label: STEP_LABEL[id], status, ...(detail ? { detail } : {}) });
    };

    push("resolve", "ok", `${item.name} v${item.version}`);

    if (item.source === "system" || item.source === "market" || item.source === "community") {
      push("source", "ok", item.source === "community" ? "社区资源（人工审核）" : item.source === "market" ? "市场资源" : "系统内置");
    } else {
      push("source", "failed", "来源未知");
      return { ok: false, steps, needsConsent: [], message: "来源未知，已阻止安装" };
    }

    const versionOk = /^\d+\.\d+\.\d+/.test(item.version);
    push("version", versionOk ? "ok" : "failed", versionOk ? item.version : "版本号格式不合法");
    if (!versionOk) return { ok: false, steps, needsConsent: [], message: "版本号不合法" };

    const handler = this.handlers.get(item.kind);
    if (item.kind === "app") {
      const validation = validateAppManifest(item.manifest ?? {}, { osVersion: OS_VERSION, allowReservedIds: true });
      if (validation.ok && validation.manifest) {
        const compatible = compareVersions(OS_VERSION, validation.manifest.minimumOSVersion) >= 0;
        push("compat", compatible ? "ok" : "failed", `需要 ${validation.manifest.minimumOSVersion}，当前 ${OS_VERSION}`);
        push("manifest", "ok", "Schema 校验通过");
        if (!compatible) return { ok: false, steps, needsConsent: [], message: "系统版本过低，不能安装" };
      } else {
        push("compat", "ok");
        push(
          "manifest",
          "failed",
          validation.errors.map((issue) => `${issue.path}：${issue.message}`).join("；"),
        );
        return { ok: false, steps, needsConsent: [], message: "Manifest 校验失败" };
      }
    } else {
      push("compat", handler ? "ok" : "failed", handler ? `${item.kind} 处理器已注册` : "没有对应的安装处理器");
      push("manifest", "ok", "由该类型的处理器校验");
      if (!handler) return { ok: false, steps, needsConsent: [], message: "该类型资源暂不支持安装" };
    }

    const needsConsent = item.permissions.filter((permission) => riskOf(permission) !== "low");
    push(
      "permissions",
      needsConsent.length ? "skipped" : "ok",
      needsConsent.length ? `${needsConsent.length} 项权限需要确认` : "只需低风险权限",
    );

    return {
      ok: true,
      steps,
      needsConsent,
      message: needsConsent.length ? "需要用户确认权限" : "可以安装",
    };
  }

  /**
   * 执行安装。每一步都会先标记 running 再标记 ok/failed，
   * 失败即停，不会继续后面的下载 / 安装。
   */
  async install(
    item: MarketItem,
    consent: InstallConsent = { accepted: false, permissions: [] },
    onStep?: (steps: StepState[]) => void,
  ): Promise<InstallOutcome> {
    const steps: StepState[] = [];
    const notify = () => onStep?.(steps.map((step) => ({ ...step })));
    const start = (id: StepId): StepState => {
      const state: StepState = { id, label: STEP_LABEL[id], status: "running" };
      steps.push(state);
      notify();
      return state;
    };
    const finish = (state: StepState, status: StepStatus, detail?: string) => {
      state.status = status;
      if (detail) state.detail = detail;
      notify();
    };
    const abort = (state: StepState | null, message: string, extra: Partial<InstallOutcome> = {}): InstallOutcome => {
      if (state) finish(state, "failed", message);
      const result: InstallOutcome = { ok: false, steps, message, ...extra };
      this.emit("market:install-failed", { id: item.id, kind: item.kind, message });
      return result;
    };

    /* 1. 获取资源信息 */
    let step = start("resolve");
    if (!item.id || !item.name) return abort(step, "资源信息不完整");
    finish(step, "ok", `${item.name} v${item.version}`);

    /* 2. 检查来源 */
    step = start("source");
    if (item.source !== "system" && item.source !== "market" && item.source !== "community") {
      return abort(step, "来源未知");
    }
    finish(
      step,
      "ok",
      item.source === "community" ? "社区资源（人工审核通过）" : item.source === "market" ? "市场资源" : "系统内置",
    );

    /* 3. 检查版本 */
    step = start("version");
    if (!/^\d+\.\d+\.\d+/.test(item.version)) return abort(step, "版本号格式不合法");
    if (item.installed && item.kind === "app") {
      finish(step, "ok", `已安装 ${item.version}，将走更新流程`);
    } else {
      finish(step, "ok", item.version);
    }

    /* 4. 检查兼容性 */
    step = start("compat");
    if (item.kind === "app") {
      const manifest = item.manifest as AppManifest | undefined;
      const minimum = manifest?.minimumOSVersion ?? "1.0.0";
      if (compareVersions(OS_VERSION, minimum) < 0) {
        return abort(step, `需要 Guandao OS ${minimum}，当前 ${OS_VERSION}`);
      }
      finish(step, "ok", `最低版本 ${minimum}`);
    } else {
      const handler = this.handlers.get(item.kind);
      if (!handler) return abort(step, "没有对应的安装处理器");
      finish(step, "ok", `${item.kind} 处理器就绪`);
    }

    /* 5. 检查 Manifest */
    step = start("manifest");
    if (item.kind === "app") {
      const validation = validateAppManifest(item.manifest ?? {}, { osVersion: OS_VERSION, allowReservedIds: true });
      if (!validation.ok || !validation.manifest) {
        return abort(step, validation.errors.map((issue) => `${issue.path}：${issue.message}`).join("；"));
      }
      item.manifest = validation.manifest;
      finish(step, "ok", `${validation.manifest.appId} · ${validation.manifest.permissions.length} 项权限`);
    } else {
      finish(step, "ok", "由该类型的处理器在安装前再次校验");
    }

    /* 6. 检查权限 */
    step = start("permissions");
    const declared = Array.isArray(item.permissions) ? item.permissions : [];
    const needsConsent = declared.filter((permission) => riskOf(permission) !== "low");
    const extraConsent = needsConsent.filter((permission) => !consent.permissions.includes(permission));
    if (extraConsent.length && !consent.accepted) {
      return abort(step, `需要确认 ${extraConsent.length} 项权限`, { needsConsent: extraConsent });
    }
    finish(step, "ok", needsConsent.length ? `已确认 ${needsConsent.length} 项` : "只需低风险权限");

    /* 7. 用户确认（由调用方保证；这里显式记录） */
    step = start("confirm");
    if (!consent.accepted && needsConsent.length) {
      return abort(step, "用户没有确认", { needsConsent });
    }
    finish(step, "ok", consent.accepted ? "用户已确认" : "无需确认");

    /* 8. 下载 */
    step = start("download");
    const handler = this.handlers.get(item.kind);
    if (!handler) return abort(step, "没有对应的安装处理器");
    let payload: unknown = null;
    try {
      payload = handler.download ? await handler.download(item) : null;
      finish(step, handler.download ? "ok" : "skipped", handler.download ? "下载完成" : "无需下载（本地资源）");
    } catch (error) {
      return abort(step, `下载失败：${(error as Error)?.message ?? "未知错误"}`);
    }

    /* 9. 校验 */
    step = start("verify");
    try {
      const verified = handler.verify ? await handler.verify(item, payload) : { ok: true, message: "无需额外校验" };
      if (!verified.ok) return abort(step, verified.message || "校验失败");
      finish(step, "ok", verified.message);
    } catch (error) {
      return abort(step, `校验异常：${(error as Error)?.message ?? "未知错误"}`);
    }

    /* 10. 安装 */
    step = start("install");
    let installed: { ok: boolean; message: string; record?: unknown; installedId?: string };
    try {
      installed = await handler.install(item, payload, consent);
    } catch (error) {
      return abort(step, `安装失败：${(error as Error)?.message ?? "未知错误"}`);
    }
    if (!installed.ok) return abort(step, installed.message || "安装失败");
    finish(step, "ok", installed.message || "安装完成");

    /* 11. 登记 */
    step = start("register");
    try {
      this.recordInstall(item, installed);
      finish(step, "ok", "已登记到本地资源清单");
    } catch (error) {
      // 登记失败不代表安装失败：如实标记并说明
      finish(step, "failed", `登记失败：${(error as Error)?.message ?? "未知错误"}`);
    }

    /* 12. 返回真实结果 */
    step = start("result");
    finish(step, "ok", "安装成功");
    this.emit("market:installed", { id: item.id, kind: item.kind });

    return {
      ok: true,
      steps,
      message: installed.message || "安装成功",
      ...(installed.record ? { record: installed.record } : {}),
      ...(installed.installedId ? { installedId: installed.installedId } : {}),
    };
  }

  async uninstall(item: MarketItem): Promise<{ ok: boolean; message: string }> {
    const handler = this.handlers.get(item.kind);
    if (!handler?.uninstall) return { ok: false, message: "该类型资源不支持从这里卸载" };
    try {
      const result = await handler.uninstall(item);
      if (result.ok) {
        const store = this.readStore();
        delete store[`${item.kind}:${item.id}`];
        this.context.kernel.storage.write("market.installs.v1", store);
        this.emit("market:uninstalled", { id: item.id, kind: item.kind });
      }
      return result;
    } catch (error) {
      return { ok: false, message: (error as Error)?.message ?? "卸载失败" };
    }
  }

  installs(): Record<string, { at: number; kind: string; name: string; version: string }> {
    return this.readStore();
  }

  /* ---------------- 内部 ---------------- */

  private readStore(): Record<string, { at: number; kind: string; name: string; version: string }> {
    return this.context.kernel.storage.read("market.installs.v1", {});
  }

  private recordInstall(item: MarketItem, installed: { installedId?: string }): void {
    const store = this.readStore();
    store[`${item.kind}:${installed.installedId ?? item.id}`] = {
      at: Date.now(),
      kind: item.kind,
      name: item.name,
      version: item.version,
    };
    this.context.kernel.storage.write("market.installs.v1", store);
  }
}

export const createInstaller = (context: InstallerContext) => new UnifiedInstaller(context);