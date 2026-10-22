// 从 ROM 提取对话头像（32×32，背景层 + 精灵层叠合）。
//
// 用法: node tools/extract-portraits.js [rom/srw2.nes]
// 输出:
//   assets/original/portraits/NN.png   人物编号 NN（十进制）的头像，原版像素尺寸，透明处没有
//   data/portraits.json                人物编号 → 文件、尺寸、图块来源、颜色
//   extracted/portraits/overview.png   总览图（不进仓库），每行 16 个，按编号排列，空号留黑
//
// 格式见 docs/notes-portraits.md。
import fs from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const PEOPLE = 112;

// 资源 0x85（头像），在 8KB bank 4，映射在 $8000：资源字节 0x22 → 一级指针表第 2 项 → 以人物编号为下标的指针表
const RES_TABLE = 0x9c78;
const RECORD_SIZE = 7;

// 对话框背景层固定用 0 号背景色板（黑、白、浅灰、深灰）
const BG_PALETTE = [0x0f, 0x30, 0x10, 0x00];

// jsnes 的 NTSC 调色板（0xBBGGRR），和 tools/extract-maps.js 相同
const NES_COLORS = [0x525252, 0xb40000, 0xa00000, 0xb1003d, 0x740069, 0x00005b, 0x00005f, 0x001840, 0x002f10, 0x084a08, 0x006700, 0x124200, 0x6d2800, 0x000000, 0x000000, 0x000000, 0xc4d5e7, 0xff4000, 0xdc0e22, 0xff476b, 0xd7009f, 0x680ad7, 0x0019bc, 0x0054b1, 0x006a5b, 0x008c03, 0x00ab00, 0x2c8800, 0xa47200, 0x000000, 0x000000, 0x000000, 0xf8f8f8, 0xffab3c, 0xff7981, 0xff5bc5, 0xff48f2, 0xdf49ff, 0x476dff, 0x00b4f7, 0x00e0ff, 0x00e375, 0x03f42b, 0x78b82e, 0xe5e218, 0x787878, 0x000000, 0x000000, 0xffffff, 0xfff2be, 0xf8b8b8, 0xf8b8d8, 0xffb6ff, 0xffc3ff, 0xc7d1ff, 0x9adaff, 0x88edf8, 0x83ffdd, 0xb8f8b8, 0xf5f8ac, 0xffffb0, 0xf8d8f8, 0x000000, 0x000000];
const rgb = (nesColor) => {
  const c = NES_COLORS[nesColor & 0x3f];
  return [c & 0xff, (c >> 8) & 0xff, (c >> 16) & 0xff];
};
const hex = (v, n = 2) => "0x" + v.toString(16).toUpperCase().padStart(n, "0");

function loadRom(file) {
  const rom = fs.readFileSync(file);
  const prgSize = rom[4] * 0x4000;
  return { prg: rom.subarray(16, 16 + prgSize), chr: rom.subarray(16 + prgSize) };
}

// 记录：+0–2 精灵 1 号色板的 1–3 号色；+3 背景 1KB bank（MMC3 R5，图案表 $0C00，图块 $C0–$FF）；
// +4 精灵 2KB bank（R1，图案表 $1800–$1FFF，图块 $80–$FF）；+5 背景首图块；+6 精灵首图块。
// 两层都是 4×4 图块，图块号 = 首图块 + 行×4 + 列
function readRecord(prg, person) {
  const ptr = prg[RES_TABLE + person * 2] | (prg[RES_TABLE + person * 2 + 1] << 8);
  if (ptr < 0x8000 || ptr >= 0xc000) return null;
  const offset = ptr; // bank 4/5 映射在 $8000–$BFFF，正好对应 PRG 0x8000–0xBFFF
  const b = Array.from(prg.subarray(offset, offset + RECORD_SIZE));
  return {
    offset,
    colors: b.slice(0, 3),
    bgBank: b[3],
    spriteBank: b[4],
    bgTile: b[5],
    spriteTile: b[6],
  };
}

// 背景图块 t（$C0–$FF）在 1KB bank bgBank；精灵图块 t（$80–$FF）在 (R1 & ~1) + bit6
const bgTileOffset = (r, t) => r.bgBank * 0x400 + (t - 0xc0) * 16;
const spriteTileOffset = (r, t) => ((r.spriteBank & 0xfe) + ((t >> 6) & 1)) * 0x400 + (t & 0x3f) * 16;

function tilePixel(chr, off, x, y) {
  return ((chr[off + y] >> (7 - x)) & 1) | (((chr[off + y + 8] >> (7 - x)) & 1) << 1);
}

