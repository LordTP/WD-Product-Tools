"use client";

import { useEffect, useState, useCallback } from "react";
import Papa from "papaparse";
import type { PoSummary, PoDetail, PoLineDetail } from "@/lib/shiphero/po-pull";
import { deriveSizeFromSku, type SizeMap } from "@/lib/sizes";
import { normalizeSheetDate, ukDate } from "@/lib/shiphero/dates";
import { ColumnFilter, BLANK_SENTINEL } from "@/components/column-filter";

interface PoDatesRow {
  orderSent: string | null;
  exFactory: string | null;
  delivery: string | null;
}

// Column definitions for the Excel-style header filters.
const COLUMNS: { id: string; label: string; get: (p: PoSummary) => string }[] = [
  { id: "poNumber", label: "PO Number", get: (p) => p.poNumber },
  { id: "product", label: "Product", get: (p) => p.products.join(", ") },
  { id: "vendor", label: "Vendor", get: (p) => p.vendorName ?? "" },
  { id: "status", label: "Status", get: (p) => p.status },
  { id: "poDate", label: "PO Date", get: (p) => p.poDate?.slice(0, 10) ?? "" },
  { id: "total", label: "Total", get: (p) => p.totalPrice ?? "" },
];
const COL = Object.fromEntries(COLUMNS.map((c) => [c.id, c]));

const passesValue = (value: string, selected: string[]): boolean => {
  if (selected.length === 0) return true;
  return value === "" ? selected.includes(BLANK_SENTINEL) : selected.includes(value);
};

// Chip text: show the value(s) when few, else a count (e.g. "3 selected").
function filterValueText(vals: string[]): string {
  const labels = vals.map((v) => (v === BLANK_SENTINEL ? "(Blank)" : v));
  if (labels.length <= 2) return labels.join(", ");
  return `${labels.length} selected`;
}

function fmtPrice(p: string): string {
  if (!p) return "—";
  const n = Number(p);
  return Number.isNaN(n) ? p : n.toFixed(2);
}

function sinceFromMonths(months: number | null): string {
  if (months === null) return "2020-01-01"; // effectively "all"
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  return d.toISOString().slice(0, 10);
}

function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

function statusClass(s: string): string {
  const k = s.toLowerCase();
  if (k.includes("cancel")) return "bg-rose-100 text-rose-700";
  if (k.includes("close") || k.includes("receiv")) return "bg-emerald-100 text-emerald-700";
  if (k.includes("transit") || k.includes("partial")) return "bg-indigo-100 text-indigo-700";
  if (k.includes("pending")) return "bg-amber-100 text-amber-700";
  return "bg-slate-100 text-slate-600";
}

