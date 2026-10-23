// 实测格子事件（events tiles）什么时候触发：移动到格子上就触发，还是选「待命」之后。
// 进第 N 关（同 verify-events.js 改 $7411），把我方一个单位放到格子 (x, y−1)，走到 (x, y)，逐帧记录：
// 格子检查例程 bank 10 $95A2 的执行、格子脚本指令、单位槽消失，并截图。
// 用法: node tools/tile-probe.js 21 14 31
import path from "node:path";
import { makeEmu, hookExec, trackBanks, ROOT } from "./lib/trace.js";
import { runScript } from "./emu.js";
import { TABLES, disasmScript, evWord } from "./lib/evscript.js";

const [stage, tx, ty] = process.argv.slice(2).map(Number);
const s0 = stage - 1;
const owner = new Map();
for (let n = 0; n < 6; n++) for (const i of disasmScript(evWord(TABLES.tile + 2 * n))) if (!owner.has(i.addr)) owner.set(i.addr, { label: `tile${n}`, ins: i });

const emu = makeEmu();
const nes = emu.nes, m = nes.cpu.mem;
const slots = trackBanks(nes);
let frame = 0, entered = false;
const of = nes.frame.bind(nes);
nes.frame = () => { frame++; return of(); };
const log = (...a) => console.log(`[f${frame}]`, ...a);
let last = null;
hookExec(nes, (pc) => {
  if (pc === 0x8107 && slots[0] === 2 && !entered) m[0x7411] = s0;
  if (pc === 0x95a2 && slots[0] === 10) {
    const sp = nes.cpu.REG_SP;
    const ret = [1, 3, 5, 7, 9].map((k) => (m[0x100 + ((sp + k) & 0xff)] | (m[0x100 + ((sp + k + 1) & 0xff)] << 8)).toString(16)).join(" ");
    log(`格子检查 $95A2，当前单位 $CD=${m[0xcd]}，栈 ${ret}，banks ${slots.join(",")}`);
  }
  if (pc === 0x81a8 && slots[0] === 26) {
    const a = m[0xfc] | (m[0xfd] << 8);
    const o = owner.get(a);
    if (o && a !== last) { last = a; log(`${o.label} $${a.toString(16)} ${o.ins.name}`); }
  }
});

runScript(emu, "wait 600\npress start\nwait 180\n");
for (let i = 0; i < 300; i++) { emu.press("a"); emu.frames(20); if (m[0x7537] && m[0x7411] === s0 && i > 20) break; }
entered = true;
emu.frames(120); emu.press("b"); emu.frames(10);
const slot = [...Array(11).keys()].find((i) => m[0x7537 + i]);
const ox = m[0x7597 + slot], oy = m[0x75b7 + slot];
log(`我方槽 ${slot} 在 (${ox},${oy})，占用图旧格 ${m[0x6c00 + oy * 32 + ox].toString(16)}，新格 ${m[0x6c00 + (ty - 1) * 32 + tx].toString(16)}`);
m[0x6c00 + (ty - 1) * 32 + tx] = m[0x6c00 + oy * 32 + ox];
m[0x6c00 + oy * 32 + ox] &= 0x7f;
m[0x7597 + slot] = tx; m[0x75b7 + slot] = ty - 1;
const cursorTo = (x, y) => { for (let i = 0; i < 80 && (m[0xc0] !== x || m[0xc1] !== y); i++) emu.press(m[0xc0] < x ? "right" : m[0xc0] > x ? "left" : m[0xc1] < y ? "down" : "up", 4); };
cursorTo(tx, ty - 1);
emu.frames(60);
const shot = (n) => emu.screenshot(path.join(ROOT, `extracted/shots/tile-${stage}-${n}.png`));
shot("0-before");
log(`光标 (${m[0xc0]},${m[0xc1]})，按 A 选中单位，再按 A 选「移动」`); emu.press("a"); emu.frames(30); shot("0a-menu"); emu.press("a"); emu.frames(40);
shot("0b-selected");
log("光标下移一格"); emu.press("down", 4); emu.frames(10);
log(`光标 (${m[0xc0]},${m[0xc1]})`); shot("0c-target");
log("按 A 移动"); emu.press("a");
for (let f = 0; f < 120; f++) { emu.frames(1); if (f % 20 === 0) log(`单位槽 ${slot}：${m[0x7537 + slot] ? `在 (${m[0x7597 + slot]},${m[0x75b7 + slot]})` : "空"}`); }
shot("1-after-move");
log("按 A（菜单第一项）"); emu.press("a");
for (let f = 0; f < 120; f++) { emu.frames(1); if (f % 30 === 0) log(`单位槽 ${slot}：${m[0x7537 + slot] ? "在" : "空"}`); }
shot("2-after-a");
