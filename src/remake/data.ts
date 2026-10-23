// 读取从 ROM 提取的数据，组装成游戏用的结构。数据文件打包进构建产物，不需要运行时再请求。
//   地图、地图环境、部署：data/maps、data/environments.json、data/deployments.json（tools/extract-maps.js）
//   机体、驾驶员、武器、精神：data/units.json、data/weapons.json、data/spirits.json（tools/extract-units.js）
import type { GridMap, MoveType } from "./grid.ts";
import { computeStats, expThreshold, type GrowthCurve, type PilotDef, type UnitDef } from "./stats.ts";
import { traitOf, type Trait } from "./traits.ts";
import { personName } from "./story.ts";
import { samePilot } from "./rules.ts";
import nameTables from "../../data/script/names.json";

// 机体名、武器名：data/units.json、weapons.json 里有不少没解出来，用剧情文本会话导出的名字表补上
// （资源 0x13 机体名、0x14 武器名，下标就是编号）
const nameTable = (res: string) =>
  new Map(((nameTables as { tables: { resource: string; items: { index: number; text: string | null }[] }[] }).tables
    .find((t) => t.resource === res)?.items ?? []).map((i) => [i.index, i.text || ""]));
const mechNames = nameTable("0x13");
const weaponNames = nameTable("0x14");
import environments from "../../data/environments.json";
import terrainNames from "../../data/terrain-names.json";
import deployments from "../../data/deployments.json";
import unitDb from "../../data/units.json";
import weaponDb from "../../data/weapons.json";
import spiritDb from "../../data/spirits.json";
import roster from "../../data/roster.json";
import launchShouts from "../../data/launch-shouts.json";

const mapFiles = import.meta.glob("../../data/maps/stage*.json", { eager: true, import: "default" });
const terrainSheets = import.meta.glob("../../assets/original/terrain/env-*.png", { eager: true, import: "default", query: "?url" });
const unitSheets = import.meta.glob("../../assets/original/units/bank-*.png", { eager: true, import: "default", query: "?url" });
const eventFiles = import.meta.glob("../../data/events/stage*.json", { eager: true, import: "default" });
import aiDb from "../../data/events/ai.json";
import type { Script } from "./script.ts";

export interface Weapon {
  id: number;
  name: string;
  range: number;
  hit: number;
  // 对空 / 陆 / 海目标的火力，null 表示打不到
  power: Record<MoveType, number | null>;
  // 射程 1 的武器和 E 类远程武器能在移动后使用；其他远程武器移动后不能用，也打不到相邻格（docs/notes-rules.md 1.1）
  usableAfterMove: boolean;
  // 原版武器表字节：第 0 字节（射程 - 1 和类型）、距离命中衰减曲线
  rangeByte: number;
  curve: number;
}

export interface Spirit {
  id: number;
  name: string;
  cost: number;
  text: string;
}

export interface Unit {
  id: number;
  // 原版单位编号：我方 0–10，敌方 14 起。精神状态只对我方 0–10 有效，规则代码靠它区分阵营
  index: number;
  side: "player" | "enemy";
  unitId: number;
  pilotId: number;
  levelIndex: number; // 原版内部等级，从 0 开始
  exp: number;
  expBase: number; // 被击破时给对方的基础经验
  money: number; // 被击破时给对方的资金
  // 精神状态标志（src/rules/spirits.js FLAG）
  spirit: number;
  // 敌人的 AI 脚本号 / 友军 NPC 的行动脚本号（data/events）
  aiScript: number;
  // 脚本用的状态位（原版 $7757 低 6 位）：bit 5 = 不移动，bit 3、4 由各关脚本自定义
  bits: number;
  // 友军 NPC：我方阵营，但由脚本控制，玩家不能操作
  npc: boolean;
  // 我方单位对应的名册号
  roster: number | null;
  name: string;
  pilotName: string;
  level: number; // 显示用，从 1 开始
  x: number;
  y: number;
  // 地图图标：所在图标表和表内序号
  icon: { sheetUrl: string; index: number };
  moveType: MoveType;
  move: number;
  strength: number;
  defense: number;
  speed: number;
  hp: number;
  maxHp: number;
  sp: number;
  maxSp: number;
  weapons: Weapon[];
  spirits: Spirit[];
  // 机师特性（重制版新增）
  trait: Trait | null;
  // 间章里的改造等级（重制版新增，见 intermission.ts）
  upgrades?: Upgrades;
  // 强化零件加的能力（跟着名册走，见 RosterMember.parts）
  parts?: PartBonus;
  // 击坠数（重制版新增，跟着名册走，出击选择里排序用）
  kills: number;
  // 在母舰里（原版 $77D7 = C0）：不在地图上，但还算在场（脚本的 exists、我方数量照算）
  aboard?: boolean;
  acted: boolean;
}

