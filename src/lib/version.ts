/**
 * Guandao OS · 单一版本来源（前端）
 *
 * 1.9 之前版本号散落在 6 个地方，社区清单甚至停在 1.6.0，
 * 导致声明 minimum 1.7/1.8 的社区内容在 1.8 系统上被判为「版本过低」而拒绝安装。
 *
 * 现在前端只从这里取版本号；worker 侧用 worker/api/version.js（JS 无法 import TS），
 * 两边由 scripts/check-version.mjs 在 CI 中强制一致。
 */

export const OS_VERSION = "2.0.0";

/** 对外展示的版本代号 */
export const RELEASE_NAME = "The Platform Era";

/** 中文版本名 */
export const RELEASE_NAME_ZH = "平台时代";

/** 数据导出格式版本（与备份 payload 中的 version 字段一致） */
export const EXPORT_FORMAT = "guandao-os/2.0";

/**
 * 构建信息。
 *
 * `__GUANDAO_BUILD_AT__` 与 `__GUANDAO_BUILD_ID__` 由 astro.config.mjs 的
 * vite.define 在构建时注入真实时间戳；本地开发或单测环境没有注入时
 * 显示「开发环境」，不会编造一个假的构建号。
 */
declare const __GUANDAO_BUILD_AT__: string | undefined;
declare const __GUANDAO_BUILD_ID__: string | undefined;

const injected = (read: () => unknown, fallback: string): string => {
  try {
    const value = read();
    return typeof value === "string" && value ? value : fallback;
  } catch {
    return fallback;
  }
};

export const BUILD_INFO = {
  build: `${OS_VERSION}+${injected(() => __GUANDAO_BUILD_ID__, "dev")}`,
  builtAt: injected(() => __GUANDAO_BUILD_AT__, "开发环境"),
  channel: "stable" as "stable" | "preview",
};

/** 2.0 的更新历史（真实发布记录，供更新中心展示；不抓取伪造数据） */
export const RELEASES: Array<{ version: string; name: string; date: string; notes: string[] }> = [
  {
    version: "2.0.0",
    name: "The Platform Era",
    date: "2026-11-05",
    notes: [
      "统一内核 Guandao Core：启动流程、生命周期、事件总线、错误隔离",
      "应用注册中心与统一 Manifest：应用状态不再靠 UI 伪装",
      "统一权限服务：默认拒绝、逐项授权、审计日志",
      "统一 Window Manager：贴靠 / 分屏 / 工作空间快照与跨设备重算",
      "系统设置（System Center）整合八类设置，改动真实生效",
      "首次启动七步引导：Local / Cloud 模式、个性化、设备、应用与工作空间",
      "更新中心：版本、构建信息、兼容性检查与数据保护检查",
      "应用与资源市场：应用 / 插件 / 主题 / 组件 / 壁纸 / 工作空间的统一入口",
      "1.x 数据迁移：先备份、再迁移、幂等可重试、旧键完全保留",
    ],
  },
  {
    version: "1.9.0",
    name: "Polish Before the Next Era",
    date: "2026-11-04",
    notes: ["按需加载应用", "错误边界与资源回收", "诊断中心与性能实验室", "质量门禁 CI"],
  },
  {
    version: "1.8.0",
    name: "Seamless Experience",
    date: "2026-11-04",
    notes: ["自适应外壳（桌面 / 平板 / 手机）", "PWA 与离线页", "接力与配对"],
  },
];