import { hasShipheroCredential, ShipheroError } from "@/lib/shiphero/client";
import { syncOpsStats } from "@/lib/ops-cache";
import { runJob } from "@/lib/sync-registry";

export const dynamic = "force-dynamic";
// The scan pages through every open order + today's shipments, so give it room.
export const maxDuration = 300;

// POST /api/ops/sync — refresh the dashboard from ShipHero (read-only scan).
export async function POST() {
  if (!hasShipheroCredential()) {
    return Response.json({ error: "ShipHero isn't connected." }, { status: 400 });
  }
  try {
    const r = await runJob("ops", () => syncOpsStats());
    if (!r.ok) throw new Error(r.error ?? "Sync failed.");
    return Response.json({ ok: true, stats: r.result });
  } catch (err) {
    if (err instanceof ShipheroError) {
      const status = err.kind === "throttled" ? 429 : 502;
      return Response.json({ error: err.message, kind: err.kind }, { status });
    }
    return Response.json({ error: err instanceof Error ? err.message : "Sync failed." }, { status: 500 });
  }
}
