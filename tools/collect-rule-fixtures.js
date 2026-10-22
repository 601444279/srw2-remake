// 用模拟器实测，生成规则测试用的数据 src/rules/fixtures/*.json（需要 rom/srw2.nes 和第一关的存档）。
//
// 用法: node tools/collect-rule-fixtures.js
// 需要的存档（extracted/states/，用 tools/emu.js 和 .scratch 里的步骤做出来，做法见 docs/notes-rules.md）：
//   map-cursor.json  第一关第 1 回合，光标在太勒上
//   t4.json          太勒移到 (8,8)，选了萨斯剑，光标对准 (8,7) 的敌人（24 号），按 A 即开战
//   e2.json          第 1 回合「回合结束」确认框，按 A 进入敌方回合
import fs from "node:fs";
import path from "node:path";
import { makeEmu, hookExec, hookWrite, trackBanks, prgByte, ROOT } from "./lib/trace.js";
import { resolve } from "./lib/res.js";

const STATES = path.join(ROOT, "extracted/states");
const OUT = path.join(ROOT, "src/rules/fixtures");
fs.mkdirSync(OUT, { recursive: true });

const word = (m, lo, hi, i) => m[lo + i] | (m[hi + i] << 8);

function unitFromRam(m, i) {
  return {
    index: i,
    side: m[0x7757 + i] & 0xc0,
    moveType: m[0x77d7 + i] & 3,
    strength: m[0x7657 + i],
    defense: m[0x7677 + i],
    speed: m[0x7697 + i],
    hp: word(m, 0x76b7, 0x76d7, i),
    maxHp: word(m, 0x76f7, 0x7717, i),
    spirit: i < 11 ? m[0x7817 + i] : 0,
    ability: m[0x77f7 + i],
    level: m[0x7577 + i],
    mobility: m[0x7637 + i],
    x: m[0x7597 + i],
    y: m[0x75b7 + i],
    weapons: [m[0x75f7 + i], m[0x7617 + i]],
  };
}

const weaponData = (id) => {
  if (!id) return null;
  const [rangeByte, hit, curve, air, land, sea] = resolve(0x87, id).bytes(6);
  return { id, rangeByte, hit, curve, power: [air, land, sea] };
};

// 改 ROM 里的武器数据（只改模拟器内存里的副本）
function patchWeapon(nes, id, bytes) {
  const r = resolve(0x87, id);
  const bank = r.addr < 0xa000 ? r.bank : r.bank + 1;
  const rom = nes.rom.rom[bank >> 1];
  const off = (bank & 1) * 8192 + (r.addr & 0x1fff);
  bytes.forEach((b, i) => { rom[off + i] = b; });
}

