/**
 * Guandao OS 1.7 · 官方示例插件
 *
 * 这些不是「假市场数据」，而是四份真实可安装的插件包：
 *   - 与第三方插件走同一套 Manifest 校验、权限审批、沙箱加载；
 *   - 打包格式、摘要算法与 CLI 产出的 .gplug 完全一致；
 *   - 安装后由 IndexedDB 保存，可在插件管理器里禁用 / 卸载 / 查看日志。
 */

import { canonicalFilesJson, type BundleFile, type Manifest } from "../../../shared/plugin-spec.js";
import { sha256Hex } from "./bundle";

export type OfficialPlugin = {
  id: string;
  manifest: Manifest;
  files: BundleFile[];
  bundle: string;
  accent: string;
  screenshots: string[];
};

let cache: Promise<OfficialPlugin[]> | null = null;

const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96">
  <rect width="96" height="96" rx="24" fill="#10131c"/>
  <circle cx="48" cy="48" r="23" fill="none" stroke="#8b93ff" stroke-width="6"/>
  <circle cx="48" cy="48" r="8" fill="#8b93ff"/>
</svg>`;

const HELLO_STYLE = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
body {
  font: 13px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", "Noto Sans SC", sans-serif;
  color: #eef1f7;
  background: radial-gradient(120% 90% at 10% 0%, #1d2440 0%, #0d1018 55%, #0a0c12 100%);
  padding: 20px;
}
.hello { max-width: 760px; margin: 0 auto; display: flex; flex-direction: column; gap: 16px; height: 100%; }
header { display: flex; align-items: center; gap: 12px; }
.logo { width: 40px; height: 40px; border-radius: 12px; background: linear-gradient(140deg,#6f8cff,#b06eff); display: grid; place-items: center; font-size: 20px; }
h1 { margin: 0; font-size: 17px; font-weight: 650; letter-spacing: -0.01em; }
header p { margin: 2px 0 0; color: #99a1b6; font-size: 11.5px; }
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
@media (max-width: 560px) { .grid { grid-template-columns: 1fr; } }
.card { background: rgba(255,255,255,.055); border: 1px solid rgba(255,255,255,.09); border-radius: 14px; padding: 14px; }
.card h2 { margin: 0 0 8px; font-size: 12px; letter-spacing: .08em; text-transform: uppercase; color: #99a1b6; font-weight: 600; }
.num { margin: 2px 0 10px; font-size: 38px; font-weight: 600; letter-spacing: -0.03em; font-variant-numeric: tabular-nums; }
.row { display: flex; gap: 8px; flex-wrap: wrap; }
button {
  font: inherit; font-size: 12px; padding: 7px 12px; border-radius: 9px; cursor: pointer;
  border: 1px solid rgba(255,255,255,.14); background: rgba(255,255,255,.07); color: #eef1f7;
}
button:hover { background: rgba(255,255,255,.12); }
button.primary { background: linear-gradient(135deg,#6f8cff,#8b7bff); border-color: transparent; font-weight: 600; }
.hint { margin: 10px 0 0; font-size: 11px; color: #7f879b; }
pre { margin: 10px 0 0; padding: 10px; border-radius: 10px; background: rgba(0,0,0,.28); font: 11px/1.5 ui-monospace, Menlo, Consolas, monospace; color: #b9c2d8; white-space: pre-wrap; min-height: 52px; max-height: 120px; overflow: auto; }
footer { margin-top: auto; padding-top: 6px; font-size: 11px; color: #7f879b; }
`;

