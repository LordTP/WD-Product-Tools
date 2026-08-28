"use client";

// PO History — the merch team's view of every purchase order in the local cache.
// Layout: header (search) → status strip (click = filter) → filter chips →
// table (progress + three dates) → footer totals. Ticking rows floats a bulk
// bar; clicking a row opens a side drawer (dates, sizes, edit, date history).
// Reads are cache-only; every ShipHero write goes through an explicit confirm.

import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import Papa from "papaparse";
import type { PoSummary, PoDetail, PoLineDetail } from "@/lib/shiphero/po-pull";
import { deriveSizeFromSku, type SizeMap } from "@/lib/sizes";
import { normalizeSheetDate, ukDate } from "@/lib/shiphero/dates";

interface PoDatesRow {
  orderSent: string | null;
  exFactory: string | null;
  delivery: string | null;
}
interface DateChange { poNumber: string; delivery?: string; exFactory?: string; orderSent?: string }
interface BulkConfirm {
  title: string;
  field: "delivery" | "exFactory" | "orderSent";
  changes: Array<DateChange & { old: string | null }>;
}
interface DateLogRow { id: number; field: string; oldValue: string | null; newValue: string | null; changedAt: string }

// ---------- helpers ----------
function fmtPrice(p: string): string {
  if (!p) return "—";
  const n = Number(p);
  return Number.isNaN(n) ? p : n.toFixed(2);
}
const gbp = (n: number) => `£${Math.round(n).toLocaleString("en-GB")}`;
const money = (p: string | null) => (p ? Number(p) || 0 : 0);

function sinceFromMonths(months: number | null): string {
  if (months === null) return "2020-01-01";
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

const pad = (x: number) => String(x).padStart(2, "0");
function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function daysFrom(iso: string): number {
  return Math.round((Date.parse(`${iso}T00:00:00`) - Date.parse(`${todayIso()}T00:00:00`)) / 86_400_000);
}
function shiftIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
// Delivered = booked in at Wander Doll, so it counts as finished alongside
// closed/cancelled: Closed view, no lateness, no missing-date nagging.
const isClosedStatus = (s: string) => /deliver|close|cancel/i.test(s);
const isDoneStatus = isClosedStatus;

type Tone = "late" | "soon" | "missing" | "";
function rel(iso: string | null, closed: boolean): { text: string; tone: Tone } {
  if (!iso) return { text: "not set", tone: closed ? "" : "missing" };
  const d = daysFrom(iso);
  if (closed) return { text: d < 0 ? `${-d}d ago` : "", tone: "" };
  if (d < 0) return { text: `${-d} day${d === -1 ? "" : "s"} late`, tone: "late" };
  if (d === 0) return { text: "today", tone: "soon" };
  if (d <= 7) return { text: `in ${d} day${d === 1 ? "" : "s"}`, tone: "soon" };
  if (d <= 30) return { text: `in ${Math.round(d / 7)} wk`, tone: "" };
  return { text: `in ${Math.round(d / 30)} mo`, tone: "" };
}

// Wander Doll's ShipHero PO statuses in journey order (free text in ShipHero).
const STATUS_ORDER = ["shipment being quoted", "shipment arranged", "on order", "ready to ship", "in transit", "delivered", "pending", "closed", "canceled"];
const statusRank = (s: string) => {
  const i = STATUS_ORDER.indexOf(s.trim().toLowerCase());
  return i === -1 ? 50 : i;
};
function statusClass(s: string): string {
  const k = s.toLowerCase();
  if (k.includes("cancel")) return "bg-rose-100 text-rose-700";
  if (k.includes("close")) return "bg-emerald-100 text-emerald-700";
  if (k.includes("deliver")) return "bg-cyan-100 text-cyan-800";
  if (k.includes("transit") || k.includes("ready")) return "bg-indigo-100 text-indigo-700";
  if (k.includes("quot") || k.includes("arrang") || k.includes("on order")) return "bg-amber-100 text-amber-700";
  return "bg-slate-100 text-slate-600";
}
function statusDot(s: string): string {
  const k = s.toLowerCase();
  if (k.includes("cancel")) return "#be123c";
  if (k.includes("close")) return "#059669";
  if (k.includes("deliver")) return "#0e7490";
  if (k.includes("transit") || k.includes("ready")) return "#4338ca";
  if (k.includes("quot") || k.includes("arrang") || k.includes("on order")) return "#b45309";
  return "#64748b";
}

// "Dongguan Jinfeng Apparel Co. Ltd (Sandra)" → { short: "Sandra", full: "Dongguan Jinfeng…" }
function vendorParts(name: string | null): { short: string; full: string } {
  if (!name) return { short: "—", full: "" };
  const m = name.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
  return m ? { short: m[2], full: m[1] } : { short: name, full: "" };
}
// "ATHENA DRAPE TOP | BABY PINK" → { name, colour }
function productParts(p: string): { name: string; colour: string } {
  const i = p.indexOf(" | ");
  return i === -1 ? { name: p, colour: "" } : { name: p.slice(0, i), colour: p.slice(i + 3) };
}
const familyOf = (p: PoSummary) => (p.products[0] ?? "").split(/\s+/)[0] || "";

type SortKey = "po" | "product" | "vendor" | "status" | "progress" | "sent" | "exf" | "expected" | "value";
type WindowF = "" | "week" | "14" | "30" | "overdue" | "unset";
const WINDOW_LABEL: Record<WindowF, string> = { "": "", week: "this week", "14": "next 14 days", "30": "next 30 days", overdue: "overdue", unset: "not set" };

// ---------- small UI bits ----------
function Chip({ label, valueText, active, onClear, children }: {
  label: string; valueText?: string | null; active: boolean; onClear: () => void;
  children: (close: () => void) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-full border text-xs ${active ? "bg-indigo-50 border-indigo-400 text-indigo-800 font-medium" : "bg-white border-slate-300 text-slate-700 hover:border-slate-400"}`}
      >
        {label}{active && valueText ? `: ${valueText}` : ""}
        {active ? (
          <span onClick={(e) => { e.stopPropagation(); onClear(); }} className="text-indigo-400 hover:text-indigo-700 leading-none ml-0.5" title="Clear">✕</span>
        ) : (
          <span className="text-slate-400 text-[9px]">▼</span>
        )}
      </button>
      {open && (
        <div className="absolute left-0 top-full mt-1 z-30 bg-white border border-slate-200 rounded-lg shadow-lg min-w-[240px] max-h-80 overflow-auto p-1 thin-scroll">
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}
function Opt({ label, count, on, onClick, dot }: { label: string; count?: number; on: boolean; onClick: () => void; dot?: string }) {
  return (
    <button onClick={onClick} className={`w-full text-left flex items-center gap-2 px-2.5 py-1.5 rounded-md text-xs ${on ? "bg-indigo-50 text-indigo-800 font-medium" : "text-slate-700 hover:bg-slate-50"}`}>
      {dot && <span className="w-2 h-2 rounded-full shrink-0" style={{ background: dot }} />}
      <span className="truncate flex-1">{label}</span>
      {count != null && <span className="text-slate-400 tabular-nums">{count}</span>}
    </button>
  );
}
function Toggle({ on, label, onClick }: { on: boolean; label: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className={`inline-flex items-center gap-2 text-xs ${on ? "text-indigo-800 font-medium" : "text-slate-500"}`}>
      <span className={`w-7 h-4 rounded-full relative transition-colors ${on ? "bg-indigo-600" : "bg-slate-300"}`}>
        <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-all ${on ? "left-3.5" : "left-0.5"}`} />
      </span>
      {label}
    </button>
  );
}
function DateCell({ iso, closed }: { iso: string | null; closed: boolean }) {
  const r = rel(iso, closed);
  const sub = r.tone === "late" ? "text-rose-600 font-semibold" : r.tone === "soon" ? "text-amber-600 font-semibold" : r.tone === "missing" ? "text-amber-600" : "text-slate-400";
  return (
    <span className={`font-mono text-[11.5px] whitespace-nowrap ${iso ? "text-slate-700" : "text-slate-300"}`}>
      {iso ? ukDate(iso) : "—"}
      {r.text && <span className={`block font-sans text-[10.5px] ${sub}`}>{r.text}</span>}
    </span>
  );
}