// ---- 战斗 ----
function runBattle(name, { pokes = {}, weaponPatch = null, frames = 1100 } = {}) {
  const emu = makeEmu(path.join(STATES, "t4.json"));
  const nes = emu.nes, cpu = nes.cpu, m = cpu.mem;
  for (const [a, v] of Object.entries(pokes)) m[Number(a)] = v;
  if (weaponPatch) patchWeapon(nes, weaponPatch.id, weaponPatch.bytes);
  const slots = trackBanks(nes);
  const atkIdx = 5, defIdx = 24;
  const before = { atk: unitFromRam(m, atkIdx), def: unitFromRam(m, defIdx) };
  const terrainAt = (u) => m[0x750f + (m[0x7000 + u.y * 32 + u.x] & 0x0f)];
  const ctx = {
    dist: Math.abs(before.atk.x - before.def.x) + Math.abs(before.atk.y - before.def.y),
    moved: true, // t4 里太勒是移动后攻击
    defTerrain: terrainAt(before.def),
    atkTerrain: terrainAt(before.atk),
    jamming: !!(m[0x750d] & 0x40),
  };
  const weapons = {};
  for (const id of [...before.atk.weapons, ...before.def.weapons]) {
    const w = weaponData(id);
    if (w && weaponPatch && id === weaponPatch.id) {
      const [rangeByte, hit, curve, air, land, sea] = weaponPatch.bytes;
      Object.assign(w, { rangeByte, hit, curve, power: [air, land, sea] });
    }
    if (w) weapons[id] = w;
  }
  const out = { name, pokes, ctx, before, weapons, usedWeapon: null, preview: null, strikes: [], rolls100: [] };
  let pend = null, cur = null, done = false;
  hookExec(nes, (pc) => {
    if (done) return;
    if (pc === 0xc39b) pend = cpu.REG_ACC;
    else if (pc === 0xc3b5 && pend !== null) {
      if (pend === 100) out.rolls100.push(cpu.REG_ACC);
      if (cur && pend === 100) cur.rolls.push(cpu.REG_ACC);
      pend = null;
    } else if (pc === 0x8b23 && slots[0] === 6) {
      const a = m[0xd1 + m[0xe8]], d = m[0xd1 + m[0xe9]];
      if (![atkIdx, defIdx].includes(a) || ![atkIdx, defIdx].includes(d)) { done = true; return; }
      cur = { attacker: a, defender: d, damage: m[0xf0] | (m[0xf1] << 8), hit: m[0xf2], rolls: [], hpBefore: word(m, 0x76b7, 0x76d7, d) };
      out.strikes.push(cur);
    } else if (pc === 0x883c && slots[0] === 4 && !out.preview && m[0xd1] === atkIdx) {
      // 攻方预测刚存好（$E1/$DF/$DB/$DD）
      out.usedWeapon = m[0xd7];
      out.preview = { attack: { flags: m[0xe1], hit: m[0xdf], damage: m[0xdb] | (m[0xdd] << 8) } };
    } else if ((pc === 0x884c || pc === 0x88ad) && slots[0] === 4 && out.preview && !out.preview.counter) {
      // $884C：不反击（攻击无效或必定击破）；$88AD：反击武器已选好
      out.preview.counter = { flags: m[0xe2], hit: m[0xe0], damage: m[0xdc] | (m[0xde] << 8), weapon: m[0xd8] };
    }
  });
  hookWrite(nes, (a, v) => {
    if (done || !cur) return;
    if (a === 0x76d7 + cur.defender) cur.hpAfter = m[0x76b7 + cur.defender] | (v << 8);
  });
  const exp0 = word(m, 0x74ec, 0x74fc, m[0x7737 + atkIdx] & 0x0f);
  const money0 = word(m, 0x743a, 0x743b, 0);
  const lv0 = m[0x745c + (m[0x7737 + atkIdx] & 0x0f)];
  for (let f = 0; f < frames; f++) {
    if (!done && f % 40 === 0) nes.buttonDown(1, 0);
    if (f % 40 === 6) nes.buttonUp(1, 0);
    nes.frame();
  }
  const slot = m[0x7737 + atkIdx] & 0x0f;
  out.after = {
    atk: unitFromRam(m, atkIdx),
    def: unitFromRam(m, defIdx),
    expGain: word(m, 0x74ec, 0x74fc, slot) - exp0,
    exp: word(m, 0x74ec, 0x74fc, slot),
    moneyGain: word(m, 0x743a, 0x743b, 0) - money0,
    level: m[0x745c + slot],
    levelBefore: lv0,
    growthType: m[0x74cc + slot] & 3,
    sp: m[0x7822 + atkIdx],
    maxSp: m[0x782d + atkIdx],
  };
  // 击破时附上机体、驾驶员数据，测试经验和升级用
  const mach = (id) => {
    const b = resolve(0x86, id).bytes(16);
    const curve = (c) => resolve(0x88, c).bytes(26);
    return {
      id, moveType: b[0], mobility: b[3], speed: b[4], strength: b[5], defense: b[6], money: b[7],
      hp: b[8] | (b[9] << 8), baseExp: b[10] | (b[11] << 8),
      curves: { speed: curve(b[12]), strength: curve(b[13]), defense: curve(b[14]), hp: curve(b[15]) },
    };
  };
  out.machines = { atk: mach(m[0x7557 + atkIdx]), def: mach(m[0x7557 + defIdx]) };
  const p = resolve(0x84, m[0x7537 + atkIdx]).bytes(2);
  out.pilot = { sp: p[0], spCurve: resolve(0x88, p[1]).bytes(26) };
  return out;
}

