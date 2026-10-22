// 从模拟器存档里读出当前关卡运行时单位表的快照（位置、数值、驾驶员和机体编号）。
// 用作测试基准：重制版按 ROM 数据算出的数值必须和原版运行时一致（tests/stats.test.ts）。
//
// 用法: node tools/snapshot-stage.js <存档.json> <关卡号>
// 输出: data/snapshots/stageNN.json
import fs from "node:fs";
import path from "node:path";
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
function main(statePath, stageArg) {
  const stage = Number(stageArg);
  const emu = createEmu();
  emu.load(statePath);
  const m = emu.nes.cpu.mem;

  const units = [];
  for (let slot = 0; slot < SLOTS; slot++) {
    const f = (name) => m[FIELD[name] + slot];
    if (f("flags") === 0) continue;
    const side = slot < FIRST_ENEMY_SLOT ? "player" : "enemy";
    units.push({
      slot, side, x: f("x"), y: f("y"),
      sprite: f("icon"),
      move: f("move"), strength: f("strength"), defense: f("defense"), speed: f("speed"),
      hp: f("hpLo") | (f("hpHi") << 8), maxHp: f("maxHpLo") | (f("maxHpHi") << 8),
      raw: { paramA: f("paramA"), paramB: f("paramB"), paramC: f("paramC"), paramD: f("paramD"), portrait: f("portrait"), flags: f("flags") },
    });
  }

  const out = path.join(ROOT, `data/snapshots/stage${String(stage).padStart(2, "0")}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const note = "原版运行时单位表快照，用作数值计算的测试基准";
  const text = JSON.stringify({ stage, note, units }, null, 2).replace(/\{\s+("paramA"[^{}]*?)\s+\}/g, (_, b) => `{ ${b.replace(/\s+/g, " ")} }`);
  fs.writeFileSync(out, text + "\n");
  console.log(`关卡 ${stage}：${units.length} 个单位`);
}

main(...process.argv.slice(2));
