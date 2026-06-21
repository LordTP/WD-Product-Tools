"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { convertRows } from "@/lib/shiphero/convert";
import { buildSourceRows, PO_FIELDS, type PoField } from "@/lib/shiphero/fields";
import type { VendorMap, PoGroup } from "@/lib/shiphero/types";
import type { ShipheroVendor } from "@/db/schema";
import type { AliasRow } from "@/lib/vendors";

type Mapping = Record<PoField, number | null>;
type Edits = Record<number, { quantity?: string; price?: string }>;

interface ParsedSheet {
  filename: string;
  headers: string[];
  rows: string[][];
  mapping: Mapping;
  rowCount: number;
}

function vendorMapFrom(aliases: AliasRow[]): VendorMap {
  const map: VendorMap = {};
  for (const a of aliases) {
    map[a.alias.trim().toUpperCase()] = { shipheroName: a.name, vendorId: a.shipheroId };
  }
  return map;
}

export function PoConverter({
  initialShipheroVendors,
  initialAliases,
  statuses,
  sizeMap,
  shipheroConnected,
}: {
  initialShipheroVendors: ShipheroVendor[];
  initialAliases: AliasRow[];
  statuses: string[];
  sizeMap: import("@/lib/sizes").SizeMap;
  shipheroConnected: boolean;
}) {
  const [shipheroVendors, setShipheroVendors] = useState(initialShipheroVendors);
  const [aliases, setAliases] = useState(initialAliases);
  const [parsed, setParsed] = useState<ParsedSheet | null>(null);
  const [mapping, setMapping] = useState<Mapping | null>(null);
  const [statusByPo, setStatusByPo] = useState<Record<string, string>>({});
  const [edits, setEdits] = useState<Edits>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showMapping, setShowMapping] = useState(false);
  const [pushOpen, setPushOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const vendorMap = useMemo(() => vendorMapFrom(aliases), [aliases]);

  const result = useMemo(() => {
    if (!parsed || !mapping) return null;
    const rows = buildSourceRows(parsed.rows, mapping).map((r) => ({
      ...r,
      quantity: edits[r.sourceRow]?.quantity ?? r.quantity,
      factoryCost: edits[r.sourceRow]?.price ?? r.factoryCost,
    }));
    // Sell-ahead is unused at Wander Doll — always 0 (convertRows defaults it).
    return convertRows(rows, vendorMap, { statusByPo, knownStatuses: statuses, sizeMap });
  }, [parsed, mapping, vendorMap, statusByPo, statuses, sizeMap, edits]);

  async function handleFile(file: File) {
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/po/parse", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to parse file.");
      setParsed(data);
      setMapping(data.mapping);
      setStatusByPo({});
      setEdits({});
      const missing = PO_FIELDS.filter((f) => f.required && data.mapping[f.key] == null);
      setShowMapping(missing.length > 0);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to parse file.");
    } finally {
      setBusy(false);
    }
  }

  async function refreshVendors() {
    const res = await fetch("/api/vendors");
    const data = await res.json();
    setShipheroVendors(data.shipheroVendors);
    setAliases(data.aliases);
  }

  function reset() {
    setParsed(null);
    setMapping(null);
    setError(null);
  }

  function downloadCsv() {
    if (!result?.csv) return;
    const today = new Date().toISOString().slice(0, 10);
    const blob = new Blob([result.csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `wander_doll_shiphero_po_upload_${today}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (!parsed || !mapping) {
    return <Dropzone busy={busy} error={error} fileRef={fileRef} onFile={handleFile} />;
  }

  const requiredUnmapped = PO_FIELDS.filter((f) => f.required && mapping[f.key] == null);
  const mappedVendorCount = result ? result.pos.filter((p) => p.vendorResolved).length : 0;
  const statusNeedsEdit = result ? result.pos.filter((p) => !p.statusResolved).length : 0;
  const pushablePos = result
    ? result.pos.filter((p) => p.vendorResolved && p.vendorId != null && p.statusResolved && p.lines.every((l) => l.status === "ok"))
    : [];
  const canPush = shipheroConnected && result != null && result.ready && pushablePos.length > 0;

  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden">
      {/* Toolbar */}
      <header className="h-14 bg-white border-b border-slate-200 flex items-center justify-between px-5 shrink-0">
        <div className="flex items-center gap-3 text-sm min-w-0">
          <span className="font-semibold text-slate-900">PO → ShipHero</span>
          <span className="text-slate-300">/</span>
          <span className="font-mono text-xs text-slate-500 truncate">{parsed.filename}</span>
          <span className="text-xs px-1.5 py-0.5 rounded bg-slate-100 text-slate-500 shrink-0">
            {parsed.rowCount} rows
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => setShowMapping((s) => !s)}
            className={`text-xs px-3 py-1.5 rounded-md border ${
              showMapping
                ? "border-indigo-300 bg-indigo-50 text-indigo-700"
                : "border-slate-200 text-slate-600 hover:bg-slate-50"
            }`}
          >
            Columns
          </button>
          <button
            onClick={reset}
            className="text-xs px-3 py-1.5 rounded-md border border-slate-200 text-slate-600 hover:bg-slate-50"
          >
            Re-upload
          </button>
          <button
            onClick={downloadCsv}
            disabled={!result?.ready}
            className={`text-xs px-3 py-1.5 rounded-md flex items-center gap-1.5 font-medium ${
              result?.ready
                ? "bg-white border border-slate-200 text-slate-700 hover:bg-slate-50"
                : "bg-slate-100 text-slate-400 cursor-not-allowed border border-slate-200"
            }`}
          >
            <svg width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />
            </svg>
            Download CSV
          </button>
          <button
            onClick={() => setPushOpen(true)}
            disabled={!canPush}
            title={
              !shipheroConnected
                ? "Connect ShipHero to push"
                : pushablePos.length === 0
                  ? "Resolve vendors/statuses first"
                  : "Review and push to ShipHero"
            }
            className={`text-xs px-3 py-1.5 rounded-md flex items-center gap-1.5 font-medium ${
              canPush ? "bg-indigo-600 text-white hover:bg-indigo-700" : "bg-slate-200 text-slate-400 cursor-not-allowed"
            }`}
          >
            <svg width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z" />
            </svg>
            Push to ShipHero{pushablePos.length > 0 ? ` (${pushablePos.length})` : ""}
          </button>
        </div>
      </header>

      {/* Stat strip */}
      <div className="bg-white border-b border-slate-200 px-5 py-2.5 flex items-center gap-5 text-sm shrink-0 flex-wrap">
        <Stat label="POs" value={result?.summary.poCount ?? 0} />
        <Divider />
        <Stat label="Lines" value={result?.summary.lineCount ?? 0} />
        <Divider />
        <Stat label="Units" value={(result?.summary.totalUnits ?? 0).toLocaleString()} />
        <Divider />
        <div className="flex items-center gap-2">
          <span className="text-slate-400 text-xs">Vendors</span>
          <span className="font-semibold font-mono">
            {mappedVendorCount}/{result?.pos.length ?? 0}
          </span>
          {result && result.unmappedAliases.length > 0 && (
            <span className="text-xs px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">
              {result.unmappedAliases.length} unmapped
            </span>
          )}
        </div>
        {statusNeedsEdit > 0 && (
          <>
            <Divider />
            <span className="text-xs px-1.5 py-0.5 rounded bg-rose-100 text-rose-700">
              {statusNeedsEdit} status{statusNeedsEdit === 1 ? "" : "es"} need editing
            </span>
          </>
        )}
      </div>

      {/* Column mapping (collapsible) */}
      {showMapping && (
        <div className="bg-slate-100 border-b border-slate-200 px-5 py-3 shrink-0">
          <p className="text-xs text-slate-500 mb-2">
            Map your sheet&apos;s columns to ShipHero fields — changes preview instantly. Required fields are marked.
          </p>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            {PO_FIELDS.map((f) => (
              <label key={f.key} className="text-xs">
                <span className="text-slate-500">
                  {f.label}
                  {f.required && <span className="text-rose-500"> *</span>}
                </span>
                <select
                  value={mapping[f.key] ?? ""}
                  onChange={(e) =>
                    setMapping({
                      ...mapping,
                      [f.key]: e.target.value === "" ? null : Number(e.target.value),
                    })
                  }
                  className={`mt-0.5 w-full px-2 py-1.5 bg-white border rounded text-xs ${
                    f.required && mapping[f.key] == null ? "border-rose-300" : "border-slate-200"
                  }`}
                >
                  <option value="">— none —</option>
                  {parsed.headers.map((h, i) => (
                    <option key={i} value={i}>
                      {h || `Column ${i + 1}`}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
        </div>
      )}

      {/* Blocking: unmapped vendors */}
      {result && result.unmappedAliases.length > 0 && (
        <UnmappedBanner
          aliases={result.unmappedAliases}
          shipheroVendors={shipheroVendors}
          onSaved={refreshVendors}
        />
      )}

      {/* Required-field block */}
      {requiredUnmapped.length > 0 && (
        <div className="bg-rose-50 border-b border-rose-200 px-5 py-2.5 text-sm text-rose-800 shrink-0">
          Missing required column mapping:{" "}
          <span className="font-medium">{requiredUnmapped.map((f) => f.label).join(", ")}</span>. Open{" "}
          <button onClick={() => setShowMapping(true)} className="underline">Columns</button> to fix.
        </div>
      )}

      {/* Data grid — grouped by PO */}
      <div className="flex-1 min-h-0 overflow-auto bg-white thin-scroll">
        <table className="w-full text-sm border-collapse">
          <thead className="sticky top-0 bg-slate-100 z-10">
            <tr className="text-left text-[11px] uppercase tracking-wide text-slate-400">
              <th className="font-medium px-4 py-2 border-b border-slate-200 w-20">Size</th>
              <th className="font-medium px-4 py-2 border-b border-slate-200">SKU</th>
              <th className="font-medium px-4 py-2 border-b border-slate-200 text-right w-24">Qty</th>
              <th className="font-medium px-4 py-2 border-b border-slate-200 text-right w-24">Price</th>
              <th className="font-medium px-4 py-2 border-b border-slate-200 text-center w-20">Status</th>
            </tr>
          </thead>
          <tbody>
            {result?.pos.map((po) => (
              <PoGroupRows
                key={po.poNumber}
                po={po}
                statuses={statuses}
                onStatusChange={(s) =>
                  setStatusByPo((prev) => ({ ...prev, [po.poNumber]: s }))
                }
                edits={edits}
                onEdit={(row, field, value) =>
                  setEdits((e) => ({ ...e, [row]: { ...e[row], [field]: value } }))
                }
              />
            ))}
          </tbody>
        </table>
      </div>

      {/* Status bar */}
      <footer className="h-8 bg-slate-100 border-t border-slate-200 text-slate-500 text-[11px] flex items-center px-5 gap-4 shrink-0 font-mono">
        <span>{result?.summary.lineCount ?? 0} lines parsed</span>
        <span className="text-emerald-600">
          {result ? result.lines.filter((l) => l.status === "ok").length : 0} valid
        </span>
        {result && result.errors.length > 0 && (
          <span className="text-rose-600">
            {result.lines.filter((l) => l.status === "blocked").length} blocked
          </span>
        )}
        {result && result.warnings.length > 0 && (
          <span className="text-amber-600">{result.warnings.length} warnings</span>
        )}
        <span className="ml-auto">header: shiphero_v3 {result?.ready ? "✓" : "—"}</span>
        <span>quoting: minimal ✓</span>
      </footer>

      {pushOpen && (
        <PushModal pushablePos={pushablePos} onClose={() => setPushOpen(false)} />
      )}
    </div>
  );
}

// ---------- subcomponents ----------

interface PreflightRow {
  poNumber: string;
  ok: boolean;
  reasons: string[];
  units: number;
  lineCount: number;
  vendor: string;
  status: string;
}
interface PushRow {
  poNumber: string;
  ok: boolean;
  shipheroId?: string;
  error?: string;
}

function PushModal({ pushablePos, onClose }: { pushablePos: PoGroup[]; onClose: () => void }) {
  const [phase, setPhase] = useState<"checking" | "ready" | "pushing" | "done">("checking");
  const [error, setError] = useState<string | null>(null);
  const [warehouseId, setWarehouseId] = useState<string>("");
  const [rows, setRows] = useState<PreflightRow[]>([]);
  const [missingSkus, setMissingSkus] = useState<string[]>([]);
  const [pushResults, setPushResults] = useState<PushRow[]>([]);

  // Run READ-ONLY pre-flight when the modal opens.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/po/preflight", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pos: pushablePos }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Pre-flight failed.");
        if (cancelled) return;
        setRows(data.rows);
        setWarehouseId(data.warehouseId);
        setMissingSkus(data.missingSkus ?? []);
        setPhase("ready");
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Pre-flight failed.");
          setPhase("ready");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pushablePos]);

  const okRows = rows.filter((r) => r.ok);
  const okPoNumbers = new Set(okRows.map((r) => r.poNumber));
  const okPos = pushablePos.filter((p) => okPoNumbers.has(p.poNumber));
  const totalUnits = okRows.reduce((a, r) => a + r.units, 0);
  const totalLines = okRows.reduce((a, r) => a + r.lineCount, 0);

  async function confirmPush() {
    setPhase("pushing");
    setError(null);
    try {
      const res = await fetch("/api/po/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pos: okPos }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Push failed.");
      setPushResults(data.results);
      setPhase("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Push failed.");
      setPhase("ready");
    }
  }

  const pushedOk = pushResults.filter((r) => r.ok).length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[85vh] flex flex-col">
        <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
          <h2 className="text-base font-bold text-slate-900">
            {phase === "done" ? "Push complete" : "Push to ShipHero"}
          </h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700 text-lg leading-none">×</button>
        </div>

        <div className="flex-1 overflow-auto p-5">
          {phase === "checking" && (
            <p className="text-sm text-slate-500">Running pre-flight checks against ShipHero…</p>
          )}

          {error && (
            <div className="mb-4 text-xs bg-rose-50 border border-rose-200 text-rose-700 rounded p-2">{error}</div>
          )}

          {phase !== "checking" && phase !== "done" && (
            <>
              <div className="mb-4 grid grid-cols-3 gap-3 text-center">
                <Box label="POs to create" value={okRows.length} />
                <Box label="Line items" value={totalLines} />
                <Box label="Total units" value={totalUnits.toLocaleString()} />
              </div>
              <p className="text-xs text-slate-400 mb-3">
                Warehouse: <span className="font-mono">{warehouseId || "—"}</span> · This creates real POs in
                ShipHero. Nothing is sent until you click Confirm.
              </p>
              <div className="border border-slate-200 rounded-lg overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-left text-[11px] uppercase tracking-wide text-slate-400">
                    <tr>
                      <th className="font-medium px-3 py-2">PO</th>
                      <th className="font-medium px-3 py-2">Vendor</th>
                      <th className="font-medium px-3 py-2">Status</th>
                      <th className="font-medium px-3 py-2 text-right">Units</th>
                      <th className="font-medium px-3 py-2">Check</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.poNumber} className="border-t border-slate-100">
                        <td className="px-3 py-1.5 font-mono text-xs">{r.poNumber}</td>
                        <td className="px-3 py-1.5 text-[13px] text-slate-600 max-w-[12rem] truncate">{r.vendor}</td>
                        <td className="px-3 py-1.5 text-xs">{r.status || "—"}</td>
                        <td className="px-3 py-1.5 text-right font-mono text-xs">{r.units}</td>
                        <td className="px-3 py-1.5">
                          {r.ok ? (
                            <span className="text-xs text-emerald-600">✓ ready</span>
                          ) : (
                            <span className="text-xs text-rose-600" title={r.reasons.join("; ")}>
                              ✕ {r.reasons[0]}
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {missingSkus.length > 0 && (
                <div className="mt-3 text-xs bg-amber-50 border border-amber-200 rounded p-2">
                  <p className="text-amber-800 font-medium">
                    {missingSkus.length} SKU{missingSkus.length === 1 ? "" : "s"} not found in ShipHero — those POs can&apos;t be pushed until the products exist:
                  </p>
                  <p className="mt-1 font-mono text-[11px] text-amber-700 break-words">{missingSkus.slice(0, 20).join(", ")}{missingSkus.length > 20 ? "…" : ""}</p>
                </div>
              )}
              {rows.some((r) => !r.ok) && (
                <p className="text-xs text-amber-700 mt-2">
                  Blocked POs won&apos;t be pushed. Fix them (vendor / status / duplicate / missing SKU) and reopen.
                </p>
              )}
            </>
          )}

          {phase === "done" && (
            <div>
              <p className="text-sm font-medium text-slate-800 mb-3">
                Created {pushedOk} of {pushResults.length} POs in ShipHero.
              </p>
              <div className="border border-slate-200 rounded-lg overflow-hidden">
                <table className="w-full text-sm">
                  <tbody>
                    {pushResults.map((r) => (
                      <tr key={r.poNumber} className="border-t border-slate-100">
                        <td className="px-3 py-1.5 font-mono text-xs">{r.poNumber}</td>
                        <td className="px-3 py-1.5">
                          {r.ok ? (
                            <span className="text-xs text-emerald-600">✓ created{r.shipheroId ? "" : ""}</span>
                          ) : (
                            <span className="text-xs text-rose-600">✕ {r.error}</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-slate-200 flex items-center justify-end gap-2">
          <button onClick={onClose} className="text-xs px-4 py-2 rounded-md border border-slate-200 text-slate-600">
            {phase === "done" ? "Close" : "Cancel"}
          </button>
          {phase !== "done" && (
            <button
              onClick={confirmPush}
              disabled={phase !== "ready" || okRows.length === 0}
              className="text-xs font-medium px-4 py-2 rounded-md bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-40"
            >
              {phase === "pushing" ? "Pushing…" : `Confirm & push ${okRows.length} PO${okRows.length === 1 ? "" : "s"}`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Box({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="bg-slate-50 rounded-lg py-3">
      <p className="text-xl font-bold text-slate-900">{value}</p>
      <p className="text-xs text-slate-400">{label}</p>
    </div>
  );
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

function PoGroupRows({
  po,
  statuses,
  onStatusChange,
  edits,
  onEdit,
}: {
  po: PoGroup;
  statuses: string[];
  onStatusChange: (status: string) => void;
  edits: Edits;
  onEdit: (row: number, field: "quantity" | "price", value: string) => void;
}) {
  return (
    <>
      {/* group header: PO · product · vendor · units · status */}
      <tr className="bg-slate-100/80 border-y border-slate-200">
        <td colSpan={5} className="px-4 py-2">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono text-xs font-semibold text-slate-700">{po.poNumber}</span>
            {po.title ? (
              <span className="text-[13px] font-medium text-slate-800">{po.title}</span>
            ) : po.productCount > 1 ? (
              <span className="text-[13px] text-slate-500">{po.productCount} products</span>
            ) : null}
            <span className="text-slate-300">·</span>
            <span
              className={`text-xs ${po.vendorResolved ? "text-slate-500" : "text-amber-700 italic font-medium"}`}
            >
              {po.vendorResolved ? po.vendor : `${po.alias} — unmapped vendor`}
            </span>
            <span className="text-slate-300">·</span>
            <span className="text-xs text-slate-500">{po.totalUnits.toLocaleString()} units</span>

            <span className="ml-auto inline-flex items-center gap-2">
              {!po.statusResolved && (
                <span
                  className="text-[10px] uppercase tracking-wide text-rose-600 font-medium"
                  title={po.statusSource ? `“${po.statusSource}” isn’t a known status — pick one` : "Pick a status"}
                >
                  edit status
                </span>
              )}
              <select
                value={po.status}
                onChange={(e) => onStatusChange(e.target.value)}
                title="PO status"
                className={`text-xs px-2 py-1 rounded border bg-white ${
                  po.statusResolved ? "border-slate-200 text-slate-600" : "border-rose-300 text-rose-700"
                }`}
              >
                {!po.statusResolved && <option value="">— status —</option>}
                {statuses.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </span>
          </div>
        </td>
      </tr>
      {/* size-level lines */}
      {po.lines.map((l, i) => (
        <tr
          key={l.sourceRow}
          className={
            l.status === "blocked"
              ? "bg-amber-50/60"
              : i % 2 === 1
                ? "bg-slate-50/60 hover:bg-indigo-50/50"
                : "hover:bg-indigo-50/50"
          }
        >
          <td className="px-4 py-1.5 border-b border-slate-100 font-mono text-xs font-medium text-slate-700">
            {l.size || "—"}
          </td>
          <td className="px-4 py-1.5 border-b border-slate-100 font-mono text-xs text-slate-500">
            {l.sku || <span className="text-rose-500 italic">missing</span>}
          </td>
          <td className="px-2 py-1 border-b border-slate-100 text-right">
            <input
              value={edits[l.sourceRow]?.quantity ?? l.quantity}
              onChange={(e) => onEdit(l.sourceRow, "quantity", e.target.value)}
              className="w-16 px-1.5 py-0.5 text-right font-mono text-xs bg-transparent hover:bg-white hover:ring-1 hover:ring-slate-200 focus:bg-white focus:ring-1 focus:ring-indigo-300 rounded outline-none"
            />
          </td>
          <td className="px-2 py-1 border-b border-slate-100 text-right">
            <input
              value={edits[l.sourceRow]?.price ?? l.price}
              onChange={(e) => onEdit(l.sourceRow, "price", e.target.value)}
              className="w-16 px-1.5 py-0.5 text-right font-mono text-xs bg-transparent hover:bg-white hover:ring-1 hover:ring-slate-200 focus:bg-white focus:ring-1 focus:ring-indigo-300 rounded outline-none"
            />
          </td>
          <td className="px-4 py-1.5 border-b border-slate-100 text-center">
            {l.status === "ok" ? (
              <span className="px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 text-xs">ok</span>
            ) : (
              <span
                className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 text-xs"
                title={l.blockReason}
              >
                {l.blockReason?.includes("vendor") || l.blockReason?.includes("supplier") ? "vendor?" : "fix"}
              </span>
            )}
          </td>
        </tr>
      ))}
    </>
  );
}

function UnmappedBanner({
  aliases,
  shipheroVendors,
  onSaved,
}: {
  aliases: string[];
  shipheroVendors: ShipheroVendor[];
  onSaved: () => Promise<void>;
}) {
  return (
    <div className="bg-amber-50 border-b border-amber-200 px-5 py-3 shrink-0 space-y-2">
      <p className="text-sm text-amber-900 font-medium">
        {aliases.length} supplier {aliases.length === 1 ? "alias has" : "aliases have"} no ShipHero
        vendor mapping — download is blocked until resolved.
      </p>
      {aliases.map((alias) => (
        <ResolveRow key={alias} alias={alias} shipheroVendors={shipheroVendors} onSaved={onSaved} />
      ))}
    </div>
  );
}

function ResolveRow({
  alias,
  shipheroVendors,
  onSaved,
}: {
  alias: string;
  shipheroVendors: ShipheroVendor[];
  onSaved: () => Promise<void>;
}) {
  const [choice, setChoice] = useState<string>(""); // vendor id, or "__new__"
  const [newName, setNewName] = useState("");
  const [newId, setNewId] = useState("");
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      const body =
        choice === "__new__"
          ? { alias, newVendorName: newName.trim(), newVendorId: newId.trim() || null }
          : { alias, vendorId: Number(choice) };
      await fetch("/api/vendors/alias", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      await onSaved();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="font-mono text-xs px-2 py-1.5 bg-white border border-amber-200 rounded">{alias}</span>
      <span className="text-amber-400">→</span>
      <select
        value={choice}
        onChange={(e) => setChoice(e.target.value)}
        className="text-xs px-2 py-1.5 bg-white border border-amber-200 rounded max-w-md"
      >
        <option value="">Select ShipHero vendor…</option>
        {shipheroVendors.map((v) => (
          <option key={v.id} value={v.id}>
            {v.name}
          </option>
        ))}
        <option value="__new__">+ Add a new ShipHero vendor…</option>
      </select>
      {choice === "__new__" && (
        <>
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Exact ShipHero vendor name"
            className="text-xs px-2 py-1.5 bg-white border border-amber-200 rounded w-64"
          />
          <input
            value={newId}
            onChange={(e) => setNewId(e.target.value)}
            placeholder="Vendor ID (optional)"
            className="text-xs px-2 py-1.5 bg-white border border-amber-200 rounded w-32"
          />
        </>
      )}
      <button
        onClick={save}
        disabled={saving || !choice || (choice === "__new__" && !newName.trim())}
        className="text-xs font-medium px-3 py-1.5 bg-amber-500 text-white rounded disabled:opacity-40"
      >
        {saving ? "Saving…" : "Map & save"}
      </button>
    </div>
  );
}

function Dropzone({
  busy,
  error,
  fileRef,
  onFile,
}: {
  busy: boolean;
  error: string | null;
  fileRef: React.RefObject<HTMLInputElement | null>;
  onFile: (f: File) => void;
}) {
  const [drag, setDrag] = useState(false);
  return (
    <div className="flex-1 flex flex-col">
      <header className="h-14 bg-white border-b border-slate-200 flex items-center px-5 shrink-0">
        <span className="font-semibold text-sm text-slate-900">PO → ShipHero</span>
        <span className="ml-3 text-xs text-slate-400">
          Convert a purchase-order sheet into ShipHero&apos;s bulk-upload CSV
        </span>
      </header>
      <div className="flex-1 flex items-center justify-center p-8">
        <div
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            const f = e.dataTransfer.files?.[0];
            if (f) onFile(f);
          }}
          className={`w-full max-w-lg rounded-xl border-2 border-dashed p-12 text-center transition-colors ${
            drag ? "border-indigo-400 bg-indigo-50" : "border-slate-300 bg-white"
          }`}
        >
          <div className="w-12 h-12 mx-auto rounded-lg bg-indigo-50 text-indigo-600 flex items-center justify-center mb-4">
            <svg width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <path d="M14 2v6h6M12 18v-6M9 15l3 3 3-3" />
            </svg>
          </div>
          <p className="text-sm font-medium text-slate-900">Drop your PO sheet here</p>
          <p className="text-xs text-slate-400 mt-1">.xlsx or .csv — one row per size/variant</p>
          <button
            onClick={() => fileRef.current?.click()}
            disabled={busy}
            className="mt-4 text-sm px-4 py-2 bg-indigo-600 text-white rounded-md hover:bg-indigo-700 disabled:opacity-50"
          >
            {busy ? "Parsing…" : "Choose file"}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".xlsx,.csv,.txt"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onFile(f);
            }}
          />
          {error && <p className="mt-4 text-xs text-rose-600">{error}</p>}
        </div>
      </div>
    </div>
  );
}