const T = 5, E = 24; // 太勒、敌人 24 号
const at = (base, i) => base + i;
const battles = [
  ["基准：萨斯剑打 24 号，24 号反击", {}],
  ["太勒速度 85：速度差 50，太勒再攻击", { pokes: { [at(0x7697, T)]: 85 } }],
  ["太勒速度 84：差 49，没有再攻击", { pokes: { [at(0x7697, T)]: 84 } }],
  ["敌人速度 102：敌人再反击一次", { pokes: { [at(0x7697, E)]: 102 } }],
  ["强攻：伤害 ×2", { pokes: { [at(0x7817, T)]: 0x08 } }],
  ["热血：伤害 ×3", { pokes: { [at(0x7817, T)]: 0x04 } }],
  ["防守：受到伤害减半", { pokes: { [at(0x7817, T)]: 0x10 } }],
  ["回避：敌人命中 0", { pokes: { [at(0x7817, T)]: 0x01 } }],
  ["敌人速度 140：太勒命中 12", { pokes: { [at(0x7697, E)]: 140 } }],
  ["敌人速度 140 + 瞄准：命中 +10", { pokes: { [at(0x7697, E)]: 140, [at(0x7817, T)]: 0x20 } }],
  ["敌人速度 140 + 必杀：命中 100", { pokes: { [at(0x7697, E)]: 140, [at(0x7817, T)]: 0x02 } }],
  ["干扰：敌人命中减半", { pokes: { 0x750d: 0x40 } }],
  ["敌人脚下地形 80%，太勒速度 10", { pokes: { 0x7510: 0x50, [at(0x7697, T)]: 10 } }],
  ["敌人脚下算作海：用海火力（萨斯剑海火力改成 99）", { pokes: { 0x7510: 0xe4 }, weaponPatch: { id: 0x47, bytes: [0, 100, 0, 0, 45, 99] } }],
  ["敌人防卫 200：伤害为 0", { pokes: { [at(0x7677, E)]: 200 } }],
  ["敌人能力 1：伤害减防卫一半", { pokes: { [at(0x77f7, E)]: 0x01 } }],
  ["敌人能力 2：25% 机率伤害减半", { pokes: { [at(0x77f7, E)]: 0x02 } }],
  ["萨斯剑改为定身武器（类型 1）", { weaponPatch: { id: 0x47, bytes: [0x10, 100, 0, 0, 45, 45] } }],
  ["击破：同等级", { pokes: { [at(0x76b7, E)]: 80, [at(0x76d7, E)]: 0 } }],
  ["击破：HP 90 等于伤害（预测不算击破）", { pokes: { [at(0x76b7, E)]: 90, [at(0x76d7, E)]: 0 } }],
  ["击破：敌人等级 3", { pokes: { [at(0x76b7, E)]: 80, [at(0x76d7, E)]: 0, [at(0x7577, E)]: 3 } }],
  ["击破：敌人等级 12（系数封顶）", { pokes: { [at(0x76b7, E)]: 80, [at(0x76d7, E)]: 0, [at(0x7577, E)]: 12 } }],
  ["击破：我方等级 3", { pokes: { [at(0x76b7, E)]: 80, [at(0x76d7, E)]: 0, [at(0x7577, T)]: 3 } }],
  ["击破：我方等级 5", { pokes: { [at(0x76b7, E)]: 80, [at(0x76d7, E)]: 0, [at(0x7577, T)]: 5 } }],
  ["击破：我方等级 10（等级差太大，经验 1）", { pokes: { [at(0x76b7, E)]: 80, [at(0x76d7, E)]: 0, [at(0x7577, T)]: 10 } }],
  ["击破后升级：经验 29 → 51", { pokes: { [at(0x76b7, E)]: 80, [at(0x76d7, E)]: 0, 0x74f1: 29 } }],
  ["击破后连升：经验 590 → 612", { pokes: { [at(0x76b7, E)]: 80, [at(0x76d7, E)]: 0, 0x74f1: 590 & 0xff, 0x7501: 590 >> 8 } }],
  ["击破、满血必中：不计算反击", { pokes: { [at(0x76b7, E)]: 50, [at(0x76d7, E)]: 0 } }],
];
const battleCases = battles.map(([name, opt]) => runBattle(name, opt));
fs.writeFileSync(path.join(OUT, "battles.json"), JSON.stringify(battleCases, null, 1));
console.log("战斗", battleCases.length, "场");

