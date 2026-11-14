import puppeteer from "puppeteer-core";

const BASE = "http://127.0.0.1:8787";
const TOKEN = process.env.GDV_TOKEN;
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ["--no-sandbox"],
  defaultViewport: { width: 1440, height: 900 },
});

const page = await browser.newPage();
const violations = [];
const errors = [];

page.on("console", (message) => {
  const text = message.text();
  if (message.type() === "error" && !text.includes("Failed to load resource")) errors.push(text);
  if (/Content Security Policy/i.test(text)) violations.push(text);
});
page.on("pageerror", (error) => errors.push(String(error)));

await page.evaluateOnNewDocument(() => {
  window.__csp = [];
  document.addEventListener("securitypolicyviolation", (event) => {
    window.__csp.push({
      directive: event.violatedDirective,
      blocked: event.blockedURI,
      sample: (event.sample || "").slice(0, 80),
      source: event.sourceFile,
    });
  });
});

if (TOKEN) {
  await page.setCookie({
    name: "gauth_sid",
    value: TOKEN,
    domain: "127.0.0.1",
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
  });
}

await page.goto(BASE, { waitUntil: "networkidle2", timeout: 60000 });
await page.waitForFunction(() => Boolean(window.GOS14), { timeout: 25000 });
await new Promise((resolve) => setTimeout(resolve, 3000));

const boot = await page.evaluate(() => {
  const node = document.getElementById("boot");
  return node ? getComputedStyle(node).display : "missing";
});

console.log("boot display:", boot);
console.log("GOS14:", await page.evaluate(() => typeof window.GOS14));
console.log("CSP violations after load:", JSON.stringify(await page.evaluate(() => window.__csp), null, 1));

// 打开所有系统应用，确认没有新的 CSP 违规
const apps = [
  { id: "notes", fn: "open" },
  { id: "files", fn: "open" },
  { id: "devices", fn: "openDevices" },
  { id: "backup", fn: "openBackup" },
  { id: "security", fn: "openSecurity" },
];
for (const app of apps) {
  const exists = await page.evaluate((name) => typeof window.GOS14?.[name] === "function", app.fn);
  if (!exists) {
    console.log(`app ${app.id}: API 不存在`);
    continue;
  }
  await page.evaluate(({ fn, id }) => window.GOS14[fn](id), app);
  await new Promise((resolve) => setTimeout(resolve, 1600));
  console.log(`app ${app.id}: windows=${await page.evaluate(() => document.querySelectorAll(".window").length)}`);
}

await new Promise((resolve) => setTimeout(resolve, 1500));

const finalViolations = await page.evaluate(() => window.__csp);
console.log("CSP violations total:", finalViolations.length);
if (finalViolations.length) console.log(JSON.stringify(finalViolations.slice(0, 8), null, 1));
console.log("console errors:", errors.slice(0, 8));

await page.screenshot({ path: ".shots/csp-enforced.png" });
await browser.close();
