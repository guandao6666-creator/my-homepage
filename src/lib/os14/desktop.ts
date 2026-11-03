/**
 * Guandao OS 1.4 · 桌面互动层
 *
 * 像素桌宠「小管」、可拖动装饰物、点击反馈与隐藏彩蛋。
 * 原则：所有元素只占自己那一小块区域，绝不拦截窗口的指针事件；
 * 彩蛋全部是可发现的惊喜，不会打断正常操作。
 */

import { ls, type Ctx } from "./core";

let ctxRef: Ctx | null = null;

const PET_KEY = "guandao.os14.pet.v1";
const DECO_KEY = "guandao.os14.deco.v1";
const EGG_KEY = "guandao.os14.eggs.v1";

type PetState = { v: 1; on: boolean; x: number; y: number; name: string; size: number };
type Deco = { id: string; kind: string; x: number; y: number };
type EggState = { v: 1; found: Record<string, number> };

export const EGGS: Array<{ id: string; title: string; hint: string }> = [
  { id: "konami", title: "↑↑↓↓←→←→BA", hint: "在桌面上按一段很老的秘籍" },
  { id: "logo", title: "连点招牌", hint: "快速点菜单栏左上角的「管」五次" },
  { id: "ripple", title: "手速", hint: "一秒内点击桌面空白处十次" },
  { id: "pet", title: "摸鱼二十次", hint: "桌宠被点二十下会记住你" },
  { id: "terminal", title: "隐藏命令", hint: "在终端里输入 guandao" },
  { id: "cake", title: "一块蛋糕", hint: "终端里也许有个和蛋糕有关的词" },
  { id: "midnight", title: "凌晨四点", hint: "在 0–4 点之间打开桌面" },
  { id: "anniversary", title: "桌面纪念日", hint: "10 月 30 日打开桌面" },
  { id: "themes", title: "换装达人", hint: "累计应用过五套主题" },
  { id: "ember", title: "余烬", hint: "找到藏在桌面里的第八个游戏" },
];

const readEggs = (): EggState => ls.get<EggState>(EGG_KEY, { v: 1, found: {} });
const writeEggs = (s: EggState) => ls.set(EGG_KEY, s);

export const foundEggs = () => readEggs().found;

/* ============================================================
   像素小动物
   ============================================================ */

const eye = (mood: "idle" | "happy" | "sleepy" | "wow", x: number) => {
  const y = mood === "sleepy" ? 18 : 16;
  if (mood === "happy") {
    return `<rect x="${x}" y="${y + 1}" width="2" height="2" fill="#123"/>
            <rect x="${x + 2}" y="${y}" width="2" height="2" fill="#123"/>
            <rect x="${x + 4}" y="${y + 1}" width="2" height="2" fill="#123"/>`;
  }
  if (mood === "sleepy") {
    return `<rect x="${x}" y="${y + 2}" width="6" height="2" fill="#123"/>`;
  }
  const size = mood === "wow" ? 4 : 3;
  return `<rect x="${x}" y="${y}" width="6" height="6" fill="#f7ffff"/>
          <rect x="${x + 1}" y="${y + 1}" width="${size}" height="${size}" fill="#12303a"/>
          <rect x="${x + 1}" y="${y + 1}" width="1" height="1" fill="#fff"/>`;
};

const petSvg = (mood: "idle" | "happy" | "sleepy" | "wow") => `
  <svg viewBox="0 0 32 32" shape-rendering="crispEdges" aria-hidden="true">
    <rect x="15" y="6" width="2" height="5" fill="#63d8c0"/>
    <rect x="13" y="3" width="6" height="4" rx="1" fill="#8ff0dc"/>
    <rect x="14" y="4" width="4" height="1" fill="#e9fffb"/>
    <rect x="10" y="10" width="12" height="2" fill="#7ce8cd"/>
    <rect x="8" y="12" width="16" height="2" fill="#6ee7c8"/>
    <rect x="6" y="14" width="20" height="10" fill="#6ee7c8"/>
    <rect x="6" y="24" width="20" height="2" fill="#4cc4ac"/>
    <rect x="8" y="26" width="16" height="2" fill="#3aa894"/>
    <rect x="8" y="28" width="5" height="2" fill="#2c8c7c"/>
    <rect x="19" y="28" width="5" height="2" fill="#2c8c7c"/>
    <rect x="8" y="21" width="3" height="2" fill="#ff9dbb" opacity=".8"/>
    <rect x="21" y="21" width="3" height="2" fill="#ff9dbb" opacity=".8"/>
    ${eye(mood, 10)}
    ${eye(mood, 18)}
    <rect x="14" y="22" width="4" height="2" fill="#12303a"/>
  </svg>`;

