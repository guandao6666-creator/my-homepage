/**
 * Guandao OS 1.7 · 插件管理器
 *
 * 只展示真实状态：版本、授权、运行上下文数量、存储占用、运行日志。
 * 每个按钮都调用注册中心里的真实动作，没有「仅改变 UI」的假开关。
 */

// 1.9：应用样式跟着应用代码一起按需加载，不再压进首屏 CSS
import "../../styles/plugins.css";
import { escapeHtml, shell, type Ctx } from "../os14/core";
import * as api from "./api";
import * as registry from "./registry";
import { getInstall, listInstalls, storageUsage } from "./store";
import { sessionCount } from "./host";
import { openPalette } from "./commands";
import { trustDetail, trustLabel, trustOf } from "./signature";
import {
  esc,
  fmtBytes,
  fmtNumber,
  loginGate,
  openDialog,
  pluginGlyph,
  promptLogin,
  recordStatus,
  requestPermissions,
  requestUninstall,
  statusChip,
  timeAgo,
  typeLabel,
} from "./ui-kit";

type Tab = "installed" | "updates" | "official" | "runtime" | "policy";

const NAV: Array<[string, string, string]> = [
  ["installed", "已安装", "▣"],
  ["updates", "可更新", "↑"],
  ["official", "官方示例", "◎"],
  ["runtime", "运行状态", "◉"],
  ["policy", "安全策略", "⚙"],
];

export const renderPluginManager = () =>
  shell(
    "pm",
    NAV,
    `<div class="gp-app" data-gp-manager>
      <header class="gp-top">
        <div class="gp-top-title">
          <p class="gp-eyebrow">Guandao OS 1.7</p>
          <h2>Plugin Manager</h2>
          <p class="gp-top-sub" data-gp-summary>正在读取本地安装记录…</p>
        </div>
        <div class="gp-top-actions">
          <button type="button" class="gp-btn" data-act="market">插件市场</button>
          <button type="button" class="gp-btn" data-act="check-updates">检查更新</button>
        </div>
      </header>
      <div class="gp-body" data-gp-body>
        <div class="gp-skeleton">正在读取插件状态…</div>
      </div>
    </div>`,
    "Plugin Manager",
  );

