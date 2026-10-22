// 地图渲染：地形、范围高亮、移动路线、单位、光标。用 Canvas 按整数倍放大原版像素，镜头和光标都平滑移动。
import type { Stage, Unit } from "./data.ts";
import type { Point } from "./grid.ts";
import { smoothCanvas } from "./upscale.ts";
import { settings } from "./settings.ts";

const TILE = 16;
export const ZOOM_LEVELS = [2, 3, 4, 5, 6];
const CAMERA_MARGIN = 3; // 光标离视野边缘少于这么多格时镜头跟过去
const CAMERA_SPEED = 14; // 镜头追赶速度（越大越快）
const CURSOR_SPEED = 30;

export interface Overlay {
  move?: Set<number>;
  attack?: Set<number>;
  danger?: Set<number>;
  path?: Point[];
  // 可以攻击 / 选择的目标格（选目标时闪烁的框）
  targets?: Point[];
}

interface FloatText {
  x: number;
  y: number;
  text: string;
  color: string;
  t: number;
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
  selected: Unit | null;
}

interface Sprite {
  normal: HTMLCanvasElement;
  gray: HTMLCanvasElement;
  url?: string;
}

const spriteKey = (u: Unit) => `${u.icon.sheetUrl}#${u.icon.index}`;

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
  float(p: Point, text: string, color = "#fff") {
    this.floats.push({ x: p.x, y: p.y, text, color, t: 0 });
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
    ctx.fillStyle = "#0b0b10";
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

    for (const u of state.units) {
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
      const lift = u === state.selected ? Math.round(Math.sin(this.time * 8) * this.zoom) - this.zoom : 0;
      ctx.globalAlpha = f && f.fade >= 0 ? f.fade : 1;
      ctx.drawImage(u.acted ? sprite.gray : sprite.normal, px, py + lift, s, s);
      if (f && f.flash > 0) {
        ctx.fillStyle = `rgba(255,255,255,${f.flash / 0.18 * 0.8})`;
        ctx.fillRect(px, py + lift, s, s);
      }
      if (u.hp > 0) this.drawHpBar(u, px, py, s);
      ctx.globalAlpha = 1;
    }

    this.drawCursor(this.cursorDraw.x * s, this.cursorDraw.y * s, s);
    this.drawFloats(s, dt);
  }

  // 伤害、回复数字：从格子中间往上飘，1 秒后消失
  private drawFloats(s: number, dt: number) {
    const ctx = this.ctx;
    const size = Math.max(14, s * 0.42);
    ctx.font = `800 ${size}px "PingFang SC", "Microsoft YaHei", sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineWidth = Math.max(3, size / 5);
    ctx.strokeStyle = "rgba(0,0,0,0.85)";
    for (const f of this.floats) {
      f.t += dt;
      const rise = Math.min(1, f.t * 3) * s * 0.5 + f.t * s * 0.15;
      ctx.globalAlpha = f.t < 0.8 ? 1 : Math.max(0, 1 - (f.t - 0.8) / 0.4);
      const x = f.x * s + s / 2, y = f.y * s + s / 2 - rise;
      ctx.strokeText(f.text, x, y);
      ctx.fillStyle = f.color;
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
    ctx.fillStyle = ratio > 0.5 ? "#4cd964" : ratio > 0.25 ? "#ffcc00" : "#ff3b30";
    ctx.fillRect(x, y, Math.round(w * ratio), h);
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
