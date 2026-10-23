// 提取强化零件和地图商店：名字、价格、说明、效果，以及 8 个商店的零件列表。
//
// 用法: node tools/extract-parts.js
// 输出: data/parts.json
//
// 原版（docs/notes-events.md「商店和工具」，模拟器实测 tools/shop-probe.js）：
//   名字    资源 0x10（data/script/names.json）
//   价格    bank 10 $9713，24 个 16 位字（原版资金单位，画面 ×10）
//   说明    bank 11 $A141，24 项指针，菜单文本（F1 换行、FF 结束）
//   商店    bank 10 $9743，8 项指针：头像、资源 − $30、问候语序号、零件个数 n、n 个零件号
//   效果    bank 10 $807E 的分发表，按零件号逐个读代码整理（下面 EFFECTS）
import fs from "node:fs";
import path from "node:path";
import { PRG, prgByte } from "./lib/trace.js";
import { isLead, loadCharmap } from "./extract-text.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const COUNT = 24;
const PRICES = 0x9713;
const SHOPS = 0x9743;
const NOTES = 11 * 0x2000 + 0x0141;
const hex = (v, n = 2) => v.toString(16).toUpperCase().padStart(n, "0");

// 效果（bank 10 $807E 跳转表）。target：pick = 部队表选我方，map = 地图上用光标点我方（enemy：点敌人），none = 不用选
//   stat     加能力（同样的量记到名册的改造值上，以后每关都带着），加到上限为止：机动 15、其他 255、HP 9999
//   sp / hp  回复精神 / HP
//   jamming  干扰（关卡标志 1）；flag 设精神状态（$7817）；exp 加经验 rand(n)
const EFFECTS = {
  0: { kind: "stat", stat: "defense", amount: 1, target: "pick" },
  1: { kind: "stat", stat: "speed", amount: 1, target: "pick" },
  2: { kind: "stat", stat: "strength", amount: 1, target: "pick" },
  3: { kind: "stat", stat: "maxHp", amount: 5, target: "pick" },
  4: { kind: "stat", stat: "defense", amount: 3, target: "pick" },
  5: { kind: "stat", stat: "move", amount: 1, target: "pick" },
  6: { kind: "flight", target: "pick" },
  7: { kind: "stat", stat: "strength", amount: 3, target: "pick" },
  8: { kind: "stat", stat: "speed", amount: 3, target: "pick" },
  9: { kind: "stat", stat: "maxHp", amount: 10, target: "pick" },
  10: { kind: "jamming", target: "none" },
  11: { kind: "sp", amount: 20, target: "pick" },
  12: { kind: "sp", amount: 100, target: "pick" },
  13: { kind: "healAll", amount: "50-200", target: "none" },
  14: { kind: "flag", flag: 0x08, blockedBy: 0x0c, target: "map" },
  15: { kind: "flag", flag: 0x80, blockedBy: 0xc0, target: "map" },
  16: { kind: "hp", amount: 100, target: "pick" },
  17: { kind: "damage", amount: "10-200", target: "enemy" },
  18: { kind: "flag", flag: 0x20, blockedBy: 0x22, target: "map" },
  19: { kind: "exp", rand: 254, target: "pick" },
  20: { kind: "none", target: "none" },
  21: { kind: "none", target: "none" },
  22: { kind: "none", target: "none" },
  23: { kind: "none", target: "none" },
};

const charmap = loadCharmap();
// 菜单文本：F1 换行，FF 结束；行首的 AF 是缩进空格
function menuText(o) {
  let text = "";
  for (; PRG[o] !== 0xff; ) {
    const b = PRG[o];
    if (b === 0xf1) { text += "\n"; o++; }
    else if (isLead(b)) { const c = hex((b << 8) | PRG[o + 1], 4); text += charmap.glyphs[c] ?? `〔${c}〕`; o += 2; }
    else { text += charmap.tiles[hex(b)] ?? `〔${hex(b)}〕`; o++; }
  }
  return text.split("\n").map((l) => l.trim()).join("\n");
}

const names = JSON.parse(fs.readFileSync(path.join(ROOT, "data/script/names.json"), "utf8")).tables.find((t) => t.resource === "0x10").items;
const word = (bank, a) => prgByte(bank, a) | (prgByte(bank, a + 1) << 8);

const parts = [...Array(COUNT).keys()].map((id) => ({
  id,
  name: names[id].text,
  price: word(10, PRICES + 2 * id),
  note: menuText(11 * 0x2000 + (word(11, 0xa141 + 2 * id) - 0xa000)),
  effect: EFFECTS[id],
}));

const shops = [...Array(8).keys()].map((n) => {
  const a = word(10, SHOPS + 2 * n);
  const b = (k) => prgByte(10, a + k);
  if (!b(0)) return null; // 5–7 号店是空的
  const count = b(3);
  return { shop: n, face: b(0), greeting: `res-${hex(b(1) + 0x30)}#${b(2)}`, parts: [...Array(count).keys()].map((k) => b(4 + k)) };
});

const out = {
  note: "强化零件和地图商店（tools/extract-parts.js，docs/notes-events.md「商店和工具」）。price 是原版资金单位（画面 ×10）；持有数全队共用，上限 255；问候语起连续 7 条：问候、需要什么、钱不够、只能带那么些、要买吗、还要什么吗、道别",
  parts,
  shops,
};
// 一项一行
const lines = (list) => list.map((x) => "  " + JSON.stringify(x)).join(",\n");
fs.writeFileSync(path.join(ROOT, "data/parts.json"), `{\n "note": ${JSON.stringify(out.note)},\n "parts": [\n${lines(parts)}\n ],\n "shops": [\n${lines(shops)}\n ]\n}\n`);
for (const p of parts) console.log(p.id, p.name, `${p.price * 10}G`, JSON.stringify(p.note));
console.log(shops.filter(Boolean).map((s) => `店 ${s.shop}：${s.greeting} ${s.parts.map((i) => parts[i].name).join("、")}`).join("\n"));