export function PoHistory({
  shipheroConnected,
  statuses,
  sizeMap,
}: {
  shipheroConnected: boolean;
  statuses: string[];
  sizeMap: SizeMap;
}) {
  const [rangeMonths, setRangeMonths] = useState<number | null>(12); // null = all
  const [mappedOnly, setMappedOnly] = useState(true);
  const [query, setQuery] = useState("");
  const [colFilters, setColFilters] = useState<Record<string, string[]>>({});
  const [pos, setPos] = useState<PoSummary[] | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openPo, setOpenPo] = useState<PoSummary | null>(null);
  const [details, setDetails] = useState<Record<string, PoDetail | "loading" | { error: string }>>({});
  const [exportChooser, setExportChooser] = useState(false);
  const [exportingLines, setExportingLines] = useState(false);
  // Bulk date amend (Flossie's supplier-slip workflow).
  const [datesByPo, setDatesByPo] = useState<Record<string, PoDatesRow>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkDelivery, setBulkDelivery] = useState("");
  const [bulkExFactory, setBulkExFactory] = useState("");
  const [bulkShift, setBulkShift] = useState("14");
  const [bulkApplying, setBulkApplying] = useState(false);
  const [bulkMsg, setBulkMsg] = useState<string | null>(null);
  const [pasteOpen, setPasteOpen] = useState(false);

  // Reads the LOCAL CACHE — instant, no API credits.
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/po/list?mappedOnly=${mappedOnly ? "1" : "0"}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load.");
      setPos(data.pos);
      setDatesByPo(data.dates ?? {});
      setLastSyncedAt(data.lastSyncedAt);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load.");
    } finally {
      setLoading(false);
    }
  }, [mappedOnly]);

  // The only path that hits ShipHero — refreshes the cache, then re-reads it.
  async function sync(full = false) {
    if (!shipheroConnected) return;
    setSyncing(true);
    setError(null);
    try {
      const res = await fetch("/api/po/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ since: sinceFromMonths(rangeMonths), full }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Sync failed.");
      await load();
      setLastSyncedAt(data.syncedAt); // reflect the run even if 0 changed
      setSyncMsg(data.count > 0 ? `${data.count} PO${data.count === 1 ? "" : "s"} updated` : "up to date");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sync failed.");
    } finally {
      setSyncing(false);
    }
  }

  useEffect(() => {
    load();
  }, [load]);

  const loadDetail = useCallback(async (poNumber: string, force = false) => {
    setDetails((d) => ({ ...d, [poNumber]: "loading" }));
    try {
      const res = await fetch(`/api/po/detail?po=${encodeURIComponent(poNumber)}${force ? "&force=1" : ""}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Couldn’t load this PO.");
      setDetails((d) => ({ ...d, [poNumber]: data.detail }));
    } catch (e) {
      setDetails((d) => ({ ...d, [poNumber]: { error: e instanceof Error ? e.message : "Failed to load." } }));
    }
  }, []);

  function openDetail(po: PoSummary) {
    setOpenPo(po);
    const cur = details[po.poNumber];
    if (!cur || (typeof cur === "object" && "error" in cur)) {
      loadDetail(po.poNumber);
    }
  }

  // Reflect a fresh detail (from an edit/refresh) into the modal + the table row.
  const applyDetail = useCallback((detail: PoDetail) => {
    setDetails((d) => ({ ...d, [detail.poNumber]: detail }));
    setPos((prev) =>
      prev
        ? prev.map((p) =>
            p.poNumber === detail.poNumber
              ? {
                  ...p,
                  status: detail.status,
                  poDate: detail.poDate,
                  totalPrice: detail.totalPrice,
                  products: detail.products,
                  unitsOrdered: detail.unitsOrdered,
                  unitsReceived: detail.unitsReceived,
                }
              : p,
          )
        : prev,
    );
    setOpenPo((prev) => (prev && prev.poNumber === detail.poNumber ? { ...prev, status: detail.status, poDate: detail.poDate } : prev));
  }, []);

  // ---- bulk date amend ----
  async function applyBulk(
    changes: Array<{ poNumber: string; delivery?: string; exFactory?: string; orderSent?: string }>,
  ) {
    if (!changes.length) return;
    setBulkApplying(true);
    setBulkMsg(null);
    setError(null);
    try {
      const res = await fetch("/api/po/bulk-dates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ changes }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Bulk update failed.");
      setBulkMsg(
        `${data.applied} PO${data.applied === 1 ? "" : "s"} updated${
          data.failed?.length ? ` · ${data.failed.length} failed` : ""
        }`,
      );
      if (data.failed?.length) {
        setError(
          `Failed: ${data.failed
            .map((f: { poNumber: string; error?: string }) => `${f.poNumber} (${f.error ?? "?"})`)
            .join("; ")}`,
        );
      }
      setSelected(new Set());
      setPasteOpen(false);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Bulk update failed.");
    } finally {
      setBulkApplying(false);
    }
  }

  // Does a row pass the column filters? Optionally ignore one column (used when
  // computing that column's distinct list — Excel narrows by the OTHER filters).
  const passesColumnFilters = useCallback(
    (p: PoSummary, exceptId?: string): boolean =>
      COLUMNS.every((c) => c.id === exceptId || passesValue(c.get(p), colFilters[c.id] ?? [])),
    [colFilters],
  );

  // Distinct values for a column's dropdown, narrowed by the other active filters.
  const distinctFor = useCallback(
    (colId: string): { values: string[]; hasBlanks: boolean } => {
      const get = COL[colId].get;
      const set = new Set<string>();
      let hasBlanks = false;
      for (const p of pos ?? []) {
        if (!passesColumnFilters(p, colId)) continue;
        const v = get(p);
        if (v === "") hasBlanks = true;
        else set.add(v);
      }
      return { values: [...set].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })), hasBlanks };
    },
    [pos, passesColumnFilters],
  );

  // Final visible rows: text search AND all column filters.
  const filtered = (pos ?? []).filter((p) => {
    if (!passesColumnFilters(p)) return false;
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return [p.poNumber, p.products.join(" "), p.vendorName ?? "", p.status, p.poDate?.slice(0, 10) ?? "", p.totalPrice ?? ""]
      .join(" ")
      .toLowerCase()
      .includes(q);
  });

  const activeFilterCount = Object.values(colFilters).filter((v) => v.length > 0).length;

  function downloadCsv(csv: string, name: string) {
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  }

  const stamp = () => new Date().toISOString().slice(0, 10);

  // General export: one row per PO (current filters + search).
  function exportGeneral() {
    setExportChooser(false);
    const rows = filtered.map((p) => ({
      "PO Number": p.poNumber,
      Product: p.products.join(" | "),
      Vendor: p.vendorName ?? "",
      Status: p.status,
      "PO Date": p.poDate?.slice(0, 10) ?? "",
      Total: p.totalPrice ?? "",
    }));
    downloadCsv(Papa.unparse(rows), `wander_doll_po_history_${stamp()}.csv`);
  }

  // Line-level export: one row per size/SKU (size-ordered) across the filtered POs.
  async function exportLines() {
    setExportingLines(true);
    try {
      const res = await fetch("/api/po/export-lines");
      const data = await res.json();
      const byPo: Record<string, PoLineDetail[]> = data.lines ?? {};
      const rank = (sku: string) => {
        const i = sizeMap.order.indexOf(deriveSizeFromSku(sku, sizeMap));
        return i === -1 ? Number.MAX_SAFE_INTEGER : i;
      };
      const rows: Record<string, string | number>[] = [];
      for (const p of filtered) {
        const lines = [...(byPo[p.poNumber] ?? [])].sort((a, b) => rank(a.sku) - rank(b.sku));
        for (const l of lines) {
          const qty = Number(l.quantity) || 0;
          const price = Number(l.price) || 0;
          rows.push({
            "PO Number": p.poNumber,
            Product: l.productName || p.products.join(" | "),
            Size: deriveSizeFromSku(l.sku, sizeMap),
            SKU: l.sku,
            "Qty Ordered": l.quantity,
            "Qty Received": l.quantityReceived,
            "Unit Price": l.price,
            "Line Total": (qty * price).toFixed(2),
            Vendor: p.vendorName ?? "",
            Status: p.status,
            "PO Date": p.poDate?.slice(0, 10) ?? "",
          });
        }
      }
      downloadCsv(Papa.unparse(rows), `wander_doll_po_lines_${stamp()}.csv`);
      setExportChooser(false);
    } catch {
      setError("Line-level export failed.");
    } finally {
      setExportingLines(false);
    }
  }

  const syncedAgo = lastSyncedAt ? timeAgo(lastSyncedAt) : null;

  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden">
      <Header>
        <div className="relative">
          <svg
            className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400"
            width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"
          >
            <circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" />
          </svg>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search PO, product, vendor, status…"
            className="pl-7 pr-2 py-1.5 border border-slate-200 rounded text-xs w-64 focus:ring-1 focus:ring-indigo-300 outline-none"
          />
        </div>
        <label className="flex items-center gap-1.5 text-xs text-slate-500 select-none">
          <input
            type="checkbox"
            checked={mappedOnly}
            onChange={(e) => setMappedOnly(e.target.checked)}
          />
          Mapped vendors only
        </label>
        <label className="flex items-center gap-1.5 text-xs text-slate-500">
          Range
          <select
            value={rangeMonths === null ? "all" : String(rangeMonths)}
            onChange={(e) => setRangeMonths(e.target.value === "all" ? null : Number(e.target.value))}
            className="px-2 py-1 border border-slate-200 rounded text-xs bg-white"
          >
            <option value="3">Last 3 months</option>
            <option value="6">Last 6 months</option>
            <option value="12">Last 12 months</option>
            <option value="24">Last 2 years</option>
            <option value="all">All POs</option>
          </select>
        </label>
        {syncedAgo && (
          <span className="text-[11px] text-slate-400">
            synced {syncedAgo}{syncMsg && <span className="text-emerald-600"> · {syncMsg}</span>}
          </span>
        )}
        <button
          onClick={() => setPasteOpen(true)}
          title="Paste a supplier's revised dates sheet (PO number + dates) and apply in bulk"
          className="text-xs px-3 py-1.5 rounded-md border border-slate-200 text-slate-600 hover:bg-slate-50 flex items-center gap-1.5"
        >
          <svg width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <rect x="8" y="2" width="8" height="4" rx="1" />
            <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2M9 13h6M9 17h4" />
          </svg>
          Amend dates
        </button>
        <button
          onClick={() => setExportChooser(true)}
          disabled={filtered.length === 0}
          title="Download the current view as CSV (Excel)"
          className="text-xs px-3 py-1.5 rounded-md border border-slate-200 text-slate-600 hover:bg-slate-50 disabled:opacity-50 flex items-center gap-1.5"
        >
          <svg width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />
          </svg>
          Export ({filtered.length})
        </button>
        <button
          onClick={() => sync(true)}
          disabled={syncing || !shipheroConnected}
          title="Re-pull every PO in the selected range (slower; use after admin changes or first setup)"
          className="text-xs px-3 py-1.5 rounded-md border border-slate-200 text-slate-600 hover:bg-slate-50 disabled:opacity-50"
        >
          Full resync
        </button>
        <button
          onClick={() => sync(false)}
          disabled={syncing || !shipheroConnected}
          title={shipheroConnected ? "Pull only POs changed since the last sync (fast)" : "Connect ShipHero first"}
          className={`text-xs px-3 py-1.5 rounded-md flex items-center gap-1.5 ${
            shipheroConnected ? "bg-indigo-600 text-white hover:bg-indigo-700" : "bg-slate-200 text-slate-400 cursor-not-allowed"
          } disabled:opacity-60`}
        >
          <svg
            width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"
            className={syncing ? "animate-spin" : ""}
          >
            <path d="M21 2v6h-6M3 12a9 9 0 0 1 15-6.7L21 8M3 22v-6h6M21 12a9 9 0 0 1-15 6.7L3 16" />
          </svg>
          {syncing ? "Syncing…" : "Sync"}
        </button>
      </Header>

      {activeFilterCount > 0 && (
        <div className="flex items-center gap-2 px-5 py-1.5 bg-indigo-50/70 border-b border-indigo-100 text-[11px] shrink-0">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" className="text-indigo-600 shrink-0">
            <path d="M22 3H2l8 9.46V19l4 2v-8.54z" />
          </svg>
          <span className="font-semibold text-indigo-900 shrink-0">Filters:</span>
          <div className="flex items-center gap-1 flex-wrap flex-1 min-w-0">
            {COLUMNS.filter((c) => (colFilters[c.id] ?? []).length > 0).map((c) => {
              const vals = colFilters[c.id];
              return (
                <button
                  key={c.id}
                  onClick={() => setColFilters((f) => ({ ...f, [c.id]: [] }))}
                  title={`${c.label}: ${vals.map((v) => (v === BLANK_SENTINEL ? "(Blank)" : v)).join(", ")}\nClick to remove`}
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-white border border-indigo-200 rounded text-indigo-800 hover:bg-indigo-100 transition-colors"
                >
                  <span className="font-medium">{c.label}:</span>
                  <span className="truncate max-w-[160px]">{filterValueText(vals)}</span>
                  <span className="text-indigo-400 leading-none">×</span>
                </button>
              );
            })}
          </div>
          <button
            onClick={() => setColFilters({})}
            className="px-2 py-0.5 text-indigo-700 hover:bg-indigo-100 rounded font-medium shrink-0"
          >
            Clear all
          </button>
        </div>
      )}

      {selected.size > 0 && (
        <div className="px-5 py-2 bg-indigo-50/70 border-b border-indigo-100 flex items-center gap-3 flex-wrap text-xs">
          <span className="font-semibold text-indigo-800">{selected.size} selected</span>
          <span className="flex items-center gap-1.5 text-slate-600">
            Set delivery
            <input
              type="date"
              value={bulkDelivery}
              onChange={(e) => setBulkDelivery(e.target.value)}
              className="border border-slate-200 rounded px-1.5 py-0.5 bg-white"
            />
            <button
              disabled={!bulkDelivery || bulkApplying}
              onClick={() => applyBulk([...selected].map((poNumber) => ({ poNumber, delivery: bulkDelivery })))}
              className="px-2 py-0.5 rounded bg-indigo-600 text-white font-medium disabled:opacity-40"
            >
              Apply
            </button>
          </span>
          <span className="text-slate-300">·</span>
          <span className="flex items-center gap-1.5 text-slate-600" title="Moves each PO's current delivery date by this many days (keeps their relative spread)">
            Shift
            <input
              type="number"
              value={bulkShift}
              onChange={(e) => setBulkShift(e.target.value)}
              className="border border-slate-200 rounded px-1.5 py-0.5 w-14 bg-white"
            />
            days
            <button
              disabled={!Number(bulkShift) || bulkApplying}
              onClick={() => {
                const n = Number(bulkShift);
                const changes = [...selected]
                  .map((poNumber) => {
                    const base =
                      datesByPo[poNumber]?.delivery ??
                      pos?.find((p) => p.poNumber === poNumber)?.poDate?.slice(0, 10);
                    if (!base) return null;
                    const d = new Date(`${base}T00:00:00`);
                    d.setDate(d.getDate() + n);
                    const pad = (x: number) => String(x).padStart(2, "0");
                    return { poNumber, delivery: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` };
                  })
                  .filter((c): c is { poNumber: string; delivery: string } => c !== null);
                applyBulk(changes);
              }}
              className="px-2 py-0.5 rounded bg-indigo-600 text-white font-medium disabled:opacity-40"
            >
              Apply
            </button>
          </span>
          <span className="text-slate-300">·</span>
          <span className="flex items-center gap-1.5 text-slate-600">
            Set ex-factory
            <input
              type="date"
              value={bulkExFactory}
              onChange={(e) => setBulkExFactory(e.target.value)}
              className="border border-slate-200 rounded px-1.5 py-0.5 bg-white"
            />
            <button
              disabled={!bulkExFactory || bulkApplying}
              onClick={() => applyBulk([...selected].map((poNumber) => ({ poNumber, exFactory: bulkExFactory })))}
              className="px-2 py-0.5 rounded bg-indigo-600 text-white font-medium disabled:opacity-40"
            >
              Apply
            </button>
          </span>
          {bulkApplying && <span className="text-indigo-600 font-medium">Applying…</span>}
          {bulkMsg && !bulkApplying && <span className="text-emerald-700 font-medium">{bulkMsg}</span>}
          <span className="ml-auto flex items-center gap-2">
            <button
              onClick={() => setPasteOpen(true)}
              className="px-2 py-0.5 rounded border border-indigo-200 text-indigo-700 font-medium hover:bg-indigo-100"
            >
              Paste revisions…
            </button>
            <button onClick={() => setSelected(new Set())} className="text-slate-500 hover:text-slate-700">
              Clear
            </button>
          </span>
        </div>
      )}

      {error && <div className="px-5 py-2 text-xs bg-rose-50 border-b border-rose-200 text-rose-700">{error}</div>}

      <div className="flex-1 min-h-0 overflow-auto bg-white thin-scroll">
        <table className="w-full text-sm border-collapse">
          <thead className="sticky top-0 bg-slate-100 z-10">
            <tr className="text-left text-[11px] uppercase tracking-wide text-slate-400">
              <th className="font-medium px-4 py-2 border-b border-slate-200 w-8">
                <input
                  type="checkbox"
                  title="Select all visible"
                  checked={filtered.length > 0 && filtered.every((p) => selected.has(p.poNumber))}
                  onChange={(e) => {
                    setSelected((prev) => {
                      const next = new Set(prev);
                      for (const p of filtered) {
                        if (e.target.checked) next.add(p.poNumber);
                        else next.delete(p.poNumber);
                      }
                      return next;
                    });
                  }}
                />
              </th>
              {COLUMNS.map((c) => (
                <th
                  key={c.id}
                  className={`font-medium px-4 py-2 border-b border-slate-200 ${
                    c.id === "poNumber" || c.id === "status" || c.id === "poDate" || c.id === "total" ? "w-28" : ""
                  } ${c.id === "total" ? "text-right" : ""}`}
                >
                  <span className={`inline-flex items-center gap-1 ${c.id === "total" ? "flex-row-reverse" : ""}`}>
                    {c.label}
                    <ColumnFilter
                      label={c.label}
                      {...distinctFor(c.id)}
                      selected={colFilters[c.id] ?? []}
                      onApply={(vals) => setColFilters((f) => ({ ...f, [c.id]: vals }))}
                    />
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map((po, i) => (
              <PoRow
                key={po.poNumber + i}
                po={po}
                zebra={i % 2 === 1}
                onOpen={() => openDetail(po)}
                checked={selected.has(po.poNumber)}
                onToggle={() =>
                  setSelected((prev) => {
                    const next = new Set(prev);
                    if (next.has(po.poNumber)) next.delete(po.poNumber);
                    else next.add(po.poNumber);
                    return next;
                  })
                }
                exFactory={datesByPo[po.poNumber]?.exFactory ?? null}
              />
            ))}
            {pos && filtered.length === 0 && !loading && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-xs text-slate-400">
                  {query.trim()
                    ? `No POs match “${query}”.`
                    : lastSyncedAt
                      ? "No POs in the cache match the current filter."
                      : "No POs cached yet — click “Sync from ShipHero” to pull them."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <footer className="h-8 bg-slate-100 border-t border-slate-200 text-slate-500 text-[11px] flex items-center px-5 gap-4 shrink-0 font-mono">
        <span>
          {query.trim() ? `${filtered.length} of ${pos?.length ?? 0}` : `${pos?.length ?? 0}`} POs
        </span>
        <span className="text-slate-400">from local cache · click a PO to open it</span>
        <span className="ml-auto">{syncedAgo ? `synced ${syncedAgo}` : "not synced yet"}</span>
      </footer>

      {pasteOpen && (
        <PasteRevisionsModal
          pos={pos ?? []}
          datesByPo={datesByPo}
          applying={bulkApplying}
          onApply={applyBulk}
          onClose={() => setPasteOpen(false)}
        />
      )}
      {openPo && (
        <PoDetailModal
          po={openPo}
          detail={details[openPo.poNumber]}
          statuses={statuses}
          sizeMap={sizeMap}
          shipheroConnected={shipheroConnected}
          onClose={() => setOpenPo(null)}
          onRefresh={() => loadDetail(openPo.poNumber, true)}
          onSaved={applyDetail}
        />
      )}

      {exportChooser && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" onClick={() => !exportingLines && setExportChooser(false)}>
          <div className="bg-white rounded-xl shadow-xl w-full max-w-sm p-5" onClick={(e) => e.stopPropagation()}>
            <p className="text-sm font-semibold text-slate-900">Export {filtered.length} PO{filtered.length === 1 ? "" : "s"}</p>
            <p className="text-xs text-slate-400 mt-0.5 mb-4">Choose the level of detail. Both respect your current filters.</p>
            <div className="space-y-2">
              <button
                onClick={exportGeneral}
                disabled={exportingLines}
                className="w-full text-left px-3 py-2.5 rounded-lg border border-slate-200 hover:border-indigo-300 hover:bg-indigo-50/50 disabled:opacity-50"
              >
                <p className="text-sm font-medium text-slate-800">General</p>
                <p className="text-[11px] text-slate-500">One row per PO — number, product, vendor, status, date, total.</p>
              </button>
              <button
                onClick={exportLines}
                disabled={exportingLines}
                className="w-full text-left px-3 py-2.5 rounded-lg border border-slate-200 hover:border-indigo-300 hover:bg-indigo-50/50 disabled:opacity-50"
              >
                <p className="text-sm font-medium text-slate-800">{exportingLines ? "Preparing…" : "Line-level detail"}</p>
                <p className="text-[11px] text-slate-500">One row per size/SKU — qty ordered &amp; received, unit price, line total.</p>
              </button>
            </div>
            <div className="mt-4 flex justify-end">
              <button onClick={() => setExportChooser(false)} disabled={exportingLines} className="text-xs px-3 py-1.5 rounded-md border border-slate-200 text-slate-600 hover:bg-slate-50 disabled:opacity-50">
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Header({ children }: { children?: React.ReactNode }) {
  return (
    <header className="h-14 bg-white border-b border-slate-200 flex items-center justify-between px-5 shrink-0">
      <div className="flex items-center gap-3">
        <span className="font-semibold text-sm text-slate-900">PO History</span>
        <span className="text-xs text-slate-400">live from ShipHero</span>
      </div>
      <div className="flex items-center gap-3">{children}</div>
    </header>
  );
}

function PoRow({
  po,
  zebra,
  onOpen,
  checked,
  onToggle,
  exFactory,
}: {
  po: PoSummary;
  zebra: boolean;
  onOpen: () => void;
  checked: boolean;
  onToggle: () => void;
  exFactory: string | null;
}) {
  return (
    <tr
      onClick={onOpen}
      className={`cursor-pointer group ${
        checked ? "bg-indigo-50/60" : zebra ? "bg-slate-50/60 hover:bg-indigo-50/40" : "hover:bg-indigo-50/40"
      }`}
    >
      <td
        className="px-4 py-2 border-b border-slate-100"
        onClick={(e) => {
          e.stopPropagation();
          onToggle();
        }}
      >
        <input type="checkbox" checked={checked} readOnly className="cursor-pointer" />
      </td>
      <td className="px-4 py-2 border-b border-slate-100 font-mono text-xs font-medium text-slate-700">{po.poNumber}</td>
      <td className="px-4 py-2 border-b border-slate-100 text-[13px] text-slate-700">
        {po.products.length === 0 ? (
          <span className="text-slate-300">—</span>
        ) : po.products.length === 1 ? (
          po.products[0]
        ) : (
          <span title={po.products.join(", ")}>
            {po.products[0]} <span className="text-slate-400">+{po.products.length - 1} more</span>
          </span>
        )}
      </td>
      <td className="px-4 py-2 border-b border-slate-100 text-[13px] text-slate-600">{po.vendorName ?? "—"}</td>
      <td className="px-4 py-2 border-b border-slate-100">
        <span className={`px-1.5 py-0.5 rounded text-xs ${statusClass(po.status)}`}>{po.status || "—"}</span>
      </td>
      <td
        className="px-4 py-2 border-b border-slate-100 font-mono text-xs text-slate-500"
        title={exFactory ? `Ex-factory ${ukDate(exFactory)}` : undefined}
      >
        {po.poDate?.slice(0, 10) ?? "—"}
        {exFactory && <span className="block text-[10px] text-slate-400">ex-fac {ukDate(exFactory)}</span>}
      </td>
      <td className="px-4 py-2 border-b border-slate-100 text-right font-mono text-xs">{po.totalPrice ?? "—"}</td>
    </tr>
  );
}

function PoDetailModal({
  po,
  detail,
  statuses,
  sizeMap,
  shipheroConnected,
  onClose,
  onRefresh,
  onSaved,
}: {
  po: PoSummary;
  detail: PoDetail | "loading" | { error: string } | undefined;
  statuses: string[];
  sizeMap: SizeMap;
  shipheroConnected: boolean;
  onClose: () => void;
  onRefresh: () => void;
  onSaved: (detail: PoDetail) => void;
}) {
  const loaded = detail && detail !== "loading" && !("error" in detail) ? (detail as PoDetail) : null;

  const [editMode, setEditMode] = useState(false);
  const [editStatus, setEditStatus] = useState(po.status);
  const [editDate, setEditDate] = useState(po.poDate?.slice(0, 10) ?? "");
  const [lineEdits, setLineEdits] = useState<Record<string, { quantity?: string; price?: string }>>({});
  const [confirm, setConfirm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Reset edit state when the PO (or its saved values) change.
  useEffect(() => {
    setEditMode(false);
    setEditStatus(po.status);
    setEditDate(po.poDate?.slice(0, 10) ?? "");
    setLineEdits({});
    setConfirm(false);
    setSaveErr(null);
  }, [po.poNumber, po.status, po.poDate]);

  function cancelEdit() {
    setEditMode(false);
    setConfirm(false);
    setLineEdits({});
    setEditStatus(po.status);
    setEditDate(po.poDate?.slice(0, 10) ?? "");
    setSaveErr(null);
  }

  const origDate = po.poDate?.slice(0, 10) ?? "";
  const statusDirty = editStatus !== po.status;
  const dateDirty = editDate !== origDate;
  const lineChanged = (l: PoLineDetail) => {
    const e = lineEdits[l.sku];
    if (!e) return false;
    return (e.quantity != null && e.quantity !== String(l.quantity)) || (e.price != null && e.price !== l.price);
  };
  const lineDirty = loaded ? loaded.lines.some(lineChanged) : false;
  const dirty = statusDirty || dateDirty || lineDirty;

  function buildPatch() {
    const patch: Record<string, unknown> = {};
    if (statusDirty) patch.status = editStatus;
    if (dateDirty) patch.poDate = editDate || null;
    if (lineDirty && loaded) {
      patch.lines = loaded.lines.filter(lineChanged).map((l) => {
        const e = lineEdits[l.sku];
        return {
          sku: l.sku,
          ...(e.quantity != null && e.quantity !== String(l.quantity) ? { quantity: Number(e.quantity) } : {}),
          ...(e.price != null && e.price !== l.price ? { price: e.price } : {}),
        };
      });
    }
    return patch;
  }

  async function save() {
    setSaving(true);
    setSaveErr(null);
    try {
      const res = await fetch("/api/po/edit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ poNumber: po.poNumber, patch: buildPatch() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Save failed.");
      onSaved(data.detail); // updates po + detail → effect resets edit state
    } catch (e) {
      setSaveErr(e instanceof Error ? e.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  }

  const getQty = (l: PoLineDetail) => lineEdits[l.sku]?.quantity ?? String(l.quantity);
  const getPrice = (l: PoLineDetail) => lineEdits[l.sku]?.price ?? l.price;
  const setLine = (sku: string, field: "quantity" | "price", value: string) =>
    setLineEdits((m) => ({ ...m, [sku]: { ...m[sku], [field]: value } }));

  const pct = loaded && loaded.unitsOrdered ? Math.round((loaded.unitsReceived / loaded.unitsOrdered) * 100) : 0;

  // Display lines small→large by size (sizeMap.order); unknown/bracket sizes sink to the end.
  // Display-only — edits/save still work off loaded.lines (keyed by SKU).
  const sizeRank = (sku: string) => {
    const i = sizeMap.order.indexOf(deriveSizeFromSku(sku, sizeMap));
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  const orderedLines = loaded ? [...loaded.lines].sort((a, b) => sizeRank(a.sku) - sizeRank(b.sku)) : [];

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

        {/* meta — read-only, or editable in edit mode */}
        <div className="px-5 py-3 border-b border-slate-100 grid grid-cols-2 md:grid-cols-4 gap-4 text-xs items-end">
          <div>
            <p className="text-[10px] uppercase tracking-wide text-slate-400 mb-1">Status</p>
            {editMode ? (
              <select
                value={editStatus}
                onChange={(e) => setEditStatus(e.target.value)}
                className={`w-full px-2 py-1.5 border rounded bg-white text-sm ${statusDirty ? "border-indigo-400" : "border-slate-200"}`}
              >
                {!statuses.includes(editStatus) && <option value={editStatus}>{editStatus || "—"}</option>}
                {statuses.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            ) : (
              <span className={`inline-block px-1.5 py-0.5 rounded text-xs ${statusClass(po.status)}`}>{po.status || "—"}</span>
            )}
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wide text-slate-400 mb-1">Expected date</p>
            {editMode ? (
              <input
                type="date"
                value={editDate}
                onChange={(e) => setEditDate(e.target.value)}
                className={`w-full px-2 py-1.5 border rounded text-sm ${dateDirty ? "border-indigo-400" : "border-slate-200"}`}
              />
            ) : (
              <p className="text-slate-700 font-medium pt-1 font-mono">{po.poDate?.slice(0, 10) ?? "—"}</p>
            )}
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
          {!detail || detail === "loading" ? (
            <p className="text-xs text-slate-400">Loading line items…</p>
          ) : "error" in detail ? (
            <div className="flex items-center gap-3">
              <p className="text-xs text-rose-600">{detail.error}</p>
              <button onClick={onRefresh} className="text-xs px-2 py-1 rounded border border-slate-200 text-slate-600 hover:bg-slate-50">Retry</button>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-3 mb-3">
                <span className="text-xs font-semibold text-slate-700">
                  {loaded!.unitsReceived.toLocaleString()} / {loaded!.unitsOrdered.toLocaleString()} units received
                </span>
                <div className="flex-1 h-2 bg-slate-200 rounded-full overflow-hidden">
                  <div className={`h-full ${pct >= 100 ? "bg-emerald-500" : pct > 0 ? "bg-indigo-500" : "bg-slate-300"}`} style={{ width: `${Math.min(pct, 100)}%` }} />
                </div>
                <span className="text-xs font-medium text-slate-500 tabular-nums w-9 text-right">{pct}%</span>
              </div>

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
                    const edited = lineChanged(l);
                    return (
                      <tr key={l.sku + i} className="border-b border-slate-100 last:border-0">
                        <td className="py-1 pr-3 font-mono font-semibold text-slate-700 whitespace-nowrap">{deriveSizeFromSku(l.sku, sizeMap) || "—"}</td>
                        <td className="py-1 pr-3 font-mono text-slate-400 whitespace-nowrap">{l.sku}</td>
                        <td className="py-1 px-2 text-right font-mono tabular-nums">
                          {editMode ? (
                            <input
                              value={getQty(l)}
                              onChange={(e) => setLine(l.sku, "quantity", e.target.value)}
                              className={`w-14 px-1 py-0.5 text-right font-mono text-xs rounded outline-none hover:bg-slate-50 focus:bg-white focus:ring-1 focus:ring-indigo-300 ${edited && getQty(l) !== String(l.quantity) ? "ring-1 ring-indigo-300 bg-indigo-50/40" : ""}`}
                            />
                          ) : (
                            l.quantity
                          )}
                        </td>
                        <td className="py-1 px-2 text-right font-mono tabular-nums">
                          {editMode ? (
                            <input
                              value={getPrice(l)}
                              onChange={(e) => setLine(l.sku, "price", e.target.value)}
                              className={`w-16 px-1 py-0.5 text-right font-mono text-xs rounded outline-none hover:bg-slate-50 focus:bg-white focus:ring-1 focus:ring-indigo-300 ${edited && getPrice(l) !== l.price ? "ring-1 ring-indigo-300 bg-indigo-50/40" : ""}`}
                            />
                          ) : (
                            fmtPrice(l.price)
                          )}
                        </td>
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
              {editMode && (
                <p className="text-[10px] text-slate-400 mt-2">Editing qty/price updates the existing SKU lines in ShipHero. Received quantities are read-only.</p>
              )}
            </>
          )}
        </div>

        {/* footer */}
        <div className="px-5 py-3 border-t border-slate-200 flex items-center justify-between gap-3">
          <div className="text-[11px] min-w-0">
            {saveErr ? (
              <span className="text-rose-600">{saveErr}</span>
            ) : editMode && dirty ? (
              <span className="text-indigo-600">Unsaved changes</span>
            ) : null}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {!editMode ? (
              <>
                <button onClick={onRefresh} className="text-xs px-3 py-1.5 rounded-md border border-slate-200 text-slate-600 hover:bg-slate-50" title="Re-pull from ShipHero">
                  Refresh
                </button>
                <button
                  onClick={() => setEditMode(true)}
                  disabled={!shipheroConnected || !loaded}
                  title={!shipheroConnected ? "Connect ShipHero to edit" : ""}
                  className="text-xs px-3 py-1.5 rounded-md border border-slate-200 text-slate-700 hover:bg-slate-50 disabled:opacity-40 flex items-center gap-1.5"
                >
                  <svg width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                    <path d="M18.5 2.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4z" />
                  </svg>
                  Edit
                </button>
                <button onClick={onClose} className="text-xs px-4 py-1.5 rounded-md bg-slate-900 text-white hover:bg-slate-800">Close</button>
              </>
            ) : !confirm ? (
              <>
                <button onClick={cancelEdit} className="text-xs px-3 py-1.5 rounded-md border border-slate-200 text-slate-600 hover:bg-slate-50">Cancel</button>
                <button
                  onClick={() => setConfirm(true)}
                  disabled={!dirty}
                  className="text-xs font-medium px-4 py-1.5 rounded-md bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-40"
                >
                  Save to ShipHero
                </button>
              </>
            ) : (
              <>
                <span className="text-[11px] text-slate-500">Write to ShipHero?</span>
                <button onClick={() => setConfirm(false)} className="text-xs px-3 py-1.5 rounded-md border border-slate-200 text-slate-600">Back</button>
                <button
                  onClick={save}
                  disabled={saving}
                  className="text-xs font-medium px-4 py-1.5 rounded-md bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50"
                >
                  {saving ? "Saving…" : "Confirm & save"}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---- Paste-revisions modal (bulk date amend from a supplier's sheet) ----
// Accepts pasted rows of: PO number + 1–3 dates. One date = delivery; two =
// ex-factory then delivery; three = order sent, ex-factory, delivery (the PO
// sheet's own column order). Shows an old→new diff before anything is applied.
function PasteRevisionsModal({
  pos,
  datesByPo,
  applying,
  onApply,
  onClose,
}: {
  pos: PoSummary[];
  datesByPo: Record<string, { orderSent: string | null; exFactory: string | null; delivery: string | null }>;
  applying: boolean;
  onApply: (changes: Array<{ poNumber: string; delivery?: string; exFactory?: string; orderSent?: string }>) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const byNumber = new Map(pos.map((p) => [p.poNumber.toUpperCase(), p]));

  interface ParsedRow {
    poNumber: string;
    known: boolean;
    orderSent?: string;
    exFactory?: string;
    delivery?: string;
    oldDelivery: string | null;
    oldExFactory: string | null;
  }

  const rows: ParsedRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    const cells = line.split(/[\t,;]/).map((c) => c.trim()).filter((c) => c !== "");
    if (cells.length < 2) continue;
    if (/po number|purchase order/i.test(cells[0])) continue; // header row
    const poNumber = cells[0];
    const dates = cells.slice(1).map((c) => normalizeSheetDate(c)).filter((d): d is string => d !== null);
    if (!dates.length) continue;
    const match = byNumber.get(poNumber.toUpperCase());
    const stored = match ? datesByPo[match.poNumber] : undefined;
    const row: ParsedRow = {
      poNumber: match?.poNumber ?? poNumber,
      known: Boolean(match),
      oldDelivery: stored?.delivery ?? match?.poDate?.slice(0, 10) ?? null,
      oldExFactory: stored?.exFactory ?? null,
    };
    if (dates.length === 1) row.delivery = dates[0];
    else if (dates.length === 2) [row.exFactory, row.delivery] = dates;
    else [row.orderSent, row.exFactory, row.delivery] = dates;
    rows.push(row);
  }
  const applicable = rows.filter((r) => r.known);
  const unknown = rows.filter((r) => !r.known);

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-3.5 border-b border-slate-200 flex items-center">
          <h3 className="text-sm font-semibold text-slate-900">Amend PO dates from a sheet</h3>
          <button onClick={onClose} className="ml-auto text-slate-400 hover:text-slate-600">✕</button>
        </div>
        <div className="p-5 overflow-y-auto flex flex-col gap-3">
          <p className="text-xs text-slate-500">
            Paste rows of <b>PO number + dates</b> (tab or comma separated, straight from Excel).
            One date = new delivery · two = ex-factory, delivery · three = order sent, ex-factory, delivery.
            UK dates (21/06/2026) are fine.
          </p>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={6}
            placeholder={"PO471\t10/06/2026\t21/06/2026\nPO472\t05/09/2026"}
            className="w-full border border-slate-200 rounded-md p-2.5 font-mono text-xs focus:ring-1 focus:ring-indigo-300 outline-none"
          />
          {unknown.length > 0 && (
            <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2">
              Not in the PO cache (will be skipped): {unknown.map((r) => r.poNumber).join(", ")}
            </p>
          )}
          {applicable.length > 0 && (
            <div className="border border-slate-200 rounded-md overflow-hidden">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-slate-50 text-left text-[10px] uppercase tracking-wide text-slate-400">
                    <th className="px-3 py-1.5 font-medium">PO</th>
                    <th className="px-3 py-1.5 font-medium">Delivery</th>
                    <th className="px-3 py-1.5 font-medium">Ex-factory</th>
                  </tr>
                </thead>
                <tbody>
                  {applicable.map((r) => (
                    <tr key={r.poNumber} className="border-t border-slate-100">
                      <td className="px-3 py-1.5 font-mono font-medium text-slate-700">{r.poNumber}</td>
                      <td className="px-3 py-1.5">
                        {r.delivery ? (
                          <>
                            <span className="text-slate-400">{r.oldDelivery ? ukDate(r.oldDelivery) : "—"}</span>
                            <span className="text-slate-300 mx-1.5">→</span>
                            <span className={`font-medium ${r.delivery === r.oldDelivery ? "text-slate-400" : "text-indigo-700"}`}>
                              {ukDate(r.delivery)}
                            </span>
                          </>
                        ) : (
                          <span className="text-slate-300">unchanged</span>
                        )}
                      </td>
                      <td className="px-3 py-1.5">
                        {r.exFactory ? (
                          <>
                            <span className="text-slate-400">{r.oldExFactory ? ukDate(r.oldExFactory) : "—"}</span>
                            <span className="text-slate-300 mx-1.5">→</span>
                            <span className="font-medium text-slate-700">{ukDate(r.exFactory)}</span>
                          </>
                        ) : (
                          <span className="text-slate-300">unchanged</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <div className="px-5 py-3.5 border-t border-slate-200 flex items-center gap-3">
          <span className="text-xs text-slate-500">
            {applicable.length} PO{applicable.length === 1 ? "" : "s"} will be updated
            {applicable.some((r) => r.delivery) ? " (delivery pushes to ShipHero's Expected Date)" : ""}
          </span>
          <button
            disabled={!applicable.length || applying}
            onClick={() =>
              onApply(
                applicable.map((r) => ({
                  poNumber: r.poNumber,
                  ...(r.delivery ? { delivery: r.delivery } : {}),
                  ...(r.exFactory ? { exFactory: r.exFactory } : {}),
                  ...(r.orderSent ? { orderSent: r.orderSent } : {}),
                })),
              )
            }
            className="ml-auto text-xs px-4 py-1.5 rounded-md bg-indigo-600 text-white font-medium disabled:opacity-40"
          >
            {applying ? "Applying…" : `Apply ${applicable.length ? `(${applicable.length})` : ""}`}
          </button>
        </div>
      </div>
    </div>
  );
}
