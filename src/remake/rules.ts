// 重制版和原版规则代码（src/rules/，按模拟器实测验证过）之间的适配层：
// 把重制版的单位、武器转换成规则代码用的原版格式，再把结果转换回来。规则本身不在这里重写。
import type { Stage, Unit, Weapon } from "./data.ts";
import { previewBattle, extraAttacker, resolveStrike, distance, inRange, FLAG_LETHAL, FLAG_VALID } from "../rules/battle.js";
import { expForKill } from "../rules/growth.js";
import { levelForExp } from "./stats.ts";
import { SPIRITS, USABLE, FLAG, healAmount, applyHeal, spiritDamage } from "../rules/spirits.js";
import { OriginalRng } from "../rules/rng.js";
import { distanceGrid, mobilityOf, BLOCKED } from "../rules/move.js";
import { enemyOrder, chooseAttack, moveGoal, moveStep } from "../rules/ai.js";
import { MOVE_TYPE_ROW, type Point } from "./grid.ts";

export { FLAG as SPIRIT_FLAG };

const SIDE_BITS = { player: 0x80, enemy: 0x40 } as const;
const TYPE_NUM = { air: 0, land: 1, sea: 2 } as const;

// 原版随机数（rand(100) 里 0–55 稍微偏多，和原版一致）。种子用当前时间，等同于原版存档里的帧计数器
const seed = new Uint8Array(128);
crypto.getRandomValues(seed);
const rng = new OriginalRng(seed);
export const rand = (n: number) => rng.rand(n);

// 存档用：随机数表和下标（读档后结果和存档时一致）
export const rngState = () => ({ mem: Array.from(rng.mem as Uint8Array), index: rng.index as number });
export function setRngState(s: { mem: number[]; index: number }) {
  rng.mem = Uint8Array.from(s.mem);
  rng.index = s.index;
}

interface RuleUnit {
  index: number;
  side: number;
  moveType: number;
  strength: number;
  defense: number;
  speed: number;
  hp: number;
  maxHp: number;
  spirit: number;
  ability: number;
  x: number;
  y: number;
}

const toRule = (u: Unit): RuleUnit => ({
  index: u.index,
  side: SIDE_BITS[u.side],
  moveType: TYPE_NUM[u.moveType],
  strength: u.strength,
  defense: u.defense,
  // 特性「快攻」：速度加成直接进原版公式（命中、回避、速度差再攻击都会受影响）
  speed: u.speed + (u.trait?.speed ?? 0),
  hp: u.hp,
  maxHp: u.maxHp,
  spirit: u.spirit,
  ability: 0,
  x: u.x,
  y: u.y,
});

const toRuleWeapon = (w: Weapon | undefined) =>
  w && { rangeByte: w.rangeByte, hit: w.hit, curve: w.curve, power: [w.power.air ?? 0, w.power.land ?? 0, w.power.sea ?? 0] };

export interface Strike {
  hit: number;
  damage: number;
  valid: boolean;
  lethal: boolean;
}

export interface Forecast {
  attack: Strike;
  counter: Strike & { weapon: Weapon | null };
  // 速度差 50 以上的一方再打一次
  extra: "attacker" | "defender" | null;
}

const strike = (r: { flags: number; hit: number; damage: number }): Strike => ({
  hit: r.hit,
  damage: r.damage,
  valid: !!(r.flags & FLAG_VALID),
  lethal: !!(r.flags & FLAG_LETHAL),
});

// 修理武器：第 0 字节高 4 位是 F
export const isRepair = (w: Weapon) => w.rangeByte >= 0xf0;

export class Rules {
  // 干扰：本回合敌方命中减半
  jamming = false;

  private stage: Stage;

  constructor(stage: Stage) {
    this.stage = stage;
  }

  terrainEffectAt(p: Point) {
    return this.stage.terrainEffect[this.stage.map.terrain[p.y][p.x]];
  }

  canHit(weapon: Weapon, from: Point, target: Point, moved: boolean) {
    return inRange(toRuleWeapon(weapon), distance(from, target), moved);
  }

  // 战前预测。attacker 站在 from（可能是移动后的位置），moved 表示这次行动移动过
  forecast(attacker: Unit, weapon: Weapon, defender: Unit, from: Point, moved: boolean): Forecast {
    const p = this.preview(attacker, weapon, defender, from, moved);
    const attack = strike(p.attack);
    const counterWeapon = p.counter.slot >= 0 && p.counter.flags & FLAG_VALID ? defender.weapons[p.counter.slot] : null;
    const counter = { ...strike(p.counter), weapon: counterWeapon };
    const extra = attack.valid ? extraAttacker({ ...toRule(attacker) }, toRule(defender), { counterValid: counter.valid }) : null;
    return { attack, counter, extra };
  }

