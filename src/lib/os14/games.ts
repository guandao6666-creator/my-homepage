/**
 * Guandao OS 1.4 · 小游戏
 *
 * 七款都能真的玩：2048、贪吃蛇、扫雷、记忆翻牌、原创方块、
 * 反应测试、数字猜谜。每款游戏在 destroy 时都会停掉自己的循环，
 * 关闭窗口后不会留下后台任务。
 */

import { clamp, escapeHtml } from "./core";

export type GameApi = {
  setScore: (score: number, label?: string) => void;
  setStatus: (text: string) => void;
  gameOver: (score: number, extra?: Record<string, unknown>) => void;
};

export type GameHandle = {
  destroy: () => void;
  pause?: () => void;
  resume?: () => void;
};

export type GameDef = {
  id: string;
  title: string;
  desc: string;
  hint: string;
  scoreLabel: string;
  lowerBetter?: boolean;
  ico: string;
  tint: string;
  /** 隐藏游戏：不在游戏中心列表里出现，只能通过彩蛋进入 */
  hidden?: boolean;
  mount: (root: HTMLElement, api: GameApi) => GameHandle;
};

const key = (s: string) => s;

/* ============================================================
   2048
   ============================================================ */

const g2048: GameDef = {
  id: "g2048",
  title: "2048",
  desc: "合并相同数字，凑出 2048",
  hint: "方向键 / WASD 移动，触屏可以直接滑动",
  scoreLabel: "分数",
  ico: "⧉",
  tint: "#e8b25c",
  mount: (root, api) => {
    const N = 4;
    let board: number[] = Array(N * N).fill(0);
    let score = 0;
    let over = false;
    let paused = false;

    root.innerHTML = `
      <div class="gm gm-2048">
        <div class="gm2048-board" data-board></div>
        <div class="gm-overlay" data-over hidden><div><b data-over-title>游戏结束</b><p data-over-sub></p><button class="g14-btn is-primary" data-over-again>再来一局</button></div></div>
        <p class="gm-tip">方向键 / WASD · 手机可滑动</p>
      </div>`;
    const boardEl = root.querySelector<HTMLElement>("[data-board]");
    const overEl = root.querySelector<HTMLElement>("[data-over]");

    const empty = () => board.map((v, i) => (v === 0 ? i : -1)).filter((i) => i >= 0);
    const add = () => {
      const cells = empty();
      if (!cells.length) return;
      board[cells[Math.floor(Math.random() * cells.length)]] = Math.random() < 0.9 ? 2 : 4;
    };

    const paint = () => {
      if (!boardEl) return;
      boardEl.innerHTML = board
        .map((v) => `<span class="gm2048-tile" data-v="${v}">${v ? v : ""}</span>`)
        .join("");
    };

    const canMove = () => {
      if (empty().length) return true;
      for (let r = 0; r < N; r++) {
        for (let c = 0; c < N; c++) {
          const v = board[r * N + c];
          if (c + 1 < N && board[r * N + c + 1] === v) return true;
          if (r + 1 < N && board[(r + 1) * N + c] === v) return true;
        }
      }
      return false;
    };

    const move = (dir: "l" | "r" | "u" | "d") => {
      if (over || paused) return;
      const before = board.join(",");
      const line = (idx: number[]) => {
        const vals = idx.map((i) => board[i]).filter((v) => v);
        const out: number[] = [];
        for (let i = 0; i < vals.length; i++) {
          if (i + 1 < vals.length && vals[i] === vals[i + 1]) {
            const merged = vals[i] * 2;
            out.push(merged);
            score += merged;
            i++;
          } else out.push(vals[i]);
        }
        while (out.length < N) out.push(0);
        idx.forEach((i, k) => (board[i] = out[k]));
      };
      if (dir === "l") for (let r = 0; r < N; r++) line([0, 1, 2, 3].map((c) => r * N + c));
      if (dir === "r") for (let r = 0; r < N; r++) line([3, 2, 1, 0].map((c) => r * N + c));
      if (dir === "u") for (let c = 0; c < N; c++) line([0, 1, 2, 3].map((r) => r * N + c));
      if (dir === "d") for (let c = 0; c < N; c++) line([3, 2, 1, 0].map((r) => r * N + c));
      if (board.join(",") === before) return;
      add();
      paint();
      api.setScore(score);
      if (!canMove()) {
        over = true;
        api.gameOver(score);
        if (overEl) {
          overEl.hidden = false;
          const title = overEl.querySelector("[data-over-title]");
          const sub = overEl.querySelector("[data-over-sub]");
          if (title) title.textContent = "没有可移动的方向了";
          if (sub) sub.textContent = `本局 ${score} 分`;
        }
      }
    };

    const onKey = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      const map: Record<string, "l" | "r" | "u" | "d"> = {
        arrowleft: "l",
        a: "l",
        arrowright: "r",
        d: "r",
        arrowup: "u",
        w: "u",
        arrowdown: "d",
        s: "d",
      };
      if (k === "p") {
        paused = !paused;
        return;
      }
      const dir = map[k];
      if (!dir) return;
      e.preventDefault();
      move(dir);
    };

    let sx = 0;
    let sy = 0;
    const onDown = (e: PointerEvent) => {
      sx = e.clientX;
      sy = e.clientY;
    };
    const onUp = (e: PointerEvent) => {
      const dx = e.clientX - sx;
      const dy = e.clientY - sy;
      if (Math.abs(dx) < 24 && Math.abs(dy) < 24) return;
      if (Math.abs(dx) > Math.abs(dy)) move(dx > 0 ? "r" : "l");
      else move(dy > 0 ? "d" : "u");
    };

    root.tabIndex = 0;
    root.addEventListener("keydown", onKey);
    root.addEventListener("pointerdown", onDown);
    root.addEventListener("pointerup", onUp);
    root.querySelector("[data-over-again]")?.addEventListener("click", () => {
      board = Array(N * N).fill(0);
      score = 0;
      over = false;
      if (overEl) overEl.hidden = true;
      add();
      add();
      paint();
      api.setScore(0);
      api.setStatus("");
    });

    add();
    add();
    paint();
    api.setScore(0);
    window.setTimeout(() => root.focus(), 30);

    return {
      destroy: () => {
        root.removeEventListener("keydown", onKey);
        root.removeEventListener("pointerdown", onDown);
        root.removeEventListener("pointerup", onUp);
      },
      pause: () => {
        paused = true;
      },
      resume: () => {
        paused = false;
      },
    };
  },
};

