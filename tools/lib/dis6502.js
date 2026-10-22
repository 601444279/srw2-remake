// 简单的 6502 反汇编器，用来读 ROM 里的规则例程。
// disasm(read, addr, count) 里 read(addr) 返回该 CPU 地址的字节。
const MODES = {
  imp: 1, acc: 1, imm: 2, zp: 2, zpx: 2, zpy: 2, izx: 2, izy: 2, rel: 2,
  abs: 3, abx: 3, aby: 3, ind: 3,
};
// 只列官方指令，其余当作 .db
const OPS = {};
function def(name, list) {
  for (const [op, mode] of list) OPS[op] = [name, mode];
}
def("ADC", [[0x69, "imm"], [0x65, "zp"], [0x75, "zpx"], [0x6d, "abs"], [0x7d, "abx"], [0x79, "aby"], [0x61, "izx"], [0x71, "izy"]]);
def("AND", [[0x29, "imm"], [0x25, "zp"], [0x35, "zpx"], [0x2d, "abs"], [0x3d, "abx"], [0x39, "aby"], [0x21, "izx"], [0x31, "izy"]]);
def("ASL", [[0x0a, "acc"], [0x06, "zp"], [0x16, "zpx"], [0x0e, "abs"], [0x1e, "abx"]]);
def("BIT", [[0x24, "zp"], [0x2c, "abs"]]);
def("BPL", [[0x10, "rel"]]); def("BMI", [[0x30, "rel"]]); def("BVC", [[0x50, "rel"]]); def("BVS", [[0x70, "rel"]]);
def("BCC", [[0x90, "rel"]]); def("BCS", [[0xb0, "rel"]]); def("BNE", [[0xd0, "rel"]]); def("BEQ", [[0xf0, "rel"]]);
def("BRK", [[0x00, "imp"]]);
def("CMP", [[0xc9, "imm"], [0xc5, "zp"], [0xd5, "zpx"], [0xcd, "abs"], [0xdd, "abx"], [0xd9, "aby"], [0xc1, "izx"], [0xd1, "izy"]]);
def("CPX", [[0xe0, "imm"], [0xe4, "zp"], [0xec, "abs"]]);
def("CPY", [[0xc0, "imm"], [0xc4, "zp"], [0xcc, "abs"]]);
def("DEC", [[0xc6, "zp"], [0xd6, "zpx"], [0xce, "abs"], [0xde, "abx"]]);
def("EOR", [[0x49, "imm"], [0x45, "zp"], [0x55, "zpx"], [0x4d, "abs"], [0x5d, "abx"], [0x59, "aby"], [0x41, "izx"], [0x51, "izy"]]);
def("CLC", [[0x18, "imp"]]); def("SEC", [[0x38, "imp"]]); def("CLI", [[0x58, "imp"]]); def("SEI", [[0x78, "imp"]]);
def("CLV", [[0xb8, "imp"]]); def("CLD", [[0xd8, "imp"]]); def("SED", [[0xf8, "imp"]]);
def("INC", [[0xe6, "zp"], [0xf6, "zpx"], [0xee, "abs"], [0xfe, "abx"]]);
def("JMP", [[0x4c, "abs"], [0x6c, "ind"]]); def("JSR", [[0x20, "abs"]]);
def("LDA", [[0xa9, "imm"], [0xa5, "zp"], [0xb5, "zpx"], [0xad, "abs"], [0xbd, "abx"], [0xb9, "aby"], [0xa1, "izx"], [0xb1, "izy"]]);
def("LDX", [[0xa2, "imm"], [0xa6, "zp"], [0xb6, "zpy"], [0xae, "abs"], [0xbe, "aby"]]);
def("LDY", [[0xa0, "imm"], [0xa4, "zp"], [0xb4, "zpx"], [0xac, "abs"], [0xbc, "abx"]]);
def("LSR", [[0x4a, "acc"], [0x46, "zp"], [0x56, "zpx"], [0x4e, "abs"], [0x5e, "abx"]]);
def("NOP", [[0xea, "imp"]]);
def("ORA", [[0x09, "imm"], [0x05, "zp"], [0x15, "zpx"], [0x0d, "abs"], [0x1d, "abx"], [0x19, "aby"], [0x01, "izx"], [0x11, "izy"]]);
def("TAX", [[0xaa, "imp"]]); def("TXA", [[0x8a, "imp"]]); def("DEX", [[0xca, "imp"]]); def("INX", [[0xe8, "imp"]]);
def("TAY", [[0xa8, "imp"]]); def("TYA", [[0x98, "imp"]]); def("DEY", [[0x88, "imp"]]); def("INY", [[0xc8, "imp"]]);
def("ROL", [[0x2a, "acc"], [0x26, "zp"], [0x36, "zpx"], [0x2e, "abs"], [0x3e, "abx"]]);
def("ROR", [[0x6a, "acc"], [0x66, "zp"], [0x76, "zpx"], [0x6e, "abs"], [0x7e, "abx"]]);
def("RTI", [[0x40, "imp"]]); def("RTS", [[0x60, "imp"]]);
def("SBC", [[0xe9, "imm"], [0xe5, "zp"], [0xf5, "zpx"], [0xed, "abs"], [0xfd, "abx"], [0xf9, "aby"], [0xe1, "izx"], [0xf1, "izy"]]);
def("STA", [[0x85, "zp"], [0x95, "zpx"], [0x8d, "abs"], [0x9d, "abx"], [0x99, "aby"], [0x81, "izx"], [0x91, "izy"]]);
def("STX", [[0x86, "zp"], [0x96, "zpy"], [0x8e, "abs"]]);
def("STY", [[0x84, "zp"], [0x94, "zpx"], [0x8c, "abs"]]);
def("TXS", [[0x9a, "imp"]]); def("TSX", [[0xba, "imp"]]); def("PHA", [[0x48, "imp"]]); def("PLA", [[0x68, "imp"]]);
def("PHP", [[0x08, "imp"]]); def("PLP", [[0x28, "imp"]]);

