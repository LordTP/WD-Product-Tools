// DB cache of ShipHero POs (headers + line items). The PO History page, dashboard
// and modal read from here (instant, no API credits); the API is only hit on an
// explicit Sync, a lazy detail fetch, or a webhook receiving-update.

import { eq, desc } from "drizzle-orm";
import { db } from "@/db";
import { shipheroPoCache } from "@/db/schema";
import {
  fetchPurchaseOrders,
  fetchPurchaseOrderDetail,
  type PoSummary,
  type PoDetail,
  type PoLineDetail,
} from "@/lib/shiphero/po-pull";
import { getSizeMap } from "@/lib/size-codes";

const now = () => new Date().toISOString();
const parse = <T>(s: string | null, fallback: T): T => {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};

/** Pull POs (headers + line items) from ShipHero into the cache. */
export async function syncPoCache(sinceISO: string): Promise<{ count: number; syncedAt: string }> {
  const pos = await fetchPurchaseOrders(sinceISO, await getSizeMap());
  const syncedAt = now();
  for (const p of pos) {
    if (!p.poNumber) continue;
    const row = {
      poNumber: p.poNumber,
      legacyId: p.legacyId,
      globalId: p.globalId,
      vendorName: p.vendorName,
      status: p.status,
      poDate: p.poDate,
      totalPrice: p.totalPrice,
      products: JSON.stringify(p.products),
      lines: JSON.stringify(p.lines),
      headerSyncedAt: syncedAt,
      linesSyncedAt: syncedAt,
    };
    await db
      .insert(shipheroPoCache)
      .values(row)
      .onConflictDoUpdate({ target: shipheroPoCache.poNumber, set: row });
  }
  return { count: pos.length, syncedAt };
}

function rowToSummary(r: typeof shipheroPoCache.$inferSelect): PoSummary {
  const lines = parse<PoLineDetail[]>(r.lines, []);
  return {
    poNumber: r.poNumber,
    legacyId: r.legacyId,
    globalId: r.globalId,
    status: r.status ?? "",
    vendorName: r.vendorName,
    poDate: r.poDate,
    totalPrice: r.totalPrice,
    products: parse<string[]>(r.products, []),
    unitsOrdered: lines.reduce((a, l) => a + l.quantity, 0),
    unitsReceived: lines.reduce((a, l) => a + l.quantityReceived, 0),
  };
}

/** Cached PO summaries (with units) + most recent sync time. No API call. */
export async function getCachedSummaries(): Promise<{ pos: PoSummary[]; lastSyncedAt: string | null }> {
  const rows = await db.select().from(shipheroPoCache).orderBy(desc(shipheroPoCache.poDate));
  const pos = rows.map(rowToSummary);
  const lastSyncedAt = rows.reduce<string | null>(
    (max, r) => (r.headerSyncedAt && (!max || r.headerSyncedAt > max) ? r.headerSyncedAt : max),
    null,
  );
  return { pos, lastSyncedAt };
}

/** The ShipHero id to address this PO in mutations (global id preferred). */
export async function getPoMutationId(poNumber: string): Promise<string | null> {
  const [row] = await db.select().from(shipheroPoCache).where(eq(shipheroPoCache.poNumber, poNumber));
  return row?.globalId ?? row?.legacyId ?? null;
}

/** Cached PO detail; fetches from ShipHero on first open (or force) and caches. */
export async function getPoDetailCached(poNumber: string, force = false): Promise<PoDetail | null> {
  const [row] = await db.select().from(shipheroPoCache).where(eq(shipheroPoCache.poNumber, poNumber));
  if (!row) return null;

  if (!force && row.lines) {
    const lines = parse<PoLineDetail[]>(row.lines, []);
    return { ...rowToSummary(row), lines };
  }

  if (!row.legacyId) return null;
  const detail = await fetchPurchaseOrderDetail(row.legacyId, await getSizeMap());
  if (!detail) return null;
  await db
    .update(shipheroPoCache)
    .set({
      lines: JSON.stringify(detail.lines),
      products: JSON.stringify(detail.products),
      status: detail.status,
      poDate: detail.poDate,
      totalPrice: detail.totalPrice,
      globalId: detail.globalId,
      linesSyncedAt: now(),
    })
    .where(eq(shipheroPoCache.poNumber, poNumber));
  return detail;
}

/** Apply a webhook/edit received-qty update to the cached lines for one PO. */
export async function updateCachedReceiving(
  poNumber: string,
  received: { sku: string; quantityReceived: number }[],
  status?: string,
): Promise<void> {
  const [row] = await db.select().from(shipheroPoCache).where(eq(shipheroPoCache.poNumber, poNumber));
  if (!row) return;
  const lines = parse<PoLineDetail[]>(row.lines, []);
  const bySku = new Map(received.map((r) => [r.sku, r.quantityReceived]));
  const updated = lines.map((l) => (bySku.has(l.sku) ? { ...l, quantityReceived: bySku.get(l.sku)! } : l));
  await db
    .update(shipheroPoCache)
    .set({ lines: JSON.stringify(updated), ...(status ? { status } : {}), linesSyncedAt: now() })
    .where(eq(shipheroPoCache.poNumber, poNumber));
}

/** Patch cached header fields after an edit (so the UI reflects it immediately). */
export async function patchCachedPo(
  poNumber: string,
  patch: Partial<{ status: string; poDate: string | null }>,
): Promise<void> {
  await db.update(shipheroPoCache).set(patch).where(eq(shipheroPoCache.poNumber, poNumber));
}
