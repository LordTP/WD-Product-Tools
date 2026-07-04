"use client";

// Merch overview dashboard. Reads the LOCAL PO cache (no API) and derives metrics
// from PO headers (value on order, open POs, overdue, status/vendor breakdowns).
// Unit-level / receiving stats come later once line items are fully synced.

import { useEffect, useState, useCallback } from "react";
import type { PoSummary } from "@/lib/shiphero/po-pull";
import type { SizeMap } from "@/lib/sizes";
import { PoBreakdownModal } from "./po-breakdown-modal";

// Statuses that aren't "open" — Delivered has landed, so it's excluded from all
// open/on-order KPIs, breakdowns and the receiving panel (same as closed/cancelled).
const DONE = ["closed", "canceled", "cancelled", "delivered"];
const isOpen = (p: PoSummary) => !DONE.includes(p.status.trim().toLowerCase());
const gbp = (n: number) =>
  "£" + n.toLocaleString("en-GB", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
const num = (s: string | null) => Number(s ?? 0) || 0;
const todayISO = () => new Date().toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) =>
  Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86_400_000);

export function Dashboard({ shipheroConnected, sizeMap }: { shipheroConnected: boolean; sizeMap: SizeMap }) {
  const [pos, setPos] = useState<PoSummary[] | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<PoSummary | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/po/list?mappedOnly=1");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load.");
      setPos(data.pos);
      setLastSyncedAt(data.lastSyncedAt);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load.");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function sync() {
    if (!shipheroConnected) return;
    setSyncing(true);
    setError(null);
    try {
      const res = await fetch("/api/po/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ since: "2024-01-01" }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Sync failed.");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sync failed.");
    } finally {
      setSyncing(false);
    }
  }

  // --- derive metrics (from cached headers) ---
  const all = pos ?? [];
  const open = all.filter(isOpen);
  const today = todayISO();
  const overdue = open
    .filter((p) => p.poDate && p.poDate.slice(0, 10) < today && p.status.toLowerCase() !== "delivered")
    .map((p) => ({ ...p, daysLate: daysBetween(p.poDate!.slice(0, 10), today) }))
    .sort((a, b) => b.daysLate - a.daysLate);
  const onOrderValue = open.reduce((a, p) => a + num(p.totalPrice), 0);

  // Units + receiving (from synced line items)
  const openOrdered = open.reduce((a, p) => a + p.unitsOrdered, 0);
  const openReceived = open.reduce((a, p) => a + p.unitsReceived, 0);
  const outstanding = Math.max(openOrdered - openReceived, 0);
  // Receiving panel: only POs whose status is "In transit" (actually on their way).
  const receiving = open
    .filter((p) => p.unitsOrdered > 0 && p.status.trim().toLowerCase() === "in transit")
    .map((p) => {
      const pct = Math.round((p.unitsReceived / p.unitsOrdered) * 100);
      const state = p.unitsReceived === 0 ? "awaiting" : p.unitsReceived >= p.unitsOrdered ? "complete" : "part";
      return { ...p, pct, state };
    })
    // in-progress first, then awaiting, then fully booked in; most-received first within each.
    .sort((a, b) => {
      const rank = (s: string) => (s === "part" ? 0 : s === "awaiting" ? 1 : 2);
      return rank(a.state) - rank(b.state) || b.pct - a.pct;
    });
  const awaitingCount = receiving.filter((p) => p.state === "awaiting").length;
  const partCount = receiving.filter((p) => p.state === "part").length;
  const completeCount = receiving.filter((p) => p.state === "complete").length;
  // Totals for the panel bar (in-transit POs only).
  const transitOrdered = receiving.reduce((a, p) => a + p.unitsOrdered, 0);
  const transitReceived = receiving.reduce((a, p) => a + p.unitsReceived, 0);
  const transitPct = transitOrdered ? Math.round((transitReceived / transitOrdered) * 100) : 0;

  // Upcoming deliveries: open POs whose expected date is today or later.
  const upcoming = open
    .filter((p) => p.poDate && p.poDate.slice(0, 10) >= today)
    .map((p) => ({ ...p, daysUntil: daysBetween(today, p.poDate!.slice(0, 10)) }))
    .sort((a, b) => a.daysUntil - b.daysUntil);
  const landingSoon = upcoming.filter((p) => p.daysUntil <= 14).length;

  const byStatus = groupBy(open, (p) => p.status || "—");
  const byVendor = groupBy(open, (p) => p.vendorName || "—");
  const maxStatusValue = Math.max(1, ...byStatus.map((g) => g.value));

  // Order value by expected month (all cached POs), chronological, last 8.
  const byMonth = [...groupBy(all, (p) => (p.poDate ? p.poDate.slice(0, 7) : "—"))]
    .filter((g) => g.key !== "—")
    .sort((a, b) => a.key.localeCompare(b.key))
    .slice(-8);
  const maxMonthValue = Math.max(1, ...byMonth.map((g) => g.value));

  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden">
      <header className="h-14 bg-white border-b border-slate-200 flex items-center justify-between px-4 sm:px-5 shrink-0">
        <div className="flex items-center gap-3">
          <span className="font-semibold text-sm text-slate-900">Dashboard</span>
          <span className="hidden sm:inline text-xs text-slate-400">purchase orders overview</span>
        </div>
        <div className="flex items-center gap-3">
          {lastSyncedAt && <span className="text-[11px] text-slate-400">synced {timeAgo(lastSyncedAt)}</span>}
          <button
            onClick={sync}
            disabled={syncing || !shipheroConnected}
            className={`text-xs px-3 py-1.5 rounded-md flex items-center gap-1.5 ${
              shipheroConnected ? "bg-indigo-600 text-white hover:bg-indigo-700" : "bg-slate-200 text-slate-400 cursor-not-allowed"
            } disabled:opacity-60`}
          >
            <svg width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" className={syncing ? "animate-spin" : ""}>
              <path d="M21 2v6h-6M3 12a9 9 0 0 1 15-6.7L21 8M3 22v-6h6M21 12a9 9 0 0 1-15 6.7L3 16" />
            </svg>
            {syncing ? "Syncing…" : "Sync"}
          </button>
        </div>
      </header>

      <div className="flex-1 min-h-0 overflow-auto p-3 sm:p-5 space-y-4 sm:space-y-5">
        {error && <div className="text-xs bg-rose-50 border border-rose-200 text-rose-700 rounded p-2">{error}</div>}

        {pos && all.length === 0 ? (
          <div className="text-center py-16 text-sm text-slate-400">
            No POs cached yet — click <span className="font-medium text-slate-600">Sync</span> to pull them from ShipHero.
          </div>
        ) : (
          <>
            {/* KPI cards */}
            <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
              <Card label="Open POs" value={open.length} />
              <Card label="Units on order" value={outstanding.toLocaleString()} sub="still to arrive" />
              <Card label="Value on order" value={gbp(onOrderValue)} accent="indigo" />
              <Card
                label="Landing ≤14 days"
                value={landingSoon}
                accent={landingSoon > 0 ? "indigo" : "slate"}
                sub={landingSoon > 0 ? "arriving soon" : "none imminent"}
              />
              <Card
                label="Overdue"
                value={overdue.length}
                accent={overdue.length > 0 ? "rose" : "slate"}
                sub={overdue.length > 0 ? "past expected date" : "all on track"}
              />
            </div>

            {/* Receiving progress — POs currently In transit */}
            <Panel title="Receiving — POs in transit">
              {receiving.length === 0 ? (
                <p className="text-xs text-slate-400">No POs currently in transit.</p>
              ) : (
                <>
                  <div className="flex items-center gap-3 mb-2">
                    <span className="text-xs font-semibold text-slate-700">
                      {transitReceived.toLocaleString()} / {transitOrdered.toLocaleString()} units received
                    </span>
                    <div className="flex-1 h-2.5 bg-slate-200 rounded-full overflow-hidden">
                      <div
                        className={`h-full ${transitPct >= 100 ? "bg-emerald-500" : "bg-indigo-500"}`}
                        style={{ width: `${Math.min(transitPct, 100)}%` }}
                      />
                    </div>
                    <span className="text-xs font-medium text-slate-500 tabular-nums">{transitPct}%</span>
                  </div>
                  <div className="flex items-center flex-wrap gap-x-3 gap-y-1 mb-2 text-[11px] text-slate-500">
                    <span className="font-medium text-slate-600">{receiving.length} in transit</span>
                    {partCount > 0 && <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-indigo-400" />{partCount} part-received</span>}
                    {awaitingCount > 0 && <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-slate-300" />{awaitingCount} awaiting</span>}
                    {completeCount > 0 && <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-emerald-400" />{completeCount} booked in</span>}
                  </div>
                  <div className="-mx-1 px-1 divide-y divide-slate-50">
                      {receiving.map((p) => (
                        <button
                          key={p.poNumber}
                          onClick={() => setSelected(p)}
                          title="View receiving breakdown"
                          className="w-full flex items-center gap-2 text-xs py-1 px-1 -mx-1 rounded hover:bg-indigo-50/60 text-left"
                        >
                          <span className="font-mono text-slate-500 w-16 shrink-0">{p.poNumber}</span>
                          <span className="text-slate-600 truncate flex-1 min-w-0">{p.products[0] ?? "—"}</span>
                          <span className="tabular-nums text-slate-500 w-16 text-right shrink-0">{p.unitsReceived.toLocaleString()}/{p.unitsOrdered.toLocaleString()}</span>
                          <div className="w-16 h-1.5 bg-slate-200 rounded-full overflow-hidden shrink-0">
                            <div
                              className={`h-full ${p.state === "complete" ? "bg-emerald-400" : p.state === "awaiting" ? "bg-slate-300" : "bg-indigo-400"}`}
                              style={{ width: `${p.pct}%` }}
                            />
                          </div>
                          <span className="tabular-nums text-slate-400 w-9 text-right shrink-0">{p.pct}%</span>
                        </button>
                      ))}
                  </div>
                </>
              )}
            </Panel>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
              {/* Status breakdown */}
              <Panel title="Open POs by status">
                {byStatus.length === 0 ? (
                  <Empty />
                ) : (
                  <div className="space-y-2">
                    {byStatus.map((g) => (
                      <div key={g.key} className="flex items-center gap-2 sm:gap-3 text-xs">
                        <span className="w-24 sm:w-36 truncate text-slate-600">{g.key}</span>
                        <div className="flex-1 h-4 bg-slate-100 rounded overflow-hidden">
                          <div className="h-full bg-indigo-400/80" style={{ width: `${(g.value / maxStatusValue) * 100}%` }} />
                        </div>
                        <span className="w-8 text-right tabular-nums text-slate-500">{g.count}</span>
                        <span className="w-16 sm:w-20 text-right tabular-nums font-medium text-slate-700">{gbp(g.value)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </Panel>

              {/* Vendor breakdown */}
              <Panel title="Open POs by vendor">
                {byVendor.length === 0 ? (
                  <Empty />
                ) : (
                  <table className="w-full text-xs">
                    <tbody>
                      {byVendor.map((g) => (
                        <tr key={g.key} className="border-b border-slate-50 last:border-0">
                          <td className="py-1.5 text-slate-700 truncate max-w-[16rem]">{g.key}</td>
                          <td className="py-1.5 text-right tabular-nums text-slate-500 w-12">{g.count}</td>
                          <td className="py-1.5 text-right tabular-nums font-medium text-slate-700 w-24">{gbp(g.value)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Panel>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
              {/* Upcoming deliveries */}
              <Panel title="Upcoming deliveries">
                {upcoming.length === 0 ? (
                  <p className="text-xs text-slate-400">No open POs with a future expected date.</p>
                ) : (
                  <table className="w-full text-xs">
                    <tbody>
                      {upcoming.slice(0, 8).map((p) => (
                        <tr key={p.poNumber} className="border-b border-slate-50 last:border-0">
                          <td className="py-1.5 font-mono text-slate-700">{p.poNumber}</td>
                          <td className="py-1.5 text-slate-600 truncate max-w-[12rem]">{p.products[0] ?? "—"}</td>
                          <td className="py-1.5 font-mono text-slate-500 w-24">{p.poDate?.slice(0, 10)}</td>
                          <td className="py-1.5 text-right w-20">
                            <span className={`tabular-nums ${p.daysUntil <= 14 ? "text-indigo-600 font-medium" : "text-slate-400"}`}>
                              {p.daysUntil === 0 ? "today" : `in ${p.daysUntil}d`}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Panel>

              {/* Order value by month */}
              <Panel title="Order value by month">
                {byMonth.length === 0 ? (
                  <Empty />
                ) : (
                  <div className="flex items-end gap-2 h-32 pt-2">
                    {byMonth.map((g) => (
                      <div key={g.key} className="flex-1 flex flex-col items-center gap-1 min-w-0">
                        <span className="text-[9px] text-slate-400 tabular-nums">{gbp(g.value)}</span>
                        <div className="w-full bg-slate-100 rounded-t flex items-end" style={{ height: "100%" }}>
                          <div
                            className="w-full bg-indigo-400/80 rounded-t"
                            style={{ height: `${(g.value / maxMonthValue) * 100}%` }}
                          />
                        </div>
                        <span className="text-[9px] text-slate-500">{monthLabel(g.key)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </Panel>
            </div>

            {/* Overdue list */}
            <Panel title={`Overdue POs${overdue.length ? ` (${overdue.length})` : ""}`}>
              {overdue.length === 0 ? (
                <p className="text-xs text-emerald-600">Nothing overdue — every open PO is within its expected date. 🎉</p>
              ) : (
                <div className="overflow-x-auto -mx-1 px-1">
                <table className="w-full min-w-[44rem] text-xs">
                  <thead>
                    <tr className="text-left text-[10px] uppercase tracking-wide text-slate-400 border-b border-slate-200">
                      <th className="font-medium py-1.5 pr-4">PO</th>
                      <th className="font-medium py-1.5 pr-4">Product</th>
                      <th className="font-medium py-1.5 pr-4">Vendor</th>
                      <th className="font-medium py-1.5 pr-4">Status</th>
                      <th className="font-medium py-1.5 pr-4">Expected</th>
                      <th className="font-medium py-1.5 pr-4 text-right">Days late</th>
                      <th className="font-medium py-1.5 text-right">Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {overdue.map((p) => (
                      <tr key={p.poNumber} className="border-b border-slate-50 last:border-0">
                        <td className="py-1.5 pr-4 font-mono text-slate-700">{p.poNumber}</td>
                        <td className="py-1.5 pr-4 text-slate-600 truncate max-w-[16rem]">{p.products[0] ?? "—"}</td>
                        <td className="py-1.5 pr-4 text-slate-500 truncate max-w-[12rem]">{p.vendorName ?? "—"}</td>
                        <td className="py-1.5 pr-4 text-slate-500">{p.status}</td>
                        <td className="py-1.5 pr-4 font-mono text-slate-500">{p.poDate?.slice(0, 10)}</td>
                        <td className="py-1.5 pr-4 text-right tabular-nums font-semibold text-rose-600">{p.daysLate}</td>
                        <td className="py-1.5 text-right tabular-nums text-slate-700">{gbp(num(p.totalPrice))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </div>
              )}
            </Panel>

            <p className="text-[11px] text-slate-400">
              Metrics from the local cache. Units & received update on Sync (and live via the receiving webhook).
            </p>
          </>
        )}
      </div>

      {selected && (
        <PoBreakdownModal po={selected} sizeMap={sizeMap} onClose={() => setSelected(null)} />
      )}
    </div>
  );
}

function groupBy(pos: PoSummary[], key: (p: PoSummary) => string) {
  const m = new Map<string, { count: number; value: number }>();
  for (const p of pos) {
    const k = key(p);
    const cur = m.get(k) ?? { count: 0, value: 0 };
    cur.count += 1;
    cur.value += num(p.totalPrice);
    m.set(k, cur);
  }
  return [...m.entries()]
    .map(([key, v]) => ({ key, ...v }))
    .sort((a, b) => b.value - a.value);
}

function Card({
  label,
  value,
  sub,
  accent = "slate",
}: {
  label: string;
  value: string | number;
  sub?: string;
  accent?: "slate" | "indigo" | "rose";
}) {
  const color =
    accent === "indigo" ? "text-indigo-600" : accent === "rose" ? "text-rose-600" : "text-slate-900";
  return (
    <div className="bg-white rounded-xl border border-slate-200 p-4">
      <p className="text-[11px] uppercase tracking-wide text-slate-400">{label}</p>
      <p className={`text-2xl font-bold mt-1 ${color}`}>{value}</p>
      {sub && <p className="text-[11px] text-slate-400 mt-0.5">{sub}</p>}
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-xl border border-slate-200 p-4">
      <p className="text-xs font-semibold text-slate-700 mb-3">{title}</p>
      {children}
    </div>
  );
}

function Empty() {
  return <p className="text-xs text-slate-400">No open POs.</p>;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function monthLabel(ym: string): string {
  const [y, m] = ym.split("-");
  const idx = Number(m) - 1;
  return `${MONTHS[idx] ?? m} ${(y ?? "").slice(2)}`;
}

function timeAgo(iso: string): string {
  const secs = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}
