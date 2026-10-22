import { test } from "node:test";
import assert from "node:assert/strict";
import { Rules } from "../src/remake/rules.ts";
import type { Stage, Unit, Weapon } from "../src/remake/data.ts";

// 第一关：太勒（空，速度 52、强度 70）站在森林（地形效果 95），乍克（陆，速度 57、防卫 30）在旁边的草地
const weapon = (name: string, hit: number, power: [number | null, number | null, number | null]): Weapon => ({
  id: 0, name, range: 1, hit, power: { air: power[0], land: power[1], sea: power[2] }, usableAfterMove: true, rangeByte: 0, curve: 0,
});
const unit = (o: Partial<Unit>): Unit => ({
  id: 0, index: 0, side: "player", unitId: 0, pilotId: 0, levelIndex: 0, exp: 0, expBase: 0, money: 0, spirit: 0, aiScript: 0, bits: 0, npc: false, roster: null,
  name: "", pilotName: "", level: 1, x: 0, y: 0, icon: { sheetUrl: "", index: 0 }, moveType: "land", move: 5,
  strength: 0, defense: 0, speed: 0, hp: 100, maxHp: 100, sp: 0, maxSp: 0, weapons: [], spirits: [], trait: null, acted: false, ...o,
});
const stage = { map: { width: 2, height: 1, terrain: [[2, 6]], moveCost: [] }, terrainEffect: [100, 100, 100, 100, 80, 213, 95], units: [] as Unit[] } as unknown as Stage;

const taile = unit({ id: 1, index: 5, x: 1, y: 0, moveType: "air", speed: 52, strength: 70, defense: 45, hp: 290, maxHp: 290, weapons: [weapon("萨斯剑", 100, [null, 45, 45])] });
const zaku = unit({ id: 2, index: 14, side: "enemy", x: 0, y: 0, speed: 57, strength: 42, defense: 30, hp: 185, maxHp: 185, weapons: [weapon("三指叉", 110, [null, 40, 40]), weapon("连发枪", 100, [40, 40, 40])] });

test("攻击预测：伤害、命中和原版公式一致", () => {
  const f = new Rules(stage).forecast(taile, taile.weapons[0], zaku, taile, false);
  assert.equal(f.attack.damage, 45 + 70 - 30);
  assert.equal(f.attack.hit, 100 + 52 - 57);
});

test("空中单位被反击时不吃地形回避（太勒站在森林上）", () => {
  const f = new Rules(stage).forecast(taile, taile.weapons[0], zaku, taile, false);
  assert.equal(f.counter.weapon?.name, "连发枪"); // 三指叉打不到空中
  assert.equal(f.counter.hit, 100);
});

test("机师特性：新人类命中 +10、铁壁伤害 −10%，必杀仍然是 100", () => {
  const newtype = { id: "newtype", name: "新人类", text: "", tier: 1, next: null, hit: 10, evade: 10 };
  const ironwall = { id: "ironwall", name: "铁壁", text: "", tier: 1, next: null, damageTaken: 0.9 };
  const a = { ...taile, speed: 40, trait: newtype };
  const d = { ...zaku, trait: ironwall };
  const f = new Rules(stage).forecast(a, a.weapons[0], d, a, false);
  assert.equal(f.attack.hit, 100 + 40 - 57 + 10);
  assert.equal(f.attack.damage, Math.floor((45 + 70 - 30) * 0.9));
  const sure = { ...a, spirit: 0x02 };
  assert.equal(new Rules(stage).forecast(sure, sure.weapons[0], d, sure, false).attack.hit, 100);
});

test("特性成长：到 Lv 10 / 20 / 30 强化，关掉成长时只有第一档", async () => {
  const { traitOf } = await import("../src/remake/traits.ts");
  assert.equal(traitOf(6, 9)?.hit, 10);
  assert.equal(traitOf(6, 9)?.next?.level, 10);
  assert.equal(traitOf(6, 10)?.hit, 13);
  assert.equal(traitOf(6, 10)?.tier, 2);
  assert.equal(traitOf(6, 35)?.hit, 20);
  assert.equal(traitOf(6, 35)?.next, null);
  assert.equal(traitOf(6, 35, false)?.hit, 10);
});

test("不设上限：50 级以后门槛继续增加，经验可以超过 65535", async () => {
  const { expThreshold, levelForExp } = await import("../src/remake/stats.ts");
  assert.equal(expThreshold(0), 30);
  assert.equal(expThreshold(48), 63290);
  assert.ok(expThreshold(49) > 63290 && expThreshold(50) - expThreshold(49) > expThreshold(49) - expThreshold(48));
  assert.ok(levelForExp(200000, 0) > 50);
});
