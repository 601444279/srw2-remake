import { NES, Controller } from "jsnes";
import "../emu/waixing-mmc3.js";
import * as storage from "./storage.js";
import { AudioOutput } from "./audio.js";
import { ACTIONS, DEFAULTS, loadSettings, saveSettings, keyName } from "./settings.js";

const FPS = 60.0988;
const SLOT_COUNT = 4;
const NES_W = 256;
const NES_H = 240;
const BUTTONS = {
  up: Controller.BUTTON_UP, down: Controller.BUTTON_DOWN,
  left: Controller.BUTTON_LEFT, right: Controller.BUTTON_RIGHT,
  a: Controller.BUTTON_A, b: Controller.BUTTON_B,
  start: Controller.BUTTON_START, select: Controller.BUTTON_SELECT,
};

const $ = (sel) => document.querySelector(sel);
const canvas = $("#screen");
const ctx = canvas.getContext("2d");
const image = ctx.createImageData(NES_W, NES_H);
const pixels = new Uint32Array(image.data.buffer);
const menu = $("#menu");

let settings = loadSettings();
const audio = new AudioOutput();
let fast = false;
let sramDirty = false;

const nes = new NES({
  onFrame(buffer) {
    // jsnes 给的是 0xBBGGRR，正好是小端 Uint32 视图下 ImageData 的 RGBA 字节顺序
    for (let i = 0; i < pixels.length; i++) pixels[i] = 0xff000000 | buffer[i];
  },
  onAudioSample: (l, r) => { if (!fast) audio.write(l, r); },
  onBatteryRamWrite: () => { sramDirty = true; },
});

// 开发时方便在控制台里调试
if (import.meta.env.DEV) window.nes = nes;

let toastTimer;
function toast(text) {
  const el = $("#toast");
  el.textContent = text;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 1800);
}

function updateSettings(patch) {
  settings = { ...settings, ...patch };
  saveSettings(settings);
  applyDisplay();
}

// ---------- 画面 ----------
function applyDisplay() {
  const pixelAspect = settings.aspect === "tv" ? (4 / 3) / (NES_W / NES_H) : 1;
  const baseW = NES_W * pixelAspect;
  let scale = Math.min(innerWidth / baseW, innerHeight / NES_H);
  if (settings.scale === "integer") scale = Math.max(1, Math.floor(scale));
  canvas.style.width = `${Math.floor(baseW * scale)}px`;
  canvas.style.height = `${Math.floor(NES_H * scale)}px`;
  canvas.classList.toggle("smooth", settings.smoothing);
  $("#fps").hidden = !settings.showFps;
}
addEventListener("resize", applyDisplay);

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.();
}

// 鼠标动一下才显示菜单按钮，平时不挡画面
let pointerTimer;
addEventListener("pointermove", () => {
  document.body.classList.add("pointer-active");
  clearTimeout(pointerTimer);
  pointerTimer = setTimeout(() => document.body.classList.remove("pointer-active"), 2000);
});

// ---------- 游戏内存档（电池 SRAM）----------
async function restoreSram() {
  const sram = await storage.get("sram");
  if (sram) nes.cpu.mem.set(sram, 0x6000);
}
setInterval(() => {
  if (!sramDirty) return;
  sramDirty = false;
  storage.set("sram", nes.cpu.mem.slice(0x6000, 0x8000));
}, 2000);

// ---------- 即时存档 ----------
const slotEls = [];
for (let i = 1; i <= SLOT_COUNT; i++) {
  const el = document.createElement("div");
  el.className = "slot";
  el.innerHTML = `
    <div class="title">${i} 号位</div>
    <div class="thumb"><span>空</span></div>
    <div class="row"><button data-act="save">存档</button><button data-act="load" disabled>读档</button></div>`;
  el.querySelector('[data-act="save"]').onclick = () => saveState(i);
  el.querySelector('[data-act="load"]').onclick = async () => { await loadState(i); closeMenu(); };
  $("#slots").append(el);
  slotEls[i] = el;
}

async function refreshSlot(i) {
  const meta = await storage.get(`slot${i}:meta`);
  const el = slotEls[i];
  el.querySelector(".thumb").innerHTML = meta ? `<img alt="${i} 号位截图" src="${meta.thumb}">` : "<span>空</span>";
  el.querySelector('[data-act="load"]').disabled = !meta;
  el.querySelector(".title").textContent = meta ? `${i} 号位 · ${new Date(meta.time).toLocaleString()}` : `${i} 号位`;
}

async function saveState(i) {
  await storage.set(`slot${i}`, JSON.stringify(nes.toJSON()));
  await storage.set(`slot${i}:meta`, { time: Date.now(), thumb: canvas.toDataURL() });
  refreshSlot(i);
  toast(`已存到 ${i} 号位`);
}

