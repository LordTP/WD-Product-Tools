// Read-only pull of ShipHero returns (RMAs) for the Swap QC-CSV export.
// Schema confirmed by introspection: `returns` is a connection (data → edges →
// node); a Return's `line_items` is a PLAIN LIST (no edges). The stock condition
// we send to Swap is derived from each line's `restock` / `quantity_received`
// (ShipHero's own `condition` field is unused here — always empty for WD).

import { shipheroGraphql } from "./client";

export interface ReturnLine {
  sku: string;
  productName: string;
  quantityExpected: number;
  quantityReceived: number;
  restock: number;
  condition: string; // ShipHero's raw condition (typically "")
}

export interface ReturnRecord {
  rma: string; // ShipHero legacy_id (shown as "RMA" in their UI)
  orderNumber: string; // e.g. "#162359" (bare-stripped at export time)
  status: string; // ShipHero return status (pending / complete / custom…)
  createdAt: string | null;
  lines: ReturnLine[];
}

interface Edge<T> {
  node?: T;
}
const nodesOf = <T>(conn: { edges?: Edge<T>[] } | undefined): T[] =>
  (conn?.edges ?? []).map((e) => e.node).filter((n): n is T => Boolean(n));

interface RawReturnLine {
  quantity?: number;
  quantity_received?: number;
  restock?: number;
  condition?: string;
  line_item?: { sku?: string; product_name?: string } | null;
  product?: { sku?: string } | null;
}
interface RawReturn {
  legacy_id?: string | number;
  status?: string;
  created_at?: string;
  order?: { order_number?: string } | null;
  line_items?: RawReturnLine[] | null;
}

function toReturnRecord(node: RawReturn): ReturnRecord {
  const lines: ReturnLine[] = (node.line_items ?? []).map((l) => ({
    sku: l.line_item?.sku ?? l.product?.sku ?? "",
    productName: (l.line_item?.product_name ?? "").trim(),
    quantityExpected: Number(l.quantity ?? 0),
    quantityReceived: Number(l.quantity_received ?? 0),
    restock: Number(l.restock ?? 0),
    condition: l.condition ?? "",
  }));
  return {
    rma: node.legacy_id != null ? String(node.legacy_id) : "",
    orderNumber: node.order?.order_number ?? "",
    status: node.status ?? "",
    createdAt: node.created_at ?? null,
    lines,
  };
}

// Keep pages modest so a busy window never blows the 4004 credit ceiling; the
// client retries throttles for us. Returns are far lighter than POs.
const PAGE = 50;
const MAX_PAGES = 200;

async function fetchPage(
  from: string,
  after: string | null,
): Promise<{ records: ReturnRecord[]; nextCursor: string | null }> {
  const afterArg = after ? `, after: "${after}"` : "";
  const query = `
    query {
      returns(date_from: "${from}") {
        data(first: ${PAGE}${afterArg}) {
          edges {
            node {
              legacy_id status created_at
              order { order_number }
              line_items {
                quantity quantity_received restock condition
                line_item { sku product_name }
                product { sku }
              }
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  `;
  const { data } = await shipheroGraphql<{
    returns?: {
      data?: { edges?: Edge<RawReturn>[]; pageInfo?: { hasNextPage?: boolean; endCursor?: string } };
    };
  }>(query);
  const conn = data.returns?.data;
  const records = nodesOf<RawReturn>(conn).map(toReturnRecord);
  const nextCursor = conn?.pageInfo?.hasNextPage ? (conn.pageInfo.endCursor ?? null) : null;
  return { records, nextCursor };
}

/**
 * Paginated pull of returns created since `fromISO`. Read-only. Filtering by
 * status / date-to happens client-side so the caller sees everything in range.
 */
export async function fetchReturns(fromISO: string): Promise<ReturnRecord[]> {
  const from = fromISO || new Date(Date.now() - 7 * 86_400_000).toISOString();
  const out: ReturnRecord[] = [];
  let after: string | null = null;
  let pages = 0;
  do {
    const { records, nextCursor }: { records: ReturnRecord[]; nextCursor: string | null } =
      await fetchPage(from, after);
    out.push(...records);
    after = nextCursor;
    pages += 1;
  } while (after && pages < MAX_PAGES);
  return out;
}