/* ============================================================
   贪吃蛇
   ============================================================ */

const snakeGame: GameDef = {
  id: "snake",
  title: "贪吃蛇",
  desc: "吃掉光点，别撞墙也别咬到自己",
  hint: "方向键 / WASD 转向，空格暂停",
  scoreLabel: "长度",
  ico: "◉",
  tint: "#5ecf9a",
  mount: (root, api) => {
    root.innerHTML = `
      <div class="gm gm-snake">
        <canvas class="gm-canvas" data-canvas width="360" height="360"></canvas>
        <p class="gm-tip">方向键 / WASD · 空格暂停 · 撞墙或咬到自己结束</p>
      </div>`;
    const canvas = root.querySelector<HTMLCanvasElement>("[data-canvas]")!;
    const ctx = canvas.getContext("2d")!;
    const CELL = 18;
    const COLS = 20;
    const ROWS = 20;
    let snake = [
      { x: 9, y: 10 },
      { x: 8, y: 10 },
      { x: 7, y: 10 },
    ];
    let dir = { x: 1, y: 0 };
    let nextDir = { x: 1, y: 0 };
    let food = { x: 14, y: 10 };
    let score = 0;
    let dead = false;
    let paused = false;
    let timer = 0;

    const placeFood = () => {
      do {
        food = { x: Math.floor(Math.random() * COLS), y: Math.floor(Math.random() * ROWS) };
      } while (snake.some((s) => s.x === food.x && s.y === food.y));
    };
    placeFood();

    const draw = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "rgba(255,255,255,.035)";
      for (let y = 0; y < ROWS; y++) {
        for (let x = 0; x < COLS; x++) {
          if ((x + y) % 2 === 0) ctx.fillRect(x * CELL, y * CELL, CELL, CELL);
        }
      }
      const grd = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
      grd.addColorStop(0, "#6ee7a8");
      grd.addColorStop(1, "#38bdf8");
      ctx.fillStyle = grd;
      for (const s of snake) {
        ctx.beginPath();
        ctx.roundRect(s.x * CELL + 1.5, s.y * CELL + 1.5, CELL - 3, CELL - 3, 4);
        ctx.fill();
      }
      ctx.fillStyle = "#ffd479";
      ctx.beginPath();
      ctx.arc(food.x * CELL + CELL / 2, food.y * CELL + CELL / 2, CELL / 2 - 2, 0, Math.PI * 2);
      ctx.fill();
    };

    const tick = () => {
      if (dead || paused) return;
      dir = nextDir;
      const head = { x: snake[0].x + dir.x, y: snake[0].y + dir.y };
      if (head.x < 0 || head.y < 0 || head.x >= COLS || head.y >= ROWS || snake.some((s) => s.x === head.x && s.y === head.y)) {
        dead = true;
        api.gameOver(score);
        api.setStatus("撞到了，游戏结束");
        return;
      }
      snake.unshift(head);
      if (head.x === food.x && head.y === food.y) {
        score += 1;
        api.setScore(score);
        placeFood();
        window.clearInterval(timer);
        timer = window.setInterval(tick, Math.max(70, 140 - score * 3));
      } else {
        snake.pop();
      }
      draw();
    };

    const onKey = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (k === " ") {
        e.preventDefault();
        paused = !paused;
        api.setStatus(paused ? "已暂停" : "");
        return;
      }
      const map: Record<string, { x: number; y: number }> = {
        arrowup: { x: 0, y: -1 },
        w: { x: 0, y: -1 },
        arrowdown: { x: 0, y: 1 },
        s: { x: 0, y: 1 },
        arrowleft: { x: -1, y: 0 },
        a: { x: -1, y: 0 },
        arrowright: { x: 1, y: 0 },
        d: { x: 1, y: 0 },
      };
      const nd = map[k];
      if (!nd) return;
      e.preventDefault();
      if (nd.x === -dir.x && nd.y === -dir.y) return;
      nextDir = nd;
    };

    let sx = 0;
    let sy = 0;
    const onDown = (e: PointerEvent) => {
      sx = e.clientX;
      sy = e.clientY;
    };
    const onUp = (e: PointerEvent) => {
      const dx = e.clientX - sx;
      const dy = e.clientY - sy;
      if (Math.abs(dx) < 20 && Math.abs(dy) < 20) return;
      const nd = Math.abs(dx) > Math.abs(dy) ? { x: Math.sign(dx), y: 0 } : { x: 0, y: Math.sign(dy) };
      if (nd.x === -dir.x && nd.y === -dir.y) return;
      nextDir = nd;
    };

    root.tabIndex = 0;
    root.addEventListener("keydown", onKey);
    root.addEventListener("pointerdown", onDown);
    root.addEventListener("pointerup", onUp);
    draw();
    timer = window.setInterval(tick, 140);
    window.setTimeout(() => root.focus(), 30);
    api.setScore(0);

    return {
      destroy: () => {
        window.clearInterval(timer);
        root.removeEventListener("keydown", onKey);
        root.removeEventListener("pointerdown", onDown);
        root.removeEventListener("pointerup", onUp);
      },
      pause: () => {
        paused = true;
      },
      resume: () => {
        paused = false;
      },
    };
  },
};

