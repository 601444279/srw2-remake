// 游戏流程（P2）：我方回合（移动、攻击、精神、待机）、敌方回合（原版 AI）、胜负判定。
// 战斗、命中、伤害、经验、AI 等规则都在 rules.ts 里调用原版规则代码。
import { applyLevel, type Stage, type Unit, type Weapon } from "./data.ts";
import { key, pathTo, rangeFrom, reachable, inBounds, MOVE_TYPE_ROW, type Point, type Reach } from "./grid.ts";
import type { Action } from "./input.ts";
import type { DrawState, Overlay, Renderer } from "./render.ts";
import type { UI, MenuItem } from "./ui.ts";
import { Rules, SPIRIT_FLAG } from "./rules.ts";
import type { Sfx } from "./sfx.ts";
import { keyLabel, settings, TEXT_SPEEDS, type BindAction } from "./settings.ts";
import { loadScene, personName, portraitUrl, STAGE_STORY, type SceneRef } from "./story.ts";

type Mode = "browse" | "selected" | "moving" | "menu" | "target" | "allyTarget" | "busy" | "dialog" | "title" | "over";

const MOVE_TILES_PER_SEC = 14;
const TYPE_LABELS = { air: "空", land: "陆", sea: "海" } as const;
// 建筑 / 基地格每回合开始回复 30% HP（docs/notes-rules.md 1.6）
const REPAIR_TERRAIN = 10;
// 打完一场战斗就清除的精神（加速、疾风保留到回合结束）
const ONE_SHOT_SPIRITS = 0xff & ~(SPIRIT_FLAG.ACCEL | SPIRIT_FLAG.GALE);

interface MoveAnim {
  unit: Unit;
  path: Point[];
  t: number;
  done: () => void;
}

interface TargetPick {
  candidates: Unit[];
  index: number;
  confirm: (u: Unit) => void;
  cancel: () => void;
  preview?: (u: Unit) => void;
}

export class Game implements DrawState {
  cursor: Point = { x: 0, y: 0 };
  selected: Unit | null = null;
  units: Unit[];
  private mode: Mode = "busy";
  private reach: Reach | null = null;
  private origin: Point | null = null;
  private moved = false;
  private anim: MoveAnim | null = null;
  private dangerOn = false;
  private dangerCache: Set<number> | null = null;
  private inspected: Unit | null = null;
  private pick: TargetPick | null = null;
  private turn = 1;
  private money = { value: 0 };
  private rules: Rules;
  onOpenSettings: () => void = () => {};
  // 对话播放中：等玩家按确定翻页
  private talk: { next: () => void; skip: () => void; autoAt: number } | null = null;
  private titleSkip: (() => void) | null = null;

  constructor(private stage: Stage, private renderer: Renderer, private ui: UI, private sfx: Sfx, private fast: () => boolean) {
    this.units = stage.units;
    this.rules = new Rules(stage);
  }

  async start() {
    const first = this.players()[0];
    this.cursor = { x: first.x, y: first.y };
    this.renderer.centerOn(this.cursor);
    this.ui.setObjective("胜利条件：击破所有敌人　失败条件：我方全灭");
    this.ui.setTurn(this.turn, "player");
    this.refreshInfo();
    const story = STAGE_STORY[this.stage.number];
    if (story) {
      for (const scene of story.prologue) await this.playScene(scene);
      this.setMode("title");
      const card = this.ui.titleCard(story.title, story.subtitle, 2.4);
      this.titleSkip = card.skip;
      await card.done;
      this.titleSkip = null;
      for (const scene of story.opening) await this.playScene(scene);
    }
    await this.ui.banner(`第 ${this.turn} 回合`, "我方回合", "player");
    this.setMode("browse");
  }

