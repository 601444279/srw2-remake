// 精神指令。还原自 bank 28 $9B10（菜单：可用条件、消耗表 $9C34）、bank 10 $86C1（使用：效果分发）、
// bank 29 $A7E4 / $A86F（回复量、伤害量）。名字取自外星汉化版的菜单。
//
// 驾驶员数据（资源 $84）第 2–4 字节是 24 位精神表，最高位对应编号 0。
// 菜单最多显示 6 个，按消耗从小到大排；精神点数不够或条件不满足的不显示。

// 状态标志（$7817，只有我方 0–10 号单位有），当回合有效，行动结束清零（$C0 两位除外，见文档）
export const FLAG = {
  ACCEL: 0x80, // 加速：机动 +3
  GALE: 0x40, // 疾风：机动 +5
  AIM: 0x20, // 瞄准：命中 +10
  GUARD: 0x10, // 防守：受到伤害减半
  POWER: 0x08, // 强攻：伤害 ×2
  HOT_BLOOD: 0x04, // 热血：伤害 ×3
  SURE_HIT: 0x02, // 必杀：命中 100
  EVADE: 0x01, // 回避：对方命中 0
};

// effect.kind：
//   flag    设状态标志
//   heal    回复 HP：target self / ally（选一个我方）/ allies（全体我方），amount 见 HEAL
//   damage  对全体敌人造成伤害，amount 见 DAMAGE
//   jamming 干扰：本回合敌方命中减半（全局 $750D bit6）
//   warp    传真：进入选格模式（地图所有空格都可选），细节未完全确认
// usable：菜单显示条件
export const SPIRITS = [
  { id: 0, name: "毅力", cost: 10, effect: { kind: "heal", target: "self", amount: "50" }, usable: "selfDamaged" },
  { id: 1, name: "加速", cost: 10, effect: { kind: "flag", flag: FLAG.ACCEL }, usable: "noMoveBuff" },
  { id: 2, name: "瞄准", cost: 10, effect: { kind: "flag", flag: FLAG.AIM }, usable: "noHitBuff" },
  { id: 3, name: "防守", cost: 20, effect: { kind: "flag", flag: FLAG.GUARD }, usable: "noGuard" },
  { id: 4, name: "强攻", cost: 40, effect: { kind: "flag", flag: FLAG.POWER }, usable: "noDamageBuff" },
  { id: 5, name: "友情", cost: 30, effect: { kind: "heal", target: "ally", amount: "50" }, usable: "allyDamaged" },
  { id: 6, name: "必杀", cost: 40, effect: { kind: "flag", flag: FLAG.SURE_HIT }, usable: "noHitBuff" },
  { id: 7, name: "疾风", cost: 50, effect: { kind: "flag", flag: FLAG.GALE }, usable: "noMoveBuff" },
  { id: 8, name: "回避", cost: 50, effect: { kind: "flag", flag: FLAG.EVADE }, usable: "noEvade" },
  { id: 9, name: "潜力", cost: 60, effect: { kind: "heal", target: "self", amount: "full" }, usable: "selfDamaged" },
  { id: 10, name: "热血", cost: 80, effect: { kind: "flag", flag: FLAG.HOT_BLOOD }, usable: "noDamageBuff" },
  { id: 11, name: "情义", cost: 70, effect: { kind: "heal", target: "ally", amount: "full" }, usable: "allyDamaged" },
  { id: 12, name: "传真", cost: 150, effect: { kind: "warp" }, usable: "always" },
  { id: 13, name: "援助", cost: 80, effect: { kind: "heal", target: "allies", amount: "50" }, usable: "anyDamaged" },
  { id: 14, name: "怒", cost: 100, effect: { kind: "damage", amount: "10-100" }, usable: "enemyExists" },
  { id: 15, name: "祈祷", cost: 100, effect: { kind: "heal", target: "allies", amount: "100" }, usable: "anyDamaged" },
  { id: 16, name: "干扰", cost: 100, effect: { kind: "jamming" }, usable: "enemyExists" },
  { id: 17, name: "狂怒", cost: 150, effect: { kind: "damage", amount: "10-255" }, usable: "enemyExists" },
  { id: 18, name: "爱心", cost: 150, effect: { kind: "heal", target: "allies", amount: "full" }, usable: "anyDamaged" },
];

// 菜单显示条件（$9B38 跳转表）。unit 是使用者，units 是全场单位
export const USABLE = {
  always: () => true,
  selfDamaged: (u) => u.hp !== u.maxHp,
  noMoveBuff: (u) => (u.spirit & 0xc0) === 0,
  noHitBuff: (u) => (u.spirit & 0x22) === 0,
  noGuard: (u) => (u.spirit & 0x10) === 0,
  noDamageBuff: (u) => (u.spirit & 0x0c) === 0,
  noEvade: (u) => (u.spirit & 0x01) === 0,
  // 友情、情义：0–10 号里有出场（$77D7 bit7 为 0）且没满血的
  allyDamaged: (u, units) => units.some((o) => o.index < 11 && o.alive && !o.hidden && o.hp !== o.maxHp),
  // 援助、祈祷、爱心：0–10 号里有没满血的（不看 bit7）
  anyDamaged: (u, units) => units.some((o) => o.index < 11 && o.alive && o.hp !== o.maxHp),
  enemyExists: (u, units) => units.some((o) => o.index >= 14 && o.alive),
};

// 回复量类型（bank 29 $A7F7，参数低 3 位）：0 = 50，1 = 100，2 = 50 + rand(151)，3 = 全满（9999），4 = 使用者最大 HP / 2
// 精神用到 50 / 100 / 全满；其余类型可能给道具或剧情用
export function healAmount(amount, unit, rand) {
  switch (amount) {
    case "50": return 50;
    case "100": return 100;
    case "50-200": return 50 + rand(151);
    case "full": return 9999;
    case "half": return unit.maxHp >> 1;
    default: throw new Error(`未知回复量 ${amount}`);
  }
}

export function applyHeal(unit, amount) {
  return Math.min(unit.hp + amount, unit.maxHp);
}

// 伤害量类型（bank 29 $A878，参数低 2 位）：0 = 10 + rand(91)，1 = 10 + rand(191)，2 = 10 + rand(246)，3 = 战斗预测伤害
// 每个敌人各掷一次；伤害不超过当前 HP（可以打到 0）
export function spiritDamage(amount, rand) {
  switch (amount) {
    case "10-100": return 10 + rand(91);
    case "10-200": return 10 + rand(191);
    case "10-255": return 10 + rand(246);
    default: throw new Error(`未知伤害量 ${amount}`);
  }
}

// 精神菜单：按 24 位表 + 当前精神点数 + 条件列出，最多 6 个，按消耗排序
export function spiritMenu(mask24, unit, units) {
  const list = [];
  for (let id = 0; id < 24 && list.length < 6; id++) {
    if (!(mask24 & (1 << (23 - id)))) continue;
    const s = SPIRITS[id];
    if (!s || unit.sp < s.cost) continue;
    if (!USABLE[s.usable](unit, units)) continue;
    list.push(s);
  }
  // 原版的排序（$9C47）：拿第 x 项和后面每一项比，后面的消耗更小就交换
  for (let x = 0; x < 5; x++) {
    for (let y = x; y < 5; y++) {
      if (!list[y + 1]) break;
      if (list[y + 1].cost < list[x].cost) [list[x], list[y + 1]] = [list[y + 1], list[x]];
    }
  }
  return list;
}
