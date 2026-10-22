// 设置窗口：鼠标开关、按键绑定。可以用鼠标点，也可以全程用键盘：
//   ↑↓←→ 移动焦点，Enter / 空格 开始改键或切换开关，改键时按下新键完成，Esc 取消，Delete 清空这个位置。
import { BIND_ACTIONS, DEFAULT_KEYS, MUSIC_STYLES, TEXT_SPEEDS, VOLUMES, bindKey, keyName, settings, volumeLabel, type BindAction, ART_STYLES, BATTLE_STYLES } from "./settings.ts";

export class SettingsPanel {
  private dialog = document.getElementById("settings") as HTMLDialogElement;
  private listening: { action: BindAction; slot: 0 | 1 } | null = null;
  private onClose: () => void = () => {};

  constructor() {
    this.dialog.addEventListener("keydown", (e) => this.keyDown(e));
    this.dialog.addEventListener("cancel", (e) => {
      // 改键时 Esc 只取消改键，不关窗口
      if (this.listening) { e.preventDefault(); this.stopListening(); }
    });
    this.dialog.addEventListener("close", () => this.onClose());
  }

  get isOpen() {
    return this.dialog.open;
  }

  open(onClose: () => void) {
    this.onClose = onClose;
    this.render();
    this.dialog.showModal();
    (this.dialog.querySelector("[data-nav]") as HTMLElement | null)?.focus();
  }