const SPEECH = [
  "在的。",
  "窗口别开太多啦。",
  "要不要玩一局 2048？",
  "今天的任务做完了吗？",
  "我就待在这儿，不吵你。",
  "桌面也是可以收拾的。",
  "双击我可以进游乐场。",
];

const readPet = (): PetState =>
  ls.get<PetState>(PET_KEY, { v: 1, on: true, x: -1, y: -1, name: "小管", size: 1 });

const writePet = (p: PetState) => ls.set(PET_KEY, p);

let petEl: HTMLElement | null = null;
let petTimer = 0;
let petClicks = 0;
let dragging = false;
let bubbleTimer = 0;

const ensurePet = (ctx: Ctx) => {
  if (petEl?.isConnected) return petEl;
  const desk = ctx.desk;
  const pet = document.createElement("div");
  pet.id = "pet14";
  pet.className = "pet14";
  const hour = new Date().getHours();
  const mood = hour >= 23 || hour < 6 ? "sleepy" : "idle";
  pet.dataset.mood = mood;
  pet.innerHTML = `
    <span class="pet14-bubble" data-bubble hidden></span>
    <span class="pet14-sprite" data-sprite>${petSvg(mood)}</span>
    <span class="pet14-name" data-name>小管</span>`;
  desk.appendChild(pet);
  petEl = pet;

  const state = readPet();
  // 默认待在桌面下方的中间空地：左边是图标栏，右边是组件栏，中间才是空的
  const maxY = Math.max(80, desk.clientHeight - 140);
  const fallbackX = Math.round(desk.clientWidth * 0.42);
  const x = state.x >= 0 ? Math.min(state.x, Math.max(20, desk.clientWidth - 80)) : fallbackX;
  const y = state.y >= 0 ? Math.min(state.y, Math.max(80, desk.clientHeight - 80)) : maxY;
  pet.style.left = `${Math.max(8, x)}px`;
  pet.style.top = `${Math.max(48, y)}px`;
  pet.style.setProperty("--pet-scale", String(clampSize(state.size)));

  const speak = (text: string) => {
    const bubble = pet.querySelector<HTMLElement>("[data-bubble]");
    if (!bubble) return;
    bubble.textContent = text;
    bubble.hidden = false;
    window.clearTimeout(bubbleTimer);
    bubbleTimer = window.setTimeout(() => (bubble.hidden = true), 2600);
  };

  const setMood = (mood: "idle" | "happy" | "sleepy" | "wow", ms = 1400) => {
    const sprite = pet.querySelector<HTMLElement>("[data-sprite]");
    if (sprite) sprite.innerHTML = petSvg(mood);
    pet.dataset.mood = mood;
    if (mood !== "idle") {
      window.setTimeout(() => {
        if (!pet.isConnected) return;
        const s = pet.querySelector<HTMLElement>("[data-sprite]");
        if (s) s.innerHTML = petSvg("idle");
        pet.dataset.mood = "idle";
      }, ms);
    }
  };

  pet.addEventListener("click", (e) => {
    if (dragging) return;
    e.stopPropagation();
    petClicks++;
    setMood("happy", 1100);
    speak(SPEECH[Math.floor(Math.random() * SPEECH.length)]);
    spawnHearts(pet);
    if (petClicks >= 20) unlockEgg("pet", ctx);
    if (petClicks === 40) unlockEgg("ember", ctx);
  });

  pet.addEventListener("dblclick", (e) => {
    e.stopPropagation();
    ctx.openApp("playground");
  });

  // 拖动：只用 transform 跟随，松手写回 left/top
  let sx = 0;
  let sy = 0;
  let ox = 0;
  let oy = 0;
  pet.addEventListener("pointerdown", (e) => {
    if ((e.target as HTMLElement).closest(".pet14-bubble")) return;
    pet.style.transition = "";
    dragging = false;
    sx = e.clientX;
    sy = e.clientY;
    ox = pet.offsetLeft;
    oy = pet.offsetTop;
    pet.setPointerCapture(e.pointerId);
    pet.classList.add("is-holding");
  });
  pet.addEventListener("pointermove", (e) => {
    if (!pet.hasPointerCapture(e.pointerId)) return;
    const dx = e.clientX - sx;
    const dy = e.clientY - sy;
    if (!dragging && Math.hypot(dx, dy) > 5) dragging = true;
    if (!dragging) return;
    const maxX = Math.max(0, desk.clientWidth - pet.offsetWidth);
    const maxY = Math.max(0, desk.clientHeight - pet.offsetHeight);
    pet.style.left = `${Math.min(maxX, Math.max(0, ox + dx))}px`;
    pet.style.top = `${Math.min(maxY, Math.max(40, oy + dy))}px`;
  });
  pet.addEventListener("pointerup", (e) => {
    pet.classList.remove("is-holding");
    if (!pet.hasPointerCapture(e.pointerId)) return;
    pet.releasePointerCapture(e.pointerId);
    if (dragging) {
      const st = readPet();
      st.x = pet.offsetLeft;
      st.y = pet.offsetTop;
      writePet(st);
      setMood("wow", 700);
    }
    window.setTimeout(() => (dragging = false), 30);
  });

  // 散步：每 7 秒换个位置，窗口不会挡到它的路
  window.clearInterval(petTimer);
  petTimer = window.setInterval(() => {
    if (!pet.isConnected || dragging || document.hidden) return;
    const st = readPet();
    if (!st.on) return;
    // 只在图标栏与组件栏之间的空地上散步
    const walkMin = desk.clientWidth * 0.3;
    const walkMax = desk.clientWidth * 0.56;
    const target = walkMin + Math.random() * Math.max(40, walkMax - walkMin);
    pet.style.transition = "left 2.6s cubic-bezier(.22,.61,.36,1), top 2.6s ease";
    pet.dataset.dir = target > pet.offsetLeft ? "right" : "left";
    pet.style.left = `${target}px`;
    const maxY = Math.max(80, desk.clientHeight - 130);
    const ny = maxY - Math.random() * 48;
    pet.style.top = `${ny}px`;
    window.setTimeout(() => {
      if (!pet.isConnected) return;
      pet.style.transition = "";
      const now = readPet();
      now.x = pet.offsetLeft;
      now.y = pet.offsetTop;
      writePet(now);
    }, 2700);
  }, 7000);

  const nameEl = pet.querySelector<HTMLElement>("[data-name]");
  if (nameEl) nameEl.textContent = state.name;
  pet.hidden = !state.on;
  return pet;
};

