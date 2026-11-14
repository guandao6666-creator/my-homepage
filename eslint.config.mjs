/**
 * ESLint 扁平配置（Guandao OS 2.0 · Phase 1，保守接入）。
 *
 * 目标不是改历史风格，而是把「安全相关、新增代码」里明确错误级的规则跑起来：
 *   - 禁止 eval / new Function / javascript: URL；
 *   - 禁止未定义变量（Node / 浏览器 / Worker 全局显式声明）。
 *
 * 暂不启用 no-unused-vars、缩进、引号等风格规则，避免一次性改写历史代码。
 * 检查范围先覆盖 Worker、脚本与 CLI；Astro 模板由 `astro check` 负责。
 */

import globals from "globals";

export default [
  {
    ignores: ["dist/**", "node_modules/**", ".astro/**", ".wrangler/**", "test-results/**", "public/**"],
  },
  {
    files: ["worker/**/*.js", "scripts/**/*.mjs", "cli/**/*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.serviceworker,
        // Cloudflare Workers / D1 / R2 运行时
        crypto: "readonly",
        caches: "readonly",
        fetch: "readonly",
        Request: "readonly",
        Response: "readonly",
        Headers: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        TextEncoder: "readonly",
        TextDecoder: "readonly",
        FormData: "readonly",
        Blob: "readonly",
        File: "readonly",
        ReadableStream: "readonly",
        WritableStream: "readonly",
        TransformStream: "readonly",
        AbortController: "readonly",
        DOMException: "readonly",
        atob: "readonly",
        btoa: "readonly",
        structuredClone: "readonly",
        queueMicrotask: "readonly",
      },
    },
    rules: {
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
      "no-script-url": "error",
      "no-undef": "error",
    },
  },
];