  // 原版的战前预测（previewBattle），再叠加机师特性。玩家预测和敌方 AI 评分都用它
  private preview(attacker: Unit, weapon: Weapon, defender: Unit, from: Point, moved: boolean) {
    const p = previewBattle({
      weapon: toRuleWeapon(weapon),
      atk: { ...toRule(attacker), x: from.x, y: from.y },
      def: toRule(defender),
      defWeapons: defender.weapons.map(toRuleWeapon),
      dist: distance(from, defender),
      moved,
      defTerrain: this.terrainEffectAt(defender),
      atkTerrain: this.terrainEffectAt(from),
      jamming: this.jamming,
    });
    this.applyTraits(p.attack, attacker, defender, weapon, from);
    const cw = p.counter.slot >= 0 ? defender.weapons[p.counter.slot] : undefined;
    if (cw) this.applyTraits(p.counter, defender, attacker, cw, defender, true);
    return p;
  }

  // 机师特性的加成（data/pilot-traits.json）。atkPos 是出手方这次战斗时的位置（指挥光环按它算），counter = 这是反击
  private applyTraits(r: { flags: number; hit: number; damage: number }, atk: Unit, def: Unit, weapon: Weapon, atkPos: Point, counter = false) {
    if (!(r.flags & FLAG_VALID)) return;
    const at = atk.trait, dt = def.trait;
    const forcedHit = atk.side === "player" && atk.spirit & FLAG.SURE_HIT;
    const forcedMiss = def.side === "player" && def.spirit & FLAG.EVADE;
    if (!forcedHit && !forcedMiss) {
      let bonus = (at?.hit ?? 0) - (dt?.evade ?? 0) + this.commandAura(atk, atkPos);
      if (weapon.range >= 2) bonus += at?.rangedHit ?? 0;
      r.hit = Math.max(0, Math.min(100, r.hit + bonus));
    }
    let dmg = r.damage;
    if (at?.lowHpDamage && atk.hp <= atk.maxHp * (at.lowHp ?? 0)) dmg *= at.lowHpDamage;
    if (counter && at?.counterDamage) dmg *= at.counterDamage;
    if (dt?.damageTaken) dmg *= dt.damageTaken;
    if (dt?.lowHpDamageTaken && def.hp <= def.maxHp * (dt.lowHp ?? 0)) dmg *= dt.lowHpDamageTaken;
    r.damage = Math.floor(dmg);
    // 能否击破按特性修正后的数值重新判断
    r.flags = r.hit > 0 && def.hp < r.damage ? r.flags | FLAG_LETHAL : r.flags & ~FLAG_LETHAL;
  }

  // 特性「指挥」：周围几格内有带指挥特性的友军，命中加成（不含自己）
  private commandAura(unit: Unit, pos: Point) {
    let bonus = 0;
    for (const u of this.stage.units) {
      const t = u.trait;
      if (u === unit || u.side !== unit.side || u.hp <= 0 || !t?.auraHit) continue;
      if (distance(u, pos) <= (t.auraRange ?? 0)) bonus = Math.max(bonus, t.auraHit);
    }
    return bonus;
  }

  // 能攻击的目标：从 from 出发，用这把武器。修理武器的目标是射程内没满血的友军
  targetsFor(attacker: Unit, weapon: Weapon, from: Point, moved: boolean, units: Unit[]) {
    if (isRepair(weapon)) {
      return units.filter((u) => u !== attacker && u.side === attacker.side && u.hp > 0 && u.hp < u.maxHp && this.canHit(weapon, from, u, moved));
    }
    return units.filter((u) => u.side !== attacker.side && u.hp > 0 && this.canHit(weapon, from, u, moved) && this.forecast(attacker, weapon, u, from, moved).attack.valid);
  }

  // 修理（bank 4 $8904，原版实测：阿波罗A 最大 HP 280 给 HP 10 的太勒回复 140）：
  // 回复量 = min(缺的 HP, 修理者最大 HP / 2)，不算命中、没有反击、不给经验，在地图上直接回复
  repairAmount(repairer: Unit, target: Unit) {
    return Math.min(target.maxHp - target.hp, repairer.maxHp >> 1);
  }

  repair(repairer: Unit, target: Unit) {
    const amount = this.repairAmount(repairer, target);
    target.hp += amount;
    return amount;
  }

