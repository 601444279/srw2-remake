// 自动测试的我方 AI（只在自动测试里用，见 autotest.ts / game.autoPlayerTurn）：像一个谨慎的玩家那样打，
// 让后面的保护、撤离、坚守关也能自动打通。每个单位按顺序考虑：
//   撤离关只管往出口走 → 修理受伤的友军 → 伤重就撤到安全的地方 → 打分最高的攻击 → 稳妥地接近
// 攻击打分：期望伤害占对方剩余 HP 的比例、击破的把握、要打倒的头目加分、离要保护的人近的敌人加分，
//   减去预计挨的反击和停留格子会被几个敌人打到。
import { stageGoals, type Stage, type Unit, type Weapon } from "./data.ts";
import { fromKey, inBounds, key, terrainCost, type Point, type Reach } from "./grid.ts";
import { isRepair, samePilot, type Rules } from "./rules.ts";

export type BotPlan =
  | { kind: "attack"; to: Point; weapon: Weapon; target: Unit }
  | { kind: "repair"; to: Point; weapon: Weapon; target: Unit }
  | { kind: "move"; to: Point };

export interface BotWorld {
  stage: Stage;
  rules: Rules;
  units: Unit[];
  reach(u: Unit): Reach;
  threat(u: Unit, reach: Reach): Set<number>;
  repairTerrain: number;
}

const dist = (a: Point, b: Point) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

export class AutoPilot {
  private goals: ReturnType<typeof stageGoals>;
  constructor(private w: BotWorld) {
    this.goals = stageGoals(w.stage.events);
  }

  private get alive() { return this.w.units.filter((u) => u.hp > 0); }
  private enemies() { return this.alive.filter((u) => u.side === "enemy"); }
  private allies() { return this.alive.filter((u) => u.side === "player"); }
  private isVip(u: Unit) { return u.npc || this.goals.mustLive.some((p) => samePilot(u.pilotId, p)); }
  private isBoss(u: Unit) { return this.goals.defeat.some((p) => samePilot(u.pilotId, p)); }

  // 每个格子会被几个敌人打到（这一轮我方行动开始时算一次；击破后重算）
  private dangerMap: Map<number, number> | null = null;
  invalidate() { this.dangerMap = null; }
  private danger(p: Point) {
    if (!this.dangerMap) {
      this.dangerMap = new Map();
      for (const e of this.enemies()) for (const k of this.w.threat(e, this.w.reach(e))) this.dangerMap.set(k, (this.dangerMap.get(k) ?? 0) + 1);
    }
    return this.dangerMap.get(key(this.w.stage.map, p.x, p.y)) ?? 0;
  }

  // 撤离关要赶路：有加速 / 疾风就用
  get hurry() { return this.goals.exits.length > 0; }

