import "./style.css";
import { loadStage } from "./data.ts";
import { Renderer } from "./render.ts";
import { Input } from "./input.ts";
import { UI } from "./ui.ts";
import { Game } from "./game.ts";
import { Sfx } from "./sfx.ts";
import { SettingsPanel } from "./settings-panel.ts";
import { settings } from "./settings.ts";

async function boot() {
  const canvas = document.getElementById("map") as HTMLCanvasElement;
  const stage = loadStage(1);
  const renderer = new Renderer(canvas);
  await renderer.setStage(stage);
  const ui = new UI();
  const panel = new SettingsPanel();
  let input: Input | null = null;
  const game = new Game(stage, renderer, ui, new Sfx(), () => input?.isFast ?? false);

  // 关闭鼠标操作时隐藏指针、菜单也不响应鼠标
  const applyMouse = () => document.body.classList.toggle("no-mouse", !settings.get().mouse);
  applyMouse();
  settings.onChange(() => { applyMouse(); game.settingsChanged(); });
  const openSettings = () => {
    if (panel.isOpen) return;
    input?.releaseAll();
    panel.open(() => game.settingsChanged());
  };
  document.getElementById("gear")!.addEventListener("click", openSettings);
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
  const frame = (now: number) => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    input.update(now);
    game.update(dt);
    renderer.draw(game, dt);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  await game.start();
}

boot().catch((e) => {
  document.body.insertAdjacentHTML("beforeend", `<pre class="fatal">${String(e?.stack ?? e)}</pre>`);
});
