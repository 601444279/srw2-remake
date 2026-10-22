// 规则函数测试：数据来自模拟器实测（tools/collect-rule-fixtures.js 生成 fixtures/*.json）。
// 运行: npm run test:rules
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { previewBattle, resolveStrike, extraAttacker, FLAG_VALID } from "./battle.js";
import { expForKill, levelForExp, addExp, statsAtLevel, addMoney } from "./growth.js";
import { distanceGrid } from "./move.js";
import { OriginalRng } from "./rng.js";
import { enemyOrder, moveGoal, moveStep } from "./ai.js";
import { spiritMenu, SPIRITS } from "./spirits.js";

const load = (name) => JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "fixtures", name), "utf8"));
const battles = load("battles.json");

// 用规则函数把一场战斗从头算一遍：预测 → 攻方出手 → 反击 → 再攻击。命中判定用实测的 rand(100) 序列
function simulate(c) {
  const atk = { ...c.before.atk }, def = { ...c.before.def };
  const w = (id) => c.weapons[id] ?? null;
  const weapon = w(c.usedWeapon);
  const p = previewBattle({ weapon, atk, def, defWeapons: def.weapons.map(w), ...c.ctx });
  const rolls = [...c.rolls100];
  const rand = (n) => { assert.equal(n, 100); return rolls.shift(); };
  const strikes = [];
  const strike = (from, to, r, wpn) => {
    const res = resolveStrike({ damage: r.damage, hit: r.hit, weaponKind: wpn.rangeByte & 0xf0 }, to, { dist: c.ctx.dist, rand });
    strikes.push({ attacker: from.index, defender: to.index, damage: r.damage, hit: r.hit, hpAfter: res.hit ? res.hpAfter : undefined });
    if (res.hit) to.hp = res.hpAfter;
    return res;
  };
  strike(atk, def, p.attack, weapon);
  const counterValid = (p.counter.flags & FLAG_VALID) !== 0;
  const counterWeapon = counterValid ? w(def.weapons[p.counter.slot]) : null;
  if (def.hp > 0 && counterValid) strike(def, atk, p.counter, counterWeapon);
  const extra = atk.hp > 0 && def.hp > 0 ? extraAttacker(atk, def, { counterValid }) : null;
  if (extra === "attacker") strike(atk, def, p.attack, weapon);
  else if (extra === "defender") strike(def, atk, p.counter, counterWeapon);
  return { preview: p, strikes };
}

for (const c of battles) {
  test(`战斗：${c.name}`, () => {
    const { preview, strikes } = simulate(c);
    assert.deepEqual(
      { flags: preview.attack.flags, hit: preview.attack.hit, damage: preview.attack.damage },
      c.preview.attack, "攻方预测");
    const counter = { flags: preview.counter.flags, hit: preview.counter.hit, damage: preview.counter.damage };
    assert.deepEqual(counter, { flags: c.preview.counter.flags, hit: c.preview.counter.hit, damage: c.preview.counter.damage }, "反击预测");
    if (c.preview.counter.flags) {
      const chosen = c.before.def.weapons[preview.counter.slot];
      assert.equal(chosen, c.preview.counter.weapon, "反击武器");
    }
    assert.deepEqual(
      strikes.map(({ attacker, defender, damage, hit, hpAfter }) => ({ attacker, defender, damage, hit, hpAfter })),
      c.strikes.map(({ attacker, defender, damage, hit, hpAfter }) => ({ attacker, defender, damage, hit, hpAfter })),
      "出手顺序与结果");
    // 打完一场后，我方的一次性精神（强攻、热血、防守、必杀、瞄准、回避）消失，加速、疾风保留
    assert.equal(c.after.atk.spirit, c.before.atk.spirit & 0xc0, "战后精神标志");
  });
}

test("击破经验与资金", () => {
  for (const c of battles.filter((b) => b.after.def.hp === 0)) {
    const gain = expForKill(c.machines.def.baseExp, c.before.def.level, c.before.atk.level);
    assert.equal(gain, c.after.expGain, c.name);
    assert.equal(c.after.moneyGain, addMoney(0, c.machines.def.money), c.name);
  }
  for (const c of battles.filter((b) => b.after.def.hp > 0)) assert.equal(c.after.expGain, 0, `${c.name}：没击破没有经验`);
});

