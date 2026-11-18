/**
 * Guandao OS 1.6 · Guandao Community · 互动 / 安装 / 管理流程（批次 4）
 *
 * 由 community.ts 的 initCommunity 闭包迁出；通过 CommunityContext 读写外层状态，
 * 事件监听器仍留在 community.ts，HTML / 文案 / 接口调用顺序保持不变。
 */
import { applyTheme, findTheme } from "../themes";
import { applyWorkspace, workspaceList } from "../workspaces";
import * as api from "../../community/api";
import {
  CATEGORY_LABEL,
  LICENSE_OPTIONS,
  WIDGET_TYPE_LABEL,
  compatibilityCheck,
  type ThemeConfig,
  type WidgetConfig,
  type WorkspaceConfig,
} from "../../community/manifest";
import {
  checkUpdate,
  getInstall,
  installFromServer,
  uninstallByPost,
} from "../../community/install";
import { REASON_LABEL } from "./constants";
import { detailPermissionText, esc, safeHex, safeWallId } from "./ui";
import {
  loadCreators,
  loadCreations,
  loadHome,
  loadMyFavorites,
} from "./loaders";
import { licenseName, loadDetailImpl } from "./detail";
import { loadPublishImpl } from "./publish";
import { modal, type Ctx } from "../core";
import type { CommunityContext } from "./context";
import type { Post } from "./types";

export const backToListImpl = (ctx: CommunityContext) => {
    const view = ctx.getView();
    const lastTab = ctx.getLastTab();
    const tab = view.kind === "detail" ? lastTab : view.kind === "creator" ? "creators" : "home";
    ctx.setActiveNav(tab);
    ctx.setView({ kind: "tab", tab });
    if (tab === "creators") void loadCreators(ctx);
    else if (tab === "creations") void loadCreations(ctx);
    else void loadHome(ctx);
  };

export const refreshPostButtonsImpl = (
  ctx: CommunityContext,
  id: string,
  liked: boolean,
  likeCount: number,
  favorited: boolean,
  favoriteCount: number,
) => {
    ctx.win.querySelectorAll<HTMLElement>(`[data-like="${id}"]`).forEach((node) => {
      node.classList.toggle("is-on", liked);
      const count = node.querySelector<HTMLElement>(`[data-like-count="${id}"]`);
      if (count) count.textContent = String(likeCount);
    });
    ctx.win.querySelectorAll<HTMLElement>(`[data-fav="${id}"]`).forEach((node) => {
      node.classList.toggle("is-on", favorited);
      const count = node.querySelector<HTMLElement>(`[data-fav-count="${id}"]`);
      if (count) count.textContent = String(favoriteCount);
    });
  };

export const toggleLikeImpl = async (ctx: CommunityContext, postId: string) => {
    const detailCache = ctx.getDetailCache();
    if (!ctx.getViewer()) {
      ctx.toast("请先登录再点赞");
      return;
    }
    try {
      const post = detailCache?.data.post.id === postId ? detailCache.data.post : null;
      if (post?.viewer.liked) {
        const result = await api.unlikePost(postId);
        post.viewer.liked = false;
        post.likeCount = result.likeCount;
        refreshPostButtonsImpl(ctx, postId, false, result.likeCount, post.viewer.favorited, post.favoriteCount);
      } else {
        const result = await api.likePost(postId);
        if (post) {
          post.viewer.liked = true;
          post.likeCount = result.likeCount;
          refreshPostButtonsImpl(ctx, postId, true, result.likeCount, post.viewer.favorited, post.favoriteCount);
        } else {
          ctx.win.querySelectorAll<HTMLElement>(`[data-like="${postId}"]`).forEach((node) => {
            node.classList.add("is-on");
            const count = node.querySelector<HTMLElement>(`[data-like-count="${postId}"]`);
            if (count) count.textContent = String(result.likeCount);
          });
        }
      }
    } catch (error) {
      ctx.toast(error instanceof Error ? error.message : "操作失败");
    }
  };