  plan(u: Unit): BotPlan | null {
    const reach = this.w.reach(u);
    const map = this.w.stage.map;
    const stops = [...reach.stops].map((k) => fromKey(map, k));
    const hpRate = u.hp / u.maxHp;
    const vip = this.isVip(u);

    // 撤离关：出口走得到就走过去（待命时格子事件把人撤走）；走不到就边打边往出口挪
    if (this.goals.exits.length) {
      const exit = stops.find((p) => this.goals.exits.some((e) => e.x === p.x && e.y === p.y));
      if (exit) return { kind: "move", to: exit };
      // 走不近（敌人堵在通道里）就先打
      const field = this.field(this.goals.exits, u);
      const to = this.toward(stops, this.goals.exits, u, 0);
      const at = (p: Point) => field.get(key(map, p.x, p.y)) ?? 9999;
      if (at(to) >= at(u)) return this.bestAttack(u, stops, false, "boxed") ?? { kind: "move", to };
      return { kind: "move", to };
    }

    // 修理：射程内受伤最重的友军（要保护的人优先）
    const repair = this.planRepair(u, stops);
    if (repair) return repair;

    // 伤重：撤退（要保护的人更早撤）。没地方回血（没有补给格、没人会修理、精神也用不了回复）就别躲了，接着打
    if (hpRate < (vip ? 0.6 : 0.35)) {
      const attack = this.bestAttack(u, stops, true);
      if (attack) return attack;
      if (this.canHeal(u)) return { kind: "move", to: this.safest(u, stops) };
      const any = this.bestAttack(u, stops, false);
      if (any) return any;
    }

    const attack = this.bestAttack(u, stops, vip) ?? (!vip && hpRate > 0.6 ? this.bestAttack(u, stops, false, "anyScore") : null);
    // 有要打倒的头目（常常还有回合限制）：离头目还远就别在路上纠缠，除非这一下能打掉对方
    const bossList = this.enemies().filter((e) => this.isBoss(e));
    if (attack?.kind === "attack" && bossList.length && !vip && !this.isBoss(attack.target)) {
      const field = this.field(bossList, u);
      const far = (field.get(key(map, u.x, u.y)) ?? 9999) > this.w.rules.mobility(u) * 2;
      const kills = this.w.rules.forecast(u, attack.weapon, attack.target, attack.to, attack.to.x !== u.x || attack.to.y !== u.y).attack.damage >= attack.target.hp;
      if (far && !kills) return { kind: "move", to: this.toward(stops, bossList, u, 0.25) };
    }
    if (attack) return attack;

    // 接近：要保护的人找最安全的格子待着；其他人往敌人那边走，不停在太危险的格子
    if (vip) return { kind: "move", to: this.safest(u, stops) };
    // 先去拦逼近要保护的人的敌人，再去找头目，最后是随便哪个敌人
    const vips = this.allies().filter((a) => this.isVip(a));
    const threats = this.enemies().filter((e) => vips.some((v) => dist(v, e) <= 8));
    const bosses = this.enemies().filter((e) => this.isBoss(e));
    const goal = threats.length ? threats : bosses.length ? bosses : this.enemies();
    if (!goal.length) return null;
    // 去打头目时少顾忌一点危险（常常有回合限制）
    const caution = goal === bosses ? (hpRate > 0.5 ? 0.25 : 1) : hpRate > 0.7 ? 1 : 3;
    return { kind: "move", to: this.toward(stops, goal, u, caution) };
  }

  private canHeal(u: Unit) {
    if (this.w.stage.map.terrain.some((row) => row.includes(this.w.repairTerrain))) return true;
    if (this.allies().some((a) => a !== u && a.weapons.some(isRepair))) return true;
    return this.w.rules.spiritMenu(u, this.w.units).some((s) => s.usable && s.def.effect.kind === "heal");
  }

  private planRepair(u: Unit, stops: Point[]): BotPlan | null {
    const weapon = u.weapons.find(isRepair);
    if (!weapon) return null;
    let best: { score: number; plan: BotPlan } | null = null;
    for (const t of this.allies()) {
      if (t === u || t.hp >= t.maxHp * 0.7) continue;
      const need = 1 - t.hp / t.maxHp + (this.isVip(t) ? 0.5 : 0);
      for (const p of stops) {
        if (!this.w.rules.canHit(weapon, p, t, p.x !== u.x || p.y !== u.y)) continue;
        const score = need - this.danger(p) * 0.08;
        if (!best || score > best.score) best = { score, plan: { kind: "repair", to: p, weapon, target: t } };
      }
    }
    return best?.plan ?? null;
  }

