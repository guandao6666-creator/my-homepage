/**
 * Guandao OS 1.7 · 插件注册中心
 *
 * 所有状态迁移都在这里完成，UI 只负责发起动作与展示结果：
 *   discover → download → validate → install → enable → launch
 *   → update / rollback / disable / uninstall
 *
 * 关键约束：
 *   - 安装前必须通过 Manifest、文件清单、包摘要三重校验；
 *   - 权限只能逐项授予，撤销后运行时立即拒绝；
 *   - 更新时新增权限必须再次征求用户同意；
 *   - 卸载会停止运行上下文、注销应用、清理缓存与数据（可选保留）。
 */

import { escapeHtml, type Ctx } from "../os14/core";
import { compareSemver, PLUGIN_LIMITS, type Manifest } from "../../../shared/plugin-spec.js";
import * as api from "./api";
import { verifyBundle } from "./bundle";
import { verifyPackageSignature } from "./signature";
import { officialPlugin, officialPlugins } from "./builtin";
import { clearEntryCache, destroySessionsFor, mountPluginApp, mountPluginWidget } from "./host";
import {
  appendLog,
  getBundle,
  getInstall,
  listInstalls,
  patchInstall,
  putBundle,
  purgePluginData,
  readState,
  removeInstallRecord,
  saveInstall,
  storageUsage,
  type InstallRecord,
} from "./store";
import { initCommandPalette, refreshCommands, unregisterPluginCommands } from "./commands";
import { normalizeTheme, saveCustomTheme, applyTheme, readThemeState, allThemes, deleteCustomTheme } from "../os14/themes";

import { OS_VERSION } from "../version";
const APP_PREFIX = "plugin:";
const WIDGET_PREFIX = "plugin-widget:";

/**
 * 2.0：换设备恢复安装时不能静默继承的权限。
 * 判断标准是「能读到用户的真实数据」或「能把数据发出去」，不包含低风险的 UI 能力。
 */
const SENSITIVE_PLUGIN_PERMISSIONS = new Set([
  "files.read_selected",
  "network.fetch",
  "notes.read_selected",
  "calendar.read_selected",
]);

let ctxRef: Ctx | null = null;
let updates = new Map<string, api.PluginCard>();

export class PluginConsentRequired extends Error {
  added: string[];
  manifest: Manifest | null;
  kind: "install" | "update";

  constructor(added: string[], manifest: Manifest | null, kind: "install" | "update") {
    super("需要确认新增权限");
    this.name = "PluginConsentRequired";
    this.added = added;
    this.manifest = manifest;
    this.kind = kind;
  }
}

export class PluginInstallError extends Error {
  details: string[];

  constructor(message: string, details: string[] = []) {
    super(message);
    this.name = "PluginInstallError";
    this.details = details;
  }
}

export function pluginAppId(id: string) {
  return `${APP_PREFIX}${id}`;
}

export function pluginWidgetId(id: string) {
  return `${WIDGET_PREFIX}${id}`;
}

/* ============================================================
   启动
   ============================================================ */

export function initPlugins(ctx: Ctx) {
  ctxRef = ctx;
  initCommandPalette(ctx);

  const records = listInstalls();
  for (const record of records) {
    if (record.blocked) continue;
    try {
      registerIntoOs(record);
    } catch (error) {
      appendLog(record.id, "error", `注册失败：${error instanceof Error ? error.message : "未知错误"}`);
    }
  }

  // 云端安装记录用于「换设备自动恢复」与更新提示；失败不影响本地使用。
  void refreshFromServer();
  window.addEventListener("guandao:plugins-change", () => refreshCommands());
}

