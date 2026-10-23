// 实测母舰「搭载」「起飞」：第 1 关里让一台机体移动到怀特（母舰）的格子 / 旁边，截图看菜单和结果。
// 用法: node tools/carrier-probe.js onto|beside
import path from "node:path";
import { makeEmu, ROOT } from "./lib/trace.js";
import { runScript } from "./emu.js";

const mode = process.argv[2] ?? "onto";
const emu = makeEmu();
const nes = emu.nes, m = nes.cpu.mem;
const shot = (n) => emu.screenshot(path.join(ROOT, `extracted/shots/carrier-${mode}-${n}.png`));
const units = () => [...Array(11).keys()].filter((i) => m[0x7537 + i]).map((i) => `${i}:p${m[0x7537 + i]}@${m[0x7597 + i]},${m[0x75b7 + i]}`).join(" ");
runScript(emu, "wait 600\npress start\nwait 180\n");
for (let i = 0; i < 300; i++) { emu.press("a"); emu.frames(20); if (m[0x7537] && i > 30) break; }
emu.frames(120); emu.press("b"); emu.frames(10);
console.log("开始", units());
const cursorTo = (x, y) => { for (let i = 0; i < 80 && (m[0xc0] !== x || m[0xc1] !== y); i++) emu.press(m[0xc0] < x ? "right" : m[0xc0] > x ? "left" : m[0xc1] < y ? "down" : "up", 4); };
// swap：0 号槽换成普通机体（刚达 9），把母舰机体（怀特 161）给 2 号槽，看「搭载」认槽还是认机体
if (mode === "swap") { m[0x7557] = 9; m[0x7557 + 2] = 161; }
if (mode === "slot0") m[0x7557] = 9; // 只把 0 号槽换成普通机体
const shipSlot = mode === "swap" ? 2 : 0;
const ship = { x: m[0x7597 + shipSlot], y: m[0x75b7 + shipSlot] };
// 离母舰最近的另一台我方
const other = [...Array(10).keys()].map((k) => k + 1).filter((i) => m[0x7537 + i] && i !== shipSlot).sort((a, b) => (Math.abs(m[0x7597 + a] - ship.x) + Math.abs(m[0x75b7 + a] - ship.y)) - (Math.abs(m[0x7597 + b] - ship.x) + Math.abs(m[0x75b7 + b] - ship.y)))[0];
console.log("母舰", ship, "移动的单位槽", other, `@${m[0x7597 + other]},${m[0x75b7 + other]}`);
const fields = (i) => Array.from({ length: 24 }, (_, f) => m[0x7537 + f * 0x20 + i].toString(16).padStart(2, "0")).join(" ");
// 先把它的 HP 压到 50，看在舰内回多少血
m[0x76b7 + other] = 50; m[0x76d7 + other] = 0;
const hp = (i) => m[0x76b7 + i] | (m[0x76d7 + i] << 8);
console.log("字段（$7537 起每 $20）搭载前", fields(other), "HP", hp(other));
cursorTo(m[0x7597 + other], m[0x75b7 + other]); emu.frames(30);
emu.press("a"); emu.frames(30); shot("1-menu");
emu.press("a"); emu.frames(40); shot("2-range");
const dest = mode !== "beside" ? ship : { x: ship.x - 1, y: ship.y };
cursorTo(dest.x, dest.y); emu.frames(20); shot("3-cursor");
emu.press("a"); emu.frames(90); shot("4-after-move");
console.log("移动后", units());
emu.press("a"); emu.frames(90); shot("5-after-a");
console.log("按 A 后", units());
console.log("字段 搭载后        ", fields(other), "HP", hp(other));
console.log("母舰字段          ", fields(0));
// 选母舰，看菜单
cursorTo(ship.x, ship.y); emu.frames(20);
emu.press("a"); emu.frames(40); shot("6-ship-menu");
emu.press("b"); emu.frames(20);

if (mode === "shipmove") {
  cursorTo(ship.x, ship.y); emu.frames(20);
  emu.press("a"); emu.frames(30); emu.press("a"); emu.frames(40);
  cursorTo(ship.x - 2, ship.y); emu.frames(20); emu.press("a"); emu.frames(90); shot("s1-ship-moved");
  console.log("母舰移动后", units(), "舱内 $77D7", m[0x77d7 + other].toString(16));
  emu.press("a"); emu.frames(60);
}
if (mode === "shipdie") {
  m[0x76b7] = 1; m[0x76d7] = 0;
  const e = [...Array(18).keys()].map((k) => k + 14).find((i) => m[0x7537 + i]);
  const ex = ship.x - 1, ey = ship.y;
  m[0x6c00 + m[0x75b7 + e] * 32 + m[0x7597 + e]] &= 0x7f;
  m[0x7597 + e] = ex; m[0x75b7 + e] = ey; m[0x6c00 + ey * 32 + ex] = 0x80 | e;
  console.log("敌人槽", e, "贴到", ex, ey);
}
// 结束回合（同 verify-events.js：空格上 A → 系统菜单 → 回合结束 → 是），一直按 A 直到我方第 2 回合
const emptyCell = () => {
  let best = null;
  for (let y = 0; y < m[0xc7]; y++) for (let x = 0; x < m[0xc6]; x++) {
    if (m[0x6c00 + y * 32 + x] & 0x80) continue;
    const d = Math.abs(x - m[0xc0]) + Math.abs(y - m[0xc1]);
    if (!best || d < best[2]) best = [x, y, d];
  }
  return best;
};
const t0 = m[0x750c];
for (let k = 0; k < 400 && m[0x750c] === t0; k++) {
  if (k % 12 === 0) { emu.press("b"); emu.frames(4); const c = emptyCell(); if (c) cursorTo(c[0], c[1]); }
  emu.press("a"); emu.frames(16);
}
for (let k = 0; k < 60; k++) emu.frames(10);
if (mode === "shipdie") shot("d1-after-enemy");
console.log("第 2 回合", units(), "母舰 HP", hp(0), "母舰 $77D7", m[0x77d7].toString(16), "回合", m[0x750c] + 1, "舱内 HP", hp(other), "$77D7", m[0x77d7 + other].toString(16), "$7737", m[0x7737 + other].toString(16));
emu.press("b"); emu.frames(10);
cursorTo(m[0x7597], m[0x75b7]); emu.frames(20);
emu.press("a"); emu.frames(40); shot("7-ship-menu-t2");
emu.press("right"); emu.frames(10); emu.press("a"); emu.frames(40); shot("8-launch");
console.log("选起飞后", units(), "$77D7", m[0x77d7 + other].toString(16));
emu.press("a"); emu.frames(40); shot("9-launch-a");
console.log("再按 A", units(), "$77D7", m[0x77d7 + other].toString(16), "光标", m[0xc0], m[0xc1]);
cursorTo(ship.x - 2, ship.y - 1); emu.frames(20);
emu.press("a"); emu.frames(90); shot("10-after-launch-move");
console.log("起飞移动后", units(), "$77D7", m[0x77d7 + other].toString(16), "$7737", m[0x7737 + other].toString(16));
for (let k = 0; k < 6; k++) { emu.frames(30); }
shot("11-after-shout");
console.log("台词后", units(), "$77D7", m[0x77d7 + other].toString(16), "$7737", m[0x7737 + other].toString(16));
emu.press("a"); emu.frames(90); shot("12-after-shout-a");
console.log("再按 A", units(), "$77D7", m[0x77d7 + other].toString(16), "$7737", m[0x7737 + other].toString(16));
