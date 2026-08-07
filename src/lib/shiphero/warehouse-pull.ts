// Pull one day of warehouse activity from ShipHero (inventory_changes +
// shipments), categorise every event, and roll it up. Called once per day by the
// cache layer; the result is stored and served locally after that.

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
const fromBinOf = (r: string) => r.match(/from bin\s+(\S+)/i)?.[1] ?? null;
const toBinOf = (r: string) =>
  r.match(/to bin\s+(\S+)/i)?.[1] ?? r.match(/added to the location\s+(\S+)/i)?.[1] ?? null;

/** Categorise a single change into an activity type. */
function classify(reason: string, chg: number, fromBin: string | null, toBin: string | null): EventType {
  const r = reason.toLowerCase();
  if (/received from purchase/.test(r)) return "received";
  if (/\border\b|shipment|shipped/.test(r)) return "pick";
  if (/cycle/.test(r)) return "adjust";
  const fa = area(fromBin);
  const ta = area(toBin);
  if (fa === "RECEIVING") return "putaway";
  if (fa === "RETURNS" && ta === "RETURN BIN") return "return-slotted";
  if (fa === "BULK" && ta === "PICK FACE") return "replenish";
  if (ta === "BULK") return "consolidation";
  if (fromBin || toBin) return "move";
  return "adjust";
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
  interface Raw { sku: string; chg: number; reason: string; user: string; loc: string; at: string }
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

  const userMap = await resolveUsers([...new Set(raw.map((r) => r.user).filter(Boolean))]);
  const uname = (u: string) => userMap[u] || (u ? `user#${u}` : "system");

  // --- shipments (outbound) ---
  let shippedOrders = 0;
  let shippedUnits = 0;
  const svc = new Map<string, { units: number; count: number }>();
  {
    let after2: string | null = null;
    let p2 = 0;
    do {
      const a2: string = after2 ? `, after: "${after2}"` : "";
      const query = `query { shipments(date_from: "${q1(from)}", date_to: "${q1(to)}", voided: false) {
        data(first: 40${a2}) { pageInfo { hasNextPage endCursor }
          edges { node { order { shipping_lines { method carrier title } } line_items(first: 50) { edges { node { quantity } } } } } } } }`;
      const { data } = await shipheroGraphql<{
        shipments?: { data?: { edges?: Array<{ node?: { order?: { shipping_lines?: { method?: string; carrier?: string; title?: string } | null } | null; line_items?: { edges?: Array<{ node?: { quantity?: number } }> } } }>; pageInfo?: { hasNextPage?: boolean; endCursor?: string } } };
      }>(query);
      const conn = data.shipments?.data;
      for (const e of conn?.edges ?? []) {
        const n = e.node;
        if (!n) continue;
        shippedOrders += 1;
        const u = (n.line_items?.edges ?? []).reduce((a, x) => a + Number(x.node?.quantity || 0), 0);
        shippedUnits += u;
        const sl = n.order?.shipping_lines;
        const s = serviceLabel(sl?.method, sl?.carrier, sl?.title);
        const cur = svc.get(s) ?? { units: 0, count: 0 };
        cur.count += 1;
        cur.units += u;
        svc.set(s, cur);
      }
      after2 = conn?.pageInfo?.hasNextPage ? (conn.pageInfo.endCursor ?? null) : null;
      p2 += 1;
    } while (after2 && p2 < MAX_PAGES);
  }

  // --- build events (one per move: +chg for transfers; received +chg; pick -chg) ---
  const events: WarehouseEvent[] = [];
  const byTypeUnits = new Map<EventType, { units: number; count: number }>();
  const flowMap = new Map<string, number>();
  const person = new Map<string, PersonRow>();
  const receivedPOs = new Map<string, number>();
  let receivedUnits = 0, putAwayUnits = 0, movedUnits = 0, moveCount = 0, returnsUnits = 0;

  for (const r of raw) {
    const fromBin = fromBinOf(r.reason);
    const toBin = toBinOf(r.reason);
    const type = classify(r.reason, r.chg, fromBin, toBin);

    // keep one canonical event per action (avoid double-counting 2-sided transfers)
    const keep =
      (type === "received" && r.chg > 0) ||
      (type === "pick" && r.chg < 0) ||
      (type !== "received" && type !== "pick" && r.chg > 0);
    if (!keep) continue;

    events.push({ at: r.at, user: uname(r.user), sku: r.sku, qty: r.chg, fromBin, toBin, reason: r.reason, type });

    const units = Math.abs(r.chg);
    const bt = byTypeUnits.get(type) ?? { units: 0, count: 0 };
    bt.units += units; bt.count += 1; byTypeUnits.set(type, bt);

    if (type === "received") { receivedUnits += units; const po = r.reason.match(/purchase order\s+(\S+)/i)?.[1] ?? "PO"; receivedPOs.set(po, (receivedPOs.get(po) ?? 0) + units); }
    else if (type === "putaway") putAwayUnits += units;
    else if (type === "return-slotted") returnsUnits += units;
    else if (type !== "pick") { movedUnits += units; moveCount += 1; }

    if (type !== "received" && type !== "pick" && (fromBin || toBin)) {
      const key = `${area(fromBin)}→${area(toBin)}`;
      flowMap.set(key, (flowMap.get(key) ?? 0) + units);
    }

    // per-person
    const name = uname(r.user);
    const p = person.get(name) ?? { name, initials: initialsOf(name), total: 0, received: 0, putAway: 0, moved: 0, picked: 0 };
    p.total += 1;
    if (type === "received") p.received += 1;
    else if (type === "putaway") p.putAway += 1;
    else if (type === "pick") p.picked += 1;
    else p.moved += 1;
    person.set(name, p);
  }

  const byType: Counted[] = [...byTypeUnits.entries()]
    .map(([t, v]) => ({ key: TYPE_META[t].label, units: v.units, count: v.count }))
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
      receivedPOs: [...receivedPOs.entries()].map(([po, units]) => ({ po, vendor: "", units })),
      putAwayUnits,
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
  if (to === "BULK") return "into storage";
  if (from === "BULK" && to === "PICK FACE") return "replenish";
  if (from === "RETURNS") return "returns";
  return "move";
}
