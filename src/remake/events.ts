// 关卡事件和敌人 AI：用原版脚本（data/events）驱动。实现 script.ts 需要的 ScriptHost，
// 具体的画面、战斗、移动由 Game 通过 EventApi 提供。运行时机见 docs/notes-events.md 第 1 节：
//   start       进关时，以及每个我方回合开始
//   enemyPhase  每个敌方回合开始（敌人行动之前）
//   check       每个单位行动结束后、每个我方回合开始（胜负判定、过关都在这里）
import { AI_SCRIPTS, createUnit, type Stage, type Unit, type Weapon } from "./data.ts";
import { ScriptRunner, type ScriptHost, type RunnerState } from "./script.ts";
import { samePilot, type AiPlan, type Rules } from "./rules.ts";
import type { Point } from "./grid.ts";
import type { SceneRef } from "./story.ts";

export interface EventApi {
  stage: Stage;
  rules: Rules;
  turn(): number;
  money: { value: number };
  playScene(ref: SceneRef): Promise<void>;
  focus(p: Point): Promise<void>;
  moveUnit(unit: Unit, to: Point): Promise<void>;
  battle(attacker: Unit, weapon: Weapon, defender: Unit, moved: boolean): Promise<void>;
  addUnit(unit: Unit): Promise<void>;
  removeUnit(unit: Unit): Promise<void>;
  wait(seconds: number): Promise<void>;
  music(kind: "player" | "enemy" | "now", song: number | "stop" | "restore"): void;
  finish(result: "clear" | "gameover" | "ending"): Promise<void>;
}

// 存档用：三段关卡脚本、每个单位的 AI / NPC 脚本的进度（按单位 id），标志位，上一场战斗
export interface EventsState {
  start: RunnerState;
  enemyPhase: RunnerState;
  check: RunnerState;
  units: Record<number, RunnerState>;
  flags: number[];
  battleRecord: BattleRecord | null;
  finished: boolean;
}

// 上一场战斗（条件 battle 用）：攻守双方驾驶员和是否被击破
export interface BattleRecord {
  attacker: number;
  defender: number;
  attackerDown: boolean;
  defenderDown: boolean;
}

const ANY_PLAYER = 0xfd;
const ANY_ENEMY = 0xfe;
const ANY = 0xff;
// 没解析到的 AI 脚本按「能打就打，打不到就接近」处理（AI 10）
const DEFAULT_AI = 10;

export class StageEvents implements ScriptHost {
  private start: ScriptRunner;
  private enemyPhase: ScriptRunner;
  private check: ScriptRunner;
  private unitScripts = new Map<Unit, ScriptRunner>();
  private flags = new Set<number>();
  private self: Unit | null = null;
  private plan: { to?: Point; attack?: AiPlan } = {};
  private movedThisAction = false;
  battleRecord: BattleRecord | null = null;
  finished = false;
  private api: EventApi;

  constructor(api: EventApi) {
    this.api = api;
    const s = api.stage.events.scripts;
    this.start = new ScriptRunner(s.start, this);
    this.enemyPhase = new ScriptRunner(s.enemyPhase, this);
    this.check = new ScriptRunner(s.check, this);
  }

  private get units() {
    return this.api.stage.units;
  }

  snapshot(): EventsState {
    const units: Record<number, RunnerState> = {};
    for (const [u, r] of this.unitScripts) units[u.id] = r.snapshot();
    return {
      start: this.start.snapshot(),
      enemyPhase: this.enemyPhase.snapshot(),
      check: this.check.snapshot(),
      units,
      flags: [...this.flags],
      battleRecord: this.battleRecord,
      finished: this.finished,
    };
  }

