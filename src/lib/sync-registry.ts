// One place that knows every ShipHero sync in the app. Three jobs:
//  1. A single QUEUE — jobs run one at a time, so two heavy syncs can never
//     drain the ShipHero credit pool together (the pool is ~4k, refill 60/s;
//     a heavy scan alone eats most of it).
//  2. Uniform LAST-RUN stamps (app_state) so the dashboard / status endpoint
//     can say "POs 4m ago · returns 32m ago · warehouse day not pulled".
//  3. The catalogue the background scheduler (instrumentation.ts) drives.
// Manual Sync buttons route through the same queue, so a button press while a
// scheduled run is in flight just waits its turn instead of doubling the cost.

import { eq } from "drizzle-orm";
import { db } from "@/db";
import { appState } from "@/db/schema";
import { syncPoCache } from "@/lib/po-cache";
import { syncOpsStats } from "@/lib/ops-cache";
import { syncReturns } from "@/lib/returns-cache";
import { syncBarcodeCatalog } from "@/lib/shiphero/barcode-catalog";
import { syncBinsCache } from "@/lib/bins-cache";
import { syncVendorsFromShiphero } from "@/lib/shiphero/vendor-sync";
import { refreshCycleCounts } from "@/lib/cycle-counts-log";
import { generateDay } from "@/lib/warehouse-cache";
import { todayUkYmd } from "@/lib/uk-time";

export type SyncKey = "po" | "ops" | "returns" | "barcodes" | "bins" | "vendors" | "cycleCounts" | "warehouseToday";

interface JobDef {
  label: string;
  heavy: boolean;
  run: () => Promise<unknown>;
}

// Default runs are all INCREMENTAL "since the last sync" — full backfills only
// happen via each page's explicit full/backfill option.
export const JOBS: Record<SyncKey, JobDef> = {
  po: { label: "Purchase orders", heavy: false, run: () => syncPoCache("2025-01-01", {}) },
  ops: { label: "Order Well scan", heavy: true, run: () => syncOpsStats() },
  returns: { label: "Returns", heavy: false, run: () => syncReturns() },
  barcodes: { label: "Barcode catalogue", heavy: false, run: () => syncBarcodeCatalog() },
  bins: { label: "Returns bins", heavy: true, run: () => syncBinsCache("PICK-00", "PICK-", {}) },
  vendors: { label: "Vendors", heavy: false, run: () => syncVendorsFromShiphero() },
  cycleCounts: { label: "Cycle counts", heavy: false, run: () => refreshCycleCounts() },
  warehouseToday: { label: "Warehouse day (today)", heavy: true, run: () => generateDay(todayUkYmd()) },
};

export interface JobStamp { at: string; ok: boolean; ms: number; error?: string }
const META_KEY = "sync_registry_meta";

async function readStamps(): Promise<Partial<Record<SyncKey, JobStamp>>> {
  const [r] = await db.select().from(appState).where(eq(appState.key, META_KEY));
  if (!r?.value) return {};
  try { return JSON.parse(r.value) as Partial<Record<SyncKey, JobStamp>>; } catch { return {}; }
}
async function writeStamp(key: SyncKey, stamp: JobStamp): Promise<void> {
  const stamps = await readStamps();
  stamps[key] = stamp;
  await db
    .insert(appState)
    .values({ key: META_KEY, value: JSON.stringify(stamps) })
    .onConflictDoUpdate({ target: appState.key, set: { value: JSON.stringify(stamps) } });
}

// ---- the queue: strictly one job at a time, per-key dedupe ----
let chain: Promise<unknown> = Promise.resolve();
const inflight = new Map<SyncKey, Promise<RunResult>>();

export interface RunResult { ok: boolean; ms: number; result?: unknown; error?: string; deduped?: boolean }

/** Queue a sync. `overrideRun` lets a manual button pass its own parameters
 *  (e.g. a full backfill) while still going through the shared queue. */
export function runJob(key: SyncKey, overrideRun?: () => Promise<unknown>): Promise<RunResult> {
  const existing = inflight.get(key);
  if (existing && !overrideRun) return existing.then((r) => ({ ...r, deduped: true }));

  const p: Promise<RunResult> = chain
    .catch(() => undefined) // one job's failure never blocks the queue
    .then(async () => {
      const t0 = Date.now();
      try {
        const result = await (overrideRun ?? JOBS[key].run)();
        const stamp: JobStamp = { at: new Date().toISOString(), ok: true, ms: Date.now() - t0 };
        await writeStamp(key, stamp);
        return { ok: true, ms: stamp.ms, result };
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        await writeStamp(key, { at: new Date().toISOString(), ok: false, ms: Date.now() - t0, error }).catch(() => undefined);
        return { ok: false, ms: Date.now() - t0, error };
      }
    })
    .finally(() => { if (inflight.get(key) === p) inflight.delete(key); });
  chain = p;
  if (!overrideRun) inflight.set(key, p);
  return p;
}

export async function syncStatus(): Promise<Array<{ key: SyncKey; label: string; heavy: boolean; running: boolean; lastRun: JobStamp | null }>> {
  const stamps = await readStamps();
  return (Object.keys(JOBS) as SyncKey[]).map((key) => ({
    key,
    label: JOBS[key].label,
    heavy: JOBS[key].heavy,
    running: inflight.has(key),
    lastRun: stamps[key] ?? null,
  }));
}
