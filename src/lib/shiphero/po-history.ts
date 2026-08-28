// PO history from ShipHero. The public API has no PurchaseOrder history object,
// but every receive / correction lands in inventory_changes with the user, SKU,
// qty, bin and a reason that links the PO row id — so "who booked in what, when"
// is rebuilt from those rows (one query per SKU that has been received).
// Read-only.

import { shipheroGraphql } from "./client";

const q1 = (s: string) => String(s ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');

export interface PoHistoryEvent {
  at: string;
  userId: string | null;
  user: string;
  sku: string;
  qty: number; // signed change in on-hand
  bin: string;
  kind: "received" | "correction" | "other";
  reason: string; // HTML stripped, "- Product App" trimmed
}

export interface PoHistoryData {
  poId: string;
  legacyId: string;
  poNumber: string;
  createdAt: string | null;
  poDate: string | null;
  arrivedAt: string | null;
  dateClosed: string | null;
  skusScanned: number;
  events: PoHistoryEvent[];
  fetchedAt: string;
}

const userCache = new Map<string, string>();
async function userName(id: string): Promise<string> {
  const hit = userCache.get(id);
  if (hit) return hit;
  try {
    const { data } = await shipheroGraphql<{ user?: { data?: { first_name?: string; last_name?: string; email?: string } } }>(
      `query { user(id: "${q1(id)}") { data { first_name last_name email } } }`,
    );
    const u = data.user?.data;
    const name = u ? `${u.first_name ?? ""} ${u.last_name ?? ""}`.trim() || u.email || id : id;
    userCache.set(id, name);
    return name;
  } catch {
    return id;
  }
}

function cleanReason(r: string): string {
  return r
    .replace(/<[^>]+>/g, "")
    .replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&").replace(/&quot;/g, '"')
    .replace(/\s*-\s*Product App\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

interface RawChange { created_at?: string; user_id?: string | null; change_in_on_hand?: number; reason?: string; location?: { name?: string } | null }

interface ChangesPage {
  inventory_changes?: { data?: { edges?: Array<{ node?: RawChange }>; pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } } };
}

async function changesForSku(sku: string, dateFrom: string): Promise<RawChange[]> {
  const out: RawChange[] = [];
  let after: string | null = null;
  for (let page = 0; page < 10; page++) {
    const afterArg: string = after ? `, after: "${q1(after)}"` : "";
    const query = `query { inventory_changes(sku: "${q1(sku)}", date_from: "${q1(dateFrom)}") { data(first: 100${afterArg}) {
        edges { node { created_at user_id change_in_on_hand reason location { name } } } pageInfo { hasNextPage endCursor } } } }`;
    const res = await shipheroGraphql<ChangesPage>(query);
    const conn = res.data.inventory_changes?.data;
    for (const e of conn?.edges ?? []) if (e.node) out.push(e.node);
    if (!conn?.pageInfo?.hasNextPage || !conn.pageInfo.endCursor) break;
    after = conn.pageInfo.endCursor;
  }
  return out;
}

/** Rebuild a PO's receive/correction history. `extraSkus` = SKUs the app has
 *  touched (un-receive log) that may now show 0 received. */
export async function pullPoHistory(poId: string, extraSkus: string[] = []): Promise<PoHistoryData> {
  const { data } = await shipheroGraphql<{
    purchase_order?: { data?: {
      id?: string; legacy_id?: number; po_number?: string; created_at?: string | null; po_date?: string | null; arrived_at?: string | null; date_closed?: string | null;
      line_items?: { edges?: Array<{ node?: { sku?: string; quantity_received?: number } }> };
    } };
  }>(`query { purchase_order(id: "${q1(poId)}") { data { id legacy_id po_number created_at po_date arrived_at date_closed
      line_items(first: 100) { edges { node { sku quantity_received } } } } } }`);
  const p = data.purchase_order?.data;
  if (!p) throw new Error("PO not found.");
  const legacyId = String(p.legacy_id ?? "");
  const poNumber = p.po_number ?? "";
  const lines = (p.line_items?.edges ?? []).map((e) => e.node).filter((n): n is NonNullable<typeof n> => Boolean(n?.sku));
  const skus = [...new Set([...lines.filter((l) => Number(l.quantity_received ?? 0) > 0).map((l) => l.sku!), ...extraSkus])];
  const created = (p.created_at ?? "").slice(0, 10);
  const dateFrom = created ? `${created}T00:00:00` : "2025-01-01T00:00:00";

  // Is this row about THIS PO? Receives link the row id; app corrections name the PO number.
  const link = `/details/${legacyId}`;
  const poRe = new RegExp(`\\b${poNumber.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
  const mine = (r: string) => (legacyId && r.includes(link)) || (/Product App/i.test(r) && poRe.test(r));

  const raw: Array<RawChange & { sku: string }> = [];
  const queue = [...skus];
  await Promise.all(Array.from({ length: 3 }, async () => {
    while (queue.length) {
      const sku = queue.shift()!;
      const rows = await changesForSku(sku, dateFrom);
      for (const r of rows) if (r.reason && mine(r.reason)) raw.push({ ...r, sku });
    }
  }));

  const ids = [...new Set(raw.map((r) => r.user_id).filter((x): x is string => Boolean(x)))];
  const names = new Map<string, string>();
  for (const id of ids) names.set(id, await userName(id));

  const events: PoHistoryEvent[] = raw
    .map((r) => {
      const reason = r.reason ?? "";
      const kind: PoHistoryEvent["kind"] = /received from purchase order/i.test(reason) ? "received" : /Product App/i.test(reason) ? "correction" : "other";
      return {
        at: r.created_at ?? "", userId: r.user_id ?? null, user: r.user_id ? names.get(r.user_id) ?? r.user_id : "ShipHero",
        sku: r.sku, qty: Number(r.change_in_on_hand ?? 0), bin: r.location?.name ?? "?", kind, reason: cleanReason(reason),
      };
    })
    .sort((a, b) => a.at.localeCompare(b.at));

  return {
    poId: p.id ?? poId, legacyId, poNumber, createdAt: p.created_at ?? null, poDate: p.po_date ?? null, arrivedAt: p.arrived_at ?? null, dateClosed: p.date_closed ?? null,
    skusScanned: skus.length, events, fetchedAt: new Date().toISOString(),
  };
}
