"use client";

// PO Un-receive: find a PO (duplicates shown so the user picks the right one),
// enter how many to take off each line's received count, choose which bin(s)
// the matching stock comes out of (Receiving by default), review, apply.
// Nothing is written until the user hits Confirm on the review step.

import { useState } from "react";

interface PoMatch { id: string; legacyId: string; poNumber: string; status: string; vendor: string; poDate: string | null; createdAt: string | null; lineCount: number; ordered: number; received: number }
interface StockBin { locationId: string; locationName: string; qty: number }
interface PoLine { sku: string; productName: string; ordered: number; received: number; bins: StockBin[] }
interface PoDetail { id: string; legacyId: string; poNumber: string; status: string; vendor: string; poDate: string | null; lines: PoLine[] }
interface Removal { unreceive: number; stock: Record<string, number> } // locationId -> qty
interface LineResult { sku: string; ok: boolean; receivedBefore?: number; receivedAfter?: number; stock: Array<{ locationName: string; before: number; after: number; ok: boolean }>; error?: string }

const sizeOf = (name: string) => (name.match(/[-–]\s*([A-Z0-9-]+)$/)?.[1] ?? name.split(/\s+/).pop() ?? "");
const day = (iso: string | null) => (iso ? iso.slice(0, 10).split("-").reverse().join("/") : "—");

