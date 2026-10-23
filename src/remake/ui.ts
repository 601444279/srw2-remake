// 界面：顶栏、信息面板、菜单、回合横幅、按键提示。都是叠在地图上的 HTML，不切换画面。
import { TYPE_LABEL, type Unit, type Weapon } from "./data.ts";
import type { Forecast, BattleEvent } from "./rules.ts";
import { settings } from "./settings.ts";
import { smoothUrl } from "./upscale.ts";
import earthMapUrl from "../../assets/original/worldmap/map.png";
import spaceMapUrl from "../../assets/original/worldmap/space.png";
import americaMapUrl from "../../assets/original/worldmap/america.png";
import type { WorldMapName } from "./story.ts";

const worldMaps: Record<WorldMapName, string> = { earth: earthMapUrl, space: spaceMapUrl, america: americaMapUrl };
import { traitLabel, type Trait } from "./traits.ts";

export interface MenuItem {
  label: string;
  // 右侧的短信息（例如消耗、SP）
  detail?: string;
  // 第二行的说明
  hint?: string;
  disabled?: boolean;
  run(): void;
}

export interface StatusData {
  unit: Unit;
  iconUrl: string;
  sprite: string | null;
  portrait: string | null;
  expToNext: number | null;
  // 敌人没交过手时为 false：只显示外形、名字和类型
  known: boolean;
  tab: StatusTab;
  hasPilot: boolean;
}

export type StatusTab = "unit" | "pilot";

export interface GrowthStats { level: number; maxHp: number; maxSp: number; strength: number; defense: number; speed: number }
export interface GrowthData {
  unit: Unit;
  portrait: string | null;
  gained: number; // 这次得到的经验
  before: GrowthStats;
  after: GrowthStats;
  // 经验条：之前 / 之后在各自等级里的进度（0–1），之后满级时 null
  barBefore: number;
  barAfter: number | null;
  toNext: number | null;
  combo?: { count: number; bonus: number } | null;
  traitBefore?: Trait | null;
  traitAfter?: Trait | null;
}

export interface TerrainInfo {
  name: string;
  evade: number;
  sea: boolean;
  costs: { label: string; cost: number }[];
}

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

const UNKNOWN_TEXT = "尚未交战，资料不明";

export class UI {
  private menuItems: MenuItem[] = [];
  private menuIndex = 0;
  private onMenuClose: (() => void) | null = null;
  private menuArgs: { items: MenuItem[]; x: number; y: number; onClose: () => void; fromHud: boolean } | null = null;
  // 回合和胜利条件不常驻屏幕，显示在右上角菜单的顶部
  private turn = 1;
  private phase: "player" | "enemy" = "player";
  private objective = "";

  setTurn(turn: number, phase: "player" | "enemy") {
    this.turn = turn;
    this.phase = phase;
  }

  setObjective(text: string) {
    this.objective = text;
  }

  setHints(hints: [string, string][]) {
    $("#hints").innerHTML = hints.map(([k, v]) => `<span><kbd>${k}</kbd>${v}</span>`).join("");
  }

  showInfo(unit: Unit | null, iconUrl: string, known: boolean, terrain: TerrainInfo | null) {
    const el = $("#info");
    if (!unit && !terrain) { el.hidden = true; return; }
    el.hidden = false;
    let html = "";
    if (unit && !known) {
      html += `
        <div class="unit ${unit.side}">
          <img src="${iconUrl}" alt="">
          <div class="body">
            <div class="name">${unit.name}<span class="tag">${TYPE_LABEL[unit.moveType]}</span></div>
            <div class="muted">${UNKNOWN_TEXT}</div>
          </div>
        </div>`;
    } else if (unit) {
      // 简要资料：只放和战斗有关的能力。武器、驾驶员、精神、特性说明都在资料页
      const ratio = Math.max(0, unit.hp / unit.maxHp);
      html += `
        <div class="unit ${unit.side}">
          <img src="${iconUrl}" alt="">
          <div class="body">
            <div class="name"><span class="nm">${unit.name}</span><span class="lv">Lv ${unit.level}</span></div>
            <div class="tags"><span class="tag">${TYPE_LABEL[unit.moveType]}</span>${unit.trait ? `<em class="trait">${traitLabel(unit.trait)}</em>` : ""}${unit.acted ? '<span class="tag done">已行动</span>' : ""}</div>
          </div>
        </div>
        <div class="hp"><div class="bar"><i style="width:${ratio * 100}%"></i></div><span>${unit.hp}<small> / ${unit.maxHp}</small></span></div>
        <div class="stats">
          <span>机动<b>${unit.move}</b></span><span>强度<b>${unit.strength}</b></span>
          <span>防卫<b>${unit.defense}</b></span><span>速度<b>${unit.speed}</b></span>
        </div>`;
    }
    if (terrain) {
      const evade = terrain.evade ? `回避 +${terrain.evade}%` : "无地形效果";
      // 光标下有单位时只给地形效果；空格子才列移动消耗
      const costs = unit ? "" : `<span class="muted">移动消耗 ${terrain.costs.map((c) => `${c.label} ${c.cost === 0 ? "×" : c.cost}`).join(" · ")}</span>`;
      html += `<div class="terrain"><b>${terrain.name}</b><span>${evade}${terrain.sea ? " · 算作海上" : ""}</span>${costs}</div>`;
    }
    el.innerHTML = html;
  }

