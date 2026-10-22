// 增强版 BGM 合成：拿原版 APU 每个声道的状态序列（音高、音量、占空比、开关、按键触发）当乐谱，
// 用不受 FC 限制的合成器重新演奏。编曲、音符、节奏完全是原版的，只换音色和混音：
//   方波 → 抗锯齿（PolyBLEP）方波 + 轻微失谐的第二层做合唱，两个方波声道左右分开
//   三角波 → 平滑三角波（原版是 4 位阶梯）+ 一层正弦垫低频
//   噪声 → 同样的 LFSR 噪声，按输出采样做箱式滤波去混叠，再低通去刺耳
//   整体 → 立体声混响、去直流、按响度统一音量、柔和限幅
// 循环曲把循环段平铺三遍再加混响，取第三遍：混响尾巴首尾相接，接缝处完全连续。

const CPU = 1789773;

// ---------- 采集 ----------

// 挂在 jsnes 上：每输出一个采样检查一次声道状态，有变化就记一条事件；写 $4003/$4007/$400B/$400F 记为按键触发
export function attachCapture(nes) {
  const papu = nes.papu;
  const events = [];
  let index = 0;
  let last = "";
  const trig = [false, false, false, false];
  const write = papu.writeReg.bind(papu);
  papu.writeReg = (a, v) => {
    if (a === 0x4003) trig[0] = true;
    else if (a === 0x4007) trig[1] = true;
    else if (a === 0x400b) trig[2] = true;
    else if (a === 0x400f) trig[3] = true;
    return write(a, v);
  };
  const square = (s) => {
    const muted = s.sweepMode === 0 && s.progTimerMax + (s.progTimerMax >> s.sweepShiftAmount) > 0x7ff;
    const on = s.isEnabled && s.lengthCounter > 0 && s.progTimerMax > 7 && !muted;
    return on ? [s.progTimerMax, s.masterVolume, s.dutyMode] : [0, 0, 0];
  };
  return {
    events,
    // 每个采样调用一次（在 onAudioSample 里）
    sample() {
      const t = papu.triangle, n = papu.noise;
      const triOn = t.isEnabled && t.lengthCounter > 0 && t.linearCounter > 0 && t.progTimerMax >= 2;
      const noiseOn = n.isEnabled && n.lengthCounter > 0;
      const s = [
        ...square(papu.square1), ...square(papu.square2),
        triOn ? t.progTimerMax : 0,
        noiseOn ? n.masterVolume : 0, n.progTimerMax, n.randomMode,
      ];
      const key = s.join(",") + trig.join(",");
      if (key !== last || trig.some(Boolean)) {
        events.push({ i: index, s, trig: [...trig] });
        last = key;
        trig.fill(false);
      }
      index++;
    },
  };
}

// 取出 [from, to) 采样段内的事件，时间改成相对 from；段开头补一条当时的状态
export function sliceEvents(events, from, to) {
  const out = [];
  let prev = null;
  for (const e of events) {
    if (e.i < from) { prev = e; continue; }
    if (e.i >= to) break;
    out.push({ ...e, i: e.i - from });
  }
  if (prev && (!out.length || out[0].i > 0)) out.unshift({ i: 0, s: prev.s, trig: [false, false, false, false] });
  return out;
}

// ---------- 合成 ----------

function polyBlep(t, dt) {
  if (t < dt) { t /= dt; return t + t - t * t - 1; }
  if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; }
  return 0;
}

const DUTY = [0.125, 0.25, 0.5, 0.75];

// 一个方波声部：主振荡器 + 失谐层。按键触发时相位归零（原版硬件也是这样），用 1.5ms 交叉淡化避免爆音
class Pulse {
  constructor(rate, detune) {
    this.rate = rate;
    this.detune = detune;
    this.phase = [0, 0.37];
    this.old = null; // 触发时旧振荡器的相位，用来交叉淡化
    this.fade = 0;
    this.amp = 0;
    this.freq = 0;
    this.duty = 0.5;
    this.lp = [0, 0];
  }
  trigger() {
    this.old = [...this.phase];
    this.fade = 1;
    this.phase = [0, 0.37];
  }
  osc(phases, k, freq) {
    const dt = freq / this.rate;
    const p = phases[k];
    const d = this.duty;
    let v = (p < d ? 1 : -1) + polyBlep(p, dt) - polyBlep((p - d + 1) % 1, dt);
    phases[k] = (p + dt) % 1;
    return v;
  }
  next(target) {
    // 音量平滑：起音 1ms，释放 4ms
    this.amp += (target - this.amp) * (target > this.amp ? 0.02 : 0.005);
    if (this.amp < 1e-5 || this.freq <= 0) return [0, 0];
    const f2 = this.freq * this.detune;
    let a = this.osc(this.phase, 0, this.freq);
    let b = this.osc(this.phase, 1, f2);
    if (this.fade > 0) {
      const oa = this.osc(this.old, 0, this.freq), ob = this.osc(this.old, 1, f2);
      a = a * (1 - this.fade) + oa * this.fade;
      b = b * (1 - this.fade) + ob * this.fade;
      this.fade = Math.max(0, this.fade - 1 / (0.0015 * this.rate));
    }
    // 一阶低通，去掉方波最刺耳的高频
    this.lp[0] += (a - this.lp[0]) * 0.55;
    this.lp[1] += (b - this.lp[1]) * 0.55;
    return [this.lp[0] * this.amp, this.lp[1] * this.amp];
  }
}

