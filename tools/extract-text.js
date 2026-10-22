// 从 ROM 提取剧情文本：字库、脚本指针表、对话脚本、名字表。
//
// 用法: node tools/extract-text.js [rom/srw2.nes]
// 输出:
//   data/script/res-XX.json        每个文本资源一个文件，按脚本编号列出对话
//   data/script/stages.json        按关卡排列的对话（来自关卡事件脚本）
//   data/script/names.json         人物、机体、武器、精神指令等名字表
//   data/script/misc.json          其他文字片段（菜单、系统消息、说明、职员表）
//   extracted/text/all.txt         全部对话的纯文本，方便通读校对（以下都不进仓库）
//   extracted/text/glyphs-N.png    剧情用到的字形总表，每格标编码，顺序见 order.txt
//   extracted/text/glyphs-extra.png 字库里剧情没用到的字，顺序见 order-extra.txt
//   extracted/text/unknown.png     对照表里还没有的字形
//   extracted/text/codes.json      脚本里用到的全部编码及出现次数
// 对照表 data/charmap.json 是人工识别的结果，这个脚本只读不写。
//
// 编码格式、控制码、指针表见 docs/notes-text.md。
import fs from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT = path.join(ROOT, "extracted/text");

// 资源表：固定 bank $F3E2（PRG 0x3F3E2），每个资源 2 字节：
//   第 1 字节 d：bank = (d >> 3) & 0x1E（8KB bank 号，$8000 装 bank、$A000 装 bank+1），d & 0x0F = 一级指针表下标
//   第 2 字节：资源类型，3 = 文本脚本
const RESOURCE_TABLE = 0x3f3e2;
const RESOURCE_COUNT = 0x8a;
const TYPE_TEXT = 3;

// 字库：12×12 点阵，每字 18 字节，在 8KB bank 0x14/0x15（引导字节 bit4 = 0）或 0x16/0x17（bit4 = 1）
const GLYPH_OFFSETS = 0x28ff0; // bank 0x14 的 $8FF0：页内 14 个字的偏移（0x12 递增）
const GLYPH_LAST = 0xdbc9; // 最后一个字，DBCA 以后是别的数据

// 控制码及其参数字节数。EE 和 F0–FF 以外、小于 0xC9 的字节是单字节图块
const CONTROL_ARGS = {
  0xee: 1, 0xf0: 1, 0xf1: 0, 0xf2: 0, 0xf3: 0, 0xf4: 1, 0xf5: 1, 0xf6: 0,
  0xf7: 2, 0xf8: 1, 0xf9: 1, 0xfa: 1, 0xfb: 1, 0xfc: 2, 0xfd: 1, 0xfe: 2, 0xff: 0,
};

export function loadRom(file) {
  const rom = fs.readFileSync(file);
  const prgSize = rom[4] * 0x4000;
  return { prg: rom.subarray(16, 16 + prgSize), chr: rom.subarray(16 + prgSize) };
}

const word = (buf, off) => buf[off] | (buf[off + 1] << 8);
const hex = (v, n = 2) => v.toString(16).toUpperCase().padStart(n, "0");

// 双字节字：引导字节 0xC9–0xEF（EE 除外），编码写成 4 位十六进制，如 "CAB6"
export const isLead = (b) => b >= 0xc9 && b < 0xf0 && b !== 0xee;

// 字形地址：code 左移 4 位后的高字节是页（$90–$BF），低 4 位查页内偏移表
export function glyphOffset(prg, code) {
  const hi = code >> 8, lo = code & 0xff;
  const bank = hi & 0x10 ? 0x16 : 0x14;
  const page = ((hi & 0x0f) << 4) | (lo >> 4);
  const cpu = (page << 8) | prg[GLYPH_OFFSETS + (lo & 0x0f)];
  if (cpu < 0x8000 || cpu >= 0xc000) return -1;
  return bank * 0x2000 + (cpu - 0x8000);
}

