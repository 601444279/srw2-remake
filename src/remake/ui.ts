// 界面：顶栏、信息面板、菜单、回合横幅、按键提示。都是叠在地图上的 HTML，不切换画面。
import type { Unit } from "./data.ts";

export interface MenuItem {
  label: string;
  hint?: string;
  disabled?: boolean;
  run(): void;
}

export interface TerrainInfo {
  name: string;
  defense: number;
  costs: { label: string; cost: number }[];
}

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

export class UI {
  private menuItems: MenuItem[] = [];
  private menuIndex = 0;
  private onMenuClose: (() => void) | null = null;

  setTurn(turn: number, phase: "player" | "enemy") {
    $("#turn").textContent = `第 ${turn} 回合`;
    const p = $("#phase");
    p.textContent = phase === "player" ? "我方回合" : "敌方回合";
    p.dataset.phase = phase;
  }

  setObjective(text: string) {
    $("#objective").textContent = text;
  }

  setHints(hints: [string, string][]) {
    $("#hints").innerHTML = hints.map(([k, v]) => `<span><kbd>${k}</kbd>${v}</span>`).join("");
  }

  showInfo(unit: Unit | null, terrain: TerrainInfo | null) {
    const el = $("#info");
    if (!unit && !terrain) { el.hidden = true; return; }
    el.hidden = false;
    let html = "";
    if (unit) {
      const ratio = Math.max(0, unit.hp / unit.maxHp);
      html += `
        <div class="unit ${unit.side}">
          <img src="${unit.iconUrl}" alt="">
          <div class="body">
            <div class="name">${unit.name}${unit.acted ? '<span class="tag">已行动</span>' : ""}</div>
            <div class="hp"><div class="bar"><i style="width:${ratio * 100}%"></i></div><span>${unit.hp} / ${unit.maxHp}</span></div>
            <div class="stats">
              <span>机动 <b>${unit.move}</b></span><span>强度 <b>${unit.strength}</b></span>
              <span>防卫 <b>${unit.defense}</b></span><span>速度 <b>${unit.speed}</b></span>
            </div>
          </div>
        </div>`;
    }
    if (terrain) {
      const costs = terrain.costs.map((c) => `${c.label} ${c.cost === 0 ? "×" : c.cost}`).join(" · ");
      html += `<div class="terrain"><b>${terrain.name}</b><span>防御 ${terrain.defense > 0 ? "+" : ""}${terrain.defense}%</span><span class="muted">移动消耗 ${costs}</span></div>`;
    }
    el.innerHTML = html;
  }

  // 菜单出现在屏幕坐标 (x, y) 旁边
  openMenu(items: MenuItem[], x: number, y: number, onClose: () => void) {
    this.menuItems = items;
    this.menuIndex = items.findIndex((i) => !i.disabled);
    this.onMenuClose = onClose;
    const el = $("#menu");
    el.innerHTML = "";
    items.forEach((item, i) => {
      const b = document.createElement("button");
      b.innerHTML = `${item.label}${item.hint ? `<small>${item.hint}</small>` : ""}`;
      b.disabled = !!item.disabled;
      b.onpointerenter = () => { if (!item.disabled) { this.menuIndex = i; this.renderMenuFocus(); } };
      b.onclick = () => this.choose(i);
      el.append(b);
    });
    el.hidden = false;
    const rect = el.getBoundingClientRect();
    el.style.left = `${Math.min(Math.max(8, x), innerWidth - rect.width - 8)}px`;
    el.style.top = `${Math.min(Math.max(56, y), innerHeight - rect.height - 8)}px`;
    this.renderMenuFocus();
  }

  get menuOpen() {
    return !$("#menu").hidden;
  }

  menuMove(dy: number) {
    if (!dy) return;
    const n = this.menuItems.length;
    let i = this.menuIndex;
    for (let step = 0; step < n; step++) {
      i = (i + dy + n) % n;
      if (!this.menuItems[i].disabled) break;
    }
    this.menuIndex = i;
    this.renderMenuFocus();
  }

  menuConfirm() {
    this.choose(this.menuIndex);
  }

  closeMenu(notify = true) {
    $("#menu").hidden = true;
    const cb = this.onMenuClose;
    this.onMenuClose = null;
    if (notify) cb?.();
  }

  private choose(i: number) {
    const item = this.menuItems[i];
    if (!item || item.disabled) return;
    this.closeMenu(false);
    item.run();
  }

  private renderMenuFocus() {
    [...$("#menu").children].forEach((b, i) => b.classList.toggle("focus", i === this.menuIndex));
  }

  // 回合横幅：滑入、停留、滑出，返回动画结束的 Promise
  banner(title: string, subtitle = "", tone: "player" | "enemy" | "neutral" = "neutral"): Promise<void> {
    const el = $("#banner");
    el.innerHTML = `<div class="title">${title}</div>${subtitle ? `<div class="sub">${subtitle}</div>` : ""}`;
    el.dataset.tone = tone;
    el.hidden = false;
    el.classList.remove("show");
    void el.offsetWidth;
    el.classList.add("show");
    return new Promise((resolve) => setTimeout(() => { el.hidden = true; resolve(); }, 1100));
  }

  toast(text: string) {
    const el = $("#toast");
    el.textContent = text;
    el.classList.add("show");
    clearTimeout(Number(el.dataset.timer));
    el.dataset.timer = String(setTimeout(() => el.classList.remove("show"), 1600));
  }
}
