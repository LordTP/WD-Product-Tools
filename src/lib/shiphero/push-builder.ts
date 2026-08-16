// Pure builder: PoGroup[] -> ShipHero CreatePurchaseOrderInput[]. No IO, so it's
// unit-tested offline. Field shape verified against the live schema (introspected):
// required PO fields: po_number, subtotal, shipping_price, total_price,
// warehouse_id, line_items; required line fields: sku, quantity(Int),
// expected_weight_in_lbs(String), price(String). Money fields are Strings.

import type { PoGroup } from "./types";
import { poDatesNote } from "./dates";

export interface PoLineInput {
  sku: string;
  quantity: number; // Int
  price: string; // String (money)
  expected_weight_in_lbs: string; // String, required by ShipHero
  vendor_sku: string;
  sell_ahead: number; // Int 0/1
  product_name?: string;
}

export interface PurchaseOrderCreateInput {
  po_number: string;
  warehouse_id: string;
  vendor_id?: string;
  fulfillment_status?: string;
  subtotal: string;
  shipping_price: string;
  total_price: string;
  discount: string;
  tax: string;
  po_date?: string;
  po_note?: string;
  line_items: PoLineInput[];
}

export interface BuildOptions {
  warehouseId: string;
  /** Required by ShipHero per line; our sheets have no weights → default "0". */
  weightLbs?: string;
  /** yyyy-mm-dd; omitted if not provided. */
  poDate?: string;
}

const money = (n: number): string => (Math.round(n * 100) / 100).toFixed(2);

export function buildPurchaseOrderInput(
  po: PoGroup,
  opts: BuildOptions,
): PurchaseOrderCreateInput {
  const weight = opts.weightLbs ?? "0";
  let subtotal = 0;

  const line_items: PoLineInput[] = po.lines.map((l) => {
    const qty = Number(l.quantity) || 0;
    const price = Number(l.price) || 0;
    subtotal += qty * price;
    return {
      sku: l.sku,
      quantity: qty,
      price: money(price),
      expected_weight_in_lbs: weight,
      vendor_sku: l.vendorSku,
      sell_ahead: l.sellAhead === "1" ? 1 : 0,
      ...(l.title ? { product_name: l.title } : {}),
    };
  });

  const subtotalStr = money(subtotal);
  return {
    po_number: po.poNumber,
    warehouse_id: opts.warehouseId,
    ...(po.vendorId != null ? { vendor_id: String(po.vendorId) } : {}),
    ...(po.status ? { fulfillment_status: po.status } : {}),
    subtotal: subtotalStr,
    shipping_price: "0.00",
    total_price: subtotalStr, // shipping/discount/tax all zero
    discount: "0.00",
    tax: "0.00",
    // The sheet's CURRENT DELIVERY drives po_date — ShipHero shows it as
    // "Expected Date". Falls back to an explicit per-push date if given.
    ...(po.delivery || opts.poDate ? { po_date: po.delivery ?? opts.poDate } : {}),
    ...(() => {
      const note = poDatesNote(po);
      return note ? { po_note: note } : {};
    })(),
    line_items,
  };
}

export function buildPurchaseOrderInputs(
  pos: PoGroup[],
  opts: BuildOptions,
): PurchaseOrderCreateInput[] {
  return pos.map((po) => buildPurchaseOrderInput(po, opts));
}

/** A PO is pushable only if vendor + status resolved and it has lines. */
export function isPushable(po: PoGroup): boolean {
  return (
    po.vendorResolved &&
    po.vendorId != null &&
    po.statusResolved &&
    po.status !== "" &&
    po.lines.length > 0 &&
    po.lines.every((l) => l.status === "ok")
  );
}