// 每字 3 列，每列 4 像素宽、6 字节；每字节高 4 位是上一行、低 4 位是下一行。位为 0 是笔画
export function decodeGlyph(prg, code) {
  const off = glyphOffset(prg, code);
  const pixels = new Uint8Array(144);
  if (off < 0) return null;
  for (let col = 0; col < 3; col++) {
    for (let i = 0; i < 6; i++) {
      const b = prg[off + col * 6 + i];
      for (let x = 0; x < 4; x++) {
        pixels[(i * 2) * 12 + col * 4 + x] = (b >> (7 - x)) & 1 ? 0 : 1;
        pixels[(i * 2 + 1) * 12 + col * 4 + x] = (b >> (3 - x)) & 1 ? 0 : 1;
      }
    }
  }
  return pixels;
}

// 字库里全部非空白的字：引导字节 C9–CB、D9–DB，低字节的低 4 位 0–D
export function allGlyphCodes(prg) {
  const codes = [];
  for (const lead of [0xc9, 0xca, 0xcb, 0xd9, 0xda, 0xdb]) {
    for (let lo = 0; lo < 256; lo++) {
      if ((lo & 0x0f) > 0x0d) continue;
      const code = (lead << 8) | lo;
      if (code > GLYPH_LAST) break;
      if (decodeGlyph(prg, code).some((p) => p)) codes.push(code);
    }
  }
  return codes;
}

export function textResources(prg) {
  const list = [];
  for (let id = 0; id < RESOURCE_COUNT; id++) {
    const d = prg[RESOURCE_TABLE + id * 2];
    const type = prg[RESOURCE_TABLE + id * 2 + 1];
    if ((type & 0xc7) !== TYPE_TEXT) continue;
    const bank = (d >> 3) & 0x1e;
    const base = bank * 0x2000;
    const cpuToPrg = (a) => base + (a - 0x8000);
    const table = word(prg, cpuToPrg(0x8000 + (d & 0x0f) * 2));
    list.push({ id, bank, index: d & 0x0f, table, cpuToPrg });
  }
  // 二级表的项数没有记录：一直读到第一个脚本的开头，或者同一 bank 里下一张表的开头为止
  for (const res of list) {
    let end = Math.min(...list.filter((r) => r.bank === res.bank && r.table > res.table).map((r) => r.table));
    res.entries = [];
    for (let a = res.table; a < end; a += 2) {
      const p = word(prg, res.cpuToPrg(a));
      if (p < 0x8000 || p >= 0xc000) break;
      res.entries.push(p);
      if (p > res.table) end = Math.min(end, p);
    }
  }
  // 没用到的项指向数据区末尾的 00 填充或别的表，记成 null
  const tables = new Set(list.map((r) => r.table));
  for (const res of list) {
    res.entries = res.entries.map((p) => (tables.has(p) || prg[res.cpuToPrg(p)] === 0 ? null : p));
  }
  return list;
}

// 把一段脚本按控制流解成指令序列。F7 是跳转，F8 是随机分支，FF 是结束 / 返回
export function parseScript(prg, res, start) {
  const ops = new Map(); // CPU 地址 → 指令
  const queue = [start];
  while (queue.length) {
    let a = queue.pop();
    while (!ops.has(a)) {
      const o = res.cpuToPrg(a);
      const b = prg[o];
      let op;
      if (isLead(b)) op = { kind: "char", code: (b << 8) | prg[o + 1], size: 2 };
      else if (b in CONTROL_ARGS) {
        const n = CONTROL_ARGS[b];
        op = { kind: "ctrl", code: b, args: Array.from(prg.subarray(o + 1, o + 1 + n)), size: 1 + n };
        if (b === 0xf8) {
          op.targets = [];
          for (let i = 0; i < op.args[0]; i++) op.targets.push(word(prg, o + 2 + i * 2));
          op.size += op.args[0] * 2;
        }
      } else op = { kind: "tile", code: b, size: 1 };
      op.addr = a;
      op.prg = o;
      ops.set(a, op);
      if (op.kind === "ctrl") {
        if (op.code === 0xff) break;
        if (op.code === 0xf7) { queue.push(word(prg, o + 1)); break; }
        if (op.code === 0xf8) { queue.push(...op.targets); break; }
      }
      a += op.size;
    }
  }
  return ops;
}

