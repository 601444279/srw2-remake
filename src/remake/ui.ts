// 界面：顶栏、信息面板、菜单、回合横幅、按键提示。都是叠在地图上的 HTML，不切换画面。
import { TYPE_LABEL, type Unit, type Weapon } from "./data.ts";
import type { Forecast, BattleEvent } from "./rules.ts";

export interface MenuItem {
  label: string;
  // 右侧的短信息（例如消耗、SP）
  detail?: string;
  // 第二行的说明
  hint?: string;
  disabled?: boolean;
  run(): void;
}

export interface TerrainInfo {
  name: string;
  evade: number;
  sea: boolean;
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

  showInfo(unit: Unit | null, iconUrl: string, terrain: TerrainInfo | null) {
    const el = $("#info");
    if (!unit && !terrain) { el.hidden = true; return; }
    el.hidden = false;
    let html = "";
    if (unit) {
      const ratio = Math.max(0, unit.hp / unit.maxHp);
      // 原版状态画面显示的火力 = 武器火力 + 机体强度
      const fire = (p: number | null) => (p === null ? "—" : String(p + unit.strength));
      const weapons = unit.weapons.map((w) => `
        <tr><td>${w.name}</td><td>${w.range}</td><td>${w.hit}</td><td>${fire(w.power.air)}</td><td>${fire(w.power.land)}</td><td>${fire(w.power.sea)}</td></tr>`).join("");
      const spirits = unit.spirits.length
        ? `<div class="spirits">${unit.spirits.map((s) => `<span title="${s.text}" class="${s.cost > unit.sp ? "off" : ""}">${s.name}<i>${s.cost}</i></span>`).join("")}</div>`
        : "";
      html += `
        <div class="unit ${unit.side}">
          <img src="${iconUrl}" alt="">
          <div class="body">
            <div class="name">${unit.name}<span class="tag">${TYPE_LABEL[unit.moveType]}</span><span class="tag">Lv ${unit.level}</span>${unit.acted ? '<span class="tag">已行动</span>' : ""}</div>
            ${unit.pilotName ? `<div class="pilot"><span>驾驶员 ${unit.pilotName}${unit.trait ? `<em class="trait" title="${unit.trait.text}">${unit.trait.name}</em>` : ""}</span>${unit.maxSp ? `<span>SP ${unit.sp} / ${unit.maxSp}</span>` : ""}</div>` : ""}
            ${unit.trait ? `<div class="trait-text">${unit.trait.name}：${unit.trait.text}</div>` : ""}
            <div class="hp"><div class="bar"><i style="width:${ratio * 100}%"></i></div><span>${unit.hp} / ${unit.maxHp}</span></div>
            <div class="stats">
              <span>机动 <b>${unit.move}</b></span><span>强度 <b>${unit.strength}</b></span>
              <span>防卫 <b>${unit.defense}</b></span><span>速度 <b>${unit.speed}</b></span>
            </div>
          </div>
        </div>
        <table class="weapons"><tr><th>武器</th><th>射程</th><th>命中</th><th>空</th><th>陆</th><th>海</th></tr>${weapons}</table>
        ${spirits}`;
    }
    if (terrain) {
      const costs = terrain.costs.map((c) => `${c.label} ${c.cost === 0 ? "×" : c.cost}`).join(" · ");
      const evade = terrain.evade ? `回避 +${terrain.evade}%` : "无地形效果";
      html += `<div class="terrain"><b>${terrain.name}</b><span>${evade}${terrain.sea ? " · 算作海上" : ""}</span><span class="muted">移动消耗 ${costs}</span></div>`;
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
      b.innerHTML = `<span class="label">${item.label}</span>${item.detail ? `<span class="detail">${item.detail}</span>` : ""}${item.hint ? `<small>${item.hint}</small>` : ""}`;
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

  // ---------- 攻击预测 ----------
  showForecast(atk: Unit, atkIcon: string, def: Unit, defIcon: string, weapon: Weapon, f: Forecast) {
    const el = $("#forecast");
    const side = (u: Unit, icon: string, w: Weapon | null, s: { hit: number; damage: number; valid: boolean; lethal: boolean }, twice: boolean, other: Unit) => {
      const after = Math.max(0, other.hp - (s.valid ? s.damage * (twice ? 2 : 1) : 0));
      return `
        <div class="fc-side ${u.side}">
          <div class="fc-head"><img src="${icon}" alt=""><div><b>${u.name}</b><small>${u.pilotName}</small></div></div>
          <div class="fc-hp"><div class="bar"><i style="width:${(u.hp / u.maxHp) * 100}%"></i></div><span>${u.hp}</span></div>
          <div class="fc-weapon">${w ? w.name : "无法反击"}</div>
          ${s.valid ? `
          <div class="fc-nums">
            <div><small>命中</small><b>${s.hit}%</b></div>
            <div><small>伤害</small><b>${s.damage}${twice ? "<em>×2</em>" : ""}</b></div>
          </div>
          <div class="fc-result">${s.lethal || after === 0 ? '<span class="kill">可击破</span>' : `对方剩 ${after}`}</div>` : '<div class="fc-nums muted">—</div>'}
        </div>`;
    };
    el.innerHTML =
      side(atk, atkIcon, weapon, f.attack, f.extra === "attacker", def) +
      '<div class="fc-vs">VS</div>' +
      side(def, defIcon, f.counter.weapon, f.counter, f.extra === "defender", atk);
    el.hidden = false;
  }

  hideForecast() {
    $("#forecast").hidden = true;
  }

  // ---------- 战斗面板（简略演出，叠在地图上） ----------
  battleStart(atk: Unit, atkIcon: string, def: Unit, defIcon: string) {
    const el = $("#battle");
    const card = (u: Unit, icon: string, role: string) => `
      <div class="bt-side ${u.side}" data-unit="${u.id}">
        <img src="${icon}" alt="">
        <div class="bt-body">
          <div class="bt-name"><b>${u.name}</b><small>${role}</small></div>
          <div class="bt-hp"><div class="bar"><i style="width:${(u.hp / u.maxHp) * 100}%"></i></div><span>${u.hp} / ${u.maxHp}</span></div>
        </div>
        <div class="bt-pop"></div>
      </div>`;
    el.innerHTML = card(atk, atkIcon, "攻击") + card(def, defIcon, "防守") + '<div class="bt-weapon"></div>';
    el.hidden = false;
  }

  // 显示一次出手，duration 秒后完成
  battleStrike(e: BattleEvent, duration: number): Promise<void> {
    const el = $("#battle");
    el.querySelector(".bt-weapon")!.textContent = `${e.from.name}「${e.weapon.name}」`;
    const target = el.querySelector(`[data-unit="${e.to.id}"]`) as HTMLElement;
    const pop = target.querySelector(".bt-pop") as HTMLElement;
    pop.textContent = e.hit ? `-${e.damage}` : "未命中";
    pop.className = `bt-pop ${e.hit ? "hit" : "miss"}`;
    void pop.offsetWidth;
    pop.classList.add("show");
    if (e.hit) {
      target.classList.remove("shake");
      void target.offsetWidth;
      target.classList.add("shake");
      const bar = target.querySelector(".bt-hp i") as HTMLElement;
      bar.style.transitionDuration = `${duration * 0.6}s`;
      bar.style.width = `${(e.hpAfter / e.to.maxHp) * 100}%`;
      target.querySelector(".bt-hp span")!.textContent = `${e.hpAfter} / ${e.to.maxHp}`;
    }
    return new Promise((r) => setTimeout(r, duration * 1000));
  }

  battleEnd() {
    $("#battle").hidden = true;
  }

  // ---------- 结果 ----------
  showResult(win: boolean, lines: string[], onRetry: () => void) {
    const el = $("#result");
    el.innerHTML = `
      <div class="card">
        <div class="title ${win ? "win" : "lose"}">${win ? "胜利" : "失败"}</div>
        ${lines.map((l) => `<div class="line">${l}</div>`).join("")}
        <button>再玩一次</button>
      </div>`;
    el.querySelector("button")!.onclick = onRetry;
    el.hidden = false;
  }

  // ---------- 剧情对话 ----------
  private typing: { full: string; shown: number; timer: number } | null = null;

  // 显示一句台词，cps = 每秒字数（Infinity 表示瞬间显示）
  showLine(speaker: string, text: string, portrait: string | null, initial: string, cps: number) {
    const el = $("#dialog");
    el.hidden = false;
    el.querySelector(".dl-face")!.innerHTML = portrait
      ? `<img src="${portrait}" alt="">`
      : `<span>${initial}</span>`;
    (el.querySelector(".dl-face") as HTMLElement).classList.toggle("placeholder", !portrait);
    el.querySelector(".dl-name")!.textContent = speaker;
    el.classList.remove("done");
    const body = el.querySelector(".dl-text")!;
    if (this.typing) clearInterval(this.typing.timer);
    if (!Number.isFinite(cps)) {
      body.textContent = text;
      this.typing = null;
      el.classList.add("done");
      return;
    }
    const t = { full: text, shown: 0, timer: 0 };
    this.typing = t;
    body.textContent = "";
    t.timer = window.setInterval(() => {
      t.shown = Math.min(t.full.length, t.shown + 1);
      body.textContent = t.full.slice(0, t.shown);
      if (t.shown >= t.full.length) this.finishLine();
    }, 1000 / cps);
  }

  get lineDone() {
    return !this.typing;
  }

  // 字还没出完时按确定：直接显示整句
  finishLine() {
    const t = this.typing;
    if (!t) return;
    clearInterval(t.timer);
    $("#dialog").querySelector(".dl-text")!.textContent = t.full;
    $("#dialog").classList.add("done");
    this.typing = null;
  }

  hideDialog() {
    if (this.typing) clearInterval(this.typing.timer);
    this.typing = null;
    $("#dialog").hidden = true;
  }

  // 关卡标题卡，seconds 秒后自动消失（也可以提前关）
  titleCard(title: string, subtitle: string, seconds: number): { done: Promise<void>; skip: () => void } {
    const el = $("#title-card");
    el.innerHTML = `<div class="tc-title">${title}</div><div class="tc-sub">${subtitle}</div>`;
    el.hidden = false;
    el.classList.remove("show");
    void el.offsetWidth;
    el.classList.add("show");
    let skip = () => {};
    const done = new Promise<void>((resolve) => {
      const end = () => { clearTimeout(timer); el.hidden = true; resolve(); };
      const timer = setTimeout(end, seconds * 1000);
      skip = end;
    });
    return { done, skip };
  }

  toast(text: string) {
    const el = $("#toast");
    el.textContent = text;
    el.classList.add("show");
    clearTimeout(Number(el.dataset.timer));
    el.dataset.timer = String(setTimeout(() => el.classList.remove("show"), 1600));
  }
}
