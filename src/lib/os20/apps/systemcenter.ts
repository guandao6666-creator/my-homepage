/**
 * Guandao OS 2.0 · 系统设置（System Center）
 *
 * 把 1.x 散落在「经典设置 / 控制中心 / 数据中心 / 设备管理 / 隐私与安全」里的东西
 * 收进一个入口，并且保证「改了真的会保存、会有反应」：
 *
 *   Appearance        主题、壁纸、材质、圆角、强调色、动画
 *   Personalization   勿扰、音量、问候、设备名、组件与工作空间入口
 *   Applications      已安装应用、应用权限、更新
 *   Plugins           插件启用/禁用、权限、更新入口
 *   Cloud             运行模式、账号、健康、同步域、云盘与备份
 *   Devices           本地设备、云端设备与会话
 *   Privacy & Security 权限审计、导出、删除入口
 *   System            版本、启动报告、诊断、更新、关于、重新引导
 *
 * 所有状态都来自 Kernel（SettingsManager / PermissionManager / AppRegistry /
 * BootReport），不在这里另存一份。
 */

import {
  badge,
  bindTabs,
  escapeHtml,
  fmtDateTime,
  shell,
  type Ctx,
} from "../../os14/core";
import { SETTINGS_BY_ID, type SettingField } from "../../core/settings";
import type { Kernel } from "../../core/kernel";
import type { Sys } from "../../os14/system";
import { CATALOG, META_BY_ID, installedVersion, isInstalled, pendingUpdate } from "../../os14/catalog";
import { THEMES, allThemes, applyTheme } from "../../os14/themes";
import { WALLPAPERS, wallpaperById } from "../../wallpapers";
import { workspaceList } from "../../os14/workspaces";
import { OS_VERSION, RELEASE_NAME, RELEASE_NAME_ZH, BUILD_INFO } from "../../version";
import { applySettings } from "../apply";
import { getOs20 } from "../bridge";
import { MANIFEST_BY_ID } from "../manifests";
import { localTombstones } from "../../sync/providers";
import {
  CONFLICT_TTL_MS,
  MAX_CONFLICTS,
  clearConflicts,
  conflictStats,
  listConflicts,
  type SyncConflict,
} from "../../sync/conflicts";

type Tab = "appearance" | "personal" | "apps" | "plugins" | "cloud" | "devices" | "privacy" | "system";

const TABS: Array<[Tab, string, string]> = [
  ["appearance", "外观", "◐"],
  ["personal", "个性化", "✦"],
  ["apps", "应用", "▦"],
  ["plugins", "插件", "◈"],
  ["cloud", "云端", "☁"],
  ["devices", "设备", "▣"],
  ["privacy", "隐私与安全", "⛨"],
  ["system", "系统", "⚙"],
];

let ctxRef: Ctx | null = null;
let sysRef: Sys | null = null;
let kernelRef: Kernel | null = null;
let tab: Tab = "appearance";

const esc = escapeHtml;

/* ============================================================
   通用小件
   ============================================================ */

const pane = (title: string, sub: string, body: string) => `
  <div class="g14-scroll">
    <div class="g14-pane-head"><h3>${esc(title)}</h3><p>${esc(sub)}</p></div>
    ${body}
  </div>`;

const group = (title: string, body: string) => `
  <section class="os20-group">
    <p class="os20-group-title">${esc(title)}</p>
    ${body}
  </section>`;

const row = (label: string, desc: string, control: string) => `
  <div class="os20-row">
    <div class="os20-row-label"><b>${esc(label)}</b><span>${esc(desc)}</span></div>
    <div class="os20-row-ctl">${control}</div>
  </div>`;

const toggle = (field: SettingField, on: boolean) => `
  <button class="cc14-switch ${on ? "is-on" : ""}" type="button" data-set-toggle="${esc(field.id)}" role="switch" aria-checked="${on}">
    <i></i><span>${on ? "开" : "关"}</span>
  </button>`;

const select = (field: SettingField, value: string) => `
  <select class="os20-select" data-set-select="${esc(field.id)}">
    ${(field.options ?? [])
      .map((option) => `<option value="${esc(option.value)}" ${option.value === value ? "selected" : ""}>${esc(option.label)}</option>`)
      .join("")}
  </select>`;

const number = (field: SettingField, value: number) => `
  <div class="os20-number">
    <input type="range" min="${field.min ?? 0}" max="${field.max ?? 100}" step="${field.step ?? 1}" value="${value}" data-set-number="${esc(field.id)}" />
    <b data-set-out="${esc(field.id)}">${value}${esc(field.unit ?? "")}</b>
  </div>`;

const field = (id: string) => SETTINGS_BY_ID[id];
const value = (id: string) => kernelRef?.settings.get(id);

const effectLabel = (f: SettingField) => (f.effect === "restart" ? "下次启动生效" : "立即生效");

const settingControl = (id: string) => {
  const definition = field(id);
  if (!definition) return "";
  const current = value(id);
  if (definition.type === "boolean") return toggle(definition, Boolean(current));
  if (definition.type === "number") return number(definition, Number(current));
  return select(definition, String(current ?? ""));
};

const settingRow = (id: string) => {
  const definition = field(id);
  if (!definition) return "";
  return row(definition.label, `${definition.desc}（${effectLabel(definition)}）`, settingControl(id));
};

/** 同步域状态 → 人话（不把 failed 写成 ok） */
const syncStateLabel = (state: string): string =>
  (
    {
      idle: "待同步",
      syncing: "同步中",
      ok: "已同步",
      conflict: "有冲突，已保留服务端版本",
      failed: "同步失败",
      offline: "离线，等待重试",
      unsupported: "未接入",
    } as Record<string, string>
  )[state] ?? state;

/* ============================================================
   同步冲突与配额（纯函数，便于 Node 单测）
   ============================================================ */

/** 面板最多展开的冲突条数；更早的记录只提示数量，不一次性铺满 */
export const CONFLICT_ROW_LIMIT = 5;

/** 冲突记录的本地保留天数，直接由冲突模块的 TTL 推导，避免两处各写一个数字 */
const CONFLICT_TTL_DAYS = Math.max(1, Math.round(CONFLICT_TTL_MS / 86_400_000));

/** 配额读取失败 / 缺字段时的统一文案（不抛错、不填假数字） */
export const QUOTA_UNAVAILABLE_TEXT = "配额信息暂不可用";

/** 与 worker/api/sync/limits.js 的上限保持一致；服务端下发 limits 时以服务端为准 */
const FALLBACK_MAX_ENTITIES = 5000;
const FALLBACK_MAX_TOMBSTONES = 2000;

const CONFLICT_DOMAIN_LABEL: Record<string, string> = {
  notes: "Notes",
  tasks: "Tasks",
  calendar: "Calendar",
  workspace: "Workspace",
  preferences: "Preferences",
};

const toCount = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 0;
};

