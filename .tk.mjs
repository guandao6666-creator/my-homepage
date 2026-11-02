import { spawn } from "node:child_process";
const EMAIL = "tok1793610836@guandao-test.com";
const PORT = 9550;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const proc = spawn("C:/Program Files/Google/Chrome/Application/chrome.exe", ["--headless=new","--no-sandbox","--remote-debugging-port=" + PORT,"--user-data-dir=C:/Users/1/Desktop/my-homepage/.shots/cdp-tk","about:blank"], { stdio: "ignore" });
let page = null;
for (let i = 0; i < 40 && !page; i++) {
  try { page = (await (await fetch("http://127.0.0.1:" + PORT + "/json/list")).json()).find((t) => t.type === "page"); } catch {}
  if (!page) await sleep(250);
}
if (!page) { console.log("未就绪"); proc.kill(); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); } };
const send = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id, method, params })); });
await new Promise((r) => (ws.onopen === null || (ws.onopen = r)));
await send("Page.enable"); await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
const ev = async (e) => (await send("Runtime.evaluate", { expression: e, returnByValue: true })).result?.value;
const errors = [];
ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.method === "Runtime.exceptionThrown") errors.push((m.params.exceptionDetails.exception?.description || "").split("\n")[0]); });
await send("Page.navigate", { url: "http://localhost:4321/" });
await sleep(3500);

// 登录
await ev("document.querySelector('.desk-icon[data-app=\"council\"]')?.click()");
await sleep(2500);
await ev("(() => { const b = document.querySelector('#council-auth'); b.querySelector('[data-auth-email]').value = '" + EMAIL + "'; b.querySelector('[data-auth-password]').value = 'tok123456'; b.querySelector('[data-auth-signup]').click(); return 1; })()");
await sleep(6000);
console.log("登录后状态:", await ev("document.getElementById('council-status')?.textContent"));
console.log("选项禁用:", await ev("document.querySelector('.council-opt')?.disabled"));

// 把时间戳改成 1 小时前，模拟过期
await ev("(() => { const a = JSON.parse(localStorage.getItem('guandao.auth')); a.at = Date.now() - 61 * 60 * 1000; localStorage.setItem('guandao.auth', JSON.stringify(a)); return a.at; })()");
console.log("已把 token 改成过期状态");

// 投票
await ev("(() => { const items = [...document.querySelectorAll('.council-item')]; const item = items.find(i => i.textContent.includes('穿什么')); const opts = [...item.querySelectorAll('.council-opt')]; const i = opts.findIndex(o => o.textContent.includes('原版')); opts[i].click(); return i; })()");
await sleep(4000);
console.log("投票后状态:", await ev("document.getElementById('council-status')?.textContent"));
console.log("我的票:", await ev("document.querySelector('.council-opt.is-mine .council-label')?.textContent ?? '无'"));
const at = await ev("(() => { const a = JSON.parse(localStorage.getItem('guandao.auth') || 'null'); return a ? Math.round((Date.now() - a.at) / 1000) + ' 秒前刷新' : '未登录'; })()");
console.log("token 状态:", at);
console.log("JS 错误:", errors.length ? errors.slice(0,2).join(" | ") : "无");
ws.close(); proc.kill();
