// 地图格子上的纯逻辑：移动范围、路径、攻击范围。不依赖浏览器，可以直接用 node 测试。

export type MoveType = "air" | "land" | "sea";
export const MOVE_TYPE_ROW: Record<MoveType, number> = { air: 0, land: 1, sea: 2 };

export interface Point {
  x: number;
  y: number;
}

export interface GridMap {
  width: number;
  height: number;
  terrain: number[][];
  // 每种移动类型对 16 种地形的消耗，0 表示不能进入
  moveCost: number[][];
}

export interface Occupant {
  x: number;
  y: number;
  side: "player" | "enemy";
}

export interface Reach {
  // key = y * width + x
  cost: Map<number, number>;
  parent: Map<number, number>;
  // 可以停留的格子（不含被其他单位占据的格子）
  stops: Set<number>;
}

export const key = (map: { width: number }, x: number, y: number) => y * map.width + x;
export const fromKey = (map: { width: number }, k: number): Point => ({ x: k % map.width, y: Math.floor(k / map.width) });
export const inBounds = (map: GridMap, x: number, y: number) => x >= 0 && y >= 0 && x < map.width && y < map.height;

const NEIGHBORS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

export function terrainCost(map: GridMap, moveType: MoveType, x: number, y: number): number {
  return map.moveCost[MOVE_TYPE_ROW[moveType]][map.terrain[y][x]];
}

// 移动范围：按地形消耗做最短路（Dijkstra）。可以穿过友军，不能穿过敌军；不能停在别人的格子上。
export function reachable(map: GridMap, from: Point, move: number, moveType: MoveType, side: Occupant["side"], occupants: Occupant[]): Reach {
  const occupied = new Map<number, Occupant["side"]>();
  for (const o of occupants) occupied.set(key(map, o.x, o.y), o.side);

  const start = key(map, from.x, from.y);
  const cost = new Map([[start, 0]]);
  const parent = new Map<number, number>();
  const queue: [number, number][] = [[0, start]];

  while (queue.length) {
    queue.sort((a, b) => a[0] - b[0]);
    const [c, k] = queue.shift()!;
    if (c > (cost.get(k) ?? Infinity)) continue;
    const { x, y } = fromKey(map, k);
    for (const [dx, dy] of NEIGHBORS) {
      const nx = x + dx, ny = y + dy;
      if (!inBounds(map, nx, ny)) continue;
      const step = terrainCost(map, moveType, nx, ny);
      if (step === 0) continue;
      const nk = key(map, nx, ny);
      const who = occupied.get(nk);
      if (who && who !== side) continue;
      const nc = c + step;
      if (nc > move || nc >= (cost.get(nk) ?? Infinity)) continue;
      cost.set(nk, nc);
      parent.set(nk, k);
      queue.push([nc, nk]);
    }
  }

  const stops = new Set<number>();
  for (const k of cost.keys()) if (k === start || !occupied.has(k)) stops.add(k);
  return { cost, parent, stops };
}

export function pathTo(map: GridMap, reach: Reach, target: Point): Point[] {
  let k = key(map, target.x, target.y);
  if (!reach.cost.has(k)) return [];
  const path = [fromKey(map, k)];
  while (reach.parent.has(k)) {
    k = reach.parent.get(k)!;
    path.unshift(fromKey(map, k));
  }
  return path;
}

// 从一组格子出发、曼哈顿距离 minRange..maxRange 的格子
export function rangeFrom(map: GridMap, cells: Iterable<number>, minRange: number, maxRange: number): Set<number> {
  const out = new Set<number>();
  for (const k of cells) {
    const { x, y } = fromKey(map, k);
    for (let dy = -maxRange; dy <= maxRange; dy++) {
      for (let dx = -maxRange; dx <= maxRange; dx++) {
        const d = Math.abs(dx) + Math.abs(dy);
        if (d < minRange || d > maxRange || !inBounds(map, x + dx, y + dy)) continue;
        out.add(key(map, x + dx, y + dy));
      }
    }
  }
  return out;
}
