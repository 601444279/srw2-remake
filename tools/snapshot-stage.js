// 从模拟器存档里读出当前关卡的单位快照（位置、图标、数值），并导出单位的地图图标。
// 在机体数据表（data/units.json）完成之前，重制版原型用这份快照跑第一关。
//
// 用法: node tools/snapshot-stage.js <存档.json> <关卡号>
// 输出: data/snapshots/stageNN.json、assets/original/icons/bBB-CC.png（BB = 1KB CHR bank，CC = 图块编号）
import fs from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import { createEmu } from "./emu.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const SLOTS = 32;
// 运行时单位表：每个字段 32 格，第 i 个单位在 基址 + i（见 docs/notes-maps.md）
const FIELD = {
  paramA: 0x7537, paramB: 0x7557, paramC: 0x7577,
  x: 0x7597, y: 0x75b7, icon: 0x75d7,
  move: 0x7637, strength: 0x7657, defense: 0x7677, speed: 0x7697,
  hpLo: 0x76b7, hpHi: 0x76d7, maxHpLo: 0x76f7, maxHpHi: 0x7717,
  portrait: 0x7737, flags: 0x7757, paramD: 0x7777,
};
const FIRST_ENEMY_SLOT = 14;
// 单位图标在背景层，我方用 2 号色板，敌人用 3 号（见 docs/notes-maps.md）
const PALETTES = { player: [0x0f, 0x30, 0x21, 0x02], enemy: [0x0f, 0x37, 0x27, 0x16] };
const NES_COLORS = [0x525252, 0xb40000, 0xa00000, 0xb1003d, 0x740069, 0x00005b, 0x00005f, 0x001840, 0x002f10, 0x084a08, 0x006700, 0x124200, 0x6d2800, 0x000000, 0x000000, 0x000000, 0xc4d5e7, 0xff4000, 0xdc0e22, 0xff476b, 0xd7009f, 0x680ad7, 0x0019bc, 0x0054b1, 0x006a5b, 0x008c03, 0x00ab00, 0x2c8800, 0xa47200, 0x000000, 0x000000, 0x000000, 0xf8f8f8, 0xffab3c, 0xff7981, 0xff5bc5, 0xff48f2, 0xdf49ff, 0x476dff, 0x00b4f7, 0x00e0ff, 0x00e375, 0x03f42b, 0x78b82e, 0xe5e218, 0x787878, 0x000000, 0x000000, 0xffffff, 0xfff2be, 0xf8b8b8, 0xf8b8d8, 0xffb6ff, 0xffc3ff, 0xc7d1ff, 0x9adaff, 0x88edf8, 0x83ffdd, 0xb8f8b8, 0xf5f8ac, 0xffffb0, 0xf8d8f8, 0x000000, 0x000000];

// 地图区域在每帧开头设置 CHR bank（R2–R4 决定 $0000–$0BFF），状态栏再用中断换掉，所以要在帧开头记录
function mapChrBanks(emu) {
  const mm = emu.nes.mmap;
  const regs = {};
  const orig = mm.executeCommand.bind(mm);
  mm.executeCommand = (cmd, arg) => {
    if (emu.nes.ppu.scanline < 20 && cmd >= 2 && cmd <= 5) regs[cmd] = arg;
    orig(cmd, arg);
  };
  emu.frames(2);
  mm.executeCommand = orig;
  // CHR A12 反转模式下，R2–R5 依次对应 $0000、$0400、$0800、$0C00
  return [regs[2], regs[3], regs[4], regs[5]];
}

function renderIcon(chr, bank1k, code, palette) {
  const png = new PNG({ width: 16, height: 16 });
  for (let q = 0; q < 4; q++) {
    const base = bank1k * 0x400 + ((code + q) & 0x3f) * 16;
    for (let y = 0; y < 8; y++) {
      const lo = chr[base + y], hi = chr[base + y + 8];
      for (let x = 0; x < 8; x++) {
        const v = ((lo >> (7 - x)) & 1) | (((hi >> (7 - x)) & 1) << 1);
        const p = (((q >> 1) * 8 + y) * 16 + (q & 1) * 8 + x) * 4;
        const c = NES_COLORS[palette[v]];
        png.data[p] = c & 0xff; png.data[p + 1] = (c >> 8) & 0xff; png.data[p + 2] = (c >> 16) & 0xff;
        png.data[p + 3] = 255; // 原版单位是背景图块，整格替换地形，0 号色就是黑底
      }
    }
  }
  return PNG.sync.write(png);
}

function main(statePath, stageArg) {
  const stage = Number(stageArg);
  const emu = createEmu();
  emu.load(statePath);
  const banks = mapChrBanks(emu);
  const m = emu.nes.cpu.mem;
  const rom = fs.readFileSync(path.join(ROOT, "rom/srw2.nes"));
  const chr = rom.subarray(16 + rom[4] * 0x4000);

  const units = [];
  for (let slot = 0; slot < SLOTS; slot++) {
    const f = (name) => m[FIELD[name] + slot];
    if (f("flags") === 0) continue;
    const side = slot < FIRST_ENEMY_SLOT ? "player" : "enemy";
    const icon = f("icon");
    const bank = banks[icon >> 6];
    const iconFile = `b${bank}-${icon.toString(16).padStart(2, "0")}-${side}.png`;
    const iconPath = path.join(ROOT, "assets/original/icons", iconFile);
    fs.mkdirSync(path.dirname(iconPath), { recursive: true });
    fs.writeFileSync(iconPath, renderIcon(chr, bank, icon, PALETTES[side]));
    units.push({
      slot, side, x: f("x"), y: f("y"),
      icon: `icons/${iconFile}`,
      move: f("move"), strength: f("strength"), defense: f("defense"), speed: f("speed"),
      hp: f("hpLo") | (f("hpHi") << 8), maxHp: f("maxHpLo") | (f("maxHpHi") << 8),
      raw: { paramA: f("paramA"), paramB: f("paramB"), paramC: f("paramC"), paramD: f("paramD"), portrait: f("portrait"), flags: f("flags") },
    });
  }

  const out = path.join(ROOT, `data/snapshots/stage${String(stage).padStart(2, "0")}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const note = "从模拟器内存读出的临时快照，机体数据表完成后由 data/units.json 取代";
  const text = JSON.stringify({ stage, note, units }, null, 2).replace(/\{\s+("paramA"[^{}]*?)\s+\}/g, (_, b) => `{ ${b.replace(/\s+/g, " ")} }`);
  fs.writeFileSync(out, text + "\n");
  console.log(`关卡 ${stage}：${units.length} 个单位，CHR bank ${banks.join("/")}`);
}

main(...process.argv.slice(2));
