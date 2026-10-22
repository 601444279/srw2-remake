// 生成规则测试要用的几个存档（extracted/states/），供 tools/collect-rule-fixtures.js 使用。
//
// 用法: node tools/make-rule-states.js
//   map-cursor.json  开机 → 标题 → 连按 A 跳过开场对话，第一关第 1 回合，光标在太勒上（已存在时直接用）
//   t4.json          太勒机动改成 30，移到 (8,8)，攻击 → 萨斯剑 → 光标对准 (8,7) 的 24 号敌人
//   e2.json          光标移到空地 (10,15)，系统菜单 → 回合结束 → 「是吗？」确认框
import fs from "node:fs";
import path from "node:path";
import { createEmu, runScript } from "./emu.js";
import { ROOT } from "./lib/trace.js";

const DIR = path.join(ROOT, "extracted/states");
const file = (n) => path.join(DIR, `${n}.json`);

function cursorTo(emu, x, y) {
  const m = emu.nes.cpu.mem;
  for (let i = 0; i < 80 && (m[0xc0] !== x || m[0xc1] !== y); i++) {
    emu.press(m[0xc0] < x ? "right" : m[0xc0] > x ? "left" : m[0xc1] < y ? "down" : "up", 4);
  }
  if (m[0xc0] !== x || m[0xc1] !== y) throw new Error(`光标没到 (${x},${y})`);
}

if (!fs.existsSync(file("map-cursor"))) {
  const emu = createEmu();
  runScript(emu, "wait 600\npress start\nwait 180\n" + "press a\nwait 20\n".repeat(60));
  // 开场对话结束后光标停在太勒（14,18）
  cursorTo(emu, 14, 18);
  emu.save(file("map-cursor"));
}

{
  const emu = createEmu();
  emu.load(file("map-cursor"));
  emu.nes.cpu.mem[0x7637 + 5] = 30; // 太勒的机动
  runScript(emu, "wait 2\npress a\nwait 30\npress a\nwait 30");
  cursorTo(emu, 8, 8);
  runScript(emu, "wait 10\npress a\nwait 150\npress a\nwait 40\npress a\nwait 40");
  cursorTo(emu, 8, 7);
  emu.frames(20);
  emu.save(file("t4"));
}

{
  const emu = createEmu();
  emu.load(file("map-cursor"));
  cursorTo(emu, 10, 15);
  runScript(emu, "press a\nwait 30\npress a\nwait 30");
  emu.save(file("e2"));
}
console.log("已生成 t4.json、e2.json");
