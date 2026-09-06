import { hasShipheroCredential, ShipheroError } from "@/lib/shiphero/client";
import { pushPurchaseOrders } from "@/lib/shiphero/push-api";
import { getDraft, markPushed } from "@/lib/po-drafts";
import { todayUkYmd } from "@/lib/uk-time";
import type { PoGroup } from "@/lib/shiphero/types";

export const dynamic = "force-dynamic";

// POST /api/po-scanner/drafts/[id]/push — WRITES: purchase_order_create via the
// same machinery the merch upload flow uses (duplicate-number guard included).
// Only ever called from the user's explicit Confirm in the push modal. Scanner
// POs go up with status Pending, zero prices (so they stay out of merch views
// and the Label Press, like every manual PO) and today's date.
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
    if (!draft.vendorId) return Response.json({ error: "Pick a vendor before pushing." }, { status: 400 });

    const group: PoGroup = {
      poNumber: draft.poNumber,
      vendor: draft.vendorName,
      vendorResolved: true,
      vendorId: draft.vendorId,
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

    const [row] = await pushPurchaseOrders([group], { poDate: todayUkYmd() });
    if (!row?.ok || !row.shipheroId) {
      return Response.json({ error: row?.error ?? "ShipHero accepted the push but returned no PO id." }, { status: 502 });
    }
    const updated = await markPushed(id, row.shipheroId);
    return Response.json({ draft: updated });
  } catch (err) {
    if (err instanceof ShipheroError) {
      const status = err.kind === "throttled" ? 429 : 502;
      return Response.json({ error: err.message, kind: err.kind }, { status });
    }
    return Response.json({ error: err instanceof Error ? err.message : "Push failed." }, { status: 500 });
  }
}
