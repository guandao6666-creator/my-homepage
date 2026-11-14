/**
 * Guandao OS 2.0 · 应用与资源市场
 *
 * 统一入口，但要让人一眼看懂「这是什么东西、装完会发生什么」：
 *   - 每张卡片标注类型、来源与是否已安装；
 *   - 详情面板列出权限与风险，高风险必须勾选确认；
 *   - 安装时展示 12 步校验流程的真实状态（哪一步失败就是哪一步）；
 *   - 不把「已审核」当成「绝对安全」，也不隐藏失败。
 */

import { safeUrl } from "../../html";
import {
  badge,
  bindTabs,
  escapeHtml,
  fmtBytes,
  fmtDateTime,
  shell,
  type Ctx,
} from "../../os14/core";
import type { Sys } from "../../os14/system";
import { getOs20 } from "../bridge";
import { createHub, type Hub } from "../../market/hub";
import { STEP_LABEL, riskOf, type InstallOutcome, type MarketItem, type ResourceKind, type StepState } from "../../market/install";

type Kind = "all" | ResourceKind;

const KINDS: Array<[Kind, string, string]> = [
  ["all", "全部", "◎"],
  ["app", "应用", "▦"],
  ["plugin", "插件", "◈"],
  ["theme", "主题", "◐"],
  ["widget", "组件", "▤"],
  ["wallpaper", "壁纸", "◧"],
  ["workspace", "工作空间", "◫"],
  ["community", "社区", "✦"],
];

type State = {
  kind: Kind;
  query: string;
  selected: string;
  remoteLoaded: boolean;
  remoteBusy: boolean;
  remoteErrors: string[];
  installing: { id: string; steps: StepState[] } | null;
  outcome: InstallOutcome | null;
  consent: { open: boolean; item: MarketItem | null; permissions: string[]; accepted: boolean };
};

const state: State = {
  kind: "all",
  query: "",
  selected: "",
  remoteLoaded: false,
  remoteBusy: false,
  remoteErrors: [],
  installing: null,
  outcome: null,
  consent: { open: false, item: null, permissions: [], accepted: false },
};

let hub: Hub | null = null;
let ctxRef: Ctx | null = null;

const esc = escapeHtml;

const kindLabel = (kind: Kind) => KINDS.find(([id]) => id === kind)?.[1] ?? kind;

const sourceBadge = (item: MarketItem) => {
  if (item.source === "system") return badge("系统内置", "ok");
  if (item.source === "market") return badge("市场插件", "accent");
  return badge("社区创作", "warn");
};

const itemKey = (item: MarketItem) => `${item.kind}:${item.id}`;
const keyOf = (item: MarketItem) => itemKey(item);

const iconHtml = (item: MarketItem) => {
  const isUrl = /^(https?:|data:|\/)/.test(item.icon);
  if (isUrl) return `<img class="os20-mk-icon" src="${safeUrl(item.icon)}" alt="" loading="lazy" />`;
  return `<span class="os20-mk-icon di-glyph ${esc(item.icon || "di-folder")}"></span>`;
};

const refreshData = () => {
  if (!hub) return;
  const current = state.selected;
  const list = hub.search(state.query, state.kind);
  if (current && !list.some((item) => keyOf(item) === current)) state.selected = "";
};

const card = (item: MarketItem) => `
  <article class="os20-mk-card ${state.selected === keyOf(item) ? "is-active" : ""}" data-item="${esc(keyOf(item))}" tabindex="0">
    <div class="os20-mk-thumb" ${item.preview ? `style="background-image:url('${esc(item.preview)}')"` : ""}>
      ${item.preview ? "" : iconHtml(item)}
      ${item.installed ? `<span class="os20-mk-badge">已安装</span>` : ""}
    </div>
    <div class="os20-mk-body">
      <h4>${esc(item.name)}</h4>
      <p>${esc(item.description.slice(0, 78))}</p>
      <div class="os20-mk-meta">
        <span>${esc(kindLabel(item.kind))}</span>
        <span>v${esc(item.version)}</span>
        ${sourceBadge(item)}
      </div>
    </div>
  </article>`;

const stepList = (steps: StepState[]) => `
  <ol class="os20-steps">
    ${steps
      .map(
        (step) => `<li class="is-${step.status}">
          <span>${step.status === "ok" ? "✓" : step.status === "failed" ? "!" : step.status === "running" ? "…" : step.status === "skipped" ? "–" : "·"}</span>
          <b>${esc(step.label)}</b>
          ${step.detail ? `<i>${esc(step.detail)}</i>` : ""}
        </li>`,
      )
      .join("")}
  </ol>`;

