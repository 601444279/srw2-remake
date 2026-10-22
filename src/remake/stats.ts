// 按原版规则从 ROM 数据算出单位数值：机体基础值 + 成长曲线前「等级」项之和 + 驾驶员加成。
// 等级按原版存储方式从 0 开始（显示时 +1）。规则见 docs/notes-units.md「等级与成长」。

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
const HP_CAP = 9999;

const grow = (curves: GrowthCurve[], curve: number, level: number) =>
  curves[curve].perLevel.slice(0, level).reduce((a, b) => a + b, 0);

export function computeStats(unit: UnitDef, pilot: PilotDef, level: number, curves: GrowthCurve[]): Stats {
  const b = pilot.bonus;
  return {
    move: Math.min(MOVE_CAP, unit.move + (b.move ?? 0)),
    speed: unit.speed + grow(curves, unit.growth.speed, level) + (b.speed ?? 0),
    strength: unit.strength + grow(curves, unit.growth.strength, level) + (b.strength ?? 0),
    defense: unit.defense + grow(curves, unit.growth.defense, level) + (b.defense ?? 0),
    maxHp: Math.min(HP_CAP, unit.hp + grow(curves, unit.growth.hp, level) + (b.hp ?? 0)),
    maxSp: pilot.sp + grow(curves, pilot.spGrowth, level),
  };
}
