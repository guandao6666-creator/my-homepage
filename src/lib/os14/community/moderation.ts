/**
 * Guandao OS 1.6 · Guandao Community · 审核中心（批次 4）
 *
 * 由 community.ts 的 initCommunity 闭包迁出；通过 CommunityContext 读写外层状态，
 * 事件监听器仍留在 community.ts，HTML / 文案 / 接口调用顺序保持不变。
 */
import * as api from "../../community/api";
import { fmtDate, modal } from "../core";
import { REASON_LABEL, STATUS_LABEL } from "./constants";
import { bytesText, coverHtml, esc, roleBadge, skeleton, timeAgo } from "./ui";
import { loadCreations } from "./loaders";
import type { CommunityContext } from "./context";

export const loadModerationImpl = async (ctx: CommunityContext) => {
    const moderationTab = ctx.getModerationTab();
    const moderationQueueStatus = ctx.getModerationQueueStatus();
    const moderationReportStatus = ctx.getModerationReportStatus();
    ctx.setActiveNav("moderation");
    if (!ctx.isStaff()) {
      ctx.setBody(ctx.emptyState("需要审核权限", "这个入口只对社区审核员与管理员开放。", "⚑"));
      return;
    }
    const token = ctx.nextToken();
    ctx.setBody(skeleton("正在读取审核数据…"));
    try {
      await ctx.ensureMeta();
      const tabItems: Array<[string, string]> = [
        ["queue", "作品审核"],
        ["reports", "举报处理"],
        ["users", "用户管理"],
        ["settings", "社区设置"],
        ["audit", "审计日志"],
      ];
      const tabs = `<div class="cx-tabs">
        ${tabItems
          .map(([id, label]) => `<button type="button" class="${moderationTab === id ? "is-active" : ""}" data-mod-tab="${id}">${label}</button>`)
          .join("")}
      </div>`;
      if (moderationTab === "queue") {
        const result = await api.adminGetQueue(moderationQueueStatus);
        if (ctx.isStale(token)) return;
        ctx.setBody(`
          <section class="cx-page-head"><div><p class="cx-eyebrow">Moderation</p><h1>审核中心</h1><p>第一版采用人工审核：通过、拒绝、隐藏与删除都会真实执行并写入审计日志。</p></div></section>
          ${tabs}
          <div class="cx-chip-row">
            ${([["pending_review", "待审核"], ["hidden", "已隐藏"], ["rejected", "未通过"], ["draft", "草稿"]] as const).map(([id, label]) => `<button type="button" class="cx-chip ${moderationQueueStatus === id ? "is-active" : ""}" data-queue-status="${id}">${label} ${result.byStatus[id] || 0}</button>`).join("")}
          </div>
          <div class="cx-mod-list">
            ${
              result.items.length
                ? result.items
                    .map(
                      (post) => `<article class="cx-mod-card" data-post="${esc(post.id)}">
                        ${coverHtml(post, "cx-mod-cover")}
                        <div class="cx-mod-main">
                          <div class="cx-mod-head"><h3>${esc(post.title)}</h3><span class="cx-status-chip is-${esc(post.status)}">${STATUS_LABEL[post.status]}</span></div>
                          <p>${esc(post.description || "没有简介")}</p>
                          <div class="cx-mod-meta"><span>作者 ${esc(post.author.displayName)}</span><span>v${esc(post.version)}</span><span>举报 ${post.reportCount}</span><span>${timeAgo(post.createdAt)}</span></div>
                          ${post.moderationNote ? `<p class="cx-modnote">备注：${esc(post.moderationNote)}</p>` : ""}
                          <div class="cx-mod-actions">
                            ${post.status !== "published" ? `<button class="cx-btn is-small is-primary" type="button" data-action="review-approve" data-id="${esc(post.id)}">通过</button>` : ""}
                            ${post.status === "pending_review" ? `<button class="cx-btn is-small" type="button" data-action="review-reject" data-id="${esc(post.id)}">拒绝</button>` : ""}
                            ${post.status === "published" ? `<button class="cx-btn is-small" type="button" data-action="review-hide" data-id="${esc(post.id)}">隐藏</button>` : ""}
                            ${post.status === "published" ? `<button class="cx-btn is-small is-ghost" type="button" data-action="feature" data-id="${esc(post.id)}" data-featured="${post.featured ? "1" : "0"}">${post.featured ? "取消精选" : "设为精选"}</button>` : ""}
                            ${ctx.isAdmin() ? `<button class="cx-btn is-small is-danger is-ghost" type="button" data-action="review-delete" data-id="${esc(post.id)}">删除</button>` : ""}
                            <button class="cx-btn is-small is-ghost" type="button" data-post="${esc(post.id)}" data-action="preview-post">查看</button>
                          </div>
                        </div>
                      </article>`,
                    )
                    .join("")
                : ctx.emptyState("队列是空的", "没有待处理的审核对象。", "⚑")
            }
          </div>
        `);
      } else if (moderationTab === "reports") {
        const result = await api.adminGetReports(moderationReportStatus);
        if (ctx.isStale(token)) return;
        ctx.setBody(`
          <section class="cx-page-head"><div><p class="cx-eyebrow">Reports</p><h1>审核中心</h1><p>举报不会自动隐藏内容，必须由审核员确认后执行。</p></div></section>
          ${tabs}
          <div class="cx-chip-row">${([["open", "待处理"], ["resolved", "已处理"], ["dismissed", "已驳回"], ["all", "全部"]] as const).map(([id, label]) => `<button type="button" class="cx-chip ${moderationReportStatus === id ? "is-active" : ""}" data-report-status="${id}">${label} ${result.byStatus[id] || 0}</button>`).join("")}</div>
          <div class="cx-report-list">
            ${
              result.items.length
                ? result.items
                    .map(
                      (report) => `<article class="cx-report" data-report="${esc(report.id)}">
                        <div class="cx-report-head"><b>${esc(REASON_LABEL[report.reason] || report.reason)}</b><span class="cx-status-chip is-${esc(report.status)}">${report.status}</span></div>
                        <p>${esc(report.description || "举报人没有补充说明。")}</p>
                        <div class="cx-report-target">${
                          report.targetType === "post"
                            ? `作品：${esc(String(report.target.title || ""))}`
                            : report.targetType === "comment"
                              ? `评论：${esc(String(report.target.content || ""))}`
                              : `用户：${esc(String(report.target.displayName || ""))}`
                        }</div>
                        <div class="cx-report-meta"><span>举报人 ${esc(report.reporterName)}</span><span>${timeAgo(report.createdAt)}</span><span>目标 ${report.targetType}</span></div>
                        ${
                          report.status === "open" || report.status === "reviewing"
                            ? `<div class="cx-mod-actions">
                                <button class="cx-btn is-small" type="button" data-action="report-dismiss" data-id="${esc(report.id)}">驳回</button>
                                ${report.targetType === "post" ? `<button class="cx-btn is-small" type="button" data-action="report-hide-post" data-id="${esc(report.id)}">隐藏作品</button>` : ""}
                                ${report.targetType === "post" && ctx.isAdmin() ? `<button class="cx-btn is-small is-danger is-ghost" type="button" data-action="report-delete-post" data-id="${esc(report.id)}">删除作品</button>` : ""}
                                ${report.targetType === "comment" ? `<button class="cx-btn is-small" type="button" data-action="report-hide-comment" data-id="${esc(report.id)}">隐藏评论</button>` : ""}
                                ${ctx.isAdmin() ? `<button class="cx-btn is-small is-danger is-ghost" type="button" data-action="report-restrict" data-id="${esc(report.id)}">限制用户</button>` : ""}
                              </div>`
                            : `<p class="cx-hint">处理结果：${esc(report.resolution || "—")}</p>`
                        }
                      </article>`,
                    )
                    .join("")
                : ctx.emptyState("没有举报", "当前筛选下没有待处理举报。", "⚑")
            }
          </div>
        `);
      } else if (moderationTab === "users") {
        const result = await api.adminGetUsers();
        if (ctx.isStale(token)) return;
        ctx.setBody(`
          <section class="cx-page-head"><div><p class="cx-eyebrow">Users</p><h1>审核中心</h1><p>角色与账号状态只能由管理员修改，审核员可以限制发布权限。</p></div></section>
          ${tabs}
          <div class="cx-user-list">
            ${(result.items as Array<Record<string, unknown>>)
              .map(
                (user) => `<article class="cx-user-row">
                  <span class="cx-avatar is-s"><i>${esc(String(user.displayName || "?").slice(0, 1))}</i></span>
                  <div><b>${esc(String(user.displayName || ""))} ${roleBadge(String(user.role))}</b><span>@${esc(String(user.username || ""))} · ${Number(user.postCount || 0)} 个作品 · ${user.status === "active" ? "正常" : "已停用"} · 限制：${esc(String(user.restriction || "none"))}</span></div>
                  <div class="cx-user-actions">
                    ${ctx.isAdmin() && user.role !== "admin" ? `<button class="cx-btn is-small" type="button" data-action="user-role" data-id="${esc(String(user.id))}" data-role="${user.role === "moderator" ? "member" : "moderator"}">${user.role === "moderator" ? "撤销审核员" : "设为审核员"}</button>` : ""}
                    ${ctx.isAdmin() && user.role !== "admin" ? `<button class="cx-btn is-small is-ghost" type="button" data-action="user-status" data-id="${esc(String(user.id))}" data-status="${user.status === "active" ? "disabled" : "active"}">${user.status === "active" ? "停用账号" : "恢复账号"}</button>` : ""}
                    ${user.role !== "admin" ? `<button class="cx-btn is-small is-ghost" type="button" data-action="user-restrict" data-id="${esc(String(user.id))}" data-restriction="${user.restriction === "none" ? "limited" : "none"}">${user.restriction === "none" ? "限制发布" : "解除限制"}</button>` : ""}
                  </div>
                </article>`,
              )
              .join("")}
          </div>
        `);
      } else if (moderationTab === "settings") {
        const settings = await api.adminGetSettings();
        if (ctx.isStale(token)) return;
        const raw = settings.raw as Record<string, unknown>;
        ctx.setBody(`
          <section class="cx-page-head"><div><p class="cx-eyebrow">Settings</p><h1>审核中心</h1><p>注册模式、审核策略、配额与社区公告。设置会立即在服务端生效。</p></div></section>
          ${tabs}
          <form class="cx-settings-form" data-admin-settings>
            <section class="cx-publish-card">
              <h2>社区与注册</h2>
              <div class="cx-form-grid">
                <label>社区名称<input class="cx-input" name="communityName" maxlength="60" value="${esc(String(raw.communityName || ""))}" ${ctx.isAdmin() ? "" : "disabled"}/></label>
                <label>注册模式<select class="cx-input" name="registrationMode" ${ctx.isAdmin() ? "" : "disabled"}>
                  <option value="closed" ${raw.registrationMode === "closed" ? "selected" : ""}>关闭注册</option>
                  <option value="open" ${raw.registrationMode === "open" ? "selected" : ""}>开放注册（GitHub 直接加入）</option>
                </select></label>
                <label class="is-wide">社区公告<textarea class="cx-input" name="announcement" rows="3" maxlength="600" ${ctx.isAdmin() ? "" : "disabled"}>${esc(String(raw.announcement || ""))}</textarea></label>
                <label class="cx-check"><input type="checkbox" name="requireReview" ${raw.requireReview ? "checked" : ""} ${ctx.isAdmin() ? "" : "disabled"}/> 发布需要人工审核</label>
                <label class="cx-check"><input type="checkbox" name="memberLogin" ${raw.memberLogin ? "checked" : ""} ${ctx.isAdmin() ? "" : "disabled"}/> 允许社区成员登录</label>
                <label class="cx-check"><input type="checkbox" name="allowPublishing" ${raw.allowPublishing ? "checked" : ""} ${ctx.isAdmin() ? "" : "disabled"}/> 允许发布新内容</label>
              </div>
            </section>
            <section class="cx-publish-card">
              <h2>配额与存储</h2>
              <div class="cx-form-grid">
                <label>每日作品数<input class="cx-input" type="number" name="maxPostsPerDay" min="1" max="100" value="${Number(settings.settings.maxPostsPerDay || 5)}" ${ctx.isAdmin() ? "" : "disabled"}/></label>
                <label>每日评论数<input class="cx-input" type="number" name="maxCommentsPerDay" min="1" max="500" value="${Number(settings.settings.maxCommentsPerDay || 60)}" ${ctx.isAdmin() ? "" : "disabled"}/></label>
                <label>每用户内容包上限<input class="cx-input" type="number" name="maxPackagesPerUser" min="1" max="500" value="${Number(settings.settings.maxPackagesPerUser || 40)}" ${ctx.isAdmin() ? "" : "disabled"}/></label>
                <label>单文件上传上限（MB）<input class="cx-input" type="number" name="maxUploadMB" min="1" max="32" value="${Math.round(Number(settings.settings.maxUploadBytes || 0) / 1024 / 1024)}" ${ctx.isAdmin() ? "" : "disabled"}/></label>
                <label>每用户存储上限（MB）<input class="cx-input" type="number" name="maxStorageMB" min="1" max="1024" value="${Math.round(Number(settings.settings.maxUserStorageBytes || 0) / 1024 / 1024)}" ${ctx.isAdmin() ? "" : "disabled"}/></label>
              </div>
              <p class="cx-hint">R2 免费额度有限，请按实际需要设置配额；社区总存储可在审计页查看。</p>
              ${ctx.isAdmin() ? `<button class="cx-btn is-primary" type="submit">保存设置</button>` : `<p class="cx-hint">只有管理员可以修改社区设置。</p>`}
              <p class="cx-hint" data-admin-msg></p>
            </section>
          </form>
        `);
      } else {
        const [result, statsResult] = await Promise.all([api.adminGetAudit(1), api.adminGetStats()]);
        if (ctx.isStale(token)) return;
        const stats = statsResult.stats;
        ctx.setBody(`
          <section class="cx-page-head"><div><p class="cx-eyebrow">Audit</p><h1>审核中心</h1><p>所有重要操作都会写入审计日志：审核、举报处理、角色、设置。</p></div></section>
          ${tabs}
          <section class="cx-panel">
            <div class="cx-section-head"><div><p class="cx-eyebrow">Overview</p><h2>社区概览</h2></div></div>
            <div class="cx-admin-stats">
              <div><b>${Number(stats.accounts || 0)}</b><span>活跃账号</span></div>
              <div><b>${Number(stats.creators || 0)}</b><span>创作者资料</span></div>
              <div><b>${Number(stats.publishedPosts || 0)}</b><span>已发布作品</span></div>
              <div><b>${Number(stats.pendingReview || 0)}</b><span>待审核</span></div>
              <div><b>${Number(stats.openReports || 0)}</b><span>待处理举报</span></div>
              <div><b>${Number(stats.assetFiles || 0)}</b><span>社区图片</span></div>
              <div><b>${Number(stats.packages || 0)}</b><span>内容包</span></div>
              <div><b>${bytesText(Number(stats.storageBytes || 0))}</b><span>R2 已用存储</span></div>
            </div>
            <p class="cx-hint">R2 免费额度不是无限空间。社区总存储包含图片与内容包；单个用户用量可在用户资料中查看。</p>
          </section>
          <div class="cx-audit-list">
            ${(result.items as Array<Record<string, unknown>>).map(
              (log) => `<article class="cx-audit-row">
                <span>${esc(String(log.action || ""))}</span>
                <div><b>${esc(String(log.actorName || "系统"))}</b><em>${esc(String(log.targetType || ""))} ${esc(String(log.targetId || ""))}</em></div>
                <time>${timeAgo(Number(log.createdAt || 0))}</time>
              </article>`,
            ).join("") || ctx.emptyState("还没有审计记录", "管理操作会出现在这里。", "▤")}
          </div>
        `);
      }
    } catch (error) {
      if (!ctx.isStale(token)) ctx.showError(error);
    }
  };

