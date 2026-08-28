// PO Un-receive — correct an over-received PO. Two verified ShipHero facts:
//  · purchase_order_update line `quantity_received` is a DELTA (negative
//    un-receives); it moves NO stock and leaves line/PO status alone.
//  · stock is corrected separately with inventory_subtract from a chosen bin.
// search/detail are read-only; apply WRITES and is only ever called from the
// user's explicit Confirm in the Un-receive page.

import { shipheroGraphql } from "./client";
import { getWarehouseId } from "./warehouse";

const q1 = (s: string) => String(s ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');

export interface PoMatch {
  id: string;
  legacyId: string;
  poNumber: string;
  status: string;
  vendor: string;
  poDate: string | null;
  createdAt: string | null;
  lineCount: number;
  ordered: number;
  received: number;
}

export interface StockBin { locationId: string; locationName: string; qty: number }

export interface PoLineDetail {
  sku: string;
  productName: string;
  ordered: number;
  received: number;
  bins: StockBin[]; // every bin holding this SKU right now
}

export interface PoDetail {
  id: string;
  legacyId: string;
  poNumber: string;
  status: string;
  vendor: string;
  poDate: string | null;
  lines: PoLineDetail[];
}

/** All POs with this exact number (duplicates exist — the user picks). */
export async function searchPo(poNumber: string): Promise<PoMatch[]> {
  const { data } = await shipheroGraphql<{
    purchase_orders?: { data?: { edges?: Array<{ node?: {
      id?: string; legacy_id?: number; po_number?: string; fulfillment_status?: string;
      po_date?: string | null; created_at?: string | null; vendor?: { name?: string } | null;
      line_items?: { edges?: Array<{ node?: { quantity?: number; quantity_received?: number } }> };
    } }> } };
  }>(`query { purchase_orders(po_number: "${q1(poNumber.trim())}") { data(first: 10) { edges { node {
      id legacy_id po_number fulfillment_status po_date created_at vendor { name }
      line_items(first: 100) { edges { node { quantity quantity_received } } } } } } } }`);
  return (data.purchase_orders?.data?.edges ?? [])
    .map((e) => e.node)
    .filter((n): n is NonNullable<typeof n> => Boolean(n))
    .filter((n) => (n.po_number ?? "").trim().toUpperCase() === poNumber.trim().toUpperCase())
    .map((n) => {
      const lines = (n.line_items?.edges ?? []).map((e) => e.node ?? {});
      return {
        id: n.id ?? "",
        legacyId: String(n.legacy_id ?? ""),
        poNumber: n.po_number ?? "",
        status: n.fulfillment_status ?? "",
        vendor: n.vendor?.name ?? "",
        poDate: n.po_date ?? null,
        createdAt: n.created_at ?? null,
        lineCount: lines.length,
        ordered: lines.reduce((a, l) => a + Number(l.quantity ?? 0), 0),
        received: lines.reduce((a, l) => a + Number(l.quantity_received ?? 0), 0),
      };
    });
}

/** Lines only — fast (one call). Bins are fetched lazily per SKU via skuBins(). */
export async function poDetail(poId: string): Promise<PoDetail> {
  const { data } = await shipheroGraphql<{
    purchase_order?: { data?: {
      id?: string; legacy_id?: number; po_number?: string; fulfillment_status?: string; po_date?: string | null;
      vendor?: { name?: string } | null;
      line_items?: { edges?: Array<{ node?: { sku?: string; product_name?: string; quantity?: number; quantity_received?: number } }> };
    } };
  }>(`query { purchase_order(id: "${q1(poId)}") { data { id legacy_id po_number fulfillment_status po_date vendor { name }
      line_items(first: 100) { edges { node { sku product_name quantity quantity_received } } } } } }`);
  const p = data.purchase_order?.data;
  if (!p) throw new Error("PO not found.");
  const lines: PoLineDetail[] = (p.line_items?.edges ?? [])
    .map((e) => e.node)
    .filter((l): l is NonNullable<typeof l> & { sku: string } => Boolean(l?.sku))
    .map((l) => ({ sku: l.sku, productName: l.product_name ?? "", ordered: Number(l.quantity ?? 0), received: Number(l.quantity_received ?? 0), bins: [] }));
  return {
    id: p.id ?? poId, legacyId: String(p.legacy_id ?? ""), poNumber: p.po_number ?? "",
    status: p.fulfillment_status ?? "", vendor: p.vendor?.name ?? "", poDate: p.po_date ?? null, lines,
  };
}

/** Every bin currently holding a SKU (Receiving first, then by qty). One call. */
export async function skuBins(sku: string): Promise<StockBin[]> {
  const warehouseId = await getWarehouseId();
  const { data } = await shipheroGraphql<{
    item_locations?: { data?: { edges?: Array<{ node?: { quantity?: number; location?: { id?: string; name?: string } | null } }> } };
  }>(`query { item_locations(warehouse_id: "${q1(warehouseId)}", sku: "${q1(sku)}") { data(first: 30) { edges { node { quantity location { id name } } } } } }`);
  return (data.item_locations?.data?.edges ?? [])
    .map((x) => x.node)
    .filter((b): b is NonNullable<typeof b> => Boolean(b && Number(b.quantity) > 0 && b.location?.id))
    .map((b) => ({ locationId: b.location!.id!, locationName: b.location!.name ?? "?", qty: Number(b.quantity) }))
    .sort((a, b) => (a.locationName === "Receiving" ? -1 : b.locationName === "Receiving" ? 1 : b.qty - a.qty));
}

export interface UnreceiveLine {
  sku: string;
  unreceive: number; // taken off the PO line's received counter
  stock: Array<{ locationId: string; locationName: string; qty: number }>; // stock removals (may be empty if already fixed)
}

export interface UnreceiveResult {
  sku: string;
  ok: boolean;
  receivedBefore?: number;
  receivedAfter?: number;
  stock: Array<{ locationName: string; before: number; after: number; ok: boolean }>;
  error?: string;
}

/** WRITES: un-receive counters + subtract stock. Verifies each step by re-reading. */
export async function applyUnreceive(poId: string, poNumber: string, lines: UnreceiveLine[]): Promise<UnreceiveResult[]> {
  const warehouseId = await getWarehouseId();
  const reason = `Un-receive correction ${poNumber} - Product App`;
  const readLine = async (sku: string) => {
    const { data } = await shipheroGraphql<{ purchase_order?: { data?: { line_items?: { edges?: Array<{ node?: { sku?: string; quantity_received?: number } }> } } } }>(
      `query { purchase_order(id: "${q1(poId)}") { data { line_items(first: 100) { edges { node { sku quantity_received } } } } } }`,
    );
    return Number((data.purchase_order?.data?.line_items?.edges ?? []).map((e) => e.node).find((n) => n?.sku === sku)?.quantity_received ?? NaN);
  };
  const readBin = async (sku: string, locationName: string) => {
    const { data } = await shipheroGraphql<{ item_locations?: { data?: { edges?: Array<{ node?: { quantity?: number; location?: { name?: string } | null } }> } } }>(
      `query { item_locations(warehouse_id: "${q1(warehouseId)}", sku: "${q1(sku)}", location_name: "${q1(locationName)}") { data(first: 5) { edges { node { quantity location { name } } } } } }`,
    );
    const row = (data.item_locations?.data?.edges ?? []).map((e) => e.node).find((n) => n?.location?.name === locationName);
    return row ? Number(row.quantity) : 0;
  };

  const results: UnreceiveResult[] = [];
  for (const ln of lines) {
    const res: UnreceiveResult = { sku: ln.sku, ok: true, stock: [] };
    try {
      if (ln.unreceive > 0) {
        res.receivedBefore = await readLine(ln.sku);
        await shipheroGraphql(
          `mutation U($data: UpdatePurchaseOrderInput!) { purchase_order_update(data: $data) { request_id } }`,
          { data: { po_id: poId, line_items: [{ sku: ln.sku, quantity_received: -ln.unreceive }] } },
        );
        res.receivedAfter = await readLine(ln.sku);
        if (res.receivedAfter !== res.receivedBefore - ln.unreceive) res.ok = false;
      }
      for (const s of ln.stock) {
        if (s.qty <= 0) continue;
        const before = await readBin(ln.sku, s.locationName);
        await shipheroGraphql(
          `mutation { inventory_subtract(data: { sku: "${q1(ln.sku)}", warehouse_id: "${q1(warehouseId)}", quantity: ${Math.floor(s.qty)}, location_id: "${q1(s.locationId)}", reason: "${q1(reason)}" }) { request_id } }`,
        );
        const after = await readBin(ln.sku, s.locationName);
        const ok = after === before - s.qty;
        if (!ok) res.ok = false;
        res.stock.push({ locationName: s.locationName, before, after, ok });
      }
    } catch (err) {
      res.ok = false;
      res.error = err instanceof Error ? err.message : "Failed";
    }
    results.push(res);
  }
  return results;
}