// ---------- 对照表与文本 ----------

export function loadCharmap() {
  const file = path.join(ROOT, "data/charmap.json");
  if (!fs.existsSync(file)) return { glyphs: {}, tiles: {}, uncertain: {} };
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

// 认不出的字写成〔编码〕
function opText(op, charmap) {
  if (op.kind === "char") return charmap.glyphs[hex(op.code, 4)] ?? `〔${hex(op.code, 4)}〕`;
  return charmap.tiles[hex(op.code)] ?? `〔${hex(op.code)}〕`;
}

const ctrlText = (op) => `{${hex(op.code)}${op.args.length ? ":" + op.args.map((a) => hex(a)).join(" ") : ""}}`;
const prgHex = (o) => "0x" + hex(o, 5);

// 「名字：」加换行开头的是对话，拆出说话人
function splitSpeaker(text) {
  const m = text.match(/^([^：\n]{1,8})：\s*\n/);
  return m ? { speaker: m[1], text: m[1] ? text.slice(m[0].length) : text } : { speaker: null, text };
}

// 按控制流把一段脚本整理成消息列表。F6（等按键）、F1、F3、FF 结束一条消息；
// F9 换头像（编号记在下一条消息上）；F8 随机选一个分支；F7 跳转，跳回已经出现过的位置时记成 goto
export function decodeEntry(prg, res, start, charmap) {
  const ops = parseScript(prg, res, start);
  const visited = new Set();
  const walk = (addr) => {
    const nodes = [];
    let msg = null, face = null;
    const flush = () => {
      if (msg && msg.text.trim()) {
        const { speaker, text } = splitSpeaker(msg.text);
        nodes.push({
          offset: prgHex(msg.offset), ...(face !== null && { face }), speaker, text: text.replace(/\s+$/, ""), raw: msg.raw,
          ...(msg.text.includes("〔") && { garbled: true }),
        });
        face = null;
      }
      msg = null;
    };
    const add = (op, text) => {
      msg ??= { offset: op.prg, text: "", raw: "" };
      msg.text += text;
      msg.raw += op.kind === "ctrl" ? ctrlText(op) : text;
    };
    for (;;) {
      if (visited.has(addr)) { flush(); nodes.push({ goto: prgHex(res.cpuToPrg(addr)) }); break; }
      visited.add(addr);
      const op = ops.get(addr);
      if (op.kind !== "ctrl") add(op, opText(op, charmap));
      else if (op.code === 0xf2) add(op, "\n");
      else if (op.code === 0xf0) add(op, "{参数}");
      else if (op.code === 0xf9) { if (msg) add(op, ""); flush(); face = op.args[0]; }
      else if ([0xf6, 0xf1, 0xf3].includes(op.code)) { if (msg) add(op, ""); flush(); }
      else if (op.code === 0xff) { flush(); break; }
      else if (op.code === 0xf7) { addr = word(prg, op.prg + 1); continue; }
      else if (op.code === 0xf8) {
        flush();
        nodes.push({ offset: prgHex(op.prg), random: op.targets.map((t) => walk(t)) });
        break;
      } else if (op.code === 0xfc) {
        flush();
        nodes.push({ offset: prgHex(op.prg), call: op.args.map((a) => (a === 0xff ? "参数" : "0x" + hex(a))) });
      } else add(op, "");
      addr += op.size;
    }
    flush();
    return nodes;
  };
  return walk(start);
}

// ---------- 导出 ----------

function writePng(file, width, height, pixel) {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = pixel(x, y);
      const i = (y * width + x) * 4;
      png.data[i] = png.data[i + 1] = png.data[i + 2] = v;
      png.data[i + 3] = 255;
    }
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, PNG.sync.write(png));
}

// 3×5 小数字字体，用来在总表里标编码
const DIGITS = {
  0: "111101101101111", 1: "010110010010111", 2: "111001111100111", 3: "111001111001111",
  4: "101101111001001", 5: "111100111001111", 6: "111100111101111", 7: "111001001001001",
  8: "111101111101111", 9: "111101111001111", A: "010101111101101", B: "110101110101110",
  C: "111100100100111", D: "110101101101110", E: "111100111100111", F: "111100111100100",
};

