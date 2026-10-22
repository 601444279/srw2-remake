// 导出 BGM：在模拟器里让音乐驱动逐首播放，自动找循环点，输出两个版本（Ogg Opus）：
//   原版录音   assets/original/music/bgm-XX.ogg（单声道，APU 原声）
//   增强版     assets/music/bgm-XX.ogg（立体声，用原版乐谱重新合成，见 tools/lib/music-synth.js）
// 以及 data/music.json：每首的时长和循环点，加上从 ROM 读出的“什么场合放哪首”。
//
// 用法: node tools/extract-music.js [曲号(16进制) ...]   只给曲号时只重做这几首，不改 data/music.json
//
// 音乐驱动在 bank 24（每帧 NMI 调 $8020）。游戏往 $4C 写 $80+曲号 切歌，$C81F 读曲目表
// （bank 0 $8000 的指针指向的表，每首 12 字节：4 字节参数 + 4 个声道的数据指针）。
// 一共 $15 首。
//
// 找循环：每帧记录驱动的乐谱进度，第一次回到之前某帧的进度时，两帧之间就是一个循环。
// 找到后再比对两段音频确认（循环前后 4 秒内写进 APU 的寄存器逐帧比较，输出相同的比例）。
// 所有声道都停了的曲子（短的过场音乐）不循环。
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { NES } from "jsnes";
import "../src/emu/waixing-mmc3.js";
import { attachCapture, renderEnhanced } from "./lib/music-synth.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT_ORIGINAL = path.join(ROOT, "assets/original/music");
const OUT_ENHANCED = path.join(ROOT, "assets/music");
const PRG = fs.readFileSync(path.join(ROOT, "rom/srw2.nes")).subarray(16, 16 + 256 * 1024);
const RATE = 48000;
const SONGS = 0x15;
const MAX_FRAMES = 60 * 60 * 6; // 最长找 6 分钟
// 循环点往后挪一点再写进文件：编码器在开头加的延迟只会让两个点一起平移，
// 只要平移量小于这个余量，循环接缝仍然落在完全重复的音频上
const LOOP_MARGIN = 0.5;
const TAIL = 2; // 循环结束后多录几秒，同样是给平移留余量

// 判断“乐谱走到同一个位置”用的 RAM：各声道的数据指针、时长计数、重复 / 子程序计数，加上声道开关和速度。
// 驱动里还有包络、颤音相位和全局计数器在走，它们不影响后面播什么，算进来反而永远找不到重复
const SEQ_RAM = [
  ...range(0x4e, 0x51), ...range(0x54, 0x57),
  ...range(0x42c, 0x44b), ...range(0x464, 0x46f),
];

function range(a, b) {
  return Array.from({ length: b - a + 1 }, (_, i) => a + i);
}

