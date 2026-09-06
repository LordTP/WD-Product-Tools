"use client";

// Apps → PO Scanner: scan returns/odd stock into a draft PO, push it to
// ShipHero, then book the lot into a RET bin and close it.
//
// Scanning UX (decided with Tom):
//  · every scan puts that line at the TOP of the list with a green flash — the
//    scanner never scrolls to see what just happened
//  · repeat scans bump qty on the existing line (no duplicate rows)
//  · accepted scan bings, unknown code buzzes; big "last scanned" banner;
//    sticky lines/units counters; Undo last scan
//  · a bin label scanned here buzzes: "that's a location — scan a product"
//
// Push and Book-in each sit behind explicit confirm modals; Book-in fetches the
// LIVE ShipHero PO and books in what ShipHero holds, never the local draft.

import { useCallback, useEffect, useRef, useState } from "react";
import { useBarcodeScanner } from "@/lib/use-barcode-scanner";
import { primeAudio, scanBing, scanBuzz } from "@/lib/scan-sound";
import type { ScanResponse } from "@/lib/scan-types";
import {
  RET_BINS,
  draftUnits,
  type BookInResult,
  type DraftLine,
  type LivePoCheck,
  type PoDraftDto,
} from "@/lib/po-scanner-types";

interface Vendor { id: string; name: string }

