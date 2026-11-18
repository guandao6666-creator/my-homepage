/**
 * Guandao OS 1.6 · Guandao Community · 发布 / 编辑 / 新版本（批次 3）
 *
 * 由 community.ts 的 initCommunity 闭包迁出；通过 CommunityContext 读写外层状态，
 * HTML 模板、字段名、localStorage 键与事件行为保持与迁移前完全一致。
 */
import { allThemes, findTheme, readThemeState } from "../themes";
import { captureCurrentWorkspace } from "../workspaces";
import { communityWidgetConfigs } from "../widgetstore";
import * as api from "../../community/api";
import type { PostType } from "../../community/api";
import {
  CATEGORY_LABEL,
  LICENSE_OPTIONS,
  WIDGET_TYPES,
  WIDGET_TYPE_LABEL,
  compatibilityCheck,
  nextVersion,
  slugify,
  validateManifestClient,
  type Manifest,
  type ThemeConfig,
  type WidgetConfig,
  type WorkspaceConfig,
} from "../../community/manifest";
import { TYPE_GLYPH, TYPE_LABEL } from "./constants";
import { clampText, esc, skeleton } from "./ui";
import { licenseName, loadDetailImpl } from "./detail";
import { safeUrl } from "../../html";
import type { Ctx } from "../core";
import type { CommunityContext } from "./context";
import type { Post, PublishState } from "./types";

  const newPublishState = (mode: PublishState["mode"], type: PostType = "theme"): PublishState => ({
    mode,
    type,
    manifest: null,
    manifestError: "",
    cover: null,
    previews: [],
    wallpapers: [],
    previewsChanged: false,
    wallpapersChanged: false,
    coverChanged: false,
  });

export const loadPublishImpl = async (
  ctx: CommunityContext,
  options: { editId?: string; versionOf?: string } = {},
) => {
    if (ctx.needLogin()) return;
    ctx.setActiveNav("");
    const token = ctx.nextToken();
    ctx.setBody(skeleton("正在准备发布…"));
    try {
      await ctx.ensureMeta();
      if (options.versionOf) {
        const data = await api.getPost(options.versionOf);
        if (data.post.author.id !== ctx.getMeta()?.viewer?.id) throw new Error("只能为自己的作品发布新版本");
        let manifest: Manifest | null = null;
        if (data.package) {
          const verified = await api.fetchVerifiedPackage(options.versionOf, undefined);
          manifest = verified.manifest as unknown as Manifest;
        }
        if (ctx.isStale(token)) return;
        ctx.setVersionState({ post: data.post, manifest, baseVersion: data.post.version });
        ctx.setPublishState({ ...newPublishState("version", data.post.type), manifest });
        ctx.setView({ kind: "publish", versionOf: options.versionOf });
        paintVersionFormImpl(ctx);
        return;
      }
      if (options.editId) {
        const data = await api.getPost(options.editId);
        if (!data.viewer.isOwner) throw new Error("只能编辑自己的作品");
        let manifest: Manifest | null = (data.post.draftManifest as unknown as Manifest) || null;
        if (!manifest && data.package) {
          try {
            const verified = await api.fetchVerifiedPackage(options.editId);
            manifest = verified.manifest as unknown as Manifest;
          } catch {
            manifest = null;
          }
        }
        if (ctx.isStale(token)) return;
        ctx.setPublishState({
          ...newPublishState("edit", data.post.type),
          postId: data.post.id,
          manifest,
        });
        ctx.setView({ kind: "publish", editId: options.editId });
        paintPublishFormImpl(ctx, data.post);
        return;
      }
      ctx.setPublishState((window as unknown as { __CX_PUBLISH?: PublishState }).__CX_PUBLISH || newPublishState("create", "theme"));
      ctx.setView({ kind: "publish" });
      paintPublishFormImpl(ctx, null);
    } catch (error) {
      if (!ctx.isStale(token)) ctx.showError(error);
    }
  };

