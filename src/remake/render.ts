// 地图渲染：地形、范围高亮、移动路线、单位、光标。用 Canvas 按整数倍放大原版像素，镜头和光标都平滑移动。
import type { Stage, Unit } from "./data.ts";
import type { Point } from "./grid.ts";
import { smoothCanvas } from "./upscale.ts";
import { settings } from "./settings.ts";
import { floatFont, tone, type Tone } from "./theme.ts";
import mapFxJson from "../../data/map-fx.json";

const TILE = 16;
export const ZOOM_LEVELS = [2, 3, 4, 5, 6];
const CAMERA_MARGIN = 3; // 光标离视野边缘少于这么多格时镜头跟过去
const CAMERA_SPEED = 14; // 镜头追赶速度（越大越快）
const CURSOR_SPEED = 30;
const HOVER_HEIGHT = 4; // 飞行演出悬停时离地几个原版像素

export interface Overlay {
  move?: Set<number>;
  attack?: Set<number>;
  danger?: Set<number>;
  path?: Point[];
  // 可以攻击 / 选择的目标格（选目标时闪烁的框）
  targets?: Point[];
  // 敌方回合：正在行动的单位（脚下亮圈）、瞄准（from 攻方显示位置 → to 目标格）
  actor?: { at: Point; enemy: boolean };
  lock?: { from: Point; to: Point };
}

interface FloatText {
  x: number;
  y: number;
  text: string;
  tone: Tone;
  t: number;
}

interface BlastPart {
  kind: "fire" | "spark" | "smoke";
  x: number; // 相对格子中心，格子为单位
  y: number;
  vx: number;
  vy: number;
  delay: number;
  life: number;
  size: number;
}

interface UnitFx {
  flash: number; // 受击闪白剩余时间
  shake: number;
  fade: number; // 击破后淡出：1 → 0
}

export interface DrawState {
  cursor: Point;
  overlay: Overlay;
  units: Unit[];
  // 正在移动的单位的显示位置（格子坐标，可以是小数）
  unitPos(unit: Unit): Point;
  // 飞行演出：离地高度 0 → 1
  unitLift(unit: Unit): number;
  // 飞行演出：引擎推力 0 → 1，移动方向（没在走时为 null）
  unitThrust(unit: Unit): number;
  unitHeading(unit: Unit): Point | null;
  // 资料可见（没交过手的敌人为 false，不画血条）
  known(unit: Unit): boolean;
  selected: Unit | null;
}

interface Sprite {
  normal: HTMLCanvasElement;
  gray: HTMLCanvasElement;
  url?: string;
}

const spriteKey = (u: Unit) => `${u.icon.sheetUrl}#${u.icon.index}`;

// 原版地图特效数据（tools/extract-map-fx.js）
type MapFxFrame = [number, number, number?, number?, number?];
export type MapFxName = "heal" | "wipe" | "comet" | "flower" | "ring" | "bolt" | "jam";
const mapFxDb = (mapFxJson as unknown as { effects: Record<string, { file: string; cels: [number, number, number, number][]; frames: MapFxFrame[]; total: number }> }).effects;
const mapFxFiles = import.meta.glob("../../assets/original/map-fx/*.png", { eager: true, import: "default", query: "?url" });
const mapFxImages = new Map<string, HTMLImageElement>();
for (const [name, fx] of Object.entries(mapFxDb)) {
  const hit = Object.entries(mapFxFiles).find(([p]) => p.endsWith(`/${fx.file}`));
  if (!hit) continue;
  const img = new Image();
  img.src = hit[1] as string;
  mapFxImages.set(name, img);
}