async function refreshFromServer() {
  if (!ctxRef) return;
  try {
    const result = await api.listInstalled();
    updates = new Map(result.items.filter((item) => item.updateAvailable).map((item) => [item.id, item]));
    const local = new Map(listInstalls().map((record) => [record.id, record]));

    for (const item of result.items) {
      if (local.has(item.id)) continue;
      if (item.installation?.source === "official") continue;
      // 另一台设备装过、这台还没有：恢复安装，但**不再静默继承敏感权限**。
      // 2.0：files.read_selected / network.fetch / notes.read_selected / calendar.read_selected
      // 属于高敏感权限，换设备时必须在本机重新确认，否则保持禁用并在列表里标「待确认权限」。
      try {
        const pkg = await api.getPackage(item.id, item.installation?.version);
        const verified = await verifyBundle(pkg.packageJson, {
          id: item.id,
          type: item.type,
          checksum: pkg.checksum,
        });
        if (!verified.ok) continue;
        // 2.2：签名必须在本地独立验一遍。invalid 直接跳过恢复，unsigned 允许但记录状态。
        const trust = await verifyPackageSignature({
          packageJson: pkg.packageJson,
          checksum: pkg.checksum,
          pluginId: item.id,
          version: pkg.version,
          signature: pkg.signature,
          publisherKeys: pkg.publisherKeys,
        });
        if (trust.status === "invalid") continue;
        const key = await putBundle(item.id, pkg.version, pkg.packageJson);
        const granted = Array.isArray(item.granted) ? item.granted : [];
        const sensitive = granted.filter((permission) => SENSITIVE_PLUGIN_PERMISSIONS.has(permission));
        const needsConsent = sensitive.length > 0;
        const record: InstallRecord = {
          id: item.id,
          name: verified.manifest.name,
          version: pkg.version,
          previousVersion: null,
          type: verified.manifest.type,
          category: verified.manifest.category,
          author: verified.manifest.author.name,
          description: verified.manifest.description,
          manifest: verified.manifest,
          permissions: verified.manifest.permissions,
          granted,
          enabled: needsConsent ? false : (item.installation?.enabled ?? true),
          source: "market",
          installedAt: Date.now(),
          updatedAt: Date.now(),
          packageHash: pkg.checksum,
          filesDigest: verified.filesDigest,
          bundleKey: key,
          signature: { status: trust.status, keyId: trust.keyId, signedAt: trust.signedAt },
          iconUrl: item.iconUrl,
          blocked: false,
          failure: "",
          needsConsent,
          logs: [
            { at: Date.now(), level: "info", message: "从云端安装记录恢复" },
            ...(needsConsent
              ? [
                  {
                    at: Date.now(),
                    level: "warn" as const,
                    message: `涉及 ${sensitive.length} 项敏感权限（${sensitive.join("、")}），已恢复但保持禁用，请在本机重新确认授权`,
                  },
                ]
              : []),
          ],
        };
        saveInstall(record);
        registerIntoOs(record);
      } catch {
        // 单个插件恢复失败不影响其它插件
      }
    }

    for (const item of result.items) {
      const record = local.get(item.id);
      if (record && item.status === "blocked" && !record.blocked) {
        destroySessionsFor(item.id);
        patchInstall(item.id, { blocked: true, enabled: false });
        appendLog(item.id, "error", "插件已被安全下架，已停止运行");
      }
    }
  } catch {
    // 未登录 / 离线：保持本地状态，不伪造「已同步」
  }
}

export function pendingUpdates(): api.PluginCard[] {
  return [...updates.values()];
}

export async function checkForUpdates(): Promise<api.PluginCard[]> {
  try {
    const result = await api.listInstalled();
    updates = new Map(result.items.filter((item) => item.updateAvailable).map((item) => [item.id, item]));
    return [...updates.values()];
  } catch {
    return [];
  }
}

/* ============================================================
   安装
   ============================================================ */

type InstallInput = {
  raw: string;
  manifest: Manifest;
  checksum: string;
  filesDigest: string;
  source: "market" | "official";
  iconUrl: string;
  granted: string[];
};

