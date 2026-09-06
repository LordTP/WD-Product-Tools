// Live inventory-change history for one SKU or one bin — the Inventory app's
// History tab (parity with Will's, minus his ledger: we read ShipHero's
// inventory_changes on demand and cache briefly in memory). Read-only.

import { shipheroGraphql } from "./client";
import { getWarehouseId } from "./warehouse";
import { resolveUserNames } from "./rma-pull";

const q1 = (s: string) => String(s ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');

export interface InvHistoryEvent {
  at: string; // naive UTC
  user: string;
  sku: string;
  qty: number; // signed change in on-hand
  bin: string;
  reason: string;
}

function cleanReason(r: string): string {
  return r
    .replace(/<[^>]+>/g, "")
    .replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&").replace(/&quot;/g, '"')
    .replace(/\s*-\s*Product App\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

interface RawChange {
  created_at?: string;
  user_id?: string | null;
  sku?: string;
  change_in_on_hand?: number;
  reason?: string;
  location?: { name?: string } | null;
}

const NODE = `created_at user_id sku change_in_on_hand reason location { name }`;
const MAX_PAGES = 3; // 300 rows is plenty for a history view

// Pages BACKWARDS (last/before) — ShipHero returns the ledger oldest-first with
// no sort arg, so forward paging with a cap would lose the newest rows on a
// busy bin. Walking from the end keeps the most recent MAX_PAGES×100.
async function pageChanges(filter: string): Promise<RawChange[]> {
  const out: RawChange[] = [];
  let before: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const beforeArg: string = before ? `, before: "${q1(before)}"` : "";
    const query = `query { inventory_changes(${filter}) { data(last: 100${beforeArg}) {
      edges { node { ${NODE} } } pageInfo { hasPreviousPage startCursor } } } }`;
    const res = await shipheroGraphql<{
      inventory_changes?: { data?: { edges?: Array<{ node?: RawChange }>; pageInfo?: { hasPreviousPage?: boolean; startCursor?: string | null } } };
    }>(query);
    const conn = res.data.inventory_changes?.data;
    for (const e of conn?.edges ?? []) if (e.node) out.push(e.node);
    if (!conn?.pageInfo?.hasPreviousPage || !conn.pageInfo.startCursor) break;
    before = conn.pageInfo.startCursor;
  }
  return out;
}

async function toEvents(raw: RawChange[]): Promise<InvHistoryEvent[]> {
  const ids = [...new Set(raw.map((r) => r.user_id).filter((x): x is string => Boolean(x)))];
  const names = await resolveUserNames(ids).catch(() => ({} as Record<string, string>));
  return raw
    .map((r) => ({
      at: r.created_at ?? "",
      user: r.user_id ? names[r.user_id] ?? "?" : "ShipHero",
      sku: r.sku ?? "",
      qty: Number(r.change_in_on_hand ?? 0),
      bin: r.location?.name ?? "?",
      reason: cleanReason(r.reason ?? ""),
    }))
    .sort((a, b) => b.at.localeCompare(a.at)); // newest first
}

// Small in-memory cache so repeated clicks don't re-hit ShipHero.
const cache = new Map<string, { at: number; events: InvHistoryEvent[] }>();
const TTL = 10 * 60_000;

/** Change history for one SKU across all bins (last `days`, newest first). */
export async function skuHistory(sku: string, days = 90): Promise<InvHistoryEvent[]> {
  const key = `sku:${sku}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.events;
  const dateFrom = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 19);
  const raw = await pageChanges(`sku: "${q1(sku)}", date_from: "${q1(dateFrom)}"`);
  const events = await toEvents(raw);
  cache.set(key, { at: Date.now(), events });
  return events;
}

/** Change history for one bin across all SKUs (last `days`, newest first). */
export async function binHistory(bin: string, days = 30): Promise<InvHistoryEvent[]> {
  const key = `bin:${bin}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.events;
  const warehouseId = await getWarehouseId();
  const dateFrom = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 19);
  const raw = await pageChanges(`warehouse_id: "${q1(warehouseId)}", location_name: "${q1(bin)}", date_from: "${q1(dateFrom)}"`);
  const events = await toEvents(raw);
  cache.set(key, { at: Date.now(), events });
  return events;
}
