/**
 * 设置页壁纸与「清空本机数据」的真实浏览器证据（2.0.6）。
 *
 * 覆盖两处只有真实 DOM / IndexedDB 才看得见的问题：
 *   1. 自定义壁纸的名字来自社区作品标题（别人可控）。2.0.5 前直接拼进
 *      `title="${name}"` / `<span>${name}</span>`，名字里带 `<img onerror>`
 *      就会在设置页执行脚本；
 *   2. 「清空本机数据」删的是伪键 `__all__`，IndexedDB 里的壁纸 blob 其实没删。
 */
import { expect, test, type Page } from "@playwright/test";

const MALICIOUS = `<img src=x onerror="window.__wallXss=1">壁纸`;

async function bootDesktop(page: Page): Promise<void> {
  await page.goto("/");
  await page.waitForSelector("#os", { timeout: 30_000 });
  await page.waitForFunction(() => !document.querySelector("#boot"), undefined, { timeout: 30_000 });
  const skip = page.locator("[data-onb-skip]");
  if (await skip.count()) {
    await skip.first().click().catch(() => undefined);
    await page.locator(".os20-onb").waitFor({ state: "detached", timeout: 10_000 }).catch(() => undefined);
  }
}

async function openSettings(page: Page, tab: "wallpaper" | "system"): Promise<void> {
  await page.evaluate((target) => {
    const api = (window as unknown as { GOS13?: { openSettings?: (t?: string) => void } }).GOS13;
    api?.openSettings?.(target);
  }, tab);
  const win = page.locator('.window[data-app="settings"]');
  await expect(win).toBeVisible({ timeout: 20_000 });
  await expect(win.locator("#wall-grid")).toBeAttached({ timeout: 20_000 });
}

test.describe("设置页壁纸安全 · 真实 Worker + 真实浏览器", () => {
  test("社区来源的壁纸标题只当文本显示，不会注入 DOM", async ({ page }) => {
    await page.addInitScript((name) => {
      if (sessionStorage.getItem("xss-seeded")) return;
      sessionStorage.setItem("xss-seeded", "1");
      localStorage.setItem(
        "guandao.os13.v1",
        JSON.stringify({
          v: 1,
          custom: [{ id: "custom:evil", name, accent: "#123456", at: Date.now(), bytes: 128 }],
        }),
      );
    }, MALICIOUS);

    await bootDesktop(page);
    await openSettings(page, "wallpaper");
    const win = page.locator('.window[data-app="settings"]');
    await win.locator('#wall-cats [data-cat="custom"]').click();
    const card = win.locator("#wall-grid .wall-card");
    await expect(card).toHaveCount(1);

    // 名字作为文本完整显示（浏览器会把实体解码回原字符）
    await expect(win.locator("#wall-grid .wc-name")).toHaveText(MALICIOUS);
    const html = await win.locator("#wall-grid").innerHTML();
    // 文本节点重新序列化时只转义 & < >（不转义引号），所以 innerHTML 里
    // 仍会出现 "onerror=" 这串字符。真正的证据看 DOM：没有注入的 img / onerror 元素。
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
    expect(await win.locator("#wall-grid img").count()).toBe(0);
    expect(await win.locator("#wall-grid [onerror]").count()).toBe(0);
    expect(await page.evaluate(() => (window as unknown as { __wallXss?: number }).__wallXss)).toBeUndefined();
  });

  test("清空本机数据后会删掉 IndexedDB 里的壁纸 blob", async ({ page }) => {
    await page.addInitScript(() => {
      if (sessionStorage.getItem("reset-seeded")) return;
      sessionStorage.setItem("reset-seeded", "1");
      localStorage.setItem(
        "guandao.os13.v1",
        JSON.stringify({
          v: 1,
          custom: [{ id: "custom:seed1", name: "待清理壁纸", accent: "#123456", at: Date.now(), bytes: 32 }],
        }),
      );
    });

    await bootDesktop(page);
    await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("guandao-os13", 1);
        request.onupgradeneeded = () => {
          if (!request.result.objectStoreNames.contains("wallpapers")) request.result.createObjectStore("wallpapers");
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("wallpapers", "readwrite");
        tx.objectStore("wallpapers").put(new Blob(["seed-wallpaper"]), "custom:seed1");
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    });
    const before = await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("guandao-os13", 1);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const count = await new Promise<number>((resolve, reject) => {
        const tx = db.transaction("wallpapers", "readonly");
        const req = tx.objectStore("wallpapers").count();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      db.close();
      return count;
    });
    expect(before).toBe(1);

    await openSettings(page, "system");
    page.on("dialog", (dialog) => void dialog.accept());
    const reloaded = page.waitForEvent("load", { timeout: 30_000 }).catch(() => undefined);
    await page.locator('.window[data-app="settings"] [data-act="reset-all"]').click();
    await reloaded;
    await page.waitForSelector("#os", { timeout: 30_000 });

    const after = await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("guandao-os13", 1);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const count = await new Promise<number>((resolve, reject) => {
        const tx = db.transaction("wallpapers", "readonly");
        const req = tx.objectStore("wallpapers").count();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      db.close();
      return count;
    });
    expect(after).toBe(0);
    // 刷新后 os13 会立刻写回一份默认配置，所以不能断言键为 null；
    // 真正要保证的是：自定义壁纸条目已清空、种子 id 不再出现。
    const stored = await page.evaluate(() => localStorage.getItem("guandao.os13.v1"));
    expect(stored ?? "").not.toContain("custom:seed1");
    const custom = JSON.parse(stored ?? "{}").custom ?? [];
    expect(custom).toEqual([]);
  });
});