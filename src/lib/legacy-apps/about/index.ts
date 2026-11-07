/**
 * 关于（about）· 对应 index.astro 原 `renderAbout`。
 *
 * 静态文案 + `data.site.author`，无 init、无状态。
 */
import type { LegacyAppModule } from "../types";

export const aboutApp: LegacyAppModule = {
  id: "about",
  title: "关于",
  width: 460,
  height: 380,
  glyph: "di-person",
  body: ({ data }) => `
          <div class="about">
            <p class="about-kicker">关于这个站</p>
            <h2>${data.site.author}</h2>
            <p>
              大连理工大学智能制造专业在读。喜欢骑车、写代码，以及把学到的东西记下来。
            </p>
            <p>
              这个桌面是博客的另一种打开方式：文章、终端、设置都在窗口里。想要正常阅读，右下角的房子可以回到普通版。
            </p>
            <p>
              2.0「平台时代」把桌面收进了一套统一内核：应用有正式的 Manifest 与状态机，权限默认拒绝并留审计，
              系统设置、首次启动引导、更新中心与应用市场都在窗口里。所有数据仍然保存在你自己的浏览器里。
            </p>
            <div class="about-links">
              <a href="/about/">关于页 →</a>
              <a href="/blog/">全部文章 →</a>
              <a href="/uses/">我用什么 →</a>
            </div>
          </div>`,
};