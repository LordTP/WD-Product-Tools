// Local log of the cycle counts we created + on-demand status refresh.
// This is the ONLY thing stored for cycle counts (a handful of rows) — the
// low-stock report itself is always live from a snapshot. Mirrors the PO cache
// pattern: read from the DB instantly, refresh live status from ShipHero on a
// button press.

import { eq, desc } from "drizzle-orm";
import { db } from "@/db";
import { cycleCountLog, appState } from "@/db/schema";
import {
  fetchCycleCountStatus,
  type CycleCountBatchNode,
} from "@/lib/shiphero/cycle-counts";
import type { CycleCountRow, LowStockItem } from "@/lib/cycle-counts-derive";

const KEY_SYNCED = "cycle_counts_last_synced_at";
const now = () => new Date().toISOString();

async function getState(key: string): Promise<string | null> {
  const [r] = await db.select().from(appState).where(eq(appState.key, key));
  return r?.value ?? null;
}
async function setState(key: string, value: string): Promise<void> {
  await db.insert(appState).values({ key, value }).onConflictDoUpdate({ target: appState.key, set: { value } });
}

function toRow(r: typeof cycleCountLog.$inferSelect): CycleCountRow {
  let items: LowStockItem[] = [];
  try {
    items = r.items ? (JSON.parse(r.items) as LowStockItem[]) : [];
  } catch {
    items = [];
  }
  return {
    shipheroId: r.shipheroId,
    legacyId: r.legacyId,
    name: r.name,
    countType: r.countType,
    items,
    skuCount: r.skuCount,
    maxQty: r.maxQty,
    dueDate: r.dueDate,
    status: r.status,
    queueStatus: r.queueStatus,
    progress: r.progress,
    counted: r.counted,
    uncounted: r.uncounted,
    skusTotal: r.skusTotal,
    skusCounted: r.skusCounted,
    shStartedAt: r.shStartedAt,
    shEndedAt: r.shEndedAt,
    createdAt: r.createdAt,
    syncedAt: r.syncedAt,
  };
}

/** Extract the cached-status columns from a ShipHero batch node. */
function statusCols(b: CycleCountBatchNode) {
  return {
    legacyId: b.legacy_id != null ? String(b.legacy_id) : null,
    countType: b.count_type ?? null,
    dueDate: b.due_date ?? null,
    status: b.status ?? null,
    queueStatus: b.queue_status ?? null,
    progress: b.progress ?? null,
    counted: b.counted ?? null,
    uncounted: b.uncounted ?? null,
    skusTotal: b.skus?.total ?? null,
    skusCounted: b.skus?.counted ?? null,
    shStartedAt: b.started_at ?? null,
    shEndedAt: b.ended_at ?? null,
  };
}

/** Record a count we just created, with the SKU list we submitted. */
export async function logCreatedCount(
  batch: CycleCountBatchNode,
  submittedItems: LowStockItem[],
  maxQty: number | null,
): Promise<void> {
  const row = {
    shipheroId: batch.id,
    name: batch.name ?? "Cycle count",
    items: JSON.stringify(submittedItems),
    skuCount: submittedItems.length,
    maxQty,
    createdAt: now(),
    syncedAt: now(),
    ...statusCols(batch),
  };
  await db
    .insert(cycleCountLog)
    .values(row)
    .onConflictDoUpdate({ target: cycleCountLog.shipheroId, set: row });
}

export async function getCycleCounts(): Promise<{ rows: CycleCountRow[]; lastSyncedAt: string | null }> {
  const rows = await db.select().from(cycleCountLog).orderBy(desc(cycleCountLog.createdAt));
  return { rows: rows.map(toRow), lastSyncedAt: await getState(KEY_SYNCED) };
}

/** Re-pull live status for every stored count from ShipHero. */
export async function refreshCycleCounts(): Promise<{ rows: CycleCountRow[]; syncedAt: string }> {
  const stored = await db.select().from(cycleCountLog);
  for (const r of stored) {
    try {
      const live = await fetchCycleCountStatus(r.shipheroId);
      if (!live) continue;
      await db
        .update(cycleCountLog)
        .set({ ...statusCols(live), name: live.name ?? r.name, syncedAt: now() })
        .where(eq(cycleCountLog.shipheroId, r.shipheroId));
    } catch {
      /* skip this one; a single failure shouldn't abort the whole refresh */
    }
  }
  const syncedAt = now();
  await setState(KEY_SYNCED, syncedAt);
  const { rows } = await getCycleCounts();
  return { rows, syncedAt };
}
