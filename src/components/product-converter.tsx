"use client";

// Style Arcade .xlsx → Shopify (Hextom) multi-variant CSV. Upload → preview →
// (remap columns if needed) → pick scenario A/B → download. Parsing is server-
// side; the CSV + analysis are computed client-side (pure fns) so the scenario
// toggle and column remapping re-generate instantly.

import { useMemo, useRef, useState } from "react";
import Papa from "papaparse";
import {
  buildScenario,
  analyze,
  FIELDS,
  type ColumnMap,
  type Scenario,
} from "@/lib/styleArcade/convert";
import type { SizeMap } from "@/lib/sizes";

interface Parsed {
  filename: string;
  sheetName: string;
  headers: string[];
  rows: unknown[][];
  cols: ColumnMap;
  missing: string[];
}

const fieldLabel = (names: string[]): string => names[0].charAt(0).toUpperCase() + names[0].slice(1);

export function ProductConverter({ sizeMap }: { sizeMap: SizeMap }) {
  const [parsed, setParsed] = useState<Parsed | null>(null);
  const [mapping, setMapping] = useState<ColumnMap | null>(null);
  const [showMapping, setShowMapping] = useState(false);
  const [scenario, setScenario] = useState<Scenario>("A");
  const [seasonSuffix, setSeasonSuffix] = useState("_NEW");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // Required fields whose column couldn't be resolved (recomputed from mapping).
  const missingRequired = useMemo(
    () => (mapping ? FIELDS.filter((f) => f.required && (mapping[f.key] ?? -1) < 0).map((f) => f.key) : []),
    [mapping],
  );
  const analysis = useMemo(
    () => (parsed && mapping ? analyze(parsed.rows, mapping, sizeMap) : null),
    [parsed, mapping, sizeMap],
  );
  const outRows = useMemo(
    () => (parsed && mapping ? buildScenario(parsed.rows, mapping, scenario, seasonSuffix, sizeMap) : []),
    [parsed, mapping, scenario, seasonSuffix, sizeMap],
  );

  async function handleFile(file: File) {
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/products/parse", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to parse file.");
      setParsed(data);
      setMapping(data.cols);
      setShowMapping((data.missing?.length ?? 0) > 0); // auto-open if anything's missing
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to parse file.");
    } finally {
      setBusy(false);
    }
  }

  function download(scn: Scenario) {
    if (!parsed || !mapping) return;
    const rows = buildScenario(parsed.rows, mapping, scn, seasonSuffix, sizeMap);
    const csv = Papa.unparse(rows);
    const base = parsed.filename.replace(/\.[^.]+$/, "");
    const name = `${base}_shopify_${scn}_${scn === "A" ? "current" : "proposed"}.csv`;
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (!parsed || !mapping) {
    return (
      <div className="flex flex-col h-full min-h-0 overflow-hidden">
        <header className="h-14 bg-white border-b border-slate-200 flex items-center px-5 shrink-0">
          <span className="font-semibold text-sm text-slate-900">Products → Shopify</span>
          <span className="ml-3 text-xs text-slate-400">Style Arcade export → Hextom bulk-import CSV</span>
        </header>
        <div className="flex-1 flex items-center justify-center p-8">
          <div
            onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files?.[0]; if (f) handleFile(f); }}
            className={`w-full max-w-lg rounded-xl border-2 border-dashed p-12 text-center transition-colors ${drag ? "border-indigo-400 bg-indigo-50" : "border-slate-300 bg-white"}`}
          >
            <div className="w-12 h-12 mx-auto rounded-lg bg-indigo-50 text-indigo-600 flex items-center justify-center mb-4">
              <svg width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path d="M20 7 12 3 4 7v10l8 4 8-4z" /><path d="M4 7l8 4 8-4M12 11v10" />
              </svg>
            </div>
            <p className="text-sm font-medium text-slate-900">Drop your Style Arcade export</p>
            <p className="text-xs text-slate-400 mt-1">.xlsx — one row per product/colourway</p>
            <button onClick={() => fileRef.current?.click()} disabled={busy} className="mt-4 text-sm px-4 py-2 bg-indigo-600 text-white rounded-md hover:bg-indigo-700 disabled:opacity-50">
              {busy ? "Parsing…" : "Choose file"}
            </button>
            <input ref={fileRef} type="file" accept=".xlsx" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }} />
            {error && <p className="mt-4 text-xs text-rose-600">{error}</p>}
          </div>
        </div>
      </div>
    );
  }

  const blocked = missingRequired.length > 0;
  const dataCols = outRows[0]?.length ?? 0;

  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden">
      {/* toolbar */}
      <header className="h-14 bg-white border-b border-slate-200 flex items-center justify-between px-5 shrink-0">
        <div className="flex items-center gap-3 text-sm min-w-0">
          <span className="font-semibold text-slate-900">Products → Shopify</span>
          <span className="text-slate-300">/</span>
          <span className="font-mono text-xs text-slate-500 truncate">{parsed.filename}</span>
          <span className="text-xs px-1.5 py-0.5 rounded bg-slate-100 text-slate-500">sheet: {parsed.sheetName}</span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => setShowMapping((s) => !s)}
            className={`text-xs px-3 py-1.5 rounded-md border ${showMapping ? "border-indigo-300 bg-indigo-50 text-indigo-700" : "border-slate-200 text-slate-600 hover:bg-slate-50"}`}
          >
            Columns{blocked ? ` (${missingRequired.length})` : ""}
          </button>
          <button onClick={() => setParsed(null)} className="text-xs px-3 py-1.5 rounded-md border border-slate-200 text-slate-600 hover:bg-slate-50">Re-upload</button>
          <button onClick={() => download(scenario)} disabled={blocked} className="text-xs px-3 py-1.5 rounded-md bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-40 flex items-center gap-1.5">
            <svg width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" /></svg>
            Download {scenario}
          </button>
          <button onClick={() => { download("A"); download("B"); }} disabled={blocked} className="text-xs px-3 py-1.5 rounded-md border border-slate-200 text-slate-600 hover:bg-slate-50 disabled:opacity-40">Both</button>
        </div>
      </header>

      {/* stat strip + scenario toggle */}
      <div className="bg-white border-b border-slate-200 px-5 py-2.5 flex items-center gap-5 text-sm shrink-0 flex-wrap">
        <Stat label="Products" value={analysis?.productCount ?? 0} />
        <Divider />
        <Stat label="Variant rows" value={analysis?.variantRows ?? 0} />
        <Divider />
        <Stat label="Columns out" value={dataCols} />
        <div className="ml-auto flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-xs text-slate-500">
            Season suffix
            <input value={seasonSuffix} onChange={(e) => setSeasonSuffix(e.target.value)} className="w-24 px-2 py-1 border border-slate-200 rounded text-xs font-mono" />
          </label>
          <div className="flex items-center rounded-md border border-slate-200 overflow-hidden text-xs">
            <button onClick={() => setScenario("A")} className={scenario === "A" ? "px-3 py-1.5 bg-indigo-600 text-white" : "px-3 py-1.5 text-slate-600 hover:bg-slate-50"} title="Current template — factory_cost_price only">A · current</button>
            <button onClick={() => setScenario("B")} className={scenario === "B" ? "px-3 py-1.5 bg-indigo-600 text-white" : "px-3 py-1.5 text-slate-600 hover:bg-slate-50"} title="Proposed — adds landed_cost_price">B · proposed</button>
          </div>
        </div>
      </div>

      {/* column mapping panel */}
      {showMapping && (
        <div className="bg-slate-100 border-b border-slate-200 px-5 py-3 shrink-0 max-h-64 overflow-auto thin-scroll">
          <p className="text-xs text-slate-500 mb-2">
            Map each output field to a Style Arcade column. Auto-matched by header name; correct any that are wrong. Required fields are marked <span className="text-rose-500">*</span>.
          </p>
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-2">
            {FIELDS.map((f) => {
              const val = mapping[f.key] ?? -1;
              const bad = f.required && val < 0;
              return (
                <label key={f.key} className="text-xs">
                  <span className="text-slate-500">
                    {fieldLabel(f.names)}{f.required && <span className="text-rose-500"> *</span>}
                  </span>
                  <select
                    value={val}
                    onChange={(e) => setMapping((m) => ({ ...(m as ColumnMap), [f.key]: Number(e.target.value) }))}
                    className={`mt-0.5 w-full px-2 py-1.5 bg-white border rounded text-xs ${bad ? "border-rose-300" : "border-slate-200"}`}
                  >
                    <option value={-1}>— none —</option>
                    {parsed.headers.map((h, i) => (
                      <option key={i} value={i}>{h || `Column ${i + 1}`}</option>
                    ))}
                  </select>
                </label>
              );
            })}
          </div>
        </div>
      )}

      {blocked && (
        <div className="bg-rose-50 border-b border-rose-200 px-5 py-2.5 text-sm text-rose-800 shrink-0">
          Missing required columns: <span className="font-medium">{missingRequired.map((k) => fieldLabel(FIELDS.find((f) => f.key === k)!.names)).join(", ")}</span>. Open{" "}
          <button onClick={() => setShowMapping(true)} className="underline">Columns</button> to map them.
        </div>
      )}

      {/* warnings */}
      {analysis && (analysis.unmappedSizes.length > 0 || analysis.duplicateCodes.length > 0) && (
        <div className="bg-amber-50 border-b border-amber-200 px-5 py-2 text-xs text-amber-800 shrink-0 space-y-0.5">
          {analysis.unmappedSizes.length > 0 && <p>Unrecognised size range(s): <span className="font-mono">{analysis.unmappedSizes.join(", ")}</span> — treated as a single literal size.</p>}
          {analysis.duplicateCodes.length > 0 && <p>Duplicate product code(s): <span className="font-mono">{analysis.duplicateCodes.join(", ")}</span>.</p>}
        </div>
      )}

      <div className="flex-1 min-h-0 p-5 grid grid-cols-1 xl:grid-cols-[280px_1fr] gap-5">
        {/* populated-% panel */}
        <div className="bg-white rounded-lg border border-slate-200 p-4 h-fit">
          <p className="text-xs font-semibold text-slate-700 mb-3">Column fill (spot data gaps)</p>
          <div className="space-y-2">
            {analysis?.populated.map((p) => (
              <div key={p.key} className="flex items-center gap-2 text-xs">
                <span className="w-28 truncate text-slate-600 capitalize">{p.label}</span>
                <div className="flex-1 h-2 bg-slate-100 rounded-full overflow-hidden">
                  <div className={`h-full ${p.pct >= 80 ? "bg-emerald-400" : p.pct >= 30 ? "bg-amber-400" : "bg-rose-400"}`} style={{ width: `${p.pct}%` }} />
                </div>
                <span className="w-9 text-right tabular-nums text-slate-500">{p.pct}%</span>
              </div>
            ))}
          </div>
          <p className="text-[10px] text-slate-400 mt-3">Blank fabric/colour fields are usually a source-data gap — fill them in Style Arcade, not here.</p>
        </div>

        {/* output preview */}
        <div className="bg-white rounded-lg border border-slate-200 overflow-hidden flex flex-col min-h-0">
          <div className="px-4 py-2.5 border-b border-slate-100 flex items-center justify-between shrink-0">
            <span className="text-xs font-semibold text-slate-700">Output preview — Scenario {scenario}</span>
            <span className="text-[11px] text-slate-400">all {Math.max(outRows.length - 1, 0)} variant rows · all {dataCols} columns — scroll ↔ / ↕</span>
          </div>
          <div className="flex-1 min-h-0 overflow-auto thin-scroll">
            <table className="text-xs border-collapse whitespace-nowrap">
              <thead className="sticky top-0 z-10 bg-slate-50">
                <tr className="text-left text-[10px] uppercase tracking-wide text-slate-400">
                  <th className="font-medium px-2 py-1.5 border-b border-slate-200 text-right sticky left-0 z-20 bg-slate-50">#</th>
                  {outRows[0]?.map((h, i) => (
                    <th key={i} className="font-medium px-2 py-1.5 border-b border-slate-200">{shortHead(h)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {outRows.slice(1).map((r, ri) => {
                  const isProductStart = r[0] !== "";
                  const rowBg = isProductStart ? "bg-slate-50" : "bg-white";
                  return (
                    <tr key={ri} className={isProductStart ? "border-t-2 border-slate-200" : ""}>
                      <td className={`px-2 py-1 border-b border-slate-50 text-right tabular-nums text-slate-300 select-none sticky left-0 z-10 ${rowBg}`}>{ri + 1}</td>
                      {r.map((c, ci) => (
                        <td key={ci} className={`px-2 py-1 border-b border-slate-50 ${ci === 5 ? "font-mono text-slate-500" : ci === 6 || ci === 7 ? "font-mono tabular-nums text-slate-700" : ci === 0 ? "font-medium text-slate-700" : "text-slate-600"} ${c === "" ? "text-slate-300" : ""}`}>
                          {String(c) || "·"}
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="px-4 py-2 text-[10px] text-slate-400 border-t border-slate-100 shrink-0">
            Each shaded row is a new product (Title + metafields); the blank <span className="font-mono">·</span> rows beneath are its other sizes — that&apos;s how Hextom groups variants into one product. The <span className="font-mono">#</span> column stays pinned while you scroll across all {dataCols} columns.
          </p>
        </div>
      </div>
    </div>
  );
}

function shortHead(h: string): string {
  return h.replace(/^Metafield: custom\./, "").replace(/ \[.*\]$/, "");
}
function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-slate-400 text-xs">{label}</span>
      <span className="font-semibold font-mono">{value}</span>
    </div>
  );
}
function Divider() {
  return <div className="w-px h-5 bg-slate-200" />;
}
