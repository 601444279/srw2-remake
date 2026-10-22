// 反汇编 PRG 某个 8KB bank 的一段代码。
// 用法: node tools/dis.js <bank> <CPU 地址(16进制)> [条数]
// 例:   node tools/dis.js 6 8C00 80
// bank 30、31 固定在 $C000、$E000，跨 bank 读取时按地址所在槽位取对应 bank。
import { prgByte } from "./lib/trace.js";
import { disasm } from "./lib/dis6502.js";

const [bankArg, addrArg, countArg] = process.argv.slice(2);
const bank = Number(bankArg);
const addr = parseInt(addrArg, 16);
const read = (a) => {
  if (a >= 0xe000) return prgByte(31, a);
  if (a >= 0xc000 && bank < 30) return prgByte(30, a);
  return prgByte(bank, a);
};
console.log(disasm(read, addr, Number(countArg ?? 60)));