export const paintPublishFormImpl = (ctx: CommunityContext, editing: Post | null) => {
    const publishState = ctx.getPublishState();
    if (!publishState) return;
    const state = publishState;
    const fixedType = state.type;
    ctx.setBody(`
      <button class="cx-back" type="button" data-action="back">← 返回</button>
      <section class="cx-page-head">
        <div><p class="cx-eyebrow">${editing ? "Edit Draft" : "Publish"}</p><h1>${editing ? "编辑草稿" : "发布作品"}</h1><p>作品会先经过结构、图片与兼容性校验；${ctx.getMeta()?.requireReview ? "发布后进入人工审核。" : "管理员已关闭前置审核。"}</p></div>
        <span class="cx-publish-progress">内容包 ${state.manifest ? "✓" : "—"} · 封面 ${state.cover || editing?.coverUrl ? "✓" : "—"}</span>
      </section>
      <form class="cx-publish" data-publish-form>
        <section class="cx-publish-card">
          <h2>1 · 作品类型</h2>
          <div class="cx-type-picker">
            ${Object.entries(TYPE_LABEL).map(([id, label]) => `<button type="button" class="cx-type-choice ${fixedType === id ? "is-active" : ""}" data-publish-type="${id}" ${editing ? "disabled" : ""}><span>${TYPE_GLYPH[id]}</span><b>${label}</b></button>`).join("")}
          </div>
        </section>
        <section class="cx-publish-card">
          <h2>2 · 基本信息</h2>
          <div class="cx-form-grid">
            <label class="is-wide">作品名称<input class="cx-input" data-pf="title" maxlength="80" value="${esc(editing?.title || "")}" placeholder="例如：Ocean Depth 深海主题" required/></label>
            <label>分类<select class="cx-input" data-pf="category">${Object.entries(CATEGORY_LABEL[fixedType] || {}).map(([id, label]) => `<option value="${id}" ${editing?.category === id ? "selected" : ""}>${label}</option>`).join("")}</select></label>
            <label>可见性<select class="cx-input" data-pf="visibility"><option value="public" ${!editing || editing.visibility === "public" ? "selected" : ""}>公开</option><option value="unlisted" ${editing?.visibility === "unlisted" ? "selected" : ""}>不公开列出（有直链可访问）</option></select></label>
            <label class="is-wide">作品介绍<textarea class="cx-input" data-pf="description" rows="5" maxlength="8000" placeholder="说明设计灵感、使用方法与注意事项…">${esc(editing?.description || "")}</textarea></label>
            <label class="is-wide">标签（逗号分隔，最多 8 个）<input class="cx-input" data-pf="tags" value="${esc(editing?.tags.join(", ") || "")}" placeholder="深色, 海洋, 极简"/></label>
            <label>许可证<select class="cx-input" data-pf="license">${LICENSE_OPTIONS.map((license) => `<option value="${license.id}" ${editing?.license === license.id ? "selected" : ""}>${esc(license.name)}</option>`).join("")}</select></label>
            <label class="is-wide">自定义授权说明<input class="cx-input" data-pf="licenseNote" maxlength="600" value="${esc(editing?.licenseNote || "")}" placeholder="选择「自定义授权」时至少填写 10 个字符"/></label>
          </div>
        </section>
        <section class="cx-publish-card">
          <h2>3 · 封面与预览</h2>
          <div class="cx-upload-row">
            <div class="cx-upload-box" data-upload-box="cover">
              <span class="cx-upload-preview" data-cover-preview>${editing?.coverUrl ? `<img src="${safeUrl(editing.coverUrl)}" alt=""/>` : `<b>＋</b><em>上传封面</em>`}</span>
              <button type="button" class="cx-btn is-small" data-action="upload-cover">选择图片</button>
              <input type="file" accept="image/jpeg,image/png,image/webp" hidden data-file-cover/>
            </div>
            <div class="cx-upload-box is-wide">
              <div class="cx-upload-previews" data-preview-list>${editing ? dataUrlPlaceholder(editing) : `<em>还没有预览图</em>`}</div>
              <button type="button" class="cx-btn is-small" data-action="upload-previews">添加预览图（最多 6 张）</button>
              <input type="file" accept="image/jpeg,image/png,image/webp" multiple hidden data-file-previews/>
            </div>
          </div>
          ${fixedType === "wallpaper" ? `<div class="cx-upload-box is-wide"><div class="cx-upload-previews" data-wall-list>${editing ? "<em>已上传的壁纸</em>" : "<em>还没有壁纸</em>"}</div><button type="button" class="cx-btn is-small" data-action="upload-wallpapers">添加壁纸图片（最多 8 张）</button><input type="file" accept="image/jpeg,image/png,image/webp" multiple hidden data-file-wallpapers/></div>` : ""}
          <p class="cx-hint">图片会在浏览器内压缩并生成缩略图；服务端会按文件头验证真实格式，SVG / HTML 不能上传。</p>
        </section>
        <section class="cx-publish-card">
          <h2>4 · 内容包</h2>
          ${publishPackageFields(fixedType)}
          <div class="cx-manifest-bar">
            <button type="button" class="cx-btn" data-action="generate-manifest">从当前桌面生成配置</button>
            <button type="button" class="cx-btn is-ghost" data-action="import-manifest">导入 JSON 内容包</button>
            <input type="file" accept="application/json,.json" hidden data-file-manifest/>
          </div>
          <div class="cx-manifest-box" data-manifest-box>${manifestSummaryImpl(state.manifest, state.manifestError)}</div>
        </section>
        <section class="cx-publish-card">
          <h2>5 · 兼容性与授权</h2>
          <div class="cx-form-grid">
            <label>最低系统版本<select class="cx-input" data-pf="compat-min"><option value="1.3.0" ${editing?.compatibility.minimum === "1.3.0" ? "selected" : ""}>1.3.0</option><option value="1.4.0" ${editing?.compatibility.minimum === "1.4.0" ? "selected" : ""}>1.4.0</option><option value="1.5.0" ${editing?.compatibility.minimum === "1.5.0" ? "selected" : ""}>1.5.0</option><option value="1.6.0" ${!editing || editing.compatibility.minimum === "1.6.0" ? "selected" : ""}>1.6.0</option></select></label>
            <label>最高系统版本（可选）<input class="cx-input" data-pf="compat-max" value="${esc(editing?.compatibility.maximum || "")}" placeholder="留空表示不限制"/></label>
            ${fixedType === "wallpaper" ? `<label>图片比例<select class="cx-input" data-pf="ratio"><option>16:9</option><option>16:10</option><option>21:9</option><option>4:3</option><option>3:2</option><option>9:16</option><option>1:1</option></select></label>` : ""}
            ${fixedType === "widget" ? widgetFields(editing) : ""}
            ${fixedType === "workspace" ? `<input type="hidden" data-pf="workspace-name" value="${esc(editing?.title || "")}"/>` : ""}
            ${fixedType === "tutorial" ? `<label class="is-wide">教程正文（Markdown）<textarea class="cx-input" data-pf="tutorial" rows="12" maxlength="20000" placeholder="## 如何布置一个专注桌面…">${esc((editing?.draftManifest?.configuration as Record<string, unknown> | undefined)?.content as string || "")}</textarea></label>` : ""}
          </div>
          <label class="cx-rights"><input type="checkbox" data-pf="rights" ${editing?.rightsConfirmed ? "checked" : ""}/> 我确认拥有该作品的发布与分享权利，并已选择许可证；不包含未经授权的商业壁纸、音乐或其他资源。</label>
          <div class="cx-publish-actions">
            <button type="button" class="cx-btn" data-action="save-draft">保存草稿</button>
            <button type="submit" class="cx-btn is-primary" data-action="submit-publish">${ctx.getMeta()?.requireReview ? "提交审核" : "发布作品"}</button>
          </div>
          <p class="cx-hint" data-publish-msg></p>
        </section>
      </form>
    `);
    if (state.manifest) {
      const box = ctx.win.querySelector<HTMLElement>("[data-manifest-box]");
      if (box) box.innerHTML = manifestSummaryImpl(state.manifest, state.manifestError);
    }
    paintPublishAssetsImpl(ctx);
  };

  const dataUrlPlaceholder = (post: Post) => `<em>保留现有预览图；重新上传会替换。</em>`;

  const widgetFields = (editing: Post | null) => {
    const config = (editing?.draftManifest?.configuration || {}) as WidgetConfig;
    const props = (config.props || {}) as Record<string, string | number | boolean>;
    return `
      <label>组件类型<select class="cx-input" data-pf="w-type">${WIDGET_TYPES.map((type) => `<option value="${type}" ${config.widgetType === type ? "selected" : ""}>${WIDGET_TYPE_LABEL[type]}</option>`).join("")}</select></label>
      <label>主色<input class="cx-input" type="color" data-pf="w-accent" value="${esc(String(props.accent || "#6f8cff"))}"/></label>
      <label>标签<input class="cx-input" data-pf="w-label" maxlength="24" value="${esc(String(props.label || ""))}" placeholder="组件上显示的文字"/></label>
      <label>语录正文<input class="cx-input" data-pf="w-text" maxlength="120" value="${esc(String(props.text || ""))}" placeholder="仅语录类型使用"/></label>
      <label>语录作者<input class="cx-input" data-pf="w-author" maxlength="32" value="${esc(String(props.author || ""))}"/></label>
      <label>天气城市<input class="cx-input" data-pf="w-city" maxlength="24" value="${esc(String(props.city || "大连"))}"/></label>
      <label>专注分钟<input class="cx-input" type="number" data-pf="w-minutes" min="5" max="120" value="${esc(String(props.minutes || 25))}"/></label>
      <label>时钟样式<select class="cx-input" data-pf="w-style"><option value="digital" ${props.style !== "analog" ? "selected" : ""}>数字</option><option value="analog" ${props.style === "analog" ? "selected" : ""}>指针</option></select></label>
    `;
  };

  const publishPackageFields = (type: PostType) => {
    if (type === "wallpaper") return `<p class="cx-hint">壁纸作品会自动根据上传图片生成内容包，无需单独上传 JSON。</p>`;
    if (type === "tutorial") return `<p class="cx-hint">教程正文会作为内容包保存，渲染时先整体转义再支持安全 Markdown。</p>`;
    return `<p class="cx-hint">支持导入符合社区 Manifest 规范的 JSON；也可以点下方按钮从当前桌面生成。</p>`;
  };

