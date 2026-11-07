/**
 * Guandao OS 1.4 · Guandao Gallery
 *
 * 导入的图片会等比压缩后存进 IndexedDB（不进 localStorage），
 * 支持相册、收藏、搜索与幻灯片。所有操作都在浏览器本地完成。
 */

import { safeUrl } from "../../html";
import {
  compressImage,
  escapeHtml,
  fmtBytes,
  idb,
  ls,
  modal,
  pickFile,
  uid,
  type Ctx,
} from "../core";

export type Photo = {
  id: string;
  blobKey: string;
  name: string;
  album: string;
  fav: boolean;
  size: number;
  at: number;
  w: number;
  h: number;
};

type GalleryState = {
  v: 1;
  albums: Array<{ id: string; name: string }>;
  photos: Photo[];
  ui: { album: string; q: string; lightbox: string };
};

const KEY = "guandao.os14.gallery.v1";

const read = (): GalleryState =>
  ls.get<GalleryState>(KEY, {
    v: 1,
    albums: [{ id: "all", name: "全部照片" }],
    photos: [],
    ui: { album: "all", q: "", lightbox: "" },
  });

const write = (s: GalleryState) => ls.set(KEY, s);

const urls = new Map<string, string>();

const urlOf = async (key: string): Promise<string | null> => {
  const cached = urls.get(key);
  if (cached) return cached;
  const blob = await idb.get<Blob>("blobs", key);
  if (!blob) return null;
  const url = URL.createObjectURL(blob);
  urls.set(key, url);
  return url;
};

const albumName = (st: GalleryState, id: string) => st.albums.find((a) => a.id === id)?.name ?? "未分类";

const visible = (st: GalleryState) => {
  let list = st.photos.slice();
  if (st.ui.album !== "all") {
    if (st.ui.album === "fav") list = list.filter((p) => p.fav);
    else list = list.filter((p) => p.album === st.ui.album);
  }
  const q = st.ui.q.trim().toLowerCase();
  if (q) list = list.filter((p) => `${p.name} ${albumName(st, p.album)}`.toLowerCase().includes(q));
  return list.sort((a, b) => b.at - a.at);
};

const body = (extra = "") => `
  <div class="ga14" data-ga14>
    <aside class="ga14-side">
      <button class="ga14-import" type="button" data-ga-import>＋ 导入图片</button>
      <div class="ga14-albums" data-ga-albums></div>
      <p class="ga14-tip">图片保存在浏览器 IndexedDB，不会上传，也不会读取你电脑上的其他文件。</p>
    </aside>
    <section class="ga14-main">
      <header class="ga14-bar">
        <input class="ga14-search" data-ga-search placeholder="搜索照片…" />
        <span class="ga14-count" data-ga-count></span>
        <button class="g14-btn" type="button" data-ga-slide>▶ 幻灯片</button>
      </header>
      <div class="ga14-grid" data-ga-grid></div>
    </section>
    ${extra}
  </div>`;

export const renderGallery = () => body();

/** 供文件管理器调用：把一张已存入 IndexedDB 的图片登记到相册 */
export const addExternalPhoto = (blobKey: string, name: string, size: number) => {
  const st = read();
  st.photos.unshift({
    id: uid(),
    blobKey,
    name: name.replace(/\.[^.]+$/, "").slice(0, 48),
    album: "all",
    fav: false,
    size,
    at: Date.now(),
    w: 0,
    h: 0,
  });
  write(st);
};

