// 体验问题测量：在第一关按常见操作一步步走，记录每一步画面多久才稳定、中间有多少黑屏帧，
// 并截图到 extracted/shots/ux/场景-序号-名字.png。结果用于 docs/ux-issues.md。
//
// 用法: node tools/ux-probe.js            （需要 extracted/states/map-cursor.json）
// 每步：按键后逐帧比较画面，连续 30 帧不变视为稳定；全屏平均亮度很低的帧算黑屏。
import path from "node:path";
import { makeEmu, ROOT, hookWrite, hookExec, trackBanks } from "./lib/trace.js";
import { runScript } from "./emu.js";
import { Controller } from "jsnes";

const KEYS = { a: Controller.BUTTON_A, b: Controller.BUTTON_B, start: Controller.BUTTON_START, select: Controller.BUTTON_SELECT, up: Controller.BUTTON_UP, down: Controller.BUTTON_DOWN, left: Controller.BUTTON_LEFT, right: Controller.BUTTON_RIGHT };

export function createProbe(state, prefix = "ux") {
  const emu = makeEmu(state);
  const nes = emu.nes;
  const origFrame = nes.frame.bind(nes);
  // 直接读 PPU 的画面缓冲（tools/emu.js 的 onFrame 存在闭包里拿不到）
  const sig = () => {
    const b = nes.ppu.buffer;
    let sum = 0, hash = 0;
    for (let i = 0; i < b.length; i += 7) { const c = b[i]; sum += (c & 0xff) + ((c >> 8) & 0xff) + ((c >> 16) & 0xff); hash = (hash * 31 + c) | 0; }
    return { bright: sum / (b.length / 7) / 3, hash };
  };
  let n = 0;
  const steps = [];
  const probe = {
    emu, nes,
    // 按键（hold 帧）后最多等 max 帧，直到画面连续 stable 帧不变
    step(name, keys, { hold = 6, max = 600, stable = 30, shot = true } = {}) {
      let frames = 0, black = 0, longestBlack = 0, run = 0, lastHash = null, same = 0;
      const tick = () => {
        origFrame(); frames++;
        const s = sig();
        if (s.bright < 4) { black++; run++; longestBlack = Math.max(longestBlack, run); } else run = 0;
        if (s.hash === lastHash) same++; else { same = 0; lastHash = s.hash; }
      };
      for (const k of [].concat(keys)) {
        // 每个键之前先等画面稳定，否则原版会吞掉按键（菜单滑出时按 A 无效）
        if (k.startsWith("wait")) { const w = Number(k.slice(4)); for (let i = 0; i < w; i++) tick(); continue; }
        nes.buttonDown(1, KEYS[k]);
        for (let i = 0; i < hold; i++) tick();
        nes.buttonUp(1, KEYS[k]);
        for (let i = 0; i < 2; i++) tick();
      }
      while (frames < max && same < stable) tick();
      // 到上限还没稳定，多半是光标、提示符在闪，等待时间没有意义
      const settle = same >= stable ? frames - same : null;
      const file = `${prefix}-${String(++n).padStart(2, "0")}-${name}`;
      if (shot) emu.screenshot(path.join(ROOT, "extracted/shots/ux", `${file}.png`));
      const r = { step: n, name, keys: [].concat(keys).join(" "), settleFrames: settle, settleSec: settle === null ? "闪烁中" : +(settle / 60).toFixed(2), blackFrames: black, longestBlack, shot: shot ? `${file}.png` : null };
      steps.push(r);
      return r;
    },
    cursorTo(x, y) {
      const m = nes.cpu.mem;
      for (let i = 0; i < 80 && (m[0xc0] !== x || m[0xc1] !== y); i++) {
        const k = m[0xc0] < x ? "right" : m[0xc0] > x ? "left" : m[0xc1] < y ? "down" : "up";
        nes.buttonDown(1, KEYS[k]); for (let j = 0; j < 4; j++) origFrame(); nes.buttonUp(1, KEYS[k]); for (let j = 0; j < 10; j++) origFrame();
      }
      if (m[0xc0] !== x || m[0xc1] !== y) throw new Error(`光标没到 (${x},${y})`);
      for (let j = 0; j < 20; j++) origFrame();
    },
    steps,
  };
  return probe;
}

const brightness = (nes) => { const b = nes.ppu.buffer; let s = 0; for (let i = 0; i < b.length; i += 97) s += b[i] & 0xff; return s / (b.length / 97); };

// 从存档出发，先跑 pre 脚本，再按一个键，返回之后 150 帧的黑屏条
function blackStrip(state, pre, key) {
  const emu = makeEmu(state), nes = emu.nes;
  if (pre) runScript(emu, pre.split(";").join("\n"));
  nes.buttonDown(1, KEYS[key]);
  let out = "";
  for (let f = 0; f < 150; f++) { if (f === 6) nes.buttonUp(1, KEYS[key]); nes.frame(); out += brightness(nes) < 4 ? "#" : "."; }
  return out;
}

