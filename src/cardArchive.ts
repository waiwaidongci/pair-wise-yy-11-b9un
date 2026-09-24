// 卡片存档：预约单登记与瓶号查重、按领瓶时点编排唯一充填位、
// 临时储气组使用卡的锁定扣减，以及本地持久化与归档快照。

import type { BankState, FillRequest, GasMix, ValveThread } from "./gasPlanner";
import { bankDrawL, bankUsableL, checkThread, isInspectionExpired, planBlend } from "./gasPlanner";

export interface RegRow {
  tankNo: string; // 瓶号
  volumeL: number; // 容积 L
  residualBar: number; // 残压 bar
  targetBar: number; // 目标压力 bar
  mix: GasMix; // 目标混合气
  thread: ValveThread; // 瓶阀螺纹
  pickupAt: string; // 领瓶时点 HH:mm
  deadline: string; // 限时 HH:mm
  inspectionUntil: string; // 检验有效期 YYYY-MM-DD
  operator: string; // 操作员
}

export interface BookingOrder {
  id: string;
  customer: string;
  rows: RegRow[];
}

export interface CardEntry {
  orderId: string;
  tankNo: string;
  drawL: number; // 占用储气组的自由气体升数
  at: string; // 锁定时刻 HH:mm
}

export interface BankCard extends BankState {
  id: string;
  entries: CardEntry[]; // 一经登记即锁定，任何情况下不得挤掉
}

export interface PlannedRow extends RegRow {
  orderId: string;
  customer: string;
  rowNo: number; // 预约单内行号（从 1 起）
  slotNo: number | null; // 唯一充填位；送检区为 null
  source: "储气组" | "备用气源" | null;
  locked: boolean;
  notes: string[];
}

export interface PlanResult {
  queue: PlannedRow[]; // 按充填位排序
  inspection: PlannedRow[]; // 送检区
  card: BankCard; // 扣减后的卡（含新锁定条目）
}

const toRequest = (r: RegRow): FillRequest => ({
  volumeL: r.volumeL,
  residualBar: r.residualBar,
  targetBar: r.targetBar,
  mix: r.mix,
  thread: r.thread,
});

const normTank = (s: string) => s.trim().toUpperCase();

export type AddRowResult =
  | { ok: true; order: BookingOrder }
  | { ok: false; reason: "duplicate"; tankNo: string; conflictRowNo: number }
  | { ok: false; reason: "invalid"; issues: string[] };

/** 登记一行：同一预约单内瓶号重录则挡住并指出原行号；配气不成立同样挡住 */
export function addRowToOrder(order: BookingOrder, row: RegRow): AddRowResult {
  const idx = order.rows.findIndex((r) => normTank(r.tankNo) === normTank(row.tankNo));
  if (idx >= 0) return { ok: false, reason: "duplicate", tankNo: row.tankNo, conflictRowNo: idx + 1 };
  const issues = planBlend(toRequest(row)).issues;
  if (issues.length) return { ok: false, reason: "invalid", issues };
  return { ok: true, order: { ...order, rows: [...order.rows, row] } };
}

/** 夜班排序键：从 18:00 起算，跨零点的时点排在深夜之后 */
function nightKey(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (((h * 60 + m - 18 * 60) % 1440) + 1440) % 1440;
}

/**
 * 编排充填位并划拨气源：
 * 1. 检验过期瓶不进队列，留在送检区；
 * 2. 其余按领瓶时点排出唯一充填位；
 * 3. 已锁定在卡上的瓶保持不动；新瓶按充填位顺序试排储气组，
 *    余压不足则保留限时、改排备用气源，绝不挤掉已锁定的卡片。
 */