  // 资料页：同一个单位分两页。机体页：战斗大图、HP、能力、武器；驾驶员页：头像、等级经验、SP、特性、精神。
  // ←→ / Q E 或点上方标签切换
  showStatus(d: StatusData, on: { close(): void; tab(t: StatusTab): void }) {
    const { unit } = d;
    const el = $("#status");
    el.className = unit.side;
    const tabs = d.known && d.hasPilot
      ? `<div class="st-tabs">${(["unit", "pilot"] as const).map((t) => `<button data-tab="${t}" class="${d.tab === t ? "on" : ""}">${t === "unit" ? "机体" : "驾驶员"}</button>`).join("")}</div>`
      : "";
    const body = !d.known ? this.statusHead(d, false) : d.tab === "pilot" && d.hasPilot ? this.statusPilot(d) : this.statusUnit(d);
    el.innerHTML = `<div class="st-card"><button class="st-close" aria-label="关闭">✕</button>${tabs}${body}</div>`;
    el.hidden = false;
    (el.querySelector(".st-close") as HTMLElement).onclick = () => on.close();
    el.querySelectorAll<HTMLElement>(".st-tabs button").forEach((b) => (b.onclick = () => on.tab(b.dataset.tab as StatusTab)));
    el.onclick = (e) => { if (e.target === el) on.close(); };
    el.oncontextmenu = (e) => { e.preventDefault(); on.close(); };
    if (settings.get().artStyle === "smooth") {
      for (const img of el.querySelectorAll<HTMLImageElement>(".st-sprite img, .st-face img")) {
        const src = img.getAttribute("src")!;
        void smoothUrl(src).then((u) => { if (img.getAttribute("src") === src) img.src = u; });
      }
    }
  }

  // 机体大图 + 名字；known 为 false（没交过手的敌人）时只有这些
  private statusHead(d: StatusData, known: boolean) {
    const { unit } = d;
    const ratio = Math.max(0, unit.hp / unit.maxHp);
    return `
      <div class="st-head">
        <div class="st-sprite">${d.sprite ? `<img src="${d.sprite}" alt="">` : `<img class="icon" src="${d.iconUrl}" alt="">`}</div>
        <div class="st-main">
          <div class="st-name">${unit.name}<span class="tag">${TYPE_LABEL[unit.moveType]}</span>${known ? `<span class="tag">Lv ${unit.level}</span>` : ""}${unit.acted ? '<span class="tag">已行动</span>' : ""}</div>
          ${known ? `
          <div class="st-hp"><span>HP</span><div class="bar"><i style="width:${ratio * 100}%"></i></div><b>${unit.hp} / ${unit.maxHp}</b></div>
          <div class="st-stats">
            <span>机动<b>${unit.move}</b></span><span>强度<b>${unit.strength}</b></span>
            <span>防卫<b>${unit.defense}</b></span><span>速度<b>${unit.speed}</b></span>
          </div>` : `<div class="muted">${UNKNOWN_TEXT}</div>`}
        </div>
      </div>`;
  }

