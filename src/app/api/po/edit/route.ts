import { hasShipheroCredential, ShipheroError } from "@/lib/shiphero/client";
import { editPurchaseOrder, type PoEditPatch } from "@/lib/shiphero/po-edit";
import { getPoMutationId, getPoDetailCached } from "@/lib/po-cache";

// POST /api/po/edit { poNumber, patch } — WRITES to ShipHero (status / date /
// notes / line qty+cost), then re-syncs that PO so the cache reflects the change.
// Only ever called by the user's "Save" action in the modal.
export async function POST(req: Request) {
  if (!hasShipheroCredential()) {
    return Response.json({ error: "ShipHero isn't connected." }, { status: 400 });
  }
  try {
    const body = await req.json();
    const poNumber = String(body.poNumber ?? "").trim();
    const patch = (body.patch ?? {}) as PoEditPatch;
    if (!poNumber) return Response.json({ error: "Missing poNumber." }, { status: 400 });

    const poId = await getPoMutationId(poNumber);
    if (!poId) return Response.json({ error: "Unknown PO (sync first)." }, { status: 404 });

    await editPurchaseOrder(poId, patch);

    // Re-pull this one PO from ShipHero so the cache is authoritative.
    const detail = await getPoDetailCached(poNumber, true);
    return Response.json({ ok: true, detail });
  } catch (err) {
    if (err instanceof ShipheroError) {
      const status = err.kind === "throttled" ? 429 : 502;
      return Response.json({ error: err.message, kind: err.kind }, { status });
    }
    return Response.json({ error: err instanceof Error ? err.message : "Edit failed." }, { status: 500 });
  }
}