  // 执行一场战斗，返回出手顺序（给演出用）。会直接修改双方 HP
  fight(attacker: Unit, weapon: Weapon, defender: Unit, moved: boolean): BattleEvent[] {
    const events: BattleEvent[] = [];
    const f = this.forecast(attacker, weapon, defender, attacker, moved);
    const dist = distance(attacker, defender);
    const hitOnce = (from: Unit, to: Unit, s: Strike, w: Weapon) => {
      const r = resolveStrike({ damage: s.damage, hit: s.hit, weaponKind: w.rangeByte & 0xf0 }, toRule(to), { dist, rand });
      if (r.hit) to.hp = Math.max(0, to.hp - r.damage);
      events.push({ from, to, weapon: w, hit: r.hit, damage: r.hit ? r.damage : 0, hpAfter: to.hp });
      return to.hp === 0;
    };
    if (hitOnce(attacker, defender, f.attack, weapon)) return events;
    if (f.counter.valid && f.counter.weapon && hitOnce(defender, attacker, f.counter, f.counter.weapon)) return events;
    if (f.extra === "attacker") hitOnce(attacker, defender, f.attack, weapon);
    else if (f.extra === "defender" && f.counter.weapon) hitOnce(defender, attacker, f.counter, f.counter.weapon);
    return events;
  }

  // 击破奖励：经验（只有我方击破才有）和资金。返回升了几级
  // bonus：经验加成百分比（击破连击）
  reward(killer: Unit, victim: Unit, money: { value: number }, bonus = 0) {
    if (killer.side !== "player") return { exp: 0, levels: 0 };
    const gain = Math.floor((expForKill(victim.expBase, victim.levelIndex, killer.levelIndex) * (100 + bonus)) / 100);
    // 重制版不设上限（原版经验 65535、资金 9999）
    killer.exp += gain;
    money.value += victim.money;
    // 特性「斗志」：击破后 SP 回复
    if (killer.trait?.spOnKill) killer.sp = Math.min(killer.maxSp, killer.sp + killer.trait.spOnKill);
    const newLevel = levelForExp(killer.exp, killer.levelIndex);
    return { exp: gain, levels: newLevel - killer.levelIndex, newLevel };
  }

  // ---------- 精神指令 ----------
  spiritMenu(unit: Unit, units: Unit[]) {
    const ruleUnits = units.map((u) => ({ ...toRule(u), alive: u.hp > 0, hidden: false }));
    const self = { ...toRule(unit), sp: unit.sp };
    return unit.spirits
      .map((s) => ({ spirit: s, def: SPIRITS[s.id] }))
      .filter(({ def }) => def)
      .map(({ spirit, def }) => ({ spirit, def, usable: unit.sp >= def.cost && USABLE[def.usable as keyof typeof USABLE](self, ruleUnits) }));
  }

  // 使用精神。target 只在「选一个我方」时需要。返回给界面提示用的结果
  useSpirit(unit: Unit, spiritId: number, units: Unit[], target?: Unit): { text: string; affected: { unit: Unit; amount: number; kind: "heal" | "damage" }[] } {
    const def = SPIRITS[spiritId];
    unit.sp -= def.cost;
    const eff = def.effect;
    const affected: { unit: Unit; amount: number; kind: "heal" | "damage" }[] = [];
    const heal = (u: Unit) => {
      const before = u.hp;
      u.hp = applyHeal(u, healAmount(eff.amount, u, rand));
      affected.push({ unit: u, amount: u.hp - before, kind: "heal" });
    };
    switch (eff.kind) {
      case "flag":
        unit.spirit |= eff.flag ?? 0;
        break;
      case "heal":
        if (eff.target === "self") heal(unit);
        else if (eff.target === "ally" && target) heal(target);
        else if (eff.target === "allies") units.filter((u) => u.side === "player" && u.hp > 0).forEach(heal);
        break;
      case "damage":
        for (const u of units.filter((x) => x.side === "enemy" && x.hp > 0)) {
          const d = Math.min(u.hp, spiritDamage(eff.amount, rand));
          u.hp -= d;
          affected.push({ unit: u, amount: d, kind: "damage" });
        }
        break;
      case "jamming":
        this.jamming = true;
        break;
    }
    return { text: `${unit.pilotName}：${def.name}！`, affected };
  }

  mobility(unit: Unit) {
    return mobilityOf(unit.move, unit.side === "player" ? unit.spirit : 0);
  }

  // ---------- AI（敌人和友军 NPC，由 AI 脚本调用） ----------
  // 行动顺序：按到最近我方单位的空中距离从近到远（原版只给敌方排序）
  enemyOrder(units: Unit[]) {
    const map = this.stage.map;
    const enemies = units.filter((u) => u.side === "enemy" && u.hp > 0);
    const order: number[] = enemyOrder({
      terrain: map.terrain,
      airCosts: map.moveCost[MOVE_TYPE_ROW.air],
      enemies: enemies.map(toRule),
      players: units.filter((u) => u.side === "player" && u.hp > 0).map(toRule),
    });
    return order.map((i) => enemies.find((e) => e.index === i)!);
  }