class Triangle {
  constructor(rate) {
    this.rate = rate;
    this.phase = 0;
    this.amp = 0;
    this.freq = 0;
  }
  next(on) {
    this.amp += ((on ? 1 : 0) - this.amp) * (on ? 0.02 : 0.004);
    if (this.amp < 1e-5 || this.freq <= 0) return 0;
    const p = this.phase;
    // 加法合成的带限三角波（奇次谐波，幅度 1/n²），谐波数按奈奎斯特截断
    const w = 2 * Math.PI * p;
    let v = 0;
    const maxH = Math.min(15, Math.floor(this.rate / 2 / this.freq));
    for (let h = 1, sign = 1; h <= maxH; h += 2, sign = -sign) v += sign * Math.sin(w * h) / (h * h);
    v *= 8 / (Math.PI * Math.PI);
    const sub = Math.sin(w) * 0.35; // 正弦垫底，低音更厚
    this.phase = (p + this.freq / this.rate) % 1;
    return (v + sub) * this.amp;
  }
}

class Noise {
  constructor(rate) {
    this.rate = rate;
    this.reg = 1;
    this.acc = 0;
    this.amp = 0;
    this.period = 4;
    this.mode = 0;
    this.lp = 0;
  }
  trigger() { this.reg = 1; }
  next(target) {
    this.amp += (target - this.amp) * (target > this.amp ? 0.05 : 0.01);
    if (this.amp < 1e-5) return 0;
    // 这个采样时间内 LFSR 走了多少步，取输出的平均值（箱式滤波，去混叠）
    const clocks = CPU / this.period / this.rate;
    this.acc += clocks;
    let sum = 0, n = 0;
    while (this.acc >= 1) {
      this.acc -= 1;
      const fb = (this.reg ^ (this.reg >> (this.mode ? 6 : 1))) & 1;
      this.reg = (this.reg >> 1) | (fb << 14);
      sum += this.reg & 1 ? -1 : 1;
      n++;
    }
    const v = n ? sum / n : (this.reg & 1 ? -1 : 1);
    this.lp += (v - this.lp) * 0.6;
    return this.lp * this.amp;
  }
}

// 把事件序列演奏成干声立体声（未加混响），length 个采样
function renderDry(events, length, rate) {
  const L = new Float32Array(length), R = new Float32Array(length);
  // 声像：方波 1 偏左、方波 2 偏右，各自的失谐层放在对侧
  const p1 = new Pulse(rate, 1.0035), p2 = new Pulse(rate, 0.9968);
  const tri = new Triangle(rate), noise = new Noise(rate);
  // 音量按 NES 混音器的大致比例
  const PULSE = 0.075 / 15, TRI = 0.11, NOISE = 0.07 / 15;
  let s = [0, 0, 0, 0, 0, 0, 0, 0, 4, 0];
  let e = 0;
  for (let i = 0; i < length; i++) {
    while (e < events.length && events[e].i <= i) {
      const ev = events[e++];
      s = ev.s;
      if (ev.trig[0]) p1.trigger();
      if (ev.trig[1]) p2.trigger();
      if (ev.trig[3]) noise.trigger();
      p1.freq = s[0] ? CPU / (16 * (s[0] + 1)) : 0; p1.duty = DUTY[s[2]];
      p2.freq = s[3] ? CPU / (16 * (s[3] + 1)) : 0; p2.duty = DUTY[s[5]];
      if (s[6]) tri.freq = CPU / (32 * (s[6] + 1));
      noise.period = s[8] || 4; noise.mode = s[9];
    }
    const [a1, b1] = p1.next(s[1] * PULSE);
    const [a2, b2] = p2.next(s[4] * PULSE);
    const t = tri.next(s[6] > 0) * TRI;
    const n = noise.next(s[7] * NOISE);
    L[i] = a1 * 0.8 + b1 * 0.35 + a2 * 0.45 + b2 * 0.55 + t + n;
    R[i] = a1 * 0.45 + b1 * 0.55 + a2 * 0.8 + b2 * 0.35 + t + n;
  }
  return [L, R];
}

// ---------- 混响（Freeverb 结构：8 个梳状滤波 + 4 个全通，左右声道长度错开）----------

const COMBS = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
const ALLPASS = [556, 441, 341, 225];