export const toggleFavoriteImpl = async (ctx: CommunityContext, postId: string) => {
    const detailCache = ctx.getDetailCache();
    const view = ctx.getView();
    if (!ctx.getViewer()) {
      ctx.toast("请先登录再收藏");
      return;
    }
    try {
      const post = detailCache?.data.post.id === postId ? detailCache.data.post : null;
      if (post?.viewer.favorited) {
        const result = await api.unfavoritePost(postId);
        post.viewer.favorited = false;
        post.favoriteCount = result.favoriteCount;
        refreshPostButtonsImpl(ctx, postId, post.viewer.liked, post.likeCount, false, result.favoriteCount);
        if (view.kind === "tab" && view.tab === "favorites") void loadMyFavorites(ctx);
        return;
      }

      const choice = await modal(ctx.win, {
        title: "收藏到收藏夹",
        body: `<div class="cx-form">
          <label>收藏夹名称（可新建）<input class="cx-input" data-fav-collection-input maxlength="32" value="default" placeholder="例如：灵感 / 学习 / 深色主题"/></label>
          <p class="cx-hint">收藏是私人数据，默认不公开。你可以用收藏夹给作品分类。</p>
        </div>`,
        actions: [{ label: "取消", value: "" }, { label: "收藏", value: "fav", primary: true }],
      });
      if (choice !== "fav") return;
      const collection =
        (ctx.win.querySelector<HTMLInputElement>("[data-fav-collection-input]")?.value || "default").trim().slice(0, 32) ||
        "default";
      const result = await api.favoritePost(postId, collection);
      if (post) {
        post.viewer.favorited = true;
        post.favoriteCount = result.favoriteCount;
        refreshPostButtonsImpl(ctx, postId, post.viewer.liked, post.likeCount, true, result.favoriteCount);
      } else {
        ctx.win.querySelectorAll<HTMLElement>(`[data-fav="${postId}"]`).forEach((node) => {
          node.classList.add("is-on");
          const count = node.querySelector<HTMLElement>(`[data-fav-count="${postId}"]`);
          if (count) count.textContent = String(result.favoriteCount);
        });
      }
      ctx.toast(`已收藏到「${collection}」`);
      if (view.kind === "tab" && view.tab === "favorites") void loadMyFavorites(ctx);
    } catch (error) {
      ctx.toast(error instanceof Error ? error.message : "操作失败");
    }
  };

export const installFlowImpl = async (ctx: CommunityContext, core: Ctx) => {
    const detailCache = ctx.getDetailCache();
    if (!detailCache) return;
    const { data, manifest } = detailCache;
    const post = data.post;
    if (!manifest) {
      ctx.toast("这个作品还没有可安装的内容包");
      return;
    }
    const compat = compatibilityCheck(manifest.compatibility);
    if (!compat.ok) {
      ctx.toast(compat.reason);
      return;
    }
    const details: string[] = [];
    if (post.type === "theme") {
      const config = manifest.configuration as ThemeConfig;
      details.push(`壁纸：${safeWallId(config.wall)}`, `强调色：${safeHex(config.accent)} / ${safeHex(config.accent2)}`, `材质：${config.material}`, `圆角：${config.radius}`, `程序坞：${config.dock?.size || 46}px`, "将写入主题中心的自定义主题，不会覆盖其他主题。");
    } else if (post.type === "widget") {
      const config = manifest.configuration as WidgetConfig;
      details.push(`组件类型：${WIDGET_TYPE_LABEL[config.widgetType] || config.widgetType}`, `请求权限：${detailPermissionText(config.permissions)}`, "渲染方式：系统声明式组件，不执行社区脚本。");
    } else if (post.type === "workspace") {
      const config = manifest.configuration as WorkspaceConfig;
      const missingApps = (config.openApps || []).filter((id) => !core.APPS[id]);
      const missingWidgets = Object.keys(config.widgets || {}).filter((id) => !core.widgets.ids.includes(id));
      details.push(`将新增一套工作空间，不会覆盖当前桌面。`, `应用：${(config.openApps || []).length} 个${missingApps.length ? `，缺少 ${missingApps.length} 个（会跳过）` : ""}`, `组件：${Object.keys(config.widgets || {}).length} 个${missingWidgets.length ? `，缺少 ${missingWidgets.length} 个（会跳过）` : ""}`, "导入前会为当前工作空间创建保护性快照。");
    } else if (post.type === "wallpaper") {
      details.push("将下载壁纸并保存到本机壁纸库，不会上传你的文件。");
    }
    const value = await modal(ctx.win, {
      title: `安装「${post.title}」`,
      body: `<div class="cx-install-modal">
        <p><b>作者</b> ${esc(post.author.displayName)} · <b>版本</b> v${esc(post.version)} · <b>许可证</b> ${esc(licenseName(post.license))}</p>
        <ul>${details.map((line) => `<li>${esc(line)}</li>`).join("")}</ul>
        <p class="cx-hint">安装包会先做 SHA-256 校验与版本兼容检查；校验失败会中止安装。</p>
      </div>`,
      actions: [
        { label: "取消", value: "" },
        ...(post.type === "theme" ? [{ label: "仅安装", value: "install" }] : []),
        { label: post.type === "theme" ? "安装并应用" : "确认安装", value: "apply", primary: true },
      ],
      wide: true,
    });
    if (value !== "install" && value !== "apply") return;
    const result = await installFromServer(post, core, { applyTheme: value === "apply" });
    if (!result.ok) {
      ctx.toast(result.message);
      return;
    }
    if (result.details?.length) {
      await modal(ctx.win, {
        title: "安装完成",
        body: `<div class="cx-install-modal"><p>${esc(result.message)}</p><ul>${result.details.map((line) => `<li>${esc(line)}</li>`).join("")}</ul></div>`,
        actions: [{ label: "完成", value: "ok", primary: true }],
      });
    } else {
      ctx.toast(result.message);
    }
    await loadDetailImpl(ctx, post.id);
  };

