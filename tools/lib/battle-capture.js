// 战斗画面采集：在模拟器上记录每帧的 PPU 状态（按扫描线的 CHR bank、OAM 归属对象），
// 并用同样的规则把背景 / 精灵画成 RGBA，供 tools/extract-battle-gfx.js 导出和核对。
//
// 战斗画面上半屏（y < 116）的 CHR bank 在 vblank 里设好，y ≈ 116 起中断换成窗口用的 bank，
// 所以按扫描线记录 MMC3 R0–R5 的写入，渲染时按行取当时的值。
import fs from "node:fs";
import path from "node:path";
import { makeEmu, ROOT, hookExec, hookWrite, trackBanks } from "./trace.js";

const rom = fs.readFileSync(path.join(ROOT, "rom/srw2.nes"));
export const CHR = rom.subarray(16 + rom[4] * 0x4000);

// jsnes 的 NTSC 调色板（0xBBGGRR），和 tools/extract-portraits.js 相同
export const NES_COLORS = [0x525252, 0xb40000, 0xa00000, 0xb1003d, 0x740069, 0x00005b, 0x00005f, 0x001840, 0x002f10, 0x084a08, 0x006700, 0x124200, 0x6d2800, 0x000000, 0x000000, 0x000000, 0xc4d5e7, 0xff4000, 0xdc0e22, 0xff476b, 0xd7009f, 0x680ad7, 0x0019bc, 0x0054b1, 0x006a5b, 0x008c03, 0x00ab00, 0x2c8800, 0xa47200, 0x000000, 0x000000, 0x000000, 0xf8f8f8, 0xffab3c, 0xff7981, 0xff5bc5, 0xff48f2, 0xdf49ff, 0x476dff, 0x00b4f7, 0x00e0ff, 0x00e375, 0x03f42b, 0x78b82e, 0xe5e218, 0x787878, 0x000000, 0x000000, 0xffffff, 0xfff2be, 0xf8b8b8, 0xf8b8d8, 0xffb6ff, 0xffc3ff, 0xc7d1ff, 0x9adaff, 0x88edf8, 0x83ffdd, 0xb8f8b8, 0xf5f8ac, 0xffffb0, 0xf8d8f8, 0x000000, 0x000000];

// jsnes 的扫描线 21 = 画面第 0 行
const FIRST_VISIBLE = 21;
// 精灵引擎（固定 bank $D194，X = 对象槽）写 OAM 缓冲 $0200 的 y 字节的指令
const SPRITE_ENGINE = 0xd194, OAM_Y_WRITE = 0xd241;

