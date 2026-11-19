/**
 * 插件体系共用样式（plugins.css）的统一入口。
 *
 * 为什么单独一个模块：插件管理器、插件市场、开发者中心三个应用都渲染
 * `gp-*` 结构，样式只在 manager.js 里加载会导致另外两个应用完全没有样式
 * （开发者中心就是一排纯白按钮）。放在这里，谁先打开都能把样式带上，
 * ensureCss 按 URL 去重，不会重复插入 <link>。
 */

import cssUrl from "../../styles/plugins.css?url";
import { ensureCss } from "../ui/lazy-css";

/** 应用模块导出 stylesReady，`lazy()` 会等它完成后再渲染，避免无样式闪烁 */
export const stylesReady = ensureCss(cssUrl);