export const installVersionImpl = async (ctx: CommunityContext, core: Ctx, postId: string, version: string) => {
    const data = await api.getPost(postId);
    const result = await installFromServer(data.post, core, { version, applyTheme: true });
    ctx.toast(result.ok ? `已安装 v${version}` : result.message);
    if (result.ok) void loadDetailImpl(ctx, postId);
  };

export const newVersionFlowImpl = (ctx: CommunityContext, postId: string) => {
    void loadPublishImpl(ctx, { versionOf: postId });
  };

export const editPostFlowImpl = (ctx: CommunityContext, postId: string) => {
    void loadPublishImpl(ctx, { editId: postId });
  };

export const deletePostFlowImpl = async (ctx: CommunityContext, postId: string) => {
    const value = await modal(ctx.win, {
      title: "删除作品",
      body: `<p>删除后作品会从社区下线，图片与内容包将进入清理队列。这个操作不可撤销。</p>`,
      actions: [{ label: "取消", value: "" }, { label: "确认删除", value: "delete", danger: true, primary: true }],
    });
    if (value !== "delete") return;
    try {
      await api.deletePost(postId);
      ctx.toast("作品已删除");
      ctx.setView({ kind: "tab", tab: "creations" });
      void loadCreations(ctx, "works");
    } catch (error) {
      ctx.toast(error instanceof Error ? error.message : "删除失败");
    }
  };

export const withdrawFlowImpl = async (ctx: CommunityContext, postId: string) => {
    const value = await modal(ctx.win, {
      title: "撤回作品",
      body: `<p>撤回后作品会变为草稿，不再公开；已安装的用户仍保留本地副本。</p>`,
      actions: [{ label: "取消", value: "" }, { label: "撤回", value: "withdraw", primary: true }],
    });
    if (value !== "withdraw") return;
    try {
      await api.withdrawPost(postId);
      ctx.toast("作品已撤回为草稿");
      void loadCreations(ctx, "works");
    } catch (error) {
      ctx.toast(error instanceof Error ? error.message : "撤回失败");
    }
  };

