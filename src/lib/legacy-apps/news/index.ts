/**
 * 大肥鱼新闻联播（news）· 对应 index.astro 原 `renderNews` / `initNews`。
 *
 * 依赖：`data.posts`、`escapeHtml`。没有计时器 / 全局监听，不需要 lifecycle。
 */
import type { LegacyAppModule } from "../types";

export const newsApp: LegacyAppModule = {
  id: "news",
  title: "新闻联播",
  width: 500,
  height: 560,
  glyph: "di-tv",
  body: () => `
          <div class="news">
            <div class="news-head">
              <img class="news-avatar" src="/pet/whale-girl.webp" alt="" />
              <div class="news-title-block">
                <p class="news-name">大肥鱼新闻联播</p>
                <p class="news-date" id="news-date"></p>
              </div>
            </div>
            <div class="news-list" id="news-list"></div>
            <p class="news-foot">本台记者 大肥鱼 · 发自桌面右下角</p>
          </div>`,
  init: (win, { data, escapeHtml }) => {
    const list = win.querySelector("#news-list");
    const dateEl = win.querySelector("#news-date");
    if (!list || !dateEl) return;

    const now = new Date();
    // 用日期当种子，同一天打开内容一致，隔天才会换
    const seed = now.getFullYear() * 10000 + (now.getMonth() + 1) * 100 + now.getDate();
    const pick = (arr: string[], salt: number) => arr[(seed + salt) % arr.length];

    dateEl.textContent = now.toLocaleDateString("zh-CN", {
      year: "numeric",
      month: "long",
      day: "numeric",
      weekday: "long",
    });

    const posts = ((data.posts ?? []) as Array<{ title: string; date: string }>).slice();
    posts.sort((a, b) => b.date.localeCompare(a.date));

    const items: Array<{ tag: string; text: string }> = [];

    // 头条：更新情况
    if (!posts.length) {
      items.push({ tag: "头条", text: "本站目前还没有文章，编辑部正在等待第一份稿件。" });
    } else {
      const last = posts[0];
      const gap = Math.floor((Date.now() - new Date(last.date).getTime()) / 86400000);

      if (gap <= 0) {
        items.push({ tag: "头条", text: `博主今日发布了《${last.title}》，编辑室全体起立鼓掌。` });
      } else if (gap <= 2) {
        items.push({ tag: "头条", text: `距离上一篇更新已 ${gap} 天，博主表示「在写了在写了」。` });
      } else if (gap <= 9) {
        items.push({ tag: "头条", text: `今日博主依然没有更新文章，距离上一篇已经 ${gap} 天。` });
      } else {
        items.push({ tag: "头条", text: `博主已连续 ${gap} 天没有更新，本台记者多次联系未果。` });
      }
    }

    // 数据
    items.push({
      tag: "数据",
      text: posts.length
        ? `本站累计 ${posts.length} 篇文章，最近一篇是《${posts[0].title}》。`
        : `本站累计 ${posts.length} 篇文章。`,
    });

    // 互动
    items.push({
      tag: "互动",
      text: pick(
        [
          "树洞持续营业中，欢迎匿名说点什么。",
          "议会正在为下一篇文章的选题投票，目前还没有定论。",
          "访客墙在等第一个愿意露脸的人。",
          "排行榜上还没人，先去逛两圈就能上榜。",
        ],
        3,
      ),
    });

    // 花絮
    items.push({
      tag: "花絮",
      text: pick(
        [
          "大肥鱼今天心情不错，在桌面右下角坐了一整天。",
          "大肥鱼表示：摸可以，别戳太用力。",
          "大肥鱼今日无排班，但在岗。",
          "据大肥鱼本人透露，她更喜欢白天，因为晚上看不清键盘。",
          "大肥鱼今天试图打开音乐播放器，未果。",
          "大肥鱼对本次更新表示满意，并要了一条小鱼干。",
        ],
        11,
      ),
    });

    list.innerHTML = items
      .map(
        (n, i) => `
                <article class="news-item" style="animation-delay:${i * 90}ms">
                  <span class="news-tag">${n.tag}</span>
                  <p class="news-text">${escapeHtml(n.text)}</p>
                </article>`,
      )
      .join("");
  },
};
