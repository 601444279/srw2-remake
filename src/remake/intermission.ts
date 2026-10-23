// 间章（重制版新增，docs/design.md 3.5 / 6.6）：过关之后、下一关之前。用资金改造机体和武器，改造前后数值对比，
// 再出击。改造等级记在名册上（RosterMember.upgrades），跟着人走到后面的关卡。
// 键盘：↑↓ 选人，←→ 选机体 / 武器，确定改造一段，「菜单」键或点「出击」进下一关；鼠标直接点。
import { MAX_UPGRADE, memberPreview, upgradeCost, type RosterMember } from "./data.ts";
import { settings } from "./settings.ts";
import type { Sfx } from "./sfx.ts";

type Part = "body" | "weapon";

export function showIntermission(opts: {
  roster: RosterMember[];
  money: { value: number };
  cleared: number;
  sfx: Sfx;
  settingsOpen: () => boolean;
}): Promise<void> {
  const { roster, money, sfx } = opts;
  const root = document.getElementById("intermission")!;
  root.hidden = false;
  let row = 0;
  let part: Part = "body";
  // 能改造的：名册里有机体的（按名册号排）
  const members = [...roster].sort((a, b) => a.member - b.member);

  return new Promise<void>((resolve) => {
    const done = () => {
      removeEventListener("keydown", onKey, true);
      root.hidden = true;
      root.innerHTML = "";
      resolve();
    };

    const buy = (i: number, p: Part) => {
      const m = members[i];
      const up = (m.upgrades ??= { body: 0, weapon: 0 });
      if (up[p] >= MAX_UPGRADE) return;
      const cost = upgradeCost(p, up[p]);
      if (money.value < cost) { flash(); return; }
      money.value -= cost;
      up[p]++;
      sfx.ui("ok");
      render();
    };
    const flash = () => {
      const el = root.querySelector(".im-money");
      el?.classList.remove("no");
      void (el as HTMLElement | null)?.offsetWidth;
      el?.classList.add("no");
    };

    const stat = (label: string, a: number | string, b: number | string) =>
      `<span class="im-stat"><i>${label}</i><b>${a}</b>${a !== b ? `<em>→ ${b}</em>` : ""}</span>`;

    const render = () => {
      const cards = members.map((m, i) => {
        const up = m.upgrades ?? { body: 0, weapon: 0 };
        const now = memberPreview(m, up);
        const nextBody = up.body < MAX_UPGRADE ? memberPreview(m, { ...up, body: up.body + 1 }) : now;
        const nextWeapon = up.weapon < MAX_UPGRADE ? memberPreview(m, { ...up, weapon: up.weapon + 1 }) : now;
        const on = i === row;
        const cell = (p: Part, title: string, lv: number, body: string) => {
          const full = lv >= MAX_UPGRADE;
          const cost = full ? 0 : upgradeCost(p, lv);
          const sel = on && part === p;
          return `
            <button class="im-cell${sel ? " on" : ""}${full ? " full" : ""}" data-i="${i}" data-p="${p}" ${full ? "disabled" : ""}>
              <div class="im-cell-head"><b>${title}</b><span class="im-pips">${"■".repeat(lv)}${"□".repeat(MAX_UPGRADE - lv)}</span></div>
              <div class="im-stats">${body}</div>
              <div class="im-cost">${full ? (p === "body" ? "改满 · 机动 +1" : "改满") : `${cost * 10}G`}</div>
            </button>`;
        };
        return `
          <div class="im-row${on ? " on" : ""}">
            <div class="im-who"><b>${now.name}</b><small>${now.pilotName} · Lv ${now.level}</small></div>
            ${cell("body", "机体改造", up.body,
              stat("HP", now.maxHp, nextBody.maxHp) + stat("防卫", now.defense, nextBody.defense) + stat("速度", now.speed, nextBody.speed) + stat("机动", now.move, nextBody.move))}
            ${cell("weapon", "武器改造", up.weapon,
              now.weapons.map((w, k) => stat(w.name, w.power, nextWeapon.weapons[k]?.power ?? w.power)).join(""))}
          </div>`;
      }).join("");
      root.innerHTML = `
        <div class="im-panel">
          <header>
            <div><b>间章</b><small>第 ${opts.cleared} 关结束 · 出击前可以改造机体和武器</small></div>
            <div class="im-money">资金 <b>${money.value * 10}G</b></div>
          </header>
          <div class="im-list">${cards}</div>
          <footer>
            <span class="im-hint">↑↓ 选机体　←→ 选机体 / 武器　确定 改造一段</span>
            <button class="im-go">出击：第 ${opts.cleared + 1} 关</button>
          </footer>
        </div>`;
      root.querySelectorAll<HTMLButtonElement>(".im-cell").forEach((b) => {
        b.onclick = () => { row = Number(b.dataset.i); part = b.dataset.p as Part; buy(row, part); };
      });
      (root.querySelector(".im-go") as HTMLButtonElement).onclick = () => { sfx.ui("ok"); done(); };
      root.querySelector(".im-row.on")?.scrollIntoView({ block: "nearest" });
    };

    const onKey = (e: KeyboardEvent) => {
      if (opts.settingsOpen()) return;
      const a = settings.actionFor(e.code);
      if (!a) return;
      e.preventDefault();
      if (a === "up" || a === "down") { row = (row + (a === "up" ? -1 : 1) + members.length) % members.length; sfx.ui("move"); render(); }
      else if (a === "left" || a === "right") { part = part === "body" ? "weapon" : "body"; sfx.ui("move"); render(); }
      else if (a === "confirm" && !e.repeat) buy(row, part);
      else if (a === "menu") { sfx.ui("ok"); done(); }
    };
    addEventListener("keydown", onKey, true);
    render();
  });
}