export const manifestSummaryImpl = (manifest: Manifest | null, error: string) => {
    if (error) return `<div class="cx-manifest-error">✕ ${esc(error)}</div>`;
    if (!manifest) return `<div class="cx-manifest-empty">还没有内容包。导入 JSON，或从当前桌面生成。</div>`;
    const check = validateManifestClient(manifest);
    const compat = compatibilityCheck(manifest.compatibility);
    return `<div class="cx-manifest-ok">
      <div><b>${esc(manifest.name)}</b><span>${TYPE_LABEL[manifest.type] || manifest.type} · v${esc(manifest.version)} · ${esc(manifest.packageId)}</span></div>
      <div class="cx-manifest-tags"><span>${compat.ok ? "✓ 兼容" : "✕ 不兼容"}</span><span>${esc(licenseName(manifest.license))}</span><span>${check.ok ? "结构校验通过" : check.errors[0]}</span></div>
    </div>`;
  };

export const paintPublishAssetsImpl = (ctx: CommunityContext) => {
    const publishState = ctx.getPublishState();
    if (!publishState) return;
    const state = publishState;
    const coverBox = ctx.win.querySelector<HTMLElement>("[data-cover-preview]");
    if (coverBox) {
      coverBox.innerHTML = state.cover
        ? `<img src="${safeUrl(`/api/community/media/${state.cover.id}`)}" alt=""/>`
        : coverBox.querySelector("img")?.outerHTML || `<b>＋</b><em>上传封面</em>`;
    }
    const previews = ctx.win.querySelector<HTMLElement>("[data-preview-list]");
    if (previews) {
      previews.innerHTML = state.previews.length
        ? state.previews.map((asset, index) => `<span class="cx-upload-thumb"><img src="${safeUrl(`/api/community/media/${asset.thumbId || asset.id}`)}" alt=""/><button type="button" data-remove-asset="${index}" data-asset-kind="preview">×</button></span>`).join("")
        : `<em>还没有预览图</em>`;
    }
    const walls = ctx.win.querySelector<HTMLElement>("[data-wall-list]");
    if (walls) {
      walls.innerHTML = state.wallpapers.length
        ? state.wallpapers.map((asset, index) => `<span class="cx-upload-thumb"><img src="${safeUrl(`/api/community/media/${asset.thumbId || asset.id}`)}" alt=""/><button type="button" data-remove-asset="${index}" data-asset-kind="wallpaper">×</button></span>`).join("")
        : `<em>还没有壁纸</em>`;
    }
  };

