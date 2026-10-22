// 原版随机数（固定 bank $C359 / $C39B，跳转表 $C021 / $C024）。
//
// 64 个 16 位字组成的环形表，放在 RAM $0300–$037F，下标 $79（字节偏移，每次 +2，模 $80）。
// 新值 = 表[i - $6E] XOR 表[i - $30]（字节偏移，即往回第 55 个和第 24 个字），写回表[i]。
// rand(n) = 新值的低字节 mod n。
//
// 开机初始化（$C33C）：A 从 0 开始，逐字节 A = A + [$7410] + ROM[$F800 + x]（带中间进位），写到 $0300 + x。
// $7410 是存档 SRAM 里每帧加 1 的计数器，所以开机时的种子取决于存档里累计的帧数。
// 地图上光标移动、菜单操作都不消耗随机数；标题画面每帧都会调用，战斗动画、敌方移动的平局、
// 命中判定、精神伤害会消耗。因此读档后做同样的操作，结果完全一样（不能靠读档刷命中）。
export class OriginalRng {
  constructor(bytes, index = 0) {
    this.mem = Uint8Array.from(bytes); // 128 字节
    this.index = index & 0x7f;
  }

  static seed(counter7410, romF800) {
    const mem = new Uint8Array(128);
    let a = 0;
    for (let x = 0; x < 128; x++) {
      // 每轮末尾的 CPX #$80 会把进位清掉，所以进位只在一轮的两次加法之间传递
      const s = a + counter7410;
      a = ((s & 0xff) + romF800[x] + (s >> 8)) & 0xff;
      mem[x] = a;
    }
    return new OriginalRng(mem, 0);
  }

  next16() {
    const m = this.mem, i = this.index;
    const p = (i - 0x6e) & 0x7f, q = (i - 0x30) & 0x7f;
    const lo = m[p] ^ m[q];
    const hi = m[(p + 1) & 0x7f] ^ m[(q + 1) & 0x7f];
    m[(i + 1) & 0x7f] = hi;
    m[i] = lo;
    this.index = (i + 2) & 0x7f;
    return lo | (hi << 8);
  }

  rand(n) {
    return (this.next16() & 0xff) % n;
  }
}
