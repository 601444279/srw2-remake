// 游戏流程：我方回合（移动、攻击、精神、待机）、敌方回合、剧情。
// 战斗、命中、伤害、经验等规则在 rules.ts 里调用原版规则代码；
// 关卡事件（对话、援军、胜负、过关）和敌人 AI 由原版脚本驱动，见 events.ts。
import { applyLevel, expProgress, expToNext, formIndexOf, formsOf, mechName, pilotForForm, transformUnit, type Stage, type Unit, type Weapon } from "./data.ts";
import { StageEvents } from "./events.ts";
import { key, pathTo, rangeFrom, reachable, inBounds, MOVE_TYPE_ROW, type Point, type Reach } from "./grid.ts";
import type { Action } from "./input.ts";
import type { DrawState, Overlay, Renderer } from "./render.ts";
import type { GrowthStats, UI, MenuItem } from "./ui.ts";
import { Rules, SPIRIT_FLAG, isRepair, rngState, setRngState, type BattleEvent } from "./rules.ts";
import { describeTime, listSaves, readSave, requestLoad, writeSave, SAVE_VERSION, type SaveData, type SlotId } from "./saves.ts";
import { hitSoundFor, splitAttackSounds, strikeSound, type Sfx } from "./sfx.ts";
import { MUSIC, type Music } from "./music.ts";
import { keyLabel, settings, TEXT_SPEEDS, type BindAction } from "./settings.ts";
import { attackShout, damageCase, reactionShout } from "./shouts.ts";
import { traitOf, type Trait } from "./traits.ts";
import { levelForExp } from "./stats.ts";
import { AutoTester, type AutoOptions, type AutoReport } from "./autotest.ts";
import { BattleScene, attackSounds, battleLayout, battleSpriteUrl } from "./battle-scene.ts";
import { loadScene, personName, portraitUrl, STAGE_STORY, WORLD_MARKER, type SceneRef } from "./story.ts";

type Mode = "browse" | "selected" | "moving" | "menu" | "target" | "allyTarget" | "busy" | "dialog" | "title" | "over" | "status" | "notice";

const MOVE_TILES_PER_SEC = 14;
// 飞行演出（设置「飞行演出」）：选中时起飞悬停，移动时引擎推着加速、快到时减速，停下后缓缓降落
const FLIGHT_MAX_SPEED = 6.5; // 格/秒
const FLIGHT_ACCEL = 12; // 格/秒²，减速也用这个
const TAKEOFF_TIME = 0.3;
const LANDING_TIME = 0.8;
// 引擎声的推力：起飞、加速、巡航、减速、悬停
const THRUST = { takeoff: 0.6, accel: 1, cruise: 0.7, brake: 0.4, hover: 0.18 };
// 这些状态下选中的单位在悬停（战斗、对话时不出引擎声）
const HOVER_MODES: Mode[] = ["selected", "moving", "menu", "target", "allyTarget"];
// 剧情对话时的音乐：原版开新游戏后，开场剧情和进地图后的开场对话都放 9 号，第 1 回合开始才换成我方回合曲
const STORY_BGM = 0x09;
const STAGE_CARD_BGM = 0x12;
const LEVEL_UP_JINGLE = 0x0e;
const TYPE_LABELS = { air: "空", land: "陆", sea: "海" } as const;
// 建筑 / 基地格每回合开始回复 30% HP（docs/notes-rules.md 1.6）
const REPAIR_TERRAIN = 10;
// 打完一场战斗就清除的精神（加速、疾风保留到回合结束）
const ONE_SHOT_SPIRITS = 0xff & ~(SPIRIT_FLAG.ACCEL | SPIRIT_FLAG.GALE);

interface MoveAnim {
  unit: Unit;
  path: Point[];
  t: number; // 沿路线走过的格数
  v: number; // 飞行演出：当前速度（格/秒）
  done: () => void;
}

interface TargetPick {
  candidates: Unit[];
  index: number;
  confirm: (u: Unit) => void;
  cancel: () => void;
  preview?: (u: Unit) => void;
}

// 援军曲（原版第 13 首，事件指令 5B CD）的拍点（秒）：第一串「噔」×6 敲完 0.85，第二串 ×7 敲完 2.57，之后每 0.855 秒一记重拍
const REINFORCE_SONG = 13;
const REVEAL_BEATS = [0.85, 2.57, 3.41, 4.28, 5.13, 5.99, 6.84, 7.69, 8.56, 9.4, 10.27, 11.12, 11.98];
const REVEAL_PULSE = 0.855;

export class Game implements DrawState {
  cursor: Point = { x: 0, y: 0 };
  selected: Unit | null = null;
  units: Unit[];
  private mode: Mode = "busy";
  private reach: Reach | null = null;
  private origin: Point | null = null;
  private moved = false;
  private anim: MoveAnim | null = null;
  // 飞行演出：离地高度 0（地面）→ 1（悬停），只记离地的单位
  private alt = new Map<Unit, number>();
  // 每个单位这一帧的推力（画喷焰用）
  private thrust = new Map<Unit, number>();
  private dangerOn = false;
  // 开始菜单（继续 / 读档 / 新游戏）开着时，右上角按钮不打开地图菜单
  private inStartMenu = false;
  private dangerCache: Set<number> | null = null;
  private inspected: Unit | null = null;
  // 移动前的单位菜单打开时，背景显示移动范围
  private reachPreview = false;
  private status: { list: Unit[]; index: number; from: Unit; back: () => void } | null = null;
  private pick: TargetPick | null = null;
  private turn = 1;
  private money = { value: 0 };
  private rules: Rules;
  onOpenSettings: () => void = () => {};
  // 对话播放中：等玩家按确定翻页
  private talk: { next: () => void; skip: () => void; autoAt: number } | null = null;
  private titleSkip: (() => void) | null = null;
  // 升级卡片开着时：按确定关闭
  private noticeClose: (() => void) | null = null;
  private events: StageEvents;
  // 我方 / 敌方回合曲（脚本的 playerBgm / enemyBgm 会改），phase 是现在是谁的回合
  private songs = { player: 7, enemy: 8 };
  private phase: "player" | "enemy" = "player";
  // 这一阶段我方的击破数（击破连击）
  private combo = 0;
  // 播过的剧情段数（判断刚才有没有说话）
  private scenesPlayed = 0;
  // 战斗演出中（可以按键跳过）
  private inBattle = false;
  private skipBattle = false;
  // 自动测试（autotest.ts）
  private auto: AutoTester | null = null;

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

