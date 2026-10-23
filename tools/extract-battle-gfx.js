// 提取原版战斗画面的素材：机体大图、武器特效动画、击破爆炸，并测量战斗流程各阶段的帧数。
//
// 用法: node tools/extract-battle-gfx.js [--units] [--effects] [--timing] [--verify]   （不带参数 = 全部）
//       --sounds          在已导出的动画上补录原版音效触发的帧（写进 battle-effects.json）
//       --transform       录地图菜单「变形」的原版过场（assets/original/battle/transform/，写进 battle-effects.json 的 transform）
//       --weapons 47,51   只录这几把武器（16 进制，调试用，结果不写 JSON）
// 需要 extracted/states/t4.json（太勒移到 (8,8)、选好萨斯剑、光标对准拉达K7，按 A 即开战）
// 和 extracted/states/e2.json（第 1 回合「回合结束」确认框，按 A 进入敌方回合）。
// 输出:
//   assets/original/battle/units/NNN.png        机体编号 NNN（十进制）的战斗大图，原版像素，透明背景
//   assets/original/battle/effects/NAME.png     特效层（精灵 + 被改掉的背景格子）的关键帧，横排，每帧同尺寸，透明背景
//   extracted/battle/stage/NAME.png             同一动画的整个上半屏（256×116，含机体、卷动），每行 4 帧，作参考（不进仓库，约 20MB）
//   data/battle-sprites.json                    机体编号 → 图片、来源（资源偏移、CHR bank、色板、排列、叠色精灵）
//   data/battle-effects.json                    武器编号 → 动画脚本、关键帧（时长、位置）；爆炸；流程时间
//   extracted/battle/                           核对用截图和总览（不进仓库）
//
// 做法：直接让原版代码在模拟器里画。机体：从 t4 存档开战前改 RAM 里的机体编号，等战斗画面画好后按 PPU 状态
// 只渲染这台机体那一侧的背景图块和它的叠色精灵对象。特效：攻击动画开始时把武器编号换掉，逐帧记录。
// 格式和数据位置见 docs/notes-battle-gfx.md。
import fs from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import { ROOT, hookExec, hookWrite, makeEmu } from "./lib/trace.js";
import { resolve } from "./lib/res.js";
import { runBattle, attachCapture, render, renderWorld, bbox, bboxW, diffWithFrame, rgbOf, regsAtLine, chrBankOf, OVERSCAN, NES_COLORS } from "./lib/battle-capture.js";

const T4 = "extracted/states/t4.json", E2 = "extracted/states/e2.json";
const OUT_IMG = path.join(ROOT, "assets/original/battle");
const OUT_TMP = path.join(ROOT, "extracted/battle");
const UNITS = JSON.parse(fs.readFileSync(path.join(ROOT, "data/units.json"), "utf8")).units;
const WEAPONS = JSON.parse(fs.readFileSync(path.join(ROOT, "data/weapons.json"), "utf8"));
const unitName = (id) => UNITS.find((u) => u.id === id)?.name ?? null;
const weaponName = (id) => WEAPONS.find((w) => w.id === id)?.name ?? null;

// t4 存档里的单位槽：5 号太勒（我方，右侧），24 号拉达K7（敌方，左侧）
const SLOT_RIGHT = 5, SLOT_LEFT = 24;
const PARTNER = { right: [0x23, 0x22], left: [0x2b, 0x36] }; // 陪打的机体（和被测机体不同编号）
// 上半屏（战斗舞台）的行范围：y ≈ 116 起中断换成下方窗口
const STAGE = [0, 116];
// 战斗画面画好、等待按键的帧（开战后按住 A 6 帧）
const IDLE_FRAME = 60;

const hex = (v, n = 2) => "0x" + v.toString(16).toUpperCase().padStart(n, "0");
const hexBytes = (a) => a.map((v) => v.toString(16).padStart(2, "0")).join(" ");
const pad3 = (n) => String(n).padStart(3, "0");
// 资源地址 → PRG 偏移（资源所在 16KB bank 对映射在 $8000–$BFFF）
const resOffset = (r) => r.bank * 0x2000 + (r.addr - 0x8000);

function writePng(file, w, h, pixel) {
  const png = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const c = pixel(x, y);
    const o = (y * w + x) * 4;
    if (c === null || c < 0) { png.data[o + 3] = 0; continue; }
    const [r, g, b] = rgbOf(c);
    png.data[o] = r; png.data[o + 1] = g; png.data[o + 2] = b; png.data[o + 3] = 255;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, PNG.sync.write(png));
}

function writeRgbPng(file, w, h, rgbAt) {
  const png = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [r, g, b] = rgbAt(x, y);
    const o = (y * w + x) * 4;
    png.data[o] = r; png.data[o + 1] = g; png.data[o + 2] = b; png.data[o + 3] = 255;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, PNG.sync.write(png));
}

// JSON 输出：短的对象 / 数组写在一行，其余缩进
function stringify(v, indent = "") {
  const flat = JSON.stringify(v);
  if (flat === undefined) return "null";
  if (flat.length <= 110 || v === null || typeof v !== "object") return flat;
  const next = indent + " ";
  if (Array.isArray(v)) return "[\n" + v.map((x) => next + stringify(x, next)).join(",\n") + "\n" + indent + "]";
  const keys = Object.keys(v).filter((k) => v[k] !== undefined);
  return "{\n" + keys.map((k) => next + JSON.stringify(k) + ": " + stringify(v[k], next)).join(",\n") + "\n" + indent + "}";
}

const hashIdx = (idx, box) => {
  let h = 0;
  if (!box) return 0;
  for (let y = box.y; y < box.y + box.h; y++) for (let x = box.x; x < box.x + box.w; x++) h = (h * 31 + idx[y * 256 + x] + 2) | 0;
  return h;
};

// ---------- 机体数据（静态）

// 资源 0x89：战斗画面机体记录（bank 4）。+0 标志，+1–3 背景色板 1–3 号色，+4–6 精灵色板 1–3 号色，
// +7 精灵 2KB CHR bank，+8 背景 1KB CHR bank，标志 bit7 时 +9 第二个背景 bank
function unitRecord(id) {
  const r = resolve(0x89, id);
  if (!r.addr) return null;
  const b = r.bytes(10);
  const flags = b[0];
  return {
    offset: resOffset(r), flags, raw: b.slice(0, flags & 0x80 ? 10 : 9),
    bgColors: b.slice(1, 4), spriteColors: b.slice(4, 7), spriteBank: b[7],
    bgBanks: flags & 0x80 ? [b[8], b[9]] : [b[8]],
  };
}

// 资源 0x21：机体背景图块排列脚本（画面脚本引擎，bank 8），读到 FF 为止
function layoutScript(id) {
  const r = resolve(0x21, id);
  const bytes = [];
  for (let i = 0; i < 64; i++) { const v = r.read(r.addr + i); bytes.push(v); if (v === 0xff) break; }
  return { offset: hex(resOffset(r), 5), raw: hexBytes(bytes) };
}

// 资源 0x41：机体叠色精灵（元精灵，bank 10）
function overlayScript(id) {
  const r = resolve(0x41, id);
  const d = decodeMetasprite(r);
  return { offset: hex(resOffset(r), 5), raw: hexBytes(d.bytes), sprites: d.sprites.map((p) => ({ ...p, tile: hex(p.tile), attr: hex(p.attr) })) };
}

// 元精灵格式（固定 bank $D194）：dx dy 首图块，之后每个属性字节画一个 8×8 精灵，FF 结束。
// 属性字节：bit7/6 翻转、bit0–1 色板；bit5 下一字节是新图块号，否则 bit4 = 0 时图块号 +1；
// bit3 下一字节加到 x，再看 bit2：有则下一字节加到 y，否则 y += 8；bit3 = 0 时 bit2 有则下一字节加到 x，否则 x += 8。
// 图块号 ≥ F8 时取 $06B8 + (n & 7) 的运行时值（战斗画面没见到）
function decodeMetasprite(r) {
  const rd = (i) => r.read(r.addr + i);
  const s8 = (v) => (v & 0x80 ? v - 256 : v);
  let i = 0, x = s8(rd(i++)), y = s8(rd(i++)), tile = rd(i++);
  const sprites = [];
  for (let guard = 0; guard < 64; guard++) {
    const a = rd(i++);
    if (a === 0xff) break;
    sprites.push({ dx: x, dy: y, tile, attr: a & 0xc3 });
    if (a & 0x20) tile = rd(i++);
    else if (!(a & 0x10)) tile = (tile + 1) & 0xff;
    if (a & 0x08) { x += s8(rd(i++)); if (a & 0x04) y += s8(rd(i++)); else y += 8; }
    else if (a & 0x04) x += s8(rd(i++));
    else x += 8;
  }
  return { sprites, bytes: Array.from({ length: i }, (_, k) => rd(k)) };
}

// ---------- 机体大图

