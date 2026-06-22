"use client";

// Read-only PO breakdown modal. Same shape as PO History's detail modal but with
// NO editing — used on the Dashboard to inspect an open PO's receiving breakdown.
// Self-contained: fetches its own line detail from /api/po/detail and caches.

import { useEffect, useState } from "react";
import type { PoSummary, PoDetail } from "@/lib/shiphero/po-pull";
import { deriveSizeFromSku, type SizeMap } from "@/lib/sizes";

function fmtPrice(p: string): string {
  if (!p) return "—";
  const n = Number(p);
  return Number.isNaN(n) ? p : n.toFixed(2);
}
function statusClass(s: string): string {
  const k = s.toLowerCase();
  if (k.includes("cancel")) return "bg-rose-100 text-rose-700";
  if (k.includes("close") || k.includes("receiv")) return "bg-emerald-100 text-emerald-700";
  if (k.includes("transit") || k.includes("partial")) return "bg-indigo-100 text-indigo-700";
  if (k.includes("pending")) return "bg-amber-100 text-amber-700";
  return "bg-slate-100 text-slate-600";
}

export function PoBreakdownModal({
  po,
  sizeMap,
  onClose,
}: {
  po: PoSummary;
  sizeMap: SizeMap;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<PoDetail | "loading" | { error: string }>("loading");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    let alive = true;
    setDetail("loading");
    (async () => {
      try {
        const res = await fetch(`/api/po/detail?po=${encodeURIComponent(po.poNumber)}`);
        const data = await res.json();
        if (!alive) return;
        setDetail(res.ok ? (data.detail as PoDetail) : { error: data.error ?? "Failed to load." });
      } catch {
        if (alive) setDetail({ error: "Failed to load line items." });
      }
    })();
    return () => {
      alive = false;
    };
  }, [po.poNumber]);

  const loaded = detail && detail !== "loading" && !("error" in detail) ? (detail as PoDetail) : null;
  const pct = po.unitsOrdered ? Math.round((po.unitsReceived / po.unitsOrdered) * 100) : 0;

  // Order lines small→large by size (sizeMap.order); unknown/bracket sizes sink to the end.
  const rank = (sku: string) => {
    const i = sizeMap.order.indexOf(deriveSizeFromSku(sku, sizeMap));
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  const orderedLines = loaded ? [...loaded.lines].sort((a, b) => rank(a.sku) - rank(b.sku)) : [];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-3xl max-h-[88vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        {/* header */}
        <div className="px-5 py-4 border-b border-slate-200 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2.5">
              <span className="font-mono text-sm font-bold text-slate-900">{po.poNumber}</span>
              <span className={`px-1.5 py-0.5 rounded text-xs ${statusClass(po.status)}`}>{po.status || "—"}</span>
            </div>
            <p className="text-[13px] text-slate-700 mt-1 truncate">{po.products.length ? po.products.join(", ") : "—"}</p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700 text-xl leading-none shrink-0">×</button>
        </div>

        {/* meta */}
        <div className="px-5 py-3 border-b border-slate-100 grid grid-cols-2 md:grid-cols-4 gap-4 text-xs items-end">
          <div>
            <p className="text-[10px] uppercase tracking-wide text-slate-400 mb-1">Status</p>
            <span className={`inline-block px-1.5 py-0.5 rounded text-xs ${statusClass(po.status)}`}>{po.status || "—"}</span>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wide text-slate-400 mb-1">Expected date</p>
            <p className="text-slate-700 font-medium pt-1 font-mono">{po.poDate?.slice(0, 10) ?? "—"}</p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wide text-slate-400 mb-1">Vendor</p>
            <p className="text-slate-700 font-medium truncate pt-1">{po.vendorName ?? "—"}</p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wide text-slate-400 mb-1">Total</p>
            <p className="text-slate-700 font-medium pt-1">{po.totalPrice ? `£${po.totalPrice}` : "—"}</p>
          </div>
        </div>

        {/* body */}
        <div className="flex-1 overflow-auto p-5 thin-scroll">
          <div className="flex items-center gap-3 mb-3">
            <span className="text-xs font-semibold text-slate-700">
              {po.unitsReceived.toLocaleString()} / {po.unitsOrdered.toLocaleString()} units received
            </span>
            <div className="flex-1 h-2 bg-slate-200 rounded-full overflow-hidden">
              <div className={`h-full ${pct >= 100 ? "bg-emerald-500" : pct > 0 ? "bg-indigo-500" : "bg-slate-300"}`} style={{ width: `${Math.min(pct, 100)}%` }} />
            </div>
            <span className="text-xs font-medium text-slate-500 tabular-nums w-9 text-right">{pct}%</span>
          </div>

          {detail === "loading" ? (
            <p className="text-xs text-slate-400">Loading line items…</p>
          ) : "error" in detail ? (
            <p className="text-xs text-rose-600">{detail.error}</p>
          ) : (
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-wide text-slate-400 border-b border-slate-200">
                  <th className="font-medium py-1 pr-3">Size</th>
                  <th className="font-medium py-1 pr-3">SKU</th>
                  <th className="font-medium py-1 px-2 text-right">Qty</th>
                  <th className="font-medium py-1 px-2 text-right">Price</th>
                  <th className="font-medium py-1 px-2 text-right">Recv</th>
                  <th className="font-medium py-1 pl-3 w-full">Receiving</th>
                </tr>
              </thead>
              <tbody>
                {orderedLines.map((l, i) => {
                  const linePct = l.quantity ? Math.round((l.quantityReceived / l.quantity) * 100) : 0;
                  const done = linePct >= 100;
                  return (
                    <tr key={l.sku + i} className="border-b border-slate-100 last:border-0">
                      <td className="py-1 pr-3 font-mono font-semibold text-slate-700 whitespace-nowrap">{deriveSizeFromSku(l.sku, sizeMap) || "—"}</td>
                      <td className="py-1 pr-3 font-mono text-slate-400 whitespace-nowrap">{l.sku}</td>
                      <td className="py-1 px-2 text-right font-mono tabular-nums">{l.quantity}</td>
                      <td className="py-1 px-2 text-right font-mono tabular-nums">{fmtPrice(l.price)}</td>
                      <td className="py-1 px-2 text-right font-mono tabular-nums text-emerald-700">{l.quantityReceived}</td>
                      <td className="py-1 pl-3 w-full">
                        <div className="flex items-center gap-2">
                          <div className="flex-1 h-1.5 bg-slate-200 rounded-full overflow-hidden min-w-[3rem]">
                            <div className={`h-full ${done ? "bg-emerald-500" : linePct > 0 ? "bg-indigo-500" : "bg-slate-200"}`} style={{ width: `${Math.min(linePct, 100)}%` }} />
                          </div>
                          <span className={`text-[10px] w-8 text-right ${done ? "text-emerald-600 font-medium" : "text-slate-400 tabular-nums"}`}>{done ? "done" : `${linePct}%`}</span>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* footer */}
        <div className="px-5 py-3 border-t border-slate-200 flex items-center justify-end">
          <button onClick={onClose} className="text-xs px-3 py-1.5 rounded-md border border-slate-200 text-slate-600 hover:bg-slate-50">Close</button>
        </div>
      </div>
    </div>
  );
}
