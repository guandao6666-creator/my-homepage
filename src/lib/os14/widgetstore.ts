/**
 * Guandao OS 1.4 · 组件中心
 *
 * 8 个新组件 + 对 1.3 已有组件的统一管理（添加 / 删除 / 尺寸 / 透明度 /
 * 层级 / 锁定）。所有组件的定时逻辑由一个全局 1Hz ticker 驱动，
 * 组件被移除后自动不再更新，不会留下后台任务。
 */

import {
  $$,
  bindTabs,
  clamp,
  compressImage,
  debounce,
  download,
  emptyState,
  escapeHtml,
  fmtDateTime,
  idb,
  ls,
  modal,
  onBus,
  pickFile,
  shell,
  todayKey,
  uid,
  type Ctx,
  type WidgetSpec,
} from "./core";
import { taskStore } from "./tasks-store";
import { coverGradient, fmtTime, music, type PlayerSnapshot } from "./music-core";

let ctxRef: Ctx | null = null;

/* ============================================================
   存储
   ============================================================ */

const PHOTO_KEY = "guandao.os14.photo.v1";
const COUNT_KEY = "guandao.os14.countdown.v1";
const FOCUS_KEY = "guandao.os14.focus.v1";
const QUICK_KEY = "guandao.os14.quicknote.v1";
const WORLD_KEY = "guandao.os14.world.v1";
const CFG_KEY = "guandao.os14.widgcfg.v1";
const WIDGET_STATE_KEY = "guandao.os.widgets.v1";

type PhotoItem = { id: string; blobKey: string; caption: string; at: number };
type PhotoState = { v: 1; items: PhotoItem[]; idx: number; auto: boolean };

type CountdownState = { v: 1; title: string; date: string; time: string };

type FocusRun = { at: number; min: number };
type FocusState = {
  v: 1;
  mode: "work" | "break";
  running: boolean;
  endsAt: number;
  remaining: number;
  workMin: number;
  breakMin: number;
  runs: FocusRun[];
};

type WorldState = { v: 1; cities: Array<{ id: string; name: string; tz: string }> };

type ExtraCfg = {
  v: 1;
  opacity: Record<string, number>;
  locked: Record<string, boolean>;
  z: Record<string, number>;
};

const readPhoto = (): PhotoState => ls.get<PhotoState>(PHOTO_KEY, { v: 1, items: [], idx: 0, auto: false });
const writePhoto = (s: PhotoState) => ls.set(PHOTO_KEY, s);

const readCount = (): CountdownState =>
  ls.get<CountdownState>(COUNT_KEY, {
    v: 1,
    title: "寒假回家",
    date: new Date(Date.now() + 86400000 * 30).toISOString().slice(0, 10),
    time: "18:00",
  });
const writeCount = (s: CountdownState) => ls.set(COUNT_KEY, s);

const readFocus = (): FocusState =>
  ls.get<FocusState>(FOCUS_KEY, {
    v: 1,
    mode: "work",
    running: false,
    endsAt: 0,
    remaining: 25 * 60,
    workMin: 25,
    breakMin: 5,
    runs: [],
  });
const writeFocus = (s: FocusState) => ls.set(FOCUS_KEY, s);

const readWorld = (): WorldState =>
  ls.get<WorldState>(WORLD_KEY, {
    v: 1,
    cities: [
      { id: "dl", name: "大连", tz: "Asia/Shanghai" },
      { id: "tk", name: "东京", tz: "Asia/Tokyo" },
      { id: "ld", name: "伦敦", tz: "Europe/London" },
      { id: "ny", name: "纽约", tz: "America/New_York" },
    ],
  });
const writeWorld = (s: WorldState) => ls.set(WORLD_KEY, s);

const readCfg = (): ExtraCfg => ls.get<ExtraCfg>(CFG_KEY, { v: 1, opacity: {}, locked: {}, z: {} });
const writeCfg = (c: ExtraCfg) => ls.set(CFG_KEY, c);

const WIDGET_CATS: Array<{ id: string; name: string }> = [
  { id: "all", name: "全部" },
  { id: "time", name: "时间与日期" },
  { id: "task", name: "任务与效率" },
  { id: "system", name: "系统状态" },
  { id: "media", name: "图片与音乐" },
  { id: "quick", name: "快捷入口" },
  { id: "life", name: "生活与装饰" },
];

const EXISTING_CAT: Record<string, string> = {
  clock: "time",
  world: "time",
  calendar: "time",
  weather: "life",
  quote: "life",
  welcome: "life",
  profile: "life",
  todo: "task",
  sys: "system",
  launch: "quick",
  recent: "quick",
};

const NEW_META: Record<string, { cat: string; ico: string }> = {
  photoframe: { cat: "media", ico: "▣" },
  countdown: { cat: "task", ico: "⏳" },
  focus: { cat: "task", ico: "◎" },
  musicmini: { cat: "media", ico: "♫" },
  quicknote: { cat: "quick", ico: "✎" },
  sysmon: { cat: "system", ico: "▤" },
  worldclock14: { cat: "time", ico: "◷" },
  taskmini: { cat: "task", ico: "✓" },
};

/* ============================================================
   照片
   ============================================================ */

const photoUrls = new Map<string, string>();

const photoUrl = async (key: string): Promise<string | null> => {
  const cached = photoUrls.get(key);
  if (cached) return cached;
  const blob = await idb.get<Blob>("blobs", key);
  if (!blob) return null;
  const url = URL.createObjectURL(blob);
  photoUrls.set(key, url);
  return url;
};

