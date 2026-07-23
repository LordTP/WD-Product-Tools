import { getCachedBins, getBinsSettings } from "@/lib/bins-cache";

export const dynamic = "force-dynamic";

// GET /api/bins/list — reads the LOCAL CACHE (no ShipHero call, 0 credits).
// Use /api/bins/sync to refresh from ShipHero.
export async function GET() {
  const [{ rows, allBins, lastSyncedAt }, settings] = await Promise.all([getCachedBins(), getBinsSettings()]);
  return Response.json({ rows, allBins, settings, lastSyncedAt, cached: true });
}