  private statusUnit(d: StatusData) {
    const { unit } = d;
    const fire = (p: number | null) => (p === null ? "—" : String(p + unit.strength));
    const weapons = unit.weapons.map((w) => `
      <tr><td>${w.name}</td><td>${w.range}</td><td>${w.hit}</td><td>${fire(w.power.air)}</td><td>${fire(w.power.land)}</td><td>${fire(w.power.sea)}</td><td>${w.usableAfterMove ? "○" : "—"}</td></tr>`).join("");
    return `${this.statusHead(d, true)}
      <table class="st-weapons"><tr><th>武器</th><th>射程</th><th>命中</th><th>空</th><th>陆</th><th>海</th><th>移动后</th></tr>${weapons || '<tr><td colspan="7" class="muted">没有武器</td></tr>'}</table>`;
  }

  private statusPilot(d: StatusData) {
    const { unit } = d;
    const exp = d.expToNext === null ? "已满级" : `下一级还需 ${d.expToNext}`;
    const spirits = unit.spirits.map((s) => `<li class="${s.cost > unit.sp ? "off" : ""}"><b>${s.name}</b><i>${s.cost}</i><span>${s.text}</span></li>`).join("");
    return `
      <div class="st-pilot">
        <div class="st-face">${d.portrait ? `<img src="${d.portrait}" alt="">` : `<span>${unit.pilotName.slice(0, 1)}</span>`}</div>
        <div class="st-pbody">
          <div class="st-pname">${unit.pilotName}<span class="tag">Lv ${unit.level}</span></div>
          ${unit.side === "player" ? `<div class="st-exp">经验 <b>${unit.exp}</b> · ${exp}</div>` : ""}
          ${unit.maxSp ? `<div class="st-sp">SP <b>${unit.sp} / ${unit.maxSp}</b></div>` : ""}
          <div class="muted">乘坐 ${unit.name}</div>
        </div>
      </div>
      ${unit.trait ? `<div class="st-trait"><div class="tt-head"><b>${traitLabel(unit.trait)}</b><small>特性</small></div><span>${unit.trait.text}</span></div>` : ""}
      ${spirits ? `<ul class="st-spirits">${spirits}</ul>` : ""}`;
  }

  hideStatus() {
    $("#status").hidden = true;
  }

