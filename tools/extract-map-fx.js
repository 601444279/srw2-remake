// 提取地图上的精神 / 修理特效：原版这些演出都是 15 号对象槽画的精灵（光标是 1 号槽），
// 在模拟器里让太勒（杰克）用某个精神（临时改 ROM 里他的精神列表，同 tools/spirit-probe.js），逐帧把 15 号槽的精灵画出来。
//
// 用法: node tools/extract-map-fx.js
// 输出: assets/original/map-fx/NAME.png  特效各帧（去重后横排）
//       data/map-fx.json                 NAME → cels（图里的 x y w h）、frames（开始帧、帧数、cel、相对目标格左上角的 x y）、
//                                        total（总帧数）、sounds（[帧, 音效号]）
// 目标格：自己身上的特效 = 光标那一格（光标精灵左上角 +1）；敌人身上的（怒、干扰）只录第一个敌人，按特效位置推出它那一格。
import fs from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import { makeEmu, ROOT, hookWrite } from "./lib/trace.js";
import { resolve } from "./lib/res.js";
import { attachCapture, render, rgbOf } from "./lib/battle-capture.js";

const OUT_DIR = path.join(ROOT, "assets/original/map-fx");
const EFFECTS = [
  { name: "heal", spirit: 0, until: 0x05 },   // 毅力：星星绕圈，回复量（05）出来之前
  { name: "wipe", spirit: 1 },                // 加速：蓝色横纹
  { name: "comet", spirit: 2 },               // 瞄准：流星
  { name: "flower", spirit: 3 },              // 防守：花瓣光圈
  { name: "ring", spirit: 4 },                // 强攻：细的蓝色电圈
  { name: "bolt", spirit: 14, enemy: true, until: 0x05 },   // 怒：闪电（第一个敌人）
  { name: "jam", spirit: 16, enemy: true, until: 0x17, nth: 2, center: true },   // 干扰：圆环（第一个敌人，第二声 17 是下一个敌人）
];

function record({ spirit, enemy, until, nth = 1, center = false }) {
  const emu = makeEmu(path.join(ROOT, "extracted/states/map-cursor.json"));
  const nes = emu.nes, m = nes.cpu.mem;
  const r = resolve(0x84, 0x11); // 太勒的驾驶员杰克
  const bank = r.addr < 0xa000 ? r.bank : r.bank + 1;
  const rom = nes.rom.rom[bank >> 1];
  const off = (bank & 1) * 8192 + ((r.addr + 2) & 0x1fff);
  const mask = 1 << (23 - spirit);
  rom[off] = mask >> 16; rom[off + 1] = (mask >> 8) & 0xff; rom[off + 2] = mask & 0xff;
  m[0x7827] = 250;
  for (let u = 0; u < 6; u++) { m[0x76b7 + u] = 50; m[0x76d7 + u] = 0; }
  const cap = attachCapture(emu);
  emu.frames(10); emu.press("a"); emu.frames(30); emu.press("right"); emu.frames(10); emu.press("a"); emu.frames(40);
  cap.beginFrame(); nes.frame();
  const base = cap.snapshot(true);
  // 光标精灵（1 号槽）最左上那块 +1 = 光标所在格的左上角
  let cx = 999, cy = 999;
  for (let i = 0; i < 64; i++) if (base.owner[i] === 1) { cx = Math.min(cx, base.oam[i * 4 + 3] + 1); cy = Math.min(cy, base.oam[i * 4] + 1); }
  let f = 0, stop = false;
  const sounds = [];
  let hits = 0;
  hookWrite(nes, (a, v) => {
    if (a !== 0x4c || !v || v >= 0x80) return;
    sounds.push([f, v]);
    if (until !== undefined && v === until && ++hits >= nth) stop = true;
  });
  const layers = [];
  let seen = false, gone = 0, first = -1;
  nes.buttonDown(1, 0);
  for (; f < 600 && !stop; f++) {
    if (f === 6) nes.buttonUp(1, 0);
    cap.beginFrame(); nes.frame();
    const s = cap.snapshot(true);
    const idx = render(s, { sprite: (i, owner) => owner === 15 });
    const any = idx.some((v) => v >= 0);
    if (any) { if (first < 0) first = f; seen = true; gone = 0; }
    else if (seen && ++gone > (enemy ? 6 : 20)) break;
    if (first >= 0) layers.push(idx);
  }
  // 末尾的空帧去掉
  while (layers.length && !layers.at(-1).some((v) => v >= 0)) layers.pop();
  // 目标格
  let tile = { x: cx, y: cy };
  if (enemy) {
    let x0 = 256, x1 = -1, y0 = 240, y1 = -1;
    for (const idx of layers) for (let y = 0; y < 240; y++) for (let x = 0; x < 256; x++) if (idx[y * 256 + x] >= 0) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    // 闪电从天上劈下来，底端落在目标格；圆环以目标格为中心
    const midX = (x0 + x1) / 2, midY = (y0 + y1) / 2;
    tile = { x: Math.floor(midX / 16) * 16, y: Math.floor((center ? midY : y1 - 1) / 16) * 16 };
  }
  return { layers, tile, sounds: sounds.filter(([sf]) => sf >= first).map(([sf, v]) => [sf - first, v]) };
}