const permissionList = (item: MarketItem) => {
  if (!item.permissions.length) return `<p class="g14-hint">这个资源不需要额外权限。</p>`;
  return `<div class="os20-mk-perms">${item.permissions
    .map((permission) => {
      const risk = riskOf(permission);
      const tone = risk === "high" ? "danger" : risk === "mid" ? "warn" : "mute";
      return `<span class="os20-chip is-${tone}">${esc(permission)} · ${risk === "high" ? "高风险" : risk === "mid" ? "中风险" : "低风险"}</span>`;
    })
    .join("")}</div>`;
};

const detail = (item: MarketItem) => {
  const precheck = hub?.installer.precheck(item);
  const steps = state.outcome?.steps ?? precheck?.steps ?? [];
  return `
    <aside class="os20-mk-detail">
      <div class="os20-mk-detail-head">
        ${iconHtml(item)}
        <div>
          <h3>${esc(item.name)}</h3>
          <p>v${esc(item.version)} · ${esc(item.author)}</p>
        </div>
      </div>
      <p class="os20-mk-desc">${esc(item.description)}</p>
      <div class="os20-mk-tags">
        ${item.tags.filter(Boolean).map((tag) => `<span>${esc(tag)}</span>`).join("")}
        ${item.sizeBytes ? `<span>${esc(fmtBytes(item.sizeBytes))}</span>` : ""}
        ${item.updatedAt ? `<span>${esc(fmtDateTime(item.updatedAt))}</span>` : ""}
      </div>

      <h4 class="os20-mk-h4">权限</h4>
      ${permissionList(item)}

      <h4 class="os20-mk-h4">安装流程</h4>
      ${stepList(
        steps.length
          ? steps
          : [
              { id: "resolve", label: STEP_LABEL.resolve, status: "pending" },
              { id: "source", label: STEP_LABEL.source, status: "pending" },
              { id: "version", label: STEP_LABEL.version, status: "pending" },
              { id: "compat", label: STEP_LABEL.compat, status: "pending" },
              { id: "manifest", label: STEP_LABEL.manifest, status: "pending" },
              { id: "permissions", label: STEP_LABEL.permissions, status: "pending" },
              { id: "download", label: STEP_LABEL.download, status: "pending" },
              { id: "verify", label: STEP_LABEL.verify, status: "pending" },
              { id: "install", label: STEP_LABEL.install, status: "pending" },
              { id: "register", label: STEP_LABEL.register, status: "pending" },
            ],
      )}

      ${state.outcome ? `<p class="os20-mk-outcome ${state.outcome.ok ? "is-ok" : "is-bad"}">${esc(state.outcome.message)}</p>` : ""}

      <div class="os20-mk-cta">
        ${
          item.installed
            ? `<button class="g14-btn" type="button" data-open-app="${esc(item.id)}">打开 / 使用</button>
               ${
                 item.kind === "app"
                   ? ""
                   : `<button class="g14-btn is-ghost" type="button" data-uninstall="${esc(keyOf(item))}">移除</button>`
               }`
            : `<button class="g14-btn is-primary" type="button" data-install="${esc(keyOf(item))}" ${precheck && !precheck.ok ? "disabled" : ""}>
                ${precheck && !precheck.ok ? "不可安装" : "安装"}
               </button>`
        }
        <button class="g14-btn is-ghost" type="button" data-close-detail>关闭详情</button>
      </div>
      ${precheck && !precheck.ok ? `<p class="g14-hint">${esc(precheck.message)}</p>` : ""}
    </aside>`;
};

const list = () => {
  if (!hub) return "";
  const items = hub.search(state.query, state.kind);
  if (!items.length) {
    return `<div class="g14-empty"><span class="g14-empty-ico">◌</span><p class="g14-empty-title">没有匹配的资源</p><p class="g14-empty-sub">换个关键词，或者到别的分类看看。</p></div>`;
  }
  return `<div class="os20-mk-grid">${items.map(card).join("")}</div>`;
};

