// Client-safe field definitions + row builder (no exceljs/Buffer imports), so the
// converter UI can re-map and re-preview without pulling server-only deps.

import type { SourceRow } from "./types";

export type PoField =
  | "poNumber"
  | "productSku"
  | "title"
  | "size"
  | "supplier"
  | "variantSku"
  | "quantity"
  | "factoryCost"
  | "status";

export const PO_FIELDS: { key: PoField; label: string; required: boolean }[] = [
  { key: "poNumber", label: "PO Number", required: true },
  { key: "supplier", label: "Supplier", required: true },
  { key: "variantSku", label: "Variant SKU", required: true },
  { key: "quantity", label: "Quantity", required: true },
  { key: "factoryCost", label: "Factory Cost Price", required: true },
  { key: "productSku", label: "Product SKU (parent)", required: false },
  { key: "title", label: "Product Title", required: false },
  { key: "size", label: "Size", required: false },
  { key: "status", label: "PO Status", required: false },
];

/** Apply a field→column mapping to raw rows, producing normalized SourceRows. */
export function buildSourceRows(
  rows: string[][],
  mapping: Record<PoField, number | null>,
): SourceRow[] {
  const get = (row: string[], field: PoField): string => {
    const idx = mapping[field];
    return idx == null ? "" : String(row[idx] ?? "").trim();
  };
  const out: SourceRow[] = [];
  rows.forEach((row, i) => {
    if (row.every((c) => String(c ?? "").trim() === "")) return; // skip blank rows
    out.push({
      poNumber: get(row, "poNumber"),
      productSku: get(row, "productSku"),
      title: get(row, "title"),
      size: get(row, "size"),
      supplier: get(row, "supplier"),
      variantSku: get(row, "variantSku"),
      quantity: get(row, "quantity"),
      factoryCost: get(row, "factoryCost"),
      status: get(row, "status"),
      sourceRow: i + 2, // +1 header, +1 for 1-based
    });
  });
  return out;
}
