// 移动范围：还原原版 bank 2 $8E28 起的逐层扩展算法（结果写在 SRAM $6800，每行 32 格）。
//
// 规则：
// - 每格值 = 从起点走到这里的累计消耗；起点 0
// - 进入一格的消耗 = 该格地形在本单位类型（空 / 陆 / 海）下的移动消耗，0 表示不能进入
// - 「跨回合」：进入后累计值超过当前门槛（初始为机动力，扩展层数超过门槛时门槛再加一个机动力）时，
//   这一格的值改为「门槛 + 该格消耗」，即上一回合剩下的移动力作废，下一回合从头走进这一格
// - 敌对单位所在格不能进入（值 FF）；友军格可以穿过，但不能停
// - 值达到 253 以上记为 253（FD），没有到达的格是 254（FE），不能进入的格是 255（FF）
// - 扩展顺序：上、下、右、左；同一格只在第一次被发现时赋值（按层从小到大处理，所以就是最小值）
export const UNREACHED = 0xfe;
export const BLOCKED = 0xff;
export const CAPPED = 0xfd;

// terrain: 二维数组 [y][x] 地形编号；costs: 16 项移动消耗；blocked: Set("x,y") 敌对单位位置
// mobility: 机动力（门槛）；传 252 以上相当于不加倍（原版算敌方行动顺序时用 $FC）
export function distanceGrid({ terrain, costs, start, mobility, blocked = new Set() }) {
  const h = terrain.length, w = terrain[0].length;
  const grid = terrain.map((row) => row.map(() => UNREACHED));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (costs[terrain[y][x]] === 0) grid[y][x] = BLOCKED;
  for (const key of blocked) { const [x, y] = key.split(",").map(Number); grid[y][x] = BLOCKED; }
  grid[start.y][start.x] = 0;
  let level = 0, threshold = mobility;
  let frontier = [[start.x, start.y]];
  const relax = (nx, ny) => {
    if (grid[ny][nx] !== UNREACHED) return false;
    const c = costs[terrain[ny][nx]];
    let v = c + level;
    if (v >= CAPPED) { grid[ny][nx] = CAPPED; return true; }
    if (v > threshold) v = threshold + c;
    grid[ny][nx] = v >= CAPPED ? CAPPED : v;
    return true;
  };
  while (frontier.length) {
    const pending = [];
    // 只扩展值等于当前层的格子，其余留到后面的层
    for (let i = 0; i < frontier.length; i++) {
      const [x, y] = frontier[i];
      if (grid[y][x] !== level) { pending.push([x, y]); continue; }
      const found = [];
      if (y > 0 && relax(x, y - 1)) found.push([x, y - 1]);
      if (y < h - 1 && relax(x, y + 1)) found.push([x, y + 1]);
      if (x < w - 1 && relax(x + 1, y)) found.push([x + 1, y]);
      if (x > 0 && relax(x - 1, y)) found.push([x - 1, y]);
      pending.push(...found);
    }
    level++;
    if (level > threshold) threshold += mobility;
    frontier = pending;
    if (level >= CAPPED) break;
  }
  // 值封顶的格子最后也会被扩展（原版层数一路加到 $FD），相连的可进入格都记为 FD
  const stack = frontier.filter(([x, y]) => grid[y][x] === CAPPED);
  while (stack.length) {
    const [x, y] = stack.pop();
    for (const [nx, ny] of [[x, y - 1], [x, y + 1], [x + 1, y], [x - 1, y]]) {
      if (nx < 0 || ny < 0 || nx >= w || ny >= h || grid[ny][nx] !== UNREACHED) continue;
      grid[ny][nx] = CAPPED;
      stack.push([nx, ny]);
    }
  }
  return grid;
}

// 本回合能停的格：累计消耗 <= 机动力，且没有其他单位
export function reachableTiles(grid, mobility, occupied = new Set(), self = null) {
  const out = [];
  grid.forEach((row, y) => row.forEach((v, x) => {
    const key = `${x},${y}`;
    if (v <= mobility && (!occupied.has(key) || (self && self.x === x && self.y === y))) out.push({ x, y, cost: v });
  }));
  return out;
}

// 机动力：基础值 + 加速 3 + 疾风 5（精神标志只对我方 0–10 号单位有效）
export function mobilityOf(base, spiritFlags = 0) {
  let m = base;
  if (spiritFlags & 0x80) m += 3;
  if (spiritFlags & 0x40) m += 5;
  return m;
}
