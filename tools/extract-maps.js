// 从 ROM 提取全部关卡地图、地图环境（地形色板、地形效果、移动消耗）和地形图块。
//
// 用法: node tools/extract-maps.js [rom/srw2.nes]
// 输出:
//   data/maps/stageNN.json       每关地形图
//   data/environments.json       地图环境
//   data/deployments.json        每关敌我单位初始配置
//   assets/original/terrain/env-N.png   每个环境的 16 种地形图块（16x16，横排）
//   assets/original/units/bank-NN-{player,enemy}.png   单位地图图标，每个 1KB CHR bank 16 个（16x16，横排）
//   extracted/maps/stageNN.png   地图预览图（不进仓库）
//
// ROM 结构见 docs/notes-maps.md。
import fs from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const STAGE_COUNT = 27;

// PRG 偏移。地图相关数据在 8KB bank 2/3，载入时分别映射在 $8000/$A000
const MAP_POINTERS = 0x5a9f; // CPU $9A9F，27 个地图指针
const ENV_POINTERS = 0x6d8c; // CPU $AD8C，27 个环境指针
// 每关一条单位图块记录（19 字节）：16 字节用途待确认，后 3 字节是 R2、R3、R4，
// 即图块号 $00–$3F、$40–$7F、$80–$BF 所在的 1KB CHR bank
const UNIT_CHR_POINTERS = 0x6f1c; // CPU $AF1C，bank 3
const DEPLOY_POINTERS = 0x701a; // CPU $B01A，bank 3 映射在 $A000，32 个部署块指针
const DEPLOY_COUNT = 32;
const cpuToPrg = (addr) => 0x4000 + (addr - 0x8000);

// 单位图标是背景图块：我方用 2 号色板，敌方用 3 号，0 号色是黑底（整格替换地形）
const UNIT_PALETTES = { player: 2, enemy: 3 };

// 背景色板：0、2、3 号固定，1 号由环境决定（见固定 bank 里 $B2B0 附近的色板脚本）
const BG_PALETTES = [
  [0x0f, 0x30, 0x10, 0x00],
  null,
  [0x0f, 0x30, 0x21, 0x02],
  [0x0f, 0x37, 0x27, 0x16],
];

// jsnes 的 NTSC 调色板（0xBBGGRR）
const NES_COLORS = [0x525252, 0xb40000, 0xa00000, 0xb1003d, 0x740069, 0x00005b, 0x00005f, 0x001840, 0x002f10, 0x084a08, 0x006700, 0x124200, 0x6d2800, 0x000000, 0x000000, 0x000000, 0xc4d5e7, 0xff4000, 0xdc0e22, 0xff476b, 0xd7009f, 0x680ad7, 0x0019bc, 0x0054b1, 0x006a5b, 0x008c03, 0x00ab00, 0x2c8800, 0xa47200, 0x000000, 0x000000, 0x000000, 0xf8f8f8, 0xffab3c, 0xff7981, 0xff5bc5, 0xff48f2, 0xdf49ff, 0x476dff, 0x00b4f7, 0x00e0ff, 0x00e375, 0x03f42b, 0x78b82e, 0xe5e218, 0x787878, 0x000000, 0x000000, 0xffffff, 0xfff2be, 0xf8b8b8, 0xf8b8d8, 0xffb6ff, 0xffc3ff, 0xc7d1ff, 0x9adaff, 0x88edf8, 0x83ffdd, 0xb8f8b8, 0xf5f8ac, 0xffffb0, 0xf8d8f8, 0x000000, 0x000000];
const rgb = (nesColor) => {
  const c = NES_COLORS[nesColor & 0x3f];
  return [c & 0xff, (c >> 8) & 0xff, (c >> 16) & 0xff];
};

function loadRom(file) {
  const rom = fs.readFileSync(file);
  const prgSize = rom[4] * 0x4000;
  return { prg: rom.subarray(16, 16 + prgSize), chr: rom.subarray(16 + prgSize) };
}

const word = (buf, off) => buf[off] | (buf[off + 1] << 8);

// 地图压缩格式：宽、高各 1 字节，之后每字节低 4 位是地形编号、高 4 位 +1 是重复次数，游程可以跨行
function decodeMap(prg, addr) {
  let o = cpuToPrg(addr);
  const width = prg[o++];
  const height = prg[o++];
  const cells = [];
  while (cells.length < width * height) {
    const b = prg[o++];
    for (let n = (b >> 4) + 1; n > 0; n--) cells.push(b & 0x0f);
  }
  if (cells.length !== width * height) throw new Error(`地图 $${addr.toString(16)} 游程越界`);
  const terrain = [];
  for (let y = 0; y < height; y++) terrain.push(cells.slice(y * width, (y + 1) * width));
  return { width, height, terrain, byteLength: o - cpuToPrg(addr) };
}

