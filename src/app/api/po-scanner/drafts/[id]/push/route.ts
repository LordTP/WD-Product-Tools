import { hasShipheroCredential, ShipheroError } from "@/lib/shiphero/client";
import { createPurchaseOrder } from "@/lib/shiphero/push-api";
import { buildPurchaseOrderInput } from "@/lib/shiphero/push-builder";
import { fetchExistingPoNumbers } from "@/lib/shiphero/po-pull";
import { getWarehouseId } from "@/lib/shiphero/warehouse";
import { getDraft, markPushed } from "@/lib/po-drafts";
import { todayUkYmd } from "@/lib/uk-time";
import type { PoGroup } from "@/lib/shiphero/types";

export const dynamic = "force-dynamic";

// POST /api/po-scanner/drafts/[id]/push — WRITES: purchase_order_create via the
// same builder + duplicate guard the merch upload flow uses. Only ever called
// from the user's explicit Confirm in the push modal. Scanner POs match the
// warehouse's established manual-PO shape: NO vendor unless one was picked
// (like Will's app), status Pending, zero prices (so they stay out of merch
// views and the Label Press) and today's date.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!hasShipheroCredential()) {
    return Response.json({ error: "ShipHero isn't connected." }, { status: 400 });
  }
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) return Response.json({ error: "Bad draft id." }, { status: 400 });

  try {
    const draft = await getDraft(id);
    if (!draft) return Response.json({ error: "Draft not found." }, { status: 404 });
    if (draft.status !== "draft") return Response.json({ error: `${draft.poNumber} is already ${draft.status}.` }, { status: 400 });
    if (!draft.lines.length) return Response.json({ error: "Nothing scanned yet — the PO has no lines." }, { status: 400 });

    const [warehouseId, existing] = await Promise.all([getWarehouseId(), fetchExistingPoNumbers("2023-01-01")]);
    if (existing.has(draft.poNumber)) {
      return Response.json({ error: `${draft.poNumber} already exists in ShipHero.` }, { status: 400 });
    }

    const group: PoGroup = {
      poNumber: draft.poNumber,
      vendor: draft.vendorName,
      vendorResolved: true,
      vendorId: draft.vendorId, // null = vendorless, like the old app's manual POs
      alias: draft.vendorName,
      totalUnits: draft.lines.reduce((a, l) => a + l.qty, 0),
      sellAhead: false,
      status: "Pending",
      statusResolved: true,
      statusSource: "Pending",
      title: null,
      productCount: draft.lines.length,
      orderSent: null,
      exFactory: null,
      delivery: null,
      lines: draft.lines.map((l) => ({
        poNumber: draft.poNumber,
        vendor: draft.vendorName,
        sku: l.sku,
        vendorSku: l.sku,
        quantity: String(l.qty),
        sellAhead: "0",
        price: "0",
        sourceRow: 0,
        poStatus: "Pending",
        size: l.size,
        title: l.title,
        status: "ok" as const,
      })),
    };

    const input = buildPurchaseOrderInput(group, { warehouseId, poDate: todayUkYmd() });
    const { id: shipheroId } = await createPurchaseOrder(input);
    const updated = await markPushed(id, shipheroId);
    return Response.json({ draft: updated });
  } catch (err) {
    if (err instanceof ShipheroError) {
      const status = err.kind === "throttled" ? 429 : 502;
      return Response.json({ error: err.message, kind: err.kind }, { status });
    }
    return Response.json({ error: err instanceof Error ? err.message : "Push failed." }, { status: 500 });
  }
}
