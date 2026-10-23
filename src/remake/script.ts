// 原版事件脚本解释器：关卡事件（开场 / 敌方阶段 / 检查）、敌人 AI、友军 NPC 共用同一套指令。
// 指令表和运行模型见 docs/notes-events.md，数据由 tools/extract-events.js 导出到 data/events。
//
// 脚本是可暂停的协程：每次 resume() 从上次停下的地方继续，执行到「暂停」为止。
//   - 动作带 pause：做完这条，下次从下一条继续
//   - 跳转带 pause：跳转成立时先跳再暂停，下次从目标继续；不成立就照常往下走
//   - stop：停在原地，以后每次调用都立即结束

export interface Op {
  at: string;
  op: string;
  pause?: boolean;
  and?: boolean;
  to?: string;
  [key: string]: unknown;
}

export interface Script {
  entry: string;
  ops: Op[];
}

// 解释器需要游戏提供的能力。pilot 是驾驶员编号；who 为 0xFD 任意我方、0xFE 任意敌方、0xFF 任意单位
export interface ScriptHost {
  // ---------- 条件 ----------
  turn(): number; // 画面上的回合数，从 1 开始
  flag(n: number): boolean;
  setFlag(n: number, on: boolean): void;
  unitBit(pilot: number, bit: number): boolean | null; // 找不到单位时 null
  setUnitBit(pilot: number, bit: number, on: boolean): void;
  inRoster(pilot: number): boolean;
  exists(pilot: number): boolean;
  onMap(pilot: number): boolean;
  enemyCount(): number;
  allyCount(): number;
  hpAtLeast(pilot: number, hp: number): boolean; // hp = 0 表示满血
  sideInRect(side: "player" | "enemy", x1: number, y1: number, x2: number, y2: number): boolean;
  unitAtIs(x: number, y: number, who: number): boolean;
  // 当前单位（select、正在行动的单位、劝降中的我方单位）
  selfBit(bit: number): boolean;
  setSelfBit(bit: number, on: boolean): void;
  selfAdjacent(who: number): boolean;
  selfAt(x: number, y: number): boolean;
  selfInRect(x1: number, y1: number, x2: number, y2: number): boolean;
  foeWithin(d: number): boolean;
  selfHpAtLeast(hp: number): boolean;
  select(pilot: number): boolean;
  lastBattle(attacker: number, defender: number, mask: number, value: number): boolean;

  // ---------- 动作 ----------
  talk(dialog: string, face: number | null, focus: { pilot?: number; cursor?: boolean }): Promise<void>;
  narrate(dialog: string): Promise<void>;
  cursorTo(x: number, y: number): Promise<void>;
  focusUnit(pilot: number, moveCursor: boolean): Promise<void>;
  spawn(side: "enemy" | "npc", x: number, y: number, pilot: number, mech: number, level: number, script: number): Promise<void>;
  deployAlly(x: number, y: number, roster: number): Promise<void>;
  changeMech(pilot: number, mech: number, newPilot?: number): Promise<void>;
  money(amount: number): void;
  bgm(kind: "player" | "enemy" | "now", track: number): void;
  wait(frames: number): Promise<void>;
  rosterAdd(roster: number, pilot: number, mech: number, level: number): void;
  rosterRemove(roster: number): void;
  selectCamera(pilot: number): Promise<void>;
  endAction(): void;
  removeSelf(): Promise<void>;
  switchSide(to: "npc" | "enemy" | "player", roster?: number): Promise<void>;
  stageClear(): Promise<void>;
  gameOver(): Promise<void>;
  ending(): Promise<void>;

  // ---------- AI（当前单位的移动 / 攻击计划） ----------
  actor(): void;
  aiPickAttack(mode: number, targetPilot?: number): boolean;
  aiApproach(targetPilot?: number): void;
  aiMoveTo(x: number, y: number): void;
  aiExec(): Promise<void>;
}

const hex = (s: string) => parseInt(s, 16);

export interface RunnerState {
  pc: number;
  cond: boolean;
  finished: boolean;
}