export const editMetaFlowImpl = async (ctx: CommunityContext, post: Post) => {
    const view = ctx.getView();
    const value = await modal(ctx.win, {
      title: "编辑作品信息",
      body: `<div class="cx-form">
        <label>作品名称<input class="cx-input" data-meta-title maxlength="80" value="${esc(post.title)}"/></label>
        <label>作品介绍<textarea class="cx-input" data-meta-desc rows="4" maxlength="8000">${esc(post.description)}</textarea></label>
        <label>标签（逗号分隔）<input class="cx-input" data-meta-tags value="${esc(post.tags.join(", "))}"/></label>
        <label>分类<select class="cx-input" data-meta-category>${Object.entries(CATEGORY_LABEL[post.type] || {}).map(([id, label]) => `<option value="${id}" ${post.category === id ? "selected" : ""}>${label}</option>`).join("")}</select></label>
        <label>许可证<select class="cx-input" data-meta-license>${LICENSE_OPTIONS.map((license) => `<option value="${license.id}" ${post.license === license.id ? "selected" : ""}>${esc(license.name)}</option>`).join("")}</select></label>
        <label>自定义授权说明<input class="cx-input" data-meta-license-note maxlength="600" value="${esc(post.licenseNote)}"/></label>
        <p class="cx-hint">修改已发布作品会重新进入人工审核（管理员除外），审核通过前作品暂不公开。版本配置请使用「发布新版本」。</p>
      </div>`,
      actions: [{ label: "取消", value: "" }, { label: "保存修改", value: "save", primary: true }],
      wide: true,
    });
    if (value !== "save") return;
    const title = (ctx.win.querySelector<HTMLInputElement>("[data-meta-title]")?.value || "").trim();
    const description = ctx.win.querySelector<HTMLTextAreaElement>("[data-meta-desc]")?.value || "";
    const tags = (ctx.win.querySelector<HTMLInputElement>("[data-meta-tags]")?.value || "")
      .split(/[,，]/)
      .map((tag) => tag.trim())
      .filter(Boolean)
      .slice(0, 8);
    const category = ctx.win.querySelector<HTMLSelectElement>("[data-meta-category]")?.value || post.category;
    const license = ctx.win.querySelector<HTMLSelectElement>("[data-meta-license]")?.value || post.license;
    const licenseNote = ctx.win.querySelector<HTMLInputElement>("[data-meta-license-note]")?.value || "";
    if (!title) {
      ctx.toast("作品名称不能为空");
      return;
    }
    try {
      const result = await api.patchPost(post.id, { title, description, tags, category, license, licenseNote });
      ctx.toast(result.message || "作品信息已更新");
      if (view.kind === "detail") await loadDetailImpl(ctx, post.id);
      else await loadCreations(ctx, "works");
    } catch (error) {
      ctx.toast(error instanceof Error ? error.message : "保存失败");
    }
  };

export const submitReportImpl = async (ctx: CommunityContext, targetType: string, targetId: string) => {
    if (!ctx.getViewer()) {
      ctx.toast("请先登录");
      return;
    }
    const value = await modal(ctx.win, {
      title: "提交举报",
      body: `<div class="cx-form">
        <label>举报原因<select class="cx-input" data-report-reason>${Object.entries(REASON_LABEL).map(([id, label]) => `<option value="${id}">${label}</option>`).join("")}</select></label>
        <label>补充说明<textarea class="cx-input" rows="3" maxlength="1000" data-report-desc placeholder="请描述具体问题，方便审核员判断"></textarea></label>
        <p class="cx-hint">举报会提交给人工审核；不会自动公开你的身份，也不会自动隐藏内容。</p>
      </div>`,
      actions: [{ label: "取消", value: "" }, { label: "提交举报", value: "report", primary: true }],
    });
    if (value !== "report") return;
    const reason = ctx.win.querySelector<HTMLSelectElement>("[data-report-reason]")?.value || "other";
    const description = ctx.win.querySelector<HTMLTextAreaElement>("[data-report-desc]")?.value || "";
    try {
      if (targetType === "comment") await api.reportComment(targetId, reason, description);
      else await api.reportContent({ targetType, targetId, reason, description });
      ctx.toast("举报已提交，管理员会尽快处理");
    } catch (error) {
      ctx.toast(error instanceof Error ? error.message : "举报提交失败");
    }
  };

