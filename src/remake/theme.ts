// 界面规范在 canvas 这一侧的入口：加载字体，从 style.css 的 :root 读颜色，给地图上的字定字体。
// 颜色只在 style.css 里写一次，这里按名字取，HTML 和地图上的字永远同色。
import "@fontsource/fusion-pixel-12px-proportional-sc";
import "@fontsource/fusion-pixel-10px-proportional-sc";
import "@fontsource/saira-condensed/600.css";
import "@fontsource/saira-condensed/700.css";
import "@fontsource/saira-condensed/800.css";
import "@fontsource/chakra-petch/600.css";

export type Tone = "ink" | "dim" | "player" | "enemy" | "accent" | "hp" | "sp" | "warn" | "danger" | "combo" | "bg";

const cache = new Map<string, string>();
export function tone(name: Tone): string {
  let v = cache.get(name);
  if (!v) {
    v = getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim() || "#fff";
    cache.set(name, v);
  }
  return v;
}

const PIXEL = '"Fusion Pixel 12px Proportional SC", "PingFang SC", sans-serif';

// 地图上飘的字：和战斗画面的伤害数字同一规范（style.css --f-dmg）——像素字，只取 12px 原字的整数倍，
// 纯色，一圈正好一个字体像素宽的黑描边。px = 放大倍数（一个字体像素是几个屏幕像素）
export function floatFont(text: string, cell: number): { font: string; size: number; px: number } {
  const digits = /^[-+0-9A-Z ]+$/.test(text);
  const px = Math.max(2, Math.round((cell * (digits ? 0.55 : 0.45)) / 12));
  const size = 12 * px;
  return { font: `400 ${size}px ${PIXEL}`, size, px };
}

// canvas 只在字体加载完以后才用得上它，先把地图要用的像素字拉下来
document.fonts.load(`400 24px ${PIXEL}`);