  // ---------- 剧情 ----------
  private async playScene(ref: SceneRef) {
    const lines = loadScene(ref);
    if (ref.focusUnit && ref.who !== undefined) {
      const u = this.units.find((x) => x.pilotId === ref.who && x.hp > 0);
      if (u) this.setCursor(u.x, u.y);
    }
    const prev = this.mode;
    this.setMode("dialog");
    let skipped = false;
    for (const line of lines) {
      if (skipped) break;
      const cps = TEXT_SPEEDS.find((t) => t.id === settings.get().textSpeed)!.cps;
      const name = line.speaker || personName(line.face);
      this.ui.showLine(name, line.text, portraitUrl(line.face), name.slice(0, 1), cps);
      await new Promise<void>((resolve) => {
        this.talk = { next: resolve, skip: () => { skipped = true; resolve(); }, autoAt: 0 };
      });
    }
    this.talk = null;
    this.ui.hideDialog();
    this.setMode(prev === "dialog" ? "busy" : prev);
  }

  // 确定：字没出完就先出完，出完了翻到下一句
  private advanceTalk() {
    if (!this.talk) return;
    if (!this.ui.lineDone) this.ui.finishLine();
    else this.talk.next();
  }

  // ---------- 绘制需要的状态 ----------
  get overlay(): Overlay {
    const o: Overlay = {};
    if (this.dangerOn) o.danger = this.dangerCache ??= this.dangerZone();
    if (this.inspected && this.inspected.hp > 0) {
      const r = this.unitReach(this.inspected);
      o.move = r.stops;
      o.attack = minus(this.threat(this.inspected, r), r.stops);
    }
    if (this.selected && this.reach && (this.mode === "selected" || this.mode === "moving")) {
      o.move = this.reach.stops;
      o.attack = minus(this.threat(this.selected, this.reach), this.reach.cost);
      if (this.mode === "selected" && this.reach.stops.has(key(this.stage.map, this.cursor.x, this.cursor.y))) {
        o.path = pathTo(this.stage.map, this.reach, this.cursor);
      }
    }
    if (this.pick) o.targets = this.pick.candidates;
    return o;
  }

  unitPos(unit: Unit): Point {
    if (!this.anim || this.anim.unit !== unit) return unit;
    const { path, t } = this.anim;
    const i = Math.min(Math.floor(t), path.length - 2);
    const f = Math.min(1, t - i);
    const a = path[i], b = path[i + 1] ?? a;
    return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
  }

  update(dt: number) {
    // 按住快速键：对话自动快进
    if (this.talk && this.fast()) {
      this.talk.autoAt += dt;
      if (this.talk.autoAt > 0.12) { this.talk.autoAt = 0; this.ui.finishLine(); this.talk.next(); }
    }
    if (!this.anim) return;
    this.anim.t += dt * MOVE_TILES_PER_SEC * this.speed();
    // 镜头跟着移动中的单位
    const p = this.unitPos(this.anim.unit);
    this.cursor = { x: Math.round(p.x), y: Math.round(p.y) };
    if (this.anim.t >= this.anim.path.length - 1) {
      const { unit, path, done } = this.anim;
      const end = path.at(-1)!;
      unit.x = end.x;
      unit.y = end.y;
      this.cursor = { ...end };
      this.anim = null;
      this.dangerCache = null;
      done();
    }
  }

  // 按住 Shift / 手柄 X 时演出加速
  private speed() {
    return this.fast() ? 3 : 1;
  }

  // ---------- 输入 ----------
  move(dx: number, dy: number) {
    if (this.mode === "menu") { this.ui.menuMove(dy || dx); return; }
    if (this.mode === "target" || this.mode === "allyTarget") { this.cyclePick(dx + dy > 0 ? 1 : -1); return; }
    if (this.mode !== "browse" && this.mode !== "selected") return;
    this.setCursor(this.cursor.x + dx, this.cursor.y + dy);
  }

