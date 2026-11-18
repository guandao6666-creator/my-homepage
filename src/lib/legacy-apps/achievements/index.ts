// 6.2：本应用样式随 chunk 按需下载
import cssUrl1 from "../../../styles/apps/legacy-achievements.css?url";
import { ensureCss } from "../../ui/lazy-css";

/** 6.2：样式走运行时加载，`load()` 会等它完成再渲染（Astro 会把直接 import 的 CSS 提升到首页） */
export const stylesReady = ensureCss(cssUrl1);

/**
 * 成就（achievements）· 对应 index.astro 原 `renderAchievements`。
 *
 * 纯展示应用：只在 body 阶段读取一次成就列表与解锁状态，
 * 由 `achievements` port 提供，不直接读 localStorage。
 */
import type { LegacyAppModule } from "../types";

export const achievementsApp: LegacyAppModule = {
  id: "achievements",
  title: "成就",
  width: 540,
  height: 476,
  glyph: "di-ach",
  body: ({ achievements }) => {
    const list = achievements.list();
    const state = achievements.state();

    const rows = list
      .map((ach) => {
        const got = Boolean(state.unlocked[ach.id]);
        return `
              <div class="ach ${got ? "is-got" : "is-locked"}">
                <span class="ach-mark">${got ? ach.mark : "?"}</span>
                <span class="ach-body">
                  <span class="ach-name">${got ? ach.name : "未解锁"}</span>
                  <span class="ach-desc">${got ? ach.desc : "继续逛逛看"}</span>
                </span>
              </div>`;
      })
      .join("");

    const count = list.filter((ach) => state.unlocked[ach.id]).length;

    return `
            <div class="ach-wrap">
              <p class="ach-head">已解锁 <b>${count}</b> / ${list.length}</p>
              <div class="ach-grid">${rows}</div>
            </div>`;
  },
};
