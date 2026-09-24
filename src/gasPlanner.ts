// 业务文件一：配气判断
// 混合气比例校验 / 提示、检验过期判定、按领瓶时点排唯一充填位、
// 储气组余压核算与备用气源改排（不动已锁定的使用卡）。

import type {
  BankState,
  CardEvent,
  CardLock,
  FillEntry,
  GasMix,
} from "./types";

export const TARGET_BAR = 200; // 统一目标压力
export const BANK_MARGIN_BAR = 10; // 储气组供气需高出的压差
export const SHIFT_START_HOUR = 18; // 夜班时间轴从 18:00 起算
export const FLEET_DEPARTURE = "06:00"; // 夜潜车队出海时间

// ---------- 混合气判断 ----------

export function mixKind(mix: GasMix): "air" | "nitrox" | "trimix" {
  if (mix.he > 0) return "trimix";
  return mix.o2 > 21 ? "nitrox" : "air";
}

export function mixLabel(mix: GasMix): string {
  const kind = mixKind(mix);
  if (kind === "trimix") return `Trimix ${mix.o2}/${mix.he}`;
  if (kind === "nitrox") return `EAN${mix.o2}`;
  return "空气 21%";
}

/** 比例校验：返回错误文案（应挡住登记），合法返回 null */
export function validateMix(mix: GasMix): string | null {
  const { o2, he } = mix;
  if (!Number.isFinite(o2) || !Number.isFinite(he)) return "氧/氦含量需为数字";
  if (he < 0 || o2 <= 0 || o2 + he > 100) return "氧+氦比例须落在 0–100%";
  if (he === 0 && o2 < 21) return "非氦混合气氧含量不得低于 21%";
  if (o2 > 40) return "氧含量超过 40%，夜班不配（需氧洁设备）";
  if (he > 0 && o2 < 16) return "Trimix 氧含量不得低于 16%";
  return null;
}

/** 比例提示：不阻挡登记，仅在队列中提醒 */
export function mixHints(mix: GasMix): string[] {
  const hints: string[] = [];
  const fo2 = mix.o2 / 100;
  if (fo2 > 0) {
    hints.push(`MOD≈${Math.floor((1.4 / fo2 - 1) * 10)}m（ppO₂ 1.4）`);
  }
  if (mix.he === 0 && mix.o2 > 21) hints.push("高氧：瓶身贴 EAN 标");
  if (mix.he > 0 && mix.o2 < 21) hints.push("低氧混合气，水面不可呼吸");
  if (mix.he > 0) hints.push(`氮含量 ${100 - mix.o2 - mix.he}%`);
  return hints;
}

// ---------- 检验与夜班时间轴 ----------

/** 检验过期判定（过期瓶留送检区，不进充填队列） */
export function isInspectionExpired(until: string, today = new Date()): boolean {
  const d = new Date(`${until}T23:59:59`);
  return Number.isNaN(d.getTime()) || d.getTime() < today.getTime();
}

/** 夜班时间轴：18:00 起算、跨零点顺延，用于按领瓶时点排序 */
export function nightTimeKey(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  const mins = (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
  return (mins - SHIFT_START_HOUR * 60 + 1440) % 1440;
}

/** 储气组可外供的最低余压 */
export function neededBankBar(): number {
  return TARGET_BAR + BANK_MARGIN_BAR;
}

// ---------- 排位与气源调度 ----------

export interface PlanResult {
  entries: FillEntry[];
  lock: CardLock | null;
  events: CardEvent[];
  bankAfter: number; // 预计本轮排完后储气组余压
}

/**
 * 按领瓶时点排出唯一充填位，并核算气源：
 * - 余压足够 → 储气组；不足 → 保留限时，改排备用气源；
 * - 全场只有一张临时使用卡，已锁定的卡片不被挤掉；
 * - 无锁定时，由排位最前的储气组瓶持卡。
 */
export function planQueue(
  entries: FillEntry[],
  bank: BankState,
  currentLock: CardLock | null,
  now = new Date(),
): PlanResult {
  const events: CardEvent[] = [];
  const at = now.toISOString();

  const active = entries
    .filter((e) => e.status === "queued")
    .sort(
      (a, b) =>
        nightTimeKey(a.deadline) - nightTimeKey(b.deadline) ||
        a.id.localeCompare(b.id),
    );

  // 唯一充填位
  const slotOf = new Map<string, number>();
  active.forEach((e, i) => slotOf.set(e.id, i + 1));

  // 已锁定的卡片：持卡瓶仍在队列中就必须保留
  let lock: CardLock | null =
    currentLock && active.some((e) => e.id === currentLock.entryId)
      ? currentLock
      : null;
  if (currentLock && !lock) {
    events.push({
      at,
      action: "release",
      entryId: currentLock.entryId,
      cylinderId: currentLock.cylinderId,
      detail: "持卡瓶已离场，临时使用卡释放",
    });
  }

  let pressure = bank.remainingBar;
  // 压力模拟必须按充填位顺序进行（登记顺序 ≠ 领瓶时点顺序）
  const plannedActive = active.map((entry) => {
    const slot = slotOf.get(entry.id)!;

    // 持卡瓶固定走储气组，任何情况下不被改排
    if (lock && entry.id === lock.entryId) {
      const low = pressure < neededBankBar();
      pressure -= bank.perFillDrop;
      return {
        ...entry,
        slot,
        source: "bank" as const,
        note: low
          ? `持有临时使用卡（余压 ${pressure + bank.perFillDrop}bar 偏低，卡已锁定优先保障）`
          : "持有临时使用卡",
      };
    }

    if (pressure >= neededBankBar() && pressure - bank.perFillDrop >= bank.reserveBar) {
      pressure -= bank.perFillDrop;
      return { ...entry, slot, source: "bank" as const, note: "" };
    }

    // 余压不足：保留限时，改排备用气源
    return {
      ...entry,
      slot,
      source: "backup" as const,
      note: `储气组余压不足（需≥${neededBankBar()}bar），保留限时 ${entry.deadline}，改排备用气源`,
    };
  });

  const plannedById = new Map(plannedActive.map((e) => [e.id, e]));
  const planned = entries.map((entry) => {
    if (entry.status !== "queued") {
      return { ...entry, slot: null, source: entry.status === "done" ? entry.source : null };
    }
    return plannedById.get(entry.id)!;
  });

  // 改排留档：原走储气组、本轮被改到备用气源的瓶
  for (const entry of planned) {
    const before = entries.find((e) => e.id === entry.id);
    if (
      entry.status === "queued" &&
      entry.source === "backup" &&
      before?.source === "bank" &&
      before.id !== lock?.entryId
    ) {
      events.push({
        at,
        action: "reroute",
        entryId: entry.id,
        cylinderId: entry.cylinderId,
        detail: `余压不足改排备用气源，限时 ${entry.deadline} 保留（充填位 #${entry.slot} 不变）`,
      });
    }
  }

  // 无锁定时，排位最前的储气组瓶持卡
  if (!lock) {
    const first = plannedActive.find((e) => e.source === "bank");
    if (first) {
      lock = {
        entryId: first.id,
        cylinderId: first.cylinderId,
        lockedAt: at,
      };
      first.note = "持有临时使用卡";
      events.push({
        at,
        action: "lock",
        entryId: first.id,
        cylinderId: first.cylinderId,
        detail: `锁定临时使用卡（充填位 #${first.slot}）`,
      });
    }
  }

  return { entries: planned, lock, events, bankAfter: pressure };
}
