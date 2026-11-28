/**
 * Guandao OS 2.1 / 2.2 / 2.3 · Focus Studio（番茄专注）
 *
 * 按需懒加载内置应用：
 *   - 深度专注（25 分钟）/ 短休息（5 分钟）/ 长休息（15 分钟）+ 2.3 新增自定义时长（1~120 分钟）
 *   - SVG 环形进度条 + 等宽大号倒计时 + 浏览器标签页标题倒计时同步
 *   - 2.3 升级：纯本地 Web Audio 三种环境音色合成（柔和白噪音 / 细雨声 / 篝火暖频）+ 音量滑杆
 *   - 2.3 修复：专注记录在存储层保留原始文本，仅在 HTML 渲染层转义，消除双重转义
 *   - 近 7 天专注柱状图，关闭窗口时彻底释放计时器与音频上下文
 */
import { clamp, escapeHtml, ls, todayKey, type Ctx } from "../os14/core";

const STORAGE_KEY = "guandao.os21.focus.v1";

export type SoundScene = "brown" | "rain" | "fire";

type FocusLog = { at: number; min: number; label: string; day: string };
type FocusPersist = {
  v: 1;
  logs: FocusLog[];
  sound: boolean;
  ambient: boolean;
  scene?: SoundScene;
  volume?: number;
  customMin?: number;
};

/** 近 7 天（含今天）每天的专注分钟数，最早的在前（纯函数，便于单测） */
export const weeklyMinutes = (logs: Array<{ day: string; min: number }>, now: Date = new Date()) => {
  const out: Array<{ day: string; label: string; min: number }> = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const day = todayKey(d);
    const min = logs.filter((l) => l.day === day).reduce((sum, l) => sum + l.min, 0);
    out.push({ day, label: i === 0 ? "今天" : `${d.getMonth() + 1}/${d.getDate()}`, min });
  }
  return out;
};

/** 校验并裁剪自定义专注分钟数（1 ~ 120 整数） */
export const clampCustomMinutes = (raw: unknown, fallback = 45): number => {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return fallback;
  return clamp(n, 1, 120);
};

const readPersist = (): Required<FocusPersist> => {
  const raw = ls.get<Partial<FocusPersist>>(STORAGE_KEY, {});
  const scene: SoundScene = raw.scene === "rain" || raw.scene === "fire" ? raw.scene : "brown";
  return {
    v: 1,
    logs: Array.isArray(raw.logs) ? raw.logs : [],
    sound: raw.sound !== false,
    ambient: Boolean(raw.ambient),
    scene,
    volume: clamp(Number.isFinite(Number(raw.volume)) ? Number(raw.volume) : 55, 5, 100),
    customMin: clampCustomMinutes(raw.customMin, 45),
  };
};

const writePersist = (data: Required<FocusPersist>) => ls.set(STORAGE_KEY, data);

type Mode = "focus" | "short" | "long" | "custom";
const MODE_MINUTES: Record<Exclude<Mode, "custom">, number> = { focus: 25, short: 5, long: 15 };
const MODE_LABEL: Record<Mode, string> = { focus: "深度专注", short: "短休息", long: "长休息", custom: "自定义专注" };

