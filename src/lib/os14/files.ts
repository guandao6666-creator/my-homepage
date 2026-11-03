/**
 * Guandao OS 1.4 · 虚拟文件系统
 *
 * 注意：这是浏览器里的虚拟文件系统，只保存「你主动导入」的内容，
 * 不会也无法读取用户电脑上的真实目录。
 *
 * 新增：类型分类、收藏 / 最近 / 下载、复制 / 移动、回收站与恢复、
 *      文件关联（md→Notes/Reader，图片→Gallery，音频→Music）、
 *      单文件导出与文件夹打包导出。
 */

import {
  badge,
  compressImage,
  download,
  escapeHtml,
  fmtAgo,
  fmtBytes,
  fmtDateTime,
  idb,
  ls,
  modal,
  pickFile,
  renderMarkdown,
  todayKey,
  uid,
  type Ctx,
} from "./core";
import { music } from "./music-core";
import { addNoteFromFile } from "./apps/notes";
import { addExternalPhoto } from "./apps/gallery";

export type FsKind = "doc" | "image" | "audio" | "video" | "other";

export type FsNode = {
  id: string;
  name: string;
  type: "folder" | "file";
  parent: string | null;
  content?: string;
  href?: string;
  starred?: boolean;
  at: number;
  kind?: FsKind;
  size?: number;
  source?: "seed" | "import" | "created";
  /** 关联到相册 / 音乐 / 阅读器的记录 id */
  refId?: string;
  trashed?: boolean;
  trashedAt?: number;
  prevParent?: string | null;
  /** 真正被打开过的时间，用于「最近」视图 */
  openedAt?: number;
};

const KEY = "guandao.os.fs.v1";

const extOf = (name: string) => (/\.([a-z0-9]+)$/i.exec(name)?.[1] ?? "").toLowerCase();

export const kindOf = (name: string, explicit?: FsKind): FsKind => {
  if (explicit) return explicit;
  const ext = extOf(name);
  if (["md", "markdown", "txt", "pdf", "doc", "docx", "json"].includes(ext)) return "doc";
  if (["png", "jpg", "jpeg", "webp", "gif", "avif", "svg"].includes(ext)) return "image";
  if (["mp3", "wav", "ogg", "m4a", "flac"].includes(ext)) return "audio";
  if (["mp4", "webm", "mov", "mkv"].includes(ext)) return "video";
  return "other";
};

const KIND_LABEL: Record<FsKind, string> = { doc: "文档", image: "图片", audio: "音频", video: "视频", other: "其他" };

const seed = (): FsNode[] => {
  const now = Date.now();
  const list: FsNode[] = [
    { id: "f-posts", name: "文章", type: "folder", parent: "root", at: now, source: "seed" },
    { id: "f-images", name: "图片", type: "folder", parent: "root", at: now, source: "seed" },
    { id: "f-docs", name: "文档", type: "folder", parent: "root", at: now, source: "seed" },
    { id: "f-audio", name: "音频", type: "folder", parent: "root", at: now, source: "seed" },
  ];
  try {
    const posts = (window as unknown as { __OS__?: { posts?: Array<{ title: string; href: string; date: string }> } }).__OS__?.posts ?? [];
    for (const p of posts) {
      list.push({
        id: `post-${p.href}`,
        name: `${p.title}.md`,
        type: "file",
        parent: "f-posts",
        href: p.href,
        at: new Date(p.date).getTime() || now,
        kind: "doc",
        source: "seed",
      });
    }
  } catch {
    /* 忽略 */
  }
  list.push({
    id: "note-welcome",
    name: "欢迎使用.txt",
    type: "file",
    parent: "f-docs",
    kind: "doc",
    source: "seed",
    at: now,
    content:
      "这是 Guandao OS 的虚拟文件系统。\n\n所有文件都保存在浏览器里，不会访问你的真实电脑文件。\n\n1.4 新增：\n- 按类型分类（文档 / 图片 / 音频 / 视频）\n- 收藏、最近打开、下载内容\n- 复制、移动、回收站与恢复\n- 文件关联：Markdown 交给笔记或阅读器，图片交给相册，音频交给音乐\n- 导出单个文件，或把整个文件夹打包成 JSON\n",
  });
  return list;
};

