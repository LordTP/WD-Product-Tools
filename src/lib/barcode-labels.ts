// Barcode Label Press — ported from Will's wanderdoll-barcode-app (Vercel).
// Everything the /barcodes page needs: sheet CSV → products, Code 128 / EAN-13
// SVG encoders for previews + the HTML print fallback, ZPL generation for the
// Zebra GK420d, and the Zebra Browser Print bridge. Client-safe, no server deps.
//
// Printing path: try Zebra Browser Print on http://localhost:9100 FIRST — the
// plain-HTTP port has no certificate, so the recurring "site not authenticated /
// Advanced → allow" ritual (an expiring self-signed-cert exception on the HTTPS
// port) can never happen. Fall back to https://localhost:9101, then to a normal
// browser print window.

import Papa from "papaparse";

export interface LabelProduct {
  sku: string;
  po: string;
  title: string;
  colour: string;
  size: string;
  barcode: string;
}
export interface QueueItem {
  product: LabelProduct;
  qty: number;
}

// ---------- sheet parsing ----------
export const LABEL_FIELDS = ["sku", "po", "title", "colour", "size", "barcode"] as const;
type Field = (typeof LABEL_FIELDS)[number];

const KEYWORDS: Record<Field, string[]> = {
  sku: ["sku", "brandsku"],
  po: ["ponumber", "purchaseorder", "po"],
  title: ["producttitle", "productname", "title", "name", "description"],
  colour: ["colour", "color"],
  size: ["size"],
  barcode: ["barcode", "ean", "upc", "gtin"],
};
const norm = (s: string) => String(s ?? "").toLowerCase().replace(/[\s_-]/g, "");

export function autoDetectColumns(headers: string[]): Partial<Record<Field, string>> {
  const mapping: Partial<Record<Field, string>> = {};
  const normalised = headers.map((h) => ({ original: h, norm: norm(h) }));
  for (const field of LABEL_FIELDS) {
    for (const kw of KEYWORDS[field]) {
      const hit = normalised.find((h) => h.norm === kw);
      if (hit) { mapping[field] = hit.original; break; }
    }
    if (mapping[field]) continue;
    for (const kw of KEYWORDS[field]) {
      const hit = normalised.find((h) => h.norm.includes(kw));
      if (hit && !Object.values(mapping).includes(hit.original)) { mapping[field] = hit.original; break; }
    }
  }
  return mapping;
}

export function parseSheetCsv(text: string): { ok: true; products: LabelProduct[] } | { ok: false; error: string } {
  if (!text.trim()) return { ok: false, error: "Sheet returned no data." };
  const result = Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: true });
  if (result.errors?.length && !result.data?.length) return { ok: false, error: `CSV parse failed: ${result.errors[0].message}` };
  const headers = result.meta?.fields ?? [];
  const mapping = autoDetectColumns(headers);
  const missing = LABEL_FIELDS.filter((f) => !mapping[f]);
  if (missing.length) return { ok: false, error: `Sheet is missing recognisable columns for: ${missing.join(", ")}.` };
  // De-duplicate by SKU (last row wins, matching the old app's merge) — the
  // sheet contains repeated SKUs, and duplicate React keys corrupt filtering.
  const bySku = new Map<string, LabelProduct>();
  let i = 0;
  for (const row of result.data) {
    const p: LabelProduct = {
      sku: String(row[mapping.sku!] ?? "").trim(),
      po: String(row[mapping.po!] ?? "").trim(),
      title: String(row[mapping.title!] ?? "").trim(),
      colour: String(row[mapping.colour!] ?? "").trim(),
      size: String(row[mapping.size!] ?? "").trim(),
      barcode: String(row[mapping.barcode!] ?? "").trim(),
    };
    if (!(p.sku || p.title || p.barcode)) continue;
    bySku.set(p.sku || `row-${i++}`, p);
  }
  return { ok: true, products: [...bySku.values()] };
}