// t4 存档开战，每 10 帧按 A：两次 HP 变化的帧、黑屏段
function fastBattle() {
  const emu = makeEmu(path.join(ROOT, "extracted/states/t4.json")), nes = emu.nes;
  let f = 0; const hp = [], black = []; let start = -1;
  hookWrite(nes, (a) => { if (a >= 0x76d7 && a < 0x76f7) hp.push(f); });
  for (; f < 600; f++) {
    if (f % 10 === 0) nes.buttonDown(1, KEYS.a); if (f % 10 === 6) nes.buttonUp(1, KEYS.a);
    nes.frame();
    const blk = brightness(nes) < 4;
    if (blk && start < 0) start = f; else if (!blk && start >= 0) { black.push([start, f]); start = -1; }
  }
  return { hpFrames: hp, blackSegments: black, endFrame: black.at(-1)?.[1] };
}

// e2 存档按 A 结束回合，之后不按键：每个敌人轮到 / 移动的帧，回合数变化的帧，黑屏帧数
function enemyPhase() {
  const emu = makeEmu(path.join(ROOT, "extracted/states/e2.json")), nes = emu.nes, m = nes.cpu.mem;
  const slots = trackBanks(nes);
  let f = 0, black = 0, end = null; const turns = [], moves = [];
  hookExec(nes, (pc) => { if (pc === 0x9208 && slots[0] === 24) turns.push([nes.cpu.REG_ACC, f]); });
  hookWrite(nes, (a) => { if (a >= 0x75b7 && a < 0x75d7) moves.push([a - 0x75b7, f]); if (a === 0x750c && end === null) end = f; });
  nes.buttonDown(1, KEYS.a);
  for (; f < 1500; f++) { if (f === 6) nes.buttonUp(1, KEYS.a); nes.frame(); if (brightness(nes) < 4) black++; }
  return { turns, moves, endFrame: end, blackFrames: black };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const MAP = path.join(ROOT, "extracted/states/map-cursor.json");
  const all = [];
  // 每个场景都从存档重新开始，互不影响
  const scene = (prefix, state, fn) => { const p = createProbe(state, prefix); fn(p); all.push(...p.steps.map((s) => ({ scene: prefix, ...s }))); };

  scene("ux-menu", MAP, (p) => {
    p.step("选中单位出菜单", "a");
    p.step("光标移到状态", "down");
    p.step("打开状态", "a");
    p.step("关闭状态", "b");
  });
  scene("ux-spirit", MAP, (p) => {
    p.step("选中单位出菜单", "a");
    p.step("光标移到精神", "right");
    p.step("打开精神菜单", "a");
  });
  scene("ux-enemy", MAP, (p) => {
    p.cursorTo(10, 5);
    p.step("光标停在敌人上", "wait1");
    p.step("按 A 看敌人", "a");
  });
  scene("ux-move", MAP, (p) => {
    p.step("选中单位出菜单", "a");
    p.step("进入移动", "a", { stable: 60 });
    p.cursorTo(10, 16);
    p.step("确认目的地", "a", { stable: 60 });
    p.step("待命", "a");
  });
  scene("ux-turn", MAP, (p) => {
    p.cursorTo(10, 15);
    p.step("空地按 A 出系统菜单", "a");
    p.step("回合结束", "a");
    p.step("确认（敌方回合开始）", "a", { max: 120 });
  });
  scene("ux-battle", path.join(ROOT, "extracted/states/t4.json"), (p) => {
    p.step("返回武器菜单", "b");
    p.step("选萨斯剑", "a");
    p.step("光标移到敌人", "up");
    p.step("开战", "a", { stable: 40 });
    for (let i = 1; i <= 5; i++) p.step(`战斗信息-${i}`, "a", { stable: 40 });
  });
  console.log("\n黑屏条（# = 黑屏帧，. = 有画面，从按键那一帧起 150 帧）");
  console.log("打开状态  ", blackStrip(MAP, "press a;wait 40;press down;wait 10", "a"));
  console.log("关闭状态  ", blackStrip(MAP, "press a;wait 40;press down;wait 10;press a;wait 90", "b"));
  console.log("进入战斗  ", blackStrip(path.join(ROOT, "extracted/states/t4.json"), "", "a"));
  console.log("\n最快打完一场（每 10 帧按一次 A）", JSON.stringify(fastBattle()));
  console.log("第 1 回合敌方阶段（不按键）", JSON.stringify(enemyPhase()));
  console.table(all.map(({ scene, name, settleFrames, settleSec, blackFrames, longestBlack, shot }) => ({ scene, name, settleFrames, settleSec, blackFrames, longestBlack, shot })));
}
