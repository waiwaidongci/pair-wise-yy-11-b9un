// 业务文件二：卡片存档
// 临时高压储气组使用卡的锁定/释放/改排全部留档，
// 预约单与队列状态持久化到 localStorage。

import type { CardEvent, FillEntry, ShopState } from "./types";
import { isInspectionExpired } from "./gasPlanner";

const STORAGE_KEY = "hxyfront-62010.night-duty";
const ARCHIVE_LIMIT = 200;

export function loadState(): ShopState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as ShopState;
      if (Array.isArray(parsed.entries) && parsed.bank) return parsed;
    }
  } catch {
    // 存档损坏时回落到初始台账
  }
  return seedState();
}

export function saveState(state: ShopState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // 存储不可用时仅保留内存态
  }
}

export function resetState(): ShopState {
  const fresh = seedState();
  saveState(fresh);
  return fresh;
}

/** 卡片事件入档（新的在前，限量截断） */
export function appendArchive(state: ShopState, events: CardEvent[]): ShopState {
  if (events.length === 0) return state;
  return { ...state, archive: [...events, ...state.archive].slice(0, ARCHIVE_LIMIT) };
}

/** 送检区留档 */
export function inspectEvent(entry: FillEntry, now = new Date()): CardEvent {
  return {
    at: now.toISOString(),
    action: "inspect",
    entryId: entry.id,
    cylinderId: entry.cylinderId,
    detail: `检验有效期至 ${entry.inspectionUntil} 已过，留送检区`,
  };
}

// ---------- 初始台账 ----------

function seedEntry(
  id: string,
  bookingId: string,
  rowNo: number,
  cylinderId: string,
  deadline: string,
  o2: number,
  he: number,
  thread: FillEntry["thread"],
  inspectionUntil: string,
): FillEntry {
  const expired = isInspectionExpired(inspectionUntil);
  return {
    id,
    bookingId,
    rowNo,
    cylinderId,
    deadline,
    mix: { o2, he },
    thread,
    inspectionUntil,
    status: expired ? "inspection" : "queued",
    source: null,
    slot: null,
    note: expired ? "检验过期，留送检区" : "",
  };
}

function seedState(): ShopState {
  const entries: FillEntry[] = [
    seedEntry("E-01", "BK-0924-1", 1, "TANK-204", "23:30", 21, 0, "M25×2", "2027-03-01"),
    seedEntry("E-02", "BK-0924-1", 2, "TANK-219", "00:20", 32, 0, "G3/4", "2026-12-01"),
    seedEntry("E-03", "BK-0924-1", 3, "TANK-231", "01:10", 36, 0, "M25×2", "2027-01-15"),
    seedEntry("E-04", "BK-0924-2", 1, "TANK-118", "02:00", 18, 45, "3/4-NPSM", "2026-11-30"),
    seedEntry("E-05", "BK-0924-2", 2, "TANK-156", "03:40", 32, 0, "G3/4", "2027-06-30"),
    seedEntry("E-06", "BK-0924-2", 3, "TANK-077", "05:20", 21, 0, "M25×2", "2024-05-31"),
  ];
  return {
    bookings: [
      { id: "BK-0924-1", customer: "蓝鲸船宿队", createdAt: new Date().toISOString() },
      { id: "BK-0924-2", customer: "自由潜小组", createdAt: new Date().toISOString() },
    ],
    entries,
    bank: { remainingBar: 240, reserveBar: 60, perFillDrop: 10 },
    cardLock: null,
    archive: entries
      .filter((e) => e.status === "inspection")
      .map((e) => inspectEvent(e)),
  };
}