const read = (): FsNode[] => {
  const raw = ls.get<FsNode[] | null>(KEY, null);
  if (Array.isArray(raw) && raw.length) {
    // 1.2 的老数据没有 kind / source，补一次
    let changed = false;
    for (const n of raw) {
      if (!n.kind) {
        n.kind = n.type === "folder" ? undefined : kindOf(n.name);
        changed = true;
      }
      if (!n.source) {
        n.source = "seed";
        changed = true;
      }
    }
    if (changed) ls.set(KEY, raw);
    return raw;
  }
  const seeded = seed();
  ls.set(KEY, seeded);
  return seeded;
};

const write = (list: FsNode[]) => ls.set(KEY, list);

type ViewId = "root" | "doc" | "image" | "audio" | "video" | "starred" | "recent" | "download" | "trash";

const VIEWS: Array<{ id: ViewId; name: string; ico: string }> = [
  { id: "root", name: "全部文件", ico: "▤" },
  { id: "doc", name: "文档", ico: "▥" },
  { id: "image", name: "图片", ico: "▣" },
  { id: "audio", name: "音频", ico: "♫" },
  { id: "video", name: "视频", ico: "▷" },
  { id: "starred", name: "收藏", ico: "★" },
  { id: "recent", name: "最近", ico: "◷" },
  { id: "download", name: "下载内容", ico: "↓" },
  { id: "trash", name: "回收站", ico: "🗑" },
];

type FsUi = { view: ViewId; folder: string; q: string; sort: "name" | "time" | "size"; asc: boolean };

const UI_KEY = "guandao.os14.fsui.v1";
const defaultUi = (): FsUi => ({ view: "root", folder: "root", q: "", sort: "time", asc: false });

const body = () => `
  <div class="fs14" data-fs14>
    <aside class="fs14-side">
      ${VIEWS.map((v) => `<button class="fs14-view" type="button" data-fs-view="${v.id}"><span>${v.ico}</span>${v.name}<b data-fs-count="${v.id}"></b></button>`).join("")}
      <div class="fs14-side-foot">
        <p class="fs14-vnote">虚拟文件系统<br/>只保存你主动导入的内容</p>
      </div>
    </aside>
    <section class="fs14-main">
      <header class="fs14-bar">
        <div class="fs14-crumb" data-fs-crumb></div>
        <div class="fs14-tools">
          <input class="fs14-search" data-fs-search placeholder="搜索当前视图…" />
          <select class="fs14-sort" data-fs-sort>
            <option value="time">按时间</option>
            <option value="name">按名称</option>
            <option value="size">按大小</option>
          </select>
          <button class="g14-btn" type="button" data-fs-newfolder>＋ 文件夹</button>
          <button class="g14-btn" type="button" data-fs-import>导入</button>
          <button class="g14-btn is-ghost" type="button" data-fs-export>导出</button>
        </div>
      </header>
      <div class="fs14-grid" data-fs-grid></div>
    </section>
  </div>`;

export const renderFiles = () => body();

const glyphFor = (n: FsNode) => {
  if (n.type === "folder") return "di-folder";
  const kind = kindOf(n.name, n.kind);
  return kind === "image" ? "di-viewer" : kind === "audio" ? "di-music" : kind === "doc" ? "di-note" : "di-files";
};

