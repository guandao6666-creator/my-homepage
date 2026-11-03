/** Guandao OS 1.4 边界测试：安装入口、程序坞、勿扰、导出、导入校验、启动台 */
import puppeteer from "puppeteer-core";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const BASE = process.env.OS14_BASE || "http://127.0.0.1:4399/";

const browser = await puppeteer.launch({executablePath:"C:/Program Files/Google/Chrome/Application/chrome.exe",headless:"new",defaultViewport:{width:1600,height:1000}});
const page = await browser.newPage();
await page.setCacheEnabled(false);
const errors=[]; page.on("pageerror",e=>errors.push(e.message));
page.on("console",m=>{if(m.type()==="error"&&!m.text().includes("Failed to load resource"))errors.push(m.text())});
const wait=(ms)=>new Promise(r=>setTimeout(r,ms));
const results=[]; const ok=(n,p,e="")=>results.push(`${p?"PASS":"FAIL"}  ${n}${e?"  · "+e:""}`);
fs.mkdirSync(".shots/downloads",{recursive:true});
const client = await page.createCDPSession();
await client.send("Browser.setDownloadBehavior",{behavior:"allow",downloadPath:path.resolve(".shots/downloads"),eventsEnabled:true});

await page.goto(BASE + "?e=" + Date.now(), { waitUntil: "networkidle2" });
await page.evaluate(()=>{localStorage.clear();indexedDB.deleteDatabase("guandao-os14")});
await page.reload({waitUntil:"networkidle2"});
await wait(2500);
await page.evaluate(()=>document.querySelectorAll(".window").forEach(w=>w.querySelector(".dot-close")?.click()));

// 未安装时的快捷方式守卫
const guard = await page.evaluate(()=>{window.GOS14.sys.addShortcut("gallery");return document.querySelectorAll('.desk-icon[data-app="gallery"]').length});
ok("未安装应用不能添加桌面快捷方式", guard===0, String(guard));

// 安装 → 快捷方式 → 程序坞
await page.evaluate(()=>window.GOS14.install("gallery"));
await wait(400);
await page.evaluate(()=>{window.GOS14.sys.addShortcut("gallery");window.GOS14.sys.pinDock("gallery",true)});
await wait(500);
const shortcut = await page.evaluate(()=>({
  icon: Boolean(document.querySelector('.desk-icon[data-app="gallery"]')),
  dock: Boolean(document.querySelector('.dock-item[data-app="gallery"]')),
  stored: JSON.parse(localStorage.getItem("guandao.os14.apps.v1")||"{}").shortcuts,
}));
ok("安装后可添加到桌面并固定程序坞", shortcut.icon && shortcut.dock && shortcut.stored.includes("gallery"), JSON.stringify(shortcut));

// 启动台包含新应用
await page.evaluate(()=>document.querySelector("[data-launchpad]")?.click());
await wait(600);
const lp = await page.evaluate(()=>[...document.querySelectorAll(".lp-icon")].map(x=>x.dataset.app));
ok("启动台包含新应用", lp.includes("appcenter") && lp.includes("gallery"), `${lp.length} 个`);
await page.evaluate(()=>document.querySelector("#lp-close")?.click());
await wait(300);

// 卸载后入口消失
await page.evaluate(()=>window.GOS14.uninstall("gallery"));
await wait(500);
const removed = await page.evaluate(()=>({icon: Boolean(document.querySelector('.desk-icon[data-app="gallery"]')),dock: Boolean(document.querySelector('.dock-item[data-app="gallery"]')),app: Boolean(window.GOS14.ctx.APPS.gallery)}));
ok("卸载后桌面 / 程序坞 / 注册表都清掉", !removed.icon && !removed.dock && !removed.app, JSON.stringify(removed));

