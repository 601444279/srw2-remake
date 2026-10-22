// 用模拟器跑一关，记录事件脚本实际执行到的指令、单位出场、名册变化、过关，和 data/events 的导出对照。
//
// 用法: node tools/verify-events.js <关卡 1–26> [选项]
//   --turns N        最多打到第 N 回合（默认 30）
//   --wipe N         第 N 回合我方阶段把敌人全部移除（直接清 $7537，测试「全歼」过关）
//   --set ADDR=VAL   开局时改 RAM（16 进制，可多个），例如 --set 7416=80 置全程标志 0
//   --shots          每回合截图到 extracted/shots/ev-NN-tTT.png
//   --save NAME      结束时存档到 extracted/states/NAME.json
// 关卡 1 从开机正常进入；其他关卡在关卡初始化（bank 2 $8107）时把 $7411 改成目标关卡（名册仍是开局的 6 人）。
// 我方单位每帧回满 HP，回合结束靠在空格上连按 A（系统菜单 → 回合结束 → 是）。
import fs from "node:fs";
import path from "node:path";
import { makeEmu, hookExec, trackBanks, ROOT } from "./lib/trace.js";
import { runScript } from "./emu.js";
import { TABLES, disasmScript, evWord } from "./lib/evscript.js";

const args = process.argv.slice(2);
const stage = Number(args[0]);
const opt = (k, d) => { const i = args.indexOf(k); return i < 0 ? d : args[i + 1]; };
const maxTurns = Number(opt("--turns", 30));
const wipeTurn = Number(opt("--wipe", 0));
const shots = args.includes("--shots");
const sets = args.flatMap((a, i) => (args[i - 1] === "--set" ? [a.split("=").map((x) => parseInt(x, 16))] : []));
const hex = (v, n = 4) => v.toString(16).toUpperCase().padStart(n, "0");
const NAMES = JSON.parse(fs.readFileSync(path.join(ROOT, "data/script/names.json"), "utf8")).tables;
const pilotName = (i) => NAMES[1].items[i]?.text || `人物${i}`;
const mechName = (i) => NAMES[3].items[i]?.text || `机体${i}`;

// 地址 → 所属脚本
const owner = new Map();
const mark = (label, entry) => { for (const i of disasmScript(entry)) if (!owner.has(i.addr)) owner.set(i.addr, { label, ins: i }); };
const s0 = stage - 1;
for (const k of ["start", "enemyPhase", "check"]) mark(k, evWord(TABLES[k] + 2 * s0));
// AI 先标：NPC 脚本会跳进 AI 脚本的公共尾巴（例如 NPC 7 → AI 10 的 $B176）
for (let n = 0; n < 34; n++) mark(`ai${n}`, evWord(TABLES.ai + 2 * n));
for (let n = 0; n < 11; n++) { mark(`npc${n}`, evWord(TABLES.npc + 2 * n)); mark(`persuade${n}`, evWord(TABLES.persuade + 2 * n)); }
for (let n = 0; n < 6; n++) mark(`tile${n}`, evWord(TABLES.tile + 2 * n));