async function finalizeInstall(input: InstallInput): Promise<InstallRecord> {
  const { raw, manifest, checksum, source, granted } = input;
  const existing = getInstall(manifest.id);
  if (existing) throw new PluginInstallError("这个插件已经安装过了");

  if (listInstalls().length >= PLUGIN_LIMITS.installedPlugins) {
    throw new PluginInstallError(`最多同时安装 ${PLUGIN_LIMITS.installedPlugins} 个插件`);
  }
  if (compareSemver(OS_VERSION, manifest.compatibility.minimumOSVersion) < 0) {
    throw new PluginInstallError(
      `这个插件需要 Guandao OS ${manifest.compatibility.minimumOSVersion} 或更高版本，当前是 ${OS_VERSION}`,
    );
  }
  if (manifest.compatibility.sdkVersion > 1) {
    throw new PluginInstallError("插件使用的 SDK 版本高于当前系统支持的版本");
  }

  const missing = manifest.dependencies
    .filter((dep) => !dep.optional && !getInstall(dep.id))
    .map((dep) => dep.id);
  if (missing.length) {
    throw new PluginInstallError(`缺少依赖插件：${missing.join("、")}`, missing);
  }

  const key = await putBundle(manifest.id, manifest.version, raw);
  const record: InstallRecord = {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    previousVersion: null,
    type: manifest.type,
    category: manifest.category,
    author: manifest.author.name,
    description: manifest.description,
    manifest,
    permissions: manifest.permissions,
    granted,
    enabled: true,
    source,
    installedAt: Date.now(),
    updatedAt: Date.now(),
    packageHash: checksum,
    filesDigest: input.filesDigest,
    bundleKey: key,
    iconUrl: input.iconUrl,
    blocked: false,
    failure: "",
    logs: [
      {
        at: Date.now(),
        level: "info" as const,
        message: `安装 v${manifest.version}（${source === "official" ? "官方" : "市场"}，${granted.length}/${manifest.permissions.length} 项权限）`,
      },
    ],
  };

  saveInstall(record);
  try {
    registerIntoOs(record);
  } catch (error) {
    appendLog(record.id, "error", `注册失败：${error instanceof Error ? error.message : "未知错误"}`);
  }
  ctxRef?.toast(`已安装「${record.name}」v${record.version}`);
  return record;
}

export async function installOfficialPlugin(id: string, granted: string[]): Promise<InstallRecord> {
  const official = await officialPlugin(id);
  if (!official) throw new PluginInstallError("没有找到这个官方插件");
  const verified = await verifyBundle(official.bundle, { id: official.manifest.id, type: official.manifest.type });
  if (!verified.ok) throw new PluginInstallError("官方插件包校验失败", verified.errors);
  const declared = new Set(official.manifest.permissions);
  const allowed = granted.filter((permission) => declared.has(permission));
  return finalizeInstall({
    raw: official.bundle,
    manifest: official.manifest,
    checksum: verified.packageDigest,
    filesDigest: verified.filesDigest,
    source: "official",
    iconUrl: "",
    granted: allowed,
  });
}

