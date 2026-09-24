// 夜班充填排程 —— 共享领域类型

/** 瓶阀螺纹 */
export type ValveThread = "M25×2" | "G3/4" | "3/4-NPSM";

/** 目标混合气（体积百分比） */
export interface GasMix {
  o2: number; // 氧含量 %
  he: number; // 氦含量 %
}

export type EntryStatus = "queued" | "done" | "inspection";

/** 气源：bank = 高压储气组（需占用使用卡），backup = 备用气源 */
export type GasSource = "bank" | "backup";

/** 一条充填登记（预约单中的一行） */
export interface FillEntry {
  id: string;
  bookingId: string; // 所属预约单号
  rowNo: number; // 在预约单中的行号（从 1 开始）
  cylinderId: string; // 瓶号
  deadline: string; // 限时 / 领瓶时点，"HH:MM"
  mix: GasMix; // 目标混合气
  thread: ValveThread; // 瓶阀螺纹
  inspectionUntil: string; // 检验有效期 YYYY-MM-DD
  status: EntryStatus;
  source: GasSource | null; // 排出的气源
  slot: number | null; // 充填位（按领瓶时点排出的唯一序号）
  note: string; // 调度备注
}

/** 预约单 */
export interface Booking {
  id: string;
  customer: string;
  createdAt: string;
}

/** 高压储气组状态 */
export interface BankState {
  remainingBar: number; // 余压
  reserveBar: number; // 安全下限（低于此不再外供）
  perFillDrop: number; // 每充一瓶余压下降
}

/** 临时使用卡当前锁定 */
export interface CardLock {
  entryId: string;
  cylinderId: string;
  lockedAt: string; // ISO 时间
}

export type CardEventAction = "lock" | "release" | "reroute" | "inspect";

/** 卡片存档条目：使用卡每一次流转都留档 */
export interface CardEvent {
  at: string; // ISO 时间
  action: CardEventAction;
  entryId: string;
  cylinderId: string;
  detail: string;
}

/** 值班台全量状态 */
export interface ShopState {
  bookings: Booking[];
  entries: FillEntry[];
  bank: BankState;
  cardLock: CardLock | null;
  archive: CardEvent[]; // 卡片存档（新的在前）
}
