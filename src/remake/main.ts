import "./style.css";
import "./theme.ts";
import { INITIAL_ROSTER, campaignRoster, loadStage, refreshSpiritText } from "./data.ts";
import { Renderer } from "./render.ts";
import { Input } from "./input.ts";
import { UI } from "./ui.ts";
import { Game } from "./game.ts";
import { Sfx } from "./sfx.ts";
import { Music } from "./music.ts";
import { SettingsPanel } from "./settings-panel.ts";
import { settings } from "./settings.ts";
import { readSave, requestLoad, takeNextStage, takePendingLoad } from "./saves.ts";
import { showTitle } from "./title.ts";

async function boot() {
  const canvas = document.getElementById("map") as HTMLCanvasElement;
  // 读档是整页重新载入：先看有没有要读的存档，有的话用存档里的关卡、名册和单位
  const pending = takePendingLoad();
  const save = pending !== null && pending !== "new" ? await readSave(pending) : null;
  // 过关进下一关（game.finishStage → requestNextStage）。开发时地址加 ?stage=N 直接从第 N 关开始（初始名册）
  let next = takeNextStage();
  // 自动测试连着打（&chain）时，每进一关记一份；改代码触发整页重载也能从这一关接着跑
  if (import.meta.env.DEV && new URLSearchParams(location.search).has("chain")) {
    if (next) sessionStorage.setItem("srw2-remake:chain-current", JSON.stringify(next));
    else next = JSON.parse(sessionStorage.getItem("srw2-remake:chain-current") ?? "null");
  }
  const devParams = new URLSearchParams(location.search);
  const devStage = import.meta.env.DEV ? Number(devParams.get("stage")) || null : null;
  // 开发时 ?stage=N：名册按一路打过来的样子模拟（data.ts campaignRoster）；&lv=N 再把全员拉到 N 级
  const devLevel = import.meta.env.DEV ? Number(devParams.get("lv")) || 0 : 0;
  const devBase = devStage && devStage > 1 ? campaignRoster(devStage) : INITIAL_ROSTER;
  const devRoster = devLevel || devBase !== INITIAL_ROSTER ? devBase.map((m) => ({ ...m, level: Math.max(m.level, devLevel - 1) })) : undefined;
  const stage = loadStage(save?.stage ?? next?.stage ?? devStage ?? 1, save?.roster ?? next?.roster ?? devRoster, next?.benched);
  if (save) stage.units.splice(0, stage.units.length, ...save.units);
  if (save) refreshSpiritText(stage.units);
  const renderer = new Renderer(canvas);
  await renderer.setStage(stage);
  const ui = new UI();
  const panel = new SettingsPanel();
  let input: Input | null = null;
  const sfx = new Sfx(), music = new Music();
  const game = new Game(stage, renderer, ui, sfx, music, () => input?.isFast ?? false);
  // 标题画面开着时游戏不接收按键
  let titleOpen = false;

  // 关闭鼠标操作时隐藏指针、菜单也不响应鼠标
  const applyMouse = () => document.body.classList.toggle("no-mouse", !settings.get().mouse);
  applyMouse();
  settings.onChange(() => {
    applyMouse();
    game.settingsChanged();
    void renderer.setArtStyle(settings.get().artStyle === "smooth", game.units, settings.get().unitBlackBox);
  });
  const openSettings = () => {
    if (panel.isOpen) return;
    input?.releaseAll();
    panel.open(() => game.settingsChanged());
  };
  const menuBtn = document.getElementById("menu-btn")!;
  menuBtn.addEventListener("click", () => {
    const r = menuBtn.getBoundingClientRect();
    game.hudMenu(r.right, r.bottom + 6);
  });
  // 点对话框翻页
  document.getElementById("dialog")!.addEventListener("click", () => { if (settings.get().mouse) game.action("confirm"); });
  game.onOpenSettings = openSettings;

  input = new Input(canvas, {
    onMove: (dx, dy) => game.move(dx, dy),
    onAction: (a) => game.action(a),
    onPointerTile: (x, y) => game.pointerTile(renderer.screenToTile(x, y)),
    onPointerClick: (x, y, button) => game.pointerClick(renderer.screenToTile(x, y), button),
    onWheel: (d) => game.action(d < 0 ? "zoomIn" : "zoomOut"),
  }, () => panel.isOpen || titleOpen);

  // 开发时方便在控制台里调试
  if (import.meta.env.DEV) Object.assign(window, { game, renderer });

  let last = performance.now();
  let lastFrame = performance.now();
  const frame = (now: number) => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    lastFrame = performance.now();
    input.update(now);
    game.update(dt);
    renderer.draw(game, dt);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  // 页面在后台时浏览器会暂停 requestAnimationFrame：自动测试时改用计时器推进（平时就让游戏暂停）
  setInterval(() => {
    if (!game.autoplaying || performance.now() - lastFrame < 200) return;
    game.update(0.05);
  }, 50);
  // 升级动画演示：地址加 ?demo=levelup
  const params0 = new URLSearchParams(location.search);
  if (params0.get("demo") === "levelup") {
    await game.demoLevelUp();
    return;
  }
  // 自动测试（开发时）：地址加 ?autoplay，可带 &turns=30&speed=8&battle=full|simple&sound=1&stage=N&lv=N&chain&queue=7,10,11
  //（chain：过关后自动进下一关接着打，名册带过去；queue：这一关打完换 queue 里的下一关，各自从模拟名册开始）
  const params = new URLSearchParams(location.search);
  if (import.meta.env.DEV && params.has("autoplay")) {
    const num = (k: string) => Number(params.get(k)) || undefined;
    const battle = params.get("battle");
    if (next) { game.money.value = next.money; if (next.items) game.items = [...next.items]; }
    const done = game.autoplay({ turns: num("turns"), speed: num("speed"), battle: battle === "full" || battle === "simple" ? battle : undefined, mute: !params.has("sound") });
    const queue = (params.get("queue") ?? "").split(",").filter(Boolean);
    if (queue.length) void done.then(() => setTimeout(() => {
      const [stage, ...rest] = queue;
      params.set("stage", stage);
      if (rest.length) params.set("queue", rest.join(",")); else params.delete("queue");
      location.search = params.toString();
    }, 1500));
    await game.start();
    return;
  }
  if (save) await game.resumeFromSave(save);
  else if (next) { game.money.value = next.money; if (next.items) game.items = [...next.items]; await game.start(); }
  else if (pending === "new" || devStage) await game.start();
  else {
    // 正常打开游戏：标题画面 → 主菜单。继续 / 读档整页重新载入（干净地重建状态）
    titleOpen = true;
    const choice = await showTitle({ music, sfx, openSettings, settingsOpen: () => panel.isOpen });
    titleOpen = false;
    if (choice.kind === "load") { requestLoad(choice.slot); return; }
    await game.start();
  }
}

boot().catch((e) => {
  document.body.insertAdjacentHTML("beforeend", `<pre class="fatal">${String(e?.stack ?? e)}</pre>`);
});
