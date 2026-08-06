import { hasShipheroCredential, ShipheroError } from "@/lib/shiphero/client";
import { syncOpsStats } from "@/lib/ops-cache";

export const dynamic = "force-dynamic";
// The scan pages through every open order + today's shipments, so give it room.
export const maxDuration = 300;

// POST /api/ops/sync — refresh the dashboard from ShipHero (read-only scan).
export async function POST() {
  if (!hasShipheroCredential()) {
    return Response.json({ error: "ShipHero isn't connected." }, { status: 400 });
  }
  try {
    const stats = await syncOpsStats();
    return Response.json({ ok: true, stats });
  } catch (err) {
    if (err instanceof ShipheroError) {
      const status = err.kind === "throttled" ? 429 : 502;
      return Response.json({ error: err.message, kind: err.kind }, { status });
    }
    return Response.json({ error: err instanceof Error ? err.message : "Sync failed." }, { status: 500 });
  }
}
