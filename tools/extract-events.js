// 导出关卡事件脚本：data/events/stageNN.json（每关）、data/events/ai.json（敌人 AI 脚本）、data/campaign.json（关卡顺序、胜利条件、名册变化）。
// 格式和指令含义见 docs/notes-events.md。
//
// 用法: node tools/extract-events.js
import fs from "node:fs";
import path from "node:path";
import { ROOT, prgByte } from "./lib/trace.js";
import { resolve } from "./lib/res.js";
import { TABLES, disasmScript, evWord, isCond } from "./lib/evscript.js";

const STAGES = 26; // 事件表、部署块、地图都有 27 项以上，但关卡号只会是 0–25（见笔记「关卡顺序」）
const OUT = path.join(ROOT, "data/events");
const hex = (v, n = 4) => v.toString(16).toUpperCase().padStart(n, "0");

// ---------- 名字和对话（只用来写 note，方便人看） ----------
const NAMES = JSON.parse(fs.readFileSync(path.join(ROOT, "data/script/names.json"), "utf8")).tables;
const nameTable = (res) => NAMES.find((t) => t.resource === res).items;
const PILOTS = nameTable("0x11"), MECHS = nameTable("0x13");
const pilotName = (i) => PILOTS[i]?.text || `人物${i}`;
const mechName = (i) => MECHS[i]?.text || `机体${i}`;
const DIALOG = {};
for (const f of fs.readdirSync(path.join(ROOT, "data/script")).filter((f) => /^res-3[0-9A-F]\.json$/.test(f))) {
  const j = JSON.parse(fs.readFileSync(path.join(ROOT, "data/script", f), "utf8"));
  DIALOG[parseInt(j.resource, 16)] = j;
}
const dialogRef = (res, idx) => `res-${hex(res + 0x30, 2)}#${idx}`;
function dialogFirst(res, idx) {
  const n = DIALOG[res + 0x30]?.entries?.find((e) => e.index === idx)?.nodes?.find((x) => x.text !== undefined);
  return n ? `${n.speaker ? n.speaker + "：" : ""}${n.text.replace(/\n/g, "")}` : "";
}
const WHO = { 0xfd: "我方", 0xfe: "敌方", 0xff: "任意" };
const who = (v) => WHO[v] ?? pilotName(v);
const flagName = (f) => (f & 0x80 ? `全程标志${f & 0x7f}` : `关卡标志${f}`);

// ---------- 菜单文本（胜利条件） ----------
const CHARMAP = JSON.parse(fs.readFileSync(path.join(ROOT, "data/charmap.json"), "utf8"));
// 菜单文本引擎（固定 bank $D3E8）的一小部分：F1 换行、FC 资源 编号 = 调用另一段、FD x = 窗口属性（bit5 时多 1 字节）、FF 结束
function menuText(type, idx) {
  const r = resolve(type, idx);
  let s = "", a = r.addr;
  for (let n = 0; n < 200; n++) {
    const b = r.read(a++);
    if (b === 0xff) break;
    if (b === 0xf1) s += "\n";
    else if (b === 0xfc) a += 2; // 调用的是窗口框（资源 $20 #15），不含文字
    else if (b === 0xfd) { if (r.read(a) & 0x20) a++; a++; }
    else if (b >= 0xf0) throw new Error(`胜利条件 ${idx} 里有没处理的控制码 ${hex(b, 2)}`);
    else if ((b >= 0xc9 && b <= 0xcb) || (b >= 0xd9 && b <= 0xdb)) s += CHARMAP.glyphs[hex((b << 8) | r.read(a++))] ?? "□";
    else s += CHARMAP.tiles[hex(b, 2)] ?? "□";
  }
  return s;
}

