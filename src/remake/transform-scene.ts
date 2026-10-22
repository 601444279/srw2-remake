// 地图菜单「变形」的原版演出（tools/extract-battle-gfx.js --transform 提取，tools/slim-battle-data.js 精简）。
// 原版：地图上先放现驾驶员的台词，然后切到战斗画面（舞台 256×160，比战斗高）放一段演出，停住等按键，回地图。
//   合体（盖塔式三段变形，动画 0x62#0B）：网格地面、三架战机起飞、冲进星空纵向合体、整屏加亮到全白（逐帧录下的原版画面），
//     全白时换成新形态，再从白里一档一档淡出新形态的战斗大图（fadeSteps 帧：亮度托底 3、2、1，最后恢复原色）
//   两段变形（0x62#10）：现形态、新形态分别画在两个名称表上（世界 512 宽），镜头先慢后快卷过去，停在新形态上
// 两种都在动画开始前几帧切 1 号曲（原版的变形曲），回地图时接回原来的曲子。
import db from "../../data/battle-scene.json";
import { battleSpriteUrl } from "./battle-scene.ts";
import { settings } from "./settings.ts";
import { smoothCanvas, smoothUrl } from "./upscale.ts";

const filmFiles = import.meta.glob("../../assets/original/battle/transform/*.png", { eager: true, import: "default", query: "?url" });

interface Film { file: string; w: number; h: number; columns: number; frames: [number, number][] }
type Pair = { kind: "combine"; film: string; at: [number, number] } | { kind: "swap"; from: [number, number]; to: [number, number] };
interface TransformData {
  films: Record<string, Film>;
  fadeSteps: number[];
  swapCamera: [number, number][];
  swapEnd: number;
  music: { combine: number; swap: number };
  pairs: Record<string, Pair>;
}
const data = (db as unknown as { transform?: TransformData }).transform;

const W = 256;
const H = 160;
const SCALE = 4;
const WORLD = 512;
export const TRANSFORM_SONG = 1;

// jsnes 的 NTSC 调色板（0xBBGGRR），和导出图片用的一样：用来把图片像素反查回 NES 色号，按原版规则淡入
const NES_COLORS = [0x525252, 0xb40000, 0xa00000, 0xb1003d, 0x740069, 0x00005b, 0x00005f, 0x001840, 0x002f10, 0x084a08, 0x006700, 0x124200, 0x6d2800, 0x000000, 0x000000, 0x000000, 0xc4d5e7, 0xff4000, 0xdc0e22, 0xff476b, 0xd7009f, 0x680ad7, 0x0019bc, 0x0054b1, 0x006a5b, 0x008c03, 0x00ab00, 0x2c8800, 0xa47200, 0x000000, 0x000000, 0x000000, 0xf8f8f8, 0xffab3c, 0xff7981, 0xff5bc5, 0xff48f2, 0xdf49ff, 0x476dff, 0x00b4f7, 0x00e0ff, 0x00e375, 0x03f42b, 0x78b82e, 0xe5e218, 0x787878, 0x000000, 0x000000, 0xffffff, 0xfff2be, 0xf8b8b8, 0xf8b8d8, 0xffb6ff, 0xffc3ff, 0xc7d1ff, 0x9adaff, 0x88edf8, 0x83ffdd, 0xb8f8b8, 0xf5f8ac, 0xffffb0, 0xf8d8f8, 0x000000, 0x000000];
const toNes = new Map<number, number>();
for (let c = 0x3f; c >= 0; c--) toNes.set(NES_COLORS[c], c);
const css = (c: number) => { const v = NES_COLORS[c]; return `rgb(${v & 0xff},${(v >> 8) & 0xff},${(v >> 16) & 0xff})`; };

