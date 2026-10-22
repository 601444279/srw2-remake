import { test } from "node:test";
import assert from "node:assert/strict";
import { scale2x, scale4x } from "../src/remake/upscale.ts";

test("单色图放大后还是单色，尺寸翻倍", () => {
  const out = scale2x(new Uint32Array(4).fill(7), 2, 2);
  assert.equal(out.length, 16);
  assert.ok(out.every((v) => v === 7));
});

test("阶梯边缘被补齐，不产生新颜色", () => {
  // 1 0
  // 1 1   右上那个 0 的左下角夹在两个 1 之间，放大后应该补成 1，让斜边变平滑
  const out = scale2x(new Uint32Array([1, 0, 1, 1]), 2, 2);
  assert.ok(out.every((v) => v === 0 || v === 1));
  assert.equal(out[1 * 4 + 2], 1);
  assert.equal(out[0 * 4 + 3], 0);
});

test("Scale4x 尺寸是 4 倍", () => {
  assert.equal(scale4x(new Uint32Array(16 * 16), 16, 16).length, 64 * 64);
});
