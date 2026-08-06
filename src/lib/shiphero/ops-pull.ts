// Live scan for the Operations dashboard — deliberately lightweight.
//
// ShipHero exposes server-side order filters (`ready_to_ship`, `has_backorder`)
// and we only read each order's `fulfillment_status` — NO line items. So instead
// of pulling ~40 line-items per order (thousands of nodes), each pass fetches one
// scalar per order at 100/page. A full refresh is a few tiny queries that barely
// touch the credit pool, and it uses ShipHero's own ready flag (matches the Hero
// Board) so it's always accurate — no cache/delta needed.

import { shipheroGraphql } from "./client";
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

function todayStartISO(): string {
  const d = new Date();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mo}-${da}T00:00:00`;
}

async function scanShippedToday() {
  let shippedOrders = 0;
  let shippedUnits = 0;
  const byService = new Map<string, { count: number; units: number }>();
  const byLane = new Map<string, { count: number; units: number }>();
  const from = todayStartISO();
  let after: string | null = null;
  let pages = 0;
  do {
    const afterArg: string = after ? `, after: "${after}"` : "";
    const query = `query { shipments(date_from: "${q1(from)}", voided: false) {
      data(first: 40${afterArg}) { pageInfo { hasNextPage endCursor }
        edges { node {
          order { shipping_lines { method carrier title } }
          line_items(first: 50) { edges { node { quantity } } } } } } } }`;
    const { data } = await shipheroGraphql<{
      shipments?: {
        data?: {
          edges?: Array<{
            node?: {
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
      shippedOrders += 1;
      const lineCount = (n.line_items?.edges ?? []).length;
      const units = (n.line_items?.edges ?? []).reduce((a, x) => a + Number(x.node?.quantity || 0), 0);
      shippedUnits += units;
      const sl = n.order?.shipping_lines;
      const svc = serviceLabel(sl?.method, sl?.carrier, sl?.title);
      const svcCur = byService.get(svc) ?? { count: 0, units: 0 };
      svcCur.count += 1;
      svcCur.units += units;
      byService.set(svc, svcCur);
      const lane = laneLabel(sl?.method, sl?.carrier, sl?.title, lineCount);
      const laneCur = byLane.get(lane) ?? { count: 0, units: 0 };
      laneCur.count += 1;
      laneCur.units += units;
      byLane.set(lane, laneCur);
    }
    after = conn?.pageInfo?.hasNextPage ? (conn.pageInfo.endCursor ?? null) : null;
    pages += 1;
  } while (after && pages < MAX_PAGES);
  return { shippedOrders, shippedUnits, byService, byLane };
}

const sortLanes = (m: Map<string, number>): LaneCount[] =>
  [...m.entries()].map(([lane, count]) => ({ lane, count })).sort((a, b) => b.count - a.count);

/** Compute the full dashboard snapshot live from ShipHero. */
export async function computeOpsStats(): Promise<Omit<OpsStats, "syncedAt">> {
  const [open, ready, shipped] = await Promise.all([
    scanLanes(OPEN),
    scanLanes(`ready_to_ship: true, ${OPEN}`),
    scanShippedToday(),
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
    shippedOrders: shipped.shippedOrders,
    shippedUnits: shipped.shippedUnits,
    shippedByService: [...shipped.byService.entries()]
      .map(([lane, v]) => ({ lane, count: v.count, units: v.units }))
      .sort((a, b) => b.count - a.count),
    shippedByLane: [...shipped.byLane.entries()]
      .map(([lane, v]) => ({ lane, count: v.count, units: v.units }))
      .sort((a, b) => b.count - a.count),
    scannedOrders: open.total,
  };
}
