"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Papa from "papaparse";
import type { ReturnRecord } from "@/lib/shiphero/returns-pull";
import {
  SWAP_CONDITIONS,
  returnToSwapRows,
  isExportable,
  bareOrderNumber,
  type ReturnsSettings,
  type SwapRow,
} from "@/lib/returns-derive";

const todayISO = () => new Date().toISOString().slice(0, 10);
const addDays = (iso: string, n: number) => {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

function timeAgo(iso: string | null): string {
  if (!iso) return "never";
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
  if (k.includes("cancel") || k.includes("reject")) return "bg-rose-100 text-rose-700";
  if (k.includes("complete")) return "bg-emerald-100 text-emerald-700";
  if (k.includes("partial") || k.includes("transit")) return "bg-indigo-100 text-indigo-700";
  if (k.includes("pending")) return "bg-amber-100 text-amber-700";
  return "bg-slate-100 text-slate-600";
}

interface DerivedRow extends SwapRow {
  rma: string;
  status: string;
  productName: string;
}

export function Returns({
  shipheroConnected,
  initialSettings,
}: {
  shipheroConnected: boolean;
  initialSettings: ReturnsSettings;
}) {
  const [from, setFrom] = useState(todayISO());
  const [to, setTo] = useState(todayISO());
  const [returns, setReturns] = useState<ReturnRecord[] | null>(null);
  const [statuses, setStatuses] = useState<string[]>([]);
  const [settings, setSettings] = useState<ReturnsSettings>(initialSettings);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showExcluded, setShowExcluded] = useState(false);
  const [exportedMsg, setExportedMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!shipheroConnected) return;
    setLoading(true);
    setError(null);
    setExportedMsg(null);
    try {
      const fromISO = `${from}T00:00:00.000Z`;
      const toISO = `${to}T23:59:59.999Z`;
      const res = await fetch(`/api/returns/list?from=${encodeURIComponent(fromISO)}&to=${encodeURIComponent(toISO)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load returns.");
      setReturns(data.returns);
      setStatuses(data.statuses ?? []);
      if (data.settings) setSettings(data.settings);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load returns.");
    } finally {
      setLoading(false);
    }
  }, [from, to, shipheroConnected]);

  // fetch-on-mount: invoked from an async callback so the React Compiler lint
  // (set-state-in-effect) sees no synchronous setState in the effect body.
  useEffect(() => {
    void (async () => { await load(); })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // initial load only; subsequent loads via the Load button

  // Split returns into exportable + excluded (with a reason).
  const { exportRows, exportable, excluded } = useMemo(() => {
    const recs = returns ?? [];
    const exportRows: DerivedRow[] = [];
    const exportable: ReturnRecord[] = [];
    const excluded: { rec: ReturnRecord; reason: string }[] = [];
    for (const rec of recs) {
      const ok = isExportable(rec, settings);
      if (ok) {
        exportable.push(rec);
        for (const row of returnToSwapRows(rec, settings)) {
          const line = rec.lines.find((l) => l.sku === row.SKU);
          exportRows.push({ ...row, rma: rec.rma, status: rec.status, productName: line?.productName ?? "" });
        }
      } else {
        const statusOk = settings.exportStatuses.map((s) => s.toLowerCase()).includes(rec.status.toLowerCase());
        const reason = !statusOk
          ? `status “${rec.status || "—"}” not set to export`
          : "nothing received yet";
        excluded.push({ rec, reason });
      }
    }
    return { exportRows, exportable, excluded };
  }, [returns, settings]);

  const condCounts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const r of exportRows) m[r["stock condition"]] = (m[r["stock condition"]] ?? 0) + r["Returned Quantity"];
    return m;
  }, [exportRows]);

  function preset(kind: "today" | "yesterday" | "7d") {
    const t = todayISO();
    if (kind === "today") { setFrom(t); setTo(t); }
    else if (kind === "yesterday") { const y = addDays(t, -1); setFrom(y); setTo(y); }
    else { setFrom(addDays(t, -6)); setTo(t); }
  }

  async function exportCsv() {
    if (exportRows.length === 0) return;
    const rows: SwapRow[] = exportRows.map((r) => ({
      "Order number": r["Order number"],
      "stock condition": r["stock condition"],
      SKU: r.SKU,
      "Returned Quantity": r["Returned Quantity"],
    }));
    const csv = Papa.unparse(rows, { columns: ["Order number", "stock condition", "SKU", "Returned Quantity"] });
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `swap_qc_${from}${from === to ? "" : `_to_${to}`}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    // stamp last-export time
    try {
      const res = await fetch("/api/returns/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ markExported: true }),
      });
      const data = await res.json();
      if (data.settings) setSettings(data.settings);
    } catch {
      /* non-fatal */
    }
    setExportedMsg(`Exported ${rows.length} row${rows.length === 1 ? "" : "s"}`);
  }

  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden">
      <header className="h-14 bg-white border-b border-slate-200 flex items-center justify-between px-4 sm:px-5 shrink-0">
        <div className="flex items-center gap-3">
          <span className="font-semibold text-sm text-slate-900">Returns</span>
          <span className="hidden sm:inline text-xs text-slate-400">Swap QC export · from ShipHero</span>
        </div>
        <div className="flex items-center gap-2 sm:gap-3">
          <span className="hidden sm:inline text-[11px] text-slate-400">
            last export {timeAgo(settings.lastExportAt)}
          </span>
          <button
            onClick={() => setShowSettings(true)}
            title="Export settings"
            className="text-xs px-2.5 py-1.5 rounded-md border border-slate-200 text-slate-600 hover:bg-slate-50 flex items-center gap-1.5"
          >
            <svg width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
            <span className="hidden sm:inline">Settings</span>
          </button>
          <button
            onClick={exportCsv}
            disabled={exportRows.length === 0}
            title="Download the Swap QC CSV for the rows below"
            className="text-xs px-3 py-1.5 rounded-md bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-40 flex items-center gap-1.5"
          >
            <svg width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />
            </svg>
            Export Swap CSV ({exportRows.length})
          </button>
        </div>
      </header>

      {/* controls */}
      <div className="bg-white border-b border-slate-200 px-4 sm:px-5 py-2.5 flex items-center flex-wrap gap-2 sm:gap-3 shrink-0">
        <label className="flex items-center gap-1.5 text-xs text-slate-500">
          From
          <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} className="px-2 py-1 border border-slate-200 rounded text-xs" />
        </label>
        <label className="flex items-center gap-1.5 text-xs text-slate-500">
          To
          <input type="date" value={to} min={from} max={todayISO()} onChange={(e) => setTo(e.target.value)} className="px-2 py-1 border border-slate-200 rounded text-xs" />
        </label>
        <div className="flex items-center gap-1">
          {(["today", "yesterday", "7d"] as const).map((k) => (
            <button key={k} onClick={() => preset(k)} className="text-[11px] px-2 py-1 rounded border border-slate-200 text-slate-500 hover:bg-slate-50">
              {k === "today" ? "Today" : k === "yesterday" ? "Yesterday" : "Last 7d"}
            </button>
          ))}
        </div>
        <button
          onClick={load}
          disabled={loading || !shipheroConnected}
          className={`text-xs px-3 py-1.5 rounded-md flex items-center gap-1.5 ${
            shipheroConnected ? "bg-slate-900 text-white hover:bg-slate-800" : "bg-slate-200 text-slate-400 cursor-not-allowed"
          } disabled:opacity-60`}
        >
          <svg width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" className={loading ? "animate-spin" : ""}>
            <path d="M21 2v6h-6M3 12a9 9 0 0 1 15-6.7L21 8M3 22v-6h6M21 12a9 9 0 0 1-15 6.7L3 16" />
          </svg>
          {loading ? "Loading…" : "Load returns"}
        </button>
        <div className="ml-auto flex items-center gap-2 text-[11px] text-slate-500">
          <span className="px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 font-medium">{settings.sellableLabel}: {condCounts[settings.sellableLabel] ?? 0}</span>
          <span className="px-1.5 py-0.5 rounded bg-rose-50 text-rose-700 font-medium">{settings.damagedLabel}: {condCounts[settings.damagedLabel] ?? 0}</span>
        </div>
      </div>

      {error && <div className="px-5 py-2 text-xs bg-rose-50 border-b border-rose-200 text-rose-700">{error}</div>}
      {!shipheroConnected && (
        <div className="px-5 py-2 text-xs bg-amber-50 border-b border-amber-200 text-amber-700">ShipHero isn’t connected — can’t pull returns.</div>
      )}
      {exportedMsg && (
        <div className="px-5 py-2 text-xs bg-emerald-50 border-b border-emerald-200 text-emerald-700">
          {exportedMsg} · upload the file into Swap → Quality Control.
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-auto bg-white thin-scroll">
        {returns === null && !loading ? (
          <p className="text-center py-16 text-sm text-slate-400">Pick a date range and click <span className="font-medium text-slate-600">Load returns</span>.</p>
        ) : exportRows.length === 0 && !loading ? (
          <div className="text-center py-16 text-sm text-slate-400">
            No exportable returns in this range.
            {excluded.length > 0 && (
              <span className="block mt-1 text-xs">{excluded.length} return{excluded.length === 1 ? "" : "s"} excluded (see below).</span>
            )}
          </div>
        ) : (
          <table className="w-full text-sm border-collapse">
            <thead className="sticky top-0 bg-slate-100 z-10">
              <tr className="text-left text-[11px] uppercase tracking-wide text-slate-400">
                <th className="font-medium px-4 py-2 border-b border-slate-200">Order number</th>
                <th className="font-medium px-4 py-2 border-b border-slate-200">RMA</th>
                <th className="font-medium px-4 py-2 border-b border-slate-200">SKU</th>
                <th className="font-medium px-4 py-2 border-b border-slate-200">Product</th>
                <th className="font-medium px-4 py-2 border-b border-slate-200">Status</th>
                <th className="font-medium px-4 py-2 border-b border-slate-200">Stock condition</th>
                <th className="font-medium px-4 py-2 border-b border-slate-200 text-right">Qty</th>
              </tr>
            </thead>
            <tbody>
              {exportRows.map((r, i) => (
                <tr key={r.rma + r.SKU + r["stock condition"] + i} className={i % 2 ? "bg-slate-50/60" : ""}>
                  <td className="px-4 py-2 border-b border-slate-100 font-mono text-xs font-medium text-slate-700">{r["Order number"]}</td>
                  <td className="px-4 py-2 border-b border-slate-100 font-mono text-xs text-slate-400">{r.rma}</td>
                  <td className="px-4 py-2 border-b border-slate-100 font-mono text-xs text-slate-500">{r.SKU}</td>
                  <td className="px-4 py-2 border-b border-slate-100 text-[13px] text-slate-700 truncate max-w-[20rem]">{r.productName || "—"}</td>
                  <td className="px-4 py-2 border-b border-slate-100"><span className={`px-1.5 py-0.5 rounded text-xs ${statusClass(r.status)}`}>{r.status || "—"}</span></td>
                  <td className="px-4 py-2 border-b border-slate-100">
                    <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${r["stock condition"] === settings.sellableLabel ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-700"}`}>
                      {r["stock condition"]}
                    </span>
                  </td>
                  <td className="px-4 py-2 border-b border-slate-100 text-right font-mono tabular-nums text-slate-700">{r["Returned Quantity"]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {/* excluded */}
        {excluded.length > 0 && (
          <div className="border-t border-slate-200">
            <button onClick={() => setShowExcluded((v) => !v)} className="w-full text-left px-5 py-2 text-xs text-slate-500 hover:bg-slate-50 flex items-center gap-2">
              <span className={`transition-transform ${showExcluded ? "rotate-90" : ""}`}>›</span>
              {excluded.length} return{excluded.length === 1 ? "" : "s"} excluded from export
            </button>
            {showExcluded && (
              <table className="w-full text-xs">
                <tbody>
                  {excluded.map(({ rec, reason }, i) => (
                    <tr key={rec.rma + i} className="border-b border-slate-50">
                      <td className="px-5 py-1.5 font-mono text-slate-500 w-28">{bareOrderNumber(rec.orderNumber) || "—"}</td>
                      <td className="px-2 py-1.5 font-mono text-slate-400 w-24">{rec.rma}</td>
                      <td className="px-2 py-1.5"><span className={`px-1.5 py-0.5 rounded ${statusClass(rec.status)}`}>{rec.status || "—"}</span></td>
                      <td className="px-2 py-1.5 text-slate-400">{reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>

      <footer className="h-8 bg-slate-100 border-t border-slate-200 text-slate-500 text-[11px] flex items-center px-5 gap-4 shrink-0 font-mono">
        <span>{exportable.length} exportable · {exportRows.length} rows · {excluded.length} excluded</span>
        <span className="text-slate-400">live from ShipHero · one row per received item</span>
        <span className="ml-auto">last export {timeAgo(settings.lastExportAt)}</span>
      </footer>

      {showSettings && (
        <SettingsModal
          settings={settings}
          statuses={statuses}
          onClose={() => setShowSettings(false)}
          onSaved={(s) => { setSettings(s); setShowSettings(false); }}
        />
      )}
    </div>
  );
}

function SettingsModal({
  settings,
  statuses,
  onClose,
  onSaved,
}: {
  settings: ReturnsSettings;
  statuses: string[];
  onClose: () => void;
  onSaved: (s: ReturnsSettings) => void;
}) {
  // Union of statuses seen this load and any already configured, so a configured
  // status still shows even if none are in the current window.
  const allStatuses = useMemo(
    () => [...new Set([...statuses, ...settings.exportStatuses])].sort((a, b) => a.localeCompare(b)),
    [statuses, settings.exportStatuses],
  );
  const [selected, setSelected] = useState<string[]>(settings.exportStatuses);
  const [sellable, setSellable] = useState(settings.sellableLabel);
  const [damaged, setDamaged] = useState(settings.damagedLabel);
  const [customStatus, setCustomStatus] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const toggle = (s: string) =>
    setSelected((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]));

  async function save() {
    setSaving(true);
    setErr(null);
    try {
      const res = await fetch("/api/returns/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ exportStatuses: selected, sellableLabel: sellable, damagedLabel: damaged }),
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-5" onClick={(e) => e.stopPropagation()}>
        <p className="text-sm font-semibold text-slate-900">Export settings</p>
        <p className="text-xs text-slate-400 mt-0.5 mb-4">Which returns count as ready, and how conditions map to Swap.</p>

        <div className="mb-4">
          <p className="text-xs font-medium text-slate-700 mb-1.5">Export when status is…</p>
          <div className="flex flex-wrap gap-1.5">
            {allStatuses.length === 0 && <span className="text-xs text-slate-400">No statuses seen yet — load some returns first.</span>}
            {allStatuses.map((s) => (
              <button
                key={s}
                onClick={() => toggle(s)}
                className={`px-2 py-1 rounded text-xs border ${selected.includes(s) ? "bg-indigo-600 text-white border-indigo-600" : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50"}`}
              >
                {s}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1.5 mt-2">
            <input
              value={customStatus}
              onChange={(e) => setCustomStatus(e.target.value)}
              placeholder="add a status exactly as in ShipHero…"
              className="flex-1 px-2 py-1 border border-slate-200 rounded text-xs"
            />
            <button
              onClick={() => { const v = customStatus.trim(); if (v && !selected.includes(v)) setSelected((c) => [...c, v]); setCustomStatus(""); }}
              disabled={!customStatus.trim()}
              className="text-xs px-2 py-1 rounded border border-slate-200 text-slate-600 hover:bg-slate-50 disabled:opacity-40"
            >
              Add
            </button>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 mb-4">
          <div>
            <p className="text-xs font-medium text-slate-700 mb-1.5">Restocked → condition</p>
            <select value={sellable} onChange={(e) => setSellable(e.target.value)} className="w-full px-2 py-1.5 border border-slate-200 rounded text-sm bg-white">
              {SWAP_CONDITIONS.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div>
            <p className="text-xs font-medium text-slate-700 mb-1.5">Received, not restocked →</p>
            <select value={damaged} onChange={(e) => setDamaged(e.target.value)} className="w-full px-2 py-1.5 border border-slate-200 rounded text-sm bg-white">
              {SWAP_CONDITIONS.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
        </div>

        {err && <p className="text-xs text-rose-600 mb-2">{err}</p>}
        <div className="flex justify-end gap-2">
          <button onClick={onClose} disabled={saving} className="text-xs px-3 py-1.5 rounded-md border border-slate-200 text-slate-600 hover:bg-slate-50">Cancel</button>
          <button onClick={save} disabled={saving || selected.length === 0} className="text-xs px-4 py-1.5 rounded-md bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-40">
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