export interface RosterMember {
  member: number;
  pilot: number;
  unit: number;
  level: number;
  // 累计经验（关与关之间带过去；没有就按等级的起点算）
  exp?: number;
  // 改造等级
  upgrades?: Upgrades;
  // 累计击坠数
  kills?: number;
  // 强化零件加的能力（原版名册的改造值 $746C–$74BC，parts.ts），每关出击时加回去
  parts?: PartBonus;
}

// 强化零件的能力加成（原版载入例程 bank 4 $96D8：加到机体数值上，机动最多 15，其他最多 255，HP 最多 9999）。
// 只截零件加的这部分，重制版改造本身超过原版上限的不动
export interface PartBonus { move: number; strength: number; defense: number; speed: number; maxHp: number }
const PART_CAP: PartBonus = { move: 15, strength: 255, defense: 255, speed: 255, maxHp: 9999 };
function withParts<T extends PartBonus>(s: T, parts?: PartBonus): T {
  if (!parts) return s;
  const out = { ...s };
  for (const k of Object.keys(PART_CAP) as (keyof PartBonus)[]) if (parts[k]) out[k] = Math.max(s[k], Math.min(PART_CAP[k], s[k] + parts[k]));
  return out;
}

// ---------- 改造（重制版新增，docs/design.md 3.5）----------
// 机体改造每段：最大 HP +6%（按原始值）、防卫 +4、速度 +2，改满 10 段机动 +1；武器改造每段：两种武器火力 +7。
// 价钱（原版资金单位，画面 ×10）：机体第 n 段 20 + 15(n−1)，武器第 n 段 15 + 10(n−1)
export interface Upgrades { body: number; weapon: number }
export const MAX_UPGRADE = 10;
export function upgradeCost(part: keyof Upgrades, level: number) {
  return part === "body" ? 20 + 15 * level : 15 + 10 * level;
}
function upgradeStats(s: { maxHp: number; defense: number; speed: number; move: number }, up?: Upgrades) {
  const b = up?.body ?? 0;
  return { maxHp: s.maxHp + Math.round(s.maxHp * 0.06 * b), defense: s.defense + 4 * b, speed: s.speed + 2 * b, move: s.move + (b >= MAX_UPGRADE ? 1 : 0) };
}
// 修理装置（武器第 0 字节高 4 位 F）不吃武器改造
const isRepairWeapon = (w: Weapon) => w.rangeByte >= 0xf0;
function upgradeWeapon(w: Weapon, up?: Upgrades): Weapon {
  const k = 7 * (up?.weapon ?? 0);
  if (!k || isRepairWeapon(w)) return w;
  const add = (v: number | null) => (v === null ? null : v + k);
  return { ...w, power: { air: add(w.power.air), land: add(w.power.land), sea: add(w.power.sea) } };
}

// 间章里看的数值：名册里这个人现在（带改造）的能力和武器火力（火力 = 武器 + 强度，同资料页）
export function memberPreview(m: RosterMember, up: Upgrades = m.upgrades ?? { body: 0, weapon: 0 }) {
  const def = units.get(m.unit)!, pilot = pilots.get(m.pilot)!;
  const st = computeStats(def, pilot, m.level, curves);
  const s = withParts({ ...st, ...upgradeStats(st, up) }, m.parts);
  return {
    name: def.name || mechNames.get(m.unit) || `机体 ${m.unit}`,
    pilotName: pilot.name || personName(m.pilot) || "",
    level: m.level + 1,
    ...s,
    weapons: def.weapons.map(weaponOf).filter((w): w is Weapon => !!w && !isRepairWeapon(w)).map((w) => {
      const u = upgradeWeapon(w, up);
      const p = u.power.land ?? u.power.air ?? u.power.sea;
      return { name: w.name, power: p === null ? 0 : p + st.strength };
    }),
  };
}

