// 录制原版 BGM：在模拟器里让音乐驱动逐首播放，录下 APU 输出，自动找循环点，编码成 Ogg Opus。
//
// 用法: node tools/extract-music.js
// 输出: assets/original/music/bgm-XX.ogg 和 assets/original/music/music.json（循环点）
//
// 音乐驱动在 bank 24（每帧 NMI 调 $8020）。游戏往 $4C 写 $80+曲号 切歌，$C81F 读曲目表
// （bank 0 $8000 的指针指向的表，每首 12 字节：4 字节参数 + 4 个声道的数据指针）。
// 一共 $15 首。
//
// 找循环：每帧记录驱动用到的 RAM，第一次出现和之前某帧完全相同的状态时，两帧之间就是一个循环。
// 所有声道都停了的曲子（短的过场音乐）不循环。
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { NES } from "jsnes";
import "../src/emu/waixing-mmc3.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT = path.join(ROOT, "assets/original/music");
const RATE = 48000;
const SONGS = 0x15;
const MAX_FRAMES = 60 * 60 * 6; // 最长找 6 分钟
// 循环点往后挪一点再写进文件：编码器在开头加的延迟只会让两个点一起平移，
// 只要平移量小于这个余量，循环接缝仍然落在完全重复的音频上
const LOOP_MARGIN = 0.5;
const TAIL = 2; // 循环结束后多录几秒，同样是给平移留余量

// 驱动的状态 RAM（$28–$2F 是临时变量，不算）
const DRIVER_RAM = [
  ...range(0x32, 0x37), ...range(0x3c, 0x4a), ...range(0x4c, 0x5c),
  ...range(0x403, 0x46b),
];

function range(a, b) {
  return Array.from({ length: b - a + 1 }, (_, i) => a + i);
}

function record(song) {
  const samples = [];
  const nes = new NES({
    emulateSound: true,
    sampleRate: RATE,
    onFrame() {},
    onAudioSample: (l, r) => samples.push((l + r) / 2),
  });
  nes.loadROM(new Uint8Array(fs.readFileSync(path.join(ROOT, "rom/srw2.nes"))));
  // 标题画面存档：游戏停在这里不动，不会自己切歌
  nes.fromJSON(JSON.parse(fs.readFileSync(path.join(ROOT, "extracted/states/title.json"), "utf8")));
  nes.frame();
  samples.length = 0;
  nes.cpu.mem[0x4c] = 0x80 + song;

  const seen = new Map();
  const frameStart = [];
  let loop = null;
  for (let f = 0; f < MAX_FRAMES; f++) {
    frameStart.push(samples.length);
    nes.frame();
    if (f === 0 && nes.cpu.mem[0x4c] !== 0xff) throw new Error(`曲 ${song} 没有被驱动接收`);
    const mem = nes.cpu.mem;
    const key = DRIVER_RAM.map((a) => mem[a]).join(",");
    const prev = seen.get(key);
    if (prev !== undefined) { loop = { from: prev + 1, to: f + 1 }; break; }
    seen.set(key, f);
  }
  if (!loop) throw new Error(`曲 ${song} 在 ${MAX_FRAMES} 帧内没找到循环`);
  frameStart.push(samples.length);

  // 所有声道停止 → 不循环，录到静音为止
  const stopped = [0, 1, 2, 3].every((ch) => !(nes.cpu.mem[0x4e + ch] & 0x40));
  const at = (frame) => frameStart[frame];
  if (stopped) {
    return { samples: trimSilence(samples.slice(0, at(loop.from))), loop: null };
  }
  // 多录一段，给循环点平移留余量
  const loopStart = at(loop.from), loopEnd = at(loop.to);
  const want = loopEnd + Math.round((LOOP_MARGIN + TAIL) * RATE);
  while (samples.length < want) nes.frame();
  return {
    samples: samples.slice(0, want),
    loop: { start: loopStart / RATE + LOOP_MARGIN, end: loopEnd / RATE + LOOP_MARGIN },
  };
}

function trimSilence(s) {
  let end = s.length;
  while (end > 0 && Math.abs(s[end - 1] - s[s.length - 1]) < 1e-4) end--;
  return s.slice(0, Math.min(s.length, end + RATE * 0.2));
}

function encode(samples, file) {
  // 去掉直流偏置，再整体放大到合适音量
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  const pcm = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) pcm[i] = (samples[i] - mean) * 1.6;
  const r = spawnSync("ffmpeg", [
    "-v", "error", "-y", "-f", "f32le", "-ar", String(RATE), "-ac", "1", "-i", "pipe:0",
    "-c:a", "libopus", "-b:a", "64k", file,
  ], { input: Buffer.from(pcm.buffer) });
  if (r.status !== 0) throw new Error(`ffmpeg 失败：${r.stderr}`);
}

fs.mkdirSync(OUT, { recursive: true });
const meta = [];
for (let song = 0; song < SONGS; song++) {
  const { samples, loop } = record(song);
  const file = `bgm-${song.toString(16).padStart(2, "0")}.ogg`;
  encode(samples, path.join(OUT, file));
  const entry = { id: song, file, duration: +(samples.length / RATE).toFixed(3), loop: loop && { start: +loop.start.toFixed(4), end: +loop.end.toFixed(4) } };
  meta.push(entry);
  console.log(file, entry.duration + "s", loop ? `循环 ${entry.loop.start}–${entry.loop.end}` : "不循环");
}
fs.writeFileSync(path.join(OUT, "music.json"), JSON.stringify(meta, null, 2) + "\n");