/* ============================================================
   扫雷
   ============================================================ */

const mineGame: GameDef = {
  id: "minesweeper",
  title: "扫雷",
  desc: "根据数字推断地雷位置",
  hint: "左键翻开，右键 / 长按插旗",
  scoreLabel: "用时（秒）",
  lowerBetter: true,
  ico: "✹",
  tint: "#ff8f8f",
  mount: (root, api) => {
    const levels = {
      easy: { n: 9, mines: 10, label: "9×9 · 10 雷" },
      mid: { n: 12, mines: 24, label: "12×12 · 24 雷" },
      hard: { n: 16, mines: 40, label: "16×16 · 40 雷" },
    } as const;
    type LevelKey = keyof typeof levels;
    let level: LevelKey = "easy";
    let n: number = levels[level].n;
    let mines: number = levels[level].mines;
    let cells: Array<{ mine: boolean; open: boolean; flag: boolean; near: number }> = [];
    let started = false;
    let dead = false;
    let won = false;
    let flags = 0;
    let seconds = 0;
    let timer = 0;

    root.innerHTML = `
      <div class="gm gm-mine">
        <div class="gm-mine-top">
          <div class="gm-seg" data-levels>
            ${(Object.keys(levels) as LevelKey[]).map((k) => `<button type="button" data-level="${k}" class="${k === level ? "is-active" : ""}">${levels[k].label}</button>`).join("")}
          </div>
          <span class="gm-mine-stat">💣 <b data-left>${mines}</b> · ⏱ <b data-time>0</b>s</span>
          <button class="g14-btn" type="button" data-reset>重开</button>
        </div>
        <div class="gm-mine-grid" data-grid></div>
        <p class="gm-tip">第一次点击一定不会踩雷。右键或长按插旗。</p>
      </div>`;
    const gridEl = root.querySelector<HTMLElement>("[data-grid]")!;
    const leftEl = root.querySelector<HTMLElement>("[data-left]")!;
    const timeEl = root.querySelector<HTMLElement>("[data-time]")!;

    const reset = (next?: LevelKey) => {
      if (next) level = next;
      n = levels[level].n;
      mines = levels[level].mines;
      cells = Array.from({ length: n * n }, () => ({ mine: false, open: false, flag: false, near: 0 }));
      started = false;
      dead = false;
      won = false;
      flags = 0;
      seconds = 0;
      leftEl.textContent = String(mines);
      timeEl.textContent = "0";
      window.clearInterval(timer);
      api.setScore(0, "用时");
      api.setStatus("");
      paint();
    };

    const plant = (safeIndex: number) => {
      const forbidden = new Set<number>([safeIndex]);
      const r0 = Math.floor(safeIndex / n);
      const c0 = safeIndex % n;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const r = r0 + dr;
          const c = c0 + dc;
          if (r >= 0 && r < n && c >= 0 && c < n) forbidden.add(r * n + c);
        }
      }
      let placed = 0;
      while (placed < mines) {
        const i = Math.floor(Math.random() * n * n);
        if (forbidden.has(i) || cells[i].mine) continue;
        cells[i].mine = true;
        placed++;
      }
      for (let i = 0; i < n * n; i++) {
        const r = Math.floor(i / n);
        const c = i % n;
        let near = 0;
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            if (!dr && !dc) continue;
            const rr = r + dr;
            const cc = c + dc;
            if (rr >= 0 && rr < n && cc >= 0 && cc < n && cells[rr * n + cc].mine) near++;
          }
        }
        cells[i].near = near;
      }
    };

    const reveal = (i: number) => {
      const stack = [i];
      while (stack.length) {
        const cur = stack.pop()!;
        const cell = cells[cur];
        if (!cell || cell.open || cell.flag) continue;
        cell.open = true;
        if (cell.mine) {
          dead = true;
          api.gameOver(seconds);
          api.setStatus("踩到雷了");
          window.clearInterval(timer);
          paint();
          return;
        }
        if (cell.near === 0) {
          const r = Math.floor(cur / n);
          const c = cur % n;
          for (let dr = -1; dr <= 1; dr++) {
            for (let dc = -1; dc <= 1; dc++) {
              const rr = r + dr;
              const cc = c + dc;
              if (rr >= 0 && rr < n && cc >= 0 && cc < n) stack.push(rr * n + cc);
            }
          }
        }
      }
    };

    const checkWin = () => {
      const opened = cells.filter((c) => c.open).length;
      if (opened === n * n - mines && !dead) {
        won = true;
        window.clearInterval(timer);
        api.setScore(seconds, "用时");
        api.gameOver(seconds);
        api.setStatus("全部排完，赢了");
        paint();
      }
    };

    const paint = () => {
      gridEl.style.gridTemplateColumns = `repeat(${n}, 1fr)`;
      gridEl.innerHTML = cells
        .map((c, i) => {
          if (c.open) {
            if (c.mine) return `<button class="gm-cell is-mine" type="button" data-i="${i}">✹</button>`;
            return `<button class="gm-cell is-open" type="button" data-i="${i}" data-n="${c.near}">${c.near || ""}</button>`;
          }
          return `<button class="gm-cell ${c.flag ? "is-flag" : ""}" type="button" data-i="${i}">${c.flag ? "⚑" : ""}</button>`;
        })
        .join("");
      leftEl.textContent = String(Math.max(0, mines - flags));
    };

    const onOpen = (i: number) => {
      if (dead || won) return;
      if (!started) {
        started = true;
        plant(i);
        timer = window.setInterval(() => {
          seconds++;
          timeEl.textContent = String(seconds);
          api.setScore(seconds, "用时");
        }, 1000);
      }
      const cell = cells[i];
      if (!cell || cell.flag || cell.open) return;
      reveal(i);
      paint();
      checkWin();
    };

    const toggleFlag = (i: number) => {
      if (dead || won || !cells[i] || cells[i].open) return;
      cells[i].flag = !cells[i].flag;
      flags += cells[i].flag ? 1 : -1;
      paint();
    };

    let longTimer = 0;
    const onDown = (e: PointerEvent) => {
      const cell = (e.target as HTMLElement).closest<HTMLElement>("[data-i]");
      if (!cell) return;
      const i = Number(cell.dataset.i);
      if (e.pointerType === "touch") {
        longTimer = window.setTimeout(() => toggleFlag(i), 420);
      }
    };
    const onUp = (e: PointerEvent) => {
      if (e.pointerType === "touch") window.clearTimeout(longTimer);
    };

    gridEl.addEventListener("click", (e) => {
      const cell = (e.target as HTMLElement).closest<HTMLElement>("[data-i]");
      if (!cell) return;
      onOpen(Number(cell.dataset.i));
    });
    gridEl.addEventListener("contextmenu", (e) => {
      const cell = (e.target as HTMLElement).closest<HTMLElement>("[data-i]");
      if (!cell) return;
      e.preventDefault();
      toggleFlag(Number(cell.dataset.i));
    });
    gridEl.addEventListener("pointerdown", onDown);
    gridEl.addEventListener("pointerup", onUp);
    root.addEventListener("click", (e) => {
      const lv = (e.target as HTMLElement).closest<HTMLElement>("[data-level]");
      if (lv) {
        root.querySelectorAll("[data-level]").forEach((b) => b.classList.toggle("is-active", b === lv));
        reset(lv.dataset.level as LevelKey);
        return;
      }
      if ((e.target as HTMLElement).closest("[data-reset]")) reset();
    });

    reset();
    return {
      destroy: () => {
        window.clearInterval(timer);
        window.clearTimeout(longTimer);
        gridEl.removeEventListener("pointerdown", onDown);
        gridEl.removeEventListener("pointerup", onUp);
      },
      pause: () => window.clearInterval(timer),
      resume: () => {
        if (!started || dead || won) return;
        window.clearInterval(timer);
        timer = window.setInterval(() => {
          seconds++;
          timeEl.textContent = String(seconds);
          api.setScore(seconds, "用时");
        }, 1000);
      },
    };
  },
};

