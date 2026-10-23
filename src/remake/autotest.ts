// 自动测试：我方也交给 AI 操作，剧情自动跳过、演出快进，一直打到过关 / 失败 / 回合上限。
// 每个行动后检查一遍状态（位置重叠、出界、HP / SP 越界、卡住不动），收集报错，最后出报告。
// 只在开发时用：控制台 game.autoplay()，或者地址加 ?autoplay（可带 &turns=30&speed=8&battle=full）。
// 自动测试期间不写存档、默认静音。
import type { Stage, Unit } from "./data.ts";

export interface AutoOptions {
  turns?: number; // 回合上限
  speed?: number; // 演出倍速
  battle?: "full" | "simple"; // 战斗演出，默认按设置
  mute?: boolean;
}

export interface AutoReport {
  stage: number;
  result: string;
  turns: number;
  actions: number;
  battles: number;
  kills: { player: number; enemy: number };
  spirits: number;
  scenes: number;
  seconds: number;
  problems: string[];
}

const STALL_SECONDS = 45;

export class AutoTester {
  readonly turns: number;
  readonly speed: number;
  readonly battle?: "full" | "simple";
  readonly mute: boolean;
  actions = 0;
  battles = 0;
  spirits = 0;
  scenes = 0;
  kills = { player: 0, enemy: 0 };
  problems: string[] = [];
  done: Promise<AutoReport>;
  private resolve!: (r: AutoReport) => void;
  private started = performance.now();
  private lastProgress = performance.now();
  private watchdog: number;
  private panel: HTMLElement;
  private finished = false;
  private stage: Stage;
  private status: () => { turn: number; mode: string };

  constructor(stage: Stage, opts: AutoOptions, status: () => { turn: number; mode: string }) {
    this.stage = stage;
    this.status = status;
    this.turns = opts.turns ?? 40;
    this.speed = opts.speed ?? 8;
    this.battle = opts.battle;
    this.mute = opts.mute ?? true;
    this.done = new Promise((r) => (this.resolve = r));
    addEventListener("error", this.onError);
    addEventListener("unhandledrejection", this.onRejection);
    this.panel = document.createElement("div");
    this.panel.id = "autotest";
    document.body.append(this.panel);
    this.watchdog = window.setInterval(() => {
      this.render();
      const idle = (performance.now() - this.lastProgress) / 1000;
      if (idle > STALL_SECONDS) this.finish(`卡住：${Math.round(idle)} 秒没有进展（模式 ${this.status().mode}）`);
    }, 1000);
    this.render();
  }

  private onError = (e: ErrorEvent) => this.problem(`报错：${e.message} @ ${e.filename?.split("/").pop()}:${e.lineno}`);
  private onRejection = (e: PromiseRejectionEvent) => this.problem(`未处理的异常：${e.reason?.stack ?? e.reason}`);

  problem(text: string) {
    if (this.problems.length < 200 && !this.problems.includes(text)) this.problems.push(`[第 ${this.status().turn} 回合] ${text}`);
    console.warn("[自动测试]", text);
    this.render();
  }

  progress() {
    this.lastProgress = performance.now();
  }

  // 每个行动之后：检查所有单位的状态
  check(units: Unit[]) {
    this.actions++;
    this.progress();
    const map = this.stage.map;
    const seen = new Map<string, Unit>();
    for (const u of units) {
      if (u.hp <= 0) continue;
      const where = `${u.name}(${u.x},${u.y})`;
      if (!Number.isInteger(u.x) || !Number.isInteger(u.y) || u.x < 0 || u.y < 0 || u.x >= map.width || u.y >= map.height) this.problem(`${where} 坐标不对`);
      const k = `${u.x},${u.y}`;
      const other = seen.get(k);
      if (other) this.problem(`${where} 和 ${other.name} 重叠`);
      seen.set(k, u);
      if (u.hp > u.maxHp) this.problem(`${where} HP ${u.hp} 超过上限 ${u.maxHp}`);
      if (u.sp < 0 || u.sp > u.maxSp) this.problem(`${where} SP ${u.sp} 越界（上限 ${u.maxSp}）`);
      if (!u.weapons.length) this.problem(`${where} 没有武器`);
      if (!u.name) this.problem(`单位 ${u.unitId} 没有名字`);
    }
  }

  finish(result: string) {
    if (this.finished) return;
    this.finished = true;
    clearInterval(this.watchdog);
    removeEventListener("error", this.onError);
    removeEventListener("unhandledrejection", this.onRejection);
    const report: AutoReport = {
      stage: this.stage.number,
      result,
      turns: this.status().turn,
      actions: this.actions,
      battles: this.battles,
      kills: this.kills,
      spirits: this.spirits,
      scenes: this.scenes,
      seconds: Math.round((performance.now() - this.started) / 1000),
      problems: this.problems,
    };
    console.log("[自动测试] 报告", report);
    // 连着打好几关（&chain）时整页会重载，每关的结果记下来，最后一起看：sessionStorage「srw2-remake:autolog」
    try {
      const log = JSON.parse(sessionStorage.getItem("srw2-remake:autolog") ?? "[]");
      log.push({ stage: report.stage, result: report.result, turns: report.turns, kills: report.kills, seconds: report.seconds, problems: report.problems });
      sessionStorage.setItem("srw2-remake:autolog", JSON.stringify(log));
    } catch { /* 存不了就算了 */ }
    this.render(report);
    this.resolve(report);
  }

  private render(report?: AutoReport) {
    const s = this.status();
    const problems = this.problems.map((p) => `<li>${p}</li>`).join("");
    this.panel.innerHTML = `
      <b>自动测试${report ? ` · ${report.result}` : " 进行中"}</b>
      <span>第 ${this.stage.number} 关 · 回合 ${s.turn}/${this.turns} · 行动 ${this.actions} · 战斗 ${this.battles} · 击破 敌 ${this.kills.enemy} / 我 ${this.kills.player} · 精神 ${this.spirits} · 剧情 ${this.scenes}</span>
      <span class="${this.problems.length ? "bad" : "ok"}">${this.problems.length ? `问题 ${this.problems.length} 个` : "没有发现问题"}${report ? ` · 用时 ${report.seconds} 秒` : ""}</span>
      ${problems ? `<ul>${problems}</ul>` : ""}`;
  }
}