function reverbChannel(input, rate, spread, { room = 0.8, damp = 0.35, predelay = 0.018 } = {}) {
  const scale = rate / 44100;
  const out = new Float32Array(input.length);
  const pd = Math.round(predelay * rate);
  const combs = COMBS.map((n) => ({ buf: new Float32Array(Math.round((n + spread) * scale)), i: 0, store: 0 }));
  const aps = ALLPASS.map((n) => ({ buf: new Float32Array(Math.round((n + spread) * scale)), i: 0 }));
  for (let k = 0; k < input.length; k++) {
    const x = (k >= pd ? input[k - pd] : 0) * 0.015;
    let y = 0;
    for (const c of combs) {
      const o = c.buf[c.i];
      c.store = o * (1 - damp) + c.store * damp;
      c.buf[c.i] = x + c.store * room;
      c.i = (c.i + 1) % c.buf.length;
      y += o;
    }
    for (const a of aps) {
      const o = a.buf[a.i];
      a.buf[a.i] = y + o * 0.5;
      a.i = (a.i + 1) % a.buf.length;
      y = o - y;
    }
    out[k] = y;
  }
  return out;
}

// ---------- 总线 ----------

function master(L, R, rate) {
  // 去直流（20Hz 高通）
  for (const ch of [L, R]) {
    let x1 = 0, y1 = 0;
    const a = Math.exp(-2 * Math.PI * 20 / rate);
    for (let i = 0; i < ch.length; i++) { const x = ch[i]; y1 = a * (y1 + x - x1); x1 = x; ch[i] = y1; }
  }
  // 按 RMS 统一响度（约 -16 dBFS），再用 tanh 柔和限幅，峰值不超过 -1 dBFS
  let sum = 0;
  for (let i = 0; i < L.length; i++) sum += L[i] * L[i] + R[i] * R[i];
  const rms = Math.sqrt(sum / (2 * L.length)) || 1;
  const gain = 0.158 / rms;
  const ceil = 0.89;
  for (const ch of [L, R]) for (let i = 0; i < ch.length; i++) ch[i] = Math.tanh(ch[i] * gain / ceil) * ceil;
}

// 渲染一首增强版。loop 为 null 时直接演奏 [0, length)；
// 否则 [0, from) 是前奏、[from, to) 是循环段，输出 = 前奏 + 循环段 + 循环段开头 tail 个采样
// margin：播放器的循环点比真正的循环点晚多少采样（见 extract-music.js 的 LOOP_MARGIN）
export function renderEnhanced(events, { length, loop, rate, tail, margin = 0 }) {
  const body = loop ? loop.to - loop.from : 0;
  let dryL, dryR, offset;
  if (!loop) {
    [dryL, dryR] = renderDry(events, length, rate);
    offset = 0;
  } else {
    // 演奏：前奏 + 循环段四遍（最后一遍只用到开头）。混响到第三遍已是稳态
    const intro = sliceEvents(events, 0, loop.from);
    const once = sliceEvents(events, loop.from, loop.to);
    const timeline = [...intro];
    for (let r = 0; r < 4; r++) for (const ev of once) timeline.push({ ...ev, i: ev.i + loop.from + r * body });
    const total = loop.from + body * 3 + tail;
    if (tail < margin + 0.05 * rate) throw new Error("tail 太短");
    [dryL, dryR] = renderDry(timeline, total, rate);
    offset = loop.from + body * 2;
  }
  const wetL = reverbChannel(dryL, rate, 0), wetR = reverbChannel(dryR, rate, 23);
  const mix = (dry, wet) => {
    const out = new Float32Array(loop ? loop.from + (loop.to - loop.from) + tail : dry.length);
    const take = (k) => dry[k] + wet[k] * 0.22;
    if (!loop) { for (let k = 0; k < out.length; k++) out[k] = take(k); return out; }
    // 前奏用第一遍，循环段和尾巴用第三遍（混响已经是稳态）。
    // 播放器从循环终点（to + margin）跳回起点（from + margin），跳之前听到的是第四遍的开头，
    // 所以循环段开头 margin 这一段也换成第四遍，跳回来波形就是连续的；之后 50ms 交叉淡化回第三遍
    // （两遍音符完全相同，只是振荡器相位略有不同）
    const fadeEnd = margin + Math.round(0.05 * rate);
    for (let k = 0; k < loop.from; k++) out[k] = take(k);
    for (let k = loop.from; k < out.length; k++) {
      const x = k - loop.from;
      const a = take(offset + x);
      const w = x < margin ? 1 : x < fadeEnd ? 1 - (x - margin) / (fadeEnd - margin) : 0;
      out[k] = w ? a * (1 - w) + take(offset + body + x) * w : a;
    }
    return out;
  };
  const L = mix(dryL, wetL), R = mix(dryR, wetR);
  master(L, R, rate);
  return [L, R];
}