  pointerTile(p: Point) {
    if (this.pick) {
      const i = this.pick.candidates.findIndex((u) => u.x === p.x && u.y === p.y);
      if (i >= 0 && i !== this.pick.index) { this.pick.index = i; this.focusPick(); }
      return;
    }
    if (this.mode !== "browse" && this.mode !== "selected") return;
    if (p.x !== this.cursor.x || p.y !== this.cursor.y) this.setCursor(p.x, p.y);
  }

  pointerClick(p: Point, button: number) {
    if (this.mode === "dialog" || this.mode === "title") { this.action(button === 2 ? "cancel" : "confirm"); return; }
    if (button === 2) { this.action("cancel"); return; }
    if (this.mode === "menu" || this.mode === "busy" || this.mode === "over") return;
    if (this.pick) {
      const i = this.pick.candidates.findIndex((c) => c.x === p.x && c.y === p.y);
      if (i >= 0) { this.pick.index = i; this.action("confirm"); }
      return;
    }
    if (!inBounds(this.stage.map, p.x, p.y)) return;
    this.setCursor(p.x, p.y);
    this.action("confirm");
  }

  action(a: Action) {
    if (a === "zoomIn" || a === "zoomOut") { this.renderer.setZoom(a === "zoomIn" ? 1 : -1); return; }
    if (a === "settings") { if (this.mode === "browse" || this.mode === "selected" || this.mode === "dialog") this.onOpenSettings(); return; }
    switch (this.mode) {
      case "dialog":
        if (a === "confirm") this.advanceTalk();
        if (a === "cancel") this.talk?.skip();
        return;
      case "title":
        if (a === "confirm" || a === "cancel") this.titleSkip?.();
        return;
      case "menu":
        if (a === "confirm") this.ui.menuConfirm();
        if (a === "cancel") this.ui.closeMenu();
        return;
      case "target":
      case "allyTarget": {
        const pick = this.pick!;
        if (a === "confirm") { this.pick = null; pick.confirm(pick.candidates[pick.index]); }
        if (a === "cancel") { this.pick = null; pick.cancel(); }
        if (a === "next" || a === "prev") this.cyclePick(a === "next" ? 1 : -1);
        return;
      }
      case "browse":
        return this.browseAction(a);
      case "selected":
        return this.selectedAction(a);
    }
  }

  private browseAction(a: Action) {
    const here = this.unitAt(this.cursor);
    switch (a) {
      case "confirm":
        if (here?.side === "player" && !here.acted) return this.select(here);
        if (here?.side === "enemy") { this.inspected = this.inspected === here ? null : here; return; }
        if (this.inspected) { this.inspected = null; return; }
        return this.openMapMenu();
      case "cancel":
        this.inspected = null;
        return;
      case "next":
      case "prev":
        return this.cycleUnit(a === "next" ? 1 : -1);
      case "danger":
        return this.toggleDanger();
      case "menu":
        return this.openMapMenu();
    }
  }

  private selectedAction(a: Action) {
    const unit = this.selected!;
    switch (a) {
      case "confirm": {
        const target = this.unitAt(this.cursor);
        // 现代捷径：直接点敌人，自动走到能打到它的格子再选武器
        if (target?.side === "enemy") return this.quickAttack(unit, target);
        if (this.cursor.x === unit.x && this.cursor.y === unit.y) return this.openActionMenu(unit);
        const k = key(this.stage.map, this.cursor.x, this.cursor.y);
        if (!this.reach!.stops.has(k)) { this.ui.toast("无法移动到这里"); return; }
        return this.moveSelected(this.cursor, () => this.openActionMenu(unit));
      }
      case "cancel":
        this.setCursor(unit.x, unit.y);
        this.deselect();
        return;
      case "danger":
        return this.toggleDanger();
    }
  }

  // ---------- 我方行动 ----------
  private select(unit: Unit) {
    this.inspected = null;
    this.selected = unit;
    this.origin = null;
    this.moved = false;
    this.reach = this.unitReach(unit);
    this.setMode("selected");
  }

