import { getCachedSummaries, getCachedLinesByPo } from "@/lib/po-cache";
import { listAliases } from "@/lib/vendors";
import { getPoDates } from "@/lib/po-dates";

// GET /api/po/list?mappedOnly=1 — reads the LOCAL CACHE (no ShipHero call). Use
// /api/po/sync to refresh the cache from ShipHero.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const mappedOnly = url.searchParams.get("mappedOnly") !== "0";

  const { pos, lastSyncedAt } = await getCachedSummaries();

  let mappedVendorNames: Set<string> | null = null;
  if (mappedOnly) {
    const aliases = await listAliases();
    mappedVendorNames = new Set(aliases.map((a) => a.name.toLowerCase()));
  }

  const filtered = pos
    .filter((p) => p.totalPrice != null && p.totalPrice !== "" && Number(p.totalPrice) !== 0)
    .filter((p) => !mappedVendorNames || (p.vendorName && mappedVendorNames.has(p.vendorName.toLowerCase())));

  // App-side dates (ex-factory / order-sent live only here; delivery mirrors po_date).
  const [dates, linesByPo] = await Promise.all([getPoDates(filtered.map((p) => p.poNumber)), getCachedLinesByPo()]);
  // Every SKU on each PO, joined, so the page's search can match any fragment of a SKU.
  const skus: Record<string, string> = {};
  for (const p of filtered) { const lines = linesByPo[p.poNumber]; if (lines?.length) skus[p.poNumber] = lines.map((l) => l.sku).join(" "); }

  return Response.json({ pos: filtered, dates, skus, lastSyncedAt, cached: true });
}
