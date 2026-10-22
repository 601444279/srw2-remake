// 读取从 ROM 提取的数据，组装成游戏用的结构。数据文件打包进构建产物，不需要运行时再请求。
//   地图、地图环境、部署：data/maps、data/environments.json、data/deployments.json（tools/extract-maps.js）
//   机体、驾驶员、武器、精神：data/units.json、data/weapons.json、data/spirits.json（tools/extract-units.js）
import type { GridMap, MoveType } from "./grid.ts";
import { computeStats, type GrowthCurve, type PilotDef, type UnitDef } from "./stats.ts";
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

export interface Weapon {
  name: string;
  range: number;
  hit: number;
  // 对空 / 陆 / 海目标的火力，null 表示打不到
  power: Record<MoveType, number | null>;
  // 原版只有射程 1 的武器和标记为「移动后可用」的武器能在移动后使用（待战斗规则确认）
  usableAfterMove: boolean;
}

export interface Spirit {
  name: string;
  cost: number;
  text: string;
}

export interface Unit {
  id: number;
  side: "player" | "enemy";
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
  acted: boolean;
}

export interface Stage {
  number: number;
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
  if (!w || !w.name) return null;
  return {
    name: w.name,
    range: w.range,
    hit: w.hit,
    power: { air: w.power.air, land: w.power.land, sea: w.power.sea },
    usableAfterMove: w.range === 1 || w.kind === "moveAndFire",
  };
}

interface Placement {
  side: Unit["side"];
  x: number;
  y: number;
  unitId: number;
  pilotId: number;
  level: number;
}

function buildUnit(id: number, p: Placement, unitChrBanks: number[]): Unit {
  const def = units.get(p.unitId);
  const pilot = pilots.get(p.pilotId);
  if (!def || !pilot) throw new Error(`第 ${id} 个单位缺数据：机体 ${p.unitId}，驾驶员 ${p.pilotId}`);
  const stats = computeStats(def, pilot, p.level, curves);
  // 地图图标号：高 2 位决定在哪个 1KB CHR bank（每关不同），低 6 位 ÷ 4 是 bank 内序号
  const bank = unitChrBanks[def.sprite >> 6];
  const moveType = MOVE_TYPES.includes(def.type as MoveType) ? (def.type as MoveType) : "land";
  return {
    id,
    side: p.side,
    name: def.name ?? `机体 ${p.unitId}`,
    pilotName: pilot.name ?? (p.side === "enemy" ? "" : `驾驶员 ${p.pilotId}`),
    level: p.level + 1,
    x: p.x,
    y: p.y,
    icon: { sheetUrl: pick<string>(unitSheets, `bank-${bank}-${p.side}.png`), index: (def.sprite & 0x3f) >> 2 },
    moveType,
    move: stats.move,
    strength: stats.strength,
    defense: stats.defense,
    speed: stats.speed,
    hp: stats.maxHp,
    maxHp: stats.maxHp,
    sp: stats.maxSp,
    maxSp: stats.maxSp,
    weapons: def.weapons.map(weaponOf).filter((w): w is Weapon => !!w),
    spirits: pilot.spirits.map((s) => spiritDb[s]).filter(Boolean).map((s) => ({ name: s.name, cost: s.cost, text: s.text })),
    acted: false,
  };
}

export function loadStage(number: number): Stage {
  const raw = pick<{ width: number; height: number; environment: number; unitChrBanks: number[]; terrain: number[][] }>(mapFiles, `stage${pad(number)}.json`);
  const env = environments[raw.environment];
  // 部署块和关卡的对应关系待确认，目前按序号对应（第一关已核对）
  const deploy = deployments[number - 1];

  const placements: Placement[] = [];
  for (const p of deploy.players) {
    const member = roster.members.find((m) => m.member === p.order);
    if (member) placements.push({ side: "player", x: p.x, y: p.y, unitId: member.unit, pilotId: member.pilot, level: member.level });
  }
  // 敌人记录：参数 a = 驾驶员，参数 b = 等级（从 0 开始）
  for (const e of deploy.enemies) placements.push({ side: "enemy", x: e.x, y: e.y, unitId: e.unit, pilotId: e.a, level: e.b });

  return {
    number,
    environment: raw.environment,
    map: { width: raw.width, height: raw.height, terrain: raw.terrain, moveCost: env.moveCostRaw },
    terrainSheetUrl: pick<string>(terrainSheets, `env-${raw.environment}.png`),
    terrainNames: terrainNames.environments[raw.environment],
    terrainEffect: env.terrainEffectRaw,
    units: placements.map((p, i) => buildUnit(i, p, raw.unitChrBanks)),
  };
}

// 地形效果原始值：0x64 = 100。推测是「受到伤害的百分比」，低于 100 就是防御加成；最高位含义未知，先忽略
export function defenseBonus(effectRaw: number): number {
  return 100 - (effectRaw & 0x7f);
}

export const TYPE_LABEL: Record<MoveType, string> = { air: "空", land: "陆", sea: "海" };