/** 数据域 id → 人话；未知域如实显示原始 id，不假装是已知域 */
export const conflictDomainLabel = (domain: string): string => {
  const key = String(domain ?? "").trim();
  if (!key) return "未知数据域";
  return CONFLICT_DOMAIN_LABEL[key] ?? key;
};

/** 实体 id 截断：保留头尾、中间省略；长 id 不撑破面板，title 里仍保留完整值 */
export function conflictEntityShort(entityId: string, max = 18): string {
  const text = String(entityId ?? "").trim();
  if (!text) return "（无 id）";
  const width = Math.max(8, Math.trunc(Number(max) || 18));
  if (text.length <= width) return text;
  const head = Math.max(4, Math.ceil((width - 1) * 0.6));
  const tail = Math.max(2, width - 1 - head);
  return `${text.slice(0, head)}…${text.slice(-tail)}`;
}

/** 检测时间：固定本地格式 YYYY-MM-DD HH:mm，跨平台一致、便于截图和断言 */
export function formatConflictTime(at: number): string {
  const ts = Number(at);
  if (!Number.isFinite(ts) || ts <= 0) return "时间未知";
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return "时间未知";
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export type ConflictViewItem = {
  id: string;
  domain: string;
  domainLabel: string;
  entityId: string;
  entityShort: string;
  detectedAt: number;
  detectedText: string;
  localRevision: number;
  serverRevision: number;
};

/** 冲突列表 → 面板行：默认只留未解决、按检测时间倒序、最多 5 条 */
export function conflictViewItems(list: SyncConflict[], options: { limit?: number } = {}): ConflictViewItem[] {
  const rawLimit = options.limit;
  const limit =
    typeof rawLimit === "number" && Number.isFinite(rawLimit)
      ? Math.max(0, Math.trunc(rawLimit))
      : CONFLICT_ROW_LIMIT;
  const source = Array.isArray(list) ? list : [];
  return source
    .filter((item) => Boolean(item) && item.state !== "resolved")
    .slice()
    .sort(
      (left, right) =>
        toCount(right.detectedAt) - toCount(left.detectedAt) ||
        String(left.id ?? "").localeCompare(String(right.id ?? "")),
    )
    .slice(0, limit)
    .map((item) => {
      const detectedAt = toCount(item.detectedAt);
      return {
        id: String(item.id ?? ""),
        domain: String(item.domain ?? ""),
        domainLabel: conflictDomainLabel(item.domain),
        entityId: String(item.entityId ?? ""),
        entityShort: conflictEntityShort(item.entityId),
        detectedAt,
        detectedText: formatConflictTime(detectedAt),
        localRevision: toCount(item.localRevision),
        serverRevision: toCount(item.serverRevision),
      };
    });
}

export type SyncQuotaText = {
  available: boolean;
  entitiesText: string;
  tombstonesText: string;
  entityCount: number;
  tombstoneCount: number;
  maxEntities: number;
  maxTombstones: number;
};

const formatQuotaCount = (value: number): string =>
  String(toCount(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/**
 * /api/sync/status 的 quotas → 展示文案。
 * 响应缺失、未登录、离线或字段损坏时 available=false 并统一显示「配额信息暂不可用」，绝不抛出。
 */
export function quotaText(quotas: unknown): SyncQuotaText {
  const unavailable: SyncQuotaText = {
    available: false,
    entitiesText: QUOTA_UNAVAILABLE_TEXT,
    tombstonesText: QUOTA_UNAVAILABLE_TEXT,
    entityCount: 0,
    tombstoneCount: 0,
    maxEntities: FALLBACK_MAX_ENTITIES,
    maxTombstones: FALLBACK_MAX_TOMBSTONES,
  };
  if (!quotas || typeof quotas !== "object") return unavailable;
  const source = quotas as { entityCount?: unknown; tombstoneCount?: unknown; limits?: unknown };
  if (source.entityCount === undefined && source.tombstoneCount === undefined) return unavailable;
  const limits =
    source.limits && typeof source.limits === "object"
      ? (source.limits as { maxEntities?: unknown; maxTombstones?: unknown })
      : {};
  const entityCount = toCount(source.entityCount);
  const tombstoneCount = toCount(source.tombstoneCount);
  const maxEntities = toCount(limits.maxEntities) || FALLBACK_MAX_ENTITIES;
  const maxTombstones = toCount(limits.maxTombstones) || FALLBACK_MAX_TOMBSTONES;
  return {
    available: true,
    entitiesText: `${formatQuotaCount(entityCount)} / ${formatQuotaCount(maxEntities)}`,
    tombstonesText: `${formatQuotaCount(tombstoneCount)} / ${formatQuotaCount(maxTombstones)}`,
    entityCount,
    tombstoneCount,
    maxEntities,
    maxTombstones,
  };
}

export type SyncResolveChoice = "local" | "remote";

export type SyncResolveOutcome =
  | { ok: true; noop?: boolean; resolved?: SyncResolveChoice }
  | { ok: false; reason: "changed" | "offline" | "unsupported" | "error"; error?: string };

export type ConflictResolveNotice = { tone: "ok" | "warn" | "error"; text: string };

/** 解决结果 → 用户提示。changed 必须让用户重新确认，不能假装解决成功 */
export function conflictResolveNotice(result: SyncResolveOutcome): ConflictResolveNotice {
  if (!result || typeof result !== "object") return { tone: "error", text: "解决冲突失败，请稍后重试" };
  if (result.ok) {
    if (result.resolved === "local") return { tone: "ok", text: "已保留本地版本，冲突已解决" };
    if (result.resolved === "remote") return { tone: "ok", text: "已保留云端版本，冲突已解决" };
    return { tone: "ok", text: "这条冲突已经处理过，无需重复操作" };
  }
  if (result.reason === "changed") return { tone: "warn", text: "同步版本已再次变化，请重新确认" };
  if (result.reason === "offline") return { tone: "warn", text: "当前离线或未登录，无法解决冲突" };
  if (result.reason === "unsupported") return { tone: "warn", text: "该数据域暂不支持解决冲突" };
  return { tone: "error", text: "解决冲突失败，请稍后重试" };
}

/* ============================================================
   外观
   ============================================================ */

const themeCard = (id: string, name: string, accent: string, accent2: string, wall: string, style: string, active: boolean) => `
  <button class="os20-theme ${active ? "is-active" : ""}" type="button" data-theme="${esc(id)}">
    <span class="os20-theme-art" style="background-image:url('${esc(wall)}');--a:${esc(accent)};--b:${esc(accent2)}"></span>
    <span class="os20-theme-meta"><b>${esc(name)}</b><i>${esc(style)}</i></span>
  </button>`;

const appearanceView = () => {
  const kernel = kernelRef;
  if (!kernel) return "";
  const currentWall = String((ctxRef?.api13.cfg() as { wall?: { id?: string } })?.wall?.id ?? "");
  const themes = allThemes();

  return pane(
    "外观",
    "主题、壁纸与材质。所有选择立即生效，并保存在这台设备上。",
    group(
      "主题",
      `<div class="os20-themes">${themes
        .slice(0, 12)
        .map((item) =>
          themeCard(item.id, item.name, item.accent, item.accent2, wallpaperById(item.wall)?.thumb || wallpaperById(item.wall)?.src || "", item.style, false),
        )
        .join("")}</div>
       <p class="g14-hint">主题同时定义壁纸、强调色、窗口材质与圆角；「主题中心」里有完整预览与自定义主题。</p>`,
    ) +
      group(
        "壁纸",
        `<div class="os20-walls">${WALLPAPERS.slice(0, 12)
          .map(
            (wall) => `<button class="os20-wall ${wall.id === currentWall ? "is-active" : ""}" type="button" data-wall="${esc(wall.id)}" title="${esc(wall.name)}">
              <span style="background-image:url('${esc(wall.thumb || wall.src)}')"></span>
            </button>`,
          )
          .join("")}</div>
         <div class="os20-inline"><button class="g14-btn" type="button" data-open="themes">打开主题中心</button>
         <button class="g14-btn is-ghost" type="button" data-wall-next>换一张</button></div>`,
      ) +
      group(
        "材质与圆角",
        settingRow("appearance.material") +
          settingRow("appearance.radius") +
          settingRow("appearance.accent") +
          settingRow("appearance.animations"),
      ) +
      group("桌面外观", settingRow("desktop.iconLabels") + settingRow("desktop.clockSeconds") + settingRow("desktop.widgets.opacity")),
  );
};

/* ============================================================
   个性化
   ============================================================ */

const personalView = () => {
  const workspaces = workspaceList();
  const profile = kernelRef?.device.profile();
  return pane(
    "个性化",
    "问候、勿扰、音量，以及这台设备的名字。",
    group("通知与声音", settingRow("notifications.dnd") + settingRow("notifications.volume")) +
      group(
        "设备名称",
        `<div class="os20-inline">
          <input class="os20-input" type="text" maxlength="40" value="${esc(profile?.name ?? "")}" data-device-name />
          <button class="g14-btn" type="button" data-device-save>保存名称</button>
        </div>
        <p class="g14-hint">只保存在本地；云端设备身份由服务端生成，两者不会混用。</p>`,
      ) +
      group(
        "桌面布置",
        row("桌面组件", "相框、倒计时、迷你日历、音乐控制等", `<button class="g14-btn" type="button" data-open="widgetstore">组件中心</button>`) +
          row(
            "工作空间",
            `当前有 ${workspaces.length} 套场景，切换会同时恢复壁纸、主题、组件与窗口布局`,
            `<button class="g14-btn" type="button" data-open="workspaces">管理场景</button>`,
          ) +
          row("程序坞位置", "也可以在这里直接改", settingControl("desktop.dock.position")) +
          row("程序坞自动隐藏", "鼠标离开后收起", settingControl("desktop.dock.autohide")),
      ),
  );
};

/* ============================================================
   应用
   ============================================================ */

const permissionLabel = (id: string) => {
  const labels: Record<string, string> = {
    "storage.read": "读取本地数据",
    "storage.write": "写入本地数据",
    "files.read": "读取文件",
    "files.write": "导出文件",
    "clipboard.read": "读取剪贴板",
    "clipboard.write": "写入剪贴板",
    "notifications.post": "发送通知",
    "network.request": "网络请求",
    "window.control": "控制窗口",
    "desktop.modify": "修改桌面",
    "theme.apply": "应用主题",
    "cloud.sync": "云同步",
    "account.read": "读取账号资料",
    "plugin.manage": "管理插件",
  };
  return labels[id] ?? id;
};

const appRow = (appId: string) => {
  const kernel = kernelRef;
  const record = kernel?.registry.get(appId);
  const meta = META_BY_ID[appId];
  if (!record || !meta) {
    return `<div class="os20-app"><span class="di-glyph ${esc(meta?.glyph ?? "di-folder")}"></span>
      <div class="os20-app-meta"><b>${esc(meta?.name ?? appId)}</b><span>未登记到 2.0 注册中心</span></div>
      <span class="os20-chip is-mute">未登记</span></div>`;
  }
  const stateLabel: Record<string, string> = {
    registered: "未安装",
    installed: "已安装",
    enabled: "已启用",
    running: "运行中",
    minimized: "已收起",
    suspended: "已挂起",
    disabled: "已禁用",
    failed: "异常",
  };
  const granted = kernel?.permissions.grantsOf({ kind: "app", id: appId }) ?? [];
  const declared = record.manifest.permissions;
  const stateTone = record.state === "failed" ? "danger" : record.state === "disabled" ? "warn" : record.state === "running" ? "ok" : "mute";

  const permChips = declared.length
    ? declared
        .map(
          (permission) => `<button class="os20-perm ${granted.includes(permission) ? "is-on" : ""}" type="button"
            data-perm-app="${esc(appId)}" data-perm="${esc(permission)}"
            title="${granted.includes(permission) ? "点击撤销" : "点击授予"}">${esc(permissionLabel(permission))}</button>`,
        )
        .join("")
    : `<span class="g14-hint">不需要额外权限</span>`;

  return `<div class="os20-app">
    <span class="di-glyph ${esc(meta.glyph)}"></span>
    <div class="os20-app-meta">
      <b>${esc(meta.name)}</b>
      <span>v${esc(record.manifest.version)} · ${esc(record.source)} · ${esc(stateLabel[record.state] ?? record.state)}</span>
      <div class="os20-perms">${permChips}</div>
    </div>
    <span class="os20-chip is-${stateTone}">${esc(stateLabel[record.state] ?? record.state)}</span>
    <div class="os20-app-acts">
      <button class="g14-btn is-ghost" type="button" data-open="${esc(appId)}">打开</button>
      ${
        record.source === "system"
          ? `<span class="g14-hint">系统应用</span>`
          : record.state === "disabled"
            ? `<button class="g14-btn" type="button" data-app-enable="${esc(appId)}">启用</button>`
            : `<button class="g14-btn is-ghost" type="button" data-app-disable="${esc(appId)}">禁用</button>`
      }
    </div>
  </div>`;
};

const appsView = () => {
  const kernel = kernelRef;
  const sys = sysRef;
  const installed = CATALOG.filter((meta) => isInstalled(meta.id));
  const updates = CATALOG.filter((meta) => isInstalled(meta.id) && pendingUpdate(meta.id));
  const stats = kernel?.registry.stats();

  return pane(
    "应用",
    "已安装应用与它们的权限。权限是真实判定：撤销后应用下次调用就会被拒绝。",
    group(
      "概览",
      `<div class="os20-kpis">
        <div class="os20-kpi"><b>${installed.length}</b><span>已安装</span></div>
        <div class="os20-kpi"><b>${stats?.running ?? 0}</b><span>运行中</span></div>
        <div class="os20-kpi"><b>${updates.length}</b><span>可更新</span></div>
        <div class="os20-kpi"><b>${kernel?.permissions.auditStats().denied ?? 0}</b><span>权限被拒次数</span></div>
      </div>`,
    ) +
      group(
        "应用权限",
        `<div class="os20-apps">${installed.map((meta) => appRow(meta.id)).join("")}</div>`,
      ) +
      group(
        "更新",
        updates.length
          ? updates
              .map(
                (meta) =>
                  row(`${meta.name} ${installedVersion(meta.id)} → ${meta.version}`, meta.tagline, `<button class="g14-btn" type="button" data-app-update="${esc(meta.id)}">更新</button>`),
              )
              .join("")
          : `<p class="g14-hint">所有内置应用都是当前版本。第三方更新在「插件管理器 → 更新」里处理。</p>`,
      ) +
      group(
        "默认应用",
        `<p class="g14-hint">2.0 还没有「默认应用」绑定：文件打开方式仍然由文件管理器按类型推荐（见文件管理器 → 打开方式）。这里不会放一个改了没反应的假设置。</p>`,
      ),
  );
};

/* ============================================================
   插件
   ============================================================ */

const pluginsView = () => {
  let records: Array<{
    id: string;
    name: string;
    version: string;
    type: string;
    enabled: boolean;
    blocked: boolean;
    granted: string[];
    permissions: string[];
    failure: string;
  }> = [];
  try {
    const module = (window as unknown as { GOS20_PLUGINS?: typeof records }).GOS20_PLUGINS;
    if (module) records = module;
  } catch {
    records = [];
  }

  return pane(
    "插件",
    "第三方插件运行在独立沙箱里，所有系统能力都要经过权限 Broker。详细日志与更新在插件管理器。",
    group(
      "已安装插件",
      records.length
        ? records
            .map((record) => {
              const granted = record.granted.length;
              const total = record.permissions.length;
              return `<div class="os20-app">
                <span class="di-glyph di-widgets"></span>
                <div class="os20-app-meta">
                  <b>${esc(record.name)}</b>
                  <span>v${esc(record.version)} · ${esc(record.type)} · 权限 ${granted}/${total}</span>
                  ${record.blocked ? `<span class="os20-chip is-danger">已下架</span>` : ""}
                  ${record.failure ? `<span class="g14-hint">${esc(record.failure)}</span>` : ""}
                </div>
                <span class="os20-chip ${record.enabled ? "is-ok" : "is-mute"}">${record.enabled ? "已启用" : "已禁用"}</span>
                <div class="os20-app-acts">
                  <button class="g14-btn is-ghost" type="button" data-open="pm">管理</button>
                </div>
              </div>`;
            })
            .join("")
        : `<p class="g14-hint">还没有安装第三方插件。到「插件市场」看看，或者用开发者中心发布自己的插件。</p>`,
    ) +
      group(
        "入口",
        row("插件管理器", "逐项授权、更新、回退、运行日志与禁用", `<button class="g14-btn" type="button" data-open="pm">打开</button>`) +
          row("插件市场", "经过审核的第三方插件；安装前校验包摘要与兼容性", `<button class="g14-btn" type="button" data-open="pmarket">打开</button>`) +
          row("开发者中心", "草稿、版本上传、审核状态与安装统计", `<button class="g14-btn is-ghost" type="button" data-open="pdev">打开</button>`),
      ) +
      group(
        "安全说明",
        `<div class="os20-note">
          <p>插件脚本运行在 <code>sandbox="allow-scripts"</code> 的 iframe 里，origin 为 opaque，读不到主页面 DOM、Cookie 与 localStorage。</p>
          <p>插件联网只能走宿主代理，域名必须在 manifest 里声明并通过你授权。</p>
          <p>撤销权限会立即销毁正在运行的插件上下文，不需要重启系统。</p>
        </div>`,
      ),
  );
};

/* ============================================================
   云端
   ============================================================ */

/** 单条冲突：域 + 实体（截断）、检测时间与两边的 revision，以及两个显式选择 */
const conflictRow = (item: ConflictViewItem): string => {
  const label = `${item.domainLabel} · ${item.entityShort}`;
  return `
    <div class="os20-row">
      <div class="os20-row-label">
        <b title="${esc(item.entityId)}">${esc(label)}</b>
        <span>检测于 ${esc(item.detectedText)} · 本地 revision ${item.localRevision} / 云端 revision ${item.serverRevision}</span>
      </div>
      <div class="os20-row-ctl">
        <button class="g14-btn" type="button" data-conflict-id="${esc(item.id)}" data-conflict-choice="local" aria-label="${esc(`保留本地版本：${label}`)}">保留本地</button>
        <button class="g14-btn is-ghost" type="button" data-conflict-id="${esc(item.id)}" data-conflict-choice="remote" aria-label="${esc(`保留云端版本：${label}`)}">保留云端</button>
      </div>
    </div>`;
};

/** 「最近同步冲突」面板正文：数量、最多 5 条待处理、清理入口、保留策略说明 */
const conflictPanelBody = (): string => {
  const items = conflictViewItems(listConflicts());
  const stats = conflictStats();
  const hidden = Math.max(0, stats.open - items.length);
  return `
    <div class="os20-inline" style="margin-top:0">
      <span class="os20-chip ${stats.open > 0 ? "is-warn" : "is-ok"}">${stats.open} 条待处理</span>
      ${stats.resolved > 0 ? `<span class="os20-chip is-mute">已解决 ${stats.resolved} 条</span>` : ""}
      ${stats.resolved > 0 ? `<button class="g14-btn is-ghost" type="button" data-conflict-clear-resolved>清理已解决</button>` : ""}
    </div>
    ${items.length ? items.map((item) => conflictRow(item)).join("") : `<p class="g14-hint">暂无同步冲突</p>`}
    ${hidden > 0 ? `<p class="g14-hint">只展开最近 ${items.length} 条；处理完或清理后，更早的 ${hidden} 条会自动顶上来。</p>` : ""}
    <div class="os20-note">
      <p>冲突记录只保存在本机：最多 ${MAX_CONFLICTS} 条、保留 ${CONFLICT_TTL_DAYS} 天，只存必要的元数据与受控快照，不上传云端。</p>
      <p>「保留本地」用本地当前内容重新推送；「保留云端」把云端版本拉回本地。确认前云端版本再次更新时，需要重新确认。</p>
    </div>`;
};

const cloudView = () => {
  const kernel = kernelRef;
  if (!kernel) return "";
  const cloud = kernel.cloud.state();
  const summary = kernel.cloud.summary();
  const domains = kernel.sync.domains();
  const unsupported = kernel.sync.unregistered([
    { id: "notes", label: "Notes" },
    { id: "tasks", label: "Tasks" },
    { id: "calendar", label: "Calendar" },
  ]);
  const tone = summary.tone === "ok" ? "is-ok" : summary.tone === "warn" ? "is-warn" : summary.tone === "danger" ? "is-danger" : "is-mute";
  const tombstones = localTombstones();

  return pane(
    "云端",
    "Local Mode 与 Cloud Mode 的区别只在于是否启用账号与云端能力；本地数据永远是你的。",
    group(
      "运行模式",
      `<div class="os20-mode">
        <button class="os20-mode-btn ${cloud.mode === "local" ? "is-active" : ""}" type="button" data-mode="local">
          <b>Local Mode</b><span>不需要账号，完整本地桌面，不会自动上传</span>
        </button>
        <button class="os20-mode-btn ${cloud.mode === "cloud" ? "is-active" : ""}" type="button" data-mode="cloud">
          <b>Cloud Mode</b><span>登录后启用同步、云盘、备份、设备与社区</span>
        </button>
      </div>
      <p class="g14-hint">切换模式不会清空本地内容，也不会无提示覆盖云端数据。</p>`,
    ) +
      group(
        "状态",
        `<div class="os20-kpis">
          <div class="os20-kpi"><b>${esc(summary.label)}</b><span>${esc(summary.detail)}</span></div>
          <div class="os20-kpi"><b>${cloud.online ? "在线" : "离线"}</b><span>浏览器网络状态</span></div>
          <div class="os20-kpi"><b>${cloud.health ? `${cloud.health.latencyMs ?? "—"} ms` : "未探测"}</b><span>云端 API 延迟</span></div>
          <div class="os20-kpi"><b>${cloud.authenticated ? esc(cloud.user?.displayName ?? "已登录") : "未登录"}</b><span>账号</span></div>
        </div>
        <div class="os20-inline">
          <button class="g14-btn" type="button" data-cloud-refresh>重新检查</button>
          <button class="g14-btn is-ghost" type="button" data-open="drive">云盘</button>
          <button class="g14-btn is-ghost" type="button" data-open="backup">备份</button>
          <button class="g14-btn is-ghost" type="button" data-open="devices">设备</button>
        </div>
        ${cloud.health ? `<p class="g14-hint">最近探测：${esc(cloud.health.detail)}（${esc(fmtDateTime(cloud.health.at))}）</p>` : ""}`,
      ) +
      group(
        "数据同步",
        `<div class="os20-sync">
          ${domains.length ? domains.map((domain) => `<div class="os20-sync-row"><b>${esc(domain.label)}</b><span>${esc(syncStateLabel(domain.state))}${
            domain.lastSyncAt ? ` · ${esc(fmtDateTime(domain.lastSyncAt))}` : ""
          }${domain.conflicts ? ` · ${domain.conflicts} 个冲突` : ""}</span></div>`).join("") : ""}
          ${unsupported
            .map(
              (domain) =>
                `<div class="os20-sync-row is-muted"><b>${esc(domain.label)}</b><span>未接入（仅在本地保存）</span></div>`,
            )
            .join("")}
        </div>
        <div class="os20-inline">
          <button class="g14-btn is-primary" type="button" data-sync-now ${cloud.authenticated && cloud.mode === "cloud" ? "" : "disabled"}>立即同步</button>
          <span class="g14-hint">${
            domains.length
              ? `已接入 ${domains.length} 个数据域 · 本地待同步墓碑 ${Object.values(tombstones).reduce((sum, value) => sum + value, 0)} 条`
              : "Cloud Mode 且登录后才会接入同步"
          }</span>
        </div>
        <div class="os20-kpis" style="margin-top:12px">
          <div class="os20-kpi"><b data-sync-quota-entities>读取中…</b><span>同步实体 / 上限</span></div>
          <div class="os20-kpi"><b data-sync-quota-tombstones>读取中…</b><span>删除墓碑 / 上限</span></div>
        </div>
        <p class="g14-hint">配额来自 <code>/api/sync/status</code> 的真实统计；超出上限时推送返回 409，不会静默丢数据。</p>
        <p class="g14-hint">同步按实体做增量对比与乐观锁：冲突时服务端版本优先落回本地，不会互相覆盖。删除通过墓碑传播，不会在另一台设备上「复活」。</p>`,
      ) +
      group("最近同步冲突", conflictPanelBody()) +
      group(
        "存储用量",
        `<div class="os20-kpis">
          <div class="os20-kpi"><b data-cloud-storage>读取中…</b><span>云盘已用 / 配额</span></div>
          <div class="os20-kpi"><b data-cloud-files>—</b><span>文件与回收站</span></div>
        </div>
        <p class="g14-hint">来自 <code>/api/files/quota</code> 的真实统计；未登录或离线时如实显示原因，不填假数字。</p>`,
      ),
  );
};

/** 云盘用量：真实请求 /api/files/quota，失败时显示具体原因 */
async function hydrateCloudStorage(root: HTMLElement): Promise<void> {
  const usedNode = root.querySelector<HTMLElement>("[data-cloud-storage]");
  const filesNode = root.querySelector<HTMLElement>("[data-cloud-files]");
  if (!usedNode) return;
  try {
    const response = await fetch("/api/files/quota", {
      credentials: "same-origin",
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      usedNode.textContent = response.status === 401 ? "登录后可用" : `读取失败（HTTP ${response.status}）`;
      if (filesNode) filesNode.textContent = "—";
      return;
    }
    const payload = (await response.json().catch(() => null)) as
      | { data?: { usedBytes?: number; limitBytes?: number; files?: number; trashCount?: number } }
      | null;
    const data = payload?.data;
    if (!data) {
      usedNode.textContent = "响应格式异常";
      return;
    }
    usedNode.textContent = `${formatBytes(Number(data.usedBytes) || 0)} / ${formatBytes(Number(data.limitBytes) || 0)}`;
    if (filesNode) filesNode.textContent = `${Number(data.files) || 0} 个 · 回收站 ${Number(data.trashCount) || 0} 个`;
  } catch {
    usedNode.textContent = "离线，无法读取";
    if (filesNode) filesNode.textContent = "—";
  }
}

/**
 * 同步配额：GET /api/sync/status（同源、credentials include），失败静默降级。
 * 只更新两个数字节点，不重渲染整页；未登录 / 离线 / 接口未上线一律显示「配额信息暂不可用」，不抛错。
 */
async function hydrateSyncQuota(root: HTMLElement): Promise<void> {
  const entitiesNode = root.querySelector<HTMLElement>("[data-sync-quota-entities]");
  const tombstonesNode = root.querySelector<HTMLElement>("[data-sync-quota-tombstones]");
  if (!entitiesNode && !tombstonesNode) return;
  const unavailable = quotaText(null);
  const write = (entitiesText: string, tombstonesText: string) => {
    if (entitiesNode) entitiesNode.textContent = entitiesText;
    if (tombstonesNode) tombstonesNode.textContent = tombstonesText;
  };
  try {
    const response = await fetch("/api/sync/status", {
      credentials: "include",
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      write(unavailable.entitiesText, unavailable.tombstonesText);
      return;
    }
    const payload = (await response.json().catch(() => null)) as { data?: { quotas?: unknown } } | null;
    const quotas = payload?.data?.quotas;
    if (!quotas) {
      write(unavailable.entitiesText, unavailable.tombstonesText);
      return;
    }
    const text = quotaText(quotas);
    write(text.entitiesText, text.tombstonesText);
  } catch {
    /* 离线或接口未上线：如实显示不可用，不打扰用户 */
    write(unavailable.entitiesText, unavailable.tombstonesText);
  }
}

const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** index;
  return `${value >= 10 || index === 0 ? Math.round(value) : value.toFixed(1)} ${units[index]}`;
};

/* ============================================================
   设备
   ============================================================ */

const devicesView = () => {
  const kernel = kernelRef;
  const profile = kernel?.device.profile();
  const capabilities = kernel?.device.capabilities();
  const cloud = kernel?.cloud.state();
  return pane(
    "设备",
    "本地设备档案与当前账号的云端设备。两者由不同系统管理，不会重复登记。",
    group(
      "这台设备",
      `<div class="os20-kpis">
        <div class="os20-kpi"><b>${esc(profile?.name ?? "—")}</b><span>本地名称</span></div>
        <div class="os20-kpi"><b>${esc(profile?.type ?? "—")}</b><span>设备类型</span></div>
        <div class="os20-kpi"><b>${esc(capabilities?.shell ?? "—")}</b><span>外壳模式</span></div>
        <div class="os20-kpi"><b>${capabilities ? `${capabilities.viewport.width}×${capabilities.viewport.height}` : "—"}</b><span>视口</span></div>
      </div>
      <div class="os20-inline">
        <input class="os20-input" type="text" maxlength="40" value="${esc(profile?.name ?? "")}" data-device-name />
        <button class="g14-btn" type="button" data-device-save>重命名</button>
      </div>
      <p class="g14-hint">指针：${esc(capabilities?.pointer ?? "—")} · 触屏：${capabilities?.touch ? "是" : "否"} · 存储可用：${capabilities?.storageAvailable ? "是" : "否"}</p>`,
    ) +
      group(
        "账号与云端设备",
        cloud?.authenticated
          ? `<p class="g14-hint">已登录 ${esc(cloud.user?.displayName ?? "")}。设备、会话、配对与接管在「Guandao Devices」里管理。</p>
             <div class="os20-inline"><button class="g14-btn" type="button" data-open="devices">打开设备管理</button>
             <button class="g14-btn is-ghost" type="button" data-open="continuity">接力中心</button></div>`
          : `<p class="g14-hint">未登录：设备列表需要 Cloud Mode。本地桌面与本地档案例外，不需要账号。</p>
             <div class="os20-inline"><button class="g14-btn" type="button" data-mode="cloud">切到 Cloud Mode</button></div>`,
      ) +
      group(
        "设备一致性",
        `<p class="g14-hint">同一浏览器刷新不会新增设备；换浏览器/换设备才会新增。撤销设备后，那台设备的下一次请求会收到 401。</p>`,
      ),
  );
};

/* ============================================================
   隐私与安全
   ============================================================ */

const privacyView = () => {
  const kernel = kernelRef;
  if (!kernel) return "";
  const stats = kernel.permissions.auditStats();
  const entries = kernel.permissions.audit(20);
  const overview = kernel.permissions.overview();
  const grantedTotal = overview.reduce((sum, item) => sum + item.granted, 0);

  return pane(
    "隐私与安全",
    "权限审计、数据导出与删除。这里只展示真实记录，不做评分游戏。",
    group(
      "概览",
      `<div class="os20-kpis">
        <div class="os20-kpi"><b>${grantedTotal}</b><span>已授予权限</span></div>
        <div class="os20-kpi"><b>${stats.total}</b><span>判定次数</span></div>
        <div class="os20-kpi"><b>${stats.denied}</b><span>被拒绝</span></div>
        <div class="os20-kpi"><b>${overview.filter((item) => item.blocked).length}</b><span>被拉黑来源</span></div>
      </div>
      <p class="g14-hint">判定记录最多保留 200 条；拒绝会立即写盘，允许按批写入。</p>`,
    ) +
      group(
        "权限明细",
        overview.length
          ? `<div class="os20-perm-list">${overview
              .map((item) => {
                const appId = item.principal.replace(/^app:/, "");
                const isSystemApp = item.kind === "app" && MANIFEST_BY_ID[appId]?.source === "system";
                const counts = isSystemApp
                  ? "系统应用 · 走 bypass（仍记审计）"
                  : `${item.granted}/${item.declared} 项`;
                return `<div class="os20-perm-row"><b>${esc(item.principal)}</b><span>${esc(counts)}</span>${
                  item.blocked ? badge("已拉黑", "danger") : ""
                }</div>`;
              })
              .join("")}</div>`
          : `<p class="g14-hint">还没有任何应用或插件请求过权限。</p>`,
      ) +
      group(
        "最近判定",
        entries.length
          ? `<div class="os20-audit">${entries
              .map(
                (entry) =>
                  `<div class="os20-audit-row ${entry.allowed ? "" : "is-denied"}">
                    <span class="os20-audit-time">${esc(fmtDateTime(entry.at))}</span>
                    <b>${esc(entry.permission)}</b>
                    <span>${esc(entry.principal.kind)}:${esc(entry.principal.id)}</span>
                    <span class="os20-chip ${entry.allowed ? "is-ok" : "is-danger"}">${entry.allowed ? "允许" : "拒绝"}</span>
                  </div>`,
              )
              .join("")}</div>`
          : `<p class="g14-hint">还没有权限判定记录。</p>`,
      ) +
      group(
        "数据",
        row("导出审计日志", "JSON 文件，包含权限清单与判定记录", `<button class="g14-btn" type="button" data-export-audit>导出</button>`) +
          row("导出我的数据", "本地全部数据 + 云端导出由隐私与安全应用处理", `<button class="g14-btn" type="button" data-open="security">打开隐私与安全</button>`) +
          row("删除数据", "本地清理与账号注销都在同一个应用里，有二次确认", `<button class="g14-btn is-ghost" type="button" data-open="security">管理</button>`),
      ),
  );
};

/* ============================================================
   系统
   ============================================================ */

const systemView = () => {
  const kernel = kernelRef;
  if (!kernel) return "";
  const report = kernel.bootReport();
  const status = kernel.status();
  const stages = report?.stages ?? [];
  const okCount = stages.filter((stage) => stage.status === "ok").length;

  return pane(
    "系统",
    "版本、启动报告、诊断与更新。构建信息来自编译时注入的真实常量。",
    group(
      "版本",
      `<div class="os20-about">
        <div class="os20-about-logo">管</div>
        <div>
          <h4>Guandao OS ${esc(OS_VERSION)}</h4>
          <p>${esc(RELEASE_NAME)} · ${esc(RELEASE_NAME_ZH)}</p>
          <p class="g14-hint">构建 ${esc(BUILD_INFO.build)} · ${esc(BUILD_INFO.builtAt)} · ${esc(BUILD_INFO.channel)}</p>
        </div>
      </div>
      <div class="os20-inline">
        <button class="g14-btn" type="button" data-open="updatecenter">更新中心</button>
        <button class="g14-btn is-ghost" type="button" data-open="diagnostics">诊断中心</button>
        <button class="g14-btn is-ghost" type="button" data-open="onboarding">重新查看引导</button>
      </div>`,
    ) +
      group(
        "启动报告",
        report
          ? `<p class="g14-hint">${okCount}/${stages.length} 个阶段成功 · 总耗时 ${report.durationMs} ms · 模式 ${esc(report.mode)}${report.offline ? " · 离线启动" : ""}</p>
             <div class="os20-stages">${stages
               .map(
                 (stage) => `<div class="os20-stage is-${stage.status}">
                   <span>${esc(stage.label)}</span>
                   <b>${stage.durationMs} ms</b>
                   <i>${stage.status === "ok" ? "完成" : stage.status === "skipped" ? "跳过" : esc(stage.error ?? "失败")}</i>
                 </div>`,
               )
               .join("")}</div>
             ${report.degraded.length ? `<div class="os20-note is-warn"><p>降级项：${report.degraded.map((item) => esc(item)).join("；")}</p></div>` : ""}`
          : `<p class="g14-hint">还没有启动报告。</p>`,
      ) +
      group(
        "更新",
        settingRow("system.updateChannel") +
          row("检查更新", "读取版本清单并做兼容性检查", `<button class="g14-btn" type="button" data-open="updatecenter">打开更新中心</button>`) +
          row("诊断日志保留", "超出上限会裁剪最旧的记录", settingControl("system.diagnosticsRetention")),
      ) +
      group(
        "维护",
        row("重启桌面", "只重新加载页面，不删除任何数据", `<button class="g14-btn" type="button" data-reload>重新加载</button>`) +
          row("重置设置", "把 2.0 设置恢复默认；不影响笔记、文件与应用数据", `<button class="g14-btn is-danger" type="button" data-reset-settings>重置设置</button>`),
      ) +
      group(
        "关于",
        `<div class="os20-note">
          <p>Guandao OS 是一个跑在浏览器里的个人数字操作系统：桌面、应用、插件、云端与社区共用一套内核。</p>
          <p>开发团队信息：本项目由作者个人维护，没有虚构的团队成员名单。构建流水线与提交记录在仓库中可查。</p>
          <p>服务状态：Kernel ${esc(status.phase)} · 应用 ${kernel.registry.list().length} 个 · 权限判定 ${kernel.permissions.auditStats().total} 次</p>
        </div>`,
      ),
  );
};

/* ============================================================
   渲染与交互
   ============================================================ */

const view = () => {
  switch (tab) {
    case "personal":
      return personalView();
    case "apps":
      return appsView();
    case "plugins":
      return pluginsView();
    case "cloud":
      return cloudView();
    case "devices":
      return devicesView();
    case "privacy":
      return privacyView();
    case "system":
      return systemView();
    case "appearance":
    default:
      return appearanceView();
  }
};

export const renderSystemCenter = () =>
  shell("systemcenter", TABS.map(([id, label, icon]) => [id, label, icon]), `<div data-sc-host></div>`, "系统设置");

export const initSystemCenter = (win: HTMLElement, ctx: Ctx, sys: Sys, kernelArg?: Kernel): (() => void) => {
  const kernel = kernelArg ?? getOs20()?.kernel ?? null;
  if (!kernel) {
    const host = win.querySelector<HTMLElement>("[data-sc-host]");
    if (host) {
      host.innerHTML = `<div class="g14-empty"><span class="g14-empty-ico">◌</span><p class="g14-empty-title">内核尚未就绪</p><p class="g14-empty-sub">2.0 系统设置依赖 Guandao Core，请刷新页面后重试。</p></div>`;
    }
    return () => undefined;
  }

  ctxRef = ctx;
  sysRef = sys;
  kernelRef = kernel;

  const host = win.querySelector<HTMLElement>("[data-sc-host]");
  if (!host) return () => undefined;

  const paint = () => {
    host.innerHTML = view();
    if (tab === "cloud") {
      void hydrateCloudStorage(host);
      void hydrateSyncQuota(host);
    }
  };

  /** 解决/清理冲突后只刷新云端面板：保留滚动位置，不调用 syncNow、不触发其他数据域 */
  const refreshCloudPanel = () => {
    if (tab !== "cloud") return;
    const scroll = host.querySelector<HTMLElement>(".g14-scroll");
    const top = scroll?.scrollTop ?? 0;
    paint();
    if (top > 0) {
      const next = host.querySelector<HTMLElement>(".g14-scroll");
      if (next) next.scrollTop = top;
    }
  };

  const apply = () => {
    try {
      applySettings(kernel, ctx, { silent: true });
    } catch {
      /* 设置应用失败时保持界面可用 */
    }
  };

  const refreshPlugins = async () => {
    try {
      const module = await import("../../plugins/registry");
      const records = module.installedRecords().map((record) => ({
        id: record.id,
        name: record.name,
        version: record.version,
        type: record.type,
        enabled: record.enabled,
        blocked: record.blocked,
        granted: record.granted,
        permissions: record.permissions,
        failure: record.failure,
      }));
      (window as unknown as { GOS20_PLUGINS?: typeof records }).GOS20_PLUGINS = records;
    } catch {
      (window as unknown as { GOS20_PLUGINS?: unknown[] }).GOS20_PLUGINS = [];
    }
    if (tab === "plugins") paint();
  };

  win.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;

    const open = target.closest<HTMLElement>("[data-open]");
    if (open) {
      const id = open.dataset.open ?? "";
      if (id === "onboarding") {
        void import("./onboarding").then((module) => module.openOnboarding({ kernel, ctx, sys }));
        return;
      }
      ctx.openApp(id);
      return;
    }

    const themeButton = target.closest<HTMLElement>("[data-theme]");
    if (themeButton) {
      const id = themeButton.dataset.theme ?? "";
      const theme = (allThemes?.() ?? THEMES).find((item) => item.id === id);
      if (theme) {
        applyTheme(theme);
        win.querySelectorAll("[data-theme]").forEach((node) => node.classList.toggle("is-active", node === themeButton));
        ctx.toast(`已应用主题「${theme.name}」`);
      }
      return;
    }

    const wallButton = target.closest<HTMLElement>("[data-wall]");
    if (wallButton) {
      const id = wallButton.dataset.wall ?? "";
      ctx.api13.setWallpaper(id);
      win.querySelectorAll("[data-wall]").forEach((node) => node.classList.toggle("is-active", node === wallButton));
      return;
    }
    if (target.closest("[data-wall-next]")) {
      ctx.api13.nextWallpaper();
      return;
    }

    const toggleButton = target.closest<HTMLElement>("[data-set-toggle]");
    if (toggleButton) {
      const id = toggleButton.dataset.setToggle ?? "";
      const next = !Boolean(kernel.settings.get(id));
      kernel.settings.set(id, next);
      apply();
      paint();
      return;
    }

    const modeButton = target.closest<HTMLElement>("[data-mode]");
    if (modeButton) {
      const mode = modeButton.dataset.mode === "cloud" ? "cloud" : "local";
      kernel.setMode(mode);
      apply();
      ctx.toast(mode === "cloud" ? "已切换到 Cloud Mode" : "已切换到 Local Mode，本地数据保持不变");
      paint();
      return;
    }

    if (target.closest("[data-cloud-refresh]")) {
      void kernel.cloud.refresh({ deep: true }).then(() => {
        paint();
      });
      return;
    }

    if (target.closest("[data-sync-now]")) {
      const gos = window as unknown as { GOS20?: { syncNow?: () => Promise<void> } };
      if (!gos.GOS20?.syncNow) {
        ctx.toast("云同步尚未就绪，请刷新后重试");
        return;
      }
      void gos.GOS20.syncNow()
        .then(() => {
          ctx.toast("同步完成");
          paint();
        })
        .catch(() => {
          ctx.toast("同步失败，请到诊断中心查看原因");
          paint();
        });
      return;
    }

    const conflictButton = target.closest<HTMLElement>("[data-conflict-id][data-conflict-choice]");
    if (conflictButton) {
      const conflictId = conflictButton.dataset.conflictId ?? "";
      const choice: SyncResolveChoice = conflictButton.dataset.conflictChoice === "remote" ? "remote" : "local";
      const gos = window as unknown as {
        GOS20?: {
          syncResolveConflict?: (id: string, selected: SyncResolveChoice) => Promise<SyncResolveOutcome>;
        };
      };
      const resolve = gos.GOS20?.syncResolveConflict;
      if (!conflictId || !resolve) {
        ctx.toast("冲突中心尚未就绪，请刷新页面后重试");
        return;
      }
      (conflictButton as HTMLButtonElement).disabled = true;
      void resolve(conflictId, choice)
        .then((result) => {
          ctx.toast(conflictResolveNotice(result).text);
        })
        .catch(() => {
          ctx.toast("解决冲突失败，请稍后重试");
        })
        .finally(() => {
          // 成功、失败、changed 都重新渲染：列表与 serverRevision 必须和真实状态一致
          refreshCloudPanel();
        });
      return;
    }

    if (target.closest("[data-conflict-clear-resolved]")) {
      const resolved = listConflicts({ includeResolved: true }).filter((item) => item.state === "resolved");
      let removed = 0;
      for (const item of resolved) removed += clearConflicts({ id: item.id });
      ctx.toast(removed > 0 ? `已清理 ${removed} 条已解决冲突记录` : "没有可清理的已解决冲突");
      refreshCloudPanel();
      return;
    }

    if (target.closest("[data-device-save]")) {
      const input = win.querySelector<HTMLInputElement>("[data-device-name]");
      const name = input?.value.trim() ?? "";
      kernel.device.rename(name);
      ctx.toast(name ? `设备已重命名为「${name}」` : "已恢复默认设备名");
      paint();
      return;
    }

    const permissionButton = target.closest<HTMLElement>("[data-perm-app][data-perm]");
    if (permissionButton) {
      const appId = permissionButton.dataset.permApp ?? "";
      const permission = permissionButton.dataset.perm ?? "";
      const principal = { kind: "app" as const, id: appId };
      const granted = kernel.permissions.grantsOf(principal);
      if (granted.includes(permission)) kernel.permissions.revoke(principal, [permission]);
      else kernel.permissions.grant(principal, [permission]);
      paint();
      return;
    }

    const disable = target.closest<HTMLElement>("[data-app-disable]");
    if (disable) {
      const id = disable.dataset.appDisable ?? "";
      kernel.registry.disable(id);
      paint();
      return;
    }
    const enable = target.closest<HTMLElement>("[data-app-enable]");
    if (enable) {
      const id = enable.dataset.appEnable ?? "";
      kernel.registry.enable(id);
      paint();
      return;
    }
    const update = target.closest<HTMLElement>("[data-app-update]");
    if (update) {
      const id = update.dataset.appUpdate ?? "";
      sys?.update(id);
      paint();
      return;
    }

    if (target.closest("[data-export-audit]")) {
      try {
        const blob = new Blob([kernel.permissions.exportAudit()], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = `guandao-audit-${new Date().toISOString().slice(0, 10)}.json`;
        link.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 1500);
        ctx.toast("审计日志已导出");
      } catch {
        ctx.toast("导出失败");
      }
      return;
    }

    if (target.closest("[data-reload]")) {
      location.reload();
      return;
    }

    if (target.closest("[data-reset-settings]")) {
      kernel.settings.reset();
      apply();
      paint();
      ctx.toast("设置已恢复默认");
      return;
    }
  });

  win.addEventListener("change", (event) => {
    const selectElement = (event.target as HTMLElement).closest<HTMLSelectElement>("[data-set-select]");
    if (selectElement) {
      const id = selectElement.dataset.setSelect ?? "";
      kernel.settings.set(id, selectElement.value);
      apply();
      paint();
      return;
    }
  });

  win.addEventListener("input", (event) => {
    const range = (event.target as HTMLElement).closest<HTMLInputElement>("[data-set-number]");
    if (!range) return;
    const id = range.dataset.setNumber ?? "";
    const definition = SETTINGS_BY_ID[id];
    const out = win.querySelector<HTMLElement>(`[data-set-out="${id}"]`);
    if (out) out.textContent = `${range.value}${definition?.unit ?? ""}`;
  });

  win.addEventListener("pointerup", (event) => {
    const range = (event.target as HTMLElement).closest<HTMLInputElement>("[data-set-number]");
    if (!range) return;
    const id = range.dataset.setNumber ?? "";
    kernel.settings.set(id, Number(range.value));
    apply();
  });

  bindTabs(win, (next) => {
    tab = (TABS.some(([id]) => id === next) ? next : "appearance") as Tab;
    if (tab === "plugins") void refreshPlugins();
    paint();
  });

  paint();
  void refreshPlugins();

  const unsubscribe = kernel.settings.subscribe(() => {
    if (tab === "appearance" || tab === "personal" || tab === "system") paint();
  });

  return () => {
    unsubscribe();
    ctxRef = null;
    sysRef = null;
    kernelRef = null;
  };
};