/**
 * Guandao OS 1.7 · 插件界面公共件
 *
 * 权限弹窗是这一版最重要的界面：它必须清楚回答四个问题——
 * 申请了什么、为什么需要、是否涉及私人数据、是否访问外部网络。
 * 所以这里不用系统通用 modal，而是按模块分组、逐项可控。
 */

import { safeUrl } from "../html";
import { escapeHtml } from "../os14/core";
import {
  PLUGIN_TYPE_META,
  PERMISSION_BY_ID,
  PLUGIN_LIMITS,
  groupPermissions,
  riskOf,
  hasSensitivePermission,
  type Manifest,
} from "../../../shared/plugin-spec.js";
import type { InstallRecord } from "./store";

/** 2.3：esc 只是 escapeHtml 的短名字，保留是为了不动 400+ 个调用点 */
export const esc = escapeHtml;

export function typeLabel(type: string): string {
  return PLUGIN_TYPE_META[type as keyof typeof PLUGIN_TYPE_META]?.label ?? type;
}

export function typeIcon(type: string): string {
  return PLUGIN_TYPE_META[type as keyof typeof PLUGIN_TYPE_META]?.icon ?? "◈";
}

export function fmtNumber(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value < 1000) return String(value);
  if (value < 10000) return `${(value / 1000).toFixed(1)}k`;
  return `${Math.round(value / 1000)}k`;
}

export function fmtBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export function timeAgo(ts: number | null | undefined): string {
  if (!ts) return "—";
  const diff = Date.now() - ts;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 2_592_000_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  return new Date(ts).toLocaleDateString("zh-CN");
}

export function riskChip(risk: string): string {
  const label = risk === "high" ? "高风险" : risk === "medium" ? "中等" : "低风险";
  return `<span class="gp-chip is-${risk === "high" ? "danger" : risk === "medium" ? "warn" : "ok"}">${label}</span>`;
}

export function pluginGlyph(name: string, type: string, accent = "linear-gradient(140deg,#6f8cff,#b06eff)", iconUrl = ""): string {
  const initial = (name || "P").trim().slice(0, 1).toUpperCase();
  if (iconUrl) {
    // 插件图标来自第三方清单：只允许 http(s)/相对路径，data: 也放行（<img> 里不执行脚本）
    return `<span class="gp-glyph has-img" style="--gp-accent:${esc(accent)}"><img src="${safeUrl(iconUrl, { allowData: true })}" alt="" loading="lazy" /><i>${esc(typeIcon(type))}</i></span>`;
  }
  return `<span class="gp-glyph" style="--gp-accent:${esc(accent)}"><b>${esc(initial)}</b><i>${esc(typeIcon(type))}</i></span>`;
}

export function recordStatus(record: InstallRecord): { label: string; tone: string } {
  if (record.blocked) return { label: "已下架", tone: "danger" };
  if (record.needsConsent) return { label: "待确认权限", tone: "warn" };
  if (!record.enabled) return { label: "已禁用", tone: "mute" };
  if (record.failure) return { label: "异常", tone: "warn" };
  return { label: "已启用", tone: "ok" };
}

export function statusChip(record: InstallRecord): string {
  const status = recordStatus(record);
  return `<span class="gp-chip is-${status.tone}">${status.label}</span>`;
}

/* ============================================================
   通用弹窗
   ============================================================ */

export type DialogOptions = {
  title: string;
  subtitle?: string;
  body: string;
  actions: Array<{ label: string; value: string; primary?: boolean; danger?: boolean }>;
  wide?: boolean;
  footer?: string;
};

