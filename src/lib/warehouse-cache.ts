// DB cache for the Warehouse Activity page. A day is pulled from ShipHero once
// (pullWarehouseDay), stored as a JSON payload, and read straight from the DB
// after that — no re-parsing. Past days are immutable; only "today" is worth
// re-generating.

import { eq } from "drizzle-orm";
import { db } from "@/db";
import { warehouseDayCache } from "@/db/schema";
import { pullWarehouseDay } from "@/lib/shiphero/warehouse-pull";
import { ymd, type WarehouseDay } from "@/lib/warehouse-types";

export async function getCachedDay(date: string): Promise<WarehouseDay | null> {
  const [row] = await db.select().from(warehouseDayCache).where(eq(warehouseDayCache.date, date));
  if (!row?.payload) return null;
  try {
    return JSON.parse(row.payload) as WarehouseDay;
  } catch {
    return null;
  }
}

/** Pull the day fresh from ShipHero and store it (overwrites any existing row). */
export async function generateDay(date: string): Promise<WarehouseDay> {
  const day = await pullWarehouseDay(date);
  const value = { date, payload: JSON.stringify(day), generatedAt: day.summary.generatedAt };
  await db
    .insert(warehouseDayCache)
    .values(value)
    .onConflictDoUpdate({ target: warehouseDayCache.date, set: { payload: value.payload, generatedAt: value.generatedAt } });
  return day;
}

/** Cache-first read: past days from the DB; regenerate only when asked (or never cached). */
export async function getDay(date: string, opts: { regenerate?: boolean } = {}): Promise<WarehouseDay> {
  if (!opts.regenerate) {
    const cached = await getCachedDay(date);
    // Never trust a cached "today" as final — but still return it instantly; the
    // page offers a manual regenerate. For past days the cache is authoritative.
    if (cached && date !== ymd()) return cached;
    if (cached && !opts.regenerate) return cached;
  }
  return generateDay(date);
}