/* ============================================================
   记忆翻牌
   ============================================================ */

const memoryGame: GameDef = {
  id: "memory",
  title: "记忆翻牌",
  desc: "翻开两张一样的牌，用最少的步数配对",
  hint: "点击翻牌，全部配对即结束",
  scoreLabel: "步数",
  lowerBetter: true,
  ico: "▤",
  tint: "#b06eff",
  mount: (root, api) => {
    const icons = ["◆", "●", "▲", "■", "★", "✦", "❖", "✿"];
    let deck: Array<{ id: number; icon: string; open: boolean; done: boolean }> = [];
    let first = -1;
    let moves = 0;
    let lock = false;
    let won = false;
    let seconds = 0;
    let timer = 0;

    root.innerHTML = `
      <div class="gm gm-mem">
        <div class="gm-mem-top"><span class="gm-mine-stat">步数 <b data-moves>0</b> · ⏱ <b data-time>0</b>s</span><button class="g14-btn" type="button" data-reset>重新发牌</button></div>
        <div class="gm-mem-grid" data-cards></div>
        <p class="gm-tip">配对成功会保持翻开。</p>
      </div>`;
    const cardsEl = root.querySelector<HTMLElement>("[data-cards]")!;
    const movesEl = root.querySelector<HTMLElement>("[data-moves]")!;
    const timeEl = root.querySelector<HTMLElement>("[data-time]")!;

    const deal = () => {
      deck = [...icons, ...icons]
        .map((icon, i) => ({ id: i, icon, open: false, done: false }))
        .sort(() => Math.random() - 0.5);
      first = -1;
      moves = 0;
      lock = false;
      won = false;
      seconds = 0;
      window.clearInterval(timer);
      timer = window.setInterval(() => {
        seconds++;
        timeEl.textContent = String(seconds);
      }, 1000);
      movesEl.textContent = "0";
      api.setScore(0, "步数");
      paint();
    };

    const paint = () => {
      cardsEl.innerHTML = deck
        .map(
          (c, i) => `<button class="gm-card ${c.open || c.done ? "is-open" : ""} ${c.done ? "is-done" : ""}" type="button" data-c="${i}">
            <span class="gm-card-back">管</span><span class="gm-card-face">${c.icon}</span>
          </button>`,
        )
        .join("");
    };

    const flip = (i: number) => {
      if (lock || won) return;
      const card = deck[i];
      if (!card || card.open || card.done) return;
      card.open = true;
      paint();
      if (first < 0) {
        first = i;
        return;
      }
      moves++;
      movesEl.textContent = String(moves);
      const a = deck[first];
      const b = card;
      if (a.icon === b.icon) {
        a.done = true;
        b.done = true;
        first = -1;
        api.setScore(moves, "步数");
        paint();
        if (deck.every((c) => c.done)) {
          won = true;
          window.clearInterval(timer);
          api.gameOver(moves, { seconds });
          api.setStatus("全部配对完成");
        }
      } else {
        lock = true;
        const prev = first;
        first = -1;
        window.setTimeout(() => {
          deck[prev].open = false;
          b.open = false;
          lock = false;
          paint();
        }, 620);
      }
    };

    root.addEventListener("click", (e) => {
      const t = e.target as HTMLElement;
      if (t.closest("[data-reset]")) {
        deal();
        return;
      }
      const c = t.closest<HTMLElement>("[data-c]");
      if (c) flip(Number(c.dataset.c));
    });

    deal();
    return {
      destroy: () => window.clearInterval(timer),
      pause: () => {
        lock = true;
        window.clearInterval(timer);
      },
      resume: () => {
        lock = false;
        window.clearInterval(timer);
        timer = window.setInterval(() => {
          seconds++;
          timeEl.textContent = String(seconds);
        }, 1000);
      },
    };
  },
};

