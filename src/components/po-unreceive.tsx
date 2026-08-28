"use client";

// PO Un-receive — full-page, three-step flow:
//   1. Find the PO (duplicates listed so the right twin is picked)
//   2. Per size: how many to take off "received", and which bin(s) the stock
//      comes out of (Receiving pre-filled; bins load lazily so the PO opens fast)
//   3. Review → Confirm (the only step that writes to ShipHero)

import { useCallback, useEffect, useRef, useState } from "react";
import { deriveSizeFromSku, type SizeMap } from "@/lib/sizes";

interface PoMatch { id: string; legacyId: string; poNumber: string; status: string; vendor: string; poDate: string | null; createdAt: string | null; lineCount: number; ordered: number; received: number }
interface StockBin { locationId: string; locationName: string; qty: number }
interface PoLine { sku: string; productName: string; ordered: number; received: number; bins: StockBin[] }
interface PoDetail { id: string; legacyId: string; poNumber: string; status: string; vendor: string; poDate: string | null; lines: PoLine[] }
interface Removal { unreceive: number; stock: Record<string, number> } // locationId -> qty
interface LineResult { sku: string; ok: boolean; receivedBefore?: number; receivedAfter?: number; stock: Array<{ locationName: string; before: number; after: number; ok: boolean }>; error?: string }
type BinsState = StockBin[] | "loading" | undefined;

const sizeOf = (name: string) => (name.match(/[-–]\s*([A-Z0-9-]+)$/)?.[1] ?? name.split(/\s+/).pop() ?? "");
const productOf = (name: string) => name.replace(/\s*[-–]\s*[A-Z0-9-]+$/, "").trim();
const day = (iso: string | null) => (iso ? iso.slice(0, 10).split("-").reverse().join("/") : "—");

