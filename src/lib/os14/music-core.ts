/**
 * Guandao OS 1.4 · 音乐内核
 *
 * 音乐应用和「音乐控制」组件共用同一个播放器实例，
 * 避免两个 Audio 同时出声、状态还不一致。
 */

import { idb, ls, uid } from "./core";

export type Track = {
  id: string;
  title: string;
  artist: string;
  /** 项目内置音频的直链 */
  src?: string;
  /** 导入音频在 IndexedDB 里的键 */
  blobKey?: string;
  size?: number;
  addedAt: number;
  imported?: boolean;
};

type MusicState = {
  v: 1;
  tracks: Track[];
  volume: number;
  index: number;
  repeat: "off" | "all" | "one";
  shuffle: boolean;
};

const KEY = "guandao.os14.music.v1";

const builtinTracks = (): Track[] => {
  try {
    const data = (window as unknown as { __OS__?: { tracks?: Array<{ src: string; title: string }> } }).__OS__;
    return (data?.tracks ?? []).map((t, i) => ({
      id: `builtin-${i}`,
      title: t.title,
      artist: "Guandao OS",
      src: t.src,
      addedAt: 0,
    }));
  } catch {
    return [];
  }
};

const defaults = (): MusicState => ({
  v: 1,
  tracks: builtinTracks(),
  volume: 0.7,
  index: 0,
  repeat: "all",
  shuffle: false,
});

export type PlayerSnapshot = {
  ready: boolean;
  playing: boolean;
  index: number;
  track: Track | null;
  time: number;
  duration: number;
  volume: number;
  repeat: MusicState["repeat"];
  shuffle: boolean;
  tracks: Track[];
  error: string;
};

class MusicCore {
  private state: MusicState;
  private audio: HTMLAudioElement | null = null;
  private listeners = new Set<(s: PlayerSnapshot) => void>();
  private objectUrl: string | null = null;
  private loading = false;
  private lastPos = 0;

  constructor() {
    const raw = ls.get<MusicState | null>(KEY, null);
    this.state = raw && raw.v === 1 ? { ...defaults(), ...raw } : defaults();
    // 内置曲目可能在构建后新增，合并一次
    for (const t of builtinTracks()) {
      if (!this.state.tracks.some((x) => x.id === t.id)) this.state.tracks.push(t);
    }
  }

  private save() {
    ls.set(KEY, { ...this.state, v: 1 });
  }

  private emit() {
    const snap = this.snapshot();
    for (const fn of this.listeners) {
      try {
        fn(snap);
      } catch {
        /* 单个订阅者出错不影响其他 */
      }
    }
  }

  private ensureAudio(): HTMLAudioElement {
    if (this.audio) return this.audio;
    const audio = new Audio();
    audio.preload = "metadata";
    audio.volume = this.state.volume;
    audio.addEventListener("timeupdate", () => this.emit());
    audio.addEventListener("durationchange", () => this.emit());
    audio.addEventListener("play", () => this.emit());
    audio.addEventListener("pause", () => this.emit());
    audio.addEventListener("ended", () => this.onEnded());
    audio.addEventListener("error", () => this.emit());
    this.audio = audio;
    return audio;
  }

  private onEnded() {
    if (this.state.repeat === "one") {
      void this.seek(0).then(() => this.play());
      return;
    }
    const nextIndex = this.nextIndex();
    if (nextIndex == null) {
      this.emit();
      return;
    }
    this.state.index = nextIndex;
    this.save();
    void this.load(true);
  }

  private nextIndex(): number | null {
    const n = this.state.tracks.length;
    if (!n) return null;
    if (this.state.shuffle && n > 1) {
      let i = this.state.index;
      while (i === this.state.index) i = Math.floor(Math.random() * n);
      return i;
    }
    if (this.state.index + 1 < n) return this.state.index + 1;
    return this.state.repeat === "all" ? 0 : null;
  }

  private async resolveSrc(track: Track | null): Promise<string | null> {
    if (!track) return null;
    if (track.src) return track.src;
    if (!track.blobKey) return null;
    const blob = await idb.get<Blob>("blobs", track.blobKey);
    if (!blob) return null;
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = URL.createObjectURL(blob);
    return this.objectUrl;
  }

  private async load(autoplay: boolean) {
    const track = this.state.tracks[this.state.index] ?? null;
    if (!track) {
      this.emit();
      return;
    }
    if (this.loading) return;
    this.loading = true;
    try {
      const audio = this.ensureAudio();
      const src = await this.resolveSrc(track);
      if (!src) {
        this.loading = false;
        this.emit();
        return;
      }
      audio.src = src;
      audio.load();
      if (autoplay) await audio.play().catch(() => undefined);
    } finally {
      this.loading = false;
      this.emit();
    }
  }

  snapshot(): PlayerSnapshot {
    const track = this.state.tracks[this.state.index] ?? null;
    return {
      ready: Boolean(track),
      playing: Boolean(this.audio && !this.audio.paused && !this.audio.ended),
      index: this.state.index,
      track,
      time: this.audio?.currentTime ?? 0,
      duration: Number.isFinite(this.audio?.duration) ? (this.audio?.duration ?? 0) : 0,
      volume: this.state.volume,
      repeat: this.state.repeat,
      shuffle: this.state.shuffle,
      tracks: this.state.tracks,
      error: track && !track.src && !track.blobKey ? "音频不可用" : "",
    };
  }

