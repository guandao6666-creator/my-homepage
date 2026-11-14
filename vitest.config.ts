/**
 * Guandao OS 2.0 · 单元测试配置
 *
 * 只跑不依赖浏览器 DOM 的纯逻辑（内核、权限、Manifest、迁移、布局几何、
 * 网络分类、脱敏、指标评分、资源域、离线队列…），
 * 浏览器行为交给 Playwright（tests/e2e）。
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts"],
    environment: "node",
    reporters: ["default"],
    coverage: {
      provider: "v8",
      reportsDirectory: "coverage",
      include: ["src/lib/core/**/*.ts", "src/lib/quality/**/*.ts", "src/lib/mobile/data.ts", "src/lib/version.ts"],
    },
  },
});