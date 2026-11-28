/**
 * Guandao OS 2.3 · Converter（换算工坊：单位换算 + 色彩对比度工具）
 *
 * 按需懒加载内置应用：
 *   - 长度 / 重量 / 温度 / 数据存储 4 大类常用单位双向精确换算
 *   - HEX ↔ RGB ↔ HSL 实时色彩互转 + WCAG 2.1 对比度检测（AA / AAA 判定）
 */
import type { Ctx } from "../os14/core";

export type UnitCategory = "length" | "mass" | "temp" | "data";

type UnitDef = { id: string; name: string; toBase: (v: number) => number; fromBase: (v: number) => number };

const linear = (id: string, name: string, factor: number): UnitDef => ({
  id,
  name,
  toBase: (v) => v * factor,
  fromBase: (v) => v / factor,
});

export const UNIT_GROUPS: Record<UnitCategory, { label: string; units: UnitDef[] }> = {
  length: {
    label: "长度",
    units: [
      linear("m", "米 (m)", 1),
      linear("km", "千米 (km)", 1000),
      linear("cm", "厘米 (cm)", 0.01),
      linear("mm", "毫米 (mm)", 0.001),
      linear("in", "英寸 (in)", 0.0254),
      linear("ft", "英尺 (ft)", 0.3048),
      linear("mi", "英里 (mi)", 1609.344),
    ],
  },
  mass: {
    label: "重量",
    units: [
      linear("kg", "千克 (kg)", 1),
      linear("g", "克 (g)", 0.001),
      linear("jin", "市斤", 0.5),
      linear("lb", "磅 (lb)", 0.45359237),
      linear("oz", "盎司 (oz)", 0.028349523125),
      linear("t", "吨 (t)", 1000),
    ],
  },
  temp: {
    label: "温度",
    units: [
      { id: "c", name: "摄氏度 (°C)", toBase: (v) => v, fromBase: (v) => v },
      { id: "f", name: "华氏度 (°F)", toBase: (v) => ((v - 32) * 5) / 9, fromBase: (v) => (v * 9) / 5 + 32 },
      { id: "k", name: "开尔文 (K)", toBase: (v) => v - 273.15, fromBase: (v) => v + 273.15 },
    ],
  },
  data: {
    label: "存储容量",
    units: [
      linear("b", "字节 (B)", 1),
      linear("kb", "KB (1024 B)", 1024),
      linear("mb", "MB", 1024 ** 2),
      linear("gb", "GB", 1024 ** 3),
      linear("tb", "TB", 1024 ** 4),
    ],
  },
};

export const convertUnit = (cat: UnitCategory, value: number, fromId: string, toId: string): number | null => {
  if (!Number.isFinite(value)) return null;
  const group = UNIT_GROUPS[cat];
  const from = group?.units.find((u) => u.id === fromId);
  const to = group?.units.find((u) => u.id === toId);
  if (!from || !to) return null;
  const raw = to.fromBase(from.toBase(value));
  return Number.isFinite(raw) ? Number(raw.toPrecision(10)) : null;
};

export const hexToRgb = (hex: string): { r: number; g: number; b: number } | null => {
  const clean = hex.trim().replace(/^#/, "");
  const full =
    clean.length === 3
      ? clean
          .split("")
          .map((c) => c + c)
          .join("")
      : clean;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
  const n = Number.parseInt(full, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
};

export const rgbToHsl = (r: number, g: number, b: number): { h: number; s: number; l: number } => {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case rn:
        h = (gn - bn) / d + (gn < bn ? 6 : 0);
        break;
      case gn:
        h = (bn - rn) / d + 2;
        break;
      default:
        h = (rn - gn) / d + 4;
        break;
    }
    h /= 6;
  }
  return { h: Math.round(h * 360), s: Math.round(s * 100), l: Math.round(l * 100) };
};

const relLum = ({ r, g, b }: { r: number; g: number; b: number }) => {
  const ch = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
};

/** 计算两个 HEX 颜色的 WCAG 2.1 对比度（1 ~ 21） */
export const contrastRatio = (hexA: string, hexB: string): number | null => {
  const a = hexToRgb(hexA);
  const b = hexToRgb(hexB);
  if (!a || !b) return null;
  const l1 = relLum(a);
  const l2 = relLum(b);
  const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  return Math.round(ratio * 100) / 100;
};

const INPUT =
  "padding:8px 10px;border-radius:9px;border:1px solid rgba(255,255,255,0.14);background:rgba(255,255,255,0.05);color:inherit;font:inherit;font-size:13px;outline:none";
const BOX = "border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.04);border-radius:11px";

