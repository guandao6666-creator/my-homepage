/**
 * Guandao OS 1.7 · 插件市场
 *
 * 与 1.6 Community 共用同一套账号与内容体系：
 *   - 浏览公开插件不需要登录；安装、评价、举报需要 Guandao Account；
 *   - 下载量、安装量、评分全部来自服务端真实记录，没有随机数；
 *   - 只展示 status=published 且版本审核通过的插件；
 *   - 官方示例单独一栏，标注「官方内置」，不与市场数据混淆。
 */

import { safeUrl } from "../html";
import { trustDetail, trustLabel } from "./signature";
import { escapeHtml, shell, type Ctx } from "../os14/core";
import * as api from "./api";
import * as registry from "./registry";
import { getInstall } from "./store";
import {
  esc,
  fmtNumber,
  loginGate,
  openDialog,
  openProgress,
  pluginGlyph,
  promptLogin,
  promptText,
  requestPermissions,
  riskChip,
  timeAgo,
  typeLabel,
} from "./ui-kit";

type Sort = "latest" | "trending" | "downloads" | "rating";

const NAV: Array<[string, string, string]> = [
  ["discover", "发现", "◈"],
  ["productivity", "效率", "▤"],
  ["system", "系统工具", "⚙"],
  ["entertainment", "娱乐", "♫"],
  ["education", "教育", "✎"],
  ["creative", "创意", "◑"],
  ["developer", "开发工具", "⌘"],
  ["official", "官方示例", "◎"],
];

const CATEGORY_OF: Record<string, string> = {
  productivity: "productivity",
  system: "system",
  entertainment: "entertainment",
  education: "education",
  creative: "creative",
  developer: "developer",
};

const INSTALL_STEPS = ["下载插件包", "校验清单与摘要", "写入本地存储", "登记安装记录", "注册到桌面"];

/** 发布者签名徽标：已签名 / 未签名 / 签名无效，与安全审核徽标并列展示。 */
function signatureChip(trust: { status?: string; keyId?: string | null } | undefined): string {
  const status = trust?.status;
  const label = trustLabel(status as "verified" | "unsigned" | "invalid" | undefined);
  const hint = trustDetail(status as "verified" | "unsigned" | "invalid" | undefined, trust?.keyId ?? null);
  const tone = status === "verified" ? " is-ok" : status === "invalid" ? " is-warn" : "";
  return `<span class="gp-chip${tone}" title="${esc(hint)}">${esc(label)}</span>`;
}

export const renderPluginMarket = () =>
  shell(
    "pmarket",
    NAV,
    `<div class="gp-app" data-gp-market>
      <header class="gp-top">
        <div class="gp-top-title">
          <p class="gp-eyebrow">Plugin Market</p>
          <h2>发现插件</h2>
          <p class="gp-top-sub" data-gp-market-sub>正在连接插件目录…</p>
        </div>
        <div class="gp-search">
          <span>⌕</span>
          <input type="search" data-gp-search placeholder="搜索插件、作者、能力…" maxlength="40" autocomplete="off" />
        </div>
      </header>
      <div class="gp-market-tabs">
        <div class="gp-seg" data-gp-sort>
          <button type="button" class="is-active" data-sort="latest">最新</button>
          <button type="button" data-sort="trending">趋势</button>
          <button type="button" data-sort="downloads">下载最多</button>
          <button type="button" data-sort="rating">评分最高</button>
        </div>
        <span class="gp-market-note">所有数据来自真实安装与评价记录</span>
      </div>
      <div class="gp-body" data-gp-body>
        <div class="gp-skeleton">正在读取插件目录…</div>
      </div>
    </div>`,
    "Plugin Market",
  );