// ---------- 指令 → JSON ----------
function opJson(ins) {
  const o = { at: hex(ins.addr), op: ins.name };
  const a = { ...ins.args };
  if (isCond(ins.op) && ins.hi) o.and = true;
  if (!isCond(ins.op) && ins.hi) o.pause = true;
  if (a.res !== undefined) { o.dialog = dialogRef(a.res, a.script); delete a.res; delete a.script; }
  if (a.to !== undefined) a.to = hex(a.to);
  if (ins.name === "money") { a.amount = a.lo | (a.hi << 8); delete a.lo; delete a.hi; }
  Object.assign(o, a);
  const note = opNote(ins);
  if (note) o.note = note;
  return o;
}

function opNote(ins) {
  const a = ins.args;
  switch (ins.name) {
    case "talk": case "window": return a.face !== undefined && a.res !== undefined ? `${pilotName(a.face)}｜${dialogFirst(a.res, a.script)}` : undefined;
    case "talkAt": case "talkCursor": return `${pilotName(a.pilot)}｜${dialogFirst(a.res, a.script)}`;
    case "narrate": return dialogFirst(a.res, a.script);
    case "spawnEnemy": case "spawnNpc": return `${pilotName(a.pilot)} / ${mechName(a.mech)} / 等级 ${a.level + 1}`;
    case "rosterAdd": return `名册 ${a.roster}：${pilotName(a.pilot)} / ${mechName(a.mech)} / 等级 ${a.level + 1}`;
    case "changeMech": return `${pilotName(a.pilot)} → ${mechName(a.mech)}`;
    case "changePilotMech": return `${pilotName(a.pilot)} → ${pilotName(a.newPilot)} / ${mechName(a.mech)}`;
    default:
      if (a.pilot !== undefined) return pilotName(a.pilot);
      if (a.who !== undefined) return who(a.who);
      if (a.flag !== undefined) return flagName(a.flag);
  }
  return undefined;
}

function scriptJson(start) {
  const list = disasmScript(start);
  for (const i of list) if (!i.name) throw new Error(`$${hex(i.addr)} 未知指令 ${hex(i.raw[0], 2)}`);
  return { entry: hex(start), ops: list.map(opJson) };
}

// ---------- 条件的文字描述 ----------
function condText(ins) {
  const a = ins.args;
  switch (ins.name) {
    case "turnIs": return `第 ${a.turn} 回合`;
    case "flag": return `${flagName(a.flag)}已置位`;
    case "unitBit": return `${pilotName(a.pilot)} 的单位位 ${a.bit} 为 1`;
    case "inRoster": return `${pilotName(a.pilot)} 在名册中`;
    case "exists": return `${pilotName(a.pilot)} 在场`;
    case "onMap": return `${pilotName(a.pilot)} 在地图上`;
    case "enemiesAtLeast": return `敌人 ≥ ${a.n}`;
    case "alliesAtLeast": return `我方 ≥ ${a.n}`;
    case "counter": return `计数 ${a.counter} ≠ 0`;
    case "hpAtLeast": return a.hp === 0 ? `${pilotName(a.pilot)} HP 全满` : `${pilotName(a.pilot)} HP ≥ ${a.hp}`;
    case "allyInRect": return `我方进入 (${a.x1},${a.y1})–(${a.x2},${a.y2})`;
    case "enemyInRect": return `敌人进入 (${a.x1},${a.y1})–(${a.x2},${a.y2})`;
    case "unitAt": return `(${a.x},${a.y}) 有${who(a.who)}单位`;
    case "selfBit": return `本单位位 ${a.bit} 为 1`;
    case "selfAdjacent": return `本单位与${who(a.who)}相邻`;
    case "selfAt": return `本单位在 (${a.x},${a.y})`;
    case "selfInRect": return `本单位在 (${a.x1},${a.y1})–(${a.x2},${a.y2})`;
    case "foeWithin": return `敌对单位在 ${a.dist} 格内`;
    case "selfHpAtLeast": return a.hp === 0 ? "本单位 HP 全满" : `本单位 HP ≥ ${a.hp}`;
    case "battle": return `刚才 ${who(a.attacker)} 攻击 ${who(a.defender)}，结果 & ${hex(a.mask, 2)} = ${hex(a.value, 2)}`;
    case "select": return `${pilotName(a.pilot)} 在场（选为当前单位）`;
    default: return `${ins.name}(${Object.values(a).join(",")})`;
  }
}
const NEG = {
  "敌人 ≥ 1": "敌人全灭", "我方 ≥ 1": "我方全灭",
};
function negText(t) {
  if (NEG[t]) return NEG[t];
  if (t.endsWith(" 在场")) return t.replace(/ 在场$/, " 不在场");
  if (t.endsWith(" 在名册中")) return t.replace(/ 在名册中$/, " 不在名册中");
  if (t.endsWith("已置位")) return t.replace(/已置位$/, "未置位");
  if (t.endsWith(" HP 全满")) return t.replace(/ HP 全满$/, " HP 不满");
  return `并非（${t}）`;
}