const HELLO_APP = `
(function () {
  var countEl = document.getElementById('count');
  var outEl = document.getElementById('out');
  var ctxEl = document.getElementById('ctx');
  var count = 0;

  function show(label, value) {
    outEl.textContent = label + '\\n' + JSON.stringify(value, null, 2);
  }
  function fail(error) {
    outEl.textContent = (error && error.code ? error.code : 'ERROR') + ': ' + (error && error.message ? error.message : '调用失败');
  }
  function paint() { countEl.textContent = String(count); }

  async function init() {
    try {
      var ctx = await window.guandao.context();
      ctxEl.textContent = ctx.pluginId + ' · v' + ctx.version + ' · SDK ' + ctx.sdkVersion + ' · 沙箱 iframe';
    } catch (error) { fail(error); }

    try {
      var stored = await window.guandao.storage.get('count');
      count = Number(stored) || 0;
      paint();
    } catch (error) { fail(error); }
  }

  document.getElementById('inc').addEventListener('click', async function () {
    count += 1;
    paint();
    try { await window.guandao.storage.set('count', count); } catch (error) { fail(error); }
  });

  document.getElementById('reset').addEventListener('click', async function () {
    count = 0;
    paint();
    try { await window.guandao.storage.clear(); } catch (error) { fail(error); }
  });

  document.getElementById('notify').addEventListener('click', async function () {
    try {
      await window.guandao.notifications.success('Hello from a plugin', '这条通知由沙箱里的插件发出。');
      show('notification', { ok: true });
    } catch (error) { fail(error); }
  });

  document.getElementById('dialog').addEventListener('click', async function () {
    try {
      var result = await window.guandao.ui.dialog({
        title: '插件请求确认',
        message: '这个对话框由插件发起，宿主负责渲染。插件拿不到对话框以外的任何内容。',
        actions: [
          { label: '取消', value: 'cancel' },
          { label: '继续', value: 'ok', primary: true }
        ]
      });
      show('dialog', result);
    } catch (error) { fail(error); }
  });

  document.getElementById('theme').addEventListener('click', async function () {
    try {
      show('theme', await window.guandao.ui.theme());
    } catch (error) { fail(error); }
  });

  window.guandao.lifecycle.on('ready', init);
})();
`;

const WIDGET_STYLE = `
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; background: transparent; }
body {
  font: 12px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", "Noto Sans SC", sans-serif;
  color: rgba(238,241,247,.92);
  display: flex; flex-direction: column; justify-content: center; gap: 2px;
  padding: 2px 4px;
}
.time { font-size: 27px; font-weight: 600; letter-spacing: -.02em; font-variant-numeric: tabular-nums; }
.date { font-size: 11px; color: rgba(238,241,247,.58); letter-spacing: .02em; }
.row { display: flex; align-items: center; gap: 6px; margin-top: 6px; font-size: 10px; color: rgba(238,241,247,.5); }
.dot { width: 5px; height: 5px; border-radius: 50%; background: #5ecf9a; box-shadow: 0 0 8px #5ecf9a; }
body[data-mode="light"] { color: #1b2130; }
body[data-mode="light"] .date, body[data-mode="light"] .row { color: rgba(27,33,48,.6); }
`;

const WIDGET_APP = `
(function () {
  var timeEl = document.getElementById('time');
  var dateEl = document.getElementById('date');
  var zoneEl = document.getElementById('zone');
  var body = document.body;

  function pad(n) { return String(n).padStart(2, '0'); }

  function tick() {
    var now = new Date();
    timeEl.textContent = pad(now.getHours()) + ':' + pad(now.getMinutes()) + ':' + pad(now.getSeconds());
    dateEl.textContent = now.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' });
  }

  function tint(theme) {
    if (!theme || !theme.mode) return;
    body.dataset.mode = theme.mode;
    if (theme.accent) {
      timeEl.style.color = theme.accent;
    }
  }

  window.guandao.lifecycle.on('theme-change', tint);
  window.guandao.lifecycle.on('ready', function () {
    tick();
    window.guandao.ui.theme().then(tint).catch(function () {});
  });

  tick();
  window.setInterval(tick, 1000);

  try {
    zoneEl.textContent = Intl.DateTimeFormat().resolvedOptions().timeZone || 'local';
  } catch (error) {
    zoneEl.textContent = 'local';
  }
})();
`;

const WIDGET_HTML = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <link rel="stylesheet" href="style.css" />
  </head>
  <body>
    <span class="time" id="time">--:--:--</span>
    <span class="date" id="date">载入中</span>
    <span class="row"><i class="dot"></i><span id="zone">sandbox</span></span>
    <script src="app.js"></script>
  </body>
</html>`;

const QUICKNOTE_HTML = `<!doctype html>
<html lang="zh-CN">
  <head><meta charset="utf-8" /><title>Guandao Quick Note</title></head>
  <body style="background:#0b0e15;color:#eef1f7;font:13px ui-sans-serif,system-ui">
    <p>命令插件没有常驻界面，这个文档只用来接收命令事件。</p>
    <script src="app.js"></script>
  </body>