export const initGallery = (win: HTMLElement, ctx: Ctx): (() => void) => {
  const root = win.querySelector<HTMLElement>("[data-ga14]");
  if (!root) return () => undefined;
  let st = read();
  let slideTimer = 0;
  const grid = root.querySelector<HTMLElement>("[data-ga-grid]");
  const albumsEl = root.querySelector<HTMLElement>("[data-ga-albums]");
  const search = root.querySelector<HTMLInputElement>("[data-ga-search]");

  const paintAlbums = () => {
    if (!albumsEl) return;
    albumsEl.innerHTML =
      `<button class="ga14-album ${st.ui.album === "all" ? "is-active" : ""}" type="button" data-ga-album="all"><span>▤</span>全部照片<b>${st.photos.length}</b></button>
       <button class="ga14-album ${st.ui.album === "fav" ? "is-active" : ""}" type="button" data-ga-album="fav"><span>★</span>收藏<b>${st.photos.filter((p) => p.fav).length}</b></button>` +
      st.albums
        .filter((a) => a.id !== "all")
        .map((a) => {
          const n = st.photos.filter((p) => p.album === a.id).length;
          return `<button class="ga14-album ${st.ui.album === a.id ? "is-active" : ""}" type="button" data-ga-album="${escapeHtml(a.id)}">
            <span>▸</span>${escapeHtml(a.name)}<b>${n}</b><i data-ga-album-menu="${escapeHtml(a.id)}">⋯</i>
          </button>`;
        })
        .join("") +
      `<button class="ga14-album is-add" type="button" data-ga-album-add>＋ 新建相册</button>`;
  };

  const paintGrid = async () => {
    if (!grid) return;
    const list = visible(st);
    const count = root.querySelector<HTMLElement>("[data-ga-count]");
    if (count) count.textContent = `${list.length} 张`;
    if (!list.length) {
      grid.innerHTML = `<div class="ga14-empty">
        <span>▣</span>
        <p>${st.photos.length ? "这个相册还没有照片" : "还没有照片"}</p>
        <p class="ga14-empty-sub">点左侧「导入图片」选择本地图片，会压缩后保存在浏览器里。</p>
      </div>`;
      return;
    }
    grid.innerHTML = list
      .map(
        (p) => `<button class="ga14-card" type="button" data-ga-open="${escapeHtml(p.id)}">
          <span class="ga14-thumb" data-thumb="${escapeHtml(p.blobKey)}"><i>▣</i></span>
          <span class="ga14-meta"><b>${escapeHtml(p.name)}</b><i>${fmtBytes(p.size)}${p.fav ? " · ★" : ""}</i></span>
        </button>`,
      )
      .join("");
    for (const p of list.slice(0, 120)) {
      const el = grid.querySelector<HTMLElement>(`[data-thumb="${CSS.escape(p.blobKey)}"]`);
      if (!el) continue;
      const url = await urlOf(p.blobKey);
      if (url) el.innerHTML = `<img src="${safeUrl(url)}" alt="${escapeHtml(p.name)}" loading="lazy" draggable="false" />`;
    }
  };

  const paint = async () => {
    paintAlbums();
    await paintGrid();
  };

  const openLightbox = async (id: string) => {
    const idx = visible(st).findIndex((p) => p.id === id);
    const list = visible(st);
    const p = list[idx];
    if (!p) return;
    const url = await urlOf(p.blobKey);
    const existing = root.querySelector(".ga14-lightbox");
    existing?.remove();
    const box = document.createElement("div");
    box.className = "ga14-lightbox";
    box.innerHTML = `
      <div class="ga14-lb-bar">
        <span>${escapeHtml(p.name)} · ${idx + 1}/${list.length}</span>
        <div>
          <button type="button" data-lb-fav>${p.fav ? "★ 已收藏" : "☆ 收藏"}</button>
          <button type="button" data-lb-del>删除</button>
          <button type="button" data-lb-close>✕</button>
        </div>
      </div>
      <div class="ga14-lb-stage"><img src="${safeUrl(url ?? "")}" alt="${escapeHtml(p.name)}"/></div>
      <div class="ga14-lb-foot">
        <button type="button" data-lb-prev>‹ 上一张</button>
        <span>${fmtBytes(p.size)} · ${albumName(st, p.album)}</span>
        <button type="button" data-lb-next>下一张 ›</button>
      </div>`;
    root.appendChild(box);
    const step = (dir: number) => {
      const next = list[(idx + dir + list.length) % list.length];
      if (next) void openLightbox(next.id);
    };
    box.addEventListener("click", (e) => {
      const t = e.target as HTMLElement;
      if (t.closest("[data-lb-close]") || t === box) {
        box.remove();
        st.ui.lightbox = "";
        write(st);
        return;
      }
      if (t.closest("[data-lb-prev]")) step(-1);
      if (t.closest("[data-lb-next]")) step(1);
      if (t.closest("[data-lb-fav]")) {
        p.fav = !p.fav;
        write(st);
        box.remove();
        void openLightbox(p.id);
        void paint();
      }
      if (t.closest("[data-lb-del]")) {
        void modal(win, {
          title: "删除这张图片？",
          body: `<p class="g14-modal-text">会从浏览器里彻底移除，原文件不受影响。</p>`,
          actions: [
            { label: "取消", value: "" },
            { label: "删除", value: "ok", danger: true, primary: true },
          ],
        }).then(async (v) => {
          if (v !== "ok") return;
          await idb.del("blobs", p.blobKey);
          urls.delete(p.blobKey);
          st.photos = st.photos.filter((x) => x.id !== p.id);
          write(st);
          box.remove();
          await paint();
        });
      }
    });
    const keyHandler = (e: KeyboardEvent) => {
      if (!box.isConnected) {
        win.removeEventListener("keydown", keyHandler);
        return;
      }
      if (e.key === "Escape") box.remove();
      if (e.key === "ArrowLeft") step(-1);
      if (e.key === "ArrowRight") step(1);
    };
    win.addEventListener("keydown", keyHandler);
  };

  const importImages = () => {
    pickFile("image/*", true, async (files) => {
      let ok = 0;
      for (const file of files.slice(0, 40)) {
        if (!file.type.startsWith("image/")) continue;
        const blob = await compressImage(file, 1800);
        const key = `img:${uid()}`;
        if (!(await idb.put("blobs", key, blob))) continue;
        let w = 0;
        let h = 0;
        try {
          const bmp = await createImageBitmap(blob);
          w = bmp.width;
          h = bmp.height;
        } catch {
          /* 尺寸拿不到就不显示 */
        }
        st.photos.unshift({
          id: uid(),
          blobKey: key,
          name: file.name.replace(/\.[^.]+$/, "").slice(0, 48),
          album: st.ui.album === "all" || st.ui.album === "fav" ? "all" : st.ui.album,
          fav: false,
          size: blob.size,
          at: Date.now(),
          w,
          h,
        });
        ok++;
      }
      write(st);
      await paint();
      ctx.toast(ok ? `已导入 ${ok} 张图片` : "没有可导入的图片");
    });
  };

  win.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    if (t.closest("[data-ga-import]")) return importImages();
    const album = t.closest<HTMLElement>("[data-ga-album]");
    if (album) {
      st.ui.album = album.dataset.gaAlbum ?? "all";
      write(st);
      void paint();
      return;
    }
    if (t.closest("[data-ga-album-add]")) {
      void modal(win, {
        title: "新建相册",
        body: `<input class="g14-input" data-modal-input placeholder="相册名称" maxlength="16" />`,
        actions: [
          { label: "取消", value: "" },
          { label: "创建", value: "ok", primary: true },
        ],
      }).then((v) => {
        if (v !== "ok") return;
        const name = (win.querySelector<HTMLInputElement>("[data-modal-input]")?.value ?? "").trim();
        if (!name) return;
        st.albums.push({ id: `a-${uid().slice(0, 8)}`, name: name.slice(0, 16) });
        write(st);
        void paint();
      });
      return;
    }
    const menu = t.closest<HTMLElement>("[data-ga-album-menu]");
    if (menu) {
      e.stopPropagation();
      const id = menu.dataset.gaAlbumMenu ?? "";
      const al = st.albums.find((a) => a.id === id);
      if (!al) return;
      void modal(win, {
        title: al.name,
        body: `<div class="g14-menu-list"><button class="g14-menu-item" data-mm="rename">重命名</button><button class="g14-menu-item is-danger" data-mm="del">删除相册</button></div>`,
        actions: [{ label: "关闭", value: "" }],
      }).then((v) => {
        if (v === "rename") {
          void modal(win, {
            title: "重命名相册",
            body: `<input class="g14-input" data-modal-input value="${escapeHtml(al.name)}" maxlength="16"/>`,
            actions: [
              { label: "取消", value: "" },
              { label: "保存", value: "ok", primary: true },
            ],
          }).then((r) => {
            if (r !== "ok") return;
            const name = (win.querySelector<HTMLInputElement>("[data-modal-input]")?.value ?? "").trim();
            if (name) al.name = name.slice(0, 16);
            write(st);
            void paint();
          });
        }
        if (v === "del") {
          st.albums = st.albums.filter((a) => a.id !== id);
          for (const p of st.photos) if (p.album === id) p.album = "all";
          if (st.ui.album === id) st.ui.album = "all";
          write(st);
          void paint();
        }
      });
      return;
    }
    const open = t.closest<HTMLElement>("[data-ga-open]");
    if (open) {
      void openLightbox(open.dataset.gaOpen ?? "");
      return;
    }
    if (t.closest("[data-ga-slide]")) {
      const list = visible(st);
      if (!list.length) {
        ctx.toast("还没有照片可以播放");
        return;
      }
      let i = 0;
      const show = () => {
        const p = list[i % list.length];
        i++;
        void openLightbox(p.id);
      };
      show();
      window.clearInterval(slideTimer);
      slideTimer = window.setInterval(show, 4200);
      ctx.toast("幻灯片开始，按 Esc 关闭当前图片");
      return;
    }
  });

  win.addEventListener("input", (e) => {
    if ((e.target as HTMLElement).matches("[data-ga-search]")) {
      st.ui.q = search?.value ?? "";
      write(st);
      void paintGrid();
    }
  });

  void paint();
  return () => {
    window.clearInterval(slideTimer);
    for (const url of urls.values()) URL.revokeObjectURL(url);
    urls.clear();
  };
};
