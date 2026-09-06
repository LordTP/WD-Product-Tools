"use client";

// Apps → Inventory: the whole warehouse by SKU — totals + every bin holding it.
// Reads /api/inventory (cache-only); Sync pulls a fresh ShipHero snapshot
// through the shared queue. Renders inside the Apps hub frame.

import { useCallback, useEffect, useMemo, useState } from "react";
import { matchesQuery, type InventoryItem, type InventoryPayload } from "@/lib/inventory-types";

const RENDER_CAP = 300;

function timeAgo(iso: string | null): string {
  if (!iso) return "";
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

type ModalView = { kind: "sku"; sku: string } | { kind: "bin"; bin: string };

export function InventoryExplorer() {
  const [data, setData] = useState<InventoryPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [query, setQuery] = useState("");
  // Modal navigation is a stack so bin ⇄ SKU pivots can go back.
  const [stack, setStack] = useState<ModalView[]>([]);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/inventory");
      const json = (await res.json()) as InventoryPayload & { error?: string };
      if (!res.ok || json.error) throw new Error(json.error ?? "Failed to load inventory.");
      setData(json);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load inventory.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void (async () => { await load(); })();
  }, [load]);

  async function sync() {
    setSyncing(true);
    try {
      const res = await fetch("/api/inventory/sync", { method: "POST" });
      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !json.ok) throw new Error(json.error ?? "Sync failed.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sync failed.");
    } finally {
      setSyncing(false);
    }
  }

  const items = useMemo(() => data?.items ?? [], [data]);
  const bySku = useMemo(() => new Map(items.map((i) => [i.sku, i])), [items]);
  const filtered = useMemo(
    () => items.filter((i) => matchesQuery(i, query)),
    [items, query],
  );
  const shown = filtered.slice(0, RENDER_CAP);
  const totalUnits = useMemo(() => filtered.reduce((a, i) => a + i.onHand, 0), [filtered]);

  const view = stack[stack.length - 1] ?? null;

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* toolbar */}
      <div className="bg-white border-b border-slate-200 px-4 lg:px-6 py-3 flex flex-wrap items-center gap-2.5 shrink-0">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search SKU, product, bin or barcode…"
          className="flex-1 min-w-[200px] max-w-md bg-white border border-slate-300 rounded-lg px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
          autoFocus
        />
        <div className="ml-auto flex items-center gap-3">
          <span className="text-xs text-slate-400 whitespace-nowrap">
            {data?.syncedAt ? `synced ${timeAgo(data.syncedAt)}` : loading ? "" : "not synced yet"}
          </span>
          <button
            onClick={() => void sync()}
            disabled={syncing}
            className="px-3 py-2 rounded-lg bg-slate-900 text-white text-xs font-medium hover:bg-slate-700 disabled:opacity-50 transition-colors"
          >
            {syncing ? "Syncing…" : "Sync"}
          </button>
        </div>
      </div>

      {/* body */}
      <div className="flex-1 min-h-0 overflow-y-auto p-4 lg:p-6">
        {error && (
          <div className="mb-4 bg-rose-50 border border-rose-200 text-rose-700 text-sm rounded-lg px-4 py-3">{error}</div>
        )}
        {loading ? (
          <p className="text-sm text-slate-400">Loading inventory…</p>
        ) : items.length === 0 ? (
          <div className="text-center py-16">
            <p className="text-[15px] font-semibold text-slate-700">No inventory synced yet</p>
            <p className="text-sm text-slate-500 mt-1">Press Sync to pull the first warehouse snapshot from ShipHero.</p>
          </div>
        ) : (
          <>
            <p className="text-xs text-slate-400 mb-3">
              {filtered.length.toLocaleString()} SKU{filtered.length === 1 ? "" : "s"} · {totalUnits.toLocaleString()} units on hand
              {filtered.length > RENDER_CAP && ` · showing first ${RENDER_CAP} — refine the search`}
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-3">
              {shown.map((item) => (
                <SkuCard key={item.sku} item={item} onOpen={() => setStack([{ kind: "sku", sku: item.sku }])} />
              ))}
            </div>
          </>
        )}
      </div>

      {/* detail modal */}
      {view && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4" onClick={() => setStack([])}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2 px-5 py-4 border-b border-slate-100">
              {stack.length > 1 && (
                <button
                  onClick={() => setStack((s) => s.slice(0, -1))}
                  className="text-slate-400 hover:text-slate-700 -ml-1 p-1 rounded transition-colors"
                  aria-label="Back"
                >
                  <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6" /></svg>
                </button>
              )}
              <h2 className="text-[15px] font-semibold text-slate-900 truncate">
                {view.kind === "sku" ? (bySku.get(view.sku)?.title ?? view.sku) : view.bin}
              </h2>
              <button
                onClick={() => setStack([])}
                className="ml-auto text-slate-400 hover:text-slate-700 p-1 rounded transition-colors"
                aria-label="Close"
              >
                <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12" /></svg>
              </button>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto p-5">
              {view.kind === "sku" ? (
                <SkuDetail
                  item={bySku.get(view.sku)}
                  onOpenBin={(bin) => setStack((s) => [...s, { kind: "bin", bin }])}
                />
              ) : (
                <BinDetail
                  bin={view.bin}
                  items={items}
                  onOpenSku={(sku) => setStack((s) => [...s, { kind: "sku", sku }])}
                />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function TotalChip({ label, value, tone }: { label: string; value: number; tone?: "amber" }) {
  return (
    <span className={`inline-flex items-baseline gap-1 rounded-md px-1.5 py-0.5 text-[11px] ${
      tone === "amber" && value > 0 ? "bg-amber-50 text-amber-700" : "bg-slate-100 text-slate-600"
    }`}>
      <span className="font-semibold font-mono">{value.toLocaleString()}</span>
      <span className="text-[10px] opacity-70">{label}</span>
    </span>
  );
}

function SkuCard({ item, onOpen }: { item: InventoryItem; onOpen: () => void }) {
  const bins = item.bins;
  return (
    <button
      onClick={onOpen}
      className="text-left bg-white rounded-xl border border-slate-200 p-4 shadow-sm hover:shadow-md hover:border-indigo-200 transition-all flex flex-col gap-2.5"
    >
      <div>
        <p className="text-[13px] font-semibold text-slate-900 leading-snug">{item.title}</p>
        <p className="text-[11px] font-mono text-slate-400 mt-0.5">
          {item.sku}
          {item.size && <span className="ml-2 font-sans font-medium text-slate-500">{item.size}</span>}
        </p>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <TotalChip label="on hand" value={item.onHand} />
        <TotalChip label="available" value={item.available} />
        {item.nonSellable > 0 && <TotalChip label="non-sellable" value={item.nonSellable} tone="amber" />}
      </div>
      {bins.length ? (
        <div className="border-t border-slate-100 pt-2 flex flex-col gap-1">
          {bins.slice(0, 4).map((b) => (
            <span key={b.name} className="flex items-baseline justify-between text-[12px]">
              <span className="font-mono text-slate-600">{b.name}</span>
              <span className="font-mono font-semibold text-slate-900">{b.qty}</span>
            </span>
          ))}
          {bins.length > 4 && <span className="text-[11px] text-slate-400">+{bins.length - 4} more bins</span>}
        </div>
      ) : (
        <p className="border-t border-slate-100 pt-2 text-[11px] text-slate-400">
          {item.onHand > 0 ? "no bin recorded" : "out of stock — no bin"}
        </p>
      )}
    </button>
  );
}

function SkuDetail({ item, onOpenBin }: { item: InventoryItem | undefined; onOpenBin: (bin: string) => void }) {
  if (!item) return <p className="text-sm text-slate-400">SKU not in the cache.</p>;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2 text-[12px] text-slate-500">
        <span className="font-mono">{item.sku}</span>
        {item.size && <span className="bg-slate-100 rounded px-1.5 py-0.5 font-medium">{item.size}</span>}
        {item.barcode && <span className="font-mono text-slate-400">{item.barcode}</span>}
      </div>
      <div className="flex flex-wrap gap-1.5">
        <TotalChip label="on hand" value={item.onHand} />
        <TotalChip label="allocated" value={item.allocated} />
        <TotalChip label="available" value={item.available} />
        <TotalChip label="non-sellable" value={item.nonSellable} tone="amber" />
      </div>
      {item.bins.length ? (
        <div className="flex flex-col gap-1">
          <p className="text-[11px] uppercase tracking-wider text-slate-400">Bins</p>
          {item.bins.map((b) => (
            <button
              key={b.name}
              onClick={() => onOpenBin(b.name)}
              className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2 hover:border-indigo-300 hover:bg-indigo-50/40 transition-colors"
            >
              <span className="font-mono text-[13px] text-slate-700">{b.name}</span>
              <span className="flex items-center gap-2">
                <span className="font-mono text-[13px] font-semibold text-slate-900">{b.qty}</span>
                <svg width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" className="text-slate-300"><path d="M9 18l6-6-6-6" /></svg>
              </span>
            </button>
          ))}
        </div>
      ) : (
        <p className="text-sm text-slate-400">{item.onHand > 0 ? "No bin recorded for this stock." : "Out of stock — no bin."}</p>
      )}
    </div>
  );
}

function BinDetail({ bin, items, onOpenSku }: { bin: string; items: InventoryItem[]; onOpenSku: (sku: string) => void }) {
  const contents = useMemo(() => {
    const rows = items
      .map((i) => ({ item: i, qty: i.bins.find((b) => b.name === bin)?.qty ?? 0 }))
      .filter((r) => r.qty !== 0)
      .sort((a, b) => a.item.title.localeCompare(b.item.title));
    return rows;
  }, [bin, items]);
  const units = contents.reduce((a, r) => a + r.qty, 0);
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[12px] text-slate-500">
        {contents.length} SKU{contents.length === 1 ? "" : "s"} · {units.toLocaleString()} units in this bin
      </p>
      <div className="flex flex-col gap-1">
        {contents.map(({ item, qty }) => (
          <button
            key={item.sku}
            onClick={() => onOpenSku(item.sku)}
            className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 px-3 py-2 hover:border-indigo-300 hover:bg-indigo-50/40 transition-colors text-left"
          >
            <span className="min-w-0">
              <span className="block text-[13px] text-slate-800 truncate">{item.title}</span>
              <span className="block text-[11px] font-mono text-slate-400">
                {item.sku}
                {item.size && <span className="ml-2 font-sans">{item.size}</span>}
              </span>
            </span>
            <span className="font-mono text-[13px] font-semibold text-slate-900 shrink-0">{qty}</span>
          </button>
        ))}
        {contents.length === 0 && <p className="text-sm text-slate-400">Nothing recorded in this bin.</p>}
      </div>
    </div>
  );
}
