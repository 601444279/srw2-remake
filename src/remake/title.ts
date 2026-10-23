// 标题画面和主菜单：原版的 logo（assets/original/title/logo.png，从标题画面截出来）、
// 原版标题音乐轮播（开机后放 5 号，每首约 50 秒淡出换下一首：5 → 2 → 0 → 1），星空背景。
// 浏览器在玩家第一次按键 / 点击之前不让网页出声，所以先是「按任意键进入」，按下后 logo 落下、音乐响起，
// 接着直接出主菜单：继续 / 新游戏 / 读档 / 设置。读档列表带存档截图。
// 返回玩家的选择；继续和读档由调用方整页重新载入。
import logoUrl from "../../assets/original/title/logo.png";
import type { Music } from "./music.ts";
import type { Sfx } from "./sfx.ts";
import { describeTime, listSaves, type SaveMeta, type SlotId } from "./saves.ts";
import { settings } from "./settings.ts";
import { smoothUrl } from "./upscale.ts";

export type TitleChoice = { kind: "new" } | { kind: "load"; slot: SlotId };

const PLAYLIST = [5, 2, 0, 1];
const SONG_SECONDS = 50;

interface Item { label: string; detail?: string; thumb?: string; disabled?: boolean; run: () => void }

export function showTitle(opts: { music: Music; sfx: Sfx; openSettings: () => void; settingsOpen: () => boolean }): Promise<TitleChoice> {
  const { music, sfx } = opts;
  const root = document.getElementById("title")!;
  root.hidden = false;
  root.innerHTML = `
    <canvas class="tt-stars"></canvas>
    <div class="tt-press">按任意键</div>
    <div class="tt-main" hidden>
      <img class="tt-logo" src="${logoUrl}" alt="第2次超级机器人大战">
      <div class="tt-sub">REMAKE</div>
      <div class="tt-menu" hidden></div>
    </div>`;
  const logo = root.querySelector(".tt-logo") as HTMLImageElement;
  if (settings.get().artStyle === "smooth") void smoothUrl(logoUrl).then((u) => (logo.src = u));
  const stopStars = stars(root.querySelector(".tt-stars") as HTMLCanvasElement);

  // 原版的标题音乐轮播（进入后才开始）
  let song = 0;
  let playlist = 0;

  const menuEl = root.querySelector(".tt-menu") as HTMLElement;
  const press = root.querySelector(".tt-press") as HTMLElement;
  let items: Item[] = [];
  let index = 0;
  let back: (() => void) | null = null;
  let started = false;

  return new Promise<TitleChoice>((resolve) => {
    const finish = (choice: TitleChoice) => {
      removeEventListener("keydown", onKey, true);
      clearInterval(playlist);
      stopStars();
      root.classList.add("out");
      setTimeout(() => { root.hidden = true; root.innerHTML = ""; root.classList.remove("out"); }, 400);
      resolve(choice);
    };

    const render = () => {
      menuEl.innerHTML = items.map((it, i) => `
        <button class="${i === index ? "on" : ""}" ${it.disabled ? "disabled" : ""} data-i="${i}">
          ${it.thumb ? `<img src="${it.thumb}" alt="">` : ""}
          <span class="label">${it.label}</span>${it.detail ? `<small>${it.detail}</small>` : ""}
        </button>`).join("");
      menuEl.querySelectorAll<HTMLButtonElement>("button").forEach((b) => {
        const i = Number(b.dataset.i);
        b.onpointerenter = () => { if (!items[i].disabled && index !== i) { index = i; render(); } };
        b.onclick = () => choose(i);
      });
    };
    const show = (list: Item[], onBack: (() => void) | null) => {
      items = list;
      back = onBack;
      index = Math.max(0, items.findIndex((i) => !i.disabled));
      render();
    };
    const choose = (i: number) => {
      const it = items[i];
      if (!it || it.disabled) return;
      sfx.ui("ok");
      it.run();
    };
    const move = (d: number) => {
      const n = items.length;
      let i = index;
      for (let k = 0; k < n; k++) { i = (i + d + n) % n; if (!items[i].disabled) break; }
      if (i !== index) { index = i; sfx.ui("move"); render(); }
    };

    const mainMenu = async () => {
      const saves = await listSaves();
      const latest = saves.reduce<SaveMeta | null>((a, b) => (!a || b.savedAt > a.savedAt ? b : a), null);
      show([
        { label: "继续", detail: latest ? `第${latest.stage}关 第${latest.turn}回合` : undefined, disabled: !latest, run: () => finish({ kind: "load", slot: latest!.slot }) },
        { label: "新游戏", run: () => finish({ kind: "new" }) },
        { label: "读档", disabled: !saves.length, run: () => loadMenu(saves) },
        { label: "设置", run: () => opts.openSettings() },
      ], null);
    };
    const loadMenu = (saves: SaveMeta[]) => {
      show(saves.map((m) => ({
        label: m.slot === "auto" ? "自动存档" : `存档 ${m.slot}`,
        detail: `第${m.stage}关 第${m.turn}回合 · ${describeTime(m.savedAt)}`,
        thumb: m.thumb || undefined,
        run: () => finish({ kind: "load", slot: m.slot }),
      })), () => void mainMenu());
    };

    const start = () => {
      if (started) return;
      started = true;
      press.hidden = true;
      (root.querySelector(".tt-main") as HTMLElement).hidden = false;
      music.play(PLAYLIST[0]);
      playlist = window.setInterval(() => {
        song = (song + 1) % PLAYLIST.length;
        music.play(PLAYLIST[song]);
      }, SONG_SECONDS * 1000);
      // logo 落下之后出菜单
      setTimeout(() => { menuEl.hidden = false; void mainMenu(); }, 1100);
    };

    // 自己处理按键（游戏的输入在标题画面期间暂停，见 main.ts）
    const onKey = (e: KeyboardEvent) => {
      if (opts.settingsOpen()) return;
      const a = settings.actionFor(e.code);
      if (!started) {
        if (e.repeat || e.code.startsWith("Shift") || e.code.startsWith("Meta") || e.code.startsWith("Control") || e.code.startsWith("Alt")) return;
        e.preventDefault();
        start();
        return;
      }
      if (!a) return;
      e.preventDefault();
      if (a === "up") move(-1);
      else if (a === "down") move(1);
      else if (a === "confirm" && !e.repeat) choose(index);
      else if (a === "cancel" && back) { sfx.ui("move"); back(); }
      else if (a === "settings") opts.openSettings();
    };
    addEventListener("keydown", onKey, true);
    root.onclick = () => { if (!started) start(); };
  });
}

// 星空：慢慢往下飘的星星，远的暗、近的亮
function stars(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext("2d")!;
  const list = Array.from({ length: 140 }, () => ({ x: Math.random(), y: Math.random(), z: Math.random() }));
  let raf = 0, last = performance.now();
  const frame = (now: number) => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    const w = (canvas.width = canvas.clientWidth * devicePixelRatio);
    const h = (canvas.height = canvas.clientHeight * devicePixelRatio);
    ctx.clearRect(0, 0, w, h);
    for (const s of list) {
      s.y += dt * (0.01 + s.z * 0.04);
      if (s.y > 1) { s.y = 0; s.x = Math.random(); }
      const size = Math.max(1, Math.round((0.5 + s.z * 1.8) * devicePixelRatio));
      ctx.globalAlpha = 0.25 + s.z * 0.75;
      ctx.fillStyle = s.z > 0.85 ? "#ffe9a8" : "#cfd8ff";
      ctx.fillRect(Math.round(s.x * w), Math.round(s.y * h), size, size);
    }
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);
  return () => cancelAnimationFrame(raf);
}
