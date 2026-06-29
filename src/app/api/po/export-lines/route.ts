import { getCachedLinesByPo } from "@/lib/po-cache";

export const dynamic = "force-dynamic";

// GET /api/po/export-lines — cached line items keyed by PO number (no ShipHero call).
// Used by the PO History line-level export.
export async function GET() {
  return Response.json({ lines: await getCachedLinesByPo() });
}
