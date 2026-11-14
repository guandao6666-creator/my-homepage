/**
 * Guandao OS 1.4 · 应用中心
 *
 * 完整的商店体验：发现 / 分类 / 搜索 / 详情 / 安装 / 卸载 / 更新。
 * 所有"安装"都只是把内置应用登记进系统，不存在远程下载与执行。
 */

import {
  badge,
  delegate,
  emptyState,
  escapeHtml,
  ls,
  modal,
  onBus,
  type Ctx,
} from "./core";
import {
  CATALOG,
  CATEGORIES,
  META_BY_ID,
  PERMISSIONS,
  categoryName,
  installedVersion,
  isInstalled,
  pendingUpdate,
  readInstall,
  type AppMeta,
  type CategoryId,
  type PermissionId,
} from "./catalog";
import type { Sys } from "./system";

let ctxRef: Ctx | null = null;
let sysRef: Sys | null = null;

export const STATS_KEY = "guandao.os14.appstats.v1";

export const readStats = (): Record<string, number> => ls.get<Record<string, number>>(STATS_KEY, {});

export const bumpOpen = (id: string) => {
  const stats = readStats();
  stats[id] = (stats[id] ?? 0) + 1;
  ls.set(STATS_KEY, stats);
};

type StoreState = {
  tab: "discover" | "all" | "new" | "hot" | "updated" | "cat";
  cat: CategoryId | "";
  query: string;
  detail: string;
};

const state: StoreState = { tab: "discover", cat: "", query: "", detail: "" };

const glyphOf = (meta: AppMeta) => META_BY_ID[meta.id]?.glyph ?? meta.glyph;

const appIcon = (meta: AppMeta, size = "") => `
  <span class="di-glyph ${glyphOf(meta)} ${size}"></span>`;

const actionLabel = (id: string) => {
  if (!isInstalled(id)) return "安装";
  if (pendingUpdate(id)) return "更新";
  return "打开";
};

const statusChip = (meta: AppMeta) => {
  if (!isInstalled(meta.id)) return badge("未安装", "mute");
  if (pendingUpdate(meta.id)) return badge(`可更新 ${meta.version}`, "warn");
  return badge("已安装", "ok");
};

const runAction = (id: string, action: string) => {
  if (!sysRef) return;
  if (action === "install") {
    sysRef.install(id);
    return;
  }
  if (action === "update") {
    sysRef.update(id);
    return;
  }
  if (action === "open") {
    sysRef.open(id);
    return;
  }
};

const card = (meta: AppMeta, compact = false) => {
  const act = actionLabel(meta.id);
  return `
    <article class="g14-app-card${compact ? " is-compact" : ""}" data-open-detail="${escapeHtml(meta.id)}">
      <div class="g14-ac-head">
        ${appIcon(meta)}
        <div class="g14-ac-title">
          <h4>${escapeHtml(meta.name)}</h4>
          <p>${escapeHtml(meta.tagline)}</p>
        </div>
      </div>
      <div class="g14-ac-meta">
        <span>${escapeHtml(categoryName(meta.category))}</span>
        <span>v${escapeHtml(meta.version)}</span>
        ${statusChip(meta)}
      </div>
      ${compact ? "" : `<div class="g14-ac-actions">
        <button class="g14-btn ${act === "打开" ? "" : "is-primary"}" type="button" data-act="${escapeHtml(act === "打开" ? "open" : act === "更新" ? "update" : "install")}" data-id="${escapeHtml(meta.id)}">${act}</button>
        <button class="g14-btn is-ghost" type="button" data-menu="${escapeHtml(meta.id)}">⋯</button>
      </div>`}
    </article>`;
};