const renderPhotoInto = async (root: HTMLElement) => {
  const st = readPhoto();
  const stage = root.querySelector<HTMLElement>("[data-w14p-stage]");
  const cap = root.querySelector<HTMLElement>("[data-w14p-cap]");
  const autoBtn = root.querySelector<HTMLElement>("[data-w14p-auto]");
  if (!stage) return;
  if (autoBtn) autoBtn.classList.toggle("is-on", st.auto);
  if (!st.items.length) {
    stage.innerHTML = `<div class="w14p-empty"><span>▣</span><p>点 ＋ 导入一张图片</p></div>`;
    if (cap) cap.textContent = "";
    return;
  }
  const item = st.items[clamp(st.idx, 0, st.items.length - 1)];
  const url = await photoUrl(item.blobKey);
  if (!url) {
    stage.innerHTML = `<div class="w14p-empty"><span>!</span><p>图片数据丢失</p></div>`;
    return;
  }
  stage.innerHTML = `<img src="${url}" alt="${escapeHtml(item.caption)}" draggable="false" />`;
  if (cap) cap.textContent = `${item.caption} · ${st.idx + 1}/${st.items.length}`;
};

export const photoWidget: WidgetSpec = {
  id: "photoframe",
  title: "桌面相框",
  desc: "导入图片，切换与自动轮播",
  category: "media",
  body: () => `
    <div class="w14p" data-w14p>
      <div class="w14p-stage" data-w14p-stage></div>
      <p class="w14p-cap" data-w14p-cap></p>
      <div class="w14p-acts">
        <button type="button" data-w14p-add title="导入图片">＋</button>
        <button type="button" data-w14p-prev title="上一张">‹</button>
        <button type="button" data-w14p-next title="下一张">›</button>
        <button type="button" data-w14p-auto title="自动轮播">⟳</button>
      </div>
    </div>`,
  init: (el) => {
    void renderPhotoInto(el);
    el.addEventListener("click", (e) => {
      const t = e.target as HTMLElement;
      const st = readPhoto();
      if (t.closest("[data-w14p-add]")) {
        pickFile("image/*", true, async (files) => {
          for (const f of files.slice(0, 8)) {
            const blob = await compressImage(f, 1600);
            const key = `img:${uid()}`;
            if (!(await idb.put("blobs", key, blob))) continue;
            st.items.push({ id: uid(), blobKey: key, caption: f.name.replace(/\.[^.]+$/, "").slice(0, 40), at: Date.now() });
          }
          if (st.items.length) st.idx = st.items.length - 1;
          writePhoto(st);
          void renderPhotoInto(el);
          ctxRef?.toast(`已导入 ${files.length} 张图片（保存在浏览器本地）`);
        });
        return;
      }
      if (t.closest("[data-w14p-prev]") || t.closest("[data-w14p-next]")) {
        if (!st.items.length) return;
        st.idx = (st.idx + (t.closest("[data-w14p-prev]") ? -1 : 1) + st.items.length) % st.items.length;
        writePhoto(st);
        void renderPhotoInto(el);
        return;
      }
      if (t.closest("[data-w14p-auto]")) {
        st.auto = !st.auto;
        writePhoto(st);
        void renderPhotoInto(el);
      }
    });
    el.addEventListener("contextmenu", (e) => {
      const st = readPhoto();
      if (!st.items.length) return;
      e.preventDefault();
      void modal(el.closest(".window") as HTMLElement ?? document.body, {
        title: "移除这张图片？",
        body: `<p class="g14-modal-text">只会从相框里删除，不会影响你的原文件。</p>`,
        actions: [
          { label: "取消", value: "" },
          { label: "移除", value: "del", danger: true, primary: true },
        ],
      }).then(async (v) => {
        if (v !== "del") return;
        const item = st.items[st.idx];
        if (item) {
          await idb.del("blobs", item.blobKey);
          photoUrls.delete(item.blobKey);
        }
        st.items.splice(st.idx, 1);
        st.idx = Math.max(0, st.idx - 1);
        writePhoto(st);
        void renderPhotoInto(el);
      });
    });
  },
};

/* ============================================================
   倒计时
   ============================================================ */

const nextOccur = (date: string, time: string): number => {
  const iso = `${date}T${time || "00:00"}:00`;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : Date.now();
};