export class ScriptRunner {
  private index = new Map<number, number>();
  private pc: number;
  private cond = false;
  // 过关、失败、结局之后整段脚本不再运行
  private finished = false;
  private script: Script;
  private host: ScriptHost;

  constructor(script: Script, host: ScriptHost) {
    this.script = script;
    this.host = host;
    script.ops.forEach((o, i) => this.index.set(hex(o.at), i));
    this.pc = this.indexOf(script.entry);
  }

  private indexOf(addr: string) {
    const i = this.index.get(hex(addr));
    if (i === undefined) throw new Error(`脚本跳转到不存在的地址 ${addr}`);
    return i;
  }

  // 存档用：脚本进度（当前指令、条件寄存器、是否已结束）
  snapshot(): RunnerState {
    return { pc: this.pc, cond: this.cond, finished: this.finished };
  }

  restore(s: RunnerState) {
    this.pc = s.pc;
    this.cond = s.cond;
    this.finished = s.finished;
  }

  // 运行到下一个暂停点
  async resume(): Promise<void> {
    if (this.finished) return;
    // 防止脚本出错时死循环：一次调用最多执行这么多条
    for (let steps = 0; steps < 2000; steps++) {
      const op = this.script.ops[this.pc];
      if (!op) { this.finished = true; return; }
      const r = await this.exec(op);
      // stop 停在原地，下次调用还会立即停下
      if (r === "stop") return;
      if (r === "jumped") { if (op.pause) return; continue; }
      this.pc++;
      // 条件跳转没跳时不暂停，照常往下执行
      if (op.pause && op.op !== "jumpIfTrue" && op.op !== "jumpIfFalse") return;
    }
    console.warn("脚本单次执行超过 2000 条，强制暂停", this.script.entry);
  }

  private setCond(op: Op, v: boolean) {
    this.cond = op.and ? this.cond && v : v;
  }

  private jump(to: string): "jumped" {
    this.pc = this.indexOf(to);
    return "jumped";
  }

