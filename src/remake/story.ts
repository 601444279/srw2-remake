// 剧情：读取对话脚本（data/script/res-XX.json，tools/extract-text.js 导出），整理成逐句播放的台词。
import names from "../../data/script/names.json";
import portraitDb from "../../data/portraits.json";

const scriptFiles = import.meta.glob("../../data/script/res-*.json", { eager: true, import: "default" });
const portraitFiles = import.meta.glob("../../assets/original/portraits/*.png", { eager: true, import: "default", query: "?url" });

export interface Line {
  face: number | null; // 人物编号，用来找头像
  speaker: string;
  text: string;
}

// 一段剧情：资源号 + 脚本号，who 是第一句的说话人（原版由事件指令的参数决定头像）
export interface SceneRef {
  res: string; // 例如 "38"
  index: number;
  who?: number;
  // 播放前镜头先移到这个人物的单位（事件指令 41、42）
  focusUnit?: boolean;
}

interface RawNode {
  face?: number;
  speaker: string | null;
  text: string;
}

// 人物名表（资源 0x11），下标 = 人物编号 = 头像编号
const peopleTable = (names as { tables: { resource: string; items: unknown[] }[] }).tables.find((t) => t.resource === "0x11");
const people = (peopleTable?.items ?? []).map((i) => (typeof i === "string" ? i : (i as { text?: string } | null)?.text ?? null));

export function personName(id: number | null) {
  return id === null ? "" : people[id] ?? "";
}

// 头像（tools/extract-portraits.js 导出）：空图和拼错的乱图不用，对话框里显示名字首字占位
const usablePortraits = new Set(
  (portraitDb.portraits as { id: number; blank?: boolean; mixed?: boolean }[]).filter((p) => !p.blank && !p.mixed).map((p) => p.id),
);

export function portraitUrl(face: number | null): string | null {
  if (face === null || !usablePortraits.has(face)) return null;
  const hit = Object.entries(portraitFiles).find(([p]) => p.endsWith(`/${String(face).padStart(2, "0")}.png`));
  return hit ? (hit[1] as string) : null;
}

export function loadScene(ref: SceneRef): Line[] {
  const file = Object.entries(scriptFiles).find(([p]) => p.endsWith(`res-${ref.res}.json`));
  if (!file) throw new Error(`找不到剧情资源 res-${ref.res}`);
  const entry = (file[1] as { entries: { index: number; nodes: RawNode[] }[] }).entries.find((e) => e.index === ref.index);
  if (!entry) throw new Error(`找不到剧情 res-${ref.res}#${ref.index}`);
  let face = ref.who ?? null;
  return entry.nodes.map((n) => {
    if (n.face !== undefined) face = n.face;
    let speaker = n.speaker ?? "";
    let text = n.text;
    // 有几句名字后面没有换行码，导出时没拆出说话人：「卡姆：但敌人的实力…」
    const m = !speaker && text.match(/^([^\n：]{1,8})：\s*/);
    if (m) {
      speaker = m[1];
      text = text.slice(m[0].length);
    }
    return { face, speaker, text: text.replace(/‥/g, "…") };
  });
}

// 关卡标题卡（原版是 CHR 里现成的字形图块，还没提取排列表，先手写已知的）
// 世界地图上这一关的位置（红点，assets/original/worldmap/map.png 的像素坐标，原版出击前的剧情画面）
export const WORLD_MARKER: Record<number, { x: number; y: number }> = {
  1: { x: 3.5, y: 11.5 },
};

export const STAGE_STORY: Record<number, { title: string; subtitle: string }> = {
  1: { title: "第1篇", subtitle: "救出刚达Z" },
};