/* ============================================================
   原创方块
   ============================================================ */

const blocksGame: GameDef = {
  id: "blocks",
  title: "方块坠落",
  desc: "原创六种碎块，消行得分",
  hint: "← → 移动，↑ 旋转，↓ 加速，空格直落",
  scoreLabel: "分数",
  ico: "▥",
  tint: "#38bdf8",
  mount: (root, api) => {
    const COLS = 10;
    const ROWS = 18;
    const CELL = 22;
    const shapes: number[][][] = [
      [[1, 1, 1]],
      [[1, 1], [1, 1]],
      [[0, 1, 1], [1, 1, 0]],
      [[1, 1, 0], [0, 1, 1]],
      [[1, 1, 1], [0, 1, 0]],
      [[1, 0, 0], [1, 1, 1]],
      // 原创的五格十字块，传统方块游戏里没有这一块
      [[0, 1, 0], [1, 1, 1], [0, 1, 0]],
    ];
    const colors = ["#38bdf8", "#b06eff", "#5ecf9a", "#ffd479", "#ff8f8f", "#8ea0bf", "#c084fc"];

    root.innerHTML = `
      <div class="gm gm-blocks">
        <canvas class="gm-canvas" data-canvas width="${COLS * CELL}" height="${ROWS * CELL}"></canvas>
        <p class="gm-tip">← → 移动 · ↑ 旋转 · ↓ 加速 · 空格直落</p>
      </div>`;
    const canvas = root.querySelector<HTMLCanvasElement>("[data-canvas]")!;
    const ctx = canvas.getContext("2d")!;
    let grid: number[][] = Array.from({ length: ROWS }, () => Array(COLS).fill(0));
    let piece: { shape: number[][]; x: number; y: number; color: number } | null = null;
    let score = 0;
    let level = 1;
    let pause = false;
    let dead = false;
    let timer = 0;

    const spawn = () => {
      const idx = Math.floor(Math.random() * shapes.length);
      const shape = shapes[idx].map((r) => r.slice());
      piece = { shape, x: Math.floor((COLS - shape[0].length) / 2), y: 0, color: idx };
      if (collide(piece.x, piece.y, shape)) {
        dead = true;
        window.clearInterval(timer);
        api.gameOver(score);
        api.setStatus("堆到顶了");
      }
    };

    const collide = (px: number, py: number, shape: number[][]) => {
      for (let r = 0; r < shape.length; r++) {
        for (let c = 0; c < shape[r].length; c++) {
          if (!shape[r][c]) continue;
          const x = px + c;
          const y = py + r;
          if (x < 0 || x >= COLS || y >= ROWS) return true;
          if (y >= 0 && grid[y][x]) return true;
        }
      }
      return false;
    };

    const merge = () => {
      if (!piece) return;
      piece.shape.forEach((row, r) =>
        row.forEach((v, c) => {
          if (v && piece) grid[piece.y + r][piece.x + c] = piece.color + 1;
        }),
      );
      let cleared = 0;
      for (let r = ROWS - 1; r >= 0; r--) {
        if (grid[r].every((v) => v)) {
          grid.splice(r, 1);
          grid.unshift(Array(COLS).fill(0));
          cleared++;
          r++;
        }
      }
      if (cleared) {
        score += cleared * 100 * level;
        level = 1 + Math.floor(score / 800);
        api.setScore(score);
        window.clearInterval(timer);
        timer = window.setInterval(down, Math.max(220, 620 - level * 55));
      }
      spawn();
      draw();
    };

    const down = () => {
      if (!piece || pause || dead) return;
      if (!collide(piece.x, piece.y + 1, piece.shape)) piece.y++;
      else merge();
      draw();
    };

    const rotate = () => {
      if (!piece || pause) return;
      const shape = piece.shape[0].map((_, i) => piece!.shape.map((r) => r[i]).reverse());
      if (!collide(piece.x, piece.y, shape)) piece.shape = shape;
      draw();
    };

    const move = (dx: number) => {
      if (!piece || pause) return;
      if (!collide(piece.x + dx, piece.y, piece.shape)) piece.x += dx;
      draw();
    };

    const slam = () => {
      if (!piece || pause) return;
      while (!collide(piece.x, piece.y + 1, piece.shape)) piece.y++;
      merge();
    };

    const draw = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "rgba(255,255,255,.03)";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      const cell = (x: number, y: number, color: string) => {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.roundRect(x * CELL + 1, y * CELL + 1, CELL - 2, CELL - 2, 3);
        ctx.fill();
      };
      for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
          if (grid[r][c]) cell(c, r, colors[(grid[r][c] - 1) % colors.length]);
        }
      }
      if (piece) {
        piece.shape.forEach((row, r) =>
          row.forEach((v, c) => {
            if (v && piece) cell(piece.x + c, piece.y + r, colors[piece.color]);
          }),
        );
      }
      ctx.strokeStyle = "rgba(255,255,255,.10)";
      ctx.strokeRect(0.5, 0.5, canvas.width - 1, canvas.height - 1);
    };

    const onKey = (e: KeyboardEvent) => {
      if (dead) return;
      const k = e.key.toLowerCase();
      if (["arrowleft", "arrowright", "arrowup", "arrowdown", " ", "a", "d", "w", "s"].includes(k)) e.preventDefault();
      if (k === "arrowleft" || k === "a") move(-1);
      if (k === "arrowright" || k === "d") move(1);
      if (k === "arrowup" || k === "w") rotate();
      if (k === "arrowdown" || k === "s") down();
      if (k === " ") slam();
    };

    root.tabIndex = 0;
    root.addEventListener("keydown", onKey);
    window.setTimeout(() => root.focus(), 30);
    spawn();
    draw();
    api.setScore(0);
    timer = window.setInterval(down, 620);

    return {
      destroy: () => {
        window.clearInterval(timer);
        root.removeEventListener("keydown", onKey);
      },
      pause: () => {
        pause = true;
        window.clearInterval(timer);
      },
      resume: () => {
        pause = false;
        timer = window.setInterval(down, Math.max(220, 620 - level * 55));
      },
    };
  },
};