const heroCard = (meta: AppMeta) => `
  <article class="g14-hero" data-open-detail="${escapeHtml(meta.id)}">
    <div class="g14-hero-glow" style="--hg:${meta.id === "playground" ? "#b06eff" : "#6f8cff"}"></div>
    <div class="g14-hero-body">
      <span class="g14-hero-kicker">${meta.isNew ? "1.4 全新" : "编辑推荐"}</span>
      <h2>${escapeHtml(meta.name)}</h2>
      <p>${escapeHtml(meta.tagline)}</p>
      <div class="g14-hero-actions">
        <button class="g14-btn is-primary" type="button" data-act="${actionLabel(meta.id) === "打开" ? "open" : actionLabel(meta.id) === "更新" ? "update" : "install"}" data-id="${escapeHtml(meta.id)}">${actionLabel(meta.id)}</button>
        <button class="g14-btn" type="button" data-open-detail="${escapeHtml(meta.id)}">查看详情</button>
      </div>
    </div>
    <div class="g14-hero-art">
      <span class="di-glyph ${glyphOf(meta)} g14-hero-icon"></span>
    </div>
  </article>`;

const section = (title: string, sub: string, items: AppMeta[], more?: string) => `
  <section class="g14-store-sec">
    <div class="g14-sec-head">
      <div><h3>${escapeHtml(title)}</h3><p>${escapeHtml(sub)}</p></div>
      ${more ? `<button class="g14-link" type="button" data-goto="${more}">查看全部 →</button>` : ""}
    </div>
    <div class="g14-app-grid">${items.map((m) => card(m)).join("")}</div>
  </section>`;

const filtered = (): AppMeta[] => {
  const q = state.query.trim().toLowerCase();
  let list = CATALOG.slice();
  if (state.tab === "cat" && state.cat) list = list.filter((m) => m.category === state.cat);
  if (state.tab === "new") list = list.filter((m) => m.isNew || m.version.startsWith("1.6") || m.version.startsWith("1.4"));
  if (state.tab === "updated") list = list.filter((m) => m.version.startsWith("1.6") || m.version.startsWith("1.4"));
  if (state.tab === "hot") {
    const stats = readStats();
    list.sort((a, b) => (stats[b.id] ?? 0) - (stats[a.id] ?? 0) || Number(b.featured) - Number(a.featured));
  }
  if (q) {
    list = list.filter((m) =>
      `${m.name} ${m.tagline} ${m.desc} ${categoryName(m.category)} ${m.author}`.toLowerCase().includes(q),
    );
  }
  return list;
};

/* ============================================================
   详情页
   ============================================================ */
