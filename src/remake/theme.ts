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
const NUMBER = '"Saira Condensed", "Fusion Pixel 12px Proportional SC", sans-serif';

// 地图上飘的字：纯数字 / 英文用窄体斜体（同 num-l），带中文的用像素字，字号取 12 的整数倍
export function floatFont(text: string, cell: number): { font: string; size: number } {
  if (/^[-+0-9A-Z ]+$/.test(text)) {
    const size = Math.max(22, Math.round(cell * 0.6));
    return { font: `italic 800 ${size}px ${NUMBER}`, size };
  }
  const size = 12 * Math.max(1, Math.round((cell * 0.45) / 12));
  return { font: `400 ${size}px ${PIXEL}`, size };
}

// canvas 只在字体加载完以后才用得上它，先把地图要用的两种字体拉下来
document.fonts.load(`400 24px ${PIXEL}`);
document.fonts.load(`italic 800 24px ${NUMBER}`);
