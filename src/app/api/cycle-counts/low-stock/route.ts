import { hasShipheroCredential, ShipheroError } from "@/lib/shiphero/client";
import { fetchLowStockItems } from "@/lib/shiphero/cycle-counts";

export const dynamic = "force-dynamic";

// POST /api/cycle-counts/low-stock { maxQty? }
// Live low-stock report from a fresh ShipHero inventory snapshot. Read-only —
// generates + downloads a snapshot, filters to 1..maxQty on_hand, discards it.
export async function POST(req: Request) {
  if (!hasShipheroCredential()) {
    return Response.json({ error: "ShipHero isn't connected." }, { status: 400 });
  }
  try {
    const body = await req.json().catch(() => ({}));
    const maxQty = Number.isFinite(body.maxQty) ? Math.max(1, Math.floor(Number(body.maxQty))) : 10;
    const { items, snapshotAt } = await fetchLowStockItems({ maxQty, minQty: 1 });
    return Response.json({ items, snapshotAt, maxQty });
  } catch (err) {
    if (err instanceof ShipheroError) {
      const status = err.kind === "throttled" ? 429 : 502;
      return Response.json({ error: err.message, kind: err.kind }, { status });
    }
    return Response.json({ error: err instanceof Error ? err.message : "Report failed." }, { status: 500 });
  }
}
