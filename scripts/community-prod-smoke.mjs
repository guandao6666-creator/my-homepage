import puppeteer from "puppeteer-core";

const browser = await puppeteer.connect({ browserURL: "http://127.0.0.1:9222" });
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (msg) => {
  if (msg.type() === "error") errors.push(`console: ${msg.text()}`);
});
await page.setCacheEnabled(false);
await page.setViewport({ width: 1440, height: 900 });
await page.goto("https://guandao.xin/", { waitUntil: "networkidle2", timeout: 60000 });
await page.waitForFunction("window.GOS14_READY === true", { timeout: 30000 });
await page.evaluate("window.GOS14.openCommunity()");
await new Promise((r) => setTimeout(r, 3000));
const result = {
  version: await page.evaluate("document.querySelector('.mb-version')?.textContent"),
  heading: await page.evaluate("document.querySelector('.cx-hero h1')?.textContent"),
  empty: await page.evaluate("document.querySelector('.cx-body .g14-empty-title')?.textContent || ''"),
  errors: errors.slice(0, 6),
};
await page.evaluate("window.dispatchEvent(new CustomEvent('guandao:open-login'))");
await new Promise((r) => setTimeout(r, 900));
result.joinBadge = await page.evaluate("document.querySelector('#gauth-community-badge')?.textContent");
result.joinVisible = await page.evaluate("!document.querySelector('#gauth-community')?.hidden");
result.inviteVisible = await page.evaluate("!document.querySelector('#gauth-invite')?.hidden");
console.log(JSON.stringify(result));
await page.screenshot({ path: ".shots/16-production-final.png" });
await page.close();
await browser.disconnect();
