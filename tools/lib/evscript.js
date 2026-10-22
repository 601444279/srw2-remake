// 事件 / AI 脚本解释器（bank 26 $8192）的离线反汇编，详见 docs/notes-events.md。
// 指令 = 首字节 & 0x7F：
//   0x00–0x3F 条件：结果放在 $FE bit7（1 = 假）。首字节 bit7 = 0 时先把结果清成「真」再判断，
//             bit7 = 1 表示和前一个条件取「与」（前面已经为假就保持假）
//   0x40–0x7F 动作：首字节 bit7 = 1 表示做完这条后暂停，下次调用从下一条继续
// OPS 里 args 是参数名（addr16 占 2 字节），host = 交给主流程做的动作（对话、出场动画等）
import { prgByte } from "./trace.js";

// 事件脚本数据在 bank 26（$8000）/ 27（$A000）
export const evRead = (a) => (a < 0xa000 ? prgByte(26, a) : prgByte(27, a));
export const evWord = (a) => evRead(a) | (evRead(a + 1) << 8);

// 各类脚本的入口表（bank 26/27）
export const TABLES = {
  start: 0x93a5, // 按关卡号：开场，之后每个我方回合开始时继续
  enemyPhase: 0x9721, // 按关卡号：每个敌方回合开始时继续
  check: 0xa49c, // 按关卡号：每次行动结束后继续（胜负判定、过关）
  npc: 0xadfc, // 友军 NPC（单位槽 11–13）的行动脚本，按 $7777
  ai: 0xaf83, // 敌人 AI 脚本，按 $7777
  persuade: 0xb4e9, // 劝降脚本，按劝降表的序号
  tile: 0xb784, // 踩格子触发的脚本
};

export const OPS = {
  0x00: { name: "turnIs", args: ["turn"] },
  0x01: { name: "flag", args: ["flag"] },
  0x02: { name: "unitBit", args: ["pilot", "bit"] },
  0x03: { name: "inRoster", args: ["pilot"] },
  0x04: { name: "exists", args: ["pilot"] },
  0x05: { name: "onMap", args: ["pilot"] },
  0x06: { name: "enemiesAtLeast", args: ["n"] },
  0x07: { name: "alliesAtLeast", args: ["n"] },
  0x08: { name: "counter", args: ["counter"] },
  0x09: { name: "hpAtLeast", args: ["pilot", "hp"] },
  0x0a: { name: "allyInRect", args: ["x1", "y1", "x2", "y2"] },
  0x0b: { name: "enemyInRect", args: ["x1", "y1", "x2", "y2"] },
  0x0c: { name: "unitAt", args: ["x", "y", "who"] },
  0x0d: { name: "selfBit", args: ["bit"] },
  0x0e: { name: "selfAdjacent", args: ["who"] },
  0x0f: { name: "selfAt", args: ["x", "y"] },
  0x10: { name: "selfInRect", args: ["x1", "y1", "x2", "y2"] },
  0x11: { name: "foeWithin", args: ["dist"] },
  0x12: { name: "selfHpAtLeast", args: ["hp"] },
  0x13: { name: "battle", args: ["attacker", "defender", "mask", "value"] },
  0x14: { name: "aiApproach", args: [] },
  0x15: { name: "aiApproachUnit", args: ["pilot"] },
  0x16: { name: "aiApproachUnit2", args: ["pilot"] },
  0x17: { name: "aiMoveNear", args: ["x", "y", "range"] },
  0x18: { name: "aiMoveTo", args: ["x", "y"] },
  0x19: { name: "aiMoveToFar", args: ["x", "y"] },
  0x1a: { name: "aiPickAttack", args: ["mode"] },
  0x1b: { name: "aiAttackUnit", args: ["pilot"] },
  0x1c: { name: "aiPickAttackNot", args: ["mode", "pilot"] },
  0x1d: { name: "aiMapWeapon", args: [] },
  0x1e: { name: "select", args: ["pilot"] },
  0x40: { name: "talk", args: ["face", "res", "script"], host: true },
  0x41: { name: "talkAt", args: ["pilot", "res", "script"], host: true },
  0x42: { name: "talkCursor", args: ["pilot", "res", "script"], host: true },
  0x43: { name: "window", args: ["mode"], host: true, len: (b) => (b[1] === 0x0b || b[1] === 0x0c ? 3 : 2) },
  0x44: { name: "narrate", args: ["res", "script"], host: true },
  0x45: { name: "closeWindow", args: [], host: true },
  0x46: { name: "cursorTo", args: ["x", "y"], host: true },
  0x47: { name: "cameraUnit", args: ["pilot"], host: true },
  0x48: { name: "cursorUnit", args: ["pilot"], host: true },
  0x49: { name: "setVar", args: ["index", "value"] },
  0x4a: { name: "spawnNpc", args: ["x", "y", "pilot", "mech", "level", "script"], host: true },
  0x4b: { name: "spawnEnemy", args: ["x", "y", "pilot", "mech", "level", "ai"], host: true },
  0x4c: { name: "deployAlly", args: ["x", "y", "roster", "ai"], host: true },
  0x4d: { name: "changePilotMech", args: ["pilot", "newPilot", "mech"] },
  0x4e: { name: "changeMech", args: ["pilot", "mech"] },
  0x4f: { name: "countUp", args: ["counter"] },
  0x50: { name: "money", args: ["lo", "hi"] },
  0x51: { name: "setFlag", args: ["flag"] },
  0x52: { name: "clearFlag", args: ["flag"] },
  0x53: { name: "setUnitBit", args: ["pilot", "bit"] },
  0x54: { name: "clearUnitBit", args: ["pilot", "bit"] },
  0x55: { name: "jump", args: ["addr16"] },
  0x56: { name: "not", args: [] },
  0x57: { name: "jumpIfTrue", args: ["addr16"] },
  0x58: { name: "jumpIfFalse", args: ["addr16"] },
  0x59: { name: "playerBgm", args: ["track"] },
  0x5a: { name: "enemyBgm", args: ["track"] },
  0x5b: { name: "bgm", args: ["track"] },
  0x5c: { name: "host5C", args: ["value"], host: true },
  0x5d: { name: "host5D", args: ["value"], host: true },
  0x5e: { name: "wait", args: ["n"], host: true },
  0x5f: { name: "stop", args: [] },
  0x60: { name: "setSelfBit", args: ["bit"] },
  0x61: { name: "clearSelfBit", args: ["bit"] },
  0x62: { name: "aiExec", args: [], host: true },
  0x63: { name: "endAction", args: [], host: true },
  0x64: { name: "selectCamera", args: ["pilot"], host: true },
  0x65: { name: "moveSelf", args: ["x", "y"], host: true },
  0x66: { name: "morphSelf", args: ["mech"], host: true },
  0x67: { name: "toNpc", args: [], host: true },
  0x68: { name: "toEnemy", args: [], host: true },
  0x69: { name: "toAlly", args: ["roster"], host: true },
  0x6a: { name: "destroySelf", args: [], host: true },
  0x6b: { name: "removeSelf", args: [], host: true },
  0x6c: { name: "actor", args: [] },
  0x6d: { name: "host6D", args: ["a", "b", "c", "d"], host: true },
  0x6e: { name: "rosterRemove", args: ["roster"] },
  0x6f: { name: "rosterAdd", args: ["roster", "pilot", "mech", "level"] },
  0x70: { name: "levelUp", args: ["roster", "n"] },
  0x71: { name: "stageClear", args: [], host: true },
  0x72: { name: "gameOver", args: [], host: true },
  0x73: { name: "ending", args: [], host: true },
};

