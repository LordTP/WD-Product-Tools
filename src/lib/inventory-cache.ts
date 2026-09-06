// Inventory-locations cache: every SKU + every bin holding it, fed by the
// ShipHero inventory snapshot (src/lib/shiphero/inventory-snapshot.ts). Powers
// Apps → Inventory and the /api/scan resolver. Each sync fully replaces the
// table (the snapshot is the whole warehouse); per-SKU totals ride in one
// app_state JSON blob alongside.

import { eq } from "drizzle-orm";
import { db } from "@/db";
import { appState, inventoryLocationsCache, type InventoryLocationRow } from "@/db/schema";
import { fetchInventorySnapshot } from "@/lib/shiphero/inventory-snapshot";

const TOTALS_KEY = "inventory_totals";

export interface InventoryTotals {
  onHand: number;
  allocated: number;
  available: number;
  nonSellable: number;
}
interface TotalsBlob {
  syncedAt: string;
  totals: Record<string, InventoryTotals>;
}

/** Pull a fresh snapshot and replace the cache. Returns row/SKU counts. */
export async function syncInventoryLocations(): Promise<{ skus: number; rows: number; snapshotAt: string }> {
  const { entries, snapshotAt } = await fetchInventorySnapshot();

  const rows = entries.flatMap((e) =>
    e.bins.map((b) => ({ sku: e.sku, bin: b.name, qty: b.qty, sellable: b.sellable, syncedAt: snapshotAt })),
  );
  const totals: Record<string, InventoryTotals> = {};
  for (const e of entries) totals[e.sku] = { onHand: e.onHand, allocated: e.allocated, available: e.available, nonSellable: e.nonSellable };

  // Full replace in one transaction so readers never see a half-written table.
  db.transaction((tx) => {
    tx.delete(inventoryLocationsCache).run();
    for (let i = 0; i < rows.length; i += 400) {
      tx.insert(inventoryLocationsCache).values(rows.slice(i, i + 400)).run();
    }
  });

  const blob: TotalsBlob = { syncedAt: snapshotAt, totals };
  await db
    .insert(appState)
    .values({ key: TOTALS_KEY, value: JSON.stringify(blob) })
    .onConflictDoUpdate({ target: appState.key, set: { value: JSON.stringify(blob) } });

  return { skus: entries.length, rows: rows.length, snapshotAt };
}

/** All cached bin rows + totals. syncedAt is null until the first sync. */
export async function getInventoryCache(): Promise<{
  rows: InventoryLocationRow[];
  totals: Record<string, InventoryTotals>;
  syncedAt: string | null;
}> {
  const [rows, [meta]] = await Promise.all([
    db.select().from(inventoryLocationsCache),
    db.select().from(appState).where(eq(appState.key, TOTALS_KEY)),
  ]);
  let totals: Record<string, InventoryTotals> = {};
  let syncedAt: string | null = null;
  if (meta?.value) {
    try {
      const blob = JSON.parse(meta.value) as TotalsBlob;
      totals = blob.totals ?? {};
      syncedAt = blob.syncedAt ?? null;
    } catch {
      /* corrupt blob — treat as unsynced */
    }
  }
  return { rows, totals, syncedAt };
}