const clampSize = (n: number) => Math.max(0.7, Math.min(1.6, Number(n) || 1));

const spawnHearts = (host: HTMLElement) => {
  for (let i = 0; i < 3; i++) {
    const heart = document.createElement("span");
    heart.className = "pet14-heart";
    heart.textContent = "♥";
    heart.style.left = `${30 + Math.random() * 30}%`;
    heart.style.animationDelay = `${i * 90}ms`;
    host.appendChild(heart);
    window.setTimeout(() => heart.remove(), 1300);
  }
};

export const setPetVisible = (on: boolean) => {
  const st = readPet();
  st.on = on;
  writePet(st);
  if (petEl) petEl.hidden = !on;
};

export const setPetSize = (size: number) => {
  const st = readPet();
  st.size = clampSize(size);
  writePet(st);
  petEl?.style.setProperty("--pet-scale", String(st.size));
};

export const setPetName = (name: string) => {
  const st = readPet();
  st.name = name.slice(0, 8) || "小管";
  writePet(st);
  const el = petEl?.querySelector<HTMLElement>("[data-name]");
  if (el) el.textContent = st.name;
};

export const petState = readPet;

/* ============================================================
   装饰物
   ============================================================ */

const DECOS: Record<string, { label: string; art: string }> = {
  plant: { label: "小盆栽", art: "🌿" },
  coffee: { label: "咖啡杯", art: "☕" },
  plane: { label: "纸飞机", art: "✈" },
  cat: { label: "像素猫", art: "🐈" },
  lamp: { label: "小台灯", art: "💡" },
};