export const handleInstalledActionImpl = async (ctx: CommunityContext, core: Ctx, action: string, postId: string) => {
    const record = getInstall(postId);
    if (!record) {
      ctx.toast("本机没有这个安装记录");
      return;
    }
    try {
      if (action === "check-update") {
        const check = await checkUpdate(postId);
        if (!check.hasUpdate) {
          ctx.toast(`已是最新版本 v${record.version}`);
          return;
        }
        await modal(ctx.win, {
          title: "发现新版本",
          body: `<p>当前 v${esc(record.version)} → 最新 v${esc(check.latest || "")}</p><p>${esc(check.changelog || "作者没有填写更新说明。")}</p><p class="cx-hint">更新会保留历史版本，可回退。</p>`,
          actions: [{ label: "稍后", value: "" }, { label: "立即更新", value: "update", primary: true }],
        }).then((value) => {
          if (value === "update") void doUpdateImpl(ctx, core, postId);
        });
      } else if (action === "update") {
        await doUpdateImpl(ctx, core, postId);
      } else if (action === "rollback") {
        const data = await api.getPost(postId);
        const versions = data.versions;
        const value = await modal(ctx.win, {
          title: "版本历史 / 回退",
          body: `<div class="cx-menu-list">${versions
            .map((version) => `<button class="cx-menu-item g14-menu-item" data-mm="${esc(version.version)}"><b>v${esc(version.version)}</b><span>${esc(version.changelog || "无说明")}</span></button>`)
            .join("")}</div>`,
          actions: [{ label: "关闭", value: "" }],
        });
        if (!value) return;
        await installVersionImpl(ctx, core, postId, value);
      } else if (action === "reapply") {
        if (record.postType === "theme") {
          const theme = findTheme(record.localId);
          if (theme) {
            applyTheme(theme);
            ctx.toast("主题已应用");
          } else ctx.toast("本地主题已不存在，请重新安装");
        } else if (record.postType === "widget") {
          core.widgets.setEnabled(record.localId, true);
          ctx.toast("组件已重新添加到桌面");
        } else if (record.postType === "workspace") {
          const workspace = workspaceList().find((item) => item.id === record.localId);
          if (workspace) {
            void applyWorkspace(workspace.id, core);
            ctx.toast("正在切换工作空间");
          } else ctx.toast("本地工作空间已不存在");
        } else if (record.postType === "wallpaper") {
          const gos13 = (window as unknown as { GOS13?: { setWallpaper?: (id: string) => void } }).GOS13;
          try {
            gos13?.setWallpaper?.(record.localId);
            ctx.toast("壁纸已应用");
          } catch {
            ctx.toast("壁纸已不在本机，请重新安装");
          }
        }
      } else if (action === "uninstall") {
        const value = await modal(ctx.win, {
          title: "卸载社区资源",
          body: `<p>将从本机移除「${esc(record.title)}」。已应用的桌面效果会按系统原有逻辑恢复或保留。</p>`,
          actions: [{ label: "取消", value: "" }, { label: "卸载", value: "go", danger: true, primary: true }],
        });
        if (value !== "go") return;
        await uninstallByPost(postId, core);
        ctx.toast("已卸载");
        await loadCreations(ctx, "installed");
      }
    } catch (error) {
      ctx.toast(error instanceof Error ? error.message : "操作失败");
    }
  };

export const doUpdateImpl = async (ctx: CommunityContext, core: Ctx, postId: string) => {
    const check = await checkUpdate(postId);
    if (!check.hasUpdate) {
      ctx.toast("已经是最新版本");
      return;
    }
    const data = await api.getPost(postId);
    const result = await installFromServer(data.post, core, { applyTheme: false });
    ctx.toast(result.ok ? `已更新到 v${data.post.version}` : result.message);
    if (result.ok) await loadCreations(ctx, "installed");
  };

export const openPostFromEventImpl = (ctx: CommunityContext, target: HTMLElement) => {
    const view = ctx.getView();
    if (target.closest("button,a,input,textarea,select,[data-action]")) return false;
    const postButton = target.closest<HTMLElement>("[data-post]");
    if (postButton?.dataset.post) {
      ctx.setLastTab(view.kind === "tab" ? view.tab : ctx.getLastTab());
      void loadDetailImpl(ctx, postButton.dataset.post);
      return true;
    }
    return false;
  };
