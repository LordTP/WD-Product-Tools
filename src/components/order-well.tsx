"use client";

// Order Well — the fulfilment picture, redrawn (per the approved mockup):
// KPIs · carrier cutoff countdowns · lane table · ready-age buckets with a
// click-through order table · blocked-by-product (with the PO that fixes it) ·
// destination mix · today's pace · a dark TV/wallboard mode (?tv=1).
// Reads the cached snapshot instantly; Sync re-scans; TV mode keeps the cache
// warm via /api/ops/stats?warm=1 (server-side single-flight, ~2.5 min cadence).

import { useCallback, useEffect, useRef, useState } from "react";
import type { AgeBucket, LaneRow, OpsStats } from "@/lib/ops-types";
import { CARRIERS, carrierForLane, type Carrier } from "@/lib/ops-cutoffs";
import { DHL_LOGO, RM_LOGO } from "@/lib/carrier-logos";
import { ukHM } from "@/lib/uk-time";

function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "never";
  const secs = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  return `${Math.round(mins / 60)}h ago`;
}

const region = new Intl.DisplayNames(["en-GB"], { type: "region" });
function countryLabel(cc: string): string {
  if (!/^[A-Z]{2}$/i.test(cc)) return cc;
  const up = cc.toUpperCase();
  const flag = up.replace(/./g, (c) => String.fromCodePoint(127397 + c.charCodeAt(0)));
  const name = up === "GB" ? "UK" : (() => { try { return region.of(up) ?? up; } catch { return up; } })();
  return `${flag} ${name}`;
}

/** London wall-clock minutes now, and whether it's a collection day (Mon–Fri). */
function londonNow(): { minutes: number; weekday: boolean; hm: string } {
  const now = new Date();
  const hm = ukHM(now.toISOString());
  const wd = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", weekday: "short" }).format(now);
  return { minutes: Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5)), weekday: !["Sat", "Sun"].includes(wd), hm };
}
const toMin = (hm: string) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));