  private deselect() {
    this.selected = null;
    this.reach = null;
    this.origin = null;
    this.moved = false;
    this.setMode("browse");
    this.refreshInfo();
  }

  private moveSelected(to: Point, done: () => void) {
    const unit = this.selected!;
    if (to.x === unit.x && to.y === unit.y) { done(); return; }
    this.origin = { x: unit.x, y: unit.y };
    this.moved = true;
    this.setMode("moving");
    this.anim = { unit, path: pathTo(this.stage.map, this.reach!, to), t: 0, done };
  }

  // 点敌人：原地能打就原地打；否则在移动范围里找能用「移动后可用」武器打到它的最近格
  private quickAttack(unit: Unit, enemy: Unit) {
    if (unit.weapons.some((w) => this.rules.targetsFor(unit, w, unit, false, [enemy]).length)) {
      this.chooseWeapon(unit, enemy);
      return;
    }
    const map = this.stage.map;
    let best: { p: Point; cost: number } | null = null;
    for (const k of this.reach!.stops) {
      const p = { x: k % map.width, y: Math.floor(k / map.width) };
      const cost = this.reach!.cost.get(k)!;
      if (best && cost >= best.cost) continue;
      if (unit.weapons.some((w) => this.rules.targetsFor(unit, w, p, true, [enemy]).length)) best = { p, cost };
    }
    if (!best) { this.ui.toast("这回合打不到这个敌人"); return; }
    this.moveSelected(best.p, () => this.chooseWeapon(unit, enemy));
  }

  private openActionMenu(unit: Unit) {
    this.setCursor(unit.x, unit.y, false);
    const canAttack = unit.weapons.some((w) => this.rules.targetsFor(unit, w, unit, this.moved, this.units).length);
    const canSpirit = this.rules.spiritMenu(unit, this.units).some((s) => s.usable);
    const items: MenuItem[] = [
      { label: "攻击", disabled: !canAttack, detail: canAttack ? "" : "无目标", run: () => this.chooseWeapon(unit) },
      { label: "精神", disabled: !canSpirit, detail: unit.maxSp ? `SP ${unit.sp}` : "", run: () => this.openSpiritMenu(unit) },
      { label: "待机", run: () => this.finishAction(unit) },
    ];
    this.openMenu(items, unit, () => this.undoMove(unit));
  }

  // 菜单里取消：回到移动前的位置，重新选择
  private undoMove(unit: Unit) {
    if (this.origin) { unit.x = this.origin.x; unit.y = this.origin.y; this.dangerCache = null; }
    this.select(unit);
    this.setCursor(unit.x, unit.y);
  }

  private chooseWeapon(unit: Unit, preset?: Unit) {
    const items: MenuItem[] = unit.weapons.map((w) => {
      const targets = this.rules.targetsFor(unit, w, unit, this.moved, preset ? [preset] : this.units);
      const fire = (["air", "land", "sea"] as const).map((t) => (w.power[t] === null ? "—" : w.power[t]! + unit.strength)).join("/");
      const hint = `射程 ${w.range}　命中 ${w.hit}　火力 ${fire}`;
      const detail = targets.length ? `${targets.length} 个目标` : w.range > 1 && !w.usableAfterMove && this.moved ? "移动后不能用" : "打不到";
      return { label: w.name, detail, hint, disabled: !targets.length, run: () => this.chooseTarget(unit, w, targets, () => this.chooseWeapon(unit, preset)) };
    });
    this.openMenu(items, unit, () => this.openActionMenu(unit));
  }

  private chooseTarget(unit: Unit, weapon: Weapon, targets: Unit[], back: () => void) {
    this.startPick("target", targets, {
      preview: (t) => this.ui.showForecast(unit, this.renderer.iconUrl(unit), t, this.renderer.iconUrl(t), weapon, this.rules.forecast(unit, weapon, t, unit, this.moved)),
      confirm: async (t) => {
        this.ui.hideForecast();
        await this.battle(unit, weapon, t, this.moved);
        if (this.mode !== "over") this.finishAction(unit);
      },
      cancel: () => { this.ui.hideForecast(); back(); },
    });
  }