// 给模拟器装采集钩子。之后每次 nes.frame() 前调 cap.beginFrame()，之后调 cap.snapshot() 取这一帧的状态
export function attachCapture(emu) {
  const nes = emu.nes, mm = nes.mmap, cpu = nes.cpu;
  const slots = trackBanks(nes);
  let regLog = [], startRegs = null, startInv = 0, scroll = null;
  const m = cpu.mem;
  // 上半屏的卷动：NMI 在帧开头按 $62/$63/$60 设 $2005（窗口部分由中断另设），游戏在这一帧里改的值下一帧才生效，
  // 所以取帧开始时的值
  const readScroll = () => ({ x: m[0x62] + ((m[0x60] & 1) << 8), y: m[0x63] });
  const origExec = mm.executeCommand.bind(mm);
  mm.executeCommand = (cmd, arg) => {
    if (cmd < 6) regLog.push([nes.ppu.scanline, cmd, arg, mm.chrAddressSelect ? 1 : 0]);
    return origExec(cmd, arg);
  };
  // OAM 缓冲每项由哪个对象写的：精灵引擎写 y 时记下当前对象槽，其他代码写的记 -1
  const owner = new Int8Array(64).fill(-1);
  let dmaOwner = new Int8Array(64).fill(-1);
  let curObj = -1, lastPc = 0;
  hookExec(nes, (pc) => {
    lastPc = pc;
    if (pc === SPRITE_ENGINE) curObj = cpu.REG_X;
  });
  hookWrite(nes, (a) => {
    if (a >= 0x200 && a < 0x300 && (a & 3) === 0) owner[(a - 0x200) >> 2] = lastPc === OAM_Y_WRITE ? curObj : -1;
    else if (a === 0x4014) dmaOwner = owner.slice();
  });
  return {
    slots,
    beginFrame() {
      regLog = [];
      startRegs = mm.chrRegs.slice();
      startInv = mm.chrAddressSelect ? 1 : 0;
      scroll = readScroll();
    },
    // light = true 时不复制画面缓冲（只要 PPU 状态时用，省时间）
    snapshot(light = false) {
      const ppu = nes.ppu;
      const vram = ppu.vramMem;
      // 垂直镜像：名称表 0、1 左右并排
      const nt = [0, 1].map((i) => Uint8Array.from(vram.subarray(0x2000 + ppu.ntable1[i] * 0x400, 0x2000 + ppu.ntable1[i] * 0x400 + 0x400)));
      return {
        nt,
        palette: Uint8Array.from(vram.subarray(0x3f00, 0x3f20)),
        oam: Uint8Array.from(ppu.spriteMem),
        owner: dmaOwner.slice(),
        startRegs, startInv, regLog: regLog.slice(),
        chrRam: Uint8Array.from(mm.chrRam),
        bgPT: ppu.f_bgPatternTable, spPT: ppu.f_spPatternTable, spSize: ppu.f_spriteSize,
        objects: Array.from({ length: 16 }, (_, i) => ({
          flags: m[0x700 + i], x: m[0x710 + i], y: m[0x720 + i], frame: m[0x730 + i], type: m[0x740 + i],
        })),
        scroll: scroll ?? readScroll(),
        frameBuffer: light ? null : Uint32Array.from(ppu.buffer),
      };
    },
  };
}

// 第 y 行（画面坐标）生效的 CHR 寄存器和 A12 反转位
export function regsAtLine(s, y) {
  const regs = s.startRegs.slice();
  let inv = s.startInv;
  for (const [sl, cmd, arg, iv] of s.regLog) {
    if (sl - FIRST_VISIBLE > y) break;
    regs[cmd] = arg; inv = iv;
  }
  return { regs, inv };
}

// 图案表地址 → CHR 字节（1KB bank 0、1 是 CHR RAM）
function chrByte(s, regs, inv, addr) {
  const l = inv ? addr ^ 0x1000 : addr;
  let bank;
  if (l < 0x800) bank = (regs[0] & 0xfe) + (l >> 10);
  else if (l < 0x1000) bank = (regs[1] & 0xfe) + ((l - 0x800) >> 10);
  else bank = regs[2 + ((l - 0x1000) >> 10)];
  if (bank < 2) return s.chrRam[bank * 0x400 + (l & 0x3ff)];
  return CHR[bank * 0x400 + (l & 0x3ff)];
}

// 图案表地址 addr 对应的 1KB CHR bank 号（导出来源用）
export function chrBankOf(regs, inv, addr) {
  const l = inv ? addr ^ 0x1000 : addr;
  if (l < 0x800) return (regs[0] & 0xfe) + (l >> 10);
  if (l < 0x1000) return (regs[1] & 0xfe) + ((l - 0x800) >> 10);
  return regs[2 + ((l - 0x1000) >> 10)];
}

function tilePixel(s, regs, inv, base, x, y) {
  const lo = chrByte(s, regs, inv, base + y), hi = chrByte(s, regs, inv, base + y + 8);
  return ((lo >> (7 - x)) & 1) | (((hi >> (7 - x)) & 1) << 1);
}