  // 战斗后的成长卡片。没升级：小卡，经验条涨一截，自动消失。
  // 升级：大卡，像原版那样一项一项往上跳——经验条、等级，然后每项能力一点一点加上去，每跳一下「嘀」一声；
  // 最后是特性（强化了就高亮）。按确定：当前这一项立刻加完、接着下一项；全部完了再按关闭。sound 放界面音效
  showGrowth(d: GrowthData, speed: number, sound: (kind: "tick" | "ding") => void = () => {}): { done: Promise<void>; advance: () => void; close: () => void } {
    const el = $("#growth");
    const up = d.after.level > d.before.level;
    const rows: [string, keyof GrowthStats][] = [["最大 HP", "maxHp"], ["最大 SP", "maxSp"], ["强度", "strength"], ["防卫", "defense"], ["速度", "speed"]];
    const statRows = rows
      .filter(([, k]) => k !== "maxSp" || d.after.maxSp > 0)
      .map(([label, k]) => `<li data-from="${d.before[k]}" data-to="${d.after[k]}"><span>${label}</span><b>${d.before[k]}</b><em></em></li>`)
      .join("");
    const face = d.portrait ? `<img src="${d.portrait}" alt="">` : `<span>${(d.unit.pilotName || d.unit.name).slice(0, 1)}</span>`;
    el.className = up ? "big" : "small";
    el.style.setProperty("--speed", String(speed));
    el.innerHTML = `
      <div class="gr-card">
        ${up ? '<div class="gr-burst"></div><div class="gr-title">LEVEL UP!</div>' : ""}
        <div class="gr-head">
          <div class="gr-face">${face}</div>
          <div class="gr-who">
            <b>${d.unit.pilotName || d.unit.name}</b><small>${d.unit.name}</small>
            <div class="gr-level">Lv <span class="lv">${d.before.level}</span><em class="lvup"></em></div>
          </div>
          <div class="gr-exp">EXP <b>+${d.gained}</b>${d.combo ? `<span class="gr-combo">${d.combo.count} 连击 · +${d.combo.bonus}%</span>` : ""}</div>
        </div>
        <div class="gr-bar"><i style="width:${d.barBefore * 100}%"></i></div>
        <div class="gr-next">${d.toNext === null ? "已达到最高等级" : `下一级还需 ${d.toNext}`}</div>
        ${up ? `<ul class="gr-stats">${statRows}</ul><div class="gr-hint">按确定加快</div>` : ""}
      </div>`;
    el.hidden = false;
    const bar = el.querySelector(".gr-bar i") as HTMLElement;
    const hint = el.querySelector(".gr-hint");
    // rush：玩家按了确定，当前这一段立刻做完
    let rush = false, finished = !up, closed = false;
    const sleep = (s: number) => (rush || closed ? Promise.resolve() : new Promise<void>((r) => setTimeout(r, (s / speed) * 1000)));
    let resolveDone!: () => void;
    const done = new Promise<void>((r) => (resolveDone = r));
    const close = () => { if (closed) return; closed = true; el.hidden = true; el.innerHTML = ""; resolveDone(); };
    const advance = () => { if (finished) close(); else rush = true; };
    el.onclick = advance;

    const run = async () => {
      await sleep(0.15);
      if (!up) {
        bar.style.width = `${(d.barAfter ?? 1) * 100}%`;
        await sleep(1.3);
        close();
        return;
      }
      // 经验条涨满
      bar.style.width = "100%";
      await sleep(0.7);
      // 等级一级一级跳，经验条从新等级的进度开始
      const lv = el.querySelector(".gr-level .lv") as HTMLElement;
      const lvUp = el.querySelector(".gr-level .lvup") as HTMLElement;
      for (let L = d.before.level + 1; L <= d.after.level; L++) {
        const shown = rush ? d.after.level : L;
        lv.textContent = String(shown);
        lvUp.textContent = `+${shown - d.before.level}`;
        lv.classList.remove("new");
        void lv.offsetWidth;
        lv.classList.add("new");
        if (!rush) sound("ding");
        if (rush) break;
        await sleep(0.45);
      }
      bar.style.transition = "none";
      bar.style.width = "0%";
      void bar.offsetWidth;
      bar.style.transition = "";
      bar.style.width = `${(d.barAfter ?? 1) * 100}%`;
      await sleep(0.5);
      // 能力一项一项往上加
      const items = [...el.querySelectorAll<HTMLElement>(".gr-stats li")];
      for (const li of items) {
        if (closed) return;
        rush = false;
        const from = Number(li.dataset.from), to = Number(li.dataset.to);
        const b = li.querySelector("b")!, em = li.querySelector("em")!;
        li.classList.add("active");
        const diff = to - from;
        const stepS = Math.min(0.14, Math.max(0.05, 1.2 / Math.max(1, diff)));
        for (let k = 1; k <= diff && !rush && !closed; k++) {
          b.textContent = String(from + k);
          em.textContent = `+${k}`;
          li.classList.toggle("bump");
          sound("tick");
          await sleep(stepS);
        }
        b.textContent = String(to);
        em.textContent = diff ? `+${diff}` : "";
        li.classList.remove("active");
        li.classList.add(diff ? "up" : "same");
        rush = false;
        await sleep(0.35);
      }
      finished = true;
      if (hint) hint.textContent = "按确定继续";
    };
    void run();
    return { done, advance, close };
  }