const renderCountdownInto = (root: HTMLElement) => {
  const st = readCount();
  const target = nextOccur(st.date, st.time);
  const diff = target - Date.now();
  const abs = Math.abs(diff);
  const days = Math.floor(abs / 86400000);
  const hours = Math.floor((abs % 86400000) / 3600000);
  const mins = Math.floor((abs % 3600000) / 60000);
  const secs = Math.floor((abs % 60000) / 1000);
  const num = root.querySelector<HTMLElement>("[data-w14c-num]");
  const label = root.querySelector<HTMLElement>("[data-w14c-label]");
  const title = root.querySelector<HTMLElement>("[data-w14c-title]");
  const sub = root.querySelector<HTMLElement>("[data-w14c-sub]");
  if (title) title.textContent = st.title || "倒计时";
  if (num) num.textContent = String(days);
  if (label) label.textContent = diff >= 0 ? "天" : "天前";
  if (sub) sub.textContent = `${st.date} ${st.time} · ${days} 天 ${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
};

export const countdownWidget: WidgetSpec = {
  id: "countdown",
  title: "倒计时",
  desc: "自定义事件、日期与标题",
  category: "task",
  body: () => `
    <div class="w14c" data-w14c>
      <p class="w14c-title" data-w14c-title>倒计时</p>
      <p class="w14c-big"><b data-w14c-num>--</b><span data-w14c-label>天</span></p>
      <p class="w14c-sub" data-w14c-sub></p>
      <div class="w14c-edit" data-w14c-edit hidden>
        <input class="w14-input" data-w14c-input maxlength="24" placeholder="事件名称" />
        <input class="w14-input" type="date" data-w14c-date />
        <input class="w14-input" type="time" data-w14c-time />
        <div class="w14c-edit-acts"><button class="w14-btn" type="button" data-w14c-save>保存</button><button class="w14-btn is-ghost" type="button" data-w14c-cancel>取消</button></div>
      </div>
      <button class="w14c-set" type="button" data-w14c-set>设置事件</button>
    </div>`,
  init: (el) => {
    renderCountdownInto(el);
    el.addEventListener("click", (e) => {
      const t = e.target as HTMLElement;
      const form = el.querySelector<HTMLElement>("[data-w14c-edit]");
      if (t.closest("[data-w14c-set]")) {
        const st = readCount();
        const input = el.querySelector<HTMLInputElement>("[data-w14c-input]");
        const date = el.querySelector<HTMLInputElement>("[data-w14c-date]");
        const time = el.querySelector<HTMLInputElement>("[data-w14c-time]");
        if (input) input.value = st.title;
        if (date) date.value = st.date;
        if (time) time.value = st.time;
        if (form) form.hidden = !form.hidden;
        return;
      }
      if (t.closest("[data-w14c-cancel]")) {
        if (form) form.hidden = true;
        return;
      }
      if (t.closest("[data-w14c-save]")) {
        const title = el.querySelector<HTMLInputElement>("[data-w14c-input]")?.value ?? "";
        const date = el.querySelector<HTMLInputElement>("[data-w14c-date]")?.value ?? "";
        const time = el.querySelector<HTMLInputElement>("[data-w14c-time]")?.value ?? "00:00";
        if (!date) {
          ctxRef?.toast("先选一个日期");
          return;
        }
        writeCount({ v: 1, title: title.slice(0, 24) || "倒计时", date, time });
        if (form) form.hidden = true;
        renderCountdownInto(el);
      }
    });
  },
};

/* ============================================================
   专注计时
   ============================================================ */

const focusRemaining = (st: FocusState): number => {
  if (!st.running) return st.remaining;
  return Math.max(0, Math.round((st.endsAt - Date.now()) / 1000));
};

const finishFocus = () => {
  const st = readFocus();
  if (!st.running) return;
  const spent = st.mode === "work" ? st.workMin : st.breakMin;
  if (st.mode === "work") {
    st.runs.push({ at: Date.now(), min: spent });
    st.runs = st.runs.slice(-400);
  }
  ctxRef?.pushNotif({
    icon: st.mode === "work" ? "◎" : "☕",
    title: st.mode === "work" ? "专注结束" : "休息结束",
    body: st.mode === "work" ? `完成 ${spent} 分钟专注，起来走走。` : "休息好了，开始下一轮吧。",
  });
  st.mode = st.mode === "work" ? "break" : "work";
  st.running = false;
  st.remaining = (st.mode === "work" ? st.workMin : st.breakMin) * 60;
  st.endsAt = 0;
  writeFocus(st);
};

const renderFocusInto = (root: HTMLElement) => {
  const st = readFocus();
  const left = focusRemaining(st);
  const total = (st.mode === "work" ? st.workMin : st.breakMin) * 60;
  const pct = total ? 1 - left / total : 0;
  const time = root.querySelector<HTMLElement>("[data-f-time]");
  const mode = root.querySelector<HTMLElement>("[data-f-mode]");
  const btn = root.querySelector<HTMLElement>("[data-f-toggle]");
  const ring = root.querySelector<SVGCircleElement>("[data-f-ring]");
  const today = todayKey();
  const done = st.runs.filter((r) => todayKey(new Date(r.at)) === today).length;
  const stat = root.querySelector<HTMLElement>("[data-f-stat]");
  if (time) time.textContent = `${String(Math.floor(left / 60)).padStart(2, "0")}:${String(left % 60).padStart(2, "0")}`;
  if (mode) mode.textContent = st.mode === "work" ? "专注" : "休息";
  if (btn) btn.textContent = st.running ? "暂停" : "开始";
  if (ring) ring.style.strokeDashoffset = String(1 - pct);
  if (stat) stat.textContent = `今日已完成 ${done} 轮`;
};

export const focusWidget: WidgetSpec = {
  id: "focus",
  title: "专注计时",
  desc: "番茄钟、休息提醒与统计",
  category: "task",
  body: () => `
    <div class="w14f" data-w14f>
      <div class="w14f-ring">
        <svg viewBox="0 0 44 44" aria-hidden="true">
          <circle class="w14f-track" cx="22" cy="22" r="18"/>
          <circle class="w14f-bar" data-f-ring cx="22" cy="22" r="18" pathLength="1"/>
        </svg>
        <b data-f-time>25:00</b>
      </div>
      <p class="w14f-mode" data-f-mode>专注</p>
      <div class="w14f-acts">
        <button class="w14-btn is-primary" type="button" data-f-toggle>开始</button>
        <button class="w14-btn" type="button" data-f-reset>重置</button>
      </div>
      <p class="w14f-stat" data-f-stat>今日已完成 0 轮</p>
      <div class="w14f-conf" data-f-conf hidden>
        <label>专注 <input type="number" min="5" max="90" data-f-work value="25"/></label>
        <label>休息 <input type="number" min="1" max="30" data-f-break value="5"/></label>
        <button class="w14-btn" type="button" data-f-apply>应用</button>
      </div>
      <button class="w14f-gear" type="button" data-f-gear title="设置时长">⚙</button>
    </div>`,
  init: (el) => {
    renderFocusInto(el);
    const st0 = readFocus();
    const work = el.querySelector<HTMLInputElement>("[data-f-work]");
    const brk = el.querySelector<HTMLInputElement>("[data-f-break]");
    if (work) work.value = String(st0.workMin);
    if (brk) brk.value = String(st0.breakMin);
    el.addEventListener("click", (e) => {
      const t = e.target as HTMLElement;
      const st = readFocus();
      if (t.closest("[data-f-toggle]")) {
        if (st.running) {
          st.remaining = focusRemaining(st);
          st.running = false;
          st.endsAt = 0;
        } else {
          // 必须先算剩余秒数再置 running：否则 focusRemaining 会走"运行中"分支，
          // 拿 endsAt=0 去减当前时间，算出 0 秒，等于立刻结束
          const left = focusRemaining(st);
          st.running = true;
          st.endsAt = Date.now() + left * 1000;
        }
        writeFocus(st);
        renderFocusInto(el);
        return;
      }
      if (t.closest("[data-f-reset]")) {
        st.running = false;
        st.endsAt = 0;
        st.mode = "work";
        st.remaining = st.workMin * 60;
        writeFocus(st);
        renderFocusInto(el);
        return;
      }
      if (t.closest("[data-f-gear]")) {
        const conf = el.querySelector<HTMLElement>("[data-f-conf]");
        if (conf) conf.hidden = !conf.hidden;
        return;
      }
      if (t.closest("[data-f-apply]")) {
        const w = clamp(Number(el.querySelector<HTMLInputElement>("[data-f-work]")?.value) || 25, 5, 90);
        const b = clamp(Number(el.querySelector<HTMLInputElement>("[data-f-break]")?.value) || 5, 1, 30);
        st.workMin = w;
        st.breakMin = b;
        if (!st.running) st.remaining = (st.mode === "work" ? w : b) * 60;
        writeFocus(st);
        const conf = el.querySelector<HTMLElement>("[data-f-conf]");
        if (conf) conf.hidden = true;
        renderFocusInto(el);
      }
    });
  },
};

/* ============================================================
   音乐控制
   ============================================================ */

export const musicWidget: WidgetSpec = {
  id: "musicmini",
  title: "音乐控制",
  desc: "封面、进度与上一首 / 下一首",
  category: "media",
  body: () => `
    <div class="w14m" data-w14m>
      <div class="w14m-cover" data-m-cover><span>♫</span></div>
      <div class="w14m-meta"><b data-m-title>还没有曲目</b><span data-m-artist>导入音频后开始播放</span></div>
      <div class="w14m-progress"><i data-m-bar></i></div>
      <div class="w14m-time"><span data-m-cur>0:00</span><span data-m-dur>0:00</span></div>
      <div class="w14m-acts">
        <button type="button" data-m-prev>⏮</button>
        <button type="button" class="is-main" data-m-play>▶</button>
        <button type="button" data-m-next>⏭</button>
      </div>
    </div>`,
  init: (el) => {
    let unsubscribe: (() => void) | null = null;
    const paint = (s: PlayerSnapshot) => {
      // 组件被移除（关闭 / 换布局）后自动退订，不留后台回调
      if (!el.isConnected) {
        unsubscribe?.();
        return;
      }
      const cover = el.querySelector<HTMLElement>("[data-m-cover]");
      const title = el.querySelector<HTMLElement>("[data-m-title]");
      const artist = el.querySelector<HTMLElement>("[data-m-artist]");
      const bar = el.querySelector<HTMLElement>("[data-m-bar]");
      const cur = el.querySelector<HTMLElement>("[data-m-cur]");
      const dur = el.querySelector<HTMLElement>("[data-m-dur]");
      const play = el.querySelector<HTMLElement>("[data-m-play]");
      if (title) title.textContent = s.track?.title ?? "还没有曲目";
      if (artist) artist.textContent = s.track?.artist ?? "导入音频后开始播放";
      if (cover && s.track) cover.style.background = coverGradient(s.track.title);
      if (bar) bar.style.width = `${s.duration ? (s.time / s.duration) * 100 : 0}%`;
      if (cur) cur.textContent = fmtTime(s.time);
      if (dur) dur.textContent = fmtTime(s.duration);
      if (play) play.textContent = s.playing ? "❚❚" : "▶";
    };
    unsubscribe = music.subscribe(paint);
    el.addEventListener("click", (e) => {
      const t = e.target as HTMLElement;
      if (t.closest("[data-m-play]")) music.toggle();
      if (t.closest("[data-m-next]")) void music.next();
      if (t.closest("[data-m-prev]")) void music.prev();
      if (t.closest("[data-m-cover]")) ctxRef?.openApp("music");
    });
  },
};

/* ============================================================
   快速便签
   ============================================================ */

export const quickNoteWidget: WidgetSpec = {
  id: "quicknote",
  title: "快速便签",
  desc: "随手写两句，自动保存",
  category: "quick",
  body: () => `
    <div class="w14q" data-w14q>
      <textarea class="w14q-area" data-q-area maxlength="1200" placeholder="随手记点什么…"></textarea>
      <div class="w14q-foot"><span data-q-state>自动保存</span><button type="button" data-q-clear>清空</button></div>
    </div>`,
  init: (el) => {
    const area = el.querySelector<HTMLTextAreaElement>("[data-q-area]");
    const state = el.querySelector<HTMLElement>("[data-q-state]");
    if (!area) return;
    area.value = ls.str(QUICK_KEY, "");
    const save = debounce(() => {
      ls.setStr(QUICK_KEY, area.value);
      if (state) state.textContent = "已保存";
      window.setTimeout(() => {
        if (state) state.textContent = "自动保存";
      }, 1200);
    }, 400);
    area.addEventListener("input", save);
    el.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest("[data-q-clear]")) {
        area.value = "";
        ls.setStr(QUICK_KEY, "");
      }
    });
  },
};

/* ============================================================
   系统状态
   ============================================================ */

const renderSysmonInto = (root: HTMLElement) => {
  const open = document.querySelectorAll(".window").length;
  const uptimeMin = Math.max(1, Math.floor(performance.now() / 60000));
  let bytes = 0;
  for (const k of ls.keys()) bytes += (k.length + ls.str(k).length) * 2;
  const rows = root.querySelector<HTMLElement>("[data-s-rows]");
  if (rows) {
    rows.innerHTML = `
      <div><span>运行窗口</span><b>${open}</b></div>
      <div><span>系统运行</span><b>${uptimeMin} 分钟</b></div>
      <div><span>本地存储</span><b>${(bytes / 1024).toFixed(1)} KB</b></div>
      <div><span>当前时间</span><b>${new Date().toLocaleTimeString("zh-CN", { hour12: false })}</b></div>`;
  }
  // 浏览器无法读取真实 CPU 占用，这里只做一条明确标注为「模拟」的装饰曲线
  const spark = root.querySelector<HTMLElement>("[data-s-spark]");
  if (spark) {
    const t = Date.now() / 1000;
    const bars = Array.from({ length: 16 }, (_, i) => {
      const v = 0.35 + 0.3 * Math.abs(Math.sin(t / 3 + i * 0.7));
      return `<i style="height:${(v * 100).toFixed(0)}%"></i>`;
    }).join("");
    spark.innerHTML = bars;
  }
};

export const sysmonWidget: WidgetSpec = {
  id: "sysmon",
  title: "系统状态",
  desc: "真实运行数据，模拟指标明确标注",
  category: "system",
  body: () => `
    <div class="w14s" data-w14s>
      <div class="w14s-rows" data-s-rows></div>
      <div class="w14s-sim">
        <div class="w14s-spark" data-s-spark></div>
        <p><b>模拟指标</b> · 浏览器读不到真实 CPU 占用，这里只是装饰曲线</p>
      </div>
    </div>`,
  init: (el) => renderSysmonInto(el),
};

/* ============================================================
   世界时钟
   ============================================================ */

const CITY_PRESETS: Array<{ name: string; tz: string }> = [
  { name: "大连", tz: "Asia/Shanghai" },
  { name: "东京", tz: "Asia/Tokyo" },
  { name: "首尔", tz: "Asia/Seoul" },
  { name: "新加坡", tz: "Asia/Singapore" },
  { name: "迪拜", tz: "Asia/Dubai" },
  { name: "柏林", tz: "Europe/Berlin" },
  { name: "伦敦", tz: "Europe/London" },
  { name: "纽约", tz: "America/New_York" },
  { name: "洛杉矶", tz: "America/Los_Angeles" },
  { name: "悉尼", tz: "Australia/Sydney" },
];

const renderWorldInto = (root: HTMLElement) => {
  const st = readWorld();
  const box = root.querySelector<HTMLElement>("[data-w14w-list]");
  if (!box) return;
  box.innerHTML = st.cities
    .map((c) => {
      let time = "--:--";
      let day = "";
      try {
        time = new Intl.DateTimeFormat("zh-CN", { timeZone: c.tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());
        day = new Intl.DateTimeFormat("zh-CN", { timeZone: c.tz, weekday: "short" }).format(new Date());
      } catch {
        time = "--:--";
      }
      return `<div class="w14w-row"><span class="w14w-name">${escapeHtml(c.name)}</span><span class="w14w-day">${escapeHtml(day)}</span><b>${time}</b><button type="button" data-w14w-del="${escapeHtml(c.id)}" title="移除">×</button></div>`;
    })
    .join("");
};

export const worldWidget: WidgetSpec = {
  id: "worldclock14",
  title: "世界时钟",
  desc: "多城市时间，可自行增删",
  category: "time",
  body: () => `
    <div class="w14w" data-w14w>
      <div class="w14w-list" data-w14w-list></div>
      <div class="w14w-add">
        <select class="w14-input" data-w14w-sel>
          ${CITY_PRESETS.map((c) => `<option value="${c.tz}|${c.name}">${c.name}</option>`).join("")}
        </select>
        <button type="button" data-w14w-add>＋</button>
      </div>
    </div>`,
  init: (el) => {
    renderWorldInto(el);
    el.addEventListener("click", (e) => {
      const t = e.target as HTMLElement;
      const st = readWorld();
      const del = t.closest<HTMLElement>("[data-w14w-del]");
      if (del) {
        st.cities = st.cities.filter((c) => c.id !== del.dataset.w14wDel);
        writeWorld(st);
        renderWorldInto(el);
        return;
      }
      if (t.closest("[data-w14w-add]")) {
        const sel = el.querySelector<HTMLSelectElement>("[data-w14w-sel]");
        const [tz, name] = (sel?.value ?? "").split("|");
        if (!tz) return;
        if (st.cities.some((c) => c.tz === tz)) {
          ctxRef?.toast("这个城市已经在列表里了");
          return;
        }
        st.cities.push({ id: uid().slice(0, 8), name, tz });
        writeWorld(st);
        renderWorldInto(el);
      }
    });
  },
};

/* ============================================================
   今日任务
   ============================================================ */

const renderTaskMini = (root: HTMLElement) => {
  const items = taskStore.dueToday();
  const box = root.querySelector<HTMLElement>("[data-tm-list]");
  const count = root.querySelector<HTMLElement>("[data-tm-count]");
  if (count) count.textContent = String(items.length);
  if (!box) return;
  box.innerHTML = items.length
    ? items
        .slice(0, 5)
        .map(
          (t) => `<label class="w14t-row"><input type="checkbox" data-tm-done="${escapeHtml(t.id)}"/><span>${escapeHtml(t.title)}</span></label>`,
        )
        .join("")
    : `<p class="w14t-empty">今天没有到期的任务</p>`;
};

export const taskMiniWidget: WidgetSpec = {
  id: "taskmini",
  title: "今日任务",
  desc: "今天到期的事，勾掉一个算一个",
  category: "task",
  body: () => `
    <div class="w14t" data-w14t>
      <div class="w14t-head"><span>今天</span><b data-tm-count>0</b><button type="button" data-tm-open>任务中心 →</button></div>
      <div class="w14t-list" data-tm-list></div>
    </div>`,
  init: (el) => {
    renderTaskMini(el);
    el.addEventListener("change", (e) => {
      const box = (e.target as HTMLElement).closest<HTMLInputElement>("[data-tm-done]");
      if (!box) return;
      taskStore.toggle(box.dataset.tmDone ?? "");
      renderTaskMini(el);
    });
    el.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest("[data-tm-open]")) ctxRef?.openApp("tasks");
    });
    let off: (() => void) | null = null;
    off = onBus("tasks-change", () => {
      if (!el.isConnected) {
        off?.();
        return;
      }
      renderTaskMini(el);
    });
  },
};

/* ============================================================
   组件运行时（全局 ticker + 额外样式）
   ============================================================ */

const applyExtras = () => {
  const cfg = readCfg();
  $$(".widget").forEach((el) => {
    const id = el.dataset.widget ?? "";
    const op = cfg.opacity[id];
    el.style.opacity = op == null ? "" : String(op);
    const z = cfg.z[id];
    el.style.zIndex = z == null ? "" : String(z);
    el.dataset.locked = cfg.locked[id] ? "1" : "";
  });
};

let ticker: number | null = null;
let lastWorld = 0;
let lastSys = 0;
let lastPhoto = 0;

const tick = () => {
  const now = Date.now();
  $$("[data-w14c]").forEach((el) => renderCountdownInto(el));
  $$("[data-w14f]").forEach((el) => {
    const st = readFocus();
    if (st.running && st.endsAt <= now) finishFocus();
    renderFocusInto(el);
  });
  if (now - lastWorld > 15000) {
    lastWorld = now;
    $$("[data-w14w]").forEach((el) => renderWorldInto(el));
  }
  if (now - lastSys > 5000) {
    lastSys = now;
    $$("[data-w14s]").forEach((el) => renderSysmonInto(el));
  }
  const st = readPhoto();
  if (st.auto && st.items.length > 1 && now - lastPhoto > 8000) {
    lastPhoto = now;
    st.idx = (st.idx + 1) % st.items.length;
    writePhoto(st);
    $$("[data-w14p]").forEach((el) => void renderPhotoInto(el));
  }
};

export const initWidgetRuntime = (ctx: Ctx) => {
  ctxRef = ctx;
  // 互动时钟：点时钟组件本体，在数字与指针之间切换
  document.addEventListener("click", (e) => {
    const body = (e.target as HTMLElement).closest<HTMLElement>('.widget[data-widget="clock"] .widget-body');
    if (!body) return;
    const all = ls.get<Record<string, Record<string, unknown>>>(WIDGET_STATE_KEY, {});
    const cur = String(all.clock?.style ?? "digital");
    all.clock = { ...all.clock, style: cur === "digital" ? "analog" : "digital" };
    ls.set(WIDGET_STATE_KEY, all);
    ctx.widgets.render("clock");
    ctx.toast(cur === "digital" ? "已切换为指针时钟" : "已切换为数字时钟");
  });
  // 互动时钟：点时钟组件本体，在数字与指针之间切换
  document.addEventListener("click", (e) => {
    const body = (e.target as HTMLElement).closest<HTMLElement>('.widget[data-widget="clock"] .widget-body');
    if (!body) return;
    const all = ls.get<Record<string, Record<string, unknown>>>(WIDGET_STATE_KEY, {});
    const cur = String(all.clock?.style ?? "digital");
    all.clock = { ...all.clock, style: cur === "digital" ? "analog" : "digital" };
    ls.set(WIDGET_STATE_KEY, all);
    ctx.widgets.render("clock");
    ctx.toast(cur === "digital" ? "已切换为指针时钟" : "已切换为数字时钟");
  });
  if (ticker == null) {
    ticker = window.setInterval(tick, 1000);
  }
  const host = document.getElementById("widgets");
  if (host) {
    new MutationObserver(() => applyExtras()).observe(host, { childList: true });
  }
  applyExtras();
  // 锁定后不让 index 的拖拽逻辑接管指针；组件内部的按钮仍然可点
  document.addEventListener(
    "pointerdown",
    (e) => {
      const head = (e.target as HTMLElement).closest<HTMLElement>(".widget[data-locked='1'] .widget-head");
      if (head) {
        e.stopPropagation();
      }
    },
    true,
  );
};

/* ============================================================
   组件中心 UI
   ============================================================ */

let galleryTab = "library";
let galleryCat = "all";
let currentWidgets: WidgetSpec[] = [];

const ensureWidgets = (): WidgetSpec[] => (ctxRef ? allWidgetSpecs(ctxRef) : currentWidgets);

const galleryPreview = (id: string) => {
  switch (id) {
    case "photoframe":
      return `<div class="gp gp-photo"><i></i><span></span></div>`;
    case "countdown":
      return `<div class="gp gp-count"><b>12</b><span>天</span><i></i></div>`;
    case "focus":
      return `<div class="gp gp-focus"><div class="gp-ring"><b>25:00</b></div><i></i></div>`;
    case "musicmini":
      return `<div class="gp gp-music"><div class="gp-cover"></div><i></i><i class="is-short"></i><div class="gp-btns"><span>⏮</span><span>▶</span><span>⏭</span></div></div>`;
    case "quicknote":
      return `<div class="gp gp-note"><i></i><i></i><i class="is-short"></i></div>`;
    case "sysmon":
      return `<div class="gp gp-sys"><i></i><i></i><i></i><div class="gp-spark"><b></b><b></b><b></b><b></b><b></b></div></div>`;
    case "worldclock14":
      return `<div class="gp gp-world"><i></i><i></i><i></i><i></i></div>`;
    case "taskmini":
      return `<div class="gp gp-task"><i></i><i></i><i></i></div>`;
    case "clock":
      return `<div class="gp gp-clock"><b>19:51</b><span>11月3日 周二</span></div>`;
    case "calendar":
      return `<div class="gp gp-cal"><b>11</b><div class="gp-dots">${"<i></i>".repeat(12)}</div></div>`;
    case "weather":
      return `<div class="gp gp-weather"><span>☀</span><b>14°</b><i></i></div>`;
    case "todo":
      return `<div class="gp gp-task"><i></i><i></i><i></i></div>`;
    case "sys":
      return `<div class="gp gp-sys"><i></i><i></i><i></i></div>`;
    case "quote":
      return `<div class="gp gp-quote"><i></i><i class="is-short"></i><b>”</b></div>`;
    case "world":
      return `<div class="gp gp-world"><i></i><i></i><i></i><i></i></div>`;
    case "launch":
      return `<div class="gp gp-launch"><span></span><span></span><span></span><span></span></div>`;
    case "recent":
      return `<div class="gp gp-recent"><i></i><i></i><i></i></div>`;
    case "profile":
      return `<div class="gp gp-profile"><span>管</span><i></i><i class="is-short"></i></div>`;
    case "welcome":
      return `<div class="gp gp-hello"><b>晚上好</b><i></i></div>`;
    default:
      return `<div class="gp gp-generic"><span>▦</span></div>`;
  }
};

const widgetCard = (spec: { id: string; title: string; desc: string; category: string }) => {
  const on = ctxRef?.widgets.on(spec.id) ?? false;
  return `
    <article class="g14-wcard ${on ? "is-on" : ""}" data-widget-id="${escapeHtml(spec.id)}">
      <div class="g14-wprev">${galleryPreview(spec.id)}</div>
      <div class="g14-wmeta">
        <h4>${escapeHtml(spec.title)}</h4>
        <p>${escapeHtml(spec.desc)}</p>
        <div class="g14-wacts">
          <button class="g14-btn ${on ? "" : "is-primary"}" type="button" data-wtoggle="${escapeHtml(spec.id)}">${on ? "从桌面移除" : "添加到桌面"}</button>
        </div>
      </div>
    </article>`;
};

const libraryView = () => {
  const specs = ensureWidgets().map((w) => ({
    id: w.id,
    title: w.title,
    desc: w.desc,
    category: w.category ?? NEW_META[w.id]?.cat ?? "life",
  }));
  const items = galleryCat === "all" ? specs : specs.filter((s) => s.category === galleryCat);
  return `
    <div class="g14-scroll">
      <div class="g14-pane-head"><h3>组件库</h3><p>点一下就能加到桌面，位置可以随手拖。</p></div>
      <div class="g14-chip-row is-wrap">
        ${WIDGET_CATS.map((c) => `<button class="g14-chip ${galleryCat === c.id ? "is-active" : ""}" type="button" data-wcat="${c.id}">${escapeHtml(c.name)}</button>`).join("")}
      </div>
      ${items.length ? `<div class="g14-wgrid">${items.map(widgetCard).join("")}</div>` : emptyState("这个分类还没有组件", "换个分类看看。", "▦")}
    </div>`;
};

const desktopView = () => {
  const on = ensureWidgets().filter((w) => ctxRef?.widgets.on(w.id));
  const off = ensureWidgets().filter((w) => !ctxRef?.widgets.on(w.id));
  return `
    <div class="g14-scroll">
      <div class="g14-pane-head"><h3>我的桌面</h3><p>已添加 ${on.length} 个组件。手机上放不下的会自动收起。</p></div>
      ${
        on.length
          ? `<div class="g14-wlist">${on
              .map(
                (w) => `<div class="g14-wrow">
                  <span class="g14-wrow-ico">${NEW_META[w.id]?.ico ?? "▦"}</span>
                  <div><b>${escapeHtml(w.title)}</b><span>${escapeHtml(w.desc)}</span></div>
                  <button class="g14-btn is-ghost" type="button" data-wtoggle="${escapeHtml(w.id)}">移除</button>
                </div>`,
              )
              .join("")}</div>`
          : emptyState("桌面还没有组件", "去组件库挑几个。", "▦")
      }
      <h3 class="g14-sub-h">未添加</h3>
      ${
        off.length
          ? `<div class="g14-wlist">${off
              .map(
                (w) => `<div class="g14-wrow">
                  <span class="g14-wrow-ico">${NEW_META[w.id]?.ico ?? "▦"}</span>
                  <div><b>${escapeHtml(w.title)}</b><span>${escapeHtml(w.desc)}</span></div>
                  <button class="g14-btn" type="button" data-wtoggle="${escapeHtml(w.id)}">添加</button>
                </div>`,
              )
              .join("")}</div>`
          : `<p class="g14-hint">全部都添加了。</p>`
      }
    </div>`;
};

const layoutView = () => {
  const cfg = readCfg();
  const on = ensureWidgets().filter((w) => ctxRef?.widgets.on(w.id));
  return `
    <div class="g14-scroll">
      <div class="g14-pane-head"><h3>布局</h3><p>调整尺寸、透明度与层级，布局会自动保存。</p></div>
      ${
        on.length
          ? `<div class="g14-layout">${on
              .map((w) => {
                const st = ctxRef?.widgets.state()[w.id] ?? {};
                const size = st.size ?? "m";
                const op = cfg.opacity[w.id] ?? 1;
                const locked = Boolean(cfg.locked[w.id]);
                return `<div class="g14-lrow" data-lrow="${escapeHtml(w.id)}">
                  <div class="g14-ltop">
                    <b>${escapeHtml(w.title)}</b>
                    <div class="g14-seg" data-wsize="${escapeHtml(w.id)}">
                      ${(["s", "m", "l"] as const)
                        .map((s) => `<button type="button" data-size="${s}" class="${size === s ? "is-active" : ""}">${s === "s" ? "小" : s === "m" ? "中" : "大"}</button>`)
                        .join("")}
                    </div>
                  </div>
                  <label class="g14-range-row"><span>不透明度</span><input type="range" min="20" max="100" value="${Math.round(op * 100)}" data-wop="${escapeHtml(w.id)}"/><b>${Math.round(op * 100)}%</b></label>
                  <div class="g14-lacts">
                    <button class="g14-btn ${locked ? "is-primary" : ""}" type="button" data-wlock="${escapeHtml(w.id)}">${locked ? "已锁定" : "锁定位置"}</button>
                    <button class="g14-btn is-ghost" type="button" data-wlayer="${escapeHtml(w.id)}|up">上移一层</button>
                    <button class="g14-btn is-ghost" type="button" data-wlayer="${escapeHtml(w.id)}|down">下移一层</button>
                    <button class="g14-btn is-ghost" type="button" data-wtoggle="${escapeHtml(w.id)}">移除</button>
                  </div>
                </div>`;
              })
              .join("")}</div>`
          : emptyState("没有可调整的组件", "先到组件库添加一个。", "▦")
      }
      <div class="g14-io-bar"><button class="g14-btn is-ghost" type="button" data-wreset>恢复默认布局</button></div>
    </div>`;
};

const view = () => (galleryTab === "desktop" ? desktopView() : galleryTab === "layout" ? layoutView() : libraryView());

export const renderWidgetGallery = () => {
  const nav: Array<[string, string, string]> = [
    ["library", "组件库", "▦"],
    ["desktop", "我的桌面", "▤"],
    ["layout", "布局", "⇕"],
  ];
  return shell("widgetstore", nav, `<div class="g14-whost" data-whost></div>`, "组件中心");
};

const patchWidgetState = (id: string, patch: Record<string, unknown>) => {
  const all = ls.get<Record<string, Record<string, unknown>>>(WIDGET_STATE_KEY, {});
  all[id] = { ...all[id], ...patch };
  ls.set(WIDGET_STATE_KEY, all);
};

export const initWidgetGallery = (win: HTMLElement): (() => void) => {
  const host = win.querySelector<HTMLElement>("[data-whost]");
  if (!host) return () => undefined;

  const paint = () => {
    host.innerHTML = view();
  };

  const toggle = (id: string) => {
    if (!ctxRef) return;
    const on = ctxRef.widgets.on(id);
    ctxRef.widgets.setEnabled(id, !on);
    ctxRef.toast(on ? "已从桌面移除" : "已添加到桌面");
    paint();
  };

  win.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const tg = t.closest<HTMLElement>("[data-wtoggle]");
    if (tg) {
      toggle(tg.dataset.wtoggle ?? "");
      return;
    }
    const cat = t.closest<HTMLElement>("[data-wcat]");
    if (cat) {
      galleryCat = cat.dataset.wcat ?? "all";
      paint();
      return;
    }
    const size = t.closest<HTMLElement>("[data-wsize] [data-size]");
    if (size) {
      const id = size.closest<HTMLElement>("[data-wsize]")?.dataset.wsize ?? "";
      patchWidgetState(id, { size: size.dataset.size });
      ctxRef?.widgets.render(id);
      window.setTimeout(paint, 60);
      return;
    }
    const lock = t.closest<HTMLElement>("[data-wlock]");
    if (lock) {
      const id = lock.dataset.wlock ?? "";
      const cfg = readCfg();
      cfg.locked[id] = !cfg.locked[id];
      writeCfg(cfg);
      applyExtras();
      paint();
      return;
    }
    const layer = t.closest<HTMLElement>("[data-wlayer]");
    if (layer) {
      const [id, dir] = (layer.dataset.wlayer ?? "").split("|");
      const cfg = readCfg();
      const cur = cfg.z[id] ?? 20;
      cfg.z[id] = dir === "up" ? cur + 2 : Math.max(1, cur - 2);
      writeCfg(cfg);
      applyExtras();
      paint();
      return;
    }
    if (t.closest("[data-wreset]")) {
      ls.del(CFG_KEY);
      const all = ls.get<Record<string, Record<string, unknown>>>(WIDGET_STATE_KEY, {});
      for (const id of Object.keys(all)) {
        if (all[id]?.x != null || all[id]?.y != null || all[id]?.size) {
          all[id] = { enabled: all[id].enabled };
        }
      }
      ls.set(WIDGET_STATE_KEY, all);
      ctxRef?.widgets.renderAll();
      applyExtras();
      paint();
      return;
    }
  });

  win.addEventListener("input", (e) => {
    const input = (e.target as HTMLElement).closest<HTMLInputElement>("[data-wop]");
    if (!input) return;
    const id = input.dataset.wop ?? "";
    const cfg = readCfg();
    cfg.opacity[id] = clamp(Number(input.value) / 100, 0.2, 1);
    writeCfg(cfg);
    applyExtras();
    const label = input.parentElement?.querySelector("b");
    if (label) label.textContent = `${input.value}%`;
  });

  bindTabs(win, (tab) => {
    galleryTab = tab;
    paint();
  });

  paint();
  return () => undefined;
};

/** 注册 8 个新组件；由 index 在启动时调用一次 */
export const registerNewWidgets = (ctx: Ctx) => {
  ctxRef = ctx;
  const specs: WidgetSpec[] = [
    photoWidget,
    countdownWidget,
    focusWidget,
    musicWidget,
    quickNoteWidget,
    sysmonWidget,
    worldWidget,
    taskMiniWidget,
  ];
  for (const spec of specs) ctx.widgets.register(spec);
  currentWidgets = specs;
  initWidgetRuntime(ctx);
};

/** 组件库里也要能看到 1.3 已有的组件 */
export const allWidgetSpecs = (ctx: Ctx): WidgetSpec[] => {
  const builtinIds = ["clock", "calendar", "weather", "todo", "sys", "welcome", "quote", "world", "launch", "recent", "profile"];
  const builtin = builtinIds
    .filter((id) => ctx.widgets.ids.includes(id))
    .map((id) => ({
      id,
      title: ctx.widgets.titles[id] ?? id,
      desc: ctx.widgets.desc[id] ?? "",
      category: EXISTING_CAT[id] ?? "life",
      body: () => "",
    }));
  return [...builtin, ...currentWidgets];
};

export const widgetIcons = NEW_META;
export const downloadWidgetLayout = () => {
  download(
    `guandao-widgets-${todayKey()}.json`,
    JSON.stringify({ kind: "guandao-widgets", version: 1, exportedAt: fmtDateTime(Date.now()), state: ls.get(WIDGET_STATE_KEY, {}), cfg: readCfg() }, null, 2),
  );
};
