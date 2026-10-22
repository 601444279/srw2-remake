// 战斗规则：命中率、伤害、反击武器选择、再攻击。还原自 bank 4 $87A1–$8CC5（战前预测）
// 和 bank 6 $8B23 起（出手结算）。地址、验证见 docs/notes-rules.md。
//
// 单位对象字段（都是原版 RAM 里的值）：
//   index      单位编号：0–10 我方（精神标志只对这些有效），14–31 敌方
//   side       阵营位（$7757 的高两位：我方 $80，敌方 $40），同阵营不能互相攻击
//   moveType   0 空 / 1 陆 / 2 海（$77D7 低两位）
//   strength 强度  defense 防卫  speed 速度  hp 当前 HP  maxHp
//   spirit     精神标志（$7817）：见 spirits.js 的 FLAG
//   ability    机体特殊能力（$77F7）：低 3 位 1 = 伤害减防卫一半，2 = 25% 机率伤害减半；最高位 = 不受远距离攻击
// 武器对象（ROM 武器表，6 字节）：
//   rangeByte  第 0 字节：低 4 位 = 射程 - 1；高 4 位 = 类型（F 修理，E 移动后可用的远程，1 命中后 50% 定身，2 吸收）
//   hit        命中
//   curve      距离衰减曲线（第 2 字节低 4 位）
//   power      [空, 陆, 海] 火力（菜单里显示的是火力 + 强度；0 表示打不到）
// 地形：terrainEffect 为守方所在格的环境地形效果原始值（$750F 表，低 7 位 = 命中百分比，最高位 = 算作海）

export const FLAG_LETHAL = 0x80; // 预测这一击能击破（且命中率 > 0）
export const FLAG_VALID = 0x40; // 能攻击
export const FLAG_ATTACK = 0x20; // 普通攻击（修理为 $A0/$20）

// 距离命中衰减表（bank 5 $B707），下标 [曲线][距离 - 1]，百分比
export const DISTANCE_CURVES = [
  [100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100],
  [100, 100, 95, 90, 85, 80, 75, 70, 65, 60, 55, 50, 45, 40, 35, 30],
  [100, 100, 95, 90, 80, 70, 60, 50, 40, 40, 30, 30, 20, 20, 10, 10],
];

const PLAYER_SPIRIT_LIMIT = 0x0b; // 0–10 号单位才看精神标志
const ENEMY_FIRST = 0x0e;

// 原版的百分比乘法：16 位 × 8 位 → 除以 100 取整；100 时直接跳过
const pct = (v, p) => (p === 100 ? v : Math.floor((v * p) / 100));

