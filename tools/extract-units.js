// 从 ROM 提取机体、驾驶员（精神）、武器、精神指令数据。
//
// 用法: node tools/extract-units.js [rom/srw2.nes]
// 输出:
//   data/units.json     机体表 + 驾驶员表 + 成长曲线 + 经验曲线
//   data/weapons.json   武器表
//   data/spirits.json   精神指令表
//
// ROM 结构见 docs/notes-units.md。
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

function loadRom(file) {
  const rom = fs.readFileSync(file);
  return rom.subarray(16, 16 + rom[4] * 0x4000);
}

const word = (buf, off) => buf[off] | (buf[off + 1] << 8);
const hex = (n, w = 2) => n.toString(16).padStart(w, "0");
const hexBytes = (bytes) => Array.from(bytes, (b) => hex(b)).join(" ");

// 资源表：固定 bank 里 $F3E2 起每个资源号 2 字节（只用第 1 字节）。
// 字节高 4 位 = 16KB bank 号（映射到 $8000–$BFFF），低 4 位 = 该 bank 开头 $8000 处指针表的下标。
// 指针表项指向一张「下标 → 记录」的指针表（见固定 bank $FD4F）。
const RESOURCE_TABLE = 0x3f3e2;
function resource(prg, id) {
  const b = prg[RESOURCE_TABLE + id * 2];
  const base = ((b >> 3) & 0x1e) * 0x2000;
  const table = base + word(prg, base + (b & 0x0f) * 2) - 0x8000;
  return {
    table,
    // 第 i 项的 PRG 偏移，指针为 0 时返回 null
    at(i) {
      const p = word(prg, table + i * 2);
      return p ? base + p - 0x8000 : null;
    },
  };
}

const RES_SPIRIT_NAMES = 0x15; // 0–3 机体类型名，0x10+i 精神名
const RES_PILOT_NAMES = 0x11;
const RES_UNIT_NAMES = 0x13;
const RES_WEAPON_NAMES = 0x14;
const RES_PILOTS = 0x84;
const RES_UNITS = 0x86;
const RES_WEAPONS = 0x87;
const RES_GROWTH = 0x88;

const UNIT_COUNT = 192;
const WEAPON_COUNT = 192;
const PILOT_COUNT = 112;
const GROWTH_CURVE_COUNT = 16;
const GROWTH_CURVE_BYTES = 25; // 50 个 4 位成长值，等级 1→50

// 机体编号 → 2 个武器编号：编号 < 0x80 查 $AF8D，否则查 $B08D（bank 4，CPU 地址即 PRG 偏移）
const UNIT_WEAPONS_LO = 0xaf8d;
const UNIT_WEAPONS_HI = 0xb08d;
// 经验曲线：4 个指针（$B757），每条是 49 个 16 位累计经验值，下标 = 当前等级 - 1
const EXP_CURVE_POINTERS = 0xb757;
// 命中随距离衰减：$B707 + 衰减类型 * 16 + (距离 - 1)，百分比
const HIT_FALLOFF = 0xb707;
// 精神消耗：bank 28 CPU $9C34，19 个
const SPIRIT_COSTS = 0x39c34;
const SPIRIT_COUNT = 19;
// 击坠经验的等级差修正：d = 敌等级 + 6 - 我方等级（夹在 0–14），经验 × MUL[d] / DIV[d]
const EXP_LEVEL_MUL = 0xc627;
const EXP_LEVEL_DIV = 0xc636;

const TYPES = ["air", "land", "sea", "type3"];