  // 特性强化：升级卡之后单独一个画面。先只亮出旧特性，蓄力、闪光，换成新档位的名字，最后才揭晓效果
  showTraitUp(d: { unit: Unit; portrait: string | null; before: Trait; after: Trait }, speed: number, sound: (kind: "tick" | "ding") => void = () => {}): { done: Promise<void>; advance: () => void; close: () => void } {
    const el = $("#growth");
    const face = d.portrait ? `<img src="${d.portrait}" alt="">` : `<span>${(d.unit.pilotName || d.unit.name).slice(0, 1)}</span>`;
    el.className = "big trait";
    el.style.setProperty("--speed", String(speed));
    el.innerHTML = `
      <div class="gr-card tu-card">
        <div class="gr-burst"></div>
        <div class="tu-title">特性强化</div>
        <div class="tu-who"><div class="gr-face">${face}</div><b>${d.unit.pilotName || d.unit.name}</b></div>
        <div class="tu-name"><span class="old">${traitLabel(d.before)}</span><span class="new">${traitLabel(d.after)}</span></div>
        <div class="tu-effect">${effectHtml(d.before.text, d.after.text)}</div>
        <div class="gr-hint">按确定继续</div>
      </div>`;
    el.hidden = false;
    const card = el.querySelector(".tu-card") as HTMLElement;
    const hint = el.querySelector(".gr-hint")!;
    let rush = false, finished = false, closed = false;
    const sleep = (s: number) => (rush || closed ? Promise.resolve() : new Promise<void>((r) => setTimeout(r, (s / speed) * 1000)));
    let resolveDone!: () => void;
    const done = new Promise<void>((r) => (resolveDone = r));
    const close = () => { if (closed) return; closed = true; el.hidden = true; el.innerHTML = ""; el.className = ""; resolveDone(); };
    const advance = () => { if (finished) close(); else rush = true; };
    el.onclick = advance;
    const run = async () => {
      hint.textContent = "";
      await sleep(0.6);
      card.classList.add("charge");
      for (let i = 0; i < 4; i++) { sound("tick"); await sleep(0.18); }
      await sleep(0.25);
      card.classList.remove("charge");
      card.classList.add("reveal");
      sound("ding");
      await sleep(0.7);
      // 效果说明里变了的数字从旧值滚到新值
      card.classList.add("effect");
      const nums = [...el.querySelectorAll<HTMLElement>(".tu-effect .num.up")];
      const steps = Math.max(1, ...nums.map((n) => Number(n.dataset.to) - Number(n.dataset.from)));
      for (let k = 1; k <= steps; k++) {
        for (const n of nums) {
          const from = Number(n.dataset.from), to = Number(n.dataset.to);
          n.textContent = String(rush ? to : Math.min(to, from + Math.round(((to - from) * k) / steps)));
        }
        if (rush) break;
        sound("tick");
        await sleep(Math.min(0.16, 0.9 / steps));
      }
      for (const n of nums) { n.textContent = n.dataset.to!; n.classList.add("done"); }
      await sleep(0.3);
      finished = true;
      hint.textContent = "按确定继续";
    };
    void run();
    return { done, advance, close };
  }

  // 整屏淡入淡出（场景之间先黑下来再亮起，原版的节奏）
  fade(toBlack: boolean, seconds: number): Promise<void> {
    const el = $("#fade");
    el.style.transitionDuration = `${seconds}s`;
    el.classList.toggle("on", toBlack);
    return new Promise((r) => setTimeout(r, seconds * 1000));
  }

  // 世界地图（出击前的剧情背景）：原版地图 + 这一关的位置（闪烁的红点）
  showWorldMap(map: WorldMapName, marker: { x: number; y: number } | null) {
    const worldMapUrl = worldMaps[map];
    const el = $("#worldmap");
    el.innerHTML = `
      <div class="wm-frame">
        <img src="${worldMapUrl}" alt="">
        ${marker ? `<i class="wm-mark" style="left:${(marker.x / 240) * 100}%;top:${(marker.y / 143) * 100}%"></i>` : ""}
      </div>`;
    el.hidden = false;
    if (settings.get().artStyle === "smooth") void smoothUrl(worldMapUrl).then((u) => { const img = el.querySelector("img"); if (img) img.src = u; });
  }

  hideWorldMap() {
    const el = $("#worldmap");
    el.classList.add("out");
    setTimeout(() => { el.hidden = true; el.classList.remove("out"); el.innerHTML = ""; }, 350);
  }