// ---------- 静态分析：每个动作在什么条件下执行 ----------
// 数据流分析：每条指令记一组「或」的条件组合（每个组合是若干条件「且」），沿控制流传播，在汇合处取并集再化简：
// 只差一个条件真假的两组合并（A 且 X、A 且 非X → A），去掉被更宽的组包含的组。
// 返回 Map(addr → [[条件文字…], …])，外层是「或」，内层是「且」；[[]] 表示无条件
function pathConditions(start) {
  const list = disasmScript(start);
  const byAddr = new Map(list.map((i) => [i.addr, i]));
  const keyOf = (alts) => alts.map((fs) => fs.map((f) => f.key + (f.val ? "+" : "-")).join("|")).sort().join("‖");
  // inp: 流入每条指令的条件组合；grp: 流入时「当前条件组」（同一地址各路径的条件组相同，脚本里都是这样）
  const inp = new Map([[start, [[]]]]), grp = new Map([[start, null]]), done = new Map();
  const pending = new Set([start]);
  const send = (a, alts, group) => {
    if (!byAddr.has(a)) return;
    inp.set(a, simplify([...(inp.get(a) ?? []), ...alts]));
    if (!grp.has(a)) grp.set(a, group);
    pending.add(a);
  };
  let budget = 20000;
  while (pending.size) {
    if (--budget < 0) throw new Error(`$${hex(start)} 条件分析不收敛`);
    const a = Math.min(...pending); // 按地址顺序处理，脚本大多向前跳，基本一遍就收敛
    pending.delete(a);
    const alts = inp.get(a), k = keyOf(alts);
    if (done.get(a) === k) continue;
    done.set(a, k);
    const ins = byAddr.get(a), group = grp.get(a);
    const next = a + ins.raw.length;
    if (isCond(ins.op)) { send(next, alts, ins.hi && group ? { conds: [...group.conds, ins], neg: false } : { conds: [ins], neg: false }); continue; }
    if (ins.op === 0x56) { send(next, alts, group && { ...group, neg: !group.neg }); continue; }
    if (ins.op === 0x57 || ins.op === 0x58) {
      const add = (want) => {
        if (!group) return alts;
        const isTrue = want !== group.neg;
        const extra = isTrue ? group.conds.map((c) => ({ key: condText(c), val: true }))
          : [{ key: group.conds.map(condText).join(" 且 "), val: false }];
        return alts.map((fs) => [...fs.filter((f) => !extra.some((x) => x.key === f.key)), ...extra].sort((x, y) => (x.key < y.key ? -1 : 1)));
      };
      send(ins.args.to, add(ins.op === 0x57), group);
      send(next, add(ins.op !== 0x57), group);
      continue;
    }
    if (ins.op === 0x55) { send(ins.args.to, alts, group); continue; }
    if (ins.op === 0x5f || ins.op === 0x73) continue; // 停止、结局之后不会再执行
    send(next, alts, group);
  }
  return inp;
}
const altsText = (alts) => (alts ?? [[]]).map((fs) => fs.map(factText));
const factText = (f) => (f.val ? f.key : negText(f.key));
function simplify(alts) {
  let sets = alts.map((fs) => new Map(fs.map((f) => [f.key, f.val])));
  for (let changed = true; changed;) {
    changed = false;
    // 合并只差一个条件真假的两组
    outer: for (let i = 0; i < sets.length; i++) for (let j = i + 1; j < sets.length; j++) {
      const A = sets[i], B = sets[j];
      if (A.size !== B.size) continue;
      let diff = null, ok = true;
      for (const [k, v] of A) { if (!B.has(k)) { ok = false; break; } if (B.get(k) !== v) { if (diff) { ok = false; break; } diff = k; } }
      if (!ok || !diff) continue;
      const M = new Map(A); M.delete(diff);
      sets.splice(j, 1); sets[i] = M; changed = true; break outer;
    }
    // 化简：A 且 X 存在时，A 且 非X 且 Y → A 且 Y
    for (const A of sets) for (const B of sets) {
      if (A === B || A.size > B.size) continue;
      let flip = null, ok = true;
      for (const [k, v] of A) { if (!B.has(k)) { ok = false; break; } if (B.get(k) !== v) { if (flip) { ok = false; break; } flip = k; } }
      if (ok && flip && A.size < B.size) { B.delete(flip); changed = true; }
    }
    // 去掉被更宽的组包含的
    const keep = sets.filter((B, j) => !sets.some((A, i) => i !== j && A.size <= B.size && [...A].every(([k, v]) => B.get(k) === v) && (A.size < B.size || i < j)));
    if (keep.length !== sets.length) { sets = keep; changed = true; }
  }
  return sets.map((m) => [...m].map(([key, val]) => ({ key, val })).sort((x, y) => (x.key < y.key ? -1 : 1)));
}

