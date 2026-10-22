// 按原版规则从 ROM 数据算出单位数值：机体基础值 + 成长曲线前「等级」项之和 + 驾驶员加成。
// 等级按原版存储方式从 0 开始（显示时 +1）。规则见 docs/notes-units.md「等级与成长」。
// 重制版不设数值上限：原版最高 50 级、经验 65535、HP 9999，这里都放开（机动仍按原版最多 15 格）。
// 50 级以后：成长曲线按最后两级的增量继续，升级门槛按最后一档的间隔逐级加 100。

export interface UnitDef {
  id: number;
  name: string | null;
  type: "air" | "land" | "sea" | string;
  sprite: number;
  move: number;
  speed: number;
  strength: number;
  defense: number;
  hp: number;
  growth: { speed: number; strength: number; defense: number; hp: number };
  weapons: number[];
}

export interface PilotDef {
  id: number;
  name: string | null;
  sp: number;
  spGrowth: number;
  spirits: number[];
  bonus: { move?: number; strength?: number; defense?: number; speed?: number; hp?: number };
}

export interface GrowthCurve {
  id: number;
  perLevel: number[];
}

export interface Stats {
  move: number;
  speed: number;
  strength: number;
  defense: number;
  maxHp: number;
  maxSp: number;
}

const MOVE_CAP = 15;

function grow(curves: GrowthCurve[], curve: number, level: number) {
  const per = curves[curve].perLevel;
  let sum = 0;
  for (let i = 0; i < level; i++) sum += per[i] ?? per[per.length - 2 + ((i - per.length) & 1)] ?? 0;
  return sum;
}

// 累计经验门槛：从等级 levelIndex 升到下一级需要的累计经验（原版表 A，现有驾驶员都用它）
const EXP_TABLE = [
  30, 80, 170, 310, 600, 900, 1300, 1800, 2400, 3000, 3800, 4580, 5520, 6720, 7680, 8700, 9780, 10920, 12120, 13380,
  14700, 16080, 17520, 19020, 20580, 22200, 23880, 25680, 27480, 29340, 31140, 33120, 35160, 37260, 39480, 41700, 43980,
  46320, 48720, 51180, 53740, 54740, 55790, 56890, 58050, 59270, 60550, 61890, 63290,
];
export function expThreshold(levelIndex: number): number {
  if (levelIndex < EXP_TABLE.length) return EXP_TABLE[levelIndex];
  const n = levelIndex - EXP_TABLE.length + 1;
  const last = EXP_TABLE.at(-1)! - EXP_TABLE.at(-2)!;
  return EXP_TABLE.at(-1)! + n * last + (100 * n * (n + 1)) / 2;
}

// 加经验后的等级：可以连升，没有上限
export function levelForExp(exp: number, levelIndex: number): number {
  while (exp >= expThreshold(levelIndex)) levelIndex++;
  return levelIndex;
}

export function computeStats(unit: UnitDef, pilot: PilotDef, level: number, curves: GrowthCurve[]): Stats {
  const b = pilot.bonus;
  return {
    move: Math.min(MOVE_CAP, unit.move + (b.move ?? 0)),
    speed: unit.speed + grow(curves, unit.growth.speed, level) + (b.speed ?? 0),
    strength: unit.strength + grow(curves, unit.growth.strength, level) + (b.strength ?? 0),
    defense: unit.defense + grow(curves, unit.growth.defense, level) + (b.defense ?? 0),
    maxHp: unit.hp + grow(curves, unit.growth.hp, level) + (b.hp ?? 0),
    maxSp: pilot.sp + grow(curves, pilot.spGrowth, level),
  };
}
