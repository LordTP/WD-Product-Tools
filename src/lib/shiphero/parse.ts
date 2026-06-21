// Spreadsheet parsing + fuzzy column auto-mapping (spec §4.3).
// Server-side only (uses exceljs + Buffer). Produces a header list, raw rows, and
// a best-guess field→column mapping the user can correct in the UI.

import ExcelJS from "exceljs";
import Papa from "papaparse";
import { PO_FIELDS, type PoField } from "./fields";

// Re-export the client-safe field helpers so existing server imports keep working.
export { PO_FIELDS, buildSourceRows, type PoField } from "./fields";

// Header alias dictionary (spec §4.3). Matched against a normalized header.
const ALIASES: Record<PoField, string[]> = {
  poNumber: ["po number", "po", "po#", "po no", "purchase order", "purchaseorder"],
  variantSku: ["variant sku", "variantsku", "sku", "variant", "barcode sku", "stock sku"],
  quantity: ["quantity ordered", "quantity", "qty", "qty ordered", "units", "order qty"],
  factoryCost: ["factory cost price", "factory cost", "cost", "unit cost", "price", "cost price"],
  supplier: ["supplier", "vendor", "factory", "supplier alias"],
  productSku: ["product sku", "parent sku", "style sku", "productsku"],
  title: ["product title", "title", "product name", "name", "description"],
  size: ["size", "variant size", "product size", "size name", "sizes", "sz"],
  status: ["po status", "status", "fulfillment status", "order status"],
};

const norm = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export interface ParsedSheet {
  headers: string[];
  rows: string[][];
}

/** Detect & parse an uploaded .xlsx / .csv buffer into headers + string rows. */
export async function parseSheet(
  buffer: Buffer,
  filename: string,
): Promise<ParsedSheet> {
  const isCsv =
    filename.toLowerCase().endsWith(".csv") ||
    filename.toLowerCase().endsWith(".txt");

  if (isCsv) {
    const text = buffer.toString("utf-8");
    const parsed = Papa.parse<string[]>(text.trim(), { skipEmptyLines: true });
    const all = parsed.data;
    const headers = (all[0] ?? []).map((h) => String(h ?? "").trim());
    const rows = all.slice(1).map((r) => r.map((c) => String(c ?? "")));
    return { headers, rows };
  }

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  const ws = wb.worksheets[0];
  if (!ws) throw new Error("No worksheet found in the uploaded file.");

  const matrix: string[][] = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const values: string[] = [];
    // exceljs row.values is 1-based with a leading undefined.
    const raw = row.values as unknown[];
    for (let i = 1; i < raw.length; i++) {
      const cell = raw[i];
      values.push(cellToString(cell));
    }
    matrix.push(values);
  });

  const headers = (matrix[0] ?? []).map((h) => h.trim());
  const rows = matrix.slice(1);
  return { headers, rows };
}

function cellToString(cell: unknown): string {
  if (cell == null) return "";
  if (typeof cell === "object") {
    const obj = cell as Record<string, unknown>;
    if ("text" in obj) return String(obj.text ?? "");
    if ("result" in obj) return String(obj.result ?? ""); // formula
    if ("richText" in obj && Array.isArray(obj.richText))
      return obj.richText.map((r: { text?: string }) => r.text ?? "").join("");
    if ("hyperlink" in obj) return String(obj.hyperlink ?? "");
  }
  return String(cell);
}

/** Best-guess mapping field→column index (null = no confident match). */
export function autoMapColumns(headers: string[]): Record<PoField, number | null> {
  const normalized = headers.map(norm);
  const result = {} as Record<PoField, number | null>;
  const taken = new Set<number>();

  for (const { key } of PO_FIELDS) {
    const aliases = ALIASES[key];
    let best: number | null = null;
    // exact normalized match first, then "contains".
    for (const a of aliases) {
      const idx = normalized.findIndex((h, i) => h === a && !taken.has(i));
      if (idx !== -1) { best = idx; break; }
    }
    if (best === null) {
      for (const a of aliases) {
        const idx = normalized.findIndex(
          (h, i) => !taken.has(i) && (h.includes(a) || a.includes(h)) && h.length > 1,
        );
        if (idx !== -1) { best = idx; break; }
      }
    }
    if (best !== null) taken.add(best);
    result[key] = best;
  }
  return result;
}