// 勿扰模式
await page.evaluate(()=>{
  const p=JSON.parse(localStorage.getItem("guandao.os14.prefs.v1")||"{}");
  p.v=1;p.dnd=true;p.volume=45;p.animations=true;p.greeting=true;
  localStorage.setItem("guandao.os14.prefs.v1",JSON.stringify(p));
  window.GOS14.ctx.pushNotif({icon:"!",title:"勿扰测试",body:"这条应当直接标记为已读"});
});
await wait(400);
const dnd = await page.evaluate(()=>{const l=JSON.parse(localStorage.getItem("guandao.os.notif.v1")||"[]");return l.find(n=>n.title==="勿扰测试")});
ok("勿扰模式下通知入库但不打扰", dnd && dnd.read===true, JSON.stringify(dnd));

// 任务通知联动
await page.evaluate(()=>{window.GOS14.ctx.pushNotif({icon:"✓",title:"联动测试",body:"应出现在任务中心"});window.GOS14.open("tasks")});
await wait(700);
await page.evaluate(()=>{[...document.querySelectorAll(".g14-nav")].find(n=>n.dataset.tab==="notif")?.click()});
await wait(400);
const notifShown = await page.evaluate(()=>[...document.querySelectorAll(".tk14-notif b")].some(b=>b.textContent==="联动测试"));
ok("任务中心显示同一份通知", notifShown);
await page.evaluate(()=>document.querySelector(".window[data-app='tasks'] .dot-close")?.click());

// 导出文件
await page.evaluate(()=>window.GOS14.open("datacenter"));
await wait(700);
await page.evaluate(()=>{[...document.querySelectorAll(".g14-nav")].find(n=>n.dataset.tab==="migrate")?.click()});
await wait(400);
await page.evaluate(()=>document.querySelector("[data-dc-export]")?.click());
await wait(1200);
const files = fs.readdirSync(".shots/downloads").filter(f=>f.endsWith(".json"));
ok("数据导出下载为 JSON", files.length>=1, files.join(","));
if(files.length){const raw=JSON.parse(fs.readFileSync(".shots/downloads/"+files[0],"utf8"));ok("导出文件包含 guandao 数据", raw.kind==="guandao-os-backup" && Object.keys(raw.data).length>5, `${Object.keys(raw.data).length} keys`)}
await page.evaluate(()=>document.querySelector(".window[data-app='datacenter'] .dot-close")?.click());

// 主题导入校验：坏文件应被拒绝
const badPath = ".shots/bad-theme.json";
fs.writeFileSync(badPath, JSON.stringify({kind:"guandao-theme",version:1,theme:{name:"x",wall:"../../evil",accent:"red",mode:"dark"}}));
await page.evaluate(()=>window.GOS14.open("themes"));
await wait(700);
await page.evaluate(()=>{[...document.querySelectorAll(".g14-nav")].find(n=>n.dataset.tab==="mine")?.click()});
await wait(400);
const [chooser] = await Promise.all([page.waitForFileChooser({timeout:5000}), page.evaluate(()=>document.querySelector("[data-import]")?.click())]);
await chooser.accept([badPath]);
await wait(800);
const badRejected = await page.evaluate(()=>({themes:JSON.parse(localStorage.getItem("guandao.os14.themes.v1")||"{}").custom?.length??0, modal: Boolean(document.querySelector(".g14-modal"))}));
ok("非法主题配置被拒绝并提示", badRejected.themes===0 && badRejected.modal, JSON.stringify(badRejected));

// 关闭失败提示，再导入一份合法主题
await page.evaluate(()=>{
  const btn=[...document.querySelectorAll(".g14-modal-actions .g14-btn")].find(b=>b.textContent.trim()==="知道了");
  btn?.click();
});
await wait(300);
const goodPath = ".shots/good-theme.json";
fs.writeFileSync(goodPath, JSON.stringify({kind:"guandao-theme",version:1,theme:{
  name:"导入测试",en:"Imported",style:"冷色 · 测试",wall:"aurora",mode:"dark",
  accent:"#22ccaa",accent2:"#3388ff",material:"glass",radius:"round",darken:20,
  font:"sans",grain:false,dock:{size:44,magnify:1.2,opacity:0.55},tags:["测试"],desc:"来自导出文件的主题"
}}));
const [chooser2] = await Promise.all([page.waitForFileChooser({timeout:5000}), page.evaluate(()=>document.querySelector("[data-import]")?.click())]);
await chooser2.accept([goodPath]);
await wait(900);
const goodImported = await page.evaluate(()=>{
  const st=JSON.parse(localStorage.getItem("guandao.os14.themes.v1")||"{}");
  const t=st.custom?.find(x=>x.name==="导入测试");
  return { n: st.custom?.length??0, accent: t?.accent, wall: t?.wall };
});
ok("合法主题配置可以导入", goodImported.n===1 && goodImported.accent==="#22ccaa", JSON.stringify(goodImported));

