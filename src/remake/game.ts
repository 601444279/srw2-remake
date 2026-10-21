// 游戏流程（P1）：浏览地图、选择单位、显示范围和路线、移动、待机、结束回合。
// 攻击、精神指令、敌方行动在 P2 加入。
import { defenseBonus, type Stage, type Unit } from "./data.ts";
import { key, pathTo, rangeFrom, reachable, inBounds, MOVE_TYPE_ROW, type Point, type Reach } from "./grid.ts";
import type { Action } from "./input.ts";
import type { DrawState, Overlay, Renderer } from "./render.ts";
import type { UI, MenuItem } from "./ui.ts";

type Mode = "browse" | "selected" | "moving" | "menu" | "busy";

const MOVE_TILES_PER_SEC = 14;
// 武器射程还没提取，敌方威胁范围暂时按射程 1 计算
const PLACEHOLDER_RANGE = 1;

interface MoveAnim {
  unit: Unit;
  path: Point[];
  t: number;
}

export class Game implements DrawState {
  cursor: Point = { x: 0, y: 0 };
  selected: Unit | null = null;
  units: Unit[];
  private mode: Mode = "busy";
  private reach: Reach | null = null;
  private origin: Point | null = null;
  private anim: MoveAnim | null = null;
  private dangerOn = false;
  // 敌方威胁范围只在单位位置变化时重算
  private dangerCache: Set<number> | null = null;
  private inspected: Unit | null = null;
  private turn = 1;

  constructor(private stage: Stage, private renderer: Renderer, private ui: UI) {
    this.units = stage.units;
  }

  async start() {
    const first = this.players().find((u) => !u.acted) ?? this.units[0];
    this.cursor = { x: first.x, y: first.y };
    this.renderer.centerOn(this.cursor);
    this.ui.setObjective("胜利条件：击破所有敌人（暂定）");
    this.ui.setTurn(this.turn, "player");
    this.refreshInfo();
    this.refreshHints();
    await this.ui.banner(`第 ${this.turn} 回合`, "我方回合", "player");
    this.mode = "browse";
    this.refreshHints();
  }

  // ---------- 绘制需要的状态 ----------
  get overlay(): Overlay {
    const o: Overlay = {};
    if (this.dangerOn) o.danger = this.dangerCache ??= this.dangerZone(this.enemies());
    if (this.inspected) {
      const r = this.unitReach(this.inspected);
      o.move = r.stops;
      o.attack = minus(rangeFrom(this.stage.map, r.stops, 1, PLACEHOLDER_RANGE), r.stops);
    }
    if (this.selected && this.reach && (this.mode === "selected" || this.mode === "moving")) {
      o.move = this.reach.stops;
      o.attack = minus(rangeFrom(this.stage.map, this.reach.stops, 1, PLACEHOLDER_RANGE), this.reach.cost);
      if (this.mode === "selected" && this.reach.stops.has(key(this.stage.map, this.cursor.x, this.cursor.y))) {
        o.path = pathTo(this.stage.map, this.reach, this.cursor);
      }
    }
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
    if (!this.anim) return;
    this.anim.t += dt * MOVE_TILES_PER_SEC;
    if (this.anim.t >= this.anim.path.length - 1) {
      const { unit, path } = this.anim;
      const end = path.at(-1)!;
      unit.x = end.x;
      unit.y = end.y;
      this.anim = null;
      this.dangerCache = null;
      this.openActionMenu(unit);
    }
  }

  // ---------- 输入 ----------
  move(dx: number, dy: number) {
    if (this.mode === "menu") { this.ui.menuMove(dy || dx); return; }
    if (this.mode !== "browse" && this.mode !== "selected") return;
    this.setCursor(this.cursor.x + dx, this.cursor.y + dy);
  }

  pointerTile(p: Point) {
    if (this.mode !== "browse" && this.mode !== "selected") return;
    if (p.x !== this.cursor.x || p.y !== this.cursor.y) this.setCursor(p.x, p.y);
  }

  pointerClick(p: Point, button: number) {
    if (this.mode === "menu") { if (button === 2) this.action("cancel"); return; }
    if (button === 2) { this.action("cancel"); return; }
    if (!inBounds(this.stage.map, p.x, p.y)) return;
    this.setCursor(p.x, p.y);
    this.action("confirm");
  }