const readFormValue = (ctx: CommunityContext, key: string) =>
    ctx.win.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(`[data-pf="${key}"]`)?.value ?? "";

const readChecked = (ctx: CommunityContext, key: string) =>
    ctx.win.querySelector<HTMLInputElement>(`[data-pf="${key}"]`)?.checked ?? false;

export const buildManifestImpl = (
  ctx: CommunityContext,
  core: Ctx,
  type: PostType,
): Manifest | null => {
    const publishState = ctx.getPublishState();
    if (!publishState) return null;
    const versionState = ctx.getVersionState();
    const meta = ctx.getMeta();
    const title = clampText(readFormValue(ctx, "title") || versionState?.post.title || "", 80);
    if (!title) {
      publishState.manifestError = "请先填写作品名称";
      return null;
    }
    const version = publishState.manifest?.version || versionState?.post.version || "1.0.0";
    const packageId = publishState.manifest?.packageId || `${slugify(title)}-${Date.now().toString(36).slice(-4)}`;
    const license = readFormValue(ctx, "license") || versionState?.post.license || "CC-BY-4.0";
    const compatibility = {
      minimum: readFormValue(ctx, "compat-min") || versionState?.post.compatibility.minimum || "1.3.0",
      ...(readFormValue(ctx, "compat-max") || versionState?.post.compatibility.maximum
        ? { maximum: readFormValue(ctx, "compat-max") || versionState?.post.compatibility.maximum }
        : {}),
    };
    const author = meta?.viewer?.displayName || "创作者";
    const base = {
      schemaVersion: 1 as const,
      packageId,
      type,
      name: title,
      version,
      author,
      description: clampText(readFormValue(ctx, "description") || versionState?.post.description || "", 600),
      compatibility,
      license,
      ...(license === "CUSTOM" ? { licenseNote: clampText(readFormValue(ctx, "licenseNote"), 600) } : {}),
      assets: [] as Array<{ kind: string; ref: string }>,
    };
    let configuration: Record<string, unknown>;
    if (type === "theme") {
      const theme = findTheme(readThemeState().current) || allThemes()[0];
      if (!theme) {
        publishState.manifestError = "没有可用的当前主题";
        return null;
      }
      configuration = {
        name: theme.name,
        en: theme.en,
        style: theme.style,
        desc: theme.desc,
        wall: theme.wall,
        mode: theme.mode,
        accent: theme.accent,
        accent2: theme.accent2,
        material: theme.material,
        radius: theme.radius,
        darken: theme.darken,
        dock: theme.dock,
        font: theme.font,
        grain: theme.grain,
        tags: theme.tags,
      };
    } else if (type === "widget") {
      const widgetType = readFormValue(ctx, "w-type") || "clock";
      const props: Record<string, string | number | boolean> = {
        accent: readFormValue(ctx, "w-accent") || "#6f8cff",
        label: clampText(readFormValue(ctx, "w-label"), 24),
      };
      if (widgetType === "quote") {
        props.text = clampText(readFormValue(ctx, "w-text"), 120);
        props.author = clampText(readFormValue(ctx, "w-author"), 32);
      }
      if (widgetType === "weather") props.city = clampText(readFormValue(ctx, "w-city"), 24);
      if (widgetType === "focus") props.minutes = Math.max(5, Math.min(120, Number(readFormValue(ctx, "w-minutes")) || 25));
      if (widgetType === "clock") props.style = readFormValue(ctx, "w-style") || "digital";
      const permissionMap: Record<string, string[]> = {
        clock: ["time", "date"], calendar: ["date"], weather: ["weather"], focus: ["time"],
        quote: ["none"], photo: ["none"], music: ["music"], system: ["system"],
        productivity: ["none"], decorative: ["none"],
      };
      configuration = { widgetType, props, permissions: permissionMap[widgetType] || ["none"], dependencies: [] };
    } else if (type === "workspace") {
      const snapshot = captureCurrentWorkspace(core);
      configuration = {
        name: clampText(snapshot.name.replace(/\s*(副本|·.*)$/, ""), 24) || "社区工作空间",
        description: clampText(readFormValue(ctx, "description"), 200),
        themeId: snapshot.theme,
        wallId: snapshot.wall,
        dock: snapshot.dock,
        shortcuts: snapshot.shortcuts,
        openApps: snapshot.openApps,
        widgets: snapshot.widgets,
        dnd: snapshot.dnd,
      };
    } else if (type === "wallpaper") {
      configuration = {
        collectionName: clampText(title, 40),
        ratio: readFormValue(ctx, "ratio") || "16:9",
        items: publishState.wallpapers.map(() => ({ caption: "" })),
      };
    } else {
      configuration = { content: clampText(readFormValue(ctx, "tutorial"), 20000) };
    }
    const manifest = { ...base, configuration } as unknown as Manifest;
    const check = validateManifestClient(manifest, type);
    if (!check.ok) {
      publishState.manifestError = check.errors.join("；");
      return null;
    }
    publishState.manifestError = "";
    return manifest;
  };

