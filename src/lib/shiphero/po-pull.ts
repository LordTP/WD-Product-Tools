// Read-only PO pulls from ShipHero. Correct query shapes per the docs:
// pagination `first`/`after` go on the inner `data` connection; single-PO detail
// uses `purchase_order(id:)`. The bulk pull includes line items (capped) so units
// + received quantities land in the cache for the dashboard/History/modal.

import { shipheroGraphql } from "./client";
import { stripSizeSuffix, DEFAULT_SIZE_MAP, type SizeMap } from "@/lib/sizes";

export interface PoLineDetail {
  sku: string;
  productName: string;
  quantity: number;
  quantityReceived: number;
  price: string;
}

export interface PoSummary {
  poNumber: string;
  legacyId: string | null;
  globalId: string | null; // base64 id, for mutations (po_id)
  status: string;
  vendorName: string | null;
  poDate: string | null;
  totalPrice: string | null;
  products: string[];
  unitsOrdered: number;
  unitsReceived: number;
}

export interface PoDetail extends PoSummary {
  lines: PoLineDetail[];
}

function safeDate(d: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : "2025-01-01";
}

interface Edge<T> {
  node?: T;
}
const nodesOf = <T>(conn: { edges?: Edge<T>[] } | undefined): T[] =>
  (conn?.edges ?? []).map((e) => e.node).filter((n): n is T => Boolean(n));

interface RawLine {
  sku?: string;
  product_name?: string;
  quantity?: number;
  quantity_received?: number;
  price?: string;
}
interface RawNode {
  id?: string;
  legacy_id?: string | number;
  po_number?: string;
  fulfillment_status?: string;
  po_date?: string;
  total_price?: string;
  vendor?: { name?: string } | null;
  line_items?: { edges?: Edge<RawLine>[] };
}

function toPoDetail(node: RawNode, sizeMap: SizeMap): PoDetail {
  const lines: PoLineDetail[] = nodesOf<RawLine>(node.line_items).map((l) => ({
    sku: l.sku ?? "",
    productName: (l.product_name ?? "").trim(),
    quantity: Number(l.quantity ?? 0),
    quantityReceived: Number(l.quantity_received ?? 0),
    price: l.price ?? "",
  }));
  return {
    poNumber: node.po_number ?? "",
    legacyId: node.legacy_id != null ? String(node.legacy_id) : null,
    globalId: node.id ?? null,
    status: node.fulfillment_status ?? "",
    vendorName: node.vendor?.name ?? null,
    poDate: node.po_date ?? null,
    totalPrice: node.total_price ?? null,
    products: [...new Set(lines.map((l) => stripSizeSuffix(l.productName, sizeMap)).filter(Boolean))],
    unitsOrdered: lines.reduce((a, l) => a + l.quantity, 0),
    unitsReceived: lines.reduce((a, l) => a + l.quantityReceived, 0),
    lines,
  };
}

// Caps keep one page under the 4004 credit ceiling: 50 POs × 40 lines ≈ 2051.
const PAGE = 50;
const LINE_CAP = 40;
const MAX_PAGES = 20;

async function fetchPage(
  since: string,
  after: string | null,
  sizeMap: SizeMap,
): Promise<{ pos: PoDetail[]; nextCursor: string | null }> {
  const afterArg = after ? `, after: "${after}"` : "";
  const query = `
    query {
      purchase_orders(po_date_from: "${since}") {
        complexity
        data(first: ${PAGE}${afterArg}) {
          edges {
            cursor
            node {
              id legacy_id po_number fulfillment_status po_date total_price
              vendor { name }
              line_items(first: ${LINE_CAP}) {
                edges { node { sku product_name quantity quantity_received price } }
              }
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  `;
  const { data } = await shipheroGraphql<{
    purchase_orders?: {
      data?: { edges?: Edge<RawNode>[]; pageInfo?: { hasNextPage?: boolean; endCursor?: string } };
    };
  }>(query);
  const conn = data.purchase_orders?.data;
  const pos = nodesOf<RawNode>(conn).map((n) => toPoDetail(n, sizeMap));
  const nextCursor = conn?.pageInfo?.hasNextPage ? (conn.pageInfo.endCursor ?? null) : null;
  return { pos, nextCursor };
}

/** Paginated pull of POs WITH line items (units + received). */
export async function fetchPurchaseOrders(sinceISO: string, sizeMap: SizeMap = DEFAULT_SIZE_MAP): Promise<PoDetail[]> {
  const since = safeDate(sinceISO);
  const out: PoDetail[] = [];
  let after: string | null = null;
  let pages = 0;
  do {
    const { pos, nextCursor } = await fetchPage(since, after, sizeMap);
    out.push(...pos);
    after = nextCursor;
    pages += 1;
  } while (after && pages < MAX_PAGES);
  return out;
}

/** Just PO numbers (cheap, for the duplicate pre-flight check). */
export async function fetchExistingPoNumbers(sinceISO: string): Promise<Set<string>> {
  const since = safeDate(sinceISO);
  const query = `
    query {
      purchase_orders(po_date_from: "${since}") {
        data(first: 100) { edges { node { po_number } } }
      }
    }
  `;
  const { data } = await shipheroGraphql<{ purchase_orders?: { data?: { edges?: Edge<{ po_number?: string }>[] } } }>(query);
  return new Set(nodesOf<{ po_number?: string }>(data.purchase_orders?.data).map((n) => (n.po_number ?? "").trim()).filter(Boolean));
}

/** Single PO with full line items via the cheap `purchase_order(id:)` query. */
export async function fetchPurchaseOrderDetail(legacyId: string, sizeMap: SizeMap = DEFAULT_SIZE_MAP): Promise<PoDetail | null> {
  const escaped = legacyId.replace(/"/g, '\\"');
  const query = `
    query {
      purchase_order(id: "${escaped}") {
        complexity
        data {
          id legacy_id po_number fulfillment_status po_date total_price vendor { name }
          line_items(first: 100) { edges { node { sku product_name quantity quantity_received price } } }
        }
      }
    }
  `;
  const { data } = await shipheroGraphql<{ purchase_order?: { data?: RawNode } }>(query);
  const node = data.purchase_order?.data;
  return node ? toPoDetail(node, sizeMap) : null;
}