  // 读档后恢复（单位已经换成存档里的那批）
  restore(s: EventsState) {
    this.start.restore(s.start);
    this.enemyPhase.restore(s.enemyPhase);
    this.check.restore(s.check);
    this.unitScripts.clear();
    for (const [id, state] of Object.entries(s.units)) {
      const u = this.units.find((x) => x.id === Number(id));
      if (!u) continue;
      this.runnerFor(u).restore(state);
    }
    this.flags = new Set(s.flags);
    this.battleRecord = s.battleRecord;
    this.finished = s.finished;
  }

  // ---------- 运行时机 ----------
  runStart() { return this.start.resume(); }
  runEnemyPhase() { return this.enemyPhase.resume(); }
  async runCheck() { if (!this.finished) await this.check.resume(); }

  // 一个敌人或友军 NPC 的行动：从它的脚本上次停下的地方继续
  private runnerFor(unit: Unit) {
    let runner = this.unitScripts.get(unit);
    if (!runner) {
      const scripts = unit.npc ? this.api.stage.events.npcScripts : AI_SCRIPTS;
      const script = scripts[String(unit.aiScript)] ?? AI_SCRIPTS[String(DEFAULT_AI)];
      runner = new ScriptRunner(script, this);
      this.unitScripts.set(unit, runner);
    }
    return runner;
  }

  async runUnit(unit: Unit) {
    const runner = this.runnerFor(unit);
    this.self = unit;
    this.plan = {};
    this.movedThisAction = false;
    await runner.resume();
    this.self = null;
  }

  // ---------- 条件 ----------
  turn() { return this.api.turn(); }
  flag(n: number) { return this.flags.has(n); }
  setFlag(n: number, on: boolean) { if (on) this.flags.add(n); else this.flags.delete(n); }

  private find(pilot: number) {
    return this.units.find((u) => u.hp > 0 && samePilot(u.pilotId, pilot));
  }

  private matches(u: Unit | undefined, who: number) {
    if (!u || u.hp <= 0) return false;
    if (who === ANY) return true;
    if (who === ANY_PLAYER) return u.side === "player";
    if (who === ANY_ENEMY) return u.side === "enemy";
    return samePilot(u.pilotId, who);
  }

  unitBit(pilot: number, bit: number) {
    const u = this.find(pilot);
    return u ? !!(u.bits & (1 << bit)) : null;
  }
  setUnitBit(pilot: number, bit: number, on: boolean) {
    const u = this.find(pilot);
    if (u) u.bits = on ? u.bits | (1 << bit) : u.bits & ~(1 << bit);
  }
  inRoster(pilot: number) { return this.api.stage.roster.some((m) => samePilot(m.pilot, pilot)); }
  exists(pilot: number) { return !!this.find(pilot); }
  onMap(pilot: number) { return !!this.find(pilot); }
  enemyCount() { return this.units.filter((u) => u.hp > 0 && u.side === "enemy").length; }
  allyCount() { return this.units.filter((u) => u.hp > 0 && u.side === "player" && !u.npc).length; }
  hpAtLeast(pilot: number, hp: number) {
    const u = this.find(pilot);
    if (!u) return false;
    return hp === 0 ? u.hp >= u.maxHp : u.hp >= hp;
  }
  sideInRect(side: "player" | "enemy", x1: number, y1: number, x2: number, y2: number) {
    return this.units.some((u) => u.hp > 0 && u.side === side && u.x >= x1 && u.x <= x2 && u.y >= y1 && u.y <= y2);
  }
  unitAtIs(x: number, y: number, who: number) {
    return this.matches(this.units.find((u) => u.hp > 0 && u.x === x && u.y === y), who);
  }
  selfBit(bit: number) { return !!this.self && !!(this.self.bits & (1 << bit)); }
  setSelfBit(bit: number, on: boolean) {
    const u = this.self;
    if (u) u.bits = on ? u.bits | (1 << bit) : u.bits & ~(1 << bit);
  }
  selfAdjacent(who: number) {
    const s = this.self;
    return !!s && this.units.some((u) => u !== s && this.matches(u, who) && Math.abs(u.x - s.x) + Math.abs(u.y - s.y) === 1);
  }
  selfAt(x: number, y: number) { return !!this.self && this.self.x === x && this.self.y === y; }
  selfInRect(x1: number, y1: number, x2: number, y2: number) {
    const s = this.self;
    return !!s && s.x >= x1 && s.x <= x2 && s.y >= y1 && s.y <= y2;
  }
  foeWithin(d: number) {
    const s = this.self;
    return !!s && this.units.some((u) => u.hp > 0 && u.side !== s.side && Math.abs(u.x - s.x) + Math.abs(u.y - s.y) <= d);
  }
  selfHpAtLeast(hp: number) { return !!this.self && (hp === 0 ? this.self.hp >= this.self.maxHp : this.self.hp >= hp); }
  select(pilot: number) {
    const u = this.find(pilot);
    if (u) this.self = u;
    return !!u;
  }
  // 上一场战斗：mask 的 bit4 / bit5 推断为「守方被击破」/「攻方被击破」（docs/notes-events.md）
  lastBattle(attacker: number, defender: number, mask: number, value: number) {
    const b = this.battleRecord;
    if (!b) return false;
    if (attacker !== ANY && !samePilot(b.attacker, attacker)) return false;
    if (defender !== ANY && !samePilot(b.defender, defender)) return false;
    const bits = (b.defenderDown ? 0x10 : 0) | (b.attackerDown ? 0x20 : 0);
    return (bits & mask & 0x30) === (value & 0x30);
  }

