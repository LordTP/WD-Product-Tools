// Cache + sync for the Operations dashboard. The page reads the cached snapshot
// (instant, 0 API credits); ShipHero is only touched when the user hits Sync —
// same pattern as the PO cache. The whole snapshot is a single JSON blob in
// app_state (it's small).

import { eq } from "drizzle-orm";
import { db } from "@/db";
import { appState } from "@/db/schema";
import { computeOpsStats, refreshShippedStats, type ShipScanState } from "@/lib/shiphero/ops-pull";
import type { OpsStats } from "@/lib/ops-types";

const KEY = "ops_stats";

export async function getOpsStats(): Promise<OpsStats | null> {
  const [r] = await db.select().from(appState).where(eq(appState.key, KEY));
  if (!r?.value) return null;
  try {
    return JSON.parse(r.value) as OpsStats;
  } catch {
    return null;
  }
}

// One in-flight refresh at a time. warm() returns the cache instantly and
// refreshes in the background — but CHEAPLY: every ~2.5 min it only re-scans
// shipped-today (incremental, a few hundred credits); the heavy open-order
// scan (~the whole credit pool) runs at most every 15 min. A TV left on all
// day must not starve the rest of the app of ShipHero credits.
const SHIP_MAX_MS = 150_000;
const FULL_MAX_MS = 15 * 60_000;
let inflight: Promise<OpsStats> | null = null;

async function saveStats(stats: OpsStats): Promise<OpsStats> {
  await db
    .insert(appState)
    .values({ key: KEY, value: JSON.stringify(stats) })
    .onConflictDoUpdate({ target: appState.key, set: { value: JSON.stringify(stats) } });
  return stats;
}

export async function warmOpsStats(): Promise<OpsStats | null> {
  const cur = await getOpsStats();
  const age = cur ? Date.now() - new Date(cur.syncedAt).getTime() : Infinity;
  if (age < SHIP_MAX_MS) return cur;
  if (!inflight) {
    const openAge = cur ? Date.now() - new Date(cur.openScannedAt ?? cur.syncedAt).getTime() : Infinity;
    inflight = (!cur || openAge >= FULL_MAX_MS
      ? syncOpsStats()
      : refreshShippedStats(cur).then(saveStats)
    ).finally(() => { inflight = null; });
    inflight.catch(() => undefined); // background failure surfaces on next manual sync
  }
  return cur;
}

export async function syncOpsStats(): Promise<OpsStats> {
  const prev = await getOpsStats();
  const computed = await computeOpsStats(prev?.shipScan as ShipScanState | undefined);
  return saveStats({ ...computed, syncedAt: new Date().toISOString() });
}
