// 音效：原版录音（tools/extract-sfx.js 从 ROM 导出，assets/original/sfx/se-XX.ogg）。
// 原版驱动同一时间只放一个音效，新音效会打断旧的（机枪连射就是反复重新触发 07 号），这里也一样。
//
// 各音效在原版里的用途（模拟器里实际跑战斗、读战斗序列脚本 resource 0x60 / 动画脚本 0x69 得到）：
//   0E 格斗砍击（光剑、萨斯剑），砍中就是这一声     0F 光束发射        03 弹道命中
//   0A 实弹 / 导弹发射                              16 大炮开火        0C 大炮炸开、光子射线和盖塔射线命中
//   07 机枪（连续重新触发）    12 左轮    06 离子剑、冷冻光线    17 离子波
//   02 击破（地图上的爆炸）    1E 确定    1F 菜单移动光标
import sfxData from "../../data/sfx.json";
import { settings } from "./settings.ts";

const urls = import.meta.glob("../../assets/original/sfx/*.ogg", { eager: true, query: "?url", import: "default" }) as Record<string, string>;

// 设置里的音效音量 1 对应的总音量
const MASTER_VOLUME = 0.9;

// 一次出手的音效：先放 fire（可连发），过 travel 秒命中时放 impact。都可以没有
export interface StrikeSound {
  fire?: number;
  repeat?: number; // fire 连发次数
  gap?: number; // 连发间隔（秒）
  travel: number;
  impact?: number;
}

const melee = (id: number): StrikeSound => ({ travel: 0.08, impact: id });
const shot = (fire: number, impact: number | undefined, travel: number): StrikeSound => ({ fire, impact, travel });

// 原版 22 种武器名对应的音效（按每个名字第一个武器编号的战斗序列核对；同名武器序列相同）
const BY_NAME: Record<string, StrikeSound> = {
  光剑: melee(0x0e),
  萨斯剑: melee(0x0e),
  离子剑: melee(0x06),
  冷冻光线: { travel: 0.25, impact: 0x06 },
  光束枪: shot(0x0f, 0x03, 0.3),
  粒子炮: shot(0x0f, 0x03, 0.3),
  光子射线: { travel: 0.25, impact: 0x0c },
  盖塔射线: { travel: 0.25, impact: 0x0c },
  导弹: shot(0x0a, 0x03, 0.4),
  盖塔导弹: shot(0x0a, 0x03, 0.4),
  穿甲弹: shot(0x0a, 0x03, 0.35),
  DX穿甲弹: shot(0x0a, 0x03, 0.35),
  手枪: shot(0x0a, 0x03, 0.3),
  射线枪: shot(0x0a, 0x03, 0.3),
  左轮手枪: shot(0x12, undefined, 0.15),
  离子波: shot(0x17, 0x03, 0.35),
  大炮: shot(0x16, 0x0c, 0.3),
  三指叉: shot(0x16, 0x0c, 0.3),
  连发枪: shot(0x16, 0x0c, 0.3),
  防空粒子炮: shot(0x16, 0x0c, 0.3),
  "20机枪": { fire: 0x07, repeat: 5, gap: 0.133, travel: 0.6 },
};

export function strikeSound(weaponName: string): StrikeSound {
  return BY_NAME[weaponName.trim()] ?? shot(0x0a, 0x03, 0.3);
}

export type UiSound = "ok" | "move";

export class Sfx {
  private ctx: AudioContext | null = null;
  private out: GainNode | null = null;
  private buffers = new Map<number, AudioBuffer>();
  private voice: AudioBufferSourceNode | null = null;
  private impactVoice: AudioBufferSourceNode | null = null;
  private jet: Jet | null = null;
  private thrust = 0;

  constructor() {
    // 一开始就建好音频、解码音效（浏览器允许就直接能出声），不允许的话第一次按键 / 点击时恢复
    this.init();
    const unlock = () => {
      this.init();
      if (this.ctx?.state === "suspended") void this.ctx.resume().catch(() => {});
    };
    for (const ev of ["keydown", "pointerdown", "touchstart"]) addEventListener(ev, unlock);
  }

  private init() {
    if (this.ctx || !window.AudioContext) return;
    const ctx = (this.ctx = new AudioContext({ latencyHint: "interactive" }));
    const out = (this.out = ctx.createGain());
    out.gain.value = MASTER_VOLUME * settings.get().sfxVolume;
    settings.onChange(() => out.gain.setTargetAtTime(MASTER_VOLUME * settings.get().sfxVolume, ctx.currentTime, 0.05));
    out.connect(ctx.destination);
    for (const { id, file } of sfxData.sfx) {
      const url = Object.entries(urls).find(([k]) => k.endsWith("/" + file))?.[1];
      if (!url) continue;
      fetch(url).then((r) => r.arrayBuffer()).then((b) => ctx.decodeAudioData(b))
        .then((buf) => this.buffers.set(id, buf)).catch((e) => console.warn(`音效 ${file} 加载失败`, e));
    }
  }

