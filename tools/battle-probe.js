// 战斗探针：从「已选好目标、按 A 即开战」的存档出发，可先改 RAM，再自动按 A 打完一场战斗，
// 记录战前预测（$DB-$E2）、每次出手（谁打谁、命中率、随机数、伤害）、HP 变化、经验和资金。
//
// 用法: node tools/battle-probe.js <存档.json> [ADDR=VAL ...] [--frames N] [--json]
// 注意：一直按 A 会在战斗结束后继续操作地图（帧数太多可能结束回合进入敌方阶段），默认 1500 帧
// 例:   node tools/battle-probe.js extracted/states/t4.json 769C=60 --json
// 也可 import { probeBattle } 在测试脚本里用。
import { makeEmu, hex, trackBanks, hookExec, hookWrite } from "./lib/trace.js";

const RAND_ENTRY = 0xc39b, RAND_EXIT = 0xc3b5; // rand(N)：A=N 进入，A=结果返回
const ATTACK_EXEC = 0x8b23;                     // bank 6：执行一次出手，$E8=攻方侧 $E9=守方侧
const PRECALC_ATTACK = 0x883c;                  // bank 4：攻方预测刚存好
const PRECALC_COUNTER = [0x884c, 0x88ad];        // bank 4：不反击 / 反击武器已选好

export function probeBattle(statePath, pokes = {}, { frames = 1500, period = 40 } = {}) {
  const emu = makeEmu(statePath);
  const nes = emu.nes, cpu = nes.cpu, m = cpu.mem;
  for (const [a, v] of Object.entries(pokes)) m[Number(a)] = v;
  const slots = trackBanks(nes);
  const bankOf = (pc) => (pc >= 0x8000 ? slots[(pc - 0x8000) >> 13] : -1);
  const out = { preview: null, rolls: [], attacks: [], hp: [], exp: null, money: null };
  let pendingRand = null, cur = null;
  const unitOf = (side) => m[0xd1 + side];
  hookExec(nes, (pc) => {
    if (pc === RAND_ENTRY) pendingRand = cpu.REG_ACC;
    else if (pc === RAND_EXIT && pendingRand !== null) {
      out.rolls.push({ n: pendingRand, r: cpu.REG_ACC });
      if (cur && pendingRand === 100) cur.rolls.push(cpu.REG_ACC);
      pendingRand = null;
    } else if (pc === ATTACK_EXEC && bankOf(pc) === 6) {
      cur = {
        attacker: unitOf(m[0xe8]), defender: unitOf(m[0xe9]),
        damage: m[0xf0] | (m[0xf1] << 8), hit: m[0xf2], rolls: [],
        hpBefore: m[0x76b7 + unitOf(m[0xe9])] | (m[0x76d7 + unitOf(m[0xe9])] << 8),
      };
      out.attacks.push(cur);
    } else if (pc === PRECALC_ATTACK && bankOf(pc) === 4 && !out.preview) {
      out.preview = {
        attacker: m[0xd1], defender: m[0xd2], weapon: m[0xd7],
        atk: { flags: m[0xe1], hit: m[0xdf], damage: m[0xdb] | (m[0xdd] << 8) },
      };
    } else if (PRECALC_COUNTER.includes(pc) && bankOf(pc) === 4 && out.preview && !out.preview.def) {
      out.preview.def = { flags: m[0xe2], hit: m[0xe0], damage: m[0xdc] | (m[0xde] << 8), weapon: m[0xd8] };
    }
  });
  hookWrite(nes, (a, v) => {
    if (a >= 0x76d7 && a < 0x76f7) {
      const u = a - 0x76d7;
      out.hp.push({ unit: u, hp: m[0x76b7 + u] | (v << 8) });
    }
  });
  const exp0 = Array.from(m.slice(0x74ec, 0x74fc)).map((lo, i) => lo | (m[0x74fc + i] << 8));
  const money0 = m[0x743a] | (m[0x743b] << 8);
  for (let f = 0; f < frames; f++) {
    if (f % period === 0) nes.buttonDown(1, 0);
    if (f % period === 6) nes.buttonUp(1, 0);
    nes.frame();
  }
  out.expGain = Array.from(m.slice(0x74ec, 0x74fc)).map((lo, i) => (lo | (m[0x74fc + i] << 8)) - exp0[i]);
  out.moneyGain = (m[0x743a] | (m[0x743b] << 8)) - money0;
  for (const a of out.attacks) a.hitResult = a.rolls.length ? a.rolls[0] < a.hit : null;
  out.final = { emu };
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const pokes = {};
  let frames = 1500, json = false;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--frames") frames = Number(args[++i]);
    else if (args[i] === "--json") json = true;
    else { const [a, v] = args[i].split("="); pokes[parseInt(a, 16)] = parseInt(v, 16); }
  }
  const r = probeBattle(args[0], pokes, { frames });
  delete r.final;
  if (json) console.log(JSON.stringify(r));
  else {
    console.log("预测", JSON.stringify(r.preview));
    for (const a of r.attacks) console.log(`出手 ${a.attacker}→${a.defender} 命中率${a.hit} 伤害${a.damage} 随机数${a.rolls.join(",")} ${a.hitResult ? "命中" : "未中"} (守方HP ${a.hpBefore})`);
    console.log("rand 调用", r.rolls.map((x) => `${x.n}:${x.r}`).join(" "));
    console.log("经验", r.expGain.map((v, i) => (v ? `${i}:+${v}` : "")).filter(Boolean).join(" "), "资金 +", r.moneyGain);
  }
}
