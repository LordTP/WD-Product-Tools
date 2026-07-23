"use client";

// Returns Pick Faces — what's sitting in the PICK-00 returns bins, what's worth
// collating back into the main faces, and how long it's been there.
// Two views over the same cached data: an action list and a spatial bin wall.

import { useCallback, useEffect, useMemo, useState } from "react";
import Papa from "papaparse";
import {
  summariseBins,
  collateList,
  binsStats,
  ageDays,
  ageBand,
  shortBin,
  type BinRow,
  type BinsSettings,
  type BinSummary,
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
  const [view, setView] = useState<"collate" | "wall">("collate");
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);

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
        setSyncMsg(`${data.itemsInBins} items · ${data.bins} bins`);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Sync failed.");
      } finally {
        setSyncing(false);
      }
    },
    [shipheroConnected, load],
  );

  // Bins are busy, so refresh on open then let them Sync manually after.
  useEffect(() => {
    (async () => {
      await load();
      if (shipheroConnected) await sync(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const bins = useMemo(() => summariseBins(allBins, rows ?? [], settings), [allBins, rows, settings]);
  const collate = useMemo(() => collateList(rows ?? [], settings), [rows, settings]);
  const stats = useMemo(() => binsStats(bins, collate), [bins, collate]);

  const q = query.trim().toLowerCase();
  const collateFiltered = q
    ? collate.filter((c) => `${c.sku} ${c.productName}`.toLowerCase().includes(q))
    : collate;
  const binsFiltered = q
    ? bins.filter(
        (b) =>
          b.binName.toLowerCase().includes(q) ||
          b.items.some((i) => `${i.sku} ${i.productName}`.toLowerCase().includes(q)),
      )
    : bins;

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
    if (view === "collate") {
      const out = collateFiltered.map((c) => ({
        SKU: c.sku,
        Product: c.productName,
        Units: c.units,
        "Collect from": c.sources.map((s) => `${shortBin(s.binName)} x${s.quantity}`).join(" | "),
        "Return to": c.destFace ?? "",
        "In face now": c.destQty ?? "",
        "Oldest (days)": c.oldestDays ?? "",
      }));
      download(Papa.unparse(out), `returns_collate_${stamp()}.csv`);
    } else {
      const out: Record<string, string | number>[] = [];
      for (const b of binsFiltered) {
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
          <button
            onClick={exportCsv}
            disabled={(rows?.length ?? 0) === 0}
            className="text-xs px-3 py-1.5 rounded-md border border-slate-200 text-slate-600 hover:bg-slate-50 disabled:opacity-50"
          >
            Export CSV
          </button>
          <button
            onClick={() => sync(false)}
            disabled={syncing || !shipheroConnected}
            title={shipheroConnected ? "Refresh from ShipHero" : "Connect ShipHero first"}
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

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-6 gap-px bg-slate-200 border-b border-slate-200 shrink-0">
        <Kpi label="Units in bins" value={stats.units} sub={`${stats.skus} SKUs`} />
        <Kpi label="Bins used" value={`${stats.binsUsed}/${stats.binsTotal}`} sub={`${stats.binsTotal - stats.binsUsed} empty`} />
        <Kpi label="Ready to collate" value={stats.collateSkus} sub={`over ${settings.collateThreshold} units`} tone={stats.collateSkus > 0 ? "rose" : "slate"} />
        <Kpi label="Units to move" value={stats.collateUnits} sub="if all collated" />
        <Kpi label={`Bins over ${settings.binTarget}`} value={stats.binsOver} sub="above target" tone={stats.binsOver > 0 ? "rose" : "slate"} />
        <Kpi label="Oldest stock" value={ageLabel(stats.oldestDays)} sub={stats.oldestBin ? shortBin(stats.oldestBin) : "—"} tone={stats.oldestDays !== null && stats.oldestDays >= settings.ageStaleDays ? "amber" : "slate"} />
      </div>

      {/* controls */}
      <div className="bg-white border-b border-slate-200 px-4 sm:px-5 py-2.5 flex items-center flex-wrap gap-2 sm:gap-3 shrink-0">
        <div className="inline-flex rounded-md border border-slate-200 overflow-hidden">
          <button onClick={() => setView("collate")} className={`text-xs px-3 py-1.5 ${view === "collate" ? "bg-indigo-600 text-white" : "text-slate-600 hover:bg-slate-50"}`}>
            Ready to collate
          </button>
          <button onClick={() => setView("wall")} className={`text-xs px-3 py-1.5 border-l border-slate-200 ${view === "wall" ? "bg-indigo-600 text-white" : "text-slate-600 hover:bg-slate-50"}`}>
            Bin wall
          </button>
        </div>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search SKU, product or bin…"
          className="pl-2 pr-2 py-1.5 border border-slate-200 rounded text-xs w-56 focus:ring-1 focus:ring-indigo-300 outline-none"
        />
        <span className="text-[11px] text-slate-400">
          {view === "collate"
            ? `SKUs with more than ${settings.collateThreshold} units across returns bins`
            : "6 across × down — tap a bin for contents"}
        </span>
      </div>

      {error && <div className="px-5 py-2 text-xs bg-rose-50 border-b border-rose-200 text-rose-700">{error}</div>}
      {!shipheroConnected && (
        <div className="px-5 py-2 text-xs bg-amber-50 border-b border-amber-200 text-amber-700">ShipHero isn’t connected — Sync is disabled.</div>
      )}

      <div className="flex-1 min-h-0 overflow-auto bg-white thin-scroll">
        {rows === null ? (
          <p className="text-center py-16 text-sm text-slate-400">Loading…</p>
        ) : view === "collate" ? (
          collateFiltered.length === 0 ? (
            <div className="text-center py-16 text-sm text-slate-400">
              Nothing to collate — no SKU has more than {settings.collateThreshold} units in the returns bins.
            </div>
          ) : (
            <table className="w-full text-sm border-collapse">
              <thead className="sticky top-0 bg-slate-100 z-10">
                <tr className="text-left text-[11px] uppercase tracking-wide text-slate-400">
                  <th className="font-medium px-4 py-2 border-b border-slate-200">Product</th>
                  <th className="font-medium px-4 py-2 border-b border-slate-200">SKU</th>
                  <th className="font-medium px-4 py-2 border-b border-slate-200 text-right">Units</th>
                  <th className="font-medium px-4 py-2 border-b border-slate-200">Collect from</th>
                  <th className="font-medium px-4 py-2 border-b border-slate-200">Return to</th>
                  <th className="font-medium px-4 py-2 border-b border-slate-200 text-right">Oldest</th>
                </tr>
              </thead>
              <tbody>
                {collateFiltered.map((c, i) => {
                  const band = ageBand(c.oldestDays, settings);
                  return (
                    <tr key={c.sku} className={i % 2 ? "bg-slate-50/60" : ""}>
                      <td className="px-4 py-2 border-b border-slate-100 text-[13px] text-slate-700">{c.productName || "—"}</td>
                      <td className="px-4 py-2 border-b border-slate-100 font-mono text-xs text-slate-500">{c.sku}</td>
                      <td className="px-4 py-2 border-b border-slate-100 text-right">
                        <span className="px-1.5 py-0.5 rounded text-xs font-semibold bg-indigo-50 text-indigo-700 tabular-nums">{c.units}</span>
                      </td>
                      <td className="px-4 py-2 border-b border-slate-100">
                        <div className="flex flex-wrap gap-1">
                          {c.sources.map((s) => (
                            <span key={s.binName} className="font-mono text-[11px] bg-slate-100 border border-slate-200 rounded px-1.5 py-0.5 whitespace-nowrap">
                              {shortBin(s.binName)} ×{s.quantity}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="px-4 py-2 border-b border-slate-100">
                        {c.destFace ? (
                          <>
                            <span className="font-mono text-xs text-emerald-700 font-semibold">{c.destFace}</span>
                            <span className="block text-[10px] text-slate-400">{c.destQty ? `holds ${c.destQty} now` : "empty face"}</span>
                          </>
                        ) : (
                          <span className="text-xs text-slate-400">no pick face found</span>
                        )}
                      </td>
                      <td className="px-4 py-2 border-b border-slate-100 text-right">
                        <span className={`px-1.5 py-0.5 rounded text-xs font-medium tabular-nums ${AGE_CLASS[band]}`}>{ageLabel(c.oldestDays)}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px]">
            <div className="p-4">
              <div className="grid grid-cols-6 gap-1.5">
                {binsFiltered.map((b) => {
                  const band = ageBand(b.oldestDays, settings);
                  const tone =
                    b.state === "empty"
                      ? "border-dashed border-slate-200 bg-white text-slate-300"
                      : b.state === "over"
                        ? "border-rose-300 bg-rose-50 text-rose-700"
                        : "border-slate-200 bg-slate-50 text-slate-800";
                  const isSel = selectedBin?.binName === b.binName;
                  return (
                    <button
                      key={b.binName}
                      onClick={() => setSelected(b.binName)}
                      title={b.binName}
                      className={`relative border rounded-lg p-1.5 text-left min-h-[58px] flex flex-col ${tone} ${isSel ? "ring-2 ring-indigo-400 border-indigo-400" : "hover:border-indigo-300"}`}
                    >
                      <span className="font-mono text-[10px] text-slate-500">{shortBin(b.binName)}</span>
                      <span className="text-base font-bold leading-none mt-0.5 tabular-nums">{b.units || "·"}</span>
                      {b.units > 0 && (
                        <span className="mt-auto h-[3px] rounded-full bg-slate-200 overflow-hidden">
                          <span
                            className={`block h-full ${b.state === "over" ? "bg-rose-500" : "bg-indigo-500"}`}
                            style={{ width: `${Math.min(100, (b.units / Math.max(1, settings.binTarget)) * 100)}%` }}
                          />
                        </span>
                      )}
                      {(band === "ageing" || band === "stale") && (
                        <span className={`absolute top-1.5 right-1.5 w-1.5 h-1.5 rounded-full ${band === "stale" ? "bg-rose-500" : "bg-amber-500"}`} />
                      )}
                    </button>
                  );
                })}
              </div>
              <div className="flex flex-wrap gap-3 mt-3 text-[10px] text-slate-400">
                <Legend cls="border-dashed border-slate-200 bg-white" label="empty" />
                <Legend cls="border-slate-200 bg-slate-50" label={`1–${settings.binTarget} units`} />
                <Legend cls="border-rose-300 bg-rose-50" label={`over ${settings.binTarget}`} />
                <span className="inline-flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-amber-500" />{settings.ageWarnDays}–{settings.ageStaleDays - 1} days</span>
                <span className="inline-flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-rose-500" />{settings.ageStaleDays}+ days</span>
              </div>
            </div>

            <aside className="border-t lg:border-t-0 lg:border-l border-slate-200 bg-slate-50 p-4">
              <p className="text-[10px] uppercase tracking-wide text-slate-400">Selected bin</p>
              <p className="font-mono text-sm font-semibold text-slate-900 mt-0.5">{selectedBin?.binName ?? "—"}</p>
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
        <span>{stats.binsUsed}/{stats.binsTotal} bins used</span>
        <span>{stats.units} units</span>
        <span>{stats.collateSkus} to collate</span>
        <span className="ml-auto">{syncedAgo ? `synced ${syncedAgo}` : "not synced yet"}</span>
      </footer>

      {showSettings && (
        <SettingsModal
          settings={settings}
          onClose={() => setShowSettings(false)}
          onSaved={(s) => {
            setSettings(s);
            setShowSettings(false);
          }}
        />
      )}
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
  const set = (k: keyof BinsSettings, v: string) => setForm((f) => ({ ...f, [k]: Number(v) || 0 }));

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

  const Field = ({ k, label, hint }: { k: keyof BinsSettings; label: string; hint: string }) => (
    <div>
      <p className="text-xs font-medium text-slate-700">{label}</p>
      <p className="text-[11px] text-slate-400 mb-1">{hint}</p>
      <input
        type="number"
        min={0}
        value={form[k]}
        onChange={(e) => set(k, e.target.value)}
        className="w-full px-2 py-1.5 border border-slate-200 rounded text-sm"
      />
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-5" onClick={(e) => e.stopPropagation()}>
        <p className="text-sm font-semibold text-slate-900">Returns pick face settings</p>
        <p className="text-xs text-slate-400 mt-0.5 mb-4">Thresholds are process rules — ShipHero doesn’t enforce a bin capacity.</p>
        <div className="grid grid-cols-2 gap-4">
          <Field k="collateThreshold" label="Collate over" hint="units of one SKU across bins" />
          <Field k="binTarget" label="Bin target" hint="units per bin before flagged" />
          <Field k="ageWarnDays" label="Ageing after" hint="days in bin" />
          <Field k="ageStaleDays" label="Stale after" hint="days in bin" />
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