export interface StageEvents {
  victoryText: string;
  scripts: { start: Script; enemyPhase: Script; check: Script };
  npcScripts: Record<string, Script>;
  // 格子事件：pilot 为 null 表示谁都行；有 script 的是事件脚本，有 shop 的是商店（data/parts.json 的 shops）
  tiles?: { x: number; y: number; pilot: number | null; script?: Script; shop?: number }[];
  // 劝降（原版表 bank 28 $9E03）：我方驾驶员 pilot 和敌方驾驶员 target 相邻时单位菜单出现「劝降」，选了就跑 script
  persuade: PersuadeEntry[];
}

export interface PersuadeEntry {
  pilot: number;
  target: number;
  index: number;
  script: Script;
}

export interface Stage {
  number: number;
  events: StageEvents;
  unitChrBanks: number[];
  // 当前队伍名册（脚本的入队、离队会改它）
  roster: RosterMember[];
  // 前面关卡带过来的全程标志（≥ 0x80，劝降了谁、谁离队等）
  flags?: number[];
  map: GridMap;
  environment: number;
  terrainSheetUrl: string;
  terrainNames: string[];
  terrainEffect: number[];
  units: Unit[];
}

const units = new Map((unitDb.units as unknown as UnitDef[]).map((u) => [u.id, u]));
const pilots = new Map((unitDb.pilots as unknown as PilotDef[]).map((p) => [p.id, p]));
const weapons = new Map(weaponDb.map((w) => [w.id, w]));
const curves = unitDb.growthCurves as GrowthCurve[];
const MOVE_TYPES: MoveType[] = ["air", "land", "sea"];

const pad = (n: number) => String(n).padStart(2, "0");
const pick = <T>(files: Record<string, unknown>, suffix: string) => {
  const hit = Object.entries(files).find(([path]) => path.endsWith(suffix));
  if (!hit) throw new Error(`找不到数据文件 ${suffix}`);
  return hit[1] as T;
};

function weaponOf(id: number): Weapon | null {
  const w = weapons.get(id);
  const name = w?.name || weaponNames.get(id);
  if (!w || !name) return null;
  return {
    id: w.id,
    name,
    range: w.range,
    hit: w.hit,
    power: { air: w.power.air, land: w.power.land, sea: w.power.sea },
    usableAfterMove: w.range === 1 || w.kind === "moveAndFire",
    rangeByte: parseInt(w.raw.slice(0, 2), 16),
    curve: w.hitFalloff,
  };
}

export interface Placement {
  side: Unit["side"];
  npc?: boolean;
  roster?: number;
  x: number;
  y: number;
  unitId: number;
  pilotId: number;
  level: number;
  exp?: number;
  upgrades?: Upgrades;
  parts?: PartBonus;
  kills?: number;
  aiScript: number;
}

// 单位编号：我方 0–10、友军 NPC 11–13、敌方 14–31（原版单位槽），用于规则里区分阵营
function nextIndex(stage: Stage, p: Placement) {
  const [from, to] = p.side === "enemy" ? [14, 31] : p.npc ? [11, 13] : [0, 10];
  for (let i = from; i <= to; i++) if (!stage.units.some((u) => u.index === i && u.hp > 0)) return i;
  return to;
}