interface CutoffView {
  carrier: Carrier;
  left: number | null; // minutes to van (null = van gone / weekend)
  ordersLeft: number;
  needPerHour: number | null;
  doingPerHour: number;
  risk: boolean;
}
function cutoffViews(stats: OpsStats | null): CutoffView[] {
  const { minutes, weekday } = londonNow();
  const hourNow = Math.floor(minutes / 60);
  return CARRIERS.map((carrier) => {
    const lanes = (stats?.lanes ?? []).filter((l) => carrierForLane(l.family) === carrier.key);
    const ordersLeft = lanes.reduce((a, l) => a + l.dueToday, 0);
    const left = weekday && minutes < toMin(carrier.van) ? toMin(carrier.van) - minutes : null;
    const needPerHour = left && left > 0 ? Math.ceil(ordersLeft / (left / 60)) : null;
    const doingPerHour = stats?.shippedByHour?.[Math.max(0, hourNow - 1)] ?? 0;
    return { carrier, left, ordersLeft, needPerHour, doingPerHour, risk: needPerHour !== null && ordersLeft > 0 && doingPerHour < needPerHour };
  });
}
const fmtLeft = (m: number) => `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;

export function OrderWell({ shipheroConnected, initialStats, initialTv = false }: {
  shipheroConnected: boolean;
  initialStats: OpsStats | null;
  initialTv?: boolean;
}) {
  const [stats, setStats] = useState<OpsStats | null>(initialStats);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tv, setTv] = useState(initialTv);
  const [ageSel, setAgeSel] = useState(3);
  const [, setClock] = useState(0); // re-render for countdowns
  const [tvTick, setTvTick] = useState(30);
  const statsRef = useRef(stats);
  useEffect(() => { statsRef.current = stats; }, [stats]);

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

  // countdown clocks tick every 30s (they're time maths, not data)
  useEffect(() => {
    const t = setInterval(() => setClock((c) => c + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  // TV mode: poll the cache every 30s; ?warm=1 keeps the scan running (~2.5 min) server-side
  useEffect(() => {
    if (!tv) return;
    const poll = async () => {
      try {
        const res = await fetch("/api/ops/stats?warm=1");
        const data = await res.json();
        if (data.stats && data.stats.syncedAt !== statsRef.current?.syncedAt) setStats(data.stats);
      } catch { /* next poll retries */ }
    };
    void poll();
    const p = setInterval(poll, 30_000);
    const tick = setInterval(() => setTvTick((x) => (x <= 1 ? 30 : x - 1)), 1000);
    return () => { clearInterval(p); clearInterval(tick); };
  }, [tv]);

  const lanes: LaneRow[] = stats?.lanes ?? [];
  const buckets: AgeBucket[] = stats?.ageBuckets ?? [];
  const cuts = cutoffViews(stats);
  const dueTodayTotal = lanes.reduce((a, l) => a + l.dueToday, 0);
  const readySingles = lanes.reduce((a, l) => a + l.singles, 0);
  const readyMultis = lanes.reduce((a, l) => a + l.multis, 0);
  const maxReady = Math.max(1, ...lanes.map((l) => l.ready));
  const byHour = stats?.shippedByHour ?? [];
  const bucket = buckets[ageSel] ?? buckets[buckets.length - 1];
  const asOf = stats ? ukHM(stats.syncedAt) : "—";

  const orderUrl = (legacyId: string) => `https://app.shiphero.com/dashboard/orders/details/${legacyId}`;

  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden bg-slate-50">
      <header className="h-14 bg-white border-b border-slate-200 flex items-center gap-3 px-5 shrink-0">
        <span className="font-semibold text-sm text-slate-900">Order Well</span>
        <span className="hidden sm:inline text-xs text-slate-400">the fulfilment picture</span>
        <div className="flex-1" />
        {stats && <span className="text-[11px] text-slate-400">data as of {asOf} · synced {timeAgo(stats.syncedAt)}</span>}
        <button onClick={() => setTv(true)} className="text-xs px-3 py-1.5 rounded-md border border-slate-300 text-slate-700 hover:bg-slate-50" title="Full-screen wallboard for the warehouse TV — keeps itself fresh (~2 min)">📺 TV mode</button>
        <button onClick={sync} disabled={syncing || !shipheroConnected}
          className="text-xs px-3 py-1.5 rounded-md bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 flex items-center gap-1.5">
          <svg width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" className={syncing ? "animate-spin" : ""}><path d="M21 2v6h-6M3 12a9 9 0 0 1 15-6.7L21 8M3 22v-6h6M21 12a9 9 0 0 1-15 6.7L3 16" /></svg>
          {syncing ? "Syncing…" : "Sync"}
        </button>
      </header>

      <div className="flex-1 min-h-0 overflow-auto p-4 lg:p-5 flex flex-col gap-4">
        {error && <div className="text-xs bg-rose-50 border border-rose-200 text-rose-700 rounded-lg px-3 py-2">{error}</div>}
        {!shipheroConnected && <div className="text-xs bg-amber-50 border border-amber-200 text-amber-800 rounded-lg px-3 py-2">ShipHero isn&apos;t connected.</div>}
        {!stats ? (
          <div className="text-center py-20 text-sm text-slate-400">Click <b className="text-slate-600">Sync</b> to pull the current picture from ShipHero.</div>
        ) : (
          <>
            {/* KPIs */}
            <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
              <Kpi label="Unfulfilled" value={stats.totalOpen} sub={`${stats.scannedOrders} orders scanned`} />
              <Kpi label="Ready to pick" value={stats.readyTotal} tone="ok" sub={`${readySingles} singles · ${readyMultis} multis`} />
              <Kpi label="Blocked — waiting stock" value={stats.waitingTotal} tone="warn" sub={stats.blockedProducts?.[0] ? `top: ${stats.blockedProducts[0].product} (${stats.blockedProducts[0].orders})` : "—"} />
              <Kpi label="Shipped today" value={`${stats.shippedOrders}`} sub={`${stats.shippedUnits} units · due today ${dueTodayTotal}`} />
              <Kpi label="Oldest ready order" value={stats.oldestReady ? `${stats.oldestReady.ageDays}d` : "—"} tone={stats.oldestReady && stats.oldestReady.ageDays >= 2 ? "bad" : undefined} sub={stats.oldestReady ? `${stats.oldestReady.orderNumber} · ${stats.oldestReady.lane}` : "nothing ready"} />
            </div>

            {/* cutoffs */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
              {cuts.map((c) => (
                <div key={c.carrier.key} className={`bg-white border rounded-xl px-4 py-3 grid grid-cols-[auto_1fr_auto] gap-x-4 gap-y-1 items-center ${c.risk ? "border-rose-300" : "border-slate-200"}`}>
                  <span className="flex flex-col gap-1">
                    {c.carrier.key === "dhl"
                      ? <span className="inline-flex items-center bg-[#FFCC00] rounded px-2 py-1 h-[24px] [&_svg]:h-[11px] [&_svg]:w-auto" dangerouslySetInnerHTML={{ __html: DHL_LOGO }} />
                      : <span className="inline-flex items-center h-[24px] [&_svg]:h-[22px] [&_svg]:w-auto" dangerouslySetInnerHTML={{ __html: RM_LOGO }} />}
                    <span className="text-[10.5px] text-slate-400">cutoff {c.carrier.cutoff} · van {c.carrier.van}</span>
                  </span>
                  <span className={`font-mono text-xl font-semibold ${c.risk ? "text-rose-600" : "text-slate-900"}`}>
                    {c.left !== null ? fmtLeft(c.left) : "van gone"}
                    <span className="block font-sans text-[10.5px] font-normal text-slate-400">{c.left !== null ? "until pickup" : "next collection next working day"}</span>
                  </span>
                  <span className="text-right text-xs text-slate-500">
                    {c.ordersLeft} due-today order{c.ordersLeft === 1 ? "" : "s"} still open
                    <b className={`block font-mono text-sm ${c.risk ? "text-rose-600" : "text-emerald-600"}`}>
                      {c.needPerHour !== null ? `need ${c.needPerHour}/h · last hr ${c.doingPerHour}` : `shipped ${stats.shippedOrders} today`}
                    </b>
                  </span>
                </div>
              ))}
            </div>

            <div className="grid grid-cols-1 xl:grid-cols-[1.5fr_1fr] gap-4">
              {/* lanes */}
              <Panel title="Lanes">
                <LaneTable lanes={lanes} maxReady={maxReady} dark={false} />
              </Panel>

              {/* ages + click table */}
              <Panel title="Ready orders — how long they've waited">
                <div className="flex items-end gap-2 h-24">
                  {buckets.map((b, i) => {
                    const max = Math.max(1, ...buckets.map((x) => x.count));
                    const tone = i === 2 ? "bg-amber-500" : i === 3 ? "bg-rose-600" : "bg-indigo-600";
                    return (
                      <button key={b.label} onClick={() => setAgeSel(i)} className={`flex-1 flex flex-col items-center justify-end gap-1 h-full rounded-md p-1 ${ageSel === i ? "bg-indigo-50" : "hover:bg-slate-50"}`}>
                        <span className="font-mono text-[11px] text-slate-700">{b.count}</span>
                        <i className={`block w-full max-w-[52px] rounded-t ${tone}`} style={{ height: `${Math.max(4, (b.count / max) * 100)}%` }} />
                        <span className={`text-[10.5px] ${ageSel === i ? "text-indigo-800 font-semibold" : "text-slate-400"}`}>{b.label}</span>
                      </button>
                    );
                  })}
                </div>
                <div className="mt-2 max-h-44 overflow-auto thin-scroll border-t border-slate-100">
                  {bucket && bucket.orders.length === 0 && <p className="text-xs text-slate-400 py-3">No ready orders in this bucket.</p>}
                  <table className="w-full text-xs">
                    <tbody>
                      {bucket?.orders.map((o) => (
                        <tr key={o.legacyId} className="border-b border-slate-100 last:border-0 hover:bg-indigo-50/40 cursor-pointer" onClick={() => window.open(orderUrl(o.legacyId), "_blank")} title="Open in ShipHero">
                          <td className="py-1.5 pr-2 font-mono font-semibold whitespace-nowrap">{o.orderNumber}</td>
                          <td className="py-1.5 pr-2 text-slate-600 truncate max-w-[220px]">{o.items}</td>
                          <td className="py-1.5 pr-2 whitespace-nowrap"><span className="px-1.5 py-0.5 rounded-full bg-indigo-50 text-indigo-700 text-[10.5px]">{o.lane}</span></td>
                          <td className={`py-1.5 text-right font-mono ${o.ageDays >= 3 ? "text-rose-600 font-semibold" : "text-slate-500"}`}>{o.ageDays}d</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="text-[10.5px] text-slate-400 mt-1.5">Click a bar to switch bucket · click an order to open it in ShipHero{bucket && bucket.count > bucket.orders.length ? ` · showing oldest ${bucket.orders.length} of ${bucket.count}` : ""}.</p>
              </Panel>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              {/* blocked products */}
              <Panel title="Blocked — what's actually missing">
                {(stats.blockedProducts ?? []).length === 0 && <p className="text-xs text-slate-400">Nothing blocked. 🎉</p>}
                <div className="flex flex-col">
                  {(stats.blockedProducts ?? []).map((b) => (
                    <div key={b.product} className="grid grid-cols-[1fr_96px] gap-2 items-center py-2 border-b border-slate-100 last:border-0 text-xs">
                      <span className="min-w-0">
                        <b className="text-slate-900">{b.product}</b>
                        <span className="block text-[11px] text-slate-500">
                          {b.incomingPo ? <>waiting on <a className="text-indigo-700 hover:underline" href={`/history?q=${encodeURIComponent(b.incomingPo)}`}>{b.incomingPo}</a>{b.incomingDate ? ` — expected ${b.incomingDate.split("-").reverse().join("/")}` : ""}</> : <span className="text-amber-700">{b.note}</span>}
                        </span>
                      </span>
                      <span className="text-right font-mono text-slate-700">{b.orders} order{b.orders === 1 ? "" : "s"}
                        <span className="block h-1.5 bg-slate-100 rounded mt-1 overflow-hidden"><i className="block h-full bg-amber-500 rounded" style={{ width: `${(b.orders / Math.max(1, stats.blockedProducts?.[0]?.orders ?? 1)) * 100}%` }} /></span>
                      </span>
                    </div>
                  ))}
                </div>
              </Panel>

              {/* countries */}
              <Panel title="Where orders are going" legend={[["bg-indigo-600", "shipped today"], ["bg-indigo-200", "still open"]]}>
                <div className="flex flex-col gap-2.5">
                  {(stats.countries ?? []).map((c) => {
                    const shippedN = c.shipped ?? 0;
                    const maxBoth = Math.max(1, ...(stats.countries ?? []).map((x) => x.open + (x.shipped ?? 0)));
                    return (
                      <div key={c.country} className="grid grid-cols-[112px_1fr_92px] gap-2 items-center text-xs">
                        <span className="text-slate-700 truncate">{countryLabel(c.country)}</span>
                        <span className="h-3 bg-slate-100 rounded overflow-hidden flex">
                          <i className="block h-full bg-indigo-600" style={{ width: `${(shippedN / maxBoth) * 100}%` }} />
                          <i className="block h-full bg-indigo-200" style={{ width: `${(c.open / maxBoth) * 100}%` }} />
                        </span>
                        <span className="text-right font-mono text-slate-700 whitespace-nowrap">{shippedN}<span className="text-slate-400 font-sans"> + {c.open} open</span></span>
                      </div>
                    );
                  })}
                </div>
                <p className="text-[10.5px] text-slate-400 mt-3 border-t border-slate-100 pt-2">
                  International open: {lanes.filter((l) => /international/i.test(l.family)).map((l) => `${l.family.replace(/international\s*[-–]\s*/i, "")} ${l.ready + l.blocked}`).join(" · ") || "none"} · shipped today {stats.shippedOrders} orders to {(stats.countries ?? []).filter((c) => (c.shipped ?? 0) > 0).length} countries
                </p>
              </Panel>

              {/* pace */}
              <Panel title="Today's pace — orders shipped per hour" legend={[["bg-indigo-500", "shipped"], ["border-t-2 border-dashed border-rose-400 bg-transparent", "needed rate"]]}>
                <PacePanel byHour={byHour} cuts={cuts} shippedOrders={stats.shippedOrders} />
              </Panel>


            </div>

            <p className="text-[11px] text-slate-400">
              Snapshot from the last Sync (data as of {asOf}). Ready/blocked use ShipHero&apos;s own allocation flags; &ldquo;due today&rdquo; = ready orders placed before that carrier&apos;s cutoff. Countdown clocks are always live.
            </p>
          </>
        )}
      </div>

      {/* ---------- TV mode ---------- */}
      {tv && (
        <div className="fixed inset-0 z-[70] bg-[#0b1020] text-slate-200 flex flex-col p-7 lg:p-10 overflow-auto">
          <div className="flex items-baseline gap-4 mb-6">
            <h2 className="text-2xl font-semibold text-white m-0">WANDERDOLL · Order Well</h2>
            <span className="font-mono text-slate-400 text-sm">data as of {asOf} · next check in {tvTick}s</span>
            <div className="flex-1" />
            <button onClick={() => setTv(false)} className="text-slate-400 border border-slate-600 rounded-lg px-3 py-1.5 text-sm hover:text-white">Exit ✕</button>
          </div>
          {stats && (
            <>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-5 mb-6">
                <TvCard label="Shipped today" value={String(stats.shippedOrders)} sub={`${stats.shippedUnits} units`} />
                <TvCard label="Ready to pick" value={String(stats.readyTotal)} sub={`${readySingles} singles · ${readyMultis} multis`} tone="green" />
                <TvCard label="Due today left" value={String(dueTodayTotal)} sub="ordered before cutoff" tone={dueTodayTotal > 0 ? "amber" : "green"} />
                <TvCard label="Oldest ready" value={stats.oldestReady ? `${stats.oldestReady.ageDays}d` : "—"} sub={stats.oldestReady?.orderNumber ?? ""} tone={stats.oldestReady && stats.oldestReady.ageDays >= 2 ? "red" : undefined} />
              </div>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 mb-6">
                {cuts.map((c) => (
                  <div key={c.carrier.key} className="bg-[#111a33] rounded-2xl px-6 py-4 flex items-center gap-5">
                    {c.carrier.key === "dhl"
                      ? <span className="inline-flex items-center bg-[#FFCC00] rounded-md px-3 py-1.5 [&_svg]:h-[14px] [&_svg]:w-auto" dangerouslySetInnerHTML={{ __html: DHL_LOGO }} />
                      : <span className="inline-flex items-center [&_svg]:h-[26px] [&_svg]:w-auto" dangerouslySetInnerHTML={{ __html: RM_LOGO }} />}
                    <span className={`font-mono text-4xl font-semibold ${c.left === null ? "text-slate-500" : c.risk ? "text-rose-400" : "text-emerald-400"}`}>
                      {c.left !== null ? fmtLeft(c.left) : "done"}
                    </span>
                    <span className="text-[15px] text-slate-300">
                      <b className="text-white">Van {c.carrier.van} · cutoff {c.carrier.cutoff}</b><br />
                      {c.left !== null ? <>{c.ordersLeft} orders left{c.needPerHour !== null ? ` · need ${c.needPerHour}/h, last hr ${c.doingPerHour}` : ""}</> : "next collection next working day"}
                    </span>
                  </div>
                ))}
              </div>
              <div className="bg-[#111a33] rounded-2xl px-6 py-4">
                <p className="text-[13px] uppercase tracking-widest text-slate-400 mb-2">Lanes — ready to pick</p>
                <LaneTable lanes={lanes} maxReady={maxReady} dark />
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Kpi({ label, value, sub, tone }: { label: string; value: string | number; sub?: string; tone?: "ok" | "warn" | "bad" }) {
  const color = tone === "ok" ? "text-emerald-600" : tone === "warn" ? "text-amber-600" : tone === "bad" ? "text-rose-600" : "text-slate-900";
  return (
    <div className="bg-white border border-slate-200 rounded-xl px-4 py-3">
      <p className="text-[10.5px] uppercase tracking-wider text-slate-500">{label}</p>
      <p className={`text-[23px] font-semibold tabular-nums leading-tight mt-0.5 ${color}`}>{value}</p>
      {sub && <p className="text-[11px] text-slate-500 truncate" title={sub}>{sub}</p>}
    </div>
  );
}

function Panel({ title, legend, children }: { title: string; legend?: Array<[string, string]>; children: React.ReactNode }) {
  return (
    <div className="bg-white border border-slate-200 rounded-xl p-4 min-w-0">
      <div className="flex items-center mb-2.5">
        <p className="text-[10.5px] uppercase tracking-wider text-slate-500 font-medium">{title}</p>
        <div className="flex-1" />
        {legend && (
          <span className="flex gap-3 text-[10.5px] text-slate-500">
            {legend.map(([cls, label]) => (
              <span key={label} className="inline-flex items-center gap-1.5"><i className={`inline-block w-3 h-2 rounded-[2px] ${cls}`} />{label}</span>
            ))}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

/** Hourly bars with a dashed "needed rate" line (due-today ÷ hours to the last
 *  van), plus the day's summary — total, average over active hours, peak. */
function PacePanel({ byHour, cuts, shippedOrders }: { byHour: number[]; cuts: CutoffView[]; shippedOrders: number }) {
  const hours = Array.from({ length: 13 }, (_, i) => i + 7); // 07–19
  const active = byHour.filter((v) => v > 0);
  const avg = active.length ? Math.round(byHour.reduce((a, v) => a + v, 0) / active.length) : 0;
  const peakHour = byHour.reduce((best, v, h) => (v > (byHour[best] ?? 0) ? h : best), 0);
  // target = whichever open carrier demands the highest rate right now
  const need = Math.max(0, ...cuts.filter((c) => c.needPerHour !== null && c.ordersLeft > 0).map((c) => c.needPerHour ?? 0));
  const max = Math.max(1, ...hours.map((h) => byHour[h] ?? 0), need);
  return (
    <>
      <div className="relative h-36">
        {need > 0 && (
          <div className="absolute left-0 right-0 border-t-2 border-dashed border-rose-400 z-10" style={{ bottom: `${(need / max) * 82 + 14}%` }}>
            <span className="absolute right-0 -top-4 text-[10px] font-mono text-rose-500">need {need}/h</span>
          </div>
        )}
        <div className="flex items-end gap-1.5 h-full pt-4 pb-5">
          {hours.map((h) => (
            <div key={h} className="flex-1 flex flex-col items-center justify-end gap-0.5 h-full" title={`${String(h).padStart(2, "0")}:00 — ${byHour[h] ?? 0} orders`}>
              {(byHour[h] ?? 0) > 0 && <span className="font-mono text-[10px] text-slate-600">{byHour[h]}</span>}
              <i className={`block w-full rounded-t ${h === peakHour && (byHour[h] ?? 0) > 0 ? "bg-indigo-700" : "bg-indigo-500"}`} style={{ height: `${Math.max(2, ((byHour[h] ?? 0) / max) * 100)}%` }} />
            </div>
          ))}
        </div>
        <div className="absolute bottom-0 left-0 right-0 flex gap-1.5">
          {hours.map((h) => <span key={h} className="flex-1 text-center text-[9.5px] text-slate-400">{h}</span>)}
        </div>
      </div>
      <div className="grid grid-cols-3 gap-2 mt-3 border-t border-slate-100 pt-2.5">
        {[["Shipped", `${shippedOrders}`], ["Avg / active hour", `${avg}`], ["Peak", byHour[peakHour] ? `${String(peakHour).padStart(2, "0")}:00 · ${byHour[peakHour]}` : "—"]].map(([l, v]) => (
          <div key={l}>
            <p className="text-[9.5px] uppercase tracking-wider text-slate-400">{l}</p>
            <p className="font-mono text-sm font-semibold text-slate-800">{v}</p>
          </div>
        ))}
      </div>
      <p className="text-[10.5px] text-slate-400 mt-2">London hours · dashed line = rate needed to clear due-today before the last van.</p>
    </>
  );
}

function LaneTable({ lanes, maxReady, dark }: { lanes: LaneRow[]; maxReady: number; dark: boolean }) {
  const th = dark ? "text-slate-500" : "text-slate-400";
  const td = dark ? "border-slate-700/60 text-slate-200" : "border-slate-100 text-slate-700";
  return (
    <table className="w-full border-collapse">
      <thead>
        <tr className={`text-[10px] uppercase tracking-wider ${th}`}>
          <th className="text-left font-medium pb-2">Lane</th>
          <th className="text-right font-medium pb-2 px-3">Ready</th>
          <th className="text-right font-medium pb-2 px-3">Due today</th>
          <th className="text-right font-medium pb-2 px-3">Singles</th>
          <th className="text-right font-medium pb-2 px-3">Multis</th>
          <th className="text-right font-medium pb-2 px-3">Blocked</th>
          <th className="text-right font-medium pb-2">Oldest</th>
        </tr>
      </thead>
      <tbody>
        {lanes.map((l) => (
          <tr key={l.family} className={dark ? "" : "hover:bg-slate-50"}>
            <td className={`py-2 border-t text-[13px] font-medium ${td} ${dark ? "text-white text-[15px]" : "text-slate-900"}`}>{l.family}</td>
            <td className={`py-2 border-t px-3 text-right font-mono font-semibold ${td} ${dark ? "text-[19px]" : "text-[14px]"}`}>{l.ready}
              {!dark && <span className="block h-1 bg-slate-100 rounded mt-1 overflow-hidden min-w-[70px]"><i className="block h-full bg-indigo-500 rounded" style={{ width: `${(l.ready / maxReady) * 100}%` }} /></span>}
            </td>
            <td className={`py-2 border-t px-3 text-right font-mono ${td} ${l.dueToday > 0 ? (dark ? "text-amber-300" : "text-amber-700 font-semibold") : ""}`}>{l.dueToday}</td>
            <td className={`py-2 border-t px-3 text-right font-mono ${td}`}>{l.singles}</td>
            <td className={`py-2 border-t px-3 text-right font-mono ${td}`}>{l.multis}</td>
            <td className={`py-2 border-t px-3 text-right ${td}`}>{l.blocked > 0 ? <span className={dark ? "font-mono text-slate-400" : "font-mono text-amber-700 bg-amber-50 rounded-full px-2 py-0.5 text-[11px] font-semibold"}>{l.blocked}</span> : <span className="font-mono opacity-40">0</span>}</td>
            <td className={`py-2 border-t text-right font-mono ${td} ${l.oldestReadyDays !== null && l.oldestReadyDays >= 2 ? (dark ? "text-rose-400 font-semibold" : "text-rose-600 font-semibold") : ""}`}>{l.oldestReadyDays !== null ? `${l.oldestReadyDays}d` : "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function TvCard({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "green" | "amber" | "red" }) {
  const color = tone === "green" ? "text-emerald-400" : tone === "amber" ? "text-amber-400" : tone === "red" ? "text-rose-400" : "text-white";
  return (
    <div className="bg-[#111a33] rounded-2xl px-6 py-5">
      <p className="text-[12px] uppercase tracking-widest text-slate-400">{label}</p>
      <p className={`font-mono text-5xl font-semibold leading-tight ${color}`}>{value}</p>
      {sub && <p className="text-[13px] text-slate-400 mt-1">{sub}</p>}
    </div>
  );
}
