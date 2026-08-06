"use client";

// Cycle Counts — two halves over one page:
//  · New count: run a live low-stock report (SKUs at/under a qty threshold,
//    pulled from a fresh ShipHero inventory snapshot — nothing stored), untick
//    anything you don't want, then generate a real ShipHero cycle count. Rows
//    are ordered by location 00 → 06 (how the floor walks it).
//  · Submitted counts: the counts we've created, with live status refreshed on
//    demand (like POs). Click one for a scrollable summary + the SKU list.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  prettyStatus,
  statusClass,
  dueLabel,
  type LowStockItem,
  type CycleCountRow,
} from "@/lib/cycle-counts-derive";

function todayInput(): string {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

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

export function CycleCounts({ shipheroConnected }: { shipheroConnected: boolean }) {
  // report state
  const [maxQty, setMaxQty] = useState(10);
  const [items, setItems] = useState<LowStockItem[] | null>(null);
  const [reportMax, setReportMax] = useState(10); // the max the current report was run at
  const [snapshotAt, setSnapshotAt] = useState<string | null>(null);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [running, setRunning] = useState(false);

  // create state
  const [name, setName] = useState("");
  const [dueDate, setDueDate] = useState(todayInput());
  const [generating, setGenerating] = useState(false);

  // history state
  const [rows, setRows] = useState<CycleCountRow[]>([]);
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [detail, setDetail] = useState<CycleCountRow | null>(null);

  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const loadHistory = useCallback(async () => {
    try {
      const res = await fetch("/api/cycle-counts/list");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load.");
      setRows(data.rows ?? []);
      setLastSyncedAt(data.lastSyncedAt ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load.");
    }
  }, []);

  useEffect(() => {
    (async () => {
      await loadHistory();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runReport = useCallback(async () => {
    if (!shipheroConnected) return;
    setRunning(true);
    setError(null);
    setToast(null);
    try {
      const res = await fetch("/api/cycle-counts/low-stock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxQty }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Report failed.");
      setItems(data.items ?? []);
      setReportMax(data.maxQty ?? maxQty);
      setSnapshotAt(data.snapshotAt ?? null);
      setExcluded(new Set());
      setName(`Low stock ≤${data.maxQty ?? maxQty} · ${todayInput()}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Report failed.");
    } finally {
      setRunning(false);
    }
  }, [shipheroConnected, maxQty]);

  const selected = useMemo(
    () => (items ?? []).filter((i) => !excluded.has(i.sku)),
    [items, excluded],
  );
  const selectedUnits = selected.reduce((a, i) => a + i.onHand, 0);

  const toggle = (sku: string) =>
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(sku)) next.delete(sku);
      else next.add(sku);
      return next;
    });
  const setAll = (include: boolean) =>
    setExcluded(include ? new Set() : new Set((items ?? []).map((i) => i.sku)));

  const generate = useCallback(async () => {
    if (selected.length === 0) return;
    setGenerating(true);
    setError(null);
    try {
      const res = await fetch("/api/cycle-counts/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), items: selected, dueDate, maxQty: reportMax }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Create failed.");
      setToast(`Created "${data.count?.name}" — ${data.count?.skuCount} SKUs.`);
      setItems(null);
      setExcluded(new Set());
      await loadHistory();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Create failed.");
    } finally {
      setGenerating(false);
    }
  }, [selected, name, dueDate, reportMax, loadHistory]);

  const refresh = useCallback(async () => {
    if (!shipheroConnected) return;
    setSyncing(true);
    setError(null);
    try {
      const res = await fetch("/api/cycle-counts/refresh", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Refresh failed.");
      setRows(data.rows ?? []);
      setLastSyncedAt(data.syncedAt ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Refresh failed.");
    } finally {
      setSyncing(false);
    }
  }, [shipheroConnected]);

  return (
    <div className="max-w-6xl mx-auto p-4 sm:p-6 space-y-6">
      <header>
        <h1 className="text-lg font-semibold text-slate-900">Cycle Counts</h1>
        <p className="text-sm text-slate-500">
          Build a count of low-stock SKUs from a live ShipHero snapshot, then track the counts you&apos;ve submitted.
        </p>
      </header>

      {!shipheroConnected && (
        <div className="rounded-md bg-amber-50 border border-amber-200 text-amber-800 text-sm px-3 py-2">
          ShipHero isn&apos;t connected — set a refresh token to use this page.
        </div>
      )}
      {error && (
        <div className="rounded-md bg-rose-50 border border-rose-200 text-rose-700 text-sm px-3 py-2">{error}</div>
      )}
      {toast && (
        <div className="rounded-md bg-emerald-50 border border-emerald-200 text-emerald-700 text-sm px-3 py-2">
          {toast}
        </div>
      )}

      {/* ---------- New count ---------- */}
      <section className="bg-white border border-slate-200 rounded-lg">
        <div className="px-4 py-3 border-b border-slate-200 flex flex-wrap items-center gap-3">
          <h2 className="text-sm font-semibold text-slate-900">New low-stock count</h2>
          <div className="ml-auto flex items-center gap-2 text-sm">
            <label className="text-slate-500">Qty ≤</label>
            <input
              type="number"
              min={1}
              value={maxQty}
              onChange={(e) => setMaxQty(Math.max(1, Number(e.target.value) || 1))}
              className="w-16 rounded-md border border-slate-300 px-2 py-1 text-slate-900"
            />
            <button
              onClick={runReport}
              disabled={!shipheroConnected || running}
              className="rounded-md bg-indigo-600 text-white px-3 py-1.5 text-sm font-medium hover:bg-indigo-700 disabled:opacity-50"
            >
              {running ? "Generating snapshot…" : "Run report"}
            </button>
          </div>
        </div>

        {items === null ? (
          <div className="px-4 py-10 text-center text-sm text-slate-400">
            Run the report to pull every SKU with {1}–{maxQty} on hand, sorted by location (00 → 06).
          </div>
        ) : items.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-slate-500">
            No SKUs between 1 and {reportMax} on hand. Nothing to count.
          </div>
        ) : (
          <>
            <div className="px-4 py-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500 border-b border-slate-100">
              <span>
                <b className="text-slate-800">{selected.length}</b> of {items.length} SKUs selected · {selectedUnits} units
              </span>
              {snapshotAt && <span>snapshot {timeAgo(snapshotAt)}</span>}
              <div className="ml-auto flex gap-2">
                <button onClick={() => setAll(true)} className="text-indigo-600 hover:underline">
                  Select all
                </button>
                <button onClick={() => setAll(false)} className="text-slate-500 hover:underline">
                  Clear
                </button>
              </div>
            </div>
            <div className="max-h-[420px] overflow-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-slate-50 text-slate-500 text-xs">
                  <tr>
                    <th className="w-10 px-3 py-2"></th>
                    <th className="text-left px-3 py-2 font-medium">SKU</th>
                    <th className="text-right px-3 py-2 font-medium">On hand</th>
                    <th className="text-left px-3 py-2 font-medium">Location(s)</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((it) => {
                    const on = !excluded.has(it.sku);
                    return (
                      <tr
                        key={it.sku}
                        onClick={() => toggle(it.sku)}
                        className={`border-t border-slate-100 cursor-pointer ${on ? "" : "opacity-40"} hover:bg-slate-50`}
                      >
                        <td className="px-3 py-2 text-center">
                          <input type="checkbox" checked={on} onChange={() => toggle(it.sku)} onClick={(e) => e.stopPropagation()} />
                        </td>
                        <td className="px-3 py-2 font-mono text-xs text-slate-800">{it.sku}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-slate-800">{it.onHand}</td>
                        <td className="px-3 py-2 text-slate-600">
                          {it.locations.length === 0 ? (
                            <span className="text-slate-400">—</span>
                          ) : (
                            <span>
                              {it.locations.map((l) => `${l.name} (${l.qty})`).join(", ")}
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="px-4 py-3 border-t border-slate-200 flex flex-wrap items-end gap-3">
              <div>
                <label className="block text-xs text-slate-500 mb-1">Count name</label>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-72 rounded-md border border-slate-300 px-2 py-1.5 text-sm text-slate-900"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-500 mb-1">Due date</label>
                <input
                  type="date"
                  value={dueDate}
                  onChange={(e) => setDueDate(e.target.value || todayInput())}
                  className="rounded-md border border-slate-300 px-2 py-1.5 text-sm text-slate-900"
                />
              </div>
              <button
                onClick={generate}
                disabled={generating || selected.length === 0 || !name.trim()}
                className="ml-auto rounded-md bg-indigo-600 text-white px-4 py-2 text-sm font-medium hover:bg-indigo-700 disabled:opacity-50"
              >
                {generating ? "Creating…" : `Generate cycle count (${selected.length})`}
              </button>
            </div>
          </>
        )}
      </section>

      {/* ---------- Submitted counts ---------- */}
      <section className="bg-white border border-slate-200 rounded-lg">
        <div className="px-4 py-3 border-b border-slate-200 flex items-center gap-3">
          <h2 className="text-sm font-semibold text-slate-900">Submitted counts</h2>
          <span className="text-xs text-slate-400">synced {timeAgo(lastSyncedAt)}</span>
          <button
            onClick={refresh}
            disabled={!shipheroConnected || syncing}
            className="ml-auto rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            {syncing ? "Refreshing…" : "Refresh status"}
          </button>
        </div>
        {rows.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-slate-400">
            No cycle counts submitted yet.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-500 text-xs">
                <tr>
                  <th className="text-left px-4 py-2 font-medium">Name</th>
                  <th className="text-left px-3 py-2 font-medium">Status</th>
                  <th className="text-left px-3 py-2 font-medium">Progress</th>
                  <th className="text-right px-3 py-2 font-medium">SKUs</th>
                  <th className="text-left px-3 py-2 font-medium">Due</th>
                  <th className="text-left px-3 py-2 font-medium">Created</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const total = r.skusTotal ?? r.skuCount;
                  const done = r.skusCounted ?? r.counted ?? 0;
                  const pct = total > 0 ? Math.round((done / total) * 100) : r.progress ?? 0;
                  return (
                    <tr
                      key={r.shipheroId}
                      onClick={() => setDetail(r)}
                      className="border-t border-slate-100 cursor-pointer hover:bg-slate-50"
                    >
                      <td className="px-4 py-2.5 text-slate-800">{r.name}</td>
                      <td className="px-3 py-2.5">
                        <span className={`inline-block rounded px-1.5 py-0.5 text-xs ${statusClass(r.status)}`}>
                          {prettyStatus(r.status)}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 w-40">
                        <div className="flex items-center gap-2">
                          <div className="h-1.5 flex-1 rounded-full bg-slate-100 overflow-hidden">
                            <div className="h-full bg-indigo-500" style={{ width: `${pct}%` }} />
                          </div>
                          <span className="text-xs text-slate-500 tabular-nums">{done}/{total}</span>
                        </div>
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-slate-700">{r.skuCount}</td>
                      <td className="px-3 py-2.5 text-slate-600">{dueLabel(r.dueDate)}</td>
                      <td className="px-3 py-2.5 text-slate-500 text-xs">{timeAgo(r.createdAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {detail && <DetailModal row={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}

function DetailModal({ row, onClose }: { row: CycleCountRow; onClose: () => void }) {
  const total = row.skusTotal ?? row.skuCount;
  const done = row.skusCounted ?? row.counted ?? 0;
  const pct = total > 0 ? Math.round((done / total) * 100) : row.progress ?? 0;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" onClick={onClose}>
      <div
        className="bg-white rounded-lg shadow-xl w-full max-w-2xl max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-3 border-b border-slate-200 flex items-start gap-3">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-slate-900 truncate">{row.name}</h3>
            <p className="text-xs text-slate-400">
              {row.legacyId ? `#${row.legacyId} · ` : ""}created {timeAgo(row.createdAt)} · synced {timeAgo(row.syncedAt)}
            </p>
          </div>
          <button onClick={onClose} className="ml-auto text-slate-400 hover:text-slate-700 text-xl leading-none">
            ×
          </button>
        </div>

        <div className="px-5 py-3 grid grid-cols-2 sm:grid-cols-4 gap-3 border-b border-slate-100 text-sm">
          <Stat label="Status" value={prettyStatus(row.status)} cls={statusClass(row.status)} />
          <Stat label="Progress" value={`${done}/${total} (${pct}%)`} />
          <Stat label="SKUs submitted" value={String(row.skuCount)} />
          <Stat label="Due" value={dueLabel(row.dueDate)} />
        </div>

        <div className="overflow-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-slate-50 text-slate-500 text-xs">
              <tr>
                <th className="text-left px-5 py-2 font-medium">SKU</th>
                <th className="text-right px-3 py-2 font-medium">On hand *</th>
                <th className="text-left px-3 py-2 font-medium">Location(s) *</th>
              </tr>
            </thead>
            <tbody>
              {row.items.map((it) => (
                <tr key={it.sku} className="border-t border-slate-100">
                  <td className="px-5 py-2 font-mono text-xs text-slate-800">{it.sku}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-700">{it.onHand}</td>
                  <td className="px-3 py-2 text-slate-600">
                    {it.locations.length ? it.locations.map((l) => `${l.name} (${l.qty})`).join(", ") : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="px-5 py-2 border-t border-slate-100 text-[11px] text-slate-400">
          * On-hand &amp; locations shown are from the snapshot when this count was created. Live count progress is above.
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, cls }: { label: string; value: string; cls?: string }) {
  return (
    <div>
      <p className="text-[11px] uppercase tracking-wide text-slate-400">{label}</p>
      {cls ? (
        <span className={`inline-block mt-0.5 rounded px-1.5 py-0.5 text-xs ${cls}`}>{value}</span>
      ) : (
        <p className="text-slate-800">{value}</p>
      )}
    </div>
  );
}
