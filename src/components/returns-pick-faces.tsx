"use client";

// Returns Pick Faces — what's in the PICK-00 returns bins, what's worth moving
// back to the main faces, and how long it's sat there.
//
// Two views over one cached dataset:
//  · By product — EVERY SKU ranked, with actionable ones flagged. Deliberately
//    not filtered to "collate only": with ~120 SKUs mostly sitting as singles
//    that view is empty almost always, which tells the floor nothing.
//  · Bin wall — the rack as it's actually numbered: DOWN each column, six high
//    (bin 1 top-left, bin 6 bottom-left, bin 7 top of the next column).

import { useCallback, useEffect, useMemo, useState } from "react";
import Papa from "papaparse";
import {
  summariseBins,
  productList,
  binsStats,
  ageDays,
  ageBand,
  shortBin,
  rackGrid,
  groupByBay,
  CONSOLIDATE_ENABLED,
  type BinRow,
  type BinsSettings,
  type BinSummary,
  type ProductRow,
} from "@/lib/bins-derive";

const AGE_CLASS: Record<string, string> = {
  fresh: "bg-emerald-50 text-emerald-700",
  ageing: "bg-amber-50 text-amber-700",
  stale: "bg-rose-50 text-rose-700",
  unknown: "bg-slate-100 text-slate-500",
};

function timeAgo(iso: string | null): string {
  if (!iso) return "never";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const secs = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}
const ageLabel = (d: number | null) => (d === null ? "—" : `${d}d`);

type Filter = "all" | "collate" | "split" | "stale";

