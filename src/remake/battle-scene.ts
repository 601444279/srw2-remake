// 完整战斗画面：原版的机体大图和武器特效（tools/extract-battle-gfx.js 提取，tools/slim-battle-data.js 精简），
// 按原版的位置和逐帧时间播放；命中 / 落空 / 击破的反应、血条、伤害数字是重制版加的。
//
// 坐标：原版上半屏 256×116。两个名称表并排成「世界」（宽 512），镜头 = 屏幕左边缘的世界坐标。
// 近身：两台机体都在镜头 32 的同一屏；远距离：左侧机体在第 0 屏（世界 = 画面位置 + 32），
// 右侧机体在第 1 屏（+ 224），攻击动画的关键帧带着镜头平移（docs/notes-battle-gfx.md）。
import db from "../../data/battle-scene.json";
import type { Unit, Weapon } from "./data.ts";
import type { Strike } from "./rules.ts";
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
const WORLD = 512; // 两个名称表并排的宽度
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

// 原版用作命中声的音效：弹道 03、炸开 0C、砍击 0E、离子剑 06
const IMPACT_SOUNDS = new Set([0x03, 0x0c, 0x0e, 0x06]);

// 一次攻击的时间线（帧，60 帧 = 1 秒），完整战斗画面和地图上的简略面板共用。
// 原版：音效全在攻击动画里按帧触发，命中和落空的动画一模一样，判定在动画播完之后，只出文字。
// 原版的命中声就落在特效打到守方的那一帧（和按特效位置算出来的到达帧只差几帧），
// 所以重制版的受击反应（闪白、震屏、伤害数字或 MISS）放在第一个命中声那一帧，而不是动画播完之后；
// 后面的命中声（连续爆炸、导弹多发）每声再小震一下。音效一律按原版帧号放，不挪不删。
// 没有命中声的动画（左轮、机枪、连续射线），取「第一声开火」和「特效飞到最远」里晚的那帧，之后每声开火小震一下，打中时可补一声 03（extraHit）。
export interface AttackTimeline {
  sounds: [number, number][]; // [帧, 音效号]
  impacts: number[]; // 受击反应的帧（第一个是正式的一击）
  extraHit: boolean; // 动画里没有命中声
  end: number; // 动画画到哪一帧（末尾的空等截短）
}

export function attackTimeline(unitId: number, weaponId: number): AttackTimeline | null {
  const anim = animFor(unitId, weaponId);
  if (!anim) return null;
  const hits = anim.sounds.filter(([, id]) => IMPACT_SOUNDS.has(id)).map(([f]) => f);
  const side = data.units[unitId]?.side ?? "right";
  // 没有命中声：第一击在开火和特效到达之后；之后每一声开火（机枪连射）再小震一下
  const first = Math.max(anim.sounds[0]?.[0] ?? 0, reachFrame(anim, side));
  const impacts = hits.length ? hits : [first, ...anim.sounds.map(([f]) => f).filter((f) => f > first)];
  return { sounds: anim.sounds, impacts, extraHit: !hits.length, end: Math.max(animEnd(anim), impacts[0] + 1) };
}

// 特效前沿第一次到达最远处（朝守方方向，最远距离的 90%）的帧；右侧的特效往左飞
function reachFrame(anim: Anim, side: Side): number {
  const fronts = anim.keyframes.filter((k) => (k[2] ?? -1) >= 0)
    .map(([f, , cel = 0, x = 0]) => ({ f, d: side === "right" ? -x : x + anim.cels[cel][2] }));
  if (!fronts.length) return 0;
  const max = Math.max(...fronts.map((p) => p.d));
  return fronts.find((p) => p.d >= max * 0.9)!.f;
}

