"""把 ROM 的 CHR 图块导出成灰度 PNG，每个 8KB bank 一张图。

用法: python3 tools/dump_chr.py rom/srw2.nes extracted/chr
"""
import sys
from pathlib import Path
from PIL import Image

GRAYS = [0, 85, 170, 255]
TILES_PER_ROW = 16


def parse_header(rom: bytes):
    assert rom[:4] == b"NES\x1a", "不是 iNES 格式"
    prg_size = rom[4] * 16 * 1024
    chr_size = rom[5] * 8 * 1024
    mapper = (rom[6] >> 4) | (rom[7] & 0xF0)
    trainer = 512 if rom[6] & 0x04 else 0
    return prg_size, chr_size, mapper, 16 + trainer


def decode_tile(data: bytes) -> list[int]:
    """NES 2bpp 图块：前 8 字节是低位平面，后 8 字节是高位平面。"""
    pixels = []
    for y in range(8):
        lo, hi = data[y], data[y + 8]
        for x in range(8):
            bit = 7 - x
            pixels.append(((lo >> bit) & 1) | (((hi >> bit) & 1) << 1))
    return pixels


def render_bank(bank: bytes) -> Image.Image:
    count = len(bank) // 16
    rows = (count + TILES_PER_ROW - 1) // TILES_PER_ROW
    img = Image.new("L", (TILES_PER_ROW * 8, rows * 8))
    px = img.load()
    for t in range(count):
        tx, ty = (t % TILES_PER_ROW) * 8, (t // TILES_PER_ROW) * 8
        for i, v in enumerate(decode_tile(bank[t * 16:(t + 1) * 16])):
            px[tx + i % 8, ty + i // 8] = GRAYS[v]
    return img


def main(rom_path: str, out_dir: str):
    rom = Path(rom_path).read_bytes()
    prg_size, chr_size, mapper, offset = parse_header(rom)
    print(f"PRG {prg_size // 1024}KB, CHR {chr_size // 1024}KB, mapper {mapper}")
    chr_data = rom[offset + prg_size: offset + prg_size + chr_size]
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    bank_size = 8 * 1024
    for i in range(chr_size // bank_size):
        img = render_bank(chr_data[i * bank_size:(i + 1) * bank_size])
        img.resize((img.width * 3, img.height * 3), Image.NEAREST).save(out / f"bank_{i:02d}.png")
    print(f"导出 {chr_size // bank_size} 张到 {out}")


if __name__ == "__main__":
    main(*sys.argv[1:3])
