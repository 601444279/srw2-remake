// 完整战斗画面：原版的机体大图和武器特效（tools/extract-battle-gfx.js 提取，tools/slim-battle-data.js 精简），
// 按原版的位置和逐帧时间播放；命中 / 落空 / 击破的反应、血条、伤害数字是重制版加的。
//
// 坐标：原版上半屏 256×116。两个名称表并排成「世界」（宽 512），镜头 = 屏幕左边缘的世界坐标。
// 近身：两台机体都在镜头 32 的同一屏；远距离：左侧机体在第 0 屏（世界 = 画面位置 + 32），
// 右侧机体在第 1 屏（+ 224），攻击动画的关键帧带着镜头平移（docs/notes-battle-gfx.md）。
import db from "../../data/battle-scene.json";
import type { Unit } from "./data.ts";
import { portraitUrl } from "./story.ts";
import { settings } from "./settings.ts";
import { smoothCanvas, smoothUrl } from "./upscale.ts";

const unitFiles = import.meta.glob("../../assets/original/battle/units/*.png", { eager: true, import: "default", query: "?url" });
const effectFiles = import.meta.glob("../../assets/original/battle/effects/*.png", { eager: true, import: "default", query: "?url" });

type Side = "left" | "right";
interface SpriteInfo { file: string; side: Side; screen: { x: number; y: number }; origin: { x: number; y: number }; w: number; h: number }
// 关键帧：开始帧、帧数、cel（-1 = 没有）、cel 相对锚点的 x、y、镜头偏移 x、y
type Keyframe = [number, number, number?, number?, number?, number?, number?];
interface Anim { file: string; layout: "close" | "ranged"; anchor: { x: number; y: number }; camera: { x: number; y: number }; cels: [number, number, number, number][]; keyframes: Keyframe[]; sounds: [number, number][] }

const data = db as unknown as {
  units: Record<string, SpriteInfo>;
  weapons: Record<string, Partial<Record<Side, Record<string, string>>>>;
  anims: Record<string, Anim>;
  explosions: Record<string, Anim>;
};

const W = 256;
const H = 116;
const SCALE = 4; // 画布内部按 4 倍画（平滑放大的图正好 1:1）
const CLOSE_CAMERA = 32;
const RANGED_OFFSET: Record<Side, number> = { left: 32, right: 224 };

const fileUrl = (files: Record<string, unknown>, name: string) => {
  const hit = Object.entries(files).find(([p]) => p.endsWith(`/${name}`));
  return hit ? (hit[1] as string) : null;
};

export function battleSpriteUrl(unitId: number): string | null {
  const info = data.units[unitId];
  return info ? fileUrl(unitFiles, info.file) : null;
}

// 这台机体用这把武器的攻击动画（原版按武器编号和机体画在哪一侧选；同一份脚本在不同机体上图可能不同）
function animFor(unitId: number, weaponId: number): Anim | null {
  const side = data.units[unitId]?.side;
  const byUnit = side ? data.weapons[weaponId]?.[side] : undefined;
  if (!byUnit) return null;
  const name = byUnit[unitId] ?? Object.values(byUnit)[0];
  return data.anims[name] ?? null;
}

// 原版这段攻击动画的音效：[第几帧, 音效号]（命中和落空一样，原版在动画之后不另放音效）
export function attackSounds(unitId: number, weaponId: number): [number, number][] | null {
  return animFor(unitId, weaponId)?.sounds ?? null;
}

// 远程武器（射程 > 1）打不到相邻格，所以战斗布局只看距离
export function battleLayout(a: { x: number; y: number }, b: { x: number; y: number }) {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y) === 1 ? "close" : "ranged";
}