// 返回 32×32 的 NES 颜色号数组
function renderPortrait(chr, r) {
  const sprPal = [null, ...r.colors];
  const out = new Array(32 * 32);
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 4; col++) {
      const bgOff = bgTileOffset(r, r.bgTile + row * 4 + col);
      const spOff = spriteTileOffset(r, r.spriteTile + row * 4 + col);
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
          const s = tilePixel(chr, spOff, x, y);
          const color = s ? sprPal[s] : BG_PALETTE[tilePixel(chr, bgOff, x, y)];
          out[(row * 8 + y) * 32 + col * 8 + x] = color;
        }
      }
    }
  }
  return out;
}

function toPng(pixels, w, h) {
  const png = new PNG({ width: w, height: h });
  for (let i = 0; i < w * h; i++) {
    const [r, g, b] = rgb(pixels[i]);
    png.data.set([r, g, b, 255], i * 4);
  }
  return PNG.sync.write(png);
}

function writeFile(rel, data) {
  const file = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
}

function personNames() {
  const names = JSON.parse(fs.readFileSync(path.join(ROOT, "data/script/names.json"), "utf8"));
  const table = names.tables.find((t) => t.resource === "0x11");
  return Object.fromEntries(table.items.map((i) => [i.index, i.text ?? ""]));
}

function main() {
  const { prg, chr } = loadRom(process.argv[2] ?? path.join(ROOT, "rom/srw2.nes"));
  const names = personNames();
  const outDir = "assets/original/portraits";
  fs.rmSync(path.join(ROOT, outDir), { recursive: true, force: true });

  const entries = [];
  const firstBySource = new Map();
  // 每组背景 / 精灵图块第一次出现的编号。两层分别借自不同人物的记录（米巴、帕依）拼出来的是乱图
  const records = Array.from({ length: PEOPLE }, (_, i) => readRecord(prg, i));
  const firstBg = new Map(), firstSprite = new Map();
  records.forEach((r, i) => {
    if (!r) return;
    const bgKey = `${r.bgBank},${r.bgTile}`, spKey = `${r.spriteBank & 0xfe},${r.spriteTile}`;
    if (!firstBg.has(bgKey)) firstBg.set(bgKey, i);
    if (!firstSprite.has(spKey)) firstSprite.set(spKey, i);
  });
  const overview = new Array(16 * 32 * 7 * 32).fill(0x0f);
  for (let person = 0; person < PEOPLE; person++) {
    const r = records[person];
    if (!r) continue;
    const pixels = renderPortrait(chr, r);
    const file = `${String(person).padStart(2, "0")}.png`;
    writeFile(`${outDir}/${file}`, toPng(pixels, 32, 32));

    // 同一组图块 + 同色 = 同一张图
    const key = [r.bgBank, r.bgTile, r.spriteBank, r.spriteTile, ...r.colors].join(",");
    const same = firstBySource.get(key);
    if (same === undefined) firstBySource.set(key, person);

    const ox = (person % 16) * 32, oy = Math.floor(person / 16) * 32;
    for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) overview[(oy + y) * 512 + ox + x] = pixels[y * 32 + x];

    entries.push({
      id: person,
      idHex: hex(person),
      name: names[person] ?? "",
      file: `${outDir}/${file}`,
      width: 32,
      height: 32,
      record: hex(r.offset, 5),
      colors: r.colors.map((c) => hex(c)),
      bg: { chrBank1k: hex(r.bgBank), firstTile: hex(r.bgTile), chrOffset: hex(bgTileOffset(r, r.bgTile), 5) },
      sprite: { chrBank2k: hex(r.spriteBank), firstTile: hex(r.spriteTile), chrOffset: hex(spriteTileOffset(r, r.spriteTile), 5) },
      ...(same !== undefined ? { sameAs: same } : {}),
      // 整张只有一种颜色（对话框底色）= 空头像
      ...(pixels.every((c) => c === pixels[0]) ? { blank: true } : {}),
      ...(firstBg.get(`${r.bgBank},${r.bgTile}`) !== firstSprite.get(`${r.spriteBank & 0xfe},${r.spriteTile}`) ? { mixed: true } : {}),
    });
  }

  const json = {
    note: "对话头像，人物编号 = 资源 0x11 人物名下标 = 剧情 F9 参数。资源 0x85 每人 7 字节记录；图像 = 4×4 背景图块（色板 0f 30 10 00）上叠 4×4 精灵图块（色板 0f + colors）。sameAs = 与该编号的图完全相同；blank = 空头像（整张对话框灰）；mixed = 背景层和精灵层借自两个不同人物，拼出来是乱图（占位）。格式见 docs/notes-portraits.md",
    resourceTable: hex(RES_TABLE, 5),
    bgPalette: BG_PALETTE.map((c) => hex(c)),
    portraits: entries,
  };
  writeFile("data/portraits.json", JSON.stringify(json, null, 1) + "\n");
  writeFile("extracted/portraits/overview.png", toPng(overview, 512, 7 * 32));
  console.log(`导出 ${entries.length} 个头像，其中不同的图 ${firstBySource.size} 张`);
}

main();
