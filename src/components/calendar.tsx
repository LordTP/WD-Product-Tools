"use client";

// Monthly PO calendar. POs sit on their poDate; click one → read-only breakdown
// (reuses PoBreakdownModal). Busy days collapse to "+N more" → a day panel.
// Search spotlights matches (PO #, product, vendor, SKU) and lists them.

import { useMemo, useState } from "react";
import type { PoSummary } from "@/lib/shiphero/po-pull";
import type { SizeMap } from "@/lib/sizes";
import { PoBreakdownModal } from "./po-breakdown-modal";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const fmtMonth = (d: Date) => d.toLocaleDateString("en-GB", { month: "long", year: "numeric" });
const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

// status → chip colour (matches the app's status palette)
function chip(status: string): { bg: string; text: string; dot: string } {
  const k = (status || "").toLowerCase();
  if (k.includes("cancel")) return { bg: "bg-rose-50", text: "text-rose-700", dot: "bg-rose-400" };
  if (k.includes("deliver") || k.includes("close") || k.includes("receiv"))
    return { bg: "bg-emerald-50", text: "text-emerald-700", dot: "bg-emerald-500" };
  if (k.includes("transit")) return { bg: "bg-indigo-50", text: "text-indigo-700", dot: "bg-indigo-500" };
  if (k.includes("ready") || k.includes("arranged")) return { bg: "bg-sky-50", text: "text-sky-700", dot: "bg-sky-500" };
  if (k.includes("order") || k.includes("pending") || k.includes("quot"))
    return { bg: "bg-amber-50", text: "text-amber-700", dot: "bg-amber-500" };
  return { bg: "bg-slate-100", text: "text-slate-600", dot: "bg-slate-400" };
}

