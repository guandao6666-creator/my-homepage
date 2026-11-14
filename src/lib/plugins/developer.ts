/**
 * Guandao OS 1.7 · 开发者中心
 *
 * 开发者的完整闭环：创建草稿 → 上传插件包 → 提交审核 → 查看结果 → 发布新版本。
 * 审核中心复用同一套账号角色（admin / moderator），审批动作全部写审计日志。
 *
 * 客户端也会先跑一遍 Manifest 校验，但服务端才是权威；这里不伪造「上传成功」。
 */

import { shell, type Ctx } from "../os14/core";
import { validateBundle, LICENSES, PLUGIN_CATEGORIES, PLUGIN_TYPE_META } from "../../../shared/plugin-spec.js";
import * as api from "./api";
import {
  esc,
  fmtBytes,
  fmtNumber,
  loginGate,
  openDialog,
  promptLogin,
  promptText,
  timeAgo,
  typeIcon,
  typeLabel,
} from "./ui-kit";

type Tab = "overview" | "plugins" | "new" | "profile" | "review" | "audit";

const NAV: Array<[string, string, string]> = [
  ["overview", "概览", "◈"],
  ["plugins", "我的插件", "▣"],
  ["new", "新建插件", "＋"],
  ["profile", "开发者资料", "◎"],
  ["review", "审核中心", "⚑"],
  ["audit", "审计日志", "≡"],
];

const STATUS: Record<string, { label: string; tone: string }> = {
  draft: { label: "草稿", tone: "mute" },
  pending_review: { label: "审核中", tone: "warn" },
  published: { label: "已发布", tone: "ok" },
  rejected: { label: "未通过", tone: "danger" },
  hidden: { label: "已隐藏", tone: "mute" },
  blocked: { label: "已下架", tone: "danger" },
  pending: { label: "待审核", tone: "warn" },
  approved: { label: "已通过", tone: "ok" },
  superseded: { label: "历史版本", tone: "mute" },
};

const statusChip = (key: string) => {
  const info = STATUS[key] ?? { label: key, tone: "mute" };
  return `<span class="gp-chip is-${info.tone}">${esc(info.label)}</span>`;
};

export const renderDeveloperCenter = () =>
  shell(
    "pdev",
    NAV,
    `<div class="gp-app" data-gp-dev>
      <header class="gp-top">
        <div class="gp-top-title">
          <p class="gp-eyebrow">Guandao Developer</p>
          <h2>开发者中心</h2>
          <p class="gp-top-sub" data-gp-dev-sub>正在读取开发者资料…</p>
        </div>
        <div class="gp-top-actions">
          <button type="button" class="gp-btn" data-act="docs">开发文档</button>
          <button type="button" class="gp-btn is-primary" data-act="tab" data-id="new">新建插件</button>
        </div>
      </header>
      <div class="gp-body" data-gp-body>
        <div class="gp-skeleton">正在读取开发者资料…</div>
      </div>
      <input type="file" accept=".gplug,.json,application/json" data-gp-bundle hidden />
    </div>`,
    "Developer Center",
  );

