/**
 * Phase 3 · 本地 E2E 维护脚本：清空本地 D1 的限流桶。
 *
 * 为什么需要：限流桶按 IP 哈希计数（`worker/api/ratelimit.js`），本地 E2E 全部来自
 * 127.0.0.1，同一个 1 小时窗口里反复跑测试会把 `plugin-upload`（20/h）、
 * `pairing-claim`（10/10min）等桶跑满，测试就会收到 429 而不是被测行为的响应。
 *
 * ⚠️ 注意：`rateLimit()` 里还有一层 **进程内内存计数**（`memoryHit(bucket, now)`），
 * 它在 Worker isolate 存活期间一直有效。所以本脚本清 D1 之后，**已在运行的 Worker
 * 仍会把旧计数当成超标**。要真正回到干净状态，必须重启 `scripts/e2e-server.mjs`
 * （重启会同时清空内存计数，且启动时会再跑一次 `resetFixtureRows()`）。
 *
 * 这只是**本地测试数据库**的维护操作：
 *   - 只跑 `wrangler d1 execute guandao-db --local`；
 *   - 不接触生产 D1，不改任何限流规则；
 *   - 生产限流逻辑完全不变，本脚本对生产无任何入口。
 *
 * 用法：node scripts/e2e-reset-limits.mjs   （之后重启 e2e-server 才能完全生效）
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const TMP_DIR = join(ROOT, ".wrangler", "tmpdir");
fs.mkdirSync(TMP_DIR, { recursive: true });

const env = { ...process.env, TEMP: TMP_DIR, TMP: TMP_DIR, WRANGLER_SEND_METRICS: "false", CI: "true" };

try {
  execFileSync(
    process.execPath,
    [
      join(ROOT, "node_modules", "wrangler", "bin", "wrangler.js"),
      "d1",
      "execute",
      "guandao-db",
      "--local",
      "--command",
      "DELETE FROM rate_limits;",
    ],
    { stdio: "ignore", env },
  );
  console.log("[e2e-reset-limits] 已清空本地 D1 限流桶（rate_limits）");
} catch (error) {
  console.error(`[e2e-reset-limits] 失败：${error?.message ?? error}`);
  process.exit(1);
}