  // 援军登场：原版第 1 关三个援军 0.6 秒一个，都挤在援军曲开头那串「噔噔噔噔噔噔」里（模拟器实测）。
  // 重制版加强：每个敌人等一串「噔噔噔噔」敲完、或者后面一记重拍，才在那一拍上闪白冒出来、镜头一震，
  // 一个一个登场，有神秘感和压迫感。拍点取自援军曲（第 13 首）的音符起点，两套录音一样
  private lastReveal = 0;
  private async addUnit(u: Unit) {
    this.syncTrait(u);
    await this.renderer.loadUnit(u);
    this.setCursor(u.x, u.y);
    if (u.side === "enemy") await this.waitRevealBeat(); else await wait(10 / 60 / this.speed());
    this.units.push(u);
    this.dangerCache = null;
    if (u.side === "enemy") this.renderer.impact(u, 0.35, this.speed());
    else this.renderer.float(u, "加入", "player");
    await wait(26 / 60 / this.speed());
  }

  private async waitRevealBeat() {
    const minLead = 0.25; // 光标、镜头先到位
    const pos = this.speed() === 1 ? this.music.position(REINFORCE_SONG) : null;
    if (pos !== null) {
      const beat = REVEAL_BEATS.find((b) => b >= pos + minLead);
      const next = beat ?? pos + minLead + ((REVEAL_PULSE - ((pos + minLead - REVEAL_BEATS.at(-1)!) % REVEAL_PULSE)) % REVEAL_PULSE);
      await wait(next - pos);
    } else {
      // 没有音乐时间可对（静音、快进、别的曲子）：按援军曲的拍子 0.85 秒一个
      const gap = REVEAL_PULSE / this.speed();
      const since = (performance.now() - this.lastReveal) / 1000;
      await wait(Math.max(minLead / this.speed(), gap - since));
    }
    this.lastReveal = performance.now();
  }

  // 撤退 / 离场：淡出，不算击破，不给经验
  private async removeUnit(u: Unit) {
    this.renderer.float(u, "撤退", "dim");
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
    this.syncTraits();
    const first = this.players()[0];
    this.cursor = { x: first.x, y: first.y };
    this.renderer.centerOn(this.cursor);
    this.ui.setObjective(`胜利条件：${this.stage.events.victoryText.replace(/。$/, "")}`);
    this.ui.setTurn(this.turn, "player");
    this.refreshInfo();
    const bgm = MUSIC.stage(this.stage.number);
    // 战斗音乐也先下载，进战斗时不卡
    const battleSongs = this.players().map((u) => MUSIC.battle(u.pilotId, -1));
    this.music.preload([bgm.player, bgm.enemy, STORY_BGM, STAGE_CARD_BGM, REINFORCE_SONG, ...new Set(battleSongs)]);
    // 进关：开场脚本跑到第一个暂停点（出击前的剧情），然后是关卡标题，之后进入第 1 回合
    // 节奏照原版（模拟器逐帧量的）。原版切画面时关掉显示搬显存造成的黑屏（硬件限制）不继承，
    // 有意做的调色板淡入淡出保留：世界地图出来后单独停一会儿才开始对话；说完暗下去，
    // 关卡标题在黑底上淡入；标题直接切走，关卡地图淡入，停一下才开始地图上的对话
    const pause = (s: number) => wait(s / this.speed());
    this.setMode("busy");
    await this.ui.fade(true, 0);
    this.music.play(STORY_BGM);
    // 原版出击前的对话在世界地图上（红点是这一关的位置），说完才进关卡地图
    this.ui.showWorldMap(WORLD_MARKER[this.stage.number] ?? null);
    await this.ui.fade(false, 0.3 / this.speed());
    await pause(1.3);
    await this.events.runStart();
    await pause(0.3);
    await this.ui.fade(true, 0.3 / this.speed());
    this.ui.hideWorldMap();
    const story = STAGE_STORY[this.stage.number];
    this.setMode("title");
    // 原版：关卡标题出现时换 18 号短曲，标题过后回到剧情曲（地图上的对话），我方回合开始再换回合曲
    // 18 号是约 2.6 秒的短曲：只放一遍；标题照原版停约 2.3 秒（140 帧）就切走，换曲时快速收掉
    this.music.play(STAGE_CARD_BGM, { once: true });
    const card = this.ui.titleCard(story?.title ?? `第${this.stage.number}篇`, story?.subtitle ?? "", 2.3);
    this.titleSkip = card.skip;
    if (this.auto) card.skip();
    await card.done;
    this.titleSkip = null;
    this.setMode("busy");
    this.music.play(STORY_BGM, { fade: 0.15 });
    await this.ui.fade(false, 0.4 / this.speed());
    await pause(0.4);
    await this.playerPhaseStart();
  }

