// 精神指令探针：临时改 ROM 里驾驶员的精神列表，只留一个精神，在第一关对太勒使用，记录所有单位 HP、标志变化。
// 用法: node tools/spirit-probe.js <精神编号 0-18> [我方HP=50] [额外按键脚本，分号分隔]
// 例:   node tools/spirit-probe.js 13 50 "wait 60;press a;wait 60;press a"   （全体回复要逐个按 A）
// 输出：有变化的单位（HP、标志、精神点数）、干扰标志 $750D、随机数调用 n:结果、HP 写入（代码位置）
// 注意：$7817 标志表只有 11 格，16 号单位的「标志」其实是 5 号的精神点数，看到可以忽略
import { makeEmu, hex, hookExec, hookWrite, trackBanks } from "./lib/trace.js";
import { resolve } from "./lib/res.js";
import { runScript } from "./emu.js";

export function probeSpirit(id, { hp = 50, state = "extracted/states/map-cursor.json", extra = "" } = {}) {
  const emu = makeEmu(state);
  const nes = emu.nes, m = nes.cpu.mem;
  const r = resolve(0x84, 0x11); // 太勒的驾驶员杰克
  const bank = r.addr < 0xa000 ? r.bank : r.bank + 1;
  const rom = nes.rom.rom[bank >> 1];
  const off = (bank & 1) * 8192 + ((r.addr + 2) & 0x1fff);
  const mask = 1 << (23 - id);
  rom[off] = mask >> 16; rom[off + 1] = (mask >> 8) & 0xff; rom[off + 2] = mask & 0xff;
  m[0x7827] = 250;
  for (let u = 0; u < 6; u++) { m[0x76b7 + u] = hp & 0xff; m[0x76d7 + u] = hp >> 8; }
  const rolls = [];
  const slots = trackBanks(nes);
  let pend = null, lastPc = 0;
  hookWrite(nes, (a, v) => {
    if (a >= 0x76b7 && a < 0x76f7) rolls.push(`W ${slots[(lastPc - 0x8000) >> 13]}:${hex(lastPc, 4)} ${hex(a, 4)}=${v}`);
  });
  hookExec(nes, (pc) => {
    lastPc = pc;
    if (pc === 0xc39b) pend = nes.cpu.REG_ACC;
    else if (pc === 0xc3b5 && pend !== null) { rolls.push(`${pend}:${nes.cpu.REG_ACC}`); pend = null; }
  });
  const snap = () => Array.from({ length: 32 }, (_, u) => ({ u, alive: m[0x7537 + u], hp: m[0x76b7 + u] | (m[0x76d7 + u] << 8), max: m[0x76f7 + u] | (m[0x7717 + u] << 8), flags: m[0x7817 + u], sp: m[0x7822 + u] }));
  const before = snap();
  const g0 = m[0x750d];
  runScript(emu, "press a\nwait 30\npress right\nwait 5\npress a\nwait 40\npress a\nwait 90\n" + extra);
  const after = snap();
  const diff = after.filter((a, i) => a.alive && (a.hp !== before[i].hp || a.flags !== before[i].flags || (i < 11 && a.sp !== before[i].sp)))
    .map((a) => ({ unit: a.u, hp: `${before[a.u].hp}->${a.hp}/${a.max}`, flags: `${hex(before[a.u].flags)}->${hex(a.flags)}`, sp: `${before[a.u].sp}->${a.sp}` }));
  return { id, diff, g750d: `${hex(g0)}->${hex(m[0x750d])}`, rolls, emu };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [id, hp, extra] = process.argv.slice(2);
  const r = probeSpirit(Number(id), { hp: hp ? Number(hp) : 50, extra: (extra ?? "").split(";").join("\n") });
  r.emu.screenshot(`extracted/shots/spirit-${id}.png`);
  delete r.emu;
  console.log(JSON.stringify(r));
}