export const initPluginManager = (win: HTMLElement, ctx: Ctx): (() => void) => {
  const body = win.querySelector<HTMLElement>("[data-gp-body]");
  const summary = win.querySelector<HTMLElement>("[data-gp-summary]");
  if (!body) return () => undefined;

  let tab: Tab = "installed";
  let detailId = "";
  let busy = false;
  let official: Awaited<ReturnType<typeof registry.officialCatalog>> | null = null;

  const setSummary = () => {
    if (!summary) return;
    const records = listInstalls();
    const enabled = records.filter((record) => record.enabled && !record.blocked).length;
    const updates = registry.pendingUpdates().length;
    const running = records.reduce((sum, record) => sum + sessionCount(record.id), 0);
    summary.textContent = `${records.length} 个已安装 · ${enabled} 个启用 · ${updates} 个可更新 · ${running} 个运行上下文`;
  };

  const fail = (error: unknown) => {
    const message = error instanceof api.PluginApiError || error instanceof Error ? error.message : "操作失败";
    ctx.toast(message);
    registry.installedRecords();
  };

  const run = async (action: string, id: string) => {
    if (busy) return;
    const record = id ? getInstall(id) : null;
    try {
      switch (action) {
        case "tab":
          tab = id as Tab;
          detailId = "";
          if (tab === "updates") await registry.checkForUpdates();
          if (tab === "official") official = await registry.officialCatalog();
          paint();
          return;

        case "back":
          detailId = "";
          paint();
          return;

        case "open-detail":
          if (!id) return;
          detailId = id;
          paint();
          return;

        case "market":
          ctx.openApp("pmarket");
          return;

        case "check-updates": {
          busy = true;
          const list = await registry.checkForUpdates();
          busy = false;
          ctx.toast(list.length ? `有 ${list.length} 个插件可以更新` : "所有插件都是最新版本");
          paint();
          return;
        }

        case "open-app": {
          if (!record) return;
          if (record.blocked) {
            ctx.toast("插件已被安全下架");
            return;
          }
          if (!record.enabled) {
            ctx.toast("插件已禁用，先启用再打开");
            return;
          }
          if (record.type === "theme") {
            registry.applyThemePlugin(record.id);
            return;
          }
          if (record.type === "widget") {
            if (!record.granted.includes("desktop.add_widget")) {
              ctx.toast("缺少「添加桌面组件」权限，先去权限里授权");
              return;
            }
            ctx.widgets.setEnabled(registry.pluginWidgetId(record.id), true);
            ctx.toast(`已把「${record.name}」放到桌面`);
            return;
          }
          if (record.type === "command") {
            openPalette();
            return;
          }
          ctx.openApp(registry.pluginAppId(record.id));
          return;
        }

        case "toggle":
          if (!record) return;
          try {
            await registry.setPluginEnabled(record.id, !record.enabled);
          } catch (error) {
            ctx.toast(error instanceof Error ? error.message : "启用失败");
          }
          paint();
          return;

        case "widget-off": {
          if (!record) return;
          ctx.widgets.setEnabled(registry.pluginWidgetId(record.id), false);
          ctx.toast("已从桌面移除组件");
          return;
        }

        case "update": {
          if (!record) return;
          try {
            await registry.updatePlugin(record.id);
          } catch (error) {
            if (error instanceof registry.PluginConsentRequired) {
              const granted = await requestPermissions(win, {
                manifest: error.manifest!,
                mode: "update",
                added: error.added,
                granted: record.granted,
              });
              if (!granted) return;
              await registry.updatePlugin(record.id, granted);
            } else {
              throw error;
            }
          }
          paint();
          return;
        }

        case "rollback": {
          if (!record || !record.previousVersion) return;
          const { result } = openDialog(win, {
            title: "回退版本",
            subtitle: `${record.name} v${record.version} → v${record.previousVersion}`,
            body: `<p class="gp-dialog-para">回退会重新下载并校验上一个版本，然后停止当前运行上下文。新版本才有的权限会被撤销。</p>
              <p class="gp-dialog-hint">插件自己的数据不会被覆盖。</p>`,
            actions: [
              { label: "取消", value: "" },
              { label: `回退到 v${record.previousVersion}`, value: "ok", primary: true },
            ],
          });
          if ((await result) !== "ok") return;
          await registry.rollbackPlugin(record.id);
          paint();
          return;
        }

        case "permissions": {
          if (!record) return;
          const granted = await requestPermissions(win, {
            manifest: record.manifest,
            mode: "manage",
            granted: record.granted,
          });
          if (!granted) return;
          await registry.saveGrantedPermissions(record.id, granted);
          ctx.toast("权限已更新，运行中的上下文已重启");
          paint();
          return;
        }

        case "uninstall": {
          if (!record) return;
          const choice = await requestUninstall(win, record);
          if (!choice.ok) return;
          await registry.uninstallPlugin(record.id, choice.keepData);
          detailId = "";
          paint();
          return;
        }

        case "install-official": {
          const item = official?.find((entry) => entry.manifest.id === id);
          if (!item) return;
          if (!item.installed) {
            const granted = await requestPermissions(win, { manifest: item.manifest, mode: "install" });
            if (!granted) return;
            await registry.installOfficialPlugin(id, granted);
          } else {
            ctx.toast("这个插件已经安装");
          }
          official = await registry.officialCatalog();
          tab = "official";
          paint();
          return;
        }

        case "docs":
          window.open("/developers/", "_blank", "noopener");
          return;

        case "sync":
          ctx.toast("正在重新读取云端安装记录…");
          paint();
          return;

        default:
          return;
      }
    } catch (error) {
      busy = false;
      fail(error);
      paint();
    }
  };

  const actionButton = (action: string, id: string, label: string, tone = "") =>
    `<button type="button" class="gp-btn${tone ? ` ${tone}` : ""}" data-act="${esc(action)}" data-id="${esc(id)}">${esc(label)}</button>`;

  const listView = () => {
    const records = listInstalls();
    if (tab === "installed" && !records.length) {
      return `<div class="gp-empty">
        <span class="gp-empty-ico">▣</span>
        <b>还没有安装任何插件</b>
        <p>到插件市场发现新能力，或者先装一个官方示例看看沙箱是怎么跑起来的。</p>
        <div class="gp-empty-actions">
          ${actionButton("market", "", "打开插件市场", "is-primary")}
          ${actionButton("tab", "official", "浏览官方示例")}
        </div>
      </div>`;
    }

    if (tab === "installed") {
      // 修复：此前「已安装」在有记录时会一路落到函数末尾的 policy 分支，
      // 用户看不到自己的插件列表，也进不了详情 / 权限 / 卸载入口。
      return `<div class="gp-hintbar">签名状态来自安装时的客户端验签结果：已签名表示发布者身份经 Ed25519 验证；未签名是旧版插件的兼容行为；签名无效的包不会被装进系统。</div>
        <div class="gp-list">${records
          .map((record) => {
            const update = registry.updateTarget(record.id);
            const trust = trustOf(record);
            return `<article class="gp-row">
              ${pluginGlyph(record.name, record.type, "", record.iconUrl)}
              <div class="gp-row-main">
                <div class="gp-row-title"><b>${esc(record.name)}</b>
                  ${statusChip(record)}
                  <span class="gp-chip ${trust === "verified" ? "is-ok" : trust === "invalid" ? "is-danger" : "is-warn"}" title="${esc(trustDetail(trust, record.signature?.keyId))}">${esc(trustLabel(trust))}</span>
                </div>
                <p class="gp-row-sub">v${esc(record.version)} · ${esc(record.author)} · ${record.permissions.length} 项权限 · 安装于 ${timeAgo(record.installedAt)}</p>
                <p class="gp-row-desc">${esc(record.description).slice(0, 140)}</p>
                <div class="gp-row-actions">
                  ${actionButton("open-detail", record.id, "管理")}
                  ${update ? actionButton("update", record.id, `更新到 v${update.version}`, "is-warn") : ""}
                  ${actionButton("toggle", record.id, record.enabled ? "禁用" : "启用")}
                </div>
              </div>
            </article>`;
          })
          .join("")}</div>`;
    }

    if (tab === "updates") {
      const pending = registry.pendingUpdates();
      if (!pending.length) {
        return `<div class="gp-empty">
          <span class="gp-empty-ico">✓</span>
          <b>没有待更新的插件</b>
          <p>更新检查读取的是服务端已审核版本，不会把草稿或未审核版本当作可用更新。</p>
          ${actionButton("check-updates", "", "再检查一次")}
        </div>`;
      }
      return `<div class="gp-list">${pending
        .map((card) => {
          const record = getInstall(card.id);
          return `<article class="gp-row">
            ${pluginGlyph(card.name, card.type, "", card.iconUrl)}
            <div class="gp-row-main">
              <div class="gp-row-title"><b>${esc(card.name)}</b><span class="gp-chip is-warn">可更新</span></div>
              <p class="gp-row-sub">v${esc(record?.version ?? "—")} → v${esc(card.version)} · ${esc(card.author.name)}</p>
              <p class="gp-row-desc">${esc(card.description).slice(0, 140)}</p>
              <div class="gp-row-actions">
                ${record ? actionButton("update", record.id, "更新", "is-primary") : ""}
                ${record ? actionButton("open-detail", record.id, "详情") : ""}
              </div>
            </div>
          </article>`;
        })
        .join("")}</div>`;
    }

    if (tab === "official") {
      const items = official ?? [];
      return `<div class="gp-hintbar">官方示例与第三方插件走完全相同的 Manifest、权限与沙箱流程，只是插件包内置在系统里，不需要联网下载。</div>
        <div class="gp-list">${items
          .map((item) => {
            const manifest = item.manifest;
            return `<article class="gp-row">
              ${pluginGlyph(manifest.name, manifest.type, item.accent)}
              <div class="gp-row-main">
                <div class="gp-row-title"><b>${esc(manifest.name)}</b>
                  <span class="gp-chip is-accent">官方</span>
                  <span class="gp-chip">${esc(typeLabel(manifest.type))}</span>
                  ${item.installed ? '<span class="gp-chip is-ok">已安装</span>' : ""}
                </div>
                <p class="gp-row-sub">v${esc(manifest.version)} · Guandao Studio · ${manifest.permissions.length} 项权限</p>
                <p class="gp-row-desc">${esc(manifest.description)}</p>
                <div class="gp-row-actions">
                  ${item.installed ? actionButton("open-detail", manifest.id, "管理") : actionButton("install-official", manifest.id, "安装", "is-primary")}
                </div>
              </div>
            </article>`;
          })
          .join("")}</div>`;
    }

    if (tab === "runtime") {
      return `<div class="gp-hintbar">浏览器不会向网页暴露每个 iframe 的真实 CPU / 内存占用。这里只展示可观测指标：运行上下文数量、存储占用、请求与错误日志；不伪造精确数值。</div>
        <div class="gp-runtime">
          ${records
            .map((record) => {
              const usage = storageUsage(record.id);
              const running = sessionCount(record.id);
              const last = record.logs[record.logs.length - 1];
              return `<article class="gp-runtime-row">
                <div class="gp-runtime-head">
                  <b>${esc(record.name)}</b>
                  ${statusChip(record)}
                  <span class="gp-chip">${running} 个上下文</span>
                </div>
                <div class="gp-runtime-grid">
                  <span>存储</span><b>${fmtBytes(usage.bytes)} / ${fmtBytes(256 * 1024)}（${usage.keys} 键）</b>
                  <span>版本</span><b>v${esc(record.version)}</b>
                  <span>最近日志</span><b>${last ? esc(last.message) : "暂无"}</b>
                </div>
              </article>`;
            })
            .join("") || '<p class="gp-muted">还没有安装插件。</p>'}
        </div>`;
    }

    return `<div class="gp-policy">
      <section class="gp-policy-card">
        <h3>默认拒绝</h3>
        <p>Manifest 没有声明的权限，插件在运行时永远拿不到；即使声明了，用户不勾选也不会授予。撤销权限后，正在运行的上下文会被销毁，下一次调用直接返回 PERMISSION_DENIED。</p>
      </section>
      <section class="gp-policy-card">
        <h3>独立沙箱</h3>
        <p>插件运行在 <code>sandbox="allow-scripts"</code> 的 iframe 中，没有同源权限：读不到主页面 DOM、Cookie、localStorage，也不能直接访问 D1 / R2。通信只走受控的 MessageChannel，宿主按 iframe 实例建立会话，不采信插件自报的身份。</p>
      </section>
      <section class="gp-policy-card">
        <h3>可审计</h3>
        <p>每个版本都有 SHA-256 包校验值与文件清单摘要；市场安装只接受审核通过的版本。审核、下架、权限变更都会写入服务端审计日志。</p>
      </section>
      <section class="gp-policy-card">
        <h3>边界</h3>
        <p>插件存储上限 ${fmtBytes(256 * 1024)}，单次请求 24 KB，每分钟 60 次调用，通知每分钟 5 条。浏览器无法可靠提供 CPU / 内存统计，系统不会为此编造数字。</p>
      </section>
      <div class="gp-policy-actions">
        ${actionButton("docs", "", "阅读开发者文档", "is-primary")}
      </div>
    </div>`;
  };

  const detailView = (record: ReturnType<typeof getInstall>) => {
    if (!record) return listView();
    const update = registry.updateTarget(record.id);
    const usage = storageUsage(record.id);
    const running = sessionCount(record.id);
    const status = recordStatus(record);
    const trust = trustOf(record);
    const trustTone = trust === "verified" ? "is-ok" : trust === "invalid" ? "is-danger" : "is-warn";
    const canOpen = ["application", "integration", "file-handler", "widget", "command", "theme"].includes(record.type);

    return `<div class="gp-detail">
      <button type="button" class="gp-back" data-act="back">← 返回列表</button>
      <header class="gp-detail-head">
        ${pluginGlyph(record.name, record.type, "", record.iconUrl)}
        <div class="gp-detail-title">
          <div class="gp-detail-name">
            <h2>${esc(record.name)}</h2>
            <span class="gp-chip">${esc(typeLabel(record.type))}</span>
            <span class="gp-chip is-${status.tone}">${status.label}</span>
            <span class="gp-chip ${trustTone}" title="${esc(trustDetail(trust, record.signature?.keyId))}">${esc(trustLabel(trust))}</span>
            ${record.source === "official" ? '<span class="gp-chip is-accent">官方</span>' : ""}
          </div>
          <p class="gp-detail-sub">v${esc(record.version)} · ${esc(record.author)} · 安装于 ${timeAgo(record.installedAt)}</p>
          <p class="gp-detail-desc">${esc(record.description)}</p>
        </div>
      </header>

      <div class="gp-detail-actions">
        ${canOpen ? actionButton("open-app", record.id, record.type === "theme" ? "应用主题" : record.type === "widget" ? "放到桌面" : record.type === "command" ? "打开命令面板" : "打开", "is-primary") : ""}
        ${record.type === "widget" ? actionButton("widget-off", record.id, "从桌面移除") : ""}
        ${update ? actionButton("update", record.id, `更新到 v${update.version}`, "is-warn") : ""}
        ${record.previousVersion ? actionButton("rollback", record.id, `回退到 v${record.previousVersion}`) : ""}
        ${actionButton("toggle", record.id, record.enabled ? "禁用" : "启用")}
        ${actionButton("permissions", record.id, "权限")}
        ${actionButton("uninstall", record.id, "卸载", "is-danger")}
      </div>

      <div class="gp-detail-grid">
        <section class="gp-card">
          <h3>安装信息</h3>
          <dl class="gp-kv">
            <div><dt>来源</dt><dd>${record.source === "official" ? "官方内置" : record.source === "market" ? "插件市场" : "本地开发"}</dd></div>
            <div><dt>兼容系统</dt><dd>≥ ${esc(record.manifest.compatibility.minimumOSVersion)} · SDK ${record.manifest.compatibility.sdkVersion}</dd></div>
            <div><dt>包校验值</dt><dd><code title="${esc(record.packageHash)}">${esc(record.packageHash.slice(0, 20))}…</code></dd></div>
            <div><dt>文件摘要</dt><dd><code title="${esc(record.filesDigest)}">${esc(record.filesDigest.slice(0, 20))}…</code></dd></div>
            <div><dt>发布者签名</dt><dd>${esc(trustDetail(trust, record.signature?.keyId))}${record.signature?.signedAt ? `<br><span class="gp-muted">签署于 ${timeAgo(record.signature.signedAt)}</span>` : ""}</dd></div>
            <div><dt>运行上下文</dt><dd>${running} 个</dd></div>
            <div><dt>插件存储</dt><dd>${fmtBytes(usage.bytes)} · ${usage.keys} 个键</dd></div>
            <div><dt>最近更新</dt><dd>${timeAgo(record.updatedAt)}</dd></div>
            <div><dt>许可证</dt><dd>${esc(record.manifest.license)}</dd></div>
          </dl>
        </section>

        <section class="gp-card">
          <h3>权限（${record.granted.length}/${record.permissions.length}）</h3>
          <ul class="gp-perm-list">
            ${record.permissions
              .map((permission) => {
                const meta = record.manifest.permissions.includes(permission);
                const granted = record.granted.includes(permission);
                return `<li class="${granted ? "is-on" : "is-off"}"><span>${esc(permission)}</span><b>${granted ? "已授权" : "未授权"}</b></li>`;
              })
              .join("") || '<li class="is-off"><span>没有申请权限</span><b>—</b></li>'}
          </ul>
          <p class="gp-note">权限撤销后立即生效；插件下一次调用会收到 PERMISSION_DENIED。</p>
        </section>
      </div>

      <section class="gp-card">
        <h3>运行日志（最近 ${record.logs.length} 条）</h3>
        <div class="gp-logs">
          ${record.logs
            .slice()
            .reverse()
            .map(
              (log) =>
                `<div class="gp-log is-${log.level}"><time>${new Date(log.at).toLocaleTimeString("zh-CN", { hour12: false })}</time><span>${esc(log.message)}</span></div>`,
            )
            .join("") || '<p class="gp-muted">还没有日志。</p>'}
        </div>
      </section>
    </div>`;
  };

  const paint = () => {
    setSummary();
    win.querySelectorAll<HTMLElement>(".g14-nav").forEach((node) => {
      node.classList.toggle("is-active", node.dataset.tab === tab);
    });
    if (detailId && getInstall(detailId)) {
      body.innerHTML = detailView(getInstall(detailId));
      return;
    }
    detailId = "";
    body.innerHTML = listView();
  };

  body.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const action = target.closest<HTMLElement>("[data-act]");
    if (action) {
      event.preventDefault();
      event.stopPropagation();
      void run(action.dataset.act ?? "", action.dataset.id ?? "");
      return;
    }
    if (target.closest("[data-gp-login]")) {
      promptLogin();
    }
  });

  win.addEventListener("click", (event) => {
    const nav = (event.target as HTMLElement).closest<HTMLElement>(".g14-nav[data-tab]");
    if (!nav) return;
    const next = nav.dataset.tab as Tab;
    if (!NAV.some(([key]) => key === next)) return;
    void run("tab", next);
  });

  const onChange = () => {
    if (!getInstall(detailId)) detailId = "";
    paint();
  };
  window.addEventListener("guandao:plugins-change", onChange);

  void (async () => {
    official = await registry.officialCatalog();
    await registry.checkForUpdates();
    paint();
  })();

  paint();
  return () => window.removeEventListener("guandao:plugins-change", onChange);
};