  // 菜单出现在屏幕坐标 (x, y) 旁边；fromHud 时是右上角按钮的下拉菜单，贴着按钮右对齐，顶部显示回合和胜利条件
  openMenu(items: MenuItem[], x: number, y: number, onClose: () => void, fromHud = false) {
    this.menuArgs = { items, x, y, onClose, fromHud };
    this.menuItems = items;
    this.menuIndex = items.findIndex((i) => !i.disabled);
    this.onMenuClose = onClose;
    const el = $("#menu");
    el.innerHTML = "";
    el.classList.toggle("from-hud", fromHud);
    $("#menu-btn").setAttribute("aria-expanded", String(fromHud));
    if (fromHud) {
      const head = document.createElement("div");
      head.className = "menu-head";
      head.innerHTML = `<b>第 ${this.turn} 回合</b> · <b data-phase="${this.phase}">${this.phase === "player" ? "我方回合" : "敌方回合"}</b>${this.objective ? `<small>${this.objective}</small>` : ""}`;
      el.append(head);
    }
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
    if (fromHud) x -= rect.width;
    el.style.left = `${Math.min(Math.max(8, x), innerWidth - rect.width - 8)}px`;
    el.style.top = `${Math.min(Math.max(56, y), innerHeight - rect.height - 8)}px`;
    this.renderMenuFocus();
  }

  get menuOpen() {
    return !$("#menu").hidden;
  }

  // 记下开着的菜单（连同光标位置），之后用 restoreMenu 原样打开
  saveMenu() {
    return this.menuOpen && this.menuArgs ? { ...this.menuArgs, index: this.menuIndex } : null;
  }

  restoreMenu(m: NonNullable<ReturnType<UI["saveMenu"]>>) {
    this.openMenu(m.items, m.x, m.y, m.onClose, m.fromHud);
    this.menuIndex = m.index;
    this.renderMenuFocus();
  }