// ---------- 图片 ----------
interface Art { src: CanvasImageSource; k: number } // k = 图片像素 / 原版像素
const imageCache = new Map<string, Promise<HTMLImageElement>>();
function loadImage(url: string) {
  let p = imageCache.get(url);
  if (!p) {
    p = new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = url;
    });
    imageCache.set(url, p);
  }
  return p;
}
const smoothCache = new Map<string, HTMLCanvasElement>();
async function loadArt(url: string): Promise<Art> {
  const img = await loadImage(url);
  if (settings.get().artStyle !== "smooth") return { src: img, k: 1 };
  let c = smoothCache.get(url);
  if (!c) smoothCache.set(url, (c = smoothCanvas(img)));
  return { src: c, k: 4 };
}
// 受击闪白用的剪影
function silhouette(art: Art) {
  const s = art.src as HTMLImageElement | HTMLCanvasElement;
  const c = document.createElement("canvas");
  c.width = s.width;
  c.height = s.height;
  const ctx = c.getContext("2d")!;
  ctx.drawImage(s, 0, 0);
  ctx.globalCompositeOperation = "source-in";
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, c.width, c.height);
  return c;
}

// ---------- 场景 ----------
interface Actor {
  unit: Unit;
  info: SpriteInfo | null;
  art: Art | null;
  white: HTMLCanvasElement | null;
  side: Side; // 画在哪一侧
  flip: boolean; // 原生在另一侧（两台同侧时）就镜像
  x: number; // 世界坐标（图左上角）
  y: number;
  w: number;
  h: number;
  dx: number; // 受击 / 闪避的临时偏移
  dy: number;
  flash: number; // 闪白剩余秒数
  alpha: number;
  hp: number;
}

interface Effect { art: Art; cel: [number, number, number, number]; x: number; y: number; flip: boolean }
interface Puff { anim: Anim; art: Art; x: number; y: number; t: number }

const $ = <T extends HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;

export class BattleScene {
  private root = $("#battle-scene");
  private canvas!: HTMLCanvasElement;
  private ctx!: CanvasRenderingContext2D;
  private actors: Actor[] = [];
  private layout: "close" | "ranged" = "close";
  private camera = { x: CLOSE_CAMERA, y: 0 };
  private effect: Effect | null = null;
  private puffs: Puff[] = [];
  private raf = 0;
  private slow = 1; // 慢镜头时的时间倍率（只影响爆炸）
  private last = 0;
  private speed: () => number;
  private skipped: () => boolean;
  private onSkip: () => void;
  private sound: (id: number) => void;

  // skipped：玩家按了跳过（立即隐藏、动画不再播放）；onSkip：点击画面请求跳过；sound：放原版音效
  constructor(speed: () => number, skipped: () => boolean, onSkip: () => void, sound: (id: number) => void) {
    this.speed = speed;
    this.skipped = skipped;
    this.onSkip = onSkip;
    this.sound = sound;
  }