// 汉化字库编码 → 字形。只收录已用模拟器状态画面截图核对过的字，其他名字先放原始字节。
// 双字节字以 C9/CA 开头；0x30–0x39 是数字，0x80–0x99 是 A–Z 小字母图块。
const GLYPHS = {
  c900: "空", c901: "陆", c902: "海",
  c91c: "毅", c91d: "力", c920: "加", c921: "速", c922: "瞄", c923: "准", c924: "防", c925: "守",
  c926: "强", c907: "攻", c927: "友", c928: "情", c929: "必", c92a: "杀", c92b: "疾", c92c: "风",
  c92d: "回", c930: "避", c931: "潜", c932: "热", c933: "血", c934: "义", c935: "传", c936: "真",
  c937: "援", c938: "助", c939: "怒", c93a: "祈", c93b: "祷", c93c: "干", c93d: "扰", c940: "狂",
  c941: "爱", c942: "心",
  c9f2: "太", c9f3: "勒", c9e9: "刚", c9ea: "达", ca02: "乍", c998: "克", c997: "布", c9a8: "拉",
  ca0a: "宰", c9c9: "恩", c966: "Ⅱ", c9ed: "阿", c9f0: "波", c9b8: "罗", c953: "金", c9e6: "盖",
  c996: "塔", ca1c: "怀", c9b6: "特",
  c9a0: "杰", c98b: "大", c944: "卫", c99b: "由", c99c: "美", c98c: "代", c9cd: "乔", c987: "士",
  c988: "兵",
  c9aa: "萨", c9b2: "斯", ca27: "剑", ca62: "左", ca63: "轮", ca46: "手", ca29: "枪", c970: "粒",
  c969: "子", ca21: "炮", c964: "机", ca26: "光", ca28: "束", ca11: "导", ca12: "弹", c975: "修",
  ca87: "理", c95c: "装", ca88: "置", ca2a: "穿", c95d: "甲", ca2b: "射", ca2c: "线", ca72: "三",
  ca73: "指", ca74: "叉", ca14: "连", c99d: "发", ca81: "离", ca3c: "冷", ca3d: "冻",
};

// 读以 FF 结尾的字符串，返回原始字节和（能完整解码时的）中文
function readName(prg, off) {
  if (off === null) return { name: null, nameHex: null };
  const bytes = [];
  while (prg[off] !== 0xff && bytes.length < 32) bytes.push(prg[off++]);
  let name = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === 0xc9 || b === 0xca) {
      const g = GLYPHS[hex(b) + hex(bytes[++i] ?? 0)];
      if (!g) { name = null; break; }
      name += g;
    } else if (b >= 0x30 && b <= 0x39) name += String(b - 0x30);
    else if (b >= 0x80 && b <= 0x99) name += String.fromCharCode(0x41 + b - 0x80);
    else { name = null; break; }
  }
  return { name, nameHex: hexBytes(bytes) };
}

// 成长曲线：每字节两个 4 位值（高位在前），第 k 个值 = 等级 k → k+1 的增量
function growthCurves(prg) {
  const res = resource(prg, RES_GROWTH);
  const curves = [];
  for (let c = 0; c < GROWTH_CURVE_COUNT; c++) {
    const off = res.at(c);
    const steps = [];
    for (let i = 0; i < GROWTH_CURVE_BYTES; i++) steps.push(prg[off + i] >> 4, prg[off + i] & 0x0f);
    curves.push({ id: c, romOffset: hex(off, 5), perLevel: steps });
  }
  return curves;
}

function expCurves(prg) {
  return [0, 1, 2, 3].map((c) => {
    const off = word(prg, EXP_CURVE_POINTERS + c * 2); // bank 4 映射在 $8000，CPU 地址即 PRG 偏移
    const totals = [];
    for (let lv = 0; lv < 49; lv++) totals.push(word(prg, off + lv * 2));
    // 第 i 项 = 从等级 i+1 升到 i+2 所需的累计经验
    return { id: c, romOffset: hex(off, 5), totalExpForNextLevel: totals };
  });
}

function unitWeapons(prg, id) {
  const off = (id < 0x80 ? UNIT_WEAPONS_LO : UNIT_WEAPONS_HI) + ((id * 2) & 0xff);
  return [prg[off], prg[off + 1]];
}

