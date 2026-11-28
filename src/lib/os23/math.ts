/**
 * Guandao OS 2.3 · 零 eval 纯函数算术表达式引擎
 *
 * 背景：旧版计算器使用 `new Function(...)` 求值，在线上严格 CSP（不含 'unsafe-eval'）
 * 下会被浏览器直接拦截并抛出 EvalError，导致任何算式按 `=` 都显示「错误」。
 *
 * 本模块用递归下降解析器安全计算四则运算、括号、一元正负号、百分号后缀（`50%` → `0.5`）
 * 与幂运算（`^` / `**`），并内置常用数学函数（sqrt / sin / cos / tan / abs / log / ln / round / floor / ceil）
 * 及常量（pi / π / e），供计算器、Spotlight 即时求值与终端 `calc` 命令共用。
 */

const CONSTANTS: Record<string, number> = {
  pi: Math.PI,
  π: Math.PI,
  e: Math.E,
};

const FUNCS: Record<string, (x: number) => number> = {
  sqrt: Math.sqrt,
  abs: Math.abs,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  ln: Math.log,
  log: Math.log10,
  round: Math.round,
  floor: Math.floor,
  ceil: Math.ceil,
};

type Token =
  | { kind: "num"; value: number }
  | { kind: "op"; value: "+" | "-" | "*" | "/" | "^" | "%" }
  | { kind: "paren"; value: "(" | ")" }
  | { kind: "id"; value: string };

const tokenize = (raw: string): Token[] | null => {
  const s = raw
    .replace(/×/g, "*")
    .replace(/÷/g, "/")
    .replace(/[−–—]/g, "-")
    .replace(/（/g, "(")
    .replace(/）/g, ")")
    .replace(/\*\*/g, "^")
    .trim();
  if (!s || s.length > 256) return null;

  const tokens: Token[] = [];
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (/[0-9.]/.test(ch)) {
      let j = i;
      let dots = 0;
      while (j < s.length && /[0-9.]/.test(s[j])) {
        if (s[j] === ".") dots++;
        j++;
      }
      if (dots > 1) return null;
      const numStr = s.slice(i, j);
      if (numStr === ".") return null;
      const val = Number(numStr);
      if (!Number.isFinite(val)) return null;
      tokens.push({ kind: "num", value: val });
      i = j;
      continue;
    }
    if (ch === "(" || ch === ")") {
      tokens.push({ kind: "paren", value: ch });
      i++;
      continue;
    }
    if (ch === "+" || ch === "-" || ch === "*" || ch === "/" || ch === "^" || ch === "%") {
      tokens.push({ kind: "op", value: ch });
      i++;
      continue;
    }
    if (/[A-Za-zπ]/.test(ch)) {
      let j = i;
      while (j < s.length && /[A-Za-z0-9π]/.test(s[j])) j++;
      tokens.push({ kind: "id", value: s.slice(i, j).toLowerCase() });
      i = j;
      continue;
    }
    return null;
  }
  return tokens.length ? tokens : null;
};

/**
 * 安全计算算术表达式。非法算式、除零或溢出统一返回 `null`，绝不抛错。
 */
export function evaluateMath(expr: string): number | null {
  const tokens = tokenize(expr);
  if (!tokens) return null;

  let pos = 0;
  const peek = () => tokens[pos];
  const consume = () => tokens[pos++];

  // E -> T ((+|-) T)*
  const parseExpr = (): number | null => {
    let left = parseTerm();
    if (left === null) return null;
    while (pos < tokens.length) {
      const t = peek();
      if (t?.kind === "op" && (t.value === "+" || t.value === "-")) {
        consume();
        const right = parseTerm();
        if (right === null) return null;
        left = t.value === "+" ? left + right : left - right;
      } else {
        break;
      }
    }
    return left;
  };

  // T -> P ((*|/) P)*
  const parseTerm = (): number | null => {
    let left = parsePower();
    if (left === null) return null;
    while (pos < tokens.length) {
      const t = peek();
      if (t?.kind === "op" && (t.value === "*" || t.value === "/")) {
        consume();
        const right = parsePower();
        if (right === null) return null;
        if (t.value === "/" && right === 0) return null;
        left = t.value === "*" ? left * right : left / right;
      } else {
        break;
      }
    }
    return left;
  };

  // P -> Unary (^ P)?   （右结合）
  const parsePower = (): number | null => {
    const base = parseUnary();
    if (base === null) return null;
    const t = peek();
    if (t?.kind === "op" && t.value === "^") {
      consume();
      const exp = parsePower();
      if (exp === null) return null;
      return Math.pow(base, exp);
    }
    return base;
  };

  // Unary -> (+|-)* Postfix
  const parseUnary = (): number | null => {
    const t = peek();
    if (t?.kind === "op" && (t.value === "+" || t.value === "-")) {
      consume();
      const v = parseUnary();
      if (v === null) return null;
      return t.value === "-" ? -v : v;
    }
    return parsePostfix();
  };

  // Postfix -> Primary (%)*
  const parsePostfix = (): number | null => {
    let v = parsePrimary();
    if (v === null) return null;
    while (peek()?.kind === "op" && peek()?.value === "%") {
      consume();
      v = v / 100;
    }
    return v;
  };

  // Primary -> NUMBER | CONST | FUNC '(' E ')' | '(' E ')'
  const parsePrimary = (): number | null => {
    const t = peek();
    if (!t) return null;
    if (t.kind === "num") {
      consume();
      return t.value;
    }
    if (t.kind === "paren" && t.value === "(") {
      consume();
      const inner = parseExpr();
      if (inner === null) return null;
      const close = consume();
      if (!close || close.kind !== "paren" || close.value !== ")") return null;
      return inner;
    }
    if (t.kind === "id") {
      consume();
      if (Object.prototype.hasOwnProperty.call(CONSTANTS, t.value)) {
        return CONSTANTS[t.value];
      }
      const fn = FUNCS[t.value];
      if (!fn) return null;
      const open = consume();
      if (!open || open.kind !== "paren" || open.value !== "(") return null;
      const arg = parseExpr();
      if (arg === null) return null;
      const close = consume();
      if (!close || close.kind !== "paren" || close.value !== ")") return null;
      return fn(arg);
    }
    return null;
  };

  const result = parseExpr();
  if (result === null || pos !== tokens.length || !Number.isFinite(result)) return null;
  const rounded = Number(result.toPrecision(12));
  return Object.is(rounded, -0) ? 0 : rounded;
}

/**
 * 判断用户输入是否像一条包含运算符或函数调用的算式（供 Spotlight 即时计算使用，
 * 避免纯数字如 `2026` 被当成算式刷屏）。
 */
export function isLikelyMathQuery(q: string): boolean {
  const s = q.trim();
  if (s.length < 2 || s.length > 120) return false;
  return /[+\-*/×÷−^%]|\b(sqrt|sin|cos|tan|abs|ln|log|round|floor|ceil)\s*\(/i.test(s);
}
