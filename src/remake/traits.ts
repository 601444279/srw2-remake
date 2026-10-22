// 机师特性（重制版新增）：数值都在 data/pilot-traits.json，边玩边改。
// 规则：在原版公式算完之后再加减，精神指令的「必杀」「回避」仍然优先（命中 100 / 0 不受特性影响）。
// 特性成长：驾驶员到 growth 里的等级时强化一档（数值和说明覆盖前一档），设置里可以关掉。
import traitDb from "../../data/pilot-traits.json" with { type: "json" };

export interface TraitValues {
  hit?: number;
  evade?: number;
  speed?: number;
  rangedHit?: number;
  lowHp?: number;
  lowHpDamage?: number;
  damageTaken?: number;
  lowHpDamageTaken?: number;
  counterDamage?: number;
  spOnKill?: number;
  spPerTurn?: number;
  hpPerTurn?: number;
  auraHit?: number;
  auraRange?: number;
}

export interface Trait extends TraitValues {
  id: string;
  name: string;
  text: string;
  tier: number; // 第几档，从 1 起
  // 下一档：在哪个等级、强化成什么样（没有下一档就是 null）
  next: { level: number; text: string } | null;
}

interface TraitDef extends TraitValues {
  name: string;
  text: string;
  growth?: ({ level: number; text: string } & TraitValues)[];
}

const traits = traitDb.traits as Record<string, TraitDef>;
const byPilot = traitDb.pilots as Record<string, string>;

export const TIER_MARKS = ["", "", "Ⅱ", "Ⅲ", "Ⅳ", "Ⅴ"];

// level = 显示等级；growth = false 时只用第一档
export function traitOf(pilotId: number, level = 1, growth = true): Trait | null {
  const id = byPilot[String(pilotId)];
  const def = id && traits[id];
  if (!def) return null;
  const { growth: tiers = [], ...base } = def;
  const reached = growth ? tiers.filter((t) => level >= t.level) : [];
  const values = Object.assign({}, base, ...reached.map(({ level: _l, ...v }) => v));
  const upcoming = growth ? tiers.find((t) => level < t.level) : undefined;
  return { id, ...values, tier: reached.length + 1, next: upcoming ? { level: upcoming.level, text: upcoming.text } : null };
}

// 带档位的名字：新人类 Ⅱ
export function traitLabel(t: Trait) {
  return t.tier > 1 ? `${t.name} ${TIER_MARKS[t.tier] ?? t.tier}` : t.name;
}