  // ---------- 动作 ----------
  async talk(dialog: string, face: number | null, focus: { pilot?: number; cursor?: boolean }) {
    if (focus.pilot !== undefined) {
      const u = this.find(focus.pilot);
      if (u) await this.api.focus(u);
    }
    await this.api.playScene(sceneRef(dialog, face));
  }
  async narrate(dialog: string) { await this.api.playScene(sceneRef(dialog, null)); }
  async cursorTo(x: number, y: number) { await this.api.focus({ x, y }); }
  async focusUnit(pilot: number) {
    const u = this.find(pilot);
    if (u) await this.api.focus(u);
  }
  async selectCamera(pilot: number) {
    const u = this.find(pilot);
    if (u) this.self = u;
    if (this.self) await this.api.focus(this.self);
  }

  async spawn(side: "enemy" | "npc", x: number, y: number, pilot: number, mech: number, level: number, script: number) {
    const stage = this.api.stage;
    const p = this.freeSpot({ x, y });
    const unit = createUnit(stage, { side: side === "enemy" ? "enemy" : "player", npc: side === "npc", x: p.x, y: p.y, unitId: mech, pilotId: pilot, level, aiScript: script });
    await this.api.addUnit(unit);
  }

  async deployAlly(x: number, y: number, roster: number) {
    const m = this.api.stage.roster.find((r) => r.member === roster);
    if (!m) return;
    const p = this.freeSpot({ x, y });
    const unit = createUnit(this.api.stage, { side: "player", roster, x: p.x, y: p.y, unitId: m.unit, pilotId: m.pilot, level: m.level, aiScript: 0 });
    await this.api.addUnit(unit);
  }

