// Live scan for the Operations dashboard — deliberately lightweight.
//
// ShipHero exposes server-side order filters (`ready_to_ship`, `has_backorder`)
// and we only read each order's `fulfillment_status` — NO line items. So instead
// of pulling ~40 line-items per order (thousands of nodes), each pass fetches one
// scalar per order at 100/page. A full refresh is a few tiny queries that barely
// touch the credit pool, and it uses ShipHero's own ready flag (matches the Hero
// Board) so it's always accurate — no cache/delta needed.

import { shipheroGraphql } from "./client";
import { todayUkYmd, ukDayStartUtcNaive } from "@/lib/uk-time";
import { serviceLabel, laneLabel, type LaneCount, type OpsStats } from "@/lib/ops-types";

const q1 = (s: string) => String(s ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
const OPEN = `fulfillment_status_not_in: ["fulfilled","canceled","cancelled"]`;
const MAX_PAGES = 400;

interface LaneScan {
  total: number;
  byLane: Map<string, number>;
}

/** Count open orders matching `filterArgs`, grouped by lane. Reads only fulfillment_status. */
async function scanLanes(filterArgs: string): Promise<LaneScan> {
  let total = 0;
  const byLane = new Map<string, number>();
  let after: string | null = null;
  let pages = 0;
  do {
    const afterArg: string = after ? `, after: "${after}"` : "";
    const query = `query { orders(${filterArgs}) {
      data(first: 100${afterArg}) { pageInfo { hasNextPage endCursor }
        edges { node { fulfillment_status } } } } }`;
    const { data } = await shipheroGraphql<{
      orders?: { data?: { edges?: Array<{ node?: { fulfillment_status?: string | null } }>; pageInfo?: { hasNextPage?: boolean; endCursor?: string } } };
    }>(query);
    const conn = data.orders?.data;
    for (const e of conn?.edges ?? []) {
      total += 1;
      const lane = e.node?.fulfillment_status || "(none)";
      byLane.set(lane, (byLane.get(lane) ?? 0) + 1);
    }
    after = conn?.pageInfo?.hasNextPage ? (conn.pageInfo.endCursor ?? null) : null;
    pages += 1;
  } while (after && pages < MAX_PAGES);
  return { total, byLane };
}

// "Today" is a London day; ShipHero filters take naive UTC.
const todayStartISO = (): string => ukDayStartUtcNaive(todayUkYmd());

// Persisted between syncs (inside the ops snapshot) so shipped-today is
// incremental: we only pull shipments newer than the cursor (minus a 15-min
// overlap; the seen-set dedupes the overlap). Resets automatically at midnight.
export interface ShipScanState {
  date: string; // YYYY-MM-DD the accumulators belong to
  cursor: string | null; // max created_date seen
  seen: string[]; // shipment ids counted today
  orders: number;
  units: number;
  byService: Record<string, { count: number; units: number }>;
  byLane: Record<string, { count: number; units: number }>;
}

// Most orders are 1–3 lines, and ShipHero prices a query by what you ASK for
// (40 shipments × first:N nested), so keep the nested ask tiny…
const NESTED_LINES = 5;
// …and when a shipment actually hits the cap (a big multi), fetch its full
// lines individually — rare, cheap, and the unit count stays exact.
async function fullLineQuantities(shipmentId: string): Promise<number[]> {
  const { data } = await shipheroGraphql<{
    shipment?: { data?: { line_items?: { edges?: Array<{ node?: { quantity?: number } }> } } };
  }>(`query { shipment(id: "${q1(shipmentId)}") { data { line_items(first: 100) { edges { node { quantity } } } } } }`);
  return (data.shipment?.data?.line_items?.edges ?? []).map((e) => Number(e.node?.quantity || 0));
}

async function scanShippedToday(prev?: ShipScanState): Promise<ShipScanState> {
  const today = todayUkYmd();
  const state: ShipScanState =
    prev && prev.date === today
      ? { ...prev, seen: [...prev.seen], byService: { ...prev.byService }, byLane: { ...prev.byLane } }
      : { date: today, cursor: null, seen: [], orders: 0, units: 0, byService: {}, byLane: {} };
  const seen = new Set(state.seen);
  const from = state.cursor
    ? new Date(new Date(`${state.cursor}Z`).getTime() - 15 * 60_000).toISOString().slice(0, 19)
    : todayStartISO();

  let after: string | null = null;
  let pages = 0;
  do {
    const afterArg: string = after ? `, after: "${after}"` : "";
    const query = `query { shipments(date_from: "${q1(from)}", voided: false) {
      data(first: 40${afterArg}) { pageInfo { hasNextPage endCursor }
        edges { node { id legacy_id created_date
          order { shipping_lines { method carrier title } }
          line_items(first: ${NESTED_LINES}) { edges { node { quantity } } } } } } } }`;
    const { data } = await shipheroGraphql<{
      shipments?: {
        data?: {
          edges?: Array<{
            node?: {
              id?: string; legacy_id?: number; created_date?: string | null;
              order?: { shipping_lines?: { method?: string | null; carrier?: string | null; title?: string | null } | null } | null;
              line_items?: { edges?: Array<{ node?: { quantity?: number } }> };
            };
          }>;
          pageInfo?: { hasNextPage?: boolean; endCursor?: string };
        };
      };
    }>(query);
    const conn = data.shipments?.data;
    for (const e of conn?.edges ?? []) {
      const n = e.node;
      if (!n) continue;
      const key = String(n.legacy_id ?? n.id ?? "");
      if (!key || seen.has(key)) continue;
      seen.add(key);
      if (n.created_date && (!state.cursor || n.created_date > state.cursor)) state.cursor = n.created_date;
      let qtys = (n.line_items?.edges ?? []).map((x) => Number(x.node?.quantity || 0));
      if (qtys.length === NESTED_LINES && n.id) {
        // Cap hit — this might be a big multi. Pull its full lines so units are exact.
        const all = await fullLineQuantities(n.id);
        if (all.length >= qtys.length) qtys = all;
      }
      const units = qtys.reduce((a, q) => a + q, 0);
      state.orders += 1;
      state.units += units;
      const sl = n.order?.shipping_lines;
      const svc = serviceLabel(sl?.method, sl?.carrier, sl?.title);
      const svcCur = (state.byService[svc] ??= { count: 0, units: 0 });
      svcCur.count += 1;
      svcCur.units += units;
      const lane = laneLabel(sl?.method, sl?.carrier, sl?.title, qtys.length);
      const laneCur = (state.byLane[lane] ??= { count: 0, units: 0 });
      laneCur.count += 1;
      laneCur.units += units;
    }
    after = conn?.pageInfo?.hasNextPage ? (conn.pageInfo.endCursor ?? null) : null;
    pages += 1;
  } while (after && pages < MAX_PAGES);
  state.seen = [...seen];
  return state;
}

const sortLanes = (m: Map<string, number>): LaneCount[] =>
  [...m.entries()].map(([lane, count]) => ({ lane, count })).sort((a, b) => b.count - a.count);

/** Compute the full dashboard snapshot live from ShipHero. Pass the previous
 *  snapshot's shipScan so shipped-today only pulls what's new since last sync. */
export async function computeOpsStats(prevShip?: ShipScanState): Promise<Omit<OpsStats, "syncedAt">> {
  const [open, ready, shipped] = await Promise.all([
    scanLanes(OPEN),
    scanLanes(`ready_to_ship: true, ${OPEN}`),
    scanShippedToday(prevShip),
  ]);

  // Blocked = open minus ready, per lane (ready is a subset of open).
  const waitingByLane = new Map<string, number>();
  for (const [lane, openCount] of open.byLane) {
    const blocked = Math.max(0, openCount - (ready.byLane.get(lane) ?? 0));
    if (blocked > 0) waitingByLane.set(lane, blocked);
  }

  return {
    totalOpen: open.total,
    readyTotal: ready.total,
    readyByLane: sortLanes(ready.byLane),
    waitingTotal: Math.max(0, open.total - ready.total),
    waitingByLane: sortLanes(waitingByLane),
    shippedOrders: shipped.orders,
    shippedUnits: shipped.units,
    shippedByService: Object.entries(shipped.byService)
      .map(([lane, v]) => ({ lane, count: v.count, units: v.units }))
      .sort((a, b) => b.count - a.count),
    shippedByLane: Object.entries(shipped.byLane)
      .map(([lane, v]) => ({ lane, count: v.count, units: v.units }))
      .sort((a, b) => b.count - a.count),
    scannedOrders: open.total,
    shipScan: shipped,
  };
}
