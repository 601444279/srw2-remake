// 起飞喊话表（bank 10 $89B5）：从母舰起飞时，按驾驶员和机体号范围挑文本资源 0x37 的哪一句（docs/notes-rules.md「母舰」）。
// 每项 4 字节：驾驶员、机体号下限、机体号上限、喊话号；FF 结束。查不到就不喊。
// 用法: node tools/extract-launch-shouts.js → data/launch-shouts.json
import fs from "node:fs";
import path from "node:path";
import { prgByte, ROOT } from "./lib/trace.js";

const rows = [];
for (let a = 0x89b5; prgByte(10, a) !== 0xff; a += 4) {
  rows.push({ pilot: prgByte(10, a), mechFrom: prgByte(10, a + 1), mechTo: prgByte(10, a + 2), shout: prgByte(10, a + 3) });
}
fs.writeFileSync(path.join(ROOT, "data/launch-shouts.json"), JSON.stringify({
  note: "起飞喊话：驾驶员 pilot 开机体 mechFrom–mechTo 时，从母舰起飞喊文本资源 0x37 第 shout 条。由 tools/extract-launch-shouts.js 从 bank 10 $89B5 导出",
  rows,
}, null, 1) + "\n");
console.log(`${rows.length} 项`);