// 动画画到哪一帧：特效画完再留 14 帧，最后一声音效后留 10 帧（原版末尾常有很长的空等）
function animEnd(anim: Anim): number {
  const kfs = anim.keyframes;
  const lastCel = kfs.reduce((end, k) => ((k[2] ?? -1) >= 0 ? k[0] + k[1] : end), 0);
  const lastSound = anim.sounds.at(-1)?.[0] ?? 0;
  return Math.min(kfs.at(-1)![0] + kfs.at(-1)![1], Math.max(lastCel + 14, lastSound + 10));
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
        <div class="bs-name"><b>${u.name}</b></div>
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

  // 开场就把双方这一战用的武器和命中率写上（驾驶员名字不写，下方台词框里有）
  arms(atk: Unit, atkWeapon: Weapon, atkStrike: Strike, def: Unit, defWeapon: Weapon | null, defStrike: Strike) {
    const fill = (u: Unit, w: Weapon | null, s: Strike) => {
      const el = this.root.querySelector(`[data-unit="${u.id}"] .bs-weapon`);
      if (!el) return;
      el.innerHTML = w && s.valid ? `<span>${w.name}</span><em>命中 <b>${s.hit}</b>%</em>` : `<span class="none">不能反击</span>`;
    };
    fill(atk, atkWeapon, atkStrike);
    fill(def, defWeapon, defStrike);
  }

  // 出手的一方武器栏亮起，另一方变暗
  weapon(u: Unit, name: string) {
    this.root.querySelectorAll(".bs-weapon").forEach((e) => e.classList.remove("active"));
    const el = this.root.querySelector(`[data-unit="${u.id}"] .bs-weapon`);
    if (!el) return;
    if (!el.textContent) el.innerHTML = `<span>${name}</span>`;
    el.classList.add("active");
  }

  // 播一段攻击动画（原版逐帧时间，见 attackTimeline）。onImpact(i) 在第 i 个受击帧调用；
  // 没有动画、或者中途跳过时，保证第 0 个一定会调用（伤害要结算）
  async attack(u: Unit, weaponId: number, onImpact: (i: number) => void) {
    let fired = false;
    const impact = (i: number) => { if (i === 0) fired = true; onImpact(i); };
    await this.playAttack(u, weaponId, impact);
    if (!fired) impact(0);
  }

  private async playAttack(u: Unit, weaponId: number, impact: (i: number) => void) {
    const a = this.actor(u);
    const anim = animFor(u.unitId, weaponId);
    const tl = attackTimeline(u.unitId, weaponId);
    const url = anim && fileUrl(effectFiles, anim.file);
    if (this.skipped()) return;
    if (!anim || !tl || !url || !a.info) { await wait(0.4 / this.speed()); return; }
    const art = await loadArt(url);
    // 锚点 = 攻方叠色精灵的位置；镜像的机体锚点也镜像
    const ax = a.flip ? a.x + a.w - a.info.origin.x : a.x + a.info.origin.x;
    const ay = a.y + a.info.origin.y;
    const camStart = this.layout === "close" ? CLOSE_CAMERA : a.side === "right" ? 256 : 0;
    const kfs = anim.keyframes;
    let frame = 0;
    await new Promise<void>((resolve) => {
      const step = () => {
        // 音效、受击反应和画面同一帧计数，跟着动画走
        for (const [f, id] of tl.sounds) if (f === frame) this.sound(id);
        tl.impacts.forEach((f, i) => { if (f === frame) impact(i); });
        const k = [...kfs].reverse().find((f) => f[0] <= frame) ?? kfs[0];
        // 镜头和特效位置可能绕过 512（两个名称表首尾相接），画的时候按循环画（见 draw），这里直接用
        const [, , cel = -1, x = 0, y = 0, cx = 0, cy = 0] = k;
        const mx = a.flip ? -cx : cx;
        this.camera = { x: camStart + mx, y: cy };
        this.effect = cel >= 0
          ? { art, cel: anim.cels[cel], x: a.flip ? ax - x - anim.cels[cel][2] : ax + x, y: ay + y, flip: a.flip }
          : null;
        if (frame >= tl.end || this.skipped()) { this.effect = null; resolve(); return; }
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

  // 同一次攻击的后续命中（连续爆炸、导弹多发）：小闪一下、小震一下
  jolt(u: Unit) {
    const a = this.actor(u);
    a.flash = 0.06;
    this.shake(a, 2);
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
    stage.style.setProperty("--fx", `${((this.screenX(a) + a.w / 2) / W) * 100}%`);
    stage.style.setProperty("--fy", `${((a.y + a.h / 2) / H) * 100}%`);
    stage.classList.add("slowmo");
    this.slow = 0.45;
    boom();
    for (let i = 0; i < 10 && art; i++) {
      this.puffs.push({ anim, art, x: a.x + a.w * (0.1 + Math.random() * 0.8), y: a.y + a.h * (0.15 + Math.random() * 0.75), t: -i * 0.05 });
    }
    a.flash = 0.25;
    this.shake(a, 6);
    // 慢镜头停一会儿让爆炸一团团炸开，再让机体消失。回到地图还会再炸一次，这里不宜拖长（整段约 1.9 秒）
    await wait(1.0 / this.speed());
    await tween(0.5 / this.speed(), (t) => { a.alpha = 1 - t; });
    // 最后一下：大爆炸，速度恢复
    this.slow = 1;
    stage.classList.remove("slowmo");
    stage.classList.add("blast");
    boom();
    for (let i = 0; i < 4 && art; i++) this.puffs.push({ anim, art, x: a.x + a.w * (0.3 + Math.random() * 0.4), y: a.y + a.h * (0.3 + Math.random() * 0.4), t: -i * 0.03 });
    await wait(0.4 / this.speed());
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
    el.style.left = `${((this.screenX(a) + a.w / 2) / W) * 100}%`;
    // 放在机体头顶，不压住机体
    el.style.top = `${(Math.max(a.y - a.h * 0.05, 0) / H) * 100}%`;
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
      ctx.globalAlpha = a.alpha;
      // 被击破时闪烁
      if (a.alpha < 1 && Math.floor(a.alpha * 12) % 2) continue;
      this.blitWrapped(a.flash > 0 && a.white ? { src: a.white, k: a.art.k } : a.art, 0, 0, a.w, a.h, x, y, a.flip);
      ctx.globalAlpha = 1;
    }
    ctx.globalAlpha = 1;
    if (this.effect) {
      const { art, cel, x, y, flip } = this.effect;
      this.blitWrapped(art, cel[0], cel[1], cel[2], cel[3], x - this.camera.x, y - this.camera.y, flip);
    }
    for (const p of this.puffs) {
      if (p.t < 0) continue;
      const frame = p.t * 60;
      const k = [...p.anim.keyframes].reverse().find((f) => f[0] <= frame);
      const cel = k?.[2] ?? -1;
      if (cel < 0) continue;
      const [cx, cy, cw, ch] = p.anim.cels[cel];
      this.blitWrapped(p.art, cx, cy, cw, ch, p.x - cw / 2 - this.camera.x, p.y - ch / 2 - this.camera.y, false);
    }
  }

  // 原版战斗画面左右两个名称表（共 512 宽）首尾相接，卷动会绕回来：按 512 循环画，看得见的那份才真正画
  private blitWrapped(art: Art, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, flip: boolean) {
    for (const off of [-WORLD, 0, WORLD]) {
      const x = dx + off;
      if (x < W && x + sw > 0) this.blit(art, sx, sy, sw, sh, x, dy, flip);
    }
  }

  // 机体在画面上的横坐标（按 512 循环换到离画面最近的那份）
  private screenX(a: Actor) {
    const x = a.x + a.w / 2 - this.camera.x;
    return x - WORLD * Math.round((x - W / 2) / WORLD) - a.w / 2;
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
