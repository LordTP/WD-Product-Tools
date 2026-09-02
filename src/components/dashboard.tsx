"use client";

// Dashboard — the morning briefing (per the approved mockup). One cache-only
// fetch (/api/dashboard) renders: the day so far · the PO position (tiles that
// deep-link into PO History pre-filtered) · landing weeks · receiving in
// transit · needs attention · returns week · value by expected month.
// Sync queues the po/returns/ops jobs through the shared sync registry.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { SizeMap } from "@/lib/sizes";
import type { AttnRow, DashboardData, RecvRow } from "@/lib/dashboard-types";
import { PoBreakdownModal } from "./po-breakdown-modal";

const gbp = (n: number) => "£" + Math.round(n).toLocaleString("en-GB");
const gbpK = (n: number) => (n >= 100_000 ? `£${Math.round(n / 1000)}k` : gbp(n));
const fmt = (n: number) => n.toLocaleString("en-GB");

function timeAgo(iso: string | null): string {
  if (!iso) return "never";
  const secs = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (secs < 90) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

function ukDateLine(): string {
  const now = new Date();
  const day = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "Europe/London" }).format(now);
  // ISO week number
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const week = Math.ceil((((d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86_400_000) + 1) / 7);
  return `${day} · week ${week}`;
}

const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthLabel = (ym: string) => MONTHS_SHORT[Number(ym.slice(5, 7)) - 1] ?? ym;

