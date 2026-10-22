// 从提取结果里挑出游戏运行时要用的战斗画面数据（完整数据有 1.4MB，大部分是给核对和重绘用的）。
//
// 用法: node tools/slim-battle-data.js
// 输入: data/battle-sprites.json、data/battle-effects.json（tools/extract-battle-gfx.js）
// 输出: data/battle-scene.json
//   units[id]   = { file, side, screen, origin, w, h }（file 已经跟过 sameAs）
//   weapons[id] = { right: { 机体编号: 动画名 }, left: … }
//   anims[name] = { file, layout, anchor, camera, cels, keyframes: [start, duration, cel?, x?, y?, camX?, camY?], sounds: [帧, 音效号] }
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, f), "utf8"));
const sprites = read("data/battle-sprites.json");
const effects = read("data/battle-effects.json");

const byId = new Map(sprites.units.map((u) => [u.id, u]));
const units = {};
for (const u of sprites.units) {
  let src = u;
  for (let i = 0; i < 4 && src && !src.file && src.sameAs != null; i++) src = byId.get(src.sameAs);
  if (!src?.file || !u.side) continue;
  units[u.id] = { file: path.basename(src.file), side: u.side, screen: u.screen, origin: u.origin, w: src.width, h: src.height };
}

const weapons = {};
for (const w of effects.weapons) {
  const out = {};
  for (const side of ["right", "left"]) {
    const rec = w[side]?.recorded ?? [];
    if (rec.length) out[side] = Object.fromEntries(rec.map((r) => [r.unit, r.anim]));
  }
  if (Object.keys(out).length) weapons[w.id] = out;
}

const slim = (a) => ({
  file: path.basename(a.effectFile),
  layout: a.layout,
  anchor: a.anchor,
  camera: a.camera,
  cels: a.cels.map((c) => [c.x, c.y, c.w, c.h]),
  keyframes: a.keyframes.map((k) => {
    const row = [k.start, k.duration];
    if (k.cel !== undefined || k.camera) row.push(k.cel ?? -1, k.x ?? 0, k.y ?? 0);
    if (k.camera) row.push(k.camera.x, k.camera.y);
    return row;
  }),
  // 原版音效触发的帧（同一帧同一音效只留一个）
  sounds: (a.sounds ?? []).filter(([f, id], i, all) => !all.slice(0, i).some(([g, j]) => g === f && j === id)),
});
const anims = Object.fromEntries(Object.entries(effects.anims).filter(([, a]) => a.effectFile).map(([n, a]) => [n, slim(a)]));
const explosions = Object.fromEntries(Object.entries(effects.explosions).map(([n, a]) => [n, slim(a)]));

// 地图菜单「变形」的原版演出（--transform 提取）：pairs["从>到"] = 合体 { film, at } 或两段 { from, to }（世界坐标）
const tf = effects.transform;
const transform = tf && {
  films: Object.fromEntries(Object.entries(tf.combine.films).map(([n, f]) => [n, { file: path.basename(f.file), w: f.frameSize.w, h: f.frameSize.h, columns: f.columns, frames: f.frames }])),
  fadeSteps: tf.combine.timing.fadeSteps,
  swapCamera: tf.swapCameras[0],
  swapEnd: tf.pairs.find((p) => p.kind === "swap")?.animEnd,
  music: Object.fromEntries(["combine", "swap"].map((k) => [k, tf.pairs.find((p) => p.kind === k)?.music])),
  pairs: Object.fromEntries(tf.pairs.filter((p) => !p.error).map((p) => [`${p.from}>${p.to}`, p.kind === "combine"
    ? { kind: "combine", film: p.film, at: [p.reveal.x, p.reveal.y] }
    : { kind: "swap", from: [p.fromAt.x, p.fromAt.y], to: [p.toAt.x, p.toAt.y] }])),
};

const out = {
  note: "战斗画面运行时数据，由 tools/slim-battle-data.js 从 battle-sprites.json / battle-effects.json 生成。keyframes 每项：开始帧、帧数、cel（-1 = 没有）、cel 相对锚点的 x、y、镜头偏移 x、y",
  units,
  weapons,
  anims,
  explosions,
  transform,
};
fs.writeFileSync(path.join(ROOT, "data/battle-scene.json"), JSON.stringify(out) + "\n");
console.log(`机体 ${Object.keys(units).length}，武器 ${Object.keys(weapons).length}，动画 ${Object.keys(anims).length}，${fs.statSync(path.join(ROOT, "data/battle-scene.json")).size} 字节`);
