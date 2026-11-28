/**
 * 计算器（calc）· 对应 index.astro 原 `renderCalc` / `initCalc`。
 *
 * 2.3 修复：改用 `evaluateMath` 递归下降解析器取代 `new Function(...)`，
 * 彻底修复生产环境严格 CSP（无 `'unsafe-eval'`）拦截导致计算全部报「错误」的缺陷；
 * 同时补充面板 `⌫` 退格键与键盘焦点防护（避免焦点留在按钮上按 Enter 重复触发 click）。
 */
import { evaluateMath } from "../../os23/math";
import type { LegacyAppModule } from "../types";

export const calculatorApp: LegacyAppModule = {
  id: "calc",
  title: "计算器",
  width: 310,
  height: 480,
  glyph: "di-calc",
  body: () => `
          <div class="calc">
            <div class="calc-display" id="calc-display">0</div>
            <div class="calc-history" id="calc-history"></div>
            <div class="calc-pad">
              ${[
                ["C", "⌫", "(", "÷"],
                ["7", "8", "9", "×"],
                ["4", "5", "6", "−"],
                ["1", "2", "3", "+"],
                ["0", ".", ")", "="],
              ]
                .map((row) =>
                  row
                    .map((k) => `<button type="button" class="calc-key ${"÷×−+=".includes(k) ? "is-op" : ""} ${k === "C" || k === "⌫" ? "is-clear" : ""}" data-k="${k}">${k}</button>`)
                    .join(""),
                )
                .join("")}
            </div>
          </div>`,
  init: (win) => {
    const display = win.querySelector("#calc-display");
    const historyEl = win.querySelector("#calc-history");
    let expr = "";
    const setDisplay = (v: string) => {
      if (display) display.textContent = v || "0";
    };
    const push = (k: string) => {
      if (k === "C") {
        expr = "";
        setDisplay("0");
        return;
      }
      if (k === "DEL" || k === "⌫") {
        expr = expr.slice(0, -1);
        setDisplay(expr);
        return;
      }
      if (k === "=") {
        if (!expr.trim()) return;
        const v = evaluateMath(expr);
        if (v !== null) {
          if (historyEl) {
            const li = document.createElement("button");
            li.type = "button";
            li.className = "calc-h-item";
            li.title = "点击复用结果";
            li.dataset.result = String(v);
            li.textContent = `${expr} = ${v}`;
            historyEl.prepend(li);
            while (historyEl.children.length > 20) historyEl.lastElementChild?.remove();
          }
          expr = String(v);
          setDisplay(expr);
        } else {
          setDisplay("错误");
          expr = "";
        }
        return;
      }
      expr += k;
      setDisplay(expr);
    };
    historyEl?.addEventListener("click", (e) => {
      const item = (e.target as HTMLElement).closest<HTMLElement>(".calc-h-item");
      if (!item?.dataset.result) return;
      expr = item.dataset.result;
      setDisplay(expr);
    });
    win.querySelectorAll<HTMLButtonElement>(".calc-key").forEach((b) =>
      b.addEventListener("click", () => {
        push(b.dataset.k ?? "");
        b.blur();
      }),
    );
    // 键盘输入（事件从聚焦的后代冒泡到窗口）
    win.tabIndex = -1;
    win.addEventListener("keydown", (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const map: Record<string, string> = {
        "*": "×",
        "/": "÷",
        "-": "−",
        "+": "+",
        Enter: "=",
        "=": "=",
        Backspace: "DEL",
        Escape: "C",
      };
      if (/^[0-9.()%^]$/.test(e.key)) {
        e.preventDefault();
        push(e.key);
      } else if (map[e.key]) {
        e.preventDefault();
        push(map[e.key]);
      }
    });
  },
};