function record(song) {
  const samples = [];
  let capture = null;
  const nes = new NES({
    emulateSound: true,
    sampleRate: RATE,
    onFrame() {},
    onAudioSample: (l, r) => { samples.push((l + r) / 2); capture?.sample(); },
  });
  nes.loadROM(new Uint8Array(fs.readFileSync(path.join(ROOT, "rom/srw2.nes"))));
  // 从标题画面存档开始。主循环停在 SRAM 里的一条死循环上（JMP $7F00），不让游戏逻辑碰音乐；
  // NMI 照常触发，音乐驱动照常每帧跑
  nes.fromJSON(JSON.parse(fs.readFileSync(path.join(ROOT, "extracted/states/title.json"), "utf8")));
  nes.frame();
  nes.cpu.mem.set([0x4c, 0x00, 0x7f], 0x7f00);
  nes.cpu.REG_PC = 0x7f00 - 1;
  samples.length = 0;
  capture = attachCapture(nes);
  nes.cpu.mem[0x4c] = 0x80 + song;
  // 每帧写进 APU 的寄存器，用来校验循环
  const apu = [];
  let frameLog = "";
  const write = nes.cpu.write.bind(nes.cpu);
  nes.cpu.write = (a, v) => {
    // 标题画面会在 NMI 里定时淡出、换下一首（像个播放列表），拦掉除驱动应答（$FF）以外的切歌请求
    if (a === 0x4c && v !== 0xff) return;
    if (a >= 0x4000 && a <= 0x4015 && a !== 0x4014) frameLog += `${a}=${v} `;
    return write(a, v);
  };

  const step = () => { frameLog = ""; nes.frame(); apu.push(frameLog); };

  const seen = new Map();
  const frameStart = [];
  let loop = null;
  for (let f = 0; f < MAX_FRAMES; f++) {
    frameStart.push(samples.length);
    step();
    if (f === 0 && nes.cpu.mem[0x4c] !== 0xff) throw new Error(`曲 ${song} 没有被驱动接收`);
    const mem = nes.cpu.mem;
    const key = SEQ_RAM.map((a) => mem[a]).join(",");
    const prev = seen.get(key);
    // 状态在第 f 帧末尾回到第 prev 帧末尾的样子，说明第 f 帧做的事和第 prev 帧一样（例如都是从头开始）
    if (prev !== undefined) { loop = { from: prev, to: f }; break; }
    seen.set(key, f);
  }
  if (!loop) throw new Error(`曲 ${song} 在 ${MAX_FRAMES} 帧内没找到循环`);
  frameStart.push(samples.length);

  // 所有声道停止，或者“循环”短得不像曲子（结尾停在一个空循环上）→ 不循环，录一会儿再裁掉静音
  const stopped = [0, 1, 2, 3].every((ch) => !(nes.cpu.mem[0x4e + ch] & 0x40));
  const at = (frame) => frameStart[frame];
  if (stopped || loop.to - loop.from < 60) {
    while (samples.length < at(loop.from) + RATE) step();
    const trimmed = trimSilence(samples);
    return { samples: trimmed, events: capture.events, loop: null };
  }
  // 多录一段，给循环点平移留余量
  const loopStart = at(loop.from), loopEnd = at(loop.to);
  const want = loopEnd + Math.round((LOOP_MARGIN + TAIL) * RATE);
  while (samples.length < want) step();
  // 校验：循环点前后各 4 秒的 APU 写入应该基本一样（包络、颤音相位没对齐会有少量不同）
  const n = 240;
  while (apu.length < loop.to + n) step();
  let same = 0;
  for (let i = 0; i < n; i++) if (apu[loop.from + i] === apu[loop.to + i]) same++;
  const seam = same / n;
  return {
    seam,
    samples: samples.slice(0, want),
    events: capture.events,
    loopSamples: { from: loopStart, to: loopEnd },
    loop: { start: loopStart / RATE + LOOP_MARGIN, end: loopEnd / RATE + LOOP_MARGIN },
  };
}

function trimSilence(s) {
  let end = s.length;
  while (end > 0 && Math.abs(s[end - 1] - s[s.length - 1]) < 1e-4) end--;
  return s.slice(0, Math.min(s.length, end + RATE * 0.2));
}

