/**
 * Guandao OS 1.3 壁纸资源管线
 *
 * 输入：.tmp-walls/*.png（图像模型产出的原始 1536x1024 图，右下角带生成水印）
 * 输出：
 *   public/wallpapers/<id>.webp        1600x1067，桌面全屏用
 *   public/wallpapers/thumbs/<id>.webp  480x320，壁纸库缩略图
 *   src/lib/wallpaper-assets.json      尺寸 / 主色 / 缩略图路径
 *
 * 水印位于右下角约 7% 区域，统一裁掉右侧与底部 7% 再放大到 3:2。
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";

const ROOT = process.cwd();
const SRC = path.join(ROOT, ".tmp-walls");
const OUT = path.join(ROOT, "public", "wallpapers");
const THUMB = path.join(OUT, "thumbs");

const MANIFEST = [
  ["A_breathtaking_photorealistic__2026-11-03T10-48-40.png", "ridge"],
  ["Photorealistic_wallpaper_of_a__2026-11-03T10-48-55.png", "snow"],
  ["Photorealistic_misty_coniferou_2026-11-03T10-49-05.png", "forest"],
  ["Aerial_photorealistic_coastlin_2026-11-03T10-49-21.png", "coast"],
  ["Photorealistic_sunset_over_a_c_2026-11-03T10-49-41.png", "sunset"],
  ["Photorealistic_astrophotograph_2026-11-03T10-49-51.png", "stars"],
  ["Photorealistic_aurora_borealis_2026-11-03T10-50-03.png", "aurora"],
  ["Photorealistic_serene_alpine_l_2026-11-03T10-50-16.png", "lake"],
  ["Photorealistic_modern_city_nig_2026-11-03T10-50-40.png", "city-night"],
  ["Photorealistic_narrow_Tokyo_ba_2026-11-03T10-50-56.png", "tokyo"],
  ["Futuristic_parametric_architec_2026-11-03T10-51-07.png", "future-arch"],
  ["Photorealistic_city_skyline_at_2026-11-03T10-51-24.png", "skyline"],
  ["Minimal_architectural_photogra_2026-11-03T10-51-41.png", "arch-min"],
  ["Abstract_fluid_gradient_wallpa_2026-11-03T10-51-57.png", "gradient"],
  ["3D_fluid_art_wallpaper__glossy_2026-11-03T10-52-13.png", "fluid"],
  ["Frosted_glass_abstract_wallpap_2026-11-03T10-52-27.png", "glass"],
  ["Minimal_geometric_abstract_wal_2026-11-03T10-52-45.png", "geo"],
  ["Digital_art_wallpaper__a_vast__2026-11-03T10-52-57.png", "digital"],
  ["Dark_technology_wallpaper__mat_2026-11-03T10-53-14.png", "tech"],
  ["Deep_space_nebula_wallpaper_in_2026-11-03T10-53-29.png", "space"],
  ["Underwater_deep_ocean_wallpape_2026-11-03T10-53-48.png", "ocean"],
  ["Chinese_ink_wash_landscape_wal_2026-11-03T10-54-07.png", "ink"],
  ["Futuristic_harbor_at_blue_hour_2026-11-03T10-54-24.png", "harbor"],
  ["Minimal_desert_dunes_wallpaper_2026-11-03T10-54-36.png", "dunes"],
];

const rgbToHsl = (r, g, b) => {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return [h, s, l];
};

const hslToRgb = (h, s, l) => {
  if (s === 0) return [l, l, l].map((v) => Math.round(v * 255));
  const hue2rgb = (p, q, t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hue2rgb(p, q, h + 1 / 3), hue2rgb(p, q, h), hue2rgb(p, q, h - 1 / 3)].map((v) =>
    Math.round(v * 255),
  );
};

const hex = ([r, g, b]) => `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;

/** 取主色：按色相分桶，挑「有存在感又不太脏」的那一桶 */
const accentFrom = async (buf) => {
  const { data, info } = await sharp(buf)
    .resize(48, 32, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const buckets = new Map();
  let totalL = 0;
  let n = 0;
  for (let i = 0; i < data.length; i += 3) {
    const [h, s, l] = rgbToHsl(data[i], data[i + 1], data[i + 2]);
    totalL += l;
    n += 1;
    if (s < 0.26 || l < 0.14 || l > 0.9) continue;
    const key = Math.round(h * 24) % 24;
    const b = buckets.get(key) ?? { w: 0, h: 0, s: 0, l: 0 };
    const weight = s * (1 - Math.abs(l - 0.55) * 1.2);
    b.w += weight;
    b.h += h * weight;
    b.s += s * weight;
    b.l += l * weight;
    buckets.set(key, b);
  }

  let best = null;
  for (const b of buckets.values()) if (!best || b.w > best.w) best = b;
  const avgL = totalL / Math.max(1, n);

  if (!best) {
    // 近乎黑白：给一个中性冷色，避免强调色变成灰色
    return { accent: "#7f9cff", accent2: "#c0a6ff", luminance: avgL };
  }

  const h = best.h / best.w;
  const s = Math.min(0.82, Math.max(0.42, best.s / best.w));
  const l = Math.min(0.68, Math.max(0.48, best.l / best.w));
  const accent = hex(hslToRgb(h, s, l));
  const accent2 = hex(hslToRgb((h + 0.08) % 1, s * 0.92, Math.min(0.74, l + 0.08)));
  return { accent, accent2, luminance: Number(avgL.toFixed(3)) };
};

await mkdir(THUMB, { recursive: true });

const out = {};
for (const [file, id] of MANIFEST) {
  const src = path.join(SRC, file);
  if (!existsSync(src)) {
    console.warn("missing", file);
    continue;
  }
  const input = await readFile(src);
  const meta = await sharp(input).metadata();
  const cropW = Math.round(meta.width * 0.93);
  const cropH = Math.round(meta.height * 0.93);

  const cropped = await sharp(input)
    .extract({ left: 0, top: 0, width: cropW, height: cropH })
    .toBuffer();

  const full = await sharp(cropped)
    .resize(1600, 1067, { fit: "cover", position: "centre" })
    .sharpen({ sigma: 0.6 })
    .webp({ quality: 82, effort: 5 })
    .toBuffer();

  const thumb = await sharp(cropped)
    .resize(480, 320, { fit: "cover", position: "centre" })
    .webp({ quality: 72, effort: 5 })
    .toBuffer();

  await writeFile(path.join(OUT, `${id}.webp`), full);
  await writeFile(path.join(THUMB, `${id}.webp`), thumb);

  const colors = await accentFrom(cropped);
  out[id] = { ...colors, bytes: full.length, w: 1600, h: 1067 };
  console.log(
    id.padEnd(12),
    `${(full.length / 1024).toFixed(0)}KB`,
    colors.accent,
    colors.accent2,
    `lum=${colors.luminance}`,
  );
}

await writeFile(path.join(ROOT, "src", "lib", "wallpaper-assets.json"), JSON.stringify(out, null, 2));
console.log(`\n${Object.keys(out).length} wallpapers → src/lib/wallpaper-assets.json`);
