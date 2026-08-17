"use client";

// Returns — Swap RMA dashboard. Reads the local cache instantly; Sync pulls
// open + recent returns from ShipHero. All filtering/aggregation is client-side
// (deriveSummary) so period/filters re-render with zero API calls.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  deriveSummary,
  fmtMoney,
  isOpen,
  isFaultyItem,
  isFaultyRow,
  productKey,
  sizeOf,
  timeHM,
  dayLabel,
  type ReturnRow,
  type ReturnsSummary,
} from "@/lib/returns-types";

interface SyncMeta {
  syncedAt: string;
  rowCount: number;
  windowFrom: string;
}

type Period = { kind: "today" } | { kind: "days"; days: 7 | 14 | 30 | 90 } | { kind: "custom" };

const DAY_CHIPS: Array<{ days: 7 | 14 | 30 | 90; label: string }> = [
  { days: 7, label: "7d" },
  { days: 14, label: "14d" },
  { days: 30, label: "30d" },
  { days: 90, label: "90d" },
];

function localYmd(d: Date): string {
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mo}-${da}`;
}

export function ReturnsDashboard({ shipheroConnected }: { shipheroConnected: boolean }) {
  const [rows, setRows] = useState<ReturnRow[]>([]);
  const [meta, setMeta] = useState<SyncMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [period, setPeriod] = useState<Period>({ kind: "days", days: 30 });
  const [customFrom, setCustomFrom] = useState<string>(localYmd(new Date(Date.now() - 7 * 86_400_000)));
  const [customTo, setCustomTo] = useState<string>(localYmd(new Date()));
  const [hideLegacy, setHideLegacy] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [reasonFilter, setReasonFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [personFilter, setPersonFilter] = useState<string | null>(null);
  const [productFocus, setProductFocus] = useState<string | null>(null);
  const [focusQuery, setFocusQuery] = useState("");
  const [exportOpen, setExportOpen] = useState(false);
  const [exportFrom, setExportFrom] = useState("2026-07-14");
  const [exportTo, setExportTo] = useState(localYmd(new Date()));
  const [exportLegacy, setExportLegacy] = useState(true);
  const [exporting, setExporting] = useState(false);

  async function runExport() {
    setExporting(true);
    setError(null);
    try {
      const res = await fetch("/api/returns-hub/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: exportFrom, to: exportTo, includeLegacy: exportLegacy }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || "Export failed.");
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `returns-rollup_${exportFrom}_to_${exportTo}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
      setExportOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Export failed.");
    } finally {
      setExporting(false);
    }
  }

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/returns-hub/list");
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to load returns.");
      setRows(json.rows ?? []);
      setMeta(json.meta ?? null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load returns.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function sync() {
    setSyncing(true);
    setError(null);
    try {
      const res = await fetch("/api/returns-hub/sync", { method: "POST" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Sync failed.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sync failed.");
    } finally {
      setSyncing(false);
    }
  }

  const legacyCount = useMemo(() => rows.filter((r) => !r.isV2).length, [rows]);

  // Window bounds as local-naive ISO strings (ShipHero timestamps are naive too).
  const [fromIso, toIso] = useMemo((): [string, string] => {
    if (period.kind === "today") return [`${localYmd(new Date())}T00:00:00`, "9999-12-31T23:59:59"];
    if (period.kind === "custom") {
      const f = customFrom || localYmd(new Date());
      const t = customTo || localYmd(new Date());
      return [`${f}T00:00:00`, `${t}T23:59:59`];
    }
    const from = new Date(Date.now() - period.days * 86_400_000);
    return [`${localYmd(from)}T00:00:00`, "9999-12-31T23:59:59"];
  }, [period, customFrom, customTo]);

  const baseRows = useMemo(() => rows.filter((r) => !hideLegacy || r.isV2), [rows, hideLegacy]);

  // Feed shows returns OPENED in the window; summary handles its own windowing
  // (opened metrics by createdAt, processing metrics by event time).
  const windowRows = useMemo(
    () => baseRows.filter((r) => r.createdAt >= fromIso && r.createdAt <= toIso),
    [baseRows, fromIso, toIso],
  );

  const summary: ReturnsSummary = useMemo(
    () => deriveSummary(baseRows, fromIso, toIso, new Date().toISOString()),
    [baseRows, fromIso, toIso],
  );

  // ---- product roll-up (all sizes of one product, current window) ----
  const productNames = useMemo(() => {
    const s = new Set<string>();
    for (const r of baseRows) for (const it of r.items) s.add(productKey(it.productName || it.sku));
    return [...s].sort();
  }, [baseRows]);

  /** Resolve typed text to a product key: exact name, SKU, or single fuzzy hit. */
  function resolveFocus(q: string): string | null {
    const t = q.trim();
    if (!t) return null;
    if (productNames.includes(t)) return t;
    if (/^WD-\d/i.test(t)) {
      for (const r of baseRows) {
        const hit = r.items.find((it) => it.sku.toUpperCase().startsWith(t.toUpperCase()));
        if (hit) return productKey(hit.productName || hit.sku);
      }
      return null;
    }
    const matches = productNames.filter((n) => n.toLowerCase().includes(t.toLowerCase()));
    return matches.length >= 1 ? matches[0] : null;
  }

  const focusData = useMemo(() => {
    if (!productFocus) return null;
    const reasons = new Map<string, number>();
    const sizes = new Map<string, { units: number; faulty: number }>();
    let units = 0, faulty = 0, value = 0, returnsCount = 0;
    const rowIds = new Set<string>();
    for (const r of windowRows) {
      let inReturn = false;
      for (const it of r.items) {
        if (productKey(it.productName || it.sku) !== productFocus) continue;
        inReturn = true;
        units += it.quantity;
        value += it.quantity * it.price * (r.exVatFactor ?? 1 / 1.2);
        const reason = (it.reason || r.reason || "Other").trim() || "Other";
        reasons.set(reason, (reasons.get(reason) ?? 0) + it.quantity);
        const size = sizeOf(it.productName || "");
        const s = sizes.get(size) ?? { units: 0, faulty: 0 };
        s.units += it.quantity;
        if (isFaultyItem(it, r.reason)) { s.faulty += it.quantity; faulty += it.quantity; }
        sizes.set(size, s);
      }
      if (inReturn) { returnsCount++; rowIds.add(r.id); }
    }
    const SIZE_ORDER = ["XXS", "XS", "S", "M", "L", "XL", "XXL", "XS-S", "S-M", "M-L", "L-XL", "ONE SIZE", "?"];
    return {
      units, faulty, value, returnsCount, rowIds,
      reasons: [...reasons.entries()].map(([key, n]) => ({ key, units: n })).sort((a, b) => b.units - a.units),
      sizes: [...sizes.entries()]
        .map(([key, v]) => ({ key, ...v }))
        .sort((a, b) => SIZE_ORDER.indexOf(a.key) - SIZE_ORDER.indexOf(b.key)),
    };
  }, [productFocus, windowRows]);

  const personReturnIds = useMemo(() => {
    if (!personFilter) return null;
    const p = summary.people.find((x) => x.name === personFilter);
    return p ? new Set(p.returnIds) : null;
  }, [personFilter, summary.people]);

  // Person filter looks across ALL rows (their processed returns may have been
  // opened before the window); other filters apply to window rows.
  const feedRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const source = personReturnIds ? baseRows.filter((r) => personReturnIds.has(r.id)) : windowRows;
    return source.filter((r) => {
      if (focusData && !focusData.rowIds.has(r.id)) return false;
      if (statusFilter === "open" && !isOpen(r)) return false;
      if (statusFilter === "complete" && isOpen(r)) return false;
      if (statusFilter === "faulty" && !isFaultyRow(r)) return false;
      if (reasonFilter !== "all") {
        const reasons = r.items.map((i) => (i.reason || r.reason || "Other").trim());
        if (!reasons.some((x) => x === reasonFilter)) return false;
      }
      if (q) {
        const hay = `${r.orderNumber} ${r.items.map((i) => `${i.sku} ${i.productName}`).join(" ")}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [windowRows, baseRows, personReturnIds, focusData, statusFilter, reasonFilter, search]);

  const maxReason = summary.reasons[0]?.units ?? 1;
  const maxProduct = summary.topProducts[0]?.units ?? 1;
  const maxPipeline = Math.max(...summary.pipeline.map((p) => p.count), 1);
  const outcomeTotal = summary.outcomes.reduce((a, o) => a + o.units, 0) || 1;
  const maxPersonActions = summary.people[0]?.actions ?? 1;

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header bar */}
      <div className="h-14 shrink-0 border-b border-slate-200 bg-white flex items-center gap-2 px-4 lg:px-6">
        <h1 className="text-[15px] font-semibold text-slate-900 mr-2">Returns</h1>
        <button
          onClick={() => setPeriod({ kind: "today" })}
          className={`text-xs px-2.5 py-1 rounded-md border ${
            period.kind === "today"
              ? "bg-indigo-50 border-indigo-200 text-indigo-700 font-medium"
              : "border-slate-200 text-slate-500 hover:bg-slate-50"
          }`}
        >
          Today
        </button>
        {DAY_CHIPS.map((p) => (
          <button
            key={p.days}
            onClick={() => setPeriod({ kind: "days", days: p.days })}
            className={`text-xs px-2.5 py-1 rounded-md border ${
              period.kind === "days" && period.days === p.days
                ? "bg-indigo-50 border-indigo-200 text-indigo-700 font-medium"
                : "border-slate-200 text-slate-500 hover:bg-slate-50"
            }`}
          >
            {p.label}
          </button>
        ))}
        <button
          onClick={() => setPeriod({ kind: "custom" })}
          className={`text-xs px-2.5 py-1 rounded-md border ${
            period.kind === "custom"
              ? "bg-indigo-50 border-indigo-200 text-indigo-700 font-medium"
              : "border-slate-200 text-slate-500 hover:bg-slate-50"
          }`}
        >
          Custom
        </button>
        {period.kind === "custom" && (
          <span className="flex items-center gap-1.5 text-xs text-slate-500">
            <input
              type="date"
              value={customFrom}
              max={customTo}
              onChange={(e) => setCustomFrom(e.target.value)}
              className="border border-slate-200 rounded-md px-2 py-[3px] bg-white text-slate-700"
            />
            →
            <input
              type="date"
              value={customTo}
              min={customFrom}
              max={localYmd(new Date())}
              onChange={(e) => setCustomTo(e.target.value)}
              className="border border-slate-200 rounded-md px-2 py-[3px] bg-white text-slate-700"
            />
          </span>
        )}
        <button
          onClick={() => setHideLegacy((v) => !v)}
          title="Swap v1-era RMAs are never processed in ShipHero — hidden by default"
          className={`text-xs px-2.5 py-1 rounded-md border ${
            hideLegacy
              ? "bg-indigo-50 border-indigo-200 text-indigo-700 font-medium"
              : "border-slate-200 text-slate-500 hover:bg-slate-50"
          }`}
        >
          {hideLegacy ? "Hiding" : "Showing"} v1 legacy · {legacyCount}
        </button>
        <div className="flex-1" />
        {meta && (
          <span className="hidden md:block text-[11px] text-slate-400 mr-2">
            Synced {new Date(meta.syncedAt).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })} · {meta.rowCount} cached
          </span>
        )}
        <button
          onClick={sync}
          disabled={syncing || !shipheroConnected}
          className="text-[13px] font-medium bg-indigo-600 text-white rounded-md px-3.5 py-1.5 hover:bg-indigo-700 disabled:opacity-50"
        >
          {syncing ? "Syncing…" : "Sync"}
        </button>
      </div>

      <div className="flex-1 overflow-auto bg-slate-50">
        <div className="p-4 lg:p-6 flex flex-col gap-4">
          {error && (
            <div className="rounded-lg border border-rose-200 bg-rose-50 text-rose-700 text-sm px-4 py-3">
              {error}
            </div>
          )}
          {!shipheroConnected && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 text-amber-700 text-sm px-4 py-3">
              ShipHero isn&apos;t connected — showing cached data only.
            </div>
          )}
          {!loading && rows.length === 0 && (
            <div className="rounded-lg border border-slate-200 bg-white text-slate-500 text-sm px-4 py-8 text-center">
              No returns cached yet — hit <b>Sync</b> to pull them from ShipHero (first sync backfills ~a month and takes a minute or two).
            </div>
          )}

          {/* KPI row */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7 gap-3">
            <Kpi v={String(summary.total)} label="Returns opened" sub={`${summary.unitsExpected} units expected`} />
            <Kpi
              v={String(summary.processedReturns)}
              label="Returns processed"
              sub={`${summary.unitsReceived} units received`}
            />
            <Kpi
              v={summary.unitsReceived ? `${Math.round(summary.restockRate * 100)}%` : "—"}
              label="Restock rate"
              sub={`${summary.unitsRestocked} restocked`}
            />
            <Kpi
              v={fmtMoney(summary.valueProcessed)}
              label="Value processed"
              sub={`${fmtMoney(summary.valueOpen)} still coming back · ex tax & discounts`}
            />
            <Kpi
              v={summary.avgTurnaroundDays != null ? `${summary.avgTurnaroundDays.toFixed(1)}d` : "—"}
              label="Avg turnaround"
              sub="opened → received"
            />
            <Kpi
              v={summary.total ? `${Math.round((summary.exchanges / summary.total) * 100)}%` : "—"}
              label="Exchanges"
              sub={`${summary.exchanges} exchange orders`}
            />
            <Kpi v={String(summary.faulty)} label="Faulty units" red sub={summary.unitsExpected ? `${((summary.faulty / summary.unitsExpected) * 100).toFixed(1)}% of units` : ""} />
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
            {/* Reasons */}
            <Panel title="Return reasons" note="units">
              {summary.reasons.slice(0, 8).map((r) => {
                const bad = /fault|damag/i.test(r.key);
                return (
                  <div key={r.key} className="grid grid-cols-[140px_1fr_44px] gap-2.5 items-center mb-2 text-[13px]">
                    <span className={`truncate ${bad ? "text-rose-600 font-medium" : "text-slate-600"}`}>
                      {bad ? "⚠ " : ""}{r.key}
                    </span>
                    <span className="h-3.5 bg-slate-100 rounded overflow-hidden">
                      <span
                        className={`block h-full rounded-r ${bad ? "bg-rose-500" : "bg-indigo-600"}`}
                        style={{ width: `${(r.units / maxReason) * 100}%` }}
                      />
                    </span>
                    <span className="text-right tabular-nums text-slate-900">{r.units}</span>
                  </div>
                );
              })}
              {summary.reasons.length === 0 && <Empty />}
            </Panel>

            {/* Outcomes + pipeline */}
            <Panel title="Outcomes & pipeline">
              <div className="flex h-5 rounded-md overflow-hidden mb-2">
                {summary.outcomes.map((o, i) => (
                  <div
                    key={o.key}
                    title={`${o.key} · ${o.units}`}
                    style={{
                      width: `${(o.units / outcomeTotal) * 100}%`,
                      background: i === 0 ? "#4f46e5" : "#0d9488",
                    }}
                    className={i > 0 ? "border-l-2 border-white" : ""}
                  />
                ))}
              </div>
              <div className="flex gap-4 text-xs text-slate-500 mb-4">
                {summary.outcomes.map((o, i) => (
                  <span key={o.key}>
                    <span
                      className="inline-block w-2 h-2 rounded-sm mr-1.5 align-middle"
                      style={{ background: i === 0 ? "#4f46e5" : "#0d9488" }}
                    />
                    {o.key} · <b className="tabular-nums text-slate-700">{o.units}</b>
                  </span>
                ))}
              </div>
              <p className="text-[11px] uppercase tracking-wider text-slate-400 mb-2">Open returns by age — all open right now, any window</p>
              {summary.pipeline.map((p, i) => (
                <div key={p.bucket} className="grid grid-cols-[90px_1fr_36px] gap-2.5 items-center mb-2 text-xs">
                  <span className="text-slate-500">{p.bucket}</span>
                  <span className="h-3.5 bg-slate-100 rounded overflow-hidden">
                    <span
                      className="block h-full rounded-r"
                      style={{
                        width: `${(p.count / maxPipeline) * 100}%`,
                        background: ["#c7d2fe", "#818cf8", "#4f46e5"][i],
                      }}
                    />
                  </span>
                  <span className="text-right tabular-nums text-[13px] text-slate-900">{p.count}</span>
                </div>
              ))}
              <p className="text-[11px] text-slate-400 mt-2">
                {summary.pipeline.reduce((a, p) => a + p.count, 0)} returns in the post or awaiting the desk.
              </p>
            </Panel>

            {/* Top returned products */}
            <Panel title="Top returned products" note="units in window">
              {summary.topProducts.map((p) => (
                <div
                  key={p.key}
                  onClick={() => { setProductFocus(p.key); setFocusQuery(p.key); }}
                  title="Click to roll up this product"
                  className="grid grid-cols-[1fr_70px_40px] gap-2.5 items-center mb-2 text-[13px] cursor-pointer hover:bg-slate-50 rounded px-1 -mx-1"
                >
                  <span className="truncate text-slate-600">{p.key}</span>
                  <span className="h-2 bg-slate-100 rounded overflow-hidden self-center">
                    <span
                      className="block h-full bg-indigo-600 rounded-r"
                      style={{ width: `${(p.units / maxProduct) * 100}%` }}
                    />
                  </span>
                  <span className="text-right tabular-nums text-slate-900">{p.units}</span>
                </div>
              ))}
              {summary.topProducts.length === 0 && <Empty />}
              <p className="text-[11px] text-slate-400 mt-2">
                High units + &ldquo;does not fit&rdquo; = sizing problem; + faulty = supplier claim.
              </p>
            </Panel>
          </div>

          {/* Processing */}
          <Panel
            title="Processing"
            note="work done IN this window (whenever the return was opened) — rate = actions ÷ hours with at least one action"
          >
            {summary.people.length === 0 ? (
              <p className="text-sm text-slate-400 py-3">
                No processing activity in this window yet — this fills up as the desk receives returns against RMAs (Swap v2 flow).
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-[13px]">
                  <thead>
                    <tr className="text-[11px] uppercase tracking-wider text-slate-400 border-b border-slate-200">
                      <th className="text-left font-medium pb-2 pr-3">Person</th>
                      <th className="text-right font-medium pb-2 px-3">Returns</th>
                      <th className="text-right font-medium pb-2 px-3">Actions</th>
                      <th className="text-right font-medium pb-2 px-3">Active hrs</th>
                      <th className="text-right font-medium pb-2 px-3">Per hour</th>
                      <th className="text-left font-medium pb-2 pl-4">Tempo (by hour of day)</th>
                      <th className="text-left font-medium pb-2 pl-4 w-1/5"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.people.map((p) => {
                      const maxHour = Math.max(...p.byHour, 1);
                      return (
                        <tr
                          key={p.name}
                          onClick={() => setPersonFilter(personFilter === p.name ? null : p.name)}
                          title="Click to filter the feed to this person's returns"
                          className={`border-b border-slate-100 last:border-0 cursor-pointer hover:bg-slate-50 ${
                            personFilter === p.name ? "bg-indigo-50/60" : ""
                          }`}
                        >
                          <td className="py-2 pr-3 whitespace-nowrap">
                            <span className="inline-flex w-6 h-6 rounded-full bg-indigo-50 text-indigo-600 text-[10px] font-semibold items-center justify-center mr-2 align-middle">
                              {p.initials}
                            </span>
                            {p.name}
                          </td>
                          <td className="text-right tabular-nums px-3">{p.returnsTouched}</td>
                          <td className="text-right tabular-nums px-3">{p.actions}</td>
                          <td className="text-right tabular-nums px-3">{p.activeHours}</td>
                          <td className="text-right tabular-nums px-3 font-medium">{p.perHour.toFixed(1)}</td>
                          <td className="pl-4">
                            <span className="inline-flex items-end gap-[2px] h-5">
                              {p.byHour.slice(6, 19).map((v, i) => (
                                <span
                                  key={i}
                                  title={`${String(i + 6).padStart(2, "0")}:00 · ${v}`}
                                  className="w-[7px] rounded-[1px]"
                                  style={{
                                    height: `${v ? Math.max(15, (v / maxHour) * 100) : 8}%`,
                                    background: v ? "#4f46e5" : "#e2e8f0",
                                  }}
                                />
                              ))}
                            </span>
                          </td>
                          <td className="pl-4">
                            <span
                              className="inline-block h-2 bg-indigo-600 rounded align-middle"
                              style={{ width: `${(p.actions / maxPersonActions) * 100}%` }}
                            />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>

          {/* Product roll-up */}
          <Panel
            title="Product roll-up"
            note="all sizes of one product — why is it coming back?"
            right={
              <div className="flex items-center gap-2">
                <input
                  list="product-focus-list"
                  value={focusQuery}
                  onChange={(e) => {
                    setFocusQuery(e.target.value);
                    const hit = resolveFocus(e.target.value);
                    if (hit && productNames.includes(e.target.value)) setProductFocus(hit);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      const hit = resolveFocus(focusQuery);
                      if (hit) { setProductFocus(hit); setFocusQuery(hit); }
                    }
                  }}
                  placeholder="Search product or SKU…"
                  className="text-xs border border-slate-200 rounded-md px-2.5 py-1 w-64 bg-white"
                />
                <datalist id="product-focus-list">
                  {productNames.map((n) => <option key={n} value={n} />)}
                </datalist>
                {productFocus && (
                  <button
                    onClick={() => { setProductFocus(null); setFocusQuery(""); }}
                    className="text-xs px-2.5 py-1 rounded-md bg-indigo-50 border border-indigo-200 text-indigo-700 font-medium"
                  >
                    Clear ✕
                  </button>
                )}
                <button
                  onClick={() => setExportOpen(true)}
                  className="text-xs px-2.5 py-1 rounded-md border border-slate-200 text-slate-600 hover:bg-slate-50 flex items-center gap-1.5"
                  title="Export every product's roll-up (reasons × sizes) to Excel"
                >
                  <svg width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />
                  </svg>
                  Export all
                </button>
              </div>
            }
          >
            {!productFocus || !focusData ? (
              <p className="text-sm text-slate-400 py-2">
                Pick a product — search above, or click any product in the panels below. The feed filters to it too.
              </p>
            ) : (
              <>
                <div className="flex items-baseline gap-4 flex-wrap mb-4">
                  <h3 className="text-[15px] font-semibold text-slate-900">{productFocus}</h3>
                  <span className="text-[13px] text-slate-500 tabular-nums">
                    {focusData.returnsCount} returns · {focusData.units} units · {fmtMoney(focusData.value)} ·{" "}
                    <span className={focusData.faulty ? "text-rose-600 font-medium" : ""}>{focusData.faulty} faulty</span>
                  </span>
                </div>
                <div className="grid md:grid-cols-2 gap-6">
                  <div>
                    <p className="text-[11px] uppercase tracking-wider text-slate-400 mb-2">Why it comes back</p>
                    {(() => {
                      const max = focusData.reasons[0]?.units ?? 1;
                      return focusData.reasons.map((r) => {
                        const bad = /fault|damag/i.test(r.key);
                        return (
                          <div key={r.key} className="grid grid-cols-[150px_1fr_40px] gap-2.5 items-center mb-2 text-[13px]">
                            <span className={`truncate ${bad ? "text-rose-600 font-medium" : "text-slate-600"}`}>{r.key}</span>
                            <span className="h-3 bg-slate-100 rounded overflow-hidden">
                              <span
                                className={`block h-full rounded-r ${bad ? "bg-rose-500" : "bg-indigo-600"}`}
                                style={{ width: `${(r.units / max) * 100}%` }}
                              />
                            </span>
                            <span className="text-right tabular-nums text-slate-900">{r.units}</span>
                          </div>
                        );
                      });
                    })()}
                  </div>
                  <div>
                    <p className="text-[11px] uppercase tracking-wider text-slate-400 mb-2">By size</p>
                    {(() => {
                      const max = Math.max(...focusData.sizes.map((s) => s.units), 1);
                      return focusData.sizes.map((s) => (
                        <div key={s.key} className="grid grid-cols-[70px_1fr_110px] gap-2.5 items-center mb-2 text-[13px]">
                          <span className="text-slate-600">{s.key}</span>
                          <span className="h-3 bg-slate-100 rounded overflow-hidden">
                            <span className="block h-full bg-indigo-600 rounded-r" style={{ width: `${(s.units / max) * 100}%` }} />
                          </span>
                          <span className="text-right tabular-nums text-slate-900 whitespace-nowrap">
                            {s.units}{s.faulty > 0 && <span className="text-rose-600"> ({s.faulty} faulty)</span>}
                          </span>
                        </div>
                      ));
                    })()}
                    <p className="text-[11px] text-slate-400 mt-2">
                      A single size dominating &ldquo;does not fit&rdquo; = grading issue on that size.
                    </p>
                  </div>
                </div>
              </>
            )}
          </Panel>

          {/* Faulty returns */}
          <Panel
            title="Faulty returns"
            note="customer-reported faulty or desk-assessed damaged, in window"
            right={
              <button
                onClick={() => setStatusFilter(statusFilter === "faulty" ? "all" : "faulty")}
                className={`text-xs px-2.5 py-1 rounded-md border ${
                  statusFilter === "faulty"
                    ? "bg-rose-50 border-rose-200 text-rose-700 font-medium"
                    : "border-slate-200 text-slate-500 hover:bg-slate-50"
                }`}
              >
                {statusFilter === "faulty" ? "Showing in feed ✕" : "Show in feed"}
              </button>
            }
          >
            {summary.faultyProducts.length === 0 ? (
              <Empty />
            ) : (
              <div className="grid md:grid-cols-2 gap-6">
                <div>
                  <p className="text-[11px] uppercase tracking-wider text-slate-400 mb-2">By product</p>
                  {(() => {
                    const max = summary.faultyProducts[0]?.units ?? 1;
                    return summary.faultyProducts.map((p) => {
                      const pct = Math.round((p.units / Math.max(1, p.totalReturned)) * 100);
                      return (
                        <div
                          key={p.key}
                          onClick={() => { setProductFocus(p.key); setFocusQuery(p.key); }}
                          title="Click to roll up this product"
                          className="grid grid-cols-[1fr_70px_170px] gap-2.5 items-center mb-2 text-[13px] cursor-pointer hover:bg-slate-50 rounded px-1 -mx-1"
                        >
                          <span className="truncate text-slate-600">{p.key}</span>
                          <span className="h-3 bg-slate-100 rounded overflow-hidden self-center">
                            <span
                              className="block h-full bg-rose-500 rounded-r"
                              style={{ width: `${(p.units / max) * 100}%` }}
                            />
                          </span>
                          <span className="text-right tabular-nums whitespace-nowrap">
                            <b className="text-rose-600">{p.units} faulty</b>
                            <span className="text-slate-500"> of {p.totalReturned} returned</span>
                            <span className={`ml-1.5 text-[11px] font-medium ${pct >= 50 ? "text-rose-600" : "text-slate-400"}`}>({pct}%)</span>
                          </span>
                        </div>
                      );
                    });
                  })()}
                  <p className="text-[11px] text-slate-400 mt-2">
                    &ldquo;2 faulty of 10 returned&rdquo; = this product came back 10 times this period, 2 of those
                    for a fault. A high % on decent volume = likely production problem.
                  </p>
                </div>
                <div>
                  <p className="text-[11px] uppercase tracking-wider text-slate-400 mb-2">The items</p>
                  <div className="max-h-64 overflow-y-auto pr-1">
                    {windowRows
                      .flatMap((r) =>
                        r.items
                          .filter((it) => isFaultyItem(it, r.reason))
                          .map((it) => ({ r, it })),
                      )
                      .sort((a, b) => b.r.createdAt.localeCompare(a.r.createdAt))
                      .slice(0, 40)
                      .map(({ r, it }, i) => (
                        <div key={r.id + i} className="flex items-center gap-2.5 text-[12.5px] py-1.5 border-b border-slate-100 last:border-0">
                          <span className="tabular-nums text-slate-400 whitespace-nowrap">{dayLabel(r.createdAt)}</span>
                          <span className="font-medium text-slate-700 whitespace-nowrap">{r.orderNumber}</span>
                          <span className="flex-1 truncate text-slate-600" title={`${it.productName} (${it.sku})`}>
                            {it.productName}
                          </span>
                          {it.condition && <span className="text-rose-600 whitespace-nowrap">{it.condition}</span>}
                          <span className={`whitespace-nowrap ${it.received > 0 ? "text-emerald-600" : "text-amber-600"}`}>
                            {it.received > 0 ? "at desk" : "in post"}
                          </span>
                        </div>
                      ))}
                  </div>
                </div>
              </div>
            )}
          </Panel>

          {/* Daily trend */}
          <Panel title="Daily trend" note="opened vs processed per day">
            <div className="flex gap-4 text-xs text-slate-500 mb-3">
              <span><span className="inline-block w-2 h-2 rounded-sm mr-1.5 align-middle" style={{ background: "#4f46e5" }} />Opened</span>
              <span><span className="inline-block w-2 h-2 rounded-sm mr-1.5 align-middle" style={{ background: "#0d9488" }} />Processed</span>
            </div>
            {(() => {
              const max = Math.max(...summary.trend.map((t) => Math.max(t.opened, t.processed)), 1);
              return (
                <div className="flex items-end gap-[3px] h-24 overflow-x-auto pb-1">
                  {summary.trend.map((t) => (
                    <div
                      key={t.day}
                      className="flex items-end gap-[1px] shrink-0"
                      title={`${dayLabel(t.day + "T00:00:00")} · opened ${t.opened} · processed ${t.processed}`}
                    >
                      <span
                        className="w-[6px] rounded-t-[1px]"
                        style={{ height: `${Math.max(2, (t.opened / max) * 100)}%`, background: "#4f46e5" }}
                      />
                      <span
                        className="w-[6px] rounded-t-[1px]"
                        style={{ height: `${Math.max(2, (t.processed / max) * 100)}%`, background: t.processed ? "#0d9488" : "#e2e8f0" }}
                      />
                    </div>
                  ))}
                </div>
              );
            })()}
            <p className="text-[11px] text-slate-400 mt-1">
              When the teal bars keep pace with the indigo ones, the desk is keeping up with what customers are sending back.
            </p>
          </Panel>

          {/* Feed */}
          <Panel
            title={`Returns · ${feedRows.length}`}
            right={
              <div className="flex items-center gap-2">
                {personFilter && (
                  <button
                    onClick={() => setPersonFilter(null)}
                    className="text-xs px-2.5 py-1 rounded-md bg-indigo-50 border border-indigo-200 text-indigo-700 font-medium"
                    title="Showing only returns this person worked — click to clear"
                  >
                    {personFilter} ✕
                  </button>
                )}
                {productFocus && (
                  <button
                    onClick={() => { setProductFocus(null); setFocusQuery(""); }}
                    className="text-xs px-2.5 py-1 rounded-md bg-indigo-50 border border-indigo-200 text-indigo-700 font-medium max-w-[220px] truncate"
                    title="Feed filtered to this product — click to clear"
                  >
                    {productFocus} ✕
                  </button>
                )}
                <select
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value)}
                  className="text-xs border border-slate-200 rounded-md px-2 py-1 bg-white text-slate-600"
                >
                  <option value="all">All statuses</option>
                  <option value="open">Open</option>
                  <option value="complete">Completed</option>
                  <option value="faulty">Faulty / damaged</option>
                </select>
                <select
                  value={reasonFilter}
                  onChange={(e) => setReasonFilter(e.target.value)}
                  className="text-xs border border-slate-200 rounded-md px-2 py-1 bg-white text-slate-600 max-w-[160px]"
                >
                  <option value="all">All reasons</option>
                  {summary.reasons.map((r) => (
                    <option key={r.key} value={r.key}>{r.key}</option>
                  ))}
                </select>
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search order / SKU / product…"
                  className="text-xs border border-slate-200 rounded-md px-2.5 py-1 w-52 bg-white"
                />
              </div>
            }
          >
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="text-[11px] uppercase tracking-wider text-slate-400 border-b border-slate-200">
                    <th className="text-left font-medium pb-2 pr-3">Opened</th>
                    <th className="text-left font-medium pb-2 px-3">Order</th>
                    <th className="text-left font-medium pb-2 px-3">Items</th>
                    <th className="text-right font-medium pb-2 px-3">Recv</th>
                    <th className="text-left font-medium pb-2 px-3">Reason</th>
                    <th className="text-right font-medium pb-2 px-3">Value</th>
                    <th className="text-left font-medium pb-2 pl-3">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {feedRows.slice(0, 250).map((r) => (
                    <FeedRow
                      key={r.id}
                      r={r}
                      open={openId === r.id}
                      onToggle={() => setOpenId(openId === r.id ? null : r.id)}
                    />
                  ))}
                </tbody>
              </table>
              {feedRows.length > 250 && (
                <p className="text-[11px] text-slate-400 pt-2">Showing first 250 — narrow the filters to see the rest.</p>
              )}
              {feedRows.length === 0 && !loading && (
                <p className="text-sm text-slate-400 py-4 text-center">Nothing matches these filters.</p>
              )}
            </div>
          </Panel>

          {exportOpen && (
            <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4" onClick={() => setExportOpen(false)}>
              <div className="bg-white rounded-xl shadow-xl w-full max-w-md" onClick={(e) => e.stopPropagation()}>
                <div className="px-5 py-3.5 border-b border-slate-200 flex items-center">
                  <h3 className="text-sm font-semibold text-slate-900">Export returns roll-up</h3>
                  <button onClick={() => setExportOpen(false)} className="ml-auto text-slate-400 hover:text-slate-600">✕</button>
                </div>
                <div className="p-5 flex flex-col gap-4 text-sm">
                  <p className="text-xs text-slate-500">
                    An Excel with a <b>Summary</b> sheet (one row per product: units, faulty %, value, top reason)
                    and a <b>By product &amp; size</b> sheet (each product's sizes × reasons grid). Uses the cached
                    returns — hit Sync first if you want today included.
                  </p>
                  <div className="flex items-center gap-3">
                    <label className="flex items-center gap-2 text-xs text-slate-600">
                      From
                      <input type="date" value={exportFrom} max={exportTo} onChange={(e) => setExportFrom(e.target.value)}
                        className="border border-slate-200 rounded-md px-2 py-1 bg-white" />
                    </label>
                    <label className="flex items-center gap-2 text-xs text-slate-600">
                      To
                      <input type="date" value={exportTo} min={exportFrom} max={localYmd(new Date())} onChange={(e) => setExportTo(e.target.value)}
                        className="border border-slate-200 rounded-md px-2 py-1 bg-white" />
                    </label>
                  </div>
                  <label className="flex items-center gap-2 text-xs text-slate-600 select-none">
                    <input type="checkbox" checked={exportLegacy} onChange={(e) => setExportLegacy(e.target.checked)} />
                    Include pre-Swap-v2 returns (before 3 Aug) — more data for reason analysis
                  </label>
                </div>
                <div className="px-5 py-3.5 border-t border-slate-200 flex justify-end gap-2">
                  <button onClick={() => setExportOpen(false)} className="text-xs px-3.5 py-1.5 rounded-md border border-slate-200 text-slate-600 hover:bg-slate-50">
                    Cancel
                  </button>
                  <button
                    onClick={runExport}
                    disabled={exporting}
                    className="text-xs px-4 py-1.5 rounded-md bg-indigo-600 text-white font-medium disabled:opacity-40"
                  >
                    {exporting ? "Building…" : "Download Excel"}
                  </button>
                </div>
              </div>
            </div>
          )}

          <p className="text-[11px] text-slate-400 pb-2">
            Values are on the Shopify basis — net of promotion discounts and tax (per-order rate, so
            zero-rated international orders aren&apos;t trimmed) — and should track Shopify&apos;s sales-reversals
            within a refund-processing lag; store-credit resolutions never appear in Shopify&apos;s figure.
            Sync re-pulls open returns + the last 14 days; completed returns freeze in the cache.
          </p>
        </div>
      </div>
    </div>
  );
}

function Kpi({ v, label, sub, red }: { v: string; label: string; sub?: string; red?: boolean }) {
  return (
    <div className="bg-white border border-slate-200 rounded-lg px-3.5 py-3">
      <div className={`text-[21px] font-semibold tracking-tight tabular-nums ${red ? "text-rose-600" : "text-slate-900"}`}>{v}</div>
      <div className="text-[10px] uppercase tracking-wider text-slate-400 mt-0.5">{label}</div>
      {sub && <div className="text-[11px] text-slate-500 mt-1">{sub}</div>}
    </div>
  );
}

function Panel({
  title,
  note,
  right,
  children,
}: {
  title: string;
  note?: string;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-white border border-slate-200 rounded-lg p-4">
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <h2 className="text-[11px] uppercase tracking-wider text-slate-500 font-medium">
          {title}
          {note && <span className="normal-case tracking-normal font-normal text-slate-400 ml-2">{note}</span>}
        </h2>
        <div className="flex-1" />
        {right}
      </div>
      {children}
    </div>
  );
}

function Empty() {
  return <p className="text-sm text-slate-400 py-3">Nothing in this window.</p>;
}

function StatusPill({ r }: { r: ReturnRow }) {
  if (!r.isV2)
    return <span className="text-[11px] font-medium rounded-full px-2 py-0.5 bg-slate-100 text-slate-400">v1 legacy</span>;
  if (/damag|fault/i.test(r.status))
    return <span className="text-[11px] font-medium rounded-full px-2 py-0.5 bg-rose-100 text-rose-700">{r.status}</span>;
  if (isOpen(r))
    return <span className="text-[11px] font-medium rounded-full px-2 py-0.5 bg-amber-100 text-amber-800">pending</span>;
  return <span className="text-[11px] font-medium rounded-full px-2 py-0.5 bg-emerald-100 text-emerald-800">{r.status}</span>;
}

function FeedRow({ r, open, onToggle }: { r: ReturnRow; open: boolean; onToggle: () => void }) {
  const reason = r.items.map((i) => i.reason).find(Boolean) || r.reason || "—";
  const faulty = /fault|damag/i.test(reason);
  const itemsLabel =
    r.items
      .slice(0, 2)
      .map((i) => i.productName.split("|")[0]?.trim() || i.sku)
      .join(", ") + (r.items.length > 2 ? ` +${r.items.length - 2}` : "");
  return (
    <>
      <tr onClick={onToggle} className={`border-b border-slate-100 cursor-pointer hover:bg-slate-50 ${open ? "bg-indigo-50/40" : ""}`}>
        <td className="py-2 pr-3 whitespace-nowrap tabular-nums text-slate-500">
          {dayLabel(r.createdAt)} {timeHM(r.createdAt)}
        </td>
        <td className="px-3 font-medium text-slate-900 whitespace-nowrap">{r.orderNumber}</td>
        <td className="px-3 text-slate-600 max-w-[300px] truncate" title={r.items.map((i) => i.productName).join(", ")}>
          {itemsLabel}
        </td>
        <td className="px-3 text-right tabular-nums text-slate-600">
          {r.received}/{r.expected}
        </td>
        <td className={`px-3 whitespace-nowrap ${faulty ? "text-rose-600 font-medium" : "text-slate-600"}`}>{reason}</td>
        <td className="px-3 text-right tabular-nums text-slate-600">{fmtMoney(r.value)}</td>
        <td className="pl-3"><StatusPill r={r} /></td>
      </tr>
      {open && (
        <tr className="bg-indigo-50/30">
          <td colSpan={7} className="px-4 py-3">
            <div className="grid md:grid-cols-2 gap-4">
              <div>
                <p className="text-[11px] uppercase tracking-wider text-slate-400 mb-2">Items</p>
                {r.items.map((it, i) => (
                  <div key={i} className="flex items-center gap-3 text-[13px] py-1 border-b border-indigo-100/60 last:border-0">
                    <span className="flex-1 text-slate-700">{it.productName} <span className="text-slate-400">({it.sku})</span></span>
                    <span className="text-slate-500 tabular-nums">recv {it.received}/{it.quantity}</span>
                    {it.condition && <span className="text-slate-500">cond: {it.condition}</span>}
                    <span className={it.restock ? "text-emerald-600" : "text-slate-400"}>
                      {it.restock ? "restock" : "no restock"}
                    </span>
                  </div>
                ))}
                {r.exchangeOrders.length > 0 && (
                  <p className="text-[12px] text-slate-500 mt-2">
                    Exchange order{r.exchangeOrders.length > 1 ? "s" : ""}: <b>{r.exchangeOrders.join(", ")}</b>
                  </p>
                )}
              </div>
              <div>
                <p className="text-[11px] uppercase tracking-wider text-slate-400 mb-2">History</p>
                {r.history.length === 0 && <p className="text-[13px] text-slate-400">No events logged.</p>}
                <ul className="text-[12.5px] text-slate-600 space-y-1.5">
                  {r.history.map((h, i) => (
                    <li key={i} className="flex gap-2">
                      <span className="tabular-nums text-slate-400 whitespace-nowrap">
                        {dayLabel(h.at)} {timeHM(h.at)}
                      </span>
                      <span>
                        {h.user && <b className="text-slate-800">{h.user} — </b>}
                        {h.body}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
