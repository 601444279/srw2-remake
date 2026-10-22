import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { computeStats } from "../src/remake/stats.ts";

const db = JSON.parse(readFileSync("data/units.json", "utf8"));
const units = new Map(db.units.map((u: { id: number }) => [u.id, u]));
const pilots = new Map(db.pilots.map((p: { id: number }) => [p.id, p]));
// 原版运行时单位表的快照（tools/snapshot-stage.js），参数 A = 驾驶员，B = 机体，C = 等级
const snapshot = JSON.parse(readFileSync("data/snapshots/stage01.json", "utf8"));

test("第一关 19 台单位的数值和原版运行时一致", () => {
  for (const s of snapshot.units) {
    const unit = units.get(s.raw.paramB) as never;
    const pilot = pilots.get(s.raw.paramA) as never;
    const st = computeStats(unit, pilot, s.raw.paramC, db.growthCurves);
    const label = `${s.side} 槽 ${s.slot}`;
    assert.equal(st.move, s.move, `${label} 机动`);
    assert.equal(st.speed, s.speed, `${label} 速度`);
    assert.equal(st.strength, s.strength, `${label} 强度`);
    assert.equal(st.defense, s.defense, `${label} 防卫`);
    assert.equal(st.maxHp, s.maxHp, `${label} HP`);
  }
});