  // 攻方画在它原生的那一侧，守方画在另一侧
  async open(attacker: Unit, defender: Unit, layout: "close" | "ranged") {
    this.layout = layout;
    const atkSide = data.units[attacker.unitId]?.side ?? "right";
    const sides: [Unit, Side][] = [[attacker, atkSide], [defender, atkSide === "right" ? "left" : "right"]];
    this.actors = await Promise.all(sides.map(([u, side]) => this.makeActor(u, side)));
    this.camera = { x: layout === "close" ? CLOSE_CAMERA : atkSide === "right" ? 256 : 0, y: 0 };
    this.effect = null;
    this.puffs = [];

    this.root.innerHTML = `
      <div class="bs-frame">
        <div class="bs-stage"><canvas width="${W * SCALE}" height="${H * SCALE}"></canvas><div class="bs-spot"></div><div class="bs-pops"></div></div>
        <div class="bs-hud">
          ${this.actorsBySide().map((a) => this.card(a)).join("")}
        </div>
        <div class="bs-msg"><div class="bs-face"></div><div class="bs-text"></div></div>
      </div>`;
    this.canvas = $("canvas", this.root);
    this.ctx = this.canvas.getContext("2d")!;
    this.ctx.imageSmoothingEnabled = false;
    this.root.hidden = this.skipped();
    this.root.classList.remove("out");
    this.root.onclick = () => this.onSkip();
    this.root.oncontextmenu = (e) => { e.preventDefault(); this.onSkip(); };
    this.last = performance.now();
    const loop = (now: number) => {
      if (this.skipped()) this.root.hidden = true;
      this.tick(Math.min(0.1, (now - this.last) / 1000));
      this.last = now;
      this.draw();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  async close() {
    this.root.classList.add("out");
    if (!this.skipped()) await wait(0.2);
    cancelAnimationFrame(this.raf);
    this.root.hidden = true;
    this.root.innerHTML = "";
    this.actors = [];
  }

  private async makeActor(unit: Unit, side: Side): Promise<Actor> {
    const info = data.units[unit.unitId] ?? null;
    const url = info && fileUrl(unitFiles, info.file);
    const art = url ? await loadArt(url) : null;
    const flip = !!info && info.side !== side;
    const w = info?.w ?? 48;
    const h = info?.h ?? 48;
    // 原版画面位置；镜像时左右对调
    let sx = info?.screen.x ?? (side === "right" ? 168 : 40);
    const sy = info?.screen.y ?? 112 - h;
    if (flip) sx = W - sx - w;
    const off = this.layout === "close" ? CLOSE_CAMERA : RANGED_OFFSET[side];
    return { unit, info, art, white: art && silhouette(art), side, flip, x: sx + off, y: sy, w, h, dx: 0, dy: 0, flash: 0, alpha: 1, hp: unit.hp };
  }

  private actorsBySide() {
    return [...this.actors].sort((a, b) => (a.side === "left" ? 0 : 1) - (b.side === "left" ? 0 : 1));
  }

  private actor(u: Unit) {
    return this.actors.find((a) => a.unit === u)!;
  }

  private card(a: Actor) {
    const u = a.unit;
    return `
      <div class="bs-card ${a.side} ${u.side}" data-unit="${u.id}">
        <div class="bs-name"><b>${u.name}</b>${u.pilotName ? `<small>${u.pilotName}</small>` : ""}</div>
        <div class="bs-hp"><div class="bar"><i style="width:${(u.hp / u.maxHp) * 100}%"></i></div><span>${u.hp} / ${u.maxHp}</span></div>
        <div class="bs-weapon"></div>
      </div>`;
  }

  // 消息窗口：说话的驾驶员头像 + 台词
  say(u: Unit, text: string | null) {
    if (!text) return;
    const face = u.pilotName ? portraitUrl(u.pilotId) : null;
    const faceEl = $(".bs-face", this.root);
    faceEl.innerHTML = face ? `<img src="${face}" alt="">` : `<span>${(u.pilotName || u.name).slice(0, 1)}</span>`;
    if (face && settings.get().artStyle === "smooth") {
      void smoothUrl(face).then((s) => { const img = faceEl.querySelector("img"); if (img?.getAttribute("src") === face) img.src = s; });
    }
    const t = $(".bs-text", this.root);
    t.innerHTML = `<b class="${u.side}">${u.pilotName || u.name}</b>${text}`;
    t.classList.remove("show");
    void t.offsetWidth;
    t.classList.add("show");
  }

  weapon(u: Unit, name: string) {
    this.root.querySelectorAll(".bs-weapon").forEach((e) => (e.textContent = ""));
    const el = this.root.querySelector(`[data-unit="${u.id}"] .bs-weapon`);
    if (el) el.textContent = name;
  }

  // 播一段攻击动画（原版逐帧时间；末尾的空等截短）
  async attack(u: Unit, weaponId: number) {
    const a = this.actor(u);
    const anim = animFor(u.unitId, weaponId);
    const url = anim && fileUrl(effectFiles, anim.file);
    if (this.skipped()) return;
    if (!anim || !url || !a.info) { await wait(0.4 / this.speed()); return; }
    const art = await loadArt(url);
    // 锚点 = 攻方叠色精灵的位置；镜像的机体锚点也镜像
    const ax = a.flip ? a.x + a.w - a.info.origin.x : a.x + a.info.origin.x;
    const ay = a.y + a.info.origin.y;
    const camStart = this.layout === "close" ? CLOSE_CAMERA : a.side === "right" ? 256 : 0;
    const kfs = anim.keyframes;
    const lastCel = kfs.reduce((end, k) => ((k[2] ?? -1) >= 0 ? k[0] + k[1] : end), 0);
    const lastSound = anim.sounds.at(-1)?.[0] ?? 0;
    const end = Math.min(kfs.at(-1)![0] + kfs.at(-1)![1], Math.max(lastCel + 14, lastSound + 10));
    let frame = 0;
    await new Promise<void>((resolve) => {
      const step = () => {
        // 音效和画面同一帧计数，跟着动画走
        for (const [f, id] of anim.sounds) if (f === frame) this.sound(id);
        const k = [...kfs].reverse().find((f) => f[0] <= frame) ?? kfs[0];
        const [, , cel = -1, x = 0, y = 0, cx = 0, cy = 0] = k;
        const mx = a.flip ? -cx : cx;
        this.camera = { x: camStart + mx, y: cy };
        this.effect = cel >= 0
          ? { art, cel: anim.cels[cel], x: a.flip ? ax - x - anim.cels[cel][2] : ax + x, y: ay + y, flip: a.flip }
          : null;
        if (frame >= end || this.skipped()) { this.effect = null; resolve(); return; }
        frame += 1;
        setTimeout(step, 1000 / 60 / this.speed());
      };
      step();
    });
  }

  // 命中：闪白、震动、伤害数字，血条减少（重制版加的反应；原版只有文字）
  hit(u: Unit, damage: number, hpAfter: number, power: number) {
    const a = this.actor(u);
    a.flash = 0.12;
    this.shake(a, 2 + power * 4);
    this.pop(a, `-${damage}`, "hit");
    this.setHp(a, hpAfter);
  }

  miss(u: Unit) {
    const a = this.actor(u);
    const dir = a.side === "left" ? -1 : 1;
    void tween(0.32 / this.speed(), (t) => { a.dx = dir * 10 * Math.sin(Math.PI * t); });
    this.pop(a, "MISS", "miss");
  }

  // 击破：慢镜头。闪白、镜头推近被击破的机体，原版的爆炸一团接一团放慢炸开，机体闪烁消失，最后一声大爆炸恢复正常速度
  async explode(u: Unit, boom: () => void) {
    const a = this.actor(u);
    const anim = data.explosions[`explode-${a.side}`];
    const url = anim && fileUrl(effectFiles, anim.file);
    const art = url ? await loadArt(url) : null;
    if (this.skipped()) { a.alpha = 0; return; }
    const stage = $(".bs-stage", this.root);
    stage.style.setProperty("--fx", `${((a.x - this.camera.x + a.w / 2) / W) * 100}%`);
    stage.style.setProperty("--fy", `${((a.y + a.h / 2) / H) * 100}%`);
    stage.classList.add("slowmo");
    this.slow = 0.4;
    boom();
    for (let i = 0; i < 10 && art; i++) {
      this.puffs.push({ anim, art, x: a.x + a.w * (0.1 + Math.random() * 0.8), y: a.y + a.h * (0.15 + Math.random() * 0.75), t: -i * 0.07 });
    }
    a.flash = 0.25;
    this.shake(a, 6);
    await wait(0.9 / this.speed());
    await tween(0.6 / this.speed(), (t) => { a.alpha = 1 - t; });
    // 最后一下：大爆炸，速度恢复
    this.slow = 1;
    stage.classList.remove("slowmo");
    stage.classList.add("blast");
    boom();
    for (let i = 0; i < 4 && art; i++) this.puffs.push({ anim, art, x: a.x + a.w * (0.3 + Math.random() * 0.4), y: a.y + a.h * (0.3 + Math.random() * 0.4), t: -i * 0.03 });
    await wait(0.5 / this.speed());
    stage.classList.remove("blast");
  }

  private shake(a: Actor, px: number) {
    void tween(0.3 / this.speed(), (t) => { a.dx = Math.round(Math.sin(t * 40) * px * (1 - t)); });
  }

  private setHp(a: Actor, hp: number) {
    a.hp = hp;
    const card = this.root.querySelector(`[data-unit="${a.unit.id}"]`);
    if (!card) return;
    (card.querySelector(".bs-hp i") as HTMLElement).style.width = `${(hp / a.unit.maxHp) * 100}%`;
    card.querySelector(".bs-hp span")!.textContent = `${hp} / ${a.unit.maxHp}`;
  }

  private pop(a: Actor, text: string, cls: string) {
    const el = document.createElement("div");
    el.className = `bs-pop ${cls}`;
    el.textContent = text;
    el.style.left = `${((a.x - this.camera.x + a.w / 2) / W) * 100}%`;
    el.style.top = `${((a.y + a.h * 0.3) / H) * 100}%`;
    $(".bs-pops", this.root).append(el);
    setTimeout(() => el.remove(), 1200);
  }

  private tick(dt: number) {
    const s = dt * this.speed();
    for (const a of this.actors) a.flash = Math.max(0, a.flash - s);
    for (const p of this.puffs) p.t += s * this.slow;
    this.puffs = this.puffs.filter((p) => p.t * 60 < p.anim.keyframes.at(-1)![0] + p.anim.keyframes.at(-1)![1]);
  }

  private draw() {
    const { ctx } = this;
    ctx.clearRect(0, 0, W * SCALE, H * SCALE);
    for (const a of this.actors) {
      if (!a.art || a.alpha <= 0) continue;
      const x = a.x + a.dx - this.camera.x;
      const y = a.y + a.dy - this.camera.y;
      if (x > W || x + a.w < 0) continue;
      ctx.globalAlpha = a.alpha;
      // 被击破时闪烁
      if (a.alpha < 1 && Math.floor(a.alpha * 12) % 2) continue;
      this.blit(a.flash > 0 && a.white ? { src: a.white, k: a.art.k } : a.art, 0, 0, a.w, a.h, x, y, a.flip);
      ctx.globalAlpha = 1;
    }
    ctx.globalAlpha = 1;
    if (this.effect) {
      const { art, cel, x, y, flip } = this.effect;
      this.blit(art, cel[0], cel[1], cel[2], cel[3], x - this.camera.x, y - this.camera.y, flip);
    }
    for (const p of this.puffs) {
      if (p.t < 0) continue;
      const frame = p.t * 60;
      const k = [...p.anim.keyframes].reverse().find((f) => f[0] <= frame);
      const cel = k?.[2] ?? -1;
      if (cel < 0) continue;
      const [cx, cy, cw, ch] = p.anim.cels[cel];
      this.blit(p.art, cx, cy, cw, ch, p.x - cw / 2 - this.camera.x, p.y - ch / 2 - this.camera.y, false);
    }
  }

  // 按原版像素坐标画图的一块（sx…sh 是原版像素）
  private blit(art: Art, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, flip: boolean) {
    const { ctx } = this;
    const k = art.k;
    const X = Math.round(dx * SCALE), Y = Math.round(dy * SCALE);
    if (!flip) {
      ctx.drawImage(art.src, sx * k, sy * k, sw * k, sh * k, X, Y, sw * SCALE, sh * SCALE);
      return;
    }
    ctx.save();
    ctx.translate(X + sw * SCALE, Y);
    ctx.scale(-1, 1);
    ctx.drawImage(art.src, sx * k, sy * k, sw * k, sh * k, 0, 0, sw * SCALE, sh * SCALE);
    ctx.restore();
  }
}

const wait = (s: number) => new Promise<void>((r) => setTimeout(r, s * 1000));

// 用计时器而不是 requestAnimationFrame：页面在后台时也能走完（自动测试）
function tween(seconds: number, f: (t: number) => void) {
  return new Promise<void>((resolve) => {
    const t0 = performance.now();
    const step = () => {
      const t = Math.min(1, (performance.now() - t0) / 1000 / seconds);
      f(t);
      if (t < 1) setTimeout(step, 16);
      else resolve();
    };
    step();
  });
}
