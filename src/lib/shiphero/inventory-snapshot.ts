// Whole-warehouse inventory snapshot — the generate → poll → download flow,
// generalised out of cycle-counts so both the low-stock report and the
// inventory-locations cache share one implementation. A snapshot is a single
// async ShipHero job (credit-cheap vs paging 4k products × locations); nothing
// here writes to ShipHero.

import { shipheroGraphql } from "./client";
import { getWarehouseId } from "./warehouse";

const q1 = (s: string) => String(s ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');

interface SnapshotFileBin {
  location_name?: string;
  quantity?: number;
  sellable?: boolean;
}
interface SnapshotFileWarehouseProduct {
  on_hand?: number;
  allocated?: number;
  available?: number;
  non_sellable?: number;
  item_bins?: Record<string, SnapshotFileBin>;
}
interface SnapshotFileProduct {
  sku?: string;
  warehouse_products?: Record<string, SnapshotFileWarehouseProduct>;
}
interface SnapshotFile {
  products?: Record<string, SnapshotFileProduct>;
}

export interface SnapshotBinQty {
  name: string;
  qty: number;
  sellable: boolean;
}
/** One SKU as the snapshot sees it: totals + every bin holding it. */
export interface SnapshotEntry {
  sku: string;
  onHand: number;
  allocated: number;
  available: number;
  nonSellable: number;
  bins: SnapshotBinQty[];
}

const POLL_TRIES = 45;
const POLL_MS = 2000;

/**
 * Generate a fresh warehouse snapshot and return every SKU with inventory
 * (has_inventory: true keeps the thousands of dead 0-qty SKUs out).
 */
export async function fetchInventorySnapshot(): Promise<{ entries: SnapshotEntry[]; snapshotAt: string }> {
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
  for (let i = 0; i < POLL_TRIES && !url; i++) {
    await new Promise((r) => setTimeout(r, i === 0 ? 1200 : POLL_MS));
    const poll = await shipheroGraphql<{
      inventory_snapshot?: { snapshot?: { status?: string; snapshot_url?: string; error?: string } };
    }>(`query { inventory_snapshot(snapshot_id: "${q1(snapshotId)}") { snapshot { status snapshot_url error } } }`);
    const snap = poll.data.inventory_snapshot?.snapshot;
    if (snap?.error) throw new Error(`ShipHero snapshot failed: ${snap.error}`);
    if (snap?.snapshot_url) url = snap.snapshot_url;
  }
  if (!url) throw new Error("The inventory snapshot didn't finish in time — try again.");

  // 3) download + flatten (the file is a plain JSON export)
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Couldn't download the inventory snapshot (${res.status}).`);
  const file = (await res.json()) as SnapshotFile;

  const entries: SnapshotEntry[] = [];
  for (const [key, product] of Object.entries(file.products ?? {})) {
    const wp =
      product.warehouse_products?.[warehouseId] ?? Object.values(product.warehouse_products ?? {})[0];
    if (!wp) continue;
    const bins = Object.values(wp.item_bins ?? {})
      .map((b) => ({ name: String(b.location_name ?? ""), qty: Number(b.quantity ?? 0), sellable: b.sellable !== false }))
      .filter((b) => b.name && b.qty !== 0);
    entries.push({
      sku: String(product.sku ?? key),
      onHand: Number(wp.on_hand ?? 0),
      allocated: Number(wp.allocated ?? 0),
      available: Number(wp.available ?? 0),
      nonSellable: Number(wp.non_sellable ?? 0),
      bins,
    });
  }
  return { entries, snapshotAt: new Date().toISOString() };
}
