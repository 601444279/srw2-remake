// 机师特性（重制版新增）：数值都在 data/pilot-traits.json，边玩边改。
// 规则：在原版公式算完之后再加减，精神指令的「必杀」「回避」仍然优先（命中 100 / 0 不受特性影响）。
import traitDb from "../../data/pilot-traits.json";

export interface Trait {
  id: string;
  name: string;
  text: string;
  hit?: number;
  evade?: number;
  speed?: number;
  rangedHit?: number;
  lowHp?: number;
  lowHpDamage?: number;
  damageTaken?: number;
  lowHpDamageTaken?: number;
  spOnKill?: number;
  spPerTurn?: number;
  hpPerTurn?: number;
  auraHit?: number;
  auraRange?: number;
}

const traits = traitDb.traits as Record<string, Omit<Trait, "id">>;
const byPilot = traitDb.pilots as Record<string, string>;

export function traitOf(pilotId: number): Trait | null {
  const id = byPilot[String(pilotId)];
  return id && traits[id] ? { id, ...traits[id] } : null;
}
