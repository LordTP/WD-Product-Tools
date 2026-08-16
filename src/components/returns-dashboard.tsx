"use client";

// Returns — Swap RMA dashboard. Reads the local cache instantly; Sync pulls
// open + recent returns from ShipHero. All filtering/aggregation is client-side
// (deriveSummary) so period/filters re-render with zero API calls.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  deriveSummary,
  fmtMoney,
  isOpen,
  timeHM,
  dayLabel,
  type ReturnRow,
  type ReturnsSummary,
} from "@/lib/returns-types";

interface SyncMeta {
  syncedAt: string;
  rowCount: number;
  windowFrom: string;
}

type Period = { kind: "today" } | { kind: "days"; days: 7 | 14 | 30 | 90 } | { kind: "custom" };

const DAY_CHIPS: Array<{ days: 7 | 14 | 30 | 90; label: string }> = [
  { days: 7, label: "7d" },
  { days: 14, label: "14d" },
  { days: 30, label: "30d" },
  { days: 90, label: "90d" },
];

function localYmd(d: Date): string {
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mo}-${da}`;
}

export function ReturnsDashboard({ shipheroConnected }: { shipheroConnected: boolean }) {
  const [rows, setRows] = useState<ReturnRow[]>([]);
  const [meta, setMeta] = useState<SyncMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [period, setPeriod] = useState<Period>({ kind: "days", days: 30 });
  const [customFrom, setCustomFrom] = useState<string>(localYmd(new Date(Date.now() - 7 * 86_400_000)));
  const [customTo, setCustomTo] = useState<string>(localYmd(new Date()));
  const [hideLegacy, setHideLegacy] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [reasonFilter, setReasonFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/returns-hub/list");
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to load returns.");
      setRows(json.rows ?? []);
      setMeta(json.meta ?? null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load returns.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function sync() {
    setSyncing(true);
    setError(null);
    try {
      const res = await fetch("/api/returns-hub/sync", { method: "POST" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Sync failed.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sync failed.");
    } finally {
      setSyncing(false);
    }
  }

  const legacyCount = useMemo(() => rows.filter((r) => !r.isV2).length, [rows]);

  // Window bounds as local-naive ISO strings (ShipHero timestamps are naive too).
  const [fromIso, toIso] = useMemo((): [string, string] => {
    if (period.kind === "today") return [`${localYmd(new Date())}T00:00:00`, "9999-12-31T23:59:59"];
    if (period.kind === "custom") {
      const f = customFrom || localYmd(new Date());
      const t = customTo || localYmd(new Date());
      return [`${f}T00:00:00`, `${t}T23:59:59`];
    }
    const from = new Date(Date.now() - period.days * 86_400_000);
    return [`${localYmd(from)}T00:00:00`, "9999-12-31T23:59:59"];
  }, [period, customFrom, customTo]);

  const baseRows = useMemo(() => rows.filter((r) => !hideLegacy || r.isV2), [rows, hideLegacy]);

  // Feed shows returns OPENED in the window; summary handles its own windowing
  // (opened metrics by createdAt, processing metrics by event time).
  const windowRows = useMemo(
    () => baseRows.filter((r) => r.createdAt >= fromIso && r.createdAt <= toIso),
    [baseRows, fromIso, toIso],
  );

  const summary: ReturnsSummary = useMemo(
    () => deriveSummary(baseRows, fromIso, toIso, new Date().toISOString()),
    [baseRows, fromIso, toIso],
  );

  const feedRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return windowRows.filter((r) => {
      if (statusFilter === "open" && !isOpen(r)) return false;
      if (statusFilter === "complete" && isOpen(r)) return false;
      if (reasonFilter !== "all") {
        const reasons = r.items.map((i) => (i.reason || r.reason || "Other").trim());
        if (!reasons.some((x) => x === reasonFilter)) return false;
      }
      if (q) {
        const hay = `${r.orderNumber} ${r.items.map((i) => `${i.sku} ${i.productName}`).join(" ")}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [windowRows, statusFilter, reasonFilter, search]);

  const maxReason = summary.reasons[0]?.units ?? 1;
  const maxProduct = summary.topProducts[0]?.units ?? 1;
  const maxPipeline = Math.max(...summary.pipeline.map((p) => p.count), 1);
  const outcomeTotal = summary.outcomes.reduce((a, o) => a + o.units, 0) || 1;
  const maxPersonActions = summary.people[0]?.actions ?? 1;

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header bar */}
      <div className="h-14 shrink-0 border-b border-slate-200 bg-white flex items-center gap-2 px-4 lg:px-6">
        <h1 className="text-[15px] font-semibold text-slate-900 mr-2">Returns</h1>
        <button
          onClick={() => setPeriod({ kind: "today" })}
          className={`text-xs px-2.5 py-1 rounded-md border ${
            period.kind === "today"
              ? "bg-indigo-50 border-indigo-200 text-indigo-700 font-medium"
              : "border-slate-200 text-slate-500 hover:bg-slate-50"
          }`}
        >
          Today
        </button>
        {DAY_CHIPS.map((p) => (
          <button
            key={p.days}
            onClick={() => setPeriod({ kind: "days", days: p.days })}
            className={`text-xs px-2.5 py-1 rounded-md border ${
              period.kind === "days" && period.days === p.days
                ? "bg-indigo-50 border-indigo-200 text-indigo-700 font-medium"
                : "border-slate-200 text-slate-500 hover:bg-slate-50"
            }`}
          >
            {p.label}
          </button>
        ))}
        <button
          onClick={() => setPeriod({ kind: "custom" })}
          className={`text-xs px-2.5 py-1 rounded-md border ${
            period.kind === "custom"
              ? "bg-indigo-50 border-indigo-200 text-indigo-700 font-medium"
              : "border-slate-200 text-slate-500 hover:bg-slate-50"
          }`}
        >
          Custom
        </button>
        {period.kind === "custom" && (
          <span className="flex items-center gap-1.5 text-xs text-slate-500">
            <input
              type="date"
              value={customFrom}
              max={customTo}
              onChange={(e) => setCustomFrom(e.target.value)}
              className="border border-slate-200 rounded-md px-2 py-[3px] bg-white text-slate-700"
            />
            →
            <input
              type="date"
              value={customTo}
              min={customFrom}
              max={localYmd(new Date())}
              onChange={(e) => setCustomTo(e.target.value)}
              className="border border-slate-200 rounded-md px-2 py-[3px] bg-white text-slate-700"
            />
          </span>
        )}
        <button
          onClick={() => setHideLegacy((v) => !v)}
          title="Swap v1-era RMAs are never processed in ShipHero — hidden by default"
          className={`text-xs px-2.5 py-1 rounded-md border ${
            hideLegacy
              ? "bg-indigo-50 border-indigo-200 text-indigo-700 font-medium"
              : "border-slate-200 text-slate-500 hover:bg-slate-50"
          }`}
        >
          {hideLegacy ? "Hiding" : "Showing"} v1 legacy · {legacyCount}
        </button>
        <div className="flex-1" />
        {meta && (
          <span className="hidden md:block text-[11px] text-slate-400 mr-2">
            Synced {new Date(meta.syncedAt).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })} · {meta.rowCount} cached
          </span>
        )}
        <button
          onClick={sync}
          disabled={syncing || !shipheroConnected}
          className="text-[13px] font-medium bg-indigo-600 text-white rounded-md px-3.5 py-1.5 hover:bg-indigo-700 disabled:opacity-50"
        >
          {syncing ? "Syncing…" : "Sync"}
        </button>
      </div>

      <div className="flex-1 overflow-auto bg-slate-50">
        <div className="p-4 lg:p-6 flex flex-col gap-4">
          {error && (
            <div className="rounded-lg border border-rose-200 bg-rose-50 text-rose-700 text-sm px-4 py-3">
              {error}
            </div>
          )}
          {!shipheroConnected && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 text-amber-700 text-sm px-4 py-3">
              ShipHero isn&apos;t connected — showing cached data only.
            </div>
          )}
          {!loading && rows.length === 0 && (
            <div className="rounded-lg border border-slate-200 bg-white text-slate-500 text-sm px-4 py-8 text-center">
              No returns cached yet — hit <b>Sync</b> to pull them from ShipHero (first sync backfills ~a month and takes a minute or two).
            </div>
          )}

          {/* KPI row */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7 gap-3">
            <Kpi v={String(summary.total)} label="Returns opened" sub={`${summary.unitsExpected} units expected`} />
            <Kpi
              v={String(summary.processedReturns)}
              label="Returns processed"
              sub={`${summary.unitsReceived} units received`}
            />
            <Kpi
              v={summary.unitsReceived ? `${Math.round(summary.restockRate * 100)}%` : "—"}
              label="Restock rate"
              sub={`${summary.unitsRestocked} restocked`}
            />
            <Kpi
              v={fmtMoney(summary.valueProcessed)}
              label="Value processed"
              sub={`${fmtMoney(summary.valueOpen)} still coming back`}
            />
            <Kpi
              v={summary.avgTurnaroundDays != null ? `${summary.avgTurnaroundDays.toFixed(1)}d` : "—"}
              label="Avg turnaround"
              sub="opened → received"
            />
            <Kpi
              v={summary.total ? `${Math.round((summary.exchanges / summary.total) * 100)}%` : "—"}
              label="Exchanges"
              sub={`${summary.exchanges} exchange orders`}
            />
            <Kpi v={String(summary.faulty)} label="Faulty units" red sub={summary.unitsExpected ? `${((summary.faulty / summary.unitsExpected) * 100).toFixed(1)}% of units` : ""} />
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
            {/* Reasons */}
            <Panel title="Return reasons" note="units">
              {summary.reasons.slice(0, 8).map((r) => {
                const bad = /fault|damag/i.test(r.key);
                return (
                  <div key={r.key} className="grid grid-cols-[140px_1fr_44px] gap-2.5 items-center mb-2 text-[13px]">
                    <span className={`truncate ${bad ? "text-rose-600 font-medium" : "text-slate-600"}`}>
                      {bad ? "⚠ " : ""}{r.key}
                    </span>
                    <span className="h-3.5 bg-slate-100 rounded overflow-hidden">
                      <span
                        className={`block h-full rounded-r ${bad ? "bg-rose-500" : "bg-indigo-600"}`}
                        style={{ width: `${(r.units / maxReason) * 100}%` }}
                      />
                    </span>
                    <span className="text-right tabular-nums text-slate-900">{r.units}</span>
                  </div>
                );
              })}
              {summary.reasons.length === 0 && <Empty />}
            </Panel>

            {/* Outcomes + pipeline */}
            <Panel title="Outcomes & pipeline">
              <div className="flex h-5 rounded-md overflow-hidden mb-2">
                {summary.outcomes.map((o, i) => (
                  <div
                    key={o.key}
                    title={`${o.key} · ${o.units}`}
                    style={{
                      width: `${(o.units / outcomeTotal) * 100}%`,
                      background: i === 0 ? "#4f46e5" : "#0d9488",
                    }}
                    className={i > 0 ? "border-l-2 border-white" : ""}
                  />
                ))}
              </div>
              <div className="flex gap-4 text-xs text-slate-500 mb-4">
                {summary.outcomes.map((o, i) => (
                  <span key={o.key}>
                    <span
                      className="inline-block w-2 h-2 rounded-sm mr-1.5 align-middle"
                      style={{ background: i === 0 ? "#4f46e5" : "#0d9488" }}
                    />
                    {o.key} · <b className="tabular-nums text-slate-700">{o.units}</b>
                  </span>
                ))}
              </div>
              <p className="text-[11px] uppercase tracking-wider text-slate-400 mb-2">Open returns by age — all open right now, any window</p>
              {summary.pipeline.map((p, i) => (
                <div key={p.bucket} className="grid grid-cols-[90px_1fr_36px] gap-2.5 items-center mb-2 text-xs">
                  <span className="text-slate-500">{p.bucket}</span>
                  <span className="h-3.5 bg-slate-100 rounded overflow-hidden">
                    <span
                      className="block h-full rounded-r"
                      style={{
                        width: `${(p.count / maxPipeline) * 100}%`,
                        background: ["#c7d2fe", "#818cf8", "#4f46e5"][i],
                      }}
                    />
                  </span>
                  <span className="text-right tabular-nums text-[13px] text-slate-900">{p.count}</span>
                </div>
              ))}
              <p className="text-[11px] text-slate-400 mt-2">
                {summary.pipeline.reduce((a, p) => a + p.count, 0)} returns in the post or awaiting the desk.
              </p>
            </Panel>

            {/* Top returned products */}
            <Panel title="Top returned products" note="units in window">
              {summary.topProducts.map((p) => (
                <div key={p.key} className="grid grid-cols-[1fr_70px_40px] gap-2.5 items-center mb-2 text-[13px]">
                  <span className="truncate text-slate-600" title={p.key}>{p.key}</span>
                  <span className="h-2 bg-slate-100 rounded overflow-hidden self-center">
                    <span
                      className="block h-full bg-indigo-600 rounded-r"
                      style={{ width: `${(p.units / maxProduct) * 100}%` }}
                    />
                  </span>
                  <span className="text-right tabular-nums text-slate-900">{p.units}</span>
                </div>
              ))}
              {summary.topProducts.length === 0 && <Empty />}
              <p className="text-[11px] text-slate-400 mt-2">
                High units + &ldquo;does not fit&rdquo; = sizing problem; + faulty = supplier claim.
              </p>
            </Panel>
          </div>

          {/* Processing */}
          <Panel
            title="Processing"
            note="work done IN this window (whenever the return was opened) — rate = actions ÷ hours with at least one action"
          >
            {summary.people.length === 0 ? (
              <p className="text-sm text-slate-400 py-3">
                No processing activity in this window yet — this fills up as the desk receives returns against RMAs (Swap v2 flow).
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-[13px]">
                  <thead>
                    <tr className="text-[11px] uppercase tracking-wider text-slate-400 border-b border-slate-200">
                      <th className="text-left font-medium pb-2 pr-3">Person</th>
                      <th className="text-right font-medium pb-2 px-3">Returns</th>
                      <th className="text-right font-medium pb-2 px-3">Actions</th>
                      <th className="text-right font-medium pb-2 px-3">Active hrs</th>
                      <th className="text-right font-medium pb-2 px-3">Per hour</th>
                      <th className="text-left font-medium pb-2 pl-4">Tempo (by hour of day)</th>
                      <th className="text-left font-medium pb-2 pl-4 w-1/5"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.people.map((p) => {
                      const maxHour = Math.max(...p.byHour, 1);
                      return (
                        <tr key={p.name} className="border-b border-slate-100 last:border-0">
                          <td className="py-2 pr-3 whitespace-nowrap">
                            <span className="inline-flex w-6 h-6 rounded-full bg-indigo-50 text-indigo-600 text-[10px] font-semibold items-center justify-center mr-2 align-middle">
                              {p.initials}
                            </span>
                            {p.name}
                          </td>
                          <td className="text-right tabular-nums px-3">{p.returnsTouched}</td>
                          <td className="text-right tabular-nums px-3">{p.actions}</td>
                          <td className="text-right tabular-nums px-3">{p.activeHours}</td>
                          <td className="text-right tabular-nums px-3 font-medium">{p.perHour.toFixed(1)}</td>
                          <td className="pl-4">
                            <span className="inline-flex items-end gap-[2px] h-5">
                              {p.byHour.slice(6, 19).map((v, i) => (
                                <span
                                  key={i}
                                  title={`${String(i + 6).padStart(2, "0")}:00 · ${v}`}
                                  className="w-[7px] rounded-[1px]"
                                  style={{
                                    height: `${v ? Math.max(15, (v / maxHour) * 100) : 8}%`,
                                    background: v ? "#4f46e5" : "#e2e8f0",
                                  }}
                                />
                              ))}
                            </span>
                          </td>
                          <td className="pl-4">
                            <span
                              className="inline-block h-2 bg-indigo-600 rounded align-middle"
                              style={{ width: `${(p.actions / maxPersonActions) * 100}%` }}
                            />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>

          {/* Feed */}
          <Panel
            title={`Returns · ${feedRows.length}`}
            right={
              <div className="flex items-center gap-2">
                <select
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value)}
                  className="text-xs border border-slate-200 rounded-md px-2 py-1 bg-white text-slate-600"
                >
                  <option value="all">All statuses</option>
                  <option value="open">Open</option>
                  <option value="complete">Completed</option>
                </select>
                <select
                  value={reasonFilter}
                  onChange={(e) => setReasonFilter(e.target.value)}
                  className="text-xs border border-slate-200 rounded-md px-2 py-1 bg-white text-slate-600 max-w-[160px]"
                >
                  <option value="all">All reasons</option>
                  {summary.reasons.map((r) => (
                    <option key={r.key} value={r.key}>{r.key}</option>
                  ))}
                </select>
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search order / SKU / product…"
                  className="text-xs border border-slate-200 rounded-md px-2.5 py-1 w-52 bg-white"
                />
              </div>
            }
          >
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="text-[11px] uppercase tracking-wider text-slate-400 border-b border-slate-200">
                    <th className="text-left font-medium pb-2 pr-3">Opened</th>
                    <th className="text-left font-medium pb-2 px-3">Order</th>
                    <th className="text-left font-medium pb-2 px-3">Items</th>
                    <th className="text-right font-medium pb-2 px-3">Recv</th>
                    <th className="text-left font-medium pb-2 px-3">Reason</th>
                    <th className="text-right font-medium pb-2 px-3">Value</th>
                    <th className="text-left font-medium pb-2 pl-3">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {feedRows.slice(0, 250).map((r) => (
                    <FeedRow
                      key={r.id}
                      r={r}
                      open={openId === r.id}
                      onToggle={() => setOpenId(openId === r.id ? null : r.id)}
                    />
                  ))}
                </tbody>
              </table>
              {feedRows.length > 250 && (
                <p className="text-[11px] text-slate-400 pt-2">Showing first 250 — narrow the filters to see the rest.</p>
              )}
              {feedRows.length === 0 && !loading && (
                <p className="text-sm text-slate-400 py-4 text-center">Nothing matches these filters.</p>
              )}
            </div>
          </Panel>

          <p className="text-[11px] text-slate-400 pb-2">
            Value = retail value of returned goods from order line prices — actual refund £ lives in Swap/Shopify.
            Sync re-pulls open returns + the last 14 days; completed returns freeze in the cache.
          </p>
        </div>
      </div>
    </div>
  );
}

function Kpi({ v, label, sub, red }: { v: string; label: string; sub?: string; red?: boolean }) {
  return (
    <div className="bg-white border border-slate-200 rounded-lg px-3.5 py-3">
      <div className={`text-[21px] font-semibold tracking-tight tabular-nums ${red ? "text-rose-600" : "text-slate-900"}`}>{v}</div>
      <div className="text-[10px] uppercase tracking-wider text-slate-400 mt-0.5">{label}</div>
      {sub && <div className="text-[11px] text-slate-500 mt-1">{sub}</div>}
    </div>
  );
}

function Panel({
  title,
  note,
  right,
  children,
}: {
  title: string;
  note?: string;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-white border border-slate-200 rounded-lg p-4">
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <h2 className="text-[11px] uppercase tracking-wider text-slate-500 font-medium">
          {title}
          {note && <span className="normal-case tracking-normal font-normal text-slate-400 ml-2">{note}</span>}
        </h2>
        <div className="flex-1" />
        {right}
      </div>
      {children}
    </div>
  );
}

function Empty() {
  return <p className="text-sm text-slate-400 py-3">Nothing in this window.</p>;
}

function StatusPill({ r }: { r: ReturnRow }) {
  if (!r.isV2)
    return <span className="text-[11px] font-medium rounded-full px-2 py-0.5 bg-slate-100 text-slate-400">v1 legacy</span>;
  if (isOpen(r))
    return <span className="text-[11px] font-medium rounded-full px-2 py-0.5 bg-amber-100 text-amber-800">pending</span>;
  return <span className="text-[11px] font-medium rounded-full px-2 py-0.5 bg-emerald-100 text-emerald-800">{r.status}</span>;
}

function FeedRow({ r, open, onToggle }: { r: ReturnRow; open: boolean; onToggle: () => void }) {
  const reason = r.items.map((i) => i.reason).find(Boolean) || r.reason || "—";
  const faulty = /fault|damag/i.test(reason);
  const itemsLabel =
    r.items
      .slice(0, 2)
      .map((i) => i.productName.split("|")[0]?.trim() || i.sku)
      .join(", ") + (r.items.length > 2 ? ` +${r.items.length - 2}` : "");
  return (
    <>
      <tr onClick={onToggle} className={`border-b border-slate-100 cursor-pointer hover:bg-slate-50 ${open ? "bg-indigo-50/40" : ""}`}>
        <td className="py-2 pr-3 whitespace-nowrap tabular-nums text-slate-500">
          {dayLabel(r.createdAt)} {timeHM(r.createdAt)}
        </td>
        <td className="px-3 font-medium text-slate-900 whitespace-nowrap">{r.orderNumber}</td>
        <td className="px-3 text-slate-600 max-w-[300px] truncate" title={r.items.map((i) => i.productName).join(", ")}>
          {itemsLabel}
        </td>
        <td className="px-3 text-right tabular-nums text-slate-600">
          {r.received}/{r.expected}
        </td>
        <td className={`px-3 whitespace-nowrap ${faulty ? "text-rose-600 font-medium" : "text-slate-600"}`}>{reason}</td>
        <td className="px-3 text-right tabular-nums text-slate-600">{fmtMoney(r.value)}</td>
        <td className="pl-3"><StatusPill r={r} /></td>
      </tr>
      {open && (
        <tr className="bg-indigo-50/30">
          <td colSpan={7} className="px-4 py-3">
            <div className="grid md:grid-cols-2 gap-4">
              <div>
                <p className="text-[11px] uppercase tracking-wider text-slate-400 mb-2">Items</p>
                {r.items.map((it, i) => (
                  <div key={i} className="flex items-center gap-3 text-[13px] py-1 border-b border-indigo-100/60 last:border-0">
                    <span className="flex-1 text-slate-700">{it.productName} <span className="text-slate-400">({it.sku})</span></span>
                    <span className="text-slate-500 tabular-nums">recv {it.received}/{it.quantity}</span>
                    {it.condition && <span className="text-slate-500">cond: {it.condition}</span>}
                    <span className={it.restock ? "text-emerald-600" : "text-slate-400"}>
                      {it.restock ? "restock" : "no restock"}
                    </span>
                  </div>
                ))}
                {r.exchangeOrders.length > 0 && (
                  <p className="text-[12px] text-slate-500 mt-2">
                    Exchange order{r.exchangeOrders.length > 1 ? "s" : ""}: <b>{r.exchangeOrders.join(", ")}</b>
                  </p>
                )}
              </div>
              <div>
                <p className="text-[11px] uppercase tracking-wider text-slate-400 mb-2">History</p>
                {r.history.length === 0 && <p className="text-[13px] text-slate-400">No events logged.</p>}
                <ul className="text-[12.5px] text-slate-600 space-y-1.5">
                  {r.history.map((h, i) => (
                    <li key={i} className="flex gap-2">
                      <span className="tabular-nums text-slate-400 whitespace-nowrap">
                        {dayLabel(h.at)} {timeHM(h.at)}
                      </span>
                      <span>
                        {h.user && <b className="text-slate-800">{h.user} — </b>}
                        {h.body}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
