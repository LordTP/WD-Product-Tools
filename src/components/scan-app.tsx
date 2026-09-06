"use client";

// Apps → Scan: point the camera (or a handheld wedge scanner) at any barcode or
// bin label. Resolves through /api/scan/[code] (cache-only) — a hit bings and
// opens the detail; an unknown code buzzes. Mobile-first: this is a floor page.

import { useCallback, useEffect, useRef, useState } from "react";
import { useBarcodeScanner } from "@/lib/use-barcode-scanner";
import { primeAudio, scanBing, scanBuzz } from "@/lib/scan-sound";
import type { ScanMatch, ScanResponse } from "@/lib/scan-types";

interface RecentScan {
  code: string;
  label: string;
  ok: boolean;
}

export function ScanApp() {
  const [entry, setEntry] = useState("");
  const [busy, setBusy] = useState(false);
  const [noMatch, setNoMatch] = useState<string | null>(null);
  const [choices, setChoices] = useState<ScanResponse | null>(null);
  const [stack, setStack] = useState<ScanMatch[]>([]);
  const [recent, setRecent] = useState<RecentScan[]>([]);
  const [cameraOn, setCameraOn] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const resolve = useCallback(async (raw: string): Promise<ScanResponse | null> => {
    const code = raw.trim();
    if (!code) return null;
    const res = await fetch(`/api/scan/${encodeURIComponent(code)}`);
    const json = (await res.json()) as ScanResponse & { error?: string };
    if (!res.ok || json.error) throw new Error(json.error ?? "Scan lookup failed.");
    return json;
  }, []);

  const matchLabel = (m: ScanMatch) => (m.kind === "location" ? m.name : m.item.title);

  // A fresh scan (camera decode or manual/wedge submit).
  const handleCode = useCallback(
    async (raw: string) => {
      const code = raw.trim();
      if (!code || busy) return;
      setBusy(true);
      setNoMatch(null);
      try {
        const r = await resolve(code);
        if (!r) return;
        if (r.matches.length) {
          scanBing();
          setRecent((prev) => [{ code, label: matchLabel(r.matches[0]), ok: true }, ...prev.filter((x) => x.code !== code)].slice(0, 8));
          if (r.matches.length === 1) {
            setChoices(null);
            setStack([r.matches[0]]);
          } else {
            setStack([]);
            setChoices(r);
          }
        } else {
          scanBuzz();
          setRecent((prev) => [{ code, label: "no match", ok: false }, ...prev.filter((x) => x.code !== code)].slice(0, 8));
          setNoMatch(code);
          if (flashTimer.current) clearTimeout(flashTimer.current);
          flashTimer.current = setTimeout(() => setNoMatch(null), 4000);
        }
      } catch (err) {
        scanBuzz();
        setNoMatch(err instanceof Error ? err.message : code);
      } finally {
        setBusy(false);
      }
    },
    [busy, resolve],
  );

  // Pivot from inside the detail modal (tap a bin on a product, or a product in
  // a bin) — pushes onto the modal stack so back works.
  const pivot = useCallback(
    async (code: string) => {
      try {
        const r = await resolve(code);
        if (r?.matches.length) setStack((s) => [...s, r.matches[0]]);
      } catch {
        /* pivot misses are silent — the row simply doesn't open */
      }
    },
    [resolve],
  );

  const scanner = useBarcodeScanner({ videoRef, onDecode: (text) => void handleCode(text) });

  function toggleCamera() {
    primeAudio();
    if (cameraOn) {
      scanner.stop();
      setCameraOn(false);
    } else {
      setCameraOn(true);
      scanner.start();
    }
  }

  useEffect(() => () => { if (flashTimer.current) clearTimeout(flashTimer.current); }, []);

  const view = stack[stack.length - 1] ?? null;

  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <div className="p-4 lg:p-6 max-w-2xl mx-auto flex flex-col gap-4">
        {/* scan zone */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            primeAudio();
            void handleCode(entry);
            setEntry("");
            inputRef.current?.focus();
          }}
          className="flex gap-2"
        >
          <input
            ref={inputRef}
            value={entry}
            onChange={(e) => setEntry(e.target.value)}
            placeholder="Scan or type a barcode, SKU or bin…"
            autoFocus
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="search"
            className="flex-1 min-w-0 bg-white border border-slate-300 rounded-xl px-4 py-3 text-[15px] text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
          />
          <button
            type="button"
            onClick={toggleCamera}
            className={`px-4 py-3 rounded-xl text-sm font-medium transition-colors shrink-0 ${
              cameraOn ? "bg-indigo-600 text-white" : "bg-slate-900 text-white hover:bg-slate-700"
            }`}
          >
            {cameraOn ? "Stop" : "Camera"}
          </button>
        </form>

        {/* camera preview */}
        {cameraOn && (
          <div className="relative rounded-2xl overflow-hidden bg-slate-900">
            <video ref={videoRef} className="w-full max-h-[340px] object-cover" muted playsInline />
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
            {(scanner.status === "starting" || scanner.status === "denied" || scanner.status === "unsupported" || scanner.status === "error") && (
              <div className="absolute inset-0 flex items-center justify-center bg-slate-900/70 text-center p-4">
                <p className="text-sm text-slate-200">
                  {scanner.status === "starting" && "Starting camera…"}
                  {scanner.status === "denied" && "Camera permission denied — allow it in the browser, or use the box above."}
                  {scanner.status === "unsupported" && "No camera available here — handheld scanners and typing still work."}
                  {scanner.status === "error" && (scanner.error ?? "Camera failed to start.")}
                </p>
              </div>
            )}
          </div>
        )}

        {/* no-match flash */}
        {noMatch && (
          <div className="bg-rose-50 border border-rose-200 rounded-xl px-4 py-3">
            <p className="text-sm font-medium text-rose-700">No match for “{noMatch}”</p>
            <p className="text-xs text-rose-500 mt-0.5">Not a known barcode, SKU or stocked bin. Empty bins aren’t in the cache.</p>
          </div>
        )}

        {/* disambiguation */}
        {choices && (
          <div className="bg-white rounded-2xl border border-slate-200 p-4">
            <p className="text-[13px] font-semibold text-slate-900 mb-2">
              “{choices.normalized}” matches {choices.matches.length} things — pick one
            </p>
            <div className="flex flex-col gap-1.5">
              {choices.matches.map((m, i) => (
                <button
                  key={i}
                  onClick={() => { setChoices(null); setStack([m]); }}
                  className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 px-3 py-2.5 hover:border-indigo-300 hover:bg-indigo-50/40 transition-colors text-left"
                >
                  <span className="min-w-0">
                    <span className="block text-[13px] text-slate-800 truncate">{matchLabel(m)}</span>
                    <span className="block text-[11px] text-slate-400">
                      {m.kind === "location" ? `bin · ${m.productCount} SKUs · ${m.units} units` : `product · ${m.item.sku}`}
                    </span>
                  </span>
                  <svg width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" className="text-slate-300 shrink-0"><path d="M9 18l6-6-6-6" /></svg>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* recent scans */}
        {recent.length > 0 && (
          <div>
            <p className="text-[11px] uppercase tracking-wider text-slate-400 mb-1.5">Recent scans</p>
            <div className="flex flex-wrap gap-1.5">
              {recent.map((r) => (
                <button
                  key={r.code}
                  onClick={() => void handleCode(r.code)}
                  className={`px-2.5 py-1.5 rounded-lg text-[12px] border transition-colors ${
                    r.ok
                      ? "bg-white border-slate-200 text-slate-600 hover:border-indigo-300"
                      : "bg-rose-50 border-rose-200 text-rose-500"
                  }`}
                >
                  {r.ok ? r.label : `${r.code} ✗`}
                </button>
              ))}
            </div>
          </div>
        )}

        {!cameraOn && recent.length === 0 && !choices && (
          <div className="text-center py-10">
            <p className="text-sm text-slate-500">
              Scan a <span className="font-medium text-slate-700">product barcode</span> to see where it lives,
              or a <span className="font-medium text-slate-700">bin label</span> to see what’s inside it.
            </p>
            <p className="text-xs text-slate-400 mt-1.5">Handheld scanners type into the box automatically — just pull the trigger.</p>
          </div>
        )}
      </div>

      {/* detail modal */}
      {view && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4" onClick={() => setStack([])}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2 px-5 py-4 border-b border-slate-100">
              {stack.length > 1 && (
                <button
                  onClick={() => setStack((s) => s.slice(0, -1))}
                  className="text-slate-400 hover:text-slate-700 -ml-1 p-1 rounded transition-colors"
                  aria-label="Back"
                >
                  <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6" /></svg>
                </button>
              )}
              <h2 className="text-[15px] font-semibold text-slate-900 truncate">{matchLabel(view)}</h2>
              <button
                onClick={() => setStack([])}
                className="ml-auto text-slate-400 hover:text-slate-700 p-1 rounded transition-colors"
                aria-label="Close"
              >
                <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12" /></svg>
              </button>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto p-5">
              {view.kind === "product" ? (
                <div className="flex flex-col gap-4">
                  <div className="flex flex-wrap items-center gap-2 text-[12px] text-slate-500">
                    <span className="font-mono">{view.item.sku}</span>
                    {view.item.size && <span className="bg-slate-100 rounded px-1.5 py-0.5 font-medium">{view.item.size}</span>}
                    {view.item.barcode && <span className="font-mono text-slate-400">{view.item.barcode}</span>}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <Chip label="on hand" value={view.item.onHand} />
                    <Chip label="allocated" value={view.item.allocated} />
                    <Chip label="available" value={view.item.available} />
                    {view.item.nonSellable > 0 && <Chip label="non-sellable" value={view.item.nonSellable} amber />}
                  </div>
                  {view.item.bins.length ? (
                    <div className="flex flex-col gap-1">
                      <p className="text-[11px] uppercase tracking-wider text-slate-400">Bins</p>
                      {view.item.bins.map((b) => (
                        <button
                          key={b.name}
                          onClick={() => void pivot(b.name)}
                          className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2.5 hover:border-indigo-300 hover:bg-indigo-50/40 transition-colors"
                        >
                          <span className="font-mono text-[13px] text-slate-700">{b.name}</span>
                          <span className="flex items-center gap-2">
                            <span className="font-mono text-[13px] font-semibold text-slate-900">{b.qty}</span>
                            <svg width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" className="text-slate-300"><path d="M9 18l6-6-6-6" /></svg>
                          </span>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-slate-400">{view.item.onHand > 0 ? "No bin recorded for this stock." : "Out of stock — no bin."}</p>
                  )}
                </div>
              ) : (
                <div className="flex flex-col gap-3">
                  <p className="text-[12px] text-slate-500">
                    {view.productCount} SKU{view.productCount === 1 ? "" : "s"} · {view.units.toLocaleString()} units in this bin
                  </p>
                  <div className="flex flex-col gap-1">
                    {view.contents.map((c) => (
                      <button
                        key={c.sku}
                        onClick={() => void pivot(c.sku)}
                        className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 px-3 py-2.5 hover:border-indigo-300 hover:bg-indigo-50/40 transition-colors text-left"
                      >
                        <span className="min-w-0">
                          <span className="block text-[13px] text-slate-800 truncate">{c.title}</span>
                          <span className="block text-[11px] font-mono text-slate-400">
                            {c.sku}
                            {c.size && <span className="ml-2 font-sans">{c.size}</span>}
                          </span>
                        </span>
                        <span className="font-mono text-[13px] font-semibold text-slate-900 shrink-0">{c.qty}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Chip({ label, value, amber }: { label: string; value: number; amber?: boolean }) {
  return (
    <span className={`inline-flex items-baseline gap-1 rounded-md px-1.5 py-0.5 text-[11px] ${
      amber && value > 0 ? "bg-amber-50 text-amber-700" : "bg-slate-100 text-slate-600"
    }`}>
      <span className="font-semibold font-mono">{value.toLocaleString()}</span>
      <span className="text-[10px] opacity-70">{label}</span>
    </span>
  );
}