  private foes(unit: Unit, units: Unit[]) {
    return units.filter((u) => u.hp > 0 && u.side !== unit.side);
  }

  // 本单位的距离图：敌对单位挡路
  private gridOf(unit: Unit, units: Unit[], start: Point = unit, mobility = this.mobility(unit)) {
    const map = this.stage.map;
    const costs = map.moveCost[MOVE_TYPE_ROW[unit.moveType]];
    const blocked = new Set(this.foes(unit, units).map((p) => `${p.x},${p.y}`));
    return distanceGrid({ terrain: map.terrain, costs, start, mobility, blocked });
  }

  private occupiedBy(unit: Unit, units: Unit[]) {
    return new Set(units.filter((u) => u.hp > 0 && u !== unit).map((u) => `${u.x},${u.y}`));
  }

  // 脚本指令「选攻击」（$1A）：canMove 为假时只考虑原地能打的；onlyPilot 限定目标（「攻击指定单位」）
  pickAttack(unit: Unit, units: Unit[], mode: number, canMove: boolean, onlyPilot?: number): AiPlan | null {
    const foes = this.foes(unit, units).filter((u) => onlyPilot === undefined || samePilot(u.pilotId, onlyPilot));
    if (!foes.length) return null;
    const ruleWeapons = unit.weapons.map(toRuleWeapon);
    type Choice = { x: number; y: number; weapon: number; target: number };
    const best = chooseAttack({
      unit: toRule(unit),
      weapons: ruleWeapons,
      targets: foes.map(toRule),
      mode,
      canMove,
      grid: this.gridOf(unit, units),
      mobility: this.mobility(unit),
      occupied: this.occupiedBy(unit, units),
      evaluate: (w: unknown, t: RuleUnit, pos: Point, moved: boolean) => {
        const target = foes.find((p) => p.index === t.index)!;
        const weapon = unit.weapons[ruleWeapons.indexOf(w as (typeof ruleWeapons)[number])];
        return this.preview(unit, weapon, target, pos, moved);
      },
    }) as Choice | null;
    if (!best) return null;
    return { to: { x: best.x, y: best.y }, weapon: unit.weapons[best.weapon], target: foes.find((p) => p.index === best.target)! };
  }

  // 脚本指令「接近」（$14）：向最近的敌对单位（或指定单位）旁边移动，本回合走得到的最近一格
  approach(unit: Unit, units: Unit[], onlyPilot?: number): Point | null {
    const targets = this.foes(unit, units).filter((u) => onlyPilot === undefined || samePilot(u.pilotId, onlyPilot));
    const all = onlyPilot === undefined ? targets : units.filter((u) => u.hp > 0 && samePilot(u.pilotId, onlyPilot));
    if (!all.length) return null;
    const grid = this.gridOf(unit, units);
    const goal = moveGoal(all.map(toRule), grid, this.occupiedBy(unit, units));
    return goal ? this.stepToward(unit, units, goal, grid) : null;
  }

  // 脚本指令「移动到 (x,y)」：本回合能停的格里离目标最近的
  moveToward(unit: Unit, units: Unit[], goal: Point): Point | null {
    return this.stepToward(unit, units, goal, this.gridOf(unit, units));
  }

  private stepToward(unit: Unit, units: Unit[], goal: Point, grid: number[][]): Point | null {
    const gridFromGoal = this.gridOf(unit, units, goal, 0xfc);
    const to: Point = moveStep({ grid, gridFromGoal, mobility: this.mobility(unit), occupied: this.occupiedBy(unit, units), self: unit, rand });
    if (grid[to.y][to.x] === BLOCKED || (to.x === unit.x && to.y === unit.y)) return null;
    return to;
  }
}

export interface BattleEvent {
  from: Unit;
  to: Unit;
  weapon: Weapon;
  hit: boolean;
  damage: number;
  hpAfter: number;
}

// AI 选好的攻击：先移动到 to，再用 weapon 打 target
export interface AiPlan {
  to: Point;
  weapon: Weapon;
  target: Unit;
}

// 驾驶员 8、9、10（盖塔三人）在脚本比较时都当作 8（docs/notes-events.md 第 2 节）
export const samePilot = (a: number, b: number) => (a >= 8 && a <= 10 ? 8 : a) === (b >= 8 && b <= 10 ? 8 : b);
