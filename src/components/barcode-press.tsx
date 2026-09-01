"use client";

// Barcode Label Press — standalone page at /barcodes with its own password.
// Pulls products from the published Google Sheet (via /api/barcodes/sheet),
// staff pick sizes + quantities and print to the Zebra via Browser Print
// (ZPL, http://localhost:9100 first), falling back to a normal print window.
// No history/analytics — this is a printing tool, nothing more.
//
// Styling deliberately matches the old Vercel app the team liked: monochrome,
// hairline-divided grid, big search, underline tabs, and the card hierarchy
// TITLE (bold caps) → SKU (mono) → barcode (mono, lighter) → COLOUR · SIZE · PO.

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
    const labelCount = totalLabels;
    setSelections(new Map());
    const zpl = await tryZPLPrint(toPrint);
    setPrinting(false);
    if (zpl.ok) {
      setToast({ ok: true, text: `Sent ${labelCount} label${labelCount === 1 ? "" : "s"} to the Zebra.` });
    } else {
      openPrintWindow(toPrint);
      setToast({ ok: false, text: `Zebra not reachable (${zpl.error}) — opened a normal print window instead. Is Browser Print running on this PC?` });
    }
    setTimeout(() => setToast(null), 8000);
  }

  // ---------- password gate ----------
  if (sheet.status === "auth") {
    return (
      <div className="min-h-screen w-full bg-white flex items-center justify-center p-4">
        <form onSubmit={login} className="w-full max-w-sm">
          <p className="font-brand text-lg text-slate-900 tracking-tight">WANDERDOLL</p>
          <h1 className="text-2xl font-semibold text-slate-900 mt-1">Label Press</h1>
          <p className="text-sm text-slate-500 mt-1 mb-6">Enter the barcode room password.</p>
          <input type="password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password"
            className="w-full border border-slate-300 rounded-lg px-4 py-3 text-base focus:ring-2 focus:ring-slate-300 focus:border-slate-500 outline-none" />
          {loginError && <p className="text-xs text-rose-600 mt-2">{loginError}</p>}
          <button disabled={loggingIn || !password} className="mt-4 w-full bg-slate-900 text-white rounded-lg py-3 text-sm font-medium hover:bg-slate-800 disabled:opacity-40">
            {loggingIn ? "Checking…" : "Enter"}
          </button>
        </form>
      </div>
    );
  }

  // ---------- main ----------
  return (
    <div className="min-h-screen w-full bg-white flex flex-col">
      {/* search row */}
      <div className="px-6 pt-5 pb-1 flex items-center gap-4">
        <span className="font-brand text-[15px] text-slate-900 tracking-tight shrink-0">WANDERDOLL <span className="text-slate-300">/</span> <span className="font-sans font-semibold">Label Press</span></span>
        <input ref={searchRef} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by SKU, product name or barcode…"
          className="flex-1 border border-slate-300 rounded-xl px-4 py-3 text-[15px] focus:ring-2 focus:ring-slate-200 focus:border-slate-500 outline-none" />
        <span className="text-sm text-slate-400 shrink-0">{filtered.length} of {items.length} products</span>
        <button onClick={loadSheet} disabled={sheet.status === "loading"} className="text-sm px-3.5 py-2 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50 disabled:opacity-50 shrink-0" title="Re-fetch the Google Sheet">
          {sheet.status === "loading" ? "Refreshing…" : "Refresh sheet"}
        </button>
      </div>

      {/* tabs + print */}
      <div className="px-6 border-b border-slate-200 flex items-end gap-6 mt-2">
        {(["all", "selected"] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)}
            className={`pb-2.5 text-[15px] -mb-px border-b-2 ${tab === t ? "border-slate-900 text-slate-900 font-semibold" : "border-transparent text-slate-500 hover:text-slate-800"}`}>
            {t === "all" ? `All (${items.length})` : `Selected (${selections.size})`}
          </button>
        ))}
        <div className="flex-1" />
      </div>

      {/* black print-queue bar (matches the old app) */}
      {selections.size > 0 && (
        <div className="bg-slate-900 text-white px-6 py-2.5 flex items-center gap-4">
          <span className="text-[11px] uppercase tracking-[0.2em] text-slate-400 shrink-0">Print queue</span>
          <div className="flex-1 flex items-center gap-2 overflow-x-auto thin-scroll py-0.5">
            {queueItems.map(({ product, qty }) => (
              <span key={product.sku} className="flex items-center gap-2 bg-slate-800 rounded-md pl-2.5 pr-1.5 py-1 text-[13px] whitespace-nowrap">
                <span className="uppercase max-w-[200px] truncate" title={product.title}>{product.title || product.sku}</span>
                <span className="bg-slate-600 rounded px-1.5 text-[11px] font-mono">×{qty}</span>
                <button onClick={() => toggle(product.sku)} aria-label="Remove" className="text-slate-400 hover:text-white px-0.5">✕</button>
              </span>
            ))}
          </div>
          <button onClick={() => setConfirming(true)} disabled={printing}
            className="shrink-0 bg-white text-slate-900 rounded-lg px-5 py-2 text-[13px] font-semibold uppercase tracking-wide hover:bg-slate-100 disabled:opacity-50">
            {printing ? "Printing…" : `Print all (${totalLabels} label${totalLabels === 1 ? "" : "s"})`}
          </button>
        </div>
      )}

      {sheet.status === "error" && (
        <div className="mx-6 mt-4 text-sm bg-rose-50 border border-rose-200 text-rose-700 rounded-lg px-4 py-2.5">
          Couldn&apos;t load the product sheet: {sheet.error}
        </div>
      )}
      {toast && (
        <div className={`mx-6 mt-4 text-sm rounded-lg px-4 py-2.5 border ${toast.ok ? "bg-emerald-50 border-emerald-200 text-emerald-800" : "bg-amber-50 border-amber-200 text-amber-800"}`}>
          {toast.text}
        </div>
      )}

      {/* hairline-divided product grid */}
      <div className="flex-1">
        {sheet.status === "loading" && items.length === 0 ? (
          <p className="text-sm text-slate-400 text-center py-20">Loading the product sheet…</p>
        ) : filtered.length === 0 ? (
          <p className="text-sm text-slate-400 text-center py-20">{tab === "selected" ? "Nothing selected yet." : "No products match that search."}</p>
        ) : (
          <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))" }}>
            {filtered.map((p) => {
              const selected = selectedSkus.has(p.sku);
              const qty = selections.get(p.sku) ?? 1;
              return (
                <div key={p.sku} onClick={() => toggle(p.sku)}
                  className={`relative px-6 py-5 border-b border-r border-slate-200/70 cursor-pointer ${selected ? "bg-slate-50" : "hover:bg-slate-50/50"}`}>
                  {selected && (
                    <span className="absolute top-3 right-3 w-5 h-5 rounded-full bg-slate-900 text-white flex items-center justify-center text-[11px]">✓</span>
                  )}
                  <p className="text-[15px] font-semibold text-slate-900 uppercase leading-snug pr-6" title={p.title}>{p.title || "—"}</p>
                  <p className="font-mono text-[13px] text-slate-500 mt-2">{p.sku || "—"}</p>
                  <p className="font-mono text-[13px] text-slate-400">{p.barcode || <span className="text-rose-500 font-sans">No barcode — won&apos;t scan</span>}</p>
                  <p className="text-[14px] text-slate-800 mt-2 uppercase">
                    {p.colour && <span className="font-medium">{p.colour}</span>}
                    {p.size && <span> · <span className="font-semibold">{p.size}</span></span>}
                    {p.po && <span className="text-slate-500"> · {p.po}</span>}
                  </p>
                  {selected && (
                    <div className="mt-3 flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                      <span className="text-[11px] uppercase tracking-widest text-slate-500 mr-1">Qty</span>
                      <button onClick={() => setQty(p.sku, qty - 1)} className="w-8 h-8 rounded-md border border-slate-300 text-slate-700 hover:bg-white">−</button>
                      <input type="number" min={1} value={qty} onChange={(e) => setQty(p.sku, Number(e.target.value))} onClick={(e) => (e.target as HTMLInputElement).select()}
                        className="w-16 h-8 text-center border border-slate-300 rounded-md text-sm tabular-nums bg-white" />
                      <button onClick={() => setQty(p.sku, qty + 1)} className="w-8 h-8 rounded-md border border-slate-300 text-slate-700 hover:bg-white">+</button>
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
                  <span className="flex-1 min-w-0 truncate text-slate-800 uppercase" title={product.title}>{product.title || product.sku}</span>
                  <span className="font-mono text-xs text-slate-500">{product.sku}</span>
                  <span className="font-mono text-xs font-semibold text-slate-900">×{qty}</span>
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
              <button onClick={() => setConfirming(false)} className="text-sm px-4 py-2 rounded-lg border border-slate-300 text-slate-600 hover:bg-slate-50">Cancel</button>
              <button onClick={confirmPrint} className="text-sm px-5 py-2 rounded-lg bg-slate-900 text-white font-medium hover:bg-slate-800">Print all ({totalLabels})</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