  private openSpiritMenu(unit: Unit) {
    const items: MenuItem[] = this.rules.spiritMenu(unit, this.units).map(({ spirit, def, usable }) => ({
      label: spirit.name,
      detail: `${spirit.cost}`,
      hint: spirit.text,
      disabled: !usable,
      run: () => {
        if (def.effect.kind === "heal" && def.effect.target === "ally") {
          const allies = this.players().filter((u) => u.hp < u.maxHp);
          this.startPick("allyTarget", allies, {
            confirm: (t) => this.castSpirit(unit, spirit.id, t),
            cancel: () => this.openSpiritMenu(unit),
          });
          return;
        }
        this.castSpirit(unit, spirit.id);
      },
    }));
    this.openMenu(items, unit, () => this.openActionMenu(unit));
  }

  private castSpirit(unit: Unit, spiritId: number, target?: Unit) {
    const r = this.rules.useSpirit(unit, spiritId, this.units, target);
    this.ui.toast(r.text);
    for (const a of r.affected) {
      this.renderer.float(a.unit, a.kind === "heal" ? `+${a.amount}` : `-${a.amount}`, a.kind === "heal" ? "#6dff8a" : "#ff6b6b");
      if (a.kind === "damage") {
        const power = a.unit.hp === 0 ? 1 : Math.min(1, (a.amount / a.unit.maxHp) * 2);
        this.sfx.hit(power);
        this.renderer.impact(a.unit, power);
        if (a.unit.hp === 0) this.renderer.killUnit(a.unit);
      }
    }
    this.dangerCache = null;
    this.refreshInfo();
    if (this.checkEnd()) return;
    // 没移动过就回到选移动的状态（加速、疾风会扩大移动范围）；移动过回到行动菜单
    if (this.moved) this.openActionMenu(unit);
    else this.select(unit);
  }

  private finishAction(unit: Unit) {
    unit.acted = true;
    this.deselect();
    if (this.checkEnd()) return;
    const next = this.players().find((u) => !u.acted);
    if (next) { this.setCursor(next.x, next.y); return; }
    this.endTurn();
  }

  // ---------- 战斗 ----------
  private async battle(attacker: Unit, weapon: Weapon, defender: Unit, moved: boolean) {
    this.setMode("busy");
    this.setCursor(defender.x, defender.y);
    // 规则层一次算完整场战斗（会直接改 HP），演出时先恢复到战前，再一击一击扣
    const before = new Map([[attacker, attacker.hp], [defender, defender.hp]]);
    const events = this.rules.fight(attacker, weapon, defender, moved);
    const after = new Map([[attacker, attacker.hp], [defender, defender.hp]]);
    for (const [u, hp] of before) u.hp = hp;

    this.ui.battleStart(attacker, this.renderer.iconUrl(attacker), defender, this.renderer.iconUrl(defender));
    await wait(0.25 / this.speed());
    for (const e of events) {
      if (e.hit) {
        // 伤害占最大 HP 的比例决定打击力度：一半血以上或击破就是满力度
        const power = e.hpAfter === 0 ? 1 : Math.min(1, (e.damage / e.to.maxHp) * 2);
        this.sfx.hit(power);
        // 先顿帧，再扣血、飘数字、震屏
        await wait(this.renderer.impact(e.to, power, this.speed()));
        e.to.hp = e.hpAfter;
        this.renderer.float(e.to, `-${e.damage}`, "#ff6b6b");
      } else {
        this.sfx.miss();
        this.renderer.float(e.to, "MISS", "#c8c8d0");
      }
      await this.ui.battleStrike(e, 0.75 / this.speed());
    }
    for (const [u, hp] of after) u.hp = hp;
    await wait(0.2 / this.speed());
    this.ui.battleEnd();

    // 击破、经验、升级
    for (const [victim, killer] of [[defender, attacker], [attacker, defender]] as const) {
      if (victim.hp > 0) continue;
      this.renderer.killUnit(victim);
      this.renderer.float(victim, "击破", "#ffd257");
      const r = this.rules.reward(killer, victim, this.money);
      if (r.exp) {
        await wait(0.35 / this.speed());
        this.renderer.float(killer, `EXP +${r.exp}`, "#8fd3ff");
        if (r.levels > 0 && r.newLevel !== undefined) {
          applyLevel(killer, r.newLevel);
          this.ui.toast(`${killer.name} 升到 Lv ${killer.level}！`);
          await wait(0.3 / this.speed());
          this.renderer.float(killer, "LEVEL UP", "#ffd257");
        }
      }
      await wait(0.5 / this.speed());
    }
    // 一次性精神打完一场就清除
    for (const u of [attacker, defender]) if (u.side === "player") u.spirit &= ~ONE_SHOT_SPIRITS;
    this.dangerCache = null;
    this.refreshInfo();
  }

