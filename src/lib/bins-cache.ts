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
  fetchDestinationCandidates,
  fetchWarehouseId,
  type DestCandidate,
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

/** Warehouse id (base64), cached in app_state; resolved from ShipHero on first need. */
export async function getWarehouseId(): Promise<string> {
  let warehouseId = await getState(KEY_WAREHOUSE);
  if (!warehouseId) {
    warehouseId = await fetchWarehouseId();
    if (!warehouseId) throw new Error("Couldn't resolve the ShipHero warehouse id.");
    await setState(KEY_WAREHOUSE, warehouseId);
  }
  return warehouseId;
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
    destCandidates: (() => {
      try {
        return r.destCandidates ? (JSON.parse(r.destCandidates) as BinRow["destCandidates"]) : [];
      } catch {
        return [];
      }
    })(),
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
  destPrefix = "PICK-",
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

  // Destination faces are only shown for SKUs that are actionable — over the
  // collate threshold OR fragmented across 2+ bins (worth consolidating even
  // below threshold). Keeps the per-SKU lookup count small.
  const unitsBySku = new Map<string, number>();
  const binsBySku = new Map<string, Set<string>>();
  for (const c of contents) {
    unitsBySku.set(c.sku, (unitsBySku.get(c.sku) ?? 0) + c.quantity);
    const set = binsBySku.get(c.sku) ?? new Set<string>();
    set.add(c.binName);
    binsBySku.set(c.sku, set);
  }
  const collatable = [...unitsBySku.keys()].filter(
    (sku) => (unitsBySku.get(sku) ?? 0) > settings.collateThreshold || (binsBySku.get(sku)?.size ?? 0) > 1,
  );
  const destBySku = new Map<string, DestCandidate[]>();
  for (const sku of collatable) {
    const cachedDest = existing.find((r) => r.sku === sku && r.destCandidates);
    if (!opts.full && cachedDest?.destCandidates) {
      try {
        destBySku.set(sku, JSON.parse(cachedDest.destCandidates) as DestCandidate[]);
        continue;
      } catch {
        /* fall through and re-fetch */
      }
    }
    destBySku.set(sku, await fetchDestinationCandidates(warehouseId, sku, destPrefix));
  }

  const syncedAt = now();
  for (const item of contents) {
    const key = `${item.binName}|${item.sku}`;
    const p = prev.get(key);
    const landed = landedByBin.get(item.binName)?.[item.sku] ?? p?.landedAt ?? null;
    const cands = destBySku.get(item.sku);
    const best = cands?.[0];
    const row = {
      binName: item.binName,
      sku: item.sku,
      productName: item.productName,
      quantity: item.quantity,
      landedAt: landed,
      itemUpdatedAt: item.itemUpdatedAt,
      destFace: cands ? (best?.face ?? null) : (p?.destFace ?? null),
      destQty: cands ? (best?.qty ?? null) : (p?.destQty ?? null),
      destCandidates: cands ? JSON.stringify(cands) : (p?.destCandidates ?? null),
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
