// 敌方 AI。还原自 bank 24 $90DE（行动顺序）、bank 26 的 AI 脚本解释器（$8192 起，脚本在 bank 27）、
// 固定 bank $CE18（攻击评分）、$CEF5（移动后攻击的候选格）、$CC83 / $CCD0（向目标移动）。
//
// 每个敌人有一个 AI 脚本（部署数据的参数 c，即 $7777；脚本表在 bank 27 $AF83），
// 第一关用到的脚本：
//   $0A / $0B  主动型：能打就打（含移动后攻击），打不到就向最近的我方单位移动
//   $05        待机型：第 8 回合前不移动，只打原地够得着的目标；第 8 回合起变成主动型
//   $0C        待机型：同上，第 12 回合起变成主动型
// 主动型 $0A 和 $0B 的差别只在攻击评分模式（$0A 用 3，$0B 用 5）。
import { distanceGrid, BLOCKED, CAPPED } from "./move.js";
import { FLAG_LETHAL, FLAG_VALID, FLAG_ATTACK } from "./battle.js";

// 行动顺序：每个敌人用「空中」移动消耗（不被单位阻挡、不跨回合）算到全图的距离，
// 取到最近我方单位的距离；按这个距离从小到大行动（相同时编号小的先），够不着（>= 253）的这回合不动。
// 最多 18 个。
export function enemyOrder({ terrain, airCosts, enemies, players }) {
  const dist = enemies.map((e) => {
    const g = distanceGrid({ terrain, costs: airCosts, start: e, mobility: 0xfc });
    let min = 0xff;
    for (const p of players) min = Math.min(min, g[p.y][p.x]);
    return { index: e.index, dist: min };
  });
  return dist
    .filter((d) => d.dist < CAPPED)
    .sort((a, b) => a.dist - b.dist || a.index - b.index)
    .slice(0, 18)
    .map((d) => d.index);
}

// 攻击评分（$CE18）。preview 为 battle.previewBattle 的结果
// mode bit1：伤害按命中率折算（伤害 × 命中 / 100）；bit0：分数 = 给出的伤害 - 受到的反击伤害
export function scoreAttack(preview, mode) {
  let dealt = preview.attack.damage, taken = preview.counter.damage;
  if (mode & 2) {
    if (preview.attack.hit !== 100) dealt = Math.floor((dealt * preview.attack.hit) / 100);
    if (preview.counter.hit !== 100) taken = Math.floor((taken * preview.counter.hit) / 100);
  }
  // 原版把差值加上 $8000 再做无符号比较，等价于有符号比较
  const score = mode & 1 ? dealt - taken : dealt;
  return { flags: preview.attack.flags, hit: preview.attack.hit, score };
}

// 新候选是否取代当前最佳：标志大的优先（能击破 $E0 > 普通 $60）；
// 都能击破比命中率，否则比分数；必须严格更好才取代（先评估的占优）
export function isBetter(cand, best) {
  if (!(cand.flags & FLAG_ATTACK)) return false;
  if (!best) return true;
  if (cand.flags !== best.flags) return cand.flags > best.flags;
  if (!(cand.flags & FLAG_VALID)) return false;
  if (cand.flags & FLAG_LETHAL) return cand.hit > best.hit;
  return cand.score > best.score;
}

// 移动后攻击的候选格（$CEF5）：只考虑目标上、下、左、右四格，
// 要求本回合走得到（距离 <= 机动）且没有单位。远程武器也只从相邻格打。
export function adjacentSpots(target, grid, mobility, occupied) {
  const h = grid.length, w = grid[0].length;
  const out = [];
  for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
    const x = target.x + dx, y = target.y + dy;
    if (x < 0 || y < 0 || x >= w || y >= h) continue;
    if (grid[y][x] > mobility || occupied.has(`${x},${y}`)) continue;
    out.push({ x, y });
  }
  return out;
}

// 选攻击（脚本指令 $1A，$885A）。evaluate(weapon, target, pos, moved) 返回 previewBattle 结果。
// 顺序：先不移动，武器 1 → 武器 2，目标按编号；
// 不移动打不到（或模式 bit2）且本回合还没移动、没有「不移动」标志时，再评估移动到目标四邻格攻击。
export function chooseAttack({ unit, weapons, targets, mode, canMove, grid, mobility, occupied, evaluate }) {
  let best = null;
  const consider = (weapon, slot, target, pos, moved) => {
    const s = scoreAttack(evaluate(weapon, target, pos, moved), mode);
    if (isBetter(s, best)) best = { ...s, weapon: slot, target: target.index, x: pos.x, y: pos.y };
  };
  weapons.forEach((w, slot) => { if (w) for (const t of targets) consider(w, slot, t, unit, false); });
  if (best && !(mode & 4)) return best;
  if (!canMove) return best;
  weapons.forEach((w, slot) => {
    if (!w) return;
    for (const t of targets) for (const p of adjacentSpots(t, grid, mobility, occupied)) consider(w, slot, t, p, !(p.x === unit.x && p.y === unit.y));
  });
  return best;
}

// 向目标移动（脚本指令 $14，$8672 + $CC83 + $CCD0）：
// 1. 用本单位的移动消耗（敌对单位阻挡）算距离图，在所有我方单位的上下左右空格里找距离最小的格作为目标点
// 2. 以目标点为起点再算一张距离图；在本回合能停的格里，选到目标点距离最小的；有多个时 rand(个数) 选一个
// grid: 从本单位出发的距离图；gridFromGoal: 从目标点出发的距离图；rand: 原版随机数
export function moveGoal(targets, grid, occupied) {
  let best = 0xff, goal = null;
  for (const t of targets) {
    const h = grid.length, w = grid[0].length;
    for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
      const x = t.x + dx, y = t.y + dy;
      if (x < 0 || y < 0 || x >= w || y >= h || occupied.has(`${x},${y}`)) continue;
      if (grid[y][x] < best) { best = grid[y][x]; goal = { x, y }; }
    }
  }
  return goal;
}

export function moveStep({ grid, gridFromGoal, mobility, occupied, self, rand }) {
  let best = 0xff;
  let list = [];
  for (let y = 0; y < grid.length; y++) {
    for (let x = 0; x < grid[0].length; x++) {
      const key = `${x},${y}`;
      if (grid[y][x] > mobility || grid[y][x] === BLOCKED) continue;
      if (occupied.has(key) && !(x === self.x && y === self.y)) continue;
      const d = gridFromGoal[y][x];
      if (d > best) continue;
      if (d < best) { best = d; list = []; }
      list.push({ x, y });
    }
  }
  if (!list.length) return { x: self.x, y: self.y };
  return list[rand(list.length)];
}