export const renderFocusStudio = () => `
  <div class="os21-focus" style="display:grid;grid-template-rows:auto auto 1fr auto auto;gap:11px;height:100%;padding:16px 18px;box-sizing:border-box;color:inherit">
    <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap">
      <div style="display:flex;gap:6px;flex-wrap:wrap" data-fs-modes>
        <button type="button" class="g14-btn is-primary" data-fs-mode="focus">专注 25m</button>
        <button type="button" class="g14-btn is-ghost" data-fs-mode="short">短休 5m</button>
        <button type="button" class="g14-btn is-ghost" data-fs-mode="long">长休 15m</button>
        <button type="button" class="g14-btn is-ghost" data-fs-mode="custom">自定义</button>
      </div>
      <label style="display:inline-flex;align-items:center;gap:5px;font-size:12px;opacity:0.85">
        <span>分钟</span>
        <input type="number" min="1" max="120" value="45" data-fs-custom-min aria-label="自定义专注分钟数" style="width:54px;padding:4px 6px;border-radius:7px;border:1px solid rgba(255,255,255,0.16);background:rgba(255,255,255,0.06);color:inherit;font-family:var(--font-mono,monospace);font-size:12px;text-align:center;outline:none" />
      </label>
    </div>

    <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;font-size:12px">
      <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
        <button type="button" class="g14-btn is-ghost" data-fs-ambient aria-pressed="false" style="min-height:28px;padding:0 10px">声景：关</button>
        <select data-fs-scene aria-label="环境声景" style="padding:4px 8px;border-radius:8px;border:1px solid rgba(255,255,255,0.14);background:rgba(255,255,255,0.06);color:inherit;font:inherit;font-size:12px;outline:none">
          <option value="brown">柔和白噪</option>
          <option value="rain">窗外细雨</option>
          <option value="fire">篝火低频</option>
        </select>
        <input type="range" min="5" max="100" value="55" data-fs-vol aria-label="环境音音量" title="环境音音量" style="width:72px" />
      </div>
      <button type="button" class="g14-btn is-ghost" data-fs-sound aria-pressed="true" style="min-height:28px;padding:0 10px">提示音：开</button>
    </div>

    <div style="display:grid;place-items:center;gap:12px;align-content:center">
      <div style="position:relative;width:184px;height:184px;display:grid;place-items:center">
        <svg viewBox="0 0 120 120" width="184" height="184" style="transform:rotate(-90deg)" aria-hidden="true">
          <circle cx="60" cy="60" r="52" fill="none" stroke="rgba(255,255,255,0.1)" stroke-width="6" />
          <circle data-fs-ring cx="60" cy="60" r="52" fill="none" stroke="var(--accent, #6f8cff)" stroke-width="6" stroke-linecap="round" stroke-dasharray="326.73" stroke-dashoffset="0" style="transition:stroke-dashoffset 0.4s ease" />
        </svg>
        <div style="position:absolute;text-align:center">
          <div data-fs-time style="font-family:var(--font-mono,monospace);font-size:36px;font-weight:700;font-variant-numeric:tabular-nums;letter-spacing:0.03em">25:00</div>
          <div data-fs-phase style="font-size:12px;opacity:0.65;margin-top:2px">深度专注</div>
        </div>
      </div>

      <input
        type="text"
        data-fs-task
        maxlength="40"
        placeholder="此刻想专注做什么？（可选）"
        style="width:min(320px,100%);padding:7px 12px;border-radius:10px;border:1px solid rgba(255,255,255,0.14);background:rgba(255,255,255,0.05);color:inherit;font:inherit;font-size:13px;text-align:center;outline:none"
      />

      <div style="display:flex;gap:10px;align-items:center">
        <button type="button" class="g14-btn is-primary" data-fs-toggle style="min-width:110px;padding:8px 18px;font-size:13.5px">开始专注</button>
        <button type="button" class="g14-btn is-ghost" data-fs-reset>重置</button>
      </div>
    </div>

    <div data-fs-week aria-label="近 7 天专注分钟" role="img" style="display:grid;grid-template-columns:repeat(7,1fr);gap:8px;align-items:end;height:70px"></div>

    <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding-top:10px;border-top:1px solid rgba(255,255,255,0.08);font-size:12px;opacity:0.8">
      <span data-fs-stats>今日已完成 0 次 · 累计 0 分钟</span>
      <span style="opacity:0.65">Guandao OS 2.3 · Focus Studio</span>
    </div>
  </div>`;

