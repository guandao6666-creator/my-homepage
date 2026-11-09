import puppeteer from "puppeteer-core";

const browser = await puppeteer.connect({ browserURL: "http://127.0.0.1:9222" });
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.setCacheEnabled(false);
await page.setViewport({ width: 480, height: 860, isMobile: true, hasTouch: true });
await page.goto("https://guandao.xin/", { waitUntil: "networkidle2", timeout: 60000 });
await page.waitForFunction("window.GOS14_READY === true", { timeout: 30000 });
await page.evaluate("window.GOS14.openCommunity()");
await new Promise((r) => setTimeout(r, 2500));
await page.screenshot({ path: ".shots/16-mobile-community.png" });
console.log(
  JSON.stringify({
    width: await page.evaluate("document.querySelector('.cx-body')?.clientWidth"),
    scroll: await page.evaluate("document.querySelector('.cx-body')?.scrollWidth"),
    errors: errors.slice(0, 5),
  }),
);
await page.close();
await browser.disconnect();
