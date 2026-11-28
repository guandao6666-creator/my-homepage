/**
 * Guandao OS 2.3 · Canvas Pad（灵感画板）
 *
 * 按需懒加载内置应用：
 *   - HTML5 Canvas 高分屏（DPR 自适应）丝滑手绘与指针压感平滑连线
 *   - 8 色调色板 + 自定义取色器 + 4 档笔触粗细 + 橡皮擦模式
 *   - 可选点阵 / 浅灰纸张 / 深色黑板底色
 *   - 最多 15 步撤销（Undo）与重做（Redo）历史栈
 *   - 一键导出透明或带底色的 PNG 图片到本机
 */
import type { Ctx } from "../os14/core";

const PALETTE = ["#f8fafc", "#6f8cff", "#22c3e6", "#4fbf9a", "#facc15", "#fb923c", "#f472b6", "#ef4444"];
const SIZES = [2, 5, 10, 18];

export const renderCanvasPad = () => `
  <div class="os23-sketch" style="display:grid;grid-template-rows:auto 1fr auto;gap:10px;height:100%;padding:14px 16px;box-sizing:border-box;color:inherit;user-select:none">
    <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap">
      <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap" data-sk-colors>
        ${PALETTE.map((c, i) => `<button type="button" data-sk-color="${c}" aria-label="颜色 ${c}" style="width:22px;height:22px;border-radius:50%;border:2px solid ${i === 1 ? "#fff" : "rgba(255,255,255,0.22)"};background:${c};cursor:pointer;padding:0"></button>`).join("")}
        <input type="color" data-sk-picker value="#6f8cff" title="自定义颜色" style="width:24px;height:24px;border:0;padding:0;background:transparent;cursor:pointer" />
      </div>
      <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
        ${SIZES.map((s, i) => `<button type="button" class="g14-btn ${i === 1 ? "is-primary" : "is-ghost"}" data-sk-size="${s}" style="min-height:28px;padding:0 9px">${s}px</button>`).join("")}
        <button type="button" class="g14-btn is-ghost" data-sk-eraser style="min-height:28px;padding:0 10px">橡皮擦</button>
      </div>
    </div>

    <div data-sk-stage style="position:relative;min-height:220px;border-radius:12px;border:1px solid rgba(255,255,255,0.12);background:#121624;overflow:hidden;touch-action:none">
      <canvas data-sk-canvas style="display:block;width:100%;height:100%;cursor:crosshair"></canvas>
    </div>

    <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap">
      <div style="display:flex;gap:6px">
        <button type="button" class="g14-btn is-ghost" data-sk-undo disabled>撤销</button>
        <button type="button" class="g14-btn is-ghost" data-sk-redo disabled>重做</button>
        <button type="button" class="g14-btn is-ghost" data-sk-bg>底色：深色</button>
        <button type="button" class="g14-btn is-ghost" data-sk-clear>清空</button>
      </div>
      <button type="button" class="g14-btn is-primary" data-sk-export>导出 PNG</button>
    </div>
  </div>`;

export const initCanvasPad = (win: HTMLElement, ctx: Ctx): (() => void) => {
  const stage = win.querySelector<HTMLElement>("[data-sk-stage]");
  const canvas = win.querySelector<HTMLCanvasElement>("[data-sk-canvas]");
  const picker = win.querySelector<HTMLInputElement>("[data-sk-picker]");
  const eraserBtn = win.querySelector<HTMLButtonElement>("[data-sk-eraser]");
  const undoBtn = win.querySelector<HTMLButtonElement>("[data-sk-undo]");
  const redoBtn = win.querySelector<HTMLButtonElement>("[data-sk-redo]");
  const bgBtn = win.querySelector<HTMLButtonElement>("[data-sk-bg]");
  const clearBtn = win.querySelector<HTMLButtonElement>("[data-sk-clear]");
  const exportBtn = win.querySelector<HTMLButtonElement>("[data-sk-export]");
  const colorBtns = Array.from(win.querySelectorAll<HTMLButtonElement>("[data-sk-color]"));
  const sizeBtns = Array.from(win.querySelectorAll<HTMLButtonElement>("[data-sk-size]"));

  if (!stage || !canvas) return () => undefined;
  const g = canvas.getContext("2d");
  if (!g) return () => undefined;

  let strokeColor = "#6f8cff";
  let strokeSize = 5;
  let erasing = false;
  let darkBg = true;
  let drawing = false;
  let lastX = 0;
  let lastY = 0;
  let dpr = Math.min(window.devicePixelRatio || 1, 2);

  const history: ImageData[] = [];
  let histIdx = -1;

  const updateHistoryBtns = () => {
    if (undoBtn) undoBtn.disabled = histIdx <= 0;
    if (redoBtn) redoBtn.disabled = histIdx < 0 || histIdx >= history.length - 1;
  };

  const snapshot = () => {
    if (canvas.width === 0 || canvas.height === 0) return;
    const img = g.getImageData(0, 0, canvas.width, canvas.height);
    history.splice(histIdx + 1);
    history.push(img);
    if (history.length > 16) history.shift();
    histIdx = history.length - 1;
    updateHistoryBtns();
  };

  const resize = () => {
    const rect = stage.getBoundingClientRect();
    const w = Math.max(240, Math.floor(rect.width));
    const h = Math.max(180, Math.floor(rect.height));
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (canvas.width === w * dpr && canvas.height === h * dpr) return;
    const prev = canvas.width > 0 && canvas.height > 0 ? g.getImageData(0, 0, canvas.width, canvas.height) : null;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (prev) {
      g.putImageData(prev, 0, 0);
    } else {
      snapshot();
    }
  };

  const posOf = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  canvas.addEventListener("pointerdown", (e) => {
    resize();
    drawing = true;
    canvas.setPointerCapture(e.pointerId);
    const p = posOf(e);
    lastX = p.x;
    lastY = p.y;
    g.save();
    g.globalCompositeOperation = erasing ? "destination-out" : "source-over";
    g.fillStyle = strokeColor;
    g.beginPath();
    g.arc(p.x, p.y, (erasing ? strokeSize * 1.8 : strokeSize) / 2, 0, Math.PI * 2);
    g.fill();
    g.restore();
  });

  canvas.addEventListener("pointermove", (e) => {
    if (!drawing) return;
    const p = posOf(e);
    g.save();
    g.globalCompositeOperation = erasing ? "destination-out" : "source-over";
    g.strokeStyle = strokeColor;
    g.lineWidth = erasing ? strokeSize * 1.8 : strokeSize;
    g.lineCap = "round";
    g.lineJoin = "round";
    g.beginPath();
    g.moveTo(lastX, lastY);
    g.lineTo(p.x, p.y);
    g.stroke();
    g.restore();
    lastX = p.x;
    lastY = p.y;
  });

  const endStroke = () => {
    if (!drawing) return;
    drawing = false;
    snapshot();
  };
  canvas.addEventListener("pointerup", endStroke);
  canvas.addEventListener("pointercancel", endStroke);

  const selectColor = (c: string) => {
    strokeColor = c;
    erasing = false;
    eraserBtn?.classList.remove("is-primary");
    eraserBtn?.classList.add("is-ghost");
    colorBtns.forEach((b) => {
      b.style.borderColor = b.dataset.skColor === c ? "#fff" : "rgba(255,255,255,0.22)";
    });
  };

  colorBtns.forEach((b) => b.addEventListener("click", () => selectColor(b.dataset.skColor ?? "#6f8cff")));
  picker?.addEventListener("input", () => selectColor(picker.value));

  sizeBtns.forEach((b) =>
    b.addEventListener("click", () => {
      strokeSize = Number(b.dataset.skSize) || 5;
      sizeBtns.forEach((item) => {
        const on = item === b;
        item.classList.toggle("is-primary", on);
        item.classList.toggle("is-ghost", !on);
      });
    }),
  );

  eraserBtn?.addEventListener("click", () => {
    erasing = !erasing;
    eraserBtn.classList.toggle("is-primary", erasing);
    eraserBtn.classList.toggle("is-ghost", !erasing);
  });

  undoBtn?.addEventListener("click", () => {
    if (histIdx <= 0) return;
    histIdx--;
    g.putImageData(history[histIdx], 0, 0);
    updateHistoryBtns();
  });

  redoBtn?.addEventListener("click", () => {
    if (histIdx >= history.length - 1) return;
    histIdx++;
    g.putImageData(history[histIdx], 0, 0);
    updateHistoryBtns();
  });

  bgBtn?.addEventListener("click", () => {
    darkBg = !darkBg;
    stage.style.background = darkBg ? "#121624" : "#f8fafc";
    bgBtn.textContent = darkBg ? "底色：深色" : "底色：浅纸";
  });

  clearBtn?.addEventListener("click", () => {
    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, canvas.width, canvas.height);
    g.restore();
    snapshot();
  });

  exportBtn?.addEventListener("click", () => {
    const out = document.createElement("canvas");
    out.width = canvas.width;
    out.height = canvas.height;
    const og = out.getContext("2d");
    if (!og) return;
    og.fillStyle = darkBg ? "#121624" : "#f8fafc";
    og.fillRect(0, 0, out.width, out.height);
    og.drawImage(canvas, 0, 0);
    const a = document.createElement("a");
    a.href = out.toDataURL("image/png");
    a.download = `guandao-sketch-${new Date().toISOString().slice(0, 10)}.png`;
    a.click();
    ctx.toast("已导出 PNG 画作");
  });

  const ro = new ResizeObserver(() => resize());
  ro.observe(stage);
  window.setTimeout(resize, 30);

  return () => ro.disconnect();
};
