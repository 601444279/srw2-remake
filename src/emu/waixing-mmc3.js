// 外星（Waixing）汉化版用的 MMC3 变种：部分 1KB CHR bank 编号不读 CHR ROM，
// 而是映射到 2KB CHR RAM，游戏把要显示的中文字形动态写进这块 RAM。
//   mapper 74：bank 8、9 是 RAM
//   mapper 194：bank 0、1 是 RAM
// 这份 ROM 文件头标的是 74，实际行为是 194（nesdev 的 194 游戏列表里也有本作），两个号都注册成同一套实现。
// 参考 https://www.nesdev.org/wiki/INES_Mapper_074 、https://www.nesdev.org/wiki/INES_Mapper_194
// jsnes 的 package exports 只公开入口，所以这里按文件路径引入内部模块。
import Mapper4 from "../../node_modules/jsnes/src/mappers/mapper4.js";
import Mappers from "../../node_modules/jsnes/src/mappers/index.js";
import Tile from "../../node_modules/jsnes/src/tile.js";

const RAM_BANKS = { 74: [8, 9], 194: [0, 1] };
const ACTIVE_LAYOUT = 194;

class WaixingMmc3 extends Mapper4 {
  static mapperName = "MMC3 (Waixing CHR-RAM)";

  constructor(nes) {
    super(nes);
    this.ramBanks = RAM_BANKS[ACTIVE_LAYOUT];
    this.chrRam = new Uint8Array(2048);
    this.chrRamTiles = [0, 1].map(() => Array.from({ length: 64 }, () => new Tile()));
    // 每个 1KB 图案表位置当前映射的 RAM bank（0/1），-1 表示 CHR ROM
    this.chrRamSlots = new Array(8).fill(-1);
    this.chrRegs = [0, 2, 4, 5, 6, 7];
  }

  loadROM() {
    super.loadROM();
    this.hookPpuWrites();
  }

  // CHR RAM 以 this.chrRam 为准。同一个 RAM bank 可能同时映射在两个位置（游戏从 $0000 写字形、从 $1000 显示），
  // 所以写入时直接改 chrRam，再同步到所有映射了这个 bank 的位置。
  hookPpuWrites() {
    const ppu = this.nes.ppu;
    const original = ppu.writeMem.bind(ppu);
    ppu.writeMem = (address, value) => {
      if (address >= 0x2000) return original(address, value);
      const bank = this.chrRamSlots[address >> 10];
      if (bank === -1) return;
      const offset = address & 0x3ff;
      this.chrRam[bank * 1024 + offset] = value;
      this.updateTileRow(bank, offset);
      for (let slot = 0; slot < 8; slot++) {
        if (this.chrRamSlots[slot] === bank) ppu.vramMem[(slot << 10) | offset] = value;
      }
    };
  }

  updateTileRow(bank, offset) {
    const base = bank * 1024 + (offset & ~15);
    const row = offset & 7;
    this.chrRamTiles[bank][offset >> 4].setScanline(row, this.chrRam[base + row], this.chrRam[base + row + 8]);
  }

  // 真实 MMC3 改变 $8000 的 bit 7（CHR A12 反转）时布局立即生效，
  // jsnes 只在写 bank 寄存器时才重新映射。游戏会翻转这一位把 CHR RAM 换到 $0000 写字形，
  // 所以这里记住 R0–R5，布局位变化时全部重映射。
  write(address, value) {
    const before = this.chrAddressSelect;
    super.write(address, value);
    if (address >= 0x8000 && (address & 0xe001) === 0x8000 && this.chrAddressSelect !== before) {
      this.remapAllChr();
    }
  }

  remapAllChr() {
    for (let cmd = 0; cmd < 6; cmd++) this.executeCommand(cmd, this.chrRegs[cmd]);
  }

  executeCommand(cmd, arg) {
    if (cmd > 5) {
      super.executeCommand(cmd, arg);
      return;
    }
    this.chrRegs[cmd] = arg;
    const invert = this.chrAddressSelect ? 0x1000 : 0;
    if (cmd <= 1) {
      const base = (cmd === 0 ? 0x0000 : 0x0800) ^ invert;
      this.mapChr1k(arg & 0xfe, base);
      this.mapChr1k((arg & 0xfe) + 1, base + 0x400);
    } else {
      this.mapChr1k(arg, (0x1000 + (cmd - 2) * 0x400) ^ invert);
    }
  }

  mapChr1k(bank, address) {
    const slot = address >> 10;
    const ramIndex = this.ramBanks.indexOf(bank);
    if (ramIndex === -1) {
      this.chrRamSlots[slot] = -1;
      this.load1kVromBank(bank, address);
      return;
    }
    const ppu = this.nes.ppu;
    ppu.triggerRendering();
    this.chrRamSlots[slot] = ramIndex;
    ppu.vramMem.set(this.chrRam.subarray(ramIndex * 1024, ramIndex * 1024 + 1024), address);
    for (let i = 0; i < 64; i++) ppu.ptTile[(address >> 4) + i] = this.chrRamTiles[ramIndex][i];
  }

  canWriteChr(address) {
    return address < 0x2000 && this.chrRamSlots[address >> 10] !== -1;
  }

  // 给导出工具用：RAM 已经是权威数据，不需要回写
  saveChrRamSlot() {}

  toJSON() {
    const s = super.toJSON();
    s.chrRam = Array.from(this.chrRam);
    s.chrRegs = this.chrRegs.slice();
    return s;
  }

  fromJSON(s) {
    super.fromJSON(s);
    this.chrRam = new Uint8Array(s.chrRam);
    for (let i = 0; i < 2048; i++) this.updateTileRow(i >> 10, i & 0x3ff);
    this.chrRegs = s.chrRegs.slice();
    this.remapAllChr();
  }
}

Mappers[74] = WaixingMmc3;
Mappers[194] = WaixingMmc3;
export default WaixingMmc3;
