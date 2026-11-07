/**
 * 计算器（calc）· 对应 index.astro 原 `renderCalc` / `initCalc`。
 *
 * 无外部依赖、无持久化。键盘监听挂在窗口元素上，
 * 窗口移除后随 DOM 一起回收，因此无需 cleanup。
 */
import type { LegacyAppModule } from "../types";

export const calculatorApp: LegacyAppModule = {
  id: "calc",
  title: "计算器",
  width: 300,
  height: 470,
  glyph: "di-calc",
  body: () => `
          <div class="calc">
            <div class="calc-display" id="calc-display">0</div>
            <div class="calc-history" id="calc-history"></div>
            <div class="calc-pad">
              ${[
                ["C", "(", ")", "÷"],
                ["7", "8", "9", "×"],
                ["4", "5", "6", "−"],
                ["1", "2", "3", "+"],
                ["0", ".", "%", "="],
              ]
                .map((row) =>
                  row
                    .map((k) => `<button class="calc-key ${"÷×−+=".includes(k) ? "is-op" : ""} ${k === "C" ? "is-clear" : ""}" data-k="${k}">${k}</button>`)
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
    const evaluate = (s: string) => {
      const clean = s.replace(/×/g, "*").replace(/−/g, "-").replace(/÷/g, "/").replace(/%/g, "/100");
      if (!/^[\d+\-*/.() ]+$/.test(clean)) return null;
      try {
        const v = Function('"use strict";return(' + clean + ")")();
        return typeof v === "number" && isFinite(v) ? v : null;
      } catch {
        return null;
      }
    };
    const push = (k: string) => {
      if (k === "C") {
        expr = "";
        setDisplay("0");
        return;
      }
      if (k === "=") {
        const v = evaluate(expr);
        if (v !== null) {
          if (historyEl) {
            const li = document.createElement("div");
            li.className = "calc-h-item";
            li.textContent = `${expr} = ${v}`;
            historyEl.prepend(li);
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
    win.querySelectorAll<HTMLButtonElement>(".calc-key").forEach((b) => b.addEventListener("click", () => push(b.dataset.k ?? "")));
    // 键盘输入（事件从聚焦的后代冒泡到窗口）
    win.tabIndex = -1;
    win.addEventListener("keydown", (e) => {
      const map: Record<string, string> = { "*": "×", "/": "÷", "-": "−", "+": "+", Enter: "=", "=": "=", Backspace: "C" };
      if (/^[0-9.()%]$/.test(e.key)) push(e.key);
      else if (map[e.key]) {
        e.preventDefault();
        push(map[e.key]);
      }
    });
  },
};