// 亮相淡入的一档：颜色亮度托底到 floor。灰色和黑色的亮度刻度比彩色高一级（0F = 0，00 = 1 … 30 = 4），
// 彩色 x1–xC 的亮度就是高 4 位；托底后灰色回到 (floor − 1) 行，彩色保留色相、亮度 = floor（原版实测，各档逐像素一致）
function fadeFromWhite(c: number, floor: number) {
  const hue = c & 0x0f, black = hue >= 0x0d;
  const grey = black || hue === 0;
  const level = black ? 0 : grey ? (c >> 4) + 1 : c >> 4;
  if (level >= floor) return c;
  return grey ? (floor - 1) << 4 : (Math.min(3, floor) << 4) | hue;
}

export function hasTransformScene(from: number, to: number) {
  return !!data?.pairs[`${from}>${to}`];
}

const urlOf = (files: Record<string, unknown>, name: string) => {
  const hit = Object.entries(files).find(([p]) => p.endsWith(`/${name}`));
  return hit ? (hit[1] as string) : null;
};

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

interface Art { src: HTMLCanvasElement; k: number } // k = 图片像素 / 原版像素

async function unitArt(unitId: number): Promise<Art | null> {
  const url = battleSpriteUrl(unitId);
  if (!url) return null;
  const img = await loadImage(url);
  const c = document.createElement("canvas");
  c.width = img.width;
  c.height = img.height;
  c.getContext("2d")!.drawImage(img, 0, 0);
  // 平滑放大（Scale4x）只复制像素、不产生新颜色，放大后照样能反查色号淡入
  return settings.get().artStyle === "smooth" ? { src: smoothCanvas(c), k: 4 } : { src: c, k: 1 };
}

// 按原版规则把整张图换成淡入某一档的颜色
function faded(art: Art, floor: number): Art {
  const c = document.createElement("canvas");
  c.width = art.src.width;
  c.height = art.src.height;
  const g = c.getContext("2d")!;
  g.drawImage(art.src, 0, 0);
  const img = g.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    if (!d[i + 3]) continue;
    const nes = toNes.get(d[i] | (d[i + 1] << 8) | (d[i + 2] << 16));
    if (nes === undefined) continue;
    const v = NES_COLORS[fadeFromWhite(nes, floor)];
    d[i] = v & 0xff; d[i + 1] = (v >> 8) & 0xff; d[i + 2] = (v >> 16) & 0xff;
  }
  g.putImageData(img, 0, 0);
  return { src: c, k: art.k };
}

export interface TransformLine { name: string; text: string; face: string | null }

const $ = <T extends HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;
const wait = (s: number) => new Promise((r) => setTimeout(r, s * 1000));

export class TransformScene {
  private root = $("#battle-scene");
  private ctx!: CanvasRenderingContext2D;

  // skipped：玩家按了确定 / 取消或点了画面。演出中按 = 直接跳到新形态亮相（rearm 清掉这次按键），停住时按 = 继续
  constructor(private speed: () => number, private skipped: () => boolean, private onSkip: () => void, private rearm: () => void) {}

  async play(from: number, to: number, line: TransformLine | null, label: string) {
    const pair = data?.pairs[`${from}>${to}`];
    if (!pair || !data) return;
    this.root.innerHTML = `
      <div class="bs-frame tf">
        <div class="bs-stage tf"><canvas width="${W * SCALE}" height="${H * SCALE}"></canvas></div>
        <div class="bs-msg"><div class="bs-face"></div><div class="bs-text"></div></div>
      </div>`;
    this.ctx = $<HTMLCanvasElement>("canvas", this.root).getContext("2d")!;
    this.ctx.imageSmoothingEnabled = false;
    this.ctx.fillStyle = css(0x0f);
    this.ctx.fillRect(0, 0, W * SCALE, H * SCALE);
    this.root.hidden = false;
    this.root.classList.remove("out");
    this.root.onclick = () => this.onSkip();
    this.root.oncontextmenu = (e) => { e.preventDefault(); this.onSkip(); };
    this.say(line, label);

    if (pair.kind === "combine") await this.combine(data.films[pair.film], to, pair.at);
    else await this.swap(from, to, pair.from, pair.to);
    this.rearm();
    // 原版停在新形态上等按键；快进时停一下就走
    const t0 = performance.now();
    while (!this.skipped() && !(this.speed() > 1 && performance.now() - t0 > 400)) await wait(1 / 60);
    this.root.classList.add("out");
    await wait(0.2);
    this.root.hidden = true;
    this.root.innerHTML = "";
  }