// ---- 移动范围 ----
const envs = JSON.parse(fs.readFileSync(path.join(ROOT, "data/environments.json"), "utf8"));
const moveCases = [];
for (const u of [0, 1, 2, 3, 4, 5]) {
  const emu = makeEmu(path.join(STATES, "map-cursor.json"));
  const m = emu.nes.cpu.mem;
  const x = m[0x7597 + u], y = m[0x75b7 + u];
  for (let i = 0; i < 80 && (m[0xc0] !== x || m[0xc1] !== y); i++) emu.press(m[0xc0] < x ? "right" : m[0xc0] > x ? "left" : m[0xc1] < y ? "down" : "up", 4);
  emu.press("a"); emu.frames(30); emu.press("a"); emu.frames(30);
  const W = m[0xc6], H = m[0xc7];
  const terrain = [], grid = [];
  for (let yy = 0; yy < H; yy++) {
    terrain.push(Array.from({ length: W }, (_, xx) => m[0x7000 + yy * 32 + xx] & 15));
    grid.push(Array.from({ length: W }, (_, xx) => m[0x6800 + yy * 32 + xx]));
  }
  const blocked = [];
  for (let i = 0; i < 32; i++) if (m[0x7537 + i] && !(m[0x77d7 + i] & 0x80) && !(m[0x7757 + i] & m[0x7757 + u] & 0xc0)) blocked.push(`${m[0x7597 + i]},${m[0x75b7 + i]}`);
  const type = m[0x77d7 + u] & 3;
  moveCases.push({ unit: u, moveType: type, mobility: m[0xd0], start: { x, y }, costs: envs[m[0x7411]].moveCostRaw[type], terrain, blocked, grid });
}
fs.writeFileSync(path.join(OUT, "move.json"), JSON.stringify(moveCases));
console.log("移动范围", moveCases.length, "个单位");

// ---- 随机数 ----
{
  const rom = Array.from({ length: 128 }, (_, i) => prgByte(31, 0xf800 + i));
  const seeds = [];
  for (const counter of [0, 77, 200]) {
    const emu = makeEmu();
    const m = emu.nes.cpu.mem;
    m[0x7410] = counter;
    let snap = null;
    hookExec(emu.nes, (pc) => { if (pc === 0xc34e && !snap) snap = Array.from(m.slice(0x300, 0x380)); });
    // 开机初始化在头几帧完成；$7410 在 NMI 里每帧 +1，初始化时读到的是当时的值
    let seen = null;
    hookExec(emu.nes, (pc) => { if (pc === 0xc33c && seen === null) seen = m[0x7410]; });
    for (let f = 0; f < 10; f++) emu.nes.frame();
    seeds.push({ counter: seen, table: snap });
  }
  // 战斗中的调用序列
  const emu = makeEmu(path.join(STATES, "t4.json"));
  const m = emu.nes.cpu.mem;
  const start = { table: Array.from(m.slice(0x300, 0x380)), index: m[0x79] };
  const calls = [];
  let pend = null;
  hookExec(emu.nes, (pc) => {
    if (pc === 0xc39b) pend = emu.nes.cpu.REG_ACC;
    else if (pc === 0xc3b5 && pend !== null) { calls.push([pend, emu.nes.cpu.REG_ACC]); pend = null; }
  });
  for (let f = 0; f < 2400; f++) { if (f % 40 === 0) emu.nes.buttonDown(1, 0); if (f % 40 === 6) emu.nes.buttonUp(1, 0); emu.nes.frame(); }
  fs.writeFileSync(path.join(OUT, "rng.json"), JSON.stringify({ romF800: rom, seeds, battle: { start, calls } }));
  console.log("随机数", seeds.length, "个种子，", calls.length, "次调用");
}

// ---- 敌方行动顺序 ----
{
  const emu = makeEmu(path.join(STATES, "e2.json"));
  const nes = emu.nes, m = nes.cpu.mem;
  const slots = trackBanks(nes);
  const W = m[0xc6], H = m[0xc7];
  const terrain = [];
  for (let y = 0; y < H; y++) terrain.push(Array.from({ length: W }, (_, x) => m[0x7000 + y * 32 + x] & 15));
  const units = Array.from({ length: 32 }, (_, i) => i).filter((i) => m[0x7537 + i] && !(m[0x77d7 + i] & 0x80)).map((i) => unitFromRam(m, i));
  const order = [];
  const moves = [];
  hookExec(nes, (pc) => {
    if (pc === 0x9208 && slots[0] === 24) order.push(nes.cpu.REG_ACC);
  });
  hookWrite(nes, (a, v) => { if (a >= 0x75b7 && a < 0x75d7) moves.push({ unit: a - 0x75b7, x: m[0x7597 + a - 0x75b7], y: v }); });
  for (let f = 0; f < 1000; f++) { if (f % 30 === 0) nes.buttonDown(1, 0); if (f % 30 === 6) nes.buttonUp(1, 0); nes.frame(); }
  const scripts = Object.fromEntries(units.filter((u) => u.index >= 14).map((u) => [u.index, m[0x7777 + u.index]]));
  fs.writeFileSync(path.join(OUT, "ai.json"), JSON.stringify({
    terrain, airCosts: envs[m[0x7411]].moveCostRaw[0], moveCosts: envs[m[0x7411]].moveCostRaw, units, scripts, turn: m[0x750c], order, moves,
  }));
  console.log("敌方行动顺序", order.join(","));
}
