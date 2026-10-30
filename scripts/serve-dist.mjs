#!/usr/bin/env node
/**
 * 极简静态服务器：把 dist/ 跑起来做本地预览。
 * 用法：node scripts/serve-dist.mjs [port]
 */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(process.cwd(), "dist");
const port = Number(process.argv[2] || 4321);

const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".json": "application/json; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
};

async function resolveFile(urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  let target = path.join(root, decoded);
  if (!target.startsWith(root)) return null;
  try {
    const info = await stat(target);
    if (info.isDirectory()) target = path.join(target, "index.html");
  } catch {
    if (!path.extname(target)) target = `${target}.html`;
  }
  try {
    await stat(target);
    return target;
  } catch {
    return null;
  }
}

createServer(async (req, res) => {
  const file = await resolveFile(req.url || "/");
  if (!file) {
    const notFound = path.join(root, "404.html");
    try {
      const body = await readFile(notFound);
      res.writeHead(404, { "Content-Type": types[".html"] });
      res.end(body);
    } catch {
      res.writeHead(404).end("Not found");
    }
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(500).end("Server error");
  }
}).listen(port, () => {
  console.log(`[serve-dist] http://localhost:${port}  →  ${root}`);
});