function timeAgo(iso: string | null): string {
  if (!iso) return "";
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

async function jsonOrThrow<T>(res: Response): Promise<T> {
  const json = (await res.json()) as T & { error?: string };
  if (!res.ok || json.error) throw new Error(json.error ?? "Request failed.");
  return json;
}

export function PoScannerApp() {
  const [drafts, setDrafts] = useState<PoDraftDto[] | null>(null);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [openId, setOpenId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [d, v] = await Promise.all([
        fetch("/api/po-scanner/drafts").then((r) => jsonOrThrow<{ drafts: PoDraftDto[] }>(r)),
        fetch("/api/po-scanner/vendors").then((r) => jsonOrThrow<{ vendors: Vendor[] }>(r)),
      ]);
      setDrafts(d.drafts);
      setVendors(v.vendors);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load.");
    }
  }, []);

  useEffect(() => {
    void (async () => { await load(); })();
  }, [load]);

  async function newDraft() {
    try {
      // No vendor by default — matching the old app; manual POs go up vendorless.
      const { draft } = await jsonOrThrow<{ draft: PoDraftDto }>(
        await fetch("/api/po-scanner/drafts", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ vendorId: null, vendorName: "" }),
        }),
      );
      setDrafts((prev) => [draft, ...(prev ?? [])]);
      setOpenId(draft.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create the draft.");
    }
  }

  const open = drafts?.find((d) => d.id === openId) ?? null;
  const patchDraft = (draft: PoDraftDto) => setDrafts((prev) => (prev ?? []).map((d) => (d.id === draft.id ? draft : d)));
  const removeDraft = (id: number) => { setDrafts((prev) => (prev ?? []).filter((d) => d.id !== id)); setOpenId(null); };

  if (open) {
    return (
      <DraftView
        key={open.id}
        draft={open}
        vendors={vendors}
        onBack={() => setOpenId(null)}
        onChange={patchDraft}
        onDeleted={() => removeDraft(open.id)}
      />
    );
  }

  const active = (drafts ?? []).filter((d) => d.status !== "booked");
  const booked = (drafts ?? []).filter((d) => d.status === "booked").slice(0, 12);

  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <div className="p-4 lg:p-6 flex flex-col gap-5">
        {error && <div className="bg-rose-50 border border-rose-200 text-rose-700 text-sm rounded-lg px-4 py-3">{error}</div>}

        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">Scanner POs</h2>
            <p className="text-[13px] text-slate-500">Scan stock in → push to ShipHero → book into a RET bin.</p>
          </div>
          <button
            onClick={() => void newDraft()}
            className="px-4 py-2.5 rounded-xl bg-slate-900 text-white text-sm font-medium hover:bg-slate-700 transition-colors"
          >
            + New PO
          </button>
        </div>

        {drafts === null ? (
          <p className="text-sm text-slate-400">Loading…</p>
        ) : (
          <>
            {active.length === 0 && booked.length === 0 && (
              <div className="text-center py-14">
                <p className="text-[15px] font-semibold text-slate-700">No scanner POs yet</p>
                <p className="text-sm text-slate-500 mt-1">Start a new PO and scan the first item.</p>
              </div>
            )}
            {active.length > 0 && (
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-2.5">
                {active.map((d) => <DraftCard key={d.id} draft={d} onOpen={() => setOpenId(d.id)} />)}
              </div>
            )}
            {booked.length > 0 && (
              <div>
                <p className="text-[11px] uppercase tracking-wider text-slate-400 mb-1.5">Recently booked in</p>
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-2.5">
                  {booked.map((d) => <DraftCard key={d.id} draft={d} onOpen={() => setOpenId(d.id)} />)}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: PoDraftDto["status"] }) {
  const map = {
    draft: "bg-slate-100 text-slate-500",
    pushed: "bg-amber-50 text-amber-700",
    booked: "bg-emerald-50 text-emerald-700",
  } as const;
  const label = { draft: "draft", pushed: "pushed — book in", booked: "booked in" } as const;
  return <span className={`text-[10px] font-semibold uppercase tracking-wider rounded-full px-2 py-0.5 ${map[status]}`}>{label[status]}</span>;
}

function DraftCard({ draft, onOpen }: { draft: PoDraftDto; onOpen: () => void }) {
  return (
    <button
      onClick={onOpen}
      className="flex items-center justify-between gap-3 bg-white rounded-xl border border-slate-200 px-4 py-3 shadow-sm hover:shadow-md hover:border-indigo-200 transition-all text-left"
    >
      <div className="min-w-0">
        <p className="font-mono text-[13px] font-semibold text-slate-900">{draft.poNumber}</p>
        <p className="text-[12px] text-slate-500 mt-0.5">
          {draft.lines.length} SKU{draft.lines.length === 1 ? "" : "s"} · {draftUnits(draft)} units
          {draft.bookedBin && ` → ${draft.bookedBin}`}
          <span className="text-slate-300"> · {timeAgo(draft.updatedAt)}</span>
        </p>
      </div>
      <StatusPill status={draft.status} />
    </button>
  );
}

// ---------------------------------------------------------------- draft view

function DraftView({
  draft, vendors, onBack, onChange, onDeleted,
}: {
  draft: PoDraftDto;
  vendors: Vendor[];
  onBack: () => void;
  onChange: (d: PoDraftDto) => void;
  onDeleted: () => void;
}) {
  const editable = draft.status === "draft";
  const [entry, setEntry] = useState("");
  const [lastScan, setLastScan] = useState<DraftLine | null>(null);
  const [flashSku, setFlashSku] = useState<string | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [undoStack, setUndoStack] = useState<string[]>([]);
  const [cameraOn, setCameraOn] = useState(false);
  // "Start scanning" = handheld wedge mode: capture keystrokes globally so the
  // trigger works even when no input is focused (ported from Will's builder).
  const [hwScan, setHwScan] = useState(false);
  const [soundOn, setSoundOn] = useState(true);
  const soundRef = useRef(true);
  useEffect(() => { soundRef.current = soundOn; }, [soundOn]);
  const [saving, setSaving] = useState(false);
  const [modal, setModal] = useState<"push" | "book" | "delete" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const errTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftRef = useRef(draft);
  useEffect(() => { draftRef.current = draft; }, [draft]);

  // Debounced autosave — every mutation routes through here.
  // vendor: undefined = unchanged, null = cleared to "No vendor".
  const persist = useCallback((lines: DraftLine[], vendor?: Vendor | null) => {
    const next: PoDraftDto = {
      ...draftRef.current,
      lines,
      ...(vendor !== undefined ? { vendorId: vendor?.id ?? null, vendorName: vendor?.name ?? "" } : {}),
    };
    onChange(next);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      setSaving(true);
      void fetch(`/api/po-scanner/drafts/${next.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ lines: next.lines, vendorId: next.vendorId, vendorName: next.vendorName }),
      })
        .then((r) => jsonOrThrow<{ draft: PoDraftDto }>(r))
        .then(({ draft: saved }) => onChange(saved))
        .catch((err) => setError(err instanceof Error ? err.message : "Autosave failed."))
        .finally(() => setSaving(false));
    }, 500);
  }, [onChange]);

  useEffect(() => () => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    if (errTimer.current) clearTimeout(errTimer.current);
  }, []);

  const flash = (sku: string) => {
    setFlashSku(sku);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlashSku(null), 1200);
  };
  const showScanError = (msg: string) => {
    if (soundRef.current) scanBuzz();
    setScanError(msg);
    if (errTimer.current) clearTimeout(errTimer.current);
    errTimer.current = setTimeout(() => setScanError(null), 4000);
  };

  /** Add one unit of a product — TOP of the list, flash, bing, undoable. */
  const addLine = useCallback((line: Omit<DraftLine, "qty">) => {
    const cur = draftRef.current.lines;
    const existing = cur.find((l) => l.sku === line.sku);
    const updated: DraftLine = existing ? { ...existing, qty: existing.qty + 1 } : { ...line, qty: 1 };
    const next = [updated, ...cur.filter((l) => l.sku !== line.sku)];
    if (soundRef.current) scanBing();
    setLastScan(updated);
    setUndoStack((s) => [...s, line.sku].slice(-50));
    flash(line.sku);
    persist(next);
  }, [persist]);

  const handleCode = useCallback(async (raw: string) => {
    const code = raw.trim();
    if (!code || !editable) return;
    setScanError(null);
    try {
      const res = await fetch(`/api/scan/${encodeURIComponent(code)}`);
      const json = (await res.json()) as ScanResponse & { error?: string };
      if (!res.ok || json.error) throw new Error(json.error ?? "Scan lookup failed.");
      const products = json.matches.filter((m) => m.kind === "product");
      const location = json.matches.find((m) => m.kind === "location");
      if (products.length === 1) {
        const it = products[0].item;
        addLine({ sku: it.sku, title: it.title, size: it.size, barcode: it.barcode });
      } else if (products.length > 1) {
        // Barcode ambiguity is rare — take the first but say so.
        const it = products[0].item;
        addLine({ sku: it.sku, title: it.title, size: it.size, barcode: it.barcode });
        setScanError(`“${code}” matched ${products.length} products — added ${it.sku}. Check it.`);
      } else if (location) {
        showScanError(`${location.name} is a location — scan a product.`);
      } else {
        showScanError(`No product found for “${code}”.`);
      }
    } catch (err) {
      showScanError(err instanceof Error ? err.message : `Scan failed for “${code}”.`);
    }
  }, [editable, addLine]);

  const scanner = useBarcodeScanner({ videoRef, onDecode: (t) => void handleCode(t) });

  // Keep the latest handler for the global listener without re-subscribing.
  const onScanRef = useRef(handleCode);
  useEffect(() => { onScanRef.current = handleCode; }, [handleCode]);

  // Handheld (USB/Bluetooth) scanner = keyboard wedge: it types the code fast
  // then Enter. While armed, capture globally — buffering rapid keystrokes and
  // flushing on Enter (or a short quiet gap, for scanners with no terminator).
  // Skipped while a field is focused so normal typing still works.
  useEffect(() => {
    if (!hwScan || !editable) return;
    let buf = "";
    let last = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      const code = buf.trim();
      buf = "";
      if (code.length >= 2) void onScanRef.current(code);
    };
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const now = Date.now();
      if (e.key === "Enter") {
        if (buf) { e.preventDefault(); clearTimeout(timer); flush(); }
        return;
      }
      if (e.key.length === 1) {
        if (now - last > 120) buf = ""; // a gap → start of a new code (or stray key)
        buf += e.key;
        last = now;
        clearTimeout(timer);
        timer = setTimeout(flush, 140);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); clearTimeout(timer); };
  }, [hwScan, editable]);

  function toggleCamera() {
    primeAudio();
    if (cameraOn) { scanner.stop(); setCameraOn(false); }
    else { setCameraOn(true); scanner.start(); }
  }

  function undoLast() {
    const sku = undoStack[undoStack.length - 1];
    if (!sku) return;
    setUndoStack((s) => s.slice(0, -1));
    const cur = draftRef.current.lines;
    const line = cur.find((l) => l.sku === sku);
    if (!line) return;
    const next = line.qty > 1
      ? cur.map((l) => (l.sku === sku ? { ...l, qty: l.qty - 1 } : l))
      : cur.filter((l) => l.sku !== sku);
    setLastScan(null);
    persist(next);
  }

  function setQty(sku: string, qty: number) {
    const cur = draftRef.current.lines;
    const next = qty <= 0 ? cur.filter((l) => l.sku !== sku) : cur.map((l) => (l.sku === sku ? { ...l, qty } : l));
    persist(next);
  }

  async function doDelete() {
    try {
      await jsonOrThrow(await fetch(`/api/po-scanner/drafts/${draft.id}`, { method: "DELETE" }));
      onDeleted();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed.");
      setModal(null);
    }
  }

  const units = draftUnits(draft);
  const vendor = vendors.find((v) => v.id === draft.vendorId) ?? null;

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* header strip */}
      <div className="bg-white border-b border-slate-200 px-4 lg:px-6 py-3 flex flex-wrap items-center gap-3 shrink-0">
        <button onClick={onBack} className="flex items-center gap-1 text-sm text-slate-500 hover:text-slate-900 transition-colors -ml-1">
          <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6" /></svg>
          POs
        </button>
        <span className="w-px h-5 bg-slate-200" />
        <span className="font-mono text-[13px] font-semibold text-slate-900">{draft.poNumber}</span>
        <StatusPill status={draft.status} />
        {editable && (
          <select
            value={draft.vendorId ?? ""}
            onChange={(e) => {
              const v = vendors.find((x) => x.id === e.target.value) ?? null;
              persist(draftRef.current.lines, v);
            }}
            className="bg-white border border-slate-200 rounded-lg px-2 py-1.5 text-[12px] text-slate-600"
          >
            <option value="">No vendor</option>
            {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
        )}
        {!editable && vendor && <span className="text-[12px] text-slate-400">{vendor.name}</span>}
        <span className="ml-auto text-[11px] text-slate-400">{saving ? "saving…" : "saved"}</span>
        {editable && (
          <>
            <button
              onClick={() => setModal("delete")}
              className="px-3 py-1.5 rounded-lg text-[12px] text-slate-400 hover:text-rose-600 hover:bg-rose-50 transition-colors"
            >
              Delete
            </button>
            <button
              onClick={() => setModal("push")}
              disabled={draft.lines.length === 0}
              className="px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-500 disabled:opacity-40 transition-colors"
            >
              Push to ShipHero
            </button>
          </>
        )}
        {draft.status === "pushed" && (
          <button
            onClick={() => setModal("book")}
            className="px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-500 transition-colors"
          >
            Book in
          </button>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="p-4 lg:p-6 flex flex-col gap-4">
          {error && <div className="bg-rose-50 border border-rose-200 text-rose-700 text-sm rounded-lg px-4 py-3">{error}</div>}

          <div className={`grid gap-4 lg:gap-6 items-start ${editable ? "lg:grid-cols-[420px_minmax(0,1fr)]" : "grid-cols-1"}`}>
          {editable && (
            <div className="flex flex-col gap-4 min-w-0 lg:sticky lg:top-0">
              {/* scan toolbar — matches the old app: SKU entry, camera icon,
                  sound toggle, and Start scanning arming the wedge listener */}
              <div className="flex flex-wrap items-center gap-2">
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    primeAudio();
                    void handleCode(entry);
                    setEntry("");
                    inputRef.current?.focus();
                  }}
                  className="flex gap-1.5 flex-1 min-w-[210px]"
                >
                  <input
                    ref={inputRef}
                    value={entry}
                    onChange={(e) => setEntry(e.target.value)}
                    placeholder="Add by SKU or barcode…"
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    className="flex-1 min-w-0 bg-white border border-slate-300 rounded-lg px-3 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                  />
                  <button type="submit" className="px-3.5 py-2.5 rounded-lg border border-slate-200 bg-white text-sm font-medium text-slate-700 hover:border-indigo-300 hover:bg-indigo-50/40 transition-colors shrink-0">
                    Add
                  </button>
                </form>
                <button
                  type="button"
                  onClick={toggleCamera}
                  title={cameraOn ? "Stop the camera" : "Scan with the camera"}
                  className={`w-10 h-10 rounded-lg border grid place-items-center transition-colors shrink-0 ${
                    cameraOn ? "bg-indigo-600 border-indigo-600 text-white" : "bg-white border-slate-200 text-slate-600 hover:border-indigo-300"
                  }`}
                >
                  <svg width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" /><circle cx="12" cy="13" r="4" /></svg>
                </button>
                <button
                  type="button"
                  onClick={() => setSoundOn((v) => !v)}
                  title={soundOn ? "Beeps on — tap to mute" : "Beeps muted — tap to unmute"}
                  className={`w-10 h-10 rounded-lg border grid place-items-center transition-colors shrink-0 ${
                    soundOn ? "bg-white border-slate-200 text-slate-600 hover:border-indigo-300" : "bg-slate-100 border-slate-200 text-slate-300"
                  }`}
                >
                  {soundOn ? (
                    <svg width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M11 5 6 9H2v6h4l5 4zM15.5 8.5a5 5 0 0 1 0 7M19 5a9 9 0 0 1 0 14" /></svg>
                  ) : (
                    <svg width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M11 5 6 9H2v6h4l5 4zM23 9l-6 6M17 9l6 6" /></svg>
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => { primeAudio(); setHwScan((v) => !v); }}
                  className={`flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-semibold transition-colors shrink-0 ${
                    hwScan ? "bg-emerald-600 text-white hover:bg-emerald-500" : "bg-slate-900 text-white hover:bg-slate-700"
                  }`}
                >
                  <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M3 5v14M7 5v14M11 5v14M15 5v14M19 5v14M21 5v14" /></svg>
                  {hwScan ? "Scanning — stop" : "Start scanning"}
                </button>
              </div>
              {hwScan && (
                <p className="text-[12px] text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2 -mt-1.5">
                  Handheld armed — pull the trigger anywhere on this page, no need to click a box first.
                </p>
              )}

              {cameraOn && (
                <div className="relative rounded-2xl overflow-hidden bg-slate-900">
                  <video ref={videoRef} className="w-full max-h-[260px] object-cover" muted playsInline />
                  <div className="absolute inset-x-8 top-1/2 -translate-y-1/2 h-0.5 bg-rose-500/70 rounded-full pointer-events-none" />
                  {scanner.torchSupported && (
                    <button
                      onClick={scanner.toggleTorch}
                      className={`absolute bottom-3 right-3 px-3 py-1.5 rounded-lg text-xs font-medium ${
                        scanner.torchOn ? "bg-amber-400 text-slate-900" : "bg-slate-800/80 text-white"
                      }`}
                    >
                      {scanner.torchOn ? "Torch on" : "Torch"}
                    </button>
                  )}
                  {scanner.status !== "scanning" && (
                    <div className="absolute inset-0 flex items-center justify-center bg-slate-900/70 text-center p-4">
                      <p className="text-sm text-slate-200">
                        {scanner.status === "starting" ? "Starting camera…"
                          : scanner.status === "denied" ? "Camera permission denied — use the box above."
                          : scanner.status === "unsupported" ? "No camera here — handheld scanners still work."
                          : scanner.error ?? "Camera failed."}
                      </p>
                    </div>
                  )}
                </div>
              )}

              {/* last scanned + errors */}
              {scanError && (
                <div className="bg-rose-50 border border-rose-200 rounded-xl px-4 py-3">
                  <p className="text-sm font-medium text-rose-700">{scanError}</p>
                </div>
              )}
              {lastScan && !scanError && (
                <div className="bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-[11px] uppercase tracking-wider text-emerald-600">Last scanned</p>
                    <p className="text-[14px] font-semibold text-emerald-900 truncate">
                      {lastScan.title}{lastScan.size && <span className="ml-1.5 font-normal">· {lastScan.size}</span>}
                    </p>
                  </div>
                  <span className="font-mono text-xl font-bold text-emerald-700 shrink-0">×{lastScan.qty}</span>
                </div>
              )}
            </div>
          )}

          <div className="flex flex-col gap-4 min-w-0">
          {/* totals strip — sticky so the counters are always in view */}
          <div className="sticky top-0 z-10 bg-slate-100 -mx-1 px-1 py-1.5">
            <div className="bg-white rounded-xl border border-slate-200 px-4 py-2.5 flex items-center gap-4 shadow-sm">
              <span className="text-[13px] text-slate-500"><span className="font-mono font-bold text-slate-900 text-[15px]">{draft.lines.length}</span> SKUs</span>
              <span className="text-[13px] text-slate-500"><span className="font-mono font-bold text-slate-900 text-[15px]">{units}</span> units</span>
              {editable && undoStack.length > 0 && (
                <button onClick={undoLast} className="ml-auto text-[12px] text-slate-500 hover:text-slate-900 px-2 py-1 rounded hover:bg-slate-100 transition-colors">
                  ↩ Undo last scan
                </button>
              )}
            </div>
          </div>

          {/* lines — newest scan always first */}
          {draft.lines.length === 0 ? (
            <p className="text-sm text-slate-400 text-center py-8">Nothing scanned yet — the first scan starts the list.</p>
          ) : (
            <div className="flex flex-col gap-1.5">
              {draft.lines.map((l) => (
                <div
                  key={l.sku}
                  className={`flex items-center justify-between gap-3 bg-white rounded-xl border px-4 py-2.5 transition-colors duration-500 ${
                    flashSku === l.sku ? "border-emerald-400 bg-emerald-50" : "border-slate-200"
                  }`}
                >
                  <div className="min-w-0">
                    <p className="text-[13px] font-medium text-slate-900 truncate">{l.title}</p>
                    <p className="text-[11px] font-mono text-slate-400">
                      {l.sku}{l.size && <span className="ml-2 font-sans text-slate-500">{l.size}</span>}
                    </p>
                  </div>
                  {editable ? (
                    <div className="flex items-center gap-1 shrink-0">
                      <button onClick={() => setQty(l.sku, l.qty - 1)} className="w-8 h-8 rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50 text-lg leading-none">−</button>
                      <span className="w-10 text-center font-mono text-[15px] font-bold text-slate-900">{l.qty}</span>
                      <button onClick={() => setQty(l.sku, l.qty + 1)} className="w-8 h-8 rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50 text-lg leading-none">+</button>
                    </div>
                  ) : (
                    <span className="font-mono text-[15px] font-bold text-slate-900 shrink-0">×{l.qty}</span>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* booked summary */}
          {draft.status === "booked" && draft.bookInResult && <BookedSummary result={draft.bookInResult} />}
          </div>
          </div>
        </div>
      </div>

      {modal === "delete" && (
        <ConfirmShell title={`Delete ${draft.poNumber}?`} onClose={() => setModal(null)}>
          <p className="text-sm text-slate-600">The draft and everything scanned into it will be gone. Nothing was sent to ShipHero.</p>
          <div className="flex justify-end gap-2 mt-4">
            <button onClick={() => setModal(null)} className="px-4 py-2 rounded-lg text-sm text-slate-500 hover:bg-slate-100">Keep it</button>
            <button onClick={() => void doDelete()} className="px-4 py-2 rounded-lg bg-rose-600 text-white text-sm font-medium hover:bg-rose-500">Delete draft</button>
          </div>
        </ConfirmShell>
      )}
      {modal === "push" && (
        <PushModal draft={draft} vendorName={vendor?.name ?? draft.vendorName} onClose={() => setModal(null)} onPushed={(d) => { onChange(d); setModal(null); }} />
      )}
      {modal === "book" && (
        <BookInModal draft={draft} onClose={() => setModal(null)} onDone={(d) => { if (d) onChange(d); }} />
      )}
    </div>
  );
}

function ConfirmShell({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[88vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
          <h2 className="text-[15px] font-semibold text-slate-900">{title}</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700 p-1 rounded" aria-label="Close">
            <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto p-5">{children}</div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- push modal

function PushModal({ draft, vendorName, onClose, onPushed }: {
  draft: PoDraftDto;
  vendorName: string;
  onClose: () => void;
  onPushed: (d: PoDraftDto) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function push() {
    setBusy(true);
    setError(null);
    try {
      const { draft: updated } = await jsonOrThrow<{ draft: PoDraftDto }>(
        await fetch(`/api/po-scanner/drafts/${draft.id}/push`, { method: "POST" }),
      );
      onPushed(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Push failed.");
      setBusy(false);
    }
  }

  return (
    <ConfirmShell title={`Push ${draft.poNumber} to ShipHero`} onClose={busy ? () => {} : onClose}>
      <p className="text-sm text-slate-600">
        This creates the purchase order in ShipHero — <span className="font-medium text-slate-900">{vendorName || "no vendor"}</span>,{" "}
        {draft.lines.length} SKU{draft.lines.length === 1 ? "" : "s"}, {draftUnits(draft)} units, status Pending.
        Booking it into a bin is the next step, after it exists.
      </p>
      <div className="mt-3 max-h-56 overflow-y-auto rounded-lg border border-slate-100 divide-y divide-slate-100">
        {draft.lines.map((l) => (
          <div key={l.sku} className="flex items-center justify-between px-3 py-2 text-[12px]">
            <span className="min-w-0 truncate text-slate-600">{l.title} {l.size && `· ${l.size}`}<span className="text-slate-300 font-mono ml-2">{l.sku}</span></span>
            <span className="font-mono font-semibold text-slate-900 shrink-0">×{l.qty}</span>
          </div>
        ))}
      </div>
      {error && <p className="text-sm text-rose-600 mt-3">{error}</p>}
      <div className="flex justify-end gap-2 mt-4">
        <button onClick={onClose} disabled={busy} className="px-4 py-2 rounded-lg text-sm text-slate-500 hover:bg-slate-100 disabled:opacity-40">Cancel</button>
        <button onClick={() => void push()} disabled={busy} className="px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-500 disabled:opacity-60">
          {busy ? "Pushing…" : "Confirm — create in ShipHero"}
        </button>
      </div>
    </ConfirmShell>
  );
}

// -------------------------------------------------------------- book-in modal

function BookInModal({ draft, onClose, onDone }: {
  draft: PoDraftDto;
  onClose: () => void;
  onDone: (d: PoDraftDto | null) => void;
}) {
  const [check, setCheck] = useState<LivePoCheck | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [ackDiffs, setAckDiffs] = useState(false);
  const [bin, setBin] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<BookInResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const { check: c } = await jsonOrThrow<{ check: LivePoCheck }>(
          await fetch(`/api/po-scanner/drafts/${draft.id}/live`),
        );
        setCheck(c);
      } catch (err) {
        setCheckError(err instanceof Error ? err.message : "Couldn't fetch the live PO.");
      }
    })();
  }, [draft.id]);

  const liveUnits = check?.lines.reduce((a, l) => a + Math.max(0, l.ordered - l.received), 0) ?? 0;
  const clean = check !== null && check.diffs.length === 0;
  const canPick = check !== null && (clean || ackDiffs);

  async function bookIn() {
    if (!bin) return;
    setBusy(true);
    setError(null);
    try {
      const { result: r, draft: updated } = await jsonOrThrow<{ result: BookInResult; draft: PoDraftDto | null }>(
        await fetch(`/api/po-scanner/drafts/${draft.id}/book-in`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ bin }),
        }),
      );
      setResult(r);
      onDone(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Book-in failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <ConfirmShell title={`Book in ${draft.poNumber}`} onClose={busy ? () => {} : onClose}>
      {result ? (
        <BookedSummary result={result} onClose={onClose} />
      ) : checkError ? (
        <p className="text-sm text-rose-600">{checkError}</p>
      ) : check === null ? (
        <p className="text-sm text-slate-400">Checking the PO in ShipHero…</p>
      ) : (
        <div className="flex flex-col gap-4">
          {/* match check — ShipHero is the source of truth */}
          {clean ? (
            <div className="bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3">
              <p className="text-sm font-medium text-emerald-800">
                ✓ ShipHero matches what you submitted — {check.lines.length} SKU{check.lines.length === 1 ? "" : "s"}, {liveUnits} units to book in.
              </p>
            </div>
          ) : (
            <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
              <p className="text-sm font-semibold text-amber-800">ShipHero doesn’t quite match your draft:</p>
              <ul className="mt-1.5 text-[13px] text-amber-700 list-disc pl-5 space-y-0.5">
                {check.diffs.map((d, i) => <li key={i}>{d}</li>)}
              </ul>
              <label className="flex items-center gap-2 mt-3 text-[13px] text-amber-900">
                <input type="checkbox" checked={ackDiffs} onChange={(e) => setAckDiffs(e.target.checked)} />
                Book in what ShipHero holds anyway ({liveUnits} units)
              </label>
            </div>
          )}

          {/* live lines */}
          <div className="max-h-44 overflow-y-auto rounded-lg border border-slate-100 divide-y divide-slate-100">
            {check.lines.map((l) => {
              const rem = Math.max(0, l.ordered - l.received);
              return (
                <div key={l.sku} className="flex items-center justify-between px-3 py-2 text-[12px]">
                  <span className="min-w-0 truncate text-slate-600">{l.productName || l.sku}<span className="text-slate-300 font-mono ml-2">{l.sku}</span></span>
                  <span className="font-mono font-semibold text-slate-900 shrink-0">×{rem}{l.received > 0 && <span className="text-amber-600 font-normal"> ({l.received} in)</span>}</span>
                </div>
              );
            })}
          </div>

          {/* bin pick */}
          <div className={canPick ? "" : "opacity-40 pointer-events-none"}>
            <p className="text-[11px] uppercase tracking-wider text-slate-400 mb-1.5">Book everything into</p>
            <div className="grid grid-cols-4 gap-1.5">
              {RET_BINS.map((b) => (
                <button
                  key={b}
                  onClick={() => { setBin(b); setConfirming(false); }}
                  className={`py-2.5 rounded-lg border font-mono text-[13px] font-semibold transition-colors ${
                    bin === b ? "bg-slate-900 text-white border-slate-900" : "bg-white text-slate-700 border-slate-200 hover:border-slate-400"
                  }`}
                >
                  {b}
                </button>
              ))}
            </div>
          </div>

          {error && <p className="text-sm text-rose-600">{error}</p>}

          {/* final confirm */}
          {confirming && bin ? (
            <div className="bg-slate-50 border border-slate-200 rounded-xl px-4 py-3">
              <p className="text-sm font-semibold text-slate-900">Final check — this writes to ShipHero:</p>
              <ul className="mt-1.5 text-[13px] text-slate-600 space-y-0.5">
                {check.lines.filter((l) => l.ordered - l.received > 0).map((l) => (
                  <li key={l.sku} className="font-mono">{l.sku} ×{l.ordered - l.received} → {bin}</li>
                ))}
                <li className="font-sans font-medium text-slate-900 pt-1">then the PO is marked Closed</li>
              </ul>
              <div className="flex justify-end gap-2 mt-3">
                <button onClick={() => setConfirming(false)} disabled={busy} className="px-4 py-2 rounded-lg text-sm text-slate-500 hover:bg-slate-100">Back</button>
                <button onClick={() => void bookIn()} disabled={busy} className="px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-500 disabled:opacity-60">
                  {busy ? "Booking in…" : `Confirm — book into ${bin} & close`}
                </button>
              </div>
            </div>
          ) : (
            <div className="flex justify-end">
              <button
                onClick={() => setConfirming(true)}
                disabled={!bin || !canPick || liveUnits === 0}
                className="px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-500 disabled:opacity-40"
              >
                Book all in{bin ? ` → ${bin}` : ""}
              </button>
            </div>
          )}
        </div>
      )}
    </ConfirmShell>
  );
}

// --------------------------------------------------------------- results view

function BookedSummary({ result, onClose }: { result: BookInResult; onClose?: () => void }) {
  const failed = result.lines.filter((l) => !l.ok);
  return (
    <div className="flex flex-col gap-3">
      <div className={`rounded-xl px-4 py-3 border ${result.closed ? "bg-emerald-50 border-emerald-200" : "bg-amber-50 border-amber-200"}`}>
        <p className={`text-sm font-semibold ${result.closed ? "text-emerald-800" : "text-amber-800"}`}>
          {result.closed
            ? `Booked into ${result.bin} and closed ✓`
            : `Booked into ${result.bin} — but NOT closed`}
        </p>
        {!result.closed && result.closeError && <p className="text-[13px] text-amber-700 mt-0.5">{result.closeError}</p>}
      </div>
      <div className="rounded-lg border border-slate-100 divide-y divide-slate-100">
        {result.lines.map((l) => (
          <div key={l.sku} className="px-3 py-2 text-[12px] flex items-center justify-between gap-3">
            <span className="font-mono text-slate-600 min-w-0 truncate">{l.sku}</span>
            <span className={`shrink-0 ${l.ok ? "text-slate-500" : "text-rose-600 font-medium"}`}>
              {l.qty === 0
                ? "nothing outstanding"
                : l.ok
                  ? `+${l.qty} received · ${result.bin} ${l.binBefore ?? 0} → ${l.binAfter ?? 0}`
                  : l.error ?? "failed — check in ShipHero"}
            </span>
          </div>
        ))}
      </div>
      {failed.length > 0 && (
        <p className="text-[13px] text-amber-700">
          {failed.length} line{failed.length === 1 ? "" : "s"} failed — the PO stays open. Run Book in again to pick up the remainder.
        </p>
      )}
      {onClose && (
        <div className="flex justify-end">
          <button onClick={onClose} className="px-4 py-2 rounded-lg bg-slate-900 text-white text-sm font-medium hover:bg-slate-700">Done</button>
        </div>
      )}
    </div>
  );
}