export const initPluginMarket = (win: HTMLElement, ctx: Ctx): (() => void) => {
  const body = win.querySelector<HTMLElement>("[data-gp-body]");
  const sub = win.querySelector<HTMLElement>("[data-gp-market-sub]");
  const search = win.querySelector<HTMLInputElement>("[data-gp-search]");
  if (!body) return () => undefined;

  let tab = "discover";
  let sort: Sort = "latest";
  let query = "";
  let page = 1;
  let meta: api.PluginMeta | null = null;
  let items: api.PluginCard[] = [];
  let total = 0;
  let loading = false;
  let detail: api.PluginDetail | null = null;
  let reviews: Awaited<ReturnType<typeof api.listReviews>> | null = null;
  let official: Awaited<ReturnType<typeof registry.officialCatalog>> | null = null;
  let offline = "";
  let searchTimer = 0;

  const setSub = (text: string) => {
    if (sub) sub.textContent = text;
  };

  const ensureMeta = async () => {
    if (meta) return meta;
    try {
      meta = await api.getMeta();
      offline = "";
      return meta;
    } catch (error) {
      offline = error instanceof Error ? error.message : "插件目录暂时不可用";
      return null;
    }
  };

  const loadList = async () => {
    loading = true;
    paint();
    try {
      if (tab === "official") {
        official = await registry.officialCatalog();
        items = [];
        total = official.length;
        setSub(`官方内置 ${official.length} 个示例 · 与第三方插件同一套校验与沙箱`);
      } else {
        await ensureMeta();
        if (offline) {
          items = [];
          total = 0;
          setSub("插件目录不可用");
        } else {
          const result = await api.listPlugins({
            tab: tab === "discover" ? "latest" : "latest",
            category: CATEGORY_OF[tab] ?? "",
            q: query,
            sort,
            page,
            limit: 12,
          });
          items = result.items;
          total = result.total;
          setSub(
            query
              ? `“${query}” 找到 ${total} 个插件`
              : `${total} 个已发布插件 · ${meta?.stats.installations ?? 0} 次安装 · ${meta?.stats.downloads ?? 0} 次下载`,
          );
        }
      }
    } catch (error) {
      offline = error instanceof Error ? error.message : "读取失败";
      setSub("插件目录读取失败");
    } finally {
      loading = false;
      paint();
    }
  };

  const openDetail = async (id: string) => {
    body.innerHTML = `<div class="gp-skeleton">正在读取插件详情…</div>`;
    try {
      detail = await api.getPlugin(id);
      reviews = await api.listReviews(id, 1).catch(() => null);
      paint();
    } catch (error) {
      detail = null;
      body.innerHTML = `<div class="gp-empty"><span class="gp-empty-ico">!</span><b>无法打开这个插件</b><p>${esc(
        error instanceof Error ? error.message : "未知错误",
      )}</p><button class="gp-btn" data-act="back">返回列表</button></div>`;
    }
  };

  const openInstalled = (id: string) => {
    const record = getInstall(id);
    if (!record) return;
    if (!record.enabled) {
      ctx.toast("插件已禁用，请到插件管理器启用");
      return;
    }
    if (record.type === "application" || record.type === "integration" || record.type === "file-handler") {
      ctx.openApp(registry.pluginAppId(id));
      return;
    }
    if (record.type === "widget") {
      ctx.widgets.setEnabled(registry.pluginWidgetId(id), true);
      ctx.toast("已放到桌面");
      return;
    }
    if (record.type === "theme") {
      registry.applyThemePlugin(id);
      return;
    }
    ctx.toast("这个插件没有可打开的窗口");
  };

  const install = async (target: api.PluginDetail) => {
    if (!meta?.viewer.id) {
      promptLogin();
      return;
    }
    const manifest = target.plugin.manifest;
    if (!target.plugin.security.audited) {
      ctx.toast("这个版本还没有通过审核，不能安装");
      return;
    }
    const granted = await requestPermissions(win, { manifest, mode: "install" });
    if (!granted) return;

    const progress = openProgress(win, `正在安装 ${target.plugin.name}`, INSTALL_STEPS);
    progress.step(0);
    try {
      await registry.installFromMarket(target, granted, (index) => {
        progress.step(index);
        progress.note(INSTALL_STEPS[index] ?? "完成");
      });
      progress.note("安装完成");
      await openDetail(target.plugin.id);
    } catch (error) {
      progress.close();
      const message = error instanceof Error ? error.message : "安装失败";
      const details = error instanceof Error && "details" in error ? (error as { details?: string[] }).details : [];
      openDialog(win, {
        title: "安装没有完成",
        body: `<p class="gp-dialog-para">${esc(message)}</p>
          ${details?.length ? `<ul class="gp-error-list">${details.map((line) => `<li>${esc(line)}</li>`).join("")}</ul>` : ""}
          <p class="gp-dialog-hint">没有写入任何安装记录；如果已经下载了插件包，也会一并清理。</p>`,
        actions: [{ label: "知道了", value: "ok", primary: true }],
      });
      return;
    }
    progress.close();
    paint();
  };

  const installOfficial = async (id: string) => {
    const item = official?.find((entry) => entry.manifest.id === id);
    if (!item) return;
    const granted = await requestPermissions(win, { manifest: item.manifest, mode: "install" });
    if (!granted) return;
    try {
      await registry.installOfficialPlugin(id, granted);
      official = await registry.officialCatalog();
      paint();
    } catch (error) {
      ctx.toast(error instanceof Error ? error.message : "安装失败");
    }
  };

  const submitReview = async (rating: number, text: string) => {
    if (!detail) return;
    try {
      await api.writeReview(detail.plugin.id, rating, text);
      reviews = await api.listReviews(detail.plugin.id, 1);
      detail = await api.getPlugin(detail.plugin.id);
      paint();
      ctx.toast("评价已保存");
    } catch (error) {
      ctx.toast(error instanceof Error ? error.message : "评价失败");
    }
  };

  const report = async () => {
    if (!detail) return;
    const { root, result } = openDialog(win, {
      title: "举报插件",
      subtitle: detail.plugin.name,
      body: `<div class="gp-field"><label>原因</label>
        <select class="gp-input" data-reason>
          <option value="malware">恶意代码 / 窃取数据</option>
          <option value="privacy">隐私问题</option>
          <option value="misleading">描述与实际不符</option>
          <option value="broken">无法运行</option>
          <option value="license">许可证问题</option>
          <option value="other">其它</option>
        </select></div>
        <div class="gp-field"><label>说明（可选）</label><textarea class="gp-input" data-detail rows="3" maxlength="1200"></textarea></div>
        <p class="gp-dialog-hint">举报会进入管理员队列，处理结果不会公开举报人身份。</p>`,
      actions: [
        { label: "取消", value: "" },
        { label: "提交举报", value: "ok", danger: true },
      ],
    });
    if ((await result) !== "ok") return;
    const reason = root.querySelector<HTMLSelectElement>("[data-reason]")?.value ?? "other";
    const text = root.querySelector<HTMLTextAreaElement>("[data-detail]")?.value ?? "";
    try {
      await api.reportPlugin(detail.plugin.id, reason, text);
      ctx.toast("已提交举报，管理员会尽快处理");
    } catch (error) {
      ctx.toast(error instanceof Error ? error.message : "举报失败");
    }
  };

  const card = (item: api.PluginCard) => `
    <article class="gp-market-card" data-open="${esc(item.id)}">
      <header>
        ${pluginGlyph(item.name, item.type, "", item.iconUrl)}
        <div class="gp-market-card-title">
          <h3>${esc(item.name)}</h3>
          <p>${esc(item.author.name)} · ${esc(typeLabel(item.type))}</p>
        </div>
        ${item.featured ? '<span class="gp-chip is-accent">推荐</span>' : ""}
      </header>
      <p class="gp-market-desc">${esc(item.description)}</p>
      <div class="gp-market-meta">
        <span>v${esc(item.version)}</span>
        <span>${fmtNumber(item.downloads)} 次下载</span>
        <span>${item.rating.count ? `${item.rating.average} 分 · ${item.rating.count} 评价` : "暂无评价"}</span>
      </div>
      <footer>
        <span class="gp-chip ${item.security.audited ? "is-ok" : "is-warn"}">${item.security.audited ? "已审核" : "未审核"}</span>
        ${signatureChip(item.security.signature)}
        ${
          item.installed
            ? `<button type="button" class="gp-btn" data-act="open" data-id="${esc(item.id)}">${item.enabled ? "打开" : "已禁用"}</button>`
            : `<button type="button" class="gp-btn is-primary" data-act="install" data-id="${esc(item.id)}">查看并安装</button>`
        }
      </footer>
    </article>`;

  const officialCard = (item: NonNullable<typeof official>[number]) => {
    const record = getInstall(item.manifest.id);
    return `<article class="gp-market-card" data-open-official="${esc(item.manifest.id)}">
      <header>
        ${pluginGlyph(item.manifest.name, item.manifest.type, item.accent)}
        <div class="gp-market-card-title">
          <h3>${esc(item.manifest.name)}</h3>
          <p>Guandao Studio · ${esc(typeLabel(item.manifest.type))}</p>
        </div>
        <span class="gp-chip is-accent">官方内置</span>
      </header>
      <p class="gp-market-desc">${esc(item.manifest.description)}</p>
      <div class="gp-market-meta">
        <span>v${esc(item.manifest.version)}</span>
        <span>${item.manifest.permissions.length} 项权限</span>
        <span>本地插件包</span>
      </div>
      <footer>
        <span class="gp-chip is-ok">与第三方同流程</span>
        ${
          item.installed
            ? `<button type="button" class="gp-btn" data-act="open" data-id="${esc(item.manifest.id)}">${record?.enabled ? "打开" : "已禁用"}</button>`
            : `<button type="button" class="gp-btn is-primary" data-act="install-official" data-id="${esc(item.manifest.id)}">安装</button>`
        }
      </footer>
    </article>`;
  };

  const listView = () => {
    if (tab === "official") {
      if (!official) return `<div class="gp-skeleton">正在读取官方示例…</div>`;
      return `<div class="gp-hintbar">官方示例也是插件：同样的 Manifest 校验、权限审批、iframe 沙箱。区别只在于插件包随系统提供，安装时不需要联网下载。</div>
        <div class="gp-market-grid">${official.map(officialCard).join("")}</div>`;
    }
    if (offline) {
      return `<div class="gp-empty">
        <span class="gp-empty-ico">!</span>
        <b>插件目录暂时不可用</b>
        <p>${esc(offline)}</p>
        <p class="gp-gate-note">市场依赖 D1 数据库与 R2 存储。你可以先安装官方示例，它们不需要联网。</p>
        <button type="button" class="gp-btn is-primary" data-act="tab" data-id="official">浏览官方示例</button>
      </div>`;
    }
    if (!meta?.viewer.id && !items.length && !loading) {
      return `${loginGate(win, "浏览插件不需要登录，但安装、评价与举报需要 Guandao Account。")}`;
    }
    if (!items.length) {
      return loading
        ? `<div class="gp-skeleton">正在读取插件目录…</div>`
        : `<div class="gp-empty"><span class="gp-empty-ico">◌</span><b>没有找到插件</b><p>换个关键词，或者到官方示例看看。</p></div>`;
    }
    const pages = Math.max(1, Math.ceil(total / 12));
    return `
      ${sort === "latest" && tab === "discover" ? `<div class="gp-market-hero">
        <div>
          <p class="gp-eyebrow">Open Desktop</p>
          <h3>扩展你的系统，做出你自己的可能。</h3>
          <p>插件运行在独立沙箱里，按需申请权限。每一个下载量、评分与安装记录都来自真实用户行为。</p>
        </div>
        <div class="gp-market-hero-stats">
          <div><b>${meta?.stats.published ?? 0}</b><span>已发布插件</span></div>
          <div><b>${meta?.stats.installations ?? 0}</b><span>安装记录</span></div>
          <div><b>${meta?.stats.downloads ?? 0}</b><span>下载次数</span></div>
        </div>
      </div>` : ""}
      <div class="gp-market-grid">${items.map(card).join("")}</div>
      ${
        pages > 1
          ? `<div class="gp-pager">
              <button type="button" class="gp-btn" data-act="page" data-id="${page - 1}" ${page <= 1 ? "disabled" : ""}>上一页</button>
              <span>第 ${page} / ${pages} 页 · 共 ${total} 个</span>
              <button type="button" class="gp-btn" data-act="page" data-id="${page + 1}" ${page >= pages ? "disabled" : ""}>下一页</button>
            </div>`
          : ""
      }`;
  };

  const detailView = (data: api.PluginDetail) => {
    const plugin = data.plugin;
    const record = getInstall(plugin.id);
    const update = registry.updateTarget(plugin.id);
    const sortedPerms = [...plugin.permissions].sort((a, b) => {
      const risk = { high: 0, medium: 1, low: 2 } as Record<string, number>;
      const pa = meta?.permissions.find((item) => item.id === a);
      const pb = meta?.permissions.find((item) => item.id === b);
      return (risk[pa?.risk ?? "low"] ?? 2) - (risk[pb?.risk ?? "low"] ?? 2);
    });

    return `<div class="gp-detail">
      <button type="button" class="gp-back" data-act="back">← 返回市场</button>
      <header class="gp-market-hero-detail">
        ${pluginGlyph(plugin.name, plugin.type, "", plugin.iconUrl)}
        <div class="gp-market-hero-main">
          <div class="gp-detail-name">
            <h2>${esc(plugin.name)}</h2>
            <span class="gp-chip">${esc(typeLabel(plugin.type))}</span>
            <span class="gp-chip ${plugin.security.audited ? "is-ok" : "is-warn"}">${plugin.security.audited ? "已通过安全审核" : "尚未审核"}</span>
            ${signatureChip(plugin.security.signature)}
            ${plugin.featured ? '<span class="gp-chip is-accent">推荐</span>' : ""}
          </div>
          <p class="gp-market-byline">
            <button type="button" class="gp-link" data-act="developer" data-id="${esc(plugin.author.id)}">${esc(plugin.author.name)}</button>
            · v${esc(plugin.version)} · ${esc(plugin.license)}
          </p>
          <p class="gp-detail-desc">${esc(plugin.description)}</p>
          <div class="gp-market-stats">
            <span><b>${fmtNumber(plugin.downloads)}</b> 下载</span>
            <span><b>${fmtNumber(plugin.installs)}</b> 安装</span>
            <span><b>${plugin.rating.count ? plugin.rating.average : "—"}</b> 评分（${plugin.rating.count}）</span>
            <span><b>${timeAgo(plugin.publishedAt)}</b> 发布</span>
          </div>
        </div>
        <div class="gp-market-buy">
          ${
            record
              ? `<button type="button" class="gp-btn is-primary" data-act="open" data-id="${esc(plugin.id)}">打开</button>
                 <p class="gp-buy-note">已安装 v${esc(record.version)}${update ? ` · 可更新到 v${update.version}` : ""}</p>
                 ${update ? `<button type="button" class="gp-btn is-warn" data-act="update" data-id="${esc(plugin.id)}">更新</button>` : ""}`
              : `<button type="button" class="gp-btn is-primary" data-act="install" data-id="${esc(plugin.id)}" ${plugin.security.audited ? "" : "disabled"}>安装</button>
                 <p class="gp-buy-note">${plugin.security.audited ? `安装前会逐项展示权限 · ${trustDetail(plugin.security.signature?.status, plugin.security.signature?.keyId ?? null)}` : "该版本尚未通过审核，暂不可安装"}</p>`
          }
          <button type="button" class="gp-btn" data-act="report" data-id="${esc(plugin.id)}">举报</button>
        </div>
      </header>

      ${
        plugin.screenshots.length
          ? `<div class="gp-shots">${plugin.screenshots
              .map((shot) => `<img src="${safeUrl(shot.url)}" alt="${esc(plugin.name)} 预览" loading="lazy" />`)
              .join("")}</div>`
          : ""
      }

      <div class="gp-detail-grid">
        <section class="gp-card">
          <h3>权限要求（${plugin.permissions.length}）</h3>
          <div class="gp-perm-chips">
            ${sortedPerms
              .map((permission) => {
                const info = meta?.permissions.find((item) => item.id === permission);
                return `<span class="gp-perm-chip is-${info?.risk ?? "low"}">${esc(info?.label ?? permission)}</span>`;
              })
              .join("") || '<span class="gp-muted">没有申请权限</span>'}
          </div>
          ${
            plugin.networkDomains.length
              ? `<p class="gp-note">外部域名：${plugin.networkDomains.map((domain) => `<code>${esc(domain)}</code>`).join(" ")}</p>`
              : '<p class="gp-note">不访问任何外部网络。</p>'
          }
          <p class="gp-note">风险等级：${riskChip(data.risk)}</p>
        </section>

        <section class="gp-card">
          <h3>兼容性与依赖</h3>
          <dl class="gp-kv">
            <div><dt>最低系统</dt><dd>Guandao OS ${esc(plugin.compatibility.minimumOSVersion)}</dd></div>
            <div><dt>SDK</dt><dd>v${plugin.compatibility.sdkVersion}</dd></div>
            <div><dt>Manifest</dt><dd>v${plugin.manifestVersion}</dd></div>
            <div><dt>依赖</dt><dd>${plugin.dependencies.length ? plugin.dependencies.map((dep) => `${esc(dep.id)} ${esc(dep.version)}${dep.optional ? "（可选）" : ""}`).join("、") : "无"}</dd></div>
            <div><dt>分类</dt><dd>${esc(meta?.categoryLabels[plugin.category] ?? plugin.category)}</dd></div>
            <div><dt>最近更新</dt><dd>${timeAgo(plugin.updatedAt)}</dd></div>
          </dl>
          ${plugin.homepage ? `<p class="gp-note"><a href="${safeUrl(plugin.homepage)}" target="_blank" rel="noopener noreferrer">开发者主页</a></p>` : ""}
        </section>
      </div>

      <section class="gp-card">
        <h3>更新日志 · v${esc(plugin.version)}</h3>
        <p class="gp-changelog">${esc(plugin.changelog || "作者没有填写这个版本的更新说明。")}</p>
      </section>

      <section class="gp-card">
        <h3>版本历史</h3>
        <div class="gp-versions">
          ${data.versions
            .map(
              (version) => `<div class="gp-version">
                <b>v${esc(version.version)}</b>
                <span class="gp-chip ${version.status === "approved" ? "is-ok" : "is-mute"}">${version.status === "approved" ? "已发布" : version.status === "pending" ? "审核中" : version.status === "superseded" ? "历史版本" : "未通过"}</span>
                <span>${esc(version.changelog || "—")}</span>
                <time>${timeAgo(version.publishedAt ?? version.createdAt)}</time>
              </div>`,
            )
            .join("") || '<p class="gp-muted">还没有版本记录。</p>'}
        </div>
      </section>

      <section class="gp-card">
        <h3>开发者</h3>
        <div class="gp-dev">
          <div>
            <b>${esc(data.developer.name)}</b>
            <p>${esc(data.developer.bio || "这位开发者还没有写简介。")}</p>
            ${data.developer.website ? `<a href="${safeUrl(data.developer.website)}" target="_blank" rel="noopener noreferrer">${esc(data.developer.website)}</a>` : ""}
          </div>
          <span class="gp-muted">加入于 ${timeAgo(data.developer.joinedAt)}</span>
        </div>
      </section>

      <section class="gp-card">
        <h3>评价（${data.reviewCount}）</h3>
        ${
          record
            ? `<form class="gp-review-form" data-review-form>
                <div class="gp-stars" data-stars>
                  ${[1, 2, 3, 4, 5].map((value) => `<button type="button" data-star="${value}" aria-label="${value} 星">★</button>`).join("")}
                </div>
                <textarea class="gp-input" data-review-text rows="2" maxlength="1200" placeholder="说说它解决了什么问题…">${esc(reviews?.mine?.body ?? "")}</textarea>
                <div class="gp-review-actions">
                  <button type="submit" class="gp-btn is-primary">${reviews?.mine ? "更新评价" : "提交评价"}</button>
                  <span class="gp-muted">只有安装过的账号可以评价</span>
                </div>
              </form>`
            : `<p class="gp-note">安装后才能评价。</p>`
        }
        <div class="gp-reviews">
          ${(reviews?.items ?? [])
            .map(
              (review) => `<div class="gp-review">
                <header><b>${esc(review.author.name)}</b><span class="gp-stars-static">${"★".repeat(review.rating)}${"☆".repeat(5 - review.rating)}</span><time>${timeAgo(review.updatedAt)}</time></header>
                <p>${esc(review.body || "（只打了分）")}</p>
              </div>`,
            )
            .join("") || '<p class="gp-muted">还没有评价。</p>'}
        </div>
      </section>
    </div>`;
  };

  const paint = () => {
    if (detail) {
      body.innerHTML = detailView(detail);
      return;
    }
    body.innerHTML = listView();
    win.querySelectorAll<HTMLElement>(".g14-nav").forEach((node) => {
      node.classList.toggle("is-active", node.dataset.tab === tab);
    });
  };

  const reloadDetail = async () => {
    if (!detail) return;
    const id = detail.plugin.id;
    detail = await api.getPlugin(id);
    reviews = await api.listReviews(id, 1).catch(() => reviews);
  };

  body.addEventListener("click", async (event) => {
    const target = event.target as HTMLElement;
    const action = target.closest<HTMLElement>("[data-act]");
    if (action) {
      event.preventDefault();
      const id = action.dataset.id ?? "";
      const kind = action.dataset.act ?? "";
      try {
        if (kind === "back") {
          detail = null;
          reviews = null;
          await loadList();
          return;
        }
        if (kind === "install") {
          if (detail) await install(detail);
          return;
        }
        if (kind === "install-official") {
          await installOfficial(id);
          return;
        }
        if (kind === "open") {
          openInstalled(id);
          return;
        }
        if (kind === "update") {
          try {
            await registry.updatePlugin(id);
          } catch (error) {
            if (error instanceof registry.PluginConsentRequired) {
              const granted = await requestPermissions(win, {
                manifest: error.manifest!,
                mode: "update",
                added: error.added,
                granted: getInstall(id)?.granted ?? [],
              });
              if (!granted) return;
              await registry.updatePlugin(id, granted);
            } else throw error;
          }
          await reloadDetail();
          paint();
          return;
        }
        if (kind === "report") {
          await report();
          return;
        }
        if (kind === "page") {
          page = Math.max(1, Number(id) || 1);
          await loadList();
          return;
        }
        if (kind === "tab") {
          tab = id;
          page = 1;
          detail = null;
          await loadList();
          return;
        }
        if (kind === "developer") {
          if (detail) await openDeveloper(detail);
          return;
        }
      } catch (error) {
        ctx.toast(error instanceof Error ? error.message : "操作失败");
      }
      return;
    }

    if (target.closest("[data-gp-login]")) {
      promptLogin();
      return;
    }

    const cardNode = target.closest<HTMLElement>("[data-open]");
    if (cardNode?.dataset.open) {
      await openDetail(cardNode.dataset.open);
      return;
    }
    const officialNode = target.closest<HTMLElement>("[data-open-official]");
    if (officialNode?.dataset.openOfficial) {
      await openDetail(officialNode.dataset.openOfficial);
      return;
    }
    const star = target.closest<HTMLElement>("[data-star]");
    if (star) {
      const form = star.closest<HTMLElement>("[data-review-form]");
      form?.querySelectorAll<HTMLElement>("[data-star]").forEach((node) => {
        node.classList.toggle("is-on", Number(node.dataset.star) <= Number(star.dataset.star));
      });
      form?.setAttribute("data-rating", star.dataset.star ?? "5");
    }
  });

  body.addEventListener("submit", (event) => {
    const form = event.target as HTMLElement;
    if (!form.matches("[data-review-form]")) return;
    event.preventDefault();
    const rating = Number(form.closest<HTMLElement>("[data-review-form]")?.getAttribute("data-rating") ?? 5);
    const text = form.querySelector<HTMLTextAreaElement>("[data-review-text]")?.value ?? "";
    void submitReview(rating, text);
  });

  win.addEventListener("click", (event) => {
    const nav = (event.target as HTMLElement).closest<HTMLElement>(".g14-nav[data-tab]");
    if (nav?.dataset.tab) {
      tab = nav.dataset.tab;
      page = 1;
      query = "";
      if (search) search.value = "";
      detail = null;
      void loadList();
    }
    const sortBtn = (event.target as HTMLElement).closest<HTMLElement>("[data-sort]");
    if (sortBtn?.dataset.sort) {
      sort = sortBtn.dataset.sort as Sort;
      win.querySelectorAll<HTMLElement>("[data-sort]").forEach((node) => node.classList.toggle("is-active", node === sortBtn));
      page = 1;
      void loadList();
    }
  });

  search?.addEventListener("input", () => {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      query = search.value.trim();
      page = 1;
      detail = null;
      void loadList();
    }, 320);
  });

  search?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    window.clearTimeout(searchTimer);
    query = search.value.trim();
    page = 1;
    detail = null;
    void loadList();
  });

  const onChange = () => paint();
  window.addEventListener("guandao:plugins-change", onChange);

  const openDeveloper = async (data: api.PluginDetail) => {
    openDialog(win, {
      title: data.developer.name,
      subtitle: `插件开发者 · 加入于 ${timeAgo(data.developer.joinedAt)}`,
      body: `<p class="gp-dialog-para">${esc(data.developer.bio || "这位开发者还没有写简介。")}</p>
        ${data.developer.website ? `<p class="gp-note">${esc(data.developer.website)}</p>` : ""}`,
      actions: [{ label: "关闭", value: "ok", primary: true }],
    });
  };

  void loadList();

  return () => {
    window.removeEventListener("guandao:plugins-change", onChange);
    window.clearTimeout(searchTimer);
  };
};