async function loadState(i) {
  const data = await storage.get(`slot${i}`);
  if (!data) return toast(`${i} 号位是空的`);
  nes.fromJSON(JSON.parse(data));
  audio.clear();
  toast(`已读取 ${i} 号位`);
}

// ---------- 菜单 ----------
function openMenu() {
  releaseAll();
  fast = false;
  audio.suspend();
  menu.showModal();
}
function closeMenu() {
  stopListening();
  menu.close();
}
$("#menu-button").onclick = openMenu;
$("#menu-close").onclick = closeMenu;
menu.addEventListener("cancel", (e) => {
  // 正在等新按键时，Esc 只取消绑定，不关菜单
  if (listening) { e.preventDefault(); stopListening(); }
});
menu.addEventListener("close", () => { resumeAfterPause(); });

function resumeAfterPause() {
  last = performance.now();
  acc = 0;
  audio.clear();
  audio.resume();
}

// 切到别的标签页或最小化时暂停，回来再继续
document.addEventListener("visibilitychange", () => {
  if (document.hidden) { releaseAll(); fast = false; audio.suspend(); }
  else if (!menu.open) resumeAfterPause();
});

for (const tab of document.querySelectorAll("[data-tab]")) {
  tab.onclick = () => {
    stopListening();
    for (const t of document.querySelectorAll("[data-tab]")) t.classList.toggle("active", t === tab);
    for (const p of document.querySelectorAll("[data-panel]")) p.hidden = p.dataset.panel !== tab.dataset.tab;
  };
}

// ---------- 按键设置 ----------
let listening = null;

function renderBindings() {
  const root = $("#bindings");
  root.innerHTML = "";
  for (const { id, label } of ACTIONS) {
    const row = document.createElement("div");
    row.className = "binding";
    const btn = document.createElement("button");
    btn.textContent = listening === id ? "按下新按键…" : keyName(settings.keys[id]);
    btn.classList.toggle("listening", listening === id);
    btn.onclick = () => { listening = id; renderBindings(); };
    row.append(Object.assign(document.createElement("span"), { textContent: label }), btn);
    root.append(row);
  }
}

function stopListening() {
  if (!listening) return;
  listening = null;
  renderBindings();
}

function bind(action, code) {
  const keys = { ...settings.keys };
  const clash = Object.keys(keys).find((a) => a !== action && keys[a] === code);
  if (clash) keys[clash] = keys[action];
  keys[action] = code;
  updateSettings({ keys });
  if (clash) toast(`「${ACTIONS.find((a) => a.id === clash).label}」改成了 ${keyName(keys[clash])}`);
}

$("#reset-keys").onclick = () => {
  updateSettings({ keys: { ...DEFAULTS.keys } });
  renderBindings();
  toast("已恢复默认按键");
};

// ---------- 画面设置 ----------
function bindOption(sel, key, { type = "select", parse = (v) => v } = {}) {
  const el = $(sel);
  if (type === "checkbox") {
    el.checked = settings[key];
    el.onchange = () => updateSettings({ [key]: el.checked });
  } else {
    el.value = String(settings[key]);
    el.onchange = () => updateSettings({ [key]: parse(el.value) });
  }
}
bindOption("#opt-scale", "scale");
bindOption("#opt-aspect", "aspect");
bindOption("#opt-smoothing", "smoothing", { type: "checkbox" });
bindOption("#opt-fast-speed", "fastSpeed", { parse: Number });
bindOption("#opt-fast-mode", "fastMode");
bindOption("#opt-fps", "showFps", { type: "checkbox" });
bindOption("#opt-diagonal", "diagonal", { type: "checkbox" });
$("#fullscreen").onclick = toggleFullscreen;

// ---------- 游戏输入 ----------
// 键盘事件只记录“哪些键按着”，每帧开始前再决定把哪些按键交给游戏：
//   1. 游戏每帧只读一次手柄，按下和松开落在同一帧之间会被漏掉，所以每次按键至少保持几帧
//   2. 原版不支持斜向移动（同时按两个方向只认一个），开启斜向辅助后交替送出两个方向
const MIN_HOLD_FRAMES = 3;
const CURSOR_X = 0xc0; // 大地图光标坐标在内存里的位置
const CURSOR_Y = 0xc1;
let frameCount = 0;
const held = new Set();
const pressedAt = new Map();
const presented = new Set();
let diagonalAxis = "x";
let lastCursor = "";

function logicalButtons() {
  const out = new Set(held);
  for (const [btn, at] of pressedAt) if (frameCount - at < MIN_HOLD_FRAMES) out.add(btn);
  return out;
}