  action(a: Action) {
    if (a === "zoomIn" || a === "zoomOut") { this.renderer.setZoom(a === "zoomIn" ? 1 : -1); return; }
    if (this.mode === "menu") {
      if (a === "confirm") this.ui.menuConfirm();
      if (a === "cancel") this.ui.closeMenu();
      return;
    }
    if (this.mode === "browse") return this.browseAction(a);
    if (this.mode === "selected") return this.selectedAction(a);
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
        this.dangerOn = !this.dangerOn;
        this.ui.toast(this.dangerOn ? "显示敌方威胁范围" : "隐藏敌方威胁范围");
        return;
      case "menu":
        return this.openMapMenu();
    }
  }

  private selectedAction(a: Action) {
    const unit = this.selected!;
    switch (a) {
      case "confirm": {
        const k = key(this.stage.map, this.cursor.x, this.cursor.y);
        if (this.cursor.x === unit.x && this.cursor.y === unit.y) return this.openActionMenu(unit);
        if (!this.reach!.stops.has(k)) { this.ui.toast("无法移动到这里"); return; }
        this.origin = { x: unit.x, y: unit.y };
        this.anim = { unit, path: pathTo(this.stage.map, this.reach!, this.cursor), t: 0 };
        this.mode = "moving";
        this.refreshHints();
        return;
      }
      case "cancel":
        this.setCursor(unit.x, unit.y);
        this.deselect();
        return;
      case "danger":
        this.dangerOn = !this.dangerOn;
        return;
    }
  }

  // ---------- 流程 ----------
  private select(unit: Unit) {
    this.inspected = null;
    this.selected = unit;
    this.origin = null;
    this.reach = this.unitReach(unit);
    this.mode = "selected";
    this.refreshHints();
  }

  private deselect() {
    this.selected = null;
    this.reach = null;
    this.origin = null;
    this.mode = "browse";
    this.refreshInfo();
    this.refreshHints();
  }

  private openActionMenu(unit: Unit) {
    this.mode = "menu";
    this.setCursor(unit.x, unit.y, false);
    const items: MenuItem[] = [
      { label: "攻击", hint: "P2", disabled: true, run: () => {} },
      { label: "精神", hint: "P2", disabled: true, run: () => {} },
      { label: "待机", run: () => this.wait(unit) },
    ];
    const anchor = this.tileToScreen(unit);
    this.ui.openMenu(items, anchor.x, anchor.y, () => this.undoMove(unit));
    this.refreshHints();
  }

  // 菜单里取消：回到移动前的位置，重新选择移动目标
  private undoMove(unit: Unit) {
    if (this.origin) { unit.x = this.origin.x; unit.y = this.origin.y; this.dangerCache = null; }
    this.origin = null;
    this.select(unit);
    this.setCursor(unit.x, unit.y);
  }

  private wait(unit: Unit) {
    unit.acted = true;
    this.deselect();
    const next = this.players().find((u) => !u.acted);
    if (next) { this.setCursor(next.x, next.y); return; }
    this.endTurn();
  }

  private openMapMenu() {
    this.mode = "menu";
    const anchor = this.tileToScreen(this.cursor);
    this.ui.openMenu([
      { label: "结束回合", run: () => this.endTurn() },
      { label: this.dangerOn ? "隐藏敌方范围" : "显示敌方范围", run: () => { this.dangerOn = !this.dangerOn; this.mode = "browse"; this.refreshHints(); } },
      { label: "返回", run: () => { this.mode = "browse"; this.refreshHints(); } },
    ], anchor.x, anchor.y, () => { this.mode = "browse"; this.refreshHints(); });
    this.refreshHints();
  }

  private async endTurn() {
    this.mode = "busy";
    this.deselect();
    this.mode = "busy";
    this.refreshHints();
    this.ui.setTurn(this.turn, "enemy");
    await this.ui.banner("敌方回合", "敌方行动将在 P2 加入", "enemy");
    this.turn++;
    for (const u of this.players()) u.acted = false;
    this.ui.setTurn(this.turn, "player");
    const first = this.players()[0];
    this.setCursor(first.x, first.y);
    await this.ui.banner(`第 ${this.turn} 回合`, "我方回合", "player");
    this.mode = "browse";
    this.refreshHints();
  }

  private cycleUnit(dir: number) {
    const list = this.players().filter((u) => !u.acted);
    if (!list.length) return;
    const current = list.findIndex((u) => u.x === this.cursor.x && u.y === this.cursor.y);
    const next = list[(current + dir + list.length) % list.length];
    this.setCursor(next.x, next.y);
  }

  // ---------- 辅助 ----------
  private setCursor(x: number, y: number, refresh = true) {
    const map = this.stage.map;
    this.cursor = { x: Math.min(map.width - 1, Math.max(0, x)), y: Math.min(map.height - 1, Math.max(0, y)) };
    if (refresh) this.refreshInfo();
  }

  private refreshInfo() {
    const unit = this.unitAt(this.cursor) ?? (this.mode === "selected" ? this.selected : null);
    const t = this.stage.map.terrain[this.cursor.y][this.cursor.x];
    const labels = { air: "空", land: "陆", sea: "海" } as const;
    this.ui.showInfo(unit ?? null, {
      name: this.stage.terrainNames[t],
      defense: defenseBonus(this.stage.terrainEffect[t]),
      costs: (Object.keys(labels) as (keyof typeof labels)[]).map((m) => ({ label: labels[m], cost: this.stage.map.moveCost[MOVE_TYPE_ROW[m]][t] })),
    });
  }

  private refreshHints() {
    const hints: Record<Mode, [string, string][]> = {
      browse: [["X", "选择"], ["E / Q", "切换单位"], ["R", "敌方范围"], ["M", "菜单"], ["+ / −", "缩放"], ["Shift", "快速移动"]],
      selected: [["X", "移动到这里"], ["Z", "取消"], ["R", "敌方范围"]],
      moving: [],
      menu: [["↑↓", "选择"], ["X", "确定"], ["Z", "返回"]],
      busy: [],
    };
    this.ui.setHints(hints[this.mode]);
  }

  // 菜单放在格子右侧
  private tileToScreen(p: Point) {
    const s = 16 * this.renderer.zoom;
    const pos = this.renderer.tileToScreen(p);
    return { x: pos.x + s * 1.2, y: pos.y };
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
    return reachable(this.stage.map, unit, unit.move, unit.moveType, unit.side, this.units.filter((u) => u !== unit && u.hp > 0));
  }

  private dangerZone(units: Unit[]) {
    const out = new Set<number>();
    for (const u of units) {
      const r = this.unitReach(u);
      for (const k of rangeFrom(this.stage.map, r.stops, 1, PLACEHOLDER_RANGE)) out.add(k);
    }
    return out;
  }
}

function minus(a: Set<number>, b: { has(k: number): boolean }) {
  return new Set([...a].filter((k) => !b.has(k)));
}
