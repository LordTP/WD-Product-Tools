"use client";

// Barcode Label Press — standalone page at /barcodes with its own password.
// Pulls products from the published Google Sheet (via /api/barcodes/sheet),
// staff pick sizes + quantities and print to the Zebra via Browser Print
// (ZPL, http://localhost:9100 first), falling back to a normal print window.
// Deliberately no history/analytics — this is a printing tool, nothing more.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { barcodeSVG, formatBarcodeNumber, openPrintWindow, parseSheetCsv, tryZPLPrint, type LabelProduct, type QueueItem } from "@/lib/barcode-labels";

type SheetState = { status: "loading" | "ok" | "error" | "auth"; products: LabelProduct[]; error?: string };

export function BarcodePress() {
  const [sheet, setSheet] = useState<SheetState>({ status: "loading", products: [] });
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loggingIn, setLoggingIn] = useState(false);
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<"all" | "selected">("all");
  const [selections, setSelections] = useState<Map<string, number>>(new Map());
  const [confirming, setConfirming] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [toast, setToast] = useState<{ ok: boolean; text: string } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const loadSheet = useCallback(async () => {
    setSheet((s) => ({ ...s, status: "loading" }));
    try {
      const res = await fetch("/api/barcodes/sheet", { cache: "no-store" });
      if (res.status === 401) { setSheet({ status: "auth", products: [] }); return; }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setSheet({ status: "error", products: [], error: body.error || `Server ${res.status}` });
        return;
      }
      const parsed = parseSheetCsv(await res.text());
      if (parsed.ok) setSheet({ status: "ok", products: parsed.products });
      else setSheet({ status: "error", products: [], error: parsed.error });
    } catch {
      setSheet({ status: "error", products: [], error: "Could not reach the sheet service." });
    }
  }, []);
  useEffect(() => { void (async () => { await loadSheet(); })(); }, [loadSheet]);

  async function login(e: React.FormEvent) {
    e.preventDefault();
    setLoggingIn(true);
    setLoginError(null);
    try {
      const res = await fetch("/api/barcodes/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "Login failed.");
      setPassword("");
      await loadSheet();
    } catch (err) {
      setLoginError(err instanceof Error ? err.message : "Login failed.");
    } finally {
      setLoggingIn(false);
    }
  }

  const items = sheet.products;
  const selectedSkus = useMemo(() => new Set(selections.keys()), [selections]);
  const totalLabels = useMemo(() => [...selections.values()].reduce((a, b) => a + (b || 0), 0), [selections]);

  const filtered = useMemo(() => {
    const base = tab === "selected" ? items.filter((p) => selectedSkus.has(p.sku)) : items;
    const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!tokens.length) return base;
    return base.filter((p) => {
      const hay = [p.sku, p.title, p.barcode, p.colour, p.size, p.po].filter(Boolean).join(" ").toLowerCase();
      return tokens.every((t) => hay.includes(t));
    });
  }, [items, query, tab, selectedSkus]);

  const queueItems: QueueItem[] = useMemo(() => {
    const bySku = new Map(items.map((p) => [p.sku, p]));
    return [...selections.entries()].map(([sku, qty]) => ({ product: bySku.get(sku)!, qty })).filter((x) => x.product);
  }, [items, selections]);

  const toggle = (sku: string) => setSelections((prev) => { const next = new Map(prev); if (next.has(sku)) next.delete(sku); else next.set(sku, 1); return next; });
  const setQty = (sku: string, qty: number) => setSelections((prev) => { const next = new Map(prev); if (next.has(sku)) next.set(sku, Math.max(1, Math.floor(qty) || 1)); return next; });

  async function confirmPrint() {
    setConfirming(false);
    setPrinting(true);
    const toPrint = queueItems;
    setSelections(new Map());
    const zpl = await tryZPLPrint(toPrint);
    setPrinting(false);
    if (zpl.ok) {
      setToast({ ok: true, text: `Sent ${totalLabels} label${totalLabels === 1 ? "" : "s"} to the Zebra.` });
    } else {
      openPrintWindow(toPrint);
      setToast({ ok: false, text: `Zebra not reachable (${zpl.error}) — opened a normal print window instead. Is Browser Print running on this PC?` });
    }
    setTimeout(() => setToast(null), 8000);
  }

  // ---------- password gate ----------
  if (sheet.status === "auth") {
    return (
      <div className="min-h-screen w-full bg-slate-100 flex items-center justify-center p-4">
        <form onSubmit={login} className="bg-white border border-slate-200 rounded-2xl p-8 w-full max-w-sm shadow-sm">
          <p className="font-brand text-lg text-slate-800 tracking-tight">WANDERDOLL</p>
          <h1 className="text-xl font-semibold text-slate-900 mt-1">Label Press</h1>
          <p className="text-sm text-slate-500 mt-1 mb-5">Enter the barcode room password.</p>
          <input type="password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password"
            className="w-full border border-slate-300 rounded-lg px-3.5 py-2.5 text-sm focus:ring-2 focus:ring-indigo-200 focus:border-indigo-400 outline-none" />
          {loginError && <p className="text-xs text-rose-600 mt-2">{loginError}</p>}
          <button disabled={loggingIn || !password} className="mt-4 w-full bg-indigo-600 text-white rounded-lg py-2.5 text-sm font-medium hover:bg-indigo-700 disabled:opacity-40">
            {loggingIn ? "Checking…" : "Enter"}
          </button>
        </form>
      </div>
    );
  }

  // ---------- main ----------
  return (
    <div className="min-h-screen w-full bg-slate-100 flex flex-col">
      <header className="h-14 bg-white border-b border-slate-200 flex items-center gap-3 px-4 lg:px-6 sticky top-0 z-20">
        <span className="font-brand text-[15px] text-slate-800 tracking-tight">WANDERDOLL</span>
        <span className="text-sm font-semibold text-slate-900">Label Press</span>
        <div className="relative flex-1 max-w-xl ml-2">
          <input ref={searchRef} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search SKU, product name or barcode…"
            className="w-full border border-slate-300 rounded-lg px-3.5 py-2 text-sm focus:ring-2 focus:ring-indigo-200 focus:border-indigo-400 outline-none" />
        </div>
        <div className="flex-1" />
        <span className="hidden md:inline text-xs text-slate-400">{filtered.length} of {items.length} products</span>
        <button onClick={loadSheet} disabled={sheet.status === "loading"} className="text-xs px-3 py-1.5 rounded-md border border-slate-300 text-slate-700 hover:bg-slate-50 disabled:opacity-50" title="Re-fetch the Google Sheet">
          {sheet.status === "loading" ? "Refreshing…" : "Refresh sheet"}
        </button>
      </header>

      {sheet.status === "error" && (
        <div className="mx-4 lg:mx-6 mt-3 text-sm bg-rose-50 border border-rose-200 text-rose-700 rounded-lg px-4 py-2.5">
          Couldn&apos;t load the product sheet: {sheet.error}
        </div>
      )}
      {toast && (
        <div className={`mx-4 lg:mx-6 mt-3 text-sm rounded-lg px-4 py-2.5 border ${toast.ok ? "bg-emerald-50 border-emerald-200 text-emerald-800" : "bg-amber-50 border-amber-200 text-amber-800"}`}>
          {toast.text}
        </div>
      )}

      <div className="px-4 lg:px-6 pt-3 flex items-center gap-2">
        {(["all", "selected"] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={`px-3 py-1.5 rounded-full text-xs border ${tab === t ? "bg-indigo-50 border-indigo-400 text-indigo-800 font-medium" : "bg-white border-slate-300 text-slate-600"}`}>
            {t === "all" ? `All (${items.length})` : `Selected (${selections.size})`}
          </button>
        ))}
        <div className="flex-1" />
        {selections.size > 0 && (
          <button onClick={() => setConfirming(true)} disabled={printing} className="text-sm px-4 py-2 rounded-lg bg-indigo-600 text-white font-medium hover:bg-indigo-700 disabled:opacity-50">
            {printing ? "Printing…" : `Print all (${totalLabels} label${totalLabels === 1 ? "" : "s"})`}
          </button>
        )}
      </div>

      <div className="flex-1 p-4 lg:p-6">
        {sheet.status === "loading" && items.length === 0 ? (
          <p className="text-sm text-slate-400 text-center py-16">Loading the product sheet…</p>
        ) : filtered.length === 0 ? (
          <p className="text-sm text-slate-400 text-center py-16">{tab === "selected" ? "Nothing selected yet." : "No products match that search."}</p>
        ) : (
          <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))" }}>
            {filtered.map((p) => {
              const selected = selectedSkus.has(p.sku);
              const qty = selections.get(p.sku) ?? 1;
              return (
                <div key={p.sku} onClick={() => toggle(p.sku)}
                  className={`bg-white rounded-xl border p-3.5 cursor-pointer transition-colors ${selected ? "border-indigo-500 ring-2 ring-indigo-100" : "border-slate-200 hover:border-slate-300"}`}>
                  <p className="text-[13px] font-medium text-slate-900 leading-snug line-clamp-2" title={p.title}>{p.title || "—"}</p>
                  <p className="font-mono text-[11px] text-slate-500 mt-1">{p.sku || "—"}</p>
                  <p className="font-mono text-[11px] text-slate-400">{p.barcode || <span className="text-rose-500 font-sans">No barcode — won&apos;t scan</span>}</p>
                  <p className="text-[11px] text-slate-500 mt-1">{[p.colour, p.size, p.po].filter(Boolean).join(" · ")}</p>
                  {selected && (
                    <div className="mt-2.5 flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                      <span className="text-[11px] text-slate-500 mr-1">Qty</span>
                      <button onClick={() => setQty(p.sku, qty - 1)} className="w-7 h-7 rounded-md border border-slate-200 text-slate-600 hover:bg-slate-50">−</button>
                      <input type="number" min={1} value={qty} onChange={(e) => setQty(p.sku, Number(e.target.value))} onClick={(e) => (e.target as HTMLInputElement).select()}
                        className="w-14 h-7 text-center border border-slate-200 rounded-md text-sm tabular-nums" />
                      <button onClick={() => setQty(p.sku, qty + 1)} className="w-7 h-7 rounded-md border border-slate-200 text-slate-600 hover:bg-slate-50">+</button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* confirm modal */}
      {confirming && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4" onClick={() => setConfirming(false)}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="px-5 py-4 border-b border-slate-200">
              <h3 className="text-base font-semibold text-slate-900">Print {totalLabels} label{totalLabels === 1 ? "" : "s"}?</h3>
              <p className="text-xs text-slate-500 mt-0.5">{queueItems.length} product{queueItems.length === 1 ? "" : "s"} · a BREAK label separates each product on the roll.</p>
            </div>
            <div className="px-5 py-3 overflow-auto thin-scroll">
              {queueItems.map(({ product, qty }) => (
                <div key={product.sku} className="flex items-center gap-3 py-1.5 border-b border-slate-100 last:border-0 text-sm">
                  <span className="flex-1 min-w-0 truncate text-slate-800" title={product.title}>{product.title || product.sku}</span>
                  <span className="font-mono text-xs text-slate-500">{product.sku}</span>
                  <span className="font-mono text-xs font-semibold text-slate-800">×{qty}</span>
                </div>
              ))}
              {queueItems[0] && (
                <div className="mt-3 border border-slate-200 rounded-lg p-3 bg-slate-50">
                  <p className="text-[10px] uppercase tracking-wider text-slate-400 mb-1.5">Label preview — {queueItems[0].product.sku}</p>
                  <div className="bg-white border border-slate-200 rounded p-2 font-mono text-[10px] uppercase leading-tight text-slate-800">
                    <p>WANDERDOLL SKU: {queueItems[0].product.sku}</p>
                    <p>PO NUMBER: {queueItems[0].product.po}</p>
                    <p>PRODUCT TITLE: {queueItems[0].product.title}</p>
                    <p>COLOUR: {queueItems[0].product.colour} · SIZE: {queueItems[0].product.size}</p>
                    <div className="mt-1.5" dangerouslySetInnerHTML={{ __html: barcodeSVG(queueItems[0].product.barcode, { width: "80%", height: 34 }) }} />
                    <p className="tracking-widest text-[9px] mt-0.5">{formatBarcodeNumber(queueItems[0].product.barcode)}</p>
                  </div>
                </div>
              )}
            </div>
            <div className="px-5 py-4 border-t border-slate-200 flex justify-end gap-2">
              <button onClick={() => setConfirming(false)} className="text-sm px-4 py-2 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50">Cancel</button>
              <button onClick={confirmPrint} className="text-sm px-5 py-2 rounded-lg bg-indigo-600 text-white font-medium hover:bg-indigo-700">Print all ({totalLabels})</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