export const paintVersionFormImpl = (ctx: CommunityContext) => {
    const versionState = ctx.getVersionState();
    if (!versionState) return;
    const { post, manifest, baseVersion } = versionState;
    ctx.setBody(`
      <button class="cx-back" type="button" data-action="back">← 返回</button>
      <section class="cx-page-head"><div><p class="cx-eyebrow">New Version</p><h1>发布新版本</h1><p>${esc(post.title)} · 当前 v${esc(baseVersion)}。历史版本会保留，可随时回退。</p></div></section>
      <form class="cx-publish" data-version-form>
        <section class="cx-publish-card">
          <h2>版本信息</h2>
          <div class="cx-form-grid">
            <label>新版本号<input class="cx-input" data-vf="version" value="${esc(nextVersion(baseVersion))}" required/></label>
            <label class="is-wide">更新说明<textarea class="cx-input" data-vf="changelog" rows="4" maxlength="2000" placeholder="这个版本改了什么？">${""}</textarea></label>
          </div>
          <div class="cx-manifest-bar">
            <button type="button" class="cx-btn" data-action="version-generate">从当前桌面生成新配置</button>
            <button type="button" class="cx-btn is-ghost" data-action="version-import">导入 JSON 内容包</button>
            <input type="file" accept="application/json,.json" hidden data-file-version/>
          </div>
          <div class="cx-manifest-box" data-version-manifest>${manifestSummaryImpl(manifest, "")}</div>
          <div class="cx-publish-actions">
            <button type="submit" class="cx-btn is-primary">${ctx.getMeta()?.requireReview ? "提交新版本审核" : "发布新版本"}</button>
          </div>
          <p class="cx-hint" data-version-msg></p>
        </section>
      </form>
    `);
  };

