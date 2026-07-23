// DB cache + sync for the Returns Pick Faces page. The page reads the cache
// (instant, 0 API credits); ShipHero is only touched by syncBinsCache().
//
// The sync is deliberately incremental: a landing date doesn't change while
// stock sits still, so we only re-derive it for bin+SKU pairs that actually
// moved since the last sync. Destination faces are only looked up for SKUs that
// clear the collate threshold, since that's the only place they're shown.

import { eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { shipheroBinCache, appState } from "@/db/schema";
import {
  fetchBinNames,
  fetchBinContents,
  landedDatesForBin,
  fetchDestinationFace,
  fetchWarehouseId,
} from "@/lib/shiphero/bins-pull";
import { DEFAULT_BINS_SETTINGS, type BinsSettings, type BinRow } from "@/lib/bins-derive";

const KEY_SETTINGS = "bins_settings";
const KEY_BINS = "bins_all_names";
const KEY_SYNCED = "bins_last_synced_at";
const KEY_WAREHOUSE = "bins_warehouse_id";
/** How far back to read the movement log when deriving a landing date. */
const MOVEMENT_WINDOW_DAYS = 90;

const now = () => new Date().toISOString();

async function getState(key: string): Promise<string | null> {
  const [r] = await db.select().from(appState).where(eq(appState.key, key));
  return r?.value ?? null;
}
async function setState(key: string, value: string): Promise<void> {
  await db.insert(appState).values({ key, value }).onConflictDoUpdate({ target: appState.key, set: { value } });
}

// ---------- settings ----------

export async function getBinsSettings(): Promise<BinsSettings> {
  const raw = await getState(KEY_SETTINGS);
  if (!raw) return { ...DEFAULT_BINS_SETTINGS };
  try {
    const p = JSON.parse(raw) as Partial<BinsSettings>;
    return {
      collateThreshold: Number.isFinite(p.collateThreshold) ? Number(p.collateThreshold) : DEFAULT_BINS_SETTINGS.collateThreshold,
      binTarget: Number.isFinite(p.binTarget) ? Number(p.binTarget) : DEFAULT_BINS_SETTINGS.binTarget,
      ageWarnDays: Number.isFinite(p.ageWarnDays) ? Number(p.ageWarnDays) : DEFAULT_BINS_SETTINGS.ageWarnDays,
      ageStaleDays: Number.isFinite(p.ageStaleDays) ? Number(p.ageStaleDays) : DEFAULT_BINS_SETTINGS.ageStaleDays,
    };
  } catch {
    return { ...DEFAULT_BINS_SETTINGS };
  }
}

export async function saveBinsSettings(patch: Partial<BinsSettings>): Promise<BinsSettings> {
  const cur = await getBinsSettings();
  const next: BinsSettings = {
    collateThreshold: patch.collateThreshold ?? cur.collateThreshold,
    binTarget: patch.binTarget ?? cur.binTarget,
    ageWarnDays: patch.ageWarnDays ?? cur.ageWarnDays,
    ageStaleDays: patch.ageStaleDays ?? cur.ageStaleDays,
  };
  await setState(KEY_SETTINGS, JSON.stringify(next));
  return next;
}

// ---------- read ----------

export async function getCachedBins(): Promise<{
  rows: BinRow[];
  allBins: string[];
  lastSyncedAt: string | null;
}> {
  const cached = await db.select().from(shipheroBinCache);
  const rows: BinRow[] = cached.map((r) => ({
    binName: r.binName,
    sku: r.sku,
    productName: r.productName ?? "",
    quantity: r.quantity,
    landedAt: r.landedAt,
    destFace: r.destFace,
    destQty: r.destQty,
  }));
  let allBins: string[] = [];
  try {
    allBins = JSON.parse((await getState(KEY_BINS)) ?? "[]") as string[];
  } catch {
    allBins = [];
  }
  return { rows, allBins, lastSyncedAt: await getState(KEY_SYNCED) };
}

// ---------- sync ----------

export interface BinsSyncResult {
  syncedAt: string;
  bins: number;
  itemsInBins: number;
  landedLookups: number;
  destLookups: number;
}

/**
 * Refresh the cache from ShipHero.
 * @param prefix returns bins prefix (PICK-00)
 * @param destPrefix main pick faces prefix (PICK-01)
 * @param opts.full recompute every landing date, ignoring the change check
 */
export async function syncBinsCache(
  prefix = "PICK-00",
  destPrefix = "PICK-01",
  opts: { full?: boolean } = {},
): Promise<BinsSyncResult> {
  const settings = await getBinsSettings();

  let warehouseId = await getState(KEY_WAREHOUSE);
  if (!warehouseId) {
    warehouseId = await fetchWarehouseId();
    if (!warehouseId) throw new Error("Couldn't resolve the ShipHero warehouse id.");
    await setState(KEY_WAREHOUSE, warehouseId);
  }

  const [binNames, contents] = await Promise.all([
    fetchBinNames(warehouseId, prefix),
    fetchBinContents(warehouseId, prefix),
  ]);

  // Existing cache keyed bin|sku, so we can tell what actually moved.
  const existing = await db.select().from(shipheroBinCache);
  const prev = new Map(existing.map((r) => [`${r.binName}|${r.sku}`, r]));

  // Only re-derive a landing date where the row is new or its quantity/updated_at moved.
  const binsNeedingLanded = new Set<string>();
  for (const item of contents) {
    const p = prev.get(`${item.binName}|${item.sku}`);
    const changed =
      opts.full || !p || !p.landedAt || p.quantity !== item.quantity || p.itemUpdatedAt !== item.itemUpdatedAt;
    if (changed) binsNeedingLanded.add(item.binName);
  }

  const since = new Date(Date.now() - MOVEMENT_WINDOW_DAYS * 86_400_000).toISOString();
  const landedByBin = new Map<string, Record<string, string>>();
  for (const bin of binsNeedingLanded) {
    landedByBin.set(bin, await landedDatesForBin(warehouseId, bin, since));
  }

  // Destination faces only for SKUs over the collate threshold (that's the only
  // place they're displayed) — keeps the lookup count small.
  const unitsBySku = new Map<string, number>();
  for (const c of contents) unitsBySku.set(c.sku, (unitsBySku.get(c.sku) ?? 0) + c.quantity);
  const collatable = [...unitsBySku.entries()].filter(([, u]) => u > settings.collateThreshold).map(([s]) => s);
  const destBySku = new Map<string, { face: string; qty: number } | null>();
  for (const sku of collatable) {
    const cachedDest = existing.find((r) => r.sku === sku && r.destFace);
    if (!opts.full && cachedDest?.destFace) {
      destBySku.set(sku, { face: cachedDest.destFace, qty: cachedDest.destQty ?? 0 });
      continue;
    }
    destBySku.set(sku, await fetchDestinationFace(warehouseId, sku, destPrefix));
  }

  const syncedAt = now();
  for (const item of contents) {
    const key = `${item.binName}|${item.sku}`;
    const p = prev.get(key);
    const landed = landedByBin.get(item.binName)?.[item.sku] ?? p?.landedAt ?? null;
    const dest = destBySku.get(item.sku);
    const row = {
      binName: item.binName,
      sku: item.sku,
      productName: item.productName,
      quantity: item.quantity,
      landedAt: landed,
      itemUpdatedAt: item.itemUpdatedAt,
      destFace: dest ? dest.face : (p?.destFace ?? null),
      destQty: dest ? dest.qty : (p?.destQty ?? null),
      syncedAt,
    };
    await db
      .insert(shipheroBinCache)
      .values(row)
      .onConflictDoUpdate({ target: [shipheroBinCache.binName, shipheroBinCache.sku], set: row });
  }

  // Drop rows that no longer hold stock (bin emptied or SKU moved out).
  const liveKeys = new Set(contents.map((c) => `${c.binName}|${c.sku}`));
  const stale = existing.filter((r) => !liveKeys.has(`${r.binName}|${r.sku}`)).map((r) => r.id);
  if (stale.length) await db.delete(shipheroBinCache).where(inArray(shipheroBinCache.id, stale));

  await setState(KEY_BINS, JSON.stringify(binNames));
  await setState(KEY_SYNCED, syncedAt);

  return {
    syncedAt,
    bins: binNames.length,
    itemsInBins: contents.length,
    landedLookups: binsNeedingLanded.size,
    destLookups: collatable.length,
  };
}
