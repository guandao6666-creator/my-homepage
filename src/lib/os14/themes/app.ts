/**
 * Guandao OS 6.2 · 主题中心界面（按需加载）。
 *
 * 主题的「运行时」（THEMES 数据、applyStoredTheme、预览/保存/导入导出）仍在 ../themes，
 * 启动时就要用；这里只放界面：主题列表、编辑器、预览条与事件绑定。
 * 拆出来之后 themes.css 也跟着 chunk 走，不再进入首屏 CSS。
 */
import {
  badge,
  bindTabs,
  emptyState,
  onBus,
  escapeHtml,
  modal,
  pickFile,
  readText,
  shell,
  type Ctx,
  type FontTone,
  type Material,
  type OsThemeMode,
  type RadiusStyle,
} from "../core";
import { safeUrl } from "../../html";
import { WALLPAPERS, wallpaperById } from "../../wallpapers";
import { ensureCss } from "../../ui/lazy-css";
import themeCssUrl from "../../../styles/desktop/themes.css?url";
import {
  allThemes,
  applyTheme,
  cancelPreview,
  commitPreview,
  deleteCustomTheme,
  exportTheme,
  findTheme,
  importThemeFile,
  normalizeTheme,
  previewTheme,
  resetTheme,
  readThemeState,
  saveCustomTheme,
  writeThemeState,
  type ThemeDef,
  type ThemeState,
} from "../themes";

/** 6.2：样式走运行时加载，load() 会等它就绪再渲染 */
export const stylesReady = ensureCss(themeCssUrl);

/* ============================================================
   主题中心界面
   ============================================================ */

let activeTab = "all";
let previewId = "";

const themePreview = (theme: ThemeDef) => {
  const wall = wallpaperById(theme.wall);
  const light = theme.mode === "light";
  return `
    <div class="g14-theme-prev ${light ? "is-light" : ""}" style="--tp-accent:${theme.accent};--tp-accent2:${theme.accent2}" data-radius="${theme.radius}">
      <img src="${safeUrl(wall.thumb)}" alt="" loading="lazy" />
      <span class="g14-tp-veil"></span>
      <span class="g14-tp-menubar"></span>
      <span class="g14-tp-win">
        <i class="g14-tp-dots"><b></b><b></b><b></b></i>
        <i class="g14-tp-line"></i><i class="g14-tp-line is-short"></i><i class="g14-tp-chip"></i>
      </span>
      <span class="g14-tp-widget"></span>
      <span class="g14-tp-dock"><i></i><i></i><i></i><i></i></span>
    </div>`;
};

const card = (theme: ThemeDef, st: ThemeState) => {
  const fav = st.favorites.includes(theme.id);
  const cur = st.current === theme.id;
  return `
    <article class="g14-theme-card ${cur ? "is-current" : ""}" data-theme="${escapeHtml(theme.id)}">
      <div class="g14-theme-shot">${themePreview(theme)}</div>
      <div class="g14-theme-meta">
        <div class="g14-theme-row">
          <h4>${escapeHtml(theme.name)} <span>${escapeHtml(theme.en)}</span></h4>
          <button class="g14-iconbtn ${fav ? "is-on" : ""}" type="button" data-fav="${escapeHtml(theme.id)}" title="收藏">${fav ? "★" : "☆"}</button>
        </div>
        <p class="g14-theme-style">${escapeHtml(theme.style)} · ${escapeHtml(theme.author)}</p>
        <p class="g14-theme-desc">${escapeHtml(theme.desc)}</p>
        <div class="g14-theme-tags">${theme.tags.map((t) => `<span>${escapeHtml(t)}</span>`).join("")}</div>
        <div class="g14-theme-actions">
          <button class="g14-btn is-primary" type="button" data-apply="${escapeHtml(theme.id)}">${cur ? "已应用" : "应用"}</button>
          <button class="g14-btn" type="button" data-prev="${escapeHtml(theme.id)}">预览</button>
          <button class="g14-btn is-ghost" type="button" data-detail="${escapeHtml(theme.id)}">详情</button>
        </div>
      </div>
    </article>`;
};

