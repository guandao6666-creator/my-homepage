#!/usr/bin/env node
/**
 * 本地 Phase 1.6 Workflow 测试用的 Mock D1 Export API。
 *
 * 仅监听 127.0.0.1；不读取任何 Secret；不连接 Cloudflare。
 * 真实 SQL 来自 `wrangler d1 export --local`，不是生产导出。
 */

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import process from "node:process";

const port = Number(process.env.MOCK_D1_PORT || 8799);
const sqlPath = process.env.MOCK_D1_SQL || "";
if (!sqlPath) {
  console.error("MOCK_D1_SQL is required");
  process.exit(1);
}
const sql = fs.readFileSync(path.resolve(sqlPath));

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);
  if (req.method === "POST" && url.pathname.endsWith("/export")) {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      let parsed = {};
      try { parsed = JSON.parse(body || "{}"); } catch { /* ignore */ }
      if (parsed.output_format !== "polling") {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ success: false, errors: [{ code: 1000, message: "output_format required" }] }));
        return;
      }
      if (!parsed.current_bookmark) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ success: true, result: { at_bookmark: "local-bookmark" } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        success: true,
        result: {
          signed_url: `http://127.0.0.1:${port}/download/local.sql`,
          filename: "local.sql",
        },
      }));
    });
    return;
  }
  if (req.method === "GET" && url.pathname === "/download/local.sql") {
    res.writeHead(200, { "content-type": "text/plain", "content-length": sql.byteLength });
    res.end(sql);
    return;
  }
  if (req.method === "POST" && url.pathname === "/webhook") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
    return;
  }
  res.writeHead(404);
  res.end("not found");
});

server.listen(port, "127.0.0.1", () => {
  console.log(`[mock-d1] listening on 127.0.0.1:${port}, sql=${sql.byteLength}B`);
});