export async function installFromMarket(
  detail: api.PluginDetail,
  granted: string[],
  onProgress?: (step: number) => void,
): Promise<InstallRecord> {
  const card = detail.plugin;
  onProgress?.(0);
  if (getInstall(card.id)) throw new PluginInstallError("这个插件已经安装过了");
  if (!card.security.audited) throw new PluginInstallError("这个版本还没有通过安全审核，不能安装");

  const pkg = await api.getPackage(card.id, card.version);
  onProgress?.(1);
  const verified = await verifyBundle(pkg.packageJson, {
    id: card.id,
    type: card.type,
    checksum: pkg.checksum,
  });
  if (!verified.ok) throw new PluginInstallError("插件包没有通过校验", verified.errors);

  const trust = await verifyPackageSignature({
    packageJson: pkg.packageJson,
    checksum: pkg.checksum,
    pluginId: card.id,
    version: pkg.version,
    signature: pkg.signature,
    publisherKeys: pkg.publisherKeys,
  });
  if (trust.status === "invalid") {
    throw new PluginInstallError(`插件签名校验失败：${trust.message}`, trust.errors.map((issue) => `${issue.code}: ${issue.message}`));
  }

  const declared = new Set(verified.manifest.permissions);
  for (const permission of granted) {
    if (!declared.has(permission)) throw new PluginInstallError(`插件没有声明权限：${permission}`);
  }

  // 先落盘插件包，再写服务端安装记录；服务端拒绝时把包清掉，避免半装状态。
  const key = await putBundle(verified.manifest.id, verified.manifest.version, pkg.packageJson);
  onProgress?.(2);
  try {
    const remote = await api.installPlugin({
      pluginId: card.id,
      version: pkg.version,
      packageHash: pkg.checksum,
      permissions: granted,
    });
    const record: InstallRecord = {
      id: verified.manifest.id,
      name: verified.manifest.name,
      version: pkg.version,
      previousVersion: null,
      type: verified.manifest.type,
      category: verified.manifest.category,
      author: verified.manifest.author.name,
      description: verified.manifest.description,
      manifest: verified.manifest,
      permissions: verified.manifest.permissions,
      granted: remote.permissions,
      enabled: true,
      source: "market",
      installedAt: Date.now(),
      updatedAt: Date.now(),
      packageHash: pkg.checksum,
      filesDigest: verified.filesDigest,
      bundleKey: key,
      signature: { status: trust.status, keyId: trust.keyId, signedAt: trust.signedAt },
      iconUrl: card.iconUrl,
      blocked: false,
      failure: "",
      logs: [
        {
          at: Date.now(),
          level: "info" as const,
          message: `从市场安装 v${pkg.version}，授予 ${remote.permissions.length}/${verified.manifest.permissions.length} 项权限`,
        },
      ],
    };
    saveInstall(record);
    onProgress?.(3);
    registerIntoOs(record);
    onProgress?.(4);
    ctxRef?.toast(`已安装「${record.name}」v${record.version}`);
    return record;
  } catch (error) {
    await purgePluginData(card.id, false);
    throw error;
  }
}

/* ============================================================
   更新 / 回滚
   ============================================================ */