export const renderConverter = () => `
  <div class="os23-conv" style="display:grid;grid-template-rows:auto 1fr auto;gap:12px;height:100%;padding:16px 18px;box-sizing:border-box;color:inherit">
    <div style="display:flex;gap:6px;flex-wrap:wrap">
      <button type="button" class="g14-btn is-primary" data-cv-mode="unit">单位换算</button>
      <button type="button" class="g14-btn is-ghost" data-cv-mode="color">色彩 & 对比度</button>
    </div>

    <div style="min-height:0;overflow:auto">
      <section data-cv-panel="unit" style="display:grid;gap:10px">
        <div style="display:flex;gap:6px;flex-wrap:wrap" data-cv-cats>
          ${(Object.keys(UNIT_GROUPS) as UnitCategory[])
            .map((k, i) => `<button type="button" class="g14-btn ${i === 0 ? "is-primary" : "is-ghost"}" data-cv-cat="${k}">${UNIT_GROUPS[k].label}</button>`)
            .join("")}
        </div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <input type="number" step="any" data-cv-val value="1" aria-label="输入数值" style="${INPUT};width:130px;font-family:var(--font-mono,monospace)" />
          <select data-cv-from aria-label="源单位" style="${INPUT};flex:1"></select>
        </div>
        <div data-cv-results style="display:grid;gap:7px"></div>
      </section>

      <section data-cv-panel="color" hidden style="display:none;gap:12px">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
          <label style="display:grid;gap:6px;font-size:12px">
            <span>前景色（HEX）</span>
            <div style="display:flex;gap:6px;align-items:center">
              <input type="color" data-cv-fg-pick value="#eef1f7" style="width:32px;height:32px;border:0;background:transparent;padding:0;cursor:pointer" />
              <input type="text" data-cv-fg value="#eef1f7" maxlength="7" style="${INPUT};flex:1;font-family:var(--font-mono,monospace)" />
            </div>
          </label>
          <label style="display:grid;gap:6px;font-size:12px">
            <span>背景色（HEX）</span>
            <div style="display:flex;gap:6px;align-items:center">
              <input type="color" data-cv-bg-pick value="#161a26" style="width:32px;height:32px;border:0;background:transparent;padding:0;cursor:pointer" />
              <input type="text" data-cv-bg value="#161a26" maxlength="7" style="${INPUT};flex:1;font-family:var(--font-mono,monospace)" />
            </div>
          </label>
        </div>

        <div data-cv-preview style="border-radius:12px;padding:16px;border:1px solid rgba(255,255,255,0.14);text-align:center">
          <div style="font-size:17px;font-weight:700">Guandao OS 2.3 · 视觉可读性预览</div>
          <div style="font-size:12.5px;margin-top:4px;opacity:0.88">The quick brown fox jumps over the lazy dog.</div>
        </div>

        <div data-cv-color-info style="display:grid;gap:7px"></div>
      </section>
    </div>

    <div style="display:flex;justify-content:space-between;font-size:12px;opacity:0.72;padding-top:8px;border-top:1px solid rgba(255,255,255,0.08)">
      <span>点击任意换算行可复制数值</span>
      <span>Guandao OS 2.3 · Converter</span>
    </div>
  </div>`;