  // ---------- 回合 ----------
  private async endTurn() {
    this.deselect();
    this.inspected = null;
    this.setMode("busy");
    for (const u of this.players()) u.spirit &= ~(SPIRIT_FLAG.ACCEL | SPIRIT_FLAG.GALE);
    this.ui.setTurn(this.turn, "enemy");
    await this.ui.banner("敌方回合", "", "enemy");
    await this.enemyPhase();
    if (this.mode === "over") return;

    this.turn++;
    this.rules.jamming = false;
    for (const u of this.players()) u.acted = false;
    this.repairOnBases("player");
    this.turnStartTraits("player");
    this.ui.setTurn(this.turn, "player");
    const first = this.players()[0];
    this.setCursor(first.x, first.y);
    await this.ui.banner(`第 ${this.turn} 回合`, "我方回合", "player");
    this.setMode("browse");
  }

  private async enemyPhase() {
    this.repairOnBases("enemy");
    this.turnStartTraits("enemy");
    for (const enemy of this.rules.enemyOrder(this.units)) {
      if (enemy.hp <= 0) continue;
      const plan = this.rules.enemyPlan(enemy, this.units, this.turn);
      // 不动也不打的敌人不移镜头
      if (plan.kind === "wait") continue;
      this.setCursor(enemy.x, enemy.y);
      await wait(0.25 / this.speed());
      const moved = plan.to.x !== enemy.x || plan.to.y !== enemy.y;
      if (moved) await this.moveEnemy(enemy, plan.to);
      if (plan.kind === "attack" && plan.target.hp > 0) {
        await this.battle(enemy, plan.weapon, plan.target, moved);
        if (this.checkEnd()) return;
      }
      await wait(0.1 / this.speed());
    }
  }

  private moveEnemy(enemy: Unit, to: Point) {
    const path = pathTo(this.stage.map, this.unitReach(enemy), to);
    return new Promise<void>((resolve) => {
      if (path.length < 2) { enemy.x = to.x; enemy.y = to.y; this.dangerCache = null; resolve(); return; }
      this.anim = { unit: enemy, path, t: 0, done: resolve };
    });
  }

  private repairOnBases(side: Unit["side"]) {
    for (const u of this.units) {
      if (u.side !== side || u.hp <= 0 || u.hp >= u.maxHp) continue;
      if (this.stage.map.terrain[u.y][u.x] !== REPAIR_TERRAIN) continue;
      const before = u.hp;
      u.hp = Math.min(u.maxHp, u.hp + Math.floor(u.maxHp * 0.3));
      this.renderer.float(u, `+${u.hp - before}`, "#6dff8a");
    }
  }