  subscribe(fn: (s: PlayerSnapshot) => void) {
    this.listeners.add(fn);
    fn(this.snapshot());
    return () => this.listeners.delete(fn);
  }

  async play(index?: number) {
    if (typeof index === "number" && index !== this.state.index) {
      this.state.index = index;
      this.save();
      this.lastPos = 0;
      await this.load(true);
      return;
    }
    const audio = this.ensureAudio();
    if (!audio.src) {
      await this.load(true);
      return;
    }
    if (this.lastPos > 0 && Math.abs(audio.currentTime - this.lastPos) > 1) audio.currentTime = this.lastPos;
    await audio.play().catch(() => undefined);
    this.emit();
  }

  pause() {
    if (!this.audio) return;
    this.lastPos = this.audio.currentTime;
    this.audio.pause();
    this.emit();
  }

  toggle() {
    if (this.snapshot().playing) this.pause();
    else void this.play();
  }

  async next() {
    const i = this.nextIndex();
    if (i == null) return;
    this.state.index = i;
    this.lastPos = 0;
    this.save();
    await this.load(true);
  }

  async prev() {
    const n = this.state.tracks.length;
    if (!n) return;
    this.state.index = (this.state.index - 1 + n) % n;
    this.lastPos = 0;
    this.save();
    await this.load(true);
  }

  async seek(seconds: number) {
    const audio = this.ensureAudio();
    if (!Number.isFinite(audio.duration)) return;
    audio.currentTime = Math.max(0, Math.min(audio.duration, seconds));
    this.lastPos = audio.currentTime;
    this.emit();
  }

  setVolume(v: number) {
    this.state.volume = Math.max(0, Math.min(1, v));
    if (this.audio) this.audio.volume = this.state.volume;
    this.save();
    this.emit();
  }

  setRepeat(mode: MusicState["repeat"]) {
    this.state.repeat = mode;
    this.save();
    this.emit();
  }

  toggleShuffle() {
    this.state.shuffle = !this.state.shuffle;
    this.save();
    this.emit();
  }

  /** 刷新播放列表（音乐应用导入 / 删除后调用） */
  setTracks(tracks: Track[], keepCurrent = true) {
    const curId = this.state.tracks[this.state.index]?.id;
    this.state.tracks = tracks;
    if (keepCurrent && curId) {
      const idx = tracks.findIndex((t) => t.id === curId);
      this.state.index = idx >= 0 ? idx : Math.min(this.state.index, Math.max(0, tracks.length - 1));
    } else {
      this.state.index = 0;
    }
    this.save();
    this.emit();
  }

  tracks() {
    return this.state.tracks.slice();
  }

  async addFiles(files: File[]): Promise<number> {
    const ok: Track[] = [];
    for (const file of files) {
      // 有些系统给本地音频的 MIME 是空的，再按扩展名兜一次
      if (!file.type.startsWith("audio/") && !/\.(mp3|wav|ogg|m4a|flac|aac)$/i.test(file.name)) continue;
      if (file.size > 40 * 1024 * 1024) continue;
      const key = `audio:${uid()}`;
      const saved = await idb.put("blobs", key, file);
      if (!saved) continue;
      ok.push({
        id: uid(),
        title: file.name.replace(/\.[^.]+$/, ""),
        artist: "本地导入",
        blobKey: key,
        size: file.size,
        addedAt: Date.now(),
        imported: true,
      });
    }
    if (ok.length) {
      this.state.tracks = [...this.state.tracks, ...ok];
      this.save();
      this.emit();
    }
    return ok.length;
  }

  async removeTrack(id: string) {
    const idx = this.state.tracks.findIndex((t) => t.id === id);
    if (idx < 0) return;
    const track = this.state.tracks[idx];
    if (track.blobKey) await idb.del("blobs", track.blobKey);
    if (this.state.index === idx) {
      this.pause();
      this.state.index = Math.max(0, idx - 1);
    } else if (this.state.index > idx) {
      this.state.index -= 1;
    }
    this.state.tracks.splice(idx, 1);
    this.save();
    this.emit();
  }

  renameTrack(id: string, title: string) {
    const t = this.state.tracks.find((x) => x.id === id);
    if (!t) return;
    t.title = title.slice(0, 60) || t.title;
    this.save();
    this.emit();
  }
}

export const music = new MusicCore();

/** 根据标题生成稳定的封面配色，避免伪造专辑图 */
export const coverGradient = (title: string) => {
  let h = 0;
  for (let i = 0; i < title.length; i++) h = (h * 31 + title.charCodeAt(i)) % 360;
  return `linear-gradient(140deg, hsl(${h} 62% 48%), hsl(${(h + 48) % 360} 58% 32%))`;
};

export const fmtTime = (s: number) => {
  if (!Number.isFinite(s) || s < 0) return "0:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
};
