// 玩家设置：按键绑定（每个功能两个键）、鼠标开关、文字速度、音乐和音效。保存在 localStorage。

export type BindAction =
  | "up" | "down" | "left" | "right"
  | "confirm" | "cancel" | "next" | "prev"
  | "danger" | "menu" | "fast" | "zoomIn" | "zoomOut" | "settings" | "save" | "load";

export type Binding = [string | null, string | null];

// 顺序就是设置界面里的显示顺序
export const BIND_ACTIONS: { id: BindAction; label: string; group: string }[] = [
  { id: "up", label: "上", group: "移动" },
  { id: "down", label: "下", group: "移动" },
  { id: "left", label: "左", group: "移动" },
  { id: "right", label: "右", group: "移动" },
  { id: "fast", label: "快速（按住）", group: "移动" },
  { id: "confirm", label: "确定", group: "操作" },
  { id: "cancel", label: "取消 / 返回", group: "操作" },
  { id: "next", label: "下一个单位", group: "操作" },
  { id: "prev", label: "上一个单位", group: "操作" },
  { id: "danger", label: "敌方威胁范围", group: "操作" },
  { id: "menu", label: "地图菜单", group: "操作" },
  { id: "save", label: "存档", group: "操作" },
  { id: "load", label: "读档", group: "操作" },
  { id: "zoomIn", label: "放大", group: "画面" },
  { id: "zoomOut", label: "缩小", group: "画面" },
  { id: "settings", label: "打开设置", group: "画面" },
];

export type TextSpeed = "slow" | "normal" | "fast" | "instant";
export const TEXT_SPEEDS: { id: TextSpeed; label: string; cps: number }[] = [
  { id: "slow", label: "慢", cps: 20 },
  { id: "normal", label: "中", cps: 40 },
  { id: "fast", label: "快", cps: 80 },
  { id: "instant", label: "瞬间", cps: Infinity },
];

export type MusicStyle = "enhanced" | "original";
export const MUSIC_STYLES: { id: MusicStyle; label: string }[] = [
  { id: "enhanced", label: "增强版" },
  { id: "original", label: "原版" },
];
// 音量档位
export const VOLUMES = [0, 0.2, 0.4, 0.6, 0.8, 1];
export const volumeLabel = (v: number) => (v === 0 ? "关" : `${Math.round(v * 100)}%`);

// 画面：原版像素（整数倍放大）/ 平滑放大（Scale4x，见 upscale.ts）
export type ArtStyle = "original" | "smooth";
export const ART_STYLES: { id: ArtStyle; label: string }[] = [
  { id: "original", label: "原版像素" },
  { id: "smooth", label: "平滑放大" },
];

// 战斗演出：完整 = 原版战斗画面（机体大图 + 武器特效）；简略 = 地图上的小战斗面板
export type BattleStyle = "full" | "simple";
export const BATTLE_STYLES: { id: BattleStyle; label: string }[] = [
  { id: "full", label: "完整" },
  { id: "simple", label: "简略" },
];

export interface Settings {
  keys: Record<BindAction, Binding>;
  mouse: boolean;
  artStyle: ArtStyle;
  battleStyle: BattleStyle;
  // 机体飞行演出：选中时起飞悬停、移动时加速减速、引擎声；关掉就是原版（上下跳动、匀速移动）
  flight: boolean;
  // 重制版的成长加成：特性成长（Lv 10 / 20 / 30 强化）、击破连击（同一阶段连续击破经验递增）
  traitGrowth: boolean;
  killCombo: boolean;
  textSpeed: TextSpeed;
  musicStyle: MusicStyle;
  musicVolume: number;
  sfxVolume: number;
  // 命中音效：打中时补一声（原版只放攻击动画自带的音效，有的武器打中没声）
  hitSfx: boolean;
}

export const DEFAULT_KEYS: Record<BindAction, Binding> = {
  up: ["ArrowUp", "KeyW"],
  down: ["ArrowDown", "KeyS"],
  left: ["ArrowLeft", "KeyA"],
  right: ["ArrowRight", "KeyD"],
  fast: ["ShiftLeft", "ShiftRight"],
  confirm: ["KeyX", "Enter"],
  cancel: ["KeyZ", "Escape"],
  next: ["KeyE", "Tab"],
  prev: ["KeyQ", null],
  danger: ["KeyR", null],
  menu: ["KeyM", "Space"],
  zoomIn: ["Equal", "NumpadAdd"],
  zoomOut: ["Minus", "NumpadSubtract"],
  settings: ["KeyO", null],
  save: ["F5", null],
  load: ["F9", null],
};

const STORAGE_KEY = "srw2-remake:settings";
const listeners = new Set<() => void>();

function load(): Settings {
  const fallback: Settings = {
    keys: structuredClone(DEFAULT_KEYS), mouse: true, artStyle: "original", battleStyle: "full", flight: true, traitGrowth: true, killCombo: true, textSpeed: "normal",
    musicStyle: "enhanced", musicVolume: 0.6, sfxVolume: 0.8, hitSfx: true,
  };
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (!saved) return fallback;
    return { ...fallback, ...saved, keys: { ...fallback.keys, ...saved.keys } };
  } catch {
    return fallback;
  }
}

let current = load();

export const settings = {
  get: () => current,
  update(patch: Partial<Settings>) {
    current = { ...current, ...patch };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
    } catch {
      // 隐私模式等情况下存不了，本次仍然生效
    }
    listeners.forEach((f) => f());
  },
  onChange(f: () => void) {
    listeners.add(f);
  },
  // 按键 → 功能
  actionFor(code: string): BindAction | undefined {
    return (Object.keys(current.keys) as BindAction[]).find((a) => current.keys[a].includes(code));
  },
};

// 把 code 绑到 action 的第 slot 个位置。如果别的功能已经用了这个键，就把这个位置原来的键换给它
export function bindKey(action: BindAction, slot: 0 | 1, code: string | null): BindAction | null {
  const keys = structuredClone(current.keys);
  const old = keys[action][slot];
  let swapped: BindAction | null = null;
  if (code) {
    for (const a of Object.keys(keys) as BindAction[]) {
      const i = keys[a].indexOf(code);
      if (i >= 0 && !(a === action && i === slot)) {
        keys[a][i] = a === action ? null : old;
        if (a !== action) swapped = a;
      }
    }
  }
  keys[action][slot] = code;
  settings.update({ keys });
  return swapped;
}

const KEY_NAMES: Record<string, string> = {
  ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→",
  Space: "空格", Enter: "Enter", Escape: "Esc", Backspace: "退格", Tab: "Tab",
  ShiftLeft: "左 Shift", ShiftRight: "右 Shift", ControlLeft: "左 Ctrl", ControlRight: "右 Ctrl",
  AltLeft: "左 Alt", AltRight: "右 Alt", MetaLeft: "左 ⌘", MetaRight: "右 ⌘",
  Equal: "=", Minus: "-", NumpadAdd: "小键盘 +", NumpadSubtract: "小键盘 -",
  BracketLeft: "[", BracketRight: "]", Semicolon: ";", Quote: "'", Comma: ",", Period: ".", Slash: "/", Backslash: "\\",
};

export function keyName(code: string | null): string {
  if (!code) return "—";
  return KEY_NAMES[code] ?? code.replace(/^Key/, "").replace(/^Digit/, "").replace(/^Numpad/, "小键盘 ");
}

// 底部提示用：这个功能的主键（没有就用副键）
export function keyLabel(action: BindAction): string {
  const [a, b] = current.keys[action];
  return keyName(a ?? b);
}
