// Pull one day of warehouse activity from ShipHero (inventory_changes +
// shipments), categorise it BY PURPOSE, and roll it up. Called once per day by
// the cache layer; the result is stored and served locally after that.
//
// How categorisation works:
//  · ShipHero logs each transfer as TWO rows (−qty leaving the source bin, +qty
//    arriving at the destination). We PAIR them by (sku, |qty|, timestamp) and
//    read the bin off each row's `location` field — so we get the real from → to
//    every time, whatever the reason wording. Then from-area → to-area names the
//    purpose (putaway / replenishment / consolidation / …).
//  · "Order … picked into tote" = a PICK (into a tote, pending pack) — not a
//    ship. Actual dispatches come from the `shipments` query (which also carries
//    the packer's user, for the "who shipped" column).

import { shipheroGraphql } from "./client";
import { getWarehouseId } from "./warehouse";
import { serviceLabel } from "@/lib/ops-types";
import {
  area,
  initialsOf,
  TYPE_META,
  type Counted,
  type EventType,
  type Flow,
  type PersonRow,
  type WarehouseDay,
  type WarehouseEvent,
} from "@/lib/warehouse-types";

const q1 = (s: string) => String(s ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
const MAX_PAGES = 300;
const stripTags = (s: string) => (s || "").replace(/<[^>]+>/g, "").trim();

interface Raw { sku: string; chg: number; reason: string; user: string; loc: string; at: string }

/** from-area → to-area → purpose. STORE and BULK are both reserve storage. */
function moveType(fa: string, ta: string): EventType {
  if (fa === "RECEIVING") return "putaway";
  if (fa === "RETURNS" && ta === "RETURN BIN") return "return-slotted";
  if (ta === "RETURN BIN") return "return-slotted";
  if (fa === "STORAGE" && ta === "PICK FACE") return "replenish";
  if (fa === "QC" && ta === "PICK FACE") return "qc-release";
  if (ta === "STORAGE") return "consolidation";
  if (ta === "QC") return "to-qc";
  if (fa === "PICK FACE" && ta === "PICK FACE") return "pick-reorg";
  return "move";
}

async function resolveUsers(ids: string[]): Promise<Record<string, string>> {
  const map: Record<string, string> = {};
  for (const uid of ids) {
    try {
      const { data } = await shipheroGraphql<{ user?: { data?: { first_name?: string; last_name?: string } } }>(
        `query { user(id: "${q1(uid)}") { data { first_name last_name } } }`,
      );
      const u = data.user?.data;
      if (u) map[uid] = `${u.first_name ?? ""} ${u.last_name ?? ""}`.trim() || uid;
    } catch {
      /* leave unresolved */
    }
  }
  return map;
}

export async function pullWarehouseDay(date: string): Promise<WarehouseDay> {
  const warehouseId = await getWarehouseId();
  const from = `${date}T00:00:00`;
  const to = `${date}T23:59:59`;

  // --- inventory changes ---
  const raw: Raw[] = [];
  let after: string | null = null;
  let pages = 0;
  do {
    const afterArg: string = after ? `, after: "${after}"` : "";
    const query = `query { inventory_changes(warehouse_id: "${q1(warehouseId)}", date_from: "${q1(from)}", date_to: "${q1(to)}") {
      data(first: 100${afterArg}) { pageInfo { hasNextPage endCursor }
        edges { node { sku change_in_on_hand reason user_id created_at location { name } } } } } }`;
    const { data } = await shipheroGraphql<{
      inventory_changes?: { data?: { edges?: Array<{ node?: { sku?: string; change_in_on_hand?: number; reason?: string; user_id?: string; created_at?: string; location?: { name?: string } | null } }>; pageInfo?: { hasNextPage?: boolean; endCursor?: string } } };
    }>(query);
    const conn = data.inventory_changes?.data;
    for (const e of conn?.edges ?? []) {
      const n = e.node;
      if (!n) continue;
      raw.push({ sku: n.sku ?? "", chg: Number(n.change_in_on_hand ?? 0), reason: stripTags(n.reason ?? ""), user: n.user_id ?? "", loc: n.location?.name ?? "", at: n.created_at ?? "" });
    }
    after = conn?.pageInfo?.hasNextPage ? (conn.pageInfo.endCursor ?? null) : null;
    pages += 1;
  } while (after && pages < MAX_PAGES);

  // --- shipments (real dispatches + who packed) ---
  let shippedOrders = 0;
  let shippedUnits = 0;
  const svc = new Map<string, { units: number; count: number }>();
  const shipByUser = new Map<string, number>();
  {
    let a: string | null = null;
    let p = 0;
    do {
      const aa: string = a ? `, after: "${a}"` : "";
      const query = `query { shipments(date_from: "${q1(from)}", date_to: "${q1(to)}", voided: false) {
        data(first: 40${aa}) { pageInfo { hasNextPage endCursor }
          edges { node { user_id order { shipping_lines { method carrier title } } line_items(first: 50) { edges { node { quantity } } } } } } } }`;
      const { data } = await shipheroGraphql<{
        shipments?: { data?: { edges?: Array<{ node?: { user_id?: string; order?: { shipping_lines?: { method?: string; carrier?: string; title?: string } | null } | null; line_items?: { edges?: Array<{ node?: { quantity?: number } }> } } }>; pageInfo?: { hasNextPage?: boolean; endCursor?: string } } };
      }>(query);
      const conn = data.shipments?.data;
      for (const e of conn?.edges ?? []) {
        const n = e.node;
        if (!n) continue;
        shippedOrders += 1;
        const u = (n.line_items?.edges ?? []).reduce((x, y) => x + Number(y.node?.quantity || 0), 0);
        shippedUnits += u;
        const s = serviceLabel(n.order?.shipping_lines?.method, n.order?.shipping_lines?.carrier, n.order?.shipping_lines?.title);
        const cur = svc.get(s) ?? { units: 0, count: 0 };
        cur.count += 1; cur.units += u; svc.set(s, cur);
        if (n.user_id) shipByUser.set(n.user_id, (shipByUser.get(n.user_id) ?? 0) + 1);
      }
      a = conn?.pageInfo?.hasNextPage ? (conn.pageInfo.endCursor ?? null) : null;
      p += 1;
    } while (a && p < MAX_PAGES);
  }

  const userMap = await resolveUsers([...new Set([...raw.map((r) => r.user), ...shipByUser.keys()].filter(Boolean))]);
  const uname = (u: string) => userMap[u] || (u ? `user#${u}` : "system");

  // --- classify raw events ---
  const events: WarehouseEvent[] = [];
  const person = new Map<string, PersonRow>();
  const pget = (u: string) => {
    const name = uname(u);
    let p = person.get(name);
    if (!p) { p = { name, initials: initialsOf(name), total: 0, received: 0, putAway: 0, moved: 0, picked: 0, shipped: 0 }; person.set(name, p); }
    return p;
  };

  const transfers: Raw[] = [];
  for (const r of raw) {
    const rl = r.reason.toLowerCase();
    if (/received from purchase/.test(rl) && r.chg > 0) {
      const po = r.reason.match(/purchase order\s+(\S+)/i)?.[1] ?? "PO";
      events.push({ at: r.at, user: uname(r.user), sku: r.sku, qty: r.chg, fromBin: "PO", toBin: r.loc || null, reason: r.reason, type: "received", meta: po });
      const p = pget(r.user); p.total++; p.received++;
    } else if (/picked into tote/.test(rl)) {
      const tote = r.reason.match(/into tote\s+(\S+)/i)?.[1] ?? "Tote";
      events.push({ at: r.at, user: uname(r.user), sku: r.sku, qty: r.chg, fromBin: r.loc || null, toBin: tote, reason: r.reason, type: "picked" });
      const p = pget(r.user); p.total++; p.picked++;
    } else if (/\bshipped\b|reshipped/.test(rl) && !/from bin|to bin/.test(rl)) {
      events.push({ at: r.at, user: uname(r.user), sku: r.sku, qty: r.chg, fromBin: r.loc || null, toBin: "SHIPPED", reason: r.reason, type: "shipped" });
      // shipped-by-person comes from the shipments query, not these rows
    } else {
      transfers.push(r);
    }
  }

  // --- pair transfers by (sku, |qty|, timestamp) → real from → to ---
  const groups = new Map<string, Raw[]>();
  for (const t of transfers) {
    const k = `${t.sku}|${Math.abs(t.chg)}|${t.at}`;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(t);
  }
  for (const g of groups.values()) {
    const pos = g.filter((e) => e.chg > 0);
    const neg = g.filter((e) => e.chg < 0);
    const n = Math.max(pos.length, neg.length);
    for (let i = 0; i < n; i++) {
      const d = pos[i];
      const s = neg[i];
      const both = d ?? s;
      const fromBin = s?.loc || d?.reason.match(/from bin\s+(\S+)/i)?.[1] || null;
      const toBin = d?.loc || s?.reason.match(/to bin\s+(\S+)/i)?.[1] || s?.reason.match(/added to the location\s+(\S+)/i)?.[1] || null;
      const type = moveType(area(fromBin), area(toBin));
      events.push({ at: both.at, user: uname(both.user), sku: both.sku, qty: Math.abs(both.chg), fromBin, toBin, reason: both.reason, type });
      const p = pget(both.user); p.total++;
      if (type === "putaway") p.putAway++; else p.moved++;
    }
  }

  // add shipped-by-person from shipments
  for (const [uid, count] of shipByUser) { const p = pget(uid); p.total += count; p.shipped += count; }

  // --- aggregates ---
  const unitsByType = new Map<EventType, number>();
  const flowMap = new Map<string, number>();
  let receivedUnits = 0, putAwayUnits = 0, pickedItems = 0, movedUnits = 0, moveCount = 0, returnsUnits = 0;
  const receivedPOs = new Map<string, number>();

  for (const e of events) {
    const u = Math.abs(e.qty);
    unitsByType.set(e.type, (unitsByType.get(e.type) ?? 0) + u);
    if (e.type === "received") { receivedUnits += u; if (e.meta) receivedPOs.set(e.meta, (receivedPOs.get(e.meta) ?? 0) + u); }
    else if (e.type === "putaway") putAwayUnits += u;
    else if (e.type === "picked") pickedItems += 1;
    else if (e.type === "return-slotted") returnsUnits += u;
    else if (e.type !== "shipped") { movedUnits += u; moveCount += 1; }
    if (["putaway", "replenish", "consolidation", "to-qc", "qc-release", "pick-reorg", "move", "return-slotted"].includes(e.type) && (e.fromBin || e.toBin)) {
      const key = `${area(e.fromBin)}→${area(e.toBin)}`;
      flowMap.set(key, (flowMap.get(key) ?? 0) + u);
    }
  }

  const byType: Counted[] = [...unitsByType.entries()]
    .map(([t, units]) => ({ key: TYPE_META[t].label, units }))
    .sort((a, b) => b.units - a.units);
  const flows: Flow[] = [...flowMap.entries()]
    .map(([k, units]) => { const [f, t] = k.split("→"); return { from: f, to: t, units, tag: flowTag(f, t) }; })
    .sort((a, b) => b.units - a.units);

  return {
    summary: {
      date,
      generatedAt: new Date().toISOString(),
      eventCount: raw.length,
      receivedUnits,
      receivedPOs: [...receivedPOs.entries()].map(([po, units]) => ({ po, vendor: "", units })).sort((a, b) => b.units - a.units),
      putAwayUnits,
      pickedItems,
      shippedOrders,
      shippedUnits,
      shippedByService: [...svc.entries()].map(([key, v]) => ({ key, units: v.units, count: v.count })).sort((a, b) => (b.count ?? 0) - (a.count ?? 0)),
      movedUnits,
      moveCount,
      returnsUnits,
      staffActive: [...person.keys()].filter((n) => n !== "system").length,
      byType,
      flows,
      byPerson: [...person.values()].sort((a, b) => b.total - a.total),
    },
    events: events.sort((a, b) => (b.at || "").localeCompare(a.at || "")),
  };
}

function flowTag(from: string, to: string): string {
  if (from === "RECEIVING") return "putaway";
  if (from === "STORAGE" && to === "PICK FACE") return "replenish";
  if (to === "STORAGE") return "to storage";
  if (from === "RETURNS") return "returns";
  if (to === "QC") return "to QC";
  if (from === "QC") return "QC out";
  return "move";
}
