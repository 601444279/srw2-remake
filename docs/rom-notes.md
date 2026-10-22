# ROM 笔记

## 基本信息
- 文件：`rom/srw2.nes`（不进仓库），SHA1 `0f00406be0f5b81b2730802692759c2671cb140a`
- PRG 256KB，CHR 256KB，文件头标 mapper 74，实际行为是 **mapper 194**：外星汉化版的 MMC3 变种，1KB CHR bank 0、1 映射到 2KB CHR RAM，中文字形由程序动态写入
- 游戏会翻转 MMC3 的 CHR A12 反转位，把 RAM 换到 $0000 写字形、再从 $1000 显示，模拟器必须在翻转时立即重映射（实现见 `src/emu/waixing-mmc3.js`）
- 带电池存档，垂直镜像

## CHR 图块分布（`python3 tools/dump_chr.py rom/srw2.nes extracted/chr`）
| bank | 内容 |
|---|---|
| 0 | 英文数字字体、菜单符号、大地图地形图块 |
| 1 | 数字、小图标、部分头像 |
| 2–6 | 驾驶员头像（还需要 PRG 里的拼图表才能拼成完整头像） |
| 7–8 | 大地图上的 SD 小机体 |
| 9 | 背景、云、建筑 |
| 10 | 标题 Logo、星空 |
| 11–12 | 汉化字库（中文字） |
| 13–15 | 杂项、特效、未确认 |
| 16–31 | 战斗画面的大机体图（以拼图形式存放）和特效图块，见 `docs/notes-battle-gfx.md` |

## 运行与截图
- 网页播放器：`npm run dev`，打开 http://localhost:5173
- 无界面脚本：`node tools/emu.js 脚本.txt`，指令见文件头注释，可截图、存档、导出 PPU 状态
- 第一关：第1篇「救出刚达Z」

## 待办
- 找调色板数据，让图块显示原本颜色
- 找头像、战斗机体的拼图表（tile arrangement）
- 找地图数据、机体/武器数值表、剧情文本编码