export function distance(a, b) {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

// 射程判定。moved：攻方本回合移动过（$E3 bit7）。反击时原版仍然看攻方是否移动过（见文档「反击」）
export function inRange(weapon, dist, moved) {
  const extra = weapon.rangeByte & 0x0f;
  const kind = weapon.rangeByte & 0xf0;
  if (extra !== 0) {
    if (kind !== 0xe0 && moved) return false; // 远程武器移动后不能用（E 类除外）
    if (dist === 1) return false; // 远程武器打不到相邻
  }
  return extra + 1 >= dist;
}

// 选火力：守方是空中单位用空中火力；否则看守方所在地形，海用海火力，其余用陆地火力
export function pickPower(weapon, target, terrainEffect) {
  if (target.moveType === 0) return weapon.power[0];
  return terrainEffect & 0x80 ? weapon.power[2] : weapon.power[1];
}

// 伤害 = 火力 + 攻方强度 - 守方防卫（最低 0），再按精神修正
export function damageOf(power, atk, def) {
  let d = Math.max(0, power + atk.strength - def.defense);
  if (atk.index < PLAYER_SPIRIT_LIMIT) {
    if (atk.spirit & 0x04) d *= 3; // 热血
    else if (atk.spirit & 0x08) d *= 2; // 强攻
  }
  if (def.index < PLAYER_SPIRIT_LIMIT && def.spirit & 0x10) d = Math.floor(d / 2); // 防守
  return d;
}

// 命中率 = 武器命中 + 攻方速度 - 守方速度（负数为 0）→ × 地形% → × 距离% → 上限 100 → 精神等修正
export function hitOf(weapon, atk, def, { dist, terrainEffect, jamming = false }) {
  let h = weapon.hit + atk.speed - def.speed;
  if (h < 0) return 0;
  if (def.moveType !== 0) h = pct(h, terrainEffect & 0x7f);
  h = pct(h, DISTANCE_CURVES[weapon.curve & 0x0f]?.[dist - 1] ?? 100);
  h = Math.min(h, 100);
  if (atk.index < PLAYER_SPIRIT_LIMIT) {
    if (atk.spirit & 0x02) h = 100; // 必杀
    else if (atk.spirit & 0x20) h = Math.min(h + 10, 100); // 瞄准
  }
  if (atk.index >= ENEMY_FIRST && jamming) h >>= 1; // 干扰：$750D bit6，敌方命中减半
  if (def.index < PLAYER_SPIRIT_LIMIT && def.spirit & 0x01) h = 0; // 回避
  return h;
}

// 一次攻击的预测（原版 $88CD / 反击 $8AE6），返回 { flags, hit, damage, heal }
// opts: dist, moved（攻方移动过）, terrainEffect（守方脚下）, jamming
export function evaluateAttack(weapon, atk, def, opts) {
  const none = { flags: 0, hit: 0, damage: 0 };
  if (!weapon) return none;
  if (!inRange(weapon, opts.dist, opts.moved)) return none;
  if (weapon.rangeByte >= 0xf0) return evaluateRepair(atk, def);
  if (atk.side & def.side & 0xc0) return none;
  const power = pickPower(weapon, def, opts.terrainEffect);
  if (power === 0) return none;
  const damage = damageOf(power, atk, def);
  const hit = hitOf(weapon, atk, def, opts);
  let flags = FLAG_VALID | FLAG_ATTACK;
  if (hit > 0 && def.hp < damage) flags |= FLAG_LETHAL;
  return { flags, hit, damage };
}

// 修理武器（rangeByte >= $F0）：只能对同阵营、未满血的单位；回复量 = min(缺的 HP, 修理者最大 HP / 2)
function evaluateRepair(atk, def) {
  if (!(atk.side & def.side & 0xc0)) return { flags: 0, hit: 0, damage: 0 };
  const missing = def.maxHp - def.hp;
  if (missing === 0) return { flags: 0, hit: 0, damage: 0 };
  const half = atk.maxHp >> 1;
  return missing < half
    ? { flags: 0xa0, hit: 100, damage: 0, heal: missing }
    : { flags: 0x20, hit: 100, damage: 0, heal: half };
}

// 反击武器选择（$8881）：两把武器都算一遍，
// 能击破的优先；都能击破选命中高的；都不能击破选伤害高的；相同时用第一把
export function chooseCounter(first, second) {
  if (!second || !(second.flags & FLAG_ATTACK)) return { ...first, slot: 0 };
  if (!(first.flags & FLAG_ATTACK)) return { ...second, slot: 1 };
  if (second.flags > first.flags) return { ...second, slot: 1 };
  if (second.flags < first.flags) return { ...first, slot: 0 };
  if (first.flags & FLAG_LETHAL) return second.hit > first.hit ? { ...second, slot: 1 } : { ...first, slot: 0 };
  return second.damage > first.damage ? { ...second, slot: 1 } : { ...first, slot: 0 };
}

// 战前预测：攻方用指定武器；守方自动选反击武器。攻方必定击破（能击破且命中 100）时不算反击
// weapons: 守方的两把武器
export function previewBattle({ weapon, atk, def, defWeapons, dist, moved, defTerrain, atkTerrain, jamming = false }) {
  const attack = evaluateAttack(weapon, atk, def, { dist, moved, terrainEffect: defTerrain, jamming });
  let counter = { flags: 0, hit: 0, damage: 0, slot: -1 };
  if (attack.flags & FLAG_VALID && !(attack.flags & FLAG_LETHAL && attack.hit === 100)) {
    const opts = { dist, moved, terrainEffect: atkTerrain, jamming };
    const r = defWeapons.map((w) => (w && w.rangeByte < 0xf0 ? evaluateAttack(w, def, atk, opts) : { flags: 0, hit: 0, damage: 0 }));
    counter = chooseCounter(r[0], r[1]);
  }
  return { attack, counter };
}

// 再攻击（bank 6 $8467）：速度差 >= 50 的一方在反击之后再打一次；被定身（状态位 $08）的不行
export function extraAttacker(atk, def, { atkStunned = false, defStunned = false, counterValid = true } = {}) {
  if (atk.speed - def.speed >= 50 && !atkStunned) return "attacker";
  if (def.speed - atk.speed >= 50 && counterValid && !defStunned) return "defender";
  return null;
}

// 一次出手的结算（bank 6 $8B23）。rand(n) 由调用方提供（原版随机数见 rng.js）。
// 顺序：特殊能力 → 命中判定 rand(100) < 命中率 → 定身判定 → 扣 HP（最低 0）
export function resolveStrike({ damage, hit, weaponKind = 0 }, def, { dist, rand }) {
  let dmg = damage;
  const ab = def.ability ?? 0;
  if (ab & 0x80 && dist !== 1) return { hit: false, damage: 0, nullified: true };
  if ((ab & 0x07) === 1) dmg = Math.max(0, dmg - (def.defense >> 1));
  else if ((ab & 0x07) === 2 && rand(100) < 25) dmg >>= 1;
  if (!(rand(100) < hit)) return { hit: false, damage: 0 };
  let stun = false;
  if ((weaponKind & 0xf0) === 0x10 && rand(100) < 50) stun = true;
  return { hit: true, damage: dmg, stun, hpAfter: Math.max(0, def.hp - dmg) };
}
