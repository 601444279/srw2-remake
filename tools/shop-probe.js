// 实测地图商店（events tiles 里的 shop）：进第 N 关（改 $7411），把我方一个单位放到格子 (x, y−1)，走到 (x, y) 选「待命」，
// 记录商店例程（bank 10 $9625 开店、$97AF 选购、$9854 付款）、资金 $743A、持有数 $741A，逐步截图，
// 最后在商店里存档 extracted/states/shop-N.json，之后可以用 tools/emu.js --from 接着按键。
// 用法: node tools/shop-probe.js 2 9 8 [按键序列，如 "a,down,a"]
import path from "node:path";
import { makeEmu, hookExec, trackBanks, ROOT } from "./lib/trace.js";
import { runScript } from "./emu.js";

const [stage, tx, ty] = process.argv.slice(2, 5).map(Number);
const keys = (process.argv[5] ?? "").split(",").filter(Boolean);
const s0 = stage - 1;

const emu = makeEmu();
const nes = emu.nes, m = nes.cpu.mem;
const slots = trackBanks(nes);
let frame = 0, entered = false;
const of = nes.frame.bind(nes);
nes.frame = () => { frame++; return of(); };
const log = (...a) => console.log(`[f${frame}]`, ...a);
const money = () => m[0x743a] | (m[0x743b] << 8);
const inv = () => [...Array(24).keys()].map((i) => m[0x741a + i]).map((v, i) => (v ? `${i}:${v}` : "")).filter(Boolean).join(" ") || "无";
hookExec(nes, (pc) => {
  if (pc === 0x8107 && slots[0] === 2 && !entered) m[0x7411] = s0;
  if (slots[0] !== 10) return;
  if (pc === 0x95a2) log(`格子检查 $95A2，当前单位 $CD=${m[0xcd]}`);
  if (pc === 0x9625) log(`开店 $9625，商店 ${m[0xf7]}`);
  if (pc === 0x97af) log(`选购 $97AF，光标 $87=${m[0x87]}`);
  if (pc === 0x9854) log(`付款 $9854，零件 ${m[0xf7]}，资金 ${money()}`);
  if (pc === 0x806e) log(`用零件 $806E，零件 ${m[0xf7]}，光标 $87=${m[0x87]}`);
});

runScript(emu, "wait 600\npress start\nwait 180\n");
for (let i = 0; i < 300; i++) { emu.press("a"); emu.frames(20); if (m[0x7537] && m[0x7411] === s0 && i > 20) break; }
entered = true;
emu.frames(120);
// 等开场对话放完：光标能动了才算进入我方回合
for (let i = 0; i < 200; i++) {
  const c = m[0xc0];
  emu.press("right", 4); emu.frames(10);
  if (m[0xc0] !== c) { emu.press("left", 4); emu.frames(10); break; }
  emu.press("a"); emu.frames(30);
}
emu.press("b"); emu.frames(10);
m[0x743a] = 0x0f; m[0x743b] = 0x27; // 资金 9999
// 预置持有零件：环境变量 INV="16:1,18:2"（零件号:个数）
for (const kv of (process.env.INV ?? "").split(",").filter(Boolean)) { const [i, n] = kv.split(":").map(Number); m[0x741a + i] = n; }
// HURT=1：我方 1、2 号槽 HP 降到 50、精神清零，方便看回复类零件
if (process.env.HURT) for (const i of [1, 2]) { m[0x76b7 + i] = 50; m[0x76d7 + i] = 0; m[0x7822 + i] = 0; }
const slot = [...Array(11).keys()].find((i) => m[0x7537 + i]);
const ox = m[0x7597 + slot], oy = m[0x75b7 + slot];
m[0x6c00 + (ty - 1) * 32 + tx] = m[0x6c00 + oy * 32 + ox];
m[0x6c00 + oy * 32 + ox] &= 0x7f;
m[0x7597 + slot] = tx; m[0x75b7 + slot] = ty - 1;
log(`我方槽 ${slot}（驾驶员 ${m[0x7537 + slot]}）放到 (${tx},${ty - 1})，资金 ${money()}，持有 ${inv()}`);
const shot0 = () => emu.screenshot(path.join(ROOT, `extracted/shots/shop-${stage}-start.png`));
const cursorTo = (x, y) => { for (let i = 0; i < 80 && (m[0xc0] !== x || m[0xc1] !== y); i++) emu.press(m[0xc0] < x ? "right" : m[0xc0] > x ? "left" : m[0xc1] < y ? "down" : "up", 4); };
log(`光标起点 (${m[0xc0]},${m[0xc1]})`); shot0();
cursorTo(tx, ty - 1);
emu.frames(60);
log(`光标 (${m[0xc0]},${m[0xc1]})，占用 ${m[0x6c00 + (ty - 1) * 32 + tx].toString(16)}`);
const shot = (n) => emu.screenshot(path.join(ROOT, `extracted/shots/shop-${stage}-${n}.png`));
shot("00-cursor");
emu.press("a"); emu.frames(30); shot("01-unitmenu"); emu.press("a"); emu.frames(40); shot("02-move");
emu.press("down", 4); emu.frames(10);
emu.press("a"); emu.frames(120);
shot("0-menu");
log("选「待命」"); emu.press("down", 4); emu.frames(10); emu.press("a"); emu.frames(240);
shot("1-open");
emu.save(path.join(ROOT, `extracted/states/shop-${stage}.json`));
keys.forEach((k, i) => {
  emu.press(k); emu.frames(60);
  shot(`k${i + 1}-${k}`);
  const u = [...Array(11).keys()].filter((i) => m[0x7537 + i]).map((i) => `${i}:HP${m[0x76b7 + i] | (m[0x76d7 + i] << 8)}/${m[0x76f7 + i] | (m[0x7717 + i] << 8)} SP${m[0x7822 + i]} 旗${m[0x7817 + i].toString(16)}`).join(" ");
  log(`按 ${k}：资金 ${money()}，持有 ${inv()}，光标 (${m[0xc0]},${m[0xc1]})，${u}`);
});