</html>`;

const QUICKNOTE_APP = `
(function () {
  window.guandao.commands.register([
    { command: 'quicknote.new', title: '新建一条快速便签' }
  ]).catch(function () {});

  window.guandao.lifecycle.on('command', function (payload) {
    if (!payload || payload.command !== 'quicknote.new') return;
    var stamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    window.guandao.notes.create({
      title: '快速便签 ' + stamp,
      body: '这条便签由 Guandao Quick Note 插件创建。\\n\\n时间：' + new Date().toLocaleString('zh-CN'),
      tags: ['插件']
    }).then(function (note) {
      return window.guandao.notifications.success('已创建便签', note.title);
    }).catch(function (error) {
      return window.guandao.notifications.error('创建失败', error.message);
    });
  });
})();
`;

const THEME_JSON = JSON.stringify(
  {
    name: "Moss",
    en: "苔原",
    desc: "低饱和的苔绿与暖灰，适合长时间阅读。",
    wall: "forest",
    mode: "dark",
    accent: "#6fbf9a",
    accent2: "#c8b98a",
    material: "frost",
    radius: "soft",
    font: "sans",
    grain: true,
  },
  null,
  2,
);

const HELLO_HTML = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="stylesheet" href="style.css" />
    <title>Guandao Hello World</title>
  </head>
  <body>
    <main class="hello">
      <header>
        <span class="logo">◈</span>
        <div>
          <h1>Guandao Hello World</h1>
          <p>一个真正跑在沙箱里的示例插件</p>
        </div>
      </header>

      <div class="grid">
        <section class="card">
          <h2>本地存储</h2>
          <p class="num" id="count">0</p>
          <div class="row">
            <button class="primary" type="button" id="inc">+1</button>
            <button type="button" id="reset">清空</button>
          </div>
          <p class="hint">值只存在 plugins/com.guandao.hello/ 这个命名空间里。</p>
        </section>

        <section class="card">
          <h2>能力调用</h2>
          <div class="row">
            <button type="button" id="notify">发通知</button>
            <button type="button" id="dialog">确认框</button>
            <button type="button" id="theme">读主题</button>
          </div>
          <pre id="out">等待调用…</pre>
        </section>
      </div>

      <footer id="ctx">正在读取插件上下文…</footer>
    </main>
    <script src="app.js"></script>
  </body>
</html>`;

function bundleFor(manifest: Manifest, files: BundleFile[]) {
  return JSON.stringify({
    format: "guandao-plugin",
    formatVersion: 1,
    manifest,
    files,
  });
}

