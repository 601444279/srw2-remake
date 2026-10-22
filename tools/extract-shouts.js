// 提取战斗台词表：每个驾驶员一张表，战斗中按「情况」查台词（喊话文本在 data/script/res-30…37）。
//
// 用法: node tools/extract-shouts.js [rom/srw2.nes]
// 输出: data/shouts.json
//
// 原版代码：bank 6 $8944（查表）。指针表 bank 6 $8D4A，按驾驶员编号，每项 2 字节（0 = 没有表）。
// 每张表：
//   前 8 × 2 字节：情况 0–7 各一条（资源号 − 0x30、脚本号）
//   之后 3 个列表（情况 8、9、10），每项 4 字节：武器编号下限、上限、资源号 − 0x30、脚本号，以 FF 结尾
// 情况（调用点 bank 6 $82A4–$845F、$8CF0–$8D47）：
//   0 未命中　1 命中但没伤害　2 轻伤（伤害 < 最大 HP 的 11%）　3 中伤（11–35%）　4 重伤（≥ 36%）
//   5 被击破　6 动不了（被定身）　7 无法反击　8 攻击　9 反击　10 再攻击（8–10 按武器编号选）
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const BANK6 = 6 * 0x2000;
const POINTERS = 0x8d4a;
const PILOTS = 112;
const CASES = ["miss", "noDamage", "light", "medium", "heavy", "destroyed", "stunned", "cannotCounter"];
const LISTS = ["attack", "counter", "extra"];

const rom = fs.readFileSync(process.argv[2] ?? path.join(ROOT, "rom/srw2.nes"));
const prg = rom.subarray(16, 16 + rom[4] * 0x4000);
const at = (cpu) => prg[BANK6 + (cpu - 0x8000)];
const ref = (res, idx) => `res-${(res + 0x30).toString(16).toUpperCase()}#${idx}`;

const pilots = {};
for (let p = 0; p < PILOTS; p++) {
  const ptr = at(POINTERS + p * 2) | (at(POINTERS + p * 2 + 1) << 8);
  if (!ptr) continue;
  const table = {};
  CASES.forEach((name, i) => { table[name] = ref(at(ptr + i * 2), at(ptr + i * 2 + 1)); });
  let o = ptr + 16;
  for (const name of LISTS) {
    const list = [];
    while (at(o) !== 0xff) {
      list.push({ from: at(o), to: at(o + 1), line: ref(at(o + 2), at(o + 3)) });
      o += 4;
    }
    o++;
    table[name] = list;
  }
  pilots[p] = table;
}

const out = {
  note: "战斗台词：按驾驶员编号，情况 0–7 各一段，攻击 / 反击 / 再攻击按武器编号区间选。line 指向 data/script/res-XX.json 的 index，同一段里有多句时随机选一句。由 tools/extract-shouts.js 生成",
  pilots,
};
fs.writeFileSync(path.join(ROOT, "data/shouts.json"), JSON.stringify(out, null, 2).replace(/\{\s+("from"[^{}]*?)\s+\}/g, (_, b) => `{ ${b.replace(/\s+/g, " ")} }`) + "\n");
console.log(`导出 ${Object.keys(pilots).length} 个驾驶员的战斗台词表`);