  // 我方回合开始：开场脚本和检查脚本各继续一次（地图上的开场对话、回合触发的事件），然后横幅
  private async playerPhaseStart() {
    this.setMode("busy");
    this.phase = "player";
    this.combo = 0;
    const scenes = this.scenesPlayed;
    await this.events.runStart();
    await this.events.runCheck();
    if (this.mode === "over") return;
    // 刚说完话：地图空着停一下再进回合（原版的节奏）
    if (this.scenesPlayed !== scenes) await wait(0.6 / this.speed());
    this.music.play(this.songs.player);
    await this.ui.banner(`第 ${this.turn} 回合`, "我方回合", "player");
    this.setMode("browse");
    if (this.auto) { void this.autoPlayerTurn(); return; }
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
    this.syncTraits();
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

  private async openSaveMenu(onCancel = () => this.openMapMenu()) {
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
    this.openMenu(items, this.cursor, onCancel);
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
        this.inStartMenu = true;
        this.setMode("menu");
        this.ui.openMenu([
          { label: "继续", detail: describeTime(latest.savedAt), hint: `${latest.title} · 第 ${latest.turn} 回合`, run: () => requestLoad(latest.slot) },
          { label: "读档", run: () => void this.openLoadMenu(show) },
          { label: "新游戏", run: () => { this.inStartMenu = false; resolve(); void this.start(); } },
        ], innerWidth / 2 - 90, innerHeight / 2 - 60, show);
      };
      show();
    });
  }

  // ---------- 剧情 ----------
  private async playScene(ref: SceneRef) {
    const lines = loadScene(ref);
    this.scenesPlayed++;
    if (this.auto) { this.auto.scenes++; this.auto.progress(); return; }
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
    if (this.selected && this.reach && (this.mode === "selected" || this.mode === "moving" || (this.mode === "menu" && this.reachPreview))) {
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

  // 离地高度，起落两头都放缓
  unitLift(unit: Unit): number {
    const a = this.alt.get(unit) ?? 0;
    return a * a * (3 - 2 * a);
  }

  unitThrust(unit: Unit): number {
    return this.thrust.get(unit) ?? 0;
  }

  // 沿路线移动时当前这一段的方向
  unitHeading(unit: Unit): Point | null {
    if (!this.anim || this.anim.unit !== unit || this.anim.v <= 0) return null;
    const { path, t } = this.anim;
    const i = Math.min(Math.floor(t), path.length - 2);
    const a = path[i], b = path[i + 1] ?? a;
    return { x: b.x - a.x, y: b.y - a.y };
  }

  update(dt: number) {
    // 按住快速键：对话自动快进
    if (this.talk && this.fast()) {
      this.talk.autoAt += dt;
      if (this.talk.autoAt > 0.12) { this.talk.autoAt = 0; this.ui.finishLine(); this.talk.next(); }
    }
    const k = dt * this.speed();
    const thrust = this.updateFlight(k);
    this.sfx.engine(this.skipBattle ? 0 : thrust);
    if (!this.anim) return;
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

  // 起飞 / 降落、沿路线推进，返回这一帧的引擎推力
  private updateFlight(k: number): number {
    const flight = settings.get().flight, anim = this.anim;
    const up = new Set<Unit>();
    if (flight && this.selected) up.add(this.selected);
    if (flight && anim) up.add(anim.unit);
    this.thrust.clear();
    for (const u of up) if (!this.alt.has(u)) this.alt.set(u, 0);
    for (const [u, a] of this.alt) {
      if (up.has(u) && u.hp > 0) {
        this.alt.set(u, Math.min(1, a + k / TAKEOFF_TIME));
        if (a < 1) this.thrust.set(u, THRUST.takeoff);
        else if (HOVER_MODES.includes(this.mode) || anim?.unit === u) this.thrust.set(u, THRUST.hover);
      } else {
        // 降落：推力跟着高度慢慢收
        if (a - k / LANDING_TIME <= 0) this.alt.delete(u);
        else this.alt.set(u, a - k / LANDING_TIME);
        this.thrust.set(u, THRUST.brake * a);
      }
    }
    const thrust = Math.max(0, ...this.thrust.values());
    if (!anim) return thrust;
    if (!flight) { anim.t += k * MOVE_TILES_PER_SEC; return thrust; }
    // 先升到悬停高度再走
    if ((this.alt.get(anim.unit) ?? 0) < 1) return thrust;
    // 加速到最高速，剩下的距离刚好够刹住时开始减速（最后留一点速度，不会停在半路）
    const left = anim.path.length - 1 - anim.t;
    const brakeCap = Math.max(1.2, Math.sqrt(2 * FLIGHT_ACCEL * left));
    const v = Math.min(FLIGHT_MAX_SPEED, anim.v + FLIGHT_ACCEL * k, brakeCap);
    const phase = v < anim.v - 1e-6 || v === brakeCap ? "brake" : v > anim.v + 1e-6 ? "accel" : "cruise";
    anim.v = v;
    anim.t += v * k;
    this.thrust.set(anim.unit, THRUST[phase]);
    return THRUST[phase];
  }

  // 按住 Shift / 手柄 X 时演出加速
  private speed() {
    if (this.skipBattle) return 40;
    if (this.auto) return this.auto.speed;
    return this.fast() ? 3 : 1;
  }

  // ---------- 输入 ----------
  move(dx: number, dy: number) {
    if (this.mode === "status") { if (dx) this.cycleStatus(dx); return; }
    if (this.mode === "menu") { this.ui.menuMove(dy || dx); this.sfx.ui("move"); return; }
    if (this.mode === "target" || this.mode === "allyTarget") { this.cyclePick(dx + dy > 0 ? 1 : -1); this.sfx.ui("move"); return; }
    if (this.mode !== "browse" && this.mode !== "selected") return;
    this.moveCursorTo(this.cursor.x + dx, this.cursor.y + dy);
  }

  // 原版：选中单位后在地图上移动光标，每走一格放 1F（和菜单光标同一声）；没选单位时移动光标不出声
  private moveCursorTo(x: number, y: number) {
    const { x: ox, y: oy } = this.cursor;
    this.setCursor(x, y);
    if (this.mode === "selected" && (this.cursor.x !== ox || this.cursor.y !== oy)) this.sfx.ui("move");
  }

  pointerTile(p: Point) {
    if (this.pick) {
      const i = this.pick.candidates.findIndex((u) => u.x === p.x && u.y === p.y);
      if (i >= 0 && i !== this.pick.index) { this.pick.index = i; this.focusPick(); }
      return;
    }
    if (this.mode !== "browse" && this.mode !== "selected") return;
    if (p.x !== this.cursor.x || p.y !== this.cursor.y) this.moveCursorTo(p.x, p.y);
  }

  pointerClick(p: Point, button: number) {
    if (this.mode === "dialog" || this.mode === "title") { this.action(button === 2 ? "cancel" : "confirm"); return; }
    if (this.mode === "status") return;
    if (this.inBattle) { this.skipCurrentBattle(); return; }
    if (button === 2) { this.action("cancel"); return; }
    // 移动前的单位菜单开着时直接点地图：点范围内的格子就走过去，点敌人就自动接近攻击
    if (this.mode === "menu" && this.reachPreview && this.selected && inBounds(this.stage.map, p.x, p.y)) {
      const enemy = this.unitAt(p)?.side === "enemy";
      if (!enemy && !this.reach!.stops.has(key(this.stage.map, p.x, p.y))) return;
      this.ui.closeMenu(false);
      this.startMove(this.selected);
      this.setCursor(p.x, p.y);
      this.action("confirm");
      return;
    }
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
    if (this.inBattle && (a === "confirm" || a === "cancel")) { this.skipCurrentBattle(); return; }
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
      case "notice":
        if (a === "confirm" || a === "cancel") this.noticeClose?.();
        return;
      case "status":
        if (a === "confirm" || a === "cancel") this.closeStatus();
        if (a === "next" || a === "prev") this.cycleStatus(a === "next" ? 1 : -1);
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
        if (here) return this.openInfoMenu(here);
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
      case "save":
        return void this.openSaveMenu(() => this.setMode("browse"));
      case "load":
        return void this.openLoadMenu(() => this.setMode("browse"));
    }
  }

  private selectedAction(a: Action) {
    const unit = this.selected!;
    switch (a) {
      case "confirm": {
        const target = this.unitAt(this.cursor);
        // 现代捷径：直接点敌人，自动走到能打到它的格子再选武器
        if (target?.side === "enemy") return this.quickAttack(unit, target);
        if (this.cursor.x === unit.x && this.cursor.y === unit.y) { this.sfx.ui("ok"); return this.openActionMenu(unit); }
        const k = key(this.stage.map, this.cursor.x, this.cursor.y);
        if (!this.reach!.stops.has(k)) { this.ui.toast("无法移动到这里"); return; }
        this.sfx.ui("ok");
        return this.moveSelected(this.cursor, () => this.openActionMenu(unit));
      }
      case "cancel":
        // 选目的地时取消：回到单位菜单
        return this.openActionMenu(unit);
      case "danger":
        return this.toggleDanger();
    }
  }

  // ---------- 我方行动 ----------
  // 选中我方单位：先弹出单位菜单（移动 / 攻击 / 精神 / 变形 / 资料 / 待机），背景显示移动范围
  private select(unit: Unit) {
    this.inspected = null;
    this.selected = unit;
    this.origin = null;
    this.moved = false;
    this.reach = this.unitReach(unit);
    this.openActionMenu(unit);
  }

  // 菜单里选「移动」：选目的地
  private startMove(unit: Unit) {
    this.setMode("selected");
    this.setCursor(unit.x, unit.y);
  }

  // 已行动的我方、敌方、友军：只能看资料、看范围
  private openInfoMenu(unit: Unit) {
    const back = () => this.setMode("browse");
    const items: MenuItem[] = [{ label: "资料", run: () => this.openStatus(unit, back) }];
    if (unit.side !== "player") {
      const on = this.inspected === unit;
      items.push({ label: on ? "隐藏范围" : "显示范围", hint: "移动范围和攻击范围", run: () => { this.inspected = on ? null : unit; back(); } });
    }
    this.openMenu(items, unit, back);
  }

  // ---------- 资料页 ----------
  private openStatus(unit: Unit, back: () => void) {
    const alive = this.units.filter((u) => u.hp > 0);
    const order = { player: 0, npc: 1, enemy: 2 } as Record<string, number>;
    const list = [...alive].sort((a, b) => (order[a.npc ? "npc" : a.side] ?? 3) - (order[b.npc ? "npc" : b.side] ?? 3));
    this.status = { list, index: Math.max(0, list.indexOf(unit)), from: unit, back };
    this.setMode("status");
    this.renderStatus();
  }

  private renderStatus() {
    const { list, index } = this.status!;
    const unit = list[index];
    this.setCursor(unit.x, unit.y);
    this.renderer.centerOn(unit);
    this.ui.showStatus(
      {
        unit,
        iconUrl: this.renderer.iconUrl(unit),
        sprite: battleSpriteUrl(unit.unitId),
        portrait: unit.pilotName ? portraitUrl(unit.pilotId) : null,
        expToNext: unit.side === "player" ? expToNext(unit) : null,
        index,
        count: list.length,
      },
      { close: () => this.closeStatus(), cycle: (d) => this.cycleStatus(d) },
    );
  }

  private cycleStatus(dir: number) {
    const st = this.status;
    if (!st) return;
    st.index = (st.index + (dir > 0 ? 1 : -1) + st.list.length) % st.list.length;
    this.sfx.ui("move");
    this.renderStatus();
  }

  private closeStatus() {
    const st = this.status;
    if (!st) return;
    this.status = null;
    this.ui.hideStatus();
    // 镜头回到打开资料页的单位
    this.setCursor(st.from.x, st.from.y);
    this.renderer.centerOn(st.from);
    st.back();
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
    this.anim = { unit, path: pathTo(this.stage.map, this.reach!, to), t: 0, v: 0, done };
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

  // 单位菜单：移动前有「移动」「变形」，取消就放开这个单位；移动后取消退回原位重新选目的地
  private openActionMenu(unit: Unit) {
    this.setCursor(unit.x, unit.y, false);
    const canAttack = unit.weapons.some((w) => this.rules.targetsFor(unit, w, unit, this.moved, this.units).length);
    const canSpirit = this.rules.spiritMenu(unit, this.units).some((s) => s.usable);
    const canMove = !this.moved && this.reach!.stops.size > 1;
    const back = () => this.openActionMenu(unit);
    const items: MenuItem[] = [
      ...(!this.moved ? [{ label: "移动", disabled: !canMove, detail: `机动 ${this.rules.mobility(unit)}`, run: () => this.startMove(unit) }] : []),
      { label: "攻击", disabled: !canAttack, detail: canAttack ? "" : "无目标", run: () => this.chooseWeapon(unit) },
      { label: "精神", disabled: !canSpirit, detail: unit.maxSp ? `SP ${unit.sp}` : "", run: () => this.openSpiritMenu(unit) },
      // 原版只在移动前的单位菜单里有「变形」，变形不消耗行动
      ...(!this.moved && formsOf(unit.unitId).length > 1 ? [{ label: "变形", run: () => this.openTransformMenu(unit) }] : []),
      { label: "资料", run: () => this.openStatus(unit, back) },
      { label: "待机", run: () => this.finishAction(unit) },
    ];
    if (this.moved) this.openMenu(items, unit, () => this.undoMove(unit));
    else this.openMenu(items, unit, () => { this.setCursor(unit.x, unit.y); this.deselect(); }, true);
  }

  // ---------- 变形 ----------
  private openTransformMenu(unit: Unit) {
    const labels = { air: "空", land: "陆", sea: "海" } as const;
    const items: MenuItem[] = formsOf(unit.unitId)
      .filter((id) => id !== unit.unitId)
      .map((id) => {
        const preview = this.previewForm(unit, id);
        return {
          label: mechName(id),
          detail: `${labels[preview.moveType]} · 机动 ${preview.move}`,
          hint: preview.weapons.map((w) => w.name).join("、") + (preview.pilotName !== unit.pilotName ? ` · 驾驶员 ${preview.pilotName}` : ""),
          run: () => void this.transform(unit, id),
        };
      });
    this.openMenu(items, unit, () => this.openActionMenu(unit));
  }

  // 预览新形态的数值（不改原单位）
  private previewForm(unit: Unit, id: number) {
    const copy = structuredClone(unit);
    transformUnit({ ...this.stage, roster: [] }, copy, id);
    return copy;
  }

  private async transform(unit: Unit, id: number) {
    this.setMode("busy");
    const scenes = transformLines(unit.pilotId, id);
    for (const scene of scenes) await this.playScene(scene);
    transformUnit(this.stage, unit, id);
    this.syncTrait(unit);
    await this.renderer.loadUnit(unit);
    this.renderer.hitUnit(unit);
    this.renderer.float(unit, "变形", "player");
    this.dangerCache = null;
    this.refreshInfo();
    await wait(0.3 / this.speed());
    // 变形不消耗行动，回到选移动的状态（移动力、地形适性都变了）
    this.select(unit);
  }

  // 移动后的菜单里取消：回到移动前的位置，重新选目的地
  private undoMove(unit: Unit) {
    if (this.origin) { unit.x = this.origin.x; unit.y = this.origin.y; this.dangerCache = null; }
    this.origin = null;
    this.moved = false;
    this.reach = this.unitReach(unit);
    this.startMove(unit);
  }

  private chooseWeapon(unit: Unit, preset?: Unit) {
    const items: MenuItem[] = unit.weapons.map((w) => {
      const targets = this.rules.targetsFor(unit, w, unit, this.moved, preset ? [preset] : this.units);
      if (isRepair(w)) {
        const hint = `射程 ${w.range}　回复友军 HP（最多 ${unit.maxHp >> 1}）`;
        return { label: w.name, detail: targets.length ? `${targets.length} 个目标` : "无人受伤", hint, disabled: !targets.length, run: () => this.chooseRepairTarget(unit, targets, () => this.chooseWeapon(unit, preset)) };
      }
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

  // 修理装置：选一名射程内受伤的友军，在地图上直接回复，然后行动结束（原版不给经验）
  private chooseRepairTarget(unit: Unit, targets: Unit[], back: () => void) {
    this.startPick("allyTarget", targets, {
      confirm: async (t) => {
        this.setMode("busy");
        // 原版：不进战斗画面，在地图上被修理的单位周围星星绕圈（04 号音效），然后回复量跳出来（05 号音效）
        const amount = this.rules.repair(unit, t);
        this.setCursor(t.x, t.y);
        this.sfx.play(0x04);
        this.renderer.repairFx(t, 1.4 / this.speed());
        await wait(1.4 / this.speed());
        this.sfx.play(0x05);
        this.renderer.float(t, `+${amount}`, "hp");
        this.refreshInfo();
        await wait(1.0 / this.speed());
        this.finishAction(unit);
      },
      cancel: back,
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
      this.renderer.float(a.unit, a.kind === "heal" ? `+${a.amount}` : `-${a.amount}`, a.kind === "heal" ? "hp" : "danger");
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

    const full = (this.auto?.battle ?? settings.get().battleStyle) === "full";
    this.inBattle = true;
    this.refreshHints();
    if (full) await this.battleFull(attacker, defender, events);
    else await this.battleSimple(attacker, defender, events);
    this.inBattle = false;
    this.skipBattle = false;
    this.ui.battleEnd();
    this.refreshHints();
    if (this.auto) {
      this.auto.battles++;
      for (const u of [attacker, defender]) if (after.get(u) === 0) this.auto.kills[u.side === "player" ? "player" : "enemy"]++;
    }
    for (const [u, hp] of after) u.hp = hp;

    // 击破、经验、升级
    for (const [victim, killer] of [[defender, attacker], [attacker, defender]] as const) {
      if (victim.hp > 0) continue;
      if (!full) this.sfx.explode();
      this.renderer.killUnit(victim);
      this.renderer.float(victim, "击破", "accent");
      const before = { stats: growthStats(killer), levelIndex: killer.levelIndex, exp: killer.exp, trait: killer.trait };
      // 击破连击：同一阶段里我方第 n 次击破，经验 +10% × (n − 1)，最多 +50%
      let combo: { count: number; bonus: number } | null = null;
      if (killer.side === "player" && settings.get().killCombo) {
        this.combo++;
        if (this.combo >= 2) {
          combo = { count: this.combo, bonus: Math.min(50, (this.combo - 1) * 10) };
          this.renderer.float(killer, `${this.combo} 连击！`, "combo");
        }
      }
      const r = this.rules.reward(killer, victim, this.money, combo?.bonus ?? 0);
      if (r.exp) {
        await wait(0.35 / this.speed());
        if (r.levels > 0 && r.newLevel !== undefined) {
          applyLevel(killer, r.newLevel);
          this.syncTrait(killer);
          // 原版升级时插播 0x0E 号小号角（系统消息里的 FD CE），放完接回原来的音乐
          this.music.jingle(LEVEL_UP_JINGLE);
        }
        await this.showGrowth(killer, r.exp, before, combo);
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

  // 简略：地图上的小战斗面板
  private async battleSimple(attacker: Unit, defender: Unit, events: BattleEvent[]) {
    this.ui.battleStart(attacker, this.renderer.iconUrl(attacker), defender, this.renderer.iconUrl(defender));
    await wait(0.25 / this.speed());
    let attacks = 0;
    for (const [i, e] of events.entries()) {
      // 战斗台词（原版规则，见 shouts.ts）：出手前喊招式，第一次是攻击 / 反击，攻方第二次出手是再攻击
      const kind = e.from === attacker ? (attacks++ ? "extra" : "attack") : "counter";
      this.ui.battleSay(e.from, attackShout(e.from.pilotId, kind, e.weapon.id));
      await wait(0.35 / this.speed());
      // 放原版这段攻击动画的音效（按原版帧号），放完再出结果；没有动画数据的用按武器名配的音效
      const seq = attackSounds(e.from.unitId, e.weapon.id);
      const sound = strikeSound(e.weapon.name);
      // 动画末尾的命中声留到真正命中时放（sfx.ts splitAttackSounds）
      if (seq) await this.playSounds(splitAttackSounds(seq).lead);
      else {
        if (!this.skipBattle) this.sfx.attack(sound);
        await wait(sound.travel / this.speed());
      }
      if (e.hit) {
        // 伤害占最大 HP 的比例决定打击力度：一半血以上或击破就是满力度
        const power = e.hpAfter === 0 ? 1 : Math.min(1, (e.damage / e.to.maxHp) * 2);
        if (!seq && !this.skipBattle) this.sfx.hit(sound);
        if (seq) this.hitSound(seq);
        // 先顿帧，再扣血、飘数字、震屏
        await wait(this.renderer.impact(e.to, power, this.speed()));
        e.to.hp = e.hpAfter;
        this.renderer.float(e.to, `-${e.damage}`, "danger");
      } else {
        if (seq) this.missSound(seq);
        this.renderer.float(e.to, "MISS", "dim");
      }
      this.ui.battleSay(e.to, reactionShout(e.to.pilotId, damageCase(e.hit, e.damage, e.hpAfter, e.to.maxHp)));
      await this.ui.battleStrike(e, 0.75 / this.speed());
      // 攻方打完、守方还活着却没有反击：守方说「无法反击」的台词
      if (i === 0 && e.hpAfter > 0 && events[1]?.from !== defender) {
        this.ui.battleSay(defender, reactionShout(defender.pilotId, "cannotCounter"));
        await wait(0.6 / this.speed());
      }
    }
    await wait(0.2 / this.speed());
    this.ui.battleEnd();
  }

  // 战斗后的经验 / 升级卡片（ui.showGrowth）。升级卡等玩家按确定，自动测试时直接关
  private async showGrowth(unit: Unit, gained: number, before: { stats: GrowthStats; levelIndex: number; exp: number; trait: Trait | null }, combo: { count: number; bonus: number } | null = null) {
    const bar = (li: number, exp: number) => { const p = expProgress(li, exp); return p ? Math.min(1, p.into / p.span) : null; };
    const card = this.ui.showGrowth({
      unit,
      portrait: unit.pilotName ? portraitUrl(unit.pilotId) : null,
      gained,
      before: before.stats,
      after: growthStats(unit),
      barBefore: bar(before.levelIndex, before.exp) ?? 1,
      barAfter: bar(unit.levelIndex, unit.exp),
      toNext: expToNext(unit),
      combo,
      traitBefore: before.trait,
      traitAfter: unit.trait,
    }, this.speed(), (k) => this.sfx.ui(k === "tick" ? "move" : "ok"));
    const up = unit.levelIndex > before.levelIndex;
    if (!up) { await card.done; return; }
    const prev = this.mode;
    this.noticeClose = card.advance;
    this.setMode("notice");
    if (this.auto) setTimeout(card.close, 300);
    await card.done;
    // 特性强化了：单独再弹一个画面
    const tb = before.trait, ta = unit.trait;
    if (tb && ta && ta.tier > tb.tier) {
      const tu = this.ui.showTraitUp({ unit, portrait: unit.pilotName ? portraitUrl(unit.pilotId) : null, before: tb, after: ta }, this.speed(), (k) => this.sfx.ui(k === "tick" ? "move" : "ok"));
      this.noticeClose = tu.advance;
      if (this.auto) setTimeout(tu.close, 300);
      await tu.done;
    }
    this.noticeClose = null;
    this.setMode(prev);
  }

  // 命中那一刻的音效：动画自带的命中声挪到这里放，没有的按设置补 03（sfx.ts hitSoundFor）
  private hitSound(animSounds: [number, number][] | null) {
    if (this.skipBattle || !animSounds) return;
    const id = hitSoundFor(animSounds, settings.get().hitSfx);
    if (id !== null) this.sfx.impact(id);
  }

  // 没打中：命中声不放；动画里只有那一声的（格斗挥砍）照原样放，免得整段没声
  private missSound(animSounds: [number, number][]) {
    if (this.skipBattle) return;
    const { lead, impact } = splitAttackSounds(animSounds);
    if (!lead.length && impact !== null) this.sfx.play(impact);
  }

  // 按原版帧号依次放音效（60 帧 = 1 秒，跟着演出倍速），跳过战斗时停
  private async playSounds(seq: [number, number][]) {
    let frame = 0;
    for (const [f, id] of seq) {
      await wait((f - frame) / 60 / this.speed());
      frame = f;
      if (this.skipBattle) return;
      this.sfx.play(id);
    }
    await wait(6 / 60 / this.speed());
  }

  // 完整：原版战斗画面（battle-scene.ts）。台词规则和简略一样
  private async battleFull(attacker: Unit, defender: Unit, events: BattleEvent[]) {
    // 原版进战斗画面换战斗音乐（按我方驾驶员，对贝克放专属曲），战斗结束接回地图上的曲子
    const back = this.music.playing;
    const ours = [attacker, defender].find((u) => u.side === "player") ?? attacker;
    const theirs = ours === attacker ? defender : attacker;
    this.music.play(MUSIC.battle(ours.pilotId, theirs.pilotId));
    const scene = new BattleScene(() => this.speed(), () => this.skipBattle, () => this.skipCurrentBattle(), (id) => { if (!this.skipBattle) this.sfx.play(id); });
    await scene.open(attacker, defender, battleLayout(attacker, defender));
    await wait(0.25 / this.speed());
    let attacks = 0;
    for (const [i, e] of events.entries()) {
      const kind = e.from === attacker ? (attacks++ ? "extra" : "attack") : "counter";
      scene.weapon(e.from, e.weapon.name);
      scene.say(e.from, attackShout(e.from.pilotId, kind, e.weapon.id) ?? `${e.weapon.name}！`);
      await wait(0.55 / this.speed());
      // 音效由原版动画数据按帧触发（scene.attack 里）；原版命中、落空之后不另放音效
      // 打中时另补一声命中音（重制版，设置里可关，见 hitSound）
      const anim = attackSounds(e.from.unitId, e.weapon.id);
      await scene.attack(e.from, e.weapon.id, anim ? splitAttackSounds(anim).lead : undefined);
      if (e.hit) {
        this.hitSound(anim);
        scene.hit(e.to, e.damage, e.hpAfter, e.hpAfter === 0 ? 1 : Math.min(1, (e.damage / e.to.maxHp) * 2));
      } else {
        if (anim) this.missSound(anim);
        scene.miss(e.to);
      }
      if (e.hpAfter === 0) {
        // 击破：先让这一击打实（伤害数字、血条扣到 0），喊完被击破的台词，再慢镜头爆炸
        await wait(0.6 / this.speed());
        scene.say(e.to, reactionShout(e.to.pilotId, "destroyed"));
        await wait(0.35 / this.speed());
        await scene.explode(e.to, () => { if (!this.skipBattle) this.sfx.explode(); });
        await wait(0.4 / this.speed());
      } else {
        await wait(0.3 / this.speed());
        scene.say(e.to, reactionShout(e.to.pilotId, damageCase(e.hit, e.damage, e.hpAfter, e.to.maxHp)));
        await wait(0.8 / this.speed());
      }
      if (i === 0 && e.hpAfter > 0 && events[1]?.from !== defender) {
        scene.say(defender, reactionShout(defender.pilotId, "cannotCounter"));
        await wait(0.7 / this.speed());
      }
    }
    await scene.close();
    if (back === null) this.music.stop();
    else this.music.play(back);
  }

  // 演示升级卡片（地址加 ?demo=levelup）：Lv 9 → 11（跨过 Lv 10 特性强化），带 3 连击；然后一张没升级的小卡。按确定重播
  async demoLevelUp() {
    this.setMode("busy");
    const src = this.players().find((u) => u.trait) ?? this.players()[0];
    const u = structuredClone(src);
    this.ui.toast("升级动画演示：按确定继续 / 重播");
    for (;;) {
      applyLevel(u, 8);
      u.exp = 2300;
      this.syncTrait(u);
      const before = { stats: growthStats(u), levelIndex: u.levelIndex, exp: u.exp, trait: u.trait };
      const gained = 800;
      u.exp += gained;
      applyLevel(u, levelForExp(u.exp, u.levelIndex));
      this.syncTrait(u);
      this.music.jingle(LEVEL_UP_JINGLE);
      await this.showGrowth(u, gained, before, { count: 3, bonus: 20 });
      await wait(0.4);
      const small = { stats: growthStats(u), levelIndex: u.levelIndex, exp: u.exp, trait: u.trait };
      u.exp += 120;
      await this.showGrowth(u, 120, small, { count: 2, bonus: 10 });
      await wait(0.6);
    }
  }

  // 特性档位跟着等级和「特性成长」设置走（敌方有名有姓的驾驶员也一样）
  private syncTrait(u: Unit) {
    u.trait = traitOf(u.pilotId, u.level, settings.get().traitGrowth);
  }

  private syncTraits() {
    for (const u of this.units) this.syncTrait(u);
  }

  // 战斗中按确定 / 取消（或点一下）：跳过演出，直接出结果
  private skipCurrentBattle() {
    if (!this.inBattle || this.skipBattle) return;
    this.skipBattle = true;
    this.ui.battleEnd();
  }

  // ---------- 自动测试（开发用，见 autotest.ts） ----------
  get autoplaying() {
    return !!this.auto;
  }

  autoplay(opts: AutoOptions = {}): Promise<AutoReport> {
    if (this.auto) return this.auto.done;
    const auto = new AutoTester(this.stage, opts, () => ({ turn: this.turn, mode: this.mode }));
    this.auto = auto;
    const real = { sfx: this.sfx, music: this.music };
    if (auto.mute) {
      const silent = new Proxy({}, { get: () => () => {} });
      this.sfx = silent as Sfx;
      this.music = silent as Music;
      real.music.stop();
    }
    void auto.done.then(() => {
      this.auto = null;
      this.sfx = real.sfx;
      this.music = real.music;
    });
    // 已经在我方回合里就直接开始；否则等开场流程走到我方回合
    if (this.mode === "browse") void this.autoPlayerTurn();
    return auto.done;
  }

  // 我方回合交给 AI：能打就打（偶尔先用精神），打不到就接近；然后结束回合
  private async autoPlayerTurn() {
    const auto = this.auto!;
    this.setMode("busy");
    try {
      for (const u of this.players()) {
        if (u.acted || u.hp <= 0 || u.npc) continue;
        this.autoSpirit(u);
        const plan = this.rules.pickAttack(u, this.units, 3, true);
        if (plan) {
          const moved = plan.to.x !== u.x || plan.to.y !== u.y;
          await this.focus(u);
          if (moved) await this.moveUnit(u, plan.to);
          await this.battle(u, plan.weapon, plan.target, moved);
        } else {
          const to = this.rules.approach(u, this.units);
          if (to && (to.x !== u.x || to.y !== u.y)) await this.moveUnit(u, to);
        }
        u.acted = true;
        await this.events.runCheck();
        auto.check(this.units);
        if (this.mode === "over") return;
      }
    } catch (e) {
      auto.problem(`我方行动出错：${(e as Error).stack ?? e}`);
      auto.finish("出错停止");
      return;
    }
    if (this.turn >= auto.turns) { auto.finish(`到达回合上限 ${auto.turns}`); return; }
    await this.endTurn();
  }

  // 血少时用回复类精神；其他时候有一定机会随便用一个（顺便测精神）
  private autoSpirit(u: Unit) {
    const menu = this.rules.spiritMenu(u, this.units).filter((s) => s.usable && s.def.effect.kind !== "warp" && !(s.def.effect.kind === "heal" && s.def.effect.target === "ally"));
    if (!menu.length) return;
    const heal = menu.find((s) => s.def.effect.kind === "heal");
    const pick = u.hp < u.maxHp * 0.4 && heal ? heal : Math.random() < 0.25 ? menu[Math.floor(Math.random() * menu.length)] : null;
    if (!pick) return;
    this.rules.useSpirit(u, pick.spirit.id, this.units);
    this.auto!.spirits++;
    this.dangerCache = null;
  }

  // ---------- 回合 ----------
  private async endTurn() {
    this.deselect();
    this.inspected = null;
    this.setMode("busy");
    for (const u of this.players()) u.spirit &= ~(SPIRIT_FLAG.ACCEL | SPIRIT_FLAG.GALE);
    // 回合交接照原版：暗下去 0.3 秒、短暂黑一下、0.4 秒亮起（原版中间黑得更久，一部分是关显示搬显存，不继承）
    await this.ui.fade(true, 0.3 / this.speed());
    this.ui.setTurn(this.turn, "enemy");
    this.phase = "enemy";
    this.music.play(this.songs.enemy);
    await wait(0.15 / this.speed());
    await this.ui.fade(false, 0.4 / this.speed());
    await this.ui.banner("敌方回合", "", "enemy");
    await this.enemyPhase();
    if (this.mode === "over") return;
    await wait(0.4 / this.speed());
    await this.ui.fade(true, 0.3 / this.speed());

    this.turn++;
    this.rules.jamming = false;
    for (const u of this.units) u.acted = false;
    this.repairOnBases("player");
    this.turnStartTraits("player");
    this.ui.setTurn(this.turn, "player");
    const first = this.players()[0];
    if (first) this.setCursor(first.x, first.y);
    await wait(0.15 / this.speed());
    await this.ui.fade(false, 0.4 / this.speed());
    await this.playerPhaseStart();
  }

  // 敌方回合：先跑本关的敌方阶段脚本（援军多半在这里），再按原版顺序让每个敌人跑自己的 AI 脚本，
  // 每个敌人行动完都跑一次检查脚本。友军 NPC 在敌人之后行动
  private async enemyPhase() {
    this.combo = 0;
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

  private async moveUnit(unit: Unit, to: Point) {
    const path = pathTo(this.stage.map, this.unitReach(unit), to);
    // 敌方回合：原版先把这个单位的移动范围亮出来停一下，再移动
    if (this.phase === "enemy" && path.length >= 2 && !this.auto) {
      this.inspected = unit;
      await wait(0.55 / this.speed());
      this.inspected = null;
    }
    return new Promise<void>((resolve) => {
      if (path.length < 2) { unit.x = to.x; unit.y = to.y; this.dangerCache = null; resolve(); return; }
      this.anim = { unit, path, t: 0, v: 0, done: resolve };
    });
  }

  private repairOnBases(side: Unit["side"]) {
    for (const u of this.units) {
      if (u.side !== side || u.hp <= 0 || u.hp >= u.maxHp) continue;
      if (this.stage.map.terrain[u.y][u.x] !== REPAIR_TERRAIN) continue;
      const before = u.hp;
      u.hp = Math.min(u.maxHp, u.hp + Math.floor(u.maxHp * 0.3));
      this.renderer.float(u, `+${u.hp - before}`, "hp");
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
        this.renderer.float(u, `+${u.hp - before}`, "hp");
      }
    }
  }

  // 检查脚本走到「过关」「失败」「结局」。过关剧情、换曲都已经由脚本做完了
  private async finishStage(result: "clear" | "gameover" | "ending") {
    this.auto?.finish({ clear: "过关", gameover: "失败", ending: "结局" }[result]);
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
  private openMenu(items: MenuItem[], at: Point, onCancel: () => void, reachPreview = false) {
    this.reachPreview = reachPreview;
    this.setMode("menu");
    const s = 16 * this.renderer.zoom;
    const pos = this.renderer.tileToScreen(at);
    this.ui.openMenu(items, pos.x + s * 1.2, pos.y, onCancel);
  }

  // 右上角按钮：再点一次收起。我方回合里随时能打开：单位菜单、选攻击目标时也行，「返回」原样回到刚才的菜单。
  // 单位行动到一半（已经移动）时不能结束回合和存档。敌方回合、动画、剧情中不能打开
  hudMenu(x: number, y: number) {
    if (this.mode === "menu" && this.ui.hudMenuOpen) { this.ui.closeMenu(); return; }
    if (this.inStartMenu) { this.ui.toast("先选择继续或新游戏"); return; }
    // 选中了还没移动的单位（单位菜单、选目的地、原地选攻击目标）：直接放开这个单位，跟按取消一样
    if (this.selected && !this.moved && (this.mode === "menu" || this.mode === "selected" || this.mode === "target" || this.mode === "allyTarget")) {
      this.pick = null;
      this.ui.hideForecast();
      this.ui.closeMenu(false);
      this.setCursor(this.selected.x, this.selected.y);
      this.deselect();
    }
    if (this.mode === "browse") { this.sfx.ui("ok"); this.openMapMenu({ x, y }); return; }
    if (this.mode === "menu" || this.mode === "target" || this.mode === "allyTarget") {
      const mode = this.mode, reachPreview = this.reachPreview, menu = this.ui.saveMenu();
      const resume = () => {
        this.setMode(mode);
        this.reachPreview = reachPreview;
        if (menu) this.ui.restoreMenu(menu);
        if (this.pick) this.focusPick();
      };
      this.ui.hideForecast();
      this.sfx.ui("ok");
      this.openMapMenu({ x, y }, resume, !!this.selected);
      return;
    }
    this.ui.toast(this.phase === "enemy" ? "敌方回合中，不能打开菜单" : "请稍等，动画结束后再打开菜单");
  }

  // at：屏幕坐标时是右上角按钮的下拉菜单，否则弹在地图光标旁边。back：返回到哪里；midAction：有单位正在行动
  private openMapMenu(at?: Point, back = () => this.setMode("browse"), midAction = false) {
    const reopen = () => this.openMapMenu(at, back, midAction);
    const items: MenuItem[] = [
      { label: "结束回合", disabled: midAction, detail: midAction ? "单位行动中" : "", run: () => this.endTurn() },
      { label: this.dangerOn ? "隐藏敌方范围" : "显示敌方范围", run: () => { this.toggleDanger(); back(); } },
      { label: "存档", disabled: midAction, detail: midAction ? "单位行动中" : "", run: () => void this.openSaveMenu(reopen) },
      { label: "读档", run: () => void this.openLoadMenu(reopen) },
      { label: "设置", detail: "按键 · 声音", run: () => { back(); this.onOpenSettings(); } },
      { label: "回到标题", run: () => this.confirmTitle(reopen) },
      { label: "返回", run: back },
    ];
    if (!at) return this.openMenu(items, this.cursor, back);
    this.reachPreview = false;
    this.setMode("menu");
    this.ui.openMenu(items, at.x, at.y, back, true);
  }

  // 回到标题画面：整页重新载入（没有待读的存档时 main.ts 会进标题画面）
  private confirmTitle(back: () => void) {
    this.openMenu([
      { label: "回到标题", hint: "没存档的进度会丢失", run: () => location.reload() },
      { label: "取消", run: back },
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
    this.syncTraits();
    this.refreshInfo();
  }

  // 底部按键提示，显示玩家当前绑定的键
  private refreshHints() {
    const k = (a: BindAction) => keyLabel(a);
    const move = `${k("up")}${k("down")}${k("left")}${k("right")}`;
    const hints: Record<Mode, [string, string][]> = {
      browse: [[k("confirm"), "选择"], [`${k("next")} / ${k("prev")}`, "切换单位"], [k("danger"), "敌方范围"], [k("menu"), "菜单"], [k("save"), "存档"], [k("load"), "读档"], [`${k("zoomIn")} / ${k("zoomOut")}`, "缩放"], [k("fast"), "快速移动"], [k("settings"), "设置"]],
      selected: [[k("confirm"), "移动到这里 / 点敌人直接攻击"], [k("cancel"), "返回菜单"], [k("danger"), "敌方范围"]],
      moving: [[`按住 ${k("fast")}`, "加速"]],
      menu: [[move, "选择"], [k("confirm"), "确定"], [k("cancel"), "返回"]],
      target: [[move, "切换目标"], [k("confirm"), "攻击"], [k("cancel"), "返回"]],
      allyTarget: [[move, "切换"], [k("confirm"), "确定"], [k("cancel"), "返回"]],
      busy: [[`按住 ${k("fast")}`, "加速"]],
      dialog: [[k("confirm"), "下一句"], [`按住 ${k("fast")}`, "快进"], [k("cancel"), "跳过这段"], [k("settings"), "设置"]],
      title: [[k("confirm"), "继续"]],
      over: [],
      notice: [[k("confirm"), "继续"]],
      status: [[`${k("left")}${k("right")} / ${k("prev")} ${k("next")}`, "切换单位"], [k("cancel"), "关闭"]],
    };
    if (this.inBattle) { this.ui.setHints([[`${k("confirm")} / ${k("cancel")}`, "跳过战斗"], [`按住 ${k("fast")}`, "加速"]]); return; }
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

// 变形台词（文本资源 0x37）：当前驾驶员「开机，到位！」（27–29：龙、欧文、路易），
// 新形态的驾驶员「盖塔N号点火！变形！」（盖塔 30–32，盖塔G 33–35）。其他机体没有专门台词
function transformLines(pilotId: number, to: number): SceneRef[] {
  const team = [8, 9, 10];
  if (!team.includes(pilotId) || !formIndexOf(to)) return [];
  const getterG = to >= 114 && to <= 125;
  const newPilot = pilotForForm(pilotId, to);
  return [
    { res: "37", index: 27 + team.indexOf(pilotId), who: pilotId },
    { res: "37", index: (getterG ? 33 : 30) + formIndexOf(to) - 1, who: newPilot },
  ];
}

function growthStats(u: Unit): GrowthStats {
  return { level: u.level, maxHp: u.maxHp, maxSp: u.maxSp, strength: u.strength, defense: u.defense, speed: u.speed };
}

function minus(a: Set<number>, b: { has(k: number): boolean }) {
  return new Set([...a].filter((k) => !b.has(k)));
}

const wait = (s: number) => new Promise<void>((r) => setTimeout(r, s * 1000));
