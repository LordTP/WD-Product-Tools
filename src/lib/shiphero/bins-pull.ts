// Read-only pulls for the Returns Pick Faces page.
//
// Schema confirmed by introspection + live probes:
//  - `item_locations(location_name_prefix:)` returns every SKU-in-bin row for a
//    whole prefix in ONE paginated query (no per-bin looping).
//  - Rows PERSIST at quantity 0 after stock is picked out, so `has_inventory:true`
//    (and a qty > 0 guard) is required or empty bins look occupied.
//  - `inventory_changes(location_name:)` is the per-bin movement log and carries
//    `previous_on_hand` + `change_in_on_hand`, which is how we derive an honest
//    "in bin since" (see landedDatesForBin below).

import { shipheroGraphql } from "./client";

export interface BinItem {
  binName: string;
  sku: string;
  productName: string;
  quantity: number;
  itemUpdatedAt: string | null;
}

interface Edge<T> {
  node?: T;
}
const nodesOf = <T>(conn: { edges?: Edge<T>[] } | undefined): T[] =>
  (conn?.edges ?? []).map((e) => e.node).filter((n): n is T => Boolean(n));

const q1 = (s: string) => String(s ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');

const PAGE = 100;
const MAX_PAGES = 200;

/** Every location name under a prefix (so we know the empty bins too). */
export async function fetchBinNames(warehouseId: string, prefix: string): Promise<string[]> {
  const query = `query { locations(warehouse_id: "${q1(warehouseId)}") { data(first: 100) { pageInfo { hasNextPage endCursor } edges { node { name } } } } }`;
  const names: string[] = [];
  let after: string | null = null;
  let pages = 0;
  do {
    const afterArg: string = after ? `, after: "${after}"` : "";
    const { data } = await shipheroGraphql<{
      locations?: { data?: { edges?: Edge<{ name?: string }>[]; pageInfo?: { hasNextPage?: boolean; endCursor?: string } } };
    }>(query.replace("data(first: 100)", `data(first: 100${afterArg})`));
    const conn = data.locations?.data;
    for (const n of nodesOf<{ name?: string }>(conn)) {
      if (n.name && n.name.startsWith(prefix)) names.push(n.name);
    }
    after = conn?.pageInfo?.hasNextPage ? (conn.pageInfo.endCursor ?? null) : null;
    pages += 1;
  } while (after && pages < MAX_PAGES);
  return names.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

/** Current contents of every bin under a prefix. Only rows actually holding stock. */
export async function fetchBinContents(warehouseId: string, prefix: string): Promise<BinItem[]> {
  const out: BinItem[] = [];
  let after: string | null = null;
  let pages = 0;
  do {
    const afterArg: string = after ? `, after: "${after}"` : "";
    const query = `
      query {
        item_locations(warehouse_id: "${q1(warehouseId)}", location_name_prefix: "${q1(prefix)}", has_inventory: true) {
          data(first: ${PAGE}${afterArg}) {
            pageInfo { hasNextPage endCursor }
            edges { node { sku quantity updated_at location { name } product { name } } }
          }
        }
      }
    `;
    const { data } = await shipheroGraphql<{
      item_locations?: {
        data?: {
          edges?: Edge<{
            sku?: string;
            quantity?: number;
            updated_at?: string;
            location?: { name?: string } | null;
            product?: { name?: string } | null;
          }>[];
          pageInfo?: { hasNextPage?: boolean; endCursor?: string };
        };
      };
    }>(query);
    const conn = data.item_locations?.data;
    for (const n of nodesOf(conn)) {
      const qty = Number(n.quantity ?? 0);
      if (qty <= 0) continue; // zero-qty ghost rows linger after a pick
      if (!n.location?.name) continue;
      out.push({
        binName: n.location.name,
        sku: n.sku ?? "",
        productName: (n.product?.name ?? "").trim(),
        quantity: qty,
        itemUpdatedAt: n.updated_at ?? null,
      });
    }
    after = conn?.pageInfo?.hasNextPage ? (conn.pageInfo.endCursor ?? null) : null;
    pages += 1;
  } while (after && pages < MAX_PAGES);
  return out;
}

/**
 * Honest "in bin since" per SKU for one bin.
 *
 * Walks the bin's movement log and, for each SKU, takes the LAST event where the
 * bin went from empty to holding stock (`previous_on_hand === 0 && change > 0`).
 * That's when the units sitting there right now actually arrived — so a partial
 * pick doesn't reset it, and reusing an emptied bin does.
 *
 * Returns sku -> ISO date. SKUs with no landing event in the window are omitted.
 */
export async function landedDatesForBin(
  warehouseId: string,
  binName: string,
  sinceISO: string,
): Promise<Record<string, string>> {
  const events: { sku: string; prev: number; change: number; at: string }[] = [];
  let after: string | null = null;
  let pages = 0;
  do {
    const afterArg: string = after ? `, after: "${after}"` : "";
    const query = `
      query {
        inventory_changes(warehouse_id: "${q1(warehouseId)}", location_name: "${q1(binName)}", date_from: "${q1(sinceISO)}") {
          data(first: ${PAGE}${afterArg}) {
            pageInfo { hasNextPage endCursor }
            edges { node { sku previous_on_hand change_in_on_hand created_at } }
          }
        }
      }
    `;
    const { data } = await shipheroGraphql<{
      inventory_changes?: {
        data?: {
          edges?: Edge<{ sku?: string; previous_on_hand?: number; change_in_on_hand?: number; created_at?: string }>[];
          pageInfo?: { hasNextPage?: boolean; endCursor?: string };
        };
      };
    }>(query);
    const conn = data.inventory_changes?.data;
    for (const n of nodesOf(conn)) {
      if (!n.sku || !n.created_at) continue;
      events.push({
        sku: n.sku,
        prev: Number(n.previous_on_hand ?? 0),
        change: Number(n.change_in_on_hand ?? 0),
        at: n.created_at,
      });
    }
    after = conn?.pageInfo?.hasNextPage ? (conn.pageInfo.endCursor ?? null) : null;
    pages += 1;
  } while (after && pages < MAX_PAGES);

  // Latest 0 -> positive transition wins.
  const landed: Record<string, string> = {};
  for (const e of events) {
    if (e.prev === 0 && e.change > 0) {
      if (!landed[e.sku] || e.at > landed[e.sku]) landed[e.sku] = e.at;
    }
  }
  return landed;
}

/** Where a SKU normally lives — its pick face under `destPrefix` (+ qty there). */
export async function fetchDestinationFace(
  warehouseId: string,
  sku: string,
  destPrefix: string,
): Promise<{ face: string; qty: number } | null> {
  const query = `
    query {
      item_locations(warehouse_id: "${q1(warehouseId)}", sku: "${q1(sku)}", location_name_prefix: "${q1(destPrefix)}") {
        data(first: 20) { edges { node { quantity location { name } } } }
      }
    }
  `;
  const { data } = await shipheroGraphql<{
    item_locations?: { data?: { edges?: Edge<{ quantity?: number; location?: { name?: string } | null }>[] } };
  }>(query);
  const rows = nodesOf(data.item_locations?.data).filter((n) => n.location?.name);
  if (rows.length === 0) return null;
  // Prefer the face that actually holds stock; else the first known face.
  const withStock = rows.filter((r) => Number(r.quantity ?? 0) > 0);
  const pick = (withStock[0] ?? rows[0])!;
  return { face: pick.location!.name!, qty: Number(pick.quantity ?? 0) };
}

/** The account's warehouse id (base64 global id). */
export async function fetchWarehouseId(): Promise<string | null> {
  const { data } = await shipheroGraphql<{
    account?: { data?: { warehouses?: { id?: string; address?: { name?: string } | null }[] } };
  }>(`query { account { data { warehouses { id address { name } } } } }`);
  const whs = data.account?.data?.warehouses ?? [];
  return whs[0]?.id ?? null;
}