const editorForm = (theme?: ThemeDef) => {
  const t = theme ?? {
    name: "",
    en: "",
    wall: "aurora",
    mode: "dark" as OsThemeMode,
    accent: "#6f8cff",
    accent2: "#b06eff",
    material: "glass" as Material,
    radius: "round" as RadiusStyle,
    darken: 22,
    dock: { size: 46, magnify: 1.22, opacity: 0.55 },
    font: "sans" as FontTone,
    grain: false,
    desc: "",
  };
  const wallOpts = WALLPAPERS.map(
    (w) => `<option value="${w.id}" ${w.id === t.wall ? "selected" : ""}>${escapeHtml(w.name)} · ${escapeHtml(w.en)}</option>`,
  ).join("");
  return `
    <div class="g14-editor">
      <div class="g14-editor-row">
        <label>主题名称<input class="g14-input" data-f="name" maxlength="24" value="${escapeHtml(t.name)}" placeholder="例如：我的夜航" /></label>
        <label>风格描述<input class="g14-input" data-f="style" maxlength="20" value="${escapeHtml((t as ThemeDef).style ?? "自定义")}" placeholder="例如：冷色 · 夜间" /></label>
      </div>
      <label>壁纸<select class="g14-input" data-f="wall">${wallOpts}</select></label>
      <div class="g14-editor-row">
        <label>主强调色<input class="g14-color" type="color" data-f="accent" value="${t.accent}" /></label>
        <label>副强调色<input class="g14-color" type="color" data-f="accent2" value="${t.accent2}" /></label>
        <label>深色强度<input class="g14-range" type="range" data-f="darken" min="0" max="70" value="${t.darken}" /></label>
      </div>
      <div class="g14-editor-row">
        <label>明暗<select class="g14-input" data-f="mode">
          <option value="dark" ${t.mode === "dark" ? "selected" : ""}>深色</option>
          <option value="light" ${t.mode === "light" ? "selected" : ""}>浅色</option>
        </select></label>
        <label>窗口材质<select class="g14-input" data-f="material">
          <option value="glass" ${t.material === "glass" ? "selected" : ""}>玻璃</option>
          <option value="frost" ${t.material === "frost" ? "selected" : ""}>磨砂</option>
          <option value="solid" ${t.material === "solid" ? "selected" : ""}>实心</option>
        </select></label>
        <label>圆角<select class="g14-input" data-f="radius">
          <option value="soft" ${t.radius === "soft" ? "selected" : ""}>柔和</option>
          <option value="round" ${t.radius === "round" ? "selected" : ""}>圆润</option>
          <option value="sharp" ${t.radius === "sharp" ? "selected" : ""}>直角</option>
        </select></label>
      </div>
      <div class="g14-editor-row">
        <label>字体气质<select class="g14-input" data-f="font">
          <option value="sans" ${t.font === "sans" ? "selected" : ""}>无衬线</option>
          <option value="serif" ${t.font === "serif" ? "selected" : ""}>衬线</option>
          <option value="mono" ${t.font === "mono" ? "selected" : ""}>等宽</option>
        </select></label>
        <label>程序坞图标<input class="g14-range" type="range" data-f="dock.size" min="34" max="72" value="${t.dock.size}" /></label>
        <label class="g14-check"><input type="checkbox" data-f="grain" ${t.grain ? "checked" : ""}/> 颗粒质感</label>
      </div>
      <label>备注<textarea class="g14-input" data-f="desc" rows="2" maxlength="120" placeholder="一句话说明这套主题">${escapeHtml(t.desc ?? "")}</textarea></label>
      <div class="g14-editor-actions">
        <button class="g14-btn is-primary" type="button" data-save="${theme ? escapeHtml(theme.id) : "new"}">保存主题</button>
        <button class="g14-btn" type="button" data-editor-preview>用当前设置预览</button>
        ${theme ? `<button class="g14-btn is-danger is-ghost" type="button" data-del="${escapeHtml(theme.id)}">删除</button>` : ""}
      </div>
      <p class="g14-hint">自定义主题保存在本机浏览器；导入的配置会先校验字段与取值范围，不会执行任何脚本。</p>
    </div>`;
};

const readEditor = (root: HTMLElement) => {
  const val = (k: string) => root.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(`[data-f="${k}"]`)?.value ?? "";
  return normalizeTheme({
    id: "custom-new",
    name: val("name"),
    en: "自定义",
    style: val("style"),
    wall: val("wall"),
    accent: val("accent"),
    accent2: val("accent2"),
    mode: val("mode"),
    material: val("material"),
    radius: val("radius"),
    font: val("font"),
    darken: Number(val("darken")),
    grain: root.querySelector<HTMLInputElement>('[data-f="grain"]')?.checked ?? false,
    desc: val("desc"),
    dock: { size: Number(val("dock.size")), magnify: 1.2, opacity: 0.55 },
    author: "我",
    tags: ["自定义"],
  });
};