export const initConverter = (win: HTMLElement, ctx: Ctx): (() => void) => {
  const q = <T extends Element>(sel: string) => win.querySelector<T>(sel);
  const modeBtns = Array.from(win.querySelectorAll<HTMLButtonElement>("[data-cv-mode]"));
  const panels = Array.from(win.querySelectorAll<HTMLElement>("[data-cv-panel]"));
  const catBtns = Array.from(win.querySelectorAll<HTMLButtonElement>("[data-cv-cat]"));
  const valInput = q<HTMLInputElement>("[data-cv-val]");
  const fromSel = q<HTMLSelectElement>("[data-cv-from]");
  const resultsEl = q<HTMLElement>("[data-cv-results]");

  let cat: UnitCategory = "length";

  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text).then(() => ctx.toast(`已复制：${text}`));
  };

  const populateUnits = () => {
    if (!fromSel) return;
    fromSel.textContent = "";
    for (const u of UNIT_GROUPS[cat].units) {
      const opt = document.createElement("option");
      opt.value = u.id;
      opt.textContent = u.name;
      fromSel.appendChild(opt);
    }
    paintUnits();
  };

  const paintUnits = () => {
    if (!resultsEl || !fromSel) return;
    resultsEl.textContent = "";
    const v = Number(valInput?.value ?? "0");
    const fromId = fromSel.value;
    for (const u of UNIT_GROUPS[cat].units) {
      const out = convertUnit(cat, v, fromId, u.id);
      const text = out === null ? "—" : String(out);
      const row = document.createElement("button");
      row.type = "button";
      row.style.cssText = `${BOX};width:100%;padding:9px 13px;display:flex;justify-content:space-between;align-items:center;color:inherit;font:inherit;cursor:pointer;text-align:left`;
      const name = document.createElement("span");
      name.textContent = u.name;
      name.style.fontSize = "13px";
      const num = document.createElement("span");
      num.textContent = text;
      num.style.cssText = "font-family:var(--font-mono,monospace);font-size:14px;font-weight:650;color:var(--accent,#6f8cff)";
      row.append(name, num);
      row.addEventListener("click", () => copy(text));
      resultsEl.appendChild(row);
    }
  };

  modeBtns.forEach((b) =>
    b.addEventListener("click", () => {
      const m = b.dataset.cvMode ?? "unit";
      modeBtns.forEach((x) => {
        const on = x === b;
        x.classList.toggle("is-primary", on);
        x.classList.toggle("is-ghost", !on);
      });
      panels.forEach((p) => {
        const on = p.dataset.cvPanel === m;
        p.hidden = !on;
        p.style.display = on ? "grid" : "none";
      });
    }),
  );

  catBtns.forEach((b) =>
    b.addEventListener("click", () => {
      cat = (b.dataset.cvCat as UnitCategory) || "length";
      catBtns.forEach((x) => {
        const on = x === b;
        x.classList.toggle("is-primary", on);
        x.classList.toggle("is-ghost", !on);
      });
      populateUnits();
    }),
  );

  valInput?.addEventListener("input", paintUnits);
  fromSel?.addEventListener("change", paintUnits);

  // Color
  const fgIn = q<HTMLInputElement>("[data-cv-fg]");
  const bgIn = q<HTMLInputElement>("[data-cv-bg]");
  const fgPick = q<HTMLInputElement>("[data-cv-fg-pick]");
  const bgPick = q<HTMLInputElement>("[data-cv-bg-pick]");
  const preview = q<HTMLElement>("[data-cv-preview]");
  const colorInfo = q<HTMLElement>("[data-cv-color-info]");

  const paintColor = () => {
    const fgHex = fgIn?.value ?? "#eef1f7";
    const bgHex = bgIn?.value ?? "#161a26";
    const fgRgb = hexToRgb(fgHex);
    const bgRgb = hexToRgb(bgHex);
    if (fgRgb && preview) preview.style.color = fgHex;
    if (bgRgb && preview) preview.style.background = bgHex;
    if (!colorInfo) return;
    colorInfo.textContent = "";
    if (!fgRgb || !bgRgb) return;
    const hsl = rgbToHsl(fgRgb.r, fgRgb.g, fgRgb.b);
    const ratio = contrastRatio(fgHex, bgHex) ?? 1;
    const wcag = ratio >= 7 ? "AAA 极佳 (≥7:1)" : ratio >= 4.5 ? "AA 合格 (≥4.5:1)" : ratio >= 3 ? "大字号合格 (≥3:1)" : "对比度不足 (<3:1)";
    const rows: Array<[string, string]> = [
      ["前景色 RGB", `rgb(${fgRgb.r}, ${fgRgb.g}, ${fgRgb.b})`],
      ["前景色 HSL", `hsl(${hsl.h}, ${hsl.s}%, ${hsl.l}%)`],
      ["WCAG 对比度", `${ratio}:1 · ${wcag}`],
    ];
    for (const [k, v] of rows) {
      const row = document.createElement("div");
      row.style.cssText = `${BOX};padding:8px 12px;display:flex;justify-content:space-between;font-size:12.5px;cursor:pointer`;
      const l = document.createElement("span");
      l.textContent = k;
      l.style.opacity = "0.65";
      const r = document.createElement("code");
      r.textContent = v;
      r.style.fontFamily = "var(--font-mono,monospace)";
      row.append(l, r);
      row.addEventListener("click", () => copy(v));
      colorInfo.appendChild(row);
    }
  };

  fgIn?.addEventListener("input", () => {
    if (hexToRgb(fgIn.value) && fgPick) fgPick.value = fgIn.value;
    paintColor();
  });
  bgIn?.addEventListener("input", () => {
    if (hexToRgb(bgIn.value) && bgPick) bgPick.value = bgIn.value;
    paintColor();
  });
  fgPick?.addEventListener("input", () => {
    if (fgIn) fgIn.value = fgPick.value;
    paintColor();
  });
  bgPick?.addEventListener("input", () => {
    if (bgIn) bgIn.value = bgPick.value;
    paintColor();
  });

  populateUnits();
  paintColor();
  return () => undefined;
};
