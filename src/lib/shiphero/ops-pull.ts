// Live scan for the Operations dashboard — deliberately lightweight.
//
// ShipHero exposes server-side order filters (`ready_to_ship`, `has_backorder`)
// and we only read each order's `fulfillment_status` — NO line items. So instead
// of pulling ~40 line-items per order (thousands of nodes), each pass fetches one
// scalar per order at 100/page. A full refresh is a few tiny queries that barely
// touch the credit pool, and it uses ShipHero's own ready flag (matches the Hero
// Board) so it's always accurate — no cache/delta needed.

import { shipheroGraphql } from "./client";
import { todayUkYmd, ukDayStartUtcNaive, ukHour } from "@/lib/uk-time";
import { serviceLabel, laneLabel, type AgeBucket, type BlockedProduct, type CountryRow, type LaneCount, type LaneRow, type OpsStats, type OrderLite } from "@/lib/ops-types";
import { CARRIERS, laneFamily } from "@/lib/ops-cutoffs";
import { getCachedLinesByPo, getCachedSummaries } from "@/lib/po-cache";
import { getSizeMap } from "@/lib/size-codes";
import { deriveSizeFromSku } from "@/lib/sizes";

const q1 = (s: string) => String(s ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
const OPEN = `fulfillment_status_not_in: ["fulfilled","canceled","cancelled"]`;
const MAX_PAGES = 400;

interface OpenOrder {
  id: string;
  legacyId: string;
  orderNumber: string;
  lane: string; // raw fulfillment_status ("Standard - Singles", "INFLUENCER"…)
  createdAt: string; // naive UTC
  country: string;
  vanKey: "dhl" | "rm"; // which collection this parcel leaves on (by shipping method)
  units: number; // from first 3 lines (enough to tell single vs multi)
  skus: string[];
  items: string; // human summary
}

/** One pass over every open order with just enough detail for the Order Well
 *  panels: lane, age, destination, first-3 lines. ~200 credits per 50 orders. */
async function scanOpenOrders(): Promise<OpenOrder[]> {
  const out: OpenOrder[] = [];
  let after: string | null = null;
  let pages = 0;
  do {
    const afterArg: string = after ? `, after: "${after}"` : "";
    const query = `query { orders(${OPEN}) { data(first: 50${afterArg}) { pageInfo { hasNextPage endCursor }
      edges { node { id legacy_id order_number fulfillment_status created_at
        shipping_lines { method carrier }
        shipping_address { country }
        line_items(first: 3) { edges { node { sku product_name quantity } } } } } } } }`;
    const { data } = await shipheroGraphql<{
      orders?: { data?: { edges?: Array<{ node?: {
        id?: string; legacy_id?: number; order_number?: string; fulfillment_status?: string | null; created_at?: string | null;
        shipping_lines?: { method?: string | null; carrier?: string | null } | null;
        shipping_address?: { country?: string | null } | null;
        line_items?: { edges?: Array<{ node?: { sku?: string; product_name?: string; quantity?: number } }> };
      } }>; pageInfo?: { hasNextPage?: boolean; endCursor?: string } } };
    }>(query);
    const conn = data.orders?.data;
    for (const e of conn?.edges ?? []) {
      const n = e.node;
      if (!n?.id) continue;
      const lines = (n.line_items?.edges ?? []).map((x) => x.node).filter((l): l is NonNullable<typeof l> => Boolean(l));
      out.push({
        id: n.id,
        legacyId: String(n.legacy_id ?? ""),
        orderNumber: n.order_number ?? "",
        lane: n.fulfillment_status || "(none)",
        createdAt: n.created_at ?? "",
        country: n.shipping_address?.country || "?",
        vanKey: /dhl/i.test(`${n.shipping_lines?.method ?? ""} ${n.shipping_lines?.carrier ?? ""}`) ? "dhl" : "rm",
        units: lines.reduce((a, l) => a + Number(l.quantity || 0), 0),
        skus: lines.map((l) => l.sku ?? "").filter(Boolean),
        items: lines.map((l) => `${l.product_name ?? l.sku ?? "?"} ×${l.quantity ?? 1}`).join(", "),
      });
    }
    after = conn?.pageInfo?.hasNextPage ? (conn.pageInfo.endCursor ?? null) : null;
    pages += 1;
  } while (after && pages < MAX_PAGES);
  return out;
}

/** Just the ids of ready-to-ship open orders (cheap; joined with the scan above). */
async function scanReadyIds(): Promise<Set<string>> {
  const ids = new Set<string>();
  let after: string | null = null;
  let pages = 0;
  do {
    const afterArg: string = after ? `, after: "${after}"` : "";
    const { data } = await shipheroGraphql<{
      orders?: { data?: { edges?: Array<{ node?: { id?: string } }>; pageInfo?: { hasNextPage?: boolean; endCursor?: string } } };
    }>(`query { orders(ready_to_ship: true, ${OPEN}) { data(first: 100${afterArg}) { pageInfo { hasNextPage endCursor } edges { node { id } } } } }`);
    const conn = data.orders?.data;
    for (const e of conn?.edges ?? []) if (e.node?.id) ids.add(e.node.id);
    after = conn?.pageInfo?.hasNextPage ? (conn.pageInfo.endCursor ?? null) : null;
    pages += 1;
  } while (after && pages < MAX_PAGES);
  return ids;
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
  byHour?: number[]; // London hours 0–23
  byCountry?: Record<string, number>;
  byHourCarrier?: Record<"dhl" | "rm", number[]>;
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
      : { date: today, cursor: null, seen: [], orders: 0, units: 0, byService: {}, byLane: {}, byHour: Array.from({ length: 24 }, () => 0), byCountry: {} };
  state.byHour = state.byHour ?? Array.from({ length: 24 }, () => 0);
  if (!state.byCountry || !state.byHourCarrier) {
    // Snapshot predates country/carrier-hour tracking — rescan the day once to backfill.
    state.cursor = null; state.seen = []; state.orders = 0; state.units = 0; state.byService = {}; state.byLane = {}; state.byHour = Array.from({ length: 24 }, () => 0); state.byCountry = {};
    state.byHourCarrier = { dhl: Array.from({ length: 24 }, () => 0), rm: Array.from({ length: 24 }, () => 0) };
  }
  state.byHourCarrier = state.byHourCarrier ?? { dhl: Array.from({ length: 24 }, () => 0), rm: Array.from({ length: 24 }, () => 0) };
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
          order { shipping_lines { method carrier title } shipping_address { country } }
          line_items(first: ${NESTED_LINES}) { edges { node { quantity } } } } } } } }`;
    const { data } = await shipheroGraphql<{
      shipments?: {
        data?: {
          edges?: Array<{
            node?: {
              id?: string; legacy_id?: number; created_date?: string | null;
              order?: { shipping_lines?: { method?: string | null; carrier?: string | null; title?: string | null } | null; shipping_address?: { country?: string | null } | null } | null;
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
      const sl0 = n.order?.shipping_lines;
      if (n.created_date) {
        state.byHour![ukHour(n.created_date)] += 1;
        // Which van does this parcel leave on? DHL carries its own; the rest go on the RM collection.
        const vanKey: "dhl" | "rm" = /dhl/i.test(`${sl0?.method ?? ""} ${sl0?.carrier ?? ""}`) ? "dhl" : "rm";
        state.byHourCarrier![vanKey][ukHour(n.created_date)] += 1;
      }
      const cc = n.order?.shipping_address?.country || "?";
      state.byCountry![cc] = (state.byCountry![cc] ?? 0) + 1;
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


/** Compute the full dashboard snapshot live from ShipHero. Pass the previous
 *  snapshot's shipScan so shipped-today only pulls what's new since last sync. */
export async function computeOpsStats(prevShip?: ShipScanState): Promise<Omit<OpsStats, "syncedAt">> {
  const [openOrders, readyIds, shipped, sizeMap] = await Promise.all([
    scanOpenOrders(),
    scanReadyIds(),
    scanShippedToday(prevShip),
    getSizeMap(),
  ]);
  const ready = openOrders.filter((o) => readyIds.has(o.id));
  const blocked = openOrders.filter((o) => !readyIds.has(o.id));
  const now = Date.now();
  const ageDaysOf = (o: OpenOrder) => (now - new Date(`${o.createdAt}Z`).getTime()) / 86_400_000;

  // legacy per-status lists (dashboard + old panels)
  const count = (rows: OpenOrder[]) => {
    const m = new Map<string, number>();
    for (const o of rows) m.set(o.lane, (m.get(o.lane) ?? 0) + 1);
    return m;
  };
  const openBy = count(openOrders), readyBy = count(ready);
  const waitingBy = new Map<string, number>();
  for (const [lane, openCount] of openBy) {
    const b = Math.max(0, openCount - (readyBy.get(lane) ?? 0));
    if (b > 0) waitingBy.set(lane, b);
  }

  // v2 lane families
  const today = todayUkYmd();
  const dayStart = ukDayStartUtcNaive(today);
  const cutoffNaive = (hm: string): string => {
    const d = new Date(`${dayStart}Z`);
    const [h, m] = hm.split(":").map(Number);
    d.setUTCMinutes(d.getUTCMinutes() + h * 60 + m);
    return d.toISOString().slice(0, 19);
  };
  const cutoffs: Record<string, string> = Object.fromEntries(CARRIERS.map((c) => [c.key, cutoffNaive(c.cutoff)]));
  const laneMap = new Map<string, LaneRow>();
  const rowFor = (family: string): LaneRow => {
    let r = laneMap.get(family);
    if (!r) { r = { family, ready: 0, singles: 0, multis: 0, dueToday: 0, blocked: 0, oldestReadyDays: null }; laneMap.set(family, r); }
    return r;
  };
  for (const o of ready) {
    const { family, kind } = laneFamily(o.lane);
    const r = rowFor(family);
    r.ready += 1;
    if (kind === "multi" || (kind === null && o.units > 1)) r.multis += 1; else r.singles += 1;
    if (o.createdAt && o.createdAt < cutoffs[o.vanKey]) r.dueToday += 1;
    const age = Math.round(ageDaysOf(o) * 10) / 10;
    if (r.oldestReadyDays === null || age > r.oldestReadyDays) r.oldestReadyDays = age;
  }
  for (const o of blocked) rowFor(laneFamily(o.lane).family).blocked += 1;
  const lanes = [...laneMap.values()].sort((a, b) => b.ready - a.ready);
  const dueByCarrier: Record<"dhl" | "rm", number> = { dhl: 0, rm: 0 };
  for (const o of ready) if (o.createdAt && o.createdAt < cutoffs[o.vanKey]) dueByCarrier[o.vanKey] += 1;

  // age buckets over ready orders (oldest first, capped for the click-through table)
  const liteOf = (o: OpenOrder): OrderLite => ({
    orderNumber: o.orderNumber, legacyId: o.legacyId,
    items: o.items || "—", lane: laneFamily(o.lane).family, ageDays: Math.round(ageDaysOf(o) * 10) / 10,
  });
  const defs: Array<[string, (d: number) => boolean]> = [
    ["< 1 day", (d) => d < 1], ["1–2 days", (d) => d >= 1 && d < 2], ["2–3 days", (d) => d >= 2 && d < 3], ["3+ days", (d) => d >= 3],
  ];
  const ageBuckets: AgeBucket[] = defs.map(([label, test]) => {
    const rows = ready.filter((o) => test(ageDaysOf(o))).sort((a, b) => ageDaysOf(b) - ageDaysOf(a));
    return { label, count: rows.length, orders: rows.slice(0, 40).map(liteOf) };
  });
  const oldest = ready.slice().sort((a, b) => ageDaysOf(b) - ageDaysOf(a))[0];

  // blocked, grouped by product (first line), joined to incoming POs
  const [{ pos }, linesByPo] = await Promise.all([getCachedSummaries(), getCachedLinesByPo()]);
  const incoming = pos.filter((p) => !/close|cancel|deliver/i.test(p.status));
  const poBySku = new Map<string, { po: string; date: string | null }>();
  for (const p of incoming) {
    for (const l of linesByPo[p.poNumber] ?? []) {
      const cur = poBySku.get(l.sku);
      const date = p.poDate?.slice(0, 10) ?? null;
      if (!cur || (date && (!cur.date || date < cur.date))) poBySku.set(l.sku, { po: p.poNumber, date });
    }
  }
  const prodMap = new Map<string, { orders: number; skus: Set<string> }>();
  for (const o of blocked) {
    const sku = o.skus[0];
    if (!sku) continue;
    const size = deriveSizeFromSku(sku, sizeMap);
    // ShipHero product names often end in "- <size>" and sometimes carry an
    // internal "Note …" suffix — strip both so the grouping label reads clean.
    const name = (o.items.split(",")[0] ?? sku)
      .replace(/\s*×\d+$/, "")
      .replace(/\s*Note\b.*$/i, "")
      .replace(/\s*[-–]\s*(XXS|XS|S|M|L|XL|XXL)\s*$/i, "")
      .trim();
    const key = size ? `${name} · ${size}` : name;
    const g = prodMap.get(key) ?? { orders: 0, skus: new Set<string>() };
    g.orders += 1; g.skus.add(sku); prodMap.set(key, g);
  }
  const blockedProducts: BlockedProduct[] = [...prodMap.entries()]
    .sort((a, b) => b[1].orders - a[1].orders).slice(0, 8)
    .map(([product, g]) => {
      const hit = [...g.skus].map((k) => poBySku.get(k)).find(Boolean);
      return { product, orders: g.orders, incomingPo: hit?.po ?? null, incomingDate: hit?.date ?? null, note: hit ? null : "no open PO covers this" };
    });

  // destination mix: open orders + shipped today, merged
  const geo = new Map<string, { open: number; shipped: number }>();
  const geoRow = (cc: string) => { let g = geo.get(cc); if (!g) { g = { open: 0, shipped: 0 }; geo.set(cc, g); } return g; };
  for (const o of openOrders) geoRow(o.country).open += 1;
  for (const [cc, n] of Object.entries(shipped.byCountry ?? {})) geoRow(cc).shipped += n;
  const countries: CountryRow[] = [...geo.entries()]
    .map(([country, g]) => ({ country, open: g.open, shipped: g.shipped }))
    .sort((a, b) => (b.open + (b.shipped ?? 0)) - (a.open + (a.shipped ?? 0)))
    .slice(0, 8);

  const asLanes = (m: Map<string, number>): LaneCount[] =>
    [...m.entries()].map(([lane, c]) => ({ lane, count: c })).sort((a, b) => b.count - a.count);

  return {
    totalOpen: openOrders.length,
    readyTotal: ready.length,
    readyByLane: asLanes(readyBy),
    waitingTotal: blocked.length,
    waitingByLane: asLanes(waitingBy),
    shippedOrders: shipped.orders,
    shippedUnits: shipped.units,
    shippedByService: Object.entries(shipped.byService)
      .map(([lane, v]) => ({ lane, count: v.count, units: v.units }))
      .sort((a, b) => b.count - a.count),
    shippedByLane: Object.entries(shipped.byLane)
      .map(([lane, v]) => ({ lane, count: v.count, units: v.units }))
      .sort((a, b) => b.count - a.count),
    scannedOrders: openOrders.length,
    shipScan: shipped,
    lanes,
    ageBuckets,
    blockedProducts,
    countries,
    shippedByHour: shipped.byHour ?? [],
    shippedByHourCarrier: shipped.byHourCarrier,
    dueByCarrier,
    oldestReady: oldest ? { orderNumber: oldest.orderNumber, ageDays: Math.round(ageDaysOf(oldest) * 10) / 10, lane: laneFamily(oldest.lane).family } : null,
  };
}