function exportFx(name, { layers, tile, sounds }) {
  const cels = [], keys = new Map(), frames = [];
  let atlasW = 0, atlasH = 0;
  for (const [i, idx] of layers.entries()) {
    let x0 = 256, y0 = 240, x1 = -1, y1 = -1;
    for (let y = 0; y < 240; y++) for (let x = 0; x < 256; x++) if (idx[y * 256 + x] >= 0) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    let cel = -1;
    if (x1 >= 0) {
      const w = x1 - x0 + 1, h = y1 - y0 + 1;
      const px = [];
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) px.push(idx[y * 256 + x]);
      const key = `${w}x${h}:${px.join(",")}`;
      if (!keys.has(key)) { keys.set(key, cels.length); cels.push({ w, h, px, x: atlasW }); atlasW += w + 1; atlasH = Math.max(atlasH, h); }
      cel = keys.get(key);
    }
    const x = x1 >= 0 ? x0 - tile.x : 0, y = x1 >= 0 ? y0 - tile.y : 0;
    const last = frames.at(-1);
    if (last && last.cel === cel && last.x === x && last.y === y) last.duration++;
    else frames.push({ start: i, duration: 1, cel, x, y });
  }
  const png = new PNG({ width: Math.max(1, atlasW), height: Math.max(1, atlasH) });
  for (const c of cels) for (let y = 0; y < c.h; y++) for (let x = 0; x < c.w; x++) {
    const v = c.px[y * c.w + x];
    if (v < 0) continue;
    const [r, g, b] = rgbOf(v);
    const o = (y * png.width + c.x + x) * 4;
    png.data[o] = r; png.data[o + 1] = g; png.data[o + 2] = b; png.data[o + 3] = 255;
  }
  fs.writeFileSync(path.join(OUT_DIR, `${name}.png`), PNG.sync.write(png));
  return {
    file: `${name}.png`,
    cels: cels.map((c) => [c.x, 0, c.w, c.h]),
    frames: frames.map((k) => (k.cel < 0 ? [k.start, k.duration] : [k.start, k.duration, k.cel, k.x, k.y])),
    total: layers.length,
    sounds,
  };
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const out = {};
for (const e of EFFECTS) {
  const rec = record(e);
  out[e.name] = exportFx(e.name, rec);
  console.log(`${e.name}: ${rec.layers.length} 帧，${out[e.name].cels.length} 个 cel，目标格 ${rec.tile.x},${rec.tile.y}，音效 ${rec.sounds.map(([f, v]) => `${f}:${v.toString(16)}`).join(" ")}`);
}
fs.writeFileSync(path.join(ROOT, "data/map-fx.json"), JSON.stringify({
  note: "地图上的精神 / 修理特效（原版 15 号对象槽的精灵），由 tools/extract-map-fx.js 生成。frames 每项：开始帧、帧数、cel、相对目标格左上角的 x、y（原版像素，格子 16×16）；没有 cel 的是空帧。sounds：[帧, 音效号]",
  effects: out,
}) + "\n");