export function PoUnreceive({ shipheroConnected, initialPo = "", sizeMap }: { shipheroConnected: boolean; initialPo?: string; sizeMap: SizeMap }) {
  // Size comes from the SKU's size code (same map as PO History). ShipHero's
  // product_name often has no size suffix, so never derive it from the name alone.
  const sizeLabel = (l: { sku: string; productName: string }): string => deriveSizeFromSku(l.sku, sizeMap) || sizeOf(l.productName);
  const [query, setQuery] = useState(initialPo);
  const [searching, setSearching] = useState(false);
  const [matches, setMatches] = useState<PoMatch[] | null>(null);
  const [detail, setDetail] = useState<PoDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [bins, setBins] = useState<Record<string, BinsState>>({});
  const [removals, setRemovals] = useState<Record<string, Removal>>({});
  const [review, setReview] = useState(false);
  const [applying, setApplying] = useState(false);
  const [results, setResults] = useState<LineResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const binsRef = useRef<Record<string, BinsState>>({});
  useEffect(() => { binsRef.current = bins; }, [bins]);

  // ---- data ----
  // Once a SKU's bins are known, pre-fill Receiving for a line that has a
  // quantity but no bin chosen yet (or whose only choice is Receiving at the old qty).
  const autoFill = useCallback((sku: string, list: StockBin[]) => {
    const recv = list.find((x) => x.locationName === "Receiving");
    if (!recv) return;
    setRemovals((r) => {
      const rem = r[sku];
      if (!rem || rem.unreceive <= 0) return r;
      const keys = Object.keys(rem.stock);
      if (keys.length !== 0 && !(keys.length === 1 && keys[0] === recv.locationId)) return r;
      const qty = Math.min(rem.unreceive, recv.qty);
      if (rem.stock[recv.locationId] === qty) return r;
      return { ...r, [sku]: { ...rem, stock: { [recv.locationId]: qty } } };
    });
  }, []);
  const fetchBins = useCallback(async (sku: string) => {
    if (binsRef.current[sku]) return;
    setBins((b) => ({ ...b, [sku]: "loading" }));
    try {
      const res = await fetch(`/api/po/unreceive/bins?sku=${encodeURIComponent(sku)}`);
      const j = await res.json();
      const list: StockBin[] = res.ok ? (j.bins as StockBin[]) : [];
      setBins((b) => ({ ...b, [sku]: list }));
      autoFill(sku, list);
    } catch { setBins((b) => ({ ...b, [sku]: [] })); }
  }, [autoFill]);

  // background prefetch, 4 at a time, so bins are usually ready before anyone types
  useEffect(() => {
    if (!detail) return;
    let cancelled = false;
    const queue = detail.lines.map((l) => l.sku).filter((s) => !binsRef.current[s]);
    (async () => {
      while (queue.length && !cancelled) {
        await Promise.all(queue.splice(0, 4).map((s) => fetchBins(s)));
      }
    })();
    return () => { cancelled = true; };
  }, [detail, fetchBins]);

  async function search(value: string = query) {
    if (!value.trim()) return;
    setSearching(true); setError(null); setMatches(null); setDetail(null); setResults(null); setRemovals({}); setBins({});
    try {
      const res = await fetch(`/api/po/unreceive/search?po=${encodeURIComponent(value.trim())}`);
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || "Search failed.");
      setMatches(j.matches);
      if (j.matches.length === 1) await pick(j.matches[0]);
    } catch (e) { setError(e instanceof Error ? e.message : "Search failed."); }
    finally { setSearching(false); }
  }

  async function pick(m: PoMatch) {
    setLoadingDetail(true); setError(null); setDetail(null); setRemovals({});
    try {
      const res = await fetch(`/api/po/unreceive/detail?id=${encodeURIComponent(m.id)}`);
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || "Couldn't load PO.");
      setDetail(j.detail);
    } catch (e) { setError(e instanceof Error ? e.message : "Couldn't load PO."); }
    finally { setLoadingDetail(false); }
  }

  // Deep link from PO History (/po-unreceive?po=PO510): search straight away.
  useEffect(() => {
    if (initialPo) void (async () => { await search(initialPo); })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function reset() { setQuery(""); setMatches(null); setDetail(null); setRemovals({}); setResults(null); setBins({}); setError(null); }

  // ---- edits ----
  function setUnreceive(line: PoLine, n: number) {
    const v = Math.max(0, Math.min(line.received, Math.floor(n || 0)));
    if (v > 0) fetchBins(line.sku);
    setRemovals((r) => {
      const cur = r[line.sku] ?? { unreceive: 0, stock: {} };
      const stock: Record<string, number> = v === 0 ? {} : { ...cur.stock };
      return { ...r, [line.sku]: { unreceive: v, stock } };
    });
    const b = bins[line.sku];
    if (v > 0 && Array.isArray(b)) autoFill(line.sku, b);
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
  const totalUnreceive = active.reduce((a, l) => a + (removals[l.sku]?.unreceive ?? 0), 0);
  const totalStock = active.reduce((a, l) => a + stockTotal(l.sku), 0);
  const binName = (sku: string, id: string) => (Array.isArray(bins[sku]) ? (bins[sku] as StockBin[]).find((b) => b.locationId === id)?.locationName : undefined) ?? "?";

  async function apply() {
    if (!detail) return;
    setApplying(true); setError(null);
    try {
      const lines = active.map((l) => ({
        sku: l.sku, unreceive: removals[l.sku]?.unreceive ?? 0,
        stock: Object.entries(removals[l.sku]?.stock ?? {}).filter(([, q]) => q > 0).map(([locationId, qty]) => ({ locationId, locationName: binName(l.sku, locationId), qty })),
      }));
      const res = await fetch("/api/po/unreceive/apply", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ poId: detail.id, poNumber: detail.poNumber, lines }) });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || "Apply failed.");
      setResults(j.results); setReview(false); setRemovals({}); setBins({});
      await pick({ id: detail.id } as PoMatch);
    } catch (e) { setError(e instanceof Error ? e.message : "Apply failed."); }
    finally { setApplying(false); }
  }

  const step = results ? 4 : detail ? 2 : 1;

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="h-14 shrink-0 border-b border-slate-200 bg-white flex items-center gap-4 px-4 lg:px-6">
        <h1 className="text-[15px] font-semibold text-slate-900">Un-receive</h1>
        <span className="text-xs text-slate-400 hidden md:inline">correct an over-received PO — counter and stock, verified step by step</span>
        <div className="flex-1" />
        <Steps step={step} />
        {(detail || matches) && (
          <button onClick={reset} className="text-xs text-slate-500 hover:text-slate-800 border border-slate-200 rounded-md px-2.5 py-1">Start over</button>
        )}
      </div>

      <div className="flex-1 overflow-auto bg-slate-50">
        <div className="p-4 lg:p-8 max-w-5xl mx-auto flex flex-col gap-5">
          {!shipheroConnected && <Banner tone="amber">ShipHero isn&apos;t connected.</Banner>}
          {error && <Banner tone="rose">{error}</Banner>}

          {/* ---------- step 4: results ---------- */}
          {results && detail && (
            <div className="bg-white border border-emerald-200 rounded-2xl p-6">
              <div className="flex items-center gap-3 mb-4">
                <span className={`w-9 h-9 rounded-full flex items-center justify-center text-lg ${results.every((r) => r.ok) ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-700"}`}>{results.every((r) => r.ok) ? "✓" : "!"}</span>
                <div>
                  <h2 className="text-[15px] font-semibold text-slate-900">{results.every((r) => r.ok) ? "Done" : "Partly done"} — {detail.poNumber}, {results.filter((r) => r.ok).length}/{results.length} line{results.length === 1 ? "" : "s"} OK</h2>
                  <p className="text-xs text-slate-500">Each change was re-read from ShipHero after it ran.{results.some((r) => !r.ok) && <span className="text-rose-600 font-medium"> A line failed — its message is in the table; check ShipHero before retrying that size.</span>}</p>
                </div>
              </div>
              <table className="w-full text-[13px]">
                <thead><tr className="text-[11px] uppercase tracking-wider text-slate-400 text-left border-b border-slate-200"><th className="py-1.5 pr-3">Size</th><th className="py-1.5 pr-3">Received</th><th className="py-1.5">Stock</th></tr></thead>
                <tbody>
                  {results.map((r) => {
                    const line = detail.lines.find((l) => l.sku === r.sku);
                    return (
                      <tr key={r.sku} className={`border-b border-slate-100 last:border-0 ${r.ok ? "" : "text-rose-700"}`}>
                        <td className="py-2 pr-3"><b>{line ? sizeLabel(line) : ""}</b> <span className="font-mono text-[11px] text-slate-400">{r.sku}</span></td>
                        <td className="py-2 pr-3 tabular-nums">{r.receivedBefore != null ? <>{r.receivedBefore} → <b>{r.receivedAfter}</b></> : <span className="text-slate-300">unchanged</span>}</td>
                        <td className="py-2 tabular-nums">{r.stock.length ? r.stock.map((s, i) => <span key={i} className="mr-3">{s.locationName} {s.before} → <b>{s.after}</b>{s.ok ? "" : " ✗"}</span>) : <span className="text-slate-300">unchanged</span>}{r.error && <span className="ml-2">{r.error}</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <div className="mt-4 flex gap-2">
                <button onClick={() => setResults(null)} className="text-xs px-3.5 py-1.5 rounded-md border border-slate-200 text-slate-600 hover:bg-slate-50">Make another change on this PO</button>
                <button onClick={reset} className="text-xs px-3.5 py-1.5 rounded-md bg-indigo-600 text-white font-medium">Start another PO</button>
              </div>
            </div>
          )}

          {/* ---------- step 1: find ---------- */}
          {!detail && !loadingDetail && (
            <div className="bg-white border border-slate-200 rounded-2xl p-8 md:p-10">
              <h2 className="text-xl font-semibold text-slate-900 mb-1">Which PO needs correcting?</h2>
              <p className="text-sm text-slate-500 mb-6">Enter the PO number. If more than one PO shares it (it happens), you&apos;ll pick the right one next.</p>
              <form onSubmit={(e) => { e.preventDefault(); search(); }} className="flex items-center gap-3 max-w-lg">
                <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="e.g. PO510"
                  className="flex-1 text-lg font-mono border border-slate-300 rounded-lg px-4 py-3 focus:ring-2 focus:ring-indigo-300 focus:border-indigo-400 outline-none" />
                <button disabled={searching || !shipheroConnected || !query.trim()} className="text-sm font-medium bg-indigo-600 text-white rounded-lg px-5 py-3 hover:bg-indigo-700 disabled:opacity-40">
                  {searching ? "Searching…" : "Find PO"}
                </button>
              </form>

              {matches && matches.length === 0 && <p className="mt-6 text-sm text-rose-600">No PO called <b>{query}</b> in ShipHero — check the number.</p>}
              {matches && matches.length > 1 && (
                <div className="mt-8">
                  <p className="text-[11px] uppercase tracking-wider text-slate-400 mb-2">{matches.length} POs called {matches[0].poNumber} — pick the right one</p>
                  <div className="flex flex-col gap-2">
                    {matches.map((m) => (
                      <button key={m.id} onClick={() => pick(m)} className="text-left grid grid-cols-[110px_1fr_140px_140px_140px] gap-4 items-center px-4 py-3 rounded-xl border border-slate-200 hover:border-indigo-300 hover:bg-indigo-50/40 text-sm">
                        <span className="font-mono text-xs text-slate-500">row {m.legacyId}</span>
                        <span className="text-slate-800 truncate">{m.vendor || "—"}</span>
                        <span><span className="px-2 py-0.5 rounded-full text-xs bg-slate-100 text-slate-600">{m.status || "—"}</span></span>
                        <span className="text-xs text-slate-500">expected {day(m.poDate)}<br />created {day(m.createdAt)}</span>
                        <span className="text-xs tabular-nums text-slate-600 text-right"><b>{m.received}</b>/{m.ordered} received<br />{m.lineCount} lines</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
          {loadingDetail && <div className="bg-white border border-slate-200 rounded-2xl p-8 text-sm text-slate-400">Loading PO lines…</div>}

          {/* ---------- step 2: adjust ---------- */}
          {detail && !results && (
            <>
              <div className="bg-white border border-slate-200 rounded-2xl p-5 flex items-center gap-5 flex-wrap">
                <div>
                  <h2 className="text-xl font-semibold text-slate-900 font-mono">{detail.poNumber}</h2>
                  <p className="text-xs text-slate-500">row {detail.legacyId} · {detail.vendor}</p>
                </div>
                <span className="px-2.5 py-1 rounded-full text-xs bg-slate-100 text-slate-600">{detail.status}</span>
                <span className="text-xs text-slate-500">expected {day(detail.poDate)}</span>
                <div className="flex-1" />
                <div className="text-right">
                  <p className="text-lg font-semibold tabular-nums text-slate-900">{detail.lines.reduce((a, l) => a + l.received, 0)} <span className="text-slate-400 font-normal">/ {detail.lines.reduce((a, l) => a + l.ordered, 0)}</span></p>
                  <p className="text-[10px] uppercase tracking-wider text-slate-400">received / ordered</p>
                </div>
              </div>

              <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
                <div className="px-5 py-3 border-b border-slate-200 bg-slate-50/60">
                  <p className="text-sm text-slate-700">For each size, enter how many to <b>take off received</b>. Stock comes out of <b>Receiving</b> by default — if it&apos;s moved on, pick the bin(s) shown under the line. Leave stock at 0 if you&apos;ve already corrected it.</p>
                </div>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-[11px] uppercase tracking-wider text-slate-400 border-b border-slate-200">
                      <th className="text-left font-medium px-5 py-2.5">Size</th>
                      <th className="text-right font-medium px-3 py-2.5">Ordered</th>
                      <th className="text-right font-medium px-3 py-2.5">Received</th>
                      <th className="text-right font-medium px-3 py-2.5">Over</th>
                      <th className="text-right font-medium px-3 py-2.5 w-44">Take off received</th>
                      <th className="text-left font-medium px-5 py-2.5">Stock out of</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.lines.map((l) => {
                      const r = removals[l.sku];
                      const over = l.received - l.ordered;
                      const chosen = stockTotal(l.sku);
                      const b = bins[l.sku];
                      const on = (r?.unreceive ?? 0) > 0;
                      return (
                        <tr key={l.sku} className={`border-b border-slate-100 align-top ${on ? "bg-indigo-50/40" : ""}`}>
                          <td className="px-5 py-3">
                            <span className="text-base font-semibold text-slate-900">{sizeLabel(l)}</span>
                            <span className="block text-[11px] text-slate-500 truncate max-w-[240px]" title={productOf(l.productName)}>{productOf(l.productName)}</span>
                            <span className="block font-mono text-[10.5px] text-slate-400">{l.sku}</span>
                          </td>
                          <td className="px-3 py-3 text-right tabular-nums text-slate-600">{l.ordered}</td>
                          <td className="px-3 py-3 text-right tabular-nums font-medium text-slate-900">{l.received}</td>
                          <td className={`px-3 py-3 text-right tabular-nums font-semibold ${over > 0 ? "text-rose-600" : over < 0 ? "text-amber-600" : "text-slate-300"}`}>{over > 0 ? `+${over}` : over || "—"}</td>
                          <td className="px-3 py-3">
                            <div className="flex items-center justify-end gap-1">
                              <button onClick={() => setUnreceive(l, (r?.unreceive ?? 0) - 1)} className="w-8 h-8 rounded-md border border-slate-200 text-slate-500 hover:bg-slate-100">−</button>
                              <input type="number" min={0} max={l.received} value={r?.unreceive || ""} placeholder="0" onChange={(e) => setUnreceive(l, Number(e.target.value))}
                                className="w-16 h-8 text-center border border-slate-200 rounded-md tabular-nums text-base" />
                              <button onClick={() => setUnreceive(l, (r?.unreceive ?? 0) + 1)} className="w-8 h-8 rounded-md border border-slate-200 text-slate-500 hover:bg-slate-100">+</button>
                            </div>
                            {over > 0 && !on && <button onClick={() => setUnreceive(l, over)} className="block ml-auto mt-1 text-[11px] text-indigo-600 hover:underline">fix the +{over}</button>}
                          </td>
                          <td className="px-5 py-3">
                            {on ? (
                              b === "loading" || b === undefined ? <span className="text-xs text-slate-400">Finding stock…</span> :
                              b.length === 0 ? <span className="text-xs text-amber-600">No stock in any bin — counter only</span> : (
                                <div className="flex flex-col gap-1.5">
                                  {!b.some((x) => x.locationName === "Receiving") && <span className="text-[11px] text-amber-600">Nothing in Receiving for this size — pick the bin the extra unit is actually in, or leave stock at 0 (counter only).</span>}
                                  {b.map((bin) => (
                                    <label key={bin.locationId} className="flex items-center gap-2 text-xs">
                                      <input type="number" min={0} max={bin.qty} value={r?.stock[bin.locationId] || ""} placeholder="0" onChange={(e) => setStock(l, bin, Number(e.target.value))}
                                        className="w-16 h-7 text-center border border-slate-200 rounded-md tabular-nums" />
                                      <span className={`${bin.locationName === "Receiving" ? "font-semibold text-slate-800" : "text-slate-700"}`}>{bin.locationName}</span>
                                      <span className="text-slate-400">has {bin.qty}</span>
                                    </label>
                                  ))}
                                  <span className={`text-[11px] ${chosen === r!.unreceive ? "text-emerald-600" : chosen === 0 ? "text-amber-600" : "text-rose-600"}`}>
                                    {chosen === r!.unreceive ? `✓ ${chosen} out of stock` : chosen === 0 ? "counter only — no stock removed" : `${chosen} chosen vs ${r!.unreceive} off received`}
                                  </span>
                                </div>
                              )
                            ) : (
                              <span className="text-xs text-slate-300">{Array.isArray(b) ? (b.map((x) => `${x.locationName} ${x.qty}`).join(" · ") || "no stock") : ""}</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* sticky action bar */}
              <div className="sticky bottom-4 bg-white border border-slate-200 rounded-2xl shadow-lg px-5 py-3 flex items-center gap-4">
                <div className="text-sm text-slate-600">
                  {active.length ? <><b>{active.length}</b> line{active.length === 1 ? "" : "s"} · <b>{totalUnreceive}</b> off received · <b>{totalStock}</b> out of stock</> : "No changes yet — enter a quantity on a line above."}
                </div>
                <div className="flex-1" />
                <button disabled={!active.length} onClick={() => setReview(true)} className="text-sm font-medium bg-indigo-600 text-white rounded-lg px-5 py-2.5 disabled:opacity-40">
                  Review changes
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {/* ---------- step 3: review ---------- */}
      {review && detail && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4" onClick={() => setReview(false)}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="px-6 py-4 border-b border-slate-200">
              <h3 className="text-base font-semibold text-slate-900">Confirm un-receive on {detail.poNumber} <span className="font-mono text-slate-400 text-sm">row {detail.legacyId}</span></h3>
              <p className="text-xs text-slate-500 mt-1">This writes to ShipHero. Received counters go down by the amounts shown; stock is subtracted from the bins listed. Every step is re-read and verified after it runs.</p>
            </div>
            <div className="px-6 py-4 overflow-y-auto">
              <table className="w-full text-sm">
                <thead><tr className="text-[10px] uppercase tracking-wide text-slate-400 text-left border-b border-slate-200"><th className="py-1.5 pr-3">Size</th><th className="py-1.5 pr-3 text-right">Received</th><th className="py-1.5 pr-3">Stock removed</th></tr></thead>
                <tbody>
                  {active.map((l) => {
                    const r = removals[l.sku];
                    return (
                      <tr key={l.sku} className="border-b border-slate-100">
                        <td className="py-2 pr-3"><b>{sizeLabel(l)}</b> <span className="font-mono text-[11px] text-slate-400">{l.sku}</span></td>
                        <td className="py-2 pr-3 text-right tabular-nums">{l.received} → <b>{l.received - (r?.unreceive ?? 0)}</b></td>
                        <td className="py-2 pr-3">{Object.entries(r?.stock ?? {}).filter(([, q]) => q > 0).map(([id, q]) => `${binName(l.sku, id)} −${q}`).join(", ") || <span className="text-amber-600">none (counter only)</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="px-6 py-4 border-t border-slate-200 flex items-center gap-2">
              {error && <p className="text-xs text-rose-600 flex-1">{error}</p>}
              <div className="flex-1" />
              <button onClick={() => setReview(false)} className="text-sm px-4 py-2 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50">Back</button>
              <button onClick={apply} disabled={applying} className="text-sm px-5 py-2 rounded-lg bg-rose-600 text-white font-medium disabled:opacity-40">{applying ? "Applying…" : "Confirm & apply"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Steps({ step }: { step: number }) {
  const items = ["Find PO", "Adjust", "Review", "Done"];
  return (
    <ol className="hidden md:flex items-center gap-2 text-[11px]">
      {items.map((label, i) => {
        const n = i + 1;
        const state = n < step ? "done" : n === step ? "now" : "todo";
        return (
          <li key={label} className="flex items-center gap-2">
            <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-semibold ${state === "now" ? "bg-indigo-600 text-white" : state === "done" ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-400"}`}>{state === "done" ? "✓" : n}</span>
            <span className={state === "now" ? "text-slate-800 font-medium" : "text-slate-400"}>{label}</span>
            {i < items.length - 1 && <span className="w-4 h-px bg-slate-200" />}
          </li>
        );
      })}
    </ol>
  );
}

function Banner({ tone, children }: { tone: "amber" | "rose"; children: React.ReactNode }) {
  const cls = tone === "amber" ? "border-amber-200 bg-amber-50 text-amber-700" : "border-rose-200 bg-rose-50 text-rose-700";
  return <div className={`rounded-lg border text-sm px-4 py-3 ${cls}`}>{children}</div>;
}
