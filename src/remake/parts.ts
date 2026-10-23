// 强化零件（原版地图商店卖的道具，docs/notes-events.md「商店和工具」）。数据 data/parts.json（tools/extract-parts.js）。
// 原版：持有数全队共用一份（$741A + 零件号，上限 255），在系统菜单「工具」里给某个单位用。
// 能力类零件加到单位身上，同样的量记在名册的改造值上（RosterMember.parts），以后每关都带着
import partsDb from "../../data/parts.json";
import type { PartBonus, Unit } from "./data.ts";

export type PartEffect =
  | { kind: "stat"; stat: keyof PartBonus; amount: number; target: "pick" }
  | { kind: "sp" | "hp"; amount: number; target: "pick" }
  | { kind: "exp"; rand: number; target: "pick" }
  | { kind: "flag"; flag: number; blockedBy: number; target: "map" }
  | { kind: "jamming"; target: "none" }
  // 商店里不卖、拿不到的（喷气机翼、维修、愤怒、地雷等），重制版不实现
  | { kind: "flight" | "healAll" | "damage" | "none"; target: string };

export interface Part {
  id: number;
  name: string;
  price: number; // 原版资金单位，画面 ×10
  note: string;
  effect: PartEffect;
}

export interface Shop {
  shop: number;
  face: number;
  greeting: string; // 例如 "res-3F#48"：从这句起连续 7 条台词
  parts: number[];
}

export const PARTS = partsDb.parts as Part[];
export const SHOPS = partsDb.shops as (Shop | null)[];
export const MAX_ITEMS = 255;
export const emptyItems = () => PARTS.map(() => 0);

// 能力上限（原版 bank 10 $82FE 起：机动 15、强度 / 防卫 / 速度 255、最大 HP 9999）
export const STAT_CAP: Record<keyof PartBonus, number> = { move: 15, strength: 255, defense: 255, speed: 255, maxHp: 9999 };
export const STAT_LABEL: Record<keyof PartBonus, string> = { move: "机动", strength: "强度", defense: "防卫", speed: "速度", maxHp: "HP" };

// 部队表里这个零件看的那一栏（原版表头随零件变）
export function pickColumn(p: Part, u: Unit): string {
  const e = p.effect;
  if (e.kind === "stat") return e.stat === "maxHp" ? `HP ${u.hp}/${u.maxHp}` : `${STAT_LABEL[e.stat]} ${u[e.stat]}`;
  if (e.kind === "sp") return `SP ${u.sp}/${u.maxSp}`;
  if (e.kind === "hp") return `HP ${u.hp}/${u.maxHp}`;
  return `Lv ${u.level}`;
}

// 能不能给这个单位用（原版不满足时出一句话、不消耗）
export function usableOn(p: Part, u: Unit): boolean {
  const e = p.effect;
  if (e.kind === "stat") return u[e.stat] < STAT_CAP[e.stat];
  if (e.kind === "sp") return u.sp < u.maxSp;
  if (e.kind === "hp") return u.hp < u.maxHp;
  if (e.kind === "flag") return (u.spirit & e.blockedBy) === 0;
  return e.kind === "exp";
}

// 能力类零件：加到单位上（到上限为止），名册改造值加同样的量。返回实际加了多少
export function applyStat(u: Unit, stat: keyof PartBonus, amount: number): number {
  const add = Math.min(amount, STAT_CAP[stat] - u[stat]);
  if (add <= 0) return 0;
  u[stat] += add;
  const parts = (u.parts ??= { move: 0, strength: 0, defense: 0, speed: 0, maxHp: 0 });
  parts[stat] += add;
  return add;
}