export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private terrain: HTMLCanvasElement | null = null;
  private terrainRaw: HTMLCanvasElement | null = null;
  // 画面设置「平滑放大」：地形和单位图标载入时用 Scale4x 放大
  private smooth = false;
  private sprites = new Map<string, Sprite>();
  private stage: Stage | null = null;
  private dpr = 1;
  private cssW = 0;
  private cssH = 0;
  zoomIndex = 1;
  private camera = { x: 0, y: 0 };
  private cameraTarget = { x: 0, y: 0 };
  private cursorDraw = { x: 0, y: 0 };
  private time = 0;
  private floats: FloatText[] = [];
  // 地图上正在播的原版特效（精神、修理），见 mapFx
  private fxPlays: { name: string; x: number; y: number; t: number; rate: number }[] = [];
  // 飞行时留下的尾烟（格子坐标）
  private smoke: { x: number; y: number; t: number }[] = [];
  // 击破爆炸：每个爆炸一组粒子（火球、火花、黑烟），格子坐标，t 秒
  private blasts: { x: number; y: number; t: number; parts: BlastPart[] }[] = [];
  private fx = new Map<Unit, UnitFx>();
  private hitstop = 0;
  // 震屏：amp 单位是原版像素，随时间按平方衰减
  private quake = { amp: 0, t: 0, dur: 0 };

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d")!;
    this.resize();
    addEventListener("resize", () => this.resize());
  }

  get zoom() {
    return ZOOM_LEVELS[this.zoomIndex];
  }

  resize() {
    this.dpr = devicePixelRatio || 1;
    this.cssW = this.canvas.clientWidth;
    this.cssH = this.canvas.clientHeight;
    this.canvas.width = Math.round(this.cssW * this.dpr);
    this.canvas.height = Math.round(this.cssH * this.dpr);
  }

  async setStage(stage: Stage) {
    this.stage = stage;
    const sheet = await loadImage(stage.terrainSheetUrl);
    const { width, height, terrain } = stage.map;
    const c = document.createElement("canvas");
    c.width = width * TILE;
    c.height = height * TILE;
    const g = c.getContext("2d")!;
    terrain.forEach((row, y) => row.forEach((t, x) => g.drawImage(sheet, t * TILE, 0, TILE, TILE, x * TILE, y * TILE, TILE, TILE)));
    this.terrainRaw = c;
    this.smooth = settings.get().artStyle === "smooth";
    // 整张地图一起放大，图块之间的边缘也能接得上
    this.terrain = this.smooth ? smoothCanvas(c) : c;
    for (const u of stage.units) await this.loadUnit(u);
    // 默认缩放：让视野里大约能看到 18 格宽
    const ideal = this.cssW / (18 * TILE);
    this.zoomIndex = ZOOM_LEVELS.reduce((best, z, i) => (Math.abs(z - ideal) < Math.abs(ZOOM_LEVELS[best] - ideal) ? i : best), 0);
  }

  // ---------- 特效 ----------
  // 原版地图特效（tools/extract-map-fx.js 从原版逐帧抠出来的精灵）：在 p 那一格按原版的帧和位置播放，
  // rate = 演出倍速。返回播完要多少秒
  //   heal 回复（星星闪烁的虚点圆圈，修理同）  wipe 加速 / 疾风  comet 瞄准 / 必杀 / 回避
  //   flower 防守  ring 强攻 / 热血（细的蓝色电圈）  bolt 怒 / 狂怒（闪电）  jam 干扰
  mapFx(name: MapFxName, p: Point, rate = 1): number {
    const fx = mapFxDb[name];
    if (!fx) return 0;
    this.fxPlays.push({ name, x: p.x, y: p.y, t: 0, rate });
    return fx.total / 60 / rate;
  }

  float(p: Point, text: string, color: Tone = "ink") {
    this.floats.push({ x: p.x, y: p.y, text, tone: color, t: 0 });
  }

  hitUnit(u: Unit) {
    const f = this.unitFx(u);
    f.flash = 0.18;
    f.shake = 0.25;
  }

  // 重击：顿帧（整个画面停住，被打的单位保持闪白）+ 之后震屏。power 0~1，返回顿帧时长（秒）
  impact(u: Unit, power: number, speed = 1): number {
    const p = Math.max(0, Math.min(1, power));
    this.hitUnit(u);
    this.hitstop = (0.05 + p * 0.08) / Math.sqrt(speed);
    this.quake = { amp: 1 + p * 3, t: 0, dur: 0.15 + p * 0.25 };
    return this.hitstop;
  }

  killUnit(u: Unit) {
    this.unitFx(u).fade = 1;
  }

  // 地图上的击破爆炸。原版回到地图后在格子上炸一下（小火光 → 白色闪爆 → 四散火花，约 50 帧，单位随之消失）；
  // 重制版加强成闪白 + 火球 + 火花 + 黑烟 + 震屏。返回演出时长（秒），之后才出经验
  explode(u: Unit): number {
    const f = this.unitFx(u);
    f.flash = 0.18;
    f.shake = 0.3;
    f.fade = 1;
    const parts: BlastPart[] = [];
    const rnd = (a: number, b: number) => a + Math.random() * (b - a);
    // 火球：中心一个大的，周围几团错开爆开
    parts.push({ kind: "fire", x: 0, y: 0, vx: 0, vy: 0, delay: 0.06, life: 0.55, size: 0.95 });
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 + rnd(-0.4, 0.4), r = rnd(0.2, 0.42);
      parts.push({ kind: "fire", x: Math.cos(a) * r, y: Math.sin(a) * r, vx: 0, vy: -0.2, delay: rnd(0.1, 0.38), life: rnd(0.35, 0.5), size: rnd(0.45, 0.7) });
    }
    // 火花：向四周飞，受重力往下落
    for (let i = 0; i < 16; i++) {
      const a = rnd(0, Math.PI * 2), v = rnd(1.4, 3);
      parts.push({ kind: "spark", x: 0, y: 0, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 1, delay: rnd(0.06, 0.14), life: rnd(0.4, 0.7), size: rnd(0.06, 0.1) });
    }
    // 黑烟：火球散了以后慢慢升起
    for (let i = 0; i < 5; i++) {
      parts.push({ kind: "smoke", x: rnd(-0.3, 0.3), y: rnd(-0.2, 0.2), vx: rnd(-0.15, 0.15), vy: rnd(-0.7, -0.4), delay: rnd(0.3, 0.55), life: rnd(0.6, 0.9), size: rnd(0.25, 0.4) });
    }
    this.blasts.push({ x: u.x, y: u.y, t: 0, parts });
    this.quake = { amp: 3, t: 0, dur: 0.4 };
    return 0.85;
  }

  private drawBlasts(s: number, dt: number) {
    const ctx = this.ctx;
    for (const b of this.blasts) {
      b.t += dt;
      const cx = (b.x + 0.5) * s, cy = (b.y + 0.5) * s;
      // 起爆闪光：白色圆形一下子撑开再消失
      const fk = (b.t - 0.06) / 0.18;
      if (fk > 0 && fk < 1) {
        ctx.fillStyle = `rgba(255, 255, 240, ${1 - fk})`;
        ctx.beginPath();
        ctx.arc(cx, cy, s * (0.3 + 0.55 * Math.sqrt(fk)), 0, Math.PI * 2);
        ctx.fill();
      }
      for (const p of b.parts) {
        const t = b.t - p.delay;
        if (t < 0 || t > p.life) continue;
        const k = t / p.life;
        const x = cx + (p.x + p.vx * t) * s, y = cy + (p.y + p.vy * t + (p.kind === "spark" ? 2.2 * t * t : 0)) * s;
        if (p.kind === "fire") {
          // 白芯 → 黄 → 橙 → 暗红，边长大边淡
          const r = s * p.size * (0.5 + 0.7 * Math.sqrt(k));
          const g = ctx.createRadialGradient(x, y, 0, x, y, r);
          const a = 1 - k * k;
          g.addColorStop(0, `rgba(255, 255, ${Math.round(230 - 200 * k)}, ${a})`);
          g.addColorStop(0.45, `rgba(255, ${Math.round(200 - 110 * k)}, 40, ${a * 0.95})`);
          g.addColorStop(1, `rgba(160, 30, 10, 0)`);
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(x, y, r, 0, Math.PI * 2);
          ctx.fill();
        } else if (p.kind === "spark") {
          // 方块火花，按缩放取整成像素点
          const px = Math.max(this.zoom, Math.round(s * p.size * (1 - k * 0.5)));
          ctx.fillStyle = k < 0.4 ? "#fff6c0" : `rgba(255, ${Math.round(190 - 120 * k)}, 40, ${1 - k})`;
          ctx.fillRect(Math.round(x - px / 2), Math.round(y - px / 2), px, px);
        } else {
          ctx.fillStyle = `rgba(40, 36, 40, ${0.55 * Math.min(1, k * 5) * (1 - k)})`;
          ctx.beginPath();
          ctx.arc(x, y, s * p.size * (0.6 + 0.8 * k), 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
    this.blasts = this.blasts.filter((b) => b.t < 1.6);
  }

  private unitFx(u: Unit) {
    let f = this.fx.get(u);
    if (!f) this.fx.set(u, (f = { flash: 0, shake: 0, fade: -1 }));
    return f;
  }

  // 载入单位图标（开局和中途出场的单位都要先载入才能画）
  private sheets = new Map<string, Promise<HTMLImageElement>>();
  async loadUnit(u: Unit) {
    const url = u.icon.sheetUrl;
    if (!this.sheets.has(url)) this.sheets.set(url, loadImage(url));
    const k = spriteKey(u);
    if (!this.sprites.has(k)) this.sprites.set(k, makeSprite(await this.sheets.get(url)!, u.icon.index, this.smooth));
  }

  // 切换画面风格：重建地形和所有单位图标
  async setArtStyle(smooth: boolean, units: Unit[]) {
    if (smooth === this.smooth || !this.terrainRaw) return;
    this.smooth = smooth;
    this.terrain = smooth ? smoothCanvas(this.terrainRaw) : this.terrainRaw;
    this.sprites.clear();
    for (const u of units) await this.loadUnit(u);
  }

  // 存档缩略图：当前画面缩小成 240 宽的 JPEG
  thumbnail(): string {
    // 画面被隐藏时画布尺寸为 0，不带截图
    if (!this.canvas.width || !this.canvas.height) return "";
    const w = 240, h = Math.round((240 * this.canvas.height) / this.canvas.width);
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    c.getContext("2d")!.drawImage(this.canvas, 0, 0, w, h);
    return c.toDataURL("image/jpeg", 0.7);
  }

  // 信息面板用的单位图标
  iconUrl(unit: Unit): string {
    const sprite = this.sprites.get(spriteKey(unit))!;
    return (sprite.url ??= sprite.normal.toDataURL());
  }

  setZoom(delta: number) {
    this.zoomIndex = Math.min(ZOOM_LEVELS.length - 1, Math.max(0, this.zoomIndex + delta));
  }

  // 屏幕坐标（CSS 像素）→ 地图格子
  screenToTile(sx: number, sy: number): Point {
    const s = TILE * this.zoom;
    return { x: Math.floor((sx + this.camera.x) / s), y: Math.floor((sy + this.camera.y) / s) };
  }

  // 地图格子 → 屏幕坐标（CSS 像素，相对页面），用镜头目标位置，菜单不会跟着镜头动画抖动
  tileToScreen(p: Point): Point {
    const s = TILE * this.zoom;
    const rect = this.canvas.getBoundingClientRect();
    return { x: rect.left + p.x * s - this.cameraTarget.x, y: rect.top + p.y * s - this.cameraTarget.y };
  }

  // 让镜头保持光标在视野内；地图比视野小时居中
  private follow(cursor: Point, snap: boolean) {
    const map = this.stage!.map;
    const s = TILE * this.zoom;
    const viewW = this.cssW, viewH = this.cssH;
    const mapW = map.width * s, mapH = map.height * s;
    const axis = (pos: number, view: number, total: number, current: number) => {
      if (total <= view) return (total - view) / 2;
      const margin = Math.min(CAMERA_MARGIN * s, view / 3);
      let t = current;
      const px = pos * s;
      if (px - t < margin) t = px - margin;
      if (px + s - t > view - margin) t = px + s - view + margin;
      return Math.min(Math.max(t, 0), total - view);
    };
    this.cameraTarget.x = axis(cursor.x, viewW, mapW, this.cameraTarget.x);
    this.cameraTarget.y = axis(cursor.y, viewH, mapH, this.cameraTarget.y);
    if (snap) Object.assign(this.camera, this.cameraTarget);
  }

  centerOn(p: Point) {
    this.cursorDraw = { ...p };
    const s = TILE * this.zoom;
    const map = this.stage!.map;
    const clamp = (v: number, view: number, total: number) => (total <= view ? (total - view) / 2 : Math.min(Math.max(v, 0), total - view));
    this.camera.x = this.cameraTarget.x = clamp(p.x * s - this.cssW / 2, this.cssW, map.width * s);
    this.camera.y = this.cameraTarget.y = clamp(p.y * s - this.cssH / 2, this.cssH, map.height * s);
  }

  draw(state: DrawState, realDt: number) {
    if (!this.stage || !this.terrain) return;
    // 顿帧期间所有动画都停住
    let dt = realDt;
    if (this.hitstop > 0) { this.hitstop -= realDt; dt = 0; }
    this.time += dt;
    this.follow(state.cursor, false);
    const ease = (speed: number) => 1 - Math.exp(-speed * dt);
    this.camera.x += (this.cameraTarget.x - this.camera.x) * ease(CAMERA_SPEED);
    this.camera.y += (this.cameraTarget.y - this.camera.y) * ease(CAMERA_SPEED);
    this.cursorDraw.x += (state.cursor.x - this.cursorDraw.x) * ease(CURSOR_SPEED);
    this.cursorDraw.y += (state.cursor.y - this.cursorDraw.y) * ease(CURSOR_SPEED);

    const ctx = this.ctx;
    const s = TILE * this.zoom;
    const map = this.stage.map;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = tone("bg");
    ctx.fillRect(0, 0, this.cssW, this.cssH);
    // 镜头位置按设备像素取整，避免图块之间出现缝隙和抖动
    let qx = 0, qy = 0;
    if (this.quake.t < this.quake.dur) {
      this.quake.t += dt;
      const k = Math.max(0, 1 - this.quake.t / this.quake.dur) ** 2 * this.quake.amp * this.zoom;
      if (dt > 0) { qx = (Math.random() * 2 - 1) * k; qy = (Math.random() * 2 - 1) * k; }
    }
    const camX = Math.round((this.camera.x + qx) * this.dpr) / this.dpr;
    const camY = Math.round((this.camera.y + qy) * this.dpr) / this.dpr;
    ctx.translate(-camX, -camY);
    ctx.drawImage(this.terrain, 0, 0, map.width * s, map.height * s);

    const cell = (k: number) => ({ x: (k % map.width) * s, y: Math.floor(k / map.width) * s });
    const fill = (cells: Set<number> | undefined, color: string) => {
      if (!cells) return;
      ctx.fillStyle = color;
      for (const k of cells) { const p = cell(k); ctx.fillRect(p.x + 1, p.y + 1, s - 2, s - 2); }
    };
    const pulse = 0.75 + 0.25 * Math.sin(this.time * 4);
    fill(state.overlay.danger, "rgba(230, 40, 60, 0.38)");
    fill(state.overlay.attack, `rgba(240, 70, 70, ${0.38 * pulse})`);
    fill(state.overlay.move, `rgba(70, 140, 255, ${0.45 * pulse})`);
    if (state.overlay.path && state.overlay.path.length > 1) this.drawPath(state.overlay.path, s);

    if (state.overlay.targets) {
      ctx.strokeStyle = `rgba(255, 90, 90, ${0.6 + 0.4 * Math.sin(this.time * 8)})`;
      ctx.lineWidth = Math.max(2, this.zoom);
      for (const t of state.overlay.targets) ctx.strokeRect(t.x * s + 2, t.y * s + 2, s - 4, s - 4);
    }

    if (state.overlay.actor) this.drawActorRing(state.overlay.actor.at, state.overlay.actor.enemy, s);

    // 离地的单位最后画，升起来的头部不会被上一格的单位和血条盖住（sort 是稳定的，其余保持原顺序）
    this.drawSmoke(s, dt);
    const order = settings.get().flight ? [...state.units].sort((a, b) => state.unitLift(a) - state.unitLift(b)) : state.units;
    for (const u of order) {
      const f = this.fx.get(u);
      if (f) {
        f.flash = Math.max(0, f.flash - dt);
        f.shake = Math.max(0, f.shake - dt);
        if (f.fade >= 0) f.fade = Math.max(0, f.fade - dt * 1.6);
      }
      if (u.hp <= 0 && (!f || f.fade <= 0)) continue;
      const pos = state.unitPos(u);
      const sprite = this.sprites.get(spriteKey(u))!;
      const shake = f && f.shake > 0 ? Math.sin(this.time * 90) * this.zoom * 1.5 : 0;
      const px = pos.x * s + shake, py = pos.y * s;
      const flight = settings.get().flight;
      const h = flight ? state.unitLift(u) : 0;
      // 原版：选中时上下跳；飞行演出：升到悬停高度，悬停时轻轻浮动
      const lift = !flight
        ? (u === state.selected ? Math.round(Math.sin(this.time * 8) * this.zoom) - this.zoom : 0)
        : -h * this.zoom * (HOVER_HEIGHT + (h >= 1 ? 0.4 * Math.sin(this.time * 2.2) : 0));
      ctx.globalAlpha = f && f.fade >= 0 ? f.fade : 1;
      if (h > 0) {
        // 脚下的影子：越高越小越淡
        ctx.fillStyle = `rgba(0,0,0,${0.4 * h * ctx.globalAlpha})`;
        ctx.beginPath();
        ctx.ellipse(px + s / 2, py + s * 0.9, s * (0.36 - 0.08 * h), s * 0.09, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      const thrust = flight ? state.unitThrust(u) : 0;
      if (thrust > 0) this.drawExhaust(px + s / 2, py + lift + s * 0.94, thrust, state.unitHeading(u), s);
      ctx.drawImage(u.acted ? sprite.gray : sprite.normal, px, py + lift, s, s);
      if (f && f.flash > 0) {
        ctx.fillStyle = `rgba(255,255,255,${f.flash / 0.18 * 0.8})`;
        ctx.fillRect(px, py + lift, s, s);
      }
      if (u.hp > 0 && state.known(u)) this.drawHpBar(u, px, py, s);
      ctx.globalAlpha = 1;
    }

    this.drawBlasts(s, dt);
    this.drawLock(state.overlay.lock, s);
    this.drawCursor(this.cursorDraw.x * s, this.cursorDraw.y * s, s);
    this.drawMapFx(s, dt);
    this.drawFloats(s, dt);
  }

  // 机体下方的喷焰：白芯 → 黄 → 橙 → 透明，长度跟推力走；移动时焰尾甩向反方向并留下尾烟
  private drawExhaust(cx: number, top: number, thrust: number, heading: Point | null, s: number) {
    const ctx = this.ctx;
    const len = s * (0.16 + 0.4 * thrust) * (0.85 + 0.15 * Math.sin(this.time * 47) + 0.08 * Math.random());
    const w = s * (0.08 + 0.06 * thrust);
    const tx = cx - (heading?.x ?? 0) * len * 0.7, ty = top + len * (1 - 0.3 * (heading?.y ?? 0));
    const g = ctx.createLinearGradient(cx, top, tx, ty);
    g.addColorStop(0, "rgba(255,255,255,0.95)");
    g.addColorStop(0.25, "rgba(255,236,120,0.9)");
    g.addColorStop(0.6, "rgba(255,140,40,0.6)");
    g.addColorStop(1, "rgba(255,80,20,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(cx - w, top);
    ctx.quadraticCurveTo(cx, top - w, cx + w, top);
    ctx.lineTo(tx, ty);
    ctx.closePath();
    ctx.fill();
    if (heading && Math.random() < 0.6) this.smoke.push({ x: tx / s, y: ty / s, t: 0 });
  }

  private drawSmoke(s: number, dt: number) {
    const ctx = this.ctx;
    for (const p of this.smoke) {
      p.t += dt;
      const k = p.t / 0.5;
      ctx.fillStyle = `rgba(200,200,210,${0.45 * (1 - k)})`;
      ctx.beginPath();
      ctx.arc(p.x * s, p.y * s, s * (0.05 + 0.12 * k), 0, Math.PI * 2);
      ctx.fill();
    }
    this.smoke = this.smoke.filter((p) => p.t < 0.5);
  }

  private drawMapFx(s: number, dt: number) {
    const ctx = this.ctx;
    const k = s / 16; // 一个原版像素
    ctx.imageSmoothingEnabled = false;
    for (const p of this.fxPlays) {
      p.t += dt;
      const fx = mapFxDb[p.name];
      const img = mapFxImages.get(p.name);
      const frame = Math.floor(p.t * 60 * p.rate);
      const key = [...fx.frames].reverse().find((f) => f[0] <= frame);
      if (!img?.complete || !key || key[2] === undefined) continue;
      const [cx, cy, cw, ch] = fx.cels[key[2]];
      ctx.drawImage(img, cx, cy, cw, ch, Math.round(p.x * s + key[3]! * k), Math.round(p.y * s + key[4]! * k), Math.round(cw * k), Math.round(ch * k));
    }
    this.fxPlays = this.fxPlays.filter((p) => p.t * 60 * p.rate < mapFxDb[p.name].total);
  }

  // 伤害、回复数字：从格子中间往上飘，1 秒后消失
  private drawFloats(s: number, dt: number) {
    const ctx = this.ctx;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const f of this.floats) {
      f.t += dt;
      // 从机体上方弹出来再慢慢升（不压在机体上），最后淡出
      const rise = Math.min(1, f.t * 6) * s * 0.15 + f.t * s * 0.12;
      ctx.globalAlpha = f.t < 0.8 ? 1 : Math.max(0, 1 - (f.t - 0.8) / 0.4);
      const { font, size, px } = floatFont(f.text, s);
      const x = Math.round(f.x * s + s / 2), y = Math.round(f.y * s - size * 0.35 - rise);
      ctx.font = font;
      // 像素描边：往 8 个方向各偏一个字体像素画黑字（同战斗画面伤害数字的 text-shadow）
      ctx.fillStyle = "#000";
      for (const [dx, dy] of [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]]) ctx.fillText(f.text, x + dx * px, y + dy * px);
      // 纯色：伤害白、其他按语气取规范里的颜色（回复 HP 绿……）
      ctx.fillStyle = f.tone === "danger" ? "#fff" : tone(f.tone);
      ctx.fillText(f.text, x, y);
    }
    ctx.globalAlpha = 1;
    this.floats = this.floats.filter((f) => f.t < 1.2);
  }

  private drawPath(path: Point[], s: number) {
    const ctx = this.ctx;
    const c = (p: Point) => [p.x * s + s / 2, p.y * s + s / 2] as const;
    ctx.lineWidth = Math.max(3, s / 6);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "rgba(255, 230, 120, 0.95)";
    ctx.beginPath();
    path.forEach((p, i) => (i ? ctx.lineTo(...c(p)) : ctx.moveTo(...c(p))));
    ctx.stroke();
    // 终点箭头
    const [ex, ey] = c(path.at(-1)!);
    const [px, py] = c(path.at(-2)!);
    const ang = Math.atan2(ey - py, ex - px);
    const h = s / 3;
    ctx.fillStyle = "rgba(255, 230, 120, 0.95)";
    ctx.beginPath();
    ctx.moveTo(ex + Math.cos(ang) * h * 0.6, ey + Math.sin(ang) * h * 0.6);
    ctx.lineTo(ex + Math.cos(ang + 2.4) * h, ey + Math.sin(ang + 2.4) * h);
    ctx.lineTo(ex + Math.cos(ang - 2.4) * h, ey + Math.sin(ang - 2.4) * h);
    ctx.fill();
  }

  private drawHpBar(u: Unit, px: number, py: number, s: number) {
    const ctx = this.ctx;
    const w = s - 2 * this.zoom, h = Math.max(2, this.zoom);
    const x = px + this.zoom, y = py + s - h - 1;
    const ratio = Math.max(0, u.hp / u.maxHp);
    ctx.fillStyle = "rgba(0, 0, 0, 0.7)";
    ctx.fillRect(x - 1, y - 1, w + 2, h + 2);
    ctx.fillStyle = tone(ratio > 0.5 ? "hp" : ratio > 0.25 ? "warn" : "danger");
    ctx.fillRect(x, y, Math.round(w * ratio), h);
  }

  // 行动中的单位：脚下一圈向外扩散的光环
  private drawActorRing(p: Point, enemy: boolean, s: number) {
    const ctx = this.ctx;
    const cx = p.x * s + s / 2, cy = p.y * s + s / 2;
    const rgb = enemy ? "255, 80, 70" : "90, 220, 140";
    ctx.fillStyle = `rgba(${rgb}, ${0.22 + 0.1 * Math.sin(this.time * 6)})`;
    ctx.fillRect(p.x * s + 1, p.y * s + 1, s - 2, s - 2);
    ctx.lineWidth = Math.max(2, this.zoom);
    for (let i = 0; i < 2; i++) {
      const k = (this.time * 1.4 + i / 2) % 1;
      ctx.strokeStyle = `rgba(${rgb}, ${(1 - k) * 0.9})`;
      ctx.beginPath();
      ctx.arc(cx, cy, s * (0.4 + 0.45 * k), 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // 瞄准：攻方到目标一条流动的虚线，目标上准星从大收紧，锁定后转动
  private lockStart = 0;
  private lockKey = "";
  private drawLock(lock: Overlay["lock"], s: number) {
    if (!lock) { this.lockKey = ""; return; }
    const k = `${lock.to.x},${lock.to.y}`;
    if (k !== this.lockKey) { this.lockKey = k; this.lockStart = this.time; }
    const age = this.time - this.lockStart;
    const ctx = this.ctx;
    const ax = lock.from.x * s + s / 2, ay = lock.from.y * s + s / 2;
    const tx = lock.to.x * s + s / 2, ty = lock.to.y * s + s / 2;
    const grow = Math.min(1, age / 0.2);
    ctx.save();
    ctx.lineWidth = Math.max(2, this.zoom);
    ctx.strokeStyle = "rgba(255, 90, 70, 0.85)";
    ctx.setLineDash([s / 5, s / 7]);
    ctx.lineDashOffset = -this.time * s;
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(ax + (tx - ax) * grow, ay + (ty - ay) * grow);
    ctx.stroke();
    ctx.setLineDash([]);
    // 准星：0.25 秒从 1.8 倍收到 1 倍，之后慢慢转
    const t = Math.min(1, age / 0.25);
    const r = s * 0.55 * (1 + 0.8 * (1 - t) ** 2);
    const locked = t >= 1;
    ctx.translate(tx, ty);
    ctx.rotate(locked ? (age - 0.25) * 1.5 : 0);
    ctx.strokeStyle = locked ? `rgba(255, 70, 60, ${0.8 + 0.2 * Math.sin(this.time * 14)})` : "rgba(255, 200, 80, 0.9)";
    ctx.lineWidth = Math.max(2, this.zoom * 1.5);
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.stroke();
    for (let i = 0; i < 4; i++) {
      ctx.rotate(Math.PI / 2);
      ctx.beginPath();
      ctx.moveTo(r * 0.55, 0);
      ctx.lineTo(r * 1.25, 0);
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawCursor(x: number, y: number, s: number) {
    const ctx = this.ctx;
    const grow = Math.sin(this.time * 6) * this.zoom * 0.6;
    const len = s / 4, w = Math.max(2, this.zoom);
    ctx.fillStyle = "#fff";
    ctx.strokeStyle = "rgba(0,0,0,0.6)";
    const corner = (cx: number, cy: number, sx: number, sy: number) => {
      ctx.fillRect(cx, cy, sx * len, sy * w);
      ctx.fillRect(cx, cy, sx * w, sy * len);
    };
    const o = -grow;
    corner(x + o, y + o, 1, 1);
    corner(x + s - o, y + o, -1, 1);
    corner(x + o, y + s - o, 1, -1);
    corner(x + s - o, y + s - o, -1, -1);
  }
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`图片加载失败：${url}`));
    img.src = url;
  });
}

// 已行动的单位显示为灰色；手动处理像素，不依赖 ctx.filter（部分浏览器不支持）
// 图标表是 16 个 16x16 图标横排，取第 index 个
function makeSprite(sheet: HTMLImageElement, index: number, smooth: boolean): Sprite {
  const normal = document.createElement("canvas");
  normal.width = normal.height = TILE;
  normal.getContext("2d")!.drawImage(sheet, index * TILE, 0, TILE, TILE, 0, 0, TILE, TILE);
  const gray = document.createElement("canvas");
  gray.width = gray.height = TILE;
  const g = gray.getContext("2d")!;
  g.drawImage(normal, 0, 0);
  const data = g.getImageData(0, 0, TILE, TILE);
  for (let i = 0; i < data.data.length; i += 4) {
    const l = (data.data[i] * 0.3 + data.data[i + 1] * 0.59 + data.data[i + 2] * 0.11) * 0.65;
    data.data[i] = data.data[i + 1] = data.data[i + 2] = l;
  }
  g.putImageData(data, 0, 0);
  return smooth ? { normal: smoothCanvas(normal), gray: smoothCanvas(gray) } : { normal, gray };
}
