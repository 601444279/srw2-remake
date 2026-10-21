// 无界面运行 ROM，按脚本输入按键，截图、存档，用来逆向原版画面。
//
// 用法: node tools/emu.js <脚本文件> [--from 存档.json]
// 脚本每行一条指令:
//   wait 60            空跑 60 帧
//   press start [8]    按住按键若干帧(默认 6)后松开，再空跑 10 帧
//   shot title         截图到 extracted/shots/title.png
//   save title         存档到 extracted/states/title.json
//   dump title         导出 PPU 状态(名称表、调色板、OAM、图案表)到 extracted/dumps/title.json
import fs from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import { NES, Controller } from "jsnes";
import "../src/emu/waixing-mmc3.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT = path.join(ROOT, "extracted");
const KEYS = {
  a: Controller.BUTTON_A, b: Controller.BUTTON_B,
  select: Controller.BUTTON_SELECT, start: Controller.BUTTON_START,
  up: Controller.BUTTON_UP, down: Controller.BUTTON_DOWN,
  left: Controller.BUTTON_LEFT, right: Controller.BUTTON_RIGHT,
};

export function createEmu(romPath = path.join(ROOT, "rom/srw2.nes")) {
  let frameBuffer = null;
  const nes = new NES({
    emulateSound: false,
    onFrame: (fb) => { frameBuffer = fb; },
  });
  nes.loadROM(new Uint8Array(fs.readFileSync(romPath)));

  const emu = {
    nes,
    frames(n) { for (let i = 0; i < n; i++) nes.frame(); },
    press(key, hold = 6) {
      const k = KEYS[key];
      if (k === undefined) throw new Error(`未知按键 ${key}`);
      nes.buttonDown(1, k); emu.frames(hold);
      nes.buttonUp(1, k); emu.frames(10);
    },
    screenshot(file) {
      const png = new PNG({ width: 256, height: 240 });
      for (let i = 0; i < 256 * 240; i++) {
        const c = frameBuffer[i];
        png.data[i * 4] = c & 0xff;
        png.data[i * 4 + 1] = (c >> 8) & 0xff;
        png.data[i * 4 + 2] = (c >> 16) & 0xff;
        png.data[i * 4 + 3] = 255;
      }
      write(file, PNG.sync.write(png));
    },
    save(file) { write(file, JSON.stringify(nes.toJSON())); },
    load(file) { nes.fromJSON(JSON.parse(fs.readFileSync(file, "utf8"))); emu.frames(1); },
    dumpPpu(file) {
      const ppu = nes.ppu;
      for (let s = 0; s < 8; s++) nes.mmap.saveChrRamSlot?.(s << 10);
      const vram = Array.from(ppu.vramMem.slice(0, 0x3f20));
      write(file, JSON.stringify({
        patterns: vram.slice(0, 0x2000),
        nametables: [0, 1, 2, 3].map((i) => {
          const base = 0x2000 + ppu.ntable1[i] * 0x400;
          return vram.slice(base, base + 0x400);
        }),
        palette: vram.slice(0x3f00, 0x3f20),
        oam: Array.from(ppu.spriteMem),
        bgPatternTable: ppu.f_bgPatternTable,
        spPatternTable: ppu.f_spPatternTable,
        spriteSize: ppu.f_spriteSize,
        scroll: { x: ppu.regFH | (ppu.regHT << 3), y: ppu.regFV | (ppu.regVT << 3) },
        chrBanks: nes.mmap.chrRamSlots,
        ram: Array.from(nes.cpu.mem.slice(0, 0x800)),
        sram: Array.from(nes.cpu.mem.slice(0x6000, 0x8000)),
      }));
    },
  };
  return emu;
}

function write(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
}

export function runScript(emu, text) {
  for (const raw of text.split("\n")) {
    const [cmd, arg, arg2] = raw.replace(/#.*/, "").trim().split(/\s+/);
    if (!cmd) continue;
    if (cmd === "wait") emu.frames(Number(arg));
    else if (cmd === "press") emu.press(arg, arg2 ? Number(arg2) : undefined);
    else if (cmd === "shot") emu.screenshot(path.join(OUT, "shots", `${arg}.png`));
    else if (cmd === "save") emu.save(path.join(OUT, "states", `${arg}.json`));
    else if (cmd === "dump") emu.dumpPpu(path.join(OUT, "dumps", `${arg}.json`));
    else throw new Error(`未知指令: ${raw}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const from = args.indexOf("--from");
  const emu = createEmu();
  if (from !== -1) emu.load(args.splice(from, 2)[1]);
  const script = args[0] === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(args[0], "utf8");
  runScript(emu, script);
}
