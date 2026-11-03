#!/usr/bin/env node
/**
 * Guandao OS 1.4 回归入口
 * 用法：node scripts/os14-qa.mjs
 *
 * 先确认 dist/ 已构建（npm run build），再起一个静态服务器，
 * 依次跑三套测试：冒烟 / 深度 / 边界。
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const PORT = Number(process.env.OS14_PORT || 4399);
const BASE = `http://127.0.0.1:${PORT}/`;

if (!existsSync("dist/index.html")) {
  console.error("找不到 dist/index.html，请先运行 npm run build");
  process.exit(1);
}

const server = spawn(process.execPath, ["scripts/serve-dist.mjs", String(PORT)], {
  stdio: ["ignore", "ignore", "inherit"],
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const ready = async () => {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(BASE);
      if (res.ok) return true;
    } catch {
      /* 还没起来 */
    }
    await wait(250);
  }
  return false;
};

const run = (file) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [file], {
      stdio: "inherit",
      env: { ...process.env, OS14_BASE: BASE },
    });
    child.on("exit", (code) => resolve(code ?? 1));
  });

let failed = false;
try {
  if (!(await ready())) {
    console.error(`静态服务器没有在 ${BASE} 起来`);
    process.exit(1);
  }
  for (const file of ["scripts/os14-smoke.mjs", "scripts/os14-deep.mjs", "scripts/os14-edge.mjs"]) {
    console.log(`\n=== ${file} ===`);
    const code = await run(file);
    if (code !== 0) failed = true;
  }
} finally {
  server.kill();
}

console.log(failed ? "\n1.4 回归存在失败项" : "\n1.4 回归全部通过");
process.exit(failed ? 1 : 0);