// ---------- 读 ROM 里的几张关卡表 ----------
const b10 = (a) => prgByte(a < 0xa000 ? 10 : 11, a);
const b28 = (a) => prgByte(a < 0xa000 ? 28 : 29, a);

// 劝降表 bank 28 $9E03：每项 3 字节（关卡号、我方驾驶员、相邻的敌方驾驶员），FF 结束；序号 = 劝降脚本号
function persuadeTable() {
  const out = [];
  for (let a = 0x9e03, i = 0; b28(a) !== 0xff; a += 3, i++) out.push({ index: i, stage: b28(a), pilot: b28(a + 1), target: b28(a + 2) });
  return out;
}

// 踩格子表 bank 10 $987E（按关卡号）：每项 4 字节（X、Y、驾驶员或 FF、值），FF 结束。值 < F0 = 格子脚本号，F0+n = 商店 n
function tileTable(stage) {
  const p = b10(0x987e + 2 * stage) | (b10(0x987f + 2 * stage) << 8);
  const out = [];
  for (let a = p; b10(a) !== 0xff; a += 4) out.push({ x: b10(a), y: b10(a + 1), pilot: b10(a + 2), value: b10(a + 3) });
  return out;
}

// 商店表 bank 10 $9743：[?, 资源−0x30, 脚本号, 个数, 零件编号…]
function shopTable(n) {
  const p = b10(0x9743 + 2 * n) | (b10(0x9744 + 2 * n) << 8);
  const count = b10(p + 3);
  return { greeting: dialogRef(b10(p + 1), b10(p + 2)), parts: Array.from({ length: count }, (_, k) => b10(p + 4 + k)) };
}

// 部署块（资源 $83，按关卡号）：只读第 3 段（NPC）给出 NPC 脚本号
const DEPLOY = JSON.parse(fs.readFileSync(path.join(ROOT, "data/deployments.json"), "utf8"));

