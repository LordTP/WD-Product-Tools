"use client";

// Warehouse Activity ("Operations") — what's been received, moved, and shipped
// on a given day, and who did it. A day is pulled from ShipHero once (Generate)
// and cached; everything here reads/filters that cached payload locally.
// Full-bleed layout to match the Dashboard.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  TYPE_META,
  area,
  timeHM,
  ymd,
  type EventType,
  type WarehouseDay,
} from "@/lib/warehouse-types";

const TYPES: EventType[] = ["received", "putaway", "replenish", "consolidation", "return-slotted", "picked", "shipped", "to-qc", "qc-release", "pick-reorg", "move", "adjust"];
const AV_COLORS = ["#6366f1", "#0ea5e9", "#f59e0b", "#10b981", "#ec4899", "#8b5cf6"];

function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "never";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
const kfmt = (n: number) => { const v = Number(n) || 0; return v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v); };
const metaOf = (t: string) => (TYPE_META as Record<string, { label: string; color: string }>)[t] ?? { label: t || "Other", color: "#64748b" };

export function WarehouseActivity({ shipheroConnected }: { shipheroConnected: boolean }) {
  const [date, setDate] = useState(ymd());
  const [day, setDay] = useState<WarehouseDay | null>(null);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [person, setPerson] = useState<string>("");
  const [type, setType] = useState<string>("");
  const [query, setQuery] = useState("");

  const loadCached = useCallback(async (d: string) => {
    setError(null);
    try {
      const res = await fetch(`/api/warehouse/day?date=${d}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load.");
      setDay(data.day ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load.");
      setDay(null);
    }
  }, []);

  useEffect(() => {
    (async () => {
      await loadCached(date);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date]);

  const generate = useCallback(async () => {
    if (!shipheroConnected) return;
    setGenerating(true);
    setError(null);
    try {
      const res = await fetch("/api/warehouse/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Generate failed.");
      setDay(data.day);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Generate failed.");
    } finally {
      setGenerating(false);
    }
  }, [shipheroConnected, date]);

  const s = day?.summary;
  const events = useMemo(() => {
    if (!day) return [];
    const q = query.trim().toLowerCase();
    return day.events.filter(
      (e) =>
        (!person || e.user === person) &&
        (!type || e.type === type) &&
        (!q || `${e.sku} ${e.fromBin ?? ""} ${e.toBin ?? ""} ${e.user}`.toLowerCase().includes(q)),
    );
  }, [day, person, type, query]);

  const maxType = Math.max(1, ...(s?.byType.map((t) => t.units) ?? [1]));
  const maxPerson = Math.max(1, ...(s?.byPerson.map((p) => p.total) ?? [1]));

  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden">
      <header className="h-14 bg-white border-b border-slate-200 flex items-center justify-between px-4 sm:px-5 shrink-0">
        <div className="flex items-center gap-3">
          <span className="font-semibold text-sm text-slate-900">Operations</span>
          <span className="hidden sm:inline text-xs text-slate-400">warehouse activity — what&apos;s been done &amp; who did it</span>
        </div>
        <div className="flex items-center gap-3">
          <input
            type="date"
            value={date}
            max={ymd()}
            onChange={(e) => setDate(e.target.value || ymd())}
            className="rounded-md border border-slate-300 px-2 py-1.5 text-xs text-slate-700"
          />
          {s && <span className="hidden sm:inline text-[11px] text-slate-400">generated {timeAgo(s.generatedAt)}</span>}
          <button
            onClick={generate}
            disabled={generating || !shipheroConnected}
            title="Pull this day's activity from ShipHero"
            className={`text-xs px-3 py-1.5 rounded-md flex items-center gap-1.5 ${
              shipheroConnected ? "bg-indigo-600 text-white hover:bg-indigo-700" : "bg-slate-200 text-slate-400 cursor-not-allowed"
            } disabled:opacity-60`}
          >
            <svg width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" className={generating ? "animate-spin" : ""}>
              <path d="M21 2v6h-6M3 12a9 9 0 0 1 15-6.7L21 8M3 22v-6h6M21 12a9 9 0 0 1-15 6.7L3 16" />
            </svg>
            {generating ? "Generating…" : day ? "Regenerate" : "Generate"}
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

        {!s ? (
          <div className="text-center py-20 text-sm text-slate-400">
            No activity pulled for <b className="text-slate-600">{date}</b> yet — hit{" "}
            <span className="font-medium text-slate-600">Generate</span>.
            <br />
            <span className="text-xs">Past days are cached after the first pull; only today re-generates.</span>
          </div>
        ) : (
          <>
            {/* KPIs */}
            <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-7 gap-3">
              <Kpi rail="#059669" label="Received" value={kfmt(s.receivedUnits)} sub={`units · ${s.receivedPOs.length} PO${s.receivedPOs.length === 1 ? "" : "s"}`} />
              <Kpi rail="#0d9488" label="Put away" value={kfmt(s.putAwayUnits)} sub="from receiving" />
              <Kpi rail="#7c3aed" label="Picked" value={kfmt(s.pickedItems)} sub="into totes" />
              <Kpi rail="#4338ca" label="Shipped" value={String(s.shippedOrders)} sub={`orders · ${s.shippedUnits} units`} />
              <Kpi rail="#d97706" label="Stock moved" value={kfmt(s.movedUnits)} sub={`${s.moveCount} moves`} />
              <Kpi rail="#0284c7" label="Returns slotted" value={kfmt(s.returnsUnits)} sub="into returns bins" />
              <Kpi rail="#6366f1" label="Staff active" value={String(s.staffActive)} sub="on the floor" />
            </div>

            {/* activity by type + flows */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
              <Panel title="Activity by type" desc="Every stock event today, grouped by what it was">
                {s.byType.length === 0 ? <Empty /> : s.byType.map((t) => {
                  const color = Object.values(TYPE_META).find((m) => m.label === t.key)?.color ?? "#64748b";
                  return (
                    <div key={t.key} className="flex items-center gap-3 text-xs mb-2">
                      <span className="w-40 text-slate-600 flex items-center gap-2 truncate">
                        <span className="w-2 h-2 rounded-full shrink-0" style={{ background: color }} />{t.key}
                      </span>
                      <span className="flex-1 h-[7px] bg-slate-100 rounded-full overflow-hidden">
                        <span className="block h-full rounded-full" style={{ width: `${(t.units / maxType) * 100}%`, background: color }} />
                      </span>
                      <span className="w-16 text-right tabular-nums font-semibold text-slate-800">{t.units.toLocaleString()}</span>
                    </div>
                  );
                })}
              </Panel>

              <Panel title="Movement flows" desc="Where stock went — from area → to area">
                {s.flows.length === 0 ? <Empty /> : s.flows.slice(0, 8).map((f, i) => (
                  <div key={i} className="flex items-center gap-2 text-xs py-2 border-t border-slate-100 first:border-t-0">
                    <span className="px-2 py-0.5 rounded bg-slate-50 border border-slate-200 font-semibold text-[11px]">{f.from}</span>
                    <span className="text-slate-300">→</span>
                    <span className="px-2 py-0.5 rounded bg-slate-50 border border-slate-200 font-semibold text-[11px]">{f.to}</span>
                    <span className="text-[10px] text-slate-400">{f.tag}</span>
                    <span className="ml-auto font-bold tabular-nums text-slate-800">{f.units.toLocaleString()}</span>
                  </div>
                ))}
              </Panel>
            </div>

            {/* who did what */}
            <Panel title="Who did what" desc="Actions per person, split by activity — click a name to filter the feed">
              <div className="overflow-x-auto -mx-1 px-1">
                <table className="w-full text-xs min-w-[42rem]">
                  <thead>
                    <tr className="text-[9.5px] uppercase tracking-wide text-slate-400 text-left">
                      <th className="font-medium pb-2">Person</th>
                      <th className="font-medium pb-2 text-right">Received</th>
                      <th className="font-medium pb-2 text-right">Put away</th>
                      <th className="font-medium pb-2 text-right">Moved</th>
                      <th className="font-medium pb-2 text-right">Picked</th>
                      <th className="font-medium pb-2 text-right">Shipped</th>
                      <th className="font-medium pb-2 text-right">Total</th>
                      <th className="font-medium pb-2 pl-3">Share</th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.byPerson.map((p, i) => (
                      <tr
                        key={p.name}
                        onClick={() => setPerson(person === p.name ? "" : p.name)}
                        className={`border-t border-slate-100 cursor-pointer hover:bg-slate-50 ${person === p.name ? "bg-indigo-50/60" : ""}`}
                      >
                        <td className="py-2">
                          <span className="flex items-center gap-2 font-semibold text-slate-700">
                            <span className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold text-white" style={{ background: AV_COLORS[i % AV_COLORS.length] }}>{p.initials}</span>
                            {p.name}
                          </span>
                        </td>
                        <td className="py-2 text-right tabular-nums text-slate-500">{p.received || "—"}</td>
                        <td className="py-2 text-right tabular-nums text-slate-500">{p.putAway || "—"}</td>
                        <td className="py-2 text-right tabular-nums text-slate-500">{p.moved || "—"}</td>
                        <td className="py-2 text-right tabular-nums text-slate-500">{p.picked || "—"}</td>
                        <td className="py-2 text-right tabular-nums text-slate-500">{p.shipped || "—"}</td>
                        <td className="py-2 text-right tabular-nums font-bold text-slate-800">{p.total}</td>
                        <td className="py-2 pl-3">
                          <span className="inline-block w-28 h-[5px] bg-slate-100 rounded-full overflow-hidden align-middle">
                            <span className="block h-full bg-indigo-400" style={{ width: `${(p.total / maxPerson) * 100}%` }} />
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>

            {/* shipped + received */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
              <Panel title="Shipped out" desc={`${s.shippedOrders} orders · ${s.shippedUnits} units`}>
                {s.shippedByService.length === 0 ? <Empty text="Nothing shipped this day." /> : s.shippedByService.map((c) => (
                  <div key={c.key} className="flex items-center gap-3 text-xs mb-2">
                    <span className="w-28 text-slate-600">{c.key}</span>
                    <span className="flex-1 h-[7px] bg-slate-100 rounded-full overflow-hidden">
                      <span className="block h-full bg-indigo-400 rounded-full" style={{ width: `${((c.count ?? 0) / Math.max(1, s.shippedOrders)) * 100}%` }} />
                    </span>
                    <span className="w-20 text-right tabular-nums font-semibold text-slate-800">{c.count} <span className="text-slate-400 font-normal">· {c.units}u</span></span>
                  </div>
                ))}
              </Panel>
              <Panel title="Received today" desc="POs booked in">
                {s.receivedPOs.length === 0 ? <Empty text="No PO received this day." /> : s.receivedPOs.map((p) => (
                  <div key={p.po} className="flex items-center gap-2 text-xs py-1.5">
                    <span className="font-mono text-[11px] text-slate-600">{p.po}</span>
                    <span className="ml-auto font-bold tabular-nums text-slate-800">{p.units}u</span>
                  </div>
                ))}
              </Panel>
            </div>

            {/* activity feed */}
            <div className="bg-white rounded-xl border border-slate-200 p-4">
              <div className="flex flex-wrap items-center gap-2 mb-3">
                <p className="text-xs font-semibold text-slate-700">Activity feed</p>
                <span className="text-[11px] text-slate-400">{events.length} of {day.events.length} events</span>
                <div className="ml-auto flex flex-wrap items-center gap-2">
                  <select value={person} onChange={(e) => setPerson(e.target.value)} className="rounded-md border border-slate-300 px-2 py-1 text-[11px] text-slate-700">
                    <option value="">Everyone</option>
                    {s.byPerson.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
                  </select>
                  <select value={type} onChange={(e) => setType(e.target.value)} className="rounded-md border border-slate-300 px-2 py-1 text-[11px] text-slate-700">
                    <option value="">All types</option>
                    {TYPES.map((t) => <option key={t} value={t}>{TYPE_META[t].label}</option>)}
                  </select>
                  <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search SKU / bin…" className="rounded-md border border-slate-300 px-2 py-1 text-[11px] text-slate-700 w-36" />
                  {(person || type || query) && <button onClick={() => { setPerson(""); setType(""); setQuery(""); }} className="text-[11px] text-slate-400 hover:underline">clear</button>}
                </div>
              </div>
              <div className="overflow-x-auto -mx-1 px-1">
                <table className="w-full text-xs min-w-[40rem]">
                  <thead>
                    <tr className="text-[9.5px] uppercase tracking-wide text-slate-400 text-left">
                      <th className="font-medium pb-2">Time</th><th className="font-medium pb-2">Who</th><th className="font-medium pb-2">SKU</th>
                      <th className="font-medium pb-2 text-right">Qty</th><th className="font-medium pb-2">Movement</th><th className="font-medium pb-2">Type</th>
                    </tr>
                  </thead>
                  <tbody>
                    {events.slice(0, 300).map((e, i) => {
                      const meta = metaOf(e.type);
                      return (
                        <tr key={i} className="border-t border-slate-100">
                          <td className="py-1.5 text-slate-400 tabular-nums whitespace-nowrap">{timeHM(e.at)}</td>
                          <td className="py-1.5 text-slate-600">{e.user}</td>
                          <td className="py-1.5 font-mono text-[11px] text-slate-500">{e.sku}</td>
                          <td className={`py-1.5 text-right tabular-nums font-bold ${e.qty >= 0 ? "text-emerald-600" : "text-rose-600"}`}>{e.qty >= 0 ? "+" : ""}{e.qty}</td>
                          <td className="py-1.5 text-slate-500">{e.toBin === "SHIPPED" ? "→ shipped" : `${e.fromBin ? area(e.fromBin) : "?"} → ${e.toBin ? area(e.toBin) : "?"}`}</td>
                          <td className="py-1.5"><span className="inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold" style={{ background: meta.color + "1a", color: meta.color }}>{meta.label}</span></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {events.length === 0 && <p className="text-center text-xs text-slate-400 py-6">No events match the filters.</p>}
                {events.length > 300 && <p className="text-center text-[11px] text-slate-400 py-3">Showing first 300 — narrow the filters to see more.</p>}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Kpi({ rail, label, value, sub }: { rail: string; label: string; value: string; sub: string }) {
  return (
    <div className="bg-white rounded-xl border border-slate-200 p-4 relative overflow-hidden">
      <span className="absolute left-0 top-0 bottom-0 w-[3px]" style={{ background: rail }} />
      <p className="text-[10px] uppercase tracking-wide text-slate-400">{label}</p>
      <p className="text-2xl font-bold mt-0.5 tabular-nums text-slate-900">{value}</p>
      <p className="text-[10.5px] text-slate-400 mt-0.5">{sub}</p>
    </div>
  );
}
function Panel({ title, desc, children }: { title: string; desc?: string; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-xl border border-slate-200 p-4">
      <p className="text-xs font-semibold text-slate-700">{title}</p>
      {desc && <p className="text-[11px] text-slate-400 mb-3 mt-0.5">{desc}</p>}
      {!desc && <div className="mb-3" />}
      {children}
    </div>
  );
}
function Empty({ text = "Nothing here." }: { text?: string }) {
  return <p className="text-xs text-slate-400">{text}</p>;
}