const h2 = (v) => v.toString(16).toUpperCase().padStart(2, "0");
const h4 = (v) => v.toString(16).toUpperCase().padStart(4, "0");

// 反汇编一条，返回 { addr, size, text, bytes }
export function disasmOne(read, addr) {
  const op = read(addr);
  const info = OPS[op];
  if (!info) return { addr, size: 1, bytes: [op], text: `.db $${h2(op)}` };
  const [name, mode] = info;
  const size = MODES[mode];
  const b1 = size > 1 ? read((addr + 1) & 0xffff) : 0;
  const b2 = size > 2 ? read((addr + 2) & 0xffff) : 0;
  const w = b1 | (b2 << 8);
  let arg = "";
  switch (mode) {
    case "imm": arg = `#$${h2(b1)}`; break;
    case "zp": arg = `$${h2(b1)}`; break;
    case "zpx": arg = `$${h2(b1)},X`; break;
    case "zpy": arg = `$${h2(b1)},Y`; break;
    case "izx": arg = `($${h2(b1)},X)`; break;
    case "izy": arg = `($${h2(b1)}),Y`; break;
    case "rel": arg = `$${h4((addr + 2 + ((b1 << 24) >> 24)) & 0xffff)}`; break;
    case "abs": arg = `$${h4(w)}`; break;
    case "abx": arg = `$${h4(w)},X`; break;
    case "aby": arg = `$${h4(w)},Y`; break;
    case "ind": arg = `($${h4(w)})`; break;
    case "acc": arg = "A"; break;
  }
  const bytes = [op, b1, b2].slice(0, size);
  return { addr, size, bytes, text: `${name} ${arg}`.trim(), name, mode, operand: mode === "rel" ? (addr + 2 + ((b1 << 24) >> 24)) & 0xffff : w };
}

export function disasm(read, addr, count, labels = {}) {
  const lines = [];
  for (let i = 0; i < count; i++) {
    const d = disasmOne(read, addr);
    const hex = d.bytes.map(h2).join(" ").padEnd(9);
    const note = labels[d.operand] ? `  ; ${labels[d.operand]}` : "";
    lines.push(`${h4(addr)}  ${hex} ${d.text}${note}`);
    addr = (addr + d.size) & 0xffff;
  }
  return lines.join("\n");
}

export { h2, h4 };