export async function updatePlugin(id: string, granted?: string[]): Promise<InstallRecord> {
  const record = getInstall(id);
  if (!record) throw new PluginInstallError("插件尚未安装");
  const detail = await api.getPlugin(id);
  const target = detail.plugin;
  if (compareSemver(target.version, record.version) <= 0) {
    throw new PluginInstallError("当前已经是最新版本");
  }

  const pkg = await api.getPackage(id, target.version);
  const verified = await verifyBundle(pkg.packageJson, { id, type: record.type, checksum: pkg.checksum });
  if (!verified.ok) throw new PluginInstallError("新版本插件包没有通过校验", verified.errors);

  const trust = await verifyPackageSignature({
    packageJson: pkg.packageJson,
    checksum: pkg.checksum,
    pluginId: id,
    version: pkg.version,
    signature: pkg.signature,
    publisherKeys: pkg.publisherKeys,
  });
  if (trust.status === "invalid") {
    throw new PluginInstallError(`新版本签名校验失败：${trust.message}`, trust.errors.map((issue) => `${issue.code}: ${issue.message}`));
  }

  /* 2.0：更新时必须重新检查兼容性。
     1.7–1.9 只在首次安装时比较 minimumOSVersion / sdkVersion，
     作者发一版要求更高系统的插件后，旧客户端会照常升级，然后所有 API 都变成
     UNKNOWN_METHOD —— 用户看到的是「更新后插件坏了」，且没有任何提示。 */
  const minimum = verified.manifest.compatibility?.minimumOSVersion ?? "0.0.0";
  if (compareSemver(OS_VERSION, minimum) < 0) {
    throw new PluginInstallError(
      `这个版本需要 Guandao OS ${minimum} 或更高版本，当前是 ${OS_VERSION}。请联系作者或停留在旧版本。`,
    );
  }
  const requiredSdk = Number(verified.manifest.compatibility?.sdkVersion ?? 1);
  if (requiredSdk > 1) {
    throw new PluginInstallError(`这个版本需要插件 SDK ${requiredSdk}，当前系统只支持到 1。`);
  }

  const added = verified.manifest.permissions.filter((permission) => !record.permissions.includes(permission));
  if (added.length && !granted) throw new PluginConsentRequired(added, verified.manifest, "update");

  const effective = granted ?? record.granted;
  for (const permission of effective) {
    if (!verified.manifest.permissions.includes(permission)) {
      // 新版本移除了某个权限：同步撤销，避免界面显示与实际不一致
      continue;
    }
  }
  const nextGranted = effective.filter((permission) => verified.manifest.permissions.includes(permission));
  const missing = added.filter((permission) => !nextGranted.includes(permission));
  if (missing.length) throw new PluginConsentRequired(missing, verified.manifest, "update");

  const key = await putBundle(id, verified.manifest.version, pkg.packageJson);
  const remote = await api.updatePlugin(id, {
    version: pkg.version,
    packageHash: pkg.checksum,
    permissions: nextGranted,
  });
  if (remote.needsConsent) throw new PluginConsentRequired(remote.added ?? [], verified.manifest, "update");

  destroySessionsFor(id);
  const next: InstallRecord = {
    ...record,
    previousVersion: record.version,
    version: pkg.version,
    manifest: verified.manifest,
    permissions: verified.manifest.permissions,
    granted: remote.permissions ?? nextGranted,
    packageHash: pkg.checksum,
    filesDigest: verified.filesDigest,
    bundleKey: key,
    signature: { status: trust.status, keyId: trust.keyId, signedAt: trust.signedAt },
    iconUrl: target.iconUrl || record.iconUrl,
    updatedAt: Date.now(),
    logs: [
      ...record.logs,
      {
        at: Date.now(),
        level: "info" as const,
        message: `更新 ${record.version} → ${pkg.version}${added.length ? `，新增权限：${added.join("、")}` : ""}`,
      },
    ].slice(-40),
  };
  saveInstall(next);
  updates.delete(id);
  clearEntryCache(id);
  registerIntoOs(next, { reRegister: true });
  ctxRef?.toast(`「${next.name}」已更新到 v${next.version}`);
  return next;
}

export async function rollbackPlugin(id: string): Promise<InstallRecord> {
  const record = getInstall(id);
  if (!record) throw new PluginInstallError("插件尚未安装");
  if (!record.previousVersion) throw new PluginInstallError("没有可回退的版本");
  const versions = await api.getVersions(id);
  const target = versions.versions.find((item) => item.version === record.previousVersion);
  if (!target) throw new PluginInstallError("上一个版本已经不可下载");
  const pkg = await api.getPackage(id, target.version);
  const verified = await verifyBundle(pkg.packageJson, { id, type: record.type, checksum: pkg.checksum });
  if (!verified.ok) throw new PluginInstallError("回退版本校验失败", verified.errors);

  const trust = await verifyPackageSignature({
    packageJson: pkg.packageJson,
    checksum: pkg.checksum,
    pluginId: id,
    version: target.version,
    signature: pkg.signature,
    publisherKeys: pkg.publisherKeys,
  });
  if (trust.status === "invalid") {
    throw new PluginInstallError(`回退版本签名校验失败：${trust.message}`, trust.errors.map((issue) => `${issue.code}: ${issue.message}`));
  }

  await api.rollback(id, { version: target.version, packageHash: pkg.checksum });
  const key = await putBundle(id, target.version, pkg.packageJson);
  destroySessionsFor(id);
  const next: InstallRecord = {
    ...record,
    version: target.version,
    previousVersion: record.version,
    manifest: verified.manifest,
    permissions: verified.manifest.permissions,
    granted: record.granted.filter((permission) => verified.manifest.permissions.includes(permission)),
    packageHash: pkg.checksum,
    filesDigest: verified.filesDigest,
    bundleKey: key,
    signature: { status: trust.status, keyId: trust.keyId, signedAt: trust.signedAt },
    updatedAt: Date.now(),
    logs: [...record.logs, { at: Date.now(), level: "warn" as const, message: `回退到 v${target.version}` }].slice(-40),
  };
  saveInstall(next);
  clearEntryCache(id);
  registerIntoOs(next, { reRegister: true });
  ctxRef?.toast(`已回退到 v${target.version}`);
  return next;
}