function captureUnit(id, rec) {
  const side = rec.flags & 0x40 ? "left" : "right";
  const partner = PARTNER[side === "right" ? "left" : "right"].find((p) => p !== id);
  let snap = null, snapEarly = null;
  runBattle(T4, {
    frames: IDLE_FRAME + 1,
    input: (f) => (f < 6 ? 1 : 0),
    setup(emu) {
      const m = emu.nes.cpu.mem;
      m[0x7557 + (side === "right" ? SLOT_RIGHT : SLOT_LEFT)] = id;
      m[0x7557 + (side === "right" ? SLOT_LEFT : SLOT_RIGHT)] = partner;
    },
    onFrame(f, cap) {
      if (f === IDLE_FRAME - 10) snapEarly = cap.snapshot();
      if (f === IDLE_FRAME) snap = cap.snapshot();
    },
  });
  const slot = snap.objects.findIndex((o, i) => i < 2 && o.frame === id && (o.type & 0x7f) === 0x41);
  if (slot < 0) throw new Error(`机体 ${hex(id)} 没找到叠色精灵对象`);
  // 哪些图块属于这台机体：按图块所在的 CHR bank 判断。通常右侧机体在 $80–$FF（R4/R5）、左侧在 $00–$3F（R2），
  // 但左侧是双 bank 机体时两边对调（bank 4 $8EDB），所以不能只看图块号
  const { regs, inv } = regsAtLine(snap, 60);
  const tileOnSide = (t) => rec.bgBanks.includes(chrBankOf(regs, inv, snap.bgPT * 0x1000 + t * 16));
  const opts = { lines: STAGE, scroll: snap.scroll };
  const both = render(snap, { ...opts, bgCell: (c, r, t) => tileOnSide(t), sprite: (i, o) => o === slot });
  const box = bbox(both, STAGE);
  // 核对：整个上半屏（两台机体 + 所有精灵）按同样规则渲染，和模拟器画面逐像素比较；再确认画面已经稳定
  const all = render(snap, { ...opts, bgCell: () => true, sprite: () => true });
  const diff = diffWithFrame(all, snap.frameBuffer, snap.palette[0], STAGE);
  // 落在画面最左 / 最右 8 列的机体像素：实机电视上通常看不到（过扫描），模拟器截图里是黑的，导出图保留
  let clipped = 0;
  if (box) for (let y = box.y; y < box.y + box.h; y++) for (let x = box.x; x < box.x + box.w; x++) if ((x < OVERSCAN || x >= 256 - OVERSCAN) && both[y * 256 + x] >= 0) clipped++;
  // NES 每条扫描线最多显示 8 个精灵，超出的不画（原版靠每帧轮换 OAM 顺序让它们闪烁）。数一下超出的行
  const perLine = new Array(240).fill(0);
  for (let i = 0; i < 64; i++) { const y = snap.oam[i * 4] + 1; if (y < 240) for (let k = 0; k < 8; k++) if (y + k < 240) perLine[y + k]++; }
  const overflowLines = perLine.filter((n, y) => y < STAGE[1] && n > 8).length;
  let stable = true;
  for (let i = 0; i < 256 * STAGE[1]; i++) if (snap.frameBuffer[i] !== snapEarly.frameBuffer[i]) { stable = false; break; }
  // 名称表里这台机体的图块排列（相对包围盒左上角所在的格子；-1 = 没画）
  const obj = snap.objects[slot];
  const sprites = [];
  for (let i = 0; i < 64; i++) if (snap.owner[i] === slot) {
    const y = snap.oam[i * 4] + 1, t = snap.oam[i * 4 + 1], a = snap.oam[i * 4 + 2], x = snap.oam[i * 4 + 3];
    sprites.push({ x: x - (box?.x ?? 0), y: y - (box?.y ?? 0), tile: t, attr: a, chrBank: chrBankOf(regs, inv, snap.spPT * 0x1000 + t * 16) });
  }
  sprites.sort((p, q) => p.y - q.y || p.x - q.x);
  const grid = [];
  let gridOrigin = null;
  if (box) {
    const sx = snap.scroll.x;
    const c0 = Math.floor((box.x + sx) / 8), c1 = Math.floor((box.x + box.w - 1 + sx) / 8);
    const r0 = Math.floor(box.y / 8), r1 = Math.floor((box.y + box.h - 1) / 8);
    for (let r = r0; r <= r1; r++) {
      const row = [];
      for (let c = c0; c <= c1; c++) {
        const t = snap.nt[(c >> 5) & 1][r * 32 + (c & 31)];
        row.push(tileOnSide(t) ? t : -1);
      }
      grid.push(row);
    }
    gridOrigin = { x: c0 * 8 - sx - box.x, y: r0 * 8 - box.y };
  }
  return {
    side, slot, box, diff, stable, overflowLines, clipped, both, sprites, grid, gridOrigin,
    origin: { x: obj.x, y: obj.y },
  };
}

function extractUnits() {
  const out = [];
  const seen = new Map(); // 像素哈希 → 编号
  const overview = [];
  for (let id = 1; id < 0xc0; id++) {
    const rec = unitRecord(id);
    if (!rec) continue;
    const entry = {
      id, idHex: hex(id), name: unitName(id),
      record: { offset: hex(rec.offset, 5), raw: hexBytes(rec.raw), flags: hex(rec.flags) },
    };
    // 0xB5–0xBF 指向同一条非机体格式的记录（00 00 00 00 18 1a …），没有机体用
    if (rec.offset === resOffset(resolve(0x89, 0xb5)) && id >= 0xb5) { entry.unused = true; out.push(entry); continue; }
    const cu = captureUnit(id, rec);
    Object.assign(entry, {
      side: cu.side,
      facing: cu.side === "right" ? "left" : "right",
      bgColors: rec.bgColors.map((c) => hex(c)), spriteColors: rec.spriteColors.map((c) => hex(c)),
      bgBanks: rec.bgBanks.map((b) => ({ bank: hex(b), chrOffset: hex(b * 0x400, 5) })),
      spriteBank: { bank: hex(rec.spriteBank), chrOffset: hex((rec.spriteBank & 0xfe) * 0x400, 5) },
      layout: layoutScript(id),
      overlay: overlayScript(id),
    });
    if (!cu.box) { entry.empty = true; out.push(entry); continue; }
    const h = hashIdx(cu.both, cu.box) ^ cu.box.w * 7919 ^ cu.box.h;
    entry.width = cu.box.w; entry.height = cu.box.h;
    entry.screen = { x: cu.box.x, y: cu.box.y };
    entry.origin = { x: cu.origin.x - cu.box.x, y: cu.origin.y - cu.box.y };
    entry.tiles = { origin: cu.gridOrigin, rows: cu.grid.map((r) => r.map((t) => (t < 0 ? "--" : t.toString(16).padStart(2, "0"))).join(" ")) };
    entry.sprites = cu.sprites.map((s) => ({ x: s.x, y: s.y, tile: hex(s.tile), attr: hex(s.attr), chrBank: hex(s.chrBank) }));
    entry.check = { stageDiff: cu.diff, stable: cu.stable };
    if (cu.overflowLines) entry.check.spriteOverflowLines = cu.overflowLines;
    if (cu.clipped) entry.check.pixelsInOverscan = cu.clipped;
    if (seen.has(h)) entry.sameAs = seen.get(h);
    else {
      seen.set(h, id);
      entry.file = `assets/original/battle/units/${pad3(id)}.png`;
      writePng(path.join(ROOT, entry.file), cu.box.w, cu.box.h, (x, y) => cu.both[(cu.box.y + y) * 256 + cu.box.x + x]);
      overview.push({ id, cu });
    }
    out.push(entry);
    process.stdout.write(`\r机体 ${hex(id)} ${cu.side} ${cu.box.w}×${cu.box.h} diff=${cu.diff}${cu.stable ? "" : " 未稳定"}   `);
  }
  console.log();
  // 总览：每格 128×116，按编号排列（只放不重复的图）
  const COLS = 8, CW = 128, CH = 96;
  const rows = Math.ceil(overview.length / COLS);
  const cells = new Int16Array(COLS * CW * rows * CH).fill(-1);
  overview.forEach(({ cu }, k) => {
    const ox = (k % COLS) * CW, oy = Math.floor(k / COLS) * CH;
    for (let y = 0; y < Math.min(cu.box.h, CH); y++) for (let x = 0; x < Math.min(cu.box.w, CW); x++)
      cells[(oy + y) * COLS * CW + ox + x] = cu.both[(cu.box.y + y) * 256 + cu.box.x + x];
  });
  writePng(path.join(OUT_TMP, "units-overview.png"), COLS * CW, rows * CH, (x, y) => { const c = cells[y * COLS * CW + x]; return c < 0 ? 0x0f : c; });
  return out;
}

// ---------- 动画（武器特效、爆炸）

const ANIM_START = 0xe816; // 动画脚本开始：$AA = 资源号，$AD = 编号
const RAND_ENTRY = 0xc39b, RAND_EXIT = 0xc3b5;

// 录一段动画：从脚本开始到 $AA 清零（脚本 FF）。返回每帧的快照（只留需要的部分）
// forceWeapon = [指令地址, RAM 地址, 武器]：bank 6 执行到该指令时把 RAM 里的武器编号换掉
// ranged：战前预测算完距离后（bank 4 $87F9）把 $E3 bit6（距离 ≠ 1）置位，画面改用远距离布局
// sounds：传数组时记下动画期间触发的音效 [第几帧（和关键帧同一计数）, 音效号]（往 $4C 写 $01–$7F）
function recordAnim({ setup, want, frames = 700, rolls = () => 99, forceWeapon = null, ranged = false, sounds = null }) {
  const rec = [];
  let active = false, ended = false, startFrame = -1, info = null, before = null;
  runBattle(T4, {
    frames,
    input: (f) => (f % 20 < 6 ? 1 : 0),
    setup(emu, cap) {
      const nes = emu.nes, m = nes.cpu.mem, cpu = nes.cpu;
      setup(m);
      let n = 0, k = 0;
      hookExec(nes, (pc) => {
        if (forceWeapon && pc === forceWeapon[0] && cap.slots[0] === 6) m[forceWeapon[1]] = forceWeapon[2];
        if (ranged && pc === 0x87f9 && cap.slots[0] === 4) m[0xe3] |= 0x40;
        if (pc === RAND_ENTRY) n = cpu.REG_ACC;
        else if (pc === RAND_EXIT && n === 100) cpu.REG_ACC = rolls(k++);
        else if (pc === ANIM_START && cap.slots[0] < 30 && !active && !ended && want(m[0xaa], m[0xad], m)) {
          active = true;
          info = { res: m[0xaa], index: m[0xad], anchor: { x: m[0x92], y: m[0x93] } };
        }
      });
      if (sounds) hookWrite(nes, (a, v) => { if (active && a === 0x4c && v >= 1 && v < 0x80) sounds.push([rec.length, v]); });
    },
    onFrame(f, cap, emu) {
      if (!active) { if (!ended && f > 30) before = cap.snapshot(); return; }
      if (startFrame < 0) startFrame = f;
      // 脚本执行到 FF（$AA 清 0）的那一帧不算动画（和流程计时的「动画结束」一致）
      if (emu.nes.cpu.mem[0xaa] === 0) { active = false; ended = true; return false; }
      rec.push(cap.snapshot());
    },
  });
  return { frames: rec, info, startFrame, before };
}