// ---------- 名册变化：扫描所有会改名册的指令 ----------
function rosterEffects(ops, conds, source) {
  const out = [];
  for (const o of ops) {
    const when = altsText(conds.get(parseInt(o.at, 16)));
    const base = { source, at: o.at, when };
    if (o.op === "rosterAdd") out.push({ ...base, change: "join", roster: o.roster, pilot: o.pilot, mech: o.mech, level: o.level, note: o.note });
    else if (o.op === "rosterRemove") out.push({ ...base, change: "leave", roster: o.roster });
    else if (o.op === "toAlly") out.push({ ...base, change: "joinFromMap", roster: o.roster, note: "当前单位（多为劝降对象）转入我方，名册由紧接着的 changeMech 写入" });
    else if (o.op === "changeMech") out.push({ ...base, change: "mech", pilot: o.pilot, mech: o.mech, note: o.note });
    else if (o.op === "changePilotMech") out.push({ ...base, change: "pilotMech", pilot: o.pilot, newPilot: o.newPilot, mech: o.mech, note: o.note });
    else if (o.op === "levelUp") out.push({ ...base, change: "level", roster: o.roster, n: o.n });
  }
  return out;
}

function eventsSummary(ops, conds, source) {
  const out = [];
  for (const o of ops) {
    const when = altsText(conds.get(parseInt(o.at, 16)));
    if (["spawnEnemy", "spawnNpc", "deployAlly"].includes(o.op)) {
      const u = { source, at: o.at, when, op: o.op, x: o.x, y: o.y };
      if (o.op === "deployAlly") u.roster = o.roster; else Object.assign(u, { pilot: o.pilot, mech: o.mech, level: o.level }, o.op === "spawnEnemy" ? { ai: o.ai } : { script: o.script });
      if (o.note) u.note = o.note;
      out.push(u);
    }
  }
  return out;
}

const firstOp = (ops, name) => ops.find((o) => o.op === name);

// JSON 输出：短的对象 / 数组（一条指令、一组条件）写在一行
function fmtJson(v, ind = "") {
  const flat = JSON.stringify(v);
  if (flat.length <= 140 || v === null || typeof v !== "object") return flat;
  const inner = ind + "  ";
  if (Array.isArray(v)) return "[\n" + v.map((x) => inner + fmtJson(x, inner)).join(",\n") + "\n" + ind + "]";
  return "{\n" + Object.entries(v).map(([k, x]) => inner + JSON.stringify(k) + ": " + fmtJson(x, inner)).join(",\n") + "\n" + ind + "}";
}