// 生成一个单位（开局部署和脚本中途出场都用它）
export function createUnit(stage: Stage, p: Placement): Unit {
  const def = units.get(p.unitId);
  const pilot = pilots.get(p.pilotId);
  if (!def || !pilot) throw new Error(`单位缺数据：机体 ${p.unitId}，驾驶员 ${p.pilotId}`);
  const stats = { ...computeStats(def, pilot, p.level, curves) };
  Object.assign(stats, withParts({ ...stats, ...upgradeStats(stats, p.upgrades) }, p.parts));
  // 地图图标号：高 2 位决定在哪个 1KB CHR bank（每关不同），低 6 位 ÷ 4 是 bank 内序号
  const bank = stage.unitChrBanks[def.sprite >> 6];
  const moveType = MOVE_TYPES.includes(def.type as MoveType) ? (def.type as MoveType) : "land";
  const isPlayer = p.side === "player" && !p.npc;
  return {
    id: Math.max(-1, ...stage.units.map((u) => u.id)) + 1,
    index: nextIndex(stage, p),
    side: p.side,
    unitId: p.unitId,
    pilotId: p.pilotId,
    levelIndex: p.level,
    // 累计经验：带过来的就用，否则按这一级的起点（不然高等级的人会显示「升级还需几千」）
    exp: p.exp ?? (p.level > 0 ? expThreshold(p.level - 1) : 0),
    expBase: (def as unknown as { expBase: number }).expBase,
    money: (def as unknown as { money: number }).money,
    spirit: 0,
    aiScript: p.aiScript,
    bits: 0,
    npc: !!p.npc,
    roster: p.roster ?? null,
    kills: p.kills ?? 0,
    name: def.name || mechNames.get(p.unitId) || `机体 ${p.unitId}`,
    // 驾驶员数据表里有些名字没解出来，用剧情的人名表（下标同样是人物编号）补上
    pilotName: pilot.name || personName(p.pilotId) || (p.side === "enemy" ? "" : `驾驶员 ${p.pilotId}`),
    level: p.level + 1,
    x: p.x,
    y: p.y,
    icon: { sheetUrl: pick<string>(unitSheets, `bank-${bank}-${p.side === "enemy" ? "enemy" : "player"}.png`), index: (def.sprite & 0x3f) >> 2 },
    moveType,
    move: stats.move,
    strength: stats.strength,
    defense: stats.defense,
    speed: stats.speed,
    hp: stats.maxHp,
    maxHp: stats.maxHp,
    // 原版只有我方单位有精神点数（$7822，0–10 号）
    sp: isPlayer ? stats.maxSp : 0,
    maxSp: isPlayer ? stats.maxSp : 0,
    weapons: def.weapons.map(weaponOf).filter((w): w is Weapon => !!w).map((w) => upgradeWeapon(w, p.upgrades)),
    upgrades: p.upgrades,
    parts: p.parts,
    spirits: isPlayer ? pilot.spirits.map((s) => spiritDb[s]).filter(Boolean).map((s) => ({ id: s.id, name: s.name, cost: s.cost, text: s.text })) : [],
    trait: traitOf(p.pilotId, p.level + 1),
    acted: false,
  };
}

// ---------- 变形 ----------
// 机体表第 0 字节：两段变形（形态 0、1）或盖塔式三段变形（形态 1–3，形态 0 是全 0 的占位记录）。
// 组首编号 = 编号 − 形态序号（docs/notes-units.md「机体表」）
interface TransformInfo { kind: "double" | "triple"; formIndex: number; baseId: number }
const transformOf = (id: number) => (units.get(id) as unknown as { transform?: TransformInfo | null })?.transform ?? null;

// 这台机体能变成的所有形态（含自己），按形态顺序；不能变形时只有自己
// 存档里的单位带着存档时的精神说明；读档后按当前数据刷新（说明文字改过时老存档也跟着变）
export function refreshSpiritText(units: Unit[]) {
  for (const u of units) for (const sp of u.spirits) {
    const cur = spiritDb[sp.id as keyof typeof spiritDb] as { text: string } | undefined;
    if (cur) sp.text = cur.text;
  }
}

export function formsOf(unitId: number): number[] {
  const t = transformOf(unitId);
  if (!t) return [unitId];
  const ids = t.kind === "triple" ? [t.baseId + 1, t.baseId + 2, t.baseId + 3] : [t.baseId, t.baseId + 1];
  return ids.filter((id) => units.has(id) && (units.get(id)!.hp > 0));
}

export function formIndexOf(unitId: number) {
  return transformOf(unitId)?.formIndex ?? 0;
}

