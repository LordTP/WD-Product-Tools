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
import { compareLocation, sortByLocation, type LowStockItem } from "@/lib/cycle-counts-derive";

const q1 = (s: string) => String(s ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');

// ---------- 1. low-stock report (live snapshot) ----------

interface SnapshotBin {
  location_name?: string;
  quantity?: number;
  sellable?: boolean;
}
interface SnapshotWarehouseProduct {
  on_hand?: number;
  available?: number;
  non_sellable?: number;
  item_bins?: Record<string, SnapshotBin>;
}
interface SnapshotProduct {
  sku?: string;
  warehouse_products?: Record<string, SnapshotWarehouseProduct>;
}
interface SnapshotFile {
  products?: Record<string, SnapshotProduct>;
}

const SNAPSHOT_POLL_TRIES = 45;
const SNAPSHOT_POLL_MS = 2000;

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
  const warehouseId = await getWarehouseId();

  // 1) kick off the snapshot job
  const gen = await shipheroGraphql<{
    inventory_generate_snapshot?: { snapshot?: { snapshot_id?: string } };
  }>(
    `mutation { inventory_generate_snapshot(data: { warehouse_id: "${q1(warehouseId)}", has_inventory: true, new_format: true }) { snapshot { snapshot_id status } } }`,
  );
  const snapshotId = gen.data.inventory_generate_snapshot?.snapshot?.snapshot_id;
  if (!snapshotId) throw new Error("ShipHero didn't return an inventory snapshot id.");

  // 2) poll until it produces a download url
  let url: string | null = null;
  for (let i = 0; i < SNAPSHOT_POLL_TRIES && !url; i++) {
    await new Promise((r) => setTimeout(r, i === 0 ? 1200 : SNAPSHOT_POLL_MS));
    const poll = await shipheroGraphql<{
      inventory_snapshot?: { snapshot?: { status?: string; snapshot_url?: string; error?: string } };
    }>(`query { inventory_snapshot(snapshot_id: "${q1(snapshotId)}") { snapshot { status snapshot_url error } } }`);
    const snap = poll.data.inventory_snapshot?.snapshot;
    if (snap?.error) throw new Error(`ShipHero snapshot failed: ${snap.error}`);
    if (snap?.snapshot_url) url = snap.snapshot_url;
  }
  if (!url) throw new Error("The inventory snapshot didn't finish in time — try again.");

  // 3) download + filter (the file is a plain JSON export)
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Couldn't download the inventory snapshot (${res.status}).`);
  const file = (await res.json()) as SnapshotFile;

  const items: LowStockItem[] = [];
  for (const [key, product] of Object.entries(file.products ?? {})) {
    const wp =
      product.warehouse_products?.[warehouseId] ?? Object.values(product.warehouse_products ?? {})[0];
    if (!wp) continue;
    const onHand = Number(wp.on_hand ?? 0);
    if (onHand < minQty || onHand > maxQty) continue;
    const locations = Object.values(wp.item_bins ?? {})
      .map((b) => ({ name: b.location_name ?? "", qty: Number(b.quantity ?? 0) }))
      .filter((l) => l.name && l.qty > 0)
      .sort((a, b) => compareLocation(a.name, b.name));
    items.push({
      sku: product.sku ?? key,
      onHand,
      available: Number(wp.available ?? 0),
      nonSellable: Number(wp.non_sellable ?? 0),
      locations,
      primaryLocation: locations[0]?.name ?? null,
    });
  }
  return { items: sortByLocation(items), snapshotAt: new Date().toISOString() };
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
