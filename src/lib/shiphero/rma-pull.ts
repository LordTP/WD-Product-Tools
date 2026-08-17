// Pull returns (Swap RMAs) from ShipHero for the Returns dashboard — richer
// sibling of returns-pull.ts (which feeds the old Swap QC-CSV export and stays
// untouched). v1 vs v2 detection: Swap v2 RMAs carry display_issue_refund=true
// and use the order number as partner_id; v1 (pre 2026-08-03 12:30 cutover) are
// legacy, never processed in ShipHero — pulled once and frozen.

import { shipheroGraphql } from "./client";
import type { ReturnRow, ReturnItem, ReturnEvent } from "@/lib/returns-types";

const q1 = (s: string) => String(s ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
const MAX_PAGES = 200;

interface RawReturnNode {
  id?: string;
  legacy_id?: number;
  created_at?: string;
  status?: string;
  reason?: string | null;
  partner_id?: string | null;
  shipping_carrier?: string | null;
  cost_to_customer?: string | null;
  display_issue_refund?: boolean;
  total_items_expected?: number;
  total_items_received?: number;
  total_items_restocked?: number;
  order?: { order_number?: string | null; total_tax?: string | null; total_price?: string | null } | null;
  exchanges?: Array<{ exchange_order?: { order_number?: string | null } | null }> | null;
  line_items?: Array<{
    quantity?: number;
    quantity_received?: number;
    restock?: number;
    condition?: string | null;
    reason?: string | null;
    line_item?: {
      sku?: string | null;
      product_name?: string | null;
      price?: string | null;
      promotion_discount?: string | null;
      quantity?: number | null;
    } | null;
  }> | null;
  return_history?: Array<{ user_id?: string | null; created_at?: string; body?: string | null }> | null;
}

function toRow(n: RawReturnNode, userNames: Record<string, string>): ReturnRow {
  const items: ReturnItem[] = (n.line_items ?? []).map((li) => {
    // Net-of-discount unit price (still inc VAT — the ex-VAT step happens at
    // aggregation). promotion_discount is a line total, so prorate per unit.
    const gross = Number(li.line_item?.price ?? 0) || 0;
    const lineQty = Number(li.line_item?.quantity ?? 1) || 1;
    const promo = Number(li.line_item?.promotion_discount ?? 0) || 0;
    return {
      sku: li.line_item?.sku ?? "?",
      productName: li.line_item?.product_name ?? li.line_item?.sku ?? "?",
      quantity: Number(li.quantity ?? 0),
      received: Number(li.quantity_received ?? 0),
      restock: Number(li.restock ?? 0) > 0,
      condition: li.condition ?? null,
      reason: li.reason ?? null,
      price: Math.max(0, gross - promo / lineQty),
    };
  });
  const history: ReturnEvent[] = (n.return_history ?? [])
    .map((h) => ({
      at: h.created_at ?? "",
      userId: h.user_id ?? null,
      user: h.user_id ? (userNames[h.user_id] ?? null) : null,
      // Bodies arrive as HTML fragments ("<p>Generated RMA</p>By Swap Returns").
      body: (h.body ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
    }))
    .sort((a, b) => a.at.localeCompare(b.at));
  // Effective ex-tax multiplier from the ORDER's own numbers: UK ≈ 0.8333
  // (÷1.2), zero-rated international = 1. Fallback to UK VAT when the order's
  // totals are unusable (most orders are GB).
  const tp = Number(n.order?.total_price ?? 0) || 0;
  const tax = Number(n.order?.total_tax ?? 0) || 0;
  const exVatFactor = tp > 0 && tax >= 0 && tax < tp ? (tp - tax) / tp : 1 / 1.2;
  return {
    id: n.id ?? "",
    legacyId: Number(n.legacy_id ?? 0),
    orderNumber: n.order?.order_number ?? "",
    createdAt: n.created_at ?? "",
    status: (n.status ?? "").toLowerCase(),
    reason: n.reason ?? null,
    carrier: n.shipping_carrier ?? null,
    costToCustomer: Number(n.cost_to_customer ?? 0) || 0,
    isV2: n.display_issue_refund === true,
    expected: Number(n.total_items_expected ?? 0),
    received: Number(n.total_items_received ?? 0),
    restocked: Number(n.total_items_restocked ?? 0),
    exVatFactor,
    // Shopify basis: net of discounts (in price) and ex tax (factor).
    value: items.reduce((a, it) => a + it.price * it.quantity, 0) * exVatFactor,
    exchangeOrders: (n.exchanges ?? [])
      .map((e) => e.exchange_order?.order_number ?? "")
      .filter(Boolean),
    items,
    history,
  };
}

/** Pull all returns created since `dateFrom` (ISO date/datetime). */
export async function pullReturns(
  dateFrom: string,
  userNames: Record<string, string>,
): Promise<{ rows: ReturnRow[]; unknownUserIds: string[] }> {
  const nodes: RawReturnNode[] = [];
  let after: string | null = null;
  let pages = 0;
  do {
    const afterArg: string = after ? `, after: "${after}"` : "";
    const query = `query { returns(date_from: "${q1(dateFrom)}") {
      data(first: 20${afterArg}) { pageInfo { hasNextPage endCursor }
        edges { node {
          id legacy_id created_at status reason partner_id shipping_carrier
          cost_to_customer display_issue_refund
          total_items_expected total_items_received total_items_restocked
          order { order_number total_tax total_price }
          exchanges { exchange_order { order_number } }
          line_items { quantity quantity_received restock condition reason
            line_item { sku product_name price promotion_discount quantity } }
          return_history { user_id created_at body }
        } } } } }`;
    const { data } = await shipheroGraphql<{
      returns?: {
        data?: {
          edges?: Array<{ node?: RawReturnNode }>;
          pageInfo?: { hasNextPage?: boolean; endCursor?: string };
        };
      };
    }>(query);
    const conn = data.returns?.data;
    for (const e of conn?.edges ?? []) if (e.node) nodes.push(e.node);
    after = conn?.pageInfo?.hasNextPage ? (conn.pageInfo.endCursor ?? null) : null;
    pages += 1;
  } while (after && pages < MAX_PAGES);

  // Collect user ids we can't name yet (resolved by the cache layer, memoised).
  const unknown = new Set<string>();
  for (const n of nodes) {
    for (const h of n.return_history ?? []) {
      if (h.user_id && !userNames[h.user_id]) unknown.add(h.user_id);
    }
  }
  return { rows: nodes.map((n) => toRow(n, userNames)), unknownUserIds: [...unknown] };
}

/** Resolve ShipHero user ids → display names. */
export async function resolveUserNames(ids: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const id of ids) {
    try {
      const { data } = await shipheroGraphql<{
        user?: { data?: { first_name?: string; last_name?: string; email?: string } };
      }>(`query { user(id: "${q1(id)}") { data { first_name last_name email } } }`);
      const u = data.user?.data;
      out[id] = u ? `${u.first_name ?? ""} ${u.last_name ?? ""}`.trim() || (u.email ?? id) : id;
    } catch {
      out[id] = id; // name lookups are best-effort; never fail the sync over one
    }
  }
  return out;
}
