/**
 * Guandao OS 2.2 · E2E 配置
 *
 * 两个被服务对象：
 *   1. `scripts/serve-dist.mjs`：`npm run build` 产出的 dist/ 静态产物（原有 UI 测试）。
 *   2. `scripts/e2e-server.mjs`：真实 Worker（wrangler dev --local）+ 本地 D1/R2 +
 *      QA 夹具（插件签名、设备配对、OAuth 回调）。Phase 3 新增，因为「CSP 响应头、
 *      插件验签、配对、OAuth」这些只能在真 Worker 上验证，静态 dist 上永远测不到。
 *
 * 项目划分：
 *   - `chromium`      ：纯 UI/静态产物测试（既有全部 spec）。
 *   - `worker`        ：需要真实 Worker 的 API 级测试（plugin-signature / sandbox / device / oauth）。
 *   - `firefox-worker`：同一批设备配对/接力用例的第二浏览器引擎（Chrome + Firefox 双引擎证据）。
 *   - `webkit-worker` ：Safari 家族引擎（Playwright WebKit）下的设备用例；WebKit ≠ 真机 Safari/iOS。
 *
 * 用法：
 *   npx playwright test                           # 三个 project 全跑
 *   npx playwright test --project=worker          # 只跑 Worker 集成测试
 *   npx playwright test --project=firefox-worker  # 只跑 Firefox 引擎的设备用例
 */
import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT || 4399);
const API_PORT = Number(process.env.E2E_API_PORT || 8788);

/** 需要真实 Worker 的 spec —— 只有这些进 `worker` project。 */
const WORKER_SPEC =
  /(plugin-signature|plugin-publishing|sandbox-worker|sandbox-origin|device|oauth|sync|community-tutorial)\.spec\.ts$/;

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 60_000,
  expect: { timeout: 12_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["json", { outputFile: "test-results/e2e-results.json" }]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: [
    {
      command: `node scripts/serve-dist.mjs ${PORT}`,
      url: `http://127.0.0.1:${PORT}`,
      reuseExistingServer: true,
      timeout: 30_000,
    },
    {
      // 首次启动要跑迁移 + wrangler 冷启动 + 生成签名夹具，给足时间。
      // 就绪探针指向 e2e-server 的本地夹具管理端口：该端口只在迁移 + 种子 +
      // 全部签名夹具生成完毕后监听，所以「能连上」= 夹具已就绪。不要改回
      // `${API_PORT}/api/health`——Worker 在 buildFixtures() 完成前就已健康，
      // 测试会与夹具的 wrangler d1 execute 写入抢同一本地 D1（曾导致 ECONNRESET）。
      command: "node scripts/e2e-server.mjs",
      url: `http://127.0.0.1:${API_PORT + 1}/__e2e/ready`,
      reuseExistingServer: true,
      timeout: 240_000,
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
  projects: [
    {
      name: "chromium",
      testIgnore: WORKER_SPEC,
      use: { baseURL: `http://127.0.0.1:${PORT}`, channel: "chrome" },
    },
    {
      name: "worker",
      testMatch: WORKER_SPEC,
      use: { baseURL: `http://127.0.0.1:${API_PORT}`, channel: "chrome" },
    },
    {
      // 第二浏览器引擎：设备配对/接力/剪贴板用例在 Firefox 上再跑一遍。
      // 不设置 channel —— channel 只适用于 Chromium 系浏览器。
      name: "firefox-worker",
      testMatch: /device\.spec\.ts$/,
      use: { ...devices["Desktop Firefox"], baseURL: `http://127.0.0.1:${API_PORT}` },
    },
    {
      // Safari 家族引擎：Playwright 的 WebKit 构建（Windows 可用），再跑一遍设备用例。
      // 这是引擎级证据，不等同于真机 Safari / iOS 验证。
      name: "webkit-worker",
      testMatch: /device\.spec\.ts$/,
      use: { ...devices["Desktop Safari"], baseURL: `http://127.0.0.1:${API_PORT}` },
    },
  ],
});