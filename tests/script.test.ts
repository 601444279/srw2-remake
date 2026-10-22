import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ScriptRunner, type ScriptHost } from "../src/remake/script.ts";

const stage1 = JSON.parse(readFileSync("data/events/stage01.json", "utf8"));

// 记录脚本调用的假游戏环境，只实现第一关用到的部分
function fakeHost(state: { turn: number; enemies: number; allies: number; units: Set<number> }) {
  const log: string[] = [];
  const host = new Proxy({} as ScriptHost, {
    get(_, name: string) {
      switch (name) {
        case "turn": return () => state.turn;
        case "enemyCount": return () => state.enemies;
        case "allyCount": return () => state.allies;
        case "exists": return (p: number) => state.units.has(p);
        case "hpAtLeast": return () => true;
        case "talk": return async (d: string) => { log.push(`talk ${d}`); };
        case "narrate": return async (d: string) => { log.push(`narrate ${d}`); };
        case "spawn": return async (side: string, _x: number, _y: number, p: number) => { log.push(`spawn ${side} ${p}`); state.units.add(p); };
        case "deployAlly": return async (_x: number, _y: number, r: number) => { log.push(`deploy ${r}`); };
        case "stageClear": return async () => { log.push("clear"); };
        case "gameOver": return async () => { log.push("gameover"); };
        default: return () => {};
      }
    },
  });
  return { host, log };
}

test("开场脚本：第一次调用播第一段对话后暂停，第二次播第二段后停住", async () => {
  const { host, log } = fakeHost({ turn: 1, enemies: 13, allies: 6, units: new Set() });
  const r = new ScriptRunner(stage1.scripts.start, host);
  await r.resume();
  assert.deepEqual(log, ["talk res-38#0"]);
  await r.resume();
  assert.deepEqual(log, ["talk res-38#0", "talk res-38#1"]);
  await r.resume();
  assert.equal(log.length, 2);
});

test("敌方阶段脚本：第 11 回合才出现凯、莫尼、邓肯三个援军", async () => {
  const state = { turn: 1, enemies: 13, allies: 6, units: new Set<number>() };
  const { host, log } = fakeHost(state);
  const r = new ScriptRunner(stage1.scripts.enemyPhase, host);
  for (; state.turn <= 10; state.turn++) await r.resume();
  assert.equal(log.length, 0);
  await r.resume();
  assert.deepEqual(log.filter((l) => l.startsWith("spawn")), ["spawn enemy 22", "spawn enemy 79", "spawn enemy 80"]);
  assert.ok(log.includes("narrate res-37#49"));
  const n = log.length;
  state.turn++;
  await r.resume();
  assert.equal(log.length, n);
});

test("检查脚本：敌人全灭 → 卡姆入队出场 → 过关对话 → 过关；我方全灭 → 失败", async () => {
  const win = fakeHost({ turn: 3, enemies: 0, allies: 6, units: new Set() });
  await new ScriptRunner(stage1.scripts.check, win.host).resume();
  assert.deepEqual(win.log, ["deploy 6", "talk res-38#2", "clear"]);

  const lose = fakeHost({ turn: 3, enemies: 5, allies: 0, units: new Set() });
  await new ScriptRunner(stage1.scripts.check, lose.host).resume();
  assert.deepEqual(lose.log, ["gameover"]);

  const going = fakeHost({ turn: 3, enemies: 5, allies: 3, units: new Set() });
  const r = new ScriptRunner(stage1.scripts.check, going.host);
  await r.resume();
  await r.resume();
  assert.deepEqual(going.log, []);
});