/* ============================================================
   反应测试
   ============================================================ */

const reactionGame: GameDef = {
  id: "reaction",
  title: "反应速度",
  desc: "变绿的瞬间点击，测五次平均",
  hint: "等它变绿再点，抢跑会作废这一轮",
  scoreLabel: "平均毫秒",
  lowerBetter: true,
  ico: "⚡",
  tint: "#ffd479",
  mount: (root, api) => {
    let round = 0;
    let results: number[] = [];
    let state: "idle" | "wait" | "go" | "tooEarly" | "done" = "idle";
    let startAt = 0;
    let timer = 0;

    root.innerHTML = `
      <div class="gm gm-react">
        <button class="gm-react-pad" type="button" data-pad>
          <b data-main>准备好了就点击开始</b>
          <span data-sub>共 5 轮，记录平均反应时间</span>
        </button>
        <div class="gm-react-log" data-log></div>
        <p class="gm-tip">最好成绩取平均毫秒，越低越好。</p>
      </div>`;
    const pad = root.querySelector<HTMLElement>("[data-pad]")!;
    const main = root.querySelector<HTMLElement>("[data-main]")!;
    const sub = root.querySelector<HTMLElement>("[data-sub]")!;
    const log = root.querySelector<HTMLElement>("[data-log]")!;

    const paintLog = () => {
      log.innerHTML = results.map((r, i) => `<span>第 ${i + 1} 轮 <b>${r}</b> ms</span>`).join("");
    };

    const nextRound = () => {
      round++;
      state = "wait";
      pad.dataset.state = "wait";
      main.textContent = "等绿色…";
      sub.textContent = `第 ${round} / 5 轮`;
      const wait = 900 + Math.random() * 2200;
      timer = window.setTimeout(() => {
        if (state !== "wait") return;
        state = "go";
        pad.dataset.state = "go";
        startAt = performance.now();
        main.textContent = "现在点！";
        sub.textContent = "越快越好";
      }, wait);
    };

    const press = () => {
      if (state === "idle" || state === "done") {
        results = [];
        round = 0;
        paintLog();
        api.setScore(0);
        nextRound();
        return;
      }
      if (state === "wait") {
        window.clearTimeout(timer);
        state = "tooEarly";
        pad.dataset.state = "early";
        main.textContent = "太早了";
        sub.textContent = "这一轮作废，点一下重来";
        window.setTimeout(() => {
          if (state === "tooEarly") {
            main.textContent = "点击继续";
            sub.textContent = `第 ${round} / 5 轮`;
            state = "idle";
            pad.dataset.state = "";
          }
        }, 700);
        return;
      }
      if (state === "go") {
        const ms = Math.round(performance.now() - startAt);
        results.push(ms);
        paintLog();
        if (results.length >= 5) {
          state = "done";
          const avg = Math.round(results.reduce((a, b) => a + b, 0) / results.length);
          pad.dataset.state = "done";
          main.textContent = `${avg} ms`;
          sub.textContent = "点一下再来五轮";
          api.setScore(avg, "平均毫秒");
          api.gameOver(avg);
        } else {
          api.setScore(ms, "本次毫秒");
          state = "idle";
          nextRound();
        }
      }
    };

    pad.addEventListener("click", press);
    return {
      destroy: () => window.clearTimeout(timer),
    };
  },
};