// 环境记录（84 字节）：
//   +0  16 字节  地形 → 色板（属性字节，色板号 × 0x55）
//   +16 16 字节  地形效果（原始值，0x64 = 100；最高位含义待确认）
//   +32 48 字节  3 组移动消耗，每组 16 种地形（0 = 不能进入；哪组对应空/陆/海待确认）
//   +80  3 字节  1 号色板的 3 个颜色
//   +83  1 字节  地形图块所在的 1KB CHR bank
function decodeEnvironment(prg, addr) {
  const o = cpuToPrg(addr);
  const bytes = (start, len) => Array.from(prg.subarray(o + start, o + start + len));
  return {
    terrainPalette: bytes(0, 16).map((b) => b / 0x55),
    terrainEffectRaw: bytes(16, 16),
    moveCostRaw: [bytes(32, 16), bytes(48, 16), bytes(64, 16)],
    palette1: [0x0f, ...bytes(80, 3)],
    chrBank1k: prg[o + 83],
  };
}

// 2bpp 图块 → 调色板下标
function tilePixels(chr, bank1k, tileIndex) {
  const base = bank1k * 0x400 + tileIndex * 16;
  const px = [];
  for (let y = 0; y < 8; y++) {
    const lo = chr[base + y], hi = chr[base + y + 8];
    for (let x = 0; x < 8; x++) px.push(((lo >> (7 - x)) & 1) | (((hi >> (7 - x)) & 1) << 1));
  }
  return px;
}

function drawSprite(png, dx, chr, bank1k, sprite, palette) {
  for (let q = 0; q < 4; q++) {
    const px = tilePixels(chr, bank1k, sprite * 4 + q);
    const ox = dx + (q & 1) * 8, oy = (q >> 1) * 8;
    for (let i = 0; i < 64; i++) {
      const [r, g, b] = rgb(palette[px[i]]);
      const p = ((oy + (i >> 3)) * png.width + ox + (i & 7)) * 4;
      png.data[p] = r; png.data[p + 1] = g; png.data[p + 2] = b; png.data[p + 3] = 255;
    }
  }
}

// 地形 n 的 16x16 图块由 CHR 里第 4n..4n+3 个 8x8 图块拼成（左上、右上、左下、右下）
function drawTerrain(png, dx, dy, chr, env, terrainId) {
  const palette = terrainId === 0 ? BG_PALETTES[0] : env.terrainPalette[terrainId] === 1 ? env.palette1 : BG_PALETTES[env.terrainPalette[terrainId]];
  for (let q = 0; q < 4; q++) {
    const px = tilePixels(chr, env.chrBank1k, terrainId * 4 + q);
    const ox = dx + (q & 1) * 8, oy = dy + (q >> 1) * 8;
    for (let i = 0; i < 64; i++) {
      const [r, g, b] = rgb(palette[px[i]]);
      const p = ((oy + (i >> 3)) * png.width + ox + (i & 7)) * 4;
      png.data[p] = r; png.data[p + 1] = g; png.data[p + 2] = b; png.data[p + 3] = 255;
    }
  }
}

// 部署块：4 段，每段以 0xFF 结束
//   0: 6 字节记录（多数关卡为空，用途待确认）
//   1: 敌人，6 字节：X、Y、参数 a、机体编号、参数 b、参数 c
//   2: 6 字节记录（可能是援军或 NPC，待确认）
//   3: 我方出击位置，4 字节：X、Y、出击顺序、保留
const bank3ToPrg = (addr) => 0x6000 + (addr - 0xa000);
function decodeDeployment(prg, addr) {
  let o = bank3ToPrg(addr);
  const sizes = [6, 6, 6, 4];
  const lists = sizes.map((size) => {
    const list = [];
    while (prg[o] !== 0xff) {
      list.push(Array.from(prg.subarray(o, o + size)));
      o += size;
    }
    o++;
    return list;
  });
  const six = ([x, y, a, unit, b, c]) => ({ x, y, unit, a, b, c });
  return {
    romAddress: `$${addr.toString(16)}`,
    byteLength: o - bank3ToPrg(addr),
    extra0: lists[0].map(six),
    enemies: lists[1].map(six),
    extra2: lists[2].map(six),
    players: lists[3].map(([x, y, order, reserved]) => ({ x, y, order, reserved })),
  };
}

