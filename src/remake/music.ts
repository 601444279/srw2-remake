// 背景音乐：原版 21 首（tools/extract-music.js 从 ROM 导出），有增强版和原版录音两套，循环点相同。
// 用 WebAudio 解码后按循环点无缝循环；切歌时旧曲淡出、新曲从头开始。
import musicData from "../../data/music.json";
import { settings } from "./settings.ts";

const enhancedUrls = import.meta.glob("../../assets/music/*.ogg", { eager: true, query: "?url", import: "default" }) as Record<string, string>;
const originalUrls = import.meta.glob("../../assets/original/music/*.ogg", { eager: true, query: "?url", import: "default" }) as Record<string, string>;

interface Track { id: number; file: string; loop: { start: number; end: number } | null }
const tracks = new Map((musicData.tracks as Track[]).map((t) => [t.id, t]));

export const MUSIC = {
  // 每关的我方 / 敌方回合音乐，过关剧情音乐和剧情结束后的音乐（关卡号从 1 开始）
  stage(n: number) {
    const s = musicData.stages[n - 1] ?? musicData.stages[0];
    return { player: s.player ?? 7, enemy: s.enemy ?? 8, clear: s.clear[0] ?? 9, after: s.clear[1] ?? null };
  },
  // 原版战斗音乐：敌方是贝克时放专属曲，否则按我方驾驶员查表
  battle(playerPilot: number, enemyPilot: number) {
    const b = musicData.battle;
    if (b.boss && enemyPilot === b.boss.pilot) return b.boss.song;
    return (b.byPilot as Record<string, number>)[playerPilot] ?? b.default;
  },
};

const FADE_OUT = 0.6;

export class Music {
  private ctx: AudioContext | null = null;
  private bus: GainNode | null = null;
  private buffers = new Map<string, Promise<AudioBuffer>>();
  private current: { id: number; src: AudioBufferSourceNode; gain: GainNode } | null = null;
  private wanted: number | null = null;

  constructor() {
    // 浏览器要求用户操作后才能出声：先记下要放的曲子，第一次按键 / 点击时再开始
    const unlock = () => {
      this.init();
      if (this.ctx?.state === "suspended") void this.ctx.resume();
      if (this.wanted !== null && !this.current) void this.start(this.wanted);
    };
    for (const ev of ["keydown", "pointerdown", "touchstart"]) addEventListener(ev, unlock);
    settings.onChange(() => this.applySettings());
  }

  private init() {
    if (this.ctx || !window.AudioContext) return;
    this.ctx = new AudioContext();
    this.bus = this.ctx.createGain();
    this.bus.gain.value = settings.get().musicVolume;
    this.bus.connect(this.ctx.destination);
  }

  private style = settings.get().musicStyle;
  private applySettings() {
    const s = settings.get();
    if (this.bus && this.ctx) this.bus.gain.setTargetAtTime(s.musicVolume, this.ctx.currentTime, 0.05);
    // 换版本：当前曲子用新版本从头放
    if (s.musicStyle !== this.style) {
      this.style = s.musicStyle;
      if (this.wanted !== null) { const id = this.wanted; this.wanted = null; this.play(id); }
    }
  }

  private url(file: string) {
    const urls = this.style === "original" ? originalUrls : enhancedUrls;
    return Object.entries(urls).find(([k]) => k.endsWith("/" + file))?.[1];
  }

  private load(file: string): Promise<AudioBuffer> {
    const url = this.url(file);
    if (!url || !this.ctx) return Promise.reject(new Error(`没有音乐文件 ${file}`));
    let p = this.buffers.get(url);
    if (!p) {
      const ctx = this.ctx;
      p = fetch(url).then((r) => r.arrayBuffer()).then((b) => ctx.decodeAudioData(b));
      this.buffers.set(url, p);
    }
    return p;
  }

  // 预先下载解码，切歌时不卡
  preload(ids: number[]) {
    this.init();
    for (const id of ids) { const t = tracks.get(id); if (t) this.load(t.file).catch(() => {}); }
  }

  // 现在要放的曲子（战斗音乐放完后接回它）
  get playing() {
    return this.wanted;
  }

  // 播放某首；正在放的就是这首时什么也不做
  play(id: number) {
    if (this.wanted === id) return;
    this.wanted = id;
    this.stopJingle();
    this.fadeOut();
    if (this.ctx?.state === "running") void this.start(id);
  }

  stop() {
    this.wanted = null;
    this.stopJingle();
    this.fadeOut();
  }

  private fadeOut(time = FADE_OUT) {
    const cur = this.current;
    if (!cur || !this.ctx) return;
    const t = this.ctx.currentTime;
    cur.gain.gain.setValueAtTime(cur.gain.gain.value, t);
    cur.gain.gain.linearRampToValueAtTime(0, t + time);
    cur.src.stop(t + time + 0.05);
    this.current = null;
  }

  // 插播一段（原版升级的小号角）：当前曲子停下，插播曲放一遍，再从头接回原来的曲子
  private jingleSrc: AudioBufferSourceNode | null = null;
  async jingle(id: number) {
    const track = tracks.get(id);
    if (!track || !this.ctx || !this.bus || this.ctx.state !== "running") return;
    const resume = this.wanted;
    this.wanted = null;
    this.fadeOut(0.1);
    this.stopJingle();
    let buffer: AudioBuffer;
    try { buffer = await this.load(track.file); } catch { return; }
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.bus);
    // 循环曲只放一遍循环段的长度（插播曲都是从头循环的）
    const length = track.loop ? track.loop.end - track.loop.start : buffer.duration;
    src.start();
    src.stop(this.ctx.currentTime + length);
    this.jingleSrc = src;
    await new Promise((r) => setTimeout(r, length * 1000));
    if (this.jingleSrc !== src) return;
    this.jingleSrc = null;
    if (this.wanted === null && resume !== null) this.play(resume);
  }

  private stopJingle() {
    this.jingleSrc?.stop();
    this.jingleSrc = null;
  }

  private async start(id: number) {
    const track = tracks.get(id);
    if (!track || !this.ctx || !this.bus) return;
    let buffer: AudioBuffer;
    try {
      buffer = await this.load(track.file);
    } catch (e) {
      console.warn(e);
      return;
    }
    // 下载期间又切了别的歌，或者已经在放了
    if (this.wanted !== id || this.current) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    if (track.loop) {
      src.loop = true;
      src.loopStart = track.loop.start;
      src.loopEnd = track.loop.end;
    }
    const gain = this.ctx.createGain();
    src.connect(gain).connect(this.bus);
    src.start();
    src.onended = () => { if (this.current?.src === src) this.current = null; };
    this.current = { id, src, gain };
  }
}