export function mechName(unitId: number) {
  return units.get(unitId)?.name || mechNames.get(unitId) || `机体 ${unitId}`;
}

// 盖塔三人（龙 8、欧文 9、路易 10）：盖塔式三段变形时，形态 1/2/3 的主驾驶员分别是他们（原版实测）
const GETTER_TEAM = [8, 9, 10];
export function pilotForForm(pilotId: number, unitId: number) {
  const t = transformOf(unitId);
  if (t?.kind === "triple" && GETTER_TEAM.includes(pilotId)) return GETTER_TEAM[t.formIndex - 1] ?? pilotId;
  return pilotId;
}

// 变形：换机体（和盖塔的主驾驶员），能力值、武器、精神、特性、图标换成新的；HP、SP 保留（不超过新的上限）。
// 脚本换乘、转阵营也用它重建单位（newPilot = 换驾驶员）
export function transformUnit(stage: Stage, unit: Unit, newUnitId: number, newPilot?: number) {
  const pilotId = newPilot ?? pilotForForm(unit.pilotId, newUnitId);
  const fresh = createUnit(stage, { side: unit.side, npc: unit.npc, roster: unit.roster ?? undefined, x: unit.x, y: unit.y, unitId: newUnitId, pilotId, level: unit.levelIndex, upgrades: unit.upgrades, parts: unit.parts, aiScript: unit.aiScript });
  const keep = { id: unit.id, index: unit.index, hp: unit.hp, sp: unit.sp, exp: unit.exp, spirit: unit.spirit, bits: unit.bits, kills: unit.kills, acted: unit.acted };
  Object.assign(unit, fresh, keep);
  unit.hp = Math.min(unit.hp, unit.maxHp);
  unit.sp = Math.min(unit.sp, unit.maxSp);
  // 名册也记成新形态，下一关出击时保持
  const m = stage.roster.find((r) => r.member === unit.roster);
  if (m) { m.unit = newUnitId; m.pilot = pilotId; }
}

// 升到下一级还差多少经验（门槛表 A，现有驾驶员都用它）；满级返回 null
export function expToNext(unit: Unit): number | null {
  return Math.max(0, expThreshold(unit.levelIndex) - unit.exp);
}

// 当前等级里的经验进度：已得 / 这一级共需（满级时 null）
export function expProgress(levelIndex: number, exp: number): { into: number; span: number } | null {
  const need = expThreshold(levelIndex);
  const from = levelIndex > 0 ? expThreshold(levelIndex - 1) : 0;
  return { into: Math.max(0, exp - from), span: Math.max(1, need - from) };
}

export const AI_SCRIPTS = (aiDb as unknown as { scripts: Record<string, Script> }).scripts;

// 这一关有没有数据（地图和事件都在）
export function hasStage(number: number) {
  return Object.keys(mapFiles).some((p) => p.endsWith(`stage${pad(number)}.json`)) && Object.keys(eventFiles).some((p) => p.endsWith(`stage${pad(number)}.json`));
}

// 在地图上：活着、不在母舰里
export const onMap = (u: Unit) => u.hp > 0 && !u.aboard;
// 母舰 = 原版单位槽 0，也就是名册 0 号（原版固定进槽 0）。看的是槽号不是机体（模拟器实测，docs/notes-rules.md「母舰」）。
// 重制版的单位编号按部署顺序分，不一定是 0，所以看名册号
export const isCarrier = (u: Unit) => u.side === "player" && !u.npc && u.roster === 0;
// 从母舰起飞时的喊话（文本资源 0x37 第几条）：按驾驶员和机体号范围查原版的表（data/launch-shouts.json），查不到不喊
export function launchShout(u: Unit): number | null {
  return launchShouts.rows.find((r) => r.pilot === u.pilotId && u.unitId >= r.mechFrom && u.unitId <= r.mechTo)?.shout ?? null;
}

// 开局名册（data/roster.json）
export const INITIAL_ROSTER: RosterMember[] = roster.members;