  private async exec(op: Op): Promise<"next" | "jumped" | "stop"> {
    const h = this.host;
    const n = (k: string) => op[k] as number;
    switch (op.op) {
      // ---------- 条件 ----------
      case "turnIs": this.setCond(op, h.turn() === n("turn")); break;
      case "flag": this.setCond(op, h.flag(n("flag"))); break;
      case "unitBit": this.setCond(op, h.unitBit(n("pilot"), n("bit")) === true); break;
      case "inRoster": this.setCond(op, h.inRoster(n("pilot"))); break;
      case "exists": this.setCond(op, h.exists(n("pilot"))); break;
      case "onMap": this.setCond(op, h.onMap(n("pilot"))); break;
      case "enemiesAtLeast": this.setCond(op, h.enemyCount() >= n("n")); break;
      case "alliesAtLeast": this.setCond(op, h.allyCount() >= n("n")); break;
      case "counter": this.setCond(op, false); break;
      case "hpAtLeast": this.setCond(op, h.hpAtLeast(n("pilot"), n("hp"))); break;
      case "allyInRect": this.setCond(op, h.sideInRect("player", n("x1"), n("y1"), n("x2"), n("y2"))); break;
      case "enemyInRect": this.setCond(op, h.sideInRect("enemy", n("x1"), n("y1"), n("x2"), n("y2"))); break;
      case "unitAt": this.setCond(op, h.unitAtIs(n("x"), n("y"), n("who"))); break;
      case "selfBit": this.setCond(op, h.selfBit(n("bit"))); break;
      case "selfAdjacent": this.setCond(op, h.selfAdjacent(n("who"))); break;
      case "selfAt": this.setCond(op, h.selfAt(n("x"), n("y"))); break;
      case "selfInRect": this.setCond(op, h.selfInRect(n("x1"), n("y1"), n("x2"), n("y2"))); break;
      case "foeWithin": this.setCond(op, h.foeWithin(n("d"))); break;
      case "selfHpAtLeast": this.setCond(op, h.selfHpAtLeast(n("hp"))); break;
      case "battle": this.setCond(op, h.lastBattle(n("attacker"), n("defender"), n("mask"), n("value"))); break;
      case "select": this.setCond(op, h.select(n("pilot"))); break;
      case "not": this.cond = !this.cond; break;

      // ---------- 跳转 ----------
      case "jump": return this.jump(op.to!);
      case "jumpIfTrue": if (this.cond) return this.jump(op.to!); break;
      case "jumpIfFalse": if (!this.cond) return this.jump(op.to!); break;
      case "stop": return "stop";

      // ---------- 对话、镜头 ----------
      case "talk": await h.talk(op.dialog as string, n("face"), {}); break;
      case "talkAt": await h.talk(op.dialog as string, n("pilot"), { pilot: n("pilot") }); break;
      case "talkCursor": await h.talk(op.dialog as string, n("pilot"), { pilot: n("pilot"), cursor: true }); break;
      case "narrate": await h.narrate(op.dialog as string); break;
      case "window": case "closeWindow": break;
      case "cursorTo": await h.cursorTo(n("x"), n("y")); break;
      case "cameraUnit": await h.focusUnit(n("pilot"), false); break;
      case "cursorUnit": await h.focusUnit(n("pilot"), true); break;
      case "selectCamera": await h.selectCamera(n("pilot")); break;
      case "wait": await h.wait(n("n") * 2); break;

      // ---------- 单位、名册 ----------
      case "spawnEnemy": await h.spawn("enemy", n("x"), n("y"), n("pilot"), n("mech"), n("level"), n("ai")); break;
      case "spawnNpc": await h.spawn("npc", n("x"), n("y"), n("pilot"), n("mech"), n("level"), n("script")); break;
      case "deployAlly": await h.deployAlly(n("x"), n("y"), n("roster")); break;
      case "changeMech": await h.changeMech(n("pilot"), n("mech")); break;
      case "changePilotMech": await h.changeMech(n("pilot"), n("mech"), n("newPilot")); break;
      case "rosterAdd": h.rosterAdd(n("roster"), n("pilot"), n("mech"), n("level")); break;
      case "rosterRemove": h.rosterRemove(n("roster")); break;
      case "setUnitBit": h.setUnitBit(n("pilot"), n("bit"), true); break;
      case "clearUnitBit": h.setUnitBit(n("pilot"), n("bit"), false); break;
      case "setSelfBit": h.setSelfBit(n("bit"), true); break;
      case "clearSelfBit": h.setSelfBit(n("bit"), false); break;
      case "setFlag": h.setFlag(n("flag"), true); break;
      case "clearFlag": h.setFlag(n("flag"), false); break;
      case "money": h.money(n("amount")); break;
      case "endAction": h.endAction(); break;
      case "removeSelf": await h.removeSelf(); break;
      case "toNpc": await h.switchSide("npc"); break;
      case "toEnemy": await h.switchSide("enemy"); break;
      case "toAlly": await h.switchSide("player", n("roster")); break;

      // ---------- 音乐 ----------
      case "playerBgm": h.bgm("player", n("track")); break;
      case "enemyBgm": h.bgm("enemy", n("track")); break;
      case "bgm": h.bgm("now", n("track")); break;

      // ---------- AI ----------
      case "actor": h.actor(); break;
      case "aiPickAttack": this.setCond(op, h.aiPickAttack(n("mode"))); break;
      case "aiAttackUnit": this.setCond(op, h.aiPickAttack(0, n("pilot"))); break;
      case "aiApproach": h.aiApproach(); break;
      case "aiApproachUnit": case "aiApproachUnit2": h.aiApproach(n("pilot")); break;
      case "aiMoveTo": case "aiMoveToFar": h.aiMoveTo(n("x"), n("y")); break;
      case "aiMapWeapon": this.setCond(op, false); break; // 地图兵器，原版只用在一处，暂不实现
      case "aiExec": await h.aiExec(); break;

      // ---------- 关卡结束 ----------
      case "stageClear": this.finished = true; await h.stageClear(); return "stop";
      case "gameOver": this.finished = true; await h.gameOver(); return "stop";
      case "ending": this.finished = true; await h.ending(); return "stop";

      default:
        console.warn(`未实现的脚本指令 ${op.op}`, op);
    }
    return "next";
  }
}