export const initDeveloperCenter = (win: HTMLElement, ctx: Ctx): (() => void) => {
  const body = win.querySelector<HTMLElement>("[data-gp-body]");
  const sub = win.querySelector<HTMLElement>("[data-gp-dev-sub]");
  const fileInput = win.querySelector<HTMLInputElement>("[data-gp-bundle]");
  if (!body) return () => undefined;

  let tab: Tab = "overview";
  let profile: api.DeveloperProfile | null = null;
  let plugins: api.DeveloperPlugin[] = [];
  let queue: Awaited<ReturnType<typeof api.getQueue>>["items"] = [];
  let published: api.PluginCard[] = [];
  let audits: Array<Record<string, unknown>> = [];
  let reports: Array<Record<string, unknown>> = [];
  let gate = false;
  let errorText = "";
  let editing = "";
  let uploadTarget = "";
  let staff = false;

  const setSub = (text: string) => {
    if (sub) sub.textContent = text;
  };

  const loadAll = async () => {
    try {
      const [profileData, pluginsData] = await Promise.all([api.getDeveloperProfile(), api.listDeveloperPlugins()]);
      profile = profileData;
      plugins = pluginsData.items;
      // 非 staff 调用审核接口会 403，静默处理，不显示入口
      staff = Boolean(pluginsData.viewer.staff);
      gate = false;
      errorText = "";
      setSub(`${profile.profile.displayName} · ${profile.stats.published} 个已发布 · ${fmtNumber(profile.stats.downloads)} 次下载`);
      if (staff) await loadAdmin();
    } catch (error) {
      if (error instanceof api.PluginApiError && error.status === 401) {
        gate = true;
        setSub("需要登录 Guandao Account");
      } else {
        errorText = error instanceof Error ? error.message : "读取失败";
        setSub("开发者资料读取失败");
      }
    }
    paint();
  };

  const loadAdmin = async () => {
    try {
      const [queueData, auditData, reportData, publishedData] = await Promise.all([
        api.getQueue("pending"),
        api.getAudit(),
        api.getReports(),
        api.listPlugins({ limit: 30, sort: "latest" }),
      ]);
      queue = queueData.items;
      audits = auditData.items;
      reports = reportData.items;
      published = publishedData.items;
    } catch {
      queue = [];
      audits = [];
      reports = [];
      published = [];
    }
  };

  const reloadPlugins = async () => {
    try {
      const data = await api.listDeveloperPlugins();
      plugins = data.items;
    } catch {
      /* 保持旧数据 */
    }
  };

  /* ---------------------------- 概览 ---------------------------- */

  const overview = () => {
    const data = profile!;
    return `<div class="gp-dev-overview">
      <section class="gp-dev-hero">
        <div>
          <p class="gp-eyebrow">Open Desktop</p>
          <h3>把想法做成插件，交给别人的桌面。</h3>
          <p>Guandao SDK 提供有限、稳定、需要授权的接口。插件跑在独立沙箱里，用户逐项批准权限；你不需要接触数据库、文件系统或任何密钥。</p>
          <div class="gp-dev-hero-actions">
            <button type="button" class="gp-btn is-primary" data-act="tab" data-id="new">新建插件</button>
            <button type="button" class="gp-btn" data-act="docs">阅读文档</button>
          </div>
        </div>
        <div class="gp-dev-stats">
          <div><b>${data.stats.published}</b><span>已发布</span></div>
          <div><b>${fmtNumber(data.stats.downloads)}</b><span>下载</span></div>
          <div><b>${fmtNumber(data.stats.installs)}</b><span>安装</span></div>
          <div><b>${data.stats.ratings}</b><span>评价</span></div>
        </div>
      </section>

      <div class="gp-detail-grid">
        <section class="gp-card">
          <h3>发布流程</h3>
          <ol class="gp-steps">
            <li><b>创建草稿</b><span>先占住插件 ID（反向域名），类型创建后不可更改。</span></li>
            <li><b>本地开发</b><span>用 <code>guandao create</code> / <code>guandao dev</code> 在浏览器里调 UI。</span></li>
            <li><b>打包上传</b><span><code>guandao package</code> 生成 .gplug，含 Manifest 与文件摘要。</span></li>
            <li><b>提交审核</b><span>服务端校验 Schema、路径、大小、权限与摘要。</span></li>
            <li><b>审核发布</b><span>管理员通过后才进入市场；已发布插件的新版本同样要审核。</span></li>
          </ol>
        </section>
        <section class="gp-card">
          <h3>边界与限制</h3>
          <dl class="gp-kv">
            <div><dt>插件包</dt><dd>≤ ${fmtBytes(2 * 1024 * 1024)}</dd></div>
            <div><dt>文件数</dt><dd>≤ 48</dd></div>
            <div><dt>单文件</dt><dd>≤ 512 KB</dd></div>
            <div><dt>插件存储</dt><dd>≤ 256 KB / 插件</dd></div>
            <div><dt>命令</dt><dd>≤ 8 条</dd></div>
            <div><dt>网络域名</dt><dd>≤ 8 个，逐条声明</dd></div>
          </dl>
          <p class="gp-note">不允许包含 .php / .wasm / .exe 等可执行后端文件；入口必须是 HTML，脚本只在沙箱里运行。</p>
        </section>
      </div>
    </div>`;
  };

  /* ---------------------------- 我的插件 ---------------------------- */

  const pluginCard = (plugin: api.DeveloperPlugin) => {
    const latest = plugin.latestVersion;
    return `<article class="gp-dev-card">
      <header>
        <span class="gp-glyph" style="--gp-accent:linear-gradient(140deg,#6f8cff,#b06eff)"><b>${esc(plugin.name.slice(0, 1))}</b><i>${typeIcon(plugin.type)}</i></span>
        <div>
          <div class="gp-detail-name"><h3>${esc(plugin.name)}</h3>${statusChip(plugin.status)}</div>
          <p class="gp-row-sub"><code>${esc(plugin.id)}</code> · ${esc(typeLabel(plugin.type))}</p>
        </div>
      </header>
      <div class="gp-dev-meta">
        <span>最新版本 <b>${esc(latest?.version ?? "—")}</b> ${latest ? statusChip(latest.status) : ""}</span>
        <span>安装 <b>${fmtNumber(plugin.installs)}</b></span>
        <span>下载 <b>${fmtNumber(plugin.downloads)}</b></span>
        <span>评分 <b>${plugin.rating.count ? plugin.rating.average : "—"}</b></span>
      </div>
      ${plugin.moderationNote ? `<p class="gp-dev-note is-warn">审核意见：${esc(plugin.moderationNote)}</p>` : ""}
      ${editing === plugin.id ? editForm(plugin) : ""}
      <div class="gp-row-actions">
        <button type="button" class="gp-btn is-primary" data-act="upload" data-id="${esc(plugin.id)}">上传新版本</button>
        ${
          plugin.status === "draft" || plugin.status === "rejected"
            ? `<button type="button" class="gp-btn" data-act="submit" data-id="${esc(plugin.id)}">提交审核</button>`
            : ""
        }
        ${
          latest && latest.status === "pending" && plugin.status !== "pending_review"
            ? `<button type="button" class="gp-btn" data-act="withdraw" data-id="${esc(plugin.id)}">撤回版本</button>`
            : ""
        }
        <button type="button" class="gp-btn" data-act="edit" data-id="${esc(plugin.id)}">${editing === plugin.id ? "取消编辑" : "编辑信息"}</button>
        ${
          plugin.status !== "published" && plugin.status !== "blocked"
            ? `<button type="button" class="gp-btn is-danger" data-act="delete" data-id="${esc(plugin.id)}">删除草稿</button>`
            : ""
        }
      </div>
    </article>`;
  };

  const editForm = (plugin: api.DeveloperPlugin) => `
    <form class="gp-form" data-edit-form data-id="${esc(plugin.id)}">
      <div class="gp-field"><label>名称</label><input class="gp-input" name="name" maxlength="48" value="${esc(plugin.name)}" /></div>
      <div class="gp-field"><label>简介</label><textarea class="gp-input" name="description" rows="2" maxlength="2000">${esc(plugin.description)}</textarea></div>
      <div class="gp-form-row">
        <div class="gp-field"><label>分类</label>
          <select class="gp-input" name="category">
            ${PLUGIN_CATEGORIES.map((category) => `<option value="${category}" ${plugin.category === category ? "selected" : ""}>${category}</option>`).join("")}
          </select>
        </div>
        <div class="gp-field"><label>许可证</label>
          <select class="gp-input" name="license">
            ${LICENSES.map((license) => `<option value="${license}" ${plugin.license === license ? "selected" : ""}>${license}</option>`).join("")}
          </select>
        </div>
      </div>
      <button type="submit" class="gp-btn is-primary">保存</button>
    </form>`;

  /* ---------------------------- 新建 ---------------------------- */

  const newForm = () => `
    <div class="gp-dev-new">
      <section class="gp-card">
        <h3>1. 插件身份</h3>
        <p class="gp-note">插件 ID 是全局唯一的反向域名，发布后不可更改。例如 <code>com.yourname.tool</code>。</p>
        <form class="gp-form" data-new-form>
          <div class="gp-field"><label>插件 ID</label><input class="gp-input" name="id" placeholder="com.example.tool" maxlength="80" required /></div>
          <div class="gp-field"><label>名称</label><input class="gp-input" name="name" maxlength="48" placeholder="例如：Markdown 速记" required /></div>
          <div class="gp-form-row">
            <div class="gp-field"><label>类型</label>
              <select class="gp-input" name="type">
                ${Object.entries(PLUGIN_TYPE_META).map(([key, meta]) => `<option value="${key}">${esc(meta.label)} · ${esc(meta.desc)}</option>`).join("")}
              </select>
            </div>
            <div class="gp-field"><label>分类</label>
              <select class="gp-input" name="category">
                ${PLUGIN_CATEGORIES.map((category) => `<option value="${category}" ${category === "productivity" ? "selected" : ""}>${category}</option>`).join("")}
              </select>
            </div>
          </div>
          <div class="gp-field"><label>简介</label><textarea class="gp-input" name="description" rows="3" maxlength="2000" placeholder="它解决什么问题？"></textarea></div>
          <div class="gp-field"><label>许可证</label>
            <select class="gp-input" name="license">${LICENSES.map((license) => `<option value="${license}">${license}</option>`).join("")}</select>
          </div>
          <button type="submit" class="gp-btn is-primary">创建草稿</button>
        </form>
      </section>
      <section class="gp-card">
        <h3>2. 本地开发与打包</h3>
        <pre class="gp-code">npx guandao create my-plugin
cd my-plugin
npx guandao dev
npx guandao validate guandao.plugin.json
npx guandao package
// 生成 dist/com.example.tool-1.0.0.gplug</pre>
        <p class="gp-note">CLI 在仓库的 <code>cli/</code> 目录；不依赖任何第三方包，也不会索取 GitHub 或 Cloudflare 权限。</p>
      </section>
    </div>`;

  /* ---------------------------- 资料 ---------------------------- */

  const profileView = () => {
    const data = profile!;
    return `<div class="gp-dev-profile">
      <section class="gp-card">
        <h3>公开资料</h3>
        <p class="gp-note">这些信息会显示在插件详情页。账号邮箱、GitHub 数字 ID 与 Session 永远不会出现在插件接口里。</p>
        <form class="gp-form" data-profile-form>
          <div class="gp-field"><label>展示名称</label><input class="gp-input" name="displayName" maxlength="40" value="${esc(data.profile.displayName)}" /></div>
          <div class="gp-field"><label>简介</label><textarea class="gp-input" name="bio" rows="3" maxlength="600">${esc(data.profile.bio)}</textarea></div>
          <div class="gp-field"><label>主页（https）</label><input class="gp-input" name="website" maxlength="300" value="${esc(data.profile.website)}" placeholder="https://" /></div>
          <button type="submit" class="gp-btn is-primary">保存资料</button>
        </form>
      </section>
      <section class="gp-card">
        <h3>账号</h3>
        <dl class="gp-kv">
          <div><dt>用户 ID</dt><dd><code>${esc(data.profile.id)}</code></dd></div>
          <div><dt>注册时间</dt><dd>${timeAgo(data.profile.createdAt)}</dd></div>
          <div><dt>审核角色</dt><dd>${staff ? "审核员（可审批插件）" : "普通开发者"}</dd></div>
          <div><dt>插件配额</dt><dd>${data.stats.total} / ${data.limits.maxPlugins}</dd></div>
        </dl>
      </section>
    </div>`;
  };

  /* ---------------------------- 审核 ---------------------------- */

  const reviewView = () => {
    if (!staff) {
      return `<div class="gp-empty"><span class="gp-empty-ico">⚑</span><b>没有审核权限</b><p>审核中心只对管理员与社区审核员开放。</p></div>`;
    }
    return `<div class="gp-hintbar">审核通过后插件才会进入市场；已发布插件的新版本也要走同一条队列。不能审核自己发布的插件。</div>
      <h3 class="gp-section-title">待审核版本（${queue.length}）</h3>
      <div class="gp-review-queue">
        ${
          queue
            .map(
              (item) => `<article class="gp-review-card">
                <header>
                  <div>
                    <div class="gp-detail-name"><b>${esc(item.plugin.name)}</b>${statusChip(item.plugin.status)}
                      <span class="gp-chip">${esc(typeLabel(item.plugin.type))}</span>
                    </div>
                    <p class="gp-row-sub">v${esc(item.version.version)} · ${esc(item.developer.name)} · ${fmtBytes(item.version.sizeBytes)} · 提交于 ${timeAgo(item.version.createdAt)}</p>
                  </div>
                  <code title="${esc(item.version.checksum)}">${esc(item.version.checksum.slice(0, 16))}…</code>
                </header>
                <p class="gp-row-desc">${esc(item.plugin.description)}</p>
                <div class="gp-perm-chips">
                  ${(item.version.manifest?.permissions ?? [])
                    .map((permission) => `<span class="gp-perm-chip">${esc(permission)}</span>`)
                    .join("") || '<span class="gp-muted">没有申请权限</span>'}
                </div>
                <p class="gp-dev-note">更新日志：${esc(item.version.changelog || "未填写")}</p>
                <div class="gp-row-actions">
                  <button type="button" class="gp-btn is-primary" data-act="approve" data-id="${esc(item.plugin.id)}" data-version="${esc(item.version.version)}">通过</button>
                  <button type="button" class="gp-btn is-danger" data-act="reject" data-id="${esc(item.plugin.id)}" data-version="${esc(item.version.version)}">拒绝</button>
                  <button type="button" class="gp-btn" data-act="restrict" data-id="${esc(item.developer.id)}" data-version="">限制开发者</button>
                  <button type="button" class="gp-btn is-danger" data-act="takedown" data-id="${esc(item.plugin.id)}" data-version="">紧急下架</button>
                </div>
              </article>`,
            )
            .join("") || '<p class="gp-muted">队列是空的。</p>'
        }
      </div>

      <h3 class="gp-section-title">举报（${reports.length}）</h3>
      <div class="gp-review-queue">
        ${
          reports
            .map(
              (report) => `<article class="gp-review-card">
                <header><b>${esc(String(report.pluginName ?? report.pluginId ?? ""))}</b><span class="gp-chip is-warn">${esc(String(report.reason ?? ""))}</span></header>
                <p class="gp-row-desc">${esc(String(report.detail ?? "（没有补充说明）"))}</p>
                <p class="gp-row-sub">举报人 ${esc(String(report.reporter ?? "—"))} · ${timeAgo(Number(report.createdAt ?? 0))}</p>
                <div class="gp-row-actions">
                  <button type="button" class="gp-btn" data-act="resolve-report" data-id="${esc(String(report.id))}" data-version="resolved">标记已处理</button>
                  <button type="button" class="gp-btn" data-act="dismiss-report" data-id="${esc(String(report.id))}" data-version="dismissed">驳回举报</button>
                  <button type="button" class="gp-btn is-danger" data-act="takedown" data-id="${esc(String(report.pluginId ?? ""))}" data-version="">下架插件</button>
                </div>
              </article>`,
            )
            .join("") || '<p class="gp-muted">没有待处理举报。</p>'
        }
      </div>

      <h3 class="gp-section-title">已发布插件</h3>
      <div class="gp-review-queue">
        ${published
          .slice(0, 12)
          .map(
            (item) => `<article class="gp-review-card">
              <header>
                <div><div class="gp-detail-name"><b>${esc(item.name)}</b>${item.featured ? '<span class="gp-chip is-accent">推荐中</span>' : ""}</div>
                <p class="gp-row-sub">v${esc(item.version)} · ${esc(item.author.name)} · ${fmtNumber(item.installs)} 安装</p></div>
              </header>
              <div class="gp-row-actions">
                <button type="button" class="gp-btn" data-act="feature" data-id="${esc(item.id)}" data-version="${item.featured ? "0" : "1"}">${item.featured ? "取消推荐" : "设为推荐"}</button>
                <button type="button" class="gp-btn is-danger" data-act="takedown" data-id="${esc(item.id)}" data-version="">下架</button>
              </div>
            </article>`,
          )
          .join("") || '<p class="gp-muted">还没有已发布插件。</p>'}
      </div>`;
  };

  const auditView = () => `
    <div class="gp-hintbar">审核、发布、下架、权限与开发者限制都会写入审计日志；日志不包含插件包内容或任何凭据。</div>
    <div class="gp-audit">
      ${
        audits
          .map((entry) => `<div class="gp-audit-row">
            <time>${timeAgo(Number(entry.createdAt ?? 0))}</time>
            <b>${esc(String(entry.action ?? ""))}</b>
            <span>${esc(String(entry.pluginId ?? entry.targetUserId ?? "—"))}</span>
            <span>${esc(String((entry.actor as { name?: string } | null)?.name ?? "系统"))}</span>
          </div>`)
          .join("") || '<p class="gp-muted">还没有审计记录。</p>'
      }
    </div>`;

  const paint = () => {
    win.querySelectorAll<HTMLElement>(".g14-nav").forEach((node) => {
      const tabName = node.dataset.tab ?? "";
      node.hidden = (tabName === "review" || tabName === "audit") && !staff;
      node.classList.toggle("is-active", tabName === tab);
    });

    if (gate) {
      body.innerHTML = loginGate(win, "开发者中心需要 Guandao Account。登录后才能创建插件、上传版本与提交审核。");
      setSub("需要登录");
      return;
    }
    if (errorText) {
      body.innerHTML = `<div class="gp-empty"><span class="gp-empty-ico">!</span><b>开发者中心暂时不可用</b><p>${esc(errorText)}</p><button class="gp-btn" data-act="reload">重试</button></div>`;
      return;
    }
    if (!profile) {
      body.innerHTML = `<div class="gp-skeleton">正在读取开发者资料…</div>`;
      return;
    }

    if (tab === "overview") body.innerHTML = overview();
    else if (tab === "plugins") {
      body.innerHTML = `<div class="gp-hintbar">草稿与审核中的版本只有你自己可见；发布后的插件会进入插件市场。</div>
        <div class="gp-dev-list">${plugins.map(pluginCard).join("") || '<div class="gp-empty"><b>还没有插件</b><p>先创建一个草稿。</p><button class="gp-btn is-primary" data-act="tab" data-id="new">新建插件</button></div>'}</div>`;
    } else if (tab === "new") body.innerHTML = newForm();
    else if (tab === "profile") body.innerHTML = profileView();
    else if (tab === "review") body.innerHTML = reviewView();
    else if (tab === "audit") body.innerHTML = auditView();
  };

  const showIssues = (title: string, issues: Array<{ path: string; message: string }>) => {
    openDialog(win, {
      title,
      body: `<ul class="gp-error-list">${issues.map((issue) => `<li><code>${esc(issue.path)}</code> ${esc(issue.message)}</li>`).join("")}</ul>
        <p class="gp-dialog-hint">插件包没有上传；修正后重新打包即可。</p>`,
      actions: [{ label: "知道了", value: "ok", primary: true }],
    });
  };

  const startUpload = (id: string) => {
    uploadTarget = id;
    if (fileInput) {
      fileInput.value = "";
      fileInput.click();
    }
  };

  const handleBundle = async (file: File) => {
    const target = uploadTarget;
    const plugin = plugins.find((item) => item.id === target);
    if (!plugin) return;
    if (file.size > 2.5 * 1024 * 1024) {
      ctx.toast("插件包不能超过 2 MB（.gplug 是 JSON 文本）");
      return;
    }
    const text = await file.text();
    const check = validateBundle(text, { expectedId: plugin.id, expectedType: plugin.type });
    if (!check.ok) {
      showIssues("插件包没有通过校验", check.errors);
      return;
    }
    const manifest = check.manifest!;
    const changelog = await promptText(win, {
      title: `上传 ${manifest.name} v${manifest.version}`,
      message: "写一句这个版本的更新说明，审核和用户都会看到。",
      value: manifest.changelog || "",
      multiline: true,
      submitLabel: "上传",
    });
    if (changelog === null) return;

    try {
      const result = await api.uploadVersion(plugin.id, text, changelog);
      ctx.toast(`已上传 v${result.version.version}，等待提交审核`);
      if (result.version.warnings?.length) {
        showIssues("上传成功，但有警告", result.version.warnings);
      }
      await reloadPlugins();
      paint();
      const submit = await openDialog(win, {
        title: "现在提交审核？",
        body: `<p class="gp-dialog-para">提交后进入审核队列；审核通过前不会出现在市场。</p>`,
        actions: [
          { label: "稍后", value: "" },
          { label: "提交审核", value: "ok", primary: true },
        ],
      });
      if ((await submit.result) === "ok") {
        await api.submitPlugin(plugin.id);
        ctx.toast("已提交审核");
        await reloadPlugins();
        paint();
      }
    } catch (error) {
      if (error instanceof api.PluginApiError && error.issues?.length) {
        showIssues("服务端拒绝了这次上传", error.issues);
      } else {
        ctx.toast(error instanceof Error ? error.message : "上传失败");
      }
    }
  };

  body.addEventListener("click", async (event) => {
    const target = event.target as HTMLElement;
    if (target.closest("[data-gp-login]")) {
      promptLogin();
      return;
    }
    const action = target.closest<HTMLElement>("[data-act]");
    if (!action) return;
    const id = action.dataset.id ?? "";
    const kind = action.dataset.act ?? "";
    const version = action.dataset.version ?? "";
    try {
      if (kind === "tab") {
        tab = id as Tab;
        editing = "";
        paint();
        return;
      }
      if (kind === "docs") {
        window.open("/developers/", "_blank", "noopener");
        return;
      }
      if (kind === "reload") {
        await loadAll();
        return;
      }
      if (kind === "edit") {
        editing = editing === id ? "" : id;
        paint();
        return;
      }
      if (kind === "upload") {
        startUpload(id);
        return;
      }
      if (kind === "submit") {
        await api.submitPlugin(id);
        ctx.toast("已提交审核");
        await reloadPlugins();
        paint();
        return;
      }
      if (kind === "withdraw") {
        await api.withdrawPlugin(id);
        ctx.toast("已撤回待审核版本");
        await reloadPlugins();
        paint();
        return;
      }
      if (kind === "delete") {
        const plugin = plugins.find((item) => item.id === id);
        const confirm = await openDialog(win, {
          title: `删除「${plugin?.name ?? id}」`,
          body: `<p class="gp-dialog-para">只允许删除没有已审核版本的草稿。删除后 ID 不能再次使用。</p>`,
          actions: [
            { label: "取消", value: "" },
            { label: "删除", value: "ok", danger: true },
          ],
        });
        if ((await confirm.result) !== "ok") return;
        await api.deleteDeveloperPlugin(id);
        ctx.toast("草稿已删除");
        await reloadPlugins();
        paint();
        return;
      }
      if (kind === "approve") {
        const note = await promptText(win, {
          title: `通过 ${id} v${version}`,
          message: "可以留一句给开发者的备注（可选）。",
          submitLabel: "通过并发布",
        });
        if (note === null) return;
        await api.reviewPlugin(id, version, "approve", note);
        ctx.toast("已通过审核并发布");
        await loadAdmin();
        paint();
        return;
      }
      if (kind === "reject") {
        const note = await promptText(win, {
          title: `拒绝 ${id} v${version}`,
          message: "必须写明原因，开发者会在作品状态里看到。",
          multiline: true,
          submitLabel: "确认拒绝",
          danger: true,
        });
        if (!note) return;
        await api.reviewPlugin(id, version, "reject", note);
        ctx.toast("已拒绝");
        await loadAdmin();
        paint();
        return;
      }
      if (kind === "takedown") {
        const reason = await promptText(win, {
          title: "紧急下架",
          message: "已安装用户会被停止运行，但数据不会被删除。原因会写入审计日志。",
          multiline: true,
          submitLabel: "下架",
          danger: true,
        });
        if (!reason) return;
        await api.takedownPlugin(id, reason);
        ctx.toast("已下架");
        await loadAdmin();
        paint();
        return;
      }
      if (kind === "feature") {
        await api.featurePlugin(id, version === "1");
        ctx.toast(version === "1" ? "已设为推荐" : "已取消推荐");
        await loadAdmin();
        paint();
        return;
      }
      if (kind === "restrict") {
        const reason = await promptText(win, {
          title: "限制开发者发布",
          message: "会复用社区资料的 restriction 字段，被限制的账号不能继续发布插件。",
          multiline: true,
          submitLabel: "限制发布",
          danger: true,
        });
        if (!reason) return;
        await api.restrictDeveloper(id, "blocked", reason);
        ctx.toast("已限制该开发者发布");
        return;
      }
      if (kind === "resolve-report" || kind === "dismiss-report") {
        await api.resolveReport(id, kind === "resolve-report" ? "resolved" : "dismissed", "");
        ctx.toast("举报已处理");
        await loadAdmin();
        paint();
      }
    } catch (error) {
      ctx.toast(error instanceof Error ? error.message : "操作失败");
    }
  });

  body.addEventListener("submit", async (event) => {
    const form = event.target as HTMLFormElement;
    event.preventDefault();
    try {
      if (form.matches("[data-new-form]")) {
        const data = new FormData(form);
        const result = await api.createPlugin({
          id: String(data.get("id") ?? "").trim(),
          name: String(data.get("name") ?? "").trim(),
          type: String(data.get("type") ?? "application"),
          category: String(data.get("category") ?? "other"),
          description: String(data.get("description") ?? "").trim(),
          license: String(data.get("license") ?? "MIT"),
        });
        ctx.toast("草稿已创建，下一步上传插件包");
        await reloadPlugins();
        tab = "plugins";
        paint();
        window.setTimeout(() => startUpload(result.plugin.id), 120);
        return;
      }
      if (form.matches("[data-edit-form]")) {
        const id = form.dataset.id ?? "";
        const data = new FormData(form);
        await api.updateDeveloperPlugin(id, {
          name: String(data.get("name") ?? ""),
          description: String(data.get("description") ?? ""),
          category: String(data.get("category") ?? "other"),
          license: String(data.get("license") ?? "MIT"),
        });
        editing = "";
        await reloadPlugins();
        paint();
        ctx.toast("已保存");
        return;
      }
      if (form.matches("[data-profile-form]")) {
        const data = new FormData(form);
        await api.updateDeveloperProfile({
          displayName: String(data.get("displayName") ?? ""),
          bio: String(data.get("bio") ?? ""),
          website: String(data.get("website") ?? ""),
        });
        await loadAll();
        ctx.toast("资料已保存");
      }
    } catch (error) {
      ctx.toast(error instanceof Error ? error.message : "保存失败");
    }
  });

  fileInput?.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    if (file) void handleBundle(file);
    fileInput.value = "";
  });

  win.addEventListener("click", (event) => {
    const nav = (event.target as HTMLElement).closest<HTMLElement>(".g14-nav[data-tab]");
    if (!nav?.dataset.tab) return;
    const next = nav.dataset.tab as Tab;
    if (!NAV.some(([key]) => key === next)) return;
    if ((next === "review" || next === "audit") && !staff) return;
    tab = next;
    editing = "";
    paint();
  });

  const onPluginsChange = () => {
    void reloadPlugins().then(() => paint());
  };
  window.addEventListener("guandao:plugins-change", onPluginsChange);

  void loadAll();

  return () => window.removeEventListener("guandao:plugins-change", onPluginsChange);
};