  // 特性「支援」每回合回复 SP，「底力」每回合回复 HP
  private turnStartTraits(side: Unit["side"]) {
    for (const u of this.units) {
      const t = u.trait;
      if (u.side !== side || u.hp <= 0 || !t) continue;
      if (t.spPerTurn && u.maxSp) u.sp = Math.min(u.maxSp, u.sp + t.spPerTurn);
      if (t.hpPerTurn && u.hp < u.maxHp) {
        const before = u.hp;
        u.hp = Math.min(u.maxHp, u.hp + Math.max(1, Math.floor(u.maxHp * t.hpPerTurn)));
        this.renderer.float(u, `+${u.hp - before}`, "#6dff8a");
      }
    }
  }

  private checkEnd() {
    if (!this.enemies().length) { this.gameOver(true); return true; }
    if (!this.players().length) { this.gameOver(false); return true; }
    return false;
  }

  private async gameOver(win: boolean) {
    this.setMode("over");
    this.ui.closeMenu(false);
    this.ui.hideForecast();
    const lines = [`回合数　${this.turn}`, `获得资金　${this.money.value * 10}G`];
    await wait(0.8);
    const story = STAGE_STORY[this.stage.number];
    if (win && story) {
      for (const scene of story.clear) await this.playScene(scene);
      this.setMode("over");
    }
    this.ui.showResult(win, lines, () => location.reload());
  }

  // ---------- 目标选择 ----------
  private startPick(mode: "target" | "allyTarget", candidates: Unit[], opts: Omit<TargetPick, "candidates" | "index">) {
    this.pick = { candidates, index: 0, ...opts };
    this.setMode(mode);
    this.focusPick();
  }

  private cyclePick(dir: number) {
    if (!this.pick) return;
    const n = this.pick.candidates.length;
    this.pick.index = (this.pick.index + dir + n) % n;
    this.focusPick();
  }

  private focusPick() {
    const t = this.pick!.candidates[this.pick!.index];
    this.setCursor(t.x, t.y);
    this.pick!.preview?.(t);
  }

  // ---------- 辅助 ----------
  private openMenu(items: MenuItem[], at: Point, onCancel: () => void) {
    this.setMode("menu");
    const s = 16 * this.renderer.zoom;
    const pos = this.renderer.tileToScreen(at);
    this.ui.openMenu(items, pos.x + s * 1.2, pos.y, onCancel);
  }

  private openMapMenu() {
    const back = () => this.setMode("browse");
    this.openMenu([
      { label: "结束回合", run: () => this.endTurn() },
      { label: this.dangerOn ? "隐藏敌方范围" : "显示敌方范围", run: () => { this.toggleDanger(); back(); } },
      { label: "设置", detail: "按键 · 鼠标", run: () => { back(); this.onOpenSettings(); } },
      { label: "返回", run: back },
    ], this.cursor, back);
  }

  private toggleDanger() {
    this.dangerOn = !this.dangerOn;
    this.ui.toast(this.dangerOn ? "显示敌方威胁范围" : "隐藏敌方威胁范围");
  }

  private cycleUnit(dir: number) {
    const list = this.players().filter((u) => !u.acted);
    if (!list.length) return;
    const current = list.findIndex((u) => u.x === this.cursor.x && u.y === this.cursor.y);
    const next = list[(current + dir + list.length) % list.length];
    this.setCursor(next.x, next.y);
  }

  private setMode(mode: Mode) {
    this.mode = mode;
    document.body.classList.toggle("story", mode === "dialog" || mode === "title");
    this.refreshHints();
  }

  private setCursor(x: number, y: number, refresh = true) {
    const map = this.stage.map;
    this.cursor = { x: Math.min(map.width - 1, Math.max(0, x)), y: Math.min(map.height - 1, Math.max(0, y)) };
    if (refresh) this.refreshInfo();
  }

