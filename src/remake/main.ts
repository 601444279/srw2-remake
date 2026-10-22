import "./style.css";
import { loadStage } from "./data.ts";
import { Renderer } from "./render.ts";
import { Input } from "./input.ts";
import { UI } from "./ui.ts";
import { Game } from "./game.ts";
import { Sfx } from "./sfx.ts";
import { Music } from "./music.ts";
import { SettingsPanel } from "./settings-panel.ts";
import { settings } from "./settings.ts";
import { readSave, takePendingLoad } from "./saves.ts";

async function boot() {
  const canvas = document.getElementById("map") as HTMLCanvasElement;
  // 读档是整页重新载入：先看有没有要读的存档，有的话用存档里的关卡、名册和单位
  const pending = takePendingLoad();
  const save = pending !== null && pending !== "new" ? await readSave(pending) : null;
  const stage = loadStage(save?.stage ?? 1, save?.roster);
  if (save) stage.units.splice(0, stage.units.length, ...save.units);
  const renderer = new Renderer(canvas);
  await renderer.setStage(stage);
  const ui = new UI();
  const panel = new SettingsPanel();
  let input: Input | null = null;
  const game = new Game(stage, renderer, ui, new Sfx(), new Music(), () => input?.isFast ?? false);

  // 关闭鼠标操作时隐藏指针、菜单也不响应鼠标
  const applyMouse = () => document.body.classList.toggle("no-mouse", !settings.get().mouse);
  applyMouse();
  settings.onChange(() => {
    applyMouse();
    game.settingsChanged();
    void renderer.setArtStyle(settings.get().artStyle === "smooth", game.units);
  });
  const openSettings = () => {
    if (panel.isOpen) return;
    input?.releaseAll();
    panel.open(() => game.settingsChanged());
  };
  document.getElementById("gear")!.addEventListener("click", openSettings);
  // 点对话框翻页
  document.getElementById("dialog")!.addEventListener("click", () => { if (settings.get().mouse) game.action("confirm"); });
  game.onOpenSettings = openSettings;

  input = new Input(canvas, {
    onMove: (dx, dy) => game.move(dx, dy),
    onAction: (a) => game.action(a),
    onPointerTile: (x, y) => game.pointerTile(renderer.screenToTile(x, y)),
    onPointerClick: (x, y, button) => game.pointerClick(renderer.screenToTile(x, y), button),
    onWheel: (d) => game.action(d < 0 ? "zoomIn" : "zoomOut"),
  }, () => panel.isOpen);

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
  // 自动测试（开发时）：地址加 ?autoplay，可带 &turns=30&speed=8&battle=full|simple&sound=1
  const params = new URLSearchParams(location.search);
  if (import.meta.env.DEV && params.has("autoplay")) {
    const num = (k: string) => Number(params.get(k)) || undefined;
    const battle = params.get("battle");
    void game.autoplay({ turns: num("turns"), speed: num("speed"), battle: battle === "full" || battle === "simple" ? battle : undefined, mute: !params.has("sound") });
    await game.start();
    return;
  }
  if (save) await game.resumeFromSave(save);
  else if (pending === "new") await game.start();
  else await game.showStartMenu();
}

boot().catch((e) => {
  document.body.insertAdjacentHTML("beforeend", `<pre class="fatal">${String(e?.stack ?? e)}</pre>`);
});