// 特效精灵：3 号以后的对象（0、1 = 两台机体的叠色精灵，2 = 窗口里的头像），以及上半屏里不属于任何对象的精灵
const isEffectSprite = (s, i) => s.owner[i] >= 3 || (s.owner[i] < 0 && s.oam[i * 4] < STAGE[1]);

// 特效层（世界坐标，512 宽）= 特效精灵 + 相对动画开始前被改掉的背景格子（光束等用背景图块画的特效），格子里 0 号色透明
const WORLD = 512;
function effectLayer(s, base) {
  const changed = (c, r, t) => t !== base.nt[(c >> 5) & 1][r * 32 + (c & 31)];
  return renderWorld(s, { rows: [0, 15], bgCell: changed, sprite: (i) => isEffectSprite(s, i) });
}

// 关键帧：特效层、镜头（卷动）、上半屏画面都不变的连续帧合成一帧
function keyframes(rec, base) {
  const layers = rec.map((s) => {
    const fx = effectLayer(s, base);
    let hs = 0;
    for (let i = 0; i < 256 * STAGE[1]; i++) hs = (hs * 31 + s.frameBuffer[i]) | 0;
    let hf = s.scroll.x * 977 + s.scroll.y;
    for (let i = 0; i < fx.length; i++) hf = (hf * 31 + fx[i] + 2) | 0;
    return { s, fx, hs, hf };
  });
  const keys = [];
  for (const L of layers) {
    const last = keys.at(-1);
    if (last && last.hs === L.hs && last.hf === L.hf) last.duration++;
    else keys.push({ ...L, duration: 1 });
  }
  return keys;
}

// 名称表里某台机体（按背景 CHR bank 认）占的世界坐标范围
function unitWorldBox(s, banks) {
  const { regs, inv } = regsAtLine(s, 60);
  let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
  for (let c = 0; c < 64; c++) for (let r = 0; r < 15; r++) {
    const t = s.nt[c >> 5][r * 32 + (c & 31)];
    if (!t || !banks.includes(chrBankOf(regs, inv, s.bgPT * 0x1000 + t * 16))) continue;
    x0 = Math.min(x0, c * 8); x1 = Math.max(x1, c * 8 + 7); y0 = Math.min(y0, r * 8); y1 = Math.max(y1, r * 8 + 7);
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

// base = 动画开始前一帧（色板、镜头、背景的变化都相对它记录）；units = { attacker, defender } 机体编号
function exportAnim(name, rec, info, base, units) {
  const keys = keyframes(rec, base);
  // 每个关键帧的特效层裁成最小矩形，相同的只存一次（cel），拼成一张图：按行排，行宽不超过 512
  const cels = [], celIndex = new Map();
  for (const k of keys) {
    const b = bboxW(k.fx, WORLD);
    if (!b) { k.cel = -1; continue; }
    let h = b.w * 7919 + b.h;
    for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) h = (h * 31 + k.fx[y * WORLD + x] + 2) | 0;
    if (!celIndex.has(h)) { celIndex.set(h, cels.length); cels.push({ src: k.fx, b }); }
    k.cel = celIndex.get(h); k.box = b;
  }
  let sheetW = 0, sheetH = 0, cx = 0, rowH = 0;
  for (const c of cels) {
    if (cx + c.b.w > 512 && cx > 0) { cx = 0; sheetH += rowH; rowH = 0; }
    c.at = { x: cx, y: sheetH };
    cx += c.b.w; rowH = Math.max(rowH, c.b.h); sheetW = Math.max(sheetW, cx);
  }
  sheetH += rowH;
  const effectFile = cels.length ? `assets/original/battle/effects/${name}.png` : null;
  if (cels.length) {
    const sheet = new Int16Array(sheetW * sheetH).fill(-1);
    for (const c of cels) for (let y = 0; y < c.b.h; y++) for (let x = 0; x < c.b.w; x++)
      sheet[(c.at.y + y) * sheetW + c.at.x + x] = c.src[(c.b.y + y) * WORLD + c.b.x + x];
    writePng(path.join(ROOT, effectFile), sheetW, sheetH, (x, y) => sheet[y * sheetW + x]);
  }
  const COLS = 4, W = 256, H = STAGE[1];
  const stageFile = `extracted/battle/stage/${name}.png`;
  const rows = Math.ceil(keys.length / COLS);
  writeRgbPng(path.join(ROOT, stageFile), COLS * W, rows * H, (x, y) => {
    const k = keys[Math.floor(y / H) * COLS + Math.floor(x / W)];
    if (!k) return [0, 0, 0];
    const c = k.s.frameBuffer[(y % H) * 256 + (x % W)];
    return [c & 0xff, (c >> 8) & 0xff, (c >> 16) & 0xff];
  });
  // 只看上半屏的名称表（第 0–14 行），下方窗口的文字变化不算
  const ntHash = (s) => { let h = 0; for (const t of s.nt) for (let i = 0; i < 15 * 32; i++) h = (h * 31 + t[i]) | 0; return h; };
  // 锚点 = 攻方叠色精灵对象的屏幕坐标（$92/$93，脚本里建对象的位置以它为基准），换成世界坐标
  const anchor = info ? { x: (info.anchor.x + base.scroll.x) & (WORLD - 1), y: info.anchor.y } : null;
  let t = 0, prevPal = base.palette;
  const frames = keys.map((k) => {
    const s = k.s;
    const f = { start: t, duration: k.duration };
    t += k.duration;
    // cel = 特效图里第几块，x/y = 这块左上角相对攻方锚点的世界坐标
    if (k.cel >= 0) Object.assign(f, { cel: k.cel, x: k.box.x - (anchor?.x ?? 0), y: k.box.y - (anchor?.y ?? 0) });
    if (s.scroll.x !== base.scroll.x || s.scroll.y !== base.scroll.y) f.camera = { x: s.scroll.x - base.scroll.x, y: s.scroll.y - base.scroll.y };
    // 色板只记和上一关键帧（第一帧和动画前）不同的项
    const pc = {};
    for (let i = 0; i < 32; i++) if (s.palette[i] !== prevPal[i]) pc[hex(0x3f00 + i, 4)] = hex(s.palette[i]);
    if (Object.keys(pc).length) f.palette = pc;
    prevPal = s.palette;
    if (ntHash(s) !== ntHash(base)) f.bgChanged = true;
    const hidden = [0, 1].filter((i) => (s.objects[i].flags & 0x10) !== (base.objects[i].flags & 0x10) || s.objects[i].flags === 0);
    if (hidden.length) f.overlayHidden = hidden;
    return f;
  });
  const unitBox = (id) => { const r = unitRecord(id); return r ? unitWorldBox(base, r.bgBanks) : null; };
  // 自检：每个关键帧把整个上半屏按同样规则渲染，和模拟器画面比较（不同的像素总数）
  let stageDiff = 0, overflowKeys = 0;
  for (const k of keys) {
    const all = render(k.s, { lines: STAGE, scroll: k.s.scroll, bgCell: () => true, sprite: () => true, limit8: true });
    stageDiff += diffWithFrame(all, k.s.frameBuffer, k.s.palette[0], STAGE);
    // 这一帧有精灵因为一行超过 8 个没显示（原版每帧轮换 OAM 顺序，表现为闪烁；导出的特效层画出全部精灵）
    const full = render(k.s, { lines: STAGE, scroll: k.s.scroll, bgCell: () => true, sprite: () => true });
    if (diffWithFrame(full, k.s.frameBuffer, k.s.palette[0], STAGE)) overflowKeys++;
  }
  return {
    effectFile, stageFile,
    // 特效图里每块的位置和尺寸
    cels: cels.map((c) => ({ x: c.at.x, y: c.at.y, w: c.b.w, h: c.b.h })),
    anchor,
    // 动画开始时的镜头（世界坐标里屏幕左边缘的 x）和两台机体在世界坐标里的位置
    camera: { x: base.scroll.x, y: base.scroll.y },
    units: units ? { attacker: { id: units.attacker, box: unitBox(units.attacker) }, defender: { id: units.defender, box: unitBox(units.defender) } } : null,
    totalFrames: t, keyframes: frames,
    basePalette: hexBytes(Array.from(base.palette)),
    check: overflowKeys ? { stageDiff, spriteOverflowKeyframes: overflowKeys } : { stageDiff },
  };
}

// 动画脚本（资源 0x60/0x61/0x62，bank 8 / bank 24）：读原始字节到第一个 FF（不跟跳转）
function animScript(res, index) {
  const r = resolve(res, index);
  if (!r.addr) return null;
  const bytes = [];
  for (let i = 0; i < 160; i++) { const v = r.read(r.addr + i); bytes.push(v); if (v === 0xff) break; }
  return { offset: hex(resOffset(r), 5), raw: hexBytes(bytes), ops: decodeAnimScript(bytes) };
}

// 动画脚本指令（固定 bank $E832，分发表 $E851）。参数个数固定的指令按表解码，其余原样
const ANIM_OPS = {
  0xf0: ["palette", (b, i) => 3 + b[i + 2]], // F0 起始色号 个数 颜色… 写色板缓冲 $0490+（$3F00+）
  0xf1: ["sub", () => 2],                     // F1 n：0 上传色板，1 ?，2 色板整体变亮（闪白），3 显示叠色精灵，4 隐藏叠色精灵
  0xf2: ["chrParams", (b, i) => 3 + b[i + 2]],// F2 起始 个数 值…：写 $04D8+（窗口 / 背景 bank 参数）
  0xf3: ["drawScreen", () => 3],              // F3 资源 编号：画面脚本（背景图块）
  0xf4: ["sound", () => 2],                   // F4 n：$4C = n（音效）
  0xf5: ["setPos", () => 3],                  // F5 槽 值：bit7 = 0 设对象 x，= 1 设 y
  0xf6: ["set61", () => 2],                   // F6 n：$61 = n
  0xf7: ["split", () => 2 + 0],               // F7 sv …：中断分屏表（高 4 位选表，低 4 位分屏号），带 1 个参数
  0xf8: ["objectAbs", null],                  // F8 槽 …：建对象（绝对坐标）
  0xf9: ["object", null],                     // F9 槽 x y 类型 轨道资源 帧轨 x轨 y轨：建对象（相对锚点）
  0xfa: ["kill", () => 2],                    // FA 槽：删除对象
  0xfb: ["show", () => 2],                    // FB 槽：对象 bit6 置位
  0xfc: ["hide", () => 2],                    // FC 槽：对象 bit6 清除
  0xfd: ["scroll", () => 3],                  // FD dx dy：卷动（震屏），同时移动 0、1 号对象
  0xfe: ["loop", () => 4],                    // FE n 地址：循环 n 次跳到地址
  0xff: ["end", () => 1],
};
function decodeAnimScript(bytes) {
  const ops = [];
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i];
    if (b < 0xf0) { ops.push(`wait ${b}`); i++; continue; }
    const [name, len] = ANIM_OPS[b];
    let n;
    if (b === 0xf7) n = 3;
    else if (b === 0xf8 || b === 0xf9) {
      const f = bytes[i + 1];
      n = 2 + (f & 0x80 ? 0 : 1) + (f & 0x40 ? 0 : 1) + 5;
    } else n = len(bytes, i);
    ops.push(`${name} ${hexBytes(bytes.slice(i + 1, i + n))}`.trim());
    i += n;
  }
  return ops;
}

