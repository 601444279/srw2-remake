// 地图商店（原版第 2、5、8 关等的格子商店，docs/notes-events.md「商店和工具」）：单位走到商店格上选「待命」打开。
// 内容照原版：米拉的头像和台词（问候 → 需要什么 → 要买吗 → 还要什么吗 → 道别；钱不够、带不下各一句，乔有自己那套）、
// 每家店 4 种零件和价格、零件说明；选一个零件先问「要买吗？」再买。买的零件全队共用，在地图菜单「工具」里用。
// 画面换成重制版的面板（和间章共用 #intermission 的样式）。键盘：↑↓ 选零件，确定 选 / 买，取消 不买 / 离开；鼠标直接点
import { PARTS, MAX_ITEMS, type Shop } from "./parts.ts";
import { loadScene, portraitUrl } from "./story.ts";
import { settings } from "./settings.ts";
import type { Sfx } from "./sfx.ts";

// 问候语起连续 7 条
const LINE = { hello: 0, what: 1, poor: 2, full: 3, sure: 4, more: 5, bye: 6 } as const;

export function showShop(opts: {
  shop: Shop;
  money: { value: number };
  items: number[];
  sfx: Sfx;
  settingsOpen: () => boolean;
}): Promise<void> {
  const { shop, money, items, sfx } = opts;
  const root = document.getElementById("intermission")!;
  const [res, base] = shop.greeting.replace("res-", "").split("#");
  const line = (k: keyof typeof LINE) => loadScene({ res, index: Number(base) + LINE[k] })[0];
  const face = portraitUrl(shop.face);
  let row = 0;
  // asking：选了零件，在问「要买吗？」
  let asking = false;
  let say = line("hello");
  // 道别那句出来后：1.1 秒自动关，或按键 / 点一下提前关
  let leaving = 0;
  let closed = false;
  root.hidden = false;

  return new Promise<void>((resolve) => {
    const done = () => {
      if (closed) return;
      closed = true;
      removeEventListener("keydown", onKey, true);
      root.hidden = true;
      root.innerHTML = "";
      resolve();
    };
    const leave = () => {
      if (leaving) return;
      leaving = performance.now();
      asking = false;
      say = line("bye");
      sfx.ui("ok");
      render();
      setTimeout(done, 1100);
    };
    const flash = () => {
      const el = root.querySelector(".im-money");
      el?.classList.remove("no");
      void (el as HTMLElement | null)?.offsetWidth;
      el?.classList.add("no");
    };
    const choose = (i: number) => {
      if (leaving) return;
      row = i;
      asking = true;
      say = line("sure");
      sfx.ui("ok");
      render();
    };
    // 原版 $97AF：先看带不带得下，再看钱够不够
    const buy = () => {
      const id = shop.parts[row], p = PARTS[id];
      asking = false;
      if (items[id] >= MAX_ITEMS) { say = line("full"); sfx.ui("move"); }
      else if (money.value < p.price) { say = line("poor"); sfx.ui("move"); flash(); }
      else {
        money.value -= p.price;
        items[id]++;
        say = line("more");
        sfx.ui("ok");
      }
      render();
    };
    const back = () => { asking = false; say = line("what"); sfx.ui("move"); render(); };

    const render = () => {
      const rows = shop.parts.map((id, i) => {
        const p = PARTS[id];
        const on = i === row;
        return `
          <div class="sh-row${on ? " on" : ""}${money.value < p.price ? " poor" : ""}" data-i="${i}">
            <button class="sh-pick" data-i="${i}"><b>${p.name}</b><span class="sh-own">持有 ${items[id]}</span><span class="sh-price">${p.price * 10}G</span></button>
            ${on && asking ? `<span class="sh-ask"><button class="sh-yes">购买</button><button class="sh-no">不买</button></span>` : ""}
          </div>`;
      }).join("");
      const sel = PARTS[shop.parts[row]];
      root.innerHTML = `
        <div class="im-panel shop">
          <header>
            <div><b>商店</b><small>买的零件全队共用，在地图菜单「工具」里给机体使用</small></div>
            <div class="im-money">资金 <b>${money.value * 10}G</b></div>
          </header>
          <div class="sh-talk">
            <div class="sh-face">${face ? `<img src="${face}" alt="">` : ""}</div>
            <div class="sh-line"><i>${say.speaker}</i>${say.text}</div>
          </div>
          <div class="sh-list">${rows}</div>
          <div class="sh-note"><b>${sel.name}</b>${sel.note.replace(/\n/g, "")}</div>
          <footer>
            <span class="im-hint">↑↓ 选零件　确定 选择 / 购买　取消 不买 / 离开</span>
            <button class="im-go sh-leave">离开</button>
          </footer>
        </div>`;
      root.querySelectorAll<HTMLButtonElement>(".sh-pick").forEach((b) => {
        b.onclick = () => { const i = Number(b.dataset.i); if (asking && i === row) buy(); else choose(i); };
      });
      root.querySelector<HTMLButtonElement>(".sh-yes")?.addEventListener("click", buy);
      root.querySelector<HTMLButtonElement>(".sh-no")?.addEventListener("click", back);
      root.querySelector<HTMLButtonElement>(".sh-leave")!.onclick = leave;
      root.querySelector(".im-panel")!.addEventListener("click", () => { if (leaving && performance.now() - leaving > 200) done(); });
    };

    const onKey = (e: KeyboardEvent) => {
      if (opts.settingsOpen()) return;
      const a = settings.actionFor(e.code);
      if (!a) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (leaving) { if ((a === "confirm" || a === "cancel") && !e.repeat) done(); return; }
      if ((a === "up" || a === "down") && !asking) {
        row = (row + (a === "up" ? -1 : 1) + shop.parts.length) % shop.parts.length;
        sfx.ui("move");
        render();
      } else if (a === "confirm" && !e.repeat) { if (asking) buy(); else choose(row); }
      else if (a === "cancel" || a === "menu") { if (asking) back(); else leave(); }
    };
    addEventListener("keydown", onKey, true);
    render();
  });
}