// ---------- barcode encoders (SVG preview + HTML fallback) ----------
const CODE128_PATTERNS = ["11011001100","11001101100","11001100110","10010011000","10010001100","10001001100","10011001000","10011000100","10001100100","11001001000","11001000100","11000100100","10110011100","10011011100","10011001110","10111001100","10011101100","10011100110","11001110010","11001011100","11001001110","11011100100","11001110100","11101101110","11101001100","11100101100","11100100110","11101100100","11100110100","11100110010","11011011000","11011000110","11000110110","10100011000","10001011000","10001000110","10110001000","10001101000","10001100010","11010001000","11000101000","11000100010","10110111000","10110001110","10001101110","10111011000","10111000110","10001110110","11101110110","11010001110","11000101110","11011101000","11011100010","11011101110","11101011000","11101000110","11100010110","11101101000","11101100010","11100011010","11101111010","11001000010","11110001010","10100110000","10100001100","10010110000","10010000110","10000101100","10000100110","10110010000","10110000100","10011010000","10011000010","10000110100","10000110010","11000010010","11001010000","11110111010","11000010100","10001111010","10100111100","10010111100","10010011110","10111100100","10011110100","10011110010","11110100100","11110010100","11110010010","11011011110","11011110110","11110110110","10101111000","10100011110","10001011110","10111101000","10111100010","11110101000","11110100010","10111011110","10111101110","11101011110","11110101110","11010000100","11010010000","11010011100","11000111010"];
const CODE128_STOP = "1100011101011";

function encodeCode128(raw: string): { bits: string; data: string } | null {
  const data = String(raw ?? "").replace(/[^\x00-\x7F]/g, "");
  if (!data) return null;
  const codes: number[] = [];
  let i = 0;
  let mode: "B" | "C";
  const digitsAhead = (from: number, max: number) => {
    let n = 0;
    while (n < max && /\d/.test(data[from + n] || "")) n++;
    return n;
  };
  const startDigits = digitsAhead(0, data.length);
  if (startDigits >= 4 || (startDigits === data.length && startDigits >= 2 && startDigits % 2 === 0)) { codes.push(105); mode = "C"; }
  else { codes.push(104); mode = "B"; }
  while (i < data.length) {
    if (mode === "C") {
      const remaining = data.length - i;
      const dig = digitsAhead(i, remaining);
      if (dig >= 2) {
        const take = Math.min(dig - (dig % 2), remaining);
        for (let k = 0; k < take; k += 2) codes.push(parseInt(data.substr(i + k, 2), 10));
        i += take;
        if (i < data.length) { codes.push(100); mode = "B"; }
      } else { codes.push(100); mode = "B"; }
    } else {
      const dig = digitsAhead(i, data.length - i);
      if (dig >= 4) { codes.push(99); mode = "C"; }
      else {
        const c = data.charCodeAt(i);
        if (c < 32 || c > 127) { i++; continue; }
        codes.push(c - 32);
        i++;
      }
    }
  }
  let checksum = codes[0];
  for (let k = 1; k < codes.length; k++) checksum += codes[k] * k;
  codes.push(checksum % 103);
  return { bits: codes.map((c) => CODE128_PATTERNS[c]).join("") + CODE128_STOP, data };
}

const EAN_L = ["0001101","0011001","0010011","0111101","0100011","0110001","0101111","0111011","0110111","0001011"];
const EAN_G = ["0100111","0110011","0011011","0100001","0011101","0111001","0000101","0010001","0001001","0010111"];
const EAN_R = ["1110010","1100110","1101100","1000010","1011100","1001110","1010000","1000100","1001000","1110100"];
const EAN_PARITY = ["LLLLLL","LLGLGG","LLGGLG","LLGGGL","LGLLGG","LGGLLG","LGGGLL","LGLGLG","LGLGGL","LGGLGL"];

