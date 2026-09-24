// 配气判断：目标混合气配比、瓶阀螺纹校验、储气组余压核算。
// 全部为纯函数，不依赖界面与存档，供卡片存档与值班界面调用。

export interface GasMix {
  o2: number; // 氧含量 %
  he: number; // 氦含量 %
}

export const AIR: GasMix = { o2: 21, he: 0 };

export type ValveThread = "G3/4" | "M25x2" | "YOKE";

export const THREADS: { id: ValveThread; label: string; maxBar: number }[] = [
  { id: "G3/4", label: "G3/4 · DIN 232bar", maxBar: 232 },
  { id: "M25x2", label: "M25×2 · DIN 300bar", maxBar: 300 },
  { id: "YOKE", label: "YOKE · INT 232bar", maxBar: 232 },
];

export interface FillRequest {
  volumeL: number; // 瓶容积 L
  residualBar: number; // 瓶内残压 bar
  targetBar: number; // 目标压力 bar
  mix: GasMix; // 目标混合气
  thread: ValveThread; // 瓶阀螺纹
}

export interface BankState {
  capacityL: number; // 储气组水容积 L
  residualBar: number; // 储气组余压 bar
}

export const round1 = (n: number) => Math.round(n * 10) / 10;

/** 混合气名称：空气 / 高氧 EANxx / Trimix xx/xx */
export function mixLabel(mix: GasMix): string {
  if (mix.he > 0) return `Trimix ${mix.o2}/${mix.he}`;
  if (mix.o2 === 21) return "空气";
  if (mix.o2 < 21) return `低氧 ${mix.o2}%`;
  if (mix.o2 < 40) return `高氧 EAN${mix.o2}`;
  return `富氧 ${mix.o2}%`;
}

export interface BlendStep {
  gas: "氦气" | "纯氧" | "空气";
  addBar: number; // 本步加入的表压
  toBar: number; // 加完后的表压
}

export interface BlendPlan {
  steps: BlendStep[];
  issues: string[];
}

/**
 * 分压配气：瓶内残气按空气计，依次加氦、加纯氧，最后空气补至目标压力。
 * 纯氧量 = (目标压力 × (氧% − 21) + 21 × 氦量) / 79。
 */
export function planBlend(req: FillRequest): BlendPlan {
  const { residualBar: p0, targetBar: p1, mix } = req;
  const issues: string[] = [];
  if (mix.o2 + mix.he > 100) issues.push("氧+氦超过 100%，混合气不成立");
  if (p1 <= p0) issues.push(`残压 ${p0}bar 已不低于目标 ${p1}bar，无需充填`);

  const heBar = (p1 * mix.he) / 100;
  const o2Raw = (p1 * (mix.o2 - 21) + 21 * heBar) / 79;
  if (o2Raw < -0.5) issues.push("目标氧含量过低，残气与氦气已超出，无法用空气配平");
  const o2Bar = Math.max(0, o2Raw);
  const airBar = p1 - p0 - heBar - o2Bar;
  if (airBar < -0.5) issues.push("残压过高，扣除氦/氧后没有空气补压空间");

  const steps: BlendStep[] = [];
  let acc = p0;
  if (heBar > 0.05) {
    acc += heBar;
    steps.push({ gas: "氦气", addBar: round1(heBar), toBar: round1(acc) });
  }
  if (o2Bar > 0.05) {
    acc += o2Bar;
    steps.push({ gas: "纯氧", addBar: round1(o2Bar), toBar: round1(acc) });
  }
  if (airBar > 0.05) {
    steps.push({ gas: "空气", addBar: round1(Math.max(0, airBar)), toBar: p1 });
  }
  return { steps, issues };
}

/** 配比提示，如「氦气 105bar → 纯氧 27.9bar → 空气补至 300bar」 */
export function blendHint(req: FillRequest): string {
  const plan = planBlend(req);
  if (plan.issues.length) return plan.issues[0];
  if (!plan.steps.length) return "无需充填";
  return plan.steps
    .map((s, i) => (i === plan.steps.length - 1 && s.gas === "空气" ? `空气补至 ${s.toBar}bar` : `${s.gas} ${s.addBar}bar`))
    .join(" → ");
}

/** 本瓶需从储气组取走的自由气体升数（仅空气补压段；氦/氧由专用气瓶供给） */
export function bankDrawL(req: FillRequest): number {
  const p1 = req.targetBar;
  const heBar = (p1 * req.mix.he) / 100;
  const o2Bar = Math.max(0, (p1 * (req.mix.o2 - 21) + 21 * heBar) / 79);
  const airBar = Math.max(0, p1 - req.residualBar - heBar - o2Bar);
  return round1(airBar * req.volumeL);
}

/** 级联直充可用气量：储气组余压高于目标压力的部分才放得出来 */
export function bankUsableL(bank: BankState, targetBar: number): number {
  return round1(bank.capacityL * Math.max(0, bank.residualBar - targetBar));
}

/** 瓶阀螺纹校验：超螺纹耐压、或富氧配 YOKE，返回提示；否则 null */
export function checkThread(thread: ValveThread, targetBar: number, mix: GasMix): string | null {
  const spec = THREADS.find((t) => t.id === thread);
  if (spec && targetBar > spec.maxBar) return `目标 ${targetBar}bar 超出 ${thread} 螺纹 ${spec.maxBar}bar 上限`;
  if (mix.o2 > 40 && thread === "YOKE") return "氧含量超过 40% 禁用 YOKE 接口";
  return null;
}

/** 检验是否过期（ISO 日期字符串比较，today 当日即视为未过期） */
export function isInspectionExpired(validUntil: string, today: string): boolean {
  return validUntil < today;
}