const renderThemeTab = (host: HTMLElement, st: ThemeState) => {
  const list = allThemes();
  if (activeTab === "editor") {
    host.innerHTML = `<div class="g14-pane-head"><h3>创建自定义主题</h3><p>先搭一套，再点「用当前设置预览」看整体效果。</p></div>${editorForm()}`;
    return;
  }
  if (activeTab === "mine") {
    const mine = st.custom;
    host.innerHTML = `
      <div class="g14-pane-head"><h3>我的主题</h3><p>共 ${mine.length} 套自定义主题，可导出为 JSON 分享。</p></div>
      ${
        mine.length
          ? `<div class="g14-theme-grid">${mine
              .map(
                (t) => `
            <article class="g14-theme-card" data-theme="${escapeHtml(t.id)}">
              <div class="g14-theme-shot">${themePreview(t)}</div>
              <div class="g14-theme-meta">
                <div class="g14-theme-row"><h4>${escapeHtml(t.name)} <span>自定义</span></h4></div>
                <p class="g14-theme-style">${escapeHtml(t.style)}</p>
                <div class="g14-theme-actions">
                  <button class="g14-btn is-primary" type="button" data-apply="${escapeHtml(t.id)}">应用</button>
                  <button class="g14-btn" type="button" data-edit="${escapeHtml(t.id)}">编辑</button>
                  <button class="g14-btn is-ghost" type="button" data-exp="${escapeHtml(t.id)}">导出</button>
                </div>
              </div>
            </article>`,
              )
              .join("")}</div>`
          : emptyState("还没有自定义主题", "点右上角「新建主题」开始搭配，或导入一个 JSON 配置。", "◐")
      }
      <div class="g14-io-bar">
        <button class="g14-btn" type="button" data-new>＋ 新建主题</button>
        <button class="g14-btn" type="button" data-import>导入主题配置</button>
        <input type="file" accept="application/json,.json" data-import-file hidden />
        <button class="g14-btn is-ghost" type="button" data-reset>恢复系统默认外观</button>
      </div>`;
    return;
  }

  let items = list;
  if (activeTab === "fav") items = list.filter((t) => st.favorites.includes(t.id));
  if (activeTab === "recent") items = st.recent.map((id) => list.find((t) => t.id === id)).filter(Boolean) as ThemeDef[];

  const title = activeTab === "fav" ? "我的收藏" : activeTab === "recent" ? "最近使用" : "全部主题";
  const sub =
    activeTab === "all"
      ? "十套内置主题，每套都包含完整的窗口、程序坞、菜单栏与组件观感。"
      : activeTab === "fav"
        ? "星标过的主题会出现在这里。"
        : "最近应用过的几套，随时切回去。";

  host.innerHTML = `
    <div class="g14-pane-head"><h3>${title}</h3><p>${sub}</p></div>
    ${
      items.length
        ? `<div class="g14-theme-grid">${items.map((t) => card(t, st)).join("")}</div>`
        : emptyState("这里是空的", "去「全部主题」看看，点 ☆ 收藏。", "☆")
    }
    <div class="g14-io-bar">
      <button class="g14-btn" type="button" data-new>＋ 新建主题</button>
      <button class="g14-btn" type="button" data-import>导入主题配置</button>
      <input type="file" accept="application/json,.json" data-import-file hidden />
      <button class="g14-btn is-ghost" type="button" data-reset>恢复系统默认外观</button>
    </div>`;
};

const previewBar = () => `
  <div class="g14-preview-bar" data-preview-bar hidden>
    <span>正在预览主题，没有保存。</span>
    <div>
      <button class="g14-btn is-primary" type="button" data-prev-ok>应用</button>
      <button class="g14-btn" type="button" data-prev-cancel>取消</button>
    </div>
  </div>`;

export const renderThemeApp = () => {
  const nav: Array<[string, string, string]> = [
    ["all", "全部主题", "◐"],
    ["fav", "我的收藏", "★"],
    ["recent", "最近使用", "◷"],
    ["mine", "我的主题", "✎"],
    ["editor", "新建主题", "＋"],
  ];
  return shell("themes", nav, `<div class="g14-theme-host" data-theme-host></div>${previewBar()}`, "主题中心");
};

