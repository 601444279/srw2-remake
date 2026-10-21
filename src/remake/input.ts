// 输入：键盘、鼠标、手柄统一转换成游戏动作。
// 方向键支持 8 方向（同时按两个方向就斜走），长按会逐渐加速，按住 Shift / 手柄 X 键高速移动。

export type Action = "confirm" | "cancel" | "next" | "prev" | "danger" | "menu" | "zoomIn" | "zoomOut";

export interface InputHandlers {
  onMove(dx: number, dy: number): void;
  onAction(action: Action): void;
  onPointerTile(screenX: number, screenY: number): void;
  onPointerClick(screenX: number, screenY: number, button: number): void;
  onWheel(delta: number): void;
}

const DIRS: Record<string, [number, number]> = {
  ArrowUp: [0, -1], KeyW: [0, -1],
  ArrowDown: [0, 1], KeyS: [0, 1],
  ArrowLeft: [-1, 0], KeyA: [-1, 0],
  ArrowRight: [1, 0], KeyD: [1, 0],
};
const ACTIONS: Record<string, Action> = {
  KeyX: "confirm", Enter: "confirm", Space: "confirm",
  KeyZ: "cancel", Backspace: "cancel", Escape: "cancel",
  KeyE: "next", Tab: "next", KeyQ: "prev",
  KeyR: "danger", KeyM: "menu",
  Equal: "zoomIn", NumpadAdd: "zoomIn", Minus: "zoomOut", NumpadSubtract: "zoomOut",
};
// 标准手柄布局
const PAD_BUTTONS: Record<number, Action> = { 0: "confirm", 1: "cancel", 4: "prev", 5: "next", 3: "danger", 9: "menu" };
const PAD_FAST = 2;

// 长按方向：先停一下，再按越来越短的间隔重复
const REPEAT_DELAY = 170;
const REPEAT_START = 85;
const REPEAT_MIN = 40;
const REPEAT_ACCEL = 0.85;
const FAST_INTERVAL = 28;

export class Input {
  private held = new Map<string, [number, number]>();
  private fast = false;
  private repeatAt = 0;
  private interval = REPEAT_START;
  private lastDir = "";
  private padPrev: boolean[] = [];
  private padDir: [number, number] = [0, 0];

  constructor(private target: HTMLElement, private handlers: InputHandlers) {
    addEventListener("keydown", (e) => this.keyDown(e));
    addEventListener("keyup", (e) => this.keyUp(e));
    addEventListener("blur", () => this.held.clear());
    target.addEventListener("pointermove", (e) => handlers.onPointerTile(e.offsetX, e.offsetY));
    target.addEventListener("pointerdown", (e) => handlers.onPointerClick(e.offsetX, e.offsetY, e.button));
    target.addEventListener("contextmenu", (e) => e.preventDefault());
    target.addEventListener("wheel", (e) => { e.preventDefault(); handlers.onWheel(Math.sign(e.deltaY)); }, { passive: false });
  }

  private keyDown(e: KeyboardEvent) {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    if (e.key === "Shift") this.fast = true;
    const dir = DIRS[e.code];
    if (dir) {
      e.preventDefault();
      if (e.repeat) return;
      this.held.set(e.code, dir);
      this.step(performance.now(), true);
      return;
    }
    let action = ACTIONS[e.code];
    if (e.code === "Tab" && e.shiftKey) action = "prev";
    if (action) {
      e.preventDefault();
      if (!e.repeat || action === "zoomIn" || action === "zoomOut") this.handlers.onAction(action);
    }
  }

  private keyUp(e: KeyboardEvent) {
    if (e.key === "Shift") this.fast = false;
    this.held.delete(e.code);
  }

  private direction(): [number, number] {
    let dx = this.padDir[0], dy = this.padDir[1];
    for (const [x, y] of this.held.values()) { dx += x; dy += y; }
    return [Math.sign(dx), Math.sign(dy)];
  }

  // 按下方向键时立即走一格并重新计时；同方向长按按间隔重复。
  // 松开斜向中的一个键只重新计时、不额外走一步，避免斜走之后多走一格
  private step(now: number, fresh = false) {
    const [dx, dy] = this.direction();
    const dirKey = `${dx},${dy}`;
    if (dx === 0 && dy === 0) { this.lastDir = ""; return; }
    if (fresh || dirKey !== this.lastDir) {
      if (fresh) this.handlers.onMove(dx, dy);
      this.lastDir = dirKey;
      this.interval = REPEAT_START;
      this.repeatAt = now + (this.fast ? FAST_INTERVAL : REPEAT_DELAY);
      return;
    }
    if (now < this.repeatAt) return;
    this.handlers.onMove(dx, dy);
    if (this.fast) {
      this.repeatAt = now + FAST_INTERVAL;
    } else {
      this.repeatAt = now + this.interval;
      this.interval = Math.max(REPEAT_MIN, this.interval * REPEAT_ACCEL);
    }
  }

  update(now: number) {
    this.pollGamepad();
    this.step(now);
  }

  private pollGamepad() {
    const pad = navigator.getGamepads?.().find((p) => p);
    if (!pad) { this.padDir = [0, 0]; return; }
    const b = (i: number) => !!pad.buttons[i]?.pressed;
    const ax = pad.axes[0] ?? 0, ay = pad.axes[1] ?? 0;
    const dx = (b(15) ? 1 : 0) - (b(14) ? 1 : 0) || (Math.abs(ax) > 0.5 ? Math.sign(ax) : 0);
    const dy = (b(13) ? 1 : 0) - (b(12) ? 1 : 0) || (Math.abs(ay) > 0.5 ? Math.sign(ay) : 0);
    const pressed = (dx !== 0 || dy !== 0) && (Math.abs(dx) > Math.abs(this.padDir[0]) || Math.abs(dy) > Math.abs(this.padDir[1]));
    this.padDir = [dx, dy];
    if (pressed) this.step(performance.now(), true);
    this.fast = this.fast || b(PAD_FAST);
    for (const [i, action] of Object.entries(PAD_BUTTONS)) {
      const now = b(Number(i));
      if (now && !this.padPrev[Number(i)]) this.handlers.onAction(action);
      this.padPrev[Number(i)] = now;
    }
    if (!b(PAD_FAST) && this.padPrev[PAD_FAST]) this.fast = false;
    this.padPrev[PAD_FAST] = b(PAD_FAST);
  }
}