const detailView = (meta: AppMeta) => {
  const installed = isInstalled(meta.id);
  const act = actionLabel(meta.id);
  const actionKey = act === "打开" ? "open" : act === "更新" ? "update" : "install";
  const perms = meta.permissions
    .map((p: PermissionId) => {
      const perm = PERMISSIONS[p];
      const tone = perm.risk === "high" ? "danger" : perm.risk === "mid" ? "warn" : "mute";
      return `<div class="g14-perm">
        <span class="g14-perm-ico">${perm.risk === "mid" ? "!" : "·"}</span>
        <div><b>${escapeHtml(perm.label)} ${badge(perm.risk === "high" ? "高风险" : perm.risk === "mid" ? "需确认" : "基础", tone)}</b><p>${escapeHtml(perm.desc)}</p></div>
      </div>`;
    })
    .join("");

  return `
    <div class="g14-detail">
      <button class="g14-back" type="button" data-back>← 返回应用列表</button>
      <header class="g14-detail-head">
        ${appIcon(meta, "is-lg")}
        <div class="g14-detail-title">
          <h2>${escapeHtml(meta.name)}</h2>
          <p>${escapeHtml(meta.tagline)}</p>
          <div class="g14-detail-meta">
            <span>${escapeHtml(categoryName(meta.category))}</span><i>·</i>
            <span>v${escapeHtml(meta.version)}</span><i>·</i>
            <span>${escapeHtml(meta.author)}</span><i>·</i>
            <span>${escapeHtml(meta.size)}</span>
            ${statusChip(meta)}
          </div>
        </div>
        <div class="g14-detail-cta">
          <button class="g14-btn is-primary is-lg" type="button" data-act="${actionKey}" data-id="${escapeHtml(meta.id)}">${act}</button>
          ${
            installed
              ? `<button class="g14-btn is-ghost" type="button" data-uninstall="${escapeHtml(meta.id)}">卸载</button>`
              : ""
          }
        </div>
      </header>

      <div class="g14-detail-grid">
        <div class="g14-detail-main">
          <h3>应用介绍</h3>
          <p class="g14-detail-desc">${escapeHtml(meta.desc)}</p>

          <h3>界面预览</h3>
          <p class="g14-note">下面的预览是按应用真实布局生成的示意图，不是伪造的截图。</p>
          <div class="g14-shots">
            ${meta.screens
              .map(
                (s) => `
              <figure class="g14-shot">
                <div class="g14-shot-win">
                  <div class="g14-shot-bar"><i></i><i></i><i></i><span>${escapeHtml(meta.name)}</span></div>
                  <div class="g14-shot-body">
                    <span class="di-glyph ${glyphOf(meta)}"></span>
                    <div class="g14-shot-lines"><i></i><i></i><i></i></div>
                    <div class="g14-shot-blocks"><b></b><b></b><b></b></div>
                  </div>
                </div>
                <figcaption>${escapeHtml(s.name)}<span>${escapeHtml(s.hint)}</span></figcaption>
              </figure>`,
              )
              .join("")}
          </div>

          <h3>功能说明</h3>
          <ul class="g14-feature-list">${meta.features.map((f) => `<li>${escapeHtml(f)}</li>`).join("")}</ul>

          <h3>权限声明</h3>
          <div class="g14-perms">${perms}</div>

          <h3>更新日志</h3>
          <div class="g14-changelog">
            ${meta.changelog
              .map(
                (c) => `<div class="g14-cl-row">
                  <div class="g14-cl-v">v${escapeHtml(c.v)}<span>${escapeHtml(c.date)}</span></div>
                  <ul>${c.items.map((i) => `<li>${escapeHtml(i)}</li>`).join("")}</ul>
                </div>`,
              )
              .join("")}
          </div>
        </div>

        <aside class="g14-detail-side">
          <div class="g14-side-card">
            <h4>应用信息</h4>
            <div class="g14-kv">
              <div><span>版本</span><b>${escapeHtml(meta.version)}</b></div>
              <div><span>已装版本</span><b>${escapeHtml(installedVersion(meta.id) || "—")}</b></div>
              <div><span>大小</span><b>${escapeHtml(meta.size)}</b></div>
              <div><span>开发者</span><b>${escapeHtml(meta.author)}</b></div>
              <div><span>分类</span><b>${escapeHtml(categoryName(meta.category))}</b></div>
              <div><span>发布</span><b>${escapeHtml(meta.release)}</b></div>
            </div>
          </div>
          <div class="g14-side-card">
            <h4>快捷操作</h4>
            <button class="g14-side-btn" type="button" data-pin="${escapeHtml(meta.id)}">
              <span>${sysRef?.isPinned(meta.id) ? "★ 已固定在程序坞" : "☆ 固定到程序坞"}</span>
            </button>
            <button class="g14-side-btn" type="button" data-shortcut="${escapeHtml(meta.id)}">
              <span>${sysRef?.hasShortcut(meta.id) ? "✓ 已在桌面" : "＋ 添加到桌面"}</span>
            </button>
            <p class="g14-hint">安装后才会真正出现在启动台、搜索与程序坞里。</p>
          </div>
          <div class="g14-side-card is-muted">
            <h4>安全说明</h4>
            <p>应用来自本项目内置代码，安装不会下载或执行远程脚本。卸载会同时关闭它的窗口并移除桌面与程序坞入口，数据仍保留，可在数据中心清理。</p>
          </div>
        </aside>
      </div>
    </div>`;
};

/* ============================================================
   页面
   ============================================================ */