/* ============================================================
   启用 / 禁用 / 卸载
   ============================================================ */

export async function setPluginEnabled(id: string, enabled: boolean): Promise<void> {
  const record = getInstall(id);
  if (!record) throw new PluginInstallError("插件尚未安装");
  if (record.blocked) throw new PluginInstallError("插件已被安全下架，不能启用");
  if (enabled && record.needsConsent) {
    throw new PluginInstallError(
      "这个插件在另一台设备上被授予过高敏感权限。请先在插件详情的「权限」里逐项确认，再启用。",
    );
  }

  if (record.source === "market") {
    try {
      await api.setEnabled(id, enabled);
    } catch (error) {
      const message = error instanceof Error ? error.message : "云端状态更新失败";
      appendLog(id, "warn", `云端状态更新失败：${message}`);
    }
  }

  if (!enabled) destroySessionsFor(id);
  const next = patchInstall(id, { enabled });
  if (!next) return;
  if (record.type === "widget") {
    if (ctxRef?.widgets.ids.includes(pluginWidgetId(id))) {
      ctxRef.widgets.setEnabled(pluginWidgetId(id), enabled && next.granted.includes("desktop.add_widget"));
    }
  }
  appendLog(id, "info", enabled ? "已启用" : "已禁用");
  ctxRef?.toast(enabled ? `已启用「${record.name}」` : `已禁用「${record.name}」`);
  refreshCommands();
}

/** 手动调整授权：立即生效，撤销后正在运行的上下文会被销毁。 */
export async function saveGrantedPermissions(id: string, permissions: string[]): Promise<string[]> {
  const record = getInstall(id);
  if (!record) throw new PluginInstallError("插件尚未安装");
  const declared = new Set(record.permissions);
  const next = [...new Set(permissions)].filter((permission) => declared.has(permission));
  destroySessionsFor(id);
  let effective = next;
  if (record.source === "market") {
    const remote = await api.grantPermissions(id, next);
    effective = remote.granted;
  }
  patchInstall(id, { granted: effective, needsConsent: false });
  appendLog(id, "info", `权限更新：${effective.length}/${record.permissions.length} 项`);
  refreshCommands();
  return effective;
}

export async function uninstallPlugin(id: string, keepData: boolean): Promise<void> {
  const record = getInstall(id);
  if (!record) return;
  destroySessionsFor(id);

  // 2.0：主题插件卸载后要把自定义主题一起清掉。
  // 如果当前正在用它，先退回一个内置主题，避免界面停留在已被删除的配色上。
  if (record.type === "theme") {
    try {
      if (readThemeState().current === id) {
        const fallback = allThemes().find((theme) => theme.id === "aurora") ?? allThemes()[0];
        if (fallback) applyTheme(fallback);
      }
      deleteCustomTheme(id);
    } catch {
      /* 主题清理失败不阻断卸载 */
    }
  }

  if (record.source === "market") {
    try {
      await api.uninstallRemote(id);
    } catch (error) {
      appendLog(id, "warn", `云端卸载记录同步失败：${error instanceof Error ? error.message : "未知错误"}`);
    }
  }

  ctxRef?.unregisterApp(pluginAppId(id));
  if (record.type === "widget" && ctxRef?.widgets.ids.includes(pluginWidgetId(id))) {
    ctxRef.widgets.setEnabled(pluginWidgetId(id), false);
  }
  unregisterPluginCommands(id);
  purgePluginData(id, keepData);
  clearEntryCache(id);
  updates.delete(id);
  removeInstallRecord(id);
  ctxRef?.toast(keepData ? `已卸载「${record.name}」，本地数据保留` : `已卸载「${record.name}」`);
  refreshCommands();
}