// 游戏暂停 / 重新开始
await page.evaluate(()=>window.GOS14.open("playground"));
await wait(800);
await page.evaluate(()=>document.querySelector('[data-play="snake"]')?.click());
await wait(600);
await page.evaluate(()=>document.querySelector("[data-pg-pause]")?.click());
await wait(300);
const paused = await page.evaluate(()=>({cover: !document.querySelector("[data-pg-paused]")?.hidden, label: document.querySelector("[data-pg-pause]")?.textContent}));
ok("游戏可以暂停", paused.cover && paused.label==="继续", JSON.stringify(paused));
await page.evaluate(()=>document.querySelector("[data-pg-restart]")?.click());
await wait(700);
const restarted = await page.evaluate(()=>({canvas: Boolean(document.querySelector(".gm-snake canvas")), cover: Boolean(document.querySelector("[data-pg-paused]")?.hidden)}));
ok("游戏可以重新开始", restarted.canvas && restarted.cover, JSON.stringify(restarted));
await page.evaluate(()=>document.querySelector(".window[data-app='playground'] .dot-close")?.click());
await wait(300);

// 快捷键 Alt+1 切换工作空间
await page.evaluate(()=>document.body.focus());
await page.keyboard.down("Alt"); await page.keyboard.press("1"); await page.keyboard.up("Alt");
await wait(1500);
const wsKey = await page.evaluate(()=>JSON.parse(localStorage.getItem("guandao.os14.ws.v1")||"{}").current);
ok("Alt+1 切换工作空间", wsKey==="daily", String(wsKey));

// 备份导入：写入探针键 → 选择文件 → 确认 → 页面刷新 → 键仍在
const importPath = ".shots/import-backup.json";
fs.writeFileSync(importPath, JSON.stringify({
  kind:"guandao-os-backup", version:"guandao-os/1.4", exportedAt:new Date().toISOString(),
  data:{"guandao.os14.importProbe":{"ok":true,"at":Date.now()}}
}));
await page.evaluate(()=>window.GOS14.open("datacenter"));
await wait(700);
await page.evaluate(()=>{[...document.querySelectorAll(".g14-nav")].find(n=>n.dataset.tab==="migrate")?.click()});
await wait(500);
const [chooser3] = await Promise.all([page.waitForFileChooser({timeout:5000}), page.evaluate(()=>document.querySelector("[data-dc-import]")?.click())]);
await chooser3.accept([importPath]);
await wait(900);
const confirmVisible = await page.evaluate(()=>[...document.querySelectorAll(".g14-modal-actions .g14-btn")].some(b=>b.textContent.includes("导入并刷新")));
await Promise.all([
  page.waitForNavigation({waitUntil:"networkidle2",timeout:8000}).catch(()=>null),
  page.evaluate(()=>{[...document.querySelectorAll(".g14-modal-actions .g14-btn")].find(b=>b.textContent.includes("导入并刷新"))?.click()}),
]);
await wait(2200);
const imported = await page.evaluate(()=>({
  probe: JSON.parse(localStorage.getItem("guandao.os14.importProbe")||"null"),
  ready: Boolean(window.GOS14_READY),
}));
ok("备份导入后数据写入并正常启动", confirmVisible && imported.probe?.ok===true && imported.ready, JSON.stringify(imported));


ok("边界测试无 JS 错误", errors.length===0, errors.slice(0,4).join(" | "));
console.log(results.join("\n"));
console.log("\nERRORS:", errors.length?errors.slice(0,8).join("\n"):"none");
await browser.close();