const discoverView = () => {
  const featured = CATALOG.filter((m) => m.featured).slice(0, 3);
  const hot = filteredHot();
  const fresh = CATALOG.filter((m) => m.isNew || m.release >= "2026-11-01").slice(0, 4);
  const updated = CATALOG.filter((m) => m.version.startsWith("1.6") || m.version.startsWith("1.4")).slice(0, 4);
  return `
    <div class="g14-store-scroll">
      ${heroCard(META_BY_ID.playground ?? featured[0])}
      ${section("推荐应用", "这些都是 1.4 的核心新能力", featured, "all")}
      ${section("最近更新", "版本号已升到 1.4 的应用", updated, "updated")}
      ${section("热门应用", "按这台设备上的打开次数排序", hot.slice(0, 4), "hot")}
      ${section("最新上架", "刚进入应用中心的新面孔", fresh, "new")}
      <section class="g14-store-sec">
        <div class="g14-sec-head"><div><h3>按分类浏览</h3><p>七类应用，点击进入分类页</p></div></div>
        <div class="g14-cat-grid">
          ${CATEGORIES.map((c) => {
            const n = CATALOG.filter((m) => m.category === c.id).length;
            return `<button class="g14-cat" type="button" data-cat="${c.id}">
              <span class="g14-cat-ico">${c.ico}</span>
              <b>${escapeHtml(c.name)}</b>
              <i>${n} 个应用</i>
              <em>${escapeHtml(c.desc)}</em>
            </button>`;
          }).join("")}
        </div>
      </section>
    </div>`;
};

const filteredHot = () => {
  const stats = readStats();
  return CATALOG.slice().sort((a, b) => (stats[b.id] ?? 0) - (stats[a.id] ?? 0) || Number(b.featured) - Number(a.featured));
};

const listView = () => {
  const items = filtered();
  const titles: Record<string, [string, string]> = {
    all: ["全部应用", "内置应用与 1.4 新增应用，共 " + CATALOG.length + " 个"],
    new: ["最新上架", "1.4 新增与重做的应用"],
    hot: ["热门应用", "按本机打开次数排序，没有使用记录时按推荐排序"],
    updated: ["最近更新", "版本号已升到 1.4 的应用"],
    cat: [CATEGORIES.find((c) => c.id === state.cat)?.name ?? "分类", CATEGORIES.find((c) => c.id === state.cat)?.desc ?? ""],
  };
  const [title, sub] = titles[state.tab] ?? titles.all;
  return `
    <div class="g14-store-scroll">
      <div class="g14-pane-head"><h3>${escapeHtml(title)}</h3><p>${escapeHtml(sub)}</p></div>
      ${
        items.length
          ? `<div class="g14-app-grid is-wide">${items.map((m) => card(m)).join("")}</div>`
          : emptyState("没有找到匹配的应用", "换个关键词，或回到「全部应用」看看。", "⌕")
      }
    </div>`;
};

const bodyView = () => (state.detail ? detailView(META_BY_ID[state.detail]) : state.tab === "discover" ? discoverView() : listView());

export const renderAppCenter = () => {
  const installed = readInstall();
  return `
    <div class="g14-store">
      <header class="g14-store-top">
        <div class="g14-store-brand">
          <span class="g14-store-logo">应</span>
          <div><b>应用中心</b><span>Guandao App Center</span></div>
        </div>
        <label class="g14-search">
          <span>⌕</span>
          <input type="search" data-store-search placeholder="搜索应用、分类或开发者" value="${escapeHtml(state.query)}" />
        </label>
        <div class="g14-store-count"><b>${Object.keys(installed.installed).length}</b><span>已安装</span></div>
      </header>
      <nav class="g14-store-tabs">
        ${[
          ["discover", "发现"],
          ["all", "全部应用"],
          ["new", "最新"],
          ["hot", "热门"],
          ["updated", "最近更新"],
        ]
          .map(
            ([k, label]) =>
              `<button class="g14-stab ${state.tab === k ? "is-active" : ""}" type="button" data-stab="${k}">${label}</button>`,
          )
          .join("")}
        <span class="g14-stab-sep"></span>
        <div class="g14-chip-row">
          ${CATEGORIES.map(
            (c) =>
              `<button class="g14-chip ${state.tab === "cat" && state.cat === c.id ? "is-active" : ""}" type="button" data-scat="${c.id}">${c.ico} ${escapeHtml(c.name)}</button>`,
          ).join("")}
        </div>
      </nav>
      <div class="g14-store-body" data-store-body>${bodyView()}</div>
    </div>`;
};

