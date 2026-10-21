// 播放器设置：按键绑定和画面选项，存在 localStorage。
const STORAGE_KEY = "srw2:settings";

// 手柄按键和播放器功能键，顺序就是设置界面里的显示顺序
export const ACTIONS = [
  { id: "up", label: "上" },
  { id: "down", label: "下" },
  { id: "left", label: "左" },
  { id: "right", label: "右" },
  { id: "a", label: "A（确定）" },
  { id: "b", label: "B（取消）" },
  { id: "start", label: "Start" },
  { id: "select", label: "Select" },
  { id: "fast", label: "加速" },
  { id: "fullscreen", label: "全屏" },
];

export const DEFAULTS = {
  keys: {
    up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight",
    a: "KeyX", b: "KeyZ", start: "Enter", select: "ShiftRight",
    fast: "Space", fullscreen: "KeyF",
  },
  fastSpeed: 4,
  fastMode: "hold", // hold：按住加速；toggle：按一下开关
  scale: "fit", // fit：铺满；integer：整数倍放大，像素最整齐
  aspect: "tv", // tv：4:3 电视比例；square：像素 1:1
  smoothing: false,
  showFps: false,
};

export function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    return { ...DEFAULTS, ...saved, keys: { ...DEFAULTS.keys, ...saved.keys } };
  } catch {
    return structuredClone(DEFAULTS);
  }
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // 隐私模式等情况下存不了，本次会话内仍然生效
  }
}

const KEY_NAMES = {
  ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→",
  Space: "空格", Enter: "Enter", Escape: "Esc", Backspace: "退格", Tab: "Tab",
  ShiftLeft: "左 Shift", ShiftRight: "右 Shift", ControlLeft: "左 Ctrl", ControlRight: "右 Ctrl",
  AltLeft: "左 Alt", AltRight: "右 Alt", MetaLeft: "左 ⌘", MetaRight: "右 ⌘",
};

export function keyName(code) {
  if (!code) return "未设置";
  if (KEY_NAMES[code]) return KEY_NAMES[code];
  return code.replace(/^Key/, "").replace(/^Digit/, "").replace(/^Numpad/, "小键盘 ");
}
