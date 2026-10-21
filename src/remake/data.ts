// 读取从 ROM 提取的数据，整理成游戏用的结构。数据文件打包进构建产物，不需要运行时再请求。
import type { GridMap, MoveType } from "./grid.ts";
import environments from "../../data/environments.json";
import terrainNames from "../../data/terrain-names.json";

const mapFiles = import.meta.glob("../../data/maps/stage*.json", { eager: true, import: "default" });
const snapshotFiles = import.meta.glob("../../data/snapshots/stage*.json", { eager: true, import: "default" });
const terrainSheets = import.meta.glob("../../assets/original/terrain/env-*.png", { eager: true, import: "default", query: "?url" });
const iconFiles = import.meta.glob("../../assets/original/icons/*.png", { eager: true, import: "default", query: "?url" });

export interface Unit {
  id: number;
  side: "player" | "enemy";
  name: string;
  x: number;
  y: number;
  iconUrl: string;
  moveType: MoveType;
  move: number;
  strength: number;
  defense: number;
  speed: number;
  hp: number;
  maxHp: number;
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

interface SnapshotUnit {
  slot: number;
  side: "player" | "enemy";
  x: number;
  y: number;
  icon: string;
  move: number;
  strength: number;
  defense: number;
  speed: number;
  hp: number;
  maxHp: number;
}

// 机体数据表完成前的临时补充：快照里还没有名字和移动类型，先手动标出已经确认的
const KNOWN_UNITS: Record<string, Record<number, { name: string; moveType: MoveType }>> = {
  "1": { 5: { name: "太勒", moveType: "air" } },
};

const pad = (n: number) => String(n).padStart(2, "0");
const pick = <T>(files: Record<string, unknown>, suffix: string) => {
  const hit = Object.entries(files).find(([path]) => path.endsWith(suffix));
  if (!hit) throw new Error(`找不到数据文件 ${suffix}`);
  return hit[1] as T;
};

export function loadStage(number: number): Stage {
  const raw = pick<{ width: number; height: number; environment: number; terrain: number[][] }>(mapFiles, `stage${pad(number)}.json`);
  const env = environments[raw.environment];
  const snapshot = pick<{ units: SnapshotUnit[] }>(snapshotFiles, `stage${pad(number)}.json`);
  const known = KNOWN_UNITS[String(number)] ?? {};
  let enemyCount = 0;
  let playerCount = 0;

  return {
    number,
    environment: raw.environment,
    map: { width: raw.width, height: raw.height, terrain: raw.terrain, moveCost: env.moveCostRaw },
    terrainSheetUrl: pick<string>(terrainSheets, `env-${raw.environment}.png`),
    terrainNames: terrainNames.environments[raw.environment],
    terrainEffect: env.terrainEffectRaw,
    units: snapshot.units.map((u, id) => {
      const fallback = u.side === "player" ? `我方 ${++playerCount}` : `敌方 ${++enemyCount}`;
      const k = known[u.slot];
      return {
        id,
        side: u.side,
        name: k?.name ?? fallback,
        x: u.x,
        y: u.y,
        iconUrl: pick<string>(iconFiles, u.icon.replace("icons/", "")),
        moveType: k?.moveType ?? "land",
        move: u.move,
        strength: u.strength,
        defense: u.defense,
        speed: u.speed,
        hp: u.hp,
        maxHp: u.maxHp,
        acted: false,
      };
    }),
  };
}

// 地形效果原始值：0x64 = 100。推测是「受到伤害的百分比」，低于 100 就是防御加成；最高位含义未知，先忽略
export function defenseBonus(effectRaw: number): number {
  return 100 - (effectRaw & 0x7f);
}
