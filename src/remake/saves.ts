// 存档：自动存档（每个我方回合开始）+ 3 个手动存档位。存在浏览器的 IndexedDB 里
// （带截图的存档有几十 KB，localStorage 不够稳）。
import type { RosterMember, Unit } from "./data.ts";
import type { EventsState } from "./events.ts";

export const SAVE_VERSION = 1;
export type SlotId = "auto" | 1 | 2 | 3;
export const SLOTS: SlotId[] = ["auto", 1, 2, 3];

export interface SaveData {
  version: number;
  stage: number;
  turn: number;
  money: number;
  // 强化零件持有数（按零件号；旧存档没有，读成全 0）
  items?: number[];
  units: Unit[];
  roster: RosterMember[];
  events: EventsState;
  rng: { mem: number[]; index: number };
  songs: { player: number; enemy: number };
  jamming: boolean;
  // 本关交过手的敌方机体编号（旧存档没有，读成空）
  scouted?: number[];
}

export interface SaveMeta {
  slot: SlotId;
  savedAt: number;
  stage: number;
  turn: number;
  title: string;
  thumb: string;
}

const DB = "srw2-remake";
const STORE = "saves";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const req = fn(db.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function writeSave(slot: SlotId, data: SaveData, meta: Omit<SaveMeta, "slot" | "savedAt">) {
  await run("readwrite", (s) => s.put(data, `data:${slot}`));
  await run("readwrite", (s) => s.put({ ...meta, slot, savedAt: Date.now() }, `meta:${slot}`));
}

export async function readSave(slot: SlotId): Promise<SaveData | null> {
  const d = (await run("readonly", (s) => s.get(`data:${slot}`))) as SaveData | undefined;
  return d && d.version === SAVE_VERSION ? d : null;
}

export async function listSaves(): Promise<SaveMeta[]> {
  const out: SaveMeta[] = [];
  for (const slot of SLOTS) {
    const m = (await run("readonly", (s) => s.get(`meta:${slot}`))) as SaveMeta | undefined;
    if (m) out.push(m);
  }
  return out;
}

// ---------- 导出 / 导入 ----------
// 存档和设置都存在浏览器里，而且按网址（包括端口）分开：换了端口就看不到原来的。
// 导出成一个 JSON 文件（所有存档 + 设置），在另一个网址导入，或者留作备份
const SETTINGS_KEY = "srw2-remake:settings";

export interface Backup { format: "srw2-remake-backup"; version: 1; exportedAt: number; settings: unknown; saves: Record<string, unknown> }

export async function exportAll(): Promise<Backup> {
  const db = await open();
  const saves = await new Promise<Record<string, unknown>>((resolve, reject) => {
    const out: Record<string, unknown> = {};
    const req = db.transaction(STORE, "readonly").objectStore(STORE).openCursor();
    req.onsuccess = () => {
      const c = req.result;
      if (!c) { resolve(out); return; }
      out[String(c.key)] = c.value;
      c.continue();
    };
    req.onerror = () => reject(req.error);
  });
  let settings: unknown = null;
  try { settings = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "null"); } catch { /* 没有设置 */ }
  return { format: "srw2-remake-backup", version: 1, exportedAt: Date.now(), settings, saves };
}

// 导入：同名的存档位被覆盖，设置整份换掉
export async function importAll(data: Backup) {
  if (data?.format !== "srw2-remake-backup") throw new Error("不是本游戏导出的文件");
  for (const [key, value] of Object.entries(data.saves ?? {})) await run("readwrite", (s) => s.put(value, key));
  if (data.settings) localStorage.setItem(SETTINGS_KEY, JSON.stringify(data.settings));
}

// 过关进下一关：带着名册（等级、经验、形态、零件加成）、资金、零件和全程标志整页重新载入，从下一关的开场开始。benched = 出击选择里留下待命的名册号
export interface NextStage { stage: number; roster: RosterMember[]; money: number; items?: number[]; benched?: number[]; flags?: number[] }
const NEXT = "srw2-remake:next";
export function requestNextStage(next: NextStage) {
  sessionStorage.setItem(NEXT, JSON.stringify(next));
  location.reload();
}
export function takeNextStage(): NextStage | null {
  const v = sessionStorage.getItem(NEXT);
  sessionStorage.removeItem(NEXT);
  try { return v ? (JSON.parse(v) as NextStage) : null; } catch { return null; }
}

// 读档时整页重新载入，用 sessionStorage 带上要读的存档位（干净地重建所有状态）
const PENDING = "srw2-remake:load";
export function requestLoad(slot: SlotId | "new") {
  sessionStorage.setItem(PENDING, String(slot));
  location.reload();
}
export function takePendingLoad(): SlotId | "new" | null {
  const v = sessionStorage.getItem(PENDING);
  sessionStorage.removeItem(PENDING);
  if (v === null) return null;
  if (v === "new" || v === "auto") return v;
  return Number(v) as SlotId;
}

export function describeTime(t: number) {
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