export function openDialog(host: HTMLElement, options: DialogOptions): { root: HTMLElement; result: Promise<string | null> } {
  let resolveFn: (value: string | null) => void = () => undefined;
  const result = new Promise<string | null>((resolve) => {
    resolveFn = resolve;
  });

  const layer = document.createElement("div");
  layer.className = "gp-dialog-layer";
  layer.innerHTML = `
    <div class="gp-dialog${options.wide ? " is-wide" : ""}" role="dialog" aria-modal="true">
      <p class="gp-dialog-title">${esc(options.title)}</p>
      ${options.subtitle ? `<p class="gp-dialog-sub">${esc(options.subtitle)}</p>` : ""}
      <div class="gp-dialog-body">${options.body}</div>
      <div class="gp-dialog-actions">
        ${options.actions
          .map(
            (action) =>
              `<button type="button" class="gp-btn${action.primary ? " is-primary" : ""}${action.danger ? " is-danger" : ""}" data-gp-action="${esc(action.value)}">${esc(action.label)}</button>`,
          )
          .join("")}
      </div>
      ${options.footer ? `<p class="gp-dialog-note">${esc(options.footer)}</p>` : ""}
    </div>`;

  const close = (value: string | null) => {
    resolveFn(value);
    // 先 resolve 再移除：调用方需要回读弹窗里的 checkbox / input
    window.setTimeout(() => layer.remove(), 0);
  };

  layer.addEventListener("click", (event) => {
    if (event.target === layer) close(null);
    const button = (event.target as HTMLElement).closest<HTMLElement>("[data-gp-action]");
    if (button) close(button.dataset.gpAction ?? "");
  });

  layer.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close(null);
  });

  host.appendChild(layer);
  window.setTimeout(() => layer.querySelector<HTMLElement>("button, input")?.focus(), 30);

  return { root: layer, result };
}

function permissionItem(permissionId: string, checked: boolean): string {
  const permission = PERMISSION_BY_ID[permissionId];
  if (!permission) return "";
  return `
    <label class="gp-perm-item${permission.sensitive ? " is-sensitive" : ""}">
      <input type="checkbox" data-perm="${esc(permission.id)}" ${checked ? "checked" : ""} />
      <span class="gp-perm-text">
        <b>${esc(permission.label)}</b>
        <span>${esc(permission.desc)}</span>
      </span>
      <span class="gp-perm-tags">
        ${permission.sensitive ? '<em class="is-private">私人数据</em>' : ""}
        ${permission.network ? '<em class="is-net">外部网络</em>' : ""}
        ${permission.risk === "high" ? '<em class="is-risk">高风险</em>' : ""}
      </span>
    </label>`;
}

export type PermissionRequest = {
  manifest: Manifest;
  mode: "install" | "update" | "manage";
  added?: string[];
  granted?: string[];
};

/**
 * 权限审批。返回用户勾选的权限列表；取消返回 null。
 * 「拒绝」也是一等公民：什么都不勾仍然可以继续安装，只是插件会在缺权限时失败。
 */