/* ============================================================
   数字猜谜
   ============================================================ */

const guessGame: GameDef = {
  id: "guess",
  title: "数字猜谜",
  desc: "1–100 之间，看你能不能少猜几次",
  hint: "每次会给「大了 / 小了」",
  scoreLabel: "次数",
  lowerBetter: true,
  ico: "?",
  tint: "#5ecf9a",
  mount: (root, api) => {
    let target = Math.floor(Math.random() * 100) + 1;
    let tries = 0;
    let done = false;

    root.innerHTML = `
      <div class="gm gm-guess">
        <p class="gm-guess-hint" data-hint>我想好了一个 1–100 的数字，开始猜吧。</p>
        <div class="gm-guess-input">
          <input class="g14-input" type="number" min="1" max="100" data-input placeholder="输入一个数字" />
          <button class="g14-btn is-primary" type="button" data-go>猜</button>
        </div>
        <div class="gm-guess-tries" data-tries></div>
        <button class="g14-btn is-ghost" type="button" data-reset>换一个数字</button>
        <p class="gm-tip">用的次数越少越好。</p>
      </div>`;
    const input = root.querySelector<HTMLInputElement>("[data-input]")!;
    const hint = root.querySelector<HTMLElement>("[data-hint]")!;
    const triesEl = root.querySelector<HTMLElement>("[data-tries]")!;

    const reset = () => {
      target = Math.floor(Math.random() * 100) + 1;
      tries = 0;
      done = false;
      triesEl.innerHTML = "";
      hint.textContent = "我想好了一个 1–100 的数字，开始猜吧。";
      input.value = "";
      api.setScore(0, "次数");
      api.setStatus("");
      input.focus();
    };

    const guess = () => {
      if (done) return;
      const v = Number(input.value);
      if (!Number.isInteger(v) || v < 1 || v > 100) {
        hint.textContent = "输入 1 到 100 之间的整数。";
        return;
      }
      tries++;
      const chip = document.createElement("span");
      chip.className = `gm-guess-chip ${v === target ? "is-ok" : v > target ? "is-high" : "is-low"}`;
      chip.textContent = `${v}${v === target ? " ✓" : v > target ? " 大了" : " 小了"}`;
      triesEl.appendChild(chip);
      api.setScore(tries, "次数");
      if (v === target) {
        done = true;
        hint.textContent = `就是 ${target}，你用了 ${tries} 次。`;
        api.gameOver(tries);
        return;
      }
      if (tries >= 8) {
        done = true;
        hint.textContent = `答案是 ${target}。8 次还没猜中，再来一局吧。`;
        api.gameOver(8);
        return;
      }
      hint.textContent = v > target ? "大了，往小一点猜。" : "小了，往大一点猜。";
      input.value = "";
      input.focus();
    };

    root.addEventListener("click", (e) => {
      const t = e.target as HTMLElement;
      if (t.closest("[data-go]")) guess();
      if (t.closest("[data-reset]")) reset();
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") guess();
    });
    window.setTimeout(() => input.focus(), 40);
    return { destroy: () => undefined };
  },
};