const readDeco = (): Deco[] => ls.get<Deco[]>(DECO_KEY, []);
const writeDeco = (list: Deco[]) => ls.set(DECO_KEY, list);

const ensureDeco = (ctx: Ctx, item: Deco) => {
  if (document.querySelector(`[data-deco="${item.id}"]`)) return;
  const kind = DECOS[item.kind];
  if (!kind) return;
  const node = document.createElement("button");
  node.type = "button";
  node.className = "deco14";
  node.dataset.deco = item.id;
  node.title = `${kind.label} · 可以拖动，双击收回`;
  node.innerHTML = `<span>${kind.art}</span>`;
  node.style.left = `${item.x}px`;
  node.style.top = `${item.y}px`;
  ctx.desk.appendChild(node);

  let sx = 0;
  let sy = 0;
  let ox = 0;
  let oy = 0;
  node.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    sx = e.clientX;
    sy = e.clientY;
    ox = node.offsetLeft;
    oy = node.offsetTop;
    node.setPointerCapture(e.pointerId);
    node.classList.add("is-drag");
  });
  node.addEventListener("pointermove", (e) => {
    if (!node.hasPointerCapture(e.pointerId)) return;
    const maxX = Math.max(0, ctx.desk.clientWidth - 40);
    const maxY = Math.max(40, ctx.desk.clientHeight - 40);
    node.style.left = `${Math.min(maxX, Math.max(0, ox + e.clientX - sx))}px`;
    node.style.top = `${Math.min(maxY, Math.max(40, oy + e.clientY - sy))}px`;
  });
  node.addEventListener("pointerup", (e) => {
    node.classList.remove("is-drag");
    if (node.hasPointerCapture(e.pointerId)) node.releasePointerCapture(e.pointerId);
    const list = readDeco();
    const it = list.find((x) => x.id === item.id);
    if (it) {
      it.x = node.offsetLeft;
      it.y = node.offsetTop;
      writeDeco(list);
    }
  });
  node.addEventListener("dblclick", () => {
    writeDeco(readDeco().filter((x) => x.id !== item.id));
    node.remove();
    ctx.toast("已收回装饰物");
  });
};

export const addDecoration = (kind: string) => {
  if (!ctxRef) return;
  const def = DECOS[kind];
  if (!def) return;
  const list = readDeco();
  const item: Deco = {
    id: `d-${Date.now().toString(36)}`,
    kind,
    x: 60 + Math.random() * Math.max(40, ctxRef.desk.clientWidth - 200),
    y: 120 + Math.random() * Math.max(40, ctxRef.desk.clientHeight - 300),
  };
  list.push(item);
  writeDeco(list);
  ensureDeco(ctxRef, item);
  ctxRef.toast(`已放置${def.label}，可以拖着走`);
};

export const decoKinds = DECOS;
export const decoList = readDeco;

/* ============================================================
   点击反馈 + 彩蛋
   ============================================================ */

const rippleAt = (x: number, y: number) => {
  const desk = document.getElementById("desk");
  if (!desk) return;
  const dot = document.createElement("span");
  dot.className = "desk-ripple";
  dot.style.left = `${x}px`;
  dot.style.top = `${y}px`;
  desk.appendChild(dot);
  window.setTimeout(() => dot.remove(), 720);
};

export const confetti = (count = 26) => {
  const desk = document.getElementById("desk");
  if (!desk) return;
  if (document.body.classList.contains("os-reduce-motion")) return;
  const colors = ["#6f8cff", "#5ecf9a", "#ffd479", "#ff8f8f", "#b06eff", "#38bdf8"];
  for (let i = 0; i < count; i++) {
    const bit = document.createElement("i");
    bit.className = "desk-confetti";
    bit.style.left = `${10 + Math.random() * 80}%`;
    bit.style.background = colors[i % colors.length];
    bit.style.animationDelay = `${Math.random() * 260}ms`;
    bit.style.setProperty("--dur", `${1.2 + Math.random() * 0.9}s`);
    bit.style.transform = `rotate(${Math.random() * 360}deg)`;
    desk.appendChild(bit);
    window.setTimeout(() => bit.remove(), 2400);
  }
};