  private render() {
    const s = settings.get();
    let group = "";
    const rows = BIND_ACTIONS.map(({ id, label, group: g }) => {
      const head = g !== group ? `<div class="set-group">${(group = g)}</div>` : "";
      const slot = (i: 0 | 1) => {
        const on = this.listening?.action === id && this.listening.slot === i;
        return `<button class="key${on ? " listening" : ""}" data-nav data-action="${id}" data-slot="${i}">${on ? "按下新按键…" : keyName(s.keys[id][i])}</button>`;
      };
      return `${head}<div class="set-row"><span>${label}</span>${slot(0)}${slot(1)}</div>`;
    }).join("");

    this.dialog.innerHTML = `
      <header><b>设置</b><button class="close" data-nav aria-label="关闭">✕</button></header>
      <section>
        <div class="set-group">鼠标</div>
        <label class="set-row toggle"><span>鼠标操作<small>关闭后地图上的悬停、点击、右键和滚轮都不起作用</small></span>
          <button class="switch${s.mouse ? " on" : ""}" data-nav data-toggle="mouse" role="switch" aria-checked="${s.mouse}"><i></i></button>
        </label>
        <div class="set-group">画面</div>
        <div class="set-row toggle"><span>画面风格<small>平滑放大：用像素画放大算法让斜线和边缘更圆滑</small></span>
          <button class="cycle" data-nav data-cycle="artStyle">${ART_STYLES.find((a) => a.id === s.artStyle)?.label}</button>
        </div>
        <div class="set-row toggle"><span>战斗演出<small>完整：原版战斗画面和武器特效；简略：在地图上快速结算</small></span>
          <button class="cycle" data-nav data-cycle="battleStyle">${BATTLE_STYLES.find((b) => b.id === s.battleStyle)?.label}</button>
        </div>
        <label class="set-row toggle"><span>飞行演出<small>选中时起飞悬停，移动时引擎加速、到达后缓缓降落；关闭为原版的跳动和匀速移动</small></span>
          <button class="switch${s.flight ? " on" : ""}" data-nav data-toggle="flight" role="switch" aria-checked="${s.flight}"><i></i></button>
        </label>
        <div class="set-group">成长</div>
        <label class="set-row toggle"><span>特性成长<small>驾驶员到 Lv 10 / 20 / 30 时机师特性强化一档</small></span>
          <button class="switch${s.traitGrowth ? " on" : ""}" data-nav data-toggle="traitGrowth" role="switch" aria-checked="${s.traitGrowth}"><i></i></button>
        </label>
        <label class="set-row toggle"><span>击破连击<small>同一阶段里连续击破，每多一次经验 +10%（最多 +50%）</small></span>
          <button class="switch${s.killCombo ? " on" : ""}" data-nav data-toggle="killCombo" role="switch" aria-checked="${s.killCombo}"><i></i></button>
        </label>
        <div class="set-group">剧情</div>
        <div class="set-row toggle"><span>文字速度<small>对话逐字显示的速度</small></span>
          <button class="cycle" data-nav data-cycle="textSpeed">${TEXT_SPEEDS.find((t) => t.id === s.textSpeed)?.label}</button>
        </div>
        <div class="set-group">声音</div>
        <div class="set-row toggle"><span>音乐版本<small>增强版：原版乐谱重新合成的立体声；原版：FC 原声录音</small></span>
          <button class="cycle" data-nav data-cycle="musicStyle">${MUSIC_STYLES.find((m) => m.id === s.musicStyle)?.label}</button>
        </div>
        <div class="set-row toggle"><span>音乐音量</span>
          <button class="cycle" data-nav data-cycle="musicVolume">${volumeLabel(s.musicVolume)}</button>
        </div>
        <div class="set-row toggle"><span>音效音量</span>
          <button class="cycle" data-nav data-cycle="sfxVolume">${volumeLabel(s.sfxVolume)}</button>
        </div>
        <div class="set-cols"><span></span><small>主键</small><small>副键</small></div>
        ${rows}
        <p class="set-hint">点按键框（或用方向键选中后按 Enter），再按下新的键。和其他功能冲突时会互换。Delete 清空，Esc 取消。</p>
        <button class="reset" data-nav>恢复默认按键</button>
      </section>`;

    this.dialog.querySelector(".close")!.addEventListener("click", () => this.dialog.close());
    this.dialog.querySelector(".reset")!.addEventListener("click", () => {
      settings.update({ keys: structuredClone(DEFAULT_KEYS) });
      this.render();
      this.focus(".reset");
    });
    this.dialog.querySelector("[data-toggle=mouse]")!.addEventListener("click", (e) => {
      e.preventDefault();
      settings.update({ mouse: !settings.get().mouse });
      this.render();
      this.focus("[data-toggle=mouse]");
    });
    for (const key of ["flight", "traitGrowth", "killCombo"] as const) {
      this.dialog.querySelector(`[data-toggle=${key}]`)!.addEventListener("click", (e) => {
        e.preventDefault();
        settings.update({ [key]: !settings.get()[key] });
        this.render();
        this.focus(`[data-toggle=${key}]`);
      });
    }
    this.dialog.querySelector("[data-cycle=artStyle]")!.addEventListener("click", () => {
      const i = ART_STYLES.findIndex((a) => a.id === settings.get().artStyle);
      settings.update({ artStyle: ART_STYLES[(i + 1) % ART_STYLES.length].id });
      this.render();
      this.focus("[data-cycle=artStyle]");
    });
    this.dialog.querySelector("[data-cycle=battleStyle]")!.addEventListener("click", () => {
      const i = BATTLE_STYLES.findIndex((b) => b.id === settings.get().battleStyle);
      settings.update({ battleStyle: BATTLE_STYLES[(i + 1) % BATTLE_STYLES.length].id });
      this.render();
      this.focus("[data-cycle=battleStyle]");
    });
    this.dialog.querySelector("[data-cycle=textSpeed]")!.addEventListener("click", () => {
      const i = TEXT_SPEEDS.findIndex((t) => t.id === settings.get().textSpeed);
      settings.update({ textSpeed: TEXT_SPEEDS[(i + 1) % TEXT_SPEEDS.length].id });
      this.render();
      this.focus("[data-cycle=textSpeed]");
    });
    this.dialog.querySelector("[data-cycle=musicStyle]")!.addEventListener("click", () => {
      const i = MUSIC_STYLES.findIndex((m) => m.id === settings.get().musicStyle);
      settings.update({ musicStyle: MUSIC_STYLES[(i + 1) % MUSIC_STYLES.length].id });
      this.render();
      this.focus("[data-cycle=musicStyle]");
    });
    for (const key of ["musicVolume", "sfxVolume"] as const) {
      this.dialog.querySelector(`[data-cycle=${key}]`)!.addEventListener("click", () => {
        const i = VOLUMES.indexOf(settings.get()[key]);
        settings.update({ [key]: VOLUMES[(i + 1) % VOLUMES.length] });
        this.render();
        this.focus(`[data-cycle=${key}]`);
      });
    }
    this.dialog.querySelectorAll<HTMLButtonElement>("button.key").forEach((b) =>
      b.addEventListener("click", () => {
        this.listening = { action: b.dataset.action as BindAction, slot: Number(b.dataset.slot) as 0 | 1 };
        this.render();
        this.focusKey(this.listening.action, this.listening.slot);
      }),
    );
  }

