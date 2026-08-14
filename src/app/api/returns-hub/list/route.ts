import { listCachedReturns, getSyncMeta } from "@/lib/returns-cache";

export const dynamic = "force-dynamic";

// GET /api/returns-hub/list — cached returns + sync meta. 0 ShipHero credits.
export async function GET() {
  try {
    const [rows, meta] = await Promise.all([listCachedReturns(), getSyncMeta()]);
    return Response.json({ rows, meta });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Failed to read returns cache." },
      { status: 500 },
    );
  }
}
