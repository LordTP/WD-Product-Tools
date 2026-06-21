// Server-side push + pre-flight against ShipHero.
//  - runPreflight: READ-ONLY checks (warehouse, existing PO numbers, local vendor/
//    status validity). Safe to call anytime.
//  - pushPurchaseOrders: the REAL purchase_order_create. Only ever invoked when the
//    user clicks "Confirm & push" — never during development/testing.

import { shipheroGraphql } from "./client";
import { getWarehouseId } from "./warehouse";
import { fetchExistingPoNumbers } from "./po-pull";
import { checkSkusExist } from "./sku-check";
import { buildPurchaseOrderInput, isPushable } from "./push-builder";
import type { PoGroup } from "./types";

export interface PreflightRow {
  poNumber: string;
  ok: boolean;
  reasons: string[];
  units: number;
  lineCount: number;
  vendor: string;
  status: string;
}

export interface PreflightResult {
  warehouseId: string;
  rows: PreflightRow[];
  okCount: number;
  blockedCount: number;
  missingSkus: string[];
}

const EXISTING_SINCE = "2023-01-01";

export async function runPreflight(pos: PoGroup[]): Promise<PreflightResult> {
  const allSkus = pos.flatMap((p) => p.lines.map((l) => l.sku)).filter(Boolean);
  // Read-only checks: warehouse, existing PO numbers, and SKU existence.
  const [warehouseId, existing, skuResult] = await Promise.all([
    getWarehouseId(),
    fetchExistingPoNumbers(EXISTING_SINCE),
    checkSkusExist(allSkus),
  ]);
  const missing = new Set(skuResult.missing);

  const rows: PreflightRow[] = pos.map((po) => {
    const reasons: string[] = [];
    if (!po.vendorResolved || po.vendorId == null) reasons.push("Vendor not mapped");
    if (!po.statusResolved || po.status === "") reasons.push("Status needs editing");
    if (po.lines.some((l) => l.status !== "ok")) reasons.push("Some lines have errors");
    if (existing.has(po.poNumber)) reasons.push("PO number already exists in ShipHero");
    const missingHere = [...new Set(po.lines.map((l) => l.sku).filter((s) => missing.has(s)))];
    if (missingHere.length > 0) reasons.push(`${missingHere.length} SKU(s) not in ShipHero`);
    return {
      poNumber: po.poNumber,
      ok: reasons.length === 0 && isPushable(po),
      reasons,
      units: po.totalUnits,
      lineCount: po.lines.length,
      vendor: po.vendor,
      status: po.status,
    };
  });

  return {
    warehouseId,
    rows,
    okCount: rows.filter((r) => r.ok).length,
    blockedCount: rows.filter((r) => !r.ok).length,
    missingSkus: skuResult.missing,
  };
}

const CREATE_MUTATION = `
  mutation Create($data: CreatePurchaseOrderInput!) {
    purchase_order_create(data: $data) {
      request_id
      complexity
      purchase_order { id legacy_id po_number }
    }
  }
`;

export interface PushRow {
  poNumber: string;
  ok: boolean;
  shipheroId?: string;
  error?: string;
}

/** REAL purchase_order_create per PO. User-triggered only. Re-checks duplicates
 *  server-side as a final guard, and skips anything not pushable. */
export async function pushPurchaseOrders(
  pos: PoGroup[],
  opts: { poDate?: string } = {},
): Promise<PushRow[]> {
  const [warehouseId, existing] = await Promise.all([
    getWarehouseId(),
    fetchExistingPoNumbers(EXISTING_SINCE),
  ]);

  const results: PushRow[] = [];
  for (const po of pos) {
    if (!isPushable(po)) {
      results.push({ poNumber: po.poNumber, ok: false, error: "Not pushable (unresolved vendor/status)." });
      continue;
    }
    if (existing.has(po.poNumber)) {
      results.push({ poNumber: po.poNumber, ok: false, error: "PO number already exists in ShipHero." });
      continue;
    }
    try {
      const input = buildPurchaseOrderInput(po, { warehouseId, poDate: opts.poDate });
      const { data } = await shipheroGraphql<{
        purchase_order_create?: { purchase_order?: { id?: string } };
      }>(CREATE_MUTATION, { data: input });
      const id = data.purchase_order_create?.purchase_order?.id;
      results.push({ poNumber: po.poNumber, ok: true, shipheroId: id });
    } catch (err) {
      results.push({
        poNumber: po.poNumber,
        ok: false,
        error: err instanceof Error ? err.message : "Push failed.",
      });
    }
  }
  return results;
}
