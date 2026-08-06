"use client";

// Operations dashboard — a manual-refresh snapshot of the fulfilment picture:
// what's unfulfilled, what's ready to ship (by lane), what's blocked (by lane),
// and what's shipped today (by service). Reads the cached snapshot instantly;
// Sync re-scans ShipHero with lightweight filtered queries (no line items).

import { useCallback, useState } from "react";
import type { OpsStats, LaneCount } from "@/lib/ops-types";

type ShipView = "service" | "lane";

function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "never";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const secs = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

export function OperationsDashboard({
  shipheroConnected,
  initialStats,
}: {
  shipheroConnected: boolean;
  initialStats: OpsStats | null;
}) {
  const [stats, setStats] = useState<OpsStats | null>(initialStats);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shipView, setShipView] = useState<ShipView>("service");

  const sync = useCallback(async () => {
    if (!shipheroConnected) return;
    setSyncing(true);
    setError(null);
    try {
      const res = await fetch("/api/ops/sync", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Sync failed.");
      setStats(data.stats);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sync failed.");
    } finally {
      setSyncing(false);
    }
  }, [shipheroConnected]);

  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden">
      <header className="h-14 bg-white border-b border-slate-200 flex items-center justify-between px-4 sm:px-5 shrink-0">
        <div className="flex items-center gap-3">
          <span className="font-semibold text-sm text-slate-900">Operations</span>
          <span className="hidden sm:inline text-xs text-slate-400">fulfilment overview</span>
        </div>
        <div className="flex items-center gap-3">
          {stats && <span className="text-[11px] text-slate-400">synced {timeAgo(stats.syncedAt)}</span>}
          <button
            onClick={sync}
            disabled={syncing || !shipheroConnected}
            title="Re-scan open orders + today's shipments from ShipHero"
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
        {!shipheroConnected && (
          <div className="text-xs bg-amber-50 border border-amber-200 text-amber-800 rounded p-2">
            ShipHero isn&apos;t connected — set a refresh token to use this page.
          </div>
        )}

        {!stats ? (
          <div className="text-center py-20 text-sm text-slate-400">
            Click <span className="font-medium text-slate-600">Sync</span> to pull the current picture from ShipHero.
          </div>
        ) : (
          <>
            {/* KPI cards */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <Card label="Unfulfilled" value={stats.totalOpen} sub="open orders" />
              <Card label="Ready to ship" value={stats.readyTotal} sub="pickable now" accent="emerald" />
              <Card label="Blocked" value={stats.waitingTotal} sub="waiting on stock" accent="amber" />
              <Card label="Shipped today" value={stats.shippedOrders} sub={`${stats.shippedUnits} units`} accent="indigo" />
            </div>

            {/* Ready + Blocked, side by side */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
              <Panel title="Ready to ship — by lane" count={stats.readyTotal}>
                <LaneBars rows={stats.readyByLane} color="bg-emerald-400/80" empty="Nothing ready to ship." />
              </Panel>
              <Panel title="Blocked — by lane" count={stats.waitingTotal} accent="amber">
                <LaneBars rows={stats.waitingByLane} color="bg-amber-400/80" empty="Nothing blocked — all open orders are ready. 🎉" />
              </Panel>
            </div>

            {/* Shipped today */}
            <Panel
              title={`Shipped today — by ${shipView}`}
              count={stats.shippedOrders}
              action={
                <div className="flex rounded-md border border-slate-200 overflow-hidden text-[11px]">
                  {(["service", "lane"] as ShipView[]).map((v) => (
                    <button
                      key={v}
                      onClick={() => setShipView(v)}
                      className={`px-2.5 py-1 capitalize ${
                        shipView === v ? "bg-indigo-600 text-white" : "bg-white text-slate-500 hover:bg-slate-50"
                      }`}
                    >
                      {v}
                    </button>
                  ))}
                </div>
              }
            >
              <LaneBars
                rows={shipView === "lane" ? stats.shippedByLane : stats.shippedByService}
                color="bg-indigo-400/80"
                showUnits
                empty="Nothing shipped yet today."
              />
            </Panel>

            <p className="text-[11px] text-slate-400">
              Snapshot from the last Sync. Ready / blocked use ShipHero&apos;s own allocation flags. &ldquo;Shipped today&rdquo;
              lanes are reconstructed (service + singles/multis) — an order&apos;s real lane is overwritten to &ldquo;fulfilled&rdquo; once it ships.
            </p>
          </>
        )}
      </div>
    </div>
  );
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
  accent?: "slate" | "emerald" | "amber" | "indigo";
}) {
  const color =
    accent === "emerald" ? "text-emerald-600" : accent === "amber" ? "text-amber-600" : accent === "indigo" ? "text-indigo-600" : "text-slate-900";
  return (
    <div className="bg-white rounded-xl border border-slate-200 p-4">
      <p className="text-[11px] uppercase tracking-wide text-slate-400">{label}</p>
      <p className={`text-2xl font-bold mt-1 tabular-nums ${color}`}>{value}</p>
      {sub && <p className="text-[11px] text-slate-400 mt-0.5">{sub}</p>}
    </div>
  );
}

function Panel({
  title,
  count,
  accent,
  action,
  children,
}: {
  title: string;
  count?: number;
  accent?: "amber";
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-white rounded-xl border border-slate-200 p-4">
      <div className="flex items-center gap-2 mb-3">
        <p className="text-xs font-semibold text-slate-700">{title}</p>
        {count != null && (
          <span
            className={`text-[11px] tabular-nums px-1.5 py-0.5 rounded ${
              accent === "amber" ? "bg-amber-50 text-amber-600" : "bg-slate-100 text-slate-500"
            }`}
          >
            {count}
          </span>
        )}
        {action && <div className="ml-auto">{action}</div>}
      </div>
      {children}
    </div>
  );
}

function LaneBars({
  rows,
  color,
  showUnits,
  empty,
}: {
  rows?: LaneCount[];
  color: string;
  showUnits?: boolean;
  empty: string;
}) {
  if (!rows || rows.length === 0) return <p className="text-xs text-slate-400">{empty}</p>;
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <div className="space-y-2">
      {rows.map((r) => (
        <div key={r.lane} className="flex items-center gap-2 sm:gap-3 text-xs">
          <span className="w-28 sm:w-44 truncate text-slate-600" title={r.lane}>{r.lane}</span>
          <div className="flex-1 h-4 bg-slate-100 rounded overflow-hidden">
            <div className={`h-full ${color}`} style={{ width: `${(r.count / max) * 100}%` }} />
          </div>
          <span className="w-14 text-right tabular-nums whitespace-nowrap">
            <span className="font-medium text-slate-700">{r.count}</span>
            {showUnits && r.units != null && <span className="text-slate-400"> · {r.units}u</span>}
          </span>
        </div>
      ))}
    </div>
  );
}