function extractUnits(prg) {
  const res = resource(prg, RES_UNITS);
  const names = resource(prg, RES_UNIT_NAMES);
  const units = [];
  for (let id = 1; id < UNIT_COUNT; id++) {
    const off = res.at(id);
    if (off === null) continue;
    const r = prg.subarray(off, off + 16);
    const form = (r[0] >> 4) & 3;
    const formKind = r[0] & 0x08 ? "triple" : r[0] & 0x04 ? "double" : null;
    units.push({
      id,
      ...readName(prg, names.at(id)),
      romOffset: hex(off, 5),
      type: TYPES[r[0] & 3],
      // 变形组：同组机体编号连续，组首 = id - formIndex
      transform: formKind ? { kind: formKind, formIndex: form, baseId: id - form } : null,
      flags0High: r[0] >> 6, // 未确认
      ability: r[1], // 低 3 位 1/2/5/6 战斗中特殊能力，bit7 另一种防御能力，未确认
      sprite: r[2],
      move: r[3],
      speed: r[4],
      strength: r[5],
      defense: r[6],
      money: r[7],
      hp: word(r, 8),
      expBase: word(r, 10),
      growth: { speed: r[12], strength: r[13], defense: r[14], hp: r[15] },
      weapons: unitWeapons(prg, id),
      raw: hexBytes(r),
    });
  }
  return units;
}

// 驾驶员记录：SP、SP 成长曲线、精神位 3 字节、掩码；掩码高 5 位决定后面跟哪些加成字节，低 2 位是经验曲线
const PILOT_BONUS_FIELDS = ["move", "strength", "defense", "speed", "hp"];
function extractPilots(prg) {
  const res = resource(prg, RES_PILOTS);
  const names = resource(prg, RES_PILOT_NAMES);
  const pilots = [];
  for (let id = 1; id < PILOT_COUNT; id++) {
    const off = res.at(id);
    if (off === null) continue;
    const mask = prg[off + 5];
    const bonus = {};
    let o = off + 6;
    PILOT_BONUS_FIELDS.forEach((f, i) => { if (mask & (0x80 >> i)) bonus[f] = prg[o++]; });
    const bits = (prg[off + 2] << 16) | (prg[off + 3] << 8) | prg[off + 4];
    const spirits = [];
    for (let s = 0; s < 24; s++) if (bits & (1 << (23 - s))) spirits.push(s);
    pilots.push({
      id,
      ...readName(prg, names.at(id)),
      romOffset: hex(off, 5),
      sp: prg[off],
      spGrowth: prg[off + 1],
      spirits,
      expCurve: mask & 3,
      bonus,
      maskBit2: (mask >> 2) & 1, // 未确认
      raw: hexBytes(prg.subarray(off, o)),
    });
  }
  return pilots;
}

function extractWeapons(prg) {
  const res = resource(prg, RES_WEAPONS);
  const names = resource(prg, RES_WEAPON_NAMES);
  const weapons = [];
  for (let id = 1; id < WEAPON_COUNT; id++) {
    const off = res.at(id);
    if (off === null) continue;
    const r = prg.subarray(off, off + 6);
    const kind = r[0] >> 4;
    const power = (v) => (v === 0 ? null : v);
    weapons.push({
      id,
      ...readName(prg, names.at(id)),
      romOffset: hex(off, 5),
      range: (r[0] & 0x0f) + 1,
      // 0 普通（射程 > 1 时移动后不能用、不能打相邻格）；0xE 移动后也能用的远程；0xF 辅助（修理），其他未确认
      kind: kind === 0 ? "normal" : kind === 0xe ? "moveAndFire" : kind === 0xf ? "support" : `unknown${kind}`,
      hit: r[1],
      hitFalloff: r[2],
      // 实际火力 = 机体强度 + 武器值，null 表示打不到该类型
      power: { air: power(r[3]), land: power(r[4]), sea: power(r[5]) },
      raw: hexBytes(r),
    });
  }
  return weapons;
}

