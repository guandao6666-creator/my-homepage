// 6.2：本应用样式随 chunk 按需下载
import cssUrl1 from "../../../styles/apps/terminal.css?url";
import { ensureCss } from "../../ui/lazy-css";

/** 6.2：样式走运行时加载，`load()` 会等它完成再渲染（Astro 会把直接 import 的 CSS 提升到首页） */
export const stylesReady = ensureCss(cssUrl1);

/**
 * 终端（terminal）· 对应 index.astro 原 `renderTerminal` / `initTerminal`。
 *
 * 依赖：`data.posts` / `data.site`、`achievements.unlock`、
 * `shell`（关闭窗口 / 主题 / 壁纸 / 生态层隐藏命令）、
 * `desktopFacilities`（窗口数 / 桌面数 / 启动时间 / 应用标题）。
 * 键盘焦点只在应用窗口内部，没有计时器与全局监听。
 */
import type { LegacyAppModule } from "../types";

export const terminalApp: LegacyAppModule = {
  id: "terminal",
  title: "终端",
  width: 560,
  height: 360,
  glyph: "di-term",
  body: () => `
          <div class="term">
            <div class="term-out" id="term-out">
              <p class="term-line term-muted">Guandao OS 2.2 · 输入 help 看可用命令</p>
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
        "OS: Guandao OS 2.2 (Chrono Flow)",
        "引擎: Astro 静态渲染",
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
          print("ls / find <词> / open <n>  列出、搜索并打开文章");
          print("blog            切换到纯净博客版");
          print("whoami / about  关于我");
          print("apps            全部应用");
          print("theme <dark|light>  切换外观");
          print("wallpaper <nebula|dusk|deep>  换壁纸");
          print("date / time / uptime  时间与运行状态");
          print("version         系统版本");
          print("neofetch        系统信息");
          print("matrix          黑客帝国");
          print("echo <文本>     回声");
          print("clear / exit    清空 / 关闭");
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
          const index = Number(rest[0]) - 1;
          const post = data.posts[index];
          if (!post) {
            print("没有这一篇，先用 ls 看看。", "term-error");
            break;
          }
          print(`正在打开：${post.title}`);
          window.location.href = post.href;
          break;
        }
        case "whoami":
        case "about":
          print(`${data.site.author} · 大连理工大学 · 智能制造`);
          break;
        case "date":
          print(new Date().toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric", weekday: "long" }));
          break;
        case "time":
          print(new Date().toLocaleTimeString("zh-CN", { hour12: false }));
          break;
        case "version":
          print("Guandao OS 2.0 · The Platform Era", "term-accent");
          break;
        case "apps":
          print(desktopFacilities.appTitles().join("  "), "term-accent");
          break;
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
          // 1.4：生态层的隐藏命令交给 os14 处理，未命中再报未知命令
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

    // preventScroll：否则浏览器会把 overflow:hidden 的桌面容器整体滚上去
    input.focus({ preventScroll: true });
  },
};