// 画一帧的指定部分到 256×240 的索引缓冲：每像素存 NES 颜色号，-1 = 透明。
//   bgCell(col, row, tile) → 是否画这个名称表格子（不传则不画背景）
//   sprite(i, owner) → 是否画第 i 个 OAM 精灵
//   lines: [y0, y1) 只画这些行
//   limit8: 模拟硬件每条扫描线最多 8 个精灵（OAM 序号小的优先），核对画面时用
export function render(s, { bgCell = null, sprite = null, lines = [0, 240], scroll = { x: 0, y: 0 }, limit8 = false } = {}) {
  const out = new Int16Array(256 * 240).fill(-1);
  const bgOpaque = new Uint8Array(256 * 240);
  const lineRegs = [];
  for (let y = lines[0]; y < lines[1]; y++) lineRegs[y] = regsAtLine(s, y);
  if (bgCell) {
    for (let y = lines[0]; y < lines[1]; y++) {
      const { regs, inv } = lineRegs[y];
      const sy = (y + scroll.y) % 240;
      for (let x = 0; x < 256; x++) {
        const sx = (x + scroll.x) & 511;
        const table = s.nt[sx >> 8];
        const col = (sx & 255) >> 3, row = sy >> 3;
        const tile = table[row * 32 + col];
        if (!bgCell(col + (sx >> 8) * 32, row, tile)) continue;
        const p = tilePixel(s, regs, inv, s.bgPT * 0x1000 + tile * 16, sx & 7, sy & 7);
        if (!p) continue;
        const attr = table[0x3c0 + (row >> 2) * 8 + (col >> 2)];
        const pal = (attr >> (((row & 2) << 1) | (col & 2))) & 3;
        out[y * 256 + x] = s.palette[pal * 4 + p] & 0x3f;
        bgOpaque[y * 256 + x] = 1;
      }
    }
  }
  if (sprite) {
    if (s.spSize) throw new Error("8×16 精灵未实现");
    // 每行能显示的精灵：OAM 里前 8 个落在这一行的
    const shown = new Array(240);
    if (limit8) for (let y = 0; y < 240; y++) {
      shown[y] = new Set();
      for (let i = 0; i < 64 && shown[y].size < 8; i++) { const sy = s.oam[i * 4] + 1; if (y >= sy && y < sy + 8) shown[y].add(i); }
    }
    // OAM 序号小的优先：从后往前画，前面的覆盖后面的
    for (let i = 63; i >= 0; i--) {
      if (!sprite(i, s.owner[i])) continue;
      const sy = s.oam[i * 4] + 1, tile = s.oam[i * 4 + 1], attr = s.oam[i * 4 + 2], sx = s.oam[i * 4 + 3];
      if (sy >= 240) continue;
      for (let py = 0; py < 8; py++) {
        const y = sy + py;
        if (y < lines[0] || y >= lines[1]) continue;
        if (limit8 && !shown[y].has(i)) continue;
        const { regs, inv } = lineRegs[y];
        const ty = attr & 0x80 ? 7 - py : py;
        for (let px = 0; px < 8; px++) {
          const x = sx + px;
          if (x > 255) continue;
          const tx = attr & 0x40 ? 7 - px : px;
          const p = tilePixel(s, regs, inv, s.spPT * 0x1000 + tile * 16, tx, ty);
          if (!p) continue;
          const o = y * 256 + x;
          // 背景优先（bit5）的精灵只在背景透明处显示
          if (attr & 0x20 && bgOpaque[o]) continue;
          out[o] = s.palette[0x10 + (attr & 3) * 4 + p] & 0x3f;
        }
      }
    }
  }
  return out;
}

export const rgbOf = (nesColor) => {
  const c = NES_COLORS[nesColor & 0x3f];
  return [c & 0xff, (c >> 8) & 0xff, (c >> 16) & 0xff];
};