  // 格子被占时放到附近的空格（原版行为）
  private freeSpot(p: Point): Point {
    const map = this.api.stage.map;
    const taken = (x: number, y: number) => this.units.some((u) => u.hp > 0 && u.x === x && u.y === y);
    for (let r = 0; r < 8; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.abs(dx) + Math.abs(dy) !== r) continue;
          const x = p.x + dx, y = p.y + dy;
          if (x >= 0 && y >= 0 && x < map.width && y < map.height && !taken(x, y)) return { x, y };
        }
      }
    }
    return p;
  }

  changeMech(pilot: number, mech: number, newPilot?: number) {
    const m = this.api.stage.roster.find((r) => samePilot(r.pilot, pilot));
    if (m) {
      m.unit = mech;
      if (newPilot !== undefined) m.pilot = newPilot;
    }
    // 地图上的单位换乘要重建（数值、武器、图标都变），等需要时再做
  }
  money(amount: number) { this.api.money.value = Math.min(9999, this.api.money.value + amount); }

  // 原版换曲代码：$80+n / $C0+n 放第 n 首；FA 停止，FB 恢复当前回合曲，FC / FD 我方 / 敌方回合曲
  bgm(kind: "player" | "enemy" | "now", track: number) {
    if (kind !== "now") { this.api.music(kind, track & 0x3f); return; }
    if (track === 0xfa) this.api.music("now", "stop");
    else if (track === 0xfb) this.api.music("now", "restore");
    else if (track === 0xfc) this.api.music("player", "restore");
    else if (track === 0xfd) this.api.music("enemy", "restore");
    else this.api.music("now", track & 0x3f);
  }

  async wait(frames: number) { await this.api.wait(frames / 60); }
  rosterAdd(roster: number, pilot: number, mech: number, level: number) {
    const list = this.api.stage.roster;
    const i = list.findIndex((m) => m.member === roster);
    const m = { member: roster, pilot, unit: mech, level };
    if (i >= 0) list[i] = m; else list.push(m);
  }
  rosterRemove(roster: number) {
    const list = this.api.stage.roster;
    const i = list.findIndex((m) => m.member === roster);
    if (i >= 0) list.splice(i, 1);
  }
  endAction() { if (this.self) this.self.acted = true; }
  async removeSelf() { if (this.self) await this.api.removeUnit(this.self); }
  switchSide(to: "npc" | "enemy" | "player", roster?: number) {
    const u = this.self;
    if (!u) return;
    u.side = to === "enemy" ? "enemy" : "player";
    u.npc = to === "npc";
    if (to === "player") u.roster = roster ?? null;
    this.unitScripts.delete(u);
  }
  async stageClear() { this.finished = true; await this.api.finish("clear"); }
  async gameOver() { this.finished = true; await this.api.finish("gameover"); }
  async ending() { this.finished = true; await this.api.finish("ending"); }

  // ---------- AI ----------
  actor() { this.plan = {}; this.movedThisAction = false; }

  // bit 5 =「不移动」：只考虑原地能打到的目标，也不会接近
  private canMove() { return !!this.self && !(this.self.bits & 0x20) && !this.movedThisAction; }

  aiPickAttack(mode: number, targetPilot?: number) {
    if (!this.self) return false;
    const plan = this.api.rules.pickAttack(this.self, this.units, mode, this.canMove(), targetPilot);
    if (plan) this.plan = { attack: plan };
    return !!plan;
  }
  aiApproach(targetPilot?: number) {
    if (!this.self || !this.canMove() || this.plan.attack) return;
    const to = this.api.rules.approach(this.self, this.units, targetPilot);
    if (to) this.plan = { to };
  }
  // 脚本指定的移动（撤退、走到某处）不受「不移动」限制
  aiMoveTo(x: number, y: number) {
    if (!this.self || this.plan.attack) return;
    const to = this.api.rules.moveToward(this.self, this.units, { x, y });
    if (to) this.plan = { to };
  }
  async aiExec() {
    const u = this.self;
    if (!u) return;
    const { to, attack } = this.plan;
    this.plan = {};
    const dest = attack?.to ?? to;
    const moved = !!dest && (dest.x !== u.x || dest.y !== u.y);
    if (dest || attack) await this.api.focus(u);
    if (moved) { await this.api.moveUnit(u, dest!); this.movedThisAction = true; }
    if (attack && attack.target.hp > 0 && u.hp > 0) await this.api.battle(u, attack.weapon, attack.target, moved);
  }
}

function sceneRef(dialog: string, face: number | null): SceneRef {
  const [, res, index] = dialog.match(/^res-([0-9A-F]+)#(\d+)$/i) ?? [];
  return { res, index: Number(index), who: face ?? undefined };
}
