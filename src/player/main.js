import { NES, Controller } from "jsnes";
import Speakers from "../../node_modules/jsnes/src/browser/speakers.js";
import "../emu/waixing-mmc3.js";
import * as storage from "./storage.js";

const FPS = 60.0988;
const FAST_SPEED = 4;
const SLOT_COUNT = 4;
const KEYS = {
  ArrowUp: Controller.BUTTON_UP, ArrowDown: Controller.BUTTON_DOWN,
  ArrowLeft: Controller.BUTTON_LEFT, ArrowRight: Controller.BUTTON_RIGHT,
  KeyX: Controller.BUTTON_A, KeyZ: Controller.BUTTON_B,
  Enter: Controller.BUTTON_START, ShiftLeft: Controller.BUTTON_SELECT, ShiftRight: Controller.BUTTON_SELECT,
};

const canvas = document.getElementById("screen");
const ctx = canvas.getContext("2d");
const image = ctx.createImageData(256, 240);
const pixels = new Uint32Array(image.data.buffer);
const statusEl = document.getElementById("status");
const speedEl = document.getElementById("speed");

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

function status(text) { statusEl.textContent = text; }

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
const slotsEl = document.getElementById("slots");
const slotEls = [];
for (let i = 1; i <= SLOT_COUNT; i++) {
  const el = document.createElement("div");
  el.className = "slot";
  el.innerHTML = `<div>${i} 号位</div><img alt="" hidden><div class="row"><button data-act="save">存</button><button data-act="load" disabled>读</button></div>`;
  el.querySelector('[data-act="save"]').onclick = () => saveState(i);
  el.querySelector('[data-act="load"]').onclick = () => loadState(i);
  slotsEl.append(el);
  slotEls[i] = el;
}

async function refreshSlot(i) {
  const meta = await storage.get(`slot${i}:meta`);
  const el = slotEls[i];
  const img = el.querySelector("img");
  img.hidden = !meta;
  if (meta) img.src = meta.thumb;
  el.querySelector('[data-act="load"]').disabled = !meta;
  el.firstChild.textContent = meta ? `${i} 号位 · ${new Date(meta.time).toLocaleString()}` : `${i} 号位`;
}

async function saveState(i) {
  await storage.set(`slot${i}`, JSON.stringify(nes.toJSON()));
  await storage.set(`slot${i}:meta`, { time: Date.now(), thumb: canvas.toDataURL() });
  refreshSlot(i);
  status(`已存到 ${i} 号位`);
}

async function loadState(i) {
  const data = await storage.get(`slot${i}`);
  if (!data) return status(`${i} 号位是空的`);
  nes.fromJSON(JSON.parse(data));
  status(`已读取 ${i} 号位`);
}

// ---------- 输入 ----------
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

document.addEventListener("keydown", (e) => {
  if (e.code in KEYS) {
    const btn = KEYS[e.code];
    if (!e.repeat) { nes.buttonDown(1, btn); pressedAt.set(btn, frameCount); pendingRelease.delete(btn); }
    e.preventDefault();
    return;
  }
  if (e.code === "Space") { fast = true; e.preventDefault(); return; }
  const fn = e.code.match(/^F([1-4])$/);
  if (fn) { saveState(Number(fn[1])); e.preventDefault(); return; }
  const digit = e.code.match(/^Digit([1-4])$/);
  if (digit) loadState(Number(digit[1]));
});
document.addEventListener("keyup", (e) => {
  if (e.code in KEYS) { pendingRelease.add(KEYS[e.code]); releaseDue(); }
  if (e.code === "Space") fast = false;
});

// ---------- 主循环 ----------
let last = performance.now();
let acc = 0;
function loop(now) {
  acc += Math.min(now - last, 100) / (1000 / FPS);
  last = now;
  const speed = fast ? FAST_SPEED : 1;
  let ran = 0;
  while (acc >= 1) {
    for (let s = 0; s < speed; s++) { nes.frame(); frameCount++; releaseDue(); }
    acc -= 1;
    ran++;
  }
  if (ran) {
    speakers.flush();
    ctx.putImageData(image, 0, 0);
  }
  speedEl.textContent = fast ? `${FAST_SPEED}× 加速` : "";
  requestAnimationFrame(loop);
}

async function boot() {
  const res = await fetch("/rom/srw2.nes");
  if (!res.ok) return status("找不到 rom/srw2.nes");
  // 先建好 AudioContext 拿到真实采样率，loadROM 时 APU 会按这个采样率初始化
  await speakers.start();
  nes.opts.sampleRate = speakers.getSampleRate();
  nes.loadROM(new Uint8Array(await res.arrayBuffer()));
  await restoreSram();
  for (let i = 1; i <= SLOT_COUNT; i++) refreshSlot(i);
  status("运行中 · 点一下页面或按任意键开启声音");
  requestAnimationFrame(loop);
}

boot();