function writeFile(rel, data) {
  const file = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
}

function main(romFile = path.join(ROOT, "rom/srw2.nes")) {
  const { prg, chr } = loadRom(romFile);

  const envAddrs = [];
  const stages = [];
  for (let i = 0; i < STAGE_COUNT; i++) {
    const mapAddr = word(prg, MAP_POINTERS + i * 2);
    const envAddr = word(prg, ENV_POINTERS + i * 2);
    if (!envAddrs.includes(envAddr)) envAddrs.push(envAddr);
    stages.push({ stage: i + 1, mapAddr, envAddr });
  }
  envAddrs.sort((a, b) => a - b);

  const environments = envAddrs.map((addr, id) => ({ id, romAddress: `$${addr.toString(16)}`, ...decodeEnvironment(prg, addr) }));
  const envText = JSON.stringify(environments, null, 2).replace(/\[\s+([\d,\s]+?)\s+\]/g, (_, nums) => `[${nums.replace(/\s+/g, " ")}]`);
  writeFile("data/environments.json", envText + "\n");

  for (const env of environments) {
    const png = new PNG({ width: 16 * 16, height: 16 });
    for (let t = 0; t < 16; t++) drawTerrain(png, t * 16, 0, chr, env, t);
    writeFile(`assets/original/terrain/env-${env.id}.png`, PNG.sync.write(png));
  }

  const unitBanks = new Set();
  for (const st of stages) {
    const rec = bank3ToPrg(word(prg, UNIT_CHR_POINTERS + (st.stage - 1) * 2));
    st.unitChrBanks = Array.from(prg.subarray(rec + 16, rec + 19));
    st.unitChrBanks.forEach((b) => unitBanks.add(b));
  }
  for (const bank of unitBanks) {
    for (const [side, pal] of Object.entries(UNIT_PALETTES)) {
      const png = new PNG({ width: 16 * 16, height: 16 });
      for (let i = 0; i < 16; i++) drawSprite(png, i * 16, chr, bank, i, BG_PALETTES[pal]);
      writeFile(`assets/original/units/bank-${bank}-${side}.png`, PNG.sync.write(png));
    }
  }

  for (const { stage, mapAddr, envAddr, unitChrBanks } of stages) {
    const map = decodeMap(prg, mapAddr);
    const environment = envAddrs.indexOf(envAddr);
    const name = `stage${String(stage).padStart(2, "0")}`;
    const json = {
      stage,
      width: map.width,
      height: map.height,
      environment,
      unitChrBanks,
      romAddress: `$${mapAddr.toString(16)}`,
      terrain: map.terrain,
    };
    // 每行一行，方便肉眼看和 diff
    const text = JSON.stringify(json, null, 2).replace(/\[\s+([\d,\s]+?)\s+\]/g, (_, nums) => `[${nums.replace(/\s+/g, " ")}]`);
    writeFile(`data/maps/${name}.json`, text + "\n");

    const png = new PNG({ width: map.width * 16, height: map.height * 16 });
    map.terrain.forEach((row, y) => row.forEach((t, x) => drawTerrain(png, x * 16, y * 16, chr, environments[environment], t)));
    writeFile(`extracted/maps/${name}.png`, PNG.sync.write(png));
  }

  const deployments = [];
  for (let i = 0; i < DEPLOY_COUNT; i++) {
    const addr = word(prg, DEPLOY_POINTERS + i * 2);
    const next = i + 1 < DEPLOY_COUNT ? word(prg, DEPLOY_POINTERS + (i + 1) * 2) : null;
    const d = decodeDeployment(prg, addr);
    if (next !== null && d.byteLength !== next - addr) console.warn(`部署块 ${i + 1} 长度 ${d.byteLength}，和下一个指针差 ${next - addr} 不一致`);
    deployments.push({ block: i + 1, ...d });
  }
  const compact = JSON.stringify(deployments, null, 2).replace(/\{\s+("x"[^{}]*?)\s+\}/g, (_, body) => `{ ${body.replace(/\s+/g, " ")} }`);
  writeFile("data/deployments.json", compact + "\n");

  console.log(`导出 ${stages.length} 张地图、${environments.length} 种地图环境`);
}

main(process.argv[2]);