// ---------- page ----------
export function PoHistory({ shipheroConnected, statuses, sizeMap }: { shipheroConnected: boolean; statuses: string[]; sizeMap: SizeMap }) {
  const [rangeMonths, setRangeMonths] = useState<number | null>(12);
  const [mappedOnly, setMappedOnly] = useState(true);
  const [query, setQuery] = useState("");
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
  const [datesByPo, setDatesByPo] = useState<Record<string, PoDatesRow>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkApplying, setBulkApplying] = useState(false);
  const [bulkMsg, setBulkMsg] = useState<string | null>(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [bulkConfirm, setBulkConfirm] = useState<BulkConfirm | null>(null);
  const [bulkPanel, setBulkPanel] = useState<null | "date" | "shift" | "exf" | "status">(null);
  const [bulkDate, setBulkDate] = useState("");
  const [bulkShift, setBulkShift] = useState("14");
  const [bulkStatus, setBulkStatus] = useState("");
  const [statusConfirm, setStatusConfirm] = useState<{ status: string; poNumbers: string[] } | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  // filters
  const [view, setView] = useState<"open" | "all" | "closed">("open");
  const [statusF, setStatusF] = useState<string | null>(null);
  const [lateOnly, setLateOnly] = useState(false);
  const [vendorF, setVendorF] = useState<string | null>(null);
  const [windowF, setWindowF] = useState<WindowF>("");
  const [familyF, setFamilyF] = useState<string | null>(null);
  const [missingOnly, setMissingOnly] = useState(false);
  const [overOnly, setOverOnly] = useState(false);
  const [groupByVendor, setGroupByVendor] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "expected", dir: 1 });
  const lastTick = useRef<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const moreRef = useRef<HTMLDivElement>(null);

  // ---- data (local cache — no ShipHero credits) ----
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
  useEffect(() => { load(); }, [load]);

  async function sync(full = false) {
    if (!shipheroConnected) return;
    setSyncing(true);
    setError(null);
    try {
      const res = await fetch("/api/po/sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ since: sinceFromMonths(rangeMonths), full }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Sync failed.");
      await load();
      setLastSyncedAt(data.syncedAt);
      setSyncMsg(data.count > 0 ? `${data.count} PO${data.count === 1 ? "" : "s"} updated` : "up to date");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sync failed.");
    } finally {
      setSyncing(false);
    }
  }

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
    if (!cur || (typeof cur === "object" && "error" in cur)) loadDetail(po.poNumber);
  }

  const applyDetail = useCallback((detail: PoDetail) => {
    setDetails((d) => ({ ...d, [detail.poNumber]: detail }));
    setPos((prev) => prev ? prev.map((p) => p.poNumber === detail.poNumber ? { ...p, status: detail.status, poDate: detail.poDate, totalPrice: detail.totalPrice, products: detail.products, unitsOrdered: detail.unitsOrdered, unitsReceived: detail.unitsReceived } : p) : prev);
    setOpenPo((prev) => (prev && prev.poNumber === detail.poNumber ? { ...prev, status: detail.status, poDate: detail.poDate, unitsOrdered: detail.unitsOrdered, unitsReceived: detail.unitsReceived } : prev));
  }, []);

  // ---- bulk dates (writes ShipHero for delivery; app-side for the rest) ----
  async function applyBulk(changes: DateChange[]) {
    if (!changes.length) return;
    setBulkApplying(true);
    setBulkMsg(null);
    setError(null);
    try {
      const res = await fetch("/api/po/bulk-dates", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ changes }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Bulk update failed.");
      setBulkMsg(`${data.applied} PO${data.applied === 1 ? "" : "s"} updated${data.failed?.length ? ` · ${data.failed.length} failed` : ""}`);
      if (data.failed?.length) setError(`Failed: ${data.failed.map((f: { poNumber: string; error?: string }) => `${f.poNumber} (${f.error ?? "?"})`).join("; ")}`);
      setSelected(new Set());
      setPasteOpen(false);
      setBulkPanel(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Bulk update failed.");
    } finally {
      setBulkApplying(false);
    }
  }

  // Bulk status: one /api/po/edit per PO (same path as the drawer's edit), sequential.
  async function applyBulkStatus(status: string, poNumbers: string[]) {
    setBulkApplying(true);
    setBulkMsg(null);
    setError(null);
    const failed: string[] = [];
    for (const poNumber of poNumbers) {
      try {
        const res = await fetch("/api/po/edit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ poNumber, patch: { status } }) });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "failed");
        applyDetail(data.detail);
      } catch (e) {
        failed.push(`${poNumber} (${e instanceof Error ? e.message : "?"})`);
      }
    }
    setBulkMsg(`${poNumbers.length - failed.length} PO${poNumbers.length - failed.length === 1 ? "" : "s"} set to ${status}${failed.length ? ` · ${failed.length} failed` : ""}`);
    if (failed.length) setError(`Failed: ${failed.join("; ")}`);
    setSelected(new Set());
    setBulkPanel(null);
    setBulkApplying(false);
  }

  // ---- derived ----
  const expectedOf = useCallback((p: PoSummary) => datesByPo[p.poNumber]?.delivery ?? p.poDate?.slice(0, 10) ?? null, [datesByPo]);
  const isLate = useCallback((p: PoSummary) => { const e = expectedOf(p); return !isDoneStatus(p.status) && !!e && daysFrom(e) < 0; }, [expectedOf]);
  const isOver = (p: PoSummary) => p.unitsReceived > p.unitsOrdered;
  const isMissing = useCallback((p: PoSummary) => !isDoneStatus(p.status) && (!datesByPo[p.poNumber]?.exFactory || !expectedOf(p)), [datesByPo, expectedOf]);

  const all = useMemo(() => pos ?? [], [pos]);
  const inView = useMemo(() => all.filter((p) => view === "all" || (view === "closed") === isClosedStatus(p.status)), [all, view]);

  const tiles = useMemo(() => {
    const by = new Map<string, PoSummary[]>();
    for (const p of all) { const k = p.status || "(none)"; if (!by.has(k)) by.set(k, []); by.get(k)!.push(p); }
    return [...by.entries()].sort((a, b) => statusRank(a[0]) - statusRank(b[0]) || a[0].localeCompare(b[0]));
  }, [all]);
  const lateList = useMemo(() => all.filter(isLate), [all, isLate]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = (statusF ? all : inView).filter((p) => {
      if (statusF && p.status !== statusF) return false;
      if (lateOnly && !isLate(p)) return false;
      if (vendorF && (p.vendorName ?? "—") !== vendorF) return false;
      if (familyF && familyOf(p) !== familyF) return false;
      if (missingOnly && !isMissing(p)) return false;
      if (overOnly && !isOver(p)) return false;
      if (windowF) {
        const e = expectedOf(p);
        const d = e ? daysFrom(e) : null;
        if (windowF === "unset" ? !!e : windowF === "overdue" ? !(d != null && d < 0 && !isDoneStatus(p.status)) : !(d != null && d >= 0 && d <= (windowF === "week" ? 7 : Number(windowF)))) return false;
      }
      if (q) {
        const hay = [p.poNumber, p.legacyId ?? "", p.vendorName ?? "", p.status, ...p.products].join(" ").toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    const dir = sort.dir;
    const key = (p: PoSummary): string | number => {
      switch (sort.key) {
        case "po": return p.poNumber;
        case "product": return p.products[0] ?? "";
        case "vendor": return vendorParts(p.vendorName).short;
        case "status": return statusRank(p.status);
        case "progress": return p.unitsOrdered ? p.unitsReceived / p.unitsOrdered : 0;
        case "sent": return datesByPo[p.poNumber]?.orderSent ?? (dir === 1 ? "9999" : "");
        case "exf": return datesByPo[p.poNumber]?.exFactory ?? (dir === 1 ? "9999" : "");
        case "expected": return expectedOf(p) ?? (dir === 1 ? "9999" : "");
        case "value": return money(p.totalPrice);
      }
    };
    return rows.sort((a, b) => { const x = key(a), y = key(b); return (x < y ? -1 : x > y ? 1 : 0) * dir || a.poNumber.localeCompare(b.poNumber, undefined, { numeric: true }); });
  }, [all, inView, statusF, lateOnly, vendorF, familyF, missingOnly, overOnly, windowF, query, sort, datesByPo, expectedOf, isLate, isMissing]);

  const countBy = (get: (p: PoSummary) => string) => {
    const m = new Map<string, number>();
    for (const p of inView) { const k = get(p); m.set(k, (m.get(k) ?? 0) + 1); }
    return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  };
  const vendorOpts = useMemo(() => countBy((p) => p.vendorName ?? "—"), [inView]); // eslint-disable-line react-hooks/exhaustive-deps
  const familyOpts = useMemo(() => countBy(familyOf).filter(([k]) => k), [inView]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectedPos = useMemo(() => all.filter((p) => selected.has(p.poNumber)), [all, selected]);
  const totals = (rows: PoSummary[]) => ({
    ordered: rows.reduce((a, p) => a + p.unitsOrdered, 0),
    received: rows.reduce((a, p) => a + p.unitsReceived, 0),
    toCome: rows.reduce((a, p) => a + Math.max(0, p.unitsOrdered - p.unitsReceived), 0),
    value: rows.reduce((a, p) => a + money(p.totalPrice), 0),
  });
  const filteredTotals = totals(filtered);
  const selectedTotals = totals(selectedPos);
  const anyFilter = !!(statusF || lateOnly || vendorF || familyF || missingOnly || overOnly || windowF || query.trim());
  const clearFilters = () => { setStatusF(null); setLateOnly(false); setVendorF(null); setFamilyF(null); setMissingOnly(false); setOverOnly(false); setWindowF(""); setQuery(""); };

  // ---- selection ----
  function toggleRow(poNumber: string, shift: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (shift && lastTick.current) {
        const ids = filtered.map((p) => p.poNumber);
        const a = ids.indexOf(lastTick.current), b = ids.indexOf(poNumber);
        if (a !== -1 && b !== -1) { for (let i = Math.min(a, b); i <= Math.max(a, b); i++) next.add(ids[i]); return next; }
      }
      if (next.has(poNumber)) next.delete(poNumber); else next.add(poNumber);
      return next;
    });
    lastTick.current = poNumber;
  }

  // ---- keyboard: "/" focuses search ----
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "/" && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement)) { e.preventDefault(); searchRef.current?.focus(); }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);
  useEffect(() => {
    if (!moreOpen) return;
    const h = (e: MouseEvent) => { if (moreRef.current && !moreRef.current.contains(e.target as Node)) setMoreOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [moreOpen]);

  // ---- export ----
  function downloadCsv(csv: string, name: string) {
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = name; a.click();
    URL.revokeObjectURL(url);
  }
  const stamp = () => new Date().toISOString().slice(0, 10);
  const exportRows = () => (selected.size ? selectedPos : filtered);
  function exportGeneral() {
    setExportChooser(false);
    const rows = exportRows().map((p) => ({
      "PO Number": p.poNumber, Product: p.products.join(" | "), Vendor: p.vendorName ?? "", Status: p.status,
      "Order Sent": datesByPo[p.poNumber]?.orderSent ?? "", "Ex-factory": datesByPo[p.poNumber]?.exFactory ?? "", Expected: expectedOf(p) ?? "",
      "Units Ordered": p.unitsOrdered, "Units Received": p.unitsReceived, Total: p.totalPrice ?? "",
    }));
    downloadCsv(Papa.unparse(rows), `wander_doll_po_history_${stamp()}.csv`);
  }
  async function exportLines() {
    setExportingLines(true);
    try {
      const res = await fetch("/api/po/export-lines");
      const data = await res.json();
      const byPo: Record<string, PoLineDetail[]> = data.lines ?? {};
      const rank = (sku: string) => { const i = sizeMap.order.indexOf(deriveSizeFromSku(sku, sizeMap)); return i === -1 ? Number.MAX_SAFE_INTEGER : i; };
      const rows: Record<string, string | number>[] = [];
      for (const p of exportRows()) {
        const lines = [...(byPo[p.poNumber] ?? [])].sort((a, b) => rank(a.sku) - rank(b.sku));
        for (const l of lines) {
          const qty = Number(l.quantity) || 0, price = Number(l.price) || 0;
          rows.push({ "PO Number": p.poNumber, Product: l.productName || p.products.join(" | "), Size: deriveSizeFromSku(l.sku, sizeMap), SKU: l.sku, "Qty Ordered": l.quantity, "Qty Received": l.quantityReceived, "Unit Price": l.price, "Line Total": (qty * price).toFixed(2), Vendor: p.vendorName ?? "", Status: p.status, Expected: expectedOf(p) ?? "" });
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
  const th = (label: string, key: SortKey, extra = "") => (
    <th
      onClick={() => setSort((s) => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : 1 }))}
      className={`font-medium px-3 py-2.5 border-b border-slate-200 whitespace-nowrap cursor-pointer select-none hover:text-slate-700 ${sort.key === key ? "text-slate-800" : ""} ${extra}`}
    >
      {label}{sort.key === key && <span className="ml-1 text-[9px] text-slate-400">{sort.dir === 1 ? "▲" : "▼"}</span>}
    </th>
  );

  // grouped rows (vendor headers) or flat
  const groups: Array<{ vendor: string | null; rows: PoSummary[] }> = useMemo(() => {
    if (!groupByVendor) return [{ vendor: null, rows: filtered }];
    const m = new Map<string, PoSummary[]>();
    for (const p of filtered) { const k = p.vendorName ?? "—"; if (!m.has(k)) m.set(k, []); m.get(k)!.push(p); }
    return [...m.entries()].map(([vendor, rows]) => ({ vendor, rows }));
  }, [filtered, groupByVendor]);

  const openIndex = openPo ? filtered.findIndex((p) => p.poNumber === openPo.poNumber) : -1;

  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden bg-slate-50">
      {/* ---------- header ---------- */}
      <header className="h-14 bg-white border-b border-slate-200 flex items-center gap-3 px-5 shrink-0">
        <span className="font-semibold text-sm text-slate-900">PO History</span>
        <div className="relative flex-1 max-w-xl">
          <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
          <input ref={searchRef} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search PO, product, colour, vendor or row id…"
            className="w-full pl-8 pr-8 py-2 border border-slate-300 rounded-lg text-[13px] focus:ring-2 focus:ring-indigo-200 focus:border-indigo-400 outline-none" />
          <kbd className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] font-mono text-slate-400 border border-slate-200 rounded px-1 bg-slate-50">/</kbd>
        </div>
        <div className="flex-1" />
        {(syncedAgo || syncMsg || bulkMsg) && (
          <span className="text-[11px] text-slate-400 whitespace-nowrap">
            {syncedAgo && `synced ${syncedAgo}`}{syncMsg && <span className="text-emerald-600"> · {syncMsg}</span>}{bulkMsg && <span className="text-emerald-600"> · {bulkMsg}</span>}
          </span>
        )}
        <button onClick={() => sync(false)} disabled={syncing || !shipheroConnected} title={shipheroConnected ? "Pull only POs changed since the last sync" : "Connect ShipHero first"}
          className="text-xs px-3 py-1.5 rounded-md bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 flex items-center gap-1.5">
          <svg width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" className={syncing ? "animate-spin" : ""}><path d="M21 2v6h-6M3 12a9 9 0 0 1 15-6.7L21 8M3 22v-6h6M21 12a9 9 0 0 1-15 6.7L3 16" /></svg>
          {syncing ? "Syncing…" : "Sync"}
        </button>
        <button onClick={() => setPasteOpen(true)} title="Paste a supplier's revised dates sheet and apply in bulk" className="text-xs px-3 py-1.5 rounded-md border border-slate-300 text-slate-700 hover:bg-slate-50">Amend dates</button>
        <button onClick={() => setExportChooser(true)} disabled={filtered.length === 0} className="text-xs px-3 py-1.5 rounded-md border border-slate-300 text-slate-700 hover:bg-slate-50 disabled:opacity-50">
          Export{selected.size ? ` (${selected.size})` : ""}
        </button>
        <div ref={moreRef} className="relative">
          <button onClick={() => setMoreOpen((o) => !o)} className="text-xs px-2.5 py-1.5 rounded-md border border-slate-300 text-slate-600 hover:bg-slate-50" title="More">⋯</button>
          {moreOpen && (
            <div className="absolute right-0 top-full mt-1 z-30 bg-white border border-slate-200 rounded-lg shadow-lg p-3 w-64 flex flex-col gap-3 text-xs">
              <label className="flex items-center justify-between gap-2 text-slate-600">Sync range
                <select value={rangeMonths === null ? "all" : String(rangeMonths)} onChange={(e) => setRangeMonths(e.target.value === "all" ? null : Number(e.target.value))} className="px-2 py-1 border border-slate-200 rounded bg-white">
                  <option value="3">Last 3 months</option><option value="6">Last 6 months</option><option value="12">Last 12 months</option><option value="24">Last 2 years</option><option value="all">All POs</option>
                </select>
              </label>
              <label className="flex items-center gap-2 text-slate-600 select-none"><input type="checkbox" checked={mappedOnly} onChange={(e) => setMappedOnly(e.target.checked)} /> Mapped vendors only</label>
              <button onClick={() => { setMoreOpen(false); sync(true); }} disabled={syncing || !shipheroConnected} className="text-left px-2.5 py-1.5 rounded-md border border-slate-200 text-slate-700 hover:bg-slate-50 disabled:opacity-50">
                Full resync <span className="text-slate-400">— re-pull every PO in range (slow)</span>
              </button>
            </div>
          )}
        </div>
      </header>

      {error && <div className="px-5 py-2 text-xs bg-rose-50 border-b border-rose-200 text-rose-700 shrink-0">{error}</div>}

      <div className="flex-1 min-h-0 flex flex-col">
        {/* ---------- status strip ---------- */}
        <div className="px-5 pt-3.5 shrink-0 grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))" }}>
          {tiles.map(([status, rows]) => {
            const t = totals(rows);
            const on = statusF === status;
            const closed = isDoneStatus(status);
            return (
              <button key={status} onClick={() => { setStatusF(on ? null : status); setLateOnly(false); }}
                className={`text-left bg-white border rounded-xl px-3 py-2.5 flex flex-col gap-0.5 transition-colors ${on ? "border-indigo-500 ring-2 ring-indigo-100" : "border-slate-200 hover:border-slate-300"}`}>
                <span className="text-[10.5px] uppercase tracking-wider text-slate-500 flex items-center gap-1.5 truncate"><span className="w-[7px] h-[7px] rounded-full shrink-0" style={{ background: statusDot(status) }} />{status}</span>
                <span className="text-[22px] font-semibold leading-tight tabular-nums text-slate-900">{rows.length}</span>
                <span className="text-[11px] text-slate-500 tabular-nums truncate">{closed ? `${gbp(t.value)} booked in` : `${t.toCome.toLocaleString()} units to come · ${gbp(t.value)}`}</span>
              </button>
            );
          })}
          <button onClick={() => { setLateOnly((v) => !v); setStatusF(null); }}
            className={`text-left bg-white border rounded-xl px-3 py-2.5 flex flex-col gap-0.5 transition-colors ${lateOnly ? "border-rose-500 ring-2 ring-rose-100" : "border-slate-200 hover:border-slate-300"}`}>
            <span className="text-[10.5px] uppercase tracking-wider text-slate-500 flex items-center gap-1.5"><span className="w-[7px] h-[7px] rounded-full bg-rose-600" />Past expected date</span>
            <span className="text-[22px] font-semibold leading-tight tabular-nums text-rose-600">{lateList.length}</span>
            <span className="text-[11px] text-slate-500 tabular-nums truncate">{totals(lateList).toCome.toLocaleString()} units to come · {gbp(totals(lateList).value)}</span>
          </button>
        </div>

        {/* ---------- filter chips ---------- */}
        <div className="px-5 py-2.5 flex items-center gap-1.5 flex-wrap shrink-0">
          <Chip label="Vendor" active={!!vendorF} valueText={vendorF ? vendorParts(vendorF).short : null} onClear={() => setVendorF(null)}>
            {(close) => (<>
              <Opt label="All vendors" on={!vendorF} onClick={() => { setVendorF(null); close(); }} />
              {vendorOpts.map(([v, n]) => <Opt key={v} label={v} count={n} on={vendorF === v} onClick={() => { setVendorF(v); close(); }} />)}
            </>)}
          </Chip>
          <Chip label="Status" active={!!statusF} valueText={statusF} onClear={() => setStatusF(null)}>
            {(close) => (<>
              <Opt label="Any status" on={!statusF} onClick={() => { setStatusF(null); close(); }} />
              {tiles.map(([s, rows]) => <Opt key={s} label={s} count={rows.length} dot={statusDot(s)} on={statusF === s} onClick={() => { setStatusF(s); setLateOnly(false); close(); }} />)}
            </>)}
          </Chip>
          <Chip label="Expected" active={!!windowF} valueText={WINDOW_LABEL[windowF]} onClear={() => setWindowF("")}>
            {(close) => (<>
              {(["", "week", "14", "30", "overdue", "unset"] as WindowF[]).map((w) => <Opt key={w} label={w ? WINDOW_LABEL[w] : "Any time"} on={windowF === w} onClick={() => { setWindowF(w); close(); }} />)}
            </>)}
          </Chip>
          <Chip label="Product" active={!!familyF} valueText={familyF} onClear={() => setFamilyF(null)}>
            {(close) => (<>
              <Opt label="All products" on={!familyF} onClick={() => { setFamilyF(null); close(); }} />
              {familyOpts.map(([f, n]) => <Opt key={f} label={f} count={n} on={familyF === f} onClick={() => { setFamilyF(f); close(); }} />)}
            </>)}
          </Chip>
          <span className="w-px h-4 bg-slate-200 mx-1" />
          <button onClick={() => setMissingOnly((v) => !v)} title="Open POs with no ex-factory or expected date" className={`px-2.5 py-1.5 rounded-full border text-xs ${missingOnly ? "bg-amber-50 border-amber-400 text-amber-800 font-medium" : "bg-white border-slate-300 text-slate-700 hover:border-slate-400"}`}>Missing dates</button>
          <button onClick={() => setOverOnly((v) => !v)} title="Received more than ordered" className={`px-2.5 py-1.5 rounded-full border text-xs ${overOnly ? "bg-rose-50 border-rose-400 text-rose-800 font-medium" : "bg-white border-slate-300 text-slate-700 hover:border-slate-400"}`}>Over-received</button>
          {anyFilter && <button onClick={clearFilters} className="text-xs text-slate-500 hover:text-slate-800 px-2">Clear all</button>}
          <div className="flex-1" />
          <Toggle on={groupByVendor} label="Group by vendor" onClick={() => setGroupByVendor((v) => !v)} />
          <div className="flex gap-0.5 bg-white border border-slate-200 rounded-lg p-0.5 ml-2">
            {(["open", "all", "closed"] as const).map((v) => (
              <button key={v} onClick={() => { setView(v); setStatusF(null); }} className={`px-2.5 py-1 rounded-md text-xs capitalize ${view === v && !statusF ? "bg-indigo-50 text-indigo-800 font-medium" : "text-slate-500 hover:text-slate-800"}`}>{v}</button>
            ))}
          </div>
        </div>

        {/* ---------- table ---------- */}
        <div className="flex-1 min-h-0 overflow-auto mx-5 bg-white border border-slate-200 rounded-t-xl thin-scroll">
          <table className="w-full text-sm border-collapse min-w-[1100px]">
            <thead className="sticky top-0 bg-slate-50 z-10">
              <tr className="text-left text-[10.5px] uppercase tracking-wider text-slate-500">
                <th className="px-3 py-2.5 border-b border-slate-200 w-9">
                  <input type="checkbox" title="Select all visible" className="accent-indigo-600 cursor-pointer" checked={filtered.length > 0 && filtered.every((p) => selected.has(p.poNumber))}
                    onChange={(e) => setSelected((prev) => { const next = new Set(prev); for (const p of filtered) { if (e.target.checked) next.add(p.poNumber); else next.delete(p.poNumber); } return next; })} />
                </th>
                {th("PO", "po", "w-[112px]")}{th("Product", "product")}{th("Vendor", "vendor", "w-[210px]")}{th("Status", "status", "w-[150px]")}{th("Received / ordered", "progress", "w-[230px]")}
                {th("Order sent", "sent", "w-[118px]")}{th("Ex-factory", "exf", "w-[118px]")}{th("Expected", "expected", "w-[124px]")}{th("Value", "value", "text-right w-[100px]")}
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <GroupRows key={g.vendor ?? "_"} group={g} totals={totals} selected={selected} openPo={openPo?.poNumber ?? null} datesByPo={datesByPo} expectedOf={expectedOf} onOpen={openDetail} onToggle={toggleRow} />
              ))}
              {pos && filtered.length === 0 && !loading && (
                <tr><td colSpan={10} className="px-4 py-12 text-center text-xs text-slate-400">
                  {!lastSyncedAt ? "No POs cached yet — click Sync to pull them from ShipHero." : anyFilter ? "No POs match — clear a filter above." : "Nothing in this view."}
                </td></tr>
              )}
              {loading && !pos && <tr><td colSpan={10} className="px-4 py-12 text-center text-xs text-slate-400">Loading…</td></tr>}
            </tbody>
          </table>
        </div>
        <footer className="h-8 mx-5 mb-3 bg-white border border-t-0 border-slate-200 rounded-b-xl text-slate-500 text-[11px] flex items-center px-4 gap-4 shrink-0 font-mono">
          <span>{filtered.length} of {all.length} POs</span>
          <span>{filteredTotals.ordered.toLocaleString()} ordered · {filteredTotals.received.toLocaleString()} received</span>
          <span>{gbp(filteredTotals.value)}</span>
          <span className="ml-auto text-slate-400 font-sans">click a row to open · tick to select · shift-click for a range</span>
        </footer>
      </div>

      {/* ---------- bulk bar ---------- */}
      <div className={`fixed left-1/2 -translate-x-1/2 bottom-6 z-40 transition-all ${selected.size ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4 pointer-events-none"}`}>
        {bulkPanel && (
          <div className="mb-2 bg-white border border-slate-200 rounded-xl shadow-xl p-3 flex items-center gap-2 text-xs">
            {bulkPanel === "date" && (<>
              <span className="text-slate-600">Set expected date to</span>
              <input type="date" value={bulkDate} onChange={(e) => setBulkDate(e.target.value)} className="border border-slate-300 rounded px-2 py-1" />
              <button disabled={!bulkDate} onClick={() => setBulkConfirm({ title: `Set expected date to ${ukDate(bulkDate)}`, field: "delivery", changes: selectedPos.map((p) => ({ poNumber: p.poNumber, delivery: bulkDate, old: expectedOf(p) })) })}
                className="px-3 py-1 rounded-md bg-indigo-600 text-white font-medium disabled:opacity-40">Review</button>
            </>)}
            {bulkPanel === "shift" && (<>
              <span className="text-slate-600">Move each PO&apos;s expected date by</span>
              <input type="number" value={bulkShift} onChange={(e) => setBulkShift(e.target.value)} className="border border-slate-300 rounded px-2 py-1 w-16" />
              <span className="text-slate-600">days (negative = earlier)</span>
              <button disabled={!Number(bulkShift)} onClick={() => {
                const n = Number(bulkShift);
                const changes = selectedPos.flatMap((p) => { const base = expectedOf(p); return base ? [{ poNumber: p.poNumber, delivery: shiftIso(base, n), old: base }] : []; });
                if (!changes.length) { setError("None of the selected POs have an expected date to shift."); return; }
                setBulkConfirm({ title: `Shift expected date by ${n > 0 ? "+" : ""}${n} days`, field: "delivery", changes });
              }} className="px-3 py-1 rounded-md bg-indigo-600 text-white font-medium disabled:opacity-40">Review</button>
            </>)}
            {bulkPanel === "exf" && (<>
              <span className="text-slate-600">Set ex-factory to</span>
              <input type="date" value={bulkDate} onChange={(e) => setBulkDate(e.target.value)} className="border border-slate-300 rounded px-2 py-1" />
              <button disabled={!bulkDate} onClick={() => setBulkConfirm({ title: `Set ex-factory to ${ukDate(bulkDate)}`, field: "exFactory", changes: selectedPos.map((p) => ({ poNumber: p.poNumber, exFactory: bulkDate, old: datesByPo[p.poNumber]?.exFactory ?? null })) })}
                className="px-3 py-1 rounded-md bg-indigo-600 text-white font-medium disabled:opacity-40">Review</button>
            </>)}
            {bulkPanel === "status" && (<>
              <span className="text-slate-600">Set status to</span>
              <select value={bulkStatus} onChange={(e) => setBulkStatus(e.target.value)} className="border border-slate-300 rounded px-2 py-1 bg-white">
                <option value="">choose…</option>
                {statuses.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
              <button disabled={!bulkStatus} onClick={() => setStatusConfirm({ status: bulkStatus, poNumbers: selectedPos.map((p) => p.poNumber) })} className="px-3 py-1 rounded-md bg-indigo-600 text-white font-medium disabled:opacity-40">Review</button>
            </>)}
            <button onClick={() => setBulkPanel(null)} className="text-slate-400 hover:text-slate-700 px-1">✕</button>
          </div>
        )}
        <div className="bg-slate-900 text-slate-200 rounded-xl shadow-2xl pl-4 pr-2 py-2 flex items-center gap-1.5 text-xs">
          <span className="mr-2 whitespace-nowrap"><b className="text-white">{selected.size} PO{selected.size === 1 ? "" : "s"}</b>
            <span className="text-slate-400"> · {selectedTotals.ordered.toLocaleString()} units · {gbp(selectedTotals.value)} · {new Set(selectedPos.map((p) => p.vendorName)).size} vendor{new Set(selectedPos.map((p) => p.vendorName)).size === 1 ? "" : "s"}</span></span>
          <button onClick={() => { setBulkPanel(bulkPanel === "date" ? null : "date"); setBulkDate(""); }} className={`px-2.5 py-1.5 rounded-md font-medium ${bulkPanel === "date" ? "bg-indigo-500 text-white" : "bg-indigo-600 text-white hover:bg-indigo-500"}`}>Amend expected date</button>
          <button onClick={() => setBulkPanel(bulkPanel === "shift" ? null : "shift")} className={`px-2.5 py-1.5 rounded-md ${bulkPanel === "shift" ? "bg-slate-600" : "bg-slate-800 hover:bg-slate-700"}`}>Shift ± days</button>
          <button onClick={() => { setBulkPanel(bulkPanel === "exf" ? null : "exf"); setBulkDate(""); }} className={`px-2.5 py-1.5 rounded-md ${bulkPanel === "exf" ? "bg-slate-600" : "bg-slate-800 hover:bg-slate-700"}`}>Set ex-factory</button>
          <button onClick={() => setBulkPanel(bulkPanel === "status" ? null : "status")} disabled={!shipheroConnected} className={`px-2.5 py-1.5 rounded-md disabled:opacity-40 ${bulkPanel === "status" ? "bg-slate-600" : "bg-slate-800 hover:bg-slate-700"}`}>Status ▾</button>
          <button onClick={() => setExportChooser(true)} className="px-2.5 py-1.5 rounded-md bg-slate-800 hover:bg-slate-700">Export selected</button>
          <button onClick={() => { setSelected(new Set()); setBulkPanel(null); }} className="px-2 py-1.5 text-slate-400 hover:text-white" title="Clear selection">✕</button>
        </div>
      </div>

      {/* ---------- confirms ---------- */}
      {bulkConfirm && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4" onClick={() => setBulkConfirm(null)}>
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md max-h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="px-5 py-3.5 border-b border-slate-200">
              <h3 className="text-sm font-semibold text-slate-900">{bulkConfirm.title}</h3>
              <p className="text-xs text-slate-500 mt-0.5">
                {bulkConfirm.changes.length} PO{bulkConfirm.changes.length === 1 ? "" : "s"}
                {bulkConfirm.field === "delivery" ? " — updates ShipHero's Expected Date" : " — app-side only (ShipHero untouched)"}
              </p>
            </div>
            <div className="px-5 py-3 overflow-y-auto">
              <table className="w-full text-xs">
                <tbody>
                  {bulkConfirm.changes.map((c) => (
                    <tr key={c.poNumber} className="border-b border-slate-100 last:border-0">
                      <td className="py-1.5 pr-3 font-mono font-medium text-slate-700">{c.poNumber}</td>
                      <td className="py-1.5 text-slate-400">{c.old ? ukDate(c.old) : "—"}</td>
                      <td className="py-1.5 px-2 text-slate-300">→</td>
                      <td className="py-1.5 font-medium text-indigo-700">{ukDate(c.delivery ?? c.exFactory ?? c.orderSent ?? "")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="px-5 py-3.5 border-t border-slate-200 flex items-center justify-end gap-2">
              <button onClick={() => setBulkConfirm(null)} className="text-xs px-3.5 py-1.5 rounded-md border border-slate-200 text-slate-600 hover:bg-slate-50">Cancel</button>
              <button disabled={bulkApplying} onClick={() => {
                const changes = bulkConfirm.changes.map(({ poNumber, delivery, exFactory, orderSent }) => ({ poNumber, ...(delivery ? { delivery } : {}), ...(exFactory ? { exFactory } : {}), ...(orderSent ? { orderSent } : {}) }));
                setBulkConfirm(null);
                applyBulk(changes);
              }} className="text-xs px-4 py-1.5 rounded-md bg-indigo-600 text-white font-medium disabled:opacity-40">Confirm &amp; apply</button>
            </div>
          </div>
        </div>
      )}
      {statusConfirm && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4" onClick={() => setStatusConfirm(null)}>
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md max-h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="px-5 py-3.5 border-b border-slate-200">
              <h3 className="text-sm font-semibold text-slate-900">Set status to “{statusConfirm.status}”</h3>
              <p className="text-xs text-slate-500 mt-0.5">{statusConfirm.poNumbers.length} PO{statusConfirm.poNumbers.length === 1 ? "" : "s"} — writes to ShipHero, one PO at a time</p>
            </div>
            <div className="px-5 py-3 overflow-y-auto text-xs font-mono text-slate-700 flex flex-wrap gap-x-3 gap-y-1">
              {statusConfirm.poNumbers.map((n) => <span key={n}>{n}</span>)}
            </div>
            <div className="px-5 py-3.5 border-t border-slate-200 flex items-center justify-end gap-2">
              <button onClick={() => setStatusConfirm(null)} className="text-xs px-3.5 py-1.5 rounded-md border border-slate-200 text-slate-600 hover:bg-slate-50">Cancel</button>
              <button disabled={bulkApplying} onClick={() => { const c = statusConfirm; setStatusConfirm(null); applyBulkStatus(c.status, c.poNumbers); }} className="text-xs px-4 py-1.5 rounded-md bg-indigo-600 text-white font-medium disabled:opacity-40">Confirm &amp; apply</button>
            </div>
          </div>
        </div>
      )}
      {pasteOpen && <PasteRevisionsModal pos={all} datesByPo={datesByPo} applying={bulkApplying} onApply={applyBulk} onClose={() => setPasteOpen(false)} />}

      {/* ---------- drawer ---------- */}
      {openPo && (
        <PoDrawer
          key={`${openPo.poNumber}|${openPo.status}|${datesByPo[openPo.poNumber]?.orderSent ?? ""}|${datesByPo[openPo.poNumber]?.exFactory ?? ""}|${datesByPo[openPo.poNumber]?.delivery ?? openPo.poDate ?? ""}`}
          po={openPo}
          detail={details[openPo.poNumber]}
          dates={datesByPo[openPo.poNumber]}
          statuses={statuses}
          sizeMap={sizeMap}
          shipheroConnected={shipheroConnected}
          onClose={() => setOpenPo(null)}
          onRefresh={() => loadDetail(openPo.poNumber, true)}
          onSaved={applyDetail}
          onSaveDates={(change, old) => {
            if (change.delivery) setBulkConfirm({ title: `Update dates on ${change.poNumber}`, field: "delivery", changes: [{ ...change, old }] });
            else applyBulk([change]);
          }}
          onPrev={openIndex > 0 ? () => openDetail(filtered[openIndex - 1]) : undefined}
          onNext={openIndex >= 0 && openIndex < filtered.length - 1 ? () => openDetail(filtered[openIndex + 1]) : undefined}
        />
      )}

      {exportChooser && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" onClick={() => !exportingLines && setExportChooser(false)}>
          <div className="bg-white rounded-xl shadow-xl w-full max-w-sm p-5" onClick={(e) => e.stopPropagation()}>
            <p className="text-sm font-semibold text-slate-900">Export {exportRows().length} PO{exportRows().length === 1 ? "" : "s"}</p>
            <p className="text-xs text-slate-400 mt-0.5 mb-4">{selected.size ? "Just the selected POs." : "Everything matching the current filters."}</p>
            <div className="space-y-2">
              <button onClick={exportGeneral} disabled={exportingLines} className="w-full text-left px-3 py-2.5 rounded-lg border border-slate-200 hover:border-indigo-300 hover:bg-indigo-50/50 disabled:opacity-50">
                <p className="text-sm font-medium text-slate-800">General</p>
                <p className="text-[11px] text-slate-500">One row per PO — product, vendor, status, all three dates, units, total.</p>
              </button>
              <button onClick={exportLines} disabled={exportingLines} className="w-full text-left px-3 py-2.5 rounded-lg border border-slate-200 hover:border-indigo-300 hover:bg-indigo-50/50 disabled:opacity-50">
                <p className="text-sm font-medium text-slate-800">{exportingLines ? "Preparing…" : "Line-level detail"}</p>
                <p className="text-[11px] text-slate-500">One row per size/SKU — qty ordered &amp; received, unit price, line total.</p>
              </button>
            </div>
            <div className="mt-4 flex justify-end">
              <button onClick={() => setExportChooser(false)} disabled={exportingLines} className="text-xs px-3 py-1.5 rounded-md border border-slate-200 text-slate-600 hover:bg-slate-50 disabled:opacity-50">Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- rows ----------
function GroupRows({ group, totals, selected, openPo, datesByPo, expectedOf, onOpen, onToggle }: {
  group: { vendor: string | null; rows: PoSummary[] };
  totals: (rows: PoSummary[]) => { ordered: number; received: number; toCome: number; value: number };
  selected: Set<string>; openPo: string | null;
  datesByPo: Record<string, PoDatesRow>; expectedOf: (p: PoSummary) => string | null;
  onOpen: (p: PoSummary) => void; onToggle: (poNumber: string, shift: boolean) => void;
}) {
  const t = group.vendor != null ? totals(group.rows) : null;
  return (
    <>
      {group.vendor != null && t && (
        <tr className="sticky top-[37px] z-[5]">
          <td colSpan={10} className="bg-slate-50 border-b border-slate-200 px-3 py-1.5 text-[11.5px] text-slate-700">
            <b className="text-slate-900">{vendorParts(group.vendor).full || group.vendor}</b>{vendorParts(group.vendor).full && <span className="text-slate-500"> ({vendorParts(group.vendor).short})</span>}
            <span className="ml-3 text-slate-500 tabular-nums">{group.rows.length} POs · {t.toCome.toLocaleString()} units to come · {gbp(t.value)}</span>
          </td>
        </tr>
      )}
      {group.rows.map((po) => <PoRow key={po.poNumber} po={po} dates={datesByPo[po.poNumber]} expected={expectedOf(po)} checked={selected.has(po.poNumber)} open={openPo === po.poNumber} onOpen={() => onOpen(po)} onToggle={(shift) => onToggle(po.poNumber, shift)} />)}
    </>
  );
}

function PoRow({ po, dates, expected, checked, open, onOpen, onToggle }: {
  po: PoSummary; dates: PoDatesRow | undefined; expected: string | null; checked: boolean; open: boolean; onOpen: () => void; onToggle: (shift: boolean) => void;
}) {
  const closed = isDoneStatus(po.status);
  const over = po.unitsReceived > po.unitsOrdered;
  const pct = po.unitsOrdered ? Math.min(100, (po.unitsReceived / po.unitsOrdered) * 100) : 0;
  const bar = over ? "bg-rose-500" : po.unitsReceived >= po.unitsOrdered && po.unitsOrdered > 0 ? "bg-emerald-500" : po.unitsReceived > 0 ? "bg-indigo-500" : "bg-slate-200";
  const [first, ...rest] = po.products;
  const fp = first ? productParts(first) : null;
  const v = vendorParts(po.vendorName);
  return (
    <tr onClick={onOpen} className={`cursor-pointer ${checked ? "bg-indigo-50/70" : "hover:bg-indigo-50/30"} ${open ? "shadow-[inset_3px_0_0_#4f46e5]" : ""}`}>
      <td className="px-3 py-2.5 border-b border-slate-100" onClick={(e) => { e.stopPropagation(); onToggle(e.shiftKey); }}>
        <input type="checkbox" checked={checked} readOnly className="accent-indigo-600 cursor-pointer" />
      </td>
      <td className="px-3 py-2.5 border-b border-slate-100 whitespace-nowrap">
        <span className="font-mono text-xs font-semibold text-slate-800">{po.poNumber}</span>
        {po.legacyId && <span className="block font-mono text-[10px] text-slate-400">row {po.legacyId}</span>}
      </td>
      <td className="px-3 py-2.5 border-b border-slate-100 max-w-[300px]">
        {fp ? (<>
          <span className="block text-[13px] font-medium text-slate-900 truncate" title={fp.name}>{fp.name}</span>
          <span className="text-[11px] text-slate-500">{fp.colour}
            {rest.length > 0 && <span className="ml-1.5 text-[10.5px] text-indigo-700 bg-indigo-50 rounded px-1" title={rest.join("\n")}>+{rest.length} more</span>}
          </span>
        </>) : <span className="text-slate-300">—</span>}
      </td>
      <td className="px-3 py-2.5 border-b border-slate-100 text-[13px] text-slate-700 max-w-[200px]">
        {v.short}{v.full && <span className="block text-[10.5px] text-slate-400 truncate" title={v.full}>{v.full}</span>}
      </td>
      <td className="px-3 py-2.5 border-b border-slate-100 whitespace-nowrap">
        <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium ${statusClass(po.status)}`}><span className="w-1.5 h-1.5 rounded-full bg-current opacity-80" />{po.status || "—"}</span>
      </td>
      <td className="px-3 py-2.5 border-b border-slate-100">
        <div className="flex items-center gap-2 min-w-[150px]">
          <span className="flex-1 h-1.5 bg-slate-100 rounded-full overflow-hidden"><span className={`block h-full rounded-full ${bar}`} style={{ width: `${pct}%` }} /></span>
          <span className="font-mono text-[11.5px] text-slate-600 w-[78px] text-right tabular-nums"><b className="text-slate-900">{po.unitsReceived}</b> / {po.unitsOrdered}{over && <span className="text-rose-600"> +{po.unitsReceived - po.unitsOrdered}</span>}</span>
        </div>
      </td>
      <td className="px-3 py-2.5 border-b border-slate-100"><DateCell iso={dates?.orderSent ?? null} closed={true} /></td>
      <td className="px-3 py-2.5 border-b border-slate-100"><DateCell iso={dates?.exFactory ?? null} closed={closed} /></td>
      <td className="px-3 py-2.5 border-b border-slate-100"><DateCell iso={expected} closed={closed} /></td>
      <td className="px-3 py-2.5 border-b border-slate-100 text-right font-mono text-xs text-slate-800 whitespace-nowrap">{po.totalPrice ? gbp(money(po.totalPrice)) : "—"}</td>
    </tr>
  );
}

// ---------- drawer ----------
function PoDrawer({ po, detail, dates, statuses, sizeMap, shipheroConnected, onClose, onRefresh, onSaved, onSaveDates, onPrev, onNext }: {
  po: PoSummary;
  detail: PoDetail | "loading" | { error: string } | undefined;
  dates: PoDatesRow | undefined;
  statuses: string[];
  sizeMap: SizeMap;
  shipheroConnected: boolean;
  onClose: () => void;
  onRefresh: () => void;
  onSaved: (detail: PoDetail) => void;
  onSaveDates: (change: DateChange, oldExpected: string | null) => void;
  onPrev?: () => void;
  onNext?: () => void;
}) {
  const loaded = detail && detail !== "loading" && !("error" in detail) ? (detail as PoDetail) : null;
  const closed = isDoneStatus(po.status);
  const expected = dates?.delivery ?? po.poDate?.slice(0, 10) ?? "";

  // dates (three fields; expected writes ShipHero via the parent's confirm)
  const [dSent, setDSent] = useState(dates?.orderSent ?? "");
  const [dExf, setDExf] = useState(dates?.exFactory ?? "");
  const [dExp, setDExp] = useState(expected);
  // (the parent keys this drawer by PO + dates + status, so a change remounts it with fresh state)
  const datesDirty = dSent !== (dates?.orderSent ?? "") || dExf !== (dates?.exFactory ?? "") || dExp !== expected;

  // date-change history (app-side log)
  const [log, setLog] = useState<DateLogRow[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/po/date-log?po=${encodeURIComponent(po.poNumber)}`).then((r) => r.json()).then((j) => { if (!cancelled) setLog(j.log ?? []); }).catch(() => { if (!cancelled) setLog([]); });
    return () => { cancelled = true; };
  }, [po.poNumber]);

  // status + line edits (existing edit path → /api/po/edit)
  const [editMode, setEditMode] = useState(false);
  const [editStatus, setEditStatus] = useState(po.status);
  const [lineEdits, setLineEdits] = useState<Record<string, { quantity?: string; price?: string }>>({});
  const [confirm, setConfirm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); if (e.key === "ArrowLeft" && onPrev && !(e.target instanceof HTMLInputElement)) onPrev(); if (e.key === "ArrowRight" && onNext && !(e.target instanceof HTMLInputElement)) onNext(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, onPrev, onNext]);

  function cancelEdit() { setEditMode(false); setConfirm(false); setLineEdits({}); setEditStatus(po.status); setSaveErr(null); }
  const statusDirty = editStatus !== po.status;
  const lineChanged = (l: PoLineDetail) => { const e = lineEdits[l.sku]; return !!e && ((e.quantity != null && e.quantity !== String(l.quantity)) || (e.price != null && e.price !== l.price)); };
  const lineDirty = loaded ? loaded.lines.some(lineChanged) : false;
  const dirty = statusDirty || lineDirty;

  async function save() {
    setSaving(true); setSaveErr(null);
    try {
      const patch: Record<string, unknown> = {};
      if (statusDirty) patch.status = editStatus;
      if (lineDirty && loaded) patch.lines = loaded.lines.filter(lineChanged).map((l) => { const e = lineEdits[l.sku]; return { sku: l.sku, ...(e.quantity != null && e.quantity !== String(l.quantity) ? { quantity: Number(e.quantity) } : {}), ...(e.price != null && e.price !== l.price ? { price: e.price } : {}) }; });
      const res = await fetch("/api/po/edit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ poNumber: po.poNumber, patch }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Save failed.");
      onSaved(data.detail);
    } catch (e) {
      setSaveErr(e instanceof Error ? e.message : "Save failed.");
    } finally { setSaving(false); }
  }
  const getQty = (l: PoLineDetail) => lineEdits[l.sku]?.quantity ?? String(l.quantity);
  const getPrice = (l: PoLineDetail) => lineEdits[l.sku]?.price ?? l.price;
  const setLine = (sku: string, field: "quantity" | "price", value: string) => setLineEdits((m) => ({ ...m, [sku]: { ...m[sku], [field]: value } }));

  const sizeRank = (sku: string) => { const i = sizeMap.order.indexOf(deriveSizeFromSku(sku, sizeMap)); return i === -1 ? Number.MAX_SAFE_INTEGER : i; };
  const orderedLines = loaded ? [...loaded.lines].sort((a, b) => sizeRank(a.sku) - sizeRank(b.sku)) : [];
  const v = vendorParts(po.vendorName);
  const over = po.unitsReceived > po.unitsOrdered;
  const pct = po.unitsOrdered ? Math.min(100, Math.round((po.unitsReceived / po.unitsOrdered) * 100)) : 0;

  const dateBox = (label: string, value: string, set: (v: string) => void, hint: string, iso: string | null) => {
    const r = rel(iso, closed || label === "Order sent");
    const sub = r.tone === "late" ? "text-rose-600 font-semibold" : r.tone === "soon" ? "text-amber-600 font-semibold" : r.tone === "missing" ? "text-amber-600" : "text-slate-400";
    return (
      <div className="bg-slate-50 rounded-lg px-3 py-2">
        <p className="text-[10px] uppercase tracking-wider text-slate-500">{label} <span className="normal-case tracking-normal text-slate-400">· {hint}</span></p>
        <input type="date" value={value} onChange={(e) => set(e.target.value)} className={`mt-1 w-full bg-transparent font-mono text-[13px] font-semibold outline-none border-b ${value !== (iso ?? "") ? "border-indigo-400 text-indigo-800" : "border-transparent hover:border-slate-300 text-slate-900"}`} />
        <p className={`text-[10.5px] mt-0.5 ${sub}`}>{r.text || " "}</p>
      </div>
    );
  };

  return (
    <>
      <div className="fixed inset-0 z-40 bg-slate-900/20" onClick={onClose} />
      <aside className="fixed top-0 right-0 bottom-0 w-full max-w-[580px] bg-white border-l border-slate-200 shadow-2xl z-50 flex flex-col">
        <div className="px-5 py-4 border-b border-slate-200 flex items-start gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2.5">
              <h2 className="font-mono text-lg font-bold text-slate-900">{po.poNumber}</h2>
              <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium ${statusClass(po.status)}`}><span className="w-1.5 h-1.5 rounded-full bg-current opacity-80" />{po.status || "—"}</span>
            </div>
            <p className="text-xs text-slate-500 mt-0.5 truncate">{po.legacyId ? `row ${po.legacyId} · ` : ""}{v.full || v.short}{v.full ? ` (${v.short})` : ""}</p>
            <p className="text-[12.5px] text-slate-700 mt-1">{po.products.map((x) => { const q = productParts(x); return `${q.name}${q.colour ? ` — ${q.colour}` : ""}`; }).join(", ") || "—"}</p>
          </div>
          <div className="flex-1" />
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700 text-xl leading-none shrink-0">×</button>
        </div>

        <div className="flex-1 overflow-auto thin-scroll px-5 py-4 flex flex-col gap-5">
          {/* progress */}
          <section>
            <div className="flex items-center gap-3">
              <span className="text-xs font-semibold text-slate-700 tabular-nums">{po.unitsReceived.toLocaleString()} / {po.unitsOrdered.toLocaleString()} units received{over && <span className="text-rose-600"> · {po.unitsReceived - po.unitsOrdered} over</span>}</span>
              <div className="flex-1 h-2 bg-slate-100 rounded-full overflow-hidden"><div className={`h-full ${over ? "bg-rose-500" : pct >= 100 ? "bg-emerald-500" : pct > 0 ? "bg-indigo-500" : "bg-slate-300"}`} style={{ width: `${pct}%` }} /></div>
              <span className="text-xs text-slate-500 tabular-nums w-9 text-right">{pct}%</span>
              <span className="font-mono text-xs text-slate-800">{po.totalPrice ? gbp(money(po.totalPrice)) : "—"}</span>
            </div>
          </section>

          {/* dates */}
          <section>
            <div className="flex items-center mb-2">
              <h3 className="text-[10.5px] uppercase tracking-wider text-slate-500 font-medium">Dates</h3>
              <div className="flex-1" />
              {datesDirty && (<>
                <button onClick={() => { setDSent(dates?.orderSent ?? ""); setDExf(dates?.exFactory ?? ""); setDExp(expected); }} className="text-[11px] text-slate-500 hover:text-slate-800 px-2">Reset</button>
                <button onClick={() => onSaveDates({ poNumber: po.poNumber, ...(dSent !== (dates?.orderSent ?? "") && dSent ? { orderSent: dSent } : {}), ...(dExf !== (dates?.exFactory ?? "") && dExf ? { exFactory: dExf } : {}), ...(dExp !== expected && dExp ? { delivery: dExp } : {}) }, expected || null)}
                  className="text-[11px] px-2.5 py-1 rounded-md bg-indigo-600 text-white font-medium">Save dates{dExp !== expected && dExp ? " → ShipHero" : ""}</button>
              </>)}
            </div>
            <div className="grid grid-cols-3 gap-2">
              {dateBox("Order sent", dSent, setDSent, "app", dates?.orderSent ?? null)}
              {dateBox("Ex-factory", dExf, setDExf, "app", dates?.exFactory ?? null)}
              {dateBox("Expected", dExp, setDExp, "ShipHero", expected || null)}
            </div>
          </section>

          {/* sizes */}
          <section>
            <div className="flex items-center mb-2">
              <h3 className="text-[10.5px] uppercase tracking-wider text-slate-500 font-medium">By size</h3>
              <div className="flex-1" />
              {editMode ? (
                confirm ? (<>
                  <span className="text-[11px] text-slate-500 mr-1">Write to ShipHero?</span>
                  <button onClick={() => setConfirm(false)} className="text-[11px] px-2 py-1 rounded-md border border-slate-200 text-slate-600 mr-1">Back</button>
                  <button onClick={save} disabled={saving} className="text-[11px] px-2.5 py-1 rounded-md bg-indigo-600 text-white font-medium disabled:opacity-50">{saving ? "Saving…" : "Confirm & save"}</button>
                </>) : (<>
                  <button onClick={cancelEdit} className="text-[11px] px-2 py-1 rounded-md border border-slate-200 text-slate-600 mr-1">Cancel</button>
                  <button onClick={() => setConfirm(true)} disabled={!dirty} className="text-[11px] px-2.5 py-1 rounded-md bg-indigo-600 text-white font-medium disabled:opacity-40">Save to ShipHero</button>
                </>)
              ) : (
                <button onClick={() => setEditMode(true)} disabled={!shipheroConnected || !loaded} className="text-[11px] px-2 py-1 rounded-md border border-slate-200 text-slate-600 hover:bg-slate-50 disabled:opacity-40">Edit qty / price / status</button>
              )}
            </div>
            {editMode && (
              <label className="flex items-center gap-2 text-xs text-slate-600 mb-2">Status
                <select value={editStatus} onChange={(e) => setEditStatus(e.target.value)} className={`px-2 py-1 border rounded bg-white text-xs ${statusDirty ? "border-indigo-400" : "border-slate-200"}`}>
                  {!statuses.includes(editStatus) && <option value={editStatus}>{editStatus || "—"}</option>}
                  {statuses.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </label>
            )}
            {saveErr && <p className="text-[11px] text-rose-600 mb-2">{saveErr}</p>}
            {!detail || detail === "loading" ? (
              <p className="text-xs text-slate-400">Loading sizes…</p>
            ) : "error" in detail ? (
              <div className="flex items-center gap-3"><p className="text-xs text-rose-600">{detail.error}</p><button onClick={onRefresh} className="text-xs px-2 py-1 rounded border border-slate-200 text-slate-600">Retry</button></div>
            ) : (
              <table className="w-full text-xs">
                <thead><tr className="text-left text-[10px] uppercase tracking-wide text-slate-400 border-b border-slate-200">
                  <th className="font-medium py-1 pr-2">Size</th><th className="font-medium py-1 pr-2">SKU</th><th className="font-medium py-1 px-2 text-right">Ordered</th><th className="font-medium py-1 px-2 text-right">Price</th><th className="font-medium py-1 px-2 text-right">Received</th><th className="font-medium py-1 pl-2 w-full"></th>
                </tr></thead>
                <tbody>
                  {orderedLines.map((l, i) => {
                    const lp = l.quantity ? Math.min(100, Math.round((l.quantityReceived / l.quantity) * 100)) : 0;
                    const lover = l.quantityReceived > l.quantity;
                    return (
                      <tr key={l.sku + i} className="border-b border-slate-100 last:border-0">
                        <td className="py-1.5 pr-2 font-semibold text-slate-800 whitespace-nowrap">{deriveSizeFromSku(l.sku, sizeMap) || "—"}</td>
                        <td className="py-1.5 pr-2 font-mono text-[10.5px] text-slate-400 whitespace-nowrap">{l.sku}</td>
                        <td className="py-1.5 px-2 text-right font-mono tabular-nums">{editMode ? <input value={getQty(l)} onChange={(e) => setLine(l.sku, "quantity", e.target.value)} className={`w-14 px-1 py-0.5 text-right font-mono text-xs rounded border ${getQty(l) !== String(l.quantity) ? "border-indigo-300 bg-indigo-50/40" : "border-slate-200"}`} /> : l.quantity}</td>
                        <td className="py-1.5 px-2 text-right font-mono tabular-nums">{editMode ? <input value={getPrice(l)} onChange={(e) => setLine(l.sku, "price", e.target.value)} className={`w-16 px-1 py-0.5 text-right font-mono text-xs rounded border ${getPrice(l) !== l.price ? "border-indigo-300 bg-indigo-50/40" : "border-slate-200"}`} /> : fmtPrice(l.price)}</td>
                        <td className={`py-1.5 px-2 text-right font-mono tabular-nums ${lover ? "text-rose-600 font-semibold" : "text-slate-800"}`}>{l.quantityReceived}{lover && ` (+${l.quantityReceived - l.quantity})`}</td>
                        <td className="py-1.5 pl-2"><div className="h-1.5 bg-slate-100 rounded-full overflow-hidden min-w-[70px]"><div className={`h-full ${lover ? "bg-rose-500" : lp >= 100 ? "bg-emerald-500" : lp > 0 ? "bg-indigo-500" : ""}`} style={{ width: `${lp}%` }} /></div></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </section>

          {/* date history */}
          <section>
            <h3 className="text-[10.5px] uppercase tracking-wider text-slate-500 font-medium mb-2">Date changes</h3>
            {log === null ? <p className="text-xs text-slate-400">Loading…</p> : log.length === 0 ? (
              <p className="text-xs text-slate-400">No date changes recorded in the app for this PO yet.</p>
            ) : (
              <div className="flex flex-col gap-1.5 text-xs">
                {log.map((r) => (
                  <div key={r.id} className="grid grid-cols-[92px_1fr] gap-2">
                    <span className="font-mono text-[10.5px] text-slate-400">{ukDate(r.changedAt.slice(0, 10))} {r.changedAt.slice(11, 16)}</span>
                    <span className="text-slate-700">{r.field === "delivery" ? "Expected" : r.field === "exFactory" ? "Ex-factory" : "Order sent"} {r.oldValue ? ukDate(r.oldValue) : "—"} → <b>{r.newValue ? ukDate(r.newValue) : "—"}</b></span>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>

        <div className="px-5 py-3 border-t border-slate-200 flex items-center gap-2">
          {po.legacyId && <a href={`https://app.shiphero.com/dashboard/purchase-orders/details/${po.legacyId}`} target="_blank" rel="noreferrer" className="text-xs px-3 py-1.5 rounded-md border border-slate-200 text-slate-700 hover:bg-slate-50">Open in ShipHero ↗</a>}
          <a href={`/po-unreceive?po=${encodeURIComponent(po.poNumber)}`} className="text-xs px-3 py-1.5 rounded-md border border-slate-200 text-slate-700 hover:bg-slate-50">Un-receive…</a>
          <button onClick={onRefresh} className="text-xs px-3 py-1.5 rounded-md border border-slate-200 text-slate-600 hover:bg-slate-50" title="Re-pull this PO from ShipHero">Refresh</button>
          <div className="flex-1" />
          <button onClick={onPrev} disabled={!onPrev} className="text-xs px-2.5 py-1.5 rounded-md text-slate-600 hover:bg-slate-50 disabled:opacity-30" title="Previous PO (←)">‹ Prev</button>
          <button onClick={onNext} disabled={!onNext} className="text-xs px-2.5 py-1.5 rounded-md text-slate-600 hover:bg-slate-50 disabled:opacity-30" title="Next PO (→)">Next ›</button>
        </div>
      </aside>
    </>
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