function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const persuade = persuadeTable();
  const campaign = { note: "关卡顺序是线性的：关卡号 = 已过关数（bank 10 $949F 按过关位图 $7412 从高位数连续的 1）。名册变化按出现位置列出，when 是到达该指令时满足的条件", stages: [] };
  const aiUse = {};

  for (let s = 0; s < STAGES; s++) {
    const scripts = {}, conds = {};
    for (const k of ["start", "enemyPhase", "check"]) {
      const entry = evWord(TABLES[k] + 2 * s);
      scripts[k] = scriptJson(entry);
      conds[k] = pathConditions(entry);
    }
    const block = DEPLOY[s];
    // NPC 脚本：部署第 3 段 + spawnNpc 指令里出现的编号
    const npcIds = new Set(block.extra2.map((u) => u.c));
    for (const k in scripts) for (const o of scripts[k].ops) if (o.op === "spawnNpc") npcIds.add(o.script);
    const npcScripts = {};
    for (const n of [...npcIds].sort((x, y) => x - y)) npcScripts[n] = scriptJson(evWord(TABLES.npc + 2 * n));
    // 敌人 AI 脚本编号
    const aiIds = new Set(block.enemies.map((u) => u.c));
    for (const k in scripts) for (const o of scripts[k].ops) if (o.op === "spawnEnemy") aiIds.add(o.ai);
    for (const n of aiIds) (aiUse[n] ||= new Set()).add(s + 1);

    const persuades = persuade.filter((p) => p.stage === s).map((p) => ({
      pilot: p.pilot, target: p.target, note: `${pilotName(p.pilot)} 劝降 ${pilotName(p.target)}`, index: p.index,
      script: scriptJson(evWord(TABLES.persuade + 2 * p.index)),
    }));
    const tiles = tileTable(s).map((t) => {
      const o = { x: t.x, y: t.y, pilot: t.pilot === 0xff ? null : t.pilot };
      if (t.value >= 0xf0) Object.assign(o, { shop: t.value & 0x0f }, shopTable(t.value & 0x0f));
      else Object.assign(o, { tileScript: t.value, script: scriptJson(evWord(TABLES.tile + 2 * t.value)) });
      return o;
    });

    // 胜负：check 脚本里到 stageClear / gameOver 的条件
    const checkList = disasmScript(evWord(TABLES.check + 2 * s));
    const outcome = (name) => altsText(simplify(checkList.filter((i) => i.name === name).flatMap((i) => conds.check.get(i.addr) ?? [])));
    const victory = menuText(0x20, s + 16);

    const summary = {
      victory: outcome("stageClear").concat(outcome("ending")),
      defeat: outcome("gameOver"),
      units: [], roster: [],
    };
    for (const k of ["start", "enemyPhase", "check"]) {
      summary.units.push(...eventsSummary(scripts[k].ops, conds[k], k));
      summary.roster.push(...rosterEffects(scripts[k].ops, conds[k], k));
    }
    for (const [n, sc] of Object.entries(npcScripts)) {
      const c = pathConditions(parseInt(sc.entry, 16));
      summary.roster.push(...rosterEffects(sc.ops, c, `npc ${n}`));
    }
    for (const p of persuades) {
      const c = pathConditions(parseInt(p.script.entry, 16));
      summary.roster.push(...rosterEffects(p.script.ops, c, `persuade ${pilotName(p.pilot)}→${pilotName(p.target)}`));
    }

    const stage = {
      stage: s + 1,
      index: s,
      victoryText: victory,
      map: s,
      deployment: block.block,
      bgm: { player: firstOp(scripts.start.ops, "playerBgm")?.track, enemy: firstOp(scripts.start.ops, "enemyBgm")?.track },
      npcDeploy: block.extra2.map((u) => ({ x: u.x, y: u.y, pilot: u.a, mech: u.unit, level: u.b, script: u.c, note: `${pilotName(u.a)} / ${mechName(u.unit)} / 等级 ${u.b + 1}` })),
      aiScripts: [...aiIds].sort((x, y) => x - y),
      scripts,
      npcScripts,
      persuade: persuades,
      tiles,
      summary,
    };
    fs.writeFileSync(path.join(OUT, `stage${String(s + 1).padStart(2, "0")}.json`), fmtJson(stage) + "\n");

    campaign.stages.push({
      stage: s + 1, index: s, victoryText: victory, deployment: block.block, map: s,
      victory: summary.victory, defeat: summary.defeat,
      roster: summary.roster,
      persuade: persuades.map((p) => ({ pilot: p.pilot, target: p.target, note: p.note })),
    });
  }

  // 敌人 AI 脚本：入口表 $AF83 共 34 项
  const ai = { note: "敌人 AI 脚本（bank 27，入口表 $AF83，按单位的 AI 编号 $7777）。usedIn = 用到它的关卡（部署或 spawnEnemy）", scripts: {} };
  for (let n = 0; n < 34; n++) ai.scripts[n] = { usedIn: [...(aiUse[n] ?? [])].sort((x, y) => x - y), ...scriptJson(evWord(TABLES.ai + 2 * n)) };
  fs.writeFileSync(path.join(OUT, "ai.json"), fmtJson(ai) + "\n");

  campaign.initialRoster = JSON.parse(fs.readFileSync(path.join(ROOT, "data/roster.json"), "utf8")).members;
  fs.writeFileSync(path.join(ROOT, "data/campaign.json"), fmtJson(campaign) + "\n");
  console.log(`已导出 ${STAGES} 关 → data/events/、data/campaign.json`);
}

main();
