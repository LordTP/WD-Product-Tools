// Cache + sync for the Returns page. Rows live in SQLite (returns_cache, one row
// per RMA); the page reads the cache instantly and ShipHero is only touched on
// Sync. Sync window: everything created in the last 14 days PLUS back to the
// oldest still-open v2 return, so pending returns keep refreshing until they
// complete. v1 legacy (pre Swap v2 cutover) are pulled once and frozen — they
// will never be processed in ShipHero. User-id → name map is memoised in
// app_state so we only ever look a person up once.

import { eq, and, desc, min } from "drizzle-orm";
import { db } from "@/db";
import { appState, returnsCache } from "@/db/schema";
import { pullReturns, resolveUserNames } from "@/lib/shiphero/rma-pull";
import type { ReturnRow } from "@/lib/returns-types";

const NAMES_KEY = "returns_user_names";
const SYNC_META_KEY = "returns_sync_meta";
// First sync backfills from here (v1 legacy era included so the page can count it).
const BACKFILL_FROM = "2026-07-14T00:00:00";

export interface SyncMeta {
  syncedAt: string;
  rowCount: number;
  windowFrom: string;
}

async function getState(key: string): Promise<string | null> {
  const [r] = await db.select().from(appState).where(eq(appState.key, key));
  return r?.value ?? null;
}

async function setState(key: string, value: string): Promise<void> {
  await db
    .insert(appState)
    .values({ key, value })
    .onConflictDoUpdate({ target: appState.key, set: { value } });
}

async function getUserNames(): Promise<Record<string, string>> {
  try {
    return JSON.parse((await getState(NAMES_KEY)) ?? "{}") as Record<string, string>;
  } catch {
    return {};
  }
}

export async function getSyncMeta(): Promise<SyncMeta | null> {
  try {
    const v = await getState(SYNC_META_KEY);
    return v ? (JSON.parse(v) as SyncMeta) : null;
  } catch {
    return null;
  }
}

export async function listCachedReturns(): Promise<ReturnRow[]> {
  const rows = await db
    .select({ payload: returnsCache.payload })
    .from(returnsCache)
    .orderBy(desc(returnsCache.createdAt));
  const out: ReturnRow[] = [];
  for (const r of rows) {
    try {
      out.push(JSON.parse(r.payload) as ReturnRow);
    } catch {
      /* skip corrupt row */
    }
  }
  return out;
}

export async function syncReturns(opts: { full?: boolean } = {}): Promise<SyncMeta> {
  const prevMeta = await getSyncMeta();
  const anyRow = await db.select({ id: returnsCache.id }).from(returnsCache).limit(1);
  const incremental = !opts.full && anyRow.length > 0 && !!prevMeta?.syncedAt;

  let filter: string | { updatedFrom: string };
  let from: string;
  if (incremental) {
    // Only returns TOUCHED since the last sync (1h overlap) — new ones and
    // status changes on old ones both arrive in this one cheap query.
    from = new Date(new Date(prevMeta!.syncedAt).getTime() - 3600_000).toISOString().slice(0, 19);
    filter = { updatedFrom: from };
  } else {
    // Full window: last 14 days, extended back to the oldest still-pending v2
    // return (or the v2 cutover on an empty cache).
    from = new Date(Date.now() - 14 * 86_400_000).toISOString().slice(0, 19);
    if (anyRow.length === 0) {
      from = BACKFILL_FROM;
    } else {
      const [oldestPending] = await db
        .select({ m: min(returnsCache.createdAt) })
        .from(returnsCache)
        .where(and(eq(returnsCache.status, "pending"), eq(returnsCache.isV2, 1)));
      if (oldestPending?.m && oldestPending.m < from) from = oldestPending.m;
    }
    filter = from;
  }

  let names = await getUserNames();
  const { rows, unknownUserIds } = await pullReturns(filter, names);

  // Resolve any new people once, persist, and re-stamp names on this pull.
  if (unknownUserIds.length) {
    const resolved = await resolveUserNames(unknownUserIds);
    names = { ...names, ...resolved };
    await setState(NAMES_KEY, JSON.stringify(names));
    for (const r of rows) {
      for (const h of r.history) {
        if (h.userId && !h.user) h.user = names[h.userId] ?? null;
      }
    }
  }

  const syncedAt = new Date().toISOString();
  for (const r of rows) {
    if (!r.id) continue;
    await db
      .insert(returnsCache)
      .values({
        id: r.id,
        legacyId: r.legacyId,
        createdAt: r.createdAt,
        status: r.status,
        isV2: r.isV2 ? 1 : 0,
        payload: JSON.stringify(r),
        syncedAt,
      })
      .onConflictDoUpdate({
        target: returnsCache.id,
        set: { status: r.status, payload: JSON.stringify(r), syncedAt },
      });
  }

  const all = await db.select({ id: returnsCache.id }).from(returnsCache);
  const meta: SyncMeta = { syncedAt, rowCount: all.length, windowFrom: from };
  await setState(SYNC_META_KEY, JSON.stringify(meta));
  return meta;
}
