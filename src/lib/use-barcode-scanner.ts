"use client";

// Lifecycle wrapper around @zxing/browser, ported from Will's warehouse app.
// The library loads lazily (only when the camera actually starts) so it never
// weighs on any other route's bundle. The hook owns start/stop, torch,
// duplicate-decode debouncing, and track cleanup on unmount so the camera
// light always releases.

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

export type ScannerStatus = "idle" | "starting" | "scanning" | "denied" | "unsupported" | "error";

interface Options {
  videoRef: RefObject<HTMLVideoElement | null>;
  onDecode: (text: string) => void;
}

export interface BarcodeScanner {
  status: ScannerStatus;
  error: string | null;
  torchSupported: boolean;
  torchOn: boolean;
  start: () => void;
  stop: () => void;
  toggleTorch: () => void;
}

// getUserMedia only works in a secure context (HTTPS or localhost) — never on
// a plain http LAN IP. Surfaced up-front so the page can show manual entry.
const isSecure = () =>
  typeof window !== "undefined" && window.isSecureContext && !!navigator.mediaDevices?.getUserMedia;

export function useBarcodeScanner({ videoRef, onDecode }: Options): BarcodeScanner {
  const [status, setStatus] = useState<ScannerStatus>(() => (isSecure() ? "idle" : "unsupported"));
  const [error, setError] = useState<string | null>(null);
  const [torchSupported, setTorchSupported] = useState(false);
  const [torchOn, setTorchOn] = useState(false);

  const controlsRef = useRef<{ stop: () => void } | null>(null);
  const lastRef = useRef<{ text: string; at: number }>({ text: "", at: 0 });
  // Keep the latest onDecode without restarting the camera each render.
  const onDecodeRef = useRef(onDecode);
  useEffect(() => {
    onDecodeRef.current = onDecode;
  }, [onDecode]);

  const secure = isSecure();

  const stop = useCallback(() => {
    controlsRef.current?.stop();
    controlsRef.current = null;
    const v = videoRef.current;
    const stream = v?.srcObject as MediaStream | null;
    stream?.getTracks().forEach((t) => t.stop());
    if (v) v.srcObject = null;
    setTorchOn(false);
    setTorchSupported(false);
    setStatus(secure ? "idle" : "unsupported");
  }, [videoRef, secure]);

  const start = useCallback(async () => {
    if (controlsRef.current) return; // idempotent — already running
    if (!secure || !videoRef.current) {
      setStatus("unsupported");
      return;
    }
    setStatus("starting");
    setError(null);
    try {
      const { BrowserMultiFormatReader } = await import("@zxing/browser");
      const { DecodeHintType, BarcodeFormat } = await import("@zxing/library");
      // TRY_HARDER + only the formats we actually use. This is what makes long,
      // dense Code128 bin labels (e.g. PICK-01-03-E-02) read reliably — the
      // library defaults favour quick reads of short codes and routinely miss
      // longer ones, especially off a screen or at an angle.
      const hints = new Map();
      hints.set(DecodeHintType.TRY_HARDER, true);
      hints.set(DecodeHintType.POSSIBLE_FORMATS, [
        BarcodeFormat.CODE_128,
        BarcodeFormat.CODE_39,
        BarcodeFormat.ITF,
        BarcodeFormat.EAN_13,
        BarcodeFormat.EAN_8,
        BarcodeFormat.UPC_A,
        BarcodeFormat.UPC_E,
        BarcodeFormat.QR_CODE,
      ]);
      const reader = new BrowserMultiFormatReader(hints, { delayBetweenScanAttempts: 100 });
      const controls = await reader.decodeFromConstraints(
        // Rear camera at the highest resolution the device will give, so thin
        // Code128 bars are actually resolvable (default res is often too low).
        { video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } } },
        videoRef.current,
        (result) => {
          if (!result) return;
          const text = result.getText();
          const now = Date.now();
          // Debounce: zxing fires per frame, so ignore the same code within ~1.5s.
          if (text === lastRef.current.text && now - lastRef.current.at < 1500) return;
          lastRef.current = { text, at: now };
          onDecodeRef.current(text);
        },
      );
      controlsRef.current = controls;
      setStatus("scanning");
      // Probe torch capability (rare on iOS — feature-detect and hide otherwise).
      const track = (videoRef.current?.srcObject as MediaStream | null)?.getVideoTracks?.()[0];
      const caps = track?.getCapabilities?.() as (MediaTrackCapabilities & { torch?: boolean }) | undefined;
      if (caps?.torch) setTorchSupported(true);
    } catch (e) {
      const err = e as DOMException;
      if (err?.name === "NotAllowedError" || err?.name === "SecurityError") setStatus("denied");
      else {
        setStatus("error");
        setError(err?.message || String(e));
      }
    }
  }, [secure, videoRef]);

  const toggleTorch = useCallback(async () => {
    const track = (videoRef.current?.srcObject as MediaStream | null)?.getVideoTracks?.()[0];
    if (!track) return;
    const next = !torchOn;
    try {
      await track.applyConstraints({ advanced: [{ torch: next }] } as unknown as MediaTrackConstraints);
      setTorchOn(next);
    } catch {
      /* torch not actually applicable on this device */
    }
  }, [torchOn, videoRef]);

  // Release the camera when the consumer unmounts.
  useEffect(() => () => stop(), [stop]);

  return { status, error, torchSupported, torchOn, start, stop, toggleTorch: () => void toggleTorch() };
}