const emu = makeEmu();
const nes = emu.nes, m = nes.cpu.mem;
const slots = trackBanks(nes);
let frame = 0;
const of = nes.frame.bind(nes);
const log = (...a) => console.log(`[f${frame} 回合${m[0x750c] + 1}]`, ...a);
const units = () => Array.from({ length: 32 }, (_, i) => (m[0x7537 + i] ? [m[0x7537 + i], m[0x7557 + i], m[0x7577 + i], m[0x7597 + i], m[0x75b7 + i]].join(",") : ""));
let before = null, roster = null, lastEv = null, cleared = 0, over = 0;
const rosterNow = () => Array.from({ length: 16 }, (_, i) => (m[0x743c + i] ? `${i}:${pilotName(m[0x743c + i])}/${mechName(m[0x744c + i])}/L${m[0x745c + i] + 1}` : "")).filter(Boolean).join(" ");
nes.frame = () => {
  frame++;
  const r = of();
  if (m[0x7411] === s0 && before) {
    // 我方回满 HP
    for (let i = 0; i < 11; i++) if (m[0x7537 + i]) { m[0x76b7 + i] = m[0x76f7 + i]; m[0x76d7 + i] = m[0x7717 + i]; }
    const now = units();
    for (let i = 0; i < 32; i++) if (now[i] !== before[i] && now[i]) {
      const [p, mech, lv, x, y] = now[i].split(",").map(Number);
      const was = before[i] ? before[i].split(",").map(Number) : null;
      if (!was || was[0] !== p || was[1] !== mech) log(`单位槽 ${i}${was ? "（变化）" : " 出现"}：${pilotName(p)} / ${mechName(mech)} / 等级 ${lv + 1} @ (${x},${y})`);
    } else if (!now[i] && before[i]) log(`单位槽 ${i} 消失：${pilotName(Number(before[i].split(",")[0]))}`);
    before = now;
  }
  const rn = rosterNow();
  if (roster !== null && rn !== roster) log(`名册：${rn}`);
  roster = rn;
  return r;
};
hookExec(nes, (pc) => {
  if (pc === 0x81a8 && slots[0] === 26) {
    const a = m[0xfc] | (m[0xfd] << 8);
    const o = owner.get(a);
    const key = `${o?.label}@${hex(a)}`;
    if (key === lastEv) return; // 同一条指令连续执行（暂停在跳转上）只记一次
    lastEv = key;
    if (!o) { log(`事件 ?? $${hex(a)}`); return; }
    if (o.label.startsWith("ai")) return; // AI 脚本太多，不记
    const i = o.ins;
    if (i.name === "jumpIfFalse" || i.name === "jumpIfTrue" || i.name === "jump") return;
    log(`${o.label} $${hex(a)} ${i.name} ${JSON.stringify(i.args).replace(/"/g, "")}`);
    if (i.name === "stageClear") cleared++;
    if (i.name === "gameOver") over++;
  }
  if (pc === 0x8107 && slots[0] === 2 && stage > 1 && !before) { m[0x7411] = s0; }
});

runScript(emu, "wait 600\npress start\nwait 180\n");
const emptyCell = () => {
  let best = null;
  for (let y = 0; y < m[0xc7]; y++) for (let x = 0; x < m[0xc6]; x++) {
    if (m[0x6c00 + y * 32 + x] & 0x80) continue;
    const d = Math.abs(x - m[0xc0]) + Math.abs(y - m[0xc1]);
    if (!best || d < best[2]) best = [x, y, d];
  }
  return best;
};
const cursorTo = (x, y) => { for (let i = 0; i < 60 && (m[0xc0] !== x || m[0xc1] !== y); i++) emu.press(m[0xc0] < x ? "right" : m[0xc0] > x ? "left" : m[0xc1] < y ? "down" : "up", 4); };

// 等开场对话结束、地图出现（单位表里有我方 0 号）
for (let i = 0; i < 200 && !(m[0x7411] === s0 && m[0x7537] && m[0x750c] === 0 && m[0x7521] | m[0x7522]) ; i++) { emu.press("a"); emu.frames(20); if (m[0x7537] && m[0x7411] === s0) break; }
for (const [a, v] of sets) m[a] = v;
before = units();
log(`关卡 ${stage} 开始，$7411=${m[0x7411]}，我方 ${before.slice(0, 11).filter(Boolean).length}，敌人 ${before.slice(14).filter(Boolean).length}`);
log(`名册：${roster}`);

let wiped = false;
while (m[0x750c] + 1 <= maxTurns && !cleared && !over) {
  const t0 = m[0x750c];
  if (wipeTurn && t0 + 1 >= wipeTurn && !wiped) {
    for (let i = 14; i < 32; i++) m[0x7537 + i] = 0;
    wiped = true; log("（移除全部敌人）");
  }
  if (shots) emu.screenshot(path.join(ROOT, `extracted/shots/ev-${String(stage).padStart(2, "0")}-t${t0 + 1}.png`));
  // 结束回合：B 取消 → 光标到空格 → A A A；之后一直按 A 推进对话，直到回合数变化
  for (let k = 0; k < 400 && m[0x750c] === t0 && !cleared && !over; k++) {
    if (k % 12 === 0) {
      emu.press("b"); emu.frames(4);
      const c = emptyCell(); if (c) cursorTo(c[0], c[1]);
    }
    emu.press("a"); emu.frames(16);
  }
}
for (let k = 0; k < 60 && cleared; k++) { emu.press("a"); emu.frames(20); }
log(`结束：过关 ${cleared}，全灭 ${over}，$7411=${m[0x7411]}，过关位图 ${hex(m[0x7412], 2)}${hex(m[0x7413], 2)}${hex(m[0x7414], 2)}${hex(m[0x7415], 2)}`);
const save = opt("--save");
if (save) emu.save(path.join(ROOT, `extracted/states/${save}.json`));