  private say(line: TransformLine | null, label: string) {
    const face = $(".bs-face", this.root), text = $(".bs-text", this.root);
    if (!line) { text.innerHTML = `<b class="player">${label}</b>`; return; }
    face.innerHTML = line.face ? `<img src="${line.face}" alt="">` : `<span>${line.name.slice(0, 1)}</span>`;
    if (line.face && settings.get().artStyle === "smooth") {
      void smoothUrl(line.face).then((s) => { const img = face.querySelector("img"); if (img) img.src = s; });
    }
    text.innerHTML = `<b class="player">${line.name}</b>${line.text}`;
    text.classList.add("show");
  }

  // 按原版 60 帧计时逐帧画，到 end 帧或被跳过为止（快进时按当前倍速推进）
  private run(end: number, draw: (frame: number) => void) {
    return new Promise<void>((resolve) => {
      let base = 0, from = performance.now(), sp = this.speed();
      const loop = (now: number) => {
        if (this.speed() !== sp) { base += ((now - from) / 1000) * 60 * sp; from = now; sp = this.speed(); }
        const frame = Math.floor(base + ((now - from) / 1000) * 60 * sp);
        if (this.skipped() || frame >= end) { draw(end); resolve(); return; }
        draw(frame);
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    });
  }

  private async combine(film: Film, to: number, at: [number, number]) {
    const url = urlOf(filmFiles, film.file);
    const [sheet, art] = await Promise.all([url ? loadImage(url) : null, unitArt(to)]);
    if (!sheet || !data) return;
    const steps = data.fadeSteps;
    const fades = art ? [3, 2, 1].map((f) => faded(art, f)) : [];
    // 帧号 → 唯一帧序号
    const index: number[] = [];
    for (const [i, n] of film.frames) for (let k = 0; k < n; k++) index.push(i);
    const { ctx } = this;
    await this.run(steps[3], (f) => {
      if (f < steps[0]) {
        const i = index[Math.min(f, index.length - 1)];
        const sx = (i % film.columns) * film.w, sy = Math.floor(i / film.columns) * film.h;
        ctx.drawImage(sheet, sx, sy, film.w, film.h, 0, 0, W * SCALE, H * SCALE);
        return;
      }
      // 淡入：第 k 档（托底 3、2、1）的背景色和机体颜色；第 4 档恢复原色
      let k = 0;
      while (k < 3 && f >= steps[k + 1]) k++;
      ctx.fillStyle = css(k < 3 ? fadeFromWhite(0x0f, 3 - k) : 0x0f);
      ctx.fillRect(0, 0, W * SCALE, H * SCALE);
      const a = k < 3 ? fades[k] : art;
      if (a) ctx.drawImage(a.src, at[0] * SCALE, at[1] * SCALE, (a.src.width / a.k) * SCALE, (a.src.height / a.k) * SCALE);
    });
  }

  private async swap(from: number, to: number, fromAt: [number, number], toAt: [number, number]) {
    const [a, b] = await Promise.all([unitArt(from), unitArt(to)]);
    if (!data) return;
    const cams = data.swapCamera;
    const { ctx } = this;
    await this.run(data.swapEnd, (f) => {
      let cam = 0;
      for (const [t, x] of cams) if (t <= f) cam = x;
      ctx.fillStyle = css(0x0f);
      ctx.fillRect(0, 0, W * SCALE, H * SCALE);
      for (const [art, at] of [[a, fromAt], [b, toAt]] as const) {
        if (!art) continue;
        const w = art.src.width / art.k, h = art.src.height / art.k;
        // 两个名称表首尾相接：按 512 循环，画看得见的那份
        for (const off of [-WORLD, 0, WORLD]) {
          const x = at[0] - cam + off;
          if (x < W && x + w > 0) ctx.drawImage(art.src, x * SCALE, at[1] * SCALE, w * SCALE, h * SCALE);
        }
      }
    });
  }
}