// 不透明像素的包围盒，没有则 null
export function bbox(idx, lines = [0, 240]) {
  let x0 = 256, y0 = 240, x1 = -1, y1 = -1;
  for (let y = lines[0]; y < lines[1]; y++) for (let x = 0; x < 256; x++) {
    if (idx[y * 256 + x] < 0) continue;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

// 和模拟器画面逐像素比较（idx 透明处用背景色 backdrop），返回不同的像素数。
// jsnes 默认 clipToTvSize：画面四边各 8 像素涂黑（模拟电视过扫描），这一圈不比
export const OVERSCAN = 8;
export function diffWithFrame(idx, frameBuffer, backdrop, lines) {
  let diff = 0;
  for (let y = Math.max(lines[0], OVERSCAN); y < Math.min(lines[1], 240 - OVERSCAN); y++) for (let x = OVERSCAN; x < 256 - OVERSCAN; x++) {
    const c = idx[y * 256 + x] < 0 ? backdrop : idx[y * 256 + x];
    if ((NES_COLORS[c] & 0xffffff) !== (frameBuffer[y * 256 + x] & 0xffffff)) diff++;
  }
  return diff;
}

// 跑一个存档：按 input(f) 决定第 f 帧按住哪些键（位掩码，bit0 = A），每帧回调 onFrame(f, snapshot 取法)
export function runBattle(state, { frames, input, setup, onFrame }) {
  const emu = makeEmu(path.join(ROOT, state));
  const cap = attachCapture(emu);
  const nes = emu.nes;
  if (setup) setup(emu, cap);
  let held = 0;
  for (let f = 0; f < frames; f++) {
    const want = input(f);
    for (let b = 0; b < 8; b++) {
      const bit = 1 << b;
      if (want & bit && !(held & bit)) nes.buttonDown(1, b);
      if (!(want & bit) && held & bit) nes.buttonUp(1, b);
    }
    held = want;
    cap.beginFrame();
    nes.frame();
    if (onFrame && onFrame(f, cap, emu) === false) break;
  }
  return emu;
}

// 按「世界坐标」画：两个名称表左右并排共 512 像素宽，不受卷动影响；精灵按当帧卷动换算到世界坐标。
// 远距离战斗时两台机体分别画在两个名称表上，镜头靠卷动在它们之间移动，所以特效要在世界坐标里记录。
//   bgCell(col 0–63, row, tile) / sprite(i, owner) 同 render；rows: 只画这些名称表行
export function renderWorld(s, { bgCell = null, sprite = null, rows = [0, 15] } = {}) {
  const W = 512;
  const out = new Int16Array(W * 240).fill(-1);
  const bgOpaque = new Uint8Array(W * 240);
  if (bgCell) {
    for (let y = rows[0] * 8; y < rows[1] * 8; y++) {
      const { regs, inv } = regsAtLine(s, y);
      const row = y >> 3;
      for (let x = 0; x < W; x++) {
        const table = s.nt[x >> 8], col = (x & 255) >> 3;
        const tile = table[row * 32 + col];
        if (!bgCell(col + (x >> 8) * 32, row, tile)) continue;
        const p = tilePixel(s, regs, inv, s.bgPT * 0x1000 + tile * 16, x & 7, y & 7);
        if (!p) continue;
        const attr = table[0x3c0 + (row >> 2) * 8 + (col >> 2)];
        const pal = (attr >> (((row & 2) << 1) | (col & 2))) & 3;
        out[y * W + x] = s.palette[pal * 4 + p] & 0x3f;
        bgOpaque[y * W + x] = 1;
      }
    }
  }
  if (sprite) {
    for (let i = 63; i >= 0; i--) {
      if (!sprite(i, s.owner[i])) continue;
      const sy = s.oam[i * 4] + 1, tile = s.oam[i * 4 + 1], attr = s.oam[i * 4 + 2], sx = s.oam[i * 4 + 3];
      if (sy >= 240) continue;
      for (let py = 0; py < 8; py++) {
        const y = sy + py;
        if (y >= 240) continue;
        const { regs, inv } = regsAtLine(s, y);
        const ty = attr & 0x80 ? 7 - py : py;
        for (let px = 0; px < 8; px++) {
          if (sx + px > 255) continue;
          const x = (sx + px + s.scroll.x) & (W - 1);
          const tx = attr & 0x40 ? 7 - px : px;
          const p = tilePixel(s, regs, inv, s.spPT * 0x1000 + tile * 16, tx, ty);
          if (!p) continue;
          const o = y * W + x;
          if (attr & 0x20 && bgOpaque[o]) continue;
          out[o] = s.palette[0x10 + (attr & 3) * 4 + p] & 0x3f;
        }
      }
    }
  }
  return out;
}

export function bboxW(idx, W) {
  let x0 = W, y0 = 240, x1 = -1, y1 = -1;
  for (let y = 0; y < 240; y++) for (let x = 0; x < W; x++) {
    if (idx[y * W + x] < 0) continue;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}