export const isCond = (op) => op < 0x40;

export function opLen(bytes) {
  const op = OPS[bytes[0] & 0x7f];
  if (!op) return null;
  if (op.len) return op.len(bytes);
  return 1 + op.args.reduce((n, a) => n + (a === "addr16" ? 2 : 1), 0);
}

// 解码 addr 处的一条指令
export function decodeAt(a, read = evRead) {
  const b0 = read(a);
  const op = OPS[b0 & 0x7f];
  if (!op) return { addr: a, raw: [b0], op: b0 & 0x7f, name: null, args: {} };
  const raw = Array.from({ length: 7 }, (_, i) => read(a + i));
  const len = opLen(raw);
  const ins = { addr: a, raw: raw.slice(0, len), op: b0 & 0x7f, hi: !!(b0 & 0x80), name: op.name, args: {} };
  let k = 1;
  for (const n of op.args) {
    if (n === "addr16") { ins.args.to = raw[k] | (raw[k + 1] << 8); k += 2; } else if (k < len) { ins.args[n] = raw[k]; k++; }
  }
  if (op.name === "window" && len === 3) ins.args.face = raw[2];
  return ins;
}

// 从 start 开始沿着跳转把可达指令都走一遍，返回按地址排序的指令列表
export function disasmScript(start, read = evRead) {
  const out = new Map();
  const todo = [start];
  while (todo.length) {
    let a = todo.pop();
    while (!out.has(a)) {
      const ins = decodeAt(a, read);
      out.set(a, ins);
      if (!ins.name) break;
      if (ins.op === 0x55) { todo.push(ins.args.to); break; }
      if (ins.op === 0x57 || ins.op === 0x58) todo.push(ins.args.to);
      if (ins.op === 0x5f) break;
      a += ins.raw.length;
    }
  }
  return [...out.values()].sort((x, y) => x.addr - y.addr);
}