function extractEffects() {
  const recUnits = new Map();
  for (const u of UNITS) { const r = unitRecord(u.id); if (r && u.weapons) recUnits.set(u.id, { r, weapons: u.weapons }); }
  const weapons = [];
  const animCache = new Map(); // 脚本偏移 + 像素哈希 → 导出结果
  for (let w = 1; w < 0xc0; w++) {
    if (ONLY_WEAPONS && !ONLY_WEAPONS.includes(w)) continue;
    const entry = { id: w, idHex: hex(w), name: weaponName(w) };
    const owners = [...recUnits].filter(([, v]) => v.weapons.includes(w)).map(([id, v]) => ({ id, side: v.r.flags & 0x40 ? "left" : "right" }));
    entry.owners = owners.map((o) => o.id);
    const ranged = (WEAPONS.find((x) => x.id === w)?.range ?? 1) > 1;
    entry.layout = ranged ? "ranged" : "close";
    for (const [res, side] of [[0x60, "right"], [0x61, "left"]]) {
      const sc = animScript(res, w);
      const key = `${side}`;
      entry[key] = { script: sc ? { res: hex(res), ...sc } : null };
      if (!sc) continue;
      const users = owners.filter((o) => o.side === side);
      if (!users.length) { entry[key].note = "没有这一侧的机体装备这把武器，没录"; continue; }
      const variants = [];
      for (const u of users) {
        process.stdout.write(`\r武器 ${hex(w)} ${side} 机体 ${hex(u.id)}            `);
        const partner = PARTNER[side === "right" ? "left" : "right"].find((p) => p !== u.id);
        const anim = recordAnim({
          setup(m) {
            m[0x7557 + (side === "right" ? SLOT_RIGHT : SLOT_LEFT)] = u.id;
            m[0x7557 + (side === "right" ? SLOT_LEFT : SLOT_RIGHT)] = partner;
          },
          // 攻击动画用 $D7（攻方武器，bank 6 $82FC 读）/ $D8（反击武器，$83DA 读）作编号：t4 里右侧先攻，左侧反击
          forceWeapon: side === "right" ? [0x82fc, 0xd7, w] : [0x83da, 0xd8, w],
          // 射程 > 1 的武器打不到相邻的敌人，原版里总是远距离布局（两台机体分在两屏，镜头卷过去）
          ranged,
          want: (aa) => aa === res,
          frames: side === "right" ? 300 : 520,
        });
        if (!anim.frames.length) { variants.push({ unit: u.id, error: "没录到动画" }); continue; }
        // 同一脚本、特效层画面一样的只导出一次（机体不同时整屏参考图不同，用第一台的）
        const fxSig = `${res}:${sc.offset}:${ranged}:` + keyframes(anim.frames, anim.before).map((k) => `${k.hf}x${k.duration}`).join(",");
        let exp = animCache.get(fxSig);
        if (!exp) {
          const name = `${side}-${sc.offset.slice(2).toLowerCase()}-u${pad3(u.id)}`;
          exp = exportAnim(name, anim.frames, anim.info, anim.before, { attacker: u.id, defender: partner });
          exp.layout = ranged ? "ranged" : "close";
          exp.name = name;
          animCache.set(fxSig, exp);
        }
        variants.push({ unit: u.id, anim: exp.name, firstFrame: anim.startFrame });
      }
      entry[key].recorded = variants;
    }
    weapons.push(entry);
  }
  console.log();
  const anims = Object.fromEntries([...animCache.values()].map((e) => [e.name, e]));
  return { weapons, anims };
}

function extractExplosions() {
  const out = {};
  // 左侧被击破：太勒先攻必中，拉达K7 HP 1；右侧被击破：太勒先攻落空，拉达K7 反击必中，太勒 HP 1。近身 / 远距离布局各录一次
  const cases = [
    { name: "explode-left", setup: (m) => { m[0x76b7 + SLOT_LEFT] = 1; m[0x76d7 + SLOT_LEFT] = 0; }, rolls: () => 0, units: { attacker: 0x23, defender: 0x2b } },
    { name: "explode-right", setup: (m) => { m[0x76b7 + SLOT_RIGHT] = 1; m[0x76d7 + SLOT_RIGHT] = 0; }, rolls: (k) => (k === 0 ? 99 : 0), units: { attacker: 0x2b, defender: 0x23 } },
  ];
  for (const c of cases) for (const ranged of [false, true]) {
    const name = c.name + (ranged ? "-ranged" : "");
    const anim = recordAnim({ setup: c.setup, want: (aa) => aa === 0x62, rolls: c.rolls, frames: 900, ranged });
    const exp = exportAnim(name, anim.frames, anim.info, anim.before, c.units);
    exp.layout = ranged ? "ranged" : "close";
    exp.script = { res: hex(anim.info.res), index: hex(anim.info.index), ...animScript(anim.info.res, anim.info.index) };
    exp.firstFrame = anim.startFrame;
    out[name] = exp;
  }
  return out;
}

// ---------- 流程时间

// t4 开战（第 0 帧按 A），记录各阶段：黑屏、战斗画面出现、动画开始 / 结束、HP 变化、消息窗口、回到地图
function measureTiming(mode, ranged = false) {
  const ev = [];
  let f0 = 0, aa = 0, wasBlack = false;
  const input = mode === "mash" ? (f) => (f % 4 < 2 ? 1 : 0) : mode === "player" ? (f) => (f % 20 < 6 ? 1 : 0) : (f) => (f < 6 ? 1 : 0);
  runBattle(T4, {
    frames: 700, input,
    setup(emu, cap) {
      const nes = emu.nes, m = nes.cpu.mem;
      hookExec(nes, (pc) => {
        if (ranged && pc === 0x87f9 && cap.slots[0] === 4) m[0xe3] |= 0x40;
        if (pc === ANIM_START && cap.slots[0] < 30) { ev.push({ f: f0, e: `动画 ${hex(m[0xaa])}#${hex(m[0xad])} 开始` }); aa = m[0xaa]; }
        if (pc === 0xd362) ev.push({ f: f0, e: `画面脚本 ${hex(m[0xa8])}#${hex(m[0xab])}` });
      });
      const ow = nes.cpu.write.bind(nes.cpu);
      nes.cpu.write = (a, v) => { if (a >= 0x76d7 && a < 0x76f7) ev.push({ f: f0, e: `HP 写入 单位 ${a - 0x76d7}` }); return ow(a, v); };
    },
    onFrame(f, cap, emu) {
      f0 = f + 1;
      const m = emu.nes.cpu.mem;
      if (aa && m[0xaa] === 0) { ev.push({ f, e: `动画 ${hex(aa)} 结束` }); aa = 0; }
      const b = emu.nes.ppu.buffer;
      let sum = 0;
      for (let i = 0; i < b.length; i += 7) sum += (b[i] & 0xff) + ((b[i] >> 8) & 0xff) + ((b[i] >> 16) & 0xff);
      const black = sum / (b.length / 7) / 3 < 4;
      if (black !== wasBlack) ev.push({ f, e: black ? "黑屏开始" : "黑屏结束" });
      wasBlack = black;
    },
  });
  return ev;
}

// ---------- 核对：第一关真实战斗的截图里找导出的机体图

