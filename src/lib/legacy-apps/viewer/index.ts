/**
 * 图片查看器（viewer）· 对应 index.astro 原 `renderViewer` / `initViewer`。
 *
 * 无外部依赖；图片以 DataURL 留在内存，不上传、不落盘。
 * 所有监听器都挂在窗口元素或它创建的一次性 `<input>` 上，
 * 窗口销毁即回收，无需 cleanup。
 */
import type { LegacyAppModule } from "../types";

export const viewerApp: LegacyAppModule = {
  id: "viewer",
  title: "图片查看器",
  width: 640,
  height: 500,
  glyph: "di-viewer",
  body: () => `
          <div class="viewer">
            <div class="viewer-bar">
              <button class="view-btn" data-view-open type="button">打开图片</button>
              <span class="view-sep"></span>
              <button class="view-btn" data-view-prev type="button" title="上一张">‹</button>
              <button class="view-btn" data-view-next type="button" title="下一张">›</button>
              <span class="view-sep"></span>
              <button class="view-btn" data-view-zoom="out" type="button" title="缩小">−</button>
              <button class="view-btn" data-view-zoom="in" type="button" title="放大">＋</button>
              <button class="view-btn" data-view-rotate type="button" title="旋转">⟳</button>
              <button class="view-btn" data-view-full type="button" title="全屏">全屏</button>
            </div>
            <div class="viewer-stage" data-view-stage>
              <div class="viewer-empty" data-view-empty>还没有图片。<br/>点「打开图片」选择本地图片（不会上传）。</div>
              <img class="viewer-img" data-view-img hidden alt="" />
            </div>
            <div class="viewer-info" data-view-info></div>
          </div>`,
  init: (win) => {
    const img = win.querySelector("[data-view-img]") as HTMLImageElement | null;
    const empty = win.querySelector("[data-view-empty]") as HTMLElement | null;
    const info = win.querySelector("[data-view-info]");
    const stage = win.querySelector("[data-view-stage]") as HTMLElement | null;
    const gallery: { src: string; name: string; size: number }[] = [];
    let idx = -1;
    let zoom = 1;
    let deg = 0;

    const apply = () => {
      if (img) img.style.transform = `scale(${zoom}) rotate(${deg}deg)`;
    };
    const show = () => {
      const item = gallery[idx];
      if (!item || !img) return;
      img.src = item.src;
      img.hidden = false;
      if (empty) empty.hidden = true;
      zoom = 1;
      deg = 0;
      apply();
      if (info) info.textContent = `${item.name} · ${(item.size / 1024).toFixed(0)} KB · ${idx + 1}/${gallery.length}`;
    };

    win.querySelector("[data-view-open]")?.addEventListener("click", () => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "image/*";
      input.multiple = true;
      input.onchange = () => {
        const files = Array.from(input.files ?? []);
        for (const f of files) {
          const reader = new FileReader();
          reader.onload = () => {
            gallery.push({ src: String(reader.result), name: f.name, size: f.size });
            idx = gallery.length - 1;
            show();
          };
          reader.readAsDataURL(f);
        }
      };
      input.click();
    });

    win.querySelector("[data-view-prev]")?.addEventListener("click", () => {
      if (gallery.length) {
        idx = (idx - 1 + gallery.length) % gallery.length;
        show();
      }
    });
    win.querySelector("[data-view-next]")?.addEventListener("click", () => {
      if (gallery.length) {
        idx = (idx + 1) % gallery.length;
        show();
      }
    });
    win.querySelectorAll("[data-view-zoom]").forEach((b) =>
      b.addEventListener("click", () => {
        zoom = Math.max(0.3, Math.min(5, zoom + (b.getAttribute("data-view-zoom") === "in" ? 0.2 : -0.2)));
        apply();
      }),
    );
    win.querySelector("[data-view-rotate]")?.addEventListener("click", () => {
      deg = (deg + 90) % 360;
      apply();
    });
    win.querySelector("[data-view-full]")?.addEventListener("click", () => {
      stage?.requestFullscreen?.().catch(() => undefined);
    });
  },
};