  // 播放 id 号音效，delay 秒后开始；会打断正在放的音效
  play(id: number, delay = 0) {
    const src = this.start(id, delay, this.voice);
    if (!src) return;
    src.onended = () => { if (this.voice === src) this.voice = null; };
    this.voice = src;
  }

  // 补的命中音（game.ts extraHitSound）：单独一路，不打断攻击动画还在响的尾音
  impact(id: number) {
    const src = this.start(id, 0, this.impactVoice);
    if (!src) return;
    src.onended = () => { if (this.impactVoice === src) this.impactVoice = null; };
    this.impactVoice = src;
  }

  private start(id: number, delay: number, prev: AudioBufferSourceNode | null) {
    const ctx = this.ctx, buf = this.buffers.get(id);
    if (!ctx || !this.out || !buf || ctx.state !== "running") return null;
    const t = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.out);
    prev?.stop(t);
    src.start(t);
    return src;
  }

  // 出手：开火声（连发的话按间隔重新触发）
  attack(s: StrikeSound) {
    if (s.fire === undefined) return;
    for (let i = 0; i < (s.repeat ?? 1); i++) this.play(s.fire, i * (s.gap ?? 0));
  }

  // 命中声；没打中不放
  hit(s: StrikeSound) {
    if (s.impact !== undefined) this.play(s.impact);
  }

  // 击破：地图上的爆炸
  explode() {
    this.play(0x02);
  }

  // 飞行演出的引擎声（原版没有，现场合成）：低沉的轰鸣 + 气流嘶声，跟着推力 0..1 变大变亮。
  // 一直在跑，推力 0 时静音；和原版音效分开走，不会被打断
  engine(thrust: number) {
    const ctx = this.ctx;
    if (!ctx || !this.out || ctx.state !== "running") return;
    if (Math.abs(thrust - this.thrust) < 0.02 && (thrust > 0 || this.thrust === 0)) return;
    // 推力上去快（点火），下来慢（引擎收油）
    const tc = thrust > this.thrust ? 0.06 : 0.22;
    this.thrust = thrust;
    const jet = (this.jet ??= makeJet(ctx, this.out));
    const t = ctx.currentTime;
    jet.roar.frequency.setTargetAtTime(160 + thrust * 1100, t, tc);
    jet.roarGain.gain.setTargetAtTime(0.55 * thrust ** 1.2, t, tc);
    jet.hiss.frequency.setTargetAtTime(1200 + thrust * 2800, t, tc);
    jet.hissGain.gain.setTargetAtTime(0.1 * thrust ** 2, t, tc);
  }

  // 界面：确定 1E，菜单移动光标 1F（原版取消和地图光标移动都不出声）
  ui(kind: UiSound) {
    this.play(kind === "ok" ? 0x1e : 0x1f);
  }
}

interface Jet {
  roar: BiquadFilterNode;
  roarGain: GainNode;
  hiss: BiquadFilterNode;
  hissGain: GainNode;
}

// 两路循环噪声：棕噪声过低通是火箭的轰鸣，白噪声过带通是气流
function makeJet(ctx: AudioContext, out: AudioNode): Jet {
  const len = ctx.sampleRate * 2;
  const white = ctx.createBuffer(1, len, ctx.sampleRate);
  const brown = ctx.createBuffer(1, len, ctx.sampleRate);
  const w = white.getChannelData(0), b = brown.getChannelData(0);
  let last = 0, peak = 0;
  for (let i = 0; i < len; i++) {
    w[i] = Math.random() * 2 - 1;
    last = (last + 0.02 * w[i]) / 1.02;
    b[i] = last;
  }
  // 拉平首尾，循环接缝处不会咔哒一声
  const drift = b[len - 1] - b[0];
  for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs((b[i] -= (drift * i) / (len - 1))));
  for (let i = 0; i < len; i++) b[i] /= peak;
  const layer = (buf: AudioBuffer, type: BiquadFilterType, q: number) => {
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.Q.value = q;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(filter).connect(gain).connect(out);
    src.start();
    return { filter, gain };
  };
  const roar = layer(brown, "lowpass", 0.9);
  const hiss = layer(white, "bandpass", 0.7);
  return { roar: roar.filter, roarGain: roar.gain, hiss: hiss.filter, hissGain: hiss.gain };
}
