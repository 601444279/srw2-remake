import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { reachable, pathTo, rangeFrom, key, type GridMap } from "../src/remake/grid.ts";

// 3x3 小地图：0 号地形不可进入，1 号消耗 1，2 号消耗 2
const COST = [[0, 1, 2]];
const tiny = (terrain: number[][]): GridMap => ({ width: terrain[0].length, height: terrain.length, terrain, moveCost: [COST[0], COST[0], COST[0]] });

test("平地上移动 2 格，范围是菱形", () => {
  const map = tiny([[1, 1, 1, 1, 1], [1, 1, 1, 1, 1], [1, 1, 1, 1, 1], [1, 1, 1, 1, 1], [1, 1, 1, 1, 1]]);
  const r = reachable(map, { x: 2, y: 2 }, 2, "land", "player", []);
  assert.equal(r.cost.size, 13);
});

test("地形消耗和不可进入的格子", () => {
  const map = tiny([[1, 2, 1], [0, 0, 1], [1, 1, 1]]);
  const r = reachable(map, { x: 0, y: 0 }, 3, "land", "player", []);
  assert.equal(r.cost.get(key(map, 1, 0)), 2);
  assert.equal(r.cost.get(key(map, 2, 0)), 3);
  assert.ok(!r.cost.has(key(map, 0, 1)));
});

test("能穿过友军但不能停留，不能穿过敌军", () => {
  const map = tiny([[1, 1, 1, 1]]);
  const friend = reachable(map, { x: 0, y: 0 }, 3, "land", "player", [{ x: 1, y: 0, side: "player" }]);
  assert.ok(friend.cost.has(key(map, 2, 0)));
  assert.ok(!friend.stops.has(key(map, 1, 0)));
  const enemy = reachable(map, { x: 0, y: 0 }, 3, "land", "player", [{ x: 1, y: 0, side: "enemy" }]);
  assert.ok(!enemy.cost.has(key(map, 2, 0)));
});

test("路径从起点到终点，长度符合", () => {
  const map = tiny([[1, 1, 1], [1, 0, 1], [1, 1, 1]]);
  const r = reachable(map, { x: 0, y: 0 }, 4, "land", "player", []);
  const p = pathTo(map, r, { x: 2, y: 2 });
  assert.deepEqual(p[0], { x: 0, y: 0 });
  assert.deepEqual(p.at(-1), { x: 2, y: 2 });
  assert.equal(p.length, 5);
});

test("射程 1–2", () => {
  const map = tiny([[1, 1, 1, 1, 1]]);
  const cells = rangeFrom(map, [key(map, 2, 0)], 1, 2);
  assert.deepEqual([...cells].sort(), [0, 1, 3, 4]);
});

test("第一关真实地图：太勒（空中，机动 6）能到达的格子数", () => {
  const stage = JSON.parse(readFileSync("data/maps/stage01.json", "utf8"));
  const env = JSON.parse(readFileSync("data/environments.json", "utf8"))[stage.environment];
  const map: GridMap = { width: stage.width, height: stage.height, terrain: stage.terrain, moveCost: env.moveCostRaw };
  const r = reachable(map, { x: 14, y: 18 }, 6, "air", "player", []);
  // 空中单位每格消耗 1，只被地图边界限制
  for (const [k, c] of r.cost) {
    const x = k % map.width, y = Math.floor(k / map.width);
    assert.equal(c, Math.abs(x - 14) + Math.abs(y - 18));
  }
  assert.ok(r.cost.size > 20);
});
