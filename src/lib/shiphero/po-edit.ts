// PO edit mutations against ShipHero. WRITES — only ever invoked from the user's
// "Save" action in the modal; the agent never runs these. After a successful edit
// the route re-syncs that one PO from ShipHero so the cache stays authoritative.
//
// Shapes verified via introspection / docs:
//  - purchase_order_set_fulfillment_status(data: { po_id, status })
//  - purchase_order_update(data: { po_id, po_date|clear_po_date, po_note,
//    packing_note, line_items: [{ sku, quantity, price, note }] })

import { shipheroGraphql } from "./client";

export interface PoEditLine {
  sku: string;
  quantity?: number;
  price?: string;
}

export interface PoEditPatch {
  status?: string;
  poDate?: string | null; // "YYYY-MM-DD"; null = clear
  poNote?: string;
  packingNote?: string;
  lines?: PoEditLine[];
}

const SET_STATUS = `
  mutation SetStatus($data: SetPurchaseOrderFulfillmentStatusInput!) {
    purchase_order_set_fulfillment_status(data: $data) {
      request_id complexity purchase_order { id fulfillment_status }
    }
  }
`;

const UPDATE_PO = `
  mutation UpdatePo($data: UpdatePurchaseOrderInput!) {
    purchase_order_update(data: $data) {
      request_id complexity purchase_order { id po_date po_note }
    }
  }
`;

/** Apply an edit to a PO in ShipHero. `poId` is the ShipHero id (global or legacy). */
export async function editPurchaseOrder(poId: string, patch: PoEditPatch): Promise<void> {
  // 1) status uses its own dedicated mutation
  if (patch.status !== undefined && patch.status !== "") {
    await shipheroGraphql(SET_STATUS, { data: { po_id: poId, status: patch.status } });
  }

  // 2) the rest go through purchase_order_update (only if something changed)
  const data: Record<string, unknown> = { po_id: poId };
  let hasUpdate = false;

  if (patch.poDate !== undefined) {
    if (patch.poDate === null || patch.poDate === "") data.clear_po_date = true;
    else data.po_date = patch.poDate;
    hasUpdate = true;
  }
  if (patch.poNote !== undefined) {
    data.po_note = patch.poNote;
    hasUpdate = true;
  }
  if (patch.packingNote !== undefined) {
    data.packing_note = patch.packingNote;
    hasUpdate = true;
  }
  if (patch.lines && patch.lines.length > 0) {
    data.line_items = patch.lines.map((l) => ({
      sku: l.sku,
      ...(l.quantity != null ? { quantity: l.quantity } : {}),
      ...(l.price != null ? { price: l.price } : {}),
    }));
    hasUpdate = true;
  }

  if (hasUpdate) {
    await shipheroGraphql(UPDATE_PO, { data });
  }
}