// 字形总表：每格上方 4 位编码、下方放大 3 倍的字形
function glyphSheet(file, prg, codes, perRow = 16) {
  const scale = 3, cellW = 42, cellH = 46;
  const rows = Math.ceil(codes.length / perRow);
  const img = new Uint8Array(perRow * cellW * rows * cellH).fill(255);
  const W = perRow * cellW;
  codes.forEach((code, n) => {
    const cx = (n % perRow) * cellW, cy = Math.floor(n / perRow) * cellH;
    hex(code, 4).split("").forEach((ch, k) => {
      const bits = DIGITS[ch];
      for (let i = 0; i < 15; i++) if (bits[i] === "1") img[(cy + 1 + Math.floor(i / 3)) * W + cx + 2 + k * 4 + (i % 3)] = 120;
    });
    const g = decodeGlyph(prg, code);
    if (!g) return;
    for (let y = 0; y < 12; y++) {
      for (let x = 0; x < 12; x++) {
        if (!g[y * 12 + x]) continue;
        for (let a = 0; a < scale; a++) for (let b = 0; b < scale; b++) img[(cy + 8 + y * scale + a) * W + cx + 2 + x * scale + b] = 0;
      }
    }
  });
  writePng(file, W, rows * cellH, (x, y) => img[y * W + x]);
}

// ---------- 名字表与其他文字 ----------

// 机体名、武器名、人物名、精神指令等是资源表里类型 1 的资源，FF 结尾的字符串，和剧情用同一套编码。
// 下标就是游戏里的编号（人物编号同时是对话头像编号）。项数没有记录，按指针自动判断，个别表手动给出
const NAME_RESOURCES = {
  0x10: { name: "强化零件" },
  0x11: { name: "人物" },
  0x12: { name: "人物（第二份）" },
  0x13: { name: "机体" },
  0x14: { name: "武器" },
  0x15: { name: "地形、菜单、精神指令", count: 35 }, // 0–2 地形，3–11 地图菜单，14–15 驾驶员 / 舰长，16 起精神指令
  0x16: { name: "机体说明：高度（m）" },
  0x17: { name: "机体说明：重量（t）" },
};

function decodeString(prg, o, charmap, end = o + 80) {
  let text = "";
  while (o < end && prg[o] !== 0xff) {
    const b = prg[o];
    if (isLead(b)) { text += opText({ kind: "char", code: (b << 8) | prg[o + 1] }, charmap); o += 2; }
    else { text += opText({ kind: "tile", code: b }, charmap); o++; }
  }
  return text;
}

function nameTables(prg, charmap) {
  const list = Object.keys(NAME_RESOURCES).map(Number).map((id) => {
    const d = prg[RESOURCE_TABLE + id * 2];
    const base = ((d >> 3) & 0x1e) * 0x2000;
    return { id, base, table: word(prg, base + (d & 0x0f) * 2) };
  });
  return list.map((r) => {
    const { name, count } = NAME_RESOURCES[r.id];
    let end = Math.min(...list.filter((x) => x.base === r.base && x.table > r.table).map((x) => x.table));
    const ptrs = [];
    for (let a = r.table; count ? ptrs.length < count : a < end; a += 2) {
      const p = word(prg, r.base + a - 0x8000);
      const ok = p >= 0x8000 && p < 0xc000;
      if (!ok && !count) break;
      ptrs.push(ok ? p : null);
      if (ok && p > r.table) end = Math.min(end, p);
    }
    return {
      resource: "0x" + hex(r.id),
      name,
      table: prgHex(r.base + r.table - 0x8000),
      items: ptrs.map((p, index) => {
        const o = r.base + p - 0x8000;
        const text = p === null ? "〔" : decodeString(prg, o, charmap).trim();
        // 指向非文字数据的是没用的编号
        return text.includes("〔") ? { index, offset: null, text: null } : { index, offset: prgHex(o), text };
      }),
    };
  });
}