  private keyDown(e: KeyboardEvent) {
    if (this.listening) {
      e.preventDefault();
      e.stopPropagation();
      if (e.code === "Escape") { this.stopListening(); return; }
      const { action, slot } = this.listening;
      const code = e.code === "Delete" ? null : e.code;
      this.listening = null;
      const swapped = bindKey(action, slot, code);
      this.render();
      this.focusKey(action, slot);
      if (swapped) this.flash(swapped);
      return;
    }
    // 方向键在可选项之间移动焦点：上下按行，左右在同一行的两个按键之间
    const nav = [...this.dialog.querySelectorAll<HTMLElement>("[data-nav]")];
    const i = nav.indexOf(document.activeElement as HTMLElement);
    const move = (to: number) => { e.preventDefault(); nav[Math.max(0, Math.min(nav.length - 1, to))]?.focus(); };
    const cur = nav[i];
    // 玩家自己绑定的确定、取消、方向键在窗口里也能用
    const bound = settings.actionFor(e.code);
    if (bound === "confirm" && e.code !== "Enter" && e.code !== "Space") { e.preventDefault(); cur?.click(); return; }
    if (bound === "cancel" && e.code !== "Escape") { e.preventDefault(); this.dialog.close(); return; }
    const arrows: Partial<Record<BindAction, string>> = { up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight" };
    const code = (bound && arrows[bound]) || e.code;
    switch (code) {
      case "ArrowDown":
        return move(this.vertical(nav, i, 1));
      case "ArrowUp":
        return move(this.vertical(nav, i, -1));
      case "ArrowRight":
        return move(cur?.dataset.slot === "0" ? i + 1 : i);
      case "ArrowLeft":
        return move(cur?.dataset.slot === "1" ? i - 1 : i);
    }
  }

  // 上下移动：按键格停在同一列（主键 / 副键），遇到开关、按钮这类单独一行的就停在它上面
  private vertical(nav: HTMLElement[], i: number, dir: 1 | -1) {
    const slot = nav[i]?.dataset.slot;
    for (let j = i + dir; j >= 0 && j < nav.length; j += dir) {
      const s = nav[j].dataset.slot;
      if (s === undefined || slot === undefined || s === slot) return j;
    }
    return i;
  }

  private stopListening() {
    const l = this.listening;
    this.listening = null;
    this.render();
    if (l) this.focusKey(l.action, l.slot);
  }

  private focus(sel: string) {
    (this.dialog.querySelector(sel) as HTMLElement | null)?.focus();
  }

  private focusKey(action: BindAction, slot: number) {
    this.focus(`button.key[data-action="${action}"][data-slot="${slot}"]`);
  }

  // 被互换了按键的功能闪一下，提示玩家
  private flash(action: BindAction) {
    this.dialog.querySelectorAll(`button.key[data-action="${action}"]`).forEach((b) => {
      b.classList.add("swapped");
      setTimeout(() => b.classList.remove("swapped"), 900);
    });
  }
}