// 精神菜单可用条件（bank 28 $9B22 跳转表），以及会设置的状态位（$7817）
const SPIRIT_RULES = [
  { condition: "selfHpNotFull", status: null, effect: "回复自身 HP（推测）" },
  { condition: "statusClear", status: 0xc0, effect: "移动力增加（推测）" },
  { condition: "statusClear", status: 0x22, effect: "下一次攻击必中（推测）" },
  { condition: "statusClear", status: 0x10, effect: "受到伤害减半（推测）" },
  { condition: "statusClear", status: 0x0c, effect: "攻击力提升（推测）" },
  { condition: "anyAllyDamaged", status: null, effect: "回复一名友军 HP（推测）" },
  { condition: "statusClear", status: 0x22, effect: "下一次攻击会心（推测）" },
  { condition: "statusClear", status: 0xc0, effect: "移动力大幅增加（推测）" },
  { condition: "statusClear", status: 0x01, effect: "下一次敌人攻击必定回避（推测）" },
  { condition: "selfHpNotFull", status: null, effect: "大量回复自身 HP（推测）" },
  { condition: "statusClear", status: 0x0c, effect: "下一次攻击伤害加倍（推测）" },
  { condition: "anyAllyDamaged", status: null, effect: "大量回复一名友军 HP（推测）" },
  { condition: "always", status: null, effect: "未知（传真，可能是传送/转移）" },
  { condition: "anyPlayerHpNotFull", status: null, effect: "回复友军 HP（推测）" },
  { condition: "enemyExists", status: null, effect: "对敌人造成伤害（推测）" },
  { condition: "anyPlayerHpNotFull", status: null, effect: "全体友军回复 HP（推测）" },
  { condition: "enemyExists", status: null, effect: "妨碍敌人（推测）" },
  { condition: "enemyExists", status: null, effect: "对全体敌人造成伤害（推测）" },
  { condition: "anyPlayerHpNotFull", status: null, effect: "全体友军完全回复（推测）" },
];

function extractSpirits(prg) {
  const names = resource(prg, RES_SPIRIT_NAMES);
  return SPIRIT_RULES.map((rule, id) => ({
    id,
    ...readName(prg, names.at(0x10 + id)),
    cost: prg[SPIRIT_COSTS + id],
    condition: rule.condition,
    statusFlag: rule.status === null ? null : hex(rule.status),
    effectGuess: rule.effect,
  }));
}

// JSON 缩进输出，但纯数字/字符串数组写在一行
function toJson(data, indent = "") {
  if (Array.isArray(data) && data.every((v) => v === null || typeof v !== "object")) return JSON.stringify(data);
  if (data === null || typeof data !== "object") return JSON.stringify(data);
  const inner = indent + "  ";
  const items = Array.isArray(data)
    ? data.map((v) => inner + toJson(v, inner))
    : Object.entries(data).map(([k, v]) => `${inner}${JSON.stringify(k)}: ${toJson(v, inner)}`);
  if (!items.length) return Array.isArray(data) ? "[]" : "{}";
  const [open, close] = Array.isArray(data) ? ["[", "]"] : ["{", "}"];
  return `${open}\n${items.join(",\n")}\n${indent}${close}`;
}

function main() {
  const prg = loadRom(process.argv[2] ?? path.join(ROOT, "rom/srw2.nes"));
  const types = resource(prg, RES_SPIRIT_NAMES);
  const units = {
    types: TYPES.map((t, i) => ({ id: i, key: t, ...readName(prg, types.at(i)) })),
    growthCurves: growthCurves(prg),
    expCurves: expCurves(prg),
    killExp: {
      levelDiffMul: Array.from(prg.subarray(EXP_LEVEL_MUL, EXP_LEVEL_MUL + 15)),
      levelDiffDiv: Array.from(prg.subarray(EXP_LEVEL_DIV, EXP_LEVEL_DIV + 15)),
    },
    hitFalloff: [0, 1, 2].map((t) => Array.from(prg.subarray(HIT_FALLOFF + t * 16, HIT_FALLOFF + t * 16 + 16))),
    units: extractUnits(prg),
    pilots: extractPilots(prg),
  };
  const weapons = extractWeapons(prg);
  const spirits = extractSpirits(prg);

  const out = (name, data) => fs.writeFileSync(path.join(ROOT, "data", name), toJson(data) + "\n");
  fs.mkdirSync(path.join(ROOT, "data"), { recursive: true });
  out("units.json", units);
  out("weapons.json", weapons);
  out("spirits.json", spirits);

  const named = (list) => list.filter((x) => x.name).length;
  console.log(`机体 ${units.units.length}（已解码名字 ${named(units.units)}），驾驶员 ${units.pilots.length}（${named(units.pilots)}），` +
    `武器 ${weapons.length}（${named(weapons)}），精神 ${spirits.length}（${named(spirits)}）`);
}

main();