// 剧情脚本以外的文字片段：菜单、系统消息、说明、职员表等。这些由另一套文本引擎（$8C 指针）显示，
// 控制码和剧情不同，还没逐条解析，这里只按「至少两个连续汉字」扫出来，方便查找
function scanFragments(prg, covered, charmap) {
  const isGlyph = (o) => isLead(prg[o]) && charmap.glyphs[hex((prg[o] << 8) | prg[o + 1], 4)] !== undefined;
  const isPunct = (b) => charmap.tiles[hex(b)] !== undefined && b !== 0xaf;
  const fragments = [];
  // 跳过字库本体（bank 0x14–0x17 里 $9000 以后的部分）
  const inFont = (o) => (o >= 0x29000 && o < 0x2c000) || (o >= 0x2d000 && o < 0x30000);
  for (let o = 0; o < prg.length - 1;) {
    if (covered.has(o) || inFont(o) || !isGlyph(o)) { o++; continue; }
    let e = o, glyphs = 0;
    while (e < prg.length - 1 && !covered.has(e)) {
      if (isGlyph(e)) { glyphs++; e += 2; } else if (isPunct(prg[e]) || prg[e] === 0xaf) e++; else break;
    }
    const text = decodeString(prg, o, charmap, e).trimEnd();
    if (glyphs >= 2 && !text.includes("〔")) fragments.push({ offset: prgHex(o), text, end: hex(prg[e]) });
    o = e;
  }
  return fragments;
}

// ---------- 关卡事件脚本 → 对话 ----------

// 关卡事件脚本在 8KB bank 0x1A/0x1B（$8000/$A000），按关卡号（RAM $7411）查 3 张指针表：
// 开场（出击前的剧情和简报）、地图事件（回合、接触等触发）、过关。解释器在 bank 0x1A $8192，
// 指令 = 首字节 & 0x7F。和对话有关的指令：
//   40/41/42 人物 资源 脚本号   显示对话（资源号 = 0x30 + 第 2 字节；41/42 会先把镜头移到该人物的单位）
//   44 资源 脚本号              显示对话（不指定人物）
// 别的指令长度还没整理，所以这里是在每段事件脚本里按字节扫描这几种模式，可能有少量误判
const EVENT_BANK = 0x1a * 0x2000;
const STAGE_COUNT = 26;
const STAGE_SLOTS = [
  { slot: "开场", table: 0x93a5 },
  { slot: "地图事件", table: 0x9721 },
  { slot: "过关", table: 0xa49c },
];

function stageScenes(prg, resources) {
  const byId = new Map(resources.map((r) => [r.id, r]));
  const cpu = (a) => EVENT_BANK + (a - 0x8000);
  const starts = new Set();
  for (const { table } of STAGE_SLOTS) for (let i = 0; i < 32; i++) starts.add(word(prg, cpu(table + i * 2)));
  const sorted = [...starts].sort((a, b) => a - b);
  const valid = (res, index) => byId.get(res)?.entries[index] != null;
  const stages = [];
  for (let stage = 0; stage < STAGE_COUNT; stage++) {
    const scenes = [];
    for (const { slot, table } of STAGE_SLOTS) {
      const start = word(prg, cpu(table + stage * 2));
      const end = sorted.find((a) => a > start) ?? start;
      for (let a = start; a < end; a++) {
        const o = cpu(a);
        const op = prg[o] & 0x7f;
        if (op >= 0x40 && op <= 0x42 && valid(0x30 + prg[o + 2], prg[o + 3])) {
          scenes.push({ slot, event: prgHex(o), op: hex(op), who: prg[o + 1], res: 0x30 + prg[o + 2], index: prg[o + 3] });
          a += 3;
        } else if (op === 0x44 && valid(0x30 + prg[o + 1], prg[o + 2])) {
          scenes.push({ slot, event: prgHex(o), op: hex(op), res: 0x30 + prg[o + 1], index: prg[o + 2] });
          a += 2;
        }
      }
    }
    stages.push(scenes);
  }
  return stages;
}