export function Calendar({
  pos,
  searchIndex,
  sizeMap,
}: {
  pos: PoSummary[];
  searchIndex: Record<string, string>;
  sizeMap: SizeMap;
}) {
  const [view, setView] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<PoSummary | null>(null);
  const [dayKey, setDayKey] = useState<string | null>(null);

  const q = query.trim().toLowerCase();
  const matches = (p: PoSummary) => !q || (searchIndex[p.poNumber] ?? "").includes(q);

  const byDate = useMemo(() => {
    const m: Record<string, PoSummary[]> = {};
    for (const p of pos) {
      const k = p.poDate?.slice(0, 10);
      if (!k) continue;
      (m[k] ??= []).push(p);
    }
    return m;
  }, [pos]);

  const results = useMemo(
    () => (q ? pos.filter(matches).sort((a, b) => (a.poDate ?? "") < (b.poDate ?? "") ? 1 : -1) : []),
    [q, pos], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const cells = useMemo(() => {
    const y = view.getFullYear(), m = view.getMonth();
    const lead = (new Date(y, m, 1).getDay() + 6) % 7; // Monday-start
    const start = new Date(y, m, 1 - lead);
    return Array.from({ length: 42 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
  }, [view]);

  const todayKey = iso(new Date());
  const dayPos = dayKey ? (byDate[dayKey] ?? []) : [];
  const shiftMonth = (n: number) => setView((v) => new Date(v.getFullYear(), v.getMonth() + n, 1));

  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden">
      {/* header + search */}
      <header className="h-14 bg-white border-b border-slate-200 flex items-center gap-3 px-4 sm:px-5 shrink-0">
        <span className="font-semibold text-sm text-slate-900">Calendar</span>
        <span className="hidden md:inline text-xs text-slate-400">purchase orders by date</span>
        <div className="relative ml-auto w-56 sm:w-72">
          <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4-4" /></svg>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search PO #, product or SKU…"
            className="w-full pl-8 pr-3 py-1.5 text-xs border border-slate-200 rounded-md outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
          />
          {q && (
            <div className="absolute top-full mt-1.5 right-0 w-80 max-h-72 overflow-auto bg-white border border-slate-200 rounded-lg shadow-lg z-30 thin-scroll">
              {results.length === 0 ? (
                <p className="px-3 py-3 text-xs text-slate-400 text-center">No POs match “{query}”.</p>
              ) : (
                results.slice(0, 12).map((p) => {
                  const c = chip(p.status);
                  return (
                    <button
                      key={p.poNumber}
                      onClick={() => { if (p.poDate) setView(new Date(Number(p.poDate.slice(0, 4)), Number(p.poDate.slice(5, 7)) - 1, 1)); setSelected(p); }}
                      className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-slate-50 border-b border-slate-50 last:border-0"
                    >
                      <span className={`w-2 h-2 rounded-full shrink-0 ${c.dot}`} />
                      <span className="font-mono text-xs font-semibold text-slate-700 w-14 shrink-0">{p.poNumber}</span>
                      <span className="flex-1 min-w-0 text-xs text-slate-600 truncate">{p.products[0] ?? "—"}</span>
                      <span className="text-[11px] text-slate-400 tabular-nums shrink-0">{p.poDate?.slice(5, 10).replace("-", "/")}</span>
                    </button>
                  );
                })
              )}
              {results.length > 12 && <p className="px-3 py-2 text-[11px] text-slate-400 text-center">+{results.length - 12} more — refine your search</p>}
            </div>
          )}
        </div>
      </header>

      {/* toolbar */}
      <div className="bg-white border-b border-slate-200 px-4 sm:px-5 py-2.5 flex items-center gap-2 sm:gap-3 flex-wrap shrink-0">
        <div className="flex items-center gap-1">
          <button onClick={() => shiftMonth(-1)} aria-label="Previous month" className="w-7 h-7 rounded-md border border-slate-200 text-slate-500 hover:bg-slate-50">‹</button>
          <span className="text-sm font-semibold text-slate-800 w-40 text-center">{fmtMonth(view)}</span>
          <button onClick={() => shiftMonth(1)} aria-label="Next month" className="w-7 h-7 rounded-md border border-slate-200 text-slate-500 hover:bg-slate-50">›</button>
        </div>
        <button onClick={() => { const d = new Date(); setView(new Date(d.getFullYear(), d.getMonth(), 1)); }} className="text-xs px-3 py-1.5 rounded-md border border-slate-200 text-slate-600 hover:bg-slate-50">Today</button>
        <div className="ml-auto hidden sm:flex items-center gap-3 text-[11px] text-slate-500 flex-wrap">
          {[["In transit", "bg-indigo-500"], ["Ready / arranged", "bg-sky-500"], ["On order / pending", "bg-amber-500"], ["Delivered", "bg-emerald-500"]].map(([l, d]) => (
            <span key={l} className="inline-flex items-center gap-1.5"><span className={`w-2 h-2 rounded-full ${d}`} />{l}</span>
          ))}
        </div>
      </div>

      {/* grid */}
      <div className="flex-1 min-h-0 overflow-auto p-3 sm:p-5">
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden min-w-[720px]">
          <div className="grid grid-cols-7 border-b border-slate-200">
            {WEEKDAYS.map((d) => (
              <div key={d} className="px-2.5 py-2 text-[10px] uppercase tracking-wide text-slate-400 font-medium">{d}</div>
            ))}
          </div>
          <div className="grid grid-cols-7">
            {cells.map((d, i) => {
              const key = iso(d);
              const inMonth = d.getMonth() === view.getMonth();
              const list = byDate[key] ?? [];
              const anyHit = q ? list.some(matches) : false;
              const units = list.reduce((a, p) => a + p.unitsOrdered, 0);
              return (
                <div key={i} className={`min-h-[116px] border-r border-b border-slate-100 [&:nth-child(7n)]:border-r-0 p-1.5 flex flex-col gap-1 ${inMonth ? "" : "bg-slate-50/60"} ${q && list.length && !anyHit ? "opacity-60" : ""}`}>
                  <div className="flex items-center justify-between">
                    <button
                      onClick={() => list.length && setDayKey(key)}
                      className={`text-xs tabular-nums ${list.length ? "cursor-pointer hover:text-indigo-600" : "cursor-default"} ${inMonth ? "text-slate-600" : "text-slate-300"} ${key === todayKey ? "bg-indigo-600 text-white w-5 h-5 rounded-full flex items-center justify-center font-semibold" : ""}`}
                    >
                      {d.getDate()}
                    </button>
                    {units > 0 && <span className="text-[10px] text-slate-400 tabular-nums">{units.toLocaleString()}u</span>}
                  </div>
                  {list.slice(0, 3).map((p) => {
                    const c = chip(p.status);
                    const dim = q && !matches(p);
                    return (
                      <button
                        key={p.poNumber}
                        onClick={() => setSelected(p)}
                        title={`${p.poNumber} · ${p.status} · ${p.products[0] ?? ""}`}
                        className={`flex items-center gap-1.5 px-1.5 py-1 rounded text-[11px] ${c.bg} ${c.text} hover:brightness-95 ${dim ? "opacity-20 grayscale" : q && matches(p) ? "ring-1 ring-offset-0" : ""}`}
                      >
                        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${c.dot}`} />
                        <span className="font-mono font-semibold text-[10px]">{p.poNumber}</span>
                        <span className="truncate text-slate-500">{(p.products[0] ?? "—").split(" | ")[0]}</span>
                      </button>
                    );
                  })}
                  {list.length > 3 && (
                    <button onClick={() => setDayKey(key)} className="text-[10px] text-indigo-600 hover:underline text-left px-1.5">+{list.length - 3} more</button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
        <p className="text-[11px] text-slate-400 mt-3">POs are placed on their PO date. Click a PO for its breakdown; click a day (or “+N more”) to see everything landing that day.</p>
      </div>

      {/* day panel */}
      {dayKey && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/40 p-4" onClick={() => setDayKey(null)}>
          <div className="bg-white rounded-xl shadow-xl w-full max-w-lg max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="px-5 py-4 border-b border-slate-200 flex items-start justify-between">
              <div>
                <p className="text-sm font-semibold text-slate-900">{new Date(dayKey + "T00:00:00").toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })}</p>
                <p className="text-xs text-slate-400 mt-0.5">{dayPos.length} PO{dayPos.length === 1 ? "" : "s"} · {dayPos.reduce((a, p) => a + p.unitsOrdered, 0).toLocaleString()} units</p>
              </div>
              <button onClick={() => setDayKey(null)} className="text-slate-400 hover:text-slate-700 text-xl leading-none">×</button>
            </div>
            <div className="overflow-auto thin-scroll">
              {dayPos.map((p) => {
                const c = chip(p.status);
                return (
                  <button key={p.poNumber} onClick={() => { setDayKey(null); setSelected(p); }} className="w-full flex items-center gap-2.5 px-5 py-2.5 text-left hover:bg-slate-50 border-b border-slate-50 last:border-0">
                    <span className={`w-2 h-2 rounded-full shrink-0 ${c.dot}`} />
                    <span className="font-mono text-xs font-semibold text-slate-700 w-14 shrink-0">{p.poNumber}</span>
                    <span className="flex-1 min-w-0 text-xs text-slate-600 truncate">{p.products[0] ?? "—"}</span>
                    <span className={`text-[11px] px-1.5 py-0.5 rounded ${c.bg} ${c.text} shrink-0`}>{p.status || "—"}</span>
                    <span className="text-[11px] text-slate-400 tabular-nums w-10 text-right shrink-0">{p.unitsOrdered.toLocaleString()}u</span>
                  </button>
                );
              })}
            </div>
            <div className="px-5 py-3 border-t border-slate-200 flex items-center justify-between">
              <span className="text-[11px] text-slate-400">Click a PO for its breakdown</span>
              <button onClick={() => setDayKey(null)} className="text-xs px-3 py-1.5 rounded-md border border-slate-200 text-slate-600 hover:bg-slate-50">Close</button>
            </div>
          </div>
        </div>
      )}

      {selected && <PoBreakdownModal key={selected.poNumber} po={selected} sizeMap={sizeMap} onClose={() => setSelected(null)} />}
    </div>
  );
}