  private refreshInfo() {
    const unit = this.unitAt(this.cursor) ?? (this.mode === "selected" ? this.selected : null);
    const t = this.stage.map.terrain[this.cursor.y][this.cursor.x];
    const effect = this.stage.terrainEffect[t];
    this.ui.showInfo(unit ?? null, unit ? this.renderer.iconUrl(unit) : "", {
      name: this.stage.terrainNames[t],
      evade: 100 - (effect & 0x7f),
      sea: !!(effect & 0x80),
      costs: (Object.keys(TYPE_LABELS) as (keyof typeof TYPE_LABELS)[]).map((m) => ({ label: TYPE_LABELS[m], cost: this.stage.map.moveCost[MOVE_TYPE_ROW[m]][t] })),
    });
  }

  // 设置改了按键之后刷新提示
  settingsChanged() {
    this.refreshHints();
  }

  // 底部按键提示，显示玩家当前绑定的键
  private refreshHints() {
    const k = (a: BindAction) => keyLabel(a);
    const move = `${k("up")}${k("down")}${k("left")}${k("right")}`;
    const hints: Record<Mode, [string, string][]> = {
      browse: [[k("confirm"), "选择"], [`${k("next")} / ${k("prev")}`, "切换单位"], [k("danger"), "敌方范围"], [k("menu"), "菜单"], [`${k("zoomIn")} / ${k("zoomOut")}`, "缩放"], [k("fast"), "快速移动"], [k("settings"), "设置"]],
      selected: [[k("confirm"), "移动 / 点敌人直接攻击"], [k("cancel"), "取消"], [k("danger"), "敌方范围"]],
      moving: [[`按住 ${k("fast")}`, "加速"]],
      menu: [[move, "选择"], [k("confirm"), "确定"], [k("cancel"), "返回"]],
      target: [[move, "切换目标"], [k("confirm"), "攻击"], [k("cancel"), "返回"]],
      allyTarget: [[move, "切换"], [k("confirm"), "确定"], [k("cancel"), "返回"]],
      busy: [[`按住 ${k("fast")}`, "加速"]],
      dialog: [[k("confirm"), "下一句"], [`按住 ${k("fast")}`, "快进"], [k("cancel"), "跳过这段"], [k("settings"), "设置"]],
      title: [[k("confirm"), "继续"]],
      over: [],
    };
    this.ui.setHints(hints[this.mode]);
  }

  private unitAt(p: Point) {
    return this.units.find((u) => u.x === p.x && u.y === p.y && u.hp > 0);
  }

  private players() {
    return this.units.filter((u) => u.side === "player" && u.hp > 0);
  }

  private enemies() {
    return this.units.filter((u) => u.side === "enemy" && u.hp > 0);
  }

  private unitReach(unit: Unit) {
    const others = this.units.filter((u) => u !== unit && u.hp > 0);
    return reachable(this.stage.map, unit, this.rules.mobility(unit), unit.moveType, unit.side, others);
  }

  // 威胁范围：移动后能用的武器从所有可停留的格子算射程；其他远程武器只能原地用，且打不到相邻格
  private threat(unit: Unit, reach: Reach) {
    const map = this.stage.map;
    const out = new Set<number>();
    for (const w of unit.weapons) {
      // 射程 2 以上的武器打不到相邻格（包括移动后可用的 E 类）
      const min = w.range > 1 ? 2 : 1;
      const from = w.usableAfterMove ? reach.stops : [key(map, unit.x, unit.y)];
      for (const k of rangeFrom(map, from, min, w.range)) out.add(k);
    }
    return out;
  }

  private dangerZone() {
    const out = new Set<number>();
    for (const u of this.enemies()) for (const k of this.threat(u, this.unitReach(u))) out.add(k);
    return out;
  }
}

function minus(a: Set<number>, b: { has(k: number): boolean }) {
  return new Set([...a].filter((k) => !b.has(k)));
}

const wait = (s: number) => new Promise((r) => setTimeout(r, s * 1000));