  get hudMenuOpen() {
    return this.menuOpen && $("#menu").classList.contains("from-hud");
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
    $("#menu-btn").setAttribute("aria-expanded", "false");
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
    $("#menu").querySelectorAll("button").forEach((b, i) => b.classList.toggle("focus", i === this.menuIndex));
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
  // known = false：对方没交过手，命中、伤害、反击都不显示（它们取决于对方的能力和武器）
  // top：放在画面上方（敌方瞄准时用，不挡住下方的单位）
  // 攻击预测：一块钢板，左攻右守镜像排列，中间 VS。不写「击破」：结果留给战斗
  // 每边：头像、机体名、驾驶员（特性只给标签）、HP；分隔线下：武器、命中 / 伤害
  // known = false：对方没交过手，命中、伤害、反击都不显示（它们取决于对方的能力和武器）
  showForecast(atk: Unit, atkIcon: string, def: Unit, defIcon: string, weapon: Weapon, f: Forecast, known = true, top = false) {
    const el = $("#forecast");
    el.classList.toggle("top", top);
    const hpTone = (u: Unit) => { const r = u.hp / u.maxHp; return r > 0.5 ? "" : r > 0.25 ? "warn" : "danger"; };
    const head = (u: Unit, icon: string, showHp: boolean) => `
      <div class="fc-head">
        <img src="${icon}" alt="">
        <div class="fc-id">
          <b>${u.name}</b>
          <small><span>${u.pilotName}</span>${u.trait && showHp ? `<em>${traitLabel(u.trait)}</em>` : ""}</small>
        </div>
      </div>
      <div class="fc-hp ${showHp ? hpTone(u) : ""}">
        <span class="lb">HP</span>
        <div class="bar"><i style="width:${showHp ? Math.max(0, u.hp / u.maxHp) * 100 : 0}%"></i></div>
        <span class="val">${showHp ? `<b>${u.hp}</b><small>/${u.maxHp}</small>` : "<b>?</b>"}</span>
      </div>`;
    const nums = (hit: string, dmg: string, cls = "") => `
      <div class="fc-nums ${cls}">
        <div><small>命中</small><b>${hit}</b></div>
        <div><small>伤害</small><b>${dmg}</b></div>
      </div>`;
    const act = (w: Weapon | null, s: { hit: number; damage: number; valid: boolean } | null, twice: boolean) => {
      if (!s) return `<div class="fc-act"><div class="fc-weapon">${w ? w.name : "？"}</div>${nums("?", "?", "dash")}</div>`;
      if (!w || !s.valid) return `<div class="fc-act none"><div class="fc-weapon">${w ? w.name : "无法反击"}</div>${nums("—", "—", "dash")}</div>`;
      return `<div class="fc-act"><div class="fc-weapon">${w.name}</div>${nums(`${s.hit}<i>%</i>`, `${s.damage}${twice ? "<i>×2</i>" : ""}`)}</div>`;
    };
    const atkSide = `<div class="fc-side ${atk.side}">${head(atk, atkIcon, true)}${act(weapon, known ? f.attack : null, f.extra === "attacker")}</div>`;
    const defSide = `<div class="fc-side ${def.side} mirror">${head(def, defIcon, known)}${known ? act(f.counter.weapon, f.counter, f.extra === "defender") : act(null, null, false)}</div>`;
    el.innerHTML = `${atkSide}<div class="fc-vs"><span>VS</span></div>${defSide}`;
    el.hidden = false;
  }

  hideForecast() {
    $("#forecast").hidden = true;
  }

  // ---------- 战斗面板（简略演出，叠在地图上） ----------
  // f：战前预测，卡片上标出双方这一战的命中率（不能反击的一方标「不能反击」）
  battleStart(atk: Unit, atkIcon: string, def: Unit, defIcon: string, f: Forecast) {
    const el = $("#battle");
    const card = (u: Unit, icon: string, role: string) => `
      <div class="bt-side ${u.side}" data-unit="${u.id}">
        <img src="${icon}" alt="">
        <div class="bt-body">
          <div class="bt-name"><b>${u.name}</b><small>${role}</small></div>
          <div class="bt-hp"><div class="bar"><i style="width:${(u.hp / u.maxHp) * 100}%"></i></div><span>${u.hp} / ${u.maxHp}</span></div>
        </div>
        <div class="bt-pop"></div>
        <div class="bt-say"></div>
      </div>`;
    const counter = f.counter.valid && f.counter.weapon ? `反击 · 命中 ${f.counter.hit}%` : "不能反击";
    el.innerHTML = card(atk, atkIcon, `攻击 · 命中 ${f.attack.hit}%`) + card(def, defIcon, counter) + '<div class="bt-weapon"></div>';
    el.hidden = false;
  }

  // 战斗台词：显示在说话一方的卡片下方，直到下一句
  battleSay(u: Unit, text: string | null) {
    if (!text) return;
    const box = $("#battle").querySelector(`[data-unit="${u.id}"] .bt-say`) as HTMLElement | null;
    if (!box) return;
    box.textContent = `${u.pilotName ? `${u.pilotName}：` : ""}${text}`;
    box.classList.remove("show");
    void box.offsetWidth;
    box.classList.add("show");
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
  showResult(win: boolean, lines: string[], onRetry: () => void, label = "再玩一次") {
    const el = $("#result");
    el.innerHTML = `
      <div class="card">
        <div class="title ${win ? "win" : "lose"}">${win ? "胜利" : "失败"}</div>
        ${lines.map((l) => `<div class="line">${l}</div>`).join("")}
        <button>${label}</button>
      </div>`;
    el.querySelector("button")!.onclick = onRetry;
    el.hidden = false;
  }

  hideResult() {
    $("#result").hidden = true;
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
    // 画面设置「平滑放大」：头像换成 Scale4x 放大后的版本
    if (portrait && settings.get().artStyle === "smooth") {
      void smoothUrl(portrait).then((u) => {
        const img = el.querySelector(".dl-face img") as HTMLImageElement | null;
        if (img && img.getAttribute("src") === portrait) img.src = u;
      });
    }
    (el.querySelector(".dl-face") as HTMLElement).classList.toggle("placeholder", !portrait);
    // 旁白（如「敌方援军出现了」，原版窗口样式 0F）没有说话人，原版不画头像框
    (el.querySelector(".dl-face") as HTMLElement).classList.toggle("none", !portrait && !initial);
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

// 特性说明：前后两档的文字只差数字时，同一行里把变了的数字标出来（data-from / data-to）做动效；
// 文字结构不一样就直接显示新档的说明
function effectHtml(before: string, after: string) {
  const split = (t: string) => t.split(/(\d+)/);
  const a = split(before), b = split(after);
  const same = a.length === b.length && a.every((p, i) => (i % 2 ? true : p === b[i]));
  if (!same) return `<span class="num up done">${after}</span>`;
  return b.map((p, i) => (i % 2 === 0 ? p : p === a[i] ? `<span class="num">${p}</span>` : `<span class="num up" data-from="${a[i]}" data-to="${p}">${a[i]}</span>`)).join("");
}