function ean13CheckDigit(d12: string): number {
  let s = 0;
  for (let i = 0; i < 12; i++) s += parseInt(d12[i], 10) * (i % 2 === 0 ? 1 : 3);
  return (10 - (s % 10)) % 10;
}
export function isEAN13(s: string): boolean {
  const digits = String(s ?? "").replace(/\D/g, "");
  return digits.length === 12 || digits.length === 13;
}
function encodeEAN13(raw: string): { bits: string; data: string } | null {
  let data = String(raw ?? "").replace(/\D/g, "");
  if (data.length === 12) data += String(ean13CheckDigit(data));
  if (data.length !== 13) return null;
  const first = parseInt(data[0], 10);
  const left = data.substr(1, 6);
  const right = data.substr(7, 6);
  const parity = EAN_PARITY[first];
  let bits = "101";
  for (let k = 0; k < 6; k++) { const d = parseInt(left[k], 10); bits += parity[k] === "L" ? EAN_L[d] : EAN_G[d]; }
  bits += "01010";
  for (let k = 0; k < 6; k++) bits += EAN_R[parseInt(right[k], 10)];
  bits += "101";
  return { bits, data };
}
function encodeBarcode(raw: string): { bits: string; data: string } | null {
  const clean = String(raw ?? "").trim();
  if (!clean) return null;
  if (isEAN13(clean)) { const ean = encodeEAN13(clean); if (ean) return ean; }
  return encodeCode128(clean);
}

export function barcodeSVG(raw: string, opts: { width?: string; height?: number | string; background?: string; color?: string } = {}): string {
  const enc = encodeBarcode(raw);
  if (!enc) return "";
  const { width = "100%", height = 40, background = "white", color = "black" } = opts;
  const barCount = enc.bits.length;
  let rects = "";
  for (let i = 0; i < enc.bits.length; i++) if (enc.bits[i] === "1") rects += `<rect x="${i}" y="0" width="1.05" height="100" fill="${color}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${barCount} 100" preserveAspectRatio="none" width="${width}" height="${height}" style="display:block;background:${background};">${rects}</svg>`;
}
export function formatBarcodeNumber(raw: string): string {
  const clean = String(raw ?? "").trim();
  if (!clean) return "";
  const digits = clean.replace(/\D/g, "");
  if (digits.length === 13) return `${digits[0]} ${digits.substr(1, 6)} ${digits.substr(7, 6)} >`;
  if (digits.length === 12) { const full = digits + String(ean13CheckDigit(digits)); return `${full[0]} ${full.substr(1, 6)} ${full.substr(7, 6)} >`; }
  return clean;
}

// ---------- ZPL for the GK420d (203 dpi, 72×36mm = 576×288 dots) ----------
const DOTS_W = 576;
const DOTS_H = 288;
const zplSafe = (s: string) => String(s ?? "").toUpperCase().replace(/[\^~\\]/g, " ");

function estimateBarcodeWidth(barcode: string, moduleWidth: number): number {
  if (isEAN13(barcode)) return 95 * moduleWidth;
  const modules = String(barcode || "").length * 11 + 35;
  return Math.min(modules * moduleWidth, DOTS_W - 40);
}
function barcodeBlock(barcode: string, x: number, y: number, height: number, moduleWidth: number): string {
  if (!barcode) return "";
  if (isEAN13(barcode)) {
    const digits = String(barcode).replace(/\D/g, "");
    return [`^FO${x},${y}`, `^BY${moduleWidth},3,${height}`, `^BEN,${height},Y,N`, `^FD${digits}^FS`].join("");
  }
  return [`^FO${x},${y}`, `^BY${moduleWidth},3,${height}`, `^BCN,${height},Y,N,N`, `^FD${zplSafe(barcode)}^FS`].join("");
}