const body = () => {
  const counts: Record<Kind, number> = (hub?.counts() ?? { all: 0 }) as Record<Kind, number>;
  const selected = state.selected && hub ? hub.search("", "all").find((item) => keyOf(item) === state.selected) : null;
  return `
    <div class="g14-scroll">
      <div class="g14-pane-head">
        <h3>应用与资源市场</h3>
        <p>应用、插件、主题、组件、壁纸、工作空间与社区作品都在这里。安装流程统一，失败会告诉你是哪一步。</p>
      </div>

      <div class="os20-mk-toolbar">
        <div class="os20-mk-tabs">
          ${KINDS.map(
            ([kind, label, icon]) =>
              `<button class="os20-mk-tab ${state.kind === kind ? "is-active" : ""}" type="button" data-kind="${kind}">
                <span>${icon}</span>${esc(label)}<i>${counts[kind] ?? 0}</i>
              </button>`,
          ).join("")}
        </div>
        <div class="os20-mk-search">
          <input type="search" placeholder="搜索名称、作者或标签" value="${esc(state.query)}" data-mk-search />
          <button class="g14-btn is-ghost" type="button" data-mk-remote ${state.remoteBusy ? "disabled" : ""}>
            ${state.remoteBusy ? "读取中…" : state.remoteLoaded ? "刷新市场" : "读取插件与社区"}
          </button>
        </div>
      </div>

      ${
        state.remoteErrors.length
          ? `<div class="os20-note is-warn"><p>${state.remoteErrors.map((error) => esc(error)).join("；")}</p><p>本地资源不受影响。</p></div>`
          : ""
      }

      <div class="os20-mk-layout">
        <div class="os20-mk-list">${list()}</div>
        ${selected ? detail(selected) : `<aside class="os20-mk-detail is-empty"><p>选择左侧任意一张卡片查看详情。</p><p class="g14-hint">安装前会依次检查来源、版本、兼容性、Manifest 与权限。</p></aside>`}
      </div>
    </div>`;
};

const consentModal = () => {
  const item = state.consent.item;
  if (!item) return "";
  const permissionRows = state.consent.permissions
    .map(
      (permission) => `
      <label class="os20-consent-row">
        <input type="checkbox" data-consent-perm="${esc(permission)}" checked />
        <span><b>${esc(permission)}</b><i>${riskOf(permission) === "high" ? "高风险：可能访问你的文件、网络或云端数据" : "中风险：读取你主动选择的内容"}</i></span>
      </label>`,
    )
    .join("");

  return `
    <div class="os20-modal" role="dialog" aria-modal="true">
      <div class="os20-modal-card">
        <h3>「${esc(item.name)}」需要这些权限</h3>
        <p class="g14-hint">逐项确认。不勾选的权限不会被授予，相关功能会不可用，但不会影响安装。</p>
        <div class="os20-consent">${permissionRows}</div>
        <div class="os20-modal-actions">
          <button class="g14-btn is-ghost" type="button" data-consent-cancel>取消</button>
          <button class="g14-btn is-primary" type="button" data-consent-ok>确认并安装</button>
        </div>
      </div>
    </div>`;
};

const installOverlay = () => {
  if (!state.installing) return "";
  return `
    <div class="os20-modal" role="dialog" aria-modal="true">
      <div class="os20-modal-card">
        <h3>正在安装</h3>
        ${stepList(state.installing.steps)}
        <div class="os20-modal-actions">
          <button class="g14-btn is-ghost" type="button" data-install-close ${state.outcome ? "" : "disabled"}>${state.outcome ? "完成" : "安装中…"}</button>
        </div>
      </div>
    </div>`;
};

export const renderMarket = () =>
  shell("market", KINDS.map(([id, label, icon]) => [id, label, icon]), `<div data-mk-host></div>`, "市场");

