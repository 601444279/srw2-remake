// 音频输出：模拟器按画面节奏产出样本，声卡按自己的时钟消费，两者速度总有一点差。
// jsnes 自带的实现靠丢样本、插静音来对齐，听起来会跳。这里改成根据缓冲量
// 微调播放速度（最多 ±1%，听不出音调变化），让缓冲一直保持在目标水位附近。
const workletCode = `
const CAPACITY = 16384;
const TARGET = 2400;      // 约 50ms，大约 3 帧的样本
const MAX_ADJUST = 0.01;  // 播放速度最多偏离 1%

class NesOutput extends AudioWorkletProcessor {
  constructor() {
    super();
    this.left = new Float32Array(CAPACITY);
    this.right = new Float32Array(CAPACITY);
    this.write = 0;
    this.read = 0;      // 带小数的读位置，用于线性插值
    this.count = 0;
    this.primed = false;
    this.lastL = 0;
    this.lastR = 0;
    this.port.onmessage = (e) => {
      if (e.data.type === "flush") { this.count = 0; this.read = this.write; this.primed = false; return; }
      const { left, right } = e.data;
      if (this.count + left.length > CAPACITY) {
        // 积压太多（例如标签页卡顿后一次性补帧），直接跳到目标水位
        const drop = this.count + left.length - TARGET;
        this.read = (this.read + drop) % CAPACITY;
        this.count -= drop;
      }
      for (let i = 0; i < left.length; i++) {
        this.left[this.write] = left[i];
        this.right[this.write] = right[i];
        this.write = (this.write + 1) % CAPACITY;
      }
      this.count += left.length;
    };
  }

  process(_, outputs) {
    const [outL, outR] = outputs[0];
    if (!this.primed && this.count >= TARGET) this.primed = true;
    const drift = Math.max(-1, Math.min(1, (this.count - TARGET) / TARGET));
    const step = 1 + drift * MAX_ADJUST;

    for (let i = 0; i < outL.length; i++) {
      if (!this.primed || this.count < 2) {
        // 没数据时从最后一个样本平滑衰减到 0，避免爆音
        this.lastL *= 0.995; this.lastR *= 0.995;
        outL[i] = this.lastL; outR[i] = this.lastR;
        if (this.count < 2) this.primed = false;
        continue;
      }
      const i0 = Math.floor(this.read);
      const i1 = (i0 + 1) % CAPACITY;
      const t = this.read - i0;
      this.lastL = outL[i] = this.left[i0] + (this.left[i1] - this.left[i0]) * t;
      this.lastR = outR[i] = this.right[i0] + (this.right[i1] - this.right[i0]) * t;
      const next = this.read + step;
      const consumed = Math.floor(next) - i0;
      this.read = next % CAPACITY;
      this.count -= consumed;
    }
    return true;
  }
}
registerProcessor("nes-output", NesOutput);
`;

const BATCH = 512;

export class AudioOutput {
  constructor() {
    this.ctx = null;
    this.node = null;
    this.batchL = new Float32Array(BATCH);
    this.batchR = new Float32Array(BATCH);
    this.pos = 0;
  }

  get sampleRate() {
    return this.ctx?.sampleRate ?? 48000;
  }

  async start() {
    if (!window.AudioContext) return;
    this.ctx = new AudioContext({ latencyHint: "interactive" });
    const url = URL.createObjectURL(new Blob([workletCode], { type: "application/javascript" }));
    await this.ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    this.node = new AudioWorkletNode(this.ctx, "nes-output", { outputChannelCount: [2] });
    this.node.connect(this.ctx.destination);
    // 浏览器要求用户操作后才能出声
    const resume = () => this.ctx.state === "suspended" && this.ctx.resume();
    for (const ev of ["keydown", "pointerdown", "touchstart"]) addEventListener(ev, resume);
  }

  write = (l, r) => {
    if (!this.node) return;
    this.batchL[this.pos] = l;
    this.batchR[this.pos] = r;
    if (++this.pos === BATCH) this.flush();
  };

  flush() {
    if (!this.node || this.pos === 0) return;
    this.node.port.postMessage({ left: this.batchL.slice(0, this.pos), right: this.batchR.slice(0, this.pos) });
    this.pos = 0;
  }

  // 读档、暂停恢复时清空缓冲，避免播放旧的声音
  clear() {
    this.pos = 0;
    this.node?.port.postMessage({ type: "flush" });
  }

  suspend() { this.ctx?.suspend(); }
  resume() { this.ctx?.resume(); }
}
