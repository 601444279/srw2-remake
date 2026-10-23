// 出击选择（重制版新增，docs/design.md 4.4 / 6.6）：间章改造之后、进下一关之前。
// 名单是这一关原版的出场名单（data.ts stageLineup），主角和剧情上不能少的人锁定出场，其余可以留下待命。
// 可按原版顺序 / 等级 / HP / 击坠数排序。键盘：↑↓ 选人，←→ 换排序，确定 出击 / 待命，「菜单」键或点「出击」开始。
import { memberPreview, stageLineup, type RosterMember } from "./data.ts";
import { settings } from "./settings.ts";
import type { Sfx } from "./sfx.ts";

const SORTS = [
  { label: "原版顺序", key: () => 0 },
  { label: "等级", key: (m: RosterMember) => -m.level },
  { label: "HP", key: (m: RosterMember) => -memberPreview(m).maxHp },
  { label: "击坠数", key: (m: RosterMember) => -(m.kills ?? 0) },
];

// 返回没选上的名册号
export function showSortie(opts: {
  stage: number;
  title: string;
  roster: RosterMember[];
  sfx: Sfx;
  settingsOpen: () => boolean;
}): Promise<number[]> {
  const { roster, sfx } = opts;
  const root = document.getElementById("intermission")!;
  root.hidden = false;
  const { slots, members, forced } = stageLineup(opts.stage, roster);
  const absent = roster.filter((m) => !members.includes(m)).sort((a, b) => a.member - b.member);
  const benched = new Set<number>();
  let sort = 0;
  let row = 0;
  const order = () => {
    const s = SORTS[sort];
    return members.map((m, i) => ({ m, i })).sort((a, b) => s.key(a.m) - s.key(b.m) || a.i - b.i).map((x) => x.m);
  };

  return new Promise<number[]>((resolve) => {
    const done = () => {
      if (benched.size === members.length) { flash(); return; }
      sfx.ui("ok");
      removeEventListener("keydown", onKey, true);
      root.hidden = true;
      root.innerHTML = "";
      resolve([...benched]);
    };
    const toggle = (m: RosterMember) => {
      if (forced.has(m.member)) return;
      if (benched.has(m.member)) benched.delete(m.member);
      else benched.add(m.member);
      sfx.ui("move");
      render();
    };
    const flash = () => {
      const el = root.querySelector(".so-count");
      el?.classList.remove("no");
      void (el as HTMLElement | null)?.offsetWidth;
      el?.classList.add("no");
    };

    const line = (m: RosterMember, on: boolean, state: "lock" | "go" | "stay" | "absent") => {
      const p = memberPreview(m);
      const tag = { lock: "必须出场", go: "出击", stay: "待命", absent: "本关不在场" }[state];
      return `
        <button class="so-row ${state}${on ? " on" : ""}" data-m="${m.member}" ${state === "absent" ? "disabled" : ""}>
          <span class="so-who"><b>${p.name}</b><small>${p.pilotName}</small></span>
          <span class="im-stat"><i>Lv</i><b>${p.level}</b></span>
          <span class="im-stat"><i>HP</i><b>${p.maxHp}</b></span>
          <span class="im-stat"><i>击坠</i><b>${m.kills ?? 0}</b></span>
          <span class="so-tag">${tag}</span>
        </button>`;
    };

    const render = () => {
      const list = order();
      const going = members.length - benched.size;
      root.innerHTML = `
        <div class="im-panel so-panel">
          <header>
            <div><b>出击选择</b><small>第 ${opts.stage} 关「${opts.title}」</small></div>
            <div class="so-count">出击 <b>${going}</b> / ${slots}</div>
          </header>
          <div class="so-sorts">${SORTS.map((s, i) => `<button class="so-sort${i === sort ? " on" : ""}" data-s="${i}">${s.label}</button>`).join("")}</div>
          <div class="im-list">
            ${list.map((m, i) => line(m, i === row, forced.has(m.member) ? "lock" : benched.has(m.member) ? "stay" : "go")).join("")}
            ${absent.map((m) => line(m, false, "absent")).join("")}
          </div>
          <footer>
            <span class="im-hint">↑↓ 选人　←→ 排序　确定 出击 / 待命</span>
            <button class="im-go">出击：第 ${opts.stage} 关</button>
          </footer>
        </div>`;
      root.querySelectorAll<HTMLButtonElement>(".so-row:not(.absent)").forEach((b) => {
        b.onclick = () => {
          const m = members.find((x) => x.member === Number(b.dataset.m))!;
          row = order().indexOf(m);
          toggle(m);
        };
      });
      root.querySelectorAll<HTMLButtonElement>(".so-sort").forEach((b) => {
        b.onclick = () => { sort = Number(b.dataset.s); row = 0; sfx.ui("move"); render(); };
      });
      (root.querySelector(".im-go") as HTMLButtonElement).onclick = done;
      root.querySelector(".so-row.on")?.scrollIntoView({ block: "nearest" });
    };

    const onKey = (e: KeyboardEvent) => {
      if (opts.settingsOpen()) return;
      const a = settings.actionFor(e.code);
      if (!a) return;
      e.preventDefault();
      if (a === "up" || a === "down") { row = (row + (a === "up" ? -1 : 1) + members.length) % members.length; sfx.ui("move"); render(); }
      else if (a === "left" || a === "right") { sort = (sort + (a === "left" ? -1 : 1) + SORTS.length) % SORTS.length; row = 0; sfx.ui("move"); render(); }
      else if (a === "confirm" && !e.repeat) toggle(order()[row]);
      else if (a === "menu") done();
    };
    addEventListener("keydown", onKey, true);
    render();
  });
}