export async function requestPermissions(host: HTMLElement, request: PermissionRequest): Promise<string[] | null> {
  const { manifest } = request;
  const permissions = manifest.permissions;
  const groups = groupPermissions(permissions);
  const risk = riskOf(permissions);
  const sensitive = hasSensitivePermission(permissions);
  /* 1.9：默认不再「全选」。
     只有低风险且不涉及私人数据的权限才默认勾选；高风险、涉及私人数据、
     需要外部网络的权限必须由用户逐项确认，否则「默认拒绝」在界面上形同虚设。 */
  const autoGrant = (id: string): boolean => {
    const permission = PERMISSION_BY_ID[id];
    if (!permission) return false;
    return permission.risk === "low" && !permission.sensitive && !permission.network;
  };
  const checkedSet = new Set(
    request.mode === "manage" ? request.granted ?? [] : permissions.filter((id) => autoGrant(id)),
  );
  const added = new Set(request.added ?? []);

  if (!permissions.length) {
    const { result } = openDialog(host, {
      title: request.mode === "manage" ? "权限" : "安装确认",
      subtitle: `${manifest.name} v${manifest.version}`,
      body: `<p class="gp-perm-empty">这个插件没有申请任何权限，只能使用自己的沙箱界面。</p>`,
      actions: [
        { label: "取消", value: "" },
        { label: request.mode === "manage" ? "保存" : "安装", value: "ok", primary: true },
      ],
      footer: "Guandao OS 1.7 · 默认拒绝：没有申请的权限，插件永远拿不到。",
    });
    const action = await result;
    return action === "ok" ? [] : null;
  }

  const body = `
    <div class="gp-perm-summary is-${risk}">
      <div class="gp-perm-summary-main">
        <b>${permissions.length} 项权限</b>
        <span>${risk === "high" ? "包含高风险能力" : risk === "medium" ? "包含中等风险能力" : "均为低风险能力"}</span>
      </div>
      <div class="gp-perm-flags">
        ${sensitive ? '<span class="is-private">涉及私人数据</span>' : ""}
        ${manifest.networkDomains.length ? `<span class="is-net">访问 ${manifest.networkDomains.length} 个外部域名</span>` : '<span class="is-local">未声明外部域名</span>'}
      </div>
    </div>
    ${added.size ? `<div class="gp-perm-added"><b>新版本新增</b>${[...added].map((id) => `<span>${esc(PERMISSION_BY_ID[id]?.label ?? id)}</span>`).join("")}</div>` : ""}
    <div class="gp-perm-groups">
      ${groups
        .map(
          (group) => `
        <section class="gp-perm-group">
          <header><b>${esc(group.label)}</b><span>${group.items.length} 项</span></header>
          ${group.items.map((item) => permissionItem(item.id, checkedSet.has(item.id))).join("")}
        </section>`,
        )
        .join("")}
    </div>
    ${manifest.networkDomains.length
      ? `<div class="gp-perm-domains"><b>允许访问的域名</b><div>${manifest.networkDomains.map((domain) => `<code>${esc(domain)}</code>`).join("")}</div><p>请求由系统代理转发，不携带 Cookie；不会访问列表以外的地址。</p></div>`
      : ""}
    <div class="gp-perm-tools">
      <button type="button" class="gp-link" data-perm-all>全部允许</button>
      <button type="button" class="gp-link" data-perm-none>全部拒绝</button>
      <span>逐项可改，安装后也能在插件管理器里撤销。</span>
    </div>`;

  const { root, result } = openDialog(host, {
    title: request.mode === "update" ? "更新需要重新确认权限" : request.mode === "manage" ? "管理权限" : "安装前确认权限",
    subtitle: `${manifest.name} v${manifest.version} · ${typeLabel(manifest.type)}`,
    body,
    actions:
      request.mode === "update"
        ? [
            { label: "暂不更新", value: "" },
            { label: "同意并更新", value: "ok", primary: true },
          ]
        : request.mode === "manage"
          ? [
              { label: "取消", value: "" },
              { label: "保存授权", value: "ok", primary: true },
            ]
          : [
              { label: "取消安装", value: "" },
              { label: "允许所选并安装", value: "ok", primary: true },
            ],
    footer: "权限可随时撤销，撤销后插件的对应调用会立即被拒绝。",
    wide: true,
  });

  root.querySelector("[data-perm-all]")?.addEventListener("click", () => {
    root.querySelectorAll<HTMLInputElement>("input[data-perm]").forEach((box) => {
      box.checked = true;
    });
  });
  root.querySelector("[data-perm-none]")?.addEventListener("click", () => {
    root.querySelectorAll<HTMLInputElement>("input[data-perm]").forEach((box) => {
      box.checked = false;
    });
  });

  const action = await result;
  if (action !== "ok") return null;
  return [...root.querySelectorAll<HTMLInputElement>("input[data-perm]")]
    .filter((box) => box.checked)
    .map((box) => box.dataset.perm ?? "")
    .filter(Boolean);
}