/* ============================================================
   注册进操作系统
   ============================================================ */

export function registerIntoOs(record: InstallRecord, options: { reRegister?: boolean } = {}) {
  const ctx = ctxRef;
  if (!ctx) return;
  if (record.type === "theme") return; // 声明式主题，不注册运行时

  if (record.type === "widget") {
    registerWidget(ctx, record);
    return;
  }

  if (record.type === "application" || record.type === "integration" || record.type === "file-handler") {
    registerApp(ctx, record);
  }
}

function registerApp(ctx: Ctx, record: InstallRecord) {
  const id = pluginAppId(record.id);
  ctx.registerApp({
    id,
    title: record.name.slice(0, 40),
    width: record.type === "file-handler" ? 760 : 900,
    height: record.type === "file-handler" ? 560 : 620,
    glyph: "di-widgets",
    body: () => `
      <div class="gp-app" data-gp-app="${record.id}">
        <div class="gp-app-state" data-gp-state>正在启动插件…</div>
      </div>`,
    init: (win) => {
      const body = win.querySelector<HTMLElement>("[data-gp-app]");
      if (!body) return;
      let cancelled = false;
      let sandbox: Awaited<ReturnType<typeof mountPluginApp>> | null = null;
      const state = win.querySelector<HTMLElement>("[data-gp-state]");
      const current = getInstall(record.id);
      if (!current || !current.enabled) {
        body.innerHTML = `<div class="gp-blocked"><b>插件已禁用</b><p>在插件管理器里启用后再打开。</p></div>`;
        return;
      }
      mountPluginApp({
        ctx,
        record: current,
        windowEl: win,
        body,
        onStatus: (status) => {
          if (!state) return;
          if (status === "ready") state.remove();
          if (status === "failed") {
            state.innerHTML = `<b>插件启动失败</b><p>可在插件管理器 → 运行日志里查看原因。</p>`;
          }
        },
      })
        .then((value) => {
          if (cancelled) {
            value.destroy();
            return;
          }
          sandbox = value;
          appendLog(record.id, "info", "应用窗口已启动");
          if (current.source === "market") void api.markLaunched(record.id).catch(() => undefined);
        })
        .catch((error) => {
          if (state) {
            state.innerHTML = `<b>插件启动失败</b><p>${escapeHtml(String(error?.message ?? "未知错误").slice(0, 200))}</p>`;
          }
          appendLog(record.id, "error", `启动失败：${error?.message ?? "未知错误"}`);
        });
      return () => {
        cancelled = true;
        sandbox?.destroy();
        sandbox = null;
      };
    },
  });
}

function registerWidget(ctx: Ctx, record: InstallRecord) {
  const id = pluginWidgetId(record.id);
  const config = record.manifest.contributes.widget;
  if (!config) return;

  if (!ctx.widgets.ids.includes(id)) {
    ctx.widgets.register({
      id,
      title: config.title || record.name,
      desc: `${record.name} · 插件组件`,
      category: "plugin",
      body: () =>
        `<div class="gp-widget" data-gp-widget="${record.id}" style="height:${Math.max(80, Math.min(480, config.height || 160))}px"><span class="gp-widget-loading">启动中…</span></div>`,
      init: (el) => mountWidget(ctx, record, el),
      defaultOn: false,
    });
  }

  const granted = record.granted.includes("desktop.add_widget");
  if (record.enabled && granted) {
    ctx.widgets.setEnabled(id, true);
  }
}

