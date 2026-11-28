// 6.2：本应用样式随 chunk 按需下载
import cssUrl1 from "../../../styles/apps/terminal.css?url";
import { ensureCss } from "../../ui/lazy-css";

/** 6.2：样式走运行时加载，`load()` 会等它完成再渲染（Astro 会把直接 import 的 CSS 提升到首页） */
export const stylesReady = ensureCss(cssUrl1);

/**
 * 终端（terminal）· 对应 index.astro 原 `renderTerminal` / `initTerminal`。
 *
 * 2.3 升级与修复：
 *   - 接入统一版本源 `OS_VERSION` / `RELEASE_NAME`（修复 `version` 命令长期停留在 2.0 的缺陷）
 *   - 新增 `calc <算式>` 命令（复用零 eval 算术解析器）
 *   - 扩展 `open <序号|应用ID>`：除打开博客文章外，可直接拉起任意桌面应用（如 `open devtools`）
 *   - 升级 `date` 命令：同时输出本地时间、UTC 与东京/伦敦/纽约世界时间
 */
import { evaluateMath } from "../../os23/math";
import { OS_VERSION, RELEASE_NAME } from "../../version";
import type { LegacyAppModule } from "../types";

export const terminalApp: LegacyAppModule = {
  id: "terminal",
  title: "终端",
  width: 580,
  height: 380,
  glyph: "di-term",
  body: () => `
          <div class="term">
            <div class="term-out" id="term-out">
              <p class="term-line term-muted">Guandao OS ${OS_VERSION.slice(0, 3)} · 输入 help 看可用命令</p>
            </div>
            <label class="term-input-row">
              <span class="term-prompt">~ $</span>
              <input class="term-input" id="term-input" type="text" autocomplete="off" spellcheck="false" />
            </label>
          </div>`,
  init: (win, { data, achievements, shell, desktopFacilities }) => {
    const out = win.querySelector("#term-out") as HTMLElement | null;
    const input = win.querySelector("#term-input") as HTMLInputElement | null;
    if (!out || !input) return;

    const print = (text: string, className = "") => {
      const line = document.createElement("p");
      line.className = `term-line ${className}`.trim();
      line.textContent = text;
      out.appendChild(line);
      out.scrollTop = out.scrollHeight;
    };

    const COMMANDS = [
      "help",
      "ls",
      "find",
      "open",
      "calc",
      "blog",
      "whoami",
      "date",
      "time",
      "uptime",
      "version",
      "apps",
      "theme",
      "wallpaper",
      "neofetch",
      "matrix",
      "echo",
      "about",
      "clear",
      "exit",
    ];

    const history: string[] = [];
    let historyIdx = -1;

    const neofetch = () => {
      const art = [
        "   ██████╗  ",
        "  ██╔════╝  ",
        "  ██║  ███╗ ",
        "  ██║   ██║ ",
        "  ╚██████╔╝ ",
        "   ╚═════╝  ",
      ];
      const info = [
        `${data.site.author}@guandao.xin`,
        "-----------------",
        `OS: Guandao OS ${OS_VERSION} (${RELEASE_NAME})`,
        "引擎: Astro 静态渲染 + Cloudflare Worker",
        `运行窗口: ${desktopFacilities.openWindowCount()}`,
        `虚拟桌面: ${desktopFacilities.deskCount()}`,
        `已开启: ${Math.max(1, Math.floor((Date.now() - desktopFacilities.bootedAt) / 60000))} 分钟`,
      ];
      for (let i = 0; i < Math.max(art.length, info.length); i++) {
        print(`${art[i] ?? "          "}  ${info[i] ?? ""}`, "term-ok");
      }
    };

    const matrix = () => {
      const chars = "アイウエオカキクケコサシスセソ01";
      for (let r = 0; r < 8; r++) {
        let line = "";
        for (let c = 0; c < 34; c++) line += chars[Math.floor(Math.random() * chars.length)];
        print(line, "term-matrix");
      }
    };

    const run = (raw: string) => {
      const cmd = raw.trim();
      if (!cmd) return;
      achievements.unlock("hack");
      history.push(cmd);
      historyIdx = history.length;
      print(`~ $ ${cmd}`, "term-echo");

      const [name, ...rest] = cmd.split(/\s+/);
      const arg = rest.join(" ");
      switch (name) {
        case "help":
          print("ls / find <词>       列出或搜索博客文章");
          print("open <序号|应用名>   打开第 n 篇文章，或启动桌面应用（如 open devtools）");
          print("calc <算式>          即时计算数学表达式（如 calc sqrt(144)+2^5）");
          print("apps                 列出全部内置应用与当前打开窗口");
          print("date / time / uptime 多时区时间与系统运行状态");
          print("theme <dark|light>   切换深浅外观");
          print("wallpaper <nebula|dusk|deep> 切换经典壁纸");
          print("version / neofetch   查看系统版本与状态卡片");
          print("blog / whoami / echo / matrix / clear / exit");
          break;
        case "ls":
          data.posts.forEach((post, index) => print(`${String(index + 1).padStart(2, "0")}  ${post.title}`));
          break;
        case "find": {
          const q = arg.trim().toLowerCase();
          if (!q) {
            print("用法：find <关键词>", "term-error");
            break;
          }
          const hits = data.posts
            .map((post, index) => ({ post, index }))
            .filter(
              ({ post }) =>
                post.title.toLowerCase().includes(q) ||
                post.tags.some((t) => t.toLowerCase().includes(q)),
            );
          if (!hits.length) {
            print(`没有找到包含「${arg.trim()}」的文章。`, "term-muted");
            break;
          }
          hits.forEach(({ post, index }) =>
            print(`${String(index + 1).padStart(2, "0")}  ${post.title}  [${post.tags.join(", ")}]`, "term-ok"),
          );
          break;
        }
        case "calc": {
          if (!arg.trim()) {
            print("用法：calc <算式>，例如 calc (128 + 64) * 3", "term-error");
            break;
          }
          const val = evaluateMath(arg);
          if (val === null) print("算式无法解析或除数为零", "term-error");
          else print(`= ${val}`, "term-ok");
          break;
        }
        case "blog":
          print("正在前往博客首页…", "term-ok");
          window.location.href = "/home/";
          break;
        case "uptime": {
          const sec = Math.max(1, Math.floor((Date.now() - desktopFacilities.bootedAt) / 1000));
          const min = Math.floor(sec / 60);
          const rem = sec % 60;
          print(
            `已运行 ${min > 0 ? `${min} 分 ${rem} 秒` : `${rem} 秒`} · 窗口 ${desktopFacilities.openWindowCount()} 个 · 虚拟桌面 ${desktopFacilities.deskCount()} 个`,
            "term-ok",
          );
          break;
        }
        case "open": {
          const target = rest[0]?.trim() ?? "";
          if (!target) {
            print("用法：open <文章序号> 或 open <应用ID/名称>（例如 open devtools）", "term-error");
            break;
          }
          if (/^\d+$/.test(target)) {
            const index = Number(target) - 1;
            const post = data.posts[index];
            if (!post) {
              print("没有这一篇，先用 ls 看看。", "term-error");
              break;
            }
            print(`正在打开文章：${post.title}`);
            window.location.href = post.href;
            break;
          }
          const opened = shell.openAppById?.(arg.trim());
          if (opened) {
            print(`已启动应用：${opened}`, "term-ok");
          } else {
            print(`未找到应用「${arg.trim()}」，输入 apps 查看应用列表。`, "term-error");
          }
          break;
        }
        case "whoami":
        case "about":
          print(`${data.site.author} · 大连理工大学 · 智能制造`);
          break;
        case "date": {
          const now = new Date();
          print(now.toLocaleString("zh-CN", { year: "numeric", month: "long", day: "numeric", weekday: "long", hour12: false }));
          const fmt = (tz: string) =>
            new Intl.DateTimeFormat("zh-CN", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now);
          print(`UTC ${now.toISOString().slice(11, 16)} · 东京 ${fmt("Asia/Tokyo")} · 伦敦 ${fmt("Europe/London")} · 纽约 ${fmt("America/New_York")}`, "term-muted");
          break;
        }
        case "time":
          print(new Date().toLocaleTimeString("zh-CN", { hour12: false }));
          break;
        case "version":
          print(`Guandao OS ${OS_VERSION} · ${RELEASE_NAME}`, "term-accent");
          break;
        case "apps": {
          print(`共 ${desktopFacilities.appTitles().length} 个应用：${desktopFacilities.appTitles().join(" · ")}`, "term-accent");
          const openTitles = desktopFacilities.openWindowTitles();
          if (openTitles.length) print(`运行中窗口（${openTitles.length}）：${openTitles.join("、")}`, "term-ok");
          break;
        }
        case "theme": {
          const t = arg === "light" ? "light" : "dark";
          shell.setTheme(t);
          print(`已切换到${t === "light" ? "浅色" : "深色"}模式。`, "term-ok");
          break;
        }
        case "wallpaper": {
          const w = ["nebula", "dusk", "deep"].includes(arg) ? arg : "nebula";
          shell.setWallpaper(w);
          print(`壁纸已切换：${w}`, "term-ok");
          break;
        }
        case "neofetch":
          neofetch();
          break;
        case "matrix":
          matrix();
          break;
        case "echo":
          print(arg);
          break;
        case "clear":
          out.innerHTML = "";
          break;
        case "exit":
          shell.closeWindow(win);
          break;
        default: {
          const extra = shell.runExtensionCommand(name);
          if (extra) print(extra, "term-accent");
          else print(`未知命令：${name}，试试 help`, "term-error");
        }
      }
    };

    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        run(input.value);
        input.value = "";
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        if (history.length) {
          historyIdx = Math.max(0, historyIdx - 1);
          input.value = history[historyIdx] ?? "";
        }
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        if (history.length) {
          historyIdx = Math.min(history.length, historyIdx + 1);
          input.value = history[historyIdx] ?? "";
        }
      } else if (event.key === "Tab") {
        event.preventDefault();
        const v = input.value.trim();
        const hit = COMMANDS.filter((c) => c.startsWith(v));
        if (hit.length === 1) input.value = hit[0] + " ";
        else if (hit.length > 1) print(hit.join("  "), "term-muted");
      }
    });

    input.focus({ preventScroll: true });
  },
};
