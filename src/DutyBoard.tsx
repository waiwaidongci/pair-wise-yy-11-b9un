// 值班界面：夜班登记台。登记瓶号/限时/目标混合气/瓶阀螺纹，
// 展示充填位队列、储气组使用卡与送检区；业务判断在 gasPlanner，存档在 cardArchive。

import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import "./styles.css";
import type { ArchiveSnapshot, BookingOrder, DutyState, RegRow } from "./cardArchive";
import { addRowToOrder, clearAll, loadArchive, loadState, planQueue, pushArchive, saveState, seedState } from "./cardArchive";
import type { GasMix, ValveThread } from "./gasPlanner";
import { bankUsableL, blendHint, mixLabel, THREADS } from "./gasPlanner";

const pad = (n: number) => String(n).padStart(2, "0");
const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const nowHM = () => {
  const d = new Date();
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
/** 跨零点的时间加 (+1) 标记 */
const fmtNight = (hhmm: string) => (Number(hhmm.slice(0, 2)) < 12 ? `${hhmm}(+1)` : hhmm);

/** 明早六点出海：取下一个 06:00 */
function nextDeparture(now: Date): Date {
  const d = new Date(now);
  d.setHours(6, 0, 0, 0);
  if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
  return d;
}

const MIX_PRESETS: { id: string; label: string; mix: GasMix }[] = [
  { id: "air", label: "空气", mix: { o2: 21, he: 0 } },
  { id: "ean32", label: "高氧 EAN32", mix: { o2: 32, he: 0 } },
  { id: "ean36", label: "高氧 EAN36", mix: { o2: 36, he: 0 } },
  { id: "tx2135", label: "Trimix 21/35", mix: { o2: 21, he: 35 } },
  { id: "custom", label: "自定义", mix: { o2: 21, he: 0 } },
];

function DutyBoard() {
  const [state, setState] = useState<DutyState>(() => loadState() ?? seedState(todayStr(), nowHM()));
  const [archive, setArchive] = useState<ArchiveSnapshot[]>(() => loadArchive());
  const [now, setNow] = useState(() => new Date());

  // 表单
  const [orderChoice, setOrderChoice] = useState<string>(() => state.orders[0]?.id ?? "__new");
  const [newOrderId, setNewOrderId] = useState("");
  const [customer, setCustomer] = useState("");
  const [tankNo, setTankNo] = useState("");
  const [volumeL, setVolumeL] = useState("12");
  const [residualBar, setResidualBar] = useState("50");
  const [targetBar, setTargetBar] = useState("200");
  const [preset, setPreset] = useState("air");
  const [o2, setO2] = useState("21");
  const [he, setHe] = useState("0");
  const [thread, setThread] = useState<ValveThread>("G3/4");
  const [pickupAt, setPickupAt] = useState("21:30");
  const [deadline, setDeadline] = useState("23:00");
  const [inspectionUntil, setInspectionUntil] = useState("2027-06-30");
  const [operator, setOperator] = useState("夜班");

  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{ orderId: string; rowNo: number } | null>(null);

  const today = todayStr();

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 20000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => saveState(state), [state]);

  // 重录被挡住时，滚动到原行
  useEffect(() => {
    if (!conflict) return;
    document.getElementById(`row-${conflict.orderId}-${conflict.rowNo}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [conflict]);

  const plan = useMemo(() => planQueue(state.orders, state.card, today, nowHM()), [state, today]);

  const dep = nextDeparture(now);
  const depMins = Math.max(0, Math.round((dep.getTime() - now.getTime()) / 60000));
  const countdown = `${Math.floor(depMins / 60)} 小时 ${depMins % 60} 分`;

  const bankCount = plan.queue.filter((r) => r.source === "储气组").length;
  const backupCount = plan.queue.filter((r) => r.source === "备用气源").length;

  function applyPreset(id: string) {
    setPreset(id);
    const p = MIX_PRESETS.find((m) => m.id === id);
    if (p && id !== "custom") {
      setO2(String(p.mix.o2));
      setHe(String(p.mix.he));
    }
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setConflict(null);

    if (!tankNo.trim()) return setError("请填写瓶号");
    const mix: GasMix = { o2: Number(o2), he: Number(he) };
    if (!(Number(volumeL) > 0) || !(Number(targetBar) > 0) || !(Number(residualBar) >= 0)) return setError("容积与压力数值不合法");
    if (mix.o2 < 5 || mix.o2 > 100 || mix.he < 0 || mix.he > 70 || mix.o2 + mix.he > 100)
      return setError("混合气比例不合法（氧 5–100%，氦 0–70%，合计 ≤100%）");

    const orderId = orderChoice === "__new" ? newOrderId.trim() || `BK-${100 + state.orders.length + 1}` : orderChoice;
    const row: RegRow = {
      tankNo: tankNo.trim().toUpperCase(),
      volumeL: Number(volumeL),
      residualBar: Number(residualBar),
      targetBar: Number(targetBar),
      mix,
      thread,
      pickupAt,
      deadline,
      inspectionUntil,
      operator: operator.trim() || "夜班",
    };

    const existing = state.orders.find((o) => o.id === orderId);
    const order: BookingOrder = existing ?? { id: orderId, customer: customer.trim() || "未留名", rows: [] };
    const res = addRowToOrder(order, row);
    if (!res.ok) {
      if (res.reason === "duplicate") {
        setConflict({ orderId, rowNo: res.conflictRowNo });
        setError(`已挡住：瓶号 ${res.tankNo} 与本预约单第 ${res.conflictRowNo} 行重复，原行已在下方标出`);
      } else {
        setError(`配气不成立：${res.issues.join("；")}`);
      }
      return;
    }

    const orders = existing ? state.orders.map((o) => (o.id === orderId ? res.order : o)) : [...state.orders, res.order];
    const planned = planQueue(orders, state.card, today, nowHM());
    setState({ orders, card: planned.card });

    const key = `${orderId}|${row.tankNo}`;
    const inQueue = planned.queue.find((r) => `${r.orderId}|${r.tankNo}` === key);
    if (planned.inspection.some((r) => `${r.orderId}|${r.tankNo}` === key)) {
      setNotice(`瓶号 ${row.tankNo} 检验过期，不进队列，已留在送检区`);
    } else if (inQueue?.source === "备用气源") {
      setNotice(`储气组余压不足，${row.tankNo} 保留限时 ${row.deadline} 改排备用气源，已锁定卡片不受影响`);
    } else {
      setNotice(`${row.tankNo} 已登记，充填位 #${inQueue?.slotNo}，储气组卡登记即锁定`);
    }
    setTankNo("");
  }

  function handleArchive() {
    const snap: ArchiveSnapshot = {
      at: `${today} ${nowHM()}`,
      cardId: state.card.id,
      residualBar: state.card.residualBar,
      locked: state.card.entries.length,
      summary: `充填位 ${plan.queue.length} · 储气组 ${bankCount} · 备用 ${backupCount} · 送检 ${plan.inspection.length}`,
    };
    setArchive(pushArchive(snap));
    setError(null);
    setNotice(`卡片 ${state.card.id} 已存档（余压 ${state.card.residualBar}bar，锁定 ${state.card.entries.length} 条）`);
  }

  function handleReset() {
    if (!window.confirm("重置为演示数据？当前登记与存档记录都会清空。")) return;
    clearAll();
    setState(seedState(todayStr(), nowHM()));
    setArchive([]);
    setError(null);
    setConflict(null);
    setNotice("已载入演示数据");
  }

  const selectedOrder = state.orders.find((o) => o.id === orderChoice);

  return (
    <main className="app">
      <section className="hero">
        <p>hxyfront-62010 · 夜班值班台 · 外岛潜店</p>
        <h1>夜潜车队充填值班台</h1>
        <span>
          车队明早 06:00 出海。全店仅剩一张临时高压储气组使用卡：登记即锁定，余压不足的瓶保留限时改排备用气源，
          不得挤掉已锁定卡片；检验过期瓶一律留在送检区。
        </span>
        <div className="countdown">
          距 06:00 出海 <strong>{countdown}</strong>
          <small>现在 {pad(now.getHours())}:{pad(now.getMinutes())}</small>
        </div>
      </section>

      <section className="metrics">
        <article>
          <small>待充填（充填位）</small>
          <strong>{plan.queue.length}</strong>
        </article>
        <article>
          <small>储气组余压</small>
          <strong>{state.card.residualBar}bar</strong>
        </article>
        <article>
          <small>备用气源</small>
          <strong>{backupCount}</strong>
        </article>
        <article>
          <small>送检区</small>
          <strong>{plan.inspection.length}</strong>
        </article>
      </section>

      {error && <div className="error-banner">{error}</div>}
      {notice && <div className="notice-banner">{notice}</div>}

      <section className="workspace">
        <aside className="panel">
          <h2>临时储气组使用卡</h2>
          <p className="card-id">
            {state.card.id} <small>（全店仅此一张）</small>
          </p>
          <p className="bank-line">
            余压 <strong>{state.card.residualBar}bar</strong> · 容积 {state.card.capacityL}L · 对 200bar 目标可用{" "}
            {bankUsableL(state.card, 200)}L
          </p>

          <h3>已锁定条目（不得挤掉）</h3>
          {state.card.entries.length === 0 ? (
            <p className="hint">暂无锁定条目</p>
          ) : (
            <ul className="locked-list">
              {state.card.entries.map((e2) => (
                <li key={`${e2.orderId}-${e2.tankNo}`}>
                  <b>{e2.tankNo}</b> · {e2.orderId} · 取气 {e2.drawL}L · {e2.at} 锁定
                </li>
              ))}
            </ul>
          )}

          <div className="card-actions">
            <button className="primary" onClick={handleArchive}>
              存档卡片
            </button>
            <button onClick={handleReset}>重置演示</button>
          </div>

          <h3>存档记录</h3>
          {archive.length === 0 ? (
            <p className="hint">还没有存档</p>
          ) : (
            <ul className="archive-list">
              {archive.slice(0, 5).map((s) => (
                <li key={s.at}>
                  {s.at} · {s.cardId} 余压 {s.residualBar}bar · 锁定 {s.locked} 条<br />
                  <small>{s.summary}</small>
                </li>
              ))}
            </ul>
          )}
        </aside>

        <section className="panel form-panel">
          <div className="heading">
            <div>
              <p>夜班登记</p>
              <h2>登记气瓶</h2>
            </div>
          </div>
          <form onSubmit={handleSubmit}>
            <div className="field-grid">
              <label>
                <span>预约单</span>
                <select value={orderChoice} onChange={(e) => setOrderChoice(e.target.value)}>
                  {state.orders.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.id} · {o.customer}
                    </option>
                  ))}
                  <option value="__new">新预约单…</option>
                </select>
              </label>
              {orderChoice === "__new" ? (
                <>
                  <label>
                    <span>新单号（留空自动编号）</span>
                    <input value={newOrderId} onChange={(e) => setNewOrderId(e.target.value)} placeholder="如 BK-093" />
                  </label>
                  <label>
                    <span>客户</span>
                    <input value={customer} onChange={(e) => setCustomer(e.target.value)} placeholder="客户/团队名" />
                  </label>
                </>
              ) : (
                <label>
                  <span>客户</span>
                  <input value={selectedOrder?.customer ?? ""} readOnly />
                </label>
              )}
              <label>
                <span>瓶号</span>
                <input value={tankNo} onChange={(e) => setTankNo(e.target.value)} placeholder="如 TANK-220" />
              </label>
              <label>
                <span>容积（L）</span>
                <input type="number" min="1" step="0.1" value={volumeL} onChange={(e) => setVolumeL(e.target.value)} />
              </label>
              <label>
                <span>残压（bar）</span>
                <input type="number" min="0" value={residualBar} onChange={(e) => setResidualBar(e.target.value)} />
              </label>
              <label>
                <span>目标压力（bar）</span>
                <input type="number" min="1" value={targetBar} onChange={(e) => setTargetBar(e.target.value)} />
              </label>
              <label>
                <span>目标混合气</span>
                <select value={preset} onChange={(e) => applyPreset(e.target.value)}>
                  {MIX_PRESETS.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>氧含量 O₂ %</span>
                <input type="number" min="5" max="100" value={o2} disabled={preset !== "custom"} onChange={(e) => setO2(e.target.value)} />
              </label>
              <label>
                <span>氦含量 He %</span>
                <input type="number" min="0" max="70" value={he} disabled={preset !== "custom"} onChange={(e) => setHe(e.target.value)} />
              </label>
              <label>
                <span>瓶阀螺纹</span>
                <select value={thread} onChange={(e) => setThread(e.target.value as ValveThread)}>
                  {THREADS.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>领瓶时点</span>
                <input type="time" value={pickupAt} onChange={(e) => setPickupAt(e.target.value)} />
              </label>
              <label>
                <span>限时</span>
                <input type="time" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
              </label>
              <label>
                <span>检验有效期</span>
                <input type="date" value={inspectionUntil} onChange={(e) => setInspectionUntil(e.target.value)} />
              </label>
              <label>
                <span>操作员</span>
                <input value={operator} onChange={(e) => setOperator(e.target.value)} />
              </label>
            </div>
            <div className="form-actions">
              <button type="submit" className="primary">
                登记入队
              </button>
              <span className="hint">同一预约单内瓶号重录会被挡住并指出原行</span>
            </div>
          </form>
        </section>
      </section>

      <section className="panel">
        <div className="heading">
          <div>
            <p>按领瓶时点排序 · 唯一充填位</p>
            <h2>充填位队列</h2>
          </div>
        </div>
        <div className="table-wrap">
          <table className="queue">
            <thead>
              <tr>
                <th>充填位</th>
                <th>预约单 / 客户</th>
                <th>瓶号</th>
                <th>目标混合气</th>
                <th>瓶阀螺纹</th>
                <th>领瓶</th>
                <th>限时</th>
                <th>气源</th>
                <th>备注</th>
              </tr>
            </thead>
            <tbody>
              {plan.queue.map((r) => {
                const isConflict = conflict !== null && conflict.orderId === r.orderId && conflict.rowNo === r.rowNo;
                return (
                  <tr key={`${r.orderId}-${r.rowNo}`} id={`row-${r.orderId}-${r.rowNo}`} className={isConflict ? "row-conflict" : ""}>
                    <td>
                      <b className="slot">#{r.slotNo}</b>
                    </td>
                    <td>
                      {r.orderId}
                      <br />
                      <small>{r.customer}</small>
                    </td>
                    <td>
                      {r.tankNo}
                      {isConflict && <span className="badge badge-danger">原行</span>}
                    </td>
                    <td>
                      {mixLabel(r.mix)}
                      <br />
                      <small>{blendHint(r)}</small>
                    </td>
                    <td>{r.thread}</td>
                    <td>{fmtNight(r.pickupAt)}</td>
                    <td className={r.source === "备用气源" ? "deadline-kept" : ""}>{fmtNight(r.deadline)}</td>
                    <td>
                      <span className={r.source === "储气组" ? "badge badge-bank" : "badge badge-backup"}>
                        {r.source}
                        {r.locked && r.source === "储气组" ? " · 已锁定" : ""}
                      </span>
                    </td>
                    <td>
                      {r.notes.map((n) => (
                        <small key={n} className="note">
                          {n}
                        </small>
                      ))}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <div className="heading">
          <div>
            <p>检验过期 · 不进充填队列</p>
            <h2>送检区</h2>
          </div>
        </div>
        {plan.inspection.length === 0 ? (
          <p className="hint">送检区暂无气瓶</p>
        ) : (
          <div className="records">
            {plan.inspection.map((r) => (
              <article key={`${r.orderId}-${r.rowNo}`}>
                <b>检</b>
                <div>
                  <h3>
                    {r.tankNo} <small>（{r.orderId} · {r.customer}）</small>
                  </h3>
                  <p>
                    检验有效期 {r.inspectionUntil} 已过期 · 限时 {fmtNight(r.deadline)} · {r.notes[0]}
                  </p>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}

export default DutyBoard;