export const reviewModerationImpl = async (
  ctx: CommunityContext,
  postId: string,
  action: string,
  defaultNote = "",
) => {
    const value = await modal(ctx.win, {
      title: "审核操作",
      body: `<div class="cx-form"><label>备注（作者可见）<textarea class="cx-input" rows="3" maxlength="600" data-review-note placeholder="${esc(defaultNote)}"></textarea></label></div>`,
      actions: [{ label: "取消", value: "" }, { label: "执行", value: action, primary: true, danger: action === "delete" }],
    });
    if (value !== action) return;
    const note = ctx.win.querySelector<HTMLTextAreaElement>("[data-review-note]")?.value || defaultNote;
    try {
      await api.adminReviewPost(postId, action, note);
      ctx.toast("审核操作已执行");
      await loadModerationImpl(ctx);
    } catch (error) {
      ctx.toast(error instanceof Error ? error.message : "操作失败");
    }
  };

export const reviewReportImpl = async (
  ctx: CommunityContext,
  reportId: string,
  action: string,
) => {
    const value = await modal(ctx.win, {
      title: "处理举报",
      body: `<div class="cx-form"><label>处理说明<textarea class="cx-input" rows="3" maxlength="600" data-report-resolution placeholder="会记录到审计日志，并在需要时通知作者"></textarea></label></div>`,
      actions: [{ label: "取消", value: "" }, { label: "确认处理", value: "go", primary: true, danger: action === "delete_post" || action === "restrict_user" }],
    });
    if (value !== "go") return;
    const resolution = ctx.win.querySelector<HTMLTextAreaElement>("[data-report-resolution]")?.value || "";
    try {
      const result = await api.adminReviewReport(reportId, action, resolution);
      ctx.toast(result.message);
      await loadModerationImpl(ctx);
    } catch (error) {
      ctx.toast(error instanceof Error ? error.message : "操作失败");
    }
  };

export const onCommunityChangeImpl = (ctx: CommunityContext) => {
    const view = ctx.getView();
    const creationsTab = ctx.getCreationsTab();
    if (view.kind === "tab" && view.tab === "creations" && creationsTab === "installed") {
      void loadCreations(ctx, "installed");
    }
  };