// 这一关的目标（从脚本里读）：脚本里「exists p」之后，p 不在了的那条路（条件跳转两边都跟）一定走到 gameOver、
// 而 p 还在的那条路不一定，p 就是 mustLive（不在了就失败）；同理一定走到过关 / 结局的是 defeat（打倒就过关）。
// exits = 撤离格（格子脚本里有 removeSelf）
type Op = { at: string; op: string; pilot?: number; to?: string };
function outcomes(ops: Op[], start: number): Set<string> {
  const out = new Set<string>(), seen = new Set<number>(), todo = [start];
  while (todo.length) {
    const i = todo.pop()!;
    if (i < 0 || i >= ops.length || seen.has(i)) continue;
    seen.add(i);
    const o = ops[i], to = () => ops.findIndex((x) => x.at === o.to);
    if (o.op === "gameOver") out.add("lose");
    else if (o.op === "stageClear" || o.op === "ending") out.add("win");
    else if (o.op === "stop") out.add("stop");
    else if (o.op === "jump") todo.push(to());
    else if (o.op === "jumpIfTrue" || o.op === "jumpIfFalse") todo.push(to(), i + 1);
    else todo.push(i + 1);
  }
  return out;
}
const only = (s: Set<string>, kind: string) => s.size === 1 && s.has(kind);
export function stageGoals(events: StageEvents) {
  const mustLive = new Set<number>(), defeat = new Set<number>();
  for (const sc of Object.values(events.scripts ?? {})) {
    const ops = (sc as Script).ops as Op[];
    ops.forEach((o, i) => {
      if (o.op !== "exists" || o.pilot === undefined || ops[i + 1]?.op !== "jumpIfFalse") return;
      const gone = outcomes(ops, ops.findIndex((x) => x.at === ops[i + 1].to)), here = outcomes(ops, i + 2);
      if (only(gone, "lose") && !only(here, "lose")) mustLive.add(o.pilot);
      if (only(gone, "win") && !only(here, "win")) defeat.add(o.pilot);
    });
  }
  const exits = (events.tiles ?? []).filter((t) => t.script?.ops.some((o) => o.op === "removeSelf")).map((t) => ({ x: t.x, y: t.y }));
  return { mustLive: [...mustLive], defeat: [...defeat], exits };
}

// 出击选择（重制版新增，docs/design.md 4.4）：这一关原版的出场名单（部署第 4 段，每个位置对应一个名册号）里、
// 名册上有的人可以选。主角（名册 0 号，原版固定进单位槽 0）和剧情里不在了就失败的人（stageGoals 的 mustLive）
// 必须出场。名单外的人原版这一关剧情里不在场，不能带上
export function stageLineup(number: number, rosterMembers: RosterMember[]) {
  const { mustLive } = stageGoals(pick<StageEvents>(eventFiles, `stage${pad(number)}.json`));
  const slots = deployments[number - 1].players.map((p) => p.order);
  const members = slots.map((n) => rosterMembers.find((m) => m.member === n)).filter((m): m is RosterMember => !!m);
  const forced = new Set(members.filter((m) => m.member === 0 || mustLive.some((p) => samePilot(m.pilot, p))).map((m) => m.member));
  return { slots: slots.length, members, forced };
}

// 开发测试用：直接从第 n 关开始时，模拟一路打过来的名册。把前面各关脚本里的入队、离队、换机体按顺序走一遍
// （劝降这类看玩家选择的不算）。像一个正常练级、用间章改造的玩家：等级至少比这一关敌人的平均等级高 5，
// 机体、武器各改 5 段（只拉到敌人平均等级、不改造的话，后半程连主力都打不过头目）
export function campaignRoster(n: number): RosterMember[] {
  const team = new Map(INITIAL_ROSTER.map((m) => [m.member, { ...m }]));
  type RosterOp = { op: string; roster?: number; pilot?: number; newPilot?: number; mech?: number; level?: number };
  for (let s = 1; s < n; s++) {
    const events = pick<StageEvents>(eventFiles, `stage${pad(s)}.json`);
    for (const sc of Object.values(events.scripts)) for (const o of (sc as Script).ops as RosterOp[]) {
      if (o.op === "rosterAdd") team.set(o.roster!, { member: o.roster!, pilot: o.pilot!, unit: o.mech!, level: o.level! });
      else if (o.op === "rosterRemove") team.delete(o.roster!);
      else if (o.op === "changeMech" || o.op === "changePilotMech") {
        const m = [...team.values()].find((x) => samePilot(x.pilot, o.pilot!));
        if (m) { m.unit = o.mech!; if (o.newPilot !== undefined) m.pilot = o.newPilot; }
      }
    }
  }
  const foes = deployments[n - 1].enemies;
  const level = foes.length ? Math.round(foes.reduce((a, e) => a + e.b, 0) / foes.length) : 0;
  return [...team.values()].map((m) => ({ ...m, level: Math.max(m.level, level + 5), exp: undefined, upgrades: { body: 5, weapon: 5 } }));
}

