import { NES, Controller } from "jsnes";
import Speakers from "../../node_modules/jsnes/src/browser/speakers.js";
import "../emu/waixing-mmc3.js";
import * as storage from "./storage.js";
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
const speakers = new Speakers({ onBufferUnderrun: () => {} });
let fast = false;
let sramDirty = false;

const nes = new NES({
  onFrame(buffer) {
    // jsnes 给的是 0xBBGGRR，正好是小端 Uint32 视图下 ImageData 的 RGBA 字节顺序
    for (let i = 0; i < pixels.length; i++) pixels[i] = 0xff000000 | buffer[i];
  },
  onAudioSample: (l, r) => { if (!fast) speakers.writeSample(l, r); },
  onBatteryRamWrite: () => { sramDirty = true; },
});

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
  toast(`已读取 ${i} 号位`);
}

// ---------- 菜单 ----------
function openMenu() {
  releaseAll();
  fast = false;
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
menu.addEventListener("close", () => { last = performance.now(); });

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
$("#fullscreen").onclick = toggleFullscreen;

// ---------- 游戏输入 ----------
// 游戏每帧只读一次手柄，按下和松开落在同一帧之间会被漏掉，所以每次按键至少保持几帧
const MIN_HOLD_FRAMES = 3;
let frameCount = 0;
const pressedAt = new Map();
const pendingRelease = new Set();

function releaseDue() {
  for (const btn of pendingRelease) {
    if (frameCount - pressedAt.get(btn) >= MIN_HOLD_FRAMES) {
      nes.buttonUp(1, btn);
      pendingRelease.delete(btn);
    }
  }
}

function releaseAll() {
  for (const btn of Object.values(BUTTONS)) nes.buttonUp(1, btn);
  pendingRelease.clear();
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
    if (!e.repeat) { nes.buttonDown(1, btn); pressedAt.set(btn, frameCount); pendingRelease.delete(btn); }
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
  if (action in BUTTONS) { pendingRelease.add(BUTTONS[action]); releaseDue(); }
  if (action === "fast" && settings.fastMode === "hold") fast = false;
});

// ---------- 主循环 ----------
let last = performance.now();
let acc = 0;
let fpsFrames = 0;
let fpsSince = performance.now();

function loop(now) {
  requestAnimationFrame(loop);
  if (menu.open) return;

  acc += Math.min(now - last, 100) / (1000 / FPS);
  last = now;
  const speed = fast ? settings.fastSpeed : 1;
  let ran = 0;
  while (acc >= 1) {
    for (let s = 0; s < speed; s++) { nes.frame(); frameCount++; fpsFrames++; releaseDue(); }
    acc -= 1;
    ran++;
  }
  if (ran) {
    speakers.flush();
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
  await speakers.start();
  nes.opts.sampleRate = speakers.getSampleRate();
  nes.loadROM(new Uint8Array(await res.arrayBuffer()));
  await restoreSram();
  for (let i = 1; i <= SLOT_COUNT; i++) refreshSlot(i);
  toast("按 Esc 打开菜单 · 点一下页面开启声音");
  requestAnimationFrame(loop);
}

boot();
