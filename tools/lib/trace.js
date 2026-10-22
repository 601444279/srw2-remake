// 规则逆向用的追踪工具：在 tools/emu.js 的模拟器上挂执行、读写钩子，记录 PRG bank 映射。
// 钩子要在 emu.load() 之后安装（读档会替换 mapper 等对象）。
import fs from "node:fs";
import path from "node:path";
import { createEmu } from "../emu.js";

export const ROOT = path.resolve(import.meta.dirname, "../..");
const romFile = fs.readFileSync(path.join(ROOT, "rom/srw2.nes"));
export const PRG = romFile.subarray(16, 16 + 256 * 1024);
export const LAST_BANK = 31;

// 读 ROM 里某个 8KB bank 在 CPU 地址 addr 处的字节（addr 只用低 13 位）
export function prgByte(bank, addr) {
  return PRG[bank * 0x2000 + (addr & 0x1fff)];
}

export function makeEmu(state) {
  const emu = createEmu();
  if (state) emu.load(state);
  return emu;
}

// 当前四个 8KB 槽位（$8000/$A000/$C000/$E000）映射的 bank。
// jsnes 的 MMC3 切换 bank 时把数据整块复制进 CPU 内存，这里按内容抽样比对反推。
export function currentBanks(nes) {
  // 直接比较内存内容反推 bank，最可靠
  const res = [];
  for (let slot = 0; slot < 4; slot++) {
    const base = 0x8000 + slot * 0x2000;
    let found = -1;
    for (let b = 0; b < 32; b++) {
      let ok = true;
      for (let k = 0; k < 64; k += 7) {
        if (nes.cpu.mem[base + k * 97 % 0x2000] !== PRG[b * 0x2000 + (k * 97 % 0x2000)]) { ok = false; break; }
      }
      if (ok) { found = b; break; }
    }
    res.push(found);
  }
  return res;
}

// 跟踪 bank 切换：包装 load8kRomBank，维护 slots[4]
export function trackBanks(nes) {
  const slots = currentBanks(nes);
  const m = nes.mmap;
  const orig = m.load8kRomBank.bind(m);
  m.load8kRomBank = (bank8k, address) => {
    slots[(address - 0x8000) >> 13] = bank8k % 32;
    return orig(bank8k, address);
  };
  return slots;
}

// 每条指令执行前回调 fn(pc, cpu)
export function hookExec(nes, fn) {
  const cpu = nes.cpu;
  const orig = cpu.emulate.bind(cpu);
  cpu.emulate = () => {
    fn((cpu.REG_PC + 1) & 0xffff, cpu);
    return orig();
  };
  return () => { cpu.emulate = orig; };
}

// 写内存回调 fn(addr, val, pc)
export function hookWrite(nes, fn) {
  const cpu = nes.cpu;
  const orig = cpu.write.bind(cpu);
  cpu.write = (addr, val) => {
    fn(addr, val, (cpu.REG_PC + 1) & 0xffff);
    return orig(addr, val);
  };
  return () => { cpu.write = orig; };
}

export function hookRead(nes, fn) {
  const cpu = nes.cpu;
  const orig = cpu.load.bind(cpu);
  cpu.load = (addr) => {
    const v = orig(addr);
    fn(addr, v);
    return v;
  };
  return () => { cpu.load = orig; };
}

export const hex = (v, n = 2) => v.toString(16).toUpperCase().padStart(n, "0");