export function labelToZPL(p: LabelProduct): string {
  const FONT_H = 22, ROW_H = 26, KEY_X = 45, VAL_X = 240, PAD_TOP = 10;
  const yRow1 = PAD_TOP, yRow2 = yRow1 + ROW_H, yTitle = yRow2 + ROW_H;
  const yColour = yTitle + ROW_H * 2, ySize = yColour + ROW_H, yBarcode = ySize + ROW_H + 6;
  const isEAN = isEAN13(p.barcode);
  const moduleWidth = isEAN ? 4 : 2;
  const barcodeHeight = 56;
  const barcodeWidth = estimateBarcodeWidth(p.barcode, moduleWidth);
  const barcodeX = Math.max(15, Math.round((DOTS_W - barcodeWidth) / 2));
  const VALUE_FB_W = DOTS_W - VAL_X - 15;
  const FONT_TAG = `^A0N,${FONT_H},${FONT_H}`;
  return [
    "^XA", `^PW${DOTS_W}`, `^LL${DOTS_H}`, "^LH0,0", "^CI28",
    `^FO${KEY_X},${yRow1}${FONT_TAG}^FDWANDERDOLL SKU:^FS`, `^FO${VAL_X},${yRow1}${FONT_TAG}^FD${zplSafe(p.sku)}^FS`,
    `^FO${KEY_X},${yRow2}${FONT_TAG}^FDPO NUMBER:^FS`, `^FO${VAL_X},${yRow2}${FONT_TAG}^FD${zplSafe(p.po)}^FS`,
    `^FO${KEY_X},${yTitle}${FONT_TAG}^FDPRODUCT TITLE:^FS`, `^FO${VAL_X},${yTitle}^FB${VALUE_FB_W},2,0,L,0${FONT_TAG}^FD${zplSafe(p.title)}^FS`,
    `^FO${KEY_X},${yColour}${FONT_TAG}^FDCOLOUR:^FS`, `^FO${VAL_X},${yColour}${FONT_TAG}^FD${zplSafe(p.colour)}^FS`,
    `^FO${KEY_X},${ySize}${FONT_TAG}^FDSIZE:^FS`, `^FO${VAL_X},${ySize}${FONT_TAG}^FD${zplSafe(p.size)}^FS`,
    barcodeBlock(p.barcode, barcodeX, yBarcode, barcodeHeight, moduleWidth),
    "^XZ",
  ].join("\n");
}
export function breakLabelZPL(): string {
  return ["^XA", `^PW${DOTS_W}`, `^LL${DOTS_H}`, "^LH0,0", "^FO40,30^GB496,4,4^FS", "^FO140,95^A0N,90,90^FDBREAK^FS", "^FO40,254^GB496,4,4^FS", "^XZ"].join("\n");
}

// ---------- HTML print fallback ----------
const esc = (s: string) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function labelHTML(p: LabelProduct): string {
  const svg = barcodeSVG(p.barcode, { width: "94%", height: "9mm" });
  const num = formatBarcodeNumber(p.barcode);
  return `<div class="label"><div class="label-text">
    <div class="row"><span class="k">WANDERDOLL SKU:</span><span class="v">${esc(p.sku)}</span></div>
    <div class="row"><span class="k">PO NUMBER:</span><span class="v">${esc(p.po)}</span></div>
    <div class="row"><span class="k">PRODUCT TITLE:</span><span class="v title">${esc(p.title)}</span></div>
    <div class="row"><span class="k">COLOUR:</span><span class="v">${esc(p.colour)}</span></div>
    <div class="row"><span class="k">SIZE:</span><span class="v">${esc(p.size)}</span></div>
  </div><div class="label-barcode">${svg}<div class="label-barcode-num">${esc(num)}</div></div></div>`;
}