  // careful：只接受挨反击少、停留格安全的攻击
  // force：「anyScore」不划算也打（但不送死）；「boxed」被堵住了，怎么都打
  private bestAttack(u: Unit, stops: Point[], careful: boolean, force: "anyScore" | "boxed" | false = false): BotPlan | null {
    const rules = this.w.rules;
    const vips = this.allies().filter((a) => this.isVip(a));
    let best: { score: number; plan: BotPlan } | null = null;
    for (const p of stops) {
      const moved = p.x !== u.x || p.y !== u.y;
      const danger = this.danger(p);
      for (const weapon of u.weapons) {
        if (isRepair(weapon)) continue;
        for (const t of this.enemies()) {
          if (!rules.canHit(weapon, p, t, moved)) continue;
          const f = rules.forecast(u, weapon, t, p, moved);
          if (!f.attack.valid) continue;
          const hit = f.attack.hit / 100;
          const swings = f.extra === "attacker" ? 2 : 1;
          const dealt = Math.min(t.hp, f.attack.damage * swings) * hit;
          const kill = f.attack.damage * swings >= t.hp ? hit : 0;
          const taken = f.counter.valid ? (f.counter.hit / 100) * f.counter.damage * (f.extra === "defender" ? 2 : 1) : 0;
          const takenRate = taken / Math.max(1, u.hp);
          let score = dealt / t.maxHp + kill * 1.5 - takenRate * 1.2 - danger * 0.06 * (1.5 - u.hp / u.maxHp);
          if (this.isBoss(t)) score += 1;
          if (vips.some((v) => dist(v, t) <= 4)) score += 0.4;
          if (careful && (takenRate > 0.3 || danger > 2)) continue;
          if (taken >= u.hp && kill < 0.9 && force !== "boxed") continue; // 可能被反击打下来
          if (!best || score > best.score) best = { score, plan: { kind: "attack", to: p, weapon, target: t } };
        }
      }
    }
    return best && (best.score > 0 || force) ? best.plan : null;
  }

  // 最安全的格子：被打到的次数少、补给格加分、靠近会修理的友军加分、离敌人远
  private safest(u: Unit, stops: Point[]): Point {
    const repairers = this.allies().filter((a) => a !== u && a.weapons.some(isRepair));
    const enemies = this.enemies();
    let best = { x: u.x, y: u.y }, bestScore = -Infinity;
    for (const p of stops.length ? stops : [best]) {
      const near = enemies.length ? Math.min(...enemies.map((e) => dist(e, p))) : 99;
      let score = -this.danger(p) * 3 + Math.min(near, 8) * 0.3;
      if (this.w.stage.map.terrain[p.y][p.x] === this.w.repairTerrain) score += 4;
      if (repairers.some((r) => dist(r, p) <= 3)) score += 1.5;
      score += this.w.rules.terrainEffectAt(p) < 100 ? 0.5 : 0;
      if (score > bestScore) { bestScore = score; best = p; }
    }
    return best;
  }

  // 往目标走：按地形算的路程（绕开墙）越短越好，危险格按 caution 扣分
  private toward(stops: Point[], goals: Point[], u: Unit, caution: number): Point {
    const field = this.field(goals, u);
    const map = this.w.stage.map;
    let best = { x: u.x, y: u.y }, bestScore = -Infinity;
    for (const p of stops) {
      const d = field.get(key(map, p.x, p.y)) ?? 9999;
      const score = -d - this.danger(p) * caution * 2;
      if (score > bestScore) { bestScore = score; best = p; }
    }
    return best;
  }

  // 从目标格出发、按这个单位的地形消耗算的路程（不管别的单位挡路）
  private field(goals: Point[], u: Unit) {
    const map = this.w.stage.map;
    const cost = new Map<number, number>();
    const queue: [number, number][] = [];
    for (const g of goals) { const k = key(map, g.x, g.y); cost.set(k, 0); queue.push([0, k]); }
    while (queue.length) {
      queue.sort((a, b) => a[0] - b[0]);
      const [c, k] = queue.shift()!;
      if (c > (cost.get(k) ?? Infinity)) continue;
      const { x, y } = fromKey(map, k);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (!inBounds(map, nx, ny)) continue;
        const step = terrainCost(map, u.moveType, nx, ny);
        if (step === 0) continue;
        const nk = key(map, nx, ny);
        if (c + step < (cost.get(nk) ?? Infinity)) { cost.set(nk, c + step); queue.push([c + step, nk]); }
      }
    }
    return cost;
  }
}