// 不改 RAM 的真实战斗：t4 我方太勒攻击拉达K7；e2 起连续结束回合，敌方阶段里敌人主动攻击我方。
// 战斗画面布局脚本（画面资源 0x20 的 0x49/0x4A/0x50/0x51）开始后 40 帧截图（画好、还没开始攻击）
function naturalBattles(enemyTurns) {
  const shots = [], anims = [];
  const LAYOUTS = [0x49, 0x4a, 0x50, 0x51];
  // 每场两张：布局脚本开始后 40 帧（画好、还没攻击），以及第一个攻击动画结束时（远距离布局时镜头已转到守方）
  const watch = (emu, label) => {
    const m = emu.nes.cpu.mem;
    let wait = -1, n = 0, animOn = false, firstAnim = false, layout = 0, cur = null, last = null;
    const cap = attachCapture(emu);
    hookExec(emu.nes, (pc) => {
      if (pc === 0xd362 && m[0xa8] === 0x20 && LAYOUTS.includes(m[0xab])) { wait = 40; n++; firstAnim = true; layout = m[0xab]; }
      if (pc === ANIM_START && cap.slots[0] < 30) {
        if (firstAnim) { animOn = true; firstAnim = false; }
        // 攻方是哪台：脚本资源 0x60 = 右侧（对象 0），0x61 = 左侧（对象 1）
        cur = { label: `${label}-${n}`, res: m[0xaa], index: m[0xad], attacker: m[0xaa] === 0x61 ? m[0x731] : m[0x730], anchor: { x: m[0x92], y: m[0x93] }, frames: [], before: last };
        anims.push(cur);
      }
    });
    return (turn) => {
      const tag = `${label}-${turn ?? ""}${n}`;
      if (wait > 0 && --wait === 0) shots.push({ label: `${tag}a`, s: cap.snapshot(), ids: [m[0x730], m[0x731]], layout });
      if (cur) { if (m[0xaa] === 0) cur = null; else cur.frames.push(cap.snapshot()); }
      if (animOn && m[0xaa] === 0) { animOn = false; shots.push({ label: `${tag}b`, s: cap.snapshot(), ids: [m[0x730], m[0x731]], layout }); }
      if (!cur) last = cap.snapshot(true);
      cap.beginFrame();
    };
  };
  {
    const emu = makeEmu(path.join(ROOT, T4));
    const tick = watch(emu, "t4");
    for (let f = 0; f < 200; f++) { if (f % 20 === 0) emu.nes.buttonDown(1, 0); if (f % 20 === 6) emu.nes.buttonUp(1, 0); tick(); emu.nes.frame(); }
  }
  {
    const emu = makeEmu(path.join(ROOT, E2));
    const nes = emu.nes, m = nes.cpu.mem;
    const tick = watch(emu, "e2");
    const frame = () => { tick(`t${m[0x750c]}-`); nes.frame(); };
    const press = (k) => { nes.buttonDown(1, k); for (let i = 0; i < 6; i++) frame(); nes.buttonUp(1, k); for (let i = 0; i < 12; i++) frame(); };
    const wait = (n) => { for (let i = 0; i < n; i++) frame(); };
    press(0); // 确认「回合结束」
    for (let t = 0; t < enemyTurns; t++) {
      // 敌方阶段：每 20 帧按 A 推进战斗消息，直到回合数加一（我方阶段开始）
      const turn = m[0x750c];
      for (let i = 0; i < 8000 && m[0x750c] === turn; i++) { if (i % 20 === 0) nes.buttonDown(1, 0); if (i % 20 === 6) nes.buttonUp(1, 0); frame(); }
      wait(200); press(1); wait(30);
      // 光标移到 (10,15) 附近的空地 → A 打开系统菜单 → A 回合结束 → A 确认
      let tx = 10, ty = 15;
      search: for (let r = 0; r < 10; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        const x = 10 + dx, y = 15 + dy;
        if (x < 0 || y < 0 || x >= m[0xc6] || y >= m[0xc7]) continue;
        let used = false;
        for (let u = 0; u < 32; u++) if (m[0x7537 + u] && !(m[0x77d7 + u] & 0x80) && m[0x7597 + u] === x && m[0x75b7 + u] === y) used = true;
        if (!used) { tx = x; ty = y; break search; }
      }
      for (let i = 0; i < 80 && (m[0xc0] !== tx || m[0xc1] !== ty); i++) {
        const k = m[0xc0] < tx ? 7 : m[0xc0] > tx ? 6 : m[0xc1] < ty ? 5 : 4; // 右 左 下 上
        nes.buttonDown(1, k); for (let j = 0; j < 4; j++) frame(); nes.buttonUp(1, k); for (let j = 0; j < 10; j++) frame();
      }
      wait(30); press(0); wait(40); press(0); wait(40); press(0); wait(60);
    }
  }
  return { shots, anims };
}

// 战斗画面背景是否随环境 / 地形变化：t4 开战前改 $7411（地图环境 0–3）和两台机体脚下的地形，比较上半屏
function verifyBackground() {
  const shot = (setup) => {
    let fb = null;
    runBattle(T4, { frames: IDLE_FRAME + 1, input: (f) => (f < 6 ? 1 : 0), setup: (emu) => setup(emu.nes.cpu.mem), onFrame: (f, cap) => { if (f === IDLE_FRAME) fb = cap.snapshot().frameBuffer; } });
    return fb;
  };
  const base = shot(() => {});
  const out = [];
  const cases = [0, 1, 2, 3].map((env) => [`环境 ${env}`, (m) => { m[0x7411] = env; }]);
  for (let t = 0; t < 16; t++) cases.push([`地形 ${t}`, (m) => {
    for (const slot of [SLOT_RIGHT, SLOT_LEFT]) { const a = 0x7000 + m[0x75b7 + slot] * 32 + m[0x7597 + slot]; m[a] = (m[a] & 0xf0) | t; }
  }]);
  for (const [name, setup] of cases) {
    const fb = shot(setup);
    let diff = 0;
    for (let i = 0; i < 256 * STAGE[1]; i++) if (fb[i] !== base[i]) diff++;
    out.push({ case: name, stageDiff: diff });
  }
  return out;
}

// 特效核对：真实战斗里播放的每段动画，逐帧算出特效层（同 exportAnim 的规则），和导出的 cel 图 + 关键帧逐帧比较
function verifyEffects(effectsDoc) {
  const out = [];
  const celKey = (get, w, h) => { let k = `${w}x${h}:`; for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const c = get(x, y); k += c ? c.join(",") : "-"; k += ";"; } return k; };
  const pngCache = new Map();
  const loadPng = (f) => { if (!pngCache.has(f)) pngCache.set(f, PNG.sync.read(fs.readFileSync(path.join(ROOT, f)))); return pngCache.get(f); };
  // 导出的动画展开成逐帧：[cel 像素键, x, y, 镜头]
  const expandExported = (a) => {
    const png = a.effectFile ? loadPng(a.effectFile) : null;
    const keys = a.cels.map((c) => celKey((x, y) => { const o = ((c.y + y) * png.width + c.x + x) * 4; return png.data[o + 3] ? [png.data[o], png.data[o + 1], png.data[o + 2]] : null; }, c.w, c.h));
    const fr = [];
    for (const k of a.keyframes) for (let i = 0; i < k.duration; i++) fr.push(`${k.cel === undefined ? "-" : keys[k.cel]}@${k.x ?? ""},${k.y ?? ""} cam${k.camera ? k.camera.x + "," + k.camera.y : "0,0"}`);
    return fr;
  };
  const expandNatural = (n) => {
    const anchor = { x: (n.anchor.x + n.before.scroll.x) & (WORLD - 1), y: n.anchor.y };
    return n.frames.map((s) => {
      const fx = effectLayer(s, n.before);
      const b = bboxW(fx, WORLD);
      const cam = `cam${s.scroll.x - n.before.scroll.x},${s.scroll.y - n.before.scroll.y}`;
      if (!b) return `-@, ${cam}`;
      const key = celKey((x, y) => { const c = fx[(b.y + y) * WORLD + b.x + x]; return c < 0 ? null : rgbOf(c); }, b.w, b.h);
      return `${key}@${b.x - anchor.x},${b.y - anchor.y} ${cam}`;
    });
  };
  for (const n of NATURAL.anims) {
    if (!n.before || !n.frames.length) continue;
    let a = null, via = "";
    if (n.res === 0x62) {
      const name = Object.keys(effectsDoc.explosions).find((k) => effectsDoc.explosions[k].script.index === hex(n.index) && effectsDoc.explosions[k].camera.x === n.before.scroll.x);
      a = name ? effectsDoc.explosions[name] : null; via = name;
    } else {
      const w = effectsDoc.weapons.find((x) => x.id === n.index);
      const side = n.res === 0x60 ? "right" : "left";
      const rec = w?.[side]?.recorded ?? [];
      const r = rec.find((x) => x.unit === n.attacker) ?? rec.find((x) => x.anim);
      a = r ? effectsDoc.anims[r.anim] : null; via = r?.anim;
    }
    const row = { battle: n.label, script: `${hex(n.res)}#${hex(n.index)}`, attacker: hex(n.attacker), anim: via ?? null };
    if (!a) { out.push({ ...row, result: "没有对应的导出动画" }); continue; }
    const ex = expandExported(a), na = expandNatural(n);
    let bad = 0;
    for (let i = 0; i < Math.max(ex.length, na.length); i++) if (ex[i] !== na[i]) bad++;
    out.push({ ...row, frames: na.length, exportedFrames: ex.length, diffFrames: bad });
  }
  return out;
}

