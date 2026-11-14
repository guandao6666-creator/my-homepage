/**
 * Guandao Cloud Drive · 个人云端文件空间
 *
 * 与本地 `files.ts` 的虚拟文件系统完全分离：
 * 这里所有数据来自 /api/files，文件本体在 R2，元数据在 D1。
 */

// 1.9：应用样式跟着应用代码一起按需加载，不再压进首屏 CSS
import { safeUrl } from "../html";
import "../../styles/drive.css";
import { escapeHtml, fmtBytes, fmtDateTime, modal } from "./core";
import { reportDriveSync } from "../devices/client";
import { sendToDevice } from "../continuity/ui";
import type { Ctx } from "./core";

type DriveFile = {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  parentId: string | null;
  category: "image" | "audio" | "video" | "document" | "other";
  isFavorite: boolean;
  createdAt: number;
  updatedAt: number;
};

type DriveFolder = {
  id: string;
  name: string;
  parentId: string | null;
  isFavorite: boolean;
};

type Quota = {
  limitBytes: number;
  usedBytes: number;
  remainingBytes: number;
  files: number;
  images: number;
  documents: number;
  audio: number;
  video: number;
  trashBytes: number;
  trashCount: number;
};

const VIEWS = [
  { id: "overview", name: "Overview", glyph: "◈" },
  { id: "all", name: "All Files", glyph: "▤" },
  { id: "image", name: "My Images", glyph: "▣" },
  { id: "document", name: "My Documents", glyph: "▥" },
  { id: "audio", name: "My Audio", glyph: "♪" },
  { id: "video", name: "My Videos", glyph: "▶" },
  { id: "recent", name: "Recent", glyph: "◷" },
  { id: "favorites", name: "Favorites", glyph: "★" },
  { id: "shared", name: "Shared", glyph: "⇄", disabled: true },
  { id: "trash", name: "Trash", glyph: "⌫" },
];

export const renderDrive = () => `
  <div class="cdrv" data-drive>
    <aside class="cdrv-side">
      <div class="cdrv-brand">
        <span class="cdrv-brand-logo">云</span>
        <div><b>Cloud Drive</b><i>Your Files, Everywhere</i></div>
      </div>
      <nav class="cdrv-nav">
        ${VIEWS.map(
          (view) => `<button type="button" class="cdrv-nav-item" data-view="${view.id}" ${view.disabled ? "disabled" : ""}>
            <span class="cdrv-nav-ico">${view.glyph}</span>
            <span>${view.name}</span>
            ${view.disabled ? '<em>未开放</em>' : ""}
          </button>`,
        ).join("")}
      </nav>
      <div class="cdrv-quota">
        <div class="cdrv-quota-top"><span>存储空间</span><b data-quota-text>—</b></div>
        <div class="cdrv-quota-bar"><span data-quota-fill></span></div>
        <p data-quota-sub>正在读取…</p>
      </div>
    </aside>

    <section class="cdrv-main">
      <header class="cdrv-top">
        <div class="cdrv-crumb" data-crumb></div>
        <div class="cdrv-tools">
          <label class="cdrv-search">
            <span>⌕</span>
            <input type="search" placeholder="搜索云端文件…" data-search autocomplete="off" />
          </label>
          <button type="button" class="cdrv-btn cdrv-btn-primary" data-upload>上传</button>
          <button type="button" class="cdrv-btn" data-newfolder>新建文件夹</button>
          <button type="button" class="cdrv-icon" data-refresh title="刷新">↻</button>
          <select class="cdrv-select" data-sort title="排序">
            <option value="updated">最近修改</option>
            <option value="created">上传时间</option>
            <option value="name">名称</option>
            <option value="size">大小</option>
            <option value="type">类型</option>
          </select>
          <button type="button" class="cdrv-icon" data-layout title="切换视图">▦</button>
        </div>
      </header>

      <div class="cdrv-stats" data-stats hidden></div>
      <div class="cdrv-body" data-body>
        <div class="cdrv-grid" data-grid></div>
      </div>

      <div class="cdrv-drop" data-drop hidden><span>松开以上传到当前文件夹</span></div>
      <div class="cdrv-uploads" data-uploads hidden></div>
    </section>

    <input type="file" multiple hidden data-file />
  </div>
`;

