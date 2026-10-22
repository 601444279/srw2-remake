// 游戏流程：我方回合（移动、攻击、精神、待机）、敌方回合、剧情。
// 战斗、命中、伤害、经验等规则在 rules.ts 里调用原版规则代码；
// 关卡事件（对话、援军、胜负、过关）和敌人 AI 由原版脚本驱动，见 events.ts。
import { applyLevel, type Stage, type Unit, type Weapon } from "./data.ts";
import { StageEvents } from "./events.ts";
import { key, pathTo, rangeFrom, reachable, inBounds, MOVE_TYPE_ROW, type Point, type Reach } from "./grid.ts";
import type { Action } from "./input.ts";
import type { DrawState, Overlay, Renderer } from "./render.ts";
import type { UI, MenuItem } from "./ui.ts";
import { Rules, SPIRIT_FLAG, rngState, setRngState } from "./rules.ts";
import { describeTime, listSaves, readSave, requestLoad, writeSave, SAVE_VERSION, type SaveData, type SlotId } from "./saves.ts";
import { strikeSound, type Sfx } from "./sfx.ts";
import { MUSIC, type Music } from "./music.ts";
import { keyLabel, settings, TEXT_SPEEDS, type BindAction } from "./settings.ts";
import { loadScene, personName, portraitUrl, STAGE_STORY, type SceneRef } from "./story.ts";

type Mode = "browse" | "selected" | "moving" | "menu" | "target" | "allyTarget" | "busy" | "dialog" | "title" | "over";