function verifyNatural(unitsOut) {
  const results = [];
  const { shots } = NATURAL;
  for (const { label, s, ids, layout } of shots) {
    const file = path.join(OUT_TMP, `natural-${label}.png`);
    writeRgbPng(file, 256, 240, (x, y) => { const c = s.frameBuffer[y * 256 + x]; return [c & 0xff, (c >> 8) & 0xff, (c >> 16) & 0xff]; });
    for (const id of ids) {
      const u = unitsOut.find((e) => e.id === id);
      const src = u?.file ? u : unitsOut.find((e) => e.id === u?.sameAs);
      if (!src?.file) { results.push({ shot: label, unit: hex(id), result: "没有导出图" }); continue; }
      // 这台机体在不在当前画面里：名称表里它的图块（按 CHR bank 认）和镜头范围有没有交集
      const wb = unitWorldBox(s, unitRecord(id).bgBanks);
      const camX = s.scroll.x, inView = wb && ((wb.x - camX) & 511) < 256 - 8 || wb && ((wb.x + wb.w - 1 - camX) & 511) < 256;
      if (!inView) { results.push({ shot: label, layout: hex(layout), unit: hex(id), name: unitName(id), result: "不在画面里（远距离布局）" }); continue; }
      const png = PNG.sync.read(fs.readFileSync(path.join(ROOT, src.file)));
      // 在截图上半屏里找导出图的位置：比较不透明像素，落在过扫描黑边（四边 8 像素）里的不比
      let best = null;
      for (let oy = 0; oy + png.height <= STAGE[1]; oy++) for (let ox = 0; ox + png.width <= 256; ox++) {
        let bad = 0, opaque = 0;
        for (let y = 0; y < png.height && bad <= (best?.bad ?? 1e9); y++) for (let x = 0; x < png.width; x++) {
          const o = (y * png.width + x) * 4;
          const sx = ox + x, sy = oy + y;
          if (!png.data[o + 3] || sx < OVERSCAN || sx >= 256 - OVERSCAN || sy < OVERSCAN) continue;
          opaque++;
          const c = s.frameBuffer[sy * 256 + sx];
          if ((c & 0xff) !== png.data[o] || ((c >> 8) & 0xff) !== png.data[o + 1] || ((c >> 16) & 0xff) !== png.data[o + 2]) bad++;
        }
        if (!best || bad < best.bad) best = { x: ox, y: oy, bad, opaque };
        if (best.bad === 0) break;
      }
      results.push({ shot: label, layout: hex(layout), unit: hex(id), name: unitName(id), file: src.file, at: { x: best.x, y: best.y }, comparedPixels: best.opaque, diff: best.bad, exportScreen: u.screen });
    }
  }
  return results;
}

// ---------- 音效时间

// 每段攻击动画、爆炸里原版触发音效的帧（动画脚本 F4 和对象轨道都会写 $4C）。按已导出的 recorded 逐台重录
function extractSounds(doc) {
  const done = new Map(); // 动画名 → sounds
  for (const w of doc.weapons) {
    const ranged = w.layout === "ranged";
    for (const [res, side] of [[0x60, "right"], [0x61, "left"]]) {
      for (const v of w[side]?.recorded ?? []) {
        if (!v.anim) continue;
        process.stdout.write(`\r音效 武器 ${hex(w.id)} ${side} 机体 ${hex(v.unit)}            `);
        const partner = PARTNER[side === "right" ? "left" : "right"].find((p) => p !== v.unit);
        const sounds = [];
        recordAnim({
          setup(m) {
            m[0x7557 + (side === "right" ? SLOT_RIGHT : SLOT_LEFT)] = v.unit;
            m[0x7557 + (side === "right" ? SLOT_LEFT : SLOT_RIGHT)] = partner;
          },
          forceWeapon: side === "right" ? [0x82fc, 0xd7, w.id] : [0x83da, 0xd8, w.id],
          ranged,
          want: (aa) => aa === res,
          frames: side === "right" ? 300 : 520,
          sounds,
        });
        const prev = done.get(v.anim);
        if (prev && JSON.stringify(prev) !== JSON.stringify(sounds)) console.log(`\n${v.anim}：机体 ${hex(v.unit)} 的音效和别的机体不同`, JSON.stringify(prev), JSON.stringify(sounds));
        if (!prev) done.set(v.anim, sounds);
      }
    }
  }
  console.log();
  for (const [name, sounds] of done) doc.anims[name].sounds = sounds;
  for (const c of [
    { name: "explode-left", setup: (m) => { m[0x76b7 + SLOT_LEFT] = 1; m[0x76d7 + SLOT_LEFT] = 0; }, rolls: () => 0 },
    { name: "explode-right", setup: (m) => { m[0x76b7 + SLOT_RIGHT] = 1; m[0x76d7 + SLOT_RIGHT] = 0; }, rolls: (k) => (k === 0 ? 99 : 0) },
  ]) for (const ranged of [false, true]) {
    const sounds = [];
    recordAnim({ setup: c.setup, want: (aa) => aa === 0x62, rolls: c.rolls, frames: 900, ranged, sounds });
    doc.explosions[c.name + (ranged ? "-ranged" : "")].sounds = sounds;
  }
}

// ---------- 变形过场

// 原版地图菜单里的「变形」：先在地图上放现驾驶员的台词，然后切到战斗画面放一段演出，停住等按键，按键后回地图。
// 演出有两种（流程脚本在 bank 28 $84BE 起，38 02 xx = 放动画 0x62#xx）：
//   combine（盖塔式三段变形，0x62#0B）：网格地面、三架战机起飞、冲进星空纵向合体、整屏加亮到全白；
//     全白时画好新形态，再从白里一档一档淡出新形态的战斗大图
//   swap（两段变形，0x62#10）：现形态和新形态分别画在两个名称表上，镜头往一边卷（先慢后快），卷到新形态停住
// 两种都在动画开始前几帧切 1 号曲，回地图时切回地图曲。
//
// 录法：map-cursor 存档，把盖塔1（4 号槽位）换成要变形的机体（连同运行时的形态位、盖塔的主驾驶员），
// 走原版菜单（选中 → 变形 → 第 k 个形态），台词每 30 帧按一次 A，动画开始后不再按。

const TF_SLOT = 4;
const TF_H = 160; // 变形演出的画面布局和战斗不同：舞台到 y = 160，下面才是窗口（亮相时机体画得比战斗画面低）
const GETTER_TEAM = [8, 9, 10]; // 龙、隼人、武藏：盖塔式三段变形形态 1/2/3 的主驾驶员

// 亮相淡入：每档把颜色亮度托底到 floor。灰色（色号低 4 位 0）和黑色的亮度刻度比彩色高一级（00 = 1 … 30 = 4，0F = 0），
// 彩色 x1–xC 的亮度就是高 4 位；托底后灰色按 floor − 1 回到色号，彩色保留色相、亮度 = floor（最多 3）
export function fadeFromWhite(c, floor) {
  const hue = c & 0x0f, black = hue >= 0x0d;
  const grey = black || hue === 0;
  const level = black ? 0 : grey ? (c >> 4) + 1 : c >> 4;
  if (level >= floor) return c;
  return grey ? (floor - 1) << 4 : (Math.min(3, floor) << 4) | hue;
}

function recordTransform(fromId, option) {
  const emu = makeEmu(path.join(ROOT, "extracted/states/map-cursor.json"));
  const nes = emu.nes, m = nes.cpu.mem;
  const unit = UNITS.find((u) => u.id === fromId);
  m[0x7557 + TF_SLOT] = fromId;
  // 运行时的类型 / 形态位（机体表 +0 的低 6 位）也要换，原版菜单按它算能变成哪些形态
  const raw0 = parseInt(unit.raw.slice(0, 2), 16);
  m[0x77d7 + TF_SLOT] = (m[0x77d7 + TF_SLOT] & 0xc0) | (raw0 & 0x3f);
  if (unit.transform.kind === "triple") m[0x7537 + TF_SLOT] = GETTER_TEAM[unit.transform.formIndex - 1];
  const cap = attachCapture(emu);
  let f = 0, start = -1, animEnd = -1, anim = null;
  const frames = [], music = [], sounds = [];
  hookWrite(nes, (a, v) => {
    if (a === 0xad && m[0xaa] === 0x62 && start < 0) { start = f; anim = v; }
    // 音效：往 $4C 写 $01–$7F（帧号和 frames 同一计数）
    if (a === 0x4c && v >= 1 && v < 0x80 && start >= 0 && animEnd < 0) sounds.push([f - start, v]);
    if (a === 0xaa && v === 0 && start >= 0 && animEnd < 0) animEnd = f - start;
    if (a === 0x4c && v >= 0x80 && v < 0xf0) music.push([start < 0 ? null : f - start, v & 0x7f, f]);
  });
  let done = false;
  const step = (n) => {
    for (let i = 0; i < n && !done; i++) {
      cap.beginFrame();
      nes.frame();
      f++;
      if (start < 0) continue;
      const s = cap.snapshot();
      const { regs } = regsAtLine(s, 60);
      frames.push({ fb: s.frameBuffer.slice(0, 256 * TF_H), palette: Array.from(s.palette), regs: regs.join(), scroll: s.scroll.x, snap: frames.length ? null : s });
      // 动画结束后再录 40 帧（合体的亮相淡入在动画结束后约 25 帧内完成）
      if (animEnd >= 0 && frames.length > animEnd + 40) done = true;
    }
  };
  const press = (b) => { nes.buttonDown(1, b); step(6); nes.buttonUp(1, b); step(14); };
  const x = m[0x7597 + TF_SLOT], y = m[0x75b7 + TF_SLOT];
  for (let i = 0; i < 80 && (m[0xc0] !== x || m[0xc1] !== y); i++) {
    const b = m[0xc0] < x ? 7 : m[0xc0] > x ? 6 : m[0xc1] < y ? 5 : 4;
    nes.buttonDown(1, b); step(4); nes.buttonUp(1, b); step(10);
  }
  // 单位菜单：移动 / 精神 / 状态 / 变形（2×2），变形在右下
  step(20); press(0); step(30); press(7); press(5); press(0); step(30);
  for (let i = 0; i < option; i++) press(5);
  const pressed = f;
  press(0);
  for (let i = 0; i < 1500 && !done; i++) {
    if (start < 0 && i % 30 === 0) nes.buttonDown(1, 0);
    if (i % 30 === 6 || start >= 0) nes.buttonUp(1, 0);
    step(1);
  }
  // 切 1 号曲的帧（相对动画开始）
  const bgm = music.find(([, t, abs]) => t === 1 && abs >= pressed);
  return { frames, anim, animEnd, sounds, toId: m[0x7557 + TF_SLOT], music: bgm ? bgm[2] - (f - frames.length) : null };
}

