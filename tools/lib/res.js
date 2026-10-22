// 离线解析游戏的「资源表」：固定 bank 例程 $FD4F（跳转表 $C10B）的等价实现。
// 游戏用 ($18=资源类型, $19=编号) 找数据：
//   类型表：类型 < $80 查 $F3E2+2*类型，否则查 $F4E2+2*(类型-$80)，取 1 字节 V
//   V 的 (V>>3)&$1E 是 8KB bank 对（b 放 $8000，b+1 放 $A000），V&$0F 选 $8000 处指针表的第几项
//   该指针指向一张以编号为下标的 16 位指针表，得到数据地址
// 已用到的类型：$84 驾驶员（精神点数），$86 机体，$87 武器，$88 成长曲线，$89 机体标志
import { prgByte } from "./trace.js";

export function resolve(type, idx) {
  const t = type & 0xff;
  const v = t < 0x80 ? prgByte(31, 0xf3e2 + 2 * t) : prgByte(31, 0xf4e2 + 2 * (t - 0x80));
  const bank = (v >> 3) & 0x1e;
  const read = (a) => (a < 0xa000 ? prgByte(bank, a) : a < 0xc000 ? prgByte(bank + 1, a) : a < 0xe000 ? prgByte(30, a) : prgByte(31, a));
  const slot = (v & 0x0f) * 2;
  const table = read(0x8000 + slot) | (read(0x8001 + slot) << 8);
  const p = table + idx * 2;
  const addr = read(p) | (read(p + 1) << 8);
  return { bank, addr, read, bytes: (n) => Array.from({ length: n }, (_, i) => read(addr + i)) };
}

// 远调用（$C108 / $FCF0）：编号 n → 资源 (类型, 编号)，表在固定 bank $F21E（n >= $80 时在 $F31E）
export function farCall(n) {
  const base = n < 0x80 ? 0xf21e : 0xf31e;
  const i = (n & 0x7f) * 2;
  const type = prgByte(31, base + i), idx = prgByte(31, base + i + 1);
  const r = resolve(type, idx);
  return { type, idx, bank: r.addr < 0xa000 ? r.bank : r.bank + 1, addr: r.addr };
}