export const initFocusStudio = (win: HTMLElement, ctx: Ctx): (() => void) => {
  const timeEl = win.querySelector<HTMLElement>("[data-fs-time]");
  const phaseEl = win.querySelector<HTMLElement>("[data-fs-phase]");
  const ringEl = win.querySelector<SVGCircleElement>("[data-fs-ring]");
  const toggleBtn = win.querySelector<HTMLButtonElement>("[data-fs-toggle]");
  const resetBtn = win.querySelector<HTMLButtonElement>("[data-fs-reset]");
  const taskInput = win.querySelector<HTMLInputElement>("[data-fs-task]");
  const statsEl = win.querySelector<HTMLElement>("[data-fs-stats]");
  const ambientBtn = win.querySelector<HTMLButtonElement>("[data-fs-ambient]");
  const sceneSel = win.querySelector<HTMLSelectElement>("[data-fs-scene]");
  const volInput = win.querySelector<HTMLInputElement>("[data-fs-vol]");
  const customInput = win.querySelector<HTMLInputElement>("[data-fs-custom-min]");
  const soundBtn = win.querySelector<HTMLButtonElement>("[data-fs-sound]");
  const modeBtns = Array.from(win.querySelectorAll<HTMLButtonElement>("[data-fs-mode]"));
  const weekEl = win.querySelector<HTMLElement>("[data-fs-week]");
  let savedTitle: string | null = null;

  const CIRC = 2 * Math.PI * 52;
  let persist = readPersist();
  let mode: Mode = "focus";
  const minutesOf = (m: Mode) => (m === "custom" ? persist.customMin : MODE_MINUTES[m]);
  let totalSec = minutesOf("focus") * 60;
  let remainSec = totalSec;
  let running = false;
  let timer: number | null = null;
  let audioCtx: AudioContext | null = null;
  let noiseNode: AudioBufferSourceNode | null = null;
  let noiseGain: GainNode | null = null;

  const syncDocTitle = () => {
    if (running) {
      if (savedTitle == null) savedTitle = document.title;
      const m = String(Math.floor(remainSec / 60)).padStart(2, "0");
      const s = String(remainSec % 60).padStart(2, "0");
      document.title = `⏱ ${m}:${s} · ${MODE_LABEL[mode]}`;
    } else if (savedTitle != null) {
      document.title = savedTitle;
      savedTitle = null;
    }
  };

  const stopAmbient = () => {
    try {
      noiseNode?.stop();
    } catch {
      /* ignore */
    }
    noiseNode = null;
    noiseGain = null;
  };

  const ensureAudio = () => {
    if (!audioCtx && typeof window.AudioContext === "function") {
      audioCtx = new window.AudioContext();
    }
    if (audioCtx && audioCtx.state === "suspended") {
      void audioCtx.resume();
    }
    return audioCtx;
  };

  const targetGainValue = () => (persist.volume / 100) * 0.16;

  const startAmbient = () => {
    stopAmbient();
    const ac = ensureAudio();
    if (!ac) return;
    const bufferSize = ac.sampleRate * 2;
    const buffer = ac.createBuffer(1, bufferSize, ac.sampleRate);
    const data = buffer.getChannelData(0);
    let last = 0;
    for (let i = 0; i < bufferSize; i++) {
      const white = Math.random() * 2 - 1;
      if (persist.scene === "rain") {
        // 细雨：轻柔粉红噪声 + 微水滴颗粒
        last = 0.86 * last + 0.14 * white;
        data[i] = last * 1.35 + (Math.random() > 0.9985 ? white * 0.45 : 0);
      } else if (persist.scene === "fire") {
        // 篝火：深沉暖频 + 细微噼啪脉冲
        last = (last + 0.015 * white) / 1.015;
        data[i] = last * 2.8 + (Math.random() > 0.9992 ? white * 0.6 : 0);
      } else {
        // 柔和白噪（布朗平滑噪声）
        last = (last + 0.02 * white) / 1.02;
        data[i] = last * 2.2;
      }
    }
    const source = ac.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    const filter = ac.createBiquadFilter();
    if (persist.scene === "rain") {
      filter.type = "bandpass";
      filter.frequency.value = 1150;
      filter.Q.value = 0.7;
    } else if (persist.scene === "fire") {
      filter.type = "lowpass";
      filter.frequency.value = 260;
    } else {
      filter.type = "lowpass";
      filter.frequency.value = 420;
    }
    const gain = ac.createGain();
    gain.gain.value = targetGainValue();
    source.connect(filter);
    filter.connect(gain);
    gain.connect(ac.destination);
    source.start();
    noiseNode = source;
    noiseGain = gain;
  };

  const playChime = () => {
    if (!persist.sound) return;
    const ac = ensureAudio();
    if (!ac) return;
    const now = ac.currentTime;
    [523.25, 659.25, 783.99].forEach((freq, idx) => {
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.001, now + idx * 0.14);
      gain.gain.exponentialRampToValueAtTime(0.12, now + idx * 0.14 + 0.04);
      gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.14 + 0.55);
      osc.connect(gain);
      gain.connect(ac.destination);
      osc.start(now + idx * 0.14);
      osc.stop(now + idx * 0.14 + 0.6);
    });
  };

  const paintWeek = () => {
    if (!weekEl) return;
    const week = weeklyMinutes(persist.logs);
    const peak = Math.max(25, ...week.map((d) => d.min));
    const total = week.reduce((sum, d) => sum + d.min, 0);
    weekEl.setAttribute("aria-label", `近 7 天共专注 ${total} 分钟`);
    weekEl.innerHTML = week
      .map((d) => {
        const h = d.min > 0 ? Math.max(6, Math.round((d.min / peak) * 44)) : 3;
        const today = d.label === "今天";
        return `<div title="${escapeHtml(d.day)} · ${d.min} 分钟" style="display:grid;justify-items:center;gap:4px">
          <span style="font-size:10px;opacity:${d.min ? 0.75 : 0.35};font-variant-numeric:tabular-nums">${d.min || ""}</span>
          <span style="width:100%;max-width:26px;height:${h}px;border-radius:5px;background:${today ? "var(--accent,#6f8cff)" : "rgba(255,255,255,0.22)"}"></span>
          <span style="font-size:10.5px;opacity:${today ? 0.9 : 0.55}">${escapeHtml(d.label)}</span>
        </div>`;
      })
      .join("");
  };

  const paintStats = () => {
    if (!statsEl) return;
    const today = todayKey();
    const todayLogs = persist.logs.filter((l) => l.day === today);
    const mins = todayLogs.reduce((sum, l) => sum + l.min, 0);
    statsEl.textContent = `今日已完成 ${todayLogs.length} 次 · 累计 ${mins} 分钟`;
    paintWeek();
  };

  const paintAudioBtns = () => {
    if (ambientBtn) {
      ambientBtn.textContent = persist.ambient ? "声景：开" : "声景：关";
      ambientBtn.setAttribute("aria-pressed", String(persist.ambient));
      ambientBtn.classList.toggle("is-primary", persist.ambient);
      ambientBtn.classList.toggle("is-ghost", !persist.ambient);
    }
    if (sceneSel) sceneSel.value = persist.scene;
    if (volInput) volInput.value = String(persist.volume);
    if (customInput) customInput.value = String(persist.customMin);
    if (soundBtn) {
      soundBtn.textContent = persist.sound ? "提示音：开" : "提示音：关";
      soundBtn.setAttribute("aria-pressed", String(persist.sound));
    }
  };

  const paintClock = () => {
    const m = String(Math.floor(remainSec / 60)).padStart(2, "0");
    const s = String(remainSec % 60).padStart(2, "0");
    if (timeEl) timeEl.textContent = `${m}:${s}`;
    if (phaseEl) phaseEl.textContent = running ? `${MODE_LABEL[mode]}中…` : MODE_LABEL[mode];
    if (ringEl) {
      const ratio = totalSec > 0 ? (totalSec - remainSec) / totalSec : 0;
      ringEl.style.strokeDashoffset = String((CIRC * (1 - ratio)).toFixed(2));
    }
    if (toggleBtn) toggleBtn.textContent = running ? "暂停" : remainSec < totalSec ? "继续专注" : "开始专注";
    syncDocTitle();
  };

  const stopTimer = () => {
    if (timer != null) {
      window.clearInterval(timer);
      timer = null;
    }
    running = false;
    stopAmbient();
    paintClock();
  };

  const switchMode = (next: Mode) => {
    stopTimer();
    mode = next;
    totalSec = minutesOf(next) * 60;
    remainSec = totalSec;
    modeBtns.forEach((btn) => {
      const on = btn.dataset.fsMode === next;
      btn.classList.toggle("is-primary", on);
      btn.classList.toggle("is-ghost", !on);
    });
    paintClock();
  };

  const complete = () => {
    const finishedMinutes = Math.max(1, Math.round(totalSec / 60));
    stopTimer();
    playChime();
    if (mode === "focus" || mode === "custom") {
      // 2.3 修复：存储层保存纯文本，不在落盘前做 HTML 实体编码
      const label = (taskInput?.value || "专注时段").trim().slice(0, 40);
      persist = {
        ...persist,
        logs: [{ at: Date.now(), min: finishedMinutes, label, day: todayKey() }, ...persist.logs].slice(0, 120),
      };
      writePersist(persist);
      paintStats();
      ctx.toast(`已完成 ${finishedMinutes} 分钟专注！休息一下吧`);
      switchMode("short");
    } else {
      ctx.toast("休息结束，准备好进入下一轮专注");
      switchMode("focus");
    }
  };

  toggleBtn?.addEventListener("click", () => {
    if (running) {
      stopTimer();
      return;
    }
    running = true;
    if (persist.ambient) startAmbient();
    paintClock();
    timer = window.setInterval(() => {
      remainSec = Math.max(0, remainSec - 1);
      paintClock();
      if (remainSec <= 0) complete();
    }, 1000);
  });

  resetBtn?.addEventListener("click", () => {
    stopTimer();
    remainSec = totalSec;
    paintClock();
  });

  ambientBtn?.addEventListener("click", () => {
    persist = { ...persist, ambient: !persist.ambient };
    writePersist(persist);
    paintAudioBtns();
    if (persist.ambient && running) startAmbient();
    else stopAmbient();
  });

  sceneSel?.addEventListener("change", () => {
    const next = sceneSel.value === "rain" || sceneSel.value === "fire" ? sceneSel.value : "brown";
    persist = { ...persist, scene: next };
    writePersist(persist);
    if (persist.ambient && running) startAmbient();
  });

  volInput?.addEventListener("input", () => {
    persist = { ...persist, volume: clamp(Number(volInput.value) || 55, 5, 100) };
    writePersist(persist);
    if (noiseGain) noiseGain.gain.value = targetGainValue();
  });

  customInput?.addEventListener("change", () => {
    const mins = clampCustomMinutes(customInput.value, persist.customMin);
    customInput.value = String(mins);
    persist = { ...persist, customMin: mins };
    writePersist(persist);
    switchMode("custom");
  });

  soundBtn?.addEventListener("click", () => {
    persist = { ...persist, sound: !persist.sound };
    writePersist(persist);
    paintAudioBtns();
  });

  modeBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      const m = btn.dataset.fsMode as Mode | undefined;
      if (m) switchMode(m);
    });
  });

  paintStats();
  paintAudioBtns();
  paintClock();

  return () => {
    stopTimer();
    if (audioCtx) {
      void audioCtx.close().catch(() => undefined);
      audioCtx = null;
    }
  };
};