test("升级与能力值", () => {
  for (const c of battles.filter((b) => b.after.def.hp === 0)) {
    const lv = levelForExp(c.after.exp, c.after.levelBefore, c.after.growthType);
    assert.equal(lv, c.after.level, `${c.name}：等级`);
    const s = statsAtLevel(c.machines.atk, c.pilot, lv);
    const a = c.after.atk;
    assert.deepEqual(
      { speed: s.speed, strength: s.strength, defense: s.defense, maxHp: s.maxHp, maxSp: s.maxSp },
      { speed: a.speed, strength: a.strength, defense: a.defense, maxHp: a.maxHp, maxSp: c.after.maxSp },
      `${c.name}：能力值`);
  }
  assert.equal(addExp(65530, 22), 65535);
});

test("移动范围与原版距离图一致", () => {
  for (const c of load("move.json")) {
    const g = distanceGrid({ terrain: c.terrain, costs: c.costs, start: c.start, mobility: c.mobility, blocked: new Set(c.blocked) });
    assert.deepEqual(g, c.grid, `单位 ${c.unit}`);
  }
});

test("随机数：开机种子", () => {
  const r = load("rng.json");
  for (const s of r.seeds) assert.deepEqual(Array.from(OriginalRng.seed(s.counter, r.romF800).mem), s.table, `计数器 ${s.counter}`);
});

test("随机数：战斗中的调用序列", () => {
  const { battle } = load("rng.json");
  const rng = new OriginalRng(battle.start.table, battle.start.index);
  for (const [n, v] of battle.calls) assert.equal(rng.rand(n), v);
});

test("敌方行动顺序", () => {
  const a = load("ai.json");
  const players = a.units.filter((u) => u.index < 11);
  const enemies = a.units.filter((u) => u.index >= 14);
  assert.deepEqual(enemyOrder({ terrain: a.terrain, airCosts: a.airCosts, enemies, players }), a.order);
});

test("敌方向目标移动：第 1 回合 5 个主动型敌人的落点", () => {
  const a = load("ai.json");
  const units = a.units.map((u) => ({ ...u }));
  for (const mv of a.moves) {
    const u = units.find((x) => x.index === mv.unit);
    const players = units.filter((x) => x.index < 11);
    const occupied = new Set(units.filter((x) => x !== u).map((x) => `${x.x},${x.y}`));
    const blocked = new Set(players.map((x) => `${x.x},${x.y}`));
    const costs = a.moveCosts[u.moveType];
    const grid = distanceGrid({ terrain: a.terrain, costs, start: u, mobility: u.mobility, blocked });
    const goal = moveGoal(players, grid, occupied);
    const gridFromGoal = distanceGrid({ terrain: a.terrain, costs, start: goal, mobility: u.mobility, blocked });
    // 平局时原版用 rand(个数) 选：先问出候选个数，再把每个候选都取一遍，确认实测落点在里面
    let count = 1;
    moveStep({ grid, gridFromGoal, mobility: u.mobility, occupied, self: u, rand: (n) => { count = n; return 0; } });
    const all = [];
    for (let i = 0; i < count; i++) all.push(moveStep({ grid, gridFromGoal, mobility: u.mobility, occupied, self: u, rand: () => i }));
    assert.ok(all.some((p) => p.x === mv.x && p.y === mv.y), `单位 ${u.index} 落点 (${mv.x},${mv.y}) 不在候选里`);
    u.x = mv.x; u.y = mv.y;
  }
});

test("精神菜单：太勒（杰克）第一关显示加速、防守", () => {
  const unit = { sp: 40, hp: 290, maxHp: 290, spirit: 0 };
  const menu = spiritMenu(0xd40000, unit, [{ index: 5, alive: true, hp: 290, maxHp: 290 }, { index: 14, alive: true, hp: 1, maxHp: 1 }]);
  assert.deepEqual(menu.map((s) => s.name), ["加速", "防守"]);
  assert.equal(SPIRITS.length, 19);
});

test("精神菜单：排序与实测截图一致", () => {
  const unit = { sp: 250, hp: 10, maxHp: 290, spirit: 0 };
  const units = [{ index: 0, alive: true, hp: 10, maxHp: 400 }, { index: 14, alive: true, hp: 1, maxHp: 1 }];
  const names = (ids) => spiritMenu(ids.reduce((m, i) => m | (1 << (23 - i)), 0), unit, units).map((s) => s.name);
  assert.deepEqual(names([0, 1, 2, 3, 4, 5]), ["毅力", "加速", "瞄准", "防守", "友情", "强攻"]);
  assert.deepEqual(names([6, 7, 8, 9, 10, 11]), ["必杀", "疾风", "回避", "潜力", "情义", "热血"]);
  assert.deepEqual(names([12, 13, 14, 15, 16, 17]), ["援助", "怒", "祈祷", "干扰", "传真", "狂怒"]);
});