export const initDrive = (win: HTMLElement, ctx?: Ctx): (() => void) => {
  const root = win.querySelector<HTMLElement>("[data-drive]");
  if (!root) return () => undefined;

  const grid = root.querySelector<HTMLElement>("[data-grid]")!;
  const crumb = root.querySelector<HTMLElement>("[data-crumb]")!;
  const stats = root.querySelector<HTMLElement>("[data-stats]")!;
  const quotaText = root.querySelector<HTMLElement>("[data-quota-text]")!;
  const quotaFill = root.querySelector<HTMLElement>("[data-quota-fill]")!;
  const quotaSub = root.querySelector<HTMLElement>("[data-quota-sub]")!;
  const search = root.querySelector<HTMLInputElement>("[data-search]")!;
  const sort = root.querySelector<HTMLSelectElement>("[data-sort]")!;
  const fileInput = root.querySelector<HTMLInputElement>("[data-file]")!;
  const uploads = root.querySelector<HTMLElement>("[data-uploads]")!;
  const dropMask = root.querySelector<HTMLElement>("[data-drop]")!;
  const body = root.querySelector<HTMLElement>("[data-body]")!;

  let view = "overview";
  let folderId: string | null = null;
  let items: DriveFile[] = [];
  let folders: DriveFolder[] = [];
  let allFolders: DriveFolder[] = [];
  let quota: Quota | null = null;
  let layout: "grid" | "list" = "grid";
  let query = "";
  let loading = false;
  let debounce = 0;
  let dragId: string | null = null;

  const api = async <T,>(path: string, init?: RequestInit): Promise<T> => {
    const response = await fetch(path, {
      ...init,
      credentials: "same-origin",
      headers: { accept: "application/json", ...(init?.body ? { "content-type": "application/json" } : {}), ...(init?.headers || {}) },
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error(payload?.error?.message || `请求失败（${response.status}）`);
    return payload.data as T;
  };

  const toast = (message: string, error = false) => {
    const node = document.createElement("div");
    node.className = `cdrv-toast${error ? " is-error" : ""}`;
    node.textContent = message;
    root.appendChild(node);
    window.setTimeout(() => node.classList.add("is-out"), 2200);
    window.setTimeout(() => node.remove(), 2600);
  };

  const loadQuota = async () => {
    quota = await api<Quota>("/api/files/quota");
    const used = fmtBytes(quota.usedBytes);
    const limit = fmtBytes(quota.limitBytes);
    quotaText.textContent = `${used} / ${limit}`;
    const ratio = Math.min((quota.usedBytes / Math.max(quota.limitBytes, 1)) * 100, 100);
    quotaFill.style.width = `${ratio}%`;
    quotaFill.classList.toggle("is-warn", ratio > 85);
    quotaSub.textContent = `剩余 ${fmtBytes(quota.remainingBytes)} · ${quota.files} 个文件 · 回收站 ${fmtBytes(quota.trashBytes)}`;
  };

  const load = async () => {
    if (loading) return;
    loading = true;
    grid.innerHTML = `<div class="cdrv-loading"><span></span><p>正在读取云端文件…</p></div>`;
    try {
      const params = new URLSearchParams({
        view: view === "all" ? "folder" : view === "overview" ? "recent" : view,
        sort: sort.value,
        limit: "120",
      });
      if (view === "all") params.set("folderId", folderId || "root");
      if (query) params.set("search", query);
      const data = await api<{ items: DriveFile[]; folders: DriveFolder[] }>(`/api/files?${params}`);
      items = data.items || [];
      folders = data.folders || [];
      allFolders = (await api<{ folders: DriveFolder[] }>("/api/files/folders")).folders || [];
      await loadQuota();
      render();
      // 真实完成一次云端读取后上报同步结果；失败不会影响文件浏览。
      void reportDriveSync({ result: "success" });
    } catch (error) {
      grid.innerHTML = `<div class="cdrv-empty"><span>⚠</span><p>${escapeHtml(error instanceof Error ? error.message : "加载失败")}</p><button type="button" data-refresh>重试</button></div>`;
      void reportDriveSync({
        result: "failed",
        message: error instanceof Error ? error.message : "云端读取失败",
      });
    } finally {
      loading = false;
    }
  };

  const folderChain = (): DriveFolder[] => {
    if (!folderId) return [];
    const map = new Map(allFolders.map((folder) => [folder.id, folder]));
    const chain: DriveFolder[] = [];
    let current = map.get(folderId);
    let guard = 0;
    while (current && guard < 20) {
      chain.unshift(current);
      current = current.parentId ? map.get(current.parentId) : undefined;
      guard += 1;
    }
    return chain;
  };

  const renderCrumb = () => {
    if (view !== "all") {
      const label = VIEWS.find((item) => item.id === view)?.name || "Cloud Drive";
      crumb.innerHTML = `<b>${label}</b>`;
      return;
    }
    const chain = folderChain();
    crumb.innerHTML =
      `<button type="button" data-go="root">全部文件</button>` +
      chain.map((folder) => `<span>›</span><button type="button" data-go="${folder.id}">${escapeHtml(folder.name)}</button>`).join("");
  };

  const statsBand = () => {
    if (view !== "overview" || !quota) {
      stats.hidden = true;
      return;
    }
    stats.hidden = false;
    stats.innerHTML = `
      <div><b>${quota.files}</b><span>文件总数</span></div>
      <div><b>${quota.images}</b><span>图片</span></div>
      <div><b>${quota.documents}</b><span>文档</span></div>
      <div><b>${quota.audio + quota.video}</b><span>音视频</span></div>
      <div><b>${fmtBytes(quota.usedBytes)}</b><span>已使用</span></div>`;
  };

  const iconFor = (file: DriveFile) =>
    file.category === "image" ? "di-viewer" : file.category === "audio" ? "di-music" : file.category === "video" ? "di-play" : file.category === "document" ? "di-note" : "di-files";

  const render = () => {
    renderCrumb();
    statsBand();
    root.querySelectorAll<HTMLElement>("[data-view]").forEach((button) => {
      button.classList.toggle("is-active", button.dataset.view === view);
    });
    grid.className = `cdrv-grid${layout === "list" ? " is-list" : ""}`;

    const folderCards = folders.map(
      (folder) => `<article class="cdrv-card is-folder" data-folder="${folder.id}" draggable="false">
        <div class="cdrv-thumb"><span class="di-glyph di-folder"></span></div>
        <div class="cdrv-name" title="${escapeHtml(folder.name)}">${escapeHtml(folder.name)}</div>
        <div class="cdrv-meta">文件夹${folder.isFavorite ? " · ★" : ""}</div>
        <button type="button" class="cdrv-more" data-menu-folder="${folder.id}" aria-label="文件夹操作">⋯</button>
      </article>`,
    );

    const fileCards = items.map((file) => {
      const thumb =
        file.category === "image"
          ? `<img src="${safeUrl(`/api/files/${file.id}/content`)}" alt="" loading="lazy" />`
          : `<span class="di-glyph ${iconFor(file)}"></span>`;
      return `<article class="cdrv-card" data-file="${file.id}" draggable="true">
        <div class="cdrv-thumb">${thumb}${file.isFavorite ? '<i class="cdrv-star">★</i>' : ""}</div>
        <div class="cdrv-name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</div>
        <div class="cdrv-meta">${fmtBytes(file.sizeBytes)} · ${fmtDateTime(file.updatedAt)}</div>
        <button type="button" class="cdrv-more" data-menu-file="${file.id}" aria-label="文件操作">⋯</button>
      </article>`;
    }).join("");

    if (!folderCards.length && !fileCards.length) {
      grid.innerHTML = `<div class="cdrv-empty"><span>▤</span><p>${view === "trash" ? "回收站是空的" : "这里还没有文件"}</p><p class="cdrv-empty-sub">${view === "trash" ? "删除的文件会先放到这里。" : "点击「上传」或把文件拖进来。"}</p></div>`;
      return;
    }
    grid.innerHTML = folderCards.join("") + fileCards;
  };

  /* ------------------------------ 上传 ------------------------------ */

  const uploadOne = (file: File, retry = false) => {
    if (file.size > 25 * 1024 * 1024) {
      toast(`${file.name} 超过 25 MiB`, true);
      return;
    }
    const row = document.createElement("div");
    row.className = "cdrv-up";
    row.innerHTML = `<div class="cdrv-up-top"><span title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</span><b>0%</b></div>
      <div class="cdrv-up-bar"><span></span></div>
      <div class="cdrv-up-actions"><button type="button" data-cancel>取消</button><button type="button" data-retry hidden>重试</button></div>`;
    uploads.hidden = false;
    uploads.appendChild(row);

    const bar = row.querySelector<HTMLElement>(".cdrv-up-bar span")!;
    const percent = row.querySelector<HTMLElement>("b")!;
    const retryBtn = row.querySelector<HTMLButtonElement>("[data-retry]")!;
    const cancelBtn = row.querySelector<HTMLButtonElement>("[data-cancel]")!;
    const xhr = new XMLHttpRequest();
    let cancelled = false;

    const finish = (ok: boolean, message?: string) => {
      if (ok) {
        row.classList.add("is-done");
        window.setTimeout(() => row.remove(), 1500);
      } else {
        row.classList.add("is-error");
        percent.textContent = message || "失败";
        retryBtn.hidden = false;
        cancelBtn.hidden = true;
      }
    };

    xhr.upload.addEventListener("progress", (event) => {
      if (!event.lengthComputable) return;
      const value = Math.round((event.loaded / event.total) * 100);
      bar.style.width = `${value}%`;
      percent.textContent = `${value}%`;
    });

    xhr.addEventListener("load", () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        finish(true);
        void load();
      } else {
        let message = "上传失败";
        try {
          message = JSON.parse(xhr.responseText)?.error?.message || message;
        } catch {
          /* ignore */
        }
        finish(false, message);
      }
    });
    xhr.addEventListener("error", () => finish(false, "网络错误"));
    xhr.addEventListener("abort", () => {
      row.remove();
    });

    cancelBtn.addEventListener("click", () => {
      cancelled = true;
      xhr.abort();
    });
    retryBtn.addEventListener("click", () => {
      row.remove();
      uploadOne(file, true);
    });

    const parent = view === "all" ? folderId || "" : "";
    xhr.open("POST", `/api/files/upload?name=${encodeURIComponent(file.name)}&parentId=${encodeURIComponent(parent)}`);
    xhr.setRequestHeader("content-type", file.type || "application/octet-stream");
    xhr.send(file);
    if (cancelled) xhr.abort();
  };

  const uploadFiles = (files: FileList | File[]) => {
    for (const file of Array.from(files)) uploadOne(file);
  };

  /* ------------------------------ 操作菜单 --------------------------- */

  const openMenu = (event: MouseEvent, type: "file" | "folder", id: string) => {
    event.stopPropagation();
    root.querySelectorAll(".cdrv-menu").forEach((node) => node.remove());
    const item = type === "file" ? items.find((file) => file.id === id) : folders.find((folder) => folder.id === id);
    if (!item) return;

    const menu = document.createElement("div");
    menu.className = "cdrv-menu";
    menu.style.left = `${Math.min(event.clientX, window.innerWidth - 180)}px`;
    menu.style.top = `${Math.min(event.clientY, window.innerHeight - 220)}px`;

    const buttons: Array<[string, string]> = type === "file"
      ? [
          ["preview", "预览"],
          ["send", "发送到设备"],
          ["download", "下载"],
          ["rename", "重命名"],
          ["favorite", item.isFavorite ? "取消收藏" : "收藏"],
          ["trash", "移入回收站"],
        ]
      : [
          ["open", "打开"],
          ["rename", "重命名"],
          ["favorite", item.isFavorite ? "取消收藏" : "收藏"],
          ["trash", "移入回收站"],
        ];

    menu.innerHTML = buttons.map(([action, label]) => `<button type="button" data-act="${action}">${label}</button>`).join("");
    root.appendChild(menu);

    menu.addEventListener("click", (clickEvent) => {
      const action = (clickEvent.target as HTMLElement).closest<HTMLElement>("[data-act]")?.dataset.act;
      menu.remove();
      if (!action) return;
      void handleAction(type, item, action);
    });

    window.setTimeout(() => {
      const close = () => {
        menu.remove();
        document.removeEventListener("click", close);
      };
      document.addEventListener("click", close);
    }, 0);
  };

  const handleAction = async (type: "file" | "folder", item: DriveFile | DriveFolder, action: string) => {
    if (type === "file" && action === "send") {
      const file = item as DriveFile;
      if (!ctx) {
        toast("当前环境不支持接力", true);
        return;
      }
      void sendToDevice(ctx, {
        itemType: "file",
        title: file.name,
        resourceId: file.id,
        payload: {
          name: file.name,
          mimeType: file.mimeType,
          sizeBytes: file.sizeBytes,
          category: file.category,
        },
      });
      return;
    }
    if (type === "folder") {
      if (action === "open") {
        folderId = item.id;
        view = "all";
        await load();
        return;
      }
      if (action === "rename") {
        const name = await promptName("重命名文件夹", item.name);
        if (!name) return;
        await fetch(`/api/files/folders/${item.id}`, { method: "PATCH", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });
        await load();
        return;
      }
      if (action === "favorite") {
        await fetch(`/api/files/folders/${item.id}`, { method: "PATCH", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ isFavorite: !item.isFavorite }) });
        await load();
        return;
      }
      if (action === "trash") {
        const ok = window.confirm(`将「${item.name}」及其内容移入回收站？`);
        if (!ok) return;
        const response = await fetch(`/api/files/folders/${item.id}?recursive=1`, { method: "DELETE", credentials: "same-origin" });
        if (!response.ok) {
          const payload = await response.json().catch(() => null);
          toast(payload?.error?.message || "删除失败", true);
          return;
        }
        await load();
      }
      return;
    }

    const file = item as DriveFile;
    if (action === "preview") return preview(file);
    if (action === "download") {
      const anchor = document.createElement("a");
      anchor.href = `/api/files/${file.id}/download`;
      anchor.download = file.name;
      anchor.click();
      return;
    }
    if (action === "rename") {
      const name = await promptName("重命名文件", file.name);
      if (!name) return;
      await fetch(`/api/files/${file.id}`, { method: "PATCH", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ displayName: name }) });
      await load();
      return;
    }
    if (action === "favorite") {
      await fetch(`/api/files/${file.id}`, { method: "PATCH", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ isFavorite: !file.isFavorite }) });
      await load();
      return;
    }
    if (action === "trash") {
      await fetch(`/api/files/${file.id}`, { method: "DELETE", credentials: "same-origin" });
      await load();
    }
  };

  const promptName = async (title: string, value: string): Promise<string | null> => {
    const result = await modal(win, {
      title,
      body: `<input class="g14-input" data-cdrv-input value="${escapeHtml(value)}" maxlength="120" />`,
      actions: [
        { label: "取消", value: "" },
        { label: "保存", value: "ok", primary: true },
      ],
    });
    if (result !== "ok") return null;
    return (win.querySelector<HTMLInputElement>("[data-cdrv-input]")?.value || "").trim() || null;
  };

  const preview = async (file: DriveFile) => {
    const url = `/api/files/${file.id}/content`;
    let content = "";
    if (file.category === "image") content = `<img class="cdrv-prev-img" src="${safeUrl(url, { allowBlob: true, allowData: true })}" alt="${escapeHtml(file.name)}" />`;
    else if (file.category === "audio") content = `<audio class="cdrv-prev-audio" controls src="${safeUrl(url, { allowBlob: true, allowData: true })}"></audio>`;
    else if (file.category === "video") content = `<video class="cdrv-prev-video" controls src="${safeUrl(url, { allowBlob: true, allowData: true })}"></video>`;
    else if (file.mimeType === "application/pdf") content = `<iframe class="cdrv-prev-pdf" src="${safeUrl(url, { allowBlob: true })}" title="PDF"></iframe>`;
    else if (file.mimeType.startsWith("text/")) {
      const text = await fetch(url, { credentials: "same-origin" }).then((response) => response.text()).catch(() => "");
      content = `<pre class="cdrv-prev-text">${escapeHtml(text.slice(0, 20000))}</pre>`;
    } else {
      content = `<div class="cdrv-prev-empty"><span class="di-glyph di-files"></span><p>此类型不支持在线预览</p></div>`;
    }

    await modal(win, {
      title: file.name,
      body: `<div class="cdrv-prev">${content}</div>
        <div class="cdrv-prev-meta">${fmtBytes(file.sizeBytes)} · ${escapeHtml(file.mimeType)} · ${fmtDateTime(file.updatedAt)}</div>`,
      actions: [
        { label: "关闭", value: "" },
        { label: "下载", value: "download", primary: true },
      ],
    }).then((choice) => {
      if (choice !== "download") return;
      const anchor = document.createElement("a");
      anchor.href = `/api/files/${file.id}/download`;
      anchor.download = file.name;
      anchor.click();
    });
  };

  /* ------------------------------ 事件 ------------------------------ */

  root.querySelectorAll<HTMLElement>("[data-view]").forEach((button) => {
    button.addEventListener("click", () => {
      const next = button.dataset.view as string;
      if (next === "shared") return;
      view = next;
      folderId = null;
      query = "";
      search.value = "";
      void load();
    });
  });

  grid.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const moreFile = target.closest<HTMLElement>("[data-menu-file]");
    if (moreFile) return openMenu(event, "file", moreFile.dataset.menuFile!);
    const moreFolder = target.closest<HTMLElement>("[data-menu-folder]");
    if (moreFolder) return openMenu(event, "folder", moreFolder.dataset.menuFolder!);

    const folder = target.closest<HTMLElement>("[data-folder]");
    if (folder) {
      folderId = folder.dataset.folder!;
      view = "all";
      void load();
      return;
    }
    const file = target.closest<HTMLElement>("[data-file]");
    if (file) {
      const found = items.find((item) => item.id === file.dataset.file);
      if (found) void preview(found);
    }
  });

  crumb.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLElement>("[data-go]");
    if (!button) return;
    view = "all";
    folderId = button.dataset.go === "root" ? null : button.dataset.go!;
    void load();
  });

  root.querySelector("[data-upload]")?.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    if (fileInput.files?.length) uploadFiles(fileInput.files);
    fileInput.value = "";
  });

  root.querySelector("[data-newfolder]")?.addEventListener("click", async () => {
    const name = await promptName("新建文件夹", "");
    if (!name) return;
    const parentId = view === "all" ? folderId : null;
    const response = await fetch("/api/files/folders", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, parentId }),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      toast(payload?.error?.message || "创建失败", true);
      return;
    }
    await load();
  });

  root.querySelector("[data-refresh]")?.addEventListener("click", () => void load());
  sort.addEventListener("change", () => void load());

  search.addEventListener("input", () => {
    window.clearTimeout(debounce);
    debounce = window.setTimeout(() => {
      query = search.value.trim();
      void load();
    }, 250);
  });

  root.querySelector("[data-layout]")?.addEventListener("click", () => {
    layout = layout === "grid" ? "list" : "grid";
    render();
  });

  root.addEventListener("dragover", (event) => {
    if (!event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault();
    dropMask.hidden = false;
  });
  root.addEventListener("dragleave", (event) => {
    if (event.target === root) dropMask.hidden = true;
  });
  root.addEventListener("drop", (event) => {
    dropMask.hidden = true;
    if (event.dataTransfer?.files?.length) {
      event.preventDefault();
      uploadFiles(event.dataTransfer.files);
    }
  });

  grid.addEventListener("dragstart", (event) => {
    const card = (event.target as HTMLElement).closest<HTMLElement>("[data-file]");
    if (!card) return;
    dragId = card.dataset.file!;
  });
  grid.addEventListener("dragover", (event) => {
    if (!dragId) return;
    const folder = (event.target as HTMLElement).closest<HTMLElement>("[data-folder]");
    if (!folder) return;
    event.preventDefault();
    folder.classList.add("is-drop");
  });
  grid.addEventListener("dragleave", (event) => {
    (event.target as HTMLElement).closest<HTMLElement>("[data-folder]")?.classList.remove("is-drop");
  });
  grid.addEventListener("drop", async (event) => {
    const folder = (event.target as HTMLElement).closest<HTMLElement>("[data-folder]");
    if (!folder || !dragId) return;
    event.preventDefault();
    const response = await fetch(`/api/files/${dragId}`, {
      method: "PATCH",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parentId: folder.dataset.folder }),
    });
    dragId = null;
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      toast(payload?.error?.message || "移动失败", true);
      return;
    }
    toast("已移动");
    await load();
  });

  void load();

  return () => {
    window.clearTimeout(debounce);
    root.querySelectorAll(".cdrv-toast,.cdrv-menu").forEach((node) => node.remove());
  };
};