const emberGame: GameDef = {
  id: "ember",
  title: "余烬",
  desc: "20 秒内点掉所有亮起的余烬",
  hint: "这是藏在桌面里的第八个游戏",
  scoreLabel: "点中次数",
  ico: "✧",
  tint: "#ffb26a",
  hidden: true,
  mount: (root, api) => {
    let left = 20;
    let hits = 0;
    let misses = 0;
    let timer = 0;
    let spawner = 0;
    let ended = false;

    root.innerHTML = `
      <div class="gm gm-ember">
        <div class="gm-ember-top"><span>剩余 <b data-left>20</b>s</span><span>命中 <b data-hit>0</b></span><span>落空 <b data-miss>0</b></span></div>
        <div class="gm-ember-stage" data-stage></div>
        <p class="gm-tip">点亮起来的圆点，20 秒后结算。</p>
      </div>`;
    const stage = root.querySelector<HTMLElement>("[data-stage]")!;
    const leftEl = root.querySelector<HTMLElement>("[data-left]")!;
    const hitEl = root.querySelector<HTMLElement>("[data-hit]")!;
    const missEl = root.querySelector<HTMLElement>("[data-miss]")!;

    const spawn = () => {
      if (ended) return;
      const dot = document.createElement("button");
      dot.type = "button";
      dot.className = "gm-ember-dot";
      dot.style.left = `${8 + Math.random() * 84}%`;
      dot.style.top = `${8 + Math.random() * 76}%`;
      dot.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        if (ended) return;
        hits++;
        hitEl.textContent = String(hits);
        dot.classList.add("is-hit");
        window.setTimeout(() => dot.remove(), 220);
      });
      stage.appendChild(dot);
      window.setTimeout(() => dot.remove(), 1500);
    };

    const onMiss = () => {
      if (ended) return;
      misses++;
      missEl.textContent = String(misses);
    };

    stage.addEventListener("pointerdown", onMiss);
    spawner = window.setInterval(spawn, 520);
    spawn();
    timer = window.setInterval(() => {
      left--;
      leftEl.textContent = String(left);
      if (left <= 0) {
        ended = true;
        window.clearInterval(timer);
        window.clearInterval(spawner);
        const score = Math.max(0, hits - Math.floor(misses / 3));
        api.setScore(score, "得分");
        api.gameOver(score, { hits, misses });
        api.setStatus(`命中 ${hits} 次，落空 ${misses} 次`);
      }
    }, 1000);

    return {
      destroy: () => {
        window.clearInterval(timer);
        window.clearInterval(spawner);
        stage.removeEventListener("pointerdown", onMiss);
      },
    };
  },
};

export const GAMES: GameDef[] = [g2048, snakeGame, mineGame, memoryGame, blocksGame, reactionGame, guessGame, emberGame];

export const gameById = (id: string) => GAMES.find((g) => g.id === id);

export const gameCover = (id: string) => {
  const g = gameById(id);
  const tint = g?.tint ?? "#6f8cff";
  return `<div class="gm-cover" style="--gt:${tint}"><span>${escapeHtml(g?.ico ?? "✦")}</span></div>`;
};

export { clamp, key };