// 全白之后的几次色板变化 = 亮相淡入的各档
function revealSteps(frames) {
  const allWhite = (p) => p.every((c) => c === 0x30);
  const whiteFrom = frames.findIndex((fr) => allWhite(fr.palette));
  if (whiteFrom < 0) return null;
  const steps = [];
  for (let i = whiteFrom + 1; i < frames.length; i++) {
    if (frames[i].palette.join() !== frames[i - 1].palette.join()) steps.push(i);
    if (steps.length === 4) break;
  }
  return steps.length === 4 ? { whiteFrom, steps } : null;
}

const unitFileOf = (() => {
  let sprites = null;
  return (id) => {
    sprites ??= JSON.parse(fs.readFileSync(path.join(ROOT, "data/battle-sprites.json"), "utf8")).units;
    let u = sprites.find((e) => e.id === id);
    for (let i = 0; i < 4 && u && !u.file && u.sameAs != null; i++) u = sprites.find((e) => e.id === u.sameAs);
    return u?.file ?? null;
  };
})();

function extractTransforms() {
  const groups = {};
  for (const u of UNITS) if (u.transform) (groups[u.transform.baseId] ??= []).push(u);
  const pairs = [];
  for (const list of Object.values(groups)) {
    // 盖塔式三段变形的形态 0 是全 0 的占位记录，菜单里不出现；菜单按形态顺序列出其余形态
    const forms = list.filter((u) => !(u.transform.kind === "triple" && u.transform.formIndex === 0));
    for (const u of forms) forms.filter((o) => o.id !== u.id).forEach((o, k) => pairs.push({ from: u.id, to: o.id, option: k }));
  }
  const variants = [];
  const out = [];
  const swapCameras = new Map();
  let combineTiming = null;
  for (const p of pairs) {
    process.stdout.write(`\r变形 ${hex(p.from)} → ${hex(p.to)}        `);
    const r = recordTransform(p.from, p.option);
    const row = { from: p.from, to: p.to };
    // 0x67–0x69、0xA7/0xA8 是敌方机体，放进我方槽位时菜单 / 色板对不上，玩家也不会操作它们变形
    if (r.toId !== p.to) { out.push({ ...row, error: `菜单第 ${p.option} 项变成了 ${hex(r.toId)}（敌方机体，不适用）` }); continue; }
    row.music = r.music;
    row.sounds = r.sounds;
    if (r.anim === 0x0b) {
      const rs = revealSteps(r.frames);
      if (!rs) { out.push({ ...row, error: "合体演出没录到亮相淡入" }); continue; }
      // 过场 = 动画开始到亮相淡入开始（含全白）。星空的星星位置每次随机，所以按每帧的色板和 CHR bank 分组
      // 色板在帧末写进 PPU，下一帧画面才变：淡入第一档在 steps[0] + 1 帧显示，过场到 steps[0] 为止
      const film = r.frames.slice(0, rs.steps[0] + 1);
      const key = film.map((fr) => fr.palette.join() + "/" + fr.regs).join("|");
      let v = variants.find((x) => x.key === key);
      if (!v) variants.push((v = { key, film, name: `combine-${variants.length}`, units: [] }));
      v.units.push(p.from);
      // 亮相：淡入结束后的画面里找新形态战斗大图的位置；按 fadeFromWhite 算出各档画面和原版逐像素比较
      const pos = locateUnit(p.to, r.frames[rs.steps[3] + 5].fb);
      let fadeDiff = null;
      // 色板在这一帧末尾才写进 PPU，画面下一帧才变，所以比后一帧
      if (pos) { fadeDiff = 0; for (let k = 0; k < 3; k++) fadeDiff += compareFade(pos, r.frames[rs.steps[k] + 1], 3 - k); }
      Object.assign(row, { kind: "combine", film: v.name, reveal: pos && { x: pos.x, y: pos.y }, fadeDiff });
      // fadeSteps：淡入各档实际显示的帧（托底 3、2、1、恢复原色）
      combineTiming ??= { animEnd: r.animEnd, whiteFrom: rs.whiteFrom + 1, fadeSteps: rs.steps.map((f) => f + 1) };
    } else if (r.anim === 0x10) {
      // 镜头：每帧上半屏卷动值（世界坐标里屏幕左边缘，两屏共 512 宽）
      const cam = r.frames.map((fr) => fr.scroll);
      const keys = [];
      cam.forEach((x, i) => { if (!i || x !== cam[i - 1]) keys.push([i, x]); });
      const camKey = JSON.stringify(keys);
      if (!swapCameras.has(camKey)) swapCameras.set(camKey, keys);
      // 两台机体在世界坐标里的位置：第 0 帧找现形态，最后一帧找新形态
      const a = locateUnit(p.from, r.frames[0].fb), b = locateUnit(p.to, r.frames.at(-1).fb);
      const world = (pos, c) => pos && { x: (pos.x + c) & 511, y: pos.y };
      const from = world(a, cam[0]), to = world(b, cam.at(-1));
      // 核对：按「黑底 + 两张图 − 镜头」重画每一帧，和模拟器画面逐像素比较
      let diff = null;
      if (!from || !to) { out.push({ ...row, error: "画面上找不到机体（敌方机体放进我方槽位色板不对，不适用）" }); continue; }
      if (from && to) { diff = 0; r.frames.forEach((fr, i) => { if (i < r.animEnd) diff += compareSwap(p.from, from, p.to, to, cam[i], fr.fb); }); }
      Object.assign(row, { kind: "swap", camera: [...swapCameras.keys()].indexOf(camKey), fromAt: from, toAt: to, animEnd: r.animEnd, diff });
    } else {
      out.push({ ...row, error: `没见过的动画 0x62#${hex(r.anim ?? 0)}` });
      continue;
    }
    out.push(row);
  }
  console.log();
  // 合体过场：每种逐帧去重（同一画面只存一次），256×116 一格，每行 8 格
  const films = {};
  for (const v of variants) {
    const uniq = [], seq = [];
    for (const fr of v.film) {
      let h = 0;
      for (let i = 0; i < fr.fb.length; i++) h = (h * 31 + fr.fb[i]) | 0;
      let idx = uniq.findIndex((u) => u.h === h);
      if (idx < 0) { idx = uniq.length; uniq.push({ h, fb: fr.fb }); }
      const last = seq.at(-1);
      if (last && last[0] === idx) last[1]++;
      else seq.push([idx, 1]);
    }
    const COLS = 8, Wd = 256, Ht = TF_H;
    const file = `assets/original/battle/transform/${v.name}.png`;
    writeRgbPng(path.join(ROOT, file), COLS * Wd, Math.ceil(uniq.length / COLS) * Ht, (x, y) => {
      const u = uniq[Math.floor(y / Ht) * COLS + Math.floor(x / Wd)];
      if (!u) return [0, 0, 0];
      const c = u.fb[(y % Ht) * 256 + (x % Wd)];
      return [c & 0xff, (c >> 8) & 0xff, (c >> 16) & 0xff];
    });
    films[v.name] = { file, frameSize: { w: Wd, h: Ht }, columns: COLS, uniqueFrames: uniq.length, totalFrames: v.film.length, frames: seq, units: v.units.map((id) => hex(id)) };
  }
  return { combine: { films, timing: combineTiming }, swapCameras: [...swapCameras.values()], pairs: out };
}

// 在画面上找机体战斗大图（不透明像素全部一致的位置；过扫描黑边里的不比）
function locateUnit(id, fb) {
  const file = unitFileOf(id);
  if (!file) return null;
  const png = PNG.sync.read(fs.readFileSync(path.join(ROOT, file)));
  for (let oy = 0; oy + png.height <= TF_H; oy++) for (let ox = -png.width + 16; ox < 256 - 16; ox++) {
    let bad = 0, seen = 0;
    for (let y = 0; y < png.height && !bad; y++) for (let x = 0; x < png.width; x++) {
      const o = (y * png.width + x) * 4;
      const sx = ox + x;
      if (!png.data[o + 3] || sx < OVERSCAN || sx >= 256 - OVERSCAN) continue;
      seen++;
      const c = fb[(oy + y) * 256 + sx];
      if ((c & 0xff) !== png.data[o] || ((c >> 8) & 0xff) !== png.data[o + 1] || ((c >> 16) & 0xff) !== png.data[o + 2]) { bad++; break; }
    }
    if (!bad && seen > 50) return { x: ox, y: oy, file };
  }
  return null;
}

// 两段变形的一帧：黑底上按世界坐标 − 镜头画两张图（世界 512 宽首尾相接），和模拟器画面比较
function compareSwap(fromId, fromAt, toId, toAt, cam, fb) {
  const imgs = [[PNG.sync.read(fs.readFileSync(path.join(ROOT, unitFileOf(fromId)))), fromAt], [PNG.sync.read(fs.readFileSync(path.join(ROOT, unitFileOf(toId)))), toAt]];
  const want = new Uint32Array(256 * TF_H).fill(NES_COLORS[0x0f] & 0xffffff);
  for (const [png, at] of imgs) for (let y = 0; y < png.height; y++) for (let x = 0; x < png.width; x++) {
    const o = (y * png.width + x) * 4;
    if (!png.data[o + 3]) continue;
    const sx = (((at.x + x - cam) % 512) + 512) % 512, sy = at.y + y;
    if (sx >= 256 || sy >= TF_H) continue;
    want[sy * 256 + sx] = png.data[o] | (png.data[o + 1] << 8) | (png.data[o + 2] << 16);
  }
  let diff = 0;
  for (let y = OVERSCAN; y < TF_H; y++) for (let x = OVERSCAN; x < 256 - OVERSCAN; x++) if ((fb[y * 256 + x] & 0xffffff) !== want[y * 256 + x]) diff++;
  return diff;
}

