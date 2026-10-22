// 读取从 ROM 提取的数据，组装成游戏用的结构。数据文件打包进构建产物，不需要运行时再请求。
//   地图、地图环境、部署：data/maps、data/environments.json、data/deployments.json（tools/extract-maps.js）
//   机体、驾驶员、武器、精神：data/units.json、data/weapons.json、data/spirits.json（tools/extract-units.js）
import type { GridMap, MoveType } from "./grid.ts";
import { computeStats, type GrowthCurve, type PilotDef, type UnitDef } from "./stats.ts";
import { traitOf, type Trait } from "./traits.ts";
import { personName } from "./story.ts";
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

const mapFiles = import.meta.glob("../../data/maps/stage*.json", { eager: true, import: "default" });
const terrainSheets = import.meta.glob("../../assets/original/terrain/env-*.png", { eager: true, import: "default", query: "?url" });
const unitSheets = import.meta.glob("../../assets/original/units/bank-*.png", { eager: true, import: "default", query: "?url" });
const eventFiles = import.meta.glob("../../data/events/stage*.json", { eager: true, import: "default" });
import { EXP_TABLE_A } from "../rules/growth.js";
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
  acted: boolean;
}

export interface RosterMember {
  member: number;
  pilot: number;
  unit: number;
  level: number;
}

export interface StageEvents {
  victoryText: string;
  scripts: { start: Script; enemyPhase: Script; check: Script };
  npcScripts: Record<string, Script>;
}

export interface Stage {
  number: number;
  events: StageEvents;
  unitChrBanks: number[];
  // 当前队伍名册（脚本的入队、离队会改它）
  roster: RosterMember[];
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
  const stats = computeStats(def, pilot, p.level, curves);
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
    exp: 0,
    expBase: (def as unknown as { expBase: number }).expBase,
    money: (def as unknown as { money: number }).money,
    spirit: 0,
    aiScript: p.aiScript,
    bits: 0,
    npc: !!p.npc,
    roster: p.roster ?? null,
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
    weapons: def.weapons.map(weaponOf).filter((w): w is Weapon => !!w),
    spirits: isPlayer ? pilot.spirits.map((s) => spiritDb[s]).filter(Boolean).map((s) => ({ id: s.id, name: s.name, cost: s.cost, text: s.text })) : [],
    trait: traitOf(p.pilotId),
    acted: false,
  };
}

// ---------- 变形 ----------
// 机体表第 0 字节：两段变形（形态 0、1）或盖塔式三段变形（形态 1–3，形态 0 是全 0 的占位记录）。
// 组首编号 = 编号 − 形态序号（docs/notes-units.md「机体表」）
interface TransformInfo { kind: "double" | "triple"; formIndex: number; baseId: number }
const transformOf = (id: number) => (units.get(id) as unknown as { transform?: TransformInfo | null })?.transform ?? null;

// 这台机体能变成的所有形态（含自己），按形态顺序；不能变形时只有自己
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

// 变形：换机体（和盖塔的主驾驶员），能力值、武器、精神、特性、图标换成新的；HP、SP 保留（不超过新的上限）
export function transformUnit(stage: Stage, unit: Unit, newUnitId: number) {
  const pilotId = pilotForForm(unit.pilotId, newUnitId);
  const fresh = createUnit(stage, { side: unit.side, npc: unit.npc, roster: unit.roster ?? undefined, x: unit.x, y: unit.y, unitId: newUnitId, pilotId, level: unit.levelIndex, aiScript: unit.aiScript });
  const keep = { id: unit.id, index: unit.index, hp: unit.hp, sp: unit.sp, exp: unit.exp, spirit: unit.spirit, bits: unit.bits, acted: unit.acted };
  Object.assign(unit, fresh, keep);
  unit.hp = Math.min(unit.hp, unit.maxHp);
  unit.sp = Math.min(unit.sp, unit.maxSp);
  // 名册也记成新形态，下一关出击时保持
  const m = stage.roster.find((r) => r.member === unit.roster);
  if (m) { m.unit = newUnitId; m.pilot = pilotId; }
}

// 升到下一级还差多少经验（门槛表 A，现有驾驶员都用它）；满级返回 null
export function expToNext(unit: Unit): number | null {
  const need = EXP_TABLE_A[unit.levelIndex];
  return need === undefined ? null : Math.max(0, need - unit.exp);
}

export const AI_SCRIPTS = (aiDb as unknown as { scripts: Record<string, Script> }).scripts;

export function loadStage(number: number, rosterMembers: RosterMember[] = roster.members): Stage {
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
    if (member) placements.push({ side: "player", roster: member.member, x: p.x, y: p.y, unitId: member.unit, pilotId: member.pilot, level: member.level, aiScript: 0 });
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
  const stats = computeStats(units.get(unit.unitId)!, pilots.get(unit.pilotId)!, levelIndex, curves);
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
