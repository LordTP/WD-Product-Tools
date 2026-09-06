// ShipHero-facing cycle-count logic. Two halves:
//  1. The low-stock REPORT — pulled 100% live from a ShipHero inventory
//     snapshot (generate → poll → download → filter). Nothing is stored; the
//     snapshot is thrown away after we read it. `has_inventory: true` keeps the
//     thousands of dead 0-qty SKUs out.
//  2. CREATE + STATUS — create an items cycle count from a chosen SKU list, and
//     read a count's live status back (ShipHero exposes batch-level progress
//     only — no per-SKU count result — so history keeps our submitted list).

import { shipheroGraphql } from "./client";
import { getWarehouseId } from "./warehouse";
import { fetchInventorySnapshot } from "./inventory-snapshot";
import { compareLocation, sortByLocation, type LowStockItem } from "@/lib/cycle-counts-derive";

const q1 = (s: string) => String(s ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');

// ---------- 1. low-stock report (live snapshot) ----------

/**
 * Every SKU whose total on_hand is between minQty and maxQty (default 1–10),
 * with the bins it's sitting in, sorted 00 → 06 by primary location.
 * Live from a fresh ShipHero inventory snapshot — no stored data.
 */
export async function fetchLowStockItems(
  opts: { maxQty?: number; minQty?: number } = {},
): Promise<{ items: LowStockItem[]; snapshotAt: string }> {
  const maxQty = Number.isFinite(opts.maxQty) ? Number(opts.maxQty) : 10;
  const minQty = Number.isFinite(opts.minQty) ? Number(opts.minQty) : 1;
  const { entries, snapshotAt } = await fetchInventorySnapshot();

  const items: LowStockItem[] = [];
  for (const e of entries) {
    if (e.onHand < minQty || e.onHand > maxQty) continue;
    const locations = e.bins
      .map((b) => ({ name: b.name, qty: b.qty }))
      .filter((l) => l.qty > 0)
      .sort((a, b) => compareLocation(a.name, b.name));
    items.push({
      sku: e.sku,
      onHand: e.onHand,
      available: e.available,
      nonSellable: e.nonSellable,
      locations,
      primaryLocation: locations[0]?.name ?? null,
    });
  }
  return { items: sortByLocation(items), snapshotAt };
}

// ---------- 2. create + status ----------

export interface CycleCountBatchNode {
  id: string;
  legacy_id?: string | number | null;
  name?: string | null;
  count_type?: string | null;
  status?: string | null;
  queue_status?: string | null;
  due_date?: string | null;
  created_at?: string | null;
  started_at?: string | null;
  ended_at?: string | null;
  progress?: number | null;
  counted?: number | null;
  uncounted?: number | null;
  skus?: { total?: number | null; counted?: number | null } | null;
  locations?: { total?: number | null; counted?: number | null } | null;
}

const BATCH_FIELDS = `
  id legacy_id name count_type status queue_status due_date created_at started_at ended_at
  progress counted uncounted skus { total counted } locations { total counted }
`;

// Sort the ShipHero count sheet by location A→Z (00 first → 06 last), so the
// floor walks it the same order as our preview. Confirmed value per ShipHero's
// API examples.
const DEFAULT_SORT_BY = "LOCATION_NAME_ASC";

/** Create an items cycle count for the given SKUs, due on dueDate (ISO). */
export async function createItemsCycleCount(input: {
  name: string;
  skus: string[];
  dueDate: string;
  sortBy?: string;
}): Promise<CycleCountBatchNode> {
  const warehouseId = await getWarehouseId();
  const skusArg = input.skus.map((s) => `"${q1(s)}"`).join(", ");
  const mutation = `
    mutation {
      cycle_count_items_create(data: {
        name: "${q1(input.name)}",
        warehouse_id: "${q1(warehouseId)}",
        due_date: "${q1(input.dueDate)}",
        sort_by: "${q1(input.sortBy ?? DEFAULT_SORT_BY)}",
        skus: [${skusArg}]
      }) { cycle_count { ${BATCH_FIELDS} } }
    }
  `;
  const { data } = await shipheroGraphql<{
    cycle_count_items_create?: { cycle_count?: CycleCountBatchNode };
  }>(mutation);
  const cc = data.cycle_count_items_create?.cycle_count;
  if (!cc?.id) throw new Error("ShipHero didn't return the created cycle count.");
  return cc;
}

/** Live status for one cycle count. null if it no longer exists. */
export async function fetchCycleCountStatus(id: string): Promise<CycleCountBatchNode | null> {
  const { data } = await shipheroGraphql<{ cycle_count?: { data?: CycleCountBatchNode } }>(
    `query { cycle_count(id: "${q1(id)}") { data { ${BATCH_FIELDS} } } }`,
  );
  return data.cycle_count?.data ?? null;
}