// 各文本资源的用途（看内容判断的）
const RESOURCE_NOTES = {
  0x30: "战斗台词：攻击方喊话，每项随机选一句（编号含义待确认，可能是机体或武器）",
  0x31: "战斗台词：少量特殊喊话",
  0x32: "关卡中的对话（地图事件、战斗中对话）A",
  0x33: "关卡中的对话 B",
  0x34: "战斗台词：被攻击方的反应，每项随机选一句",
  0x35: "战斗台词：被攻击方的反应（特殊）",
  0x36: "关卡中的对话 C",
  0x37: "出击、变形时的喊话，以及少量关卡对话",
  0x38: "剧情：开场、关卡开场与过关（前期）",
  0x39: "剧情：关卡开场与过关（中后期）",
  0x3a: "剧情：后期",
  0x3b: "剧情：后期，含商店老板西蒙",
  0x3f: "系统消息：升级、精神指令效果、全灭结局、存档、商店（带参数）",
};

function countMessages(nodes) {
  let n = 0;
  for (const node of nodes) {
    if (node.text !== undefined) n++;
    if (node.random) for (const branch of node.random) n += countMessages(branch);
  }
  return n;
}

// 纯文本版，方便通读校对
function plainText(nodes, indent = "") {
  const lines = [];
  for (const node of nodes) {
    if (node.text !== undefined) {
      const head = `${indent}[${node.offset}]${node.face !== undefined ? ` 头像${node.face}` : ""} `;
      lines.push(head + (node.speaker ? `${node.speaker}：` : "") + node.text.replace(/\n/g, "／"));
    } else if (node.random) {
      lines.push(`${indent}[${node.offset}] 随机 ${node.random.length} 选 1`);
      node.random.forEach((b) => lines.push(...plainText(b, indent + "  ")));
    } else if (node.goto) lines.push(`${indent}→ ${node.goto}`);
    else if (node.call) lines.push(`${indent}[${node.offset}] 调用 ${node.call.join(" ")}`);
  }
  return lines;
}

