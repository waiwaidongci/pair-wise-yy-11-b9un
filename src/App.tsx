// 业务文件三：值班界面
// 夜班登记预约单（瓶号/限时/目标混合气/瓶阀螺纹），重录瓶号当场挡住并指出原行；
// 队列按领瓶时点排唯一充填位，储气组余压不足自动改排备用气源；
// 过期瓶留送检区；使用卡流转在下方存档。

import { useEffect, useState } from "react";
import "./styles.css";
import type {
  CardEventAction,
  FillEntry,
  ShopState,
  ValveThread,
} from "./types";
import {
  FLEET_DEPARTURE,
  TARGET_BAR,
  mixHints,
  mixLabel,
  neededBankBar,
  planQueue,
  validateMix,
  isInspectionExpired,
} from "./gasPlanner";
import {
  appendArchive,
  inspectEvent,
  loadState,
  resetState,
  saveState,
} from "./cardStore";

const THREADS: ValveThread[] = ["M25×2", "G3/4", "3/4-NPSM"];

const PRESETS: Record<string, { label: string; o2: string; he: string }> = {
  air: { label: "空气 21%", o2: "21", he: "0" },
  ean32: { label: "高氧 EAN32", o2: "32", he: "0" },
  ean36: { label: "高氧 EAN36", o2: "36", he: "0" },
  tx1845: { label: "Trimix 18/45", o2: "18", he: "45" },
  tx2135: { label: "Trimix 21/35", o2: "21", he: "35" },
  custom: { label: "自定义比例", o2: "", he: "" },
};

const ACTION_LABEL: Record<CardEventAction, string> = {
  lock: "锁定",
  release: "释放",
  reroute: "改排",
  inspect: "送检",
};

interface DraftRow {
  key: string;
  cylinderId: string;
  deadline: string;
  preset: string;
  o2: string;
  he: string;
  thread: ValveThread;
  inspectionUntil: string;
}

let rowSeq = 0;
function emptyRow(): DraftRow {
  rowSeq += 1;
  return {
    key: `row-${rowSeq}`,
    cylinderId: "",
    deadline: "",
    preset: "air",
    o2: "21",
    he: "0",
    thread: "M25×2",
    inspectionUntil: "",
  };
}

