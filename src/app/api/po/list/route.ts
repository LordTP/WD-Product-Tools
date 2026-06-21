import { getCachedSummaries } from "@/lib/po-cache";
import { listAliases } from "@/lib/vendors";

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

  return Response.json({ pos: filtered, lastSyncedAt, cached: true });
}