export function planQueue(orders: BookingOrder[], card: BankCard, today: string, now: string): PlanResult {
  const flat = orders.flatMap((o) => o.rows.map((r, i) => ({ ...r, orderId: o.id, customer: o.customer, rowNo: i + 1 })));
  const lockedKeys = new Map(card.entries.map((e) => [`${e.orderId}|${normTank(e.tankNo)}`, e]));

  const inspection: PlannedRow[] = [];
  const fillable: PlannedRow[] = [];
  for (const r of flat) {
    const base: PlannedRow = { ...r, slotNo: null, source: null, locked: false, notes: [] };
    if (isInspectionExpired(r.inspectionUntil, today)) {
      inspection.push({ ...base, notes: [`检验 ${r.inspectionUntil} 已过期，留在送检区`] });
      continue;
    }
    const warn = checkThread(r.thread, r.targetBar, r.mix);
    if (warn) base.notes.push(`螺纹提示：${warn}`);
    fillable.push(base);
  }

  fillable.sort((a, b) => nightKey(a.pickupAt) - nightKey(b.pickupAt) || a.orderId.localeCompare(b.orderId) || a.rowNo - b.rowNo);

  let residual = card.residualBar;
  const newEntries: CardEntry[] = [];
  const queue = fillable.map((r, i) => {
    const row: PlannedRow = { ...r, slotNo: i + 1 };
    const key = `${row.orderId}|${normTank(row.tankNo)}`;
    if (lockedKeys.has(key)) {
      row.source = "储气组";
      row.locked = true;
      row.notes.push("储气组卡已锁定");
      return row;
    }
    const draw = bankDrawL(toRequest(row));
    const usable = bankUsableL({ capacityL: card.capacityL, residualBar: residual }, row.targetBar);
    if (draw <= usable) {
      row.source = "储气组";
      row.locked = true;
      residual = Math.round((residual - draw / card.capacityL) * 10) / 10;
      newEntries.push({ orderId: row.orderId, tankNo: row.tankNo, drawL: draw, at: now });
      row.notes.push("登记即锁定储气组卡");
    } else {
      row.source = "备用气源";
      row.notes.push(`储气组余压不足（需 ${draw}L／可用 ${usable}L），保留限时 ${row.deadline} 改排备用气源`);
    }
    return row;
  });

  return { queue, inspection, card: { ...card, residualBar: residual, entries: [...card.entries, ...newEntries] } };
}

// ---------- 持久化与归档 ----------

export interface DutyState {
  orders: BookingOrder[];
  card: BankCard;
}

const STATE_KEY = "hxyfront-62010:duty-state";
const ARCHIVE_KEY = "hxyfront-62010:card-archive";

export function loadState(): DutyState | null {
  try {
    const raw = localStorage.getItem(STATE_KEY);
    return raw ? (JSON.parse(raw) as DutyState) : null;
  } catch {
    return null;
  }
}

export function saveState(s: DutyState): void {
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify(s));
  } catch {
    /* 存储不可用时静默跳过 */
  }
}

export function clearAll(): void {
  try {
    localStorage.removeItem(STATE_KEY);
    localStorage.removeItem(ARCHIVE_KEY);
  } catch {
    /* ignore */
  }
}

export interface ArchiveSnapshot {
  at: string;
  cardId: string;
  residualBar: number;
  locked: number;
  summary: string;
}

export function loadArchive(): ArchiveSnapshot[] {
  try {
    const raw = localStorage.getItem(ARCHIVE_KEY);
    return raw ? (JSON.parse(raw) as ArchiveSnapshot[]) : [];
  } catch {
    return [];
  }
}

/** 卡片存档：新快照置顶，最多保留 20 条 */
export function pushArchive(snap: ArchiveSnapshot): ArchiveSnapshot[] {
  const list = [snap, ...loadArchive()].slice(0, 20);
  try {
    localStorage.setItem(ARCHIVE_KEY, JSON.stringify(list));
  } catch {
    /* ignore */
  }
  return list;
}

/** 演示数据：两张预约单，覆盖储气组锁定、备用气源、送检区三种走向 */
export function seedState(today: string, now: string): DutyState {
  const orders: BookingOrder[] = [
    {
      id: "BK-091",
      customer: "黑潮夜潜队",
      rows: [
        { tankNo: "TANK-204", volumeL: 12, residualBar: 55, targetBar: 200, mix: { o2: 21, he: 0 }, thread: "G3/4", pickupAt: "21:30", deadline: "23:00", inspectionUntil: "2027-03-01", operator: "阿海" },
        { tankNo: "TANK-219", volumeL: 11, residualBar: 30, targetBar: 200, mix: { o2: 32, he: 0 }, thread: "G3/4", pickupAt: "21:45", deadline: "23:30", inspectionUntil: "2026-12-01", operator: "阿海" },
        { tankNo: "TANK-231", volumeL: 12, residualBar: 10, targetBar: 200, mix: { o2: 21, he: 0 }, thread: "YOKE", pickupAt: "22:10", deadline: "00:30", inspectionUntil: "2025-08-01", operator: "小棠" },
      ],
    },
    {
      id: "BK-092",
      customer: "蓝洞技术潜水",
      rows: [
        { tankNo: "TANK-305", volumeL: 24, residualBar: 80, targetBar: 300, mix: { o2: 21, he: 35 }, thread: "M25x2", pickupAt: "22:00", deadline: "01:00", inspectionUntil: "2027-06-30", operator: "小棠" },
        { tankNo: "TANK-317", volumeL: 12, residualBar: 60, targetBar: 200, mix: { o2: 36, he: 0 }, thread: "G3/4", pickupAt: "22:20", deadline: "01:30", inspectionUntil: "2027-01-15", operator: "阿海" },
      ],
    },
  ];
  const card: BankCard = { id: "临卡-01", capacityL: 50, residualBar: 260, entries: [] };
  const plan = planQueue(orders, card, today, now);
  return { orders, card: plan.card };
}