export function Dashboard({ shipheroConnected, sizeMap }: { shipheroConnected: boolean; sizeMap: SizeMap }) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [selected, setSelected] = useState<RecvRow | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/dashboard");
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? "Failed to load.");
      setData(d);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load.");
    }
  }, []);

  useEffect(() => {
    void (async () => { await load(); })();
  }, [load]);

  async function sync() {
    if (!shipheroConnected) return;
    setSyncing(true);
    setSyncMsg(null);
    try {
      // All three go through the shared queue server-side (one at a time).
      const results = await Promise.allSettled([
        fetch("/api/po/sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ since: "2025-01-01" }) }),
        fetch("/api/returns-hub/sync", { method: "POST" }),
        fetch("/api/ops/sync", { method: "POST" }),
      ]);
      const failed = results.filter((r) => r.status === "rejected" || (r.status === "fulfilled" && !r.value.ok)).length;
      setSyncMsg(failed ? `${3 - failed}/3 synced` : "all fresh");
      await load();
    } finally {
      setSyncing(false);
    }
  }

  const t = data?.today;
  const p = data?.poPosition;
  const jobAt = (key: string) => data?.jobs.find((j) => j.key === key)?.at ?? null;
  const maxWeek = Math.max(1, ...(data?.weeks ?? []).map((w) => w.units));
  const maxMonth = Math.max(1, ...(data?.months ?? []).map((m) => m.value));
  const maxReason = Math.max(1, ...(data?.returnsWeek.reasons ?? []).map((r) => r.units));
  const spark = t?.shippedByHour?.slice(6, 21) ?? [];
  const maxSpark = Math.max(1, ...spark);

  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden">
      <header className="h-14 bg-white border-b border-slate-200 flex items-center justify-between px-4 sm:px-5 shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <span className="font-semibold text-sm text-slate-900">Dashboard</span>
          <span className="hidden sm:inline text-xs text-slate-400 truncate">{ukDateLine()}</span>
        </div>
        <div className="flex items-center gap-3">
          {data && (
            <span className="hidden md:inline text-[11px] text-slate-400">
              POs {timeAgo(jobAt("po"))} · returns {timeAgo(jobAt("returns"))} · orders {timeAgo(jobAt("ops"))}
              {syncMsg && <span className="text-emerald-600"> · {syncMsg}</span>}
            </span>
          )}
          <button
            onClick={() => void sync()}
            disabled={syncing || !shipheroConnected}
            title="Refresh POs, returns and the order well (queued, incremental)"
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

      <div className="flex-1 min-h-0 overflow-auto p-3 sm:p-5 space-y-4">
        {error && <div className="text-xs bg-rose-50 border border-rose-200 text-rose-700 rounded p-2">{error}</div>}
        {!data && !error && <div className="text-center py-16 text-sm text-slate-400">Loading the briefing…</div>}

        {data && t && p && (
          <>
            {/* 1 · today */}
            <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
              <Tile href="/order-well" label="Shipped today" go="Order Well ›">
                <Big v={t.shippedOrders === null ? "—" : fmt(t.shippedOrders)} small={t.shippedOrders === null ? "no scan yet" : `orders · ${fmt(t.shippedUnits)} units`} />
                {spark.length > 0 && (
                  <div className="flex items-end gap-[3px] h-8 mt-2">
                    {spark.map((v, i) => (
                      <div key={i} title={`${i + 6}:00 — ${v}`} className={`flex-1 rounded-sm ${i === spark.length - 1 ? "bg-indigo-500" : "bg-indigo-200"}`} style={{ height: `${Math.max(8, (v / maxSpark) * 100)}%` }} />
                    ))}
                  </div>
                )}
                <Sub>by hour, 6am → 8pm</Sub>
              </Tile>
              <Tile href="/order-well" label="Open orders" go="Order Well ›">
                <Big v={fmt(t.totalOpen)} />
                <Sub><b className="text-slate-600">{fmt(t.readyTotal)}</b> ready to pick · <b className="text-slate-600">{fmt(t.waitingTotal)}</b> waiting on stock</Sub>
                {t.oldestReady && <Sub>oldest ready <b className="text-slate-600">{t.oldestReady.ageDays}d</b> · {t.oldestReady.lane}</Sub>}
              </Tile>
              <Tile href="/order-well" label="Due on today's vans" go="Order Well ›">
                <Big v={fmt(t.dueDhl + t.dueRm)} small="orders" />
                <Sub>DHL <b className="text-slate-600">{fmt(t.dueDhl)}</b> (van 3:30pm) · RM <b className="text-slate-600">{fmt(t.dueRm)}</b> (5:30pm)</Sub>
              </Tile>
              <Tile href="/returns" label="Returns" go="Returns ›">
                <Big v={fmt(t.returnsOpenedToday)} small="opened today" />
                <Sub>this week <b className="text-slate-600">{fmt(t.returnsOpenedWeek)}</b> opened · <b className="text-slate-600">{fmt(t.returnsProcessedWeek)}</b> processed</Sub>
              </Tile>
            </div>

            {/* 2 · PO position */}
            <div className="grid grid-cols-2 xl:grid-cols-5 gap-4">
              <Tile href="/history" label="Value on order" go="POs ›">
                <Big v={gbpK(p.valueOnOrder)} />
                <Sub>{p.openCount} open POs · {p.vendorCount} vendor{p.vendorCount === 1 ? "" : "s"}</Sub>
              </Tile>
              <Tile href="/history" label="Units to come" go="POs ›">
                <Big v={fmt(p.unitsToCome)} />
                <Sub>across {p.datedCount} dated POs</Sub>
              </Tile>
              <Tile href="/history?win=14" label="Landing ≤ 14 days" go="POs ›">
                <Big v={fmt(p.landing14Units)} small="units" />
                <Sub>{p.landing14Pos} PO{p.landing14Pos === 1 ? "" : "s"} expected</Sub>
              </Tile>
              <Tile href="/history?win=overdue" label="Past expected date" go="POs ›" tone={p.overdueCount > 0 ? "bad" : undefined}>
                <Big v={fmt(p.overdueCount)} small="POs" tone={p.overdueCount > 0 ? "bad" : undefined} />
                <Sub>{p.overdueCount > 0 ? `${fmt(p.overdueUnits)} units late · worst ${p.overdueWorstDays} days` : "all on track"}</Sub>
              </Tile>
              <Tile href="/history?missing=1" label="Missing dates" go="POs ›" tone={p.missingCount > 0 ? "warn" : undefined}>
                <Big v={fmt(p.missingCount)} small="POs" tone={p.missingCount > 0 ? "warn" : undefined} />
                <Sub>{p.missingCount > 0 ? "no ex-factory or expected date yet" : "everything dated"}</Sub>
              </Tile>
            </div>

            {/* 3 · landing weeks + receiving + attention */}
            <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
              <Panel title="Landing — next 4 weeks" go={{ href: "/calendar", label: "Calendar ›" }}>
                <div className="space-y-2">
                  {data.weeks.map((w) => (
                    <Link key={w.label} href={w.href} className="grid grid-cols-[92px_1fr_110px] gap-2.5 items-center text-xs rounded hover:bg-indigo-50/60 py-0.5">
                      <span className="text-slate-600">{w.label}{w.sub && <span className="block text-[10px] text-slate-400">{w.sub}</span>}</span>
                      <span className="h-3 bg-slate-100 rounded-full overflow-hidden">
                        <span className={`block h-full rounded-full ${w.late ? "bg-rose-500" : "bg-indigo-500"}`} style={{ width: `${Math.min(100, (w.units / maxWeek) * 100)}%` }} />
                      </span>
                      <span className="text-right tabular-nums text-slate-600">{fmt(w.units)} <span className="text-slate-400">u · {w.pos} POs</span></span>
                    </Link>
                  ))}
                </div>
              </Panel>

              <Panel title="Receiving — in transit" go={{ href: "/history?status=In%20transit", label: "All ›" }}>
                {data.receiving.length === 0 ? (
                  <p className="text-xs text-slate-400">No POs currently in transit.</p>
                ) : (
                  <div className="divide-y divide-slate-50 -my-1">
                    {data.receiving.map((r) => (
                      <button key={r.po.poNumber} onClick={() => setSelected(r)} title="Receiving breakdown" className="w-full grid grid-cols-[58px_1fr_92px] gap-2.5 items-center py-1.5 text-xs text-left hover:bg-indigo-50/60 rounded">
                        <span className="font-mono font-semibold text-slate-700">{r.po.poNumber}</span>
                        <span className="min-w-0">
                          <span className="block truncate text-slate-600">{r.po.products[0] ?? "—"}</span>
                          <span className="block h-1.5 bg-slate-100 rounded-full overflow-hidden mt-1">
                            <span className={`block h-full rounded-full ${r.state === "over" ? "bg-rose-500" : r.state === "complete" ? "bg-emerald-500" : r.state === "awaiting" ? "bg-slate-300" : "bg-indigo-500"}`} style={{ width: `${Math.max(r.state === "awaiting" ? 0 : 4, r.pct)}%` }} />
                          </span>
                        </span>
                        <span className="text-right tabular-nums text-slate-600">
                          {fmt(r.po.unitsReceived)} / {fmt(r.po.unitsOrdered)}
                          <span className={`block text-[10px] ${r.state === "over" ? "text-rose-600" : r.state === "complete" ? "text-emerald-600" : "text-slate-400"}`}>
                            {r.state === "over" ? `+${fmt(r.po.unitsReceived - r.po.unitsOrdered)} over` : r.state === "complete" ? "done — close it" : r.state === "awaiting" ? "awaiting" : "booking in"}
                          </span>
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </Panel>

              <Panel title="Needs attention">
                {data.attention.length === 0 ? (
                  <p className="text-xs text-emerald-600">Nothing needs attention. 🎉</p>
                ) : (
                  <div className="divide-y divide-slate-50 -my-1">
                    {data.attention.map((a, i) => <AttnLine key={i} a={a} />)}
                  </div>
                )}
              </Panel>
            </div>

            {/* 4 · returns week + value by month */}
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
              <Panel title="Returns — last 7 days" go={{ href: "/returns", label: "Returns ›" }}>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-500 mb-3">
                  <span><b className="text-slate-800 tabular-nums">{fmt(data.returnsWeek.opened)}</b> opened</span>
                  <span><b className="text-slate-800 tabular-nums">{fmt(data.returnsWeek.processed)}</b> processed</span>
                  <span><b className="text-slate-800 tabular-nums">{gbpK(data.returnsWeek.valueOpen)}</b> in the post</span>
                  <span><b className="text-slate-800 tabular-nums">{data.returnsWeek.faultyPct}%</b> faulty</span>
                </div>
                {data.returnsWeek.reasons.length === 0 ? (
                  <p className="text-xs text-slate-400">No returns opened this week.</p>
                ) : (
                  <div className="space-y-2">
                    {data.returnsWeek.reasons.map((r) => (
                      <div key={r.key} className="grid grid-cols-[128px_1fr_64px] gap-2.5 items-center text-xs">
                        <span className="truncate text-slate-600">{r.key}</span>
                        <span className="h-2.5 bg-slate-100 rounded-full overflow-hidden">
                          <span className="block h-full rounded-full bg-indigo-400" style={{ width: `${(r.units / maxReason) * 100}%` }} />
                        </span>
                        <span className="text-right tabular-nums text-slate-500">{r.units} · {r.pct}%</span>
                      </div>
                    ))}
                  </div>
                )}
              </Panel>

              <Panel title="Order value by expected month">
                {data.months.length === 0 ? (
                  <p className="text-xs text-slate-400">No dated POs yet.</p>
                ) : (
                  <div className="flex items-end gap-2 h-32 pt-2">
                    {data.months.map((m) => (
                      <div key={m.ym} className="flex-1 flex flex-col items-center justify-end gap-1 h-full min-w-0 group" title={`${monthLabel(m.ym)} — ${gbp(m.value)} · ${m.pos} POs`}>
                        <span className={`text-[9px] tabular-nums ${m.current ? "text-slate-600" : "text-slate-400 invisible group-hover:visible"}`}>{gbpK(m.value)}</span>
                        <div className={`w-full max-w-11 rounded-t ${m.current ? "bg-indigo-500" : "bg-indigo-200 group-hover:bg-indigo-300"}`} style={{ height: `${Math.max(3, (m.value / maxMonth) * 78)}%` }} />
                        <span className={`text-[9px] ${m.current ? "text-slate-700 font-semibold" : "text-slate-400"}`}>{monthLabel(m.ym)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </Panel>
            </div>

            <p className="text-[11px] text-slate-400">
              Everything from the local caches — the background sync keeps them fresh; Sync forces a refresh now.
            </p>
          </>
        )}
      </div>

      {selected && (
        <PoBreakdownModal key={selected.po.poNumber} po={selected.po} sizeMap={sizeMap} onClose={() => setSelected(null)} />
      )}
    </div>
  );
}

// ---- pieces ----

function Tile({ href, label, go, tone, children }: { href: string; label: string; go: string; tone?: "bad" | "warn"; children: React.ReactNode }) {
  return (
    <Link href={href} className={`block bg-white rounded-xl border p-4 hover:border-indigo-300 hover:shadow-sm transition-colors group ${tone === "bad" ? "border-rose-200" : tone === "warn" ? "border-amber-200" : "border-slate-200"}`}>
      <p className="text-[11px] uppercase tracking-wide text-slate-400 flex items-center justify-between">
        {label}
        <span className="normal-case tracking-normal text-indigo-500 opacity-0 group-hover:opacity-100 transition-opacity">{go}</span>
      </p>
      {children}
    </Link>
  );
}

function Big({ v, small, tone }: { v: string; small?: string; tone?: "bad" | "warn" }) {
  const color = tone === "bad" ? "text-rose-600" : tone === "warn" ? "text-amber-600" : "text-slate-900";
  return (
    <p className={`text-2xl font-bold mt-1 tabular-nums ${color}`}>
      {v}{small && <span className="text-xs font-medium text-slate-400 ml-1.5">{small}</span>}
    </p>
  );
}

function Sub({ children }: { children: React.ReactNode }) {
  return <p className="text-[11px] text-slate-400 mt-0.5">{children}</p>;
}

function Panel({ title, go, children }: { title: string; go?: { href: string; label: string }; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-xl border border-slate-200 p-4 min-w-0">
      <p className="text-xs font-semibold text-slate-700 mb-3 flex items-center justify-between">
        {title}
        {go && <Link href={go.href} className="text-[11px] font-normal text-indigo-500 hover:underline">{go.label}</Link>}
      </p>
      {children}
    </div>
  );
}

function AttnLine({ a }: { a: AttnRow }) {
  const dot = a.sev === "bad" ? "bg-rose-500" : a.sev === "warn" ? "bg-amber-500" : "bg-indigo-400";
  const body = (
    <>
      <span className={`w-2 h-2 rounded-full shrink-0 ${dot}`} />
      <span className="text-slate-600 min-w-0 flex-1"><b className="text-slate-800">{a.strong}</b> {a.text}</span>
      {a.cta && <span className="text-[11px] text-indigo-500 whitespace-nowrap shrink-0">{a.cta}</span>}
    </>
  );
  if (!a.cta || a.href === "#") return <div className="flex items-center gap-2.5 py-1.5 text-xs">{body}</div>;
  return <Link href={a.href} className="flex items-center gap-2.5 py-1.5 text-xs hover:bg-indigo-50/60 rounded group">{body}</Link>;
}
