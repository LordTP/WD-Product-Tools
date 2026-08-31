// Cache + sync for the Operations dashboard. The page reads the cached snapshot
// (instant, 0 API credits); ShipHero is only touched when the user hits Sync —
// same pattern as the PO cache. The whole snapshot is a single JSON blob in
// app_state (it's small).

import { eq } from "drizzle-orm";
import { db } from "@/db";
import { appState } from "@/db/schema";
import { computeOpsStats, type ShipScanState } from "@/lib/shiphero/ops-pull";
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

export async function syncOpsStats(): Promise<OpsStats> {
  const prev = await getOpsStats();
  const computed = await computeOpsStats(prev?.shipScan as ShipScanState | undefined);
  const stats: OpsStats = { ...computed, syncedAt: new Date().toISOString() };
  await db
    .insert(appState)
    .values({ key: KEY, value: JSON.stringify(stats) })
    .onConflictDoUpdate({ target: appState.key, set: { value: JSON.stringify(stats) } });
  return stats;
}