export const unlockEgg = (id: string, ctx?: Ctx) => {
  const def = EGGS.find((e) => e.id === id);
  if (!def) return;
  const st = readEggs();
  if (st.found[id]) return;
  st.found[id] = Date.now();
  writeEggs(st);
  const c = ctx ?? ctxRef;
  c?.pushNotif({ icon: "✧", title: `发现彩蛋：${def.title}`, body: "已记在「游乐场 → 彩蛋」里。" });
  c?.toast(`✧ 发现彩蛋：${def.title}`);
  confetti(18);
  document.dispatchEvent(new CustomEvent("guandao:egg", { detail: { id } }));
};

const konami = ["arrowup", "arrowup", "arrowdown", "arrowdown", "arrowleft", "arrowright", "arrowleft", "arrowright", "b", "a"];
let konamiIdx = 0;
let logoClicks = 0;
let logoAt = 0;
let rippleClicks = 0;
let rippleAt0 = 0;

const openHiddenGame = () => {
  if (!ctxRef) return;
  ctxRef.openApp("playground");
  window.setTimeout(() => {
    window.dispatchEvent(new CustomEvent("guandao:play", { detail: { game: "ember" } }));
  }, 320);
};

export const terminalCommand = (cmd: string): string | null => {
  switch (cmd) {
    case "guandao":
      unlockEgg("terminal");
      return "Guandao OS 1.4 · A Desktop That Becomes Your World.";
    case "cake":
      unlockEgg("cake");
      return "🎂 今天也值得一块蛋糕。";
    case "play":
      openHiddenGame();
      return "正在打开隐藏游戏「余烬」…";
    case "pixel":
      return "小管在桌面上看着你。双击它能进游乐场。";
    case "coffee":
      addDecoration("coffee");
      return "放了一杯咖啡在桌上。";
    case "42":
      return "42 —— 生命、宇宙以及一切的答案。";
    case "egg":
      return `已发现 ${Object.keys(readEggs().found).length} / ${EGGS.length} 个彩蛋，去游乐场看看。`;
    default:
      return null;
  }
};

export const initDesktop = (ctx: Ctx) => {
  ctxRef = ctx;
  ensurePet(ctx);

  // 恢复装饰物
  for (const item of readDeco()) ensureDeco(ctx, item);

  // 点击桌面空白：涟漪 + 连点彩蛋
  const onDeskClick = (e: MouseEvent) => {
    const t = e.target as HTMLElement;
    if (t.closest(".window") || t.closest(".widget") || t.closest(".desk-icon") || t.closest(".dock") || t.closest(".pet14") || t.closest(".deco14"))
      return;
    if (!t.closest("#desk")) return;
    const rect = ctx.desk.getBoundingClientRect();
    rippleAt(e.clientX - rect.left, e.clientY - rect.top);
    const now = Date.now();
    if (now - rippleAt0 > 1200) {
      rippleAt0 = now;
      rippleClicks = 0;
    }
    rippleClicks++;
    if (rippleClicks >= 10) {
      rippleClicks = 0;
      unlockEgg("ripple", ctx);
    }
  };
  document.addEventListener("click", onDeskClick);

  // 菜单栏 logo 连点
  const logo = document.querySelector<HTMLElement>(".mb-logo");
  logo?.addEventListener("click", () => {
    const now = Date.now();
    if (now - logoAt > 1600) logoClicks = 0;
    logoAt = now;
    logoClicks++;
    if (logoClicks >= 5) {
      logoClicks = 0;
      unlockEgg("logo", ctx);
    }
  });

  // 秘籍
  document.addEventListener("keydown", (e) => {
    const k = e.key.toLowerCase();
    if (k === konami[konamiIdx]) {
      konamiIdx++;
      if (konamiIdx >= konami.length) {
        konamiIdx = 0;
        unlockEgg("konami", ctx);
      }
    } else {
      konamiIdx = k === konami[0] ? 1 : 0;
    }
  });

  // 特殊日期
  const now = new Date();
  if (now.getHours() < 4) unlockEgg("midnight", ctx);
  if (now.getMonth() === 9 && now.getDate() === 30) unlockEgg("anniversary", ctx);

  // 主题收藏家
  try {
    const themes = ls.get<{ recent?: string[] }>("guandao.os14.themes.v1", {});
    if ((themes.recent?.length ?? 0) >= 5) unlockEgg("themes", ctx);
  } catch {
    /* 忽略 */
  }

};

export const desktopHooks = { openHiddenGame, terminal: terminalCommand };