// benched：出击选择里没选上的名册号（剧情中途靠脚本出场的照样会出来）
export function loadStage(number: number, rosterMembers: RosterMember[] = roster.members, benched: number[] = []): Stage {
  const raw = pick<{ width: number; height: number; environment: number; unitChrBanks: number[]; terrain: number[][] }>(mapFiles, `stage${pad(number)}.json`);
  const env = environments[raw.environment];
  const events = pick<StageEvents>(eventFiles, `stage${pad(number)}.json`);
  // 部署块第 n 块 = 第 n 关（docs/notes-events.md 第 1 节）
  const deploy = deployments[number - 1];

  const stage: Stage = {
    number,
    events,
    unitChrBanks: raw.unitChrBanks,
    roster: rosterMembers.map((m) => ({ ...m })),
    environment: raw.environment,
    map: { width: raw.width, height: raw.height, terrain: raw.terrain, moveCost: env.moveCostRaw },
    terrainSheetUrl: pick<string>(terrainSheets, `env-${raw.environment}.png`),
    terrainNames: terrainNames.environments[raw.environment],
    terrainEffect: env.terrainEffectRaw,
    units: [],
  };

  const placements: Placement[] = [];
  // 我方：部署第 4 段的第三个字节是名册号，名册里有人才出击
  for (const p of deploy.players) {
    const member = stage.roster.find((m) => m.member === p.order);
    if (member && !benched.includes(member.member)) placements.push({ side: "player", roster: member.member, x: p.x, y: p.y, unitId: member.unit, pilotId: member.pilot, level: member.level, exp: member.exp, upgrades: member.upgrades, parts: member.parts, kills: member.kills, aiScript: 0 });
  }
  // 敌人记录：参数 a = 驾驶员，b = 等级（从 0 开始），c = AI 脚本
  for (const e of deploy.enemies) placements.push({ side: "enemy", x: e.x, y: e.y, unitId: e.unit, pilotId: e.a, level: e.b, aiScript: e.c });
  // 部署第 3 段：开局就在场的友军 NPC，最后一字节是行动脚本号
  for (const n of deploy.extra2) placements.push({ side: "player", npc: true, x: n.x, y: n.y, unitId: n.unit, pilotId: n.a, level: n.b, aiScript: n.c });
  for (const p of placements) stage.units.push(createUnit(stage, p));
  return stage;
}

// 升级后重算能力：只提高上限，当前 HP / SP 不变（原版实测，docs/notes-rules.md 2.2）
export function applyLevel(unit: Unit, levelIndex: number) {
  const base = computeStats(units.get(unit.unitId)!, pilots.get(unit.pilotId)!, levelIndex, curves);
  const stats = withParts({ ...base, ...upgradeStats(base, unit.upgrades) }, unit.parts);
  unit.levelIndex = levelIndex;
  unit.level = levelIndex + 1;
  unit.speed = stats.speed;
  unit.strength = stats.strength;
  unit.defense = stats.defense;
  unit.maxHp = stats.maxHp;
  unit.maxSp = stats.maxSp;
}

// 地形效果原始值：0x64 = 100。推测是「受到伤害的百分比」，低于 100 就是防御加成；最高位含义未知，先忽略
export function defenseBonus(effectRaw: number): number {
  return 100 - (effectRaw & 0x7f);
}

export const TYPE_LABEL: Record<MoveType, string> = { air: "空", land: "陆", sea: "海" };