export function ReturnsPickFaces({
  shipheroConnected,
  initialSettings,
}: {
  shipheroConnected: boolean;
  initialSettings: BinsSettings;
}) {
  const [rows, setRows] = useState<BinRow[] | null>(null);
  const [allBins, setAllBins] = useState<string[]>([]);
  const [settings, setSettings] = useState<BinsSettings>(initialSettings);
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [view, setView] = useState<"products" | "wall">("products");
  const [filter, setFilter] = useState<Filter>("all");
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [openDest, setOpenDest] = useState<string | null>(null);
  const [moveProduct, setMoveProduct] = useState<ProductRow | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/bins/list");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load.");
      setRows(data.rows);
      setAllBins(data.allBins ?? []);
      setLastSyncedAt(data.lastSyncedAt ?? null);
      if (data.settings) setSettings(data.settings);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load.");
    }
  }, []);

  const sync = useCallback(
    async (full = false) => {
      if (!shipheroConnected) return;
      setSyncing(true);
      setError(null);
      try {
        const res = await fetch("/api/bins/sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ full }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Sync failed.");
        await load();
        setLastSyncedAt(data.syncedAt);
        setSyncMsg(`${data.itemsInBins} items`);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Sync failed.");
      } finally {
        setSyncing(false);
      }
    },
    [shipheroConnected, load],
  );

  useEffect(() => {
    (async () => {
      await load();
      if (shipheroConnected) await sync(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const bins = useMemo(() => summariseBins(allBins, rows ?? [], settings), [allBins, rows, settings]);
  const products = useMemo(() => productList(rows ?? [], settings), [rows, settings]);
  const stats = useMemo(() => binsStats(bins, products), [bins, products]);

  const q = query.trim().toLowerCase();
  const matchesQuery = (p: ProductRow) => !q || `${p.sku} ${p.productName}`.toLowerCase().includes(q);
  const productsShown = products.filter((p) => {
    if (!matchesQuery(p)) return false;
    if (filter === "collate") return p.isCollate;
    if (filter === "split") return p.isSplit;
    if (filter === "stale") return p.isStale;
    return true;
  });

  const binMatches = (b: BinSummary) =>
    !q || b.binName.toLowerCase().includes(q) || b.items.some((i) => `${i.sku} ${i.productName}`.toLowerCase().includes(q));

  const selectedBin: BinSummary | null =
    bins.find((b) => b.binName === selected) ?? bins.find((b) => b.units > 0) ?? bins[0] ?? null;

  function download(csv: string, name: string) {
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  }
  const stamp = () => new Date().toISOString().slice(0, 10);

  function exportCsv() {
    if (view === "products") {
      download(
        Papa.unparse(
          productsShown.map((p) => ({
            SKU: p.sku,
            Product: p.productName,
            Units: p.units,
            Bins: p.binCount,
            "Found in": p.sources.map((s) => `${shortBin(s.binName)} x${s.quantity}`).join(" | "),
            "Return to": p.destFace ?? "",
            "In face now": p.destQty ?? "",
            "Oldest (days)": p.oldestDays ?? "",
            Action: p.isCollate ? "Collate" : p.isSplit ? "Consolidate (split)" : p.isNear ? "Nearly" : "",
          })),
        ),
        `returns_products_${stamp()}.csv`,
      );
    } else {
      const out: Record<string, string | number>[] = [];
      for (const b of bins) {
        if (b.items.length === 0) {
          out.push({ Bin: b.binName, SKU: "", Product: "", Units: 0, "In bin (days)": "", State: "empty" });
          continue;
        }
        for (const i of b.items) {
          out.push({
            Bin: b.binName,
            SKU: i.sku,
            Product: i.productName,
            Units: i.quantity,
            "In bin (days)": ageDays(i.landedAt) ?? "",
            State: b.state,
          });
        }
      }
      download(Papa.unparse(out), `returns_bins_${stamp()}.csv`);
    }
  }

  const syncedAgo = lastSyncedAt ? timeAgo(lastSyncedAt) : null;
  const bays = groupByBay(bins);

  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden">
      <header className="h-14 bg-white border-b border-slate-200 flex items-center justify-between px-4 sm:px-5 shrink-0">
        <div className="flex items-center gap-3">
          <span className="font-semibold text-sm text-slate-900">Returns Pick Faces</span>
          <span className="hidden sm:inline text-xs text-slate-400">PICK-00 · {stats.binsTotal} bins</span>
        </div>
        <div className="flex items-center gap-2 sm:gap-3">
          {syncedAgo && (
            <span className="hidden sm:inline text-[11px] text-slate-400">
              synced {syncedAgo}
              {syncMsg && <span className="text-emerald-600"> · {syncMsg}</span>}
            </span>
          )}
          <button onClick={() => setShowSettings(true)} className="text-xs px-2.5 py-1.5 rounded-md border border-slate-200 text-slate-600 hover:bg-slate-50">
            Settings
          </button>
          <button onClick={exportCsv} disabled={(rows?.length ?? 0) === 0} className="text-xs px-3 py-1.5 rounded-md border border-slate-200 text-slate-600 hover:bg-slate-50 disabled:opacity-50">
            Export CSV
          </button>
          <button
            onClick={() => sync(false)}
            disabled={syncing || !shipheroConnected}
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

      <div className="grid grid-cols-2 lg:grid-cols-6 gap-px bg-slate-200 border-b border-slate-200 shrink-0">
        <Kpi label="Units in bins" value={stats.units} sub={`${stats.skus} SKUs`} />
        <Kpi label="Bins used" value={`${stats.binsUsed}/${stats.binsTotal}`} sub={`${stats.binsTotal - stats.binsUsed} empty`} />
        <Kpi label="Ready to collate" value={stats.collateSkus} sub={`over ${settings.collateThreshold} units`} tone={stats.collateSkus > 0 ? "rose" : "slate"} />
        <Kpi label="Split across bins" value={stats.splitSkus} sub="same SKU, 2+ bins" tone={stats.splitSkus > 0 ? "amber" : "slate"} />
        <Kpi label={`Bins over ${settings.binTarget}`} value={stats.binsOver} sub="above target" tone={stats.binsOver > 0 ? "rose" : "slate"} />
        <Kpi label="Oldest stock" value={ageLabel(stats.oldestDays)} sub={stats.oldestBin ? shortBin(stats.oldestBin) : "—"} tone={stats.oldestDays !== null && stats.oldestDays >= settings.ageStaleDays ? "amber" : "slate"} />
      </div>

      <div className="bg-white border-b border-slate-200 px-4 sm:px-5 py-2.5 flex items-center flex-wrap gap-2 sm:gap-3 shrink-0">
        <div className="inline-flex rounded-md border border-slate-200 overflow-hidden">
          <button onClick={() => setView("products")} className={`text-xs px-3 py-1.5 ${view === "products" ? "bg-indigo-600 text-white" : "text-slate-600 hover:bg-slate-50"}`}>
            By product
          </button>
          <button onClick={() => setView("wall")} className={`text-xs px-3 py-1.5 border-l border-slate-200 ${view === "wall" ? "bg-indigo-600 text-white" : "text-slate-600 hover:bg-slate-50"}`}>
            Bin wall
          </button>
        </div>

        {view === "products" && (
          <div className="flex items-center gap-1">
            {([
              ["all", `All (${products.length})`],
              ["collate", `Ready to collate (${stats.collateSkus})`],
              ["split", `Split across bins (${stats.splitSkus})`],
              ["stale", `Stale (${stats.staleSkus})`],
            ] as [Filter, string][]).map(([k, label]) => (
              <button
                key={k}
                onClick={() => setFilter(k)}
                className={`text-[11px] px-2 py-1 rounded border ${filter === k ? "bg-slate-900 text-white border-slate-900" : "border-slate-200 text-slate-600 hover:bg-slate-50"}`}
              >
                {label}
              </button>
            ))}
          </div>
        )}

        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search SKU, product or bin…"
          className="pl-2 pr-2 py-1.5 border border-slate-200 rounded text-xs w-56 focus:ring-1 focus:ring-indigo-300 outline-none ml-auto"
        />
      </div>

      {error && <div className="px-5 py-2 text-xs bg-rose-50 border-b border-rose-200 text-rose-700">{error}</div>}
      {!shipheroConnected && <div className="px-5 py-2 text-xs bg-amber-50 border-b border-amber-200 text-amber-700">ShipHero isn’t connected — Sync is disabled.</div>}

      <div className="flex-1 min-h-0 overflow-auto bg-white thin-scroll">
        {rows === null ? (
          <p className="text-center py-16 text-sm text-slate-400">Loading…</p>
        ) : view === "products" ? (
          productsShown.length === 0 ? (
            <div className="text-center py-16 text-sm text-slate-400">Nothing matches that filter.</div>
          ) : (
            <table className="w-full text-sm border-collapse">
              <thead className="sticky top-0 bg-slate-100 z-10">
                <tr className="text-left text-[11px] uppercase tracking-wide text-slate-400">
                  <th className="font-medium px-4 py-2 border-b border-slate-200">Product</th>
                  <th className="font-medium px-4 py-2 border-b border-slate-200 text-right">Units</th>
                  <th className="font-medium px-4 py-2 border-b border-slate-200">Found in</th>
                  <th className="font-medium px-4 py-2 border-b border-slate-200">Return to</th>
                  <th className="font-medium px-4 py-2 border-b border-slate-200 text-right">Oldest</th>
                  <th className="font-medium px-4 py-2 border-b border-slate-200">Action</th>
                </tr>
              </thead>
              <tbody>
                {productsShown.map((p, i) => (
                  <tr key={p.sku} className={i % 2 ? "bg-slate-50/60" : ""}>
                    <td className="px-4 py-2 border-b border-slate-100">
                      <span className="text-[13px] text-slate-700">{p.productName || "—"}</span>
                      <span className="block font-mono text-[10px] text-slate-400">{p.sku}</span>
                    </td>
                    <td className="px-4 py-2 border-b border-slate-100 text-right">
                      <span className={`px-1.5 py-0.5 rounded text-xs font-semibold tabular-nums ${p.isCollate ? "bg-rose-50 text-rose-700" : "bg-indigo-50 text-indigo-700"}`}>{p.units}</span>
                    </td>
                    <td className="px-4 py-2 border-b border-slate-100">
                      <div className="flex flex-wrap gap-1">
                        {p.sources.map((s) => (
                          <span key={s.binName} className="font-mono text-[11px] bg-slate-100 border border-slate-200 rounded px-1.5 py-0.5 whitespace-nowrap">
                            {shortBin(s.binName)}
                            {s.quantity > 1 && ` ×${s.quantity}`}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="px-4 py-2 border-b border-slate-100 align-top">
                      {p.destFace ? (
                        <>
                          <button
                            onClick={() => setOpenDest(openDest === p.sku ? null : p.sku)}
                            className="text-left group"
                            title="Show every pick face this SKU is known to live in"
                          >
                            <span className="font-mono text-xs text-emerald-700 font-semibold group-hover:underline">{p.destFace}</span>
                            <span className="block text-[10px] text-slate-400">
                              {p.destQty ? `holds ${p.destQty}` : "last used"}
                              {p.destCandidates.length > 1 && (
                                <span className="text-indigo-600"> · +{p.destCandidates.length - 1} more {openDest === p.sku ? "▴" : "▾"}</span>
                              )}
                            </span>
                          </button>
                          {openDest === p.sku && p.destCandidates.length > 0 && (
                            <div className="mt-1.5 border border-slate-200 rounded-md bg-white overflow-hidden">
                              {p.destCandidates.map((c, ci) => (
                                <div
                                  key={c.face}
                                  className={`flex items-center justify-between gap-3 px-2 py-1 text-[11px] ${ci === 0 ? "bg-emerald-50/60" : ""} ${ci ? "border-t border-slate-100" : ""}`}
                                >
                                  <span className="font-mono text-slate-700">{c.face}</span>
                                  <span className="flex items-center gap-2 shrink-0">
                                    <span className={`tabular-nums ${c.qty > 0 ? "text-emerald-700 font-semibold" : "text-slate-400"}`}>{c.qty > 0 ? `${c.qty} in face` : "empty"}</span>
                                    <span className="text-slate-400 tabular-nums">{c.updatedAt ? String(c.updatedAt).slice(0, 10) : "—"}</span>
                                  </span>
                                </div>
                              ))}
                            </div>
                          )}
                        </>
                      ) : (
                        <span
                          className="text-[11px] text-slate-300"
                          title={
                            p.isCollate || p.isSplit
                              ? "Searched every PICK aisle — this SKU has no known pick face"
                              : "Not looked up: pick faces are only resolved for SKUs that need collating or are split across bins"
                          }
                        >
                          {p.isCollate || p.isSplit ? "no known face" : "—"}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2 border-b border-slate-100 text-right">
                      <span className={`px-1.5 py-0.5 rounded text-xs font-medium tabular-nums ${AGE_CLASS[ageBand(p.oldestDays, settings)]}`}>{ageLabel(p.oldestDays)}</span>
                    </td>
                    <td className="px-4 py-2 border-b border-slate-100">
                      <div className="flex items-center gap-2">
                      {p.isCollate ? (
                        <span className="px-1.5 py-0.5 rounded text-[11px] font-semibold bg-rose-100 text-rose-700">Collate</span>
                      ) : p.isSplit ? (
                        <span className="px-1.5 py-0.5 rounded text-[11px] font-medium bg-amber-100 text-amber-700">Split · {p.binCount} bins</span>
                      ) : p.isNear ? (
                        <span className="px-1.5 py-0.5 rounded text-[11px] font-medium bg-slate-100 text-slate-500">1 more to collate</span>
                      ) : null}
                      {CONSOLIDATE_ENABLED && (
                        <button
                          onClick={() => setMoveProduct(p)}
                          className="ml-auto text-[11px] px-2 py-1 rounded border border-indigo-200 text-indigo-700 hover:bg-indigo-50 font-medium inline-flex items-center gap-1"
                          title="Consolidate this SKU into a pick face"
                        >
                          <svg width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2.2" viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
                          Consolidate
                        </button>
                      )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        ) : (
          <div className="grid grid-cols-1 xl:grid-cols-[1fr_320px] h-full">
            <div className="p-4 overflow-auto flex flex-col gap-6">
              {bays.map(({ bay, bins: bayBins }) => {
                const units = bayBins.reduce((a, b) => a + b.units, 0);
                const empty = bayBins.filter((b) => b.units === 0).length;
                const rows = rackGrid(bayBins, 6);
                return (
                  <div key={bay} className="w-max">
                    <div className="flex items-baseline gap-2 mb-2">
                      <span className="text-xs font-semibold text-slate-700">Bay {bay}</span>
                      <span className="text-[11px] text-slate-400 tabular-nums">
                        {bayBins.length} bins · {units} units · {bayBins.length - empty} in use
                      </span>
                    </div>
                    <div className="flex flex-col gap-2">
                      {rows.map((row, r) => (
                        <div key={r} className="flex gap-2 items-stretch">
                          <span className="w-5 shrink-0 flex items-center justify-end pr-0.5 font-mono text-[11px] text-slate-300">{r + 1}</span>
                          {row.map((b, c) =>
                            b === null ? (
                              <div key={c} className="w-[94px] shrink-0" />
                            ) : (
                              <BinTile
                                key={b.binName}
                                bin={b}
                                settings={settings}
                                dim={!!q && !binMatches(b)}
                                selected={selectedBin?.binName === b.binName}
                                onClick={() => setSelected(b.binName)}
                              />
                            ),
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
              <div className="flex flex-wrap gap-3 text-[10px] text-slate-400">
                <Legend cls="border-dashed border-slate-200 bg-white" label="empty" />
                <Legend cls="border-slate-200 bg-slate-50" label={`1–${settings.binTarget} units`} />
                <Legend cls="border-rose-300 bg-rose-50" label={`over ${settings.binTarget}`} />
                <span className="inline-flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-amber-500" />{settings.ageWarnDays}–{settings.ageStaleDays - 1}d</span>
                <span className="inline-flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-rose-500" />{settings.ageStaleDays}d+</span>
                <span className="ml-auto">each bay numbered down its columns — 1 top-left, 6 bottom-left</span>
              </div>
            </div>

            <aside className="border-t xl:border-t-0 xl:border-l border-slate-200 bg-slate-50 p-4">
              <p className="text-[10px] uppercase tracking-wide text-slate-400">Selected bin</p>
              <p className="font-mono text-sm font-semibold text-slate-900 mt-0.5">{selectedBin?.binName ?? "—"}</p>
              {selectedBin && selectedBin.units > 0 && (
                <p className="text-[11px] text-slate-400 mt-0.5">
                  {selectedBin.units} unit{selectedBin.units === 1 ? "" : "s"} · {selectedBin.items.length} SKU{selectedBin.items.length === 1 ? "" : "s"}
                </p>
              )}
              <div className="mt-3 flex flex-col gap-2">
                {!selectedBin || selectedBin.items.length === 0 ? (
                  <p className="text-xs text-slate-400 bg-white border border-slate-200 rounded-lg p-3">Empty — free for putaway.</p>
                ) : (
                  selectedBin.items.map((i) => {
                    const d = ageDays(i.landedAt);
                    return (
                      <div key={i.sku} className="bg-white border border-slate-200 rounded-lg p-2.5">
                        <div className="flex items-start justify-between gap-2">
                          <span className="text-xs text-slate-700 leading-snug">{i.productName || i.sku}</span>
                          <span className="px-1.5 py-0.5 rounded text-[11px] font-semibold bg-indigo-50 text-indigo-700 tabular-nums shrink-0">{i.quantity}</span>
                        </div>
                        <div className="flex items-center justify-between mt-1.5">
                          <span className="font-mono text-[10px] text-slate-400">{i.sku}</span>
                          <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium tabular-nums ${AGE_CLASS[ageBand(d, settings)]}`}>in bin {ageLabel(d)}</span>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </aside>
          </div>
        )}
      </div>

      <footer className="h-8 bg-slate-100 border-t border-slate-200 text-slate-500 text-[11px] flex items-center px-5 gap-4 shrink-0 font-mono">
        <span>{stats.binsUsed}/{stats.binsTotal} bins</span>
        <span>{stats.units} units</span>
        <span>{stats.collateSkus} to collate</span>
        <span>{stats.splitSkus} split</span>
        <span className="ml-auto">{syncedAgo ? `synced ${syncedAgo}` : "not synced yet"}</span>
      </footer>

      {showSettings && (
        <SettingsModal settings={settings} onClose={() => setShowSettings(false)} onSaved={(s) => { setSettings(s); setShowSettings(false); }} />
      )}
      {moveProduct && (
        <ConsolidateModal
          product={moveProduct}
          onClose={() => setMoveProduct(null)}
          onMoved={async () => {
            setMoveProduct(null);
            await sync(false);
          }}
        />
      )}
    </div>
  );
}

function BinTile({
  bin,
  settings,
  selected,
  dim,
  onClick,
}: {
  bin: BinSummary;
  settings: BinsSettings;
  selected: boolean;
  dim: boolean;
  onClick: () => void;
}) {
  const band = ageBand(bin.oldestDays, settings);
  const top = bin.items[0];
  const tone =
    bin.state === "empty"
      ? "border-dashed border-slate-200 bg-white"
      : bin.state === "over"
        ? "border-rose-300 bg-rose-50"
        : "border-slate-200 bg-slate-50";
  const title =
    bin.items.length === 0
      ? `${bin.binName} — empty`
      : `${bin.binName}\n${bin.items.map((i) => `${i.quantity}× ${i.productName || i.sku}`).join("\n")}`;
  return (
    <button
      onClick={onClick}
      title={title}
      className={`w-[94px] shrink-0 border rounded-lg px-2 py-1.5 text-left flex flex-col gap-1 min-h-[66px] relative transition-opacity ${tone} ${
        selected ? "ring-2 ring-indigo-400 border-indigo-400" : "hover:border-indigo-300"
      } ${dim ? "opacity-25" : ""}`}
    >
      <div className="flex items-baseline justify-between gap-1">
        <span className="font-mono text-[11px] text-slate-400">{shortBin(bin.binName)}</span>
        <span className={`text-xl font-bold leading-none tabular-nums ${bin.state === "empty" ? "text-slate-300" : bin.state === "over" ? "text-rose-600" : "text-slate-800"}`}>
          {bin.units || "·"}
        </span>
      </div>
      {top ? (
        <>
          <span className="text-[11px] leading-tight text-slate-600 line-clamp-3">
            {top.productName || top.sku}
            {bin.items.length > 1 && <span className="text-slate-400 font-medium"> +{bin.items.length - 1} more</span>}
          </span>
          {bin.oldestDays !== null && (
            <span className={`mt-auto text-[10px] tabular-nums ${band === "stale" ? "text-rose-600 font-medium" : band === "ageing" ? "text-amber-600" : "text-slate-400"}`}>
              in bin {ageLabel(bin.oldestDays)}
            </span>
          )}
        </>
      ) : (
        <span className="mt-auto text-[10px] text-slate-300">free</span>
      )}
      {(band === "ageing" || band === "stale") && (
        <span className={`absolute top-1.5 right-1.5 w-2 h-2 rounded-full ${band === "stale" ? "bg-rose-500" : "bg-amber-500"}`} />
      )}
    </button>
  );
}

interface MovePreview {
  dest: { face: string; currentQty: number; willBe: number };
  sources: { binName: string; liveQty: number; movable: boolean }[];
  totalMove: number;
  warnings: string[];
}
interface MoveResult {
  ok: boolean;
  dest: { face: string; qtyAfter: number };
  movedTotal: number;
  results: { binName: string; moved: number; ok: boolean; error?: string }[];
}

function ConsolidateModal({
  product,
  onClose,
  onMoved,
}: {
  product: ProductRow;
  onClose: () => void;
  onMoved: () => void;
}) {
  const candidates = product.destCandidates.filter((c) => !c.face.toUpperCase().startsWith("PICK-00"));
  const [checked, setChecked] = useState<Set<string>>(new Set(product.sources.map((s) => s.binName)));
  const [destFace, setDestFace] = useState(candidates[0]?.face ?? "");
  const [phase, setPhase] = useState<"collect" | "preview" | "done">("collect");
  const [preview, setPreview] = useState<MovePreview | null>(null);
  const [result, setResult] = useState<MoveResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const binNames = product.sources.map((s) => s.binName).filter((b) => checked.has(b));
  const toggle = (bin: string) =>
    setChecked((s) => {
      const n = new Set(s);
      if (n.has(bin)) n.delete(bin);
      else n.add(bin);
      return n;
    });

  async function call(confirm: boolean) {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/bins/move", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sku: product.sku, binNames, destFace: destFace.trim(), confirm }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Something went wrong.");
      if (confirm) {
        setResult(data as MoveResult);
        setPhase("done");
      } else {
        setPreview(data as MovePreview);
        setPhase("preview");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg max-h-[88vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-slate-200">
          <p className="text-sm font-semibold text-slate-900">Consolidate stock</p>
          <p className="text-[13px] text-slate-600 mt-0.5">{product.productName || product.sku}</p>
          <p className="font-mono text-[11px] text-slate-400">{product.sku}</p>
        </div>

        <div className="flex-1 overflow-auto p-5 thin-scroll">
          {phase === "collect" && (
            <>
              <p className="text-[11px] uppercase tracking-wide text-slate-400 mb-2">Collect from — tick each bin as you pick it</p>
              <div className="flex flex-col gap-2">
                {product.sources.map((s) => (
                  <label
                    key={s.binName}
                    className={`flex items-center gap-3 border rounded-lg px-3 py-2 cursor-pointer ${checked.has(s.binName) ? "border-indigo-300 bg-indigo-50/50" : "border-slate-200"}`}
                  >
                    <input type="checkbox" checked={checked.has(s.binName)} onChange={() => toggle(s.binName)} className="w-4 h-4" />
                    <span className="font-mono text-xs text-slate-700 flex-1">{s.binName}</span>
                    <span className="px-1.5 py-0.5 rounded text-xs font-semibold bg-slate-100 text-slate-700 tabular-nums">{s.quantity}</span>
                  </label>
                ))}
              </div>

              <p className="text-[11px] uppercase tracking-wide text-slate-400 mt-4 mb-2">Consolidate into</p>
              {candidates.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {candidates.map((c) => (
                    <button
                      key={c.face}
                      onClick={() => setDestFace(c.face)}
                      className={`font-mono text-[11px] px-2 py-1 rounded border ${destFace === c.face ? "bg-indigo-600 text-white border-indigo-600" : "border-slate-200 text-slate-600 hover:bg-slate-50"}`}
                      title={c.qty > 0 ? `holds ${c.qty} now` : "empty face"}
                    >
                      {c.face}
                      {c.qty > 0 && <span className={destFace === c.face ? "text-indigo-100" : "text-slate-400"}> · {c.qty}</span>}
                    </button>
                  ))}
                </div>
              )}
              <input
                value={destFace}
                onChange={(e) => setDestFace(e.target.value)}
                placeholder="or type a pick face, e.g. PICK-03-12-D-01"
                className="w-full px-2.5 py-2 border border-slate-200 rounded text-sm font-mono focus:ring-1 focus:ring-indigo-300 outline-none"
              />
              <p className="text-[11px] text-slate-400 mt-1.5">Must be an existing pickable face — not a PICK-00 returns bin.</p>
            </>
          )}

          {phase === "preview" && preview && (
            <>
              <p className="text-[11px] uppercase tracking-wide text-slate-400 mb-2">Review — nothing has moved yet</p>
              <div className="border border-slate-200 rounded-lg divide-y divide-slate-100">
                {preview.sources.map((s) => (
                  <div key={s.binName} className="flex items-center justify-between px-3 py-2 text-sm">
                    <span className="font-mono text-xs text-slate-600">{s.binName}</span>
                    <span className={`tabular-nums ${s.movable ? "text-slate-700" : "text-rose-500"}`}>{s.movable ? `move ${s.liveQty}` : "empty — skip"}</span>
                  </div>
                ))}
              </div>
              <div className="flex items-center justify-center gap-3 my-3 text-sm">
                <span className="font-semibold tabular-nums text-slate-900">{preview.totalMove} units</span>
                <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" className="text-slate-400"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
                <span className="font-mono text-sm font-semibold text-emerald-700">{preview.dest.face}</span>
              </div>
              <p className="text-center text-[12px] text-slate-500">
                {preview.dest.face} holds <span className="tabular-nums">{preview.dest.currentQty}</span> → will be <span className="tabular-nums font-semibold text-slate-800">{preview.dest.willBe}</span>
              </p>
              {preview.warnings.length > 0 && (
                <div className="mt-3 bg-amber-50 border border-amber-200 rounded-lg p-2.5 text-[12px] text-amber-800">
                  {preview.warnings.map((w, i) => (
                    <p key={i}>⚠ {w}</p>
                  ))}
                </div>
              )}
              {preview.totalMove === 0 && (
                <p className="mt-3 text-center text-sm text-rose-600">Nothing left to move — these bins have all been picked since.</p>
              )}
            </>
          )}

          {phase === "done" && result && (
            <>
              <p className={`text-sm font-semibold mb-3 ${result.ok ? "text-emerald-700" : "text-amber-700"}`}>
                {result.ok ? "✓ Moved" : "Partly moved — check the failures"}
              </p>
              <div className="border border-slate-200 rounded-lg divide-y divide-slate-100">
                {result.results.map((r) => (
                  <div key={r.binName} className="flex items-center justify-between px-3 py-2 text-sm">
                    <span className="font-mono text-xs text-slate-600">{r.binName}</span>
                    {r.ok ? (
                      <span className="text-emerald-700 tabular-nums">✓ moved {r.moved}</span>
                    ) : (
                      <span className="text-rose-600 text-xs" title={r.error}>✕ {r.error ?? "failed"}</span>
                    )}
                  </div>
                ))}
              </div>
              <p className="text-center text-[12px] text-slate-500 mt-3">
                {result.dest.face} now holds <span className="tabular-nums font-semibold text-slate-800">{result.dest.qtyAfter}</span>
              </p>
            </>
          )}

          {error && <p className="text-xs text-rose-600 mt-3 bg-rose-50 border border-rose-200 rounded p-2">{error}</p>}
        </div>

        <div className="px-5 py-3 border-t border-slate-200 flex items-center justify-end gap-2">
          {phase === "collect" && (
            <>
              <button onClick={onClose} className="text-xs px-3 py-1.5 rounded-md border border-slate-200 text-slate-600 hover:bg-slate-50">Cancel</button>
              <button
                onClick={() => call(false)}
                disabled={loading || binNames.length === 0 || !destFace.trim()}
                className="text-xs px-4 py-1.5 rounded-md bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-40"
              >
                {loading ? "Checking…" : "Preview move"}
              </button>
            </>
          )}
          {phase === "preview" && (
            <>
              <button onClick={() => setPhase("collect")} disabled={loading} className="text-xs px-3 py-1.5 rounded-md border border-slate-200 text-slate-600 hover:bg-slate-50">Back</button>
              <button
                onClick={() => call(true)}
                disabled={loading || (preview?.totalMove ?? 0) === 0}
                className="text-xs px-4 py-1.5 rounded-md bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-40"
              >
                {loading ? "Moving…" : `Confirm & move ${preview?.totalMove ?? 0}`}
              </button>
            </>
          )}
          {phase === "done" && (
            <button
              onClick={() => (result && result.movedTotal > 0 ? onMoved() : onClose())}
              className="text-xs px-4 py-1.5 rounded-md bg-slate-900 text-white hover:bg-slate-800"
            >
              Done
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Kpi({ label, value, sub, tone = "slate" }: { label: string; value: string | number; sub?: string; tone?: "slate" | "rose" | "amber" }) {
  const color = tone === "rose" ? "text-rose-600" : tone === "amber" ? "text-amber-600" : "text-slate-900";
  return (
    <div className="bg-white p-3.5">
      <p className="text-[10px] uppercase tracking-wide text-slate-400">{label}</p>
      <p className={`text-xl font-bold mt-0.5 tabular-nums ${color}`}>{value}</p>
      {sub && <p className="text-[11px] text-slate-400">{sub}</p>}
    </div>
  );
}

function Legend({ cls, label }: { cls: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`w-2.5 h-2.5 rounded border ${cls}`} />
      {label}
    </span>
  );
}

function SettingsModal({
  settings,
  onClose,
  onSaved,
}: {
  settings: BinsSettings;
  onClose: () => void;
  onSaved: (s: BinsSettings) => void;
}) {
  const [form, setForm] = useState(settings);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setErr(null);
    try {
      const res = await fetch("/api/bins/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Save failed.");
      onSaved(data.settings);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  }

  const fields: { k: keyof BinsSettings; label: string; hint: string }[] = [
    { k: "collateThreshold", label: "Collate over", hint: "units of one SKU across bins" },
    { k: "binTarget", label: "Bin target", hint: "units per bin before flagged" },
    { k: "ageWarnDays", label: "Ageing after", hint: "days in bin" },
    { k: "ageStaleDays", label: "Stale after", hint: "days in bin" },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-5" onClick={(e) => e.stopPropagation()}>
        <p className="text-sm font-semibold text-slate-900">Returns pick face settings</p>
        <p className="text-xs text-slate-400 mt-0.5 mb-4">Thresholds are process rules — ShipHero doesn’t enforce a bin capacity.</p>
        <div className="grid grid-cols-2 gap-4">
          {fields.map((f) => (
            <div key={f.k}>
              <p className="text-xs font-medium text-slate-700">{f.label}</p>
              <p className="text-[11px] text-slate-400 mb-1">{f.hint}</p>
              <input
                type="number"
                min={0}
                value={form[f.k]}
                onChange={(e) => setForm((prev) => ({ ...prev, [f.k]: Number(e.target.value) || 0 }))}
                className="w-full px-2 py-1.5 border border-slate-200 rounded text-sm"
              />
            </div>
          ))}
        </div>
        {err && <p className="text-xs text-rose-600 mt-3">{err}</p>}
        <div className="flex justify-end gap-2 mt-5">
          <button onClick={onClose} className="text-xs px-3 py-1.5 rounded-md border border-slate-200 text-slate-600 hover:bg-slate-50">Cancel</button>
          <button onClick={save} disabled={saving} className="text-xs px-4 py-1.5 rounded-md bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50">
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