const MOVE_TILES_PER_SEC = 14;
// 剧情对话时的音乐：原版开新游戏后，开场剧情和进地图后的开场对话都放 9 号，第 1 回合开始才换成我方回合曲
const STORY_BGM = 0x09;
const LEVEL_UP_JINGLE = 0x0e;
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
  private events: StageEvents;
  // 我方 / 敌方回合曲（脚本的 playerBgm / enemyBgm 会改），phase 是现在是谁的回合
  private songs = { player: 7, enemy: 8 };
  private phase: "player" | "enemy" = "player";

  constructor(private stage: Stage, private renderer: Renderer, private ui: UI, private sfx: Sfx, private music: Music, private fast: () => boolean) {
    this.units = stage.units;
    this.rules = new Rules(stage);
    const bgm = MUSIC.stage(stage.number);
    this.songs = { player: bgm.player, enemy: bgm.enemy };
    this.events = new StageEvents({
      stage,
      rules: this.rules,
      turn: () => this.turn,
      money: this.money,
      playScene: (ref) => this.playScene(ref),
      focus: (p) => this.focus(p),
      moveUnit: (u, to) => this.moveUnit(u, to),
      battle: (a, w, d, moved) => this.battle(a, w, d, moved),
      addUnit: (u) => this.addUnit(u),
      removeUnit: (u) => this.removeUnit(u),
      wait: (s) => wait(s / this.speed()),
      music: (kind, song) => this.scriptMusic(kind, song),
      finish: (r) => this.finishStage(r),
    });
  }

  // ---------- 事件脚本需要的能力 ----------
  // 镜头移到某格，停一下让玩家看清
  private async focus(p: Point) {
    this.setCursor(p.x, p.y);
    await wait(0.2 / this.speed());
  }

  private async addUnit(u: Unit) {
    await this.renderer.loadUnit(u);
    this.units.push(u);
    this.dangerCache = null;
    this.setCursor(u.x, u.y);
    this.renderer.float(u, u.side === "enemy" ? "出现" : "加入", u.side === "enemy" ? "#ff8a8a" : "#8fd3ff");
    await wait(0.35 / this.speed());
  }

  // 撤退 / 离场：淡出，不算击破，不给经验
  private async removeUnit(u: Unit) {
    this.renderer.float(u, "撤退", "#c8c8d0");
    this.renderer.killUnit(u);
    u.hp = 0;
    this.dangerCache = null;
    await wait(0.5 / this.speed());
  }

  // 原版换曲代码交给音乐模块
  private scriptMusic(kind: "player" | "enemy" | "now", song: number | "stop" | "restore") {
    if (song === "stop") { this.music.stop(); return; }
    // playerBgm / enemyBgm 只记下回合曲（原版 $7529 / $752A），到那一方的回合开始时才换
    if (kind !== "now") {
      if (song === "restore") this.music.play(this.songs[kind]);
      else this.songs[kind] = song;
      return;
    }
    this.music.play(song === "restore" ? this.songs[this.phase] : song);
  }

  async start() {
    const first = this.players()[0];
    this.cursor = { x: first.x, y: first.y };
    this.renderer.centerOn(this.cursor);
    this.ui.setObjective(`胜利条件：${this.stage.events.victoryText.replace(/。$/, "")}`);
    this.ui.setTurn(this.turn, "player");
    this.refreshInfo();
    const bgm = MUSIC.stage(this.stage.number);
    this.music.preload([bgm.player, bgm.enemy, STORY_BGM]);
    // 进关：开场脚本跑到第一个暂停点（出击前的剧情），然后是关卡标题，之后进入第 1 回合
    this.music.play(STORY_BGM);
    this.setMode("busy");
    await this.events.runStart();
    const story = STAGE_STORY[this.stage.number];
    this.setMode("title");
    const card = this.ui.titleCard(story?.title ?? `第${this.stage.number}篇`, story?.subtitle ?? "", 2.4);
    this.titleSkip = card.skip;
    await card.done;
    this.titleSkip = null;
    await this.playerPhaseStart();
  }

  // 我方回合开始：开场脚本和检查脚本各继续一次（地图上的开场对话、回合触发的事件），然后横幅
  private async playerPhaseStart() {
    this.setMode("busy");
    this.phase = "player";
    await this.events.runStart();
    await this.events.runCheck();
    if (this.mode === "over") return;
    this.music.play(this.songs.player);
    await this.ui.banner(`第 ${this.turn} 回合`, "我方回合", "player");
    this.setMode("browse");
    this.saveTo("auto").catch((e) => console.warn("自动存档失败", e));
  }

  // ---------- 存档 ----------
  snapshot(): SaveData {
    return {
      version: SAVE_VERSION,
      stage: this.stage.number,
      turn: this.turn,
      money: this.money.value,
      units: structuredClone(this.units),
      roster: structuredClone(this.stage.roster),
      events: this.events.snapshot(),
      rng: rngState(),
      songs: { ...this.songs },
      jamming: this.rules.jamming,
    };
  }

  private async saveTo(slot: SlotId) {
    const story = STAGE_STORY[this.stage.number];
    await writeSave(slot, this.snapshot(), {
      stage: this.stage.number,
      turn: this.turn,
      title: `第${this.stage.number}关${story ? ` ${story.subtitle}` : ""}`,
      thumb: this.renderer.thumbnail(),
    });
    if (slot !== "auto") this.ui.toast(`已存到存档 ${slot}`);
  }

  // 读档：单位和名册在建 Game 之前已经换成存档里的（main.ts），这里恢复其余状态，直接进入我方回合
  async resumeFromSave(save: SaveData) {
    this.turn = save.turn;
    this.money.value = save.money;
    this.songs = { ...save.songs };
    this.rules.jamming = save.jamming;
    setRngState(save.rng);
    this.events.restore(save.events);
    this.phase = "player";
    const first = this.players().find((u) => !u.acted) ?? this.players()[0];
    this.cursor = { x: first.x, y: first.y };
    this.renderer.centerOn(this.cursor);
    this.ui.setObjective(`胜利条件：${this.stage.events.victoryText.replace(/。$/, "")}`);
    this.ui.setTurn(this.turn, "player");
    this.music.play(this.songs.player);
    this.setMode("browse");
    this.refreshInfo();
    this.ui.toast(`已读取存档 · 第 ${this.turn} 回合`);
  }

  private async openSaveMenu() {
    const metas = await listSaves();
    const items: MenuItem[] = ([1, 2, 3] as SlotId[]).map((slot) => {
      const m = metas.find((x) => x.slot === slot);
      return {
        label: `存档 ${slot}`,
        detail: m ? describeTime(m.savedAt) : "空",
        hint: m ? `${m.title} · 第 ${m.turn} 回合（覆盖）` : undefined,
        run: async () => {
          try { await this.saveTo(slot); } catch (e) { console.warn(e); this.ui.toast("存档失败"); }
          this.setMode("browse");
        },
      };
    });
    this.openMenu(items, this.cursor, () => this.openMapMenu());
  }

  // 读档列表（地图菜单和开始菜单共用）。onCancel 为空时不能取消
  async openLoadMenu(onCancel: () => void) {
    const metas = await listSaves();
    const items: MenuItem[] = metas.map((m) => ({
      label: m.slot === "auto" ? "自动存档" : `存档 ${m.slot}`,
      detail: describeTime(m.savedAt),
      hint: `${m.title} · 第 ${m.turn} 回合`,
      run: () => requestLoad(m.slot),
    }));
    if (!items.length) { this.ui.toast("还没有存档"); onCancel(); return; }
    this.openMenu(items, this.cursor, onCancel);
  }

  // 打开游戏时有存档：开始菜单（继续 / 读档 / 新游戏）
  async showStartMenu(): Promise<void> {
    const metas = await listSaves();
    if (!metas.length) return this.start();
    const latest = metas.reduce((a, b) => (b.savedAt > a.savedAt ? b : a));
    return new Promise<void>((resolve) => {
      const show = () => {
        this.setMode("menu");
        this.ui.openMenu([
          { label: "继续", detail: describeTime(latest.savedAt), hint: `${latest.title} · 第 ${latest.turn} 回合`, run: () => requestLoad(latest.slot) },
          { label: "读档", run: () => void this.openLoadMenu(show) },
          { label: "新游戏", run: () => { resolve(); void this.start(); } },
        ], innerWidth / 2 - 90, innerHeight / 2 - 60, show);
      };
      show();
    });
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
    if (this.mode === "menu") { this.ui.menuMove(dy || dx); this.sfx.ui("move"); return; }
    if (this.mode === "target" || this.mode === "allyTarget") { this.cyclePick(dx + dy > 0 ? 1 : -1); this.sfx.ui("move"); return; }
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
        if (a === "confirm") { this.sfx.ui("ok"); this.ui.menuConfirm(); }
        if (a === "cancel") this.ui.closeMenu();
        return;
      case "target":
      case "allyTarget": {
        const pick = this.pick!;
        if (a === "confirm") { this.sfx.ui("ok"); this.pick = null; pick.confirm(pick.candidates[pick.index]); }
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
        this.sfx.ui("ok");
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
        this.sfx.ui("ok");
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

  private async castSpirit(unit: Unit, spiritId: number, target?: Unit) {
    const r = this.rules.useSpirit(unit, spiritId, this.units, target);
    this.ui.toast(r.text);
    for (const a of r.affected) {
      this.renderer.float(a.unit, a.kind === "heal" ? `+${a.amount}` : `-${a.amount}`, a.kind === "heal" ? "#6dff8a" : "#ff6b6b");
      if (a.kind === "damage") {
        const power = a.unit.hp === 0 ? 1 : Math.min(1, (a.amount / a.unit.maxHp) * 2);
        this.sfx.play(0x03);
        this.renderer.impact(a.unit, power);
        if (a.unit.hp === 0) { this.sfx.explode(); this.renderer.killUnit(a.unit); }
      }
    }
    this.dangerCache = null;
    this.refreshInfo();
    // 精神「怒」「狂怒」可能打掉敌人，跑一次检查脚本
    if (r.affected.some((a) => a.kind === "damage" && a.unit.hp === 0)) {
      const moved = this.moved;
      this.setMode("busy");
      await this.events.runCheck();
      if (this.mode === "over") return;
      this.moved = moved;
    }
    // 没移动过就回到选移动的状态（加速、疾风会扩大移动范围）；移动过回到行动菜单
    if (this.moved) this.openActionMenu(unit);
    else this.select(unit);
  }

  // 我方单位行动结束：跑检查脚本（胜负、过关、行动触发的事件），再跳到下一个没行动的单位
  private async finishAction(unit: Unit) {
    unit.acted = true;
    this.deselect();
    this.setMode("busy");
    await this.events.runCheck();
    if (this.mode === "over") return;
    this.setMode("browse");
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
      // 先放开火声，等“弹道飞到”再命中（音效是原版的，见 sfx.ts）
      const sound = strikeSound(e.weapon.name);
      this.sfx.attack(sound);
      await wait(sound.travel / this.speed());
      if (e.hit) {
        // 伤害占最大 HP 的比例决定打击力度：一半血以上或击破就是满力度
        const power = e.hpAfter === 0 ? 1 : Math.min(1, (e.damage / e.to.maxHp) * 2);
        this.sfx.hit(sound);
        // 先顿帧，再扣血、飘数字、震屏
        await wait(this.renderer.impact(e.to, power, this.speed()));
        e.to.hp = e.hpAfter;
        this.renderer.float(e.to, `-${e.damage}`, "#ff6b6b");
      } else {
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
      this.sfx.explode();
      this.renderer.killUnit(victim);
      this.renderer.float(victim, "击破", "#ffd257");
      const r = this.rules.reward(killer, victim, this.money);
      if (r.exp) {
        await wait(0.35 / this.speed());
        this.renderer.float(killer, `EXP +${r.exp}`, "#8fd3ff");
        if (r.levels > 0 && r.newLevel !== undefined) {
          applyLevel(killer, r.newLevel);
          this.ui.toast(`${killer.name} 升到 Lv ${killer.level}！`);
          // 原版升级时插播 0x0E 号小号角（系统消息里的 FD CE），放完接回原来的音乐
          this.music.jingle(LEVEL_UP_JINGLE);
          await wait(0.3 / this.speed());
          this.renderer.float(killer, "LEVEL UP", "#ffd257");
        }
      }
      await wait(0.5 / this.speed());
    }
    // 记下这场战斗，检查脚本的 battle 条件会用
    this.events.battleRecord = { attacker: attacker.pilotId, defender: defender.pilotId, attackerDown: attacker.hp <= 0, defenderDown: defender.hp <= 0 };
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
    this.phase = "enemy";
    this.music.play(this.songs.enemy);
    await this.ui.banner("敌方回合", "", "enemy");
    await this.enemyPhase();
    if (this.mode === "over") return;

    this.turn++;
    this.rules.jamming = false;
    for (const u of this.units) u.acted = false;
    this.repairOnBases("player");
    this.turnStartTraits("player");
    this.ui.setTurn(this.turn, "player");
    const first = this.players()[0];
    if (first) this.setCursor(first.x, first.y);
    await this.playerPhaseStart();
  }

  // 敌方回合：先跑本关的敌方阶段脚本（援军多半在这里），再按原版顺序让每个敌人跑自己的 AI 脚本，
  // 每个敌人行动完都跑一次检查脚本。友军 NPC 在敌人之后行动
  private async enemyPhase() {
    this.repairOnBases("enemy");
    this.turnStartTraits("enemy");
    await this.events.runEnemyPhase();
    for (const enemy of this.rules.enemyOrder(this.units)) {
      if (enemy.hp <= 0 || enemy.side !== "enemy") continue;
      await this.events.runUnit(enemy);
      await this.events.runCheck();
      if (this.mode === "over") return;
    }
    for (const npc of this.units.filter((u) => u.npc && u.hp > 0)) {
      await this.events.runUnit(npc);
      await this.events.runCheck();
      if (this.mode === "over") return;
    }
  }

  private moveUnit(unit: Unit, to: Point) {
    const path = pathTo(this.stage.map, this.unitReach(unit), to);
    return new Promise<void>((resolve) => {
      if (path.length < 2) { unit.x = to.x; unit.y = to.y; this.dangerCache = null; resolve(); return; }
      this.anim = { unit, path, t: 0, done: resolve };
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

  // 检查脚本走到「过关」「失败」「结局」。过关剧情、换曲都已经由脚本做完了
  private async finishStage(result: "clear" | "gameover" | "ending") {
    this.setMode("over");
    this.ui.closeMenu(false);
    this.ui.hideForecast();
    const lines = [`回合数　${this.turn}`, `获得资金　${this.money.value * 10}G`];
    await wait(0.6);
    this.ui.showResult(result !== "gameover", lines, () => location.reload());
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
      { label: "存档", run: () => void this.openSaveMenu() },
      { label: "读档", run: () => void this.openLoadMenu(() => this.openMapMenu()) },
      { label: "设置", detail: "按键 · 声音", run: () => { back(); this.onOpenSettings(); } },
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

const wait = (s: number) => new Promise<void>((r) => setTimeout(r, s * 1000));
