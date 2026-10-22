// 经验值、升级、资金。还原自 bank 6 $84BC（击破结算）、bank 4 $8CC6（加经验与升级）、
// bank 4 $81DA / $822F（按等级算能力值）。等级在 RAM 里从 0 开始，画面显示 +1。

// 累计经验门槛（bank 5 $B75F / $B7C3），第 L 项 = 从等级 L 升到 L+1 需要的累计经验（L 从 0 起）
export const EXP_TABLE_A = [
  30, 80, 170, 310, 600, 900, 1300, 1800, 2400, 3000, 3800, 4580, 5520, 6720, 7680, 8700, 9780, 10920, 12120, 13380,
  14700, 16080, 17520, 19020, 20580, 22200, 23880, 25680, 27480, 29340, 31140, 33120, 35160, 37260, 39480, 41700, 43980,
  46320, 48720, 51180, 53740, 54740, 55790, 56890, 58050, 59270, 60550, 61890, 63290, 65535,
];
export const EXP_TABLE_B = [
  40, 100, 360, 600, 900, 1260, 1680, 2220, 2820, 3480, 4200, 4980, 5820, 6720, 7680, 8700, 9780, 10920, 12120, 13380,
  14700, 16080, 17520, 19020, 20580, 22200, 23880, 25680, 27480, 29340, 31140, 33120, 35160, 37260, 39480, 41700, 43980,
  46320, 48720, 51180, 53740, 54740, 55790, 56890, 58050, 59270, 60550, 61890, 63290, 65535,
];
// 角色的成长类型（$74CC 低两位）→ 门槛表（bank 5 $B757 指针表：A B B A）
export const EXP_TABLE_BY_TYPE = [EXP_TABLE_A, EXP_TABLE_B, EXP_TABLE_B, EXP_TABLE_A];
export const MAX_LEVEL_INDEX = 0x31; // 显示等级 50

// 等级差系数（bank 6 $8627 / $8636），下标 = 敌等级 - 我等级 + 6，夹在 0–14
const EXP_MUL = [1, 1, 1, 1, 1, 1, 1, 3, 2, 5, 3, 7, 4, 9, 5];
const EXP_DIV = [12, 10, 8, 6, 4, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1];

// 击破一个敌人得到的经验。baseExp = 敌方机体基础经验（机体表第 10–11 字节）；等级都是从 0 起的内部值
// 只有击破才有经验；敌方击破我方没有经验
export function expForKill(baseExp, enemyLevel, playerLevel) {
  const d = enemyLevel + 6 - playerLevel;
  if (d < 0) return 1;
  const i = Math.min(d, 14);
  const v = Math.floor((((baseExp * (enemyLevel + 1)) & 0xffff) * EXP_MUL[i]) / EXP_DIV[i]) & 0xffff;
  return v === 0 ? 1 : v;
}

// 加经验（上限 65535）后的等级：只要累计经验 >= 当前等级的门槛就升一级，可以连升
export function levelForExp(exp, level, growthType) {
  const table = EXP_TABLE_BY_TYPE[growthType & 3];
  while (level !== MAX_LEVEL_INDEX && exp >= table[level]) level++;
  return level;
}

export function addExp(exp, gain) {
  return Math.min(exp + gain, 0xffff);
}

// 成长曲线（资源 $88）：每字节两个 4 位增量，高位在前。升到等级 L（内部值）累计加的值 = 前 L 个增量之和
export function curveBonus(curveBytes, level) {
  let sum = 0;
  for (let i = 0; i < level; i++) {
    const b = curveBytes[i >> 1];
    sum += i & 1 ? b & 0x0f : b >> 4;
  }
  return sum;
}

// 能力值只由「机体基础值 + 成长曲线」决定，升级不随机
// machine: { speed, strength, defense, hp, curves: { speed, strength, defense, hp } }（curves 为曲线字节数组）
// pilot:   { sp, spCurve }
export function statsAtLevel(machine, pilot, level) {
  const cap8 = (v) => Math.min(v, 255);
  return {
    speed: cap8(machine.speed + curveBonus(machine.curves.speed, level)),
    strength: cap8(machine.strength + curveBonus(machine.curves.strength, level)),
    defense: cap8(machine.defense + curveBonus(machine.curves.defense, level)),
    maxHp: Math.min(machine.hp + curveBonus(machine.curves.hp, level), 9999),
    maxSp: pilot ? cap8(pilot.sp + curveBonus(pilot.spCurve, level)) : 0,
  };
}

// 资金：击破敌人得到机体表第 7 字节，上限 9999（画面显示 ×10，即 99990G）
export function addMoney(money, reward) {
  return Math.min(money + reward, 9999);
}