export const initFiles = (win: HTMLElement, ctx: Ctx): (() => void) => {
  const root = win.querySelector<HTMLElement>("[data-fs14]");
  if (!root) return () => undefined;
  let ui = ls.get<FsUi>(UI_KEY, defaultUi());
  let selected = "";

  const grid = root.querySelector<HTMLElement>("[data-fs-grid]");
  const crumb = root.querySelector<HTMLElement>("[data-fs-crumb]");
  const search = root.querySelector<HTMLInputElement>("[data-fs-search]");

  const saveUi = () => ls.set(UI_KEY, ui);

  const visible = (): FsNode[] => {
    const all = read();
    let list: FsNode[];
    if (ui.view === "trash") list = all.filter((n) => n.trashed);
    else {
      list = all.filter((n) => !n.trashed);
      if (ui.view === "starred") list = list.filter((n) => n.starred);
      else if (ui.view === "recent")
        list = list
          .filter((n) => n.type === "file")
          .sort((a, b) => (b.openedAt ?? b.at) - (a.openedAt ?? a.at))
          .slice(0, 40);
      else if (ui.view === "download") list = list.filter((n) => n.source === "import");
      else if (ui.view === "root") list = list.filter((n) => n.parent === ui.folder);
      else list = list.filter((n) => n.type === "file" && kindOf(n.name, n.kind) === ui.view);
    }
    const q = ui.q.trim().toLowerCase();
    if (q) list = list.filter((n) => n.name.toLowerCase().includes(q));
    const dir = ui.asc ? 1 : -1;
    if (ui.sort === "name") list.sort((a, b) => dir * a.name.localeCompare(b.name, "zh"));
    else if (ui.sort === "size") list.sort((a, b) => dir * ((a.size ?? a.content?.length ?? 0) - (b.size ?? b.content?.length ?? 0)));
    else list.sort((a, b) => dir * (a.at - b.at));
    // 文件夹永远排在文件前面
    return list.sort((a, b) => (a.type === b.type ? 0 : a.type === "folder" ? -1 : 1));
  };

  const counts = () => {
    const all = read().filter((n) => !n.trashed);
    const map: Record<string, number> = {
      root: all.filter((n) => n.parent === ui.folder).length,
      doc: all.filter((n) => n.type === "file" && kindOf(n.name, n.kind) === "doc").length,
      image: all.filter((n) => n.type === "file" && kindOf(n.name, n.kind) === "image").length,
      audio: all.filter((n) => n.type === "file" && kindOf(n.name, n.kind) === "audio").length,
      video: all.filter((n) => n.type === "file" && kindOf(n.name, n.kind) === "video").length,
      starred: all.filter((n) => n.starred).length,
      recent: 0,
      download: all.filter((n) => n.source === "import").length,
      trash: read().filter((n) => n.trashed).length,
    };
    return map;
  };

  const paintCrumb = () => {
    if (!crumb) return;
    const all = read();
    if (ui.view === "root") {
      const chain: FsNode[] = [];
      let cur = all.find((n) => n.id === ui.folder && n.type === "folder");
      while (cur) {
        chain.unshift(cur);
        cur = all.find((n) => n.id === cur?.parent && n.type === "folder");
      }
      crumb.innerHTML =
        `<button type="button" data-fs-go="root">全部文件</button>` +
        chain.map((n) => `<span>›</span><button type="button" data-fs-go="${escapeHtml(n.id)}">${escapeHtml(n.name)}</button>`).join("");
    } else {
      const v = VIEWS.find((x) => x.id === ui.view);
      crumb.innerHTML = `<b>${v?.name ?? ""}</b>`;
    }
  };

  const paint = () => {
    const list = visible();
    const c = counts();
    root.querySelectorAll<HTMLElement>("[data-fs-count]").forEach((el) => {
      const n = c[el.dataset.fsCount ?? ""] ?? 0;
      el.textContent = n ? String(n) : "";
    });
    root.querySelectorAll<HTMLElement>("[data-fs-view]").forEach((el) =>
      el.classList.toggle("is-active", el.dataset.fsView === ui.view),
    );
    paintCrumb();
    if (!grid) return;
    if (!list.length) {
      grid.innerHTML = `<div class="fs14-empty"><span>▤</span><p>${ui.view === "trash" ? "回收站是空的" : "这里还没有文件"}</p>
        <p class="fs14-empty-sub">${ui.view === "trash" ? "删除的文件会先放到这里。" : "点顶部「导入」添加，或新建一个文件夹。"}</p></div>`;
      return;
    }
    grid.innerHTML = list
      .map(
        (n) => `<article class="fs14-card ${selected === n.id ? "is-sel" : ""}" data-fs-node="${escapeHtml(n.id)}" data-fs-type="${n.type}">
          <span class="fs14-ico di-glyph ${glyphFor(n)}"></span>
          <span class="fs14-name" title="${escapeHtml(n.name)}">${escapeHtml(n.name)}</span>
          <span class="fs14-meta">${n.type === "folder" ? `${read().filter((x) => x.parent === n.id && !x.trashed).length} 项` : fmtBytes(n.size ?? n.content?.length ?? 0)}${n.starred ? " · ★" : ""}</span>
          <span class="fs14-act"><button type="button" data-fs-menu="${escapeHtml(n.id)}">⋯</button></span>
        </article>`,
      )
      .join("");
  };

  const openNode = async (id: string) => {
    const all = read();
    const n = all.find((x) => x.id === id);
    if (!n) return;
    n.openedAt = Date.now();
    write(all);
    n.openedAt = Date.now();
    write(all);
    if (n.type === "folder") {
      ui.view = "root";
      ui.folder = n.id;
      saveUi();
      paint();
      return;
    }
    if (n.href) {
      window.open(n.href, "_blank", "noreferrer");
      return;
    }
    const ext = extOf(n.name);
    const kind = kindOf(n.name, n.kind);
    if (kind === "image") {
      ctx.openApp("gallery");
      ctx.toast(n.refId ? "已在相册中打开" : "这张图片在相册里");
      return;
    }
    if (kind === "audio") {
      ctx.openApp("music");
      return;
    }
    if (ext === "md" || ext === "markdown") {
      void modal(win, {
        title: n.name,
        body: `<p class="g14-modal-text">Markdown 文件用哪个应用打开？</p>`,
        actions: [
          { label: "取消", value: "" },
          { label: "阅读器", value: "reader" },
          { label: "笔记", value: "notes", primary: true },
        ],
      }).then((v) => {
        if (v === "notes") {
          const ok = addNoteFromFile(n.name, n.content ?? "");
          ctx.openApp("notes");
          ctx.toast(ok ? "已作为新笔记打开" : "无法创建笔记");
        }
        if (v === "reader") ctx.toast("请到阅读器里导入这个文件（阅读器读取本地文本）");
      });
      return;
    }
    if (ext === "txt" || kind === "doc") {
      void modal(win, {
        title: n.name,
        wide: true,
        body: `<div class="fs14-preview">${n.content ? `<pre>${escapeHtml(n.content)}</pre>` : `<p class="g14-modal-text">这个文件没有可预览的文本内容。</p>`}</div>`,
        actions: [
          { label: "关闭", value: "" },
          { label: "阅读器", value: "reader" },
        ],
      }).then((v) => {
        if (v === "reader") ctx.openApp("reader");
      });
      return;
    }
    void modal(win, {
      title: n.name,
      body: `<p class="g14-modal-text">没有为 <b>.${escapeHtml(ext || "?")}</b> 建立关联应用。可以导出后用本地软件打开。</p>`,
      actions: [{ label: "知道了", value: "ok", primary: true }],
    });
  };

  const details = (id: string) => {
    const n = read().find((x) => x.id === id);
    if (!n) return;
    const kind = n.type === "folder" ? "文件夹" : KIND_LABEL[kindOf(n.name, n.kind)];
    void modal(win, {
      title: n.name,
      body: `<div class="g14-kv">
        <div><span>类型</span><b>${kind}</b></div>
        <div><span>大小</span><b>${n.type === "folder" ? "—" : fmtBytes(n.size ?? n.content?.length ?? 0)}</b></div>
        <div><span>位置</span><b>${n.parent === "root" ? "全部文件" : escapeHtml(read().find((x) => x.id === n.parent)?.name ?? "—")}</b></div>
        <div><span>创建 / 修改</span><b>${fmtDateTime(n.at)}</b></div>
        <div><span>来源</span><b>${n.source === "import" ? "用户导入" : n.source === "created" ? "桌面新建" : "系统预置"}</b></div>
        <div><span>收藏</span><b>${n.starred ? "是" : "否"}</b></div>
      </div>
      ${n.content ? `<div class="fs14-preview is-short"><pre>${escapeHtml(n.content.slice(0, 400))}${n.content.length > 400 ? "\n…" : ""}</pre></div>` : ""}`,
      actions: [{ label: "关闭", value: "" }],
    });
  };

  win.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;

    const view = t.closest<HTMLElement>("[data-fs-view]");
    if (view) {
      ui.view = (view.dataset.fsView as ViewId) ?? "root";
      selected = "";
      if (ui.view === "root") ui.folder = "root";
      saveUi();
      paint();
      return;
    }

    const go = t.closest<HTMLElement>("[data-fs-go]");
    if (go) {
      ui.view = "root";
      ui.folder = go.dataset.fsGo ?? "root";
      saveUi();
      paint();
      return;
    }

    if (t.closest("[data-fs-newfolder]")) {
      void modal(win, {
        title: "新建文件夹",
        body: `<input class="g14-input" data-modal-input placeholder="文件夹名称" maxlength="40" />`,
        actions: [
          { label: "取消", value: "" },
          { label: "创建", value: "ok", primary: true },
        ],
      }).then((v) => {
        if (v !== "ok") return;
        const name = (win.querySelector<HTMLInputElement>("[data-modal-input]")?.value ?? "").trim();
        if (!name) return;
        const all = read();
        all.push({ id: uid(), name: name.slice(0, 40), type: "folder", parent: ui.folder, at: Date.now(), source: "created" });
        write(all);
        paint();
      });
      return;
    }

    if (t.closest("[data-fs-import]")) {
      pickFile("*/*", true, async (files) => {
        const all = read();
        let ok = 0;
        for (const file of files.slice(0, 30)) {
          const kind = kindOf(file.name, file.type.startsWith("image/") ? "image" : file.type.startsWith("audio/") ? "audio" : undefined);
          if (kind === "image") {
            const blob = await compressImage(file);
            const key = `img:${uid()}`;
            if (!(await idb.put("blobs", key, blob))) continue;
            addExternalPhoto(key, file.name, blob.size);
            all.push({
              id: uid(),
              name: file.name.slice(0, 60),
              type: "file",
              parent: ui.folder,
              at: Date.now(),
              kind: "image",
              size: blob.size,
              source: "import",
              refId: key,
            });
            ok++;
            continue;
          }
          if (kind === "audio") {
            const added = await music.addFiles([file]);
            if (!added) continue;
            const track = music.tracks().slice(-1)[0];
            all.push({
              id: uid(),
              name: file.name.slice(0, 60),
              type: "file",
              parent: ui.folder,
              at: Date.now(),
              kind: "audio",
              size: file.size,
              source: "import",
              refId: track?.id,
            });
            ok++;
            continue;
          }
          if (file.size > 2 * 1024 * 1024) continue;
          const text = await file.text().catch(() => "");
          all.push({
            id: uid(),
            name: file.name.slice(0, 60),
            type: "file",
            parent: ui.folder,
            at: Date.now(),
            kind: kind === "other" ? kindOf(file.name) : kind,
            size: file.size,
            content: text,
            source: "import",
          });
          ok++;
        }
        write(all);
        paint();
        ctx.toast(ok ? `已导入 ${ok} 个文件` : "没有可导入的文件（文本需小于 2MB）");
      });
      return;
    }

    if (t.closest("[data-fs-export]")) {
      const all = read().filter((n) => !n.trashed);
      const current = ui.view === "root" ? all.filter((n) => n.parent === ui.folder) : visible();
      const ids = new Set(current.map((n) => n.id));
      const bundle = {
        kind: "guandao-fs-bundle",
        version: 1,
        exportedAt: new Date().toISOString(),
        scope: ui.view === "root" ? all.find((n) => n.id === ui.folder)?.name ?? "全部文件" : ui.view,
        nodes: current.map((n) => ({ ...n, content: n.content?.slice(0, 200000) })),
        note: "图片 / 音频的二进制内容不在包内，仅导出目录结构与文本。",
      };
      download(`guandao-files-${todayKey()}.json`, JSON.stringify(bundle, null, 2));
      ctx.toast(`已打包导出 ${ids.size} 项`);
      return;
    }

    const menu = t.closest<HTMLElement>("[data-fs-menu]");
    if (menu) {
      e.stopPropagation();
      const id = menu.dataset.fsMenu ?? "";
      const n = read().find((x) => x.id === id);
      if (!n) return;
      const inTrash = Boolean(n.trashed);
      void modal(win, {
        title: n.name,
        body: `<div class="g14-menu-list">
          ${n.type === "file" ? `<button class="g14-menu-item" data-mm="open">打开</button>` : `<button class="g14-menu-item" data-mm="open">进入文件夹</button>`}
          <button class="g14-menu-item" data-mm="detail">查看详情</button>
          <button class="g14-menu-item" data-mm="rename">重命名</button>
          <button class="g14-menu-item" data-mm="star">${n.starred ? "取消收藏" : "收藏"}</button>
          ${inTrash ? `<button class="g14-menu-item" data-mm="restore">恢复到原位置</button>` : `<button class="g14-menu-item" data-mm="copy">复制副本</button><button class="g14-menu-item" data-mm="move">移动到…</button>`}
          ${n.type === "file" && n.content ? `<button class="g14-menu-item" data-mm="export">导出文件</button>` : ""}
          <button class="g14-menu-item is-danger" data-mm="${inTrash ? "purge" : "trash"}">${inTrash ? "彻底删除" : "移到回收站"}</button>
        </div>`,
        actions: [{ label: "关闭", value: "" }],
      }).then(async (v) => {
        const all = read();
        const node = all.find((x) => x.id === id);
        if (!node) return;
        if (v === "open") void openNode(id);
        if (v === "detail") details(id);
        if (v === "star") {
          node.starred = !node.starred;
          write(all);
          paint();
        }
        if (v === "rename") {
          void modal(win, {
            title: "重命名",
            body: `<input class="g14-input" data-modal-input value="${escapeHtml(node.name)}" maxlength="60" />`,
            actions: [
              { label: "取消", value: "" },
              { label: "保存", value: "ok", primary: true },
            ],
          }).then((r) => {
            if (r !== "ok") return;
            const name = (win.querySelector<HTMLInputElement>("[data-modal-input]")?.value ?? "").trim();
            if (!name) return;
            node.name = name.slice(0, 60);
            write(all);
            paint();
          });
        }
        if (v === "copy") {
          const copy: FsNode = { ...node, id: uid(), name: `${node.name} 副本`, at: Date.now(), source: "created" };
          if (node.type === "folder") {
            const kids = all.filter((x) => x.parent === node.id);
            for (const k of kids) all.push({ ...k, id: uid(), parent: copy.id, at: Date.now() });
          }
          all.push(copy);
          write(all);
          paint();
          ctx.toast("已复制");
        }
        if (v === "move") {
          const folders = all.filter((x) => x.type === "folder" && !x.trashed && x.id !== node.id);
          void modal(win, {
            title: "移动到",
            body: `<div class="g14-menu-list">
              <button class="g14-menu-item" data-mm="root">全部文件</button>
              ${folders.map((f) => `<button class="g14-menu-item" data-mm="${escapeHtml(f.id)}">${escapeHtml(f.name)}</button>`).join("")}
            </div>`,
            actions: [{ label: "取消", value: "" }],
          }).then((target) => {
            if (!target) return;
            node.parent = target;
            write(all);
            paint();
            ctx.toast("已移动");
          });
        }
        if (v === "export") download(node.name.endsWith(".md") ? node.name : `${node.name}.txt`, node.content ?? "", "text/plain;charset=utf-8");
        if (v === "trash") {
          node.trashed = true;
          node.trashedAt = Date.now();
          node.prevParent = node.parent;
          write(all);
          paint();
          ctx.toast("已移到回收站");
        }
        if (v === "restore") {
          node.trashed = false;
          node.parent = node.prevParent ?? "root";
          write(all);
          paint();
          ctx.toast("已恢复");
        }
        if (v === "purge") {
          write(all.filter((x) => x.id !== id));
          paint();
          ctx.toast("已彻底删除");
        }
      });
      return;
    }

    const card = t.closest<HTMLElement>("[data-fs-node]");
    if (card) {
      selected = card.dataset.fsNode ?? "";
      paint();
      if (card.dataset.fsType === "folder") void openNode(selected);
    }
  });

  win.addEventListener("dblclick", (e) => {
    const card = (e.target as HTMLElement).closest<HTMLElement>("[data-fs-node]");
    if (card) void openNode(card.dataset.fsNode ?? "");
  });

  win.addEventListener("input", (e) => {
    if ((e.target as HTMLElement).matches("[data-fs-search]")) {
      ui.q = search?.value ?? "";
      paint();
    }
  });

  win.addEventListener("change", (e) => {
    const sel = (e.target as HTMLElement).closest<HTMLSelectElement>("[data-fs-sort]");
    if (sel) {
      ui.sort = (sel.value as FsUi["sort"]) ?? "time";
      ui.asc = ui.sort === "name";
      saveUi();
      paint();
    }
  });

  paint();
  return () => undefined;
};

export const fsStats = () => {
  const all = read();
  return {
    total: all.filter((n) => !n.trashed).length,
    trash: all.filter((n) => n.trashed).length,
    images: all.filter((n) => n.kind === "image" && !n.trashed).length,
    docs: all.filter((n) => n.type === "file" && kindOf(n.name, n.kind) === "doc" && !n.trashed).length,
    bytes: all.reduce((sum, n) => sum + (n.size ?? n.content?.length ?? 0), 0),
  };
};