export const initAppCenter = (win: HTMLElement, ctx: Ctx, sys: Sys): (() => void) => {
  ctxRef = ctx;
  sysRef = sys;
  state.detail = "";
  const host = win.querySelector<HTMLElement>("[data-store]") ?? win;
  const bodyHost = win.querySelector<HTMLElement>("[data-store-body]");

  const paint = () => {
    if (!bodyHost) return;
    bodyHost.innerHTML = bodyView();
    bodyHost.scrollTop = 0;
  };

  const paintTabs = () => {
    win.querySelectorAll<HTMLElement>("[data-stab]").forEach((b) => b.classList.toggle("is-active", b.dataset.stab === state.tab));
    win.querySelectorAll<HTMLElement>("[data-scat]").forEach((b) =>
      b.classList.toggle("is-active", state.tab === "cat" && b.dataset.scat === state.cat),
    );
  };

  const openDetail = (id: string) => {
    if (!META_BY_ID[id]) return;
    state.detail = id;
    paint();
  };

  win.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;

    const act = t.closest<HTMLElement>("[data-act]");
    if (act) {
      e.stopPropagation();
      const id = act.dataset.id ?? "";
      runAction(id, act.dataset.act ?? "open");
      paint();
      return;
    }

    const detailLink = t.closest<HTMLElement>("[data-open-detail]");
    if (detailLink) {
      e.stopPropagation();
      openDetail(detailLink.dataset.openDetail ?? "");
      return;
    }

    if (t.closest("[data-back]")) {
      state.detail = "";
      paint();
      return;
    }

    const stab = t.closest<HTMLElement>("[data-stab]");
    if (stab) {
      state.tab = (stab.dataset.stab as StoreState["tab"]) ?? "discover";
      state.detail = "";
      paintTabs();
      paint();
      return;
    }

    const scat = t.closest<HTMLElement>("[data-scat]");
    if (scat) {
      state.tab = "cat";
      state.cat = (scat.dataset.scat as CategoryId) ?? "";
      state.detail = "";
      paintTabs();
      paint();
      return;
    }

    const cat = t.closest<HTMLElement>("[data-cat]");
    if (cat) {
      state.tab = "cat";
      state.cat = (cat.dataset.cat as CategoryId) ?? "";
      state.detail = "";
      paintTabs();
      paint();
      return;
    }

    const goto = t.closest<HTMLElement>("[data-goto]");
    if (goto) {
      state.tab = (goto.dataset.goto as StoreState["tab"]) ?? "all";
      state.detail = "";
      paintTabs();
      paint();
      return;
    }

    const menu = t.closest<HTMLElement>("[data-menu]");
    if (menu) {
      e.stopPropagation();
      const id = menu.dataset.menu ?? "";
      const meta = META_BY_ID[id];
      if (!meta) return;
      const pinned = sysRef?.isPinned(id);
      const shortcut = sysRef?.hasShortcut(id);
      void modal(win, {
        title: meta.name,
        body: `<div class="g14-menu-list">
          <button class="g14-menu-item" type="button" data-mm="detail">查看详情</button>
          <button class="g14-menu-item" type="button" data-mm="pin">${pinned ? "从程序坞取消固定" : "固定到程序坞"}</button>
          <button class="g14-menu-item" type="button" data-mm="shortcut">${shortcut ? "移除桌面快捷方式" : "添加到桌面"}</button>
          ${isInstalled(id) ? `<button class="g14-menu-item is-danger" type="button" data-mm="uninstall">卸载应用</button>` : ""}
        </div>`,
        actions: [{ label: "关闭", value: "" }],
      }).then((v) => {
        if (v === "detail") openDetail(id);
        if (v === "pin") {
          sysRef?.pinDock(id, !pinned);
          ctx.toast(pinned ? "已从程序坞移除" : "已固定到程序坞");
          paint();
        }
        if (v === "shortcut") {
          if (shortcut) sysRef?.removeShortcut(id);
          else sysRef?.addShortcut(id);
          paint();
        }
        if (v === "uninstall") confirmUninstall(id);
      });
      return;
    }

    const pin = t.closest<HTMLElement>("[data-pin]");
    if (pin) {
      const id = pin.dataset.pin ?? "";
      sysRef?.pinDock(id, !sysRef.isPinned(id));
      paint();
      return;
    }

    const shortcut = t.closest<HTMLElement>("[data-shortcut]");
    if (shortcut) {
      const id = shortcut.dataset.shortcut ?? "";
      if (sysRef?.hasShortcut(id)) sysRef.removeShortcut(id);
      else sysRef?.addShortcut(id);
      paint();
      return;
    }

    const un = t.closest<HTMLElement>("[data-uninstall]");
    if (un) {
      confirmUninstall(un.dataset.uninstall ?? "");
      return;
    }

  });

  const confirmUninstall = (id: string) => {
    const meta = META_BY_ID[id];
    if (!meta) return;
    void modal(win, {
      title: `卸载「${meta.name}」？`,
      body: `<p class="g14-modal-text">会关闭它的窗口，并从启动台、桌面与程序坞移除。应用数据仍保留在本机，重新安装后可以继续用。</p>`,
      actions: [
        { label: "取消", value: "" },
        { label: "卸载", value: "ok", danger: true, primary: true },
      ],
    }).then((v) => {
      if (v === "ok") {
        sysRef?.uninstall(id);
        if (state.detail === id) state.detail = "";
        paint();
      }
    });
  };

  win.addEventListener("input", (e) => {
    const input = (e.target as HTMLElement).closest<HTMLInputElement>("[data-store-search]");
    if (!input) return;
    state.query = input.value;
    state.detail = "";
    paint();
  });

  // 卡片右键：快速菜单
  win.addEventListener("contextmenu", (e) => {
    const cardEl = (e.target as HTMLElement).closest<HTMLElement>("[data-open-detail]");
    if (!cardEl) return;
    e.preventDefault();
    const id = cardEl.dataset.openDetail ?? "";
    const meta = META_BY_ID[id];
    if (!meta) return;
    void modal(win, {
      title: meta.name,
      body: `<div class="g14-menu-list">
        <button class="g14-menu-item" type="button" data-mm="detail">查看详情</button>
        <button class="g14-menu-item" type="button" data-mm="pin">${sysRef?.isPinned(id) ? "取消固定" : "固定到程序坞"}</button>
        <button class="g14-menu-item" type="button" data-mm="shortcut">${sysRef?.hasShortcut(id) ? "移除桌面图标" : "添加到桌面"}</button>
        ${isInstalled(id) ? `<button class="g14-menu-item is-danger" type="button" data-mm="uninstall">卸载</button>` : ""}
      </div>`,
      actions: [{ label: "关闭", value: "" }],
    }).then((v) => {
      if (v === "detail") openDetail(id);
      if (v === "pin") sysRef?.pinDock(id, !sysRef?.isPinned(id));
      if (v === "shortcut") (sysRef?.hasShortcut(id) ? sysRef?.removeShortcut(id) : sysRef?.addShortcut(id));
      if (v === "uninstall") confirmUninstall(id);
      paint();
    });
  });

  const off = onBus("apps-change", () => paint());
  delegate(win, "[data-store-search]", "keydown", (_t, ev) => {
    if ((ev as KeyboardEvent).key === "Escape") (ev.target as HTMLInputElement).blur();
  });

  return () => off();
};
