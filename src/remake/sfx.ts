// 音效：用 WebAudio 实时合成，不用音频文件。
// 音色走 GB 机战的路子（LFSR 噪声 + 方波下滑），再补一层 GB 硬件做不到的低频，打击感主要靠这一层。
// 每个命中音分三层：起音（短促噪声，打中的瞬间）、主体（芯片噪声和方波往下滑）、尾巴（低频正弦）。

const MASTER_VOLUME = 0.5;

export class Sfx {
  private ctx: AudioContext | null = null;
  private out: AudioNode | null = null;
  private noise: AudioBuffer | null = null; // 长周期 LFSR：沙沙的爆破声
  private metal: AudioBuffer | null = null; // 短周期 LFSR：带金属味的嗡声

  constructor() {
    // 浏览器要求用户操作后才能出声，第一次按键 / 点击时再创建
    const unlock = () => {
      this.init();
      if (this.ctx?.state === "suspended") void this.ctx.resume();
    };
    for (const ev of ["keydown", "pointerdown", "touchstart"]) addEventListener(ev, unlock);
  }

  private init() {
    if (this.ctx || !window.AudioContext) return;
    const ctx = (this.ctx = new AudioContext({ latencyHint: "interactive" }));
    // 压一下峰值，几层叠起来时不爆音，同时让低频更结实
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 6;
    comp.attack.value = 0.002;
    comp.release.value = 0.12;
    const master = ctx.createGain();
    master.gain.value = MASTER_VOLUME;
    comp.connect(master).connect(ctx.destination);
    this.out = comp;
    this.noise = lfsrBuffer(ctx, false);
    this.metal = lfsrBuffer(ctx, true);
  }

  // 命中。power 0~1：伤害占目标最大 HP 的比例（击破算 1），越大越低沉、尾巴越长
  hit(power: number) {
    const ctx = this.ctx, out = this.out;
    if (!ctx || !out || ctx.state !== "running") return;
    const p = Math.max(0, Math.min(1, power));
    const t = ctx.currentTime + 0.005;

    // 起音：5ms 左右的高频噪声
    this.playNoise(this.noise!, t, { rate: 1, gain: 0.55, decay: 0.012, highpass: 2500 });

    // 主体：GB 噪声通道式的爆破，播放速度往下压 = 音高往下掉
    this.playNoise(this.noise!, t, {
      rate: 0.9, rateTo: 0.18 - p * 0.1, gain: 0.5 + p * 0.25, decay: 0.12 + p * 0.2,
      lowpass: 6000, lowpassTo: 500,
    });
    // 重击再叠一层金属噪声
    if (p > 0.35) this.playNoise(this.metal!, t, { rate: 0.5, rateTo: 0.12, gain: 0.25 * p, decay: 0.1 + p * 0.12 });

    // 方波下滑：芯片味的“咚”
    const sq = ctx.createOscillator();
    sq.type = "square";
    sq.frequency.setValueAtTime(420 - p * 160, t);
    sq.frequency.exponentialRampToValueAtTime(55, t + 0.09 + p * 0.06);
    this.envelope(sq, t, 0.22, 0.1 + p * 0.06);

    // 尾巴：低频正弦，GB 没有这层
    const sub = ctx.createOscillator();
    sub.type = "sine";
    sub.frequency.setValueAtTime(140 - p * 30, t);
    sub.frequency.exponentialRampToValueAtTime(38, t + 0.16 + p * 0.14);
    this.envelope(sub, t, 0.7 + p * 0.3, 0.14 + p * 0.22);
  }

  // 闪避：一声很轻的“咻”
  miss() {
    const ctx = this.ctx;
    if (!ctx || !this.out || ctx.state !== "running") return;
    const t = ctx.currentTime + 0.005;
    this.playNoise(this.noise!, t, { rate: 0.6, rateTo: 0.35, gain: 0.2, decay: 0.16, bandpass: 2600, bandpassTo: 900, attack: 0.04 });
  }

  private envelope(src: OscillatorNode, t: number, peak: number, decay: number) {
    const g = this.ctx!.createGain();
    g.gain.setValueAtTime(peak, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + decay);
    src.connect(g).connect(this.out!);
    src.start(t);
    src.stop(t + decay + 0.02);
  }

  private playNoise(buf: AudioBuffer, t: number, o: {
    rate: number; rateTo?: number; gain: number; decay: number; attack?: number;
    highpass?: number; lowpass?: number; lowpassTo?: number; bandpass?: number; bandpassTo?: number;
  }) {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.playbackRate.setValueAtTime(o.rate, t);
    if (o.rateTo) src.playbackRate.exponentialRampToValueAtTime(o.rateTo, t + o.decay);
    let node: AudioNode = src;
    const filter = (type: BiquadFilterType, from: number, to?: number) => {
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.frequency.setValueAtTime(from, t);
      if (to) f.frequency.exponentialRampToValueAtTime(to, t + o.decay);
      node = node.connect(f);
    };
    if (o.highpass) filter("highpass", o.highpass);
    if (o.lowpass) filter("lowpass", o.lowpass, o.lowpassTo);
    if (o.bandpass) filter("bandpass", o.bandpass, o.bandpassTo);
    const g = ctx.createGain();
    const attack = o.attack ?? 0;
    g.gain.setValueAtTime(attack ? 0.001 : o.gain, t);
    if (attack) g.gain.exponentialRampToValueAtTime(o.gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.001, t + attack + o.decay);
    node.connect(g).connect(this.out!);
    src.start(t);
    src.stop(t + attack + o.decay + 0.02);
  }
}

// 按 GB 噪声通道的方式生成噪声：15 位 LFSR（short=true 时用 7 位，周期短，听起来像金属嗡鸣）。
// 以约 32kHz 的速度推进移位寄存器，再用播放速度控制音高。
function lfsrBuffer(ctx: AudioContext, short: boolean): AudioBuffer {
  const rate = ctx.sampleRate;
  const len = short ? Math.round(rate * 0.05) : rate;
  const buf = ctx.createBuffer(1, len, rate);
  const data = buf.getChannelData(0);
  const step = 32768 / rate;
  let reg = 0x7fff, acc = 0;
  for (let i = 0; i < len; i++) {
    acc += step;
    while (acc >= 1) {
      acc -= 1;
      const bit = (reg ^ (reg >> 1)) & 1;
      reg = (reg >> 1) | (bit << 14);
      if (short) reg = (reg & ~0x40) | (bit << 6);
    }
    data[i] = reg & 1 ? -0.8 : 0.8;
  }
  return buf;
}
