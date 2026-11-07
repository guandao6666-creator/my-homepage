#!/usr/bin/env node
/**
 * Phase 2.1 CSS 拆分视觉对比。
 *
 * 用法：
 *   node scripts/compare-css-shots.mjs .shots/phase-2.1-before .shots/phase-2.1-after
 *
 * 规则：
 * - 逐像素比较（通道差 > 2 视为不同），同时比较 layout.json 的 boundingBox；
 * - 顶部状态栏未读红点属于异步通知状态，允许在白名单状态中作为动态差异记录；
 * - 其它任何像素差异或布局差异都会以非 0 退出。
 */

import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

const beforeDir = path.resolve(process.argv[2] || ".shots/phase-2.1-before");
const afterDir = path.resolve(process.argv[3] || ".shots/phase-2.1-after");
const DYNAMIC = new Set(["768x1024-window.png"]);

const names = fs
  .readdirSync(beforeDir)
  .filter((name) => name.endsWith(".png"))
  .sort();

const details = [];
let exact = 0;
let dynamic = 0;
const failed = [];

for (const name of names) {
  const afterPath = path.join(afterDir, name);
  if (!fs.existsSync(afterPath)) {
    failed.push({ name, reason: "missing" });
    continue;
  }
  const a = await sharp(path.join(beforeDir, name)).raw().toBuffer({ resolveWithObject: true });
  const b = await sharp(afterPath).raw().toBuffer({ resolveWithObject: true });
  if (a.info.width !== b.info.width || a.info.height !== b.info.height) {
    failed.push({ name, reason: "size", before: [a.info.width, a.info.height], after: [b.info.width, b.info.height] });
    continue;
  }
  let diff = 0;
  let max = 0;
  let minX = a.info.width;
  let minY = a.info.height;
  let maxX = -1;
  let maxY = -1;
  for (let i = 0; i < a.data.length; i += 4) {
    let d = 0;
    for (let c = 0; c < 3; c += 1) d = Math.max(d, Math.abs(a.data[i + c] - b.data[i + c]));
    if (d > 2) {
      diff += 1;
      if (d > max) max = d;
      const pixel = i / 4;
      const x = pixel % a.info.width;
      const y = Math.floor(pixel / a.info.width);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  const row = {
    name,
    pixels: a.info.width * a.info.height,
    diff,
    ratio: diff / (a.info.width * a.info.height),
    max,
    bbox: diff ? [minX, minY, maxX, maxY] : null,
  };
  if (!diff) exact += 1;
  else if (DYNAMIC.has(name) && maxY <= 22) {
    dynamic += 1;
    row.dynamic = "顶部通知未读红点（异步状态，不是 CSS 差异）";
  } else {
    failed.push(row);
  }
  details.push(row);
}

/* layout.json */
let layoutChecked = 0;
const layoutMismatch = [];
try {
  const before = JSON.parse(fs.readFileSync(path.join(beforeDir, "layout.json"), "utf8"));
  const after = JSON.parse(fs.readFileSync(path.join(afterDir, "layout.json"), "utf8"));
  for (const [state, boxes] of Object.entries(before)) {
    if (!after[state]) {
      layoutMismatch.push({ state, reason: "missing-state" });
      continue;
    }
    for (const [key, box] of Object.entries(boxes)) {
      layoutChecked += 1;
      const other = after[state][key];
      if (!box || !other) {
        if (box !== other) layoutMismatch.push({ state, key, before: box, after: other });
        continue;
      }
      const delta = Math.max(...["x", "y", "width", "height"].map((k) => Math.abs(box[k] - other[k])));
      if (delta > 0.6) layoutMismatch.push({ state, key, before: box, after: other, delta });
    }
  }
} catch (error) {
  layoutMismatch.push({ reason: "layout.json", error: error.message });
}

const report = {
  generatedAt: new Date().toISOString(),
  states: names.length,
  exact,
  dynamic,
  failed,
  layoutChecked,
  layoutMismatch,
  details,
};
fs.writeFileSync(path.join(afterDir, "..", "phase-2.1-diff-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ states: report.states, exact, dynamic, failed: failed.length, layoutChecked, layoutMismatch: layoutMismatch.length }, null, 2));
process.exit(failed.length || layoutMismatch.length ? 1 : 0);