// 淡入某一档：图片像素反查色号 → fadeFromWhite → 和模拟器画面比较（背景色也按同样规则）
function compareFade(pos, frame, floor) {
  const png = PNG.sync.read(fs.readFileSync(path.join(ROOT, pos.file)));
  const toNes = new Map();
  for (let c = 0x3f; c >= 0; c--) toNes.set(NES_COLORS[c] & 0xffffff, c);
  const backdrop = NES_COLORS[fadeFromWhite(0x0f, floor)] & 0xffffff;
  let diff = 0;
  for (let y = OVERSCAN; y < TF_H; y++) for (let x = OVERSCAN; x < 256 - OVERSCAN; x++) {
    let want = backdrop;
    const px = x - pos.x, py = y - pos.y;
    if (px >= 0 && py >= 0 && px < png.width && py < png.height) {
      const o = (py * png.width + px) * 4;
      if (png.data[o + 3]) {
        const rgb = png.data[o] | (png.data[o + 1] << 8) | (png.data[o + 2] << 16);
        want = NES_COLORS[fadeFromWhite(toNes.get(rgb), floor)] & 0xffffff;
      }
    }
    if ((frame.fb[y * 256 + x] & 0xffffff) !== want) diff++;
  }
  return diff;
}

// ---------- 主程序

const argv = process.argv.slice(2);
const wi = argv.indexOf("--weapons");
const ONLY_WEAPONS = wi >= 0 ? argv.splice(wi, 2)[1].split(",").map((v) => parseInt(v, 16)) : null;
const args = new Set(argv);
const all = args.size === 0 && !ONLY_WEAPONS;
fs.mkdirSync(OUT_TMP, { recursive: true });

const spritesFile = path.join(ROOT, "data/battle-sprites.json");
let NATURAL = null; // 真实战斗的截图和动画（--verify 时录）
const effectsFile = path.join(ROOT, "data/battle-effects.json");

if (all || args.has("--units")) {
  const units = extractUnits();
  const doc = {
    note: "战斗画面机体大图。机体编号 = 资源 0x86 下标（data/units.json）。图 = 背景图块层（1KB CHR bank，按资源 0x21 排列脚本画到名称表）+ 叠色精灵层（资源 0x41 元精灵，2KB CHR bank）。side = 原版画在哪一侧（记录标志 bit6：1 = 左侧，0 = 右侧），facing = 图朝向；原版不翻转，同一台机体只有一张图。screen = 原版画面上的左上角坐标（已减去上半屏卷动 32），origin = 叠色精灵对象坐标（特效脚本的锚点）在图内的位置。tiles.rows 是背景图块号（-- = 没画），tiles.origin 是第一格相对图左上角的位置。sprites 是叠色精灵（x/y 相对图左上角）。sameAs = 和该编号的图完全相同。格式见 docs/notes-battle-gfx.md",
    resources: { record: "0x89（bank 4）", layout: "0x21（bank 8，画面脚本）", overlay: "0x41（bank 10，元精灵）" },
    units,
  };
  fs.writeFileSync(spritesFile, stringify(doc) + "\n");
  const ok = units.filter((u) => u.check);
  console.log(`机体：${units.length} 个编号，导出 ${units.filter((u) => u.file).length} 张图，上半屏渲染不一致 ${ok.filter((u) => u.check.stageDiff).length} 个，未稳定 ${ok.filter((u) => !u.check.stable).length} 个`);
}

if (all || args.has("--effects") || args.has("--timing") || ONLY_WEAPONS) {
  const prev = fs.existsSync(effectsFile) ? JSON.parse(fs.readFileSync(effectsFile, "utf8")) : {};
  const doc = {
    note: "战斗动画。武器编号 = 资源 0x87 下标（data/weapons.json）。每把武器两份脚本：right = 资源 0x60（攻方在右侧，即我方机体），left = 资源 0x61（攻方在左侧）。recorded 列出实际录到的机体和动画名；同一脚本在不同机体上画面一样时共用一个动画。anims[名].effectFile = 特效精灵层关键帧横排（每帧 frameSize），stageFile = 整个上半屏关键帧（每行 4 帧，256×116）。keyframes：start/duration 是帧数（60 帧 = 1 秒），sprites 坐标相对攻方锚点，shake = 卷动偏移（震屏），palette = 色板变化后的 32 色，bgChanged = 背景图块被改。命中和落空的动画完全一样（判定在动画之后），击破时另播爆炸动画（资源 0x62）。格式见 docs/notes-battle-gfx.md",
    ...prev,
  };
  if (all || args.has("--effects") || ONLY_WEAPONS) {
    const { weapons, anims } = extractEffects();
    doc.weapons = weapons;
    doc.anims = anims;
    if (!ONLY_WEAPONS) doc.explosions = extractExplosions();
  }
  if (all || args.has("--timing")) {
    doc.timing = {
      note: "t4 开战（第 0 帧按下 A）后的事件帧号。player = 每 20 帧按一次 A（按住 6 帧），mash = 每 4 帧按一次（最快），idle = 只按开战那一次（看哪里停下等按键），rangedPlayer = 同 player 但强制远距离布局。远距离时萨斯剑脚本照样播（实际游戏里萨斯剑不会远距离用，只看流程）",
      player: measureTiming("player"), mash: measureTiming("mash"), idle: measureTiming("idle"), rangedPlayer: measureTiming("player", true),
    };
  }
  if (ONLY_WEAPONS) console.log(JSON.stringify(doc.weapons, null, 1).slice(0, 3000), JSON.stringify(Object.values(doc.anims).map((a) => ({ name: a.name, keyframes: a.keyframes.map((k) => `${k.start}+${k.duration}${k.sprites ? "*" + k.sprites.length : ""}${k.camera ? " cam" + JSON.stringify(k.camera) : ""}${k.palette ? " pal" : ""}${k.bgChanged ? " bg" : ""}${k.overlayHidden ? " hide" : ""}`) }))));
  else fs.writeFileSync(effectsFile, stringify(doc) + "\n");
  if (doc.weapons) {
    const bad = Object.values({ ...doc.anims, ...doc.explosions }).filter((a) => a.check.stageDiff);
    console.log(`武器：${doc.weapons.length} 把，动画 ${Object.keys(doc.anims).length} 个，整屏渲染不一致 ${bad.length} 个${bad.length ? "：" + bad.map((a) => a.name ?? "").join(" ") : ""}`);
  }
}

if (args.has("--transform")) {
  const doc = JSON.parse(fs.readFileSync(effectsFile, "utf8"));
  const t = extractTransforms();
  doc.transform = {
    note: "地图菜单「变形」的原版演出。pairs[] 每个变形组合：kind = combine（盖塔式三段变形，动画 0x62#0B）或 swap（两段变形，0x62#10），music = 切 1 号曲的帧（相对动画开始）。combine：film = 用哪段过场（combine.films，frames = [唯一帧序号, 连续帧数]…，唯一帧按 columns 列排在 file 里，从动画开始到亮相淡入开始，含整屏加亮和全白），reveal = 新形态战斗大图在上半屏的位置，之后按 combine.timing.fadeSteps 的帧逐档淡入（托底亮度 3、2、1，第 4 档恢复原色，规则见 docs/notes-battle-gfx.md），fadeDiff = 按规则重画和原版不同的像素数。swap：fromAt / toAt = 现形态、新形态的图在世界坐标（两屏 512 宽）里的位置，camera = swapCameras 里第几条镜头轨迹（[帧, 屏幕左边缘的世界 x]…），diff = 按模型重画动画期间每帧和原版不同的像素总数。两种演出最后都停住等按键",
    ...t,
  };
  fs.writeFileSync(effectsFile, stringify(doc) + "\n");
  const ok = t.pairs.filter((p) => !p.error);
  const bad = ok.filter((p) => (p.kind === "combine" ? p.fadeDiff : p.diff) !== 0);
  console.log(`变形：${t.pairs.length} 个组合，合体 ${ok.filter((p) => p.kind === "combine").length}（过场 ${Object.keys(t.combine.films).length} 种），两段 ${ok.filter((p) => p.kind === "swap").length}（镜头轨迹 ${t.swapCameras.length} 种），重画不一致 ${bad.length}，失败 ${t.pairs.length - ok.length}`);
}

if (args.has("--sounds")) {
  const doc = JSON.parse(fs.readFileSync(effectsFile, "utf8"));
  extractSounds(doc);
  fs.writeFileSync(effectsFile, stringify(doc) + "\n");
  const all = Object.values(doc.anims);
  console.log(`音效：${all.filter((a) => a.sounds?.length).length} / ${all.length} 个动画有音效`);
}

if (all || args.has("--verify")) {
  NATURAL = naturalBattles(6);
  const fxRes = verifyEffects(JSON.parse(fs.readFileSync(effectsFile, "utf8")));
  console.table(fxRes);
  const units = JSON.parse(fs.readFileSync(spritesFile, "utf8")).units;
  const res = verifyNatural(units);
  console.table(res.map((r) => ({ ...r, file: r.file?.split("/").pop(), at: r.at ? `${r.at.x},${r.at.y}` : "", exportScreen: r.exportScreen ? `${r.exportScreen.x},${r.exportScreen.y}` : "" })));
  const bg = verifyBackground();
  console.log("背景：", bg.map((b) => `${b.case}:${b.stageDiff}`).join(" "));
  fs.writeFileSync(path.join(OUT_TMP, "verify.json"), JSON.stringify({ natural: res, effects: fxRes, background: bg }, null, 1));
}