function applyInputs() {
  const want = logicalButtons();
  const horizontal = [BUTTONS.left, BUTTONS.right].find((b) => want.has(b));
  const vertical = [BUTTONS.up, BUTTONS.down].find((b) => want.has(b));
  if (settings.diagonal && horizontal !== undefined && vertical !== undefined) {
    want.delete(diagonalAxis === "x" ? vertical : horizontal);
  }
  for (const btn of presented) if (!want.has(btn)) { nes.buttonUp(1, btn); presented.delete(btn); }
  for (const btn of want) if (!presented.has(btn)) { nes.buttonDown(1, btn); presented.add(btn); }
}

// 光标真的走了一格，才换另一个方向，这样和游戏读按键的节拍对得上
function trackDiagonal() {
  const mem = nes.cpu.mem;
  const cursor = `${mem[CURSOR_X]},${mem[CURSOR_Y]}`;
  if (cursor !== lastCursor) {
    diagonalAxis = diagonalAxis === "x" ? "y" : "x";
    lastCursor = cursor;
  }
}

function stepFrame() {
  applyInputs();
  nes.frame();
  frameCount++;
  trackDiagonal();
}

function releaseAll() {
  held.clear();
  pressedAt.clear();
  for (const btn of presented) nes.buttonUp(1, btn);
  presented.clear();
}

function actionFor(code) {
  return Object.keys(settings.keys).find((a) => settings.keys[a] === code);
}

document.addEventListener("keydown", (e) => {
  if (menu.open) {
    if (listening && e.code !== "Escape") {
      e.preventDefault();
      bind(listening, e.code);
      listening = null;
      renderBindings();
    }
    return;
  }
  if (e.code === "Escape") { openMenu(); return; }

  const action = actionFor(e.code);
  if (action in BUTTONS) {
    const btn = BUTTONS[action];
    if (!e.repeat) { held.add(btn); pressedAt.set(btn, frameCount); }
    e.preventDefault();
    return;
  }
  if (action === "fast") {
    if (settings.fastMode === "toggle") {
      if (!e.repeat) { fast = !fast; toast(fast ? `${settings.fastSpeed}× 加速` : "恢复正常速度"); }
    } else fast = true;
    e.preventDefault();
    return;
  }
  if (action === "fullscreen") { if (!e.repeat) toggleFullscreen(); return; }

  const fn = e.code.match(/^F([1-4])$/);
  if (fn) { saveState(Number(fn[1])); e.preventDefault(); return; }
  const digit = e.code.match(/^Digit([1-4])$/);
  if (digit) loadState(Number(digit[1]));
});

document.addEventListener("keyup", (e) => {
  const action = actionFor(e.code);
  if (action in BUTTONS) held.delete(BUTTONS[action]);
  if (action === "fast" && settings.fastMode === "hold") fast = false;
});

// ---------- 主循环 ----------
// FC 是 60.0988 帧，屏幕一般是 60Hz（或 120Hz），直接按时间累加会出现这次跑 0 帧、下次跑 2 帧的抖动。
// 累加值接近整数时直接对齐到整数，60Hz 屏幕上就是稳定的一刷一帧，速度差由音频那边微调吸收。
const FRAME_MS = 1000 / FPS;
const SNAP = 0.15;
let last = performance.now();
let acc = 0;
let fpsFrames = 0;
let fpsSince = performance.now();

function loop(now) {
  requestAnimationFrame(loop);
  if (menu.open || document.hidden) return;

  acc += Math.min(now - last, 100) / FRAME_MS;
  last = now;
  const nearest = Math.round(acc);
  if (nearest >= 1 && Math.abs(acc - nearest) < SNAP) acc = nearest;

  const speed = fast ? settings.fastSpeed : 1;
  let ran = 0;
  while (acc >= 1) {
    for (let s = 0; s < speed; s++) stepFrame();
    fpsFrames += speed;
    acc -= 1;
    ran++;
  }
  if (ran) {
    audio.flush();
    ctx.putImageData(image, 0, 0);
  }

  if (now - fpsSince >= 500) {
    const fps = Math.round((fpsFrames * 1000) / (now - fpsSince));
    $("#fps").textContent = `${fps} FPS${fast ? ` · ${settings.fastSpeed}× 加速` : ""}`;
    fpsFrames = 0;
    fpsSince = now;
  }
}

async function boot() {
  applyDisplay();
  renderBindings();
  const res = await fetch("/rom/srw2.nes");
  if (!res.ok) return toast("找不到 rom/srw2.nes");
  // 先建好 AudioContext 拿到真实采样率，loadROM 时 APU 会按这个采样率初始化
  await audio.start();
  nes.opts.sampleRate = audio.sampleRate;
  nes.loadROM(new Uint8Array(await res.arrayBuffer()));
  await restoreSram();
  for (let i = 1; i <= SLOT_COUNT; i++) refreshSlot(i);
  toast("按 Esc 打开菜单 · 点一下页面开启声音");
  requestAnimationFrame(loop);
}

boot();