export async function requestUninstall(host: HTMLElement, record: InstallRecord): Promise<{ ok: boolean; keepData: boolean }> {
  const usage = record.granted.length;
  const { root, result } = openDialog(host, {
    title: `卸载「${record.name}」`,
    subtitle: `v${record.version} · ${typeLabel(record.type)}`,
    body: `
      <p class="gp-dialog-para">卸载会立即停止所有运行中的插件上下文，移除应用注册与命令。</p>
      <label class="gp-check"><input type="checkbox" data-keep /> 保留插件产生的数据</label>
      <p class="gp-dialog-hint">默认清空它的命名空间存储（不影响其它插件与应用）。需要下次接着用原来的配置时再勾选保留。</p>
      <p class="gp-dialog-hint">当前授予 ${usage} 项权限，卸载后全部撤销。</p>`,
    actions: [
      { label: "取消", value: "" },
      { label: "卸载", value: "ok", danger: true, primary: true },
    ],
    footer: "云端只保留一条卸载审计记录，不保留插件数据。",
  });
  const action = await result;
  const keepData = Boolean(root.querySelector<HTMLInputElement>("[data-keep]")?.checked);
  return { ok: action === "ok", keepData };
}

export async function promptText(
  host: HTMLElement,
  options: {
    title: string;
    message?: string;
    value?: string;
    placeholder?: string;
    multiline?: boolean;
    submitLabel?: string;
    danger?: boolean;
  },
): Promise<string | null> {
  const body = `
    ${options.message ? `<p class="gp-dialog-para">${esc(options.message)}</p>` : ""}
    ${
      options.multiline
        ? `<textarea class="gp-input" data-gp-input rows="4" maxlength="1200" placeholder="${esc(options.placeholder ?? "")}">${esc(options.value ?? "")}</textarea>`
        : `<input class="gp-input" data-gp-input maxlength="200" value="${esc(options.value ?? "")}" placeholder="${esc(options.placeholder ?? "")}" />`
    }`;
  const { root, result } = openDialog(host, {
    title: options.title,
    body,
    actions: [
      { label: "取消", value: "" },
      { label: options.submitLabel ?? "确定", value: "ok", primary: !options.danger, danger: options.danger },
    ],
  });
  const input = root.querySelector<HTMLInputElement | HTMLTextAreaElement>("[data-gp-input]");
  window.setTimeout(() => input?.focus(), 40);
  const action = await result;
  if (action !== "ok") return null;
  return input?.value.trim() ?? "";
}

export function promptLogin(): void {
  const menu = document.getElementById("mb-account") as HTMLButtonElement | null;
  const auth = document.getElementById("mbam-auth") as HTMLButtonElement | null;
  if (menu) {
    menu.click();
    window.setTimeout(() => auth?.click(), 80);
    return;
  }
  location.assign("/?account=1");
}

export function loginGate(host: HTMLElement, message: string): string {
  return `
    <div class="gp-gate">
      <span class="gp-gate-ico">◈</span>
      <b>需要 Guandao Account</b>
      <p>${esc(message)}</p>
      <button type="button" class="gp-btn is-primary" data-gp-login>使用 GitHub 登录</button>
      <p class="gp-gate-note">插件安装与权限都绑定到账号；本地官方示例不需要登录即可体验。</p>
    </div>`;
}

/** 安装进度：只展示真实步骤，把每一步的完成情况交给调用方推进。 */
export function openProgress(host: HTMLElement, title: string, steps: string[]) {
  const layer = document.createElement("div");
  layer.className = "gp-dialog-layer";
  layer.innerHTML = `
    <div class="gp-dialog" role="dialog" aria-modal="true">
      <p class="gp-dialog-title">${esc(title)}</p>
      <ol class="gp-progress">
        ${steps.map((step, index) => `<li data-step="${index}" class="is-pending"><span></span><b>${esc(step)}</b></li>`).join("")}
      </ol>
      <p class="gp-progress-note" data-gp-progress-note>正在与本地运行时校验…</p>
    </div>`;
  host.appendChild(layer);
  return {
    step(index: number) {
      layer.querySelectorAll<HTMLElement>("[data-step]").forEach((node) => {
        const current = Number(node.dataset.step);
        node.classList.toggle("is-done", current < index);
        node.classList.toggle("is-active", current === index);
        node.classList.toggle("is-pending", current > index);
      });
    },
    note(text: string) {
      const node = layer.querySelector<HTMLElement>("[data-gp-progress-note]");
      if (node) node.textContent = text;
    },
    close() {
      layer.remove();
    },
  };
}

export const LIMITS = PLUGIN_LIMITS;