function main() {
  const romFile = process.argv[2] ?? path.join(ROOT, "rom/srw2.nes");
  const { prg } = loadRom(romFile);
  const charmap = loadCharmap();
  const resources = textResources(prg);
  const stages = stageScenes(prg, resources);
  // 脚本 → 用到它的关卡场景
  const usedBy = new Map();
  stages.forEach((scenes, stage) => {
    for (const sc of scenes) {
      const key = `${sc.res}#${sc.index}`;
      const tag = `第${stage + 1}关·${sc.slot}`;
      if (!usedBy.has(key)) usedBy.set(key, []);
      if (!usedBy.get(key).includes(tag)) usedBy.get(key).push(tag);
    }
  });
  const counts = new Map();
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(path.join(ROOT, "data/script"), { recursive: true });
  const plain = [];
  const covered = new Set();
  let total = 0;
  for (const res of resources) {
    const entries = [];
    res.entries.forEach((start, index) => {
      if (start === null) return;
      for (const op of parseScript(prg, res, start).values()) {
        for (let i = 0; i < op.size; i++) covered.add(op.prg + i);
        const key = op.kind === "char" ? hex(op.code, 4) : op.kind === "tile" ? hex(op.code) : null;
        if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      const nodes = decodeEntry(prg, res, start, charmap);
      const scenes = usedBy.get(`${res.id}#${index}`);
      entries.push({ index, offset: prgHex(res.cpuToPrg(start)), ...(scenes && { stages: scenes }), nodes });
      plain.push(`== 资源 0x${hex(res.id)} #${index} ${prgHex(res.cpuToPrg(start))}`, ...plainText(nodes));
      total += countMessages(nodes);
    });
    const doc = {
      resource: "0x" + hex(res.id),
      note: RESOURCE_NOTES[res.id] ?? "",
      bank: "0x" + hex(res.bank),
      table: prgHex(res.cpuToPrg(res.table)),
      entries,
    };
    fs.writeFileSync(path.join(ROOT, `data/script/res-${hex(res.id)}.json`), JSON.stringify(doc, null, 1) + "\n");
  }
  fs.writeFileSync(path.join(OUT, "all.txt"), plain.join("\n") + "\n");
  const byId = new Map(resources.map((r) => [r.id, r]));
  const stageDoc = stages.map((scenes, stage) => ({
    stage: stage + 1,
    scenes: scenes.map((sc) => ({
      slot: sc.slot, event: sc.event, op: sc.op, ...(sc.who !== undefined && { who: sc.who }),
      script: `res-${hex(sc.res)}#${sc.index}`,
      nodes: decodeEntry(prg, byId.get(sc.res), byId.get(sc.res).entries[sc.index], charmap),
    })),
  }));
  fs.writeFileSync(path.join(ROOT, "data/script/stages.json"), JSON.stringify({
    note: "按关卡排列的对话。来源是关卡事件脚本（bank 0x1A）里的对话指令，按出现顺序列出；同一段事件里可能有条件分支，顺序不一定等于实际播放顺序",
    stages: stageDoc,
  }, null, 1) + "\n");
  const names = nameTables(prg, charmap);
  fs.writeFileSync(path.join(ROOT, "data/script/names.json"), JSON.stringify({ note: "资源表里类型 1 的名字资源，FF 结尾；index 是游戏里的编号，空字符串是未使用的编号", tables: names }, null, 1) + "\n");
  // 名字表里的字符串也不算「其他片段」
  for (const t of names) {
    for (const item of t.items) {
      if (item.offset === null) continue;
      for (let o = parseInt(item.offset, 16); prg[o] !== 0xff; o++) covered.add(o);
    }
  }
  const fragments = scanFragments(prg, covered, charmap);
  fs.writeFileSync(path.join(ROOT, "data/script/misc.json"), JSON.stringify({ note: "剧情脚本以外扫到的文字片段（菜单、系统消息、说明、职员表等），未按文本引擎解析，end 是片段后面那个字节", fragments }, null, 1) + "\n");
  fs.writeFileSync(path.join(OUT, "codes.json"), JSON.stringify(Object.fromEntries([...counts].sort()), null, 1));

  // 引导字节超出字库范围的不是字（只出现在 0x3F #24 结尾的残留数据里）
  const codes = [...counts.keys()].filter((k) => k.length === 4).map((k) => parseInt(k, 16))
    .filter((c) => glyphOffset(prg, c) >= 0x28000 && c <= GLYPH_LAST).sort((a, b) => a - b);
  for (const f of fs.readdirSync(OUT)) if (f.startsWith("glyphs-")) fs.unlinkSync(path.join(OUT, f));
  for (let i = 0; i * 128 < codes.length; i++) glyphSheet(path.join(OUT, `glyphs-${i}.png`), prg, codes.slice(i * 128, i * 128 + 128));
  fs.writeFileSync(path.join(OUT, "order.txt"), codes.map((c) => hex(c, 4)).join("\n"));
  // 字库里剧情没用到的字（机体名、武器名等菜单文字用到）
  const used = new Set(codes);
  const extra = allGlyphCodes(prg).filter((c) => !used.has(c));
  glyphSheet(path.join(OUT, "glyphs-extra.png"), prg, extra);
  fs.writeFileSync(path.join(OUT, "order-extra.txt"), extra.map((c) => hex(c, 4)).join("\n"));
  const unknown = [...codes, ...extra].filter((c) => !charmap.glyphs[hex(c, 4)]);
  if (unknown.length) glyphSheet(path.join(OUT, "unknown.png"), prg, unknown);
  const linked = new Set([...usedBy.keys()]).size;
  console.log(`关卡 ${stages.length} 个，关卡事件引用的脚本 ${linked} 段`);
  console.log(`名字表 ${names.length} 张，其他文字片段 ${fragments.length} 段`);
  console.log(`文本资源 ${resources.length} 个，消息 ${total} 条；双字节字 ${codes.length} 种，未识别 ${unknown.length}，存疑 ${Object.keys(charmap.uncertain).length}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