export function officialPlugins(): Promise<OfficialPlugin[]> {
  if (cache) return cache;
  cache = (async () => {
    const base = {
      manifestVersion: 1,
      license: "MIT",
      author: { name: "Guandao Studio", url: "https://guandao.xin" },
      compatibility: { minimumOSVersion: "1.7.0", sdkVersion: 1 },
      networkDomains: [],
      dependencies: [],
      homepage: "https://guandao.xin/developers/",
      repository: "",
      category: "developer",
      screenshots: [],
      changelog: "随 Guandao OS 1.7 提供的官方示例。",
    };

    const helloManifest = {
      ...base,
      id: "com.guandao.hello",
      name: "Guandao Hello World",
      version: "1.0.0",
      description: "官方示例：演示插件启动、界面、本地存储、通知、对话框与主题读取。",
      type: "application" as const,
      entry: "index.html",
      icon: "icon.svg",
      permissions: [
        "window.open",
        "notification.show",
        "dialog.open",
        "plugin.storage.read",
        "plugin.storage.write",
        "theme.read",
      ],
      contributes: {},
    } satisfies Manifest;

    const helloFiles: BundleFile[] = [
      { path: "index.html", encoding: "utf8", content: HELLO_HTML },
      { path: "style.css", encoding: "utf8", content: HELLO_STYLE },
      { path: "app.js", encoding: "utf8", content: HELLO_APP },
      { path: "icon.svg", encoding: "utf8", content: ICON_SVG },
      { path: "README.md", encoding: "utf8", content: "# Guandao Hello World\n\n官方示例插件。\n" },
    ];

    const widgetManifest = {
      ...base,
      id: "com.guandao.clock",
      name: "Guandao Clock",
      version: "1.0.0",
      description: "官方示例组件：一个跟随主题配色的桌面时钟，演示组件插件的生命周期。",
      type: "widget" as const,
      entry: "index.html",
      icon: "icon.svg",
      category: "productivity",
      permissions: ["desktop.add_widget", "theme.read"],
      contributes: {
        widget: {
          title: "Guandao Clock",
          defaultSize: "m" as const,
          height: 132,
          description: "跟随主题配色的时钟",
        },
      },
    } satisfies Manifest;

    const widgetFiles: BundleFile[] = [
      { path: "index.html", encoding: "utf8", content: WIDGET_HTML },
      { path: "style.css", encoding: "utf8", content: WIDGET_STYLE },
      { path: "app.js", encoding: "utf8", content: WIDGET_APP },
      { path: "icon.svg", encoding: "utf8", content: ICON_SVG },
    ];

    const quickNoteManifest = {
      ...base,
      id: "com.guandao.quicknote",
      name: "Guandao Quick Note",
      version: "1.0.0",
      description: "官方示例命令插件：在命令面板里输入 quicknote 就能新建一条便签。",
      type: "command" as const,
      entry: "index.html",
      icon: "icon.svg",
      category: "productivity",
      permissions: ["desktop.register_command", "notes.create", "notification.show"],
      contributes: {
        command: [{ command: "quicknote.new", title: "新建一条快速便签", description: "写入 Guandao Notes" }],
      },
    } satisfies Manifest;

    const quickNoteFiles: BundleFile[] = [
      { path: "index.html", encoding: "utf8", content: QUICKNOTE_HTML },
      { path: "app.js", encoding: "utf8", content: QUICKNOTE_APP },
      { path: "icon.svg", encoding: "utf8", content: ICON_SVG },
    ];

    const themeManifest = {
      ...base,
      id: "com.guandao.theme.moss",
      name: "Moss 苔原",
      version: "1.0.0",
      description: "声明式主题扩展：苔绿与暖灰的配色、雾面材质与更柔的圆角。不执行任何脚本。",
      type: "theme" as const,
      entry: "",
      icon: "icon.svg",
      category: "creative",
      permissions: ["theme.apply"],
      contributes: {
        theme: {
          name: "Moss",
          en: "苔原",
          desc: "低饱和的苔绿与暖灰，适合长时间阅读。",
          wall: "forest",
          mode: "dark" as const,
          accent: "#6fbf9a",
          accent2: "#c8b98a",
          material: "frost" as const,
          radius: "soft" as const,
          font: "sans" as const,
          grain: true,
        },
      },
    } satisfies Manifest;

    const themeFiles: BundleFile[] = [
      { path: "icon.svg", encoding: "utf8", content: ICON_SVG },
      { path: "theme.json", encoding: "utf8", content: THEME_JSON },
      { path: "README.md", encoding: "utf8", content: "# Moss\n\n声明式主题，不需要脚本。\n" },
    ];

    const build = async (
      manifest: Manifest,
      files: BundleFile[],
      accent: string,
    ): Promise<OfficialPlugin> => {
      const filesDigest = await sha256Hex(canonicalFilesJson(files));
      const bundle = JSON.stringify({
        format: "guandao-plugin",
        formatVersion: 1,
        manifest,
        files,
        filesDigest,
      });
      return { id: manifest.id, manifest, files, bundle, accent, screenshots: [] };
    };

    return Promise.all([
      build(helloManifest, helloFiles, "linear-gradient(140deg,#6f8cff,#b06eff)"),
      build(widgetManifest, widgetFiles, "linear-gradient(140deg,#5ecf9a,#3f8ecf)"),
      build(quickNoteManifest, quickNoteFiles, "linear-gradient(140deg,#f2bd6b,#e07a5f)"),
      build(themeManifest, themeFiles, "linear-gradient(140deg,#6fbf9a,#c8b98a)"),
    ]);
  })();
  return cache;
}

export async function officialPlugin(id: string): Promise<OfficialPlugin | null> {
  const list = await officialPlugins();
  return list.find((item) => item.id === id) ?? null;
}

export const OFFICIAL_IDS = [
  "com.guandao.hello",
  "com.guandao.clock",
  "com.guandao.quicknote",
  "com.guandao.theme.moss",
];