export const initMarket = (win: HTMLElement, ctx: Ctx, sys: Sys): (() => void) => {
  ctxRef = ctx;
  const os20 = getOs20();
  if (!os20) {
    const host = win.querySelector<HTMLElement>("[data-mk-host]");
    if (host) host.innerHTML = `<div class="g14-empty"><p class="g14-empty-title">内核尚未就绪</p><p class="g14-empty-sub">2.0 市场依赖 Guandao Core，请刷新页面。</p></div>`;
    return () => undefined;
  }

  hub = createHub(ctx, sys, os20.kernel);
  const host = win.querySelector<HTMLElement>("[data-mk-host]");
  if (!host) return () => undefined;

  const paint = () => {
    refreshData();
    host.innerHTML = body();
    // 模态层挂在窗口内部，避免被窗口裁剪
    const existing = win.querySelector(".os20-modal");
    existing?.remove();
    if (state.consent.open) host.insertAdjacentHTML("beforeend", consentModal());
    if (state.installing) host.insertAdjacentHTML("beforeend", installOverlay());
  };

  const findItem = (key: string): MarketItem | null => {
    if (!hub) return null;
    return hub.items("all").find((item) => keyOf(item) === key) ?? null;
  };

  const runInstall = async (item: MarketItem) => {
    if (!hub) return;
    const precheck = hub.installer.precheck(item);
    if (precheck.needsConsent.length) {
      state.consent = {
        open: true,
        item,
        permissions: precheck.needsConsent,
        accepted: false,
      };
      paint();
      return;
    }
    await executeInstall(item, { accepted: true, permissions: [] });
  };

  const executeInstall = async (item: MarketItem, consent: { accepted: boolean; permissions: string[] }) => {
    if (!hub) return;
    state.consent = { open: false, item: null, permissions: [], accepted: false };
    state.outcome = null;
    state.installing = { id: keyOf(item), steps: [] };
    paint();

    const outcome = await hub.installer.install(item, consent, (steps) => {
      if (state.installing) {
        state.installing.steps = steps;
        // 只重绘流程区，避免整页闪烁
        const overlay = win.querySelector<HTMLElement>(".os20-modal .os20-steps");
        if (overlay) overlay.outerHTML = stepList(steps);
      }
    });

    state.installing = null;
    state.outcome = outcome;
    if (outcome.ok) {
      ctx.toast(outcome.message);
      // 重新渲染，让「已安装」状态立即生效
      hub = createHub(ctx, sys, os20!.kernel);
    } else {
      ctx.toast(outcome.message);
    }
    paint();
  };

  host.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;

    const kindButton = target.closest<HTMLElement>("[data-kind]");
    if (kindButton) {
      state.kind = (kindButton.dataset.kind as Kind) ?? "all";
      state.selected = "";
      state.outcome = null;
      paint();
      return;
    }

    const itemCard = target.closest<HTMLElement>("[data-item]");
    if (itemCard && !target.closest("[data-install]")) {
      state.selected = itemCard.dataset.item ?? "";
      state.outcome = null;
      paint();
      return;
    }

    if (target.closest("[data-close-detail]")) {
      state.selected = "";
      state.outcome = null;
      paint();
      return;
    }

    const installButton = target.closest<HTMLElement>("[data-install]");
    if (installButton) {
      const item = findItem(installButton.dataset.install ?? "");
      if (item) void runInstall(item);
      return;
    }

    const uninstallButton = target.closest<HTMLElement>("[data-uninstall]");
    if (uninstallButton && hub) {
      const item = findItem(uninstallButton.dataset.uninstall ?? "");
      if (!item) return;
      void hub.uninstall(item).then((result) => {
        ctx.toast(result.message);
        hub = createHub(ctx, sys, os20.kernel);
        paint();
      });
      return;
    }

    const openApp = target.closest<HTMLElement>("[data-open-app]");
    if (openApp) {
      const id = openApp.dataset.openApp ?? "";
      ctx.openApp(id);
      return;
    }

    if (target.closest("[data-consent-cancel]")) {
      state.consent = { open: false, item: null, permissions: [], accepted: false };
      paint();
      return;
    }

    if (target.closest("[data-consent-ok]")) {
      const item = state.consent.item;
      if (!item) return;
      const permissions = Array.from(win.querySelectorAll<HTMLInputElement>("[data-consent-perm]"))
        .filter((input) => input.checked)
        .map((input) => input.dataset.consentPerm ?? "")
        .filter(Boolean);
      void executeInstall(item, { accepted: true, permissions });
      return;
    }

    if (target.closest("[data-install-close]")) {
      state.outcome = null;
      paint();
      return;
    }

    if (target.closest("[data-mk-remote]")) {
      if (!hub || state.remoteBusy) return;
      state.remoteBusy = true;
      state.remoteErrors = [];
      paint();
      void hub.refreshRemote().then((result) => {
        state.remoteBusy = false;
        state.remoteLoaded = true;
        state.remoteErrors = result.errors;
        paint();
        ctx.toast(`已读取 ${result.plugins} 个插件与 ${result.community} 个社区作品`);
      });
      return;
    }
  });

  host.addEventListener("input", (event) => {
    const search = (event.target as HTMLElement).closest<HTMLInputElement>("[data-mk-search]");
    if (!search) return;
    state.query = search.value;
    refreshData();
    const listHost = host.querySelector<HTMLElement>(".os20-mk-list");
    if (listHost) listHost.innerHTML = list();
  });

  bindTabs(win, (next) => {
    if (KINDS.some(([id]) => id === next)) {
      state.kind = next as Kind;
      state.selected = "";
      paint();
    }
  });

  paint();
  return () => {
    hub = null;
    ctxRef = null;
  };
};