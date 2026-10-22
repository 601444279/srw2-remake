// 战斗台词：按原版规则从驾驶员的台词表里选（data/shouts.json，tools/extract-shouts.js）。
// 同一段台词里有多句时随机选一句；只用于演出，不消耗游戏的随机数。
import shoutDb from "../../data/shouts.json";

const scriptFiles = import.meta.glob("../../data/script/res-3[0-7].json", { eager: true, import: "default" });

export type ShoutCase = "miss" | "noDamage" | "light" | "medium" | "heavy" | "destroyed" | "stunned" | "cannotCounter";
export type ShoutAttack = "attack" | "counter" | "extra";

interface Table extends Record<ShoutCase, string> {
  attack: { from: number; to: number; line: string }[];
  counter: { from: number; to: number; line: string }[];
  extra: { from: number; to: number; line: string }[];
}

const tables = (shoutDb as unknown as { pilots: Record<string, Table> }).pilots;

interface Node { text?: string; random?: { text?: string }[][] }

// "res-30#79" → 这一段里所有可选的句子
function choices(ref: string): string[] {
  const [, res, index] = ref.match(/^res-([0-9A-F]+)#(\d+)$/i) ?? [];
  const file = Object.entries(scriptFiles).find(([p]) => p.endsWith(`res-${res}.json`));
  const entry = (file?.[1] as { entries: { index: number; nodes: Node[] }[] } | undefined)?.entries.find((e) => e.index === Number(index));
  const out: string[] = [];
  for (const n of entry?.nodes ?? []) {
    if (n.random) for (const v of n.random) out.push(v.map((x) => x.text ?? "").join(""));
    else if (n.text) out.push(n.text);
  }
  return out.map((t) => t.replace(/\n/g, " ").replace(/‥/g, "…").trim()).filter(Boolean);
}

const pick = (list: string[]) => (list.length ? list[Math.floor(Math.random() * list.length)] : null);

// 攻击、反击、再攻击：按武器编号所在区间选
export function attackShout(pilotId: number, kind: ShoutAttack, weaponId: number): string | null {
  const t = tables[String(pilotId)];
  const hit = t?.[kind].find((e) => weaponId >= e.from && weaponId <= e.to);
  return hit ? pick(choices(hit.line)) : null;
}

export function reactionShout(pilotId: number, c: ShoutCase): string | null {
  const t = tables[String(pilotId)];
  return t ? pick(choices(t[c])) : null;
}

// 挨打的反应按伤害占最大 HP 的比例分档（原版 bank 6 $8D15）
export function damageCase(hit: boolean, damage: number, hpAfter: number, maxHp: number): ShoutCase {
  if (hpAfter <= 0) return "destroyed";
  if (!hit) return "miss";
  if (damage === 0) return "noDamage";
  const pct = Math.floor((damage * 100) / maxHp);
  return pct < 11 ? "light" : pct < 36 ? "medium" : "heavy";
}