export function generatePrintHTML(items: QueueItem[]): string {
  const labels = items
    .flatMap(({ product, qty }) => Array.from({ length: Math.max(1, Math.floor(qty) || 1) }, () => labelHTML(product)))
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8" /><title>Wander Doll labels</title><style>
@page { size: 72mm 36mm; margin: 0; }
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { background: white; } body { font-family: 'Courier New', Courier, monospace; color: black; }
.label { width: 72mm; height: 36mm; padding: 2mm; page-break-after: always; overflow: hidden; display: flex; flex-direction: column; font-size: 7pt; line-height: 1.2; background: white; color: black; text-transform: uppercase; }
.label:last-child { page-break-after: auto; } .label-text { flex: 1; }
.row { display: flex; align-items: flex-start; gap: 1.5mm; margin-bottom: 0.3mm; }
.k { min-width: 20mm; white-space: nowrap; flex-shrink: 0; } .v { flex: 1; word-break: break-word; } .v.title { line-height: 1.15; }
.label-barcode { display: flex; flex-direction: column; align-items: center; margin-top: auto; padding-top: 0.5mm; }
.label-barcode svg { display: block; } .label-barcode-num { font-size: 6pt; letter-spacing: 1.5px; margin-top: 0.3mm; }
@media screen { body { padding: 20px; background: #eee; } .label { box-shadow: 0 2px 8px rgba(0,0,0,0.15); margin: 0 auto 12px; } }
</style></head><body>${labels}<script>window.addEventListener('load', () => { setTimeout(() => window.print(), 150); });</script></body></html>`;
}

export function openPrintWindow(items: QueueItem[]): boolean {
  const w = window.open("", "_blank", "width=900,height=700");
  if (!w) return false;
  w.document.open();
  w.document.write(generatePrintHTML(items));
  w.document.close();
  return true;
}

// ---------- Zebra Browser Print bridge ----------
// http first (no certificate → nothing to "authenticate"); https as fallback for
// installs where the http listener is off. Same batching as before: the GK420d
// buffer silently truncates big payloads, so 10 labels per POST, 1.5s apart.
const BP_HOSTS = ["http://localhost:9100", "https://localhost:9101"];
const TIMEOUT_MS = 30_000;
const BATCH_SIZE = 10;
const BATCH_DELAY_MS = 1500;

function fetchWithTimeout(url: string, opts: RequestInit = {}): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

interface BpDevice { uid?: string; name?: string }

async function findBrowserPrint(): Promise<{ host: string; device: BpDevice }> {
  let lastErr = "Browser Print service not reachable. Is it running on this PC?";
  for (const host of BP_HOSTS) {
    try {
      const res = await fetchWithTimeout(`${host}/available`);
      if (!res.ok) { lastErr = `Browser Print returned ${res.status}`; continue; }
      const body = await res.json();
      const device: BpDevice | undefined = body?.default?.uid ? body.default : Array.isArray(body?.printer) && body.printer.length ? body.printer[0] : undefined;
      if (!device) throw new Error("No Zebra printer is connected to Browser Print.");
      return { host, device };
    } catch (err) {
      if (err instanceof Error && /No Zebra printer/.test(err.message)) throw err;
      lastErr = err instanceof Error && err.name !== "AbortError" && err.message !== "Failed to fetch" ? err.message : lastErr;
    }
  }
  throw new Error(lastErr);
}

function expandLabels(items: QueueItem[]): string[] {
  const out: string[] = [];
  for (const { product, qty } of items) {
    const n = Math.max(1, Math.floor(qty) || 1);
    const zpl = labelToZPL(product);
    for (let i = 0; i < n; i++) out.push(zpl);
    out.push(breakLabelZPL());
  }
  return out;
}

export async function tryZPLPrint(items: QueueItem[]): Promise<{ ok: boolean; error?: string }> {
  try {
    const { host, device } = await findBrowserPrint();
    const labels = expandLabels(items);
    if (labels.length === 0) return { ok: true };
    for (let i = 0; i < labels.length; i += BATCH_SIZE) {
      const chunk = labels.slice(i, i + BATCH_SIZE).join("\n");
      try {
        const res = await fetchWithTimeout(`${host}/write`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ device, data: chunk }),
        });
        if (!res.ok) throw new Error(`Browser Print write failed (${res.status})`);
      } catch (err) {
        return { ok: false, error: `${err instanceof Error ? err.message : String(err)} (failed at label ${i + 1} of ${labels.length})` };
      }
      if (i + BATCH_SIZE < labels.length) await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