/** 排位 + 使用卡流转入档，返回新状态 */
function replan(draft: ShopState): ShopState {
  const res = planQueue(draft.entries, draft.bank, draft.cardLock);
  return appendArchive(
    { ...draft, entries: res.entries, cardLock: res.lock },
    res.events,
  );
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function App() {
  const [state, setState] = useState<ShopState>(() => replan(loadState()));
  const [customer, setCustomer] = useState("");
  const [rows, setRows] = useState<DraftRow[]>([emptyRow()]);
  const [formError, setFormError] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [dupMap, setDupMap] = useState<Record<string, number>>({}); // 重录行 key -> 原行下标
  const [notice, setNotice] = useState<string | null>(null);
  const [bankInput, setBankInput] = useState("");

  useEffect(() => {
    saveState(state);
  }, [state]);

  const queued = state.entries
    .filter((e) => e.status === "queued")
    .sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0));
  const inspection = state.entries.filter((e) => e.status === "inspection");
  const done = state.entries.filter((e) => e.status === "done");
  const backupCount = queued.filter((e) => e.source === "backup").length;
  const bankPlanned =
    state.bank.remainingBar -
    queued.filter((e) => e.source === "bank").length * state.bank.perFillDrop;
  const lockHolder = state.cardLock
    ? state.entries.find((e) => e.id === state.cardLock!.entryId)
    : null;

  const patchRow = (key: string, patch: Partial<DraftRow>) => {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  };

  // 登记预约单：先校验，再挡住重录瓶号，最后排位入档
  const submitBooking = () => {
    setNotice(null);
    const errs: Record<string, string> = {};
    const dups: Record<string, number> = {};
    const seen = new Map<string, number>();

    rows.forEach((row, idx) => {
      const cid = row.cylinderId.trim().toUpperCase();
      if (!cid) errs[row.key] = "瓶号必填";
      else if (!/^\d{1,2}:\d{2}$/.test(row.deadline))
        errs[row.key] = "请填限时（领瓶时点）";
      else if (!row.inspectionUntil) errs[row.key] = "请填检验有效期";
      else {
        const mixErr = validateMix({ o2: Number(row.o2), he: Number(row.he) });
        if (mixErr) errs[row.key] = mixErr;
      }
      // 同一预约单内瓶号重录：记录原行
      if (cid) {
        if (seen.has(cid)) dups[row.key] = seen.get(cid)!;
        else seen.set(cid, idx);
      }
    });

    // 已在队列中的瓶号同样挡住
    rows.forEach((row) => {
      const cid = row.cylinderId.trim().toUpperCase();
      if (!cid || errs[row.key] || dups[row.key] !== undefined) return;
      const hit = queued.find(
        (e) => e.cylinderId.toUpperCase() === cid,
      );
      if (hit)
        errs[row.key] = `该瓶已在队列中（充填位 #${hit.slot} · ${hit.bookingId}）`;
    });

    if (Object.keys(errs).length > 0 || Object.keys(dups).length > 0) {
      setRowErrors(errs);
      setDupMap(dups);
      const firstDupKey = Object.keys(dups)[0];
      if (firstDupKey !== undefined) {
        const dupIdx = rows.findIndex((r) => r.key === firstDupKey);
        const cid = rows[dupIdx].cylinderId.trim().toUpperCase();
        setFormError(
          `瓶号重录已挡住：${cid} 已在第 ${dups[firstDupKey] + 1} 行登记（原行已标黄），第 ${dupIdx + 1} 行请改正`,
        );
      } else {
        setFormError("请修正标红行后再提交");
      }
      return;
    }

    const now = new Date();
    const stamp = `${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
    const bookingId = `BK-${stamp}-${state.bookings.length + 1}`;
    const newEntries: FillEntry[] = rows.map((row, i) => {
      const expired = isInspectionExpired(row.inspectionUntil, now);
      return {
        id: `E-${now.getTime().toString(36)}-${i}`,
        bookingId,
        rowNo: i + 1,
        cylinderId: row.cylinderId.trim().toUpperCase(),
        deadline: row.deadline,
        mix: { o2: Number(row.o2), he: Number(row.he) },
        thread: row.thread,
        inspectionUntil: row.inspectionUntil,
        status: expired ? "inspection" : "queued",
        source: null,
        slot: null,
        note: expired ? "检验过期，留送检区" : "",
      };
    });

    let draft: ShopState = {
      ...state,
      bookings: [
        ...state.bookings,
        {
          id: bookingId,
          customer: customer.trim() || "现场客户",
          createdAt: now.toISOString(),
        },
      ],
      entries: [...state.entries, ...newEntries],
    };
    draft = appendArchive(
      draft,
      newEntries
        .filter((e) => e.status === "inspection")
        .map((e) => inspectEvent(e, now)),
    );
    const planned = replan(draft);
    setState(planned);

    const placed = planned.entries.filter(
      (e) => e.bookingId === bookingId && e.status === "queued",
    );
    const diverted = newEntries.filter((e) => e.status === "inspection").length;
    setNotice(
      `预约单 ${bookingId} 已登记：${
        placed.map((e) => `${e.cylinderId}→充填位#${e.slot}`).join("、") ||
        "无待充填瓶"
      }${diverted ? `；${diverted} 瓶检验过期，留送检区` : ""}`,
    );
    setRows([emptyRow()]);
    setCustomer("");
    setRowErrors({});
    setDupMap({});
    setFormError(null);
  };

  const signOff = (id: string) => {
    setState(
      replan({
        ...state,
        entries: state.entries.map((e) =>
          e.id === id ? { ...e, status: "done" as const } : e,
        ),
      }),
    );
  };

  const applyBankGauge = () => {
    const v = Number(bankInput);
    if (!Number.isFinite(v) || v < 0 || v > 300) return;
    setState(
      replan({
        ...state,
        bank: { ...state.bank, remainingBar: Math.round(v) },
      }),
    );
    setBankInput("");
  };

  const dupOrigins = Object.values(dupMap);

  return (
    <main className="app">
      <section className="hero">
        <p>外岛潜店 · 夜班充填值班台</p>
        <h1>夜潜车队 {FLEET_DEPARTURE} 出海</h1>
        <span>
          前台仅剩临时高压储气组使用卡 ×1（目标压力 {TARGET_BAR}bar
          统一）。登记瓶号、限时、目标混合气与瓶阀螺纹后，按领瓶时点排出唯一充填位；
          储气组余压不足时保留限时、改排备用气源，已锁定的卡片不被挤掉；
          检验过期瓶一律留送检区。
        </span>
      </section>

      <section className="metrics">
        <article>
          <small>待充填</small>
          <strong>{queued.length}</strong>
        </article>
        <article>
          <small>储气组余压</small>
          <strong>{state.bank.remainingBar}bar</strong>
        </article>
        <article>
          <small>备用气源</small>
          <strong>{backupCount}</strong>
        </article>
        <article>
          <small>送检区</small>
          <strong>{inspection.length}</strong>
        </article>
      </section>

      <section className="workspace">
        <aside className="panel aside-stack">
          <div>
            <h2>临时使用卡 TMP-01</h2>
            {state.cardLock && lockHolder ? (
              <p className="card-holder">
                <span className="badge badge-card">卡·锁定</span>
                {state.cardLock.cylinderId}
                {lockHolder.slot ? `（充填位 #${lockHolder.slot}）` : ""}
                <br />
                <small>锁定于 {fmtTime(state.cardLock.lockedAt)}</small>
              </p>
            ) : (
              <p className="card-holder">卡片空闲，等待下一瓶锁定</p>
            )}
          </div>

          <div className="bank-box">
            <h3>高压储气组</h3>
            <p>
              余压 <b>{state.bank.remainingBar}bar</b> · 安全下限{" "}
              {state.bank.reserveBar}bar
              <br />
              外供门槛 ≥{neededBankBar()}bar · 每瓶 -{state.bank.perFillDrop}bar
              <br />
              预计本轮排完 <b>{bankPlanned}bar</b>
            </p>
            <div className="gauge-row">
              <input
                type="number"
                min={0}
                max={300}
                placeholder="余压校正 bar"
                value={bankInput}
                onChange={(e) => setBankInput(e.target.value)}
              />
              <button onClick={applyBankGauge}>校正</button>
            </div>
          </div>

          <div className="bank-box">
            <h3>备用气源</h3>
            <p>独立压缩机，不限瓶数。余压不足的瓶保留限时改排此处，不影响持卡瓶。</p>
          </div>

          <div className="bank-box">
            <h3>送检区（{inspection.length}）</h3>
            {inspection.length === 0 && <p>暂无过期瓶</p>}
            <ul className="mini-list">
              {inspection.map((e) => (
                <li key={e.id}>
                  <span className="badge badge-warn">送检</span>
                  {e.cylinderId}
                  <small>检验至 {e.inspectionUntil} · {e.bookingId}</small>
                </li>
              ))}
            </ul>
          </div>

          <button
            className="ghost-btn"
            onClick={() => {
              if (window.confirm("重置夜班台账？当前登记与存档将清空。")) {
                setState(replan(resetState()));
                setNotice(null);
                setFormError(null);
              }
            }}
          >
            重置夜班台账
          </button>
        </aside>

        <section className="panel form-panel">
          <div className="heading">
            <div>
              <p>预约单登记</p>
              <h2>客户领瓶登记</h2>
            </div>
            <button className="primary" onClick={submitBooking}>
              提交预约单并排充填位
            </button>
          </div>

          <label className="customer-field">
            <span>客户 / 船队</span>
            <input
              placeholder="如：蓝鲸船宿队"
              value={customer}
              onChange={(e) => setCustomer(e.target.value)}
            />
          </label>

          {formError && <div className="error-banner">{formError}</div>}
          {notice && <div className="notice-banner">{notice}</div>}

          <div className="booking-rows">
            {rows.map((row, idx) => {
              const isDup = dupMap[row.key] !== undefined;
              const isOrigin = !isDup && dupOrigins.includes(idx);
              return (
                <div
                  key={row.key}
                  className={`booking-row${isDup ? " dup-blocked" : ""}${isOrigin ? " dup-origin" : ""}`}
                >
                  <div className="row-head">
                    <b>第 {idx + 1} 行</b>
                    {isOrigin && <span className="tag tag-origin">原行</span>}
                    {isDup && (
                      <span className="tag tag-dup">
                        与第 {dupMap[row.key] + 1} 行重录
                      </span>
                    )}
                    {rows.length > 1 && (
                      <button
                        className="row-remove"
                        onClick={() =>
                          setRows((rs) => rs.filter((r) => r.key !== row.key))
                        }
                      >
                        删除行
                      </button>
                    )}
                  </div>
                  <div className="row-grid">
                    <label>
                      <span>瓶号</span>
                      <input
                        placeholder="如 TANK-240"
                        value={row.cylinderId}
                        onChange={(e) =>
                          patchRow(row.key, { cylinderId: e.target.value })
                        }
                      />
                    </label>
                    <label>
                      <span>限时（领瓶时点）</span>
                      <input
                        type="time"
                        value={row.deadline}
                        onChange={(e) =>
                          patchRow(row.key, { deadline: e.target.value })
                        }
                      />
                    </label>
                    <label>
                      <span>目标混合气</span>
                      <select
                        value={row.preset}
                        onChange={(e) => {
                          const p = e.target.value;
                          const preset = PRESETS[p];
                          patchRow(row.key, {
                            preset: p,
                            ...(p === "custom"
                              ? {}
                              : { o2: preset.o2, he: preset.he }),
                          });
                        }}
                      >
                        {Object.entries(PRESETS).map(([k, v]) => (
                          <option key={k} value={k}>
                            {v.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      <span>瓶阀螺纹</span>
                      <select
                        value={row.thread}
                        onChange={(e) =>
                          patchRow(row.key, {
                            thread: e.target.value as ValveThread,
                          })
                        }
                      >
                        {THREADS.map((t) => (
                          <option key={t} value={t}>
                            {t}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      <span>氧含量 O₂%</span>
                      <input
                        type="number"
                        min={1}
                        max={100}
                        disabled={row.preset !== "custom"}
                        value={row.o2}
                        onChange={(e) => patchRow(row.key, { o2: e.target.value })}
                      />
                    </label>
                    <label>
                      <span>氦含量 He%</span>
                      <input
                        type="number"
                        min={0}
                        max={99}
                        disabled={row.preset !== "custom"}
                        value={row.he}
                        onChange={(e) => patchRow(row.key, { he: e.target.value })}
                      />
                    </label>
                    <label>
                      <span>检验有效期</span>
                      <input
                        type="date"
                        value={row.inspectionUntil}
                        onChange={(e) =>
                          patchRow(row.key, { inspectionUntil: e.target.value })
                        }
                      />
                    </label>
                  </div>
                  {rowErrors[row.key] && (
                    <p className="row-error">{rowErrors[row.key]}</p>
                  )}
                </div>
              );
            })}
          </div>

          <button
            className="ghost-btn"
            onClick={() => setRows((rs) => [...rs, emptyRow()])}
          >
            + 加一行气瓶
          </button>
        </section>
      </section>

      <section className="panel">
        <div className="heading">
          <div>
            <p>按领瓶时点排序 · 充填位唯一</p>
            <h2>充填队列</h2>
          </div>
        </div>
        <div className="table-wrap">
          <table className="queue-table">
            <thead>
              <tr>
                <th>充填位</th>
                <th>瓶号</th>
                <th>限时</th>
                <th>目标混合气</th>
                <th>瓶阀螺纹</th>
                <th>气源</th>
                <th>使用卡</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {queued.map((e) => (
                <tr key={e.id}>
                  <td>
                    <b className="slot-no">#{e.slot}</b>
                  </td>
                  <td>
                    {e.cylinderId}
                    <br />
                    <small>
                      {e.bookingId} · 第{e.rowNo}行
                    </small>
                  </td>
                  <td>{e.deadline}</td>
                  <td>
                    {mixLabel(e.mix)}
                    <br />
                    <small>{mixHints(e.mix).join("；")}</small>
                    {e.note && (
                      <>
                        <br />
                        <small className="note">{e.note}</small>
                      </>
                    )}
                  </td>
                  <td>{e.thread}</td>
                  <td>
                    {e.source === "bank" ? (
                      <span className="badge badge-bank">储气组</span>
                    ) : (
                      <span className="badge badge-backup">备用气源</span>
                    )}
                  </td>
                  <td>
                    {state.cardLock?.entryId === e.id ? (
                      <span className="badge badge-card">卡·锁定</span>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td>
                    <button onClick={() => signOff(e.id)}>签收</button>
                  </td>
                </tr>
              ))}
              {queued.length === 0 && (
                <tr>
                  <td colSpan={8}>队列已清空，等待登记</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="bottom-grid">
        <div className="panel">
          <div className="heading">
            <div>
              <p>使用卡流转留档</p>
              <h2>卡片存档</h2>
            </div>
          </div>
          <ul className="log-list">
            {state.archive.slice(0, 10).map((ev, i) => (
              <li key={`${ev.at}-${i}`}>
                <span className={`badge badge-${ev.action}`}>
                  {ACTION_LABEL[ev.action]}
                </span>
                <div>
                  <b>{ev.cylinderId}</b> {ev.detail}
                  <br />
                  <small>{fmtTime(ev.at)}</small>
                </div>
              </li>
            ))}
            {state.archive.length === 0 && <li>暂无流转记录</li>}
          </ul>
        </div>

        <div className="panel">
          <div className="heading">
            <div>
              <p>今晚已完成</p>
              <h2>已签收（{done.length}）</h2>
            </div>
          </div>
          <ul className="mini-list">
            {done.map((e) => (
              <li key={e.id}>
                <span className="badge badge-done">签收</span>
                {e.cylinderId}
                <small>
                  {mixLabel(e.mix)} ·{" "}
                  {e.source === "bank" ? "储气组" : e.source === "backup" ? "备用气源" : "—"}
                </small>
              </li>
            ))}
            {done.length === 0 && <li>暂无签收</li>}
          </ul>
        </div>
      </section>
    </main>
  );
}

export default App;
