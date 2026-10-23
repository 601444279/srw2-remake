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
// 出击前剧情的世界地图（原版画面截出来的，assets/original/worldmap/）：第 1–13 关地球，14–22 关宇宙航线，23–26 关美洲。
// 红点是这一关的位置（地图图片里的像素坐标）。标题是原版关卡标题卡上的字（原版是现成的字形图块，不是文本）。
// 都是在模拟器里把关卡号 $7411 改成各关、让原版播出击前流程截出来的
export type WorldMapName = "earth" | "space" | "america";
export function worldMapOf(stage: number): WorldMapName {
  return stage <= 13 ? "earth" : stage <= 22 ? "space" : "america";
}

export const WORLD_MARKER: Record<number, { x: number; y: number }> = {
  1: { x: 4.0, y: 12.0 },
  2: { x: 20.0, y: 44.0 },
  3: { x: 4.0, y: 100.0 },
  4: { x: 4.0, y: 100.0 },
  5: { x: 52.0, y: 100.0 },
  6: { x: 84.0, y: 116.0 },
  7: { x: 84.0, y: 116.0 },
  8: { x: 84.0, y: 28.0 },
  9: { x: 132.0, y: 60.0 },
  10: { x: 204.0, y: 68.0 },
  11: { x: 212.0, y: 52.0 },
  12: { x: 156.0, y: 60.0 },
  13: { x: 156.0, y: 60.0 },
  14: { x: 44.0, y: 124.0 },
  15: { x: 148.0, y: 108.0 },
  16: { x: 188.0, y: 84.0 },
  17: { x: 148.0, y: 60.0 },
  18: { x: 108.0, y: 108.0 },
  19: { x: 220.0, y: 44.0 },
  20: { x: 212.0, y: 12.0 },
  21: { x: 212.0, y: 12.0 },
  22: { x: 12.0, y: 92.0 },
  23: { x: 132.0, y: 28.0 },
  24: { x: 116.0, y: 84.0 },
  25: { x: 156.0, y: 116.0 },
  26: { x: 156.0, y: 116.0 },
};

export const STAGE_STORY: Record<number, { title: string; subtitle: string }> = {
  1: { title: "第1篇", subtitle: "救出刚达Z" },
  2: { title: "第2篇", subtitle: "凶街" },
  3: { title: "第3篇", subtitle: "达卡尔之血" },
  4: { title: "第4篇", subtitle: "S．巴库" },
  5: { title: "第5篇", subtitle: "背叛的荒野" },
  6: { title: "第6篇", subtitle: "破坏敌要塞" },
  7: { title: "第7篇", subtitle: "决斗" },
  8: { title: "第8篇", subtitle: "圈套" },
  9: { title: "第9篇", subtitle: "复仇" },
  10: { title: "第10篇", subtitle: "夫奥" },
  11: { title: "第11篇", subtitle: "终极机器人" },
  12: { title: "第12篇", subtitle: "拉萨之战" },
  13: { title: "第13篇", subtitle: "影子" },
  14: { title: "第14篇", subtitle: "向着宇宙……" },
  15: { title: "第15篇", subtitle: "激战" },
  16: { title: "第16篇", subtitle: "逃脱" },
  17: { title: "第17篇", subtitle: "起动" },
  18: { title: "第18篇", subtitle: "潜入帕托" },
  19: { title: "第19篇", subtitle: "决战月球" },
  20: { title: "第20篇", subtitle: "决战古拉" },
  21: { title: "第21篇", subtitle: "停止吧，时间！" },
  22: { title: "第22篇", subtitle: "突入大气层" },
  23: { title: "第23篇", subtitle: "反击" },
  24: { title: "第24篇", subtitle: "亡灵" },
  25: { title: "第25篇", subtitle: "巴塔利二世" },
  26: { title: "第26篇", subtitle: "黎明的决斗" },
};
