// 导出原版音效：在模拟器里让声音驱动逐个播放音效，录下 APU 输出，编码成 Ogg Opus。
//
// 用法: node tools/extract-sfx.js
// 输出: assets/original/sfx/se-XX.ogg，data/sfx.json（每个音效的时长）
//
// 音效和音乐用同一个驱动（bank 24）：往 $4C 写 $01–$7F 播音效（$53 是当前音效的优先级，
// 新音效编号不大于它才会播），音效占用的声道在 $4E–$51 的 bit7。先写 $FE 停掉音乐再录。
// 各音效在游戏里的用途见 docs/rom-notes.md 和 src/remake/sfx.ts。
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { NES } from "jsnes";
import "../src/emu/waixing-mmc3.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT = path.join(ROOT, "assets/original/sfx");
const RATE = 48000;
const MAX_ID = 0x1f; // 0x20 以后没有有效的音效数据

function record(id) {
  const samples = [];
  const nes = new NES({ emulateSound: true, sampleRate: RATE, onFrame() {}, onAudioSample: (l, r) => samples.push((l + r) / 2) });
  nes.loadROM(new Uint8Array(fs.readFileSync(path.join(ROOT, "rom/srw2.nes"))));
  nes.fromJSON(JSON.parse(fs.readFileSync(path.join(ROOT, "extracted/states/title.json"), "utf8")));
  nes.frame();
  // 主循环停在 SRAM 里的死循环上，只让 NMI 里的声音驱动跑；拦掉标题画面自己的切歌请求
  nes.cpu.mem.set([0x4c, 0x00, 0x7f], 0x7f00);
  nes.cpu.REG_PC = 0x7f00 - 1;
  const write = nes.cpu.write.bind(nes.cpu);
  nes.cpu.write = (a, v) => (a === 0x4c && v !== 0xff && v !== 0xfe ? undefined : write(a, v));
  nes.cpu.mem[0x4c] = 0xfe;
  for (let i = 0; i < 40; i++) nes.frame();
  samples.length = 0;
  nes.cpu.mem[0x53] = 0xff;
  nes.cpu.mem[0x4c] = id;
  const busy = () => [0, 1, 2, 3].some((c) => nes.cpu.mem[0x4e + c] & 0x80);
  let last = -1;
  for (let f = 0; f < 300; f++) {
    nes.frame();
    if (busy()) last = f;
    else if (f - last > 4) break;
  }
  if (last < 0) return null;
  const end = Math.min(samples.length, Math.round(((last + 3) / 60) * RATE));
  return samples.slice(0, end);
}

function encode(samples, file) {
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  const pcm = Float32Array.from(samples, (v) => (v - mean) * 1.6);
  // 结尾 5ms 淡出，免得截断处爆音
  const fade = Math.round(RATE * 0.005);
  for (let i = 0; i < fade; i++) pcm[pcm.length - 1 - i] *= i / fade;
  const r = spawnSync("ffmpeg", [
    "-v", "error", "-y", "-f", "f32le", "-ar", String(RATE), "-ac", "1", "-i", "pipe:0",
    "-c:a", "libopus", "-b:a", "64k", file,
  ], { input: Buffer.from(pcm.buffer) });
  if (r.status !== 0) throw new Error(`ffmpeg 失败：${r.stderr}`);
}

fs.mkdirSync(OUT, { recursive: true });
const list = [];
for (let id = 1; id <= MAX_ID; id++) {
  const s = record(id);
  if (!s) { console.log(id.toString(16), "无声"); continue; }
  const file = `se-${id.toString(16).padStart(2, "0")}.ogg`;
  encode(s, path.join(OUT, file));
  list.push({ id, file, duration: +(s.length / RATE).toFixed(3) });
  console.log(file, (s.length / RATE).toFixed(2) + "s");
}
fs.writeFileSync(path.join(ROOT, "data/sfx.json"), JSON.stringify({
  note: "由 tools/extract-sfx.js 生成。原版音效录音在 assets/original/sfx/，编号 = 驱动里的音效号",
  sfx: list,
}, null, 2) + "\n");
