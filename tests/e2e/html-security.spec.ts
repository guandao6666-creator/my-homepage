/**
 * Guandao OS 2.3 · DOM 层面的安全验证（真实浏览器）。
 *
 * 为什么放在 Playwright 而不是 vitest：
 * 项目没有 jsdom/happy-dom 依赖，而 Playwright 本来就是既有的浏览器测试环境。
 * 这里导入的是 **`src/lib/html.ts` 的真实实现**（不是复制一份），
 * 把它的输出插进真实 DOM，再由浏览器决定这是「文本」还是「节点」。
 */
import { expect, test, type Page } from "@playwright/test";
import { escapeAttr, escapeHtml, safeUrl } from "../../src/lib/html";

/** 在空白页里测，避免干扰桌面状态 */
async function freshPage(page: Page): Promise<void> {
  await page.goto("about:blank");
  await page.evaluate(() => {
    (window as unknown as { __alerted: boolean }).__alerted = false;
    window.alert = () => {
      (window as unknown as { __alerted: boolean }).__alerted = true;
    };
  });
}

async function insert(page: Page, markup: string) {
  return page.evaluate((html) => {
    const host = document.createElement("div");
    host.id = "probe";
    host.innerHTML = html;
    document.body.appendChild(host);
    return {
      scripts: host.querySelectorAll("script").length,
      imgs: host.querySelectorAll("img").length,
      svgs: host.querySelectorAll("svg").length,
      iframes: host.querySelectorAll("iframe").length,
      childElements: host.children.length,
      text: host.textContent ?? "",
      alerted: (window as unknown as { __alerted: boolean }).__alerted,
    };
  }, markup);
}

const PAYLOADS = [
  "<script>alert(1)</script>",
  "<img src=x onerror=alert(1)>",
  "<svg onload=alert(1)>",
  '<iframe src="javascript:alert(1)"></iframe>',
  "<details open ontoggle=alert(1)>",
];

test.describe("Phase 2.3 · DOM 安全", () => {
  test("对照组：未转义的载荷确实会生成节点（证明检测有效）", async ({ page }) => {
    await freshPage(page);
    const raw = await insert(page, "<img src=x onerror=alert(1)><script>alert(1)</script>");
    // 如果这里都不是 1，说明检测手段本身失效，后面的断言就没有意义
    expect(raw.imgs).toBe(1);
    expect(raw.scripts).toBe(1);
  });

  for (const payload of PAYLOADS) {
    test(`转义后不产生可执行节点：${payload.slice(0, 28)}`, async ({ page }) => {
      await freshPage(page);
      const result = await insert(page, `<div>${escapeHtml(payload)}</div>`);

      expect(result.scripts, "不应产生 script 节点").toBe(0);
      expect(result.imgs, "不应产生 img 节点").toBe(0);
      expect(result.svgs, "不应产生 svg 节点").toBe(0);
      expect(result.iframes, "不应产生 iframe 节点").toBe(0);
      expect(result.alerted, "不应执行 alert").toBe(false);

      // 载荷应当作为**文本**原样出现在页面上
      expect(result.text).toContain(payload);
    });
  }

  test("属性上下文：转义后的引号无法闭合属性", async ({ page }) => {
    await freshPage(page);
    const payload = 'x" onmouseover="alert(1)" data-pwned="1';
    const markup = `<div id="t" title="${escapeAttr(payload)}">hello</div>`;
    await page.evaluate((html) => {
      const host = document.createElement("div");
      host.innerHTML = html;
      document.body.appendChild(host);
    }, markup);

    const info = await page.evaluate(() => {
      const el = document.querySelector("#t") as HTMLElement;
      return {
        attrCount: el.attributes.length,
        title: el.getAttribute("title"),
        hasOnmouseover: el.hasAttribute("onmouseover"),
        hasPwned: el.hasAttribute("data-pwned"),
      };
    });

    expect(info.attrCount, "只应该有 id 和 title 两个属性").toBe(2);
    expect(info.hasOnmouseover).toBe(false);
    expect(info.hasPwned).toBe(false);
    expect(info.title).toBe(payload);
  });

  test("属性上下文：单引号包裹时同样无法闭合", async ({ page }) => {
    await freshPage(page);
    const payload = "x' onfocus='alert(1)' data-pwned='1";
    await page.evaluate((html) => {
      const host = document.createElement("div");
      host.innerHTML = html;
      document.body.appendChild(host);
    }, `<div id="t" title='${escapeAttr(payload)}'>x</div>`);

    const info = await page.evaluate(() => {
      const el = document.querySelector("#t") as HTMLElement;
      return { attrCount: el.attributes.length, hasOnfocus: el.hasAttribute("onfocus") };
    });
    expect(info.attrCount).toBe(2);
    expect(info.hasOnfocus).toBe(false);
  });

  test("URL 上下文：javascript: 被拦截后 href 为空", async ({ page }) => {
    await freshPage(page);
    // 在 Node 侧用真实模块算好，再传进页面（页面里没有这个模块）
    const badHref = safeUrl("javascript:alert(1)");
    const goodHref = safeUrl("https://guandao.xin/blog/");

    await page.evaluate(
      ([bad, good]) => {
        const host = document.createElement("div");
        host.innerHTML = `<a id="bad" href="${bad}">点我</a><a id="good" href="${good}">好链接</a>`;
        document.body.appendChild(host);
      },
      [badHref, goodHref],
    );

    const info = await page.evaluate(() => ({
      badHrefAttr: document.querySelector("#bad")?.getAttribute("href"),
      goodHrefAttr: document.querySelector("#good")?.getAttribute("href"),
    }));

    expect(info.badHrefAttr, "危险协议应被清空").toBe("");
    expect(info.goodHrefAttr).toBe("https://guandao.xin/blog/");
  });

  test("合法中文、Emoji 与普通文本照常显示", async ({ page }) => {
    await freshPage(page);
    const text = "管道的首页 · 骑车 🚴‍♀️ 100km · café";
    const result = await insert(page, `<p>${escapeHtml(text)}</p>`);
    expect(result.text).toBe(text);
    expect(result.childElements).toBe(1);
  });

  test("富文本不会被「转义一下就当作 HTML 执行」", async ({ page }) => {
    await freshPage(page);
    // 模拟：用户提交了带标签的富文本，调用方以为 escapeHtml 之后就能安全当 HTML 用
    const userRichText = '<b>加粗</b><script>alert(1)</script>';
    const result = await insert(page, `<div class="user-content">${escapeHtml(userRichText)}</div>`);
    expect(result.scripts).toBe(0);
    expect(result.alerted).toBe(false);
    // 标签以文本形式可见，而不是被渲染成加粗
    expect(result.text).toContain("<b>加粗</b>");
  });
});