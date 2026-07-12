// Pure, client-safe logic for turning ShipHero returns into Swap QC-CSV rows.
// No DB / server imports here so the Returns component can use it directly.

import type { ReturnRecord } from "@/lib/shiphero/returns-pull";

// Swap's QC statuses (Quality Control by CSV). The two condition labels are
// configurable, but should be one Swap recognises (or is mapped to in your Swap
// condition-mapping) for the upload to process cleanly.
export const SWAP_CONDITIONS = [
  "Sellable",
  "Damaged",
  "Missing",
  "Wrong item",
  "No-Value",
  "Pending",
] as const;
export type SwapCondition = (typeof SWAP_CONDITIONS)[number];

export interface ReturnsSettings {
  /** Return statuses that count as "processed / ready to export". */
  exportStatuses: string[];
  /** Label for restocked units (sellable). */
  sellableLabel: string;
  /** Label for received-but-not-restocked units (damaged). */
  damagedLabel: string;
  /** Last time a CSV was exported (for the "since last export" hint). */
  lastExportAt: string | null;
}

export const DEFAULT_RETURNS_SETTINGS: ReturnsSettings = {
  exportStatuses: ["complete"],
  sellableLabel: "Sellable",
  damagedLabel: "Damaged",
  lastExportAt: null,
};

/** The four Swap columns, in order. */
export interface SwapRow {
  "Order number": string;
  "stock condition": string;
  SKU: string;
  "Returned Quantity": number;
}

/** Strip ShipHero's leading "#": "#162359" → "162359" (Swap wants it bare). */
export const bareOrderNumber = (on: string): string => on.replace(/^#/, "").trim();

/**
 * Rows a single return contributes to the Swap CSV. Per line item:
 *  - restocked units → sellable label
 *  - the rest of the received units → damaged label
 * Lines with nothing received produce no rows (Swap marks those Missing after 48h).
 */
export function returnToSwapRows(rec: ReturnRecord, settings: ReturnsSettings): SwapRow[] {
  const order = bareOrderNumber(rec.orderNumber);
  const rows: SwapRow[] = [];
  for (const l of rec.lines) {
    const received = Math.max(0, l.quantityReceived);
    if (received === 0 || !l.sku) continue;
    const restocked = Math.min(Math.max(0, l.restock), received);
    const damaged = received - restocked;
    if (restocked > 0)
      rows.push({ "Order number": order, "stock condition": settings.sellableLabel, SKU: l.sku, "Returned Quantity": restocked });
    if (damaged > 0)
      rows.push({ "Order number": order, "stock condition": settings.damagedLabel, SKU: l.sku, "Returned Quantity": damaged });
  }
  return rows;
}

/** Does this return qualify for export under the current settings? */
export const isExportable = (rec: ReturnRecord, settings: ReturnsSettings): boolean =>
  settings.exportStatuses.map((s) => s.toLowerCase()).includes(rec.status.toLowerCase()) &&
  rec.lines.some((l) => l.quantityReceived > 0 && l.sku);