function mountWidget(ctx: Ctx, record: InstallRecord, el: HTMLElement) {
  let sandbox: Awaited<ReturnType<typeof mountPluginWidget>> | null = null;
  let cancelled = false;

  const observer = new MutationObserver(() => {
    if (el.isConnected) return;
    observer.disconnect();
    cancelled = true;
    sandbox?.destroy();
    sandbox = null;
  });
  const host = document.getElementById("widgets") ?? document.body;
  observer.observe(host, { childList: true, subtree: true });

  const current = getInstall(record.id);
  if (!current || !current.enabled) return;
  // init 拿到的是整张卡片，这里要挂到 body 里的容器上，否则 iframe 会跑到标题下面
  const mount = el.querySelector<HTMLElement>(".gp-widget") ?? el;
  mount.querySelector(".gp-widget-loading")?.remove();
  mountPluginWidget({ ctx, record: current, host: mount })
    .then((value) => {
      if (cancelled || !el.isConnected) {
        value.destroy();
        return;
      }
      sandbox = value;
    })
    .catch((error) => {
      el.innerHTML = `<span class="gp-widget-error">组件启动失败</span>`;
      appendLog(record.id, "error", `组件启动失败：${error?.message ?? "未知错误"}`);
    });
}

/* ============================================================
   主题插件
   ============================================================ */

export function applyThemePlugin(id: string): void {
  const record = getInstall(id);
  if (!record) throw new PluginInstallError("插件尚未安装");
  const preset = record.manifest.contributes.theme;
  if (!preset) throw new PluginInstallError("这个插件没有主题预设");
  if (!record.granted.includes("theme.apply")) {
    throw new PluginInstallError("没有 theme.apply 权限，先在详情里授权");
  }
  const theme = normalizeTheme({
    id: record.id,
    name: preset.name,
    en: preset.en || "插件",
    author: record.author,
    desc: preset.desc,
    style: "插件主题",
    wall: preset.wall,
    mode: preset.mode,
    accent: preset.accent,
    accent2: preset.accent2,
    material: preset.material,
    radius: preset.radius,
    font: preset.font,
    grain: preset.grain,
    tags: ["插件"],
  });
  if (!theme) throw new PluginInstallError("主题预设不合法（颜色或壁纸格式错误）");
  saveCustomTheme(theme);
  applyTheme(theme);
  appendLog(id, "info", `已应用主题 ${preset.name}`);
}

/* ============================================================
   查询
   ============================================================ */

export function installedRecords() {
  return listInstalls();
}

export function isInstalled(id: string) {
  return Boolean(getInstall(id));
}

export function updateTarget(id: string): api.PluginCard | null {
  return updates.get(id) ?? null;
}

export function storageOf(id: string) {
  return storageUsage(id);
}

export function recordsByType(type: string) {
  return listInstalls().filter((record) => record.type === type);
}

export function hasBundle(id: string): Promise<string | null> {
  const record = getInstall(id);
  if (!record) return Promise.resolve(null);
  return getBundle(record.bundleKey);
}

/** 组件中心 / 应用中心能否看到这个插件 */
export function pluginVisibility(id: string) {
  const record = getInstall(id);
  return Boolean(record && record.enabled && !record.blocked);
}

export function stateSummary() {
  const state = readState();
  const records = Object.values(state.installs);
  return {
    total: records.length,
    enabled: records.filter((record) => record.enabled).length,
    failed: records.filter((record) => record.failure).length,
    blocked: records.filter((record) => record.blocked).length,
  };
}

export async function officialCatalog(): Promise<Array<{ manifest: Manifest; accent: string; installed: boolean }>> {
  const list = await officialPlugins();
  return list.map((item) => ({
    manifest: item.manifest,
    accent: item.accent,
    installed: Boolean(getInstall(item.id)),
  }));
}
