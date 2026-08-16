import { getCachedSummaries } from "@/lib/po-cache";
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
  const dates = await getPoDates(filtered.map((p) => p.poNumber));

  return Response.json({ pos: filtered, dates, lastSyncedAt, cached: true });
}