export function PoUnreceive({ shipheroConnected }: { shipheroConnected: boolean }) {
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [matches, setMatches] = useState<PoMatch[] | null>(null);
  const [detail, setDetail] = useState<PoDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [removals, setRemovals] = useState<Record<string, Removal>>({});
  const [review, setReview] = useState(false);
  const [applying, setApplying] = useState(false);
  const [results, setResults] = useState<LineResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function search() {
    if (!query.trim()) return;
    setSearching(true); setError(null); setMatches(null); setDetail(null); setResults(null); setRemovals({});
    try {
      const res = await fetch(`/api/po/unreceive/search?po=${encodeURIComponent(query.trim())}`);
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || "Search failed.");
      setMatches(j.matches);
      if (j.matches.length === 1) await pick(j.matches[0]);
    } catch (e) { setError(e instanceof Error ? e.message : "Search failed."); }
    finally { setSearching(false); }
  }

  async function pick(m: PoMatch) {
    setLoadingDetail(true); setError(null); setDetail(null); setRemovals({}); setResults(null);
    try {
      const res = await fetch(`/api/po/unreceive/detail?id=${encodeURIComponent(m.id)}`);
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || "Couldn't load PO.");
      setDetail(j.detail);
    } catch (e) { setError(e instanceof Error ? e.message : "Couldn't load PO."); }
    finally { setLoadingDetail(false); }
  }

  /** Set how many to un-receive on a line; default the stock removal to Receiving. */
  function setUnreceive(line: PoLine, n: number) {
    const v = Math.max(0, Math.min(line.received, Math.floor(n || 0)));
    setRemovals((r) => {
      const cur = r[line.sku] ?? { unreceive: 0, stock: {} };
      const stock: Record<string, number> = { ...cur.stock };
      // auto-suggest: take it all from Receiving if it's there, else leave for the user
      const recv = line.bins.find((b) => b.locationName === "Receiving");
      const alreadyChosen = Object.values(stock).reduce((a, q) => a + q, 0);
      if (v > 0 && alreadyChosen === 0 && recv && recv.qty >= v) stock[recv.locationId] = v;
      if (v === 0) for (const k of Object.keys(stock)) delete stock[k];
      return { ...r, [line.sku]: { unreceive: v, stock } };
    });
  }
  function setStock(line: PoLine, bin: StockBin, n: number) {
    const v = Math.max(0, Math.min(bin.qty, Math.floor(n || 0)));
    setRemovals((r) => {
      const cur = r[line.sku] ?? { unreceive: 0, stock: {} };
      const stock = { ...cur.stock, [bin.locationId]: v };
      if (v === 0) delete stock[bin.locationId];
      return { ...r, [line.sku]: { ...cur, stock } };
    });
  }

  const active = detail ? detail.lines.filter((l) => (removals[l.sku]?.unreceive ?? 0) > 0 || Object.values(removals[l.sku]?.stock ?? {}).some((q) => q > 0)) : [];
  const stockTotal = (sku: string) => Object.values(removals[sku]?.stock ?? {}).reduce((a, q) => a + q, 0);

  async function apply() {
    if (!detail) return;
    setApplying(true); setError(null);
    try {
      const lines = active.map((l) => ({
        sku: l.sku,
        unreceive: removals[l.sku]?.unreceive ?? 0,
        stock: Object.entries(removals[l.sku]?.stock ?? {}).filter(([, q]) => q > 0).map(([locationId, qty]) => ({
          locationId, locationName: l.bins.find((b) => b.locationId === locationId)?.locationName ?? "?", qty,
        })),
      }));
      const res = await fetch("/api/po/unreceive/apply", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ poId: detail.id, poNumber: detail.poNumber, lines }) });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || "Apply failed.");
      setResults(j.results);
      setReview(false);
      // refresh the PO so the table shows the new truth
      await pick({ id: detail.id } as PoMatch);
    } catch (e) { setError(e instanceof Error ? e.message : "Apply failed."); }
    finally { setApplying(false); }
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="h-14 shrink-0 border-b border-slate-200 bg-white flex items-center gap-3 px-4 lg:px-6">
        <h1 className="text-[15px] font-semibold text-slate-900">Un-receive</h1>
        <span className="text-xs text-slate-400 hidden md:inline">correct an over-received PO — takes units off the received count and out of the bin they landed in</span>
        <div className="flex-1" />
        <form onSubmit={(e) => { e.preventDefault(); search(); }} className="flex items-center gap-2">
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="PO number, e.g. PO510"
            className="text-sm border border-slate-200 rounded-md px-3 py-1.5 w-48 focus:ring-1 focus:ring-indigo-300 outline-none" />
          <button disabled={searching || !shipheroConnected} className="text-[13px] font-medium bg-indigo-600 text-white rounded-md px-3.5 py-1.5 hover:bg-indigo-700 disabled:opacity-50">
            {searching ? "Searching…" : "Find PO"}
          </button>
        </form>
      </div>

      <div className="flex-1 overflow-auto bg-slate-50">
        <div className="p-4 lg:p-6 flex flex-col gap-4 max-w-6xl">
          {!shipheroConnected && <div className="rounded-lg border border-amber-200 bg-amber-50 text-amber-700 text-sm px-4 py-3">ShipHero isn&apos;t connected.</div>}
          {error && <div className="rounded-lg border border-rose-200 bg-rose-50 text-rose-700 text-sm px-4 py-3">{error}</div>}

          {/* results of an apply */}
          {results && (
            <div className="bg-white border border-slate-200 rounded-lg p-4">
              <h2 className="text-[11px] uppercase tracking-wider text-slate-500 font-medium mb-3">
                Applied — {results.filter((r) => r.ok).length}/{results.length} lines OK
              </h2>
              {results.map((r) => (
                <div key={r.sku} className={`text-[13px] py-1.5 border-b border-slate-100 last:border-0 ${r.ok ? "text-slate-700" : "text-rose-700"}`}>
                  <b className="font-mono">{r.sku}</b>
                  {r.receivedBefore != null && <span> · received {r.receivedBefore} → <b>{r.receivedAfter}</b></span>}
                  {r.stock.map((s, i) => <span key={i}> · {s.locationName} {s.before} → <b>{s.after}</b>{s.ok ? "" : " ✗"}</span>)}
                  {r.error && <span> · {r.error}</span>}
                </div>
              ))}
            </div>
          )}

          {/* duplicate picker */}
          {matches && matches.length !== 1 && (
            <div className="bg-white border border-slate-200 rounded-lg p-4">
              <h2 className="text-[11px] uppercase tracking-wider text-slate-500 font-medium mb-3">
                {matches.length === 0 ? "No PO with that number" : `${matches.length} POs called ${matches[0].poNumber} — pick the right one`}
              </h2>
              {matches.map((m) => (
                <button key={m.id} onClick={() => pick(m)}
                  className={`w-full text-left grid grid-cols-[100px_1fr_150px_110px_110px_120px] gap-3 items-center px-3 py-2.5 rounded-md border mb-2 text-[13px] hover:bg-indigo-50/40 ${detail?.id === m.id ? "border-indigo-300 bg-indigo-50/60" : "border-slate-200"}`}>
                  <span className="font-mono text-xs text-slate-500">row {m.legacyId}</span>
                  <span className="text-slate-800 truncate">{m.vendor || "—"}</span>
                  <span><span className="px-1.5 py-0.5 rounded text-xs bg-slate-100 text-slate-600">{m.status || "—"}</span></span>
                  <span className="text-xs text-slate-500">expected {day(m.poDate)}</span>
                  <span className="text-xs text-slate-500">created {day(m.createdAt)}</span>
                  <span className="text-xs tabular-nums text-slate-600 text-right">{m.received}/{m.ordered} recv · {m.lineCount} lines</span>
                </button>
              ))}
            </div>
          )}

          {loadingDetail && <p className="text-sm text-slate-400">Loading PO lines and bin locations…</p>}

          {/* lines + removals */}
          {detail && (
            <div className="bg-white border border-slate-200 rounded-lg p-4">
              <div className="flex items-baseline gap-3 flex-wrap mb-3">
                <h2 className="text-[15px] font-semibold text-slate-900">{detail.poNumber}</h2>
                <span className="text-xs text-slate-500">row {detail.legacyId} · {detail.vendor} · <span className="px-1.5 py-0.5 rounded bg-slate-100">{detail.status}</span> · expected {day(detail.poDate)}</span>
                <div className="flex-1" />
                <button disabled={!active.length} onClick={() => setReview(true)}
                  className="text-[13px] font-medium bg-indigo-600 text-white rounded-md px-3.5 py-1.5 disabled:opacity-40">
                  Review {active.length ? `(${active.length} line${active.length === 1 ? "" : "s"})` : ""}
                </button>
              </div>
              <p className="text-xs text-slate-500 mb-3">
                Enter how many to <b>take off received</b> per size. Stock defaults to coming out of <b>Receiving</b>; if the units have moved on, pick the bin(s) below the line. Set stock to 0 if you&apos;ve already corrected the stock.
              </p>
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="text-[11px] uppercase tracking-wider text-slate-400 border-b border-slate-200">
                    <th className="text-left font-medium pb-2">Size · SKU</th>
                    <th className="text-right font-medium pb-2 px-3">Ordered</th>
                    <th className="text-right font-medium pb-2 px-3">Received</th>
                    <th className="text-right font-medium pb-2 px-3">Over</th>
                    <th className="text-right font-medium pb-2 px-3 w-32">Take off received</th>
                    <th className="text-left font-medium pb-2 pl-4">Stock out of</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.lines.map((l) => {
                    const r = removals[l.sku];
                    const over = l.received - l.ordered;
                    const chosen = stockTotal(l.sku);
                    const mismatch = (r?.unreceive ?? 0) > 0 && chosen !== r!.unreceive;
                    return (
                      <tr key={l.sku} className={`border-b border-slate-100 align-top ${r?.unreceive ? "bg-indigo-50/30" : ""}`}>
                        <td className="py-2">
                          <span className="font-semibold text-slate-800">{sizeOf(l.productName)}</span>
                          <span className="block font-mono text-[11px] text-slate-400">{l.sku}</span>
                        </td>
                        <td className="py-2 px-3 text-right tabular-nums">{l.ordered}</td>
                        <td className="py-2 px-3 text-right tabular-nums">{l.received}</td>
                        <td className={`py-2 px-3 text-right tabular-nums font-medium ${over > 0 ? "text-rose-600" : over < 0 ? "text-amber-600" : "text-slate-300"}`}>{over > 0 ? `+${over}` : over || "—"}</td>
                        <td className="py-2 px-3 text-right">
                          <input type="number" min={0} max={l.received} value={r?.unreceive || ""} placeholder="0"
                            onChange={(e) => setUnreceive(l, Number(e.target.value))}
                            className="w-20 text-right border border-slate-200 rounded px-2 py-1 tabular-nums" />
                        </td>
                        <td className="py-2 pl-4">
                          {(r?.unreceive ?? 0) > 0 ? (
                            <div className="flex flex-col gap-1">
                              {l.bins.length === 0 && <span className="text-xs text-amber-600">No stock anywhere — counter-only</span>}
                              {l.bins.map((b) => (
                                <label key={b.locationId} className="flex items-center gap-2 text-xs text-slate-600">
                                  <input type="number" min={0} max={b.qty} value={r?.stock[b.locationId] || ""} placeholder="0"
                                    onChange={(e) => setStock(l, b, Number(e.target.value))}
                                    className="w-16 text-right border border-slate-200 rounded px-1.5 py-0.5 tabular-nums" />
                                  <span className={b.locationName === "Receiving" ? "font-medium text-slate-700" : ""}>{b.locationName}</span>
                                  <span className="text-slate-400">has {b.qty}</span>
                                </label>
                              ))}
                              <span className={`text-[11px] ${mismatch ? "text-amber-600" : "text-slate-400"}`}>
                                stock out: {chosen} / {r!.unreceive}{mismatch ? (chosen === 0 ? " — counter only (stock already fixed?)" : " — doesn't match, check") : ""}
                              </span>
                            </div>
                          ) : <span className="text-xs text-slate-300">{l.bins.map((b) => `${b.locationName} ${b.qty}`).join(" · ") || "no stock"}</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* review + confirm */}
      {review && detail && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4" onClick={() => setReview(false)}>
          <div className="bg-white rounded-xl shadow-xl w-full max-w-xl max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="px-5 py-3.5 border-b border-slate-200">
              <h3 className="text-sm font-semibold text-slate-900">Un-receive on {detail.poNumber} (row {detail.legacyId})</h3>
              <p className="text-xs text-slate-500 mt-0.5">This writes to ShipHero: received counters go down, stock is subtracted from the bins listed. Each step is verified after it runs.</p>
            </div>
            <div className="px-5 py-3 overflow-y-auto">
              <table className="w-full text-xs">
                <thead><tr className="text-[10px] uppercase tracking-wide text-slate-400 text-left"><th className="py-1 pr-3">Size</th><th className="py-1 pr-3 text-right">Received</th><th className="py-1 pr-3">Stock removed</th></tr></thead>
                <tbody>
                  {active.map((l) => {
                    const r = removals[l.sku];
                    return (
                      <tr key={l.sku} className="border-t border-slate-100">
                        <td className="py-1.5 pr-3"><b>{sizeOf(l.productName)}</b> <span className="font-mono text-slate-400">{l.sku}</span></td>
                        <td className="py-1.5 pr-3 text-right tabular-nums">{l.received} → <b>{l.received - (r?.unreceive ?? 0)}</b></td>
                        <td className="py-1.5 pr-3">
                          {Object.entries(r?.stock ?? {}).filter(([, q]) => q > 0).map(([id, q]) => `${l.bins.find((b) => b.locationId === id)?.locationName ?? id} −${q}`).join(", ") || <span className="text-amber-600">none (counter only)</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="px-5 py-3.5 border-t border-slate-200 flex justify-end gap-2">
              <button onClick={() => setReview(false)} className="text-xs px-3.5 py-1.5 rounded-md border border-slate-200 text-slate-600 hover:bg-slate-50">Cancel</button>
              <button onClick={apply} disabled={applying} className="text-xs px-4 py-1.5 rounded-md bg-rose-600 text-white font-medium disabled:opacity-40">
                {applying ? "Applying…" : "Confirm & apply"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