export const submitPublishImpl = async (
  ctx: CommunityContext,
  core: Ctx,
  publish: boolean,
) => {
    const publishState = ctx.getPublishState();
    if (!publishState) return;
    const msg = ctx.win.querySelector<HTMLElement>("[data-publish-msg]");
    const setMsg = (text: string) => {
      if (msg) msg.textContent = text;
    };
    const title = clampText(readFormValue(ctx, "title"), 80);
    if (!title) {
      setMsg("请填写作品名称");
      return;
    }
    const description = readFormValue(ctx, "description");
    const tags = readFormValue(ctx, "tags").split(/[,，]/).map((tag) => tag.trim()).filter(Boolean).slice(0, 8);
    const license = readFormValue(ctx, "license") || "CC-BY-4.0";
    const licenseNote = readFormValue(ctx, "licenseNote");
    const category = readFormValue(ctx, "category") || "other";
    const visibility = readFormValue(ctx, "visibility") || "public";
    const rightsConfirmed = readChecked(ctx, "rights");
    if (publish && !rightsConfirmed) {
      setMsg("发布前必须确认你拥有相关作品的分享权利");
      return;
    }
    if (publish) {
      let manifest = publishState.manifest;
      if (!manifest || publishState.type === "wallpaper" || publishState.type === "tutorial") {
        manifest = buildManifestImpl(ctx, core, publishState.type);
        if (manifest) publishState.manifest = manifest;
      }
      if (!manifest) {
        setMsg(publishState.manifestError || "请先生成或导入内容包");
        return;
      }
      if (publishState.type === "wallpaper" && publishState.wallpapers.length === 0) {
        setMsg("壁纸作品至少上传一张图片");
        return;
      }
    }
    const payload: Record<string, unknown> = {
      type: publishState.type,
      title,
      description,
      category,
      tags,
      license,
      licenseNote,
      visibility,
      rightsConfirmed,
      publish,
      manifest: publishState.manifest || undefined,
      changelog: publishState.mode === "edit" ? "更新草稿" : "首次发布",
    };
    if (publishState.mode === "edit") {
      if (publishState.coverChanged) {
        payload.coverAssetId = publishState.cover?.id || null;
        payload.coverThumbAssetId = publishState.cover?.thumbId || null;
      }
      if (publishState.previewsChanged) {
        payload.previews = publishState.previews.map((asset) => ({ id: asset.id, thumbId: asset.thumbId }));
      }
      if (publishState.wallpapersChanged) {
        payload.wallpapers = publishState.wallpapers.map((asset) => ({ id: asset.id, thumbId: asset.thumbId }));
      }
    } else {
      payload.coverAssetId = publishState.cover?.id || null;
      payload.coverThumbAssetId = publishState.cover?.thumbId || null;
      payload.previews = publishState.previews.map((asset) => ({ id: asset.id, thumbId: asset.thumbId }));
      payload.wallpapers = publishState.wallpapers.map((asset) => ({ id: asset.id, thumbId: asset.thumbId }));
    }
    try {
      setMsg(publish ? "正在提交…" : "正在保存草稿…");
      if (publishState.mode === "edit" && publishState.postId) {
        await api.patchPost(publishState.postId, payload);
        if (publish) {
          const result = await api.publishPost(publishState.postId, {});
          ctx.toast(result.message);
        } else {
          ctx.toast("草稿已保存");
        }
        await loadDetailImpl(ctx, publishState.postId);
      } else {
        const result = await api.createPost(payload);
        ctx.toast(result.message);
        ctx.setPublishState(newPublishState("create", publishState.type));
        await loadDetailImpl(ctx, result.post.id);
      }
    } catch (error) {
      setMsg(error instanceof Error ? error.message : "提交失败");
    }
  };