function encode(channels, file, bitrate) {
  const n = channels[0].length;
  const pcm = new Float32Array(n * channels.length);
  for (let i = 0; i < n; i++) for (let c = 0; c < channels.length; c++) pcm[i * channels.length + c] = channels[c][i];
  const r = spawnSync("ffmpeg", [
    "-v", "error", "-y", "-f", "f32le", "-ar", String(RATE), "-ac", String(channels.length), "-i", "pipe:0",
    "-c:a", "libopus", "-b:a", bitrate, file,
  ], { input: Buffer.from(pcm.buffer), maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(`ffmpeg 失败：${r.stderr}`);
}

// 原版录音：去掉直流偏置，整体放大到合适音量
function original(samples) {
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  return Float32Array.from(samples, (v) => (v - mean) * 1.6);
}

// ---------- 什么场合放哪首（从 ROM 读）----------
const prgByte = (bank, addr) => PRG[bank * 0x2000 + (addr & 0x1fff)];

// 关卡事件脚本（bank 0x1A，见 docs/notes-text.md）里的音乐指令：
//   59 曲  设我方回合音乐（$7529）  5A 曲  设敌方回合音乐（$752A）  5B 曲  立即播放（FB 当前 / FC 我方 / FD 敌方）
// 指令长度没整理完，这里和对话提取一样按字节扫描
function stageMusic() {
  // bank 0x1A 在 $8000、0x1B 在 $A000，按 16KB 连续读
  const byte = (a) => PRG[0x1a * 0x2000 + (a - 0x8000)];
  const word = (a) => byte(a) | (byte(a + 1) << 8);
  const tables = { intro: 0x93a5, map: 0x9721, clear: 0xa49c };
  const starts = new Set();
  for (const t of Object.values(tables)) for (let i = 0; i < 32; i++) starts.add(word(t + i * 2));
  const sorted = [...starts].sort((a, b) => a - b);
  const stages = [];
  for (let stage = 0; stage < 26; stage++) {
    const entry = { player: null, enemy: null, clear: [] };
    for (const [slot, t] of Object.entries(tables)) {
      const start = word(t + stage * 2);
      const end = sorted.find((a) => a > start) ?? start;
      for (let a = start; a < end; a++) {
        const op = byte(a) & 0x7f, arg = byte(a + 1);
        if (arg < 0x80 || arg >= 0x80 + SONGS) continue;
        if (op === 0x59 && slot === "intro") entry.player = arg & 0x3f;
        else if (op === 0x5a && slot === "intro") entry.enemy = arg & 0x3f;
        else if (op === 0x5b && slot === "clear") entry.clear.push(arg & 0x3f);
      }
    }
    stages.push(entry);
  }
  return stages;
}

// 战斗音乐（bank 6 $86AC）：表在 $86D2，每项 2 字节（驾驶员编号、曲号|$80），$FF 结束、后一字节是默认曲。
// 第一项拿防守方以外的另一方（$E6）比对，其余拿 $E5 比对——实际效果是：
// 敌方驾驶员 0x35（贝克）出场放专属曲，否则按我方驾驶员查表
function battleMusic() {
  const byPilot = {};
  let boss = null, fallback = null;
  for (let a = 0x86d2; ; a += 2) {
    const pilot = prgByte(6, a), song = prgByte(6, a + 1) & 0x3f;
    if (pilot === 0xff) { fallback = song; break; }
    if (a === 0x86d2) boss = { pilot, song };
    else byPilot[pilot] = song;
  }
  return { boss, byPilot, default: fallback };
}

fs.mkdirSync(OUT_ORIGINAL, { recursive: true });
fs.mkdirSync(OUT_ENHANCED, { recursive: true });
const tracks = [];
const only = process.argv.slice(2).map((a) => parseInt(a, 16));
for (let song = 0; song < SONGS; song++) {
  if (only.length && !only.includes(song)) continue;
  const { samples, events, loop, loopSamples, seam } = record(song);
  const file = `bgm-${song.toString(16).padStart(2, "0")}.ogg`;
  encode([original(samples)], path.join(OUT_ORIGINAL, file), "64k");
  const tail = Math.round((LOOP_MARGIN + TAIL) * RATE);
  const hd = renderEnhanced(events, { length: samples.length, loop: loopSamples, rate: RATE, tail, margin: Math.round(LOOP_MARGIN * RATE) });
  encode(hd, path.join(OUT_ENHANCED, file), "128k");
  const round = (v) => +v.toFixed(6);
  tracks.push({ id: song, file, loop: loop && { start: round(loop.start), end: round(loop.end) } });
  console.log(file, (samples.length / RATE).toFixed(1) + "s", loop ? `循环 ${round(loop.start)}–${round(loop.end)}  APU 吻合 ${(seam * 100).toFixed(0)}%` : "不循环");
}
if (!only.length) {
  const out = {
    note: "由 tools/extract-music.js 生成。曲号 = 驱动里的编号；原版录音在 assets/original/music/，增强版在 assets/music/，文件名相同、循环点相同（秒）",
    tracks,
    stages: stageMusic(),
    battle: battleMusic(),
  };
  fs.writeFileSync(path.join(ROOT, "data/music.json"), JSON.stringify(out, null, 2) + "\n");
}
