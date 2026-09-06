// Background sync scheduler — keeps every cache fresh so nobody has to press
// Sync for data to appear (the buttons remain as manual overrides). Runs once
// per server process via Next's instrumentation hook.
//
// Guard rails:
//  · production only (local dev never burns credits) unless SYNC_SCHEDULER=on
//  · SYNC_SCHEDULER=off disables it entirely in any environment
//  · every run goes through the sync-registry QUEUE — one job at a time, so
//    scheduled + manual + TV-warm work can never stack up on the credit pool
//  · London working-hours gating on the heavy jobs; light jobs run 06:00–22:00
//  · everything is incremental "since last sync"; full backfills stay manual

export async function register() {
  if (process.env.NEXT_RUNTIME === "edge") return;
  const setting = process.env.SYNC_SCHEDULER ?? "";
  if (setting === "off") { console.log("[sync] scheduler disabled (SYNC_SCHEDULER=off)"); return; }
  if (process.env.NODE_ENV !== "production" && setting !== "on") return;
  if (!process.env.SHIPHERO_REFRESH_TOKEN && !process.env.SHIPHERO_ACCESS_TOKEN) {
    console.log("[sync] scheduler idle — ShipHero isn't connected");
    return;
  }

  const { runJob } = await import("@/lib/sync-registry");
  const { ukHour } = await import("@/lib/uk-time");
  type SyncKey = Parameters<typeof runJob>[0];

  const schedule = (key: SyncKey, everyMs: number, opts: { fromHour?: number; toHour?: number; initialDelayMs?: number } = {}) => {
    const { fromHour = 6, toHour = 22, initialDelayMs = 30_000 } = opts;
    const tick = async () => {
      const h = ukHour(new Date().toISOString());
      if (h < fromHour || h >= toHour) return;
      const r = await runJob(key);
      if (!r.deduped) console.log(`[sync] ${key}: ${r.ok ? "ok" : `FAILED (${r.error})`} in ${(r.ms / 1000).toFixed(1)}s`);
    };
    setTimeout(() => { void tick(); setInterval(() => void tick(), everyMs); }, initialDelayMs);
  };

  // Light, frequent — the data people look at all day.
  schedule("po", 15 * 60_000, { initialDelayMs: 45_000 });
  schedule("returns", 20 * 60_000, { initialDelayMs: 90_000 });
  // Order Well: the TV/warm path handles minutes-level freshness cheaply; this
  // is the safety net so the page is never worse than ~20 min stale.
  schedule("ops", 20 * 60_000, { initialDelayMs: 150_000 });
  // Heavier / slower-moving.
  schedule("warehouseToday", 2 * 60 * 60_000, { fromHour: 7, toHour: 19, initialDelayMs: 5 * 60_000 });
  // Inventory locations: one snapshot job per run — cheap on credits but heavy
  // on wall-clock (generate → poll → download), so working hours only.
  schedule("inventoryLocations", 2 * 60 * 60_000, { fromHour: 7, toHour: 19, initialDelayMs: 7 * 60_000 });
  schedule("barcodes", 6 * 60 * 60_000, { initialDelayMs: 8 * 60_000 });
  schedule("cycleCounts", 6 * 60 * 60_000, { initialDelayMs: 10 * 60_000 });
  schedule("bins", 12 * 60 * 60_000, { initialDelayMs: 12 * 60_000 });
  schedule("vendors", 24 * 60 * 60_000, { initialDelayMs: 14 * 60_000 });

  console.log("[sync] background scheduler armed (po 15m · returns 20m · ops 20m · warehouse-day 2h · catalogue 6h)");
}