export const submitVersionImpl = async (ctx: CommunityContext, core: Ctx) => {
    const versionState = ctx.getVersionState();
    const publishState = ctx.getPublishState();
    if (!versionState || !publishState) return;
    const msg = ctx.win.querySelector<HTMLElement>("[data-version-msg]");
    const setMsg = (text: string) => {
      if (msg) msg.textContent = text;
    };
    const version = readFormValue(ctx, "version");
    const changelog = readFormValue(ctx, "changelog");
    if (!version) return setMsg("请填写版本号");
    if (changelog.trim().length < 2) return setMsg("请填写更新说明");
    let manifest = versionState.manifest;
    if (!manifest) {
      manifest = buildManifestImpl(ctx, core, versionState.post.type);
      if (manifest) {
        manifest.version = version;
        versionState.manifest = manifest;
        const box = ctx.win.querySelector<HTMLElement>("[data-version-manifest]");
        if (box) box.innerHTML = manifestSummaryImpl(manifest, "");
      }
    }
    if (!manifest) return setMsg("请生成或导入新版本内容包");
    manifest.version = version;
    try {
      setMsg("正在提交新版本…");
      const result = await api.createVersion(versionState.post.id, { manifest, changelog });
      ctx.toast(result.message);
      await loadDetailImpl(ctx, versionState.post.id);
    } catch (error) {
      setMsg(error instanceof Error ? error.message : "发布失败");
    }
  };