export const initThemeApp = (win: HTMLElement, ctx?: Ctx): (() => void) => {
  const host = win.querySelector<HTMLElement>("[data-theme-host]");
  if (!host) return () => undefined;
  let editing: ThemeDef | undefined;

  const bar = win.querySelector<HTMLElement>("[data-preview-bar]");

  const paint = () => {
    const st = readThemeState();
    renderThemeTab(host, st);
    refreshBar();
  };

  const refreshBar = () => {
    if (!bar) return;
    bar.hidden = !previewId;
  };

  const onFav = (id: string) => {
    const st = readThemeState();
    st.favorites = st.favorites.includes(id) ? st.favorites.filter((x) => x !== id) : [...st.favorites, id];
    writeThemeState(st);
    paint();
  };

  const openDetail = async (theme: ThemeDef) => {
    const st = readThemeState();
    const picked = await modal(win, {
      title: `${theme.name} · ${theme.en}`,
      wide: true,
      body: `
        <div class="g14-detail-hero">${themePreview(theme)}</div>
        <p class="g14-detail-desc">${escapeHtml(theme.desc)}</p>
        <div class="g14-kv">
          <div><span>壁纸</span><b>${escapeHtml(wallpaperById(theme.wall).name)}</b></div>
          <div><span>明暗</span><b>${theme.mode === "light" ? "浅色" : "深色"}</b></div>
          <div><span>材质</span><b>${theme.material === "glass" ? "玻璃" : theme.material === "frost" ? "磨砂" : "实心"}</b></div>
          <div><span>圆角</span><b>${theme.radius === "sharp" ? "直角" : theme.radius === "soft" ? "柔和" : "圆润"}</b></div>
          <div><span>程序坞</span><b>${theme.dock.size}px</b></div>
          <div><span>字体</span><b>${theme.font === "mono" ? "等宽" : theme.font === "serif" ? "衬线" : "无衬线"}</b></div>
        </div>
        <div class="g14-swatches"><i style="background:${theme.accent}"></i><i style="background:${theme.accent2}"></i><i style="background:${theme.mode === "light" ? "#f7f4ee" : "#141826"}"></i></div>
        ${st.favorites.includes(theme.id) ? badge("已收藏", "warn") : ""}`,
      actions: [
        { label: "关闭", value: "" },
        { label: "收藏 / 取消", value: "fav" },
        { label: "应用主题", value: "apply", primary: true },
      ],
    });
    if (picked === "fav") onFav(theme.id);
    if (picked === "apply") {
      applyTheme(theme);
      paint();
    }
  };

  win.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const st = readThemeState();

    const favBtn = t.closest<HTMLElement>("[data-fav]");
    if (favBtn) return onFav(favBtn.dataset.fav ?? "");

    const applyBtn = t.closest<HTMLElement>("[data-apply]");
    if (applyBtn) {
      const theme = findTheme(applyBtn.dataset.apply ?? "");
      if (theme) {
        applyTheme(theme);
        previewId = "";
        paint();
      }
      return;
    }

    const prevBtn = t.closest<HTMLElement>("[data-prev]");
    if (prevBtn) {
      const theme = findTheme(prevBtn.dataset.prev ?? "");
      if (theme) {
        previewTheme(theme);
        previewId = theme.id;
        refreshBar();
      }
      return;
    }

    const detailBtn = t.closest<HTMLElement>("[data-detail]");
    if (detailBtn) {
      const theme = findTheme(detailBtn.dataset.detail ?? "");
      if (theme) void openDetail(theme);
      return;
    }

    if (t.closest("[data-prev-ok]")) {
      const theme = findTheme(previewId);
      if (theme) commitPreview(theme);
      previewId = "";
      paint();
      return;
    }
    if (t.closest("[data-prev-cancel]")) {
      cancelPreview();
      previewId = "";
      paint();
      return;
    }

    if (t.closest("[data-new]")) {
      activeTab = "editor";
      editing = undefined;
      win.querySelectorAll(".g14-nav").forEach((n) => n.classList.toggle("is-active", (n as HTMLElement).dataset.tab === "editor"));
      paint();
      return;
    }

    const editBtn = t.closest<HTMLElement>("[data-edit]");
    if (editBtn) {
      editing = findTheme(editBtn.dataset.edit ?? "");
      activeTab = "editor";
      win.querySelectorAll(".g14-nav").forEach((n) => n.classList.toggle("is-active", (n as HTMLElement).dataset.tab === "editor"));
      host.innerHTML = `<div class="g14-pane-head"><h3>编辑主题</h3><p>修改后保存会覆盖原来的自定义主题。</p></div>${editorForm(editing)}`;
      return;
    }

    const delBtn = t.closest<HTMLElement>("[data-del]");
    if (delBtn) {
      const id = delBtn.dataset.del ?? "";
      void modal(win, {
        title: "删除这套自定义主题？",
        body: `<p class="g14-modal-text">删除后无法恢复，正在使用时会切回 Aurora。</p>`,
        actions: [
          { label: "取消", value: "" },
          { label: "删除", value: "del", danger: true, primary: true },
        ],
      }).then((v) => {
        if (v === "del") {
          deleteCustomTheme(id);
          editing = undefined;
          paint();
        }
      });
      return;
    }

    if (t.closest("[data-editor-preview]")) {
      const theme = readEditor(host);
      if (!theme) {
        ctx?.toast("请先给主题起个名字，并确认颜色是 #RRGGBB");
        return;
      }
      previewTheme(theme);
      previewId = "editor-preview";
      refreshBar();
      return;
    }

    const saveBtn = t.closest<HTMLElement>("[data-save]");
    if (saveBtn) {
      const theme = readEditor(host);
      if (!theme) {
        ctx?.toast("请填写名称，颜色需要是 #RRGGBB 格式");
        return;
      }
      const id = saveBtn.dataset.save ?? "new";
      if (id !== "new") theme.id = id;
      else theme.id = `custom-${Date.now().toString(36)}`;
      if (editing) theme.createdAt = editing.createdAt;
      saveCustomTheme(theme);
      applyTheme(theme);
      previewId = "";
      editing = undefined;
      activeTab = "mine";
      win.querySelectorAll(".g14-nav").forEach((n) => n.classList.toggle("is-active", (n as HTMLElement).dataset.tab === "mine"));
      paint();
      return;
    }

    const expBtn = t.closest<HTMLElement>("[data-exp]");
    if (expBtn) {
      const theme = findTheme(expBtn.dataset.exp ?? "");
      if (theme) exportTheme(theme);
      return;
    }

    if (t.closest("[data-import]")) {
      win.querySelector<HTMLInputElement>("[data-import-file]")?.click();
      return;
    }

    if (t.closest("[data-reset]")) {
      void modal(win, {
        title: "恢复系统默认外观？",
        body: `<p class="g14-modal-text">会回到 1.3 的默认壁纸与配色，自定义主题不会被删除。</p>`,
        actions: [
          { label: "取消", value: "" },
          { label: "恢复默认", value: "ok", primary: true },
        ],
      }).then((v) => {
        if (v === "ok") {
          resetTheme();
          paint();
        }
      });
      return;
    }

    const fileInput = t.closest<HTMLElement>("[data-import-file]") as HTMLInputElement | null;
    if (fileInput) return;
    void st;
  });

  win.addEventListener("change", async (e) => {
    const input = (e.target as HTMLElement).closest<HTMLInputElement>("[data-import-file]");
    if (!input?.files?.length) return;
    const file = input.files[0];
    const theme = await importThemeFile(file);
    if (!theme) {
      void modal(win, {
        title: "导入失败",
        body: `<p class="g14-modal-text">这个文件不是有效的 Guandao 主题配置，或字段超出允许范围。主题文件只包含颜色、壁纸与材质参数，不会被执行。</p>`,
        actions: [{ label: "知道了", value: "ok", primary: true }],
      });
      input.value = "";
      return;
    }
    ctx?.toast(`已导入主题「${theme.name}」`);
    activeTab = "mine";
    paint();
    input.value = "";
  });

  bindTabs(win, (tab) => {
    activeTab = tab;
    if (tab !== "editor") editing = undefined;
    if (tab === "editor") {
      host.innerHTML = `<div class="g14-pane-head"><h3>创建自定义主题</h3><p>先搭一套，再点「用当前设置预览」看整体效果。</p></div>${editorForm()}`;
      return;
    }
    paint();
  });

  const off = onBus("themes-change", () => paint());
  paint();

  return () => {
    off();
    if (previewId) {
      cancelPreview();
      previewId = "";
    }
  };
};
